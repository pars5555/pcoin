"""Read-only access to the index database.

Two properties this module exists to guarantee.

**Read-only means read-only.** Every connection is opened with the SQLite URI
``mode=ro``, so a bug in a handler cannot write to the index -- it raises
``sqlite3.OperationalError: attempt to write a readonly database`` instead. The
indexer is the single writer; the API is a reader and nothing else. The one
state-changing endpoint in this API (``POST /api/tx``) does not touch this
database at all.

**A request sees one consistent snapshot.** Every handler runs its reads inside
an explicit read transaction. Without that, a single response could compute a
balance against tip *T* and the coinbase-maturity cut-off against tip *T+1* --
and during a reorg it could read `blocks` after an unwind and `outputs` before
one. Under WAL a reader never blocks the indexer and the indexer never blocks a
reader, so this costs nothing but correctness.

Sharing the file with a live indexer: WAL needs a writable ``-shm`` file. Run
the API as a user with write permission on the *directory* holding the index (it
still cannot write the database itself), or point it at a copy.
"""

import sqlite3
import threading

from pcoin_indexer import db


class IndexUnavailable(RuntimeError):
    """The index database could not be opened or is not an index."""


class Store:
    def __init__(self, path):
        self.path = path
        self._local = threading.local()

    def _conn(self):
        conn = getattr(self._local, "conn", None)
        if conn is None:
            try:
                conn = db.connect(self.path, readonly=True)
                db.check_schema_version(conn)
            except (sqlite3.Error, db.IndexCorruption) as exc:
                raise IndexUnavailable("cannot open index %s: %s"
                                       % (self.path, exc)) from exc
            self._local.conn = conn
        return conn

    def close(self):
        conn = getattr(self._local, "conn", None)
        if conn is not None:
            conn.close()
            self._local.conn = None

    class _Snapshot:
        def __init__(self, conn):
            self.conn = conn

        def __enter__(self):
            self.conn.execute("BEGIN")
            return self.conn

        def __exit__(self, exc_type, exc, tb):
            # Read transactions have nothing to commit; ending it releases the
            # WAL snapshot so the next request sees newly indexed blocks.
            try:
                self.conn.execute("COMMIT")
            except sqlite3.Error:                            # pragma: no cover
                self.conn.execute("ROLLBACK")
            return False

    def snapshot(self):
        """`with store.snapshot() as conn:` -- one consistent view per request."""
        return self._Snapshot(self._conn())

    # -- outpoint resolution for the mempool view ------------------------
    def resolve_outpoints(self, outpoints):
        """{(txid, n): (address, value_sat)} for those the index knows about.

        Used to attribute a mempool transaction's *inputs* to addresses. An
        outpoint that is not in the index is simply absent from the result --
        never guessed at, and the caller marks that transaction incomplete.
        """
        if not outpoints:
            return {}
        wanted = {}
        for txid, n in outpoints:
            wanted.setdefault(txid, set()).add(n)
        out = {}
        conn = self._conn()
        txids = list(wanted)
        CHUNK = 400
        with self.snapshot():
            for i in range(0, len(txids), CHUNK):
                chunk = txids[i:i + CHUNK]
                placeholders = ",".join("?" * len(chunk))
                rows = conn.execute(
                    "SELECT txid, n, address, value FROM outputs WHERE txid IN (%s)"
                    % placeholders, chunk)
                for r in rows:
                    if r["n"] in wanted.get(r["txid"], ()):
                        out[(r["txid"], r["n"])] = (r["address"], r["value"])
        return out
