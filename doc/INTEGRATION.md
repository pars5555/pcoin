# Integrating PCoin

For exchanges, payment processors, and anyone who has to move PCN
programmatically. It assumes you have integrated Bitcoin Core before and tells
you only what is different, plus the handful of things that will bite you.

Everything here is verifiable against the source at
<https://github.com/pars5555/pcoin> and against the live chain at
<https://explorer.pc.am>.

---

## 1. The short version

PCoin is a fork of **Bitcoin Core v29.4**. The RPC interface, the wallet, the
descriptor system, PSBT, and the binaries' names are all unchanged. If your
integration speaks Bitcoin Core, it speaks PCoin.

Four things differ, and all four have caught someone out:

| | PCoin | Bitcoin |
|---|---|---|
| **RPC port** | `9443` — **P2P minus one** | P2P plus one |
| **Config file** | `pcoin.conf` | `bitcoin.conf` |
| **Data directory** | `~/.pcoin`, `%LOCALAPPDATA%\PCoin` | `~/.bitcoin` |
| **Proof of work** | RandomX | SHA-256d |

The RPC port is the one that surprises people. Bitcoin uses P2P+1, but on this
chain P2P+1 (9445) is bitcoind's own default Tor onion listener, so RPC went to
P2P−1 instead. The rationale is in `src/chainparamsbase.cpp:37-38`.

Binaries keep upstream names — `bitcoind`, `bitcoin-cli`. Only the datadir and
config are renamed, so **on a machine that also runs Bitcoin, always pass an
explicit `-datadir`.**

**wPCN is not PCN.** A 1:1 wrapped IOU, `wPCN`, exists as a BEP-20 token on BNB
Smart Chain (`0x290A5779a419Cb9cB22fa087CDD1CD16dA2D95F1`, 8 decimals, fixed
50,000 supply, backed by a public reserve). It is a different asset on a different
chain: a BSC transfer is never a PCN deposit, and the PancakeSwap price is not the
PCN reference price — that is <https://price.pc.am>. Conversion in both directions
is manual, via <https://wrapdesk.pc.am>.

---

## 2. Chain parameters

| | |
|---|---|
| Ticker | PCN |
| Max supply | 21,000,000 (hard cap, Bitcoin's schedule) |
| Block subsidy | 50 PCN, halving every 210,000 blocks |
| Target spacing | 600 s |
| Difficulty | LWMA, **retargeting every block**, from height 2800. Below that, Bitcoin's 2016-block retarget |
| Coinbase maturity | 100 blocks (spendable at depth 101) |
| P2P / RPC | 9444 / 9443 |
| Network magic | `cf a2 d1 b8` |
| Address types | bech32 `pc1…`; base58 `P…` (55) and script (56); WIF 183 |
| BIP32 version bytes | **Bitcoin's** — `0488ADE4` / `0488B21E`, so extended keys serialise as `xprv…`/`xpub…` |
| BIP44 coin type | **9444'** |
| Genesis | `a95d51f0cbf25cad10c35961c6189356525d079835f02e83e2395f382fbe264a` |
| DNS seed | `seed.pc.am` |

### The coin type is load-bearing

PCoin kept Bitcoin's extended-key version bytes, so a PCoin xprv is
byte-compatible with a Bitcoin one. **Coin type `9444'` is the only thing
keeping the two key trees apart.** Under coin type 0 the same recovery phrase
would derive identical keys on both chains, and a customer's PCoin withdrawal
address would be a live Bitcoin address.

The reference derivation is BIP84:

```
m / 84' / 9444' / account' / change / index
```

`9444'` is unregistered in SLIP-44. Never use it on a test network — testnets
use SLIP-44's universal coin type 1.

---

## 3. Running a node

```bash
# Linux — the archive unpacks to pcoin-<ver>/ with the binaries at its top level
curl -fLO https://github.com/pars5555/pcoin/releases/download/v1.3.0/pcoin-linux-x86_64-miner.tar.gz
tar xzf pcoin-linux-x86_64-miner.tar.gz && cd pcoin-*/
./bitcoind -datadir=/var/lib/pcoin -daemon
./bitcoin-cli -datadir=/var/lib/pcoin getblockchaininfo
# or, on Debian/Ubuntu: curl -fsSL https://pc.am/dl/install.sh | sudo sh
```

A minimal `pcoin.conf` for an exchange:

```ini
server=1
listen=1
txindex=1            # required if you look transactions up by txid
rpcbind=127.0.0.1
rpcallowip=127.0.0.1
dbcache=450

# Deposit crediting needs a fee estimate to build withdrawals, and this chain
# has almost no fee history. Without this, every send fails with
# "Fee estimation failed".
fallbackfee=0.00001

# A phrase-backed wallet holds only wpkh descriptors. Without this, sending to
# a taproot pc1p... address fails while allocating change.
changetype=bech32
```

Verify your download first — checksums at <https://pc.am/dl/SHA256SUMS.txt>.

**Resource note.** The whole chain is still tiny (tens of MB — `size_on_disk` in
`getblockchaininfo` is the real figure; `du` on `blocks/` overstates it because Core
preallocates) and a full sync from
genesis takes minutes. RandomX verification uses a ~256 MB cache in light mode;
budget that per node.

---

## 4. Crediting deposits

Standard Bitcoin Core practice applies. Two chain-specific points:

**Confirmations.** Reorgs happen here — a chain this small reorganises a block
or two from time to time, which is what you get when propagation delay is a
meaningful fraction of block spacing. Read `reorg_count` from
<https://explorer.pc.am/api/status> for the count to date rather than trusting a
figure written here, which rots. Do not credit at 1 confirmation. Treat
this as a small chain and require depth accordingly; 20+ is not paranoid at
current hashrate. Note that **hashrate is currently low and concentrated**, so
the cost of a deep reorg is correspondingly low. Price that in.

**Block timestamps are not monotonic in height.** Consensus requires only that
a timestamp beats the median of the previous eleven. A block can carry a time
slightly earlier than its parent. Any code computing "time since last block" or
"deposits in the last 24 h" from block times must tolerate negative intervals.

**Coinbase maturity is 100 blocks.** Mined output is unspendable until depth
101. Compute maturity in blocks, never as a duration: spacing on this chain has
ranged from 49 s to over 1200 s, so any ETA derived from a fixed spacing is
wrong.

---

## 5. Withdrawals

Nothing unusual. `sendtoaddress`, `send`, `sendall`, and PSBT all behave as in
Bitcoin Core v29.4.

Two flags worth knowing:

* **`add_to_wallet=false`** on `send`/`sendall` builds and signs a transaction
  and hands back the hex **without recording anything**. Nothing is locked and
  the inputs stay available, so you can show a user the real fee before they
  commit and abandon it for free if they decline.
* **`sendall` takes the same positional shape as `send`** —
  `(recipients, conf_target, estimate_mode, fee_rate, options)`. Passing the
  options object second lands it in `conf_target` and the node rejects the
  whole call. This is easy to get wrong; use named parameters.

### Re-submitting a transaction is safe, and reports oddly

Broadcasting the same signed transaction twice is harmless — but the node
reports "already sent" through the same channel as a failure, and treating that
as a failure is how software double-pays:

| Situation | `testmempoolaccept` | `sendrawtransaction` |
|---|---|---|
| Already in the mempool | `allowed=false`, `txn-already-in-mempool` | **succeeds**, returns the txid |
| Already confirmed | `allowed=false`, `txn-already-known` | error **−27** |
| Genuinely stale (inputs spent elsewhere) | `allowed=false`, `missing-inputs` | error **−25** |

The first two mean *the transaction is out there*. Only the third is a failure,
and it is the one case where the coins went somewhere else.

---

## 6. The HTTP API, if you would rather not run a node

<https://explorer.pc.am/api> is read-only, CORS-enabled, needs no key, and is
served from an index built independently of any wallet.

```
GET  /api/status                      index and node health
GET  /api/tip                         current tip
GET  /api/blocks?limit=N              recent blocks
GET  /api/block/{height|hash}         one block
GET  /api/block/{height}/txs          its transactions
GET  /api/tx/{txid}                   one transaction, fully decoded
GET  /api/address/{addr}              balance, counts, first/last height
GET  /api/address/{addr}/txs          history, paged
GET  /api/address/{addr}/utxos        spendable outputs
POST /api/addresses                   many addresses in one call
GET  /api/addresses/top               rich list
GET  /api/mempool                     unconfirmed
GET  /api/fees                        fee observations
GET  /api/search?q=…                  height, hash, txid or address
POST /api/tx                          relay a SIGNED transaction
```

Full request and response examples: [`contrib/explorer/pcoin_api/API.md`](../contrib/explorer/pcoin_api/API.md).

Every response carries an `index` block giving, among others, `indexed_height`,
`node_height`, `blocks_behind`, `stale`, `node_reachable` and — the trap —
`reorg_count` and `blocks_unwound`.

`reorg_count` and `blocks_unwound` are **cumulative lifetime counters**: they
only ever grow. `blocks_unwound == 0` is therefore **not** a health gate. It
went permanently false at this chain's first reorg, and every rail that had
gated on it silently refused to credit any deposit from that moment on — alive,
ticking, exiting clean, and settling nothing. If you want a genuine mid-reorg
signal, compare `blocks_unwound` between two successive reads and act on the
*change*, never on the value.

**Gate on `stale == false`, `node_reachable`, and `blocks_behind == 0` before
trusting a balance** — a lagging index reports an old answer confidently, and a
stalled one reports `blocks_behind: 0` because it has not polled and does not
know it is behind. `stale` is the index's own verdict, and `stale_reasons` says
why.

`POST /api/tx` accepts only signed transaction hex. The service holds no keys
and will refuse a request containing key material.

**These are three independent instances** — <https://explorer.pc.am>,
<https://explorer2.pc.am>, <https://explorer3.pc.am> — and corroborating two of them
is what the project's own payment rails do. Still run your own node for anything where money depends on the
answer; this is a convenience, not infrastructure you should depend on.

---

## 7. Amounts

Amounts arrive as **bare JSON numbers**, not strings —
`JSON_BIGINT_AS_STRING` affects integers only. Parse to a decimal or integer
satoshi type, never to a float you then do arithmetic on. The explorer API
returns both: `*_sat` (integer) and `*_pcn` (string). **Use the integer.**

When sending an amount to the node, pass a **fixed-point string**
(`"1.50000000"`). Core parses the raw text, and a double that serialises as
`1.0E-8` is rejected.

---

## 8. Things that are not true of this chain

Stated plainly, because assuming otherwise wastes days:

* **There is no address index in the node.** The chainstate is a UTXO set keyed
  by outpoint with no reverse map from script to outpoints, and `txindex` answers
  a different question (txid → tx). "What does this address hold" requires an
  external index — that is what the explorer is.
* **`scantxoutset` is not an alternative.** It is O(entire UTXO set) and
  globally serialised behind a process-wide flag. Never put it behind an HTTP
  request.
* **ZMQ is compiled out.** `getzmqnotifications` returns "Method not found".
  Poll, or rebuild with `-DWITH_ZMQ=ON`.
* **The P2P user agent is `/Satoshi:29.4.0/`** and `CLIENT_VERSION` is 29.4.0,
  even on v1.x releases. You cannot identify a PCoin node, or tell PCoin
  releases apart, by user agent.
* **`getdeploymentinfo` does not mention LWMA.** Its softfork list is unchanged
  from upstream. LWMA is a plain height check, not a deployment; the only way to
  see its state is the height.
* **The Python functional test framework cannot talk to a PCoin node** — it still
  carries Bitcoin's network magic. Any test using `add_p2p_connection` hangs.

---

## 9. Honest disclosure

If you are evaluating PCoin for listing, these are the facts you would find
anyway, stated up front:

* **The chain launched on 1 August 2026.** Check its age and height live at
  <https://explorer.pc.am/api/status> rather than trusting a date in this file.
* **Hashrate is small and concentrated.** Most of it goes through the project's
  own pool, `pool.pc.am` — its share is published at <https://pool.pc.am/api/pools>
  (`poolStats.poolHashrate` against `networkStats.networkHashrate`). A
  well-resourced attacker could reorg this chain today.
* **Coin distribution is concentrated.** Almost all early mining was done by the
  founder's hardware; there was no premine and no sale. Do not take a figure from
  this document — the live rich list is at
  <https://explorer.pc.am/api/addresses/top>. Note that the wPCN reserve
  (`pc1q7hhzmdkkx0zjtzj6qkwmuvhlgwfqjrc6j2dk52`, 50,000 PCN backing the wrapped
  token) appears on that list and is not a holder.
* **The market is tiny.** A posted rate exists at <https://price.pc.am> (the anchor
  the payment rails price off), PCN is sold from a finite ladder at
  <https://market.pc.am>, and a 1:1 wrapped token (wPCN, BEP-20 on BNB Smart Chain)
  trades on PancakeSwap with very little depth — tens of dollars move that price by
  double digits. Treat any quoted price as unproven.
* **Difficulty changed behaviour at height 2800** (passed), switching from
  Bitcoin's 2016-block retarget to per-block LWMA. Nodes older than v1.2.0 are
  forked off and must upgrade.

---

## 10. Contact

Source, issues and releases: <https://github.com/pars5555/pcoin>
Explorer and API: <https://explorer.pc.am>
Checksums: <https://pc.am/dl/SHA256SUMS.txt>
