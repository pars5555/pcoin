"""POST /api/tx -- the only state-changing endpoint.

The tests here are almost entirely about *what the API claims* rather than about
whether a transaction moved. "The node accepted it" and "the network has it" are
different statements, and this file pins down which one comes back in each case:

  peers == 0                       -> network.has_it = false   (a fact)
  a peer requested it              -> network.has_it = true     (a fact)
  no peer requested it yet         -> network.has_it = null     (unknown)
  the node rejected it             -> network.has_it = false, 400
  the response was lost            -> 502, accepted = null, retry is safe

The one that would be easiest to get wrong, and that costs a user real money, is
the third: an API that reports "sent" there is lying, and a wallet that believes
it stops watching.
"""

import hashlib
import os
import unittest

from . import helpers  # noqa: F401  (sets sys.path)
from .apiharness import Env
from .fakechain import COIN, FakeChain
from .fakenode import FakeNode
from .test_txid import LEGACY_HEX, LEGACY_TXID, SEGWIT_HEX, SEGWIT_TXID
from pcoin_indexer.rpc import RpcError, RpcTransportError

MINER = "ADDRMINER"


def build_chain(blocks=5):
    chain = FakeChain(genesis_address=None)
    chain.mine_many(blocks, miner=MINER)
    return chain


class BroadcastTestCase(unittest.TestCase):
    def make_env(self, **kw):
        env = Env(chain=build_chain(), **kw)
        self.addCleanup(env.close)
        return env

    def send(self, env, hexstr=SEGWIT_HEX, path="/api/tx"):
        return env.post(path, {"hex": hexstr})


class SuccessTests(BroadcastTestCase):
    def test_a_peer_asking_for_it_is_reported_as_the_network_having_it(self):
        env = self.make_env()
        env.node.auto_acknowledge = True
        status, body, _ = self.send(env)
        self.assertEqual(status, 200, body)
        self.assertEqual(body["txid"], SEGWIT_TXID)
        self.assertIs(body["accepted_by_node"], True)
        self.assertIs(body["network"]["has_it"], True)
        self.assertEqual(body["network"]["state"], "acknowledged_by_peer")
        self.assertIs(body["network"]["checks"]["unbroadcast"], False)
        self.assertEqual(body["next"], "/api/tx/" + SEGWIT_TXID)

    def test_no_peer_acknowledgement_yet_is_unknown_and_202(self):
        env = self.make_env()
        env.node.auto_acknowledge = False
        status, body, _ = self.send(env)
        # Accepted locally. That is NOT "the network has it", and the status code
        # says so on its own.
        self.assertEqual(status, 202, body)
        self.assertIs(body["accepted_by_node"], True)
        self.assertIsNone(body["network"]["has_it"])
        self.assertEqual(body["network"]["state"], "awaiting_peer_acknowledgement")
        self.assertIn("not yet established", body["network"]["detail"])

    def test_zero_peers_is_a_definite_no(self):
        env = self.make_env()
        env.node.connections_in = 0
        env.node.connections_out = 0
        status, body, _ = self.send(env)
        self.assertEqual(status, 202, body)
        self.assertIs(body["accepted_by_node"], True)
        # Not unknown: with no peers nobody can have received it.
        self.assertIs(body["network"]["has_it"], False)
        self.assertEqual(body["network"]["state"], "no_peers")
        self.assertEqual(body["network"]["peers"], 0)

    def test_a_witness_node_is_the_strongest_signal(self):
        chain = build_chain()
        node = FakeNode(chain)
        witness = FakeNode(chain)
        witness.add_mempool_tx(txid=SEGWIT_TXID, pays=[("ADDRX", COIN)])
        env = Env(chain=chain, node=node, witness_rpc=witness)
        self.addCleanup(env.close)
        status, body, _ = self.send(env)
        self.assertEqual(status, 200, body)
        self.assertIs(body["network"]["has_it"], True)
        self.assertEqual(body["network"]["state"], "observed_by_witness_node")
        self.assertIs(body["network"]["checks"]["witness_node"], True)

    def test_the_broadcast_transaction_becomes_visible_as_unconfirmed(self):
        env = self.make_env()
        status, body, _ = self.send(env)
        self.assertIn(status, (200, 202))
        got, _b, _h = env.get("/api/tx/%s" % SEGWIT_TXID)
        self.assertEqual(got, 200)

    def test_a_plain_text_hex_body_is_accepted(self):
        env = self.make_env()
        status, _headers, data = env.request(
            "POST", "/api/tx", raw_body=SEGWIT_HEX.encode(),
            headers={"Content-Type": "text/plain"})
        self.assertIn(status, (200, 202), data)
        self.assertIn(SEGWIT_TXID.encode(), data)

    def test_a_legacy_transaction_is_relayed_too(self):
        env = self.make_env()
        status, body, _ = self.send(env, LEGACY_HEX)
        self.assertIn(status, (200, 202))
        self.assertEqual(body["txid"], LEGACY_TXID)
        self.assertIs(body["tx"]["has_witness"], False)


class RejectionTests(BroadcastTestCase):
    def test_a_node_rejection_is_a_400_and_a_definite_no(self):
        env = self.make_env()
        env.node.send_hook = lambda _h: (_ for _ in ()).throw(
            RpcError(-26, "min relay fee not met, 100 < 141"))
        status, body, _ = self.send(env)
        self.assertEqual(status, 400)
        self.assertIs(body["accepted_by_node"], False)
        self.assertEqual(body["error"]["code"], "rejected")
        self.assertEqual(body["error"]["rpc_code"], -26)
        self.assertIn("min relay fee", body["error"]["message"])
        self.assertIs(body["network"]["has_it"], False)

    def test_already_in_the_chain_means_the_network_definitely_has_it(self):
        env = self.make_env()
        env.node.send_hook = lambda _h: (_ for _ in ()).throw(
            RpcError(-27, "Transaction outputs already in utxo set"))
        status, body, _ = self.send(env)
        self.assertEqual(status, 200, body)
        self.assertIs(body["already_in_chain"], True)
        self.assertIs(body["network"]["has_it"], True)
        self.assertEqual(body["network"]["state"], "already_in_a_block")

    def test_a_warming_up_node_is_503_not_a_rejection(self):
        env = self.make_env()
        env.node.send_hook = lambda _h: (_ for _ in ()).throw(
            RpcError(-28, "Loading block index..."))
        status, body, _ = self.send(env)
        self.assertEqual(status, 503)
        self.assertEqual(body["error"]["code"], "node_warming_up")

    def test_invalid_hex_never_reaches_the_node(self):
        env = self.make_env()
        for bad in ("not hex at all", SEGWIT_HEX + "00", SEGWIT_HEX[:-1], ""):
            status, body, _ = self.send(env, bad)
            self.assertEqual(status, 400, bad)
            self.assertIn(body["error"]["code"],
                          ("invalid_transaction", "bad_request"))
        self.assertEqual(env.node.sent, [])

    def test_key_material_in_the_body_is_refused_outright(self):
        env = self.make_env()
        status, body, _ = env.post("/api/tx", {"hex": SEGWIT_HEX,
                                               "mnemonic": "abandon abandon"})
        self.assertEqual(status, 400)
        self.assertEqual(body["error"]["code"], "refused")
        self.assertIn("non-custodial", body["error"]["message"])
        self.assertEqual(env.node.sent, [])

    def test_a_missing_hex_field_is_explained(self):
        env = self.make_env()
        status, body, _ = env.post("/api/tx", {"nope": 1})
        self.assertEqual(status, 400)
        self.assertIn("hex", body["error"]["message"])

    def test_a_txid_mismatch_is_never_reported_as_success(self):
        env = self.make_env()
        env.node.send_hook = lambda _h: "ff" * 32
        status, body, _ = self.send(env)
        self.assertEqual(status, 500)
        self.assertEqual(body["error"]["code"], "txid_mismatch")


class LostResponseTests(BroadcastTestCase):
    """CLAUDE.md section 7.6: a lost response is not a failure."""

    def test_a_lost_response_is_resolved_by_asking_for_the_txid(self):
        env = self.make_env()

        def lose_the_answer(_hexstr):
            # The node really did accept it; only the answer went missing.
            env.node.add_mempool_tx(txid=SEGWIT_TXID, pays=[("ADDRX", COIN)])
            raise RpcTransportError("connection reset by peer")

        env.node.send_hook = lose_the_answer
        status, body, _ = self.send(env)
        self.assertIn(status, (200, 202), body)
        self.assertIs(body["accepted_by_node"], True)
        self.assertIn("was lost", body["note"])

    def test_an_unresolvable_outcome_is_neither_success_nor_rejection(self):
        env = self.make_env()
        env.node.send_hook = lambda _h: (_ for _ in ()).throw(
            RpcTransportError("connection reset by peer"))
        status, body, _ = self.send(env)
        self.assertEqual(status, 502)
        self.assertIsNone(body["accepted_by_node"])
        self.assertEqual(body["error"]["code"], "broadcast_outcome_unknown")
        self.assertIn("NOT a rejection", body["error"]["message"])
        self.assertIs(body["retry"]["safe"], True)
        self.assertIsNone(body["network"]["has_it"])
        # The txid is still reported, which is what makes the retry checkable.
        self.assertEqual(body["txid"], SEGWIT_TXID)

    def test_resending_the_same_hex_is_idempotent(self):
        env = self.make_env()
        first = self.send(env)
        second = self.send(env)
        self.assertEqual(first[1]["txid"], second[1]["txid"])
        self.assertEqual(len(env.node.mempool), 1)


class GateTests(BroadcastTestCase):
    def test_a_wallet_enabled_node_is_refused(self):
        chain = build_chain()
        env = Env(chain=chain, node=FakeNode(chain, wallets=["payouts"]))
        self.addCleanup(env.close)
        status, body, _ = self.send(env)
        self.assertEqual(status, 503)
        self.assertEqual(body["error"]["code"], "broadcast_unavailable")
        self.assertIn("-disablewallet", body["error"]["message"])
        self.assertEqual(env.node.sent, [])
        state, _b, _h = env.get("/api/status")
        self.assertEqual(state, 200)

    def test_the_wallet_check_can_be_overridden_explicitly(self):
        chain = build_chain()
        env = Env(chain=chain, node=FakeNode(chain, wallets=["payouts"]),
                  allow_wallet_node=True)
        self.addCleanup(env.close)
        status, _body, _h = self.send(env)
        self.assertIn(status, (200, 202))

    def test_status_reports_why_broadcast_is_unavailable(self):
        chain = build_chain()
        env = Env(chain=chain, node=FakeNode(chain, wallets=["payouts"]))
        self.addCleanup(env.close)
        status, body, _ = env.get("/api/status")
        self.assertEqual(status, 200)
        self.assertIs(body["broadcast"]["enabled"], False)
        self.assertTrue(body["broadcast"]["reasons"])
        self.assertIs(body["broadcast"]["checks"]["wallet_probe"]
                      ["wallet_rpcs_present"], True)

    def test_broadcast_can_be_disabled_by_configuration(self):
        env = self.make_env(enabled=False)
        status, body, _ = self.send(env)
        self.assertEqual(status, 503)
        self.assertIn("--no-broadcast", body["error"]["message"])

    def test_a_node_on_a_different_chain_is_refused(self):
        env = self.make_env()
        env.broadcaster._node_genesis = "ff" * 32
        status, body, _ = self.send(env)
        self.assertEqual(status, 503)
        self.assertIn("different chains", body["error"]["message"])
        self.assertEqual(env.node.sent, [])

    def test_an_unreachable_node_disables_broadcast_rather_than_pretending(self):
        env = self.make_env()
        env.blind_node()
        env.node.transport_down = True
        status, body, _ = self.send(env)
        self.assertEqual(status, 503)
        self.assertEqual(body["error"]["code"], "broadcast_unavailable")


class RateLimitTests(BroadcastTestCase):
    def test_broadcast_has_its_own_stricter_limit(self):
        env = self.make_env(broadcast_rate=0.0, broadcast_burst=2)
        codes = [self.send(env)[0] for _ in range(4)]
        self.assertEqual([c in (200, 202) for c in codes[:2]], [True, True])
        self.assertEqual(codes[2:], [429, 429])
        status, body, headers = self.send(env)
        self.assertEqual(status, 429)
        self.assertEqual(body["error"]["limit_scope"], "client")
        self.assertIn("Retry-After", headers)

    def test_a_global_limit_caps_the_whole_process(self):
        env = self.make_env(broadcast_rate=1000.0, broadcast_burst=1000.0,
                            broadcast_global_rate=0.0, broadcast_global_burst=1)
        first = self.send(env)[0]
        second = self.send(env, LEGACY_HEX)
        self.assertIn(first, (200, 202))
        self.assertEqual(second[0], 429)
        self.assertEqual(second[1]["error"]["limit_scope"], "global")

    def test_reads_are_not_blocked_by_the_broadcast_limit(self):
        env = self.make_env(broadcast_rate=0.0, broadcast_burst=0)
        self.assertEqual(self.send(env)[0], 429)
        self.assertEqual(env.get("/api/status")[0], 200)


class NoWriteTests(BroadcastTestCase):
    def test_broadcast_does_not_touch_the_index(self):
        """Broadcast is the only state-changing endpoint, and the state it
        changes is the node's mempool -- never this database."""
        env = self.make_env()

        def digest():
            out = hashlib.sha256()
            for suffix in ("", "-wal"):
                path = env.db_path + suffix
                if os.path.exists(path):
                    with open(path, "rb") as fh:
                        out.update(fh.read())
            return out.hexdigest()

        before = digest()
        status, _body, _h = self.send(env)
        self.assertIn(status, (200, 202))
        self.assertEqual(digest(), before)


if __name__ == "__main__":                                   # pragma: no cover
    unittest.main()
