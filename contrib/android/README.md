# PCoin Android miner and wallet

The Android app: a full PCoin node, a RandomX miner, and a BIP39 wallet, in one
APK. It runs `bitcoind` as a child process and talks to it over loopback RPC.

This directory holds **source only**. Two things it deliberately does not
contain are described below, and the app will not build without them.

## What is missing from git, and why

**`app/src/main/jniLibs/arm64-v8a/`** — `libbitcoind.so` and `libbitcoincli.so`,
about 14 MB. These are the node itself, cross-compiled for arm64, and they are
build products of the C++ tree in this repository rather than app source. Build
them with the Android NDK (see [`../../CLAUDE.md`](../../CLAUDE.md)) and drop
them in.

Note the filenames have no hyphen: Android only extracts and grants execute
permission to files matching `lib*.so`, so `bitcoin-cli` ships as
`libbitcoincli.so`. Renaming them breaks the app at runtime, not at build time.

**`local.properties`** — machine-specific SDK path and, on a release machine,
the signing configuration. Never commit it. Create it with:

```properties
sdk.dir=C\:\\path\\to\\Android\\Sdk
```

## Building

This module builds **two apps** from one source tree, as product flavours on the
`role` dimension:

| flavour | applicationId | what it is |
|---|---|---|
| `miner` | `am.pc.pcoinminer` | node + wallet + mining |
| `wallet` | `am.pc.pcoinwallet` | node + wallet, mining compiled out |

```
gradlew.bat :app:assembleMinerDebug     REM app/build/outputs/apk/miner/debug/
gradlew.bat :app:assembleWalletDebug    REM app/build/outputs/apk/wallet/debug/
```

There is no bare `assembleDebug` any more, and the output path gained a flavour
directory. Anything still pointing at `apk/debug/app-debug.apk` is stale.

**Do not run a bare `gradlew.bat testMinerDebugUnitTest`.** The suite includes an
end-to-end forwarding test that drives a real phone over adb. Scope it:

```
gradlew.bat :app:testMinerDebugUnitTest --tests "org.pcoin.miner.wallet.*"
```

`namespace` stays `org.pcoin.miner` for both flavours — it is only the
R/BuildConfig package, which is why the test filter above is unchanged.
`applicationId` is what makes them different apps.

Note for anything that automates the UI: **uiautomator reports resource-ids under
the applicationId**, so they are `am.pc.pcoinminer:id/…`, not the namespace.
Matching the wrong prefix finds nothing and looks like an empty screen.

## Signing

Release builds are signed with the keystore at `D:\pc.am\pcoin-release.keystore`,
which is irreplaceable: Android refuses to upgrade an installed app across a
change of signing key, so losing it means every user must uninstall — and an
uninstall destroys the wallet inside. Debug builds are used on the test fleet
precisely so wallets survive redeployment.

The build reads `storeFile` / `storePassword` / `keyAlias` from
`local.properties`, falling back to the `PCOIN_KEYSTORE` and
`PCOIN_KEYSTORE_PASSWORD` environment variables.

## Layout

| Path | What it is |
|---|---|
| `MinerService.kt` | Foreground service; owns the node and the mining gates (charging, thermal, sync) |
| `NodeController.kt` | Starts `bitcoind`, writes `pcoin.conf`, wraps the RPC |
| `ForwardEngine.kt` / `ForwardPolicy.kt` | Auto-forward. Policy is pure Kotlin with no Android or I/O, so every decision that spends money is unit-testable on a plain JVM |
| `wallet/` | BIP39, BIP32, secp256k1, derivation, encrypted seed storage, the unlock gate |
| `SetupActivity.kt` | First run: create or restore a 12/24-word phrase |
| `MainActivity.kt` | The single screen |

Derivation is `m/84'/9444'/0'/0/i` on mainnet and `m/84'/1'/0'/0/i` on test
networks, with published test vectors in [`../../PCOIN.md`](../../PCOIN.md).
A wallet that departs from wpkh-only, account `0'`, or index range `[0, 999]`
will show an **empty wallet** for the same phrase in this app.
