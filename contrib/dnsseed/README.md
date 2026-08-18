# PCoin crawler-backed DNS seed

## The problem it solves

`seed.pc.am` is a **static** A/AAAA record naming our own four machines. A new
node asks it, gets our hosts, and connects. That works — right up until those
hosts are gone, and then nobody new can ever join. Adding more of our own boxes
to the record does not fix it, because they are all still ours.

This is the single largest dependency the project has on us. It is *not* a
mining dependency — an already-running miner keeps mining and keeps earning
with every one of our servers switched off, which has been measured, not
assumed. It is a **network-membership** dependency, and it only bites new
nodes.

A real DNS seed answers with **whoever is currently listening**. It crawls the
network, keeps the nodes that actually complete a handshake, and serves those.
We still operate the name; the *answers* come from the network. The day a third
party runs a reachable node, newcomers start being pointed at it without anyone
editing anything.

## It is a SECOND name, not a replacement

`seed.pc.am` keeps working exactly as it does today. This daemon serves a new
zone, added to `vSeeds` alongside it. If this daemon breaks, bootstrapping is
no worse than it is now. Only once it has run for a while unattended is it
worth considering pointing anything else at it.

## The `x9` problem, which is broken today

Core does not query the bare seed name. It queries
`x<hex-service-bits>.<seed>` — `src/net.cpp`:

```cpp
constexpr ServiceFlags requiredServiceBits{SeedsServiceFlags()};
std::string host = strprintf("x%x.%s", requiredServiceBits, seed);
```

and only falls back to the bare name — via a single slow `ADDR_FETCH`
connection — when that subdomain does not resolve:

```cpp
} else {
    // If the seed does not support a subdomain with our desired service bits,
    // we make an ADDR_FETCH connection ...
    AddAddrFetch(seed);
}
```

`x9.seed.pc.am` is **NXDOMAIN**, so every PCoin node in existence takes the
degraded path. This daemon answers the x-subdomains, filtered on the bits
actually requested. (The fallback still works, which is why nobody noticed.)

## Running it

```
/opt/pcoin-dnsseed/pcoin-dnsseed.mjs      the daemon (Node 18+, no dependencies)
/etc/pcoin-dnsseed.json                   config; every field below is overridable
/var/lib/pcoin-dnsseed/nodes.json         learned nodes, survives restarts
systemctl status pcoin-dnsseed
```

The systemd unit runs it as an unprivileged user with **one** capability,
`CAP_NET_BIND_SERVICE`, purely to bind :53 — verified as `CapEff=0000...0400`.

> **`SystemCallFilter` must allow `pkey_alloc pkey_free pkey_mprotect`.** V8
> allocates a memory protection key for its JIT's W^X, and `@system-service`
> does not include the `pkey_*` family, so node dies with SIGSYS on every start
> (audit: `syscall=330`). Allowing them costs nothing — protection keys
> restrict what a process may do to *its own* pages.

## DNS delegation

The zone must be delegated to this box. In Cloudflare, on `pc.am`:

| Type | Name | Content | Proxy |
|---|---|---|---|
| `A` | `ns1` | `152.53.171.190` | **DNS only** |
| `NS` | `dnsseed` | `ns1.pc.am` | n/a |

`ns1` **must not be proxied** — Cloudflare's proxy carries HTTP only, and this
is DNS on port 53.

Verify from anywhere:

```sh
dig @152.53.171.190 dnsseed.pc.am NS +short      # -> ns1.pc.am.
dig x9.dnsseed.pc.am A +short                    # -> live nodes, once delegated
```

## What it will not do

* **It is not a resolver.** It answers only for its own zone and returns
  `REFUSED` for everything else, so it cannot be used as an open resolver or a
  reflector. Verified: `dig @<host> google.com` → `status: REFUSED`.
* **It does not amplify.** Answers are a handful of A/AAAA records. A UDP reply
  over 512 bytes is truncated with `TC=1` rather than sent, so the asker
  retries over TCP — which an attacker spoofing a victim's address cannot do.
  Per-source rate limiting sits on top.
* **It does not repeat hearsay.** A node learned from a peer's `addr` message
  is a *candidate*, not an answer. It is served only after this daemon has
  itself completed a PCoin handshake with it, at least `minSuccesses` times,
  within `goodForMs`. Testing that claim rather than repeating it is the entire
  point of a DNS seed.

## Adding it to the node

Once delegation is verified, add to `src/kernel/chainparams.cpp` beside the
existing seed:

```cpp
vSeeds.emplace_back("dnsseed.pc.am.");
```

That ships in the next release. Old nodes keep using `seed.pc.am` and are
unaffected.

## Operational notes

* The configured `seeds` are **never** retired from the node store, however
  long they stay unreachable. They are the floor the crawler stands on; a bad
  week must not leave it with nothing to crawl from.
* `crawl` never overlaps itself, and the node store is capped, so a peer that
  floods `addr` messages cannot grow the heap without bound.
* Answers are shuffled per query. A seed that always replies in the same order
  concentrates the whole network onto whichever node happens to sort first.
