# Pool distribution reports

Who found PCoin's blocks, taken from the chain and nothing else. Each folder here
is one window of blocks, produced by
[`contrib/pool/pool-distribution.py`](../../contrib/pool/pool-distribution.py) from a
PCoin node. **How a block is attributed, what the numbers mean and what they
cannot tell you is in [`contrib/pool/POOL-DISTRIBUTION.md`](../../contrib/pool/POOL-DISTRIBUTION.md)
— read it before quoting a figure.**

| folder | blocks | window (UTC) |
|---|---|---|
| [`2026-11-06_heights-11200-15501`](2026-11-06_heights-11200-15501) | 4,302 | 2026-10-07 06:45 – 2026-11-06 06:36 (the 30 days before 2026-11-06) |

Each folder holds `blocks.csv` (one row per block and why it was attributed that
way), `summary.csv` (blocks, share and 95% interval per party), `daily.csv` and
`meta.json` (the exact window and the labels used, with where each came from).

## Check it yourself

You need a PCoin node you run and Python 3:

```
python3 contrib/pool/pool-distribution.py --from-height 11200 --to-height 15501 --out-dir mine/
```

`blocks.csv`, `summary.csv` and `daily.csv` should match the published files
byte for byte; `meta.json` differs only in the time it was generated. The first
report was regenerated from a node on a second run and matched exactly.

A share here is a share of **blocks**, not of hashrate, and a fee address is not
an identity: a pool is named only where its operator published its address, and
everything else is shown by its address, unnamed. If you operate a pool and want
it named, or think a row is wrong, open an issue with your fee address.
