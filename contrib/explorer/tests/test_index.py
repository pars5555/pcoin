"""Non-reorg indexer tests: amounts, coinbase maturity, the consistency marker,
and the read-side queries the API will use."""

import time
import unittest
from decimal import Decimal

from . import helpers  # noqa: F401  (sets sys.path)
from .fakechain import COIN, SUBSIDY, FakeChain, FakeRpc
from .helpers import make_indexer
from pcoin_indexer import db, queries
from pcoin_indexer.amounts import from_sat, subsidy_sat, to_sat
from pcoin_indexer.indexer import COINBASE_MATURITY, normalize_block, verify


class AmountTests(unittest.TestCase):
    def test_decimal_round_trip(self):
        self.assertEqual(to_sat(Decimal("50.00000000")), 5_000_000_000)
        self.assertEqual(to_sat(Decimal("0.00000001")), 1)
        self.assertEqual(to_sat(Decimal("1324.99997988")), 132_499_997_988)
        self.assertEqual(to_sat(0), 0)

    def test_scientific_notation(self):
        """The node really does emit `1.871e-05` for a small fee."""
        self.assertEqual(to_sat(Decimal("1.871e-05")), 1871)
        self.assertEqual(to_sat(Decimal("1.77e-06")), 177)

    def test_float_is_refused(self):
        with self.assertRaises(TypeError):
            to_sat(0.1)
        with self.assertRaises(TypeError):
            to_sat(50.0)

    def test_sub_satoshi_is_refused(self):
        with self.assertRaises(ValueError):
            to_sat(Decimal("0.000000005"))

    def test_from_sat(self):
        self.assertEqual(from_sat(5_000_000_000), "50.00000000")
        self.assertEqual(from_sat(1), "0.00000001")
        self.assertEqual(from_sat(-1), "-0.00000001")

    def test_subsidy(self):
        self.assertEqual(subsidy_sat(0), 50 * COIN)
        self.assertEqual(subsidy_sat(209_999), 50 * COIN)
        self.assertEqual(subsidy_sat(210_000), 25 * COIN)
        self.assertEqual(subsidy_sat(420_000), 1_250_000_000)
        self.assertEqual(subsidy_sat(210_000 * 64), 0)


class NormaliseTests(unittest.TestCase):
    def test_rejects_a_missing_prevout(self):
        """A pruned node answers verbosity 3 without prevouts. Fail loudly."""
        chain = FakeChain()
        chain.mine_many(2, miner="A")
        cb1 = chain.coinbase_txid(1)
        h = chain.mine(miner="A", spends=[(cb1, 0)], pays=[("B", 49 * COIN)])
        raw = chain.getblock(h, 3)
        del raw["tx"][1]["vin"][0]["prevout"]
        with self.assertRaises(ValueError) as ctx:
            normalize_block(raw)
        self.assertIn("prevout", str(ctx.exception))

    def test_block_economics(self):
        chain = FakeChain()
        chain.mine_many(2, miner="A")
        cb1 = chain.coinbase_txid(1)
        h = chain.mine(miner="A", spends=[(cb1, 0)], pays=[("B", 49 * COIN)])
        blk = normalize_block(chain.getblock(h, 3))
        self.assertEqual(blk["subsidy"], SUBSIDY)
        self.assertEqual(blk["total_fees"], SUBSIDY - 49 * COIN)
        self.assertEqual(blk["coinbase_out"], blk["subsidy"] + blk["total_fees"])


class MaturityTests(unittest.TestCase):
    def setUp(self):
        self.chain = FakeChain()
        self.rpc = FakeRpc(self.chain)
        self.conn, self.idx = make_indexer(self.rpc)
        self.addCleanup(self.conn.close)

    def test_immature_coinbase_is_not_spendable(self):
        self.chain.mine_many(5, miner="A")
        self.idx.sync()
        s = queries.address_summary(self.conn, "A")
        self.assertEqual(s["balance"], 5 * SUBSIDY)
        self.assertEqual(s["immature"], 5 * SUBSIDY)
        self.assertEqual(s["spendable"], 0)

    def test_maturity_boundary(self):
        """A coinbase at height h is spendable in the block at h+100, i.e. once
        it has 100 confirmations. Off by one here is a wallet that builds an
        unspendable transaction."""
        n = COINBASE_MATURITY + 3
        self.chain.mine_many(n, miner="A")
        self.idx.sync()
        tip = self.idx.tip_height()
        self.assertEqual(tip, n)
        # coinbases at heights 1..(tip - 99) are mature
        mature_upto = tip + 1 - COINBASE_MATURITY
        s = queries.address_summary(self.conn, "A")
        self.assertEqual(s["spendable"], mature_upto * SUBSIDY)
        self.assertEqual(s["immature"], (n - mature_upto) * SUBSIDY)

        row = self.conn.execute(
            "SELECT maturity_height FROM outputs WHERE height=1 AND n=0").fetchone()
        self.assertEqual(row["maturity_height"], 1 + COINBASE_MATURITY)
        utxos = queries.address_utxos(self.conn, "A", mature_only=True)
        self.assertEqual(len(utxos), mature_upto)
        self.assertTrue(all(u["mature"] for u in utxos))

    def test_maturity_moves_back_after_a_reorg(self):
        base = self.chain.mine_many(COINBASE_MATURITY + 2, miner="A")
        self.idx.sync()
        before = queries.address_summary(self.conn, "A")["spendable"]
        self.assertGreater(before, 0)
        # reorg away the last few blocks; some coins become immature again
        fork = self.chain.active_chain()[COINBASE_MATURITY - 2]
        b = fork
        for _ in range(3):
            b = self.chain.mine(on=b, miner="Z")
        self.chain.set_tip(b)
        self.idx.sync()
        after = queries.address_summary(self.conn, "A")["spendable"]
        self.assertLess(after, before)
        self.assertEqual(verify(self.conn), [])
        del base


class MarkerTests(unittest.TestCase):
    def setUp(self):
        self.chain = FakeChain()
        self.rpc = FakeRpc(self.chain)
        self.conn, self.idx = make_indexer(self.rpc)
        self.addCleanup(self.conn.close)

    def test_health_reports_being_behind(self):
        self.chain.mine_many(10, miner="A")
        # 4 blocks applied == heights 0..3, so the tip is 3
        self.idx.sync_once(max_blocks=4)
        h = queries.health(self.conn)
        self.assertEqual(h["node_height"], 10)
        self.assertEqual(h["indexed_height"], 3)
        self.assertEqual(h["blocks_behind"], 7)
        self.assertTrue(h["stale"])
        self.idx.sync()
        h = queries.health(self.conn)
        self.assertEqual(h["blocks_behind"], 0)
        self.assertEqual(h["status"], "ok")
        self.assertFalse(h["stale"], h["stale_reasons"])

    def test_health_goes_stale_without_a_poll(self):
        self.chain.mine_many(3, miner="A")
        self.idx.sync()
        h = queries.health(self.conn, now=int(time.time()) + 3600)
        self.assertTrue(h["stale"])
        self.assertTrue(any("poll" in r for r in h["stale_reasons"]))

    def test_a_failed_poll_never_advances_the_marker(self):
        """CLAUDE.md 7.1: an RPC that failed resolves nothing. A node we cannot
        reach must not silently reset `blocks_behind` to 0."""
        self.chain.mine_many(5, miner="A")
        self.idx.sync()
        self.chain.mine_many(4, miner="A")

        class Dead:
            def __getattr__(self, _name):
                def boom(*_a, **_kw):
                    from pcoin_indexer.rpc import RpcTransportError
                    raise RpcTransportError("connection refused")
                return boom

        from pcoin_indexer.indexer import Indexer
        from pcoin_indexer.rpc import RpcTransportError
        broken = Indexer(self.conn, Dead(), genesis_hash="x")
        with self.assertRaises(RpcTransportError):
            broken.poll_node()
        h = queries.health(self.conn)
        self.assertEqual(h["node_height"], 5)      # the last thing we actually saw
        self.assertEqual(h["status"], "error")
        self.assertTrue(h["stale"])

    def test_refuses_a_different_genesis(self):
        from pcoin_indexer.indexer import WrongChain
        self.chain.mine_many(2, miner="A")
        self.idx.sync()
        other = FakeChain(genesis_address="SOMEONE")
        other.mine_many(2, miner="A")
        from pcoin_indexer.indexer import Indexer
        idx2 = Indexer(self.conn, FakeRpc(other))
        with self.assertRaises(WrongChain):
            idx2.poll_node()


class QueryTests(unittest.TestCase):
    def setUp(self):
        self.chain = FakeChain()
        self.rpc = FakeRpc(self.chain)
        self.conn, self.idx = make_indexer(self.rpc)
        self.addCleanup(self.conn.close)
        self.chain.mine_many(3, miner="A")
        cb1 = self.chain.coinbase_txid(1)
        self.payblock = self.chain.mine(miner="M", spends=[(cb1, 0)],
                                        pays=[("B", 30 * COIN), ("A", 19 * COIN)])
        self.idx.sync()
        self.payment = self.conn.execute(
            "SELECT txid FROM txs WHERE height=4 AND block_index=1").fetchone()["txid"]

    def test_transaction_detail(self):
        t = queries.transaction(self.conn, self.payment)
        self.assertEqual(t["height"], 4)
        self.assertEqual(t["confirmations"], 1)
        self.assertEqual(t["fee"], SUBSIDY - 49 * COIN)
        self.assertEqual(t["value_in"], SUBSIDY)
        self.assertEqual(len(t["inputs"]), 1)
        self.assertEqual(t["inputs"][0]["address"], "A")
        self.assertEqual(t["inputs"][0]["value"], SUBSIDY)
        self.assertEqual({o["address"] for o in t["outputs"]}, {"A", "B"})
        self.assertIsNotNone(t["block_time"])
        self.assertIn("health", t)

    def test_coinbase_detail_reports_when_it_matures(self):
        cb = self.conn.execute("SELECT txid FROM txs WHERE height=2"
                               " AND block_index=0").fetchone()["txid"]
        t = queries.transaction(self.conn, cb)
        self.assertTrue(t["is_coinbase"])
        self.assertEqual(t["spendable_from_height"], 2 + COINBASE_MATURITY)
        self.assertFalse(t["outputs"][0]["mature"])

    def test_address_history_and_utxos(self):
        s = queries.address_summary(self.conn, "A")
        self.assertEqual(s["tx_count"], 4)      # 3 coinbases + the payment
        self.assertEqual(s["received"], 3 * SUBSIDY + 19 * COIN)
        self.assertEqual(s["sent"], SUBSIDY)
        self.assertEqual(s["balance"], 2 * SUBSIDY + 19 * COIN)
        hist = queries.address_history(self.conn, "A")
        self.assertEqual(hist[0]["height"], 4)
        self.assertEqual(hist[0]["net"], 19 * COIN - SUBSIDY)
        utxos = queries.address_utxos(self.conn, "A")
        self.assertEqual(len(utxos), 3)
        self.assertEqual(sum(u["value"] for u in utxos), 2 * SUBSIDY + 19 * COIN)

    def test_search(self):
        self.assertEqual(queries.search(self.conn, "B")["kind"], "address")
        self.assertEqual(queries.search(self.conn, self.payment)["kind"], "tx")
        self.assertEqual(queries.search(self.conn, self.payblock)["kind"], "block")
        self.assertEqual(queries.search(self.conn, "2")["kind"], "block")
        self.assertIsNone(queries.search(self.conn, "no-such-thing"))

    def test_block_view_and_orphans(self):
        b = queries.block(self.conn, 4)
        self.assertEqual(b["n_tx"], 2)
        self.assertFalse(b["orphaned"])
        self.assertEqual(len(b["txids"]), 2)
        # orphan block 4 and check it is still findable
        self.chain.set_tip(self.chain.active_chain()[3])
        self.chain.mine(miner="Z")
        self.chain.mine(miner="Z")
        self.idx.sync()
        o = queries.block(self.conn, self.payblock)
        self.assertTrue(o["orphaned"])

    def test_chain_stats(self):
        st = queries.chain_stats(self.conn)
        self.assertEqual(st["height"], 4)
        self.assertEqual(st["tx_count"], 6)         # 5 coinbases + 1 payment
        self.assertEqual(st["non_coinbase_count"], 1)
        # genesis is unspendable, so supply is 4 * 50 PCN
        self.assertEqual(st["supply_sat"], 4 * SUBSIDY)


class ResumeTests(unittest.TestCase):
    def test_sync_is_resumable(self):
        chain = FakeChain()
        rpc = FakeRpc(chain)
        conn, idx = make_indexer(rpc)
        self.addCleanup(conn.close)
        chain.mine_many(25, miner="A")
        idx.sync_once(max_blocks=7)
        self.assertEqual(idx.tip_height(), 6)     # 7 blocks == heights 0..6
        idx.sync_once(max_blocks=7)
        self.assertEqual(idx.tip_height(), 13)
        idx.sync()
        self.assertEqual(idx.tip_height(), 25)
        self.assertEqual(verify(conn), [])
        st = db.get_state(conn)
        self.assertEqual(st["indexed_height"], 25)
        self.assertEqual(st["status"], "ok")


if __name__ == "__main__":
    unittest.main()
