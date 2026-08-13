package org.pcoin.miner

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Who a transaction says was on the other side.
 *
 * This decides what a receipt claims about a counterparty and which address a
 * "pay this" button would fill in, so the cases that matter most are the ones
 * where the honest answer is "several" or "cannot say".
 */
class TxPartiesTest {

    private val mine1 = "pc1qlvw6kx8wkcz8f6p0d6kswv69fjt33ll079f64e"
    private val mine2 = "pc1qw35szkv5hfsfxxtv82jhy5rp46s5yph9prnktu"
    private val them1 = "pc1qtadn46mj4p6w9gwgykz8j7h8yh89k90rsqxgsv"
    private val them2 = "pc1q8ghcjcxxuv6wg4sp7zhs6udv3vfpm6y8l9kfm5"

    @Test
    fun `our own change address is not a counterparty`() {
        // A send pays the recipient AND returns change to us. Showing the change
        // address would tell someone they had paid themselves.
        val outputs = listOf(them1, mine1)
        assertEquals(listOf(them1), TxParties.counterparties(outputs, setOf(mine1)))
    }

    @Test
    fun `several inputs give several addresses, not one`() {
        val inputs = listOf(them1, them2)
        assertEquals(listOf(them1, them2), TxParties.counterparties(inputs, emptySet()))
    }

    @Test
    fun `duplicates collapse but order is kept`() {
        // Stable order matters: a list that reshuffles between viewings reads as
        // though the underlying data changed.
        val inputs = listOf(them2, them1, them2, them1)
        assertEquals(listOf(them2, them1), TxParties.counterparties(inputs, emptySet()))
    }

    @Test
    fun `matching our addresses is case-insensitive for bech32`() {
        // The node reports lower case, but an address may have been recorded in
        // upper case from a QR. Missing that would show our own address as the
        // person who paid us.
        assertTrue(TxParties.counterparties(listOf(mine1.uppercase()), setOf(mine1)).isEmpty())
    }

    @Test
    fun `a self-transfer has no counterparty at all`() {
        assertTrue(TxParties.counterparties(listOf(mine1, mine2), setOf(mine1, mine2)).isEmpty())
    }

    @Test
    fun `blank and whitespace entries are dropped`() {
        assertEquals(listOf(them1), TxParties.counterparties(listOf("", "   ", them1), emptySet()))
    }

    // --------------------------------------------------------------- payable

    @Test
    fun `payable refuses anything too short to be an address`() {
        // Never let a stray string reach the compose field of a payment.
        assertEquals(listOf(them1), TxParties.payable(listOf("pc1short", them1), emptySet()))
    }

    @Test
    fun `payable never offers our own address`() {
        assertTrue(TxParties.payable(listOf(mine1), setOf(mine1)).isEmpty())
    }

    // ----------------------------------------------------- why we cannot say

    @Test
    fun `an unconfirmed transaction cannot have its inputs resolved yet`() {
        // Inputs are resolved by asking for the transaction WITHIN ITS BLOCK,
        // which is the only route on a node with no txindex. No block, no answer.
        assertEquals(
            "not in a block yet",
            TxParties.unresolvableReason(confirmations = 0, hasBlockHash = false, isCoinbase = false),
        )
    }

    @Test
    fun `a confirmed transaction with no block hash is still unresolvable`() {
        assertEquals(
            "not in a block yet",
            TxParties.unresolvableReason(confirmations = 6, hasBlockHash = false, isCoinbase = false),
        )
    }

    @Test
    fun `mined coins have no sender and say so`() {
        assertEquals(
            "newly mined coins have no sender",
            TxParties.unresolvableReason(confirmations = 200, hasBlockHash = true, isCoinbase = true),
        )
    }

    @Test
    fun `a confirmed ordinary transaction is resolvable`() {
        assertNull(TxParties.unresolvableReason(confirmations = 1, hasBlockHash = true, isCoinbase = false))
    }
}
