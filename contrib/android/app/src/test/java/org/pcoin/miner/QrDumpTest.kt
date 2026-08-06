package org.pcoin.miner

import org.junit.Test
import java.io.File

/**
 * Writes our symbols out so an independent DECODER can try to read them.
 *
 * Matching another encoder's mask choice proves nothing a scanner cares about;
 * being decodable does. Run this, then decode the output with
 * `scratchpad/qr_decode.py` (OpenCV) and check every payload round-trips.
 * Not an assertion-bearing test -- it exists to produce evidence.
 */
class QrDumpTest {

    private val cases = listOf(
        "addr_a" to "pc1qtestvectoraaaaaaaaaaaaaaaaaaaaaaaaqqqq",
        "addr_b" to "pc1qtestvectorzzzzzzzzzzzzzzzzzzzzzzzz2345",
        "short" to "PCoin",
        "uri" to "pcoin:pc1qtestvectoraaaaaaaaaaaaaaaaaaaaaaaaqqqq?amount=1.5",
        "long" to "pcoin:pc1qtestvectoraaaaaaaaaaaaaaaaaaaaaaaaqqqq" +
            "?amount=123.45678901&label=PCoin+cold+storage",
    )

    private fun write(file: File, entries: List<Triple<String, String, Qr.Matrix>>) {
        file.printWriter().use { w ->
            for ((name, text, m) in entries) {
                w.println("### $name | size=${m.size}")
                w.println(text)
                for (y in 0 until m.size) {
                    w.println((0 until m.size).joinToString("") { x -> if (m[x, y]) "1" else "0" })
                }
                w.println()
            }
        }
        println("WROTE ${file.absolutePath}")
    }

    @Test
    fun dumpChosenMasks() {
        write(
            File(System.getProperty("java.io.tmpdir"), "pcoin-qr-ours.txt"),
            cases.map { (n, t) -> Triple(n, t, Qr.encode(t)!!) },
        )
    }

    @Test
    fun dumpEveryMaskForEveryCase() {
        // Isolates mask selection from everything upstream of it: if some masks
        // decode and others do not, the data is fine and the scoring is not.
        write(
            File(System.getProperty("java.io.tmpdir"), "pcoin-qr-allmasks.txt"),
            cases.flatMap { (n, t) ->
                (0..7).map { mask -> Triple("$n-m$mask", t, Qr.encode(t, mask)!!) }
            },
        )
    }
}
