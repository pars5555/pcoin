# Seed monitoring

All three seeds run a health check every 10 minutes. Installed 2026-08-07 and
verified against a real failure on each.

## Why "is the container running" is the wrong question

`restart=unless-stopped` already covers a crash and a reboot. What it does not
cover is the node being *up and useless*: chain stuck, every peer gone, or the
P2P port not accepting anyone. From the outside all three look identical to
health, and a seed that seeds nothing is exactly as bad as one that is down —
`seed.pc.am` is how a new node finds the network at all.

So the check asks four separate questions, each a distinct way of being useless:

| Check | Fails when |
|---|---|
| `rpc` | the node does not answer `getblockchaininfo` |
| `peers` | `getconnectioncount` is zero |
| `progress` | the tip has not moved AND is older than `STALL_SECONDS` (2 h) |
| `listening` | TCP 9444 refuses a local connection |

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

## Deliberately not included

**There is no alerting.** The check writes state and exits non-zero; systemd
records the failure and `systemctl list-units --failed` shows it. Wiring that to
email, Telegram or a pager is a one-line `OnFailure=` away, and none was chosen
because a notification channel nobody agreed to is a notification channel that
gets muted.

Until that is wired up, **this catches nothing on its own** — someone still has
to look. The honest description of today's state is "the seeds now record their
own health", not "the seeds are monitored".

## Servers

Access details are in `D:\pc.am\PCOIN-SERVERS.md`, deliberately not in this
repository. Seed 3 needs no `sudo`; the other two do.
