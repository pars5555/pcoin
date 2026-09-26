// Telegram Stars top-ups (lib/stars.mjs) and the settings behind every admin section.
//
// Pinned: an invoice exists before it is sent; Telegram's last check refuses any payment that is
// not exactly the invoice we issued, to that user; a payment credits once per Telegram charge id,
// in one transaction, and the books still close; a refund never leaves the house paying twice.

import test from 'node:test';
import assert from 'node:assert/strict';

import { nowSec, assertSchema } from '../lib/db.mjs';
import { reconcile } from '../lib/deposits.mjs';
import {
  packages, sendStarsInvoice, checkPreCheckout, creditStarsPayment, expireInvoices, refundStarsPayment,
  RefundRefused, starsReport, usdMicro,
} from '../lib/stars.mjs';
import { DEFAULT_SETTINGS, settingsProblems, mergeSettingsInput } from '../lib/settings.mjs';
import { systemPrompt, buildRequest, DEFAULT_CHAT_PROMPT } from '../lib/studio.mjs';
import { freshDb, fakeTg, user, OFFER, MARGIN_E6 } from './fixtures.mjs';

const S = { ...DEFAULT_SETTINGS };
const tgWith = (answers = {}) => {
  const calls = [];
  return {
    calls,
    call: async (method, params) => { calls.push({ method, params }); return answers[method] ?? { ok: true, result: true }; },
  };
};
async function paidInvoice(db, tg, { chatId = 7, index = 0 } = {}) {
  const r = await sendStarsInvoice({ db, tg }, { chatId, settings: S, index });
  const inv = db.prepare('SELECT * FROM stars_invoices WHERE payload = ?').get(r.payload);
  return { payload: r.payload, inv, sp: { currency: 'XTR', total_amount: inv.stars, invoice_payload: r.payload, telegram_payment_charge_id: `ch_${inv.id}` } };
}

test('migration 014 keeps the ledger\'s unique key and accepts Stars deposits', () => {
  const db = freshDb();
  assertSchema(db);
  db.prepare(`INSERT INTO ledger (chat_id, delta_micro_usd, kind, idem_key, created_at) VALUES (7, 1, 'deposit_stars', 'stars:x', ?)`).run(nowSec());
  assert.throws(() => db.prepare(`INSERT INTO ledger (chat_id, delta_micro_usd, kind, idem_key, created_at) VALUES (7, 1, 'deposit_stars', 'stars:x', ?)`).run(nowSec()), /UNIQUE/);
  assert.throws(() => db.prepare(`INSERT INTO ledger (chat_id, delta_micro_usd, kind, created_at) VALUES (7, 1, 'bogus', ?)`).run(nowSec()), /CHECK/);
});

test('packages: webbuilderbot\'s four by default, none when switched off', () => {
  assert.deepEqual(packages(S).map((p) => [p.stars, Number(p.micro)]), [[250, 5e6], [500, 10e6], [1250, 25e6], [2500, 50e6]]);
  assert.deepEqual(packages({ ...S, starsEnabled: false }), []);
  assert.equal(usdMicro(2.5), 2500000n);
});

test('the invoice is written before it is sent, in Stars, with no provider token', async () => {
  const db = freshDb();
  const tg = tgWith();
  const r = await sendStarsInvoice({ db, tg }, { chatId: 7, settings: S, index: 1 });
  assert.equal(r.ok, true);
  const p = tg.calls[0].params;
  assert.equal(tg.calls[0].method, 'sendInvoice');
  assert.equal(p.currency, 'XTR');
  assert.equal(p.provider_token, '');
  assert.deepEqual(p.prices, [{ label: 'Top up $10.00', amount: 500 }]);
  assert.equal(db.prepare('SELECT state, stars, micro_usd FROM stars_invoices WHERE payload = ?').get(p.payload).micro_usd, 10e6);
  assert.equal((await sendStarsInvoice({ db, tg }, { chatId: 7, settings: S, index: 9 })).ok, false, 'a stale package index');
  const failing = tgWith({ sendInvoice: { ok: false, description: 'Bad Request' } });
  const f = await sendStarsInvoice({ db, tg: failing }, { chatId: 7, settings: S, index: 0 });
  assert.equal(f.ok, false);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM stars_invoices WHERE state = 'pending'").get().n, 1, 'an invoice Telegram refused is not left payable');
});

test('Telegram\'s last check: only exactly the invoice we issued, to that user, still fresh', async () => {
  const db = freshDb({ chats: [7, 8] });
  const { payload, inv } = await paidInvoice(db, tgWith());
  const q = (over = {}) => ({ invoice_payload: payload, from: { id: 7 }, currency: 'XTR', total_amount: inv.stars, ...over });
  assert.deepEqual(checkPreCheckout(db, q()), { ok: true });
  assert.match(checkPreCheckout(db, q({ invoice_payload: 'stars:7:1:dead' })).error, /not started here/);
  assert.match(checkPreCheckout(db, q({ from: { id: 8 } })).error, /another account/);
  assert.match(checkPreCheckout(db, q({ total_amount: 1 })).error, /amount does not match/);
  assert.match(checkPreCheckout(db, q({ currency: 'USD' })).error, /amount does not match/);
  assert.match(checkPreCheckout(db, q(), nowSec() + 90000).error, /expired/);
  db.prepare("UPDATE stars_invoices SET state = 'paid' WHERE id = ?").run(inv.id);
  assert.match(checkPreCheckout(db, q()).error, /already used/);
});

test('a payment credits once per Telegram charge id, and the books close', async () => {
  const db = freshDb({ balanceMicro: 0 });
  const { sp } = await paidInvoice(db, tgWith());
  const r = creditStarsPayment(db, { chatId: 7, sp });
  assert.equal(r.credited, true);
  assert.equal(r.micro, 5000000n);
  assert.equal(r.balance, 5000000, 'the new balance, counted once (webbuilderbot counted it twice)');
  assert.equal(creditStarsPayment(db, { chatId: 7, sp }).duplicate, true);
  assert.equal(user(db).b, 5000000);
  const led = db.prepare("SELECT * FROM ledger WHERE kind = 'deposit_stars'").all();
  assert.equal(led.length, 1);
  assert.equal(led[0].idem_key, `stars:${sp.telegram_payment_charge_id}`);
  assert.equal(db.prepare('SELECT state FROM stars_invoices').get().state, 'paid');
  assert.equal(reconcile(db).ok, true);
});

test('a payment that does not match its invoice is not credited (and says why)', async () => {
  const db = freshDb({ chats: [7, 8], balanceMicro: 0 });
  const { sp } = await paidInvoice(db, tgWith());
  assert.match(creditStarsPayment(db, { chatId: 8, sp }).refused, /another chat/);
  assert.match(creditStarsPayment(db, { chatId: 7, sp: { ...sp, total_amount: 1 } }).refused, /paid 1 XTR/);
  assert.match(creditStarsPayment(db, { chatId: 7, sp: { ...sp, invoice_payload: 'nope' } }).refused, /no invoice/);
  assert.match(creditStarsPayment(db, { chatId: 7, sp: { ...sp, telegram_payment_charge_id: '' } }).refused, /no telegram_payment_charge_id/);
  assert.equal(user(db, 7).b, 0);
  assert.equal(reconcile(db).ok, true);
});

test('a refund: Telegram first, then the credit comes off -- never once it is spent', async () => {
  const db = freshDb({ balanceMicro: 0 });
  const { sp } = await paidInvoice(db, tgWith());
  creditStarsPayment(db, { chatId: 7, sp });
  const pay = db.prepare('SELECT * FROM stars_payments').get();

  const refusing = tgWith({ refundStarPayment: { ok: false, description: 'CHARGE_ALREADY_REFUNDED' } });
  await assert.rejects(refundStarsPayment({ db, tg: refusing }, { paymentId: pay.id }), (e) => e instanceof RefundRefused && /Telegram refused/.test(e.message));
  assert.equal(user(db).b, 5000000, 'Telegram said no: nothing changed');

  const tg = tgWith();
  const r = await refundStarsPayment({ db, tg }, { paymentId: pay.id, note: 'asked by the user' });
  assert.deepEqual(tg.calls[0], { method: 'refundStarPayment', params: { user_id: 7, telegram_payment_charge_id: sp.telegram_payment_charge_id } });
  assert.equal(r.stars, 250);
  assert.equal(user(db).b, 0);
  assert.ok(db.prepare('SELECT refunded_at FROM stars_payments').get().refunded_at);
  assert.equal(reconcile(db).ok, true);
  await assert.rejects(refundStarsPayment({ db, tg }, { paymentId: pay.id }), /already refunded/);

  const db2 = freshDb({ balanceMicro: 0 });
  const p2 = await paidInvoice(db2, tgWith());
  creditStarsPayment(db2, { chatId: 7, sp: p2.sp });
  db2.prepare('UPDATE users SET balance_micro_usd = 1000000 WHERE chat_id = 7').run(); // spent most of it
  const tg2 = tgWith();
  await assert.rejects(refundStarsPayment({ db: db2, tg: tg2 }, { paymentId: 1 }), /has been spent/);
  assert.equal(tg2.calls.length, 0, 'Telegram is not even asked');
});

test('unpaid invoices expire after a day', async () => {
  const db = freshDb();
  await paidInvoice(db, tgWith());
  assert.equal(expireInvoices(db), 0);
  assert.equal(expireInvoices(db, nowSec() + 90000), 1);
});

test('Telegram\'s books: received, matured past the 21-day hold, next unlock', async () => {
  const now = 2_000_000_000;
  const tg = tgWith({
    getMyStarBalance: { ok: true, result: { amount: 750 } },
    getStarTransactions: { ok: true, result: { transactions: [
      { id: 'a', amount: 250, date: now - 30 * 86400, source: { type: 'user', user: { id: 7 }, invoice_payload: 'p1' } },
      { id: 'b', amount: 500, date: now - 2 * 86400, source: { type: 'user', user: { id: 7 }, invoice_payload: 'p2' } },
    ] } },
  });
  const r = await starsReport(tg, { now });
  assert.equal(r.balance, 750);
  assert.equal(r.incomingStars, 750);
  assert.equal(r.maturedStars, 250);
  assert.equal(r.nextUnlockAt, now - 2 * 86400 + 21 * 86400);
});

test('settings: every section validated; a form becomes typed settings; reset returns to the built-in instructions', () => {
  const ok = settingsProblems(DEFAULT_SETTINGS, { offer: OFFER, chatChoices: ['mimo-v2.5'] });
  assert.deepEqual(ok, []);
  const bad = settingsProblems({ ...DEFAULT_SETTINGS, chatPerHour: 0, chatMaxChars: 5, historyMax: 1, margin: 0.5, cardTtlHours: 0,
    starsPackages: [{ usd: 0.1, stars: 5 }, { usd: 5, stars: 1.5 }], paySupportText: ' ' }, { offer: OFFER, chatChoices: ['mimo-v2.5'] });
  assert.equal(bad.length, 8, bad.join(' | '));
  assert.match(settingsProblems({ ...DEFAULT_SETTINGS, starsPackages: [] }, { offer: OFFER, chatChoices: ['mimo-v2.5'] }).join(), /no package/);

  const m = mergeSettingsInput(DEFAULT_SETTINGS, { chatPerHour: '60', margin: '2.5', starsEnabled: 'on', starsPackages: [{ usd: '1', stars: '50' }], junk: 'x' });
  assert.equal(m.chatPerHour, 60);
  assert.equal(m.margin, 2.5);
  assert.deepEqual(m.starsPackages, [{ usd: 1, stars: 50 }]);
  assert.equal(m.junk, undefined);
  assert.equal(mergeSettingsInput({ ...DEFAULT_SETTINGS, chatPrompt: 'custom' }, { chatPromptReset: true }).chatPrompt, '');
  assert.equal(mergeSettingsInput({ ...DEFAULT_SETTINGS, chatPrompt: 'custom' }, { chatModel: 'x' }).chatPrompt, 'custom', 'a field left out keeps its value');
});

test('the admin\'s instructions replace the built-in ones -- and the live context is still added after them', () => {
  const db = freshDb();
  const s = systemPrompt({ instructions: 'Only draw cats.', prices: ['a picture costs $0.27'], balanceMicro: 1000000n, latest: 'a dog' });
  assert.match(s, /^Only draw cats\./);
  assert.doesNotMatch(s, /HOW IT WORKS/);
  assert.match(s, /==== CONTEXT/);
  assert.match(s, /PRICES: a picture costs \$0\.27\./);
  assert.match(s, /THE USER'S LATEST MESSAGE: "a dog"/);
  const req = buildRequest({ db, settings: { ...DEFAULT_SETTINGS, chatPrompt: 'Be brief.' }, offer: OFFER, marginE6: MARGIN_E6, balanceMicro: 0n }, { chatId: 7, userContent: 'hello' });
  assert.match(req.body.system, /^Be brief\./);
  const dflt = buildRequest({ db, settings: DEFAULT_SETTINGS, offer: OFFER, marginE6: MARGIN_E6, balanceMicro: 0n }, { chatId: 7, userContent: 'hello' });
  assert.ok(dflt.body.system.startsWith(DEFAULT_CHAT_PROMPT));
});
