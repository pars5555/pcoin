#!/usr/bin/env node
// Maintain the ladder's ask cap (`ladderMaxPriceUsd`) against the wPCN pool.
//
//   node cap-policy.mjs                          propose only -- writes nothing
//   node cap-policy.mjs --apply                  write it, then PROVE it took effect
//   node cap-policy.mjs --apply --force-drop     allow a drop past the per-run limit
//
// --- why this exists -------------------------------------------------------
// The owner's rule is "PCN sits 5% above wPCN". The cap was maintained by hand
// every six hours, and the hand kept HOLDING it -- four times -- because
// lowering a price to follow a $1,300 pool is the exact move an attacker wants.
//
// Holding has its own cost, and it is not obvious. The sale gate in server.mjs
// measures divergence as (ladderPrice - serviceRate) / serviceRate, and
// serviceRate follows the pool DOWN. So the premium is not a 5% budget:
//
//     divergence = 1.05 x (pool_when_capped / pool_now) - 1
//
// It is 5% PLUS every point the pool has fallen since the cap was last touched.
// On 2026-09-12 the cap stood at $0.0359101 (set against a pool of $0.0341999),
// the pool had fallen to $0.03088625, and divergence was 16.27% against a
// maxDivergencePct of 20. Four holds had spent 11 of the 20 points, and at 20
// the market closes to EVERYBODY -- the honest buyers included.
//
// --- the rule --------------------------------------------------------------
//     target  = median(pool over 24h) x (1 + PREMIUM_PCT)
//     ceiling = worst public serviceRate x (1 + MAX_DIVERGENCE_PCT)
//     cap     = max(min(target, ceiling), ladderMinPriceUsd)
//
// The MEDIAN is the anti-manipulation half. A flash dump is a handful of samples
// against 1,440 and barely moves a 24h median; to drag the cap down an attacker
// must hold the pool depressed for more than twelve hours, in the open, where it
// is visible and where this tool's own output records it. That converts a
// one-shot reversible trade into a sustained, observable campaign.
//
// The CEILING is the keep-the-market-open half. It binds only when the pool has
// fallen so far that the 24h median still sits above what the gate tolerates.
//
// --- the asymmetry that makes this safe to automate ------------------------
// RAISING the cap is unconditionally safe: it makes PCN dearer, which no dumper
// benefits from. LOWERING it is the entire attack surface. So only drops are
// rate-limited and only drops need a human. Rises apply freely.
//
// --- every refusal leaves the cap ALONE ------------------------------------
// This tool fails closed in the literal sense: when it cannot answer it changes
// nothing and says why. An unreadable oracle is not a pool price of zero, and a
// short sample window is not a stable market. That is the CLAUDE.md 7.1 rule
// applied to the one number deciding what the whole remaining book sells for.
import { readFileSync, writeFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import { makeSettings } from '/opt/pcoin-market/settings.mjs';

const PREMIUM_PCT        = 5;      // owner's rule: PCN sits this far above wPCN
const MAX_DIVERGENCE_PCT = 10;     // ceiling. The sale gate closes at 20.
const WINDOW_H           = 24;     // the median window
const MIN_SAMPLES        = 1000;   // of a possible ~1440. Below this: refuse.
const MAX_DROP_PCT       = 8;      // a bigger fall IN ONE RUN needs --force-drop
const MAX_DROP_24H_PCT   = 12;     // ...and this much in a DAY, however many runs it takes
const RATE_SAMPLES       = 3;      // judge the ceiling on the WORST public rate
const PUBLIC_RATE_URL    = 'https://price.pc.am/price';
const STATE              = '/opt/pcoin-price/state.json';
const HISTORY            = '/opt/pcoin-market/cap-history.json';
const GATE_PCT           = 20;     // maxDivergencePct -- what closes the market

const apply     = process.argv.includes('--apply');
const forceDrop = process.argv.includes('--force-drop');
const f = (x, n = 8) => Number(x).toFixed(n);

let pool = null;
async function refuse(why) {
  console.log('\n  REFUSED: ' + why);
  console.log('  The cap is unchanged.');
  if (pool) await pool.end();
  process.exit(2);
}

// --- 1. the median, from the oracle's own sample history --------------------
// Only the price PRIMARY holds poolSamples; the replicas carry no history and
// must never recompute one. This tool therefore runs on the primary, by design.
let st;
try { st = JSON.parse(readFileSync(STATE, 'utf8')); }
catch (e) { await refuse('cannot read the oracle state at ' + STATE + ' (' + e.message + ')'); }

const samples = (st.poolSamples || [])
  .filter(s => Number.isFinite(s && s.p) && s.p > 0 && Number.isFinite(s && s.t));
if (!samples.length) await refuse('the oracle holds no usable pool samples');

const now = Math.max(...samples.map(s => s.t));
const win = samples.filter(s => s.t >= now - WINDOW_H * 3600e3).map(s => s.p).sort((a, b) => a - b);
if (win.length < MIN_SAMPLES) {
  await refuse('only ' + win.length + ' pool samples in the last ' + WINDOW_H + 'h, need ' +
    MIN_SAMPLES + '. A short window is not a stable market -- it is an unknown one.');
}
const median = win.length % 2
  ? win[(win.length - 1) / 2]
  : (win[win.length / 2 - 1] + win[win.length / 2]) / 2;

// --- 2. the ceiling, from the rate the PRODUCTS actually read ---------------
// Deliberately the PUBLIC url, not this box's loopback oracle: price.pc.am is
// answered by three origins and they have disagreed before, so a customer's rail
// credits at whichever one it reached. Judge on the worst, exactly as the sale
// gate does -- "some origin still disagrees" is the condition we must not sell
// into, and equally the one we must not size a ceiling against.
const got = await Promise.allSettled(Array.from({ length: RATE_SAMPLES }, async () => {
  const r = await fetch(PUBLIC_RATE_URL, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return Number((await r.json()).serviceRate);
}));
const rates = got.filter(r => r.status === 'fulfilled').map(r => r.value)
                 .filter(r => Number.isFinite(r) && r > 0);
if (!rates.length) {
  const why = got.find(r => r.status === 'rejected');
  await refuse('price.pc.am is unreadable (' +
    ((why && why.reason && why.reason.message) || 'no usable serviceRate') +
    '), so the divergence ceiling cannot be computed. An unreadable rate is not a rate.');
}
const rate = Math.max(...rates);   // worst = highest rate = tightest ceiling
const disagree = rates.length > 1 && Math.min(...rates) !== Math.max(...rates);

// --- 3. the decision --------------------------------------------------------
const cfg = JSON.parse(readFileSync('/opt/pcoin-market/config.json', 'utf8'));
pool = mysql.createPool({ ...cfg.db, connectionLimit: 2, decimalNumbers: false });
const S = makeSettings(pool, { warn: () => {}, error: console.error });
await S.reload();

const floor    = Number(S.get('ladderMinPriceUsd')) || 0;
const current  = Number(S.get('ladderMaxPriceUsd')) || 0;
const target   = median * (1 + PREMIUM_PCT / 100);
const ceiling  = rate   * (1 + MAX_DIVERGENCE_PCT / 100);
let   cap      = Math.min(target, ceiling);
const hitFloor = cap < floor;
cap = Math.max(cap, floor);              // askCap() in ladder.mjs clamps the same way

const divOf = p => (p - rate) / rate * 100;

console.log('\n  ladder ask cap  --  ' + new Date(now).toISOString());
console.log('  ' + '-'.repeat(68));
console.log('  pool spot              $' + f(st.poolPrice));
console.log('  pool median ' + WINDOW_H + 'h         $' + f(median) + '   (' + win.length + ' samples)');
console.log('  public serviceRate     $' + f(rate) + '   (worst of ' + rates.length +
            (disagree ? ', ORIGINS DISAGREE' : '') + ')');
console.log('  code floor             $' + f(floor));
console.log('');
console.log('  target  = median x ' + (1 + PREMIUM_PCT / 100).toFixed(2) +
            '   $' + f(target) + '   -> divergence ' + divOf(target).toFixed(2) + '%');
console.log('  ceiling = rate   x ' + (1 + MAX_DIVERGENCE_PCT / 100).toFixed(2) +
            '   $' + f(ceiling) + '   -> divergence ' + divOf(ceiling).toFixed(2) + '%');
console.log('  binding : ' + (hitFloor ? 'THE FLOOR'
            : target <= ceiling ? 'the median target' : 'the divergence ceiling'));
console.log('');
console.log('  cap now                $' + f(current) +
            (current ? '   -> divergence ' + divOf(current).toFixed(2) + '%' : '   (0 = no cap set)'));
console.log('  cap proposed           $' + f(cap) + '   -> divergence ' + divOf(cap).toFixed(2) + '%');

// How much further can the pool fall before the sale gate shuts on everybody?
// Printed every run: it is the number that says how urgent the next one is.
//
// THIS LINE PRINTED THE RECIPROCAL UNTIL 2026-09-13, AND IT ERRED TOWARDS CALM.
// It computed (1+GATE)/(1+div) - 1, which is the fall expressed as a fraction of
// the FUTURE price, and labelled it as a fall from the price now. Those differ,
// and always in the direction that makes things look less urgent: at 5.02%
// divergence it printed 14.3% when the real tolerated fall was 12.5%, and the
// gap widens as divergence grows. A number whose whole job is to say "how
// urgent is this" must not round towards comfortable.
//
// Derivation, from the relation stated at the top of this file:
//   divergence = (ladderPrice - serviceRate) / serviceRate
//   the gate closes when divergence >= GATE, i.e. serviceRate <= cap/(1+GATE)
//   so the tolerated fall from today's serviceRate is
//       1 - (cap/(1+GATE)) / serviceRate  =  1 - (1 + div) / (1 + GATE)
const slack = 1 - (1 + divOf(cap) / 100) / (1 + GATE_PCT / 100);
console.log('  headroom               the pool may fall a further ' + (slack * 100).toFixed(1) +
            '% before the ' + GATE_PCT + '% gate closes the market');
// A wPCN figure belongs here too -- a percentage is not a decision, and what
// actually closes the market is somebody SELLING. It is NOT printed because
// this file does not hold the pool reserves, and the first version of this fix
// referenced a RES_WPCN that does not exist, which would have thrown on the
// next run. Adding it means fetching getReserves here; until then, convert by
// hand: sell_wPCN = reserve_wPCN * (1/sqrt(1-slack) - 1) / 0.9975.

const movePct = current > 0 ? (cap - current) / current * 100 : Infinity;
if (current > 0) console.log('  move                   ' + (movePct >= 0 ? '+' : '') + movePct.toFixed(2) + '%');

const D = S.defs.ladderMaxPriceUsd;
if (cap < D.min || cap > D.max) {
  await refuse('computed cap $' + f(cap) + ' falls outside the setting\'s own bounds (' +
               D.min + ' .. ' + D.max + ')');
}

if (current > 0 && Math.abs(movePct) < 0.05) {
  console.log('\n  No material change. Nothing written.');
  await pool.end();
  process.exit(0);
}

// Only DROPS are gated. A rise makes PCN dearer and helps no dumper.
if (movePct < -MAX_DROP_PCT && !forceDrop) {
  await refuse('this is a ' + Math.abs(movePct).toFixed(2) + '% DROP, past the ' + MAX_DROP_PCT +
    '% per-run limit.\n' +
    '           A fall that large in one run is either a real crash or somebody pushing the pool.\n' +
    '           LOOK at the pool\'s recent trades first, then re-run with --force-drop if it is real.');
}

// ...and the same limit again over a DAY, because a per-run cap alone does not
// bound a campaign. Four runs of 7.9% each clear the check above individually
// and still take the cap down 28% in twenty-four hours without a human ever
// being asked. Somebody pushing the pool would simply push it slowly. So the
// ratchet is measured against the HIGHEST cap this tool applied in the last 24h,
// which is the number a patient attacker has to walk down.
let history = [];
try { history = JSON.parse(readFileSync(HISTORY, 'utf8')); } catch { history = []; }
history = history.filter(h => Number.isFinite(h && h.t) && Number.isFinite(h && h.cap));
const recent = history.filter(h => h.t >= Date.now() - 24 * 3600e3).map(h => h.cap);
if (recent.length) {
  const ref   = Math.max(...recent);
  const dayPct = (cap - ref) / ref * 100;
  console.log('  24h ratchet            highest cap applied in 24h $' + f(ref) +
              '   this would be ' + (dayPct >= 0 ? '+' : '') + dayPct.toFixed(2) + '%');
  if (dayPct < -MAX_DROP_24H_PCT && !forceDrop) {
    await refuse('this would put the cap ' + Math.abs(dayPct).toFixed(2) + '% below the highest ' +
      'cap applied\n           in the last 24h ($' + f(ref) + '), past the ' + MAX_DROP_24H_PCT +
      '% daily limit.\n' +
      '           A slow, sustained push on the pool looks exactly like this. It is the shape\n' +
      '           a patient attacker uses precisely because each single step looks reasonable.\n' +
      '           Decide deliberately, then --force-drop if the decline is real.');
  }
}

if (!apply) {
  console.log('\n  Proposal only -- nothing written. Re-run with --apply to set it.');
  await pool.end();
  process.exit(0);
}

await S.set('ladderMaxPriceUsd', cap);
console.log('\n  WROTE ladderMaxPriceUsd = ' + cap);

// Record it BEFORE verifying. The ratchet must count a cap that was written,
// not only one that was written and then confirmed -- otherwise a run whose
// read-back fails leaves no trace, and the next run measures its drop against a
// stale, higher reference. That is the direction that loses the protection.
try {
  history.push({ t: Date.now(), cap, forced: forceDrop });
  writeFileSync(HISTORY, JSON.stringify(
    history.filter(h => h.t >= Date.now() - 7 * 24 * 3600e3), null, 1));
} catch (e) {
  console.log('  WARNING: could not record cap history (' + e.message + '). ' +
              'The 24h ratchet is blind until this is fixed.');
}

// --- 4. prove it took effect ------------------------------------------------
// A stored value that fails `coerce` on reload is SILENTLY ignored and the
// setting reverts to its DEFAULT -- which for this one is 0, meaning NO CAP AT
// ALL. A write that looks fine and leaves the ladder uncapped is the worst
// outcome available here, so the write is not finished until the live service
// has been asked what it is actually selling at.
// Read over LOOPBACK, and here that is REQUIRED, not a preference. Since the
// public/internal split, /api/ladder/state serves anonymous callers a subset that
// does NOT include askCapUsd -- so fetching the public URL would read undefined,
// compare NaN against the cap, and report *** DOES NOT MATCH *** on a write that
// was perfectly fine. The absence of X-Forwarded-For on a loopback request is what
// marks this as one of our own processes and returns the full object.
//
// This is the OPPOSITE call from pcoin-market-watch.mjs next door, and deliberately
// so: that one asks "can a customer reach us", which only the public URL answers.
// This one asks "did my own write survive a reload", which only the local socket
// answers. Same endpoint, two different questions.
await new Promise(r => setTimeout(r, 35000));       // the server reloads every 30s
try {
  const res = await fetch('http://127.0.0.1:8789/api/ladder/state', { signal: AbortSignal.timeout(20000) });
  const live = await res.json();
  const ok = Math.abs(Number(live.askCapUsd) - cap) < 1e-9;
  console.log('  live askCapUsd         $' + f(live.askCapUsd) + '  ' + (ok ? 'MATCHES' : '*** DOES NOT MATCH ***'));
  console.log('  live marginalPrice     $' + f(live.marginalPrice) +
              '   (uncapped rung $' + f(live.rungMarginalPrice) + ')');
  await pool.end();
  process.exit(ok ? 0 : 3);
} catch (e) {
  console.log('  COULD NOT VERIFY against the live service (' + e.message + ') -- check askCapUsd by hand.');
  await pool.end();
  process.exit(4);
}
