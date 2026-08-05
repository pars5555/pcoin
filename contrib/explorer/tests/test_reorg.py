"""Reorg tests.

CLAUDE.md section 10.12: 66 chain tips over ~2100 blocks, a ~3% stale rate, and
LWMA at height 2800 halves block spacing again. Reorgs are the normal case here.
An index that unwinds them wrongly reports wrong balances forever and never
notices, so this file is the load-bearing part of the test suite.

The central test is `test_apply_unwind_is_exact_inverse`: take a whole-database
snapshot, apply blocks, unwind them, and require the database to be byte-for-byte
what it was. That is a much stronger statement than "the balance came out right".
"""

import random
import unittest

from . import helpers
from .fakechain import COIN, SUBSIDY, FakeChain, FakeRpc
from .helpers import diff_snapshots, make_indexer, snapshot
from pcoin_indexer import db, queries
from pcoin_indexer.indexer import ChainLinkError, Indexer, verify


class ReorgTestCase(unittest.TestCase):
    def setUp(self):
        self.chain = FakeChain()
        self.rpc = FakeRpc(self.chain)
        self.conn, self.idx = make_indexer(self.rpc)
        self.addCleanup(self.conn.close)

    # -- assertions -----------------------------------------------------
    def assertClean(self, msg=""):
        problems = verify(self.conn, deep=True)
        self.assertEqual(problems, [], "%s\n%s" % (msg, "\n".join(problems)))

    def assertMatchesNode(self):
        """The index tip is the node tip and every hash on the way agrees."""
        chain = self.chain.active_chain()
        tip_h, tip_hash = self.idx.tip()
        self.assertEqual(tip_h, len(chain) - 1)
        self.assertEqual(tip_hash, chain[-1])
        rows = self.conn.execute("SELECT height, hash FROM blocks"
                                 " ORDER BY height").fetchall()
        self.assertEqual([r["hash"] for r in rows], chain)

    def balance(self, address):
        return queries.address_summary(self.conn, address)["balance"]

    def spendable(self, address):
        return queries.address_summary(self.conn, address)["spendable"]

    # -- basics ---------------------------------------------------------
    def test_linear_sync(self):
        self.chain.mine_many(10, miner="A")
        self.idx.sync()
        self.assertMatchesNode()
        self.assertClean()
        # genesis is unspendable, so 10 coinbases of 50 PCN each land on A
        self.assertEqual(self.balance("A"), 10 * SUBSIDY)
        self.assertEqual(self.balance("NOBODY"), 0)

    def test_genesis_output_is_unspendable(self):
        """PCoin's genesis pays a bare pubkey that was never in the UTXO set
        (chainparams.cpp:62). Counting it would put the index 50 PCN over."""
        self.idx.sync()
        row = self.conn.execute("SELECT unspendable, address FROM outputs"
                                " WHERE height=0").fetchone()
        self.assertEqual(row["unspendable"], 1)
        self.assertIsNone(row["address"])
        sup = self.conn.execute(
            "SELECT COALESCE(SUM(value),0) v FROM outputs"
            " WHERE spent_height IS NULL AND unspendable=0").fetchone()["v"]
        self.assertEqual(sup, 0)

    def test_witness_commitment_is_unspendable(self):
        self.chain.mine(miner="A")
        self.idx.sync()
        row = self.conn.execute(
            "SELECT unspendable, script_type, value FROM outputs"
            " WHERE height=1 AND n=1").fetchone()
        self.assertEqual((row["unspendable"], row["script_type"], row["value"]),
                         (1, "nulldata", 0))

    # -- the central invariant -----------------------------------------
    def test_apply_unwind_is_exact_inverse(self):
        self.chain.mine_many(6, miner="A")
        cb3 = self.chain.coinbase_txid(3)
        self.chain.mine(miner="A", spends=[(cb3, 0)],
                        pays=[("B", 30 * COIN), ("A", 19 * COIN)])
        self.idx.sync()
        before = snapshot(self.conn)
        before_h = self.idx.tip_height()

        # Extend by blocks that spend earlier outputs, including one that spends
        # an output created in the very same block.
        cb5 = self.chain.coinbase_txid(5)
        self.chain.mine(miner="C", spends=[(cb5, 0)], pays=[("D", 49 * COIN)])
        self.chain.mine_many(3, miner="A")
        cb2 = self.chain.coinbase_txid(2)
        self.chain.mine(miner="E", spends=[(cb2, 0)], pays=[("B", 25 * COIN)])
        self.idx.sync()
        self.assertClean("after extending")
        self.assertGreater(self.idx.tip_height(), before_h)

        self.idx.unwind_to(before_h)
        after = snapshot(self.conn)
        self.assertEqual(before, after,
                         "unwind is not the exact inverse of apply:\n%s"
                         % diff_snapshots(before, after))
        self.assertClean("after unwind")

    def test_unwind_restores_spent_outputs(self):
        self.chain.mine_many(3, miner="A")
        self.idx.sync()
        cb1 = self.chain.coinbase_txid(1)
        self.assertEqual(self.balance("A"), 3 * SUBSIDY)

        self.chain.mine(miner="A", spends=[(cb1, 0)], pays=[("B", 50 * COIN)])
        self.idx.sync()
        self.assertEqual(self.balance("B"), 50 * COIN)
        spent = self.conn.execute("SELECT spent_height FROM outputs"
                                  " WHERE txid=? AND n=0", (cb1,)).fetchone()
        self.assertEqual(spent["spent_height"], 4)

        self.idx.unwind_to(3)
        spent = self.conn.execute("SELECT spent_height, spent_by_txid FROM outputs"
                                  " WHERE txid=? AND n=0", (cb1,)).fetchone()
        self.assertIsNone(spent["spent_height"])
        self.assertIsNone(spent["spent_by_txid"])
        self.assertEqual(self.balance("B"), 0)
        self.assertEqual(self.balance("A"), 3 * SUBSIDY)
        # B had no history left at all -> its rollup row is gone, not zeroed
        self.assertIsNone(self.conn.execute(
            "SELECT 1 FROM addresses WHERE address='B'").fetchone())
        self.assertClean()

    def test_same_block_spend_unwinds(self):
        """Tx 1 in a block spends an output created by... an earlier block, and
        a later block's tx spends that block's own coinbase. Unwind must walk
        transactions in reverse block order or it trips over itself."""
        self.chain.mine_many(2, miner="A")
        self.idx.sync()
        cb2 = self.chain.coinbase_txid(2)
        # block 3: coinbase to A, plus a payment spending block 2's coinbase
        self.chain.mine(miner="A", spends=[(cb2, 0)], pays=[("B", 49 * COIN)])
        cb3 = self.chain.coinbase_txid(3)
        # block 4 spends block 3's coinbase
        self.chain.mine(miner="A", spends=[(cb3, 0)], pays=[("C", 49 * COIN)])
        self.idx.sync()
        before = snapshot(self.conn)
        self.chain.mine_many(2, miner="A")
        self.idx.sync()
        self.idx.unwind_to(4)
        self.assertEqual(before, snapshot(self.conn),
                         diff_snapshots(before, snapshot(self.conn)))
        self.assertClean()

    # -- reorgs ---------------------------------------------------------
    def test_simple_reorg_replaces_branch(self):
        base = self.chain.mine_many(3, miner="A")
        self.chain.mine_many(2, on=base, miner="A")   # heights 4,5 on branch A
        self.idx.sync()
        self.assertEqual(self.idx.tip_height(), 5)
        self.assertEqual(self.balance("A"), 5 * SUBSIDY)

        # branch B forks at height 3 and is longer
        b = base
        for _ in range(4):
            b = self.chain.mine(on=b, miner="Z")
        self.chain.set_tip(b)

        self.idx.sync()
        self.assertMatchesNode()
        self.assertEqual(self.idx.tip_height(), 7)
        self.assertEqual(self.balance("A"), 3 * SUBSIDY)
        self.assertEqual(self.balance("Z"), 4 * SUBSIDY)
        self.assertClean()
        self.assertEqual(self.idx.reorgs, 1)
        n = self.conn.execute("SELECT COUNT(*) c FROM reorg_log").fetchone()["c"]
        self.assertEqual(n, 1)
        # the orphaned blocks are remembered, not lost
        orph = self.conn.execute("SELECT COUNT(*) c FROM orphaned_blocks").fetchone()["c"]
        self.assertEqual(orph, 2)

    def test_reorg_undoes_a_spend(self):
        """The dangerous case: a payment confirmed on the losing branch. After
        the reorg the coin must be unspent again and the recipient's balance
        must be zero -- an index that leaves it credited is worse than useless."""
        base = self.chain.mine_many(4, miner="A")
        cb2 = self.chain.coinbase_txid(2)
        # losing branch: block 5 pays B
        lose = self.chain.mine(on=base, miner="A", spends=[(cb2, 0)],
                               pays=[("B", 49 * COIN)])
        self.chain.set_tip(lose)
        self.idx.sync()
        self.assertEqual(self.balance("B"), 49 * COIN)

        # winning branch: two blocks from the same fork point, no payment
        w = base
        for _ in range(2):
            w = self.chain.mine(on=w, miner="A")
        self.chain.set_tip(w)
        self.idx.sync()

        self.assertMatchesNode()
        self.assertEqual(self.balance("B"), 0)
        self.assertEqual(self.balance("A"), 6 * SUBSIDY)
        out = self.conn.execute("SELECT spent_height FROM outputs WHERE txid=? AND n=0",
                                (cb2,)).fetchone()
        self.assertIsNone(out["spent_height"])
        self.assertClean()

    def test_reorg_same_tx_reconfirmed_at_a_different_height(self):
        """A transaction dropped from one branch and mined again on the other.
        txid is the primary key, so getting the ordering wrong here is a
        UNIQUE-constraint crash or, worse, a stale height."""
        base = self.chain.mine_many(4, miner="A")
        cb2 = self.chain.coinbase_txid(2)
        lose = self.chain.mine(on=base, miner="A", spends=[(cb2, 0)],
                               pays=[("B", 49 * COIN)])
        self.chain.set_tip(lose)
        self.idx.sync()
        moved_txid = self.conn.execute(
            "SELECT txid FROM txs WHERE height=5 AND block_index=1").fetchone()["txid"]

        # winning branch re-mines the very same payment, two blocks later
        w = self.chain.mine(on=base, miner="A")
        w = self.chain.mine(on=w, miner="A")
        # replay the identical tx body into the new branch, at height 7
        payment = dict(self.chain.txs[moved_txid]["tx"])
        cb = self.chain._coinbase(7, "A", SUBSIDY)
        w = self.chain._store(w, 7, self.chain.blocks[w]["time"] + 600, [cb, payment])
        self.chain.set_tip(w)

        self.idx.sync()
        self.assertMatchesNode()
        row = self.conn.execute("SELECT height FROM txs WHERE txid=?",
                                (moved_txid,)).fetchone()
        self.assertEqual(row["height"], 7)
        self.assertEqual(self.balance("B"), 49 * COIN)
        self.assertClean()

    def test_deep_reorg_to_genesis(self):
        for _ in range(12):
            self.chain.mine(miner="A")
        self.idx.sync()
        self.assertEqual(self.balance("A"), 12 * SUBSIDY)

        genesis = self.chain.active_chain()[0]
        b = genesis
        for _ in range(14):
            b = self.chain.mine(on=b, miner="Q")
        self.chain.set_tip(b)

        self.idx.sync()
        self.assertMatchesNode()
        self.assertEqual(self.balance("A"), 0)
        self.assertEqual(self.balance("Q"), 14 * SUBSIDY)
        # genesis itself was never unwound: it is common to both branches
        self.assertEqual(self.idx.blocks_unwound, 12)
        self.assertClean()

    def test_find_fork_at_every_depth(self):
        """find_fork uses an exponential probe plus a binary search. Check it
        lands on the exact fork height for every depth from 1 to 40, and that
        it costs O(log depth) calls rather than O(depth)."""
        for depth in range(1, 41):
            chain = FakeChain()
            rpc = FakeRpc(chain)
            conn, idx = make_indexer(rpc)
            try:
                base = chain.mine_many(20, miner="A")
                chain.mine_many(depth, miner="A")
                idx.sync()
                fork_height = 20
                b = base
                for _ in range(depth + 1):
                    b = chain.mine(on=b, miner="Z")
                chain.set_tip(b)
                calls_before = rpc.call_count
                found = idx.find_fork(chain.height())
                self.assertEqual(found, fork_height, "depth %d" % depth)
                probes = rpc.call_count - calls_before
                self.assertLessEqual(probes, 2 * (depth.bit_length() + 2),
                                     "depth %d took %d probes" % (depth, probes))
            finally:
                conn.close()

    def test_equal_length_competing_branch(self):
        """Same height, different hash -- the case a height-only comparison
        misses entirely."""
        base = self.chain.mine_many(5, miner="A")
        a = self.chain.mine(on=base, miner="A")
        self.chain.set_tip(a)
        self.idx.sync()
        self.assertEqual(self.idx.tip_height(), 6)

        b = self.chain.mine(on=base, miner="Z")
        self.chain.set_tip(b)
        self.idx.sync()
        self.assertMatchesNode()
        self.assertEqual(self.balance("Z"), SUBSIDY)
        self.assertEqual(self.balance("A"), 5 * SUBSIDY)
        self.assertClean()

    def test_reorg_to_a_shorter_chain(self):
        """A node can end up on a chain that is shorter in blocks but heavier in
        work. getblockhash then errors above the new tip; the indexer must cope."""
        base = self.chain.mine_many(4, miner="A")
        long_tip = self.chain.mine_many(6, on=base, miner="A")
        self.chain.set_tip(long_tip)
        self.idx.sync()
        self.assertEqual(self.idx.tip_height(), 10)

        short = self.chain.mine(on=base, miner="Z")
        self.chain.set_tip(short)
        self.idx.sync()
        self.assertMatchesNode()
        self.assertEqual(self.idx.tip_height(), 5)
        self.assertEqual(self.balance("A"), 4 * SUBSIDY)
        self.assertEqual(self.balance("Z"), SUBSIDY)
        self.assertClean()

    # -- crash safety ---------------------------------------------------
    def test_crash_mid_reorg_is_recoverable(self):
        """Kill the process after unwinding some but not all of a reorg. The
        index must still satisfy invariant I, and a fresh indexer over the same
        file must converge on exactly the state a from-scratch index produces."""
        import os
        import tempfile

        tmpdir = tempfile.mkdtemp()
        path = os.path.join(tmpdir, "idx.sqlite")
        conn = db.connect(path)
        db.init_schema(conn)
        idx = Indexer(conn, self.rpc)

        base = self.chain.mine_many(6, miner="A")
        cb3 = self.chain.coinbase_txid(3)
        losing = self.chain.mine(on=base, miner="A", spends=[(cb3, 0)],
                                 pays=[("B", 49 * COIN)])
        for _ in range(5):
            losing = self.chain.mine(on=losing, miner="A")
        self.chain.set_tip(losing)
        idx.sync()
        self.assertEqual(idx.tip_height(), 12)

        # Winning branch.
        w = base
        for _ in range(9):
            w = self.chain.mine(on=w, miner="Z")
        self.chain.set_tip(w)

        # Unwind only 3 of the 6 blocks that must go, then "crash".
        for h in (12, 11, 10):
            idx.unwind_block(h)
        self.assertEqual(idx.tip_height(), 9)
        problems = verify(conn, deep=True)
        self.assertEqual(problems, [], "half-unwound index is not self-consistent:\n"
                                       + "\n".join(problems))
        conn.close()

        # Restart against the same file.
        conn2 = db.connect(path)
        db.init_schema(conn2)
        idx2 = Indexer(conn2, self.rpc)
        idx2.sync()
        recovered = snapshot(conn2)
        self.assertEqual(idx2.tip_height(), 15)
        problems = verify(conn2, deep=True)
        self.assertEqual(problems, [], "\n".join(problems))
        conn2.close()

        # A fresh index of the same node must be identical.
        conn3, idx3 = make_indexer(self.rpc)
        idx3.sync()
        fresh = snapshot(conn3)
        self.assertEqual(recovered, fresh,
                         "recovery diverged from a from-scratch index:\n%s"
                         % diff_snapshots(recovered, fresh))
        conn3.close()

    def test_apply_refuses_a_block_that_does_not_link(self):
        self.chain.mine_many(3, miner="A")
        self.idx.sync()
        fork = self.chain.active_chain()[1]
        other = self.chain.mine(on=fork, miner="Z")
        from pcoin_indexer.indexer import normalize_block
        blk = normalize_block(self.chain.getblock(other, 3))
        with self.assertRaises(ChainLinkError):
            self.idx.apply_block(blk)
        # ... and the failed apply left nothing behind
        self.assertEqual(self.idx.tip_height(), 3)
        self.assertClean()

    def test_unwind_refuses_out_of_order(self):
        self.chain.mine_many(4, miner="A")
        self.idx.sync()
        with self.assertRaises(ChainLinkError):
            self.idx.unwind_block(2)
        self.assertEqual(self.idx.tip_height(), 4)
        self.assertClean()

    # -- the node moving underneath a fetch in progress -------------------
    def test_reorg_between_the_poll_and_the_fetch(self):
        """getblockchaininfo says height 12, and by the time the batch of
        getblockhash calls lands the node has switched to a 6-block branch.
        Half the heights we asked for no longer exist. The node *answered*
        (-8), so this is a fact and the right move is to re-observe -- not to
        raise, and above all not to read the missing height as a fork point."""
        base = self.chain.mine_many(5, miner="A")
        long_tip = self.chain.mine_many(7, on=base, miner="A")
        self.chain.set_tip(long_tip)
        short = self.chain.mine(on=base, miner="Z")

        chain = self.chain
        fired = []

        class MidFetchReorg(FakeRpc):
            def block_hashes(self, heights):
                if not fired:
                    fired.append(True)
                    chain.set_tip(short)      # the node reorgs, mid-call
                return FakeRpc.block_hashes(self, heights)

        conn, idx = make_indexer(MidFetchReorg(self.chain))
        self.addCleanup(conn.close)
        idx.sync()
        self.assertTrue(fired, "the mid-fetch reorg never triggered")
        self.assertEqual(idx.tip_height(), 6)
        self.assertEqual(idx.tip()[1], short)
        self.assertEqual(verify(conn, deep=True), [])

    def test_an_unexpected_rpc_error_is_never_read_as_a_fork(self):
        """CLAUDE.md 7.1/7.2. If getblockhash fails for a reason that is not
        "no block at that height", find_fork must propagate it. Swallowing it
        makes every height look like a mismatch and unwinds the whole index."""
        from pcoin_indexer.rpc import RpcError as RE

        self.chain.mine_many(8, miner="A")
        self.idx.sync()
        before = snapshot(self.conn)

        class Sulky(FakeRpc):
            def block_hash(self, height):
                raise RE(-28, "Loading block index...")

        idx = Indexer(self.conn, Sulky(self.chain))
        with self.assertRaises(RE):
            idx.find_fork(8)
        self.assertEqual(before, snapshot(self.conn))
        self.assertEqual(self.idx.tip_height(), 8)

    def test_out_of_range_height_is_still_read_as_no_block(self):
        """The other half of the previous test: -8 *is* an answer, and
        find_fork must keep using it to walk down past a shorter node chain."""
        base = self.chain.mine_many(4, miner="A")
        self.chain.mine_many(5, on=base, miner="A")
        self.idx.sync()
        self.assertEqual(self.idx.tip_height(), 9)
        short = self.chain.mine(on=base, miner="Z")
        self.chain.set_tip(short)
        # node_height is 5, index tip is 9: every probe above 5 is out of range
        self.assertEqual(self.idx.find_fork(self.chain.height()), 4)

    # -- randomised ------------------------------------------------------
    def test_randomised_branch_switching(self):
        """Drive the indexer through a long sequence of random branch switches
        and require, after each one, that the index equals a fresh index of the
        same node. This is the drift test for the incremental rollups."""
        rng = random.Random(20260804)
        chain = FakeChain()
        rpc = FakeRpc(chain)
        conn, idx = make_indexer(rpc)
        self.addCleanup(conn.close)

        tips = [chain.tip]
        for step in range(40):
            on = rng.choice(tips[-6:])
            miner = rng.choice(["A", "B", "C"])
            spends = pays = None
            if rng.random() < 0.35:
                # Spend something that actually exists on the branch being
                # extended -- an outpoint from another branch would make the
                # block invalid rather than interesting.
                avail = chain.utxos_on(on)
                if avail:
                    txid, n, value, _addr = rng.choice(avail)
                    spends = [(txid, n)]
                    pays = [(rng.choice(["X", "Y", "Z"]), value - 1000)]
            new = chain.mine(on=on, miner=miner, spends=spends, pays=pays)
            tips.append(new)
            if rng.random() < 0.4:
                chain.set_tip(rng.choice(tips))
            else:
                chain.set_tip(new)
            idx.sync()

            self.assertEqual(idx.tip_height(), chain.height(), "step %d" % step)
            self.assertEqual(idx.tip()[1], chain.tip, "step %d" % step)
            problems = verify(conn, deep=True)
            self.assertEqual(problems, [], "step %d:\n%s" % (step, "\n".join(problems)))

            fresh_conn, fresh_idx = make_indexer(rpc)
            fresh_idx.sync()
            got, want = snapshot(conn), snapshot(fresh_conn)
            fresh_conn.close()
            self.assertEqual(got, want, "step %d: incremental index diverged from a "
                                        "fresh one:\n%s" % (step, diff_snapshots(got, want)))
        self.assertGreater(idx.reorgs, 3, "the randomised run produced no reorgs")


if __name__ == "__main__":
    unittest.main()
