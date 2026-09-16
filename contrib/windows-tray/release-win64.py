#!/usr/bin/env python3
"""Cut a Windows miner release, all of it, and prove it afterwards.

    release-win64.py --version 1.4.31 --node-zip <path to the node zip>
    release-win64.py --version 1.4.31 --node-zip ... --dry-run
    release-win64.py --version 1.4.31 --verify-only

WHY THIS EXISTS. A Windows release touches four places and a release is only as
good as the one you forgot:

    1. the GitHub release and its asset
    2. install.ps1's $Version AND $Sha256 -- in the repo
    3. the SAME install.ps1 deployed at pc.am/dl/
    4. pc.am/dl/SHA256SUMS.txt

Forgetting 2 or 3 breaks every new install, because install.ps1 refuses on a hash
mismatch. Forgetting 4 leaves the tray asking a stale list "what is the latest?".
Both have happened. In September 2026 something worse happened: v1.4.29 and
v1.4.30 both shipped with the exe reporting 1.4.28, so every miner was told to
update into the build they were already running, twice, and nobody noticed until
a user said so on Discord.

So this does all four, and then CHECKS ALL FOUR FROM THE OUTSIDE -- downloading
what the public downloads rather than trusting what it just uploaded. It refuses
at every step instead of warning: a check that only prints is not a check.

WHAT IT WILL NOT DO. It does not build. Run build.bat yourself and look at it.
It does not invent a version: --version must match Version.cs AND the compiled
binary, which is the check that would have caught the September releases.
"""
import argparse
import hashlib
import io
import os
import re
import subprocess
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
ASSET = "pcoin-win64-miner.zip"
PCAM_HOST = os.environ.get("PCAM_HOST", "rba@35.239.156.16")
PCAM_DL = "/var/www/pc.am/dl"
GH_REPO = os.environ.get("GH_REPO", "pars5555/pcoin")


def die(msg):
    sys.exit("REFUSING: " + msg)


def run(cmd, **kw):
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=kw.pop("timeout", 300), **kw)
    if r.returncode != 0:
        die("%s failed: %s" % (cmd[0], (r.stderr or r.stdout).strip()[:400]))
    return r.stdout


def fetch(url, timeout=120, fresh=False):
    """Read a URL. With fresh=True, go past the CDN.

    pc.am sits behind Cloudflare with max-age=60, so a file written a moment ago
    still serves its old body to the public for up to a minute. The first run of
    this tool duly reported the release INCOMPLETE while the origin was perfectly
    correct -- a verifier that cries wolf is one people learn to ignore, which is
    worse than no verifier. A unique query string is not in the cache, so it comes
    from the origin.
    """
    if fresh:
        url += ("&" if "?" in url else "?") + "cb=" + str(int(__import__("time").time() * 1000))
    req = urllib.request.Request(url, headers={"User-Agent": "pcoin-release/1.0",
                                               "Cache-Control": "no-cache", "Pragma": "no-cache"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def binary_versions(path):
    """Every dotted version inside the compiled exe. csc writes constants as
    UTF-16 literals, so they can be read without a decompiler."""
    blob = open(path, "rb").read()
    return sorted(set(re.findall(r"\d+\.\d+\.\d+", blob.decode("utf-16-le", "ignore"))))


def source_version():
    m = re.search(r'Version\s*=\s*"([^"]+)"', io.open(os.path.join(HERE, "Version.cs"), encoding="utf-8").read())
    return m.group(1) if m else None


# ---------------------------------------------------------------- the checks
def verify(version, sha, quiet=False):
    """Prove the release from OUTSIDE, the way a user meets it. Returns a list of
    failures; empty means the release is actually complete."""
    bad = []
    say = (lambda *a: None) if quiet else print

    # 1. The published asset, downloaded, hashed, and opened.
    url = "https://github.com/%s/releases/download/v%s/%s" % (GH_REPO, version, ASSET)
    try:
        blob = fetch(url)
    except Exception as e:                                    # noqa: BLE001
        bad.append("the published asset could not be downloaded (%s)" % type(e).__name__)
        blob = None
    if blob is not None:
        got = hashlib.sha256(blob).hexdigest()
        say("  asset downloaded      : %d bytes" % len(blob))
        if got != sha:
            bad.append("the published asset hashes %s, not %s" % (got[:16], sha[:16]))
        else:
            say("  asset sha256          : matches")
        # And the version INSIDE it -- the thing September got wrong.
        import zipfile, tempfile
        with tempfile.TemporaryDirectory() as td:
            zp = os.path.join(td, "a.zip")
            open(zp, "wb").write(blob)
            with zipfile.ZipFile(zp) as z:
                names = [n for n in z.namelist() if n.endswith("PCoinTray.exe")]
                if len(names) != 1:
                    bad.append("the published zip contains %d PCoinTray.exe" % len(names))
                else:
                    ep = os.path.join(td, "PCoinTray.exe")
                    with z.open(names[0]) as src, open(ep, "wb") as fh:
                        fh.write(src.read())
                    vs = binary_versions(ep)
                    if version not in vs:
                        bad.append("the PUBLISHED exe does not contain %s (it has: %s)" % (version, ", ".join(vs)))
                    else:
                        say("  version inside the exe: %s" % version)

    # 2 and 3. install.ps1, as the public gets it.
    try:
        live = fetch("https://pc.am/dl/install.ps1", timeout=40, fresh=True).decode("utf-8", "replace")
    except Exception as e:                                    # noqa: BLE001
        bad.append("pc.am/dl/install.ps1 unreadable (%s)" % type(e).__name__)
        live = ""
    lv = re.search(r"\$Version\s*=\s*'([^']+)'", live)
    ls = re.search(r"\$Sha256\s*=\s*'([^']+)'", live)
    if not lv or lv.group(1) != version:
        bad.append("pc.am install.ps1 pins %s, not %s" % (lv.group(1) if lv else "nothing", version))
    elif not ls or ls.group(1) != sha:
        bad.append("pc.am install.ps1 carries the wrong $Sha256")
    else:
        say("  pc.am install.ps1     : %s + matching hash" % version)

    repo_ps1 = io.open(os.path.join(HERE, "install.ps1"), encoding="utf-8-sig").read()
    if live and hashlib.sha256(live.encode()).hexdigest() != hashlib.sha256(repo_ps1.encode()).hexdigest():
        # Not fatal by itself -- line endings differ legitimately -- so compare
        # the two things that decide whether an install works.
        rv = re.search(r"\$Version\s*=\s*'([^']+)'", repo_ps1)
        rs = re.search(r"\$Sha256\s*=\s*'([^']+)'", repo_ps1)
        if not rv or rv.group(1) != version or not rs or rs.group(1) != sha:
            bad.append("the REPO install.ps1 disagrees with the release")
        else:
            say("  repo install.ps1      : %s + matching hash (bytes differ from live: line endings)" % version)
    else:
        say("  repo install.ps1      : identical to the live one")

    # 4. The checksum list the tray reads to answer "am I out of date?".
    try:
        sums = fetch("https://pc.am/dl/SHA256SUMS.txt", timeout=40, fresh=True).decode("utf-8", "replace")
    except Exception as e:                                    # noqa: BLE001
        bad.append("pc.am/dl/SHA256SUMS.txt unreadable (%s)" % type(e).__name__)
        sums = ""
    pending, found = None, None
    for line in sums.split("\n"):
        f = re.match(r"^#\s*from release v?([0-9][0-9.]*)\s*$", line.strip())
        if f:
            pending = f.group(1)
            continue
        m = re.match(r"^([0-9a-f]{64})\s+\*?(\S+)\s*$", line.strip())
        if m:
            if m.group(2).lower() == ASSET.lower():
                found = (pending, m.group(1))
            pending = None
    if not found:
        bad.append("SHA256SUMS.txt does not name %s" % ASSET)
    elif found[0] != version or found[1] != sha:
        bad.append("SHA256SUMS.txt says %s/%s for %s" % (found[0], found[1][:12], ASSET))
    else:
        say("  pc.am SHA256SUMS.txt  : %s + matching hash" % version)

    return bad


# ---------------------------------------------------------------- the release
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", required=True)
    ap.add_argument("--node-zip", default=None, help="the node zip pack-win64.py takes")
    ap.add_argument("--notes", default=None, help="file with the release notes")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--verify-only", action="store_true")
    a = ap.parse_args()
    v = a.version

    if a.verify_only:
        zip_path = os.path.join(HERE, ASSET)
        if not os.path.isfile(zip_path):
            die("no local %s to take the hash from; pass the one you released" % ASSET)
        sha = hashlib.sha256(open(zip_path, "rb").read()).hexdigest()
        print("verifying v%s (%s) from the outside" % (v, sha[:16]))
        bad = verify(v, sha)
        if bad:
            print("\nINCOMPLETE:")
            for b in bad:
                print("  - " + b)
            return 1
        print("\nthe release is complete and consistent on all four surfaces.")
        return 0

    # ---- preflight: the version has to agree in three places -----------------
    sv = source_version()
    if sv != v:
        die("Version.cs says %s, --version says %s" % (sv, v))
    tray = os.path.join(HERE, "PCoinTray.exe")
    if not os.path.isfile(tray):
        die("no PCoinTray.exe -- run build.bat")
    vs = binary_versions(tray)
    if v not in vs:
        die("PCoinTray.exe does not contain %s (it has: %s). Run build.bat after bumping Version.cs."
            % (v, ", ".join(vs)))
    print("preflight: Version.cs, --version and the compiled binary all say %s" % v)

    if not a.node_zip:
        die("--node-zip is required to pack (or use --verify-only)")

    # ---- 1. pack --------------------------------------------------------------
    out = os.path.join(HERE, ASSET)
    cmd = [sys.executable, os.path.join(HERE, "pack-win64.py"), "--version", v,
           "--node-zip", a.node_zip, "--tray", tray, "--out", out]
    if a.dry_run:
        print("dry run: would pack with %s" % " ".join(cmd[1:]))
    else:
        run(cmd)
    sha = hashlib.sha256(open(out, "rb").read()).hexdigest() if os.path.isfile(out) else "0" * 64
    print("packed %s  sha256 %s" % (ASSET, sha))

    # ---- 2. the GitHub release ------------------------------------------------
    notes = io.open(a.notes, encoding="utf-8").read() if a.notes else ("PCoin Windows miner v%s" % v)
    if a.dry_run:
        print("dry run: would create release v%s and upload %s" % (v, ASSET))
    else:
        existing = subprocess.run(["gh", "release", "view", "v" + v, "--repo", GH_REPO],
                                  capture_output=True, text=True)
        if existing.returncode != 0:
            run(["gh", "release", "create", "v" + v, "--repo", GH_REPO, "--title",
                 "v%s - Windows miner" % v, "--notes", notes])
        run(["gh", "release", "upload", "v" + v, out, "--repo", GH_REPO, "--clobber"])
        print("uploaded to the v%s release" % v)

    # ---- 3. install.ps1, in the repo and on pc.am ----------------------------
    ps1_path = os.path.join(HERE, "install.ps1")
    ps1 = io.open(ps1_path, encoding="utf-8-sig").read()
    ps1_new = re.sub(r"(\$Version\s*=\s*')[^']+(')", r"\g<1>%s\g<2>" % v, ps1, count=1)
    ps1_new = re.sub(r"(\$Sha256\s*=\s*')[^']+(')", r"\g<1>%s\g<2>" % sha, ps1_new, count=1)
    if "$Version = '%s'" % v not in ps1_new or "$Sha256 = '%s'" % sha not in ps1_new:
        die("could not rewrite $Version/$Sha256 in install.ps1 -- has its shape changed?")
    if a.dry_run:
        print("dry run: would set install.ps1 to %s / %s" % (v, sha[:16]))
    else:
        io.open(ps1_path, "w", encoding="utf-8", newline="\r\n").write(ps1_new)
        run(["scp", "-o", "StrictHostKeyChecking=no", ps1_path, "%s:/tmp/install.ps1" % PCAM_HOST])
        run(["ssh", "-o", "StrictHostKeyChecking=no", PCAM_HOST,
             "sudo install -m 644 -o root -g root /tmp/install.ps1 %s/install.ps1 && rm -f /tmp/install.ps1" % PCAM_DL])
        print("install.ps1 updated in the repo and on pc.am")

    # ---- 4. SHA256SUMS.txt ---------------------------------------------------
    if a.dry_run:
        print("dry run: would add the %s entry to SHA256SUMS.txt" % ASSET)
    else:
        sums = fetch("https://pc.am/dl/SHA256SUMS.txt", timeout=40, fresh=True).decode("utf-8", "replace")
        lines, out_lines, replaced = sums.split("\n"), [], False
        i = 0
        while i < len(lines):
            m = re.match(r"^([0-9a-f]{64})\s+\*?(\S+)\s*$", lines[i].strip())
            if m and m.group(2).lower() == ASSET.lower():
                # Drop the old entry AND the provenance line above it.
                while out_lines and re.match(r"^#\s*from release", out_lines[-1].strip()):
                    out_lines.pop()
                out_lines.append("# from release v%s" % v)
                out_lines.append("%s  %s" % (sha, ASSET))
                replaced = True
            else:
                out_lines.append(lines[i])
            i += 1
        if not replaced:
            out_lines += ["# from release v%s" % v, "%s  %s" % (sha, ASSET)]
        body = "\n".join(out_lines)
        tmp = os.path.join(HERE, ".SHA256SUMS.new")
        io.open(tmp, "w", encoding="utf-8", newline="\n").write(body)
        run(["scp", "-o", "StrictHostKeyChecking=no", tmp, "%s:/tmp/SHA256SUMS.txt" % PCAM_HOST])
        run(["ssh", "-o", "StrictHostKeyChecking=no", PCAM_HOST,
             "sudo install -m 644 -o root -g root /tmp/SHA256SUMS.txt %s/SHA256SUMS.txt && rm -f /tmp/SHA256SUMS.txt" % PCAM_DL])
        os.remove(tmp)
        print("SHA256SUMS.txt updated on pc.am")

    if a.dry_run:
        print("\ndry run finished: nothing was published.")
        return 0

    # ---- and now prove all four, from outside --------------------------------
    print("\nverifying the release the way a user meets it:")
    bad = verify(v, sha)
    if bad:
        print("\nTHE RELEASE IS INCOMPLETE:")
        for b in bad:
            print("  - " + b)
        return 1
    print("\nv%s is published and consistent on all four surfaces." % v)
    return 0


if __name__ == "__main__":
    sys.exit(main())
