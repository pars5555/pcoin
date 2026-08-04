package org.pcoin.miner.wallet

import java.security.MessageDigest
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * The hash primitives BIP32/BIP39 need, and nothing else.
 *
 * Deliberately free of any Android import so the whole derivation stack can be
 * exercised by plain JVM unit tests against the published BIP39/BIP32 vectors.
 * That cross-check is the only thing standing between a subtle bug here and a
 * recovery phrase that does not recover anything.
 *
 * SHA-256/SHA-512/HMAC-SHA512 come from the platform. RIPEMD-160 does not exist
 * in the JDK or in Android's providers at all, so it is implemented below.
 * PBKDF2-HMAC-SHA512 is also implemented by hand rather than taken from
 * SecretKeyFactory: "PBKDF2WithHmacSHA512" only exists from API 26 (minSdk here
 * is 24), and the JCA variant additionally re-encodes the password through
 * PBEKeySpec's char[] in a way that is easy to get subtly wrong for a mnemonic.
 * BIP39 specifies the password as raw UTF-8 bytes of the NFKD string, so raw
 * bytes are what this takes.
 */
object Hashes {

    fun sha256(data: ByteArray): ByteArray =
        MessageDigest.getInstance("SHA-256").digest(data)

    fun sha512(data: ByteArray): ByteArray =
        MessageDigest.getInstance("SHA-512").digest(data)

    fun doubleSha256(data: ByteArray): ByteArray = sha256(sha256(data))

    fun hmacSha512(key: ByteArray, data: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA512")
        mac.init(SecretKeySpec(key, "HmacSHA512"))
        return mac.doFinal(data)
    }

    /** HASH160 = RIPEMD160(SHA256(x)). The Bitcoin pubkey-hash function. */
    fun hash160(data: ByteArray): ByteArray = ripemd160(sha256(data))

    /**
     * PBKDF2-HMAC-SHA512.
     *
     * BIP39 uses 2048 iterations and a 64-byte output, which is exactly one
     * HMAC-SHA512 block, so the block loop below runs once in practice. It is
     * written for the general case anyway because a silently-wrong multi-block
     * path is worse than a slightly longer function.
     */
    fun pbkdf2HmacSha512(
        password: ByteArray,
        salt: ByteArray,
        iterations: Int,
        dkLen: Int,
    ): ByteArray {
        require(iterations > 0) { "iterations must be positive" }
        require(dkLen > 0) { "dkLen must be positive" }

        val mac = Mac.getInstance("HmacSHA512")
        mac.init(SecretKeySpec(password, "HmacSHA512"))
        val hLen = mac.macLength
        val out = ByteArray(dkLen)
        var offset = 0
        var block = 1

        while (offset < dkLen) {
            // U1 = PRF(P, S || INT_32_BE(block))
            mac.update(salt)
            mac.update(((block ushr 24) and 0xFF).toByte())
            mac.update(((block ushr 16) and 0xFF).toByte())
            mac.update(((block ushr 8) and 0xFF).toByte())
            mac.update((block and 0xFF).toByte())
            var u = mac.doFinal()
            val t = u.copyOf()

            for (i in 1 until iterations) {
                u = mac.doFinal(u)
                for (k in t.indices) t[k] = (t[k].toInt() xor u[k].toInt()).toByte()
            }

            val take = minOf(hLen, dkLen - offset)
            System.arraycopy(t, 0, out, offset, take)
            t.fill(0)
            u.fill(0)
            offset += take
            block++
        }
        return out
    }

    // ------------------------------------------------------------- ripemd160

    /**
     * RIPEMD-160, per the original Dobbertin/Bosselaers/Preneel specification.
     *
     * Verified in HashesTest against the specification's own test vectors,
     * including the "million a" case, and end-to-end against the BIP32 vectors
     * (whose key identifiers are HASH160 values, so a wrong RIPEMD-160 would
     * make every extended key serialise with the wrong parent fingerprint).
     */
    fun ripemd160(message: ByteArray): ByteArray {
        // Written as Long literals narrowed with toInt() rather than as negative
        // hex constants: hand-computing the two's complement of five magic
        // numbers is a pointless place to make an arithmetic slip.
        var h0 = 0x67452301L.toInt()
        var h1 = 0xEFCDAB89L.toInt()
        var h2 = 0x98BADCFEL.toInt()
        var h3 = 0x10325476L.toInt()
        var h4 = 0xC3D2E1F0L.toInt()

        // MD4-style padding: 0x80, zero fill to 56 mod 64, 64-bit LE bit length.
        val bitLen = message.size.toLong() * 8
        val padLen = ((55 - message.size) % 64 + 64) % 64 + 1
        val padded = ByteArray(message.size + padLen + 8)
        System.arraycopy(message, 0, padded, 0, message.size)
        padded[message.size] = 0x80.toByte()
        for (i in 0 until 8) {
            padded[padded.size - 8 + i] = ((bitLen ushr (8 * i)) and 0xFF).toByte()
        }

        val x = IntArray(16)
        var pos = 0
        while (pos < padded.size) {
            for (i in 0 until 16) {
                val b = pos + i * 4
                x[i] = (padded[b].toInt() and 0xFF) or
                    ((padded[b + 1].toInt() and 0xFF) shl 8) or
                    ((padded[b + 2].toInt() and 0xFF) shl 16) or
                    ((padded[b + 3].toInt() and 0xFF) shl 24)
            }

            var a = h0; var b = h1; var c = h2; var d = h3; var e = h4
            var aa = h0; var bb = h1; var cc = h2; var dd = h3; var ee = h4

            for (j in 0 until 80) {
                var t = a + f(j, b, c, d) + x[RL[j]] + K[j / 16]
                t = rol(t, SL[j]) + e
                a = e; e = d; d = rol(c, 10); c = b; b = t

                t = aa + f(79 - j, bb, cc, dd) + x[RR[j]] + KK[j / 16]
                t = rol(t, SR[j]) + ee
                aa = ee; ee = dd; dd = rol(cc, 10); cc = bb; bb = t
            }

            val tmp = h1 + c + dd
            h1 = h2 + d + ee
            h2 = h3 + e + aa
            h3 = h4 + a + bb
            h4 = h0 + b + cc
            h0 = tmp

            pos += 64
        }

        val out = ByteArray(20)
        intArrayOf(h0, h1, h2, h3, h4).forEachIndexed { i, v ->
            out[i * 4] = (v and 0xFF).toByte()
            out[i * 4 + 1] = ((v ushr 8) and 0xFF).toByte()
            out[i * 4 + 2] = ((v ushr 16) and 0xFF).toByte()
            out[i * 4 + 3] = ((v ushr 24) and 0xFF).toByte()
        }
        return out
    }

    private fun rol(v: Int, n: Int): Int = (v shl n) or (v ushr (32 - n))

    private fun f(j: Int, x: Int, y: Int, z: Int): Int = when (j / 16) {
        0 -> x xor y xor z
        1 -> (x and y) or (x.inv() and z)
        2 -> (x or y.inv()) xor z
        3 -> (x and z) or (y and z.inv())
        else -> x xor (y or z.inv())
    }

    private val K = intArrayOf(
        0x00000000L.toInt(), 0x5A827999L.toInt(), 0x6ED9EBA1L.toInt(),
        0x8F1BBCDCL.toInt(), 0xA953FD4EL.toInt(),
    )
    private val KK = intArrayOf(
        0x50A28BE6L.toInt(), 0x5C4DD124L.toInt(), 0x6D703EF3L.toInt(),
        0x7A6D76E9L.toInt(), 0x00000000L.toInt(),
    )

    /** Message-word order, left line. */
    private val RL = intArrayOf(
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
        7, 4, 13, 1, 10, 6, 15, 3, 12, 0, 9, 5, 2, 14, 11, 8,
        3, 10, 14, 4, 9, 15, 8, 1, 2, 7, 0, 6, 13, 11, 5, 12,
        1, 9, 11, 10, 0, 8, 12, 4, 13, 3, 7, 15, 14, 5, 6, 2,
        4, 0, 5, 9, 7, 12, 2, 10, 14, 1, 3, 8, 11, 6, 15, 13,
    )

    /** Message-word order, right line. */
    private val RR = intArrayOf(
        5, 14, 7, 0, 9, 2, 11, 4, 13, 6, 15, 8, 1, 10, 3, 12,
        6, 11, 3, 7, 0, 13, 5, 10, 14, 15, 8, 12, 4, 9, 1, 2,
        15, 5, 1, 3, 7, 14, 6, 9, 11, 8, 12, 2, 10, 0, 4, 13,
        8, 6, 4, 1, 3, 11, 15, 0, 5, 12, 2, 13, 9, 7, 10, 14,
        12, 15, 10, 4, 1, 5, 8, 7, 6, 2, 13, 14, 0, 3, 9, 11,
    )

    /** Rotate-left amounts, left line. */
    private val SL = intArrayOf(
        11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8,
        7, 6, 8, 13, 11, 9, 7, 15, 7, 12, 15, 9, 11, 7, 13, 12,
        11, 13, 6, 7, 14, 9, 13, 15, 14, 8, 13, 6, 5, 12, 7, 5,
        11, 12, 14, 15, 14, 15, 9, 8, 9, 14, 5, 6, 8, 6, 5, 12,
        9, 15, 5, 11, 6, 8, 13, 12, 5, 12, 13, 14, 11, 8, 5, 6,
    )

    /** Rotate-left amounts, right line. */
    private val SR = intArrayOf(
        8, 9, 9, 11, 13, 15, 15, 5, 7, 7, 8, 11, 14, 14, 12, 6,
        9, 13, 15, 7, 12, 8, 9, 11, 7, 7, 12, 7, 6, 15, 13, 11,
        9, 7, 15, 11, 8, 6, 6, 14, 12, 13, 5, 14, 13, 13, 7, 5,
        15, 5, 8, 11, 14, 14, 6, 14, 6, 9, 12, 9, 12, 5, 15, 8,
        8, 5, 12, 9, 12, 5, 14, 6, 8, 13, 6, 5, 15, 13, 11, 11,
    )
}
