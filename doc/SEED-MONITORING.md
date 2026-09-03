# Seed monitoring

All three seeds run a health check every 10 minutes. Installed 2026-08-07 and
verified against a real failure on each.

## Why "is the container running" is the wrong question

`restart=unless-stopped` already covers a crash and a reboot. What it does not
cover is the node being *up and useless*: chain stuck, every peer gone, or the
P2P port not accepting anyone. From the outside all three look identical to
health, and a seed that seeds nothing is exactly as bad as one that is down —
`seed.pc.am` is how a new node finds the network at all.

So the check asks five separate questions, each a distinct way of being useless:

| Check | Fails when |
|---|---|
| `rpc` | the node does not answer `getblockchaininfo` |
| `peers` | `getconnectioncount` is zero |
| `progress` | the tip has not moved AND is older than `STALL_SECONDS` (2 h) |
| `listening` | TCP 9444 refuses a local connection |
| `supply` | total supply no longer equals 50 PCN x height (sampled — `gettxoutsetinfo` is O(UTXO set); `SUPPLY_EVERY=1` forces it, and a skip is not a pass) |

Both halves of the stall check are required. Height alone would fire during any
quiet stretch — the chain has legitimately run past 1200 s between blocks — and
tip age alone would fire on a slow patch that is progressing perfectly well.

Block timestamps are **not monotonic in height** on this chain (consensus only
requires beating the median of the last eleven), so a tip can read slightly
ahead of the wall clock. A negative age is clamped to zero rather than treated
as an error.

## What is installed

```
/usr/local/bin/pcoin-seed-watch                  the check
/etc/systemd/system/pcoin-seed-watch.service     oneshot, capped at 64M / 10% CPU
/etc/systemd/system/pcoin-seed-watch.timer       every 10 min, randomised ±120 s
/var/lib/pcoin-seed-watch/state                  last height and time
```

The randomised delay matters: all three seeds were installed the same afternoon
and would otherwise fire in lockstep, so one transient network blip could fail
all three checks in the same second and look like a network-wide outage.

## Reading it

```bash
systemctl list-timers pcoin-seed-watch.timer     # when it next runs
systemctl status pcoin-seed-watch.service        # last result
journalctl -u pcoin-seed-watch -n 20             # history
/usr/local/bin/pcoin-seed-watch; echo $?         # run it now, 0 = healthy
```

Healthy looks like:

```
ok: height 2338, tip 486s old, 15 peers
```

Unhealthy exits non-zero with the reason, and systemd records it:

```
UNHEALTHY: container pcoin-seed is not running
   Result=exit-code  ExecMainStatus=1
```

## Verified, not assumed

On seed 3 the node was stopped deliberately and the check was confirmed to
report `UNHEALTHY: container pcoin-seed is not running`, exit 1, with systemd
recording `Result=exit-code`. It returned to `ok` once the node was restarted. A
monitor that has only ever been seen to print "ok" has not been tested.

## Alerting

The check writes state and exits non-zero; systemd records the failure and
`systemctl list-units --failed` shows it. On the seeds that run it, that failure
reaches the private ops channel through a **drop-in**, not through the unit file
in this repo:

```
/etc/systemd/system/pcoin-seed-watch.service.d/10-onfailure.conf
    [Unit]
    OnFailure=pcoin-alert@%n.service
```

`pcoin-alert@.service` (in `contrib/seed-monitoring/`) sends the last journal
lines of the failing unit through `pcoin-notify`. `pcoin-fork-watch.service` and
`pcoin-fork-day.service` carry the same `OnFailure=` directly in their tracked
unit files; only the seed-watch wiring lives in an untracked drop-in.

**That asymmetry is the thing to watch.** A fresh install from this repo gets a
seed check that fails silently until someone adds the drop-in by hand, and
nothing detects the omission — the check still runs, still exits non-zero, and
still tells nobody. Verify with `systemctl show pcoin-seed-watch -p OnFailure`
rather than assuming; an empty value means this host is recording its own health
and nothing else.

## Servers

Access details are in `D:\pc.am\PCOIN-SERVERS.md`, deliberately not in this
repository. Seed 3 needs no `sudo`; the other two do.
