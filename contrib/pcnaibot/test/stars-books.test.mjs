// Telegram's Stars books against ours (lib/stars-books.mjs; review of 2026-09-27, item D).
//
// Pinned: matching books raise nothing; money on one side only is a problem in either direction,
// for payments and for refunds; a failed or incomplete read is never "the books match"; paging
// reads past 100 transactions; a payment still on its way is given time.
import test from 'node:test';
import assert from 'node:assert/strict';

import { nowSec } from '../lib/db.mjs';
import { readStarTransactions, compareStarsBooks, nextBooksState, BOOKS_GRACE_SEC, BOOKS_UNKNOWN_AFTER } from '../lib/stars-books.mjs';
import { freshDb } from './fixtures.mjs';

const OLD = nowSec() - BOOKS_GRACE_SEC - 60;
function payment(db, { id, charge, stars = 250, at = OLD, refund = null, chat = 7 }) {
  const inv = db.prepare(
    "INSERT INTO stars_invoices (chat_id, payload, stars, micro_usd, state, created_at) VALUES (?,?,?,?, 'paid', ?)"
  ).run(chat, `stars:${chat}:${id}`, stars, 5_000_000, at).lastInsertRowid;
  db.prepare(
    'INSERT INTO stars_payments (id, chat_id, invoice_id, charge_id, stars, micro_usd, created_at, refund_state, notified_at) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(id, chat, inv, charge, stars, 5_000_000, at, refund, at);
}
const paid = (id, amount = 250, date = OLD, user = 7) => ({ id, amount, date, source: { type: 'user', user: { id: user }, invoice_payload: 'stars:x' } });
const refunded = (id, amount = 250, date = OLD, user = 7) => ({ id, amount, date, receiver: { type: 'user', user: { id: user } } });
const withdrawal = (id, amount = 1000) => ({ id, amount, date: OLD, receiver: { type: 'fragment' } });

test('matching books raise nothing -- payments, a refund, and a withdrawal to Fragment', () => {
  const db = freshDb();
  payment(db, { id: 1, charge: 'ch_1' });
  payment(db, { id: 2, charge: 'ch_2', refund: 'done' });
  const r = compareStarsBooks(db, [paid('ch_1'), paid('ch_2'), refunded('ch_2'), withdrawal('w_1')]);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.counts, { telegramIn: 2, telegramRefunds: 1, payments: 2 });
});

test('a payment Telegram has and we never credited is a problem; a fresh one or a parked one is not yet', () => {
  const db = freshDb();
  const r = compareStarsBooks(db, [paid('ch_lost', 500, OLD, 42), paid('ch_fresh', 250, nowSec() - 30), paid('ch_parked')], { ignore: new Set(['ch_parked']) });
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /paid in Telegram, never credited: 500 ⭐ from user 42/);
});

test('a payment we credited that Telegram does not have is a problem', () => {
  const db = freshDb();
  payment(db, { id: 3, charge: 'ch_3' });
  payment(db, { id: 4, charge: 'ch_new', at: nowSec() - 30 });
  const r = compareStarsBooks(db, []);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /credited here, not in Telegram: payment #3/);
});

test('amounts that differ are a problem', () => {
  const db = freshDb();
  payment(db, { id: 5, charge: 'ch_5', stars: 250 });
  assert.match(compareStarsBooks(db, [paid('ch_5', 2500)]).problems[0], /payment #5 is 250 ⭐, Telegram says 2500 ⭐/);
});

test('refunds: made in Telegram but open here, closed here but not in Telegram, or for a payment we never had', () => {
  const db = freshDb();
  payment(db, { id: 6, charge: 'ch_6' });                     // Telegram refunded it; we did not close it
  payment(db, { id: 7, charge: 'ch_7', refund: 'done' });     // we closed it; Telegram has no refund
  const r = compareStarsBooks(db, [paid('ch_6'), refunded('ch_6'), paid('ch_7'), refunded('ch_x')]);
  assert.equal(r.problems.length, 3, r.problems.join(' | '));
  assert.ok(r.problems.some((p) => /refunded in Telegram, not closed here: payment #6/.test(p)));
  assert.ok(r.problems.some((p) => /refunded here, not in Telegram: payment #7/.test(p)));
  assert.ok(r.problems.some((p) => /refunded a payment we never had/.test(p)));
});

// ---- reading Telegram ----------------------------------------------------------------------------

function pagedTg(all, { failAt = null } = {}) {
  const calls = [];
  return {
    calls,
    call: async (method, { offset, limit }) => {
      calls.push({ method, offset, limit });
      if (failAt !== null && offset >= failAt) return { ok: false, description: 'Too Many Requests' };
      return { ok: true, result: { transactions: all.slice(offset, offset + limit) } };
    },
  };
}

test('paging reads every transaction past the first hundred', async () => {
  const all = Array.from({ length: 250 }, (_, i) => paid(`ch_${i}`));
  const tg = pagedTg(all);
  const r = await readStarTransactions(tg);
  assert.equal(r.ok, true);
  assert.equal(r.txs.length, 250);
  assert.deepEqual(tg.calls.map((c) => c.offset), [0, 100, 200]);
});

test('a read that fails part-way, throws, or cannot reach the end is not a list', async () => {
  const all = Array.from({ length: 250 }, (_, i) => paid(`ch_${i}`));
  assert.equal((await readStarTransactions(pagedTg(all, { failAt: 100 }))).ok, false, 'a partial list would report old payments as missing');
  assert.equal((await readStarTransactions({ call: async () => { throw new Error('ETIMEDOUT'); } })).ok, false);
  assert.equal((await readStarTransactions({ call: async () => ({ ok: true, result: {} }) })).ok, false);
  assert.equal((await readStarTransactions(pagedTg(all), { maxPages: 2 })).ok, false);
});

// ---- the running state the heartbeat carries -----------------------------------------------------

test('failed reads: never ok; pending before any read completed; unknown after a few in a row', () => {
  const db = freshDb();
  const compare = (txs) => compareStarsBooks(db, txs);
  const fail = { ok: false, error: 'Too Many Requests' };
  let s = nextBooksState(null, fail, compare);
  assert.equal(s.state, 'pending', 'no read has completed yet');
  for (let i = 1; i < BOOKS_UNKNOWN_AFTER; i++) s = nextBooksState(s, fail, compare);
  assert.equal(s.state, 'unknown');
  assert.equal(s.failures, BOOKS_UNKNOWN_AFTER);

  s = nextBooksState(s, { ok: true, txs: [] }, compare, 1000);
  assert.deepEqual([s.state, s.failures, s.checked_at], ['ok', 0, 1000]);
  s = nextBooksState(s, fail, compare);
  assert.equal(s.state, 'ok', 'one failed read keeps the last answer ...');
  assert.equal(s.failures, 1, '... and counts');
  for (let i = 1; i < BOOKS_UNKNOWN_AFTER; i++) s = nextBooksState(s, fail, compare);
  assert.equal(s.state, 'unknown', 'a run of failures is never "the books match"');
  assert.equal(s.checked_at, 1000, 'and says when they last did');
});

test('a mismatch is carried with its problems', () => {
  const db = freshDb();
  const s = nextBooksState(null, { ok: true, txs: [paid('ch_ghost')] }, (txs) => compareStarsBooks(db, txs));
  assert.equal(s.state, 'mismatch');
  assert.equal(s.problems.length, 1);
});
