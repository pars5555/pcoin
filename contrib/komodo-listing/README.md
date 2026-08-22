# Listing PCN on the Komodo DeFi Framework

Everything needed to open the PR, and the reasoning behind each choice. The
ElectrumX servers this depends on are in [`../electrumx`](../electrumx).

**Submit to `GLEECBTC/coins`, not `KomodoPlatform/coins`.** The latter is not
merely stale — it is a *downstream fork* of the former, last pushed December
2025, with zero coin additions ever merged. Gleec acquired Komodo's cross-chain
DeFi stack and development moved with it. The same is true of the framework
itself: `KomodoPlatform/komodo-defi-framework` 301-redirects to
`GLEECBTC/komodo-defi-framework`.

---

## Status

| requirement | state |
|---|---|
| 2+ ElectrumX servers, real SSL | ✅ `electrum1.pc.am`, `electrum2.pc.am` |
| WSS | ✅ port 50004 on both, `ws_url` in `electrums/PCN` |
| Admin contact | ✅ `pcoin@pc.am` + GitHub `@pars5555` |
| Server monitoring | ✅ `pcoin-electrumx-watch`, 10-minute timer on both hosts |
| `coins` entry | ✅ `files/coins-entries.json` — validated in a live KDF |
| `electrums/PCN` | ✅ |
| `explorers/PCN` | ✅ two independent explorers |
| `icons_original/pcn.png` | ✅ 256×256 |
| **One completed atomic swap** | ⛔ **the remaining gate** — see below |

---

## The coins entry, and why it says what it says

Two entries, because native-segwit is a separate coin in this repo rather than a
flag — the same treatment BTC gets:

* **`PCN`** — legacy, `m/44'/9444'`, addresses start `P…`
* **`PCN-segwit`** — `m/84'/9444'`, `pc1q…`, `orderbook_ticker: "PCN"` so both
  share one orderbook

**`PCN-segwit` is the one that matters to real users.** PCoin's Android app and
Windows tray are BIP84-only, and every mining payout the chain has ever made went
to an `m/84'/9444'` path. Someone importing their twelve words and finding only
the legacy entry would see an empty wallet.

Four fields that are easy to get wrong and were each checked against source:

| field | value | why |
|---|---|---|
| `sign_message_prefix` | `"PCoin Signed Message:\n"` | **not** Bitcoin's. `src/common/signmessage.cpp:24` |
| `rpcport` | `9443` | P2P **minus** one, because P2P plus one is bitcoind's Tor onion listener. A merged PR (#1960) exists that did nothing but fix another coin's P2P/RPC mix-up |
| `txfee` | `10000` | flat, **not** `0`. Zero means "use `estimatesmartfee`", and PCoin has no fee history for it to work from |
| `derivation_path` | `m/44'/9444'` / `m/84'/9444'` | `9444'` is unregistered in SLIP-44 and cannot be changed — see the PR body |

`required_confirmations` is `10`: the highest value in use anywhere in that
repository. It is not a mitigation for the hashrate concentration and the PR body
says so outright. See [`PR-BODY.md`](PR-BODY.md).

**Validated against a real KDF, not just eyeballed.** `kdf 3.0.0-beta` enabled
both entries through `electrum1/2.pc.am` and derived
`PNX1j3p4R8ZUvzVaaak5CnjzYspyPf13tx` and
`pc1qnryrnsz3xpe2ya0r8xhw9ghduua24d9j70kvdd`; PCoin's own node returns
`isvalid: true` for both, with the expected P2PKH and P2WPKH scriptPubKeys. That
round trip is what proves the version bytes and the bech32 hrp are right.

---

## The swap

Komodo requires the coin to have completed one real atomic swap, and the five
resulting txids go in `swaps/PCN-DOGE.md`.

**The counterparty is DOGE, not KMD, and that was forced rather than chosen.**
KMD is the convention — 120 of the 136 existing swap files use it — but:

* The only crypto available to fund the taker side was TRX and USDT-TRC20, and
  **both carry `"wallet_only": true` in Komodo's own coins file.** KDF can hold
  them and cannot swap them; Tron has no HTLC path in KDF. Check that flag before
  planning a swap around any coin.
* Converting to KMD via an instant swapper is not available either:
  `usdttrc20_kmd` and `trx_kmd` both return **`pair_is_inactive`** on ChangeNOW.
  KMD is thinly supported by aggregators.
* `trx_doge` is active with a minimum of **3.75 TRX**, and DOGE is a plain UTXO
  coin with `wallet_only: false`, 60-second blocks and `required_confirmations: 2`
  — strictly easier to settle than KMD's 4.

Nothing in Komodo's requirement names KMD; it asks for "a successful Atomic Swap
using Komodo DeFi Framework", and 16 of the existing files use other counterparties.

Two KDF instances are set up on seed 3 under `/opt/kdf` (`maker/` and `taker/`),
each with its own BIP39 passphrase in `/opt/kdf/secrets/wallets.json`, mode 0600.
Both are on netid **6133**.

> **netid 8762 is deprecated and KDF refuses to start on it**, as is 7777 before
> it. `DEPRECATED_NETID_LIST` in `mm2src/mm2_p2p/src/behaviours/atomicdex.rs`.
> Also: `is_bootstrap_node` **defaults to true**, and a bootstrap node must also
> be a seed node — so an ordinary wallet needs `"is_bootstrap_node": false` plus
> a `seednodes` list, or it dies in a precheck whose message names neither field.
> Take the seed list from `GLEECBTC/coins/seed-nodes.json`, filtered to netid
> 6133; the file still contains 8762 entries that would leave you on an empty
> network.

To run it once both wallets are funded:

```sh
/opt/kdf/rpc maker '{"method":"setprice","base":"PCN","rel":"DOGE","price":"0.2","volume":"100"}'
/opt/kdf/rpc taker '{"method":"buy","base":"PCN","rel":"DOGE","price":"0.21","volume":"100"}'
/opt/kdf/rpc taker '{"method":"my_recent_swaps","limit":5}'
```

Pull the five txids from the finished swap's events — `TakerFeeSent`,
`MakerPaymentReceived`/`MakerPaymentSent`, `TakerPaymentSent`,
`TakerPaymentSpent`, `MakerPaymentSpent` — and write them into
`files/swaps/PCN-DOGE.md` in that order.

**A self-swap satisfies Komodo's requirement but is not a price.** Both wallets
here are ours, so the resulting number means nothing about what PCN is worth, and
nothing on pc.am may ever quote it. The first real price comes from a stranger.

---

## Opening the PR

Copy into a fork of `GLEECBTC/coins@master`:

```
files/coins-entries.json   -> append both objects to the top-level `coins` file
files/electrums/PCN        -> electrums/PCN
files/explorers/PCN        -> explorers/PCN
files/icons_original/pcn.png -> icons_original/pcn.png
files/swaps/PCN-DOGE.md    -> swaps/PCN-DOGE.md
```

Do **not** add `icons/pcn.png`. That directory is generated by
`.github/workflows/gen_configs.yml`, which resizes everything in
`icons_original/` to 128×128 and opens its own bot PR; a hand-added file
conflicts with it.

Use [`PR-BODY.md`](PR-BODY.md) as the description, and **re-measure the hashrate
concentration immediately before filing** — `pcoin-concentration-watch --window
300` on any seed. It moves, and the PR body quotes a number.

Questions go to `#dev-support` on the Komodo Platform Discord.

---

## Two upstream monitoring endpoints are dead

The repo README points at
`electrum-status.dragonhound.info/api/v1/electrums_status` and
`stats.kmd.io/atomicdex/electrum_status/` for server health. As of 2026-08-22 the
first resets the TLS handshake and the second returns HTTP 521. **Do not plan
around either** — the delisting rule still applies regardless, because the
scanner that feeds it (`utils/scan_electrums.py`, `utils/uptime_tracker.py`) runs
inside the repo on a daily cron. Our own `pcoin-electrumx-watch` is the thing
that will actually tell us first.
