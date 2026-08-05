"""Read-side helpers. This is the surface the HTTP API will sit on.

Nothing here writes, and nothing here derives an address, holds a key or signs
anything -- the API is non-custodial. Clients derive their own addresses from
their own twelve words (BIP84, m/84'/9444'/0'/0/i) and this module answers
questions about the chain.

Every balance-shaped answer carries the health block from `health()`. A caller
that renders a balance without checking `health()["stale"]` is the failure mode
requirement 5 exists to prevent.
"""

import time

from .indexer import COINBASE_MATURITY

# How long an index may go without a successful node poll before its answers
# are labelled stale, regardless of how far behind it is. The chain targets
# 600 s and currently runs at ~1100 s, so 5 minutes is well inside one block.
DEFAULT_MAX_POLL_AGE = 300

_DECIMAL = frozenset("0123456789")
# Above this a Python int cannot be bound to a SQLite INTEGER; sqlite3 raises
# OverflowError. Every place that turns caller text into a height is bounded.
MAX_HEIGHT = 2 ** 62


def _row(r):
    return dict(r) if r is not None else None


def is_decimal(text):
    """Strict ASCII digits.

    Not ``str.isdigit()``: that is True for '2' (superscript two) and for
    Arabic-Indic digits, while ``int()`` raises on both. These helpers take
    caller-supplied text, so the test that decides "this is a height" has to be
    exact rather than merely Unicode-numeric.
    """
    return bool(text) and all(c in _DECIMAL for c in text)


def tip_height(conn):
    r = conn.execute("SELECT MAX(height) h FROM blocks").fetchone()
    return -1 if r is None or r["h"] is None else r["h"]


def health(conn, *, max_poll_age=DEFAULT_MAX_POLL_AGE, now=None):
    """How far behind the chain the index is, and whether it may be trusted."""
    now = int(time.time()) if now is None else now
    st = _row(conn.execute("SELECT * FROM sync_state WHERE id=1").fetchone()) or {}
    indexed = tip_height(conn)
    node = st.get("node_height")
    behind = None if node is None else node - indexed
    poll_age = None if st.get("last_poll_ts") is None else now - st["last_poll_ts"]
    reasons = []
    if node is None:
        reasons.append("the node has never been polled successfully")
    if behind:
        reasons.append("index is %d block(s) behind the last observed node tip" % behind)
    if poll_age is None or poll_age > max_poll_age:
        reasons.append("last successful node poll was %s"
                       % ("never" if poll_age is None else "%ds ago" % poll_age))
    if st.get("status") in ("error", "reorg", "reindex", "init"):
        reasons.append("indexer status is %r (%s)"
                       % (st.get("status"), st.get("status_detail")))
    # An index that is level with its node looks perfectly healthy by every
    # measure above -- and is wrong whenever the node itself is not on the
    # chain. The two ways that happens are recorded at poll time, because the
    # web UI deliberately never talks to a node and the index is its only
    # possible source for either. Both are "unknown" when absent (an older
    # index, or a node that did not answer), and unknown adds no reason.
    if st.get("node_ibd"):
        reasons.append("the node was still in initial block download at the "
                       "last poll, so its tip is not known to be the chain tip")
    if st.get("node_connections") == 0:
        reasons.append("the node had no peers at the last poll, so its tip may "
                       "be stale or on a branch nobody else is building on")
    return {
        "chain": st.get("chain"),
        "status": st.get("status"),
        "status_detail": st.get("status_detail"),
        "indexed_height": indexed,
        "indexed_hash": st.get("indexed_hash"),
        "node_height": node,
        "node_hash": st.get("node_hash"),
        "node_headers": st.get("node_headers"),
        "node_ibd": st.get("node_ibd"),
        "node_connections": st.get("node_connections"),
        "blocks_behind": behind,
        "last_poll_age_seconds": poll_age,
        "reorg_count": st.get("reorg_count"),
        "blocks_unwound": st.get("blocks_unwound"),
        "stale": bool(reasons),
        "stale_reasons": reasons,
    }


def address_summary(conn, address, *, maturity=COINBASE_MATURITY, with_health=True):
    tip = tip_height(conn)
    next_height = tip + 1
    a = _row(conn.execute("SELECT * FROM addresses WHERE address=?",
                          (address,)).fetchone())
    immature = conn.execute(
        "SELECT COALESCE(SUM(value),0) v, COUNT(*) n FROM outputs"
        " WHERE address=? AND spent_height IS NULL AND is_coinbase=1"
        "   AND unspendable=0 AND maturity_height > ?",
        (address, next_height)).fetchone()
    if a is None:
        a = {"address": address, "balance": 0, "received": 0, "sent": 0,
             "utxo_count": 0, "tx_count": 0, "first_height": None,
             "last_height": None}
    a = dict(a)
    a["immature"] = immature["v"]
    a["immature_utxo_count"] = immature["n"]
    # `balance` counts every unspent output. Spendable is what a wallet may
    # actually build a transaction from right now: a coinbase is spendable in
    # the block at `maturity_height`, i.e. once it has `maturity` confirmations.
    a["spendable"] = a["balance"] - immature["v"]
    a["maturity"] = maturity
    a["as_of_height"] = tip
    # `with_health=False` is for a caller that already has the health block and
    # is asking about many addresses in one request: it is the same answer for
    # every one of them, and recomputing it per address is pure waste. The
    # default stays True so no existing caller silently loses its staleness
    # check -- rendering a balance without it is the failure this exists to stop.
    if with_health:
        a["health"] = health(conn)
    return a


def address_utxos(conn, address, *, limit=1000, offset=0, mature_only=False):
    tip = tip_height(conn)
    sql = ("SELECT o.txid, o.n, o.value, o.height, o.is_coinbase, o.maturity_height,"
           " o.script_hex, o.script_type, b.time AS block_time, b.hash AS block_hash"
           " FROM outputs o JOIN blocks b ON b.height = o.height"
           " WHERE o.address=? AND o.spent_height IS NULL AND o.unspendable=0")
    params = [address]
    if mature_only:
        sql += " AND (o.is_coinbase=0 OR o.maturity_height <= ?)"
        params.append(tip + 1)
    sql += " ORDER BY o.height DESC, o.n ASC LIMIT ? OFFSET ?"
    params += [limit, offset]
    out = []
    for r in conn.execute(sql, params):
        d = dict(r)
        d["confirmations"] = tip - d["height"] + 1
        d["mature"] = (not d["is_coinbase"]) or d["maturity_height"] <= tip + 1
        out.append(d)
    return out


def address_history(conn, address, *, limit=50, offset=0):
    tip = tip_height(conn)
    rows = conn.execute(
        "SELECT at.txid, at.height, at.block_index, at.received, at.sent,"
        " b.time AS block_time, b.hash AS block_hash"
        " FROM address_txs at JOIN blocks b ON b.height = at.height"
        " WHERE at.address=?"
        " ORDER BY at.height DESC, at.block_index DESC LIMIT ? OFFSET ?",
        (address, limit, offset)).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["net"] = d["received"] - d["sent"]
        d["confirmations"] = tip - d["height"] + 1
        out.append(d)
    return out


def transaction(conn, txid):
    """Everything about one transaction, including each input's source address
    and amount, its fee, and its confirmation state."""
    t = _row(conn.execute("SELECT * FROM txs WHERE txid=?", (txid,)).fetchone())
    if t is None:
        return None
    tip = tip_height(conn)
    b = _row(conn.execute("SELECT * FROM blocks WHERE height=?",
                          (t["height"],)).fetchone())
    t["confirmations"] = tip - t["height"] + 1
    t["block_hash"] = b["hash"] if b else None
    t["block_time"] = b["time"] if b else None
    t["block_mediantime"] = b["mediantime"] if b else None
    t["fee_rate_sat_vb"] = (t["fee"] / t["vsize"]) if t["vsize"] else None
    t["inputs"] = [dict(r) for r in conn.execute(
        "SELECT n, prev_txid, prev_n, value, address, script_type, sequence,"
        " coinbase_hex FROM inputs WHERE txid=? ORDER BY n", (txid,))]
    outs = []
    for r in conn.execute(
            "SELECT n, value, address, script_type, script_hex, is_coinbase,"
            " maturity_height, unspendable, spent_by_txid, spent_by_n, spent_height"
            " FROM outputs WHERE txid=? ORDER BY n", (txid,)):
        d = dict(r)
        d["spent"] = d["spent_height"] is not None
        d["mature"] = (not d["is_coinbase"]) or d["maturity_height"] <= tip + 1
        outs.append(d)
    t["outputs"] = outs
    if t["is_coinbase"]:
        t["spendable_from_height"] = t["height"] + COINBASE_MATURITY
    t["health"] = health(conn)
    return t


def block(conn, ident, *, with_txids=True):
    """`ident` may be a height (int or numeric string) or a block hash."""
    if isinstance(ident, int) or (isinstance(ident, str) and is_decimal(ident)):
        if int(ident) > MAX_HEIGHT:
            return None
        b = conn.execute("SELECT * FROM blocks WHERE height=?", (int(ident),)).fetchone()
    else:
        b = conn.execute("SELECT * FROM blocks WHERE hash=?", (ident,)).fetchone()
    if b is None:
        o = _row(conn.execute("SELECT * FROM orphaned_blocks WHERE hash=?",
                              (ident,)).fetchone())
        if o is not None:
            o["orphaned"] = True
            return o
        return None
    d = dict(b)
    tip = tip_height(conn)
    d["confirmations"] = tip - d["height"] + 1
    d["orphaned"] = False
    nxt = conn.execute("SELECT hash FROM blocks WHERE height=?",
                       (d["height"] + 1,)).fetchone()
    d["next_hash"] = nxt["hash"] if nxt else None
    if with_txids:
        d["txids"] = [r["txid"] for r in conn.execute(
            "SELECT txid FROM txs WHERE height=? ORDER BY block_index",
            (d["height"],))]
    return d


def recent_blocks(conn, limit=25):
    return [dict(r) for r in conn.execute(
        "SELECT height, hash, time, n_tx, size, difficulty, total_fees, subsidy"
        " FROM blocks ORDER BY height DESC LIMIT ?", (limit,))]


def rich_list(conn, limit=100):
    return [dict(r) for r in conn.execute(
        "SELECT address, balance, received, sent, tx_count, utxo_count"
        " FROM addresses WHERE balance > 0 ORDER BY balance DESC LIMIT ?", (limit,))]


def search(conn, term):
    """One box, three answer shapes: block, transaction, address."""
    term = (term or "").strip()
    if not term:
        return None
    if is_decimal(term):
        b = block(conn, term)
        if b:
            return {"kind": "block", "result": b}
    if len(term) == 64 and all(c in "0123456789abcdefABCDEF" for c in term):
        term_l = term.lower()
        t = transaction(conn, term_l)
        if t:
            return {"kind": "tx", "result": t}
        b = block(conn, term_l)
        if b:
            return {"kind": "block", "result": b}
        return None
    r = conn.execute("SELECT 1 FROM addresses WHERE address=?", (term,)).fetchone()
    if r or conn.execute("SELECT 1 FROM outputs WHERE address=? LIMIT 1",
                         (term,)).fetchone():
        return {"kind": "address", "result": address_summary(conn, term)}
    return None


def chain_stats(conn):
    tip = tip_height(conn)
    b = _row(conn.execute("SELECT * FROM blocks WHERE height=?", (tip,)).fetchone())
    agg = conn.execute(
        "SELECT COUNT(*) txs, SUM(is_coinbase) coinbases FROM txs").fetchone()
    utxo = conn.execute(
        "SELECT COUNT(*) n, COALESCE(SUM(value),0) v FROM outputs"
        " WHERE spent_height IS NULL AND unspendable=0").fetchone()
    addrs = conn.execute(
        "SELECT COUNT(*) n FROM addresses WHERE balance > 0").fetchone()
    return {
        "height": tip,
        "best_hash": b["hash"] if b else None,
        "block_time": b["time"] if b else None,
        "difficulty": b["difficulty"] if b else None,
        "tx_count": agg["txs"],
        "coinbase_count": agg["coinbases"],
        "non_coinbase_count": (agg["txs"] or 0) - (agg["coinbases"] or 0),
        "utxo_count": utxo["n"],
        "supply_sat": utxo["v"],
        "addresses_with_balance": addrs["n"],
        "health": health(conn),
    }
