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

import { immediate, kvGetJson, kvSetJson } from './db.mjs';
import { nowSec } from './time.mjs';
import { log, chatTag } from './log.mjs';
import { t, langOf } from './i18n.mjs';
import { toppedUpMicro } from './rewards.mjs';
import { moneyLabel, balanceLabel } from './media.mjs';
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

// ---- telling the user (review, 2026-09-27, item B) ---------------------------------------------
//
// "✅ Paid" used to go out only from the delivery that also wrote the claim, and only after it: a
// crash between credit and claim made the redelivery say "already credited" (reads like an error
// right after paying), and a crash between claim and send told the user nothing at all. The row
// now records when the user was told (stars_payments.notified_at, migration 017), and this is the
// one function that tells them -- called by the loop on every delivery and by a 2-minute sweep.
// It sets notified_at only after Telegram accepted the message, so a failure is retried; a crash
// between the send and that write can repeat the message once, which is the right way to fail.
// A payment refunded before it was ever announced is closed without a "Paid".
export async function notifyStarsPaid({ db, tg }, chargeId, { inFlight = new Set(), now = nowSec } = {}) {
  const id = String(chargeId ?? '');
  if (!id || inFlight.has(id)) return { skipped: 'in_flight' };
  const p = db.prepare('SELECT * FROM stars_payments WHERE charge_id = ?').get(id);
  if (!p) return { skipped: 'unknown' };
  if (p.notified_at !== null) return { skipped: 'notified' };
  if (p.refund_state !== null) {
    db.prepare('UPDATE stars_payments SET notified_at = ? WHERE id = ? AND notified_at IS NULL').run(now(), p.id);
    return { skipped: 'refunded' };
  }
  inFlight.add(id);
  try {
    const balance = db.prepare('SELECT balance_micro_usd b FROM users WHERE chat_id = ?').get(p.chat_id)?.b ?? 0;
    const text = t(langOf(db, p.chat_id), 'stars.paid', { stars: p.stars, usd: moneyLabel(p.micro_usd), balance: balanceLabel(balance) });
    const r = await tg.sendMessage(p.chat_id, text);
    if (!r?.ok) {
      if (!unreachable(r)) return { sent: false, error: r?.description ?? 'send failed' };
      // Blocked the bot / deactivated / chat gone: the 2-minute sweep would ask Telegram every
      // 2 minutes for ever. Back off (4 min, 8, 16 ... one day). notified_at stays NULL -- they
      // were NOT told -- so the "Paid" still reaches them if they come back.
      const prev = kvGetJson(db, backoffKey(id));
      const n = (prev?.n ?? 0) + 1;
      const delay = Math.min(NOTIFY_RETRY_SEC * 2 ** n, NOTIFY_BACKOFF_MAX_SEC);
      kvSetJson(db, backoffKey(id), { n, next: now() + delay, why: r.description ?? null });
      return { sent: false, error: r.description ?? 'unreachable', backoffSec: delay };
    }
    db.prepare('UPDATE stars_payments SET notified_at = ? WHERE id = ? AND notified_at IS NULL').run(now(), p.id);
    if (kvGetJson(db, backoffKey(id)) !== null) db.prepare('DELETE FROM kv WHERE k = ?').run(backoffKey(id));
    return { sent: true, chatId: p.chat_id };
  } finally {
    inFlight.delete(id);
  }
}

// Telegram's answer for a user we can no longer write to. Only these back off; a timeout, a 429 or
// a 5xx is ours or Telegram's problem and keeps the 2-minute retry.
export const NOTIFY_RETRY_SEC = 120;
export const NOTIFY_BACKOFF_MAX_SEC = 86_400;
const backoffKey = (chargeId) => `stars:notify-backoff:${chargeId}`;
export function unreachable(r) {
  if (!r || r.ok || r.unknown) return false;
  return r.errorCode === 403 || /blocked by the user|user is deactivated|chat not found/i.test(r.description ?? '');
}

// Payments whose user has not been told yet, for the sweep. Younger than `graceSec` is left to the
// delivery that is telling them right now; one whose user is unreachable waits out its backoff.
export function unnotifiedPayments(db, { graceSec = 60, now = nowSec() } = {}) {
  return db.prepare('SELECT charge_id FROM stars_payments WHERE notified_at IS NULL AND created_at <= ? ORDER BY id')
    .all(now - graceSec).map((r) => r.charge_id)
    .filter((c) => !((kvGetJson(db, backoffKey(c))?.next ?? 0) > now));
}

export function expireInvoices(db, now = nowSec()) {
  return db.prepare("UPDATE stars_invoices SET state = 'expired' WHERE state = 'pending' AND created_at < ?").run(now - INVOICE_TTL_SEC).changes;
}

export class RefundRefused extends Error {}

// Give the Stars back and take the credit away (review, 2026-09-26: "fix ... the refund race").
//
// THE MONEY COMES OFF FIRST, THEN TELEGRAM IS ASKED. This used to check the balance, await
// Telegram, and deduct afterwards -- and a ✅ pressed during the await reserved the same money, so
// the balance went negative and the house paid for the picture as well as returning the Stars.
// Now step 1 is one BEGIN IMMEDIATE: a conditional deduction (refused unless the SPENDABLE balance
// covers it -- money set aside for something being made is not spendable), its ledger row, and the
// payment marked 'pending'. Nothing can spend that money after it.
//
// Then Telegram's answer decides:
//   ok, or CHARGE_ALREADY_REFUNDED  -> 'done'. The Stars are back with the user either way.
//   a definite refusal              -> the money goes back, with its own ledger row (…:undo), and
//                                      the payment is refundable again.
//   no answer                       -> stays 'pending', money still off. The refund may or may not
//                                      have happened, and neither guess is safe; pressing Refund
//                                      again asks Telegram again, and one of the two lines above
//                                      settles it.
//
// Each attempt's ledger key is stars-refund:<charge>:<n>, its reversal stars-refund:<charge>:<n>:undo
// -- both match 'stars-refund:%', which is what the invite reward's "paid in" sum reads.
//
// THE INVITE LOOPHOLE (same review: "close the invite-reward refund loophole"). A top-up that an
// invite reward required cannot be refunded out from under it: top up $5 in Stars, make a video on
// the welcome gift (the inviter gets $2), refund the $5 -- and the inviter's $2 was free. If the
// invited person's inviter has been paid, and this refund would leave what they paid in below the
// minimum that payout required, the refund is refused -- unless the admin asks for `clawback`, in
// which case, once Telegram confirms, the reward is taken back off the inviter (their balance may
// go negative: they were paid for a top-up that no longer exists) and the invite is voided.
export async function refundStarsPayment({ db, tg }, { paymentId, note = '', clawback = false, now = nowSec() }) {
  const begun = beginRefund(db, { paymentId, note, clawback, now });
  const p = begun.payment;
  const r = await tg.call('refundStarPayment', { user_id: p.chat_id, telegram_payment_charge_id: p.charge_id });

  if (r.ok || (!r.unknown && /CHARGE_ALREADY_REFUNDED/i.test(String(r.description ?? '')))) {
    const done = finishRefund(db, p.id, nowSec());
    log.info('stars payment refunded', {
      chat: chatTag(p.chat_id), stars: p.stars, micro: p.micro_usd,
      telegram: r.ok ? 'refunded' : 'already refunded', clawback: done.clawback ? Number(done.clawback.micro) : 0,
    });
    return { ok: true, stars: p.stars, micro: p.micro_usd, chatId: p.chat_id, clawback: done.clawback };
  }
  if (!r.unknown) {
    undoRefund(db, p.id, String(r.description ?? 'refused'), nowSec());
    throw new RefundRefused(`Telegram refused the refund: ${r.description ?? 'no reason given'}. The balance was put back.`);
  }
  log.error('STARS REFUND OUTCOME UNKNOWN -- the credit stays off until Telegram answers', {
    chat: chatTag(p.chat_id), payment: p.id, stars: p.stars, desc: r.description ?? null,
  });
  throw new RefundRefused(`Telegram did not answer (${r.description ?? 'no answer'}), so the refund may or may not have happened. `
    + `${usdLabel(p.micro_usd)} stays off the balance until it is settled: press Refund again to ask Telegram again.`);
}

// The minimum paid-in top-up an invite reward stands on, or null if there is none to protect.
function inviteDependency(db, chatId, refundMicro) {
  const ref = db.prepare("SELECT * FROM referrals WHERE referred_chat_id = ? AND status = 'rewarded'").get(chatId);
  if (!ref) return null;
  // A reward paid before the minimum was stamped: assume it needed everything paid in so far.
  const min = ref.min_topup_micro_usd === null ? null : BigInt(ref.min_topup_micro_usd);
  const after = toppedUpMicro(db, chatId) - BigInt(refundMicro);
  if (min !== null && after >= min) return null;
  return { ref, min, after };
}

// Step 1, synchronous: take the money off and mark the payment pending. Returns { payment }.
export function beginRefund(db, { paymentId, note = '', clawback = false, now = nowSec() }) {
  return immediate(db, () => {
    const p = db.prepare('SELECT * FROM stars_payments WHERE id = ?').get(paymentId);
    if (!p) throw new RefundRefused('no such payment');
    if (p.refund_state === 'done' || p.refunded_at) throw new RefundRefused('already refunded');
    // Already off the balance, Telegram's answer still open: ask again, deduct nothing.
    if (p.refund_state === 'pending') return { payment: p, resumed: true };

    const dep = inviteDependency(db, p.chat_id, p.micro_usd);
    if (dep && !clawback) {
      throw new RefundRefused(`this user was invited by ${dep.ref.referrer_chat_id}, who was paid ${usdLabel(dep.ref.reward_micro_usd ?? 0)} `
        + `because this user topped up; refunding this payment would leave them having paid in ${usdLabel(dep.after > 0n ? dep.after : 0n)}, `
        + `below the ${dep.min === null ? 'top-up that reward' : usdLabel(dep.min)} required. `
        + 'Tick "take the invite reward back" to refund it and take the reward off the inviter.');
    }

    const dec = db.prepare(
      'UPDATE users SET balance_micro_usd = balance_micro_usd - ? WHERE chat_id = ? AND balance_micro_usd >= ?'
    ).run(p.micro_usd, p.chat_id, p.micro_usd);
    if (dec.changes !== 1) {
      const u = db.prepare('SELECT balance_micro_usd b, reserved_micro_usd r FROM users WHERE chat_id = ?').get(p.chat_id);
      throw new RefundRefused(`the user's spendable balance (${usdLabel(u?.b ?? 0)}${u?.r ? `, plus ${usdLabel(u.r)} set aside for something being made` : ''}) `
        + `is below what this payment credited (${usdLabel(p.micro_usd)}): it has been spent`);
    }
    const attempt = db.prepare(
      "SELECT COUNT(*) n FROM ledger WHERE idem_key LIKE ? AND idem_key NOT LIKE '%:undo'"
    ).get(`stars-refund:${p.charge_id}:%`).n + 1;
    db.prepare(
      `INSERT INTO ledger (chat_id, delta_micro_usd, kind, idem_key, note, created_at) VALUES (?,?, 'adjust', ?, ?, ?)`
    ).run(p.chat_id, -p.micro_usd, `stars-refund:${p.charge_id}:${attempt}`,
      `Stars refund (${p.stars} ⭐)${note ? `: ${String(note).slice(0, 120)}` : ''}`, now);
    db.prepare(
      "UPDATE stars_payments SET refund_state = 'pending', refund_started_at = ?, refund_note = ?, refund_clawback = ? WHERE id = ?"
    ).run(now, String(note ?? '').slice(0, 200), dep && clawback ? 1 : 0, p.id);
    return { payment: db.prepare('SELECT * FROM stars_payments WHERE id = ?').get(p.id), resumed: false };
  });
}

// Telegram confirmed: the refund is done, and the invite reward is taken back if that was asked.
export function finishRefund(db, paymentId, now = nowSec()) {
  return immediate(db, () => {
    const p = db.prepare('SELECT * FROM stars_payments WHERE id = ?').get(paymentId);
    const up = db.prepare("UPDATE stars_payments SET refund_state = 'done', refunded_at = ? WHERE id = ? AND refund_state = 'pending'").run(now, paymentId);
    if (up.changes !== 1) return { already: true, clawback: null };
    let clawback = null;
    if (p.refund_clawback) {
      const ref = db.prepare("SELECT * FROM referrals WHERE referred_chat_id = ? AND status = 'rewarded'").get(p.chat_id);
      if (ref && ref.reward_micro_usd > 0) {
        db.prepare(
          `INSERT INTO ledger (chat_id, delta_micro_usd, kind, idem_key, note, created_at) VALUES (?,?, 'referral', ?, ?, ?)`
        ).run(ref.referrer_chat_id, -ref.reward_micro_usd, `referral-clawback:${p.chat_id}`,
          `invite reward taken back: ${p.chat_id} was refunded their top-up`, now);
        db.prepare('UPDATE users SET balance_micro_usd = balance_micro_usd - ? WHERE chat_id = ?').run(ref.reward_micro_usd, ref.referrer_chat_id);
        db.prepare("UPDATE referrals SET status = 'void', void_reason = 'top-up refunded; reward taken back' WHERE id = ?").run(ref.id);
        clawback = { inviter: ref.referrer_chat_id, micro: BigInt(ref.reward_micro_usd) };
      }
    }
    return { already: false, clawback };
  });
}

// Telegram definitely refused: put the money back, with its own ledger row.
export function undoRefund(db, paymentId, why, now = nowSec()) {
  return immediate(db, () => {
    const p = db.prepare('SELECT * FROM stars_payments WHERE id = ?').get(paymentId);
    if (!p || p.refund_state !== 'pending') return { noop: true };
    const attempt = db.prepare(
      "SELECT COUNT(*) n FROM ledger WHERE idem_key LIKE ? AND idem_key NOT LIKE '%:undo'"
    ).get(`stars-refund:${p.charge_id}:%`).n;
    db.prepare(
      `INSERT INTO ledger (chat_id, delta_micro_usd, kind, idem_key, note, created_at) VALUES (?,?, 'adjust', ?, ?, ?)`
    ).run(p.chat_id, p.micro_usd, `stars-refund:${p.charge_id}:${attempt}:undo`, `Stars refund refused by Telegram: ${String(why).slice(0, 120)}`, now);
    db.prepare('UPDATE users SET balance_micro_usd = balance_micro_usd + ? WHERE chat_id = ?').run(p.micro_usd, p.chat_id);
    db.prepare('UPDATE stars_payments SET refund_state = NULL, refund_started_at = NULL, refund_clawback = 0 WHERE id = ?').run(p.id);
    return { restored: BigInt(p.micro_usd) };
  });
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
