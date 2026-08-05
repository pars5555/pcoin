"""Live observations of the node: peers, relay fees, and the mempool.

The index answers everything about *confirmed* history. Three things it cannot
answer, because they are not in any block, come from here:

  * how many peers the node has, which is what decides whether a broadcast can
    physically go anywhere;
  * the relay fee floor;
  * the mempool -- without which ``/api/address/{a}/utxos`` hands a wallet back
    the very outpoint it just spent and the wallet double-spends itself
    (CLAUDE.md section 11).

Everything here follows CLAUDE.md section 7.1/7.2 literally: **an RPC that
failed, timed out or answered "I do not know" resolves nothing.** A failed poll
never advances an observation and never clears one. It sets ``fresh=False`` and
an ``error``, and leaves the previous observation in place with its true age, so
a caller can see *"this is what we knew 40 seconds ago"* rather than a confident
zero. In particular an unreachable node must never turn into
``unconfirmed_balance = 0``; it turns into ``unconfirmed: {"known": false}``.
"""

import threading
import time

from pcoin_indexer.amounts import to_sat
from pcoin_indexer.rpc import RpcError, RpcTransportError

# JSON-RPC / Bitcoin Core error codes we interpret rather than merely report.
RPC_METHOD_NOT_FOUND = -32601      # e.g. every wallet RPC on a -disablewallet node
RPC_INVALID_ADDRESS_OR_KEY = -5    # "No such mempool transaction"
RPC_WALLET_NOT_FOUND = -18         # wallet support present, no wallet loaded

DEFAULT_CACHE_SECONDS = 2.0

# How many mempool transactions this process will decode and keep bodies for.
#
# PCoin has no fee market and an effective relay floor of 1.000 sat/vB, while
# Core's `-maxmempool` default is 300 MB -- so the mempool is sized by whoever
# is willing to pay that floor, not by us. Without a ceiling, one refresh is a
# single JSON-RPC batch containing one `getrawtransaction` per mempool entry,
# aimed at the same node the broadcast path depends on, and `_tx_cache` retains
# a decoded body for each. Both are bounded here. Beyond the cap the mempool is
# still reported with the node's true `tx_count`, and `truncated` says the
# per-address view is incomplete -- it never reads as a smaller mempool.
DEFAULT_MAX_MEMPOOL_TXS = 5000

# One JSON-RPC batch is one HTTP request and one JSON document held in memory at
# both ends. Fetch in chunks rather than as one giant array.
DEFAULT_RPC_BATCH = 250

# 1 sat/vB == 1000 sat/kvB. Core reports fee rates in PCN/kvB.
SAT_PER_KVB_PER_SAT_PER_VB = 1000


def _sat_per_kvb(amount):
    """Core reports fee rates as an amount per kvB. Convert exactly, no floats."""
    return to_sat(amount)


def sat_per_vb_str(sat_per_kvb):
    """Render sat/vB as a fixed-point string. Never a float: a fee rate that
    prints as 0.30000000000000004 in a wallet is a support ticket."""
    if sat_per_kvb is None:
        return None
    whole, frac = divmod(int(sat_per_kvb), SAT_PER_KVB_PER_SAT_PER_VB)
    return "%d.%03d" % (whole, frac)


class NodeView:
    """Cached, thread-safe view of one node's live state.

    A single refresh costs one JSON-RPC batch of four calls, plus one more batch
    only when the mempool contains transactions we have not seen before. With an
    empty mempool -- the normal state on PCoin today -- that is four calls every
    ``cache_seconds``, regardless of how many HTTP requests arrive.
    """

    def __init__(self, rpc, resolver=None, *, cache_seconds=DEFAULT_CACHE_SECONDS,
                 max_mempool_txs=DEFAULT_MAX_MEMPOOL_TXS,
                 rpc_batch=DEFAULT_RPC_BATCH, log=None, clock=time.time):
        self.rpc = rpc
        self.resolver = resolver
        self.cache_seconds = cache_seconds
        self.max_mempool_txs = max_mempool_txs
        self.rpc_batch = max(1, int(rpc_batch))
        self.log = log or (lambda msg: None)
        self._clock = clock
        # Two locks on purpose. `_lock` is held only for the microseconds it
        # takes to read or swap the snapshot dict. `_refresh_lock` is held across
        # the RPC round trip, and is taken *non-blocking* by ordinary requests:
        # if another thread is already refreshing, this one serves the previous
        # observation with its true age rather than queueing behind a node that
        # may be hung. One slow node must not consume every request thread.
        self._lock = threading.Lock()
        self._refresh_lock = threading.Lock()
        self._snapshot = self._empty()
        self._tx_cache = {}          # txid -> decoded mempool tx
        self._wallet_probe = {"known": False, "wallet_rpcs_present": None,
                              "detail": "not probed yet"}

    # -- shape ----------------------------------------------------------
    def _empty(self):
        return {
            "known": False, "fresh": False, "error": None,
            "observed_at": None, "age_seconds": None,
            "chain": None, "blocks": None, "headers": None,
            "best_hash": None, "initial_block_download": None,
            "connections": {"total": None, "in": None, "out": None},
            "relay": {},
            "mempool": {"known": False, "reason": "the node has never been polled "
                                                  "successfully", "tx_count": None},
        }

    # -- public ---------------------------------------------------------
    def snapshot(self, *, force=False):
        """Return the current view, refreshing it if the cache has expired.

        `force=True` waits for a refresh -- broadcast uses it, because the peer
        count it reports has to describe the network the transaction was
        actually handed to. Everything else prefers a slightly older answer over
        a slower one, and says how old it is.
        """
        now = self._clock()
        with self._lock:
            attempted = self._snapshot.get("attempted_at")
            fresh_enough = (attempted is not None
                            and now - attempted < self.cache_seconds)
            if not force and fresh_enough:
                return self._with_age(now)

        if not self._refresh_lock.acquire(blocking=force):
            with self._lock:
                return self._with_age(self._clock())
        try:
            # Re-check: another thread may have refreshed while we waited.
            now = self._clock()
            with self._lock:
                attempted = self._snapshot.get("attempted_at")
                if (not force and attempted is not None
                        and now - attempted < self.cache_seconds):
                    return self._with_age(now)
            self._refresh(now)
        finally:
            self._refresh_lock.release()
        with self._lock:
            return self._with_age(self._clock())

    def _with_age(self, now):
        """Caller must hold `_lock`."""
        snap = dict(self._snapshot)
        snap["age_seconds"] = (None if snap["observed_at"] is None
                               else round(now - snap["observed_at"], 3))
        return snap

    def wallet_probe(self):
        """Is this node running with -disablewallet?

        A `-disablewallet` node does not register any wallet RPC at all, so
        ``listwallets`` comes back as -32601 "Method not found". Anything else --
        a list of wallets, or -18 "No wallet is loaded" -- means wallet support is
        compiled in and enabled, and this process refuses to use such a node for
        broadcast unless the operator explicitly overrides it.

        The reason is narrow and worth stating: this API must never be able to
        move somebody's coins. It only ever calls `sendrawtransaction`, so a
        wallet on the far end is not *directly* reachable -- but an API that can
        reach a wallet RPC port is one bug or one misconfigured reverse proxy away
        from being able to spend, and CLAUDE.md section 7.10 records what happens
        when a wallet-scoped RPC is aimed at the wrong wallet.
        """
        with self._lock:
            if self._wallet_probe["known"]:
                return dict(self._wallet_probe)
        result = self._probe_wallet()
        with self._lock:
            self._wallet_probe = result
        return dict(result)

    def _probe_wallet(self):
        try:
            wallets = self.rpc.call("listwallets")
        except RpcError as exc:
            if exc.code == RPC_METHOD_NOT_FOUND:
                return {"known": True, "wallet_rpcs_present": False,
                        "detail": "listwallets -> -32601, so the node runs with "
                                  "-disablewallet"}
            if exc.code == RPC_WALLET_NOT_FOUND:
                return {"known": True, "wallet_rpcs_present": True,
                        "detail": "listwallets -> -18, so wallet support is enabled "
                                  "(no wallet currently loaded)"}
            return {"known": True, "wallet_rpcs_present": True,
                    "detail": "listwallets -> error %s: %s" % (exc.code, exc.message)}
        except RpcTransportError as exc:
            # Not an answer. Resolves nothing -- stays unknown, and is re-probed.
            return {"known": False, "wallet_rpcs_present": None,
                    "detail": "could not reach the node: %s" % exc}
        loaded = wallets if isinstance(wallets, list) else []
        return {"known": True, "wallet_rpcs_present": True,
                "detail": "listwallets succeeded and returned %d loaded wallet(s)"
                          % len(loaded),
                "loaded_wallets": len(loaded)}

    # -- refresh --------------------------------------------------------
    def _refresh(self, now):
        """Caller holds `_refresh_lock` and must NOT hold `_lock`."""
        with self._lock:
            snap = dict(self._snapshot)
        snap["attempted_at"] = now
        try:
            chaininfo, netinfo, mempoolinfo, rawmempool = self.rpc.batch([
                ("getblockchaininfo", []),
                ("getnetworkinfo", []),
                ("getmempoolinfo", []),
                ("getrawmempool", [True]),
            ])
        except (RpcTransportError, RpcError) as exc:
            snap["fresh"] = False
            snap["error"] = str(exc)
            # Everything else is deliberately left exactly as it was. The caller
            # reads `age_seconds` and decides; it never sees a fabricated zero.
            snap["mempool"] = dict(snap["mempool"])
            snap["mempool"]["fresh"] = False
            snap["mempool"]["error"] = str(exc)
            with self._lock:
                self._snapshot = snap
            return

        snap.update({
            "known": True, "fresh": True, "error": None, "observed_at": now,
            "chain": chaininfo.get("chain"),
            "blocks": chaininfo.get("blocks"),
            "headers": chaininfo.get("headers"),
            "best_hash": chaininfo.get("bestblockhash"),
            "initial_block_download": bool(chaininfo.get("initialblockdownload")),
            "connections": {
                "total": netinfo.get("connections"),
                "in": netinfo.get("connections_in"),
                "out": netinfo.get("connections_out"),
            },
            "relay": self._relay_block(netinfo, mempoolinfo),
        })
        snap["mempool"] = self._build_mempool(rawmempool, mempoolinfo, now)
        with self._lock:
            self._snapshot = snap

    def _relay_block(self, netinfo, mempoolinfo):
        out = {}
        for key, src, field in (
            ("min_relay", mempoolinfo, "minrelaytxfee"),
            ("mempool_min", mempoolinfo, "mempoolminfee"),
            ("incremental_relay", mempoolinfo, "incrementalrelayfee"),
            ("network_relay", netinfo, "relayfee"),
        ):
            value = src.get(field)
            if value is None:
                continue
            out[key + "_sat_per_kvb"] = _sat_per_kvb(value)
        out["mempool_bytes"] = mempoolinfo.get("bytes")
        out["mempool_max_bytes"] = mempoolinfo.get("maxmempool")
        out["full_rbf"] = mempoolinfo.get("fullrbf")
        out["unbroadcast_count"] = mempoolinfo.get("unbroadcastcount")
        return out

    # -- mempool --------------------------------------------------------
    def _build_mempool(self, rawmempool, mempoolinfo, now):
        """Turn the node's mempool into per-address deltas and spent outpoints.

        Two things make this small enough to do on every refresh: PCoin has no
        fee market and a near-empty mempool, and transaction bodies are cached
        across refreshes so a stable mempool costs no extra RPC at all.
        """
        if not isinstance(rawmempool, dict):
            return {"known": False, "fresh": False,
                    "reason": "getrawmempool returned %s, not an object"
                              % type(rawmempool).__name__,
                    "tx_count": None}

        all_txids = list(rawmempool.keys())
        total = len(all_txids)
        truncated = total > self.max_mempool_txs
        txids = all_txids
        if truncated:
            # Oldest first, and deterministic: the tracked set then barely
            # changes between refreshes, so the body cache is not churned and
            # the transactions most likely to be mined next are the ones we
            # understand. `_seq`-style insertion order would not be stable.
            def _entry_time(t):
                e = rawmempool.get(t)
                return (e.get("time") if isinstance(e, dict) else None) or 0
            txids = sorted(all_txids, key=lambda t: (_entry_time(t), t))
            txids = txids[:self.max_mempool_txs]

        wanted = [t for t in txids if t not in self._tx_cache]
        for start in range(0, len(wanted), self.rpc_batch):
            chunk = wanted[start:start + self.rpc_batch]
            try:
                bodies = self.rpc.batch(
                    [("getrawtransaction", [t, True]) for t in chunk],
                    missing_codes=(RPC_INVALID_ADDRESS_OR_KEY,))
            except (RpcTransportError, RpcError) as exc:
                return {"known": False, "fresh": False,
                        "reason": "could not fetch %d mempool transaction(s): %s"
                                  % (len(wanted), exc),
                        "tx_count": total}
            for t, body in zip(chunk, bodies):
                if body is not None:
                    self._tx_cache[t] = body
        # Drop bodies for transactions that have left the mempool -- or that
        # fell outside the cap, which is what bounds `_tx_cache` to
        # `max_mempool_txs` entries however large the node's mempool grows.
        live = set(txids)
        for gone in [t for t in self._tx_cache if t not in live]:
            del self._tx_cache[gone]

        # Outputs created by mempool transactions, so a chained spend resolves.
        mem_outputs = {}
        for t in txids:
            body = self._tx_cache.get(t)
            if body is None:
                continue
            for o in body.get("vout") or []:
                spk = o.get("scriptPubKey") or {}
                mem_outputs[(t, o["n"])] = (spk.get("address"), to_sat(o["value"]))

        # Everything not created in the mempool must come from the index.
        need = []
        for t in txids:
            body = self._tx_cache.get(t)
            if body is None:
                continue
            for i in body.get("vin") or []:
                if "coinbase" in i:
                    continue
                key = (i["txid"], i["vout"])
                if key not in mem_outputs:
                    need.append(key)
        confirmed = {}
        resolver_error = None
        if need and self.resolver is not None:
            try:
                confirmed = self.resolver(need)
            except Exception as exc:                     # pragma: no cover
                resolver_error = str(exc)
        elif need:
            resolver_error = "no index resolver configured"

        by_address = {}
        spent_outpoints = {}
        incomplete = []

        def bump(address, field, amount, txid):
            if address is None:
                return
            entry = by_address.setdefault(address, {
                "received_sat": 0, "sent_sat": 0, "txids": [],
                "outputs": [], "spends": []})
            entry[field] += amount
            if txid not in entry["txids"]:
                entry["txids"].append(txid)
            return entry

        for t in txids:
            body = self._tx_cache.get(t)
            if body is None:
                incomplete.append(t)
                continue
            unresolved = 0
            for i in body.get("vin") or []:
                if "coinbase" in i:
                    continue
                key = (i["txid"], i["vout"])
                from_mempool = key in mem_outputs
                src = mem_outputs[key] if from_mempool else confirmed.get(key)
                if src is None:
                    unresolved += 1
                    continue
                address, value = src
                spent_outpoints[key] = t
                entry = bump(address, "sent_sat", value, t)
                if entry is not None:
                    # `confirmed` distinguishes "a coin that exists in a block is
                    # on its way out" from "an unconfirmed coin is being re-spent".
                    # Only the former can be subtracted from a confirmed balance.
                    entry["spends"].append({"txid": key[0], "vout": key[1],
                                            "value_sat": value, "spender_txid": t,
                                            "confirmed": not from_mempool})
            for o in body.get("vout") or []:
                spk = o.get("scriptPubKey") or {}
                address = spk.get("address")
                value = to_sat(o["value"])
                entry = bump(address, "received_sat", value, t)
                if entry is not None:
                    entry["outputs"].append({
                        "txid": t, "vout": o["n"], "value_sat": value,
                        "script_hex": spk.get("hex"), "script_type": spk.get("type")})
            if unresolved:
                incomplete.append(t)

        out = {
            "known": True,
            "fresh": True,
            "observed_at": now,
            # The node's own count, never the tracked count -- a truncated view
            # must not read as a smaller mempool.
            "tx_count": total,
            "tracked_tx_count": len(txids),
            "truncated": truncated,
            "bytes": mempoolinfo.get("bytes"),
            "txids": txids,
            "entries": {t: {"vsize": rawmempool[t].get("vsize"),
                            "fee_sat": (to_sat(rawmempool[t]["fees"]["base"])
                                        if rawmempool[t].get("fees") else None),
                            "time": rawmempool[t].get("time"),
                            "depends": rawmempool[t].get("depends") or [],
                            "unbroadcast": rawmempool[t].get("unbroadcast")}
                        for t in txids if isinstance(rawmempool.get(t), dict)},
            "by_address": by_address,
            "spent_outpoints": spent_outpoints,
            # A transaction whose inputs we could not attribute still counts for
            # its outputs, and is named here rather than silently dropped: a
            # partially understood mempool must not look like a fully understood
            # one. `incomplete` non-empty means some address's `sent` may be low.
            "incomplete_txids": incomplete,
            "resolver_error": resolver_error,
        }
        if truncated:
            out["truncated_detail"] = (
                "the node's mempool holds %d transactions and this process "
                "decodes at most %d of them (oldest first), so an output of "
                "yours may be spent by a transaction outside that set"
                % (total, self.max_mempool_txs))
        return out

    def mempool_for_address(self, snapshot, address):
        """Per-address mempool state, or an explicit 'not known' with a reason."""
        mem = snapshot.get("mempool") or {}
        if not mem.get("known"):
            return {"known": False,
                    "reason": mem.get("reason") or mem.get("error")
                              or "the mempool has not been observed"}
        entry = (mem.get("by_address") or {}).get(address)
        out = {
            "known": True,
            "as_of_seconds_ago": snapshot.get("age_seconds"),
            "fresh": bool(mem.get("fresh")),
            "receiving_sat": 0, "spending_sat": 0,
            "tx_count": 0, "txids": [],
            "utxo_count": 0,
        }
        if entry is not None:
            out["receiving_sat"] = entry["received_sat"]
            out["spending_sat"] = entry["sent_sat"]
            out["txids"] = list(entry["txids"])
            out["tx_count"] = len(entry["txids"])
            out["utxo_count"] = len(entry["outputs"])
        details = []
        if mem.get("incomplete_txids"):
            details.append(
                "%d mempool transaction(s) had inputs this API could not attribute "
                "to an address; amounts leaving an address may be understated"
                % len(mem["incomplete_txids"]))
        if mem.get("truncated"):
            details.append(mem.get("truncated_detail") or "the mempool was truncated")
        if details:
            out["partial"] = True
            out["partial_detail"] = "; ".join(details)
        return out
