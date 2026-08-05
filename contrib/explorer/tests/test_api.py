"""The read side of the JSON API, exercised over a real HTTP socket.

The tests that matter most here are not "does /api/address return a number".
They are the ones that pin down what the API says when it does *not* know:

* `test_unconfirmed_is_null_not_zero_when_the_mempool_is_unknown`
* `test_spendable_is_null_when_the_mempool_is_unknown`
* `test_used_is_null_when_it_cannot_be_determined`
* `test_utxos_warn_when_the_mempool_could_not_be_observed`

Each of those is CLAUDE.md section 7.1/7.2 written as an assertion: an
unanswerable question must not come back as a definite answer, because in a send
path a definite wrong answer authorises spending the same coins twice.
"""

import socket
import sqlite3
import unittest

from . import helpers  # noqa: F401  (sets sys.path)
from .apiharness import Env
from .fakechain import COIN, FakeChain
from .fakenode import FakeNode

MINER = "ADDRMINER"
BOB = "ADDRBOB"
CAROL = "ADDRCAROL"
UNUSED = "ADDRNOBODYEVERUSEDTHIS"


def build_chain(blocks=120):
    """121 blocks of coinbase to MINER, then a real spend to BOB.

    With COINBASE_MATURITY = 100 and a tip at 121, the coinbases from height 1
    to 22 are mature and 23..121 are not -- so every test here has all three
    balance categories genuinely populated rather than zero.
    """
    chain = FakeChain(genesis_address=None)
    chain.mine_many(blocks, miner=MINER)
    cb = chain.coinbase_txid(1)
    chain.mine(spends=[(cb, 0)], pays=[(BOB, 30 * COIN), (MINER, 19 * COIN)],
               miner=MINER)
    return chain


def walk(obj, path=""):
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield from walk(v, "%s.%s" % (path, k))
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            yield from walk(v, "%s[%d]" % (path, i))
    else:
        yield path, obj


class ApiTestCase(unittest.TestCase):
    def setUp(self):
        self.env = Env(chain=build_chain())
        self.addCleanup(self.env.close)

    def get(self, path, expect=200):
        status, body, headers = self.env.get(path)
        self.assertEqual(status, expect, "%s -> %s %r" % (path, status, body))
        return body, headers


class StatusTests(ApiTestCase):
    def test_status_reports_index_and_node_heights(self):
        body, _ = self.get("/api/status")
        self.assertEqual(body["index"]["indexed_height"], 121)
        self.assertEqual(body["index"]["blocks_behind"], 0)
        self.assertEqual(body["index"]["blocks_behind_now"], 0)
        self.assertFalse(body["index"]["stale"])
        self.assertEqual(body["node"]["blocks"], 121)
        self.assertEqual(body["chain"]["height"], 121)
        self.assertEqual(body["chain"]["supply_pcn"], "6050.00000000")
        self.assertFalse(body["server"]["custodial"])

    def test_status_shows_how_far_behind_the_index_is(self):
        self.env.chain.mine_many(5, miner=MINER)     # node moves, index does not
        body, _ = self.get("/api/status")
        self.assertEqual(body["index"]["indexed_height"], 121)
        self.assertEqual(body["node"]["blocks"], 126)
        # The indexer has not polled since, so its own arithmetic still says 0;
        # the API's live measurement says 5. Both are reported, separately.
        self.assertEqual(body["index"]["blocks_behind"], 0)
        self.assertEqual(body["index"]["blocks_behind_now"], 5)
        self.env.resync()
        body, _ = self.get("/api/status")
        self.assertEqual(body["index"]["blocks_behind_now"], 0)
        self.assertEqual(body["index"]["indexed_height"], 126)

    def test_status_reports_an_unreachable_node_without_erasing_the_index(self):
        self.env.node.transport_down = True
        body, _ = self.get("/api/status")
        self.assertFalse(body["node"]["reachable"])
        self.assertIn("cannot reach", body["node"]["error"])
        # The index is a local file and still answers.
        self.assertEqual(body["index"]["indexed_height"], 121)
        self.assertEqual(body["chain"]["height"], 121)

    def test_tip(self):
        body, _ = self.get("/api/tip")
        self.assertEqual(body["tip"]["height"], 121)
        self.assertEqual(body["tip"]["hash"], self.env.chain.tip)
        self.assertTrue(body["tip"]["time_iso"].endswith("Z"))

    def test_discovery_root_lists_every_endpoint(self):
        body, _ = self.get("/")
        self.assertIn("POST /api/tx", body["endpoints"])
        self.assertIn("GET /api/fees", body["endpoints"])
        self.assertFalse(body["custodial"])


class AddressBalanceTests(ApiTestCase):
    def test_confirmed_immature_and_unconfirmed_are_separate(self):
        body, _ = self.get("/api/address/%s" % MINER)
        c = body["balance"]["confirmed"]
        self.assertGreater(c["mature_sat"], 0)
        self.assertGreater(c["immature_sat"], 0)
        # Never merged: the sum is offered under its own name, and it is not
        # what may be spent.
        self.assertEqual(c["onchain_unspent_sat"],
                         c["mature_sat"] + c["immature_sat"])
        self.assertEqual(c["spendable_sat"], c["mature_sat"] - c["pending_spend_sat"])
        self.assertEqual(c["maturity_blocks"], 100)
        self.assertEqual(c["as_of_height"], 121)
        self.assertTrue(body["balance"]["unconfirmed"]["known"])

    def test_every_balance_response_carries_the_index_height(self):
        for path in ("/api/address/%s" % MINER,
                     "/api/address/%s/utxos" % MINER,
                     "/api/address/%s/txs" % MINER,
                     "/api/addresses?list=%s,%s" % (MINER, BOB)):
            body, _ = self.get(path)
            self.assertEqual(body["index"]["indexed_height"], 121, path)
            self.assertIn("indexed_hash", body["index"])

    def test_maturity_is_reported_in_blocks_not_as_a_clock(self):
        body, _ = self.get("/api/address/%s" % MINER)
        c = body["balance"]["confirmed"]
        self.assertEqual(c["next_maturity_height"], 123)
        self.assertEqual(c["next_maturity_in_blocks"], 1)
        # Block spacing on this chain is neither the 600s target nor stable, so
        # an ETA would be a fabrication.
        self.assertNotIn("next_maturity_eta", c)
        self.assertNotIn("next_maturity_seconds", c)

    def test_unknown_address_answers_with_zeros_and_used_false(self):
        body, _ = self.get("/api/address/%s" % UNUSED)
        self.assertEqual(body["balance"]["confirmed"]["onchain_unspent_sat"], 0)
        self.assertEqual(body["balance"]["lifetime"]["tx_count"], 0)
        self.assertIs(body["used"], False)

    def test_unconfirmed_receipt_is_visible_and_kept_separate(self):
        utxos, _ = self.get("/api/address/%s/utxos" % BOB)
        u = utxos["utxos"][0]
        self.env.node.add_mempool_tx(spends=[(u["txid"], u["vout"])],
                                     pays=[(CAROL, 25 * COIN)])
        body, _ = self.get("/api/address/%s" % CAROL)
        self.assertEqual(body["balance"]["confirmed"]["onchain_unspent_sat"], 0)
        self.assertEqual(body["balance"]["unconfirmed"]["receiving_sat"],
                         25 * COIN)
        self.assertEqual(body["balance"]["unconfirmed"]["tx_count"], 1)
        self.assertIs(body["used"], True)

    def test_a_mempool_spend_moves_money_out_of_spendable(self):
        utxos, _ = self.get("/api/address/%s/utxos" % BOB)
        u = utxos["utxos"][0]
        self.env.node.add_mempool_tx(spends=[(u["txid"], u["vout"])],
                                     pays=[(CAROL, 25 * COIN)])
        body, _ = self.get("/api/address/%s" % BOB)
        c = body["balance"]["confirmed"]
        self.assertEqual(c["mature_sat"], 30 * COIN)
        self.assertEqual(c["pending_spend_sat"], 30 * COIN)
        self.assertEqual(c["spendable_sat"], 0)
        self.assertEqual(c["onchain_unspent_sat"], 30 * COIN)

    def test_unconfirmed_is_null_not_zero_when_the_mempool_is_unknown(self):
        self.env.blind_node()
        self.env.node.transport_down = True
        body, _ = self.get("/api/address/%s" % BOB)
        unconf = body["balance"]["unconfirmed"]
        self.assertIs(unconf["known"], False)
        self.assertTrue(unconf["reason"])
        self.assertNotIn("receiving_sat", unconf)   # not 0 -- absent

    def test_spendable_is_null_when_the_mempool_is_unknown(self):
        self.env.blind_node()
        self.env.node.transport_down = True
        body, _ = self.get("/api/address/%s" % BOB)
        c = body["balance"]["confirmed"]
        self.assertIsNone(c["spendable_sat"])
        self.assertIsNone(c["pending_spend_sat"])
        self.assertTrue(c["spendable_unknown_reason"])
        # What *is* known is still reported.
        self.assertEqual(c["mature_sat"], 30 * COIN)

    def test_used_is_null_when_it_cannot_be_determined(self):
        self.env.blind_node()
        self.env.node.transport_down = True
        body, _ = self.get("/api/address/%s" % UNUSED)
        # No confirmed history and no mempool knowledge: `false` here would
        # silently truncate a gap-limit scan.
        self.assertIsNone(body["used"])

    def test_a_node_that_goes_away_keeps_its_last_observation(self):
        self.get("/api/address/%s" % BOB)            # one good observation
        self.env.node.transport_down = True
        body, _ = self.get("/api/address/%s" % BOB)
        self.assertTrue(body["mempool"]["known"])
        self.assertFalse(body["mempool"]["node_reachable"])
        self.assertIsNotNone(body["mempool"]["observed_seconds_ago"])


class MultiAddressTests(ApiTestCase):
    def test_post_many_addresses_in_one_request(self):
        names = [MINER, BOB, CAROL, UNUSED]
        status, body, _ = self.env.post("/api/addresses", {"addresses": names})
        self.assertEqual(status, 200, body)
        self.assertEqual(body["count"], 4)
        got = {a["address"]: a for a in body["addresses"]}
        self.assertIs(got[MINER]["used"], True)
        self.assertIs(got[UNUSED]["used"], False)
        self.assertEqual(got[BOB]["balance"]["confirmed"]["mature_sat"], 30 * COIN)
        self.assertEqual(body["index"]["indexed_height"], 121)

    def test_gap_limit_scan_shape(self):
        """The whole point: 20 candidate addresses answered in one round trip."""
        names = ["GAPSCAN%03d" % i for i in range(20)]
        names[3] = BOB
        status, body, _ = self.env.post("/api/addresses", {"addresses": names})
        self.assertEqual(status, 200)
        used = [a["address"] for a in body["addresses"] if a["used"]]
        self.assertEqual(used, [BOB])

    def test_duplicates_are_collapsed(self):
        status, body, _ = self.env.post("/api/addresses",
                                        {"addresses": [BOB, BOB, MINER]})
        self.assertEqual(status, 200)
        self.assertEqual(body["count"], 2)

    def test_too_many_addresses_is_refused(self):
        env = Env(chain=build_chain(3), max_addresses=5)
        self.addCleanup(env.close)
        status, body, _ = env.post("/api/addresses",
                                   {"addresses": ["ADDR%04d" % i for i in range(6)]})
        self.assertEqual(status, 413)
        self.assertEqual(body["error"]["code"], "too_many_addresses")
        self.assertEqual(body["error"]["max_addresses"], 5)

    def test_get_variant_with_a_comma_list(self):
        body, _ = self.get("/api/addresses?list=%s,%s" % (BOB, UNUSED))
        self.assertEqual(body["count"], 2)

    def test_get_variant_without_a_list_explains_the_post_form(self):
        status, body, _ = self.env.get("/api/addresses")
        self.assertEqual(status, 400)
        self.assertIn("POST", body["error"]["message"])

    def test_bad_address_string_is_refused(self):
        status, body, _ = self.env.post("/api/addresses",
                                        {"addresses": ["../../etc/passwd"]})
        self.assertEqual(status, 400)
        self.assertEqual(body["error"]["code"], "bad_request")


class HistoryTests(ApiTestCase):
    def test_pagination_by_offset(self):
        first, _ = self.get("/api/address/%s/txs?limit=10" % MINER)
        self.assertEqual(len(first["confirmed"]["items"]), 10)
        self.assertEqual(first["confirmed"]["total"], 122)
        self.assertTrue(first["confirmed"]["has_more"])
        second, _ = self.get("/api/address/%s/txs?limit=10&offset=10" % MINER)
        ids_a = [i["txid"] for i in first["confirmed"]["items"]]
        ids_b = [i["txid"] for i in second["confirmed"]["items"]]
        self.assertEqual(len(set(ids_a) & set(ids_b)), 0)

    def test_cursor_pagination_matches_offset_pagination(self):
        first, _ = self.get("/api/address/%s/txs?limit=10" % MINER)
        cursor = first["confirmed"]["next_cursor"]
        by_cursor, _ = self.get("/api/address/%s/txs?limit=10&cursor=%s"
                                % (MINER, cursor))
        by_offset, _ = self.get("/api/address/%s/txs?limit=10&offset=10" % MINER)
        self.assertEqual([i["txid"] for i in by_cursor["confirmed"]["items"]],
                         [i["txid"] for i in by_offset["confirmed"]["items"]])

    def test_history_is_newest_first_and_carries_datetimes(self):
        body, _ = self.get("/api/address/%s/txs?limit=5" % MINER)
        heights = [i["height"] for i in body["confirmed"]["items"]]
        self.assertEqual(heights, sorted(heights, reverse=True))
        for item in body["confirmed"]["items"]:
            self.assertTrue(item["time_iso"].endswith("Z"))
            self.assertEqual(item["net_sat"],
                             item["received_sat"] - item["sent_sat"])
            self.assertGreaterEqual(item["confirmations"], 1)

    def test_unconfirmed_history_is_a_separate_array(self):
        utxos, _ = self.get("/api/address/%s/utxos" % BOB)
        u = utxos["utxos"][0]
        self.env.node.add_mempool_tx(spends=[(u["txid"], u["vout"])],
                                     pays=[(CAROL, 25 * COIN)])
        body, _ = self.get("/api/address/%s/txs" % BOB)
        # Merging these into the paged confirmed list would make page 2 shift
        # every time the mempool changed.
        self.assertEqual(len(body["unconfirmed"]["items"]), 1)
        self.assertEqual(body["unconfirmed"]["items"][0]["confirmations"], 0)
        self.assertTrue(all(i["confirmations"] >= 1
                            for i in body["confirmed"]["items"]))

    def test_bad_cursor_is_refused(self):
        status, body, _ = self.env.get("/api/address/%s/txs?cursor=nonsense" % MINER)
        self.assertEqual(status, 400)

    def test_limit_bounds_are_enforced(self):
        for bad in ("0", "9999", "abc"):
            status, _b, _h = self.env.get("/api/address/%s/txs?limit=%s"
                                          % (MINER, bad))
            self.assertEqual(status, 400, bad)


class UtxoTests(ApiTestCase):
    def test_default_list_is_spendable_only(self):
        body, _ = self.get("/api/address/%s/utxos" % MINER)
        self.assertTrue(body["utxos"])
        for u in body["utxos"]:
            self.assertTrue(u["mature"])
            self.assertIs(u["spendable"], True)
        self.assertGreater(body["summary"]["immature_count"], 0)
        self.assertEqual(len(body["utxos"]), body["summary"]["mature_count"])

    def test_immature_can_be_included_explicitly(self):
        body, _ = self.get("/api/address/%s/utxos?include_immature=1" % MINER)
        immature = [u for u in body["utxos"] if not u["mature"]]
        self.assertEqual(len(immature), body["summary"]["immature_count"])
        for u in immature:
            self.assertIs(u["spendable"], False)
            self.assertIsNotNone(u["maturity_height"])

    def test_outputs_being_spent_in_the_mempool_are_excluded(self):
        before, _ = self.get("/api/address/%s/utxos" % BOB)
        self.assertEqual(len(before["utxos"]), 1)
        u = before["utxos"][0]
        self.env.node.add_mempool_tx(spends=[(u["txid"], u["vout"])],
                                     pays=[(CAROL, 25 * COIN)])
        after, _ = self.get("/api/address/%s/utxos" % BOB)
        # Handing this outpoint back is how a wallet double-spends itself.
        self.assertEqual(after["utxos"], [])
        self.assertEqual(after["summary"]["pending_spend_count"], 1)
        with_them, _ = self.get(
            "/api/address/%s/utxos?include_pending_spend=1" % BOB)
        self.assertEqual(len(with_them["utxos"]), 1)
        self.assertIs(with_them["utxos"][0]["spent_in_mempool"], True)
        self.assertIs(with_them["utxos"][0]["spendable"], False)

    def test_unconfirmed_change_can_be_included(self):
        utxos, _ = self.get("/api/address/%s/utxos" % BOB)
        u = utxos["utxos"][0]
        self.env.node.add_mempool_tx(spends=[(u["txid"], u["vout"])],
                                     pays=[(CAROL, 25 * COIN)])
        body, _ = self.get("/api/address/%s/utxos?include_unconfirmed=1" % CAROL)
        self.assertEqual(len(body["utxos"]), 1)
        self.assertEqual(body["utxos"][0]["status"], "unconfirmed")
        self.assertEqual(body["utxos"][0]["confirmations"], 0)
        self.assertIsNone(body["utxos"][0]["height"])

    def test_utxos_warn_when_the_mempool_could_not_be_observed(self):
        self.env.blind_node()
        self.env.node.transport_down = True
        body, _ = self.get("/api/address/%s/utxos" % BOB)
        self.assertFalse(body["summary"]["mempool_filtered"])
        self.assertIsNone(body["summary"]["spendable_sat"])
        # Nothing landed in the pending bucket, but that is ignorance, not zero.
        self.assertIsNone(body["summary"]["pending_spend_sat"])
        self.assertIsNone(body["summary"]["pending_spend_count"])
        # What is genuinely known is still reported.
        self.assertEqual(body["summary"]["mature_sat"], 30 * COIN)
        self.assertTrue(any("double-spend" in w for w in body["warnings"]))
        for u in body["utxos"]:
            self.assertIsNone(u["spendable"])
            self.assertIsNone(u["spent_in_mempool"])

    def test_require_mempool_turns_the_warning_into_a_refusal(self):
        self.env.blind_node()
        self.env.node.transport_down = True
        status, body, _ = self.env.get(
            "/api/address/%s/utxos?require_mempool=1" % BOB)
        self.assertEqual(status, 503)
        self.assertEqual(body["error"]["code"], "mempool_unknown")

    def test_utxos_are_paginated(self):
        body, _ = self.get("/api/address/%s/utxos?limit=5&include_immature=1"
                           % MINER)
        self.assertEqual(len(body["utxos"]), 5)
        self.assertTrue(body["has_more"])
        self.assertEqual(body["total"], 121)


class TransactionTests(ApiTestCase):
    def _spend_txid(self):
        body, _ = self.get("/api/block/121")
        return body["block"]["txids"][1]

    def test_transaction_detail(self):
        txid = self._spend_txid()
        body, _ = self.get("/api/tx/%s" % txid)
        tx = body["tx"]
        self.assertEqual(tx["txid"], txid)
        self.assertEqual(tx["status"], "confirmed")
        self.assertEqual(tx["height"], 121)
        self.assertEqual(tx["confirmations"], 1)
        self.assertEqual(tx["fee_sat"], 1 * COIN)
        self.assertEqual(tx["fee_rate_sat_per_vb"].count("."), 1)
        # Every input carries the source address and amount, which is the thing
        # a node cannot tell you without undo data.
        self.assertEqual(len(tx["inputs"]), 1)
        self.assertEqual(tx["inputs"][0]["address"], MINER)
        self.assertEqual(tx["inputs"][0]["value_sat"], 50 * COIN)
        addresses = {o["address"] for o in tx["outputs"]}
        self.assertEqual(addresses, {BOB, MINER})
        self.assertTrue(tx["block_time_iso"].endswith("Z"))

    def test_coinbase_reports_maturity(self):
        body, _ = self.get("/api/block/121")
        cb = body["block"]["txids"][0]
        tx, _ = self.get("/api/tx/%s" % cb)
        self.assertTrue(tx["tx"]["is_coinbase"])
        self.assertEqual(tx["tx"]["matures_at_height"], 221)
        self.assertIs(tx["tx"]["mature"], False)
        self.assertEqual(tx["tx"]["maturity_in_blocks"], 99)

    def test_unknown_transaction_is_a_conclusive_404_when_the_index_is_current(self):
        status, body, _ = self.env.get("/api/tx/%s" % ("ab" * 32))
        self.assertEqual(status, 404)
        self.assertIs(body["error"]["conclusive"], True)
        self.assertEqual(body["error"]["index_height"], 121)

    def test_unknown_transaction_is_inconclusive_when_the_index_is_stale(self):
        self.env.writer.execute(
            "UPDATE sync_state SET last_poll_ts = ?, node_height = ? WHERE id=1",
            (1, 99999))
        status, body, _ = self.env.get("/api/tx/%s" % ("ab" * 32))
        self.assertEqual(status, 404)
        self.assertIs(body["error"]["conclusive"], False)

    def test_a_mempool_transaction_is_served_as_unconfirmed(self):
        utxos, _ = self.get("/api/address/%s/utxos" % BOB)
        u = utxos["utxos"][0]
        txid = self.env.node.add_mempool_tx(spends=[(u["txid"], u["vout"])],
                                            pays=[(CAROL, 25 * COIN)])
        body, _ = self.get("/api/tx/%s" % txid)
        self.assertEqual(body["tx"]["status"], "unconfirmed")
        self.assertEqual(body["tx"]["confirmations"], 0)
        self.assertIsNone(body["tx"]["height"])
        self.assertEqual(body["tx"]["outputs"][0]["address"], CAROL)
        self.assertEqual(body["tx"]["inputs"][0]["address"], BOB)

    def test_bad_txid_is_refused(self):
        for bad in ("nothex", "ab" * 31, "ab" * 33):
            status, _b, _h = self.env.get("/api/tx/%s" % bad)
            self.assertEqual(status, 400, bad)


class BlockTests(ApiTestCase):
    def test_block_by_height_and_by_hash_agree(self):
        by_height, _ = self.get("/api/block/121")
        by_hash, _ = self.get("/api/block/%s" % by_height["block"]["hash"])
        self.assertEqual(by_height["block"], by_hash["block"])
        self.assertEqual(by_height["block"]["tx_count"], 2)
        self.assertEqual(by_height["block"]["subsidy_pcn"], "50.00000000")
        self.assertEqual(by_height["block"]["total_fees_sat"], 1 * COIN)
        self.assertTrue(by_height["block"]["time_iso"].endswith("Z"))

    def test_block_txs_returns_full_transactions(self):
        body, _ = self.get("/api/block/121/txs")
        self.assertEqual(body["tx_count"], 2)
        self.assertEqual(len(body["txs"]), 2)
        self.assertTrue(body["txs"][0]["is_coinbase"])
        self.assertEqual(body["txs"][1]["inputs"][0]["address"], MINER)

    def test_genesis_has_an_addressless_output(self):
        body, _ = self.get("/api/block/0")
        tx, _ = self.get("/api/tx/%s" % body["block"]["txids"][0])
        self.assertIsNone(tx["tx"]["outputs"][0]["address"])

    def test_recent_blocks(self):
        body, _ = self.get("/api/blocks?limit=3")
        self.assertEqual([b["height"] for b in body["blocks"]], [121, 120, 119])
        body, _ = self.get("/api/blocks?limit=2&before_height=119")
        self.assertEqual([b["height"] for b in body["blocks"]], [118, 117])

    def test_missing_block_is_404(self):
        status, body, _ = self.env.get("/api/block/99999")
        self.assertEqual(status, 404)
        self.assertEqual(body["error"]["code"], "not_found")


class ReorgTests(ApiTestCase):
    def test_balances_follow_a_reorg_and_the_orphan_is_still_findable(self):
        """The index's reason for existing, seen from the API.

        A spend confirmed on the losing branch must stop counting, and the block
        that lost must come back as `orphaned: true` rather than as a 404 --
        "I saw that block and it lost a reorg" is a different fact from "I have
        never heard of it".
        """
        chain = self.env.chain
        before, _ = self.get("/api/address/%s" % BOB)
        self.assertEqual(before["balance"]["confirmed"]["mature_sat"], 30 * COIN)
        orphaned_hash = chain.tip

        # Build a competing branch from height 120 that does not contain the
        # spend, and make it longer.
        fork_parent = chain.ancestry(chain.tip)[120]
        branch = chain.mine_many(3, on=fork_parent, miner=CAROL)
        chain.set_tip(branch)
        stats = self.env.resync()
        self.assertGreaterEqual(stats["unwound"], 1)

        after, _ = self.get("/api/address/%s" % BOB)
        self.assertEqual(after["balance"]["confirmed"]["mature_sat"], 0)
        self.assertEqual(after["balance"]["lifetime"]["tx_count"], 0)
        self.assertEqual(after["index"]["indexed_height"], 123)

        body, _ = self.get("/api/block/%s" % orphaned_hash)
        self.assertIs(body["block"]["orphaned"], True)
        self.assertEqual(body["block"]["height"], 121)


class FeeTests(ApiTestCase):
    def test_fee_floor_comes_from_the_node(self):
        body, _ = self.get("/api/fees")
        self.assertEqual(body["relay_floor"]["sat_per_kvb"], 100)
        self.assertEqual(body["relay_floor"]["sat_per_vb"], "0.100")
        self.assertEqual(body["effective_floor"]["sat_per_kvb"], 100)
        # The relay floor and what a wallet should actually pay are different
        # numbers on PCoin and are reported separately.
        self.assertEqual(body["recommended"]["sat_per_kvb"], 1000)
        self.assertEqual(body["recommended"]["sat_per_vb"], "1.000")
        self.assertFalse(body["fee_estimation"]["usable"])
        self.assertTrue(body["no_fee_market"])
        self.assertEqual(body["dust_thresholds_sat"]["p2wpkh"], 294)

    def test_a_raised_mempool_minimum_raises_the_effective_floor(self):
        from decimal import Decimal
        self.env.node.mempool_min = Decimal("0.00005000")   # 5000 sat/kvB
        body, _ = self.get("/api/fees")
        self.assertEqual(body["effective_floor"]["sat_per_kvb"], 5000)
        self.assertEqual(body["recommended"]["sat_per_kvb"], 5000)

    def test_fees_refuse_to_invent_a_number(self):
        self.env.blind_node()
        self.env.node.transport_down = True
        status, body, _ = self.env.get("/api/fees")
        self.assertEqual(status, 503)
        self.assertEqual(body["error"]["code"], "node_unreachable")


class SearchTests(ApiTestCase):
    def test_search_by_height_txid_hash_and_address(self):
        block, _ = self.get("/api/search?q=121")
        self.assertEqual(block["kind"], "block")
        by_hash, _ = self.get("/api/search?q=%s" % block["block"]["hash"])
        self.assertEqual(by_hash["kind"], "block")
        txid = block["block"]["txids"][1]
        tx, _ = self.get("/api/search?q=%s" % txid)
        self.assertEqual(tx["kind"], "tx")
        addr, _ = self.get("/api/search?q=%s" % BOB)
        self.assertEqual(addr["kind"], "address")
        self.assertIs(addr["known"], True)

    def test_search_for_an_unseen_address_still_answers(self):
        body, _ = self.get("/api/search?q=%s" % UNUSED)
        self.assertEqual(body["kind"], "address")
        self.assertIs(body["known"], False)
        self.assertEqual(body["balance"]["confirmed"]["onchain_unspent_sat"], 0)

    def test_search_for_an_unknown_hash_is_404(self):
        status, _b, _h = self.env.get("/api/search?q=%s" % ("cd" * 32))
        self.assertEqual(status, 404)

    def test_search_needs_a_term(self):
        status, _b, _h = self.env.get("/api/search")
        self.assertEqual(status, 400)


class MoneyEncodingTests(ApiTestCase):
    PATHS = ("/api/status", "/api/tip", "/api/fees", "/api/blocks?limit=3",
             "/api/block/121", "/api/block/121/txs",
             "/api/address/" + MINER,
             "/api/address/%s/utxos?include_immature=1" % MINER,
             "/api/address/%s/txs" % MINER,
             "/api/addresses?list=%s,%s" % (MINER, BOB),
             "/api/addresses/top")

    def test_no_amount_is_ever_a_json_float(self):
        """An amount that cannot round-trip through an IEEE double must never be
        handed to a wallet as one."""
        for path in self.PATHS:
            body, _ = self.get(path)
            for key, value in walk(body):
                if key.endswith("_sat"):
                    self.assertTrue(value is None or isinstance(value, int),
                                    "%s%s = %r" % (path, key, value))
                    self.assertNotIsInstance(value, float, "%s%s" % (path, key))
                if key.endswith("_pcn"):
                    self.assertTrue(value is None or isinstance(value, str),
                                    "%s%s = %r" % (path, key, value))

    def test_pcn_strings_are_fixed_point(self):
        body, _ = self.get("/api/address/%s" % MINER)
        self.assertRegex(
            body["balance"]["confirmed"]["mature_pcn"], r"\A-?\d+\.\d{8}\Z")


class HttpBehaviourTests(ApiTestCase):
    def test_unknown_route_is_404(self):
        status, body, _ = self.env.get("/api/nope")
        self.assertEqual(status, 404)
        self.assertEqual(body["error"]["code"], "not_found")

    def test_wrong_method_is_405(self):
        status, body, _ = self.env.post("/api/status", {})
        self.assertEqual(status, 405)
        self.assertEqual(body["error"]["code"], "method_not_allowed")

    def test_options_preflight(self):
        status, headers, _data = self.env.request("OPTIONS", "/api/status")
        self.assertEqual(status, 204)
        self.assertEqual(headers["Access-Control-Allow-Origin"], "*")
        self.assertIn("POST", headers["Access-Control-Allow-Methods"])

    def test_security_headers_and_no_python_version_leak(self):
        _body, headers = self.get("/api/status")
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertIn("pcoin-explorer-api", headers["Server"])
        self.assertNotIn("Python", headers["Server"])

    def test_head_returns_headers_without_a_body(self):
        status, headers, data = self.env.request("HEAD", "/api/status")
        self.assertEqual(status, 200)
        self.assertEqual(data, b"")
        self.assertGreater(int(headers["Content-Length"]), 0)

    def test_oversized_body_is_refused(self):
        status, _headers, data = self.env.request(
            "POST", "/api/tx", raw_body=b"0" * 1_100_000,
            headers={"Content-Type": "application/json"})
        self.assertEqual(status, 413)
        self.assertIn(b"payload_too_large", data)

    def test_chunked_bodies_are_refused(self):
        raw = ("POST /api/tx HTTP/1.1\r\nHost: x\r\n"
               "Transfer-Encoding: chunked\r\n\r\n0\r\n\r\n").encode()
        sock = socket.create_connection(("127.0.0.1", self.env.port), timeout=10)
        try:
            sock.sendall(raw)
            reply = b""
            while True:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                reply += chunk
        finally:
            sock.close()
        self.assertIn(b"411", reply.split(b"\r\n")[0])
        self.assertIn(b"length_required", reply)

    def test_read_rate_limit(self):
        env = Env(chain=build_chain(2), read_rate=0.0, read_burst=3)
        self.addCleanup(env.close)
        codes = [env.get("/api/status")[0] for _ in range(5)]
        self.assertEqual(codes[:3], [200, 200, 200])
        self.assertEqual(codes[3:], [429, 429])
        status, body, headers = env.get("/api/status")
        self.assertEqual(status, 429)
        self.assertEqual(body["error"]["code"], "rate_limited")
        self.assertIn("Retry-After", headers)


class ReadOnlyTests(ApiTestCase):
    def test_the_api_connection_cannot_write(self):
        conn = self.env.store._conn()
        with self.assertRaises(sqlite3.OperationalError) as cm:
            conn.execute("INSERT INTO addresses (address, balance) VALUES ('x', 1)")
        self.assertIn("readonly", str(cm.exception))

    def test_a_request_sees_one_consistent_snapshot(self):
        """A response must not mix a balance read at tip T with a maturity
        cut-off read at tip T+1."""
        with self.env.store.snapshot() as conn:
            first = conn.execute("SELECT MAX(height) h FROM blocks").fetchone()["h"]
            self.env.chain.mine_many(2, miner=MINER)
            self.env.resync()
            second = conn.execute("SELECT MAX(height) h FROM blocks").fetchone()["h"]
        self.assertEqual(first, second)
        with self.env.store.snapshot() as conn:
            after = conn.execute("SELECT MAX(height) h FROM blocks").fetchone()["h"]
        self.assertEqual(after, first + 2)


class MempoolEndpointTests(ApiTestCase):
    def test_mempool_endpoint_lists_unconfirmed_transactions(self):
        utxos, _ = self.get("/api/address/%s/utxos" % BOB)
        u = utxos["utxos"][0]
        txid = self.env.node.add_mempool_tx(spends=[(u["txid"], u["vout"])],
                                            pays=[(CAROL, 25 * COIN)])
        body, _ = self.get("/api/mempool")
        self.assertEqual(body["mempool"]["tx_count"], 1)
        self.assertIn(txid, body["mempool"]["txids"])
        self.assertIs(body["mempool"]["entries"][txid]["unbroadcast"], True)

    def test_an_unresolvable_input_marks_the_view_partial(self):
        """A mempool transaction spending an outpoint the index has never seen
        must make the view visibly partial, not silently wrong."""
        self.env.node.add_mempool_tx(spends=[("ff" * 32, 0)],
                                     pays=[(CAROL, 1 * COIN)])
        body, _ = self.get("/api/mempool")
        self.assertIs(body["mempool"]["partial"], True)
        self.assertEqual(body["mempool"]["incomplete_tx_count"], 1)
        addr, _ = self.get("/api/address/%s" % CAROL)
        self.assertIs(addr["balance"]["unconfirmed"]["partial"], True)


class NodeViewTests(ApiTestCase):
    def test_a_refresh_in_flight_never_blocks_another_request(self):
        """One slow node must not consume every request thread.

        With a refresh already running, a second caller gets the previous
        observation and its true age instead of queueing behind an RPC that may
        be hung.
        """
        view = self.env.view
        view.snapshot()                                   # one good observation
        acquired = view._refresh_lock.acquire(blocking=False)
        self.assertTrue(acquired)
        try:
            snap = view.snapshot()                        # must not block
        finally:
            view._refresh_lock.release()
        self.assertTrue(snap["known"])
        self.assertIsNotNone(snap["age_seconds"])

    def test_the_node_observation_is_cached_between_requests(self):
        env = Env(chain=build_chain(3), cache_seconds=3600)
        self.addCleanup(env.close)
        env.get("/api/status")
        before = env.node.call_count
        for _ in range(3):
            env.get("/api/status")
        # getblockchaininfo/getnetworkinfo/getmempoolinfo/getrawmempool are not
        # re-issued per HTTP request.
        self.assertEqual(env.node.call_count, before)

    def test_a_failed_poll_never_advances_or_clears_an_observation(self):
        view = self.env.view
        good = view.snapshot()
        self.assertTrue(good["fresh"])
        self.env.node.transport_down = True
        bad = view.snapshot()
        self.assertFalse(bad["fresh"])
        self.assertTrue(bad["known"])
        self.assertEqual(bad["blocks"], good["blocks"])     # not reset, not None
        self.assertEqual(bad["observed_at"], good["observed_at"])
        self.assertIn("cannot reach", bad["error"])


class WithoutANodeTests(unittest.TestCase):
    def test_index_only_endpoints_still_work_with_no_node_at_all(self):
        """Blocks and transactions come from a local file. A node outage must not
        take the explorer down with it."""
        chain = build_chain(5)
        node = FakeNode(chain)
        env = Env(chain=chain, node=node)
        self.addCleanup(env.close)
        env.blind_node()
        node.transport_down = True
        for path in ("/api/block/1", "/api/blocks?limit=2", "/api/addresses/top"):
            status, body, _ = env.get(path)
            self.assertEqual(status, 200, "%s -> %r" % (path, body))
            self.assertEqual(body["index"]["indexed_height"], 6)


if __name__ == "__main__":                                   # pragma: no cover
    unittest.main()
