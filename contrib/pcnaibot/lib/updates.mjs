// The one place an update's work may come BEFORE its claim (review, 2026-09-26: "fix the
// lost-payment-on-restart bug").
//
// The poll loop claims each update (INSERT into tg_updates) before working on it, which makes work
// AT-MOST-ONCE -- right for a chat turn that costs money to repeat, wrong for a payment Telegram has
// already taken: a successful_payment update was claimed, then waited for a free slot, and a
// restart in that wait lost the credit for good, because a claimed update is never retried.
//
// A Stars credit is idempotent on Telegram's charge id, so it runs FIRST, synchronously, and the
// claim follows. A restart can then only make it run twice (the second run answers "already
// credited"), never not at all. If `credit` throws, nothing is claimed and the caller fetches the
// same update again.
import { nowSec } from './time.mjs';
import { immediate } from './db.mjs';

export function creditThenClaim(db, up, credit, now = nowSec()) {
  const reply = credit(up.message);
  const claimed = db.prepare('INSERT OR IGNORE INTO tg_updates (update_id, claimed_at) VALUES (?,?)').run(up.update_id, now).changes === 1;
  return { reply, claimed };
}

// ONE successful_payment delivery, decided here rather than inline in the poll loop (review,
// 2026-09-27, item F2: a change to the loop that removed the retry limit passed every test).
//   { outcome: 'handled', reply, claimed }    credited (or refused for good) -- carry on
//   { outcome: 'retry', tries, error }        fetch the SAME update again after a short pause
//   { outcome: 'parked', tries, error }       written down for the sweep; carry on with the next
// `tries` is the loop's Map of failed attempts per update_id.
export function takePaymentUpdate(db, up, credit, tries, now = nowSec()) {
  try {
    const r = creditThenClaim(db, up, credit, now);
    tries.delete(up.update_id);
    return { outcome: 'handled', ...r };
  } catch (error) {
    const n = (tries.get(up.update_id) ?? 0) + 1;
    if (n < PAYMENT_QUICK_TRIES) {
      tries.set(up.update_id, n);
      return { outcome: 'retry', tries: n, error };
    }
    // If even this write fails the database is down: it throws, the process ends, the unit restarts
    // it, the unclaimed update is fetched again -- and the stale heartbeat alerts.
    parkPayment(db, up, error, now);
    tries.delete(up.update_id);
    return { outcome: 'parked', tries: n, error };
  }
}

// ---- a payment that will not credit must not hold the bot (review, 2026-09-27) -----------------
//
// "One bad payment freezes the bot": the loop re-fetched a failing Stars update for ever, so nobody
// else was answered, while the heartbeat stayed fresh and said ok. Now the loop tries a few times
// (PAYMENT_QUICK_TRIES), then PARKS the payment here -- the whole update, written in the same
// transaction as its claim -- and goes on. retryParked() is run by a timer and credits it once it
// can (idempotent on Telegram's charge id, like every Stars credit). The heartbeat carries the
// parked count and heartbeat-check.sh alerts on it: a payment Telegram took and we have not
// credited is never silent.
export const PAYMENT_QUICK_TRIES = 3;
const PARKED = 'stars:parked:';

export function parkPayment(db, up, err, now = nowSec()) {
  const m = up.message;
  const rec = {
    update_id: up.update_id,
    chat_id: m.chat.id,
    from: m.from ? { id: m.from.id, language_code: m.from.language_code ?? null } : null,
    successful_payment: m.successful_payment,
    parked_at: now,
    error: String(err?.message ?? err).slice(0, 300),
  };
  immediate(db, () => {
    db.prepare('INSERT OR REPLACE INTO kv (k, v, updated_at) VALUES (?,?,?)').run(`${PARKED}${up.update_id}`, JSON.stringify(rec), now);
    db.prepare('INSERT OR IGNORE INTO tg_updates (update_id, claimed_at) VALUES (?,?)').run(up.update_id, now);
  });
  return rec;
}

export function parkedCount(db) {
  return db.prepare('SELECT COUNT(*) n FROM kv WHERE k LIKE ?').get(`${PARKED}%`).n;
}

// Their Telegram charge ids: the Stars books check leaves these to the parked alert.
export function parkedChargeIds(db) {
  return db.prepare('SELECT v FROM kv WHERE k LIKE ?').all(`${PARKED}%`)
    .map((r) => { try { return String(JSON.parse(r.v).successful_payment?.telegram_payment_charge_id ?? ''); } catch { return ''; } })
    .filter(Boolean);
}

// Try every parked payment once. `credit(rec)` returns the user's reply or throws; a success is
// removed, a failure stays for the next run. Returns { credited: [{ rec, reply }], failed: n }.
export function retryParked(db, credit) {
  const credited = [];
  let failed = 0;
  for (const row of db.prepare('SELECT k, v FROM kv WHERE k LIKE ? ORDER BY updated_at').all(`${PARKED}%`)) {
    const rec = JSON.parse(row.v);
    let reply;
    try { reply = credit(rec); } catch { failed++; continue; }
    db.prepare('DELETE FROM kv WHERE k = ?').run(row.k);
    credited.push({ rec, reply });
  }
  return { credited, failed };
}
