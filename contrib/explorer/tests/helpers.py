"""Shared test scaffolding."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pcoin_indexer import db, indexer  # noqa: E402

# Tables whose contents must be identical after apply-then-unwind. reorg_log and
# orphaned_blocks are deliberately excluded: they are the audit trail of the
# reorg and are *supposed* to grow.
SNAPSHOT_TABLES = {
    "blocks": "height",
    "txs": "txid",
    "outputs": "txid, n",
    "inputs": "txid, n",
    "address_txs": "address, txid",
    "addresses": "address",
}


def make_indexer(chain_or_rpc, path=":memory:"):
    conn = db.connect(path)
    db.init_schema(conn)
    return conn, indexer.Indexer(conn, chain_or_rpc)


def snapshot(conn):
    out = {}
    for table, order in SNAPSHOT_TABLES.items():
        rows = conn.execute("SELECT * FROM %s ORDER BY %s" % (table, order)).fetchall()
        out[table] = [tuple(r) for r in rows]
    st = conn.execute("SELECT indexed_height, indexed_hash FROM sync_state"
                      " WHERE id=1").fetchone()
    out["_tip"] = tuple(st)
    return out


def diff_snapshots(a, b):
    lines = []
    for key in sorted(set(a) | set(b)):
        if a.get(key) != b.get(key):
            ra, rb = a.get(key), b.get(key)
            lines.append("table %s differs (%s rows vs %s rows)"
                         % (key, len(ra or []), len(rb or [])))
            sa, sb = set(map(repr, ra or [])), set(map(repr, rb or []))
            for extra in sorted(sa - sb)[:3]:
                lines.append("   only in A: %s" % extra[:200])
            for extra in sorted(sb - sa)[:3]:
                lines.append("   only in B: %s" % extra[:200])
    return "\n".join(lines)
