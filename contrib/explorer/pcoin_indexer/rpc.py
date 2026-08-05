"""Minimal JSON-RPC client for a PCoin (Bitcoin Core v29.4 derived) node.

Stdlib only. Two things it does that a naive client does not:

1. Amounts are parsed with ``parse_float=Decimal`` so a PCN value is never a
   binary float. See amounts.py.
2. It distinguishes *the node answered with an error* (``RpcError``, a fact)
   from *we could not reach the node* (``RpcTransportError``, not a fact).
   CLAUDE.md section 7.1/7.2: an RPC that failed resolves nothing. The caller
   must not turn a transport failure into an answer.
"""

import base64
import json
import os
import time
import urllib.error
import urllib.request
from decimal import Decimal

# src/chainparamsbase.cpp:41-56 -- PCoin's RPC port is P2P *minus* one, which is
# not Bitcoin's arrangement (P2P+1 is bitcoind's default Tor onion listener).
# Getting regtest wrong here is not cosmetic: 19443 is testnet3's RPC port, so a
# regtest indexer would have quietly indexed a different network.
DEFAULT_RPC_PORT = {"main": 9443, "test": 19443, "testnet4": 29443,
                    "signet": 39443, "regtest": 49443}
COOKIE_SUBDIR = {"main": "", "test": "testnet3", "testnet4": "testnet4",
                 "signet": "signet", "regtest": "regtest"}

# Node error codes that mean "that block is not on my active chain right now",
# which during a reorg is an ordinary answer rather than a failure:
#   -8  RPC_INVALID_PARAMETER   getblockhash: "Block height out of range"
#   -5  RPC_INVALID_ADDRESS_OR_KEY  getblock: "Block not found"
MISSING_BLOCK_CODES = (-8, -5)


class RpcError(Exception):
    """The node answered, and the answer was an error. This is a fact."""

    def __init__(self, code, message):
        super().__init__("RPC error %s: %s" % (code, message))
        self.code = code
        self.message = message


class RpcTransportError(Exception):
    """We did not get an answer. This resolves nothing."""


class RpcClient:
    def __init__(self, url, user=None, password=None, cookie_path=None, timeout=180):
        self.url = url.rstrip("/")
        self.timeout = timeout
        self._cookie_path = cookie_path
        self._user = user
        self._password = password
        self._auth = None
        self._id = 0
        self.call_count = 0
        self.rpc_seconds = 0.0
        self.bytes_in = 0

    # -- auth ------------------------------------------------------------
    def _load_auth(self, force=False):
        if self._auth is not None and not force:
            return self._auth
        if self._user is not None:
            raw = "%s:%s" % (self._user, self._password or "")
        elif self._cookie_path:
            try:
                with open(self._cookie_path, "r", encoding="utf-8") as fh:
                    raw = fh.read().strip()
            except OSError as exc:
                raise RpcTransportError("cannot read cookie %s: %s"
                                        % (self._cookie_path, exc)) from exc
        else:
            raise RpcTransportError("no RPC credentials configured")
        self._auth = base64.b64encode(raw.encode("utf-8")).decode("ascii")
        return self._auth

    # -- transport -------------------------------------------------------
    def _post(self, payload):
        body = json.dumps(payload).encode("utf-8")
        for attempt in (0, 1):
            req = urllib.request.Request(
                self.url, data=body,
                headers={"Content-Type": "application/json",
                         "Authorization": "Basic " + self._load_auth(force=bool(attempt))})
            started = time.monotonic()
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    raw = resp.read()
            except urllib.error.HTTPError as exc:
                raw = exc.read()
                if exc.code == 401 and attempt == 0 and self._cookie_path:
                    # Node restarted -> new cookie. Re-read once, then give up.
                    continue
                if exc.code == 500 and raw:
                    # Core returns 500 with a JSON-RPC error body for e.g.
                    # "Block height out of range". That is an answer.
                    try:
                        return json.loads(raw.decode("utf-8"), parse_float=Decimal)
                    except ValueError:
                        pass
                raise RpcTransportError("HTTP %s from %s: %s"
                                        % (exc.code, self.url, raw[:200])) from exc
            except (urllib.error.URLError, OSError) as exc:
                raise RpcTransportError("cannot reach %s: %s" % (self.url, exc)) from exc
            finally:
                self.rpc_seconds += time.monotonic() - started
            self.bytes_in += len(raw)
            try:
                return json.loads(raw.decode("utf-8"), parse_float=Decimal)
            except ValueError as exc:
                raise RpcTransportError("unparseable RPC response: %s" % exc) from exc
        raise RpcTransportError("authentication failed against %s" % self.url)

    # -- API -------------------------------------------------------------
    def call(self, method, *params):
        self._id += 1
        self.call_count += 1
        resp = self._post({"jsonrpc": "1.0", "id": self._id,
                           "method": method, "params": list(params)})
        if isinstance(resp, list):
            raise RpcTransportError("batch response to a single call")
        err = resp.get("error")
        if err:
            raise RpcError(err.get("code"), err.get("message"))
        return resp.get("result")

    def batch(self, calls, *, missing_codes=()):
        """calls: [(method, [params...]), ...] -> [result, ...] in order.

        `missing_codes` lists node error codes that are turned into ``None``
        instead of raising. That is used for exactly one thing: a reorg between
        the tip observation and the fetch means some of the heights we asked for
        are no longer on the node's active chain. The node *answered* -- it said
        "not on my chain" -- so it is a fact, and the caller re-polls. Every
        other error code still raises, because an unexpected error must not be
        read as "that block does not exist".
        """
        if not calls:
            return []
        payload = []
        base = self._id
        for i, (method, params) in enumerate(calls):
            payload.append({"jsonrpc": "1.0", "id": base + i,
                            "method": method, "params": list(params)})
        self._id = base + len(calls)
        self.call_count += len(calls)
        resp = self._post(payload)
        if not isinstance(resp, list):
            err = resp.get("error") if isinstance(resp, dict) else None
            if err:
                raise RpcError(err.get("code"), err.get("message"))
            raise RpcTransportError("expected a batch response, got %r" % type(resp))
        if len(resp) != len(calls):
            raise RpcTransportError("batch length mismatch: sent %d got %d"
                                    % (len(calls), len(resp)))
        by_id = {}
        for item in resp:
            by_id[item.get("id")] = item
        out = []
        for i, (method, _params) in enumerate(calls):
            item = by_id.get(base + i)
            if item is None:
                raise RpcTransportError("batch response missing id %d" % (base + i))
            if item.get("error"):
                e = item["error"]
                if e.get("code") in missing_codes:
                    out.append(None)
                    continue
                raise RpcError(e.get("code"), e.get("message"))
            out.append(item.get("result"))
        return out

    # -- convenience -----------------------------------------------------
    def blockchain_info(self):
        return self.call("getblockchaininfo")

    def block_hash(self, height):
        return self.call("getblockhash", height)

    def block_hashes(self, heights):
        """-> [hash | None]. None means "no longer on the active chain"."""
        return self.batch([("getblockhash", [h]) for h in heights],
                          missing_codes=MISSING_BLOCK_CODES)

    def blocks_verbose(self, hashes, verbosity=3):
        """-> [block | None], positionally aligned with `hashes`.

        None means "the node no longer has that block". `hashes` must not
        contain None -- the caller re-polls as soon as a height goes missing,
        so a None here would be a bug rather than a reorg.
        """
        if any(h is None for h in hashes):
            raise ValueError("blocks_verbose called with a missing hash")
        return self.batch([("getblock", [h, verbosity]) for h in hashes],
                          missing_codes=MISSING_BLOCK_CODES)


def client_from_args(url=None, datadir=None, chain="main", user=None,
                     password=None, cookie=None, timeout=180):
    """Build a client from the usual combination of flags."""
    if url is None:
        port = DEFAULT_RPC_PORT.get(chain, 9443)
        url = "http://127.0.0.1:%d/" % port
    if user is None and cookie is None and datadir:
        sub = COOKIE_SUBDIR.get(chain, "")
        cookie = os.path.join(datadir, sub, ".cookie") if sub else os.path.join(datadir, ".cookie")
    return RpcClient(url, user=user, password=password, cookie_path=cookie, timeout=timeout)
