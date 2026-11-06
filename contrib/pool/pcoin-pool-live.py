#!/usr/bin/env python3
"""Render the "who finds the blocks" charts shown on the pc.am mining page.

    python3 pcoin-pool-live.py --out-dir /var/lib/pcoin-pool-live [--days 30]

Reads the last --days of blocks from a PCoin node you control, attributes each with the
SAME rules and labels as pool-distribution.py (it imports that file, so the website and
the published reports cannot disagree), and writes, atomically:

  distribution-bars.svg    share of blocks per party, with 95% intervals
  distribution-daily.svg   blocks per day, stacked by party
  distribution-*-narrow.svg  the same two, drawn for phone widths (the page chooses with <picture>)
  distribution.json        the same numbers, for anyone who wants them

THE PAGE SHOWS AN IMAGE, NOT SCRIPT. pc.am's mining page has no JavaScript and a policy
that allows scripts only from pc.am; an <img> cannot run code, so showing a server-drawn
SVG keeps that. Every file carries the time it was drawn, so a stale chart says it is stale.

A share of BLOCKS is not a share of hashrate; the charts say so, and link to the dated
reports under reports/pool-distribution/, which are the record. This is the moving view.
"""
import argparse
import collections
import datetime
import html
import importlib.machinery
import importlib.util
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))


def load_generator():
    for p in (os.environ.get("POOL_DISTRIBUTION"), os.path.join(HERE, "pool-distribution.py"),
              "/usr/local/bin/pcoin-pool-distribution"):
        if p and os.path.exists(p):
            loader = importlib.machinery.SourceFileLoader("pool_distribution", p)
            spec = importlib.util.spec_from_loader("pool_distribution", loader)
            mod = importlib.util.module_from_spec(spec)
            loader.exec_module(mod)
            return mod
    sys.exit("cannot find pool-distribution.py (set POOL_DISTRIBUTION)")


gen = load_generator()

# Display order and colours. The page is dark, but the image is self-contained (an <img>
# cannot read the page's CSS), so it draws its own panel. Colours are distinct from each
# other and keep their contrast on that panel.
PARTIES = [
    # id,        chart label,                 small line under it,            colour
    ("project",  "PCoin pools",               "pool.pc.am + pool2.pc.am",     "#8b5cf6"),
    ("rabid",    "Rabid Mining",              "independent pool",             "#2dd4bf"),
    ("chatlab",  "ChatLab",                   "independent pool",             "#f59e0b"),
    ("aioncore", "AionCore",                  "independent pool",             "#ec4899"),
    ("solo",     "Solo miners",               "paid directly, no pool",       "#60a5fa"),
    ("own",      "Project's own miners",      "solo, to the treasury",        "#c4b5fd"),
    ("other",    "Other pools",               "fee address not named",        "#7d8499"),
]
COLOR = {p[0]: p[3] for p in PARTIES}


def party_id(kind, label):
    """Map a generator classification to a chart party."""
    if kind == "pool":
        return {"pool.pc.am + pool2.pc.am": "project", "Rabid Mining pool": "rabid",
                "ChatLab pool": "chatlab", "AionCore pool": "aioncore"}.get(label, "other")
    if kind == "solo":
        return "own" if label.startswith("project miners") else "solo"
    return "other"          # pool_unlabelled, pool_unknown


# ------------------------------------------------------------------------------ data
def collect(rpc, days):
    tip = rpc.call("getblockcount")
    tip_hash = rpc.call("getblockhash", tip)
    tip_time = rpc.call("getblockheader", tip_hash)["time"]
    lo = gen.first_height_at_or_after(rpc, tip_time - days * 86400, tip)
    rows = []
    for start in range(lo, tip + 1, 100):
        hs = list(range(start, min(start + 100, tip + 1)))
        hashes = rpc.batch("getblockhash", [[h] for h in hs])
        for h, blk in zip(hs, rpc.batch("getblock", [[bh, 2] for bh in hashes])):
            kind, label, fee, payout = gen.classify(gen.coinbase_outputs(blk), gen.KNOWN)
            if kind == "unreadable":
                continue
            rows.append({"height": h, "time": blk["time"], "party": party_id(kind, label), "payout": payout})
    if rpc.call("getblockhash", tip) != tip_hash:
        sys.exit("the chain reorganised while reading; try again")
    return tip, tip_time, rows


def summarise(rows):
    n = len(rows)
    by = collections.Counter(r["party"] for r in rows)
    solo_addrs = len({r["payout"] for r in rows if r["party"] == "solo"})
    out = []
    for pid, name, sub, colour in PARTIES:
        k = by.get(pid, 0)
        if not k:
            continue
        lo, hi = gen.wilson(k, n)
        if pid == "solo":
            sub = "%d addresses, paid directly" % solo_addrs
        out.append({"id": pid, "name": name, "note": sub, "color": colour, "blocks": k,
                    "share": 100.0 * k / n, "ci_low": lo, "ci_high": hi})
    out.sort(key=lambda p: -p["blocks"])
    return out


def daily(rows):
    days = collections.defaultdict(collections.Counter)
    for r in rows:
        days[datetime.datetime.fromtimestamp(r["time"], datetime.timezone.utc).strftime("%Y-%m-%d")][r["party"]] += 1
    return [(d, days[d]) for d in sorted(days)]


# ------------------------------------------------------------------------------ SVG
INK, DIM, PANEL, TRACK, EDGE = "#e9ebf4", "#9aa2b8", "#11131d", "#1c1f2d", "#262a3b"
FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"


def esc(s):
    return html.escape(str(s), quote=True)


def nice_max(v):
    for step in (5, 10, 20, 25, 50, 100, 200, 250, 500):
        if v <= step * 4:
            m = ((v + step - 1) // step) * step
            return max(m, step), step
    return v, max(1, v // 4)


def svg_open(w, h, title, desc):
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" width="%d" height="%d" role="img" '
            'aria-labelledby="t d"><title id="t">%s</title><desc id="d">%s</desc>'
            '<rect width="%d" height="%d" rx="16" fill="%s"/>'
            '<rect x=".5" y=".5" width="%d" height="%d" rx="15.5" fill="none" stroke="%s"/>'
            % (w, h, w, h, esc(title), esc(desc), w, h, PANEL, w - 1, h - 1, EDGE))


def stamp(now_s, first, last, w, y, extra=""):
    t = ("as of %s UTC · blocks %s–%s%s" % (now_s, format(first, ","), format(last, ","), extra))
    return '<text x="%d" y="%d" font-size="12" fill="%s" font-family="%s">%s</text>' % (24, y, DIM, FONT, esc(t))


def bars_svg(parties, n, tip, first, now_s, days):
    w = 640
    top, row = 78, 52
    h = top + row * len(parties) + 92          # room under the axis labels for the footnote and the stamp
    maxshare = max(p["share"] for p in parties)
    scale_max = max(10, int(-(-maxshare // 10)) * 10)
    x0, bw = 224, 292                                  # bar track
    o = [svg_open(w, h, "Who found the blocks, last %d days" % days,
                  "Share of blocks found by each party over the last %d days, %s blocks. " % (days, format(n, ","))
                  + "; ".join("%s %.1f%%" % (p["name"], p["share"]) for p in parties)
                  + ". A share of blocks, not of hashrate.")]
    o.append('<text x="24" y="38" font-size="19" font-weight="700" fill="%s" font-family="%s">Who found the blocks</text>' % (INK, FONT))
    o.append('<text x="24" y="60" font-size="13" fill="%s" font-family="%s">Share of the last %s blocks (%d days). Whiskers: 95%% interval.</text>'
             % (DIM, FONT, format(n, ","), days))
    # faint scale lines
    for t in range(0, scale_max + 1, 10 if scale_max <= 60 else 20):
        x = x0 + bw * t / scale_max
        o.append('<line x1="%.1f" y1="%d" x2="%.1f" y2="%d" stroke="%s" stroke-width="1"/>' % (x, top - 10, x, top + row * len(parties) - 8, EDGE))
        o.append('<text x="%.1f" y="%d" font-size="11" fill="%s" text-anchor="middle" font-family="%s">%d%%</text>'
                 % (x, top + row * len(parties) + 8, DIM, FONT, t))
    for i, p in enumerate(parties):
        y = top + i * row
        cy = y + 14
        o.append('<circle cx="34" cy="%d" r="5" fill="%s"/>' % (cy - 5, p["color"]))
        o.append('<text x="48" y="%d" font-size="15" font-weight="600" fill="%s" font-family="%s">%s</text>' % (cy, INK, FONT, esc(p["name"])))
        o.append('<text x="48" y="%d" font-size="12" fill="%s" font-family="%s">%s</text>' % (cy + 17, DIM, FONT, esc(p["note"])))
        o.append('<rect x="%d" y="%d" width="%d" height="20" rx="10" fill="%s"/>' % (x0, cy - 12, bw, TRACK))
        fw = max(6.0, bw * p["share"] / scale_max)
        o.append('<rect x="%d" y="%d" width="%.1f" height="20" rx="10" fill="%s"/>' % (x0, cy - 12, fw, p["color"]))
        if p["blocks"] >= 8:                           # an interval on a handful of blocks is just noise
            xl = x0 + bw * p["ci_low"] / scale_max
            xh = x0 + bw * p["ci_high"] / scale_max
            o.append('<g stroke="%s" stroke-width="2" stroke-linecap="round" opacity=".92">'
                     '<line x1="%.1f" y1="%d" x2="%.1f" y2="%d"/><line x1="%.1f" y1="%d" x2="%.1f" y2="%d"/>'
                     '<line x1="%.1f" y1="%d" x2="%.1f" y2="%d"/></g>'
                     % (INK, xl, cy - 2, xh, cy - 2, xl, cy - 7, xl, cy + 3, xh, cy - 7, xh, cy + 3))
        o.append('<text x="%d" y="%d" font-size="16" font-weight="700" fill="%s" text-anchor="end" font-family="%s">%.1f%%</text>'
                 % (w - 24, cy - 1, INK, FONT, p["share"]))
        o.append('<text x="%d" y="%d" font-size="12" fill="%s" text-anchor="end" font-family="%s">%s blocks</text>'
                 % (w - 24, cy + 16, DIM, FONT, format(p["blocks"], ",")))
    yb = h - 30
    o.append('<text x="24" y="%d" font-size="12" fill="%s" font-family="%s">A share of blocks, not of hashrate. Independent pools are named from the chain; see the method.</text>' % (yb - 16, DIM, FONT))
    o.append(stamp(now_s, first, tip, w, yb + 2))
    o.append("</svg>")
    return "".join(o)


def daily_svg(parties, series, tip, first, now_s, days):
    w, h = 640, 372
    left, right, top, bot = 46, 22, 74, 118
    plot_w, plot_h = w - left - right, h - top - bot
    order = [p["id"] for p in parties]
    totals = [sum(c.values()) for _, c in series]
    ymax, step = nice_max(max(totals))
    n = len(series)
    gap = 3
    cw = (plot_w - gap * (n - 1)) / n
    o = [svg_open(w, h, "Blocks per day by party, last %d days" % days,
                  "Stacked columns: blocks found each UTC day over the last %d days, by party. " % days
                  + "The first and last days are partial.")]
    o.append('<text x="24" y="36" font-size="19" font-weight="700" fill="%s" font-family="%s">Blocks per day</text>' % (INK, FONT))
    o.append('<text x="24" y="57" font-size="13" fill="%s" font-family="%s">By UTC day. The first and last columns are partial days.</text>' % (DIM, FONT))
    for t in range(0, ymax + 1, step):
        y = top + plot_h - plot_h * t / ymax
        o.append('<line x1="%d" y1="%.1f" x2="%d" y2="%.1f" stroke="%s" stroke-width="1"/>' % (left, y, w - right, y, EDGE))
        o.append('<text x="%d" y="%.1f" font-size="11" fill="%s" text-anchor="end" font-family="%s">%d</text>' % (left - 8, y + 4, DIM, FONT, t))
    for i, (d, c) in enumerate(series):
        x = left + i * (cw + gap)
        y = top + plot_h
        partial = i in (0, n - 1)
        for pid in order:
            k = c.get(pid, 0)
            if not k:
                continue
            hh = plot_h * k / ymax
            y -= hh
            o.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" fill="%s"%s/>'
                     % (x, y, cw, max(hh, .6), COLOR[pid], ' opacity=".55"' if partial else ""))
        if i % 5 == 0 or i == n - 1:
            lab = datetime.datetime.strptime(d, "%Y-%m-%d").strftime("%b %d").replace(" 0", " ")
            o.append('<text x="%.1f" y="%d" font-size="11" fill="%s" text-anchor="middle" font-family="%s">%s</text>'
                     % (x + cw / 2, top + plot_h + 18, DIM, FONT, lab))
    # legend, wrapped by measured-ish width
    lx, ly = 24, top + plot_h + 44
    for p in parties:
        wlab = 22 + 7.2 * len(p["name"])
        if lx + wlab > w - 20:
            lx, ly = 24, ly + 22
        o.append('<rect x="%d" y="%d" width="11" height="11" rx="3" fill="%s"/>' % (lx, ly - 9, p["color"]))
        o.append('<text x="%d" y="%d" font-size="12" fill="%s" font-family="%s">%s</text>' % (lx + 17, ly + 1, INK, FONT, esc(p["name"])))
        lx += wlab + 14
    o.append(stamp(now_s, first, tip, w, h - 16))
    o.append("</svg>")
    return "".join(o)


# --- narrow versions, for phones --------------------------------------------------------
# A 640-wide image shrunk into a 340px column makes 12-15px text about 6-8px. These are drawn at
# 360 wide so a phone shows them at about their real size; the page picks one with <picture>.
def bars_svg_narrow(parties, n, tip, first, now_s, days):
    w, top, row = 360, 76, 64
    x0, bw = 20, 320
    h = top + row * len(parties) + 74
    maxshare = max(p["share"] for p in parties)
    scale_max = max(10, int(-(-maxshare // 10)) * 10)
    o = [svg_open(w, h, "Who found the blocks, last %d days" % days,
                  "Share of blocks found by each party over the last %d days, %s blocks. " % (days, format(n, ","))
                  + "; ".join("%s %.1f%%" % (p["name"], p["share"]) for p in parties)
                  + ". A share of blocks, not of hashrate.")]
    o.append('<text x="20" y="34" font-size="18" font-weight="700" fill="%s" font-family="%s">Who found the blocks</text>' % (INK, FONT))
    o.append('<text x="20" y="55" font-size="12.5" fill="%s" font-family="%s">Last %d days · %s blocks · whiskers: 95%% interval</text>'
             % (DIM, FONT, days, format(n, ",")))
    for i, p in enumerate(parties):
        y = top + i * row
        o.append('<circle cx="26" cy="%d" r="5" fill="%s"/>' % (y + 6, p["color"]))
        o.append('<text x="40" y="%d" font-size="15" font-weight="600" fill="%s" font-family="%s">%s</text>' % (y + 11, INK, FONT, esc(p["name"])))
        o.append('<text x="%d" y="%d" font-size="16" font-weight="700" fill="%s" text-anchor="end" font-family="%s">%.1f%%</text>' % (w - 20, y + 11, INK, FONT, p["share"]))
        o.append('<rect x="%d" y="%d" width="%d" height="14" rx="7" fill="%s"/>' % (x0, y + 21, bw, TRACK))
        o.append('<rect x="%d" y="%d" width="%.1f" height="14" rx="7" fill="%s"/>' % (x0, y + 21, max(5.0, bw * p["share"] / scale_max), p["color"]))
        if p["blocks"] >= 8:
            xl, xh = x0 + bw * p["ci_low"] / scale_max, x0 + bw * p["ci_high"] / scale_max
            o.append('<g stroke="%s" stroke-width="2" stroke-linecap="round" opacity=".92"><line x1="%.1f" y1="%d" x2="%.1f" y2="%d"/>'
                     '<line x1="%.1f" y1="%d" x2="%.1f" y2="%d"/><line x1="%.1f" y1="%d" x2="%.1f" y2="%d"/></g>'
                     % (INK, xl, y + 28, xh, y + 28, xl, y + 24, xl, y + 32, xh, y + 24, xh, y + 32))
        o.append('<text x="20" y="%d" font-size="12" fill="%s" font-family="%s">%s · %s blocks</text>'
                 % (y + 52, DIM, FONT, esc(p["note"]), format(p["blocks"], ",")))
    y = top + row * len(parties) + 14
    o.append('<text x="20" y="%d" font-size="12" fill="%s" font-family="%s">A share of blocks, not of hashrate.</text>' % (y, DIM, FONT))
    o.append('<text x="20" y="%d" font-size="12" fill="%s" font-family="%s">as of %s UTC</text>' % (y + 18, DIM, FONT, esc(now_s)))
    o.append('<text x="20" y="%d" font-size="12" fill="%s" font-family="%s">blocks %s–%s</text>' % (y + 36, DIM, FONT, format(first, ","), format(tip, ",")))
    o.append("</svg>")
    return "".join(o)


def daily_svg_narrow(parties, series, tip, first, now_s, days):
    w = 360
    left, right, top = 36, 16, 78
    plot_h = 176
    order = [p["id"] for p in parties]
    ymax, step = nice_max(max(sum(c.values()) for _, c in series))
    n = len(series)
    gap = 1.5
    cw = (w - left - right - gap * (n - 1)) / n
    legend_rows = (len(parties) + 1) // 2
    h = top + plot_h + 30 + legend_rows * 22 + 54
    o = [svg_open(w, h, "Blocks per day by party, last %d days" % days,
                  "Stacked columns: blocks found each UTC day over the last %d days, by party. The first and last days are partial." % days)]
    o.append('<text x="20" y="34" font-size="18" font-weight="700" fill="%s" font-family="%s">Blocks per day</text>' % (INK, FONT))
    o.append('<text x="20" y="55" font-size="12.5" fill="%s" font-family="%s">By UTC day · first and last are partial days</text>' % (DIM, FONT))
    for t in range(0, ymax + 1, step):
        y = top + plot_h - plot_h * t / ymax
        o.append('<line x1="%d" y1="%.1f" x2="%d" y2="%.1f" stroke="%s" stroke-width="1"/>' % (left, y, w - right, y, EDGE))
        o.append('<text x="%d" y="%.1f" font-size="11" fill="%s" text-anchor="end" font-family="%s">%d</text>' % (left - 6, y + 4, DIM, FONT, t))
    for i, (d, c) in enumerate(series):
        x = left + i * (cw + gap)
        y = top + plot_h
        for pid in order:
            k = c.get(pid, 0)
            if k:
                hh = plot_h * k / ymax
                y -= hh
                o.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" fill="%s"%s/>'
                         % (x, y, cw, max(hh, .6), COLOR[pid], ' opacity=".55"' if i in (0, n - 1) else ""))
        if i % 10 == 0 or i == n - 1:
            lab = datetime.datetime.strptime(d, "%Y-%m-%d").strftime("%b %d").replace(" 0", " ")
            anchor = "start" if i == 0 else ("end" if i == n - 1 else "middle")
            o.append('<text x="%.1f" y="%d" font-size="11" fill="%s" text-anchor="%s" font-family="%s">%s</text>'
                     % (x + (0 if i == 0 else cw if i == n - 1 else cw / 2), top + plot_h + 18, DIM, anchor, FONT, lab))
    ly = top + plot_h + 46
    for i, p in enumerate(parties):
        lx = 20 if i % 2 == 0 else 190
        yy = ly + (i // 2) * 22
        o.append('<rect x="%d" y="%d" width="11" height="11" rx="3" fill="%s"/>' % (lx, yy - 9, p["color"]))
        o.append('<text x="%d" y="%d" font-size="12" fill="%s" font-family="%s">%s</text>' % (lx + 17, yy + 1, INK, FONT, esc(p["name"])))
    sy = ly + legend_rows * 22 + 6
    o.append('<text x="20" y="%d" font-size="12" fill="%s" font-family="%s">as of %s UTC</text>' % (sy, DIM, FONT, esc(now_s)))
    o.append('<text x="20" y="%d" font-size="12" fill="%s" font-family="%s">blocks %s–%s</text>' % (sy + 18, DIM, FONT, format(first, ","), format(tip, ",")))
    o.append("</svg>")
    return "".join(o)


# ------------------------------------------------------------------------------ main
def atomic_write(path, text):
    d = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".tmp-")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(text)
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--days", type=int, default=30)
    ap.add_argument("--datadir", default="~/.pcoin")
    ap.add_argument("--rpc-url", default="http://127.0.0.1:9443")
    ap.add_argument("--rpc-user")
    ap.add_argument("--rpc-password")
    a = ap.parse_args()

    rpc = gen.connect(a)
    tip, tip_time, rows = collect(rpc, a.days)
    if len(rows) < 50:
        sys.exit("only %d blocks readable; refusing to draw a chart from that" % len(rows))
    parties = summarise(rows)
    series = daily(rows)
    first = rows[0]["height"]
    now_s = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M")
    os.makedirs(a.out_dir, exist_ok=True)

    atomic_write(os.path.join(a.out_dir, "distribution-bars.svg"), bars_svg(parties, len(rows), tip, first, now_s, a.days))
    atomic_write(os.path.join(a.out_dir, "distribution-daily.svg"), daily_svg(parties, series, tip, first, now_s, a.days))
    atomic_write(os.path.join(a.out_dir, "distribution-bars-narrow.svg"), bars_svg_narrow(parties, len(rows), tip, first, now_s, a.days))
    atomic_write(os.path.join(a.out_dir, "distribution-daily-narrow.svg"), daily_svg_narrow(parties, series, tip, first, now_s, a.days))
    doc = {
        "generated_utc": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "window_days": a.days, "from_height": first, "to_height": tip, "blocks": len(rows),
        "from_time_utc": datetime.datetime.fromtimestamp(rows[0]["time"], datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "to_time_utc": datetime.datetime.fromtimestamp(rows[-1]["time"], datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "meaning": "share of BLOCKS found, not of hashrate; see contrib/pool/POOL-DISTRIBUTION.md",
        "record": "https://github.com/pars5555/pcoin/tree/main/reports/pool-distribution",
        "parties": [{k: (round(v, 2) if isinstance(v, float) else v) for k, v in p.items() if k != "color"} for p in parties],
        "daily": [{"date": d, **{pid: c.get(pid, 0) for pid, *_ in PARTIES if c.get(pid, 0)}} for d, c in series],
    }
    atomic_write(os.path.join(a.out_dir, "distribution.json"), json.dumps(doc, indent=1) + "\n")
    print("drew %d blocks (%d..%d), %d parties, %d days -> %s" % (len(rows), first, tip, len(parties), len(series), a.out_dir))


if __name__ == "__main__":
    main()
