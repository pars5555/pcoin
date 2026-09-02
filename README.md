# PCoin (PCN) — the coin anyone can mine

PCoin is an independent Layer-1 blockchain — a fork of Bitcoin Core v29.4 with three consensus changes: proof-of-work is **RandomX**, the CPU-fair algorithm, so an ordinary phone or laptop is a first-class miner; difficulty is **LWMA**, retargeting every block from height 2800; and the future-block-time limit tightens from 2 hours to 15 minutes at and above that height. No ASIC farms, no premine, no investors.

Website: **https://pc.am** · Full technical manual: **[PCOIN.md](PCOIN.md)**

Live surfaces: explorer **https://explorer.pc.am** · mining pool **https://pool.pc.am** · buy from the ladder **https://market.pc.am** · wPCN on BNB Smart Chain via **https://wrapdesk.pc.am** · what accepts PCN and how to integrate: **https://docs.pc.am** · announcements **https://t.me/PCoinPCN**

## The mission

Money creation for ordinary people. If you own a phone or a laptop, you can mine PCN.

1. **Fair by physics.** RandomX (the Monero PoW algorithm) makes general-purpose CPUs
   the best miners, neutralizing ASICs and mostly neutralizing GPUs.
2. **Proven, boring economics.** Bitcoin's monetary rules, untouched: 21 million cap,
   halvings, 10-minute blocks. Nothing clever, nothing new to break.
3. **Community from zero.** Every node is equal. There is no premine and no company;
   the founder's role dissolves as the network grows.

## Key parameters

| Parameter | Value |
|---|---|
| Ticker | PCN |
| Launch | August 2026 |
| Consensus | Proof-of-work: RandomX, fixed key `PCoin/RandomX/v1`, light-mode (256 MB) verification; block IDs remain double-SHA256 |
| Supply | 21,000,000 PCN — 50 PCN subsidy, halving every 210,000 blocks |
| Blocks | 10-minute target, LWMA difficulty retarget every block from height 2800 (the legacy 2016-block retarget applies only below that height) |
| Mainnet ports | P2P 9444, RPC 9443 |
| Network magic | `cf a2 d1 b8` |
| Addresses | legacy start with `P` (base58 prefix 55); bech32 `pc1...` |
| Genesis | block ID `a95d51f0cbf25cad10c35961c6189356525d079835f02e83e2395f382fbe264a`, time `1785600628`, nBits `0x1f0fffff` (~4096 hashes/block at launch) |
| Config / data | `pcoin.conf` in `~/.pcoin` (Linux) or `%LOCALAPPDATA%\PCoin` (Windows) |
| Seed nodes | `seed.pc.am` (DNS seed, several addresses) plus compiled-in fixed seeds in `src/chainparamsseeds.h` |

PCoin is **not** a token and does not run on any other chain. It has its own genesis
block, network magic, ports, and address formats — a PCoin node can never connect to
or sync from the Bitcoin network.

## Quickstart (Linux)

**1. Get binaries.** Linux one-liner (verifies the download against the release's
`SHA256SUMS`, installs, and runs the setup wizard):
`curl -fsSL https://pc.am/dl/install.sh | sudo sh`. Windows, Android and plain
archives: https://pc.am/download. Or build from source — see
[PCOIN.md](PCOIN.md). Binaries keep their upstream names (`bitcoind`, `bitcoin-cli`).

**2. Run a node.** It auto-connects to the network via `seed.pc.am`:

```bash
mkdir -p ~/.pcoin
printf 'server=1\nrpcuser=pcoinrpc\nrpcpassword=CHANGE_ME_long_random\n' > ~/.pcoin/pcoin.conf
./bitcoind -daemon
./bitcoin-cli getblockchaininfo   # genesis: a95d51f0cbf25cad...264a
```

**3. Mine.** The built-in miner is all you need. (If you already run mining software:
[SRBMiner-Multi](https://github.com/doktor83/SRBMiner-Multi/releases) ≥ 3.5.6 mines PCN
natively against the pool with `--algorithm randompcn --pool pool.pc.am:3333`; stock xmrig does
**not** work — it speaks Monero's protocols — see `contrib/pool/MINER-INTEGRATION.md` §9.)

```bash
./bitcoin-cli createwallet "main"
ADDR=$(./bitcoin-cli getnewaddress)
./bitcoin-cli startpoolmining "pool.pc.am:3333" "$ADDR" 0   # 0 = all cores
# or solo, all cores: ./bitcoin-cli startmining "$ADDR" 0
# status either way:  ./bitcoin-cli getcpuminerinfo
```

Difficulty now tracks the whole network's CPUs (LWMA, every block since height
2800), so a single CPU mining solo sees a block only every few days or longer. For a
steady share use the pool — it pays in the coinbase, and the fee is shown on
https://pool.pc.am. Rewards mature after 100 confirmations (`bitcoin-cli getbalance`).

## Roadmap (near term)

- ~~Android node + miner app~~ shipped — https://pc.am/download
- ~~First real-world micro-payments~~ services accept PCN today — https://docs.pc.am
- 100 independent nodes
- Community-run seed nodes
- In-browser wallet

## Honest disclosures

PCoin is a young, experimental chain — **it is not an investment**. A small, thin
market exists (https://price.pc.am posts the rate the payment rails use; wPCN trades
on PancakeSwap via https://wrapdesk.pc.am) and any price can be moved by one party.
Like any small PoW network, its security grows with the number of independent
participants; with few miners, a 51% attack is cheap.
There is no premine and no sale, but the founder's own machines mined a large share
of the early supply. The distribution is public and checkable at any time at
https://explorer.pc.am/api/addresses/top — read that, not this sentence. The entire
source is public and MIT-licensed — audit it yourself.

## License and acknowledgment

PCoin is based on [Bitcoin Core](https://github.com/bitcoin/bitcoin) v29.4 and would
not exist without its developers' work. Released under the MIT license — see
[COPYING](COPYING). RandomX is the work of [tevador and
contributors](https://github.com/tevador/RandomX).

## Contributing

Contributions are welcome — run a node, review the code, open issues and pull
requests at https://github.com/pars5555/pcoin. The most valuable contribution right
now is simply running an always-on node.
