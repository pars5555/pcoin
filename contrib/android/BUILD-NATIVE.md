# Building the Android node binary

`app/src/main/jniLibs/arm64-v8a/libbitcoind.so` is **not in git** — it is a
13 MB build artifact and `.gitignore` excludes it. This file is how to rebuild
it, because the recipe that knew how lived in a scratchpad and is gone.

Two scripts do the whole job, from a Linux host (WSL is fine):

```bash
bash contrib/android/build-android-deps.sh   # libevent, sqlite, boost  -> /root/android-prefix
bash contrib/android/build-android-node.sh   # bitcoind + bitcoin-cli -> jniLibs/arm64-v8a/
```

Target: **arm64-v8a, API 24, NDK r26b** (= 26.1.10909125), `c++_static`.
That is the same NDK the phones' current binary was built with; changing it is
not a decision to make casually, because every phone would need reinstalling.

## The four things that will waste your afternoon

**1. The NDK inside the Windows Android SDK cannot do this.**
It ships only `toolchains/llvm/prebuilt/`**`windows`**`-x86_64`. A Linux-hosted
cross build finds no compiler and autotools reports the uselessly generic
*"C compiler cannot create executables"* — which reads like a broken toolchain
rather than the wrong host. Download the Linux NDK. Copying the Windows one to
a native filesystem "for speed" costs 2 GB and helps nothing.

**2. Upstream `depends` has no `android.mk`.**
There is no `HOST=aarch64-linux-android` to run. Core needs exactly three
things, and `build-android-deps.sh` builds them into one prefix:

| | |
|---|---|
| libevent | a real autotools cross-compile |
| sqlite | one amalgamation; needed because the wallet is enabled |
| boost | **header-only** for Core's usage, so the system headers cross fine |

**3. `CMAKE_PREFIX_PATH` alone does nothing.**
The NDK toolchain re-roots every `find_*` inside the NDK, so a dependency in
your own prefix is invisible however loudly you point at it. What works is
`CMAKE_FIND_ROOT_PATH=<prefix>` **plus all three** of
`CMAKE_FIND_ROOT_PATH_MODE_{PACKAGE,INCLUDE,LIBRARY}=BOTH`.

**4. No source changes are needed.**
RandomX selects its a64 JIT from `CMAKE_SYSTEM_PROCESSOR=aarch64` on its own.
If you find yourself editing `src/randomx`, stop — something else is wrong.

## Packaging

Android blocks `exec` from app-writable storage, which is why the node ships as
a `.so` inside the APK's `nativeLibraryDir` rather than as a file the app writes
out. So the binaries are simply renamed:

```
bitcoind     -> jniLibs/arm64-v8a/libbitcoind.so
bitcoin-cli  -> jniLibs/arm64-v8a/libbitcoincli.so
```

## Installing on a phone that is already mining

`install -r` keeps app-private storage, so **the wallet survives** — but only
while the signer matches. Check it, do not assume:

```
apksigner verify --print-certs app-miner-debug.apk    # must be de1fd650…
```

A different signer forces an uninstall, and an uninstall destroys the wallet.

Stop the node cleanly first (`stopmining` then `stop` over RPC) or the next
start pays for an unclean shutdown with a rescan.

**Setting `pool_url` by editing `shared_prefs` is a race.** SharedPreferences is
an in-memory map written back on any change: edit the XML while the app holds
it and the app's copy wins the next time anything is saved. It happened here —
the service restarted during `install -r`, loaded prefs, and silently erased the
edit. Stop the app, confirm it is stopped, edit, and verify, all without giving
the service a window to come back in.
