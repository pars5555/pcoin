#!/usr/bin/env python3
"""Truth table for the wPCN keeper's floor mode.

It loads `decide()` out of the REAL /usr/local/bin/pcoin-wpcn-keeper rather than
restating the rule, because a test that restates the rule passes against broken
code -- which has already happened on this project this month.

Run:  /opt/wpcn/.venv/bin/python test_decide.py [path-to-keeper]
Exit 0 = every case passed.
"""
import importlib.machinery
import importlib.util
import os
import sys
import tempfile

KEEPER = sys.argv[1] if len(sys.argv) > 1 else "/usr/local/bin/pcoin-wpcn-keeper"

# Import it without running main(). Give it a tuning file of its own so the
# import cannot be affected by, or affect, whatever production is set to.
_tmp = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
_tmp.write("{}")
_tmp.close()
os.environ["KEEPER_TUNING"] = _tmp.name
os.environ["KEEPER_EFFECTIVE"] = _tmp.name + ".eff"
# An import by path caches bytecode in a __pycache__ BESIDE the keeper -- a stray
# directory in /usr/local/bin when this runs as root against the installed one.
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_loader(
    "keeper", importlib.machinery.SourceFileLoader("keeper", KEEPER))
k = importlib.util.module_from_spec(spec)
spec.loader.exec_module(k)
decide = k.decide

DB = 0.03          # the live dead band
LADDER = 0.0336    # roughly the live ladder
FLOOR = 0.015      # the owner's floor

fails = []
cases = []


def case(name, pool, ladder, floor, want_action, want_target, why):
    a, t, bt, st = decide(pool, ladder, floor, DB)
    ok = (a == want_action) and (
        want_target is None or (t is not None and abs(t - want_target) < 1e-12))
    cases.append((ok, name, pool, ladder, floor, a, t, want_action, want_target, why))
    if not ok:
        fails.append(name)
    # Two invariants that must hold on EVERY case, not just the ones aimed at them.
    assert st == ladder, "%s: sell target must always be the ladder" % name
    assert bt <= ladder + 1e-12, (
        "%s: buy target %.8f is ABOVE the ladder %.8f -- the keeper would buy the "
        "pool up past its own ask, which makes wrap-and-dump free money"
        % (name, bt, ladder))


# ---------------------------------------------------------------- parity mode
# floor = 0 must reproduce the behaviour the keeper had before floor mode, or
# turning the floor off is not a safe rollback.
case("parity: at parity", LADDER, LADDER, 0, None, None,
     "no gap, nothing to do")
case("parity: inside band below", LADDER * 0.98, LADDER, 0, None, None,
     "2% < 3% dead band")
case("parity: inside band above", LADDER * 1.02, LADDER, 0, None, None,
     "2% < 3% dead band")
case("parity: 10% below", LADDER * 0.90, LADDER, 0, "buy", LADDER,
     "the OLD behaviour: defend parity with USDT")
case("parity: 10% above", LADDER * 1.10, LADDER, 0, "sell", LADDER,
     "sell into a premium, back to the ladder")
case("parity: far below", 0.010, LADDER, 0, "buy", LADDER,
     "old behaviour buys all the way back to the ladder")

# ----------------------------------------------------------------- floor mode
case("floor: at the ladder", LADDER, LADDER, FLOOR, None, None,
     "nothing to do")
case("floor: BETWEEN floor and ladder", 0.025, LADDER, FLOOR, None, None,
     "THE POINT OF THE WHOLE CHANGE: a 26% fall is left alone, not bought")
case("floor: just above the floor", 0.0155, LADDER, FLOOR, None, None,
     "inside the dead band of the floor")
case("floor: 3% below the floor", 0.01454, LADDER, FLOOR, "buy", FLOOR,
     "floor breached -- buy, and only back to the FLOOR")
case("floor: far below the floor", 0.008, LADDER, FLOOR, "buy", FLOOR,
     "still only to the floor, never back to the ladder")
case("floor: above the ladder", 0.040, LADDER, FLOOR, "sell", LADDER,
     "a premium is still corrected; wPCN must not trade above PCN")
case("floor: at the floor exactly", FLOOR, LADDER, FLOOR, None, None,
     "the floor is held, not crossed -- no trade at the boundary")
case("floor: dead-band boundary exactly", FLOOR * (1 - DB), LADDER, FLOOR, None, None,
     "strict <, so the boundary itself does not trade")

# --------------------------------------------------- the min() clamp, isolated
# If the floor is ever set above the ladder -- a fat finger, or the ask falling
# below it -- the keeper must NOT buy the pool up to the floor.
case("clamp: floor ABOVE the ladder", 0.020, LADDER, 0.050, "buy", LADDER,
     "buys to the LADDER, never to a floor above it")
case("clamp: floor above, pool at ladder", LADDER, LADDER, 0.050, None, None,
     "clamped to the ladder, so no gap and no trade")
case("clamp: ladder below the floor", 0.0100, 0.0120, FLOOR, "buy", 0.0120,
     "ladder 0.012 < floor 0.015: the LADDER wins, buy only to 0.012")

# ------------------------------------------ floor mode never sells to defend
for p in (0.014, 0.010, 0.005, 0.001):
    a, t, _, _ = decide(p, LADDER, FLOOR, DB)
    if a != "buy":
        fails.append("below-floor-%s" % p)
        cases.append((False, "below floor %.4f -> buy" % p, p, LADDER, FLOOR,
                      a, t, "buy", FLOOR, "selling below the floor would be perverse"))

# ------------------------------------- the PCN price FALLS, the pool does not
# Owner, 2026-09-24: "make sure keeper will do if pcn price reduced". The ladder
# is what price.pc.am posts, read fresh every run, so a lower PCN price is a
# lower SELL target: a pool left above it by more than the dead band is sold
# down to it. Numbers are the live ones that day: pool == ladder == $0.027335.
POOL_NOW = 0.027335
case("PCN down 12%: pool left above it", POOL_NOW, 0.024, FLOOR, "sell", 0.024,
     "price.pc.am fell to $0.024 and the pool did not -- sell wPCN down to it")
case("PCN down 3.5%: just past the band", POOL_NOW, POOL_NOW / 1.035, FLOOR, "sell", POOL_NOW / 1.035,
     "3.5% > 3% dead band -- sell")
case("PCN down 2%: inside the band", POOL_NOW, POOL_NOW * 0.98, FLOOR, None, None,
     "2% is inside the dead band -- hold, no churn on noise")
case("PCN down to the floor", POOL_NOW, FLOOR, FLOOR, "sell", FLOOR,
     "even at the floor the pool is sold down to it, never below")

# How much does it sell, and does the daily cap bind? The real solver on the
# day's real reserves (21,646.07 wPCN / 591.70 USDT).
RW, RU = 21646.07, 591.70
cap = k.DAILY_WPCN_CAP
for target, label in ((0.024, "to $0.024"), (FLOOR, "to the $0.015 floor")):
    need = k.solve_trade(RW, RU, target, False)
    after = (RU - k.amount_out(need, RW, RU)) / (RW + need)
    ok = abs(after - target) / target < 0.005
    cases.append((ok, "sizing %s" % label, POOL_NOW, target, FLOOR, "sell", target, "sell", target,
                  "needs %.0f wPCN (daily cap %.0f: %s)" % (need, cap,
                  "one day" if need <= cap else "about %d days at the cap" % -(-need // cap))))
    if not ok:
        fails.append("sizing %s" % label)

# --------------------------------------------------------------------- report
w = max(len(c[1]) for c in cases)
for ok, name, pool, ladder, floor, a, t, wa, wt, why in cases:
    print("%s %-*s pool $%.6f ladder $%.6f floor $%.4f -> %-5s @ %s   %s"
          % ("PASS" if ok else "FAIL", w, name, pool, ladder, floor,
             a or "hold", ("$%.6f" % t) if t is not None else "   -   ", why))
print()
if fails:
    print("%d FAILED: %s" % (len(fails), ", ".join(fails)))
    sys.exit(1)
print("all %d cases passed" % len(cases))
