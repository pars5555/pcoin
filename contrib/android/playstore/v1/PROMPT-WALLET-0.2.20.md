# Prompt for the Android team — submit PCoin Wallet 0.2.20 to Play review

Paste everything below the line into a fresh session on the machine that holds
the release keystore. It is written to be self-contained: it names the traps
that have actually bitten this project, so nobody has to have been here before.

---

You are submitting **PCoin Wallet 0.2.20** to Google Play production review.

Repo: `d:\xampp\htdocs\pcoin`, Android project at `contrib/android`.
The full engineering write-up of what changed is
`contrib/android/playstore/v1/HANDOFF-WALLET-0.2.20.md` — **read it first**, it
explains each fix and how it was verified on hardware. The rest of the Play
process (listing copy, declarations, signing) is in the same directory:
`DEPLOY.md`, `SUBMISSION.md`, `SIGNING.md`, `STORE-LISTING.md`.

## What you are shipping

App: **`am.pc.pcoinwallet`**, the `wallet` product flavour (mining is compiled
out of this flavour — do not ship `miner`).

| | |
|---|---|
| going out as | **versionCode 23 / versionName 0.2.20** |
| currently live on Play | versionCode 22 / 0.2.19 — **confirm this in the console**, do not trust this line |
| track | production |

Three defects in the payment-link path, all found by driving a real phone:

1. **A payment link's amount was thrown away.** It was parsed, shown in the
   largest type on the review screen, and then dropped — every link produced a
   half-filled send form and the person retyped a number they had just been
   shown. Now prefilled, only when the link actually names an amount.
2. **A link opened with no wallet set up walked through to the send screen** —
   which cannot send and does not say why, so it reads as *the payment failed*
   rather than *you have no wallet yet*. Now checked with `SeedStore.exists()`
   before the request is displayed: it explains, hides Continue, and offers
   "Set up a wallet" plus a Google Play link.
3. **The parser accepted an address the Windows wallet rejected.** One stray
   escape (`...nq4j\?amount=7.25`) parsed as an address with a trailing
   backslash and was displayed as legitimate. Nothing could have been lost — a
   node rejects such an address — but two wallets disagreeing about what an
   address *is* must never happen on the screen whose whole job is showing the
   true destination. Now `address.any { !it.isLetterOrDigit() }` → reject.

No change to derivation, key storage, the Keystore gate, or `Redact`. No new
permissions. No analytics. No change to the miner flavour.

## The artifact

A signed bundle has been built and verified on this machine:

```
contrib/android/app/build/outputs/bundle/walletRelease/app-wallet-release.aab
built    2026-09-10 15:43
sha256   05496cf733fb0ec8b194fde7b7979dc8f3ac5af7e8995e3bb73f3d039c319e22
```

**Hash it before you upload it.** A stale bundle from the previous day sat in
that exact path during this work -- same name, same directory, plausible size,
containing the old code. It would have uploaded and looked completely normal.
That is the whole reason the hash is written down here. If it does not match,
rebuild rather than guessing which one you are holding:

```powershell
cd D:\xampp\htdocs\pcoin\contrib\android
.\gradlew.bat bundleWalletRelease
```

(Use PowerShell and the `.\` prefix. Invoked as a bare `gradlew.bat` from some
shells it is not found, and the build silently does not happen -- which looks
exactly like a build that succeeded and changed nothing.)

Verify what you are about to upload rather than assuming. Note the bundle
directory has **no** `output-metadata.json` -- that file is written for APK
outputs only, so read the version from the APK of the same build:

```powershell
Get-FileHash app\build\outputs\bundle\walletRelease\app-wallet-release.aab -Algorithm SHA256

type app\build\outputs\apk\wallet\release\output-metadata.json

apksigner verify --print-certs app\build\outputs\apk\wallet\release\app-wallet-release.apk
```

Confirmed on 2026-09-10 for the bundle above: application id
`am.pc.pcoinwallet`, versionName `0.2.20` present in `base/manifest`, signed.

Expected signer: **`2dc08424507c08c12f5afb7ce7328d5f4fec772dde04de40d69a69e8dcaccb32`**.
Play App Signing re-signs the upload to `dd4116a5`, which is what users get.
**Never ship a debug-signed build (`de1fd650`)** — it cannot upgrade the store
app, and switching keys forces an uninstall, which destroys the user's wallet
and address book. That has already cost a real person a ten-entry address book.

## Before you upload — traps that have actually bitten this project

1. **Check the targetSdk floor in the console FIRST.** It moves and only the
   console tells you. 35 was mandatory on 2026-08-31; on 2026-09-06 an upload
   was rejected for *"must target at least API level 36"* — eight days later,
   with no local warning, after the bundle had been uploaded. This build is
   `compileSdk 36` / `targetSdk 36`, which was correct as of 2026-09-10.
2. **A rejected upload burns the version code.** A consumed code can never be
   reused, so a failed attempt costs a bump. Get the floor right before, not
   after.
3. **16 KB native-library alignment** — `bitcoind`/`bitcoin-cli` are linked with
   `-Wl,-z,max-page-size=16384` and CameraX is pinned to 1.4.x. 1.3's
   `libimage_processing_util_jni.so` is 4 KB-aligned and fails Play's check.
4. **Never run bare `gradlew.bat testDebugUnitTest`.** It includes
   `ForwardSandboxE2ETest`, which shells out to a hard-coded adb path and a
   hard-coded phone serial and runs a real regtest node on that device for ten
   minutes. It is a device-touching operation dressed up as a unit test. Always
   pass a `--tests` filter:
   ```cmd
   gradlew.bat testWalletDebugUnitTest --tests "org.pcoin.miner.PaymentUriTest"
   ```

## Verified on hardware — reproduce before submitting if you want your own proof

Tested on a **moto g play (2024), serial `ZY22K8JLCH`** — deliberately *not*
the owner's identical `ZY22KFX8TV`, which holds the treasury and must never be
experimented on. Guard on the serial before any install or uninstall.

```cmd
adb -s <serial> shell am start -a android.intent.action.VIEW ^
  -d "'pcoin:pc1qnfk7xenwzxx7h4mx88g004crlx0m2zcjg3nq4j?amount=7.25'"
```

| case | expected |
|---|---|
| valid link, wallet set up | review shows **7.25000000 PCN**; Continue → send form **prefilled with the amount** |
| valid link, **no wallet** | explains; **Set up a wallet** + **Get PCoin Wallet on Google Play**; **no Continue button** |
| `...nq4j\?amount=7.25` | *"This request could not be read, so it is being refused rather than half-understood. Nothing has been sent."* |
| no wallet app installed | `am` reports `No activity found` — the OS has nothing to hand it to |

Confirmed on 2026-09-10 against the 0.2.20 build on a fresh, never-launched
install: the no-wallet screen appeared with no Continue button, and both the
setup and Play buttons were present.

## Release notes for the console (~450 chars, ready to paste)

> Payment links now fill in the amount, not just the address — you no longer
> retype a number you were just shown.
>
> Opening a payment link before you have set up a wallet now explains what is
> missing instead of showing a send screen that cannot send.
>
> A malformed payment link is refused outright rather than partly understood.

## When it is live

Tell the owner, and update `pc.am` if anything user-visible changed there — a
PCoin change is not finished until the public surfaces match it. The download
and payment pages already point Android users at Google Play rather than the
`.apk`, which is deliberate: the two are signed with different keys and cannot
upgrade each other.

**Do not announce this to the Telegram channel.** The owner's standing
instruction is that nothing is announced until a big change; releases go to the
website only, and every announcement needs his approval first.
