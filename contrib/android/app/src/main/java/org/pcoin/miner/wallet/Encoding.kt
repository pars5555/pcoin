package org.pcoin.miner.wallet

import java.math.BigInteger

/** Base58Check, as used for extended keys (xprv/xpub). */
object Base58 {

    private const val ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

    fun encodeCheck(payload: ByteArray): String {
        val checksum = Hashes.doubleSha256(payload).copyOfRange(0, 4)
        return encode(payload + checksum)
    }

    fun encode(input: ByteArray): String {
        if (input.isEmpty()) return ""
        var value = BigInteger(1, input)
        val fiftyEight = BigInteger.valueOf(58)
        val sb = StringBuilder()
        while (value.signum() > 0) {
            val divRem = value.divideAndRemainder(fiftyEight)
            sb.append(ALPHABET[divRem[1].toInt()])
            value = divRem[0]
        }
        // Every leading zero byte is one leading '1'.
        for (b in input) {
            if (b.toInt() != 0) break
            sb.append(ALPHABET[0])
        }
        return sb.reverse().toString()
    }
}

/**
 * Bech32 (BIP173) for P2WPKH addresses.
 *
 * Only witness version 0 is produced, which is all a wpkh() descriptor can
 * generate, so the bech32m variant (BIP350, witness version 1+) is deliberately
 * not implemented — there is no path in this app that would use it, and an
 * unused half-right implementation is a liability.
 */
object Bech32 {

    private const val CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"

    /** PCoin mainnet HRP, from chainparams.cpp: bech32_hrp = "pc". */
    const val HRP_MAINNET = "pc"

    /** Regtest/testnet HRP, for completeness. */
    const val HRP_REGTEST = "pcrt"

    fun encodeP2wpkh(hrp: String, pubKeyHash: ByteArray): String {
        require(pubKeyHash.size == 20) { "P2WPKH program must be 20 bytes" }
        val data = ByteArray(1) { 0 } + convertBits(pubKeyHash, 8, 5, true)
        return encode(hrp, data)
    }

    private fun encode(hrp: String, data: ByteArray): String {
        val checksum = createChecksum(hrp, data)
        val sb = StringBuilder(hrp).append('1')
        for (b in data) sb.append(CHARSET[b.toInt()])
        for (b in checksum) sb.append(CHARSET[b])
        return sb.toString()
    }

    private fun convertBits(data: ByteArray, from: Int, to: Int, pad: Boolean): ByteArray {
        var acc = 0
        var bits = 0
        val out = ArrayList<Byte>(data.size * from / to + 2)
        val maxv = (1 shl to) - 1
        for (b in data) {
            acc = (acc shl from) or (b.toInt() and 0xFF)
            bits += from
            while (bits >= to) {
                bits -= to
                out.add(((acc shr bits) and maxv).toByte())
            }
        }
        if (pad && bits > 0) out.add(((acc shl (to - bits)) and maxv).toByte())
        return out.toByteArray()
    }

    private fun polymod(values: IntArray): Int {
        val gen = intArrayOf(0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3)
        var chk = 1
        for (v in values) {
            val top = chk ushr 25
            chk = ((chk and 0x1ffffff) shl 5) xor v
            for (i in 0 until 5) if (((top ushr i) and 1) != 0) chk = chk xor gen[i]
        }
        return chk
    }

    private fun hrpExpand(hrp: String): IntArray {
        val out = IntArray(hrp.length * 2 + 1)
        for (i in hrp.indices) {
            out[i] = hrp[i].code ushr 5
            out[i + hrp.length + 1] = hrp[i].code and 31
        }
        out[hrp.length] = 0
        return out
    }

    private fun createChecksum(hrp: String, data: ByteArray): IntArray {
        val values = hrpExpand(hrp) + data.map { it.toInt() }.toIntArray() + IntArray(6)
        // Constant 1: BIP173 bech32, correct for witness version 0.
        val mod = polymod(values) xor 1
        return IntArray(6) { (mod ushr (5 * (5 - it))) and 31 }
    }
}

/** Lowercase hex, for fingerprints and test vectors. Never for secrets in logs. */
fun ByteArray.toHex(): String {
    val sb = StringBuilder(size * 2)
    for (b in this) {
        val v = b.toInt() and 0xFF
        sb.append("0123456789abcdef"[v ushr 4])
        sb.append("0123456789abcdef"[v and 0x0F])
    }
    return sb.toString()
}

fun hexToBytes(hex: String): ByteArray {
    require(hex.length % 2 == 0) { "odd-length hex" }
    val out = ByteArray(hex.length / 2)
    for (i in out.indices) {
        out[i] = ((Character.digit(hex[i * 2], 16) shl 4) or
            Character.digit(hex[i * 2 + 1], 16)).toByte()
    }
    return out
}
