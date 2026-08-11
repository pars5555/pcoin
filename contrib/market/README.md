# market.pc.am — selling PCN from a finite ladder

This is the only place PCN can be bought with ordinary crypto, and the only
place it can be sold back. It is a small Node service in front of MariaDB.

It is also the only PCoin service that **sends coins**. Every other one is
watch-only, and its worst bug fails to credit somebody. This one's worst bug
sends money to a stranger and nothing gets it back. That asymmetry is why the
code is shaped the way it is, and why delivery is still manual.

```
contrib/market/
  server.mjs        the HTTP service — auth, quotes, orders, IPN, buyback
  ladder.mjs        the fill engine. Pure walk functions + transactional reserve/settle/release
  ladder-test.mjs   40 cases against a real database. Refuses to run on a dirty ladder
  ladder-sim.mjs    simulate a sale to exercise the whole chain without spending money
  gen_ladder.mjs    generates the ladder and emits ladder.sql. Seeded, reproducible
  ladder.sql        the generated schema + 100 rungs
  index.html        the page, including the average-price calculator
  style.css
```

Runtime config lives in `/opt/pcoin-market/config.json` on the host (mode 600):
database credentials, the NOWPayments API key and IPN secret, the session
secret, and the buyback deposit address. **None of it is in this repository and
none of it may ever be.**

---

## 1. Why a ladder and not the AMM

PCoin already had a constant-product market maker posting a price. It was the
right tool for a posted price and the wrong tool for the requirement, which was:

> the price should be **$10.00 when 100,000 PCN are gone**.

A constant-product curve is asymptotic. `R × S = k` means you can always buy
more and the supply never runs out, so *"all 100,000 sold"* is not a point on
the curve and no purchase ever arrives at a stated price. There is no way to
express that requirement on an AMM, at any parameterisation.

A **finite order-book ladder** terminates. 100 rungs holding exactly 100,000 PCN
between them, priced geometrically from $0.001 to $10.00. When the last rung is
empty the price *is* $10.00, because there is nothing left to sell.

The second thing it buys is protection. On the AMM, 50,000 PCN cost about **$51**
— one person could have taken half the inventory for the price of a meal. On the
ladder the same 50,000 costs about **$1,084**, because it climbs 50 rungs. That
twenty-fold gap is the point of the exercise.

## 2. The ladder itself

| property | value |
|---|---|
| inventory | exactly **100,000 PCN**, one-way |
| rungs | **100** |
| price of rung *i* | `0.001 × 10000^(i/99)` |
| step | **+9.7499%** per rung |
| first / last | **$0.001** → **$10.00** |
| quantity per rung | ~1,000, randomised within 800–1,400 |
| revenue if fully sold | **$112,572.36** (average **$1.1257**/PCN) |

Reproduce any of it with `node gen_ladder.mjs --report`. The generator is seeded,
so re-running it emits byte-identical SQL — a ladder nobody can regenerate is a
ladder nobody can audit.

**Inventory is one-way.** Coins sold back through the buyback do **not** return
to the ladder. If they did, a buyer could walk the marginal price up and then
walk it back down, and "exactly 100,000 PCN" would stop being true.

### Two corrections the quantities needed

Both are the same lesson — a number that is right on average is not right — and
both are worth keeping in mind if the ladder is ever regenerated.

**Uniform 800–1,400 has a mean of 1,100, not 1,000.** Over 100 rungs that is
110,000 PCN against a 100,000 budget. The true-up then claws 10,000 back out of
the tail, which pins the *most expensive* rungs at the 800 floor and shifts
inventory into the cheap end. Revenue came out **$91.5k** instead of $112.5k, and
50,000 PCN cost $767 instead of $1,084. Quantities are now drawn from a
triangular distribution with its mode at 800, whose mean is exactly 1,000 and
which still spans the whole stated band.

**Expected-value-correct is not good enough for a ladder drawn once.** Because
prices span four orders of magnitude, the top ten rungs carry more than half the
revenue. With 100 independent draws the *expected* revenue is right, but any
single ladder misses it by whatever those few rungs happened to roll — the first
seed tried came in 7% light purely because rungs 97–99 drew small. The draw is
therefore **stratified**: every block of ten consecutive rungs gets exactly
10,000 PCN, and is then shuffled within the block to destroy the correlation
between a rung's size and its position that the feasibility clamp would
otherwise introduce.

## 3. The fill engine

Quantities are integer units of **1e-8 PCN**. Walking a ladder in floats and
writing the result into a `DECIMAL` column with a `CHECK` constraint means a
1e-9 overshoot aborts a transaction someone has already paid for. Integers
cannot overshoot.

### Lifecycle

```
        /api/buy                    IPN: finished|confirmed
  ─────────────────────►  reserved  ─────────────────────►  sold
                             │
                             │  IPN: failed|expired|refunded
                             │  invoice creation failed
                             │  24h sweeper
                             ▼
                          released
```

**Reservation happens at order creation, not at payment.** The order already
commits us to a quantity — `orders.quoted_pcn` is written then, and the invoice
is for a fixed number of dollars. Without a reservation, two orders could be
quoted against the same rungs and we would owe more PCN at those prices than the
rungs hold.

**Rungs are locked `FOR UPDATE`, in rung order, by every writer.** That is what
makes two buyers landing on one rung serialise instead of both being told it is
available. The same race, as a JSON file, is what the $20/day sell cap lost
before it was moved into a transaction.

**Settle and release are idempotent and only ever touch `state='reserved'`.** A
NOWPayments callback retry is a no-op. A refund arriving after delivery cannot
un-sell inventory.

**The database refuses to oversell even if the application is wrong.**
`CHECK (qty_sold + qty_reserved <= qty_total)` is the backstop; the row locks are
the mechanism. Both are there deliberately.

### The published price ignores reservations

`ladderState()` computes the published `marginalPrice` from `qty_sold` **alone**.

Reserving costs nothing. If reservations moved the published price, anyone could
open orders they never intend to pay for and walk it up — and because
`serviceRate` follows that number, it would inflate what four separate products
credit real customers. Quoting still respects reservations, so we can never
oversell; only the *published* number ignores them.

### The order is written before the invoice

`/api/buy` reserves rungs and inserts the order in one transaction, and only then
asks NOWPayments for an invoice. The original sequence was the other way round,
which meant a crash or a dropped response in between left a live invoice with no
order row: the customer pays, the IPN arrives, and the handler logs
`unknown order ignored`. Money in, nothing recorded. Written this way the worst
case is an order with no invoice, which the sweeper expires.

## 4. The divergence interlock

**The market refuses to sell when the ladder price and the rate the products
credit PCN at have drifted more than 20% apart.**

PCN is only worth buying here because the four products accept it over there. If
the two prices come apart, someone buys a coin at one price and has it accepted
at another — and the gap is unbounded, because the ladder runs to $10.00 while
`serviceRate` walks at a bounded speed.

Four properties matter:

- It compares against the **public** `price.pc.am`, not the loopback oracle on
  the same host. Those are different services, and that distinction is the whole
  point — the loopback one is always correct and nobody consumes it.
- It **samples the public endpoint three times and judges on the worst reading**.
  `price.pc.am` is Cloudflare-proxied across three origins, and they have
  disagreed in production. A lucky sample must not open sales while a customer's
  service credits off an unlucky one. When readings differ the response carries
  `oracleDisagrees: true` and `ratesSeen`.
- It **fails closed.** An unreadable oracle blocks the sale. A cached reading is
  reused for up to 5 minutes — `serviceRate` moves at most 10% an hour, so a few
  minutes old is still meaningful — never longer, and never a default.
- It is **self-clearing.** Nothing has to be remembered to turn selling back on.

`GET /api/ladder/gate` reports it; `/api/quote` carries `saleOpen` and
`saleBlockedReason`, and the page greys the button out and explains, rather than
refusing at the final click.

> **Know the throughput consequence.** The bottom rungs are worth well under a
> dollar, so the $10 minimum order consumes 8 rungs and moves the marginal price
> from 0.001 to 0.00192 — 92% above the credit rate. Sales then pause until
> `serviceRate` walks within 20%, roughly **5 hours** at 10%/hour. In practice
> the ladder sells about one minimum order every five hours until price levels
> rise. That is a deliberate throttle, and it is tunable: `MAX_DIVERGENCE_PCT`
> here, `serviceRetuneIntervalHours` and `serviceMaxMovePct` on the oracle.

## 5. Delivery — how the buyer actually gets the coins

Sign in → quote → order → NOWPayments invoice → IPN → rungs settle → **delivery**.

Delivery is split by size, and the split is the security model:

| order | what happens | what a break-in costs |
|---|---|---|
| ≤ `autoMaxUsd` (default **$25**) | the server signs and sends from a small hot wallet, usually within a minute | the float, and nothing more |
| above it | the server sends **nothing** — it queues the order and messages the operator, who sends from a wallet that has never been online | nothing |

So the money reachable from this box is bounded by the float, not by the
business. Everything else in the PCoin estate is watch-only; this is the one
exception, and it is kept small on purpose.

**The float** lives in a Core descriptor wallet called `market-hot`, created on
the host and never anywhere else. Levels: top up to `floatTargetPcn` (30,000),
Telegram nags below `floatWarnPcn` (24,000), and auto-send **stops** below
`floatStopPcn` (1,000) so the wallet can never half-empty itself mid-order.
Balance is read as `trusted` only — spending against unconfirmed coins is how a
wallet talks itself into an overdraft.

> Core generated that wallet at `m/84'/0'/0'`, not PCoin's `m/84'/9444'/0'`. It
> is a fresh random seed used only here so nothing collides, but a restore into
> a tool that assumes 9444' will produce different addresses. Back it up with
> `backupwallet`, not with twelve words — it does not have any.

### Never send twice

A double send is unrecoverable, so no step is optimistic:

1. **The order is claimed** with a conditional `UPDATE ... WHERE status='awaiting_delivery'`.
   Exactly one caller wins; everyone else sees `affectedRows = 0` and stops.
2. **The send carries the order id as its wallet comment.** If the process dies
   between claiming and recording, the transaction can be *found* rather than
   guessed at.
3. **Recovery never retries blind.** A claimed order with no recorded txid makes
   the reconciler search the wallet for that comment: found → record it; not
   found → the send never happened, hand it back. An order whose fate cannot be
   established is escalated to a human and **never resent**.

An RPC error is treated the same way — a timeout says nothing about whether the
node broadcast, so the wallet is searched before concluding anything.

### What the operator does

```bash
market-admin list                     # what is waiting, and why
market-admin float                    # balance, levels, funding address
market-admin backing                  # how much more PCN can be sold
market-admin send <order>             # send it now from the hot wallet
market-admin deliver <order> <txid>   # record one you sent yourself
market-admin set-password [email]     # admin panel password (prompts)
```

`deliver` records; `send` spends. Separate verbs on purpose — the one that moves
money should not be the one reached for by muscle memory.

### How much may be sold at all

The ladder says what there is to sell. **Backing** says what can actually be
handed over: the owner's own wallet balance, read from the explorer, minus every
PCN already promised on undelivered orders. Both have to say yes.

If the explorer cannot be read, the last good balance stands for 30 minutes — a
wallet does not empty by surprise — and past that **the market stops accepting
orders** rather than promise coins nobody has confirmed exist.

## 5b. Buying back is closed

`buybackOpen` is **off**. `/api/sell` refuses at the door and the panel is off
the page. Nothing underneath was deleted: the `sells` table, the per-account
daily cap and the AMM buyback in the price oracle are all intact and still
correct, so re-opening is one switch in the admin panel.

The cap, when it does come back, is enforced **inside a transaction with
`FOR UPDATE`**. A transaction alone was not enough: under REPEATABLE READ a
plain `SELECT SUM` is a non-locking consistent read, so two simultaneous
requests both saw the pre-transaction total and both passed — the same race the
move from a JSON file was supposed to have ended.

## 6. HTTP API

Everything read-only is public. Nothing here needs a credential to consume.

| endpoint | what it does |
|---|---|
| `GET /api/price` | proxies the price oracle |
| `GET /api/quote?usd=` | what `$X` buys: `pcn`, `effectivePrice`, `newPrice`, `rungsConsumed`, plus `saleOpen` / `saleBlockedReason` |
| `GET /api/ladder/state` | `marginalPrice`, `nextFillPrice`, sold / reserved / remaining, `pctSold` |
| `GET /api/ladder/calc?pcn=` | the calculator: rungs consumed, total cost, average price, price before and after |
| `GET /api/ladder/gate` | whether selling is open, and why not |
| `POST /api/register` `/api/login` `/api/logout` `GET /api/me` | accounts |
| `POST /api/buy` | reserve rungs, create the order and the invoice |
| `POST /api/sell` | request a buyback payout |
| `POST /ipn` | NOWPayments callback. **HMAC-SHA512 verified before anything is touched** |

The IPN signature is computed over the JSON re-serialised with keys sorted and
**each value's original source text preserved**. `JSON.stringify` renders `10.0`
as `10`, which would have produced a different string than the sender signed and
rejected **every round-number payment** as a bad signature — silently, and
looking exactly like an attack.

## 6b. The admin panel

`https://market.pc.am/admin` — orders, ladder rungs, fills, IPN log, users,
settings and an audit trail, all filterable and sortable.

Auth: password (scrypt, set only from the host with `market-admin set-password`)
plus **TOTP two-factor**, enrolled in the panel so the secret is shown once.
Login is rate-limited per account *and* per IP, every write carries a CSRF token
bound to the session, the cookie is `HttpOnly; Secure; SameSite=Strict`, and
every sign-in and change is written to `admin_audit` and announced on Telegram.

What it can change: sales on/off, buyback on/off, order limits, the auto-send
cutoff, float levels, order TTL, divergence limit. What it deliberately
**cannot**: `serviceRate` and the ladder's own prices. Those move money in four
other products; they belong behind the CLI, where a mistyped form cannot reach
them.

Settings live in the `settings` table and are re-read every 30 seconds, so a
change applies without a restart. The code defaults in `settings.mjs` still
define what each setting *means* and its safe range — but remember the rule this
estate keeps rediscovering: **a stored value beats a changed default.** Editing
a default does not move a running install.

### Least privilege

The application database user has **no DDL rights**. Tables are created once, as
root, at install time — so a compromised app cannot reshape its own schema. Both
`ensureTable()` calls therefore treat a privilege error as normal *provided the
table already exists*, and only refuse to start if it genuinely does not.

```sql
-- as root, once, per new table
GRANT SELECT, INSERT, UPDATE, DELETE ON pcoin_market.<table> TO 'pcoin_market'@'localhost';
```

## 7. Operating it

```bash
# regenerate and verify the ladder (prints the full sanity check)
node gen_ladder.mjs --report

# the engine test — 40 cases against the real DB.
# Refuses unless the ladder is pristine; restores it afterwards.
cd /opt/pcoin-market && node ladder-test.mjs

# exercise ladder -> oracle -> serviceRate without spending money
node ladder-sim.mjs sell 2000
node ladder-sim.mjs reset      # refuses if any non-TEST fill exists
```

Deploy is a file copy and `systemctl restart pcoin-market`. The service is
`pcoin-market.service`, `WorkingDirectory=/opt/pcoin-market`, behind Caddy.

**Seeding the ladder is not idempotent and must never run twice.** `ladder.sql`
creates the tables `IF NOT EXISTS` but the rung `INSERT` would reset `qty_sold`
and hand the same inventory out again. Check `SELECT COUNT(*) FROM ladder_rungs`
is 0 first. The guard is deliberately in the caller rather than `INSERT IGNORE`,
because `IGNORE` would silently skip exactly the rungs whose counters had
already moved — the only case that matters.

The application database user needs `SELECT, INSERT, UPDATE, DELETE` on both
ladder tables and **no DDL**; creating the tables requires the root socket.

## 8. Traps

1. **`price` and `buybackPrice` are different numbers.** `price` is the ladder's
   marginal rung — what it costs to *buy* the next coin. `buybackPrice` is the
   AMM curve — what a sell-back *pays*. The page's sell estimate once read
   `price`; left alone it would have promised sellers many times the real payout.
2. **A replica of the price oracle must never be pointed at `https://price.pc.am`.**
   That name is Cloudflare-proxied across all origins including itself, so the
   replica syncs from itself, freezes, and reports `stale: false` while doing it.
   This has happened twice. Point new origins at the primary's address with the
   key pinned.
3. **Reservations must not move the published price.** See §3.
4. **The $10 minimum order jumps 8 rungs** at launch prices. Any reasoning about
   "a small order" is wrong at the bottom of the ladder, where a rung costs under
   a dollar.
5. **`decimalNumbers: false` is deliberate.** DECIMAL columns come back as
   strings; turning a money column into a float is how rounding errors get into
   ledgers.
