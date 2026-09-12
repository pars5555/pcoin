// The provider billing path.
//
// Section 8's tests 12, 13, 14 and 17, plus the no-clamp rule, which is the one
// that decides whether an under-quote is a pricing bug or a free lunch.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, pendingMigrations, applyMigration, nowSec } from '../lib/db.mjs';
import {
  reserve, settle, release, hold, ageOutReservations, acquireUserLock,
  takeFreeTurn, quoteTurn, InsufficientFunds, Busy,
} from '../lib/billing.mjs';
import { reconcile } from '../lib/deposits.mjs';
import { classify, Bucket, usageFromResponse, assertNoCacheTokens } from '../lib/oonacode.mjs';
import { parseScaled, tokensToMicroUsd } from '../lib/money.mjs';

function freshDb(balance = 10000000) { // $10.00
  const dir = mkdtempSync(join(tmpdir(), 'pcnaibot-bill-'));
  const db = openDb(join(dir, 'b.db'));
  for (const m of pendingMigrations(db)) applyMigration(db, m);
  db.prepare('INSERT INTO users (chat_id, balance_micro_usd, model, created_at) VALUES (?,?,?,?)')
    .run(1, balance, 'claude-sonnet-5', nowSec());
  // Seed the balance THROUGH the ledger, because that is the only way a real
  // balance ever arrives. Setting the column alone would leave the
  // reconciliation invariant broken before the test does anything -- which is
  // exactly the drift the invariant exists to catch.
  if (balance > 0) {
    db.prepare(`INSERT INTO ledger (chat_id, delta_micro_usd, kind, idem_key, created_at)
                VALUES (?,?,?,?,?)`).run(1, balance, 'adjust', 'seed:1', nowSec());
  }
  return db;
}

const SONNET = {
  inputPricePerMe9: parseScaled('2.4', 9),
  outputPricePerMe9: parseScaled('12', 9),
};
const M3 = parseScaled('3.0', 6);

function bal(db) { return db.prepare('SELECT balance_micro_usd b FROM users WHERE chat_id=1').get().b; }
function resv(db) { return db.prepare('SELECT reserved_micro_usd r FROM users WHERE chat_id=1').get().r; }

// ---------------------------------------------------------------------------
// Test 13: ask for max_tokens 4096 and get a 200-token answer -- the settle
// must be ~200 tokens' worth, NOT the ceiling.
// ---------------------------------------------------------------------------
test('a 4096-token ceiling with a 200-token answer settles at ~200 tokens, not the ceiling', () => {
  const db = freshDb();
  const quote = quoteTurn({ inputTokens: 1000n, maxTokens: 4096n, priceRow: SONNET, marginE6: M3 });
  const r = reserve(db, { chatId: 1, updateId: 1, model: 'claude-sonnet-5', microUsd: quote });
  assert.equal(resv(db), Number(quote));

  const actual = tokensToMicroUsd(1000n, SONNET.inputPricePerMe9, M3)
               + tokensToMicroUsd(200n, SONNET.outputPricePerMe9, M3);
  const s = settle(db, r.reservationId, actual);

  assert.equal(s.overran, false);
  assert.equal(resv(db), 0, 'the whole reservation is released');
  assert.equal(bal(db), 10000000 - Number(actual));
  // The ceiling was 4096 output tokens; we billed 200.
  assert.ok(Number(actual) < Number(quote) / 3, 'billed far below the ceiling');
  assert.equal(reconcile(db).ok, true);
  db.close();
});

// ---------------------------------------------------------------------------
// THE NO-CLAMP RULE. A settle that exceeds the reservation is BILLED IN FULL
// and the balance goes NEGATIVE. Clamping would convert every under-quote into
// free output paid for by the house.
// ---------------------------------------------------------------------------
test('a settle that overruns the reservation is billed IN FULL and may go negative', () => {
  const db = freshDb(500000); // $0.50
  const quote = 100000n;      // $0.10 reserved
  const r = reserve(db, { chatId: 1, updateId: 1, model: 'claude-sonnet-5', microUsd: quote });

  const actual = 900000n;     // $0.90 actually incurred -- a bad under-quote
  const s = settle(db, r.reservationId, actual);

  assert.equal(s.overran, true);
  assert.equal(s.actual, actual, 'billed in full, NOT clamped to the reservation');
  assert.equal(bal(db), 500000 - 900000, 'balance is negative, which blocks further turns');
  assert.ok(s.negative);
  assert.ok(s.ratio > 1, 'the settle/reserved ratio is emitted for the heartbeat counter');
  assert.equal(reconcile(db).ok, true, 'the invariant still closes');
  db.close();
});

// ---------------------------------------------------------------------------
// Test 17: an empty balance refuses BEFORE the provider call.
// ---------------------------------------------------------------------------
test('an insufficient balance refuses before anything is called, and moves no money', () => {
  const db = freshDb(1000); // $0.001
  const quote = quoteTurn({ inputTokens: 1000n, maxTokens: 4096n, priceRow: SONNET, marginE6: M3 });
  assert.throws(() => reserve(db, { chatId: 1, updateId: 1, model: 'claude-sonnet-5', microUsd: quote }),
    InsufficientFunds);
  assert.equal(bal(db), 1000, 'balance untouched');
  assert.equal(resv(db), 0, 'nothing reserved');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM reservations').get().n, 0);
  db.close();
});

// ---------------------------------------------------------------------------
// Test 11 / 5.4: the same update_id must reserve exactly once.
// ---------------------------------------------------------------------------
test('the same update_id reserves exactly once', () => {
  const db = freshDb();
  const q = 50000n;
  const a = reserve(db, { chatId: 1, updateId: 77, model: 'gpt-5', microUsd: q });
  const b = reserve(db, { chatId: 1, updateId: 77, model: 'gpt-5', microUsd: q });
  assert.equal(b.duplicate, true);
  assert.equal(a.reservationId, b.reservationId);
  assert.equal(resv(db), Number(q), 'reserved once, not twice');
  assert.equal(reconcile(db).ok, true);
  db.close();
});

// ---------------------------------------------------------------------------
// Test 12: every provider error class lands in the right bucket.
// ---------------------------------------------------------------------------
test('error classification: each shape lands in the right bucket', () => {
  const gatewayJson5xx = { type: 'error', error: { type: 'api_error', message: 'upstream failed' } };

  // PERMANENT -- did not run.
  for (const s of [400, 401, 402, 404, 405, 415]) {
    assert.equal(classify(s, { error: { code: 'x' } }, { hadJsonContentType: true }), Bucket.PERMANENT, `HTTP ${s}`);
  }
  // BACKOFF -- did not run, come back later.
  assert.equal(classify(429, null, {}), Bucket.BACKOFF);
  assert.equal(classify(503, null, {}), Bucket.BACKOFF);

  // NOT BILLED -- only when the GATEWAY answered in its own /v1 envelope.
  assert.equal(classify(500, gatewayJson5xx, { hadJsonContentType: true }), Bucket.NOT_BILLED);

  // UNKNOWN -- an HTML 502 from Apache while the container kept generating is a
  // DIFFERENT EVENT WITH THE SAME STATUS CODE.
  assert.equal(classify(502, null, { hadJsonContentType: false }), Bucket.UNKNOWN);
  assert.equal(classify(504, null, { hadJsonContentType: false }), Bucket.UNKNOWN);
  assert.equal(classify(524, null, { hadJsonContentType: false }), Bucket.UNKNOWN);
  // A 5xx that decoded as JSON but is NOT the gateway envelope is still unknown.
  assert.equal(classify(500, { something: 'else' }, { hadJsonContentType: true }), Bucket.UNKNOWN);

  assert.equal(classify(200, {}, { hadJsonContentType: true }), Bucket.OK);
});

test('PERMANENT and BACKOFF release in full; UNKNOWN holds', () => {
  const db = freshDb();
  const q = 200000n;

  const r1 = reserve(db, { chatId: 1, updateId: 1, model: 'gpt-5', microUsd: q });
  release(db, r1.reservationId, 'permanent: HTTP 400');
  assert.equal(resv(db), 0);
  assert.equal(bal(db), 10000000, 'released in full');

  const r2 = reserve(db, { chatId: 1, updateId: 2, model: 'gpt-5', microUsd: q });
  hold(db, r2.reservationId, 'unknown: HTML 502');
  assert.equal(resv(db), Number(q), 'held money stays reserved, neither spent nor returned');
  assert.equal(db.prepare('SELECT state FROM reservations WHERE id=?').get(r2.reservationId).state, 'held');
  db.close();
});

// ---------------------------------------------------------------------------
// Test 19: kill mid-turn, restart, the reservation ages out and the invariant
// holds.
// ---------------------------------------------------------------------------
test('an orphaned reservation ages out, is released in full, and is logged', () => {
  const db = freshDb();
  const q = 300000n;
  const r = reserve(db, { chatId: 1, updateId: 1, model: 'gpt-5', microUsd: q });
  // Simulate a process kill 2 hours ago.
  db.prepare('UPDATE reservations SET created_at = ? WHERE id = ?').run(nowSec() - 7200, r.reservationId);

  assert.equal(reconcile(db).ok, true, 'invariant holds even while orphaned');

  const freed = ageOutReservations(db, { olderThanMinutes: 60 });
  assert.equal(freed.length, 1);
  assert.equal(resv(db), 0);
  assert.equal(bal(db), 10000000, 'released in full -- never confiscated');
  const row = db.prepare('SELECT state, note FROM reservations WHERE id=?').get(r.reservationId);
  assert.equal(row.state, 'expired');
  assert.match(row.note, /reserve_expired/);
  assert.equal(reconcile(db).ok, true);
  db.close();
});

test('a held reservation also ages out rather than being confiscated forever', () => {
  const db = freshDb();
  const r = reserve(db, { chatId: 1, updateId: 1, model: 'gpt-5', microUsd: 100000n });
  hold(db, r.reservationId, 'unknown');
  db.prepare('UPDATE reservations SET created_at = ? WHERE id = ?').run(nowSec() - 7200, r.reservationId);
  const freed = ageOutReservations(db, { olderThanMinutes: 60 });
  assert.equal(freed.length, 1);
  assert.equal(bal(db), 10000000);
  db.close();
});

// ---------------------------------------------------------------------------
// Test 18: free-model spam is stopped by a quota independent of balance.
// ---------------------------------------------------------------------------
test('a free model is rate limited per chat, independently of balance', () => {
  const db = freshDb(0); // no money at all
  let allowed = 0;
  for (let i = 0; i < 15; i++) if (takeFreeTurn(db, 1, { perHour: 10 }).allowed) allowed++;
  assert.equal(allowed, 10, 'the 11th free turn is refused even though it costs $0');
  db.close();
});

// ---------------------------------------------------------------------------
// Per-user serialisation.
// ---------------------------------------------------------------------------
test('a second concurrent turn for the same chat is refused', () => {
  const db = freshDb();
  const unlock = acquireUserLock(db, 1);
  assert.throws(() => acquireUserLock(db, 1), Busy);
  unlock();
  const unlock2 = acquireUserLock(db, 1);
  unlock2();
  db.close();
});

// ---------------------------------------------------------------------------
// usage parsing: the bug that made webbuilderbot's turns FREE.
// ---------------------------------------------------------------------------
test('an absent usage block is UNREADABLE, never zero tokens', () => {
  assert.equal(usageFromResponse({ stop_reason: 'end_turn' }).readable, false);
  assert.equal(usageFromResponse({ usage: {}, stop_reason: 'end_turn' }).readable, false);
  assert.equal(usageFromResponse({ usage: { input_tokens: 5 }, stop_reason: 'end_turn' }).readable, false);
  // No stop_reason means the turn is not proven complete, even with usage.
  assert.equal(usageFromResponse({ usage: { input_tokens: 5, output_tokens: 7 } }).readable, false);

  const ok = usageFromResponse({ usage: { input_tokens: 5, output_tokens: 7 }, stop_reason: 'end_turn' });
  assert.equal(ok.readable, true);
  assert.equal(ok.inputTokens, 5);
  assert.equal(ok.outputTokens, 7);
});

// ---------------------------------------------------------------------------
// Test 15: the cache assertion.
// ---------------------------------------------------------------------------
test('non-zero cache counters are detected', () => {
  assert.equal(assertNoCacheTokens({ input_tokens: 1, output_tokens: 1 }).clean, true);
  assert.equal(assertNoCacheTokens({ cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }).clean, true);
  assert.equal(assertNoCacheTokens({ cache_read_input_tokens: 512 }).clean, false);
  assert.equal(assertNoCacheTokens({ cache_creation_input_tokens: 20 }).clean, false);
});
