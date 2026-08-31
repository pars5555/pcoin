# The wPCN wrap desk — specification

**Status: not built.** This is the design, written before any of it exists, so the
dangerous parts are decided while nothing is at stake.

The wrap desk is what turns wPCN from an isolated token into something pegged to
PCN. Until it exists, the two prices are free to drift apart arbitrarily, because
nothing connects them.

---

## 1. What it does

| direction | what happens | who does it |
|---|---|---|
| **wrap** — PCN → wPCN | user sends PCN to the reserve; operator sends wPCN from inventory | manual |
| **redeem** — wPCN → PCN | user calls `redeem()` on the contract, which burns and logs their PCoin address; operator sends PCN | manual |

Both legs are **manual on purpose**. See §3.

Neither leg mints anything. Supply is fixed at 50,000 forever — the contract has
no mint function and no owner, verified in the deployed bytecode. Wrapping moves
existing wPCN from the operator's wallet to a user's; redeeming burns it.

---

## 2. Why the peg works — arbitrage, not enforcement

With both directions open, other people close the gap for their own profit:

* **pool price above the PCN rate** → buy PCN cheap, wrap it, sell wPCN into the
  pool → pushes wPCN **down**
* **pool price below the PCN rate** → buy wPCN cheap, redeem for PCN, sell PCN →
  pushes wPCN **up**

That is why wBTC tracks BTC. Nobody enforces it; it simply pays to close.

**One direction alone is not a peg.** Wrapping without redemption pushes the pool
up and never down, so it can overshoot and stay there. Redemption is what makes
it two-sided, and it is the half that is easy to defer and shouldn't be.

---

## 3. The reorg problem, and why wrapping stays manual

A normal bridge lets anyone deposit and mint automatically. That is precisely the
shape a majority miner monetises:

> deposit PCN → receive wPCN → sell wPCN for USDT → reorg the deposit away

The deployed contract **cannot accept a deposit at all**, which removes the
attack surface entirely rather than mitigating it. The wrap desk reintroduces the
deposit path *outside* the contract, so the defence has to live in the procedure:

* **100+ confirmations before releasing any wPCN.** ~17 hours at 600 s spacing.
  Long enough that reorging it costs far more than the amount involved.
* **A human in the loop.** No automation that could be raced.
* **Per-person limits** (§4), so no single request is worth attacking.
* **The confirmation depth is not negotiable downward for a good customer.** The
  whole defence is that the window is uneconomic to attack; shortening it for
  someone impatient reopens it.

PCoin's hashrate is currently ~70–80% concentrated on `pool.pc.am`. That is the
project's own pool, which is better than a stranger holding it — but it does not
change the arithmetic, and the confirmation depth is sized for the general case.

---

## 4. Limits, and why they exist

**Inventory is 19,026 wPCN and cannot be increased.** At ~$0.0183 that absorbs
about **$350 of miner PCN**. There is ~162,600 PCN in other hands (~$3,000), so
demand could exceed supply by an order of magnitude on day one.

### Size the limit on PRICE IMPACT, not on inventory

The first version of this section sized limits against the 19,026 inventory.
That is the wrong constraint. The binding one is **what happens if everyone wraps
and immediately dumps into the pool** — the realistic failure, and the one the
owner asked about.

Measured against the live pool (30,974 wPCN / 411.97 USDT):

| wPCN dumped | seller receives | avg price | pool price after |
|---|---|---|---|
| 500 | $6.53 | $0.01306 | −3% |
| 1,000 | $12.85 | $0.01285 | −6% |
| 1,676 | $21.10 | $0.01259 | **−10%** |
| 3,656 | $36+ | $0.01210 | **−20%** |
| 5,000 | $57.14 | $0.01143 | −26% |
| 19,026 (all) | **$156.52** | $0.00823 | **−62%** |

**Two things fall out of that table.**

*Dumping is a bad deal for the dumper.* Selling all 19,026 yields $156 — an
average of $0.0082 against a $0.0133 spot and a $0.0183 service rate. The
constant product stops the pool being emptied; a seller into a thin pool mostly
punishes themselves.

*The real cost is the chart, not the money.* A −62% day-one candle is what kills
a token. $156 is not.

So the allocation is whatever caps the worst case at an acceptable drop:

| max acceptable drop | total desk allocation |
|---|---|
| 5% | 805 wPCN |
| **10%** | **1,675 wPCN** |
| 15% | 2,622 wPCN |
| 20% | 3,656 wPCN |

| limit | value | why |
|---|---|---|
| **total desk allocation** | **1,500 wPCN** | worst case, every recipient dumping at once, is about −9% |
| **per person** | **250 wPCN** | six people in the first round; no individual moves the pool more than ~1.6% |
| confirmations | **100** | the reorg window (§3) |

**Deliberately much tighter than inventory allows.** 19,026 stays in reserve.
Raise the allocation only after watching what the first recipients actually do —
and that is observable: their wPCN either sits in their wallet or turns up in the
pool's `Swap` events.

### The cycle mostly cancels a dump

If someone wraps 1,000 PCN and dumps the wPCN, the operator now holds 1,000 real
PCN. Selling it (§5) and buying wPCN back pushes the price up by roughly what
their sell pushed it down — **and buys back cheaper than they sold.**

Run promptly, the net price impact of a wrap-and-dump is near zero. The limit is
the backstop for when the cycle *cannot* keep up — several people wrapping at
once, or the PCN not selling quickly — not the primary defence.

Announce limits *before* opening. A desk that runs out mid-queue without having
said it could is worse than one that never opened.

---

## 5. The self-funding cycle, and the rule that governs it

Wrapping hands out inventory. This replaces it, funded by customers rather than
the operator's capital:

1. Miner wraps *N* PCN → receives *N* wPCN from inventory
2. Operator sells that *N* PCN through `market.pc.am` for USDT
3. Operator buys wPCN back from the pool with that USDT
4. Inventory replenished; the pool has seen a real buy

**Simulated from the live pool** (30,974 wPCN / 411.97 USDT, PCN rate $0.0183,
1,000 PCN per cycle):

| cycle | pool price | wPCN bought back | net |
|---|---|---|---|
| 1 | $0.013301 | 1,314 | **+314** |
| 2 | $0.014507 | 1,207 | +207 |
| 3 | $0.015765 | 1,113 | +113 |
| 4 | $0.017076 | 1,029 | +29 |
| 5 | $0.018440 | 954 | **−46** |

**It converges on the PCN rate; it does not run away.** While the pool trades
below the posted rate you sell PCN dear and buy wPCN cheap, so inventory *grows*
— 19,026 → ~19,689 by cycle 4. Once the pool passes the rate, the cycle costs
more than it returns.

> **THE RULE: run the cycle only while the pool trades BELOW `price.pc.am`.
> Pause it above.** That one rule keeps wPCN pegged, funds the desk from real
> customer flow, and never requires trading against yourself.

This is also why `market.pc.am` must keep running: it is the leg that turns
wrapped PCN back into the USDT that buys wPCN. Without it the cycle has no
middle step.

---

## 6. ⚠ The circular-reference trap — read before wiring the oracle

The stated goal is to eventually take the PancakeSwap price as PCN's price. That
is right, and there is a specific way to get it wrong:

```
    the cycle:   pool price  ←  follows  ←  price.pc.am
    the oracle:  price.pc.am ←  follows  ←  pool price
```

**Wire both and the two chase each other with no external anchor.** Any nudge in
either direction amplifies: a small push moves the pool, which moves
`serviceRate`, which moves what the cycle is willing to pay, which moves the pool
again. That is not price discovery — it is a feedback loop, and it is the exact
shape of a manipulated spiral. On six live payment rails.

**The only thing that breaks the circle is external demand** — trades by people
who are not us. So the switch must be gated on that, and on nothing else:

> **Do not switch `serviceRate` to follow the pool until a majority of pool
> volume, over a sustained window, comes from addresses that are not ours.**

That is measurable: read the pair's `Swap` events, exclude the operator and the
cycle's own address, and require third-party volume to dominate over (say) 30
days. Time alone is not the gate. Depth alone is not the gate. **Provenance is.**

Until then `price.pc.am` stays the anchor, honestly labelled as a posted rate,
and the pool is a second opinion rather than the source of truth.

### Can the price grow without limit?

**Yes — there is no ceiling in the mechanism.** An AMM price rises without bound
as the pool's token side is bought down; the earlier "$0.15" figure was one row
in a table, not a cap.

But *what* makes it rise matters:

* **Real demand** — strangers buying — raises it and the rise means something.
* **The cycle** raises it only up to `price.pc.am`, then stops by construction.
* **Self-buying** raises it arbitrarily and the number means nothing, because a
  price you paid for yourself carries no information.

So: unlimited growth is possible, and only the first kind is worth having. The
constraint is not arithmetic, it is whether anyone else wants PCN — which is what
the six services, the miners and the listings are actually for.

---

## 7. Operational checklist per request

1. User states the amount and their BSC address; operator checks it against the
   per-person limit and remaining allocation.
2. User sends PCN to the reserve address.
3. **Wait for 100 confirmations.** Verify against `explorer.pc.am` *and* the node
   — two independent reads, per the project's standing practice.
4. Verify the reserve balance covers all circulating wPCN afterwards. Each wrap
   should push backing *above* 1:1, never below.
5. Send wPCN from the inventory wallet. Record txid on both chains.
6. Run the cycle (§5) if, and only if, the pool trades below `price.pc.am`.

**Redemption is the same in reverse**, driven by the contract's `redeem(amount,
pcoinAddress)` event — which burns first and logs the destination, so the request
is a permanent record the operator cannot alter or deny.

---

## 8. What must be disclosed when it opens

* Wrapping and redemption are **manual**, with a stated turnaround.
* **100 confirmations** before release, and why.
* **Per-person and total limits**, stated up front, with the inventory figure.
* The desk can **run out**, and what happens then.
* Backing is **verifiable**: reserve `pc1q7hhzmdkkx0zjtzj6qkwmuvhlgwfqjrc6j2dk52`
  against a fixed 50,000 supply, both checkable by anyone.

---

# 9. Target architecture: connecting market.pc.am and the pool

Added after reading `market.pc.am`'s actual pricing code. **It changes the
recommendation**, so the finding comes first.

## 9.1 The ladder already does what the pool was wanted for

`market.pc.am` prices PCN from a **ladder**: 100 rungs, exactly 100,000 PCN,
geometric from **$0.015 to $10.00** at +6.79% a rung. Each purchase consumes
rungs and the marginal price rises. It is a bonding curve, and it already has the
property "if someone buys PCN, the price grows" — all the way to $10.

State on 31 Aug 2026: rungs 0-2 exhausted (2,940 PCN sold), marginal price at
rung 3, ~$0.0183 — which is what `serviceRate` is tracking.

**Compare the two instruments honestly:**

| | ladder | wPCN pool |
|---|---|---|
| depth | 100,000 PCN (~$1,800 at current rungs, far more higher up) | **$412** |
| price path | designed, geometric, to $10 | emergent |
| cost to move 26% | hundreds of dollars of real purchases | **~$50** |
| direction | sell-side only (buyback closed) | both ways |
| who can trade | buyers, via the site | anyone, permissionlessly |

**So replacing the ladder with the pool price today would be a downgrade.** The
pool is thinner by orders of magnitude and correspondingly easier to move. The
pool's advantage is that it is two-sided and permissionless; the ladder's is that
it is deep and cannot be pushed around for $50. Those are different virtues and
the pool has not earned the anchor role yet.

**Therefore: the ladder anchors, the pool follows — until the pool is deep enough
and third-party-driven enough to invert that.** The switch is gated in §6.

## 9.2 Making a PCN purchase move the wPCN price

The connection already exists in one direction and is simply not automated:

```
buyer purchases PCN on market.pc.am
   -> ladder rungs consumed, marginal price rises
   -> serviceRate tracks the ladder (damped, capped, alerted)
   -> the cycle buys wPCN while pool < serviceRate
   -> pool price rises
```

Automating step 3 is the whole change. On a successful delivery, buy wPCN from
the pool with a share of the proceeds — **only while the pool trades below
`serviceRate`**, per the rule in §5.

### Where it hooks

`/opt/pcoin-market/delivery.mjs`, in `deliver()`, **after** the PCN send has
succeeded and `delivered_txid` is recorded. Never before: a pool buy that
happened while the delivery then failed would be an unfunded position, and the
order is the thing that must be right.

### How it must behave

* **Read the pool price first, from the pair contract's `getReserves()`** — not
  from an API. It is the source of truth and cannot be stale or spoofed.
* **If the pool read fails, skip the buy.** Do not guess, do not retry into a
  loop, do not treat "unreadable" as "below the rate". Log it and move on. The
  delivery has already succeeded and must not be affected.
* **If pool price >= serviceRate, skip the buy.** This is the §5 rule and it is
  what stops the cycle running away.
* **Cap the per-order spend** and cap the price impact — refuse if the buy would
  move the pool more than a few percent. A large order must not be allowed to
  spike a thin pool.
* **Idempotency.** A retried delivery must not buy twice. Key the buy on
  `order_id` in its own table, the same shape as `delivered_txid`.
* **Never let it block or fail a delivery.** Wrap the whole thing; a pool problem
  must never strand a paying customer. This is the §7.13 lesson from CLAUDE.md:
  an ordered list of steps sharing one process is a chain, and a chain fails
  whole.

### Disclosure — not optional

Every one of these buys is signed by an address the project controls. On-chain,
routing customer demand and wash trading look identical; **only the disclosure
separates them.**

So publish, on pc.am and wherever the pool is linked:

> market.pc.am routes a share of PCN purchase proceeds into the wPCN pool.
> The routing address is `0x…`. These buys are funded by customer purchases,
> not by trading against ourselves.

An undisclosed version of exactly the same transactions is indefensible. A
disclosed one is ordinary market making.

## 9.3 The other direction: sell wPCN to BSC buyers directly

Cleaner still, and worth building second. Offer BSC-paying customers **wPCN**
rather than PCN, bought live from the pool with their own payment:

```
customer pays USDT -> market.pc.am buys wPCN FROM THE POOL -> delivers wPCN
```

Now the buy is the customer's economic decision reaching the pool directly. It
produces genuine third-party volume, which is the gate in §6 — and it is the only
mechanism here that produces volume nobody has to take on trust.

Keep the PCN option alongside it: real PCN is what the six services accept, and
wPCN is not a substitute for that.

## 9.4 Build order — not negotiable

1. **Wrap desk, both directions** (§1-§4). The anchor. Without arbitrage against
   real PCN, everything below is self-referential.
2. **Routing** (§9.2, then §9.3). Purchases move one price.
3. **Oracle last** (§6). Only once third-party volume dominates.

Doing 3 before 1 gives a self-referential price on six live payment rails, with
nothing external holding it down. That is the failure this document exists to
prevent.

---

## 10. Redemption — wPCN back to PCN

The mirror of wrapping, and the risk sits on the **other side**. Wrapping waits
because a PCoin reorg could take back a deposit we already paid for. Redemption
cannot wait for the same reason, because by the time we can see it the customer
has already lost their tokens.

### 10.1 What the contract does

`redeem(uint256 value, string pcoinAddress)` — `WrappedPCoin.sol:145`:

1. checks the caller's balance,
2. **burns** — `balanceOf` down, `totalSupply` down,
3. *then* emits `Redeem(from, value, pcoinAddress)`.

The burn happens **before** the log exists. So there is no such thing as a
pending redemption to cancel: the moment we can observe one, the wPCN is already
destroyed and that person is owed PCN. A missed wrap leaves a customer waiting.
A missed redemption leaves a customer **robbed**.

The address is a free-text string. The contract enforces only "non-empty and
<= 90 characters" (`:146-150`) — it cannot know what a PCoin address looks like.
Validation is ours to do.

### 10.2 What makes one safe to pay

| gate | why |
|---|---|
| burn is **finalized** on BSC | not a confirmation count — finality is the actual property. A reorg that unwound the burn would hand them back their wPCN *and* our PCN |
| destination valid **on PCoin** | people paste Bitcoin addresses, memos, truncated strings |
| reserve can cover it | |

Any of those unreadable means **hold**. Unreadable is UNKNOWN — never a pass,
and never a rejection either.

### 10.3 ⭐ The supply invariant is the auditor

This is the load-bearing idea, and it does not depend on logs at all:

```
issuedSupply - totalSupply  ==  total wPCN ever redeemed
```

`issuedSupply` is immutable, set once in the constructor. `totalSupply` only
falls, and only in `redeem()`. So the contract already knows the answer, in **one
state read** that cannot be rate-limited away, cannot fall into a scan gap, and
cannot be missed because an endpoint changed its indexing policy.

The watcher compares that figure against the redemptions it has actually seen,
every run. **Logs tell us WHO to pay; the invariant tells us WHETHER we have
seen everyone.** A shortfall means somebody burned wPCN and is on no list — the
worst state this system can reach — and it alerts loudly rather than staying
quiet.

That backstop is not theoretical. Log access here is genuinely unreliable:

* the deploy RPC (`bsc-dataseed.bnbchain.org`) **refuses `eth_getLogs` at every
  range**, including a 100-block span — measured, not assumed;
* the public endpoints that do serve logs only index **recent** history, so a
  historical backfill is not available at any price on a free tier;
* both rate-limit hard enough to 429 mid-scan.

Which is why the scan rotates endpoints with backoff, paces itself, and — when
it still cannot read a range — **refuses to advance its scan pointer** rather
than turning an unread range into a silent gap.

### 10.4 Why the scan floor is where it is

`REDEEM_FROM_BLOCK` is set in the unit file, and it is justified rather than
guessed. At the moment it was set the contract reported
`issuedSupply == totalSupply == 50000`, which **proves** zero wPCN had ever been
redeemed. There is nothing before that block to find. The invariant re-checks
that claim on every run, so if the floor were ever wrong the watcher says so
instead of quietly missing people.

### 10.5 Per request

1. `pcoin-redeem-watch` reports the burn once finalized, with amount and address.
2. **Run `validateaddress` on the destination.** The watcher's regex is
   structural sanity only and is deliberately not called validation.
3. Send the PCN from the reserve.
4. Record it: `pcoin-redeem-watch --paid <txhash:logIndex> <pcoin_txid>`.

Step 4 is the one manual override in the system, and it exists because the
payment goes out on PCoin, which the script cannot attribute back to a BSC burn.
Unlike the wrap side there is no chain read that proves *this particular*
redemption was settled — so a human records it, **with the txid**, so the claim
is at least checkable afterwards.

### 10.6 What is deliberately NOT built

**Nothing sends automatically.** The watcher nags; a person pays. An automatic
sender holding a key to the reserve, driven by a free-text address supplied by
whoever called `redeem()`, is a much larger target than this desk's volume
justifies.

### 10.7 Keyed on (txhash, logIndex)

Not on txhash. One BSC transaction can emit several `Redeem` events — a contract
or a multicall can batch them — and keying on the hash alone would pay the first
and **silently drop** the rest. Exactly the mistake all four deposit rails
shipped first (CLAUDE.md §8c #1), in a new place.

---

## 11. The keeper — connecting the two prices automatically

`contrib/wpcn/pcoin-wpcn-keeper`, every 10 minutes.

Before it existed PCN and wPCN were two unrelated numbers with nothing between
them. The keeper closes that gap mechanically, trading from our own inventory:

| condition | action | effect |
|---|---|---|
| pool **below** posted | buy wPCN from the pool | price **up** |
| pool **above** posted | sell wPCN into the pool | price **down** |

### 11.1 The anchor points at price.pc.am, and that is the safety story

The pool follows the posted rate. **Never the reverse.** At the time of writing
the pool holds ~$824 of total value, and at that depth **~$20 moves the price
10%**. Six live payment rails price off `price.pc.am`. If the posted rate
followed the pool, a few hundred dollars would reprice every rail — deposit PCN
bought cheaply elsewhere, collect credit at twice its worth.

Wire it both ways and there is no external anchor at all; see §6.

### 11.2 What it refuses to do

* **Trade on a price it could not read.** Unreadable is UNKNOWN, never zero and
  never "no change needed".
* **Trade inside the dead band** (2%). PancakeSwap takes 0.25% per swap plus
  gas, so chasing a 1% gap loses money on the round trip.
* **Overshoot.** Trade size is solved by bisection on the exact swap formula for
  the amount that reaches parity *and no further*; overshooting just hands the
  difference to the next arbitrageur. Verified to land within 0.000026% of
  target in both directions.
* **Exceed the daily budget** — so a bug or a manipulated read cannot empty the
  float in one run.
* **Act on an implausible gap** (>5x). That is far more likely a broken feed
  than a real market, so it alerts and holds.
* **Spend the float to zero.** Floors on both sides, with an alert when either
  runs low, so the operator finds out before it stops working rather than after.

### 11.3 Its key was generated on the server and never printed

`pcoin-wpcn-keeper --init` writes the key straight to `/etc/pcoin/keeper.conf`
at mode 0600 and prints only the **address**. This is a direct response to the
deployer key, which was generated on a server and delivered through a chat
transcript — and therefore had to be treated as burned and swept. Never repeat
that shape.

### 11.4 The economics, stated honestly

Buying wPCN spends USDT and accumulates wPCN. A pool that sits below posted for
a long time drains the float in one direction. That is not a bug — it is the
desk buying its own token cheaply — but it is finite, which is why the low-float
alert exists.

And this **is** market-making our own token. Ordinary and legitimate, but it
must be disclosed on pc.am as plainly as "the liquidity is not locked" already
is. A price we moved ourselves carries less information than one strangers set,
which is exactly why the anchor points the way it does, and why §6's gate on
third-party volume is what governs ever reversing it.
