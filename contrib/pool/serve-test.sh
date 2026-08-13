#!/bin/bash
# Serve mode must: stay warm, agree with one-shot mode, and survive garbage.
# The last one is not optional -- malformed lines are exactly what a hostile
# miner sends, and a validator that exits takes the pool with it.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
BIN=${BIN:-$here/build/validate}

# A real block and its target, plus deliberate garbage interleaved.
read -r H HDR BITS _ < "$here/vectors.txt"
TARGET=$(python3 -c "
b=int('$BITS',16); e=b>>24; m=b&0x7fffff
t=m*(1<<(8*(e-3))) if e>3 else m>>(8*(3-e))
print('%064x'%t)")

{
  echo "$HDR $TARGET"                 # 1 real share, must be ok
  echo "garbage"                      # 2 too few fields
  echo "zz $TARGET"                   # 3 non-hex header
  echo "$HDR deadbeef"                # 4 short target
  echo ""                             # 5 empty line
  echo "$HDR $(printf '0%.0s' $(seq 1 64))"  # 6 impossible target, must be no
  echo "$HDR $TARGET"                 # 7 still alive and still correct
} | timeout 60 "$BIN" --serve 2>/dev/null > /tmp/serve.out
rc=$?

echo "  exit=$rc  (0 means it survived every line)"
nl -ba /tmp/serve.out | sed 's/^/    /'
ok=$(grep -c '^ok ' /tmp/serve.out); no=$(grep -c '^no ' /tmp/serve.out); err=$(grep -c '^err ' /tmp/serve.out)
echo "  ok=$ok no=$no err=$err"
rm -f /tmp/serve.out
[ "$rc" -eq 0 ] && [ "$ok" -eq 2 ] && [ "$no" -eq 1 ] && [ "$err" -eq 3 ] \
  && { echo "  PASS: 2 valid, 1 rejected, 3 malformed handled, process survived"; exit 0; }
echo "  FAIL"; exit 1
