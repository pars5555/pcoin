"""SQLite plumbing: connection, pragmas, schema, and the consistency marker.

Why SQLite: the whole index is one file, a reader (the API) and the single
writer can share it under WAL, and there is no server to operate. At ~2000
blocks the database is a few megabytes; it stays the right answer for years.
"""

import os
import sqlite3
import time

SCHEMA_VERSION = 2
_SCHEMA_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "schema.sql")

STATUS_INIT = "init"
STATUS_SYNCING = "syncing"
STATUS_OK = "ok"
STATUS_REORG = "reorg"
STATUS_REINDEX = "reindex"
STATUS_ERROR = "error"


class IndexCorruption(RuntimeError):
    """An invariant the index relies on was found violated. Never swallowed."""


def connect(path, *, readonly=False, bulk=False):
    """Open the index database.

    bulk=True is only for building a throwaway file (reindex-to-temp): it keeps
    the rollback journal in memory and never fsyncs, because losing that file
    entirely is a supported outcome -- we just start the reindex again.

    Note it is journal_mode=MEMORY, not OFF. OFF would make ROLLBACK a no-op,
    and apply/unwind rely on ROLLBACK to undo a *failed* statement sequence,
    which is a correctness property and not just a crash-safety one. MEMORY
    keeps that and still avoids every journal fsync.
    """
    if readonly:
        uri = "file:%s?mode=ro" % _uri_path(path)
        conn = sqlite3.connect(uri, uri=True, timeout=30)
    else:
        conn = sqlite3.connect(path, timeout=30)
    conn.row_factory = sqlite3.Row
    # Manual transaction control: every apply/unwind is one explicit
    # BEGIN IMMEDIATE ... COMMIT. Python's implicit handling would hide that.
    conn.isolation_level = None
    if not readonly:
        if bulk:
            conn.execute("PRAGMA journal_mode=MEMORY")
            conn.execute("PRAGMA synchronous=OFF")
        else:
            conn.execute("PRAGMA journal_mode=WAL")
            # NORMAL is safe here and it is safe *because* of invariant I:
            # a power cut can lose the last committed transactions, which lands
            # the index on an earlier height that is still a valid chain prefix.
            # The sync loop then re-applies those blocks. It cannot lose half a
            # transaction -- SQLite's commit is atomic either way.
            conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA temp_store=MEMORY")
    conn.execute("PRAGMA cache_size=-65536")  # 64 MiB page cache
    return conn


def _uri_path(path):
    return os.path.abspath(path).replace("?", "%3f").replace("#", "%23").replace("\\", "/")


def init_schema(conn, chain=None, genesis_hash=None):
    with open(_SCHEMA_PATH, "r", encoding="utf-8") as fh:
        conn.executescript(fh.read())
    conn.execute("PRAGMA foreign_keys=ON")
    row = conn.execute("SELECT id FROM sync_state WHERE id=1").fetchone()
    if row is None:
        conn.execute(
            "INSERT INTO sync_state (id, schema_version, chain, genesis_hash, "
            "indexed_height, status, indexer_pid, indexer_started_ts) "
            "VALUES (1, ?, ?, ?, -1, ?, ?, ?)",
            (SCHEMA_VERSION, chain, genesis_hash, STATUS_INIT, os.getpid(), int(time.time())))
    else:
        conn.execute("UPDATE sync_state SET indexer_pid=?, indexer_started_ts=? WHERE id=1",
                     (os.getpid(), int(time.time())))
    migrate(conn)
    check_schema_version(conn)


def migrate(conn):
    """Forward-only, additive migrations, run from `init_schema` (writer only).

    The rule: a migration here may only add something that is NULL/absent for
    existing rows. Anything that would change what an existing row *means* is
    not a migration -- it is a reindex, and belongs behind the version check in
    `check_schema_version`, which refuses to open the file at all. `schema.sql`
    is `CREATE TABLE IF NOT EXISTS`, so it never alters an existing table and
    this is the only place a column can appear in one.
    """
    row = conn.execute("SELECT schema_version FROM sync_state WHERE id=1").fetchone()
    if row is None:
        return
    if row["schema_version"] == 1:
        # v2 adds sync_state.node_connections so `health()` can report a node
        # with zero peers as a reason not to trust the tip. The indexed data is
        # untouched, so there is nothing to rebuild.
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(sync_state)")}
        if "node_connections" not in cols:
            conn.execute("ALTER TABLE sync_state ADD COLUMN node_connections INTEGER")
        conn.execute("UPDATE sync_state SET schema_version=2 WHERE id=1")


def check_schema_version(conn):
    row = conn.execute("SELECT schema_version FROM sync_state WHERE id=1").fetchone()
    if row is None:
        raise IndexCorruption("sync_state row is missing; the database is not an index")
    if row["schema_version"] != SCHEMA_VERSION:
        raise IndexCorruption(
            "index schema version %s, this build expects %s -- reindex required"
            % (row["schema_version"], SCHEMA_VERSION))


def get_state(conn):
    row = conn.execute("SELECT * FROM sync_state WHERE id=1").fetchone()
    return dict(row) if row is not None else None


def set_state(conn, **fields):
    if not fields:
        return
    cols = ", ".join("%s=?" % k for k in fields)
    conn.execute("UPDATE sync_state SET %s WHERE id=1" % cols, tuple(fields.values()))


def db_size_bytes(path):
    total = 0
    for suffix in ("", "-wal", "-shm"):
        try:
            total += os.path.getsize(path + suffix)
        except OSError:
            pass
    return total
