#!/usr/bin/env python3
"""Install the miner watchdog on Windows miners, over the AI Control API.

    python deploy-watchdog.py                 # every Windows miner
    python deploy-watchdog.py VHQ1C8A 6QIOQ5J  # just these

Why a script and not a one-liner: the watchdog source is ~6 KB, and pushing that
through `run_shell` hit "The command line is too long" (the transport caps a
command at windows of 32k, and psb64.py wraps the payload in base64/UTF-16 on
top of that). The agent's own **`write_file` tool** carries it as a request
BODY instead of a command line, so it fits in one call - and the SHA-256 is
verified ON THE DEVICE afterwards, because per CLAUDE.md ?7.6 a transfer that
"returned OK" is not a transfer that landed.

The install step needs elevation to create a task with /rl HIGHEST. These PCs
run UAC with ConsentPromptBehaviorAdmin=0, so `Start-Process -Verb RunAs`
elevates silently (CLAUDE.md ?5).
"""
import hashlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "aicontrol"))
import ac  # noqa: E402

SRC = os.path.join(HERE, "miner-watchdog.ps1")
TARGET = "C:\\PCoin\\miner-watchdog.ps1"
TASK = "PCoinWatchdog"
DEFAULT_DEVICES = ["MAKAVST", "JTIIJES", "5SH2116", "VHQ1C8A", "6QIOQ5J",
                   "AKHQ7BJ", "I5UT4OJ"]

INSTALL = r"""
# SINGLE QUOTES ONLY. The remote-execution transport strips every double quote
# from a script in transit (CLAUDE.md 7.8), which silently turned the version of
# this check that used them into something that printed nothing and then failed
# with HASH-MISMATCH on a file that had transferred correctly.
$ErrorActionPreference='SilentlyContinue'
$h = (Get-FileHash 'C:\PCoin\miner-watchdog.ps1' -Algorithm SHA256).Hash.ToLower()
'on-device sha256: ' + $h
'expected (crlf): __WANT__'
'expected (lf):   __WANT_LF__'
'expected (crlf): __WANT_CRLF__'
'expected (bom):  __WANT_BOM__'
if ($h -ne '__WANT__' -and $h -ne '__WANT_LF__' -and $h -ne '__WANT_CRLF__' -and $h -ne '__WANT_BOM__') { 'HASH-MISMATCH'; exit 2 }
'hash-ok'
$p = Start-Process powershell -Verb RunAs -PassThru -Wait -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','C:\PCoin\miner-watchdog.ps1','-Install')
'elevated install exit: ' + $p.ExitCode
'task present: ' + [bool](schtasks /query /tn PCoinWatchdog 2>$null)
'watchdog log tail:'
Get-Content 'C:\PCoin\watchdog.log' -Tail 3 | ForEach-Object { '  ' + $_ }
"""


def deploy(device):
    # newline='' keeps CRLF: the text path normalises line endings, and the
    # working copy on this Windows box is CRLF, so reading it in text mode
    # silently changed every line and the on-device hash never matched.
    src = open(SRC, encoding="utf-8", newline="").read()
    raw = open(SRC, "rb").read()
    want = hashlib.sha256(raw).hexdigest()
    want_lf = hashlib.sha256(raw.replace(b"\r\n", b"\n")).hexdigest()
    # The agent's write_file stores Windows newlines, so whatever the source
    # uses, the file that lands on a PC hashes as the CRLF form. Same character
    # count, different bytes - that was the whole of the mismatch that sent me
    # looking for a corrupted transfer that had not happened.
    want_crlf = hashlib.sha256(
        raw.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")).hexdigest()
    # ...and it writes UTF-8 WITH a BOM: 6273 bytes for a 6270-character file.
    # That is the hash actually on disk (measured), harmless for PowerShell.
    want_bom = hashlib.sha256(b"\xef\xbb\xbf" + raw.replace(b"\r\n", b"\n")).hexdigest()
    dev = ac.resolve(device)
    r = ac.call(dev, "write_file", {"path": TARGET, "content": src}, timeout=120)
    wrote = str(r)[:120]
    ps = (INSTALL.replace('__WANT__', want)
                .replace('__WANT_LF__', want_lf)
                .replace('__WANT_CRLF__', want_crlf)
                .replace('__WANT_BOM__', want_bom))
    v = ac.call(dev, "run_powershell", {"script": ps, "timeout_ms": 120000}, timeout=180)
    out = (v.get("result") or "") if isinstance(v, dict) else str(v)
    ok = "hash-ok" in out and "task present: True" in out
    print("%-12s %s  (write: %s)" % (device, "OK" if ok else "CHECK", wrote))
    for line in out.strip().splitlines():
        print("    " + line.strip()[:150])
    return ok


def main(argv):
    devices = argv[1:] or DEFAULT_DEVICES
    bad = [d for d in devices if not deploy(d)]
    print("\n%d/%d installed%s" % (len(devices) - len(bad), len(devices),
                                   ("; failed: " + ", ".join(bad)) if bad else ""))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))