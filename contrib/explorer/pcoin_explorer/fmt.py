"""Escaping and human formatting.

Everything that reaches the HTML goes through ``esc`` (or a helper here that
calls it). There is no template engine and no client-side rendering, so this
module is the only place an unescaped string could get out.

Three rules that come straight from CLAUDE.md and are enforced here rather
than left to each call site:

1. **Amounts are never floats.** Satoshi integers in, fixed-point strings out,
   via ``pcoin_indexer.amounts.from_sat``.
2. **Unknown is not zero** (CLAUDE.md 7.1/7.2). ``maybe`` renders ``None`` as a
   visible em dash, never as ``0``, so a missing answer can never be read as a
   definite one.
3. **Block timestamps are not monotonic in height** (CLAUDE.md 3), so a
   "seconds since" can legitimately be negative. ``ago`` says "in 4 min" rather
   than clamping to zero and pretending the block is old.
"""

import html
import time

from pcoin_indexer.amounts import from_sat

DASH = "—"  # em dash: "we do not know", never "zero"


def esc(value):
    """HTML-escape any value, including quotes (safe in an attribute)."""
    if value is None:
        return ""
    return html.escape(str(value), quote=True)


def maybe(value, dash=DASH):
    """An unknown value renders as a dash, never as a zero."""
    return dash if value is None else esc(value)


# -- amounts ---------------------------------------------------------------

def pcn(sat, *, group=False):
    """Satoshis -> a plain fixed-point PCN string. Never a float."""
    if sat is None:
        return None
    s = from_sat(int(sat))
    if not group:
        return s
    whole, frac = s.split(".")
    neg = whole.startswith("-")
    if neg:
        whole = whole[1:]
    out = "{:,}".format(int(whole))
    return ("-" if neg else "") + out + "." + frac


def amount_html(sat, *, group=False, sign=False, unit=True):
    """Render an amount with the fractional part dimmed.

    Copy/paste still yields the exact string, because the two spans are
    adjacent with no whitespace between them.
    """
    if sat is None:
        return '<span class="amt dim">%s</span>' % DASH
    s = pcn(sat, group=group)
    neg = s.startswith("-")
    if neg:
        s = s[1:]
    whole, frac = s.split(".")
    prefix = "-" if neg else ("+" if sign and int(sat) > 0 else "")
    cls = "amt" + (" neg" if neg else (" pos" if sign and int(sat) > 0 else ""))
    return ('<span class="%s">%s%s<span class="amt-f">.%s</span>%s</span>'
            % (cls, esc(prefix), esc(whole), esc(frac),
               '<span class="unit"> PCN</span>' if unit else ""))


# -- numbers ---------------------------------------------------------------

def num(value):
    if value is None:
        return DASH
    return "{:,}".format(int(value))


def sig(value, digits=6):
    """A float with a fixed number of significant digits, never in a way that
    turns a small difficulty into '0'."""
    if value is None:
        return DASH
    try:
        f = float(value)
    except (TypeError, ValueError):
        return esc(value)
    if f == 0:
        return "0"
    return "%.*g" % (digits, f)


def size_bytes(n):
    if n is None:
        return DASH
    n = float(n)
    for unit, step in (("B", 1), ("kB", 1000), ("MB", 1000 ** 2), ("GB", 1000 ** 3)):
        if n < step * 1000 or unit == "GB":
            v = n / step
            return ("%d %s" % (round(v), unit)) if v >= 100 else ("%.2f %s" % (v, unit))
    return "%d B" % n


def hashrate(hps):
    """Hashes/second with a sane unit. RandomX rates here are tens to
    thousands of H/s, not the TH/s a SHA-256d explorer assumes."""
    if hps is None:
        return DASH
    v = float(hps)
    for unit, step in (("H/s", 1.0), ("kH/s", 1e3), ("MH/s", 1e6),
                       ("GH/s", 1e9), ("TH/s", 1e12)):
        if v < step * 1000 or unit == "TH/s":
            return "%.4g %s" % (v / step, unit)
    return "%.4g H/s" % v


# -- time ------------------------------------------------------------------

def iso(ts):
    if ts is None:
        return DASH
    return time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime(int(ts)))


def duration(seconds, *, parts=2):
    """A rough human duration. Negative input keeps its sign rather than
    being clamped -- see the module docstring."""
    if seconds is None:
        return DASH
    s = int(seconds)
    neg = s < 0
    s = abs(s)
    units = (("y", 31_536_000), ("d", 86_400), ("h", 3_600), ("min", 60), ("s", 1))
    out = []
    for name, step in units:
        if s >= step:
            v, s = divmod(s, step)
            out.append("%d %s" % (v, name))
            if len(out) >= parts:
                break
    if not out:
        out = ["0 s"]
    return ("-" if neg else "") + " ".join(out)


def ago(ts, now=None):
    """'3 h ago', or 'in 4 min' when a header timestamp is ahead of the clock.

    Both happen on this chain: timestamps are only constrained to be above the
    median of the last 11 blocks and below now + 2 h (now + 15 min at heights
    >= lwmaHeight), so a block can legitimately be stamped in the future.
    """
    if ts is None:
        return DASH
    now = int(time.time()) if now is None else int(now)
    delta = now - int(ts)
    if -2 <= delta <= 2:
        return "just now"
    if delta < 0:
        return "in " + duration(-delta, parts=1)
    return duration(delta, parts=1) + " ago"


def time_cell(ts, now=None):
    """Absolute time is the fact; relative time is the convenience."""
    if ts is None:
        return '<span class="dim">%s</span>' % DASH
    return ('<span class="t" title="%s">%s</span><span class="t-rel">%s</span>'
            % (esc(iso(ts)), esc(iso(ts)), esc(ago(ts, now))))


# -- identifiers -----------------------------------------------------------

def shorten(text, head=10, tail=8):
    if text is None:
        return DASH
    text = str(text)
    if len(text) <= head + tail + 1:
        return esc(text)
    return esc(text[:head]) + "…" + esc(text[-tail:])


def confirmations_badge(n):
    if n is None:
        return '<span class="badge badge-unknown">unknown</span>'
    n = int(n)
    if n <= 0:
        return '<span class="badge badge-warn">%s conf</span>' % esc(n)
    cls = "badge-ok" if n >= 6 else "badge-soft"
    return '<span class="badge %s">%s conf</span>' % (cls, num(n))


def pct(part, whole, digits=2):
    if not whole:
        return DASH
    return "%.*f%%" % (digits, 100.0 * float(part) / float(whole))
