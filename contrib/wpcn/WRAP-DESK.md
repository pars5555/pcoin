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

| limit | value | why |
|---|---|---|
| per person, per week | **500 wPCN** | 38 people can be served before inventory is touched to the bottom |
| per request | 500 wPCN | keeps any single reorg target small |
| total desk allocation | **start at 5,000**, not 19,026 | learn demand with a quarter of the inventory at risk |
| confirmations | **100** | the reorg window |

**Start with a pilot: 5–10 miners, 500 wPCN each.** If demand is 10× supply, far
better to discover that at 5,000 wPCN than at 19,026.

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
