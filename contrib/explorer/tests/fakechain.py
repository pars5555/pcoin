"""A synthetic chain that speaks `getblock <hash> 3`.

Everything the indexer consumes is a JSON-RPC answer, so a fake node is enough
to exercise the reorg logic exhaustively -- including branches a real node would
take days to produce. The shapes here were copied from a live PCoin mainnet node
(genesis is a bare `pubkey` output with no address; every coinbase carries a
zero-value OP_RETURN witness commitment; every non-coinbase vin carries a
`prevout` with the source address and value).
"""

import hashlib
from decimal import Decimal

from pcoin_indexer.rpc import MISSING_BLOCK_CODES, RpcError

COIN = 100_000_000
SUBSIDY = 50 * COIN
GENESIS_TIME = 1785600628
SPACING = 600


def _h(*parts):
    return hashlib.sha256("|".join(str(p) for p in parts).encode()).hexdigest()


def _pcn(sat):
    """Render satoshis the way the node's JSON does: a bare number. The RPC
    layer parses with parse_float=Decimal, so hand back a Decimal."""
    return Decimal(sat).scaleb(-8)


def _spk_for(address):
    if address is None:
        return {"asm": "<pubkey> OP_CHECKSIG",
                "hex": "41" + "aa" * 65 + "ac", "type": "pubkey"}
    return {"asm": "0 " + _h(address)[:40],
            "hex": "0014" + _h(address)[:40],
            "address": address,
            "type": "witness_v0_keyhash"}


WITNESS_COMMITMENT = {
    "asm": "OP_RETURN aa21a9ed" + "00" * 32,
    "hex": "6a24aa21a9ed" + "00" * 32,
    "type": "nulldata",
}


class FakeChainError(RuntimeError):
    pass


class FakeChain:
    """Mines synthetic blocks. `tip` is the active chain; `set_tip` reorgs."""

    def __init__(self, *, genesis_address=None):
        self.blocks = {}        # hash -> block record
        self.txs = {}           # txid -> tx record (across ALL branches)
        self.tip = None
        self._nonce = 0
        self._mine_genesis(genesis_address)

    # -- construction ---------------------------------------------------
    def _mine_genesis(self, address):
        # PCoin's real genesis pays a bare pubkey and is not in the UTXO set.
        cb = self._coinbase(0, address, SUBSIDY, witness_commitment=False,
                            tag="genesis:%s" % address)
        self.tip = self._store(None, 0, GENESIS_TIME, [cb])

    def _next_txid(self, height, index, tag):
        self._nonce += 1
        return _h("tx", height, index, tag, self._nonce)

    def _coinbase(self, height, address, value, *, witness_commitment=True, extra=None,
                  tag="cb"):
        vout = [{"n": 0, "value": value, "spk": _spk_for(address)}]
        if witness_commitment:
            vout.append({"n": 1, "value": 0, "spk": dict(WITNESS_COMMITMENT)})
        for _i, (addr, val) in enumerate(extra or []):
            vout.append({"n": len(vout), "value": val, "spk": _spk_for(addr)})
        return {
            "txid": self._next_txid(height, 0, tag),
            "coinbase": True,
            "vin": [{"coinbase": "%02x" % (height & 0xFF), "sequence": 0xFFFFFFFF}],
            "vout": vout,
        }

    def _store(self, prev_hash, height, time_, txs):
        self._nonce += 1
        bhash = _h("blk", height, prev_hash, [t["txid"] for t in txs], self._nonce)
        rec = {"hash": bhash, "prev": prev_hash, "height": height, "time": time_,
               "txs": txs}
        self.blocks[bhash] = rec
        for i, t in enumerate(txs):
            if t["txid"] in self.txs and self.txs[t["txid"]]["block"] != bhash:
                # A tx may appear in more than one branch; remember the newest
                # placement, which is what a real node's mempool/branch handling
                # produces. Prevout lookup only needs the tx body.
                pass
            self.txs[t["txid"]] = {"block": bhash, "index": i, "tx": t}
        return bhash

    def mine(self, *, on=None, miner="MINER", spends=None, pays=None, fee=0,
             extra_coinbase=None, time_=None):
        """Extend `on` (default: the active tip) by one block.

        spends: [(txid, n), ...] outpoints consumed by a single payment tx
        pays:   [(address, sat), ...] outputs of that payment tx
        """
        parent = self.tip if on is None else on
        prec = self.blocks[parent]
        height = prec["height"] + 1
        t = prec["time"] + SPACING if time_ is None else time_

        payment = None
        fees = 0
        if spends:
            total_in = 0
            vin = []
            for txid, n in spends:
                src = self.txs.get(txid)
                if src is None:
                    raise FakeChainError("unknown prevout tx %s" % txid)
                out = src["tx"]["vout"][n]
                total_in += out["value"]
                vin.append({"txid": txid, "vout": n, "sequence": 0xFFFFFFFD})
            outs = list(pays or [])
            total_out = sum(v for _a, v in outs)
            fees = total_in - total_out
            if fees < 0:
                raise FakeChainError("payment spends %d but pays %d"
                                     % (total_in, total_out))
            payment = {
                "txid": self._next_txid(height, 1, "pay"),
                "coinbase": False,
                "vin": vin,
                "vout": [{"n": i, "value": v, "spk": _spk_for(a)}
                         for i, (a, v) in enumerate(outs)],
            }
        cb = self._coinbase(height, miner, SUBSIDY + fees, extra=extra_coinbase)
        txs = [cb] if payment is None else [cb, payment]
        bhash = self._store(parent, height, t, txs)
        if parent == self.tip:
            self.tip = bhash
        return bhash

    def mine_many(self, n, *, on=None, miner="MINER"):
        h = self.tip if on is None else on
        for _ in range(n):
            h = self.mine(on=h, miner=miner)
        return h

    def set_tip(self, bhash):
        """Reorg: declare `bhash` the active tip."""
        if bhash not in self.blocks:
            raise FakeChainError("unknown block %s" % bhash)
        self.tip = bhash

    # -- chain views ----------------------------------------------------
    def active_chain(self):
        out = []
        h = self.tip
        while h is not None:
            out.append(h)
            h = self.blocks[h]["prev"]
        out.reverse()
        return out

    def height(self):
        return self.blocks[self.tip]["height"]

    def coinbase_txid(self, height):
        return self.blocks[self.active_chain()[height]]["txs"][0]["txid"]

    def ancestry(self, bhash):
        """Blocks from genesis to `bhash`, in order."""
        out = []
        h = bhash
        while h is not None:
            out.append(h)
            h = self.blocks[h]["prev"]
        out.reverse()
        return out

    def utxos_on(self, bhash):
        """Spendable outputs in the branch ending at `bhash`.

        Needed so a randomised test builds branches that are internally valid:
        an output that exists on one branch may simply not exist on another,
        and mining a block that spends it would be an invalid chain rather than
        an interesting test case."""
        utxo = {}
        for h in self.ancestry(bhash):
            rec = self.blocks[h]
            for t in rec["txs"]:
                if not t["coinbase"]:
                    for i in t["vin"]:
                        utxo.pop((i["txid"], i["vout"]), None)
                for o in t["vout"]:
                    if o["value"] <= 0 or o["spk"].get("address") is None:
                        continue          # nulldata / bare pubkey
                    if rec["height"] == 0:
                        continue          # genesis is not in the UTXO set
                    utxo[(t["txid"], o["n"])] = (o["value"], o["spk"]["address"])
        return [(txid, n, v, a) for (txid, n), (v, a) in utxo.items()]

    # -- RPC surface ----------------------------------------------------
    def getblockhash(self, height):
        chain = self.active_chain()
        if height < 0 or height >= len(chain):
            raise KeyError("Block height out of range")
        return chain[height]

    def getblockchaininfo(self):
        return {"chain": "regtest", "blocks": self.height(),
                "headers": self.height(), "bestblockhash": self.tip,
                "initialblockdownload": False}

    def getblock(self, bhash, verbosity=3):
        rec = self.blocks.get(bhash)
        if rec is None:
            raise KeyError("Block not found")
        chain = self.active_chain()
        on_active = bhash in set(chain)
        conf = (len(chain) - rec["height"]) if on_active else -1
        txs = [self._render_tx(t, i) for i, t in enumerate(rec["txs"])]
        size = 200 + 100 * len(txs)
        out = {
            "hash": rec["hash"],
            "confirmations": conf,
            "height": rec["height"],
            "version": 0x20000000,
            "versionHex": "20000000",
            "merkleroot": _h("mr", rec["hash"]),
            "time": rec["time"],
            "mediantime": rec["time"] - 30,
            "nonce": 1234,
            "bits": "1e0b7c33",
            "difficulty": Decimal("0.0003401078181484832"),
            "chainwork": "%064x" % ((rec["height"] + 1) * 4096),
            "nTx": len(txs),
            "strippedsize": size - 36,
            "size": size,
            "weight": 4 * size - 108,
            "tx": txs,
        }
        if rec["prev"] is not None:
            out["previousblockhash"] = rec["prev"]
        return out

    def _render_tx(self, t, index):
        vin = []
        if t["coinbase"]:
            vin.append({"coinbase": t["vin"][0]["coinbase"],
                        "txinwitness": ["00" * 32],
                        "sequence": t["vin"][0]["sequence"]})
        else:
            for i in t["vin"]:
                src = self.txs[i["txid"]]["tx"]["vout"][i["vout"]]
                vin.append({
                    "txid": i["txid"], "vout": i["vout"],
                    "scriptSig": {"asm": "", "hex": ""},
                    "txinwitness": ["30" * 71, "03" * 33],
                    "prevout": {
                        "generated": self.txs[i["txid"]]["tx"]["coinbase"],
                        "height": self.blocks[self.txs[i["txid"]]["block"]]["height"],
                        "value": _pcn(src["value"]),
                        "scriptPubKey": dict(src["spk"]),
                    },
                    "sequence": i["sequence"],
                })
        vout = [{"n": o["n"], "value": _pcn(o["value"]),
                 "scriptPubKey": dict(o["spk"])} for o in t["vout"]]
        size = 150 + 100 * len(vin) + 40 * len(vout)
        return {"txid": t["txid"], "hash": _h("w", t["txid"]), "version": 2,
                "size": size, "vsize": size - 20, "weight": 4 * size - 80,
                "locktime": 0, "vin": vin, "vout": vout}


class FakeRpc:
    """Implements the slice of RpcClient the Indexer uses."""

    def __init__(self, chain):
        self.chain = chain
        self.call_count = 0
        self.calls = []

    def _dispatch(self, method, params):
        self.call_count += 1
        self.calls.append(method)
        if method == "getblockchaininfo":
            return self.chain.getblockchaininfo()
        if method == "getblockhash":
            try:
                return self.chain.getblockhash(params[0])
            except KeyError as exc:
                raise RpcError(-8, str(exc)) from exc
        if method == "getblock":
            try:
                return self.chain.getblock(params[0], params[1] if len(params) > 1 else 1)
            except KeyError as exc:
                raise RpcError(-5, str(exc)) from exc
        raise RpcError(-32601, "Method not found: %s" % method)

    def call(self, method, *params):
        return self._dispatch(method, list(params))

    def batch(self, calls, *, missing_codes=()):
        out = []
        for m, p in calls:
            try:
                out.append(self._dispatch(m, list(p)))
            except RpcError as exc:
                if exc.code in missing_codes:
                    out.append(None)
                else:
                    raise
        return out

    def blockchain_info(self):
        return self._dispatch("getblockchaininfo", [])

    def block_hash(self, height):
        return self._dispatch("getblockhash", [height])

    # The two helpers below mirror RpcClient exactly, including its "a block the
    # node no longer has on its active chain becomes None" rule. If the fake were
    # more forgiving than the real client the reorg tests would pass against a
    # client that cannot survive a live reorg.
    def block_hashes(self, heights):
        return self.batch([("getblockhash", [h]) for h in heights],
                          missing_codes=MISSING_BLOCK_CODES)

    def blocks_verbose(self, hashes, verbosity=3):
        if any(h is None for h in hashes):
            raise ValueError("blocks_verbose called with a missing hash")
        return self.batch([("getblock", [h, verbosity]) for h in hashes],
                          missing_codes=MISSING_BLOCK_CODES)
