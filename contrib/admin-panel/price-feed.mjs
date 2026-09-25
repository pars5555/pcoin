// ═══════════════════════════════════════════════════════════════════════════
// price.pc.am for the admin pages -- /detail first, either body shape
// ═══════════════════════════════════════════════════════════════════════════
//
// The owner, 2026-09-25: "simplify the price.pc.am json response ... check
// every service which field is using ... fix all". The ROOT body shrinks to
// nine fields (creditRateUsd, sellPriceUsd, poolUsd, floorUsd, state, seq,
// stale, ageSeconds, at) and today's full body -- index window, refusals, pool
// median, buyback, note -- moves to GET /detail.
//
// These pages are DIAGNOSTIC: nothing on them decides money, so they read
// /detail, which is the only place the evidence behind the price still lives.
// It does not exist until price.pc.am ships it, and an origin may lag behind
// the others, so a /detail that fails falls back to the root. Either way the
// body goes through priceView(), which hands the pages the one shape they were
// written against -- a page that renders "not relayed" because a field moved
// would be the same lie as a page of zeros.
//
// Pure except readPrice(), which fetches.

export const PRICE_ROOT = 'https://price.pc.am/';
export const PRICE_DETAIL = 'https://price.pc.am/detail';

const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);

/** The full body -> { ok: true, data, from: 'detail' | 'root' }, or
 *  { ok: false, error }. `data` is already through priceView(). `getJson(url)`
 *  resolves { ok, data } or { ok: false, error }, so a page with its own cache
 *  (pricing.mjs) can pass that in. */
export async function readPrice(getJson = fetchJson) {
  const d = await getJson(PRICE_DETAIL);
  if (d && d.ok && isObj(d.data)) return { ok: true, data: priceView(d.data), from: 'detail' };
  const r = await getJson(PRICE_ROOT);
  if (r && r.ok && isObj(r.data)) return { ok: true, data: priceView(r.data), from: 'root' };
  return { ok: false, error: (r && r.error) || 'price.pc.am could not be read' };
}

export async function fetchJson(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!r.ok) return { ok: false, error: 'HTTP ' + r.status };
    return { ok: true, data: await r.json() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Either body shape -> today's full shape, so the pages read one vocabulary.
 *  Fields the body carries are kept as they are; fields it does not carry are
 *  filled from the minimal ones, and nothing is invented:
 *
 *    creditRateUsd  <- creditRateUsd, else serviceRate
 *    rateFloorUsd   <- rateFloorUsd, else floorUsd
 *    pool           <- the pool block, else { spotUsd: poolUsd } (no median:
 *                      the minimal body has none, and a page shows a dash)
 *    index          <- the index block while it is published (rolled back to
 *                      {"useIndex":0}, the top-level creditRateUsd is NOT the
 *                      index); else built from the top level, where it IS
 *                      (inUse: true). With no window, no refusal: unknown.
 *
 *  A top-level `stale` that is present and not literally false marks the index
 *  stale as well: in price.pc.am's phase-1 body it is the one unified HOLD flag,
 *  and a page that shows green while the rails hold is the thing to avoid. */
export function priceView(p) {
  if (!isObj(p)) return p;
  const out = { ...p };
  if (out.creditRateUsd == null && p.serviceRate != null) out.creditRateUsd = p.serviceRate;
  if (out.rateFloorUsd == null && p.floorUsd != null) out.rateFloorUsd = p.floorUsd;
  if (!isObj(p.pool) && p.poolUsd != null) out.pool = { spotUsd: p.poolUsd };
  const topStale = 'stale' in p && p.stale !== false;
  if (isObj(p.index)) {
    out.index = topStale && p.index.stale === false ? { ...p.index, stale: true } : p.index;
  } else if (typeof p.state === 'string') {
    const priced = ['live', 'held', 'frozen'].includes(p.state);
    out.index = {
      usd: priced ? p.creditRateUsd : null, state: p.state, seq: p.seq ?? null,
      ageSeconds: p.ageSeconds ?? null, stale: p.stale !== false,
      inUse: true, window: null, refused: null, lastMoveAt: null,
    };
  }
  return out;
}
