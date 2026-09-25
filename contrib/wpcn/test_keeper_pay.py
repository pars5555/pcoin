"""State-machine tests for pcoin-keeper-pay against a fake chain.

    /opt/wpcn/.venv/bin/python contrib/wpcn/test_keeper_pay.py

Needs web3 importable (for its address helpers and TransactionNotFound); touches
no network and no real key. The property under test is the one that matters:
one key can never produce two payments, whatever fails and wherever.
"""
import importlib.machinery
import importlib.util
import io
import json
import os
import sys
import tempfile
from contextlib import redirect_stdout, redirect_stderr

HERE = os.path.dirname(os.path.abspath(__file__))
TMP = tempfile.mkdtemp()
os.environ["KEEPER_PAY_LEDGER"] = os.path.join(TMP, "ledger.json")
os.environ["PCOIN_NOTIFY"] = "/nonexistent"
os.environ["KEEPER_PAY_RECEIPT_WAIT"] = "0"

spec = importlib.util.spec_from_loader("kp", importlib.machinery.SourceFileLoader("kp", os.path.join(HERE, "pcoin-keeper-pay")))
kp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(kp)
kp.time.sleep = lambda s: None
from web3.exceptions import TransactionNotFound  # noqa: E402

KEEPER = "0x477C9793C0d69283d703010500C86f7335B27521"
DEST = "0x5525B6DC7ed19eC5311A65dd95A9cd0d7a978f50"
E18 = 10 ** 18


class Signed:
    def __init__(self, n):
        self.hash = bytes([n % 256]) * 32
        self.raw_transaction = b"RAW" + bytes([n % 256])


class Chain:
    """Just enough of web3 for the tool. Every broadcast is counted."""
    def __init__(self, usdt=100 * E18, bnb=E18):
        self.usdt, self.bnb = usdt, bnb
        self.latest = 7            # mined nonce count
        self.mempool = {}          # hash -> (nonce, units, to)
        self.receipts = {}
        self.broadcasts = []       # every send_raw_transaction call
        self.refuse_next = None
        self.signs = 0
        self.eth = self
        self.gas_price = 10 ** 9

    # eth
    def get_transaction_receipt(self, h):
        h = h if isinstance(h, str) else "0x" + h.hex()
        if h in self.receipts:
            return self.receipts[h]
        raise TransactionNotFound(h)

    def get_transaction(self, h):
        if h in self.mempool:
            return {"hash": h}
        raise TransactionNotFound(h)

    def get_transaction_count(self, addr, tag):
        return self.latest + (len(self.mempool) if tag == "pending" else 0)

    def send_raw_transaction(self, raw):
        self.broadcasts.append(bytes(raw))
        if self.refuse_next:
            e, self.refuse_next = self.refuse_next, None
            raise ValueError(e)
        tx = self.by_raw[bytes(raw)]
        self.mempool[tx["hash"]] = tx
        return tx["hash"]

    def estimate_gas(self, tx):
        return 50000

    def get_balance(self, addr):
        return self.bnb

    # mining
    def mine(self, h, status=1, units=None, to=DEST, frm=KEEPER):
        tx = self.mempool.pop(h)
        self.latest += 1
        units = tx["units"] if units is None else units
        self.receipts[h] = {"status": status, "blockNumber": 100 + self.latest, "logs": [] if status != 1 else [{
            "address": kp.USDT, "topics": [kp.TRANSFER_TOPIC, "0x" + frm.lower()[2:].rjust(64, "0"),
                                           "0x" + to.lower()[2:].rjust(64, "0")],
            "data": hex(units)}]}
        if status == 1:
            self.usdt -= units


class Acct:
    def __init__(self, chain):
        self.address, self.c = KEEPER, chain

    def sign_transaction(self, tx):
        self.c.signs += 1
        s = Signed(tx["nonce"] * 7 + self.c.signs)
        h = "0x" + s.hash.hex()
        self.c.by_raw = getattr(self.c, "by_raw", {})
        self.c.by_raw[bytes(s.raw_transaction)] = {"hash": h, "nonce": tx["nonce"], "units": tx["units"]}
        return s


class Usdt:
    def __init__(self, chain):
        c = chain

        class F:
            def balanceOf(self, a):
                return type("C", (), {"call": lambda s: c.usdt})()

            def transfer(self, to, units):
                return type("T", (), {"build_transaction": lambda s, d: {"from": d["from"], "units": units, "to": to}})()
        self.functions = F()


def run(chain, *argv, busy=None, floor=5.0):
    kp.connect = lambda: (chain, Acct(chain), Usdt(chain))
    kp.keeper_busy = lambda: busy
    kp.min_usdt_floor = lambda: floor
    out, err = io.StringIO(), io.StringIO()
    code = 0
    with redirect_stdout(out), redirect_stderr(err):
        try:
            kp.send(*argv)
        except SystemExit as e:
            code = e.code
    line = out.getvalue().strip().splitlines()[-1]
    return code, json.loads(line)


fails = 0


def check(label, cond, extra=""):
    global fails
    fails += not cond
    print("%s  %s %s" % ("ok  " if cond else "FAIL", label, extra))


def fresh():
    if os.path.exists(os.environ["KEEPER_PAY_LEDGER"]):
        os.remove(os.environ["KEEPER_PAY_LEDGER"])


def ledger():
    return json.load(open(os.environ["KEEPER_PAY_LEDGER"]))["payouts"]


# 1. the happy path: signed and RECORDED before the broadcast, then confirmed
fresh(); c = Chain()
orig_send = c.send_raw_transaction
seen_before = {}
def spy(raw):
    seen_before["rec"] = ledger().get("k1")
    return orig_send(raw)
c.send_raw_transaction = spy
code, r = run(c, "k1", DEST, "50000000", "wd#1", False)   # receipt wait 0 -> unknown until mined
check("the record exists, state 'signed', BEFORE the broadcast", (seen_before.get("rec") or {}).get("state") == "signed")
check("no receipt yet -> UNKNOWN (exit 3), never 'refused'", code == 3 and r["state"] == "unknown", str(r))
h = r["txid"]
c.mine(h)
code, r = run(c, "k1", DEST, "50000000", "wd#1", False)
check("pressing again after it mined: paid, SAME hash, no new signature", code == 0 and r["txid"] == h and c.signs == 1, str(r))
code, r = run(c, "k1", DEST, "50000000", "wd#1", False)
check("and again: 'already', still one signature, one broadcast", code == 0 and r["state"] == "already" and c.signs == 1 and len(c.broadcasts) == 1, str(r))
check("50 USDT left the keeper exactly once", c.usdt == 50 * E18)

# 2. crash between sign and broadcast: the retry re-sends the IDENTICAL bytes
fresh(); c = Chain()
c.refuse_next = "connection reset"
c.get_transaction = lambda h: (_ for _ in ()).throw(RuntimeError("rpc down"))   # cannot even ask
code, r = run(c, "k2", DEST, "20000000", "", False)
check("broadcast failed AND the node cannot be asked -> UNKNOWN, record kept", code == 3 and ledger()["k2"]["state"] == "signed", str(r))
c.get_transaction = Chain.get_transaction.__get__(c)
code, r = run(c, "k2", DEST, "20000000", "", False)
check("retry: identical raw bytes re-broadcast, NO second signature", c.signs == 1 and c.broadcasts[-1] == c.broadcasts[0], str(len(c.broadcasts)))
c.mine(r["txid"])
code, r = run(c, "k2", DEST, "20000000", "", False)
check("then it settles as paid, once", code == 0 and c.usdt == 80 * E18 and c.signs == 1, str(r))

# 3. the node REFUSED it and does not know it: nothing sent, a retry may sign fresh
fresh(); c = Chain()
c.refuse_next = "insufficient funds for gas"
code, r = run(c, "k3", DEST, "20000000", "", False)
check("node refusal + node does not know it -> REFUSED, state 'rejected'", code == 2 and ledger()["k3"]["state"] == "rejected", str(r))
code, r = run(c, "k3", DEST, "20000000", "", False)
check("retry after a proven refusal signs a fresh transaction", c.signs == 2, str(r))

# 4. a DEAD nonce: another transaction took the slot, ours can never mine
fresh(); c = Chain()
code, r = run(c, "k4", DEST, "20000000", "", False)
dead_hash = r["txid"]
c.mempool.pop(dead_hash)          # dropped from the mempool...
c.latest += 1                     # ...and its nonce consumed by another tx
code, r = run(c, "k4", DEST, "20000000", "", False)
check("dead nonce -> old marked 'dead', a new one signed with a NEW hash", ledger()["k4"]["hash"] != dead_hash and c.signs == 2, str(r))

# 5. a still-pending transaction is NEVER replaced by a new one
fresh(); c = Chain()
code, r = run(c, "k5", DEST, "20000000", "", False)
for _ in range(3):
    run(c, "k5", DEST, "20000000", "", False)
check("pending: three more presses, still ONE signature", c.signs == 1, str(c.signs))

# 6. reverted: no USDT moved, retry signs fresh
fresh(); c = Chain()
code, r = run(c, "k6", DEST, "20000000", "", False)
c.mine(r["txid"], status=0)
code, r = run(c, "k6", DEST, "20000000", "", False)
check("reverted -> REFUSED with the reason, state 'reverted'", code == 2 and "REVERTED" in r["message"], str(r))
code, r = run(c, "k6", DEST, "20000000", "", False)
check("after a revert a press signs a new transaction", c.signs == 2)

# 7. mined but the Transfer is wrong -> unknown, never 'paid'
fresh(); c = Chain()
code, r = run(c, "k7", DEST, "20000000", "", False)
c.mine(r["txid"], units=19 * E18)
code, r = run(c, "k7", DEST, "20000000", "", False)
check("wrong amount in the log -> UNKNOWN, 'mined_unverified'", code == 3 and ledger()["k7"]["state"] == "mined_unverified", str(r))
code, r = run(c, "k7", DEST, "20000000", "", False)
check("...and it stays refused to act, no new signature", code == 3 and c.signs == 1)

# 8. refusals: nothing signed, nothing broadcast
fresh(); c = Chain(usdt=24 * E18)
code, r = run(c, "k8", DEST, "20000000", "", False, floor=5.0)
check("would cross the keeper's 5 USDT floor -> REFUSED, nothing signed", code == 2 and "floor" in r["message"] and c.signs == 0, str(r))
c = Chain()
code, r = run(c, "k9", DEST, "20000000", "", False, busy="the keeper is trading right now")
check("keeper busy -> REFUSED, nothing signed", code == 2 and c.signs == 0, str(r))
code, r = run(c, "k10", DEST, "600000000", "", False)
check("above the per-payout ceiling -> REFUSED", code == 2 and c.signs == 0, str(r))
code, r = run(c, "k11", "0xnot-an-address", "1000000", "", False)
check("bad address -> REFUSED", code == 2 and c.signs == 0, str(r))
fresh(); c = Chain(usdt=1000 * E18)
code, r = run(c, "k12", DEST, "300000000", "", False)
c.mine(r["txid"])
code, r = run(c, "k13", DEST, "300000000", "", False)
check("daily ceiling counts today's payouts -> second 300 REFUSED", code == 2 and "daily" in r["message"], str(r))
code, r = run(c, "k12", DEST, "299000000", "", False)
check("a key reused with a different amount -> REFUSED", code == 2 and "already used" in r["message"], str(r))
code, r = run(c, "k12", "0x0db1025b5b3300bF0bf8C38a40EC8ddbDA6302d2", "300000000", "", False)
check("a key reused with a different address -> REFUSED", code == 2 and "already used" in r["message"], str(r))

# 9. dry run signs nothing and writes nothing
fresh(); c = Chain()
code, r = run(c, "k14", DEST, "20000000", "", True)
check("dry run: exit 0, no signature, no ledger entry", code == 0 and c.signs == 0 and not os.path.exists(os.environ["KEEPER_PAY_LEDGER"]), str(r))

# 10. a damaged ledger is an error, never an empty ledger
with open(os.environ["KEEPER_PAY_LEDGER"], "w") as fh:
    fh.write("{not json")
c = Chain()
code, r = run(c, "k15", DEST, "20000000", "", False)
check("unparseable ledger -> REFUSED, nothing signed", code == 2 and c.signs == 0, str(r))

print("\n%d failure(s)" % fails)
sys.exit(1 if fails else 0)
