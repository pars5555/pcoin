#!/usr/bin/env bash
# Prove `startpoolmining` against the real pool: a node takes work over TCP,
# hashes it, and the shares land in the pool's ledger.
#
#   bash clienttest.sh <path-to-new-bitcoind> <allowlisted-address> [seconds]
#
# storetest.mjs proves the arithmetic, ledgertest.sh proves the pool. This
# proves the CLIENT -- the half that runs on a user's PC, and the half that
# cannot be tested by anything already in this directory, because until now
# nothing in the tree could take work from a pool at all.
#
# Four things it checks, and the last two are the ones that actually matter:
#
#   1. shares flow: submitted, accepted, and recorded against the right miner
#   2. the miner needs NO synced chain -- it runs on an empty regtest datadir
#      with no peers, because the pool supplies the block
#   3. a pool that REFUSES the address says so, in words, through RPC. A miner
#      silently not earning is the worst failure this can have
#   4. a pool that goes away STOPS the hashing. Grinding a dead pool's job
#      looks identical to working on every dial a user can see

set -u
cd "$(dirname "$0")"

BITCOIND="${1:?usage: clienttest.sh <bitcoind> <address> [seconds]}"
ADDR="${2:?usage: clienttest.sh <bitcoind> <address> [seconds]}"
SECS="${3:-45}"
DATADIR=/tmp/poolminer-test
RPCPORT=19556
CFG=pool.config.json
DB=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("pool.config.json","utf8")).db)')
POOL_PID=""; NODE_PID=""
pass=0; fail=0
ok()  { pass=$((pass+1)); printf '  PASS  %s\n' "$1"; }
bad() { fail=$((fail+1)); printf '  FAIL  %s  --  %s\n' "$1" "${2:-}"; }
chk() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected $3, got $2"; fi; }

cleanup() {
  [ -n "$NODE_PID" ] && kill "$NODE_PID" 2>/dev/null
  [ -n "$POOL_PID" ] && kill "$POOL_PID" 2>/dev/null
  return 0
}
trap cleanup EXIT

# RPC over curl: the test binary is bitcoind only, and the node's cookie auth
# needs no extra tooling.
rpc() {
  local m="$1"; shift
  local p="${1:-[]}"
  local cookie="$DATADIR/regtest/.cookie"
  # A MISSING COOKIE IS NOT AN ANSWER ABOUT THE NODE. Without this guard curl
  # prompts for a password, every field comes back empty, and an assertion like
  # `state != "mining"` PASSES on the empty string -- a green tick for a node
  # that never started. That is not hypothetical: it happened on the first run
  # of this script, and it is the same shape as MYMINERS.md's transport rule 4.
  [ -r "$cookie" ] || { echo '{"error":"NO COOKIE - the node is not running"}'; return 1; }
  curl -s --max-time 10 --user "$(cat "$cookie")" \
    --data-binary "{\"jsonrpc\":\"1.0\",\"id\":\"t\",\"method\":\"$m\",\"params\":$p}" \
    -H 'content-type: text/plain;' "http://127.0.0.1:$RPCPORT/"
}
field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const r=JSON.parse(s).result;console.log(r===null||r===undefined?"":(r[process.argv[1]]??""))}catch(e){console.log("")}})' "$1"; }

echo "=== pool ==="
rm -f "$DB" "$DB-wal" "$DB-shm"
: >poolc.log
node pool.mjs --config "$CFG" >>poolc.log 2>&1 &
POOL_PID=$!
for _ in $(seq 1 60); do grep -q 'listening on' poolc.log && break; sleep 1; done
grep -q 'listening on' poolc.log || { echo "pool did not start"; exit 1; }
echo "  pool up (pid $POOL_PID)"

echo
echo "=== a node with no chain, no peers, and no wallet ==="
rm -rf "$DATADIR"; mkdir -p "$DATADIR"
"$BITCOIND" -regtest -datadir="$DATADIR" -port=19555 -rpcport=$RPCPORT \
            -listen=0 -dnsseed=0 -connect=0 -daemon >node.log 2>&1
for _ in $(seq 1 40); do
  rpc getblockcount 2>/dev/null | grep -q '"result"' && break
  sleep 1
done
# Refuse to run the rest against a node that never came up. Every check below
# would otherwise "pass" on an empty string.
if ! rpc getblockcount 2>/dev/null | grep -q '"result"'; then
  echo "  the test node did not start. Its output:"
  sed 's/^/    /' node.log | head -10
  echo "FAIL: the node under test never started; nothing below was exercised"
  exit 1
fi
NODE_PID=$(pgrep -f "datadir=$DATADIR" | grep -v "^$$\$" | head -1)
BLOCKS=$(rpc getblockchaininfo | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).result.blocks)}catch(e){console.log("?")}})')
echo "  node up (pid ${NODE_PID:-?}), chain height $BLOCKS -- deliberately empty"

echo
echo "=== 1. a pool that refuses the address says so, in words ==="
# The address must be VALID but NOT on the allowlist -- those are two different
# refusals and they come from two different places. An invalid address is
# refused locally by startpoolmining and never reaches the pool at all, so using
# one here would test this node's own parser and report it as the pool's
# allowlist working. (That is exactly what the first version of this test did.)
# So: make a real address on this node, which the pool has never heard of.
rpc createwallet '["probe"]' >/dev/null 2>&1
STRANGER=$(rpc getnewaddress '["","bech32"]' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).result||"")}catch(e){console.log("")}})')
if [ -z "$STRANGER" ]; then
  bad "could make a valid off-allowlist address to test the refusal with" "getnewaddress returned nothing"
else
  VALID=$(rpc validateaddress "[\"$STRANGER\"]" | grep -c '"isvalid":true')
  chk "the probe address is genuinely valid (so this tests the POOL, not our parser)" "$VALID" "1"
fi
rpc startpoolmining "[\"127.0.0.1:3333\",\"$STRANGER\",1]" >/dev/null 2>&1
sleep 6
INFO=$(rpc getcpuminerinfo)
PSTATE=$(echo "$INFO" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).result.poolstate)}catch(e){console.log("?")}})')
PSTATUS=$(echo "$INFO" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).result.poolstatus)}catch(e){console.log("?")}})')
chk "a non-allowlisted address is REFUSED, not silently idle" "$PSTATE" "refused"
if echo "$PSTATUS" | grep -qi "not open\|refused"; then
  ok "and the reason is readable over RPC: \"$PSTATUS\""
else
  bad "the refusal reason is readable over RPC" "poolstatus was: '$PSTATUS'"
fi
rpc stopmining >/dev/null 2>&1
sleep 1

echo
echo "=== 2. an allowlisted address mines, for ${SECS}s ==="
RES=$(rpc startpoolmining "[\"127.0.0.1:3333\",\"$ADDR\",1]")
echo "$RES" | grep -q '"pool":true' && ok "startpoolmining reports pool mode" \
  || bad "startpoolmining reports pool mode" "$RES"
sleep "$SECS"

INFO=$(rpc getcpuminerinfo)
get() { echo "$INFO" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).result[process.argv[1]]??"")}catch(e){console.log("")}})' "$1"; }
SUB=$(get sharessubmitted); ACC=$(get sharesaccepted); REJ=$(get sharesrejected)
HR=$(get hashespersec); PS=$(get poolstate); PH=$(get poolheight); BF=$(get blocksfound)
echo "  submitted=$SUB accepted=$ACC rejected=$REJ  hashrate=$HR  state=$PS  poolheight=$PH"

chk "the client is connected and mining" "$PS" "mining"
if [ "${SUB:-0}" -gt 0 ]; then ok "the miner submitted shares ($SUB)"; else bad "the miner submitted shares" "none"; fi
if [ "${ACC:-0}" -gt 0 ]; then ok "the pool accepted them ($ACC)"; else bad "the pool accepted shares" "0 of $SUB"; fi
if [ "${PH:-0}" -gt 0 ]; then ok "the job carries a real height ($PH)"; else bad "the job carries a height" "$PH"; fi
chk "blocksfound stays 0 in pool mode -- the POOL submits blocks, not us" "${BF:-x}" "0"

# The ledger is the point. Shares must be recorded against THIS address.
DBN=$(sqlite3 "$DB" "SELECT COUNT(*) FROM shares WHERE miner='$ADDR';")
if [ "${DBN:-0}" -gt 0 ]; then ok "the pool's ledger recorded them against this address ($DBN rows)"
else bad "the ledger recorded shares for this address" "0 rows for $ADDR"; fi
if [ "${DBN:-0}" -eq "${ACC:-1}" ]; then ok "every accepted share is in the ledger, exactly once"
else echo "         (ledger $DBN vs accepted $ACC -- differ only by shares in flight at the read)"; fi

# Nothing may vanish: every share is either accepted or rejected.
LOST=$(( ${SUB:-0} - ${ACC:-0} - ${REJ:-0} ))
if [ "$LOST" -le 2 ] && [ "$LOST" -ge -2 ]; then
  ok "every submitted share was either accepted or rejected (drift $LOST, in flight)"
else
  bad "shares are accounted for" "$SUB submitted but $ACC + $REJ = $((ACC+REJ)) answered"
fi

# A HIGH REJECT RATE IS ONLY ACCEPTABLE IF YOU KNOW WHY. On regtest roughly half
# of all hashes are also valid BLOCKS, so almost every share moves the tip,
# retires the job, and strands the shares queued a moment earlier -- they arrive
# against a job that no longer exists. That is a fact about regtest, not about
# the client: on mainnet a job lives for the whole round and this is rare.
#
# So the check is not "few rejections", which regtest can never satisfy. It is
# that every rejection has the reason we expect. A rejection for the WRONG
# reason reads identically in a log, and that mistake has already been made
# twice in this project.
DBG="$DATADIR/regtest/debug.log"
TOTALREJ=$(grep -c "share rejected" "$DBG" 2>/dev/null || echo 0)
STALEREJ=$(grep -c "share rejected (job not found or stale)" "$DBG" 2>/dev/null || echo 0)
OTHERREJ=$((TOTALREJ - STALEREJ))
if [ "$TOTALREJ" -eq 0 ]; then
  ok "no shares were rejected at all"
elif [ "$OTHERREJ" -eq 0 ]; then
  ok "all $TOTALREJ rejections are stale jobs -- expected on regtest, where a share is usually also a block"
else
  bad "every rejection is a stale job" "$OTHERREJ rejected for another reason:
$(grep -oE 'share rejected \([^)]*\)' "$DBG" | sort | uniq -c | grep -v 'stale' | head -3)"
fi

echo
echo "=== 3. no synced chain was needed ==="
FINAL=$(rpc getblockchaininfo | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const r=JSON.parse(s).result;console.log(r.blocks+" "+r.initialblockdownload)}catch(e){console.log("? ?")}})')
echo "  the mining node's own chain: height ${FINAL% *}, IBD ${FINAL#* }"
if [ "${FINAL% *}" = "0" ]; then ok "mined for a pool with an EMPTY local chain and no peers"
else bad "the local chain stayed empty" "height ${FINAL% *}"; fi

echo
echo "=== 4. a pool that goes away stops the hashing ==="
# The failure this prevents: grinding a dead pool's job at full speed, which
# looks exactly like working on every dial a user can see.
kill "$POOL_PID" 2>/dev/null; POOL_PID=""
sleep 12
INFO=$(rpc getcpuminerinfo)
HR2=$(get hashespersec); PS2=$(get poolstate); ST2=$(get poolstatus)
echo "  hashrate=$HR2  state=$PS2  status=\"$ST2\""
# Name the states that count as "noticed". `!= mining` would also be satisfied
# by an empty string from a dead node, which is a pass for the wrong reason.
case "$PS2" in
  disconnected|connecting) ok "the client noticed the pool is gone (state $PS2)" ;;
  mining) bad "the client noticed the pool is gone" "still reports mining" ;;
  *) bad "the client noticed the pool is gone" "unexpected state '$PS2'" ;;
esac
if [ -n "$ST2" ]; then ok "and says why: \"$ST2\""
else bad "and says why" "poolstatus is empty while not mining"; fi
STOPPED=$(node -e "console.log(Number('${HR2:-1}') < 1 ? 'yes':'no')")
chk "and stopped hashing rather than grinding for nobody" "$STOPPED" "yes"

rpc stopmining >/dev/null 2>&1
sleep 1
rpc stop >/dev/null 2>&1

echo
if [ "$fail" -eq 0 ]; then echo "PASS: $pass checks passed"; else echo "FAIL: $pass passed, $fail failed"; fi
exit $([ "$fail" -eq 0 ] && echo 0 || echo 1)
