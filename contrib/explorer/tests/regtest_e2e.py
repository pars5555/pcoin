"""End-to-end reorg test against a real PCoin node on regtest.

Not part of the unit suite: it needs a node, so it is opt-in.

    python3 tests/regtest_e2e.py \
        --bin /root/pcoin-build/build/bin \
        --datadir /root/pcoin-explorer-regtest

The unit tests drive the indexer from a synthetic chain, which is the only way
to exercise 40 random branch switches in under a second. This file exists to
check the other half: that the assumptions the synthetic chain encodes are
actually true of a real bitcoind -- the shape of `getblock <hash> 3`, the error
codes on a height that has just been reorged away, and the behaviour of
`invalidateblock`/`reconsiderblock`, which is how a real reorg is provoked.

The assertion after every phase is the strong one: the incrementally-maintained
index must be byte-for-byte identical to a fresh index built from genesis
against the same node, and both must agree with the node's own
`gettxoutsetinfo`. NEVER point this at mainnet -- it mines and it invalidates
blocks. It refuses to run against a chain that is not regtest.
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tests.helpers import diff_snapshots, snapshot          # noqa: E402
from pcoin_indexer import db, queries                        # noqa: E402
from pcoin_indexer.indexer import Indexer, reindex, verify    # noqa: E402
from pcoin_indexer.rpc import RpcClient                       # noqa: E402

COIN = 100_000_000


class Cli:
    def __init__(self, binpath, datadir):
        self.exe = os.path.join(binpath, "bitcoin-cli")
        self.datadir = datadir

    def __call__(self, *args, wallet=None):
        cmd = [self.exe, "-datadir=%s" % self.datadir, "-regtest"]
        if wallet:
            cmd.append("-rpcwallet=%s" % wallet)
        cmd += [str(a) for a in args]
        out = subprocess.check_output(cmd, stderr=subprocess.STDOUT).decode().strip()
        try:
            return json.loads(out)
        except ValueError:
            return out


class Check:
    def __init__(self):
        self.n = 0
        self.failed = []

    def __call__(self, ok, label):
        self.n += 1
        print("  %s %s" % ("PASS" if ok else "FAIL", label))
        if not ok:
            self.failed.append(label)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bin", required=True, help="directory holding bitcoin-cli")
    ap.add_argument("--datadir", required=True, help="a REGTEST datadir")
    args = ap.parse_args()

    cli = Cli(args.bin, args.datadir)
    info = cli("getblockchaininfo")
    if info["chain"] != "regtest":
        sys.exit("refusing to run against chain %r -- regtest only" % info["chain"])

    rpc = RpcClient("http://127.0.0.1:49443/",
                    cookie_path=os.path.join(args.datadir, "regtest", ".cookie"))
    check = Check()
    tmp = tempfile.mkdtemp(prefix="pcoin-e2e-")
    live = os.path.join(tmp, "live.sqlite")
    conn = db.connect(live)
    db.init_schema(conn)
    idx = Indexer(conn, rpc, chain="regtest")

    def fresh_snapshot():
        """Build a whole new index from genesis and snapshot it."""
        path = os.path.join(tmp, "fresh-%d.sqlite" % time.time_ns())
        reindex(path, RpcClient("http://127.0.0.1:49443/",
                                cookie_path=os.path.join(args.datadir, "regtest",
                                                         ".cookie")),
                in_place=True)
        c = db.connect(path, readonly=True)
        s = snapshot(c)
        c.close()
        return s

    def phase(label):
        print("\n== %s ==" % label)
        idx.sync()
        node = cli("getblockchaininfo")
        check(idx.tip_height() == node["blocks"], "index height == node height (%d)"
              % node["blocks"])
        check(idx.tip()[1] == node["bestblockhash"], "index tip hash == node tip hash")
        problems = verify(conn, deep=True)
        check(problems == [], "verify() is clean" + ("" if not problems
                                                     else ": %s" % problems[:3]))
        got, want = snapshot(conn), fresh_snapshot()
        check(got == want, "incremental index == a from-scratch index"
              + ("" if got == want else "\n" + diff_snapshots(got, want)))
        # the node's own chainstate is the independent oracle
        utxo = cli("gettxoutsetinfo")
        row = conn.execute(
            "SELECT COUNT(*) n, COALESCE(SUM(value),0) v FROM outputs"
            " WHERE spent_height IS NULL AND unspendable=0").fetchone()
        check(row["n"] == utxo["txouts"], "utxo count == gettxoutsetinfo.txouts (%d)"
              % utxo["txouts"])
        check(row["v"] == round(float(utxo["total_amount"]) * COIN),
              "supply == gettxoutsetinfo.total_amount (%s)" % utxo["total_amount"])
        h = queries.health(conn)
        check(h["blocks_behind"] == 0 and not h["stale"],
              "health reports caught up and not stale")

    # -- wallet ---------------------------------------------------------
    if "e2e" not in cli("listwallets"):
        try:
            cli("createwallet", "e2e")
        except subprocess.CalledProcessError:
            cli("loadwallet", "e2e")   # exists on disk but is not loaded
    a1 = cli("getnewaddress", wallet="e2e")
    a2 = cli("getnewaddress", wallet="e2e")

    print("mining 130 blocks (RandomX at regtest powLimit; the first one pays "
          "the ~256 MiB cache init)...")
    t0 = time.time()
    cli("generatetoaddress", 130, a1, wallet="e2e")
    print("  %.1fs" % (time.time() - t0))
    phase("linear sync, 130 coinbases")

    # -- a spend --------------------------------------------------------
    cli("settxfee", "0.00010000", wallet="e2e")
    txid = cli("sendtoaddress", a2, 12.5, wallet="e2e")
    cli("generatetoaddress", 1, a1, wallet="e2e")
    phase("after a real spend")
    t = queries.transaction(conn, txid)
    check(t is not None, "the spend is in the index")
    if t:
        check(all(i["address"] for i in t["inputs"]),
              "every input carries its source address (from prevout)")
        check(t["fee"] > 0, "fee is positive (%d sat)" % t["fee"])
        check(t["value_in"] - t["value_out"] == t["fee"], "fee == value_in - value_out")

    # -- reorg: invalidate the block holding the spend -------------------
    tip = cli("getblockchaininfo")["blocks"]
    spend_height = t["height"]
    victim = cli("getblockhash", spend_height)
    print("\ninvalidating block %d (%s) -- the spend goes with it"
          % (spend_height, victim[:16]))
    cli("invalidateblock", victim)
    after = cli("getblockchaininfo")
    check(after["blocks"] == spend_height - 1,
          "node rolled back to %d" % (spend_height - 1))
    # Rebuild a longer branch that does NOT contain the spend. The wallet
    # re-broadcasts, so mine to a fresh address from a throwaway keypool entry
    # and use a raw block with no mempool tx: generateblock with no txs.
    for _ in range(4):
        cli("generateblock", a1, "[]", wallet="e2e")
    phase("after a %d-block reorg that orphaned a spend" % (tip - spend_height + 1))

    row = conn.execute("SELECT COUNT(*) c FROM txs WHERE txid=?", (txid,)).fetchone()
    print("  the orphaned spend is present in the index: %s" % bool(row["c"]))
    orph = conn.execute("SELECT COUNT(*) c FROM orphaned_blocks").fetchone()["c"]
    check(orph > 0, "orphaned blocks were recorded (%d)" % orph)
    rl = conn.execute("SELECT COUNT(*) c FROM reorg_log").fetchone()["c"]
    check(rl > 0, "the reorg was logged (%d entr%s)" % (rl, "y" if rl == 1 else "ies"))

    # -- reorg back: reconsider, the original branch may win again -------
    cli("reconsiderblock", victim)
    phase("after reconsiderblock")

    # -- a deep reorg ----------------------------------------------------
    deep_from = cli("getblockchaininfo")["blocks"] - 40
    victim = cli("getblockhash", deep_from)
    print("\ninvalidating block %d -- a 40-deep reorg" % deep_from)
    cli("invalidateblock", victim)
    for _ in range(45):
        cli("generateblock", a2, "[]", wallet="e2e")
    phase("after a 40-deep reorg")
    check(idx.reorgs > 0, "the indexer recorded %d reorg(s)" % idx.reorgs)
    check(idx.blocks_unwound > 40, "the indexer unwound %d block(s)"
          % idx.blocks_unwound)

    # -- SIGKILL in the middle of a sync ---------------------------------
    # The module docstring's Corollary claims a crash can only ever leave the
    # index at *some* height whose contents are a valid chain prefix. Simulating
    # that inside one process proves less than actually killing one, because a
    # real kill also tests that WAL recovery on the next open does the right
    # thing. Kill repeatedly at random points, then let it finish.
    print("\n== SIGKILL mid-sync, repeatedly ==")
    killed_path = os.path.join(tmp, "killed.sqlite")
    env = dict(os.environ, PYTHONPATH=os.path.dirname(
        os.path.dirname(os.path.abspath(__file__))))
    kills = 0
    for i in range(8):
        p = subprocess.Popen(
            [sys.executable, "-m", "pcoin_indexer", "--db", killed_path,
             "--datadir", args.datadir, "--chain", "regtest", "--batch", "4",
             "--quiet", "sync"],
            env=env, cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(0.05 + 0.03 * i)
        if p.poll() is None:
            p.kill()
            kills += 1
        p.wait()
        if os.path.exists(killed_path):
            c = db.connect(killed_path)
            problems = verify(c, deep=True)
            tip = c.execute("SELECT MAX(height) h FROM blocks").fetchone()["h"]
            c.close()
            if problems:
                check(False, "after kill %d (tip %s): %s" % (i, tip, problems[:3]))
                break
    else:
        check(True, "index stayed self-consistent through %d SIGKILLs" % kills)
    subprocess.check_call(
        [sys.executable, "-m", "pcoin_indexer", "--db", killed_path,
         "--datadir", args.datadir, "--chain", "regtest", "--quiet", "sync"],
        env=env, cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        stdout=subprocess.DEVNULL)
    c = db.connect(killed_path, readonly=True)
    check(verify(c, deep=True) == [], "the killed index verifies after resuming")
    resumed = snapshot(c)
    c.close()
    check(resumed == fresh_snapshot(),
          "the killed-and-resumed index == a from-scratch index")

    conn.close()
    print("\n%d checks, %d failed" % (check.n, len(check.failed)))
    for f in check.failed:
        print("  FAILED: %s" % f)
    return 1 if check.failed else 0


if __name__ == "__main__":
    sys.exit(main())
