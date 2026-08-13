"""Read-only queries the web UI needs on top of ``pcoin_indexer.queries``.

Everything here is additive and read-only. ``pcoin_indexer.queries`` is the
indexer's verified read surface and is deliberately not modified; this module
adds the list/pagination/metric shapes a browsable explorer needs and reuses
that module for every balance-shaped answer.

Every query is parameterised. Nothing here builds SQL from request input except
the ``IN (?,?,...)`` placeholder runs, whose *count* comes from a list this
module built itself.
"""

from pcoin_indexer import queries

# src/kernel/chainparams.cpp:120 (main), :254, :338, :454 (testnets), :533
# (regtest, std::numeric_limits<int>::max(), i.e. never). LWMA retargets every
# block from this height; below it the chain runs the deliberately-broken
# legacy retarget (CLAUDE.md 7.4).
LWMA_HEIGHT = {"main": 2800, "test": 1, "testnet4": 1, "signet": 1,
               "regtest": None}

# Consensus target spacing, src/kernel/chainparams.cpp (nPowTargetSpacing).
TARGET_SPACING = 600

# Windows used for the pace/hashrate panel, in blocks.
#
# These are deliberately short. A longer window is not "more data" on this
# chain, it is *different* data: heights 0..2015 were mined at the minimum
# difficulty roughly 49 s apart and everything from 2016 on is roughly 20x
# slower, because the legacy retarget only fires every 2016 blocks. Measured
# at height 2129 the mean spacing comes out at 1066 s over 100 blocks, 672 s
# over 200 and 272 s over 500 -- the long windows are averaging two different
# chains together and would report the chain as running *faster* than its
# target when it is running about 1.8x slower. RECENT_WINDOW is the headline
# figure and every window shown is labelled with its own length.
PACE_WINDOWS = (10, 50, 100)
RECENT_WINDOW = 100
HASHRATE_WINDOW = 100


def _placeholders(n):
    return ",".join("?" * n)


def _rows(cur):
    return [dict(r) for r in cur]


# -- lists -----------------------------------------------------------------

def count(conn, table, where="", params=()):
    sql = "SELECT COUNT(*) c FROM %s %s" % (table, where)
    return conn.execute(sql, params).fetchone()["c"]


def blocks_page(conn, *, limit=25, offset=0):
    return _rows(conn.execute(
        "SELECT height, hash, time, mediantime, n_tx, size, weight, difficulty,"
        " bits, total_fees, subsidy, coinbase_out, value_out"
        " FROM blocks ORDER BY height DESC LIMIT ? OFFSET ?", (limit, offset)))


def miners_for(conn, heights):
    """height -> the coinbase output address that took the most value.

    'Miner' is the best label the chain can support: a coinbase may pay several
    addresses and always carries a zero-value OP_RETURN witness commitment with
    no address at all, so this picks the largest addressed output and nothing
    more is claimed by it.
    """
    if not heights:
        return {}
    rows = conn.execute(
        "SELECT t.height AS height, o.address AS address, o.value AS value"
        " FROM txs t JOIN outputs o ON o.txid = t.txid"
        " WHERE t.block_index = 0 AND o.address IS NOT NULL"
        "   AND t.height IN (%s)" % _placeholders(len(heights)),
        tuple(heights)).fetchall()
    best = {}
    for r in rows:
        cur = best.get(r["height"])
        if cur is None or r["value"] > cur[1]:
            best[r["height"]] = (r["address"], r["value"])
    return {h: v[0] for h, v in best.items()}


def txs_page(conn, *, limit=25, offset=0, coinbase=None):
    """Recent transactions across the whole chain, newest first.

    `coinbase`: None = everything, False = exclude coinbases. On this chain
    2126 of 2136 transactions are coinbases, so "hide coinbases" is what makes
    the list readable at all.
    """
    where = ""
    params = []
    if coinbase is False:
        where = "WHERE t.is_coinbase = 0"
    elif coinbase is True:
        where = "WHERE t.is_coinbase = 1"
    params += [limit, offset]
    return _rows(conn.execute(
        "SELECT t.txid, t.height, t.block_index, t.is_coinbase, t.n_in, t.n_out,"
        " t.value_in, t.value_out, t.fee, t.size, t.vsize, b.time, b.hash AS block_hash"
        " FROM txs t JOIN blocks b ON b.height = t.height %s"
        " ORDER BY t.height DESC, t.block_index DESC LIMIT ? OFFSET ?" % where,
        params))


def tx_count(conn, *, coinbase=None):
    if coinbase is False:
        return count(conn, "txs", "WHERE is_coinbase = 0")
    if coinbase is True:
        return count(conn, "txs", "WHERE is_coinbase = 1")
    return count(conn, "txs")


def block_txs(conn, height, *, limit=100, offset=0):
    return _rows(conn.execute(
        "SELECT txid, block_index, is_coinbase, n_in, n_out, value_in, value_out,"
        " fee, size, vsize, weight FROM txs WHERE height = ?"
        " ORDER BY block_index LIMIT ? OFFSET ?", (height, limit, offset)))


def outputs_for(conn, txids, *, cap=6):
    """txid -> {'rows': [...up to cap...], 'total': n, 'value': sat}.

    One query for a whole page of transactions, so a list page is O(1) queries
    rather than O(rows).
    """
    if not txids:
        return {}
    rows = conn.execute(
        "SELECT txid, n, value, address, script_type, unspendable, spent_height"
        " FROM outputs WHERE txid IN (%s) ORDER BY txid, n"
        % _placeholders(len(txids)), tuple(txids)).fetchall()
    out = {}
    for r in rows:
        slot = out.setdefault(r["txid"], {"rows": [], "total": 0, "value": 0})
        slot["total"] += 1
        slot["value"] += r["value"]
        if len(slot["rows"]) < cap:
            slot["rows"].append(dict(r))
    return out


def inputs_for(conn, txids, *, cap=6):
    if not txids:
        return {}
    rows = conn.execute(
        "SELECT txid, n, value, address, prev_txid, prev_n"
        " FROM inputs WHERE txid IN (%s) ORDER BY txid, n"
        % _placeholders(len(txids)), tuple(txids)).fetchall()
    out = {}
    for r in rows:
        slot = out.setdefault(r["txid"], {"rows": [], "total": 0, "value": 0})
        slot["total"] += 1
        slot["value"] += (r["value"] or 0)
        if len(slot["rows"]) < cap:
            slot["rows"].append(dict(r))
    return out


def change_for(conn, txids):
    """txid -> {'change': sat, 'addresses': set(addresses that are change)}.

    WHY THIS EXISTS
    A UTXO chain cannot spend part of a coin. To send 1,306 PCN out of an 8,000
    PCN output you spend the whole 8,000 and pay yourself 6,693 back, so the
    transaction's *total output value* is 8,000 while only 1,306 actually went
    anywhere. Listing that 8,000 under a column called "Value out" is
    technically exact and reliably misread: the owner of this chain read his own
    delivery and asked why 8,000 had left when his wallet showed 1,306.

    The heuristic is the standard one and it is exact for the case that causes
    the confusion: an output paying an address that also appears among the
    transaction's INPUTS is money returning to the same party. It cannot detect
    change sent to a fresh address (nothing on-chain can), so this UNDERSTATES
    change and therefore OVERSTATES what was sent -- the safe direction. It
    never claims a payment to a stranger was change.

    EXISTS, not a JOIN: a transaction spending three inputs from one address
    would multiply that output's value by three under a join, inventing change
    out of nothing.
    """
    if not txids:
        return {}
    rows = conn.execute(
        "SELECT o.txid, o.n, o.value, o.address FROM outputs o"
        " WHERE o.txid IN (%s) AND o.address IS NOT NULL"
        "   AND EXISTS (SELECT 1 FROM inputs i"
        "                WHERE i.txid = o.txid AND i.address = o.address)"
        % _placeholders(len(txids)), tuple(txids)).fetchall()
    out = {}
    for r in rows:
        slot = out.setdefault(r["txid"], {"change": 0, "addresses": set()})
        slot["change"] += (r["value"] or 0)
        slot["addresses"].add(r["address"])
    return out


def addresses_page(conn, *, limit=50, offset=0, include_empty=False):
    where = "" if include_empty else "WHERE balance > 0"
    return _rows(conn.execute(
        "SELECT address, balance, received, sent, tx_count, utxo_count,"
        " first_height, last_height FROM addresses %s"
        " ORDER BY balance DESC, received DESC, address ASC LIMIT ? OFFSET ?"
        % where, (limit, offset)))


def addresses_count(conn, *, include_empty=False):
    return count(conn, "addresses", "" if include_empty else "WHERE balance > 0")


def address_history_count(conn, address):
    return count(conn, "address_txs", "WHERE address = ?", (address,))


def address_utxo_count(conn, address):
    return count(conn, "outputs",
                 "WHERE address = ? AND spent_height IS NULL AND unspendable = 0",
                 (address,))


def address_exists(conn, address):
    """Has this address ever appeared in the chain? An address with a zero
    balance but a history is a different answer from one never seen at all."""
    if conn.execute("SELECT 1 FROM addresses WHERE address = ?",
                    (address,)).fetchone():
        return True
    return bool(conn.execute("SELECT 1 FROM outputs WHERE address = ? LIMIT 1",
                             (address,)).fetchone())


# -- reorgs ----------------------------------------------------------------

def reorgs(conn, *, limit=50, offset=0):
    return _rows(conn.execute(
        "SELECT id, ts, fork_height, old_tip_height, old_tip_hash, new_tip_height,"
        " new_tip_hash, blocks_unwound, detail FROM reorg_log"
        " ORDER BY id DESC LIMIT ? OFFSET ?", (limit, offset)))


def orphans(conn, *, limit=50, offset=0):
    return _rows(conn.execute(
        "SELECT hash, height, prev_hash, time, n_tx, unwound_ts"
        " FROM orphaned_blocks ORDER BY height DESC, unwound_ts DESC"
        " LIMIT ? OFFSET ?", (limit, offset)))


def orphan(conn, block_hash):
    r = conn.execute("SELECT * FROM orphaned_blocks WHERE hash = ?",
                     (block_hash,)).fetchone()
    return dict(r) if r else None


# -- chain metrics ---------------------------------------------------------

def _window_rows(conn, tip, window):
    lo = max(0, tip - window)
    return _rows(conn.execute(
        "SELECT height, time, chainwork FROM blocks"
        " WHERE height >= ? AND height <= ? ORDER BY height", (lo, tip)))


def hashrate_estimate(conn, tip, window=HASHRATE_WINDOW):
    """Network hashrate from chainwork over a window, mirroring Core's
    GetNetworkHashPS (src/rpc/mining.cpp): work done divided by the *span* of
    the block timestamps in the window.

    The span, rather than last-minus-first, is the point. Block timestamps are
    not monotonic in height on this chain (CLAUDE.md 3), so last-minus-first
    can be zero or negative and would produce a nonsense or infinite rate.
    Whenever the span is not positive this returns None -- an unknown, never a
    zero (CLAUDE.md 7.1).
    """
    if tip is None or tip < 1:
        return None
    rows = _window_rows(conn, tip, window)
    if len(rows) < 2:
        return None
    times = [r["time"] for r in rows]
    span = max(times) - min(times)
    try:
        work = int(rows[-1]["chainwork"], 16) - int(rows[0]["chainwork"], 16)
    except (TypeError, ValueError):
        return None
    if span <= 0 or work <= 0:
        return None
    return {"hashrate": work / float(span), "blocks": len(rows) - 1,
            "seconds": span, "work": work,
            "from_height": rows[0]["height"], "to_height": rows[-1]["height"]}


def spacing(conn, tip, window):
    """Mean seconds per block over the last `window` blocks, or None.

    Same span-based method and same refusal to invent a number as
    ``hashrate_estimate``.
    """
    if tip is None or tip < 1:
        return None
    rows = _window_rows(conn, tip, window)
    if len(rows) < 2:
        return None
    times = [r["time"] for r in rows]
    span = max(times) - min(times)
    blocks = len(rows) - 1
    if span <= 0:
        return None
    return {"seconds": span / float(blocks), "blocks": blocks, "span": span,
            "from_height": rows[0]["height"], "to_height": rows[-1]["height"]}


# The all-time span, memoised on the tip hash. See `all_time_spacing`.
_ALL_TIME = {}
_ALL_TIME_KEEP = 8


def all_time_spacing(conn, tip):
    """`spacing` over every block, memoised.

    This is the one window that grows with the chain, and it is read on the home
    page, on /about, on /api/chain and once per coinbase transaction page -- so
    it was the only per-request O(chain) scan on the hottest paths.

    Keying on the tip *hash* rather than the height is what makes the cache
    safe: by invariant I the contents of `blocks` are always the heights 0..T of
    one genesis-rooted chain, so the tip hash names that whole set. The same
    hash therefore cannot mean a different span -- not across two databases, and
    not after a reorg, which necessarily changes the tip hash.
    """
    if tip is None or tip < 1:
        return None
    row = conn.execute("SELECT hash FROM blocks WHERE height = ?", (tip,)).fetchone()
    if row is None:
        return spacing(conn, tip, tip)
    hit = _ALL_TIME.get(row["hash"])
    if hit is None:
        hit = spacing(conn, tip, tip)
        if hit is None:
            return None
        _ALL_TIME[row["hash"]] = hit
        while len(_ALL_TIME) > _ALL_TIME_KEEP:
            _ALL_TIME.pop(next(iter(_ALL_TIME)))
    # A copy: callers annotate the result, and the cached dict must not grow a
    # field from one page and be read with it on another.
    return dict(hit)


def pace(conn, tip, windows=PACE_WINDOWS):
    """The pace panel: recent spacing at several windows plus all-time.

    All-time is included precisely because it is misleading on its own -- the
    chain ran at ~49 s/block below height 2016 at powLimit and at ~1200 s/block
    since, so the lifetime mean is an artefact and is labelled as one.
    """
    out = {"target": TARGET_SPACING, "windows": []}
    for w in windows:
        if tip is not None and tip >= w:
            got = spacing(conn, tip, w)
            if got:
                got["window"] = w
                out["windows"].append(got)
    if tip is not None and tip >= 1:
        allt = all_time_spacing(conn, tip)
        if allt:
            allt["window"] = tip
            out["all_time"] = allt
    # The headline is the largest window that is still <= RECENT_WINDOW. Taking
    # the largest window available would silently reach back into the fast
    # pre-retarget era and invert the answer; taking the smallest would be
    # dominated by the variance of a Poisson process at ~1000 s spacing.
    usable = [w for w in out["windows"] if w["window"] <= RECENT_WINDOW]
    if usable:
        out["recent"] = max(usable, key=lambda w: w["window"])
    elif out["windows"]:
        out["recent"] = min(out["windows"], key=lambda w: w["window"])
    else:
        out["recent"] = out.get("all_time")
    return out


def lwma_status(conn, chain, tip):
    """Where the chain is relative to the LWMA activation height.

    The ETA is derived from the *measured* recent pace, never from the 600 s
    target -- the chain does not run at target and rendering an ETA from a
    hardcoded spacing is exactly the mistake the indexer README forbids for
    coinbase maturity.
    """
    height = LWMA_HEIGHT.get(chain, LWMA_HEIGHT["main"]) if chain else None
    if chain and chain not in LWMA_HEIGHT:
        height = None
    if height is None:
        return {"chain": chain, "height": None, "active": None,
                "blocks_remaining": None, "eta_seconds": None}
    active = tip is not None and tip >= height
    remaining = None if tip is None else max(0, height - tip)
    eta = None
    if not active and remaining:
        recent = pace(conn, tip)["recent"]
        if recent:
            eta = remaining * recent["seconds"]
    return {"chain": chain, "height": height, "active": active,
            "blocks_remaining": remaining, "eta_seconds": eta}


def maturity_eta(conn, tip, maturity_height):
    """Blocks and (estimated) seconds until a coinbase output is spendable.

    Blocks is the fact -- an output is spendable in the block at
    `maturity_height`. The seconds figure is an estimate from the measured
    recent pace and is labelled as one wherever it is rendered.
    """
    if maturity_height is None or tip is None:
        return None
    remaining = maturity_height - (tip + 1)
    if remaining <= 0:
        return {"blocks": 0, "seconds": 0, "mature": True, "window": None,
                "maturity_height": maturity_height}
    recent = pace(conn, tip)["recent"]
    return {"blocks": remaining,
            "seconds": remaining * recent["seconds"] if recent else None,
            "window": recent["blocks"] if recent else None,
            "mature": False, "maturity_height": maturity_height}


def summary(conn, *, now=None):
    """Everything the home page and /api/chain need, in one call."""
    stats = queries.chain_stats(conn)
    tip = stats["height"]
    chain = stats["health"].get("chain")
    stats["pace"] = pace(conn, tip)
    stats["hashrate"] = hashrate_estimate(conn, tip)
    stats["lwma"] = lwma_status(conn, chain, tip)
    stats["block_count"] = tip + 1 if tip is not None and tip >= 0 else 0
    stats["reorg_count"] = stats["health"].get("reorg_count")
    stats["orphan_count"] = count(conn, "orphaned_blocks")
    stats["address_count"] = count(conn, "addresses")
    return stats
