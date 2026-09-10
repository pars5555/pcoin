# Handoff: PCoin Wallet 0.2.20 → Google Play

**For the Android team. Everything below is either verified on hardware or
explicitly marked as not.**

The change is small and entirely inside the payment-link path. No consensus
code, no key handling, no derivation, no UI outside one screen and one field.

---

## What changed, and why

Three defects, all found by driving a real phone rather than reading code. The
device was a **moto g play (2024), serial `ZY22K8JLCH`** — deliberately *not*
the owner's identical `ZY22KFX8TV`, which holds the treasury.

### 1. A payment link's amount was thrown away

`SignRequestActivity` parsed the amount, displayed it in the largest type on
the screen, and then called `SendActivity.intentFor(this, target.address)` —
address only. Every link produced a half-filled form, and the person had to
read the number off the previous screen and retype it.

This was deliberate. The comment argued that a number you type yourself is one
you have read. The owner overruled it and I agree: the review screen has
already shown the amount, so it *has* been read; retyping mostly produces
typos; and every BIP21 wallet prefills.

**Nothing protective was removed.** The field is ordinary and editable, it goes
through the same validation, the fee is still shown, and the Keystore unlock
still stands between the request and any money moving.

- `SendActivity`: new `EXTRA_AMOUNT_SAT`; `intentFor(ctx, address, amountSat = 0L)`
- Prefills only when `> 0` — a link naming no amount must not write
  `0.00000000` into the box, which would be a confident answer to a question
  nobody asked

### 2. A link with no wallet set up walked through to Send

A fresh install with no wallet still offered the send screen — which cannot
send and does not say why, so it reads as *the payment failed* rather than *you
have no wallet yet*.

Now checked with `SeedStore.exists()` **before the request is displayed**, so
nobody reads an address and an amount and forms an intention they cannot act
on. The screen explains, hides Continue, and offers:

1. **Set up a wallet** — the action that actually resolves it. This app is
   demonstrably installed or the screen could not be drawing, so what is
   missing is a wallet, not the app.
2. **Get PCoin Wallet on Google Play** — underneath, for a stale sideloaded
   build. `market://` first, `https://play.google.com/...` as fallback.

### 3. The parser accepted an address the Windows wallet rejected

`PaymentUri.parse` refused only *whitespace*. A link ending
`...nq4j\?amount=7.25` — one stray escape — parsed as an address with a
trailing backslash and was shown as legitimate all the way to the send form.
The Windows wallet already required alphanumerics.

Two wallets disagreeing about what an address **is** is the worst possible
place for them to differ, and this is the screen whose entire job is showing
the true destination. Nothing could have been lost — a node rejects such an
address — but it must never be displayed as real.

Now `address.any { !it.isLetterOrDigit() }` → reject. Both address formats this
chain uses are alphanumeric (bech32 `pc1…`, base58 `P…`), so this is not a
narrowing of what is legitimate.

**Regression test added and passing:** `PaymentUriTest` →
`address with a non alphanumeric character is refused`, covering `\ / ; " <`
and `%20`.

---

## Files touched

```
app/src/main/java/org/pcoin/miner/PaymentUri.kt          validation
app/src/test/java/org/pcoin/miner/PaymentUriTest.kt      regression test
app/src/wallet/java/org/pcoin/miner/SendActivity.kt      EXTRA_AMOUNT_SAT, prefill
app/src/wallet/java/org/pcoin/miner/SignRequestActivity.kt  no-wallet guard, amount
app/src/wallet/res/layout/activity_sign_request.xml      sr_setup, sr_store
app/src/wallet/res/values/strings.xml                    4 new strings
```

---

## Verified on hardware — reproduce these before submitting

Install the wallet flavour, then from a PC:

```
adb -s <serial> shell am start -a android.intent.action.VIEW \
  -d "'pcoin:pc1qnfk7xenwzxx7h4mx88g004crlx0m2zcjg3nq4j?amount=7.25'"
```

| case | expected |
|---|---|
| valid link, wallet set up | review shows **7.25000000 PCN**; Continue → send form **prefilled with the amount** |
| valid link, **no wallet** | explains; **Set up a wallet** + **Get PCoin Wallet on Google Play**; **no Continue button** |
| `...nq4j\?amount=7.25` | *"This request could not be read, so it is being refused rather than half-understood. Nothing has been sent."* |
| no wallet app at all | `am` reports `No activity found` — the OS has nothing to hand it to |

Unit tests: `gradlew.bat testWalletDebugUnitTest --tests "org.pcoin.miner.PaymentUriTest"`

> **Never run bare `gradlew.bat testDebugUnitTest`.** It includes
> `ForwardSandboxE2ETest`, which shells out to a hard-coded adb and phone serial
> and runs a real regtest node on that device. Always pass `--tests`.

---

## Before you upload — the traps that have actually bitten

1. **Check the targetSdk floor in the console first.** It moves and only the
   console tells you. 35 was mandatory on 2026-08-31; an upload was rejected on
   2026-09-06 for *"must target at least API level 36"*. The current build is
   `targetSdk 36`. A rejected upload **burns the version code**.
2. **Version code must increase.** Play build is `versionCode 22` /
   `versionName 0.2.19`. This goes out as **23 / 0.2.20**.
3. **16 KB alignment** on native libraries — link with
   `-Wl,-z,max-page-size=16384`, keep CameraX at 1.4.x.
4. **Signing:** upload with the release keystore (`2dc08424`); Play re-signs to
   `dd4116a5`. Do **not** ship a debug-signed build (`de1fd650`) — it cannot
   upgrade the store app and switching forces an uninstall, which destroys the
   user's wallet.

## Release notes (suggested, ~450 chars)

> Payment links now fill in the amount, not just the address — you no longer
> retype a number you were just shown.
>
> Opening a payment link before you have set up a wallet now explains what is
> missing instead of showing a send screen that cannot send.
>
> A malformed payment link is refused outright rather than partly understood.

## What is NOT in this build

- No change to derivation, key storage, the Keystore gate, or `Redact`
- No change to the miner flavour
- No new permissions
- No analytics
