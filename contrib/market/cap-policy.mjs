#!/usr/bin/env node
// Maintain the ladder's ask cap (`ladderMaxPriceUsd`) against the wPCN pool.
//
//   node cap-policy.mjs                          propose only -- writes nothing
//   node cap-policy.mjs --apply                  write it, then PROVE it took effect
//   node cap-policy.mjs --apply --force-drop     allow a drop past the per-run limit
//
//   node cap-policy.mjs --curve                  the same decision, applied to the
//   node cap-policy.mjs --curve --apply          PRICE ITSELF (ammK) instead of the
//   node cap-policy.mjs --curve --apply --force-drop   inert cap. See below.
//
// --- --curve: why a second mode ---------------------------------------------
// `ladderMaxPriceUsd` has been INERT for pricing since 077fa32. What a customer
// is charged is the constant-product curve, price = ammK / X^2, and nothing
// maintained ammK -- so the ask could not follow the pool anywhere. Maintaining
// a cap that nothing reads is the shape of a check that only prints.
//
// On 2026-09-19 the owner asked for the other half of the trade: the keeper
// stops spending USDT defending the wPCN pool, and instead PCN follows wPCN
// down. The keeper side is `buy_floor_usd` in pcoin-wpcn-keeper. This is the
// ask side. Re-anchoring is one line of arithmetic -- ammK = price * X^2 --
// and everything around it is the part that has to be right.
//
// THREE THINGS MAKE IT SAFE TO RUN UNATTENDED, and they are the same three that
// make the cap mode safe, because it is the same attack:
//   * it only ever moves the price DOWN, never up. A pumped pool must not be
//     able to make PCN dearer; only real buying and retire-on-spend do that,
//     and both already work through X.
//   * every drop is rate-limited, per run and per day, against the tool's own
//     record -- so a patient push on the pool cannot walk the ask down quietly.
//   * `ladderMinPriceUsd` is a hard bottom, and since 2026-09-19 it is enforced
//     INSIDE ladder.mjs on the curve path as well, not only here. A floor that
//     lives only in the automation is not a floor.
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
const CURVE_HISTORY      = '/opt/pcoin-market/curve-history.json';
// Loopback, and that is REQUIRED rather than preferred: the public subset of
// /api/ladder/state omits askCapUsd and is not guaranteed to carry the curve
// fields either, so reading the public URL would compare against undefined and
// report a mismatch on a write that was perfectly fine.
const LIVE_STATE         = 'http://127.0.0.1:8789/api/ladder/state';
const ALERT_CONF         = '/etc/pcoin/alert.conf';

const apply     = process.argv.includes('--apply');
const forceDrop = process.argv.includes('--force-drop');
const curveMode = process.argv.includes('--curve');
const f = (x, n = 8) => Number(x).toFixed(n);

/** Tell the ops channel. An automated price change that nobody is told about
 *  is indistinguishable from one nobody decided, so this runs on every APPLIED
 *  move. It swallows every failure: a telegram outage must never stop, or
 *  un-do, a write that has already landed. */
async function tg(text) {
  let token = '', chat = '';
  try {
    for (const line of readFileSync(ALERT_CONF, 'utf8').split('\n')) {
      if (line.trim().startsWith('#')) continue;
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      if (m[1] === 'TELEGRAM_TOKEN') token = m[2].replace(/^["']|["']$/g, '');
      if (m[1] === 'ALERT_CHAT' && !chat) chat = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (e) {
    console.log('  (no alert.conf: ' + e.message + ') ' + text.replace(/<[^>]+>/g, ''));
    return;
  }
  if (!token || !chat) { console.log('  (no telegram configured) ' + text); return; }
  try {
    const r = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML',
                             disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) console.log('  telegram refused it: ' + r.status + ' ' + (await r.text()).slice(0, 200));
  } catch (e) { console.log('  telegram failed: ' + e.message); }
}

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

// ═══════════════════════════════════════════════════════════════════════════
//  --curve : move the PRICE, by re-anchoring ammK. See the header.
// ═══════════════════════════════════════════════════════════════════════════
if (curveMode) {
  // --- 1. what the curve is actually doing -----------------------------------
  // Read from the LIVE service rather than reconstructed here. The whole risk in
  // this mode is writing k against a model of the curve that is not the model
  // the server is using, so the model is CHECKED against the live number below
  // instead of being assumed.
  let live;
  try {
    const res = await fetch(LIVE_STATE, { signal: AbortSignal.timeout(20000) });
    live = await res.json();
  } catch (e) {
    await refuse('cannot read the live ladder state at ' + LIVE_STATE + ' (' + e.message +
      ').\n           Without it the inventory and the price in force are both UNKNOWN, ' +
      'and\n           k must never be written against a guess.');
  }

  const k    = Number(S.get('ammK'));
  const virt = Number(S.get('ammVirtualPcn'));
  const rem  = Number(live && live.ladderRemainingPcn);
  const nowP = Number(live && live.marginalPrice);
  if (!(Number.isFinite(k) && k > 0)) {
    await refuse('ammK is ' + S.get('ammK') + ', so the curve is OFF and the ladder is pricing ' +
      'by rungs.\n           Re-anchoring k would switch the curve on as a side effect of a ' +
      'price\n           adjustment, which is not this tool\'s decision to make. Use --apply ' +
      '(cap mode)\n           to maintain the rung cap instead, or turn the curve on ' +
      'deliberately.');
  }
  if (!(Number.isFinite(virt) && virt >= 0)) await refuse('ammVirtualPcn is not a usable number');
  if (!(Number.isFinite(rem) && rem > 0)) {
    await refuse('the live service reports ladderRemainingPcn = ' + live.ladderRemainingPcn +
      '.\n           No inventory means no X, and no X means no curve to re-anchor.');
  }
  if (!(Number.isFinite(nowP) && nowP > 0)) {
    await refuse('the live service reports marginalPrice = ' + live.marginalPrice +
      ', which is not a price.');
  }

  const X = rem + virt;
  const modelled = (k / X) / X;

  // --- 2. THE MODEL CHECK, and it is the load-bearing one --------------------
  // If price != k/X^2 then this tool's arithmetic is not the server's, and the
  // difference is not academic: ammParams() falls back to RUNG pricing silently
  // whenever the settings fail to coerce, so a curve that looks configured here
  // can be one the server is not using. Writing k in that state changes nothing
  // visible and hides the fact.
  //
  // The one benign mismatch is the floor: ladder.mjs publishes
  // max(k/X^2, ladderMinPriceUsd), so a curve already UNDER the floor reports
  // the floor. That is a real state with a correct answer -- there is nothing
  // left to lower -- and it is handled as such rather than as an error.
  if (Math.abs(modelled - nowP) / nowP > 1e-6) {
    if (floor > 0 && Math.abs(nowP - floor) / floor < 1e-9 && modelled <= floor) {
      console.log('\n  ladder ask CURVE  --  ' + new Date(now).toISOString());
      console.log('  ' + '-'.repeat(68));
      console.log('  the curve is already AT THE FLOOR: k/X^2 = $' + f(modelled) +
                  ', floor $' + f(floor) + ', charged $' + f(nowP) + '.');
      console.log('  Nothing to lower. The floor is doing its job and is enforced inside');
      console.log('  ladder.mjs, so this is the price in force whatever k says.');
      await pool.end();
      process.exit(0);
    }
    await refuse('MODEL MISMATCH. k/X^2 = $' + f(modelled) + ' but the live service is ' +
      'charging $' + f(nowP) + '.\n           k=' + k + ' virt=' + virt + ' rem=' + rem +
      ' X=' + X + '\n           Either the server is not using the curve at all -- ammParams() ' +
      'falls back to\n           rung pricing SILENTLY when a setting fails to coerce -- or this ' +
      'tool\'s\n           arithmetic is not the server\'s. Writing k against either would be ' +
      'a\n           change nobody could see. Check /pricing on the admin panel.');
  }

  // --- 3. the target, same rule as the cap mode ------------------------------
  const cTarget  = median * (1 + PREMIUM_PCT / 100);
  const cCeiling = rate * (1 + MAX_DIVERGENCE_PCT / 100);
  let   want     = Math.min(cTarget, cCeiling);
  const cHitFloor = want < floor;
  want = Math.max(want, floor);

  console.log('\n  ladder ask CURVE  --  ' + new Date(now).toISOString());
  console.log('  ' + '-'.repeat(68));
  console.log('  pool spot              $' + f(st.poolPrice));
  console.log('  pool median ' + WINDOW_H + 'h         $' + f(median) + '   (' + win.length + ' samples)');
  console.log('  public serviceRate     $' + f(rate) + '   (worst of ' + rates.length +
              (disagree ? ', ORIGINS DISAGREE' : '') + ')');
  console.log('  code floor             $' + f(floor) + '   (enforced in ladder.mjs too)');
  console.log('');
  console.log('  inventory X            ' + rem.toFixed(8) + ' PCN + ' + virt.toFixed(8) +
              ' virtual = ' + X.toFixed(8));
  console.log('  charged now            $' + f(nowP) + '   -> divergence ' + divOf(nowP).toFixed(2) +
              '%   (k = ' + k + ')');
  console.log('  target  = median x ' + (1 + PREMIUM_PCT / 100).toFixed(2) + '   $' + f(cTarget));
  console.log('  ceiling = rate   x ' + (1 + MAX_DIVERGENCE_PCT / 100).toFixed(2) + '   $' + f(cCeiling));
  console.log('  binding : ' + (cHitFloor ? 'THE FLOOR'
              : cTarget <= cCeiling ? 'the median target' : 'the divergence ceiling'));
  console.log('  proposed               $' + f(want) + '   -> divergence ' + divOf(want).toFixed(2) + '%');

  // --- 4. DOWN ONLY ----------------------------------------------------------
  // A pumped pool must never be able to make PCN dearer. The price rises only
  // through X -- real buying, and retire-on-spend -- both of which are demand
  // that was paid for. Raising k here would hand that lever to anyone with a
  // few hundred dollars and the thinnest pool in the estate.
  const cMovePct = (want - nowP) / nowP * 100;
  console.log('  move                   ' + (cMovePct >= 0 ? '+' : '') + cMovePct.toFixed(2) + '%');
  if (cMovePct > -0.05) {
    console.log('\n  No drop needed. This mode only ever moves the price DOWN -- the curve ' +
                'rises\n  on its own through buying and retire-on-spend, and letting a pool ' +
                'read raise\n  it would make pumping the pool profitable. Nothing written.');
    await pool.end();
    process.exit(0);
  }

  // --- 5. the same two drop gates --------------------------------------------
  if (cMovePct < -MAX_DROP_PCT && !forceDrop) {
    await refuse('this is a ' + Math.abs(cMovePct).toFixed(2) + '% DROP IN THE PRICE ITSELF, past ' +
      'the ' + MAX_DROP_PCT + '% per-run limit.\n' +
      '           LOOK at the pool\'s recent trades first, then re-run with --force-drop.');
  }
  let cHist = [];
  try { cHist = JSON.parse(readFileSync(CURVE_HISTORY, 'utf8')); } catch { cHist = []; }
  cHist = cHist.filter(h => Number.isFinite(h && h.t) && Number.isFinite(h && h.price));
  const cRecent = cHist.filter(h => h.t >= Date.now() - 24 * 3600e3).map(h => h.price);
  if (cRecent.length) {
    const cRef = Math.max(...cRecent);
    const cDay = (want - cRef) / cRef * 100;
    console.log('  24h ratchet            highest price applied in 24h $' + f(cRef) +
                '   this would be ' + (cDay >= 0 ? '+' : '') + cDay.toFixed(2) + '%');
    if (cDay < -MAX_DROP_24H_PCT && !forceDrop) {
      await refuse('this would put the price ' + Math.abs(cDay).toFixed(2) + '% below the highest ' +
        'applied\n           in the last 24h ($' + f(cRef) + '), past the ' + MAX_DROP_24H_PCT +
        '% daily limit.\n           A slow, sustained push on the pool looks exactly like this.');
    }
  }

  const newK = want * X * X;
  const KD = S.defs.ammK;
  if (!(newK > 0) || newK < KD.min || newK > KD.max) {
    await refuse('computed ammK ' + newK + ' falls outside the setting\'s own bounds (' +
                 KD.min + ' .. ' + KD.max + ')');
  }
  console.log('  ammK                   ' + k + '  ->  ' + newK);

  if (!apply) {
    console.log('\n  Proposal only -- nothing written. Re-run with --curve --apply to set it.');
    await pool.end();
    process.exit(0);
  }

  await S.set('ammK', newK);
  console.log('\n  WROTE ammK = ' + newK);

  // Recorded BEFORE verifying, for the same reason the cap mode does it: the
  // ratchet must count a price that was WRITTEN. A run whose read-back fails
  // would otherwise leave no trace and the next run would measure its drop
  // against a stale, higher reference -- the direction that loses the guard.
  try {
    cHist.push({ t: Date.now(), price: want, k: newK, X, forced: forceDrop });
    writeFileSync(CURVE_HISTORY, JSON.stringify(
      cHist.filter(h => h.t >= Date.now() - 7 * 24 * 3600e3), null, 1));
  } catch (e) {
    console.log('  WARNING: could not record curve history (' + e.message + '). ' +
                'The 24h ratchet is blind until this is fixed.');
  }

  // --- 6. prove it took effect ----------------------------------------------
  // Not "did the row change" -- did the SERVICE change what it charges. A value
  // that fails coerce() on reload is ignored silently and ammParams() falls back
  // to rung pricing, which looks like a successful write and sells at a price
  // nobody chose.
  //
  // X is re-read rather than reused: somebody may have bought, or retire-on-spend
  // may have run, between the write and now. Comparing against a stale X would
  // report a mismatch on a correct write -- and, worse, could be tuned into a
  // tolerance so loose that a real rung fallback slipped through it.
  await new Promise(r => setTimeout(r, 35000));
  try {
    const res = await fetch(LIVE_STATE, { signal: AbortSignal.timeout(20000) });
    const after = await res.json();
    const remNow = Number(after.ladderRemainingPcn);
    const gotP   = Number(after.marginalPrice);
    const expect = Math.max(newK / (remNow + virt) / (remNow + virt), floor);
    const ok = Number.isFinite(gotP) && Number.isFinite(expect) &&
               Math.abs(gotP - expect) / expect < 1e-6;
    console.log('  live marginalPrice     $' + f(gotP) + '   expected $' + f(expect) +
                '  ' + (ok ? 'MATCHES' : '*** DOES NOT MATCH ***'));
    if (remNow !== rem) {
      console.log('  (inventory moved during the run: ' + rem + ' -> ' + remNow +
                  ' PCN, which is why the expectation is recomputed)');
    }
    await tg('<b>market.pc.am</b>\nPCN ask followed the wPCN pool <b>down</b>.\n' +
             'charged $' + f(nowP, 6) + ' \u2192 $' + f(gotP, 6) +
             '  (' + cMovePct.toFixed(2) + '%)\n' +
             'pool median 24h $' + f(median, 6) + ', floor $' + f(floor, 6) +
             (cHitFloor ? ' <b>(the floor is binding)</b>' : '') + '\n' +
             'ammK ' + k.toFixed(0) + ' \u2192 ' + newK.toFixed(0) +
             (forceDrop ? '\n<b>--force-drop was used</b>' : '') +
             (ok ? '' : '\n<b>THE READ-BACK DID NOT MATCH \u2014 check /pricing now</b>'));
    await pool.end();
    process.exit(ok ? 0 : 3);
  } catch (e) {
    console.log('  COULD NOT VERIFY against the live service (' + e.message +
                ') -- check /pricing by hand.');
    await tg('<b>market.pc.am</b>\nWrote ammK = ' + newK + ' but COULD NOT VERIFY it took ' +
             'effect (' + e.message + ').\nCheck what the market is charging, by hand.');
    await pool.end();
    process.exit(4);
  }
}


/** How much further can the pool fall before the sale gate shuts on everybody?
 *
 *  Called on EVERY run, including the "no material change" one, because the
 *  whole point of the number is to say how urgent the NEXT run is -- and the
 *  quiet runs are exactly the ones where nobody is looking otherwise.
 *
 *  Both inputs are read live and neither is assumed:
 *    * what a customer is actually charged is `marginalPrice` from the curve.
 *      NOT the ask cap -- that has been inert for pricing since 077fa32, and
 *      computing headroom from it described a price nobody pays.
 *    * the gate is `maxDivergencePct`, a SETTING. It was hardcoded as 20 here
 *      until 2026-09-14, by which time the real value was 1000.
 *
 *  Swallows everything. An informational line must never be able to stop a cap
 *  from being written, and "I could not read it" is printed rather than hidden.
 */
async function printHeadroom() {
  let live;
  try {
    const res = await fetch('http://127.0.0.1:8789/api/ladder/state',
                            { signal: AbortSignal.timeout(15000) });
    live = await res.json();
  } catch (e) {
    console.log('  headroom               UNKNOWN -- could not read market.pc.am (' +
                e.message + '). Not guessing.');
    return;
  }
  const gate    = Number(S.get('maxDivergencePct'));
  const charged = Number(live && live.marginalPrice);
  if (!isFinite(gate) || gate <= 0 || !isFinite(charged) || charged <= 0) {
    console.log('  headroom               UNKNOWN -- need a live marginalPrice and ' +
                'maxDivergencePct, and at least one did not read as a positive number.');
    return;
  }
  const div   = divOf(charged);
  const slack = 1 - (1 + div / 100) / (1 + gate / 100);
  console.log('  charged (curve)        $' + f(charged) +
              '   -> divergence ' + div.toFixed(2) + '%   (gate ' + gate + '%)');
  if (slack <= 0) {
    console.log('  headroom               NONE -- divergence is already at or past the gate, ' +
                'so the market is refusing every sale right now.');
  } else {
    console.log('  headroom               the pool may fall a further ' + (slack * 100).toFixed(1) +
                '% before the ' + gate + '% gate closes the market');
  }
}

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
//   divergence = (price charged - serviceRate) / serviceRate
//   the gate closes when divergence >= GATE, i.e. serviceRate <= price/(1+GATE)
//   so the tolerated fall from today's serviceRate is
//       1 - (price/(1+GATE)) / serviceRate  =  1 - (1 + div) / (1 + GATE)
//
// PRINTED AT THE END, NOT HERE. Two of its three inputs are not known at this
// point in the run: the price a customer actually pays is `marginalPrice` off
// the live curve, not the cap this script computes -- the cap has been inert for
// pricing since 077fa32 -- and the gate is a SETTING, not a constant. Both are
// read in the verification block below, where a failure to read them prints
// "unknown" instead of a number.
//
// The version that stood here until 2026-09-14 used `divOf(cap)` and a hardcoded
// GATE_PCT = 20, and by then the cap was inert and the real gate was 1000. It
// was not slightly off; it was about a different price and a different
// threshold, and it still read as an urgent, precise percentage.
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
  // Still say how close the gate is. A run that changes nothing is not a run
  // with nothing to report -- the pool moves whether or not the cap does.
  await printHeadroom();
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


  await printHeadroom();
  await pool.end();
  process.exit(ok ? 0 : 3);
} catch (e) {
  console.log('  COULD NOT VERIFY against the live service (' + e.message + ') -- check askCapUsd by hand.');
  await pool.end();
  process.exit(4);
}
