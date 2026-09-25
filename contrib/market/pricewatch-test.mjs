#!/usr/bin/env node
// Tests for pricewatch.mjs.   node pricewatch-test.mjs
//
// Runs entirely against fabricated states — no database, no ladder, no network.
// That is deliberate, and it is the lesson from the two tests that came before
// it: `ladder-test.mjs` drives the REAL ladder and so briefly moves the posted
// price (and once dragged serviceRate 10% with it). A test for an alerting
// module has no business touching production to prove a string is correct.
//
// WHAT THIS PINS DOWN
// The first version of this alert reported ANY rise in qty_retired as
// "spent on the services". That is an inference, not an observation — and the
// first two times it fired, both were direct SQL edits during testing, so it
// announced 947 PCN of customer revenue that did not exist. An alert that
// invents a business reason is worse than no alert, because it is believed.
//
// The distinction it must now hold:
//   ladder qty_retired moved AND the retirements ledger moved with it -> spending
//   ladder moved, ledger did not                                       -> an edit
//   ledger could not be read at all                                    -> unknown
// and "unknown" must never render as either of the other two.

import { makePriceWatch } from './pricewatch.mjs';

const sent = [];
const notify = async m => { sent.push(m); return true; };
const state = new Map();
let LADDER, LEDGER, LEDGER_THROWS = false;

const pool = { query: async (sql, args = []) => {
  if (/FROM market_state/.test(sql)) { const v = state.get(args[0]); return [v ? [{ v }] : []]; }
  if (/INTO market_state/.test(sql)) { state.set(args[0], args[1]); return [{}]; }
  if (/FROM retirements/.test(sql)) {
    if (LEDGER_THROWS) throw new Error('Lost connection to MySQL server');
    return [[{ t: LEDGER }]];
  }
  return [[]];
}};
const ladder = { ladderState: async () => LADDER };
const PW = makePriceWatch({ pool, ladder, notify, log: { log() {}, warn() {} } });

const set = (price, sold, retired, remaining, ledger) => {
  LADDER = { marginalPrice: price, soldPcn: sold, retiredPcn: retired, remainingPcn: remaining };
  LEDGER = ledger;
};

let pass = 0, fail = 0;
const ok = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}\n         ${d}`); }
};

console.log('\nbaseline');
set(0.015, 0, 40, 99960, 40);
await PW.check();
ok('first run is silent — no "before" exists yet', sent.length === 0, `sent ${sent.length}`);

console.log('\ncause attribution');
sent.length = 0; set(0.0160182693, 0, 987, 99013, 987); await PW.check();
ok('ladder and ledger agree -> customer spending',
   /customers spent on the services/i.test(sent[0] || ''), sent[0]);
ok('  ...and carries no warning', !/⚠️/.test(sent[0] || ''), sent[0]);

sent.length = 0; set(0.0171056633, 0, 1817, 98183, 987); await PW.check();
ok('ledger did not move -> NOT called spending',
   !/customers spent/i.test(sent[0] || ''), sent[0]);
ok('  ...named as a direct edit',
   /NO payment on chain|edited directly/i.test(sent[0] || ''), sent[0]);

sent.length = 0; set(0.018, 0, 2817, 97183, 1487); await PW.check();
ok('partly backed -> reports both amounts separately',
   /only .* matched by a payment/i.test(sent[0] || ''), sent[0]);

console.log('\nunknown must stay unknown');
sent.length = 0; LEDGER_THROWS = true; set(0.019, 0, 3817, 96183, 1487); await PW.check();
ok('a throwing ledger read -> "cause unverified"',
   /cause unverified/i.test(sent[0] || ''), sent[0]);
ok('  ...does not claim spending', !/customers spent/i.test(sent[0] || ''), sent[0]);
ok('  ...does not accuse an edit either', !/NO payment on chain/i.test(sent[0] || ''), sent[0]);
LEDGER_THROWS = false;

// A null/non-numeric total must not collapse to 0 via `?? 0` — that would turn
// a failed read into the accusation "retired with NO payment on chain".
sent.length = 0; set(0.020, 0, 4817, 95183, null); await PW.check();
ok('a non-numeric ledger total -> unverified, not zero',
   /cause unverified/i.test(sent[0] || ''), sent[0]);

console.log('\nquiet when nothing happens');
sent.length = 0; await PW.check();
ok('no price change -> no message', sent.length === 0, `sent ${sent.length}`);

// INDEX MODE (price plan Step 3). The price is the PCN index x a setting, so
// neither sales nor retirements move it: any cause worked out from those deltas
// would be invented. And an index nobody can vouch for publishes a null price,
// which must not be announced as "the ladder is empty".
console.log('\nindex mode');
const idx = (price, extra = {}) => {
  LADDER = { marginalPrice: price, soldPcn: 0, retiredPcn: 4817, remainingPcn: 95183,
             pricingMode: 'index', premiumPct: 3, index: { usd: 0.0273, seq: 4 }, priceUnavailable: null,
             ...extra };
  LEDGER = 4817;
};
sent.length = 0; idx(null, { priceUnavailable: 'the PCN index is unknown' });
const r1 = await PW.check();
ok('an unusable index is not announced at all', sent.length === 0, sent[0]);
ok('  ...and is not written as the new baseline', r1.ok === false && JSON.parse(state.get('lastPublishedPrice')).price === 0.020,
   state.get('lastPublishedPrice'));
sent.length = 0; idx(0.028119);
await PW.check();
ok('an index move says it is the index, with its seq',
   /index mode: the PCN index is now \$0\.0273 \(seq 4\)/.test(sent[0] || ''), sent[0]);
ok('  ...and invents no sale, retirement or edit behind it',
   !/PCN sold|customers spent|PCN retired|edited directly|ladder itself was changed/i.test(sent[0] || ''), sent[0]);
ok('  ...headed as the market price, not the ladder', /Market price moved/.test(sent[0] || ''), sent[0]);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
