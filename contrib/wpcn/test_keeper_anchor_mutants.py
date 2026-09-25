#!/usr/bin/env python3
"""Prove that every index rule in the keeper is LOAD-BEARING.

    /opt/wpcn/.venv/bin/python test_keeper_anchor_mutants.py [path-to-keeper]

A test that has only ever been seen passing has not been shown to test
anything -- this estate has paid for that more than once (a holding check whose
threshold could never be reached; a deposit monitor that only ever said
"healthy"). So for each rule the keeper applies to the PCN index, this makes a
MUTANT copy of the keeper with exactly that rule taken out, runs
test_keeper_anchor.py against the mutant, and requires the case that guards the
rule to FAIL. Same idea as the exchange's test/index-price-mutants.mjs and
contrib/market/curve-refusals.sh.

SAFE BY CONSTRUCTION: the keeper under test is only ever READ. Mutants are
written into a temporary directory and deleted afterwards; nothing is run but
the test file, which imports the keeper without calling main().

EVERY ANCHOR MUST MATCH EXACTLY ONCE. A search text that is missing or found
twice stops the run as BROKEN rather than being skipped: a mutant that silently
did not apply would "survive" for the wrong reason, or be "killed" by a syntax
error. Each mutant is also compiled before it is judged.

Defaults to the keeper beside this file (the candidate). Point it at the
installed one to prove what is running:
    test_keeper_anchor_mutants.py /usr/local/bin/pcoin-wpcn-keeper
Exit 0 only if the unmutated keeper passes every case and every mutant is killed.
"""
import os
import py_compile
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
KEEPER = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "pcoin-wpcn-keeper")
TESTS = os.path.join(HERE, "test_keeper_anchor.py")

# (name, the case that must fail -- its exact name in test_keeper_anchor.py,
#  [(search, replace), ...])
MUTANTS = [
    ("state check removed",
     "UNKNOWN state is not a price, even with a number beside it",
     [("    if state not in INDEX_PRICED_STATES:\n", "    if False:\n")]),
    ("'unknown' counted as a priced state",
     "UNKNOWN state is not a price, even with a number beside it",
     [('INDEX_PRICED_STATES = ("live", "held", "frozen")',
       'INDEX_PRICED_STATES = ("live", "held", "frozen", "unknown")')]),
    ("'held' refused (too strict: the keeper would stop on a quiet day)",
     "HELD index is still the price",
     [('INDEX_PRICED_STATES = ("live", "held", "frozen")',
       'INDEX_PRICED_STATES = ("live", "frozen")')]),
    ("'frozen' refused (the owner's brake would stop the keeper)",
     "FROZEN index is still the price",
     [('INDEX_PRICED_STATES = ("live", "held", "frozen")',
       'INDEX_PRICED_STATES = ("live", "held")')]),
    ("stale check removed",
     "STALE index is not a price",
     [('    if ix.get("stale") is not False:\n', "    if False:\n")]),
    ("stale checked only when present (answer-shaped default)",
     "a missing 'stale' is not 'not stale'",
     [('    if ix.get("stale") is not False:\n', '    if ix.get("stale") is True:\n')]),
    ("age check removed",
     "age over max_index_age_s is not a price",
     [("    if age > max_age_s:\n", "    if False:\n")]),
    ("age bound off by one (>= instead of >)",
     "age exactly at max_index_age_s is usable",
     [("    if age > max_age_s:\n", "    if age >= max_age_s:\n")]),
    ("age bound not wired to max_index_age_s (uses price.pc.am's 600 s)",
     "age over max_index_age_s is not a price",
     [("    max_age_s = MAX_INDEX_AGE_S if max_age_s is None else max_age_s\n",
       "    max_age_s = 600 if max_age_s is None else max_age_s\n")]),
    ("bool accepted as a number",
     "a bool age is not an age",
     [("    if x is None or isinstance(x, bool):\n", "    if x is None:\n")]),
    ("zero / negative check removed",
     "a zero index is not a price",
     [("    if not (usd > 0):\n", "    if False:\n")]),
    ("max_target_usd check removed",
     "an index over max_target_usd is not a price",
     [("    if usd > max_target_usd:\n", "    if False:\n")]),
    ("a missing index block falls back to the ladder",
     "no index block at all is not a price",
     [('        return None, "price.pc.am carries no index (no top-level state, no index block)"\n',
       '        ix = {"state": "held", "stale": False, "ageSeconds": 0,'
       ' "usd": d.get("sellPriceUsd")}\n')]),
    ("anchor mode falls back to the ladder when the index is unusable",
     "anchor on: stale index -> NO target, NOT the ladder",
     [("return None, info           # UNKNOWN: hold. Never the ladder.",
       'anchor = _real(d.get("sellPriceUsd"))')]),
    ("anchor_index ignored (always the ladder)",
     "anchor on: the target is the INDEX, not sellPriceUsd",
     [("    if ANCHOR_INDEX:\n        ix = index_block(d)",
       "    if False:\n        ix = index_block(d)")]),
    # ---- both body shapes (owner, 2026-09-25: "simplify the price.pc.am json
    # response"). The minimal body puts the index at the top level; the
    # transition publishes both; the ladder block is honoured while it lasts.
    ("the minimal body is not read (only the old index block)",
     "the MINIMAL body is a price",
     [('    if isinstance(d.get("state"), str):\n        return {"usd": d.get("creditRateUsd")',
       '    if False:\n        return {"usd": d.get("creditRateUsd")')]),
    ("the minimal body's usd read from sellPriceUsd",
     "the MINIMAL body is a price",
     [('{"usd": d.get("creditRateUsd"), "state"', '{"usd": d.get("sellPriceUsd"), "state"')]),
    ("the minimal body's stale flag dropped",
     "the MINIMAL body with stale: true is not a price",
     [('"ageSeconds": d.get("ageSeconds"), "stale": d.get("stale")}',
       '"ageSeconds": d.get("ageSeconds"), "stale": False}')]),
    ("the transition prefers the top level over the index block",
     "transition: the INDEX BLOCK is the price, not the top-level creditRateUsd",
     [('    if isinstance(ix, dict):\n        if "stale" in d',
       '    if isinstance(ix, dict) and not isinstance(d.get("state"), str):\n        if "stale" in d')]),
    ("the transition ignores the top-level stale",
     "transition: top-level stale holds, though the index block says fresh",
     [('        if "stale" in d and d.get("stale") is not False and ix.get("stale") is False:\n',
       '        if False:\n')]),
    ("the transition's top-level stale honoured only when True",
     "transition: a top-level stale of null holds",
     [('        if "stale" in d and d.get("stale") is not False and ix.get("stale") is False:\n',
       '        if d.get("stale") is True and ix.get("stale") is False:\n')]),
    ("ladder.stale ignored",
     "today's body, ladder.stale true: not a price, though the index says fresh",
     [('    if "ladder" in d and not (isinstance(d.get("ladder"), dict)\n',
       '    if False and not (isinstance(d.get("ladder"), dict)\n')]),
    ("ladder.stale checked only when true (answer-shaped default)",
     "today's body, ladder: null is not a price",
     [('    if "ladder" in d and not (isinstance(d.get("ladder"), dict)\n'
       '                              and d["ladder"].get("stale") is False):\n',
       '    if "ladder" in d and isinstance(d.get("ladder"), dict) and d["ladder"].get("stale") is True:\n')]),
    ("per-run cap removed on the BUY side",
     "per-run cap binds a BUY at $10",
     [("        run_cap = MAX_USDT_PER_RUN\n", '        run_cap = float("inf")\n')]),
    ("per-run cap removed on the SELL side",
     "per-run cap binds a SELL at 400 wPCN",
     [("        run_cap = MAX_WPCN_PER_RUN\n", '        run_cap = float("inf")\n')]),
    ("per-run cap dropped from the budget min()",
     "per-run cap binds a BUY at $10",
     [("    budget = min(want,\n                 run_cap,\n",
       "    budget = min(want,\n")]),
    ("per-run caps swapped (USDT cap applied to wPCN)",
     "per-run cap binds a SELL at 400 wPCN",
     [("        run_cap = MAX_WPCN_PER_RUN\n", "        run_cap = MAX_USDT_PER_RUN\n")]),
]


def run_tests(keeper):
    """(exit status, set of failed case names, full output).

    PYTHONDONTWRITEBYTECODE, and a directory per mutant (below), because the
    first version of this driver reported a survivor that was not one: Python
    caches compiled bytecode keyed on the source's mtime AND SIZE, the BUY and
    SELL per-run mutants are the same length (MAX_USDT_PER_RUN and
    MAX_WPCN_PER_RUN), and both were written to one path inside one second --
    so the SELL mutant was judged by running the BUY mutant's cached code.
    """
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
    r = subprocess.run([sys.executable, TESTS, keeper], capture_output=True,
                       text=True, timeout=120, env=env)
    failed = set()
    for line in r.stdout.splitlines():
        if " FAILED: " in line:
            failed = set(x.strip() for x in line.split(" FAILED: ", 1)[1].split(" | "))
    return r.returncode, failed, r.stdout + r.stderr


def main():
    with open(KEEPER) as f:
        original = f.read()
    print("under test: %s" % KEEPER)

    # 0. Every anchor is where we think it is, exactly once.
    broken = []
    for name, _case, edits in MUTANTS:
        for find, _ in edits:
            n = original.count(find)
            if n != 1:
                broken.append("%s: search text found %d times: %r" % (name, n, find[:80]))
    if broken:
        print("BROKEN: %d mutant anchor(s) no longer match the keeper. Update the "
              "mutants; nothing was run.\n  - %s" % (len(broken), "\n  - ".join(broken)))
        return 2

    # 1. The unmutated keeper passes every case. If it did not, a "killed"
    # mutant would prove nothing.
    status, failed, out = run_tests(KEEPER)
    if status != 0 or failed:
        print("BASELINE FAILED: the unmutated keeper must pass first.\n" + out)
        return 2
    print("baseline: every case passes unmutated\n")

    # 2. Each mutant must be killed by its own case.
    box = tempfile.mkdtemp(prefix="keeper-mutants-")
    killed, survivors = 0, []
    try:
        for i, (name, case, edits) in enumerate(MUTANTS):
            src = original
            for find, replace in edits:
                src = src.replace(find, replace, 1)
            os.mkdir(os.path.join(box, "m%02d" % i))
            path = os.path.join(box, "m%02d" % i, "pcoin-wpcn-keeper")
            with open(path, "w") as f:
                f.write(src)
            try:
                py_compile.compile(path, cfile=os.path.join(box, "m%02d.pyc" % i),
                                   doraise=True)
            except py_compile.PyCompileError as e:
                survivors.append("%s: the mutant does not even compile, so it proves "
                                 "nothing\n%s" % (name, e))
                print("  BROKEN    %s" % name)
                continue
            status, failed, out = run_tests(path)
            if status != 0 and case in failed:
                killed += 1
                print("  killed    %s  (by \"%s\")" % (name, case))
            else:
                survivors.append("%s: \"%s\" still passes with the rule removed "
                                 "(exit %d, failed: %s)" % (name, case, status,
                                                            sorted(failed) or "none"))
                print("  SURVIVED  %s" % name)
    finally:
        shutil.rmtree(box, ignore_errors=True)

    print("\n%d of %d mutants killed." % (killed, len(MUTANTS)))
    if survivors:
        print("\nNOT PROVEN:\n  - " + "\n  - ".join(survivors))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
