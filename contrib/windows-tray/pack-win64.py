#!/usr/bin/env python3
"""Pack the Windows release zip.

    python pack-win64.py --version 1.3.3 --node-zip <old pcoin-win64-miner.zip>

LAYOUT. Only the miner sits at the root; the node binaries move into bin\.
Four .exe files in one folder told a user nothing about which to run -- and the
one to run, PCoinTray.exe, was the smallest and least obvious of them.

    pcoin-<ver>/
      PCoinTray.exe      the thing you double-click
      START HERE.txt
      uninstall.ps1      what Settings > Apps > Uninstall runs
      bin/bitcoind.exe
      bin/bitcoin-cli.exe
      COPYING

THE UNINSTALLER MUST BE IN THE ZIP. install.ps1 writes the Settings > Apps
entry only when uninstall.ps1 is on disk after the copy -- an UninstallString
pointing at a file that was never installed is the v1.2.3 bug over again. This
script did not ship it, while the release it was written against was packed by
hand WITH it, so re-packing from here alone would have quietly removed the
Apps-list entry from every new install and reported success doing it.

FILENAMES DO NOT CHANGE. PCoinTray.exe is named in both installers, the logon
scheduled task and six source files; bitcoin-cli.exe is called by name from
mine.ps1 and the tray. Moving them is safe, renaming them is not.

NEVER Compress-Archive. It writes entry names containing backslashes, so the
whole tree unpacks on Linux and macOS as a few files with \ in their names.
zipfile writes forward slashes; the assert below refuses to ship otherwise.
"""
import argparse, hashlib, os, shutil, sys, tempfile, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))

START_HERE = """PCoin -- what to run
====================

  Double-click  PCoinTray.exe

That is the miner. It starts the node for you and puts an icon in your system
tray; everything else is driven from there.

  bin\        the node itself (bitcoind) and its command-line tool. You do not
              need to open these -- PCoinTray.exe runs them for you.
  COPYING     licence.

Prefer one command instead? In PowerShell:

  & ([scriptblock]::Create((irm https://pc.am/dl/mine.ps1)))

That installs, waits for the chain to sync, asks where to pay you, and starts
mining -- no unzipping and nothing to place by hand.
"""

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", required=True)
    ap.add_argument("--node-zip", required=True,
                    help="a previous pcoin-win64-miner.zip to take bitcoind/bitcoin-cli from")
    ap.add_argument("--tray", default=os.path.join(HERE, "PCoinTray.exe"))
    ap.add_argument("--uninstaller", default=os.path.join(HERE, "uninstall.ps1"))
    ap.add_argument("--out", default=None)
    a = ap.parse_args()

    top = "pcoin-%s" % a.version
    out = a.out or os.path.join(HERE, "pcoin-win64-miner.zip")
    if not os.path.isfile(a.tray):
        sys.exit("no PCoinTray.exe at %s -- run build.bat first" % a.tray)
    # Refuse rather than warn: a zip without this installs cleanly, reports
    # success, and leaves the user no way to remove PCoin from Settings.
    if not os.path.isfile(a.uninstaller):
        sys.exit("no uninstall.ps1 at %s" % a.uninstaller)

    tmp = tempfile.mkdtemp(prefix="pcoinpack")
    try:
        with zipfile.ZipFile(a.node_zip) as z:
            names = z.namelist()
            def grab(base):
                hits = [n for n in names if n.rsplit("/", 1)[-1].lower() == base.lower()]
                if len(hits) != 1:
                    sys.exit("expected exactly one %s in %s, found %d" % (base, a.node_zip, len(hits)))
                dest = os.path.join(tmp, base)
                with z.open(hits[0]) as src, open(dest, "wb") as fh:
                    shutil.copyfileobj(src, fh)
                return dest
            bitcoind = grab("bitcoind.exe")
            bitcoincli = grab("bitcoin-cli.exe")
            copying = grab("COPYING")

        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
            z.write(a.tray,   "%s/PCoinTray.exe" % top)
            z.write(a.uninstaller, "%s/uninstall.ps1" % top)
            z.writestr("%s/START HERE.txt" % top, START_HERE.replace("\n", "\r\n"))
            z.write(bitcoind,   "%s/bin/bitcoind.exe" % top)
            z.write(bitcoincli, "%s/bin/bitcoin-cli.exe" % top)
            z.write(copying,  "%s/COPYING" % top)

        with zipfile.ZipFile(out) as z:
            names = z.namelist()
            bad = [n for n in names if "\\" in n]
            assert not bad, "backslashes in entry names: %r" % bad
            roots = {n[len(top) + 1:] for n in names}
            exes_at_root = [n for n in roots if n.lower().endswith(".exe") and "/" not in n]
            assert exes_at_root == ["PCoinTray.exe"], \
                "exactly one exe belongs at the root, found %r" % exes_at_root
            # A check that only prints is not a check (CLAUDE.md 7.12).
            assert "uninstall.ps1" in roots, \
                "uninstall.ps1 is missing: every new install would lose its " \
                "Settings > Apps entry, and the install would still say it worked"

        sha = hashlib.sha256(open(out, "rb").read()).hexdigest()
        print("wrote %s" % out)
        for n in sorted(names):
            print("   %s" % n)
        print("\nsha256 %s" % sha)
        print("\nPut this in install.ps1 -- $Version AND $Sha256 move together:")
        print('    [string]$Version = %r,' % a.version)
        print('    [string]$Sha256  = %r,' % sha)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

main()
