#!/usr/bin/env python3
"""Run a PowerShell script on an AI Control device with NO quoting problems.

    python psb64.py <device> <script-file>
    ... | python psb64.py <device> -

WHY THIS EXISTS
CLAUDE.md 7.8: the transport mutates quotes in transit. Double quotes are
stripped outright, and doubled single quotes do not survive either, so a script
that is correct locally arrives as a syntax error -- which reads as a broken
device rather than a broken transport. Writing quote-free PowerShell is possible
but crippling: you cannot even assign a path to a variable, because a bare path
is parsed as a command.

powershell.exe -EncodedCommand takes base64 of UTF-16LE and needs no quotes on
the command line at all, so nothing the transport can mangle is left. The script
itself may then contain any quotes it likes.
"""
import base64, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ac

def main(a):
    if len(a) < 3:
        sys.exit(__doc__)
    dev = ac.resolve(a[1])
    script = sys.stdin.read() if a[2] == "-" else open(a[2], encoding="utf-8").read()
    enc = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
    # run_shell, not run_powershell: this is a bare command line, no quotes in it.
    ac.show(ac.call(dev, "run_shell",
                    {"command": "powershell -NoProfile -NonInteractive -EncodedCommand " + enc,
                     "timeout_ms": 180000}, timeout=200))

if __name__ == "__main__":
    main(sys.argv)
