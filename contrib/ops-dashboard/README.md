# PCoin ops dashboard

Private operator view: chain health, a miner census over the last N blocks,
peers seen by the seed, and on-chain balances for every address you care about —
your own miners and the deposit addresses of every PCN payment integration.

Deployed at **`https://explorer.pc.am/admin/`** (178.105.3.51, `/opt/pcoin-ops`,
systemd unit `pcoin-ops`, loopback-bound on 8787, proxied by Caddy).

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
| `./fleet` / `./payments` | fleet balances split by the `PAYMENT - ` label prefix, with totals rows |
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

## The trailing slash is load-bearing

The app emits RELATIVE links (`action="./login"`). That is what lets it be
mounted under a prefix at all — but at `/admin` with no trailing slash,
`./login` resolves to `/login`, which is not proxied to this app and lands on
the explorer's file_server as *"only GET and HEAD are served here"*. So Caddy
must redirect `/admin` to `/admin/` before anything renders:

```
handle /admin {
	redir * /admin/ permanent
}
handle /admin/* {
	reverse_proxy 127.0.0.1:8787
}
```

The cookie `Path` must match the mount point too, or a successful login hands
back a cookie the next request will not send.

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
* `collector/pcoin-pool-collect` — the pool's real workers, shares and found
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

`fleet` is a plain `{ address: label }` map and drives two things: the "mine"
flag in the miner census, and the balances table. Prefix a label with
`PAYMENT - ` to mark an integration's deposit address rather than one of your
own miners.

## Why it is in git now

It was not, for its whole life — 408 lines, one host, no copy. It was edited
three times in a single day by different sessions, and the site next door had
already been silently reverted twice by exactly that pattern before it was put
under version control. Deploy from here; do not edit the server copy in place.
