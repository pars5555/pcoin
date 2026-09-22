#!/usr/bin/env python3
"""Build site/sitemap.xml from the pages that actually exist.

    python contrib/deploy/make-sitemap.py            # writes site/sitemap.xml
    python contrib/deploy/make-sitemap.py --check     # exits 1 if it is stale

WHY IT IS GENERATED AND NOT HAND-WRITTEN
A sitemap is a list of promises about what exists. Hand-written, it rots the
first time a page is added or removed, and nothing tells you -- which is the
same failure mode as every stale number CLAUDE.md 8b warns about, except a
search engine reads this one. Generated from the tree, it cannot disagree with
the tree.

WHY THERE IS AN EXCLUSION RULE
/var/www/pc.am holds a directory whose name is a 64-character hex string: the
unlisted admin path. Publishing it in a sitemap would hand it to every crawler
that asks, which is the whole of its security. So any path segment that looks
like a secret -- 16 or more hex characters, which no page name does by
accident -- is excluded BY RULE rather than by a list somebody has to
remember to update, and every exclusion is printed so it is visible rather than
silent. A silent exclusion and a forgotten page look identical.

lastmod comes from git, not from the filesystem: a fresh clone has today's
mtime on every file, which would claim the whole site changed this morning.
A file git does not know about is emitted with no lastmod rather than a guessed
one -- an absent lastmod is ignored, a wrong one is believed.
"""
import argparse
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SITE = ROOT / "site"
BASE = "https://pc.am"
OUT = SITE / "sitemap.xml"

# A path segment of 16+ hex characters is an unlisted path, never a page.
SECRET = re.compile(r"^[0-9a-f]{16,}$", re.I)

# Priority is a hint, not a ranking. The homepage leads; the pages a visitor is
# sent to by name come next; reference material is lower. Anything not named
# here gets the default, so adding a page never needs this table edited.
PRIORITY = {
    "": "1.0",
    "mining": "0.9", "wallet": "0.9", "download": "0.9", "buy": "0.8",
    "faq": "0.8", "docs": "0.8", "pay": "0.7", "exchanges": "0.7",
    "bounty": "0.7", "news": "0.7", "app": "0.6", "pcnearner": "0.6",
    "roadmap": "0.6", "whitepaper": "0.6", "listing": "0.5",
}
DEFAULT_PRIORITY = "0.6"


def git_lastmod(path):
    """Last commit date for a file, or None if git has never seen it."""
    try:
        out = subprocess.run(
            ["git", "-C", str(ROOT), "log", "-1", "--format=%cs", "--", str(path)],
            capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return None
    d = out.stdout.strip()
    return d if re.fullmatch(r"\d{4}-\d{2}-\d{2}", d) else None


def pages():
    """(url-path, file) for every page, with exclusions reported."""
    found, skipped = [], []
    for f in sorted(SITE.rglob("*.html")):
        rel = f.relative_to(SITE)
        if any(SECRET.match(part) for part in rel.parts):
            skipped.append(str(rel))
            continue
        if f.name == "index.html":
            d = rel.parent.as_posix()
            url = "/" if d == "." else f"/{d}/"
        else:
            url = "/" + rel.as_posix()
        found.append((url, f))
    return found, skipped


def build():
    found, skipped = pages()
    lines = ['<?xml version="1.0" encoding="UTF-8"?>',
             '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for url, f in found:
        key = url.strip("/")
        lines.append("  <url>")
        lines.append(f"    <loc>{BASE}{url}</loc>")
        mod = git_lastmod(f)
        if mod:
            lines.append(f"    <lastmod>{mod}</lastmod>")
        lines.append(f"    <priority>{PRIORITY.get(key, DEFAULT_PRIORITY)}</priority>")
        lines.append("  </url>")
    lines.append("</urlset>")
    return "\n".join(lines) + "\n", found, skipped


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true",
                    help="exit 1 if sitemap.xml does not match the tree")
    a = ap.parse_args()

    xml, found, skipped = build()
    for s in skipped:
        print(f"excluded (unlisted path): {s}", file=sys.stderr)

    if a.check:
        have = OUT.read_text(encoding="utf-8") if OUT.exists() else ""
        if have != xml:
            print(f"STALE: {OUT} does not match the {len(found)} pages on disk. "
                  f"Run this script without --check.", file=sys.stderr)
            return 1
        print(f"sitemap.xml is current: {len(found)} pages")
        return 0

    OUT.write_text(xml, encoding="utf-8", newline="\n")
    print(f"wrote {OUT}  {len(found)} pages, {len(skipped)} excluded")
    return 0


if __name__ == "__main__":
    sys.exit(main())
