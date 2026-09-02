# Mining PCoin: what a RandomX miner needs to know

For anyone adding PCoin (`PCN`) support to mining software — XMRigCC, a pool, a
dashboard, or your own client. Everything here is checkable against the vectors
at the bottom and against a live endpoint.

**Short version:** PCoin is a Bitcoin Core fork with proof-of-work replaced by
RandomX. So the *hash* is Monero-shaped and everything *around* it is
Bitcoin-shaped. Integrations fail where those two habits meet, and this document
is mostly about those places.

---

## 1. The RandomX key never rotates

```
key = "PCoin/RandomX/v1"     (16 ASCII bytes, no NUL terminator)
```

Fixed on every network including regtest, and identical for every block since
genesis. **There is no seed height, no key rotation, and no dataset transition
to manage.**

Monero re-keys every 2048 blocks, so Monero miners carry seed-height arithmetic
and two VMs across each boundary. None of that applies here. Initialise once at
startup and never touch it again. Changing this key would be a hard fork.

## 2. What gets hashed is an 80-byte Bitcoin header

**Not a CryptoNote blob.** This is the single most common integration mistake.

The input is the canonical 80-byte serialised Bitcoin block header — byte for
byte the same bytes Bitcoin's double-SHA256 would consume:

| offset | size | field | encoding |
|---|---|---|---|
| 0 | 4 | version | int32 LE |
| 4 | 32 | prev block hash | internal (little-endian) order |
| 36 | 32 | merkle root | internal (little-endian) order |
| 68 | 4 | time | uint32 LE |
| 72 | 4 | nBits | uint32 LE |
| 76 | 4 | **nonce** | uint32 LE |

The miner varies **bytes 76..79** and nothing else. There is no extra nonce
inside the blob, and no CryptoNote `nonce offset 39`.

## 3. Block id and PoW hash are DIFFERENT hashes

```
block id  = SHA256d(header)      <- prev-block links, RPC, explorers
PoW hash  = RandomX(header)      <- the only thing compared to the target
```

A block's id is *not* its RandomX hash and will never look like it. Do not
display one as the other, and do not try to derive one from the other.

## 4. Target convention

Bitcoin's, not Monero's.

* `nBits` is Bitcoin's compact form. Expand it the usual way:
  `target = mantissa << (8 * (exponent - 3))`.
* A block is valid when the RandomX hash, **read as a 256-bit little-endian
  integer**, is `<= target`. That is the same convention `GetHash()` uses, so if
  you already compare a Bitcoin hash to a target you are already correct.
* powLimit is `0x000fffff...` = 2^244 − 1. Note that is far below Bitcoin's
  2^224, so difficulty-1 here is not difficulty-1 anywhere else — if you display
  a "difficulty" figure, say which unit it is in.

**Share targets are the network target multiplied by a factor.** Difficulty is
inversely proportional to target, so an *easier* share target is a *larger*
number. Getting that backwards makes every share also a block, which looks
perfect right up until nobody is paid for shares.

## 5. Test vectors

Real mainnet blocks. Feed the header to RandomX with the key above; the result
must match `rx_hash` exactly, and must be `<= target`.

```
height   3238
header   000000205c71a66a6cf94cd034b0205d5adbae3fb504fd7065e364ba2195cb5cb4dfd3d0
         b5b487e9c770e2e4d8469dfcbaa4afaadc9b616ce567d767f9e77670b1406f8e1f8f7d6a
         51a5021e09250000
target   000002a551000000000000000000000000000000000000000000000000000000
rx_hash  000000f211f8da29568c7a124e1c94698f0be2ff3695453aa13787b1f7ac6ad9
block id 1639cc4b2f8cbd22e6ef73133f3a5739468d4405b7b9332928546ab0062a82dc

height   3389
header   0000002077a3f697237998f06ed073885d0fd2aaee37d9fb7db9d038f05087a8e35b35b3
         1b5dfff4f64bf8b91f67840f79d135870d70d1e8390b236fd561e81c167aea9844897e6a
         8b7b621de1060000
target   000000627b8b0000000000000000000000000000000000000000000000000000
rx_hash  0000005fb9b980842c7812a8398883922004ee050535ded8c383a980895615b2
block id 8c90978ceb9a66cdd990159921f3c02ad90aca4da4bb5b9f590b51624a276b5e
```

`contrib/pool/vectors.txt` in the PCoin repository carries 100 more, and
`contrib/pool/selftest.sh` checks them **and** checks that a one-bit change to
the nonce is rejected — the half that actually proves a verifier works.

## 6. A live endpoint to test against

```
stratum   pool.pc.am:3333          plain TCP, no TLS
api       https://pool.pc.am/api/pools     MiningCore-shaped, CORS open
```

Protocol is the Monero-style stratum-like convention: JSON per line over raw
TCP, `login` / `job` / `submit` / `keepalived`.

```
-> {"id":1,"method":"login","params":{"login":"<pc1q… payout address>","pass":"x"}}
<- {"id":1,"result":{"id":"<session>","job":{...},"status":"OK"}}
-> {"id":2,"method":"submit","params":{"id":"<session>","job_id":"…","nonce":"xxxxxxxx"}}
<- {"id":2,"result":{"status":"OK"}}
<- {"jsonrpc":"2.0","method":"job","params":{...}}      pushed on a new tip
```

The job carries:

| field | meaning |
|---|---|
| `blob` | the 80-byte header as hex, **nonce field already zeroed** |
| `target` | 32-byte big-endian hex. A share must hash `<=` this |
| `job_id` | echo it back on submit |
| `height` | the height being worked on |
| `algo` | `rx/pcoin` |

`nonce` on submit is 8 hex characters: **the four bytes exactly as they sit at
offset 76**, in that order. This is the xmrig/Monero convention, so a
Monero-lineage miner needs no special case.

```
nonce value 83  ->  bytes at offset 76 are 53 00 00 00  ->  "53000000"
```

The reverse spelling (`"00000053"`, the uint32 as big-endian text) is what
PCoin's own node miner sends — `strprintf("%08x", nonce)` in
`src/node/poolclient.cpp`. **The pool accepts both** and uses whichever one
validates, so either spelling works today. New integrations should use the byte
order above; the legacy form is a compatibility fallback that will be removed
once no miner needs it.

This mattered: the pool originally accepted only the legacy spelling, so every
share from a standard xmrig was rebuilt into a header nobody had mined and
rejected as *"share above target"* — a miner that hashes perfectly and earns
nothing, with no error that points at the cause.

**The login is a payout address, not an account.** There is no registration.
It must be a v0 bech32 `pc1q…` address — a taproot `pc1p…` will pass a PCoin
node's own address check and then be refused by the pool, because payouts are
built as P2WPKH outputs.

## 7. Things that will surprise you

**No wallet is involved on the mining machine.** The address is where the pool
credits you; the miner holds no key.

**Miners are paid in the block's coinbase**, as one output each, at the moment
the block is found. There is no pool balance, no withdrawal, and therefore no
"minimum payout" beyond the network dust limit (294 sat) — below that a miner is
skipped for that block and paid by a later one.

**Coinbase maturity is 100 blocks** (~17 h). Coins are visible on the chain
immediately and cannot move until then. That is a consensus rule, not a pool
policy, and it applies identically to solo miners.

**Block timestamps are not monotonic in height.** LWMA retargets every block and
allows a limited future timestamp, so "time since last block" can come out
negative. Sort by height, not by time.

**Reorgs are routine at this size.** Anything walking the chain must handle them
from day one.

## 8. Or just run the node

The PCoin node has a CPU miner built in and speaks this protocol itself, so
"what do I run" already has an answer that needs no third-party software:

```
bitcoin-cli startpoolmining "pool.pc.am:3333" "<your pc1q… address>" 0
# (the .deb also installs a `pcoin-cli` alias for the same binary)
```

`0` threads means every core. Releases: <https://github.com/pars5555/pcoin/releases>

## 9. Miners that already support PCN

Status as of 2026-09-02. Check the miner's own release notes before trusting
this table; it is a snapshot.

| miner | status | how |
|---|---|---|
| **SRBMiner-Multi** | **supported** since 3.5.6 (2026-08-17) | `SRBMiner-MULTI --disable-gpu --algorithm randompcn --pool pool.pc.am:3333 --wallet <pc1q…> --cpu-threads N` |
| xmrigCC | pull request [#435](https://github.com/Bendr0id/xmrigCC/pull/435) open, unmerged | unofficial Linux build `rx-pcoin-v1` on the pars5555 fork; `-a rx/pcoin` |
| stock xmrig | does not work | speaks Monero's block format; no `rx/pcoin` algorithm |

SRBMiner's `randompcn` was verified against `pool.pc.am:3333` on 2026-09-02:
login accepted, jobs received, a share accepted at 1 thread. It charges its own
0.85% developer fee on this algorithm, separate from the pool's 2%. The pool does
not record the miner's `agent` string, so the API cannot tell you how many of the
connected miners are SRBMiner versus the node.

---

Questions, corrections, or a request for more vectors:
<https://github.com/pars5555/pcoin/issues>
