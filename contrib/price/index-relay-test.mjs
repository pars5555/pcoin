// node contrib/price/index-relay-test.mjs -- pure, touches nothing.
// Every refusal in index-relay.mjs is proved to FIRE here, and every healthy
// reading is proved to pass: a guard only ever seen passing is untested.
import assert from 'node:assert/strict';
import { INDEX_RULES, validateIndexBody, confirmTwice, speedCheck, remember,
         indexUsable, rateFromIndex, switchCheck, indexLadder, indexNote,
         MINIMAL_KEYS, bodyVersionOf, creditAgeSeconds, creditStale, minimalBody, phase1Body } from './index-relay.mjs';
import { loadConsumers, fetchOf, PCNAIBOT_BOUNDS, EXCHANGE_STALE_SECONDS } from './test-consumers.mjs';

const NOW = 1790250000;
const body = (o = {}) => ({
  enabled: true, usd: '0.027335212', nano: '27335212', state: 'held', seq: 0,
  computedAt: NOW - 5, lastMoveAt: null,
  window: { hours: 168, trades: 3, entities: 4, countedPcn: '420.00000000', countedUsd: '10.044090', qualifies: false },
  limitedBy: [], reasons: ['too little evidence'], ...o,
});
const priced = (nano, seq, extra = {}) =>
  validateIndexBody(body({ nano: String(nano), usd: (nano / 1e9).toFixed(9), seq, ...extra }), { nowS: NOW }).reading;
let n = 0;
const check = (name, fn) => { fn(); n += 1; console.log('  ok  ', name); };

check('a healthy held reading is accepted with its numbers', () => {
  const v = validateIndexBody(body(), { nowS: NOW });
  assert.equal(v.ok, true);
  assert.equal(v.reading.nano, 27335212); assert.equal(v.reading.seq, 0); assert.equal(v.reading.state, 'held');
  assert.equal(v.reading.window.trades, 3);
});

check('live and frozen are priced states too', () => {
  for (const state of ['live', 'frozen']) assert.equal(validateIndexBody(body({ state }), { nowS: NOW }).reading.state, state);
});

check('unknown is a valid reading WITHOUT a price, never with the last one', () => {
  const v = validateIndexBody(body({ state: 'unknown', usd: null, nano: null, seq: null }), { nowS: NOW });
  assert.equal(v.ok, true); assert.equal(v.reading.nano, null); assert.equal(v.reading.usd, null);
});

check('disabled on the exchange is a fact, not a fault', () => {
  const v = validateIndexBody({ enabled: false, state: 'disabled', usd: null, nano: null }, { nowS: NOW });
  assert.equal(v.ok, true); assert.equal(v.reading.state, 'disabled'); assert.equal(v.reading.nano, null);
});

check('a stale body is refused, measured on OUR clock not the exchange\'s ageSeconds', () => {
  const v = validateIndexBody(body({ computedAt: NOW - 121, ageSeconds: 1 }), { nowS: NOW });
  assert.equal(v.ok, false); assert.equal(v.kind, 'stale');
  assert.equal(validateIndexBody(body({ computedAt: NOW - 120 }), { nowS: NOW }).ok, true, 'exactly 120 s is still fresh');
});

check('the clock-skew window: 30 s in the future is tolerated, 31 s is not', () => {
  assert.equal(validateIndexBody(body({ computedAt: NOW + 30 }), { nowS: NOW }).ok, true);
  const v = validateIndexBody(body({ computedAt: NOW + 31 }), { nowS: NOW });
  assert.equal(v.ok, false); assert.match(v.why, /in the future/);
});

check('floor and ceiling are refused outright', () => {
  assert.match(validateIndexBody(body({ nano: '14999999', usd: '0.014999999' }), { nowS: NOW }).why, /below the \$0.015 floor/);
  assert.equal(validateIndexBody(body({ nano: '15000000', usd: '0.015000000' }), { nowS: NOW }).ok, true);
  assert.match(validateIndexBody(body({ nano: '100000001', usd: '0.100000001' }), { nowS: NOW }).why, /above the \$0.1 ceiling/);
});

check('malformed bodies are invalid, never a number', () => {
  for (const [o, re] of [
    [null, /not a JSON object/], [[], /not a JSON object/], [{ state: 'held' }, /"enabled" is missing/],
    [body({ state: 'rising' }), /unrecognised state/], [body({ computedAt: 'soon' }), /computedAt/],
    [body({ nano: '-5' }), /nano/], [body({ nano: 27335212 }), /nano/], [body({ usd: '0.03' }), /does not match/],
    [body({ seq: -1 }), /seq/], [body({ seq: 1.5 }), /seq/],
  ]) {
    const v = validateIndexBody(o, { nowS: NOW });
    assert.equal(v.ok, false, JSON.stringify(o)); assert.match(v.why, re);
  }
});

check('a transient seen only once is never confirmed; two agreeing polls are', () => {
  const a = priced(27335212, 0), b = priced(26788508, 1);
  let g = confirmTwice(null, a); assert.equal(g.confirmed, false);
  g = confirmTwice(g.pending, b); assert.equal(g.confirmed, false, 'a different reading resets the count');
  g = confirmTwice(g.pending, a); assert.equal(g.confirmed, false, 'the blip in the middle bought nothing');
  g = confirmTwice(g.pending, a); assert.equal(g.confirmed, true);
});

check('the first reading ever is accepted: it is the seed', () => {
  assert.equal(speedCheck({ prev: null, reading: priced(27335212, 0), nowS: NOW }).ok, true);
});

check('seq going backwards is refused', () => {
  const v = speedCheck({ prev: { nano: 27335212, seq: 5 }, reading: priced(27335212, 4), nowS: NOW });
  assert.equal(v.ok, false); assert.match(v.why, /backwards/);
});

check('a price change without a new seq is refused', () => {
  const v = speedCheck({ prev: { nano: 27335212, seq: 5 }, reading: priced(27300000, 5), nowS: NOW });
  assert.equal(v.ok, false); assert.match(v.why, /without a new seq/);
});

check('one step may move 2.5%, not 2.6%, in either direction', () => {
  const prev = { nano: 27000000, seq: 3 };
  assert.equal(speedCheck({ prev, reading: priced(27675000, 4), nowS: NOW }).ok, true, '+2.5%');
  assert.equal(speedCheck({ prev, reading: priced(26325000, 4), nowS: NOW }).ok, true, '-2.5%');
  assert.match(speedCheck({ prev, reading: priced(27702000, 4), nowS: NOW }).why, /a step/);
  assert.match(speedCheck({ prev, reading: priced(26298000, 4), nowS: NOW }).why, /a step/);
});

check('two fills inside one poll (seq +2) may move two steps\' worth', () => {
  const prev = { nano: 27000000, seq: 3 };
  assert.equal(speedCheck({ prev, reading: priced(Math.round(27000000 * 0.98 * 0.98), 5), nowS: NOW }).ok, true);
});

check('the 24 h check: more than 5.5% from the day\'s extremes is refused even in small steps', () => {
  const t = NOW - 3600;
  const history = [{ t: t - 7200, nano: 28000000 }, { t: t - 3600, nano: 27440000 }, { t, nano: 26891200 }];
  const prev = { nano: 26891200, seq: 3 };
  const ok = speedCheck({ prev, history, reading: priced(26500000, 4), nowS: NOW });
  assert.equal(ok.ok, true, '5.36% below the high');
  const no = speedCheck({ prev, history, reading: priced(26400000, 4), nowS: NOW });
  assert.equal(no.ok, false); assert.match(no.why, /below the 24 h high/);
  const up = speedCheck({ prev: { nano: 25000000, seq: 1 }, history: [{ t, nano: 25000000 }], reading: priced(26400000, 4), nowS: NOW });
  assert.equal(up.ok, false); assert.match(up.why, /above the 24 h low/);
});

check('history older than 24 h no longer binds', () => {
  const history = [{ t: NOW - 90000, nano: 30000000 }];
  assert.equal(speedCheck({ prev: { nano: 27000000, seq: 3 }, history, reading: priced(26500000, 4), nowS: NOW }).ok, true);
});

check('a deliberate re-seed jump is refused by the check (the operator accepts it by hand)', () => {
  const v = speedCheck({ prev: { nano: 27335212, seq: 9 }, reading: priced(22000000, 10), nowS: NOW });
  assert.equal(v.ok, false);
});

check('unknown and disabled readings skip the price checks', () => {
  const u = validateIndexBody(body({ state: 'unknown', nano: null, usd: null, seq: null }), { nowS: NOW }).reading;
  assert.equal(speedCheck({ prev: { nano: 27335212, seq: 9 }, reading: u, nowS: NOW }).ok, true);
});

check('remember keeps every change, one point per 10 min otherwise, and 25 h at most', () => {
  let h = [];
  h = remember(h, { t: NOW, nano: 1 });
  h = remember(h, { t: NOW + 60, nano: 1 });
  assert.equal(h.length, 1, 'an unchanged value inside 10 min is not stored again');
  h = remember(h, { t: NOW + 120, nano: 2 });
  assert.equal(h.length, 2, 'a change is always stored');
  h = remember(h, { t: NOW + 719, nano: 2 });
  assert.equal(h.length, 2, '599 s after the last point: not yet');
  h = remember(h, { t: NOW + 720, nano: 2 });
  assert.equal(h.length, 3, '600 s after the last point: stored');
  h = remember(h, { t: NOW + 26 * 3600, nano: 3 });
  assert.deepEqual(h.map((x) => x.nano), [3], 'points older than 25 h are dropped');
});

assert.equal(INDEX_RULES.floorUsd, 0.015);

// ── Step 4: the credit rate IS the index ───────────────────────────────────
console.log('  -- step 4 (useIndex = 1)');

check('the exchange\'s published caps are relayed, and odd ones become null rather than a guess', () => {
  const v = validateIndexBody(body({ rules: { perTradePct: 2, perDayPct: 5, bandPct: 25, floorUsd: '0.015000000' } }), { nowS: NOW });
  assert.deepEqual(v.reading.rules, { perTradePct: 2, perDayPct: 5 });
  assert.equal(validateIndexBody(body(), { nowS: NOW }).reading.rules, null, 'absent');
  assert.deepEqual(validateIndexBody(body({ rules: { perTradePct: '2', perDayPct: 500 } }), { nowS: NOW }).reading.rules,
    { perTradePct: null, perDayPct: null }, 'a string or an absurd value is not a cap');
});

// The published block, as server.mjs indexBlock() builds it.
const block = (o = {}) => ({ usd: 0.027335212, state: 'held', seq: 0, ageSeconds: 14, stale: false,
  lastMoveAt: null, window: null, limitedBy: [], reasons: [], refused: null, inUse: true,
  source: 'https://exchange.pc.am/api/index', ...o });

check('a usable index is fresh AND priced; unknown, disabled, stale and absent are not', () => {
  for (const state of ['held', 'live', 'frozen']) assert.equal(indexUsable(block({ state })), true, state);
  assert.equal(indexUsable(block({ stale: true, ageSeconds: 668 })), false, 'stale (the live state on 2026-09-25)');
  assert.equal(indexUsable(block({ state: 'unknown', usd: null, seq: null })), false, 'a FRESH unknown still holds');
  assert.equal(indexUsable(block({ state: 'disabled', usd: null, seq: null })), false);
  assert.equal(indexUsable(block({ state: 'unknown' })), false, 'a no-price state is unusable even with a number attached');
  assert.equal(indexUsable(null), false);
  assert.equal(indexUsable(block({ stale: undefined })), false, 'stale must be literally false');
  assert.equal(indexUsable(block({ usd: 0 })), false);
});

check('the credit rate is the index, clamped to the floor and the ceiling -- the ceiling winning', () => {
  const b = { floorUsd: 0.015, ceilingUsd: 10 };
  assert.equal(rateFromIndex(0.027335212, b), 0.027335212, 'in range: the index itself, to the last digit');
  assert.equal(rateFromIndex(0.012, b), 0.015, 'below the floor');
  assert.equal(rateFromIndex(0.05, { floorUsd: 0.015, ceilingUsd: 0.02 }), 0.02, 'above the ceiling');
  assert.equal(rateFromIndex(0.05, { floorUsd: 0.03, ceilingUsd: 0.02 }), 0.02, 'crossed bounds: the ceiling wins, as in the walk');
  assert.equal(rateFromIndex(0.027, { floorUsd: 0.015, ceilingUsd: 0 }), 0.027, 'a zero ceiling is no ceiling, never a zero rate');
  for (const x of [null, undefined, NaN, 0, -1, '0.02']) assert.equal(rateFromIndex(x, b), null, String(x));
});

check('the switch refuses a stale, unknown, absent or refused index -- even when forced', () => {
  const args = { serviceRate: 0.027335, sellPriceUsd: 0.0282, force: true };
  assert.match(switchCheck({ ...args, block: block({ stale: true, ageSeconds: 668 }) }).why, /stale/);
  assert.match(switchCheck({ ...args, block: block({ state: 'unknown', usd: null }) }).why, /"unknown"/);
  assert.match(switchCheck({ ...args, block: null }).why, /never had an index reading/);
  assert.match(switchCheck({ ...args, block: block({ refused: { why: 'moved 9%' } }) }).why, /refusing the latest/);
});

check('the switch refuses a gap of 0.5% or more, unless forced', () => {
  // 2026-09-25 11:16 UTC, live: creditRateUsd 0.026748145, index 0.027335212 -> 2.148%.
  const live = switchCheck({ block: block(), serviceRate: 0.026748145216180963, sellPriceUsd: 0.0282 });
  assert.equal(live.ok, false); assert.match(live.why, /2\.148% from the index/); assert.equal(live.gapPct, 2.1477);
  const at = (rate) => switchCheck({ block: block({ usd: 0.02 }), serviceRate: rate, sellPriceUsd: 0.03 });
  assert.equal(at(0.02 * 1.0049).ok, true, '0.49% above');
  assert.equal(at(0.02 * 0.9951).ok, true, '0.49% below');
  // Not the exact 0.5% point: 0.02 x 1.005 is 0.4999...% in binary floating point.
  assert.equal(at(0.02 * 1.0051).ok, false, '0.51% above');
  assert.equal(at(0.02 * 0.9949).ok, false, '0.51% below');
  assert.equal(at(NaN).ok, false, 'an unknown rate is not a small gap');
  const forced = switchCheck({ block: block(), serviceRate: 0.026748145, sellPriceUsd: 0.0282, force: true });
  assert.equal(forced.ok, true); assert.equal(forced.forced, true);
});

check('the switch refuses while market.pc.am sells BELOW the index, unless forced', () => {
  // Also the live case: the market curve sat at 0.026748 under an index of 0.027335.
  const under = switchCheck({ block: block(), serviceRate: 0.027335, sellPriceUsd: 0.026748145 });
  assert.equal(under.ok, false); assert.match(under.why, /below the index/);
  assert.equal(switchCheck({ block: block(), serviceRate: 0.027335, sellPriceUsd: null }).ok, false, 'unknown sell price');
  assert.equal(switchCheck({ block: block(), serviceRate: 0.027335, sellPriceUsd: 0.027335212 }).ok, true, 'equal is allowed');
  assert.equal(switchCheck({ block: block(), serviceRate: 0.027335, sellPriceUsd: 0.028155268 }).ok, true, 'index x 1.03 (Step 3)');
});

check('the ladder compatibility block: price = sellPriceUsd, clock and stale flag = the index', () => {
  const l = indexLadder({ block: block(), sellPriceUsd: 0.028155268, soldPcn: 38571.36624107, remainingPcn: 16387.70607446 });
  assert.deepEqual(l, { price: 0.028155268, soldPcn: 38571.36624107, remainingPcn: 16387.70607446, ageSeconds: 14, stale: false });
  assert.equal(indexLadder({ block: block({ stale: true, ageSeconds: 668 }), sellPriceUsd: 1 }).stale, true);
  assert.equal(indexLadder({ block: block({ state: 'unknown', usd: null }), sellPriceUsd: 1 }).stale, true,
    'a fresh unknown is stale HERE, so every rail that honours ladder.stale holds');
  assert.deepEqual([indexLadder({ block: null, sellPriceUsd: 1 }).stale, indexLadder({ block: null, sellPriceUsd: 1 }).ageSeconds], [true, null]);
});

check('the index-mode note: what the price is, its caps, floor and ceiling -- and no exit', () => {
  const note = indexNote({ floorUsd: 0.015, rules: { perTradePct: 2, perDayPct: 5 }, maxAgeS: 600, buybackOpen: false });
  for (const re of [/volume-weighted median/, /user-to-user trades on exchange\.pc\.am/, /at most 2% per trade and 5% in 24 hours/,
                    /floor of \$0\.0150/, /ceiling of \$0\.10/, /more than 10 minutes old/, /503/,
                    /ladder block is kept only so older integrations keep working/, /not buying PCN back/]) {
    assert.match(note, re);
  }
  // Never advertise wrapping and selling as the way out (plan §0; the Phase 2
  // note was fixed for exactly this).
  for (const re of [/wrapdesk/i, /redeem/i, /way out/i, /sell (the|that|on) pool/i, /`/]) assert.doesNotMatch(note, re);
  const bare = indexNote({ floorUsd: 0.015, rules: null, maxAgeS: 600 });
  assert.match(bare, /in capped steps/); assert.doesNotMatch(bare, /\d% per trade/, 'no rules relayed: no invented figures');
});

// ── the contract: what the rails and the exchange will actually do with it ──
// A synthetic index-mode body, built in the server's exact key order from the
// same helpers server.mjs calls, with today's live figures (2026-09-25 11:16
// UTC). server-test.mjs then runs the REAL server and checks its real body.
const { validateRateBody, RateInsane, fetchSellPrice, exchangeSource } = await loadConsumers();
console.log(`  -- contract (exchange fetchSellPrice: ${exchangeSource})`);

function indexModeBody({ ix = block(), sellPriceUsd = 0.028155268, pool = { spotUsd: 0.0272, medianUsd: 0.02675, windowHours: 6, samples: 2000, ageSeconds: 59, rateHeldAboveBy: null } } = {}) {
  const rate = 0.027335212;   // serviceRate, as pollIndex() set it from the index
  return {
    price: sellPriceUsd, serviceRate: rate, creditRateUsd: rate, sellPriceUsd,
    rateFieldToUse: 'creditRateUsd', rateFollowsPoolDown: false, rateFloorUsd: 0.015, pool, index: ix,
    currency: 'USD', buybackOpen: false, buybackPrice: null, buybackRemainingToday: 0,
    ladder: indexLadder({ block: ix, sellPriceUsd, soldPcn: 38571.36624107, remainingPcn: 16387.70607446 }),
    note: indexNote({ floorUsd: 0.015, rules: { perTradePct: 2, perDayPct: 5 }, maxAgeS: 600, buybackOpen: false }),
    role: 'replica', stale: false, stateAgeSeconds: 5, at: new Date().toISOString(),
  };
}
const text = (o) => JSON.stringify(o, null, 2);   // exactly how server.mjs json() serialises
const LEGACY_RATE = { rate: 0.026748145216180963 }; // pcnaibot's last accepted, before the switch
let pending = 0;
const acheck = async (name, fn) => { await fn(); n += 1; pending += 1; console.log('  ok  ', name); };

await acheck('pcnaibot\'s REAL validateRateBody accepts the index-mode body and credits the index', async () => {
  const r = validateRateBody(text(indexModeBody()), PCNAIBOT_BOUNDS, LEGACY_RATE);
  assert.equal(r.rate, 0.027335212); assert.equal(r.rateText, '0.027335212');
  assert.equal(r.rateE12, 27335212000n, 'floor-quantised from the TEXT, as the rail credits it');
  assert.equal(r.fieldUsed, 'creditRateUsd'); assert.equal(r.fieldNamed, 'creditRateUsd'); assert.equal(r.diverged, false);
});

await acheck('...and does not need the pool once rateFollowsPoolDown is false (the sampler may die)', async () => {
  assert.equal(validateRateBody(text(indexModeBody({ pool: null })), PCNAIBOT_BOUNDS, LEGACY_RATE).rate, 0.027335212);
});

await acheck('...and REFUSES a stale or unknown index through ladder.stale -- it holds, it never credits the last number', async () => {
  for (const ix of [block({ stale: true, ageSeconds: 668 }), block({ state: 'unknown', usd: null, seq: null })]) {
    assert.throws(() => validateRateBody(text(indexModeBody({ ix })), PCNAIBOT_BOUNDS, LEGACY_RATE),
      (e) => e instanceof RateInsane && /ladder\.stale is true/.test(e.reason));
  }
  assert.throws(() => validateRateBody(text(indexModeBody({ ix: null })), PCNAIBOT_BOUNDS, LEGACY_RATE),
    (e) => e instanceof RateInsane && /ladder\.ageSeconds is absent/.test(e.reason), 'no index at all');
});

await acheck('the exchange\'s fetchSellPrice accepts it: stale false, ladder.stale false, sellPriceUsd > 0, fresh `at`', async () => {
  const r = await fetchSellPrice({ url: 'http://x/', fetchImpl: fetchOf(text(indexModeBody())), staleSeconds: EXCHANGE_STALE_SECONDS, attempts: 1 });
  assert.equal(r.usable, true, r.reason); assert.equal(r.kind, 'ok');
  assert.equal(r.sellPriceUsd, '0.028155268', 'the market price, not the credit rate');
});

await acheck('...and pulls the bots (kind "bad") when the index is stale or unknown', async () => {
  for (const ix of [block({ stale: true, ageSeconds: 668 }), block({ state: 'unknown', usd: null, seq: null })]) {
    const r = await fetchSellPrice({ url: 'http://x/', fetchImpl: fetchOf(text(indexModeBody({ ix }))), staleSeconds: EXCHANGE_STALE_SECONDS, attempts: 1 });
    assert.equal(r.usable, false); assert.equal(r.kind, 'bad'); assert.match(r.reason, /ladder\.stale/);
  }
});

await acheck('every other rail\'s field reads the index: creditRateUsd, serviceRate, and the fallbacks they use', async () => {
  const j = JSON.parse(text(indexModeBody()));
  assert.equal(j.rateFieldToUse, 'creditRateUsd');
  assert.equal(j.creditRateUsd, j.index.usd);
  assert.equal(Number(j.creditRateUsd ?? j.serviceRate), 0.027335212, 'wpcn-pay: creditRateUsd ?? serviceRate');
  assert.equal(Number(j.serviceRate), 0.027335212, 'webai, the pc.am web app, payment-report: serviceRate');
  assert.equal(Number(j.serviceRate ?? j.price), 0.027335212, 'pcnearner: serviceRate ?? price');
  assert.equal(j.rateFollowsPoolDown, false);
});

assert.equal(pending, 6);

// ── the published body: bodyVersion 1 (legacy + additive) and 2 (minimal) ──
// Owner, 2026-09-25: "make it minimal compact json". Every way the unified
// `stale` turns true is proved to FIRE here; server-test.mjs proves the wiring.
console.log('  -- the published body (bodyVersion)');

check('bodyVersion is 2 only when it is literally the number 2; anything else is the legacy body', () => {
  assert.equal(bodyVersionOf(2), 2);
  for (const v of [1, undefined, null, '2', 3, true, 0, 2.5, NaN]) assert.equal(bodyVersionOf(v), 1, String(v));
});

check('the age of the rate: the index\'s in index mode, the LADDER\'s otherwise -- never serviceRateAt', () => {
  assert.equal(creditAgeSeconds({ indexMode: true, block: block({ ageSeconds: 14 }), ladderAgeS: 999 }), 14);
  assert.equal(creditAgeSeconds({ indexMode: false, block: block({ ageSeconds: 14 }), ladderAgeS: 37 }), 37);
  assert.equal(creditAgeSeconds({ indexMode: true, block: block({ ageSeconds: -12 }) }), 0,
    'an exchange clock up to 30 s ahead is tolerated; the age floors at 0, never goes negative');
  assert.equal(creditAgeSeconds({ indexMode: true, block: null, ladderAgeS: 5 }), null, 'no reading: unknown, not the ladder\'s');
  assert.equal(creditAgeSeconds({ indexMode: true, block: block({ ageSeconds: null }) }), null);
  assert.equal(creditAgeSeconds({ indexMode: false, ladderAgeS: null }), null, 'a ladder never read is unknown, not 0');
  assert.equal(creditAgeSeconds({ indexMode: false, ladderAgeS: NaN }), null);
});

// A fresh index-mode reading, and the ladder block server.mjs builds beside it.
const fresh = (o = {}) => {
  const b = o.block === undefined ? block() : o.block;
  return { indexMode: true, block: b, oracleStale: false, serviceRate: 0.027335212, ageSeconds: 14,
           ladder: indexLadder({ block: b, sellPriceUsd: 0.028155268, soldPcn: 1, remainingPcn: 1 }), ...o };
};

check('unified stale: FALSE only when the oracle is in sync, the ladder flag is false, the index usable, the rate and age known', () => {
  assert.equal(creditStale(fresh()), false);
  assert.equal(creditStale({ ...fresh(), indexMode: false,
    ladder: { price: 0.028, stale: false, ageSeconds: 30 }, block: block({ stale: true }) }), false,
    'legacy mode: the index is shadow data, and its staleness does not stop a rate that does not use it');
});

check('unified stale: TRUE on every one of its causes, each alone', () => {
  const cases = {
    'the replica is out of sync (the old top-level stale)': { oracleStale: true },
    'the oracle did not say (undefined is not "in sync")': { oracleStale: undefined },
    'no ladder block at all (every rail refused on that)': { ladder: null },
    'ladder.stale true (the old nested flag)': { ladder: { stale: true } },
    'ladder.stale absent': { ladder: {} },
    'index stale': { block: block({ stale: true, ageSeconds: 668 }) },
    'index unknown, FRESH': { block: block({ state: 'unknown', usd: null, seq: null }) },
    'index disabled': { block: block({ state: 'disabled', usd: null, seq: null }) },
    'no index reading in index mode': { block: null },
    'a rate of zero': { serviceRate: 0 },
    'a NaN rate': { serviceRate: NaN },
    'no rate': { serviceRate: null },
    'an unknown age': { ageSeconds: null },
    'a fractional age (not produced by creditAgeSeconds)': { ageSeconds: 1.5 },
  };
  for (const [why, o] of Object.entries(cases)) {
    // The ladder flag is left as the fresh one unless the case is about it:
    // this proves the INDEX clause fires by itself, not through ladder.stale.
    const args = { ...fresh(), ...o };
    assert.equal(creditStale(args), true, why);
  }
  assert.equal(creditStale({ ...fresh(), indexMode: false, ladder: { stale: true, ageSeconds: 700 } }), true,
    'legacy mode: a market clock over 10 minutes');
});

const minArgs = (o = {}) => ({ indexMode: true, block: block(), ladderKnown: true, ladderAgeS: 30, oracleStale: false,
  serviceRate: 0.027335212, sellPriceUsd: 0.028155268, poolUsd: 0.0272, floorUsd: 0.015, at: '2026-09-25T12:00:00.000Z',
  ladder: indexLadder({ block: block(), sellPriceUsd: 0.028155268, soldPcn: 1, remainingPcn: 1 }), ...o });

check('the minimal body is EXACTLY nine keys, in the agreed order, with the agreed values', () => {
  const m = minimalBody(minArgs());
  assert.deepEqual(Object.keys(m), MINIMAL_KEYS);
  assert.deepEqual(MINIMAL_KEYS, ['creditRateUsd', 'sellPriceUsd', 'poolUsd', 'floorUsd', 'state', 'seq', 'stale', 'ageSeconds', 'at']);
  assert.deepEqual(m, { creditRateUsd: 0.027335212, sellPriceUsd: 0.028155268, poolUsd: 0.0272, floorUsd: 0.015,
    state: 'held', seq: 0, stale: false, ageSeconds: 14, at: '2026-09-25T12:00:00.000Z' });
  assert.equal(JSON.stringify(m).includes(' '), false, 'compact: no whitespace anywhere');
});

check('the minimal body says UNKNOWN as null, never as a number', () => {
  assert.equal(minimalBody(minArgs({ ladderKnown: false, sellPriceUsd: 0.001 })).sellPriceUsd, null,
    'an origin that never read the market must not publish the AMM\'s 0.001 as a sale price');
  for (const x of [null, 0, NaN, -1, undefined]) assert.equal(minimalBody(minArgs({ poolUsd: x })).poolUsd, null, String(x));
  const u = minimalBody(minArgs({ block: block({ state: 'unknown', usd: null, seq: null }) }));
  assert.deepEqual([u.state, u.seq, u.stale], ['unknown', null, true]);
  const none = minimalBody(minArgs({ block: null }));
  assert.deepEqual([none.state, none.seq, none.ageSeconds, none.stale], ['unknown', null, null, true], 'never polled');
  const legacy = minimalBody(minArgs({ indexMode: false, ladderAgeS: 42, ladder: { stale: false } }));
  assert.deepEqual([legacy.ageSeconds, legacy.stale], [42, false], 'legacy mode: the ladder clock');
});

check('bodyVersion 1 keeps every legacy key in place, replaces `stale` IN PLACE, and APPENDS the new ones', () => {
  const legacy = indexModeBody({ ix: block({ state: 'unknown', usd: null, seq: null }) });
  const m = minimalBody(minArgs({ block: legacy.index, ladder: legacy.ladder, at: legacy.at }));
  const v1 = phase1Body(legacy, m);
  const keys = Object.keys(legacy);
  assert.deepEqual(Object.keys(v1), [...keys, 'poolUsd', 'floorUsd', 'state', 'seq', 'ageSeconds']);
  for (const k of keys) if (k !== 'stale') assert.deepEqual(v1[k], legacy[k], k);
  assert.equal(legacy.stale, false, 'the legacy flag said in sync ...');
  assert.equal(v1.stale, true, '... and the unified one holds, because the index is unknown');
  assert.equal(v1.at, legacy.at);
  assert.equal(v1.creditRateUsd, legacy.creditRateUsd, 'never overwritten by the minimal copy');
});

// The phase-1 body through the two consumers that refuse on their own rules.
// Built from the same helpers server.mjs calls; server-test.mjs repeats this
// against the real server.
const v1Of = (ix) => {
  const legacy = indexModeBody({ ix });
  return phase1Body(legacy, minimalBody(minArgs({ block: legacy.index, ladder: legacy.ladder, at: legacy.at })));
};

await acheck('the PHASE-1 body: pcnaibot credits the index exactly as before, and holds on stale or unknown', async () => {
  const r = validateRateBody(text(v1Of(block())), PCNAIBOT_BOUNDS, LEGACY_RATE);
  assert.equal(r.rateText, '0.027335212'); assert.equal(r.fieldUsed, 'creditRateUsd'); assert.equal(r.diverged, false);
  for (const ix of [block({ stale: true, ageSeconds: 668 }), block({ state: 'unknown', usd: null, seq: null })]) {
    assert.throws(() => validateRateBody(text(v1Of(ix)), PCNAIBOT_BOUNDS, LEGACY_RATE),
      (e) => e instanceof RateInsane && /ladder\.stale is true/.test(e.reason), 'the same refusal, same reason');
  }
});

await acheck('the PHASE-1 body: the exchange quotes sellPriceUsd as before, and pulls the bots on stale or unknown', async () => {
  const ok = await fetchSellPrice({ url: 'http://x/', fetchImpl: fetchOf(text(v1Of(block()))), staleSeconds: EXCHANGE_STALE_SECONDS, attempts: 1 });
  assert.equal(ok.usable, true, ok.reason); assert.equal(ok.sellPriceUsd, '0.028155268');
  for (const ix of [block({ stale: true, ageSeconds: 668 }), block({ state: 'unknown', usd: null, seq: null })]) {
    const r = await fetchSellPrice({ url: 'http://x/', fetchImpl: fetchOf(text(v1Of(ix))), staleSeconds: EXCHANGE_STALE_SECONDS, attempts: 1 });
    // Same outcome. The REASON now names the top-level flag, because it is
    // unified and the exchange checks it before ladder.stale.
    assert.equal(r.usable, false); assert.equal(r.kind, 'bad'); assert.match(r.reason, /stale/);
  }
});

assert.equal(pending, 8);
console.log(`ALL ${n} CHECKS PASSED`);
