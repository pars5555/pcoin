# Pool distribution reports

Who found PCoin's blocks, taken from the chain and nothing else. Each folder here
is one window of blocks, produced by
[`contrib/pool/pool-distribution.py`](../../contrib/pool/pool-distribution.py) from a
PCoin node. **How a block is attributed, what the numbers mean and what they
cannot tell you is in [`contrib/pool/POOL-DISTRIBUTION.md`](../../contrib/pool/POOL-DISTRIBUTION.md)
— read it before quoting a figure.**

| folder | blocks | window (UTC) |
|---|---|---|
| [`2026-10_heights-10299-14747`](2026-10_heights-10299-14747) | 4,449 | 2026-10-01 00:07 – 2026-10-31 23:57 (calendar month October 2026) |
| [`2026-11-06_heights-11200-15501`](2026-11-06_heights-11200-15501) | 4,302 | 2026-10-07 06:45 – 2026-11-06 06:36 (the 30 days before 2026-11-06) |

The two windows overlap (7–31 October is in both). Monthly reports are for finished
calendar months and are generated automatically on the 1st; the 30-day one was a
one-off for a community request.

Each folder holds `blocks.csv` (one row per block and why it was attributed that
way), `summary.csv` (blocks, share and 95% interval per party), `daily.csv` and
`meta.json` (the exact window and the labels used, with where each came from).

## Check it yourself

You need a PCoin node you run and Python 3:

```
python3 contrib/pool/pool-distribution.py --from-height 11200 --to-height 15501 --out-dir mine/
```

Use the `from_height` and `to_height` in each folder's `meta.json`. `blocks.csv`,
`summary.csv` and `daily.csv` should match the published files byte for byte;
`meta.json` differs only in the time it was generated. Each published report was
regenerated from a node a second time and matched exactly.

A share here is a share of **blocks**, not of hashrate, and a fee address is not
an identity: a pool is named only where its operator published its address or gave
it to the project, the source of every name is in `meta.json`, and everything else
is shown by its address, unnamed. If you operate a pool and want it named, or think
a row is wrong, reply on [issue #7](https://github.com/pars5555/pcoin/issues/7)
with your fee address.

## Revisions

* **2026-11-06, revised the same day.** The address `pc1q85lry2…c5ryc7` is now named
  *Rabid Mining pool*; the first version of this report showed it unnamed. Only the
  label on its 1,105 rows changed. Every hash, time, address and count is identical,
  and the earlier version is in this repository's history. The name rests on a
  payment, not on a public post by the operator, and `meta.json` and
  [`POOL-DISTRIBUTION.md`](../../contrib/pool/POOL-DISTRIBUTION.md) say exactly why:
  the project paid that address the independent-pool bounty on 2026-09-30 (block
  10241), the address turned from solo mining into a pool fee output on the day the
  pool opened, and it matches the blocks the pool lists on its own site. A community
  member pointed out the payment. If the operator would rather it were stated
  differently, say so on issue #7.
