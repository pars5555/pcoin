# wPCN — Wrapped PCoin on BNB Smart Chain

A fixed-supply BEP-20 token representing a claim on PCN held in a publicly named
reserve, paired against USDT in a PancakeSwap V2 pool.

**Why this exists.** Every other venue PCoin can reach — Komodo, atomic swaps —
needs a *counterparty*: another person, holding the other coin, running
compatible software, willing to trade right now. Most people will never clear
that bar. This route needs a wallet and a click, because the trade is against a
pool of money in a contract rather than against a person.

**What it is not.** wPCN is not PCN, and this is not a trustless bridge. It is an
issued claim. That distinction is the whole content of the disclosure below, and
nothing here should be presented in a way that blurs it.

---

## Status

| | |
|---|---|
| Contract | `WrappedPCoin.sol`, compiles clean under **solc 0.8.26**, optimizer 200 runs |
| Tests | `test_wpcn.py` — **47 checks, all passing** on an in-process py-evm |
| Deploy gas | **707,992** measured — about **$0.025** at 0.05 Gwei / BNB $700 |
| Full setup gas | ~3.8M — about **$0.13** all in |
| BSC connectivity | verified: chain 56, gas 0.05 Gwei, Router/Factory/USDT all live |
| Deployed | **yes** — `0x290A5779a419Cb9cB22fa087CDD1CD16dA2D95F1` on BNB Smart Chain, 50,000 wPCN fixed supply; PancakeSwap V2 wPCN/USDT pool live; wrap and redeem at https://wrapdesk.pc.am (see `WRAP-DESK.md`) |

---

## The contract, and why it is shaped this way

**There is no owner, and no mint function.** The whole supply is created in the
constructor and after that nobody — including whoever deployed it — can create
another unit. That is checkable in the bytecode, not promised in a document, and
it is the single most important property here. `test_wpcn.py` asserts the *absence*
of `mint`, `owner`, `pause`, `blacklist`, `setFee`, `upgradeTo` and friends from
the ABI, so a future edit that quietly adds one fails the suite.

**There is no deposit path, and that is deliberate given PCoin's hashrate.** A
normal bridge lets anyone deposit PCN and receive wrapped tokens — which is
exactly the shape a majority miner monetises: deposit, mint, sell, then reorg the
deposit away. This contract cannot accept a deposit at all. The attack has no
entry point, which is stronger than mitigating it.

**8 decimals, not 18.** Matching PCN's own smallest unit, so 1 wPCN is 1 PCN with
no scaling factor anywhere. This follows WBTC, which likewise keeps Bitcoin's 8.
A conversion factor between a wrapper and its backing is a rounding bug waiting
to be found.

**`totalSupply` vs `issuedSupply`.** `totalSupply` behaves normally and falls when
tokens are redeemed — that is what wallets and explorers expect. `issuedSupply` is
immutable and records what the reserve was sized against. Folding both meanings
into one standard field would have made the contract quietly non-conformant.

**Redemption is `redeem(amount, pcoinAddress)`** — it burns and emits your PCoin
address in an event. Settlement is manual: a person sends the PCN. The event is a
permanent record of the request that the issuer cannot alter or deny, which is
the strongest thing a single-chain contract can do. **Burning happens first**, so
anyone calling it should understand the order: the tokens are gone when the
transaction confirms, and what remains is the log and the issuer's word.

---

## What must be disclosed, plainly, wherever this is promoted

These are not caveats to bury. Two of them are the same class of thing the
hashrate concentration was, and that one was put in the first paragraph of the
Komodo PR for a reason.

1. **wPCN is an IOU.** Its value depends on the reserve actually holding the PCN
   it claims, and on redemptions being honoured. No contract can prove a balance
   on another chain. The reserve address is baked into the contract and emitted
   at deployment so anyone can check it themselves — but checking is on them, and
   the promise is on us.

2. **Whoever holds the LP tokens can withdraw the liquidity.** This — not the
   token contract — is what people mean by *"is the liquidity locked?"*. The
   token being ownerless does not make the pool safe. `deploy.py verify` prints
   who holds the LP tokens and says so out loud, because a project that omits
   this is hoping nobody asks.

3. **A small pool is a volatile pool, and that is arithmetic, not a flaw.** With
   under $1,000 of depth (check the live pool before quoting a figure), a trade of a
   few percent of the pool moves the price ~10%. Anyone told to
   expect a stable price will feel misled by something we knew in advance.

4. **Redemption is manual.** https://wrapdesk.pc.am/redeem calls `redeem()` from
   your own wallet; a person then sends the PCN by hand — allow hours, not
   minutes. PCN → wPCN goes through the same desk (5% fee, 100 confirmations).
   Design and procedures: `WRAP-DESK.md`. Say so; do not let "wrapped" imply an
   automatic bridge.

---

## Costs, measured rather than estimated

At the verified 0.05 Gwei and BNB ~$700:

| step | gas | cost |
|---|---|---|
| deploy wPCN | 707,992 (measured) | $0.025 |
| approve × 2 | ~92,000 | $0.003 |
| createPair + addLiquidity | ~3,000,000 | $0.105 |
| **total** | **~3.8M** | **~$0.13** |

So gas is a rounding error. **A $5 BNB buffer covers it ~35×.** Essentially the
entire budget goes into the pool, which was the point of checking.

**BNB is required even for a USDT pool** — BSC's gas token is always BNB. This
trips people up.

---

## Deployment runbook

Prerequisites, in this order — the first one is not optional and not reversible:

1. **Lock the backing PCN first.** Send the PCN to the dedicated reserve address
   *before* deploying. `ISSUED_PCN` must already be sitting there. Deploying does
   not create backing; it only claims it.
2. Fund the deployer with BNB (~$5) and USDT-BEP20 (the pool money).
3. Compile and test:
   ```sh
   solc --optimize --optimize-runs 200 --combined-json abi,bin -o build --overwrite WrappedPCoin.sol
   ./.venv/bin/python test_wpcn.py          # must be all-green before anything else
   ```
4. Write `wpcn.conf` (mode 0600, **never** committed — see the docstring in
   `deploy.py` for the keys).
5. Stage by stage, checking between each:
   ```sh
   ./deploy.py addr      # balances; says READY or what is missing
   ./deploy.py token     # deploys; writes TOKEN= into the conf
   ./deploy.py pool      # approve + createPair + addLiquidity
   ./deploy.py verify    # reads it all back OFF-CHAIN, including LP custody
   ```
6. **Verify the source on BscScan** — solc 0.8.26, optimizer on, 200 runs. An
   unverified contract is one nobody can audit, and asking people to trust an
   unverified wrapper is asking too much.

Each stage refuses to run twice. `token` will not deploy if `TOKEN` is already
set; `pool` will not add liquidity if a pair already exists, because adding to a
pool with existing reserves uses *its* ratio, not yours.

> **The opening price is set by the `POOL_WPCN` / `POOL_USDT` ratio and nothing
> checks it.** `addLiquidity` on an empty pair mints the pool at exactly that
> ratio. There is no undo — the only correction is somebody arbitraging you.
> `deploy.py pool` prints the implied price before sending, on purpose.

---

## Addresses, verified against BscScan on 2026-08-24

| what | address |
|---|---|
| PancakeSwap V2 Router | `0x10ED43C718714eb63d5aA57B78B54704E256024E` |
| PancakeSwap V2 Factory | `0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73` |
| USDT (Binance-Peg BSC-USD) | `0x55d398326f99059fF775485246999027B3197955` |

**USDT on BSC has 18 decimals**, not the 6 it uses on Ethereum and Tron —
confirmed by reading `decimals()` off the live contract. Getting this wrong is
how someone sends 10¹² times what they meant to.

**V2, not V3.** V3's concentrated liquidity needs the position actively managed
inside a price range; drift outside it and the position stops trading entirely.
V2's flat curve needs no babysitting, which is the right trade for a new token
with no established range.

---

## Files

| file | what it is |
|---|---|
| `WrappedPCoin.sol` | the contract. ~90 lines of logic, no dependencies |
| `test_wpcn.py` | 47 checks on a real EVM, including ABI-absence assertions |
| `deploy.py` | staged deployment, refuses to repeat irreversible steps |
| `wpcn.conf` | **not in git.** Holds the private key |

---

## After launch: feeding the pool price into price.pc.am

**Superseded.** The direction that shipped is the opposite: `price.pc.am` is the
anchor and `pcoin-wpcn-keeper` moves the pool toward it, never the reverse
(`WRAP-DESK.md` §11.1). The live pool price may be published as its own
informational field but must never be presented as the PCN price. The plan below is
kept as history; switching `serviceRate` to follow the pool is gated on a sustained
majority of pool volume coming from addresses that are not ours (`WRAP-DESK.md` §6).

On PancakeSwap the price is automatic and needs no oracle — an AMM's price *is*
its pool ratio, so every trade moves it. The question is only what, if anything,
downstream should follow it.

**The thing not to do: wire the pool price straight into `serviceRate`.**
`serviceRate` is what five live products credit real customers at. The pool is
shallow — check the live pool before quoting a figure — so a small buy moves it
~10%. Wiring them together buys an attacker a
rate they control for a few hundred dollars: pump wPCN, spend PCN across
checker / webbuilderbot / aicontrol / 3dmodels.pc.am / 3dmodel.oonak.ai at the inflated
rate, sell back. That is oracle manipulation, a thin pool is the textbook
vulnerable oracle, and the rails would be funding the attack.

`price.pc.am` already knows this. From its own source:

> `serviceRate` TRACKS the market price but is damped and capped: every mined
> coin is a claim on those services, so letting an unbounded curve set that
> number would let a price spike multiply a liability nobody paid for. Damping
> is the seatbelt.

and, written after it actually broke:

> This service had NO alerting of any kind, which is how `serviceRate` walked
> +10% a minute against a stuck retune clock until a human happened to read the
> number. It sets the rate every PCN payment product credits real money at, so a
> wrong value here is a wrong price everywhere at once.

So the pool is **a new input to a system that already distrusts its inputs**,
not new plumbing. The design:

1. **Publish the live pool price as its own field**, unfiltered and real-time.
   Honest, and it is not what credits anybody.
2. **Feed it to `serviceRate` only through the existing damping and step cap** —
   the same seatbelt the market.pc.am ladder goes through.
3. **Use a time-weighted average over 30–60 minutes, never the spot price.**
   Moving a spot price costs one transaction. Holding an hour-long average away
   from true price means paying arbitrageurs for an hour. This is the standard
   defence and it is the single highest-value item here.
4. **Cap daily movement and alert on every step.** Both already exist.
5. **Cross-check against the ladder price.** If PancakeSwap and market.pc.am
   disagree beyond a margin, that is a signal something is wrong — hold, do not
   credit. Same doctrine as everywhere else in this project: an implausible
   reading resolves nothing.

**Sequencing: after the pool has traded for a few days.** There is real value in
watching it behave before anything that moves money depends on it, and none in
rushing. Until then `serviceRate` keeps working exactly as it does today.
