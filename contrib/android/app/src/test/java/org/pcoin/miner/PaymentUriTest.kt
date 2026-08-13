package org.pcoin.miner

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * What a scanned QR is allowed to mean.
 *
 * This sits on the payment path: whatever comes out lands in the address field
 * of a send. It cannot make a bad address good -- the node still validates and
 * the review step still shows what was built -- but it can and must refuse to
 * turn a random QR into something that looks like a destination.
 */
class PaymentUriTest {

    private val addr = "pc1qlvw6kx8wkcz8f6p0d6kswv69fjt33ll079f64e"

    @Test
    fun `a bare address is what this app's own receive screen encodes`() {
        assertEquals(addr, PaymentUri.parse(addr)?.address)
        assertNull(PaymentUri.parse(addr)?.amountSat)
    }

    @Test
    fun `a scheme is stripped`() {
        assertEquals(addr, PaymentUri.parse("pcoin:$addr")?.address)
        assertEquals(addr, PaymentUri.parse("PCOIN:$addr")?.address)
        assertEquals(addr, PaymentUri.parse("pcoin://$addr")?.address)
    }

    @Test
    fun `UPPER CASE bech32 is accepted and folded`() {
        // Not an edge case. QR's alphanumeric mode is digits and capitals only
        // and is much denser than byte mode, so encoders routinely upper-case a
        // bech32 address to shrink the code. Rejecting it would fail on a large
        // share of real codes.
        assertEquals(addr, PaymentUri.parse(addr.uppercase())?.address)
        assertEquals(addr, PaymentUri.parse("PCOIN:" + addr.uppercase())?.address)
    }

    @Test
    fun `base58 case is never folded`() {
        // Base58 IS case-sensitive; folding would turn a valid address into a
        // different one.
        val b58 = "PGmqNfjbG1YxpTNQnnQhFqDBRz3LPPQjHF"
        assertEquals(b58, PaymentUri.parse(b58)?.address)
    }

    @Test
    fun `an amount is read when stated`() {
        assertEquals(150_000_000L, PaymentUri.parse("pcoin:$addr?amount=1.5")?.amountSat)
        assertEquals(addr, PaymentUri.parse("pcoin:$addr?amount=1.5")?.address)
    }

    @Test
    fun `other parameters do not confuse the amount`() {
        val t = PaymentUri.parse("pcoin:$addr?label=Market&amount=2&message=hi")
        assertEquals(addr, t?.address)
        assertEquals(200_000_000L, t?.amountSat)
    }

    @Test
    fun `an unreadable amount yields null, and the address still comes through`() {
        // The deliberate direction: never let a bad amount cost the user the
        // address, and never invent a number. Null leaves the box empty.
        for (bad in listOf("amount=abc", "amount=", "amount=-1", "amount=1.123456789")) {
            val t = PaymentUri.parse("pcoin:$addr?$bad")
            assertEquals("address must survive $bad", addr, t?.address)
            assertNull("amount must be null for $bad", t?.amountSat)
        }
    }

    @Test
    fun `a QR that is not a payment is refused`() {
        assertNull(PaymentUri.parse(null))
        assertNull(PaymentUri.parse(""))
        assertNull(PaymentUri.parse("   "))
        assertNull(PaymentUri.parse("hello"))
        assertNull(PaymentUri.parse("https://pc.am"))
        assertNull(PaymentUri.parse("pc1qshort"))
    }

    @Test
    fun `an address containing whitespace is refused`() {
        // A QR holding a sentence must not be mined for something address-shaped.
        assertNull(PaymentUri.parse("pc1qlvw6kx8 wkcz8f6p0d6kswv69fjt33ll079f64e"))
    }

    @Test
    fun `surrounding whitespace is tolerated`() {
        assertEquals(addr, PaymentUri.parse("  $addr\n")?.address)
    }
}
