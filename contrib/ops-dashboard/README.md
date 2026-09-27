# PCoin ops dashboard

Private operator view: chain health, a miner census over the last N blocks,
peers seen by the seed, and on-chain balances for every address you care about —
your own miners and the deposit addresses of every PCN payment integration.

Runs on 178.105.3.51, `/opt/pcoin-ops`, systemd unit `pcoin-ops`, loopback-bound
on 8787.

> **RETIRED AS A BROWSER UI on 2026-09-27 (owner-approved).** The owner's admin is
> **https://admin.pc.am**. Every browser path under `explorer.pc.am/admin` — the
> pages below, the login form, `/logout`, the 2FA screen — is a **302 to
> `https://admin.pc.am/`**, for everyone. Two routes still answer, both
> machine-to-machine:
>
> * `POST /admin/collect` with a bearer token — the collectors below, through Caddy;
> * `GET /api` with the read-only bearer — the unified panel, over **loopback**
>   (`http://127.0.0.1:8787/api`), never through Caddy.
>
> It is enforced twice: in Caddy (the block below) and in `server.mjs` itself, so
> restoring an older Caddyfile cannot bring the login page back. The page
> renderers are still in `server.mjs`, unreachable, so reinstating one is a
> one-line change. 302 rather than 301 because a browser caches a 301
> indefinitely and this has to stay reversible. The page table below describes
> what the renderers produce, not anything a browser can reach.

## Layout

A left rail with one page per subject, in the shape of a conventional admin
panel; every listing has numbered pagination (25 rows/page):

| page | what it shows |
|---|---|
| `./` | dashboard — stat cards plus a short preview of each section |
| `./blocks` | recent blocks, paged back to genesis via `before_height`; each row shows who the coinbase paid |
| `./census` | who won each block (window selectable 100/200/500). A split coinbase is counted ONCE as the pool, not once per participant |
| `./pool` | the pool's REAL workers from its share log: 24 h share, ≈hashrate, last share, blocks found, paid |
| `./peers` | the collector's peer snapshot, with a loud staleness banner when the snapshot is old |
| `./fleet` / `./payments` | fleet balances split by the `PAYMENT - ` label prefix, with totals rows; `./fleet` also lists your machines, one row per machine, when `machines` is configured |
| `./address?a=…` | detail for one address: balance cards, mempool state, paginated confirmed history |

Detail pages use **query strings, not path segments** (`./address?a=…`), so
every page sits exactly one segment under the mount and relative links keep
working — see the trailing-slash section below. Height/txid links point at the
public explorer on the same host (`/block/{hash}`, `/tx/{txid}`), by hash so a
reorg cannot swap the page underneath.

The unknown-is-not-zero doctrine survives everywhere it matters: a null
`spendable` renders as *unknown*, an unobservable mempool is a warning banner
rather than a zero, a failed balances read on the dashboard says "unreadable",
and a block whose coinbase could not be fetched says so instead of "no miner".

## Why this is private, and must stay private

It links payout addresses to balances and to the operator's own fleet. That is
exactly the deanonymisation surface the public explorer deliberately does not
offer: on this chain **a deposit address IS a customer**, and index order IS
signup order. It sends `noindex,nofollow,noarchive`, and it must never be
exposed or linked from anything public.

## The Caddy block (explorer.pc.am, since 2026-09-27)

The Caddyfile lives only on the host (`/etc/caddy/Caddyfile`; Caddy there is
shared with another project, so it is validated as the `caddy` user and applied
with a graceful `caddy reload`, never a restart). This is the part that concerns
this app:

```
handle /admin {
	redir https://admin.pc.am/ 302
}
handle /admin/* {
	@ops_collect {
		method POST
		path /admin/collect
		header Authorization "Bearer *"
	}
	handle @ops_collect {
		reverse_proxy 127.0.0.1:8787
	}
	handle {
		redir https://admin.pc.am/ 302
	}
}
```

`method POST` matters: the previous machine matcher checked only the path and the
header, so a GET of `/admin/collect` carrying any `Bearer x` header slipped past
the owner-IP lock and was handed the login page.

If a page is ever reinstated: the app emits RELATIVE links (`action="./login"`),
so it only works mounted at `/admin/` WITH the trailing slash, and the session
cookie's `Path` must match the mount point.

## The collectors

Two hosts push data in through `/collect`; the dashboard itself reaches out to
nothing but the explorer beside it. Each snapshot carries its **own** `at`
timestamp and the UI judges staleness per-source — a fresh pool snapshot must
never make a dead peer collector look alive.

* `collector/pcoin-ops-collect` — peers/tips, runs **on the seed** from
  `/etc/cron.d/pcoin-ops` every 4 minutes as root. It runs there because the
  seed's RPC is loopback-bound inside its container and deliberately
  unreachable from anywhere else — the seed pushes a summary out rather than
  letting anything in.
* `pcoin-pool-collect` — **the copy is `contrib/pool/pcoin-pool-collect`**, not
  this folder (a stale 2026-08-19 duplicate lived here until 2026-09-23 and
  would have regressed the collector if deployed). The pool's real workers, shares and found
  blocks, runs **on the pool host** from root's crontab every 4 minutes. Same
  reasoning: the pool API is loopback-bound and the SQLite share log is
  root-only.

Both read the bearer token from `/etc/pcoin-ops-token` on their own host.

Two lessons already paid for:

* **The cron line discards output** (`>/dev/null 2>&1`), and the script uses
  `curl -sf`, so a failing POST is completely silent. When the dashboard moved
  from `/ops/` to `/admin/` on 2026-08-12, the collector kept posting to the
  old path and nobody noticed for six days — the UI now shows a loud staleness
  banner precisely because "no fresh snapshot" must never look like "fresh and
  quiet". If the banner is up, run the script by hand on the seed and read the
  exit code: `22` means an HTTP-level rejection (wrong path, wrong token).
* The deployed copy used to be the only copy. The file here is the master;
  deploy by copying it to `/usr/local/bin/pcoin-ops-collect` on the seed.

## Configuration

`config.json` lives beside `server.mjs` on the server and is **NOT in this
repo** — it holds the scrypt password hash, the session secret and the collector
bearer token, plus your address labels. See `config.example.json` for the shape.
`state.json` is runtime data written by the collector; also not tracked.

**Second factor.** Login is scrypt password + a six-digit TOTP code once
`totpSecret` is present in `config.json`. Enrol with

```
node /opt/pcoin-ops/server.mjs --gen-totp     # prints the secret and an otpauth URI
```

paste the secret into `config.json`, add it to your authenticator (scan the URI
or type the secret), then `systemctl restart pcoin-ops`. Until the key exists
the panel is **password only** and says so in the journal on every start —
deliberately, so a deploy can never lock you out before you have enrolled. The
code is checked with the same RFC 6238 implementation the market admin uses
(`totp.mjs`), so one authenticator entry per panel.

**Who is asking.** The login throttle and the audit rows key on
`clientip.mjs` — a copy of `contrib/market/clientip.mjs`, which is canonical;
keep the two identical. It trusts `CF-Connecting-IP` only when the request
demonstrably came through Cloudflare and otherwise uses the real peer. The
previous version read the first `X-Forwarded-For` entry, which the client
writes, so a guesser could reset their own lockout on every attempt.

The service runs as the unprivileged `pcoin-ops` user (drop-in
`/etc/systemd/system/pcoin-ops.service.d/10-hardening.conf`); `/opt/pcoin-ops`
is owned by it and is the only writable path.

`fleet` is a plain `{ address: label }` map and drives two things: the "mine"
flag in the miner census, and the balances table. Prefix a label with
`PAYMENT - ` to mark an integration's deposit address rather than one of your
own miners.

`machines` (optional) is a list with one entry per computer — `name`, `alias`,
`os`, `mode` (`solo` / `pool`), `pool`, `pays_to`, `forward_to` (`null` = paid
directly) and `note` — because `fleet` is keyed by address and several machines
pay one address. `./fleet` shows it above the balances, with each `pays_to`
balance taken from the same single explorer request. There is **no live column,
on purpose**: the node logs in to a pool with the bare payout address, so
neither the pool's share log nor the chain can tell machines that share an
address apart, and a per-machine "last seen" would be a guess. Put each
`pays_to` in `fleet` too, or the census will not count its blocks as yours.

## Why it is in git now

It was not, for its whole life — 408 lines, one host, no copy. It was edited
three times in a single day by different sessions, and the site next door had
already been silently reverted twice by exactly that pattern before it was put
under version control. Deploy from here; do not edit the server copy in place.
