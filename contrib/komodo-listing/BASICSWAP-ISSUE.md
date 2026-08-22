# Coin request: PCoin (PCN) — Bitcoin Core v29.4 fork, RandomX PoW

PCoin is an independent Layer-1 forked from Bitcoin Core **v29.4**. Only two
things were replaced: the proof-of-work *check* (RandomX, CPU-mined) and the
difficulty algorithm (LWMA). **The script engine, the transaction format and the
address formats are untouched upstream code**, which is why the four listed
criteria are met without any changes on either side.

- Source: https://github.com/pars5555/pcoin
- Explorers: https://explorer.pc.am · https://explorer3.pc.am
- Site: https://pc.am

---

## The four criteria, verified against a live node

Not asserted from the source — read off mainnet at height 4685.

| criterion | evidence |
|---|---|
| **Uses UTXO scripts** | Bitcoin Core v29.4 fork; `src/script/` is unmodified. The only consensus changes are in `pow.cpp`, `crypto/pow_randomx.*` and `chainparams.cpp`. |
| **Has CLTV or CSV** | `getdeploymentinfo`: `bip65` **and** `csv` both `type=buried, active=true, height=1`. Both, from genesis. |
| **Has SegWit enabled** | `getdeploymentinfo`: `segwit` `type=buried, active=true, height=1`. Taproot is active too. Native bech32 (`pc1q…`) is the default address type. |
| **Works with watch-only addresses** | Demonstrated, not claimed. A descriptor wallet created with `disable_private_keys=true`, given an `addr()` descriptor and rescanned from genesis, reports `private_keys_enabled: false`, `descriptors: true`, **399 transactions** and `trusted: 16250.00032063` plus `immature: 3700.00011195`. |

## Chain parameters

| | |
|---|---|
| ticker / decimals | `PCN` / 8 |
| P2P / RPC port | 9444 / **9443** (RPC is P2P **minus** one — P2P+1 is bitcoind's default Tor onion listener) |
| network magic | `cf a2 d1 b8` |
| bech32 hrp | `pc` |
| base58 pubkey / p2sh / WIF | 55 / 56 / 183 |
| BIP44 coin type | `9444'` — **unregistered in SLIP-44**, see below |
| message prefix | `"PCoin Signed Message:\n"` (**not** Bitcoin's) |
| block target / halving / cap | 600 s / 210,000 blocks / 21 M |
| coinbase maturity | 100 blocks |
| genesis | `a95d51f0cbf25cad10c35961c6189356525d079835f02e83e2395f382fbe264a` |

Two things that surprise reviewers, stated before you find them:

- **PCoin's BIP32 version bytes are Bitcoin's own (`0488ADE4` / `0488B21E`)**, so
  PCoin extended keys serialise literally as `xprv…`/`xpub…`. Inherited, not
  intentional. It is why the coin type is load-bearing: under coin type 0 one
  seed would derive byte-identical keys on both chains, and `9444'` is the only
  thing keeping the trees apart. It is in production use and cannot change.
- **Block IDs are still double-SHA256 and headers are still a fixed 80 bytes.**
  RandomX replaced only the PoW *check*. Anything that does not validate proof of
  work needs no RandomX awareness at all — a stock Bitcoin-derived ElectrumX coin
  class works unmodified, which we have running in production.

---

## Disclosure: hashrate concentration, and why it matters more here than usual

**One unidentified solo miner currently finds about 70% of PCoin blocks (95% CI
65–75%, measured over the last 300 blocks.)** I am raising this unprompted.

BasicSwap holds nothing, so there is no venue-side balance to drain. But I want
to flag a concern that is **specific to timelock-based swaps** rather than the
generic 51% warning:

**An atomic swap is a clock, and a majority miner controls how fast PCoin's clock
runs.** Three PCoin-specific facts compound that:

- LWMA retargets **every block**, so a miner with 70% has unusually direct
  influence over spacing.
- **Block timestamps are not monotonic in height** on this chain. Anything
  deriving elapsed time from timestamps can read negative intervals.
- `nMinimumChainWork` is `0` and `PermittedDifficultyTransition()` returns true
  unconditionally above the LWMA activation height, so there is no work-based
  brake on a deep reorg.

So a refund path expressed in block heights behaves predictably; one expressed in
wall-clock time against block timestamps is worth a second look for this chain.
I would rather raise that than have someone discover it during a swap. If you
judge PCN unsuitable until the concentration comes down, that is a reasonable
call and I would rather be told than merged.

The figure is reproducible on any PCoin node —
`contrib/seed-monitoring/pcoin-concentration-watch --window 300` classifies recent
coinbases and reports a confidence interval rather than a point estimate.

## What is already running

Two ElectrumX servers with real Let's Encrypt certificates and WSS
(`electrum1.pc.am`, `electrum2.pc.am`), on separate providers in separate
countries, monitored every 10 minutes, each backed by its own full node with
`txindex=1`. Tooling is at
[`contrib/electrumx`](https://github.com/pars5555/pcoin/tree/main/contrib/electrumx).

Happy to run whatever tests are useful, stand up a node you can point at, or do
the integration work myself if you would rather review a PR than write one.

Contact: `pcoin@pc.am`, GitHub `@pars5555`.
