// BOTH SHAPES of the price.pc.am body, through the rail's own validator.
//
// The owner, 2026-09-25: "simplify the price.pc.am json response ... check
// every service which field is using ... fix all". The root body becomes
//   { creditRateUsd, sellPriceUsd, poolUsd, floorUsd, state, seq, stale,
//     ageSeconds, at }
// -- no `ladder`, no `stateAgeSeconds`, no `pool`, no `rateFieldToUse`. The
// oracle adds those fields first and removes the old ones later, so the three
// bodies that decide money are:
//
//   today's        captured live 2026-09-25 13:39 UTC, verbatim  -> credits
//   minimal        the same numbers in the new shape            -> credits
//   minimal+stale  `stale: true`                                -> REFUSED
//
// Built as TEXT, because the rate is read from the literal (see rate.mjs) --
// JSON.stringify of a parsed body is how the oracle's own pretty-printing is
// reproduced, spaces after the colons included.

import test from 'node:test';
import assert from 'node:assert/strict';

import { validateRateBody, RateInsane } from '../lib/rate.mjs';

const BOUNDS = { maxStateAgeS: 900, maxLadderAgeS: 900, maxPoolAgeS: 900, maxJumpFactor: 10 };

const TODAY = JSON.parse(`{"price":0.027550589,"serviceRate":0.026748145,"creditRateUsd":0.026748145,"sellPriceUsd":0.027550589,"rateFieldToUse":"creditRateUsd","rateFollowsPoolDown":false,"rateFloorUsd":0.015,"pool":{"spotUsd":0.027246974914188885,"medianUsd":0.026748145216180963,"windowHours":6,"samples":2000,"ageSeconds":17,"rateHeldAboveBy":null},"index":{"usd":0.026748145,"state":"held","seq":1,"ageSeconds":19,"stale":false,"lastMoveAt":null,"window":{"hours":168,"trades":4,"entities":5,"countedPcn":"757.00000000","countedUsd":"16.817790","qualifies":false},"limitedBy":[],"reasons":["too little evidence in every window; the widest (168 h) has 4 counted fills (5 needed), $16.81 counted ($25.00 needed)"],"refused":null,"inUse":true,"source":"https://exchange.pc.am/api/index"},"currency":"USD","buybackOpen":false,"buybackPrice":null,"buybackRemainingToday":0,"ladder":{"price":0.027550589,"soldPcn":38571.36624107,"remainingPcn":16387.70607446,"ageSeconds":19,"stale":false},"note":"The PCN price is the PCN index: the volume-weighted median price of real user-to-user trades on exchange.pc.am, a small order book the project runs. Trades with the project's own bots, and trades between linked accounts, do not count. It moves only when new qualifying trades arrive, by at most 2% per trade and 5% in 24 hours, and when there is too little trading it holds its last value. It never goes below a floor of $0.0150 or above a ceiling of $0.10. What PCoin services credit one PCN at (creditRateUsd, also published as serviceRate) is the index itself. sellPriceUsd is what market.pc.am charges for PCN, and it never credits anything. If the index is more than 10 minutes old, or the exchange reports it as unknown, GET /credit-rate answers 503 and ladder.stale is true: hold the credit and try again later, never guess a rate. The wPCN PancakeSwap pool is not an input to this price. The ladder block is kept only so older integrations keep working: its price is sellPriceUsd and its stale flag follows the index. This service is not buying PCN back at present.","role":"replica","stale":false,"stateAgeSeconds":0,"at":"2026-09-25T13:39:22.114Z"}`);
const MINIMAL = {
  creditRateUsd: 0.026748145, sellPriceUsd: 0.027550589, poolUsd: 0.027246974914188885,
  floorUsd: 0.015, state: 'held', seq: 1, stale: false, ageSeconds: 19, at: '2026-09-25T13:39:22.114Z',
};
const text = (o) => JSON.stringify(o, null, 2);
const drop = (o, k) => { const c = { ...o }; delete c[k]; return c; };

test("today's body credits at creditRateUsd", () => {
  const r = validateRateBody(text(TODAY), BOUNDS, null);
  assert.equal(r.rateText, '0.026748145');
  assert.equal(r.fieldUsed, 'creditRateUsd');
  assert.equal(r.rateFloorUsd, 0.015);
});

test('the MINIMAL body credits at creditRateUsd', () => {
  const r = validateRateBody(text(MINIMAL), BOUNDS, null);
  assert.equal(r.rateText, '0.026748145');
  assert.equal(r.fieldUsed, 'creditRateUsd');
  assert.equal(r.fieldNamed, null, 'no rateFieldToUse any more, so nothing to alert on');
  assert.equal(r.rateFloorUsd, 0.015, 'floorUsd is the floor in the minimal body (floorParity reads it)');
});

test('the MINIMAL body with stale: true is REFUSED', () => {
  assert.throws(() => validateRateBody(text({ ...MINIMAL, stale: true }), BOUNDS, null), RateInsane);
});

test('the transition body (both sets at once) credits', () => {
  const r = validateRateBody(text({ ...TODAY, ...MINIMAL }), BOUNDS, null);
  assert.equal(r.rateText, '0.026748145');
});

// ---- the minimal body's own clock -----------------------------------------
test('minimal: ageSeconds over the bound is refused', () => {
  assert.throws(() => validateRateBody(text({ ...MINIMAL, ageSeconds: 901 }), BOUNDS, null), /ageSeconds 901 > 900/);
});

test('minimal: NO clock at all is refused, never read as fresh', () => {
  // No ladder block AND no ageSeconds: the rate has no clock left to judge.
  assert.throws(() => validateRateBody(text(drop(MINIMAL, 'ageSeconds')), BOUNDS, null), /ageSeconds is absent/);
  assert.throws(() => validateRateBody(text({ ...MINIMAL, ageSeconds: null }), BOUNDS, null), RateInsane);
});

test('minimal: a missing or null stale is refused', () => {
  assert.throws(() => validateRateBody(text(drop(MINIMAL, 'stale')), BOUNDS, null), /stale is undefined/);
  assert.throws(() => validateRateBody(text({ ...MINIMAL, stale: null }), BOUNDS, null), /stale is null/);
});

test('minimal: sellPriceUsd is never the credit rate', () => {
  assert.throws(() => validateRateBody(text(drop(MINIMAL, 'creditRateUsd')), BOUNDS, null),
    /neither creditRateUsd nor serviceRate/);
});

// ---- today's body keeps every refusal it had ------------------------------
test("today's body: ladder.stale true is still refused", () => {
  const b = JSON.parse(JSON.stringify(TODAY)); b.ladder.stale = true;
  assert.throws(() => validateRateBody(text(b), BOUNDS, null), /ladder.stale is true/);
});

test("today's body: ladder null is still refused", () => {
  assert.throws(() => validateRateBody(text({ ...TODAY, ladder: null }), BOUNDS, null), /ladder block is absent/);
});

test("today's body: a never-synced replica (stateAgeSeconds null) is still refused", () => {
  assert.throws(() => validateRateBody(text({ ...TODAY, stateAgeSeconds: null }), BOUNDS, null), /stateAgeSeconds is absent/);
});

test("today's body without stateAgeSeconds AND without ageSeconds is refused", () => {
  // The only way stateAgeSeconds may be missing is beside the minimal body's
  // ageSeconds; a body with neither has no replica clock at all.
  assert.throws(() => validateRateBody(text(drop(TODAY, 'stateAgeSeconds')), BOUNDS, null), /stateAgeSeconds is absent/);
});

test('the transition: a stale ladder still refuses though the top level says fresh', () => {
  const b = { ...JSON.parse(JSON.stringify(TODAY)), ...MINIMAL };
  b.ladder.stale = true;
  assert.throws(() => validateRateBody(text(b), BOUNDS, null), /ladder.stale is true/);
});

test('the transition: a stale top-level ageSeconds refuses though the ladder is fresh', () => {
  assert.throws(() => validateRateBody(text({ ...TODAY, ...MINIMAL, ageSeconds: 5000 }), BOUNDS, null), /ageSeconds 5000/);
});

test('a body that is not an object is refused', () => {
  assert.throws(() => validateRateBody('[{"creditRateUsd": 0.02, "stale": false, "ageSeconds": 1}]', BOUNDS, null),
    /not a JSON object/);
});

// ---- control: the rule this replaced cannot credit the minimal body --------
test('control: before 2026-09-25 the minimal body was refused for want of a ladder', () => {
  // The old check 4, verbatim in effect: a missing ladder block is insane.
  const oldCheck4 = (b) => { if (!b.ladder || typeof b.ladder !== 'object') throw new Error('ladder block is absent'); };
  assert.throws(() => oldCheck4(MINIMAL), /ladder block is absent/,
    'if this stops throwing, the fixture no longer tells the two shapes apart');
  assert.doesNotThrow(() => oldCheck4(TODAY));
});
