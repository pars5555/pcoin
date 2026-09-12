#!/usr/bin/env node
// Explicit, versioned migration runner.
//
// NOT `CREATE TABLE IF NOT EXISTS`. On an existing install that keeps the OLD
// index, so a code change that depends on a new unique key silently never
// reaches the database and the bug it was meant to fix is still live.
//
// Verification is by PRAGMA index_list / index_info -- what the database HAS --
// not by reading the schema file, which only says what we meant.
//
// Usage:
//   node migrate.mjs                 # apply pending, then verify
//   node migrate.mjs --verify-only   # verify an existing database, change nothing
//   node migrate.mjs --db <path>     # override DB_PATH

import { loadConfig } from './lib/config.mjs';
import {
  openDb, pendingMigrations, applyMigration, appliedVersions,
  assertSchema, uniqueIndexColumns, tableColumns,
} from './lib/db.mjs';

const args = process.argv.slice(2);
const verifyOnly = args.includes('--verify-only');
const dbFlag = args.indexOf('--db');
const dbOverride = dbFlag >= 0 ? args[dbFlag + 1] : null;

function dbPath() {
  if (dbOverride) return dbOverride;
  const cfg = loadConfig();
  return cfg.str('DB_PATH');
}

const path = dbPath();
const db = openDb(path);

if (!verifyOnly) {
  const pending = pendingMigrations(db);
  if (pending.length === 0) {
    console.log(`no pending migrations (applied: ${[...appliedVersions(db)].sort((a, b) => a - b).join(', ') || 'none'})`);
  }
  for (const m of pending) {
    process.stdout.write(`applying ${m.name} ... `);
    applyMigration(db, m);
    console.log('ok');
  }
}

// ---- the structural proof ------------------------------------------------
console.log(`\ndatabase: ${path}`);
console.log(`applied versions: ${[...appliedVersions(db)].sort((a, b) => a - b).join(', ') || 'none'}`);

console.log('\nPRAGMA index_list / index_info -- unique indexes that matter:');
for (const t of ['pcn_deposits', 'ledger', 'wpcn_claims', 'pcn_addresses', 'reservations']) {
  for (const u of uniqueIndexColumns(db, t)) {
    console.log(`  ${t.padEnd(15)} UNIQUE (${u.columns.join(', ')})  [${u.name}, origin=${u.origin}]`);
  }
}

const depCols = tableColumns(db, 'pcn_deposits');
console.log(`\npcn_deposits has a vout column: ${depCols.includes('vout') ? 'YES -- WRONG' : 'no (correct: the key is (txid, address))'}`);

try {
  assertSchema(db);
  console.log('\nschema assertions: PASS');
} catch (e) {
  console.error(`\nschema assertions: FAIL\n${e.message}`);
  process.exit(1);
}

db.close();
