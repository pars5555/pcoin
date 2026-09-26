// Payment safety (review of 2026-09-26, migration 016).
//
// Pinned:
//   * a Stars credit runs BEFORE its update is claimed: a failure claims nothing, a redelivery
//     credits again (idempotently) instead of being skipped;
//   * a Stars refund takes the money off FIRST: a ✅ during Telegram's answer cannot spend it, a
//     refusal puts it back, no answer leaves it off until asked again, two refunds at once deduct once;
//   * a refund cannot undo the top-up an invite reward was paid for, unless the reward is taken back;
//   * the welcome gift's daily cap holds, per UTC day;
//   * a pasted wPCN hash is asked about again until the answer is final.
import test from 'node:test';
import assert from 'node:assert/strict';

import { reconcile } from '../lib/deposits.mjs';
import { sendStarsInvoice, creditStarsPayment, refundStarsPayment, RefundRefused } from '../lib/stars.mjs';
import { reserve, InsufficientFunds } from '../lib/billing.mjs';
import { openAccount, payInviteReward, usdToMicro, giftsToday } from '../lib/rewards.mjs';
import { STATE, FINAL_STATES, CHECK_MAX_AGE_SEC, recordCheck, noteCheck, dueChecks } from '../lib/wpcn.mjs';
import { creditThenClaim } from '../lib/updates.mjs';
import { turnQueue } from '../lib/turns.mjs';
import { DEFAULT_SETTINGS } from '../lib/settings.mjs';
import { freshDb } from './fixtures.mjs';

const S = { ...DEFAULT_SETTINGS };
const bal = (db, c = 7) => db.prepare('SELECT balance_micro_usd b FROM users WHERE chat_id = ?').get(c).b;
const refundState = (db, id) => db.prepare('SELECT refund_state s FROM stars_payments WHERE id = ?').get(id).s;
const deductions = (db) => db.prepare("SELECT COUNT(*) n FROM ledger WHERE idem_key LIKE 'stars-refund:%' AND idem_key NOT LIKE '%:undo'").get().n;

// Telegram, answering per method; a function answer is awaited, which lets a test hold a call open.
function tgFake(answers = {}) {
  const calls = [];
  return {
    calls,
    call: async (method, params) => {
      calls.push({ method, params });
      const a = answers[method];
      return typeof a === 'function' ? a(params) : (a ?? { ok: true, result: true });
    },
  };
}

// A $5 Stars top-up, credited. Returns the stars_payments row.
async function starsTopUp(db, chatId = 7) {
  const r = await sendStarsInvoice({ db, tg: tgFake() }, { chatId, settings: S, index: 0 });
  const inv = db.prepare('SELECT * FROM stars_invoices WHERE payload = ?').get(r.payload);
  const sp = { currency: 'XTR', total_amount: inv.stars, invoice_payload: r.payload, telegram_payment_charge_id: `ch_${inv.id}` };
  assert.ok(creditStarsPayment(db, { chatId, sp }).credited);
  return db.prepare('SELECT * FROM stars_payments WHERE charge_id = ?').get(sp.telegram_payment_charge_id);
}

// ---- Stars: credit before claim ----------------------------------------------------------------

test('a Stars credit runs before its update is claimed; a failure claims nothing, a redelivery credits again', () => {
  const db = freshDb();
  const up = { update_id: 99, message: { chat: { id: 7 } } };
  assert.throws(() => creditThenClaim(db, up, () => { throw new Error('database is locked'); }), /locked/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM tg_updates WHERE update_id = 99').get().n, 0, 'not claimed: it will be fetched again');

  let runs = 0;
  const a = creditThenClaim(db, up, () => { runs++; return 'credited'; });
  assert.deepEqual(a, { reply: 'credited', claimed: true });
  // Telegram delivers it again after a restart: the credit RUNS again (the charge id makes it a
  // no-op) instead of being skipped, and nobody is answered twice.
  const b = creditThenClaim(db, up, () => { runs++; return 'already credited'; });
  assert.equal(b.claimed, false);
  assert.equal(runs, 2);
});

test('a full set of slots queues the next turn instead of holding the poll loop', async () => {
  const q = turnQueue(2);
  let releaseA;
  let releaseB;
  q.track(new Promise((r) => { releaseA = r; }));   // a button's background work
  q.submit(() => new Promise((r) => { releaseB = r; }));
  await new Promise((r) => setImmediate(r));
  assert.equal(q.running.size, 2, 'both slots taken');

  const started = [];
  const t0 = Date.now();
  q.submit(async () => { started.push('c'); });
  q.submit(async () => { started.push('d'); });
  assert.ok(Date.now() - t0 < 50, 'submit returned at once: a pre-checkout behind it is answered now');
  assert.equal(q.waiting.length, 2);
  assert.deepEqual(started, []);

  releaseA();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(started, ['c', 'd'], 'in arrival order, as slots free up');
  assert.equal(q.waiting.length, 0);
  releaseB();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(q.running.size, 0);

  // A turn that throws still frees its slot.
  q.submit(async () => { throw new Error('boom'); });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(q.running.size, 0);
});

// ---- Stars: refunds ----------------------------------------------------------------------------

test('a ✅ pressed while Telegram is refunding cannot spend the money being refunded', async () => {
  const db = freshDb({ balanceMicro: 0 });
  const pay = await starsTopUp(db);
  let answer;
  const tg = tgFake({ refundStarPayment: () => new Promise((r) => { answer = r; }) });
  const refund = refundStarsPayment({ db, tg }, { paymentId: pay.id });
  await new Promise((r) => setImmediate(r));

  assert.equal(bal(db), 0, 'the credit is off before Telegram answers');
  assert.equal(refundState(db, pay.id), 'pending');
  assert.throws(() => reserve(db, { chatId: 7, reqKey: 'proposal:1', model: 'm', microUsd: 2_520_000n }), InsufficientFunds);

  answer({ ok: true, result: true });
  const r = await refund;
  assert.equal(r.ok, true);
  assert.equal(bal(db), 0, 'never negative');
  assert.equal(refundState(db, pay.id), 'done');
  assert.ok(db.prepare('SELECT refunded_at FROM stars_payments WHERE id = ?').get(pay.id).refunded_at);
  assert.ok(reconcile(db).ok);
});

test('money set aside for something being made is not refundable; Telegram is not even asked', async () => {
  const db = freshDb({ balanceMicro: 0 });
  const pay = await starsTopUp(db);
  reserve(db, { chatId: 7, reqKey: 'proposal:1', model: 'm', microUsd: 2_520_000n });
  const tg = tgFake();
  await assert.rejects(refundStarsPayment({ db, tg }, { paymentId: pay.id }), (e) => e instanceof RefundRefused && /set aside/.test(e.message));
  assert.equal(tg.calls.length, 0);
  assert.equal(bal(db), 2_480_000);
});

test('no answer from Telegram keeps the credit off; asking again settles it without a second deduction', async () => {
  const db = freshDb({ balanceMicro: 0 });
  const pay = await starsTopUp(db);
  const silent = tgFake({ refundStarPayment: { ok: false, unknown: true, description: 'timeout' } });
  await assert.rejects(refundStarsPayment({ db, tg: silent }, { paymentId: pay.id }), /did not answer/);
  assert.equal(bal(db), 0, 'the refund may have happened: the credit stays off');
  assert.equal(refundState(db, pay.id), 'pending');
  assert.ok(reconcile(db).ok);

  // Telegram had in fact refunded it.
  const tg = tgFake({ refundStarPayment: { ok: false, unknown: false, description: 'Bad Request: CHARGE_ALREADY_REFUNDED' } });
  const r = await refundStarsPayment({ db, tg }, { paymentId: pay.id });
  assert.equal(r.ok, true);
  assert.equal(refundState(db, pay.id), 'done');
  assert.equal(deductions(db), 1, 'asked twice, deducted once');
  assert.equal(bal(db), 0);
  await assert.rejects(refundStarsPayment({ db, tg }, { paymentId: pay.id }), /already refunded/);
});

test('a refusal puts the money back, and the payment can be refunded again later', async () => {
  const db = freshDb({ balanceMicro: 0 });
  const pay = await starsTopUp(db);
  const refusing = tgFake({ refundStarPayment: { ok: false, unknown: false, description: 'Bad Request: CHARGE_NOT_FOUND' } });
  await assert.rejects(refundStarsPayment({ db, tg: refusing }, { paymentId: pay.id }), /put back/);
  assert.equal(bal(db), 5_000_000);
  const r = await refundStarsPayment({ db, tg: tgFake() }, { paymentId: pay.id });
  assert.equal(r.ok, true);
  assert.equal(bal(db), 0);
  const keys = db.prepare("SELECT idem_key FROM ledger WHERE idem_key LIKE 'stars-refund:%' ORDER BY id").all().map((x) => x.idem_key);
  assert.deepEqual(keys, [`stars-refund:${pay.charge_id}:1`, `stars-refund:${pay.charge_id}:1:undo`, `stars-refund:${pay.charge_id}:2`]);
  assert.ok(reconcile(db).ok);
});

test('two refunds of the same payment at once take the money off once', async () => {
  const db = freshDb({ balanceMicro: 0 });
  const pay = await starsTopUp(db);
  let n = 0;
  const tg = tgFake({
    refundStarPayment: async () => {
      const mine = ++n;
      await new Promise((r) => setTimeout(r, 10));
      return mine === 1 ? { ok: true, result: true } : { ok: false, unknown: false, description: 'Bad Request: CHARGE_ALREADY_REFUNDED' };
    },
  });
  const [a, b] = await Promise.all([
    refundStarsPayment({ db, tg }, { paymentId: pay.id }),
    refundStarsPayment({ db, tg }, { paymentId: pay.id }),
  ]);
  assert.equal(a.ok && b.ok, true);
  assert.equal(bal(db), 0, 'not −$5');
  assert.equal(deductions(db), 1);
  assert.ok(reconcile(db).ok);
});

// ---- the invite loophole -----------------------------------------------------------------------

async function invitedAndRewarded() {
  const db = freshDb({ balanceMicro: 0, chats: [] });
  openAccount(db, { chatId: 1, model: 'studio', giftMicro: usdToMicro(3) });
  openAccount(db, { chatId: 7, model: 'studio', giftMicro: usdToMicro(3), invitedBy: 1 });
  const pay = await starsTopUp(db, 7);
  const paid = payInviteReward(db, { referredId: 7, rewardMicro: usdToMicro(2), minTopupMicro: usdToMicro(1) });
  assert.equal(paid.paid, true);
  return { db, pay };
}

test('the invite reward stamps the top-up it required', async () => {
  const { db } = await invitedAndRewarded();
  assert.equal(db.prepare('SELECT min_topup_micro_usd m FROM referrals WHERE referred_chat_id = 7').get().m, 1_000_000);
});

test('refunding the top-up an invite reward was paid for is refused -- unless the reward is taken back', async () => {
  const { db, pay } = await invitedAndRewarded();
  const tg = tgFake();
  await assert.rejects(refundStarsPayment({ db, tg }, { paymentId: pay.id }), (e) => e instanceof RefundRefused && /invited by 1/.test(e.message));
  assert.equal(tg.calls.length, 0, 'Telegram is not asked');
  assert.equal(bal(db, 7), 8_000_000, 'nothing moved');

  const r = await refundStarsPayment({ db, tg }, { paymentId: pay.id, clawback: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.clawback, { inviter: 1, micro: 2_000_000n });
  assert.equal(bal(db, 7), 3_000_000, 'the gift is left');
  assert.equal(bal(db, 1), 3_000_000, '$3 gift + $2 reward − $2 taken back');
  const ref = db.prepare('SELECT status, void_reason FROM referrals WHERE referred_chat_id = 7').get();
  assert.equal(ref.status, 'void');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM ledger WHERE idem_key = 'referral-clawback:7'").get().n, 1);
  assert.ok(reconcile(db).ok);
});

test('a refund Telegram refuses does not take the reward back', async () => {
  const { db, pay } = await invitedAndRewarded();
  const refusing = tgFake({ refundStarPayment: { ok: false, unknown: false, description: 'Bad Request: CHARGE_NOT_FOUND' } });
  await assert.rejects(refundStarsPayment({ db, tg: refusing }, { paymentId: pay.id, clawback: true }), /refused/);
  assert.equal(bal(db, 1), 5_000_000, 'the inviter keeps it');
  assert.equal(bal(db, 7), 8_000_000);
  assert.equal(db.prepare('SELECT status FROM referrals WHERE referred_chat_id = 7').get().status, 'rewarded');
  assert.ok(reconcile(db).ok);
});

test('a refund that leaves enough paid in for the reward goes through as usual', async () => {
  const { db, pay } = await invitedAndRewarded();
  await starsTopUp(db, 7); // a second $5
  const r = await refundStarsPayment({ db, tg: tgFake() }, { paymentId: pay.id });
  assert.equal(r.ok, true);
  assert.equal(r.clawback, null);
  assert.equal(bal(db, 1), 5_000_000);
});

// ---- the welcome gift's daily cap --------------------------------------------------------------

test('the welcome gift stops at the daily cap and starts again the next UTC day', () => {
  const db = freshDb({ balanceMicro: 0, chats: [] });
  const day = 86400 * 20700;
  const open = (chatId, now) => openAccount(db, { chatId, model: 'studio', giftMicro: usdToMicro(3), giftCapMicro: usdToMicro(6), now });
  assert.equal(open(1, day + 60).giftMicro, 3_000_000n);
  assert.equal(open(2, day + 120).giftMicro, 3_000_000n);
  const third = open(3, day + 180);
  assert.equal(third.giftMicro, 0n);
  assert.equal(third.capped, true);
  assert.equal(bal(db, 3), 0);
  assert.equal(giftsToday(db, day + 200), 6_000_000n);
  assert.equal(open(4, day + 86400 + 5).giftMicro, 3_000_000n, 'a new day');
  // No cap at all when it is 0.
  for (let c = 10; c < 20; c++) assert.equal(openAccount(db, { chatId: c, model: 'studio', giftMicro: usdToMicro(3), now: day + 86400 * 3 }).giftMicro, 3_000_000n);
  assert.ok(reconcile(db).ok);
});

// ---- pasted wPCN hashes ------------------------------------------------------------------------

test('a pasted wPCN hash is asked about again until the answer is final', () => {
  const db = freshDb();
  const t0 = 1_790_000_000;
  const h = `0x${'ab'.repeat(32)}`;
  assert.equal(recordCheck(db, 7, `0x${'AB'.repeat(32)}`, t0), h, 'stored lower-case');
  assert.equal(dueChecks(db, t0 + 10).length, 0, 'its own message is still answering it');
  assert.equal(dueChecks(db, t0 + 31).length, 1, 'never answered (a restart): asked again');

  noteCheck(db, 7, h, STATE.CONFIRMING, t0 + 31);
  assert.equal(dueChecks(db, t0 + 60).length, 0);
  assert.equal(dueChecks(db, t0 + 87).length, 1, 'a minute later');

  noteCheck(db, 7, h, STATE.CREDITED, t0 + 87);
  assert.equal(dueChecks(db, t0 + 999).length, 0, 'final');
  recordCheck(db, 7, h, t0 + 1000);
  assert.equal(db.prepare('SELECT done_at FROM wpcn_checks').get().done_at, null, 'pasting it again opens it again');

  for (const s of [STATE.CREDITED, STATE.ALREADY_CLAIMED, STATE.NO_PAYMENT, STATE.REVERTED]) assert.ok(FINAL_STATES.has(s), s);
  for (const s of [STATE.PENDING, STATE.CONFIRMING, STATE.UNREADABLE, STATE.REORGED]) assert.ok(!FINAL_STATES.has(s), s);
});

test('a pasted hash is given up on after six hours', () => {
  const db = freshDb();
  const t0 = 1_790_000_000;
  recordCheck(db, 7, `0x${'cd'.repeat(32)}`, t0);
  assert.equal(dueChecks(db, t0 + CHECK_MAX_AGE_SEC + 1).length, 0);
  assert.equal(db.prepare('SELECT last_state FROM wpcn_checks').get().last_state, 'expired');
});
