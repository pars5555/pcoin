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
               ["*.mjs", "*.css", "*.html", "*.sql", "*.sh"]),
    # server.mjs on the box IS wrapdesk-server.mjs in the repo. A deployment
    # that renames its entrypoint looks like "one file only on the server and a
    # different one only in the repo", which reads as two problems and is none.
    "wrapdesk": ("contrib/wpcn", "/opt/wrapdesk", "~/.ssh/id_ed25519",
                 ["*.mjs"], {"server.mjs": "wrapdesk-server.mjs"},
                 # the desk imports the market's QR encoder; ONE source, no copy
                 {"qr.mjs": "contrib/market/qr.mjs"}),
    # NOT /opt/pcoin-explorer/src -- that is a checkout of this whole repo. The
    # units run from contrib/explorer inside it, which is the directory that
    # actually has to match.
    # RECURSIVE, not a list of packages. The first version globbed
    # pcoin_indexer/ and pcoin_explorer/ by name and reported this deployment
    # CLEAN -- while pcoin_api/ sat unexamined with three locally modified
    # files in it. A blind spot in an audit is worse than no audit, because it
    # produces a clean report somebody then trusts. Naming directories is how
    # you get one, so this names none.
    "explorer": ("contrib/explorer", "/opt/pcoin-explorer/src/contrib/explorer",
                 "~/.ssh/id_ed25519", ["**/*.py"]),
    "pool": ("contrib/pool", "/opt/pcoin-pool", "~/.ssh/id_ed25519",
             ["*.mjs"]),
    # price.pc.am has THREE origins and the public URL reaches whichever one
    # Cloudflare picks -- the third (the parsos coordinator) once served a
    # month-old build for weeks while the other two were current. So each is its
    # own deployment here: an audit of "price" that looked at one box would be
    # the same blind spot again. state.json is per-origin state, never compared.
    "price": ("contrib/price", "/opt/pcoin-price", "~/.ssh/id_ed25519", ["server.mjs", "index-relay.mjs"]),
    "price-replica": ("contrib/price", "/opt/pcoin-price", "~/.ssh/id_ed25519", ["server.mjs", "index-relay.mjs"]),
    "price-parsos": ("contrib/price", "/opt/pcoin-price", "~/.ssh/parsos_server", ["server.mjs", "index-relay.mjs"]),
    # Its /stats endpoint lived only on the server for twelve days (2026-09-12
    # to 09-24) before this entry existed.
    # rate.mjs since 2026-09-25: the credit-rate rule moved out of server.mjs, and
    # an entry naming only server.mjs would have reported a stale rate.mjs clean.
    "wpcn-pay": ("contrib/wpcn-pay", "/opt/pcoin-wpcn-pay", "~/.ssh/id_ed25519", ["server.mjs", "rate.mjs"]),
    # The card generator kit. A 2026-09-13 copy sat here refusing to read the
    # nine-key price body for a day, and no entry existed to notice (09-26).
    "announce": ("contrib/announce", "/opt/pcoin-announce", "~/.ssh/id_ed25519", ["make_card.py"]),
    # @PcoinAiBot's BUILD CONTEXT: the bot and its watcher run from an image
    # built out of this directory, so a drift here ships on the next rebuild.
    "pcnaibot": ("contrib/pcnaibot", "/opt/pcnaibot", "~/.ssh/id_ed25519",
                 ["*.mjs", "lib/*.mjs", "migrations/*.sql", "Dockerfile"]),
    # The unified admin panel, including the pinned Move PCN crypto bundle: a
    # drifted bundle is refused by the panel itself, but a drifted server.mjs
    # is not, and it is the file that decides which routes can spend.
    "admin": ("contrib/admin-panel", "/opt/pcoin-admin", "~/.ssh/id_ed25519", ["*.mjs", "*.js"]),
}

# Files that are SUPPOSED to be absent from a server: tests and local helpers
# never ship. Listing them stops the report crying wolf every run -- a report
# with permanent noise in it is one people stop reading, which is how the three
# real cases went unnoticed for weeks.
NOT_DEPLOYED_OK = {
    "pool": {"blocktest.mjs", "coinbasetest.mjs", "duptest.mjs",
             "storetest.mjs", "testminer.mjs"},
    "market": {"gen_ladder.mjs", "ops-send-test.mjs", "announce-spool-test.mjs", "ipn-deploy-test.sh",
               "ipn-deploy.sh", "ipn-e2e-test.mjs", "ipn-test.mjs", "ladder-index-test.mjs", "price-feed-test.mjs"},
    "admin": {"send-test.mjs", "transfer-test.mjs", "transfer-crypto.entry.mjs", "admin-gate-test.mjs",
              "exchange-preview.mjs", "exchange-preview-drive.mjs", "exchange-preview-cf-drive.mjs",
              "pay-hot-test.mjs", "pay-keeper-test.mjs", "price-feed-test.mjs", "wrap-code-test.mjs"},
    "wpcn-pay": {"rate-test.mjs"},
    "pcnaibot": {"livetest.mjs"},
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
    # Deployed here, but their one source lives elsewhere in the repo. Compared
    # against that source rather than a copy, because a copy is a second thing
    # to go stale.
    borrowed = spec[5] if len(spec) > 5 else {}  # remote name -> repo path

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
    for remote_name, repo_path in borrowed.items():
        f = ROOT / repo_path
        if f.is_file():
            local[remote_name] = norm(f.read_bytes())

    # LISTED WITH find, NOT A SHELL GLOB. In POSIX sh "**" is just "*", so
    # "**/*.py" matches exactly one level deep and silently skips the top level
    # and anything nested further. It happens to cover contrib/explorer today
    # because every package there is one level down -- which is luck, not a
    # property, and a pattern that looks recursive and is not is precisely how
    # an audit reports a directory clean without having read it.
    finds = []
    for g in globs:
        if g.startswith("**/"):
            finds.append(f"find . -type f -name '{g[3:]}'")
        elif "/" in g:
            d, _, base = g.rpartition("/")
            finds.append(f"find ./{d} -maxdepth 1 -type f -name '{base}'")
        else:
            finds.append(f"find . -maxdepth 1 -type f -name '{g}'")
    pat = "{ " + "; ".join(finds) + r"; } 2>/dev/null | sed 's#^\./##' | sort -u"

    rc, out, err = sh(f'ssh -o ConnectTimeout=20 -o BatchMode=yes -i {key} {target} '
                      f'"cd {remote} 2>/dev/null && {pat}"')
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
        f'"cd {remote} && {pat} | while read -r f; do '
        f'echo \'{SEP}\'\\"$f\\"; cat \\"$f\\"; done"')
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


# ── /usr/local/bin: the scripts that WATCH the money ────────────────────────
#
# Everything above audits a directory under /opt. The monitors do not live
# there: they are installed one file at a time into /usr/local/bin, on four
# hosts, by hand. 198 of them were installed against 60 tracked candidates and
# NOTHING had ever compared the two -- so a monitor edited on a server to
# silence a false alarm would stay edited, invisibly, while the repo copy that
# looks authoritative is a different program.
#
# A script MISSING from a host is not a finding: pcoin-pool-* belongs on the
# pool hosts and nowhere else. Two things are findings -- a file that DIFFERS
# from the repo, and a file installed that the repo does not have at all. The
# second is operational code with exactly one copy, which is the class this
# project has now found four times.
BIN_DIR = "/usr/local/bin"

# Units, docs and configs share the pcoin- prefix and are not installed as
# scripts; comparing them would report drift that cannot exist.
NOT_A_SCRIPT = ("service", "timer", "md", "json", "conf", "example",
                "socket", "target", "sql", "html", "css")


# Installed under a different name from the file in the repo. Named here one
# at a time rather than guessed: a guess would compare against the wrong file,
# and both of these were reported as drift while being byte-identical.
INSTALLED_AS = {
    "pcoin-deploy": "contrib/deploy/deploy.sh",
    "pcoin-electrumx-check": "contrib/electrumx/check-electrumx.py",
}


def repo_scripts():
    """basename -> normalised bytes, for every tracked script under contrib/."""
    rc, out, _ = sh('git -C "%s" ls-files contrib' % ROOT)
    found = {}
    for rel in out.splitlines():
        rel = rel.strip()
        if not rel:
            continue
        name = rel.rsplit("/", 1)[-1]
        if not (name.startswith("pcoin-") or name.startswith("ipv4-")):
            continue
        if name.rsplit(".", 1)[-1] in NOT_A_SCRIPT:
            continue
        try:
            body = norm((ROOT / rel).read_bytes())
        except OSError:
            continue
        # Two tracked files with one basename: whichever sorted last used to
        # win SILENTLY. It happened -- a stale ops-dashboard copy of
        # pcoin-pool-collect was only right by the accident of path order.
        if name in found and found[name] != body:
            print("  WARNING: two different tracked files are named %s; "
                  "comparing against %s" % (name, rel))
        found[name] = body
    for name, rel in INSTALLED_AS.items():
        try:
            found[name] = norm((ROOT / rel).read_bytes())
        except OSError:
            pass
    return found


def audit_bin(hosts):
    import hashlib
    repo = repo_scripts()
    print("  %d tracked script(s) in the repo" % len(repo))
    print("")
    problems = 0
    unknown_all = {}
    for label, spec in hosts.items():
        target, key = spec["ssh"], spec["key"]
        cmd = ("ls %s 2>/dev/null | grep -E '^(pcoin-|ipv4-)' | "
               "while read -r f; do sha256sum %s/$f; done" % (BIN_DIR, BIN_DIR))
        rc, out, err = sh("ssh -o ConnectTimeout=20 -o BatchMode=yes -i %s %s \"%s\""
                          % (key, target, cmd))
        if rc != 0 or not out.strip():
            # An unreachable host is UNKNOWN, never clean (CLAUDE.md 7.1).
            print("  == %-24s COULD NOT LIST %s -- UNKNOWN, not clean"
                  % (label, BIN_DIR))
            problems += 1
            continue

        installed = {}
        for line in out.splitlines():
            parts = line.split(None, 1)
            if len(parts) != 2:
                continue
            name = parts[1].strip().rsplit("/", 1)[-1]
            # BACKUPS ARE NOT DEPLOYMENTS. Every careful install leaves a
            # .bak-<something> beside the file it replaced, and the first run
            # of this reported 100+ of them as "not in the repo" -- burying
            # the handful of real findings in a list nobody would read twice.
            # Two backup conventions are in use: name.bak-<when> and
            # name.pre-<change>. Both are snapshots a careful install left
            # behind, neither is a deployment, and the first run of this
            # reported 100+ of them and buried the six real findings.
            if ".bak" in name or ".pre-" in name or name.endswith(".discord-pending"):
                continue
            installed[name] = parts[0]

        differ, unknown = [], []
        for name, h in sorted(installed.items()):
            # Some scripts are TRACKED with an extension and INSTALLED without
            # one (pcoin-payout-announce.py -> pcoin-payout-announce). Same
            # file, two names; reporting it as untracked is a false finding.
            key = (name if name in repo else
                   next((c for c in (name + ".py", name + ".sh", name + ".mjs")
                         if c in repo), name))
            if key in repo:
                if hashlib.sha256(repo[key]).hexdigest() != h:
                    differ.append(name)
                continue
            if name not in repo:
                unknown.append(name)
                unknown_all.setdefault(name, []).append(label)

        ok = len(installed) - len(differ) - len(unknown)
        print("  == %-24s %3d installed, %3d match, %d DIFFER, %d not in the repo"
              % (label, len(installed), ok, len(differ), len(unknown)))
        for n in differ:
            print("       DIFFERS  %s" % n)
            problems += 1

    if unknown_all:
        print("")
        print("  installed but NOT IN THE REPO (%d) -- one copy each, on the host only:"
              % len(unknown_all))
        for n, where in sorted(unknown_all.items()):
            print("       %-36s %s" % (n, ", ".join(where)))
        problems += len(unknown_all)
    return problems


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

    # "bin" is not a directory deployment: it is every installed monitor
    # script across every host, compared by basename. See audit_bin().
    if a.which == ["bin"]:
        hosts = targets.get("_bin_hosts") or {}
        if not hosts:
            print("no _bin_hosts in " + TARGETS_FILE.name, file=sys.stderr)
            return 2
        print("")
        print("== /usr/local/bin across %d host(s)" % len(hosts))
        n = audit_bin(hosts)
        print("")
        print("%d problem(s)" % n)
        return 1 if n else 0

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
