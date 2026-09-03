#!/usr/bin/env python3
"""Pack the Windows WALLET release zip.

    python pack-win64-wallet.py --version 1.4.0 --node-zip <a pcoin-win64-miner.zip>

The same layout rules as pack-win64.py (the miner), for the same reasons:

    pcoin-<ver>/
      PCoinWallet.exe     the thing you double-click
      START HERE.txt
      bin/bitcoind.exe    the wallet's OWN node -- never shared with the miner
      bin/bitcoin-cli.exe
      COPYING

The node binaries are taken from a miner release zip: they are the same
build, and the wallet must ship its own copy because it runs its own node in
its own folder (see PCoinWallet.cs). Exactly one exe at the root, asserted.

NEVER Compress-Archive. It writes entry names containing backslashes, so the
whole tree unpacks on Linux and macOS as a few files with \ in their names.
zipfile writes forward slashes; the assert below refuses to ship otherwise.
"""
import argparse, hashlib, os, shutil, sys, tempfile, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))

START_HERE = """PCoin Wallet -- what to run
===========================

  Double-click  PCoinWallet.exe

That is the wallet. It runs its own PCoin node beside it (in the data folder
next to this file), asks you to create or restore your twelve words, and
shows your address as text and as a QR code. Send, History and the Address
book are buttons in the window.

  bin\        the node itself (bitcoind) and its command-line tool. You do not
              need to open these -- PCoinWallet.exe runs them for you.
  COPYING     licence.

The same twelve words open your wallet in the PCoin Wallet app on Android.
Keep them on paper. Anyone who has the words has the coins.

This program does not mine and does not need the PCoin miner. If the miner is
also installed on this PC the two run side by side, each with its own node.

Prefer one command instead? In PowerShell:

  irm https://pc.am/dl/install-wallet.ps1 | iex
"""

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", required=True)
    ap.add_argument("--node-zip", required=True,
                    help="a pcoin-win64-miner.zip to take bitcoind/bitcoin-cli from")
    ap.add_argument("--wallet", default=os.path.join(HERE, "PCoinWallet.exe"))
    ap.add_argument("--uninstaller", default=os.path.join(HERE, "uninstall-wallet.ps1"))
    ap.add_argument("--out", default=None)
    a = ap.parse_args()

    top = "pcoin-%s" % a.version
    out = a.out or os.path.join(HERE, "pcoin-win64-wallet.zip")
    if not os.path.isfile(a.wallet):
        sys.exit("no PCoinWallet.exe at %s -- run build-wallet.bat first" % a.wallet)
    if not os.path.isfile(a.uninstaller):
        sys.exit("no uninstall-wallet.ps1 at %s" % a.uninstaller)

    tmp = tempfile.mkdtemp(prefix="pcoinwpack")
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
            z.write(a.wallet, "%s/PCoinWallet.exe" % top)
            z.write(a.uninstaller, "%s/uninstall-wallet.ps1" % top)
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
            assert exes_at_root == ["PCoinWallet.exe"], \
                "exactly one exe belongs at the root, found %r" % exes_at_root

        sha = hashlib.sha256(open(out, "rb").read()).hexdigest()
        print("wrote %s" % out)
        for n in sorted(names):
            print("   %s" % n)
        print("\nsha256 %s" % sha)
        print("\nPut this in install-wallet.ps1 -- $Version AND $Sha256 move together:")
        print('    [string]$Version = %r,' % a.version)
        print('    [string]$Sha256  = %r,' % sha)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

main()
