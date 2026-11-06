# Who found PCoin's blocks — method

`pool-distribution.py` turns the chain into a table: for a window of blocks, how
many were found by which party. Everything it uses is on-chain, so anyone with a
node can run it and get the same file. This page is the method; read it before
quoting a number from the output.

## What it can and cannot tell you

**It answers:** what share of blocks in a window paid out through a given pool's
fee address, how many were paid straight to one address ("solo"), and how those
shares moved day by day.

**It cannot answer, and does not try to:**

* **Hashrate or number of active miners per pool.** The chain records who was
  *paid* in a block, not how much work anyone did. Those figures exist only in a
  pool operator's own records. A share of *blocks* is also a noisy estimate of a
  share of *hashrate*: with a few hundred blocks the interval is several points
  wide, which is why every row carries a 95% interval.
* **Who is behind an address.** A "solo" address may be one person, several
  machines of one person, or a small pool that takes no fee.
* **A pool that takes no fee.** Its coinbase has no fee output to recognise, so it
  is counted with the solo miners (1–2 outputs) or as "pool-shaped, no
  recognisable fee output" (3+ outputs).

## Running it

```
python3 contrib/pool/pool-distribution.py --days 30 --out-dir report/
python3 contrib/pool/pool-distribution.py --month 2026-10 --out-dir report-2026-10/
```

It needs Python 3 and your own PCoin node (RPC on `127.0.0.1:9443`; the cookie is
read from `--datadir`, default `~/.pcoin`). It only reads. For a report that
others must be able to reproduce exactly, publish with explicit heights
(`--from-height`/`--to-height`) or a finished `--month`; `meta.json` records the
heights used either way.

## How a block is attributed

Only the **coinbase transaction** is used. Zero-value outputs (the witness
commitment) are ignored. Then, in order:

1. **A fee output exists → a pool.** A PPLNS pool keeps a fixed percentage of the
   block and pays it, plus a few satoshis of rounding, to its own address, while
   each miner receives an arbitrary amount. So an output within 1,000 satoshis of
   a round percentage of the coinbase (0.5% steps, up to 10%) is the fee output,
   and its address names the pool. The chance of a miner's share landing on a
   round percentage by accident is about one in a million per output.
   * If that address is in the label table the block is that pool's.
   * If not, the block is reported as an **unlabelled pool, with its fee
     address**. Nothing is guessed.
2. **Three or more outputs but no fee output** → "pool-shaped, no recognisable
   fee output". Reported as its own line, never folded into any named pool.
3. **One or two outputs, no fee output → solo.** Reported as a single line with
   the number of distinct addresses; the addresses themselves are in `blocks.csv`.
   A coinbase paying only the project treasury address is shown separately as
   *project miners*: those are the project's own machines.
4. **No paying output** → unreadable, and left out of every denominator.

`pool.pc.am` and `pool2.pc.am` pay the same treasury address and their coinbases
carry no tag, so the chain cannot tell them apart; they are one line.

These are the rules of `contrib/seed-monitoring/pcoin-concentration-watch`, with
one tightening: a block counts as a named pool's only if that address is the
**fee output**, not merely if it appears somewhere in the coinbase. Appearing
anywhere is something any miner can arrange for one satoshi. On the 4,301 blocks
ending 2026‑11‑06 the two classifiers agreed on every block.

## Where a name comes from

A name is attached to a fee address only when the pool's operator published that
address themselves; the source is written next to it in the `KNOWN` table and in
`meta.json`. Operators who want to be named can open an issue with their fee
address; anyone can add or correct entries with `--labels file.json`.

## Other limits

* **Block timestamps are not monotonic** (the future-time rule allows 15 minutes
  of noise), so a time-based window can differ from another run by a handful of
  blocks at each edge.
* **It reads the best chain at the moment it runs.** If the chain reorganises
  while it reads, it stops and asks to be run again; blocks orphaned later are
  not in a report that was already published.
* **Confidence intervals** are Wilson 95% intervals on the block count.

## Files

| file | contents |
|---|---|
| `blocks.csv` | one row per block: height, hash, time, party, how it was decided |
| `summary.csv` | per party: blocks, share, 95% interval, the basis for the attribution |
| `daily.csv` | blocks per party per UTC day |
| `meta.json` | exact window, node tip, tool version, the labels used and their sources |
