# A mining pool for PCoin — design

Status: **design only, nothing built.** Written 2026-08-13.

## Why

A miner with 100 H/s against a 28,000 H/s network finds a block every **~47
hours** on average — and "on average" hides the real problem, which is that the
distribution is exponential. Half of those miners wait longer than 32 hours for
their *first* payout, and a meaningful fraction see nothing for a week and
conclude the software is broken. pc.am invites people to mine; most of them
currently install, see zero, and uninstall.

A pool converts one rare 50 PCN event into a steady trickle proportional to
work done. That is the whole product.

It also happens to be the best answer to the two problems that have nothing to
do with user experience:

* **Security.** 28,000 H/s is rentable for pocket money. Every miner the pool
  retains raises the cost of a 51% attack.
* **Distribution.** 62.8% of supply was mined in the first 27.7 hours. Nothing
  dilutes that except other people mining, and nothing makes other people mine
  like getting paid this week instead of next month.

## What already exists

Verified against the live seed, not assumed:

| need | status |
|---|---|
| `getblocktemplate` | ✅ returns `target`, `bits`, `height`, `curtime`, `mintime`, `coinbasevalue`, `mutable: [time, transactions, prevblock]` |
| `submitblock` | ✅ present |
| a node to attach to | ✅ three seeds, `txindex` on two |
| a payout wallet pattern | ✅ the treasury + forwarding design already in use |
| miners that can be redirected | ⚠️ **this is the work** — see "The client problem" |

## The one thing that makes this easier than Monero

**PCoin's RandomX key never rotates.** It is the fixed ASCII string
`PCoin/RandomX/v1` on every network (`src/crypto/pow_randomx.cpp:26-28`), and
changing it is PoW v2 — a hard fork.

Monero re-keys every 2048 blocks, so every Monero pool must manage cache and
dataset transitions, run two RandomX VMs across the boundary, and get the
seed-height arithmetic right. **None of that applies here.** The pool
initialises RandomX once at startup and never touches it again. That removes
the single most bug-prone part of a RandomX pool.

The corresponding cost: rotating the key later becomes a coordinated upgrade of
the pool as well as every node. Worth writing down now.

## Architecture

```
  miners ──stratum-like TCP──▶ pool ──getblocktemplate/submitblock──▶ pcoind
                                 │
                                 ├── share validator  (RandomX, light mode)
                                 ├── share store      (SQLite)
                                 └── payout engine    (PPLNS, on a timer)
```

Four components. Each is independently testable, which matters because this
handles money.

### 1. Job distribution

Poll `getblocktemplate` every ~2 s and on every new tip. Build the coinbase
paying **the pool's own address**, compute the merkle root, and hand miners a
job.

Give each miner its own `extranonce` so two miners never grind the same search
space. With `mutable: [time, transactions, prevblock]` the pool controls the
coinbase, which is what makes extranonce possible.

**Push a new job the instant the tip changes.** Work on a stale template is
wasted and miners notice immediately.

### 2. Share validation — the RandomX part

A share is a nonce whose RandomX hash beats the *pool's* target, which is much
easier than the network target. The pool must verify every share by computing
the hash itself. A miner that could not do this honestly could otherwise claim
credit for work it never did.

- **Light mode**, ~256 MiB cache. **Measured on real blocks: 21.7 ms per hash,
  ~45 shares/sec per core** (~735/sec across 16 cores), plus a one-off 834 ms
  cache init. An earlier draft of this document guessed ~1 ms and ~1,000
  shares/sec — **wrong by more than 20×**. RandomX light-mode verification is
  deliberately expensive; that cost *is* the CPU-fairness. Do not carry a
  SHA256d intuition into a RandomX pool.
- **This puts a floor under share difficulty.** Share difficulty is usually set
  as low as miners find comfortable, so small miners submit often. Here every
  share costs the pool 21.7 ms of CPU, so "one share per miner per second" stops
  being free: 45 miners at that rate saturate a core. Target roughly **one share
  per miner per 10–30 s** and use vardiff to hold it there. At the current
  28,000 H/s network this is comfortable on two cores — but it is a real
  constraint, not a rounding error, and it is the first thing that will bite if
  the pool grows.
- Reuse `src/crypto/pow_randomx.{h,cpp}`. It already does exactly this, degrades
  `flags → |SECURE → DEFAULT`, and all three paths produce identical hashes.
- **Never trust a submitted hash.** Take the nonce, recompute, compare.
- Reject duplicates. Keep a per-job seen-nonce set.

When a share also beats the **network** target, that is a block: `submitblock`
immediately, then record it.

### 3. Share accounting — PPLNS

**Pay Per Last N Shares.** When a block is found, pay the last N shares
proportionally, regardless of round boundaries.

Chosen over the alternatives for specific reasons:

- **Not PPS** (pay per share, pool absorbs variance). PPS requires the operator
  to hold a float large enough to survive a bad-luck streak. On a chain this
  small a 3× expected round is routine, and an underfunded PPS pool defaults
  publicly.
- **Not proportional-per-round.** It is trivially exploitable by pool hopping:
  join when a round is young, leave when it ages.

Set `N ≈ 2×` the shares in an average round. Store every share with
`(miner, difficulty, timestamp, job_id)`.

### 4. Payouts

- Accrue balances in **satoshis, integer arithmetic only**. No floats anywhere
  in the payout path — the same rule the payment rails follow.
- **Coinbase maturity is 100 blocks.** A found block's reward cannot be paid for
  ~100 × 600 s ≈ 17 hours. Miners must see this as *pending* rather than
  missing, or they will report it as a bug.
- Pay out on a threshold (say 1 PCN) plus a timer, batched into one transaction.
- **Idempotency:** key every payout on `(block_height, miner_address)`. The
  lesson from the payment rails applies exactly — a retry must be a no-op, and
  the key must be the thing that is actually unique.

### The client problem — the real work

Every current miner calls `startmining` on its **own** node, which builds its
**own** template. Pool mining means taking work from elsewhere. That is a change
to the tray app, the Android app *and* the Linux supervisor.

**The cheap path: put it in the node.** Add an RPC beside `startmining`:

```
startpoolmining "url" "user" ( threads ttl )
```

The existing `cpuminer` supervisor keeps its thread pool, its 64-nonce batching,
its dead-man's-switch TTL and its thermal behaviour — the only change is where
the template comes from and where a solution goes. Every existing client then
gains pool mining as a **one-line config change**, with no new binary on any
phone or PC.

This is worth doing even if a standalone miner ships later. Rewriting three
clients to speak a network protocol is most of the project; changing where one
function gets its template is not.

## Protocol

Follow the Monero stratum-like convention (JSON-RPC over a raw TCP line
protocol: `login`, `job`, `submit`, `keepalived`) rather than inventing one.
Two reasons: existing RandomX mining software already speaks it, and anyone who
has run a Monero pool can read the code.

## What this does NOT solve

State plainly, so nobody expects otherwise:

- **It does not make the chain faster.** Block spacing is LWMA's job.
- **It does not increase anyone's expected earnings.** It reduces *variance*.
  Total pool payout minus fee is slightly less than expected solo earnings.
- **It centralises hashrate.** A pool with a majority of a 28,000 H/s network
  *is* the 51% risk it was meant to reduce. Publish the pool's share, cap
  registrations if it approaches 40%, and encourage a second pool early. This
  is not hypothetical at this size.

## Build order

Each step is independently useful and testable:

1. ~~**Validator against real blocks.**~~ **DONE.** `validate.cpp` +
   `make-vectors.sh` + `selftest.sh`. Verifies 100 real blocks (heights
   3114–3213) against the targets the chain accepted them under: **100/100
   pass, and 0/100 pass once the nonce is flipped by one.** Both halves matter —
   a validator that accepts everything prints the same "100/100" as a correct
   one, so the tampered run is the only evidence worth anything. Links the
   vendored `src/randomx` only, no Bitcoin Core.
2. **Job server + share validator**, no payouts. Miners connect, submit shares,
   the pool logs them and submits real blocks. Solo-with-extra-steps, but it
   proves the protocol end to end.
3. **Share store and PPLNS accounting**, with payouts *computed and logged but
   not sent*. Run it against real shares for a week; reconcile by hand.
4. **Payouts enabled**, threshold-triggered, idempotent on
   `(block_height, miner_address)`.
5. **`startpoolmining`** in the node, then flip the fleet over.

**Do not skip 3.** A payout engine that has never been reconciled against a real
week of shares is how a pool loses its operator's money rather than its users'.

## Open questions for the owner

1. **Fee?** 0% buys goodwill at launch and costs a rounding error at this size.
   1–2% is normal. It should be published either way.
2. **Which host?** Not a seed — validating shares is CPU work and a seed's job
   is bootstrapping. `178.105.178.27` is PCoin-dedicated and already runs the
   market and pcnearner.
3. **Public or fleet-only first?** Running it with your own miners for a week
   before announcing exercises the payout path with money you own.
