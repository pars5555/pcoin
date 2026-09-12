// The money path, tested against a real SQLite database.
//
// Every case here corresponds to a rule that has already been shipped WRONG by
// a real integration in this estate. They are regression tests for other
// people's incidents, not hypotheticals.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, pendingMigrations, applyMigration, assertSchema, nowSec } from '../lib/db.mjs';
import { importPool, allocateAddress, issuedAddresses, poolStats, PoolEmpty } from '../lib/pool.mjs';
import { creditDeposit, creditDepositSafe, reconcile, CreditResult } from '../lib/deposits.mjs';
import { rateToE12 } from '../lib/money.mjs';

// Two real PCoin addresses (valid bech32) used as pool entries.
const A1 = 'pc1qnfk7xenwzxx7h4mx88g004crlx0m2zcjg3nq4j';
const A2 = 'pc1qsl67w7cs8gsvd9jekdrnjxj873du7x5n6nj82l';
const A3 = 'pc1q59d4tnhq6k3qqa9u5gvtuj05zswnjz3a900uxa';

const RATE = {
  usable: true,
  rateE12: rateToE12('0.03590242147375549'),
  rateText: '0.03590242147375549',
  source: 'oracle',
  readAt: 1789000000,
};

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'pcnaibot-test-'));
  const db = openDb(join(dir, 'test.db'));
  for (const m of pendingMigrations(db)) applyMigration(db, m);
  assertSchema(db);
  return db;
}

function seedPool(db, entries) {
  const text = entries.map(([i, a]) => `${i} ${a}`).join('\n');
  return importPool(db, text);
}

function addUser(db, chatId) {
  db.prepare('INSERT INTO users (chat_id, model, created_at) VALUES (?,?,?)')
    .run(chatId, 'glm-5.3-flash', nowSec());
}

function insertDeposit(db, { txid, address, chatId, sat, height = 7000 }) {
  return db.prepare(
    `INSERT INTO pcn_deposits (txid, address, chat_id, status, amount_sat, block_height, first_seen_at)
     VALUES (?,?,?,'confirming',?,?,?)`
  ).run(txid, address, chatId, sat, height, nowSec()).lastInsertRowid;
}

function balance(db, chatId) {
  return db.prepare('SELECT balance_micro_usd b FROM users WHERE chat_id=?').get(chatId).b;
}

// ---------------------------------------------------------------------------
// RULE 1. "vout is always 0 for these deposits, so the wrong key silently DROPS
// a second deposit instead of erroring. All four live services shipped this
// wrong first." It fails SAFE -- it never double-credits -- which is exactly
// why nobody sees it.
// ---------------------------------------------------------------------------
test('one transaction paying TWO of our addresses credits BOTH users', () => {
  const db = freshDb();
  seedPool(db, [[1000, A1], [1001, A2]]);
  addUser(db, 111);
  addUser(db, 222);
  const a = allocateAddress(db, 111);
  const b = allocateAddress(db, 222);
  assert.notEqual(a.address, b.address);

  const TXID = 'aa'.repeat(32);
  const d1 = insertDeposit(db, { txid: TXID, address: a.address, chatId: 111, sat: 1000000000n });
  const d2 = insertDeposit(db, { txid: TXID, address: b.address, chatId: 222, sat: 2000000000n });

  const r1 = creditDeposit(db, d1, RATE);
  const r2 = creditDeposit(db, d2, RATE);

  assert.equal(r1.result, CreditResult.CREDITED);
  assert.equal(r2.result, CreditResult.CREDITED);
  assert.ok(balance(db, 111) > 0, 'first user credited');
  assert.ok(balance(db, 222) > 0, 'second user credited');
  // The second is exactly twice the first: same rate, twice the sats.
  assert.equal(balance(db, 222), balance(db, 111) * 2);

  const ledgerRows = db.prepare('SELECT COUNT(*) n FROM ledger').get().n;
  assert.equal(ledgerRows, 2, 'two ledger rows for one txid across two addresses');
  db.close();
});

// ---------------------------------------------------------------------------
// The double-credit guard: the ledger row goes in BEFORE the balance moves.
// ---------------------------------------------------------------------------
test('crediting the same deposit twice moves money exactly once', () => {
  const db = freshDb();
  seedPool(db, [[1000, A1]]);
  addUser(db, 111);
  const a = allocateAddress(db, 111);
  const id = insertDeposit(db, { txid: 'bb'.repeat(32), address: a.address, chatId: 111, sat: 5000000000n });

  const first = creditDeposit(db, id, RATE);
  const after = balance(db, 111);
  const second = creditDeposit(db, id, RATE);

  assert.equal(first.result, CreditResult.CREDITED);
  assert.equal(second.result, CreditResult.ALREADY);
  assert.equal(balance(db, 111), after, 'balance unchanged on replay');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ledger').get().n, 1);
  // The duplicate path returns WHAT WAS APPLIED, not a recomputation.
  assert.equal(second.microUsd, first.microUsd);
  db.close();
});

test('a pre-existing ledger key blocks the credit before any money moves', () => {
  const db = freshDb();
  seedPool(db, [[1000, A1]]);
  addUser(db, 111);
  const a = allocateAddress(db, 111);
  const txid = 'cc'.repeat(32);
  const id = insertDeposit(db, { txid, address: a.address, chatId: 111, sat: 5000000000n });

  // Simulate a previous attempt whose response we lost: the ledger row landed,
  // the process died before the deposit row was updated.
  db.prepare(`INSERT INTO ledger (chat_id, delta_micro_usd, kind, idem_key, created_at)
              VALUES (?,?,?,?,?)`).run(111, 999, 'deposit_pcn', `pcn:${txid}:${a.address}`, nowSec());

  const r = creditDepositSafe(db, id, RATE);
  assert.equal(r.result, CreditResult.DUPLICATE);
  assert.equal(balance(db, 111), 0, 'no money moved on the duplicate path');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ledger').get().n, 1);
  db.close();
});

// ---------------------------------------------------------------------------
// Dust is CREDITED-AND-CARRIED, never `rejected`. `rejected` here would be a
// we-keep-it rule, terminal and unalerted, for money that is already ours.
// ---------------------------------------------------------------------------
test('dust below the minimum is carried, gets a ZERO ledger row, and is finalised', () => {
  const db = freshDb();
  seedPool(db, [[1000, A1]]);
  addUser(db, 111);
  const a = allocateAddress(db, 111);
  const id = insertDeposit(db, { txid: 'dd'.repeat(32), address: a.address, chatId: 111, sat: 50000000n }); // 0.5 PCN

  const r = creditDeposit(db, id, RATE);
  assert.equal(r.result, CreditResult.CREDITED);
  assert.equal(r.dust, true);
  assert.equal(balance(db, 111), 0, 'no USD credited for dust');

  const row = db.prepare('SELECT * FROM pcn_deposits WHERE id=?').get(id);
  assert.equal(row.status, 'credited', 'finalised, NOT rejected');
  assert.equal(row.credited_micro_usd, 0);

  const led = db.prepare('SELECT * FROM ledger').all();
  assert.equal(led.length, 1, 'the zero-USD ledger row IS written');
  assert.equal(led[0].delta_micro_usd, 0);

  const addr = db.prepare('SELECT remainder_nano_usd r FROM pcn_addresses WHERE address=?').get(a.address);
  assert.ok(addr.r > 0, 'the dust value is carried on the address');
  db.close();
});

test('the carry flushes into the next real credit for that address', () => {
  const db = freshDb();
  seedPool(db, [[1000, A1]]);
  addUser(db, 111);
  const a = allocateAddress(db, 111);

  insertDeposit(db, { txid: 'ee'.repeat(32), address: a.address, chatId: 111, sat: 50000000n });
  creditDeposit(db, 1, RATE);
  const carried = db.prepare('SELECT remainder_nano_usd r FROM pcn_addresses WHERE address=?').get(a.address).r;
  assert.ok(carried > 0);

  const id2 = insertDeposit(db, { txid: 'ff'.repeat(32), address: a.address, chatId: 111, sat: 1000000000n });
  creditDeposit(db, id2, RATE);

  // With no carry, 10 PCN would credit floor(nano/1000). With the carry added
  // first, the result is >= that. The point is that the carry is not lost.
  const after = db.prepare('SELECT remainder_nano_usd r FROM pcn_addresses WHERE address=?').get(a.address).r;
  assert.ok(after < 1000, 'remainder stays sub-micro');
  assert.ok(balance(db, 111) > 0);
  db.close();
});

// ---------------------------------------------------------------------------
// Allocation rules.
// ---------------------------------------------------------------------------
test('a double /topup returns the SAME address, not a second one', () => {
  const db = freshDb();
  seedPool(db, [[1000, A1], [1001, A2]]);
  addUser(db, 111);
  const first = allocateAddress(db, 111);
  const again = allocateAddress(db, 111);
  assert.equal(again.address, first.address);
  assert.equal(again.fresh, false);
  assert.equal(poolStats(db).issued, 1, 'only one address consumed');
  db.close();
});

test('claimability is assigned_at, so a deleted user never frees their address', () => {
  const db = freshDb();
  seedPool(db, [[1000, A1], [1001, A2]]);
  addUser(db, 111);
  const a = allocateAddress(db, 111);

  // Delete the user the way a real deletion would: null the chat_id.
  db.prepare('UPDATE pcn_addresses SET chat_id = NULL WHERE address = ?').run(a.address);
  db.prepare('DELETE FROM users WHERE chat_id = ?').run(111);

  addUser(db, 222);
  const b = allocateAddress(db, 222);
  assert.notEqual(b.address, a.address, 'the shown address is NEVER re-issued');

  // ...and it is still WATCHED, because issuedAddresses keys on assigned_at.
  const watched = issuedAddresses(db).map((r) => r.address);
  assert.ok(watched.includes(a.address), 'orphaned address stays under watch');
  db.close();
});

test('an empty pool throws PoolEmpty rather than deriving on the fly', () => {
  const db = freshDb();
  seedPool(db, [[1000, A1]]);
  addUser(db, 111);
  addUser(db, 222);
  allocateAddress(db, 111);
  assert.throws(() => allocateAddress(db, 222), PoolEmpty);
  db.close();
});

test('a pool file with ONE bad line imports NOTHING', () => {
  const db = freshDb();
  const text = [`1000 ${A1}`, '1001 notanaddress', `1002 ${A3}`].join('\n');
  assert.throws(() => importPool(db, text), /refused/);
  assert.equal(poolStats(db).total, 0, 'all-or-nothing: no partial import');
  db.close();
});

test('a pool file holding a Bitcoin address imports NOTHING', () => {
  const db = freshDb();
  const text = [`1000 ${A1}`, '1001 bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'].join('\n');
  assert.throws(() => importPool(db, text), /refused/);
  assert.equal(poolStats(db).total, 0);
  db.close();
});

test('addresses are stored lowercase even when the file is uppercase', () => {
  const db = freshDb();
  importPool(db, `1000 ${A1.toUpperCase()}`);
  const row = db.prepare('SELECT address FROM pcn_addresses').get();
  assert.equal(row.address, A1);
  db.close();
});

test('a pool file for a DIFFERENT wallet is refused rather than merged', () => {
  const db = freshDb();
  importPool(db, `1000 ${A1}`);
  assert.throws(() => importPool(db, `1000 ${A2}`), /DIFFERENT address/);
  db.close();
});

// ---------------------------------------------------------------------------
// The reconciliation invariant.
// ---------------------------------------------------------------------------
test('the reconciliation invariant holds after credits and breaks on tampering', () => {
  const db = freshDb();
  seedPool(db, [[1000, A1]]);
  addUser(db, 111);
  const a = allocateAddress(db, 111);
  const id = insertDeposit(db, { txid: '11'.repeat(32), address: a.address, chatId: 111, sat: 3000000000n });
  creditDeposit(db, id, RATE);

  assert.equal(reconcile(db).ok, true, 'invariant holds after a normal credit');

  // A balance moved without a ledger row -- the shape a bad migration or a
  // hand-edit produces.
  db.prepare('UPDATE users SET balance_micro_usd = balance_micro_usd + 5 WHERE chat_id=?').run(111);
  const bad = reconcile(db);
  assert.equal(bad.ok, false);
  assert.equal(bad.drifts[0].kind, 'ledger_vs_balance');
  db.close();
});

test('an orphaned open reservation is caught by the invariant', () => {
  const db = freshDb();
  addUser(db, 111);
  db.prepare(`INSERT INTO reservations (chat_id, update_id, model, micro_usd, state, created_at)
              VALUES (?,?,?,?, 'open', ?)`).run(111, 1, 'gpt-5', 5000, nowSec());
  const r = reconcile(db);
  assert.equal(r.ok, false);
  assert.ok(r.drifts.some((d) => d.kind === 'reserved_vs_open'));
  db.close();
});

// ---------------------------------------------------------------------------
// A credit must never happen without a usable rate.
// ---------------------------------------------------------------------------
test('crediting refuses outright when the rate is not usable', () => {
  const db = freshDb();
  seedPool(db, [[1000, A1]]);
  addUser(db, 111);
  const a = allocateAddress(db, 111);
  const id = insertDeposit(db, { txid: '22'.repeat(32), address: a.address, chatId: 111, sat: 3000000000n });

  assert.throws(() => creditDeposit(db, id, { usable: false }), /usable rate/);
  assert.throws(() => creditDeposit(db, id, null), /usable rate/);
  assert.equal(balance(db, 111), 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ledger').get().n, 0);
  db.close();
});
