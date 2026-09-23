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
"""
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


def post_text(p, total):
    """The post. Plain facts, no adjectives doing work the numbers should do."""
    amount = ("$%s" % p["sent"].rstrip("0").rstrip(".")) if p["asset"] == "USD" else ("%s PCN" % p["sent"].rstrip("0").rstrip("."))
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
        "Somebody mined PCN, sold it on exchange.pc.am, and took the money out. "
        "Every payout is checked against the chain before it counts as paid.",
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

    done = 0
    for p in fresh[:MAX_PER_RUN]:
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
    return 0


if __name__ == "__main__":
    sys.exit(main())
