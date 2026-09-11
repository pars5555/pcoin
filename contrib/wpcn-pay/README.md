# Accepting wPCN — the shared payment verifier

One small service that lets every PCoin project take **wPCN** on BNB Smart Chain
alongside PCN. A project hands it a customer's transaction hash; it proves the
payment on chain, records the claim so no two projects can bank the same one,
and answers with an amount in USD. The project credits its own user.

It never holds a key, never moves money, and never touches a user balance.

---

## Why a transaction hash, and not an address per customer

The PCN rails give every customer their own address and watch the chain for
deposits. That design does not survive the move to BEP-20:

| | PCN | wPCN on BSC |
|---|---|---|
| tell payers apart | one address each | **no memo field exists** |
| move funds out | free | each address first needs **BNB for gas** |
| watch for deposits | explorer index | `eth_getLogs`, which public BSC RPCs **refuse** |

That last row is not a guess. Measured 2026-09-08 against
`bsc-dataseed.binance.org`, filtering on the wPCN contract alone:

```
span 1     -> ERROR: limit exceeded
span 50    -> ERROR: limit exceeded
span 500   -> ERROR: limit exceeded
span 5000  -> ERROR: limit exceeded
```

**Even a single block is refused.** Address-watching on BSC therefore means a
paid RPC subscription or running our own node, and per-customer addresses mean
funding thousands of them with BNB before a single payment can be swept.

`eth_getTransactionReceipt` for one hash is still served by every public
endpoint, free. So the customer pastes the hash. It is one extra field in a
form, and it removes the gas problem, the sweeping problem and the indexing
problem together.

---

## The rules this service exists to enforce

`docs.pc.am` states four for PCN. Every one has cost real money at least once,
and every one carries over with a twist:

1. **Key on `(txhash, logIndex)`** — never the hash alone. One transaction can
   contain several `Transfer` logs, and keying on the hash silently **drops**
   the second rather than erroring. This is the BEP-20 shape of the
   `(txid, address)` rule that all four original PCN rails shipped wrong.
2. **Read the rate at credit time and stamp it on the row.** `credited_rate_usd`
   is written once and never recomputed. A hardcoded rate is how 3dmodels
   credited a batch at one fifteenth of value.
3. **A failed, timed-out or stale read resolves nothing.** There is no `?? 0`
   anywhere in this file on a value that decides money. An unreadable chain is
   `503 unreadable`, never `no_payment`.
4. **Gate on confirmations; detect reorgs but never auto-reverse a credit.**

And a fifth, learned the expensive way:

5. **Never gate on a cumulative counter.** One ordinary 1-block reorg set
   `blocks_unwound` to 1 on 2026-08-30, and all six PCN rails refused to credit
   anything for three and a half days while exiting clean every tick. Health
   here means "the node answered and this receipt is buried deep enough" — never
   "nothing has ever gone wrong".

---

## What was actually tested

Not a description of intent — this is what ran, against a real BSC transfer
(`0x9a5069de…`, 368.58 tokens, logIndex 139):

| test | result |
|---|---|
| no bearer token | `401` |
| malformed hash | `bad_request` |
| real transfer | **`credited`**, rate stamped `$0.035902`, no bonus → `$13.2318` |
| the same hash again | `already_claimed`, `yours=true`, no second row |
| a **different project** claiming the same hash | `already_claimed`, `yours=false`, `banked_by=checker.pc.am` |
| a hash that does not exist | `pending` — **not** `no_payment` |
| every RPC dead | `503 unreadable`, **nothing written** |
| chain fine, **price feed dead** | `503 unreadable`, **nothing written** |

The last two are the ones that matter. A verifier that credits when it cannot
read is worse than no verifier, and a verifier whose failure path has never been
exercised has not been tested — *a check that cannot fire is indistinguishable
from a check that passes*.

> A note on the fifth test. It first appeared to pass wrongly, returning
> `200 pending` instead of `503`. The cause was the harness, not the service:
> each shell invocation is a new process, so `kill %1` did not reach the running
> server, the new one failed with `EADDRINUSE`, and the request was answered by
> the old server with working RPCs. Killing by listening port produced the real
> result. Worth recording, because a test that silently tests the wrong process
> is exactly the failure this file is about.

---

## How the ledger is stored

One JSON file per claim, named `<txhash>-<logIndex>.json`, in `dbDir`.

The uniqueness guarantee is the **filesystem's**: `writeFileSync` with flag
`'wx'` is an `O_CREAT|O_EXCL` create, which either makes the file or throws
`EEXIST`, atomically, with no read-then-write window. Two projects racing on the
same hash, or one project retrying after a lost response, both aim at the same
filename and exactly one wins. The record is `fsync`ed before the caller is told
it happened, because a credit that is not on disk when the process dies is a
credit the customer can claim twice.

This deliberately does **not** use `node:sqlite`. That API is still flagged
experimental and prints a warning on every start; a financial ledger should not
be one node upgrade away from behaving differently. It also confined the service
to hosts running node >= 22.5 — two of five — which is an absurd constraint for
an append-only set of small records. A directory of files is greppable, backs up
with `rsync`, and needs no dependency at all.

## Install

```bash
sudo useradd --system --home /var/lib/pcoin-wpcn-pay --shell /usr/sbin/nologin pcoinpay
sudo install -d -o pcoinpay -g pcoinpay -m 750 /var/lib/pcoin-wpcn-pay /opt/pcoin-wpcn-pay
sudo install -m 644 server.mjs /opt/pcoin-wpcn-pay/server.mjs

sudo install -d -m 755 /etc/pcoin
sudo install -m 600 wpcn-pay.example.json /etc/pcoin/wpcn-pay.json
sudoedit /etc/pcoin/wpcn-pay.json          # set payTo and generate the client tokens

sudo install -m 644 pcoin-wpcn-pay.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now pcoin-wpcn-pay
curl -s http://127.0.0.1:8792/health
```

Generate each project token with `openssl rand -hex 32`. The service **refuses
to start** if `payTo`, `decimals`, `minConfirmations`, `bonusPercent`, `rpcUrls`
or `clients` is unset — it will not run on a default that could be mistaken for
a decision. That is not pedantry: `pcoin-wrapdesk-watch` defaulted a height
floor to `0` when run outside its unit, re-read the reserve's own founding
deposit as a customer owed 50,000 PCN, and paged the owner with an alert
indistinguishable from a real one.

Bind stays on **loopback**, behind the web server each host already runs. Three
services on `116.203.221.42` were reachable from the internet because nobody
checked; do not add a fourth.

### `payTo` must be its own address

Do **not** point it at the wPCN inventory wallet. Revenue and float sharing one
balance means you cannot tell what you have sold from what you have not issued.
A fresh address, in the custody scheme, recorded in the runbook.

---

## Using it from a project

```
POST /verify        { "txhash": "0x…", "user_ref": "<your user id>" }
Authorization: Bearer <this project's token>
```

| HTTP | `state` | what the project should do |
|---|---|---|
| 200 | `credited` | credit `usd_total`; the row is now banked to you |
| 200 | `already_claimed` | credit **nothing**; check `yours` to see if it was you |
| 200 | `pending` | not visible yet — tell the customer to wait, retry later |
| 200 | `confirming` | seen, too shallow — show `confirmations/required` |
| 200 | `no_payment` | the hash is real but paid us nothing |
| 200 | `reverted` | the transaction failed on chain |
| 200 | `reorged` | the block is no longer canonical — do not credit |
| 400 | `bad_request` | malformed hash |
| 401 | — | bad or missing bearer token |
| **503** | `unreadable` | **we could not look. Resolve nothing. Retry.** |

`503` is the one that matters. It is not a failure to display to a customer as
"payment not found" — it means the question is unanswered, and the only correct
response is to ask again.

```php
<?php
// The whole integration. Note what is NOT here: no `?? 0`, no `@`, no cast of
// a failed call into a number. Each of those turns "unknown" into an answer.
function wpcn_verify(string $txhash, string $userRef): array {
    $ch = curl_init('http://127.0.0.1:8792/verify');
    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 60,
        CURLOPT_HTTPHEADER     => [
            'Content-Type: application/json',
            'Authorization: Bearer ' . WPCN_PAY_TOKEN,
        ],
        CURLOPT_POSTFIELDS => json_encode(['txhash' => $txhash, 'user_ref' => $userRef]),
    ]);
    $body = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($body === false || $code === 0) {
        return ['state' => 'unreadable'];        // transport died: resolve nothing
    }
    $j = json_decode($body, true);
    if (!is_array($j)) {
        return ['state' => 'unreadable'];        // unparseable is not "no payment"
    }
    return $j;
}

$r = wpcn_verify($_POST['txhash'], $user->id);

if ($r['state'] === 'credited') {
    // usd_total already includes the wPCN bonus.
    credit_user_balance($user->id, $r['usd_total'], [
        'source'    => 'wpcn',
        'txhash'    => $txhash,
        'rate_used' => $r['transfers'][0]['rate_usd'],
    ]);
    flash("Credited \${$r['usd_total']}.");
} elseif ($r['state'] === 'unreadable') {
    flash('We could not reach the chain just now. Your payment is safe — try again in a minute.');
} elseif ($r['state'] === 'confirming') {
    flash("Payment seen — waiting for confirmations ({$r['confirmations']}/{$r['required']}).");
} else {
    flash('That transaction did not pay us. Check the hash.');
}
```

---

## The bonus is ZERO, and the story of why is worth keeping

`bonusPercent` is **0**. One wPCN credits exactly what one PCN credits, at
`price.pc.am/credit-rate`, because that is what wPCN *is*: a 1:1 claim on PCN in
a public reserve, redeemable 1:1. An asset whose entire proposition is parity
should not be credited at anything other than parity.

**It was 10 until 2026-09-11, and the reasoning was sound while it lasted.** The
flow was one-directional — wrap PCN, sell it on PancakeSwap, and
`pcoin-wpcn-keeper` buys it back out of a small float to defend the peg. A
discount for paying in wPCN was meant to reverse the arrow: to pay a PCoin
service at the best rate you would have to **buy wPCN on PancakeSwap**, which is
a buy the pool has never seen, from someone who is not us.

**It never worked, because our own wrap desk undercut it.** The desk sells wPCN
for a 5% fee, so nobody ever had to buy anything: wrap PCN you already hold, pay
with the wPCN, collect a bonus worth more than the fee. Measured on the day it
was removed, that round trip paid **+9.50%** — and it created exactly zero
demand, because no purchase took place. A demand lever that can be satisfied by
your own machinery is not a lever.

The lesson generalises: **before pricing an incentive, check every route to the
thing you are incentivising, including your own.** If wPCN needs demand, it
needs something that cannot be arbitraged from inside the estate.

---

## What this does not do

* **No per-customer addresses.** See the top of this file.
* **No auto-reversal on reorg.** It refuses to credit a non-canonical block and
  says so. Unwinding something already credited is a human decision.
* **No user balances.** Each project keeps its own. This service owns only the
  claim ledger, which is what stops two projects banking one payment.
* **No key, no custody, no outbound transaction.** Ever.

---

## Rollout status — 2026-09-08

All six PCoin services that accept PCN now hold a verifier token, and every one
of them authenticates: `GET /claims?user_ref=…` returns `{"ok":true,"project":
"<name>","claims":[]}`, while an invalid token returns 401. That 401 is what
makes *accepted* distinguishable from merely *reachable*, and it is the check to
run before believing any report — including one from the project itself.

| service | rail armed? |
|---|---|
| `checker.pc.am` | yes |
| `webbuilderbot` | yes |
| `3dmodels.pc.am` | yes |
| `3dmodel.oonak.ai` | yes |
| `aicontrol.pc.am` | token installed, `enabled` still false |
| `webai.pc.am` | token installed, `enabled` still false |

**`wpcn_payments` is 0 rows everywhere.** Nothing has been paid in wPCN yet, so
the two checks that need a real payment are still owed on every rail: that the
rate lands *stamped on the row* (`credited_rate_usd`), and that submitting the
same hash twice credits exactly once — verified by reading the **balance**, not
the reply message.

### Two things worth carrying forward

**Every one of these rails shipped a `claims()` that could never work**, because
they all vendored the same broken client (fixed in `891bac4`: the PHP copy set
`CURLOPT_POSTFIELDS` unconditionally, which switches curl to POST even when the
body is null and which `CURLOPT_POST => false` does not undo; both copies then
demanded a `state` field that a `/claims` reply does not carry). One mistake,
copied six times — the same shape as the `blocks_unwound` gate that stopped
every PCN rail for three and a half days. **A shared client is a shared bug, and
vendoring means upstream fixes do not reach you either.** The projects that
handled this best added an assertion against *what their copy actually puts on
the wire* — one stood up a loopback HTTP server and checked the request line —
and then proved it fires by restoring the old client and watching it go red.

**It failed safe, which is why nobody saw it.** A broken `claims()` refuses
rather than double-credits, so the rails looked quiet instead of wrong. It would
have surfaced at the worst moment: the heal path that returns a customer's money
after a lost write could never heal, and the token-install probe would have
rejected a perfectly valid token while blaming the token.
