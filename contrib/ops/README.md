# contrib/ops — the operational layer for the payments host

Everything here runs on `178.105.178.27`, the box that serves market.pc.am,
price.pc.am, pool.pc.am, pcnearner.pc.am and explorer2.pc.am, and that holds the
market's hot wallet.

It is in git for one reason: **until 2026-08-17 none of it was, and a rebuild of
that host would have silently lost every one of these controls.** That is the
same gap that once left the tray and Android helper scripts untracked — the
difference being that these files are the only thing standing between an
anonymous stratum connection and a wallet.

**No secrets are in this directory and none may be added.** Every script reads
its credentials from a file on the host:

| script | reads | which contains |
|---|---|---|
| `pcoin-monitor.mjs` | `/etc/pcoin-monitor.conf` | Telegram token + chat id |
| `pcoin-caddy-watchdog` | `/etc/pcoin/alert.conf` | Telegram token + chat id |
| `pcoin-cf-firewall` | nothing | — |

## What each one is for

### `pcoin-monitor.mjs` — every 10 minutes, via cron
Checks the seed is reachable, the node answers, the chain is advancing, peers
exist, reorgs are sane, and that **pc.am's published download checksums match
GitHub's**. That last one is a tamper check: pc.am shares a box with ~215
unrelated vhosts on end-of-life PHP, so GitHub is an independent second channel.

It reported `unknown` **189 runs in a row** and nobody noticed, because pc.am
appends `# v1.3.0` to each hash line and the parser anchored the filename to
end-of-line. It matched every GitHub line and no pc.am line, so the comparison
set was always empty. A monitor stuck on "cannot tell" is indistinguishable from
one that works — which is the failure this whole file exists to prevent.

### `pcoin-caddy-watchdog` + `.service` / `.timer` — every 2 minutes
Caddy shipped `Restart=no`, so a crash took down all five surfaces until a human
noticed. `caddy-10-restart.conf` fixes that half. This watchdog covers the half
systemd cannot see: **running but not serving**.

Deliberately conservative, because restarting drops connections on five sites:

* probes the **loopback**, never the public name — a Cloudflare or DNS fault is
  not a caddy fault and must not trigger a restart
* requires **two failures 15s apart**
* one restart per run, then it reports and stops

Proven by stopping caddy for real: detected and restored in 23 seconds. Its
Telegram alert was itself broken on first install (it read `MARKET_CHAT`, which
the config file lost on 2026-08-15) and now falls back to `ALERT_CHAT`.

### `pcoin-cf-firewall` + `.service` / `.timer` — weekly
Restricts `:80`/`:443` to Cloudflare's published ranges, fetched live so the list
cannot go stale. Refuses to apply a list that fails a sanity check, because a
truncated download would lock every visitor out of every site.

**Currently partially defeated:** `pool.pc.am` is an unproxied record needing
Let's Encrypt HTTP-01, so blanket `Anywhere` rules were re-added on 2026-08-13.
The code-side defence still holds — `contrib/market/clientip.mjs` only trusts
`CF-Connecting-IP` when the peer is genuinely a Cloudflare address, verified by
sending forged headers straight to the origin.

### `pcoin-market.service`, `pcoin-price.service`
The hardened units. Both daemons ran as **root with the full capability set**
and holding the node cookie, which meant any bug in the checkout path, the
payment callback or the admin panel was root on the box and unrestricted wallet
RPC. They now run as their own unprivileged users with `CapabilityBoundingSet=`
empty and a syscall filter.

`MemoryDenyWriteExecute` is deliberately absent: V8 JIT-compiles and the service
will not start with it.

## Not here

`pcoin-pool.service` and the pool's config are the pool's own work and belong
with `contrib/pool/`. The same hardening was applied to it on 2026-08-17 — its
own user, empty capability set, seccomp, and an `rpcauth` identity whitelisted
to the seven RPCs it actually calls — after it was verified that the pool could
read the node cookie and retrieve `market-hot`'s xprv while parsing JSON from
anonymous internet miners.
