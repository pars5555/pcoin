// Database access.
//
// SQLite, not MySQL, and that was not a preference: the target host has no
// mysql client and no server, MariaDB must not be installed on it (its
// must-not-disturb list is long), and /usr/bin/sqlite3 is present.
//
// The consequence that matters is in the transaction helper below. SQLite has
// no SELECT ... FOR UPDATE. The equivalent is BEGIN IMMEDIATE, which takes the
// write lock UP FRONT rather than on first write -- a plain BEGIN would let two
// ticks both read, both decide to credit, and one of them fail at COMMIT with
// SQLITE_BUSY after it had already decided.

import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', 'migrations');

export function openDb(path, { readonly = false } = {}) {
  const db = new Database(path, { readonly });
  // WAL so the watcher writing does not block the bot reading.
  db.pragma('journal_mode = WAL');
  // Both processes contend for one write lock. Without a busy timeout the
  // loser throws SQLITE_BUSY immediately instead of waiting 5s for a
  // transaction that takes milliseconds.
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  return db;
}

// Run fn inside a write transaction that holds the lock from the first
// statement. Returns fn's value; rolls back and rethrows on any throw.
//
// better-sqlite3's own .transaction() uses a deferred BEGIN, so it is NOT a
// substitute for this where two processes can race.
export function immediate(db, fn) {
  db.prepare('BEGIN IMMEDIATE').run();
  try {
    const out = fn();
    db.prepare('COMMIT').run();
    return out;
  } catch (e) {
    try { db.prepare('ROLLBACK').run(); } catch { /* already rolled back */ }
    throw e;
  }
}

export function nowSec() {
  return Math.floor(Date.now() / 1000);
}

// ---- migrations ----------------------------------------------------------
//
// Explicit and versioned. CREATE TABLE IF NOT EXISTS is a trap on an existing
// install: it keeps the OLD index, so a code change that depends on a new
// unique key silently never reaches the database.

function ensureMigrationTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
             version    INTEGER PRIMARY KEY,
             name       TEXT NOT NULL,
             applied_at INTEGER NOT NULL
           )`);
}

export function appliedVersions(db) {
  ensureMigrationTable(db);
  return new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));
}

export function pendingMigrations(db) {
  const done = appliedVersions(db);
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort()
    .map((f) => ({ version: Number(f.split('_')[0]), name: f, path: join(MIGRATIONS_DIR, f) }))
    .filter((m) => !done.has(m.version));
}

export function applyMigration(db, m) {
  const sql = readFileSync(m.path, 'utf8');
  // DDL plus its bookkeeping in one transaction: a half-applied migration is
  // the state nothing knows how to recover from.
  immediate(db, () => {
    db.exec(sql);
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?,?,?)')
      .run(m.version, m.name, nowSec());
  });
}

// ---- index verification --------------------------------------------------
//
// Verify with PRAGMA index_list / index_info, NOT by reading the schema file.
// The file says what we meant; the pragmas say what the database has, and on an
// upgraded install those differ. This is what proves UNIQUE(txid,address) is
// really there.

export function uniqueIndexColumns(db, table) {
  const out = [];
  for (const idx of db.pragma(`index_list(${table})`)) {
    if (!idx.unique) continue;
    const cols = db.pragma(`index_info(${idx.name})`).map((c) => c.name);
    out.push({ name: idx.name, origin: idx.origin, columns: cols });
  }
  return out;
}

export function tableColumns(db, table) {
  return db.pragma(`table_info(${table})`).map((c) => c.name);
}

// The three structural facts the money path depends on. Called at startup by
// both processes; throws rather than warning, because a check that only prints
// is not a check.
export function assertSchema(db) {
  const problems = [];

  const depCols = tableColumns(db, 'pcn_deposits');
  if (depCols.includes('vout')) {
    problems.push('pcn_deposits has a vout column: the ledger key must be (txid,address)');
  }

  const depUniq = uniqueIndexColumns(db, 'pcn_deposits');
  const hasTxidAddr = depUniq.some((u) => u.columns.length === 2 &&
    u.columns.includes('txid') && u.columns.includes('address'));
  if (!hasTxidAddr) {
    problems.push('pcn_deposits is missing UNIQUE (txid, address)');
  }
  // A unique index on txid ALONE is the bug rule 1 describes, wearing a
  // different name. Refuse it explicitly.
  if (depUniq.some((u) => u.columns.length === 1 && u.columns[0] === 'txid')) {
    problems.push('pcn_deposits has UNIQUE(txid) alone: a second deposit to a different address would be dropped');
  }

  const ledUniq = uniqueIndexColumns(db, 'ledger');
  if (!ledUniq.some((u) => u.columns.length === 1 && u.columns[0] === 'idem_key')) {
    problems.push('ledger is missing UNIQUE (idem_key): the double-credit guard is the unique violation');
  }

  const wpcnUniq = uniqueIndexColumns(db, 'wpcn_claims');
  const hasHashLog = wpcnUniq.some((u) => u.columns.length === 2 &&
    u.columns.includes('txhash') && u.columns.includes('log_index'));
  if (!hasHashLog) {
    problems.push('wpcn_claims is missing UNIQUE (txhash, log_index)');
  }

  if (problems.length) {
    throw new Error(`schema assertions failed:\n  - ${problems.join('\n  - ')}`);
  }
}

// ---- kv ------------------------------------------------------------------

export function kvGet(db, key) {
  const row = db.prepare('SELECT v FROM kv WHERE k = ?').get(key);
  return row ? row.v : null;
}

export function kvSet(db, key, value) {
  db.prepare(`INSERT INTO kv (k, v, updated_at) VALUES (?,?,?)
              ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`)
    .run(key, String(value), nowSec());
}

export function kvGetJson(db, key) {
  const raw = kvGet(db, key);
  if (raw === null) return null;
  // Bytes that will not decode are UNKNOWN, not an empty value. Let it throw:
  // a failed read of our own state is not an empty state.
  return JSON.parse(raw);
}

export function kvSetJson(db, key, value) {
  kvSet(db, key, JSON.stringify(value));
}
