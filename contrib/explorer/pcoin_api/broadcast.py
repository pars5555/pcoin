"""Transaction broadcast: the one endpoint in this API that changes anything.

Everything else here is a read of a SQLite file opened `mode=ro`. This is the
exception, so it carries the constraints the rest does not need.

**It never holds a key.** The client signs; this relays. There is no wallet in
this process, no address derivation and no signing code anywhere in the package.

**The node it relays through must be a `-disablewallet` node.** Verified at
startup by probing `listwallets` (see `nodeview.wallet_probe`), not assumed.
An API that can reach a wallet RPC is one misconfigured reverse proxy away from
being able to spend, and CLAUDE.md section 7.10 records what happens when a
wallet-scoped RPC is aimed at the wrong wallet.

**It reports whether the network has the transaction, not whether the node
accepted it.** Those are different claims and the difference is the whole point:
a transaction can enter a local mempool on a node with zero peers and go nowhere,
and the client will have been told "sent". The honest signals, in descending
strength:

  1. an independent *witness node* has the transaction in its mempool -- proof it
     crossed the network, if the operator configured one;
  2. it was already mined -- `sendrawtransaction` answering -27, or the txid
     turning up in a block;
  3. `getmempoolentry(txid).unbroadcast == false`. Core keeps a transaction in an
     "unbroadcast" set from the moment it is submitted locally until a peer sends
     a GETDATA for it and we push it over the wire
     (`src/net_processing.cpp:2382`, `src/rpc/mempool.cpp:341`). `false`
     therefore means *at least one peer asked for this transaction and received
     it* -- a genuine "it left this box" signal from a single node;
  4. zero peers -- then nobody can have it, and that is a fact, reported as
     `network.has_it: false`;
  5. anything else is **unknown**, reported as `network.has_it: null`. Never as
     success and never as failure. CLAUDE.md section 7.2.

**A lost response is not a failure.** CLAUDE.md section 7.6. The txid is computed
locally from the submitted bytes before the node is contacted, so if the HTTP
response to `sendrawtransaction` goes missing we ask the node whether it has that
exact transaction instead of guessing -- and the client can retry the identical
request safely, because `sendrawtransaction` on a transaction already in the
mempool is idempotent.
"""

import threading
import time

from pcoin_indexer import db as indexdb
from pcoin_indexer.rpc import RpcError, RpcTransportError

from .errors import ApiError
from .txid import TxParseError, parse_hex

RPC_METHOD_NOT_FOUND = -32601
RPC_INVALID_ADDRESS_OR_KEY = -5      # "No such mempool transaction"
RPC_VERIFY_ERROR = -25
RPC_VERIFY_REJECTED = -26
RPC_VERIFY_ALREADY_IN_UTXO_SET = -27
RPC_IN_WARMUP = -28
RPC_DESERIALIZATION_ERROR = -22

DEFAULT_WAIT_SECONDS = 8.0
DEFAULT_POLL_SECONDS = 0.5


class Broadcaster:
    def __init__(self, rpc, node, store, *, enabled=True,
                 allow_wallet_node=False, witness_rpc=None,
                 wait_seconds=DEFAULT_WAIT_SECONDS,
                 poll_seconds=DEFAULT_POLL_SECONDS, log=None,
                 clock=time.monotonic, sleep=time.sleep):
        self.rpc = rpc
        self.node = node
        self.store = store
        self.enabled = enabled
        self.allow_wallet_node = allow_wallet_node
        self.witness_rpc = witness_rpc
        self.wait_seconds = wait_seconds
        self.poll_seconds = poll_seconds
        self.log = log or (lambda msg: None)
        self._clock = clock
        self._sleep = sleep
        self._lock = threading.Lock()
        self._node_genesis = None
        self.sent_count = 0

    # -- gate ------------------------------------------------------------
    def _index_genesis(self):
        try:
            with self.store.snapshot() as conn:
                state = indexdb.get_state(conn) or {}
                return state.get("genesis_hash")
        except Exception:                                    # pragma: no cover
            return None

    def _node_genesis_hash(self):
        with self._lock:
            if self._node_genesis is not None:
                return self._node_genesis
        try:
            value = self.rpc.block_hash(0)
        except (RpcError, RpcTransportError):
            return None
        with self._lock:
            self._node_genesis = value
        return value

    def state(self):
        """Whether broadcast is available, and if not, exactly why.

        Surfaced by `/api/status` so an operator finds out from the status page
        rather than from a user whose payment did not send.
        """
        checks = {}
        reasons = []
        if not self.enabled:
            reasons.append("broadcast is disabled by configuration (--no-broadcast)")
        checks["configured"] = self.enabled

        probe = self.node.wallet_probe()
        checks["wallet_probe"] = probe
        if probe["known"] and probe["wallet_rpcs_present"]:
            if self.allow_wallet_node:
                checks["wallet_override"] = True
            else:
                reasons.append(
                    "the broadcast node has wallet RPCs enabled (%s); this API "
                    "refuses to relay through a node that can spend. Run it with "
                    "-disablewallet, or pass --allow-wallet-node to accept the "
                    "risk explicitly." % probe["detail"])
        elif not probe["known"]:
            reasons.append("could not determine whether the broadcast node has a "
                           "wallet: %s" % probe["detail"])

        snap = self.node.snapshot()
        checks["node_reachable"] = bool(snap.get("fresh"))
        if not snap.get("known"):
            reasons.append("the broadcast node has never been reached: %s"
                           % (snap.get("error") or "no successful poll"))

        index_genesis = self._index_genesis()
        node_genesis = self._node_genesis_hash()
        checks["index_genesis"] = index_genesis
        checks["node_genesis"] = node_genesis
        if index_genesis and node_genesis and index_genesis != node_genesis:
            reasons.append(
                "the broadcast node serves genesis %s but this index was built on "
                "%s -- they are different chains" % (node_genesis, index_genesis))

        checks["witness_node"] = self.witness_rpc is not None
        return {"enabled": not reasons, "reasons": reasons, "checks": checks,
                "wait_seconds": self.wait_seconds,
                "sent_this_process": self.sent_count}

    # -- broadcast -------------------------------------------------------
    def broadcast(self, hexstr, *, wait_seconds=None):
        """-> (http_status, payload). Never raises for an ordinary rejection."""
        gate = self.state()
        if not gate["enabled"]:
            raise ApiError(503, "broadcast_unavailable",
                           "; ".join(gate["reasons"]), checks=gate["checks"])

        try:
            parsed = parse_hex(hexstr)
        except TxParseError as exc:
            raise ApiError(400, "invalid_transaction", str(exc))

        txid = parsed["txid"]
        wait = self.wait_seconds if wait_seconds is None else wait_seconds

        # Observe the peer count *before* sending, so the answer describes the
        # network the transaction was actually handed to.
        snap = self.node.snapshot(force=True)
        peers = (snap.get("connections") or {}).get("total")

        accepted = None
        already_in_chain = False
        node_error = None
        try:
            returned = self.rpc.call("sendrawtransaction", parsed["hex"])
            accepted = True
            if isinstance(returned, str) and returned.lower() != txid:
                # Our txid and the node's disagree: we did not send what we think
                # we sent. Refuse to report either as authoritative.
                raise ApiError(
                    500, "txid_mismatch",
                    "the node returned txid %s for a transaction this API "
                    "computed as %s" % (returned, txid))
        except RpcError as exc:
            if exc.code == RPC_VERIFY_ALREADY_IN_UTXO_SET:
                already_in_chain = True
                accepted = False
            else:
                return self._rejection(txid, parsed, exc, peers)
        except RpcTransportError as exc:
            # The call may well have succeeded and only the answer was lost.
            # Ask the node whether it has this exact transaction rather than
            # guessing -- CLAUDE.md section 7.6.
            present, detail = self._is_in_mempool(self.rpc, txid)
            if present is True:
                accepted = True
                node_error = ("the response to sendrawtransaction was lost (%s), "
                              "but the node's mempool contains this txid" % exc)
            else:
                return 502, {
                    "txid": txid,
                    "accepted_by_node": None,
                    "error": {
                        "code": "broadcast_outcome_unknown",
                        "message": "the node did not answer (%s) and a follow-up "
                                   "check could not confirm the transaction "
                                   "either way (%s). This is NOT a rejection: "
                                   "re-sending the identical hex is safe and "
                                   "idempotent." % (exc, detail),
                    },
                    "network": {"has_it": None, "state": "unknown",
                                "peers": peers,
                                "detail": "the transaction's fate is unknown"},
                    "retry": {"safe": True, "how": "POST the identical hex again"},
                }

        with self._lock:
            self.sent_count += 1
        self.log("broadcast %s (accepted=%s, peers=%s)" % (txid, accepted, peers))

        network = self._observe_propagation(txid, peers, wait,
                                            already_in_chain=already_in_chain)
        payload = {
            "txid": txid,
            "accepted_by_node": accepted,
            "already_in_chain": already_in_chain,
            "network": network,
            "tx": {"size": parsed["size"], "vsize": parsed["vsize"],
                   "weight": parsed["weight"], "version": parsed["version"],
                   "locktime": parsed["locktime"],
                   "input_count": len(parsed["vin"]),
                   "output_count": len(parsed["vout"]),
                   "has_witness": parsed["has_witness"],
                   "wtxid": parsed["wtxid"]},
            "next": "/api/tx/%s" % txid,
        }
        if node_error:
            payload["note"] = node_error
        # 200 only when the network demonstrably has it. 202 means "we have it,
        # the network's state is not established" -- which is the truth in every
        # other case, and a client that reads only the status code still learns
        # the difference.
        return (200 if network["has_it"] is True else 202), payload

    def _rejection(self, txid, parsed, exc, peers):
        status = 400
        code = "rejected"
        if exc.code == RPC_IN_WARMUP:
            status, code = 503, "node_warming_up"
        elif exc.code == RPC_DESERIALIZATION_ERROR:
            code = "malformed_transaction"
        elif exc.code in (RPC_VERIFY_ERROR, RPC_VERIFY_REJECTED):
            code = "rejected"
        elif exc.code == RPC_METHOD_NOT_FOUND:               # pragma: no cover
            status, code = 503, "broadcast_unavailable"
        return status, {
            "txid": txid,
            "accepted_by_node": False,
            "error": {"code": code, "message": exc.message,
                      "rpc_code": exc.code,
                      "detail": "This is the node's answer, i.e. a fact about "
                                "this transaction -- not a transport failure."},
            "network": {"has_it": False, "state": "rejected", "peers": peers,
                        "detail": "the node did not accept the transaction, so "
                                  "it was never relayed"},
            "tx": {"vsize": parsed["vsize"], "input_count": len(parsed["vin"]),
                   "output_count": len(parsed["vout"])},
        }

    # -- propagation -----------------------------------------------------
    def _is_in_mempool(self, rpc, txid):
        """-> (True | False | None, detail). None means we could not find out."""
        try:
            entry = rpc.call("getmempoolentry", txid)
        except RpcError as exc:
            if exc.code == RPC_INVALID_ADDRESS_OR_KEY:
                return False, "not in the mempool"
            return None, "getmempoolentry -> %s: %s" % (exc.code, exc.message)
        except RpcTransportError as exc:
            return None, "could not reach the node: %s" % exc
        return True, entry

    def _observe_propagation(self, txid, peers, wait, *, already_in_chain=False):
        started = self._clock()
        result = {"has_it": None, "state": "unknown", "peers": peers,
                  "waited_seconds": 0.0, "checks": {}}

        if already_in_chain:
            result.update({
                "has_it": True, "state": "already_in_a_block",
                "detail": "the node answered -27: this transaction is already in "
                          "the chain, so the network unquestionably has it"})
            return result

        if peers == 0:
            # Not unknown. With no peers the transaction cannot have reached
            # anybody, and it will sit in the local mempool until this node
            # connects to something. Core retries the initial broadcast every
            # 10-15 minutes (src/net_processing.cpp:1541).
            result.update({
                "has_it": False, "state": "no_peers",
                "detail": "the broadcast node has zero peers, so nothing on the "
                          "network has received this transaction. It is in the "
                          "local mempool and will be re-offered when the node "
                          "connects to a peer."})
            return result

        deadline = started + max(0.0, wait)
        while True:
            if self.witness_rpc is not None:
                present, detail = self._is_in_mempool(self.witness_rpc, txid)
                result["checks"]["witness_node"] = (
                    True if present is True else False if present is False
                    else "unknown: %s" % detail)
                if present is True:
                    result.update({
                        "has_it": True, "state": "observed_by_witness_node",
                        "waited_seconds": round(self._clock() - started, 3),
                        "detail": "an independent node, not the one this "
                                  "transaction was submitted to, has it in its "
                                  "mempool -- it crossed the network"})
                    return result

            present, detail = self._is_in_mempool(self.rpc, txid)
            if present is True and isinstance(detail, dict):
                unbroadcast = detail.get("unbroadcast")
                result["checks"]["unbroadcast"] = unbroadcast
                if unbroadcast is False:
                    result.update({
                        "has_it": True, "state": "acknowledged_by_peer",
                        "waited_seconds": round(self._clock() - started, 3),
                        "detail": "a peer requested this transaction and the node "
                                  "sent it (Core cleared it from the unbroadcast "
                                  "set), so at least one other node has it"})
                    return result
                state = "awaiting_peer_acknowledgement"
            elif present is False:
                # It left the mempool between the send and this check. Mined is
                # the good explanation; there are others (eviction, a conflict).
                mined = self._mined_check(txid)
                if mined is True:
                    result.update({
                        "has_it": True, "state": "confirmed_in_block",
                        "waited_seconds": round(self._clock() - started, 3),
                        "detail": "the transaction is already in a block"})
                    return result
                state = "left_mempool_unexplained"
                result["checks"]["mined"] = mined
            else:
                state = "unknown"
                result["checks"]["local_mempool"] = "unknown: %s" % detail

            now = self._clock()
            if now >= deadline:
                result["state"] = state
                result["waited_seconds"] = round(now - started, 3)
                result["detail"] = self._explain(state, wait)
                return result
            self._sleep(min(self.poll_seconds, max(0.0, deadline - now)))

    def _mined_check(self, txid):
        """True / False / None. Needs -txindex on the node to answer False vs
        None reliably; without it a confirmed transaction also reads as -5, so
        this is deliberately allowed to return None rather than guess."""
        try:
            raw = self.rpc.call("getrawtransaction", txid, True)
        except RpcError as exc:
            if exc.code == RPC_INVALID_ADDRESS_OR_KEY:
                return None      # no txindex, or genuinely unknown -- not "no"
            return None
        except RpcTransportError:
            return None
        if isinstance(raw, dict) and raw.get("blockhash"):
            return True
        return False

    @staticmethod
    def _explain(state, wait):
        if state == "awaiting_peer_acknowledgement":
            return ("The node has the transaction and is offering it to peers, but "
                    "no peer had requested it within %.1fs. Core announces on a "
                    "randomised delay, so this is not evidence of a problem -- it "
                    "is simply not yet established that the network has it. Poll "
                    "GET /api/tx/<txid>." % wait)
        if state == "left_mempool_unexplained":
            return ("The transaction is no longer in the node's mempool and this "
                    "API could not confirm it was mined. It may have been mined, "
                    "evicted, or replaced. Poll GET /api/tx/<txid>.")
        return ("This API could not establish whether the network has the "
                "transaction. That is an unknown, not a failure. Poll "
                "GET /api/tx/<txid>.")
