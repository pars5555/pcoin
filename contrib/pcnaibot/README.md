# pcnaibot — the PCoin AI bot

A Telegram bot (`@PcoinAiBot`) that sells paid AI models and takes payment in
PCN. It sits on the **OonaCode gateway** for the models and on the estate's
existing PCN deposit machinery for the money.

It is the **seventh PCN rail**. Everything in §7 of the build brief has already
been shipped wrong by a real integration here and cost real money to find, and
four of those were shipped wrong by *all four* rails that existed at the time —
one mistake, copied, not four. The comments in this tree name the incident
behind each rule; they are not decoration, and they are the reason to read the
code rather than skim it.

---

## What it is, and what it is not

**It is** a Telegram bot with its own token, its own systemd units and its own
SQLite database. A user picks a model and talks. Each turn is priced in USD from
the provider's returned token counts × the house margin, and debited from an
**integer micro-USD** balance. The user tops that up by sending PCN to a deposit
address that is **theirs forever**, taken from a pool derived offline.

**It is not custodial banking.** The bot holds no user keys and no user coins. A
deposit address is a leaf of *our* wallet; the money is ours the moment it
confirms, and what the user holds is a **service credit denominated in USD** —
one-way, non-withdrawable, non-refundable.

**It is not a wallet.** No key generation, no sending, no `/withdraw`, and **no
private key and no account xpub ever reaches the server** — only a list of
`(index, address)` pairs. A watch-only rail's worst bug fails to credit
somebody; a spending rail's worst bug sends coins to a stranger. This stays in
the first category.

**It is not one process.** Three: the Telegram bot, the deposit watcher and
the HTTP API, each with its own unit and its own memory limit — see below.

---

## Layout

```
bot.mjs                  the Telegram-facing process (long polling)
watch.mjs                the deposit watcher, a SEPARATE process on a timer
api.mjs                  the public HTTP API -- users calling their balance with a key
Dockerfile               one image, used by all three processes
migrate.mjs              explicit versioned migrations + the structural proof
heartbeat-check.sh       staleness check for both heartbeats; RUNS AS ROOT
migrations/              001_init .. 004_api_keys, explicit and versioned
systemd/                 units + timers + logrotate; systemd/docker/ for the container
test/                    39 tests: money path, billing path, API keys
lib/
  config.mjs             reads /etc/pcoin/pcnaibot.conf; keeps secrets OUT of env
  log.mjs                redact-by-allow-list logging; crash handlers
  time.mjs               nowSec() — epoch SECONDS, never milliseconds
  money.mjs              integer/BigInt money arithmetic
  db.mjs                 sqlite, BEGIN IMMEDIATE, schema assertions
  address.mjs            local bech32 validation
  pool.mjs               pool import and address allocation
  deposits.mjs           the atomic credit + the reconciliation invariant
  rate.mjs               price.pc.am, three clocks, two catch arms
  explorer.mjs           explorer API, request budget, index health gate
  registry.mjs           the model price table
  oonacode.mjs           the gateway client and the error buckets
  billing.mjs            reserve → settle | release | hold | age-out
  tokens.mjs             byte-based token estimation + calibration fixture
  telegram.mjs           Bot API, HTML escaping, splitting, retry_after
  wpcn.mjs               wPCN top-ups, ported from checker_pc_am's WpcnService
  vendor/wpcn-pay.mjs    the shared verifier client, VENDORED VERBATIM
  apikeys.mjs            per-user API keys (hashed) + the rate bucket
  probe.mjs              asks each model what the registry will not tell you
```

## Three processes, deliberately

| unit | what |
|---|---|
| `pcnaibot.service` | the Telegram bot, `Restart=always`, long polling |
| `pcnaibot-watch.service` + `.timer` | the deposit watcher, one tick per minute |
| `pcnaibot-api.service` | the public HTTP API, loopback only, behind Caddy |
| `pcnaibot-heartbeat.service` + `.timer` | staleness check, **as root** |

Running the watcher as a `setInterval` inside the bot would mean they share one
`MemoryMax=`, so a conversation-history spike OOM-kills the **credit path**,
`Restart=always` hides that behind `active (running)`, and `OnFailure=` can
never fire for a dead interval. Separate processes also mean the watcher never
needs the OonaCode key and the bot never needs the explorer.

**The heartbeat timer runs as root and that is load-bearing.** `pcoin-notify`
reads `/etc/pcoin/alert.conf` (mode 0600, root) and its own guard exits **0**
when it cannot — so a non-root caller gets silent non-delivery and a timer unit
reporting success, with the alarm on the money path dead.

## Secrets

`/etc/pcoin/pcnaibot.conf`, mode **0640 root:pcnaibot** — deliberately not
`0600 root:root`, because the process reads the file *itself* rather than having
systemd inject it. Putting the three credentials in `process.env` of a process
whose job is to accept arbitrary text from strangers and make outbound calls
with `Authorization: Bearer` is one `console.error(err)` away from a sixth leak.

Never add any of it to `/etc/pcoin/alert.conf` — that file is sourced by scripts
that post publicly.

`.gitignore` carries `contrib/pcnaibot/*.conf` with a `!*.conf.example`
negation, because **this repo is public and has no generic `*.conf` rule**.

## Install

```sh
useradd --system --home /var/lib/pcnaibot --shell /usr/sbin/nologin pcnaibot
install -d -o pcnaibot -g pcnaibot /var/lib/pcnaibot /var/log/pcnaibot
install -d -m 755 /opt/pcnaibot
rsync -a --exclude node_modules contrib/pcnaibot/ /opt/pcnaibot/
cd /opt/pcnaibot && npm ci --omit=dev

install -m 0640 -o root -g pcnaibot pcnaibot.conf /etc/pcoin/pcnaibot.conf   # fill it in first
sudo -u pcnaibot PCNAIBOT_CONF=/etc/pcoin/pcnaibot.conf node /opt/pcnaibot/migrate.mjs

install -m 644 systemd/pcnaibot.service systemd/pcnaibot-watch.service \
               systemd/pcnaibot-watch.timer systemd/pcnaibot-heartbeat.service \
               systemd/pcnaibot-heartbeat.timer /etc/systemd/system/
install -m 644 systemd/logrotate.pcnaibot /etc/logrotate.d/pcnaibot
install -m 755 heartbeat-check.sh /opt/pcnaibot/heartbeat-check.sh
systemctl daemon-reload
systemctl enable --now pcnaibot-watch.timer pcnaibot-heartbeat.timer
systemctl enable --now pcnaibot
```

`migrate.mjs` prints a `PRAGMA index_list` / `index_info` dump and asserts the
structure before exiting — that output is the evidence that
`UNIQUE (txid, address)` exists and no `vout` column does.

## The rules this rail is built around

1. **Key the ledger on `(txid, address)`** — never `(txid, vout)`. `vout` is
   always 0 for these deposits, so the wrong key degenerates to `UNIQUE(txid)`
   and **silently drops** a second deposit when one transaction pays two of our
   addresses. It fails *safe*, which is why nobody sees it. There is no `vout`
   column in this schema and `assertSchema()` refuses one.
2. **Read the rate from `price.pc.am` at credit time and stamp it on the row** —
   as an integer `rate_e12`, with its source and its read time. The rate is
   parsed from the response **text**, because `JSON.parse` turns it into a
   double and `toFixed(12)` then rounds *up* where the spec says floor.
3. **A failed, timed-out or stale read resolves nothing** — hold, never credit.
   Every client here returns a discriminated result; nothing returns a bare
   value a caller could `?? 0` into a decision.
4. **Gate on the deposit's own block height (≥ 2800), 3 confirmations, 100 for
   coinbase**, and detect reorgs but **never auto-reverse** a credit.
5. **`blocks_unwound` and `reorg_count` are cumulative lifetime counters — never
   gate on their value.** Live values are `1, 1` on explorer.pc.am and `0, 0` on
   explorer2; they will never return to 0. The gate is `stale === false`,
   `node_reachable === true`, `blocks_behind === 0`. A real mid-reorg signal is
   the **change** between two reads.

## Monitoring

The rail is watched by `contrib/seed-monitoring/pcoin-deposit-watch`, which this
build extends with:

* **`sqlite_q()`** and **`check_deposits_sqlite()`** — the SQLite twin of
  `check_deposits()`, which was MySQL-only end to end. Without it this rail gets
  heartbeat-only monitoring, i.e. *"asked 'is it ticking', not 'is it settling
  anything'"*.
* **`check_holding "pcnaibot" "$PCNAI_LOG"`** — which is why the watcher unit
  writes a real log **file**. `check_holding` is file-based (`[ -r "$logf" ] ||
  return 0`) and **journald is not a file**, so every DB-heartbeat rail in the
  estate has no holding check at all. That gap was the 3½-day outage.
* the **`case ",$skipped," in *,disabled,*)`** branch, which decides between
  *"deposits are landing and not being credited"* and *"rail not launched, not a
  fault"* by asking whether an address has ever been **issued**
  (`assigned_at IS NOT NULL`, never `chat_id IS NOT NULL`).

Every one of those was **proven to fire against seeded bad input** before being
trusted — and proven silent on a healthy baseline. A check that cannot fire is
indistinguishable from a check that passes.

**`RAILS_EXPECTED` in the repo is documentation, not deployment.** Every host
overrides it from `/etc/pcoin-deposit-watch.conf`, so editing the default here
reaches zero hosts. The per-host narrowing must be written **before** the script
is installed, or the first run fires a real `PCN rails NOT MONITORED` page at
the owner from a monitoring-setup step.

## Testing

```sh
node --test test/          # 39 tests, no network
```

They need `better-sqlite3`, which has no Windows/node-24 prebuild — run them on
the target host or any Linux box with node 20.

## Open items

* **`BYTES_PER_TOKEN = 2.2` is still uncalibrated** for the fallback path. It
  matters less now that `count_tokens` is known to work, but it is what the
  estimator falls back to when counting fails, and the bot's users write
  Armenian, where `chars / 3.5` runs **2.8× low** and Chinese **4.2× low**.
* **Q5b, Q8b and Q10 remain OPEN** — they need the console's cumulative
  `costUsd`, which sits behind a browser session token an API key cannot reach.
  They decide credit-unit rounding, whether tiering is live, and how a truncated
  stream is billed. The nightly console reconciliation is what would settle them.
* **wPCN is implemented but OFF.** The verifier's rate basis is fixed and
  deployed, but wrapping PCN and paying in wPCN still yields **~+4.5%** more
  credit than paying the same PCN directly (10% bonus × 0.95 wrap fee), which
  bypasses the pool buy the bonus exists to force.
* **Streaming is not implemented**, and the API refuses `stream: true` rather
  than silently returning a non-streamed body. Streaming would add the
  `message_start` early-abort, which is the only mechanism that *stops* a
  mid-answer overrun rather than discovering it afterwards.
* **wPCN is off** (`WPCN_ENABLED=0`) and must stay off until the shared verifier
  credits from `serviceRate` rather than `price`.

---

## The HTTP API

A user runs `/apikey` in Telegram and gets a key. That key spends the same
balance, through the **same reserve/settle path** — a turn costs the same
whether it arrived from Telegram or from curl, and both land in one ledger that
the reconciliation invariant closes over. Writing a second billing path here
would be the "one mistake, copied" shape this project keeps paying for.

```sh
curl https://ai.pc.am/v1/messages   -H "x-api-key: $PCN_KEY"   -H "content-type: application/json"   -d '{"model":"glm-5.3-flash","max_tokens":256,
       "messages":[{"role":"user","content":"Hello"}]}'
```

It is Anthropic-shaped on purpose, so an off-the-shelf SDK works unchanged.
`GET /v1/models` returns the caller's billable set **with our prices, margin
included**; `GET /v1/balance` returns their balance; every reply carries
`x-pcn-cost-usd` and `x-pcn-balance-usd`.

* **Keys are stored as a SHA-256 hash and shown once.** A stolen database yields
  no usable credential. Lookup is by hash on a unique index, so there is no
  candidate set and no per-key timing signal.
* **Absent, malformed, unknown and revoked all answer one 401.** The difference
  is only useful to somebody guessing.
* **`max_tokens` is required**, not defaulted — it is the only thing bounding
  the reservation, and a caller who omits it must be told rather than quietly
  charged for a ceiling they never chose.
* **`cache_control` is refused**, so a caller cannot opt us into billing blind.
* **`Idempotency-Key` makes a retry safe**: the second attempt gets 409 and is
  not billed. Without one, each call is distinct.
* One request at a time per account, enforced by the same `busy_at` lock the
  Telegram side uses, plus a per-key token bucket independent of money.

It binds to **loopback only** and is fronted by the host's existing Caddy —
`systemd/Caddyfile.snippet` — so it opens no port and needs no ufw change.

## Docker

`Dockerfile` builds one image used by all three processes; `systemd/docker/`
holds the unit variants. Verified on the target host: the image builds and the
watcher credits real chain history from inside a container, identically to the
native run.

Three things are load-bearing and must survive any edit:

1. **`/var/log/pcnaibot` is bind-mounted.** `check_holding` is file-based
   (`[ -r "$logf" ] || return 0`) and **the Docker log driver is not a file**.
   Without the mount, the one check that catches "alive and crediting nothing"
   returns 0 on every run.
2. **The config is a read-only bind mount, never `-e`.** `docker inspect` prints
   `Env` in full to anyone in the docker group, which is the leak the
   config-file design exists to avoid.
3. **The watcher gets its OWN container**, not `docker exec` into the bot. That
   is what gives it its own `--memory`; under `exec` they would share one cgroup
   and the two-process split would be cosmetic.

The API's port publish is `-p 127.0.0.1:8799:8799`. **Never a bare `-p`** —
Docker writes DNAT rules straight into iptables and they are evaluated *before*
ufw's chains, so a bare publish exposes the port to the internet while ufw still
reports it closed.

## What the provider will not tell you

Measured live on 2026-09-11 with a real key. Each of these is now a startup
check that **refuses**, not a warning:

| finding | consequence |
|---|---|
| `/v1/models` lists all 24 pool models, diff against the registry is **empty** — but all three Claude models refuse at call time as *"served by a subscription credential"* | the model list is **not** authoritative for reachability; `claude-sonnet-5` (which the build brief's D9 named) can never work |
| `qwen3.7-max` returned **9,085 output tokens against `max_tokens: 32`** — 284× — while reporting `stop_reason: "max_tokens"` | `max_tokens` does not bound every model, and it is the only thing bounding the reservation |
| `count_tokens` **works** despite the registry declaring `countTokens: false` | count the input instead of estimating it |
| …but it **under-counts**: `glm-5.3-flash` +5 tokens, `mimo-v2.5:free` +48 (77%) | the count is not a ceiling; `INPUT_SAFETY_TOKENS` adds flat headroom |
| there is **no cost field anywhere** — body or headers | we price the tokens ourselves; the premise holds |
| `mimo-v2.5:free` reports `cache_read_input_tokens: 192` unasked; every paid model reports 0 | the gateway does not cache on its own initiative for anything we bill |
| the authenticated rate limit is **600/60**, not the 300 measured unauthenticated | |
