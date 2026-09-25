#!/usr/bin/env node
// Both shapes of the price.pc.am body, through the market's readers.
//
//   node price-feed-test.mjs
//
// PURE. No network, no database: price-feed.mjs is handed parsed bodies, and
// ladder.mjs indexUnitPrice() -- the function that decides whether the market
// sells at all in index mode -- judges what indexFromPriceBody() returns.
//
// WHY THIS EXISTS. The owner, 2026-09-25: "simplify the price.pc.am json
// response ... check every service which field is using ... fix all". The root
// body loses serviceRate, index.*, ladder.*, pool.* and note, and gains
// creditRateUsd/state/seq/stale/ageSeconds at the top level. price.pc.am adds
// the new fields first and removes the old ones later, so every reader has to
// give the same answer on THREE bodies:
//
//   today's            -- captured live from https://price.pc.am/ on
//                         2026-09-25 13:39 UTC, verbatim below
//   the minimal one    -- the same numbers in the new shape
//   minimal + stale    -- which must HOLD: the market closes, no rate is used
//
// The last section runs the market's OLD index read on the minimal body and
// requires it to fail, so this file is proved able to tell the shapes apart
// rather than passing because every body happened to carry an `index` block.
import { indexFromPriceBody, creditRateFromPriceBody } from './price-feed.mjs';
import { indexUnitPrice } from './ladder.mjs';

let failed = 0;
function ok(name, cond, detail = '') {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (detail ? '   ' + detail : ''));
  if (!cond) failed++;
}
const clone = (o) => JSON.parse(JSON.stringify(o));

// Verbatim, from `curl -s https://price.pc.am/` at 2026-09-25T13:39:22Z (a
// replica answered; index mode, state held).
const TODAY = JSON.parse(`{"price":0.027550589,"serviceRate":0.026748145,"creditRateUsd":0.026748145,"sellPriceUsd":0.027550589,"rateFieldToUse":"creditRateUsd","rateFollowsPoolDown":false,"rateFloorUsd":0.015,"pool":{"spotUsd":0.027246974914188885,"medianUsd":0.026748145216180963,"windowHours":6,"samples":2000,"ageSeconds":17,"rateHeldAboveBy":null},"index":{"usd":0.026748145,"state":"held","seq":1,"ageSeconds":19,"stale":false,"lastMoveAt":null,"window":{"hours":168,"trades":4,"entities":5,"countedPcn":"757.00000000","countedUsd":"16.817790","qualifies":false},"limitedBy":[],"reasons":["too little evidence in every window; the widest (168 h) has 4 counted fills (5 needed), $16.81 counted ($25.00 needed)"],"refused":null,"inUse":true,"source":"https://exchange.pc.am/api/index"},"currency":"USD","buybackOpen":false,"buybackPrice":null,"buybackRemainingToday":0,"ladder":{"price":0.027550589,"soldPcn":38571.36624107,"remainingPcn":16387.70607446,"ageSeconds":19,"stale":false},"note":"The PCN price is the PCN index: the volume-weighted median price of real user-to-user trades on exchange.pc.am, a small order book the project runs. Trades with the project's own bots, and trades between linked accounts, do not count. It moves only when new qualifying trades arrive, by at most 2% per trade and 5% in 24 hours, and when there is too little trading it holds its last value. It never goes below a floor of $0.0150 or above a ceiling of $0.10. What PCoin services credit one PCN at (creditRateUsd, also published as serviceRate) is the index itself. sellPriceUsd is what market.pc.am charges for PCN, and it never credits anything. If the index is more than 10 minutes old, or the exchange reports it as unknown, GET /credit-rate answers 503 and ladder.stale is true: hold the credit and try again later, never guess a rate. The wPCN PancakeSwap pool is not an input to this price. The ladder block is kept only so older integrations keep working: its price is sellPriceUsd and its stale flag follows the index. This service is not buying PCN back at present.","role":"replica","stale":false,"stateAgeSeconds":0,"at":"2026-09-25T13:39:22.114Z"}`);

// The same moment in the minimal shape.
const MINIMAL = {
  creditRateUsd: 0.026748145, sellPriceUsd: 0.027550589, poolUsd: 0.027246974914188885,
  floorUsd: 0.015, state: 'held', seq: 1, stale: false, ageSeconds: 19, at: '2026-09-25T13:39:22.114Z',
};
const MINIMAL_STALE = { ...MINIMAL, stale: true };
// The transition: both sets at once, as price.pc.am will publish between the
// two steps.
const BOTH = { ...clone(TODAY), ...MINIMAL };

const RATE = 0.026748145;
const PRICING = { premiumPct: 3, floor: 0.015, maxAgeS: 600 };
const near = (a, b) => Math.abs(a - b) < 1e-12;

console.log('\n  price.pc.am, both body shapes  --  the market\'s readers\n  ' + '-'.repeat(60));

// ---- 1. the credit rate: works, works, holds ------------------------------
{
  const t = creditRateFromPriceBody(TODAY);
  ok("today's body: the credit rate is creditRateUsd", t.ok && near(t.rate, RATE), JSON.stringify(t));
  const m = creditRateFromPriceBody(MINIMAL);
  ok('minimal body: the credit rate is creditRateUsd', m.ok && near(m.rate, RATE), JSON.stringify(m));
  ok('minimal body: its age is the top-level ageSeconds', m.ageSeconds === 19);
  const s = creditRateFromPriceBody(MINIMAL_STALE);
  ok('minimal body, stale: HOLDS', !s.ok && /stale/.test(s.why), s.why);
  const b = creditRateFromPriceBody(BOTH);
  ok('transition body (both sets): works', b.ok && near(b.rate, RATE));
}

// ---- 2. the index the market prices with: works, works, market closes ----
{
  const t = indexUnitPrice(indexFromPriceBody(TODAY), PRICING);
  ok("today's body: the market prices at index x 1.03", t.ok && near(t.unitPrice, RATE * 1.03), JSON.stringify(t));
  const m = indexUnitPrice(indexFromPriceBody(MINIMAL), PRICING);
  ok('minimal body: the same price', m.ok && near(m.unitPrice, RATE * 1.03), JSON.stringify(m));
  const s = indexUnitPrice(indexFromPriceBody(MINIMAL_STALE), PRICING);
  ok('minimal body, stale: the MARKET CLOSES', !s.ok && /vouch/.test(s.why), s.why);
  const b = indexFromPriceBody(BOTH);
  ok('transition body: works', b.state === 'held' && b.seq === 1 && b.ageSeconds === 19 && b.stale === false);
  const ix = indexFromPriceBody(MINIMAL);
  ok('minimal body: seq is carried (pricing-mode.mjs compares it)', ix.seq === 1);

  // Rolled back ({"useIndex":0}) in phase 1, creditRateUsd is the pool-follow
  // rate and the `index` block is still the index. The market sells at the INDEX.
  const rolled = { ...clone(TODAY), ...MINIMAL, creditRateUsd: 0.02 };
  ok('transition: the INDEX BLOCK is the index, not the top-level creditRateUsd',
     near(indexFromPriceBody(rolled).usd, RATE), String(indexFromPriceBody(rolled).usd));
  const topStale = { ...clone(TODAY), ...MINIMAL, stale: true };
  ok("transition: price.pc.am's unified top-level stale closes the market, though the block says fresh",
     !indexUnitPrice(indexFromPriceBody(topStale), PRICING).ok);
  const topNull = { ...clone(TODAY), ...MINIMAL, stale: null };
  ok('transition: a top-level stale of null closes it too', !indexUnitPrice(indexFromPriceBody(topNull), PRICING).ok);
  const blockStale = { ...clone(TODAY), ...MINIMAL }; blockStale.index.stale = true;
  ok('transition: a stale index block closes it, though the top level says fresh',
     !indexUnitPrice(indexFromPriceBody(blockStale), PRICING).ok);
}

// ---- 3. unknown-shaped: every "I do not know" holds -----------------------
{
  const unknown = indexUnitPrice(indexFromPriceBody({ ...MINIMAL, state: 'unknown' }), PRICING);
  ok('minimal body, state unknown: the market closes', !unknown.ok && /unknown/.test(unknown.why), unknown.why);
  const disabled = indexUnitPrice(indexFromPriceBody({ ...MINIMAL, state: 'disabled' }), PRICING);
  ok('minimal body, state disabled: the market closes', !disabled.ok);
  const old = indexUnitPrice(indexFromPriceBody({ ...MINIMAL, ageSeconds: 601 }), PRICING);
  ok('minimal body, too old: the market closes', !old.ok && /601 s ago/.test(old.why), old.why);
  const noAge = { ...MINIMAL }; delete noAge.ageSeconds;
  ok('minimal body, no ageSeconds: the market closes', !indexUnitPrice(indexFromPriceBody(noAge), PRICING).ok);

  const noStale = { ...MINIMAL }; delete noStale.stale;
  ok('a missing top-level stale is not "fresh" (credit rate)', !creditRateFromPriceBody(noStale).ok);
  ok('a missing top-level stale is not "fresh" (index)', !indexUnitPrice(indexFromPriceBody(noStale), PRICING).ok);
  ok('stale: null holds', !creditRateFromPriceBody({ ...MINIMAL, stale: null }).ok);

  const ixStale = clone(TODAY); ixStale.index.stale = true; ixStale.ladder.stale = true;
  ok("today's body, index stale (ladder.stale follows it): the credit rate HOLDS",
     !creditRateFromPriceBody(ixStale).ok, creditRateFromPriceBody(ixStale).why);
  ok("today's body, index stale: the market closes", !indexUnitPrice(indexFromPriceBody(ixStale), PRICING).ok);
  const ladderNull = clone(TODAY); ladderNull.ladder = null;
  ok("today's body with ladder: null holds (it did before; transition must not loosen it)",
     !creditRateFromPriceBody(ladderNull).ok);
  const replica = clone(TODAY); replica.stale = true;
  ok("today's body, replica out of sync (top-level stale): holds", !creditRateFromPriceBody(replica).ok);

  const oldReplica = { serviceRate: 0.0267, stale: false, ladder: { stale: false, ageSeconds: 5 } };
  const or = creditRateFromPriceBody(oldReplica);
  ok('an old replica with serviceRate only still answers', or.ok && near(or.rate, 0.0267), JSON.stringify(or));
  ok('never the SALE price: sellPriceUsd/price alone is no credit rate',
     !creditRateFromPriceBody({ sellPriceUsd: 0.0275, price: 0.0275, stale: false }).ok);
  ok('creditRateUsd 0 is no rate', !creditRateFromPriceBody({ ...MINIMAL, creditRateUsd: 0 }).ok);
  ok('creditRateUsd null is no rate (Number(null) would be 0)', !creditRateFromPriceBody({ ...MINIMAL, creditRateUsd: null }).ok);
  ok('creditRateUsd true is no rate (Number(true) would be 1)', !creditRateFromPriceBody({ ...MINIMAL, creditRateUsd: true }).ok);
  for (const junk of [null, undefined, 'x', 42, [MINIMAL]]) {
    ok(`not an object (${Array.isArray(junk) ? 'an array' : JSON.stringify(junk) ?? 'undefined'}) holds`,!creditRateFromPriceBody(junk).ok && indexFromPriceBody(junk) === null);
  }
  ok('no index anywhere: null (the market says "publishes no index")', indexFromPriceBody({ creditRateUsd: 0.02, stale: false }) === null);
}

// ---- 4. control: the OLD reader cannot read the minimal body --------------
// What server.mjs refreshIndex() did until 2026-09-25: `j.index`. If this ever
// passes, the fixtures above no longer tell the two shapes apart.
{
  const oldRead = (j) => (j && j.index && typeof j.index === 'object' ? j.index : null);
  const oldRate = (j) => Number(j.serviceRate);
  ok('control: the old index read finds nothing in the minimal body', oldRead(MINIMAL) === null);
  ok('control: the old serviceRate read gets NaN from the minimal body', Number.isNaN(oldRate(MINIMAL)));
  ok("control: the old reads still work on today's body", oldRead(TODAY) !== null && near(oldRate(TODAY), RATE));
}

console.log('');
if (failed) {
  console.log(`  ${failed} FAILED`);
  process.exit(1);
}
console.log('  all cases passed');
