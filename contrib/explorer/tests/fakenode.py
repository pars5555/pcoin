"""A synthetic node for the API tests.

Extends `fakechain.FakeRpc` -- which already speaks the three block RPCs the
indexer uses -- with everything the API layer needs: wallet probing, peers, relay
fees, the mempool, and `sendrawtransaction`.

It mirrors the real client's failure semantics deliberately:

* a missing mempool entry raises `RpcError(-5)`, the way Core does, so code that
  reads "not found" as "the node is down" fails here;
* `listwallets` raises `RpcError(-32601)` when the node is configured with
  `-disablewallet`, which is exactly how a real `-disablewallet` node answers;
* the transport can be made to fail with `RpcTransportError`, which is a
  different thing from an error answer and must be handled differently.

A fake that was more forgiving than the real client would let tests pass against
an API that cannot survive a real node.
"""

import hashlib
from decimal import Decimal

from . import helpers  # noqa: F401  (sets sys.path)
from .fakechain import FakeRpc
from pcoin_indexer.rpc import RpcError, RpcTransportError


def _pcn(sat):
    return Decimal(sat).scaleb(-8)


def _fake_txid(seed):
    return hashlib.sha256(str(seed).encode()).hexdigest()


def _spk(address):
    if address is None:
        return {"asm": "OP_RETURN", "hex": "6a00", "type": "nulldata"}
    return {"asm": "0 " + hashlib.sha256(address.encode()).hexdigest()[:40],
            "hex": "0014" + hashlib.sha256(address.encode()).hexdigest()[:40],
            "address": address, "type": "witness_v0_keyhash"}


class FakeNode(FakeRpc):
    def __init__(self, chain, *, wallets=None, connections=8):
        super().__init__(chain)
        # wallets=None models `-disablewallet`: the RPC is not registered at all.
        self.wallets = wallets
        self.connections_in = connections // 2
        self.connections_out = connections - connections // 2
        self.min_relay = Decimal("0.00000100")
        self.mempool_min = Decimal("0.00000100")
        self.incremental = Decimal("0.00000100")
        self.mempool = {}            # txid -> entry
        self.transport_down = False
        self.fail_methods = {}       # method -> exception to raise
        self.sent = []               # hex strings handed to sendrawtransaction
        self.send_hook = None        # callable(hex) -> txid, or raises
        # Models a peer having immediately asked for the transaction, which is
        # what clears Core's unbroadcast set (src/net_processing.cpp:2382).
        self.auto_acknowledge = False
        self.mined = set()           # txids that are "in a block"
        self._seq = 0

    # -- test helpers ----------------------------------------------------
    def add_mempool_tx(self, *, spends=(), pays=(), fee_sat=1000, vsize=141,
                       unbroadcast=True, txid=None, time_=1785832900):
        """Put a transaction in the mempool.

        `spends` are (txid, vout) outpoints -- they may be confirmed outputs the
        index knows or outputs of another mempool transaction.
        """
        self._seq += 1
        txid = txid or _fake_txid("mempool:%d:%r:%r" % (self._seq, spends, pays))
        self.mempool[txid] = {
            "txid": txid,
            "vin": [{"txid": t, "vout": n, "sequence": 0xFFFFFFFD,
                     "scriptSig": {"asm": "", "hex": ""},
                     "txinwitness": ["30" * 71, "03" * 33]}
                    for t, n in spends],
            "vout": [{"n": i, "value": _pcn(v), "scriptPubKey": _spk(a)}
                     for i, (a, v) in enumerate(pays)],
            "_fee_sat": fee_sat, "_vsize": vsize, "_time": time_,
            "_unbroadcast": unbroadcast,
        }
        return txid

    def acknowledge(self, txid):
        """Model a peer having asked for the transaction (GETDATA)."""
        if txid in self.mempool:
            self.mempool[txid]["_unbroadcast"] = False

    def mine_mempool_tx(self, txid):
        self.mempool.pop(txid, None)
        self.mined.add(txid)

    # -- dispatch --------------------------------------------------------
    def _dispatch(self, method, params):
        if self.transport_down:
            raise RpcTransportError("cannot reach the node (test)")
        if method in self.fail_methods:
            raise self.fail_methods[method]
        handler = getattr(self, "_rpc_" + method, None)
        if handler is not None:
            self.call_count += 1
            self.calls.append(method)
            return handler(*params)
        return super()._dispatch(method, params)

    # -- RPCs ------------------------------------------------------------
    def _rpc_listwallets(self):
        if self.wallets is None:
            raise RpcError(-32601, "Method not found")
        return list(self.wallets)

    def _rpc_getnetworkinfo(self):
        return {
            "version": 290400, "subversion": "/Satoshi:29.4.0/",
            "connections": self.connections_in + self.connections_out,
            "connections_in": self.connections_in,
            "connections_out": self.connections_out,
            "relayfee": self.min_relay, "incrementalfee": self.incremental,
        }

    def _rpc_getmempoolinfo(self):
        return {
            "loaded": True, "size": len(self.mempool), "bytes": 0, "usage": 32,
            "total_fee": _pcn(sum(e["_fee_sat"] for e in self.mempool.values())),
            "maxmempool": 300000000,
            "mempoolminfee": self.mempool_min, "minrelaytxfee": self.min_relay,
            "incrementalrelayfee": self.incremental,
            "unbroadcastcount": sum(1 for e in self.mempool.values()
                                    if e["_unbroadcast"]),
            "fullrbf": True,
        }

    def _entry(self, e):
        return {"vsize": e["_vsize"], "weight": e["_vsize"] * 4,
                "time": e["_time"], "depends": [], "spentby": [],
                "fees": {"base": _pcn(e["_fee_sat"])},
                "unbroadcast": e["_unbroadcast"]}

    def _rpc_getrawmempool(self, verbose=False):
        if not verbose:
            return list(self.mempool)
        return {t: self._entry(e) for t, e in self.mempool.items()}

    def _rpc_getmempoolentry(self, txid):
        e = self.mempool.get(txid)
        if e is None:
            raise RpcError(-5, "Transaction not in mempool")
        return self._entry(e)

    def _rpc_getrawtransaction(self, txid, verbose=False, blockhash=None):
        e = self.mempool.get(txid)
        if e is not None:
            out = {k: v for k, v in e.items() if not k.startswith("_")}
            out.update({"hash": txid, "version": 2, "size": e["_vsize"] + 20,
                        "vsize": e["_vsize"], "weight": e["_vsize"] * 4,
                        "locktime": 0, "confirmations": 0})
            return out
        if txid in self.mined:
            return {"txid": txid, "blockhash": self.chain.tip, "confirmations": 1}
        # Without -txindex this is also what a confirmed transaction looks like.
        raise RpcError(-5, "No such mempool transaction. Use -txindex ...")

    def _rpc_sendrawtransaction(self, hexstr, *_rest):
        self.sent.append(hexstr)
        if self.send_hook is not None:
            return self.send_hook(hexstr)
        from pcoin_api.txid import parse_hex
        parsed = parse_hex(hexstr)
        self.mempool[parsed["txid"]] = {
            "txid": parsed["txid"],
            "vin": [{"txid": i["prev_txid"], "vout": i["prev_n"],
                     "sequence": i["sequence"], "scriptSig": {"asm": "", "hex": ""}}
                    for i in parsed["vin"]],
            "vout": [{"n": o["n"], "value": _pcn(o["value_sat"]),
                      "scriptPubKey": {"hex": o["script_pub_key_hex"],
                                       "type": "witness_v0_keyhash"}}
                     for o in parsed["vout"]],
            "_fee_sat": 1000, "_vsize": parsed["vsize"], "_time": 1785832900,
            "_unbroadcast": not self.auto_acknowledge,
        }
        return parsed["txid"]
