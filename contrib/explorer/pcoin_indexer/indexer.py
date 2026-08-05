"""The PCoin address indexer.

Reads blocks over JSON-RPC with ``getblock <hash> 3`` and maintains a SQLite
address index. Never parses a block file, never needs the network magic, the
bech32 hrp, the base58 versions or RandomX -- an address is a plain string that
the node has already decoded.

Reorgs are the core feature, not an edge case. CLAUDE.md section 10.12: the live
seed reports 66 chain tips over ~2100 blocks, a ~3% stale rate, and LWMA at
height 2800 halves block spacing again. An indexer that mishandles a reorg
reports wrong balances forever and never notices.


INVARIANT I
-----------
    At every instant at which no transaction is open, `blocks` contains exactly
    the heights 0..T for some T >= -1, with one row per height, and for every
    h in 1..T:  blocks[h].prev_hash == blocks[h-1].hash.

Enforcement:
  * one row per height          -- `height` is the PRIMARY KEY (structural)
  * one row per hash            -- `hash` is UNIQUE            (structural)
  * contiguity + linkage        -- `_apply_locked` refuses any block whose
                                   height != T+1 or whose prev_hash != the hash
                                   at T; `_unwind_locked` refuses any height
                                   != T. Both run inside one BEGIN IMMEDIATE.

Claim: given I, the rows of `blocks` are the first T+1 blocks of a real chain
rooted at the node's genesis -- never a mixture of two branches.

Proof (induction on T).
  Base, T = 0: `_apply_locked` only accepts height 0 if its hash equals the
  genesis hash the node reported, which is checked once per sync against
  `getblockhash 0`. So blocks[0] is genesis.
  Step: assume blocks[0..T-1] is a genuine chain. A row is only added at height
  T, and only if its prev_hash equals blocks[T-1].hash. Block hashes are
  double-SHA256 of the header (CLAUDE.md section 3: PoW is RandomX but block
  *ids* are unchanged), so equality of prev_hash and hash means this block's
  header genuinely commits to that parent. Hence blocks[0..T] is a chain. []

Corollary (why per-block atomicity is enough, and better than one big
transaction): every single-block apply and every single-block unwind takes the
database from one state satisfying I to another state satisfying I. A crash --
or a WAL commit lost to a power cut under synchronous=NORMAL -- can therefore
only leave the index at *some* height whose contents are a valid chain prefix.
It can never leave a half-unwound mixture. On restart the sync loop re-derives
the fork point from the node and continues; a partially unwound index simply
gets unwound further. This is why `unwind_to` does not, and must not, wrap the
whole reorg in one transaction.
"""

import os
import time

from . import db
from .amounts import COIN, subsidy_sat, to_sat
from .db import IndexCorruption
from .rpc import MISSING_BLOCK_CODES, RpcError, RpcTransportError

COINBASE_MATURITY = 100          # src/consensus/consensus.h:19
HALVING_INTERVAL = 210_000       # chainparams: nSubsidyHalvingInterval

# nSubsidyHalvingInterval per network (src/kernel/chainparams.cpp). Regtest is
# 150, not 210000 -- with the mainnet number a regtest index would compute the
# wrong subsidy from height 150 and `verify` would report every later block as
# claiming more than subsidy+fees.
HALVING_INTERVAL_BY_CHAIN = {
    "main": 210_000, "test": 210_000, "testnet4": 210_000,
    "signet": 210_000, "regtest": 150,
}
MAX_SCRIPT_SIZE = 10_000         # script/script.h, for IsUnspendable()
ZERO_HASH = "0" * 64

DEFAULT_BATCH = 32               # blocks per RPC batch while syncing
MAX_REPOLLS = 16                 # node reorgs tolerated inside one sync_once


class ChainLinkError(RuntimeError):
    """The block offered does not extend the indexed tip. Means: reorg."""


class WrongChain(RuntimeError):
    """The node is not serving the chain this index was built from."""


# ---------------------------------------------------------------------------
# RPC shape -> plain Python, satoshis, no floats
# ---------------------------------------------------------------------------

def _is_unspendable(script_hex, script_type, height, is_coinbase):
    # CScript::IsUnspendable(): starts with OP_RETURN, or is oversized.
    if script_type == "nulldata":
        return True
    if script_hex[:2].lower() == "6a":
        return True
    if len(script_hex) // 2 > MAX_SCRIPT_SIZE:
        return True
    # The genesis coinbase is never added to the UTXO set (chainparams.cpp:62-64:
    # "the output of its generation transaction cannot be spent"). Counting it
    # would put the index 50 PCN above gettxoutsetinfo forever.
    if height == 0 and is_coinbase:
        return True
    return False


def normalize_block(raw, halving_interval=HALVING_INTERVAL):
    """Turn a `getblock <hash> 3` result into the rows we are going to store."""
    height = raw["height"]
    prev_hash = raw.get("previousblockhash")
    if height == 0:
        prev_hash = None
    elif not prev_hash:
        raise ValueError("block at height %d has no previousblockhash" % height)

    txs = []
    value_out = 0
    total_fees = 0
    coinbase_out = 0

    for index, t in enumerate(raw["tx"]):
        vin = t.get("vin") or []
        vout = t.get("vout") or []
        has_cb_field = bool(vin) and "coinbase" in vin[0]
        is_coinbase = index == 0
        if is_coinbase != has_cb_field:
            raise ValueError(
                "block %d tx %d: coinbase position/shape disagree (index=%d, "
                "coinbase field=%s)" % (height, index, index, has_cb_field))

        outs = []
        tx_out = 0
        for o in vout:
            spk = o.get("scriptPubKey") or {}
            script_hex = spk.get("hex", "")
            script_type = spk.get("type")
            address = spk.get("address")
            if address is None:
                # v29 emits "address"; be tolerant of the pre-22.0 "addresses" list.
                legacy = spk.get("addresses")
                if isinstance(legacy, list) and len(legacy) == 1:
                    address = legacy[0]
            value = to_sat(o["value"])
            tx_out += value
            outs.append({
                "n": o["n"],
                "value": value,
                "address": address,
                "script_type": script_type,
                "script_hex": script_hex,
                "unspendable": 1 if _is_unspendable(script_hex, script_type, height,
                                                    is_coinbase) else 0,
            })

        ins = []
        tx_in = 0
        if is_coinbase:
            src = vin[0]
            ins.append({
                "n": 0,
                "prev_txid": None,
                "prev_n": None,
                "value": None,
                "address": None,
                "script_type": None,
                "sequence": src.get("sequence", 0xFFFFFFFF),
                "coinbase_hex": src.get("coinbase"),
            })
            coinbase_out += tx_out
        else:
            for n, i in enumerate(vin):
                if "coinbase" in i:
                    raise ValueError("block %d tx %d: coinbase input outside tx 0"
                                     % (height, index))
                prevout = i.get("prevout")
                if prevout is None:
                    raise ValueError(
                        "block %d tx %s vin %d has no prevout. getblock verbosity 3 "
                        "needs undo data -- a pruned node cannot feed this indexer."
                        % (height, t["txid"], n))
                pspk = prevout.get("scriptPubKey") or {}
                paddr = pspk.get("address")
                if paddr is None:
                    legacy = pspk.get("addresses")
                    if isinstance(legacy, list) and len(legacy) == 1:
                        paddr = legacy[0]
                pvalue = to_sat(prevout["value"])
                tx_in += pvalue
                ins.append({
                    "n": n,
                    "prev_txid": i["txid"],
                    "prev_n": i["vout"],
                    "value": pvalue,
                    "address": paddr,
                    "script_type": pspk.get("type"),
                    "sequence": i.get("sequence", 0xFFFFFFFF),
                    "coinbase_hex": None,
                })

        fee = 0 if is_coinbase else tx_in - tx_out
        if not is_coinbase and fee < 0:
            raise ValueError("block %d tx %s: outputs exceed inputs by %d sat"
                             % (height, t["txid"], -fee))
        total_fees += fee
        value_out += tx_out

        txs.append({
            "txid": t["txid"],
            "wtxid": t.get("hash"),
            "block_index": index,
            "version": t.get("version", 1),
            "locktime": t.get("locktime", 0),
            "size": t.get("size"),
            "vsize": t.get("vsize"),
            "weight": t.get("weight"),
            "is_coinbase": 1 if is_coinbase else 0,
            "value_in": 0 if is_coinbase else tx_in,
            "value_out": tx_out,
            "fee": fee,
            "inputs": ins,
            "outputs": outs,
        })

    return {
        "height": height,
        "hash": raw["hash"],
        "prev_hash": prev_hash,
        "merkleroot": raw["merkleroot"],
        "version": raw["version"],
        "time": raw["time"],
        "mediantime": raw.get("mediantime", raw["time"]),
        "nonce": raw["nonce"],
        "bits": raw["bits"],
        "difficulty": float(raw["difficulty"]),
        "chainwork": raw["chainwork"],
        "size": raw["size"],
        "strippedsize": raw.get("strippedsize", raw["size"]),
        "weight": raw["weight"],
        "n_tx": raw.get("nTx", len(txs)),
        "value_out": value_out,
        "total_fees": total_fees,
        "subsidy": subsidy_sat(height, halving_interval),
        "coinbase_out": coinbase_out,
        "confirmations": raw.get("confirmations"),
        "txs": txs,
    }


# ---------------------------------------------------------------------------
# Indexer
# ---------------------------------------------------------------------------

class Indexer:
    def __init__(self, conn, rpc, *, genesis_hash=None, chain=None, log=None):
        self.conn = conn
        self.rpc = rpc
        self.genesis_hash = genesis_hash
        self.chain = chain
        self.halving_interval = HALVING_INTERVAL_BY_CHAIN.get(chain, HALVING_INTERVAL)
        self.log = log or (lambda msg: None)
        self.blocks_applied = 0
        self.blocks_unwound = 0
        self.reorgs = 0

    # -- tip ------------------------------------------------------------
    def tip(self):
        row = self.conn.execute(
            "SELECT height, hash FROM blocks ORDER BY height DESC LIMIT 1").fetchone()
        if row is None:
            return -1, None
        return row["height"], row["hash"]

    def tip_height(self):
        return self.tip()[0]

    def hash_at(self, height):
        row = self.conn.execute("SELECT hash FROM blocks WHERE height=?",
                                (height,)).fetchone()
        return row["hash"] if row else None

    # -- apply ----------------------------------------------------------
    def apply_block(self, blk):
        """Apply one block. One SQLite transaction, all or nothing."""
        self.conn.execute("BEGIN IMMEDIATE")
        try:
            self._apply_locked(blk)
        except BaseException:
            self.conn.execute("ROLLBACK")
            raise
        self.conn.execute("COMMIT")
        self.blocks_applied += 1

    def _apply_locked(self, blk):
        conn = self.conn
        height = blk["height"]
        tip_h, tip_hash = self.tip()

        # --- INVARIANT I is enforced here, and only here. -----------------
        if height != tip_h + 1:
            raise ChainLinkError("index tip is %d, refusing to apply height %d"
                                 % (tip_h, height))
        if height == 0:
            if self.genesis_hash and blk["hash"] != self.genesis_hash:
                raise WrongChain("node genesis %s != expected %s"
                                 % (blk["hash"], self.genesis_hash))
        elif blk["prev_hash"] != tip_hash:
            raise ChainLinkError(
                "block %s at height %d has parent %s but the index holds %s at %d"
                % (blk["hash"], height, blk["prev_hash"], tip_hash, tip_h))
        # ------------------------------------------------------------------

        conn.execute(
            "INSERT INTO blocks (height, hash, prev_hash, merkleroot, version, time,"
            " mediantime, nonce, bits, difficulty, chainwork, size, strippedsize,"
            " weight, n_tx, value_out, total_fees, subsidy, coinbase_out)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (height, blk["hash"], blk["prev_hash"], blk["merkleroot"], blk["version"],
             blk["time"], blk["mediantime"], blk["nonce"], blk["bits"],
             blk["difficulty"], blk["chainwork"], blk["size"], blk["strippedsize"],
             blk["weight"], blk["n_tx"], blk["value_out"], blk["total_fees"],
             blk["subsidy"], blk["coinbase_out"]))

        for tx in blk["txs"]:
            self._apply_tx(height, tx)

        conn.execute(
            "UPDATE sync_state SET indexed_height=?, indexed_hash=?, last_apply_ts=? "
            "WHERE id=1", (height, blk["hash"], int(time.time())))

    def _apply_tx(self, height, tx):
        conn = self.conn
        txid = tx["txid"]
        conn.execute(
            "INSERT INTO txs (txid, wtxid, height, block_index, version, locktime,"
            " size, vsize, weight, is_coinbase, n_in, n_out, value_in, value_out, fee)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (txid, tx["wtxid"], height, tx["block_index"], tx["version"],
             tx["locktime"], tx["size"], tx["vsize"], tx["weight"], tx["is_coinbase"],
             len(tx["inputs"]), len(tx["outputs"]), tx["value_in"], tx["value_out"],
             tx["fee"]))

        # deltas[address] = [received, sent, n_out, n_in]
        deltas = {}

        # Inputs first: an output created earlier in this same block may be spent
        # by a later tx in it, and the outputs row must already exist.
        for i in tx["inputs"]:
            if i["prev_txid"] is None:
                conn.execute(
                    "INSERT INTO inputs (txid, n, height, prev_txid, prev_n, value,"
                    " address, script_type, sequence, coinbase_hex)"
                    " VALUES (?,?,?,NULL,NULL,NULL,NULL,NULL,?,?)",
                    (txid, i["n"], height, i["sequence"], i["coinbase_hex"]))
                continue

            src = conn.execute(
                "SELECT value, address, script_type, spent_height FROM outputs"
                " WHERE txid=? AND n=?", (i["prev_txid"], i["prev_n"])).fetchone()
            if src is None:
                raise IndexCorruption(
                    "tx %s vin %d spends %s:%d which is not in the index"
                    % (txid, i["n"], i["prev_txid"], i["prev_n"]))
            if src["spent_height"] is not None:
                raise IndexCorruption(
                    "tx %s vin %d spends %s:%d which the index already records as "
                    "spent at height %s" % (txid, i["n"], i["prev_txid"], i["prev_n"],
                                            src["spent_height"]))
            # Cross-check our stored copy against the node's undo data. A
            # mismatch means the index and the node disagree about history.
            if src["value"] != i["value"] or src["address"] != i["address"]:
                raise IndexCorruption(
                    "prevout mismatch for %s:%d -- index has (%s, %s), node says "
                    "(%s, %s)" % (i["prev_txid"], i["prev_n"], src["value"],
                                  src["address"], i["value"], i["address"]))

            cur = conn.execute(
                "UPDATE outputs SET spent_by_txid=?, spent_by_n=?, spent_height=?"
                " WHERE txid=? AND n=? AND spent_height IS NULL",
                (txid, i["n"], height, i["prev_txid"], i["prev_n"]))
            if cur.rowcount != 1:
                raise IndexCorruption("failed to mark %s:%d spent"
                                      % (i["prev_txid"], i["prev_n"]))

            conn.execute(
                "INSERT INTO inputs (txid, n, height, prev_txid, prev_n, value,"
                " address, script_type, sequence, coinbase_hex)"
                " VALUES (?,?,?,?,?,?,?,?,?,NULL)",
                (txid, i["n"], height, i["prev_txid"], i["prev_n"], src["value"],
                 src["address"], src["script_type"], i["sequence"]))

            if src["address"] is not None:
                d = deltas.setdefault(src["address"], [0, 0, 0, 0])
                d[1] += src["value"]
                d[3] += 1

        is_cb = tx["is_coinbase"]
        maturity = height + COINBASE_MATURITY if is_cb else None
        for o in tx["outputs"]:
            conn.execute(
                "INSERT INTO outputs (txid, n, height, value, address, script_type,"
                " script_hex, is_coinbase, maturity_height, unspendable,"
                " spent_by_txid, spent_by_n, spent_height)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL)",
                (txid, o["n"], height, o["value"], o["address"], o["script_type"],
                 o["script_hex"], is_cb, maturity, o["unspendable"]))
            if o["address"] is not None and not o["unspendable"]:
                d = deltas.setdefault(o["address"], [0, 0, 0, 0])
                d[0] += o["value"]
                d[2] += 1

        for address, (recv, sent, n_out, n_in) in deltas.items():
            conn.execute(
                "INSERT INTO address_txs (address, txid, height, block_index,"
                " received, sent, n_out, n_in) VALUES (?,?,?,?,?,?,?,?)",
                (address, txid, height, tx["block_index"], recv, sent, n_out, n_in))
            conn.execute(
                "INSERT INTO addresses (address, balance, received, sent, utxo_count,"
                " tx_count, first_height, last_height) VALUES (?,?,?,?,?,1,?,?)"
                " ON CONFLICT(address) DO UPDATE SET"
                "   balance      = balance      + excluded.balance,"
                "   received     = received     + excluded.received,"
                "   sent         = sent         + excluded.sent,"
                "   utxo_count   = utxo_count   + excluded.utxo_count,"
                "   tx_count     = tx_count     + 1,"
                "   first_height = MIN(first_height, excluded.first_height),"
                "   last_height  = MAX(last_height,  excluded.last_height)",
                (address, recv - sent, recv, sent, n_out - n_in, height, height))

    # -- unwind ---------------------------------------------------------
    def unwind_block(self, height):
        """Undo exactly one block. One SQLite transaction, all or nothing."""
        self.conn.execute("BEGIN IMMEDIATE")
        try:
            self._unwind_locked(height)
        except BaseException:
            self.conn.execute("ROLLBACK")
            raise
        self.conn.execute("COMMIT")
        self.blocks_unwound += 1

    def _unwind_locked(self, height):
        conn = self.conn
        tip_h, _tip_hash = self.tip()
        if height != tip_h:
            raise ChainLinkError(
                "refusing to unwind height %d: the index tip is %d. Blocks must be "
                "unwound in strictly decreasing order or invariant I breaks."
                % (height, tip_h))

        blk = conn.execute("SELECT * FROM blocks WHERE height=?", (height,)).fetchone()
        if blk is None:
            raise IndexCorruption("no block row at height %d" % height)

        conn.execute(
            "INSERT OR REPLACE INTO orphaned_blocks (hash, height, prev_hash, time,"
            " n_tx, unwound_ts) VALUES (?,?,?,?,?,?)",
            (blk["hash"], height, blk["prev_hash"], blk["time"], blk["n_tx"],
             int(time.time())))

        # deltas[address] = [received, sent, utxo, tx_count]
        deltas = {}

        rows = conn.execute(
            "SELECT txid, block_index, is_coinbase FROM txs WHERE height=?"
            " ORDER BY block_index DESC", (height,)).fetchall()

        for trow in rows:
            txid = trow["txid"]

            # A tx later in this same block may spend this one's outputs; we are
            # walking block_index DESC and every higher block is already unwound,
            # so by now nothing of this tx can still be spent. Assert it: if this
            # ever fires, the ordering argument was wrong and the alternative is
            # silent balance corruption.
            stuck = conn.execute(
                "SELECT n, spent_by_txid, spent_height FROM outputs"
                " WHERE txid=? AND spent_height IS NOT NULL LIMIT 1",
                (txid,)).fetchone()
            if stuck is not None:
                raise IndexCorruption(
                    "unwinding height %d: output %s:%d is still marked spent by %s "
                    "at height %s" % (height, txid, stuck["n"], stuck["spent_by_txid"],
                                      stuck["spent_height"]))

            # Restore every prevout this tx consumed.
            for irow in conn.execute(
                    "SELECT n, prev_txid, prev_n FROM inputs WHERE txid=?"
                    " AND prev_txid IS NOT NULL ORDER BY n DESC", (txid,)).fetchall():
                cur = conn.execute(
                    "UPDATE outputs SET spent_by_txid=NULL, spent_by_n=NULL,"
                    " spent_height=NULL WHERE txid=? AND n=? AND spent_by_txid=?",
                    (irow["prev_txid"], irow["prev_n"], txid))
                if cur.rowcount != 1:
                    raise IndexCorruption(
                        "unwinding %s vin %d: %s:%d was not marked spent by it"
                        % (txid, irow["n"], irow["prev_txid"], irow["prev_n"]))

            # The recorded per-(address, tx) deltas are what apply added, so
            # subtracting them is an exact inverse by construction -- there is no
            # second, independently-derived arithmetic to drift from.
            for arow in conn.execute(
                    "SELECT address, received, sent, n_out, n_in FROM address_txs"
                    " WHERE txid=?", (txid,)).fetchall():
                d = deltas.setdefault(arow["address"], [0, 0, 0, 0])
                d[0] += arow["received"]
                d[1] += arow["sent"]
                d[2] += arow["n_out"] - arow["n_in"]
                d[3] += 1

            conn.execute("DELETE FROM address_txs WHERE txid=?", (txid,))
            conn.execute("DELETE FROM outputs WHERE txid=?", (txid,))
            conn.execute("DELETE FROM inputs WHERE txid=?", (txid,))
            conn.execute("DELETE FROM txs WHERE txid=?", (txid,))

        for address, (recv, sent, utxo, ntx) in deltas.items():
            conn.execute(
                "UPDATE addresses SET balance=balance-?, received=received-?,"
                " sent=sent-?, utxo_count=utxo_count-?, tx_count=tx_count-?"
                " WHERE address=?", (recv - sent, recv, sent, utxo, ntx, address))
        # first_height/last_height are MIN/MAX and cannot be inverted; recompute
        # them from address_txs, which is an index seek at both ends.
        for address in deltas:
            row = conn.execute(
                "SELECT MIN(height) AS lo, MAX(height) AS hi, COUNT(*) AS c"
                " FROM address_txs WHERE address=?", (address,)).fetchone()
            if row["c"] == 0:
                conn.execute("DELETE FROM addresses WHERE address=?", (address,))
            else:
                conn.execute(
                    "UPDATE addresses SET first_height=?, last_height=? WHERE address=?",
                    (row["lo"], row["hi"], address))

        conn.execute("DELETE FROM blocks WHERE height=?", (height,))

        new_h, new_hash = self.tip()
        # The counter is bumped inside this same transaction, not once at the
        # end of the reorg: `unwind_to` is deliberately not one transaction (see
        # the Corollary above), so a crash part-way through it would otherwise
        # leave `blocks_unwound` short by however many blocks had already been
        # committed. Here it can only ever be exact.
        conn.execute(
            "UPDATE sync_state SET indexed_height=?, indexed_hash=?,"
            " blocks_unwound=blocks_unwound+1 WHERE id=1",
            (new_h, new_hash))

    def unwind_to(self, fork_height):
        """Unwind down to (and keeping) `fork_height`. Each block is its own
        transaction -- see the Corollary in the module docstring."""
        count = 0
        while True:
            tip_h, _ = self.tip()
            if tip_h <= fork_height:
                return count
            self.unwind_block(tip_h)
            count += 1

    # -- fork detection -------------------------------------------------
    def _node_hash_at(self, height):
        """The node's active-chain hash at `height`, or None if it has no block
        there right now.

        Only -8 ("Block height out of range") is read as None. Every other error
        propagates: CLAUDE.md 7.1/7.2 -- an RPC that failed resolves nothing, and
        here "resolves nothing" turned into "the hashes differ" would unwind the
        index off a perfectly good chain.
        """
        try:
            return self.rpc.block_hash(height)
        except RpcError as exc:
            if exc.code in MISSING_BLOCK_CODES:
                return None
            raise

    def _matches(self, height):
        ours = self.hash_at(height)
        if ours is None:
            return False
        return ours == self._node_hash_at(height)

    def find_fork(self, node_height):
        """Highest height h <= min(indexed tip, node_height) at which the index
        and the node agree. -1 if they agree nowhere (index must be wiped).

        Exponential probe down from the tip, then a binary search, so a deep
        reorg costs O(log depth) RPC calls instead of O(depth)."""
        hi = min(self.tip_height(), node_height)
        if hi < 0:
            return -1
        if self._matches(hi):
            return hi
        bad = hi
        step = 1
        while True:
            probe = hi - step
            if probe < 0:
                probe = 0
            if self._matches(probe):
                good = probe
                break
            bad = probe
            if probe == 0:
                return -1
            step *= 2
        # good matches, bad does not, good < bad
        lo, hi2 = good, bad
        while hi2 - lo > 1:
            mid = (lo + hi2) // 2
            if self._matches(mid):
                lo = mid
            else:
                hi2 = mid
        return lo

    def handle_reorg(self, node_height, detail=""):
        """Unwind to the fork point, with an audit trail that survives a crash.

        The trail is opened *before* the unwind and completed after it. Writing
        it only afterwards -- which is what this used to do -- meant a crash
        part-way through `unwind_to` lost the record permanently: the balances
        were still correct (every per-block unwind is its own transaction, and a
        resumed index is row-for-row identical to a from-scratch reindex), but
        `reorg_count` silently under-counted, and an under-counting monitor
        reads as a quiet chain. Now `reorg_count` is committed before any block
        moves, `blocks_unwound` is committed per block, and an interrupted reorg
        is visible as a `reorg_log` row with a NULL `new_tip_height`.
        """
        old_h, old_hash = self.tip()
        fork = self.find_fork(node_height)
        db.set_state(self.conn, status=db.STATUS_REORG,
                     status_detail="unwinding %d..%d (fork at %d)"
                                   % (old_h, fork + 1, fork))
        self.log("reorg: index tip %d (%s) diverges; fork at %d, unwinding %d block(s)"
                 % (old_h, (old_hash or "-")[:16], fork, old_h - fork))

        self.conn.execute("BEGIN IMMEDIATE")
        try:
            cur = self.conn.execute(
                "INSERT INTO reorg_log (ts, fork_height, old_tip_height, old_tip_hash,"
                " new_tip_height, new_tip_hash, blocks_unwound, detail)"
                " VALUES (?,?,?,?,NULL,NULL,?,?)",
                (int(time.time()), fork, old_h, old_hash, old_h - fork,
                 "%sunwind started" % (detail + " -- " if detail else "")))
            log_id = cur.lastrowid
            self.conn.execute(
                "UPDATE sync_state SET reorg_count=reorg_count+1 WHERE id=1")
        except BaseException:
            self.conn.execute("ROLLBACK")
            raise
        self.conn.execute("COMMIT")

        n = self.unwind_to(fork)
        self.reorgs += 1
        new_h, new_hash = self.tip()
        self.conn.execute("BEGIN IMMEDIATE")
        try:
            self.conn.execute(
                "UPDATE reorg_log SET new_tip_height=?, new_tip_hash=?,"
                " blocks_unwound=?, detail=? WHERE id=?",
                (new_h, new_hash, n, detail, log_id))
        except BaseException:
            self.conn.execute("ROLLBACK")
            raise
        self.conn.execute("COMMIT")
        return fork, n

    # -- sync -----------------------------------------------------------
    def poll_node(self):
        """Observe the node. On success updates the node_* marker; on failure
        marks status=error and leaves the previous observation alone."""
        try:
            info = self.rpc.blockchain_info()
        except (RpcTransportError, RpcError) as exc:
            self._set_state_committed(status=db.STATUS_ERROR,
                                      status_detail="node poll failed: %s" % exc)
            raise
        if info.get("chain") and info["chain"] != self.chain:
            self.chain = info["chain"]
            self.halving_interval = HALVING_INTERVAL_BY_CHAIN.get(
                self.chain, HALVING_INTERVAL)
        if self.genesis_hash is None:
            self.genesis_hash = self.rpc.block_hash(0)
        stored = db.get_state(self.conn) or {}
        if stored.get("genesis_hash") and stored["genesis_hash"] != self.genesis_hash:
            raise WrongChain(
                "this index was built on genesis %s, the node serves %s"
                % (stored["genesis_hash"], self.genesis_hash))
        fields = dict(
            chain=info.get("chain"), genesis_hash=self.genesis_hash,
            node_height=info["blocks"], node_hash=info["bestblockhash"],
            node_headers=info.get("headers"),
            node_ibd=1 if info.get("initialblockdownload") else 0,
            last_poll_ts=int(time.time()))
        connections = self._peer_count()
        if connections is not None:
            fields["node_connections"] = connections
        self._set_state_committed(**fields)
        return info

    def _peer_count(self):
        """`getnetworkinfo.connections`, or None.

        A node with zero peers keeps answering `getblockchaininfo` with whatever
        tip it last had, so an index that only watches the height stays level
        with it and reports a stalled chain as healthy. This is the observation
        that makes that visible on a UI which deliberately never talks to a node.

        A failure returns None and the previous observation is left alone: an
        RPC that failed resolves nothing (CLAUDE.md 7.1), and writing 0 here
        would raise a false alarm rather than clear a real one.
        """
        try:
            info = self.rpc.call("getnetworkinfo")
        except (RpcTransportError, RpcError):
            return None
        value = info.get("connections") if isinstance(info, dict) else None
        return None if value is None else int(value)

    def _set_state_committed(self, **fields):
        self.conn.execute("BEGIN IMMEDIATE")
        try:
            db.set_state(self.conn, **fields)
        except BaseException:
            self.conn.execute("ROLLBACK")
            raise
        self.conn.execute("COMMIT")

    def sync_once(self, *, batch=DEFAULT_BATCH, max_blocks=None, progress=None):
        """One poll, then advance the index to the tip the node just reported.

        Returns a stats dict. Safe to call in a loop; safe to kill at any point.
        """
        info = self.poll_node()
        node_height = info["blocks"]
        node_hash = info["bestblockhash"]
        applied = unwound = reorgs = 0
        repolls = 0
        started = time.monotonic()

        while True:
            tip_h, tip_hash = self.tip()
            if tip_h == node_height and tip_hash == node_hash:
                break
            if max_blocks is not None and applied >= max_blocks:
                break
            if repolls > MAX_REPOLLS:
                # The node has reorged out from under us this many times inside
                # one call. Stop and let the caller come back; spinning here
                # would starve the status marker of updates.
                break

            if tip_h >= node_height:
                # We are as long as (or longer than) the node and disagree:
                # the only explanation is a reorg.
                _fork, n = self.handle_reorg(node_height, detail="index >= node tip")
                unwound += n
                reorgs += 1
                if n == 0:
                    # Nothing to unwind and still disagreeing -> the node moved
                    # under us. Re-poll on the next call rather than spin.
                    break
                continue

            want_hi = min(node_height, tip_h + batch)
            if max_blocks is not None:
                want_hi = min(want_hi, tip_h + (max_blocks - applied))
            heights = list(range(tip_h + 1, want_hi + 1))
            hashes = self.rpc.block_hashes(heights)
            if any(h is None for h in hashes):
                # The node reorged to something shorter between the poll and
                # this fetch. Re-observe rather than reason from a stale tip.
                info = self.poll_node()
                node_height, node_hash = info["blocks"], info["bestblockhash"]
                repolls += 1
                continue
            raws = self.rpc.blocks_verbose(hashes, 3)

            restart = False
            repoll = False
            for raw in raws:
                if raw is None or (raw.get("confirmations") is not None
                                   and raw["confirmations"] < 0):
                    # The node reorged between getblockhash and getblock: the
                    # block is gone, or is still known but no longer on the
                    # active chain (Core reports confirmations = -1 for those).
                    repoll = True
                    break
                blk = normalize_block(raw, self.halving_interval)
                try:
                    self.apply_block(blk)
                except ChainLinkError as exc:
                    _fork, n = self.handle_reorg(node_height, detail=str(exc))
                    unwound += n
                    reorgs += 1
                    restart = True
                    break
                applied += 1
                if progress is not None:
                    progress(blk["height"], node_height)
            if repoll:
                info = self.poll_node()
                node_height, node_hash = info["blocks"], info["bestblockhash"]
                repolls += 1
                continue
            if restart:
                continue

        tip_h, tip_hash = self.tip()
        caught_up = (tip_h == node_height and tip_hash == node_hash)
        if caught_up:
            detail = None
        elif node_height > tip_h:
            detail = "behind by %d" % (node_height - tip_h)
        else:
            # Not behind -- diverged. Saying "behind by -3" here would be the
            # marker lying about which of the two states it is in.
            detail = ("diverged: index at %d, last observed node tip %d (%s)"
                      % (tip_h, node_height, (node_hash or "-")[:16]))
        self._set_state_committed(
            status=db.STATUS_OK if caught_up else db.STATUS_SYNCING,
            status_detail=detail, indexed_height=tip_h, indexed_hash=tip_hash)
        return {
            "applied": applied, "unwound": unwound, "reorgs": reorgs,
            "indexed_height": tip_h, "node_height": node_height,
            "caught_up": caught_up, "seconds": time.monotonic() - started,
        }

    def sync(self, *, batch=DEFAULT_BATCH, progress=None, max_rounds=64):
        """Poll-and-advance until the index matches a freshly observed node tip."""
        totals = {"applied": 0, "unwound": 0, "reorgs": 0, "rounds": 0}
        for _ in range(max_rounds):
            stats = self.sync_once(batch=batch, progress=progress)
            totals["applied"] += stats["applied"]
            totals["unwound"] += stats["unwound"]
            totals["reorgs"] += stats["reorgs"]
            totals["rounds"] += 1
            totals.update({k: stats[k] for k in
                           ("indexed_height", "node_height", "caught_up")})
            if stats["caught_up"]:
                break
            if stats["applied"] == 0 and stats["unwound"] == 0:
                break
        return totals


# ---------------------------------------------------------------------------
# Reindex from scratch
# ---------------------------------------------------------------------------

def reindex(db_path, rpc, *, batch=DEFAULT_BATCH, log=None, progress=None,
            in_place=False):
    """Rebuild the index from genesis.

    Not in place by default: the new index is built in `<db>.reindex` with the
    journal off (losing that file is a supported outcome -- we just start over)
    and moved over the live file only once it is complete. An API reading the
    old file therefore never sees a half-built index, and never has to be told
    to distrust one.
    """
    log = log or (lambda m: None)
    target = db_path if in_place else db_path + ".reindex"
    for suffix in ("", "-wal", "-shm", "-journal"):
        try:
            os.remove(target + suffix)
        except OSError:
            pass

    conn = db.connect(target, bulk=not in_place)
    try:
        if in_place:
            conn.executescript(
                "PRAGMA foreign_keys=OFF;"
                "DROP TABLE IF EXISTS address_txs;"
                "DROP TABLE IF EXISTS addresses;"
                "DROP TABLE IF EXISTS inputs;"
                "DROP TABLE IF EXISTS outputs;"
                "DROP TABLE IF EXISTS txs;"
                "DROP TABLE IF EXISTS blocks;"
                "DROP TABLE IF EXISTS sync_state;"
                "DROP TABLE IF EXISTS reorg_log;"
                "DROP TABLE IF EXISTS orphaned_blocks;")
        db.init_schema(conn)
        idx = Indexer(conn, rpc, log=log)
        db.set_state(conn, status=db.STATUS_REINDEX)
        stats = idx.sync(batch=batch, progress=progress)
        conn.execute("PRAGMA optimize")
        conn.execute("ANALYZE")
    finally:
        conn.close()

    if not in_place:
        for suffix in ("-wal", "-shm", "-journal"):
            try:
                os.remove(db_path + suffix)
            except OSError:
                pass
        os.replace(target, db_path)
        log("reindex complete, moved %s -> %s" % (target, db_path))
    return stats


# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------

def verify(conn, *, deep=True):
    """Recompute everything derivable and report disagreements.

    This is the safety net behind the incremental rollups: `addresses` is a
    cache of `outputs`/`address_txs`, and this rebuilds it independently and
    diffs. Cheap on this chain; run it after any reorg you care about.
    """
    problems = []

    # -- invariant I ---------------------------------------------------
    row = conn.execute("SELECT COUNT(*) c, MIN(height) lo, MAX(height) hi"
                       " FROM blocks").fetchone()
    if row["c"]:
        if row["lo"] != 0:
            problems.append("blocks do not start at height 0 (lowest is %d)" % row["lo"])
        if row["hi"] - row["lo"] + 1 != row["c"]:
            problems.append("blocks are not contiguous: %d rows spanning %d..%d"
                            % (row["c"], row["lo"], row["hi"]))
        broken = conn.execute(
            "SELECT b.height FROM blocks b JOIN blocks p ON p.height = b.height - 1"
            " WHERE b.prev_hash IS NOT p.hash LIMIT 5").fetchall()
        for b in broken:
            problems.append("block %d does not link to its parent" % b["height"])
        orphan_link = conn.execute(
            "SELECT height FROM blocks WHERE height > 0 AND prev_hash IS NULL"
        ).fetchall()
        for b in orphan_link:
            problems.append("block %d has no prev_hash" % b["height"])

    # -- sync_state mirror --------------------------------------------
    st = db.get_state(conn) or {}
    tip = conn.execute("SELECT height, hash FROM blocks ORDER BY height DESC"
                       " LIMIT 1").fetchone()
    tip_h = tip["height"] if tip else -1
    tip_hash = tip["hash"] if tip else None
    if st.get("indexed_height") != tip_h or st.get("indexed_hash") != tip_hash:
        problems.append("sync_state says tip %s/%s, blocks says %s/%s"
                        % (st.get("indexed_height"), st.get("indexed_hash"),
                           tip_h, tip_hash))

    # -- referential sanity -------------------------------------------
    for sql, msg in (
        ("SELECT COUNT(*) c FROM txs WHERE height NOT IN (SELECT height FROM blocks)",
         "%d tx rows reference a missing block"),
        ("SELECT COUNT(*) c FROM outputs WHERE txid NOT IN (SELECT txid FROM txs)",
         "%d output rows reference a missing tx"),
        ("SELECT COUNT(*) c FROM inputs WHERE txid NOT IN (SELECT txid FROM txs)",
         "%d input rows reference a missing tx"),
        ("SELECT COUNT(*) c FROM outputs WHERE spent_by_txid IS NOT NULL"
         " AND spent_by_txid NOT IN (SELECT txid FROM txs)",
         "%d outputs are marked spent by a tx that is not indexed"),
        ("SELECT COUNT(*) c FROM outputs WHERE (spent_height IS NULL)"
         " != (spent_by_txid IS NULL)",
         "%d outputs have spent_height and spent_by_txid disagreeing"),
        ("SELECT COUNT(*) c FROM address_txs WHERE txid NOT IN (SELECT txid FROM txs)",
         "%d address_txs rows reference a missing tx"),
    ):
        c = conn.execute(sql).fetchone()["c"]
        if c:
            problems.append(msg % c)

    # every non-coinbase input must correspond to an output marked spent by it
    c = conn.execute(
        "SELECT COUNT(*) c FROM inputs i LEFT JOIN outputs o"
        " ON o.txid=i.prev_txid AND o.n=i.prev_n"
        " WHERE i.prev_txid IS NOT NULL"
        "   AND (o.txid IS NULL OR o.spent_by_txid IS NOT i.txid"
        "        OR o.spent_by_n IS NOT i.n)").fetchone()["c"]
    if c:
        problems.append("%d inputs are not matched by a spent output" % c)

    if not deep:
        return problems

    # -- rollup cache vs a fresh recompute ----------------------------
    recomputed = {}
    for r in conn.execute(
            "SELECT address, SUM(received) rec, SUM(sent) snt, COUNT(*) txc,"
            " SUM(n_out - n_in) utxo, MIN(height) lo, MAX(height) hi"
            " FROM address_txs GROUP BY address"):
        recomputed[r["address"]] = (r["rec"] - r["snt"], r["rec"], r["snt"],
                                    r["utxo"], r["txc"], r["lo"], r["hi"])
    stored = {}
    for r in conn.execute("SELECT * FROM addresses"):
        stored[r["address"]] = (r["balance"], r["received"], r["sent"],
                                r["utxo_count"], r["tx_count"], r["first_height"],
                                r["last_height"])
    for a in set(stored) | set(recomputed):
        if stored.get(a) != recomputed.get(a):
            problems.append("addresses row for %s is %r, recompute says %r"
                            % (a, stored.get(a), recomputed.get(a)))
            if len(problems) > 50:
                problems.append("... further address mismatches suppressed")
                break

    # -- balance vs the live UTXO rows (fully independent of address_txs) --
    mismatch = conn.execute(
        "SELECT COUNT(*) c FROM ("
        "  SELECT a.address, a.balance, a.utxo_count,"
        "         COALESCE(u.v, 0) v, COALESCE(u.n, 0) n"
        "  FROM addresses a LEFT JOIN ("
        "    SELECT address, SUM(value) v, COUNT(*) n FROM outputs"
        "    WHERE spent_height IS NULL AND unspendable=0 AND address IS NOT NULL"
        "    GROUP BY address) u ON u.address = a.address"
        "  WHERE a.balance != COALESCE(u.v,0) OR a.utxo_count != COALESCE(u.n,0))"
    ).fetchone()["c"]
    if mismatch:
        problems.append("%d addresses whose cached balance/utxo_count disagrees with "
                        "the unspent outputs table" % mismatch)

    # -- block-level economics ----------------------------------------
    bad = conn.execute(
        "SELECT height, coinbase_out, subsidy, total_fees FROM blocks"
        " WHERE coinbase_out > subsidy + total_fees LIMIT 5").fetchall()
    for b in bad:
        problems.append("block %d claims %d sat but subsidy+fees is %d"
                        % (b["height"], b["coinbase_out"], b["subsidy"] + b["total_fees"]))

    bad = conn.execute(
        "SELECT t.txid FROM txs t WHERE t.is_coinbase=0 AND t.fee !="
        " (t.value_in - t.value_out) LIMIT 5").fetchall()
    for b in bad:
        problems.append("tx %s fee does not equal value_in - value_out" % b["txid"])

    return problems


def supply_sat(conn):
    """Total spendable supply implied by the index (comparable, modulo the
    genesis coinbase, with `gettxoutsetinfo`.total_amount)."""
    row = conn.execute(
        "SELECT COALESCE(SUM(value),0) v, COUNT(*) n FROM outputs"
        " WHERE spent_height IS NULL AND unspendable=0").fetchone()
    return row["v"], row["n"]
