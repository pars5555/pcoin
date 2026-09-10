# PCoin Wallet for iOS

A light client. Keys and signing on the device, chain data over HTTP from
`explorer.pc.am`.

The brief was *"identical to the Android one"*, and the wording, the screens and
the key scheme are. The architecture is not, and cannot be — see
[What is not identical](#what-is-not-identical-and-why), which is the honest
list the brief asked for.

```
contrib/ios/
  PCoinKit/                 pure Swift, no UIKit. Testable on macOS with no simulator.
    Sources/PCoinKit/       crypto, derivation, addresses, transactions, explorer client
    Sources/CSecp256k1/     vendored libsecp256k1 (see VENDORED.md)
    Tests/PCoinKitTests/    67 tests, all against published vectors
  PCoinWallet/              the SwiftUI app
    App/                    entry point, URL routing, every user-visible string
    Model/                  key storage, preferences, the one view model
    Screens/                one file per Android activity
    Components/             QR rendering, the warnings list
  PCoinWalletUITests/       the three payment-link cases, on a simulator
  tools/genproj.py          generates PCoinWallet.xcodeproj
  tools/gen_wordlist.py     regenerates the embedded BIP39 list
```

## Build and test

The derivation stack runs on any machine with Swift. No simulator, no signing,
no device:

```sh
cd contrib/ios/PCoinKit
swift test
```

That is the acceptance test. It asserts the vectors published in `PCOIN.md` §6.4
— seed, master xprv, fingerprint, account xprv and xpub, both descriptors with
their checksums, and six addresses — plus BIP32, BIP39, RIPEMD-160, bech32 and
BIP143 against their own published vectors.

The app:

```sh
cd contrib/ios
python tools/genproj.py                     # after adding or removing a source file
xcodebuild -project PCoinWallet.xcodeproj -scheme PCoinWallet \
           -sdk iphoneos -configuration Debug CODE_SIGNING_ALLOWED=NO build
```

`project.pbxproj` is generated rather than hand-maintained. A pbxproj is a soup
of 24-hex identifiers that nobody reviews and that merges badly; the generator
derives every identifier from the file path, so regenerating produces a diff that
shows only what actually changed. **Run `genproj.py` after adding a file** — the
target compiles the list the script found, not whatever is on disk.

## What is not identical, and why

Everything here is a real difference somebody will notice. Nothing on this list
was a preference.

### 1. There is no node in the app

The Android wallet ships `bitcoind` as `jniLibs/arm64-v8a/libbitcoind.so` and
execs it. It syncs the chain, holds the UTXO set, builds transactions and
broadcasts them itself.

iOS forbids both halves of that: an app may not exec a separate executable and
may not JIT. So this app derives its own addresses, validates addresses itself,
builds and signs its own transactions, and reads the chain over HTTP.

Consequences that reach the screen:

* **The chain line names the explorer, not a peer count.** Android says
  `Block 7342 · 51 peers` about the node inside it. This app has no peers and
  claiming a number would be claiming something it cannot know.
* **The Settings warnings are a different list.** Android warns about battery
  optimisation, "Pause app activity if unused" and blocked notifications —
  all three because a node runs in the background there. None of those
  conditions exists here, so reproducing them would be inventing problems. The
  iOS list is: no device passcode, phrase not written down, key not in the
  Secure Enclave, explorer index not current.
* **A send can end in a state Android does not have.** See §4 below.

### 2. iOS signs; Android does not

The Android wallet has a small Kotlin secp256k1 that says of itself, correctly,
*"It must never be reused for signing"* — it is a plain double-and-add ladder,
not constant time. It gets away with that because the node inside the app does
the signing.

There is no node here, so every spend is signed on the device with a live
private key. That is exactly the case the Kotlin file rules itself out of, so
this app links the **same libsecp256k1 the chain itself uses**, vendored from
`src/secp256k1` in this repository. `SigningTests` pins it to BIP143's published
vector, signature bytes included, which also proves RFC6979 determinism.

### 3. The unlock happens one screen earlier

Android prompts for the Keystore unlock at **Send now**. This app prompts at
**Check this send**.

The review screen promises *"These are the real figures from the transaction that
was just built"*, and on iOS building a transaction means signing it, which means
the key. Android can show real figures without an unlock because its node holds
the key and builds the transaction for it.

Nothing has left the wallet at that point — the sentence on the review screen is
still literally true — but the Face ID prompt arrives one step sooner.

### 4. A send has three outcomes, not two

`POST /api/tx` answers whether **the network** has the transaction, which is a
bigger claim than "a node accepted it". `network.has_it` is three-valued and
this app keeps it that way:

| value | what the app says |
|---|---|
| `true` | Sent |
| `false` | Not sent, with the reason. A fact — the coins are untouched. |
| `null` | **Not confirmed yet.** Not a failure. "Do not send it again; check your activity in a few minutes." |

`?? false` on that value would tell somebody their payment failed while it is
confirming. A transport failure is reported the same way, because the txid is
computed from the submitted bytes before the node is contacted — a lost response
has lost nothing, and resubmitting the identical hex is safe.

### 5. Spending requires one confirmation

Bitcoin Core defaults `spendzeroconfchange` to true, so the node inside the
Android app will spend its own change the moment it is broadcast.

This app has no node and therefore no way to be sure an unconfirmed output is
its own change rather than an incoming payment somebody can still replace — and
this chain reorgs routinely. One confirmation is the smallest gate that makes
the question answerable. The practical cost: a second send immediately after the
first may have to wait for a block.

### 6. Balance reading uses a cached account xpub

Reading a balance must not prompt for Face ID — nobody expects that, and Android
does not do it, because its node already holds the descriptors.

So the account **xpub** is cached in the Keychain ungated. It derives every
address the wallet owns and can spend nothing. The cost is stated rather than
hidden: anyone who obtains it learns every address this wallet has used and can
watch its balance. That is a privacy loss, not a theft risk, and it is why the
item is `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`.

The phrase itself is touched only for a spend or a deliberate "show me my words".

### 7. Gap-limit scanning, not a 1000-address import

Android hands its node `wpkh(...)` descriptors with a 1000-address range and
lets it rescan locally, which costs nothing when you already have the chain.
A light client has to ask about each address, so `WalletScanner` walks in
windows of 40 and stops after 20 consecutive unused addresses, with a floor of
40 so a wallet whose first few addresses happen to be unused is never wrongly
declared empty. When a scan stops at its cap instead of at the gap limit, the
home screen says so rather than showing a total that could be short.

## What is deliberately absent

* **No miner.** Apple prohibits on-device mining. The Android project compiles
  mining out of its wallet flavour; there is no iOS equivalent to compile in and
  one must never be added.
* **No copy or share button on the recovery phrase.** A phrase in the clipboard
  is a phrase every app on the phone can read.
* **No fee estimator.** Three fixed rates — 1, 5, 20 sat/vbyte — exactly as
  Android offers. This chain has almost no fee market and `estimatesmartfee` has
  nothing to learn from.
* **No ETA anywhere.** Block spacing here is noisy and routinely far from the
  600 s target in both directions, and block timestamps are not monotonic in
  height. Maturity is stated in blocks, never in hours.

### 8. A Simulator with no passcode holds the phrase ungated

`.userPresence` cannot be satisfied on a device with no passcode, and a
simulator has none by default — `SecItemAdd` refuses rather than prompting. The
alternative was an app that cannot create a wallet on a simulator, which would
make the whole thing untestable without a device.

So it falls back, and says so: the mode is recorded, shown in Settings as
**"NOT GATED (Simulator, no passcode)"**, and raised in the warnings list as
*"Your recovery phrase is NOT protected"*. `#if targetEnvironment(simulator)`
keeps it out of every device binary. A security property that quietly degrades
is worse than one that was never claimed.

## Verified

* `swift test` — **67 tests, 0 failures**, on macOS with no simulator.
* `xcodebuild test -only-testing:PCoinWalletUITests` — **3 tests, 0 failures**,
  the three payment-link cases against the real screens in the iOS 18.3
  Simulator, plus a screenshot of each.
* Every app source compiles against the iOS SDK.
* `POST /api/tx` on explorer.pc.am parsed a transaction this code serialised and
  reported its vsize, input count and output count correctly.

## Known gaps

* **No real-device build has been produced.** The Mac this was built on has no
  code-signing identity and no device attached; `security find-identity -v -p
  codesigning` reports 0 valid identities. Everything below the signing step is
  verified.
* **No send has been made end to end.** The path is wired and the endpoint is
  live, but sending needs a wallet with coins.
* **No app icon or asset catalogue.** The build produces an app with the default
  icon.
* **History is read per used address**, one request each, merged by txid. Fine
  for a wallet with a handful of addresses; a wallet with hundreds would want the
  explorer to grow a per-xpub history endpoint.
* **The App Store listing has not been written.** `contrib/android/playstore/v1/
  STORE-LISTING.md` is the source to adapt.
