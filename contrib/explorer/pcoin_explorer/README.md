# PCoin explorer — the web UI

Server-rendered pages plus a read-only JSON API, in one stdlib-only process, on
top of the SQLite address index built by `pcoin_indexer`.

```bash
cd contrib/explorer
python3 -m pcoin_indexer --datadir ~/.pcoin --db pcoin-index.sqlite sync --daemon &
python3 -m pcoin_explorer --db pcoin-index.sqlite serve      # http://127.0.0.1:8080/
```

No build step, no package manager, no third-party dependency — same reasoning as
the indexer: this project is already a C++ chain, a Kotlin app and a C# tray app
maintained by one person, and the thing it must not acquire is a fourth
toolchain. `git clone && python3 -m pcoin_explorer serve` is the whole install.

There is **no JavaScript on any page.** Search is a GET form, paging is links,
the two address views are a query parameter. The Content-Security-Policy says
`default-src 'none'` and the pages actually comply — a test asserts it.

---

## What it holds, and what it therefore cannot do

The only input is the index file, opened read-only (`mode=ro`, or a normal
handle with `PRAGMA query_only=ON` where SQLite cannot create the WAL
shared-memory file from a read-only connection).

* **No node credentials.** The process never speaks to a node. It cannot be
  talked into calling `scantxoutset`, which is globally serialised behind a
  process-wide flag and O(entire UTXO set) per call, and it cannot affect the
  chain no matter what a request contains.
* **No write surface.** With nothing mounted at `/api`, every method other than
  `GET` and `HEAD` is refused. It never derives an address, holds a key, signs
  or broadcasts. Clients derive their own addresses from their own twelve words
  (BIP84, `m/84'/9444'/0'/0/i`).
* **One consistent snapshot per request.** Each request runs inside a single
  deferred read transaction. Without it a page could read the tip, then the
  balances, then the confirmations, and straddle a writer's commit — on a chain
  that reorganises as often as this one, rendering a mixture of two chain states
  is not a theoretical concern.
* **Nothing containing money is cacheable.** HTML and JSON are `no-store`; only
  the stylesheet carries a `max-age`. A balance served from a proxy cache after
  a reorg is exactly the wrong answer.

It binds `127.0.0.1` by default. `http.server` is not a hardened edge server —
put a reverse proxy in front of anything public. **Not on the seed host:**
`seed.pc.am` is PCoin's only DNS seed and `vFixedSeeds` is empty, so loading
that box off the network stops anyone new from bootstrapping the chain.

---

## The search box

One field, and the routing is the product. Every branch is decided by a
**positive** test, never by elimination, so it cannot route to the wrong kind.

| You type | You get |
|---|---|
| `2000` | block at height 2000 |
| a 64-hex id | the transaction, else the block, else the block this index orphaned |
| 8–63 hex characters | exact prefix match on txid/block hash; several matches list them |
| `pc1q…` or a base58 address | the address page |
| an address with no history | the address page, balance zero, saying so |
| `PC1Q…` (all upper) | the same address, lowercased — bech32 is case-insensitive as a whole |
| `bc1q…`, `1A1z…` | *"that is a Bitcoin address, not a PCoin one"* |
| a PCoin address from another PCoin network | *"…but this explorer is serving mainnet"* |
| an address with one character wrong | *"the checksum does not verify — check for a typo"* |
| a pasted URL, `0x`-prefixed id, quoted or padded text | normalised first, then routed |

Two of those are worth stating plainly, because both are cases where the naive
answer is actively misleading:

* **A valid address with no history is not "not found".** A freshly derived
  receive address appears in no table. Answering "not found" reads as *your
  address is wrong*. `pcoin_explorer/addr.py` therefore decodes bech32 and
  base58check offline — PCoin's hrp `pc`/`tpc`/`pcrt` and base58 versions
  55/56 and 117/118 — so the page can say "valid, never used, balance zero".
* **A wrong-network address is named, not silently unmatched.** PCoin inherited
  Bitcoin's BIP32 version bytes (CLAUDE.md §6), so the two chains' addresses
  have to be told apart loudly.

When nothing matches *and* the index is behind the node, the miss says so rather
than asserting the thing does not exist.

---

## The pages

| Path | |
|---|---|
| `/` | tip, difficulty, hashrate estimate, supply, the pace panel, latest blocks, latest payments |
| `/blocks`, `/block/<height\|hash>` | list; every header field, and the block's transactions with their addresses |
| `/txs`, `/tx/<txid>` | list (with a payments-only view); inputs with their source addresses and amounts, outputs, fee and fee rate, size/vsize/weight, confirmations, timestamp, block |
| `/addresses`, `/address/<address>` | every address ranked by balance; balance split, history and UTXOs, paged |
| `/reorgs` | the reorg log and the orphaned blocks this index unwound |
| `/about` | what it can and cannot tell you, and the index's live state |
| `/api`, `/api/…` | the JSON API |
| `/healthz` | `200` when the index is level with the node, `503` when it is not |

### Four things it refuses to round off

1. **The staleness banner.** `queries.health()` exists so a balance is never
   rendered as current when the index has not heard from the node. Every page
   carries the banner when `health()["stale"]` is true, and `/healthz` answers
   503. The indexer README names "an API that renders a balance without checking
   `stale`" as the exact failure that table exists to prevent.
2. **The unconfirmed balance is `not indexed`, never `0.00000000`.** There is no
   mempool index, so nobody has answered that question. Rendering an unanswered
   question as a definite zero is CLAUDE.md §7.2 — the mistake that, in a
   wallet's send path, authorises spending the same coins twice. The API returns
   `"unconfirmed": null` with a reason string for the same reason.
3. **Coinbase maturity is counted in blocks.** An output is spendable in the
   block at `maturity_height`; that is the consensus rule. Where a time estimate
   appears beside it, it is derived from this chain's *measured* pace and is
   labelled as such — never from the 600 s target, because the chain does not
   run at target.
4. **Unknown renders as an em dash.** `fmt.maybe`, `fmt.num(None)`,
   `fmt.amount_html(None)` and `fmt.hashrate(None)` all produce a dash. A
   missing answer never looks like a zero.

### The pace panel, and the window that inverts it

The chain's block rate is the number most easily made to lie here, so the window
is chosen deliberately. Heights 0–2015 were mined at the minimum difficulty
roughly 49 s apart; everything since is ~20× slower, because the legacy retarget
only fires every 2016 blocks. Measured at height 2129:

| window | mean spacing |
|---|---|
| last 10 | 1336 s |
| last 50 | 1059 s |
| **last 100 (headline)** | **1066 s — 1.78× the 600 s target** |
| last 200 | 672 s |
| last 500 | 272 s |
| all 2129 | 110 s |

A longer window is not more data, it is *different* data: at 500 blocks the page
would report the chain as running **faster** than target, which is the opposite
of the truth. `reads.RECENT_WINDOW` is the headline; every window shown is
labelled with its own length, and the lifetime average is shown *and* called an
artefact. A test builds a two-era chain and asserts the home page says "slower".

The hashrate estimate is work over time from `chainwork`, mirroring Core's
`GetNetworkHashPS`: the **span** of the block timestamps in the window, not
last-minus-first, because block timestamps are not monotonic in height here
(CLAUDE.md §3). When the span is not positive it returns `None` and the page
says so — an unknown, never a zero.

---

## JSON API

`GET /api/status · /chain · /blocks · /block/<id> · /txs · /tx/<txid> ·
/address/<a> · /address/<a>/history · /address/<a>/utxos · /addresses ·
/reorgs · /search?q=`

Every amount appears twice — `x` as an exact integer of satoshis and `x_pcn` as
a fixed-point decimal string — so no response can lose a satoshi to an IEEE
double. A test walks every response and fails on a float in any amount-shaped
field. Every balance-shaped response carries `health`.

### Serving the full API from the same process

The richer API — mempool-aware balances, multi-address gap scans, signed
transaction relay — is the separate `pcoin_api` package. Mount it and one port
serves both:

```bash
python3 -m pcoin_explorer --db pcoin-index.sqlite serve \
        --with-api -- --datadir ~/.pcoin --no-broadcast
```

Everything under `/api` is then answered by that application, including `POST`,
and the pages are served around it. The hook is
`server.Router(store, api_app=...)`: any object with
`handle(method, path, query, body, client) -> (status, payload)` works, which is
`pcoin_api.ApiApplication`'s signature. It is built through that package's own
parser and factory, so its defaults, rate limits and broadcast policy stay in
one place. If it fails, the response is a `502` naming the failure — never an
empty result.

---

## Tests

```bash
cd contrib/explorer && python3 -m unittest tests.test_web    # 93 tests, ~1s
cd contrib/explorer && python3 -m unittest discover -s tests -t .
```

They run the router directly rather than over a socket, so every page, status
code and escaping rule is reachable without binding a port. Beyond "it returns
200": the numbers on an address page equal the index's own; immature coinbase is
excluded from *spendable now*; unconfirmed never renders as zero; the banner
appears exactly when `health()["stale"]` is true; an orphaned block still
resolves to a page; every real identifier in a synthetic chain routes to its own
kind and no other; hostile input comes back inert; the markup on every page is
tag-balanced; no page contains `<script`; and no page contains a double-escaped
entity.

`tests/bech32enc.py` is a bech32 **encoder** used only by the tests — the
explorer itself only ever decodes, because it must never construct an address.

---

## Known gaps

* **No mempool** in this package's own API. Unconfirmed transactions are
  invisible and are reported as unknown rather than as zero. Mount `pcoin_api`
  for a mempool-aware view.
* **No charts.** Deliberate: they would need JavaScript or a rendering
  dependency, and neither is worth it for a chain this young.
* **No websocket/live update.** Reload the page.
* Pagination uses `LIMIT/OFFSET`. Fine at this chain size; it is the first thing
  to change if the index ever gets large.
