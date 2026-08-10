# PCoin (PCN)

PCoin is an **independent Layer-1 blockchain**, forked from **Bitcoin Core v29.4**
(upstream tag `v29.4`, branch `pcoin` in this repo). It is *not* a Bitcoin sidechain,
token, or testnet — it has its own genesis block, its own network magic, its own
ports and address formats, and therefore its own completely separate P2P network
and coin supply. A PCoin node will never connect to, or sync from, the Bitcoin
network, and PCN cannot collide with BTC addresses or transactions.

Consensus economics are deliberately **identical to Bitcoin**: 21 million coin cap,
50 PCN block subsidy, halving every 210,000 blocks, 10-minute target spacing,
per-block LWMA difficulty retarget from height 2800. The proof of work, however, is **RandomX** (the
CPU-friendly, ASIC-resistant algorithm pioneered by Monero) instead of SHA-256d
— see §5 and "Why RandomX" below. Beyond the PoW function, what changed is the
network *identity*, not the monetary rules.

## 1. Identity

| Parameter | Value |
|---|---|
| Name | PCoin |
| Ticker / currency unit | PCN |
| Client name | PCoin Core (binaries still named `bitcoind.exe` etc. — see §8) |
| Forked from | Bitcoin Core v29.4 |
| Proof of work | RandomX (v1: fixed key `PCoin/RandomX/v1`, light-mode verification). Block **IDs** remain double-SHA256 — only the PoW validity check uses RandomX. |
| Max supply | 21,000,000 PCN |
| Block subsidy | 50 PCN, halving every 210,000 blocks |
| Block target spacing | 600 s (10 minutes) |
| Difficulty retarget | LWMA, **every block**, from height 2800 on mainnet (`lwmaHeight`); legacy 2016-block retarget below that height. LWMA from height 1 on testnet/testnet4/signet; disabled on regtest (`INT_MAX`) |
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
Difficulty then self-adjusts: every 2016 blocks below height 2800, and every block via LWMA at and above 2800 (increase capped at 3x/block, decrease at 12x/block).

### Why RandomX

RandomX is deliberately **CPU-fair**: it executes randomly generated programs
over a large memory working set, which kills the efficiency edge of ASICs and
mostly neutralizes GPUs — the best miner for it *is* a general-purpose CPU.
Verification runs in light mode with a 256 MB cache, which fits comfortably on
a modern phone, so phones can meaningfully mine.

Measured hashrates (RandomX v1.2.1, JIT enabled, 4 threads, light mode unless
noted) — these are real measurements, not estimates:

| Device | H/s | 256 MB cache init |
|---|---|---|
| Desktop (16 threads, 2 GB **fast** mode) | 2518 | 3.4 s |
| Desktop (4 threads, light mode) | 178 | 0.7 s |
| Galaxy Z Flip 5 / Snapdragon 8 Gen 2 | 144 | 0.7 s |
| Pixel 4a / Snapdragon 730G | 51 | 2.0 s |
| moto g play 2024 | 43 | 3.1 s |
| Galaxy A03 / Helio P35 | 15 | 5.4 s |

A full-speed desktop out-mines a flagship phone ~17× and an entry-level phone
~170× — nothing like the millions-to-one advantage an ASIC has under SHA-256.
Note the flagship phone in light mode is within 1.25× of this desktop in light
mode; the desktop's real advantage comes from the 2 GB dataset phones cannot
hold. All devices produced bit-identical RandomX results, so phones validate
consensus exactly as x86 does.

Difficulty self-adjusts every block under LWMA (from height 2800 on mainnet), so the network settles at whatever hashrate its CPUs actually provide.

## 2. What was changed vs upstream v29.4

No monetary or script consensus rules were altered. Besides identity/bootstrap
changes there are **two** real consensus changes: the proof-of-work
function (SHA-256d → RandomX, rows marked below).

| File | Change |
|---|---|
| `src/kernel/chainparams.cpp` | The core of the fork, for all five chains (main/testnet/testnet4/signet/regtest): new `pszTimestamp`; new genesis parameters (`nTime=1785600628`, per-network `nNonce`/`nBits` as in the tables above) and updated genesis-hash/merkle-root asserts; new `pchMessageStart` magic bytes (signet magic remains derived from the challenge); new `nDefaultPort` per network; `powLimit` set to `000fff...` (regtest keeps `7fffff...`); base58 prefixes (55/56/183 main, 117/118/245 testnets); bech32 HRPs `pc`/`tpc`/`pcrt`; **DNS seeds (`vSeeds`): mainnet carries a single entry, `seed.pc.am` (the project's initial seed) — all other networks cleared**; **fixed seeds (`vFixedSeeds`): mainnet loads PCoin's own three entries from `chainparamsseeds.h`; testnet/testnet4/signet/regtest cleared**; **checkpoints cleared**; `nMinimumChainWork` and `defaultAssumeValid` zeroed; `chainTxData` zeroed; buried softfork deployments (BIP34, BIP65, BIP66, CSV, SegWit) set active from height 1 (regtest keeps upstream defaults, incl. SegWit from height 0; Taproot active from genesis on every chain via the usual `ALWAYS_ACTIVE` mechanism). |
| `src/chainparamsbase.cpp` | Default RPC ports: 9443 / 19443 / 29443 / 39443 / 49443 (P2P−1; P2P+1 stays free for the default Tor onion listener). |
| `src/chainparamsseeds.h` | Rewritten: Bitcoin's ~2031 mainnet seeds replaced by PCoin's own three BIP155-encoded fixed seeds (35.239.156.16, 35.238.47.14, 178.105.3.51, all :9444). The file **is** `#include`d by `kernel/chainparams.cpp` and mainnet loads it into `vFixedSeeds` as a fallback for when DNS seeding yields nothing; only the test networks and regtest call `vFixedSeeds.clear()`. Regenerate from `contrib/seeds/nodes_main.txt` via `contrib/seeds/generate-seeds.py`. |
| `src/randomx/` **(PoW)** | Vendored RandomX v1.2.x (tevador/RandomX) — the PoW hash library, built as part of the tree. |
| `src/crypto/pow_randomx.{h,cpp}` **(PoW)** | RandomX wrapper. Fixed key (the RandomX "K" input): the ASCII string `PCoin/RandomX/v1` (16 bytes, no NUL terminator), identical on **all** networks including regtest; key rotation would be a later hard fork — v1 is fixed-key. Verification uses RandomX **light mode** (256 MB cache, no 2 GB dataset): `randomx_alloc_cache()` with the machine-appropriate flags from `randomx_get_flags()` (auto-detected JIT / hardware AES / Argon2 SSSE3/AVX2; falls back to `RANDOMX_FLAG_DEFAULT` if that allocation fails) + `randomx_init_cache(key)` once under `std::call_once`, then a `thread_local` `randomx_vm` per thread sharing that cache. `RANDOMX_FLAG_JIT` is used when available, with a mandatory fallback to the interpreter (`RANDOMX_FLAG_DEFAULT`) if JIT allocation fails — some environments block W^X pages. |
Row is accurate but incomplete, and the §2 table omits every LWMA and miner change. Missing rows (all confirmed changed vs v29.4): `src/pow.{h,cpp}` (+264/+38, LwmaGetNextWorkRequired and the DO-NOT-MODIFY legacy overflow), `src/consensus/params.h` (+40, lwmaHeight/nLwmaAveragingWindow/nLwmaMaxSolvetime/nLwmaMaxFutureBlockTime), `src/chain.h` (+27, LWMA_MAX_FUTURE_BLOCK_TIME), `src/deploymentinfo.cpp` (+4, DEPLOYMENT_LWMA), `src/node/cpuminer.{h,cpp}` (new, +437), `src/rpc/mining.cpp` (+129, startmining/stopmining/getcpuminerinfo), `src/init.cpp` (+18, RandomXPowInit), `src/net_processing.cpp` (+19), `src/node/blockstorage.cpp` (+23), `src/rpc/client.cpp` (+2), `src/chainparams.cpp` (+1), `src/kernel/chainparams.h` (+7), `src/CMakeLists.txt`/`src/crypto/CMakeLists.txt`/`src/kernel/CMakeLists.txt`. (exactly the same byte-order convention as the existing uint256-from-bytes + `UintToArith256` path), is ≤ the nBits target. The block **ID** (`CBlockHeader::GetHash`, prev-block links, genesis asserts, RPC block hashes) stays double-SHA256 and was deliberately not touched. |
| `src/common/args.cpp` | `BITCOIN_CONF_FILENAME = "pcoin.conf"`; `GetDefaultDataDir()` returns `AppData\Local\PCoin` (Windows), `~/.pcoin` (Unix), `~/Library/Application Support/PCoin` (macOS). |
| `src/common/signmessage.cpp` | `MESSAGE_MAGIC = "PCoin Signed Message:\n"` — PCN message signatures are not valid Bitcoin signatures and vice versa. |
| `src/policy/feerate.h` | `CURRENCY_UNIT = "PCN"` (fee rates display as PCN/kvB). |
| `src/qt/bitcoinunits.cpp` | GUI unit labels: PCN / mPCN / µPCN. |
| `CMakeLists.txt` | `CLIENT_NAME` set to `PCoin Core` (shows up in version strings and the user agent); `project()` renamed `PCoinCore`; `HOMEPAGE_URL` set to the placeholder `https://pcoin.example/` (RFC 2606 reserved TLD, feeds `CLIENT_URL` in `--version` output and the Windows installer — replace once a real project site exists). |

**Not** changed: executable names (`bitcoind`, `bitcoin-cli`, `bitcoin-qt`,
`bitcoin-wallet`, ...), Qt icons/artwork. See §8.

## 3. Building

### Option A — Windows native (MSVC + vcpkg)

Per `doc/build-windows-msvc.md`. Requirements: Visual Studio (2022 17.6+ works;
this machine has **Visual Studio Community 2026** which also works) with the
"Desktop development with C++" workload, which bundles CMake and vcpkg.

Open a **Developer PowerShell for VS** (this sets up the compiler and
`VCPKG_ROOT`, which the CMake presets rely on), then:

```powershell
cd D:\xampp\htdocs\pcoin

# See available presets (the vs2022 presets set BUILD_GUI=ON; the project default is OFF)
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
**`seed.pc.am`** — currently resolving to three public nodes (`35.239.156.16`, `35.238.47.14`, `178.105.3.51`), the same three that ship as compiled-in fixed seeds. Re-confirm the live record with `dig +short seed.pc.am` before editing, since DNS state is not settled by the source tree. On startup, when a
fresh node has no peers to try, Bitcoin Core's `ThreadDNSAddressSeed` resolves
that name and uses the returned addresses as candidate peers, so a fresh
mainnet node finds the network on its own. `-connect`/`-addnode` remain
available as a manual fallback (e.g. `-addnode=seed.pc.am`) if DNS is blocked
or the seed is down.

**Testnet/testnet4/signet/regtest still have zero automatic peer discovery** —
their `vSeeds` and `vFixedSeeds` are both empty (mainnet does carry three hard-coded fixed seeds; the test networks do not)
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
multi-threaded miner is built in: `startmining "address" ( threads ttl )`, `stopmining` and `getcpuminerinfo` (RPC category "mining"). `generatetoaddress` remains the single-threaded path.

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
`generatetoaddress 1 $addr` to keep building the chain; below height 2800 difficulty moves only at each 2016-block retarget, and from height 2800 LWMA retargets every block (increase capped at 3x/block, decrease at 12x/block) until it matches the network's actual hashrate. Watch
progress with:

```powershell
bitcoin-cli.exe getblockcount
bitcoin-cli.exe getmininginfo
bitcoin-cli.exe getbalance      # rewards mature after 100 blocks
```

## 6. Wallet recovery phrase and key derivation

Bitcoin Core has never supported BIP39, and PCoin's node does not either — the
node stays byte-for-byte upstream in the wallet layer. The recovery phrase is
implemented in the **client applications** (the Windows tray app, the Android
miner), which derive the keys locally and hand the node a single account-level
extended private key through `importdescriptors`.

This section is the contract. Anything published here must keep working, because
somebody's coins depend on it. A wallet that follows it can restore PCoin funds
from the words alone, with no PCoin-specific software.

### 6.1 The scheme

| | |
|---|---|
| Mnemonic | **BIP39**, **English wordlist only** — never a localised list |
| Length | **12 words** (128 bits) by default; 24 words (256 bits) optional. These two lengths only — BIP39 also defines 15, 18 and 21, and PCoin wallets deliberately do not accept or generate them, so that every client agrees on what a valid phrase is |
| BIP39 passphrase | **empty string** (`""`). No "25th word" |
| Seed | PBKDF2-HMAC-SHA512, 2048 iterations, salt `"mnemonic"`, 64 bytes |
| Master key | BIP32, `HMAC-SHA512(key = "Bitcoin seed", data = seed)` |
| Accounts | **BIP84** — `wpkh()`, native SegWit v0, `pc1q…` |

The BIP32 key string is the literal ASCII `"Bitcoin seed"` — unchanged. It is
part of BIP32 itself, and every standard library uses it. Changing it to
`"PCoin seed"` would buy nothing and would make a PCoin phrase unrestorable in
any other wallet.

### 6.2 Derivation path

```
m / 84' / 9444' / account' / change / index

receive: m/84'/9444'/0'/0/i
change:  m/84'/9444'/0'/1/i
```

* **Coin type `9444'`** — PCoin's SLIP-44 index, matching the mainnet P2P port.
  It is unregistered upstream at the time of writing and a registration PR is
  the intended next step, but the number will not change either way.
* **Coin type `1'` on every test network** — testnet, testnet4, signet and
  regtest, per SLIP-44's universal convention. Never use `9444'` on a test
  chain.
* **Account is fixed at `0'`** in the current clients. `1'`, `2'`, … are
  reserved.
* Clients import the range `[0, 999]` on both chains, so a restore recovers
  funds up to index 999 without any gap-limit logic.
* The **mining payout address is `m/84'/9444'/0'/0/0`** — generated once and
  reused, so the address a miner has already written down keeps working.

**Why not coin type 0.** PCoin kept Bitcoin's extended-key version bytes on
mainnet: `EXT_SECRET_KEY = 0x0488ADE4`, so PCoin extended keys serialise as
literal `xprv…`/`xpub…` (`src/kernel/chainparams.cpp`). Under coin type 0 the
same phrase would derive **byte-identical keys** on both chains — a reused
phrase would silently put someone's Bitcoin keys on a PCoin node, and a leaked
PCoin wallet would be a leaked Bitcoin wallet. Coin type 9444 is the only thing
separating the two trees, which is exactly why it must never be changed.

Test networks use `0x04358394` (`tprv`/`tpub`) and the `tpc`/`pcrt` bech32
prefixes, so a client must select version bytes per network rather than
hardcoding `xprv`.

### 6.3 Descriptors

Two descriptors are imported, with the origin fingerprint and path filled in:

```
external: wpkh([<master-fingerprint>/84h/9444h/0h]<account-xprv>/0/*)
internal: wpkh([<master-fingerprint>/84h/9444h/0h]<account-xprv>/1/*)
```

* Derivation stops at the **account** level. The node gets a key that can spend
  account 0 and nothing else; the seed and the root key never leave the client.
* `84h` rather than `84'` — identical derivation, no quoting hazards.
* `importdescriptors` requires a checksum. Get it from `getdescriptorinfo` and
  append it — but use **only** the `checksum` field. The `descriptor` field it
  returns is the canonical form **without private keys**; importing that
  produces a watch-only wallet that looks healthy until the first send.

### 6.4 Test vectors

The mnemonic below is the standard all-zero-entropy BIP39 phrase. It is a **burn
phrase**, published in every wallet's test suite. Never put coins on it.

```
mnemonic  = abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about
passphrase= (empty)
seed      = 5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc1
            9a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4
master fingerprint = 73c5da0a
```

Account 0 on **mainnet**, `m/84'/9444'/0'`:

```
xprv = xprv9y14Hos54MVJgZi4fDbHMeHQznnF9PCiwjtq5yCv6YKF1nCBFDSzHRtXHxqCWKy4EE5VXRJDdKcyfpSgrrTKKXJLvkPqWfpcLAXQtZcMRwL
xpub = xpub6BzQhKPxtj3bu3nXmF8HinE9YpcjYqvaJxpRtMcXesrDtaXKnkmEqED19EcyDUGb3tuRih7NACR2HY1WrfkRP1dHpMZS2imgmrTrV8cVpE3
```

Descriptors, in the public form `listdescriptors` reports, with their checksums:

```
wpkh([73c5da0a/84h/9444h/0h]xpub6BzQhKPxtj3bu3nXmF8HinE9YpcjYqvaJxpRtMcXesrDtaXKnkmEqED19EcyDUGb3tuRih7NACR2HY1WrfkRP1dHpMZS2imgmrTrV8cVpE3/0/*)#w8mxel75
wpkh([73c5da0a/84h/9444h/0h]xpub6BzQhKPxtj3bu3nXmF8HinE9YpcjYqvaJxpRtMcXesrDtaXKnkmEqED19EcyDUGb3tuRih7NACR2HY1WrfkRP1dHpMZS2imgmrTrV8cVpE3/1/*)#ln78y2wv
```

(The checksum covers the exact string, so the same descriptor written with the
`xprv` instead of the `xpub` has a different one — that is expected.)

First three receive addresses, `m/84'/9444'/0'/0/{0,1,2}`:

```
pc1qj7lccmpqhdgg6enh503hqqyx244e49yespm8pf
pc1q0ncnjjyklxwts46h7e7jmls0l8d99lhv3wk0sm
pc1qzze3twr9c0cg0s3v2yh7797gae4ufk7zu4wux0
```

First three change addresses, `m/84'/9444'/0'/1/{0,1,2}`:

```
pc1qel0k9nyfvgqsgkc4fv9jp9ff37gw48gnsqt2rs
pc1qszm5tcmmewdgjny34klqv3dupm6jd5939k6e20
pc1qxyzkhz58fs86rxjmm96hz58zt3j0qnx8s76tyg
```

Any node can confirm these without a wallet:

```powershell
bitcoin-cli.exe deriveaddresses "wpkh([73c5da0a/84h/9444h/0h]xpub6BzQhKPxtj3bu3nXmF8HinE9YpcjYqvaJxpRtMcXesrDtaXKnkmEqED19EcyDUGb3tuRih7NACR2HY1WrfkRP1dHpMZS2imgmrTrV8cVpE3/0/*)#w8mxel75" "[0,2]"
```

### 6.5 Two settings a spend depends on

Independent of recovery phrases, and needed on any PCoin wallet that will ever
send:

```
fallbackfee=0.00001
changetype=bech32
```

Core's `DEFAULT_FALLBACK_FEE` is 0 and PCoin has no fee history to estimate
from, so **without `fallbackfee` every mainnet send fails** with "Fee estimation
failed". And because a phrase-backed wallet holds only `wpkh` descriptors,
sending to a taproot `pc1p…` address fails while allocating change unless
`changetype` pins change to bech32.

### 6.6 Restoring by hand

The clients do this for you; this is the same thing at the command line, for a
wallet that has an account xprv from the words above.

```powershell
bitcoin-cli.exe createwallet "pcoin-hd" false true "" false true true false
# blank=true: no HD seed of the node's own, only the keys that get imported

# checksum each descriptor (the private form, exactly as it will be sent)
bitcoin-cli.exe getdescriptorinfo "wpkh([73c5da0a/84h/9444h/0h]<xprv>/0/*)"

bitcoin-cli.exe -rpcwallet=pcoin-hd importdescriptors "[
  {\"desc\":\"wpkh([73c5da0a/84h/9444h/0h]<xprv>/0/*)#<sum>\",\"active\":true,\"internal\":false,\"range\":[0,999],\"next_index\":0,\"timestamp\":1785600628},
  {\"desc\":\"wpkh([73c5da0a/84h/9444h/0h]<xprv>/1/*)#<sum>\",\"active\":true,\"internal\":true, \"range\":[0,999],\"next_index\":0,\"timestamp\":1785600628}]"
```

* `timestamp` is the genesis time `1785600628` for a restore — the true lower
  bound for a rescan. For a phrase created a moment ago, use `"now"` instead and
  the scan is skipped entirely.
* `importdescriptors` returns a **result per descriptor and does not fail the
  call** when only one of them worked. Check every `success`. A wallet that
  imported the receive descriptor but not the change one can take coins and
  cannot build change — invisible until the first send.
* Do not put a `label` on the internal descriptor; the node rejects that.

Finally, check that the node and the words agree before trusting the wallet:

```powershell
bitcoin-cli.exe -rpcwallet=pcoin-hd getaddressinfo pc1q…   # the address YOU derived at .../0/0
# expect "ismine": true and "hdkeypath": "m/84h/9444h/0h/0/0"
```

Note that `getnewaddress` is **not** the right check after a restore: the rescan
advances the descriptor past every index that already has history, so it
correctly returns a later address than index 0.

## 7. Why nodes and servers matter

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

## 8. Honest next steps and warnings

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
  * No real DNS seeder (crawler) — mainnet bootstraps off the static DNS seed
    `seed.pc.am` plus three compiled-in fixed seeds in `src/chainparamsseeds.h`
    that are used when DNS seeding yields nothing; testnets still need manual
    `-addnode`/`-connect` (§4).
  * No block explorer, no checkpoints, no `assumevalid`/minimum-chainwork
    anchors (they're zeroed — fine for a young chain, revisit once there's
    history worth anchoring).
  * Releases are cut manually (there is no CI). The one packaging script is
    `contrib/linux-deb/build-deb.sh`; Windows ships a plain zip, and the Inno
    Setup installer was dropped in 2026-08 (it added a Defender false positive
    and a second thing to keep in step, for no benefit the zip did not already
    give). Still missing: code signing and reproducible-build attestations.
* **Sensible order of next steps:** run two VPS nodes → mine a few thousand
  blocks → back up wallets → add more seed nodes behind `seed.pc.am` and stand
  up a proper crawling DNS seeder + explorer → re-brand binaries and GUI →
  only then think about inviting the public.
