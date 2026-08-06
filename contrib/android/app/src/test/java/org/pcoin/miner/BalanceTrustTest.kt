package org.pcoin.miner

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * [MinerState.Snapshot.balanceIsTrustworthy] -- the gate between the node's
 * numbers and the figure a person reads as their money.
 *
 * The case that motivated every test here is `freshly restarted node`: it was
 * observed on the test device, not imagined. A hard kill left the node coming
 * back at height 0 with a block tree of one block, resyncing from genesis, and
 * the wallet screen said "Up to date" above a confident 0.00000000 for an
 * account that had just held coins. Two plausible-looking conditions passed and
 * the wrong answer came out looking exactly like the right one.
 */
class BalanceTrustTest {

    private fun snap(
        height: Long,
        headers: Long,
        ibd: Boolean,
    ) = MinerState.Snapshot(height = height, headers = headers, initialBlockDownload = ibd)

    @Test
    fun `a synced node at the tip is trustworthy`() {
        assertTrue(snap(2311, 2311, ibd = false).balanceIsTrustworthy)
    }

    @Test
    fun `a freshly restarted node at height zero is NOT trustworthy`() {
        // The real defect. height >= headers holds trivially at 0 >= 0, so this
        // has to be caught by the IBD flag or not at all.
        assertFalse(snap(0, 0, ibd = true).balanceIsTrustworthy)
    }

    @Test
    fun `the default snapshot is not trustworthy`() {
        // Before anything has been read the honest answer is "I do not know",
        // and the default must not be answer-shaped.
        assertFalse(MinerState.Snapshot().balanceIsTrustworthy)
    }

    @Test
    fun `a node that never answered is not trustworthy`() {
        assertFalse(snap(-1, -1, ibd = false).balanceIsTrustworthy)
        assertFalse(snap(2311, -1, ibd = false).balanceIsTrustworthy)
        assertFalse(snap(-1, 2311, ibd = false).balanceIsTrustworthy)
    }

    @Test
    fun `a node still downloading blocks is not trustworthy`() {
        assertFalse(snap(500, 2311, ibd = true).balanceIsTrustworthy)
    }

    @Test
    fun `a node behind its own headers is not trustworthy`() {
        // Even with IBD cleared: headers run ahead of blocks, and the wallet has
        // not scanned the gap.
        assertFalse(snap(2300, 2311, ibd = false).balanceIsTrustworthy)
    }

    @Test
    fun `a node ahead of its known headers is trustworthy`() {
        // Blocks and headers arrive as separate messages, so height can lead by
        // one for a moment. That is not a reason to blank someone's balance.
        assertTrue(snap(2312, 2311, ibd = false).balanceIsTrustworthy)
    }

    @Test
    fun `IBD alone is enough to withhold the figure`() {
        // Everything else looks perfect; the node says it is still catching up.
        assertFalse(snap(2311, 2311, ibd = true).balanceIsTrustworthy)
    }

    // ------------------------------------------------- when was this READ?

    @Test
    fun `chainReadAtMs defaults to never`() {
        // Answer-shaped defaults are the bug this whole file is about. Zero is
        // "never read", and the home screen renders that as "Not checked yet".
        assertEquals(0L, MinerState.Snapshot().chainReadAtMs)
    }

    @Test
    fun `chainReadAtMs is independent of updatedAtMs`() {
        // The distinction is the entire point. updatedAtMs advances on every
        // publish, including the ones that carry a stale reading forward because
        // the RPC failed; chainReadAtMs must only move when the node answered.
        // A screen keying off the wrong one says "Updated just now" for hours
        // over a node that died -- which is what it did.
        val s = MinerState.Snapshot(updatedAtMs = 9_000L, chainReadAtMs = 1_000L)
        assertEquals(9_000L, s.updatedAtMs)
        assertEquals(1_000L, s.chainReadAtMs)
        assertTrue(s.updatedAtMs > s.chainReadAtMs)
    }

    @Test
    fun `a refresh only counts as successful on a strictly newer read`() {
        // The rule the home screen applies. Modelled here because the screen
        // itself needs an Activity to test, and getting this backwards produced
        // a green "refreshed" result in 1.5 s from a node that had not answered
        // in twenty minutes.
        fun refreshSucceeded(readAtPress: Long, readNow: Long) = readNow > readAtPress

        assertTrue("the node answered again", refreshSucceeded(1_000L, 1_001L))
        assertFalse("nothing new came back", refreshSucceeded(1_000L, 1_000L))
        assertFalse("cannot go backwards", refreshSucceeded(1_000L, 999L))
        // And the case a balance comparison gets wrong: a perfectly good refresh
        // that returns the very same number, which is the common case.
        assertTrue("same balance, genuinely re-read", refreshSucceeded(1_000L, 4_000L))
    }
}
