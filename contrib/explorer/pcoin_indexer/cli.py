"""Command line entry point: python -m pcoin_indexer <command>"""

import argparse
import json
import os
import sqlite3
import sys
import time
from decimal import Decimal

from . import db, queries, rpc as rpcmod
from .amounts import from_sat
from .db import IndexCorruption
from .indexer import DEFAULT_BATCH, Indexer, WrongChain, reindex, supply_sat, verify
from .rpc import RpcError, RpcTransportError

# Exit codes. A supervisor (`Restart=on-failure` in systemd -- see README.md,
# "Running it as a service") restarts on any of these; they exist so the reason
# is in `systemctl status` rather than only in a Python traceback.
EXIT_NODE_UNREACHABLE = 3
EXIT_WRONG_CHAIN = 4
EXIT_STORAGE = 5
EXIT_CORRUPTION = 6


def _log(msg):
    sys.stderr.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), msg))
    sys.stderr.flush()


def _json(obj):
    def default(o):
        if isinstance(o, Decimal):
            return str(o)
        raise TypeError(repr(o))
    print(json.dumps(obj, indent=2, default=default, sort_keys=False))


def build_parser():
    p = argparse.ArgumentParser(
        prog="pcoin-index",
        description="PCoin explorer address indexer (RPC -> SQLite).")
    p.add_argument("--db", default=os.environ.get("PCOIN_INDEX_DB", "pcoin-index.sqlite"),
                   help="index database path (default: pcoin-index.sqlite)")
    p.add_argument("--rpc-url", default=os.environ.get("PCOIN_RPC_URL"),
                   help="node RPC url (default http://127.0.0.1:9443/)")
    p.add_argument("--datadir", default=os.environ.get("PCOIN_DATADIR"),
                   help="node datadir, used to find the .cookie file")
    p.add_argument("--chain", default=os.environ.get("PCOIN_CHAIN", "main"),
                   choices=["main", "test", "testnet4", "signet", "regtest"])
    p.add_argument("--rpc-user", default=os.environ.get("PCOIN_RPC_USER"))
    p.add_argument("--rpc-password", default=os.environ.get("PCOIN_RPC_PASSWORD"))
    p.add_argument("--rpc-cookie", default=os.environ.get("PCOIN_RPC_COOKIE"))
    p.add_argument("--batch", type=int, default=DEFAULT_BATCH,
                   help="blocks per RPC batch (default %d)" % DEFAULT_BATCH)
    p.add_argument("--quiet", action="store_true")

    sub = p.add_subparsers(dest="command", required=True)

    s = sub.add_parser("sync", help="bring the index up to the node tip")
    s.add_argument("--daemon", action="store_true", help="keep polling")
    s.add_argument("--interval", type=float, default=30.0,
                   help="seconds between polls in --daemon mode")

    s = sub.add_parser("reindex", help="rebuild from genesis")
    s.add_argument("--in-place", action="store_true",
                   help="rebuild into the live file instead of a temp file "
                        "(faster to set up, but the file is unusable meanwhile)")

    s = sub.add_parser("verify", help="recompute everything derivable and diff it")
    s.add_argument("--shallow", action="store_true")

    sub.add_parser("status", help="print the consistency marker")
    sub.add_parser("stats", help="chain-level summary from the index")

    s = sub.add_parser("address", help="balance, history and utxos for an address")
    s.add_argument("address")
    s.add_argument("--utxos", action="store_true")
    s.add_argument("--history", type=int, default=10)

    s = sub.add_parser("tx", help="every detail of one transaction")
    s.add_argument("txid")

    s = sub.add_parser("block", help="one block by height or hash")
    s.add_argument("ident")

    s = sub.add_parser("search", help="address / txid / block hash / height")
    s.add_argument("term")

    return p


def make_rpc(args):
    return rpcmod.client_from_args(
        url=args.rpc_url, datadir=args.datadir, chain=args.chain,
        user=args.rpc_user, password=args.rpc_password, cookie=args.rpc_cookie)


def _progress_factory(quiet):
    state = {"last": 0.0}

    def progress(height, target):
        if quiet:
            return
        now = time.monotonic()
        if now - state["last"] < 0.5 and height != target:
            return
        state["last"] = now
        sys.stderr.write("\r  indexed %d / %d" % (height, target))
        sys.stderr.flush()
    return progress


def main(argv=None):
    args = build_parser().parse_args(argv)
    log = (lambda m: None) if args.quiet else _log

    if args.command == "reindex":
        client = make_rpc(args)
        started = time.monotonic()
        stats = reindex(args.db, client, batch=args.batch, log=log,
                        progress=_progress_factory(args.quiet),
                        in_place=args.in_place)
        if not args.quiet:
            sys.stderr.write("\n")
        elapsed = time.monotonic() - started
        conn = db.connect(args.db, readonly=True)
        rows = {t: conn.execute("SELECT COUNT(*) c FROM %s" % t).fetchone()["c"]
                for t in ("blocks", "txs", "inputs", "outputs", "address_txs",
                          "addresses")}
        sat, n = supply_sat(conn)
        conn.close()
        _json({"reindex": stats, "seconds": round(elapsed, 2),
               "db_bytes": db.db_size_bytes(args.db), "rows": rows,
               "utxo_count": n, "supply": from_sat(sat),
               "rpc_calls": client.call_count,
               "rpc_seconds": round(client.rpc_seconds, 2),
               "rpc_bytes": client.bytes_in})
        return 0

    read_only = args.command in ("status", "stats", "address", "tx", "block",
                                 "search", "verify")
    if read_only and not os.path.exists(args.db):
        sys.stderr.write("no index at %s -- run `reindex` or `sync` first\n" % args.db)
        return 2

    if args.command in ("sync",):
        conn = db.connect(args.db)
        client = make_rpc(args)
        try:
            db.init_schema(conn)
            idx = Indexer(conn, client, chain=args.chain, log=log)
            while True:
                try:
                    stats = idx.sync(batch=args.batch,
                                     progress=_progress_factory(args.quiet))
                    if not args.quiet:
                        sys.stderr.write("\r")
                    log("tip %s/%s applied=%d unwound=%d reorgs=%d"
                        % (stats.get("indexed_height"), stats.get("node_height"),
                           stats["applied"], stats["unwound"], stats["reorgs"]))
                except (RpcTransportError, RpcError) as exc:
                    log("node unreachable (%s) -- index left untouched" % exc)
                    if not args.daemon:
                        return EXIT_NODE_UNREACHABLE
                except WrongChain as exc:
                    sys.stderr.write("REFUSING TO INDEX: %s\n" % exc)
                    return EXIT_WRONG_CHAIN
                except sqlite3.OperationalError as exc:
                    # A full disk, a locked database, a read-only filesystem.
                    # Every apply and every unwind is one BEGIN IMMEDIATE, so
                    # the index is left at a valid chain prefix and `health()`
                    # turns stale within 300 s -- but this process cannot make
                    # progress, and looping on it would spin. Exit non-zero even
                    # under --daemon and let the supervisor back off and retry.
                    sys.stderr.write(
                        "INDEX WRITE FAILED: %s\n"
                        "The index is intact at a valid chain prefix and will "
                        "resume where it stopped. Check free space on the "
                        "volume holding %s (the database, its -wal and its -shm)."
                        "\n" % (exc, os.path.abspath(args.db)))
                    return EXIT_STORAGE
                except IndexCorruption as exc:
                    sys.stderr.write(
                        "INDEX CORRUPTION: %s\n"
                        "Refusing to continue. Rebuild with `reindex`; the "
                        "chain is small enough that this is under a minute.\n"
                        % exc)
                    return EXIT_CORRUPTION
                if not args.daemon:
                    break
                time.sleep(args.interval)
        finally:
            conn.close()
        return 0

    conn = db.connect(args.db, readonly=True)
    try:
        if args.command == "verify":
            problems = verify(conn, deep=not args.shallow)
            _json({"ok": not problems, "problems": problems,
                   "health": queries.health(conn)})
            return 0 if not problems else 1
        if args.command == "status":
            _json(queries.health(conn))
            return 0
        if args.command == "stats":
            st = queries.chain_stats(conn)
            st["supply"] = from_sat(st["supply_sat"])
            _json(st)
            return 0
        if args.command == "address":
            out = queries.address_summary(conn, args.address)
            for k in ("balance", "spendable", "immature", "received", "sent"):
                out[k + "_pcn"] = from_sat(out[k])
            if args.history:
                out["history"] = queries.address_history(conn, args.address,
                                                         limit=args.history)
            if args.utxos:
                out["utxos"] = queries.address_utxos(conn, args.address)
            _json(out)
            return 0
        if args.command == "tx":
            out = queries.transaction(conn, args.txid)
            if out is None:
                sys.stderr.write("no such transaction in the index\n")
                return 2
            _json(out)
            return 0
        if args.command == "block":
            out = queries.block(conn, args.ident)
            if out is None:
                sys.stderr.write("no such block in the index\n")
                return 2
            _json(out)
            return 0
        if args.command == "search":
            out = queries.search(conn, args.term)
            if out is None:
                sys.stderr.write("nothing found\n")
                return 2
            _json(out)
            return 0
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
