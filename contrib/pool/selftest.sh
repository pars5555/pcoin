#!/bin/bash
# Prove the validator agrees with the chain AND that it can fail.
#
# The second half matters more. A validator that accepts everything prints the
# same "100/100" as a correct one, so the only evidence worth anything is that
# work the chain would reject is rejected here too.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
BIN=${BIN:-$here/build/validate}
[ -x "$BIN" ] || { echo "no validator at $BIN -- run build.sh first"; exit 2; }

echo "== real blocks (must all pass) =="
"$BIN" < "$here/vectors.txt"; real=$?

echo
echo "== same blocks, nonce flipped by 1 (must all fail) =="
awk '{ n=strtonum("0x" substr($2,153,8)); printf "%s %s%08x %s %s\n", $1, substr($2,1,152), xor(n,1), $3, $4 }' \
    "$here/vectors.txt" > /tmp/pcn-tampered.txt
"$BIN" < /tmp/pcn-tampered.txt > /tmp/pcn-tampered.out 2>&1; tamper=$?
tail -2 /tmp/pcn-tampered.out
rm -f /tmp/pcn-tampered.txt /tmp/pcn-tampered.out

echo
if [ "$real" -eq 0 ] && [ "$tamper" -ne 0 ]; then
  echo "PASS: agrees with the chain, and rejects work the chain would reject"
  exit 0
fi
[ "$real" -ne 0 ] && echo "FAIL: real blocks did not verify"
[ "$tamper" -eq 0 ] && echo "FAIL: tampered work was ACCEPTED -- the validator is vacuous"
exit 1
