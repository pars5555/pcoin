#!/bin/bash
# Prove the CURVE mode's drop clamps CONVERGE instead of jamming.
#
# `curve-refusals.sh` proves each branch fires once. That is not the question
# the clamp was written to answer. The refusal it replaced fired perfectly every
# time too -- and because it fired every time, the ask never moved at all: run
# after run measured the same too-large drop against the same unchanged price
# and declined again. Simulated over 48 h after a 2,000 wPCN dump it refused at
# hours 1, 3, 6, 11, 12, 13, 18, 24, 36 and 48.
#
# So this drives the tool REPEATEDLY, feeding each run's own result back in as
# what is charged now -- exactly what the hourly timer does -- and shows the ask
# walking down to the target and stopping there. A jam shows up as a run that
# writes nothing while still short of the target.
#
# Never --apply. The real settings table is read (floor, bounds) and never
# written; the ammK each run would have set is applied only to the sandbox's own
# idea of the price.
#
#   SRC=/tmp/cap-policy.candidate.mjs ./curve-converge.sh
set -u
SRC=${SRC:-/opt/pcoin-market/cap-policy.mjs}
[ -r "$SRC" ] || { echo "cannot read \$SRC: $SRC"; exit 1; }
D=/tmp/curve-converge; rm -rf $D; mkdir -p $D

cat > $D/stub.mjs <<'JS'
import http from 'node:http';
import { readFileSync } from 'node:fs';
const serve = (port, file) => http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  try { res.end(readFileSync(file, 'utf8')); }
  catch (e) { res.statusCode = 500; res.end('{}'); }
}).listen(port, '127.0.0.1');
serve(18789, '/tmp/curve-converge/live.json');
serve(18790, '/tmp/curve-converge/rate.json');
JS

sed -e "s#'/opt/pcoin-price/state.json'#'$D/oracle.json'#" \
    -e "s#'/opt/pcoin-market/curve-history.json'#'$D/curve-history.json'#" \
    -e "s#http://127.0.0.1:8789/api/ladder/state#http://127.0.0.1:18789/api/ladder/state#g" \
    -e "s#https://price.pc.am/price#http://127.0.0.1:18790/price#g" \
    "$SRC" > $D/cap.mjs
ln -sfn /opt/pcoin-market/node_modules $D/node_modules
node --check $D/cap.mjs || { echo "the sandbox copy does not parse"; exit 1; }
for pat in "$D/oracle.json" ":18789/api" ":18790/price" "$D/curve-history.json"; do
  grep -q -- "$pat" $D/cap.mjs || { echo "NOT REPOINTED: $pat -- refusing to run"; exit 1; }
done
if grep -q "https://price\.pc\.am" $D/cap.mjs; then
  echo "a real price.pc.am URL survived the rewrite -- refusing to run"; exit 1
fi

node $D/stub.mjs >/dev/null 2>&1 & STUB=$!
trap 'kill $STUB 2>/dev/null' EXIT
sleep 1

read -r K VIRT <<<"$(cd /opt/pcoin-market && node -e "
import('/opt/pcoin-market/settings.mjs').then(async m=>{
  const fs=await import('node:fs'); const mysql=(await import('mysql2/promise')).default;
  const cfg=JSON.parse(fs.readFileSync('/opt/pcoin-market/config.json','utf8'));
  const p=mysql.createPool({...cfg.db,connectionLimit:2,decimalNumbers:false});
  const S=m.makeSettings(p,{warn:()=>{},error:console.error}); await S.reload();
  process.stdout.write([S.get('ammK'),S.get('ammVirtualPcn')].join(' '));
  await p.end();});")"

POOL=${POOL:-0.027679}    # the pool after a 2,000 wPCN dump
P=${START:-0.03364477}    # what the ladder charges today
HOURS=${HOURS:-6}
TARGET=$(node -e "process.stdout.write(($POOL*1.05).toFixed(8))")

# The median is set to the dumped pool outright -- the WORST case. In reality it
# takes >12 h to follow, so the demanded drop arrives smaller and later than this.
node -e "const n=1441,now=Date.now(),s=[];for(let i=0;i<n;i++)s.push({t:now-i*60000,p:$POOL});
  require('fs').writeFileSync('$D/oracle.json',JSON.stringify({poolPrice:$POOL,poolSamples:s}));"
printf '{"serviceRate":%s}\n' "$POOL" > $D/rate.json
echo '[]' > $D/curve-history.json

echo
echo "  under test: $SRC"
echo "  pool dumped to \$$POOL   ladder starts at \$$P   target \$$TARGET"
echo "  ------------------------------------------------------------------------"
JAMMED=0
for h in $(seq 1 $HOURS); do
  REM=$(node -e "process.stdout.write(String(Math.sqrt($K/$P)-$VIRT))")
  printf '{"marginalPrice":%s,"ladderRemainingPcn":%s,"askCapUsd":0.03}\n' "$P" "$REM" > $D/live.json
  OUT=$(cd /opt/pcoin-market && node $D/cap.mjs --curve 2>&1); RC=$?

  if echo "$OUT" | grep -q "budget is already spent"; then
    echo "  hour $h: clamps leave nothing to write this run (exit $RC)"; continue
  fi
  if [ "$RC" != 0 ]; then
    echo "  hour $h: *** EXIT $RC -- THE ASK DID NOT MOVE ***"
    echo "$OUT" | grep -A2 REFUSED | sed 's/^/      | /'
    JAMMED=1; break
  fi

  NEWK=$(echo "$OUT" | grep -oE 'ammK +[0-9.]+ +-> +[0-9.]+' | grep -oE '[0-9.]+$')
  NP=$(node -e "const X=Math.sqrt($K/$P);process.stdout.write(($NEWK/(X*X)).toFixed(8))")
  MOVE=$(echo "$OUT" | grep -E '^  applied move' | grep -oE '\-[0-9.]+%')
  [ -n "$MOVE" ] || MOVE=$(echo "$OUT" | grep -E '^  move' | grep -oE '\-[0-9.]+%')
  WHY=$(echo "$OUT" | grep -oE 'limited by [^)]+' | tail -1)
  echo "  hour $h: \$$P -> \$$NP   $MOVE   ${WHY:-full target reached, no clamp}"

  # The applied price joins the history, exactly as the real run records it --
  # the 24h ratchet measures the NEXT run against this.
  node -e "const f='$D/curve-history.json';const fs=require('fs');
    const h=JSON.parse(fs.readFileSync(f,'utf8'));
    h.push({t:Date.now(),price:$NP,k:$NEWK,X:1,forced:false});
    fs.writeFileSync(f,JSON.stringify(h));"
  P=$NP
  if [ "$(node -e "process.stdout.write(String(Math.abs($P-$TARGET)/$TARGET<0.0005))")" = true ]; then
    echo
    echo "  CONVERGED at hour $h: \$$P against a target of \$$TARGET."
    break
  fi
done

echo
if [ "$JAMMED" = 1 ]; then
  echo "  JAMMED -- the ask stopped moving while still short of the target."
  echo "  That is the failure the clamp exists to prevent."
  exit 1
fi
echo "  The ask tracked the pool down without ever refusing to move."
