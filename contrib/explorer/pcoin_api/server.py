"""The HTTP layer: routing, limits, headers, and one JSON error shape.

`http.server.ThreadingHTTPServer` from the standard library, for the same reason
the indexer is stdlib-only: this project already carries a C++ chain, a Kotlin
app and a C# tray app maintained by one person, and the thing it must not grow is
a fourth toolchain with its own package manager and its own patch treadmill.
`git clone && python3 -m pcoin_api serve` is the whole install.

That choice has a real limit and it is stated rather than hidden: this is a
thread-per-connection server suitable for a wallet backend and a block explorer
on a small chain, not for an unmetered public firehose. Put it behind nginx or
Cloudflare for TLS and for a second layer of rate limiting. The rate limiter here
is a backstop, not a substitute.
"""

import json
import socket
import threading
import time
import urllib.parse
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from pcoin_indexer.rpc import RpcError, RpcTransportError

from . import __version__
from .errors import ApiError
from .service import parse_int
from .store import IndexUnavailable

MAX_BODY_BYTES = 1_000_000        # a 400 000-byte transaction is 800 000 hex chars
DRAIN_LIMIT = 4 * 1024 * 1024     # how much of an oversized body we will discard
JSON_CONTENT_TYPE = "application/json; charset=utf-8"
MEMPOOL_PAGE = 100                # default txids/entries per /api/mempool page
MAX_MEMPOOL_PAGE = 1000
# One thread per connection with no ceiling is a denial of service that costs a
# client 200 open sockets. `_Handler.timeout` bounds how long a silent
# connection may hold a thread; this bounds how many may exist at once.
MAX_CONNECTIONS = 128


def dumps(obj):
    def default(o):
        if isinstance(o, Decimal):
            # Never a float: an amount that cannot round-trip through an IEEE
            # double must not be handed to a wallet as one.
            return str(o)
        if isinstance(o, set):
            return sorted(o)
        raise TypeError("cannot serialise %r" % (o,))
    return json.dumps(obj, default=default, separators=(",", ":"),
                      sort_keys=False).encode("utf-8")


class ApiApplication:
    """Routing and policy. Deliberately free of any HTTP object, so the whole
    surface is testable by calling `handle()` directly as well as over a socket."""

    def __init__(self, service, broadcaster, *, read_limiter=None,
                 broadcast_limiter=None, cors_origin="*", trust_proxy=False,
                 log=None, started_at=None):
        self.service = service
        self.broadcaster = broadcaster
        self.read_limiter = read_limiter
        self.broadcast_limiter = broadcast_limiter
        self.cors_origin = cors_origin
        self.trust_proxy = trust_proxy
        self.log = log or (lambda msg: None)
        self.started_at = started_at or time.time()

    # -- routing ---------------------------------------------------------
    def handle(self, method, path, query, body, client, *, already_limited=False):
        """-> (status, payload_dict). Raises nothing; every failure is a payload.

        The read limiter is checked **here**, not only in this package's own HTTP
        handler, because `handle()` is the mount point: `pcoin_explorer` serves
        the whole API by calling this method directly, and a limiter that only
        ran in `_Handler._serve` was silently absent in the documented
        `--with-api` deployment. `already_limited=True` is how this package's own
        handler says it has already spent the token -- it checks before reading
        a request body, so an oversized POST is refused without being read.
        """
        try:
            if not already_limited:
                self.check_read_limit(client)
            return self._route(method, path, query, body, client)
        except ApiError as exc:
            return exc.status, exc.payload()
        except IndexUnavailable as exc:
            return 503, {"error": {"code": "index_unavailable",
                                   "message": str(exc)}}
        except (RpcTransportError, RpcError) as exc:
            # The node did not answer, or answered with an error we did not
            # anticipate. Either way this is not a fact about the chain.
            return 502, {"error": {"code": "node_unreachable", "message": str(exc),
                                   "detail": "This is a failure to obtain an "
                                             "answer, not an answer."}}
        except Exception as exc:                             # pragma: no cover
            self.log("unhandled error on %s %s: %r" % (method, path, exc))
            return 500, {"error": {"code": "internal_error",
                                   "message": "%s: %s" % (type(exc).__name__, exc)}}

    def _route(self, method, path, query, body, client):
        segments = [urllib.parse.unquote(s) for s in path.strip("/").split("/") if s]

        if not segments or segments == ["api"]:
            if method not in ("GET", "HEAD"):
                raise ApiError(405, "method_not_allowed", "use GET")
            return 200, self.discovery()

        if segments[0] != "api":
            raise ApiError(404, "not_found", "unknown path %r" % path)

        rest = segments[1:]
        svc = self.service

        # -- the one state-changing route ---------------------------------
        if rest == ["tx"] and method == "POST":
            self._limit(self.broadcast_limiter, client, "broadcast")
            return self._broadcast(body, query)

        # -- the one read that takes a body -------------------------------
        # A gap-limit scan is 20-200 addresses; that does not fit reliably in a
        # URL, so the multi-address query accepts a POST body. It is still a
        # read: it opens the same `mode=ro` connection as every GET.
        if rest == ["addresses"] and method == "POST":
            payload = self._json_body(body)
            addresses = payload.get("addresses")
            if addresses is None:
                raise ApiError(400, "bad_request",
                               'body must be {"addresses": ["pc1...", ...]}')
            merged = dict(query)
            if "history" in payload:
                merged["history"] = payload["history"]
            return 200, svc.addresses(addresses, merged)

        if method not in ("GET", "HEAD"):
            raise ApiError(405, "method_not_allowed",
                           "%s is not allowed on %s" % (method, path))

        if rest == ["status"]:
            return 200, svc.status(broadcast_state=self.broadcaster.state(),
                                   server=self.server_block())
        if rest == ["tip"]:
            return 200, svc.tip()
        if rest == ["fees"]:
            return 200, svc.fees()
        if rest == ["mempool"]:
            return 200, self.mempool(query)
        if rest == ["search"]:
            return 200, svc.search(query.get("q"))
        if rest == ["blocks"]:
            return 200, svc.blocks(query)
        if rest == ["addresses", "top"]:
            return 200, svc.rich_list(query)
        if rest == ["addresses"]:
            listed = query.get("list") or query.get("addresses")
            if not listed:
                raise ApiError(400, "bad_request",
                               "GET /api/addresses needs ?list=addr1,addr2 -- or "
                               "POST a JSON body {\"addresses\": [...]}, which has "
                               "no URL length limit")
            names = [a for a in str(listed).replace(" ", ",").split(",") if a]
            return 200, svc.addresses(names, query)
        if len(rest) == 2 and rest[0] == "tx":
            return 200, svc.transaction(rest[1], query)
        if len(rest) == 2 and rest[0] == "block":
            return 200, svc.block(rest[1], query)
        if len(rest) == 3 and rest[0] == "block" and rest[2] == "txs":
            return 200, svc.block_txs(rest[1], query)
        if len(rest) == 2 and rest[0] == "address":
            return 200, svc.address(rest[1], query)
        if len(rest) == 3 and rest[0] == "address" and rest[2] == "txs":
            return 200, svc.address_history(rest[1], query)
        if len(rest) == 3 and rest[0] == "address" and rest[2] == "utxos":
            return 200, svc.address_utxos(rest[1], query)

        raise ApiError(404, "not_found", "unknown path %r" % path)

    # -- POST bodies -----------------------------------------------------
    def _json_body(self, body):
        if not body:
            raise ApiError(400, "bad_request", "empty request body")
        try:
            payload = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as exc:
            raise ApiError(400, "bad_request", "body is not valid JSON: %s" % exc)
        if not isinstance(payload, dict):
            raise ApiError(400, "bad_request", "body must be a JSON object")
        return payload

    def _broadcast(self, body, query):
        hexstr = None
        if body:
            text = body.decode("utf-8", "replace").strip()
            if text.startswith("{"):
                payload = self._json_body(body)
                hexstr = payload.get("hex") or payload.get("rawtx")
                if hexstr is None:
                    raise ApiError(400, "bad_request",
                                   'body must be {"hex": "<signed transaction>"}')
                for forbidden in ("mnemonic", "seed", "privkey", "private_key",
                                  "wif", "xprv"):
                    if forbidden in payload:
                        raise ApiError(
                            400, "refused",
                            "this API is non-custodial and never accepts key "
                            "material; remove %r from the request body. Sign the "
                            "transaction on your own device and send only the "
                            "signed hex." % forbidden)
            else:
                hexstr = text
        if not hexstr:
            raise ApiError(400, "bad_request",
                           'POST a body of {"hex": "<signed transaction hex>"}')
        wait = query.get("wait")
        wait_seconds = None
        if wait not in (None, ""):
            try:
                wait_seconds = max(0.0, min(30.0, float(wait)))
            except (TypeError, ValueError):
                raise ApiError(400, "bad_request", "wait must be a number of seconds")
        return self.broadcaster.broadcast(hexstr, wait_seconds=wait_seconds)

    # -- helpers ---------------------------------------------------------
    def _limit(self, limiter, client, scope):
        if limiter is None:
            return
        ok, retry_after, which = limiter.check(client)
        if not ok:
            finite = retry_after if retry_after != float("inf") else None
            raise ApiError(
                429, "rate_limited",
                "too many %s requests; %s"
                % (scope, "this limit does not refill"
                   if finite is None else "retry in %.1fs" % finite),
                retry_after_seconds=None if finite is None else round(finite, 1),
                limit_scope=which)

    def check_read_limit(self, client):
        self._limit(self.read_limiter, client, "read")

    def server_block(self):
        return {"api_version": __version__,
                "uptime_seconds": round(time.time() - self.started_at, 1),
                "custodial": False,
                "note": "This API never derives an address, holds a key or signs "
                        "anything. Clients derive their own addresses from their "
                        "own twelve words (BIP84, m/84'/9444'/0'/0/i)."}

    def mempool(self, query=None):
        """The mempool, **paged**.

        Core's `-maxmempool` default is 300 MB and PCoin has no fee market, so
        the mempool is attacker-sizeable. Returning `txids` and `entries` for all
        of it turned one anonymous GET into megabytes of JSON; the page is capped
        here and the ingestion side is capped in `nodeview` (see
        `NodeView.max_mempool_txs`). `mempool.tx_count` is always the node's own
        total, so a truncated page never reads as a smaller mempool.
        """
        query = query or {}
        limit = parse_int(query, "limit", MEMPOOL_PAGE, minimum=0,
                          maximum=MAX_MEMPOOL_PAGE)
        offset = parse_int(query, "offset", 0, minimum=0, maximum=10_000_000)
        snap = self.service.node.snapshot()
        mem = snap.get("mempool") or {}
        with self.service.store.snapshot() as conn:
            out = self.service._envelope(conn, snap)
        out["mempool"] = self.service._mempool_block(snap)
        if mem.get("known"):
            txids = mem.get("txids") or []
            entries = mem.get("entries") or {}
            page = txids[offset:offset + limit]
            out["mempool"]["txids"] = page
            out["mempool"]["entries"] = {t: entries[t] for t in page
                                         if t in entries}
            out["mempool"]["limit"] = limit
            out["mempool"]["offset"] = offset
            out["mempool"]["has_more"] = offset + len(page) < len(txids)
        return out

    def discovery(self):
        return {
            "name": "PCoin block explorer API",
            "api_version": __version__,
            "custodial": False,
            "endpoints": {
                "GET /api/status": "chain tip, index height, how far behind the "
                                   "index is, node and mempool state",
                "GET /api/tip": "just the tip block",
                "GET /api/blocks?limit=&before_height=": "recent blocks",
                "GET /api/block/{height|hash}?limit=&offset=": "one block",
                "GET /api/block/{height|hash}/txs?limit=&offset=":
                    "full transactions in a block",
                "GET /api/tx/{txid}": "one transaction in full detail",
                "POST /api/tx": 'broadcast a signed transaction: {"hex": "..."}',
                "GET /api/address/{address}?history=": "balances and a short history",
                "GET /api/address/{address}/txs?limit=&offset=&cursor=":
                    "paginated history",
                "GET /api/address/{address}/utxos?include_immature=&"
                "include_pending_spend=&include_unconfirmed=&require_mempool=":
                    "spendable outputs",
                "GET /api/addresses?list=a,b,c":
                    "many addresses in one request. PRIVACY: every address in "
                    "one request is linked to every other by whoever runs this "
                    "server. Prefer the POST form (no query string to end up in "
                    "a proxy log), one address per request, or your own instance",
                "POST /api/addresses": 'many addresses: {"addresses": [...]}',
                "GET /api/addresses/top?limit=&offset=": "richest addresses",
                "GET /api/fees": "the relay fee floor and what to actually pay",
                "GET /api/mempool?limit=&offset=":
                    "unconfirmed transactions the node can see (paged)",
                "GET /api/search?q=": "address, txid, block hash or height",
            },
            "documentation": "contrib/explorer/pcoin_api/API.md",
        }


class _Handler(BaseHTTPRequestHandler):
    server_version = "pcoin-explorer-api/" + __version__
    sys_version = ""                 # do not advertise the Python version
    protocol_version = "HTTP/1.1"
    timeout = 30

    # -- plumbing --------------------------------------------------------
    @property
    def app(self):
        return self.server.app

    def log_message(self, fmt, *args):       # noqa: A003 - base class name
        self.app.log("%s %s" % (self.client_address[0], fmt % args))

    def log_request(self, code="-", size="-"):
        """Log the path, never the query string.

        `BaseHTTPRequestHandler.log_request` logs `self.requestline` verbatim.
        `GET /api/addresses?list=pc1q...,pc1q...,pc1q...` is a gap-limit scan of
        one wallet, so logging it verbatim writes that wallet's entire address
        linkage to disk on every request. The path identifies the endpoint,
        which is all an access log needs.
        """
        path = self.path.split("?", 1)[0]
        if len(self.path) > len(path):
            path += "?<redacted>"
        self.log_message('"%s %s %s" %s %s', self.command, path[:200],
                         self.request_version, str(code), str(size))

    def client_key(self):
        peer = self.client_address[0]
        if not self.app.trust_proxy:
            return peer
        forwarded = self.headers.get("X-Forwarded-For")
        if not forwarded:
            return peer
        # The rightmost entry is the one the trusted proxy appended; entries to
        # its left are whatever the client claimed and must never be trusted.
        parts = [p.strip() for p in forwarded.split(",") if p.strip()]
        return parts[len(parts) - 1] if parts else peer

    def _headers(self, status, body_len, extra=None):
        self.send_response(status)
        self.send_header("Content-Type", JSON_CONTENT_TYPE)
        self.send_header("Content-Length", str(body_len))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        if self.app.cors_origin:
            self.send_header("Access-Control-Allow-Origin", self.app.cors_origin)
            self.send_header("Vary", "Origin")
        for key, value in (extra or {}).items():
            self.send_header(key, str(value))
        self.end_headers()

    def _respond(self, status, payload, *, head=False):
        body = dumps(payload)
        extra = {}
        if status == 429:
            retry = ((payload.get("error") or {}).get("retry_after_seconds"))
            extra["Retry-After"] = str(int(retry or 1) + 1)
        if status in (411, 413):
            # We refused before draining the request body, so there are unread
            # bytes on the socket. Keeping the connection alive would misparse
            # them as the next request.
            self.close_connection = True
            extra["Connection"] = "close"
        self._headers(status, len(body), extra)
        if not head:
            self.wfile.write(body)

    def _read_body(self):
        if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
            raise ApiError(411, "length_required",
                           "chunked request bodies are not accepted; send "
                           "Content-Length")
        raw_len = self.headers.get("Content-Length")
        if raw_len is None:
            raise ApiError(411, "length_required", "Content-Length is required")
        try:
            length = int(raw_len)
        except ValueError:
            raise ApiError(400, "bad_request", "Content-Length is not an integer")
        if length < 0:
            raise ApiError(400, "bad_request", "negative Content-Length")
        if length > MAX_BODY_BYTES:
            # Discard a bounded amount so the 413 can actually be delivered --
            # answering and closing mid-upload shows the client a connection
            # reset instead of the reason. Beyond the drain limit the connection
            # is simply dropped; a 100 MB upload does not get to bill us for it.
            remaining = min(length, DRAIN_LIMIT)
            while remaining > 0:
                chunk = self.rfile.read(min(65536, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
            raise ApiError(413, "payload_too_large",
                           "request body is %d bytes, the limit is %d"
                           % (length, MAX_BODY_BYTES))
        return self.rfile.read(length) if length else b""

    # -- verbs -----------------------------------------------------------
    def do_OPTIONS(self):                                    # noqa: N802
        self._headers(204, 0, {
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Max-Age": "600"})

    def do_GET(self, head=False):                            # noqa: N802
        self._serve("HEAD" if head else "GET", head=head)

    def do_HEAD(self):                                       # noqa: N802
        self.do_GET(head=True)

    def do_POST(self):                                       # noqa: N802
        self._serve("POST")

    def _serve(self, method, head=False):
        parsed = urllib.parse.urlparse(self.path)
        query = {k: v[len(v) - 1] for k, v in
                 urllib.parse.parse_qs(parsed.query, keep_blank_values=True).items()}
        client = self.client_key()
        try:
            self.app.check_read_limit(client)
            body = self._read_body() if method == "POST" else b""
        except ApiError as exc:
            self._respond(exc.status, exc.payload(), head=head)
            return
        except (socket.timeout, OSError):                    # pragma: no cover
            return

        status, payload = self.app.handle(
            "GET" if head else method, parsed.path, query, body, client,
            already_limited=True)
        self._respond(status, payload, head=head)


class BoundedThreadingHTTPServer(ThreadingHTTPServer):
    """`ThreadingHTTPServer` with a ceiling on concurrent connections.

    The stock class spawns one unbounded daemon thread per accepted connection.
    A client that opens sockets and sends nothing therefore pins one thread each
    for as long as it likes -- 200 sockets, 200 threads. The handler's `timeout`
    bounds how *long* a silent connection holds its thread; this bounds how
    *many* exist, and answers the rest with 503 immediately rather than queueing
    them behind an accept backlog that hides the problem.
    """

    daemon_threads = True
    allow_reuse_address = True
    max_connections = MAX_CONNECTIONS
    over_capacity_response = (
        b"HTTP/1.1 503 Service Unavailable\r\n"
        b"Content-Type: text/plain; charset=utf-8\r\n"
        b"Content-Length: 43\r\nRetry-After: 1\r\nConnection: close\r\n\r\n"
        b"too many concurrent connections; retry\n")

    def __init__(self, *args, **kwargs):
        # Created before super().__init__, which may start accepting.
        self._slots = threading.BoundedSemaphore(self.max_connections)
        super().__init__(*args, **kwargs)

    def process_request(self, request, client_address):
        if not self._slots.acquire(blocking=False):
            try:
                request.sendall(self.over_capacity_response)
            except OSError:
                pass
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            # The worker thread never started, so it will never release.
            self._slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._slots.release()


class ApiServer(BoundedThreadingHTTPServer):
    def __init__(self, address, app):
        self.app = app
        super().__init__(address, _Handler)


def serve_forever(app, host="127.0.0.1", port=8080):
    server = ApiServer((host, port), app)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread
