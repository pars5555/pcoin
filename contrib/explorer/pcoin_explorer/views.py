"""Server-rendered pages. No JavaScript, no template engine.

Two things are load-bearing here rather than decorative:

1. **The staleness banner.** ``pcoin_indexer.queries.health()`` exists so that a
   balance is never rendered as if it were current when the index has not
   heard from the node. Every page that this module produces carries the banner
   when ``health()["stale"]`` is true, and the affected numbers are labelled.
   The indexer README names an API that renders a balance without checking
   ``stale`` as the exact failure this table exists to prevent.

2. **Unknown is rendered as unknown.** There is no mempool index, so the
   unconfirmed balance is *not known*, not zero. It renders as "not indexed"
   with a link to what that means. CLAUDE.md 7.1/7.2 -- an unanswerable
   question must never be shown as a definite answer.

Everything that reaches the markup goes through ``fmt.esc`` or a helper in
``fmt`` that calls it.
"""

import time
from urllib.parse import quote, urlencode

from pcoin_indexer import queries
from pcoin_indexer.indexer import COINBASE_MATURITY

from . import addr as addrmod
from . import reads
from .fmt import (DASH, amount_html, ago, confirmations_badge, duration, esc,
                  hashrate, iso, maybe, num, pcn, pct, shorten, sig, size_bytes,
                  time_cell)
from .theme import FAVICON

PER_PAGE = 25
ADDRESS_PER_PAGE = 50

NAV = (("/blocks", "Blocks"), ("/txs", "Transactions"),
       ("/addresses", "Addresses"), ("/reorgs", "Reorgs"), ("/about", "About"))


class Ctx:
    """Everything a page needs that is not its own arguments.

    One health read and one tip read per request, shared by every component, so
    a page cannot show two different tip heights in two different places.
    """

    def __init__(self, conn, *, now=None, path="/", query=None):
        self.conn = conn
        self.now = int(time.time()) if now is None else int(now)
        self.path = path
        self.query = query or {}
        self.health = queries.health(conn, now=self.now)
        self.tip = self.health["indexed_height"]
        self.chain = self.health.get("chain") or "main"


# -- small components -------------------------------------------------------

def link(href, text, *, cls="", title=None, escape_text=True):
    return '<a href="%s"%s%s>%s</a>' % (
        esc(href),
        ' class="%s"' % esc(cls) if cls else "",
        ' title="%s"' % esc(title) if title else "",
        esc(text) if escape_text else text)


def tx_link(txid, *, short=True):
    if not txid:
        return '<span class="dim">%s</span>' % DASH
    return '<a class="mono" href="/tx/%s" title="%s">%s</a>' % (
        esc(quote(str(txid), safe="")), esc(txid),
        shorten(txid) if short else esc(txid))


def block_link(height, *, text=None):
    if height is None:
        return '<span class="dim">%s</span>' % DASH
    return '<a class="mono" href="/block/%d">%s</a>' % (
        int(height), esc(text if text is not None else num(height)))


def block_hash_link(block_hash, *, short=True):
    if not block_hash:
        return '<span class="dim">%s</span>' % DASH
    return '<a class="mono" href="/block/%s" title="%s">%s</a>' % (
        esc(quote(str(block_hash), safe="")), esc(block_hash),
        shorten(block_hash) if short else esc(block_hash))


def address_link(address, *, short=False, kind=None):
    """An output with no address is a real thing on this chain -- the genesis
    coinbase pays a bare pubkey and every coinbase carries a zero-value
    OP_RETURN witness commitment -- so it is labelled, not blanked."""
    if not address:
        label = {"nulldata": "OP_RETURN (unspendable)",
                 "pubkey": "bare pubkey (no address)"}.get(
                     kind, "no address (%s)" % (kind or "nonstandard"))
        return '<span class="dim">%s</span>' % esc(label)
    return '<a class="mono" href="/address/%s" title="%s">%s</a>' % (
        esc(quote(str(address), safe="")), esc(address),
        shorten(address, 14, 10) if short else esc(address))


def tile(label, value, *, foot=None, accent=False, small=False):
    return ('<div class="tile%s"><div class="label">%s</div>'
            '<div class="value%s">%s</div>%s</div>'
            % (" accent" if accent else "", esc(label),
               " sm" if small else "", value,
               '<div class="foot">%s</div>' % foot if foot else ""))


def tiles(items):
    return '<div class="tiles">%s</div>' % "".join(items)


def panel(inner):
    return '<div class="panel">%s</div>' % inner


def table(headers, rows, *, empty="Nothing here yet."):
    if not rows:
        return panel('<div class="empty">%s</div>' % esc(empty))
    head = "".join('<th%s>%s</th>' % (' class="num"' if n else "", esc(h))
                   for h, n in headers)
    return panel('<div class="tablewrap"><table><thead><tr>%s</tr></thead>'
                 '<tbody>%s</tbody></table></div>' % (head, "".join(rows)))


def kv(rows):
    body = "".join('<tr><th>%s</th><td>%s</td></tr>' % (esc(k), v)
                   for k, v in rows if v is not None)
    return panel('<div class="tablewrap"><table class="kv"><tbody>%s</tbody>'
                 '</table></div>' % body)


def note(text):
    return '<span class="note">%s</span>' % esc(text)


def banner(kind, html_body):
    return '<div class="banner banner-%s">%s</div>' % (esc(kind), html_body)


def pager(path, params, page, total_items, per_page):
    """Page links. `params` is every other query parameter, preserved."""
    if total_items is None:
        return ""
    pages = max(1, (total_items + per_page - 1) // per_page)
    if pages <= 1:
        return ('<div class="pager"><span class="dim">%s item(s)</span></div>'
                % num(total_items))

    def href(p):
        q = dict(params)
        if p > 1:
            q["page"] = p
        else:
            q.pop("page", None)
        return path + ("?" + urlencode(q) if q else "")

    def cell(p, text):
        if p == page:
            return '<span class="cur">%s</span>' % esc(text)
        if p < 1 or p > pages:
            return '<span class="off">%s</span>' % esc(text)
        return link(href(p), text)

    out = [cell(1, "first"), cell(page - 1, "prev")]
    lo, hi = max(1, page - 2), min(pages, page + 2)
    for p in range(lo, hi + 1):
        out.append(cell(p, str(p)))
    out += [cell(page + 1, "next"), cell(pages, "last")]
    out.append('<span class="spacer"></span>')
    out.append('<span class="dim">page %s of %s &middot; %s item(s)</span>'
               % (num(page), num(pages), num(total_items)))
    return '<div class="pager">%s</div>' % "".join(out)


def tabs(items, current):
    out = []
    for href, label, key in items:
        out.append('<a class="%s" href="%s">%s</a>'
                   % ("on" if key == current else "", esc(href), esc(label)))
    return '<div class="tabs">%s</div>' % "".join(out)


# -- the shell --------------------------------------------------------------

def health_banner(ctx):
    """The one component that must never be forgotten on a page showing money."""
    h = ctx.health
    if not h.get("stale"):
        return ""
    items = "".join("<li>%s</li>" % esc(r) for r in h.get("stale_reasons") or [])
    behind = h.get("blocks_behind")
    severe = h.get("node_height") is None or (behind or 0) > 3
    body = ("<b>These numbers may be out of date.</b> The index is not known to "
            "be level with the node, so a balance or a confirmation count on "
            "this page can be wrong.<ul>%s</ul>" % items)
    return banner("err" if severe else "warn", body)


def shell(ctx, *, title, body, active="", h1=None, kind=None, subhead=None,
          description=None):
    nav = "".join(
        '<a class="%s" href="%s">%s</a>' % ("on" if active == href else "",
                                            esc(href), esc(label))
        for href, label in NAV)
    q = esc(ctx.query.get("q", "") if isinstance(ctx.query, dict) else "")
    head = ""
    if h1:
        head = "<h1>%s%s</h1>" % (
            '<span class="kind">%s</span>' % esc(kind) if kind else "", h1)
        if subhead:
            head += '<div class="subhead">%s</div>' % subhead
    footer_bits = [
        "PCoin explorer &middot; index height %s" % num(ctx.tip),
        "node height %s" % (num(ctx.health.get("node_height"))
                            if ctx.health.get("node_height") is not None else DASH),
        "last node poll %s" % (esc(duration(ctx.health.get("last_poll_age_seconds"),
                                            parts=1) + " ago")
                               if ctx.health.get("last_poll_age_seconds") is not None
                               else "never"),
        "chain <b>%s</b>" % esc(ctx.chain),
    ]
    return """<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>%(title)s</title>
<meta name="description" content="%(description)s">
<meta name="theme-color" content="#0a0b10">
<meta name="referrer" content="same-origin">
<link rel="icon" href="%(favicon)s">
<link rel="stylesheet" href="/static/style.css">
</head><body>
<header class="top"><div class="wrap"><div class="topbar">
  <a class="brand" href="/"><span class="mark"></span>
     <span>PCoin explorer<br><span class="sub">%(chain)s</span></span></a>
  <nav class="main">%(nav)s</nav>
  <form class="search" action="/search" method="get" role="search">
    <input type="search" name="q" value="%(q)s" autocomplete="off" spellcheck="false"
           aria-label="Search"
           placeholder="address, transaction id, block hash or height">
    <button type="submit">Search</button>
  </form>
</div></div></header>
<main><div class="wrap">%(banner)s%(head)s%(body)s</div></main>
<footer><div class="wrap"><div class="cols">
  <div>%(footer)s</div>
  <div><a href="/api">JSON API</a> &middot; <a href="/about">About this explorer</a>
       &middot; <a href="https://pc.am">pc.am</a></div>
</div></div></footer>
</body></html>""" % {
        "title": esc(title), "description": esc(description or
                                                "PCoin (PCN) block explorer"),
        "favicon": esc(FAVICON), "chain": esc(ctx.chain), "nav": nav, "q": q,
        "banner": health_banner(ctx), "head": head, "body": body,
        "footer": " &middot; ".join(footer_bits)}


# -- home -------------------------------------------------------------------

def _pace_prose(ctx, s):
    """The honesty paragraph. Every number in it is measured from the index."""
    pace = s["pace"]
    recent = pace.get("recent")
    lwma = s["lwma"]
    out = []
    if recent:
        ratio = recent["seconds"] / float(reads.TARGET_SPACING)
        verdict = ("<b>slower</b> than" if ratio > 1.15 else
                   ("<b>faster</b> than" if ratio < 0.87 else "close to"))
        out.append(
            "PCoin targets one block every %s. Measured over the last %s blocks "
            "it is producing one every <b>%s</b> &mdash; %.2f&times; the target, "
            "i.e. %s target."
            % (esc(duration(reads.TARGET_SPACING)), num(recent["blocks"]),
               esc(duration(recent["seconds"])), ratio, verdict))
    else:
        out.append("There are not yet enough blocks with a usable timestamp span "
                   "to measure the block rate.")
    if pace["windows"]:
        bits = ["last %s blocks <b>%s</b>" % (num(w["blocks"]),
                                              esc(duration(w["seconds"])))
                for w in pace["windows"]]
        allt = pace.get("all_time")
        if allt:
            bits.append("all %s blocks <b>%s</b>" % (num(allt["blocks"]),
                                                     esc(duration(allt["seconds"]))))
        out.append("Mean seconds per block by window: " + " &middot; ".join(bits) + ".")
    allt = pace.get("all_time")
    if allt and recent and abs(allt["seconds"] - recent["seconds"]) > 60:
        out.append(
            "The lifetime average of %s is an <i>artefact</i>, not a track record, "
            "and so is any window longer than about a hundred blocks: heights 0 to "
            "2015 were mined at the minimum difficulty roughly a minute apart, and "
            "the difficulty only began adjusting every block at height 2800. Read "
            "the recent window, not the average."
            % esc(duration(allt["seconds"])))
    if lwma.get("height") is None:
        out.append("LWMA difficulty retargeting is disabled on this network.")
    elif lwma.get("active"):
        out.append("LWMA retargeting is <b>active</b> (since height %s): the "
                   "difficulty now adjusts every block."
                   % num(lwma["height"]))
    else:
        eta = lwma.get("eta_seconds")
        out.append(
            "Until height <b>%s</b> the difficulty only retargets every 2016 "
            "blocks, which is why the pace has not corrected. LWMA retargeting "
            "activates there &mdash; <b>%s blocks</b> away%s &mdash; and adjusts "
            "every block from then on, which is expected to bring the pace back "
            "toward target."
            % (num(lwma["height"]), num(lwma["blocks_remaining"]),
               (", roughly %s at the pace measured above" % esc(duration(eta)))
               if eta else ""))
    return '<div class="banner banner-info prose">%s</div>' % "".join(
        "<p>%s</p>" % p for p in out)


def home(ctx):
    conn = ctx.conn
    s = reads.summary(conn)
    hr = s["hashrate"]
    recent = s["pace"].get("recent")

    tl = [
        tile("Block height", num(s["height"]), accent=True,
             foot="tip %s" % shorten(s["best_hash"] or "", 8, 6)),
        tile("Est. network hashrate",
             esc(hashrate(hr["hashrate"])) if hr else DASH,
             foot=("from chainwork over %s blocks" % num(hr["blocks"])) if hr
                  else "not enough timestamp span to measure"),
        tile("Difficulty", esc(sig(s["difficulty"], 7)),
             foot="relative to Bitcoin's difficulty-1 target"),
        tile("Avg block time",
             esc(duration(recent["seconds"])) if recent else DASH,
             foot=("last %s blocks &middot; target %s"
                   % (num(recent["blocks"]), esc(duration(reads.TARGET_SPACING))))
                  if recent else "target %s" % esc(duration(reads.TARGET_SPACING))),
        tile("Circulating supply", amount_html(s["supply_sat"], group=True, unit=False),
             foot="PCN in %s unspent outputs, incl. immature coinbase"
                  % num(s["utxo_count"]), small=True),
        tile("Transactions", num(s["tx_count"]),
             foot="%s coinbase &middot; %s payments"
                  % (num(s["coinbase_count"]), num(s["non_coinbase_count"]))),
        tile("Addresses with a balance", num(s["addresses_with_balance"]),
             foot="%s seen ever" % num(s["address_count"])),
        tile("Reorgs handled", num(s["reorg_count"]),
             foot="%s orphaned block(s) recorded" % num(s["orphan_count"])),
    ]

    blocks = reads.blocks_page(conn, limit=10)
    miners = reads.miners_for(conn, [b["height"] for b in blocks])
    brows = []
    for b in blocks:
        brows.append(
            "<tr><td>%s</td><td>%s</td><td class='num'>%s</td>"
            "<td>%s</td><td class='num'>%s</td><td class='num'>%s</td></tr>"
            % (block_link(b["height"]), time_cell(b["time"], ctx.now),
               num(b["n_tx"]), address_link(miners.get(b["height"]), short=True),
               amount_html(b["subsidy"] + b["total_fees"], unit=False),
               esc(size_bytes(b["size"]))))
    blocks_tbl = table((("Height", False), ("Time", False), ("Txs", True),
                        ("Mined to", False), ("Reward", True), ("Size", True)),
                       brows)

    pays = reads.txs_page(conn, limit=10, coinbase=False)
    outs = reads.outputs_for(conn, [t["txid"] for t in pays], cap=3)
    prows = []
    for t in pays:
        o = outs.get(t["txid"], {"rows": [], "total": 0})
        dests = "<br>".join(address_link(r["address"], short=True,
                                         kind=r["script_type"])
                            for r in o["rows"]) or '<span class="dim">%s</span>' % DASH
        if o["total"] > len(o["rows"]):
            dests += '<div class="dim">+%s more</div>' % num(o["total"] - len(o["rows"]))
        prows.append(
            "<tr><td>%s</td><td>%s</td><td>%s</td><td class='num'>%s</td>"
            "<td class='num'>%s</td></tr>"
            % (tx_link(t["txid"]), time_cell(t["time"], ctx.now), dests,
               amount_html(t["value_out"], unit=False),
               amount_html(t["fee"], unit=False)))
    pays_tbl = table((("Transaction", False), ("Time", False), ("To", False),
                      ("Value", True), ("Fee", True)), prows,
                     empty="No non-coinbase transactions on this chain yet.")

    body = (tiles(tl)
            + _pace_prose(ctx, s)
            + "<h2>Latest blocks %s</h2>" % link("/blocks", "see all")
            + blocks_tbl
            + "<h2>Latest payments %s%s</h2>"
              % (note("non-coinbase transactions only; %s of %s transactions on "
                      "this chain are block rewards"
                      % (num(s["coinbase_count"]), num(s["tx_count"]))),
                 link("/txs", "see all"))
            + pays_tbl)
    return shell(ctx, title="PCoin (PCN) block explorer", body=body,
                 description="PCoin block explorer: blocks, transactions, "
                             "addresses and balances on the PCN chain.")


# -- blocks -----------------------------------------------------------------

def blocks_list(ctx, page):
    conn = ctx.conn
    total = ctx.tip + 1 if ctx.tip >= 0 else 0
    offset = (page - 1) * PER_PAGE
    rows_ = reads.blocks_page(conn, limit=PER_PAGE, offset=offset)
    miners = reads.miners_for(conn, [b["height"] for b in rows_])
    rows = []
    for b in rows_:
        rows.append(
            "<tr><td>%s</td><td>%s</td><td class='num'>%s</td><td>%s</td>"
            "<td class='num'>%s</td><td class='num'>%s</td><td class='num'>%s</td>"
            "<td class='num'>%s</td></tr>"
            % (block_link(b["height"]), time_cell(b["time"], ctx.now),
               num(b["n_tx"]), address_link(miners.get(b["height"]), short=True),
               amount_html(b["subsidy"], unit=False),
               amount_html(b["total_fees"], unit=False),
               esc(size_bytes(b["size"])), esc(sig(b["difficulty"], 5))))
    body = (pager("/blocks", {}, page, total, PER_PAGE)
            + table((("Height", False), ("Time", False), ("Txs", True),
                     ("Mined to", False), ("Subsidy", True), ("Fees", True),
                     ("Size", True), ("Difficulty", True)), rows)
            + pager("/blocks", {}, page, total, PER_PAGE))
    return shell(ctx, title="Blocks - PCoin explorer", body=body, active="/blocks",
                 h1="Blocks", kind="chain")


def _orphan_block_page(ctx, o):
    body = banner("warn",
                  "<b>This block was orphaned.</b> The index held it and then "
                  "unwound it when the node switched to a better chain, so it is "
                  "not part of the active chain and pays nobody. It is kept here "
                  "as an audit trail. Reorgs are routine on PCoin &mdash; see "
                  + link("/reorgs", "the reorg log") + ".")
    body += kv([
        ("Hash", '<code>%s</code>' % esc(o["hash"])),
        ("Height it was at", num(o["height"])),
        ("Previous block", block_hash_link(o.get("prev_hash"), short=False)),
        ("Timestamp", "%s %s" % (esc(iso(o.get("time"))),
                                 note(ago(o.get("time"), ctx.now)))),
        ("Transactions", num(o.get("n_tx"))),
        ("Unwound at", "%s %s" % (esc(iso(o.get("unwound_ts"))),
                                  note(ago(o.get("unwound_ts"), ctx.now)))),
    ])
    return shell(ctx, title="Orphaned block - PCoin explorer", body=body,
                 h1="Orphaned block", kind="block",
                 subhead=esc(o["hash"]), active="/blocks")


def block_page(ctx, ident, page=1):
    conn = ctx.conn
    b = queries.block(conn, ident, with_txids=False)
    if b is None:
        return None
    if b.get("orphaned"):
        return _orphan_block_page(ctx, b)

    height = b["height"]
    reward = b["subsidy"] + b["total_fees"]
    over = b["coinbase_out"] - reward
    tl = [
        tile("Height", num(height), accent=True,
             foot=confirmations_badge(b["confirmations"])),
        tile("Timestamp", '<span class="value sm">%s</span>' % esc(iso(b["time"])),
             foot=esc(ago(b["time"], ctx.now)), small=True),
        tile("Transactions", num(b["n_tx"])),
        tile("Size", esc(size_bytes(b["size"])),
             foot="%s weight units" % num(b["weight"])),
        tile("Block reward", amount_html(b["coinbase_out"], unit=False),
             foot="%s subsidy + %s fees" % (pcn(b["subsidy"]), pcn(b["total_fees"])),
             small=True),
        tile("Difficulty", esc(sig(b["difficulty"], 7)),
             foot="bits %s" % esc(b["bits"])),
    ]

    nav = []
    if height > 0:
        nav.append(link("/block/%d" % (height - 1), "← previous block"))
    if b.get("next_hash"):
        nav.append(link("/block/%d" % (height + 1), "next block →"))
    navhtml = ('<div class="pager">%s</div>'
               % "".join(nav)) if nav else ""

    warn = ""
    if over > 0:
        warn = banner("err", "<b>The coinbase claimed %s more than the subsidy "
                             "plus fees.</b> That should be impossible under "
                             "consensus; treat this index as suspect and run "
                             "<code>verify</code>." % esc(pcn(over)))

    rows = [
        ("Hash", '<code>%s</code>' % esc(b["hash"])),
        ("Previous block", block_hash_link(b["prev_hash"], short=False)
         if b["prev_hash"] else '<span class="dim">none (genesis)</span>'),
        ("Next block", block_hash_link(b.get("next_hash"), short=False)
         if b.get("next_hash") else '<span class="dim">none (this is the tip)</span>'),
        ("Merkle root", '<code>%s</code>' % esc(b["merkleroot"])),
        ("Timestamp", "%s %s" % (esc(iso(b["time"])),
                                 note("header nTime; %s" % ago(b["time"], ctx.now)))),
        ("Median time past", "%s %s" % (
            esc(iso(b["mediantime"])),
            note("MTP is monotonic in height; the header timestamp is not"))),
        ("Version", "0x%08x %s" % (b["version"] & 0xFFFFFFFF, note(str(b["version"])))),
        ("Bits", "%s %s" % (esc(b["bits"]),
                            note("difficulty %s" % sig(b["difficulty"], 8)))),
        ("Nonce", num(b["nonce"])),
        ("Chainwork", '<code>%s</code>' % esc(b["chainwork"])),
        ("Size", "%s %s" % (esc(size_bytes(b["size"])),
                            note("%s bytes, stripped %s, weight %s"
                                 % (num(b["size"]), num(b["strippedsize"]),
                                    num(b["weight"]))))),
        ("Transactions", num(b["n_tx"])),
        ("Total output value", amount_html(b["value_out"])),
        ("Fees", amount_html(b["total_fees"])),
        ("Subsidy", "%s %s" % (amount_html(b["subsidy"]),
                               note("consensus subsidy at this height"))),
        ("Coinbase claimed", amount_html(b["coinbase_out"])),
        ("Confirmations", confirmations_badge(b["confirmations"])),
    ]

    total_txs = b["n_tx"]
    offset = (page - 1) * PER_PAGE
    txs = reads.block_txs(conn, height, limit=PER_PAGE, offset=offset)
    txids = [t["txid"] for t in txs]
    outs = reads.outputs_for(conn, txids, cap=5)
    ins = reads.inputs_for(conn, txids, cap=5)
    chg = reads.change_for(conn, txids)
    trows = []
    for t in txs:
        o = outs.get(t["txid"], {"rows": [], "total": 0})
        i = ins.get(t["txid"], {"rows": [], "total": 0})
        c = chg.get(t["txid"], {"change": 0, "addresses": set()})
        if t["is_coinbase"]:
            src = ('<span class="badge badge-cb">coinbase</span> '
                   '<span class="dim">newly mined</span>')
        else:
            src = "<br>".join(address_link(r["address"], short=True)
                              for r in i["rows"]) or '<span class="dim">%s</span>' % DASH
            if i["total"] > len(i["rows"]):
                src += '<div class="dim">+%s more</div>' % num(i["total"] - len(i["rows"]))
        # Per-output values, same reasoning as the /txs list.
        dst = "<br>".join(
            '%s <span class="dim">%s</span>%s'
            % (address_link(r["address"], short=True, kind=r["script_type"]),
               amount_html(r["value"], unit=False),
               ' <span class="badge">change</span>' if r["address"] in c["addresses"] else "")
            for r in o["rows"]) or '<span class="dim">%s</span>' % DASH
        if o["total"] > len(o["rows"]):
            dst += '<div class="dim">+%s more</div>' % num(o["total"] - len(o["rows"]))
        sent_cell = amount_html(t["value_out"], unit=False)
        if o["total"] > 1:
            sent_cell += '<div class="dim">incl. change</div>'
        trows.append(
            "<tr><td>%s<div class='dim'>#%s</div></td><td>%s</td><td>%s</td>"
            "<td class='num'>%s</td><td class='num'>%s</td></tr>"
            % (tx_link(t["txid"]), num(t["block_index"]), src, dst,
               sent_cell,
               amount_html(t["fee"], unit=False) if not t["is_coinbase"]
               else '<span class="dim">%s</span>' % DASH))

    body = (navhtml + warn + tiles(tl)
            + "<h2>Header</h2>" + kv(rows)
            + "<h2>Transactions %s</h2>" % note("%s in this block" % num(total_txs))
            + pager("/block/%d" % height, {}, page, total_txs, PER_PAGE)
            + table((("Transaction", False), ("From", False), ("To", False),
                     ("Total out", True), ("Fee", True)), trows)
            + pager("/block/%d" % height, {}, page, total_txs, PER_PAGE))
    return shell(ctx, title="Block %s - PCoin explorer" % height, body=body,
                 h1="Block %s" % num(height), kind="block",
                 subhead=esc(b["hash"]), active="/blocks",
                 description="PCoin block %s, %s transactions, mined %s."
                             % (height, b["n_tx"], iso(b["time"])))


# -- transactions -----------------------------------------------------------

def txs_list(ctx, page, coinbase):
    conn = ctx.conn
    total = reads.tx_count(conn, coinbase=coinbase)
    offset = (page - 1) * PER_PAGE
    txs = reads.txs_page(conn, limit=PER_PAGE, offset=offset, coinbase=coinbase)
    txids = [t["txid"] for t in txs]
    outs = reads.outputs_for(conn, txids, cap=4)
    # One extra query for the whole page, so this stays O(1) per page.
    chg = reads.change_for(conn, txids)
    rows = []
    for t in txs:
        o = outs.get(t["txid"], {"rows": [], "total": 0})
        c = chg.get(t["txid"], {"change": 0, "addresses": set()})
        # Each destination with WHAT IT RECEIVED. This is the whole fix, and it
        # needs no heuristic: "Total out 8,000" against a wallet showing 1,306
        # is only confusing while the split is invisible. Shown per output, the
        # 6,693 change is right there and the arithmetic explains itself.
        dst = "<br>".join(
            '%s <span class="dim">%s</span>%s'
            % (address_link(r["address"], short=True, kind=r["script_type"]),
               amount_html(r["value"], unit=False),
               ' <span class="badge">change</span>' if r["address"] in c["addresses"] else "")
            for r in o["rows"]) or '<span class="dim">%s</span>' % DASH
        if o["total"] > len(o["rows"]):
            dst += '<div class="dim">+%s more</div>' % num(o["total"] - len(o["rows"]))
        sent_cell = amount_html(t["value_out"], unit=False)
        if o["total"] > 1:
            sent_cell += '<div class="dim">incl. change</div>'
        rows.append(
            "<tr><td>%s%s</td><td>%s</td><td>%s</td><td>%s</td>"
            "<td class='num'>%s</td><td class='num'>%s</td></tr>"
            % (tx_link(t["txid"]),
               ' <span class="badge badge-cb">coinbase</span>' if t["is_coinbase"] else "",
               block_link(t["height"]), time_cell(t["time"], ctx.now), dst,
               sent_cell,
               amount_html(t["fee"], unit=False) if not t["is_coinbase"]
               else '<span class="dim">%s</span>' % DASH))
    params = {} if coinbase is None else {"payments": "1"}
    view = "payments" if coinbase is False else "all"
    body = (tabs([("/txs", "All transactions", "all"),
                  ("/txs?payments=1", "Payments only", "payments")], view)
            + pager("/txs", params, page, total, PER_PAGE)
            + table((("Transaction", False), ("Block", False), ("Time", False),
                     ("To", False), ("Total out", True), ("Fee", True)), rows)
            + pager("/txs", params, page, total, PER_PAGE))
    return shell(ctx, title="Transactions - PCoin explorer", body=body,
                 active="/txs", h1="Transactions", kind="chain")


def _io_side(title, rows_html, total_value):
    return ('<div class="side"><h3>%s</h3>%s'
            '<div class="row"><div class="idx"></div><div class="body">'
            '<b>Total</b></div><div class="val">%s</div></div></div>'
            % (esc(title), "".join(rows_html), amount_html(total_value, unit=False)))


def tx_page(ctx, txid):
    conn = ctx.conn
    t = queries.transaction(conn, txid)
    if t is None:
        return None
    is_cb = bool(t["is_coinbase"])

    mat = None
    if is_cb:
        mat = reads.maturity_eta(conn, ctx.tip, t["height"] + COINBASE_MATURITY)

    # Outputs the sender paid to ITSELF, where that can be established as fact:
    # the address also appears among this transaction's inputs. That only
    # catches address REUSE. Bitcoin Core sends change to a fresh address every
    # time, so the common case cannot be detected from the chain by anyone —
    # and a badge is not put on a guess. The honest fix is elsewhere: the list
    # views now show what each output received, so an 8,000 total against a
    # wallet showing 1,306 explains itself without anything having to know
    # which half was change.
    _chg = reads.change_for(conn, [txid]).get(txid, {"change": 0, "addresses": set()})
    change_addrs = _chg["addresses"]

    tl = [
        tile("Value out", amount_html(t["value_out"], group=True, unit=False),
             accent=True,
             foot=("across %s outputs — a transaction spends a whole coin, so this "
                   "usually includes change returning to the sender"
                   % num(t["n_out"])) if t["n_out"] > 1
                  else "across %s output" % num(t["n_out"]),
             small=True),
        tile("Fee", '<span class="dim">%s</span>' % DASH if is_cb
             else amount_html(t["fee"], unit=False),
             foot="newly created coins pay no fee" if is_cb
                  else ("%s sat/vB" % sig(t["fee_rate_sat_vb"], 4)
                        if t["fee_rate_sat_vb"] is not None else "&nbsp;"),
             small=True),
        tile("Confirmations", num(t["confirmations"]),
             foot=confirmations_badge(t["confirmations"])),
        tile("Included in", '<span class="value sm">%s</span>'
             % block_link(t["height"]),
             foot=esc(iso(t["block_time"])), small=True),
        tile("Size", esc(size_bytes(t["size"])),
             foot="%s vB &middot; %s WU" % (num(t["vsize"]), num(t["weight"]))),
    ]

    banners = []
    if is_cb:
        if mat and mat["mature"]:
            banners.append(banner(
                "info",
                "<b>Coinbase transaction.</b> These are newly mined coins with no "
                "inputs. It matured at height %s and is spendable now."
                % num(mat["maturity_height"])))
        else:
            eta = ("" if not mat or mat.get("seconds") is None else
                   " &mdash; roughly %s at the pace measured over the last %s "
                   "blocks. That estimate comes from this chain's measured pace, "
                   "never from the 600 s target alone, because the chain has not "
                   "always run at target."
                   % (esc(duration(mat["seconds"])), num(mat.get("window"))))
            banners.append(banner(
                "warn",
                "<b>Coinbase transaction &mdash; not yet spendable.</b> Newly "
                "mined coins mature after %s confirmations. These become "
                "spendable in the block at height <b>%s</b>, %s block(s) away%s."
                % (num(COINBASE_MATURITY),
                   num(mat["maturity_height"]) if mat else DASH,
                   num(mat["blocks"]) if mat else DASH, eta)))

    irows = []
    if is_cb:
        cb = t["inputs"][0] if t["inputs"] else {}
        irows.append(
            '<div class="row"><div class="idx">0</div><div class="body">'
            '<div class="addr"><span class="badge badge-cb">coinbase</span> '
            'newly mined coins</div>'
            '<div class="meta">scriptSig <code>%s</code></div></div>'
            '<div class="val">%s</div></div>'
            % (esc(shorten(cb.get("coinbase_hex") or "", 24, 8)),
               amount_html(t["value_out"], unit=False)))
    else:
        for i in t["inputs"]:
            irows.append(
                '<div class="row"><div class="idx">%s</div><div class="body">'
                '<div class="addr">%s</div>'
                '<div class="meta">from %s:%s%s</div></div>'
                '<div class="val">%s</div></div>'
                % (num(i["n"]), address_link(i["address"], short=True,
                                             kind=i["script_type"]),
                   tx_link(i["prev_txid"]), num(i["prev_n"]),
                   " &middot; %s" % esc(i["script_type"]) if i["script_type"] else "",
                   amount_html(i["value"], unit=False)))

    orows = []
    for o in t["outputs"]:
        meta = []
        if o["script_type"]:
            meta.append(esc(o["script_type"]))
        if o["address"] and o["address"] in change_addrs:
            meta.append('<span class="badge">change back to the sender</span>')
        if o["unspendable"]:
            meta.append('<span class="badge badge-soft">unspendable</span>')
        if o["spent"]:
            meta.append("spent by %s:%s" % (tx_link(o["spent_by_txid"]),
                                            num(o["spent_by_n"])))
        elif not o["unspendable"]:
            if o["is_coinbase"] and not o["mature"]:
                meta.append('<span class="badge badge-warn">immature until height %s</span>'
                            % num(o["maturity_height"]))
            else:
                meta.append('<span class="badge badge-ok">unspent</span>')
        orows.append(
            '<div class="row"><div class="idx">%s</div><div class="body">'
            '<div class="addr">%s</div><div class="meta">%s</div></div>'
            '<div class="val">%s</div></div>'
            % (num(o["n"]), address_link(o["address"], short=True,
                                         kind=o["script_type"]),
               " &middot; ".join(meta),
               amount_html(o["value"], unit=False)))

    io = ('<div class="io">%s%s</div>'
          % (_io_side("Inputs (%s)" % num(t["n_in"]), irows,
                      t["value_out"] if is_cb else t["value_in"]),
             _io_side("Outputs (%s)" % num(t["n_out"]), orows, t["value_out"])))

    rows = [
        ("Transaction id", '<code>%s</code>' % esc(t["txid"])),
        ("Witness txid", '<code>%s</code>' % esc(t["wtxid"]) if t["wtxid"] else None),
        ("Block", "%s %s" % (block_link(t["height"]),
                             note("position %s in the block" % t["block_index"]))),
        ("Block hash", block_hash_link(t["block_hash"], short=False)),
        ("Timestamp", "%s %s" % (esc(iso(t["block_time"])),
                                 note(ago(t["block_time"], ctx.now)))),
        ("Confirmations", confirmations_badge(t["confirmations"])),
        ("Value in", '<span class="dim">%s</span>' % DASH if is_cb
         else amount_html(t["value_in"])),
        ("Value out", amount_html(t["value_out"])),
        ("Fee", '<span class="dim">%s</span>' % DASH if is_cb
         else "%s %s" % (amount_html(t["fee"]),
                         note("%s sat/vB; PCoin has no fee market and an "
                              "effective floor of 1.000 sat/vB"
                              % sig(t["fee_rate_sat_vb"], 4)))),
        ("Size", "%s %s" % (num(t["size"]),
                            note("bytes; %s vB, %s weight units"
                                 % (num(t["vsize"]), num(t["weight"]))))),
        ("Version", num(t["version"])),
        ("Locktime", num(t["locktime"])),
        ("Spendable from height",
         "%s %s" % (num(t["spendable_from_height"]),
                    note("coinbase maturity is %s blocks" % COINBASE_MATURITY))
         if is_cb else None),
    ]

    body = ("".join(banners) + tiles(tl) + "<h2>Inputs and outputs</h2>" + io
            + "<h2>Details</h2>" + kv(rows))
    return shell(ctx, title="Transaction %s - PCoin explorer" % shorten(t["txid"]),
                 body=body, h1="Transaction", kind="transaction",
                 subhead=esc(t["txid"]), active="/txs",
                 description="PCoin transaction %s in block %s."
                             % (t["txid"], t["height"]))


# -- addresses --------------------------------------------------------------

def _unconfirmed_tile():
    """The unconfirmed balance is *unknown*, not zero -- there is no mempool
    index. Showing 0.00000000 here would be the CLAUDE.md 7.2 mistake: an
    unanswerable question rendered as a definite answer, and in a send path
    that authorises spending coins twice."""
    return tile("Unconfirmed", '<span class="dim">not indexed</span>',
                foot=link("/about#mempool", "no mempool index %s why" % DASH),
                small=True)


def address_page(ctx, address, *, view="txs", page=1):
    conn = ctx.conn
    s = queries.address_summary(conn, address)
    seen = reads.address_exists(conn, address)
    kind = addrmod.classify(address, ctx.chain)

    tl = [
        tile("Confirmed balance", amount_html(s["balance"], group=True, unit=False),
             accent=True, foot="%s unspent output(s)" % num(s["utxo_count"]),
             small=True),
        tile("Spendable now", amount_html(s["spendable"], group=True, unit=False),
             foot="usable in a transaction built at height %s" % num(ctx.tip + 1),
             small=True),
        tile("Immature", amount_html(s["immature"], group=True, unit=False),
             foot="%s coinbase output(s) under %s confirmations"
                  % (num(s["immature_utxo_count"]), num(s["maturity"])), small=True),
        _unconfirmed_tile(),
        tile("Total received", amount_html(s["received"], group=True, unit=False),
             small=True),
        tile("Total sent", amount_html(s["sent"], group=True, unit=False), small=True),
        tile("Transactions", num(s["tx_count"]),
             foot=("heights %s–%s" % (num(s["first_height"]), num(s["last_height"])))
                  if s["first_height"] is not None else "never seen on chain"),
    ]

    intro = ""
    if not seen:
        intro = banner(
            "info",
            "<b>This is a valid %s address that has never appeared on the "
            "chain.</b> Its balance is zero because nothing has ever been sent "
            "to it &mdash; not because it is unknown. Nothing is wrong with the "
            "address." % esc(kind or "PCoin"))
    elif s["immature"]:
        intro = banner(
            "info",
            "<b>%s PCN of this balance is immature.</b> Freshly mined coins "
            "cannot be spent until they have %s confirmations, so 'spendable "
            "now' is the number a wallet can actually build a transaction from."
            % (esc(pcn(s["immature"])), num(s["maturity"])))

    if view == "utxos":
        total = reads.address_utxo_count(conn, address)
        offset = (page - 1) * ADDRESS_PER_PAGE
        utxos = queries.address_utxos(conn, address, limit=ADDRESS_PER_PAGE,
                                      offset=offset)
        rows = []
        for u in utxos:
            state = ('<span class="badge badge-ok">mature</span>' if u["mature"]
                     else '<span class="badge badge-warn">immature until %s</span>'
                          % num(u["maturity_height"]))
            rows.append(
                "<tr><td>%s<span class='dim'>:%s</span></td><td>%s</td><td>%s</td>"
                "<td class='num'>%s</td><td class='num'>%s</td><td>%s</td></tr>"
                % (tx_link(u["txid"]), num(u["n"]), block_link(u["height"]),
                   time_cell(u["block_time"], ctx.now), num(u["confirmations"]),
                   amount_html(u["value"], unit=False),
                   state if u["is_coinbase"] else
                   '<span class="badge badge-soft">payment</span>'))
        listing = (pager("/address/%s" % quote(address, safe=""), {"view": "utxos"},
                         page, total, ADDRESS_PER_PAGE)
                   + table((("Outpoint", False), ("Block", False), ("Time", False),
                            ("Confs", True), ("Value", True), ("Status", False)),
                           rows, empty="This address holds no unspent outputs.")
                   + pager("/address/%s" % quote(address, safe=""), {"view": "utxos"},
                           page, total, ADDRESS_PER_PAGE))
    else:
        total = reads.address_history_count(conn, address)
        offset = (page - 1) * ADDRESS_PER_PAGE
        hist = queries.address_history(conn, address, limit=ADDRESS_PER_PAGE,
                                       offset=offset)
        rows = []
        for h in hist:
            rows.append(
                "<tr><td>%s</td><td>%s</td><td>%s</td><td class='num'>%s</td>"
                "<td class='num'>%s</td><td class='num'>%s</td>"
                "<td class='num'>%s</td></tr>"
                % (tx_link(h["txid"]), block_link(h["height"]),
                   time_cell(h["block_time"], ctx.now), num(h["confirmations"]),
                   amount_html(h["received"], unit=False) if h["received"]
                   else '<span class="dim">%s</span>' % DASH,
                   amount_html(h["sent"], unit=False) if h["sent"]
                   else '<span class="dim">%s</span>' % DASH,
                   amount_html(h["net"], sign=True, unit=False)))
        listing = (pager("/address/%s" % quote(address, safe=""), {}, page, total,
                         ADDRESS_PER_PAGE)
                   + table((("Transaction", False), ("Block", False), ("Time", False),
                            ("Confs", True), ("Received", True), ("Sent", True),
                            ("Net", True)), rows,
                           empty="No transactions involve this address.")
                   + pager("/address/%s" % quote(address, safe=""), {}, page, total,
                           ADDRESS_PER_PAGE))

    qa = quote(address, safe="")
    body = (intro + tiles(tl)
            + tabs([("/address/%s" % qa, "Transactions (%s)" % num(s["tx_count"]),
                     "txs"),
                    ("/address/%s?view=utxos" % qa,
                     "Unspent outputs (%s)" % num(s["utxo_count"]), "utxos")],
                   view)
            + listing
            + '<p class="muted" style="margin-top:18px;font-size:.86rem">'
              'This explorer is read-only and non-custodial: it holds no keys, '
              'derives no addresses and cannot move coins. %s</p>'
              % link("/about", "What it can and cannot tell you"))
    sub = esc(address)
    if kind:
        sub += ' <span class="badge badge-soft">%s</span>' % esc(kind)
    return shell(ctx, title="Address %s - PCoin explorer" % shorten(address),
                 body=body, h1="Address", kind="address", subhead=sub,
                 active="/addresses",
                 description="PCoin address %s: balance, transaction history "
                             "and unspent outputs." % address)


def addresses_list(ctx, page, include_empty):
    conn = ctx.conn
    total = reads.addresses_count(conn, include_empty=include_empty)
    offset = (page - 1) * ADDRESS_PER_PAGE
    rows_ = reads.addresses_page(conn, limit=ADDRESS_PER_PAGE, offset=offset,
                                 include_empty=include_empty)
    stats = queries.chain_stats(conn)
    supply = stats["supply_sat"]
    rows = []
    for i, a in enumerate(rows_, start=offset + 1):
        rows.append(
            "<tr><td class='num dim'>%s</td><td>%s</td><td class='num'>%s</td>"
            "<td class='num dim'>%s</td><td class='num'>%s</td>"
            "<td class='num'>%s</td><td class='num'>%s</td><td>%s</td></tr>"
            % (num(i), address_link(a["address"], short=True),
               amount_html(a["balance"], group=True, unit=False),
               esc(pct(a["balance"], supply)),
               amount_html(a["received"], group=True, unit=False),
               num(a["tx_count"]), num(a["utxo_count"]),
               block_link(a["last_height"]) if a["last_height"] is not None else DASH))
    params = {"all": "1"} if include_empty else {}
    body = (tabs([("/addresses", "With a balance", "held"),
                  ("/addresses?all=1", "Every address ever seen", "all")],
                 "all" if include_empty else "held")
            + '<p class="muted" style="font-size:.88rem;margin:10px 0">'
              'Every address the chain has ever paid or spent from, ranked by '
              'unspent value. Percentages are of the %s PCN currently in unspent '
              'outputs. <b>&ldquo;Unspent&rdquo; includes immature coinbase</b> '
              '&mdash; on a chain that is almost entirely coinbase that is most '
              'of it, and it is not spendable yet. Open an address for the '
              'mature / immature split.</p>' % esc(pcn(supply, group=True))
            + pager("/addresses", params, page, total, ADDRESS_PER_PAGE)
            + table((("#", True), ("Address", False), ("Unspent", True),
                     ("Share", True), ("Received", True), ("Txs", True),
                     ("UTXOs", True), ("Last seen", False)), rows)
            + pager("/addresses", params, page, total, ADDRESS_PER_PAGE))
    return shell(ctx, title="Addresses - PCoin explorer", body=body,
                 active="/addresses", h1="Addresses", kind="chain")


# -- reorgs -----------------------------------------------------------------

def reorgs_page(ctx, page=1):
    conn = ctx.conn
    total = reads.count(conn, "reorg_log")
    offset = (page - 1) * PER_PAGE
    rows_ = reads.reorgs(conn, limit=PER_PAGE, offset=offset)
    rows = []
    for r in rows_:
        rows.append(
            "<tr><td>%s</td><td>%s</td><td class='num'>%s</td><td>%s</td>"
            "<td>%s</td><td class='dim'>%s</td></tr>"
            % (time_cell(r["ts"], ctx.now), block_link(r["fork_height"]),
               num(r["blocks_unwound"]),
               "%s %s" % (num(r["old_tip_height"]),
                          block_hash_link(r["old_tip_hash"])),
               "%s %s" % (num(r["new_tip_height"]),
                          block_hash_link(r["new_tip_hash"])),
               esc(r["detail"] or "")))
    otot = reads.count(conn, "orphaned_blocks")
    orows = []
    for o in reads.orphans(conn, limit=PER_PAGE):
        orows.append(
            "<tr><td class='num'>%s</td><td>%s</td><td>%s</td>"
            "<td class='num'>%s</td><td>%s</td></tr>"
            % (num(o["height"]), block_hash_link(o["hash"]),
               time_cell(o["time"], ctx.now), num(o["n_tx"]),
               esc(iso(o["unwound_ts"]))))

    intro = banner(
        "info",
        "<b>Reorgs are routine on PCoin, not exceptional.</b> "
        "<code>getchaintips</code> on the seed node has returned around 66 tips "
        "over ~2100 blocks &mdash; roughly a 3% stale rate &mdash; because stale "
        "rate tracks propagation delay divided by block spacing, and the first "
        "~2016 blocks were seconds apart. This log is the index's own audit "
        "trail: every time the node switched to a better chain, the index "
        "unwound the losing blocks by subtracting back the exact per-address "
        "amounts it had added, and kept the orphaned headers below so they "
        "resolve to a page instead of a 404.")

    body = (intro
            + "<h2>Reorgs handled %s</h2>"
              % note("%s recorded" % num(total))
            + pager("/reorgs", {}, page, total, PER_PAGE)
            + table((("When", False), ("Forked at", False), ("Unwound", True),
                     ("Old tip", False), ("New tip", False), ("Detail", False)),
                    rows,
                    empty="This index has not had to unwind a reorg yet.")
            + "<h2>Orphaned blocks %s</h2>" % note("%s recorded" % num(otot))
            + table((("Height", True), ("Hash", False), ("Timestamp", False),
                     ("Txs", True), ("Unwound at", False)), orows,
                    empty="No orphaned blocks recorded by this index."))
    return shell(ctx, title="Reorgs - PCoin explorer", body=body, active="/reorgs",
                 h1="Reorgs and orphaned blocks", kind="chain")


# -- search results ---------------------------------------------------------

def search_result_page(ctx, result):
    kind = result["kind"]
    q = result.get("query", "")
    if kind == "ambiguous":
        rows = []
        for m in result["matches"]:
            rows.append("<tr><td>%s</td><td>%s</td></tr>"
                        % ("transaction" if m["kind"] == "tx" else
                           ("orphaned block" if m.get("orphaned") else "block"),
                           tx_link(m["id"], short=False) if m["kind"] == "tx"
                           else block_hash_link(m["id"], short=False)))
        body = (banner("info", "<b>%s things start with that prefix.</b> Pick one."
                       % num(len(result["matches"])))
                + table((("Kind", False), ("Identifier", False)), rows))
        return 300, shell(ctx, title="Several matches - PCoin explorer", body=body,
                          h1="Several matches", kind="search",
                          subhead=esc(q))

    if kind == "invalid":
        body = banner("warn", "<b>%s</b><div class='muted' style='margin-top:6px'>"
                              "Searched for <code>%s</code>.</div>"
                      % (esc(result["detail"]), esc(q)))
        body += _search_help(ctx)
        return 400, shell(ctx, title="Not a valid search - PCoin explorer",
                          body=body, h1="That does not look like a PCoin "
                                        "address or identifier", kind="search")

    if kind == "empty":
        body = _search_help(ctx)
        return 400, shell(ctx, title="Search - PCoin explorer", body=body,
                          h1="Type something to search for", kind="search")

    detail = result.get("detail", "nothing matched")
    extra = ""
    if ctx.health.get("stale"):
        extra = ("<p>The index is <b>not known to be level with the node</b>, so "
                 "this may be a transaction or block the index has not reached "
                 "yet rather than one that does not exist.</p>")
    body = banner("warn", "<b>Not found.</b> %s.%s" % (esc(detail), extra))
    body += _search_help(ctx)
    return 404, shell(ctx, title="Not found - PCoin explorer", body=body,
                      h1="Nothing matched", kind="search", subhead=esc(q))


def _search_help(ctx):
    return ('<div class="panel"><div class="pad prose">'
            "<p>The search box takes any one of:</p><ul>"
            "<li>a <b>block height</b> &mdash; a plain number, 0 to %s</li>"
            "<li>a <b>block hash</b> or <b>transaction id</b> &mdash; 64 hex "
            "characters, or at least 8 characters of one</li>"
            "<li>a <b>PCoin address</b> &mdash; <code>%s1&hellip;</code> "
            "(bech32) or a base58 address</li></ul>"
            "<p class='dim'>Addresses from other chains are rejected on purpose: "
            "PCoin shares Bitcoin's BIP32 version bytes, so a wrong-network "
            "address has to be caught loudly rather than quietly not matching.</p>"
            "</div></div>"
            % (num(ctx.tip), esc(addrmod.BECH32_HRP.get(ctx.chain, "pc"))))


# -- about ------------------------------------------------------------------

def about_page(ctx):
    h = ctx.health
    s = reads.summary(ctx.conn)
    lwma = s["lwma"]
    body = """
<div class="panel"><div class="pad prose">
<p>This is a block explorer for <b>PCoin (PCN)</b>, an independent Layer-1
chain: its own genesis block, its own network, its own UTXO set. It is a fork
of Bitcoin Core v29.4 with proof-of-work replaced by <b>RandomX</b> (CPU
friendly, ASIC resistant) and the difficulty algorithm replaced by <b>LWMA</b>.
Block ids are still double-SHA256; only the proof-of-work hash changed.</p>

<h2>What this explorer is</h2>
<p>A server-rendered page over an address index built by polling a PCoin node
for <code>getblock &lt;hash&gt; 3</code>. Bitcoin Core has no address index of
its own &mdash; the chainstate is a UTXO set keyed by outpoint with no reverse
map from script to outpoints &mdash; so "what does this address hold" has to be
answered outside the node.</p>
<ul>
<li>It is <b>read-only and non-custodial</b>. It never generates an address,
never holds a key, never signs and never broadcasts. It cannot move coins.</li>
<li>It does <b>not talk to the node</b> at all. Its only input is the index
file, opened read-only, so it holds no RPC credentials.</li>
<li>There is <b>no JavaScript</b> on any page.</li>
</ul>

<h2 id="mempool">What it cannot tell you</h2>
<p><b>There is no mempool index</b>, so unconfirmed transactions are invisible.
That is why an address page shows the unconfirmed balance as
<i>not indexed</i> rather than as <code>0.00000000</code>: nobody has answered
that question, and rendering an unanswered question as a definite zero is the
mistake that, in a wallet's send path, authorises spending the same coins
twice.</p>

<h2>Reorgs</h2>
<p>PCoin reorganises often &mdash; around a 3%% stale rate over its first ~2100
blocks &mdash; so the index unwinds losing branches by subtracting back the exact
per-address amounts it had added, rather than recomputing them. Orphaned blocks
are kept and still resolve to a page. %(reorgs)s</p>

<h2>Block pace and difficulty</h2>
<p>%(pace)s</p>

<h2>Coinbase maturity</h2>
<p>Mined coins need <b>%(maturity)s confirmations</b> before they can be spent.
Maturity is counted in blocks, which is the consensus rule; wherever a time
estimate appears next to it, it is derived from the pace measured on this chain
and never from the 600 s target alone, because the chain has not always run at
target.</p>

<h2>Index state right now</h2>
</div></div>
""" % {
        "reorgs": link("/reorgs", "See the reorg log."),
        "maturity": COINBASE_MATURITY,
        "pace": ("The difficulty only retargets every 2016 blocks until height "
                 "%s, where LWMA retargeting activates and starts adjusting "
                 "every block. Until then the pace cannot correct itself."
                 % num(lwma["height"])) if lwma.get("height") and not lwma.get("active")
                else ("LWMA retargeting is active, so the difficulty adjusts "
                      "every block."),
    }
    body += kv([
        ("Chain", esc(h.get("chain"))),
        ("Index height", num(h.get("indexed_height"))),
        ("Index tip hash", '<code>%s</code>' % esc(h.get("indexed_hash") or "")),
        ("Node height last observed", maybe(h.get("node_height"))),
        ("Blocks behind", maybe(h.get("blocks_behind"))),
        ("Last successful node poll",
         ("%s ago" % esc(duration(h.get("last_poll_age_seconds"))))
         if h.get("last_poll_age_seconds") is not None else "never"),
        ("Indexer status", "%s %s" % (esc(h.get("status")),
                                      note(h.get("status_detail") or ""))),
        ("Reorgs handled", num(h.get("reorg_count"))),
        ("Blocks unwound", num(h.get("blocks_unwound"))),
        ("Trustworthy right now",
         '<span class="badge badge-err">no &mdash; see the banner</span>'
         if h.get("stale") else '<span class="badge badge-ok">yes</span>'),
    ])
    return shell(ctx, title="About - PCoin explorer", body=body, active="/about",
                 h1="About this explorer", kind="pcoin")


def api_page(ctx):
    body = """
<div class="panel"><div class="pad prose">
<p>Read-only JSON over the same index. Every amount is returned twice: the plain
field is an exact integer of <b>satoshis</b> (<code>"fee": 584</code>) and the
matching <code>_pcn</code> field is a fixed-point decimal string
(<code>"fee_pcn": "0.00000584"</code>). No amount anywhere in these responses is
a floating point number, so none of them can lose a satoshi.</p>
<p>Every balance-shaped response carries a <code>health</code> object. If
<code>health.stale</code> is true the numbers are not known to be current and a
client must say so rather than render them as fact.</p>
<pre>GET /api/status                      index health
GET /api/chain                       tip, supply, pace, hashrate estimate
GET /api/blocks?page=1               block list
GET /api/block/&lt;height|hash&gt;         one block, with its txids
GET /api/txs?page=1&amp;payments=1       transaction list
GET /api/tx/&lt;txid&gt;                   one transaction, inputs with source addresses
GET /api/address/&lt;address&gt;           balance: confirmed, spendable, immature
GET /api/address/&lt;address&gt;/history   transaction history, paged
GET /api/address/&lt;address&gt;/utxos     unspent outputs, paged
GET /api/addresses?page=1            addresses ranked by balance
GET /api/reorgs                      reorg log and orphaned blocks
GET /api/search?q=&lt;anything&gt;         what the search box does</pre>
<p>There is no write surface here: no broadcast endpoint, no address generation,
no keys. A wallet derives its own addresses from its own twelve words
(BIP84, <code>m/84'/9444'/0'/0/i</code>) and this API answers questions about
the chain.</p>
<p>This is the small API that ships with the pages and needs nothing but the
index file. The full API &mdash; mempool-aware balances, multi-address gap
scans and signed-transaction relay &mdash; lives in the <code>pcoin_api</code>
package and can be mounted here so that one port serves both:</p>
<pre>python3 -m pcoin_explorer --db pcoin-index.sqlite serve \\
        --with-api -- --datadir ~/.pcoin</pre>
<p>With it mounted, every path under <code>/api</code> is answered by that
application instead, and this page is replaced by its discovery document.</p>
</div></div>
"""
    return shell(ctx, title="JSON API - PCoin explorer", body=body, h1="JSON API",
                 kind="pcoin")


def error_page(ctx, code, title, detail):
    body = banner("warn", "<b>%s</b><p class='muted'>%s</p>" % (esc(title),
                                                                esc(detail)))
    body += _search_help(ctx)
    return shell(ctx, title="%s - PCoin explorer" % title, body=body,
                 h1=esc(title), kind="error %s" % code)
