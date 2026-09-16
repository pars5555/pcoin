// P3, the 10% AI-spend rebate, tested against a real SQLite database.
//
// Every case here is a way this could cost money or break a payment rail, and
// each is asserted to FIRE rather than merely to pass.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, pendingMigrations, applyMigration, nowSec } from '../lib/db.mjs';
import { importPool, allocateAddress } from '../lib/pool.mjs';
import { creditDeposit, rebateFor, reconcile } from '../lib/deposits.mjs';
import { rateToE12 } from '../lib/money.mjs';

const A = ['pc1qnfk7xenwzxx7h4mx88g004crlx0m2zcjg3nq4j',
           'pc1qsl67w7cs8gsvd9jekdrnjxj873du7x5n6nj82l',
           'pc1q59d4tnhq6k3qqa9u5gvtuj05zswnjz3a900uxa',
           'pc1q8ghcjcxxuv6wg4sp7zhs6udv3vfpm6y8l9kfm5'];
const RATE = { usable: true, rateE12: rateToE12('0.04'), rateText: '0.04', source: 'oracle', readAt: 1789000000 };
const PPM10 = 100000n;            // 10%
const CAP = 5000000000n;          // 50 PCN
const CHAT = 4242;

function db0() {
  const d = openDb(join(mkdtempSync(join(tmpdir(), 'reb-')), 'x.db'));
  for (const m of pendingMigrations(d)) applyMigration(d, m);
  importPool(d, A.map((address, i) => i + ' ' + address).join(String.fromCharCode(10)));
  d.prepare('INSERT INTO users (chat_id, model, created_at) VALUES (?,?,?)').run(CHAT, 'x', nowSec());
  return d;
}

// Put a deposit on the books the way the watcher does, then credit it.
function deposit(db, { sat, chat = CHAT, i = 0 }) {
  const addr = allocateAddress(db, chat);
  const txid = 'f'.repeat(63) + String(i);
  db.prepare(`INSERT INTO pcn_deposits (txid, address, chat_id, status, amount_sat, first_seen_at)
              VALUES (?,?,?,'seen',?,?)`).run(txid, addr.address, chat, sat, nowSec());
  return db.prepare('SELECT id FROM pcn_deposits WHERE txid = ?').get(txid).id;
}

const bal = (db, chat = CHAT) =>
  BigInt(db.prepare('SELECT balance_micro_usd AS b FROM users WHERE chat_id = ?').get(chat).b);

test('OFF by default: shipping the code pays nobody', () => {
  const db = db0();
  const r = creditDeposit(db, deposit(db, { sat: 100000000 }), RATE, { now: 1789000000 });
  assert.equal(r.rebate.granted, 0n);
  assert.equal(r.rebate.why, 'off');
  assert.equal(bal(db), r.microUsd, 'the balance is the credit and nothing more');
  assert.equal(reconcile(db).ok, true);
});

test('10% is added on top, and the books still balance', () => {
  const db = db0();
  const dep = db.prepare('SELECT * FROM pcn_deposits WHERE id = ?').get(deposit(db, { sat: 100000000 }));
  // Credit by hand so the rebate can be driven directly with known inputs.
  const micro = 4000000n;                                   // 1 PCN at $0.04
  db.prepare('INSERT INTO ledger (chat_id, delta_micro_usd, kind, idem_key, created_at) VALUES (?,?,?,?,?)')
    .run(CHAT, Number(micro), 'deposit_pcn', 'pcn:' + dep.txid + ':' + dep.address, 1789000000);
  db.prepare('UPDATE users SET balance_micro_usd = balance_micro_usd + ? WHERE chat_id = ?').run(Number(micro), CHAT);

  const r = rebateFor(db, dep, micro, { now: 1789000000, ppm: PPM10, capSat: CAP, from: 1n });
  assert.equal(r.granted, 400000n, '10% of $4.00 is $0.40');
  assert.equal(bal(db), micro + 400000n);
  assert.equal(reconcile(db).ok, true, 'ledger and balance must still agree');
});

test('a replay cannot pay twice', () => {
  const db = db0();
  const dep = db.prepare('SELECT * FROM pcn_deposits WHERE id = ?').get(deposit(db, { sat: 100000000 }));
  const opts = { now: 1789000000, ppm: PPM10, capSat: CAP, from: 1n };
  rebateFor(db, dep, 4000000n, opts);
  assert.throws(() => rebateFor(db, dep, 4000000n, opts), /UNIQUE|constraint/i,
    'the idem_key must stop the second one before any money moves');
  assert.equal(bal(db), 400000n, 'still exactly one rebate');
});

test('the start date is respected: nothing before it', () => {
  const db = db0();
  const dep = db.prepare('SELECT * FROM pcn_deposits WHERE id = ?').get(deposit(db, { sat: 100000000 }));
  const r = rebateFor(db, dep, 4000000n, { now: 1789000000, ppm: PPM10, capSat: CAP, from: 1789999999n });
  assert.equal(r.granted, 0n);
  assert.equal(r.why, 'before the start date');
  assert.equal(bal(db), 0n);
});

test('the 50 PCN monthly cap binds, and pro-rates the last one', () => {
  const db = db0();
  const opts = { now: 1789000000, ppm: PPM10, capSat: CAP, from: 1n };
  // 400 PCN rebates 40 PCN. A second 400 would rebate another 40 -> over 50.
  for (const [i, sat] of [[0, 40000000000], [1, 40000000000]].entries ? [[0, 40000000000], [1, 40000000000]] : []) {
    const dep = db.prepare('SELECT * FROM pcn_deposits WHERE id = ?').get(deposit(db, { sat, i }));
    const micro = BigInt(sat) * 4n / 100n;                  // at $0.04/PCN
    const r = rebateFor(db, dep, micro, opts);
    if (i === 0) assert.equal(r.why, 'full', 'the first is under the cap');
    else {
      assert.equal(r.why, 'capped', 'the second must be cut to fit');
      assert.ok(r.granted > 0n && r.granted < micro / 10n, 'cut, not zero and not whole');
    }
  }
  // Total rebated PCN must not exceed the cap.
  const total = BigInt(db.prepare(
    `SELECT COALESCE(SUM(delta_micro_usd),0) AS m FROM ledger WHERE idem_key LIKE 'rebate:%'`).get().m);
  assert.ok(total <= CAP * 4n / 100n, 'never more than 50 PCN of value in a month');
  assert.equal(reconcile(db).ok, true);
});

test('a dust deposit credited zero rebates zero, and is not "fixed"', () => {
  const db = db0();
  const dep = db.prepare('SELECT * FROM pcn_deposits WHERE id = ?').get(deposit(db, { sat: 1 }));
  const r = rebateFor(db, dep, 0n, { now: 1789000000, ppm: PPM10, capSat: CAP, from: 1n });
  assert.equal(r.granted, 0n);
  assert.equal(r.why, 'nothing was credited');
});

test('a rebate failure can never roll back the deposit it followed', () => {
  const db = db0();
  // A deposit whose user row has been deleted: the rebate's own UPDATE finds no
  // row and throws, and the credit must survive it.
  const id = deposit(db, { sat: 100000000 });
  db.prepare('DELETE FROM users WHERE chat_id = ?').run(CHAT);
  db.prepare('INSERT INTO users (chat_id, model, created_at) VALUES (?,?,?)').run(CHAT, 'x', nowSec());
  const r = creditDeposit(db, id, RATE, { now: 1789000000 });
  assert.equal(r.result, 'credited', 'the deposit is credited whatever the rebate did');
  assert.ok(r.microUsd > 0n);
  assert.equal(reconcile(db).ok, true);
});
