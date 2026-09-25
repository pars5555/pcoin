// Test helper, never deployed: the REAL code of the two consumers that refuse a
// price.pc.am body on their own rules, so the index-mode body is proved against
// what they actually check rather than against a description of it.
//
//   pcnaibot   contrib/pcnaibot/lib/rate.mjs validateRateBody() -- same repo,
//              always the real one.
//   exchange   pcoin-exchange/lib/prices.mjs fetchSellPrice() -- a SEPARATE repo.
//              Imported from the sibling checkout when it is there (it is on the
//              owner's machine: D:\xampp\htdocs\pcoin-exchange). Where it is not
//              -- a server with only this repo -- a copy of its checks stands in,
//              and the run SAYS so, because a stand-in that passes proves less.
//
// The pcnaibot bounds are its production defaults (pcnaibot.conf.example and
// readRate()), and the exchange's staleSeconds is its price_stale_seconds
// default (lib/settings.mjs: 120).
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export const PCNAIBOT_BOUNDS = Object.freeze({ maxStateAgeS: 900, maxLadderAgeS: 900, maxPoolAgeS: 900, maxJumpFactor: 10 });
export const EXCHANGE_STALE_SECONDS = 120;

// A faithful copy of pcoin-exchange lib/prices.mjs fetchSellPrice()'s checks on
// a body it has read (as of pcoin-exchange 98bfd3a, 2026-09-25), used only when
// the real file is not on disk.
function fetchSellPriceReplica() {
  const bad = (reason) => ({ usable: false, kind: 'bad', reason });
  return async function fetchSellPrice({ url, fetchImpl = fetch, staleSeconds, nowMs = Date.now() }) {
    const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
    if (res.status >= 500 || res.status === 429) return { usable: false, kind: 'unreadable', reason: `HTTP ${res.status}` };
    if (!res.ok) return bad(`HTTP ${res.status}`);
    let j;
    try { j = JSON.parse(await res.text()); } catch (e) { return bad(`body did not decode: ${e.message}`); }
    if (!j || typeof j !== 'object') return bad('not an object');
    if (j.stale !== false) return bad(`stale is ${JSON.stringify(j.stale)}`);
    if (!j.ladder || j.ladder.stale !== false) return bad('ladder.stale is not false');
    if (typeof j.sellPriceUsd !== 'number' || !Number.isFinite(j.sellPriceUsd) || j.sellPriceUsd <= 0) {
      return bad('sellPriceUsd missing or not positive');
    }
    const at = Date.parse(j.at);
    if (!Number.isFinite(at)) return bad('`at` missing or unparseable');
    const ageSeconds = (nowMs - at) / 1000;
    if (ageSeconds > Number(staleSeconds)) return bad(`price is ${Math.round(ageSeconds)}s old`);
    if (ageSeconds < -60) return bad('`at` is in the future');
    return { usable: true, kind: 'ok', sellPriceUsd: String(j.sellPriceUsd), at: j.at, ageSeconds };
  };
}

export async function loadConsumers() {
  const rate = await import(pathToFileURL(resolve(HERE, '../pcnaibot/lib/rate.mjs')).href);
  const exPath = process.env.PCOIN_EXCHANGE_PRICES || resolve(HERE, '../../../pcoin-exchange/lib/prices.mjs');
  let fetchSellPrice, exchangeSource;
  if (existsSync(exPath)) {
    ({ fetchSellPrice } = await import(pathToFileURL(exPath).href));
    exchangeSource = `REAL ${exPath}`;
  } else {
    fetchSellPrice = fetchSellPriceReplica();
    exchangeSource = `STAND-IN (the exchange repo is not at ${exPath}; set PCOIN_EXCHANGE_PRICES to use the real one)`;
  }
  return { validateRateBody: rate.validateRateBody, RateInsane: rate.RateInsane, fetchSellPrice, exchangeSource };
}

/** A fetch that answers `text` with `status`, for fetchSellPrice's fetchImpl. */
export const fetchOf = (text, status = 200) => async () => ({
  ok: status >= 200 && status < 300, status, text: async () => text,
});
