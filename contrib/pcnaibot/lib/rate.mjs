// The rate oracle: https://price.pc.am
//
// Read `creditRateUsd` -- the field the oracle NOMINATES, in `rateFieldToUse`.
// `serviceRate` is still read alongside it and a disagreement is alerted on;
// this rail credited from serviceRate until 2026-09-17, and the two have been
// identical every time they were compared, but only one of them is nominated.
//
// NEVER `price` -- that is the ladder's marginal rung, what the next PCN COSTS
// TO BUY, and the docs call confusing the two "the mistake waiting to be made".
// NEVER PancakeSwap: ~$34 of selling moves it -10%, so reading it as a price
// lets anyone who spends $20 set our credit rate.
//
// THE RATE IS TAKEN FROM THE RESPONSE TEXT, NOT FROM JSON.parse. Parsing first
// turns 0.03590242147375549 into a double, and quantising that back out with
// toFixed(12) ROUNDS UP (...474) where the spec says floor (...473). Pulling
// the literal out of the body keeps the float out of the money path entirely.
//
// THREE CLOCKS, THREE INDEPENDENT BOUNDS. Reusing one bound for two of them
// means tightening one destroys the other:
//   * stale / stateAgeSeconds -- the REPLICA's sync. price.pc.am has three
//     origins behind Cloudflare and one served a month-old build for weeks, so
//     `role` and `at` also tell you WHICH origin answered.
//   * ladder.stale / ladder.ageSeconds -- whether the PRICE is usable. Computed
//     from the ladder poll age alone; it says NOTHING about the pool sampler.
//   * pool.ageSeconds -- the third. serviceRate is exactly pool.medianUsd today
//     and `rateFollowsPoolDown` is true, so if the market service keeps
//     answering while the pool sampler dies, serviceRate FREEZES at a median
//     taken before whatever moved the pool, a two-clock gate passes, and -- since
//     the rate follows the pool DOWN -- a frozen rate is a rate that is too high
//     and WE OVER-CREDIT.

import { rateToE12 } from './money.mjs';
import { nowSec } from './time.mjs';
import { log } from './log.mjs';

// A tiny store interface -- { getJson(key), setJson(key, value) } -- rather than
// an import of db.mjs. That keeps the validator (and its adversarial tests)
// runnable without the native sqlite module, which is the difference between a
// test suite that runs everywhere and one that only runs on the server.

const KV_LAST_ACCEPTED = 'rate:last_accepted';
const KV_CACHE = 'rate:cache';

// The oracle answered, and the answer is not usable. This is a DIFFERENT
// outcome from "the oracle was unreachable", and the difference is the whole
// point: shipped wrong in exactly this form once, every band and staleness
// violation threw, landed in the generic catch, and came back out usable:true
// FROM CACHE. The cache was filled by the same oracle, so falling back to it
// LAUNDERS THE READING YOU JUST REFUSED.
export class RateInsane extends Error {
  constructor(reason) {
    super(`rate refused: ${reason}`);
    this.name = 'RateInsane';
    this.reason = reason;
  }
}

// Pull a numeric literal for `key` out of raw JSON text, as a STRING.
// Anchored on the key so a value elsewhere in the document cannot match.
function rawNumber(text, key) {
  const re = new RegExp(`"${key}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?(?:[eE][-+]?\\d+)?)`);
  const m = re.exec(text);
  return m ? m[1] : null;
}

// A number that must be present AND numeric. Absent or non-numeric is UNKNOWN
// and is refused -- never read as 0. `?? 0` on a value that may not exist is
// the exact shape rule 3 warns about.
function requireFiniteNumber(v, what) {
  if (v === undefined || v === null) throw new RateInsane(`${what} is absent (unknown, not zero)`);
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new RateInsane(`${what} is not a finite number`);
  return v;
}

export function validateRateBody(text, { maxStateAgeS, maxLadderAgeS, maxPoolAgeS, maxJumpFactor }, lastAccepted) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    // A body we cannot decode is unreadable, not insane. Let the caller's
    // generic arm treat it as unreachable so a recent cache may stand in.
    throw new Error('price oracle body did not decode as JSON');
  }

  // --- check 1/2: the rate itself, from the TEXT -------------------------
  //
  // WHICH FIELD IS THE CREDIT RATE. price.pc.am publishes `serviceRate` and
  // `creditRateUsd`, and names the one integrators are to use in a third field,
  // `rateFieldToUse` -- which reads "creditRateUsd". This rail read
  // `serviceRate`. The two have been identical every time they have been
  // compared, so nobody has ever been over- or under-credited, but they are
  // separate fields and only one of them is nominated.
  //
  // Both are still read, so a divergence is REPORTED rather than discovered in
  // somebody's balance. The oracle changing which field it nominates is
  // reported too: silently following a renamed field is how a rail starts
  // crediting from a number nobody chose.
  const creditStr = rawNumber(text, 'creditRateUsd');
  const serviceStr = rawNumber(text, 'serviceRate');
  const rateStr = creditStr ?? serviceStr;
  const fieldUsed = creditStr !== null ? 'creditRateUsd' : 'serviceRate';
  if (rateStr === null) throw new RateInsane('neither creditRateUsd nor serviceRate is present');
  const rateNum = Number(rateStr);
  if (!Number.isFinite(rateNum)) throw new RateInsane(`${fieldUsed} is not finite`);
  if (rateNum <= 0) throw new RateInsane(`${fieldUsed} is not positive (${rateStr})`);
  if (rateNum < 1e-7 || rateNum > 1.0) throw new RateInsane(`${fieldUsed} ${rateStr} outside band [1e-7, 1.0]`);

  // A named field we do NOT honour is a fact worth surfacing, not a refusal:
  // refusing here would stop the rail crediting over a naming change.
  const fieldNamed = typeof body.rateFieldToUse === 'string' ? body.rateFieldToUse : null;
  const diverged = creditStr !== null && serviceStr !== null && creditStr !== serviceStr;

  // --- check 3: no more than a 10x jump vs the last ACCEPTED rate --------
  // Against the last reading we ACCEPTED, not the last reading we took: a
  // sequence of refused readings must not walk the guard along with them.
  if (lastAccepted && Number.isFinite(lastAccepted.rate) && lastAccepted.rate > 0) {
    const f = rateNum / lastAccepted.rate;
    if (f > maxJumpFactor || f < 1 / maxJumpFactor) {
      throw new RateInsane(`${fieldUsed} moved ${f.toFixed(3)}x vs last accepted (limit ${maxJumpFactor}x)`);
    }
  }

  // TWO BODY SHAPES, 2026-09-25. The owner: "simplify the price.pc.am json
  // response ... check every service which field is using ... fix all". The
  // root body becomes { creditRateUsd, sellPriceUsd, poolUsd, floorUsd, state,
  // seq, stale, ageSeconds, at }: no `ladder`, no `stateAgeSeconds`, no pool
  // block. Its top-level `ageSeconds` is the age of creditRateUsd itself and its
  // `stale` is the one HOLD flag, with the replica's sync folded in. The oracle
  // ADDS those fields first and REMOVES the old ones later, so each clock below
  // is checked wherever it is published, and a body carrying NO clock for the
  // rate or the replica is refused exactly as an absent block always was.
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RateInsane('the body is not a JSON object');
  const hasLadder = 'ladder' in body;
  const hasRateAge = body.ageSeconds !== undefined;

  // --- check 4: the rate's clock, on its OWN bound -----------------------
  // Today's body: the ladder block (in index mode its stale flag follows the
  // index). A `ladder` key that is present but null still refuses, as before.
  if (hasLadder) {
    const ladder = body.ladder;
    if (!ladder || typeof ladder !== 'object') throw new RateInsane('ladder block is absent');
    const ladderAge = requireFiniteNumber(ladder.ageSeconds, 'ladder.ageSeconds');
    if (ladder.stale !== false) throw new RateInsane(`ladder.stale is ${JSON.stringify(ladder.stale)}`);
    if (ladderAge > maxLadderAgeS) throw new RateInsane(`ladder.ageSeconds ${ladderAge} > ${maxLadderAgeS}`);
  }
  // The minimal body: top-level ageSeconds, on the same bound. Required when
  // there is no ladder block -- then it is the only clock the rate has.
  if (hasRateAge || !hasLadder) {
    const rateAge = requireFiniteNumber(body.ageSeconds, 'ageSeconds');
    if (rateAge > maxLadderAgeS) throw new RateInsane(`ageSeconds ${rateAge} > ${maxLadderAgeS}`);
  }

  // --- check 5: the replica clock, on its OWN bound ----------------------
  // `stale` is in both shapes and must be literally false in both.
  if (body.stale !== false) throw new RateInsane(`stale is ${JSON.stringify(body.stale)}`);
  // stateAgeSeconds is today's body only. Absent is accepted ONLY beside the
  // minimal body's ageSeconds, whose `stale` already carries the sync.
  if (body.stateAgeSeconds !== undefined || !hasRateAge) {
    const stateAge = requireFiniteNumber(body.stateAgeSeconds, 'stateAgeSeconds');
    if (stateAge > maxStateAgeS) throw new RateInsane(`stateAgeSeconds ${stateAge} > ${maxStateAgeS}`);
  }

  // --- check 6: the pool clock, but only when the rate follows the pool --
  // A `pool` of null while rateFollowsPoolDown is true is UNKNOWN, not "the
  // pool does not matter".
  if (body.rateFollowsPoolDown === true) {
    const pool = body.pool;
    if (!pool || typeof pool !== 'object') {
      throw new RateInsane('rateFollowsPoolDown is true but pool block is absent or null');
    }
    const poolAge = requireFiniteNumber(pool.ageSeconds, 'pool.ageSeconds');
    if (poolAge > maxPoolAgeS) throw new RateInsane(`pool.ageSeconds ${poolAge} > ${maxPoolAgeS}`);
    requireFiniteNumber(pool.medianUsd, 'pool.medianUsd');
  }

  return {
    rateText: rateStr,
    rate: rateNum,
    rateE12: rateToE12(rateStr), // from the STRING: floor, no double involved
    // `floorUsd` in the minimal body (2026-09-25), `rateFloorUsd` before it.
    rateFloorUsd: typeof body.rateFloorUsd === 'number' ? body.rateFloorUsd
      : typeof body.floorUsd === 'number' ? body.floorUsd : null,
    role: typeof body.role === 'string' ? body.role : null,
    at: typeof body.at === 'string' ? body.at : null,
    buybackOpen: body.buybackOpen === true,
    // Which field the money came from, and whether the other one disagreed.
    // Carried out of here so the caller can say so ONCE, loudly, rather than
    // this file deciding on its own what is worth waking somebody for.
    fieldUsed,
    fieldNamed,
    diverged,
    creditRateText: creditStr,
    serviceRateText: serviceStr,
  };
}

export async function readRate(store, cfg, { fetchImpl = fetch } = {}) {
  const url = cfg.strOr('PRICE_URL', 'https://price.pc.am');
  const bounds = {
    maxStateAgeS: cfg.num('RATE_MAX_STATE_AGE_S', 900),
    maxLadderAgeS: cfg.num('RATE_MAX_LADDER_AGE_S', 900),
    maxPoolAgeS: cfg.num('RATE_MAX_POOL_AGE_S', 900),
    maxJumpFactor: cfg.num('RATE_MAX_JUMP_FACTOR', 10),
  };
  const cacheMaxAge = cfg.num('RATE_CACHE_MAX_AGE_S', 21600); // 6h hard ceiling

  const lastAccepted = store.getJson(KV_LAST_ACCEPTED);

  let text;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetchImpl(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`price oracle HTTP ${res.status}`);
      text = await res.text();
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    // UNREACHABLE. A recent cache is a legitimate stand-in here, because we
    // never got an answer to refuse.
    //
    // This line said `db` until 2026-09-16 -- a name that does not exist in
    // this function. So the ONE branch whose whole job is to soften an oracle
    // outage threw a ReferenceError instead, which propagated out of the tick
    // and killed the watcher: no deposit credited while price.pc.am was down,
    // and the owner paged. The safety path was the only path never tested.
    return fromCache(store, cacheMaxAge, `unreachable: ${e.message}`);
  }

  let reading;
  try {
    reading = validateRateBody(text, bounds, lastAccepted);
  } catch (e) {
    if (e instanceof RateInsane) {
      // ANSWERED, AND THE ANSWER IS INSANE. Refuse, and DO NOT CACHE-FALL-BACK:
      // the cache was filled by this same oracle.
      return { usable: false, source: null, reason: e.reason };
    }
    // Body did not decode -- treat as unreachable.
    return fromCache(store, cacheMaxAge, `undecodable: ${e.message}`);
  }

  // THE TWO RATE FIELDS DISAGREED. Not a refusal -- the reading is sound and
  // the oracle nominates the one we used -- but it has never happened, so the
  // first time it does somebody should find out from an alert rather than from
  // a customer's balance.
  if (reading.diverged) {
    log.error('price oracle: creditRateUsd and serviceRate DISAGREE -- crediting from creditRateUsd', {
      creditRateUsd: reading.creditRateText, serviceRate: reading.serviceRateText,
    });
  }
  if (reading.fieldNamed && reading.fieldNamed !== reading.fieldUsed) {
    log.error('price oracle nominates a field we are NOT crediting from', {
      nominated: reading.fieldNamed, using: reading.fieldUsed,
    });
  }
  if (reading.fieldUsed !== 'creditRateUsd') {
    log.warn('creditRateUsd absent; fell back to serviceRate', { using: reading.fieldUsed });
  }

  const now = nowSec();
  const accepted = {
    rate: reading.rate,
    rateText: reading.rateText,
    rateE12: reading.rateE12.toString(),
    at: now,
  };
  store.setJson(KV_LAST_ACCEPTED, accepted);
  store.setJson(KV_CACHE, accepted);

  return {
    usable: true,
    source: 'oracle',
    rate: reading.rate,
    rateText: reading.rateText,
    rateE12: reading.rateE12,
    readAt: now,
    role: reading.role,
    rateFloorUsd: reading.rateFloorUsd,
    buybackOpen: reading.buybackOpen,
  };
}

function fromCache(store, cacheMaxAge, why) {
  const c = store.getJson(KV_CACHE);
  if (!c || !Number.isFinite(c.at)) return { usable: false, source: null, reason: why };
  const age = nowSec() - c.at;
  // An EXPIRED entry is UNKNOWN. A cache with no expiry is a hardcoded rate
  // that took longer to write.
  if (age > cacheMaxAge) {
    return { usable: false, source: null, reason: `${why}; cache expired (${age}s)` };
  }
  return {
    usable: true,
    source: 'cache',
    rate: c.rate,
    rateText: c.rateText,
    rateE12: BigInt(c.rateE12),
    readAt: c.at,
    cacheAgeSeconds: age,
    reason: why,
  };
}

// Floor parity is a TIMER CHECK, never a credit gate.
//
// At M=3.0 the invariant serviceRate/rateFloorUsd <= M holds while serviceRate
// <= $0.045. serviceCeiling is 10.00 by design and a sustained rise crosses
// $0.045 in about three hourly retunes -- at which point a credit-path
// assertion would STOP CREDITING EVERY DEPOSIT, keeping coins that are already
// ours and giving nothing back, while rows sit in `confirming` and the only
// alarm is a 6-hour stuck check. "Make it refuse" means refusing the thing you
// can still stop -- publishing a price list -- not keeping a customer's coins
// because a margin ratio moved. At credit time: CREDIT AND FLAG.
export function floorParity(rate, rateFloorUsd, margin) {
  if (!Number.isFinite(rate) || !Number.isFinite(rateFloorUsd) || rateFloorUsd <= 0) {
    return { evaluable: false, ok: null, ratio: null };
  }
  const ratio = rate / rateFloorUsd;
  return { evaluable: true, ok: ratio <= margin, ratio };
}

// The store shape readRate expects, backed by the kv table.
export function kvStore(db, kv) {
  return {
    getJson: (k) => kv.getJson(db, k),
    setJson: (k, v) => kv.setJson(db, k, v),
  };
}
