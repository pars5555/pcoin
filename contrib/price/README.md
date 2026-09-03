# price.pc.am — the one number everything agrees on

PCN is not traded on any exchange, so there is no price to *discover* — only a
price to **post**. This service posts it, and every PCN payment integration
converts PCN to dollars with the number it publishes. Getting it wrong credits
real customers the wrong amount of money.

It is one file, `server.mjs`, with its whole state in a JSON file next to it.

---

## 1. Three numbers, and they are not the same

| field | what it is | who uses it |
|---|---|---|
| `price` | the **ladder's marginal rung** — what the next PCN costs to buy | the market page, humans |
| `buybackPrice` | the **constant-product curve** — what a sell-back pays | the buyback path only |
| `serviceRate` | what the payment rails **credit** PCN at | checker.pc.am, webbuilderbot, aicontrol.pc.am, 3dmodels.pc.am, 3dmodel.oonak.ai (a DIFFERENT product from 3dmodels.pc.am, with its own wallet) |

Confusing the first two is the mistake waiting to be made. Once the ladder has
moved they are decades apart, and using `price` to estimate a payout would
promise a seller many times what the buyback actually pays.

`serviceRate` is separate from both **on purpose**. Every mined coin is a claim
on those services, so letting an unbounded price directly set that number would
multiply a liability nobody paid for. The damping is the seatbelt.

## 2. Why the AMM is still here

The curve no longer prices a purchase — the ladder does that. It still runs the
**buyback**, because it has exactly the property a buyback needs:

> Payouts come out of the reserve, and the reserve can only be reduced by the
> same integral that filled it. **You can never pay out more than you hold.**

The operator's worst case is the seed capital, not supply × price. A fixed-price
buyback has no such bound, which is the entire reason this is a curve.

The failure mode that remains is not insolvency but price collapse: PCN is mined
continuously and mined coins cost their holders electricity rather than money.
If they all sell in, the curve does its job and the price falls. That is a
product problem, and the answer is real demand from the services.

> **There are two sell caps, they are different things, and the documentation
> has called them one.** `SELL_CAP_USD_PER_DAY = 20` in the market is per
> account per day and *is* enforced, inside a transaction, on the customer path.
> `dailySellCapUsd` here is a global backstop on the curve — live value **100**,
> not the 20 the docs quote — and it is currently **not exercised at all**,
> because the market records a payout request without calling `/execute`. So
> `soldToday` never increments and the curve never actually moves on a buyback.
> Nothing is over-paying today, since payouts are manual; but do not read
> `buybackRemainingToday` as a measure of anything until the market starts
> driving `/execute`.

## 3. How serviceRate walks

Every 60 seconds the **primary** polls the market's ladder and steps
`serviceRate` toward the posted price. Three brakes, and all three matter:

1. **±`serviceMaxMovePct` (10%) per step.** A ladder rung is +6.7885% (the
   header of `contrib/market/ladder.sql` states the live geometry), so one step
   is a little over one rung: in normal trading the rate keeps up, but a buyer
   sweeping thirty rungs cannot drag it there at once.
2. **A minimum interval between steps** (`serviceRetuneIntervalHours`, default
   **1**). Without this the clamp is decorative — polling every 60 seconds would
   turn "10% per step" into 10% per minute, which is 1000× in half an hour.
3. **A hard ceiling** (`serviceCeiling`, **10.00**) — the ladder's terminal
   price.

Measured live: with the ladder at 0.1831 and the rate at 0.001 — a target 183×
away — the rate stepped 0.001 → 0.0011 → 0.00121 → 0.001331 → 0.0014641. Exactly
10% each time, never toward the target.

> `serviceCeiling` was **0.01** while the AMM was the only seller, when 0.01 was
> ten times anything reachable. Under the ladder the price runs to 10.00 by
> design, and a ceiling of 0.01 does not fail loudly — it silently caps the
> credit rate at one cent while the market sells at ten dollars, and every
> customer paying with PCN is credited a thousandth of what they handed over.

**A changed default does not reach an existing install.** `load()` is
`{...DEFAULTS, ...state.json}`, so a stored value always wins. Changing
`serviceCeiling` in the source is not enough; it must be set explicitly through
`/admin/state`, which is what persists it.

## 4. Failure is modelled, not guessed

The rule the whole codebase is written against: **an answer that resolves
nothing must not become a fact.**

- **A failed ladder poll resolves nothing.** It keeps the last known ladder
  price, does not fall back to the AMM's 0.001 — which would undercut the ladder
  by three orders of magnitude — and does not retune. Past 10 minutes it reports
  `ladder.stale`.
- **A failed replica sync resolves nothing.** The last known state is still the
  best answer available; erasing it would take every payment system down for a
  network blip. `stale: true` says the number is remembered rather than current.
- **An exhausted ladder reports `marginalPrice: null`**, which is *not* a price
  of zero. It means every rung is sold and the last rung's price stands.

## 5. Primary and replicas

One **primary** owns the curve; replicas mirror it and refuse writes with `409`.
Two hosts accepting writes would diverge the curve, and there is no merge for a
divergent AMM.

Replicas exist because every payment path depends on this one service. Any
single origin can die unnoticed. **There are three origins** — a primary that
accepts writes and two replicas — and one of them lives on another project's
box; the full list is in `D:\pc.am\servers.md` under "price.pc.am — the rate
oracle, 3 origins". Deploy to all three and verify against the PUBLIC url, never
against the box you edited: Cloudflare sends most traffic to whichever origin it
picks, so updating two of three changes nothing a consumer sees.

### The trap that caught both replicas

Both shipped with `upstream: https://price.pc.am` — the **Cloudflare-proxied
name, which routes back to whichever origin Cloudflare picks, including the
replica itself**. A replica that fetches its own state, writes it back, and
reports `stale: false` looks perfectly healthy while never having heard from the
primary.

In production one such mirror served roughly nineteen of every twenty public
requests from a state frozen months behind, while the correct origins served the
other one — so consumers read **whichever of two disagreeing numbers they
happened to get**. Nothing in any log said a word.

Two changes close it:

- **Replicas sync from the primary's address**, with `price.pc.am` as the TLS
  server name and the primary's **public key pinned**. The primary presents a
  Cloudflare Origin CA certificate, which no public trust store contains — it is
  trusted only by Cloudflare's edge — so ordinary verification cannot succeed on
  a direct origin-to-origin call. Pinning is strictly *narrower* than trusting a
  CA: a CA can issue for anyone, a pin accepts one key and nothing else.
- **A replica refuses to sync from anything answering as a replica.** The
  primary carries no `role` key; only a replica does. Mirroring a mirror is how a
  frozen price passes for a live one, so it is now a visible failed sync instead.

> **Any new origin must be given the pinned upstream.** One left pointing at
> `https://price.pc.am` silently re-creates this exact fault. And note the blast
> radius of "fixing" it carelessly: all of them *refuse* a stale oracle and
> stop crediting six hours later, so flipping that flag without fixing the
> upstream is a self-inflicted outage.

## 6. HTTP API

| endpoint | |
|---|---|
| `GET /price` | the posted price, `serviceRate`, `buybackPrice`, the ladder block, staleness |
| `GET /state` | the full state, minus the admin token, so a replica can mirror it |
| `GET /quote/buy?usd=` `GET /quote/sell?pcn=` | AMM quotes — `sell` is the live buyback |
| `GET /history` | recent curve movements |
| `POST /execute` | move the curve. **Primary only**, admin token |
| `POST /admin/state` | set curve and damping parameters. **Primary only**, admin token |
| `POST /admin/retune` | force one `serviceRate` step now — refreshes the ladder first, then applies the clamp and ceiling. **Primary only**, admin token |

`/admin/retune` is the operator's throttle for the walk. It bypasses the
*interval*, never the clamp or the ceiling.

State is written with write-then-rename. A torn write here would corrupt the
reserve, which is the one number the solvency property depends on.

## 7. Traps

1. **A stored setting beats a changed default.** See §3.
2. **`price` ≠ `buybackPrice`.** See §1.
3. **Never point a replica at the proxied name.** See §5.
4. **The clamp without an interval is decorative.** See §3.
5. **Only the primary polls the ladder.** The market runs on the primary's
   loopback; a replica could not reach it, and if it could, independent walks
   would drift and the products would read inconsistent rates.
