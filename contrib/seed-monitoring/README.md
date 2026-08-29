# seed-monitoring

Watchers for the PCoin chain and for the services that take PCN. They alert to
the **private** ops channel via `pcoin-notify`. Nothing here may post to the
public channel -- see `CLAUDE.md` §8b.

## pcoin-deposit-watch: who watches which rail

This script checks each rail by reading that rail's **own** evidence -- its
config, its database, its log. That evidence is only readable on the host where
the rail runs, and no single host can read all of it. So each host declares the
rails it is responsible for in `/etc/pcoin-deposit-watch.conf`:

```sh
RAILS_EXPECTED="webbuilderbot aicontrol"
```

**The union of these lists is what covers the estate, and nothing computes that
union automatically.** If you add a rail, add it to exactly one host's list and
to the table below. A rail missing from every list is monitored by nobody, and
the failure is silent in exactly the way this table exists to prevent.

| rail | evidence lives on | watched from | how |
|---|---|---|---|
| `checker` | 152.53.171.190 | 152.53.171.190 | MySQL `settings.last_poll_at` |
| `webbuilderbot` | 116.203.221.42 | 116.203.221.42 | MySQL `settings.last_poll_at` |
| `aicontrol` | 116.203.221.42 | 116.203.221.42 | MySQL `pcoin_watcher_heartbeat` |
| `3dmodels.pc.am` | *(unassigned)* | — | log mtime + deposits file |
| `3dmodel.oonak.ai` | 202.61.252.202 | *(unassigned)* | log mtime + `deposits.json` |
| `portrait2video` | 167.233.206.186 | any host with the token | read-only HTTP status endpoint |

Rows marked *unassigned* are genuinely unwatched right now. The script says so
on every host whose `RAILS_EXPECTED` names them, which is the point: an
unassigned rail is loud, not invisible.

### Why a rail that cannot be checked ALERTS

Every per-rail check is guarded by `if [ -r <its config> ]`. On the right host
that is correct. On any other host the check does not fail -- it **vanishes**,
and the script exits 0 having examined nothing.

That is not hypothetical. On 2026-08-29 this script was running every five
minutes on 152.53.171.190 and checking exactly **one** of the five rails then
declared; the other four lived elsewhere. It produced no output and logged
*"all PCN deposit watchers healthy"*. Silence from a monitor is
indistinguishable from health, and it had read as healthy for weeks.

So a rail nothing looked at is now reported as **unknown** -- not as broken, and
not as fine. Collapsing unknown into either direction is the mistake the whole
PCN codebase is written against (`CLAUDE.md` §7.1).

Alerts are gated on **change**, with a daily re-assert. The concentration
watcher already taught this estate that repeating an identical alert every few
minutes is how people learn to ignore it; a gap that scrolled past weeks ago is
the one nobody remembers, hence the re-assert.

### portrait2video is checked differently, on purpose

It is the first rail not on a watcher host: SQLite on its own box, no config to
read here and no database to query. Granting a watcher SSH into the machine
that takes payments, to answer three integers, is a worse trade than asking over
HTTP -- so it exposes a read-only status endpoint carrying heartbeat age, stuck
count and reorg count, and nothing else. No money, no addresses, no user data.

```sh
# /etc/pcoin-deposit-watch.conf   (mode 600 -- it holds a token)
P2V_MONITOR_URL=https://<host>/internal/pcn-status
P2V_MONITOR_TOKEN=...
```

An **empty token disables the endpoint** rather than opening it, and an unset
URL is not a pass -- a rail nobody configured is a rail nobody is watching, and
the coverage report says so.

### Testing it

A monitor only ever observed saying "healthy" has not been tested. All four
paths -- healthy, stale, unreachable, unconfigured -- should be exercised
before trusting a change:

```sh
# nothing readable: must alert, must name every rail
CONF=/dev/null NOTIFY=/bin/true STATE_DIR=$(mktemp -d) bash pcoin-deposit-watch
journalctl -t pcoin-deposit-watch -n 5 --no-pager -o cat

# run twice with the same STATE_DIR: the second must be silent (change-gated)
```
