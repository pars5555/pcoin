#!/usr/bin/env python3
"""Tests for the answer bot's guard and context -- run: python3 test_answer_guard.py

Needs nothing but python3: it loads pcoin-group-answer and pcoin-group-watch as
modules (their main() is guarded) and never touches the network or a live file.

Every rule is tested in BOTH directions. A guard only ever shown passing good
answers has not been shown to hold anything (CLAUDE.md 8c: a check that cannot
fire is indistinguishable from a check that passes).
"""
import importlib.machinery
import importlib.util
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))


def load(name):
    loader = importlib.machinery.SourceFileLoader(name.replace("-", "_"), os.path.join(HERE, name))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


ans = load("pcoin-group-answer")
watch = load("pcoin-group-watch")
FAILS = []


def check(cond, what):
    print(("ok    " if cond else "FAIL  ") + what)
    if not cond:
        FAILS.append(what)


# ---- 1. the six real drafts held as "how funds are held", 09-15 .. 09-26 ----
# Every one is the standard scam warning the prompt requires. All must pass now.
REAL_WARNINGS = [
    "Reminder for everyone: nobody from PCoin will ever DM you first, and nobody here will ever ask for a recovery phrase or private key. If anyone offers to arrange an exchange listing or \"help\" with funds, it is a scam — block and report them, and please say so here so the next person sees it.",
    "Withdrawals from exchange.pc.am are sent by hand, within 24 hours of the request. If it has been longer than that, a person will look into it — posting the withdrawal or transaction ID here helps (never a recovery phrase or private key, nobody here will ever ask for one).",
    "If funds actually left your wallet and nothing was credited, that is for a person to trace — I can't diagnose it from here and I won't guess at the cause. Refreshing a payment page can create several invoices, so keep the invoice IDs and the transaction hashes for the one you paid, but never post a recovery phrase or private key anywhere. I've filed this with your words and someone will follow it up.",
    "Dollar deposits are credited once the payment confirms, so there is a short wait — but if it has been well past that, a person will check it for you. Please post the method you used, the amount, the time you sent it and a transaction reference if you have one, and it will be looked into. Please do not share any recovery phrase or private key with anyone here.",
    "Support is here. Tell us what you are seeing, and where -- which service, wallet or miner, and the version if it is a wallet or miner, plus the exact wording on screen if there is any. One thing up front: never share your 12-word phrase or a private key with anyone, and nobody from PCoin will ever DM you first or ask for them.",
    "Reminder for everyone: nobody from PCoin will ever DM you first, and nobody will ever ask for your 12-word recovery phrase or private key. If somebody has messaged you privately about your wallet, an offer, or \"validating\" anything, block and report them — anyone claiming PCoin is running a giveaway is a scammer.",
]
for i, t in enumerate(REAL_WARNINGS, 1):
    check(ans.guard(t) is None, "real scam warning #%d now passes (was held: %r)" % (i, ans.guard(t)))

# ---- 2. disclosures about how funds are held must STILL be held ------------
DISCLOSURES = [
    "The private key is stored on our server.",
    "We never share the private key; it is kept in a vault.",
    "Nobody can see the private key because it sits on a hardware wallet offline.",
    "Our treasury uses a cold wallet.",
    "The market float is a hot wallet on the market server.",
    "Keys are kept in a vault on a backup server.",
    "Never share your private key. Our own keys are in a multisig vault.",
]
for t in DISCLOSURES:
    check(ans.guard(t) == "how funds are held", "still held: %r -> %r" % (t, ans.guard(t)))

# ---- 3. the bot sees its own earlier replies --------------------------------
CHAT = -1003975107618
tmp = tempfile.mkdtemp()
qpath = os.path.join(tmp, "queue.json")
with open(qpath, "w", encoding="utf-8") as fh:
    # THE REAL SHAPE of /var/lib/pcoin-approve/queue.json: {"items": [...]}.
    # The first version of this test used an id->item map, passed, and the
    # feature then did nothing in production for four hours.
    json.dump({"items": [
        {"dest": "group", "state": "published", "published_at": 1000, "text": "EARLIER REPLY ONE"},
        {"dest": "group", "state": "cancelled", "published_at": 1100, "text": "CANCELLED DRAFT"},
        {"dest": "channel", "state": "published", "published_at": 1150, "text": "CHANNEL POST"},
        {"dest": "group", "state": "published", "published_at": 5000, "text": "LATER REPLY"},
    ]}, fh)
ans.APPROVE_QUEUE = qpath
spool = [
    {"chat": CHAT, "message_id": 1, "date": 900, "from": "Tony", "text": "first question"},
    {"chat": CHAT, "message_id": 2, "date": 1200, "from": "Tony", "text": "follow-up"},
    {"chat": -42, "message_id": 3, "date": 1250, "from": "Other", "text": "another chat"},
]
row = {"chat": CHAT, "message_id": 4, "date": 1300}
thread = ans.recent_thread(row, spool=spool)
check(any("EARLIER REPLY ONE" in l and l.startswith("PCoin (you") for l in thread), "own published reply is in the thread")
check(not any("CANCELLED DRAFT" in l for l in thread), "a cancelled draft is not")
check(not any("CHANNEL POST" in l for l in thread), "a post to another destination is not")
check(not any("LATER REPLY" in l for l in thread), "a reply from after the question is not")
check(not any("another chat" in l for l in thread), "another chat's messages are not")
order = [l.split(": ", 1)[1] for l in thread]
check(order == ["first question", "EARLIER REPLY ONE", "follow-up"], "in time order: %r" % order)
ans.APPROVE_QUEUE = os.path.join(tmp, "missing.json")
check(ans.recent_thread(row, spool=spool) == ["Tony: first question", "Tony: follow-up"],
      "an unreadable queue degrades to the spool only, no error")

# ---- 4. forwards are labelled, and our channel counts as official -----------
fwd_ours = {"forward_origin": {"type": "channel", "chat": {"id": -1003712285504, "username": "PCoinPCN", "title": "PCoin Official"}}}
fwd_other = {"forward_origin": {"type": "channel", "chat": {"id": -1009, "username": "somecoin", "title": "Some Coin"}}}
fwd_user = {"forward_origin": {"type": "hidden_user", "sender_user_name": "Bob"}}
check(watch.forward_info({"text": "hi"}) is None, "a plain message is not a forward")
check(watch.forward_info(fwd_ours)["official"] is True, "a forward from @PCoinPCN is official")
check(watch.forward_info(fwd_other)["official"] is False, "a forward from another channel is not")
check(watch.forward_info(fwd_user)["official"] is False and watch.forward_info(fwd_user)["title"] == "Bob",
      "a forward from a person is labelled with their name, not official")

ans.APPROVE_QUEUE = os.path.join(tmp, "missing.json")
ans.read_spool = lambda: []
ctx_ours = ans.with_context({"chat": CHAT, "message_id": 9, "date": 2000,
                              "forwarded_from": watch.forward_info(fwd_ours)}, "some text")
ctx_other = ans.with_context({"chat": CHAT, "message_id": 9, "date": 2000,
                               "forwarded_from": watch.forward_info(fwd_other)}, "some text")
check("OFFICIAL post from the PCoin channel" in ctx_ours, "context says an official forward is official")
check("not an official PCoin statement" in ctx_other and "Some Coin" in ctx_other,
      "context says a foreign forward is not official")

# ---- 5. which drafts must WAIT for the owner (hold) -------------------------
H = ans.hold_reasons
check(H("How do I install the Windows miner?", "Open PowerShell and paste: irm https://pc.am/dl/install.ps1 | iex", "high", None, {}) == [],
      "a plain how-to answer is not held")
check(H("Is this a scam DM?", "Nobody from PCoin will ever DM you first or ask for your recovery phrase.", "high", None, {}) == [],
      "a scam warning is not held")
check(any("money" in w for w in H("When is my withdrawal paid?", "Withdrawals are sent by hand within 24 hours.", "high", None, {})),
      "a withdrawal answer is held")
check(any("mining defaults" in w for w in H("Solo mining", "Solo takes weeks or months; the pool is the default.", "high", None, {})),
      "a mining-default answer is held")
check(any("denies" in w for w in H("Is the pinned counter real?", "The project has never tied a listing to purchases; it is not official.", "high", None, {})),
      "a denial is held")
check(any("confident" in w for w in H("hi", "Hello!", "medium", None, {})), "medium confidence is held")
check(any("disputing" in w for w in H("that's wrong", "Sorry.", "high", None, {"reply_to_from": "PCoin (@PCoinPCNBot)"})),
      "a reply to the bot is held")
check(any("disputing" in w for w in H("Please flag it for a person", "ok", "high", None, {}, ["PCoin (you, an earlier reply that WAS posted): x"])),
      "a dispute after a bot reply in the thread is held")
check(any("follow up" in w for w in H("my miner is stuck", "A person will look into it.", "high", None, {})),
      "a promise of a person with no report is held")
check(not any("follow up" in w for w in H("my miner is stuck", "A person will look into it.", "high", {"kind": "bug", "summary": "x"}, {})),
      "the same promise WITH a report is not held for that reason")

print()
print("%d FAILED" % len(FAILS) if FAILS else "ALL PASSED")
sys.exit(1 if FAILS else 0)
