#!/usr/bin/env node
// Index-mode pricing -- price plan Step 3.
//
//   node ladder-index-test.mjs
//
// PURE. flatWalk and indexUnitPrice are called directly with synthetic rungs,
// and makeLadder runs over a fake pool that answers the ladder's four SELECTs
// from memory. No database, no network, nothing that can touch the live price.
//
// What it pins down (D:\pc.am\PCOIN-PRICE-EXCHANGE-ANCHOR-PLAN.md §5 Step 3):
//   1. usd -> pcn and pcn -> usd are exact, to the satoshi
//   2. the premium is applied, and the price is FLAT at every order size
//   3. the floor clamps both directions, and only below it
//   4. rung allocation is identical to ammWalk's for the same quantity
//   5. an unknown or stale index REFUSES -- and never falls back to the curve
//   6. a partial fill when the inventory runs out
//   7. curve mode is untouched: same result, field for field, as before
import { flatWalk, indexUnitPrice, ammWalk, makeLadder, UNITS, INDEX_PRICED_STATES } from './ladder.mjs';

let failed = 0, passed = 0;
function ok(name, cond, detail = '') {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (detail ? '   ' + detail : ''));
  if (cond) passed++; else failed++;
}
const sect = t => console.log('\n  ' + t + '\n  ' + '-'.repeat(66));

/** A rung. qty_* in PCN, as the DECIMAL columns come back (strings are fine too). */
const rung = (no, total, sold = 0, reserved = 0, retired = 0) => ({
  rung_no: no, price: 0.015 * 1.0679 ** (no - 1),
  qty_total: total, qty_sold: sold, qty_reserved: reserved, qty_retired: retired,
});
// Three rungs, the first partly sold, reserved and retired, so allocation has
// to skip stock that is not for sale -- the part of ammWalk being mirrored.
// Large enough that $380 at the index, and $100 at the floor, both fill in full.
const RUNGS = [rung(1, 10000, 4000, 1000, 500), rung(2, 10000), rung(3, 10000, 0, 10000), rung(4, 10000)];
const AVAIL = 4500 + 10000 + 0 + 10000;       // 24,500 PCN actually for sale

const FRESH = { usd: 0.027335212, state: 'held', seq: 7, ageSeconds: 42, stale: false };
const P = 3, FLOOR = 0.015, MAXAGE = 900;
const U = indexUnitPrice(FRESH, { premiumPct: P, floor: FLOOR, maxAgeS: MAXAGE }).unitPrice;

// ── 1. exact both ways ─────────────────────────────────────────────────────
sect('1. usd -> pcn and pcn -> usd are exact');
{
  const usd = 20;
  const w = flatWalk(RUNGS, { usd }, U);
  const want = Math.floor((usd / U) * UNITS) / UNITS;
  ok('$20 buys floor($20 / price) coins, to the satoshi', w.pcn === want, `${w.pcn} vs ${want}`);
  ok('the buyer pays exactly the $20 offered', w.cost === usd, `$${w.cost}`);
  ok('never a satoshi more than was paid for', w.pcn * U <= usd + 1e-12, `${w.pcn * U} <= ${usd}`);
  ok('the remainder kept is under one satoshi\'s worth', usd - w.pcn * U < U / UNITS + 1e-15,
     `${(usd - w.pcn * U).toExponential(3)} < ${(U / UNITS).toExponential(3)}`);
  ok('nothing unfilled', w.usdUnfilled === 0 && w.pcnUnfilled === 0);

  const pcn = 1234.56789012;
  const v = flatWalk(RUNGS, { pcn }, U);
  ok('1,234.56789012 PCN is delivered to the satoshi', v.pcn === pcn, `${v.pcn}`);
  ok('and costs exactly pcn x price', v.cost === pcn * U, `$${v.cost} vs $${pcn * U}`);
  ok('pcn -> usd -> pcn round-trips', flatWalk(RUNGS, { usd: v.cost }, U).pcn >= pcn - 1 / UNITS);
}

// ── 2. premium and flatness ────────────────────────────────────────────────
sect('2. the premium is applied, and the price is flat');
{
  const q3 = indexUnitPrice(FRESH, { premiumPct: 3, floor: FLOOR, maxAgeS: MAXAGE });
  const q0 = indexUnitPrice(FRESH, { premiumPct: 0, floor: FLOOR, maxAgeS: MAXAGE });
  ok('3% on the index', q3.ok && q3.unitPrice === FRESH.usd * 1.03, `$${q3.unitPrice}`);
  ok('0% is the index itself', q0.ok && q0.unitPrice === FRESH.usd, `$${q0.unitPrice}`);
  ok('it reports the index and premium it used', q3.indexUsd === FRESH.usd && q3.premiumPct === 3);
  const sizes = [20, 100, 380].map(usd => flatWalk(RUNGS, { usd }, U));
  ok('$20, $100 and $380 all pay the same price a coin',
     sizes.every(w => w.avgPrice === U), sizes.map(w => w.avgPrice).join(' / '));
  ok('and every one leaves the next price where it was',
     sizes.every(w => w.marginalAfter === U));
  const coins = [1, 10, 12000].map(pcn => flatWalk(RUNGS, { pcn }, U));
  ok('1, 10 and 12,000 PCN all cost the same a coin', coins.every(w => w.avgPrice === U));
}

// ── 3. the floor ───────────────────────────────────────────────────────────
sect('3. the floor clamps both directions, and only below it');
{
  const low = { ...FRESH, usd: 0.012 };                       // x1.03 = 0.01236 < 0.015
  const held = indexUnitPrice(low, { premiumPct: P, floor: FLOOR, maxAgeS: MAXAGE });
  const free = indexUnitPrice(low, { premiumPct: P, floor: 0, maxAgeS: MAXAGE });
  ok('control: without the floor the price is under it', free.unitPrice < FLOOR, `$${free.unitPrice}`);
  ok('with it, the price is exactly the floor', held.unitPrice === FLOOR && held.floored === true);
  const wu = flatWalk(RUNGS, { usd: 100 }, held.unitPrice);
  const fu = flatWalk(RUNGS, { usd: 100 }, free.unitPrice);
  ok('named the MONEY: floor($100 / floor) coins', wu.pcn === Math.floor((100 / FLOOR) * UNITS) / UNITS, `${wu.pcn}`);
  ok('...FEWER coins than unfloored, never more', wu.pcn < fu.pcn, `${wu.pcn} < ${fu.pcn}`);
  const wp = flatWalk(RUNGS, { pcn: 1000 }, held.unitPrice);
  const fp = flatWalk(RUNGS, { pcn: 1000 }, free.unitPrice);
  ok('named the COINS: 1,000 x floor', wp.cost === 1000 * FLOOR, `$${wp.cost}`);
  ok('...MORE money than unfloored, never less', wp.cost > fp.cost);
  const above = indexUnitPrice(FRESH, { premiumPct: P, floor: FLOOR, maxAgeS: MAXAGE });
  ok('above the floor it changes nothing', above.unitPrice === FRESH.usd * 1.03 && above.floored === false);
  for (const bad of [0, -1, NaN, null, undefined, 'x']) {
    const r = indexUnitPrice(low, { premiumPct: P, floor: bad, maxAgeS: MAXAGE });
    ok(`a floor of ${String(bad)} disables it rather than breaking pricing`,
       r.ok && r.unitPrice === free.unitPrice);
  }
}

// ── 4. allocation identical to ammWalk ─────────────────────────────────────
sect('4. the rungs an order reserves do not depend on the mode');
{
  const k = 0.03 * 100000 * 100000, v = 100000 - AVAIL;       // any curve will do
  for (const pcn of [0.00000001, 1, 4499.99999999, 4500, 4500.5, 14500, 20000, 24499.99999999]) {
    const a = ammWalk(RUNGS, { pcn }, k, v, 0);
    const f = flatWalk(RUNGS, { pcn }, U);
    const same = a && f && a.fills.length === f.fills.length &&
      a.fills.every((x, i) => x.rungNo === f.fills[i].rungNo && x.units === f.fills[i].units);
    ok(`${pcn} PCN: same rungs, same units`, same,
       JSON.stringify(f.fills.map(x => [x.rungNo, x.units])));
  }
  const byUsd = flatWalk(RUNGS, { usd: 50 }, U);
  const again = ammWalk(RUNGS, { pcn: byUsd.pcn }, k, v, 0);
  ok('an order named in dollars allocates as ammWalk does for the same coins',
     JSON.stringify(byUsd.fills.map(x => [x.rungNo, x.units])) ===
     JSON.stringify(again.fills.map(x => [x.rungNo, x.units])));
  ok('stock that is sold, reserved or retired is never allocated',
     !byUsd.fills.some(x => x.rungNo === 3) &&
     flatWalk(RUNGS, { pcn: 20000 }, U).fills.every(x => x.rungNo !== 3));
  ok('every fill is priced at the one price', flatWalk(RUNGS, { pcn: 20000 }, U).fills.every(x => x.price === U));
}

// ── 5. unknown or stale refuses ────────────────────────────────────────────
sect('5. an index nobody can vouch for REFUSES');
{
  const cases = [
    ['never read (null)',           null],
    ['never read, with a reason',   { state: null, error: 'price.pc.am could not be read' }],
    ['state unknown',               { ...FRESH, state: 'unknown', usd: null }],
    ['state disabled',              { ...FRESH, state: 'disabled', usd: null }],
    ['a state nobody defined',      { ...FRESH, state: 'guessing' }],
    ['no price (null)',             { ...FRESH, usd: null }],
    ['a price of 0',                { ...FRESH, usd: 0 }],
    ['a price of ""',               { ...FRESH, usd: '' }],
    ['a negative price',            { ...FRESH, usd: -0.02 }],
    ['no age',                      { ...FRESH, ageSeconds: null }],
    ['age undefined',               { ...FRESH, ageSeconds: undefined }],
    ['older than the limit',        { ...FRESH, ageSeconds: MAXAGE + 1 }],
    ['the relay says stale',        { ...FRESH, stale: true }],
    ['stale missing (not "false")', { ...FRESH, stale: undefined }],
  ];
  for (const [name, idx] of cases) {
    const r = indexUnitPrice(idx, { premiumPct: P, floor: FLOOR, maxAgeS: MAXAGE });
    ok(`refuses: ${name}`, r.ok === false && typeof r.why === 'string' && !('unitPrice' in r), r.why);
  }
  ok('refuses: an unusable premium',
     !indexUnitPrice(FRESH, { premiumPct: NaN, floor: FLOOR, maxAgeS: MAXAGE }).ok);
  ok('refuses: an unusable age limit',
     !indexUnitPrice(FRESH, { premiumPct: P, floor: FLOOR, maxAgeS: NaN }).ok);
  ok('exactly AT the age limit is still current',
     indexUnitPrice({ ...FRESH, ageSeconds: MAXAGE }, { premiumPct: P, floor: FLOOR, maxAgeS: MAXAGE }).ok);
  for (const s of INDEX_PRICED_STATES) {
    ok(`priced state '${s}' is usable ('held' is not stale)`,
       indexUnitPrice({ ...FRESH, state: s }, { premiumPct: P, floor: FLOOR, maxAgeS: MAXAGE }).ok);
  }
  ok('the reason names the relay\'s own error',
     /could not be read/.test(indexUnitPrice({ state: null, error: 'price.pc.am could not be read' }, {}).why));
}

// ── makeLadder over a fake pool ────────────────────────────────────────────
function fakePool(rungs, log = []) {
  const n = x => Number(x);
  const inStock = r => n(r.qty_sold) + n(r.qty_reserved) + n(r.qty_retired) < n(r.qty_total);
  const q = async (sql) => {
    const s = String(sql).replace(/\s+/g, ' ');
    log.push(s);
    if (/SUM\(qty_total\)/.test(s)) {
      const sum = k => rungs.reduce((a, r) => a + n(r[k]), 0);
      return [[{ tot: sum('qty_total'), sold: sum('qty_sold'), resv: sum('qty_reserved'), retd: sum('qty_retired') }]];
    }
    if (/MIN\(price\)/.test(s)) {
      return [[{ lo: rungs[0].price, hi: rungs[rungs.length - 1].price, n: rungs.length,
                 p1: rungs[0].price, p2: rungs[1].price }]];
    }
    if (/SELECT price FROM ladder_rungs/.test(s)) {
      const withResv = /qty_reserved/.test(s);
      const r = rungs.find(x => withResv ? inStock(x)
        : n(x.qty_sold) + n(x.qty_retired) < n(x.qty_total));
      return [[r ? { price: r.price } : undefined].filter(Boolean)];
    }
    if (/SELECT rung_no, price, qty_total/.test(s)) return [rungs.filter(inStock)];
    return [{ affectedRows: 1 }];
  };
  return { query: q, getConnection: async () => ({ query: q, beginTransaction() {}, commit() {},
                                                     rollback() {}, release() {} }) };
}
const K = 0.029 * 1e5 * 1e5, VIRT = 1e5 - AVAIL - 100;     // a configured curve, for "no fallback"
const settingsFor = (over = {}) => {
  const s = { pricingMode: 'index', marketPremiumPct: P, indexMaxAgeSeconds: MAXAGE,
              ladderMinPriceUsd: FLOOR, ammK: K, ammVirtualPcn: VIRT, ladderMaxPriceUsd: 0, ...over };
  return k => s[k];
};

sect('5b. through makeLadder: a stale index CLOSES, it never falls back to the curve');
{
  const L = makeLadder(fakePool(RUNGS), { getSetting: settingsFor(),
                                           getIndex: () => ({ ...FRESH, ageSeconds: MAXAGE + 60 }) });
  for (const [name, call] of [['walkUsd', () => L.walkUsd(RUNGS, 100)],
                              ['walkPcn', () => L.walkPcn(RUNGS, 100)]]) {
    let err = null, got = null;
    try { got = call(); } catch (e) { err = e; }
    ok(`${name} throws instead of pricing`, err && !got, got ? `priced at $${got.avgPrice}` : '');
    ok(`${name}: code 503, tagged for server.mjs`,
       err && err.code === 503 && err.indexUnavailable === true && err.pricingRefusal === true);
    ok(`${name}: the buyer is told why`, err && /cannot be confirmed/.test(err.message) &&
       /past the 900 s limit/.test(err.message), err && err.message.slice(0, 90));
  }
  const throwing = makeLadder(fakePool(RUNGS), { getSetting: settingsFor(),
                                                  getIndex: () => { throw new Error('boom'); } });
  let e2 = null; try { throwing.walkUsd(RUNGS, 100); } catch (e) { e2 = e; }
  ok('a getIndex() that throws is a refusal too, not a crash', e2 && e2.code === 503, e2 && e2.message.slice(0, 80));
  // A registered-but-missing premium must not become 0%.
  const noPrem = makeLadder(fakePool(RUNGS), { getSetting: settingsFor({ marketPremiumPct: undefined }),
                                                getIndex: () => FRESH });
  let e3 = null; try { noPrem.walkUsd(RUNGS, 100); } catch (e) { e3 = e; }
  ok('a premium setting that reads as nothing refuses, not 0%', e3 && e3.code === 503, e3 && e3.message.slice(0, 80));

  const st = await L.ladderState();
  ok('ladderState: no price published', st.marginalPrice === null && st.nextFillPrice === null);
  ok('ladderState: and says why', typeof st.priceUnavailable === 'string' && /900 s/.test(st.priceUnavailable),
     st.priceUnavailable);
  ok('ladderState: the index block says it is not usable', st.index && st.index.usable === false);

  // reserveLadder: refuses before writing a single row.
  const log = [];
  const L2 = makeLadder(fakePool(RUNGS, log), { getSetting: settingsFor(),
                                                 getIndex: () => ({ ...FRESH, stale: true }) });
  const conn = await fakePool(RUNGS, log).getConnection();
  let e4 = null; try { await L2.reserveLadder(conn, 'ORD-STALE', 50); } catch (e) { e4 = e; }
  ok('reserveLadder refuses with 503', e4 && e4.code === 503);
  ok('...and wrote nothing', !log.some(s => /INSERT INTO ladder_fills|UPDATE ladder_rungs/.test(s)));
}

sect('5c. through makeLadder: a usable index prices flat');
{
  const L = makeLadder(fakePool(RUNGS), { getSetting: settingsFor(), getIndex: () => FRESH });
  const w = L.walkUsd(RUNGS, 100);
  ok('walkUsd is the flat walk at index x 1.03', w.avgPrice === U && w.pcn === flatWalk(RUNGS, { usd: 100 }, U).pcn);
  ok('walkPcn likewise', L.walkPcn(RUNGS, 100).cost === 100 * U);
  const st = await L.ladderState();
  ok('ladderState: marginalPrice = nextFillPrice = the unit price',
     st.marginalPrice === U && st.nextFillPrice === U, `$${st.marginalPrice} / $${st.nextFillPrice}`);
  ok('ladderState: pricingMode and premium are published', st.pricingMode === 'index' && st.premiumPct === P);
  ok('ladderState: the index it priced with is published',
     st.index && st.index.usd === FRESH.usd && st.index.seq === FRESH.seq && st.index.usable === true);
  ok('ladderState: priceUnavailable is null', st.priceUnavailable === null);
}

// ── 6. partial fill ────────────────────────────────────────────────────────
sect('6. the inventory runs out mid-order');
{
  const bigUsd = (AVAIL + 500) * U;
  const w = flatWalk(RUNGS, { usd: bigUsd }, U);
  ok('fills exactly what there is', w.pcn === AVAIL, `${w.pcn} of ${AVAIL}`);
  ok('charges only for what it got', w.cost === AVAIL * U);
  ok('reports the dollars it could not fill', Math.abs(w.usdUnfilled - 500 * U) < 1e-9, `$${w.usdUnfilled}`);
  ok('and that the stock is exhausted: no next price', w.exhausted === true && w.marginalAfter === null);
  const p = flatWalk(RUNGS, { pcn: AVAIL + 123 }, U);
  ok('named in coins: reports the coins it could not fill', Math.abs(p.pcnUnfilled - 123) < 1e-9, `${p.pcnUnfilled}`);
  ok('...and charges for the rest only', p.cost === AVAIL * U);
  const none = flatWalk([rung(1, 10, 10)], { usd: 20 }, U);
  ok('sold out: nothing filled, all of it unfilled', none.pcn === 0 && none.usdUnfilled === 20 && none.exhausted);
  const dust = flatWalk(RUNGS, { usd: 1e-12 }, U);
  ok('money that buys no whole satoshi is unfilled, not a $0 sale', dust.pcn === 0 && dust.usdUnfilled === 1e-12);

  // reserveLadder refuses a partial, in the buyer's words for this mode.
  const L = makeLadder(fakePool(RUNGS), { getSetting: settingsFor(), getIndex: () => FRESH });
  const conn = await fakePool(RUNGS).getConnection();
  let e = null; try { await L.reserveLadder(conn, 'ORD-BIG', bigUsd); } catch (x) { e = x; }
  ok('reserveLadder refuses the partial with 409', e && e.code === 409);
  ok('...saying what is left, without "rungs"', e && /left for sale here/.test(e.message) && !/rung/.test(e.message),
     e && e.message);
}

sect('   invalid input is refused, never priced');
{
  for (const u of [0, -1, NaN, Infinity, null]) ok(`unit price ${u} -> null`, flatWalk(RUNGS, { usd: 10 }, u) === null);
  for (const usd of [0, -5, NaN, Infinity]) ok(`usd ${usd} -> null`, flatWalk(RUNGS, { usd }, U) === null);
  for (const pcn of [0, -5, NaN]) ok(`pcn ${pcn} -> null`, flatWalk(RUNGS, { pcn }, U) === null);
}

// ── 7. curve mode untouched ────────────────────────────────────────────────
sect('7. curve mode prices exactly as before');
{
  const idxs = [() => FRESH, () => null, () => { throw new Error('x'); }];
  for (const [label, s] of [['pricingMode curve', settingsFor({ pricingMode: 'curve' })],
                            ['pricingMode unset', settingsFor({ pricingMode: undefined })],
                            ['pricingMode ""',    settingsFor({ pricingMode: '' })]]) {
    for (const gi of idxs) {
      const L = makeLadder(fakePool(RUNGS), { getSetting: s, getIndex: gi });
      const a = JSON.stringify(L.walkUsd(RUNGS, 100));
      const b = JSON.stringify(ammWalk(RUNGS, { usd: 100 }, K, VIRT, FLOOR));
      const c = JSON.stringify(L.walkPcn(RUNGS, 500));
      const d = JSON.stringify(ammWalk(RUNGS, { pcn: 500 }, K, VIRT, FLOOR));
      ok(`${label}, getIndex ${gi === idxs[0] ? 'fresh' : gi === idxs[1] ? 'null' : 'throws'}: identical to ammWalk`,
         a === b && c === d);
    }
  }
  const L = makeLadder(fakePool(RUNGS), { getSetting: settingsFor({ pricingMode: 'curve' }), getIndex: () => null });
  const st = await L.ladderState();
  const sum = k => RUNGS.reduce((a, r) => a + r[k], 0);
  const tot = sum('qty_total'), sold = sum('qty_sold'), retd = sum('qty_retired');
  const X = (tot - sold - retd) + VIRT;
  ok('ladderState marginalPrice is still max(k/X^2, floor)', st.marginalPrice === Math.max((K / X) / X, FLOOR),
     `$${st.marginalPrice}`);
  ok('...and says it is on the curve, with no price outage', st.pricingMode === 'curve' && st.priceUnavailable === null);
  const bare = makeLadder(fakePool(RUNGS));               // the test harnesses' shape
  ok('a ladder built with no settings at all is on the curve', (await bare.ladderState()).pricingMode === 'curve');
}

console.log('');
if (failed) { console.log(`  ${failed} FAILED, ${passed} passed`); process.exit(1); }
console.log(`  all ${passed} cases passed`);
