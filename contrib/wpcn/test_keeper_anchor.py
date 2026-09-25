#!/usr/bin/env python3
"""Truth table for the keeper on the PCN index (price plan Phase 3 Step 2, D11).

It loads the REAL keeper by path and drives its own functions -- index_verdict(),
index_from_body(), target_from_body(), run_budget(), decide() -- rather than
restating the rules, because a test that restates a rule passes against broken
code. Every rule here is also proved to be LOAD-BEARING by
test_keeper_anchor_mutants.py, which removes it and requires the case guarding
it to fail.

The keeper is loaded with D11's own settings in a tuning file of its own, so
the first case is simply "the keeper accepts the owner's numbers": a value it
would refuse would stop it trading the moment the switch is made.

Run:  /opt/wpcn/.venv/bin/python test_keeper_anchor.py [path-to-keeper]
Exit 0 = every case passed. The last line names every failed case, and the
mutant driver reads it.
"""
import importlib.machinery
import importlib.util
import json
import os
import sys
import tempfile

KEEPER = sys.argv[1] if len(sys.argv) > 1 else "/usr/local/bin/pcoin-wpcn-keeper"

# D11 exactly, as the owner approved it on 2026-09-24: parity both ways (buy
# floor 0, no discount), a 3% dead band, $50 and 2,000 wPCN a day, $10 and 400
# wPCN a run, never sell the float under 1,500 wPCN.
D11 = {"anchor_index": True, "buy_floor_usd": 0, "target_discount_pct": 0,
       "dead_band": 0.03, "daily_usdt_cap": 50, "daily_wpcn_cap": 2000,
       "max_usdt_per_run": 10, "max_wpcn_per_run": 400, "min_wpcn": 1500,
       "min_usdt": 5, "max_index_age_s": 180, "max_target_usd": 0.10,
       "buy": True, "sell": True}

# Import without running main(), on a tuning file of its own, so the import can
# neither be affected by nor affect whatever production is set to. Any KEEPER_*
# variable in this shell is removed first: the file must be the only source.
_tmp = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
json.dump(D11, _tmp)
_tmp.close()
for _v in [v for v in os.environ if v.startswith("KEEPER_")]:
    del os.environ[_v]
os.environ["KEEPER_TUNING"] = _tmp.name
os.environ["KEEPER_EFFECTIVE"] = _tmp.name + ".eff"
os.environ["KEEPER_STATE"] = _tmp.name + ".state"
os.environ["PCOIN_NOTIFY"] = "/nonexistent/never-notify"
# Importing a file by path caches its bytecode in a __pycache__ BESIDE it -- run
# as root against /usr/local/bin/pcoin-wpcn-keeper, that is a stray directory in
# /usr/local/bin. Nothing here needs the cache.
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_loader(
    "keeper", importlib.machinery.SourceFileLoader("keeper", KEEPER))
k = importlib.util.module_from_spec(spec)
spec.loader.exec_module(k)
os.unlink(_tmp.name)

INDEX = 0.027335212     # the index as seeded on 2026-09-24, held since
LADDER = 0.026748145    # sellPriceUsd the same morning -- deliberately DIFFERENT
POOL = 0.027246975      # the pool spot that morning
DB = 0.03

fails = []
rows = []


def check(name, got, want, why):
    """want is a float (compared to 1e-12), None, or a callable(got) -> bool."""
    if callable(want):
        ok = bool(want(got))
    elif want is None:
        ok = got is None
    else:
        ok = got is not None and not isinstance(got, bool) and abs(got - want) < 1e-12
    rows.append((ok, name, got, why))
    if not ok:
        fails.append(name)


def run(name, fn, want, why):
    """A pure function that RAISES has not returned None; count it as a failure.
    (In production posted_rate() would catch it and hold, but the contract of
    these functions is "a value or None", and a crash hides which check ran.)"""
    try:
        got = fn()
    except Exception as e:                                   # noqa: BLE001
        rows.append((False, name, "raised %s: %s" % (type(e).__name__, e), why))
        fails.append(name)
        return
    check(name, got, want, why)


def body(**ix):
    """A price.pc.am body shaped like the live one: an `index` block beside a
    perfectly readable sellPriceUsd, so any code that falls back to the ladder
    would find a number there and be caught."""
    block = {"usd": INDEX, "state": "held", "seq": 0, "ageSeconds": 14, "stale": False,
             "inUse": False, "refused": None, "source": "https://exchange.pc.am/api/index"}
    for key, v in ix.items():
        if v is DROP:
            block.pop(key, None)
        else:
            block[key] = v
    return {"sellPriceUsd": LADDER, "creditRateUsd": LADDER, "price": LADDER,
            "index": block}


DROP = object()
ifb = k.index_from_body

# --------------------------------------------------------------- the settings
run("D11 settings are accepted by the keeper", lambda: k.TUNING_ERROR, None,
    "a value the keeper refuses would stop it trading the moment the switch is made")
run("anchor_index is read from the tuning file", lambda: k.ANCHOR_INDEX, lambda v: v is True,
    "the switch must reach the code through the file the panel writes")
run("max_index_age_s is read from the tuning file", lambda: k.MAX_INDEX_AGE_S, 180.0, "")
run("max_usdt_per_run is read from the tuning file", lambda: k.MAX_USDT_PER_RUN, 10.0, "")
run("max_wpcn_per_run is read from the tuning file", lambda: k.MAX_WPCN_PER_RUN, 400.0, "")

# ------------------------------------------------------------ usable readings
run("live index is a price", lambda: ifb(body(state="live", seq=3)), INDEX,
    "live: moved within 24 h, or could have")
run("HELD index is still the price", lambda: ifb(body(state="held")), INDEX,
    "plan 2.4: a held price is still the price -- too few new fills to move is not a fault")
run("FROZEN index is still the price", lambda: ifb(body(state="frozen")), INDEX,
    "the owner's brake holds the value; the keeper keeps parity with it")
run("a numeric-string usd is accepted", lambda: ifb(body(usd="0.027335212")), INDEX,
    "exchange-shaped bodies spell usd as a string")
run("age exactly at max_index_age_s is usable", lambda: ifb(body(ageSeconds=180)), INDEX,
    "the bound is 'over', not 'at'")
run("a price just under max_target_usd is usable", lambda: ifb(body(usd=0.0999)), 0.0999, "")

# ----------------------------------------------------------------- the state
run("UNKNOWN state is not a price, even with a number beside it",
    lambda: ifb(body(state="unknown")), None,
    "the state alone decides: a usd left beside 'unknown' is a leftover, not a price")
run("DISABLED state is not a price", lambda: ifb(body(state="disabled")), None,
    "the owner switched the index off on the exchange")
run("an unheard-of state is not a price", lambda: ifb(body(state="LIVE")), None,
    "anything this code does not know collapses to do-nothing")
run("a missing state is not a price", lambda: ifb(body(state=DROP)), None, "")

# ----------------------------------------------------------------- staleness
run("STALE index is not a price", lambda: ifb(body(stale=True)), None,
    "price.pc.am says it is stale; a fresh-looking age does not overrule it")
run("a missing 'stale' is not 'not stale'", lambda: ifb(body(stale=DROP)), None,
    "CLAUDE.md 7.2: defaults must be unknown-shaped, not answer-shaped")
run("a null 'stale' is not 'not stale'", lambda: ifb(body(stale=None)), None, "")

# ---------------------------------------------------------------------- age
run("age over max_index_age_s is not a price", lambda: ifb(body(ageSeconds=181)), None,
    "three missed polls: the relay has stopped, whatever the block still says")
run("a much older index is not a price", lambda: ifb(body(ageSeconds=628)), None,
    "what the public block really showed at 11:16 UTC on 2026-09-25")
run("a missing age is not a young age", lambda: ifb(body(ageSeconds=DROP)), None, "")
run("a null age is not a young age", lambda: ifb(body(ageSeconds=None)), None, "")
run("a bool age is not an age", lambda: ifb(body(ageSeconds=True)), None,
    "True would otherwise read as '1 s old' -- the freshest index there is")
run("the age bound can be tightened by the caller",
    lambda: ifb(body(ageSeconds=100), max_age_s=60), None, "")

# ------------------------------------------------------------------- value
run("a zero index is not a price", lambda: ifb(body(usd=0)), None, "")
run("a negative index is not a price", lambda: ifb(body(usd=-0.02)), None, "")
run("a null usd is not a price", lambda: ifb(body(usd=None)), None,
    "what price.pc.am publishes for unknown -- rejected on its own as well")
run("a bool usd is not a price", lambda: ifb(body(usd=True)), None,
    "in Python True == 1: a flag in the wrong field would read as $1")
run("an index over max_target_usd is not a price",
    lambda: ifb(body(usd=0.1000001)), None,
    "one corrupted read would otherwise have the keeper chase it with the float")
run("a wildly wrong index is not a price", lambda: ifb(body(usd=27.335212)), None,
    "a nano/usd mix-up, 1000x")

# ---------------------------------------------------------- missing blocks
run("no index block at all is not a price", lambda: ifb({"sellPriceUsd": LADDER}), None,
    "an old price.pc.am, or one that has not polled yet -- the ladder is right there and must NOT be used")
run("a null index block is not a price",
    lambda: ifb({"sellPriceUsd": LADDER, "index": None}), None,
    "what price.pc.am publishes before its first poll")
run("a body that is not an object is not a price", lambda: ifb([INDEX]), None, "")

# ------------------------------------- the anchor, end to end, never the ladder
run("anchor on: the target is the INDEX, not sellPriceUsd",
    lambda: k.target_from_body(body())[0], INDEX,
    "the two differ on purpose, so reading the wrong field cannot pass")
run("anchor on: stale index -> NO target, NOT the ladder",
    lambda: k.target_from_body(body(stale=True))[0], None,
    "unknown collapses to do-nothing, never to the old price")
run("anchor on: no index block -> NO target, NOT the ladder",
    lambda: k.target_from_body({"sellPriceUsd": LADDER})[0], None, "")
run("anchor on: the hold says it did not fall back",
    lambda: k.target_from_body(body(state="unknown"))[1].get("why", ""),
    lambda why: "NOT falling back to the ladder" in why and "unknown" in why,
    "the log line must say what the keeper is NOT doing")


def with_anchor_off(fn):
    k.ANCHOR_INDEX = False
    try:
        return fn()
    finally:
        k.ANCHOR_INDEX = True


run("anchor off: the target is sellPriceUsd, exactly as before",
    lambda: with_anchor_off(lambda: k.target_from_body(body())[0]), LADDER,
    "rollback (anchor_index false) must be the old keeper")
run("anchor off: the index block is ignored, even when it is broken",
    lambda: with_anchor_off(lambda: k.target_from_body(body(stale=True, state="unknown"))[0]),
    LADDER, "")

# ------------------------------------------------------------- per-run caps
# run_budget(buying, want, spent_today, have). Floors: 5 USDT, 1,500 wPCN.
run("per-run cap binds a BUY at $10",
    lambda: k.run_budget(True, 37.0, 0.0, 250.0), lambda r: r == (10.0, "per-run cap"),
    "a $37 correction becomes a $10 step; the next minute re-reads the pool")
run("per-run cap binds a SELL at 400 wPCN",
    lambda: k.run_budget(False, 1200.0, 0.0, 7585.51), lambda r: r == (400.0, "per-run cap"),
    "a 1,200 wPCN correction becomes a 400 wPCN step")
run("a small trade is not rounded UP to the cap",
    lambda: k.run_budget(True, 3.0, 0.0, 250.0), lambda r: r == (3.0, "gap"),
    "the cap is a ceiling, never a size")
run("the daily cap still binds under the per-run cap",
    lambda: k.run_budget(True, 37.0, 45.0, 250.0), lambda r: r == (5.0, "daily cap"),
    "$45 of $50 spent today leaves $5, less than a step")
run("the wPCN float floor still binds under the per-run cap",
    lambda: k.run_budget(False, 1200.0, 0.0, 1700.0), lambda r: r == (200.0, "float floor"),
    "1,700 held against a 1,500 floor leaves 200 to sell")
run("the daily cap reached is named as the daily cap",
    lambda: k.run_budget(False, 1200.0, 2000.0, 7585.51), lambda r: r == (0.0, "daily cap"),
    "a blocked run must send the reader to the limit that is binding")


def with_run_cap_zero(fn):
    old = k.MAX_USDT_PER_RUN
    k.MAX_USDT_PER_RUN = 0.0
    try:
        return fn()
    finally:
        k.MAX_USDT_PER_RUN = old


run("a per-run cap of 0 stops buying, and says so",
    lambda: with_run_cap_zero(lambda: k.run_budget(True, 37.0, 0.0, 250.0)),
    lambda r: r == (0.0, "per-run cap"), "")

# -------------------------------- parity with the index, both ways (decide())
# decide() is unchanged; this is what it does when handed the index. Numbers are
# the morning of 2026-09-25: pool $0.027247, index $0.027335 (or re-seeded to
# the then credit rate, $0.026748).
FLOOR = k.BUY_FLOOR_USD
run("buy_floor_usd is 0: parity, not floor mode", lambda: FLOOR, 0.0, "")
for name, pool, anchor, want_action in (
        ("first minute: pool -0.32% of the index -> hold", POOL, INDEX, None),
        ("first minute, index re-seeded to $0.026748: pool +1.86% -> hold", POOL, LADDER, None),
        ("pool 3.5% ABOVE the index -> sell", INDEX * 1.035, INDEX, "sell"),
        ("pool 3.5% BELOW the index -> buy (parity, not the $0.015 floor)", INDEX * 0.965, INDEX, "buy"),
        ("pool 2.9% below the index -> hold (inside the 3% band)", INDEX * 0.971, INDEX, None)):
    a, t, _bt, _st = k.decide(pool, anchor, FLOOR, DB)
    ok = a == want_action and (a is None or abs(t - anchor) < 1e-12)
    rows.append((ok, name, "%s @ %s" % (a or "hold", ("$%.8f" % t) if t else "-"),
                 "the target is the index itself, from both sides"))
    if not ok:
        fails.append(name)

# How long a correction takes in steps, on the day's real reserves (the same
# 21,646.07 wPCN / 591.70 USDT test_keeper_decide.py sizes against).
RW, RU = 21646.07, 591.70
p0 = RU / RW
for label, target, buying in (("pool 5% above the index", p0 / 1.05, False),
                              ("pool 5% below the index", p0 / 0.95, True)):
    need = k.solve_trade(RU, RW, target, True) if buying else k.solve_trade(RW, RU, target, False)
    step = k.MAX_USDT_PER_RUN if buying else k.MAX_WPCN_PER_RUN
    unit = "USDT" if buying else "wPCN"
    rows.append((True, "sizing: " + label, "%.2f %s" % (need, unit),
                 "%d one-minute step(s) of %g %s" % (-(-need // step), step, unit)))

# --------------------------------------------------------------------- report
w = max(len(r[1]) for r in rows)
for ok, name, got, why in rows:
    print("%s %-*s -> %-22s %s" % ("PASS" if ok else "FAIL", w, name, got, why))
print()
if fails:
    print("%d FAILED: %s" % (len(fails), " | ".join(fails)))
    sys.exit(1)
print("all %d cases passed" % len(rows))
