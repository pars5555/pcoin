package org.pcoin.miner

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Amount parsing is the one place a slip becomes a 100,000,000x error, so it is
 * tested on a plain JVM with no Android on the classpath.
 */
class AmountsTest {

    private fun sat(s: String): Long {
        val p = Amounts.parse(s)
        assertTrue("expected $s to parse, got $p", p is Amounts.Parsed.Ok)
        return (p as Amounts.Parsed.Ok).sat
    }

    private fun bad(s: String?): Amounts.Reason {
        val p = Amounts.parse(s)
        assertTrue("expected $s to be rejected, got $p", p is Amounts.Parsed.Bad)
        return (p as Amounts.Parsed.Bad).why
    }

    @Test
    fun `whole coins`() {
        assertEquals(100_000_000L, sat("1"))
        assertEquals(100_000_000L, sat("1.0"))
        assertEquals(5_000_000_000L, sat("50"))
    }

    @Test
    fun `the value a double would get wrong`() {
        // 0.1 * 1e8 in IEEE754 is 10000000.000000002.
        assertEquals(10_000_000L, sat("0.1"))
        assertEquals(70_000_000L, sat("0.7"))
        assertEquals(2_900_000L, sat("0.029"))
    }

    @Test
    fun `full precision`() {
        assertEquals(1L, sat("0.00000001"))
        assertEquals(12_345_678_901L, sat("123.45678901"))
    }

    @Test
    fun `nine decimals is a typo, not a tiny amount`() {
        assertEquals(Amounts.Reason.TOO_MANY_DECIMALS, bad("0.123456789"))
    }

    @Test
    fun `rejects what should never be sent`() {
        assertEquals(Amounts.Reason.EMPTY, bad(""))
        assertEquals(Amounts.Reason.EMPTY, bad(null))
        assertEquals(Amounts.Reason.EMPTY, bad("   "))
        assertEquals(Amounts.Reason.NOT_A_NUMBER, bad("abc"))
        assertEquals(Amounts.Reason.NEGATIVE, bad("-1"))
        assertEquals(Amounts.Reason.ZERO, bad("0"))
        assertEquals(Amounts.Reason.ZERO, bad("0.00000000"))
        assertEquals(Amounts.Reason.TOO_LARGE, bad("21000001"))
    }

    @Test
    fun `grouping separators are ambiguous and refused, never guessed`() {
        // A German phone renders 1,5 for one and a half. Accepting both
        // spellings in one field is how someone sends 15 meaning 1.5.
        assertEquals(Amounts.Reason.NOT_A_NUMBER, bad("1,5"))
        assertEquals(Amounts.Reason.NOT_A_NUMBER, bad("1,000"))
    }

    @Test
    fun `dust is a send-time question, not a parsing one`() {
        // Parsing succeeds -- 293 satoshis is a perfectly well-formed number.
        assertEquals(293L, sat("0.00000293"))
        assertEquals(294L, sat("0.00000294"))
        // The send path is what refuses it.
        assertTrue(Amounts.isDust(293L))
        assertTrue(!Amounts.isDust(294L))
    }

    @Test
    fun `pasted input`() {
        assertEquals(100_000_000L, sat("  1  "))
        assertEquals(100_000_000L, sat("+1"))
    }

    @Test
    fun `node string is fixed point, never scientific`() {
        assertEquals("0.00000001", Amounts.toNodeString(1))
        assertEquals("1.00000000", Amounts.toNodeString(100_000_000))
        assertEquals("123.45678901", Amounts.toNodeString(12_345_678_901))
        assertEquals("106750.99986703", Amounts.toNodeString(10_675_099_986_703))
    }

    @Test
    fun `round trip`() {
        // Compare satoshis, not trimmed strings. Trimming trailing zeros turns
        // "50" into "5", which is exactly the kind of silent corruption this
        // class exists to prevent -- and it fooled the first version of this
        // very test.
        for (s in listOf("0.00000001", "0.00000294", "0.1", "1", "50", "123.45678901", "20999999.99999999")) {
            val v = sat(s)
            assertEquals("round trip of $s", v, sat(Amounts.toNodeString(v)))
        }
    }
}
