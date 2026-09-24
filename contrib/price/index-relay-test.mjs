// node contrib/price/index-relay-test.mjs -- pure, touches nothing.
// Every refusal in index-relay.mjs is proved to FIRE here, and every healthy
// reading is proved to pass: a guard only ever seen passing is untested.
import assert from 'node:assert/strict';
import { INDEX_RULES, validateIndexBody, confirmTwice, speedCheck, remember } from './index-relay.mjs';

const NOW = 1790250000;
const body = (o = {}) => ({
  enabled: true, usd: '0.027335212', nano: '27335212', state: 'held', seq: 0,
  computedAt: NOW - 5, lastMoveAt: null,
  window: { hours: 168, trades: 3, entities: 4, countedPcn: '420.00000000', countedUsd: '10.044090', qualifies: false },
  limitedBy: [], reasons: ['too little evidence'], ...o,
});
const priced = (nano, seq, extra = {}) =>
  validateIndexBody(body({ nano: String(nano), usd: (nano / 1e9).toFixed(9), seq, ...extra }), { nowS: NOW }).reading;
let n = 0;
const check = (name, fn) => { fn(); n += 1; console.log('  ok  ', name); };

check('a healthy held reading is accepted with its numbers', () => {
  const v = validateIndexBody(body(), { nowS: NOW });
  assert.equal(v.ok, true);
  assert.equal(v.reading.nano, 27335212); assert.equal(v.reading.seq, 0); assert.equal(v.reading.state, 'held');
  assert.equal(v.reading.window.trades, 3);
});

check('live and frozen are priced states too', () => {
  for (const state of ['live', 'frozen']) assert.equal(validateIndexBody(body({ state }), { nowS: NOW }).reading.state, state);
});

check('unknown is a valid reading WITHOUT a price, never with the last one', () => {
  const v = validateIndexBody(body({ state: 'unknown', usd: null, nano: null, seq: null }), { nowS: NOW });
  assert.equal(v.ok, true); assert.equal(v.reading.nano, null); assert.equal(v.reading.usd, null);
});

check('disabled on the exchange is a fact, not a fault', () => {
  const v = validateIndexBody({ enabled: false, state: 'disabled', usd: null, nano: null }, { nowS: NOW });
  assert.equal(v.ok, true); assert.equal(v.reading.state, 'disabled'); assert.equal(v.reading.nano, null);
});

check('a stale body is refused, measured on OUR clock not the exchange\'s ageSeconds', () => {
  const v = validateIndexBody(body({ computedAt: NOW - 121, ageSeconds: 1 }), { nowS: NOW });
  assert.equal(v.ok, false); assert.equal(v.kind, 'stale');
  assert.equal(validateIndexBody(body({ computedAt: NOW - 120 }), { nowS: NOW }).ok, true, 'exactly 120 s is still fresh');
});

check('the clock-skew window: 30 s in the future is tolerated, 31 s is not', () => {
  assert.equal(validateIndexBody(body({ computedAt: NOW + 30 }), { nowS: NOW }).ok, true);
  const v = validateIndexBody(body({ computedAt: NOW + 31 }), { nowS: NOW });
  assert.equal(v.ok, false); assert.match(v.why, /in the future/);
});

check('floor and ceiling are refused outright', () => {
  assert.match(validateIndexBody(body({ nano: '14999999', usd: '0.014999999' }), { nowS: NOW }).why, /below the \$0.015 floor/);
  assert.equal(validateIndexBody(body({ nano: '15000000', usd: '0.015000000' }), { nowS: NOW }).ok, true);
  assert.match(validateIndexBody(body({ nano: '100000001', usd: '0.100000001' }), { nowS: NOW }).why, /above the \$0.1 ceiling/);
});

check('malformed bodies are invalid, never a number', () => {
  for (const [o, re] of [
    [null, /not a JSON object/], [[], /not a JSON object/], [{ state: 'held' }, /"enabled" is missing/],
    [body({ state: 'rising' }), /unrecognised state/], [body({ computedAt: 'soon' }), /computedAt/],
    [body({ nano: '-5' }), /nano/], [body({ nano: 27335212 }), /nano/], [body({ usd: '0.03' }), /does not match/],
    [body({ seq: -1 }), /seq/], [body({ seq: 1.5 }), /seq/],
  ]) {
    const v = validateIndexBody(o, { nowS: NOW });
    assert.equal(v.ok, false, JSON.stringify(o)); assert.match(v.why, re);
  }
});

check('a transient seen only once is never confirmed; two agreeing polls are', () => {
  const a = priced(27335212, 0), b = priced(26788508, 1);
  let g = confirmTwice(null, a); assert.equal(g.confirmed, false);
  g = confirmTwice(g.pending, b); assert.equal(g.confirmed, false, 'a different reading resets the count');
  g = confirmTwice(g.pending, a); assert.equal(g.confirmed, false, 'the blip in the middle bought nothing');
  g = confirmTwice(g.pending, a); assert.equal(g.confirmed, true);
});

check('the first reading ever is accepted: it is the seed', () => {
  assert.equal(speedCheck({ prev: null, reading: priced(27335212, 0), nowS: NOW }).ok, true);
});

check('seq going backwards is refused', () => {
  const v = speedCheck({ prev: { nano: 27335212, seq: 5 }, reading: priced(27335212, 4), nowS: NOW });
  assert.equal(v.ok, false); assert.match(v.why, /backwards/);
});

check('a price change without a new seq is refused', () => {
  const v = speedCheck({ prev: { nano: 27335212, seq: 5 }, reading: priced(27300000, 5), nowS: NOW });
  assert.equal(v.ok, false); assert.match(v.why, /without a new seq/);
});

check('one step may move 2.5%, not 2.6%, in either direction', () => {
  const prev = { nano: 27000000, seq: 3 };
  assert.equal(speedCheck({ prev, reading: priced(27675000, 4), nowS: NOW }).ok, true, '+2.5%');
  assert.equal(speedCheck({ prev, reading: priced(26325000, 4), nowS: NOW }).ok, true, '-2.5%');
  assert.match(speedCheck({ prev, reading: priced(27702000, 4), nowS: NOW }).why, /a step/);
  assert.match(speedCheck({ prev, reading: priced(26298000, 4), nowS: NOW }).why, /a step/);
});

check('two fills inside one poll (seq +2) may move two steps\' worth', () => {
  const prev = { nano: 27000000, seq: 3 };
  assert.equal(speedCheck({ prev, reading: priced(Math.round(27000000 * 0.98 * 0.98), 5), nowS: NOW }).ok, true);
});

check('the 24 h check: more than 5.5% from the day\'s extremes is refused even in small steps', () => {
  const t = NOW - 3600;
  const history = [{ t: t - 7200, nano: 28000000 }, { t: t - 3600, nano: 27440000 }, { t, nano: 26891200 }];
  const prev = { nano: 26891200, seq: 3 };
  const ok = speedCheck({ prev, history, reading: priced(26500000, 4), nowS: NOW });
  assert.equal(ok.ok, true, '5.36% below the high');
  const no = speedCheck({ prev, history, reading: priced(26400000, 4), nowS: NOW });
  assert.equal(no.ok, false); assert.match(no.why, /below the 24 h high/);
  const up = speedCheck({ prev: { nano: 25000000, seq: 1 }, history: [{ t, nano: 25000000 }], reading: priced(26400000, 4), nowS: NOW });
  assert.equal(up.ok, false); assert.match(up.why, /above the 24 h low/);
});

check('history older than 24 h no longer binds', () => {
  const history = [{ t: NOW - 90000, nano: 30000000 }];
  assert.equal(speedCheck({ prev: { nano: 27000000, seq: 3 }, history, reading: priced(26500000, 4), nowS: NOW }).ok, true);
});

check('a deliberate re-seed jump is refused by the check (the operator accepts it by hand)', () => {
  const v = speedCheck({ prev: { nano: 27335212, seq: 9 }, reading: priced(22000000, 10), nowS: NOW });
  assert.equal(v.ok, false);
});

check('unknown and disabled readings skip the price checks', () => {
  const u = validateIndexBody(body({ state: 'unknown', nano: null, usd: null, seq: null }), { nowS: NOW }).reading;
  assert.equal(speedCheck({ prev: { nano: 27335212, seq: 9 }, reading: u, nowS: NOW }).ok, true);
});

check('remember keeps every change, one point per 10 min otherwise, and 25 h at most', () => {
  let h = [];
  h = remember(h, { t: NOW, nano: 1 });
  h = remember(h, { t: NOW + 60, nano: 1 });
  assert.equal(h.length, 1, 'an unchanged value inside 10 min is not stored again');
  h = remember(h, { t: NOW + 120, nano: 2 });
  assert.equal(h.length, 2, 'a change is always stored');
  h = remember(h, { t: NOW + 719, nano: 2 });
  assert.equal(h.length, 2, '599 s after the last point: not yet');
  h = remember(h, { t: NOW + 720, nano: 2 });
  assert.equal(h.length, 3, '600 s after the last point: stored');
  h = remember(h, { t: NOW + 26 * 3600, nano: 3 });
  assert.deepEqual(h.map((x) => x.nano), [3], 'points older than 25 h are dropped');
});

assert.equal(INDEX_RULES.floorUsd, 0.015);
console.log(`ALL ${n} CHECKS PASSED`);
