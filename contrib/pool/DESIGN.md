# A mining pool for PCoin — design

Status: **built and public** — `pool.pc.am:3333`, payouts in the coinbase (see
`MINER-INTEGRATION.md`). This design was written 2026-08-13 and is kept as the
rationale; steps 1-5 below are done.

## Why

A miner with 100 H/s against a 28,000 H/s network (the rate on 2026-08-13; see
https://pool.pc.am/api/pools for today's) finds a block every **~47
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
* **Distribution.** 62.8% of the supply that existed on 2026-08-13 was mined in
  the first 27.7 hours. Nothing
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

**Built (step 3). What "difficulty" turned out to have to mean:**

A share's weight is **`2^256 / share_target` — the expected number of hashes to
find it**, not a share count and not difficulty-1 units.

* *Not a count*, because vardiff means two miners' shares are not the same
  thing. In the test, one miner submitting 100 easy shares and another
  submitting 10 shares ten times harder did **identical work**; paying by count
  would have handed the first ten times the money.
* *Not difficulty-1 units* (`powLimit / target`), which was the obvious choice
  and is wrong here. At a share factor of 50000 against this chain's difficulty
  a share is **easier than powLimit**, so its difficulty-1 weight floors to
  **zero** and the share becomes worth nothing. `2^256` is above every possible
  target, so the weight is always ≥ 1.

**N is measured in that same unit — work, not shares:**
`N = 2 × (2^256 / network_target)`, i.e. twice the work one block is expected to
take. This matters more here than on most chains: **LWMA retargets every block**,
so a fixed share count would silently come to mean "half a round" after a
difficulty doubling. Measured in work, N follows the chain without being touched.

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

### SUPERSEDED 2026-08-13: payouts are made BY THE COINBASE

Everything below this heading describes a pool that holds miners' coins in a
wallet and sends them later. **It no longer works that way, and the reason is
worth keeping.**

Option A above put a spending key on `178.105.178.27` — a box that also runs the
market, the explorer and pcnearner. The owner's instinct was to keep the key off
it, and the design that satisfies that instinct completely is to **pay miners
directly in the coinbase of each block the pool finds**: one output per miner,
proportional to the PPLNS window at template-build time.

**The pool then holds no wallet, no private key, and has no send path.** What
that deletes, rather than guards against:

* **idempotency** stops being a database constraint and becomes a property of
  the chain. A block exists or it does not; a retry cannot pay twice and a lost
  response resolves nothing. The entire class of §7.1/§7.6 bug is gone.
* **orphans** reverse themselves. There is no credit to claw back, and no
  "detect but never auto-reverse" rule to get right.
* **custody**. The single largest risk in running a pool — the operator holding
  other people's money — does not exist.
* a miner can **verify its own payment inside the block it helped find**,
  without trusting this pool's bookkeeping.

The costs, stated plainly:

* **The split is fixed when the TEMPLATE is built**, because the coinbase is
  committed to by the merkle root. A share submitted a second before a block
  lands is paid by the *next* block instead. Deferred, never lost.
* **No payout threshold.** Every block pays everyone in the window, so there is
  more on-chain output than batching would produce.
* **Dust.** A miner owed less than the relay dust limit (294 sat) cannot be paid
  in that block without making it unrelayable. It is dropped from that block and
  its shares stay in the window to accumulate; the dropped share is
  redistributed to the other miners, never kept by the pool.

**When to revisit.** The dust and block-space costs scale with miner count and
are negligible at fleet size. Reconsider before opening publicly, or once a
typical miner's per-block slice approaches the dust limit — whichever comes
first. Switching back means building the wallet path in §4 below, which is why
it is kept rather than deleted.

Proven by `coinbasetest.mjs`: a node **accepted a block whose coinbase pays three
miners**, and the block read back off the chain pays each the exact amount the
ledger says. The ledger is now reconciled against the *chain* rather than
against itself (`reconcileAgainstChain`).

---

**Built (step 3), and the details that only appear once you write it down:**

*The split, exactly.* `fee = value × 200 / 10000`, `pot = value − fee`,
`amount_i = pot × w_i / W` — all BigInt, all flooring. The floors always lose a
few satoshis; that remainder is **dust and it goes to the pool**, never silently
vanishing. The invariant `Σ amounts + dust + fee == coinbase value` is asserted
before anything is written, re-derived per block by `payouts.mjs` from the
weights stored on the rows themselves, and checked across the whole ledger at
once by `ledgertest.sh`. A per-block check can pass while the ledger as a whole
has invented coins.

*A float here is silent, not loud.* SQLite integers are int64 and a literal
above that is **parsed as REAL with no error**, so an over-large weight would
become a float that still prints, still sums, and is quietly wrong. Weights are
refused above 2^62 rather than stored. At real magnitudes the numerator
`pot × w` is past 2^53, so this is not hypothetical tidiness.

*Idempotency is two layers, and only one of them was being tested.* The
application returns early when a block already has payout rows; the
`PRIMARY KEY (block_height, miner)` refuses a duplicate underneath it. Deleting
the primary key left the whole suite green, because the application guard hid
it — so the test now also inserts a duplicate row directly, going around the
guard. Two layers, two checks.

*Two of our own blocks at one height.* The chosen key is `(block_height, …)`, so
the loser's rows sit in the way of the winner's. Resolved only when the chain
has already said which lost: if the recorded block is `orphaned` its rows are
replaced, otherwise **nothing is computed** and it is logged as unresolved.
Guessing which one won is the mistake this project keeps paying for.

*Record before acknowledging.* A share is fsynced to the ledger **before** the
miner is told `OK`, and if the store cannot be written the share is refused with
a retryable error rather than accepted. A share the pool cannot record is a
share the pool will not pay. If the store dies the pool stops accepting shares
entirely — the same rule already applied to the validator.

*Reorgs, which are routine here (~3% stale rate).* Maturity is a **depth, not a
proof**, so mature blocks keep being re-checked; a block a reorg pushes back
under 100 confirmations returns to *pending*, because "payable" has to mean
"spendable now" — step 4 will read exactly that field to decide what to send. A
disagreement must be seen **twice** before it is believed, the same
two-observation rule the forwarding engine uses. And per the doctrine above:
once a payout has actually been **sent**, a later reorg raises an **alarm and
changes nothing**. Detect reorgs; never auto-reverse a credit.

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
2. ~~**Job server + share validator**, no payouts.~~ **DONE** — `pool.pc.am:3333`,
   protocol in `MINER-INTEGRATION.md` §6. Miners connect, submit shares,
   the pool logs them and submits real blocks. Solo-with-extra-steps, but it
   proves the protocol end to end.
3. ~~**Share store and PPLNS accounting**, with payouts *computed and logged but
   not sent*.~~ **DONE.** `store.mjs` (SQLite ledger + PPLNS + payout
   computation), `payouts.mjs` (the reconciliation report), `storetest.mjs`
   (70 offline checks), `ledgertest.sh` (29 end-to-end checks against the
   regtest node). **Nothing can send: there is no send path in the tree.**

   What the end-to-end run proved, with two miners over 40 s: every share the
   miners were told was accepted is in the ledger and none twice; 55 blocks
   found, every one reconciling to the satoshi; **98,750,000,000 satoshis mined,
   98,750,000,000 accounted for** across payouts + fee + dust; the fee tracked
   the reward down through the regtest halving at height 150, because the pool
   reads `coinbasevalue` per template rather than assuming 50 PCN; blocks showed
   as PENDING until buried, then matured; a restart lost and duplicated nothing;
   killing the ledger out from under the running pool made it **refuse** shares
   rather than accept ones it could not record; and a block the node genuinely
   reorged away — `invalidateblock`, then a longer chain — was marked orphaned
   and its payouts voided.

   The evidence that matters is that the tests can fail. **15 mutations, each
   deleting exactly one guard, were applied to `store.mjs` and every one turned
   the suite red** — inverted weights, the missing UNIQUE index, the missing
   primary key, believing an orphan on first sight, resolving an unreadable tip,
   rounding instead of flooring, dropping the window trim, double-charging the
   fee, latching maturity through a reorg, silently reversing a sent payout.
   Two of them found real bugs first: `total_changes()` is cumulative rather
   than per-statement, so every replay reported itself as freshly recorded; and
   `evaluateBlocks` only ever re-examined *pending* blocks, so a matured block
   leaving the chain was invisible.

   Still to do in step 3's spirit: **run it against real shares for a week and
   reconcile by hand.** Nothing above substitutes for that.
4. ~~**Payouts enabled**~~ **DONE** — paid in each block's coinbase, one output per
   miner (`MINER-INTEGRATION.md` §7), idempotent on `(block_height, miner_address)`.
5. ~~**`startpoolmining`** in the node~~ **DONE** — `src/rpc/mining.cpp`; the fleet
   mines through the pool.

**Do not skip 3.** A payout engine that has never been reconciled against a real
week of shares is how a pool loses its operator's money rather than its users'.

## Decisions (owner, 2026-08-13)

| question | decision |
|---|---|
| **Fee** | **2%** — published on the pool page. Normal, and honest about it. |
| **Host** | **178.105.178.27** — PCoin-dedicated, already runs the market and pcnearner. Not a seed: validating shares is sustained CPU work and a seed's job is bootstrapping. |
| **Launch** | **Fleet-only for one week**, then public. The payout path gets exercised against coins the owner already holds before it ever touches a stranger's. |

Consequences worth writing down now, so they are not rediscovered:

* **2% is taken from the block reward, not from a miner's balance.** 50 PCN
  found → 49 PCN into PPLNS, 1 PCN to the pool. Never debit a miner's accrued
  balance; a fee that can make a balance go *down* is the kind of thing people
  screenshot.
* **`.27` has 2 cores.** At 21.7 ms per share that is ~90 shares/sec absolute
  ceiling, shared with the market, the price replica and pcnearner. Budget one
  core for validation and keep vardiff honest — see §2.
* **Fleet-only is enforced, not just intended.** Start with an allowlist of the
  fleet's payout addresses; a stranger who finds the port gets a clean
  rejection rather than silently accruing a balance nobody planned to pay.

## Questions as originally posed (all answered in the Decisions table above; kept for the record)

1. **Fee?** 0% buys goodwill at launch and costs a rounding error at this size.
   1–2% is normal. It should be published either way.
2. **Which host?** Not a seed — validating shares is CPU work and a seed's job
   is bootstrapping. `178.105.178.27` is PCoin-dedicated and already runs the
   market and pcnearner.
3. **Public or fleet-only first?** Running it with your own miners for a week
   before announcing exercises the payout path with money you own.
