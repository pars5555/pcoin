# Mining PCoin (PCN) on HiveOS, mmpOS and plain Linux

> **NOT TESTED ON REAL HIVEOS OR mmpOS HARDWARE.** The pool side and the
> SRBMiner `randompcn` algorithm were verified (see "What is verified"). The
> HiveOS and mmpOS screens were NOT run by us; those steps come from the
> vendors' documentation. If a field differs on your rig, please say so in
> https://github.com/pars5555/pcoin/issues/2 and this guide will be fixed.

## Read this first: what to expect

* PCoin uses **RandomX**, which is designed for **CPUs**. GPUs are a poor fit
  and the miner below runs on the CPU (`--disable-gpu`). A rig's graphics cards
  will sit idle; its CPU does the work, and a typical mining-rig CPU is modest.
* No earnings or prices are promised. PCN can be sold on exchange.pc.am, but
  that order book is young and thin and there is no guaranteed way to sell, so
  treat any value as uncertain. A pool only smooths out luck; after its 2% fee
  you earn slightly less than solo on average.
* Mined coins can be spent only after **100 blocks (about 17 hours)**.
* Mining on a rig OS leaves no private key on the rig. The address is only
  where you get credited.

## Step 1. Get a PCN address

Install the **Windows PCoin Wallet** or the **Android wallet** (links at
https://pc.am) and copy a receive address. It must look like `pc1q...`
(bech32, prefix `pc`). **Taproot `pc1p...` addresses are refused by the pool.**
Write your 12 recovery words on paper.

## Step 2a. HiveOS flight sheet

Use a **Custom miner** (the bundled SRBMiner may be older than 3.5.6, the first
version with `randompcn`).

1. Workers > your rig > flight sheet > Create. Coin can be any placeholder.
2. Wallet: create a wallet entry named PCN whose address is your `pc1q...`
   address.
3. Miner: choose **Custom**. Fields:

| Field | Value |
|---|---|
| Miner name | `SRBMiner-MULTI` |
| Installation URL | `https://github.com/doktor83/SRBMiner-Multi/releases/download/3.7.5/srbminer_custom-3.7.5.tar.gz` (any release 3.5.6 or newer; replace the version in both places) |
| Wallet and worker template | `%WAL%` (just the address; **no `.%WORKER_NAME%`**, the pool has no worker names) |
| Pool URL | `pool.pc.am:3333` (backup: `pool2.pc.am:3333`) |
| Pass | `x` |
| Extra config arguments | `--disable-gpu --algorithm randompcn --cpu-threads N` |

Replace `N` with the number of CPU threads to use. Plain TCP, no TLS.
Whether the Hive wrapper accepts the pool URL without a `stratum+tcp://`
prefix, or needs it, is **unverified**; if SRBMiner shows a connection error
try `stratum+tcp://pool.pc.am:3333`. If the wrapper does not pass the pool and
wallet through, put them in the extra arguments instead:
`--pool pool.pc.am:3333 --wallet <pc1q... address> --password x`.

4. Apply the flight sheet to the rig and watch the miner log.

## Step 2b. mmpOS

mmpOS has no PCoin coin entry that we know of, and we could not confirm that
SRBMiner is a built-in there. The documented route is a **custom miner**
(guide: https://github.com/ddobreff/mmpos/blob/main/CUSTOM_MINER.MD):

* A `.tar.gz` containing `mmp-launch.sh`, an executable `mmp-stats.sh` and
  `mmp-external.conf` (`EXTERNAL_NAME`, `EXTERNAL_VERSION`).
* mmpOS passes `--pool host:port`, `--user`, `--password` (default `x`) and
  `--coin` to `mmp-launch.sh`, and the script must turn them into the miner's
  command line. Its default user is `wallet.rigname`; **set the user to your bare
  `pc1q...` address**.
* The script should end by running:
  `./SRBMiner-MULTI --disable-gpu --algorithm randompcn --pool pool.pc.am:3333 --wallet <address> --password x --cpu-threads N`

We have not written or tested such a package. Alternatively ask the mmpOS team
to add the algorithm.

## Step 2c. Plain Linux

```
./SRBMiner-MULTI --disable-gpu --algorithm randompcn \
  --pool pool.pc.am:3333 --wallet <your pc1q... address> --cpu-threads N
```

Other options: PCoin's own node has a built-in pool miner
(`bitcoin-cli startpoolmining "pool.pc.am:3333" "<address>" 0`, see
`MINER-INTEGRATION.md` section 8). xmrigCC support is an unmerged pull request
(Bendr0id/xmrigCC#435) with an unofficial build; **stock xmrig does not work**.
SRBMiner takes its own 0.85% fee on this algorithm, on top of the pool's 2%.

## Step 3. Confirm it is working

* Miner log: "connected", jobs received, and **accepted** shares.
* https://pool.pc.am shows pool hashrate and connected miners (the API at
  `https://pool.pc.am/api/pools` only has pool-wide data; we did not find a
  per-address lookup there, so ask in the issue if you need one).
* Blocks found by the pool pay each recent contributor directly in the coinbase
  (PPLNS). Your address then shows the incoming amount on
  https://explorer.pc.am, immature for 100 blocks. A small miner may wait a long
  time between payouts; amounts under 0.00000294 PCN are skipped for that block.

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| "unknown algorithm" / "randompcn" not found | SRBMiner older than 3.5.6. Use the Installation URL above. |
| Connection refused / timeout | Check you used port **3333**, plain TCP (no TLS), no firewall on the rig. Try `pool2.pc.am:3333`. |
| Login refused / bad address | Address must be `pc1q...`, not `pc1p...`, with no `.workername` suffix. |
| Shares rejected "above target" | Wrong miner or algorithm (a Monero build, or `rx/0`). Use `randompcn`. Both nonce spellings are accepted by the pool. |
| Stale or rejected shares in bursts | Normal around new blocks; many in a row suggests a clock off by minutes or a slow link. Enable time sync (`timedatectl set-ntp true`). |
| Very low hashrate, GPU idle | Expected: RandomX runs on the CPU. Raise `--cpu-threads` to the physical cores; PCoin uses RandomX light mode (about 256 MiB of cache per miner process), so memory is rarely the limit; if the miner is killed, check free RAM. |
| Shares accepted but nothing received | Normal for hours or days at low hashrate; then 100-block lock. An orphaned block cancels its payouts. |

## What is verified, and what is not

Verified (2026-10-12): pool.pc.am API reports plain TCP stratum on 3333, PPLNS,
2% fee, minimum 0.00000294 PCN, direct coinbase payout; the SRBMiner README
lists `randompcn` at 0.85% fee; the SRBMiner 3.7.5 release offers a HiveOS
custom package and configuration via "Extra config arguments"; `randompcn`
against this pool was tested on 2026-09-02 (`MINER-INTEGRATION.md` section 9,
Linux, 1 thread). `pool2.pc.am:3333` is described on the pool page as the same
software and fee.

Not verified: any real HiveOS or mmpOS flight sheet, the Hive wrapper's handling
of the pool URL, and the `%WAL%` template behaviour with this pool.

## Sources

* https://github.com/pars5555/pcoin/issues/2
* `contrib/pool/MINER-INTEGRATION.md`, `contrib/pool/site/index.html`
* https://pool.pc.am/api/pools/pcoin
* https://github.com/doktor83/SRBMiner-Multi (README and releases)
* https://hiveon.com/knowledge-base/ASIC-Hub/start_custom_miner/
* https://docs.qu.ai/guides/miner/hiveos-flight-sheet (SRBMiner flight sheet example, `%WAL%` style template)
* https://github.com/ddobreff/mmpos/blob/main/CUSTOM_MINER.MD
