# PCoin — Windows always-on full node setup

Package: `pcoin-win64-miner.zip` from the release that built it —
<https://github.com/pars5555/pcoin/releases/download/v1.2.6/pcoin-win64-miner.zip>
(PCoin Core v29.4.0, x86-64, statically linked). Components release separately, so
`/releases/latest/` is **not** a safe way to reach a Windows build: a release that ships only
the Android wallet has no Windows asset and the link 404s. Assets gained a role word in
v1.2.6 — `-miner`, `-wallet`, `-earner`; `pcoin-win64.zip` is the pre-1.2.6 spelling.
Contents: `bitcoind.exe`, `bitcoin-cli.exe`, `PCOIN.md`, `pcoin.conf.example`.

The binaries are fully static (no MSVC runtime, no MinGW DLLs). Windows 10 /
Windows Server 2016 or newer, 64-bit only.

---

## 1. Where to put the files

Install the programs somewhere stable, e.g.:

```
C:\PCoin\bitcoind.exe
C:\PCoin\bitcoin-cli.exe
```

The **data directory** is separate and is where the blockchain, wallet and
config live. The default on Windows is:

```
C:\Users\<YourUser>\AppData\Local\PCoin\
```

For an always-on node running as a service, prefer an explicit directory on a
disk with room to grow, e.g. `D:\PCoinData`, and pass `-datadir=D:\PCoinData`
on every command (both `bitcoind.exe` and `bitcoin-cli.exe`).

Create it first:

```cmd
mkdir D:\PCoinData
```

## 2. The config file

The config file must be named **`pcoin.conf`** (PCoin Core renamed it; it is NOT `bitcoin.conf`). Copy the example config to:

```
D:\PCoinData\pcoin.conf
```

Minimum contents for an always-on node:

```ini
server=1
listen=1
txindex=1
daemon=0

rpcbind=127.0.0.1
rpcallowip=127.0.0.1
rpcuser=pcoinrpc
rpcpassword=PUT_A_LONG_RANDOM_STRING_HERE

dbcache=1024
maxconnections=64

# Point the node at the other PCoin machines so it can find the network:
# addnode=<ip-of-other-node>:9444
```

Notes:
- `daemon=0` on Windows — `bitcoind.exe` has no real daemon mode there; the
  service wrapper (below) is what keeps it running in the background.
- `txindex=1` requires a non-pruned node (`prune=0`, the default).
- Change `rpcpassword`. For something better than a plaintext password, use
  `share/rpcauth/rpcauth.py` from the source tree and put the resulting
  `rpcauth=` line in the config instead of `rpcuser`/`rpcpassword`.
- The node finds the network on its own: it resolves the DNS seed `seed.pc.am` and, if that yields nothing, falls back to compiled-in fixed seeds. `addnode=` lines pointing at the seeds (35.239.156.16:9444, 178.105.3.51:9444, 152.53.171.190:9444) or at each other are belt-and-braces, not a requirement.

## 3. First run (foreground, to check it works)

```cmd
C:\PCoin\bitcoind.exe -datadir=D:\PCoinData -printtoconsole
```

Watch for these lines:

```
RandomX proof-of-work verification initialized (light mode)
Bound to 0.0.0.0:9444
init message: Done loading
```

Stop it with `Ctrl+C`, or from another window:

```cmd
C:\PCoin\bitcoin-cli.exe -datadir=D:\PCoinData stop
```

## 4. Windows Firewall — open TCP 9444 inbound

PCoin's mainnet P2P port is **TCP 9444**. Run in an **elevated** (Administrator)
PowerShell or cmd:

```powershell
New-NetFirewallRule -DisplayName "PCoin P2P 9444" -Direction Inbound -Protocol TCP -LocalPort 9444 -Action Allow -Profile Any
```

or with netsh:

```cmd
netsh advfirewall firewall add rule name="PCoin P2P 9444" dir=in action=allow protocol=TCP localport=9444
```

Do **not** open the RPC port (9443) to the network — the config above binds RPC
to 127.0.0.1 only, which is what you want.

If the PCs are behind a router and you want inbound peers from the internet,
forward TCP 9444 to each machine (use a different external port per machine if
they share one public IP, and set `port=` accordingly; advertise the mapped address with `externalip=<ip>`).

Port reference:

| Network | P2P   | RPC   |
|---------|-------|-------|
| mainnet | 9444  | 9443  |
| testnet3| 19444 | 19443 |
| regtest | 49444 | 49443 |

## 5. Run it in the background

### Option A — NSSM (recommended)

NSSM makes `bitcoind.exe` a real Windows service that starts at boot, restarts
on crash, and runs without anyone logged in. Download NSSM from nssm.cc and put
`nssm.exe` in `C:\PCoin\`.

From an **elevated** cmd:

```cmd
C:\PCoin\nssm.exe install PCoinNode C:\PCoin\bitcoind.exe -datadir=D:\PCoinData -printtoconsole
C:\PCoin\nssm.exe set PCoinNode AppDirectory C:\PCoin
C:\PCoin\nssm.exe set PCoinNode DisplayName "PCoin Full Node"
C:\PCoin\nssm.exe set PCoinNode Start SERVICE_AUTO_START
C:\PCoin\nssm.exe set PCoinNode AppStdout D:\PCoinData\service-out.log
C:\PCoin\nssm.exe set PCoinNode AppStderr D:\PCoinData\service-err.log
C:\PCoin\nssm.exe set PCoinNode AppExit Default Restart
C:\PCoin\nssm.exe set PCoinNode AppRestartDelay 10000
:: graceful shutdown: give bitcoind time to flush the chainstate
C:\PCoin\nssm.exe set PCoinNode AppStopMethodConsole 120000
C:\PCoin\nssm.exe set PCoinNode AppStopMethodWindow 120000
C:\PCoin\nssm.exe start PCoinNode
```

Important: the stop timeouts matter. Killing `bitcoind` mid-flush can corrupt
the chainstate and force a full reindex.

Manage it with:

```cmd
sc query PCoinNode
C:\PCoin\nssm.exe restart PCoinNode
C:\PCoin\nssm.exe stop PCoinNode
C:\PCoin\nssm.exe remove PCoinNode confirm
```

If the service account cannot read `D:\PCoinData`, either grant
`NT AUTHORITY\LocalService`/`SYSTEM` access to it, or set the service to run as
your user: `nssm set PCoinNode ObjectName .\YourUser YourPassword`.
Note that the default data directory `%LOCALAPPDATA%\PCoin` belongs to *your*
profile — another reason to use an explicit `-datadir` for a service.

### Option B — Task Scheduler (no extra software)

From an **elevated** cmd:

```cmd
schtasks /Create /TN "PCoinNode" /SC ONSTART /RU SYSTEM /RL HIGHEST /F ^
  /TR "C:\PCoin\bitcoind.exe -datadir=D:\PCoinData"
schtasks /Run /TN "PCoinNode"
```

Then in Task Scheduler (`taskschd.msc`), open the task and set:
- Settings → "If the task fails, restart every" 1 minute, up to 3 times
- Settings → uncheck "Stop the task if it runs longer than"
- General → "Run whether user is logged on or not"

Task Scheduler will not restart the process if it exits cleanly and has no
crash-restart supervision as good as NSSM's, so NSSM is the better choice for
an always-on node.

To stop it cleanly, always use RPC rather than killing the task:

```cmd
C:\PCoin\bitcoin-cli.exe -datadir=D:\PCoinData stop
```

## 6. Checking sync and health

All commands need the same `-datadir` you started the node with.

```cmd
:: overall chain state - check "blocks" vs "headers" and "verificationprogress"
C:\PCoin\bitcoin-cli.exe -datadir=D:\PCoinData getblockchaininfo

:: quick height
C:\PCoin\bitcoin-cli.exe -datadir=D:\PCoinData getblockcount

:: are we still catching up?  "initialblockdownload": true means not synced yet
C:\PCoin\bitcoin-cli.exe -datadir=D:\PCoinData getblockchaininfo | findstr "blocks headers initialblockdownload verificationprogress"

:: peers - should be > 0; look at "inbound" to confirm port 9444 is reachable
C:\PCoin\bitcoin-cli.exe -datadir=D:\PCoinData getconnectioncount
C:\PCoin\bitcoin-cli.exe -datadir=D:\PCoinData getpeerinfo

:: network / listening status
C:\PCoin\bitcoin-cli.exe -datadir=D:\PCoinData getnetworkinfo

:: mining difficulty and hashrate view
C:\PCoin\bitcoin-cli.exe -datadir=D:\PCoinData getmininginfo

:: integrity check of the last N blocks (level 4 = full)
C:\PCoin\bitcoin-cli.exe -datadir=D:\PCoinData verifychain 4 100
```

The node is fully synced when `blocks == headers` and
`initialblockdownload` is `false`.

Live log:

```powershell
Get-Content D:\PCoinData\debug.log -Wait -Tail 50
```

## 7. Troubleshooting

- **No peers**: add `addnode=<other-pc-ip>:9444` lines to `pcoin.conf` and
  restart, or add at runtime with
  `bitcoin-cli -datadir=D:\PCoinData addnode <ip>:9444 add`.
- **No inbound peers**: firewall rule missing, or router port-forward missing.
  Confirm the node is listening with `netstat -an | findstr 9444`.
- **"Cannot obtain a lock on data directory"**: another `bitcoind.exe` is
  already running against that datadir (check Task Manager / `sc query
  PCoinNode`).
- **Corrupted chainstate after a hard kill**: start once with `-reindex`
  (slow — it re-validates every block, including RandomX proof-of-work).
- **Antivirus / SmartScreen**: these binaries are unsigned, so Defender
  SmartScreen may warn on first run. If Defender quarantines `bitcoind.exe`,
  add `C:\PCoin` and the data directory to the exclusion list — real-time
  scanning of the LevelDB files also slows sync considerably.
- **RAM**: RandomX verification runs in light mode and needs roughly 256 MB of
  cache on top of `dbcache`. Budget ~2 GB for the node.
