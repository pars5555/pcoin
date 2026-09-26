// The "10% back" line may only appear while the rebate would actually pay -- and must say the real
// numbers. It is advertising a money promise, so every "off" shape is tested to stay silent.

import test from 'node:test';
import assert from 'node:assert/strict';

import { rebatePromo } from '../lib/promo.mjs';
import { t, LANG_CODES } from '../lib/i18n.mjs';

const ON = { ppm: 100000n, capSat: 5000000000n, from: 1789000000n };
const NOW = 1790000000;

test('live rebate: 10% back, up to 50 PCN a month', () => {
  assert.deepEqual(rebatePromo(ON, NOW), { key: 'promo.rebate', vars: { percent: '10', cap: '50' } });
});

test('a fractional percent and cap are written exactly', () => {
  const r = rebatePromo({ ppm: 125000n, capSat: 1250000000n, from: 1n }, NOW);
  assert.equal(r.vars.percent, '12.5');
  assert.equal(r.vars.cap, '12.5');
  assert.equal(rebatePromo({ ppm: 5000n, capSat: 1n, from: 1n }, NOW).vars.percent, '0.5');
  assert.equal(rebatePromo({ ppm: 5000n, capSat: 1n, from: 1n }, NOW).vars.cap, '0.00000001');
});

test('off, not started, or a zero cap: say nothing', () => {
  assert.equal(rebatePromo({ ...ON, ppm: 0n }, NOW), null, 'ppm 0 is off');
  assert.equal(rebatePromo({ ...ON, from: 0n }, NOW), null, 'from 0 means never');
  assert.equal(rebatePromo({ ...ON, from: BigInt(NOW + 1) }, NOW), null, 'before the start date');
  assert.equal(rebatePromo({ ...ON, capSat: 0n }, NOW), null, 'rebateFor pays nobody at a zero cap');
  assert.equal(rebatePromo(null, NOW), null);
  assert.equal(rebatePromo({ ppm: 100000, capSat: 5000000000, from: 1 }, NOW), null, 'numbers, not bigints: refuse rather than guess');
});

test('the start second itself counts', () => {
  assert.ok(rebatePromo({ ...ON, from: BigInt(NOW) }, NOW));
});

test('every language renders the line with the numbers filled in', () => {
  const { key, vars } = rebatePromo(ON, NOW);
  for (const L of LANG_CODES) {
    const s = t(L, key, vars);
    assert.notEqual(s, key, `${L}: the key is missing`);
    assert.ok(!/\{\w+\}/.test(s), `${L}: a placeholder was left unfilled: ${s}`);
    assert.ok(s.includes('10') && s.includes('50') && s.includes('PCN'), `${L}: ${s}`);
  }
});
