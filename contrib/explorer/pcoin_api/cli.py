"""Command line entry point: `python3 -m pcoin_api serve`."""

import argparse
import json
import os
import sys
import time

from pcoin_indexer import rpc as rpcmod

from . import __version__
from .broadcast import DEFAULT_WAIT_SECONDS, Broadcaster
from .nodeview import DEFAULT_CACHE_SECONDS, NodeView
from .ratelimit import RateLimiter
from .server import ApiApplication, ApiServer
from .service import MAX_ADDRESSES, Service
from .store import IndexUnavailable, Store


def _log(msg):
    sys.stderr.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), msg))
    sys.stderr.flush()


def build_parser():
    p = argparse.ArgumentParser(
        prog="pcoin-api",
        description="PCoin block explorer JSON API (read-only over the index, "
                    "plus signed-transaction relay).")
    p.add_argument("--version", action="version", version=__version__)
    p.add_argument("--db", default=os.environ.get("PCOIN_INDEX_DB",
                                                  "pcoin-index.sqlite"),
                   help="index database built by pcoin_indexer")
    p.add_argument("--rpc-url", default=os.environ.get("PCOIN_RPC_URL"))
    p.add_argument("--datadir", default=os.environ.get("PCOIN_DATADIR"),
                   help="node datadir, used to find the .cookie file")
    p.add_argument("--chain", default=os.environ.get("PCOIN_CHAIN", "main"),
                   choices=["main", "test", "testnet4", "signet", "regtest"])
    p.add_argument("--rpc-user", default=os.environ.get("PCOIN_RPC_USER"))
    p.add_argument("--rpc-password", default=os.environ.get("PCOIN_RPC_PASSWORD"))
    p.add_argument("--rpc-cookie", default=os.environ.get("PCOIN_RPC_COOKIE"))
    p.add_argument("--rpc-timeout", type=float, default=10.0,
                   help="seconds to wait on a node RPC (default 10). A refresh "
                        "is single-flight, so a hung node delays node-dependent "
                        "endpoints by at most this, once.")

    p.add_argument("--host", default="127.0.0.1",
                   help="bind address (default 127.0.0.1 -- put a TLS reverse "
                        "proxy in front rather than binding 0.0.0.0 directly)")
    p.add_argument("--port", type=int, default=8080)
    p.add_argument("--cors-origin", default="*",
                   help="Access-Control-Allow-Origin, or '' to send none")
    p.add_argument("--trust-proxy", action="store_true",
                   help="rate-limit on the last X-Forwarded-For entry. Only set "
                        "this when a proxy you control appends it -- otherwise "
                        "any client spoofs the header and evades the limiter.")

    p.add_argument("--no-broadcast", action="store_true",
                   help="serve reads only; POST /api/tx answers 503")
    p.add_argument("--allow-wallet-node", action="store_true",
                   help="relay through a node that has wallet RPCs enabled. Not "
                        "recommended: this API must never be able to spend.")
    p.add_argument("--witness-rpc-url",
                   help="a SECOND, independent node. After a broadcast the API "
                        "asks it whether it has the transaction, which is the "
                        "only true 'the network has it' signal.")
    p.add_argument("--witness-rpc-user")
    p.add_argument("--witness-rpc-password")
    p.add_argument("--witness-rpc-cookie")
    p.add_argument("--broadcast-wait", type=float, default=DEFAULT_WAIT_SECONDS,
                   help="seconds to wait for a propagation signal (default %.0f)"
                        % DEFAULT_WAIT_SECONDS)

    p.add_argument("--read-rate", type=float, default=20.0,
                   help="read requests per second per client (default 20)")
    p.add_argument("--read-burst", type=float, default=60.0)
    p.add_argument("--broadcast-rate", type=float, default=0.1,
                   help="broadcasts per second per client (default 0.1 = one "
                        "every 10s)")
    p.add_argument("--broadcast-burst", type=float, default=3.0)
    p.add_argument("--broadcast-global-rate", type=float, default=1.0,
                   help="broadcasts per second across all clients (default 1)")
    p.add_argument("--broadcast-global-burst", type=float, default=10.0)

    p.add_argument("--max-addresses", type=int, default=MAX_ADDRESSES,
                   help="addresses per multi-address request (default %d)"
                        % MAX_ADDRESSES)
    p.add_argument("--cache-seconds", type=float, default=DEFAULT_CACHE_SECONDS,
                   help="how long a node/mempool observation is reused")
    p.add_argument("--quiet", action="store_true")

    sub = p.add_subparsers(dest="command")
    sub.add_parser("serve", help="run the HTTP server (default)")
    sub.add_parser("check", help="print the startup gate and exit")
    return p


def build_app(args, log):
    store = Store(args.db)
    node_rpc = rpcmod.client_from_args(
        url=args.rpc_url, datadir=args.datadir, chain=args.chain,
        user=args.rpc_user, password=args.rpc_password, cookie=args.rpc_cookie,
        timeout=args.rpc_timeout)
    witness_rpc = None
    if args.witness_rpc_url:
        witness_rpc = rpcmod.RpcClient(
            args.witness_rpc_url, user=args.witness_rpc_user,
            password=args.witness_rpc_password,
            cookie_path=args.witness_rpc_cookie, timeout=args.rpc_timeout)

    node = NodeView(node_rpc, resolver=store.resolve_outpoints,
                    cache_seconds=args.cache_seconds, log=log)
    service = Service(store, node, max_addresses=args.max_addresses)
    broadcaster = Broadcaster(
        node_rpc, node, store, enabled=not args.no_broadcast,
        allow_wallet_node=args.allow_wallet_node, witness_rpc=witness_rpc,
        wait_seconds=args.broadcast_wait, log=log)
    app = ApiApplication(
        service, broadcaster,
        read_limiter=RateLimiter(args.read_rate, args.read_burst),
        broadcast_limiter=RateLimiter(
            args.broadcast_rate, args.broadcast_burst,
            global_rate=args.broadcast_global_rate,
            global_burst=args.broadcast_global_burst),
        cors_origin=args.cors_origin or None, trust_proxy=args.trust_proxy,
        log=log)
    return store, app


def main(argv=None):
    args = build_parser().parse_args(argv)
    log = (lambda m: None) if args.quiet else _log

    if not os.path.exists(args.db):
        sys.stderr.write(
            "no index at %s.\n"
            "Build one first:  python3 -m pcoin_indexer --datadir <node datadir> "
            "--chain %s sync\n" % (args.db, args.chain))
        return 2

    try:
        store, app = build_app(args, log)
    except IndexUnavailable as exc:
        sys.stderr.write("%s\n" % exc)
        return 2

    gate = app.broadcaster.state()
    if args.command == "check":
        json.dump({"index": app.service.status()["index"], "broadcast": gate},
                  sys.stdout, indent=2, default=str)
        sys.stdout.write("\n")
        return 0 if gate["enabled"] or args.no_broadcast else 1

    log("PCoin explorer API %s" % __version__)
    log("index      %s" % os.path.abspath(args.db))
    log("node       %s" % app.broadcaster.rpc.url)
    if gate["enabled"]:
        log("broadcast  ENABLED (%s)"
            % ("witness node configured" if gate["checks"].get("witness_node")
               else "no witness node: propagation reported from the local "
                    "unbroadcast flag only"))
    else:
        for reason in gate["reasons"]:
            log("broadcast  DISABLED: %s" % reason)
    log("Reminder: do not run this on the seed host. seed.pc.am is the only DNS "
        "seed and vFixedSeeds is empty.")

    server = ApiServer((args.host, args.port), app)
    log("listening on http://%s:%d/" % (args.host, args.port))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("stopping")
    finally:
        server.server_close()
        store.close()
    return 0
