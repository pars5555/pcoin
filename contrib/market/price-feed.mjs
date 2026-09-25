// ═══════════════════════════════════════════════════════════════════════════
// Reading price.pc.am -- both body shapes, one set of rules.
// ═══════════════════════════════════════════════════════════════════════════
//
// The owner, 2026-09-25: "simplify the price.pc.am json response ... check
// every service which field is using ... fix all". The root body shrinks to
//
//   { creditRateUsd, sellPriceUsd, poolUsd, floorUsd,
//     state, seq, stale, ageSeconds, at }
//
// and today's full body (serviceRate, index.*, ladder.*, pool.*, note, ...)
// moves to GET /detail, for diagnostic pages only. price.pc.am ADDS the new
// fields first and REMOVES the old ones later, so every reader in this market
// has to work on three bodies: today's, the transition one (both sets), and the
// minimal one. And none of them may read /detail: that is a diagnostic surface,
// and a money path that depends on it breaks the day it is reshaped.
//
// PURE. No network, no clock: server.mjs, cap-policy.mjs, pricing-mode.mjs and
// admin.mjs fetch, and hand the parsed body in. price-feed-test.mjs drives both
// functions with the body captured live on 2026-09-25, the minimal one, and the
// minimal one marked stale.
//
// THE MARKER for the minimal shape is a top-level `state` string. Today's body
// has `stale` at the top (the replica's sync) but the index state only inside
// `index`, so a top-level `state` means the new fields are there.

/** The PCN index the market prices with -- { usd, state, seq, ageSeconds,
 *  stale } -- or null when the body carries none. The same five fields
 *  ladder.mjs indexUnitPrice() judges; nothing here decides whether they are
 *  usable, because that is indexUnitPrice's job and it must stay in one place.
 *
 *    today's body   -> the `index` block, as before
 *    phase 1        -> STILL the `index` block (price.pc.am publishes the old
 *                      body plus the nine new fields). Not the top level's
 *                      creditRateUsd: with the rails rolled back
 *                      ({"useIndex":0}) that is the pool-follow rate, not the
 *                      index, and this market sells at the INDEX
 *    minimal body   -> the top level IS the index; creditRateUsd is its usd
 *
 *  Every published freshness flag must say fresh: a top-level `stale` that is
 *  present and not literally false marks the reading stale even when the block
 *  says otherwise. In phase 1 that flag is price.pc.am's unified HOLD. */
export function indexFromPriceBody(j) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  const b = j.index;
  if (b && typeof b === 'object' && !Array.isArray(b)) {
    const topSaysStale = 'stale' in j && j.stale !== false;
    return { usd: b.usd, state: b.state, seq: b.seq, ageSeconds: b.ageSeconds,
             stale: topSaysStale ? true : b.stale };
  }
  if (typeof j.state === 'string') {
    return { usd: j.creditRateUsd, state: j.state, seq: j.seq ?? null,
             ageSeconds: j.ageSeconds, stale: j.stale };
  }
  return null;
}

/** What one PCN is credited at, from a price.pc.am body.
 *  -> { ok: true, rate, ageSeconds } or { ok: false, why }.
 *
 *  `creditRateUsd`, falling back to `serviceRate` (its older name) only while
 *  a replica still serves the old body. NEVER `price` / `sellPriceUsd`: that
 *  is what this market CHARGES, and crediting at it is the leak the credit
 *  rate exists to close (contrib/wpcn-pay/server.mjs has the arithmetic).
 *
 *  Two freshness rules, both unknown-shaped (CLAUDE.md 7.2):
 *    * top-level `stale` must be literally false. Both bodies carry it -- the
 *      replica's sync today, "do not use" in the minimal body -- so an absent
 *      one is a body we do not recognise, and that holds too.
 *    * while a `ladder` block is still published, its `stale` must be false as
 *      well. In index mode it is the flag that follows the INDEX, and today it
 *      is the only one that turns true when the index goes stale or unknown
 *      while the oracle itself is healthy. Absent in the minimal body, where
 *      top-level `stale` says the same thing. */
export function creditRateFromPriceBody(j) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { ok: false, why: 'price.pc.am answered something that is not a JSON object' };
  const raw = j.creditRateUsd ?? j.serviceRate;
  // Number(null) is 0, Number('') is 0 and Number(true) is 1: test the raw value.
  const rate = (raw === null || raw === undefined || raw === '' || typeof raw === 'boolean') ? NaN : Number(raw);
  if (!(Number.isFinite(rate) && rate > 0)) return { ok: false, why: 'price.pc.am gave no usable creditRateUsd' };
  if (j.stale !== false) return { ok: false, why: `price.pc.am says the rate is stale (stale ${JSON.stringify(j.stale ?? null)})` };
  if ('ladder' in j && !(j.ladder && typeof j.ladder === 'object' && j.ladder.stale === false)) {
    return { ok: false, why: 'price.pc.am says the rate is stale (ladder.stale is not false)' };
  }
  const a = j.ageSeconds ?? (j.index && typeof j.index === 'object' ? j.index.ageSeconds : undefined)
          ?? (j.ladder && typeof j.ladder === 'object' ? j.ladder.ageSeconds : undefined);
  const age = (a === null || a === undefined || typeof a === 'boolean') ? null : Number(a);
  return { ok: true, rate, ageSeconds: Number.isFinite(age) ? age : null };
}
