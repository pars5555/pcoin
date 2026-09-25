#!/usr/bin/env python3
"""Announce a payout, once it has actually been paid AND confirmed on chain.

    pcoin-payout-announce              one pass; run it from a timer
    pcoin-payout-announce --dry-run    print the post, queue nothing, remember nothing
    pcoin-payout-announce --status     what it knows, touching nothing

Owner, 2026-09-16: "whenever i submit in the admin that withdrawal approved and
sent then we should send message to telegram ... and when i submit in admin it
should send to me to approve."

So this does not post. It QUEUES a draft through pcoin-approve, and the owner's
Confirm in Telegram is what publishes it — the same gate every other public
message goes through.

WHY IT ANNOUNCES ON `paid` AND NOT WHEN THE TXID IS PASTED. Recording a payment
sets `paid_unverified`; the exchange then checks the chain that the right amount
reached the right address, and only then writes `paid`. Announcing the earlier
state would mean occasionally retracting a payment that did not verify, and a
retracted payout announcement costs more credibility than a late one gains.
In practice the gap is under a minute.

WHAT IT DELIBERATELY DOES NOT SAY. No email, no account, no destination address.
It reads `/api/payouts`, which is published precisely so this script needs no
admin token — a token that could list users and their addresses has no business
in something that writes marketing posts. The transaction id is OFF by default
for the same reason: it is public on the chain, but publishing it OURSELVES next
to "a PCoin user" ties a person's address to a person's business. Set
PAYOUT_ANNOUNCE_TXID=1 if the proof is worth more than that, which is a real
argument for a project whose main criticism is that there is no way out.

NO BACKLOG ON FIRST RUN. The first pass records what already exists and announces
none of it, so installing this cannot post a month of history at once.

A PCN PAYOUT THAT WAS A PURCHASE IS THANKED FOR, NOT JUST REPORTED. Owner,
2026-09-25: "every purchase in exchange should be reported if user withdrawal
the pcn". The exchange marks such a payout `purchase: true` (the buyer had
bought at least that much PCN on the book, for $20+, before asking to take it
out -- its lib/views.mjs purchaseWithdrawals has the whole rule), and this posts
the same thank-you market.pc.am's buyers get, with the SAME "N purchases" the
pinned banner shows: N comes from pcoin-listing-banner's own post_number(), fed
this run's snapshot of the payout feed, never from a count of our own. If N
cannot be read, the post is HELD (not sent without it, not sent as a plain
payout) and retried next run. Any other payout keeps the plain text.
"""
import importlib.machinery
import importlib.util
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from decimal import Decimal, InvalidOperation

FEED = os.environ.get("PAYOUT_FEED", "https://exchange.pc.am/api/payouts")
STATE = os.environ.get("PAYOUT_ANNOUNCE_STATE", "/var/lib/pcoin-payout-announce/state.json")
APPROVE = os.environ.get("PCOIN_APPROVE", "/usr/local/bin/pcoin-approve")
DEST = os.environ.get("PAYOUT_ANNOUNCE_DEST", "channel")
WITH_TXID = os.environ.get("PAYOUT_ANNOUNCE_TXID", "0") == "1"
MAX_PER_RUN = int(os.environ.get("PAYOUT_ANNOUNCE_MAX", "3"))
# The one program that counts purchases (see the docstring).
BANNER = os.environ.get("LISTING_BANNER", "/usr/local/bin/pcoin-listing-banner")

DRY = "--dry-run" in sys.argv


def load():
    try:
        s = json.load(open(STATE))
        if not isinstance(s, dict):
            raise ValueError("not an object")
    except Exception:                                        # noqa: BLE001
        s = {}
    s.setdefault("announced", [])
    s.setdefault("started", False)
    return s


def save(s):
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    tmp = STATE + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(s, fh)
    os.replace(tmp, STATE)


def waited(seconds):
    """How long the person waited, in words. Rounded honestly, never flattered."""
    m = max(0, int(seconds)) // 60
    if m < 1:
        return "in under a minute"
    if m < 60:
        return "%d minute%s later" % (m, "" if m == 1 else "s")
    h = m / 60.0
    if h < 24:
        return "%.1f hours later" % h
    return "%.1f days later" % (h / 24.0)


NETWORK = {"BEP20": "USDT on BNB Smart Chain", "TRC20": "USDT on TRON", "PCN": "PCN"}

# Where anybody can check the payment for themselves.
EXPLORER = {
    "BEP20": "https://bscscan.com/tx/%s",
    "TRC20": "https://tronscan.org/#/transaction/%s",
    "PCN": "https://explorer.pc.am/tx/%s",
}


def _total(x, places):
    """A running total for the tally line, or None when it is absent or zero.

    Decimal, never float: these are money, and 633.9 must print as 633.90.
    """
    try:
        d = Decimal(str(x))
    except (InvalidOperation, ValueError):
        return None
    if d <= 0:
        return None
    if places == 2:
        return "{:,.2f}".format(d)
    out = "{:,f}".format(d.normalize())
    return out.rstrip("0").rstrip(".") if "." in out else out


def is_purchase(p):
    """A PCN payout the exchange says was a purchase. `is True`, not truthiness:
    a feed from before 2026-09-25 has no field, and a missing field is "no"."""
    return p.get("asset") == "PCN" and p.get("purchase") is True


def purchase_text(p, n):
    """The thank-you for a purchase taken out of exchange.pc.am.

    The market's wording (pcoin-purchase-announce), with the venue and the one
    thing that makes it count here -- the buyer took the PCN to their own
    wallet. N is the banner's number, passed in, never counted here. Plain text,
    for the same reason as post_text.
    """
    n = int(n)
    lines = [
        "Someone bought PCN on exchange.pc.am and took it to their own wallet — thank you. \U0001F389",
        "",
        "That’s %d purchase%s on the road to a listing. Every one counts, and it’s real people "
        "choosing PCN that gets us there." % (n, "" if n == 1 else "s"),
    ]
    if WITH_TXID and p.get("txid"):
        # Same proof, same switch as every other payout post.
        lines += ["", "Check it on the chain:", EXPLORER.get(p["network"], "%s") % p["txid"]]
    lines += ["", "exchange.pc.am is open if you’d like to be next."]
    return "\n".join(lines)


def load_module(name, path):
    """Load a script that has no .py suffix, with its OWN argv (so the banner's
    `--dry-run in sys.argv` does not read ours)."""
    spec = importlib.util.spec_from_loader(name, importlib.machinery.SourceFileLoader(name, path))
    m = importlib.util.module_from_spec(spec)
    argv, sys.argv = sys.argv, [path]
    try:
        spec.loader.exec_module(m)
    finally:
        sys.argv = argv
    return m


def banner_number(feed):
    """(N, None) or (None, why). N is what the pinned bar shows or is about to.

    `feed` is this run's snapshot, handed to the banner so the exchange half of
    N is the very feed this payout came from -- not a second read a moment
    later that might disagree. Anything that goes wrong is a reason to HOLD.
    """
    try:
        lb = load_module("pcoin_listing_banner", BANNER)
    except Exception as e:                                   # noqa: BLE001
        return None, "cannot load %s (%s)" % (BANNER, type(e).__name__)
    try:
        return lb.post_number(feed), None
    except lb.Unreadable as e:
        return None, e.reason
    except SystemExit as e:                                  # a helper that still dies
        return None, "the banner's count exited (%s)" % (e.code,)


def post_text(p, total):
    """The post. Plain facts, no adjectives doing work the numbers should do."""
    amount =("$%s" % p["sent"].rstrip("0").rstrip(".")) if p["asset"] == "USD" else ("%s PCN" % p["sent"].rstrip("0").rstrip("."))
    # PLAIN TEXT, no markup. pcoin-approve can send Markdown or nothing, and
    # Telegram REFUSES a message whose Markdown does not balance -- this estate
    # has already had alerts silently dropped that way, and a refused post is
    # worse than an unformatted one. Telegram links a bare URL by itself.
    lines = [
        "\U0001f4b8 Paid out",
        "",
        # PCN needs no network clause: "1200 PCN - PCN, sent ..." reads as a bug.
        ("%s \u2014 sent %s." % (amount, waited(p["waitedSeconds"]))
         if p["asset"] == "PCN" else
         "%s \u2014 %s, sent %s." % (amount, NETWORK.get(p["network"], p["network"]), waited(p["waitedSeconds"]))),
        "",
        # WHAT HAPPENED DEPENDS ON THE ASSET. A USD payout is somebody who sold
        # PCN and took the dollars out. A PCN payout is the opposite direction:
        # on 2026-09-24 #19 and #20 were people who BOUGHT PCN with crypto and
        # took the PCN out, and both went out publicly as "mined PCN, sold it
        # and took the money out" -- the sentence written for the USD case.
        ("Somebody took PCN out of exchange.pc.am to their own wallet. "
         if p["asset"] == "PCN" else
         "Somebody mined PCN, sold it on exchange.pc.am, and took the money out. ")
        + "Every payout is checked against the chain before it counts as paid.",
    ]
    if WITH_TXID and p.get("txid"):
        # A bare hash is proof only to somebody who already knows what to do with
        # it. A link is proof anybody can click, which is the entire point of
        # publishing it at all. Telegram makes a bare URL clickable by itself.
        lines += ["", "Check it on the chain:", EXPLORER.get(p["network"], "%s") % p["txid"]]
    tally = []
    if total.get("count"):
        tally.append("%d payout%s so far" % (total["count"], "" if total["count"] == 1 else "s"))
    # Each total says what it counts. A bare "6200 PCN" beside a dollar
    # figure read as a price or a pending order: three people asked the group
    # what it meant on 2026-09-22, and it only moves when somebody withdraws
    # PCN itself, so it sat still through every USDT payout.
    usd_sent = _total(total.get("usdSent"), 2)
    pcn_sent = _total(total.get("pcnSent"), 8)
    if usd_sent:
        tally.append("$%s paid out in USDT" % usd_sent)
    if pcn_sent:
        tally.append("%s PCN paid out as PCN" % pcn_sent)
    if tally:
        lines += ["", "%s." % " \u00b7 ".join(tally)]
    return "\n".join(lines)


def read_feed():
    req = urllib.request.Request(FEED, headers={"accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.load(r)
    except Exception as e:                                   # noqa: BLE001
        # Unreadable is not "no payouts". Say so and change nothing.
        sys.exit("cannot read %s (%s); nothing announced, nothing recorded" % (FEED, type(e).__name__))


def main():
    st = load()
    feed = read_feed()
    payouts = feed.get("payouts") or []
    total = feed.get("total") or {}
    known = set(str(x) for x in st["announced"])

    if "--status" in sys.argv:
        print("  feed        : %s" % FEED)
        print("  destination : %s" % DEST)
        print("  txid in post: %s" % ("yes" if WITH_TXID else "no"))
        print("  paid so far : %s" % total.get("count"))
        print("  announced   : %d" % len(known))
        print("  started     : %s" % st["started"])
        return 0

    if not st["started"]:
        # First run: adopt the history, announce none of it.
        st["announced"] = [str(p["id"]) for p in payouts]
        st["started"] = True
        if not DRY:
            save(st)
        print("  first run: %d existing payout(s) recorded, none announced" % len(payouts))
        return 0

    fresh = [p for p in payouts if str(p["id"]) not in known]
    fresh.sort(key=lambda p: int(p["id"]))
    if not fresh:
        print("  nothing new")
        return 0

    done, held = 0, None
    n = None
    for p in fresh[:MAX_PER_RUN]:
        if is_purchase(p):
            if n is None:
                n, why = banner_number(feed)
                if n is None:
                    # HELD, not downgraded to a plain payout post: the owner asked
                    # for purchases to be reported AS purchases. Not recorded, so
                    # the next run tries again; later payouts wait behind it so
                    # the channel keeps its order.
                    held = "payout %s is a purchase and the purchase count cannot be read: %s" % (p["id"], why)
                    break
            text = purchase_text(p, n)
        else:
            text = post_text(p, total)
        if DRY:
            print("  would queue payout %s:\n%s\n" % (p["id"], text))
            done += 1
            continue
        r = subprocess.run(
            [APPROVE, "submit", "--dest", DEST, "--source", "pcoin-payout-announce",
             "--key", "payout-%s" % p["id"], "--text", text],
            capture_output=True, text=True, timeout=60)
        if r.returncode != 0:
            # Do NOT record it: an unqueued payout must be retried next run.
            print("  could not queue payout %s: %s" % (p["id"], (r.stderr or r.stdout).strip()[:200]),
                  file=sys.stderr)
            break
        st["announced"].append(str(p["id"]))
        done += 1
        print("  queued payout %s for approval" % p["id"])

    if not DRY and done:
        st["announced"] = st["announced"][-500:]
        save(st)
    print("  %d queued, %d waiting for the next run" % (done, max(0, len(fresh) - done)))
    if held:
        # Exit non-zero so a held post is not a quiet success in the journal.
        print("  HELD: %s" % held, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
