# fleet-health - the watchdog that stops a miner dying quietly

**Every miner in this estate runs unattended, and a stopped miner is silent.**
The pool cannot tell you "machine X stopped" - every machine logs in as a bare
payout address - and pool mining happens *inside* `bitcoind`, so a node that
will not start produces no hashing and no shares at all. The two incidents that
built this directory:

| date | machine | what happened | cost |
|---|---|---|---|
| 2026-10-08 | DESKTOP-VHQ1C8A (office01) | `peers.dat` corrupt -> **bitcoind refused to start**, by design; the tray tried once and gave up | 2 days of no mining while the tray, the scheduled task and the shortcut all looked healthy |
| 2026-10-09 | DESKTOP-6QIOQ5J (office02) | fell to **light mode**, 296 H/s instead of 1,760 | 6 hours at 1/7 the rate; cause was real memory pressure (8 GB box, 1.8 GB free) |
| 2026-09-30 | musho | BTRFS went read-only -> the node crash-looped **52,727 times** | 9 days |

The node's own message used to say what a human should do: *"As a workaround,
you can move the file ... out of the way (rename, move, or delete) to have a new
one created on the next start."* A fleet of unattended machines needs something
to be that human.

## What each script does

Both are deliberately narrow, idempotent and rate-limited. Neither starts a
second node, and neither fights the tray or the supervisor that own the miner.

**`miner-watchdog.ps1`** (Windows, the tray layout in `C:\PCoin`)
1. bitcoind not running -> quarantine `peers.dat` **if** the log says it is
   corrupt, then start `bitcoind -datadir=C:\PCoin\data -randomxfastmode`
   (the fast flag matters: without it the machine comes back in light mode).
   It checks port 9443 first, so it never races something already starting one.
2. bitcoind running in `light` while `pcoin-tray.cfg` asks for fast -> restart it,
   at most once an hour, **except** when the reported reason is memory - that one
   is real and restarting only wastes uptime.
3. Everything it does is appended to `C:\PCoin\watchdog.log`.

**`miner-watchdog.sh`** (Linux, the `systemctl --user` layout)
1. `pcoind` not active and its journal says the peers.dat is corrupt -> quarantine
   it and restart the unit (instead of the 52,727-restart loop).
2. node synced but **0 `pcminer` threads** while `pcoin-miner.service` is active
   -> restart the supervisor, because the supervisor is the ON switch
   (`bitcoin-cli stopmining` alone is undone within 30 s). Never touches a node
   still in initial block download, and restarts the supervisor at most every
   30 minutes.

## Install

Windows (one PC):
```powershell
# copy miner-watchdog.ps1 to C:\PCoin\ then:
powershell -ExecutionPolicy Bypass -File C:\PCoin\miner-watchdog.ps1 -Install
```
It registers the scheduled task `PCoinWatchdog`, every 10 minutes, highest
privileges, so it survives the tray being closed.

Linux (one user):
```bash
install -Dm755 miner-watchdog.sh ~/.local/bin/pcoin-watchdog
install -Dm644 pcoin-watchdog.service pcoin-watchdog.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now pcoin-watchdog.timer
```
The user must have lingering enabled (`loginctl enable-linger <user>`) - the
miners already do, since their node units are user units too.

## The durable fix is in the node, and it is not this

A watchdog treats the symptom. The correct fix for the peers.dat case is one
line of behaviour in `src/addrdb.cpp`: quarantine the corrupt file and continue
with an empty address manager instead of refusing to start - a corrupt peer
cache is an annoyance, not a reason to stop earning. That change is now
in `src/addrdb.cpp` (the corrupt file goes to `peers.dat.corrupt`), but it is a
node change and only reaches a machine with the next release. Until every miner
runs a build that has it, this directory is what keeps the fleet alive - and the
light-mode and stopped-supervisor checks stay useful after that.
