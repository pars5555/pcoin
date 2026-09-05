#!/usr/bin/env python3
"""Migrate the wrap-desk ledger from wrap:<txid> to wrap:<txid>:<deposit-address>.

Runs on 178.105.3.51. Every existing key is mapped from a table that was built by
reading each transaction's outputs from the chain (explorer.pc.am/api/tx/<txid>)
and finding which watched deposit address it paid -- not from memory, and not
from requests.json. Each of the three paid exactly one watched address, so the
mapping is unambiguous. A key that is not in the table STOPS the migration: an
unknown deposit is not something to guess an address for.

Two guards added after adversarial review (2026-09-05):
  * The watcher names its state file WRAPDESK_STATE; this script used a different
    name, so the two could have silently operated on different files. Same name
    now, same default.
  * The new watcher will look up wrap:<txid>:<watch_addr> where watch_addr is the
    EXACT string from /var/lib/wrapdesk/requests.json. If the address written here
    differed by a single byte -- a checksum case, a stray space -- every released
    wrap would be re-reported as an ACTION and the operator told to pay again. So
    each non-reserve address must be byte-equal to a requests.json address, or
    the migration refuses.

Dry-run by default. --apply writes, after copying state.json aside. Idempotent:
a key already in the new format is left alone, so a second run is a no-op. A
missing state file is "nothing to migrate", not an error.
"""
import json
import os
import shutil
import sys
import time

STATE = os.environ.get("WRAPDESK_STATE", "/var/lib/pcoin-wrapdesk/state.json")
REQUESTS = os.environ.get("WRAPDESK_REQUESTS", "/var/lib/wrapdesk/requests.json")
RESERVE = "pc1q7hhzmdkkx0zjtzj6qkwmuvhlgwfqjrc6j2dk52"

# txid -> the one watched address that transaction paid (verified on-chain 2026-09-05)
CHAIN_VERIFIED = {
    "4ce92aba528e5c59e5fae2f2787a8adf64e256fbde91e9852e8e744901162bcb":
        "pc1qyq2n99v7m9v60gw3peu7cnnc5nm0gfeh5kkaqe",   # index 1, 10 PCN, height 5881
    "acf288a85bf3e606a4bd9e5d93afc03ebb3b9e7d3f442965ca9d1784c5653621":
        "pc1q6haspr08p2nj2vhlkzsqackk052cgx2m8tswfz",   # index 2, 250 PCN, height 6269
    "9727cf9b4ecdf5e8a2e17c1d94061c4f2a5a0826a2b823f7a576164ff8dae9c2":
        RESERVE,                                        # index 0, 50,000 PCN, height 5765
}


def known_addresses():
    """The exact strings the watcher will use as watch_addr."""
    try:
        with open(REQUESTS) as f:
            req = json.load(f).get("requests", {})
    except FileNotFoundError:
        return None
    return {v.get("address") for v in req.values() if isinstance(v, dict)} | {RESERVE}


def migrate_map(m):
    out, changed, unknown = {}, [], []
    for k, v in m.items():
        if k.startswith("wrap:") and k.count(":") == 1:
            txid = k[5:]
            addr = CHAIN_VERIFIED.get(txid)
            if not addr:
                unknown.append(k)
                out[k] = v
                continue
            nk = f"wrap:{txid}:{addr}"
            out[nk] = v
            changed.append((k, nk))
        else:
            out[k] = v
    return out, changed, unknown


def main():
    apply = "--apply" in sys.argv
    print("state file:", STATE)
    try:
        with open(STATE) as f:
            st = json.load(f)
    except FileNotFoundError:
        print("  no state file -- nothing to migrate")
        return 0

    addrs = known_addresses()
    if addrs is None:
        print(f"REFUSING: cannot read {REQUESTS}; the byte-equality check needs it.")
        return 2
    bad = [(t, a) for t, a in CHAIN_VERIFIED.items() if a not in addrs]
    if bad:
        print("REFUSING: these chain-verified addresses are not byte-equal to any "
              "address in requests.json (or the reserve):")
        for t, a in bad:
            print(f"  {t[:16]}... -> {a!r}")
        print("The new watcher would never match them. Fix the table, re-run.")
        return 2
    print(f"  address check: all {len(CHAIN_VERIFIED)} table addresses are byte-equal to requests.json/reserve")

    new = dict(st)
    all_changed, all_unknown = [], []
    for sect in ("seen", "nagged"):
        if isinstance(st.get(sect), dict):
            new[sect], ch, un = migrate_map(st[sect])
            all_changed += [(sect,) + c for c in ch]
            all_unknown += [(sect, u) for u in un]

    for sect, old, nk in all_changed:
        print(f"  {sect:8s} {old}\n           -> {nk}")
    if not all_changed:
        print("  nothing to migrate (already in the new format)")
    if all_unknown:
        print("\nREFUSING: these old-format keys are not in the chain-verified table:")
        for sect, k in all_unknown:
            print(f"  {sect}: {k}")
        print("Look each one up on explorer.pc.am, add it to CHAIN_VERIFIED, re-run.")
        return 2
    if not apply:
        print("\nDRY RUN. Nothing written. Re-run with --apply to write.")
        return 0
    if all_changed:
        bak = f"{STATE}.pre-migration-{time.strftime('%Y%m%d%H%M%S')}"
        shutil.copy2(STATE, bak)
        tmp = STATE + ".tmp"
        with open(tmp, "w") as f:
            json.dump(new, f, indent=1)
        os.replace(tmp, STATE)
        print(f"\nWRITTEN. Backup at {bak}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
