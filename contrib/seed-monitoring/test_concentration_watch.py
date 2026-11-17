#!/usr/bin/env python3
"""Unit tests for pcoin-concentration-watch coinbase classification."""

import importlib.machinery
import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
MOD_PATH = os.path.join(HERE, "pcoin-concentration-watch")
loader = importlib.machinery.SourceFileLoader("concentration_watch", MOD_PATH)
spec = importlib.util.spec_from_loader("concentration_watch", loader)
cw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cw)

TREASURY = "pc1qlvw6kx8wkcz8f6p0d6kswv69fjt33ll079f64e"
OURS = cw.OUR_POOLS


def mk_block(vouts):
    """vouts is [(pcn_float_or_str, addr_or_none)]."""
    out = []
    for val, addr in vouts:
        spk = {"address": addr} if addr else {"type": "nulldata"}
        out.append({"value": val, "scriptPubKey": spk})
    out.append({"value": 0.0, "scriptPubKey": {"type": "nulldata"}})
    return {"tx": [{"vout": out}]}


def main():
    # 1. Legitimate pool.pc.am / pool2.pc.am block (2% fee + 42-sat PPLNS rounding)
    b_ours = mk_block([
        ("28.41999958", "pc1qminer1"),
        ("14.58000000", "pc1qminer2"),
        ("6.00000000", TREASURY),        # fleet PC mining into pool2 to treasury
        ("1.00000042", TREASURY),        # actual 2% pool fee + rounding
    ])
    assert cw.classify(b_ours, OURS) == ("ours", "pool.pc.am + pool2.pc.am")

    # 2. Attack #10: Outside pool (1% fee) adds 1-satoshi output to treasury to blind monitor
    b_spoof_pool = mk_block([
        ("30.00000000", "pc1qminer_a"),
        ("19.49999996", "pc1qminer_b"),
        ("0.50000003", "pc1qevilpool"),  # 1% fee
        ("0.00000001", TREASURY),        # 1-sat decoy to treasury
    ])
    assert cw.classify(b_spoof_pool, OURS) == ("outside", "pc1qevilpool")

    # 3. Solo attacker splits 50 PCN into 49.99999999 PCN + 1 sat to treasury (in either order)
    b_spoof_solo_a = mk_block([
        ("0.00000001", TREASURY),
        ("49.99999999", "pc1qevilsolo"),
    ])
    assert cw.classify(b_spoof_solo_a, OURS) == ("solo", "pc1qevilsolo")

    # 4. Solo attacker tries a cheap 0.5% (0.25 PCN) output to treasury to mimic a round fee step
    b_spoof_half_pct = mk_block([
        ("49.75000000", "pc1qevilsolo"),
        ("0.25000000", TREASURY),
    ])
    assert cw.classify(b_spoof_half_pct, OURS) == ("solo", "pc1qevilsolo")

    # 5. Solo attacker puts 1-sat dust to random fresh address at vout[0] and real payout at vout[1]
    b_dust_vout0 = mk_block([
        ("0.00000001", "pc1qfreshdust999"),
        ("49.99999999", "pc1qevilsolo"),
    ])
    assert cw.classify(b_dust_vout0, OURS) == ("solo", "pc1qevilsolo")

    # 6. Legitimate solo block to treasury (fleet solo machine) stays 'solo' to treasury
    b_fleet_solo = mk_block([("50.00000000", TREASURY)])
    assert cw.classify(b_fleet_solo, OURS) == ("solo", TREASURY)

    # 7. Outside pool with no round fee step (3+ outputs) lands in UNIDENTIFIED
    b_unid = mk_block([
        ("20.12345678", "pc1qa"),
        ("19.87654321", "pc1qb"),
        ("10.00000001", "pc1qc"),
    ])
    assert cw.classify(b_unid, OURS) == ("outside", cw.UNIDENTIFIED)

    print("ALL CONCENTRATION WATCH TESTS PASSED")


if __name__ == "__main__":
    sys.exit(main())
