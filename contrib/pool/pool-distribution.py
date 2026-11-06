#!/usr/bin/env python3
"""Who found PCoin's blocks? A reproducible pool-distribution report from the chain.

    python3 pool-distribution.py --days 30   --out-dir report/
    python3 pool-distribution.py --month 2026-10 --out-dir report-2026-10/
    python3 pool-distribution.py --from-height 15000 --to-height 15499 --out-dir r/

It needs only a PCoin node you control (RPC on 127.0.0.1:9443, cookie in the
datadir) and Python 3. It reads the coinbase of every block in the window and
attributes the block by what the coinbase PAYS -- nothing else. The rules are in
POOL-DISTRIBUTION.md next to this file; read that before quoting a number.

Writes into --out-dir:
  blocks.csv   one row per block: height, hash, time, who, how it was decided
  summary.csv  one row per party: blocks, share, 95% interval
  daily.csv    blocks per party per UTC day
  meta.json    the exact window, the node tip, the tool version

The attribution rules are the same as contrib/seed-monitoring/pcoin-concentration-watch
with ONE deliberate tightening: a block counts as a named pool's only if that
pool's address is the FEE output (a round percentage of the coinbase), not merely
if the address appears anywhere in it. Appearing anywhere is something anybody
can arrange for one satoshi.
"""
import argparse
import base64
import collections
import csv
import datetime
import decimal
import json
import math
import os
import sys
import urllib.request

TOOL_VERSION = "1"

# The public treasury address that pool.pc.am and pool2.pc.am pay their fee to.
# Both pools pay the SAME address and their coinbases carry no tag, so the chain
# cannot tell them apart and they are one line (see contrib/pool/pool.config.json).
TREASURY = "pc1qlvw6kx8wkcz8f6p0d6kswv69fjt33ll079f64e"

# Fee address -> (name, where the attribution comes from). A name is only here
# when the operator themselves published the address. An address nobody has
# claimed is reported as an unlabelled pool by its fee address, never guessed at.
# --labels FILE.json ({"pc1q...": ["name", "source"]}) adds to or overrides this.
KNOWN = {
    TREASURY: ("pool.pc.am + pool2.pc.am",
               "the project's pools; the fee address is the public treasury in contrib/pool/pool.config.json"),
    "pc1qdjd0peg79ln37y67k0uz7nfvsypndzx5s26qqa": (
        "ChatLab pool", "address posted by the operator in github.com/pars5555/pcoin/issues/6"),
    "pc1qclkpmsdklwehq54fztw5qw8ssnuwmee3szaz2e": (
        "AionCore pool", "address posted by the operator in github.com/pars5555/pcoin/issues/5"),
    # Named on the strength of a payment and on-chain behaviour rather than a public post by
    # the operator, and the source says so: the project paid this address the independent-pool
    # bounty (500 PCN, block 10241, tx 6cc641b29fa10277fdc572e09cd7bca3af1ac18a14f80e84d54b4af93e1573af,
    # 2026-09-30); the address mined solo until 2026-09-18 14:58 and became a pool fee output
    # from 15:10 the same day, the day this pool says it opened; and 19 of the 20 blocks
    # listed on pool.rabidmining.com are on it.
    "pc1q85lry2j8n5yphq44mk86vc6u3rwygwlnc5ryc7": (
        "Rabid Mining pool",
        "address the project paid the independent-pool bounty to on 2026-09-30 (block 10241, tx 6cc641b2...); "
        "it turned from solo mining into a pool fee output on 2026-09-18, the day the pool opened, and "
        "matches the blocks listed on pool.rabidmining.com"),
}

# How a pool's fee output is recognised: a round percentage of the coinbase
# (0.5% steps, up to 10%) give or take FEE_SLACK_SATS of rounding. A PPLNS split
# leaves less than 1 satoshi per miner over; a miner's share lands on a round
# percentage by accident roughly once in a million outputs.
FEE_STEPS = range(1, 21)          # k/200 of the coinbase: 0.5% .. 10%
FEE_SLACK_SATS = 1000


# --------------------------------------------------------------------- node RPC
class Rpc:
    def __init__(self, url, user, password):
        self.url = url
        tok = base64.b64encode(("%s:%s" % (user, password)).encode()).decode()
        self.headers = {"Content-Type": "application/json", "Authorization": "Basic " + tok}
        self._id = 0

    def _post(self, payload):
        req = urllib.request.Request(self.url, json.dumps(payload).encode(), self.headers)
        with urllib.request.urlopen(req, timeout=120) as r:
            # Decimal, not float: coinbase amounts are compared in satoshis.
            return json.loads(r.read().decode(), parse_float=decimal.Decimal)

    def call(self, method, *params):
        self._id += 1
        d = self._post({"jsonrpc": "1.0", "id": self._id, "method": method, "params": list(params)})
        if d.get("error"):
            raise RuntimeError("%s: %s" % (method, d["error"]))
        return d["result"]

    def batch(self, method, params_list):
        """Same method for many parameter lists, results in the order asked."""
        if not params_list:
            return []
        base = self._id
        calls = [{"jsonrpc": "1.0", "id": base + i, "method": method, "params": list(p)}
                 for i, p in enumerate(params_list, 1)]
        self._id += len(calls)
        out = {}
        for d in self._post(calls):
            if d.get("error"):
                raise RuntimeError("%s: %s" % (method, d["error"]))
            out[d["id"]] = d["result"]
        return [out[base + i] for i in range(1, len(calls) + 1)]


def connect(a):
    user, password = a.rpc_user, a.rpc_password
    if not (user and password):
        cookie = os.path.join(os.path.expanduser(a.datadir), ".cookie")
        try:
            user, _, password = open(cookie, encoding="utf-8").read().strip().partition(":")
        except OSError as e:
            sys.exit("cannot read the RPC cookie (%s). Pass --datadir, or --rpc-user and --rpc-password." % e)
    return Rpc(a.rpc_url, user, password)


# ------------------------------------------------------------------ attribution
def coinbase_outputs(block):
    """[(satoshis, address or None)] for the paying outputs of a verbosity-2 block."""
    txs = block.get("tx") or []
    if not txs:
        return []
    paying = []
    for o in txs[0].get("vout") or []:
        value = decimal.Decimal(o.get("value") or 0)
        if value <= 0:
            continue                       # the witness commitment is a zero-value OP_RETURN
        spk = o.get("scriptPubKey") or {}
        addr = spk.get("address")
        if not addr:
            addrs = spk.get("addresses") or []
            addr = addrs[0] if addrs else None
        paying.append((int(value * 100000000), addr))
    return paying


def fee_address(paying):
    """The address a pool pays its fee to, or None: the output within FEE_SLACK_SATS
    of a round percentage of the coinbase, the closest one winning."""
    total = sum(v for v, _ in paying)
    best = None
    for v, a in paying:
        if not a:
            continue
        for k in FEE_STEPS:
            d = abs(v - total * k // 200)
            if d <= FEE_SLACK_SATS and (best is None or d < best[0]):
                best = (d, a)
    return best[1] if best else None


def short(addr):
    return "%s...%s" % (addr[:10], addr[-6:])


def classify(paying, known):
    """-> (kind, label, fee_address, payout_address).

    kind is one of
      pool            a pool whose fee output is a known, named address
      pool_unlabelled a pool by its fee output; nobody has published that address
      pool_unknown    pool-shaped (3+ outputs) but no recognisable fee output
      solo            one miner paid directly (1-2 outputs, no fee output)
      unreadable      no paying output; dropped from every denominator
    """
    if not paying:
        return "unreadable", "(unreadable)", "", ""
    if len(paying) >= 2:
        fee = fee_address(paying)
        if fee:
            if fee in known:
                return "pool", known[fee][0], fee, ""
            return "pool_unlabelled", "unlabelled pool, fee address " + short(fee), fee, ""
        if len(paying) >= 3:
            return "pool_unknown", "pool-shaped, no recognisable fee output", "", ""
    addr = paying[0][1] or ""
    if addr == TREASURY:
        return "solo", "project miners (solo, paid straight to the treasury address)", "", addr
    return "solo", "solo miners", "", addr


def wilson(k, n, z=1.96):
    """95% interval, in percent, for k of n. Wilson, because the normal
    approximation misbehaves for the small counts a short window gives."""
    if not n:
        return 0.0, 0.0
    p = k / float(n)
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    w = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return 100 * max(0.0, (c - w) / d), 100 * min(1.0, (c + w) / d)


# ----------------------------------------------------------------------- window
def header_time(rpc, height):
    return rpc.call("getblockheader", rpc.call("getblockhash", height))["time"]


def first_height_at_or_after(rpc, ts, tip):
    """Lowest height whose block time is >= ts, by bisection. Block times are not
    monotonic in height (the future-time rule allows 15 minutes of noise), so the
    edge can be off by a few blocks; meta.json says so."""
    lo, hi = 0, tip + 1
    while lo < hi:
        mid = (lo + hi) // 2
        if header_time(rpc, mid) >= ts:
            hi = mid
        else:
            lo = mid + 1
    return lo


def resolve_window(rpc, a):
    tip = rpc.call("getblockcount")
    tip_hash = rpc.call("getblockhash", tip)
    tip_time = rpc.call("getblockheader", tip_hash)["time"]
    note = ""
    if a.from_height is not None or a.to_height is not None:
        lo = a.from_height if a.from_height is not None else 0
        hi = a.to_height if a.to_height is not None else tip
        how = "explicit heights"
    elif a.month:
        y, m = (int(x) for x in a.month.split("-"))
        start = datetime.datetime(y, m, 1, tzinfo=datetime.timezone.utc)
        end = datetime.datetime(y + (m == 12), 1 if m == 12 else m + 1, 1, tzinfo=datetime.timezone.utc)
        lo = first_height_at_or_after(rpc, int(start.timestamp()), tip)
        hi = first_height_at_or_after(rpc, int(end.timestamp()), tip) - 1
        if int(end.timestamp()) > tip_time:
            note = "month not finished: the window ends at the chain tip"
            hi = tip
        how = "calendar month %s (UTC)" % a.month
    else:
        lo = first_height_at_or_after(rpc, tip_time - a.days * 86400, tip)
        hi = tip
        how = "last %d days before the chain tip" % a.days
    if not (0 <= lo <= hi <= tip):
        sys.exit("empty or out-of-range window: %d..%d (tip %d)" % (lo, hi, tip))
    return lo, hi, how, note, tip, tip_hash


# ------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    w = ap.add_argument_group("window (pick one; default --days 30)")
    w.add_argument("--days", type=int, default=30)
    w.add_argument("--month", metavar="YYYY-MM")
    w.add_argument("--from-height", type=int)
    w.add_argument("--to-height", type=int)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--datadir", default="~/.pcoin", help="node datadir holding .cookie (default ~/.pcoin)")
    ap.add_argument("--rpc-url", default="http://127.0.0.1:9443")
    ap.add_argument("--rpc-user")
    ap.add_argument("--rpc-password")
    ap.add_argument("--labels", metavar="FILE.json", help='{"pc1q...": ["name", "source"]} to add or override')
    ap.add_argument("--batch", type=int, default=100)
    a = ap.parse_args()

    known = dict(KNOWN)
    if a.labels:
        with open(a.labels, encoding="utf-8") as fh:
            for addr, v in json.load(fh).items():
                known[addr] = (v[0], v[1] if len(v) > 1 else "--labels")

    rpc = connect(a)
    lo, hi, how, note, tip, tip_hash = resolve_window(rpc, a)
    n_total = hi - lo + 1
    print("window: heights %d..%d (%d blocks), %s" % (lo, hi, n_total, how), file=sys.stderr)

    rows = []
    for start in range(lo, hi + 1, a.batch):
        heights = list(range(start, min(start + a.batch, hi + 1)))
        hashes = rpc.batch("getblockhash", [[h] for h in heights])
        blocks = rpc.batch("getblock", [[bh, 2] for bh in hashes])
        for h, bh, blk in zip(heights, hashes, blocks):
            paying = coinbase_outputs(blk)
            kind, label, fee, payout = classify(paying, known)
            rows.append({"height": h, "hash": bh, "time": blk["time"], "kind": kind, "label": label,
                         "fee_address": fee, "payout_address": payout, "outputs": len(paying)})
        print("  %d/%d" % (len(rows), n_total), end="\r", file=sys.stderr)
    print(file=sys.stderr)

    # Re-check that the chain did not reorganise under us while we read it.
    if rpc.call("getblockhash", hi) != rows[-1]["hash"]:
        sys.exit("the chain reorganised while reading; run again")

    readable = [r for r in rows if r["kind"] != "unreadable"]
    n = len(readable)
    os.makedirs(a.out_dir, exist_ok=True)

    def utc(ts):
        return datetime.datetime.fromtimestamp(ts, datetime.timezone.utc)

    with open(os.path.join(a.out_dir, "blocks.csv"), "w", newline="", encoding="utf-8") as fh:
        cw = csv.writer(fh)
        cw.writerow(["height", "hash", "time_utc", "kind", "party", "fee_address", "payout_address_if_solo",
                     "paying_outputs"])
        for r in rows:
            cw.writerow([r["height"], r["hash"], utc(r["time"]).strftime("%Y-%m-%dT%H:%M:%SZ"), r["kind"],
                         r["label"], r["fee_address"], r["payout_address"], r["outputs"]])

    # Solo miners are one line: how many addresses is the interesting fact, not
    # the list (the list is in blocks.csv, on-chain anyway).
    solo_addrs = {r["payout_address"] for r in readable if r["label"] == "solo miners"}
    parties = collections.Counter(r["label"] for r in readable)
    first = {}
    for r in readable:
        first.setdefault(r["label"], r)
    with open(os.path.join(a.out_dir, "summary.csv"), "w", newline="", encoding="utf-8") as fh:
        cw = csv.writer(fh)
        cw.writerow(["party", "kind", "fee_address", "blocks", "share_percent", "ci95_low_percent",
                     "ci95_high_percent", "attribution"])
        for label, k in parties.most_common():
            r = first[label]
            ci = wilson(k, n)
            shown = label if label != "solo miners" else "solo miners (%d distinct addresses)" % len(solo_addrs)
            basis = known[r["fee_address"]][1] if r["fee_address"] in known else (
                "fee output = round percentage of the coinbase; nobody has published this address" if r["kind"] == "pool_unlabelled" else
                "the coinbase pays only the treasury address: a project machine mining solo" if label.startswith("project miners") else
                "coinbase pays 1-2 addresses, no fee output" if r["kind"] == "solo" else
                "3+ outputs but no fee output found")
            cw.writerow([shown, r["kind"], r["fee_address"], k, "%.2f" % (100.0 * k / n), "%.2f" % ci[0],
                         "%.2f" % ci[1], basis])

    daily = collections.Counter((utc(r["time"]).strftime("%Y-%m-%d"), r["label"]) for r in readable)
    with open(os.path.join(a.out_dir, "daily.csv"), "w", newline="", encoding="utf-8") as fh:
        cw = csv.writer(fh)
        cw.writerow(["date_utc", "party", "blocks"])
        for (day, label), k in sorted(daily.items()):
            cw.writerow([day, label, k])

    meta = {
        "tool": "contrib/pool/pool-distribution.py", "tool_version": TOOL_VERSION,
        "generated_utc": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "window": how, "from_height": lo, "to_height": hi, "blocks_in_window": n_total,
        "blocks_attributed": n, "blocks_unreadable": n_total - n,
        "from_time_utc": utc(rows[0]["time"]).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "to_time_utc": utc(rows[-1]["time"]).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "window_note": note or "block timestamps are not monotonic, so the first and last few blocks of a "
                               "time-based window can differ by a handful from another node's run",
        "node_tip_height": tip, "node_tip_hash": tip_hash,
        "labels_used": {addr: {"name": v[0], "source": v[1]} for addr, v in known.items()},
        "method": "see POOL-DISTRIBUTION.md",
    }
    with open(os.path.join(a.out_dir, "meta.json"), "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=2)
        fh.write("\n")

    print("%d blocks attributed (%d unreadable) in %s..%s" % (n, n_total - n, meta["from_time_utc"], meta["to_time_utc"]))
    for label, k in parties.most_common():
        shown = label if label != "solo miners" else "solo miners (%d addresses)" % len(solo_addrs)
        lo_ci, hi_ci = wilson(k, n)
        print("  %-62s %5d  %5.1f%%  (95%%: %.1f-%.1f%%)" % (shown[:62], k, 100.0 * k / n, lo_ci, hi_ci))
    print("wrote blocks.csv summary.csv daily.csv meta.json to %s" % a.out_dir)


if __name__ == "__main__":
    main()
