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

import contextlib
import os
import sqlite3
import threading

from pcoin_indexer import db


class IndexUnavailable(RuntimeError):
    """The index database could not be opened or is not an index."""


class Store:
    """A bounded pool of read-only connections to the index.

    A BOUNDED POOL, NOT ONE CONNECTION PER THREAD. Until 2026-09-19 this kept
    its connection in a threading.local(). The HTTP server runs one daemon
    thread per HTTP connection, so "per thread" meant "per concurrent request",
    unbounded up to the server's connection ceiling, each with its own SQLite
    handle and page cache -- and nothing ever closed them, because a daemon
    thread's locals are released only when the interpreter finalises it.
    Measured on explorer3.pc.am on 2026-09-18: ~70 open handles behind 5-12 live
    threads, and 23 OOM kills in one day while systemd reported the unit active.
    explorer.pc.am carried the same shape at 282 handles.

    pcoin_explorer.server.Store was given this pool weeks earlier; this module
    was not, and /api/* is what the payment rails call, so the half under the
    most load kept the unfixed half of the bug. The two pools are now the same
    shape on purpose: a request borrows a handle and gives it back, and a
    request that arrives when all are busy waits a few milliseconds for one
    rather than opening another. Database work is bounded by the pool, not by
    how many people happen to be hitting the API.

    Read-only is preserved exactly as before: every handle is opened mode=ro
    and checked to be an index before it is lent to anybody.
    """

    def __init__(self, path, pool_size=None):
        self.path = path
        size = pool_size or int(os.environ.get("API_DB_POOL", "16"))
        self._pool = []
        self._lock = threading.Lock()
        self._sem = threading.BoundedSemaphore(size)

    def _open(self):
        try:
            conn = db.connect(self.path, readonly=True)
            db.check_schema_version(conn)
        except (sqlite3.Error, db.IndexCorruption) as exc:
            raise IndexUnavailable("cannot open index %s: %s"
                                   % (self.path, exc)) from exc
        return conn

    def acquire(self):
        """Borrow a connection, opening one only if the pool has never filled."""
        self._sem.acquire()
        try:
            with self._lock:
                conn = self._pool.pop() if self._pool else None
            if conn is None:
                conn = self._open()
            return conn
        except BaseException:
            # Nothing was borrowed, so the slot must go back or the pool leaks
            # one permit per failure until it deadlocks.
            self._sem.release()
            raise

    def release(self, conn, *, discard=False):
        """Return a connection. discard=True for one that errored -- a handle
        whose transaction state is unknown must not be handed to anybody else."""
        try:
            if discard:
                try:
                    conn.close()
                except Exception:
                    pass
            else:
                with self._lock:
                    self._pool.append(conn)
        finally:
            self._sem.release()

    @contextlib.contextmanager
    def borrowed(self):
        conn = self.acquire()
        bad = False
        try:
            yield conn
        except BaseException:
            bad = True
            raise
        finally:
            self.release(conn, discard=bad)

    @contextlib.contextmanager
    def snapshot(self):
        """`with store.snapshot() as conn:` -- one consistent view per request.

        BEGIN pins a WAL snapshot so one response cannot mix a balance read at
        tip T with a maturity cut-off read at tip T+1. COMMIT on the way out has
        nothing to commit; it releases the snapshot so the next borrower sees
        newly indexed blocks. Only a handle whose transaction could not be ended
        is discarded -- a handler raising an ordinary Python error leaves the
        connection perfectly reusable, and discarding it would cost a reopen
        for every 500.
        """
        conn = self.acquire()
        bad = False
        try:
            conn.execute("BEGIN")
            yield conn
        finally:
            try:
                conn.execute("COMMIT")
            except sqlite3.Error:
                try:
                    conn.execute("ROLLBACK")
                except sqlite3.Error:
                    bad = True
            self.release(conn, discard=bad)

    def close_thread(self):
        """Nothing to do: a thread owns no connection here, it borrows one.

        THIS MUST STAY A NO-OP. `close()` below drops every idle connection in
        the pool, and calling that at the end of every request thread would
        empty the pool continuously and force a reopen for the next caller --
        the contention that wedged explorer.pc.am three times on 2026-09-18.
        The per-thread hook and the shutdown hook are different operations.
        """

    def close(self):
        """Drop every idle connection. Used by the tests and at shutdown."""
        with self._lock:
            pool, self._pool = list(self._pool), []
        for conn in pool:
            try:
                conn.close()
            except Exception:
                pass

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
        txids = list(wanted)
        CHUNK = 400
        with self.snapshot() as conn:
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
