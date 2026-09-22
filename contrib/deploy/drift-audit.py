#!/usr/bin/env python3
"""Does the code running in production still match the repository?

    python contrib/deploy/drift-audit.py              # every deployment
    python contrib/deploy/drift-audit.py market       # just one
    python contrib/deploy/drift-audit.py --pull market   # also fetch the
                                                         # differing files for diffing

WHY THIS EXISTS

Three separate services have turned out to be running code that was never
committed: price.pc.am (a third origin nobody knew about), explorer.pc.am, and
on 2026-09-22 the wrap desk, which was 761 lines ahead of the repo and held the
only control that closes the desk to new money. A deploy from git would have
deleted it silently.

Each was found by accident, weeks apart, while looking for something else.
Nothing was asking the question, so the answer was always "we will find out the
hard way". This asks it.

THE TWO TRAPS IT EXISTS TO AVOID

  LINE ENDINGS. contrib/market/settings.mjs is CRLF in the Windows working tree
  and LF on the server. A byte comparison called it 264 lines of drift; it is
  byte-identical once the endings are normalised. Comparing raw would bury three
  real differences under four fake ones, so every comparison here normalises.

  DIRECTION. Drift is not one thing. The repo being AHEAD means a fix has not
  shipped; the SERVER being ahead means work will be destroyed by the next
  deploy. They need opposite responses, and a tool that only says "differs"
  tells you to do the dangerous one. So it counts lines each way and says which.

WHERE THE HOSTS COME FROM

Not from here: this repository is public and CLAUDE.md 5 keeps SSH usernames off
it deliberately. The ssh target for each deployment is read from
TARGETS_FILE (default D:\\pc.am\\deploy-targets.json), a JSON object of
{"<name>": "<user@host>"}. A deployment with no entry is SKIPPED WITH A NOTICE,
never silently, because a deployment nobody audits is the whole problem.
"""
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TARGETS_FILE = Path(os.environ.get(
    "PCOIN_DEPLOY_TARGETS", r"D:\pc.am\deploy-targets.json"))

# name -> (repo subdir, remote dir, ssh key, files to compare)
#
# Generated files, state and anything holding a credential are excluded by
# NAME here rather than by a pattern, so adding one is a deliberate act that
# shows up in a diff. config.json in particular holds secrets and must never
# be pulled into the repo.
DEPLOYMENTS = {
    "market": ("contrib/market", "/opt/pcoin-market", "~/.ssh/id_ed25519",
               ["*.mjs", "*.css", "*.html", "*.sql"]),
    # server.mjs on the box IS wrapdesk-server.mjs in the repo. A deployment
    # that renames its entrypoint looks like "one file only on the server and a
    # different one only in the repo", which reads as two problems and is none.
    "wrapdesk": ("contrib/wpcn", "/opt/wrapdesk", "~/.ssh/id_ed25519",
                 ["*.mjs"], {"server.mjs": "wrapdesk-server.mjs"}),
    # NOT /opt/pcoin-explorer/src -- that is a checkout of this whole repo. The
    # units run from contrib/explorer inside it, which is the directory that
    # actually has to match.
    "explorer": ("contrib/explorer", "/opt/pcoin-explorer/src/contrib/explorer",
                 "~/.ssh/id_ed25519", ["*.py", "pcoin_indexer/*.py",
                                       "pcoin_explorer/*.py"]),
    "pool": ("contrib/pool", "/opt/pcoin-pool", "~/.ssh/id_ed25519",
             ["*.mjs"]),
}

# Files that are SUPPOSED to be absent from a server: tests and local helpers
# never ship. Listing them stops the report crying wolf every run -- a report
# with permanent noise in it is one people stop reading, which is how the three
# real cases went unnoticed for weeks.
NOT_DEPLOYED_OK = {
    "pool": {"blocktest.mjs", "coinbasetest.mjs", "duptest.mjs",
             "storetest.mjs", "testminer.mjs"},
    "market": {"gen_ladder.mjs"},
}

# Never compared: state, generated files, or files holding credentials.
IGNORE = {"config.json", "package-lock.json", "cap-history.json"}


def norm(b):
    """Content with line endings normalised and trailing blank space removed."""
    return b.replace(b"\r\n", b"\n").rstrip() + b"\n"


def sh(cmd):
    # encoding is EXPLICIT. text=True alone decodes with the Windows locale
    # (cp1252 here), which throws on the first UTF-8 byte in a source file and
    # takes the reader thread down with it -- the audit then dies on a file
    # that is perfectly fine, which reads as a broken host.
    r = subprocess.run(cmd, shell=True, capture_output=True, timeout=180,
                       encoding="utf-8", errors="replace")
    return r.returncode, r.stdout or "", r.stderr or ""


def audit(name, target, pull=False):
    spec = DEPLOYMENTS[name]
    sub, remote, key, globs = spec[:4]
    renames = spec[4] if len(spec) > 4 else {}   # remote name -> repo name

    repo_dir = ROOT / sub
    if not repo_dir.is_dir():
        print(f"  {sub} is not in this checkout -- skipped")
        return 0

    # Keyed by path RELATIVE TO THE DEPLOYMENT ROOT, not basename. The
    # explorer ships pcoin_indexer/ and pcoin_explorer/ as packages, and
    # keying on basename made every one of its 29 files look both
    # server-only and repo-only at once -- 26 phantom problems and no real
    # ones. The remote glob already returns relative paths, so this makes the
    # two sides speak the same language.
    local = {}
    for g in globs:
        for f in repo_dir.glob(g):
            rel = f.relative_to(repo_dir).as_posix()
            if f.name not in IGNORE:
                local[rel] = norm(f.read_bytes())

    pat = " ".join(globs)
    rc, out, err = sh(f'ssh -o ConnectTimeout=20 -o BatchMode=yes -i {key} {target} '
                      f'"cd {remote} 2>/dev/null && for f in {pat}; do '
                      f'[ -f \\"$f\\" ] && echo \\"$f\\"; done"')
    if rc != 0 or not out.strip():
        # UNREADABLE IS NOT CLEAN. This is the one answer that must never be
        # mistaken for "no drift" -- that is CLAUDE.md 7.1 and it is why this
        # returns a failure rather than an empty report.
        print(f"  COULD NOT LIST {target}:{remote} -- this is UNKNOWN, not clean"
              + (f"\n  {err.strip()[:160]}" if err.strip() else ""))
        return 1

    names = [n for n in out.split() if n not in IGNORE]

    # EVERY FILE IN ONE CONNECTION. One ssh per file meant ~120 round trips
    # across four deployments, which is slow enough that the audit does not get
    # run -- and an audit nobody runs is the thing this is here to fix. The
    # marker is a fixed sentinel that cannot occur in source.
    SEP = "@@@PCOIN-DRIFT@@@"
    rc, blob, err = sh(
        f'ssh -o ConnectTimeout=20 -o BatchMode=yes -i {key} {target} '
        f'"cd {remote} && for f in {pat}; do [ -f \\"$f\\" ] && '
        f'{{ echo \'{SEP}\'\\"$f\\"; cat \\"$f\\"; }}; done"')
    if rc != 0:
        print(f"  COULD NOT READ {target}:{remote} -- UNKNOWN, not clean")
        return 1
    bodies = {}
    for chunk in blob.split(SEP)[1:]:
        fname, _, content = chunk.partition("\n")
        bodies[fname.strip()] = content

    same, differ, only_remote = [], [], []
    for n in names:
        if n not in bodies:
            print(f"  could not read {n} -- treating as UNKNOWN")
            return 1
        rb = norm(bodies[n].encode("utf-8", "replace"))
        n = renames.get(n, n)
        if n not in local:
            only_remote.append(n)
        elif rb == local[n]:
            same.append(n)
        else:
            # Which side is ahead? Count the lines each holds that the other
            # does not. This is what decides whether it is safe to deploy.
            ls = set(local[n].decode("utf-8", "replace").splitlines())
            rs = set(rb.decode("utf-8", "replace").splitlines())
            differ.append((n, len(ls - rs), len(rs - ls)))
            if pull:
                p = ROOT / "contrib" / "deploy" / "_drift" / name
                p.mkdir(parents=True, exist_ok=True)
                (p / n).write_bytes(rb)

    seen = {renames.get(n, n) for n in names}
    only_repo = [n for n in local
                 if n not in seen and n not in NOT_DEPLOYED_OK.get(name, set())]

    print(f"  identical        : {len(same)}")
    if differ:
        print(f"  DIFFERENT        : {len(differ)}")
        for n, l, r in differ:
            side = ("SERVER AHEAD -- a deploy would DESTROY this" if r > l
                    else "repo ahead -- a fix that has not shipped" if l > r
                    else "both changed -- reconcile by hand")
            print(f"      {n:<24} repo-only {l:<4} server-only {r:<4}  {side}")
    if only_remote:
        print(f"  ONLY ON SERVER   : {len(only_remote)}  (never committed)")
        for n in only_remote:
            print(f"      {n}")
    if only_repo:
        print(f"  ONLY IN REPO     : {len(only_repo)}  (never deployed)")
        for n in sorted(only_repo):
            print(f"      {n}")
    if pull and differ:
        print(f"  server copies saved under contrib/deploy/_drift/{name}/")
    return len(differ) + len(only_remote)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("which", nargs="*", help="deployment names; default all")
    ap.add_argument("--pull", action="store_true",
                    help="save the server's copy of each differing file for diffing")
    a = ap.parse_args()

    try:
        targets = json.loads(TARGETS_FILE.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"cannot read {TARGETS_FILE}: {e}\n"
              f"It maps a deployment name to an ssh target, e.g.\n"
              f'  {{"market": "user@host", "wrapdesk": "user@host"}}\n'
              f"It lives off-repo because this repository is public and SSH "
              f"usernames are not (CLAUDE.md 5).", file=sys.stderr)
        return 2

    names = a.which or list(DEPLOYMENTS)
    total, skipped = 0, []
    for n in names:
        if n not in DEPLOYMENTS:
            print(f"unknown deployment {n!r}; known: {', '.join(DEPLOYMENTS)}",
                  file=sys.stderr)
            return 2
        print(f"\n== {n}  ({DEPLOYMENTS[n][1]})")
        if n not in targets:
            # Named but unreachable is reported, never skipped in silence.
            print(f"  NO SSH TARGET in {TARGETS_FILE.name} -- NOT AUDITED")
            skipped.append(n)
            continue
        total += audit(n, targets[n], a.pull)

    print(f"\n{total} file(s) differ or are uncommitted"
          + (f"; {len(skipped)} deployment(s) NOT AUDITED: {', '.join(skipped)}"
             if skipped else ""))
    return 1 if (total or skipped) else 0


if __name__ == "__main__":
    sys.exit(main())
