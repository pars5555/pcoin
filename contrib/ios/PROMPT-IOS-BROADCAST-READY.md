# Follow-up for the iOS team — the broadcast blocker is cleared

Send this to whoever is building the iOS wallet. It replaces §1 of
`PROMPT-IOS-WALLET.md`, which told you not to design around a blocker. The
blocker is gone.

---

**`POST https://explorer.pc.am/api/tx` now works. You can send.**

The original brief said no public broadcast path existed and that this was our
problem to fix. It is fixed, as of **2026-09-10**, and it was worse than
described — the endpoint had never worked in any configuration, for a reason
worth knowing because the same shape can bite your code.

## What was wrong

The API refuses to relay through a node whose wallet RPCs answer: a public,
unauthenticated endpoint that can reach a wallet RPC is one misconfigured proxy
away from being able to spend. It proved this by calling `listwallets` and
expecting `-32601 Method not found`, which is what a `-disablewallet` node says.

But Core returns that error under **HTTP 404**, and the RPC client promoted only
HTTP **500** bodies to answers — everything else became a transport error. So
the probe never saw the `-32601` it was looking for. It recorded *"could not
determine whether the broadcast node has a wallet"*, and broadcast refuses on an
unknown answer, which is correct.

The result: a node **with** a wallet was refused for having one, and a node
**without** one was refused for being unreadable. There was no third option.

**That is the §7.2 rule in the brief, biting its own author:** an error was
turned into a definite answer of the wrong kind. "I could not read this" was
recorded where "this node has no wallet" was the fact. Worth re-reading the
rules section with that example in mind — it is not hypothetical advice.

## What exists now

Two nodes behind the API, deliberately:

| | |
|---|---|
| **relay** | a `-disablewallet` node. Holds no keys, cannot hold any. Your transaction goes here. |
| **witness** | a separate node we did *not* submit to, which independently answers "does the network have this". |

## What you get back, and how to read it

The response tells you **whether the network has the transaction**, not merely
whether a node accepted it. Those are different claims, and the difference is
the point: a transaction can enter a local mempool on a node with zero peers and
go nowhere while the client is told "sent".

A real response, from a structurally valid transaction spending an outpoint that
does not exist:

```json
{
  "txid": "08c29bf41abfc03bf80cc969ecec36d4f0b0b0ee87f63a3cd335f36fd90a5483",
  "accepted_by_node": false,
  "error": {
    "code": "rejected",
    "message": "bad-txns-inputs-missingorspent",
    "rpc_code": -25,
    "detail": "This is the node's answer, i.e. a fact about this transaction -- not a transport failure."
  },
  "network": {
    "has_it": false,
    "state": "rejected",
    "peers": 3,
    "detail": "the node did not accept the transaction, so it was never relayed"
  }
}
```

**Read `network.has_it` as three-valued, and never collapse it to a boolean:**

| value | meaning | what the UI should say |
|---|---|---|
| `true` | it crossed the network | sent |
| `false` | a fact — rejected, or the node has zero peers so nobody can have it | not sent, with the reason |
| `null` | **unknown.** Never success, never failure. | "we could not confirm yet" — keep checking, do not tell the user it failed |

`null` is the one that will tempt you into a bug. In Swift, do not model this as
`Bool` with a default. `?? false` here tells a user their payment failed when it
may be confirming.

## Retrying is safe, and you should

The txid is computed from the submitted bytes **before** the node is contacted,
so a lost HTTP response does not lose the transaction. Resubmitting the identical
hex is safe — `sendrawtransaction` on a transaction already in the mempool is not
an error. If a response goes missing, retry the same request rather than
assuming either outcome. A lost response is not a failure (§7.6).

## The rest of the API, all verified live the same day

| endpoint | notes |
|---|---|
| `GET /api/status` | gate on `index.stale == false`, `node_reachable`, `blocks_behind == 0` |
| `GET /api/address/{addr}` | balance, used, history, `mempool`, `unconfirmed_history` |
| `GET /api/address/{addr}/txs` | history |
| `GET /api/address/{addr}/utxos` | **plural** — `/utxo` is a 404 |
| `POST /api/addresses` | gap-limit scan, `{"addresses":[...]}` |
| `GET /api/tx/{txid}` | one transaction |
| `POST /api/tx` | **broadcast — now live**, `{"hex":"..."}` |

There is a broadcast rate limit, separate from the read limit. Do not retry in a
tight loop; back off.

## Still true from the original brief

Everything else stands: BIP39 12 words, `m/84'/9444'/0'`, bech32 `pc1…`, coin
type **9444'** which must never change, the published §6.4 vectors as your
acceptance test before any UI, Keychain + Secure Enclave gating the **key** and
not a screen, the three payment-link behaviours, and no mining.

Nothing about signing changes. The device signs; we relay. The API holds no key,
has no wallet, and now provably cannot reach one.
