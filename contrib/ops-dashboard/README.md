# PCoin ops dashboard

Private operator view: chain health, a miner census over the last N blocks,
peers seen by the seed, and on-chain balances for every address you care about —
your own miners and the deposit addresses of every PCN payment integration.

Deployed at **`https://explorer.pc.am/admin/`** (178.105.3.51, `/opt/pcoin-ops`,
systemd unit `pcoin-ops`, loopback-bound on 8787, proxied by Caddy).

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
