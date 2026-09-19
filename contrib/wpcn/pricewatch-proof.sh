#!/bin/bash
# Prove every alert in pcoin-price-watch FIRES, against forced inputs.
#
# Always --dry-run, so nothing reaches Telegram. Every case points the script at
# its OWN state file and, where needed, its own config, so production state is
# never touched. The low-float cases use a freshly generated keypair with no
# funds -- an address is all the script reads, it never signs anything.
set -u
D=/tmp/pricewatch-proof
rm -rf $D; mkdir -p $D
PY=/opt/wpcn/.venv/bin/python
W=/usr/local/bin/pcoin-price-watch
FAILED=0

seed () { printf '%s\n' "$1" > $D/state.json; }
run () { PRICE_WATCH_STATE=$D/state.json "$@" $PY $W --dry-run 2>&1; }
# A LIVE run that cannot send: an empty alert.conf means no token, so the script
# prints instead of posting -- and unlike --dry-run it SAVES STATE, which is the
# only way to exercise the damping at all. Production state is untouched because
# PRICE_WATCH_STATE is overridden.
: > $D/empty.conf
# PCOIN_NOTIFY points at nothing, so the script prints instead of sending -- and
# unlike --dry-run it SAVES STATE, which is the only way to exercise the damping.
# (It used to point PCOIN_ALERT_CONF at an empty file; the script no longer reads
# credentials at all, it shells out to the notifier.)
live () { PRICE_WATCH_STATE=$D/state.json PCOIN_NOTIFY=$D/no-notifier "$@" $PY $W 2>&1; }

expect () {   # label, must-contain
  if echo "$OUT" | grep -qi -- "$2"; then
    echo "  PASS  $1"
  else
    echo "  FAIL  $1  (wanted '$2')"
    echo "$OUT" | sed 's/^/          | /'
    FAILED=$((FAILED+1))
  fi
}
refute () {   # label, must-NOT-contain
  if echo "$OUT" | grep -qi -- "$2"; then
    echo "  FAIL  $1  (did NOT want '$2')"
    echo "$OUT" | sed 's/^/          | /'
    FAILED=$((FAILED+1))
  else
    echo "  PASS  $1"
  fi
}

echo
echo "  === pcoin-price-watch: does each alert fire? ==="
echo

# A keypair with no funds. Reading balances only; this never signs.
$PY -c "
from eth_account import Account
a = Account.create()
open('$D/keeper.conf','w').write('KEEPER_PRIVATE_KEY=' + a.key.hex() + '\n')
print('  (empty test wallet ' + a.address[:12] + '... generated for the float cases)')
"

echo "  [1] no change at all -> says so, alerts nothing"
# Establish state from the LIVE values rather than guessing band indexes -- the
# first version of this hardcoded pool_band=0 when the real band was 1, so the
# script correctly reported a crossing and the test called it a failure.
rm -f $D/state.json; live >/dev/null; live >/dev/null
OUT=$(live); expect "quiet tick reports no change" "no change"
refute "quiet tick sends nothing" "WOULD SEND"

echo "  [2] the pool FALLS through a band, and NAMES THE LINE IT CROSSED"
# Last seen in the top band (>= $0.035); it is now ~$0.0336, so the line crossed
# is $0.0350 -- not $0.0300, which is the boundary of the band it landed in and
# is what the first version wrongly printed.
seed '{"pool_band":0,"outside_band":0,"ask":0.033644771,"nagged":{}}'
OUT=$(run); expect "a fall is reported" "FELL THROUGH"
expect "and names the line actually crossed (0.0350)" "0.0350"
refute "not the boundary of the band it landed in" "FELL THROUGH \$0.0300"

echo "  [2b] the pool RISES back through a band"
seed '{"pool_band":3,"outside_band":0,"ask":0.033644771,"nagged":{}}'
OUT=$(run); expect "a rise is reported" "rose back above"

echo "  [3] outside-held wPCN crosses a band -- the early warning"
seed '{"pool_band":0,"outside_band":4,"ask":0.033644771,"nagged":{}}'
OUT=$(run); expect "outside supply crossing is reported" "OUTSIDE OUR WALLETS"
expect "and it names the number that matters" "9,709"

echo "  [4] the ask moves more than 1%"
seed '{"pool_band":0,"outside_band":0,"ask":0.050000000,"nagged":{}}'
OUT=$(run); expect "an ask move is reported" "PCN ask"

echo "  [5] the ask moves LESS than 1% -- must stay quiet"
seed '{"pool_band":0,"outside_band":0,"ask":0.033700000,"nagged":{}}'
OUT=$(run); refute "a small ask wobble is not news" "PCN ask"

echo "  [6] the keeper float is empty (USDT and gas)"
rm -f $D/state.json
OUT=$(KEEPER_CONF=$D/keeper.conf live); expect "low USDT fires" "keeper USDT"
expect "low BNB fires" "keeper BNB"

echo "  [7] ...and does NOT fire again on the next tick (damping)"
# Must be a LIVE run: --dry-run deliberately does not save state, so the nag
# timestamp never persists and damping cannot be observed from dry runs at all.
OUT=$(KEEPER_CONF=$D/keeper.conf live); refute "a persistent condition is not news twice" "keeper USDT"

echo "  [8] the BSC side is unreadable -> UNKNOWN, never 'unchanged'"
printf 'RPC=https://127.0.0.1:9/\nTOKEN=0x290A5779a419Cb9cB22fa087CDD1CD16dA2D95F1\nPAIR=0xB2c6C80cb31DE366Fb556Fff7C433660BAF60204\n' > $D/bad-wpcn.conf
seed '{"pool_band":0,"outside_band":0,"ask":0.033644771,"nagged":{}}'
OUT=$(WPCN_CONF=$D/bad-wpcn.conf run); expect "an unreadable chain is reported UNKNOWN" "UNREADABLE"
refute "and does not invent a price" "pool \$0.00"

echo "  [9] the market is unreadable -> the ask is UNKNOWN"
sed 's#https://market.pc.am/api/ladder/state#http://127.0.0.1:9/nope#' $W > $D/w-nomarket
seed '{"pool_band":0,"outside_band":0,"ask":0.033644771,"nagged":{}}'
OUT=$(PRICE_WATCH_STATE=$D/state.json $PY $D/w-nomarket --dry-run 2>&1)
expect "an unreadable market is reported UNKNOWN" "market.pc.am is UNREADABLE"

echo "  [10] a state file that PARSES but is missing keys must not crash"
seed '{}'
OUT=$(run); expect "a bare {} state is survived" "first reading"

echo "  [11] a corrupt state file must not crash either"
printf 'not json' > $D/state.json
OUT=$(run); expect "an unparseable state is survived" "first reading"

echo "  [12] --dry-run really sends nothing"
seed '{"pool_band":5,"outside_band":4,"ask":0.9,"nagged":{}}'
OUT=$(run); expect "dry run says WOULD SEND" "WOULD SEND"
refute "dry run does not report a real send" "notifier failed"

echo
if [ $FAILED -gt 0 ]; then echo "  $FAILED CHECK(S) DID NOT FIRE"; exit 1; fi
echo "  every alert fired, and the quiet cases stayed quiet"
echo "  production state file untouched:"
ls -la /var/lib/pcoin-price-watch/ 2>/dev/null | tail -2
