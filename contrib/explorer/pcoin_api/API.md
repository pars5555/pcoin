# PCoin explorer — JSON API

A read-only HTTP interface over the index built by `pcoin_indexer`, plus exactly
one state-changing endpoint: `POST /api/tx`, which relays an already-signed
transaction.

Every example below is a **real response**, captured by running this API against
a synced PCoin mainnet node (`bitcoind` v29.4, datadir `/root/pcoin-verify`) at
height **2133** on 2026-08-04. Long arrays are trimmed and the cut is marked
`… trimmed …`; nothing else is edited. Where a response looks surprising — the
fee floor being 0.1 sat/vB, broadcast being refused — that is what the node
actually said.

---

## Contents

- [Running it](#running-it)
- [Conventions](#conventions) — the `index` block, amounts, unknowns
- `GET /api/status` — [chain tip, index height, how far behind](#get-apistatus)
- `GET /api/tip` — [just the tip](#get-apitip)
- `GET /api/blocks` — [recent blocks](#get-apiblocks)
- `GET /api/block/{height|hash}` — [one block](#get-apiblockheighthash)
- `GET /api/block/{height|hash}/txs` — [its transactions in full](#get-apiblockheighthashtxs)
- `GET /api/tx/{txid}` — [one transaction in full detail](#get-apitxtxid)
- `POST /api/tx` — [broadcast a signed transaction](#post-apitx)
- `GET /api/address/{address}` — [balances](#get-apiaddressaddress)
- `GET /api/address/{address}/txs` — [paginated history](#get-apiaddressaddresstxs)
- `GET /api/address/{address}/utxos` — [outputs to spend](#get-apiaddressaddressutxos)
- `POST /api/addresses` — [many addresses in one request](#post-apiaddresses)
- `GET /api/addresses/top` — [richest addresses](#get-apiaddressestop)
- `GET /api/fees` — [the fee floor, and what to actually pay](#get-apifees)
- `GET /api/mempool` — [unconfirmed transactions](#get-apimempool)
- `GET /api/search` — [one box, four answer shapes](#get-apisearch)
- [Errors](#errors) · [Rate limits](#rate-limits) · [Deployment](#deployment)

---

## Running it

```bash
# 1. build the index (separate process, the single writer)
python3 -m pcoin_indexer --datadir ~/.pcoin --chain main sync --daemon --interval 30

# 2. serve it
python3 -m pcoin_api serve --db pcoin-index.sqlite --datadir ~/.pcoin --chain main \
                           --host 127.0.0.1 --port 8080
```

Stdlib only — no build step, no package manager, no dependencies to keep
patched. `python3 -m pcoin_api check` prints the startup gate and exits, which is
the fastest way to find out why broadcast is refusing to come up.

**It is non-custodial, structurally.** Nothing in this package derives an
address, generates a key, stores a key or signs anything. Clients derive their
own addresses from their own twelve words (BIP84, `m/84'/9444'/0'/0/i`) and this
API answers questions about the chain and relays signed bytes. A request body
containing a field named `mnemonic`, `seed`, `privkey`, `private_key`, `wif` or
`xprv` is refused with a `400 refused` before anything else happens.

**Do not run it on the seed host.** `seed.pc.am` is the only DNS seed and
`vFixedSeeds` is empty: if that box gets loaded off the network, nobody new can
bootstrap PCoin.

---

## Conventions

### Every response carries the index height

Every payload starts with an `index` block. A balance without a height is
unfalsifiable — the client cannot tell "you have 0" from "I stopped indexing
three days ago".

| field | meaning |
|---|---|
| `indexed_height` / `indexed_hash` | the tip of the index itself |
| `node_height` / `blocks_behind` | the **indexer's** last observation of the node, and its own arithmetic |
| `node_height_now` / `blocks_behind_now` | **this process's** live observation, seconds old |
| `last_poll_age_seconds` | how long since the indexer last reached the node |
| `stale` / `stale_reasons` | the index's own verdict on whether it may be trusted |

`blocks_behind` and `blocks_behind_now` are two measurements by two processes and
neither overwrites the other. A stalled indexer shows up as `blocks_behind: 0`
(it has not polled, so it does not know it is behind) together with a growing
`blocks_behind_now` and a growing `last_poll_age_seconds`. **A client that renders
a balance without checking `index.stale` is the failure mode this block exists to
prevent.**

### Amounts are integers and strings, never floats

Every amount appears twice: `..._sat` is an exact integer number of satoshis and
is what you do arithmetic on; `..._pcn` is a fixed-point string for display. No
money-adjacent value in any response is a JSON float, including fee rates, which
are strings like `"1.000"` sat/vB alongside an exact integer `sat_per_kvb`.
106250.00000001 does not survive a round trip through an IEEE double.

### Confirmed, immature and unconfirmed are never merged

Three different claims about three different things:

```
confirmed.mature_sat          money in a block that consensus allows spending
confirmed.immature_sat        coinbase output, not spendable for another N blocks
confirmed.pending_spend_sat   confirmed coin an unconfirmed transaction is consuming
confirmed.spendable_sat       = mature - pending_spend   (what you may build from now)
confirmed.onchain_unspent_sat = mature + immature        (NOT spendable)
unconfirmed.receiving_sat     money in the mempool, in no block at all
```

On PCoin this is not pedantry: 2 134 of 2 144 transactions on the chain today are
coinbases, `COINBASE_MATURITY` is 100 blocks, and blocks currently arrive about
every 19 minutes — so an address's "balance" is mostly money it cannot spend for
another day and a half. Maturity is always reported **in blocks**
(`next_maturity_in_blocks`), never as an ETA: block spacing here is neither the
600 s target nor stable, and it changes again when LWMA activates at height 2800.

### Unknown is its own state

If the mempool has not been observed, the answer is not zero:

```json
"unconfirmed": {"known": false, "reason": "cannot reach http://127.0.0.1:9443/: …"},
"confirmed":   {"spendable_sat": null, "pending_spend_sat": null,
                "spendable_unknown_reason": "…"}
```

`null` and `false` mean different things throughout, and `used` on the
multi-address endpoint can be `true`, `false` **or `null`** — because a `false`
that should have been "I do not know" silently truncates a gap-limit scan and
loses somebody's wallet.

### Read consistency

Every request runs its reads inside one SQLite read transaction, so a response
cannot mix a balance computed at tip *T* with a maturity cut-off computed at
tip *T+1* — which is exactly what a reorg landing mid-request would otherwise do.
Every connection is opened `mode=ro`; the only endpoint that changes anything is
`POST /api/tx`, and it does not touch this database at all.

---

## `GET /api/status`

Chain tip, index height, how far behind the index is, the node this process can
see, the mempool, and whether broadcast is available and if not why.

```bash
curl -s http://127.0.0.1:8080/api/status
```

```json
{
  "index": {
    "chain": "main", "status": "ok", "status_detail": null,
    "indexed_height": 2133,
    "indexed_hash": "543c5f2b07c29e0aa5466591a071778c0df1bac1fa859d1616e97a64127098a7",
    "node_height": 2133, "node_headers": 2133,
    "blocks_behind": 0, "last_poll_age_seconds": 29,
    "reorg_count": 0, "blocks_unwound": 0,
    "stale": false, "stale_reasons": [],
    "indexed_time": 1785835247, "indexed_time_iso": "2026-08-04T09:20:47Z",
    "node_height_now": 2133, "node_observed_seconds_ago": 0.003,
    "node_reachable": true, "blocks_behind_now": 0
  },
  "chain": {
    "height": 2133,
    "best_hash": "543c5f2b07c29e0aa5466591a071778c0df1bac1fa859d1616e97a64127098a7",
    "block_time": 1785835247, "block_time_iso": "2026-08-04T09:20:47Z",
    "difficulty": 0.0003401078181484832,
    "tx_count": 2144, "coinbase_count": 2134, "non_coinbase_count": 10,
    "utxo_count": 142, "addresses_with_balance": 15,
    "supply_sat": 10665000000000, "supply_pcn": "106650.00000000"
  },
  "node": {
    "observed": true, "reachable": true, "error": null,
    "observed_seconds_ago": 0.003, "chain": "main",
    "blocks": 2133, "headers": 2133, "initial_block_download": false,
    "connections": {"total": 1, "in": 0, "out": 1}
  },
  "mempool": {"known": true, "node_reachable": true,
              "observed_seconds_ago": 0.003, "tx_count": 0},
  "broadcast": {
    "enabled": false,
    "reasons": ["the broadcast node has wallet RPCs enabled (listwallets succeeded and returned 4 loaded wallet(s)); this API refuses to relay through a node that can spend. Run it with -disablewallet, or pass --allow-wallet-node to accept the risk explicitly."],
    "checks": {
      "configured": true,
      "wallet_probe": {"known": true, "wallet_rpcs_present": true,
                       "detail": "listwallets succeeded and returned 4 loaded wallet(s)",
                       "loaded_wallets": 4},
      "node_reachable": true,
      "index_genesis": "a95d51f0cbf25cad10c35961c6189356525d079835f02e83e2395f382fbe264a",
      "node_genesis":  "a95d51f0cbf25cad10c35961c6189356525d079835f02e83e2395f382fbe264a",
      "witness_node": false
    },
    "wait_seconds": 8.0, "sent_this_process": 0
  },
  "server": {"api_version": "1.0.0", "uptime_seconds": 0.1, "custodial": false,
             "note": "This API never derives an address, holds a key or signs anything. …"}
}
```

That `broadcast.enabled: false` is the real answer for this particular node —
`/root/pcoin-verify` has four wallets loaded, so the API refused it. See
[`POST /api/tx`](#post-apitx).

`chain.supply_sat` is directly comparable with the node's own
`gettxoutsetinfo.total_amount`, which is how the index is cross-checked.

---

## `GET /api/tip`

The tip block on its own, for a cheap poll.

```bash
curl -s http://127.0.0.1:8080/api/tip
```

```json
{
  "index": {"indexed_height": 2133, "…": "as above"},
  "tip": {
    "height": 2133,
    "hash": "543c5f2b07c29e0aa5466591a071778c0df1bac1fa859d1616e97a64127098a7",
    "prev_hash": "584d4e06000bda09bc7f7e6d2eb2410d5d901dd2fc39b72995fc9501bce2d2ec",
    "merkleroot": "2473b6569edffe046589d4ddfaaedbad794446ed876bd23d9318fd7e06ba7e22",
    "version": 536870912, "nonce": 4392, "bits": "1e0b7c33",
    "difficulty": 0.0003401078181484832,
    "chainwork": "000000000000000000000000000000000000000000000000000000000ac42d84",
    "time": 1785835247, "time_iso": "2026-08-04T09:20:47Z",
    "mediantime": 1785834171, "mediantime_iso": "2026-08-04T09:02:51Z",
    "size": 250, "strippedsize": 214, "weight": 892, "n_tx": 1,
    "value_out_sat": 5000000000, "value_out_pcn": "50.00000000",
    "total_fees_sat": 0, "total_fees_pcn": "0.00000000",
    "subsidy_sat": 5000000000, "subsidy_pcn": "50.00000000",
    "coinbase_out_sat": 5000000000, "coinbase_out_pcn": "50.00000000"
  }
}
```

> **Do not sort blocks by `time`.** Block timestamps on PCoin are not monotonic
> in height — consensus only requires `timestamp > MTP` — so "time since the last
> block" can legitimately come out negative. `mediantime` is monotonic; height is
> the only ordering that always means what you think.

---

## `GET /api/blocks`

Recent blocks, newest first. `?limit=` (1–200, default 25) and
`?before_height=` for paging backwards; the response carries
`next_before_height`.

```bash
curl -s 'http://127.0.0.1:8080/api/blocks?limit=2'
```

```json
{
  "index": {"indexed_height": 2133, "…": "…"},
  "blocks": [
    {"height": 2133,
     "hash": "543c5f2b07c29e0aa5466591a071778c0df1bac1fa859d1616e97a64127098a7",
     "prev_hash": "584d4e06000bda09bc7f7e6d2eb2410d5d901dd2fc39b72995fc9501bce2d2ec",
     "time": 1785835247, "time_iso": "2026-08-04T09:20:47Z",
     "mediantime": 1785834171, "mediantime_iso": "2026-08-04T09:02:51Z",
     "n_tx": 1, "size": 250, "weight": 892, "bits": "1e0b7c33",
     "difficulty": 0.0003401078181484832, "confirmations": 1,
     "value_out_sat": 5000000000, "value_out_pcn": "50.00000000",
     "total_fees_sat": 0, "total_fees_pcn": "0.00000000",
     "subsidy_sat": 5000000000, "subsidy_pcn": "50.00000000"},
    {"height": 2132,
     "hash": "584d4e06000bda09bc7f7e6d2eb2410d5d901dd2fc39b72995fc9501bce2d2ec",
     "time": 1785834630, "time_iso": "2026-08-04T09:10:30Z",
     "n_tx": 1, "confirmations": 2, "…": "…"}
  ],
  "count": 2, "tip_height": 2133, "next_before_height": 2132
}
```

`prev_hash` is included on every entry so a client can verify the chain links
without a second request — useful precisely because this chain reorgs.

---

## `GET /api/block/{height|hash}`

Either identifier works. `?limit=` / `?offset=` page the `txids` array.

```bash
curl -s 'http://127.0.0.1:8080/api/block/2125?limit=5'
```

```json
{
  "index": {"indexed_height": 2133, "…": "…"},
  "block": {
    "height": 2125,
    "hash": "b954029d8add3a44f7abcde82fda351df9694983580a4d726b3c9b1929222d17",
    "prev_hash": "d22729b3e2fb5519a96a0a19cf566f67aa1bef9a6344c5faeffd6a76f47f5fd3",
    "merkleroot": "2200ef8031d2aef93a79510ec85e1db20ff28926c7f77754d086d2d0e45fc19a",
    "version": 536870912, "nonce": 7227, "bits": "1e0b7c33",
    "difficulty": 0.0003401078181484832,
    "chainwork": "000000000000000000000000000000000000000000000000000000000a11dc54",
    "time": 1785831740, "time_iso": "2026-08-04T08:22:20Z",
    "mediantime": 1785822428, "mediantime_iso": "2026-08-04T05:47:08Z",
    "size": 288717, "strippedsize": 80252, "weight": 529473, "n_tx": 5,
    "confirmations": 9, "orphaned": false,
    "next_hash": "9e67fdad161ae562d0924451deb21f0aed3a1078ca6cd4985c77cb090a17593a",
    "value_out_sat": 9979999995960, "value_out_pcn": "99799.99995960",
    "total_fees_sat": 132151,      "total_fees_pcn": "0.00132151",
    "subsidy_sat": 5000000000,     "subsidy_pcn": "50.00000000",
    "coinbase_out_sat": 5000132151, "coinbase_out_pcn": "50.00132151",
    "txids": [
      "2c80a76bf4a9d480d240d2436e61d445c3e9837419d9bb66bb848f0d56fc6b6f",
      "ba0705f4fda56fff4ac200ffb3cb62cf87cc90d92f691e90ec6343d1a543ff86",
      "f7f0edaf726e7c1eccf487b682128f5e0842af2c206acb794003bde332c585a3",
      "eb41544ca75207c61db45e67a0281a5cce7cec3c20122de2733d404f278e306e",
      "19231bfb85c98afe4bd367cad763296c5f39bbecd4dbb17b9768261e6169ee9c"
    ],
    "tx_count": 5,
    "tx_page": {"limit": 5, "offset": 0, "has_more": false}
  }
}
```

`coinbase_out_sat` is what the coinbase actually claimed and `subsidy_sat +
total_fees_sat` is what consensus allowed; `pcoin-index verify` flags any block
where the first exceeds the second.

**A block that lost a reorg is an answer, not a 404.** The index keeps every
block it ever held and later unwound, so asking for one by hash returns:

```json
{"index": {"…": "…"},
 "block": {"hash": "…", "height": 2101, "prev_hash": "…",
           "time": 1785700000, "time_iso": "2026-08-01T…Z",
           "n_tx": 1, "unwound_ts": 1785835100,
           "unwound_at_iso": "2026-08-04T09:18:20Z", "orphaned": true}}
```

"I saw that block and it lost a reorg" is a different fact from "I have never
heard of it", and on a chain with ~66 chain tips it is a fact clients meet.

---

## `GET /api/block/{height|hash}/txs`

Every transaction in a block, in full (same shape as `GET /api/tx/{txid}`).
`?limit=` 1–50, default 25.

```bash
curl -s 'http://127.0.0.1:8080/api/block/2125/txs?limit=1&offset=1'
```

```json
{
  "index": {"…": "…"},
  "height": 2125,
  "block_hash": "b954029d8add3a44f7abcde82fda351df9694983580a4d726b3c9b1929222d17",
  "txs": [{"txid": "eb41544ca75207c61db45e67a0281a5cce7cec3c20122de2733d404f278e306e",
           "… same shape as GET /api/tx …": "…"}],
  "tx_count": 5, "limit": 1, "offset": 1, "has_more": true
}
```

---

## `GET /api/tx/{txid}`

Everything about one transaction, including **each input's source address and
amount** — the thing a node cannot tell you without undo data, and the reason
this index exists.

```bash
curl -s http://127.0.0.1:8080/api/tx/19231bfb85c98afe4bd367cad763296c5f39bbecd4dbb17b9768261e6169ee9c
```

```json
{
  "index": {"indexed_height": 2133, "…": "…"},
  "mempool": {"known": true, "tx_count": 0, "…": "…"},
  "tx": {
    "txid": "19231bfb85c98afe4bd367cad763296c5f39bbecd4dbb17b9768261e6169ee9c",
    "wtxid": "b581bcbe4aaf897f995f0eb7d0e2d40ba4330d83257ea4bfd704009978af64cd",
    "status": "confirmed",
    "height": 2125, "block_index": 4,
    "block_hash": "b954029d8add3a44f7abcde82fda351df9694983580a4d726b3c9b1929222d17",
    "block_time": 1785831740, "block_time_iso": "2026-08-04T08:22:20Z",
    "mediantime_iso": "2026-08-04T05:47:08Z",
    "confirmations": 9,
    "version": 2, "locktime": 2124,
    "size": 1226, "vsize": 584, "weight": 2333,
    "is_coinbase": false, "n_in": 8, "n_out": 1,
    "value_in_sat": 274999995960,  "value_in_pcn": "2749.99995960",
    "value_out_sat": 274999995376, "value_out_pcn": "2749.99995376",
    "fee_sat": 584, "fee_pcn": "0.00000584",
    "fee_rate_sat_per_vb": "1.000",
    "inputs": [
      {"n": 0,
       "prev_txid": "f46d56b44f568b8e41bf9cc1e335c4384522d5425fd0dc1fc797d6e2207b011b",
       "prev_n": 0,
       "address": "pc1qexampleaddresscccccccccccccccccccc6789",
       "script_type": "witness_v0_keyhash",
       "sequence": 4294967293, "coinbase_hex": null,
       "value_sat": 5000000000, "value_pcn": "50.00000000"},
      "… 7 more inputs trimmed …"
    ],
    "outputs": [
      {"n": 0,
       "address": "pc1qexampleaddressaaaaaaaaaaaaaaaaaaaaqqqq",
       "script_type": "witness_v0_keyhash",
       "script_hex": "0014fb1dab18eeb60474e82f6ead0733454c9718ffef",
       "is_coinbase": false, "maturity_height": null, "unspendable": false,
       "spent": false, "spent_by_txid": null, "spent_by_n": null,
       "spent_height": null, "mature": true,
       "value_sat": 274999995376, "value_pcn": "2749.99995376"}
    ]
  }
}
```

That transaction paid **584 satoshis for 584 vbytes — exactly 1.000 sat/vB**,
which is `fallbackfee=0.00001` doing its job. See [`GET /api/fees`](#get-apifees).

A **coinbase** additionally carries `matures_at_height`, `mature` and
`maturity_in_blocks`. An **unconfirmed** transaction is served from the mempool
with `"status": "unconfirmed"`, `"confirmations": 0`, `"height": null` and an
`unbroadcast` flag.

**A 404 says how confident it is.** If the index is current the answer is
conclusive; if it is stale, it says so rather than implying the transaction does
not exist:

```json
{"error": {"code": "not_found",
           "message": "no transaction ab…ab in the index or the observed mempool",
           "conclusive": false, "index_height": 2133,
           "detail": "The index is stale, so this is not a conclusive answer."}}
```

---

## `POST /api/tx`

**The only state-changing endpoint.** It relays an already-signed transaction.
It holds no key, and it will not run against a node that has a wallet.

```bash
curl -s -X POST http://127.0.0.1:8080/api/tx \
     -H 'Content-Type: application/json' \
     -d '{"hex": "02000000000101aaaa…00000000"}'
```

A bare `text/plain` body containing just the hex works too.

### What it reports, and why

`sendrawtransaction` returning a txid means **the local node accepted it**. It
does *not* mean the network has it: a transaction can enter a local mempool on a
node with zero peers and go nowhere while the user is told "sent". So the answer
separates the two claims:

| `network.state` | `network.has_it` | meaning |
|---|---|---|
| `observed_by_witness_node` | `true` | a second, independent node has it in its mempool. Proof it crossed the network. |
| `already_in_a_block` | `true` | the node answered −27: it is already in the chain. |
| `confirmed_in_block` | `true` | it left the mempool and we found it in a block. |
| `acknowledged_by_peer` | `true` | a peer sent a GETDATA and the node pushed the transaction to it. |
| `no_peers` | `false` | the node has zero peers, so nobody can have received it. A fact, not an unknown. |
| `awaiting_peer_acknowledgement` | `null` | accepted locally; no peer has asked for it yet. **Unknown.** |
| `left_mempool_unexplained` | `null` | gone from the mempool and not demonstrably mined. |
| `rejected` | `false` | the node refused it (HTTP 400, with the node's own message). |

`acknowledged_by_peer` is not a guess. Core keeps a locally-submitted transaction
in an *unbroadcast set* until a peer requests it over the wire and it is sent
(`src/net_processing.cpp:2382`, exposed as `getmempoolentry().unbroadcast`,
`src/rpc/mempool.cpp:341`). `unbroadcast: false` therefore means *at least one
other node asked for this transaction and received it*.

**HTTP status carries the same distinction**, so even a client that reads only
the status code learns it: **200** when the network demonstrably has it, **202**
when it is accepted locally and the network's state is not established.

The API waits up to `--broadcast-wait` seconds (default 8, override per request
with `?wait=`) for a positive signal, returning as soon as it gets one.

Configure `--witness-rpc-url` pointing at a **second, independent** node for the
strongest signal available.

### Success

```json
{
  "txid": "0299f611edd55fcd0344ef51c5a2735ee2b0f451fc3e6f066e10986dcabf903c",
  "accepted_by_node": true,
  "already_in_chain": false,
  "network": {
    "has_it": true,
    "state": "acknowledged_by_peer",
    "peers": 8,
    "waited_seconds": 0.51,
    "checks": {"unbroadcast": false},
    "detail": "a peer requested this transaction and the node sent it (Core cleared it from the unbroadcast set), so at least one other node has it"
  },
  "tx": {"size": 234, "vsize": 153, "weight": 609, "version": 2, "locktime": 0,
         "input_count": 1, "output_count": 2, "has_witness": true,
         "wtxid": "68246cad25d4d36310cfceac7ed4481df9c46973f62522ac9e418a797b5c4629"},
  "next": "/api/tx/0299f611edd55fcd0344ef51c5a2735ee2b0f451fc3e6f066e10986dcabf903c"
}
```

### Accepted, but nobody has asked for it yet — **HTTP 202**

```json
{
  "txid": "0299f611…903c", "accepted_by_node": true, "already_in_chain": false,
  "network": {
    "has_it": null, "state": "awaiting_peer_acknowledgement",
    "peers": 8, "waited_seconds": 8.0, "checks": {"unbroadcast": true},
    "detail": "The node has the transaction and is offering it to peers, but no peer had requested it within 8.0s. Core announces on a randomised delay, so this is not evidence of a problem -- it is simply not yet established that the network has it. Poll GET /api/tx/<txid>."
  },
  "next": "/api/tx/0299f611…903c"
}
```

### No peers — **HTTP 202**, and a definite "no"

```json
{
  "txid": "0299f611…903c", "accepted_by_node": true,
  "network": {
    "has_it": false, "state": "no_peers", "peers": 0,
    "detail": "the broadcast node has zero peers, so nothing on the network has received this transaction. It is in the local mempool and will be re-offered when the node connects to a peer."
  }
}
```

### Rejected by the node — **HTTP 400**

```json
{
  "txid": "0299f611…903c",
  "accepted_by_node": false,
  "error": {"code": "rejected", "rpc_code": -26,
            "message": "min relay fee not met, 100 < 141",
            "detail": "This is the node's answer, i.e. a fact about this transaction -- not a transport failure."},
  "network": {"has_it": false, "state": "rejected", "peers": 8,
              "detail": "the node did not accept the transaction, so it was never relayed"},
  "tx": {"vsize": 153, "input_count": 1, "output_count": 2}
}
```

### The response was lost — **HTTP 502**, and *not* a rejection

The txid is computed locally from the submitted bytes *before* the node is
contacted, so a lost response does not leave the client guessing. The API asks
the node whether it has that exact transaction; if it does, the broadcast is
reported as successful with a `note`. If that check cannot settle it either:

```json
{
  "txid": "0299f611…903c",
  "accepted_by_node": null,
  "error": {
    "code": "broadcast_outcome_unknown",
    "message": "the node did not answer (cannot reach http://127.0.0.1:9443/: …) and a follow-up check could not confirm the transaction either way (could not reach the node: …). This is NOT a rejection: re-sending the identical hex is safe and idempotent."
  },
  "network": {"has_it": null, "state": "unknown", "peers": 1},
  "retry": {"safe": true, "how": "POST the identical hex again"}
}
```

`accepted_by_node: null` is a third value and means exactly what it says.
CLAUDE.md §7.2: a `getrawtransaction` failure read as "0 confirmations" is what
turns an unanswerable question into a definite "not confirmed", which in a send
path authorises spending the same coins twice.

### Broadcast refused — **HTTP 503**

This is the **real** response from the API pointed at `/root/pcoin-verify`:

```json
{
  "error": {
    "code": "broadcast_unavailable",
    "message": "the broadcast node has wallet RPCs enabled (listwallets succeeded and returned 4 loaded wallet(s)); this API refuses to relay through a node that can spend. Run it with -disablewallet, or pass --allow-wallet-node to accept the risk explicitly.",
    "checks": {
      "configured": true,
      "wallet_probe": {"known": true, "wallet_rpcs_present": true,
                       "detail": "listwallets succeeded and returned 4 loaded wallet(s)",
                       "loaded_wallets": 4},
      "node_reachable": true,
      "index_genesis": "a95d51f0cbf25cad10c35961c6189356525d079835f02e83e2395f382fbe264a",
      "node_genesis":  "a95d51f0cbf25cad10c35961c6189356525d079835f02e83e2395f382fbe264a",
      "witness_node": false
    }
  }
}
```

The wallet check is a probe, not an assumption: a `-disablewallet` node does not
register any wallet RPC, so `listwallets` comes back `-32601 Method not found`.
Anything else — a list of wallets, or `-18 No wallet is loaded` — means wallet
support is live on that node and broadcast is refused. Broadcast is also refused
when the node serves a different genesis than the index was built on, when the
node has never been reached, and when `--no-broadcast` is set. All of these are
visible in `/api/status` **before** a user tries to send.

### Other refusals

| status | code | when |
|---|---|---|
| 400 | `invalid_transaction` | not hex, odd length, truncated, trailing bytes, no outputs, a coinbase |
| 400 | `refused` | the body contained a field named `mnemonic`, `seed`, `privkey`, `private_key`, `wif` or `xprv` |
| 413 | `payload_too_large` | body over 1 000 000 bytes |
| 429 | `rate_limited` | see [rate limits](#rate-limits) |
| 500 | `txid_mismatch` | the node returned a different txid than the submitted bytes hash to |

---

## `GET /api/address/{address}`

```bash
curl -s 'http://127.0.0.1:8080/api/address/pc1qexampleaddressaaaaaaaaaaaaaaaaaaaaqqqq?history=2'
```

```json
{
  "index": {"indexed_height": 2133, "stale": false, "…": "…"},
  "mempool": {"known": true, "node_reachable": true,
              "observed_seconds_ago": 0.004, "tx_count": 0},
  "address": "pc1qexampleaddressaaaaaaaaaaaaaaaaaaaaqqqq",
  "used": true,
  "balance": {
    "confirmed": {
      "mature_sat": 9974999863809,          "mature_pcn": "99749.99863809",
      "mature_utxo_count": 4,
      "immature_sat": 0,                    "immature_pcn": "0.00000000",
      "immature_utxo_count": 0,
      "pending_spend_sat": 0,               "pending_spend_pcn": "0.00000000",
      "pending_spend_utxo_count": 0,
      "spendable_sat": 9974999863809,       "spendable_pcn": "99749.99863809",
      "spendable_utxo_count": 4,
      "onchain_unspent_sat": 9974999863809, "onchain_unspent_pcn": "99749.99863809",
      "utxo_count": 4,
      "as_of_height": 2133, "maturity_blocks": 100
    },
    "unconfirmed": {
      "known": true, "fresh": true, "as_of_seconds_ago": 0.004,
      "tx_count": 0, "txids": [], "utxo_count": 0,
      "receiving_sat": 0, "receiving_pcn": "0.00000000",
      "spending_sat": 0,  "spending_pcn": "0.00000000"
    },
    "lifetime": {
      "tx_count": 8, "first_height": 2079, "last_height": 2125,
      "received_sat": 10214999860014, "received_pcn": "102149.99860014",
      "sent_sat": 239999996205,       "sent_pcn": "2399.99996205"
    }
  },
  "history": {"items": ["… see /txs …"], "total": 8, "limit": 2, "has_more": true}
}
```

A **miner's** address shows the split this endpoint exists for. Real response for
`pc1qexampleaddresszzzzzzzzzzzzzzzzzzzz2345` at height 2133:

```json
"confirmed": {
  "mature_sat":   25000000000,  "mature_pcn":   "250.00000000",
  "mature_utxo_count": 5,
  "immature_sat": 165000132396, "immature_pcn": "1650.00132396",
  "immature_utxo_count": 33,
  "pending_spend_sat": 0, "pending_spend_utxo_count": 0,
  "spendable_sat": 25000000000, "spendable_pcn": "250.00000000",
  "spendable_utxo_count": 5,
  "onchain_unspent_sat": 190000132396, "onchain_unspent_pcn": "1900.00132396",
  "utxo_count": 38,
  "as_of_height": 2133, "maturity_blocks": 100,
  "next_maturity_height": 2140, "next_maturity_in_blocks": 6
}
```

**87% of that "balance" cannot be spent.** An explorer showing one number would be
wrong about this address by 1 650 PCN, and a wallet that tried to build a
transaction from it would produce something every node rejects.

When the mempool cannot be observed:

```json
"confirmed": {"mature_sat": 3000000000, "spendable_sat": null,
              "pending_spend_sat": null,
              "spendable_unknown_reason": "cannot reach http://127.0.0.1:9443/: …"},
"unconfirmed": {"known": false, "reason": "cannot reach http://127.0.0.1:9443/: …"}
```

An address with no history is a valid answer, not a 404: zeros, and
`"used": false`.

---

## `GET /api/address/{address}/txs`

Paginated history, newest first. `?limit=` 1–200 (default 25), plus either
`?offset=` or `?cursor=`.

Unconfirmed transactions are a **separate array** and are never mixed into the
paged confirmed list — merging them would make page 2 shift every time the
mempool changed.

```bash
curl -s 'http://127.0.0.1:8080/api/address/pc1qexampleaddressaaaaaaaaaaaaaaaaaaaaqqqq/txs?limit=2'
```

```json
{
  "index": {"indexed_height": 2133, "…": "…"},
  "mempool": {"known": true, "tx_count": 0, "…": "…"},
  "address": "pc1qexampleaddressaaaaaaaaaaaaaaaaaaaaqqqq",
  "unconfirmed": {"known": true, "items": [], "count": 0},
  "confirmed": {
    "items": [
      {"txid": "19231bfb85c98afe4bd367cad763296c5f39bbecd4dbb17b9768261e6169ee9c",
       "height": 2125, "block_index": 4,
       "block_hash": "b954029d8add3a44f7abcde82fda351df9694983580a4d726b3c9b1929222d17",
       "time": 1785831740, "time_iso": "2026-08-04T08:22:20Z",
       "confirmations": 9, "n_in": 0, "n_out": 1,
       "received_sat": 274999995376, "received_pcn": "2749.99995376",
       "sent_sat": 0, "sent_pcn": "0.00000000",
       "net_sat": 274999995376, "net_pcn": "2749.99995376"},
      {"txid": "eb41544ca75207c61db45e67a0281a5cce7cec3c20122de2733d404f278e306e",
       "height": 2125, "block_index": 3, "confirmations": 9,
       "received_sat": 3404999953818, "received_pcn": "34049.99953818",
       "net_sat": 3404999953818, "…": "…"}
    ],
    "total": 8, "limit": 2, "offset": 0, "has_more": true,
    "next_cursor": "2125:3"
  }
}
```

**Prefer `cursor` over `offset`.** Feed `next_cursor` straight back as
`?cursor=2125:3`. An offset shifts under you when the chain extends or reorgs
between two pages; a key does not, and this chain reorgs routinely.

---

## `GET /api/address/{address}/utxos`

Outputs to build a transaction from. **The default is the safe set**: mature,
and not already being spent by something in the mempool.

| parameter | default | effect |
|---|---|---|
| `include_immature=1` | off | also return coinbase outputs that consensus will not let you spend yet |
| `include_pending_spend=1` | off | also return outputs an unconfirmed transaction is already consuming |
| `include_unconfirmed=1` | off | also return outputs created by mempool transactions (`"status": "unconfirmed"`) |
| `require_mempool=1` | off | **503 instead of a warning** if the mempool could not be observed |
| `limit` / `offset` | 1000 / 0 | limit is capped at 2000 |

```bash
curl -s 'http://127.0.0.1:8080/api/address/pc1qexampleaddressaaaaaaaaaaaaaaaaaaaaqqqq/utxos?limit=2'
```

```json
{
  "index": {"indexed_height": 2133, "…": "…"},
  "mempool": {"known": true, "tx_count": 0, "…": "…"},
  "address": "pc1qexampleaddressaaaaaaaaaaaaaaaaaaaaqqqq",
  "utxos": [
    {"txid": "19231bfb85c98afe4bd367cad763296c5f39bbecd4dbb17b9768261e6169ee9c",
     "vout": 0, "height": 2125,
     "block_hash": "b954029d8add3a44f7abcde82fda351df9694983580a4d726b3c9b1929222d17",
     "block_time": 1785831740, "block_time_iso": "2026-08-04T08:22:20Z",
     "confirmations": 9,
     "is_coinbase": false, "maturity_height": null, "mature": true,
     "spent_in_mempool": false, "spendable": true, "status": "confirmed",
     "script_hex": "0014fb1dab18eeb60474e82f6ead0733454c9718ffef",
     "script_type": "witness_v0_keyhash",
     "value_sat": 274999995376, "value_pcn": "2749.99995376"},
    {"txid": "ba0705f4fda56fff4ac200ffb3cb62cf87cc90d92f691e90ec6343d1a543ff86",
     "vout": 0, "value_sat": 3139999957409, "value_pcn": "31399.99957409",
     "spendable": true, "…": "…"}
  ],
  "count": 2, "total": 4, "limit": 2, "offset": 0, "has_more": true,
  "as_of_height": 2133,
  "summary": {
    "mempool_filtered": true,
    "mature_sat": 9974999863809, "mature_count": 4,
    "immature_sat": 0, "immature_count": 0,
    "pending_spend_sat": 0, "pending_spend_count": 0,
    "spendable_sat": 9974999863809, "spendable_count": 4
  },
  "filters": {"include_immature": false, "include_pending_spend": false,
              "include_unconfirmed": false},
  "warnings": []
}
```

`summary` always describes **all** the address's unspent outputs, regardless of
which of them the `filters` let through, so a client can see what it is not
being shown.

When the mempool cannot be observed, the list is still returned but the API says
plainly that it might be dangerous:

```json
"summary": {"mempool_filtered": false,
            "mature_sat": 3000000000, "mature_count": 1,
            "pending_spend_sat": null, "pending_spend_count": null,
            "spendable_sat": null, "spendable_count": null},
"warnings": ["The mempool could not be observed (cannot reach http://127.0.0.1:9443/: …). This list may contain outputs an unconfirmed transaction is already spending; building a transaction from it risks a double-spend of your own coins. Pass require_mempool=1 to get a 503 instead."]
```

and each UTXO carries `"spendable": null`, `"spent_in_mempool": null` — not
`false`. A wallet building a send should pass `require_mempool=1`.

---

## `POST /api/addresses`

Many addresses in **one** request. This is the gap-limit scan: a wallet derives
`m/84'/9444'/0'/0/0…19` (and the change chain) locally and asks once which of
them have been used.

```bash
curl -s -X POST http://127.0.0.1:8080/api/addresses \
     -H 'Content-Type: application/json' \
     -d '{"addresses": ["pc1qexampleaddressaaaaaaaaaaaaaaaaaaaaqqqq",
                        "pc1qnosuchaddresseverusedatall000000000000"]}'
```

```json
{
  "index": {"indexed_height": 2133, "…": "…"},
  "mempool": {"known": true, "tx_count": 0, "…": "…"},
  "addresses": [
    {"address": "pc1qexampleaddressaaaaaaaaaaaaaaaaaaaaqqqq",
     "used": true,
     "balance": {"confirmed": {"mature_sat": 9974999863809,
                               "immature_sat": 0,
                               "spendable_sat": 9974999863809,
                               "onchain_unspent_sat": 9974999863809,
                               "as_of_height": 2133, "…": "…"},
                 "unconfirmed": {"known": true, "tx_count": 0, "…": "…"},
                 "lifetime": {"tx_count": 8, "first_height": 2079,
                              "last_height": 2125, "…": "…"}}},
    {"address": "pc1qnosuchaddresseverusedatall000000000000",
     "used": false,
     "balance": {"confirmed": {"mature_sat": 0, "…": "…"},
                 "lifetime": {"tx_count": 0, "…": "…"}}}
  ],
  "count": 2, "max_addresses": 500
}
```

`GET /api/addresses?list=addr1,addr2` does the same for short lists; the POST
form has no URL length limit. Duplicates are collapsed. Over `--max-addresses`
(default 500) the request is refused with **413 `too_many_addresses`**.

**`used` has three values.** `true`, `false`, and `null` when the address has no
confirmed history *and* the mempool could not be observed — because an
unconfirmed payment to it would make it used, and a scanner that reads `false`
there stops early and loses the rest of the wallet.

---

## `GET /api/addresses/top`

The richest addresses. `?limit=` 1–1000 (default 100), `?offset=`.

```bash
curl -s 'http://127.0.0.1:8080/api/addresses/top?limit=3'
```

```json
{
  "index": {"indexed_height": 2133, "…": "…"},
  "addresses": [
    {"rank": 1, "address": "pc1qexampleaddressaaaaaaaaaaaaaaaaaaaaqqqq",
     "tx_count": 8, "utxo_count": 4, "first_height": 2079, "last_height": 2125,
     "onchain_unspent_sat": 9974999863809, "onchain_unspent_pcn": "99749.99863809",
     "received_sat": 10214999860014, "received_pcn": "102149.99860014",
     "sent_sat": 239999996205, "sent_pcn": "2399.99996205"},
    {"rank": 2, "address": "pc1qexampleaddresszzzzzzzzzzzzzzzzzzzz2345",
     "tx_count": 720, "utxo_count": 38, "first_height": 15, "last_height": 2133,
     "onchain_unspent_sat": 190000132396, "onchain_unspent_pcn": "1900.00132396",
     "received_sat": 3595000132396, "sent_sat": 3405000000000},
    {"rank": 3, "address": "pc1qexampleaddressddddddddddddddddddddwxyz",
     "tx_count": 669, "utxo_count": 37, "first_height": 3, "last_height": 2130,
     "onchain_unspent_sat": 185000003795, "onchain_unspent_pcn": "1850.00003795",
     "received_sat": 3340000003795, "sent_sat": 3155000000000}
  ],
  "total": 15, "limit": 3, "offset": 0
}
```

Rank 2 is a miner: 720 transactions, first seen at height 15, still receiving at
the tip — and 34 050 of the 35 950 PCN it has ever received has been swept out.

The field is `onchain_unspent`, not `balance`: on a chain that is 99.5% coinbase
this figure includes immature coinbase, which is usually most of it.

---

## `GET /api/fees`

**Two different numbers, reported separately.** Real response:

```bash
curl -s http://127.0.0.1:8080/api/fees
```

```json
{
  "index": {"indexed_height": 2133, "…": "…"},
  "observed": {"node_reachable": true, "observed_seconds_ago": 0.006, "error": null},
  "relay_floor":       {"sat_per_kvb": 100,  "sat_per_vb": "0.100",
                        "pcn_per_kvb": "0.00000100", "known": true,
                        "source": "getmempoolinfo.minrelaytxfee"},
  "mempool_min":       {"sat_per_kvb": 100,  "sat_per_vb": "0.100", "…": "…"},
  "incremental_relay": {"sat_per_kvb": 100,  "sat_per_vb": "0.100", "…": "…"},
  "effective_floor":   {"sat_per_kvb": 100,  "sat_per_vb": "0.100",
                        "source": "max(minrelaytxfee, mempoolminfee) -- a transaction below this is rejected, not queued"},
  "recommended":       {"sat_per_kvb": 1000, "sat_per_vb": "1.000",
                        "pcn_per_kvb": "0.00001000",
                        "source": "max(effective_floor, 1000 sat/kvB) -- 1000 sat/kvB is what fallbackfee=0.00001 (PCOIN.md section 6.5) pays, and PCoin has no fee market to bid into"},
  "fee_estimation": {"usable": false,
                     "detail": "estimatesmartfee needs a fee history this chain does not have; it answers 'Insufficient data or no feerate found'. Use `recommended`."},
  "dust_thresholds_sat": {"p2wpkh": 294, "p2tr": 301, "p2pkh": 546,
                          "p2sh": 540, "p2wsh": 330},
  "dust_thresholds_note": "Derived from DUST_RELAY_TX_FEE = 3000 sat/kvB, a compile-time constant (src/policy/policy.h:64) that no RPC reports and that -dustrelayfee can override. Treat as informational, not observed.",
  "mempool": {"known": true, "tx_count": 0, "…": "…"},
  "no_fee_market": true
}
```

* **`effective_floor` = 0.1 sat/vB.** Below this a transaction is *rejected*, not
  queued. This is lower than most people expect: upstream Bitcoin Core v29.4 set
  `DEFAULT_MIN_RELAY_TX_FEE` to **100** sat/kvB (`src/policy/policy.h:66`), and
  PCoin did not change it (`git diff v29.4..HEAD -- src/policy/policy.h` is
  empty). Older documentation saying "the floor is 1 sat/vB" describes the
  *wallet default*, not the relay rule.
* **`recommended` = 1.0 sat/vB.** This is what `fallbackfee=0.00001` — the
  setting every PCoin wallet is told to set (`PCOIN.md` §6.5) — actually pays,
  and it is what real transactions on the chain pay: the mainnet transaction in
  the [`/api/tx` example](#get-apitxtxid) paid 584 sat for 584 vbytes.
* There is **no fee market to bid into**. `estimatesmartfee` has no data and
  says so. Paying the bare floor instead of the recommended rate saves 180
  satoshis on a 200-vbyte payment and makes the transaction the only unusual one
  in the mempool.

If the node has never been observed this endpoint returns **503
`node_unreachable`** rather than a number somebody might spend against.

---

## `GET /api/mempool`

```bash
curl -s http://127.0.0.1:8080/api/mempool
```

Real response — PCoin's mempool is normally empty:

```json
{
  "index": {"indexed_height": 2133, "…": "…"},
  "mempool": {"known": true, "node_reachable": true,
              "observed_seconds_ago": 0.005,
              "tx_count": 0, "txids": [], "entries": {}}
}
```

With something in it (this one from the test suite, since the live mempool was
empty):

```json
"mempool": {
  "known": true, "tx_count": 1,
  "txids": ["8069c537cb79ced588911fccfddf935af5e526cc8aee280318d8b3a76464c8a9"],
  "entries": {
    "8069c537…c8a9": {"vsize": 141, "fee_sat": 1000, "time": 1785832900,
                      "depends": [], "unbroadcast": true}
  }
}
```

`"partial": true` with `incomplete_tx_count` appears when a mempool transaction
spends an outpoint the index has not seen — its outputs are still counted, its
inputs are not attributed to any address, and the API says so rather than
quietly understating somebody's outgoing amount.

---

## `GET /api/search`

One box. `?q=` accepts a height, a block hash, a txid or an address.

```bash
curl -s 'http://127.0.0.1:8080/api/search?q=pc1qexampleaddressaaaaaaaaaaaaaaaaaaaaqqqq'
```

```json
{"kind": "address", "known": true,
 "index": {"…": "…"}, "address": "pc1qlvw6…64e",
 "balance": {"…": "as GET /api/address"}, "used": true}
```

`kind` is `"block"`, `"tx"` or `"address"`, and the rest of the payload is
exactly what the corresponding endpoint returns. An address with no history
answers `"known": false` with zeros rather than 404 — a wallet checking a freshly
derived receive address needs that answer.

---

## Errors

```json
{"error": {"code": "not_found", "message": "no block 99999 in the index"}}
```

| status | code | meaning |
|---|---|---|
| 400 | `bad_request` | malformed parameter, address, txid or body |
| 400 | `invalid_transaction` | the submitted bytes are not a relayable transaction |
| 400 | `refused` | the request contained key material |
| 400 | `rejected` | the node refused the transaction (its message and `rpc_code` included) |
| 404 | `not_found` | with `conclusive` on transactions, so a stale index cannot look like a definite "no" |
| 405 | `method_not_allowed` | |
| 411 | `length_required` | no `Content-Length`, or chunked encoding |
| 413 | `payload_too_large` / `too_many_addresses` | |
| 429 | `rate_limited` | with `Retry-After` and `limit_scope` (`client` or `global`) |
| 500 | `internal_error` / `txid_mismatch` | |
| 502 | `node_unreachable` | **a failure to obtain an answer, never an answer** |
| 502 | `broadcast_outcome_unknown` | the broadcast's fate is genuinely unknown; retrying is safe |
| 503 | `index_unavailable` | the index file could not be opened |
| 503 | `broadcast_unavailable` / `node_warming_up` / `mempool_unknown` | |

---

## Rate limits

Two independent token buckets.

| | default | flags |
|---|---|---|
| reads, per client | 20/s, burst 60 | `--read-rate`, `--read-burst` |
| broadcast, per client | 1 per 10 s, burst 3 | `--broadcast-rate`, `--broadcast-burst` |
| broadcast, whole process | 1/s, burst 10 | `--broadcast-global-rate`, `--broadcast-global-burst` |

A 429 carries `Retry-After` and `error.limit_scope`. The broadcast bucket is
checked separately from the read bucket, so exhausting it never blocks reads.

Clients are keyed on the peer address of the socket. `X-Forwarded-For` is honoured
**only** with `--trust-proxy`, and then only its rightmost entry — the one a proxy
you control appended. Without that flag any client can spoof the header and the
per-client limit becomes decorative.

---

## Deployment

* **Separate host from the seed.** `seed.pc.am` is the only DNS seed and
  `vFixedSeeds` is empty (CLAUDE.md §5, §11).
* **Point it at a `-disablewallet` node.** Broadcast refuses anything else unless
  `--allow-wallet-node` is passed.
* **Bind 127.0.0.1 and terminate TLS in front.** This is `http.server`: a
  thread-per-connection server, right-sized for a wallet backend and an explorer
  on a small chain, not for an unmetered public firehose. The rate limiter here
  is a backstop, not a substitute for one at the edge.
* **Run the indexer as a separate process.** It is the single writer; the API
  opens the same file `mode=ro`. Under WAL a reader never blocks the writer.
  A read-only SQLite connection still needs a writable `-shm`, so the API's user
  needs write permission on the *directory* holding the index (not on the
  database file itself).
* **Configure a witness node** (`--witness-rpc-url`) if you can. Without one, the
  strongest propagation signal available is the local unbroadcast flag.
* **`GET /api/status` is the health check.** Alert on `index.stale`,
  `index.blocks_behind_now`, `index.last_poll_age_seconds`,
  `node.connections.total == 0` and `broadcast.enabled == false`.

### Mounting it under the web UI

`pcoin_explorer` can serve this API and the HTML site on one port:
`ApiApplication.handle(method, path, query, body, client) -> (status, payload)`
is the whole composition surface, and `pcoin_api.cli.build_app(args, log)`
returns `(store, app)` built from this package's own defaults, so rate limits and
broadcast policy are never duplicated.

---

## Tests

```bash
cd contrib/explorer && python3 -m unittest discover -s tests -t .
```

`tests/test_api.py` (72), `tests/test_broadcast.py` (27) and `tests/test_txid.py`
(16) cover this package. The API tests run against a **real HTTP socket**, not by
calling handlers directly: routing, header handling, body limits, status codes
and the JSON encoder are all part of the contract a wallet depends on.

The transaction-parsing vectors in `tests/test_txid.py` are not self-referential
— both hex strings were fed to a live PCoin node's `decoderawtransaction` and the
txid, wtxid, size, vsize and weight recorded there are that node's answers.
