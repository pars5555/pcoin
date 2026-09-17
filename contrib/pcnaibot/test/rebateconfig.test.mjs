// The rebate's ON SWITCH must be reachable from the config file.
//
// The rebate logic itself was correct and covered by rebate.test.mjs. What
// nothing covered was whether the switch could ever be thrown in production:
// `REBATE` was built from `process.env` alone, and this bot's systemd unit
// passes NO environment variables (config is a read-only bind mount, so that
// `docker inspect` cannot print secrets). So the bounty page advertised "10%
// back", the code was right, and it paid out zero times for days.
//
// These tests are about the wiring, not the arithmetic.

import test from 'node:test';
import assert from 'node:assert/strict';

import { REBATE, configureRebate } from '../lib/deposits.mjs';

function reset() {
  return configureRebate({ ppm: '0', capSat: '5000000000', from: '0' });
}

test('with nothing configured the rebate is OFF', () => {
  reset();
  assert.equal(REBATE.ppm, 0n, 'off unless somebody turns it on');
});

test('the config file can turn it on', () => {
  reset();
  const r = configureRebate({ ppm: '100000', capSat: '5000000000', from: '1789000000' });
  assert.equal(r.ppm, 100000n, '100000 ppm is 10%');
  assert.equal(r.capSat, 5000000000n, '50 PCN a month');
  assert.equal(r.from, 1789000000n);
  // And the module-level object the credit path reads is the one that moved.
  assert.equal(REBATE.ppm, 100000n, 'creditDeposit reads REBATE, so REBATE must change');
  reset();
});

test('absent keys leave the current value alone', () => {
  reset();
  configureRebate({ ppm: '100000', from: '1789000000' });
  configureRebate({ ppm: null, capSat: undefined, from: null });
  assert.equal(REBATE.ppm, 100000n, 'a missing key is not a zero');
  reset();
});

test('an empty string is not a zero either', () => {
  // `REBATE_PPM=` in the config file reads as '', which BigInt('') would turn
  // into 0n -- silently switching the rebate off rather than leaving it.
  reset();
  configureRebate({ ppm: '100000', from: '1789000000' });
  configureRebate({ ppm: '   ', from: '' });
  assert.equal(REBATE.ppm, 100000n);
  assert.equal(REBATE.from, 1789000000n);
  reset();
});

test('values are exact integers, never floats', () => {
  reset();
  const r = configureRebate({ ppm: '100000', capSat: '5000000000', from: '1789000000' });
  for (const [k, v] of Object.entries(r)) {
    assert.equal(typeof v, 'bigint', `${k} must be a BigInt -- money never touches a float`);
  }
  reset();
});

test('BOTH the rate and the start date are required to be on', () => {
  // rebateFor() refuses when either is unset, so a half-configured switch is
  // off rather than surprising. This pins that the pair is what matters.
  reset();
  configureRebate({ ppm: '100000' });
  assert.equal(REBATE.from, 0n, 'no start date means no deposit qualifies');
  reset();
  configureRebate({ from: '1789000000' });
  assert.equal(REBATE.ppm, 0n, 'no rate means nothing is granted');
  reset();
});
