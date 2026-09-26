// admin.pc.am's credit path and user list. The credit must keep the ledger
// invariant closed and must credit once however many times the form is posted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, pendingMigrations, applyMigration, nowSec } from '../lib/db.mjs';
import { reconcile } from '../lib/deposits.mjs';
import { adminCredit, listUsers, userLedger, CreditRefused } from '../lib/admin-api.mjs';
import { trimZeros } from '../lib/money.mjs';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'pcnaibot-admin-'));
  const db = openDb(join(dir, 'a.db'));
  for (const m of pendingMigrations(db)) applyMigration(db, m);
  db.prepare('INSERT INTO users (chat_id, balance_micro_usd, model, created_at) VALUES (?,?,?,?)')
    .run(7, 0, 'mimo-v2.5', nowSec());
  return db;
}
const bal = (db) => db.prepare('SELECT balance_micro_usd b FROM users WHERE chat_id=7').get().b;

test('a credit lands in the balance AND the ledger, and the invariant closes', () => {
  const db = freshDb();
  const r = adminCredit(db, { chatId: 7, microUsd: 100000000, note: 'welcome', requestId: 'req-00000001' });
  assert.equal(r.duplicate, false);
  assert.equal(bal(db), 100000000);
  const l = userLedger(db, 7);
  assert.equal(l.length, 1);
  assert.equal(l[0].kind, 'adjust');
  assert.match(l[0].note, /welcome/);
  assert.equal(reconcile(db).ok, true);
  db.close();
});

test('the same request id credits once, however often it is posted', () => {
  const db = freshDb();
  adminCredit(db, { chatId: 7, microUsd: 5000000, note: 'x', requestId: 'req-00000002' });
  const again = adminCredit(db, { chatId: 7, microUsd: 5000000, note: 'x', requestId: 'req-00000002' });
  assert.equal(again.duplicate, true);
  assert.equal(bal(db), 5000000, 'credited once, not twice');
  assert.equal(reconcile(db).ok, true);
  db.close();
});

test('a credit is refused, moving nothing, for a bad amount, an unknown user, or no note', () => {
  const db = freshDb();
  const bad = [
    { chatId: 7, microUsd: 0, note: 'x', requestId: 'req-00000003' },
    { chatId: 7, microUsd: 1000000001, note: 'x', requestId: 'req-00000004' }, // over $1,000
    { chatId: 99, microUsd: 1000000, note: 'x', requestId: 'req-00000005' },
    { chatId: 7, microUsd: 1000000, note: '  ', requestId: 'req-00000006' },
    { chatId: 7, microUsd: 1000000, note: 'x', requestId: '' },
  ];
  for (const b of bad) assert.throws(() => adminCredit(db, b), CreditRefused);
  assert.equal(bal(db), 0);
  assert.equal(userLedger(db, 7).length, 0);
  db.close();
});

test('the user list sums spend, deposits and credits from the ledger rows', () => {
  const db = freshDb();
  adminCredit(db, { chatId: 7, microUsd: 2000000, note: 'x', requestId: 'req-00000007' });
  db.prepare(`INSERT INTO ledger (chat_id, delta_micro_usd, kind, idem_key, created_at) VALUES (7,-300000,'ai_turn','turn:1',?)`).run(nowSec());
  db.prepare('UPDATE users SET balance_micro_usd = balance_micro_usd - 300000 WHERE chat_id=7').run();
  const [u] = listUsers(db);
  assert.equal(u.credited_micro_usd, 2000000);
  assert.equal(u.spent_micro_usd, 300000);
  assert.equal(u.deposited_micro_usd, 0);
  assert.equal(u.turns, 1);
  assert.equal(u.balance_micro_usd, 1700000);
  db.close();
});

test('a balance shows no trailing zeros', () => {
  assert.equal(trimZeros('100.0000'), '100');
  assert.equal(trimZeros('7.9260'), '7.926');
  assert.equal(trimZeros('0.0000'), '0');
  assert.equal(trimZeros('-1.5000'), '-1.5');
  assert.equal(trimZeros('100'), '100');
});

// Live on 2026-09-26 the Stars page hung for 90 s: its report carried a BigInt, JSON.stringify threw
// after the headers were out, and the error handler then threw "headers already sent".
test('the admin API answers a reply carrying BigInts, and every route needs the token', async () => {
  const { startAdminApi } = await import('../lib/admin-api.mjs');
  const db = freshDb();
  const token = 'x'.repeat(40);
  const server = startAdminApi({
    db, token, port: 0, host: '127.0.0.1',
    stars: { get: async () => ({ packages: [{ stars: 250, micro: 5000000n }] }), refund: async () => ({ ok: false, error: 'no' }) },
  });
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const ok = await fetch(`${base}/admin/stars`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { packages: [{ stars: 250, micro: 5000000 }] });
    const no = await fetch(`${base}/admin/stars`, { signal: AbortSignal.timeout(5000) });
    assert.equal(no.status, 401);
  } finally {
    server.close();
  }
});
