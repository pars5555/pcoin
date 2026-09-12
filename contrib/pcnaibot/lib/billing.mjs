// Billing a cost known only AFTER the answer: reserve, then settle.
//
//   1. QUOTE    worst case = counted (not estimated) input + max_tokens, at the
//               model's live RETAIL $/1M, x M.
//   2. RESERVE  a reservations ROW, and move the quote from balance_micro_usd
//               into reserved_micro_usd. A REAL DECREMENT, not a check.
//               Cannot cover the worst case -> REFUSE BEFORE CALLING.
//   3. CALL     the provider.
//   4. SETTLE   re-quote from the provider's OWN returned token counts.
//               Release the difference.
//   5. AGE OUT  a reservation with no usage received, older than N minutes, is
//               released in full and logged.
//
// WHY AGE-OUT IS NOT "ASK THE PROVIDER": the natural rule -- release only once
// the provider confirms no usage was recorded -- CANNOT BE IMPLEMENTED with the
// credential this bot holds, because cumulative costUsd sits behind a browser
// session token. Left as written it reduces to "held forever" for every
// reservation orphaned by a crash, an OOM, a deploy or a lost response. And
// reserved_micro_usd is not spendable, there are no refunds, and the server
// holds no key. CONFISCATING A CUSTOMER'S BALANCE IN A PRODUCT THAT PUBLISHES
// "NO REFUNDS" IS WORSE THAN OVER-RELEASING TO OURSELVES ON A LOST RESPONSE.
// The reconciler that catches the error in that trade is the nightly console
// check, not a timer.

import { immediate } from './db.mjs';
import { nowSec } from './time.mjs';
import { tokensToMicroUsd } from './money.mjs';
import { log } from './log.mjs';

export class InsufficientFunds extends Error {
  constructor(needed, available) {
    super(`insufficient balance: need ${needed}, have ${available}`);
    this.name = 'InsufficientFunds';
    this.needed = needed;
    this.available = available;
  }
}

export class Busy extends Error {
  constructor() { super('another turn is already in flight for this chat'); this.name = 'Busy'; }
}

// The worst case for a turn, in micro-USD.
//
// `max_tokens` is the ONLY thing bounding the output side, which is why it is
// mandatory and finite on every request: an unbounded request is an unbounded
// liability.
export function quoteTurn({ inputTokens, maxTokens, priceRow, marginE6 }) {
  const inMicro = tokensToMicroUsd(inputTokens, priceRow.inputPricePerMe9 ?? priceRow.input_price_per_m_e9, marginE6);
  const outMicro = tokensToMicroUsd(maxTokens, priceRow.outputPricePerMe9 ?? priceRow.output_price_per_m_e9, marginE6);
  return inMicro + outMicro;
}

// Per-user serialisation. An atomic conditional UPDATE with an affected-row
// check -- zero rows means somebody else holds it. The balance is re-read AFTER
// the lock, never before.
export function acquireUserLock(db, chatId, { staleSeconds = 180 } = {}) {
  const now = nowSec();
  const res = db.prepare(
    `UPDATE users SET busy_at = ?
      WHERE chat_id = ? AND (busy_at IS NULL OR busy_at < ?)`
  ).run(now, chatId, now - staleSeconds);
  if (res.changes !== 1) throw new Busy();
  return () => {
    try { db.prepare('UPDATE users SET busy_at = NULL WHERE chat_id = ?').run(chatId); }
    catch (e) { log.warn('failed to release user lock', { chat: String(chatId).slice(-4), err: e.message }); }
  };
}

// RESERVE. A real decrement of balance into reserved, plus a row.
//
// The `free` path reserves ZERO and writes no reservation row -- but the caller
// MUST still have passed the per-chat free-turn quota, because a $0 quote
// reserves $0 and a money-based check would admit it unconditionally.
export function reserve(db, { chatId, updateId = null, reqKey = null, model, microUsd, allowOverdraft = false }) {
  // Exactly one identity, matching the CHECK on the table. A turn arriving from
  // Telegram is keyed on its update_id; one arriving through the API is keyed on
  // its request id. Mixing the two id spaces in one column would let an API
  // request collide with a Telegram update and silently reuse its reservation.
  if ((updateId === null) === (reqKey === null)) {
    throw new Error('reserve: exactly one of updateId or reqKey is required');
  }
  return immediate(db, () => {
    const existing = updateId !== null
      ? db.prepare('SELECT * FROM reservations WHERE update_id = ?').get(updateId)
      : db.prepare('SELECT * FROM reservations WHERE req_key = ?').get(reqKey);
    if (existing) {
      // Idempotent: the same request must never reserve twice.
      return { reservationId: existing.id, microUsd: BigInt(existing.micro_usd), duplicate: true };
    }

    const u = db.prepare('SELECT balance_micro_usd, reserved_micro_usd FROM users WHERE chat_id = ?').get(chatId);
    if (!u) throw new Error('reserve: no user row');

    const need = Number(microUsd);
    if (need > 0) {
      // OVERDRAFT.
      //
      // By default a turn is refused unless the balance covers the WORST CASE,
      // because max_tokens is the only thing bounding it. With a 32,000-token
      // ceiling that worst case is ~$1.15 on gpt-5, which would lock out anyone
      // holding less than that even though a typical answer costs a fraction of
      // a cent.
      //
      // With allowOverdraft the reservation may take the balance negative. The
      // guard that remains is that it must be NON-NEGATIVE to start: a user who
      // is already in the red cannot keep going, so the exposure is bounded at
      // one turn's ceiling per user rather than being unbounded. That matters
      // because Telegram accounts are free and the allow-list will not stay
      // one person forever.
      const floor = allowOverdraft ? 0 : need;
      const dec = db.prepare(
        `UPDATE users
            SET balance_micro_usd = balance_micro_usd - ?,
                reserved_micro_usd = reserved_micro_usd + ?
          WHERE chat_id = ? AND balance_micro_usd >= ?`
      ).run(need, need, chatId, floor);
      if (dec.changes !== 1) throw new InsufficientFunds(need, u.balance_micro_usd);
    }

    const r = db.prepare(
      `INSERT INTO reservations (chat_id, update_id, req_key, model, micro_usd, state, created_at)
       VALUES (?,?,?,?,?, 'open', ?)`
    ).run(chatId, updateId, reqKey, model, need, nowSec());

    return { reservationId: r.lastInsertRowid, microUsd: BigInt(need), duplicate: false };
  });
}

// SETTLE. Re-quote from the provider's OWN returned counts and release the
// difference.
//
// A SETTLE THAT EXCEEDS THE RESERVATION IS BILLED IN FULL. NEVER CLAMP.
// Clamping is not a safety net, it is the exploit: it converts every
// under-quote into free output paid for by the house, and the only trace is an
// alert nothing gates on. The balance goes NEGATIVE and further turns are
// blocked until the user tops up.
export function settle(db, reservationId, actualMicroUsd, { note = null } = {}) {
  return immediate(db, () => {
    const r = db.prepare('SELECT * FROM reservations WHERE id = ?').get(reservationId);
    if (!r) throw new Error('settle: no reservation');
    if (r.state !== 'open') return { alreadyClosed: true, state: r.state };

    const reserved = BigInt(r.micro_usd);
    const actual = BigInt(actualMicroUsd);
    const overran = actual > reserved;

    // Give the whole reservation back first, then take the real amount. Doing
    // it in this order means the arithmetic is the same whether the settle is
    // under or over, and there is no branch where money is created.
    db.prepare(
      `UPDATE users
          SET reserved_micro_usd = reserved_micro_usd - ?,
              balance_micro_usd  = balance_micro_usd + ?
        WHERE chat_id = ?`
    ).run(Number(reserved), Number(reserved), r.chat_id);

    if (actual > 0n) {
      // NO `WHERE balance >= ?` GUARD HERE, deliberately. This charge has
      // already been incurred upstream; refusing it would be the clamp.
      db.prepare('UPDATE users SET balance_micro_usd = balance_micro_usd - ? WHERE chat_id = ?')
        .run(Number(actual), r.chat_id);

      const idem = r.update_id !== null ? `turn:${r.update_id}` : `turn:api:${r.req_key}`;
      db.prepare(
        `INSERT INTO ledger (chat_id, delta_micro_usd, kind, idem_key, note, created_at)
         VALUES (?,?,?,?,?,?)`
      ).run(r.chat_id, -Number(actual), 'ai_turn', idem, note, nowSec());
    }

    db.prepare(`UPDATE reservations SET state='settled', closed_at=?, note=? WHERE id=?`)
      .run(nowSec(), overran ? `OVERRAN: settled ${actual} vs reserved ${reserved}` : note, reservationId);

    const bal = db.prepare('SELECT balance_micro_usd b FROM users WHERE chat_id=?').get(r.chat_id).b;
    return {
      reserved,
      actual,
      overran,
      // Emitted per turn in the heartbeat summary as a counter: a
      // clamp-equivalent that fires on 30% of Armenian messages and 0% of
      // English ones is a PRICING BUG, and a per-turn ratio in a table is the
      // only way anyone ever sees it.
      ratio: reserved === 0n ? null : Number(actual) / Number(reserved),
      balanceAfter: bal,
      negative: bal < 0,
    };
  });
}

// RELEASE IN FULL. Used for PERMANENT, BACKOFF and NOT_BILLED -- everything
// that positively did not run.
export function release(db, reservationId, reason) {
  return immediate(db, () => {
    const r = db.prepare('SELECT * FROM reservations WHERE id = ?').get(reservationId);
    if (!r) throw new Error('release: no reservation');
    if (r.state !== 'open') return { alreadyClosed: true, state: r.state };

    db.prepare(
      `UPDATE users
          SET reserved_micro_usd = reserved_micro_usd - ?,
              balance_micro_usd  = balance_micro_usd + ?
        WHERE chat_id = ?`
    ).run(r.micro_usd, r.micro_usd, r.chat_id);

    db.prepare(`UPDATE reservations SET state='released', closed_at=?, note=? WHERE id=?`)
      .run(nowSec(), reason ?? null, reservationId);
    return { released: BigInt(r.micro_usd) };
  });
}

// HOLD. Used for UNKNOWN only: the turn MAY have run. The money stays in
// `reserved` until the age-out releases it, so it is neither spendable nor
// lost, and the nightly console reconciliation is what settles whether we
// over-released.
export function hold(db, reservationId, reason) {
  return immediate(db, () => {
    const r = db.prepare('SELECT * FROM reservations WHERE id = ?').get(reservationId);
    if (!r || r.state !== 'open') return { noop: true };
    db.prepare(`UPDATE reservations SET state='held', note=? WHERE id=?`).run(reason ?? null, reservationId);
    return { held: BigInt(r.micro_usd) };
  });
}

// AGE OUT. Release in full any reservation older than N minutes that produced
// no usage we received, with a reserve_expired note, and alert on the count.
export function ageOutReservations(db, { olderThanMinutes = 60 } = {}) {
  const cutoff = nowSec() - olderThanMinutes * 60;
  const stale = db.prepare(
    `SELECT id, chat_id, micro_usd, state FROM reservations
      WHERE state IN ('open','held') AND created_at < ?`
  ).all(cutoff);

  const freed = [];
  for (const r of stale) {
    immediate(db, () => {
      const cur = db.prepare('SELECT * FROM reservations WHERE id = ?').get(r.id);
      if (!cur || !['open', 'held'].includes(cur.state)) return;
      db.prepare(
        `UPDATE users
            SET reserved_micro_usd = reserved_micro_usd - ?,
                balance_micro_usd  = balance_micro_usd + ?
          WHERE chat_id = ?`
      ).run(cur.micro_usd, cur.micro_usd, cur.chat_id);
      db.prepare(`UPDATE reservations SET state='expired', closed_at=?, note=? WHERE id=?`)
        .run(nowSec(), 'reserve_expired: no usage was ever received', r.id);
      freed.push({ id: r.id, microUsd: cur.micro_usd });
    });
  }
  if (freed.length) {
    log.warn('reservations aged out and released in full', {
      count: freed.length,
      total_micro: freed.reduce((a, b) => a + b.microUsd, 0),
    });
  }
  return freed;
}

// The free-model quota, enforced INDEPENDENTLY of balance.
export function takeFreeTurn(db, chatId, { perHour = 10 } = {}) {
  const hourKey = Math.floor(nowSec() / 3600);
  return immediate(db, () => {
    db.prepare(
      `INSERT INTO free_usage (chat_id, hour_key, turns) VALUES (?,?,0)
       ON CONFLICT(chat_id, hour_key) DO NOTHING`
    ).run(chatId, hourKey);
    const row = db.prepare('SELECT turns FROM free_usage WHERE chat_id=? AND hour_key=?').get(chatId, hourKey);
    if (row.turns >= perHour) return { allowed: false, used: row.turns, limit: perHour };
    db.prepare('UPDATE free_usage SET turns = turns + 1 WHERE chat_id=? AND hour_key=?').run(chatId, hourKey);
    return { allowed: true, used: row.turns + 1, limit: perHour };
  });
}
