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
import os
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
    if cmd == "type":
        # Input.insertText delivers text the way a real keystroke arrives.
        # document.execCommand('insertText') does NOT survive a Draft.js editor
        # (x.com): multi-line text comes back with the lines re-ordered and URLs
        # split mid-string. Focus the field with `eval` first.
        t = pick(argv[2])
        text = argv[3] if len(argv) > 3 else sys.stdin.read()
        msg = call(t, "Input.insertText", {"text": text})
        print("inserted %d chars: %s" % (len(text),
              "ok" if not msg.get("error") else msg["error"]))
        return

    if cmd == "click":
        # A real, trusted mouse event at page coordinates. Some React cards
        # ignore a dispatched MouseEvent (they listen on pointer events with
        # capture, or check isTrusted), so scripted .click() silently does
        # nothing -- which looks exactly like a page that failed to load.
        # Pass x,y from an `eval` that returns getBoundingClientRect centres.
        t = pick(argv[2])
        x, y = float(argv[3]), float(argv[4])
        for kind in ("mousePressed", "mouseReleased"):
            call(t, "Input.dispatchMouseEvent",
                 {"type": kind, "x": x, "y": y, "button": "left",
                  "clickCount": 1, "buttons": 1 if kind == "mousePressed" else 0})
        print("clicked at %g,%g" % (x, y))
        return

    if cmd == "shot":
        # When the DOM does not explain what a page is doing, look at it
        # (CLAUDE.md 8). Writes a PNG; no domain needs enabling for this.
        import base64
        t = pick(argv[2])
        out = argv[3] if len(argv) > 3 else "shot.png"
        msg = call(t, "Page.captureScreenshot", {"format": "png"}, timeout=60)
        data = ((msg.get("result") or {}).get("data"))
        if not data:
            print("no image: %s" % msg.get("error") or msg)
            return
        with open(out, "wb") as fh:
            fh.write(base64.b64decode(data))
        print("wrote %s (%d bytes)" % (out, len(base64.b64decode(data))))
        return

    if cmd == "upload":
        # Set a file input's files. A file chooser cannot be driven from script,
        # so this is the only way to satisfy a required upload.
        #
        # Both calls MUST share one websocket: a remote objectId is scoped to the
        # connection that produced it, and this client otherwise opens a fresh
        # connection per call -- which fails with "Could not find object with
        # given id", a message that reads like a bad selector and is not.
        t = pick(argv[2])
        selector, path = argv[3], os.path.abspath(argv[4])
        if not os.path.exists(path):
            sys.exit("no such file: %s" % path)
        ws = websocket.create_connection(t["webSocketDebuggerUrl"], timeout=45,
                                         suppress_origin=True)
        try:
            def send(i, method, params):
                ws.send(json.dumps({"id": i, "method": method, "params": params}))
                while True:
                    m = json.loads(ws.recv())
                    if m.get("id") == i:
                        return m
            r1 = send(1, "Runtime.evaluate",
                      {"expression": "document.querySelector(%r)" % selector,
                       "returnByValue": False})
            obj = (((r1.get("result") or {}).get("result")) or {}).get("objectId")
            if not obj:
                sys.exit("selector matched nothing: %s" % selector)
            r2 = send(2, "DOM.setFileInputFiles", {"files": [path], "objectId": obj})
            print("uploaded %s -> %s%s" % (os.path.basename(path), selector,
                  "" if not r2.get("error") else "  ERROR: %s" % r2["error"]))
        finally:
            ws.close()
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
