// The rate oracle: https://price.pc.am
//
// Read `serviceRate`. NEVER `price` -- that is the ladder's marginal rung, what
// the next PCN COSTS TO BUY, and the docs call confusing the two "the mistake
// waiting to be made". NEVER PancakeSwap: ~$34 of selling moves it -10%, so
// reading it as a price lets anyone who spends $20 set our credit rate.
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
  const rateStr = rawNumber(text, 'serviceRate');
  if (rateStr === null) throw new RateInsane('serviceRate is absent');
  const rateNum = Number(rateStr);
  if (!Number.isFinite(rateNum)) throw new RateInsane('serviceRate is not finite');
  if (rateNum <= 0) throw new RateInsane(`serviceRate is not positive (${rateStr})`);
  if (rateNum < 1e-7 || rateNum > 1.0) throw new RateInsane(`serviceRate ${rateStr} outside band [1e-7, 1.0]`);

  // --- check 3: no more than a 10x jump vs the last ACCEPTED rate --------
  // Against the last reading we ACCEPTED, not the last reading we took: a
  // sequence of refused readings must not walk the guard along with them.
  if (lastAccepted && Number.isFinite(lastAccepted.rate) && lastAccepted.rate > 0) {
    const f = rateNum / lastAccepted.rate;
    if (f > maxJumpFactor || f < 1 / maxJumpFactor) {
      throw new RateInsane(`serviceRate moved ${f.toFixed(3)}x vs last accepted (limit ${maxJumpFactor}x)`);
    }
  }

  // --- check 4: the ladder clock, on its OWN bound -----------------------
  const ladder = body.ladder;
  if (!ladder || typeof ladder !== 'object') throw new RateInsane('ladder block is absent');
  const ladderAge = requireFiniteNumber(ladder.ageSeconds, 'ladder.ageSeconds');
  if (ladder.stale !== false) throw new RateInsane(`ladder.stale is ${JSON.stringify(ladder.stale)}`);
  if (ladderAge > maxLadderAgeS) throw new RateInsane(`ladder.ageSeconds ${ladderAge} > ${maxLadderAgeS}`);

  // --- check 5: the replica clock, on its OWN bound ----------------------
  if (body.stale !== false) throw new RateInsane(`stale is ${JSON.stringify(body.stale)}`);
  const stateAge = requireFiniteNumber(body.stateAgeSeconds, 'stateAgeSeconds');
  if (stateAge > maxStateAgeS) throw new RateInsane(`stateAgeSeconds ${stateAge} > ${maxStateAgeS}`);

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
    rateFloorUsd: typeof body.rateFloorUsd === 'number' ? body.rateFloorUsd : null,
    role: typeof body.role === 'string' ? body.role : null,
    at: typeof body.at === 'string' ? body.at : null,
    buybackOpen: body.buybackOpen === true,
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
    return fromCache(db, cacheMaxAge, `unreachable: ${e.message}`);
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
