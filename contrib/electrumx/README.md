# ElectrumX for PCoin

Two ElectrumX servers, `electrum1.pc.am` and `electrum2.pc.am`, are what make
PCoin listable on the Komodo DeFi Framework and usable by any Electrum-protocol
wallet. This directory is everything needed to rebuild either one from nothing.

The listing artifacts themselves — the `coins` entry, `electrums/PCN`, the icon —
live in [`../komodo-listing`](../komodo-listing). This directory is the
infrastructure; that one is the paperwork.

---

## The thing worth understanding before you touch anything

**No ElectrumX patch is required, and if you find yourself writing one you have
gone wrong.**

PCoin replaced the proof-of-work *check* with RandomX and the retarget algorithm
with LWMA. Neither is visible to an Electrum server:

* block IDs are still **double-SHA256** — `GetHash()` is unchanged
* headers are still a fixed **80 bytes**
* **ElectrumX never validates proof of work.** It trusts the daemon for that.

So PCoin needs a stock Bitcoin-derived coin class and nothing else. That is a
real advantage over KawPow and Equihash coins, whose integrations needed changes
to ElectrumX's header handling before they could be listed.

`pcoin_coin_class.py` is the whole PCoin-specific surface: version bytes, genesis
hash, RPC port, and a deserializer choice. It is ~25 lines of actual code.

---

## Layout

| file | what it is |
|---|---|
| `pcoin_coin_class.py` | the `PCoin(Coin)` class, appended into upstream's `coins.py` by the installer |
| `install-electrumx.sh` | idempotent installer: user, venv, coin class, systemd unit. **tcp only** |
| `enable-tls.sh` | certbot + deploy hook + switches on `ssl://` and `wss://` |
| `check-electrumx.py` | end-to-end verifier. Also the monitor's engine. Stdlib only |
| `pcoin-electrumx-watch` | checks every endpoint of both servers, from outside |
| `pcoin-electrumx-watch.{service,timer}` | 10-minute timer, `OnFailure=pcoin-alert@` |

Upstream is **`spesmilo/electrumx`, pinned at tag `2.0.0`**. Two things about
that choice, because both were non-obvious:

* `spesmilo/electrumx` is widely believed to have dropped altcoin support. It has
  not. `coins.py` still carries ~170 coin classes including Litecoin, Dash,
  DigiByte and Komodo — the file simply moved to `src/electrumx/lib/coins.py`.
* `kyuupichan/electrumX`, the original, is the one that dropped them. Its master
  is now BitcoinSV-only, 7 classes, last pushed January 2024. Do not fork it.

---

## Installing a third server

Assumes a Debian host already running a PCoin node with `txindex=1`.

**1. Give the node an RPC identity for ElectrumX.** Never reuse the explorer's.

```sh
PW=$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))')
python3 - "$PW" <<'PY' >> /path/to/pcoin.conf
import hmac, hashlib, os, sys
salt = os.urandom(16).hex()
print("rpcauth=electrumx:%s$%s" % (
    salt, hmac.new(salt.encode(), sys.argv[1].encode(), hashlib.sha256).hexdigest()))
PY
mkdir -p /etc/electrumx && chmod 750 /etc/electrumx
printf 'DAEMON_URL=http://electrumx:%s@127.0.0.1:9443/\n' "$PW" > /etc/electrumx/daemon.env
chmod 600 /etc/electrumx/daemon.env
```

> **If the node sets `rpcwhitelistdefault=0`** — seed 4 does — a user with no
> whitelist line gets *nothing*. Add one, and remember `getindexinfo`: the coin
> class declares `REQUIRED_DAEMON_INDEXES = ("txindex",)`, so ElectrumX calls it
> at startup and a missing entry fails the handshake, not the index.
>
> ```
> rpcwhitelist=electrumx:getblockchaininfo,getblockcount,getbestblockhash,getblockhash,getblock,getblockheader,getrawtransaction,sendrawtransaction,getrawmempool,getmempoolentry,getmempoolinfo,getnetworkinfo,estimatesmartfee,uptime,getindexinfo,testmempoolaccept,submitpackage
> ```
>
> **If the node does NOT set it** — seeds 1 and 3 do not — then adding *any*
> `rpcwhitelist` line flips the default to 0 for **every** user, and the
> explorer silently loses every method it uses. On those hosts, add the
> `rpcauth` line and no whitelist.

**2. Install, tcp only.**

```sh
./install-electrumx.sh electrum3.pc.am
```

**3. Prove the index before adding TLS.** This is the step people skip.

```sh
python3 check-electrumx.py 127.0.0.1:50001:t \
  --address pc1qnfk7xenwzxx7h4mx88g004crlx0m2zcjg3nq4j \
  --address pc1q85lry2j8n5yphq44mk86vc6u3rwygwlnc5ryc7
```

`server.version` answering proves almost nothing. The address check compares
`blockchain.scripthash.get_balance` against `explorer.pc.am`, which is an
*independently built* index. Two independent indexes agreeing on a 379-transaction
address is what actually proves the coin class is right; a wrong `P2PKH_VERBYTE`
or the wrong deserializer produces a server that passes every other check and
returns an empty history for the entire chain.

**4. DNS, then TLS.** A grey-cloud (**proxy OFF**) `A` record — the orange cloud
cannot carry TCP 50002/50004 — then:

```sh
./enable-tls.sh electrum3.pc.am
```

**5. Firewall and monitoring.**

```sh
ufw allow proto tcp from any to any port 50001,50002,50004 comment 'PCoin ElectrumX'
install -m 755 check-electrumx.py /usr/local/bin/pcoin-electrumx-check
install -m 755 pcoin-electrumx-watch /usr/local/bin/
install -m 644 pcoin-electrumx-watch.service pcoin-electrumx-watch.timer /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now pcoin-electrumx-watch.timer
```

---

## The four ways this fails silently

Komodo's rule is written down: *"Failing servers will result in an automatic
delisting of your coin upon the next release."* None of these show up as a dead
service.

1. **The certificate expired.** Renewal worked; nothing restarted. ElectrumX
   reads its certificate exactly once, at startup. This is why `enable-tls.sh`
   installs a `--deploy-hook` that restarts the service, and why the monitor
   fails at 10 days remaining rather than at 0.
2. **WSS is not actually serving.** A coin with no working WSS endpoint is
   dropped from the web wallet's generated config **without any delisting being
   filed** — it just stops appearing. So the monitor tests `wss` as a real
   WebSocket handshake, not as an open port.
3. **The index stalled while the node kept moving.** The monitor compares the
   server's tip against `explorer.pc.am` rather than against itself.
4. **The port closed from the outside** while loopback still answers. The monitor
   connects by public hostname, and each host also checks the *other* host — so
   a machine that falls off the internet is noticed by something other than a
   person.

Everywhere in this tooling, **an unreadable answer is UNKNOWN and fails the
check.** It never becomes a zero and never becomes a pass. A balance comparison
against a reference that could not be fetched would "confirm" a server that
indexes nothing at all.

---

## Local gotchas that cost time here

* **`REPORT_HOST` is on upstream's obsolete list and ElectrumX refuses to start
  if it is set at all.** The hostname belongs in `REPORT_SERVICES`.
* **`EnvBase.boolean()` is true for any non-empty string.** `PEER_ANNOUNCE=false`
  means **true**. To turn something off, set it to nothing.
* **`TOR_PROXY_PORT` is pinned to 9050 on purpose.** Left unset, ElectrumX probes
  localhost 9050, 9150 *and 1080* and adopts whatever answers. On seed 3 that is
  `gost`, an unrelated SOCKS relay, which would quietly start carrying PCoin peer
  traffic.
* **systemd `EnvironmentFile` needs `KEY=value` with no spaces.** ElectrumX's own
  docs show `COIN = Bitcoin`, which is envdir syntax and produces variables that
  are never read.
* **Certificates use DNS-01, not HTTP-01, and that is deliberate.**
  `electrum2.pc.am` lives on a host where ufw allows 80/443 only from
  Cloudflare's ranges, because `checker.pc.am` — somebody else's production
  service — sits behind Cloudflare there. HTTP-01 validates from unpublished
  vantage points, so it cannot be allowed by source address: the port must be
  open to the world while the challenge is fetched.

  The first implementation did exactly that, opening port 80 for the couple of
  seconds needed and closing it again via certbot pre/post hooks. It worked, but
  it briefly exposed an unrelated production origin six times a year — and when
  a run failed before reaching the post-hook, the port stayed open until somebody
  noticed. It happened twice during setup. `enable-tls.sh` now closes it from a
  `trap` for that reason, but the real fix was to stop needing port 80 at all.

  Both certificates are issued with `--dns-cloudflare` against a token scoped
  `Zone:DNS:Edit` on `pc.am` only, at `/etc/letsencrypt/cloudflare.ini` (0600).
  The token is recorded in `D:\pc.am\PCOIN-SECRETS.md` §17 and must never enter
  this repository. `enable-tls.sh` still contains the HTTP-01 webroot path, which
  is the right fallback for a host with no Cloudflare zone — a third server
  somewhere else can still use it.
