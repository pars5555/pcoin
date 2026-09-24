// ═══════════════════════════════════════════════════════════════════════════
// The PCN index relay -- price plan Phase 2 (D:\pc.am\PCOIN-PRICE-EXCHANGE-ANCHOR-PLAN.md)
// ═══════════════════════════════════════════════════════════════════════════
//
// exchange.pc.am computes one PCN price from qualifying user-to-user fills and
// publishes it at /api/index. price.pc.am relays it as a SECOND, UNUSED field so
// a week of it can be judged beside the rate the rails really credit at. Nothing
// credits with it in this phase.
//
// Everything here is pure: no clock, no network, no state. The server hands in
// the time and the previous reading, and gets back a decision. That is what lets
// every refusal below be proved to fire (index-relay-test.mjs) instead of hoped.
//
// WHY price.pc.am CHECKS AGAIN
// The exchange already caps its own moves (2% a fill, 5% a day). A check that
// only the writer performs is not a check: an exchange bug, or a compromise of
// that one box, would otherwise walk straight into the number six payment rails
// will one day credit at. So this side keeps its OWN memory of what it accepted
// and refuses anything that moved faster than the exchange's rules allow, with a
// little headroom (2.5% a step, 5.5% a day) so rounding can never trip it.

export const INDEX_RULES = Object.freeze({
  maxAgeS: 120,        // a reading computed longer ago than this is not current
  skewS: 30,           // how far in the FUTURE computedAt may be (clock skew)
  stepPct: 2.5,        // per seq step, either direction
  dayPct: 5.5,         // against the extremes this side accepted in 24 h
  floorUsd: 0.015,     // the published floor, same number as rateFloorUsd
  ceilingUsd: 0.10,    // the plan's ceiling (decision D8)
});

const PRICED = new Set(['held', 'live', 'frozen']);
const STATES = new Set([...PRICED, 'unknown']);
const NANO = 1e9;

const short = (xs, n = 5, len = 200) =>
  (Array.isArray(xs) ? xs : []).filter((x) => typeof x === 'string').slice(0, n).map((x) => x.slice(0, len));

function windowOf(w) {
  if (!w || typeof w !== 'object') return null;
  const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : null);
  return {
    hours: num(w.hours), trades: num(w.trades), entities: num(w.entities),
    countedPcn: typeof w.countedPcn === 'string' ? w.countedPcn.slice(0, 32) : null,
    countedUsd: typeof w.countedUsd === 'string' ? w.countedUsd.slice(0, 32) : null,
    qualifies: w.qualifies === true,
  };
}

/** Is this body from /api/index a reading we can use at all?
 *
 *  Returns { ok: true, reading } or { ok: false, kind, why }. kind is
 *  'disabled' (the owner switched the index off -- a fact, not a fault),
 *  'stale' or 'invalid'. An 'unknown' state from the exchange IS a valid
 *  reading: it is the exchange correctly saying it has no price, and it is
 *  relayed as such -- with no price attached, never with the last one. */
export function validateIndexBody(j, { nowS, rules = INDEX_RULES } = {}) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { ok: false, kind: 'invalid', why: 'the body is not a JSON object' };
  if (j.enabled === false) return { ok: true, reading: { state: 'disabled', nano: null, usd: null, seq: null, computedAt: null } };
  if (j.enabled !== true) return { ok: false, kind: 'invalid', why: '"enabled" is missing' };
  if (!STATES.has(j.state)) return { ok: false, kind: 'invalid', why: `unrecognised state ${JSON.stringify(j.state)}` };

  const at = Number(j.computedAt);
  if (!Number.isSafeInteger(at) || at <= 0) return { ok: false, kind: 'invalid', why: 'computedAt is missing or not a time' };
  // Measured on OUR clock, never the exchange's own ageSeconds: a stuck
  // exchange clock would report every reading as fresh.
  const age = nowS - at;
  if (age > rules.maxAgeS) return { ok: false, kind: 'stale', why: `computed ${age} s ago (more than ${rules.maxAgeS})` };
  if (age < -rules.skewS) return { ok: false, kind: 'invalid', why: `computedAt is ${-age} s in the future` };

  const base = {
    state: j.state, computedAt: at,
    lastMoveAt: Number.isSafeInteger(Number(j.lastMoveAt)) && j.lastMoveAt !== null ? Number(j.lastMoveAt) : null,
    window: windowOf(j.window), limitedBy: short(j.limitedBy), reasons: short(j.reasons, 3),
  };
  if (j.state === 'unknown') return { ok: true, reading: { ...base, nano: null, usd: null, seq: null } };

  if (typeof j.nano !== 'string' || !/^[1-9][0-9]{0,15}$/.test(j.nano)) return { ok: false, kind: 'invalid', why: 'nano is not a positive integer string' };
  const nano = Number(j.nano);
  // Two spellings of one number must agree; a body where they do not was not
  // produced by the code we reviewed.
  if (typeof j.usd !== 'string' || Math.abs(Number(j.usd) * NANO - nano) > 0.5) {
    return { ok: false, kind: 'invalid', why: `usd ${JSON.stringify(j.usd)} does not match nano ${j.nano}` };
  }
  const seq = Number(j.seq);
  if (!Number.isSafeInteger(seq) || seq < 0) return { ok: false, kind: 'invalid', why: 'seq is not a non-negative integer' };
  if (nano < Math.round(rules.floorUsd * NANO)) return { ok: false, kind: 'invalid', why: `$${j.usd} is below the $${rules.floorUsd} floor` };
  if (nano > Math.round(rules.ceilingUsd * NANO)) return { ok: false, kind: 'invalid', why: `$${j.usd} is above the $${rules.ceilingUsd} ceiling` };
  return { ok: true, reading: { ...base, nano, usd: nano / NANO, seq } };
}

const keyOf = (r) => `${r.state}|${r.seq}|${r.nano}`;

/** The transient guard, same rule as ladderPriceConfirmed(): a reading is
 *  believed only when two consecutive polls agree on it. A value seen once and
 *  never again -- a test fill, a half-written row -- becomes unobservable. */
export function confirmTwice(pending, reading) {
  const key = keyOf(reading);
  if (pending && pending.key === key) return { confirmed: true, pending };
  return { confirmed: false, pending: { key } };
}

/** The independent speed check. `prev` is the last reading THIS side accepted
 *  with a price ({nano, seq}); `history` is [{t, nano}] of accepted prices.
 *  Returns { ok: true } or { ok: false, why }. */
export function speedCheck({ prev, history = [], reading, nowS, rules = INDEX_RULES }) {
  if (!PRICED.has(reading.state)) return { ok: true };        // nothing priced to check
  if (!prev || !Number.isFinite(prev.nano) || !Number.isSafeInteger(prev.seq)) return { ok: true }; // first ever: the seed
  if (reading.seq < prev.seq) return { ok: false, why: `seq went backwards (${prev.seq} -> ${reading.seq})` };
  if (reading.seq === prev.seq && reading.nano !== prev.nano) {
    return { ok: false, why: `the price changed ($${prev.nano / NANO} -> $${reading.usd}) without a new seq` };
  }
  const steps = reading.seq - prev.seq;
  if (steps > 0) {
    const ratio = reading.nano / prev.nano;
    const up = (1 + rules.stepPct / 100) ** steps, down = (1 - rules.stepPct / 100) ** steps;
    if (ratio > up || ratio < down) {
      return { ok: false, why: `moved ${((ratio - 1) * 100).toFixed(2)}% in ${steps} step(s); at most ${rules.stepPct}% a step is allowed` };
    }
  }
  const cut = nowS - 86400;
  const seen = [prev.nano, ...history.filter((h) => h && h.t >= cut && Number.isFinite(h.nano)).map((h) => h.nano)];
  const hi = Math.max(...seen), lo = Math.min(...seen);
  if (reading.nano > lo * (1 + rules.dayPct / 100)) {
    return { ok: false, why: `$${reading.usd} is ${((reading.nano / lo - 1) * 100).toFixed(2)}% above the 24 h low $${lo / NANO}; at most ${rules.dayPct}% a day` };
  }
  if (reading.nano < hi * (1 - rules.dayPct / 100)) {
    return { ok: false, why: `$${reading.usd} is ${((1 - reading.nano / hi) * 100).toFixed(2)}% below the 24 h high $${hi / NANO}; at most ${rules.dayPct}% a day` };
  }
  return { ok: true };
}

/** Append an accepted price to the 24 h memory: on every change, and otherwise
 *  at most every ten minutes, trimmed to 25 h and 400 points. */
export function remember(history, { t, nano }) {
  const xs = (Array.isArray(history) ? history : []).filter((h) => h && h.t >= t - 25 * 3600);
  const last = xs[xs.length - 1];
  if (!last || last.nano !== nano || t - last.t >= 600) xs.push({ t, nano });
  return xs.slice(-400);
}
