"""The read-only JSON API. Same index, same process, same answers as the pages.

Three rules it keeps:

* **No floating-point money.** Every amount appears twice: ``x_sat``, an exact
  integer of satoshis, and ``x``, a fixed-point decimal string. A client that
  parses either one gets an exact number; there is no representation in a
  response that can lose a satoshi.
* **Every balance-shaped answer carries ``health``.** A client that renders a
  balance without checking ``health.stale`` is the failure mode the indexer's
  ``sync_state`` table exists to prevent.
* **No write surface.** No broadcast, no address generation, no keys. The
  process cannot reach the node at all.
"""

from decimal import Decimal

from pcoin_indexer import queries
from pcoin_indexer.amounts import from_sat
from pcoin_indexer.indexer import COINBASE_MATURITY

from . import addr as addrmod
from . import reads, search

MAX_PAGE_SIZE = 200


def json_default(obj):
    if isinstance(obj, Decimal):
        return str(obj)
    raise TypeError(repr(obj))


def _money(d, *keys):
    """Add a decimal-string twin for each satoshi field, in place."""
    for k in keys:
        if d.get(k) is not None:
            d[k + "_pcn"] = from_sat(d[k])
    return d


def status(ctx):
    return 200, queries.health(ctx.conn, now=ctx.now)


def chain(ctx):
    s = reads.summary(ctx.conn)
    # supply arrives already named `supply_sat`, so the decimal twin is
    # `supply_pcn` -- same rule as every other amount: integer satoshis under
    # one name, the fixed-point string under `<name>_pcn`.
    s["supply_pcn"] = from_sat(s["supply_sat"])
    s["coinbase_maturity"] = COINBASE_MATURITY
    s["target_spacing_seconds"] = reads.TARGET_SPACING
    return 200, s


def blocks(ctx, page, per_page):
    offset = (page - 1) * per_page
    rows = reads.blocks_page(ctx.conn, limit=per_page, offset=offset)
    miners = reads.miners_for(ctx.conn, [b["height"] for b in rows])
    for b in rows:
        b["miner_address"] = miners.get(b["height"])
        _money(b, "total_fees", "subsidy", "coinbase_out", "value_out")
    total = ctx.tip + 1 if ctx.tip >= 0 else 0
    return 200, {"page": page, "per_page": per_page, "total": total,
                 "blocks": rows, "health": ctx.health}


def block(ctx, ident):
    b = queries.block(ctx.conn, ident, with_txids=True)
    if b is None:
        return 404, {"error": "no such block in the index",
                     "health": ctx.health}
    _money(b, "total_fees", "subsidy", "coinbase_out", "value_out")
    b["health"] = ctx.health
    return 200, b


def txs(ctx, page, per_page, coinbase):
    offset = (page - 1) * per_page
    rows = reads.txs_page(ctx.conn, limit=per_page, offset=offset,
                          coinbase=coinbase)
    for t in rows:
        _money(t, "value_in", "value_out", "fee")
    return 200, {"page": page, "per_page": per_page,
                 "total": reads.tx_count(ctx.conn, coinbase=coinbase),
                 "transactions": rows, "health": ctx.health}


def tx(ctx, txid):
    t = queries.transaction(ctx.conn, txid)
    if t is None:
        return 404, {"error": "no such transaction in the index",
                     "health": ctx.health}
    _money(t, "value_in", "value_out", "fee")
    for i in t["inputs"]:
        _money(i, "value")
    for o in t["outputs"]:
        _money(o, "value")
    if t["is_coinbase"]:
        t["maturity"] = reads.maturity_eta(ctx.conn, ctx.tip,
                                           t["height"] + COINBASE_MATURITY)
    return 200, t


def address(ctx, addr_text):
    canonical = addrmod.canonicalise(addr_text, ctx.chain) or addr_text
    s = queries.address_summary(ctx.conn, canonical)
    _money(s, "balance", "spendable", "immature", "received", "sent")
    s["address"] = canonical
    s["type"] = addrmod.classify(canonical, ctx.chain)
    s["valid"] = s["type"] is not None
    s["seen_on_chain"] = reads.address_exists(ctx.conn, canonical)
    # There is no mempool index, so the unconfirmed balance is unknown. It is
    # reported as null with an explicit reason -- never as 0, which a client
    # would read as a fact (CLAUDE.md 7.1/7.2).
    s["unconfirmed"] = None
    s["unconfirmed_reason"] = "this index does not track the mempool"
    return 200, s


def address_history(ctx, addr_text, page, per_page):
    canonical = addrmod.canonicalise(addr_text, ctx.chain) or addr_text
    offset = (page - 1) * per_page
    rows = queries.address_history(ctx.conn, canonical, limit=per_page,
                                   offset=offset)
    for r in rows:
        _money(r, "received", "sent", "net")
    return 200, {"address": canonical, "page": page, "per_page": per_page,
                 "total": reads.address_history_count(ctx.conn, canonical),
                 "transactions": rows, "health": ctx.health}


def address_utxos(ctx, addr_text, page, per_page, mature_only):
    canonical = addrmod.canonicalise(addr_text, ctx.chain) or addr_text
    offset = (page - 1) * per_page
    rows = queries.address_utxos(ctx.conn, canonical, limit=per_page,
                                 offset=offset, mature_only=mature_only)
    for r in rows:
        _money(r, "value")
    return 200, {"address": canonical, "page": page, "per_page": per_page,
                 "total": reads.address_utxo_count(ctx.conn, canonical),
                 "mature_only": mature_only, "utxos": rows,
                 "coinbase_maturity": COINBASE_MATURITY, "health": ctx.health}


def addresses(ctx, page, per_page, include_empty):
    offset = (page - 1) * per_page
    rows = reads.addresses_page(ctx.conn, limit=per_page, offset=offset,
                                include_empty=include_empty)
    for r in rows:
        _money(r, "balance", "received", "sent")
    return 200, {"page": page, "per_page": per_page,
                 "total": reads.addresses_count(ctx.conn,
                                                include_empty=include_empty),
                 "addresses": rows, "health": ctx.health}


def reorgs(ctx, page, per_page):
    offset = (page - 1) * per_page
    return 200, {"page": page, "per_page": per_page,
                 "total": reads.count(ctx.conn, "reorg_log"),
                 "reorgs": reads.reorgs(ctx.conn, limit=per_page, offset=offset),
                 "orphaned_blocks": reads.orphans(ctx.conn, limit=per_page),
                 "orphaned_total": reads.count(ctx.conn, "orphaned_blocks"),
                 "health": ctx.health}


def search_api(ctx, q):
    result = search.route(ctx.conn, q, chain=ctx.chain)
    code = {"empty": 400, "invalid": 400, "not_found": 404,
            "ambiguous": 300}.get(result["kind"], 200)
    if result.get("target"):
        result["url"] = result["target"]
    result["health"] = ctx.health
    return code, result


def clamp_page(value, default=1):
    try:
        page = int(value)
    except (TypeError, ValueError):
        return default
    return max(1, min(page, 100_000))


def clamp_per_page(value, default):
    try:
        n = int(value)
    except (TypeError, ValueError):
        return default
    return max(1, min(n, MAX_PAGE_SIZE))
