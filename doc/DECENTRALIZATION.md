# Mining decentralization

Who finds PCoin's blocks matters more than almost anything else about its security. A mining
pool decides which block its miners work on, so a pool that holds more than half of the
network can rewrite recent history if its operator is dishonest or its server is compromised —
whatever anyone intends. This page says what the project measures, where that stands,
what has been done, and what happens if the project's own pools get too large.

It is a standing page. It is updated with every monthly report.

## What is measured

Two numbers, which are not the same and are never mixed up:

- **Share of blocks** found by each party over a window. Taken from the chain only, with the
  method and every block published, so anyone with a node can reproduce it byte for byte:
  [`reports/pool-distribution`](../reports/pool-distribution). Live charts, redrawn every ten
  minutes: <https://pc.am/mining/>.
- **Share of hashrate**, right now. An estimate (a pool's reported rate against the network
  rate implied by the difficulty), shown on each pool's stats page. It moves first and is
  noisier; the block share is the one that can be checked.

## Where it stands

Share of blocks found by the project's own two pools (pool.pc.am and pool2.pc.am), with the
95% interval:

| window | our pools | blocks in window |
|---|---|---|
| August 2026 (chain starts 1 Aug; our pool opened 13 Aug) | 20.9% (19.9–22.0) | 6,004 |
| September 2026 | 65.2% (63.8–66.7) | 4,295 |
| October 2026 | 47.9% (46.5–49.4) | 4,449 |
| 30 days to 2026-11-06 (one-off report) | 46.9% (45.4–48.4) | 4,302 |

September is the high point: the project's pool was most of the network. Solo mining became
the installer default on 10 September and independent pools appeared, and the share fell by
about 17 points in October.

It is rising again. On 5 and 6 November (6 November partial) our pools found about 60% of the
blocks, in the same days that one independent pool's blocks fell from about 40 a day to about
10 and another has found none since 21 October. The live hashrate estimate for our two pools
moved between about 55% and two thirds of the network during 6 November. The 30-day figure
above lags behind both.

## What has been done

- **2026-09-10** — the Windows and Linux installers mine **solo** by default, so new hashrate
  does not land on our pool unless the miner chooses it.
- **September 2026** — a bounty of 500 PCN for running a pool that is not ours
  (<https://pc.am/bounty/>). Three independent pools are listed on the home page.
- **2026-11-06** — the block report, its method and the live charts were published, and new
  miners were asked to **start solo**. This is a request, not a restriction: nobody is blocked
  from our pools and nothing changed for current miners.

## The line, and what happens at it

**The aim:** the project's own pools stay below **half of the blocks over any 30-day window**,
as the report above measures it, and fall from there.

**If the 30-day figure reaches 50%,** the project publishes a decision in
[@PCoinPCN](https://t.me/PCoinPCN) within seven days, with its reasons, whichever way it
goes. The measures on the table are closing pool.pc.am and pool2.pc.am to new miners (existing
miners are not removed; the pool software already has an allowlist that can do this) and a
public request to the largest miners on our pools to spread across other pools.

The line is deliberately the majority line and not a promise about a smaller number. Nothing
here promises a cap, a date or a result that depends on other people's machines.

## What this cannot do

- A request to new miners, or a closed door for new miners, does not move the miners who are
  already on our pools. The project does not control where anyone points a machine.
- Smaller is better, but any pool is still an operator who picks the block its miners build
  on. Only a pool design with **no operator** removes that, such as P2Pool, which exists for
  RandomX on Monero. For PCoin it is **wanted and not built**. A developer who wants to take
  it on is welcome to open an issue.

## Check it yourself

You need a PCoin node you run and Python 3; the commands are in the
[reports README](../reports/pool-distribution/README.md). If you operate a pool and want it
named, or think a row is wrong, say so on
[issue #7](https://github.com/pars5555/pcoin/issues/7).
