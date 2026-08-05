"""The HTTP server: routing, one SQLite snapshot per request, and the API and
the web UI in one process.

Deliberate properties:

* **The index file is the only input.** It is opened read-only (or, where a WAL
  shared-memory file cannot be created from a read-only handle, with
  ``PRAGMA query_only=ON``). There are no node credentials in this process and
  no code path that writes anything, so no request can affect the chain, the
  node, or the index.

* **One consistent snapshot per request.** Each request runs inside a single
  deferred read transaction. Without it, a page that reads the tip, then the
  balances, then the confirmations could straddle a writer's commit and render
  a mixture of two chain states. On a chain that reorganises as often as this
  one does, that is not a theoretical concern.

* **Nothing is cached that contains money.** HTML and JSON responses are
  ``no-store``; only the stylesheet is cacheable. A balance served from a
  proxy cache after a reorg is exactly the wrong answer.

* **It binds to localhost by default.** ``http.server`` is not a hardened
  edge server. Put a reverse proxy in front of it for anything public, and
  never on the seed host (``seed.pc.am`` is PCoin's only DNS seed and
  ``vFixedSeeds`` is empty, so loading that box off the network stops anyone
  new from bootstrapping the chain).
"""

import json
import sqlite3
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

from pcoin_indexer import db

from . import api, search, views
from .theme import CSS
from .views import Ctx

MAX_PATH = 512
MAX_QUERY = 1024
MAX_BODY = 1_000_000        # only reachable when an API application is mounted
# A connection that sends a request line and then nothing must not own a thread
# for ever, and there must not be an unbounded number of them. Neither limit is
# optional: this one process serves every page and, with --with-api, the whole
# API, so one visitor with 200 idle sockets is a total outage.
REQUEST_TIMEOUT = 30
MAX_CONNECTIONS = 128
ADDRESS_CHARS = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")

SECURITY_HEADERS = (
    # No scripts anywhere on any page, so the policy can say exactly that.
    ("Content-Security-Policy",
     "default-src 'none'; style-src 'self'; img-src 'self' data:; "
     "form-action 'self'; base-uri 'none'; frame-ancestors 'none'"),
    ("X-Content-Type-Options", "nosniff"),
    ("Referrer-Policy", "same-origin"),
    ("X-Frame-Options", "DENY"),
    ("Cross-Origin-Resource-Policy", "same-origin"),
)


class IndexUnavailable(RuntimeError):
    """The index file could not be read. Never rendered as 'nothing found'."""


class Store:
    """One read-only SQLite connection per serving thread."""

    def __init__(self, path):
        self.path = path
        self._local = threading.local()
        self.mode = None

    def _open(self):
        try:
            conn = db.connect(self.path, readonly=True)
            conn.execute("SELECT schema_version FROM sync_state WHERE id=1").fetchone()
            self.mode = "read-only"
            return conn
        except sqlite3.OperationalError:
            # A WAL database needs a -shm file, and SQLite cannot create one
            # from a mode=ro handle. If no writer currently holds the database
            # open there is nothing to attach to, and the read-only URI fails.
            # A normal handle with query_only=ON is the same guarantee -- any
            # attempt to write raises -- without needing to create shm from a
            # read-only connection.
            conn = db.connect(self.path)
            conn.execute("PRAGMA query_only=ON")
            conn.execute("SELECT schema_version FROM sync_state WHERE id=1").fetchone()
            self.mode = "query_only"
            return conn

    def connection(self):
        conn = getattr(self._local, "conn", None)
        if conn is None:
            try:
                conn = self._open()
            except sqlite3.Error as exc:
                raise IndexUnavailable(str(exc)) from exc
            self._local.conn = conn
        return conn

    def close(self):
        conn = getattr(self._local, "conn", None)
        if conn is not None:
            conn.close()
            self._local.conn = None


class Router:
    """Path -> handler. Kept separate from the HTTP plumbing so the whole site
    is testable without opening a socket.

    `api_app` is the composition hook. Given any object with

        handle(method, path, query_dict, body_bytes, client) -> (status, payload)

    every request under ``/api`` is delegated to it and the pages are served
    around it, so the UI and a richer API (mempool, multi-address scan, signed
    transaction relay) are literally one process on one port rather than two
    services a reverse proxy has to stitch together. ``pcoin_api.ApiApplication``
    has exactly that signature. With no `api_app`, the small read-only API in
    ``pcoin_explorer.api`` is served instead, so the UI stands alone.
    """

    def __init__(self, store, *, chain_override=None, api_app=None):
        self.store = store
        self.chain_override = chain_override
        self.api_app = api_app

    # -- helpers ----------------------------------------------------------
    @staticmethod
    def _one(params, key, default=None):
        v = params.get(key)
        return v[0] if v else default

    @staticmethod
    def _flag(params, key):
        v = params.get(key)
        if not v:
            return False
        return v[0] not in ("0", "false", "no", "")

    @staticmethod
    def _valid_id(text):
        return bool(text) and len(text) <= 128 and all(c in ADDRESS_CHARS for c in text)

    @staticmethod
    def _valid_block_ident(text):
        """A block is addressed by height or by hash. A height larger than a
        SQLite integer would raise OverflowError on binding, so it is rejected
        here rather than becoming a 500."""
        if not Router._valid_id(text):
            return False
        if all(c in "0123456789" for c in text):
            return int(text) <= search.MAX_HEIGHT
        return True

    def handle(self, path, query_string, *, method="GET", body=b"", client=""):
        """-> (status, content_type, body_bytes, extra_headers)"""
        if len(path) > MAX_PATH or len(query_string) > MAX_QUERY:
            return self._plain(414, "request-target too long")
        try:
            path = unquote(path)
        except Exception:
            return self._plain(400, "undecodable path")
        params = parse_qs(query_string, keep_blank_values=True)

        if self.api_app is not None and (path == "/api" or path.startswith("/api/")):
            return self._delegate(method, path, params, body, client)
        if method not in ("GET", "HEAD"):
            return self._plain(405, "only GET and HEAD are served here")

        if path == "/static/style.css":
            return (200, "text/css; charset=utf-8", CSS.encode("utf-8"),
                    (("Cache-Control", "public, max-age=86400"),
                     ("ETag", '"%s"' % _css_etag())))
        if path == "/robots.txt":
            # Explorers get crawled hard and every page is a database query.
            return (200, "text/plain; charset=utf-8",
                    b"User-agent: *\nDisallow: /api/\nCrawl-delay: 10\n", ())

        try:
            conn = self.store.connection()
        except IndexUnavailable as exc:
            return self._unavailable(path, str(exc))

        conn.execute("BEGIN")
        try:
            return self._route(conn, path, params)
        finally:
            try:
                conn.execute("ROLLBACK")
            except sqlite3.Error:
                self.store.close()

    def _route(self, conn, path, params):
        ctx = Ctx(conn, path=path,
                  query={k: v[0] for k, v in params.items()})
        if self.chain_override:
            ctx.chain = self.chain_override
        segs = [s for s in path.split("/") if s]

        # `segs[0]`, not `path.startswith("/api")`: the latter also matches
        # /apiary and would answer it with the API index.
        if segs and segs[0] == "api":
            return self._api(ctx, segs[1:], params)

        page = api.clamp_page(self._one(params, "page"))

        if not segs:
            return self._html(200, views.home(ctx))
        head = segs[0]

        if head == "search" and len(segs) == 1:
            return self._search(ctx, self._one(params, "q", ""))

        if head == "blocks" and len(segs) == 1:
            return self._html(200, views.blocks_list(ctx, page))

        if head == "block" and len(segs) == 2:
            ident = segs[1]
            if not self._valid_block_ident(ident):
                return self._html(400, views.error_page(
                    ctx, 400, "Not a block identifier",
                    "A block is addressed by height or by its 64-character hash."))
            body = views.block_page(ctx, ident.lower() if len(ident) == 64 else ident,
                                    page=page)
            if body is None:
                return self._html(404, views.error_page(
                    ctx, 404, "No such block",
                    "The index holds heights 0..%d and no block with that hash."
                    % ctx.tip))
            return self._html(200, body)

        if head == "txs" and len(segs) == 1:
            coinbase = False if self._flag(params, "payments") else None
            return self._html(200, views.txs_list(ctx, page, coinbase))

        if head == "tx" and len(segs) == 2:
            txid = segs[1].lower()
            if not self._valid_id(txid):
                return self._html(400, views.error_page(
                    ctx, 400, "Not a transaction id",
                    "A transaction id is 64 hexadecimal characters."))
            body = views.tx_page(ctx, txid)
            if body is None:
                return self._html(404, views.error_page(
                    ctx, 404, "No such transaction",
                    "No transaction with that id is in the index."
                    + (" The index is behind the node, so it may simply not have"
                       " been reached yet." if ctx.health.get("stale") else "")))
            return self._html(200, body)

        if head == "address" and len(segs) == 2:
            addr_text = segs[1]
            if not self._valid_id(addr_text):
                return self._html(400, views.error_page(
                    ctx, 400, "Not an address",
                    "PCoin addresses are alphanumeric."))
            result = search.route(conn, addr_text, chain=ctx.chain)
            if result["kind"] != "address":
                # Not a valid address on this chain: say which mistake it is
                # rather than rendering a zero balance for a typo.
                return self._search(ctx, addr_text)
            view = "utxos" if self._one(params, "view") == "utxos" else "txs"
            return self._html(200, views.address_page(
                ctx, result["address"], view=view, page=page))

        if head == "addresses" and len(segs) == 1:
            return self._html(200, views.addresses_list(
                ctx, page, self._flag(params, "all")))

        if head == "reorgs" and len(segs) == 1:
            return self._html(200, views.reorgs_page(ctx, page))

        if head == "about" and len(segs) == 1:
            return self._html(200, views.about_page(ctx))

        if head == "healthz" and len(segs) == 1:
            h = ctx.health
            return self._json(200 if not h["stale"] else 503, h)

        return self._html(404, views.error_page(
            ctx, 404, "No such page", "Nothing is served at %s." % path))

    def _delegate(self, method, path, params, body, client):
        """Hand an /api request to the mounted API application.

        The query is flattened the way that application flattens it -- last
        value wins for a repeated key -- so a request means the same thing
        whichever of the two servers receives it.
        """
        query = {k: v[len(v) - 1] for k, v in params.items()}
        cors = getattr(self.api_app, "cors_origin", "*")
        try:
            status, payload = self.api_app.handle(method, path, query, body, client)
        except Exception as exc:                        # noqa: BLE001
            traceback.print_exc(file=sys.stderr)
            # The mounted API failed to produce an answer. That is a failure to
            # obtain an answer, never an answer (CLAUDE.md 7.1) -- so it is a
            # 502 with the reason, not an empty result.
            return self._json(502, {"error": {
                "code": "api_failed",
                "message": "the mounted API raised %s" % type(exc).__name__,
                "detail": str(exc)}}, cors)
        return self._json(status, payload, cors)

    def _search(self, ctx, q):
        result = search.route(ctx.conn, q, chain=ctx.chain)
        if result.get("target"):
            # 302, not 303: the search itself was a GET, and a redirect keeps
            # the canonical URL in the address bar so it can be shared.
            return (302, "text/html; charset=utf-8", b"",
                    (("Location", result["target"]),))
        status, html = views.search_result_page(ctx, result)
        return self._html(status if status != 300 else 200, html)

    def _api(self, ctx, segs, params):
        page = api.clamp_page(self._one(params, "page"))
        per = api.clamp_per_page(self._one(params, "limit"), 25)
        if not segs:
            return self._html(200, views.api_page(ctx))
        head = segs[0]
        try:
            if head == "status" and len(segs) == 1:
                return self._json(*api.status(ctx))
            if head == "chain" and len(segs) == 1:
                return self._json(*api.chain(ctx))
            if head == "blocks" and len(segs) == 1:
                return self._json(*api.blocks(ctx, page, per))
            if head == "block" and len(segs) == 2:
                if not self._valid_block_ident(segs[1]):
                    return self._json(400, {"error": "not a block identifier"})
                return self._json(*api.block(ctx, segs[1]))
            if head == "txs" and len(segs) == 1:
                coinbase = False if self._flag(params, "payments") else None
                return self._json(*api.txs(ctx, page, per, coinbase))
            if head == "tx" and len(segs) == 2:
                if not self._valid_id(segs[1]):
                    return self._json(400, {"error": "not a transaction id"})
                return self._json(*api.tx(ctx, segs[1].lower()))
            if head == "address" and len(segs) in (2, 3):
                if not self._valid_id(segs[1]):
                    return self._json(400, {"error": "not an address"})
                if len(segs) == 2:
                    return self._json(*api.address(ctx, segs[1]))
                if segs[2] == "history":
                    return self._json(*api.address_history(ctx, segs[1], page, per))
                if segs[2] == "utxos":
                    return self._json(*api.address_utxos(
                        ctx, segs[1], page, per, self._flag(params, "mature_only")))
            if head == "addresses" and len(segs) == 1:
                return self._json(*api.addresses(ctx, page, per,
                                                 self._flag(params, "all")))
            if head == "reorgs" and len(segs) == 1:
                return self._json(*api.reorgs(ctx, page, per))
            if head == "search" and len(segs) == 1:
                return self._json(*api.search_api(ctx, self._one(params, "q", "")))
        except sqlite3.Error as exc:
            return self._json(503, {"error": "index unavailable: %s" % exc})
        return self._json(404, {"error": "no such endpoint",
                                "see": "/api"})

    # -- response shapes --------------------------------------------------
    @staticmethod
    def _html(status, body):
        return (status, "text/html; charset=utf-8", body.encode("utf-8"),
                (("Cache-Control", "no-store"),))

    @staticmethod
    def _json(status, obj, cors="*"):
        body = json.dumps(obj, indent=2, default=api.json_default,
                          sort_keys=False).encode("utf-8")
        extra = [("Cache-Control", "no-store")]
        if cors:
            extra += [("Access-Control-Allow-Origin", cors), ("Vary", "Origin")]
        return (status, "application/json; charset=utf-8", body, tuple(extra))

    @staticmethod
    def _plain(status, text):
        return (status, "text/plain; charset=utf-8", text.encode("utf-8"),
                (("Cache-Control", "no-store"),))

    def _unavailable(self, path, detail):
        """The index could not be opened. This is 'we do not know', and it must
        never be rendered as an empty chain (CLAUDE.md 7.1)."""
        if path == "/api" or path.startswith("/api/"):
            return self._json(503, {"error": "the index is unavailable",
                                    "detail": detail})
        body = ("<!doctype html><meta charset=utf-8>"
                "<title>Index unavailable</title>"
                "<link rel=stylesheet href=/static/style.css>"
                "<div class=wrap><h1>The index is unavailable</h1>"
                "<div class='banner banner-err'>This explorer could not open its "
                "index database, so it cannot answer anything. It is deliberately "
                "showing nothing rather than an empty chain.</div>"
                "<pre>%s</pre></div>" % _escape(detail))
        return (503, "text/html; charset=utf-8", body.encode("utf-8"),
                (("Cache-Control", "no-store"),))


def _escape(text):
    from .fmt import esc
    return esc(text)


_CSS_ETAG = None


def _css_etag():
    global _CSS_ETAG
    if _CSS_ETAG is None:
        import hashlib
        _CSS_ETAG = hashlib.sha256(CSS.encode("utf-8")).hexdigest()[:16]
    return _CSS_ETAG


class Handler(BaseHTTPRequestHandler):
    server_version = "pcoin-explorer"
    sys_version = ""              # do not advertise the Python version
    protocol_version = "HTTP/1.1"
    # `StreamRequestHandler.timeout` is None by default, which means a
    # connection that never sends a complete request line holds its thread until
    # the client closes it. 30 s, matching pcoin_api's handler.
    timeout = REQUEST_TIMEOUT

    router = None
    access_log = True

    def version_string(self):
        return self.server_version          # never the Python version

    def _client_key(self):
        """The identity the mounted API's rate limiters bucket on.

        The peer address is the only honest answer unless a proxy we control
        appends `X-Forwarded-For` -- which is exactly what that application's
        `--trust-proxy` asserts. Passing the peer address unconditionally put
        every client behind the reverse proxy the docs recommend into one bucket
        keyed on 127.0.0.1, so one client's broadcasts denied everybody else's.
        """
        peer = self.client_address[0]
        if not getattr(self.router, "api_app", None):
            return peer
        if not getattr(self.router.api_app, "trust_proxy", False):
            return peer
        forwarded = self.headers.get("X-Forwarded-For")
        if not forwarded:
            return peer
        # The rightmost entry is the one the trusted proxy appended; entries to
        # its left are whatever the client claimed and must never be trusted.
        parts = [p.strip() for p in forwarded.split(",") if p.strip()]
        return parts[len(parts) - 1] if parts else peer

    def _serve(self, *, body=True, request_body=b""):
        started = time.monotonic()
        parts = urlsplit(self.path)
        try:
            status, ctype, payload, extra = self.router.handle(
                parts.path, parts.query, method=self.command,
                body=request_body, client=self._client_key())
        except Exception:                       # noqa: BLE001 - last line of defence
            traceback.print_exc(file=sys.stderr)
            status, ctype, payload, extra = (
                500, "text/plain; charset=utf-8",
                b"internal error; see the server log\n",
                (("Cache-Control", "no-store"),))
        headers = dict(extra)
        etag = headers.get("ETag")
        if (status == 200 and etag
                and etag in [t.strip() for t in
                             (self.headers.get("If-None-Match") or "").split(",")]):
            status, payload, body = 304, b"", False
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(payload)))
        for k, v in SECURITY_HEADERS:
            self.send_header(k, v)
        for k, v in extra:
            self.send_header(k, v)
        self.end_headers()
        if body and payload:
            self.wfile.write(payload)
        if self.access_log:
            # The path, never the query string. `/api/addresses?list=pc1q...`
            # is a gap-limit scan of one wallet, and logging it verbatim writes
            # that wallet's whole address linkage to disk on every request.
            target = parts.path[:200]
            if parts.query:
                target += "?<redacted>"
            sys.stderr.write("%s %s %s %s %d %.1fms\n" % (
                time.strftime("%H:%M:%S"), self.command, target, status,
                len(payload), (time.monotonic() - started) * 1000))

    def do_GET(self):
        self._serve()

    def do_HEAD(self):
        self._serve(body=False)

    def _with_body(self):
        """A request that carries a body is only accepted when an API
        application is mounted; the UI itself has no write surface at all.

        The rules here mirror the mounted API's own: no chunked bodies (there is
        no way to answer before draining one), Content-Length required, and a
        hard cap. If we refuse without draining, the unread bytes would be
        misparsed as the next request on a keep-alive connection, so the
        connection is closed in that case.
        """
        if getattr(self.router, "api_app", None) is None:
            return self._reject()
        if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
            self.close_connection = True
            return self._short(411, "send Content-Length; chunked is not accepted")
        raw_len = self.headers.get("Content-Length")
        if raw_len is None:
            self.close_connection = True
            return self._short(411, "Content-Length is required")
        try:
            length = int(raw_len)
        except ValueError:
            self.close_connection = True
            return self._short(400, "bad Content-Length")
        if length < 0 or length > MAX_BODY:
            self.close_connection = True
            return self._short(413, "request body over %d bytes" % MAX_BODY)
        body = self.rfile.read(length) if length else b""
        self._serve(request_body=body)

    do_POST = do_PUT = do_DELETE = do_PATCH = _with_body

    def _short(self, status, text):
        payload = (text + "\n").encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Connection", "close")
        for k, v in SECURITY_HEADERS:
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(payload)

    def _reject(self):
        payload = (b"only GET and HEAD are served; this explorer has no write "
                   b"surface\n")
        self.send_response(405)
        self.send_header("Allow", "GET, HEAD")
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Connection", "close")
        for k, v in SECURITY_HEADERS:
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(payload)
        self.close_connection = True

    def log_message(self, fmt, *args):      # the default logger writes to stderr
        pass                                # unformatted; _serve does it instead


class Server(ThreadingHTTPServer):
    """One thread per connection, with a ceiling on how many may exist.

    `request_queue_size` only sizes the accept backlog; it does not cap
    concurrency, and the stock class spawns an unbounded daemon thread per
    accepted connection. Combined with `Handler.timeout` that made 200 sockets
    sending a partial request line into 200 pinned threads for as long as the
    client cared to hold them. Over the ceiling we answer 503 and close, which
    is a visible refusal rather than a queue that hides the problem.
    """

    daemon_threads = True
    allow_reuse_address = True
    # http.server has no request-size limits of its own worth relying on;
    # the router caps the request target and every query is parameterised.
    request_queue_size = 64
    max_connections = MAX_CONNECTIONS
    over_capacity_response = (
        b"HTTP/1.1 503 Service Unavailable\r\n"
        b"Content-Type: text/plain; charset=utf-8\r\n"
        b"Content-Length: 43\r\nRetry-After: 1\r\nConnection: close\r\n\r\n"
        b"too many concurrent connections; retry\n")

    def __init__(self, *args, **kwargs):
        # Created before super().__init__, which may begin accepting.
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


def build(db_path, *, chain=None, access_log=True, api_app=None):
    store = Store(db_path)
    router = Router(store, chain_override=chain, api_app=api_app)
    handler = type("BoundHandler", (Handler,),
                   {"router": router, "access_log": access_log})
    return store, router, handler


def serve(db_path, *, host="127.0.0.1", port=8080, chain=None, access_log=True,
          api_app=None, log=print):
    store, _router, handler = build(db_path, chain=chain, access_log=access_log,
                                    api_app=api_app)
    httpd = Server((host, port), handler)
    # Touch the index once at startup so a misconfigured path fails loudly here
    # rather than as a 503 on someone's first request.
    try:
        conn = store.connection()
        state = conn.execute("SELECT chain, indexed_height FROM sync_state"
                             " WHERE id=1").fetchone()
        log("index %s opened %s: chain=%s height=%s"
            % (db_path, store.mode, state["chain"], state["indexed_height"]))
    except IndexUnavailable as exc:
        log("WARNING: cannot open the index at %s (%s) -- serving 503 until it "
            "appears" % (db_path, exc))
    if api_app is None:
        log("serving http://%s:%d/ (GET and HEAD only, no write surface)"
            % (host, port))
    else:
        log("serving http://%s:%d/ -- pages plus the mounted API at /api "
            "(%s)" % (host, port, type(api_app).__name__))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        log("stopping")
    finally:
        httpd.server_close()
    return 0
