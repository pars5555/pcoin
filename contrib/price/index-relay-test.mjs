// node contrib/price/index-relay-test.mjs -- pure, touches nothing.
// Every refusal in index-relay.mjs is proved to FIRE here, and every healthy
// reading is proved to pass: a guard only ever seen passing is untested.
import assert from 'node:assert/strict';
import { INDEX_RULES, validateIndexBody, confirmTwice, speedCheck, remember,
         indexUsable, rateFromIndex, switchCheck, indexLadder, indexNote } from './index-relay.mjs';
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
console.log(`ALL ${n} CHECKS PASSED`);
