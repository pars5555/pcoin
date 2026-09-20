#!/bin/bash
# Prove every refusal and CLAMP branch of `cap-policy.mjs --curve` FIRES.
#
# A check that has only ever been seen passing has not been tested, and this one
# decides the price the whole remaining book sells for. So each branch is driven
# against forced inputs, in a sandbox:
#
#   * a COPY of cap-policy.mjs in /tmp with STATE, LIVE_STATE, PUBLIC_RATE_URL
#     and CURVE_HISTORY repointed at files and stubs we control;
#   * never --apply, so nothing is ever written. The real settings table is read
#     (for the floor and the bounds) and never written.
#
# THREE INPUTS HAVE TO BE CONTROLLABLE or whole branches are unreachable:
#   * the 24h MEDIAN          -> the oracle state file
#   * what is CHARGED NOW     -> the stubbed /api/ladder/state
#   * the public serviceRate  -> the stubbed price.pc.am
# The first version of this harness stubbed only the first two, and the real
# $0.0336 serviceRate then capped every proposal through the divergence ceiling
# -- which made the 24h-ratchet window arithmetically unreachable. The branch
# looked dead when it was simply never being asked.
set -u
# Which cap-policy.mjs is under test. Defaults to the DEPLOYED copy, because
# "does the thing that is running still hold" is the question this answers most
# often. Point it at a candidate to prove a change before it goes anywhere:
#   SRC=/tmp/cap-policy.candidate.mjs ./curve-refusals.sh
SRC=${SRC:-/opt/pcoin-market/cap-policy.mjs}
[ -r "$SRC" ] || { echo "cannot read \$SRC: $SRC"; exit 1; }
echo "  under test: $SRC"
D=/tmp/curve-sandbox
rm -rf $D; mkdir -p $D
LPORT=18789      # stub /api/ladder/state
RPORT=18790      # stub price.pc.am

cat > $D/stub.mjs <<'JS'
import http from 'node:http';
import { readFileSync } from 'node:fs';
const serve = (port, file) => http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  try { res.end(readFileSync(file, 'utf8')); }
  catch (e) { res.statusCode = 500; res.end('{}'); }
}).listen(port, '127.0.0.1');
serve(18789, '/tmp/curve-sandbox/live.json');
serve(18790, '/tmp/curve-sandbox/rate.json');
JS

# Half-stubs. Both listeners live in one process, so killing it takes BOTH down
# -- and the rate is read BEFORE the live ladder state, so "the ladder is
# unreachable" then refuses for the rate instead and the branch is never
# reached. Each of the two cases that isolates one endpoint needs the other
# still answering.
cat > $D/stub-ladder-only.mjs <<'JS'
import http from 'node:http';
import { readFileSync } from 'node:fs';
http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(readFileSync('/tmp/curve-sandbox/live.json', 'utf8'));
}).listen(18789, '127.0.0.1');
JS

cat > $D/stub-rate-only.mjs <<'JS'
import http from 'node:http';
import { readFileSync } from 'node:fs';
http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(readFileSync('/tmp/curve-sandbox/rate.json', 'utf8'));
}).listen(18790, '127.0.0.1');
JS

sed -e "s#'/opt/pcoin-price/state.json'#'$D/oracle.json'#" \
    -e "s#'/opt/pcoin-market/curve-history.json'#'$D/curve-history.json'#" \
    -e "s#http://127.0.0.1:8789/api/ladder/state#http://127.0.0.1:$LPORT/api/ladder/state#g" \
    -e "s#https://price.pc.am/price#http://127.0.0.1:$RPORT/price#g" \
    "$SRC" > $D/cap.mjs
# ESM resolves bare specifiers by walking up from the IMPORTING file, so a copy
# in /tmp cannot find mysql2 however we cd into /opt/pcoin-market.
ln -sfn /opt/pcoin-market/node_modules $D/node_modules
node --check $D/cap.mjs || { echo "the sandbox copy does not parse"; exit 1; }
for pat in "$D/oracle.json" ":$LPORT/api" ":$RPORT/price" "$D/curve-history.json"; do
  grep -q -- "$pat" $D/cap.mjs || { echo "NOT REPOINTED: $pat -- refusing to run"; exit 1; }
done
# The URL, not the words: "price.pc.am" also appears in comments and in the
# refusal message that case [4] greps for, so matching the bare name refused to
# run on a perfectly correct rewrite.
if grep -q "https://price\.pc\.am" $D/cap.mjs; then
  echo "a real price.pc.am URL survived the rewrite -- refusing to run"; exit 1
fi

node $D/stub.mjs >/dev/null 2>&1 & STUB=$!
trap 'kill $STUB 2>/dev/null' EXIT
sleep 1

# --- the live curve, read once ---------------------------------------------
read -r K VIRT FLOOR KMIN KMAX <<<"$(cd /opt/pcoin-market && node -e "
import('/opt/pcoin-market/settings.mjs').then(async m=>{
  const fs=await import('node:fs'); const mysql=(await import('mysql2/promise')).default;
  const cfg=JSON.parse(fs.readFileSync('/opt/pcoin-market/config.json','utf8'));
  const p=mysql.createPool({...cfg.db,connectionLimit:2,decimalNumbers:false});
  const S=m.makeSettings(p,{warn:()=>{},error:console.error}); await S.reload();
  process.stdout.write([S.get('ammK'),S.get('ammVirtualPcn'),S.get('ladderMinPriceUsd'),
                        S.defs.ammK.min,S.defs.ammK.max].join(' '));
  await p.end();});")"

# X = sqrt(k/price); rem = X - virt. The inverse of price = k/X^2, so a case can
# name the price it wants CHARGED and get an inventory that really produces it.
# Without this the model check fires and every case refuses for the wrong reason
# -- which is exactly what happened to two cases in the first run.
remFor () { node -e "
  const k=$K, v=$VIRT, p=+process.argv[1];
  process.stdout.write(String(Math.sqrt(k/p)-v));" "$1"; }

mkoracle () { node -e "
    const n=+process.argv[2], p=+process.argv[1], now=Date.now();
    const s=[]; for(let i=0;i<n;i++) s.push({t: now-i*60000, p});
    require('fs').writeFileSync('$D/oracle.json', JSON.stringify({poolPrice:p, poolSamples:s}));
  " "$1" "$2"; }
mklive () { printf '{"marginalPrice":%s,"ladderRemainingPcn":%s,"askCapUsd":0.03}\n' "$1" "$2" > $D/live.json; }
mkrate () { printf '{"serviceRate":%s}\n' "$1" > $D/rate.json; }
charge () { mklive "$1" "$(remFor "$1")"; }

run () {
  local out rc
  out=$(cd /opt/pcoin-market && node $D/cap.mjs --curve "$@" 2>&1); rc=$?
  LAST_RC=$rc; LAST_OUT="$out"
}
expect () {  # label, expected exit, substring
  if [ "$LAST_RC" = "$2" ] && echo "$LAST_OUT" | grep -qi -- "$3"; then
    echo "  PASS  $1"
  else
    echo "  FAIL  $1"
    echo "        wanted exit $2 containing '$3', got exit $LAST_RC:"
    echo "$LAST_OUT" | grep -viE "^[[:space:]]*$" | tail -6 | sed 's/^/          | /'
    FAILED=$((FAILED+1))
  fi
}
FAILED=0

echo
echo "  === refusal and clamp branches of cap-policy.mjs --curve ==="
echo "  live curve: k=$K virt=$VIRT floor=\$$FLOOR  (ammK bounds $KMIN .. $KMAX)"
echo

# What every case starts from unless it overrides: a $0.030 pool, a $0.030
# public rate, and the curve charging $0.0336.
reset () { mkoracle 0.030 1441; mkrate 0.030; charge 0.0336; rm -f $D/curve-history.json; }

echo "  [1] the live ladder state is unreachable (the rate still answers)"
reset; kill $STUB 2>/dev/null; sleep 1
node $D/stub-rate-only.mjs >/dev/null 2>&1 & ONLYR=$!; sleep 1
run; expect "unreachable live state refuses" 2 "cannot read the live ladder state"
kill $ONLYR 2>/dev/null; sleep 1
node $D/stub.mjs >/dev/null 2>&1 & STUB=$!; sleep 1

echo "  [2] too few pool samples to trust a median"
reset; mkoracle 0.030 200
run; expect "a short sample window refuses" 2 "pool samples in the last"

echo "  [3] the oracle state is unreadable"
reset; echo 'not json' > $D/oracle.json
run; expect "an unreadable oracle refuses" 2 "cannot read the oracle state"

echo "  [4] the public rate is unreadable (the ladder still answers)"
reset; kill $STUB 2>/dev/null; sleep 1
node $D/stub-ladder-only.mjs >/dev/null 2>&1 & ONLY=$!; sleep 1
run; expect "an unreadable serviceRate refuses" 2 "price.pc.am is unreadable"
kill $ONLY 2>/dev/null; sleep 1
node $D/stub.mjs >/dev/null 2>&1 & STUB=$!; sleep 1

echo "  [5] MODEL MISMATCH -- the service is not charging k/X^2"
reset; mklive 0.09 62910.51878714
run; expect "a model mismatch refuses" 2 "MODEL MISMATCH"

echo "  [6] the curve is already UNDER the floor, so the floor is what is charged"
reset; UNDER=$(node -e "process.stdout.write(String($FLOOR*0.7))")
mklive "$FLOOR" "$(remFor "$UNDER")"
mkoracle 0.005 1441; mkrate 0.005
run; expect "at the floor, exits clean rather than refusing" 0 "already AT THE FLOOR"

echo "  [7] a drop bigger than the per-run limit is CLAMPED, not refused"
# This used to refuse, and the refusal froze the ask permanently -- the next run
# measured the same too-large drop and refused again, for ever. It must now fall
# exactly MAX_DROP_PCT and leave the rest for later runs.
reset; charge 0.060; mkoracle 0.030 1441; mkrate 0.030
run; expect "a >8% single-run drop clamps" 0 "CLAMPED per-run"
expect "...and proposes rather than refusing" 0 "Proposal only"
# The clamped DESTINATION is what matters, not merely that it said CLAMPED:
# 0.060 less 8% is 0.0552. Assert the arrow's right-hand side and the applied
# move, NOT the "proposed" line -- that one is printed in §3, before any clamp
# exists, and still shows the full unclamped target ($0.0315 here). Asserting on
# it failed against perfectly correct behaviour on the first run of this case.
expect "...to exactly 8% below what is charged" 0 "> \$0.05520000"
expect "...and reports the applied move, not the wanted one" 0 "applied move           -8.00%"

echo "  [8] the 24h ratchet -- each step looks reasonable, the day does not"
# Within 8% of what is charged now, but more than 12% below the highest price
# applied in the last 24h. The rate is set high so the ceiling stays out of it.
reset; charge 0.0555; mkoracle 0.050190 1441; mkrate 0.050
cat > $D/curve-history.json <<JSON
[{"t": $(($(date +%s)*1000 - 3600000)), "price": 0.060, "k": 1, "X": 1, "forced": false}]
JSON
run; expect "the 24h ratchet clamps" 0 "CLAMPED 24h ratchet"
# 0.060 less 12% = 0.0528, and that is above the 8%/run floor of 0.051060, so
# the DAY is what binds here and the run limit is not reached.
expect "...to 12% below the 24h high" 0 "0.052800"

echo "  [8b] the day's drop budget is already spent -- nothing left to write"
# Charging the 24h floor already. The clamps leave no room, so it must exit
# CLEAN and write nothing, rather than proposing a zero move or refusing.
reset; charge 0.0528; mkoracle 0.030 1441; mkrate 0.030
cat > $D/curve-history.json <<JSON
[{"t": $(($(date +%s)*1000 - 3600000)), "price": 0.060, "k": 1, "X": 1, "forced": false}]
JSON
run; expect "an exhausted daily budget exits clean" 0 "budget is already spent"

echo "  [8c] a clamp may never RAISE the ask"
# The 24h clamp lifts toward a price applied up to 24 h ago, and the curve can
# fall on its own in between (inventory top-up grows X, so ammK/X^2 drops). Here
# the 24h high is $0.060 but only $0.030 is charged now, so the 24h floor of
# $0.0528 sits ABOVE the live price: clamping to it would be a +76% RAISE, which
# is the one thing this mode must never do. It must take the no-move instead.
reset; charge 0.030; mkoracle 0.0267 1441; mkrate 0.0267
cat > $D/curve-history.json <<JSON
[{"t": $(($(date +%s)*1000 - 3600000)), "price": 0.060, "k": 1, "X": 1, "forced": false}]
JSON
run; expect "a clamp above the live price writes nothing" 0 "budget is already spent"
if echo "$LAST_OUT" | grep -qE '^  ammK '; then
  echo "  FAIL  ...and proposes no ammK at all"
  echo "$LAST_OUT" | grep -E '^  ammK ' | sed 's/^/          | /'
  FAILED=$((FAILED+1))
else
  echo "  PASS  ...and proposes no ammK at all"
fi

echo "  [9] --force-drop is what gets past them, and it still writes nothing"
reset; charge 0.060; mkoracle 0.030 1441; mkrate 0.030
run --force-drop; expect "--force-drop clears the gates, writes nothing without --apply" 0 "Proposal only"

echo "  [10] the curve is switched OFF (ammK = 0) -- not this tool's call to make"
sed -e "s#S.get('ammK')#0#" $D/cap.mjs > $D/cap-nok.mjs
node --check $D/cap-nok.mjs && {
  reset
  LAST_OUT=$(cd /opt/pcoin-market && node $D/cap-nok.mjs --curve 2>&1); LAST_RC=$?
  expect "ammK=0 refuses rather than switching the curve on" 2 "curve is OFF"
}

echo "  [11] a legitimate drop is PROPOSED and not applied"
reset; charge 0.0330; mkoracle 0.0310 1441; mkrate 0.0310
run; expect "a legitimate drop proposes only" 0 "Proposal only"

echo "  [12] no drop needed -- the tool never raises the price"
reset; charge 0.0300; mkoracle 0.0400 1441; mkrate 0.0400
run; expect "a higher pool does NOT raise the ask" 0 "only ever moves the price DOWN"

echo
if [ $FAILED -gt 0 ]; then echo "  $FAILED BRANCH(ES) DID NOT FIRE"; exit 1; fi
echo "  every refusal and clamp branch fired"
echo
echo "  and the real settings were never written:"
cd /opt/pcoin-market && node -e "
import('/opt/pcoin-market/settings.mjs').then(async m=>{
  const fs=await import('node:fs'); const mysql=(await import('mysql2/promise')).default;
  const cfg=JSON.parse(fs.readFileSync('/opt/pcoin-market/config.json','utf8'));
  const p=mysql.createPool({...cfg.db,connectionLimit:2,decimalNumbers:false});
  const S=m.makeSettings(p,{warn:()=>{},error:console.error}); await S.reload();
  console.log('    ammK              ', S.get('ammK'));
  console.log('    ladderMinPriceUsd ', S.get('ladderMinPriceUsd'));
  await p.end();});"
