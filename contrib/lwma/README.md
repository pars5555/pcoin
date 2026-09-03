# LWMA reference model

`lwma_ref.py` is the normative integer model of PCoin's difficulty algorithm.

* `lwma(times, bits, N, T, ST, pow_limit)` mirrors `LwmaGetNextWorkRequired()`
  in `src/pow.cpp`, including the running maximum over timestamps, the mandatory
  in-loop division by `k*N`, and the explicit overflow guard.
* `legacy(last_bits, last_time, first_time)` reproduces the pre-fork
  `CalculateNextWorkRequired()`, **including its silent 256-bit wraparound**.

The legacy function exists to document, and to keep reproducible, the defect
that produced mainnet's height-2016 retarget:

```python
>>> from lwma_ref import legacy
>>> hex(legacy(0x1f0fffff, 1785700177, 1785600628))
'0x1e0b7c33'
```

That is the value actually on the chain. Without the wraparound the answer
would have been `0x1f03ffff`, an exact 4x. `src/validation.cpp` requires
`block.nBits == GetNextWorkRequired(...)` exactly, so the buggy path is
preserved below `consensus.lwmaHeight` and must never be "fixed".

## Solvetimes are measured against a running maximum

Consensus only requires a block's timestamp to exceed its parent's
median-time-past, so a miner may legally backdate its **own** blocks. With raw
solvetimes and an asymmetric clamp band `[-FTL, +ST]` that was a standing
subsidy: the backdated block floors at `-FTL` while the honest block behind it
caps at `+ST`, so the pair reports `ST - FTL` seconds of apparent time for about
`2T` seconds of real time. Simulated on this exact integer model, a miner holding a
seventh of the hashrate could sustain emission at 1.31x indefinitely, and a 50%
miner at 2.09x.

`lwma()` therefore folds each timestamp through `max(times[i], prev)`. Apparent
elapsed time then telescopes to `max(timestamp) - first`, so backdating can only
*withhold* apparent time, which raises the backdater's own difficulty. On an
all-honest chain the running maximum is the identity, so mean spacing,
difficulty variance and recovery behaviour are unchanged.

The residual is bounded, not zero, and it is worth stating precisely. The
weights are positional, so holding the running maximum flat for one block defers
that block's increment to the next, higher-weighted index. Writing the weighted
sum in Abel form, `t = N*M_N - sum_{i<N} M_i`, shows the whole of the attacker's
leverage: `M_N` is pinned by real time because honest miners stamp the real
clock, and interior `M_i` can only be pushed down. Suppressing `m` consecutive
blocks and letting one honest block catch up gives exactly

    t/k = 1 + m/(N+1),   while (m+1)*T <= ST

so easing is capped at `1 + (ST/T - 1)/(N+1)` = **1.18x**, and sustaining a run
of `m` costs `m/(m+1)` of the hashrate — 1.016x at 50%, 1.033x at 67%, and the
1.18x peak only at 91.7%, which is `1 - T/ST`, the same share that already
permits the unbounded upward ratchet. Beyond `m = ST/T - 1` the catch-up
solvetime hits the `ST` clamp and the withheld time is destroyed, so
overreaching makes the chain harder rather than easier. Against the raw-solvetime
3.43x, which was unbounded in attacker share, this is a bounded second-order
effect: under 2% at any share a real attacker could hold.
`pow_tests/pcoin_lwma_backdating_never_pays` asserts these exact bounds.

`ST = 12*T` (not `6*T`) sets the maximum per-block difficulty decrease and the
supermajority-ratchet threshold `1 - T/ST`: a miner above that share can stamp
every block at MTP+1 and drive difficulty up without bound. Simulation puts the
threshold at ~75% hashrate with raw solvetimes at `ST = 6T`, ~83% with the
running maximum, and ~90% at `ST = 12T`, which also cuts 99%-hashrate-loss
recovery from 10.3 to 6.2 days and the Jensen emission bias from +0.42% to
+0.16%.

## Differential test

The C++ implementation is differential-tested against this model by
`pow_tests/pcoin_lwma_differential_vectors`, which rebuilds the same windows
from a documented LCG and compares 30 committed `nBits` outputs. Regenerate
those with:

```sh
python contrib/lwma/lwma_ref.py --vectors
```

## Known bias

LWMA has a small one-directional Jensen-inequality bias: the steady-state block
interval runs slightly above `T` because the weighted mean of solvetimes is not
the mean of the corresponding difficulties. Measured over 20,000 blocks at
`ST = 12T` it is **+0.16%** (600.95 s against a 600 s target), down from +0.42%
at `ST = 6T`. It is not a coding error and it does not compound, but emission
and the halving schedule do run that fraction behind the nominal schedule
indefinitely.
