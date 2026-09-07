#!/usr/bin/env python3
"""Drive an AI Control device: one tool call, one answer.

    python ac.py devices                       list devices (name, id, platform, online)
    python ac.py sh   <device> <command>       run_shell
    python ac.py ps   <device> <script>        run_powershell   (script may be '-' for stdin)
    python ac.py tool <device> <name> [json]   any MCP tool, arguments as JSON
    python ac.py tools <device> [filter]       list the device's tools

<device> may be a device id OR a substring of its name ("5SH2116", "moto").

WHY THIS EXISTS
CLAUDE.md 5 documents `run_remote.py` as the way to reach the fleet, and 2 records
that it is gone with the rest of the scratchpad. This is its replacement, in the
repository this time.

THREE THINGS IT DOES ON PURPOSE

  It builds the JSON with json.dumps rather than string interpolation. Hand-escaping
  a PowerShell script inside JSON inside a shell fails in a way that returns "Bad
  JSON" from the far end and looks like a device fault (CLAUDE.md 7.8: quotes are
  mutated in transit; assume any string crossing this transport is changed).

  It strips CR from the bearer key. A key read from a file on D: carries \\r, which
  makes the header malformed; the server answers a bare 400 with no body, on every
  path, which reads exactly like "wrong endpoint" and has sent a session down the
  wrong road before.

  It never prints the key, and never echoes the Authorization header.

The key lives in D:\\pc.am\\PCOIN-SECRETS.md section 6, or in $AICONTROL_KEY.
"""
import json
import os
import re
import sys
import urllib.error
import urllib.request

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

BASE = "https://aicontrol.pc.am"
SECRETS = r"D:\pc.am\PCOIN-SECRETS.md"


def key():
    k = os.environ.get("AICONTROL_KEY", "")
    if not k and os.path.exists(SECRETS):
        with open(SECRETS, encoding="utf-8", errors="replace") as fh:
            txt = fh.read()
        m = re.search(r"^\|\s*Access key\s*\|([^|]+)\|", txt, re.M)
        if m:
            k = m.group(1)
    k = k.strip().strip("`").replace("\r", "").replace("\n", "")
    if not k:
        sys.exit("no AI Control key: set AICONTROL_KEY or add it to %s" % SECRETS)
    return k


def api(path, payload=None, timeout=180):
    req = urllib.request.Request(
        BASE + path,
        data=None if payload is None else json.dumps(payload).encode("utf-8"),
        headers={"Authorization": "Bearer " + key(),
                 "Content-Type": "application/json"},
        method="GET" if payload is None else "POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:400]
        sys.exit("HTTP %s from %s: %s" % (e.code, path, body))


def devices():
    d = api("/devices")
    return d if isinstance(d, list) else (d.get("devices") or d.get("data") or [])


def resolve(token):
    """A device id, or a unique substring of a device name."""
    if re.fullmatch(r"[0-9a-f]{16,32}", token or ""):
        return token
    hits = [d for d in devices()
            if token.lower() in (d.get("device_name") or "").lower()]
    if not hits:
        sys.exit("no device matching %r" % token)
    if len(hits) > 1:
        sys.exit("ambiguous %r: " % token +
                 ", ".join("%s (%s)" % (h["device_name"], h["device_id"]) for h in hits))
    return hits[0]["device_id"]


def call(dev, name, args, timeout=180):
    return api("/devices/%s/execute" % dev,
               {"command": "mcp_call", "data": {"name": name, "arguments": args}},
               timeout)


def show(res):
    if isinstance(res, dict) and "result" in res:
        r = res["result"]
        print(r if isinstance(r, str) else json.dumps(r, indent=2, ensure_ascii=False))
        if not res.get("ok", True):
            sys.exit(1)
    else:
        print(json.dumps(res, indent=2, ensure_ascii=False))


def main(a):
    if len(a) < 2:
        sys.exit(__doc__)
    cmd = a[1]
    if cmd == "devices":
        for d in devices():
            print("%-34s %-30s %-8s online=%s" % (
                d.get("device_id"), (d.get("device_name") or "")[:30],
                d.get("platform"), d.get("is_online")))
        return
    dev = resolve(a[2])
    if cmd == "sh":
        show(call(dev, "run_shell", {"command": a[3], "timeout_ms": 120000}))
    elif cmd == "ps":
        script = sys.stdin.read() if a[3] == "-" else a[3]
        show(call(dev, "run_powershell", {"script": script, "timeout_ms": 120000}))
    elif cmd == "tool":
        args = json.loads(a[4]) if len(a) > 4 else {}
        show(call(dev, a[3], args))
    elif cmd == "tools":
        res = api("/devices/%s/execute" % dev, {"command": "list_tools", "data": {}})
        tools = (res.get("result") or {}).get("tools") or []
        pat = a[3] if len(a) > 3 else ""
        for t in tools:
            if not pat or pat.lower() in t["name"].lower():
                print("%-32s %s" % (t["name"], (t.get("description") or "")[:90]))
    else:
        sys.exit("unknown command %r" % cmd)


if __name__ == "__main__":
    main(sys.argv)
