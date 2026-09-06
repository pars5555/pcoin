#!/usr/bin/env python3
"""Minimal Chrome DevTools Protocol client for the project's dedicated Edge.

    python cdp.py list
    python cdp.py open  <url>
    python cdp.py eval  <url-substring> <javascript>
    python cdp.py text  <url-substring>          # visible text of the page
    python cdp.py close <url-substring>

WHY IT IS DELIBERATELY SMALL
CLAUDE.md 8 requires all browser work to go through the dedicated Edge on port
9761, and records two failures worth designing against:

  - A client that calls Runtime.enable / Page.enable / DOM.enable drowns in
    events on a busy page (x.com was the case that cost a session), and every
    request then times out on a page that is perfectly healthy. This client
    enables NOTHING; Runtime.evaluate needs no domain enabled.

  - The websocket handshake must send no Origin header, or Chrome rejects it
    with 403. `suppress_origin=True` is the whole fix and is easy to lose.

It is a tool, not a framework: one request, one reply, no session state. That
is enough to read a page and fill a form, and it cannot wedge itself.
"""
import json
import sys
import urllib.request

# Windows consoles default to cp1252, and a page that answers with an emoji
# then kills the client on print() rather than on anything to do with the
# browser -- which reads as "the automation failed" when it had already
# succeeded. Force UTF-8 out before anything can be printed.
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

try:
    import websocket                       # websocket-client
except ImportError:
    sys.exit("pip install websocket-client")

PORT = 9761
BASE = "http://127.0.0.1:%d" % PORT


def targets():
    with urllib.request.urlopen(BASE + "/json/list", timeout=10) as r:
        return [t for t in json.loads(r.read()) if t.get("type") == "page"]


def pick(sub):
    hits = [t for t in targets() if sub.lower() in (t.get("url") or "").lower()]
    if not hits:
        sys.exit("no tab whose URL contains %r. Open one first." % sub)
    return hits[0]


def call(target, method, params=None, timeout=45):
    ws = websocket.create_connection(target["webSocketDebuggerUrl"],
                                     timeout=timeout, suppress_origin=True)
    try:
        ws.send(json.dumps({"id": 1, "method": method, "params": params or {}}))
        while True:
            msg = json.loads(ws.recv())
            if msg.get("id") == 1:          # ignore any unsolicited event
                return msg
    finally:
        ws.close()


def evaluate(target, expr, timeout=45):
    msg = call(target, "Runtime.evaluate",
               {"expression": expr, "returnByValue": True,
                "awaitPromise": True, "userGesture": True}, timeout)
    res = (msg.get("result") or {})
    if res.get("exceptionDetails"):
        det = res["exceptionDetails"]
        return {"error": (det.get("exception") or {}).get("description") or det.get("text")}
    return {"value": (res.get("result") or {}).get("value")}


def main(argv):
    if len(argv) < 2:
        sys.exit(__doc__)
    cmd = argv[1]
    if cmd == "list":
        for t in targets():
            print("%s  %s\n    %s" % (t["id"][:8], (t.get("title") or "")[:60],
                                      (t.get("url") or "")[:100]))
        return
    if cmd == "open":
        req = urllib.request.Request(BASE + "/json/new?" + argv[2], method="PUT")
        with urllib.request.urlopen(req, timeout=15) as r:
            d = json.loads(r.read())
        print("opened %s\n%s" % (d["id"][:8], d.get("url")))
        return
    if cmd == "close":
        t = pick(argv[2])
        with urllib.request.urlopen(BASE + "/json/close/" + t["id"], timeout=10) as r:
            print(r.read().decode())
        return
    if cmd == "eval":
        out = evaluate(pick(argv[2]), argv[3])
        print(json.dumps(out.get("error") or out.get("value"), indent=2,
                         ensure_ascii=False) if not isinstance(out.get("value"), str)
              else out["value"])
        return
    if cmd == "text":
        out = evaluate(pick(argv[2]),
                       "document.body.innerText.replace(/\\n{3,}/g,'\\n\\n')")
        print(out.get("value") or out.get("error"))
        return
    sys.exit("unknown command %r" % cmd)


if __name__ == "__main__":
    main(sys.argv)
