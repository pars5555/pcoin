// price.pc.am for the admin pages, on both body shapes -- `node contrib/admin-panel/price-feed-test.mjs`.
//
// The owner, 2026-09-25: "simplify the price.pc.am json response". The root
// shrinks to nine fields and the full body moves to /detail. These pages read
// /detail and fall back to the root, and priceView() hands them one shape.
// Nothing is fetched: readPrice() is given a stand-in getter.
import assert from 'node:assert/strict';
import { readPrice, priceView, PRICE_ROOT, PRICE_DETAIL } from './price-feed.mjs';

// Verbatim, from `curl -s https://price.pc.am/` at 2026-09-25T13:39:22Z.
const TODAY = JSON.parse(`{"price":0.027550589,"serviceRate":0.026748145,"creditRateUsd":0.026748145,"sellPriceUsd":0.027550589,"rateFieldToUse":"creditRateUsd","rateFollowsPoolDown":false,"rateFloorUsd":0.015,"pool":{"spotUsd":0.027246974914188885,"medianUsd":0.026748145216180963,"windowHours":6,"samples":2000,"ageSeconds":17,"rateHeldAboveBy":null},"index":{"usd":0.026748145,"state":"held","seq":1,"ageSeconds":19,"stale":false,"lastMoveAt":null,"window":{"hours":168,"trades":4,"entities":5,"countedPcn":"757.00000000","countedUsd":"16.817790","qualifies":false},"limitedBy":[],"reasons":["too little evidence in every window; the widest (168 h) has 4 counted fills (5 needed), $16.81 counted ($25.00 needed)"],"refused":null,"inUse":true,"source":"https://exchange.pc.am/api/index"},"currency":"USD","buybackOpen":false,"buybackPrice":null,"buybackRemainingToday":0,"ladder":{"price":0.027550589,"soldPcn":38571.36624107,"remainingPcn":16387.70607446,"ageSeconds":19,"stale":false},"note":"(the note, as published)","role":"replica","stale":false,"stateAgeSeconds":0,"at":"2026-09-25T13:39:22.114Z"}`);
const MINIMAL = {
  creditRateUsd: 0.026748145, sellPriceUsd: 0.027550589, poolUsd: 0.027246974914188885,
  floorUsd: 0.015, state: 'held', seq: 1, stale: false, ageSeconds: 19, at: '2026-09-25T13:39:22.114Z',
};
let n = 0;
const check = async (name, fn) => { await fn(); n++; console.log('  ok  ' + name); };
const getter = (map) => async (url) => (url in map ? map[url] : { ok: false, error: 'HTTP 404' });

await check("today's body: every field the pages read is where it was", () => {
  const v = priceView(TODAY);
  assert.equal(v.creditRateUsd, 0.026748145);
  assert.equal(v.pool.medianUsd, 0.026748145216180963);
  assert.equal(v.index.window.trades, 4);
  assert.equal(v.index.inUse, true);
  assert.equal(v.rateFloorUsd, 0.015);
});

await check('the minimal body: the same numbers, the index built from the top level', () => {
  const v = priceView(MINIMAL);
  assert.equal(v.creditRateUsd, 0.026748145);
  assert.equal(v.sellPriceUsd, 0.027550589);
  assert.equal(v.pool.spotUsd, 0.027246974914188885);
  assert.equal(v.pool.medianUsd, undefined, 'no median in the minimal body: a dash, never a number');
  assert.equal(v.rateFloorUsd, 0.015);
  assert.deepEqual([v.index.usd, v.index.state, v.index.seq, v.index.stale, v.index.inUse], [0.026748145, 'held', 1, false, true]);
  assert.equal(v.index.window, null, 'no evidence window is unknown, not "no trades"');
});

await check('the minimal body marked stale: the index card goes stale', () => {
  const v = priceView({ ...MINIMAL, stale: true });
  assert.equal(v.index.stale, true);
  assert.equal(v.stale, true);
});

await check('the minimal body in state unknown carries no index price', () => {
  assert.equal(priceView({ ...MINIMAL, state: 'unknown' }).index.usd, null);
});

await check('the transition: the index block wins, and the unified top-level stale marks it stale', () => {
  const both = { ...JSON.parse(JSON.stringify(TODAY)), ...MINIMAL, creditRateUsd: 0.0301 };
  assert.equal(priceView(both).index.usd, 0.026748145, 'rolled back, creditRateUsd is not the index');
  assert.equal(priceView({ ...both, stale: true }).index.stale, true);
});

await check('/detail first', async () => {
  const r = await readPrice(getter({ [PRICE_DETAIL]: { ok: true, data: TODAY }, [PRICE_ROOT]: { ok: true, data: MINIMAL } }));
  assert.equal(r.from, 'detail');
  assert.equal(r.data.index.window.hours, 168);
});

await check('/detail missing (404 until price.pc.am ships it): the root, whichever shape it is', async () => {
  const a = await readPrice(getter({ [PRICE_ROOT]: { ok: true, data: TODAY } }));
  assert.equal(a.from, 'root');
  assert.equal(a.data.index.window.trades, 4);
  const b = await readPrice(getter({ [PRICE_ROOT]: { ok: true, data: MINIMAL } }));
  assert.equal(b.from, 'root');
  assert.equal(b.data.index.state, 'held');
});

await check('/detail answering something that is not an object falls back too', async () => {
  const r = await readPrice(getter({ [PRICE_DETAIL]: { ok: true, data: [1, 2] }, [PRICE_ROOT]: { ok: true, data: MINIMAL } }));
  assert.equal(r.from, 'root');
});

await check('both unreadable: a failure, never an empty body', async () => {
  const r = await readPrice(getter({}));
  assert.equal(r.ok, false);
  assert.ok(r.error);
});

console.log(`ALL ${n} CHECKS PASSED`);
