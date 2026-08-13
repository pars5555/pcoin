#!/bin/bash
# Build the share validator against the VENDORED RandomX -- not a system copy.
# src/randomx is a plain directory in this repo, not a submodule, and it is the
# exact source the node hashes with. Linking anything else would test a
# different algorithm.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
out=${1:-$here/build}

# ARCH=native tunes for THIS machine's instruction set, which is right when the
# validator runs where it was built and wrong the moment it does not: a binary
# built on one host and copied to another dies with "Illegal instruction (core
# dumped)" the first time it hashes. That has already happened once, shipping a
# validator from the build host to the pool host.
#
# Worse, it does not fail politely. `./validate` with no input exits 0, so the
# binary looks fine right up until it is fed a block -- which, on a pool, is
# after miners have connected. Build it where it will run, or set ARCH=default
# for a portable binary (RandomX still detects AES-NI and friends at runtime, so
# the cost is small).
ARCH=${ARCH:-native}

mkdir -p "$out"
if [ ! -f "$out/librandomx.a" ]; then
  echo "building vendored RandomX (once, ARCH=$ARCH)"
  cmake -S "$root/src/randomx" -B "$out/rx" -DCMAKE_BUILD_TYPE=Release -DARCH="$ARCH" >/dev/null
  cmake --build "$out/rx" -j "${JOBS:-$(nproc)}" --target randomx >/dev/null
  find "$out/rx" -name 'librandomx.a' -exec cp {} "$out/librandomx.a" \;
fi

g++ -O2 -std=c++17 -I"$root/src/randomx/src" \
    "$here/validate.cpp" "$out/librandomx.a" -lpthread -o "$out/validate"
echo "built $out/validate"
