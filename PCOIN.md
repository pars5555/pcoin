# PCoin (PCN)

PCoin is an **independent Layer-1 blockchain**, forked from **Bitcoin Core v29.4**
(upstream tag `v29.4`, branch `pcoin` in this repo). It is *not* a Bitcoin sidechain,
token, or testnet — it has its own genesis block, its own network magic, its own
ports and address formats, and therefore its own completely separate P2P network
and coin supply. A PCoin node will never connect to, or sync from, the Bitcoin
network, and PCN cannot collide with BTC addresses or transactions.

Consensus economics are deliberately **identical to Bitcoin**: 21 million coin cap,
50 PCN block subsidy, halving every 210,000 blocks, 10-minute target spacing,
2016-block difficulty retarget. The proof of work, however, is **RandomX** (the
CPU-friendly, ASIC-resistant algorithm pioneered by Monero) instead of SHA-256d
— see §5 and "Why RandomX" below. Beyond the PoW function, what changed is the
network *identity*, not the monetary rules.

## 1. Identity

| Parameter | Value |
|---|---|
| Name | PCoin |
| Ticker / currency unit | PCN |
| Client name | PCoin Core (binaries still named `bitcoind.exe` etc. — see §7) |
| Forked from | Bitcoin Core v29.4 |
| Proof of work | RandomX (v1: fixed key `PCoin/RandomX/v1`, light-mode verification). Block **IDs** remain double-SHA256 — only the PoW validity check uses RandomX. |
| Max supply | 21,000,000 PCN |
| Block subsidy | 50 PCN, halving every 210,000 blocks |
| Block target spacing | 600 s (10 minutes) |
| Difficulty retarget | every 2016 blocks |
| Genesis timestamp string | `PCoin 01/Aug/2026 an independent chain is born` |
| Genesis nTime | `1785600628` (all networks) |
| Genesis merkle root | `a7cf99f4692673756afae432320aaa2fcc3a50638b50962bcf12d37b3a56171f` (all networks) |
| PoW limit (main/testnets/signet) | `000fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff` (regtest keeps upstream `7fffff...`) |
| Legacy address prefix (main) | base58 pubkey `55` → addresses start with `P`; script `56`; WIF secret `183` |
| Legacy address prefix (testnets) | base58 pubkey `117`, script `118`, WIF secret `245` |
| Bech32 HRP | main `pc1...`, testnets `tpc1...`, regtest `pcrt1...` |
| Signed-message magic | `PCoin Signed Message:\n` |
| Data directory | Windows `%LOCALAPPDATA%\PCoin` (falls back to `%APPDATA%\PCoin` if it already exists), Linux `~/.pcoin`, macOS `~/Library/Application Support/PCoin` |
| Config file | `pcoin.conf` |

### Per-network parameters

| Network | P2P port | RPC port | Magic bytes | Genesis nBits | Genesis nNonce |
|---|---|---|---|---|---|
| main | 9444 | 9443 | `cf a2 d1 b8` | `0x1f0fffff` | 3321 |
| testnet (v3) | 19444 | 19443 | `cf a3 d2 b9` | `0x1f0fffff` | 100011047 |
| testnet4 | 29444 | 29443 | `cf a4 d3 ba` | `0x1f0fffff` | 200003229 |
| signet | 39444 | 39443 | computed from signet challenge (upstream mechanism, unchanged) | `0x1f0fffff` | 300001160 |
| regtest | 49444 | 49443 | `cf a5 d4 bb` | `0x207fffff` | 400000001 |

RPC sits at P2P−1 (like Bitcoin's 8332/8333) because P2P+1 is reserved by
bitcoind's default Tor onion listener on 127.0.0.1.

**Signet caveat:** the *default* signet deliberately keeps Bitcoin's signet
challenge (per spec), so its derived magic bytes are identical to Bitcoin
signet's (`0a 03 cf 40`) and new blocks would need signatures from Bitcoin's
signet operators — i.e. the default PCoin signet can never produce blocks.
(The genesis block, ports, and address prefixes are still PCoin's, so it can
never sync from Bitcoin signet either.) To run a usable PCoin signet, start
all nodes with your own `-signetchallenge=<hex script>`; the magic is then
derived from your challenge automatically.

### Genesis block hashes

The **genesis hash** is the block ID (double-SHA256 of the header) — it is what
appears in `getblockchaininfo`, prev-block links, and the chainparams asserts.
The **RandomX PoW hash** is the separate value that must satisfy the nBits
target; it is listed here for reference only and never appears as a block ID.

| Network | Genesis hash (block ID, SHA-256d) | Genesis RandomX PoW hash |
|---|---|---|
| main | `a95d51f0cbf25cad10c35961c6189356525d079835f02e83e2395f382fbe264a` | `000e8b8c3cfa5120f8c7b61df79e13d87cfa00a711228e8047a0390d38a7c285` |
| testnet | `216e2226749946617ed53e3861ea45bd6dc9d417a88ce8a702c6dd7508c0a549` | `000dcd9bccf95033bc7d036bb2ed80dc8ee4b30aebbe0199b24505f190642c34` |
| testnet4 | `a2bd065af17c77eb6685356f3ccd85cd5f081285fc64ff08d2a25756bc397456` | `00005ed694ab63bc3e99e599a34754cc6e98746c993251c83888aab5d2b4b249` |
| signet | `1674cce1aecdcc3b22c6f445f4acb257167bf058b73123198fbc962f15c62622` | `0004f544c95e55302b834d7990a3bea28290cf6e6fa1dae46277aa2d1b8f09f7` |
| regtest | `8585eb65ae0d6bb5d1778aec77f0f2ecd589e15f5083430805b865a4ecbbfb3c` | `59fdf5148be1599e7c13d3b804da9daaf9dec901f07102daa083a07c7b7834fe` |

(Block IDs no longer start with zeros — they don't have to, since the block ID
is not the value checked against the target anymore. The RandomX PoW hash is.)

Note: `0x1f0fffff` (target `000fffff` followed by 56 zeros) means **~4096
expected hashes per block** at genesis. A normal CPU does hundreds of RandomX
hashes per second in light mode, so that's seconds per block — even a phone can
bootstrap the chain. Regtest keeps `0x207fffff` (~1–2 hashes per block).
Difficulty then self-adjusts every 2016 blocks (max 4× per period).

### Why RandomX

RandomX is deliberately **CPU-fair**: it executes randomly generated programs
over a large memory working set, which kills the efficiency edge of ASICs and
mostly neutralizes GPUs — the best miner for it *is* a general-purpose CPU.
Verification runs in light mode with a 256 MB cache, which fits comfortably on
a modern phone, so phones can meaningfully mine. Honest numbers: a desktop
mines with the 2 GB dataset (fast mode) that does not fit on a phone, so
expect a desktop to be roughly 20–50× faster than a phone in light mode —
still nothing like the millions-to-one advantage an ASIC has under SHA-256.
Difficulty
self-adjusts every 2016 blocks, so the network settles at whatever hashrate its
CPUs actually provide.

## 2. What was changed vs upstream v29.4

No monetary or script consensus rules were altered. Besides identity/bootstrap
changes there is exactly **one** real consensus change: the proof-of-work
function (SHA-256d → RandomX, rows marked below).

| File | Change |
|---|---|
| `src/kernel/chainparams.cpp` | The core of the fork, for all five chains (main/testnet/testnet4/signet/regtest): new `pszTimestamp`; new genesis parameters (`nTime=1785600628`, per-network `nNonce`/`nBits` as in the tables above) and updated genesis-hash/merkle-root asserts; new `pchMessageStart` magic bytes (signet magic remains derived from the challenge); new `nDefaultPort` per network; `powLimit` set to `000fff...` (regtest keeps `7fffff...`); base58 prefixes (55/56/183 main, 117/118/245 testnets); bech32 HRPs `pc`/`tpc`/`pcrt`; **DNS seeds (`vSeeds`): mainnet carries a single entry, `seed.pc.am` (the project's initial seed) — all other networks cleared**; **fixed seeds (`vFixedSeeds`) cleared**; **checkpoints cleared**; `nMinimumChainWork` and `defaultAssumeValid` zeroed; `chainTxData` zeroed; buried softfork deployments (BIP34, BIP65, BIP66, CSV, SegWit) set active from height 1 (regtest keeps upstream defaults, incl. SegWit from height 0; Taproot active from genesis on every chain via the usual `ALWAYS_ACTIVE` mechanism). |
| `src/chainparamsbase.cpp` | Default RPC ports: 9443 / 19443 / 29443 / 39443 / 49443 (P2P−1; P2P+1 stays free for the default Tor onion listener). |
| `src/chainparamsseeds.h` | File itself is unmodified (still contains Bitcoin's seed IPs), but it is no longer `#include`d anywhere — `chainparams.cpp` dropped the include and every chain calls `vFixedSeeds.clear()`, so no Bitcoin seed address is ever used (PCoin's own bootstrap is the mainnet DNS seed `seed.pc.am` instead; see §4). |
| `src/randomx/` **(PoW)** | Vendored RandomX v1.2.x (tevador/RandomX) — the PoW hash library, built as part of the tree. |
| `src/crypto/pow_randomx.{h,cpp}` **(PoW)** | RandomX wrapper. Fixed key (the RandomX "K" input): the ASCII string `PCoin/RandomX/v1` (16 bytes, no NUL terminator), identical on **all** networks including regtest; key rotation would be a later hard fork — v1 is fixed-key. Verification uses RandomX **light mode** (256 MB cache, no 2 GB dataset): `randomx_alloc_cache()` with the machine-appropriate flags from `randomx_get_flags()` (auto-detected JIT / hardware AES / Argon2 SSSE3/AVX2; falls back to `RANDOMX_FLAG_DEFAULT` if that allocation fails) + `randomx_init_cache(key)` once under `std::call_once`, then a `thread_local` `randomx_vm` per thread sharing that cache. `RANDOMX_FLAG_JIT` is used when available, with a mandatory fallback to the interpreter (`RANDOMX_FLAG_DEFAULT`) if JIT allocation fails — some environments block W^X pages. |
| `src/pow.cpp`, `src/validation.cpp` **(PoW)** | PoW *check* routed to RandomX: a block satisfies PoW iff `RandomX_hash(80-byte serialized header)`, interpreted as a **little-endian** 256-bit integer (exactly the same byte-order convention as the existing uint256-from-bytes + `UintToArith256` path), is ≤ the nBits target. The block **ID** (`CBlockHeader::GetHash`, prev-block links, genesis asserts, RPC block hashes) stays double-SHA256 and was deliberately not touched. |
| `src/common/args.cpp` | `BITCOIN_CONF_FILENAME = "pcoin.conf"`; `GetDefaultDataDir()` returns `AppData\Local\PCoin` (Windows), `~/.pcoin` (Unix), `~/Library/Application Support/PCoin` (macOS). |
| `src/common/signmessage.cpp` | `MESSAGE_MAGIC = "PCoin Signed Message:\n"` — PCN message signatures are not valid Bitcoin signatures and vice versa. |
| `src/policy/feerate.h` | `CURRENCY_UNIT = "PCN"` (fee rates display as PCN/kvB). |
| `src/qt/bitcoinunits.cpp` | GUI unit labels: PCN / mPCN / µPCN. |
| `CMakeLists.txt` | `CLIENT_NAME` set to `PCoin Core` (shows up in version strings and the user agent); `project()` renamed `PCoinCore`; `HOMEPAGE_URL` set to the placeholder `https://pcoin.example/` (RFC 2606 reserved TLD, feeds `CLIENT_URL` in `--version` output and the Windows installer — replace once a real project site exists). |

**Not** changed: executable names (`bitcoind`, `bitcoin-cli`, `bitcoin-qt`,
`bitcoin-wallet`, ...), Qt icons/artwork, tests, docs. See §7.

## 3. Building

### Option A — Windows native (MSVC + vcpkg)

Per `doc/build-windows-msvc.md`. Requirements: Visual Studio (2022 17.6+ works;
this machine has **Visual Studio Community 2026** which also works) with the
"Desktop development with C++" workload, which bundles CMake and vcpkg.

Open a **Developer PowerShell for VS** (this sets up the compiler and
`VCPKG_ROOT`, which the CMake presets rely on), then:

```powershell
cd D:\xampp\htdocs\pcoin

# See available presets (all set BUILD_GUI=ON by default)
cmake --list-presets

# Static linking, with GUI:
cmake -B build --preset vs2022-static
cmake --build build --config Release -j 8
ctest --test-dir build --build-config Release   # optional; some tests skipped without Python 3

# Or: dynamic linking, daemon/CLI only (faster):
cmake -B build --preset vs2022 -DBUILD_GUI=OFF
cmake --build build --config Release -j 8
```

**The first configure step builds all vcpkg dependencies from source and can
easily take an hour or more.** Later builds reuse the vcpkg binary cache and are
fast.

Notes straight from the repo doc:

* The presets use the `Visual Studio 17 2022` generator. If CMake can't find a
  VS2022 instance under VS 2026, override the generator:
  `cmake -B build --preset vs2022-static -G "Visual Studio 18 2026"`.
* "Buildtrees path ... is too long" error →
  `cmake -B build --preset vs2022-static -DVCPKG_INSTALL_OPTIONS="--x-buildtrees-root=C:\vcpkg"`
* Repo path contains spaces →
  `-DVCPKG_INSTALLED_DIR="C:\path_without_spaces"`
* Speed up configure by skipping unused vcpkg features:
  `cmake -B build --preset vs2022 -DVCPKG_MANIFEST_NO_DEFAULT_FEATURES=ON -DVCPKG_MANIFEST_FEATURES="wallet;tests" -DBUILD_GUI=OFF`
* Add the repo directory to Microsoft Defender exclusions — it noticeably speeds
  up the build.

Binaries land in `build\bin\Release\` (`bitcoind.exe`, `bitcoin-cli.exe`,
`bitcoin-qt.exe`, ...).

### Option B — WSL2 Ubuntu

Per `doc/build-unix.md`. In your Ubuntu shell:

```bash
# Build requirements
sudo apt-get install build-essential cmake pkgconf python3

# Required libraries
sudo apt-get install libevent-dev libboost-dev

# Descriptor wallet (you want this)
sudo apt install libsqlite3-dev

# Optional: ZMQ notifications (build with -DWITH_ZMQ=ON)
sudo apt-get install libzmq3-dev

# Optional: GUI (build with -DBUILD_GUI=ON)
sudo apt-get install qtbase5-dev qttools5-dev qttools5-dev-tools
sudo apt install qtwayland5              # Wayland desktops
sudo apt-get install libqrencode-dev     # QR codes; or pass -DWITH_QRENCODE=OFF
```

Then build (from a Linux path like `~/pcoin` — compiling on `/mnt/d/...` is much
slower; `git clone /mnt/d/xampp/htdocs/pcoin ~/pcoin` works fine):

```bash
cd ~/pcoin
cmake -B build                 # add -DBUILD_GUI=ON for the GUI, -DENABLE_WALLET=OFF for a walletless P2P node
cmake --build build -j "$(nproc)"
ctest --test-dir build         # optional
./build/bin/bitcoind --version # should say PCoin Core
```

Berkeley DB is only needed for legacy wallets — skip it; descriptor wallets use
SQLite.

## 4. Run your first node

Everything is namespaced by the new datadir, so PCoin never touches an existing
Bitcoin installation.

Create the datadir and config:

```powershell
# Windows
mkdir "$env:LOCALAPPDATA\PCoin"
notepad "$env:LOCALAPPDATA\PCoin\pcoin.conf"
```

```bash
# WSL/Linux
mkdir -p ~/.pcoin && nano ~/.pcoin/pcoin.conf
```

Minimal `pcoin.conf`:

```ini
# --- RPC ---
server=1
rpcuser=pcoinrpc
rpcpassword=change_this_to_a_long_random_string

# --- P2P ---
listen=1
# Mainnet finds peers automatically via the DNS seed (seed.pc.am) — no config
# needed. addnode= lines are an optional fallback on mainnet, and REQUIRED on
# testnets/regtest (see below). One line per known node:
# addnode=203.0.113.5:9444

# Optional quality-of-life
daemon=0
txindex=1
```

Start the node:

```powershell
.\build\bin\Release\bitcoind.exe
# or with an explicit datadir:
.\build\bin\Release\bitcoind.exe -datadir=D:\pcoin-data
```

Defaults are already PCoin's: P2P listens on **9444**, RPC on **9443** (main).
If you use a custom `-datadir`, pass the same `-datadir` to every
`bitcoin-cli` call too.

Check it:

```powershell
.\build\bin\Release\bitcoin-cli.exe getblockchaininfo
# "blocks": 0, "bestblockhash": "a95d51f0cbf25cad...264a"  <- the PCoin genesis
```

### Connecting a second machine

**Mainnet has automatic peer discovery.** `vSeeds` in
`src/kernel/chainparams.cpp` contains the project's initial DNS seed,
**`seed.pc.am`** — currently a plain A record pointing at one public node
(`35.239.156.16`), which is all a starter seed needs to be. On startup, when a
fresh node has no peers to try, Bitcoin Core's `ThreadDNSAddressSeed` resolves
that name and uses the returned addresses as candidate peers, so a fresh
mainnet node finds the network on its own. `-connect`/`-addnode` remain
available as a manual fallback (e.g. `-addnode=seed.pc.am`) if DNS is blocked
or the seed is down.

**Testnet/testnet4/signet/regtest still have zero automatic peer discovery** —
their `vSeeds` are empty and all hard-coded fixed seeds were removed on every
network. On those chains a node will sit alone forever unless you tell it where
a peer is, via `-connect`, `-addnode`, or the `addnode` RPC. The same manual
wiring is how you build a deliberately private two-node setup on any network.
Once two nodes are connected, normal address gossip (addrman) takes over and
they share any further peers they learn about.

On the second machine (replace `203.0.113.5` with node #1's IP):

```powershell
# connect ONLY to this peer (good for a private 2-node setup):
bitcoind.exe -connect=203.0.113.5:9444

# or: connect to this peer but still accept/discover others (normal operation):
bitcoind.exe -addnode=203.0.113.5:9444

# or at runtime:
bitcoin-cli.exe addnode "203.0.113.5:9444" add
bitcoin-cli.exe getpeerinfo
```

On node #1, open TCP 9444 in Windows Defender Firewall (or your VPS security
group), and make sure `listen=1` is set (it is the default when `-connect` is
not used).

## 5. Mine the first blocks

Because the PoW is RandomX — a CPU algorithm — the **built-in miner is all you
need**: `bitcoin-cli generatetoaddress` grinds *real* RandomX blocks on **any**
network, mainnet included. It is single-threaded and uses the light-mode
verifier (256 MB cache, hundreds of hashes/second), which is perfectly adequate
at the launch difficulty of ~4096 expected hashes per block. A dedicated
multi-threaded miner is future work.

Do **not** reach for external miners:

* **xmrig does NOT work.** It also mines RandomX, but it speaks Monero's
  stratum/RPC protocols and Monero's block format — it cannot talk to a PCoin
  node.
* All the old SHA-256d tooling (cpuminer, ASICs, ckpool/public-pool, ...) is
  now irrelevant: the PoW is not SHA-256d anymore, so those miners produce
  hashes the network simply rejects.

### 5a. Wallet + address first

```powershell
bitcoin-cli.exe createwallet "main"
bitcoin-cli.exe getnewaddress
# -> pc1q...           (native segwit, default)
bitcoin-cli.exe getnewaddress "" legacy
# -> P...              (base58 P2PKH — note the P prefix)
```

### 5b. Regtest: near-instant blocks for testing

```powershell
.\build\bin\Release\bitcoind.exe -regtest -daemon         # WSL; on Windows omit -daemon and use a 2nd terminal
.\build\bin\Release\bitcoin-cli.exe -regtest createwallet "test"
$addr = .\build\bin\Release\bitcoin-cli.exe -regtest getnewaddress
.\build\bin\Release\bitcoin-cli.exe -regtest generatetoaddress 101 $addr
.\build\bin\Release\bitcoin-cli.exe -regtest getbalance   # 50 PCN spendable
```

101 blocks because coinbase outputs need 100 confirmations to mature — after
101 blocks, exactly the first block reward (50 PCN) is spendable. Regtest uses
ports 49444/49443 and its own `regtest/` subdirectory in the datadir, so it
never touches your mainnet data. Regtest's `0x207fffff` target needs only ~1–2
RandomX hashes per block, so the 101 blocks still land in seconds even though
each one is genuinely RandomX-mined now.

### 5c. Mainnet: first real blocks

With the node from §4 running:

```powershell
bitcoin-cli.exe createwallet "main"
$addr = bitcoin-cli.exe getnewaddress
bitcoin-cli.exe generatetoaddress 1 $addr
# -> [ "…block hash…" ]
```

At launch difficulty (`0x1f0fffff`, ~4096 expected hashes) each call takes
**seconds to a few minutes** on a typical CPU — the single light-mode thread
does a few hundred hashes per second, and mining is a lottery, so individual
blocks vary. Don't be alarmed if one call sits for a while. Repeat (or loop)
`generatetoaddress 1 $addr` to keep building the chain; difficulty climbs at
each 2016-block retarget (capped at 4× per period) until it matches the
network's actual hashrate, so blocks get progressively slower to grind. Watch
progress with:

```powershell
bitcoin-cli.exe getblockcount
bitcoin-cli.exe getmininginfo
bitcoin-cli.exe getbalance      # rewards mature after 100 blocks
```

## 6. Why nodes and servers matter

* **Seed nodes vs regular nodes.** There is no special "seed node" software — a
  seed is just an ordinary, always-on, publicly reachable node whose address
  everyone knows (on mainnet, published as the DNS name `seed.pc.am`; on
  testnets, still shared as `addnode=` lines). Every node stores the full
  chain, validates every block, and relays transactions; the seed's only extra
  job is being findable.
* **What happens if every node goes offline?** The chain *pauses* — no blocks,
  no transactions. Nothing is lost: the entire ledger sits in the `blocks/` and
  `chainstate/` folders of every node's datadir. The moment any one node comes
  back online, the chain resumes exactly where it stopped, and new nodes can
  sync the full history from it. PCoin only truly dies if **every copy of the
  datadir on every machine is deleted**. Your coins are entries in that shared
  ledger, and your keys are in your `wallets/` folder — back that folder up.
* **Practical implication.** The moment you invite anyone else, run **1–2
  always-on nodes** — a small VPS (2 GB RAM, ~20 GB disk is plenty for a young
  chain) with TCP 9444 open, `listen=1`, and a static IP. Add their IPs as
  extra A records behind `seed.pc.am` (so mainnet DNS bootstrap returns them
  too), and optionally publish them as fallback `addnode=` lines. Two nodes in
  different locations means one can reboot without the network becoming
  unreachable for newcomers.

## 7. Honest next steps and warnings

* **The chain is NOT secure.** Security of a PoW chain equals the cost of
  out-mining it. RandomX removes the *ASIC* threat, not the *51%* threat: with
  only a handful of CPUs mining, anyone who rents a few dozen cloud CPU cores
  (or points a modest botnet at it) can 51%-attack PCoin — rewrite history,
  double-spend, censor. Until meaningful independent hashrate exists, treat
  PCN as **educational — assign it no monetary value and accept none for it.**
  Do not list it, sell it, or promise anything about it.
* **Legal.** Issuing or distributing a currency can trigger money-transmission,
  securities, tax, and consumer-protection law depending on your jurisdiction
  and what you do with it (selling, exchanging, promoting). Mining blocks on
  your own machines for learning is generally uncontroversial; anything
  involving other people's money is not. Get real legal advice before going
  beyond a hobby network.
* **Intentionally NOT done yet** (so nobody is surprised):
  * Binaries keep upstream names: `bitcoind.exe`, `bitcoin-cli.exe`,
    `bitcoin-qt.exe`, `bitcoin-wallet.exe` (rename = CMake target churn, left
    for later).
  * Qt GUI still shows Bitcoin icons/artwork/splash (only unit labels changed).
  * No real DNS seeder (crawler) — mainnet bootstraps off a single static DNS
    seed, `seed.pc.am` (a plain A record pointing at one node); testnets still
    need manual `-addnode`/`-connect` (§4).
  * No block explorer, no checkpoints, no `assumevalid`/minimum-chainwork
    anchors (they're zeroed — fine for a young chain, revisit once there's
    history worth anchoring).
  * No release/packaging pipeline, no code signing, no reproducible-build
    attestations.
* **Sensible order of next steps:** run two VPS nodes → mine a few thousand
  blocks → back up wallets → add more seed nodes behind `seed.pc.am` and stand
  up a proper crawling DNS seeder + explorer → re-brand binaries and GUI →
  only then think about inviting the public.
