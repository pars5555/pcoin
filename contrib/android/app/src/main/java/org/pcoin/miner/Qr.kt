package org.pcoin.miner

/**
 * A minimal QR encoder, written out rather than pulled in.
 *
 * The module depends on core-ktx and appcompat and nothing else -- see
 * `build.gradle.kts` -- and that is deliberate: this app signs transactions on a
 * phone holding real money, and a barcode library is a large amount of code from
 * a third party for one rendered square. The whole encoder is ~200 lines and the
 * output is checked against an independent implementation in QrTest.
 *
 * Scope, chosen to be exactly enough for an address or a `pcoin:` URI:
 *
 *   * BYTE mode only. Alphanumeric mode would pack an uppercased bech32 address
 *     into a smaller symbol, but byte mode round-trips any string unchanged and
 *     is what every scanner handles without argument. A 42-character address
 *     lands in version 3 at ECC M, which is small enough.
 *   * ECC level M (~15% recovery), the usual choice for addresses.
 *   * Versions 1..10. Version 10 at ECC M holds 213 bytes, far past anything
 *     this app will ever show.
 *
 * Not supported, and not needed: kanji/numeric/alphanumeric modes, structured
 * append, ECI. [encode] returns null rather than guessing if the text does not
 * fit, and callers must handle that -- a QR that silently encodes the wrong
 * thing is worse than no QR beside an address someone is about to be paid at.
 */
object Qr {

    /** A square matrix of modules. `true` is dark. */
    class Matrix(val size: Int) {
        private val cells = BooleanArray(size * size)
        private val locked = BooleanArray(size * size)

        operator fun get(x: Int, y: Int): Boolean = cells[y * size + x]

        fun set(x: Int, y: Int, dark: Boolean, lock: Boolean = false) {
            cells[y * size + x] = dark
            if (lock) locked[y * size + x] = true
        }

        fun isLocked(x: Int, y: Int): Boolean = locked[y * size + x]
    }

    /**
     * Encode [text] as a QR symbol.
     *
     * @return the module matrix, or null when the text does not fit in version
     *   10 at ECC M. Null is a real answer: callers must not render a partial
     *   symbol.
     */
    fun encode(text: String): Matrix? = encode(text, null)

    /**
     * @param forceMask pins the mask instead of scoring all eight. For tests
     *   only -- production callers use [encode], because the spec's penalty
     *   rules exist to avoid symbols a scanner struggles with, and one of those
     *   was observed being produced here before the rules were applied properly.
     */
    fun encode(text: String, forceMask: Int?): Matrix? {
        val data = text.toByteArray(Charsets.UTF_8)
        val version = (1..10).firstOrNull { data.size <= capacityBytes(it) } ?: return null

        val bits = BitBuffer()
        bits.append(0b0100, 4)                       // byte mode
        bits.append(data.size, charCountBits(version))
        data.forEach { bits.append(it.toInt() and 0xFF, 8) }

        val totalDataBits = dataCodewords(version) * 8
        bits.append(0, minOf(4, totalDataBits - bits.size))   // terminator
        while (bits.size % 8 != 0) bits.append(0, 1)
        // Pad alternately with the two bytes the spec names.
        var pad = 0xEC
        while (bits.size < totalDataBits) {
            bits.append(pad, 8)
            pad = if (pad == 0xEC) 0x11 else 0xEC
        }

        val codewords = interleave(bits.toBytes(), version)
        val size = 17 + version * 4
        val m = Matrix(size)
        drawFunctionPatterns(m, version)
        drawCodewords(m, codewords)

        // Every mask is drawn and scored; the lowest penalty wins. Doing fewer
        // is legal but produces symbols some scanners struggle with -- observed
        // here: an early build picked a mask that OpenCV could not read at all
        // for one address, while the same data under a properly-scored mask
        // decoded fine.
        var best = forceMask ?: -1
        if (forceMask == null) {
            var bestPenalty = Int.MAX_VALUE
            for (mask in 0..7) {
                applyMask(m, mask)
                drawFormat(m, mask)
                val p = penalty(m)
                if (p < bestPenalty) { bestPenalty = p; best = mask }
                applyMask(m, mask)   // XOR again to undo
            }
        }
        applyMask(m, best)
        drawFormat(m, best)
        return m
    }

    // ------------------------------------------------------------ tables

    // Total codewords per version, and ECC codewords per block at level M.
    private val TOTAL = intArrayOf(0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346)
    private val ECC_PER_BLOCK = intArrayOf(0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26)
    private val BLOCKS = intArrayOf(0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5)

    private fun dataCodewords(v: Int) = TOTAL[v] - ECC_PER_BLOCK[v] * BLOCKS[v]
    private fun capacityBytes(v: Int) = dataCodewords(v) - 2 - (if (v >= 10) 1 else 0)
    private fun charCountBits(v: Int) = if (v < 10) 8 else 16

    private val ALIGN = arrayOf(
        intArrayOf(), intArrayOf(), intArrayOf(6, 18), intArrayOf(6, 22), intArrayOf(6, 26),
        intArrayOf(6, 30), intArrayOf(6, 34), intArrayOf(6, 22, 38), intArrayOf(6, 24, 42),
        intArrayOf(6, 26, 46), intArrayOf(6, 28, 50),
    )

    // ------------------------------------------------------- bit plumbing

    private class BitBuffer {
        private val bytes = ArrayList<Byte>()
        var size = 0; private set

        fun append(value: Int, bits: Int) {
            for (i in bits - 1 downTo 0) {
                if (size % 8 == 0) bytes.add(0)
                if ((value ushr i) and 1 == 1) {
                    val idx = size / 8
                    bytes[idx] = (bytes[idx].toInt() or (0x80 ushr (size % 8))).toByte()
                }
                size++
            }
        }

        fun toBytes(): IntArray = IntArray(bytes.size) { bytes[it].toInt() and 0xFF }
    }

    /** Split into blocks, compute Reed-Solomon, then interleave as the spec requires. */
    private fun interleave(data: IntArray, version: Int): IntArray {
        val blocks = BLOCKS[version]
        val eccLen = ECC_PER_BLOCK[version]
        val shortLen = data.size / blocks
        val longCount = data.size % blocks

        val dataBlocks = ArrayList<IntArray>(blocks)
        val eccBlocks = ArrayList<IntArray>(blocks)
        var p = 0
        for (i in 0 until blocks) {
            val len = shortLen + if (i >= blocks - longCount) 1 else 0
            val b = data.copyOfRange(p, p + len)
            p += len
            dataBlocks.add(b)
            eccBlocks.add(reedSolomon(b, eccLen))
        }

        val out = ArrayList<Int>(TOTAL[version])
        val maxData = dataBlocks.maxOf { it.size }
        for (i in 0 until maxData) {
            for (b in dataBlocks) if (i < b.size) out.add(b[i])
        }
        for (i in 0 until eccLen) {
            for (b in eccBlocks) out.add(b[i])
        }
        return out.toIntArray()
    }

    // GF(256) with the QR primitive polynomial 0x11D.
    private val EXP = IntArray(512)
    private val LOG = IntArray(256)

    init {
        var x = 1
        for (i in 0 until 255) {
            EXP[i] = x
            LOG[x] = i
            x = x shl 1
            if (x and 0x100 != 0) x = x xor 0x11D
        }
        for (i in 255 until 512) EXP[i] = EXP[i - 255]
    }

    private fun mul(a: Int, b: Int): Int =
        if (a == 0 || b == 0) 0 else EXP[LOG[a] + LOG[b]]

    private fun reedSolomon(data: IntArray, eccLen: Int): IntArray {
        // Generator polynomial for eccLen check symbols.
        var gen = intArrayOf(1)
        for (i in 0 until eccLen) {
            val next = IntArray(gen.size + 1)
            for (j in gen.indices) {
                next[j] = next[j] xor gen[j]
                next[j + 1] = next[j + 1] xor mul(gen[j], EXP[i])
            }
            gen = next
        }
        val res = IntArray(eccLen)
        for (byte in data) {
            val factor = byte xor res[0]
            System.arraycopy(res, 1, res, 0, eccLen - 1)
            res[eccLen - 1] = 0
            for (j in 0 until eccLen) res[j] = res[j] xor mul(gen[j + 1], factor)
        }
        return res
    }

    // ----------------------------------------------------------- drawing

    private fun drawFunctionPatterns(m: Matrix, version: Int) {
        val size = m.size
        // Timing patterns first: finders overwrite their ends.
        for (i in 0 until size) {
            m.set(6, i, i % 2 == 0, lock = true)
            m.set(i, 6, i % 2 == 0, lock = true)
        }
        finder(m, 0, 0); finder(m, size - 7, 0); finder(m, 0, size - 7)

        val centres = ALIGN[version]
        for (a in centres) for (b in centres) {
            // Skip the three that would land on a finder.
            if ((a == 6 && b == 6) || (a == 6 && b == size - 7) || (a == size - 7 && b == 6)) continue
            alignment(m, a, b)
        }

        // Format areas are reserved here and written by drawFormat.
        for (i in 0..8) {
            if (i != 6) { m.set(i, 8, false, lock = true); m.set(8, i, false, lock = true) }
        }
        for (i in 0..7) m.set(size - 1 - i, 8, false, lock = true)
        for (i in 0..6) m.set(8, size - 1 - i, false, lock = true)
        m.set(8, size - 8, true, lock = true)   // always-dark module
    }

    private fun finder(m: Matrix, x: Int, y: Int) {
        for (dy in -1..7) for (dx in -1..7) {
            val px = x + dx
            val py = y + dy
            if (px !in 0 until m.size || py !in 0 until m.size) continue
            val d = maxOf(kotlin.math.abs(dx - 3), kotlin.math.abs(dy - 3))
            m.set(px, py, d != 2 && d <= 3, lock = true)
        }
    }

    private fun alignment(m: Matrix, cx: Int, cy: Int) {
        for (dy in -2..2) for (dx in -2..2) {
            val d = maxOf(kotlin.math.abs(dx), kotlin.math.abs(dy))
            m.set(cx + dx, cy + dy, d != 1, lock = true)
        }
    }

    private fun drawCodewords(m: Matrix, words: IntArray) {
        val size = m.size
        var bit = 0
        var col = size - 1
        while (col > 0) {
            if (col == 6) col--          // the vertical timing column is skipped
            for (row in 0 until size) {
                for (c in 0..1) {
                    val x = col - c
                    // Odd columns run upwards.
                    val upward = ((col + 1) and 2) == 0
                    val y = if (upward) size - 1 - row else row
                    if (m.isLocked(x, y)) continue
                    val dark = bit < words.size * 8 &&
                        (words[bit / 8] ushr (7 - bit % 8)) and 1 == 1
                    m.set(x, y, dark)
                    bit++
                }
            }
            col -= 2
        }
    }

    private fun applyMask(m: Matrix, mask: Int) {
        for (y in 0 until m.size) for (x in 0 until m.size) {
            if (m.isLocked(x, y)) continue
            val flip = when (mask) {
                0 -> (x + y) % 2 == 0
                1 -> y % 2 == 0
                2 -> x % 3 == 0
                3 -> (x + y) % 3 == 0
                4 -> (y / 2 + x / 3) % 2 == 0
                5 -> (x * y) % 2 + (x * y) % 3 == 0
                6 -> ((x * y) % 2 + (x * y) % 3) % 2 == 0
                else -> ((x + y) % 2 + (x * y) % 3) % 2 == 0
            }
            if (flip) m.set(x, y, !m[x, y])
        }
    }

    private fun drawFormat(m: Matrix, mask: Int) {
        // ECC level M is 0b00; 15 bits of BCH(15,5) then XOR 0x5412.
        val data = (0b00 shl 3) or mask
        var rem = data
        for (i in 0 until 10) {
            rem = (rem shl 1) xor ((rem ushr 9) * 0x537)
        }
        val bits = ((data shl 10) or rem) xor 0x5412

        val size = m.size
        for (i in 0..5) m.set(8, i, bit(bits, i), lock = true)
        m.set(8, 7, bit(bits, 6), lock = true)
        m.set(8, 8, bit(bits, 7), lock = true)
        m.set(7, 8, bit(bits, 8), lock = true)
        for (i in 9..14) m.set(14 - i, 8, bit(bits, i), lock = true)

        for (i in 0..7) m.set(size - 1 - i, 8, bit(bits, i), lock = true)
        for (i in 8..14) m.set(8, size - 15 + i, bit(bits, i), lock = true)
        m.set(8, size - 8, true, lock = true)
    }

    private fun bit(v: Int, i: Int) = (v ushr i) and 1 == 1

    /** The four penalty rules, used only to choose between masks. */
    private fun penalty(m: Matrix): Int {
        val size = m.size
        var score = 0

        // Rule 1: runs of five or more.
        for (i in 0 until size) {
            var runColour = m[0, i]; var run = 1
            for (j in 1 until size) {
                if (m[j, i] == runColour) run++ else { if (run >= 5) score += run - 2; runColour = m[j, i]; run = 1 }
            }
            if (run >= 5) score += run - 2
            runColour = m[i, 0]; run = 1
            for (j in 1 until size) {
                if (m[i, j] == runColour) run++ else { if (run >= 5) score += run - 2; runColour = m[i, j]; run = 1 }
            }
            if (run >= 5) score += run - 2
        }

        // Rule 2: 2x2 blocks of one colour.
        for (y in 0 until size - 1) for (x in 0 until size - 1) {
            val c = m[x, y]
            if (c == m[x + 1, y] && c == m[x, y + 1] && c == m[x + 1, y + 1]) score += 3
        }

        // Rule 3: the finder-like 1:1:3:1:1 pattern.
        val a = booleanArrayOf(true, false, true, true, true, false, true, false, false, false, false)
        val b = booleanArrayOf(false, false, false, false, true, false, true, true, true, false, true)
        for (y in 0 until size) for (x in 0 until size - 10) {
            var ha = true; var hb = true; var va = true; var vb = true
            for (k in 0 until 11) {
                if (m[x + k, y] != a[k]) ha = false
                if (m[x + k, y] != b[k]) hb = false
                if (m[y, x + k] != a[k]) va = false
                if (m[y, x + k] != b[k]) vb = false
            }
            if (ha) score += 40
            if (hb) score += 40
            if (va) score += 40
            if (vb) score += 40
        }

        // Rule 4: deviation from an even split of dark and light.
        var dark = 0
        for (y in 0 until size) for (x in 0 until size) if (m[x, y]) dark++
        val percent = dark * 100 / (size * size)
        score += (kotlin.math.abs(percent - 50) / 5) * 10
        return score
    }
}
