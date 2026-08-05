"""Tests for the web UI and the JSON API.

The router is exercised directly (``Router.handle(path, query)``) rather than
over a socket: every page, every status code and every escaping rule is
reachable without binding a port, so the suite stays fast and hermetic.

What is actually asserted, beyond "it returns 200":

* the numbers rendered on an address page equal the index's own numbers;
* an immature coinbase is excluded from "spendable now" in the page, not just
  in the query layer;
* the unconfirmed balance is rendered as *unknown*, never as 0 -- there is no
  mempool index, and CLAUDE.md 7.1/7.2 makes rendering an unanswered question
  as a definite answer the single most expensive class of bug in this project;
* the staleness banner appears exactly when ``health()["stale"]`` is true;
* an orphaned block still resolves to a page, because reorgs are routine here;
* the search box routes every input shape to the right place, and says the
  right thing about the ones it cannot route;
* no page contains a ``<script`` tag, and hostile input never escapes escaping.
"""

import contextlib
import io
import json
import time
import unittest

from . import helpers  # noqa: F401  (sets sys.path)
from .bech32enc import address_n, p2tr, p2wpkh
from .fakechain import COIN, SUBSIDY, FakeChain, FakeRpc
from .helpers import make_indexer

from pcoin_indexer import db, queries
from pcoin_indexer.amounts import from_sat
from pcoin_indexer.indexer import COINBASE_MATURITY

from pcoin_explorer import addr, api, fmt, reads, search, server, views
from pcoin_explorer.views import Ctx

# fakechain reports chain "regtest" from getblockchaininfo, and the indexer
# records that in sync_state, so the explorer decodes addresses with regtest's
# hrp. The test addresses match, which also keeps the wrong-network tests
# honest: a mainnet `pc1...` address really is foreign here.
CHAIN = "regtest"
HRP = "pcrt"
MINER = address_n(1, hrp=HRP)
ALICE = address_n(2, hrp=HRP)
BOB = address_n(3, hrp=HRP)
UNSEEN = address_n(99, hrp=HRP)


VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link",
             "meta", "source", "track", "wbr"}


def _unclosed_tags(html_text):
    """-> the stack of tags left open at the end of the document."""
    from html.parser import HTMLParser

    class Checker(HTMLParser):
        def __init__(self):
            super().__init__(convert_charrefs=True)
            self.stack = []
            self.bad = []

        def handle_starttag(self, tag, attrs):
            if tag not in VOID_TAGS:
                self.stack.append(tag)

        def handle_endtag(self, tag):
            if tag in VOID_TAGS:
                return
            if tag in self.stack:
                while self.stack and self.stack.pop() != tag:
                    self.bad.append(tag)
            else:
                self.bad.append("stray </%s>" % tag)

    c = Checker()
    c.feed(html_text)
    c.close()
    return c.stack + c.bad


class StubStore:
    """A Store that hands out one already-open connection."""

    def __init__(self, conn):
        self.conn = conn
        self.mode = "test"

    def connection(self):
        return self.conn

    def close(self):
        pass


def build_chain(*, with_reorg=False, payment=True):
    """A small but structurally complete chain.

    It deliberately contains every awkward shape the real chain has: an
    addressless genesis output, a witness-commitment OP_RETURN in every
    coinbase, immature coinbases at the tip, mature ones below, and (optionally)
    a reorg so that reorg_log and orphaned_blocks are not empty.
    """
    chain = FakeChain()
    chain.mine_many(COINBASE_MATURITY + 5, miner=MINER)
    if payment:
        cb1 = chain.coinbase_txid(1)
        chain.mine(miner=MINER, spends=[(cb1, 0)],
                   pays=[(ALICE, 30 * COIN), (BOB, 19 * COIN)])
    chain.mine_many(3, miner=MINER)
    conn, idx = make_indexer(FakeRpc(chain))
    idx.sync()
    if with_reorg:
        fork = chain.active_chain()[-3]
        branch = chain.mine(on=fork, miner=BOB)
        branch = chain.mine(on=branch, miner=BOB)
        branch = chain.mine(on=branch, miner=BOB)
        branch = chain.mine(on=branch, miner=BOB)
        chain.set_tip(branch)
        idx.sync()
    return chain, conn, idx


def router_for(conn):
    return server.Router(StubStore(conn))


def get(router, path, query=""):
    status, ctype, payload, extra = router.handle(path, query)
    return status, ctype, payload.decode("utf-8"), dict(extra)


def get_json(router, path, query=""):
    status, ctype, body, _extra = get(router, path, query)
    assert "json" in ctype, (path, ctype, body[:200])
    return status, json.loads(body)


class PageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.chain, cls.conn, cls.idx = build_chain(with_reorg=True)
        cls.router = router_for(cls.conn)
        cls.tip = queries.tip_height(cls.conn)

    def test_every_page_renders(self):
        cb = self.chain.coinbase_txid(2)
        paths = ["/", "/blocks", "/blocks?page=2", "/txs", "/txs?payments=1",
                 "/addresses", "/addresses?all=1", "/reorgs", "/about", "/api",
                 "/block/0", "/block/%d" % self.tip, "/tx/%s" % cb,
                 "/address/%s" % MINER, "/address/%s?view=utxos" % MINER,
                 "/address/%s" % UNSEEN, "/static/style.css", "/robots.txt"]
        for p in paths:
            path, _, query = p.partition("?")
            status, _ctype, body, _ = get(self.router, path, query)
            self.assertEqual(status, 200, "%s -> %s" % (p, status))
            self.assertTrue(body)

    def test_no_javascript_anywhere(self):
        """The CSP says script-src is absent; the pages must actually comply,
        so the site keeps working with scripting switched off."""
        for p in ["/", "/blocks", "/txs", "/addresses", "/reorgs", "/about",
                  "/block/1", "/address/%s" % MINER]:
            _s, ctype, body, _ = get(self.router, p)
            self.assertIn("html", ctype)
            self.assertNotIn("<script", body.lower())
            self.assertNotIn("onclick=", body.lower())
            self.assertNotIn("javascript:", body.lower())

    def test_markup_is_balanced(self):
        """The markup is built by string concatenation, so nothing else checks
        that the tags close. An unbalanced <div> silently swallows the rest of
        the page in a real browser."""
        cb = self.chain.coinbase_txid(2)
        pay = self.conn.execute(
            "SELECT txid FROM txs WHERE is_coinbase=0 LIMIT 1").fetchone()
        paths = ["/", "/blocks", "/txs", "/txs?payments=1", "/addresses",
                 "/addresses?all=1", "/reorgs", "/about", "/api", "/block/0",
                 "/block/%d" % self.tip, "/tx/%s" % cb,
                 "/address/%s" % MINER, "/address/%s?view=utxos" % MINER,
                 "/address/%s" % UNSEEN, "/no/such/page", "/search?q=zzz"]
        if pay:
            paths.append("/tx/%s" % pay["txid"])
        for p in paths:
            path, _, query = p.partition("?")
            _s, ctype, body, _ = get(self.router, path, query)
            self.assertIn("html", ctype, p)
            self.assertEqual(_unclosed_tags(body), [], "unbalanced tags on %s" % p)

    def test_no_double_escaped_entities(self):
        """`&amp;mdash;` on the page means a literal was escaped twice: text
        that should be markup went through the escaper, or vice versa. Cheap to
        introduce and easy to miss by eye."""
        cb = self.chain.coinbase_txid(2)
        for p in ["/", "/blocks", "/txs", "/addresses", "/reorgs", "/about",
                  "/api", "/block/1", "/tx/%s" % cb, "/address/%s" % MINER]:
            _s, _c, body, _ = get(self.router, p)
            for bad in ("&amp;mdash;", "&amp;middot;", "&amp;nbsp;", "&amp;amp;",
                        "&amp;times;", "&amp;hellip;", "&amp;lt;", "&amp;gt;"):
                self.assertNotIn(bad, body, "%s contains %s" % (p, bad))

    def test_security_headers_declared(self):
        names = dict(server.SECURITY_HEADERS)
        self.assertIn("default-src 'none'", names["Content-Security-Policy"])
        self.assertEqual(names["X-Content-Type-Options"], "nosniff")

    def test_html_is_never_cached(self):
        _s, _c, _b, extra = get(self.router, "/address/%s" % MINER)
        self.assertEqual(extra.get("Cache-Control"), "no-store")

    def test_stylesheet_is_cached_and_tagged(self):
        _s, ctype, _b, extra = get(self.router, "/static/style.css")
        self.assertIn("text/css", ctype)
        self.assertIn("max-age", extra.get("Cache-Control", ""))
        self.assertTrue(extra.get("ETag"))

    def test_unknown_page_is_404(self):
        for p in ("/no/such/thing", "/apiary", "/blocksx", "/tx", "/address",
                  "/block", "/static/other.css", "/etc/passwd"):
            status, _c, _b, _ = get(self.router, p)
            self.assertEqual(status, 404, "%s -> %s" % (p, status))
        # a trailing slash on /api is the same page, not a miss
        self.assertEqual(get(self.router, "/api/")[0], 200)

    def test_missing_block_and_tx_are_404(self):
        self.assertEqual(get(self.router, "/block/999999")[0], 404)
        self.assertEqual(get(self.router, "/tx/" + "ab" * 32)[0], 404)

    def test_method_surface_is_read_only(self):
        """With nothing mounted at /api the process has no write endpoint at
        all: no broadcast, no address generation. Non-custodial by
        construction, not by policy."""
        self.assertTrue(hasattr(server.Handler, "do_GET"))
        self.assertTrue(hasattr(server.Handler, "do_HEAD"))
        for verb in ("do_POST", "do_PUT", "do_DELETE", "do_PATCH"):
            self.assertIs(getattr(server.Handler, verb), server.Handler._with_body)
        for verb in ("POST", "PUT", "DELETE", "PATCH"):
            for path in ("/", "/api/tx", "/address/%s" % MINER):
                status, _c, _b, _e = self.router.handle(path, "", method=verb,
                                                        body=b"x")
                self.assertEqual(status, 405, "%s %s" % (verb, path))


class AddressPageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.chain, cls.conn, cls.idx = build_chain()
        cls.router = router_for(cls.conn)
        cls.tip = queries.tip_height(cls.conn)

    def test_balance_matches_the_index(self):
        s = queries.address_summary(self.conn, MINER)
        _st, _c, body, _ = get(self.router, "/address/%s" % MINER)
        self.assertIn(from_sat(s["balance"]).split(".")[1], body)
        # the exact fixed-point strings must both appear, split across the
        # dimmed fractional span
        for value in (s["balance"], s["spendable"], s["immature"]):
            whole, frac = from_sat(value).split(".")
            self.assertIn("%s<span class=\"amt-f\">.%s</span>" % (
                "{:,}".format(int(whole)), frac), body,
                "missing rendering of %s" % from_sat(value))

    def test_immature_is_separated_from_spendable(self):
        s = queries.address_summary(self.conn, MINER)
        self.assertGreater(s["immature"], 0, "test chain should have immature coins")
        self.assertEqual(s["spendable"], s["balance"] - s["immature"])
        _st, _c, body, _ = get(self.router, "/address/%s" % MINER)
        self.assertIn("Immature", body)
        self.assertIn("Spendable now", body)

    def test_unconfirmed_is_unknown_not_zero(self):
        """No mempool index means the unconfirmed balance is unanswered. It must
        never render as 0.00000000 -- that is a definite answer to a question
        nobody asked the node (CLAUDE.md 7.2)."""
        _st, _c, body, _ = get(self.router, "/address/%s" % MINER)
        self.assertIn("Unconfirmed", body)
        self.assertIn("not indexed", body)
        head = body[body.index("Unconfirmed"):body.index("Unconfirmed") + 400]
        self.assertNotIn("0.00000000", head)

        _st, payload = get_json(self.router, "/api/address/%s" % MINER)
        self.assertIsNone(payload["unconfirmed"])
        self.assertIn("mempool", payload["unconfirmed_reason"])

    def test_valid_but_unseen_address_is_not_a_404(self):
        """A freshly derived receive address has no history. Saying 'not found'
        would read as 'your address is wrong'."""
        status, _c, body, _ = get(self.router, "/address/%s" % UNSEEN)
        self.assertEqual(status, 200)
        self.assertIn("never appeared on the chain", body)
        self.assertIn("P2WPKH", body)

    def test_uppercase_bech32_is_canonicalised(self):
        status, _c, _b, extra = get(self.router, "/search", "q=" + MINER.upper())
        self.assertEqual(status, 302)
        self.assertEqual(extra["Location"], "/address/" + MINER)

    def test_history_and_utxo_views(self):
        for query in ("", "view=utxos"):
            status, _c, body, _ = get(self.router, "/address/%s" % MINER, query)
            self.assertEqual(status, 200)
            self.assertIn("Unspent outputs", body)

    def test_paging_is_bounded(self):
        status, _c, body, _ = get(self.router, "/address/%s" % MINER,
                                  "page=999999999999999999")
        self.assertEqual(status, 200)
        self.assertIn("Address", body)


class TransactionPageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.chain, cls.conn, cls.idx = build_chain()
        cls.router = router_for(cls.conn)
        cls.tip = queries.tip_height(cls.conn)
        cls.payment = cls.conn.execute(
            "SELECT txid FROM txs WHERE is_coinbase=0 LIMIT 1").fetchone()["txid"]

    def test_payment_shows_source_addresses_and_fee(self):
        status, _c, body, _ = get(self.router, "/tx/%s" % self.payment)
        self.assertEqual(status, 200)
        t = queries.transaction(self.conn, self.payment)
        self.assertTrue(t["inputs"][0]["address"])
        self.assertIn(t["inputs"][0]["address"], body)
        for o in t["outputs"]:
            if o["address"]:
                self.assertIn(o["address"], body)
        self.assertIn("sat/vB", body)
        self.assertIn("Inputs", body)
        self.assertIn("Outputs", body)

    def test_coinbase_is_marked_and_maturity_is_shown_in_blocks(self):
        young = self.chain.coinbase_txid(self.tip)
        status, _c, body, _ = get(self.router, "/tx/%s" % young)
        self.assertEqual(status, 200)
        self.assertIn("Coinbase transaction", body)
        self.assertIn("not yet spendable", body)
        self.assertIn(str(self.tip + COINBASE_MATURITY), body.replace(",", ""))

    def test_mature_coinbase_says_so(self):
        old = self.chain.coinbase_txid(1)
        _s, _c, body, _ = get(self.router, "/tx/%s" % old)
        self.assertIn("spendable now", body)

    def test_witness_commitment_output_is_labelled_not_blanked(self):
        """Every coinbase carries a zero-value OP_RETURN with no address. It has
        to be visible as what it is, or the outputs will not add up on screen."""
        cb = self.chain.coinbase_txid(2)
        _s, _c, body, _ = get(self.router, "/tx/%s" % cb)
        self.assertIn("OP_RETURN (unspendable)", body)

    def test_genesis_output_has_no_address(self):
        _s, _c, body, _ = get(self.router, "/block/0")
        self.assertEqual(_s, 200)
        cb = self.chain.coinbase_txid(0)
        _s2, _c2, body2, _ = get(self.router, "/tx/%s" % cb)
        self.assertIn("bare pubkey (no address)", body2)


class BlockPageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.chain, cls.conn, cls.idx = build_chain(with_reorg=True)
        cls.router = router_for(cls.conn)
        cls.tip = queries.tip_height(cls.conn)

    def test_header_fields_are_all_present(self):
        _s, _c, body, _ = get(self.router, "/block/5")
        for label in ("Merkle root", "Median time past", "Chainwork", "Nonce",
                      "Bits", "Subsidy", "Coinbase claimed", "Confirmations"):
            self.assertIn(label, body)

    def test_block_by_hash_and_by_height_agree(self):
        row = self.conn.execute("SELECT hash FROM blocks WHERE height=5").fetchone()
        a = get(self.router, "/block/5")[2]
        b = get(self.router, "/block/%s" % row["hash"])[2]
        self.assertEqual(a, b)

    def test_orphaned_block_resolves_to_a_page(self):
        """Reorgs are routine on PCoin. A block that lost a race must still be
        findable, and must say why it is not on the chain."""
        row = self.conn.execute(
            "SELECT hash FROM orphaned_blocks LIMIT 1").fetchone()
        self.assertIsNotNone(row, "the test chain should have orphaned a block")
        status, _c, body, _ = get(self.router, "/block/%s" % row["hash"])
        self.assertEqual(status, 200)
        self.assertIn("orphaned", body.lower())

    def test_reorg_log_page(self):
        status, _c, body, _ = get(self.router, "/reorgs")
        self.assertEqual(status, 200)
        self.assertIn("Reorgs are routine", body)
        n = self.conn.execute("SELECT COUNT(*) c FROM reorg_log").fetchone()["c"]
        self.assertGreater(n, 0)


class StalenessTests(unittest.TestCase):
    """The banner is the whole reason `sync_state` exists. It has to appear when
    the index is not known to be level with the node, and it has to stay away
    when it is."""

    def setUp(self):
        self.chain, self.conn, self.idx = build_chain()
        self.router = router_for(self.conn)

    def _set(self, **fields):
        db.set_state(self.conn, **fields)

    def test_fresh_index_has_no_banner(self):
        self._set(last_poll_ts=int(time.time()), status="ok", status_detail=None)
        _s, _c, body, _ = get(self.router, "/address/%s" % MINER)
        self.assertNotIn("may be out of date", body)

    def test_behind_the_node_shows_the_banner(self):
        tip = queries.tip_height(self.conn)
        self._set(node_height=tip + 9, last_poll_ts=int(time.time()), status="ok")
        _s, _c, body, _ = get(self.router, "/address/%s" % MINER)
        self.assertIn("may be out of date", body)
        self.assertIn("9 block(s) behind", body)

    def test_a_node_that_stopped_answering_shows_the_banner(self):
        self._set(last_poll_ts=int(time.time()) - 86400, status="error",
                  status_detail="connection refused")
        _s, _c, body, _ = get(self.router, "/")
        self.assertIn("may be out of date", body)

    def test_healthz_reports_503_when_stale(self):
        self._set(last_poll_ts=int(time.time()) - 86400, status="error")
        status, payload = get_json(self.router, "/healthz")
        self.assertEqual(status, 503)
        self.assertTrue(payload["stale"])

    def test_a_miss_while_stale_says_so(self):
        self._set(last_poll_ts=int(time.time()) - 86400, status="error")
        status, _c, body, _ = get(self.router, "/tx/" + "cd" * 32)
        self.assertEqual(status, 404)
        self.assertIn("behind the node", body)


class SearchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.chain, cls.conn, cls.idx = build_chain()
        cls.router = router_for(cls.conn)
        cls.tip = queries.tip_height(cls.conn)
        cls.txid = cls.conn.execute(
            "SELECT txid FROM txs WHERE is_coinbase=0 LIMIT 1").fetchone()["txid"]
        cls.bhash = cls.conn.execute(
            "SELECT hash FROM blocks WHERE height=5").fetchone()["hash"]

    def route(self, q):
        return search.route(self.conn, q, chain=CHAIN)

    def test_height(self):
        self.assertEqual(self.route("5")["target"], "/block/5")
        self.assertEqual(self.route(" 0 ")["target"], "/block/0")

    def test_height_out_of_range_is_not_found_with_the_range(self):
        r = self.route("99999999")
        self.assertEqual(r["kind"], "not_found")
        self.assertIn("0..%d" % self.tip, r["detail"])

    def test_txid_and_block_hash(self):
        self.assertEqual(self.route(self.txid)["target"], "/tx/%s" % self.txid)
        self.assertEqual(self.route(self.bhash)["target"], "/block/%s" % self.bhash)

    def test_uppercase_and_whitespace_and_0x(self):
        for variant in ("  %s  " % self.txid.upper(), "0x" + self.txid,
                        '"%s"' % self.txid):
            self.assertEqual(self.route(variant)["target"], "/tx/%s" % self.txid)

    def test_pasted_url(self):
        self.assertEqual(
            self.route("https://explorer.pc.am/tx/%s" % self.txid)["target"],
            "/tx/%s" % self.txid)
        self.assertEqual(self.route("/block/%s" % self.bhash)["target"],
                         "/block/%s" % self.bhash)

    def test_truncated_identifier(self):
        r = self.route(self.txid[:12])
        self.assertEqual(r["kind"], "tx")
        self.assertEqual(r["target"], "/tx/%s" % self.txid)

    def test_too_short_hex_is_refused_rather_than_guessed(self):
        r = self.route(self.txid[:4])
        self.assertEqual(r["kind"], "invalid")
        self.assertIn("too short", r["detail"])

    def test_address(self):
        r = self.route(MINER)
        self.assertEqual(r["kind"], "address")
        self.assertTrue(r["seen"])
        self.assertEqual(r["type"], "P2WPKH")

    def test_valid_unseen_address_still_routes(self):
        r = self.route(UNSEEN)
        self.assertEqual(r["kind"], "address")
        self.assertFalse(r["seen"])

    def test_bitcoin_address_is_named(self):
        for a, needle in (("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", "Bitcoin"),
                          ("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", "Bitcoin"),
                          ("3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy", "Bitcoin")):
            r = self.route(a)
            self.assertEqual(r["kind"], "invalid", a)
            self.assertIn(needle, r["detail"])

    def test_pcoin_address_from_another_pcoin_network(self):
        """PCoin's own networks must be told apart too, not just Bitcoin's."""
        r = self.route(address_n(4, hrp="pc"))
        self.assertEqual(r["kind"], "invalid")
        self.assertIn("PCoin mainnet address", r["detail"])
        self.assertIn("regtest", r["detail"])
        r = self.route(address_n(4, hrp="tpc"))
        self.assertEqual(r["kind"], "invalid")
        self.assertIn("test network", r["detail"])

    def test_typo_in_an_address_says_typo(self):
        broken = MINER[:-1] + ("q" if MINER[-1] != "q" else "p")
        r = self.route(broken)
        self.assertEqual(r["kind"], "invalid")
        self.assertIn("typo", r["detail"])

    def test_non_ascii_digits_are_not_heights(self):
        """`'²'.isdigit()` is True and `int('²')` raises, and `'٢'.isdigit()` is
        True and `int('٢')` is 2. A search box takes arbitrary text, so the
        height test has to be strict ASCII."""
        for weird in ("²", "٢", "½", "5²", "٢٠٠٠"):
            r = self.route(weird)
            self.assertIn(r["kind"], ("not_found", "invalid"), weird)

    def test_absurd_heights_do_not_crash(self):
        """A height beyond a 64-bit integer would raise OverflowError when
        bound as a SQLite parameter."""
        for big in ("9" * 40, str(2 ** 70)):
            self.assertEqual(self.route(big)["kind"], "not_found")
            status, _c, _b, _e = get(self.router, "/block/" + big)
            self.assertIn(status, (400, 404))
            status, _payload = get_json(self.router, "/api/block/" + big)
            self.assertIn(status, (400, 404))

    def test_garbage(self):
        self.assertEqual(self.route("hello world")["kind"], "not_found")
        self.assertEqual(self.route("")["kind"], "empty")
        self.assertEqual(self.route(None)["kind"], "empty")

    def test_search_endpoint_redirects(self):
        status, _c, _b, extra = get(self.router, "/search", "q=5")
        self.assertEqual(status, 302)
        self.assertEqual(extra["Location"], "/block/5")

    def test_search_endpoint_reports_failures(self):
        self.assertEqual(get(self.router, "/search", "q=hello")[0], 404)
        self.assertEqual(get(self.router, "/search", "q=")[0], 400)
        self.assertEqual(get(self.router, "/search",
                             "q=bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4")[0], 400)

    def test_never_routes_to_the_wrong_kind(self):
        """Exhaustive cross-check: every real identifier in the index routes to
        its own kind and nothing else."""
        for row in self.conn.execute("SELECT txid FROM txs"):
            r = self.route(row["txid"])
            self.assertEqual(r["kind"], "tx", row["txid"])
        for row in self.conn.execute("SELECT height, hash FROM blocks"):
            self.assertEqual(self.route(row["hash"])["kind"], "block")
            self.assertEqual(self.route(str(row["height"]))["kind"], "block")
        for row in self.conn.execute("SELECT address FROM addresses"):
            self.assertEqual(self.route(row["address"])["kind"], "address",
                             row["address"])


class EscapingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.chain, cls.conn, cls.idx = build_chain()
        cls.router = router_for(cls.conn)

    def test_hostile_search_input_is_escaped(self):
        """The payload is echoed back (into the search box and the heading), so
        what matters is that it comes back inert: no raw '<' or quote from user
        input ever reaches the markup."""
        payloads = ['<script>alert(1)</script>', '" onmouseover="alert(1)',
                    "'><img src=x onerror=alert(1)>", "</title><script>x</script>",
                    '"><style>body{display:none}</style>']
        for p in payloads:
            status, _c, body, _ = get(self.router, "/search",
                                      "q=" + p.replace("&", "%26"))
            self.assertIn(status, (400, 404))
            self.assertNotIn(p, body)            # never verbatim
            self.assertNotIn("<script", body.lower())
            self.assertNotIn("<img", body.lower())
            self.assertNotIn("<style", body.lower())
            # every character that could break out has been entity-escaped
            for ch in "<>\"'":
                if ch in p:
                    self.assertIn({"<": "&lt;", ">": "&gt;", '"': "&quot;",
                                   "'": "&#x27;"}[ch], body)

    def test_hostile_path_input_is_rejected(self):
        for p in ["/address/<script>", "/tx/<img src=x>", "/block/../../etc/passwd"]:
            status, _c, body, _ = get(self.router, p)
            self.assertIn(status, (400, 404))
            self.assertNotIn("<script", body.lower())

    def test_over_long_request_target_is_refused(self):
        status, _c, _b, _ = get(self.router, "/address/" + "a" * 5000)
        self.assertEqual(status, 414)

    def test_esc_covers_attributes(self):
        self.assertEqual(fmt.esc('a"b<c>&'), "a&quot;b&lt;c&gt;&amp;")


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.chain, cls.conn, cls.idx = build_chain(with_reorg=True)
        cls.router = router_for(cls.conn)
        cls.txid = cls.conn.execute(
            "SELECT txid FROM txs WHERE is_coinbase=0 LIMIT 1").fetchone()["txid"]

    def test_endpoints(self):
        for p in ["/api/status", "/api/chain", "/api/blocks", "/api/block/3",
                  "/api/txs", "/api/txs?payments=1", "/api/tx/%s" % self.txid,
                  "/api/address/%s" % MINER,
                  "/api/address/%s/history" % MINER,
                  "/api/address/%s/utxos" % MINER,
                  "/api/addresses", "/api/reorgs", "/api/search?q=3"]:
            path, _, query = p.partition("?")
            status, payload = get_json(self.router, path, query)
            self.assertEqual(status, 200, p)
            self.assertIsInstance(payload, dict)

    def test_no_floating_point_money_anywhere(self):
        """A float amount is a wrong answer that looks right. Every amount is
        either an integer of satoshis or a fixed-point string."""
        for p in ["/api/chain", "/api/blocks", "/api/tx/%s" % self.txid,
                  "/api/address/%s" % MINER, "/api/address/%s/utxos" % MINER,
                  "/api/addresses"]:
            _s, payload = get_json(self.router, p)
            self._assert_no_float_money(payload, p)

    def _assert_no_float_money(self, node, where):
        money_words = ("value", "balance", "fee", "received", "sent", "supply",
                       "subsidy", "immature", "spendable", "amount", "net")
        # A *rate* is a ratio, not an amount: fee_rate_sat_vb and difficulty are
        # legitimately floats and losing a bit of precision in them costs
        # nothing. An amount is what must never be a float.
        rate_keys = ("fee_rate_sat_vb", "difficulty", "hashrate")
        if isinstance(node, dict):
            for k, v in node.items():
                if isinstance(v, float) and k not in rate_keys:
                    self.assertFalse(any(w in k for w in money_words),
                                     "%s: %s is a float (%r)" % (where, k, v))
                self._assert_no_float_money(v, where)
        elif isinstance(node, list):
            for v in node:
                self._assert_no_float_money(v, where)

    def test_amounts_carry_both_forms(self):
        _s, payload = get_json(self.router, "/api/address/%s" % MINER)
        self.assertEqual(payload["balance_pcn"], from_sat(payload["balance"]))
        self.assertEqual(payload["immature_pcn"], from_sat(payload["immature"]))
        self.assertEqual(payload["spendable"],
                         payload["balance"] - payload["immature"])
        _s, chain = get_json(self.router, "/api/chain")
        self.assertEqual(chain["supply_pcn"], from_sat(chain["supply_sat"]))
        _s, tx = get_json(self.router, "/api/tx/%s" % self.txid)
        self.assertEqual(tx["fee_pcn"], from_sat(tx["fee"]))
        for o in tx["outputs"]:
            self.assertEqual(o["value_pcn"], from_sat(o["value"]))
        for i in tx["inputs"]:
            self.assertEqual(i["value_pcn"], from_sat(i["value"]))

    def test_every_amount_field_has_a_decimal_twin(self):
        """Whatever the field is called, if it is satoshis there is a `_pcn`
        string next to it. A client that only reads one form still gets an
        exact number."""
        for p in ["/api/chain", "/api/blocks", "/api/address/%s" % MINER,
                  "/api/address/%s/utxos" % MINER,
                  "/api/address/%s/history" % MINER, "/api/addresses"]:
            _s, payload = get_json(self.router, p)
            self._assert_twins(payload, p)

    def _assert_twins(self, node, where):
        named = ("value", "balance", "fee", "received", "sent", "subsidy",
                 "immature", "spendable", "total_fees", "coinbase_out",
                 "value_in", "value_out", "net")
        if isinstance(node, dict):
            for k, v in node.items():
                if k in named and isinstance(v, int) and not isinstance(v, bool):
                    self.assertIn(k + "_pcn", node, "%s: %s has no _pcn twin"
                                  % (where, k))
                    self.assertEqual(node[k + "_pcn"], from_sat(v))
                self._assert_twins(v, where)
        elif isinstance(node, list):
            for v in node:
                self._assert_twins(v, where)

    def test_health_travels_with_every_balance(self):
        for p in ["/api/chain", "/api/address/%s" % MINER,
                  "/api/tx/%s" % self.txid, "/api/blocks", "/api/addresses"]:
            _s, payload = get_json(self.router, p)
            self.assertIn("health", payload, p)
            self.assertIn("stale", payload["health"])

    def test_missing_things_are_404_json(self):
        s, payload = get_json(self.router, "/api/tx/" + "ef" * 32)
        self.assertEqual(s, 404)
        self.assertIn("error", payload)
        s, payload = get_json(self.router, "/api/block/999999")
        self.assertEqual(s, 404)
        s, payload = get_json(self.router, "/api/nope")
        self.assertEqual(s, 404)

    def test_page_size_is_clamped(self):
        _s, payload = get_json(self.router, "/api/blocks", "limit=100000")
        self.assertLessEqual(payload["per_page"], api.MAX_PAGE_SIZE)
        _s, payload = get_json(self.router, "/api/blocks", "limit=-3&page=-9")
        self.assertGreaterEqual(payload["per_page"], 1)
        self.assertEqual(payload["page"], 1)
        _s, payload = get_json(self.router, "/api/blocks", "limit=abc&page=xyz")
        self.assertEqual(payload["page"], 1)

    def test_search_api_mirrors_the_box(self):
        s, payload = get_json(self.router, "/api/search", "q=%s" % MINER)
        self.assertEqual(s, 200)
        self.assertEqual(payload["kind"], "address")
        self.assertEqual(payload["url"], "/address/%s" % MINER)
        s, payload = get_json(self.router, "/api/search", "q=zzz")
        self.assertEqual(s, 404)


class AddressDecodingTests(unittest.TestCase):
    def test_pcoin_bech32_round_trip(self):
        a = p2wpkh(b"\x01" * 20)
        self.assertTrue(a.startswith("pc1q"))
        self.assertEqual(addr.classify(a), "P2WPKH")
        self.assertEqual(addr.classify(p2wpkh(b"\x02" * 20)), "P2WPKH")

    def test_witness_versions(self):
        self.assertEqual(addr.classify(p2tr(b"\x03" * 32)), "P2TR")
        from .bech32enc import p2wsh
        self.assertEqual(addr.classify(p2wsh(b"\x04" * 32)), "P2WSH")

    def test_bech32m_and_bech32_are_not_interchangeable(self):
        """A v0 program encoded with the bech32m constant is invalid, and a v1
        program encoded with the bech32 constant is too. Accepting either would
        make two different strings look like the same address."""
        from .bech32enc import bech32_encode
        from pcoin_explorer.addr import _convertbits
        v0_wrong = bech32_encode("pc", [0] + _convertbits(list(b"\x05" * 20), 8, 5),
                                 "bech32m")
        v1_wrong = bech32_encode("pc", [1] + _convertbits(list(b"\x06" * 32), 8, 5),
                                 "bech32")
        self.assertIsNone(addr.classify(v0_wrong))
        self.assertIsNone(addr.classify(v1_wrong))

    def test_single_character_change_is_rejected(self):
        a = p2wpkh(b"\x07" * 20)
        for i in range(4, len(a)):
            other = "q" if a[i] != "q" else "p"
            broken = a[:i] + other + a[i + 1:]
            self.assertIsNone(addr.classify(broken), broken)

    def test_mixed_case_is_rejected(self):
        a = p2wpkh(b"\x08" * 20)
        mixed = a[:6].upper() + a[6:]
        self.assertIsNone(addr.bech32_decode(mixed))

    def test_case_insensitive_whole_string(self):
        a = p2wpkh(b"\x09" * 20)
        self.assertEqual(addr.canonicalise(a.upper()), a)
        self.assertEqual(addr.canonicalise(a), a)

    def test_base58_versions_are_pcoins(self):
        """PCoin uses 55/56, not Bitcoin's 0/5. Getting this wrong would accept
        a Bitcoin address as a PCoin one, and PCoin already shares Bitcoin's
        BIP32 version bytes."""
        import hashlib
        def b58check(version, payload):
            body = bytes([version]) + payload
            chk = hashlib.sha256(hashlib.sha256(body).digest()).digest()[:4]
            n = int.from_bytes(body + chk, "big")
            alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
            out = ""
            while n:
                n, r = divmod(n, 58)
                out = alphabet[r] + out
            return "1" * len(body + chk) * 0 + out
        self.assertEqual(addr.classify(b58check(55, b"\x11" * 20)), "P2PKH")
        self.assertEqual(addr.classify(b58check(56, b"\x11" * 20)), "P2SH")
        self.assertIsNone(addr.classify(b58check(0, b"\x11" * 20)))
        self.assertIsNone(addr.classify(b58check(5, b"\x11" * 20)))
        self.assertEqual(addr.classify(b58check(117, b"\x11" * 20), "test"), "P2PKH")

    def test_chain_specific_hrp(self):
        self.assertEqual(addr.classify(address_n(1, hrp="tpc"), "test"), "P2WPKH")
        self.assertIsNone(addr.classify(address_n(1, hrp="tpc"), "main"))
        self.assertEqual(addr.classify(address_n(1, hrp="pcrt"), "regtest"), "P2WPKH")

    def test_foreign_hint(self):
        self.assertIn("Bitcoin", addr.foreign_hint(
            "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"))
        self.assertIsNone(addr.foreign_hint(p2wpkh(b"\x0a" * 20)))


class MetricTests(unittest.TestCase):
    """The pace and hashrate numbers, which are the ones most easily made to lie."""

    def _chain_with_two_eras(self):
        """Fast blocks then slow blocks -- the shape of the real chain, where
        heights 0..2015 ran ~49 s apart and everything since runs ~1000 s
        apart."""
        chain = FakeChain()
        t = chain.blocks[chain.tip]["time"]
        for _ in range(160):
            t += 50
            chain.mine(miner=MINER, time_=t)
        for _ in range(120):
            t += 1200
            chain.mine(miner=MINER, time_=t)
        conn, idx = make_indexer(FakeRpc(chain))
        idx.sync()
        return conn

    def test_recent_window_is_not_contaminated_by_the_fast_era(self):
        conn = self._chain_with_two_eras()
        tip = queries.tip_height(conn)
        p = reads.pace(conn, tip)
        self.assertLessEqual(p["recent"]["window"], reads.RECENT_WINDOW)
        self.assertAlmostEqual(p["recent"]["seconds"], 1200, delta=60)
        # A long window would report the chain as faster than target, which is
        # the opposite of the truth.
        long_window = reads.spacing(conn, tip, 280)
        self.assertLess(long_window["seconds"], p["recent"]["seconds"])

    def test_all_time_is_reported_but_not_used_as_the_headline(self):
        conn = self._chain_with_two_eras()
        tip = queries.tip_height(conn)
        p = reads.pace(conn, tip)
        self.assertIn("all_time", p)
        self.assertNotEqual(p["all_time"]["seconds"], p["recent"]["seconds"])

    def test_home_page_says_slower_when_it_is_slower(self):
        conn = self._chain_with_two_eras()
        _s, _c, body, _ = get(router_for(conn), "/")
        self.assertIn("slower</b> than target", body)

    def test_hashrate_is_none_rather_than_zero_without_a_span(self):
        """Block timestamps are not monotonic in height on this chain, so the
        span over a window can be zero. That is an unknown, not a zero."""
        chain = FakeChain()
        t = chain.blocks[chain.tip]["time"]
        for _ in range(5):
            chain.mine(miner=MINER, time_=t)      # every block the same second
        conn, idx = make_indexer(FakeRpc(chain))
        idx.sync()
        self.assertIsNone(reads.hashrate_estimate(conn, queries.tip_height(conn), 4))
        self.assertIsNone(reads.spacing(conn, queries.tip_height(conn), 4))
        _s, _c, body, _ = get(router_for(conn), "/")
        self.assertIn("not enough timestamp span", body)

    def test_lwma_countdown(self):
        conn = self._chain_with_two_eras()
        tip = queries.tip_height(conn)
        st = reads.lwma_status(conn, "main", tip)
        self.assertEqual(st["height"], 2800)
        self.assertFalse(st["active"])
        self.assertEqual(st["blocks_remaining"], 2800 - tip)
        self.assertGreater(st["eta_seconds"], 0)
        self.assertIsNone(reads.lwma_status(conn, "regtest", tip)["height"])
        self.assertTrue(reads.lwma_status(conn, "test", tip)["active"])

    def test_maturity_is_counted_in_blocks(self):
        conn = self._chain_with_two_eras()
        tip = queries.tip_height(conn)
        m = reads.maturity_eta(conn, tip, tip + 40)
        self.assertEqual(m["blocks"], 39)
        self.assertFalse(m["mature"])
        self.assertTrue(reads.maturity_eta(conn, tip, tip - 5)["mature"])


class FormattingTests(unittest.TestCase):
    def test_amounts_are_exact(self):
        self.assertEqual(fmt.pcn(5_000_000_000), "50.00000000")
        self.assertEqual(fmt.pcn(1), "0.00000001")
        self.assertEqual(fmt.pcn(-1), "-0.00000001")
        self.assertEqual(fmt.pcn(10_625_000_000_000, group=True), "106,250.00000000")

    def test_amount_html_is_copyable(self):
        html = fmt.amount_html(5_000_000_001, unit=False)
        text = html.replace("</span>", "").replace('<span class="amt-f">', "")
        self.assertIn("50.00000001", text)

    def test_unknown_renders_as_a_dash(self):
        self.assertEqual(fmt.maybe(None), fmt.DASH)
        self.assertEqual(fmt.num(None), fmt.DASH)
        self.assertIn(fmt.DASH, fmt.amount_html(None))
        self.assertEqual(fmt.hashrate(None), fmt.DASH)
        self.assertEqual(fmt.iso(None), fmt.DASH)

    def test_future_timestamps_are_not_clamped(self):
        """A header may legitimately be stamped ahead of the wall clock."""
        now = 1_000_000
        self.assertIn("in ", fmt.ago(now + 300, now))
        self.assertIn("ago", fmt.ago(now - 300, now))
        self.assertEqual(fmt.ago(now, now), "just now")

    def test_durations(self):
        self.assertEqual(fmt.duration(600), "10 min")
        self.assertEqual(fmt.duration(1065), "17 min 45 s")
        self.assertEqual(fmt.duration(86400 * 8 + 3600 * 6), "8 d 6 h")
        self.assertEqual(fmt.duration(0), "0 s")

    def test_hashrate_units(self):
        self.assertIn("H/s", fmt.hashrate(900))
        self.assertIn("kH/s", fmt.hashrate(1242))
        self.assertIn("MH/s", fmt.hashrate(3.4e6))

    def test_shorten_keeps_both_ends(self):
        s = "a" * 20 + "b" * 20
        out = fmt.shorten(s)
        self.assertTrue(out.startswith("a" * 10))
        self.assertTrue(out.endswith("b" * 8))


class StubApi:
    """Stands in for ``pcoin_api.ApiApplication``: the same call signature and
    nothing else. The tests must not depend on that package's internals, which
    are developed separately."""

    cors_origin = "https://wallet.example"

    def __init__(self, *, boom=False):
        self.calls = []
        self.boom = boom

    def handle(self, method, path, query, body, client):
        self.calls.append((method, path, dict(query), body, client))
        if self.boom:
            raise RuntimeError("the API blew up")
        return 200, {"mounted": True, "method": method, "path": path,
                     "query": query, "body_len": len(body)}


class MountedApiTests(unittest.TestCase):
    """The UI and a full API in one process on one port."""

    def setUp(self):
        self.chain, self.conn, self.idx = build_chain()
        self.stub = StubApi()
        self.router = server.Router(StubStore(self.conn), api_app=self.stub)

    def test_api_paths_are_delegated(self):
        status, payload = get_json(self.router, "/api/address/%s" % MINER,
                                   "history=true&limit=5")
        self.assertEqual(status, 200)
        self.assertTrue(payload["mounted"])
        self.assertEqual(payload["query"], {"history": "true", "limit": "5"})
        self.assertEqual(self.stub.calls[0][1], "/api/address/%s" % MINER)

    def test_repeated_parameters_flatten_the_same_way(self):
        """Last value wins, matching the mounted application's own handler, so
        a request means the same thing whichever server receives it."""
        _s, payload = get_json(self.router, "/api/blocks", "limit=1&limit=9")
        self.assertEqual(payload["query"]["limit"], "9")

    def test_pages_still_work_alongside(self):
        for p in ["/", "/blocks", "/address/%s" % MINER]:
            self.assertEqual(get(self.router, p)[0], 200)
        self.assertEqual(len(self.stub.calls), 0)

    def test_post_reaches_the_mounted_api(self):
        status, _ctype, payload, _extra = self.router.handle(
            "/api/tx", "", method="POST", body=b'{"hex":"00"}', client="1.2.3.4")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(payload)["method"], "POST")
        method, path, _q, body, client = self.stub.calls[0]
        self.assertEqual((method, path), ("POST", "/api/tx"))
        self.assertEqual(body, b'{"hex":"00"}')
        self.assertEqual(client, "1.2.3.4")

    def test_post_is_refused_when_nothing_is_mounted(self):
        """With no API mounted the process has no write surface at all, and a
        POST must be refused rather than quietly treated as a GET."""
        plain = router_for(self.conn)
        status, _ctype, _payload, _extra = plain.handle(
            "/api/tx", "", method="POST", body=b"{}")
        self.assertEqual(status, 405)
        status, _c, _p, _e = plain.handle("/address/%s" % MINER, "",
                                          method="POST")
        self.assertEqual(status, 405)

    def test_the_mounted_cors_origin_is_honoured(self):
        _s, _c, _b, extra = get(self.router, "/api/status")
        self.assertEqual(extra["Access-Control-Allow-Origin"],
                         "https://wallet.example")

    def test_a_failing_api_is_502_not_an_empty_answer(self):
        router = server.Router(StubStore(self.conn), api_app=StubApi(boom=True))
        with contextlib.redirect_stderr(io.StringIO()) as log:
            status, payload = get_json(router, "/api/status")
        self.assertEqual(status, 502)
        self.assertEqual(payload["error"]["code"], "api_failed")
        self.assertIn("RuntimeError", log.getvalue())   # and it is logged

    def test_body_limits_exist(self):
        self.assertLessEqual(server.MAX_BODY, 10_000_000)


class SnapshotIsolationTests(unittest.TestCase):
    def test_a_request_runs_in_one_transaction(self):
        """Without a snapshot a page could read the tip, then balances written
        by a reorg that landed in between, and render a mixture of two chain
        states."""
        chain, conn, idx = build_chain()
        router = router_for(conn)
        seen = []
        conn.set_trace_callback(lambda sql: seen.append(sql.strip().split()[0].upper()))
        try:
            get(router, "/")
        finally:
            conn.set_trace_callback(None)
        self.assertEqual(seen[0], "BEGIN")
        self.assertEqual(seen[-1], "ROLLBACK")
        self.assertNotIn("COMMIT", seen)
        self.assertEqual(seen.count("BEGIN"), 1)
        self.assertFalse(conn.in_transaction)

    def test_the_transaction_is_closed_even_when_a_page_fails(self):
        """A leaked read transaction would pin the WAL and stop the indexer
        from checkpointing, so the ROLLBACK is in a finally."""
        chain, conn, idx = build_chain()
        router = router_for(conn)
        original = views.home

        def boom(_ctx):
            raise RuntimeError("kaboom")

        views.home = boom
        try:
            with self.assertRaises(RuntimeError):
                get(router, "/")
        finally:
            views.home = original
        self.assertFalse(conn.in_transaction)


if __name__ == "__main__":
    unittest.main()
