# PCoin Wallet — deploy runbook

## Key facts

| | |
|---|---|
| Package | `am.pc.pcoinwallet` (the `wallet` product flavour) |
| Version | 0.2.12 (versionCode 15) — submitted 2026-08-31 |
| Bundle | `PCoinWallet-release-0.2.12-vc15.aab` (this folder) |
| Signing | `signing.properties` at the repo root of `contrib/android`; keystores live on `D:` and on both vault hosts — see `SIGNING.md` |
| Toolchain | AGP 8.5.1 · Kotlin 2.0.21 · compileSdk/targetSdk 35 · minSdk 24 |
| Native | `app/src/main/jniLibs/arm64-v8a/libbitcoind.so` + `libbitcoincli.so` — a real PCoin full node, 16 KB-aligned |
| Privacy policy | https://pc.am/wallet-privacy.html (served from `35.239.156.16:/var/www/pc.am/`) |

**TWO APPS, ONE TREE.** `miner` is `am.pc.pcoinminer`; `wallet` is
`am.pc.pcoinwallet`. Only the wallet goes to Play. `assembleDebug` does not
exist — always name the flavour.

## Build a release

```powershell
cd d:\xampp\htdocs\pcoin\contrib\android
# bump versionCode + versionName in app\build.gradle.kts (wallet flavour) first
.\gradlew.bat testWalletDebugUnitTest --tests "org.pcoin.miner.ForwardPolicyTest" `
              --tests "org.pcoin.miner.UserSendTest" --tests "org.pcoin.miner.AddressBookTest"
.\gradlew.bat bundleWalletRelease assembleWalletRelease assembleWalletDebug
copy app\build\outputs\bundle\walletRelease\app-wallet-release.aab `
     playstore\v1\PCoinWallet-release-<ver>-vc<code>.aab
```

> The former device-holding `ForwardSandboxE2ETest` no longer exists (see
> `../../README.md`), so the full `testWalletDebugUnitTest` suite is device-free;
> a `--tests` filter is only for narrowing an investigation.

Verify the signer before anything leaves the machine:

```powershell
apksigner verify --print-certs app\build\outputs\apk\wallet\release\app-wallet-release.apk
# release must be 2dc08424...  debug must be de1fd650...
```

## Rebuild the native node (only when the node changes)

Built in WSL from `/root/pcoin-android` with NDK r26b, arm64-v8a, API 24.
**Must be linked 16 KB-aligned** or Play rejects it:

```bash
cmake -B build -DCMAKE_EXE_LINKER_FLAGS='-Wl,-z,max-page-size=16384'
cmake --build build --target bitcoind bitcoin-cli -j8
llvm-strip build/bin/bitcoind build/bin/bitcoin-cli
# then copy to jniLibs as libbitcoind.so / libbitcoincli.so and check:
readelf -l libbitcoind.so | awk '/LOAD/{getline; print $NF}'   # must print 0x4000
```

## Install on the fleet

```powershell
# owner's phone (release key, wallet must survive) - in place, NEVER uninstall
adb -s <treasury-phone-serial> install -r app\build\outputs\apk\wallet\release\app-wallet-release.apk
# Z Flip 5 test device (debug key)
adb -s <test-device-serial> install -r app\build\outputs\apk\wallet\debug\app-wallet-debug.apk
# Serials live in D:\pc.am\PCOIN-SERVERS.md, not in this public repo. Guard on
# the serial before any install: the two moto g plays look alike and one holds
# the treasury.
```

`install -r` fails safely on a signer mismatch — it refuses, it does not
uninstall. An uninstall destroys the wallet in app-private storage.

## Submission

Follow `SUBMISSION.md`. Screenshots are captured from the Z Flip 5 with
`adb shell screencap`, cropped to 1080x2140 and balance-blurred (see
`STORE-LISTING.md`).
