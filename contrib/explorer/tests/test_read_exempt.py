"""The read-limit exemption for direct local callers (--read-limit-exempt).

Why it exists: every caller on the explorer's own host that connects straight
to 127.0.0.1:8080 shares ONE rate-limit key, so one local burst 429'd every
other local reader -- the ops census and a payment rail's deposit watcher among
them (2026-09-27).

What must never happen is a request that came THROUGH the reverse proxy getting
the exemption. Caddy connects from loopback too, so the tests that matter most
here are the ones where the peer IS loopback and the answer must still be
"limited": every forwarding header, empty or not, and a spoofed
X-Forwarded-For under --trust-proxy.

Every limiter below is built with burst 0 and rate 0, so a request the limiter
sees is refused on the spot: 200 means "exempt", 429 means "limited", and no
test has to reason about a bucket refilling.
"""

import contextlib
import http.client
import io
import json
import threading
import unittest

from . import helpers  # noqa: F401  (sets sys.path)
from .apiharness import Env
from .fakechain import FakeChain

from pcoin_api import cli as apicli
from pcoin_api.ratelimit import (FORWARDING_HEADERS, is_direct_local,
                                 parse_networks)
from pcoin_explorer import server as webserver

LOOPBACK = parse_networks(["127.0.0.0/8,::1/128"])


def small_chain():
    chain = FakeChain(genesis_address=None)
    chain.mine_many(2, miner="ADDRMINER")
    return chain


def hdrs(pairs=()):
    """A real case-insensitive header map, the type http.server hands over."""
    m = http.client.HTTPMessage()
    for k, v in pairs:
        m[k] = v
    return m


def fetch(port, method, path, headers=None, body=None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    try:
        conn.request(method, path, body=body, headers=dict(headers or {}))
        resp = conn.getresponse()
        data = resp.read()
        return resp.status, (json.loads(data) if data else None)
    finally:
        conn.close()


class DecisionTests(unittest.TestCase):
    """is_direct_local() on its own: the whole policy in one function."""

    def test_nothing_configured_exempts_nobody(self):
        self.assertFalse(is_direct_local("127.0.0.1", hdrs(), ()))
        self.assertFalse(is_direct_local("127.0.0.1", hdrs(), None))

    def test_a_direct_loopback_caller_is_exempt(self):
        for peer in ("127.0.0.1", "127.0.0.2", "::1", "::ffff:127.0.0.1"):
            with self.subTest(peer=peer):
                self.assertTrue(is_direct_local(peer, hdrs(), LOOPBACK))

    def test_a_peer_outside_the_list_is_not(self):
        # The second is this host's own public address: a request that went out
        # through Cloudflare and came back is public traffic, not a local call.
        for peer in ("10.0.0.5", "2a01:4f8:c014:2684::1", "not-an-ip", ""):
            with self.subTest(peer=peer):
                self.assertFalse(is_direct_local(peer, hdrs(), LOOPBACK))

    def test_any_forwarding_header_disqualifies_even_when_empty(self):
        # Caddy's `header_up X-Forwarded-For {CF-Connecting-IP}` sends an EMPTY
        # value when the placeholder is empty. Present-but-empty is still "this
        # came through a proxy".
        for name in FORWARDING_HEADERS:
            for value in ("", "203.0.113.9"):
                with self.subTest(header=name, value=value):
                    self.assertFalse(is_direct_local(
                        "127.0.0.1", hdrs([(name, value)]), LOOPBACK))

    def test_header_names_are_matched_case_insensitively(self):
        self.assertFalse(is_direct_local(
            "127.0.0.1", hdrs([("x-forwarded-proto", "https")]), LOOPBACK))
        self.assertFalse(is_direct_local(
            "127.0.0.1", hdrs([("cf-connecting-ip", "1.2.3.4")]), LOOPBACK))

    def test_an_ordinary_header_does_not_disqualify(self):
        self.assertTrue(is_direct_local(
            "127.0.0.1", hdrs([("Accept", "application/json"),
                               ("User-Agent", "node")]), LOOPBACK))


class ParseTests(unittest.TestCase):
    def test_accepts_lists_commas_and_spaces(self):
        nets = parse_networks(["127.0.0.0/8, ::1/128", "", "10.1.2.0/24"])
        self.assertEqual([str(n) for n in nets],
                         ["127.0.0.0/8", "::1/128", "10.1.2.0/24"])
        self.assertEqual(parse_networks(None), ())
        self.assertEqual(parse_networks([]), ())

    def test_refuses_what_it_cannot_read(self):
        # A security list: a typo must stop the process, never quietly exempt
        # nothing -- or everything.
        for bad in ("127.0.0.1/8", "0.0.0.0/0", "::/0", "localhost",
                    "127.0.0.0/33"):
            with self.subTest(value=bad):
                with self.assertRaises(ValueError):
                    parse_networks([bad])


class CliTests(unittest.TestCase):
    ENV = apicli.READ_EXEMPT_ENV

    def test_off_by_default(self):
        args = apicli.build_parser().parse_args([])
        self.assertEqual(apicli.read_exempt_networks(args, environ={}), ())

    def test_flags_and_environment_are_merged_without_duplicates(self):
        args = apicli.build_parser().parse_args(
            ["--read-limit-exempt", "127.0.0.0/8",
             "--read-limit-exempt", "::1/128"])
        nets = apicli.read_exempt_networks(
            args, environ={self.ENV: "127.0.0.0/8, 10.9.0.0/16"})
        self.assertEqual([str(n) for n in nets],
                         ["127.0.0.0/8", "::1/128", "10.9.0.0/16"])

    def test_environment_alone(self):
        args = apicli.build_parser().parse_args([])
        nets = apicli.read_exempt_networks(
            args, environ={self.ENV: "127.0.0.0/8,::1/128"})
        self.assertEqual([str(n) for n in nets], ["127.0.0.0/8", "::1/128"])

    def test_a_bad_flag_is_a_usage_error(self):
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                apicli.build_parser().parse_args(
                    ["--read-limit-exempt", "127.0.0.1/8"])

    def test_a_bad_environment_value_refuses_to_start(self):
        args = apicli.build_parser().parse_args([])
        with self.assertRaises(ValueError) as cm:
            apicli.read_exempt_networks(args, environ={self.ENV: "0.0.0.0/0"})
        self.assertIn(self.ENV, str(cm.exception))


class ApiServerTests(unittest.TestCase):
    """pcoin_api's own HTTP server, over a real socket from 127.0.0.1."""

    def env(self, **kw):
        kw.setdefault("read_rate", 0.0)
        kw.setdefault("read_burst", 0)
        env = Env(chain=small_chain(), **kw)
        self.addCleanup(env.close)
        return env

    def test_without_the_setting_loopback_is_limited_as_before(self):
        env = self.env()
        self.assertEqual(env.get("/api/status")[0], 429)

    def test_a_direct_local_caller_is_not_read_limited(self):
        env = self.env(read_exempt_networks=LOOPBACK)
        codes = [env.get("/api/status")[0] for _ in range(8)]
        self.assertEqual(codes, [200] * 8)

    def test_a_proxied_request_from_loopback_is_still_limited(self):
        env = self.env(read_exempt_networks=LOOPBACK)
        for name in FORWARDING_HEADERS:
            for value in ("", "203.0.113.9"):
                with self.subTest(header=name, value=value):
                    status, body, _h = env.get("/api/status",
                                               headers={name: value})
                    self.assertEqual(status, 429, body)
                    self.assertEqual(body["error"]["code"], "rate_limited")

    def test_a_spoofed_forwarded_for_under_trust_proxy_is_limited(self):
        # With --trust-proxy the rate-limit KEY is read from X-Forwarded-For. A
        # request naming 127.0.0.1 there is keyed as 127.0.0.1 -- and must
        # still be limited, because the exemption never looks at the key.
        env = self.env(trust_proxy=True, read_exempt_networks=LOOPBACK)
        for xff in ("127.0.0.1", "203.0.113.9, 127.0.0.1", "::1"):
            with self.subTest(xff=xff):
                status, _b, _h = env.get("/api/status",
                                         headers={"X-Forwarded-For": xff})
                self.assertEqual(status, 429)
        self.assertEqual(env.get("/api/status")[0], 200)

    def test_broadcasts_stay_limited_for_exempt_callers(self):
        env = self.env(read_exempt_networks=LOOPBACK, broadcast_rate=0.0,
                       broadcast_burst=1)
        first, _b, _h = env.post("/api/tx", {"hex": "00"})
        self.assertNotEqual(first, 429, "the read limit (burst 0) must not "
                                        "have applied to an exempt POST")
        second, body, _h = env.post("/api/tx", {"hex": "00"})
        self.assertEqual(second, 429)
        self.assertEqual(body["error"]["limit_scope"], "client")


class _PlainStubApi:
    """The documented five-argument mount contract and nothing else."""

    cors_origin = "*"

    def __init__(self):
        self.calls = []

    def handle(self, method, path, query, body, client):
        self.calls.append((method, path, client))
        return 200, {"ok": True}


class MountedTests(unittest.TestCase):
    """The deployed shape: pcoin_explorer serving the API it mounts."""

    def serve(self, api_app):
        router = webserver.Router(None, api_app=api_app)
        handler = type("QuietHandler", (webserver.Handler,),
                       {"router": router, "access_log": False})
        httpd = webserver.Server(("127.0.0.1", 0), handler)
        thread = threading.Thread(target=httpd.serve_forever,
                                  kwargs={"poll_interval": 0.01}, daemon=True)
        thread.start()

        def stop():
            httpd.shutdown()
            httpd.server_close()
        self.addCleanup(stop)
        return httpd.server_address[1]

    def api(self, **kw):
        env = Env(chain=small_chain(), serve=False, read_rate=0.0,
                  read_burst=0, **kw)
        self.addCleanup(env.close)
        return env.app

    def test_off_by_default(self):
        port = self.serve(self.api())
        self.assertEqual(fetch(port, "GET", "/api/status")[0], 429)

    def test_a_direct_local_caller_is_exempt(self):
        port = self.serve(self.api(read_exempt_networks=LOOPBACK))
        codes = [fetch(port, "GET", "/api/status")[0] for _ in range(6)]
        self.assertEqual(codes, [200] * 6)

    def test_what_caddy_sends_is_limited(self):
        # The headers Caddy puts on every request it proxies to this port,
        # including the EMPTY X-Forwarded-For it sends when CF-Connecting-IP is
        # absent (a local request to Caddy itself).
        port = self.serve(self.api(trust_proxy=True,
                                   read_exempt_networks=LOOPBACK))
        for extra in ({"X-Forwarded-For": "203.0.113.9"},
                      {"X-Forwarded-For": "127.0.0.1"},
                      {"X-Forwarded-For": ""}):
            headers = {"X-Forwarded-Proto": "https",
                       "X-Forwarded-Host": "explorer.pc.am", **extra}
            with self.subTest(**extra):
                self.assertEqual(
                    fetch(port, "GET", "/api/status", headers)[0], 429)
        self.assertEqual(fetch(port, "GET", "/api/status")[0], 200)

    def test_an_app_without_the_hook_is_called_as_before(self):
        stub = _PlainStubApi()
        port = self.serve(stub)
        self.assertEqual(fetch(port, "GET", "/api/status")[0], 200)
        self.assertEqual(stub.calls, [("GET", "/api/status", "127.0.0.1")])


if __name__ == "__main__":
    unittest.main()
