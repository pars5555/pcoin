"""Build a real index, a real HTTP server and a fake node, for the API tests.

The tests talk to the API over a genuine TCP socket with `http.client`, not by
calling handler functions directly. Routing, header handling, body limits, status
codes and the JSON encoder are all part of the contract a wallet depends on, and
a test that bypasses them tests something else.
"""

import http.client
import json
import os
import shutil
import tempfile

from . import helpers  # noqa: F401  (sets sys.path)
from .fakechain import FakeChain
from .fakenode import FakeNode
from pcoin_indexer import db
from pcoin_indexer.indexer import Indexer

from pcoin_api.broadcast import Broadcaster
from pcoin_api.nodeview import NodeView
from pcoin_api.ratelimit import RateLimiter
from pcoin_api.server import ApiApplication, ApiServer
from pcoin_api.service import Service
from pcoin_api.store import Store


class Env:
    """An index, a fake node, a Service and (optionally) a listening server."""

    def __init__(self, *, chain=None, node=None, read_rate=1000.0,
                 read_burst=1000.0, broadcast_rate=1000.0, broadcast_burst=1000.0,
                 broadcast_global_rate=None, broadcast_global_burst=None,
                 cache_seconds=0.0, enabled=True, allow_wallet_node=False,
                 witness_rpc=None, wait_seconds=0.0, serve=True,
                 max_addresses=500):
        self.tmpdir = tempfile.mkdtemp(prefix="pcoin-api-test-")
        self.db_path = os.path.join(self.tmpdir, "index.sqlite")
        self.chain = chain or FakeChain(genesis_address=None)
        self.node = node or FakeNode(self.chain)

        self.writer = db.connect(self.db_path)
        db.init_schema(self.writer)
        self.indexer = Indexer(self.writer, self.node, chain="regtest")
        self.indexer.sync()

        self.store = Store(self.db_path)
        # cache_seconds=0 makes every request re-observe the node, which is what
        # a test wants: no test should have to reason about a stale cache.
        self.view = NodeView(self.node, resolver=self.store.resolve_outpoints,
                             cache_seconds=cache_seconds)
        self.service = Service(self.store, self.view, max_addresses=max_addresses)
        self.broadcaster = Broadcaster(
            self.node, self.view, self.store, enabled=enabled,
            allow_wallet_node=allow_wallet_node, witness_rpc=witness_rpc,
            wait_seconds=wait_seconds, poll_seconds=0.0, sleep=lambda _s: None)
        self.app = ApiApplication(
            self.service, self.broadcaster,
            read_limiter=RateLimiter(read_rate, read_burst),
            broadcast_limiter=RateLimiter(
                broadcast_rate, broadcast_burst,
                global_rate=broadcast_global_rate,
                global_burst=broadcast_global_burst),
            cors_origin="*")
        self.server = None
        if serve:
            self.server = ApiServer(("127.0.0.1", 0), self.app)
            import threading
            # A short poll interval: the default 0.5s is what `shutdown()` waits
            # for, and paid once per test it dominates the whole suite.
            self.thread = threading.Thread(
                target=self.server.serve_forever, kwargs={"poll_interval": 0.01},
                daemon=True)
            self.thread.start()

    def blind_node(self):
        """Throw away every observation of the node.

        Models a process that has just started against a node it has never
        reached -- which is the only state in which the mempool is genuinely
        *unknown*. (A node that answered once and then went away is a different
        state: the last observation is kept, with its true age.)
        """
        self.view = NodeView(self.node, resolver=self.store.resolve_outpoints,
                             cache_seconds=0.0)
        self.service.node = self.view
        self.broadcaster.node = self.view
        return self.view

    # -- lifecycle -------------------------------------------------------
    def resync(self):
        """Advance the index after the fake chain has moved."""
        return self.indexer.sync()

    def close(self):
        if self.server is not None:
            self.server.shutdown()
            self.server.server_close()
        self.store.close()
        self.writer.close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    # -- requests --------------------------------------------------------
    @property
    def port(self):
        return self.server.server_address[1]

    def request(self, method, path, body=None, headers=None, raw_body=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            payload = raw_body
            hdrs = dict(headers or {})
            if body is not None:
                payload = json.dumps(body).encode()
                hdrs.setdefault("Content-Type", "application/json")
            conn.request(method, path, body=payload, headers=hdrs)
            resp = conn.getresponse()
            data = resp.read()
            return resp.status, dict(resp.getheaders()), data
        finally:
            conn.close()

    def get(self, path, **kw):
        status, headers, data = self.request("GET", path, **kw)
        return status, (json.loads(data) if data else None), headers

    def post(self, path, body=None, **kw):
        status, headers, data = self.request("POST", path, body=body, **kw)
        return status, (json.loads(data) if data else None), headers
