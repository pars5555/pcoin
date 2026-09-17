// readRate's FAILURE branches.
//
// `validateRateBody` was well covered and `readRate` was not covered at all,
// which is how `fromCache(db, ...)` -- a name that does not exist in that
// function -- shipped on the unreachable path and sat there. The oracle is
// usually up, so the branch almost never ran; when it did, on 2026-09-16, it
// threw a ReferenceError that propagated out of the watcher tick and killed it.
//
// The rule these tests encode: an oracle that DID NOT ANSWER may fall back to a
// recent cache, and an oracle that ANSWERED SOMETHING INSANE may not -- the
// cache was filled by that same oracle. Neither may ever throw.

import test from 'node:test';
import assert from 'node:assert/strict';

import { readRate, RateInsane } from '../lib/rate.mjs';
import { nowSec } from '../lib/time.mjs';

// The config surface readRate actually uses.
const cfg = {
  strOr: (_k, d) => d,
  num: (_k, d) => d,
};

function store(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    map: m,
    getJson: (k) => (m.has(k) ? m.get(k) : null),
    setJson: (k, v) => m.set(k, v),
  };
}

const CACHE_KEY = 'rate:cache';
const freshCache = (ageS = 60) => ({
  rate: 0.0359,
  rateText: '0.03590242147375549',
  rateE12: '35902421473',
  at: nowSec() - ageS,
});

// A body the validator accepts, so the success path is a control.
//
// Built as TEXT with the rate as a bare JSON number, because that is what the
// oracle sends and what `rawNumber` reads. Going through JSON.stringify would
// quote it into a string and miss the whole point: the rate is taken from the
// literal so no double ever touches it.
function goodBody(rate = '0.03590242147375549') {
  return `{"serviceRate":${rate},"stale":false,"stateAgeSeconds":10,`
    + `"ladder":{"stale":false,"ageSeconds":10},"rateFollowsPoolDown":false,`
    + `"role":"primary","at":"${new Date().toISOString()}"}`;
}

const okFetch = async () => ({ ok: true, status: 200, text: async () => goodBody() });

test('a reachable, sane oracle is used', async () => {
  const s = store();
  const r = await readRate(s, cfg, { fetchImpl: okFetch });
  assert.equal(r.usable, true);
  assert.equal(r.rateText, '0.03590242147375549');
  // ...and it fills the cache the outage path depends on.
  assert.ok(s.getJson(CACHE_KEY), 'a good reading is cached');
});

// ---------------------------------------------------------------------------
// THE BRANCH THIS FILE EXISTS FOR.
// ---------------------------------------------------------------------------
test('an UNREACHABLE oracle falls back to a recent cache instead of throwing', async () => {
  const s = store({ [CACHE_KEY]: freshCache(60) });
  const dead = async () => { throw new Error('ECONNREFUSED'); };

  // Before the fix this threw ReferenceError: db is not defined.
  const r = await readRate(s, cfg, { fetchImpl: dead });
  assert.equal(r.usable, true, 'a recent cache stands in when nobody answered');
  assert.equal(r.source, 'cache');
  assert.match(r.reason ?? '', /unreachable/);
});

test('an oracle that answers a bad STATUS is unreachable, not insane', async () => {
  const s = store({ [CACHE_KEY]: freshCache(60) });
  const http503 = async () => ({ ok: false, status: 503, text: async () => 'upstream down' });
  const r = await readRate(s, cfg, { fetchImpl: http503 });
  assert.equal(r.usable, true, 'a 503 is not an answer about the price');
  assert.equal(r.source, 'cache');
});

test('an UNREACHABLE oracle with NO cache resolves nothing -- it does not invent a rate', async () => {
  const s = store();
  const dead = async () => { throw new Error('ECONNREFUSED'); };
  const r = await readRate(s, cfg, { fetchImpl: dead });
  assert.equal(r.usable, false);
  assert.equal(r.source, null);
  // The one thing that must never happen: a number.
  assert.ok(!('rate' in r) || r.rate === undefined || r.rate === null,
    'unknown must not collapse into a rate of zero or anything else');
});

test('a STALE cache is refused rather than stretched', async () => {
  // Older than the 6h ceiling.
  const s = store({ [CACHE_KEY]: freshCache(21600 + 60) });
  const dead = async () => { throw new Error('ECONNREFUSED'); };
  const r = await readRate(s, cfg, { fetchImpl: dead });
  assert.equal(r.usable, false, 'past the ceiling the cache stops being evidence');
});

// ---------------------------------------------------------------------------
// The asymmetry: ANSWERED-AND-INSANE must NOT reach for the cache.
// ---------------------------------------------------------------------------
test('an INSANE answer refuses WITHOUT falling back to cache', async () => {
  const s = store({ [CACHE_KEY]: freshCache(60) });
  const insane = async () => ({
    ok: true, status: 200,
    // A perfectly well-formed body whose own `stale` flag says do not trust it.
    text: async () => '{"serviceRate":0.03590242147375549,"stale":true,'
      + '"stateAgeSeconds":10,"ladder":{"stale":false,"ageSeconds":10}}',
  });
  const r = await readRate(s, cfg, { fetchImpl: insane });
  assert.equal(r.usable, false, 'refused');
  assert.equal(r.source, null,
    'the cache was filled by this same oracle, so it is not independent evidence');
  assert.ok(r.reason, 'the refusal says why');
});

test('an UNDECODABLE body is treated as unreachable', async () => {
  const s = store({ [CACHE_KEY]: freshCache(60) });
  const garbage = async () => ({ ok: true, status: 200, text: async () => '<html>502</html>' });
  const r = await readRate(s, cfg, { fetchImpl: garbage });
  assert.equal(r.usable, true);
  assert.equal(r.source, 'cache');
  assert.match(r.reason ?? '', /undecodable/);
});

// ---------------------------------------------------------------------------
// The property that actually protects the watcher: readRate NEVER throws.
// The crash was fatal because the tick had no guard of its own.
// ---------------------------------------------------------------------------
test('readRate never throws, whatever the oracle does', async () => {
  const hostile = [
    async () => { throw new Error('ECONNREFUSED'); },
    async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); },
    async () => ({ ok: false, status: 500, text: async () => { throw new Error('body died'); } }),
    async () => ({ ok: true, status: 200, text: async () => '' }),
    async () => ({ ok: true, status: 200, text: async () => 'null' }),
    async () => ({ ok: true, status: 200, text: async () => '{}' }),
  ];
  for (const f of hostile) {
    const s = store({ [CACHE_KEY]: freshCache(60) });
    const r = await readRate(s, cfg, { fetchImpl: f });
    assert.equal(typeof r, 'object', 'a result, never an exception');
    assert.ok('usable' in r, 'and it always says whether it is usable');
  }
});
