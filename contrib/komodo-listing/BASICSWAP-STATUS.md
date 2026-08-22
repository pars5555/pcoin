# BasicSwap — already filed, and answered. Do not open a second issue.

**[basicswap/basicswap#649](https://github.com/basicswap/basicswap/issues/649)**,
opened 2026-08-20 by `pars5555`. Still open, no labels, no assignee.

It is a good issue: it checks PCoin against all four stated requirements with
evidence from a live node, demonstrates watch-only rather than asserting it, and
discloses both the chain's age and the hashrate concentration unprompted.

**The reply, in full, from `nahuhh` (`author_association: COLLABORATOR`) —
2026-08-20, the only comment on the thread:**

> 1. Too young

That is a maintainer, and the `1.` refers to the first disclosure in the issue:
*"The chain is young — genesis was 1 Aug 2026 — and small."*

## What that means, and what it does not

It is a **soft no on maturity, not a technical rejection.** Nothing in the four
requirements was disputed; the reply does not mention UTXO scripts, CLTV/CSV,
SegWit or watch-only, and it does not mention the 65–70% miner either. Age is the
one thing that cannot be engineered around — it passes on its own, and only if
the chain keeps running.

**No threshold was given.** Nobody has asked what "old enough" means, so we do
not know whether it is six months, a year, or a stand-in for "come back with
users." That is the one cheap question available here, and it has not been put.

## Do not

* **Do not open another issue.** Duplicates on a repo whose queue is already a
  graveyard — `add XNO nano` #106 open since July 2024, DigiByte #472, Navio
  #537, Yenten #433 all open and unmerged — will read as noise, and the account
  filing them is the same one carrying the ANN thread.
* **Do not treat the ElectrumX work as an answer to this.** BasicSwap needs no
  ElectrumX. Two servers with real certificates change nothing about "too young"
  and posting them as a rebuttal would look like not having read the reply.

## Worth doing, when there is something new to say

A single short comment asking what maturity threshold they apply — no pitch, no
re-litigating — would turn an unanswerable wait into a date. Best sent alongside
something that has actually changed: a completed atomic swap on another venue,
independent miners on the chain, or simply six more months of uptime.

The technical evidence in #649 remains accurate. Re-verified 2026-08-22 at height
4685: `bip65`, `csv` and `segwit` are each `type=buried, active=true, height=1`,
taproot active, and the watch-only probe wallet reports
`private_keys_enabled: false` with 399 transactions tracked and 16,250 PCN
trusted plus 3,700 immature. One figure in #649 has moved and would need
restating in any follow-up: the solo miner was ~65% then and is **~70%
(95% CI 65–75)** now.
