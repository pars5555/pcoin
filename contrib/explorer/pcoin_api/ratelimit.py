"""Token-bucket rate limiting, in memory, thread safe.

Two independent limiters are used by the server: a permissive one over every
read endpoint, and a strict one over ``POST /api/tx``. Broadcast is the only
state-changing endpoint in this API and the only one that costs the *network*
anything, so it gets its own bucket per client and a second global bucket that
caps the whole process.

Keying is on the peer address the socket actually reports. ``X-Forwarded-For``
is honoured only when the operator passes ``--trust-proxy``, because otherwise
any client can spoof that header and the per-client limit becomes decorative.

One deliberate hole, OFF unless the operator lists networks for it
(``--read-limit-exempt``): a caller on the explorer's own host that connects
straight to the socket -- not through the reverse proxy -- is not read-limited.
Every such caller shares the one key ``127.0.0.1``, so without this a single
local burst 429s every other local reader, payment rails included.

The decision is taken on the SOCKET PEER plus the ABSENCE of every forwarding
header, never on the rate-limit key. The key is the wrong input: with
``--trust-proxy`` it is read out of ``X-Forwarded-For``, a header the proxy
fills in from a request header of its own, so exempting by key would let a
public request that names 127.0.0.1 there walk past the limiter. The proxy
itself connects from loopback too, which is why the peer alone is not enough
either: Caddy always adds ``X-Forwarded-Proto``/``-Host`` (and on
explorer.pc.am ``X-Forwarded-For``), and Cloudflare adds ``CF-Connecting-IP``
and ``CDN-Loop``, so anything that came through them carries at least one of
``FORWARDING_HEADERS`` and is limited exactly as before.
"""

import ipaddress
import threading
import time
from collections import OrderedDict

# A request carrying ANY of these, even with an empty value, came through a
# proxy and is never a direct local caller.
FORWARDING_HEADERS = (
    "X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto", "Forwarded",
    "X-Real-IP", "CF-Connecting-IP", "True-Client-IP", "CDN-Loop", "Via",
)


def parse_networks(values):
    """``["127.0.0.0/8,::1/128", ...]`` -> a tuple of ``ip_network``.

    Raises ``ValueError`` on anything it cannot parse, on host bits set
    (``127.0.0.1/8``) and on a ``/0``. An exemption list is a security setting:
    a typo must stop the process at startup, not quietly exempt nothing -- or
    everything.
    """
    out = []
    for value in values or ():
        for part in str(value).replace(" ", ",").split(","):
            part = part.strip()
            if not part:
                continue
            net = ipaddress.ip_network(part, strict=True)
            if net.prefixlen == 0:
                raise ValueError("refusing to exempt all of %s" % net)
            out.append(net)
    return tuple(out)


def is_direct_local(peer, headers, networks):
    """True only for a request that came STRAIGHT from an exempt network.

    `peer` is the socket's peer address, `headers` the request's headers as a
    case-insensitive mapping (``http.server``'s ``self.headers``). No networks
    configured means False, always.
    """
    if not networks:
        return False
    for name in FORWARDING_HEADERS:
        if headers.get(name) is not None:
            return False
    try:
        ip = ipaddress.ip_address(str(peer).split("%", 1)[0])
    except ValueError:
        return False
    if ip.version == 6 and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return any(ip in net for net in networks)


class TokenBucket:
    __slots__ = ("capacity", "rate", "tokens", "updated")

    def __init__(self, rate, capacity, now):
        self.rate = float(rate)          # tokens per second
        self.capacity = float(capacity)  # burst
        self.tokens = float(capacity)
        self.updated = now

    def take(self, now, cost=1.0):
        """-> (allowed, retry_after_seconds)."""
        elapsed = now - self.updated
        if elapsed > 0:
            self.tokens = min(self.capacity, self.tokens + elapsed * self.rate)
            self.updated = now
        if self.tokens >= cost:
            self.tokens -= cost
            return True, 0.0
        if self.rate <= 0:
            return False, float("inf")
        return False, (cost - self.tokens) / self.rate


class RateLimiter:
    """Per-key token buckets with a bounded key set.

    The key table is bounded and evicts least-recently-used entries, so a flood
    of distinct source addresses cannot grow it without limit. Eviction is
    permissive by construction (an evicted client gets a fresh full bucket), which
    is the right failure direction for a public read API; the global bucket on
    broadcast is what holds the line when the per-key table is being churned.
    """

    def __init__(self, rate, burst, *, max_keys=8192, global_rate=None,
                 global_burst=None, clock=time.monotonic):
        self.rate = rate
        self.burst = burst
        self.max_keys = max_keys
        self._clock = clock
        self._lock = threading.Lock()
        self._buckets = OrderedDict()
        self._global = (TokenBucket(global_rate, global_burst, clock())
                        if global_rate is not None else None)

    def check(self, key, cost=1.0):
        """-> (allowed, retry_after_seconds, scope) where scope is 'client',
        'global' or None."""
        now = self._clock()
        with self._lock:
            bucket = self._buckets.get(key)
            if bucket is None:
                bucket = TokenBucket(self.rate, self.burst, now)
                self._buckets[key] = bucket
                while len(self._buckets) > self.max_keys:
                    self._buckets.popitem(last=False)
            else:
                self._buckets.move_to_end(key)

            # The global bucket is checked first but only *debited* once the
            # client bucket has also allowed the request, so a single throttled
            # client cannot drain the global allowance for everybody else.
            if self._global is not None:
                self._global.take(now, 0.0)      # refill without spending
                if self._global.tokens < cost:
                    wait = ((cost - self._global.tokens) / self._global.rate
                            if self._global.rate > 0 else float("inf"))
                    return False, wait, "global"

            ok, wait = bucket.take(now, cost)
            if not ok:
                return False, wait, "client"
            if self._global is not None:
                self._global.take(now, cost)
            return True, 0.0, None

    def tracked_keys(self):
        with self._lock:
            return len(self._buckets)
