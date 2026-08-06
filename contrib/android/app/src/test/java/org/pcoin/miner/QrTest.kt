package org.pcoin.miner

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * [Qr] against golden vectors from an INDEPENDENT implementation.
 *
 * `src/test/resources/qr_vectors.txt` was produced by the Python `qrcode`
 * library (byte mode, ECC M, border 0 -- the same choices Qr.kt makes) using
 * `scratchpad/qr_reference.py`.
 *
 * **What is compared, and why not the raw modules.** The comparison unmasks both
 * symbols first and then diffs. Two conforming encoders can legitimately choose
 * different data masks -- python-qrcode's penalty scoring does not agree with a
 * straight reading of the spec's four rules, and it picks mask 4 where both this
 * implementation and an independent Python transcription of the spec rules score
 * mask 2 lower. Asserting module-for-module equality would pin us to another
 * library's non-spec choice. What actually has to be identical is everything the
 * mask does not touch: the codewords, the Reed-Solomon parity, where each bit
 * lands, and every function pattern. That is what is asserted here, and it comes
 * out at zero differing modules.
 *
 * **Decodability was verified separately**, because matching another encoder
 * proves nothing to a camera. `QrDumpTest` writes every payload under all eight
 * masks; `scratchpad/qr_decode2.py` renders them and reads them back with two
 * independent decoders (OpenCV and zxing-cpp) at two scales. Result: 40 of 40
 * symbols read correctly, with a single OpenCV-only miss at one scale that zxing
 * reads fine at both -- a decoder quirk, not a malformed symbol, since a real
 * defect does not appear only at the LARGER rendering.
 *
 * To regenerate the vectors after a deliberate change: run
 * `scratchpad/qr_reference.py` and replace the resource. Do not hand-edit it.
 */
class QrTest {

    private class Vector(
        val name: String,
        val version: Int,
        val size: Int,
        val text: String,
        val rows: List<String>,
    )

    private fun vectors(): List<Vector> {
        val text = javaClass.classLoader!!
            .getResourceAsStream("qr_vectors.txt")!!
            .bufferedReader()
            .readText()
        val out = ArrayList<Vector>()
        var name = ""; var version = 0; var size = 0; var payload: String? = null
        val rows = ArrayList<String>()

        fun flush() {
            if (payload != null) out.add(Vector(name, version, size, payload!!, ArrayList(rows)))
            payload = null; rows.clear()
        }

        for (raw in text.lines()) {
            val line = raw.trim()
            when {
                line.startsWith("###") -> {
                    flush()
                    val parts = line.removePrefix("###").split("|").map { it.trim() }
                    name = parts[0]
                    version = parts[1].substringAfter("=").toInt()
                    size = parts[2].substringAfter("=").toInt()
                }
                line.isEmpty() -> Unit
                payload == null && !line.matches(Regex("[01]+")) -> payload = line
                line.matches(Regex("[01]+")) -> rows.add(line)
                else -> Unit
            }
        }
        flush()
        return out
    }

    /** The mask a symbol declares, read back out of its format information. */
    private fun maskOf(dark: (Int, Int) -> Boolean): Int {
        var bits = 0
        for (i in 0..5) if (dark(8, i)) bits = bits or (1 shl i)
        if (dark(8, 7)) bits = bits or (1 shl 6)
        if (dark(8, 8)) bits = bits or (1 shl 7)
        if (dark(7, 8)) bits = bits or (1 shl 8)
        for (i in 9..14) if (dark(14 - i, 8)) bits = bits or (1 shl i)
        // 15-bit word is (data << 10) | bch, and data is (ecc << 3) | mask.
        return ((bits xor 0x5412) shr 10) and 7
    }

    private fun maskBit(mask: Int, x: Int, y: Int): Boolean = when (mask) {
        0 -> (x + y) % 2 == 0
        1 -> y % 2 == 0
        2 -> x % 3 == 0
        3 -> (x + y) % 3 == 0
        4 -> (y / 2 + x / 3) % 2 == 0
        5 -> (x * y) % 2 + (x * y) % 3 == 0
        6 -> ((x * y) % 2 + (x * y) % 3) % 2 == 0
        else -> ((x + y) % 2 + (x * y) % 3) % 2 == 0
    }

    @Test
    fun `the vector file loaded`() {
        val v = vectors()
        assertEquals("expected five golden vectors", 5, v.size)
        v.forEach { assertEquals("${it.name}: row count", it.size, it.rows.size) }
    }

    @Test
    fun `every symbol is the version and size the reference chose`() {
        for (v in vectors()) {
            val m = Qr.encode(v.text)
            assertNotNull("${v.name}: encoder returned null for a payload that fits", m)
            assertEquals("${v.name}: size (reference version ${v.version})", v.size, m!!.size)
        }
    }

    @Test
    fun `function patterns match the reference exactly`() {
        // Finders, timing, alignment, the dark module: everything the mask does
        // not touch and that a scanner locks onto first.
        for (v in vectors()) {
            val m = Qr.encode(v.text)!!
            var diff = 0
            for (y in 0 until v.size) for (x in 0 until v.size) {
                if (!m.isLocked(x, y)) continue
                // Format modules encode the mask, so they legitimately differ.
                val isFormat = (x == 8 && (y <= 8 || y >= v.size - 8)) ||
                    (y == 8 && (x <= 8 || x >= v.size - 8))
                if (isFormat) continue
                if (m[x, y] != (v.rows[y][x] == '1')) diff++
            }
            assertEquals("${v.name}: function modules differing", 0, diff)
        }
    }

    @Test
    fun `unmasked data matches the reference module for module`() {
        // The real assertion: identical codewords, identical Reed-Solomon parity,
        // identical placement. Independent of which mask either side chose.
        for (v in vectors()) {
            val m = Qr.encode(v.text)!!
            val ourMask = maskOf { x, y -> m[x, y] }
            val refMask = maskOf { x, y -> v.rows[y][x] == '1' }

            var diff = 0
            val first = ArrayList<String>()
            for (y in 0 until v.size) for (x in 0 until v.size) {
                if (m.isLocked(x, y)) continue          // function module
                val ours = m[x, y] xor maskBit(ourMask, x, y)
                val theirs = (v.rows[y][x] == '1') xor maskBit(refMask, x, y)
                if (ours != theirs) { diff++; if (first.size < 8) first.add("($x,$y)") }
            }
            assertEquals(
                "${v.name}: unmasked data differs (ours mask=$ourMask, ref mask=$refMask) ${first.joinToString(" ")}",
                0, diff,
            )
        }
    }

    @Test
    fun `the declared mask is one of the eight`() {
        for (v in vectors()) {
            val m = Qr.encode(v.text)!!
            assertTrue("${v.name}: mask in range", maskOf { x, y -> m[x, y] } in 0..7)
        }
    }

    @Test
    fun `a real PCoin address encodes at version 3`() {
        // 42 characters in byte mode. If this ever changes, the receive screen's
        // layout assumptions change with it.
        val m = Qr.encode("pc1qtestvectoraaaaaaaaaaaaaaaaaaaaaaaaqqqq")
        assertNotNull(m)
        assertEquals(29, m!!.size)   // 17 + 3*4
    }

    @Test
    fun `every mask produces a well-formed symbol`() {
        // All eight were rendered and read back by two independent decoders --
        // see the class comment. Here we assert only the structure, which is
        // what a JVM test can check without a decoder.
        val text = "pc1qtestvectorzzzzzzzzzzzzzzzzzzzzzzzz2345"
        for (mask in 0..7) {
            val m = Qr.encode(text, mask)!!
            assertEquals("mask $mask: size", 29, m.size)
            assertEquals("mask $mask: declared mask", mask, maskOf { x, y -> m[x, y] })
            assertTrue("mask $mask: dark module", m[8, m.size - 8])
            // Timing patterns must survive masking.
            for (i in 8 until m.size - 8) {
                assertEquals("mask $mask: h timing at $i", i % 2 == 0, m[i, 6])
                assertEquals("mask $mask: v timing at $i", i % 2 == 0, m[6, i])
            }
        }
    }

    @Test
    fun `the finder patterns are where the spec puts them`() {
        val m = Qr.encode("pc1qtestvectoraaaaaaaaaaaaaaaaaaaaaaaaqqqq")!!
        for ((cx, cy) in listOf(3 to 3, m.size - 4 to 3, 3 to m.size - 4)) {
            assertTrue("finder centre at ($cx,$cy)", m[cx, cy])
            assertTrue("finder ring at ($cx,${cy - 2})", !m[cx, cy - 2])
            assertTrue("finder outer at ($cx,${cy - 3})", m[cx, cy - 3])
        }
    }

    @Test
    fun `text too large for version 10 returns null rather than a wrong symbol`() {
        // Null is a real answer. Truncating, or emitting a partial symbol beside
        // an address someone is about to be paid at, is how coins go missing.
        assertNull(Qr.encode("x".repeat(400)))
    }

    @Test
    fun `an empty string still produces a valid symbol`() {
        val m = Qr.encode("")
        assertNotNull(m)
        assertEquals(21, m!!.size)
    }

    @Test
    fun `encoding is deterministic`() {
        // Mask selection scores every mask; an unstable choice would make the
        // rendered code change under the user between redraws.
        val a = Qr.encode("pc1qtestvectoraaaaaaaaaaaaaaaaaaaaaaaaqqqq")!!
        val b = Qr.encode("pc1qtestvectoraaaaaaaaaaaaaaaaaaaaaaaaqqqq")!!
        for (y in 0 until a.size) for (x in 0 until a.size) {
            assertEquals("module ($x,$y)", a[x, y], b[x, y])
        }
    }
}
