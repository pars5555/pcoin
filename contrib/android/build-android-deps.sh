#!/bin/bash
# Cross-compile PCoin's dependencies for arm64-v8a Android.
#
# THE LINUX NDK, not the one in the Windows SDK. That copy only ships
# toolchains/llvm/prebuilt/WINDOWS-x86_64, so a Linux-hosted cross build finds
# no compiler at all and autotools reports the uselessly generic "C compiler
# cannot create executables". Copying it to a native filesystem for speed --
# which cost 2 GB and several minutes -- did not and could not help.
#
# r26b IS 26.1.10909125, which is the version the phones' current libbitcoind.so
# was built with.
set -e
NDK=/root/ndk-r26b
PREFIX=/root/android-prefix
API=24
HOST=aarch64-linux-android
JOBS=$(nproc)

rm -rf /root/ndk-26.1     # the Windows-hosted copy: wrong host, no use to us

if [ ! -d "$NDK/toolchains/llvm/prebuilt/linux-x86_64" ]; then
  echo "downloading the Linux NDK r26b (~600 MB)..."
  cd /root
  [ -f ndk.zip ] || curl -sL -o ndk.zip https://dl.google.com/android/repository/android-ndk-r26b-linux.zip
  rm -rf android-ndk-r26b
  unzip -q ndk.zip
  mv android-ndk-r26b "$NDK"
fi
TC="$NDK/toolchains/llvm/prebuilt/linux-x86_64"
export AR="$TC/bin/llvm-ar" RANLIB="$TC/bin/llvm-ranlib" STRIP="$TC/bin/llvm-strip"
export CC="$TC/bin/${HOST}${API}-clang" CXX="$TC/bin/${HOST}${API}-clang++"
"$CC" --version | head -1

mkdir -p "$PREFIX" /root/andbuild && cd /root/andbuild

if [ ! -f "$PREFIX/lib/libevent_core.a" ]; then
  echo "=== libevent ==="
  [ -f libevent-2.1.12-stable.tar.gz ] || curl -sL -o libevent-2.1.12-stable.tar.gz \
    https://github.com/libevent/libevent/releases/download/release-2.1.12-stable/libevent-2.1.12-stable.tar.gz
  rm -rf libevent-2.1.12-stable && tar xzf libevent-2.1.12-stable.tar.gz
  cd libevent-2.1.12-stable
  ./configure --host="$HOST" --prefix="$PREFIX" --disable-shared --enable-static \
      --disable-samples --disable-libevent-regress --disable-openssl --with-pic \
      >/root/ev.log 2>&1 || { echo "libevent configure FAILED"; tail -25 /root/ev.log; exit 1; }
  make -j"$JOBS" >>/root/ev.log 2>&1 && make install >>/root/ev.log 2>&1 \
    || { echo "libevent build FAILED"; tail -25 /root/ev.log; exit 1; }
  cd ..
fi
ls "$PREFIX/lib/" | grep -E "^libevent" | sed 's/^/  /'

if [ ! -f "$PREFIX/lib/libsqlite3.a" ]; then
  echo "=== sqlite ==="
  [ -f sqlite-autoconf-3460100.tar.gz ] || curl -sL -o sqlite-autoconf-3460100.tar.gz \
    https://sqlite.org/2024/sqlite-autoconf-3460100.tar.gz
  rm -rf sqlite-autoconf-3460100 && tar xzf sqlite-autoconf-3460100.tar.gz
  cd sqlite-autoconf-3460100
  ./configure --host="$HOST" --prefix="$PREFIX" --disable-shared --enable-static \
      --disable-readline --with-pic >/root/sq.log 2>&1 \
    || { echo "sqlite configure FAILED"; tail -25 /root/sq.log; exit 1; }
  make -j"$JOBS" >>/root/sq.log 2>&1 && make install >>/root/sq.log 2>&1 \
    || { echo "sqlite build FAILED"; tail -25 /root/sq.log; exit 1; }
  cd ..
fi
ls "$PREFIX/lib/libsqlite3.a" | sed 's/^/  /'

# Core uses boost header-only (multi_index, signals2): architecture-independent.
if [ ! -d "$PREFIX/include/boost" ]; then
  [ -d /usr/include/boost ] || { echo "install libboost-dev first"; exit 1; }
  mkdir -p "$PREFIX/include"
  cp -r /usr/include/boost "$PREFIX/include/"
fi
echo "  boost headers: $(ls "$PREFIX/include/boost" | wc -l) entries"
echo "PREFIX READY: $PREFIX"
