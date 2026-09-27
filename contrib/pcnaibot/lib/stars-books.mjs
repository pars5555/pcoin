// Telegram's Stars books against ours, on a timer (review, 2026-09-27, item D).
//
// Telegram keeps an undelivered update for 24 hours. A bot that is down or wedged for longer loses
// the successful_payment for good: Telegram has the Stars, stars_payments has no row, and nothing
// said so. A refund made outside the bot was just as invisible. This compares the two books every
// hour; the result rides in the bot heartbeat and heartbeat-check.sh (on the host, as root) alerts
// the PRIVATE ops channel through pcoin-notify when it changes -- never @PCoinPCN.
//
// Matching is on the transaction id. Telegram documents that a StarTransaction's id "coincides with
// SuccessfulPayment.telegram_payment_charge_id for successful incoming payments from users", and a
// refund carries "the identifier of the original transaction" -- so both sides key on charge_id.
// Still to be confirmed on the first real payment (review item E).
//
// A read that failed, or that could not be completed, is UNKNOWN -- never "the books match".
import { nowSec } from './time.mjs';

export const BOOKS_GRACE_SEC = 10 * 60;      // a payment this fresh may still be on its way
export const BOOKS_UNKNOWN_AFTER = 3;        // failed reads in a row before it is its own alert
const PAGE = 100;

const fromUser = (p) => !!p && (p.type === 'user' || (!p.type && p.user));

// Every transaction, paged. { ok: true, txs } | { ok: false, error }. Stopping at maxPages without a
// short page is a failure: a partial list would report every older payment as missing.
export async function readStarTransactions(tg, { maxPages = 100 } = {}) {
  const txs = [];
  for (let page = 0; page < maxPages; page++) {
    let r;
    try { r = await tg.call('getStarTransactions', { offset: page * PAGE, limit: PAGE }); }
    catch (e) { return { ok: false, error: String(e?.message ?? e).slice(0, 200) }; }
    if (!r?.ok) return { ok: false, error: String(r?.description ?? 'getStarTransactions failed').slice(0, 200) };
    const got = r.result?.transactions;
    if (!Array.isArray(got)) return { ok: false, error: 'getStarTransactions: no transactions array' };
    txs.push(...got);
    if (got.length < PAGE) return { ok: true, txs };
  }
  return { ok: false, error: `more than ${maxPages * PAGE} transactions; the list was not read to the end` };
}

// Pure. `ignore` holds charge ids known to be in flight (parked payments: they have their own alert).
export function compareStarsBooks(db, txs, { now = nowSec(), graceSec = BOOKS_GRACE_SEC, ignore = new Set() } = {}) {
  const payments = db.prepare('SELECT id, chat_id, charge_id, stars, created_at, refund_state FROM stars_payments').all();
  const byCharge = new Map(payments.map((p) => [p.charge_id, p]));
  const incoming = new Map();
  const refunds = new Map();
  for (const t of txs) {
    if (fromUser(t.source)) incoming.set(String(t.id), t);
    else if (fromUser(t.receiver)) refunds.set(String(t.id), t);
  }
  const problems = [];
  const old = (at) => now - Number(at) >= graceSec;

  for (const [id, t] of incoming) {
    if (!old(t.date) || ignore.has(id)) continue;
    const p = byCharge.get(id);
    if (!p) problems.push(`paid in Telegram, never credited: ${t.amount} ⭐ from user ${t.source?.user?.id ?? '?'} (tx ${id.slice(0, 24)})`);
    else if (Number(p.stars) !== Number(t.amount)) problems.push(`amount differs: payment #${p.id} is ${p.stars} ⭐, Telegram says ${t.amount} ⭐`);
  }
  for (const p of payments) {
    if (!old(p.created_at)) continue;
    if (!incoming.has(p.charge_id)) problems.push(`credited here, not in Telegram: payment #${p.id} (${p.stars} ⭐, chat ${p.chat_id})`);
  }
  for (const [id, t] of refunds) {
    if (!old(t.date)) continue;
    const p = byCharge.get(id);
    if (!p) problems.push(`Telegram refunded a payment we never had: ${t.amount} ⭐ (tx ${id.slice(0, 24)})`);
    else if (p.refund_state !== 'done') problems.push(`refunded in Telegram, not closed here: payment #${p.id} (refund_state ${p.refund_state ?? 'none'})`);
  }
  for (const p of payments) {
    if (p.refund_state === 'done' && !refunds.has(p.charge_id)) problems.push(`refunded here, not in Telegram: payment #${p.id}`);
  }
  return {
    problems,
    counts: { telegramIn: incoming.size, telegramRefunds: refunds.size, payments: payments.length },
  };
}

// The hourly check's running state, as the heartbeat carries it.
//   { state: 'ok' | 'mismatch' | 'unknown' | 'pending', checked_at, failures, problems, counts }
// One failed read keeps the last answer and counts; BOOKS_UNKNOWN_AFTER in a row make it 'unknown'.
// 'pending' is "no read has completed yet" -- not ok, and not yet worth an alert.
export function nextBooksState(prev, read, compare, now = nowSec()) {
  if (!read.ok) {
    const failures = (prev?.failures ?? 0) + 1;
    const base = prev ?? { state: 'pending', checked_at: null, problems: [], counts: null };
    let state = base.state;
    if (failures >= BOOKS_UNKNOWN_AFTER) state = 'unknown';
    else if (base.checked_at === null) state = 'pending';
    return { ...base, failures, last_error: read.error, state };
  }
  const c = compare(read.txs);
  return {
    state: c.problems.length ? 'mismatch' : 'ok',
    checked_at: now,
    failures: 0,
    last_error: null,
    problems: c.problems.slice(0, 20),
    counts: c.counts,
  };
}
