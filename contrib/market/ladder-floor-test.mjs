#!/usr/bin/env node
// The price floor on the constant-product curve.
//
//   node ladder-floor-test.mjs
//
// PURE. It calls `ammWalk` directly with synthetic rungs (and, in section 7,
// makeLadder over an in-memory stand-in for the pool), touches no database
// and cannot move the live posted price -- deliberately unlike ladder-test.mjs
// next door, which does both and carries an explicit opt-in for it.
//
// WHY THIS EXISTS. `ladderMinPriceUsd` was applied only by `askCap()`, which is
// on the rung FALLBACK path. While the curve was configured -- which it has been
// since 077fa32 -- the market had no floor at all on what it sold PCN for. The
// setting read like a floor and guarded a code path nobody was taking. This
// test is what stops that being true again, so every case below is also run
// against a deliberately unfloored walk at the end: a floor test that cannot
// fail is the same shape as the bug it is testing for.
import { ammWalk, makeLadder, UNITS } from './ladder.mjs';

const FLOOR = 0.015;
let failed = 0;

function ok(name, cond, detail = '') {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (detail ? '   ' + detail : ''));
  if (!cond) failed++;
}

/** One rung holding `pcn` coins. Only qty_* and rung_no are read by ammWalk;
 *  `price` is inventory bookkeeping on the curve path, never the price charged. */
const rung = (no, pcn) => ({
  rung_no: no, price: 0.05,
  qty_total: pcn, qty_sold: 0, qty_reserved: 0, qty_retired: 0,
});

// A curve priced WELL BELOW the floor, which is the only case that matters:
// k and v chosen so k/X^2 comes out around $0.006 against a $0.015 floor.
const RUNGS = [rung(1, 20000), rung(2, 20000), rung(3, 20000)];
const REM = 60000, VIRT = 40000;
const X = REM + VIRT;                     // 100,000
const CHEAP_K = 0.006 * X * X;            // spot $0.006  -- 2.5x under the floor
const DEAR_K = 0.030 * X * X;             // spot $0.030  -- well above it

console.log('\n  curve floor  --  floor $' + FLOOR.toFixed(4) +
            ', X = ' + X.toLocaleString() + '\n  ' + '-'.repeat(66));

// ---- 1. the buyer names the MONEY -----------------------------------------
{
  const free = ammWalk(RUNGS, { usd: 100 }, CHEAP_K, VIRT, 0);
  const held = ammWalk(RUNGS, { usd: 100 }, CHEAP_K, VIRT, FLOOR);
  ok('unfloored, $100 buys coins under the floor',
     free.avgPrice < FLOOR, `$${free.avgPrice.toFixed(6)}/PCN for ${free.pcn.toFixed(2)} PCN`);
  ok('floored, $100 pays no less than the floor',
     held.avgPrice >= FLOOR - 1e-9, `$${held.avgPrice.toFixed(8)}/PCN`);
  ok('floored, $100 buys exactly usd/floor coins',
     Math.abs(held.pcn - 100 / FLOOR) < 1e-6,
     `${held.pcn.toFixed(6)} vs ${(100 / FLOOR).toFixed(6)}`);
  ok('the floor gives the buyer FEWER coins, never more',
     held.pcn < free.pcn, `${held.pcn.toFixed(2)} < ${free.pcn.toFixed(2)}`);
  ok('the buyer still spends what they offered',
     Math.abs(held.cost - 100) < 1e-9, `$${held.cost}`);
}

// ---- 2. the buyer names the COINS -----------------------------------------
{
  const free = ammWalk(RUNGS, { pcn: 5000 }, CHEAP_K, VIRT, 0);
  const held = ammWalk(RUNGS, { pcn: 5000 }, CHEAP_K, VIRT, FLOOR);
  ok('unfloored, 5,000 PCN sells under the floor',
     free.avgPrice < FLOOR, `$${free.avgPrice.toFixed(6)}/PCN`);
  ok('floored, 5,000 PCN costs at least 5,000 x floor',
     held.cost >= 5000 * FLOOR - 1e-9, `$${held.cost.toFixed(6)} >= $${(5000 * FLOOR).toFixed(2)}`);
  ok('floored, the buyer gets the coins they asked for',
     Math.abs(held.pcn - 5000) < 1e-6, `${held.pcn}`);
  ok('the floor makes the buyer pay MORE, never less',
     held.cost > free.cost, `$${held.cost.toFixed(2)} > $${free.cost.toFixed(2)}`);
}

// ---- 3. above the floor the curve is untouched ----------------------------
// The clamp must be inert in normal operation, or it is not a floor, it is a
// price change. Every field is compared, not just the average.
{
  const free = ammWalk(RUNGS, { usd: 100 }, DEAR_K, VIRT, 0);
  const held = ammWalk(RUNGS, { usd: 100 }, DEAR_K, VIRT, FLOOR);
  ok('above the floor, the coins are identical',
     Math.abs(free.pcn - held.pcn) < 1e-12, `${free.pcn} vs ${held.pcn}`);
  ok('above the floor, the cost is identical',
     Math.abs(free.cost - held.cost) < 1e-12);
  ok('above the floor, the next price is identical',
     Math.abs(free.marginalAfter - held.marginalAfter) < 1e-12);
  const fp = ammWalk(RUNGS, { pcn: 5000 }, DEAR_K, VIRT, 0);
  const hp = ammWalk(RUNGS, { pcn: 5000 }, DEAR_K, VIRT, FLOOR);
  ok('above the floor, the pcn direction is identical too',
     Math.abs(fp.cost - hp.cost) < 1e-12);
}

// ---- 4. the PUBLISHED next price is floored as well -----------------------
// A quote that says $0.006 and an invoice that charges $0.015 is the exact
// disagreement ammWalk's own header says this file guards against.
{
  const held = ammWalk(RUNGS, { usd: 100 }, CHEAP_K, VIRT, FLOOR);
  ok('the next price quoted is not below the floor',
     held.marginalAfter >= FLOOR - 1e-9, `$${held.marginalAfter.toFixed(8)}`);
}

// ---- 5. a floor of 0 or nonsense must disable it, not break pricing -------
{
  const base = ammWalk(RUNGS, { usd: 100 }, CHEAP_K, VIRT, 0);
  for (const bad of [0, -1, NaN, Infinity, undefined, null, 'x']) {
    const r = ammWalk(RUNGS, { usd: 100 }, CHEAP_K, VIRT, bad);
    ok(`floor ${String(bad)} prices exactly as no floor`,
       r && Math.abs(r.pcn - base.pcn) < 1e-12);
  }
}

// ---- 6. the floor must not let inventory be oversold ----------------------
// usd/floor can exceed what the rungs hold. The allocation loop, not the clamp,
// is what bounds it -- so check the bound survives the clamp.
{
  const huge = ammWalk(RUNGS, { usd: 10_000_000 }, CHEAP_K, VIRT, FLOOR);
  ok('a giant order fills no more than the inventory',
     huge.pcn <= REM + 1 / UNITS, `${huge.pcn} of ${REM}`);
  ok('a giant order reports the unfilled remainder',
     huge.usdUnfilled > 0, `$${huge.usdUnfilled.toFixed(2)} unfilled`);
  ok('a giant order is charged only for what it got',
     huge.cost < 10_000_000, `$${huge.cost.toFixed(2)}`);
}

// ---- 7. the floor is WIRED, on both pricing paths ------------------------
// Adapted for price plan Step 3 (index mode). The original bug was never that
// the floor arithmetic was wrong -- it was that the floor lived on a path the
// live code did not take. Sections 1-6 test the arithmetic; this one goes
// through makeLadder, the way server.mjs does, with ladderMinPriceUsd set as a
// SETTING, on the curve and on the index. And each is run once with the floor
// off, as the control: a wiring test that passes either way proves nothing.
{
  const setting = (over) => k => ({ ladderMinPriceUsd: FLOOR, ammK: CHEAP_K, ammVirtualPcn: VIRT,
                                    ladderMaxPriceUsd: 0, marketPremiumPct: 3,
                                    indexMaxAgeSeconds: 900, ...over })[k];
  // An index under the floor: $0.006 x 1.03 = $0.00618.
  const LOW = () => ({ usd: 0.006, state: 'held', seq: 1, ageSeconds: 10, stale: false });
  // ladderState() only needs the four aggregate SELECTs answered.
  const pool = { query: async sql => {
    const s = String(sql);
    if (/SUM\(qty_total\)/.test(s)) return [[{ tot: REM, sold: 0, resv: 0, retd: 0 }]];
    if (/MIN\(price\)/.test(s)) return [[{ lo: 0.05, hi: 0.05, n: 3, p1: 0.05, p2: 0.05 }]];
    return [[{ price: 0.05 }]];
  } };

  for (const [path, over] of [['curve', { pricingMode: 'curve' }], ['index', { pricingMode: 'index' }]]) {
    const held = makeLadder(pool, { getSetting: setting(over), getIndex: LOW });
    const free = makeLadder(pool, { getSetting: setting({ ...over, ladderMinPriceUsd: 0 }), getIndex: LOW });
    const hw = held.walkUsd(RUNGS, 100), fw = free.walkUsd(RUNGS, 100);
    ok(`${path}: control -- with the floor setting at 0, $100 buys under the floor`,
       fw.avgPrice < FLOOR, `$${fw.avgPrice.toFixed(6)}/PCN`);
    ok(`${path}: with ladderMinPriceUsd set, $100 pays no less than the floor`,
       hw.avgPrice >= FLOOR - 1e-9 && hw.pcn <= 100 / FLOOR + 1e-8, `$${hw.avgPrice.toFixed(8)}/PCN`);
    const hp = held.walkPcn(RUNGS, 5000);
    ok(`${path}: 5,000 PCN costs at least 5,000 x floor`, hp.cost >= 5000 * FLOOR - 1e-9, `$${hp.cost.toFixed(6)}`);
    const st = await held.ladderState();
    ok(`${path}: the PUBLISHED price is floored too`,
       st.marginalPrice >= FLOOR - 1e-12 && st.nextFillPrice >= FLOOR - 1e-12, `$${st.marginalPrice}`);
  }
}

console.log('');
if (failed) {
  console.log(`  ${failed} FAILED`);
  process.exit(1);
}
console.log('  all cases passed');
