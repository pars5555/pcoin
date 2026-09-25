#!/usr/bin/env python3
"""Purchase posts and the listing banner's count -- the root side, without a
network, a database or Telegram.

    python purchase-posts-test.py

Covers the three programs changed on 2026-09-25 (owner: "Purchase posts - on,
it should automatically grow the pinned message ... every purchase in exchange
should be reported if user withdrawal the pcn"):

  pcoin-listing-banner     reads the exchange's purchases from /api/payouts,
                           never counts down, never publishes a short total;
  pcoin-purchase-announce  drains the market's spool as root, trusts nothing in
                           it but an order id, renders the text itself;
  pcoin-payout-announce    thanks a PURCHASE payout with the banner's N, and
                           holds rather than downgrades when N is unreadable.

Runs on Windows too (the POSIX-only directory-handle path in the drainer is the
one piece it cannot reach; its pure checks are tested directly).
"""
import importlib.machinery
import importlib.util
import io
import json
import os
import shutil
import stat
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stdout, redirect_stderr

HERE = os.path.dirname(os.path.abspath(__file__))
SEED = os.path.join(os.path.dirname(HERE), "seed-monitoring")


def load(name, path, env=None):
    old_env = {}
    for k, v in (env or {}).items():
        old_env[k] = os.environ.get(k)
        os.environ[k] = v
    spec = importlib.util.spec_from_loader(name, importlib.machinery.SourceFileLoader(name, path))
    m = importlib.util.module_from_spec(spec)
    argv, sys.argv = sys.argv, [path]
    try:
        spec.loader.exec_module(m)
    finally:
        sys.argv = argv
        for k, v in old_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
    return m


def feed(purchases=2, usd="50.000000", minimum="20.000000", payouts=None, **extra):
    t = {"count": 6, "usdSent": "45.540000", "pcnSent": "7200.00000000",
         "purchases": purchases, "purchasesUsd": usd, "purchaseMinUsd": minimum}
    t.update(extra)
    return {"payouts": payouts or [], "total": t}


class Quiet:
    """Swallow the scripts' own log lines so the test output stays readable."""
    def __enter__(self):
        self.out, self.err = io.StringIO(), io.StringIO()
        self._o, self._e = redirect_stdout(self.out), redirect_stderr(self.err)
        self._o.__enter__(); self._e.__enter__()
        return self

    def __exit__(self, *a):
        self._e.__exit__(*a); self._o.__exit__(*a)
        return False


# ═══════════════════════════════════════════════════════════════ the banner ═══
class Banner(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="banner-")
        self.lb = load("lb", os.path.join(HERE, "pcoin-listing-banner"), {
            "BANNER_STATE_DIR": self.dir, "BANNER_CHAT_ID": "-100test", "BANNER_MIN_USD": "20",
            "BANNER_EXCHANGE_URL": "https://exchange.example/api/payouts?limit=1"})

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_feed_read(self):
        self.assertEqual(self.lb.parse_exchange_feed(feed()), (2, 50.0))

    def test_feed_contract_breaks_are_contract_faults(self):
        U = self.lb.Unreadable
        for bad in ({"payouts": [], "total": {"count": 3}},            # exchange on the old code
                    feed(purchases=-1), feed(purchases=True), feed(purchases="2"),
                    feed(usd="-1"), feed(usd="x"), "not an object"):
            with self.assertRaises(U) as c:
                self.lb.parse_exchange_feed(bad)
            self.assertTrue(c.exception.contract, bad)

    def test_a_different_threshold_is_refused_never_mixed(self):
        with self.assertRaises(self.lb.Unreadable) as c:
            self.lb.parse_exchange_feed(feed(minimum="10.000000"))
        self.assertTrue(c.exception.contract)
        self.assertIn("two different kinds", c.exception.reason)

    def test_unreadable_is_the_last_figure_never_zero(self):
        lb = self.lb
        st = lb.load_state()
        lb.remember_exchange(st, 5, 150.0)

        def down():
            raise lb.Unreadable("exchange.pc.am unreadable (URLError)")
        lb.read_exchange = down
        with Quiet():
            self.assertEqual(lb.exchange_figures(st), (5, 150.0, False, None))
        # Never read under THIS url: refuse, do not guess.
        with self.assertRaises(lb.Unreadable) as c:
            lb.exchange_figures(lb.load_state())
        self.assertFalse(c.exception.contract)
        # A figure remembered from another URL (the old per-fill endpoint) is not ours.
        st2 = lb.load_state()
        st2["exchange"] = {"url": "https://exchange.pc.am/api/listing-purchases", "purchases": 9, "usd": 1.0}
        with self.assertRaises(lb.Unreadable):
            lb.exchange_figures(st2)

    def test_contract_fault_keeps_the_number_and_reports_the_fault(self):
        lb = self.lb
        st = lb.load_state()
        lb.remember_exchange(st, 5, 150.0)
        with Quiet():
            c, u, fresh, fault = lb.exchange_figures(st, {"payouts": [], "total": {"count": 1}})
        self.assertEqual((c, u, fresh), (5, 150.0, False))
        self.assertIn("total.purchases", fault)

    def test_post_number_is_the_bar_never_less(self):
        lb = self.lb
        lb.market_figures = lambda: (16, 1219.49, "2026-09-25")
        self.assertEqual(lb.post_number(feed(purchases=2)), 18)
        lb.save_state(dict(lb.load_state(), last_count=20, chat_id="-100test"))
        self.assertEqual(lb.post_number(feed(purchases=2)), 20)      # the bar says 20: so does the post
        self.assertEqual(lb.post_number(feed(purchases=7)), 23)      # and it moves up with the truth

    def test_post_number_raises_rather_than_guessing(self):
        lb = self.lb

        def db_down():
            raise lb.Unreadable("mysql did not answer within 30 s")
        lb.market_figures = db_down
        with self.assertRaises(lb.Unreadable):
            lb.post_number(feed())

    def _main(self, market, ex, dry=False, state=None):
        """Run main() with every outside call stubbed. Telegram must never be
        reached on the paths tested here, so read_token() fails the test."""
        lb = self.lb
        lb.DRY_RUN = dry
        lb.take_lock = lambda: None
        lb.count_orders = lambda: market
        lb.exchange_figures = lambda st, feed=None: ex
        lb.read_token = lambda: self.fail("Telegram was reached")
        if state:
            lb.save_state(dict(lb.load_state(), **state))
        return lb

    def test_main_refuses_a_smaller_number_before_touching_telegram(self):
        lb = self._main((14, 1100.0, ""), (1, 20.0, True, None),
                        state={"chat_id": "-100test", "message_id": 67, "last_count": 16, "last_usd": 1219.49})
        with Quiet() as q, self.assertRaises(SystemExit) as c:
            lb.main()
        self.assertEqual(c.exception.code, 1)
        self.assertIn("REFUSING to publish 15", q.err.getvalue())
        # The fresh exchange reading is still remembered; the published figures are not touched.
        st = lb.load_state()
        self.assertEqual(st["last_count"], 16)
        self.assertEqual(st["exchange"]["purchases"], 1)

    def test_main_dry_run_says_it_would_refuse(self):
        lb = self._main((14, 1100.0, ""), (1, 20.0, True, None), dry=True,
                        state={"chat_id": "-100test", "last_count": 16})
        with Quiet() as q:
            self.assertEqual(lb.main(), 0)
        self.assertIn("REFUSING", q.out.getvalue())

    def test_main_never_publishes_a_short_total(self):
        lb = self.lb
        lb.DRY_RUN = False
        lb.take_lock = lambda: None
        lb.count_orders = lambda: (16, 1219.49, "")

        def never_read(st, feed=None):
            raise lb.Unreadable("exchange.pc.am unreadable (URLError), and no earlier figure")
        lb.exchange_figures = never_read
        lb.read_token = lambda: self.fail("Telegram was reached")
        with Quiet(), self.assertRaises(SystemExit) as c:
            lb.main()
        self.assertEqual(c.exception.code, 0)        # weather: quiet, as it always was

    def test_widget_copy_says_the_exchange_counts_once_withdrawn(self):
        t = self.lb.widget_text(18, 1269.49, 1000, "2026-09-25 13:00")
        self.assertTrue(t.startswith("▰"))                   # the bar still comes first
        self.assertIn("<b>18</b> / 1,000 purchases", t)
        self.assertIn("once the PCN is withdrawn to your own wallet", t)
        # pcoin-discord-banner swaps exactly this substring; it must survive.
        self.assertIn('<a href="https://t.me/PCoinPCNChat">Questions? Ask in the chat</a>', t)


# ════════════════════════════════════════════════════════════════ the drainer ═══
class FakeLB:
    MIN_USD = 20.0

    class Unreadable(Exception):
        def __init__(self, reason, contract=False):
            super().__init__(reason)
            self.reason, self.contract = reason, contract

    def __init__(self, orders, n=18, db_down=False, n_down=False):
        self.orders, self.n, self.db_down, self.n_down = orders, n, db_down, n_down
        self.queries = []

    def market_query(self, sql):
        self.queries.append(sql)
        if self.db_down:
            raise self.Unreadable("mysql did not answer within 30 s")
        oid = sql.split("'")[1]
        o = self.orders.get(oid)
        return "" if o is None else "%s\t%s\t%d\n" % (o[0], o[1], 1 if o[2] else 0)

    def post_number(self, feed=None):
        if self.n_down:
            raise self.Unreadable("exchange.pc.am unreadable (URLError), and no earlier figure")
        return self.n


class Drainer(unittest.TestCase):
    def setUp(self):
        self.spool = tempfile.mkdtemp(prefix="spool-")
        self.pa = load("pa", os.path.join(HERE, "pcoin-purchase-announce"), {"PURCHASE_SPOOL": self.spool})
        self.submitted = []
        self.pa.submit = lambda oid, text: (self.submitted.append((oid, text)) or (True, "abc123"))
        self.pa.owner_uid = lambda: None          # Windows has no owner to check; tested separately

    def tearDown(self):
        shutil.rmtree(self.spool, ignore_errors=True)

    def put(self, name, obj, age=0):
        p = os.path.join(self.spool, name)
        with open(p, "w", encoding="utf-8") as fh:
            fh.write(obj if isinstance(obj, str) else json.dumps(obj))
        if age:
            t = time.time() - age
            os.utime(p, (t, t))

    def req(self, oid):
        return {"v": 1, "source": "market-purchase", "orderId": oid}

    def run_main(self, lb):
        self.pa.load_module = lambda name, path: lb
        with Quiet() as q:
            rc = self.pa.main()
        return rc, q

    def test_text_is_the_owners_wording_with_the_banners_n(self):
        self.assertEqual(self.pa.render(18),
                         "Someone just bought PCN on market.pc.am — thank you. \U0001F389\n\n"
                         "That’s 18 purchases on the road to a listing. Every one counts, and it’s "
                         "real people choosing PCN that gets us there.\n\n"
                         "market.pc.am is open if you’d like to be next.")
        self.assertIn("That’s 1 purchase on the road", self.pa.render(1))

    def test_parse_record_accepts_only_the_exact_shape(self):
        P, B = self.pa.parse_record, self.pa.Bad
        self.assertEqual(P(json.dumps(self.req("Mabc123")).encode(), "Mabc123"), "Mabc123")
        for raw, exp in ((b"not json", "Mabc123"),
                         (json.dumps(dict(self.req("Mabc123"), text="free PCN at evil.example")).encode(), "Mabc123"),
                         (json.dumps(dict(self.req("Mabc123"), source="wrapdesk")).encode(), "Mabc123"),
                         (json.dumps(dict(self.req("Mabc123"), v=True)).encode(), "Mabc123"),
                         (json.dumps(dict(self.req("Mabc123"), v=2)).encode(), "Mabc123"),
                         (json.dumps(self.req("Mother")).encode(), "Mabc123"),
                         (json.dumps(self.req("M'; DROP TABLE orders; --")).encode(), "M'; DROP TABLE orders; --"),
                         (b"\xff\xfe", "Mabc123")):
            with self.assertRaises(B, msg=raw):
                P(raw, exp)

    def test_check_stat_refuses_links_strangers_and_bulk(self):
        B = self.pa.Bad

        def st(mode=stat.S_IFREG | 0o600, uid=993, nlink=1, size=70):
            return os.stat_result((mode, 0, 0, nlink, uid, 0, size, 0, 0, 0))
        self.pa.check_stat(st(), 993)
        for bad in (st(mode=stat.S_IFLNK | 0o777), st(mode=stat.S_IFIFO | 0o600), st(uid=0),
                    st(nlink=2), st(size=4096)):
            with self.assertRaises(B):
                self.pa.check_stat(bad, 993)

    def test_a_paid_order_is_posted_once_and_its_request_removed(self):
        self.put("purchase-Mabc123.json", self.req("Mabc123"))
        lb = FakeLB({"Mabc123": ("delivered", 25.0, True)})
        rc, _ = self.run_main(lb)
        self.assertEqual(rc, 0)
        self.assertEqual([o for o, _ in self.submitted], ["Mabc123"])
        self.assertIn("That’s 18 purchases", self.submitted[0][1])
        self.assertEqual(os.listdir(self.spool), [])
        self.assertIn("order_id = 'Mabc123'", lb.queries[0])

    def test_orders_that_do_not_count_are_dropped_without_a_post(self):
        for oid in ("Mreview", "Msmall", "Munpaid", "Mnone", "Mtest"):
            self.put("purchase-%s.json" % oid, self.req(oid))
        lb = FakeLB({"Mreview": ("needs_review", 50.0, True), "Msmall": ("delivered", 19.99, True),
                     "Munpaid": ("pending", 50.0, False), "Mtest": ("test_completed", 50.0, True)})
        self.pa.MAX_PER_RUN = 10
        rc, _ = self.run_main(lb)
        self.assertEqual(rc, 0)
        self.assertEqual(self.submitted, [])
        self.assertEqual(os.listdir(self.spool), [])

    def test_database_down_holds_the_request_and_fails_the_run(self):
        self.put("purchase-Mabc123.json", self.req("Mabc123"))
        rc, q = self.run_main(FakeLB({}, db_down=True))
        self.assertEqual(rc, 1)
        self.assertEqual(self.submitted, [])
        self.assertEqual(os.listdir(self.spool), ["purchase-Mabc123.json"])
        self.assertIn("could not be read", q.err.getvalue())

    def test_unreadable_count_holds_quietly_then_loudly(self):
        self.put("purchase-Mabc123.json", self.req("Mabc123"))
        orders = {"Mabc123": ("delivered", 25.0, True)}
        rc, _ = self.run_main(FakeLB(orders, n_down=True))
        self.assertEqual((rc, self.submitted), (0, []))            # fresh: wait for the next minute
        self.put("purchase-Mabc123.json", self.req("Mabc123"), age=3600)
        rc, q = self.run_main(FakeLB(orders, n_down=True))
        self.assertEqual(rc, 1)                                    # an hour: ops must hear
        self.assertEqual(os.listdir(self.spool), ["purchase-Mabc123.json"])

    def test_a_refused_submit_keeps_the_request_and_fails_the_run(self):
        self.put("purchase-Mabc123.json", self.req("Mabc123"))
        self.pa.submit = lambda oid, text: (False, "REFUSED: 12 items already awaiting approval")
        rc, q = self.run_main(FakeLB({"Mabc123": ("delivered", 25.0, True)}))
        self.assertEqual(rc, 1)
        self.assertEqual(os.listdir(self.spool), ["purchase-Mabc123.json"])
        self.assertIn("REFUSED", q.err.getvalue())

    def test_junk_in_the_spool_is_removed_never_posted_and_reported(self):
        self.put("purchase-Mabc123.json", dict(self.req("Mabc123"), text="anything at all"))
        self.put("purchase-Mother1.json", self.req("Mdifferent"))
        self.put("notes.txt", "hello")
        self.put(".purchase-Mx.1234.tmp", "half-written")            # the market mid-write: left alone
        rc, q = self.run_main(FakeLB({"Mabc123": ("delivered", 25.0, True)}))
        self.assertEqual(rc, 1)
        self.assertEqual(self.submitted, [])
        self.assertEqual(os.listdir(self.spool), [".purchase-Mx.1234.tmp"])
        self.assertNotIn("anything at all", q.out.getvalue() + q.err.getvalue())   # spool text is never echoed

    def test_at_most_max_per_run_and_one_n_per_run(self):
        for i in range(5):
            self.put("purchase-Mo%d.json" % i, self.req("Mo%d" % i), age=100 - i)
        lb = FakeLB({"Mo%d" % i: ("delivered", 30.0, True) for i in range(5)})
        rc, _ = self.run_main(lb)
        self.assertEqual(rc, 0)
        self.assertEqual([o for o, _ in self.submitted], ["Mo0", "Mo1", "Mo2"])   # oldest first
        self.assertEqual(len(os.listdir(self.spool)), 2)

    def test_dry_run_and_status_touch_nothing(self):
        self.put("purchase-Mabc123.json", self.req("Mabc123"))
        self.put("junk", "x")
        for flag in ("--dry-run", "--status"):
            pa = load("pa2", os.path.join(HERE, "pcoin-purchase-announce"), {"PURCHASE_SPOOL": self.spool})
            pa.owner_uid = lambda: None
            pa.submit = lambda oid, text: self.fail("submitted under %s" % flag)
            pa.load_module = lambda name, path: FakeLB({"Mabc123": ("delivered", 25.0, True)})
            pa.DRY = flag == "--dry-run"
            pa.TOUCH_NOTHING = True
            argv, sys.argv = sys.argv, ["x", flag]
            try:
                with Quiet():
                    pa.main()
            finally:
                sys.argv = argv
            self.assertEqual(sorted(os.listdir(self.spool)), ["junk", "purchase-Mabc123.json"])

    def test_only_private_test_destinations_may_replace_the_channel(self):
        pa = load("pa3", os.path.join(HERE, "pcoin-purchase-announce"),
                  {"PURCHASE_SPOOL": self.spool, "PURCHASE_ANNOUNCE_DEST": "group"})
        with self.assertRaises(SystemExit):
            pa.main()

    def test_no_spool_is_nothing_to_do(self):
        pa = load("pa4", os.path.join(HERE, "pcoin-purchase-announce"),
                  {"PURCHASE_SPOOL": os.path.join(self.spool, "absent")})
        pa.owner_uid = lambda: None
        with Quiet() as q:
            self.assertEqual(pa.main(), 0)
        self.assertIn("StateDirectory", q.out.getvalue())


# ════════════════════════════════════════════════════════ the payout announcer ═══
class FakeRun:
    def __init__(self, rc=0):
        self.calls, self.rc = [], rc

    def run(self, argv, **kw):
        self.calls.append(argv)

        class R:
            pass
        r = R()
        r.returncode, r.stdout, r.stderr = self.rc, "id1", ""
        return r


class PayoutAnnounce(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="payout-")
        self.state = os.path.join(self.dir, "state.json")
        with open(self.state, "w") as fh:
            json.dump({"announced": ["1"], "started": True}, fh)
        self.po = load("po", os.path.join(SEED, "pcoin-payout-announce.py"),
                       {"PAYOUT_ANNOUNCE_STATE": self.state, "PAYOUT_ANNOUNCE_TXID": "1"})
        self.fake = FakeRun()
        self.po.subprocess = self.fake

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def p(self, id, asset="PCN", purchase=None, sent="1708.00000000"):
        d = {"id": str(id), "asset": asset, "network": "PCN" if asset == "PCN" else "BEP20", "sent": sent,
             "requestedAt": 1, "paidAt": 2, "waitedSeconds": 9174, "txid": "ab" * 32}
        if purchase is not None:
            d["purchase"] = purchase
        return d

    def run_with(self, payouts, number=(18, None)):
        f = feed(payouts=payouts)
        self.po.read_feed = lambda: f
        self.po.banner_number = lambda feed_: number
        with Quiet() as q:
            rc = self.po.main()
        return rc, q

    def texts(self):
        return {c[c.index("--key") + 1]: c[c.index("--text") + 1] for c in self.fake.calls}

    def test_a_purchase_payout_gets_the_purchase_text_with_the_banners_n(self):
        rc, _ = self.run_with([self.p(2, purchase=True)])
        self.assertEqual(rc, 0)
        t = self.texts()["payout-2"]                          # the dedupe key is unchanged
        self.assertTrue(t.startswith("Someone bought PCN on exchange.pc.am and took it to their own wallet "
                                     "— thank you. \U0001F389"))
        self.assertIn("That’s 18 purchases on the road to a listing.", t)
        self.assertIn("https://explorer.pc.am/tx/" + "ab" * 32, t)
        self.assertNotIn("Paid out", t)
        self.assertIn("--source", self.fake.calls[0])
        # Owner 2026-09-25: purchase posts publish without review.
        self.assertEqual(self.fake.calls[0][self.fake.calls[0].index("--source") + 1], "exchange-purchase")

    def test_other_payouts_keep_todays_text(self):
        rc, _ = self.run_with([self.p(2, purchase=False), self.p(3, asset="USD", sent="45.540000"),
                               self.p(4)])                    # a PCN payout from an old feed: no field
        self.assertEqual(rc, 0)
        t = self.texts()
        self.assertIn("Somebody took PCN out of exchange.pc.am to their own wallet.", t["payout-2"])
        self.assertIn("Somebody mined PCN, sold it on exchange.pc.am", t["payout-3"])
        self.assertIn("\U0001f4b8 Paid out", t["payout-4"])
        self.assertNotIn("road to a listing", "".join(t.values()))

    def test_unreadable_n_holds_the_purchase_and_everything_after_it(self):
        rc, q = self.run_with([self.p(2, purchase=True), self.p(3, asset="USD", sent="45.540000")],
                              number=(None, "mysql did not answer within 30 s"))
        self.assertEqual(rc, 1)
        self.assertEqual(self.fake.calls, [])
        with open(self.state) as fh:
            self.assertEqual(json.load(fh)["announced"], ["1"])    # not recorded: retried next run
        self.assertIn("HELD", q.err.getvalue())

    def test_n_is_asked_once_per_run(self):
        asked = []
        f = feed(payouts=[self.p(2, purchase=True), self.p(3, purchase=True)])
        self.po.read_feed = lambda: f
        self.po.banner_number = lambda feed_: (asked.append(feed_) or (20, None))
        with Quiet():
            self.po.main()
        self.assertEqual(len(asked), 1)
        self.assertIs(asked[0], f)                                  # this run's snapshot, not a re-read

    def test_banner_number_uses_the_real_banner_with_this_feed(self):
        # The real pcoin-listing-banner, its database stubbed: the feed passed in
        # is the one the exchange half of N comes from.
        d = tempfile.mkdtemp(prefix="bn-")
        try:
            env = {"BANNER_STATE_DIR": d, "BANNER_EXCHANGE_URL": "https://exchange.example/api/payouts?limit=1"}
            for k, v in env.items():
                os.environ[k] = v
            real = self.po.load_module

            def patched(name, path):
                m = real(name, os.path.join(HERE, "pcoin-listing-banner"))
                m.market_figures = lambda: (16, 1219.49, "")
                return m
            self.po.load_module = patched
            self.assertEqual(self.po.banner_number(feed(purchases=3)), (19, None))
            n, why = self.po.banner_number({"payouts": [], "total": {"count": 1}})   # old shape, nothing cached
            self.assertIsNone(n)
            self.assertIn("total.purchases", why)
        finally:
            for k in ("BANNER_STATE_DIR", "BANNER_EXCHANGE_URL"):
                os.environ.pop(k, None)
            shutil.rmtree(d, ignore_errors=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
