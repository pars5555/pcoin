// Per-user API keys.
//
// STORED AS A HASH, SHOWN ONCE. The database holds sha256(key) and a 12-char
// prefix for display. A stolen database then yields no usable credential, and a
// support conversation never needs the secret.
//
// LOOKUP IS BY HASH, NOT BY PREFIX. Hashing the presented key and selecting on
// the unique hash column is a single indexed equality test -- there is no
// candidate set to compare against one at a time, so there is no per-key timing
// signal to leak. (constantTimeEqual below is kept for the one place a
// non-indexed comparison is unavoidable.)

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { nowSec } from './time.mjs';

export const KEY_PREFIX = 'pcn_';

export function hashKey(key) {
  return createHash('sha256').update(String(key), 'utf8').digest('hex');
}

export function constantTimeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// 32 bytes of CSPRNG, base64url. `randomBytes`, never Math.random.
export function generateKey() {
  return KEY_PREFIX + randomBytes(32).toString('base64url');
}

export function looksLikeKey(s) {
  return typeof s === 'string' && s.startsWith(KEY_PREFIX) && s.length >= 20 && s.length <= 128;
}

// Issue a key. Returns the PLAINTEXT once; it is never stored and never
// recoverable. The caller must show it and then forget it.
export function issueKey(db, chatId, { name = null, maxPerUser = 5 } = {}) {
  const live = db.prepare(
    'SELECT COUNT(*) n FROM api_keys WHERE chat_id = ? AND revoked_at IS NULL'
  ).get(chatId).n;
  if (live >= maxPerUser) {
    throw new Error(`you already have ${live} active keys (maximum ${maxPerUser}); revoke one first`);
  }

  const key = generateKey();
  db.prepare(
    `INSERT INTO api_keys (chat_id, key_hash, key_prefix, name, created_at)
     VALUES (?,?,?,?,?)`
  ).run(chatId, hashKey(key), key.slice(0, 12), name, nowSec());
  return key;
}

// Resolve a presented key to its owner.
//
// Returns null for absent, malformed, unknown OR revoked -- the caller must not
// be able to tell those apart from the outside, because the difference is only
// useful to somebody guessing.
export function resolveKey(db, presented) {
  if (!looksLikeKey(presented)) return null;
  const row = db.prepare(
    'SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL'
  ).get(hashKey(presented));
  return row ?? null;
}

export function touchKey(db, id) {
  db.prepare('UPDATE api_keys SET last_used_at = ?, calls = calls + 1 WHERE id = ?').run(nowSec(), id);
}

export function listKeys(db, chatId) {
  return db.prepare(
    `SELECT id, key_prefix, name, created_at, last_used_at, revoked_at, calls
       FROM api_keys WHERE chat_id = ? ORDER BY id DESC`
  ).all(chatId);
}

// Revoke by PREFIX, because that is the only part the user ever sees again.
// revoked_at is set once and never cleared -- a revoked key is never reusable,
// for the same reason an issued deposit address is never re-issued.
export function revokeKey(db, chatId, prefix) {
  const res = db.prepare(
    `UPDATE api_keys SET revoked_at = ?
      WHERE chat_id = ? AND key_prefix = ? AND revoked_at IS NULL`
  ).run(nowSec(), chatId, prefix);
  return res.changes;
}

// A per-key token bucket, kept in memory.
//
// Deliberately NOT in the database: this is abuse control on a public endpoint,
// it must answer in microseconds, and losing it on restart costs one burst.
// It is a SECOND admission control, independent of money -- a free-model call
// quotes $0, so a balance check admits it unconditionally.
export class RateBucket {
  constructor({ perMinute = 60, burst = 20 } = {}) {
    this.perMinute = perMinute;
    this.burst = burst;
    this.buckets = new Map();
  }

  take(id, n = 1) {
    const now = Date.now();
    let b = this.buckets.get(id);
    if (!b) {
      b = { tokens: this.burst, last: now };
      this.buckets.set(id, b);
    }
    const refill = ((now - b.last) / 60000) * this.perMinute;
    b.tokens = Math.min(this.burst, b.tokens + refill);
    b.last = now;
    if (b.tokens < n) {
      const needed = n - b.tokens;
      return { allowed: false, retryAfter: Math.ceil((needed / this.perMinute) * 60) };
    }
    b.tokens -= n;
    return { allowed: true };
  }

  // Bounded: a public endpoint must not let strangers grow a Map without limit.
  sweep(maxEntries = 10000) {
    if (this.buckets.size <= maxEntries) return;
    const entries = [...this.buckets.entries()].sort((a, b) => a[1].last - b[1].last);
    for (const [k] of entries.slice(0, entries.length - maxEntries)) this.buckets.delete(k);
  }
}
