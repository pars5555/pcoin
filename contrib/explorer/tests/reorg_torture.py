"""Reorg torture test for the PCoin explorer index.

This is the adversarial sibling of ``regtest_e2e.py``. That file checks that the
indexer's assumptions about a real node are true. This one attacks the single
property the whole index rests on: **after a reorg the index must be exactly what
a from-scratch reindex of the same final chain would have produced.** Not
"balances agree" -- every row of every table, compared as a tuple.

Why that is the bar: CLAUDE.md section 10.12 -- the live chain carries ~66 chain
tips over ~2100 blocks, a ~3% stale rate, and LWMA at height 2800 halves block
spacing again. A reorg here is a weekly event, not a thought experiment. An
indexer that unwinds one row too few reports a wrong balance *forever* and
nothing ever tells it.

It runs against its own throwaway regtest nodes. It never touches mainnet except
for phase 6, which is strictly read-only (getblockchaininfo / getblockhash /
getblock / scantxoutset / gettxoutsetinfo) and refuses to do anything else.

    python3 tests/reorg_torture.py \
        --bin /root/pcoin-build/build/bin \
        --workdir /root/pcoin-torture \
        --mainnet-datadir /root/pcoin-verify        # optional, phase 6

Phases
  1  one-block reorg                      -> identity with a fresh reindex
  2  deep reorg (>= 10 blocks)            -> identity
  2b two real nodes racing, no invalidateblock, so the reorg is not synthetic
  3  a reorg that orphans a coinbase      -> the reward vanishes from the address
  4  SIGKILL between unwind and re-apply  -> converges to the correct state
  5  a tx in a block on one branch and in the mempool on the other, plus the
     same txid re-mined at a different height -> never double counted
  6  the real chain: index the mainnet node read-only and diff a sample of
     addresses against scantxoutset, which is ground truth from the node's own
     UTXO set and shares no code with the index
"""

import argparse
import json
import os
import random
import signal
import subprocess
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tests.helpers import diff_snapshots, snapshot            # noqa: E402
from pcoin_indexer import db, queries                          # noqa: E402
from pcoin_indexer.indexer import Indexer, reindex, verify      # noqa: E402
from pcoin_indexer.rpc import RpcClient                         # noqa: E402

COIN = 100_000_000
EXPLORER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


# ---------------------------------------------------------------------------
# plumbing
# ---------------------------------------------------------------------------

class Cli:
    def __init__(self, binpath, datadir, name="node"):
        self.exe = os.path.join(binpath, "bitcoin-cli")
        self.datadir = datadir
        self.name = name

    def __call__(self, *args, wallet=None, allow_fail=False):
        cmd = [self.exe, "-datadir=%s" % self.datadir]
        if wallet:
            cmd.append("-rpcwallet=%s" % wallet)
        cmd += [str(a) for a in args]
        try:
            out = subprocess.check_output(cmd, stderr=subprocess.STDOUT).decode().strip()
        except subprocess.CalledProcessError as exc:
            if allow_fail:
                return None
            raise RuntimeError("%s: %s failed: %s"
                               % (self.name, args[0], exc.output.decode()[:400]))
        try:
            return json.loads(out)
        except ValueError:
            return out


class Check:
    def __init__(self):
        self.n = 0
        self.failed = []
        self.phase = "-"

    def phase_begin(self, label):
        self.phase = label
        print("\n=== %s ===" % label, flush=True)

    def __call__(self, ok, label, detail=""):
        self.n += 1
        print("  %-4s %s" % ("PASS" if ok else "FAIL", label), flush=True)
        if not ok:
            if detail:
                print("       " + detail.replace("\n", "\n       "), flush=True)
            self.failed.append("[%s] %s%s" % (self.phase, label,
                                              (" -- " + detail[:300]) if detail else ""))
        return ok


def wait_for(fn, timeout=60, interval=0.2, what="condition"):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if fn():
            return True
        time.sleep(interval)
    raise RuntimeError("timed out waiting for %s" % what)


# ---------------------------------------------------------------------------
# the harness
# ---------------------------------------------------------------------------

class Torture:
    def __init__(self, args):
        self.args = args
        self.check = Check()
        self.work = args.workdir
        self.dbdir = os.path.join(self.work, "dbs")
        os.makedirs(self.dbdir, exist_ok=True)
        self.a = Cli(args.bin, os.path.join(self.work, "a"), "A")
        self.b = Cli(args.bin, os.path.join(self.work, "b"), "B")
        self.rpc_url = "http://127.0.0.1:%d/" % args.rpc_port
        self.cookie = os.path.join(self.work, "a", "regtest", ".cookie")
        self.live_db = os.path.join(self.dbdir, "live.sqlite")
        self.conn = None
        self.idx = None
        self.fresh_seq = 0

    # -- index handles --------------------------------------------------
    def new_rpc(self):
        return RpcClient(self.rpc_url, cookie_path=self.cookie)

    def open_live(self):
        self.conn = db.connect(self.live_db)
        db.init_schema(self.conn)
        self.idx = Indexer(self.conn, self.new_rpc(), chain="regtest")

    def reopen_live(self):
        if self.conn is not None:
            self.conn.close()
        self.open_live()

    def fresh_snapshot(self):
        """A whole new index built from genesis against the same node."""
        self.fresh_seq += 1
        path = os.path.join(self.dbdir, "fresh-%d.sqlite" % self.fresh_seq)
        for suffix in ("", "-wal", "-shm"):
            try:
                os.remove(path + suffix)
            except OSError:
                pass
        reindex(path, self.new_rpc(), in_place=True)
        c = db.connect(path, readonly=True)
        snap = snapshot(c)
        probs = verify(c, deep=True)
        c.close()
        return snap, probs

    def snapshot_of(self, path):
        c = db.connect(path, readonly=True)
        snap = snapshot(c)
        probs = verify(c, deep=True)
        c.close()
        return snap, probs

    # -- the identity assertion -----------------------------------------
    def assert_identical(self, label, conn=None, path=None):
        """The whole point of the exercise.

        Compares every row of blocks / txs / outputs / inputs / address_txs /
        addresses, as tuples, against a from-scratch reindex of the same node.
        Also runs the index's own deep verify on both, and reconciles the UTXO
        set against the node's `gettxoutsetinfo`, which is computed by entirely
        different code inside the node.
        """
        check = self.check
        path = path or self.live_db
        got, got_probs = self.snapshot_of(path)
        want, want_probs = self.fresh_snapshot()

        rows = sum(len(v) for k, v in got.items() if isinstance(v, list))
        check(got_probs == [], "%s: deep verify clean on the incremental index"
              % label, str(got_probs[:3]))
        check(want_probs == [], "%s: deep verify clean on the from-scratch index"
              % label, str(want_probs[:3]))
        ok = got == want
        check(ok, "%s: incremental index == from-scratch index (%d rows over %d "
              "tables)" % (label, rows, len(got) - 1),
              "" if ok else diff_snapshots(got, want))

        node = self.a("getblockchaininfo")
        check(got["_tip"][0] == node["blocks"] and got["_tip"][1] == node["bestblockhash"],
              "%s: index tip == node tip (%d)" % (label, node["blocks"]),
              "index says %r" % (got["_tip"],))

        utxo = self.a("gettxoutsetinfo")
        target = db.connect(path, readonly=True)
        row = target.execute(
            "SELECT COUNT(*) n, COALESCE(SUM(value),0) v FROM outputs"
            " WHERE spent_height IS NULL AND unspendable=0").fetchone()
        n_utxo, v_utxo = row["n"], row["v"]
        target.close()
        check(n_utxo == utxo["txouts"],
              "%s: utxo count == gettxoutsetinfo.txouts (%d)" % (label, utxo["txouts"]),
              "index has %d" % n_utxo)
        check(v_utxo == round(float(utxo["total_amount"]) * COIN),
              "%s: supply == gettxoutsetinfo.total_amount (%s)"
              % (label, utxo["total_amount"]),
              "index has %d sat" % v_utxo)
        return ok

    # -- node lifecycle -------------------------------------------------
    def start(self, cli):
        subprocess.check_call(
            [os.path.join(self.args.bin, "bitcoind"), "-datadir=%s" % cli.datadir,
             "-daemonwait"], stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)

    def stop(self, cli):
        cli("stop", allow_fail=True)

    def ensure_wallet(self, cli, name="tw"):
        wallets = cli("listwallets") or []
        if name not in wallets:
            if cli("createwallet", name, allow_fail=True) is None:
                cli("loadwallet", name)
        return name

    # ===================================================================
    # phases
    # ===================================================================

    def phase_setup(self):
        c = self.check
        c.phase_begin("setup: a private regtest chain")
        info = self.a("getblockchaininfo")
        if info["chain"] != "regtest":
            sys.exit("node A is on chain %r -- refusing" % info["chain"])
        c(True, "node A is regtest (genesis %s)" % self.a("getblockhash", 0)[:16])
        self.ensure_wallet(self.a)
        self.addr = {k: self.a("getnewaddress", wallet="tw") for k in
                     ("mine", "cb", "x", "y")}
        have = self.a("getblockcount")
        if have < 140:
            self.a("generatetoaddress", 140 - have, self.addr["mine"], wallet="tw")
        c(self.a("getblockcount") >= 140,
          "mined to height %d (COINBASE_MATURITY=100 satisfied)"
          % self.a("getblockcount"))
        self.open_live()
        stats = self.idx.sync()
        c(stats["caught_up"], "initial linear sync: %d blocks applied"
          % stats["applied"])
        self.assert_identical("linear")

    # -- 1: a one-block reorg -------------------------------------------
    def phase_one_block(self):
        c = self.check
        c.phase_begin("phase 1: a ONE-BLOCK reorg")
        tip_h = self.a("getblockcount")
        doomed = self.a("getblockhash", tip_h)
        before = self.idx.blocks_unwound
        self.a("invalidateblock", doomed)
        assert self.a("getblockcount") == tip_h - 1
        # Two blocks on the other side so the new branch strictly wins.
        self.a("generatetoaddress", 2, self.addr["y"], wallet="tw")
        new_tip = self.a("getblockcount")
        c(new_tip == tip_h + 1, "node rebuilt to height %d on a different branch"
          % new_tip)
        stats = self.idx.sync()
        c(stats["reorgs"] == 1, "the indexer saw exactly 1 reorg (%d)" % stats["reorgs"])
        c(self.idx.blocks_unwound - before == 1,
          "exactly 1 block was unwound (%d)" % (self.idx.blocks_unwound - before))
        row = self.conn.execute("SELECT * FROM reorg_log ORDER BY id DESC"
                                " LIMIT 1").fetchone()
        c(row is not None and row["blocks_unwound"] == 1
          and row["fork_height"] == tip_h - 1,
          "reorg_log records fork_height=%s unwound=%s"
          % (row["fork_height"] if row else None,
             row["blocks_unwound"] if row else None))
        orph = self.conn.execute("SELECT COUNT(*) c FROM orphaned_blocks WHERE hash=?",
                                 (doomed,)).fetchone()["c"]
        c(orph == 1, "the orphaned block is recorded in orphaned_blocks")
        gone = self.conn.execute("SELECT COUNT(*) c FROM blocks WHERE hash=?",
                                 (doomed,)).fetchone()["c"]
        c(gone == 0, "the orphaned block is NOT in blocks")
        self.assert_identical("after a 1-block reorg")

    # -- 2: a deep reorg -------------------------------------------------
    def phase_deep(self, depth=14, rebuild=18):
        c = self.check
        c.phase_begin("phase 2: a DEEP reorg (%d blocks unwound)" % depth)
        tip_h = self.a("getblockcount")
        fork_h = tip_h - depth
        doomed = self.a("getblockhash", fork_h + 1)
        old_hashes = [self.a("getblockhash", h) for h in range(fork_h + 1, tip_h + 1)]
        before_unwound = self.idx.blocks_unwound
        # Count only the fork-search probes, not the block fetches, so the
        # O(log depth) claim is measured rather than inferred.
        probes = {"n": 0}
        real_probe = self.idx._node_hash_at

        def counting_probe(height):
            probes["n"] += 1
            return real_probe(height)
        self.idx._node_hash_at = counting_probe
        self.a("invalidateblock", doomed)
        c(self.a("getblockcount") == fork_h, "node rolled back to the fork at %d"
          % fork_h)
        self.a("generatetoaddress", rebuild, self.addr["y"], wallet="tw")
        c(self.a("getblockcount") == fork_h + rebuild,
          "node rebuilt %d blocks -> height %d" % (rebuild, fork_h + rebuild))
        stats = self.idx.sync()
        unwound = self.idx.blocks_unwound - before_unwound
        c(unwound == depth, "exactly %d blocks unwound (%d)" % (depth, unwound))
        c(stats["applied"] == rebuild, "exactly %d blocks re-applied (%d)"
          % (rebuild, stats["applied"]))
        # find_fork is an exponential probe + binary search: O(log depth) probes,
        # not O(depth). Measure the cost, do not infer it.
        self.idx._node_hash_at = real_probe
        c(probes["n"] < depth, "the fork search used %d height probes for a "
          "%d-deep reorg (a linear walk would need >= %d)"
          % (probes["n"], depth, depth))
        still = self.conn.execute(
            "SELECT COUNT(*) c FROM blocks WHERE hash IN (%s)"
            % ",".join("?" * len(old_hashes)), old_hashes).fetchone()["c"]
        c(still == 0, "none of the %d orphaned hashes remain in blocks"
          % len(old_hashes))
        recorded = self.conn.execute(
            "SELECT COUNT(*) c FROM orphaned_blocks WHERE hash IN (%s)"
            % ",".join("?" * len(old_hashes)), old_hashes).fetchone()["c"]
        c(recorded == len(old_hashes), "all %d are in orphaned_blocks (%d)"
          % (len(old_hashes), recorded))
        self.assert_identical("after a %d-deep reorg" % depth)

    # -- 2b: two real nodes racing --------------------------------------
    def phase_two_nodes(self):
        """A reorg produced by two nodes disagreeing, with no invalidateblock.

        invalidateblock is a convenient lie: it makes the node throw a branch
        away on command. A real reorg arrives as a longer chain from a peer that
        the node then switches to on its own. This phase produces that.
        """
        c = self.check
        c.phase_begin("phase 2b: a reorg from a real competing node (no "
                      "invalidateblock)")
        try:
            self.start(self.b)
        except subprocess.CalledProcessError as exc:
            c(False, "node B started", str(exc))
            return
        binfo = self.b("getblockchaininfo")
        if binfo["chain"] != "regtest":
            c(False, "node B is regtest")
            return
        self.ensure_wallet(self.b)
        b_addr = self.b("getnewaddress", wallet="tw")
        # Sync B up to A.
        self.b("addnode", "127.0.0.1:%d" % self.args.p2p_port_a, "onetry")
        target = self.a("getblockcount")
        wait_for(lambda: self.b("getblockcount") == target, timeout=180,
                 what="node B to sync to height %d" % target)
        c(self.b("getbestblockhash") == self.a("getbestblockhash"),
          "node B synced to node A at height %d" % target)

        # Partition, then mine a short branch on A and a longer one on B.
        self.a("setnetworkactive", "false")
        self.b("setnetworkactive", "false")
        wait_for(lambda: not self.a("getpeerinfo") and not self.b("getpeerinfo"),
                 timeout=30, what="the partition")
        c(True, "partitioned: both nodes have 0 peers")
        self.a("generatetoaddress", 3, self.addr["x"], wallet="tw")
        self.b("generatetoaddress", 7, b_addr, wallet="tw")
        self.idx.sync()
        a_only_tip = self.a("getbestblockhash")
        c(self.idx.tip()[1] == a_only_tip,
          "the index followed node A's 3-block branch to height %d"
          % self.a("getblockcount"))
        a_branch = [self.a("getblockhash", h)
                    for h in range(target + 1, target + 4)]

        # Heal the partition. A must reorg to B's longer branch by itself.
        self.a("setnetworkactive", "true")
        self.b("setnetworkactive", "true")
        self.a("addnode", "127.0.0.1:%d" % self.args.p2p_port_b, "onetry")
        wait_for(lambda: self.a("getblockcount") == target + 7, timeout=180,
                 what="node A to adopt node B's branch")
        c(self.a("getbestblockhash") == self.b("getbestblockhash"),
          "node A reorged to node B's 7-block branch on its own")
        before = self.idx.blocks_unwound
        stats = self.idx.sync()
        c(self.idx.blocks_unwound - before == 3,
          "the indexer unwound A's 3 blocks (%d)" % (self.idx.blocks_unwound - before))
        c(stats["applied"] == 7, "and applied B's 7 (%d)" % stats["applied"])
        left = self.conn.execute(
            "SELECT COUNT(*) c FROM blocks WHERE hash IN (?,?,?)",
            a_branch).fetchone()["c"]
        c(left == 0, "none of A's abandoned blocks are still indexed")
        self.assert_identical("after a peer-driven reorg")
        # Shut B down and re-isolate A: the later phases use invalidateblock,
        # and a peer re-announcing the branch would undo it.
        self.stop(self.b)
        self.a("setnetworkactive", "false")
        wait_for(lambda: not self.a("getpeerinfo"), timeout=30,
                 what="A to drop its peers again")
        c(True, "node B stopped and node A re-isolated for the remaining phases")

    # -- 3: a reorg that orphans a coinbase ------------------------------
    def phase_coinbase(self):
        c = self.check
        c.phase_begin("phase 3: a reorg that INVALIDATES A COINBASE")
        cb_addr = self.a("getnewaddress", wallet="tw")
        self.a("generatetoaddress", 1, cb_addr, wallet="tw")
        cb_height = self.a("getblockcount")
        cb_hash = self.a("getblockhash", cb_height)
        cb_txid = self.a("getblock", cb_hash)["tx"][0]
        self.idx.sync()

        summary = queries.address_summary(self.conn, cb_addr)
        subsidy = self.conn.execute("SELECT subsidy FROM blocks WHERE height=?",
                                    (cb_height,)).fetchone()["subsidy"]
        c(summary["balance"] == subsidy and summary["balance"] > 0,
          "the fresh coinbase credits %d sat to %s" % (subsidy, cb_addr[:20]),
          "index says %d" % summary["balance"])
        c(summary["immature"] == subsidy,
          "and all of it is immature (maturity height %d)" % (cb_height + 100))
        c(summary["spendable"] == 0, "spendable is 0 while immature")
        scan = self.a("scantxoutset", "start", json.dumps(["addr(%s)" % cb_addr]))
        c(round(float(scan["total_amount"]) * COIN) == subsidy,
          "the node's own scantxoutset agrees (%s PCN)" % scan["total_amount"])

        # Now orphan it.
        self.a("invalidateblock", cb_hash)
        self.a("generatetoaddress", 3, self.addr["y"], wallet="tw")
        self.idx.sync()

        row = self.conn.execute("SELECT * FROM addresses WHERE address=?",
                                (cb_addr,)).fetchone()
        c(row is None, "the address row is GONE, not left at a stale balance",
          "row is %r" % (dict(row) if row else None))
        after = queries.address_summary(self.conn, cb_addr)
        c(after["balance"] == 0 and after["received"] == 0 and after["tx_count"] == 0,
          "address_summary reports 0 balance / 0 received / 0 txs",
          repr({k: after[k] for k in ("balance", "received", "sent", "tx_count")}))
        outs = self.conn.execute("SELECT COUNT(*) c FROM outputs WHERE address=?",
                                 (cb_addr,)).fetchone()["c"]
        c(outs == 0, "no output rows survive for that address")
        txrow = self.conn.execute("SELECT COUNT(*) c FROM txs WHERE txid=?",
                                  (cb_txid,)).fetchone()["c"]
        c(txrow == 0, "the coinbase transaction row is gone")
        atx = self.conn.execute("SELECT COUNT(*) c FROM address_txs WHERE address=?",
                                (cb_addr,)).fetchone()["c"]
        c(atx == 0, "no address_txs rows survive")
        scan = self.a("scantxoutset", "start", json.dumps(["addr(%s)" % cb_addr]))
        c(round(float(scan["total_amount"]) * COIN) == 0,
          "the node agrees the address holds nothing (%s PCN)" % scan["total_amount"])
        self.assert_identical("after orphaning a coinbase")

        # The nastier variant: the SAME address is paid again on the winning
        # branch. A unwind that forgot a row leaves the address holding two
        # subsidies, and nothing downstream would ever notice.
        self.a("generatetoaddress", 1, cb_addr, wallet="tw")
        again_h = self.a("getblockcount")
        self.idx.sync()
        subsidy2 = self.conn.execute("SELECT subsidy FROM blocks WHERE height=?",
                                     (again_h,)).fetchone()["subsidy"]
        s = queries.address_summary(self.conn, cb_addr)
        c(s["balance"] == subsidy2 and s["utxo_count"] == 1 and s["tx_count"] == 1,
          "paid again on the winning branch, the address holds exactly ONE "
          "subsidy (%d sat, 1 utxo, 1 tx) -- not two"
          % s["balance"],
          repr({k: s[k] for k in ("balance", "utxo_count", "tx_count", "received")}))
        c(s["received"] == subsidy2,
          "and lifetime `received` counts the orphaned credit zero times")
        scan = self.a("scantxoutset", "start", json.dumps(["addr(%s)" % cb_addr]))
        c(round(float(scan["total_amount"]) * COIN) == subsidy2,
          "scantxoutset agrees: %s PCN" % scan["total_amount"])
        self.assert_identical("same address credited on both branches")

    # -- 4: crash mid-reorg ----------------------------------------------
    def _crash_run(self, dbpath, mode, n):
        env = dict(os.environ, PYTHONPATH=EXPLORER_DIR)
        p = subprocess.run(
            [sys.executable, os.path.abspath(__file__), "crashdriver",
             "--db", dbpath, "--rpc-url", self.rpc_url, "--cookie", self.cookie,
             "--kill-mode", mode, "--kill-n", str(n)],
            env=env, cwd=EXPLORER_DIR, capture_output=True)
        return p

    def _db_tip(self, path):
        c = db.connect(path, readonly=True)
        row = c.execute("SELECT MAX(height) h FROM blocks").fetchone()
        st = c.execute("SELECT indexed_height, status FROM sync_state"
                       " WHERE id=1").fetchone()
        probs = verify(c, deep=True)
        c.close()
        return row["h"], dict(st), probs

    def _finish(self, path):
        env = dict(os.environ, PYTHONPATH=EXPLORER_DIR)
        subprocess.check_call(
            [sys.executable, "-m", "pcoin_indexer", "--db", path,
             "--rpc-url", self.rpc_url, "--rpc-cookie", self.cookie,
             "--chain", "regtest", "--quiet", "sync"],
            env=env, cwd=EXPLORER_DIR, stdout=subprocess.DEVNULL)

    def phase_crash(self):
        c = self.check
        c.phase_begin("phase 4: SIGKILL BETWEEN UNWIND AND RE-APPLY")
        path = os.path.join(self.dbdir, "crash.sqlite")
        for suffix in ("", "-wal", "-shm"):
            try:
                os.remove(path + suffix)
            except OSError:
                pass
        self._finish(path)              # a normal, complete index to start from
        tip_h, st, probs = self._db_tip(path)
        c(probs == [] and tip_h == self.a("getblockcount"),
          "a separate index is synced to height %s" % tip_h)

        depth = 12
        fork_h = tip_h - depth
        doomed = self.a("getblockhash", fork_h + 1)
        self.a("invalidateblock", doomed)
        self.a("generatetoaddress", depth + 5, self.addr["x"], wallet="tw")
        node_tip = self.a("getblockcount")
        c(node_tip == fork_h + depth + 5,
          "provoked a %d-deep reorg; node is now at %d" % (depth, node_tip))

        # (a) the exact window the task names: every block unwound, nothing
        #     re-applied yet.
        p = self._crash_run(path, "between", 0)
        c(p.returncode == -signal.SIGKILL,
          "the indexer was SIGKILLed (rc=%s)" % p.returncode,
          p.stderr.decode()[-300:])
        marker = p.stderr.decode()
        crash_tip, st, probs = self._db_tip(path)
        c(crash_tip == fork_h,
          "the crashed database sits exactly at the fork height %d (found %s)"
          % (fork_h, crash_tip), marker[-200:])
        c(crash_tip < tip_h and crash_tip < node_tip,
          "which is below BOTH the old tip (%d) and the node tip (%d) -- i.e. the "
          "kill really did land between the unwind and the re-apply"
          % (tip_h, node_tip))
        c(probs == [], "the half-finished index still passes deep verify -- a "
          "crash left a valid chain PREFIX, not a mixture of branches",
          str(probs[:3]))
        c(st["indexed_height"] == crash_tip,
          "sync_state.indexed_height (%s) matches the surviving blocks"
          % st["indexed_height"])

        # (b) restart into the SAME reorg and kill again, this time four blocks
        #     into the re-apply. Note what the restarted process sees: the index
        #     is now a strict prefix of the node's chain, so there is nothing
        #     left to unwind and the recovery is a plain forward sync. That is
        #     the Corollary in the module docstring, observed rather than argued.
        p = self._crash_run(path, "after-applies", 4)
        c(p.returncode == -signal.SIGKILL,
          "restarted into the same reorg and SIGKILLed 4 blocks into the "
          "re-apply (rc=%s)" % p.returncode, p.stderr.decode()[-300:])
        marker = p.stderr.decode()
        c("unwinds=0" in marker, "the restart had nothing left to unwind -- the "
          "recovery from a crash mid-reorg is a plain forward sync from the "
          "fork, exactly as the Corollary claims", marker[-200:])
        mid_tip, st, probs = self._db_tip(path)
        c(mid_tip == fork_h + 4, "the index is at %d = fork + 4 re-applied"
          % mid_tip, "expected %d" % (fork_h + 4))
        c(probs == [], "still a valid chain prefix after the second kill",
          str(probs[:3]))

        # (c) a fresh reorg, killed with the unwind and the re-apply in the SAME
        #     process, part way through the re-apply.
        self._finish(path)
        tip_h2, _, _ = self._db_tip(path)
        fork2 = tip_h2 - 8
        self.a("invalidateblock", self.a("getblockhash", fork2 + 1))
        self.a("generatetoaddress", 12, self.addr["x"], wallet="tw")
        p = self._crash_run(path, "mid-reapply", 4)
        c(p.returncode == -signal.SIGKILL,
          "a second reorg, unwound and re-applied in one process, SIGKILLed 4 "
          "blocks into the re-apply (rc=%s)" % p.returncode,
          p.stderr.decode()[-300:])
        mid2, _, probs = self._db_tip(path)
        c(mid2 == fork2 + 4, "the index is at %d = fork(%d) + 4" % (mid2, fork2))
        c(probs == [], "valid chain prefix after a kill inside a live reorg",
          str(probs[:3]))

        # (d) kill a fourth time while still *unwinding*, to prove a partially
        #     unwound index just gets unwound further rather than repaired.
        self._finish(path)
        tip_h3, _, _ = self._db_tip(path)
        self.a("invalidateblock", self.a("getblockhash", tip_h3 - 9))
        self.a("generatetoaddress", 14, self.addr["y"], wallet="tw")
        p = self._crash_run(path, "after-unwinds", 3)
        c(p.returncode == -signal.SIGKILL,
          "SIGKILLed 3 blocks into a 10-block unwind (rc=%s)" % p.returncode)
        part_tip, _, probs = self._db_tip(path)
        c(part_tip == tip_h3 - 3, "the index is partially unwound: %d (was %d)"
          % (part_tip, tip_h3))
        c(probs == [], "a PARTIALLY unwound index is still self-consistent",
          str(probs[:3]))

        # Now let an ordinary, unmodified indexer finish and prove convergence.
        self._finish(path)
        final_tip, st, probs = self._db_tip(path)
        c(probs == [], "the resumed index passes deep verify", str(probs[:3]))
        c(final_tip == self.a("getblockcount"),
          "the resumed index caught up to the node tip %d" % final_tip)
        c(st["status"] == "ok", "status marker reads 'ok' (%s)" % st["status"])
        self.assert_identical("crashed 4x, then resumed", path=path)

        # The audit trail, which is a weaker guarantee than the balances and is
        # worth stating precisely rather than assuming. `orphaned_blocks` is
        # written inside each per-block unwind transaction, so it survives any
        # crash. The reorg_log SUMMARY row and sync_state's counters are written
        # by handle_reorg only after unwind_to finishes, so a kill mid-unwind
        # loses them -- the blocks are still correctly unwound, only the
        # bookkeeping about why is gone.
        cc = db.connect(path, readonly=True)
        rl = cc.execute("SELECT COUNT(*) n, COALESCE(SUM(blocks_unwound),0) u"
                        " FROM reorg_log").fetchone()
        orph = cc.execute("SELECT COUNT(*) n FROM orphaned_blocks").fetchone()["n"]
        cst = db.get_state(cc)
        cc.close()
        c(orph >= rl["u"], "orphaned_blocks recorded all %d unwound blocks; it is "
          "written inside each unwind transaction so a crash cannot lose it"
          % orph)
        c(cst["blocks_unwound"] == rl["u"] and cst["reorg_count"] == rl["n"],
          "sync_state's counters agree with reorg_log (%d reorgs / %d blocks)"
          % (cst["reorg_count"], cst["blocks_unwound"]))
        if orph != rl["u"]:
            print("  note: reorg_log accounts for %d unwound blocks but %d were "
                  "actually unwound. The %d-block difference is the unwind that "
                  "was SIGKILLed part way through: handle_reorg writes its "
                  "summary row only after unwind_to returns, so that summary is "
                  "lost. Balances are unaffected -- proved by the row-for-row "
                  "identity above -- and the orphaned hashes are still recorded."
                  % (rl["u"], orph, orph - rl["u"]))

        # And the live index, which never crashed, must land on the same place.
        self.idx.sync()
        self.assert_identical("the never-crashed live index, same final chain")

    # -- 5: block on one branch, mempool on the other --------------------
    def phase_mempool_double_count(self):
        c = self.check
        c.phase_begin("phase 5: a tx in a BLOCK on one branch and in the MEMPOOL "
                      "on the other")
        x = self.a("getnewaddress", wallet="tw")
        self.a("settxfee", "0.00010000", wallet="tw")
        txid = self.a("sendtoaddress", x, 12.5, wallet="tw")
        self.a("generatetoaddress", 1, self.addr["mine"], wallet="tw")
        spend_h = self.a("getblockcount")
        spend_block = self.a("getblockhash", spend_h)
        self.idx.sync()

        row = self.conn.execute("SELECT height FROM txs WHERE txid=?",
                                (txid,)).fetchone()
        c(row is not None and row["height"] == spend_h,
          "the spend is indexed at height %d" % spend_h)
        s = queries.address_summary(self.conn, x)
        c(s["balance"] == 1250000000, "the recipient shows 12.5 PCN confirmed",
          "%d sat" % s["balance"])
        # what the tx spends, so we can watch the sender side too
        srcs = [(i["prev_txid"], i["prev_n"]) for i in
                self.conn.execute("SELECT prev_txid, prev_n FROM inputs WHERE txid=?"
                                  " AND prev_txid IS NOT NULL", (txid,)).fetchall()]
        c(bool(srcs), "the spend consumes %d confirmed output(s)" % len(srcs))

        # Orphan the block. Core returns its transactions to the mempool.
        self.a("invalidateblock", spend_block)
        # Build a strictly longer branch that does NOT contain the tx.
        # generateblock with an empty tx list ignores the mempool entirely.
        for _ in range(3):
            self.a("generateblock", self.addr["y"], "[]", wallet="tw")
        mem = self.a("getrawmempool")
        c(txid in mem, "the orphaned tx is back in the node's mempool")
        c(self.a("getblockcount") > spend_h,
          "the new branch is longer (%d > %d) and does not contain it"
          % (self.a("getblockcount"), spend_h))
        self.idx.sync()

        gone = self.conn.execute("SELECT COUNT(*) c FROM txs WHERE txid=?",
                                 (txid,)).fetchone()["c"]
        c(gone == 0, "the index no longer holds the transaction at all")
        s2 = queries.address_summary(self.conn, x)
        c(s2["balance"] == 0 and s2["received"] == 0 and s2["tx_count"] == 0,
          "the recipient's CONFIRMED balance is 0, not 12.5 and not 25",
          repr({k: s2[k] for k in ("balance", "received", "tx_count")}))
        for prev_txid, prev_n in srcs:
            o = self.conn.execute("SELECT spent_height FROM outputs WHERE txid=? "
                                  "AND n=?", (prev_txid, prev_n)).fetchone()
            c(o is not None and o["spent_height"] is None,
              "the input it consumed is unspent again in the index (%s:%d)"
              % (prev_txid[:12], prev_n))

        # The API layer is where a double count would actually show up: it adds
        # a live mempool view on top of the index.
        api = self.build_service()
        out = api.address(x)
        conf = out["balance"]["confirmed"]
        unconf = out["balance"]["unconfirmed"]
        c(conf["onchain_unspent_sat"] == 0,
          "API: confirmed.onchain_unspent is 0 sat",
          json.dumps(conf, default=str)[:300])
        c(unconf.get("known") and unconf.get("receiving_sat") == 1250000000,
          "API: the same 12.5 PCN appears exactly once, in the UNCONFIRMED bucket",
          json.dumps(unconf, default=str)[:300])
        c(out["balance"]["lifetime"]["received_sat"] == 0,
          "API: lifetime received (confirmed history) stays 0")
        c("total" not in conf and "total" not in out["balance"],
          "API: there is no field that sums confirmed and unconfirmed together")

        # Sender side: the coin the mempool tx spends is confirmed and unspent in
        # the index, so it must be reported as pending-spend, not as spendable.
        src_addr = self.conn.execute(
            "SELECT address FROM outputs WHERE txid=? AND n=?", srcs[0]).fetchone()
        if src_addr and src_addr["address"]:
            sout = api.address(src_addr["address"])["balance"]["confirmed"]
            c(sout["pending_spend_sat"] > 0,
              "API: the sender's coin is counted as pending_spend (%d sat)"
              % sout["pending_spend_sat"])
            c(sout["spendable_sat"] == sout["mature_sat"] - sout["pending_spend_sat"],
              "API: spendable = mature - pending_spend, so it is not offered twice")

        # /utxos is the endpoint a wallet actually spends from: the coin the
        # mempool tx is consuming must not be offered back to it.
        for prev_txid, prev_n in srcs:
            src_row = self.conn.execute(
                "SELECT address FROM outputs WHERE txid=? AND n=?",
                (prev_txid, prev_n)).fetchone()
            if not src_row or not src_row["address"]:
                continue
            u = api.address_utxos(src_row["address"], {"limit": "2000"})
            offered = [o for o in u["utxos"]
                       if o["txid"] == prev_txid and o["vout"] == prev_n]
            c(offered == [],
              "API /utxos does NOT offer back the coin the mempool tx is "
              "spending", json.dumps(offered, default=str)[:300])
            c(u["summary"]["pending_spend_sat"] > 0,
              "API /utxos accounts for it in the pending_spend bucket (%s sat)"
              % u["summary"]["pending_spend_sat"])
            u2 = api.address_utxos(src_row["address"],
                                   {"limit": "2000", "include_pending_spend": "1"})
            shown = [o for o in u2["utxos"]
                     if o["txid"] == prev_txid and o["vout"] == prev_n]
            c(len(shown) == 1 and shown[0]["spendable"] is False
              and shown[0]["spent_in_mempool"] is True,
              "and when explicitly asked for, it comes back flagged "
              "spendable=false / spent_in_mempool=true",
              json.dumps(shown, default=str)[:300])
            break

        # Now re-mine it, at a DIFFERENT height than before. The same txid moving
        # to a new height is the case a naive "insert or ignore" index gets wrong.
        self.a("generatetoaddress", 1, self.addr["mine"], wallet="tw")
        new_h = self.a("getblockcount")
        c(new_h != spend_h, "the tx is re-mined at height %d, not its old %d"
          % (new_h, spend_h))
        c(txid in self.a("getblock", self.a("getblockhash", new_h))["tx"],
          "the re-mined block really contains the same txid")
        self.idx.sync()
        row = self.conn.execute("SELECT height FROM txs WHERE txid=?",
                                (txid,)).fetchone()
        c(row is not None and row["height"] == new_h,
          "the index holds it once, at the new height %d" % new_h,
          repr(dict(row)) if row else "missing")
        dupes = self.conn.execute(
            "SELECT COUNT(*) c FROM address_txs WHERE txid=? AND address=?",
            (txid, x)).fetchone()["c"]
        c(dupes == 1, "exactly one address_txs row for (x, txid) -- not two")
        s3 = queries.address_summary(self.conn, x)
        c(s3["balance"] == 1250000000 and s3["received"] == 1250000000,
          "the recipient is back to exactly 12.5 PCN, received exactly 12.5",
          repr({k: s3[k] for k in ("balance", "received", "tx_count")}))
        api2 = self.build_service()
        out2 = api2.address(x)
        c(out2["balance"]["confirmed"]["onchain_unspent_sat"] == 1250000000,
          "API: 12.5 PCN confirmed")
        c(out2["balance"]["unconfirmed"].get("receiving_sat") == 0,
          "API: and 0 unconfirmed -- it did not stay in both buckets",
          json.dumps(out2["balance"]["unconfirmed"], default=str)[:200])
        self.assert_identical("after the tx moved block -> mempool -> block")

    def build_service(self):
        """A live API service over the current index and node.

        Built fresh each time so nothing is served out of a stale cache -- the
        point of this phase is what the API says at one exact instant.
        """
        from pcoin_api.service import Service
        from pcoin_api.store import Store
        from pcoin_api.nodeview import NodeView
        store = Store(self.live_db)
        node = NodeView(self.new_rpc(), resolver=store.resolve_outpoints,
                        cache_seconds=0.0)
        return Service(store, node)

    # -- 7: chaos --------------------------------------------------------
    def phase_chaos(self, seconds=30):
        """Reorg the node *while* the indexer is mid-sync.

        Every phase so far mutated the node and then let the indexer look. This
        one does not stop. It is the only way to reach the three paths that only
        fire when the chain moves between two RPC calls: `getblockhash` coming
        back -8 for a height that existed a moment ago, `getblock` returning a
        block with `confirmations = -1` because it is no longer on the active
        chain, and `apply_block` raising ChainLinkError on a batch that was
        correct when it was fetched. On a chain with a 3% stale rate those are
        not exotic, they are Tuesday.
        """
        c = self.check
        c.phase_begin("phase 7: CHAOS -- the node reorging while the indexer syncs")
        stop = threading.Event()
        errors = []
        counts = {"mine_rounds": 0, "reorgs_forced": 0, "blocks_mined": 0,
                  "deepest": 0}
        rng = random.Random(20260804)

        def churn():
            try:
                while not stop.is_set():
                    tip = self.a("getblockcount")
                    if rng.random() < 0.5 and tip > 40:
                        depth = rng.randint(1, 8)
                        self.a("invalidateblock", self.a("getblockhash",
                                                         tip - depth + 1))
                        counts["reorgs_forced"] += 1
                        counts["deepest"] = max(counts["deepest"], depth)
                        n = depth + rng.randint(0, 3)
                    else:
                        counts["mine_rounds"] += 1
                        n = rng.randint(1, 4)
                    # A FRESH address every round. Rebuilding on the same parent,
                    # to the same address, inside the same second reproduces the
                    # block that was just invalidated byte for byte, and the node
                    # rejects it as already-known-invalid. That is a property of
                    # regtest mining, not of the indexer, but it stops the churn
                    # dead if you do not avoid it.
                    self.a("generatetoaddress", n,
                           self.a("getnewaddress", wallet="tw"), wallet="tw")
                    counts["blocks_mined"] += n
                    time.sleep(rng.uniform(0.0, 0.04))
            except Exception as exc:                       # noqa: BLE001
                errors.append("churn thread: %r" % exc)

        # Instrument the two RPC results that only occur when the chain moves
        # between two calls, so "those paths were exercised" is a measurement.
        race = {"missing_height": 0, "stale_block": 0}
        real_hashes = self.idx.rpc.block_hashes
        real_blocks = self.idx.rpc.blocks_verbose

        def counting_hashes(heights):
            out = real_hashes(heights)
            if any(h is None for h in out):
                race["missing_height"] += 1
            return out

        def counting_blocks(hashes, verbosity=3):
            out = real_blocks(hashes, verbosity)
            for b in out:
                if b is None or (b.get("confirmations") is not None
                                 and b["confirmations"] < 0):
                    race["stale_block"] += 1
                    break
            return out
        self.idx.rpc.block_hashes = counting_hashes
        self.idx.rpc.blocks_verbose = counting_blocks

        log_before = self.conn.execute(
            "SELECT COALESCE(MAX(id),0) m FROM reorg_log").fetchone()["m"]
        worker = threading.Thread(target=churn, daemon=True)
        worker.start()
        syncs = 0
        deadline = time.time() + seconds
        before_reorgs = self.idx.reorgs
        before_unwound = self.idx.blocks_unwound
        while time.time() < deadline and not errors:
            try:
                # A small batch so a reorg is much more likely to land in the
                # middle of one rather than between two.
                self.idx.sync(batch=4)
                syncs += 1
            except Exception as exc:                       # noqa: BLE001
                errors.append("sync raised: %r" % exc)
        stop.set()
        worker.join(timeout=120)
        self.idx.rpc.block_hashes = real_hashes
        self.idx.rpc.blocks_verbose = real_blocks
        c(not errors, "%d sync passes while the node reorged underneath, with no "
          "exception" % syncs, "; ".join(errors[:3]))
        c(counts["reorgs_forced"] > 5,
          "the churn thread forced %d reorgs (deepest %d) and mined %d blocks in "
          "%ds" % (counts["reorgs_forced"], counts["deepest"],
                   counts["blocks_mined"], seconds))
        c(self.idx.reorgs - before_reorgs > 0,
          "the indexer detected and handled %d reorg(s), unwinding %d block(s)"
          % (self.idx.reorgs - before_reorgs,
             self.idx.blocks_unwound - before_unwound))
        # Which detection path fired, measured. Informational: a fast poll loop
        # nearly always catches the node in its momentarily-shortened state, so
        # chaos reaches the "index >= node tip" path and phases 1-5 reach the
        # parent-mismatch one. The run-wide assertion is at the end of run().
        by_path = {"parent mismatch (ChainLinkError)": 0, "index >= node tip": 0}
        for r in self.conn.execute("SELECT detail FROM reorg_log WHERE id > ?",
                                   (log_before,)):
            key = ("index >= node tip" if (r["detail"] or "").startswith("index >=")
                   else "parent mismatch (ChainLinkError)")
            by_path[key] += 1
        print("  note: detection paths during chaos: %s; mid-fetch races seen: "
              "%d vanished heights, %d off-chain blocks (phase 7b forces both "
              "deterministically)"
              % (", ".join("%s x%d" % (k, v) for k, v in by_path.items()),
                 race["missing_height"], race["stale_block"]))
        # The node is quiet again; let the index settle and check it is exact.
        for _ in range(10):
            stats = self.idx.sync()
            if stats["caught_up"]:
                break
        c(stats["caught_up"], "the index settled onto the node tip afterwards")
        self.assert_identical("after %ds of continuous reorging" % seconds)

    # -- 7b: the two mid-fetch races, forced ------------------------------
    def phase_fetch_races(self):
        """Reorg the node *inside* one sync pass, deterministically.

        `sync_once` observes the tip, asks for a range of block hashes, then asks
        for those blocks. Two windows exist between those calls, and on a chain
        with a 3% stale rate they will both be hit eventually. Waiting for the
        race to happen by luck proves nothing when it does not fire, so these
        hooks make the node reorg at the exact instant, once.
        """
        c = self.check
        c.phase_begin("phase 7b: the node reorging INSIDE a single sync pass")
        self.idx.sync()
        base = self.idx.tip_height()

        # (i) the heights vanish between the tip observation and getblockhash.
        self.a("generatetoaddress", 6, self.a("getnewaddress", wallet="tw"),
               wallet="tw")
        real_hashes = self.idx.rpc.block_hashes
        fired = {"n": 0, "nones": 0}

        def shortening_hashes(heights):
            if fired["n"] == 0:
                fired["n"] = 1
                # The node throws the whole range away right now.
                self.a("invalidateblock", self.a("getblockhash", base + 1))
            out = real_hashes(heights)
            fired["nones"] += sum(1 for h in out if h is None)
            return out
        self.idx.rpc.block_hashes = shortening_hashes
        stats = self.idx.sync()
        self.idx.rpc.block_hashes = real_hashes
        c(fired["nones"] > 0,
          "getblockhash answered -8 for %d height(s) that existed a moment "
          "earlier, and the indexer re-polled instead of guessing"
          % fired["nones"])
        c(self.idx.tip_height() == base and stats["applied"] == 0,
          "the index correctly stayed at %d and applied nothing"
          % self.idx.tip_height())
        c(verify(self.conn, deep=True) == [], "index still verifies")

        # (ii) the blocks are still known but leave the active chain between
        #      getblockhash and getblock -- Core reports confirmations = -1.
        self.a("generatetoaddress", 6, self.a("getnewaddress", wallet="tw"),
               wallet="tw")
        doomed = self.a("getblockhash", base + 1)
        real_blocks = self.idx.rpc.blocks_verbose
        seen = {"n": 0, "offchain": 0}

        def switching_blocks(hashes, verbosity=3):
            if seen["n"] == 0:
                seen["n"] = 1
                self.a("invalidateblock", doomed)
                self.a("generatetoaddress", 9,
                       self.a("getnewaddress", wallet="tw"), wallet="tw")
            out = real_blocks(hashes, verbosity)
            for b in out:
                if b is None or (b.get("confirmations") is not None
                                 and b["confirmations"] < 0):
                    seen["offchain"] += 1
            return out
        self.idx.rpc.blocks_verbose = switching_blocks
        before_applied = self.idx.blocks_applied
        self.idx.sync()
        self.idx.rpc.blocks_verbose = real_blocks
        c(seen["offchain"] > 0,
          "getblock returned %d block(s) with confirmations < 0 -- fetched from "
          "the active chain, off it by the time they arrived" % seen["offchain"])
        c(self.idx.tip_height() == self.a("getblockcount"),
          "the indexer re-polled and landed on the winning branch at %d"
          % self.idx.tip_height())
        c(self.idx.blocks_applied > before_applied,
          "having applied %d block(s) of it"
          % (self.idx.blocks_applied - before_applied))
        self.assert_identical("after two reorgs inside a single sync pass")

    # -- 8: a reorg all the way to genesis --------------------------------
    def phase_to_genesis(self):
        c = self.check
        c.phase_begin("phase 8: a reorg that unwinds EVERY block back to genesis")
        tip = self.a("getblockcount")
        genesis = self.a("getblockhash", 0)
        self.a("invalidateblock", self.a("getblockhash", 1))
        c(self.a("getblockcount") == 0, "the node is back at genesis")
        self.a("generatetoaddress", tip + 5, self.addr["mine"], wallet="tw")
        before = self.idx.blocks_unwound
        stats = self.idx.sync()
        c(self.idx.blocks_unwound - before == tip,
          "the indexer unwound all %d blocks above genesis (%d)"
          % (tip, self.idx.blocks_unwound - before))
        c(stats["applied"] == tip + 5, "and applied the %d replacements (%d)"
          % (tip + 5, stats["applied"]))
        row = self.conn.execute("SELECT hash FROM blocks WHERE height=0").fetchone()
        c(row is not None and row["hash"] == genesis,
          "height 0 was never unwound -- the fork search bottomed out at genesis, "
          "not at -1")
        c(self.conn.execute("SELECT COUNT(*) c FROM blocks").fetchone()["c"]
          == tip + 6, "the index holds exactly heights 0..%d" % (tip + 5))
        self.assert_identical("after a reorg back to genesis")

    # -- 6: the real chain -----------------------------------------------
    def phase_mainnet(self, datadir, sample=40):
        c = self.check
        c.phase_begin("phase 6: the REAL chain -- index vs scantxoutset")
        cli = Cli(self.args.bin, datadir, "mainnet")
        info = cli("getblockchaininfo")
        if info["chain"] != "main":
            c(False, "the mainnet node is on chain %r" % info["chain"])
            return
        c(True, "read-only against the synced mainnet node at height %d"
          % info["blocks"])
        rpc = RpcClient("http://127.0.0.1:9443/",
                        cookie_path=os.path.join(datadir, ".cookie"))
        path = os.path.join(self.dbdir, "mainnet.sqlite")
        started = time.monotonic()
        stats = reindex(path, rpc, in_place=True)
        elapsed = time.monotonic() - started
        conn = db.connect(path, readonly=True)
        probs = verify(conn, deep=True)
        c(probs == [], "deep verify of the mainnet index is clean (%d blocks in "
          "%.1fs)" % (stats["indexed_height"] + 1, elapsed), str(probs[:5]))

        # PIN THE COMPARISON TO ONE BLOCK. A live mainnet node keeps moving --
        # the first version of this check compared an index at height 2136
        # against a UTXO set at 2137 and reported a 50 PCN "mismatch" that was
        # really one new coinbase. Everything below must describe the same tip,
        # so every oracle's `bestblock` is required to equal the index tip, and
        # the whole comparison is redone if the node advances during it.
        for attempt in range(6):
            idx_tip = conn.execute("SELECT hash FROM blocks ORDER BY height DESC"
                                   " LIMIT 1").fetchone()["hash"]
            utxo = cli("gettxoutsetinfo")
            if utxo.get("bestblock") == idx_tip:
                break
            conn.close()
            c(True, "the node advanced to %d mid-check; re-syncing the index and "
              "starting the comparison again" % utxo.get("height"))
            stats = reindex(path, rpc, in_place=True)
            conn = db.connect(path, readonly=True)
        c(utxo.get("bestblock") == idx_tip,
          "the index and gettxoutsetinfo describe the SAME block (%s at height "
          "%s)" % (idx_tip[:16], utxo.get("height")))

        row = conn.execute(
            "SELECT COUNT(*) n, COALESCE(SUM(value),0) v FROM outputs"
            " WHERE spent_height IS NULL AND unspendable=0").fetchone()
        c(row["n"] == utxo["txouts"], "utxo count %d == gettxoutsetinfo.txouts %d"
          % (row["n"], utxo["txouts"]))
        c(row["v"] == round(float(utxo["total_amount"]) * COIN),
          "total supply %s PCN == gettxoutsetinfo.total_amount %s"
          % (row["v"] / COIN, utxo["total_amount"]))

        # address-level ground truth: scantxoutset shares no code with the index
        addrs = [r["address"] for r in conn.execute(
            "SELECT address FROM addresses ORDER BY balance DESC LIMIT ?",
            (sample // 2,))]
        rest = [r["address"] for r in conn.execute(
            "SELECT address FROM addresses ORDER BY address")]
        random.seed(20260804)
        extra = [a for a in random.sample(rest, min(len(rest), sample)) if a not in addrs]
        addrs += extra[:sample - len(addrs)]
        # deliberately include addresses whose balance is zero (fully spent)
        spent = [r["address"] for r in conn.execute(
            "SELECT address FROM addresses WHERE balance = 0 LIMIT 5")]
        for a in spent:
            if a not in addrs:
                addrs.append(a)

        total_addrs = conn.execute("SELECT COUNT(*) c FROM addresses").fetchone()["c"]
        mismatches = []
        moved = []
        zero_checked = 0
        for a in addrs:
            idx_row = conn.execute(
                "SELECT balance, utxo_count FROM addresses WHERE address=?",
                (a,)).fetchone()
            scan = cli("scantxoutset", "start", json.dumps(["addr(%s)" % a]))
            if scan.get("bestblock") != idx_tip:
                # A new block landed mid-scan. That answer describes a different
                # chain state, so it is not evidence either way -- it is
                # discarded, never counted as a match OR as a mismatch.
                moved.append(a)
                continue
            node_sat = round(float(scan["total_amount"]) * COIN)
            node_n = len(scan.get("unspents") or [])
            idx_sat = idx_row["balance"] if idx_row else 0
            idx_n = idx_row["utxo_count"] if idx_row else 0
            if idx_sat == 0:
                zero_checked += 1
            if node_sat != idx_sat or node_n != idx_n:
                mismatches.append("%s: index %d sat/%d utxo, scantxoutset %d sat/%d "
                                  "utxo" % (a, idx_sat, idx_n, node_sat, node_n))
        addrs = [a for a in addrs if a not in moved]
        if moved:
            print("  note: %d scan(s) discarded because the node advanced during "
                  "them" % len(moved))
        c(not mismatches, "all %d sampled addresses match scantxoutset exactly, "
          "balance AND utxo count (%d of them fully spent, at zero balance)"
          % (len(addrs), zero_checked), "\n".join(mismatches[:8]))
        c(len(addrs) + len(moved) == total_addrs,
          "the sample covered every one of the %d addresses that exist on the "
          "chain (%d compared, %d discarded as racing a new block)"
          % (total_addrs, len(addrs), len(moved)))

        # a spent output must not still be counted
        c(conn.execute("SELECT COUNT(*) c FROM outputs WHERE spent_height IS NOT NULL"
                       " AND spent_by_txid IS NULL").fetchone()["c"] == 0,
          "no output is marked spent without a spender")
        rows = {t: conn.execute("SELECT COUNT(*) c FROM %s" % t).fetchone()["c"]
                for t in ("blocks", "txs", "outputs", "inputs", "address_txs",
                          "addresses")}
        n_tips = len(cli("getchaintips") or [])
        print("  note: this node reports %d chain tip(s). The seed reports ~66; "
              "a node that synced the active chain from a peer never learns "
              "about the competing branches, so THIS node cannot demonstrate a "
              "mainnet reorg. The reorg evidence is the regtest phases." % n_tips)
        conn.close()
        return {"height": stats["indexed_height"], "seconds": round(elapsed, 1),
                "addresses_checked": len(addrs), "addresses_total": total_addrs,
                "chaintips": n_tips, "rows": rows}

    # -- coverage of the detection paths, over the whole run --------------
    def phase_detection_coverage(self):
        c = self.check
        c.phase_begin("coverage: every reorg-detection path, over the whole run")
        rows = self.conn.execute("SELECT detail, blocks_unwound FROM reorg_log"
                                 ).fetchall()
        by_path = {"parent mismatch (ChainLinkError)": 0, "index >= node tip": 0}
        for r in rows:
            key = ("index >= node tip" if (r["detail"] or "").startswith("index >=")
                   else "parent mismatch (ChainLinkError)")
            by_path[key] += 1
        for name, n in by_path.items():
            c(n > 0, "detection path %r fired %d time(s)" % (name, n))
        total = sum(r["blocks_unwound"] for r in rows)
        deepest = max([r["blocks_unwound"] for r in rows] or [0])
        c(len(rows) > 50, "%d reorgs logged on the live index, %d blocks unwound "
          "in total, deepest single reorg %d blocks"
          % (len(rows), total, deepest))
        st = db.get_state(self.conn)
        c(st["reorg_count"] == len(rows) and st["blocks_unwound"] == total,
          "sync_state's own counters agree: %d reorgs / %d unwound"
          % (st["reorg_count"], st["blocks_unwound"]))

    # ===================================================================
    def run(self):
        self.phase_setup()
        self.phase_one_block()
        self.phase_deep()
        if not self.args.no_second_node:
            self.phase_two_nodes()
        self.phase_coinbase()
        self.phase_crash()
        self.phase_mempool_double_count()
        self.phase_chaos(seconds=self.args.chaos_seconds)
        self.phase_fetch_races()
        self.phase_to_genesis()
        self.phase_detection_coverage()
        extra = None
        if self.args.mainnet_datadir:
            extra = self.phase_mainnet(self.args.mainnet_datadir,
                                       sample=self.args.mainnet_sample)
        print("\n%d checks, %d failed" % (self.check.n, len(self.check.failed)))
        for f in self.check.failed:
            print("  FAILED: %s" % f)
        if extra:
            print("mainnet phase: %r" % (extra,))
        return 1 if self.check.failed else 0


# ---------------------------------------------------------------------------
# the crash driver -- runs as its own process so it can be SIGKILLed for real
# ---------------------------------------------------------------------------

def crash_driver(args):
    conn = db.connect(args.db)
    db.init_schema(conn)
    rpc = RpcClient(args.rpc_url, cookie_path=args.cookie)
    idx = Indexer(conn, rpc, chain="regtest")
    real_unwind = idx.unwind_block
    real_apply = idx.apply_block
    state = {"unwinds": 0, "applies": 0, "applies_after_unwind": 0}

    def die(why):
        sys.stderr.write("CRASHPOINT %s\n" % why)
        sys.stderr.flush()
        os.kill(os.getpid(), signal.SIGKILL)

    def unwind(height):
        real_unwind(height)
        state["unwinds"] += 1
        if args.kill_mode == "after-unwinds" and state["unwinds"] >= args.kill_n:
            die("after %d unwinds, tip now %d" % (state["unwinds"], idx.tip_height()))

    def apply(blk):
        if args.kill_mode == "after-applies" and state["applies"] >= args.kill_n:
            die("after %d applied blocks (unwinds=%d), tip %d"
                % (state["applies"], state["unwinds"], idx.tip_height()))
        if state["unwinds"] > 0:
            if (args.kill_mode == "between"
                    and state["applies_after_unwind"] == 0):
                die("between unwind and re-apply, tip %d, about to apply %d"
                    % (idx.tip_height(), blk["height"]))
            if (args.kill_mode == "mid-reapply"
                    and state["applies_after_unwind"] >= args.kill_n):
                die("mid re-apply after %d applied blocks, tip %d"
                    % (state["applies_after_unwind"], idx.tip_height()))
        real_apply(blk)
        state["applies"] += 1
        if state["unwinds"] > 0:
            state["applies_after_unwind"] += 1

    idx.unwind_block = unwind
    idx.apply_block = apply
    idx.sync()
    conn.close()
    sys.stderr.write("crash driver finished WITHOUT reaching its kill point "
                     "(mode=%s n=%d unwinds=%d)\n"
                     % (args.kill_mode, args.kill_n, state["unwinds"]))
    return 9


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd")
    cd = sub.add_parser("crashdriver")
    cd.add_argument("--db", required=True)
    cd.add_argument("--rpc-url", required=True)
    cd.add_argument("--cookie", required=True)
    cd.add_argument("--kill-mode", required=True,
                    choices=["between", "mid-reapply", "after-unwinds",
                             "after-applies"])
    cd.add_argument("--kill-n", type=int, default=0)

    ap.add_argument("--bin", default="/root/pcoin-build/build/bin")
    ap.add_argument("--workdir", default="/root/pcoin-torture")
    ap.add_argument("--rpc-port", type=int, default=41443)
    ap.add_argument("--p2p-port-a", type=int, default=41444)
    ap.add_argument("--p2p-port-b", type=int, default=42444)
    ap.add_argument("--mainnet-datadir")
    ap.add_argument("--mainnet-sample", type=int, default=40)
    ap.add_argument("--no-second-node", action="store_true")
    ap.add_argument("--chaos-seconds", type=int, default=30)
    args = ap.parse_args()
    if args.cmd == "crashdriver":
        return crash_driver(args)
    return Torture(args).run()


if __name__ == "__main__":
    sys.exit(main())
