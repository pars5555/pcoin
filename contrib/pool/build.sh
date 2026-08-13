#!/bin/bash
# Build the share validator against the VENDORED RandomX -- not a system copy.
# src/randomx is a plain directory in this repo, not a submodule, and it is the
# exact source the node hashes with. Linking anything else would test a
# different algorithm.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
out=${1:-$here/build}

mkdir -p "$out"
if [ ! -f "$out/librandomx.a" ]; then
  echo "building vendored RandomX (once)"
  cmake -S "$root/src/randomx" -B "$out/rx" -DCMAKE_BUILD_TYPE=Release -DARCH=native >/dev/null
  cmake --build "$out/rx" -j "$(nproc)" --target randomx >/dev/null
  find "$out/rx" -name 'librandomx.a' -exec cp {} "$out/librandomx.a" \;
fi

g++ -O2 -std=c++17 -I"$root/src/randomx/src" \
    "$here/validate.cpp" "$out/librandomx.a" -lpthread -o "$out/validate"
echo "built $out/validate"
