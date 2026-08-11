package org.pcoin.miner

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The rebuild trigger, against the strings bitcoind actually prints.
 *
 * This predicate decides whether the app rebuilds the block database on a phone
 * holding real coins, from text produced by another program. The false-positive
 * cases below matter more than the true ones: a wrong "yes" is what would turn
 * a one-shot repair into a device that rebuilds its chain on every start.
 */
class NodeLogTest {

    @Test
    fun `Core asking for a restart is detected`() {
        assertTrue(
            NodeLog.demandsReindex(
                listOf("Error: Please restart with -reindex or -reindex-chainstate to recover.")
            )
        )
    }

    @Test
    fun `Core asking for a rebuild is detected`() {
        assertTrue(
            NodeLog.demandsReindex(
                listOf("You need to rebuild the database using -reindex to change -txindex.")
            )
        )
    }

    @Test
    fun `the demand is found anywhere in the tail, not only on the last line`() {
        assertTrue(
            NodeLog.demandsReindex(
                listOf(
                    "2026-08-11T04:00:00Z init message: Loading block index...",
                    "Error: Please restart with -reindex to recover.",
                    "2026-08-11T04:00:01Z Shutdown: done",
                )
            )
        )
    }

    @Test
    fun `case does not matter`() {
        assertTrue(NodeLog.demandsReindex(listOf("PLEASE RESTART WITH -REINDEX")))
    }

    // ------------------------------------------------------- false positives

    @Test
    fun `our own spawn line is not a demand`() {
        // THE ONE THAT MATTERS. NodeController logs its command line on every
        // spawn, so once a rebuild is armed the tail contains "-reindex" put
        // there by this app. Reading that back as the node asking for another
        // rebuild is the path to a phone that rebuilds its chain forever.
        assertFalse(
            NodeLog.demandsReindex(
                listOf("spawning: /data/app/.../libbitcoind.so -datadir=/data/.../pcoin -reindex")
            )
        )
    }

    @Test
    fun `progress output during a rebuild is not a fresh demand`() {
        assertFalse(
            NodeLog.demandsReindex(
                listOf(
                    "Reindexing block file blk00000.dat...",
                    "2026-08-11T04:00:02Z Reindexing finished",
                )
            )
        )
    }

    @Test
    fun `an unrelated restart message is not a demand`() {
        assertFalse(NodeLog.demandsReindex(listOf("Shutdown requested, restart to apply settings")))
    }

    @Test
    fun `ordinary startup output is not a demand`() {
        assertFalse(
            NodeLog.demandsReindex(
                listOf(
                    "PCoin Core starting",
                    "Loading banlist...",
                    "init message: Verifying blocks...",
                    "UpdateTip: new best=00000000 height=2917",
                )
            )
        )
    }

    @Test
    fun `an empty tail is not a demand`() {
        // A node that produced no output at all resolves nothing. It must never
        // read as a request to rebuild anything.
        assertFalse(NodeLog.demandsReindex(emptyList()))
    }
}
