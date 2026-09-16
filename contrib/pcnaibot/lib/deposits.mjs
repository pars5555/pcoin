// Crediting -- the atomic part.
//
// THE LEDGER ROW GOES IN BEFORE THE BALANCE MOVES. That ordering is the whole
// double-credit guard: on a replay the UNIQUE(idem_key) violation throws before
// any money has moved, so there is no window in which a concurrent tick can
// apply the same deposit twice. It is not defence in depth; it is the defence.

import { immediate, nowSec } from './db.mjs';
import { satsToNanoUsd, splitNano } from './money.mjs';

// P3, the AI-spend rebate. OFF unless the environment says otherwise, so this
// file can ship and be read before anybody decides to run it.
//   PCNAIBOT_REBATE_PPM=100000   -> 10%
//   PCNAIBOT_REBATE_FROM=<unix>  -> only deposits credited from this moment on;
//                                   0 means never, which is the default
export const REBATE = {
  ppm: BigInt(process.env.PCNAIBOT_REBATE_PPM ?? 0),
  capSat: BigInt(process.env.PCNAIBOT_REBATE_CAP_SAT ?? 5000000000),   // 50 PCN
  from: BigInt(process.env.PCNAIBOT_REBATE_FROM ?? 0),
};

export const CreditResult = {
  CREDITED: 'credited',
  ALREADY: 'already_credited',
  DUPLICATE: 'duplicate_ledger_key',
};

function isUniqueViolation(e) {
  return /UNIQUE constraint failed/i.test(String(e && e.message));
}

// Credit one deposit row.
//
// `rate` must be a usable reading: { rateE12, rateText, source, readAt }. The
// caller is responsible for having refused an unusable one -- an unreadable
// rate is not a rate of zero, and this function will not invent one.
export function creditDeposit(db, depositId, rate, {
  minDepositSat = 100000000n,
  // The observation made THIS tick, from the authoritative /api/tx. Passing
  // these in rather than re-reading the row is deliberate: the row holds what
  // an earlier pass saw, and `confirmations_at_credit` must record the count at
  // the moment the money moved, not a stale one.
  observed = null,
} = {}) {
  if (!rate || rate.usable !== true) {
    throw new Error('creditDeposit: called without a usable rate');
  }
  const rateE12 = BigInt(rate.rateE12);
  if (rateE12 <= 0n) throw new Error('creditDeposit: non-positive rate');

  return immediate(db, () => {
    const dep = db.prepare('SELECT * FROM pcn_deposits WHERE id = ?').get(depositId);
    if (!dep) throw new Error(`creditDeposit: no deposit row ${depositId}`);

    if (dep.status === 'credited') {
      // ON THE DUPLICATE PATH, RETURN WHAT WAS ACTUALLY APPLIED. Do not
      // re-stamp amount or rate from the current tick, or a daily cap and
      // every report drift with nothing in the log to say why.
      return {
        result: CreditResult.ALREADY,
        microUsd: BigInt(dep.credited_micro_usd ?? 0),
        rateE12: dep.credited_rate_e12 === null ? null : BigInt(dep.credited_rate_e12),
        creditedAt: dep.credited_at,
      };
    }

    // Look the address row up BY THE DEPOSIT'S ADDRESS, not by chat_id: the
    // carry belongs to the address, and the deposit may have arrived at an
    // address whose user has since been deleted.
    const addr = db.prepare('SELECT * FROM pcn_addresses WHERE address = ?').get(dep.address);
    if (!addr) throw new Error(`creditDeposit: deposit ${depositId} names an address not in the pool`);

    const amountSat = BigInt(dep.amount_sat);
    const carry = BigInt(addr.remainder_nano_usd);
    const nanoThis = satsToNanoUsd(amountSat, rateE12);

    let micro;
    let remainder;
    let dust = false;

    if (amountSat < minDepositSat) {
      // DUST. Do NOT mark it `rejected`: that is a we-keep-it rule, terminal
      // and unalerted, for money that is already ours. Carry its nano-USD on
      // the address, write a ZERO-USD ledger row so the deposit is visible to
      // every reconciliation and to pcoin-payment-report, and finalise it. The
      // carry flushes at the next real credit for this address.
      dust = true;
      micro = 0n;
      remainder = carry + nanoThis;
    } else {
      const split = splitNano(carry + nanoThis);
      micro = split.micro;
      remainder = split.remainder;
    }

    const idemKey = `pcn:${dep.txid}:${dep.address}`;
    const now = nowSec();

    // LEDGER ROW FIRST. Write it even when micro == 0 -- webbuilderbot skips
    // the zero row, and those deposits are then invisible to every
    // reconciliation and to the payment report.
    try {
      db.prepare(
        `INSERT INTO ledger (chat_id, delta_micro_usd, kind, idem_key, rate_e12, note, created_at)
         VALUES (?,?,?,?,?,?,?)`
      ).run(
        dep.chat_id,
        Number(micro),
        'deposit_pcn',
        idemKey,
        Number(rateE12),
        dust ? 'dust below minimum; carried on the address' : null,
        now
      );
    } catch (e) {
      if (isUniqueViolation(e)) {
        // The money already moved under this key on an earlier attempt whose
        // outcome we lost. Nothing has moved in THIS transaction.
        throw Object.assign(new Error('ledger key already applied'), { duplicate: true });
      }
      throw e;
    }

    if (micro > 0n && dep.chat_id !== null) {
      const upd = db.prepare(
        'UPDATE users SET balance_micro_usd = balance_micro_usd + ? WHERE chat_id = ?'
      ).run(Number(micro), dep.chat_id);
      if (upd.changes !== 1) {
        throw new Error(`creditDeposit: no users row for chat of deposit ${depositId}`);
      }
    }

    db.prepare('UPDATE pcn_addresses SET remainder_nano_usd = ? WHERE id = ?')
      .run(Number(remainder), addr.id);

    db.prepare(
      `UPDATE pcn_deposits
          SET status = 'credited',
              credited_micro_usd = ?,
              credited_rate_e12 = ?,
              credited_rate_text = ?,
              credited_rate_source = ?,
              credited_rate_at = ?,
              confirmations_at_credit = ?,
              block_hash = COALESCE(?, block_hash),
              is_coinbase = COALESCE(?, is_coinbase),
              credited_at = ?,
              note = COALESCE(note, ?)
        WHERE id = ?`
    ).run(
      Number(micro),
      Number(rateE12),
      rate.rateText ?? null,
      rate.source === 'cache' ? 'cache' : 'oracle',
      rate.readAt ?? now,          // when the rate was READ, != credited_at
      observed && Number.isInteger(observed.confirmations) ? observed.confirmations : dep.confirmations_at_credit ?? null,
      observed && typeof observed.blockHash === 'string' ? observed.blockHash : dep.block_hash ?? null,
      observed && typeof observed.isCoinbase === 'boolean' ? (observed.isCoinbase ? 1 : 0) : null,
      now,
      dust ? 'dust: carried, zero USD credited' : null,
      depositId
    );

    // The rebate is a BONUS on top of a credit that has already succeeded. It
    // must never be the reason a real payment fails to land, so a fault here is
    // recorded and swallowed rather than rolling the deposit back with it.
    let rebate = { granted: 0n, why: 'not attempted' };
    try {
      rebate = rebateFor(db, dep, micro, {
        now, ppm: REBATE.ppm, capSat: REBATE.capSat, from: REBATE.from,
      });
    } catch (e) {
      rebate = { granted: 0n, why: 'failed: ' + (e && e.message ? e.message : String(e)) };
    }

    return { result: CreditResult.CREDITED, microUsd: micro, rateE12, dust, remainder, rebate };
  });
}

// A wrapper that turns the duplicate throw into a result rather than an error,
// because a duplicate is a normal outcome of an idempotent retry.
export function creditDepositSafe(db, depositId, rate, opts) {
  try {
    return creditDeposit(db, depositId, rate, opts);
  } catch (e) {
    if (e && e.duplicate) {
      return { result: CreditResult.DUPLICATE, microUsd: 0n, rateE12: null };
    }
    throw e;
  }
}

// ---------------------------------------------------------------- P3 rebate
//
// "10% back when you spend PCN here", paid as CREDIT AT THIS SERVICE. Nothing
// is sent, no address is collected, and the user gets it immediately -- which
// is the whole reason this shape was chosen: no rail stores a PCN address that
// the user controls, so there is nowhere to send a coin even if we wanted to.
//
// SWITCHED OFF BY DEFAULT. rebatePpm is 0 unless the operator sets it, so
// deploying this code changes nothing until somebody decides it should.
//
// THREE THINGS IT MUST NEVER DO, in order of how much they would cost:
//
//   1. Break a deposit. The rebate runs inside the credit's transaction, so a
//      throw here would roll back the CREDIT -- the money-critical path -- and
//      leave a real payment uncredited. Every call site therefore catches.
//   2. Pay twice. Keyed on the deposit that earned it, so the UNIQUE(idem_key)
//      that already guards deposits guards this too. A replay throws before
//      anything moves.
//   3. Overpay. The monthly cap is read INSIDE the same transaction, so two
//      deposits landing together cannot both see an empty allowance.
//
// The cap is expressed in PCN and computed from amount_sat, never from a rate:
// the rebate is always 10% of the coins sent, so the PCN arithmetic needs no
// oracle and cannot drift with the price.
export function rebateFor(db, dep, micro, { now, ppm, capSat, from }) {
  if (ppm <= 0n) return { granted: 0n, why: 'off' };
  if (from <= 0n || BigInt(now) < from) return { granted: 0n, why: 'before the start date' };
  if (micro <= 0n) return { granted: 0n, why: 'nothing was credited' };
  if (dep.chat_id === null || dep.chat_id === undefined) return { granted: 0n, why: 'no account to credit' };

  const wanted = (micro * ppm) / 1000000n;
  if (wanted <= 0n) return { granted: 0n, why: 'rounds to zero' };

  // What this person has already had rebated, this calendar month, in PCN.
  // Joined through the idem_key rather than a flag column, because the ledger
  // row IS the record -- a flag can disagree with it, a key cannot.
  const monthStart = BigInt(Math.floor(new Date(new Date(Number(now) * 1000)
    .toISOString().slice(0, 7) + '-01T00:00:00Z').getTime() / 1000));
  const used = db.prepare(
    `SELECT COALESCE(SUM(d.amount_sat), 0) AS sat
       FROM pcn_deposits d
       JOIN ledger l ON l.idem_key = 'rebate:' || d.txid || ':' || d.address
      WHERE d.chat_id = ? AND l.created_at >= ?`
  ).get(dep.chat_id, Number(monthStart));
  const usedSat = (BigInt(used.sat) * ppm) / 1000000n;
  const thisSat = (BigInt(dep.amount_sat) * ppm) / 1000000n;
  if (usedSat >= capSat) return { granted: 0n, why: 'monthly cap already reached' };

  let grant = wanted;
  if (usedSat + thisSat > capSat) {
    // Pro-rate in the same proportion the PCN was cut, so the USD and the PCN
    // never tell different stories about the same rebate.
    const allowed = capSat - usedSat;
    grant = thisSat > 0n ? (wanted * allowed) / thisSat : 0n;
    if (grant <= 0n) return { granted: 0n, why: 'monthly cap already reached' };
  }

  db.prepare(
    `INSERT INTO ledger (chat_id, delta_micro_usd, kind, idem_key, rate_e12, note, created_at)
     VALUES (?,?,?,?,?,?,?)`
  ).run(dep.chat_id, Number(grant), 'adjust', `rebate:${dep.txid}:${dep.address}`,
        null, 'P3: 10% back on PCN spent here', Number(now));
  const upd = db.prepare('UPDATE users SET balance_micro_usd = balance_micro_usd + ? WHERE chat_id = ?')
    .run(Number(grant), dep.chat_id);
  if (upd.changes !== 1) throw new Error('rebate: no users row for chat ' + dep.chat_id);
  return { granted: grant, why: grant < wanted ? 'capped' : 'full' };
}

// The reconciliation invariant, per user. Checked every tick.
//
//   SUM(ledger.delta_micro_usd) == balance_micro_usd + reserved_micro_usd
//   reserved_micro_usd          == SUM(reservations.micro_usd WHERE state='open')
//
// Reserve moves balance->reserved and writes no ledger row; settle writes one
// negative ai_turn row and releases the remainder; a full release writes
// nothing. The arithmetic closes. This single check catches an orphaned
// reservation, a settle that overran, and a bad migration.
export function reconcile(db) {
  const drifts = db.prepare(
    `SELECT u.chat_id,
            u.balance_micro_usd,
            u.reserved_micro_usd,
            COALESCE((SELECT SUM(l.delta_micro_usd) FROM ledger l WHERE l.chat_id = u.chat_id), 0) AS ledger_sum,
            COALESCE((SELECT SUM(r.micro_usd) FROM reservations r
                       WHERE r.chat_id = u.chat_id AND r.state = 'open'), 0) AS open_resv
       FROM users u`
  ).all();

  const bad = [];
  for (const r of drifts) {
    if (r.ledger_sum !== r.balance_micro_usd + r.reserved_micro_usd) {
      bad.push({
        chat_id: r.chat_id,
        kind: 'ledger_vs_balance',
        ledger_sum: r.ledger_sum,
        balance: r.balance_micro_usd,
        reserved: r.reserved_micro_usd,
      });
    }
    if (r.reserved_micro_usd !== r.open_resv) {
      bad.push({
        chat_id: r.chat_id,
        kind: 'reserved_vs_open',
        reserved: r.reserved_micro_usd,
        open_resv: r.open_resv,
      });
    }
  }
  return { ok: bad.length === 0, drifts: bad, usersChecked: drifts.length };
}

// 30-day totals, SUMMED FROM THE DEPOSIT ROWS rather than read off a counter
// column. A counter drifts and nothing notices; the rows are the fact.
export function creditedUsdLast30Days(db, chatId = null) {
  const since = nowSec() - 30 * 86400;
  if (chatId === null) {
    const r = db.prepare(
      `SELECT COALESCE(SUM(credited_micro_usd),0) AS m FROM pcn_deposits
        WHERE status='credited' AND credited_at >= ?`
    ).get(since);
    return BigInt(r.m);
  }
  const r = db.prepare(
    `SELECT COALESCE(SUM(credited_micro_usd),0) AS m FROM pcn_deposits
      WHERE status='credited' AND credited_at >= ? AND chat_id = ?`
  ).get(since, chatId);
  return BigInt(r.m);
}
