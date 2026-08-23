# Add PCoin (PCN)

PCoin is an independent Layer-1 forked from Bitcoin Core v29.4, with proof-of-work
replaced by RandomX (CPU-mined, ASIC-resistant) and the difficulty algorithm
replaced by LWMA. Bitcoin's economics are untouched: 21 M cap, 50 PCN block
reward, 210 000-block halving, 600 s target spacing. No premine, no ICO, no
allocation — the genesis output is unspendable, as in Bitcoin.

- Source: https://github.com/pars5555/pcoin
- Site: https://pc.am
- Explorers: https://explorer.pc.am · https://explorer3.pc.am
- BitcoinTalk ANN: https://bitcointalk.org/index.php?topic=5591113.0

---

## Please read this first: hashrate concentration

**One unidentified solo miner currently finds about 72% of PCoin blocks
(95% CI 67–77%, measured over the last 300 blocks, at height 4719).** I am
stating this unprompted, before anyone asks, because it is the single most
important fact about accepting PCN in a swap, and a counterparty who discovers
it later is entitled to assume it was hidden.

Measured repeatedly over the last day it read 70.0%, 70.3%, 70.7% and 71.7% —
**it is drifting up, not down.** I would rather show you the trend than a single
flattering reading.

What that means concretely:

- Komodo DeFi Framework itself holds nothing, so **the venue carries no
  balance-sheet risk**. The risk transfers wholly to whoever takes the PCN side
  of a swap: a majority miner can reorg the PCN funding transaction after the
  other leg has settled irreversibly.
- **`required_confirmations` does not fix this, and on a 600-second chain it
  cannot even try.** Confirmations set an attacker's waiting time, not their
  cost. I first set it to `10` — the highest value in use anywhere in this
  repository — and then tested it, and **every swap fails**:

  > `MakerPaymentWaitConfirmFailed` — *"Waited too long … for transaction
  > b03d58f9… to be confirmed 10 times"* (it reached 4)

  KDF requires the maker payment to confirm within **40% of `PAYMENT_LOCKTIME`**,
  which is `3600*2 + 300*2 = 7800 s`, so **3120 s**. At 600 s spacing that is
  ~5.2 blocks expected, and block spacing under LWMA is noisy in both
  directions. Ten is unreachable; even 5 would fail roughly a third of the time.
  The 4× locktime extension is a hardcoded list — `BCH | BTG | SBTC` — that PCN
  cannot join without a change to your codebase.

  **So it is `2`**, which is what BLOZ (a 600 s Bitcoin fork merged this month)
  uses, and one above BTC's own `1`. I would rather ship a value that works than
  a value that signals caution and silently breaks every swap.

  Read that as sharpening the disclosure, not softening it: **on a chain with
  this block time, `required_confirmations` cannot express a defence against a
  70% miner at all.** The number is a liveness parameter here, not a security
  one. If you would rather PCN were not listed on those terms, that is a
  reasonable call.
- Supporting facts, all verifiable from the repo and the explorer:
  `nMinimumChainWork` is `0` and `PermittedDifficultyTransition()` returns true
  unconditionally above the LWMA activation height, so there is no work-based
  brake on a deep reorg. The whole chain is ~235 950 PCN across 99 addresses
  with a balance, so the economic disincentive that protects large chains does
  not exist here.
- What is being done about it: the chain is RandomX and CPU-mined specifically so
  that ordinary hardware can compete, a public pool is open, and the ANN thread
  is being used to recruit independent miners. It is a real effort with an
  honest, unfinished result so far.
- The current figure is reproducible on any PCoin node —
  `pcoin-concentration-watch --window 300` in
  [`contrib/seed-monitoring`](https://github.com/pars5555/pcoin/tree/main/contrib/seed-monitoring)
  classifies recent coinbases and reports a confidence interval rather than a
  point estimate.

**If that makes PCN unsuitable for listing right now, I would rather be told
than listed.** I am not asking for an exception; I am asking that the decision
be made with the number in front of you.

---

## Two things a reviewer will notice and should not have to discover

**1. PCoin's BIP32 version bytes are Bitcoin's own (`0488ADE4` / `0488B21E`), so
PCoin extended keys literally serialise as `xprv…` / `xpub…`.** This is
inherited, not intentional, and it is why the BIP44 coin type is load-bearing:
under coin type 0 one seed phrase would derive byte-identical keys on both
chains. It is `9444'` that keeps the two key trees apart.

**2. Coin type `9444'` is not registered in SLIP-0044.** It is in use in
production today by PCoin's own Android wallet and Windows tray wallet, and by
every mining payout the chain has made, so it cannot be changed without
stranding real funds. I am happy to file a SLIP-0044 registration; I did not
want to hold this submission behind someone else's merge queue. `9444` is
unclaimed in `slip-0044.md`.

Two further notes for the same reason:

- `sign_message_prefix` is `"PCoin Signed Message:\n"`, **not** Bitcoin's — see
  `src/common/signmessage.cpp:24`. It is one of the few strings PCoin did change.
- `rpcport` is `9443`, which is **P2P minus one**, not Bitcoin's arrangement.
  That is deliberate: P2P plus one is bitcoind's default Tor onion listener.
  Both `9443` and `9444` are unclaimed in this repo's `coins` file.

---

## ElectrumX

Two servers, both running upstream **spesmilo/electrumx 2.0.0** unmodified apart
from a coin class:

| | |
|---|---|
| `electrum1.pc.am` | ssl `50002`, wss `50004` (tcp `50001` also open, not advertised here) |
| `electrum2.pc.am` | ssl `50002`, wss `50004` (tcp `50001` also open, not advertised here) |

- **Real Let's Encrypt certificates, issued by certbot, renewing unattended.**
  No `disable_cert_verification` anywhere in the submission. The renewal deploy
  hook restarts ElectrumX, because ElectrumX reads its certificate once at
  startup and a renewal that does not restart is how this silently breaks in 60
  days.
- **Separate machines, separate providers, separate countries** (Hetzner
  Falkenstein and Netcup), each with its own PCoin full node with `txindex=1`.
  A single host failure cannot take both down.
- Both are monitored every 10 minutes by a check that connects **from outside,
  over ssl and wss, by public hostname, with certificate verification on**, and
  additionally compares `blockchain.scripthash.get_balance` against an
  independent address index — because a server can answer `server.version`
  perfectly while returning an empty history for every address on the chain.
  Certificate expiry is alerted on at 10 days remaining. The check is
  [`contrib/electrumx/check-electrumx.py`](https://github.com/pars5555/pcoin/tree/main/contrib/electrumx).
- Admin contact: `pcoin@pc.am` (monitored), GitHub `@pars5555`. Happy to join
  the ElectrumX status channel on Discord for ping registration.

**No ElectrumX patch was required.** PCoin replaced only the proof-of-work
*check*; block IDs are still double-SHA256 and headers are still a fixed 80
bytes, and ElectrumX never validates proof of work. The coin class is a plain
`Coin` subclass with PCoin's version bytes, genesis hash and RPC port —
[`contrib/electrumx/pcoin_coin_class.py`](https://github.com/pars5555/pcoin/tree/main/contrib/electrumx).
It subclasses `Coin` rather than `Bitcoin` on purpose: `Bitcoin` requires daemon
version 31 and a `txospenderindex`, both of which postdate the v29.4 codebase
PCoin forked.

---

## Files in this PR

| file | note |
|---|---|
| `coins` | two entries: `PCN` (legacy, `m/44'/9444'`) and `PCN-segwit` (`m/84'/9444'`) |
| `electrums/PCN` | 2 servers, SSL + `ws_url`, contact on each |
| `explorers/PCN` | two independent explorers |
| `icons_original/pcn.png` | 256×256 PNG |
| `swaps/PCN-DOGE.md` | the five txids from the completed swap |

**On the `-segwit` sibling:** PCoin's own wallets — the Android app and the
Windows tray — are BIP84-only and produce `pc1q…` addresses, and every mining
payout the chain has made went to a `m/84'/9444'` path. So `PCN-segwit` is the
entry real PCoin users will need; the legacy `PCN` entry exists to follow the
convention BTC and other forks use here. If you would rather I submit only one,
say which and I will drop the other.
