#!/bin/bash
# Publish PCoin's supply figures. CIRCULATING EQUALS TOTAL; immature coinbase is
# reported separately rather than deducted.
#
# THIS REVERSED A PREVIOUS DECISION, on purpose. An earlier version deducted the
# immature window, reasoning that CoinMarketCap's definition excludes coins that
# cannot be moved. That argument is sound in general and wrong here, and it also
# put pc.am 1.3% out of step with explorer.pc.am at the same block height --
# two official endpoints, both linked from the site, giving different answers to
# the one question every listing form asks.
#
# Why circulating == total is the right answer for PCoin specifically: there is
# no premine, no team allocation, no vesting and no locked tranche. The ONLY
# unspendable coins are the last 99 block rewards, and that window empties
# itself within a day. Deducting a rolling window that refills and drains makes
# the headline figure wobble permanently for something that is never true for
# more than a few hours per coin.
#
# This is also what the project already says in writing, in two places that a
# reviewer will read before this script: site/whitepaper/index.html -- "Circulating
# supply therefore equals total supply. There is no locked, reserved or otherwise
# non-circulating tranche to deduct" -- and site/docs/index.html. The explorer
# API agrees. This file was the only dissenter.
#
# total       = every coin ever issued and still in the UTXO set
# immature    = sum of coinbase outputs not yet spendable (99 blocks -- see below)
# circulating = total   (immature is published alongside, not subtracted)
#
# Freely-spendable coins are counted as circulating regardless of who holds
# them, which is the standard treatment for a mined coin (Bitcoin counts
# dormant and founder-mined coins the same way). Concentration is disclosed
# separately rather than by quietly shrinking this number.
set -euo pipefail

OUT=/var/www/pc.am/supply
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

CLI="sudo docker exec pcoin-seed bitcoin-cli"

INFO=$($CLI gettxoutsetinfo 2>/dev/null)
if [ -z "$INFO" ]; then
    echo "gettxoutsetinfo failed; leaving previous values in place" >&2
    exit 1
fi

TOTAL=$(printf '%s' "$INFO" | python3 -c 'import json,sys; print("%.8f" % json.load(sys.stdin)["total_amount"])')
HEIGHT=$(printf '%s' "$INFO" | python3 -c 'import json,sys; print(json.load(sys.stdin)["height"])')

# Immature: sum the coinbase outputs that are NOT YET SPENDABLE.
#
# The window is 99 blocks, not 100, and the off-by-one is decidable rather than a
# matter of taste. A coinbase at height h may be spent when spendHeight >=
# h + COINBASE_MATURITY. The next block to be mined is HEIGHT+1, so that coinbase
# is spendable iff h + 100 <= HEIGHT + 1, i.e. h <= HEIGHT-99. Heights
# HEIGHT-98..HEIGHT are therefore still immature: 99 blocks.
#
# Scanning 100 counted one coinbase that had already matured -- exactly the
# 50 PCN by which this file and explorer.pc.am disagreed.
MATURITY=100
IMMATURE_BLOCKS=$((MATURITY - 1))
IMMATURE=$(
  for i in $(seq 0 $((IMMATURE_BLOCKS - 1))); do
      H=$((HEIGHT - i))
      [ "$H" -lt 1 ] && continue
      $CLI getblock "$($CLI getblockhash $H)" 2
  done | python3 -c '
import json, sys
total = 0.0
dec = json.JSONDecoder()
buf = sys.stdin.read()
idx = 0
while idx < len(buf):
    while idx < len(buf) and buf[idx] in " \n\r\t":
        idx += 1
    if idx >= len(buf):
        break
    obj, idx = dec.raw_decode(buf, idx)
    total += sum(o["value"] for o in obj["tx"][0]["vout"])
print("%.8f" % total)
'
)

# Circulating IS total. Kept as its own variable so every consumer below reads
# one value and none of them can drift apart again.
CIRC="$TOTAL"

# Refuse to publish nonsense rather than overwrite good values with bad ones.
python3 - "$TOTAL" "$IMMATURE" "$CIRC" <<'PY'
import sys
t, i, c = (float(x) for x in sys.argv[1:4])
assert t > 0, "total is not positive"
assert 0 <= i <= t, "immature out of range"
assert abs(t - c) < 1e-6, "circulating must equal total"
assert i < t * 0.5, "immature is implausibly large"
PY

printf '%s' "$CIRC"     > "$TMP/circulating.txt"
printf '%s' "$TOTAL"    > "$TMP/total.txt"
printf '%s' "$IMMATURE" > "$TMP/immature.txt"
printf '%s' "21000000"  > "$TMP/max.txt"

python3 - "$TOTAL" "$IMMATURE" "$CIRC" "$HEIGHT" > "$TMP/supply.json" <<'PY'
import json, sys, time
total, immature, circ, height = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
print(json.dumps({
    "asset": "PCoin", "symbol": "PCN",
    "circulating_supply": float(circ),
    "total_supply": float(total),
    "immature_supply": float(immature),
    "max_supply": 21000000,
    "height": height,
    "methodology": (
        "total = every coin issued and present in the UTXO set, from the node's "
        "gettxoutsetinfo. circulating = total: there is no premine, no team "
        "allocation, no vesting and no locked or reserved supply of any kind, so "
        "there is no non-circulating tranche to deduct. All supply is mined by "
        "proof-of-work. immature = the coinbase outputs not yet spendable, which "
        "is the most recent 99 blocks (a coinbase at height h may be spent from "
        "height h+100, so at tip H the immature heights are H-98..H); it is "
        "reported here for completeness and is NOT subtracted from circulating. "
        "Freely-spendable coins are counted as circulating regardless of holder, "
        "the standard treatment for a mined asset. This matches "
        "explorer.pc.am/api/supply to the satoshi."
    ),
    "source": "full node, bitcoin-cli gettxoutsetinfo + 99-block coinbase scan",
    "updated_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
}, indent=1))
PY

sudo mkdir -p "$OUT"
for f in circulating.txt total.txt immature.txt max.txt supply.json; do
    sudo install -o www-data -g www-data -m 644 "$TMP/$f" "$OUT/$f"
done

echo "height=$HEIGHT total=$TOTAL immature=$IMMATURE circulating=$CIRC"
