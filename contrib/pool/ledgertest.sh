#!/usr/bin/env bash
# End to end: real shares from two miners, through the pool, into the ledger,
# out as a reconciled PPLNS split -- and nothing sent.
#
#   bash ledgertest.sh <miner-address-A> <miner-address-B> [seconds]
#
# storetest.mjs proves the arithmetic offline. This proves the arithmetic is
# wired to anything: that the shares in the database are the shares the miners
# were told were accepted, that a block found by the pool produces payout rows
# that add up to its coinbase, that maturity actually flips, and that a restart
# does not lose or double-count a share.
#
# It runs against the `pcoin-regtest` container. Two things about regtest shape
# this test and are worth knowing before reading the numbers:
#
#   * roughly HALF of all hashes are valid blocks there, so this finds blocks
#     constantly. For the payout path that is a feature -- a week of mainnet
#     rounds in a minute.
#   * one block's work is ~2 hashes, so a windowMultiplier of 2 would give a
#     PPLNS window of 4 shares. The regtest config uses 500 instead, which puts
#     ~1000 shares in the window and makes it span many rounds -- which is the
#     property being tested. Mainnet stays at 2.
#
# NOTE: pgrep -f matches its own command line, so this tracks PIDs it started
# rather than searching for them.

set -u
cd "$(dirname "$0")"

A="${1:?usage: ledgertest.sh <addrA> <addrB> [seconds]}"
B="${2:?usage: ledgertest.sh <addrA> <addrB> [seconds]}"
SECS="${3:-45}"
CFG=pool.config.json
DB=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("pool.config.json","utf8")).db)')
RPC="sudo docker exec pcoin-regtest bitcoin-cli -regtest"
POOL_PID=""
pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  PASS  %s\n' "$1"; }
bad()  { fail=$((fail+1)); printf '  FAIL  %s  --  %s\n' "$1" "${2:-}"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected $3, got $2"; fi; }
q()    { sqlite3 "$DB" "$1"; }
cleanup(){ [ -n "$POOL_PID" ] && kill "$POOL_PID" 2>/dev/null; }
trap cleanup EXIT

echo "fresh ledger at $DB"
rm -f "$DB" "$DB-wal" "$DB-shm"

start_pool() {
  node pool.mjs --config "$CFG" >>pool.log 2>&1 &
  POOL_PID=$!
  for _ in $(seq 1 60); do
    grep -q 'listening on' pool.log && return 0
    sleep 1
  done
  echo "pool did not come up; see pool.log"; exit 1
}

: >pool.log
echo "starting pool (this waits ~1s for the RandomX cache)…"
start_pool
echo "pool up (pid $POOL_PID)"

echo
echo "── two miners, ${SECS}s ──────────────────────────────────────────────"
node testminer.mjs 127.0.0.1 3333 "$A" "$SECS" >minerA.log 2>&1 &
MA=$!
node testminer.mjs 127.0.0.1 3333 "$B" "$SECS" >minerB.log 2>&1 &
MB=$!
wait $MA; wait $MB
ACC_A=$(grep -o 'accepted [0-9]*' minerA.log | tail -1 | awk '{print $2}')
ACC_B=$(grep -o 'accepted [0-9]*' minerB.log | tail -1 | awk '{print $2}')
echo "  miner A was told $ACC_A shares were accepted"
echo "  miner B was told $ACC_B shares were accepted"
sleep 2

echo
echo "── the ledger holds exactly what the miners were told ────────────────"
DB_A=$(q "SELECT COUNT(*) FROM shares WHERE miner='$A';")
DB_B=$(q "SELECT COUNT(*) FROM shares WHERE miner='$B';")
check "miner A's accepted shares are all in the ledger" "$DB_A" "$ACC_A"
check "miner B's accepted shares are all in the ledger" "$DB_B" "$ACC_B"

DUPS=$(q "SELECT COUNT(*) FROM (SELECT job_id,nonce FROM shares GROUP BY job_id,nonce HAVING COUNT(*)>1);")
check "no nonce is recorded twice" "$DUPS" "0"

ZERO=$(q "SELECT COUNT(*) FROM shares WHERE weight<1;")
check "every share carries a weight of at least 1" "$ZERO" "0"

# The miners replay every accepted nonce immediately. None may be accepted.
REPLAY_OK=$(cat minerA.log minerB.log | grep -c 'ACCEPTED AGAIN (BAD)')
check "no replayed nonce was accepted a second time" "$REPLAY_OK" "0"

# ...but "not accepted" is not the same claim as "rejected as a duplicate", and
# on regtest this test CANNOT make the stronger one. About one share in four is
# also a block here, which moves the tip and clears the job cache, so a good
# share's replay often lands on a job that no longer exists and is refused as
# STALE. That is a fact about regtest, not about the pool -- duptest.mjs proves
# the reason against real mainnet difficulty, and its header explains why it has
# to. What IS checkable here: the dedup path is genuinely reached, and no replay
# is ever refused for some third reason nobody predicted.
REPLAYS=$(cat minerA.log minerB.log | grep -c 'replayed ->')
DUP=$(cat minerA.log minerB.log | grep 'replayed ->' | grep -c 'duplicate share')
STALE=$(cat minerA.log minerB.log | grep 'replayed ->' | grep -c 'job not found or stale')
check "every replay was refused as a duplicate or as stale, and nothing else" \
  "$((REPLAYS - DUP - STALE))" "0"
if [ "$DUP" -gt 0 ]; then ok "the dedup check is reached in the live pool ($DUP of $REPLAYS; $STALE went stale first)"
else bad "the dedup check is reached in the live pool" "all $REPLAYS replays went stale -- dedup never exercised"; fi

echo
echo "── blocks and payouts ────────────────────────────────────────────────"
BLOCKS=$(q "SELECT COUNT(*) FROM blocks;")
echo "  the pool found $BLOCKS block(s)"
if [ "$BLOCKS" -eq 0 ]; then
  bad "the pool found at least one block" "found none, so nothing below was exercised"
else
  ok "the pool found at least one block"

  # The invariant, computed in SQL rather than by asking the pool to grade its
  # own homework: for every block, payouts + fee + dust must equal the coinbase.
  OFF=$(q "SELECT COUNT(*) FROM blocks b JOIN pool_fees f ON f.block_height=b.height
           WHERE b.value <> f.fee + f.dust +
             (SELECT IFNULL(SUM(amount),0) FROM payouts p WHERE p.block_height=b.height);")
  check "every block's payouts + fee + dust equal its coinbase, to the satoshi" "$OFF" "0"

  FEEBAD=$(q "SELECT COUNT(*) FROM pool_fees WHERE fee <> value*200/10000;")
  check "the fee is exactly 2% of the block reward on every block" "$FEEBAD" "0"

  NEG=$(q "SELECT COUNT(*) FROM payouts WHERE amount<0;")
  check "no payout is negative" "$NEG" "0"

  # 2% comes off the REWARD. Every miner's total must be positive and the pool
  # must never hold more than its fee plus dust.
  MINERS=$(q "SELECT COUNT(DISTINCT miner) FROM payouts;")
  echo "  $MINERS miner(s) appear in the payout rows"
  if [ "$MINERS" -ge 2 ]; then ok "both miners are paid from the same blocks"
  else bad "both miners are paid from the same blocks" "only $MINERS miner in the rows"; fi

  SENT=$(q "SELECT COUNT(*) FROM payouts WHERE sent_txid IS NOT NULL;")
  check "STEP 3: nothing is marked sent" "$SENT" "0"

  # The global invariant, across every block at once. Per-block reconciliation
  # can be right while the whole ledger has invented or lost coins somewhere --
  # this is the one number the operator should be able to check in a week's time
  # against what the pool address actually received.
  TOTAL_IN=$(q "SELECT IFNULL(SUM(value),0) FROM blocks;")
  TOTAL_OUT=$(q "SELECT (SELECT IFNULL(SUM(amount),0) FROM payouts)
                      + (SELECT IFNULL(SUM(fee),0)+IFNULL(SUM(dust),0) FROM pool_fees);")
  check "every satoshi mined is accounted for: payouts + fees + dust == coinbases" "$TOTAL_OUT" "$TOTAL_IN"
  echo "         $TOTAL_IN sat mined, $TOTAL_OUT sat accounted for"

  # The reward halves at height 150 on regtest. The pool reads coinbasevalue
  # from each template rather than assuming 50 PCN, so the fee must follow it
  # down -- a hardcoded reward would show up here and nowhere else.
  VALUES=$(q "SELECT COUNT(DISTINCT value) FROM blocks;")
  if [ "$VALUES" -gt 1 ]; then
    ok "the fee tracks the block reward across a halving ($VALUES distinct rewards seen)"
  else
    echo "         (no halving crossed in this run; $VALUES distinct reward value)"
  fi

  # And the payout rows must reference blocks the node actually has.
  MISSING=0
  for h in $(q "SELECT hash FROM blocks;"); do
    $RPC getblock "$h" >/dev/null 2>&1 || MISSING=$((MISSING+1))
  done
  check "every block in the ledger is a block the node has" "$MISSING" "0"
fi

echo
echo "── PENDING, not missing ──────────────────────────────────────────────"
PEND=$(q "SELECT COUNT(*) FROM blocks WHERE state='pending';")
if [ "$PEND" -gt 0 ]; then ok "$PEND block(s) are PENDING while the coinbase is immature"
else bad "blocks are PENDING while immature" "none are pending"; fi
PAYABLE=$(q "SELECT IFNULL(SUM(p.amount),0) FROM payouts p JOIN blocks b ON b.hash=p.block_hash WHERE b.state='mature';")
check "nothing is payable yet" "$PAYABLE" "0"

echo
echo "── maturity actually flips ───────────────────────────────────────────"
# Bury them. Coinbase maturity is 100 blocks on regtest too.
BURY=$($RPC getnewaddress "" bech32)
$RPC generatetoaddress 105 "$BURY" >/dev/null 2>&1
echo "  buried under 105 blocks; waiting for the maturity pass…"
MATURED=0
for _ in $(seq 1 24); do
  sleep 5
  MATURED=$(q "SELECT COUNT(*) FROM blocks WHERE state='mature';")
  [ "$MATURED" -gt 0 ] && break
done
if [ "$MATURED" -gt 0 ]; then ok "$MATURED block(s) matured and became payable"
else bad "blocks mature once buried" "still 0 mature after 120s"; fi
ORPH=$(q "SELECT COUNT(*) FROM blocks WHERE state='orphaned';")
echo "  $ORPH orphaned"

echo
echo "── a real reorg voids a real block ───────────────────────────────────"
# Simulated orphans are cheap; this one is a genuine reorg. Invalidate the
# pool's highest block on the node and build a different chain past it, then let
# the maturity pass discover that the block it recorded is no longer the block
# at that height. Reorgs are routine on PCoin -- the live chain has carried a
# ~3% stale rate -- so this path will run for real.
VICTIM=$(q "SELECT hash FROM blocks ORDER BY height DESC LIMIT 1;")
VH=$(q "SELECT height FROM blocks ORDER BY height DESC LIMIT 1;")
VPAY=$(q "SELECT IFNULL(SUM(amount),0) FROM payouts WHERE block_hash='$VICTIM';")
echo "  invalidating our block at height $VH ($VPAY sat of payouts ride on it)"
$RPC invalidateblock "$VICTIM" >/dev/null 2>&1
$RPC generatetoaddress 6 "$BURY" >/dev/null 2>&1
NEWHASH=$($RPC getblockhash "$VH")
if [ "$NEWHASH" = "$VICTIM" ]; then
  bad "the node really did reorg away from our block" "height $VH still resolves to $VICTIM"
else
  ok "the node really did reorg away from our block"
  echo "  waiting for the pool to notice (needs two passes, by design)…"
  STATE=""
  for _ in $(seq 1 24); do
    sleep 5
    STATE=$(q "SELECT state FROM blocks WHERE hash='$VICTIM';")
    [ "$STATE" = "orphaned" ] && break
  done
  check "the pool marks its own orphaned block as orphaned" "$STATE" "orphaned"
  VOID=$(q "SELECT IFNULL(SUM(p.amount),0) FROM payouts p JOIN blocks b ON b.hash=p.block_hash
            WHERE b.state='orphaned';")
  if [ "$VOID" -ge "$VPAY" ]; then ok "its payouts became void, not payable"
  else bad "its payouts became void" "void total $VOID does not cover the $VPAY on that block"; fi
  STILLSENT=$(q "SELECT COUNT(*) FROM payouts WHERE sent_txid IS NOT NULL;")
  check "and still nothing anywhere is marked sent" "$STILLSENT" "0"
fi

echo
echo "── a restart loses nothing and double-counts nothing ─────────────────"
SHARES_BEFORE=$(q "SELECT COUNT(*) FROM shares;")
BLOCKS_BEFORE=$(q "SELECT COUNT(*) FROM blocks;")
PAY_BEFORE=$(q "SELECT IFNULL(SUM(amount),0) FROM payouts;")
kill "$POOL_PID" 2>/dev/null; wait "$POOL_PID" 2>/dev/null
start_pool
sleep 3
check "every share survived the restart" "$(q 'SELECT COUNT(*) FROM shares;')" "$SHARES_BEFORE"
check "every block survived the restart"  "$(q 'SELECT COUNT(*) FROM blocks;')" "$BLOCKS_BEFORE"
check "no payout was recomputed or duplicated" "$(q 'SELECT IFNULL(SUM(amount),0) FROM payouts;')" "$PAY_BEFORE"

echo
echo "── an unwritable ledger refuses shares; it never invents an answer ───"
# Kill the store out from under the running pool. The pool can still validate,
# and must still say no: "I could not record this" is not "accepted".
SQLPID=$(ps -o pid=,ppid=,comm= -e | awk -v p="$POOL_PID" '$2==p && $3 ~ /sqlite3/ {print $1}' | head -1)
if [ -z "$SQLPID" ]; then
  bad "found the pool's sqlite3 child to kill" "none found under pid $POOL_PID"
else
  kill -9 "$SQLPID"
  sleep 1
  node testminer.mjs 127.0.0.1 3333 "$A" 10 >minerC.log 2>&1
  LATER=$(q "SELECT COUNT(*) FROM shares;")
  GOTOK=$(grep -o 'accepted [0-9]*' minerC.log | tail -1 | awk '{print $2}')
  check "with the ledger gone, no share is accepted" "${GOTOK:-0}" "0"
  check "and no share is recorded" "$LATER" "$SHARES_BEFORE"
  if grep -q 'ledger unavailable' minerC.log; then ok "and the miner is told why, rather than silently ignored"
  else bad "the miner is told why" "$(grep -o '[0-9]*x .*' minerC.log | head -2 | tr '\n' ' ')"; fi
fi

echo
echo "── the ledger, as the operator will read it ──────────────────────────"
kill "$POOL_PID" 2>/dev/null; POOL_PID=""
node payouts.mjs --config "$CFG" 2>&1 | sed 's/^/  /'

echo
if [ "$fail" -eq 0 ]; then echo "PASS: $pass checks passed"; else echo "FAIL: $pass passed, $fail failed"; fi
exit $([ "$fail" -eq 0 ] && echo 0 || echo 1)
