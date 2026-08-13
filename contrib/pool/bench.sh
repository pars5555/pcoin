#!/bin/bash
# Per-hash verification cost, with the one-off RandomX cache init cancelled out
# by timing two different workloads and taking the slope.
#
# This number decides pool capacity: every share is re-hashed by the pool, so
# shares/sec/core is the ceiling. RandomX light-mode verification is
# deliberately expensive -- that is what makes the algorithm CPU-fair -- so it
# is tens of milliseconds, not the sub-millisecond people assume from SHA256d.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
BIN=${BIN:-$here/build/validate}
[ -x "$BIN" ] || { echo "no validator at $BIN"; exit 2; }

run_ms() {
  local f=$1 s e
  s=$(date +%s%N); "$BIN" < "$f" >/dev/null 2>&1; e=$(date +%s%N)
  echo $(( (e - s) / 1000000 ))
}

small=$(mktemp); large=$(mktemp)
head -100 "$here/vectors.txt" > "$small"
for _ in $(seq 1 16); do cat "$here/vectors.txt"; done > "$large"
na=$(wc -l < "$small"); nb=$(wc -l < "$large")
ta=$(run_ms "$small"); tb=$(run_ms "$large")
rm -f "$small" "$large"

per_us=$(( (tb - ta) * 1000 / (nb - na) ))
[ "$per_us" -le 0 ] && { echo "  timing too noisy to slope"; exit 1; }
echo "  $na hashes: ${ta} ms"
echo "  $nb hashes: ${tb} ms"
echo "  per hash:   ${per_us} us  (init cancelled)"
echo "  cache init: $(( ta - na * per_us / 1000 )) ms, once at startup"
echo "  one core:   ~$(( 1000000 / per_us )) shares/sec"
echo "  $(nproc) cores:  ~$(( $(nproc) * 1000000 / per_us )) shares/sec"
