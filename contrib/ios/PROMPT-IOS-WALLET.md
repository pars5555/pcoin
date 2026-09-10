# Prompt for the iOS team — build PCoin Wallet for iPhone

Paste everything below the line into a fresh session on the Mac mini. It is
written to be self-contained.

---

You are building **PCoin Wallet for iOS**, to match the shipping Android app.

The brief from the owner is *"the iOS wallet should be identical to the Android
one"*. Treat that as binding for behaviour, wording and screens. There is
exactly **one** respect in which it cannot be met, and it is architectural —
read the next section before planning anything, because it decides the whole
build.

Reference sources, all in the repo `d:\xampp\htdocs\pcoin` (public on GitHub at
`github.com/pars5555/pcoin`):

| what | where |
|---|---|
| the app you are matching | `contrib/android/app/src/wallet/java/org/pcoin/miner/` |
| chain identity, address formats, ports | `PCOIN.md` §1 |
| **derivation, descriptors, published test vectors** | `PCOIN.md` §6 — §6.4 is the acceptance test |
| explorer HTTP API | `contrib/explorer/pcoin_api/API.md`, live at `explorer.pc.am/api` |
| orientation for the whole project | `CLAUDE.md` |

---

## 1. The one thing that is NOT identical, and a blocker you do not own

**The Android app runs a real PCoin node inside itself.** `bitcoind` ships as
`jniLibs/arm64-v8a/libbitcoind.so` and is exec'd from `nativeLibraryDir`. It
syncs the chain, holds the UTXO set, builds transactions and broadcasts them
itself. That is why the Android wallet needs no server in order to send money.

**iOS forbids this.** An app may not exec a separate executable, and may not
JIT. So the iOS wallet must be a **light client**: keys and signing on the
device, chain data over HTTP from `explorer.pc.am`.

That changes what you build, and it exposes a gap on our side:

> ### BROADCAST IS CURRENTLY REFUSED IN PRODUCTION
>
> Measured 2026-09-10 against all three instances:
>
> ```
> POST https://explorer.pc.am/api/tx   {"hex":"..."}
> -> {"error":{"code":"broadcast_unavailable",
>     "message":"the broadcast node has wallet RPCs enabled (listwallets
>     succeeded and returned 1 loaded wallet(s)); this API refuses to relay
>     through a node that can spend. Run it with -disablewallet, or pass
>     --allow-wallet-node to accept the risk explicitly."}}
> ```
>
> explorer2 answers the same; explorer3 cannot reach its node at all (HTTP 403).
> The refusal is the API behaving correctly — it will not relay through a node
> that holds keys — but the effect is that **no public broadcast path exists
> today**. Android never hit this because it broadcasts through its own node.
>
> **This is server work on the PCoin side, not yours.** Raise it before you
> start: someone must stand up a broadcast node with `-disablewallet`. Do not
> design around it, do not ship a wallet that cannot send, and do not reach for
> `--allow-wallet-node` to make the error go away — that flag exists to accept a
> real risk explicitly, and it is not yours to accept.

Everything else — balances, history, UTXOs, fee inputs — is already available
and working. Verified live on 2026-09-10:

| endpoint | use |
|---|---|
| `GET /api/status` | height, index freshness |
| `GET /api/address/{addr}` | balance, used flag, history, unconfirmed history |
| `GET /api/address/{addr}/txs` | history page |
| `GET /api/address/{addr}/utxos` | **note the plural** — `/utxo` is a 404 |
| `POST /api/addresses` `{"addresses":[...]}` | gap-limit scan; 20-200 addresses do not fit in a URL |
| `GET /api/tx/{txid}` | one transaction |
| `POST /api/tx` `{"hex":"..."}` | broadcast — **blocked, see above** |

Every response carries an `index` block. **Read it every time**, and gate on
`index.stale == false`, `node_reachable`, and `blocks_behind == 0`. A stale
index is not an error; it is an old answer that looks current, and a wallet that
spends off one double-spends itself.

---

## 2. What must match Android EXACTLY

### The key scheme — not negotiable

BIP39, **12 words**, 128 bits of entropy. Derivation:

```
m / 84' / 9444' / account' / change / index      (BIP84, native SegWit)
```

Addresses are bech32 with hrp **`pc`** (`pc1q…`). Legacy base58 versions are
55 / 56 / 183.

**Coin type 9444' is load-bearing and must never change.** PCoin kept Bitcoin's
BIP32 version bytes (`0488ADE4`), so a PCoin extended key literally serialises
as `xprv…`. Under coin type 0 the same phrase would derive byte-identical keys
on Bitcoin and PCoin. 9444' is the only thing keeping the two trees apart.

**Your acceptance test is `PCOIN.md` §6.4**, and it is published, so getting it
wrong is not a matter of opinion. Using the standard all-zero BIP39 burn phrase
`abandon abandon … about` with an empty passphrase:

```
master fingerprint       73c5da0a
m/84'/9444'/0'/0/0       pc1qj7lccmpqhdgg6enh503hqqyx244e49yespm8pf
m/84'/9444'/0'/0/1       pc1q0ncnjjyklxwts46h7e7jmls0l8d99lhv3wk0sm
m/84'/9444'/0'/0/2       pc1qzze3twr9c0cg0s3v2yh7797gae4ufk7zu4wux0
```

Write those as a unit test **first**, before any UI. A wallet that derives
differently is not a compatible wallet — the same twelve words must restore the
same money on Android, Windows and iOS. That property is the product.

Never put coins on that phrase; it is a burn phrase in every wallet's test
suite.

### Key storage

Android holds the phrase as AES-256-GCM ciphertext under a key that lives in
AndroidKeyStore and never leaves it, created with
`setUserAuthenticationRequired(true)` — so the cipher **physically cannot**
produce plaintext without a fresh device unlock. A rooted device cannot skip
past a boolean callback, because there is no boolean.

Build the same property on iOS, not a lookalike: Keychain with
`kSecAttrAccessibleWhenUnlockedThisDeviceOnly` and an access control of
`.userPresence` / `.biometryCurrentSet`, backed by the Secure Enclave. The
authentication must gate the **key**, not a screen. A biometric prompt whose
success branch merely calls your own `unlock()` is theatre.

`…ThisDeviceOnly` is deliberate: the phrase must not travel in an iCloud
Keychain backup.

**The phrase is never logged, never put in a notification, never written
anywhere else.** Android has a `Redact.kt` whose whole job is keeping that true.
Build the equivalent, and test it.

### Screens

Match these one for one, including the wording:

| Android | what it is |
|---|---|
| `MainActivity` | balance, receive address, send/receive, warnings strip |
| `SendActivity` | address, amount, fee, review, confirm |
| `ScanActivity` / `QrView` | QR scan and display |
| `HistoryActivity` | transaction history, searchable |
| `AddressBookActivity` | saved counterparties |
| `SettingsActivity` | settings |
| `SignRequestActivity` | **the payment-link review screen** — see §3 |
| `WalletWarnings` | the warnings shown on the main screen |

---

## 3. Payment links — three fixes shipped in 0.2.20; match all three

Android registers the **`pcoin:`** scheme. Do the same on iOS
(`CFBundleURLTypes`), and also claim the universal link `https://pc.am/pay` —
the hop page at `site/pay/index.html` exists because a Telegram mini app runs in
a sandboxed iframe and cannot navigate to a custom scheme.

URI shape: `pcoin:<address>?amount=<PCN>`.

1. **The amount is prefilled, not retyped.** It used to be parsed, shown in the
   largest type on the review screen, and then dropped — every link produced a
   half-filled form. Prefill only when the link actually names an amount: a link
   with no amount must not write `0.00000000` into the box, which is a confident
   answer to a question nobody asked.
2. **A link with no wallet set up must not reach the send screen.** Check
   *before* the request is displayed, so nobody reads an address and an amount
   and forms an intention they cannot act on. Explain, hide Continue, and offer
   "Set up a wallet" plus a link to the App Store listing. A send screen that
   cannot send and does not say why reads as *the payment failed*, not *you have
   no wallet yet*. This exact bug was reported on both Android and Windows.
3. **Refuse a malformed address outright.** The rule is
   `address.any { !it.isLetterOrDigit() }` → reject. Both PCoin address formats
   are alphanumeric (bech32 `pc1…`, base58 `P…`), so this narrows nothing
   legitimate. It was found because `...nq4j\?amount=7.25` — one stray escape —
   parsed as an address with a trailing backslash and was displayed as
   legitimate all the way to the send form. Two wallets disagreeing about what
   an address *is* is the worst possible place to differ, and this is the screen
   whose entire job is showing the true destination.

Test each with:

```
xcrun simctl openurl booted "pcoin:pc1qnfk7xenwzxx7h4mx88g004crlx0m2zcjg3nq4j?amount=7.25"
```

| case | expected |
|---|---|
| valid link, wallet set up | review shows **7.25000000 PCN**; Continue → send form prefilled |
| valid link, **no wallet** | explains; "Set up a wallet" + App Store link; **no Continue** |
| `...nq4j\?amount=7.25` | refused: *"This request could not be read, so it is being refused rather than half-understood. Nothing has been sent."* |

---

## 4. Rules this project has already paid for

1. **A failed, timed-out or "I don't know" read resolves NOTHING.** It can never
   advance a record, clear one, or authorise a send. Model *unknown* as its own
   state; never let it collapse into *no*. In Swift the network layer returns
   `Result` or throws — never an optional you then `?? 0`. A `?? 0` on a call
   that may not have happened is a bug: it turns "I could not ask" into "the
   answer is zero". That has cost this project money twice; a failed
   `getrawtransaction` read as "0 confirmations" authorises spending the same
   coins again.
2. **Gate on the transaction's own block height**, 3 confirmations (100 for
   coinbase). **Never gate on `blocks_unwound` or `reorg_count`** — they are
   cumulative lifetime counters. Six PCoin payment rails gated on
   `blocks_unwound == 0`; one ordinary 1-block reorg set it to 1 permanently and
   all six silently refused to credit anything for three and a half days while
   exiting clean every tick.
3. **This chain reorgs routinely.** Handle it from day one. Block timestamps are
   **not monotonic in height**, so "time since the last block" can come out
   negative. Never render an ETA from a hardcoded spacing.
4. **Amounts arrive as bare JSON numbers**, not strings. Round to satoshis
   explicitly and do every calculation in integer satoshis. Never let a `Double`
   near a balance.
5. **Not every output has an address** — genesis is a raw pubkey output, and
   every coinbase carries a zero-value OP_RETURN witness commitment. Address
   must be optional in your model.
6. **A wallet needs mempool awareness.** Without it, asking for UTXOs straight
   after a send hands back the outpoint you just spent and the wallet
   double-spends itself. The address endpoints return `mempool` and
   `unconfirmed_history` — use them.

---

## 5. App Store

- It is a **non-custodial** wallet: keys never leave the device, we hold nothing,
  there is no account and no server-side balance. Say so plainly in the review
  notes — it is the question Apple asks first.
- **No mining.** The Android project has two flavours and the mining one is
  compiled out of the wallet. There is no iOS miner and you must not add one:
  Apple prohibits on-device mining and it would sink the review.
- Expect the export-compliance questions: standard cryptography, nothing
  proprietary.
- Android listing copy is in `contrib/android/playstore/v1/STORE-LISTING.md` —
  match its tone and claims, adapted to Apple's format.

## 6. What to hand back

1. The derivation unit test passing against `PCOIN.md` §6.4, shown as output.
2. A build on a real iPhone with the three payment-link cases exercised.
3. A written note on anything where "identical to Android" had to bend, and why.
4. Confirmation that you did **not** work around the broadcast blocker.

Do not announce anything publicly. Releases go to the website only, and every
announcement needs the owner's approval first.
