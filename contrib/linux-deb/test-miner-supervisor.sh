#!/bin/bash
# Drive pcoin-miner-supervisor through a pool outage with a fake bitcoin-cli.
#
# This exists because "sh -n passes" says nothing about behaviour. Two real bugs
# were caught here and neither was visible by reading:
#
#   1. The poolstate extraction used a sed backreference. The backslash did not
#      survive being written through a shell, the replacement became a literal
#      control character, and STATE came out EMPTY on every poll -- so a
#      perfectly healthy pool was judged dead and every pool miner would have
#      migrated itself to solo. Syntax was valid throughout.
#   2. An absent poolstate field was treated as "pool is down" rather than as
#      unknown, which would have done the same thing on an older node.
#
# Run it on any Linux box; it touches no real node and no network.
#   ./contrib/linux-deb/test-miner-supervisor.sh [path-to-supervisor]
set -u
SUP=${1:-$(dirname "$0")/pcoin-miner-supervisor}
[ -r "$SUP" ] || { echo "cannot read $SUP"; exit 1; }

T=$(mktemp -d) || exit 1
trap 'kill ${PID:-0} 2>/dev/null; rm -rf "$T"' EXIT
cp "$SUP" "$T/sup"; chmod +x "$T/sup"
echo mining > "$T/poolstate"; : > "$T/calls"

cat > "$T/fakecli" <<CLI
#!/bin/sh
S=$T/poolstate
case "\$1" in
  getblockchaininfo) echo '{"blocks": 4058, "initialblockdownload": false}';;
  getconnectioncount) echo 30;;
  validateaddress)   echo '{"isvalid": true}';;
  getcpuminerinfo)   echo '{"mining": true, "threads": 1, "pool": true, "poolstate": "'"\$(cat \$S)"'", "sharesaccepted": 7}';;
  startmining)       echo SOLO >> $T/calls; echo '{"mining":true}';;
  startpoolmining)   echo POOL >> $T/calls; echo '{"mining":true}';;
  stopmining)        echo STOP >> $T/calls; echo '{}';;
  *) echo '{}';;
esac
CLI
chmod +x "$T/fakecli"

sed -i "s|^CLI=.*|CLI=\"$T/fakecli\"|;s|^CONF=.*|CONF=$T/miner.conf|" "$T/sup"
sed -i "s|^FALLBACK_AFTER=.*|FALLBACK_AFTER=6|;s|^POOL_RETRY=.*|POOL_RETRY=14|;s|^POLL=.*|POLL=1|" "$T/sup"
printf 'PAYOUT_ADDRESS=pc1qlvw6kx8wkcz8f6p0d6kswv69fjt33ll079f64e\nTHREADS=1\nPOOL_URL=pool.pc.am:3333\n' > "$T/miner.conf"

PASS=0; FAIL=0
ck() { if [ "$2" = yes ]; then PASS=$((PASS+1)); echo "    ok   $1"; else FAIL=$((FAIL+1)); echo "    FAIL $1"; fi; }
has() { grep -q "$1" "$T/log" && echo yes || echo no; }
hasnt() { grep -q "$1" "$T/log" && echo no || echo yes; }

"$T/sup" > "$T/log" 2>&1 & PID=$!

echo "  phase 1: pool healthy"
sleep 4
ck "starts in POOL mode"                       "$(has 'pool mining for')"
ck "does NOT fall back while pool is healthy"  "$(hasnt 'falling back')"

echo "  phase 2: pool goes away"
echo disconnected > "$T/poolstate"
sleep 4
ck "notices the pool stopped supplying work"   "$(has 'stopped supplying work')"
ck "has not fallen back before FALLBACK_AFTER" "$(hasnt 'falling back')"
sleep 6
ck "falls back to SOLO"                        "$(has 'falling back to SOLO')"
ck "solo mining actually starts"               "$(has 'mining SOLO')"

echo "  phase 3: pool still dead"
sleep 16
ck "re-tries the pool"                         "$(has 're-trying the pool')"

echo "  phase 4: pool returns"
echo mining > "$T/poolstate"
sleep 18
ck "recovers to pool"                          "$(has 'pool is supplying work again')"

echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
