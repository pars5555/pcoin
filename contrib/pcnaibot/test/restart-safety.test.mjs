// Restart and deploy safety (review of 2026-09-27, migration 017).
//
// Pinned:
//   A. a claimed chat message that had not started survives a restart and runs exactly once; one
//      that had started is never re-run; one too old is dropped -- and each user told once;
//   B. a paid user is always told "✅ Paid" exactly once, whichever delivery or sweep gets there,
//      and never "already credited";
//   C. a shutdown waits for running turns, starts nothing queued, and is bounded by its timeout;
//      a second signal exits at once;
//   F2. a payment credit that keeps failing is retried, then parked, and the next update is still
//      handled; the heartbeat says ok:false while a payment is parked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { nowSec } from '../lib/db.mjs';
import { claimMessage, startTurn, finishTurn, recoverTurns, TURN_RECOVERY_MAX_AGE_SEC } from '../lib/inbox.mjs';
import { turnQueue } from '../lib/turns.mjs';
import { gracefulStop, installShutdown } from '../lib/shutdown.mjs';
import { sendStarsInvoice, creditStarsPayment, notifyStarsPaid, unnotifiedPayments } from '../lib/stars.mjs';
import { takePaymentUpdate, creditThenClaim, PAYMENT_QUICK_TRIES, parkedCount } from '../lib/updates.mjs';
import { botHeartbeat } from '../lib/heartbeat.mjs';
import { DEFAULT_SETTINGS } from '../lib/settings.mjs';
import { freshDb, fakeTg } from './fixtures.mjs';

const quietLog = { info() {}, warn() {}, error() {} };
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const up = (id, text = 'a red fox', chat = 7) => ({ update_id: id, message: { message_id: id, chat: { id: chat, type: 'private' }, from: { id: chat }, text } });
const row = (db, id) => db.prepare('SELECT state, body FROM tg_updates WHERE update_id = ?').get(id);

// The bot's own turn wrapper (bot.mjs runTurn), with the work replaced.
const runner = (db, seen) => (msg) => async () => {
  if (!startTurn(db, msg.__update_id)) return;
  try { seen.push(msg.text); } finally { finishTurn(db, msg.__update_id); }
};

// ---- A. a claimed message survives a restart -----------------------------------------------------

test('A: a message queued behind busy slots when the process dies runs exactly once after the restart', async () => {
  const db = freshDb();
  // The old process: one slot, taken; the message is claimed and waits.
  const q1 = turnQueue(1);
  q1.track(new Promise(() => {}));                    // never finishes: the process dies first
  assert.equal(claimMessage(db, up(501)), true);
  const seen = [];
  q1.submit(runner(db, seen)({ ...up(501).message, __update_id: 501 }));
  await tick();
  assert.deepEqual(seen, [], 'still waiting when the process dies');
  assert.equal(row(db, 501).state, 'queued');
  assert.equal(claimMessage(db, up(501)), false, 'Telegram redelivers it: the claim holds, as before');

  // The new process over the same database.
  const left = recoverTurns(db);
  assert.equal(left.resume.length, 1);
  assert.equal(left.resume[0].text, 'a red fox');
  assert.equal(left.resume[0].__update_id, 501);
  assert.deepEqual(left.lost, []);
  const q2 = turnQueue(2);
  const run = runner(db, seen);
  q2.submit(run(left.resume[0]));
  q2.submit(run(left.resume[0]));                     // even submitted twice, it runs once
  await tick(20);
  assert.deepEqual(seen, ['a red fox']);
  assert.deepEqual(row(db, 501), { state: 'done', body: null }, 'answered; the message text is not kept');
  assert.deepEqual(recoverTurns(db), { resume: [], lost: [] }, 'a later start finds nothing');
});

test('A: a turn cut off mid-run is never re-run; its user is to be told once', () => {
  const db = freshDb();
  claimMessage(db, up(502));
  assert.equal(startTurn(db, 502), true);
  assert.equal(startTurn(db, 502), false, 'started once');
  const left = recoverTurns(db);
  assert.deepEqual(left.resume, []);
  assert.deepEqual(left.lost, [{ updateId: 502, chatId: 7, was: 'started' }]);
  assert.deepEqual(row(db, 502), { state: 'lost', body: null });
  assert.equal(startTurn(db, 502), false, 'and it can never start again');
  assert.deepEqual(recoverTurns(db).lost, [], 'nobody is told twice');
});

test('A: a queued message too old to answer late is dropped and reported, not run', () => {
  const db = freshDb();
  claimMessage(db, up(503), nowSec() - TURN_RECOVERY_MAX_AGE_SEC - 60);
  claimMessage(db, up(504, 'recent'));
  const left = recoverTurns(db);
  assert.deepEqual(left.resume.map((m) => m.__update_id), [504]);
  assert.deepEqual(left.lost, [{ updateId: 503, chatId: 7, was: 'queued' }]);
  assert.equal(row(db, 503).state, 'lost');
});

test('A: rows written before migration 017 (state NULL) are left alone', () => {
  const db = freshDb();
  db.prepare('INSERT INTO tg_updates (update_id, claimed_at) VALUES (?,?)').run(500, nowSec());
  assert.deepEqual(recoverTurns(db), { resume: [], lost: [] });
});

// ---- B. the paid user is told --------------------------------------------------------------------

async function paidInvoice(db, chatId = 7) {
  const tgFake = { call: async () => ({ ok: true, result: true }) };
  const r = await sendStarsInvoice({ db, tg: tgFake }, { chatId, settings: { ...DEFAULT_SETTINGS }, index: 0 });
  const inv = db.prepare('SELECT * FROM stars_invoices WHERE payload = ?').get(r.payload);
  return { currency: 'XTR', total_amount: inv.stars, invoice_payload: r.payload, telegram_payment_charge_id: `ch_${inv.id}` };
}
const paidTexts = (tg) => tg.sent.filter((s) => s.kind === 'message' && /Paid/.test(s.text));

test('B: credit, crash before the claim, redelivery -- the user gets "✅ Paid", not "already credited"', async () => {
  const db = freshDb();
  const sp = await paidInvoice(db);
  assert.ok(creditStarsPayment(db, { chatId: 7, sp }).credited);   // ... and the process dies here
  // Redelivery: the same shape bot.mjs uses (handleStarsPaid answers with the charge id).
  const credit = (m) => { const r = creditStarsPayment(db, { chatId: m.chat.id, sp: m.successful_payment }); return { chargeId: r.credited || r.duplicate ? sp.telegram_payment_charge_id : null }; };
  const taken = takePaymentUpdate(db, { update_id: 77, message: { chat: { id: 7 }, successful_payment: sp } }, credit, new Map());
  assert.equal(taken.outcome, 'handled');
  const tg = fakeTg();
  assert.equal((await notifyStarsPaid({ db, tg }, taken.reply.chargeId)).sent, true);
  const told = paidTexts(tg);
  assert.equal(told.length, 1);
  assert.match(told[0].text, /Paid <b>250 ⭐<\/b>/);
  assert.ok(!tg.sent.some((s) => /already credited/.test(s.text ?? '')));
});

test('B: claimed but the reply never sent -- the sweep sends "✅ Paid" exactly once', async () => {
  const db = freshDb();
  const sp = await paidInvoice(db);
  creditThenClaim(db, { update_id: 78, message: { chat: { id: 7 }, successful_payment: sp } }, (m) => creditStarsPayment(db, { chatId: 7, sp: m.successful_payment }));
  // ... and the process dies before the reply. The sweep leaves a fresh payment to its delivery:
  assert.deepEqual(unnotifiedPayments(db), []);
  const due = unnotifiedPayments(db, { now: nowSec() + 120 });
  assert.deepEqual(due, [sp.telegram_payment_charge_id]);
  const tg = fakeTg();
  for (const id of due) await notifyStarsPaid({ db, tg }, id);
  for (const id of unnotifiedPayments(db, { now: nowSec() + 240 })) await notifyStarsPaid({ db, tg }, id);
  assert.equal(paidTexts(tg).length, 1, 'once');
  assert.deepEqual(unnotifiedPayments(db, { now: nowSec() + 360 }), []);
});

test('B: a payment already announced, delivered again, gets no second "Paid"; a failed send is retried', async () => {
  const db = freshDb();
  const sp = await paidInvoice(db);
  creditStarsPayment(db, { chatId: 7, sp });
  const refusing = fakeTg({ fail: ['message'] });
  assert.equal((await notifyStarsPaid({ db, tg: refusing }, sp.telegram_payment_charge_id)).sent, false);
  assert.equal(db.prepare('SELECT notified_at FROM stars_payments').get().notified_at, null, 'not told: still owed');
  const tg = fakeTg();
  await notifyStarsPaid({ db, tg }, sp.telegram_payment_charge_id);
  assert.equal((await notifyStarsPaid({ db, tg }, sp.telegram_payment_charge_id)).skipped, 'notified');
  assert.equal(creditStarsPayment(db, { chatId: 7, sp }).duplicate, true);
  await notifyStarsPaid({ db, tg }, sp.telegram_payment_charge_id);
  assert.equal(paidTexts(tg).length, 1);
});

test('B: a user who blocked the bot is retried with backoff, not every 2 min; a timeout is not', async () => {
  const db = freshDb();
  const sp = await paidInvoice(db);
  creditStarsPayment(db, { chatId: 7, sp });
  const id = sp.telegram_payment_charge_id;
  const blocked = { sendMessage: async () => ({ ok: false, unknown: false, errorCode: 403, description: 'Forbidden: bot was blocked by the user' }) };
  const t0 = nowSec();
  const r1 = await notifyStarsPaid({ db, tg: blocked }, id, { now: () => t0 });
  assert.equal(r1.sent, false);
  assert.equal(r1.backoffSec, 240);
  assert.equal(db.prepare('SELECT notified_at FROM stars_payments').get().notified_at, null, 'not told: still owed');
  assert.deepEqual(unnotifiedPayments(db, { now: t0 + 120 }), [], 'the next 2-minute sweep skips it');
  assert.deepEqual(unnotifiedPayments(db, { now: t0 + 241 }), [id], 'due again after the backoff');
  const r2 = await notifyStarsPaid({ db, tg: blocked }, id, { now: () => t0 + 241 });
  assert.equal(r2.backoffSec, 480, 'doubles');
  for (let i = 0; i < 20; i++) await notifyStarsPaid({ db, tg: blocked }, id, { now: () => t0 });
  assert.equal((await notifyStarsPaid({ db, tg: blocked }, id, { now: () => t0 })).backoffSec, 86_400, 'capped at a day');
  // They unblock: the "Paid" goes out and the backoff is cleared.
  const tg = fakeTg();
  assert.equal((await notifyStarsPaid({ db, tg }, id)).sent, true);
  assert.equal(paidTexts(tg).length, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM kv WHERE k LIKE 'stars:notify-backoff:%'").get().n, 0);
  // A timeout is not "blocked": no backoff, the 2-minute sweep keeps trying.
  const db2 = freshDb();
  const sp2 = await paidInvoice(db2);
  creditStarsPayment(db2, { chatId: 7, sp: sp2 });
  const slow = { sendMessage: async () => ({ ok: false, unknown: true, description: 'timeout' }) };
  assert.equal((await notifyStarsPaid({ db: db2, tg: slow }, sp2.telegram_payment_charge_id)).backoffSec, undefined);
  assert.deepEqual(unnotifiedPayments(db2, { now: nowSec() + 120 }), [sp2.telegram_payment_charge_id]);
});

test('B: two notices racing for the same payment send one message', async () => {
  const db = freshDb();
  const sp = await paidInvoice(db);
  creditStarsPayment(db, { chatId: 7, sp });
  const tg = fakeTg();
  const inFlight = new Set();
  await Promise.all([notifyStarsPaid({ db, tg }, sp.telegram_payment_charge_id, { inFlight }), notifyStarsPaid({ db, tg }, sp.telegram_payment_charge_id, { inFlight })]);
  assert.equal(paidTexts(tg).length, 1);
});

test('B: a payment refunded before it was announced is closed without a "Paid"', async () => {
  const db = freshDb();
  const sp = await paidInvoice(db);
  creditStarsPayment(db, { chatId: 7, sp });
  db.prepare("UPDATE stars_payments SET refund_state = 'done'").run();
  const tg = fakeTg();
  assert.equal((await notifyStarsPaid({ db, tg }, sp.telegram_payment_charge_id)).skipped, 'refunded');
  assert.equal(paidTexts(tg).length, 0);
  assert.deepEqual(unnotifiedPayments(db, { now: nowSec() + 999 }), []);
});

// ---- C. a shutdown drains ------------------------------------------------------------------------

test('C: a shutdown waits for running turns and starts none that are queued', async () => {
  const q = turnQueue(1);
  let finishRunning;
  const done = [];
  q.submit(() => new Promise((r) => { finishRunning = () => { done.push('running'); r(); }; }));
  q.submit(async () => { done.push('queued'); });
  await tick();
  const order = [];
  const stopped = gracefulStop({
    turns: q, log: quietLog, timeoutMs: 2000,
    stopIntake: () => order.push('intake stopped'),
    finalize: async () => order.push('finalized'),
  });
  await tick(20);
  assert.deepEqual(order, ['intake stopped'], 'still waiting for the running turn');
  finishRunning();
  const r = await stopped;
  assert.equal(r.drained, true);
  assert.deepEqual(done, ['running'], 'the queued one was not started: it is durable and runs after the restart');
  assert.deepEqual(order, ['intake stopped', 'finalized']);
});

test('C: a turn that will not finish does not hold the shutdown past its timeout', async () => {
  const q = turnQueue(2);
  q.track(new Promise(() => {}));
  const t0 = Date.now();
  let finalized = false;
  const r = await gracefulStop({ turns: q, log: quietLog, timeoutMs: 150, stopIntake() {}, finalize: async () => { finalized = true; } });
  assert.equal(r.drained, false);
  assert.ok(Date.now() - t0 < 1000, 'bounded');
  assert.equal(finalized, true, 'the heartbeat and the database are still closed');
});

test('C: SIGTERM runs the stop once and exits 0; a second signal exits 1 at once', async () => {
  const proc = new EventEmitter();
  const exits = [];
  let stops = 0;
  let release;
  installShutdown({ proc, log: quietLog, exit: (c) => exits.push(c), stop: () => { stops++; return new Promise((r) => { release = r; }); } });
  proc.emit('SIGTERM', 'SIGTERM');
  await tick();
  assert.equal(stops, 1);
  proc.emit('SIGINT', 'SIGINT');
  assert.deepEqual(exits, [1], 'the second signal does not wait');
  release();
  await tick();
  assert.equal(stops, 1, 'the stop ran once');
  assert.deepEqual(exits, [1, 0]);
});

// ---- F2. the payment retry limit, where a test can see it ----------------------------------------

test('F2: a credit that always throws is retried, then parked, and the next update is still handled', () => {
  const db = freshDb();
  const tries = new Map();
  const bad = { update_id: 900, message: { chat: { id: 7 }, successful_payment: { total_amount: 250, telegram_payment_charge_id: 'ch_bad' } } };
  const failing = () => { throw new Error('SQLITE_BUSY'); };
  const outcomes = [];
  for (let i = 0; i < PAYMENT_QUICK_TRIES; i++) outcomes.push(takePaymentUpdate(db, bad, failing, tries).outcome);
  assert.deepEqual(outcomes, [...Array(PAYMENT_QUICK_TRIES - 1).fill('retry'), 'parked']);
  assert.equal(parkedCount(db), 1);
  assert.equal(tries.size, 0);
  // The loop goes on: the next payment is handled.
  const good = { update_id: 901, message: { chat: { id: 7 }, successful_payment: { total_amount: 250, telegram_payment_charge_id: 'ch_ok' } } };
  const r = takePaymentUpdate(db, good, () => ({ chargeId: 'ch_ok' }), tries);
  assert.equal(r.outcome, 'handled');
  assert.equal(r.claimed, true);
  // A redelivery of the parked one does not start a second count: its claim was written with it.
  assert.equal(takePaymentUpdate(db, bad, () => ({ chargeId: 'ch_bad' }), tries).claimed, false);
});

test('F2: the heartbeat says ok:false while a Stars payment is parked', () => {
  const base = { processed: 1, offset: 10, inFlight: 0, waiting: 0, making: 0 };
  assert.equal(botHeartbeat({ ...base, starsParked: 0 }).ok, true);
  const hb = botHeartbeat({ ...base, starsParked: 2, starsBooks: { state: 'ok' } });
  assert.equal(hb.ok, false);
  assert.equal(hb.stars_parked, 2);
  assert.match(hb.last_error, /2 Stars payment/);
  assert.deepEqual(hb.stars_books, { state: 'ok' });
});
