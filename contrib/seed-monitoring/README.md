# seed-monitoring

Watchers for the PCoin chain and for the services that take PCN. They alert to
the **private** ops channel via `pcoin-notify`. Nothing here may post to the
public channel -- announcements and alerts are separate acts, and alerts never go
public.

`pcoin-notify` sends with Telegram's legacy `parse_mode=Markdown` so the subject
can be bold, but **alert bodies are not escaped**. One unpaired `_` or `*` in a
body -- `<bsc_txhash>`, `*** EXHAUSTED ***`, half a txid -- and Telegram rejects
the whole message with *can't parse entities*. That dropped the wrap-desk nag
22 times in a row (2026-08-31 20:12 to 2026-09-01 18:39 UTC) with nothing but a
`failed` row in `pcoin-telegram-log` to show for it. Since 2026-09-01 the
notifier resends as plain text on that rejection: the bold is lost, the message
is not. Still write bodies as if they were plain text -- the fallback is a net,
not a formatting feature.

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
| `webbuilderbot` | the webbuilderbot host | same host | MySQL `settings.last_poll_at` |
| `aicontrol` | the webbuilderbot host | same host | MySQL `pcoin_watcher_heartbeat` |
| `3dmodels.pc.am` | the webbuilderbot host | same host | log mtime + docker db |
| `3dmodel.oonak.ai` | its own host | same host | log mtime + `deposits.json` |

Host addresses are in `D:\pc.am\PCOIN-SERVERS.md` (off-repo). The rails sit behind
Cloudflare, so their origin addresses are deliberately not written down here.

Five rails, all assigned as of 2026-08-29. Before that date only `checker` was
actually being checked, on the one host that ran the script; the rest lived on
machines it could not read and vanished silently.

If a rail appears in no host's list it is watched by nobody and nothing will
say so -- the coverage report can only speak about rails it was told to expect.
That is the one hole this design does not close by itself, and the reason this
table has to be edited in the same change that adds a rail.

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
PCN codebase is written against: an answer that never arrived resolves nothing.

Alerts are gated on **change**, with a daily re-assert. The concentration
watcher already taught this estate that repeating an identical alert every few
minutes is how people learn to ignore it; a gap that scrolled past weeks ago is
the one nobody remembers, hence the re-assert.

### A rail on a host the watcher cannot read

One rail is not on a watcher host: its state lives on its own box, with no config
to read here and no database to query. Granting a watcher SSH into a machine that
takes payments, to answer three integers, is a worse trade than asking over HTTP --
so such a rail exposes a read-only status endpoint carrying heartbeat age, stuck
count and reorg count, and nothing else. No money, no addresses, no user data.

```sh
# /etc/pcoin-deposit-watch.conf   (mode 600 -- it holds a token)
RAILS_EXPECTED="checker"
```

The token is a **path segment**, not a header: the watcher requests
`$URL/$TOKEN`. A wrong token answers **404**, the same as a route that does not
exist, so a leaked URL cannot be probed to learn whether the token half is close.

An unset URL is not a pass -- a rail nobody configured is a rail nobody is
watching, and the coverage report says so. `enabled:false` in the payload is
handled separately: a rail that has switched its own watcher off is neither
healthy nor crashed, and gets its own message rather than passing because the
endpoint answered.

Note the conf is **sourced**, so it wins over the environment. To test with
different values, point `CONF` somewhere else rather than exporting the
variables -- exporting them and watching nothing change is a confusing ten
minutes.

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
