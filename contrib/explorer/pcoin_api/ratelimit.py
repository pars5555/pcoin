"""Token-bucket rate limiting, in memory, thread safe.

Two independent limiters are used by the server: a permissive one over every
read endpoint, and a strict one over ``POST /api/tx``. Broadcast is the only
state-changing endpoint in this API and the only one that costs the *network*
anything, so it gets its own bucket per client and a second global bucket that
caps the whole process.

Keying is on the peer address the socket actually reports. ``X-Forwarded-For``
is honoured only when the operator passes ``--trust-proxy``, because otherwise
any client can spoof that header and the per-client limit becomes decorative.
"""

import threading
import time
from collections import OrderedDict


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
