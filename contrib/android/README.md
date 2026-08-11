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

### Tests

Run the whole suite. It is device-free.

```
gradlew.bat :app:testWalletDebugUnitTest
```

141 cases across ten classes: `UserSendTest` (24), `ForwardPolicyTest` (62),
`AmountsTest` (10), `BalanceTrustTest` (11) in package `org.pcoin.miner`, plus
`QrTest` (11) and `QrDumpTest` (2), plus `DerivationVectorsTest` (13), `PublishedVectorsTest` (1), `RedactTest` (4) and `WordlistIntegrityTest` (3) in
`org.pcoin.miner.wallet`.

> Earlier revisions of this file told you to scope every run to
> `--tests "org.pcoin.miner.wallet.*"` because of an end-to-end forwarding test
> that drove a real phone over adb. **That test no longer exists** — there is no
> `ForwardSandboxE2ETest`, no `SandboxHarness`, no `androidTest` source set, and
> nothing matching in git history. The filter is now actively harmful: it runs 18
> of 125 cases and skips *every* send-path test, which is the money-moving half
> of the app. Use a filter only to narrow a specific investigation.

`namespace` stays `org.pcoin.miner` for both flavours — it is only the
R/BuildConfig package, which is why the test package names do not mention the
flavour. `applicationId` is what makes them different apps.

Note for anything that automates the UI: **uiautomator reports resource-ids under
the applicationId**, so they are `am.pc.pcoinminer:id/…`, not the namespace.
Matching the wrong prefix finds nothing and looks like an empty screen.

## Signing

Release builds are signed with the keystore at `D:\pc.am\pcoin-release.keystore`,
which is irreplaceable: Android refuses to upgrade an installed app across a
change of signing key, so losing it means every user must uninstall — and an
uninstall destroys the wallet inside. Debug builds are used on the test fleet
precisely so wallets survive redeployment.

The build reads signing configuration from **`signing.properties`** in this
directory — *not* `local.properties`, which holds only `sdk.dir`. Keys placed in
`local.properties` are silently ignored, and the release build then falls back to
the debug key without saying so (`app/build.gradle.kts:9-16, 177-178`).

```properties
# contrib/android/signing.properties  -- never commit; ignored by .gitignore
storeFile=D:\\pc.am\\pcoin-release.keystore
storePassword=...
keyAlias=...
keyPassword=...

# The DEBUG keystore is pinned here too, and that matters more than it looks.
# Gradle's default ~/.android/debug.keystore was lost and silently regenerated
# once, producing a build Android refused to install over the existing one --
# and the recovery for that is an uninstall, which destroys the wallet.
debugStoreFile=D:\\pc.am\\pcoin-debug.keystore
debugStorePassword=android
debugKeyAlias=androiddebugkey
debugKeyPassword=android
```

`storeFile` / `storePassword` fall back to the `PCOIN_KEYSTORE` and
`PCOIN_KEYSTORE_PASSWORD` environment variables; `debugStoreFile` falls back to
`PCOIN_DEBUG_KEYSTORE`.

Before shipping anything, check which key actually signed it:

```
apksigner verify --print-certs app\build\outputs\apk\wallet\debug\app-wallet-debug.apk
```

The debug certificate must report SHA-256 `de1fd650…`. A different digest means
the pinned keystore was not used, and installing that build over an existing one
will fail.

## Layout

| Path | What it is |
|---|---|
| `MinerService.kt` | Foreground service; owns the node and the mining gates (charging, thermal, sync) |
| `NodeController.kt` | Starts `bitcoind`, writes `pcoin.conf`, wraps the RPC |
| `ForwardEngine.kt` / `ForwardPolicy.kt` | Auto-forward. Policy is pure Kotlin with no Android or I/O, so every decision that spends money is unit-testable on a plain JVM |
| `wallet/` | BIP39, BIP32, secp256k1, derivation, encrypted seed storage, the unlock gate |
| `AddressBook.kt` | Names for addresses you pay. Pure Kotlin, no Android, so the matching rules are unit-testable; `AddressBookStore.kt` is the SharedPreferences half |
| `SetupActivity.kt` | First run: create or restore a 12/24-word phrase |
| `MainActivity.kt` | The single screen |

The address book is wallet-flavour UI (`AddressBookActivity`, plus the compose,
review and result steps of `SendActivity`). Two rules hold everywhere it
appears, and they are not stylistic: a name is a note this phone keeps that
nothing verifies, so it is **always shown next to the address, never instead of
it**, and the book **never decides where money goes** — it fills a field that
`validateaddress` still checks and the review step still shows in full.

Derivation is `m/84'/9444'/0'/0/i` on mainnet and `m/84'/1'/0'/0/i` on test
networks, with published test vectors in [`../../PCOIN.md`](../../PCOIN.md).
A wallet that departs from wpkh-only, account `0'`, or index range `[0, 999]`
will show an **empty wallet** for the same phrase in this app.
