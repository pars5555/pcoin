#!/bin/bash
# Build bitcoind (and bitcoin-cli) for arm64-v8a Android, with startpoolmining.
#
# NO SOURCE CHANGES ARE NEEDED. RandomX picks its a64 JIT from
# CMAKE_SYSTEM_PROCESSOR=aarch64 by itself.
#
# THE THING THAT ALWAYS BITES: the NDK toolchain re-roots every find_* inside
# the NDK, so a dependency in our own prefix is invisible no matter what
# CMAKE_PREFIX_PATH says. CMAKE_FIND_ROOT_PATH plus all three
# CMAKE_FIND_ROOT_PATH_MODE_* set to BOTH is what actually makes it look in both
# places. CMAKE_PREFIX_PATH alone does nothing at all.
set -e
NDK=/root/ndk-r26b
PREFIX=/root/android-prefix
SRC=${PCOIN_SRC:-$(cd "$(dirname "$0")/../.." && pwd)}
DST=/root/pcoin-android
API=24

# A plain copy, not a git checkout: the build tree is an artifact.
mkdir -p "$DST"
rsync -a --delete --exclude build --exclude .git "$SRC/" "$DST/" 2>/dev/null || {
  rm -rf "$DST"; mkdir -p "$DST"; cp -r "$SRC/src" "$SRC/cmake" "$SRC/CMakeLists.txt" "$DST/" 2>/dev/null || true
}
cd "$DST"

cmake -B build \
  -DCMAKE_TOOLCHAIN_FILE="$NDK/build/cmake/android.toolchain.cmake" \
  -DANDROID_ABI=arm64-v8a \
  -DANDROID_PLATFORM="android-$API" \
  -DANDROID_STL=c++_static \
  -DCMAKE_FIND_ROOT_PATH="$PREFIX" \
  -DCMAKE_FIND_ROOT_PATH_MODE_PACKAGE=BOTH \
  -DCMAKE_FIND_ROOT_PATH_MODE_INCLUDE=BOTH \
  -DCMAKE_FIND_ROOT_PATH_MODE_LIBRARY=BOTH \
  -DCMAKE_PREFIX_PATH="$PREFIX" \
  -DBUILD_GUI=OFF -DENABLE_WALLET=ON -DBUILD_TESTS=OFF -DBUILD_BENCH=OFF \
  -DBUILD_FUZZ_BINARY=OFF -DWITH_ZMQ=OFF -DENABLE_IPC=OFF \
  -DCMAKE_BUILD_TYPE=Release \
  >/root/and-cm.log 2>&1 || { echo "CMAKE FAILED"; tail -30 /root/and-cm.log; exit 1; }
echo "configured"

set +e
cmake --build build -j"$(nproc)" --target bitcoind bitcoin-cli >/root/and-build.log 2>&1
RC=$?
set -e
if [ $RC -ne 0 ]; then
  echo "BUILD FAILED"; grep -E "error:|Error" /root/and-build.log | head -25; exit 1
fi

echo "=== built ==="
file build/bin/bitcoind | sed 's/^/  /'
"$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-strip" build/bin/bitcoind build/bin/bitcoin-cli
ls -la build/bin/bitcoind build/bin/bitcoin-cli
echo "=== startpoolmining present ==="
strings build/bin/bitcoind    | grep -c startpoolmining | sed 's/^/  bitcoind:    /'
strings build/bin/bitcoin-cli | grep -c startpoolmining | sed 's/^/  bitcoin-cli: /'
echo "=== stage as the app expects: exec is blocked from app storage, so the ==="
echo "=== node ships as a .so inside the APK's nativeLibraryDir            ==="
OUTDIR="$SRC/contrib/android/app/src/main/jniLibs/arm64-v8a"
cp build/bin/bitcoind    "$OUTDIR/libbitcoind.so"
cp build/bin/bitcoin-cli "$OUTDIR/libbitcoincli.so"
ls -la "$OUTDIR/"
sha256sum "$OUTDIR/libbitcoind.so"
