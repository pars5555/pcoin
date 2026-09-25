#!/usr/bin/env node
// The wPCN credit rate, on both shapes of the price.pc.am body.
//
//   node rate-test.mjs
//
// PURE: rate.mjs is handed parsed bodies; nothing is fetched, nothing credited.
//
// The owner, 2026-09-25: "simplify the price.pc.am json response ... check
// every service which field is using ... fix all". price.pc.am first ADDS the
// minimal fields (creditRateUsd/state/seq/stale/ageSeconds/...) and later
// REMOVES the old ones (serviceRate, ladder, index, pool, note, ...). So the
// three bodies that matter:
//
//   today's          captured live from https://price.pc.am/ on 2026-09-25
//                    13:39 UTC, verbatim            -> credits
//   minimal          the same numbers, new shape    -> credits
//   minimal, stale   `stale: true`                  -> HOLDS
//
// plus the transition (both sets at once), and the ways each could be misread.
// The last block runs the rule this file REPLACED against the minimal body and
// requires it to refuse -- proof the fixtures distinguish the shapes.
import { creditRateFromBody } from './rate.mjs';

let failed = 0;
function ok(name, cond, detail = '') {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (detail ? '   ' + detail : ''));
  if (!cond) failed++;
}
const clone = (o) => JSON.parse(JSON.stringify(o));
/** The rate, or the refusal's message. A throw is a hold. */
const read = (j) => { try { return { rate: creditRateFromBody(j) }; } catch (e) { return { hold: e.message }; } };

// Verbatim, from `curl -s https://price.pc.am/` at 2026-09-25T13:39:22Z.
const TODAY = JSON.parse(`{"price":0.027550589,"serviceRate":0.026748145,"creditRateUsd":0.026748145,"sellPriceUsd":0.027550589,"rateFieldToUse":"creditRateUsd","rateFollowsPoolDown":false,"rateFloorUsd":0.015,"pool":{"spotUsd":0.027246974914188885,"medianUsd":0.026748145216180963,"windowHours":6,"samples":2000,"ageSeconds":17,"rateHeldAboveBy":null},"index":{"usd":0.026748145,"state":"held","seq":1,"ageSeconds":19,"stale":false,"lastMoveAt":null,"window":{"hours":168,"trades":4,"entities":5,"countedPcn":"757.00000000","countedUsd":"16.817790","qualifies":false},"limitedBy":[],"reasons":["too little evidence in every window; the widest (168 h) has 4 counted fills (5 needed), $16.81 counted ($25.00 needed)"],"refused":null,"inUse":true,"source":"https://exchange.pc.am/api/index"},"currency":"USD","buybackOpen":false,"buybackPrice":null,"buybackRemainingToday":0,"ladder":{"price":0.027550589,"soldPcn":38571.36624107,"remainingPcn":16387.70607446,"ageSeconds":19,"stale":false},"note":"The PCN price is the PCN index: the volume-weighted median price of real user-to-user trades on exchange.pc.am, a small order book the project runs. Trades with the project's own bots, and trades between linked accounts, do not count. It moves only when new qualifying trades arrive, by at most 2% per trade and 5% in 24 hours, and when there is too little trading it holds its last value. It never goes below a floor of $0.0150 or above a ceiling of $0.10. What PCoin services credit one PCN at (creditRateUsd, also published as serviceRate) is the index itself. sellPriceUsd is what market.pc.am charges for PCN, and it never credits anything. If the index is more than 10 minutes old, or the exchange reports it as unknown, GET /credit-rate answers 503 and ladder.stale is true: hold the credit and try again later, never guess a rate. The wPCN PancakeSwap pool is not an input to this price. The ladder block is kept only so older integrations keep working: its price is sellPriceUsd and its stale flag follows the index. This service is not buying PCN back at present.","role":"replica","stale":false,"stateAgeSeconds":0,"at":"2026-09-25T13:39:22.114Z"}`);
const MINIMAL = {
  creditRateUsd: 0.026748145, sellPriceUsd: 0.027550589, poolUsd: 0.027246974914188885,
  floorUsd: 0.015, state: 'held', seq: 1, stale: false, ageSeconds: 19, at: '2026-09-25T13:39:22.114Z',
};
const RATE = 0.026748145;

console.log('\n  wpcn-pay credit rate  --  both price.pc.am body shapes\n  ' + '-'.repeat(56));

// ---- the three bodies ------------------------------------------------------
let r = read(TODAY);
ok("today's body credits at creditRateUsd", r.rate === RATE, JSON.stringify(r));
r = read(MINIMAL);
ok('the minimal body credits at creditRateUsd', r.rate === RATE, JSON.stringify(r));
r = read({ ...MINIMAL, stale: true });
ok('the minimal body with stale: true HOLDS', r.hold && /stale/.test(r.hold), r.hold);
r = read({ ...clone(TODAY), ...MINIMAL });
ok('the transition body (both sets) credits', r.rate === RATE, JSON.stringify(r));

// ---- today's body: the holds it had must survive ---------------------------
let b = clone(TODAY); b.ladder.stale = true; b.index.stale = true;
r = read(b);
ok("today's body, index stale (ladder.stale true, top-level false): HOLDS", !!r.hold, r.hold);
b = clone(TODAY); b.ladder = null;
ok("today's body, ladder: null: HOLDS (as it always did)", !!read(b).hold);
b = clone(TODAY); b.stale = true;
ok("today's body, replica out of sync: HOLDS", !!read(b).hold);
b = clone(TODAY); delete b.ladder.stale;
ok("today's body, ladder.stale missing: HOLDS", !!read(b).hold);
b = { ...clone(TODAY), ...MINIMAL, stale: true };
ok('transition body with stale: true HOLDS even though ladder says fresh', !!read(b).hold);

// ---- unknown-shaped --------------------------------------------------------
b = { ...MINIMAL }; delete b.stale;
ok('no `stale` at all: HOLDS (an unrecognised body is not a fresh one)', !!read(b).hold);
ok('stale: null HOLDS', !!read({ ...MINIMAL, stale: null }).hold);
ok('stale: "false" (a string) HOLDS', !!read({ ...MINIMAL, stale: 'false' }).hold);
ok('creditRateUsd 0 HOLDS', !!read({ ...MINIMAL, creditRateUsd: 0 }).hold);
ok('creditRateUsd null HOLDS', !!read({ ...MINIMAL, creditRateUsd: null }).hold);
ok('creditRateUsd true HOLDS (Number(true) is 1)', !!read({ ...MINIMAL, creditRateUsd: true }).hold);
ok('creditRateUsd negative HOLDS', !!read({ ...MINIMAL, creditRateUsd: -0.02 }).hold);
ok('creditRateUsd "abc" HOLDS', !!read({ ...MINIMAL, creditRateUsd: 'abc' }).hold);
for (const junk of [null, undefined, 'x', 7, []]) {
  ok(`a body that is not an object (${Array.isArray(junk) ? 'an array' : String(junk)}) HOLDS`, !!read(junk).hold);
}

// ---- never the sale price --------------------------------------------------
ok('sellPriceUsd/price alone is NOT a credit rate',
   !!read({ sellPriceUsd: 0.0275, price: 0.0275, stale: false }).hold);
b = { ...MINIMAL, sellPriceUsd: 0.5 };
ok('a wildly different sellPriceUsd does not move the credit', read(b).rate === RATE);
ok('an old replica with serviceRate only still credits',
   read({ serviceRate: 0.0267, stale: false, ladder: { stale: false } }).rate === 0.0267);
ok('creditRateUsd wins over serviceRate', read({ ...MINIMAL, serviceRate: 0.05 }).rate === RATE);

// ---- control: the rule this replaced cannot read the minimal body ----------
// server.mjs usdRate() until 2026-09-25: `!j.ladder || j.ladder.stale !== false`
// -> hold. On the minimal body that holds FOREVER -- every wPCN claim refused
// the moment price.pc.am drops the ladder block. If this control ever passes,
// the fixtures no longer tell the shapes apart.
const oldRule = (j) => {
  const rate = Number(j.creditRateUsd ?? j.serviceRate);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  if (j.stale === true) return null;
  if (!j.ladder || j.ladder.stale !== false) return null;
  return rate;
};
ok("control: the old rule credits today's body", oldRule(TODAY) === RATE);
ok('control: the old rule would HOLD every minimal body', oldRule(MINIMAL) === null);

console.log('');
if (failed) {
  console.log(`  ${failed} FAILED`);
  process.exit(1);
}
console.log('  all cases passed');
