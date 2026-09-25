// ═══════════════════════════════════════════════════════════════════════════
// The PCN index relay -- price plan Phase 2 (D:\pc.am\PCOIN-PRICE-EXCHANGE-ANCHOR-PLAN.md)
// ═══════════════════════════════════════════════════════════════════════════
//
// exchange.pc.am computes one PCN price from qualifying user-to-user fills and
// publishes it at /api/index. price.pc.am relays it as a SECOND, UNUSED field so
// a week of it can be judged beside the rate the rails really credit at. Nothing
// credits with it in this phase.
//
// STEP 4 (plan Phase 3, the bottom of this file): with `useIndex = 1` on the
// primary, the index IS the credit rate. Everything that decides what the rails
// then see -- is the index usable, the clamp, the switch's precondition, the
// `ladder` compatibility block, the `note` -- is here and pure for the same
// reason as the rest: so each rule is proved to fire, not hoped.
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

// The exchange's own speed caps, as it publishes them in `rules`. Relayed so the
// index-mode `note` can quote them instead of retyping them: a number on a
// public page is a promise, and a copy of a setting that lives on another box
// goes stale the day somebody changes the setting. Absent or odd -> null, and
// the note then says "capped" without a figure rather than inventing one.
function rulesOf(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  const pct = (x) => (typeof x === 'number' && Number.isFinite(x) && x > 0 && x <= 100 ? x : null);
  return { perTradePct: pct(r.perTradePct), perDayPct: pct(r.perDayPct) };
}

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
    rules: rulesOf(j.rules),
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

// ═══════════════════════════════════════════════════════════════════════════
// Step 4 -- the credit rate IS the index (useIndex = 1)
// ═══════════════════════════════════════════════════════════════════════════
//
// The owner decided on 2026-09-25 to switch now. From then on creditRateUsd =
// serviceRate = the relayed index, with no walk, and every rail reads the same
// fields it read before: only the SOURCE of the value changes (plan §7).

/** Is the relayed `index` block (server.mjs indexBlock()) usable as THE price?
 *
 *  Fresh on this side's clock AND in a priced state. `index.stale` alone is not
 *  enough: a fresh `unknown` reading is not stale -- it is the exchange saying,
 *  correctly and just now, that it has no price -- and plan §2.4 says the rails
 *  HOLD on unknown. A remembered price must never stand in for "no price". */
export function indexUsable(block) {
  return !!block && typeof block === 'object' && block.stale === false && PRICED.has(block.state)
    && typeof block.usd === 'number' && Number.isFinite(block.usd) && block.usd > 0;
}

/** The credit rate for an index price, clamped to [floorUsd, ceilingUsd].
 *
 *  The ceiling is applied LAST, so it wins if the two ever cross -- the same
 *  order retuneServiceRate() applies them in. A bound that is not a positive
 *  number is no bound (a zero ceiling would publish a rate of zero, which is an
 *  answer-shaped unknown). null for anything that is not a positive price: the
 *  caller then leaves the rate where it is. */
export function rateFromIndex(usd, { floorUsd, ceilingUsd } = {}) {
  if (!(typeof usd === 'number' && Number.isFinite(usd) && usd > 0)) return null;
  let r = usd;
  if (Number.isFinite(floorUsd) && floorUsd > 0) r = Math.max(r, floorUsd);
  if (Number.isFinite(ceilingUsd) && ceilingUsd > 0) r = Math.min(r, ceilingUsd);
  return r;
}

export const SWITCH_MAX_GAP_PCT = 0.5;

/** May the rails be switched onto the index NOW? Plan Step 4's precondition,
 *  ENFORCED by the switch rather than left in a runbook: "a check that only
 *  prints is not a check. Make it refuse" (CLAUDE.md §7.12).
 *
 *    1. the index is usable -- fresh, priced, and no reading being refused.
 *       `force` does NOT skip this: switching onto an index that cannot be read
 *       stops every rail at once (/credit-rate 503), which nobody means to do.
 *    2. |serviceRate - index| / index < 0.5%, so the flip is invisible to rails.
 *    3. market.pc.am sells at or above the index. The rule since 13195a7 is that
 *       a rail never credits more for a PCN than the project charges for one;
 *       once the walk is off nothing else enforces it, and the plan relies on
 *       Step 3 (market = index x 1.03) having happened first.
 *
 *  `force` skips 2 and 3 only: the operator saying "I have looked at it
 *  myself", the same meaning it has on /admin/retune. */
export function switchCheck({ block, serviceRate, sellPriceUsd, force = false, maxGapPct = SWITCH_MAX_GAP_PCT }) {
  if (!indexUsable(block)) {
    const why = !block ? 'price.pc.am has never had an index reading'
      : block.stale !== false ? `the index is stale (computed ${block.ageSeconds ?? '?'} s ago; the limit is indexMaxAgeSeconds)`
      : `the index is "${block.state}", which carries no price`;
    return { ok: false, why: `refused: ${why}. Switching now would make every rail hold (GET /credit-rate 503).` };
  }
  if (block.refused) {
    return { ok: false, why: `refused: price.pc.am is refusing the latest index reading (${block.refused.why}). Resolve that first.` };
  }
  const gapPct = (Math.abs(serviceRate - block.usd) / block.usd) * 100;
  const facts = { indexUsd: block.usd, indexSeq: block.seq, serviceRate, sellPriceUsd,
                  gapPct: Number.isFinite(gapPct) ? Number(gapPct.toFixed(4)) : null };
  if (!force) {
    if (!(gapPct < maxGapPct)) {
      return { ok: false, ...facts, why: `refused: the credit rate ${serviceRate} is ` +
        `${Number.isFinite(gapPct) ? gapPct.toFixed(3) : '?'}% from the index ${block.usd}; the switch needs under ` +
        `${maxGapPct}% so the rails see no jump. Wait for the walk to close it, or pass "force": true.` };
    }
    if (!(typeof sellPriceUsd === 'number' && Number.isFinite(sellPriceUsd) && sellPriceUsd >= block.usd)) {
      return { ok: false, ...facts, why: `refused: market.pc.am sells at ${sellPriceUsd ?? 'an unknown price'}, below ` +
        `the index ${block.usd}, so the rails would credit more than the project charges. Put the market on the ` +
        'index first (plan Step 3), or pass "force": true.' };
    }
  }
  return { ok: true, ...facts, forced: !!force };
}

/** The `ladder` block in index mode (plan §2.6): a COMPATIBILITY block.
 *
 *  pcnaibot (lib/rate.mjs), every docs.pc.am integration ("ladder.stale is
 *  honoured") and the exchange's fetchSellPrice() all REQUIRE
 *  `ladder.stale === false` before they use this feed. In index mode the number
 *  the rails credit at is the index, so the flag they gate on follows the index:
 *  stale whenever the index is not usable (stale, unknown, disabled, absent).
 *  `price` is sellPriceUsd, what market.pc.am charges -- never a credit rate. */
export function indexLadder({ block, sellPriceUsd, soldPcn, remainingPcn }) {
  return {
    price: sellPriceUsd,
    soldPcn,
    remainingPcn,
    ageSeconds: block && Number.isFinite(block.ageSeconds) ? block.ageSeconds : null,
    stale: !indexUsable(block),
  };
}

/** The `note` in index mode. Plain words, no code formatting: the pc.am mini
 *  app shows it to users. Every figure is read from what this service enforces
 *  or relays (floor = rateFloorUsd, ceiling = the relay's own refusal bound,
 *  caps = the exchange's published rules), never retyped. And it names no
 *  exit: this field once ended by telling holders their way out was to wrap and
 *  sell the pool, and on a pool that thin saying so shaped behaviour. */
export function indexNote({ floorUsd, ceilingUsd = INDEX_RULES.ceilingUsd, rules, maxAgeS, buybackOpen }) {
  const perTrade = rules && rules.perTradePct, perDay = rules && rules.perDayPct;
  const caps = perTrade && perDay
    ? `by at most ${perTrade}% per trade and ${perDay}% in 24 hours`
    : 'in capped steps (the limits are published at https://exchange.pc.am/api/index)';
  const mins = Math.max(1, Math.round(Number(maxAgeS) / 60) || 10);
  return 'The PCN price is the PCN index: the volume-weighted median price of real user-to-user trades ' +
    'on exchange.pc.am, a small order book the project runs. Trades with the project\'s own bots, and ' +
    `trades between linked accounts, do not count. It moves only when new qualifying trades arrive, ${caps}, ` +
    'and when there is too little trading it holds its last value. It never goes below a floor of $' +
    Number(floorUsd).toFixed(4) + ' or above a ceiling of $' + Number(ceilingUsd).toFixed(2) + '. ' +
    'What PCoin services credit one PCN at (creditRateUsd, also published as serviceRate) is the index ' +
    'itself. sellPriceUsd is what market.pc.am charges for PCN, and it never credits anything. ' +
    `If the index is more than ${mins} minute${mins === 1 ? '' : 's'} old, or the exchange reports it as ` +
    'unknown, GET /credit-rate answers 503 and ladder.stale is true: hold the credit and try again later, ' +
    'never guess a rate. The wPCN PancakeSwap pool is not an input to this price. The ladder block is kept ' +
    'only so older integrations keep working: its price is sellPriceUsd and its stale flag follows the index. ' +
    (buybackOpen
      ? 'Buying PCN back is a separate constant-product curve at a much lower price.'
      : 'This service is not buying PCN back at present.');
}
