# CLAUDE.md — PCoin

Read this first. It is the orientation document for a session that starts cold.
Everything below is either verified in this tree or explicitly marked unverified.
Where a fact lives in another document this file points at it rather than
restating it, because a duplicated fact is a fact that will go stale.

| Topic | Authoritative source |
|---|---|
| Chain identity, genesis, ports, address formats | `PCOIN.md` §1 |
| Full change list vs upstream v29.4 | `PCOIN.md` §2 |
| Build recipes in prose | `PCOIN.md` §3 |
| Recovery phrase, derivation, descriptors, test vectors | `PCOIN.md` §6 |
| LWMA reference model | `contrib/lwma/README.md`, `contrib/lwma/lwma_ref.py` |
| Tray app design | `contrib/windows-tray/README.md` |
| Windows always-on node | `doc/WINDOWS-NODE-SETUP.md` (has a known error, §10.1) |
| Custody for integrated systems | `contrib/vault/README.md`; the operational procedure is `D:\pc.am\PCOIN-CUSTODY-RUNBOOK.md` (off-repo — it names the vault hosts) |

---

## 1. What PCoin is

PCoin (ticker PCN) is an **independent Layer-1 blockchain** — its own genesis
block, its own network magic, its own ports and address prefixes, its own UTXO
set. It is not a token, not an ERC-20, not a sidechain, and it does not settle
on anyone else's chain. It is a fork of the Bitcoin Core **v29.4** codebase with
proof-of-work replaced by **RandomX** (CPU-friendly, ASIC-resistant) and the
difficulty algorithm replaced by **LWMA**. 21 M cap, 50 PCN block reward,
210 000-block halving, 600 s target spacing — the economics are untouched from
Bitcoin. Genesis timestamp: *"PCoin 01/Aug/2026 an independent chain is born"*
(`src/kernel/chainparams.cpp:75`). The chain is **live and carrying real
blocks**, so consensus changes orphan real work: treat every edit under
`src/pow.cpp`, `src/crypto/pow_randomx.*`, `src/validation.cpp` and
`src/kernel/chainparams.cpp` as a hard fork until proven otherwise.

The chain is also **very young** — genesis timestamp 1785600628, so at the time
of writing it is about **two and a half days old**. Every "all time" number in
this file describes a weekend, not a track record. Read them that way.

## 2. Repository map

`d:\xampp\htdocs\pcoin`, branch `main`, public at github.com/pars5555/pcoin.
Upstream base is tag `v29.4`; every diff below is `git diff v29.4..HEAD`.

```
src/randomx/            vendored copy of tevador/RandomX. NOT a submodule (no .gitmodules).
                        151 tracked files, 39,914 lines, of which ~17.4k are .c/.cpp/.h/.hpp
src/crypto/pow_randomx.{h,cpp}   the PoW wrapper — the whole RandomX surface
src/pow.{h,cpp}         LWMA + the deliberately-broken legacy retarget (§3)
src/kernel/chainparams.cpp       all five networks' parameters
src/node/cpuminer.{h,cpp}        the built-in multithreaded miner (PCoin-only file)
src/rpc/mining.cpp      startmining / stopmining / getcpuminerinfo live here
contrib/lwma/           reference implementation + README for the difficulty algo
contrib/windows-tray/   the Windows tray miner (C#) — see the tracking warning below
contrib/utxo-tools/     upstream's dumptxoutset -> sqlite converter
site/index.html         the pc.am website, deployed by copying this one file
depends/                byte-identical to upstream v29.4
test/functional/        upstream's framework — largely BROKEN against PCoin (§10.3)
.github/                workflows/ci.yml (439 lines) and actions/* (164 lines) were
                        DELETED; ISSUE_TEMPLATE/* and PULL_REQUEST_TEMPLATE.md are still
                        tracked and were only modified. Either way: there is no CI.
                        Every check is manual.
```

Outside the repo, and this matters more than anything else in this section:

* ~~The Android app is not in git at all.~~ **Fixed.** It lives at
  `contrib/android` and is tracked. The scratchpad copy it used to live in is
  gone; do not go looking for it.
* ~~Most of the Windows tray app is untracked.~~ **Fixed.** Every source
  `build.bat` compiles is tracked, so a fresh clone can build the tray.
  `build.bat:31-52` compiles a fixed source list naming nine of those ten files
  plus the manifest. **A fresh clone cannot build the tray app**, and
  `README.md:102-108` tells a fresh cloner to just run `build.bat`.
* Operational helper scripts (`run_remote.py`, `fleet.ps1`, `deploy_tray.py`,
  `backup_phones.ps1`, `pull_pc_wallets.py`, `publish_120.py`, the LWMA
  simulations, the Android build recipe) live in the same scratchpad, not in git.
* Secrets: `D:\pc.am\PCOIN-SECRETS.md`. Wallet backups: `D:\pc.am\wallet-backups`.

## 3. The chain

### Proof of work — RandomX
`src/crypto/pow_randomx.cpp`.
* Key is the fixed ASCII string `PCoin/RandomX/v1`, identical on **every**
  network including regtest (`:26-28`). Rotating it is PoW v2, a hard fork.
* Light mode only — ~256 MiB cache, never `FULL_MEM`, never `LARGE_PAGES`
  (`InitCache`, `:66-98`). Cache and fallback VM are leaked deliberately to dodge
  a `thread_local` destruction-order hazard (`:30-46`).
* VM creation degrades: detected flags → `|SECURE` (W^X JIT) → `DEFAULT`
  interpreter (`:54-64`). All three produce identical hashes.
* The PoW statement (`:139-163`): `RandomX(80-byte serialized header)` read
  little-endian must be ≤ the `nBits` target. **Block IDs are still
  double-SHA256** — `GetHash()`, prev-block links and every RPC hash are
  unchanged. Do not confuse the two.
* `RandomXPowInit()` runs eagerly from `src/init.cpp:1684` so OOM becomes a clean
  `InitError` instead of an exception on the message-handling thread.
* Call sites: `src/validation.cpp:3961`, `:4162`; `src/node/blockstorage.cpp:153`,
  `:1038`; `src/rpc/mining.cpp:155`.
* Two mitigations that look like dead code and are not:
  `src/net_processing.cpp:2443+` filters already-known headers **before** the
  PoW check so a peer cannot make you burn ~1 ms each;
  `src/node/blockstorage.cpp` spot-checks RandomX only every 1000 heights at
  startup (interval constant at `:147`, the check at `:152-156`) — otherwise
  startup is O(height) × ms.

### Difficulty — LWMA at height 2800
`LwmaGetNextWorkRequired`, `src/pow.cpp:107-208`; dispatch at `:210-219`;
parameters at `src/consensus/params.h:137-154` (N=60, ST=12T=7200,
max-future=900). Retargets **every block**. Activation height is
`src/kernel/chainparams.cpp:120` (mainnet 2800; 1 on the testnets; `INT_MAX` on
regtest). The rationale block immediately above it (`:108-119`) states the
measured pace and the constraints — read it before touching the number.

Three things in that function must not be "cleaned up":
1. The division by `k*N` stays **inside the loop, before the multiply**
   (`:150-157`). The published `avgTarget * weightedSolvetime / k` shape silently
   wraps at PCoin's 2^244 powLimit.
2. Solvetimes are measured against a **running maximum** of window timestamps
   (`:145-151`), not raw parent timestamps. Consensus only requires
   `timestamp > MTP`, so raw solvetimes let a miner backdate its own blocks for a
   permanent difficulty subsidy — simulated 1.31× emission at 1/7 hashrate.
3. The **explicit exact overflow guard** `sumTarget > max_uint / t` (`:177-201`),
   derived independently of the multiply it protects. Falls back to powLimit
   deterministically so the chain stays alive.

Clamps are asymmetric on purpose: increase capped at 3×/block, decrease at
ST/T = 12×/block; a zero result is bumped to 1 (`:206`) because `DeriveTarget`
rejects zero and would halt the chain.

`PermittedDifficultyTransition()` (`:318`) returns **true unconditionally** above
`lwmaHeight` (`:343`). That is only safe while `nMinimumChainWork == 0`, and a
startup `assert` at `src/kernel/chainparams.cpp:175` enforces it. Never set
`nMinimumChainWork` without first giving that function a real LWMA bound.

`LWMA_MAX_FUTURE_BLOCK_TIME` (15 min, `src/chain.h:56`) applies **only** at
heights ≥ `lwmaHeight` (`src/validation.cpp:4263-4266`). `MAX_FUTURE_BLOCK_TIME`
is still 2 h (`src/chain.h:37`). Gating on height is what stops the rollout
splitting the network. A consequence worth remembering: **block timestamps are
not monotonic in height**, so "time since last block" and "blocks in the last
24 h" can both come out negative.

Tests: **13** PCoin-specific Boost cases at `src/test/pow_tests.cpp:381-1092`
(the file is 1094 lines; `test_bitcoin --run_test=pow_tests` runs 28 cases in
total and passes), fuzz target `pow_lwma`, functional
`test/functional/feature_lwma.py` (passes — it is RPC-only), reference model
`contrib/lwma/lwma_ref.py`.

### Network parameters
See `PCOIN.md` §1 for the full table. The load-bearing ones: P2P 9444 / RPC 9443
on mainnet (**RPC is P2P−1**, not Bitcoin's arrangement, because P2P+1 is
bitcoind's default Tor onion listener — the rationale is in
`src/chainparamsbase.cpp:37-38`); magic `cf a2 d1 b8` (regtest `cf a5 d4 bb`);
bech32 hrp `pc`; base58 55/56/183; powLimit `000fffff…` = 2^244−1; genesis id
`a95d51f0cbf25cad…264a`. BIP32 xpub/xprv version bytes are **left at Bitcoin's
values** (`0488ADE4`) — this is why the BIP44 coin type is load-bearing (§6). All
five networks have `checkpointData = {}`, `nMinimumChainWork = 0`,
`defaultAssumeValid = 0`, `chainTxData` zeroed, `vFixedSeeds` cleared. Mainnet's
only seed is `seed.pc.am.` (`:196`).

### The built-in miner
`src/node/cpuminer.{h,cpp}`, process-wide singleton, stopped from
`src/init.cpp:273`. One supervisor thread (`pcminer-sup`) rebuilds the template
on tip change / 20 s (`TEMPLATE_REFRESH`, `cpuminer.cpp:35`) / first publish and
enforces a **dead-man's switch** (`ttl_seconds`) so a phone app killed by the OS
cannot leave a node hashing with nothing enforcing thermal limits. N workers
grind disjoint 64-nonce batches (`NONCE_BATCH`, `cpuminer.cpp:31`). On a solve
the worker **retires the template first**, then calls `ProcessNewBlock`.
`m_blocks_found` only increments if the block ends up on the active chain —
deliberate, so the user-visible count never includes side-branch blocks that pay
nothing.

RPCs added, all in `src/rpc/mining.cpp`, category "mining":
* `startmining "address" ( threads ttl )` (`:1137`) — no wallet needed; threads 0
  = all cores; values above `hardware_concurrency()` are **capped, not rejected**.
  Returns `{mining, threads, address, ttl}` — note `ttl` is returned but is not
  declared in the `RPCResult`, a real doc mismatch.
* `stopmining` (`:1189`).
* `getcpuminerinfo` (`:1210`) — **polling it refreshes the dead-man's switch**
  (`KeepAlive()` at `:1230`), which is why a supervisor that only reads status
  keeps mining alive.

`generatetoaddress` / `generateblock` still exist and now do real
(single-threaded) RandomX work. `xmrig` and every SHA-256d miner are useless here.

## 4. Building

### Node — WSL2 / Linux (the normal path)
The build tree is **`/root/pcoin-build`** — a plain copy, **not a git repo**.
There is no `/root/pcoin`; a recipe that starts `cd ~/pcoin` fails on its first
line.
```bash
sudo apt-get install build-essential cmake pkgconf python3 libevent-dev libboost-dev libsqlite3-dev
cd /root/pcoin-build          # a Linux path; building on /mnt/d is much slower
cmake -B build -DBUILD_GUI=OFF -DENABLE_WALLET=ON -DCMAKE_BUILD_TYPE=Release
cmake --build build -j "$(nproc)"
./build/bin/bitcoind --version      # prints "PCoin Core daemon version v29.4.0" (§10.9)
```
Binaries land in `/root/pcoin-build/build/bin/{bitcoind,bitcoin-cli,test_bitcoin}`.
The functional-test config is at `build/test/config.ini` and there is **no**
`test/config.ini`, so a bare `python3 test/functional/x.py` fails until you pass
`--configfile=/root/pcoin-build/build/test/config.ini`.

Unit tests: `ctest --test-dir build`, or
`./build/bin/test_bitcoin --run_test=pow_tests`.

### Node — Windows release binaries (mingw cross-compile from WSL)
Tree `/root/pcoin-win`, stock Bitcoin `depends`:
```bash
cd /root/pcoin-win/depends && make HOST=x86_64-w64-mingw32 NO_QT=1 NO_ZMQ=1 NO_USDT=1 -j8
cd /root/pcoin-win && cmake -B build \
  -DCMAKE_TOOLCHAIN_FILE=/root/pcoin-win/depends/x86_64-w64-mingw32/toolchain.cmake \
  -DBUILD_GUI=OFF -DENABLE_WALLET=ON -DCMAKE_BUILD_TYPE=Release
cmake --build build -j8
```
Logs in `/root/winbuild-logs`. A native MSVC+vcpkg path is documented in
`PCOIN.md` §3 (presets `vs2022`, `vs2022-static`); first configure takes ~an hour.

### Windows tray app
No toolchain to install — it uses the C# compiler that ships in the box.
```cmd
cd contrib\windows-tray
build.bat
PCoinTray.exe --selftest
```
The self-test writes `pcoin-selftest.txt` itself (`PCoinTray.cs:67`, documented at
`README.md:124`) — you do not need to redirect it. `build.bat` finds
`%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe` and references the WPF
assemblies by path out of that framework's `WPF\` subdirectory (`build.bat:24-29`)
because they are not next to the compiler. `System.Numerics` is there for
secp256k1 arithmetic and `System.Security` for DPAPI. **Nothing comes from
NuGet.** Remember §2: nine of the ten sources are untracked, so this only builds
in the working tree, not from a clone.

### Android app
From `contrib/android` (AGP 8.5.1 / Kotlin 2.0.21 / wrapper 8.11.1,
`minSdk 24`, `targetSdk 34`).

**TWO APPS, ONE SOURCE TREE.** Product flavours on the `role` dimension:

| flavour | applicationId | what it is |
|---|---|---|
| `miner` | `am.pc.pcoinminer` | node + wallet + mining |
| `wallet` | `am.pc.pcoinwallet` | node + wallet, mining compiled out |

```cmd
gradlew.bat testMinerDebugUnitTest --tests "org.pcoin.miner.wallet.*"
gradlew.bat assembleMinerDebug     :: app/build/outputs/apk/miner/debug/
gradlew.bat assembleWalletDebug    :: app/build/outputs/apk/wallet/debug/
```

Bare `assembleDebug` no longer exists — the flavour split replaced it, and the
output path moved. Anything that hardcodes `apk/debug/app-debug.apk` is stale.

Three traps that follow from the flavours and the rename:

1. **`namespace` is still `org.pcoin.miner` for both flavours.** It is only the
   R/BuildConfig package. `applicationId` is the app identity.
2. **`uiautomator` reports resource-ids under the APPLICATION ID**, not the
   namespace — so a fleet script matching `org.pcoin.miner:id/…` silently matches
   nothing and reads as "no buttons on screen". Match any package prefix.
3. **The debug signing key is pinned** via `signing.properties`
   (`debugStoreFile`). Gradle's default `~/.android/debug.keystore` was lost and
   silently regenerated once, producing a build Android refused to install over
   the existing one. Verify before shipping — `apksigner verify --print-certs`
   must report `de1fd650…`.

Changing either `applicationId` again means an uninstall on every phone, and an
uninstall destroys the wallet in app-private data.

> **Never run bare `gradlew.bat testDebugUnitTest`.** The debug unit-test task
> includes `app/src/test/java/org/pcoin/miner/ForwardSandboxE2ETest.kt`, which has
> no `@Ignore` and no availability guard. Via `SandboxHarness.kt:40-41` it shells
> out to a **hard-coded `adb.exe` and a hard-coded phone serial — the Z Flip 5 —**
> and runs a real `bitcoind` regtest sandbox on that device, holding it for
> `holdMinutes` (default 10, `app/build.gradle.kts:89`). That is a device-touching
> operation dressed up as a unit test. The `--tests` filter above is what makes
> the command device-free; the wallet-vector tests (`DerivationVectorsTest.kt`,
> `PublishedVectorsTest.kt`, `RedactTest.kt`) genuinely need no device.

`local.properties` holds only `sdk.dir`; `signing.properties` holds the release
keystore path and passwords and sits outside the app source
(`app/build.gradle.kts:26-49`). The **BIP39/BIP32/secp256k1 stack** in
`org.pcoin.miner.wallet` deliberately has no Android imports
(`app/build.gradle.kts:101-105`) so published vectors run on a plain JVM. Note
the scope: three files in that same package — `SeedStore.kt`, `SeedGate.kt`,
`DescriptorInstaller.kt` — *do* import `android.*`, because they are storage,
auth-gate and RPC glue rather than crypto. "The wallet package has no Android
imports" is false; "the crypto stack has none" is true.

The native `bitcoind` for Android is built separately per
`scratchpad/android-port/recipe/BUILD-ANDROID.md` (NDK r26.1, arm64-v8a, API 24,
`ANDROID_STL=c++_static`). **No source changes are needed** — RandomX picks the
a64 JIT on its own from `CMAKE_SYSTEM_PROCESSOR=aarch64`. The thing that always
bites: the NDK legacy toolchain re-roots every `find_*` inside the NDK, so you
need `CMAKE_FIND_ROOT_PATH=<prefix>` **and** all three
`CMAKE_FIND_ROOT_PATH_MODE_{PACKAGE,INCLUDE,LIBRARY}=BOTH`; `CMAKE_PREFIX_PATH`
alone does nothing. Packaging requires renaming `bitcoind` →
`jniLibs/arm64-v8a/libbitcoind.so` and exec-ing it from `nativeLibraryDir`,
because Android 10+ blocks exec from app-writable storage.

### The Linux user path
`contrib/linux-deb/` is not just `build-deb.sh` any more. The whole install is

```
curl -fsSL https://pc.am/dl/install.sh | sudo sh
```

which verifies the download against the release's `SHA256SUMS`, installs, and
execs the wizard. Four tracked files, all shipped inside the `.deb` except the
first:

| file | what it is |
|---|---|
| `install.sh` | the one-liner. Hosted at `pc.am/dl/install.sh`; **not** version-pinned, it resolves through `/releases/latest/download/` so it never needs a release-time bump (contrast `install.ps1`, which does — §4 "Cutting a release") |
| `pcoin-setup` | wizard: asks for the payout address, **validates it via the node's `validateaddress`** rather than a regex, asks thread count, writes `/etc/pcoin/miner.conf`, enables `pcoin-miner` |
| `pcoin-miner-supervisor` | `ExecStart` of `pcoin-miner.service`. Waits for RPC, waits for `initialblockdownload == false`, then `startmining` with **ttl=120** and polls `getcpuminerinfo` every 30 s — the poll *is* the keep-alive |
| `pcoin-mine` | live terminal dashboard: hashrate, share of network, block ETA, `b` scans the UTXO set for the payout address and splits mature from immature |

Three design points that must survive any edit:

1. **`pcoin-miner.service` must NOT use `BindsTo=`/`PartOf=` on `pcoind`.**
   Propagation is one-way: a `systemctl restart pcoind` would stop mining and
   never restart it, silently, until the next reboot. The supervisor rides out
   a node restart itself — measured recovery is ~20 s.
2. **The wizard reads from `/dev/tty`, not stdin.** When `install.sh` is piped
   into `sh`, stdin *is* the script; reading it would consume the rest of the
   file. `install.sh:…` reopens the terminal explicitly before `exec`.
3. **A failed `validateaddress` is not a rejection and not an acceptance.** Both
   the wizard and the supervisor loop and retry rather than resolve it either
   way — the §7.1 doctrine, applied to the one input that costs money.

Because the miner pays a bare address, **the machine holds no key**. That is why
mining to the treasury address directly is the right shape on Linux, and why
none of this needs the Windows tray's forward-and-sweep machinery.

### Cutting a release
Entirely manual — there is no CI. Five artifacts per release, from three builds:

| artifact | built by |
|---|---|
| `pcoin-<ver>-win64.zip` | mingw cross-compile, packed with a **Python** `zipfile` script. **Must contain `PCoinTray.exe` beside the two node binaries** — see below |
| `pcoin-<ver>-linux-x86_64.tar.gz` | the Linux build tree |
| `pcoin-<ver>-linux-amd64.deb` | `contrib/linux-deb/build-deb.sh <ver> <bindir>` |
| `pcoin-<ver>-android-{miner,wallet}.apk` | `gradlew.bat assemble{Miner,Wallet}Release` |

**The win64 zip must include the tray app.** Up to v1.2.3 it held only
`bitcoin-cli.exe`, `bitcoind.exe` and `COPYING`, while `install.ps1` — the
one-liner advertised on pc.am — downloads *only* that zip. The result was an
install that reported success and produced a node with no miner UI, a desktop
shortcut pointing at a file that had never been installed, and a scheduled task
launching the same missing exe. `install.ps1` now refuses rather than
half-installing, but the real fix is to pack the tray. Doing so also needs no
second download, which matters because of the next paragraph.

**The Windows installer is gone. Ship the zip only.** `installer.iss` and both
`*-win64-setup.exe` assets were deleted on 2026-08-10. The installer had been
quarantined as `Trojan:Script/Wacatac.H!ml` — an `!ml` suffix means a
machine-learning heuristic, so it was a reputation false positive on the **Inno
Setup stub**, never a coin-mining detection and never anything in the code.

**Do not confuse Defender with SmartScreen; users report both as "Defender".**
Re-measured 2026-08-10 on a real desktop (real-time protection on, signatures
one day old): the zip downloads, extracts, and survives a forced
`Start-MpScan` with **no detection**, and so did the installer by then — the
heuristic had aged out. An **EICAR control file dropped in the same folder was
caught**, which is what proves the folder was not excluded and the scan was
real. Always run that control; a clean result from a scanner that was not
looking is worthless.

What users actually hit is **SmartScreen**, because every binary is
`NotSigned`: it warns about anything it has not seen downloaded widely,
regardless of content. Only a code-signing certificate removes it. (§7.3 is a
different Windows trap; this is its own.)

The archives each contain a top-level `pcoin-<ver>/`. **Never build the zip with
PowerShell `Compress-Archive`** — it writes entry names containing backslashes,
so the whole tree unpacks on Linux and macOS as a handful of files with `\` in
their names. Use `zipfile` and assert `sum("\\" in n for n in namelist()) == 0`.

Publish with the `scratchpad/publish_122.py` pattern — it pulls the GitHub token
from `git credential fill`, never a literal, and is idempotent (an asset of the
same name is deleted before re-upload), which matters because a 9 MB upload over
a flaky link is exactly the thing that half-finishes.

**Every asset is then uploaded a second time under a version-less name**
(`pcoin-win64-miner.zip`, …). This is
load-bearing, not tidiness: pc.am links through
`/releases/latest/download/<name>`, and GitHub resolves `latest` to the newest
release and then looks for that **exact** filename. A versioned name in that URL
works for one release and 404s for every one after it. The site links to the
stable names and therefore needs **no edit at release time**. `SHA256SUMS` lists
both name forms with the same hash.

**Asset names carry the ROLE, as of v1.2.6**: `pcoin-<platform>-<role>.<ext>`, e.g.
`pcoin-win64-miner.zip`, `pcoin-linux-amd64-miner.deb`, `pcoin-android-wallet.apk`,
and `pcoin-win64-earner.zip` when the Windows earner ships. Before v1.2.6 the
non-Android assets had no role word (`pcoin-win64.zip`), and **those old names are
still published as transition aliases with identical bytes** — because
`install.ps1` and `install.sh` are fetched fresh from `pc.am/dl/` but a copy
someone saved still asks for the old name. Drop the aliases only once nothing
references them, and remember that renaming an asset means editing, in the same
change: both installers, `site/index.html`, `site/download/index.html`,
`doc/WINDOWS-NODE-SETUP.md`, and the copies of the two installers deployed on
pc.am. The repo alone is not enough.

Two things that still need a manual bump:
* **`contrib/windows-tray/install.ps1:20-21`** — `$Version` and `$Sha256` are
  pinned defaults and the installer refuses to run on a hash mismatch, so
  forgetting the SHA bump breaks every new install.
* **`pc.am/dl/SHA256SUMS.txt`** — copy the release's `SHA256SUMS` up with the
  explanatory preamble.

`site/index.html` only needs redeploying when its *content* changes. If you find
yourself editing a download URL there, something has regressed.

Sanity check before calling it done: `curl -sIL -o /dev/null -w '%{http_code}'`
every stable link, and hash one downloaded file against the published list. The
site pointed at v1.0.0 binaries while `install.ps1` pinned v1.2.0 for long
enough that it made §9's open-items list.

## 5. The fleet

No secrets in this file. Credentials, API keys and tokens are in
`D:\pc.am\PCOIN-SECRETS.md`, outside the repo. Do not copy any of them into any
file, including this one. Note in particular that `run_remote.py` hard-codes the
aicontrol bearer key and `SandboxHarness.kt` hard-codes a phone serial — neither
belongs in this repo.

**SSH access to all three seeds is written down: `D:\pc.am\PCOIN-SERVERS.md`.**
Read it instead of asking, and instead of guessing. The IPs are public (they ship
as fixed seeds in `src/chainparamsseeds.h`) but the usernames, key paths and
per-host care levels are not, which is why they live on `D:` and not here. **The
SSH username differs per host and is not derivable** — seed 2 cost a wasted round
of four keys × six users × two ports before the answer turned out to be a
username nobody had tried, with a key already on the machine. That file also
records which boxes are shared production (one runs Odoo, one runs pc.am and
~215 vhosts) and therefore how careful to be.

**Seed node + website** — GCP, `35.239.156.16`, Debian 11.11, 2 vCPU / 8 GB RAM
(≈7 GB usable), 49 GB disk with **18 GB free**, uptime ~1450 days.
SSH login (username and key) is in `D:\pc.am\PCOIN-SERVERS.md`; the account there
has passwordless sudo and root login is denied. The username is deliberately not
written here — this repo is public, and §5 already says usernames live on `D:`,
so naming one in this file contradicted the rule it states. This is a **shared
production box**: 13 enabled Apache vhost files (15
available), 12 of them not `pc.am`, together declaring **215 distinct
ServerName/ServerAlias hostnames** — plus MariaDB, Docker, coturn, frps and about
ten PHP-FPM pools. PHP is **7.4.33, end of life since November 2022**. Treat it
accordingly: **graceful Apache reload only, never a restart.**

The node runs in Docker, not systemd: container `pcoin-seed`, image `pcoin:1.2.0`,
`restart=unless-stopped`, publishing only `9444` (P2P). Manage it with
`sudo docker exec pcoin-seed bitcoin-cli <rpc>`. Its config is five lines
(`server`, `listen`, **`txindex=1`**, `rpcbind=127.0.0.1`, `rpcallowip=127.0.0.1`,
cookie auth, no `rest=1`) — so **RPC is unreachable from outside the container**.
The container has `Memory: 0` and no CPU quota, i.e. nothing on this host
constrains anything from starving anything else.

Website: Apache vhost `pc.am.conf`, docroot `/var/www/pc.am` (a single
`index.html`), Cloudflare Origin certs under `/etc/apache2/certs/pc.am/`. `pc.am`
and `aicontrol.pc.am` are proxied through Cloudflare (104.21.52.61 /
172.67.196.49); `seed.pc.am` is a plain unproxied A record to the single IP.
`aicontrol.pc.am` is **not** hosted on this box — don't look for it in
`/etc/apache2`.

**Three Windows miners** — all run `C:\PCoin\bitcoind.exe -datadir=C:\PCoin\data`
plus `PCoinTray.exe`. They are reached through the AI Control API at
`https://aicontrol.pc.am` via `scratchpad/run_remote.py`
(`run(device_id, script, timeout_ms)`), which relays a `run_powershell` MCP call
over an FRP tunnel. Device IDs are 32-char hex, not numeric. `scratchpad/fleet.ps1`
is the one-line-per-PC status read. Note: **only the seed has `txindex`** — any
code assuming `getrawtransaction` works will fail against a PC node.

> **`scratchpad/deploy_tray.py` deploys on import.** It has no
> `if __name__ == "__main__"` guard, so `import deploy_tray` — even just to read a
> constant — re-uploads the tray binary to a live PC and restarts the app there.
> This has actually happened. Read it with an editor, never with an import.

**Phones** — reached over `adb -s <serial>` from PowerShell (MSYS/Git Bash
rewrites `/data/local/tmp` into a Windows path). Pixel 4a and SM-S135DL mine; the
**Z Flip 5 is the designated test device**; a moto g play was removed from the
fleet but is still listed in `backup_phones.ps1:14` and `upgrade_phones.ps1:17` —
running either as-is touches a device that is no longer part of the network.

**Install path for a new PC**: `contrib/windows-tray/install.ps1`, which
downloads the pinned release zip, verifies the pinned SHA-256, and defaults to
`-Threads 0` (installed but **not** mining) on purpose — a node that mines before
it has synced builds a competing fork.

## 6. Wallets and money

**The scheme.** BIP39, 12 words, 128 bits of entropy. Derivation is
`m / 84' / 9444' / account' / change / index` — BIP84 native SegWit, producing
`pc1q…` addresses. Mining payouts go to `m/84'/9444'/0'/0/0`. Documented in
`PCOIN.md` §6 (§6.2 path, §6.3 descriptors, §6.4 test vectors, §6.6 manual
restore); the app-side specification is
`pcoin-android-app/.../wallet/PcoinDerivation.kt:1-60`, and the two must stay in
step — any future wallet restoring the same twelve words depends on it.

**Coin type 9444' is load-bearing and must never change.** PCoin inherited
Bitcoin's `EXT_SECRET_KEY` version bytes (`0488ADE4`), so PCoin extended keys
serialise as literal `xprv…` and a Bitcoin xprv parses in a PCoin descriptor.
Under coin type 0, one phrase would derive byte-identical keys on both chains.
9444' is the only thing keeping the two trees apart. It is unregistered in
SLIP-44. Never use it on a test network — testnets use SLIP-44's universal coin
type 1.

**Two settings any wallet that will ever send needs** (`PCOIN.md` §6.5, verbatim
rationale at `PCOIN.md:523-537`): `fallbackfee=0.00001` (Core's default is 0 and
PCoin has no fee history, so every mainnet send otherwise fails with "Fee
estimation failed") and `changetype=bech32` (a phrase-backed wallet holds only
`wpkh` descriptors, so sending to a taproot `pc1p…` address fails while
allocating change).

**Where keys live.**
* *Windows tray*: DPAPI-protected `pcoin-seed.dat` (`SeedStore.cs:103`,
  `ProtectedData.Protect(..., CurrentUser)` at `:129`) in the tray exe's own
  directory — `C:\PCoin` (`PCoinTray.cs:231`). It is deliberately **not** in
  `pcoin-tray.cfg`, because `install.ps1` rewrites that config wholesale on every
  upgrade and would destroy the phrase (`SeedStore.cs:93-100`). `SeedStore.Save`
  refuses to replace an existing phrase unless the caller says so explicitly, and
  writes via a temp file + single rename so an interrupted write can never leave
  a truncated phrase — or no phrase at all.
* *Android*: AES-256-GCM ciphertext in app-private storage under a key that lives
  in AndroidKeyStore and never leaves it (`wallet/SeedStore.kt:17-36`). The auth
  gate is the **key**, not the UI: the key is created with
  `setUserAuthenticationRequired(true)`, so the Cipher physically cannot produce
  plaintext without a fresh device unlock — a rooted device cannot skip past a
  boolean callback, because there is no boolean. The plaintext phrase is never
  logged, never put in a notification, never written anywhere else (`Redact.kt`
  exists to keep it that way).
* *Node*: ordinary descriptor `wallet.dat` in the datadir.

**What destroys them.**
* Uninstalling the Android app. Android refuses to upgrade across signing keys,
  so installing a release-signed APK over a debug-signed one requires an
  uninstall — which wipes app-private storage and the wallet with it. This is why
  `upgrade_phones.ps1` installs the **debug-signed** APK on purpose. The switch to
  the release key happens exactly once, together with introducing the recovery
  phrase, so the user ends up restorable in the same step.
* Reinstalling the tray app into a different directory, or any tool that rewrites
  `pcoin-tray.cfg` if a phrase were ever stored there.
* For the currently-installed debug builds on the phones, **there is no phrase at
  all — the wallet file *is* the coins.**

**Backups.** `D:\pc.am\wallet-backups`. Produced by
`scratchpad/backup_phones.ps1` (`run-as am.pc.pcoinminer … backupwallet`, base64
out over `adb exec-out`, `[IO.File]::WriteAllBytes`, then delete the temp file on
the device) and `scratchpad/pull_pc_wallets.py` (same shape via `run_remote.py`,
decoded and written `"wb"` in Python). Both discover devices from `adb devices`
rather than a hardcoded list — the old fixed list named a phone that had left the
fleet and omitted two that joined it, so it backed up neither.

> **Standing rule: a backup is not a backup until it has been loaded.**
> Before anything destructive — an uninstall, a key rotation, a datadir wipe, a
> phrase replacement — copy the backup to a scratch datadir, `loadwallet` it, and
> confirm `getbalances` and `getaddressinfo <expected address>` report what you
> expect. Only then proceed. Note `getnewaddress` is **not** a valid check after a
> restore: the rescan advances the descriptor past every index with history, so it
> correctly returns something later than index 0.

## 7. Hard-won lessons

These are real incidents, not hypotheticals. Each one cost hours or money.

1. **A transient read overwrote authoritative state — three separate times.**
   The general rule, stated once and enforced everywhere:
   *an RPC that failed, timed out, or answered "I do not know" resolves nothing.*
   It can never advance a record, never clear one, and never authorise a build.
   The doctrine is written at `ForwardPolicy.kt:16-26`; the storage-layer
   consequence at `Prefs.kt:11-24` (persisted values are split into
   *authoritative intent*, written with `commit()` only by a user action or a
   node-confirmed terminal outcome, and *derived display*, freely recomputed);
   and the concrete guard at `NodeController.kt:420-429` — `getaddressinfo` is
   **wallet-scoped**, so with two wallets loaded, asking the wrong one whether it
   owns an address returns a confident, authoritative-looking `false`. Code that
   trusted that answer discarded the user's payout address, and block rewards go
   to a key nobody has. The fix was to persist `payoutWallet` alongside the
   address (`Prefs.kt:80-99`) so the question is always aimed correctly, and to
   make the check diagnostic-only. Contrast `MinerService.kt:376-381`, which
   *does* adopt a change — because it reads persisted intent, not a node
   observation, and the guard is one-way: a blank value never clears an address
   already held.
   **Rule: model "unknown" as its own state. Never let it collapse into "no".**

2. **An error was silently converted into a definite answer.** A
   `getrawtransaction` failure was read as "0 confirmations" — an unanswerable
   question became a definite "not confirmed", which in a send path authorises
   spending the same coins again. *(Historical: the original call site is gone;
   the surviving evidence is the doctrine comment and the shape of the
   replacement.)* The current code models every failure mode explicitly:
   `ForwardEngine.observe()` (`ForwardEngine.kt:841-895`) distinguishes *threw*
   (`readable = false`, resolves nothing) from *answered −5 "no such
   transaction"* (`readable = true, knownToWallet = false`, a real fact), and
   does the same again for `getmempoolentry`. A `confirmations < 0` reading must
   be seen twice, far apart, before it is acted on (`ForwardPolicy.kt:138,281`).
   **Rule: `optInt("x", 0)` on a call that may not have happened is a bug.
   Defaults must be unknown-shaped, not answer-shaped.**

3. **Tray apps launched from a service were invisible.** Windows isolates
   services and everything they launch into **session 0**, which has no desktop
   and no notification area. The app ran perfectly, mined perfectly, and the
   person at the keyboard reasonably concluded their PC was not mining. Worse,
   the single-instance mutex is session-scoped, so the invisible copy did not
   stop a second copy in the user's session, and the two fought over the mining
   mode. **This happened on two of three machines.** Fix: `PCoinTray.cs:75-99`
   refuses to start in session 0 and says why — and does it as the very first
   thing, before any node is started, so there is never a node left behind by the
   process that gives up. The recovery path is a **one-shot interactive scheduled
   task** at `install.ps1:213-219` (`schtasks /create /tn PCoinTrayLaunch … /sc
   once /st 23:59 … /it /f`, run, then delete). Do not confuse it with
   `install.ps1:186`, which creates a *different*, persistent task
   (`/tn PCoinMiner … /sc onlogon /it /rl LIMITED`).
   **Rule: on Windows, "it ran" and "the user can see it" are different claims.**

4. **`arith_uint256` silently wrapped and corrupted the difficulty.**
   `CalculateNextWorkRequired`'s `bnNew *= nActualTimespan` overflows for every
   PCoin retarget, because `arith_uint256::operator*=(uint32_t)` discards the
   carry out of the top limb with **no overflow detection**. Height 2016 produced
   `0x1e0b7c33` instead of `0x1f03ffff` — a 356× jump. Every node computed the
   same wrong answer, so consensus held, and blocks 2016..2799 are only valid
   under the wrapping arithmetic. **Fixing it would orphan the live chain**, so
   the legacy path is deliberately left broken and documented: the DO-NOT-MODIFY
   block is `src/pow.cpp:221-231` and the `CalculateNextWorkRequired` warning is
   `:263-278`. The LWMA replacement carries an *exact, checked* guard instead of
   an argument (`:177-201`). Golden vector:
   `contrib/lwma/lwma_ref.py legacy(0x1f0fffff, 1785700177, 1785600628) == 0x1e0b7c33`
   (also `src/test/pow_tests.cpp:381`).
   **Rule: unsigned wraparound is not an error, it is a wrong answer that looks
   right. Check explicitly — and once a wrong answer is in a chain it is the spec.**

5. **Unguarded concurrent `Start`/`Stop` in the CPU miner called
   `std::terminate`.** Two tray apps on one PC issued `startmining`
   simultaneously; one thread was assigned over a still-joinable `std::thread`,
   which terminates the process — observed in the field as exception `0x40000015`
   (STATUS_FATAL_APP_EXIT) with two `pcminer-sup` threads. Fix:
   `m_lifecycle_mutex` (`cpuminer.h:94`) + `StopLocked()` (`cpuminer.h:83-84`,
   `cpuminer.cpp:139`) serialise the whole lifecycle. Two subtleties that must
   survive any refactor: `Stop()` **must never be called from the supervisor
   thread**, because it joins it; and `StopLocked()` always joins and never
   early-returns on `m_running`, because the supervisor can retire itself via the
   TTL.
   **Rule: an RPC entry point is a concurrent entry point. Any handle you can
   reassign, you can `std::terminate` on.**

6. **A non-idempotent retry duplicated part of a chunked upload.** An earlier
   deploy appended each base64 chunk to one file; when a write succeeded but its
   response was lost in the tunnel, the retry appended the same chunk again and
   produced a corrupt binary that still looked plausible. Fix
   (`deploy_tray.py:3-10`, `:136-146`): each chunk goes to its **own numbered
   file** written with `Set-Content` (never appended), the assembled length is
   checked, and SHA-256 is verified before decoding. Related: **a 404 from
   `/execute` usually means the response could not be delivered, not that the
   command failed — it probably ran.** `run_remote.py` retries 404s because the
   tunnel flaps, and that retry is only safe for idempotent scripts.
   **Rule: if the transport can lose a response, every operation on it must be
   idempotent, and the result must be verified by content hash, not by "the call
   returned".**

7. **PowerShell text-mode redirection corrupts binary payloads.** `>`, `>>`,
   `Out-File` and `Set-Content` are text APIs: they apply an encoding and
   line-ending translation, so piping a wallet file or an executable through them
   produces a file of the right general size that is silently wrong. *(Inferred
   from the mitigation, which is total: every binary path in the tooling
   base64-encodes and then writes bytes explicitly — `backup_phones.ps1` uses
   `adb exec-out … base64` + `[IO.File]::WriteAllBytes`; `pull_pc_wallets.py`
   decodes and opens `"wb"`; `deploy_tray.py` gzips and base64s. Nothing anywhere
   redirects a binary.)*
   **Rule: move binaries as text you chose the encoding for, or as bytes you
   wrote yourself. Never through a shell redirection.**

8. **Double quotes are stripped from scripts in transit by the remote-execution
   transport.** A script that works locally silently changes meaning on the
   device — this reproduces reliably: a `-Filter "Name='bitcoind.exe'"` arrives as
   `-Filter Name='bitcoind.exe'` and errors. Use single quotes only; where a
   literal `"` is genuinely needed, build it as `[char]34` — `fleet.ps1` does this
   at lines 4, 5 and 10, though **not** at line 7, which still carries a literal
   `'"time":\s*(\d+)'`. Do not assume the file is uniformly safe; check the line
   you are copying. Related constraints on the same transport: the bare MCP tool
   name does nothing (it must be wrapped in `mcp_call`), long scripts fail
   (Windows caps a command line at 32k, hence the chunking), and any
   `[scriptblock]::Create((iwr …))` payload is blocked by AMSI on the device.
   **Rule: when a string crosses a transport you do not control, assume it is
   mutated. Verify the received text, not the sent text.**

9. **Mining before a node has synced builds a competing fork.** This is why
   `install.ps1` defaults to `-Threads 0` — installed, not mining.

10. **A wallet-scoped RPC answered about the wrong wallet.** Called out
    separately from #1 because it generalises: `getaddressinfo`, `gettransaction`
    and `getbalances` are all `-rpcwallet` scoped, and with two wallets loaded
    they will confidently answer about whichever one you did not mean. Always
    pass the wallet explicitly.

11. **`importdescriptors` returns a result per descriptor and does not fail the
    call** when only one worked (`PCOIN.md` §6.6). A wallet that imported the
    receive descriptor but not the change one accepts coins and cannot build
    change — invisible until the first send. Check every `success`.

12. **The `.deb` declared `Depends: libc6` and nothing else, so it installed
    fine and then never ran.** The binaries link libevent dynamically; Ubuntu
    26.04 ships only `libevent_core`, so `bitcoind` died at every start with
    `libevent_extra-2.1.so.7: cannot open shared object file` and systemd
    crash-looped it 43 times. dpkg reported success throughout, because a
    missing *undeclared* dependency is not a packaging error — it is a
    packaging omission, and nothing checks for it. Fixed at
    `contrib/linux-deb/build-deb.sh:52`, which now declares all three libevent
    modules with `-7t64 | -7` alternatives for the 64-bit-time_t rename, and
    prints `objdump -p … NEEDED` at build time so the declared list can be
    compared against the real one. **Rule: an install that succeeds proves the
    files were copied, nothing more. Test a package on a machine that has never
    had the software's dependencies — a dev box always has them already.**

## 8. Operating rules

* **Phones**: only the **Z Flip 5** is the designated test device. No mining, no
  sustained load, no experiments on the Pixel 4a or the SM-S135DL without an
  explicit go-ahead. **Always delete any binary pushed to a device** when done.
  And see §4: `gradlew.bat testDebugUnitTest` without a `--tests` filter is a
  device-touching command.
* **Never commit or push without review.** There is no CI; nothing catches you.
* **Secrets stay on `D:`** — `D:\pc.am\PCOIN-SECRETS.md`, backups in
  `D:\pc.am\wallet-backups`. Nothing in this repo may contain a key, token,
  password or seed phrase. `.gitignore:26-32` blocks `*SECRETS*`, `*credential*`,
  `*.key`, `*.pem`, `wallet.dat`, `*wallet-backup*` — treat that as a safety net,
  not permission to try.
* **The GCP box is shared production.** Graceful Apache reload only, never a
  restart. Other people's sites are on it, on an EOL PHP.
* **The chain is live.** Consensus edits orphan real blocks. Every node must run
  ≥ v1.2.0 before height 2800.
* **Do not modify the Android app directory** while another workflow is editing
  it, and remember it has no version control — there is no undo.
* **Never import a scratchpad helper to read it.** See §5 on `deploy_tray.py`.
* **Browser automation always uses the dedicated Edge instance on port 9136.**
  Never 9222, never the user's normal Edge. Two sessions sharing one browser
  produced mixed-up state — Play Console tabs from another session appearing in
  the middle of a form this session was filling. Check first, launch if absent:

  ```powershell
  # reuse if alive, otherwise start it
  if (-not (Get-NetTCPConnection -LocalPort 9136 -State Listen -EA SilentlyContinue)) {
      Start-Process 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' -ArgumentList @(
        '--remote-debugging-port=9136',
        '--user-data-dir=C:\Users\pars\AppData\Local\Temp\edge-claude-9136',
        '--no-first-run','--no-default-browser-check','--start-maximized')
  }
  ```

  The profile at `edge-claude-9136` persists logins between runs, so the user
  signs in once per site rather than every session. Two things that cost time
  before: **the browser exits on its own** and every call then times out — check
  the port before blaming the page; and **x.com floods CDP with events**, so use
  a client that does NOT call `Runtime.enable` / `Page.enable` / `DOM.enable`
  (`scratchpad/cdp_lite.py` is that client) or every request times out on a page
  that is perfectly healthy.

## 8b. THE PUBLIC SURFACES ARE PART OF THE CHANGE, NOT A WRITE-UP OF IT

**If a change alters anything a user could see, believe, or act on, the public
surfaces are updated IN THE SAME SESSION. A change is not finished until they
are.** They are not documentation that may lag; they are the only channel most
people will ever read, and the only one that reaches users nobody can contact.

| surface | host / path | update it when |
|---|---|---|
| **pc.am** | `35.239.156.16:/var/www/pc.am/index.html` (from `site/index.html`) | anything user-visible: a new service accepting PCN, a new platform, a changed rate or claim, a consensus milestone, a new channel |
| **market.pc.am** | `178.105.178.27:/opt/pcoin-market` | prices, limits, what is for sale, how delivery works |
| **explorer.pc.am** | `178.105.3.51:/opt/pcoin-explorer` | new API endpoints or a changed response shape wallets depend on |
| **docs.pc.am** | `178.105.3.51` | the integration guide, whenever an integration's behaviour changes |
| **pcnearner.pc.am** | `178.105.178.27:8787` | the GPU-earner API surface and payout terms |
| **@PCoinPCN** (Telegram, `-1003712285504`) | `pcoin-announce` | anything users must ACT on, or would want to know |
| **explorer.pc.am/admin/** | `178.105.3.51:/opt/pcoin-ops` (from `contrib/ops-dashboard`) | a new miner, a new payment integration, a retired address — §8c |

### 8c. The five services that accept PCN

Four are live and have each credited three real deposits; the fifth is a
third-party integration still in review. **Deposit addresses are per-user and
REUSED**, which is the whole reason the ledger key below is not negotiable.

| service | credits you get | deposit address | code |
|---|---|---|---|
| **checker.pc.am** | credits | `pc1qnfk7xenwzxx7h4mx88g004crlx0m2zcjg3nq4j` | `pars5555/checker-pc-am`, on 35.238.47.14 |
| **webbuilderbot** | USD balance | `pc1q59d4tnhq6k3qqa9u5gvtuj05zswnjz3a900uxa` | `oonak-ai/ai-tgbot`, on 116.203.221.42 |
| **aicontrol.pc.am** | USD credit | `pc1q8ghcjcxxuv6wg4sp7zhs6udv3vfpm6y8l9kfm5` | `oonak-ai/aicontrol-server` |
| **3dmodels.pc.am** | credits | `pc1qtadn46mj4p6w9gwgykz8j7h8yh89k90rsqxgsv` | own repo, **no remote** — one disk |
| **3dmodel.oonak.ai** | credits | `pc1qpj707j3m5uqchj6j2vswvgnsfsags9lp0stffl` | `d:\xampp\htdocs\3dmodel` — **IN REVIEW, do not treat as live** |

`3dmodel.oonak.ai` and `3dmodels.pc.am` are **different products with different
wallets**. Nothing may be shared between them, and a reviewer who reads the
wrong directory will report nonsense about both.

**Every one of these addresses is in the admin dashboard** (`explorer.pc.am/admin/`,
`config.json` → `fleet`, labelled `PAYMENT - <service>`), so one page shows every
rail's balance beside every miner. Adding a service means adding it there too —
that is what makes the dashboard the answer to "is money arriving", rather than
a list someone has to remember to update.

The four non-negotiables, each of which has been shipped WRONG by a real
integration and cost money to find. The full guide is `site/docs/index.html`
(published at docs.pc.am); this is the short list:

1. **Key the ledger on `(txid, address)` — never `(txid, vout)`.** `vout` is
   always 0 for these deposits, so the wrong key silently DROPS a second
   deposit instead of erroring. All four live services shipped this wrong first.
2. **Read the rate from `price.pc.am` at credit time and STAMP it on the row**
   (`credited_rate_usd`). A hardcoded rate is how 3dmodels credited a batch at
   one fifteenth of value, and how pc.am advertised a stale price for hours.
3. **A failed, timed-out or stale read resolves NOTHING — hold, never credit.**
   An unreadable rate is not a rate of zero; an errored explorer call is not
   "no payment". Watch for `?? 0`, `?: 0`, `(int)$x` on a failed call, and
   `@`-suppressed calls: each turns "unknown" into a number.
4. **Gate on the deposit's own block height, 6 confirmations** (100 for
   coinbase), and **detect reorgs but never auto-reverse a credit.**

Monitoring: `pcoin-deposit-watch` (every 5 min, both hosts) watches the
watchers, and `pcoin-payment-report` (every 2 min) posts each credit to the
private ops channel with who/where/PCN/USD/rate-used/rate-now. Both live only
on the servers — see §9.

### The rule that keeps it honest

**A number on a public page is a promise.** Never hardcode a rate, a supply
figure, a percentage or a version where it can rot. If it must appear, it must
be derived at render time or re-checked whenever it is touched. Two real
examples from this project:

* pc.am said **"1,000 PCN = $1.00"** for hours after the credit rate moved to
  $0.015 — the site was quoting customers **one fifteenth** of what the four
  services were actually paying them.
* It claimed **"one address holds about 92% … 107,900 of ~116,800 PCN"** long
  after that stopped being true (48% in the largest address, ~75% across three).
  That one is worse than a stale price, because it is a *fairness* disclosure —
  being wrong about it costs credibility that a price cannot.

### Before every deploy of pc.am

```bash
git log --oneline -8 -- site/index.html | grep -i "do not deploy"
```

Commits are deliberately used to STAGE copy that only becomes true after an
event ("LWMA is active" written before the fork). If that matches, read the
commit body for the condition it is waiting on.

`site/index.html` is **CRLF**. Anchor edits on a single line, or read and write
**bytes**; a text-mode round trip silently rewrites the file to LF and every
multi-line anchor stops matching on the next edit.

Deploy **atomically** — stage into the same directory and `mv`. A plain
in-place `cp` lets Apache serve a half-written file to a request that arrives
mid-copy; that has already happened and produced a page missing two links.
No Apache reload is needed for a static file, and on that box a restart is
forbidden — it serves ~215 unrelated vhosts.

Then verify by **fetching the public URL back** and comparing to the repo copy.
Do not trust the upload.

### Announcements are a separate act from alerts

Operational alerts go to the private channel (`ALERT_CHAT`, `-1004340510788`)
and must **never** reach `@PCoinPCN`. That mistake has been made once already:
subscribers received `status=3/NOTIMPLEMENTED` and an internal hostname. Public
announcements are written deliberately, for people, and go out through
`pcoin-announce`, which refuses anything that looks operational.


## 9. Current state, and what is next

State measured on the seed, **2026-08-04** — **re-measure before relying on any
of it**: height **2082**, difficulty 0.0003401078 (bits `1e0b7c33`), txcount
**2089** of which **6** are non-coinbase, UTXO set **2035** outputs,
`size_on_disk` ~652 KB, total supply **104,100 PCN**. The seed has 7 inbound and
0 outbound connections — it is purely a rendezvous point. Combined desktop
hashrate ≈ **1,120 H/s** across three PCs (519 + 140 + 461), plus two phones.

Two numbers people get wrong here:

* **`du -sh /root/.pcoin/blocks` reports 18 MB, not 652 KB.** Core preallocates
  `blk*.dat`. The block *content* really is under 1 MB; the filesystem usage is
  not. Both statements are true and they differ by ~28×.
* **The chain is running SLOWER than target, not faster.** Measured from the
  seed: last 100 blocks ≈ **864 s/block**, last 20 ≈ 1082 s, last 10 ≈ 1213 s —
  all above the 600 s target. The chain-wide *average* of ~89 s/block is an
  artefact of the first ~2000 blocks being mined at powLimit (heights 0–2015 ran
  at ~49 s/block; 2016 onwards at ~1210 s). `src/kernel/chainparams.cpp:108-119`
  states it plainly: "measured pace 1317 s/block", "the chain is currently
  running ~2.2x slower than target", "Expect a one-off ~2x difficulty DROP at
  this height". **LWMA at 2800 exists to make blocks come faster, not slower.**
  At the observed pace, height 2800 is roughly **10 days** from height 2082.

Working tree is **dirty**: `PCOIN.md` (+188 lines, the new wallet-recovery-phrase
§6), the five tracked `contrib/windows-tray` files, and
`src/node/cpuminer.{h,cpp}` (the `m_lifecycle_mutex` fix from lesson 5) are all
modified and uncommitted, plus ten untracked tray sources. **The concurrency fix
and the entire recovery-phrase client feature are not committed anywhere.**

Open items, roughly in order of how much damage they do if ignored:

1. ~~`site/index.html` links to v1.0.0 binaries.~~ **Fixed.** pc.am now has a
   `#download` section linking every platform through
   `/releases/latest/download/<version-less name>`, so it tracks the newest
   release without an edit. See §4 "Cutting a release" for why the names must
   stay version-less.
2. ~~Get the tray sources and the Android app into version control.~~ **Fixed.**
   Both are tracked, as is the packaging script `contrib/linux-deb/build-deb.sh`.
   (`installer.iss` was removed with the installer — see §4 "Cutting a release".)
3. ~~The docs are stale on difficulty.~~ **Fixed.** 34 verified corrections
   applied across `README.md`, `PCOIN.md`, `doc/INTEGRATION.md` and four
   `contrib/*` READMEs. Every surviving mention of 2016 blocks is now explicitly
   scoped to "below height 2800". Note `doc/bitcoin-conf.md`, `files.md`,
   `init.md`, `build-osx.md` and `release-process.md` are **unmodified upstream
   Bitcoin documents** and correctly say `bitcoin.conf` — do not "fix" those.
4. ~~`doc/WINDOWS-NODE-SETUP.md` says `bitcoin.conf`.~~ **Fixed**, along with a
   stale `pcoin-1.0.0-win64.zip` package name in the same file.
5. **The single seed has no monitoring.** `restart=unless-stopped` covers a crash
   and a reboot; nothing watches for "container up, chain stalled", and if
   `seed.pc.am` dies no new participant can bootstrap. There is no cron job or
   systemd timer watching it.
6. Version reporting is inconsistent: the binary says `v29.4.0`, the P2P user
   agent is still `/Satoshi:29.4.0/`, releases say v1.2.0. PCoin nodes are
   indistinguishable from Bitcoin nodes on the wire by user agent.
7. **No address index exists** — Core has never carried one and PCoin added none.
   `scantxoutset` is globally serialised behind a process-wide flag
   (`src/rpc/blockchain.cpp:2141-2168`) and is O(entire UTXO set) per call, so it
   must never be fronted by HTTP. ZMQ source is present but **not compiled in**
   (`CMakeLists.txt:146,236`; `getzmqnotifications` returns "Method not found" on
   the live seed), so an indexer must poll or the node must be rebuilt with
   `-DWITH_ZMQ=ON`. See §11.
8. The Windows PCs' `pcoin.conf` has duplicated `addnode` lines — **two of the
   three machines, with two different addresses**: DESKTOP-AKHQ7BJ has
   `192.168.1.150:9444` ×11, DESKTOP-I5UT4OJ has `192.168.1.100:9444` ×11, and
   DESKTOP-5SH2116 has a single `35.239.156.16:9444` and is unaffected. A deploy
   script appends without checking.
9. `backup_phones.ps1` and `upgrade_phones.ps1` still enumerate the removed
   moto g play.

## 10. Things a newcomer gets wrong

1. `doc/WINDOWS-NODE-SETUP.md` says `bitcoin.conf`. It is **`pcoin.conf`**.
2. Binaries keep upstream names (`bitcoind`, `bitcoin-cli`, `bitcoin-qt`). Only
   the datadir (`~/.pcoin`, `%LOCALAPPDATA%\PCoin`) and config are renamed — so
   omitting `-datadir` on a machine that also has Bitcoin is a real hazard. The
   tray installer forces an explicit datadir for exactly this reason.
3. **The Python functional-test framework cannot talk to a PCoin node.**
   `test/functional/test_framework/messages.py:80` still holds Bitcoin's
   `MAGIC_BYTES` (regtest `fabfb5da`; PCoin's regtest magic is `cfa5d4bb`). Every
   test using `add_p2p_connection` hangs and fails after 60 s. `feature_lwma.py`
   passes only because it is RPC- and node-to-node-only;
   `p2p_invalid_locator.py` fails, as predicted.
4. Tests that build their own blocks are broken a second way: `CBlock.solve()`
   grinds SHA256d, which is not the PoW hash, so hand-built blocks die with
   `high-hash` before reaching the rule under test. The equivalent negative tests
   live in `src/test/pow_tests.cpp`.
5. `MAX_FUTURE_BLOCK_TIME` in the Python framework was set to 900
   (`test/functional/test_framework/blocktools.py:57-59`) with a comment claiming
   it matches `src/chain.h` — it does not; `src/chain.h:37` is still 7200, and
   the 900 s rule is `LWMA_MAX_FUTURE_BLOCK_TIME` (`src/chain.h:56`), gated on
   `lwmaHeight`, which is `INT_MAX` on regtest.
6. Never "fix" `CalculateNextWorkRequired`'s overflow, and never reorder the
   divide/multiply in `LwmaGetNextWorkRequired`. See §7.4 and the comments at
   `src/pow.cpp:221-231` and `:263-278`.
7. Never set `nMinimumChainWork` without first giving
   `PermittedDifficultyTransition` a real LWMA bound. A startup assert at
   `src/kernel/chainparams.cpp:175` enforces this.
8. `getdeploymentinfo` does **not** report lwma. Its softfork list
   (`src/rpc/blockchain.cpp:1406-1412`) is unchanged from upstream — CLTV, CSV,
   SEGWIT, TESTDUMMY, TAPROOT — and LWMA is a plain height check, not a
   deployment. The only way to see fork state is the height.
9. `CLIENT_VERSION` is still 29.4.0 (with `CLIENT_NAME "PCoin Core"`) even though
   releases are v1.x — see §9.6.
10. Default signet keeps Bitcoin's challenge, so its magic equals Bitcoin
    signet's and it can never produce blocks. Use `-signetchallenge`.
11. ~~`src/chainparamsseeds.h` still contains Bitcoin's IPs but is no longer
    `#include`d anywhere. It is dead, not active.~~ **WRONG on both counts,
    corrected 2026-08-12.** Commit `2776061` replaced Bitcoin's 2,552 lines with
    PCoin's own 48, and the file is `#include`d at `chainparams.cpp:9` and *used*
    at `:212` (`vFixedSeeds = chainparams_seed_main`). It holds **all three seed
    IPs** as BIP155 tuples and is the bootstrap fallback when DNS is down,
    blocked, or `-dnsseed=0`. Do not "clean up" a file that is load-bearing.

    While you are here — **how a node finds peers, in order**: `peers.dat`
    (a node that has run before needs no seed at all) → the DNS seed
    `seed.pc.am` → these fixed seeds → then `addr`/`getaddr` gossip, which is
    what actually makes the network decentralised. **If every one of our servers
    dies the chain does not stop**: existing nodes keep their peers and keep
    mining. What breaks is *new* nodes joining, because all three fixed seeds
    and the DNS name are ours. The fix is community-run seeds, exactly as the
    comment at `chainparams.cpp:197` says; until then a newcomer can always use
    `-addnode=<any live peer>`.
12. **Reorgs are routine on this chain, not exceptional.** `getchaintips` on the
    live seed returns **66 tips** — 28 `valid-fork`, 36 `valid-headers`, several
    with `branchlen: 2`, plus one `headers-only` tip with `branchlen: 2015`
    forking at genesis. That is a ~3% stale rate over 2,082 blocks. All of it is
    from the fast 49 s/block era (zero stales since height 2016), which is the
    point: stale rate tracks propagation delay over block spacing, and LWMA at
    2800 will roughly halve spacing again. Any tool that walks the chain must
    handle reorgs from day one.

## 11. If you are about to build the block explorer

Design and critique were done separately; the load-bearing conclusions:

* **The node cannot answer "what does this address hold."** The chainstate is a
  UTXO set keyed by outpoint with no reverse map from script to outpoints.
  `txindex` is txid → tx, a different question. An address index must be built
  outside the node (or added as a new `BaseIndex` subclass).
* **Ingest via `getblock <hash> 3` over RPC polling.** Verbosity 3 returns
  decoded transactions including each input's `prevout` (and `prevout.generated`
  for coinbase spends), so the indexer never parses a block file, never needs the
  magic bytes, never needs bech32/base58, and never needs to know PoW exists. ZMQ
  is compiled out, but polling is the right answer anyway — a dropped ZMQ
  notification stalls an indexer silently.
* **v1 reorg strategy: on any divergence, truncate and re-index from genesis.**
  A full re-index is under a minute at this size. Per-block rollback with undo
  semantics is the highest-risk code in the project and buys nothing for years.
* **Not every output has an address.** Genesis is a raw `pubkey` output, and
  *every* block's coinbase carries a zero-value OP_RETURN witness commitment.
  Address must be NULLable, and unspendable outputs need a flag or
  `scantxoutset` reconciliation will never balance.
* **`immature` is a mandatory third balance.** 2,083 of 2,089 transactions are
  coinbases; coinbase maturity is 100 blocks ≈ 33 h now and ≈ 17 h after 2800.
  Compute maturity in blocks, never render an ETA from a hardcoded spacing.
* **Amounts arrive as bare JSON numbers.** There is no string form —
  `JSON_BIGINT_AS_STRING` only affects integers. Round to satoshis explicitly.
* **A wallet-facing explorer needs mempool.** Without it, `/address/{a}/utxo`
  after `POST /tx` hands back the outpoint just spent, and the wallet
  double-spends itself.
* **Do not run it on the seed host as specced.** That box is the network's only
  bootstrap point and has no cgroup limits, a 128 MB shared InnoDB buffer pool,
  18 GB free and an EOL PHP. Separate host, or accept the risk explicitly.
* **Timing: after height 2800 lands cleanly, and after Send exists.** An index
  built through a possible chain split gets discarded anyway, and until Send
  exists the spend path — the hard part — gets zero exercise.
