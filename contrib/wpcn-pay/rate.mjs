// The credit rate out of a price.pc.am body -- pure, so it can be tested.
//
// server.mjs reads its config and exits at import time, which makes the rate
// rule it applies untestable in place. It lives here instead, with no I/O, and
// rate-test.mjs drives it with the body captured live on 2026-09-25.
//
// TWO BODY SHAPES. The owner, 2026-09-25: "simplify the price.pc.am json
// response ... check every service which field is using ... fix all". The root
// body shrinks to { creditRateUsd, sellPriceUsd, poolUsd, floorUsd, state, seq,
// stale, ageSeconds, at }; serviceRate, `ladder`, `index`, `pool` and `note`
// move to GET /detail, which a money path must never depend on. price.pc.am adds
// the new fields first and removes the old ones later, so this reads both.

/** The USD credit rate for one PCN, or THROWS. A throw is a hold: verify()
 *  answers "try again", never a number (rule 3 in server.mjs). */
export function creditRateFromBody(j) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('price feed answered something that is not a JSON object');

  // `creditRateUsd`, NOT `price` / `sellPriceUsd`. This read `Number(j.price)`
  // from the day it was written, and `price` is what a BUYER pays us -- the one
  // number in the feed that must never credit anything. Measured 2026-09-11
  // before the fix: price $0.037621 vs creditRate $0.035902 = 4.79% over, then
  // +10% bonus = 15.3% more credit than the same value paid in PCN. (The full
  // history is at usdRate() in server.mjs.)
  //
  // `serviceRate` is the older name for the same number. It is the fallback only
  // so a replica still serving the old body answers correctly rather than
  // refusing; the minimal body does not carry it at all.
  const raw = j.creditRateUsd ?? j.serviceRate;
  // Number(null) is 0 and Number(true) is 1 -- test the raw value first.
  const rate = (raw === null || raw === undefined || raw === '' || typeof raw === 'boolean') ? NaN : Number(raw);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error('price feed gave no usable credit rate');

  // The feed says so itself when its number is not to be used. Rule 3.
  //
  // `stale` must be literally false, not merely "not true". Both shapes carry
  // it: today it is the replica's sync, in the minimal body it is "HOLD, do not
  // use" for the rate itself. So an absent one is a body we do not recognise --
  // and that is a hold too (CLAUDE.md 7.2: unknown-shaped defaults). It read
  // `=== true` until 2026-09-25; every real body carries the field, so the only
  // thing the stricter test changes is what an unrecognised body does.
  if (j.stale !== false) throw new Error(`price feed reports itself stale (stale ${JSON.stringify(j.stale ?? null)})`);

  // AND, WHILE THE `ladder` BLOCK IS STILL PUBLISHED, IT MUST SAY FRESH. Since
  // 2026-09-25 the credit rate is the PCN index (price.pc.am useIndex). In
  // today's body, when the index goes stale or unknown the top-level `stale`
  // stays false -- the ORACLE is fine, its number is not -- and only
  // `ladder.stale` turns true. Every PCN rail holds on it; this one kept
  // crediting wPCN at the last index until that was fixed the same day. A
  // `ladder` of null (today's body before its first poll) holds as it always
  // did. In the minimal body the block is gone and top-level `stale` above
  // carries the same meaning.
  if ('ladder' in j && !(j.ladder && typeof j.ladder === 'object' && j.ladder.stale === false)) {
    throw new Error('price feed: the rate is stale (ladder.stale is not false)');
  }
  return rate;
}
