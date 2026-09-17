// WHICH field the money is credited from.
//
// price.pc.am publishes `serviceRate` AND `creditRateUsd`, and nominates one of
// them in `rateFieldToUse` -- which says "creditRateUsd". This rail read
// `serviceRate` until 2026-09-17. The two have been identical every time they
// were compared, so nobody was ever over- or under-credited; but they are two
// separate fields and only one is nominated, and "identical today" is not a
// property anybody guaranteed.
//
// So: credit from creditRateUsd, keep reading serviceRate, and make a
// disagreement LOUD rather than something discovered in a customer's balance.

import test from 'node:test';
import assert from 'node:assert/strict';

import { validateRateBody, RateInsane } from '../lib/rate.mjs';

const BOUNDS = { maxStateAgeS: 900, maxLadderAgeS: 900, maxPoolAgeS: 900, maxJumpFactor: 10 };

// Built as TEXT with bare JSON numbers, because the rate is read from the
// literal -- a float never touches the money path.
function body({ credit = '0.03764263862520874', service = '0.03764263862520874', nominate = 'creditRateUsd' } = {}) {
  const parts = [];
  if (credit !== null) parts.push(`"creditRateUsd":${credit}`);
  if (service !== null) parts.push(`"serviceRate":${service}`);
  if (nominate !== null) parts.push(`"rateFieldToUse":"${nominate}"`);
  parts.push('"stale":false', '"stateAgeSeconds":10');
  parts.push('"ladder":{"stale":false,"ageSeconds":10}', '"rateFollowsPoolDown":false');
  return `{${parts.join(',')}}`;
}

test('the credit rate comes from creditRateUsd', () => {
  const r = validateRateBody(body(), BOUNDS, null);
  assert.equal(r.fieldUsed, 'creditRateUsd');
  assert.equal(r.rateText, '0.03764263862520874');
});

test('the live 2026-09-17 body: both fields agree, nothing is flagged', () => {
  const r = validateRateBody(body(), BOUNDS, null);
  assert.equal(r.diverged, false, 'they are identical today, and that is the normal case');
  assert.equal(r.fieldNamed, 'creditRateUsd');
  assert.equal(r.fieldNamed, r.fieldUsed, 'we credit from the field the oracle nominates');
});

// ---------------------------------------------------------------------------
// THE CASE THIS EXISTS FOR.
// ---------------------------------------------------------------------------
test('when the two fields DISAGREE, creditRateUsd wins and it is reported', () => {
  const r = validateRateBody(body({ credit: '0.02', service: '0.05' }), BOUNDS, null);
  assert.equal(r.rateText, '0.02', 'the nominated field decides the money');
  assert.equal(r.diverged, true, 'and the disagreement is carried out, not swallowed');
  assert.equal(r.creditRateText, '0.02');
  assert.equal(r.serviceRateText, '0.05');
});

test('a disagreement is NOT a refusal', () => {
  // Refusing would stop the rail crediting anybody over a field mismatch that
  // has a clear, documented answer. Report it and keep working.
  const r = validateRateBody(body({ credit: '0.02', service: '0.05' }), BOUNDS, null);
  assert.ok(r.rate > 0, 'still a usable reading');
});

test('creditRateUsd absent falls back to serviceRate rather than refusing', () => {
  const r = validateRateBody(body({ credit: null }), BOUNDS, null);
  assert.equal(r.fieldUsed, 'serviceRate');
  assert.equal(r.rateText, '0.03764263862520874');
  assert.equal(r.diverged, false, 'nothing to disagree with');
});

test('the oracle nominating a field we do not use is surfaced', () => {
  const r = validateRateBody(body({ nominate: 'somethingElse' }), BOUNDS, null);
  assert.equal(r.fieldNamed, 'somethingElse');
  assert.notEqual(r.fieldNamed, r.fieldUsed, 'the caller alerts on this');
});

test('neither field present is refused, not read as zero', () => {
  assert.throws(
    () => validateRateBody(body({ credit: null, service: null }), BOUNDS, null),
    RateInsane,
  );
});

test('the band and sign checks still apply to whichever field is used', () => {
  assert.throws(() => validateRateBody(body({ credit: '0' }), BOUNDS, null), /not positive/);
  assert.throws(() => validateRateBody(body({ credit: '5.0' }), BOUNDS, null), /outside band/);
  // And they name the field they actually judged, so the log is not misleading.
  assert.throws(() => validateRateBody(body({ credit: null, service: '0' }), BOUNDS, null), /serviceRate is not positive/);
});

test('the rate is still taken from the TEXT, so no float touches it', () => {
  // 0.03590242147375549 floors to ...473; a double round-trip gives ...474.
  const r = validateRateBody(body({ credit: '0.03590242147375549', service: '0.03590242147375549' }), BOUNDS, null);
  assert.equal(r.rateText, '0.03590242147375549');
  assert.equal(r.rateE12, 35902421473n, 'floor, not round');
});

test('the jump guard judges the field actually in use', () => {
  const last = { rate: 0.0376, rateText: '0.0376' };
  assert.throws(
    () => validateRateBody(body({ credit: '0.9', service: '0.9' }), BOUNDS, last),
    /creditRateUsd moved/,
  );
});
