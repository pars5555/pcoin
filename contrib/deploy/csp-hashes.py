#!/usr/bin/env python3
"""Compute the CSP sha256 hashes for pc.am's inline scripts.

    python contrib/deploy/csp-hashes.py            # from the repo
    python contrib/deploy/csp-hashes.py --live      # from the published pages

pc.am's Content-Security-Policy pins the inline <script> on /app/ and /pay/ by
hash rather than allowing 'unsafe-inline'. That is what keeps the policy strict
on the two pages that have any JavaScript at all -- /pay/ reads
location.search and builds a payment URI, so it is the last page that should
let an injected script run.

The cost is that the hash and the script must move together. Change either
page's inline script without recomputing, and the browser silently stops
executing it: the page renders and does nothing. So:

  1. run this after editing site/app/index.html or site/pay/index.html,
  2. put the new hash in the vhost (see pc-am-security-headers.conf),
  3. reload Apache gracefully.

`pcoin-service-watch` runs the --live comparison every five minutes and alerts
when the header and the page disagree, so a forgotten step 2 is noticed rather
than discovered by a user.
"""
import argparse
import base64
import hashlib
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PAGES = {"/app/": "site/app/index.html", "/pay/": "site/pay/index.html"}
INLINE = re.compile(rb"<script>(.*?)</script>", re.S)


def hashes(raw):
    """Every inline script's CSP source expression, in document order."""
    return ["'sha256-%s'" % base64.b64encode(hashlib.sha256(m.group(1)).digest()).decode()
            for m in INLINE.finditer(raw)]


def live(url):
    req = urllib.request.Request(url, headers={"User-Agent": "pcoin-csp-hashes"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read(2_000_000), r.headers.get("Content-Security-Policy") or ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", action="store_true",
                    help="read the published pages and check the header agrees")
    a = ap.parse_args()

    bad = 0
    for path, rel in PAGES.items():
        if a.live:
            raw, csp = live("https://pc.am" + path)
            hs = hashes(raw)
            if not hs:
                print(f"{path:<8} NO inline script found -- the page changed shape")
                bad += 1
                continue
            for h in hs:
                ok = h in csp
                print(f"{path:<8} {h}  {'in the live header' if ok else 'MISSING from the live header'}")
                if not ok:
                    bad += 1
            if not csp:
                print(f"{path:<8} the page sends NO Content-Security-Policy at all")
                bad += 1
        else:
            raw = (ROOT / rel).read_bytes()
            for h in hashes(raw):
                print(f"{path:<8} {h}   ({rel})")

    if a.live:
        print(f"\n{bad} mismatch(es)")
        return 1 if bad else 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
