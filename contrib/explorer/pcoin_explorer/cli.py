"""Command line entry point: ``python3 -m pcoin_explorer [options] <command>``.

Two commands:

* ``serve``  -- run the web UI and the JSON API.
* ``render`` -- print one page to stdout without opening a socket, which is how
  the tests and a quick "does this page still build" check work.
"""

import argparse
import os
import sys

from . import server


def build_parser():
    p = argparse.ArgumentParser(
        prog="pcoin-explorer",
        description="PCoin block explorer: server-rendered web UI and a "
                    "read-only JSON API over the pcoin_indexer index.")
    p.add_argument("--db", default=os.environ.get("PCOIN_INDEX_DB",
                                                  "pcoin-index.sqlite"),
                   help="index database path (default: pcoin-index.sqlite)")
    p.add_argument("--chain", default=os.environ.get("PCOIN_CHAIN"),
                   choices=["main", "test", "testnet4", "signet", "regtest"],
                   help="override the chain recorded in the index; only affects "
                        "address decoding and the LWMA activation height")
    sub = p.add_subparsers(dest="command", required=True)

    s = sub.add_parser("serve", help="run the HTTP server")
    s.add_argument("--host", default=os.environ.get("PCOIN_EXPLORER_HOST",
                                                    "127.0.0.1"),
                   help="bind address (default 127.0.0.1 -- put a reverse proxy "
                        "in front of it for anything public)")
    s.add_argument("--port", type=int,
                   default=int(os.environ.get("PCOIN_EXPLORER_PORT", "8080")))
    s.add_argument("--quiet", action="store_true", help="no access log")
    s.add_argument("--with-api", action="store_true",
                   help="mount the full pcoin_api application at /api in this "
                        "same process, so one port serves the pages and the "
                        "complete API (mempool, multi-address scan, signed "
                        "transaction relay). Pass that application's own flags "
                        "after a bare --, e.g.\n"
                        "  serve --with-api -- --datadir ~/.pcoin --no-broadcast")
    s.add_argument("api_args", nargs="*",
                   help="arguments forwarded to pcoin_api (after --)")

    s = sub.add_parser("render", help="render one path to stdout and exit")
    s.add_argument("path", help="e.g. / or /block/2000 or /api/chain")
    return p


def build_api_app(args, log):
    """Construct the mounted API application, or fail with a clear reason.

    Deliberately built through pcoin_api's own parser and factory rather than by
    reaching into its internals: that package owns its defaults, its rate limits
    and its broadcast policy, and duplicating any of them here would create a
    second copy to drift.
    """
    try:
        from pcoin_api import cli as apicli
    except ImportError as exc:
        raise SystemExit(
            "--with-api needs the pcoin_api package next to this one (%s)" % exc)
    argv = list(args.api_args or [])
    if "--db" not in argv:
        argv = ["--db", args.db] + argv
    if args.chain and "--chain" not in argv:
        argv = ["--chain", args.chain] + argv
    api_args = apicli.build_parser().parse_args(argv)
    _store, app = apicli.build_app(api_args, log)
    return app


def main(argv=None):
    args = build_parser().parse_args(argv)

    if args.command == "serve":
        if not os.path.exists(args.db):
            sys.stderr.write(
                "no index at %s.\n"
                "Build one first:  python3 -m pcoin_indexer --datadir <node datadir>"
                " --db %s sync\n" % (args.db, args.db))
            return 2
        log = (lambda m: sys.stderr.write(m + "\n"))
        api_app = build_api_app(args, log) if args.with_api else None
        return server.serve(args.db, host=args.host, port=args.port,
                            chain=args.chain, access_log=not args.quiet,
                            api_app=api_app, log=log)

    if args.command == "render":
        store, router, _handler = server.build(args.db, chain=args.chain,
                                               access_log=False)
        path, _, query = args.path.partition("?")
        status, ctype, payload, extra = router.handle(path, query)
        sys.stderr.write("%s %s %s\n" % (status, ctype,
                                         dict(extra).get("Location", "")))
        sys.stdout.write(payload.decode("utf-8", "replace"))
        store.close()
        return 0 if status < 400 else 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
