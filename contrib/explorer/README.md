# PCoin explorer — the indexer

The part that has to be correct. It reads blocks from a PCoin node over JSON-RPC
and maintains a SQLite address index that can answer *balance*, *history*,
*UTXOs*, and *every detail of one transaction* — the questions the node itself
cannot answer, because the chainstate is a UTXO set keyed by outpoint with no
reverse map from script to outpoints, and `txindex` answers a different question
(txid → tx).

`queries.py` is the read surface. The JSON API that sits on it lives in the
sibling package `pcoin_api` — see **[`pcoin_api/API.md`](pcoin_api/API.md)** for
every endpoint with a real request and response.

---

## Language and storage

**Python 3 (stdlib only) + SQLite**: the owner maintains a C++ chain, a Kotlin
app and a C# tray app alone, so the one thing this must not be is a fourth
toolchain — Python is already installed everywhere a PCoin node runs (Core's own
functional tests are Python), it needs no build step, no package manager and no
runtime to keep patched, and SQLite is one file that a reader and the single
writer can share under WAL with no server to operate.

Concretely: zero third-party dependencies (`json`, `sqlite3`, `urllib`,
`decimal`), so `git clone && python3 -m pcoin_indexer sync` is the whole install,
and there is no repeat of the tray app's *"a fresh clone cannot build it"*
problem. At 2 126 blocks the database is 5.8 MB and a full rebuild takes under
two seconds; the design headroom is years, and if the chain ever outgrows it the
schema ports to Postgres unchanged.

## Running it

```bash
python3 -m pcoin_indexer --datadir ~/.pcoin --chain main sync
python3 -m pcoin_indexer --datadir ~/.pcoin --chain main sync --daemon --interval 30
python3 -m pcoin_indexer --datadir ~/.pcoin reindex          # rebuild from genesis
python3 -m pcoin_indexer --db pcoin-index.sqlite verify       # recompute and diff
python3 -m pcoin_indexer --db pcoin-index.sqlite status
python3 -m pcoin_indexer --db pcoin-index.sqlite address pc1q…  --utxos
python3 -m pcoin_indexer --db pcoin-index.sqlite tx <txid>
python3 -m pcoin_indexer --db pcoin-index.sqlite search <anything>
```

Credentials come from the node's `.cookie` under `--datadir`, or from
`--rpc-user/--rpc-password`, or the `PCOIN_*` environment variables. RPC ports
default per network from `src/chainparamsbase.cpp:41-56` — **PCoin's RPC port is
P2P minus one**, so regtest is 49443, not Bitcoin's 18443 and not testnet3's
19443.

**Do not deploy this on the seed host.** `seed.pc.am` is the only DNS seed and
`vFixedSeeds` is empty (CLAUDE.md §5, §11): if that box gets loaded off the
network nobody new can bootstrap PCoin. Separate host.

**It never generates an address, holds a key or signs anything.** Clients derive
their own addresses from their own twelve words (BIP84, `m/84'/9444'/0'/0/i`).

## What it consumes, and what it therefore does not need to know

Everything arrives through `getblock <hash> 3`. Verbosity 3 returns fully decoded
transactions with each input's `prevout` attached, so the indexer reads
`scriptPubKey.address` as **a plain string the node already decoded**. It never
parses `blk*.dat`, and so it never needs PCoin's network magic `cf a2 d1 b8`, the
bech32 hrp `pc`, base58 versions 55/56/183, or RandomX. That is the whole reason
a 900-line indexer beats adopting electrs/Fulcrum/esplora here: every one of
those parses block files directly and would find zero blocks in a PCoin datadir.

Two consequences worth stating:

* **A pruned node cannot feed this.** Verbosity 3 needs undo data. If a `prevout`
  is missing the indexer raises rather than guessing — see
  `normalize_block`.
* Amounts arrive as bare JSON numbers. The RPC layer parses with
  `parse_float=Decimal` and `amounts.to_sat` **rejects a Python float** rather
  than rounding one, so a regression in that plumbing is a loud `TypeError`
  instead of a silent one-satoshi drift.

---

## Reorgs: the core feature

`getchaintips` on the live seed returns ~66 tips over ~2 100 blocks — a ~3% stale
rate — and LWMA at height 2800 roughly halves block spacing again, which raises
it further (stale rate tracks propagation delay over block spacing). Reorgs here
are routine. An indexer that unwinds one incorrectly reports wrong balances
forever and never notices, which is worse than having no explorer.

### Invariant I

> At every instant at which no transaction is open, `blocks` contains exactly the
> heights `0..T` for some `T ≥ -1`, one row per height, and for every `h` in
> `1..T`: `blocks[h].prev_hash == blocks[h-1].hash`.

Enforcement is split between the schema and the two procedures that mutate it:

| Half of the invariant | Enforced by |
|---|---|
| one row per height | `blocks.height` is the PRIMARY KEY (structural) |
| one row per hash | `blocks.hash` is UNIQUE (structural) |
| contiguity + linkage | `_apply_locked` refuses any block whose `height != T+1` or whose `prev_hash != hash(T)`; `_unwind_locked` refuses any height `!= T`. Both run inside one `BEGIN IMMEDIATE`. |

**Claim.** Given I, the rows of `blocks` are the first `T+1` blocks of a real
chain rooted at the node's genesis — never a mixture of two branches.

**Proof** (induction on `T`).
*Base, T = 0.* `_apply_locked` accepts height 0 only if its hash equals the
genesis hash the node reported for height 0, so `blocks[0]` is genesis.
*Step.* Assume `blocks[0..T-1]` is a genuine chain. A row is only ever added at
height `T`, and only if its `prev_hash` equals `blocks[T-1].hash`. Block IDs on
PCoin are still double-SHA256 of the 80-byte header — PoW is RandomX but
`GetHash()` is unchanged (CLAUDE.md §3) — so equality of `prev_hash` and `hash`
means this block's header genuinely commits to that parent. Hence `blocks[0..T]`
is a chain. ∎

**Corollary (why per-block atomicity is enough, and better than one big
transaction).** Every single-block apply and every single-block unwind takes the
database from one state satisfying I to another state satisfying I. A crash — or
a WAL commit lost to a power cut under `synchronous=NORMAL` — can therefore only
ever leave the index at *some* height whose contents are a valid chain prefix. It
cannot leave a half-unwound mixture of two branches. On restart the sync loop
re-derives the fork point from the node and continues; a partially unwound index
simply gets unwound further, and a partially applied one gets re-extended.

This is why `unwind_to` does **not**, and must not, wrap a whole reorg in one
transaction. Wrapping it would make a 40-block unwind a single 40× larger failure
domain and buy nothing, because the per-block statement is already the atomic
unit the invariant is stated over.

### Detection

Three independent paths, all of which land in the same `handle_reorg`:

1. `_apply_locked` finds the next block's `prev_hash` does not match the indexed
   tip → `ChainLinkError`. This is the common case.
2. The index is at or above the node's height and the hashes disagree — the
   equal-length competing branch, which a height-only comparison misses entirely,
   and the shorter-but-heavier chain, where `getblockhash` errors above the new
   tip.
3. A height we asked for stops existing between the tip observation and the
   fetch. The node *answered* (`-8`), so it is a fact: re-observe and retry.

`find_fork` then walks down with an exponential probe followed by a binary
search, so a depth-*d* reorg costs *O(log d)* RPC calls, not *O(d)*.

### Why unwind is an exact inverse rather than a recomputation

`address_txs` stores the exact per-`(address, tx)` deltas that `apply` added
(`received`, `sent`, `n_out`, `n_in`). Unwind subtracts *those recorded numbers*
back out of the `addresses` rollup. There is no second, independently-derived
piece of arithmetic that could drift from the first. The two quantities that
genuinely cannot be inverted — `first_height` and `last_height`, being MIN/MAX —
are recomputed from `address_txs` with an index seek at each end.

`tests/test_reorg.py::test_apply_unwind_is_exact_inverse` states this directly:
snapshot the whole database, apply blocks, unwind them, require the database to
be row-for-row what it was.

### The one ordering argument

`_unwind_locked` walks a block's transactions in **descending `block_index`**.
Combined with unwinding blocks in strictly descending height, that guarantees
nothing of the transaction being removed can still be marked spent by the time we
reach it: any spender is either later in the same block (already removed) or in a
higher block (already unwound). The code does not merely rely on that argument —
it *asserts* it and raises `IndexCorruption` if it is ever false, because the
alternative to a loud failure here is silent balance corruption.

---

## Schema

Full DDL and per-column notes in `pcoin_indexer/schema.sql`.

| Table | Purpose |
|---|---|
| `blocks` | one row per height; header fields, size/weight, `value_out`, `total_fees`, `subsidy`, `coinbase_out` |
| `txs` | `txid` PK, block placement, size/vsize/weight, `value_in`, `value_out`, `fee` |
| `outputs` | `(txid, n)` PK, value, address, script, `is_coinbase`, `maturity_height`, `unspendable`, and **spent-ness** |
| `inputs` | `(txid, n)` PK, with the **source output's address and amount** copied in from `prevout` |
| `address_txs` | `(address, txid)` PK — the history index, and the exact per-tx deltas unwind subtracts |
| `addresses` | rollup cache: balance, received, sent, utxo_count, tx_count, first/last height |
| `sync_state` | the single-row consistency marker |
| `reorg_log`, `orphaned_blocks` | the audit trail; an orphaned block is still findable instead of 404 |

**Spent-ness is stored, not derived**, so a balance is one primary-key lookup on
`addresses` and never a scan. `addresses` is a *cache* of `outputs`/`address_txs`
— `verify` rebuilds it independently and diffs, and cross-checks it a second time
against the live unspent rows.

Two things a naive schema gets wrong on this chain:

* **`address` is NULLable.** Genesis pays a bare `pubkey` with no address, and
  every block's coinbase carries a zero-value OP_RETURN witness commitment.
* **`unspendable` is a real flag.** OP_RETURN outputs, oversized scripts, and the
  genesis coinbase — which `chainparams.cpp:62-64` states is never added to the
  UTXO set at all. Without the genesis exclusion the index sits 50 PCN above
  `gettxoutsetinfo` forever.

### Coinbase maturity

2 126 of 2 136 transactions on mainnet today are coinbases, so a balance that
counts immature coinbase as spendable is wrong more often than it is right.
Every coinbase output carries `maturity_height = height + 100`, the first height
at which it may be spent (`nSpendHeight - nHeight >= COINBASE_MATURITY`). The
address view returns three numbers:

* `balance` — every unspent output, immature included
* `immature` — unspent coinbase with `maturity_height > tip + 1`
* `spendable` — `balance - immature`, i.e. what a wallet may build a transaction
  from *right now*, since a transaction being assembled now lands in the block at
  `tip + 1`

`immature` is deliberately **not** cached in `addresses`: it depends on the
current tip height, so a stored value goes stale with nothing writing to it.

### The consistency marker

`sync_state` is one row, written inside the same transaction as the block it
describes, and `queries.health()` turns it into `blocks_behind`,
`last_poll_age_seconds`, `stale` and `stale_reasons`.

It follows CLAUDE.md §7.1/§7.2 literally: **an RPC that failed, timed out or
answered "I do not know" resolves nothing.** The `node_*` fields are written
*only* after a successful poll, so a node that has gone away leaves the last
observation intact and `blocks_behind` keeps growing — it is never silently reset
to zero. A failed poll sets `status='error'` and touches nothing else. Likewise
`_node_hash_at` treats only `-8` ("Block height out of range") as "no block
there"; every other error propagates, because "the node did not answer" read as
"the hashes differ" would unwind the index off a perfectly good chain.

An API that renders a balance without checking `health()["stale"]` is the exact
failure mode this table exists to prevent.

### Reindex from scratch

`reindex` builds into `<db>.reindex` with the rollback journal in memory and no
fsync, then `os.replace`s it over the live file only once complete — so a reader
never observes a half-built index and never has to be told to distrust one. It is
`journal_mode=MEMORY` rather than `OFF` on purpose: `OFF` makes `ROLLBACK` a
no-op, and apply/unwind rely on rollback to undo a *failed* statement sequence,
which is a correctness property, not just a crash-safety one.

---

## Tests

```bash
cd contrib/explorer && python3 -m unittest discover -s tests -t .   # 42 tests, ~0.7s
```

`tests/fakechain.py` is a synthetic node that speaks `getblock <hash> 3`,
including the shapes a real PCoin node produces (addressless genesis, the
witness-commitment OP_RETURN, `prevout.generated`). It can produce in
milliseconds branch structures a real node would take days to reach. Its
`FakeRpc` mirrors `RpcClient` exactly, including the "a block the node no longer
has becomes `None`" rule — a fake more forgiving than the real client would let
the reorg tests pass against a client that cannot survive a live reorg.

Reorg-specific coverage (`tests/test_reorg.py`): apply/unwind is an exact
inverse; unwind restores spent outputs; a spend confirmed on the losing branch is
undone; the same tx re-mined at a different height; a deep reorg to genesis; an
equal-length competing branch; a reorg to a *shorter* chain; a reorg landing
between the tip poll and the block fetch; `find_fork` lands exactly at every
depth 1..40 in *O(log d)* probes; a half-completed reorg is recoverable and
converges on the from-scratch answer; an unexpected RPC error is never read as a
fork; and a 40-step randomised branch-switching walk that after **every** step
requires the incrementally-maintained index to equal a freshly built one.

### Against a real node

```bash
python3 tests/regtest_e2e.py --bin /root/pcoin-build/build/bin \
                             --datadir /root/pcoin-explorer-regtest
```

Opt-in, regtest only (it refuses any other chain — it mines and it calls
`invalidateblock`). It drives a real `bitcoind` through a linear sync, a real
spend, a reorg that orphans that spend, `reconsiderblock`, and a 40-deep reorg,
and after every phase asserts that the incremental index is **byte-for-byte
identical to a from-scratch index** and that its UTXO count and total supply
match the node's own `gettxoutsetinfo`. It finishes by `SIGKILL`ing a syncing
indexer eight times at random points and requiring the survivor to verify clean
and converge on the same answer.

### The reorg torture test

```bash
python3 tests/reorg_torture.py --bin /root/pcoin-build/build/bin \
                               --workdir /root/pcoin-torture \
                               --mainnet-datadir /root/pcoin-verify   # optional
```

`regtest_e2e.py` checks that the indexer's assumptions about a real node hold.
This one attacks the property everything else rests on: **after a reorg the index
must equal, row for row, a from-scratch reindex of the same final chain.** It
starts its own regtest nodes (two, so one reorg is produced by a real competing
peer rather than by `invalidateblock`), and refuses to run against any other
chain. The mainnet phase is strictly read-only — `getblockchaininfo`,
`getblockhash`, `getblock`, `gettxoutsetinfo`, `scantxoutset`, nothing else.

| Phase | What it forces |
|---|---|
| 1 | a one-block reorg |
| 2 | a 14-deep reorg; the fork search is *measured* at O(log d) probes |
| 2b | two real nodes, partitioned and healed — no `invalidateblock` anywhere |
| 3 | a reorg that orphans a coinbase, then pays the **same address** again on the winning branch |
| 4 | `SIGKILL` between the unwind and the re-apply, then three more kills at other points |
| 5 | a tx in a block on one branch and in the **mempool** on the other, then re-mined at a different height |
| 7 | 60 s of continuous reorging *while* the indexer syncs |
| 7b | the node reorging **inside a single sync pass**, at both race windows, deterministically |
| 8 | a reorg that unwinds every block back to genesis |
| 6 | the real chain: index the mainnet node and diff every address against `scantxoutset` |

Two things it is careful about, because the first versions of both were wrong.
The mainnet comparison is **pinned to one block** — every oracle's `bestblock`
must equal the index tip, and the comparison restarts if the node advances, since
otherwise one new coinbase reads as a 50 PCN "mismatch". And the mid-fetch race
paths are *forced by a hook*, not waited for: a race that does not happen is not
evidence that the code handling it works.

---

## Measured

Full mainnet index, RPC to a synced node on the same host (WSL2, `/root`
filesystem, node at height 2125):

| | |
|---|---|
| Full reindex from genesis | **1.76 – 2.04 s** (3 runs) |
| — of which RPC | 0.65 s, 4 254 calls, 6.7 MB |
| Database size | **5 828 608 bytes** (5.8 MB) |
| Incremental resync, already caught up | 0.33 s |
| `verify --deep` | 0.17 s |
| Rows | blocks 2 126 · txs 2 136 · inputs 4 129 · outputs 4 263 · address_txs 2 153 · addresses 25 |
| Index UTXO count / supply | 134 / 106 250.00000000 PCN |
| Node `gettxoutsetinfo` | `txouts` **134**, `total_amount` **106250.00000000** — exact match |
| Per-address cross-check | all 15 addresses with a balance match `scantxoutset` exactly |

Regtest end-to-end: **47/47 checks**, including a real 40-deep reorg and 8
`SIGKILL`s. Unit suite: **42/42** in 0.7 s (250/250 with the API tests).

Reorg torture (`tests/reorg_torture.py`), three consecutive clean runs against
its own regtest nodes: **182/182 checks, 0 failures**. In one run the live index
absorbed **66 reorgs unwinding 660 blocks**, the deepest being a 377-block unwind
back to genesis, and after every phase it was identical row-for-row (up to 2 332
rows across 6 tables) to a from-scratch reindex. The chaos phase ran **26 549
sync passes against a node reorging underneath it** — 59 forced reorgs in 60 s —
with no exception and an exact index at the end. All three reorg-detection paths
and both mid-fetch race windows were measured as exercised, not assumed. On
mainnet, all **25** addresses that exist on the chain match `scantxoutset` on
balance *and* UTXO count, pinned to a single block.

One measured limit of the audit trail, as distinct from the balances: `reorg_log`
and `sync_state.reorg_count` are written by `handle_reorg` only after `unwind_to`
returns, so a crash part-way through an unwind loses that summary row — in the
crash phase, 30 blocks were unwound but `reorg_log` accounts for 27.
`orphaned_blocks` is written inside each per-block unwind transaction and is
therefore complete, and the balances are unaffected: the crashed-and-resumed
index is still identical to a from-scratch one.

A full reindex is cheap enough that it is a legitimate operational answer to any
doubt about the index. That is a property of *today's* chain size, not a design
guarantee — hence the per-block unwind, which stays cheap when it isn't.

## Known gaps

* **The index itself still has no mempool**, and it should not have one: an index
  is a record of what blocks committed to. The unconfirmed view a wallet's Send
  flow needs — so that `/address/{a}/utxos` never hands back an outpoint the
  client just spent — is built live in `pcoin_api/nodeview.py` from
  `getrawmempool`, resolved against this index, and is reported as *unknown*
  rather than zero whenever the node cannot be reached.
* **Polling only.** ZMQ source is present in the tree but not compiled in
  (`CMakeLists.txt:146,236`); polling is the right answer anyway, because a
  dropped ZMQ notification stalls an indexer silently.
* Coinbase maturity is reported **in blocks**, never as an ETA — block spacing on
  this chain is neither the 600 s target nor stable, and it changes again at 2800.
