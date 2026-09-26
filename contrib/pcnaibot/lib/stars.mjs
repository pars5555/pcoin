// Telegram Stars top-ups (owner, 2026-09-26: "add telegram stars payment similar to webbuilderbot").
//
// webbuilderbot's shape: fixed packages ($5 = 250 ⭐ ...), an invoice row written BEFORE sendInvoice,
// the pre-checkout answer checked against that row, the balance credited on successful_payment.
// Three things done differently, each a bug there:
//   * the credit is keyed on Telegram's own telegram_payment_charge_id (UNIQUE), not our payload;
//   * the invoice update, the payment row, the ledger row and the balance move in ONE transaction;
//   * the pre-checkout also checks the payer, the currency and the amount, not only that the
//     payload exists.
// And one thing it lacks: a refund (refundStarPayment), from the admin page, only while the user
// still has the money it credited.
//
// Stars are credited as USD at the package's price. The Stars themselves are the bot owner's on
// Telegram (withdrawable after Telegram's 21-day hold); nothing here touches PCN.

import { immediate } from './db.mjs';
import { nowSec } from './time.mjs';
import { log, chatTag } from './log.mjs';
import { t, langOf } from './i18n.mjs';
import { randomBytes } from 'node:crypto';

export const INVOICE_TTL_SEC = 24 * 3600;
export const HOLD_DAYS = 21;               // Telegram's hold before Stars can be withdrawn
export const WITHDRAW_MIN_STARS = 1000;    // Telegram's minimum withdrawal

export const usdMicro = (usd) => BigInt(Math.round(Number(usd) * 100)) * 10000n;
const usdLabel = (micro) => `$${(Number(micro) / 1e6).toFixed(2)}`;

// The packages on sale, as the admin set them.
export function packages(settings) {
  if (!settings.starsEnabled) return [];
  return (settings.starsPackages ?? []).map((p, i) => ({ index: i, usd: p.usd, stars: p.stars, micro: usdMicro(p.usd) }));
}

export const packageButtonText = (p) => `⭐ ${p.stars} → ${usdLabel(p.micro)}`;

// Write the invoice, then send it. A package index from a stale keyboard is refused.
export async function sendStarsInvoice({ db, tg }, { chatId, settings, index, now = nowSec() }) {
  const lang = langOf(db, chatId);
  const p = packages(settings)[index];
  if (!p) return { ok: false, text: t(lang, 'stars.pkg_gone', { topup: t(lang, 'kb.topup') }) };
  const payload = `stars:${chatId}:${now}:${randomBytes(4).toString('hex')}`;
  db.prepare(
    `INSERT INTO stars_invoices (chat_id, payload, stars, micro_usd, state, created_at) VALUES (?,?,?,?, 'pending', ?)`
  ).run(chatId, payload, p.stars, Number(p.micro), now);
  const title = t(lang, 'stars.inv_title', { usd: usdLabel(p.micro) });
  const r = await tg.call('sendInvoice', {
    chat_id: chatId,
    title,
    description: t(lang, 'stars.inv_desc', { usd: usdLabel(p.micro) }),
    payload,
    provider_token: '',
    currency: 'XTR',
    prices: [{ label: title, amount: p.stars }],
  });
  if (!r.ok) {
    log.warn('sendInvoice failed', { chat: chatTag(chatId), desc: r.description ?? null });
    db.prepare("UPDATE stars_invoices SET state = 'expired' WHERE payload = ? AND state = 'pending'").run(payload);
    return { ok: false, text: t(lang, 'stars.start_failed') };
  }
  return { ok: true, payload };
}

// Telegram's last check before it takes the Stars; it must be answered within 10 seconds, so this
// is a synchronous look-up. Returns { ok } or { ok: false, error } for answerPreCheckoutQuery.
export function checkPreCheckout(db, q, now = nowSec()) {
  // In the PAYER's language: this text is shown to them by Telegram.
  const lang = langOf(db, Number(q?.from?.id));
  const no = (key) => ({ ok: false, error: t(lang, key, { topup: t(lang, 'kb.topup') }) });
  const inv = db.prepare('SELECT * FROM stars_invoices WHERE payload = ?').get(String(q?.invoice_payload ?? ''));
  if (!inv) return no('pc.not_here');
  if (inv.state !== 'pending') return no('pc.used');
  if (now - inv.created_at > INVOICE_TTL_SEC) return no('pc.expired');
  if (Number(q?.from?.id) !== inv.chat_id) return no('pc.other_account');
  if (q?.currency !== 'XTR' || Number(q?.total_amount) !== inv.stars) return no('pc.amount');
  return { ok: true };
}

// successful_payment: credit ONCE, in one transaction. Returns
//   { credited: true, micro, stars, balance }  |  { duplicate: true, balance }  |  { refused: why }
// A refusal is logged loudly: Telegram has taken the Stars, and the admin must see why no credit.
export function creditStarsPayment(db, { chatId, sp, now = nowSec() }) {
  const chargeId = String(sp?.telegram_payment_charge_id ?? '');
  if (!chargeId) return { refused: 'no telegram_payment_charge_id' };
  return immediate(db, () => {
    const prior = db.prepare('SELECT * FROM stars_payments WHERE charge_id = ?').get(chargeId);
    const bal = () => db.prepare('SELECT balance_micro_usd b FROM users WHERE chat_id = ?').get(chatId)?.b ?? null;
    if (prior) return { duplicate: true, balance: bal() };
    const inv = db.prepare('SELECT * FROM stars_invoices WHERE payload = ?').get(String(sp.invoice_payload ?? ''));
    if (!inv) return { refused: `no invoice for payload ${String(sp.invoice_payload ?? '').slice(0, 60)}` };
    if (inv.chat_id !== chatId) return { refused: `invoice ${inv.id} belongs to another chat` };
    if (sp.currency !== 'XTR' || Number(sp.total_amount) !== inv.stars) return { refused: `paid ${sp.total_amount} ${sp.currency}, invoice ${inv.id} is ${inv.stars} XTR` };
    if (!db.prepare('SELECT 1 FROM users WHERE chat_id = ?').get(chatId)) return { refused: 'no user row' };

    db.prepare("UPDATE stars_invoices SET state = 'paid', paid_at = ? WHERE id = ?").run(now, inv.id);
    db.prepare(
      'INSERT INTO stars_payments (chat_id, invoice_id, charge_id, stars, micro_usd, created_at) VALUES (?,?,?,?,?,?)'
    ).run(chatId, inv.id, chargeId, inv.stars, inv.micro_usd, now);
    db.prepare(
      `INSERT INTO ledger (chat_id, delta_micro_usd, kind, idem_key, note, created_at) VALUES (?,?, 'deposit_stars', ?, ?, ?)`
    ).run(chatId, inv.micro_usd, `stars:${chargeId}`, `${inv.stars} Telegram Stars`, now);
    db.prepare('UPDATE users SET balance_micro_usd = balance_micro_usd + ? WHERE chat_id = ?').run(inv.micro_usd, chatId);
    return { credited: true, micro: BigInt(inv.micro_usd), stars: inv.stars, balance: bal() };
  });
}

export function expireInvoices(db, now = nowSec()) {
  return db.prepare("UPDATE stars_invoices SET state = 'expired' WHERE state = 'pending' AND created_at < ?").run(now - INVOICE_TTL_SEC).changes;
}

export class RefundRefused extends Error {}

// Give the Stars back and take the credit away. Refused unless the user still holds what the
// payment credited -- a refund must never leave the house paying for pictures twice. Telegram
// first: if it refuses, nothing here changes.
export async function refundStarsPayment({ db, tg }, { paymentId, note }) {
  const p = db.prepare('SELECT * FROM stars_payments WHERE id = ?').get(paymentId);
  if (!p) throw new RefundRefused('no such payment');
  if (p.refunded_at) throw new RefundRefused('already refunded');
  const u = db.prepare('SELECT balance_micro_usd b FROM users WHERE chat_id = ?').get(p.chat_id);
  if (!u || u.b < p.micro_usd) throw new RefundRefused(`the user's balance (${usdLabel(u?.b ?? 0)}) is below what this payment credited (${usdLabel(p.micro_usd)}): it has been spent`);
  const r = await tg.call('refundStarPayment', { user_id: p.chat_id, telegram_payment_charge_id: p.charge_id });
  if (!r.ok) throw new RefundRefused(`Telegram refused the refund: ${r.description ?? 'no answer'}`);
  const now = nowSec();
  immediate(db, () => {
    db.prepare('UPDATE stars_payments SET refunded_at = ?, refund_note = ? WHERE id = ?').run(now, String(note ?? '').slice(0, 200), p.id);
    db.prepare(
      `INSERT INTO ledger (chat_id, delta_micro_usd, kind, idem_key, note, created_at) VALUES (?,?, 'adjust', ?, ?, ?)`
    ).run(p.chat_id, -p.micro_usd, `stars-refund:${p.charge_id}`, `Stars refund (${p.stars} ⭐)${note ? `: ${String(note).slice(0, 120)}` : ''}`, now);
    db.prepare('UPDATE users SET balance_micro_usd = balance_micro_usd - ? WHERE chat_id = ?').run(p.micro_usd, p.chat_id);
  });
  log.info('stars payment refunded', { chat: chatTag(p.chat_id), stars: p.stars, micro: p.micro_usd });
  return { ok: true, stars: p.stars, micro: p.micro_usd, chatId: p.chat_id };
}

// What Telegram says: the bot's Stars balance, and every transaction, to check our books against.
export async function starsReport(tg, { now = nowSec(), maxPages = 20 } = {}) {
  const bal = await tg.call('getMyStarBalance', {});
  const txs = [];
  for (let offset = 0, page = 0; page < maxPages; page++) {
    const r = await tg.call('getStarTransactions', { offset, limit: 100 });
    if (!r.ok) return { ok: false, error: r.description ?? 'getStarTransactions failed' };
    const t = r.result?.transactions ?? [];
    txs.push(...t);
    if (t.length < 100) break;
    offset += t.length;
  }
  const holdSec = HOLD_DAYS * 86400;
  const incoming = txs.filter((t) => t.source);
  const matured = incoming.filter((t) => now - t.date >= holdSec).reduce((a, t) => a + t.amount, 0)
    - txs.filter((t) => t.receiver).reduce((a, t) => a + t.amount, 0);
  const next = incoming.filter((t) => now - t.date < holdSec).map((t) => t.date + holdSec).sort((a, b) => a - b)[0] ?? null;
  return {
    ok: true,
    balance: bal.ok ? bal.result?.amount ?? 0 : null,
    incomingStars: incoming.reduce((a, t) => a + t.amount, 0),
    maturedStars: Math.max(0, matured),
    nextUnlockAt: next,
    withdrawMin: WITHDRAW_MIN_STARS,
    transactions: txs.slice(0, 200).map((t) => ({
      id: t.id, date: t.date, amount: t.amount, direction: t.source ? 'in' : 'out',
      user: t.source?.user?.id ?? t.receiver?.user?.id ?? null,
      payload: t.source?.invoice_payload ?? null,
    })),
  };
}
