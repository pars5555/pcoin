#!/usr/bin/env python3
"""A HELD item is never auto-published; an unheld one still is. Linux only
(the gate's tick takes a file lock). Run: python3 test_approve_hold.py

Uses a throwaway queue in a temp dir and a fake Telegram: nothing real is read,
written or sent.
"""
import importlib.machinery
import importlib.util
import json
import os
import sys
import tempfile
import types

HERE = os.path.dirname(os.path.abspath(__file__))
tmp = tempfile.mkdtemp()
os.environ["APPROVE_QUEUE"] = os.path.join(tmp, "queue.json")
loader = importlib.machinery.SourceFileLoader("approve", os.path.join(HERE, "pcoin-approve"))
spec = importlib.util.spec_from_loader(loader.name, loader)
ap = importlib.util.module_from_spec(spec)
loader.exec_module(ap)

SENT = []


def fake_api(token, method, params=None, files=None, timeout=None, **kw):
    SENT.append((method, dict(params or {})))
    return {"ok": True, "result": {"message_id": 1000 + len(SENT)}}


OPS = []
ap.api = fake_api
ap.conf = lambda: {"TELEGRAM_TOKEN": "test"}
ap.notify_ops = lambda *a, **k: OPS.append((a, k))
FAILS = []


def check(cond, what):
    print(("ok    " if cond else "FAIL  ") + what)
    if not cond:
        FAILS.append(what)


def submit(text, key, hold=""):
    a = types.SimpleNamespace(dest="group", text=text, caption="", photo=None, key=key,
                              reply_to="1", source="pcoin-group-answer", markdown=False, hold=hold)
    ap.cmd_submit(a)


submit("A how-to answer.", "k-plain")
submit("A money answer.", "k-held", hold="money, price, listing, bounty or withdrawal")
d = ap.load()
check(d["items"][1]["hold"] == "money, price, listing, bounty or withdrawal", "submit --hold is stored on the item")
check(d["items"][0]["hold"] == "", "an ordinary submit has no hold")
check(ap.digest(d["items"][1]) == d["items"][1]["digest"], "the hold is not part of what is approved (digest unchanged)")

ap.cmd_tick(None)                      # asks the owner about both
d = ap.load()
check([i["state"] for i in d["items"]] == ["awaiting", "awaiting"], "both are put to the owner")
asks = [p["text"] for m, p in SENT if m == "sendMessage" and "APPROVAL NEEDED" in p.get("text", "")]
check(any("WAITS FOR YOUR DECISION" in t for t in asks), "the held prompt says it waits for a decision")
check(any("Publishes itself in" in t for t in asks), "the unheld prompt says it publishes itself")

# Time passes beyond the auto-deliver window.
for i in d["items"]:
    i["dm_at"] = ap.now() - ap.AUTO_DELIVER_SECONDS - 5
ap.save(d)
SENT.clear()
ap.cmd_tick(None)
d = ap.load()
plain, held = d["items"]
check(plain["state"] in ("confirmed", "published", "failed"), "the unheld item is released on the timeout (%s)" % plain["state"])
check(held["state"] == "awaiting", "the HELD item is NOT released on the timeout (%s)" % held["state"])
check(held.get("hold_reminded_at"), "the owner is reminded about the held item")
rem = [p for m, p in SENT if m == "sendMessage" and "STILL WAITING" in p.get("text", "")]
check(len(rem) == 1 and "reply_markup" not in rem[0], "exactly one reminder, with no buttons")

SENT.clear()
ap.cmd_tick(None)                      # a second tick soon after: no second reminder
check(not [p for m, p in SENT if "STILL WAITING" in p.get("text", "")], "no reminder spam on the next tick")
check(ap.load()["items"][1]["state"] == "awaiting", "still waiting after another tick")

d = ap.load()
d["items"][1]["hold_reminded_at"] = ap.now() - ap.HOLD_REMIND_SECONDS - 5
ap.save(d)
SENT.clear()
ap.cmd_tick(None)
check(len([p for m, p in SENT if "STILL WAITING" in p.get("text", "")]) == 1, "reminded again after HOLD_REMIND_SECONDS")

# --- a private service named in a public message is REFUSED, not published.
#
# This is the leak from 2026-10-22: a review session submitted "If you were
# referring to checker.pc.am, the issue has been resolved..." straight through
# `submit`, and the gate published it into @PCoinPCNChat. answer-prompt.md:554
# already forbade the name and the bot obeyed -- but the prompt governs the model
# that reads it, and nothing on the submit path looked at the words at all.
#
# Every check here is asserted against KNOWN-BAD input first. A guard that is
# never shown to fire is indistinguishable from a guard that is not there (§7.12).
check(ap.forbidden_name_in("see checker.pc.am please") == "checker.pc.am",
      "forbidden_name_in finds the private address in ordinary prose")
check(ap.forbidden_name_in("CHECKER.PC.AM is back") == "checker.pc.am",
      "forbidden_name_in is case-insensitive")
check(ap.forbidden_name_in("the checker retried and then succeeded") is None,
      "the ordinary word 'checker' does NOT trip it -- whole-name match only")
check(ap.forbidden_name_in("all clear, nothing to report") is None,
      "clean text is not flagged")
check(ap.forbidden_name_in(None) is None, "forbidden_name_in tolerates a null text")

before = len(ap.load()["items"])
OPS.clear()
SENT.clear()
refused = None
try:
    submit("Update: if you were referring to checker.pc.am, the issue has been "
           "resolved and the service is back online now!", "k-leak")
except SystemExit as e:
    refused = str(e)
check(refused is not None and "REFUSED" in refused and "checker.pc.am" in refused,
      "a submission naming the private service exits with a refusal (%s)" % (refused or "NOT RAISED"))
check(len(ap.load()["items"]) == before, "the refused message is never queued")
check(not any("checker.pc.am" in p.get("text", "") for m, p in SENT),
      "nothing naming it is sent to the owner or anywhere else")
check(any(a and "private service named in a public message" in a[0] for a, k in OPS),
      "the ops channel is told a submission was refused")

OPS.clear()
submit("Withdrawals are cleared and the balance is correct again.", "k-ok-after")
check(len(ap.load()["items"]) == before + 1, "an ordinary message after the refusal still queues")
check(not OPS, "an ordinary message raises no ops alert")

print()
print("%d FAILED" % len(FAILS) if FAILS else "ALL PASSED")
sys.exit(1 if FAILS else 0)
