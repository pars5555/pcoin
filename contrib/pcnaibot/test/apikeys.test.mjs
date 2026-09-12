// API keys and the API billing path.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, pendingMigrations, applyMigration, nowSec } from '../lib/db.mjs';
import { issueKey, resolveKey, revokeKey, listKeys, hashKey, RateBucket, looksLikeKey } from '../lib/apikeys.mjs';
import { reserve, settle } from '../lib/billing.mjs';
import { reconcile } from '../lib/deposits.mjs';

function freshDb(balance = 1000000) {
  const dir = mkdtempSync(join(tmpdir(), 'pcnaibot-key-'));
  const db = openDb(join(dir, 'k.db'));
  for (const m of pendingMigrations(db)) applyMigration(db, m);
  db.prepare('INSERT INTO users (chat_id, balance_micro_usd, model, created_at) VALUES (?,?,?,?)')
    .run(5, balance, 'glm-5.3-flash', nowSec());
  db.prepare('INSERT INTO ledger (chat_id, delta_micro_usd, kind, idem_key, created_at) VALUES (?,?,?,?,?)')
    .run(5, balance, 'adjust', 'seed:5', nowSec());
  return db;
}

test('the plaintext key is never stored -- only its hash', () => {
  const db = freshDb();
  const key = issueKey(db, 5);
  const row = db.prepare('SELECT * FROM api_keys').get();
  assert.equal(row.key_hash, hashKey(key));
  assert.notEqual(row.key_hash, key);
  // The whole row must not contain the secret anywhere.
  assert.ok(!JSON.stringify(row).includes(key), 'the key itself appears nowhere in the row');
  // The prefix is a display aid, not the secret.
  assert.ok(key.startsWith(row.key_prefix));
  db.close();
});

test('a valid key resolves to its owner; a wrong one resolves to nothing', () => {
  const db = freshDb();
  const key = issueKey(db, 5);
  assert.equal(resolveKey(db, key).chat_id, 5);
  assert.equal(resolveKey(db, `${key}x`), null);
  assert.equal(resolveKey(db, 'pcn_totally-wrong-value-here'), null);
  assert.equal(resolveKey(db, ''), null);
  assert.equal(resolveKey(db, null), null);
  assert.equal(resolveKey(db, undefined), null);
  db.close();
});

test('a revoked key stops resolving and is never reusable', () => {
  const db = freshDb();
  const key = issueKey(db, 5);
  const prefix = key.slice(0, 12);
  assert.ok(resolveKey(db, key));
  assert.equal(revokeKey(db, 5, prefix), 1);
  assert.equal(resolveKey(db, key), null, 'revoked resolves to nothing, same as unknown');
  // revoked_at is set once and never cleared.
  assert.equal(revokeKey(db, 5, prefix), 0, 'revoking twice changes nothing');
  db.close();
});

test('one user cannot revoke another user\'s key', () => {
  const db = freshDb();
  db.prepare('INSERT INTO users (chat_id, model, created_at) VALUES (?,?,?)').run(6, 'glm-5.3-flash', nowSec());
  const key = issueKey(db, 5);
  assert.equal(revokeKey(db, 6, key.slice(0, 12)), 0);
  assert.ok(resolveKey(db, key), 'still valid');
  db.close();
});

test('keys are capped per user', () => {
  const db = freshDb();
  for (let i = 0; i < 5; i++) issueKey(db, 5);
  assert.throws(() => issueKey(db, 5), /maximum/);
  // Revoking one frees a slot.
  revokeKey(db, 5, listKeys(db, 5)[0].key_prefix);
  issueKey(db, 5);
  db.close();
});

test('generated keys are distinct and well-formed', () => {
  const db = freshDb();
  const a = issueKey(db, 5);
  const b = issueKey(db, 5);
  assert.notEqual(a, b);
  assert.ok(looksLikeKey(a) && looksLikeKey(b));
  assert.ok(!looksLikeKey('sk-something'));
  assert.ok(!looksLikeKey('pcn_'));
  db.close();
});

// ---------------------------------------------------------------------------
// The API billing path shares the bot's reserve/settle, keyed on req_key.
// ---------------------------------------------------------------------------
test('an API turn reserves and settles on req_key, and the invariant closes', () => {
  const db = freshDb();
  const r = reserve(db, { chatId: 5, reqKey: 'k1:abc', model: 'glm-5.3-flash', microUsd: 5000n });
  assert.equal(r.duplicate, false);
  const s = settle(db, r.reservationId, 1200n);
  assert.equal(s.overran, false);
  assert.equal(reconcile(db).ok, true);

  const led = db.prepare("SELECT idem_key FROM ledger WHERE kind='ai_turn'").get();
  assert.equal(led.idem_key, 'turn:api:k1:abc', 'API turns are keyed distinctly from Telegram ones');
  db.close();
});

test('the same req_key reserves exactly once', () => {
  const db = freshDb();
  const a = reserve(db, { chatId: 5, reqKey: 'k1:same', model: 'gpt-5-mini', microUsd: 4000n });
  const b = reserve(db, { chatId: 5, reqKey: 'k1:same', model: 'gpt-5-mini', microUsd: 4000n });
  assert.equal(b.duplicate, true);
  assert.equal(a.reservationId, b.reservationId);
  db.close();
});

test('a Telegram update_id and an API req_key cannot collide', () => {
  const db = freshDb();
  // Both exist in the same table; they must not be confusable.
  reserve(db, { chatId: 5, updateId: 42, model: 'gpt-5-mini', microUsd: 1000n });
  const api = reserve(db, { chatId: 5, reqKey: '42', model: 'gpt-5-mini', microUsd: 1000n });
  assert.equal(api.duplicate, false, 'req_key "42" is NOT update_id 42');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM reservations').get().n, 2);
  db.close();
});

test('reserve refuses unless exactly one identity is given', () => {
  const db = freshDb();
  assert.throws(() => reserve(db, { chatId: 5, model: 'gpt-5-mini', microUsd: 100n }), /exactly one/);
  assert.throws(() => reserve(db, { chatId: 5, updateId: 1, reqKey: 'x', model: 'gpt-5-mini', microUsd: 100n }), /exactly one/);
  db.close();
});

// ---------------------------------------------------------------------------
test('the rate bucket allows a burst then refuses, and reports a retry delay', () => {
  const b = new RateBucket({ perMinute: 60, burst: 5 });
  let allowed = 0;
  for (let i = 0; i < 10; i++) if (b.take('x').allowed) allowed++;
  assert.equal(allowed, 5, 'the burst is the burst');
  const r = b.take('x');
  assert.equal(r.allowed, false);
  assert.ok(r.retryAfter >= 1);
  // A different key has its own bucket.
  assert.equal(b.take('y').allowed, true);
});

test('the rate bucket is bounded and cannot grow without limit', () => {
  const b = new RateBucket({ perMinute: 60, burst: 2 });
  for (let i = 0; i < 500; i++) b.take(`id${i}`);
  b.sweep(100);
  assert.ok(b.buckets.size <= 100, 'sweep bounds the map');
});
