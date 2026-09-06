# Running a PCoin pool

This is the practical companion to [`DESIGN.md`](DESIGN.md). That file explains
*why* the pool works the way it does; this one is how to stand one up.

**Please do run one.** PCoin currently has a single pool — ours — and it has
been finding between 55% and 70% of blocks. That is the concentration risk the
white paper names, and it is not a problem we can fix by ourselves: miners
cannot leave for a second pool while there is no second pool. Everything below
is the software we run in production, in this repository, under the same
licence as the rest of it. Nothing is held back.

---

## What you need

| | |
|---|---|
| A synced PCoin node | full node, `txindex` not required |
| Node.js | 18+ (we run 24) |
| A C++ toolchain | for the share validator — `g++` and `make` |
| sqlite3 | the share ledger |
| A payout address | `pc1q…`, where blocks your pool finds are paid |
| A public port | 3333 by convention; anything works |

RAM is dominated by RandomX: the validator holds a ~256 MiB cache. CPU is the
real budget — **each share costs roughly 21.7 ms to verify**, which is why
vardiff exists and why share rate is a cost, not a comfort setting.

---

## Build and configure

```bash
git clone https://github.com/pars5555/pcoin
cd pcoin/contrib/pool
./build.sh                      # builds the RandomX share validator
cp pool.config.example.json pool.config.json
```

The example config is commented line by line — read it rather than copying
blindly. The fields that decide how your pool behaves:

| field | what it does |
|---|---|
| `poolAddress` | where blocks your pool finds are paid |
| `feePercent` | taken off the **block reward**, never off a miner's balance |
| `allowlist` | `[]` is open to everyone; a list of addresses restricts it |
| `pplns.windowMultiplier` | N as a multiple of one block's work. 2 ≈ two rounds |
| `pplns.maturity` | **must be 100** — that is consensus, not policy |
| `vardiff.targetSeconds` | seconds between shares per miner. 15 is our number |
| `cliCommand` | how the pool talks to your node (see the warning below) |

Then:

```bash
./selftest.sh                   # end to end against a local node
node pool.mjs --config pool.config.json
```

---

## Three things that will bite you

These are not hypothetical. Each one cost us something.

### 1. Do not give the pool full RPC access

The obvious `cliCommand` is `bitcoin-cli -datadir=…`, which authenticates with
the node's cookie — and a cookie grants **every** RPC, including
`listdescriptors`, which returns the wallet's `xprv`. A pool is an
internet-facing service that parses hostile input. It must not hold a key to
the wallet.

Give it its own `rpcauth` identity with `rpcwhitelistdefault=0` and only the
methods it calls, and put the password in a `-conf` file rather than on the
command line — `argv` is world-readable through `ps`.

```
cliCommand: ["/path/to/bitcoin-cli", "-conf=/etc/your-pool/rpc.conf"]
```

Verify it by trying something not on the list; you want HTTP 403, not a result.

### 2. The share database is a financial record

Every accepted share is fsynced to SQLite **before** the miner is told OK. That
file is the only record of who is owed what. **Back it up like a wallet.** A
week of lost shares is how a pool loses its operator's money rather than its
users'.

Reconcile with `node payouts.mjs` and keep `pool-reconcile-watch.sh` running.

### 3. Payouts come out of the coinbase

The pool does not send transactions. It builds the block template so that the
**coinbase pays the miners directly**, which means the pool never holds a
spendable key for miner funds and cannot lose or steal them. It also means a
payout is only final once the coinbase matures — 100 blocks, roughly 17 hours —
and balances show as PENDING until then. Do not "fix" this by adding a hot
wallet; the absence of one is the security model.

---

## Tell people it exists

A pool nobody knows about does not reduce concentration. Once yours is running:

* Open an issue or PR on [the repo](https://github.com/pars5555/pcoin) and we
  will list it on pc.am alongside ours. **We want the competition** — that is
  not politeness, it is the only fix for the number in our own white paper.
* Submit it to MiningPoolStats and the other trackers.
* Say so in the [Telegram channel](https://t.me/PCoinPCN).

Miners point at a pool with one config line
(`poolurl=` on Windows, the same in the Linux miner config), so switching costs
them nothing. That cuts both ways: it is why concentration can persist, and why
it can also disappear in an afternoon.

---

## Solo mining is always an option

Nobody has to use any pool. The node ships with a built-in miner:

```
bitcoin-cli startmining "<your pc1q… address>" <threads>
```

That mines directly to your own address with no fee, no operator and no
counterparty. What you give up is predictability: at PCoin's current network
hashrate a small miner may wait a long time between blocks, and then receive a
whole one. A pool trades that variance for a fee — it does not increase what
you earn. On a chain this size, a healthy split between solo miners and several
pools is worth more than any individual's convenience.
