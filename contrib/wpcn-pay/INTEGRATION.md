# Accepting wPCN — implementation brief for a PCoin service

**Hand this whole file to whoever implements it.** It is written to be
self-contained: a developer who has never seen PCoin should be able to work from
it without asking anyone a question.

Applies to **checker.pc.am, webbuilderbot, aicontrol.pc.am, webai.pc.am,
3dmodels.pc.am, 3dmodel.oonak.ai** and any service added later. Every one
implements the **same pattern** — same states, same ledger key, same refusal
rules — so that a bug found in one is a bug findable in all of them, and a
customer gets the same behaviour wherever they pay.

---

## 1. What you are building, in one paragraph

Your service already accepts **PCN** (native chain, one deposit address per
user, watched by a poller). You are adding **wPCN** — the same coin wrapped as a
BEP-20 token on BNB Smart Chain — as a second way to pay. The customer sends
wPCN from their own wallet to **one shared address**, then pastes the
**transaction hash** into your site. You send that hash to a central verifier,
which proves the payment on chain and tells you what it is worth in USD. You
credit your own user.

**wPCN and PCN credit at exactly the same rate.** One wPCN is worth one PCN,
because that is what wPCN is — a 1:1 claim on PCN in a public reserve. Both use
`price.pc.am/credit-rate`. (Until 2026-09-11 wPCN earned 10% more; that bonus was
removed because our own wrap desk sold wPCN for 5%, so it could be collected
without anyone buying anything. `bonus_pct` is still in the response, and is
now `0`.)

## 2. Why a transaction hash and not a deposit address per user

This is the question everyone asks first, so: we tried, and the chain will not
support it.

| | PCN (what you do today) | wPCN on BSC |
|---|---|---|
| tell payers apart | one address each | **no memo field exists in BEP-20** |
| move funds out | free | every address needs **BNB for gas first** |
| watch for deposits | explorer index | `eth_getLogs`, which public BSC RPCs **refuse** |

Measured 2026-09-08 against `bsc-dataseed.binance.org`, filtering on the wPCN
contract alone:

```
span 1 block     -> ERROR: limit exceeded
span 50 blocks   -> ERROR: limit exceeded
span 500 blocks  -> ERROR: limit exceeded
span 5000 blocks -> ERROR: limit exceeded
```

**Even a single block is refused.** Watching would mean a paid RPC subscription
or running our own BSC node, and per-user addresses would mean funding thousands
of them with BNB before a single payment could be swept.
`eth_getTransactionReceipt` for one hash is still free everywhere. So the
customer pastes the hash. One extra form field removes the gas problem, the
sweeping problem and the indexing problem together.

## 3. The verifier

```
POST https://wpcnpay.pc.am/verify
Authorization: Bearer <your project's token>
Content-Type: application/json

{ "txhash": "0x…64 hex…", "user_ref": "<your internal user id>" }
```

Your token is issued per project. **Ask the owner for it — it is not in this
document and must never be committed.** Store it the way you store your other
service credentials.

It holds no key, moves no money, and never touches your user balances. What it
owns is the **claim ledger**: it guarantees that one transaction hash can be
banked exactly once, across all services. You do not have to check whether
another service already took a payment — you ask, and the answer is
authoritative.

### Every reply, and what to do about it

| HTTP | `state` | what you do |
|---|---|---|
| 200 | `credited` | **credit `usd_total`**, once. It is now banked to you. |
| 200 | `already_claimed` | credit **nothing**. `yours` says whether it was you. |
| 200 | `pending` | not visible on chain yet. Tell them to wait; let them retry. |
| 200 | `confirming` | seen, too shallow. Show `confirmations`/`required`. |
| 200 | `no_payment` | real transaction, but it did not pay our address. |
| 200 | `reverted` | it failed on chain. Nothing was sent. |
| 200 | `reorged` | that block is no longer canonical. Do not credit. |
| 400 | `bad_request` | malformed hash. |
| 401 | — | your token is wrong. **A deployment bug, not a payment failure.** |
| **503** | `unreadable` | **we could not look.** Resolve nothing. Let them retry. |

**`unreadable` is the one that matters.** It does not mean "you did not pay". It
means the question is unanswered. Showing a paying customer "no payment found"
because a network call failed is how you convince someone they were robbed.

A successful reply looks like:

```json
{
  "ok": true,
  "state": "credited",
  "confirmations": 21,
  "usd_total": 14.2834,
  "wpcn_total": 368.58,
  "transfers": [{
    "state": "credited", "txhash": "0x…", "logIndex": 139,
    "wpcn": 368.58, "rate_usd": 0.035902421, "bonus_pct": 0, "usd": 13.2331
  }]
}
```

## 4. Use the supplied client. Do not write your own HTTP call.

`contrib/wpcn-pay/clients/WpcnPay.php` and
`contrib/wpcn-pay/clients/wpcn-pay.mjs` are in the repo and are already tested
against the live endpoint. They exist so that six services do not each invent a
subtly different idea of what a failure means.

```php
$wpcn = new WpcnPay(WPCN_PAY_TOKEN);
$r = $wpcn->verify($txhash, (string) $user->id);

if (WpcnPay::isCredit($r)) {
    // usd_total is the FINAL figure, bonus already applied (it is 0 today).
    // Never recompute it from wpcn x rate yourself.
    creditUser($user->id, $r['usd_total'], [
        'source'    => 'wpcn',
        'txhash'    => $txhash,
        'log_index' => $r['transfers'][0]['logIndex'],
        'rate_used' => $r['transfers'][0]['rate_usd'],
    ]);
}
flash(WpcnPay::humanMessage($r));   // safe to show a customer in every case
```

```js
import { WpcnPay, isCredit, humanMessage } from './wpcn-pay.mjs';
const wpcn = new WpcnPay(process.env.WPCN_PAY_TOKEN);
const r = await wpcn.verify(txhash, String(user.id));
if (isCredit(r)) { /* credit r.usd_total, once */ }
```

`isCredit()` is deliberately **not** `state !== 'unreadable'`. Written that way
it inverts the safe default and every unknown becomes a credit.

## 5. Your own ledger — the part the verifier cannot do for you

The verifier stops two *services* banking one payment. It cannot stop *your*
code crediting twice if your response is lost and the user retries. You need
your own idempotent row.

```sql
CREATE TABLE `wpcn_payments` (
  `id`                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`            BIGINT UNSIGNED NOT NULL,
  `txhash`             CHAR(66)        NOT NULL,
  `log_index`          INT UNSIGNED    NOT NULL,
  `wpcn`               DECIMAL(24,8)   NOT NULL,
  `credited_usd`       DECIMAL(18,6)   NOT NULL,
  `credited_rate_usd`  DECIMAL(18,10)  NOT NULL,   -- STAMPED, never recomputed
  `bonus_pct`          DECIMAL(6,3)    NOT NULL,
  `credited_at`        TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_claim` (`txhash`, `log_index`),
  KEY `by_user` (`user_id`, `credited_at`)
) ENGINE=InnoDB;
```

**`UNIQUE (txhash, log_index)` is not negotiable, and it is not `txhash` alone.**
One BSC transaction can contain several `Transfer` logs. Keying on the hash
alone silently **drops** the second one rather than erroring — which is exactly
the shape of the `(txid, vout)` bug that all four original PCN rails shipped,
and it cost real money each time.

Insert that row and credit the user **in one transaction**. If the insert hits
the unique key, you have already credited it: credit nothing and report success.

## 6. The rules, and why each one exists

These are the same four rules `docs.pc.am` states for PCN. Every one of them has
cost this project money.

1. **Key on `(txhash, log_index)`.** Never the hash alone. See above.
2. **Stamp the rate you actually credited at.** `credited_rate_usd` is written
   once and never recomputed at display time. A hardcoded rate is how one
   service credited a batch at one fifteenth of value.
3. **A failed, timed-out or stale read resolves nothing.** Search your diff for
   `?? 0`, `|| 0`, `(int)$x` on a failed call and `@`-suppressed calls. Each one
   turns "unknown" into a number, and the number is always wrong in the
   customer's favour or ours, never neutral.
4. **Gate on confirmations; never auto-reverse a credit.** The verifier does the
   confirmation gating (15 blocks on BSC). If it says `reorged`, do not credit —
   but never automatically claw back something already credited. That is a human
   decision.

And a fifth, learned expensively:

5. **Never gate on a cumulative counter.** One ordinary 1-block reorg set
   `blocks_unwound` to 1 on 2026-08-30 and **all six PCN rails silently refused
   to credit anything for three and a half days** while exiting clean every
   tick. Health means "the call answered", never "nothing has ever gone wrong".

## 7. The customer-facing part

Wherever you show the PCN deposit address, add a wPCN option:

- The payment address, which the verifier reports at
  `GET https://wpcnpay.pc.am/health` as `payTo`. **Read it from there rather
  than hardcoding it**, so it can be rotated without six deployments.
- **Network: BNB Smart Chain (BEP-20).** Say it loudly. wPCN sent on Ethereum or
  Tron is gone.
- **Token: wPCN, 8 decimals.** Not 18. Most BEP-20 tokens are 18 and wallets
  that guess will be wrong.
- A single text field: *"Paste your transaction hash"*, plus a Verify button.
- Say plainly that **wPCN credits the same as PCN**. There is no bonus to
  explain and no arithmetic for them to check.

After they submit, show `humanMessage($r)`. For `pending` and `confirming`,
leave the field populated so they can retry without re-pasting.

## 8. Before you call it done

Do not skip these. Each one has failed in production somewhere in this estate.

- [ ] A **real payment** credits exactly once, and the row lands with the rate stamped.
- [ ] **Submitting the same hash twice** credits once. Check the balance, not the message.
- [ ] A hash **that does not exist** shows "we cannot see it yet", **not** "no payment".
- [ ] With the **verifier unreachable** (block it in your firewall, or point the
      client at a dead port), your page says "could not check, try again" and
      **credits nothing**. If you only test the happy path you have not tested this.
- [ ] With a **wrong token**, the same. A misconfigured deployment must never
      resolve a customer's payment.
- [ ] A hash that paid a **different address** shows "did not pay us".
- [ ] The credited amount is **`usd_total` as returned, never recomputed**.
      Trust the field; do not multiply `wpcn` by `rate_usd` yourself.

That fourth item is the one that separates a working integration from one that
will eventually tell a paying customer they did not pay. Test it deliberately —
*a check that cannot fire is indistinguishable from a check that passes.*

## 9. What the first integration got right — copy these

checker.pc.am shipped first, on 2026-09-08. Reviewing it turned up four things
this brief did not ask for and should have. Do them.

**Handle `already_claimed` with `yours=true` and no local row.** That state means
the verifier banked the payment to *your* user and *your* write was then lost —
the database went away between their answer and your commit. Refusing forever
costs a paying customer their money. Re-read the claim from `GET /claims`, which
carries the stamped rate, and credit from that, through the same unique key.
Only when **every** log in the reply is yours, and only when you genuinely hold
no row. If you cannot read the claim record either, return `unreadable` — never
"already credited".

> This is only safe because the balance and the row commit in **one**
> transaction. If yours can credit a balance without writing the row, this heal
> path double-credits. Check that before copying it.

> **The two endpoints name the same three fields differently, and `GET /claims`
> now returns BOTH spellings.** This was a defect in the verifier, found on
> 2026-09-08 by an integrator whose heal path read the `/verify` names off a
> `/claims` row and got `undefined` for all three — a heal that would have
> failed even with a correct HTTP client, and failed *silently*, because a
> number that goes missing and a number that is zero look alike by the time they
> reach a balance.
>
> | | log index | amount | rate |
> |---|---|---|---|
> | `/verify` → `transfers[]` | `logIndex` | `usd` | `rate_usd` |
> | `/claims` → `claims[]` (stored names) | `log_index` | `usd_credited` | `credited_rate_usd` |
>
> Every `/claims` row now carries all six keys, so either reading works. Adding
> names cannot break a reader; renaming would have broken the integrator who had
> already coded to the stored names. **Accept both anyway** — normalise on the
> way in, and if a row for your hash is unreadable return `unreadable`, never a
> guess. Your own stub is not evidence here: a test double agrees with whatever
> shape you assumed, which is exactly how this stayed hidden.

**Refuse a zero conversion rate.** If your own `credits_per_usd` (or whatever
turns USD into your product's units) is missing or `<= 0`, you would credit
nothing and report success. That is rule 3 pointed at your own config instead of
at the network. Log it and refuse.

**Lock the user row.** `SELECT ... FOR UPDATE` on the balance row, inside the
same transaction as the insert. Two requests for one user arriving together is
not exotic — it is what a customer does when the first page seems slow.

**A `credited` reply you cannot read is not a credit.** If `state` is `credited`
but `usd_total` is zero or the `transfers` array is unusable, write nothing and
return `unreadable`. The verifier has still banked it to you, so the customer's
retry lands in the heal path above and gets the full record.

Two more worth copying:

* The client was taken **verbatim**, with a namespace line and a comment saying
  *"fix bugs upstream and re-copy; do not edit here"*. That is the entire point
  of a shared client.
* The destructive test carries **two independent guards** — an explicit
  `..._IS_DISPOSABLE=yes` environment variable *and* a count of real users in the
  target database — with a comment explaining that either one alone fails open.

Its live run against the real verifier is the bar to clear:

```
wrong token                  -> unreadable
dead port                    -> unreadable
wrong endpoint (an HTML page) -> unreadable    <- not "no payment"
malformed hash               -> bad_request
nonexistent hash             -> pending        <- asserted NOT no_payment
rows written during all of the above: 0
```

## 10. Questions

Read `contrib/wpcn-pay/README.md` for the verifier's own design and the test
results it shipped with. Anything else, ask the owner.
