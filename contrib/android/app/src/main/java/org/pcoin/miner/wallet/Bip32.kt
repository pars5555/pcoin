package org.pcoin.miner.wallet

import java.math.BigInteger

/**
 * BIP32 hierarchical deterministic key derivation.
 *
 * Private derivation only: the app never needs to walk an xpub, and leaving
 * public-parent derivation out means there is no code path that could
 * accidentally hand the node a watch-only key.
 *
 * The HMAC key for the master seed is the literal ASCII string "Bitcoin seed".
 * That constant is part of BIP32 itself, NOT part of Bitcoin's chain parameters:
 * changing it to "PCoin seed" would buy nothing and would make every standard
 * BIP32 library on earth unable to restore a PCoin wallet from the same words.
 * Do not change it.
 */
object Bip32 {

    private const val MASTER_HMAC_KEY = "Bitcoin seed"

    /** BIP32 marks a hardened child by setting the top bit of the index. */
    const val HARDENED = 0x80000000.toInt()

    fun hardened(index: Int): Int = index or HARDENED

    /**
     * An extended private key.
     *
     * [key] is the 32-byte private scalar and [chainCode] the 32-byte chain
     * code. Both are secrets; nothing in this class ever converts them to a
     * String except [serialize], whose result is equally secret and must never
     * be logged.
     */
    class ExtendedKey(
        val key: ByteArray,
        val chainCode: ByteArray,
        val depth: Int,
        val parentFingerprint: ByteArray,
        val childNumber: Int,
    ) {
        init {
            require(key.size == 32) { "private key must be 32 bytes" }
            require(chainCode.size == 32) { "chain code must be 32 bytes" }
            require(parentFingerprint.size == 4) { "fingerprint must be 4 bytes" }
        }

        /** Compressed public key (33 bytes). Public information. */
        val publicKey: ByteArray by lazy { Secp256k1.publicKeyCompressed(key) }

        /** HASH160 of the public key: this key's identifier. */
        val identifier: ByteArray by lazy { Hashes.hash160(publicKey) }

        /** First 4 bytes of the identifier, as children record it. */
        val fingerprint: ByteArray get() = identifier.copyOfRange(0, 4)

        /**
         * Base58Check "xprv..." form.
         *
         * @param versionBytes EXT_SECRET_KEY for the target network. PCoin
         *   mainnet kept Bitcoin's 0x0488ADE4, which is precisely why the coin
         *   type in the derivation path must not be Bitcoin's 0.
         */
        fun serialize(versionBytes: ByteArray): String {
            require(versionBytes.size == 4)
            val out = ByteArray(78)
            var o = 0
            System.arraycopy(versionBytes, 0, out, o, 4); o += 4
            out[o++] = depth.toByte()
            System.arraycopy(parentFingerprint, 0, out, o, 4); o += 4
            out[o++] = ((childNumber ushr 24) and 0xFF).toByte()
            out[o++] = ((childNumber ushr 16) and 0xFF).toByte()
            out[o++] = ((childNumber ushr 8) and 0xFF).toByte()
            out[o++] = (childNumber and 0xFF).toByte()
            System.arraycopy(chainCode, 0, out, o, 32); o += 32
            out[o++] = 0 // private-key marker
            System.arraycopy(key, 0, out, o, 32)
            return Base58.encodeCheck(out)
        }

        /** Overwrites the secret material. Best effort; see SeedStore's notes. */
        fun wipe() {
            key.fill(0)
            chainCode.fill(0)
        }
    }

    /** Master key from a BIP39 (or any) seed. */
    fun fromSeed(seed: ByteArray): ExtendedKey {
        require(seed.size in 16..64) { "seed length out of range" }
        val i = Hashes.hmacSha512(MASTER_HMAC_KEY.toByteArray(Charsets.US_ASCII), seed)
        val il = i.copyOfRange(0, 32)
        val ir = i.copyOfRange(32, 64)
        i.fill(0)
        val k = BigInteger(1, il)
        require(k.signum() != 0 && k < Secp256k1.N) { "invalid master key for this seed" }
        return ExtendedKey(il, ir, 0, ByteArray(4), 0)
    }

    /**
     * One CKDpriv step. Returns null for the (roughly 2^-127) case BIP32 calls
     * invalid, where the specified behaviour is to move on to the next index
     * rather than to fail — [derivePath] implements that.
     */
    fun deriveChild(parent: ExtendedKey, index: Int): ExtendedKey? {
        val data = ByteArray(37)
        if (index and HARDENED != 0) {
            data[0] = 0
            System.arraycopy(parent.key, 0, data, 1, 32)
        } else {
            System.arraycopy(parent.publicKey, 0, data, 0, 33)
        }
        data[33] = ((index ushr 24) and 0xFF).toByte()
        data[34] = ((index ushr 16) and 0xFF).toByte()
        data[35] = ((index ushr 8) and 0xFF).toByte()
        data[36] = (index and 0xFF).toByte()

        val i = Hashes.hmacSha512(parent.chainCode, data)
        data.fill(0)
        val il = i.copyOfRange(0, 32)
        val ir = i.copyOfRange(32, 64)
        i.fill(0)

        val tweak = BigInteger(1, il)
        il.fill(0)
        if (tweak >= Secp256k1.N) return null
        val childScalar = tweak.add(BigInteger(1, parent.key)).mod(Secp256k1.N)
        if (childScalar.signum() == 0) return null

        return ExtendedKey(
            key = Secp256k1.unsigned32(childScalar),
            chainCode = ir,
            depth = parent.depth + 1,
            parentFingerprint = parent.fingerprint,
            childNumber = index,
        )
    }

    /**
     * Derives a whole path, e.g. listOf(hardened(84), hardened(9444),
     * hardened(0), 0, 0).
     */
    fun derivePath(master: ExtendedKey, path: IntArray): ExtendedKey {
        var node = master
        for (rawIndex in path) {
            var index = rawIndex
            var child = deriveChild(node, index)
            var guard = 0
            while (child == null) {
                // BIP32: "proceed with the next value for i". Reaching here at
                // all is a ~2^-127 event; the guard exists so a bug can never
                // turn it into an unbounded loop.
                check(guard++ < 8) { "derivation failed repeatedly at index $rawIndex" }
                index += 1
                child = deriveChild(node, index)
            }
            node = child
        }
        return node
    }

    /** Parses "m/84'/9444'/0'/0/0" (also accepts "h" for hardened). */
    fun parsePath(path: String): IntArray {
        val parts = path.trim().split('/').filter { it.isNotBlank() }
        val out = ArrayList<Int>(parts.size)
        for ((i, p) in parts.withIndex()) {
            if (i == 0 && (p == "m" || p == "M")) continue
            val isHardened = p.endsWith("'") || p.endsWith("h") || p.endsWith("H")
            val numText = if (isHardened) p.dropLast(1) else p
            val n = numText.toLongOrNull()
                ?: throw IllegalArgumentException("bad path element \"$p\"")
            require(n in 0..0x7FFFFFFFL) { "path index out of range: $p" }
            out.add(if (isHardened) hardened(n.toInt()) else n.toInt())
        }
        return out.toIntArray()
    }
}
