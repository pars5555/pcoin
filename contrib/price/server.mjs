#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// PCoin price oracle — constant-product AMM. price.pc.am
// ═══════════════════════════════════════════════════════════════════════════
//
// WHY THIS SHAPE
// PCN is not traded anywhere, so there is no price to discover — only a price
// to POST. A constant-product curve (R * S = k) is the standard way to post one
// that responds to demand without an order book or a counterparty:
//
//   price = R / S            R = USDT reserve, S = PCN in the pool
//   buy  dR  ->  get dS = S - k/(R+dR)      price rises
//   sell dS  ->  get dR = R - k/(S+dS)      price falls
//
// THE PROPERTY THAT MAKES IT SAFE
// Payouts come out of R, and R can only be reduced by the same integral that
// filled it. **You can never pay out more than you hold**, so the operator's
// worst case is the seed — not supply x price. A fixed-price buyback has no
// such bound, which is the whole reason this is a curve and not a constant.
//
// THE FAILURE MODE THAT REMAINS
// Not insolvency — price collapse. PCN is mined continuously (~18,700/day), and
// mined coins cost their holders electricity, not money. If they all sell in,
// the curve does its job and the price falls toward zero. That is a product
// problem, not a solvency one, and the answer to it is real demand from the
// services, not a bigger reserve.
//
// SERVICE RATE IS SEPARATE, ON PURPOSE
// `serviceRate` is what the four products credit at. It TRACKS the market price
// but is damped and capped: every mined coin is a claim on those services, so
// letting an unbounded curve set that number would let a price spike multiply a
// liability nobody paid for. Damping is the seatbelt.
//
// UNLESS `useIndex` IS 1 (price plan Phase 3 Step 4). Then serviceRate is the
// PCN index -- the capped median of exchange.pc.am user-to-user fills, relayed
// and re-checked below -- and the walk is off. The damping then lives in the
// index's own caps (2% a fill, 5% a day) and in this side's speed check.

import { createServer } from 'node:http';
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https';
import { readFileSync, writeFileSync, existsSync, renameSync,
         openSync, closeSync, fsyncSync } from 'node:fs';
import { dirname } from 'node:path';
import { timingSafeEqual, createHash, X509Certificate } from 'node:crypto';
import { validateIndexBody, confirmTwice, speedCheck, remember,
         indexUsable, rateFromIndex, switchCheck, indexLadder, indexNote } from './index-relay.mjs';

const STATE = '/opt/pcoin-price/state.json';
const PORT = 8788;

// ── alerting ───────────────────────────────────────────────────────────────
// This service had NO alerting of any kind, which is how `serviceRate` walked
// +10% a minute against a stuck retune clock until a human happened to read the
// number. It sets the rate four payment products credit real money at, so a
// wrong value here is a wrong price everywhere at once, and the only previous
// way to notice was to look.
//
// Implemented inline rather than by importing the market's notify.mjs: this is
// a separate deployment unit under /opt/pcoin-price and must not gain a
// dependency on a sibling directory that may not be installed beside it.
const ALERT_CONF = '/etc/pcoin/alert.conf';
function readAlertConf() {
  try {
    const out = {};
    for (const line of readFileSync(ALERT_CONF, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]] = m[2];
    }
    return out;
  } catch { return {}; }
}
const ALERT = readAlertConf();
const alertTo = ALERT.MARKET_CHAT || ALERT.ALERT_CHAT;
let alertedMissing = false;
let lastPollAlert = 0;
/** Best-effort and never throws: an alert that can crash the price oracle is a
 *  worse problem than the one it reports. */
// FIRE AND FORGET. price.pc.am is read by every payment rail on the estate, and
// nothing that happens on api.telegram.org may hold it up.
//
// The send could never THROW -- failures were already caught and logged -- but
// it was awaited, and the timeout is ten seconds. A Telegram outage therefore
// did not break the oracle, it made whatever was alerting wait ten seconds,
// which on a service this many things depend on is its own kind of outage.
// Owner, 2026-09-18: every Telegram send must be async, everywhere.
//
// sendAlert() does the work; notify() hands it over and returns at once. No
// caller has ever used the return value; anything that needs to know a message
// landed should await sendAlert directly and say why.
const MAX_IN_FLIGHT = 50;
let alertsInFlight = 0;
let alertsDropped = 0;

function notify(html) {
  if (alertsInFlight >= MAX_IN_FLIGHT) {
    alertsDropped++;
    if (alertsDropped === 1 || alertsDropped % 50 === 0) {
      console.error(`[price] ${alertsInFlight} alerts in flight — DROPPING (${alertsDropped} so far). ` +
                    'Telegram is probably down; pricing is unaffected.');
    }
    return Promise.resolve(false);
  }
  alertsInFlight++;
  // Not awaited on purpose, so the .catch() matters: an un-awaited promise that
  // rejects is an unhandled rejection, which would take down the very service
  // the alert is about.
  sendAlert(html)
    .catch(e => console.error('[price] alert unexpected:', e && e.message))
    .finally(() => { alertsInFlight--; });
  return Promise.resolve(true);
}

async function sendAlert(html) {
  if (!ALERT.TELEGRAM_TOKEN || !alertTo) {
    if (!alertedMissing) {
      alertedMissing = true;
      console.warn('[price] no Telegram token or chat configured — alerts are LOG ONLY');
    }
    console.warn('[price][alert]', html.replace(/<[^>]+>/g, ''));
    return false;
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${ALERT.TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: alertTo, parse_mode: 'HTML',
                             text: `<b>price.pc.am</b>\n${html}` }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) console.warn('[price] telegram said', r.status);
    return r.ok;
  } catch (e) { console.warn('[price] alert failed:', e.message); return false; }
}
// Declared up here, not beside the index code that mostly uses them: the
// first pollLadder() runs during module evaluation, and its failure branch
// formats an alert -- a const declared further down would still be in its
// temporal dead zone and throw, taking the oracle down at start.
// House style for the owner (every PCoin alert): a severity colour and a plain
// headline, what it means with the numbers, "What to do", and the exact
// figures last in <i>tech: ...</i> for whoever checks the arithmetic.
//   usd6(0.0267481452) -> "$0.026748"   pctMove(a, b) -> "down 2.00%"
const usd6 = (n) => (n === null || n === undefined || !isFinite(Number(n)) ? 'unknown'
  : '$' + Number(n).toFixed(6).replace(/0+$/, '').replace(/\.$/, ''));
function pctMove(from, to) {
  const a = Number(from), b = Number(to);
  if (!(a > 0) || !isFinite(b)) return '';
  const p = ((b - a) / a) * 100;
  return `${p >= 0 ? 'up' : 'down'} ${Math.abs(p).toFixed(2)}%`;
}
// A move that does not survive rounding to a millionth of a dollar is float
// noise (0.02794430694305964 -> 0.027944306943059636 was announced as a move on
// 2026-09-24). It is still sent -- every change is, by design -- but it says so.
const noRealMove = (a, b) => usd6(a) === usd6(b);
// What the rails do when the index cannot be used, in plain words.
const indexStakesPlain = () => `Payment services keep crediting at the last good price for up to ` +
  `${Math.round(st.indexMaxAgeSeconds / 60)} min; after that they HOLD new PCN credits until it is back.`;

// The lowest rate the walk can stand on. Only used to escape serviceRate = 0,
// which a multiplicative clamp can otherwise never leave.
const SERVICE_RATE_FLOOR = 1e-8;
// How far above serviceCeiling a reported ladder price may be before it is
// treated as a fault rather than a price. The ceiling is the ladder's last rung,
// so anything above it is already impossible; the factor is slack for a future
// ceiling change landing before the ladder is regenerated.
const LADDER_SANITY_FACTOR = 2;
const LADDER = 'http://127.0.0.1:8789/api/ladder/state';   // market.pc.am, same box

// -- the PancakeSwap pool, and why the posted rate now follows it DOWN ------
//
// Until 2026-09-09 this feed was the anchor and the pool was held to it by
// pcoin-wpcn-keeper, which bought wPCN whenever the pool fell. That is over:
// the keeper's float was 132 USDT against an unlimited, freely-mintable
// supply, so it was a countdown, not a defence.
//
// With nothing defending the downside the pool WILL fall when people sell, and
// that opens a leak which did not exist while the two were pinned together:
//
//     buy wPCN cheap on PancakeSwap -> redeem() 1:1 into PCN
//       -> spend that PCN at any of the six rails, credited at serviceRate
//
// Every cent serviceRate sits above the pool is free money to whoever does
// that, paid out of market-hot. So the rate must track the pool DOWN. This is
// not a courtesy to the market; it is the thing that closes the arbitrage.
//
// THE POOL MAY ONLY EVER LOWER THE RATE, NEVER RAISE IT. That asymmetry is the
// whole safety argument. The pool holds about $1,387, so roughly $100 moves it
// 15%; if it could push the rate UP, a stranger could buy 15% more credit at
// our services for $100. Pushing it DOWN costs them money and only reduces
// what we credit -- there is no attack in that direction, so none is guarded.
const POOL_PAIR = '0xB2c6C80cb31DE366Fb556Fff7C433660BAF60204';
const POOL_WPCN = '0x290A5779a419Cb9cB22fa087CDD1CD16dA2D95F1';   // 8 decimals
const POOL_USDT = '0x55d398326f99059fF775485246999027B3197955';   // 18 decimals
const POOL_RPCS = ['https://bsc-dataseed.binance.org',
                   'https://bsc-dataseed1.defibit.io',
                   'https://bsc-dataseed1.ninicoin.io'];
// balanceOf(address) on each token, rather than getReserves() on the pair.
// getReserves needs token0/token1 ordering to interpret, and that ordering has
// already been got wrong once on this project -- the pair was documented as
// wPCN/WBNB when it is wPCN/USDT. Two balance reads cannot be misread.
const BALANCE_OF = '0x70a08231';

// Held-state alerting. In memory on purpose: after a restart the state is
// re-confirmed over the next few polls rather than announced again.
const HELD_CONFIRM_POLLS = Number(process.env.PCOIN_PRICE_HELD_CONFIRM || 3);
let heldPending = null;
let heldPendingPolls = 0;

async function readPoolPriceUsd() {
  const call = async (rpc, token) => {
    const data = BALANCE_OF + '0'.repeat(24) + POOL_PAIR.slice(2).toLowerCase();
    const r = await fetch(rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call',
                             params: [{ to: token, data }, 'latest'] }),
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) throw new Error('rpc HTTP ' + r.status);
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || 'rpc error');
    if (typeof j.result !== 'string' || !/^0x[0-9a-f]*$/i.test(j.result)) {
      throw new Error('rpc returned no usable result');
    }
    return BigInt(j.result);
  };
  let lastErr = null;
  for (const rpc of POOL_RPCS) {
    try {
      const [w, u] = await Promise.all([call(rpc, POOL_WPCN), call(rpc, POOL_USDT)]);
      // A pair with nothing in it has no price. Returning 0 here would be an
      // answer-shaped unknown, and the rate would walk to the floor on it.
      if (w <= 0n || u <= 0n) throw new Error('pair reserves are zero');
      const wpcn = Number(w) / 1e8;
      const usdt = Number(u) / 1e18;
      const price = usdt / wpcn;
      if (!(isFinite(price) && price > 0)) throw new Error('pair produced a non-price');
      return { price, wpcn, usdt, rpc };
    } catch (e) { lastErr = e; }
  }
  throw new Error('no BSC RPC answered: ' + (lastErr ? lastErr.message : 'unknown'));
}

/** Median of the samples inside the window, or null for UNKNOWN.
 *
 *  Median, not mean: one absurd reading from a flaky RPC moves a mean and
 *  cannot move a median. And null rather than a number when there is not
 *  enough history -- a thin sample is not a cheap price, it is no price, and
 *  the doctrine here is that an unknown must never resolve into a figure. */
function poolMedianUsd() {
  const windowMs = (st.poolTwapHours || 6) * 3600e3;
  const cut = Date.now() - windowMs;
  const xs = (st.poolSamples || [])
    .filter(s => s && s.t >= cut && s.p > 0).map(s => s.p).sort((a, b) => a - b);
  if (xs.length < (st.poolMinSamples || 12)) return null;
  const m = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
}

async function pollPool() {
  if (!st.poolFollow) return { ok: false, why: 'poolFollow is off' };
  try {
    const r = await readPoolPriceUsd();
    st.poolPrice = r.price;
    st.poolAt = Date.now();
    st.poolWpcn = r.wpcn;
    st.poolUsdt = r.usdt;
    st.poolSamples = [...(st.poolSamples || []), { t: st.poolAt, p: r.price }]
      // Keep more than the window, so raising poolTwapHours has history to work
      // with immediately, and cap the array so a long-running process cannot
      // grow the state file without bound.
      .filter(s => s && s.t >= Date.now() - 36 * 3600e3)
      .slice(-2000);
    // Computed here, not in the response, so the REPLICAS can publish the
    // same figures. They hold no samples and must never recompute -- an empty
    // window would answer null and read as "the pool cannot be reached".
    st.poolMedian = poolMedianUsd();
    // In index mode the pool drives nothing -- the rate is the index -- so "the
    // rate is held above the pool by a brake" would describe a mechanism that is
    // switched off. Published as null and never alerted (the plan retires that
    // alert at Step 4). The samples are still taken: they show how well the
    // keeper holds the pool to the index.
    st.poolHeldBy = indexMode() ? null : poolStatus().limitedBy;

    // Alert on CHANGE, and only once the new state has survived a few polls.
    //
    // Gating on change rather than on time is the lesson from the
    // concentration watcher, which sent the same figure twenty-four times in
    // eight hours and taught everyone to ignore it. The confirmation count is
    // for the boundary: a pool sitting exactly on a brake would otherwise flip
    // between held and not-held every minute and alert on each flip.
    if (!indexMode()) {
      const held = st.poolHeldBy;
      if (held === heldPending) heldPendingPolls += 1;
      else { heldPending = held; heldPendingPolls = 1; }

      if (heldPendingPolls >= HELD_CONFIRM_POLLS && held !== st.poolHeldAnnounced) {
        const was = st.poolHeldAnnounced;
        st.poolHeldAnnounced = held;
        const med = st.poolMedian, ladder = st.ladderPrice, rate = st.serviceRate;
        const pct = (a, b) => (b > 0 ? ((a - b) / b) * 100 : 0);
        if (held) {
          const why = {
            floor: 'the published floor',
            // Read the live number rather than hardcoding one. This said
            // "20%" while poolMaxDivergencePct was 15, so the alert named a
            // threshold that was not the one stopping anything.
            marketInterlock: `the ${st.poolMaxDivergencePct}% interlock under the ladder ask`,
            dailyDrop: "one day's maximum fall",
          }[held] || held;
          await notify(
            '⚠️ <b>The credit rate is being held ABOVE the pool</b>\n' +
            `Stopped by: <b>${why}</b>\n\n` +
            `pool (6h median) <code>$${Number(med).toFixed(8)}</code>\n` +
            `serviceRate      <code>$${Number(rate).toFixed(8)}</code>  ` +
            `(<b>${pct(rate, med) >= 0 ? '+' : ''}${pct(rate, med).toFixed(1)}%</b> above the pool)\n` +
            `ladder ask       <code>$${Number(ladder).toFixed(8)}</code>\n\n` +
            'While this lasts, buying wPCN on PancakeSwap, redeeming it 1:1 and ' +
            'spending the PCN at a rail is profitable by that gap, and it is paid ' +
            'out of market-hot.' +
            (held === 'marketInterlock'
              ? '\n\n<b>This one needs a decision.</b> The rate is floored at ' +
                `${st.poolMaxDivergencePct}% below the ladder ask and cannot follow the pool ` +
                'any lower on its own.\n\nTwo levers, both deliberate: lower the LADDER, ' +
                'or lower the interlock (<code>poolMaxDivergencePct</code>). No automatic ' +
                'rule should make either call.\n\n<i>Note: this no longer stops market.pc.am ' +
                'selling. That was true while its sale gate was 20%; the gate was raised to ' +
                '1000 on 2026-09-14 so the market never refuses an order. The reason to act ' +
                'is the arbitrage above, which is paid out of market-hot \u2014 not a stalled ' +
                'market.</i>'
              : '\n\nIt may clear on its own — ' +
                (held === 'dailyDrop' ? 'the daily limit resets.' : 'the floor does not.')));
        } else {
          await notify(
            '✅ <b>The credit rate has caught up with the pool</b>\n' +
            `Was held by <b>${was}</b>; nothing is holding it now.\n` +
            `serviceRate <code>$${Number(rate).toFixed(8)}</code>, ` +
            `pool <code>$${Number(med).toFixed(8)}</code>.`);
        }
      }
    }
    st.poolSampleCount = (st.poolSamples || []).length;
    try { save(st); } catch (e) { console.warn('[price] pool sample not saved:', e.message); }
    return { ok: true, price: r.price };
  } catch (e) {
    // Unreadable resolves NOTHING. The last median stands until it ages out of
    // the window on its own, and if it does the target falls back to the
    // ladder -- never to zero, and never to the floor.
    console.warn('[price] pool unreadable:', e.message);
    return { ok: false, why: e.message };
  }
}

const DEFAULTS = {
  reserve: 1000,            // USDT
  supply: 1000000,          // PCN in the pool -> opening price 0.001
  feeBps: 150,              // 1.5% each way; the spread pays for inventory risk
  dailySellCapUsd: 20,      // one day of mining. Nobody drains a month in an hour
  // Mirrored from the market every poll; the market owns the switch. Default
  // FALSE so a fresh origin never advertises a buyback before it is told.
  buybackOpen: false,
  serviceRate: 0.001,       // what the 4 products credit PCN at
  serviceMaxMovePct: 10,    // per retune step, either direction
  // The ceiling is the ladder's terminal price. It was 0.01, set when the AMM
  // was the only seller and 0.01 was ten times anything reachable. Under the
  // ladder the price runs to 10.00 by design, and a ceiling of 0.01 would not
  // fail loudly -- it would silently cap the credit rate at one cent while the
  // market sold at ten dollars, and every customer paying for a service with
  // PCN would be credited a thousandth of what they handed over.
  serviceCeiling: 10.00,
  // How often a retune step may fire. The clamp is +/-10% PER STEP and a ladder
  // rung is +6.7885% (see the header of contrib/market/ladder.sql for the live
  // geometry), so one step is a little over one rung: in normal trading
  // serviceRate keeps up with the ladder, but a buyer who sweeps thirty rungs
  // at once moves it 10% an hour and a human has time to look. Set
  // this to 24 for the slowest sane walk, or 0 to retune on every poll.
  serviceRetuneIntervalHours: 1,
  serviceRateAt: 0,         // ms epoch of the last accepted step
  // Last known ladder marginal price. Persisted, because it is the posted
  // price: if the market service is down we keep serving the last real number
  // rather than falling back to the AMM curve, which would quote 0.001 and
  // undercut the ladder by three orders of magnitude.
  ladderPrice: null,
  ladderAt: 0,
  ladderSoldPcn: 0,
  ladderRemainingPcn: null,
  soldToday: 0,
  day: '',
  history: [],
  // Follow the pool downward. See the block by POOL_PAIR for the reasoning.
  poolFollow: true,
  // THE FLOOR. Rung 0 of the ladder is $0.015 -- the first price PCN was ever
  // offered at, and the bottom of our own order book. Below this we would be
  // crediting PCN at less than we have ever sold it for, on the word of a pool
  // holding about $1,300. It is a published number with history rather than
  // one somebody picked, which is the only kind of floor worth having.
  poolFloorUsd: 0.015,
  // How far below the LADDER price the rate may be dragged.
  //
  // market.pc.am carries its own interlock: at maxDivergencePct (20) between
  // the ladder and the rate the products actually credit at, it PAUSES EVERY
  // SALE and alerts. That interlock is right -- selling PCN at the ladder price
  // while the rails credit far less would shortchange the buyer -- so this
  // number sits UNDER it, and the rate stops following before the market jams
  // rather than after. If the pool falls further than this, it is a decision
  // for a person: the LADDER has to come down, and no automatic rule here can
  // make that choice.
  poolMaxDivergencePct: 15,
  // A crash is not a price. At most this much below where the rate opened the
  // day, however far the pool goes.
  poolMaxDailyDropPct: 10,
  poolTwapHours: 6,
  poolMinSamples: 12,
  poolPrice: null,
  poolAt: 0,
  poolWpcn: null,
  poolUsdt: null,
  poolSamples: [],
  // Where the rate stood when the day opened, for poolMaxDailyDropPct.
  rateDayKey: '',
  rateDayOpen: 0,
  // Worked out by the primary each poll and mirrored to the replicas, so
  // every origin publishes the same pool picture. Never recomputed off-box.
  poolMedian: null,
  poolHeldBy: null,
  poolSampleCount: 0,
  // The last held-state we ANNOUNCED. Explicitly null rather than absent:
  // undefined would differ from null on the very first poll and announce a
  // clearance that never happened.
  poolHeldAnnounced: null,

  // THE PCN INDEX (price plan Phase 2, then Step 4). Read by the primary from
  // exchange.pc.am every 60 s, checked again here (index-relay.mjs), and
  // published as an `index` block.
  //
  // `useIndex` is the switch that makes it THE rate. Phase 2 deliberately had
  // no switch, because a setting that does nothing reads as switched; it
  // arrived with the code that reads it. 0 = the legacy walk, byte-for-byte.
  // 1 = creditRateUsd = serviceRate = the index (plan Step 4): no walk, the
  // `ladder` block becomes a compatibility block whose stale flag follows the
  // index, and GET /credit-rate answers 503 whenever the index is not usable.
  // Set ONLY through POST /admin/state, which refuses while the precondition
  // does not hold. The owner decided on 2026-09-25 to switch now.
  useIndex: 0,
  indexUrl: 'https://exchange.pc.am/api/index',
  // Older than this and the published block says stale -- and in index mode
  // the rails HOLD: /credit-rate answers 503 and ladder.stale is true.
  indexMaxAgeSeconds: 600,
  indexState: null,         // null = never polled; else held|live|frozen|unknown|disabled
  indexNano: null,          // the last ACCEPTED price, as a string of nano-USD
  indexSeq: null,
  indexComputedAt: null,    // seconds, the exchange's computation time
  indexAt: 0,               // ms, when this side last accepted a reading
  indexMeta: null,          // { lastMoveAt, window, limitedBy, reasons, rules }
  indexRefused: null,       // { why, seq, usd, at } while a reading is being refused
  indexError: null,         // { why, at } while the endpoint cannot be read
  indexHistory: [],         // [{t, nano}] accepted, 25 h -- for the speed check; not replicated
  indexRebaseArmed: false,  // set by POST /admin/index/accept after a deliberate re-seed

  adminToken: '',
};

function load() {
  // A missing or unreadable state file used to collapse into `{...DEFAULTS}`,
  // and DEFAULTS carries no `role` -- so `st.role || 'primary'` turned "I do not
  // know what I am" into the one answer that owns the curve. A replica whose
  // state.json was truncated by a full disk would come back as a SECOND primary,
  // accepting writes and diverging the AMM, for which there is no merge.
  //
  // Unknown is its own state, so unknown is fatal. Bootstrapping a genuinely new
  // origin is the one case where there is nothing to lose, and it has to be
  // asked for explicitly.
  if (!existsSync(STATE)) {
    if (process.env.PCOIN_PRICE_INIT === '1') return { ...DEFAULTS, role: 'primary' };
    console.error(`[price] FATAL: ${STATE} does not exist. Refusing to guess a role -- ` +
                  `a replica that guesses "primary" diverges the curve. ` +
                  `To bootstrap a new origin: PCOIN_PRICE_INIT=1`);
    process.exit(1);
  }
  let parsed;
  try { parsed = JSON.parse(readFileSync(STATE, 'utf8')); }
  catch (e) {
    console.error(`[price] FATAL: ${STATE} is unreadable (${e.message}). ` +
                  `Refusing to start on defaults -- restore it from a .bak.`);
    process.exit(1);
  }
  if (parsed.role !== 'primary' && parsed.role !== 'replica') {
    console.error(`[price] FATAL: ${STATE} has no explicit "role". ` +
                  `Set it to "primary" or "replica"; it must never be inferred.`);
    process.exit(1);
  }
  return { ...DEFAULTS, ...parsed };
}
function save(s) {
  // Write-then-rename: a torn write here would corrupt the reserve, which is
  // the one number the safety property depends on. rename() is atomic for the
  // DIRECTORY ENTRY only -- it promises nothing about the tmp file's bytes
  // having reached the platter, so a crash can leave a zero-length state.json
  // behind an atomic rename. fsync the data before the rename, and the
  // directory after it, or the guarantee is only half there.
  const tmp = STATE + '.tmp';
  const fd = openSync(tmp, 'w');
  try { writeFileSync(fd, JSON.stringify(s, null, 2)); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(tmp, STATE);
  try {
    const dir = openSync(dirname(STATE), 'r');
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } catch { /* directory fsync is unsupported on some filesystems; not fatal */ }
}

let st = load();

// Step 4 is on. Strictly 1: anything else -- absent, 0, a hand-edited `true` --
// is the legacy walk, which is today's behaviour and the safe way to be wrong.
function indexMode() { return st.useIndex === 1; }

// 'primary' owns the curve. 'replica' mirrors it and refuses writes.
const ROLE = st.role;
const UPSTREAM = st.upstream || null;      // replica only, e.g. https://price-1.pc.am
let lastSync = 0;
let syncOk = ROLE === 'primary';

// A replica must reach the PRIMARY, and `price.pc.am` cannot get it there.
// That name is Cloudflare-proxied, and it resolved to this very replica -- so
// the replica fetched its own state, wrote it back, and called that a sync. It
// looked perfectly healthy: `stale: false`, a plausible price, no errors in the
// log. Nothing the primary computed had reached the public endpoint since the
// day it was set up, and nothing ever would have.
//
// So the sync goes to the primary's ADDRESS, with `price.pc.am` as the TLS
// server name. The primary answers with a Cloudflare Origin CA certificate,
// which no public trust store contains -- it is trusted only by Cloudflare's
// edge -- so ordinary verification cannot succeed on a direct origin-to-origin
// call. We pin the public key instead. That is strictly NARROWER than trusting
// a CA: a CA can issue for anyone, a pin accepts one key and nothing else.
const UPSTREAM_SNI  = st.upstreamSni  || null;    // e.g. 'price.pc.am'
const UPSTREAM_SPKI = st.upstreamSpki || null;    // base64 sha256 of the SPKI

// The pin is checked on `secureConnect`, which only fires for a real handshake.
// With the default agent that was a 50% outage: https.Agent caches TLS SESSIONS,
// and on a RESUMED session the server does not re-send its certificate, so
// getPeerCertificate() returns `{}` and the pin check destroyed the request with
// "no peer certificate". Every other sync failed, in production, once a minute.
//
// The fix is to make every request a fresh handshake, which also makes the pin
// unconditionally per-connection instead of per-session. This costs one RSA
// handshake per 30 seconds and buys a check that cannot be skipped.
//
// Not `checkServerIdentity`: with rejectUnauthorized:false Node never calls it
// (verifyError is already set by the untrusted Origin CA, and the internal guard
// short-circuits), so that route looks stricter and is no pin at all.
const pinAgent = new HttpsAgent({ maxCachedSessions: 0, keepAlive: false });

const MAX_UPSTREAM_BYTES = 256 * 1024;

function getPinnedJson(urlStr, sni, spkiPin, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    let settled = false;
    const fail = e => { if (!settled) { settled = true; req.destroy(); reject(e); } };
    const deadline = setTimeout(() => fail(new Error('upstream exceeded the total deadline')),
                                timeoutMs * 2);
    const req = httpsRequest({
      host: u.hostname, port: u.port || 443, path: u.pathname + u.search,
      method: 'GET', servername: sni, headers: { Host: sni },
      rejectUnauthorized: false,      // replaced by the pin check below, not dropped
      timeout: timeoutMs, agent: pinAgent,
    }, res => {
      let s = '';
      res.on('data', c => {
        s += c;
        // The inbound request reader caps its body; a response from a host we
        // authenticate with a pin over rejectUnauthorized:false deserves the
        // same treatment, not less.
        if (s.length > MAX_UPSTREAM_BYTES) fail(new Error('upstream response too large'));
      });
      res.on('end', () => {
        if (settled) return;
        if (res.statusCode !== 200) return fail(new Error(`HTTP ${res.statusCode}`));
        let j;
        try { j = JSON.parse(s); } catch { return fail(new Error('upstream sent unparseable JSON')); }
        settled = true; clearTimeout(deadline); resolve(j);
      });
    });
    req.on('socket', sock => sock.on('secureConnect', () => {
      const cert = sock.getPeerCertificate();
      // `cert.pubkey` is absent on some Node/TLS paths even for a full
      // handshake; `cert.raw` is the DER and always present, so derive the SPKI
      // from it when needed rather than treating a missing convenience field as
      // a missing certificate.
      let spki = null;
      try {
        if (cert && cert.pubkey) spki = createHash('sha256').update(cert.pubkey).digest('base64');
        else if (cert && cert.raw) {
          const der = new X509Certificate(cert.raw).publicKey.export({ type: 'spki', format: 'der' });
          spki = createHash('sha256').update(der).digest('base64');
        }
      } catch (e) { return fail(new Error(`cannot read the peer key: ${e.message}`)); }
      if (!spki) return fail(new Error('no peer certificate'));
      if (spki !== spkiPin) {
        fail(new Error(`upstream key pin mismatch: got ${spki}, expected ${spkiPin}`));
      }
    }));
    req.on('timeout', () => fail(new Error('upstream timed out')));
    req.on('error', e => { clearTimeout(deadline); if (!settled) { settled = true; reject(e); } });
    req.end();
  });
}

async function syncFromPrimary() {
  if (ROLE !== 'replica' || !UPSTREAM) return;
  try {
    const v = (UPSTREAM_SNI && UPSTREAM_SPKI)
      ? await getPinnedJson(`${UPSTREAM}/state`, UPSTREAM_SNI, UPSTREAM_SPKI)
      : await (async () => {
          const r = await fetch(`${UPSTREAM}/state`, { signal: AbortSignal.timeout(8000) });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })();
    if (typeof v.reserve !== 'number' || typeof v.supply !== 'number') throw new Error('bad state');
    // Every origin now declares its role explicitly, so require the POSITIVE
    // answer rather than merely rejecting the negative one. Mirroring a mirror
    // is how a frozen price passes for a live one, and an upstream that has
    // stopped saying what it is has not said "primary".
    if (v.role !== 'primary') {
      throw new Error(`upstream answered as "${v.role ?? 'unknown'}", not the primary`);
    }
    // Keep our own identity AND our own means of authenticating the upstream.
    // `...v` would otherwise import the primary's copies of these -- and a
    // promoted or misconfigured primary could hand every replica a pin that
    // matches nothing, killing all sync at once with no way back in.
    st = { ...st, ...v,
           role: ROLE, upstream: UPSTREAM,
           upstreamSni: UPSTREAM_SNI, upstreamSpki: UPSTREAM_SPKI };
    save(st);
    lastSync = Date.now();
    syncOk = true;
  } catch (e) {
    // Deliberately do NOT clear the state. A failed sync resolves nothing: the
    // last known price is still the best answer available, and erasing it would
    // take four payment systems down for a network blip.
    syncOk = false;
    console.warn('[price] sync failed, serving last known state:', e.message);
  }
}
if (ROLE === 'replica') {
  await syncFromPrimary();
  setInterval(syncFromPrimary, 30000);
}
const k = () => st.reserve * st.supply;
const price = () => st.reserve / st.supply;          // the AMM curve — buyback only
const today = () => new Date().toISOString().slice(0, 10);

// ── the ladder is now the posted price ─────────────────────────────────────
// PCN is sold from a finite 100,000-coin ladder on market.pc.am, not from this
// curve. The AMM still runs the BUYBACK -- its safety property (you can never
// pay out more than the reserve holds) is exactly what a buyback needs, and
// nothing about that changed. What changed is which number is "the price":
// quoting the curve's 0.001 while the market charges ladder prices would be
// publishing a figure nobody can trade at.
const ladderKnown = () => typeof st.ladderPrice === 'number' && isFinite(st.ladderPrice)
                          && st.ladderPrice > 0;
// Falls back to the AMM curve ONLY before a ladder price has ever been seen --
// i.e. a brand-new origin that has not completed one poll. It must never be
// used to answer "the market service is down", because the curve sits at 0.001
// and that reads as "PCN is worth a thousandth of what it was".
const postedPrice = () => (ladderKnown() ? st.ladderPrice : price());
// retuneServiceRate must not walk toward the AMM fallback. If the ladder has
// never been known there is no target, and no target means no step.
// The rate the walk aims at. The ladder is the ceiling; the pool may pull it
// down; three separate brakes bound how far. Every one of them yields the
// LADDER price when its input is unknown -- never zero, and never the floor.
function retuneTarget() {
  if (!ladderKnown()) return null;
  const ladder = st.ladderPrice;
  if (!st.poolFollow) return ladder;
  const pool = poolMedianUsd();
  if (pool === null) return ladder;          // too little history is not a price
  const dayFrom = st.rateDayOpen > 0 ? st.rateDayOpen : st.serviceRate;
  const brakes = [
    st.poolFloorUsd || 0,                                    // absolute floor
    ladder * (1 - (st.poolMaxDivergencePct || 0) / 100),     // market interlock
    dayFrom * (1 - (st.poolMaxDailyDropPct || 0) / 100),     // one day's fall
  ];
  // min() against the ladder is what makes this one-directional: a pool
  // trading ABOVE the ladder changes nothing at all.
  //
  // And the OUTER min() is the rule the brakes must never break: they may
  // slow how far the POOL drags the rate, but never lift it above the
  // LADDER -- the price the project SELLS PCN at. Until 2026-09-23 the ladder
  // could not fall fast, so a brake above it never arose; since the ask
  // follows the pool down hourly it can, and the day's-drop brake held the
  // rate at $0.0306 over a $0.0292 ask. Buy PCN on market.pc.am, spend it at
  // a rail: 4.7% for nothing, paid by the project. A rail must never credit
  // more for a PCN than the project charges for one.
  return Math.min(ladder, Math.max(Math.min(ladder, pool), ...brakes));
}

/** What the pool says, and what is stopping the rate reaching it. Used by
 *  /price and by the log line, so both describe the same situation. */
function poolStatus() {
  const pool = poolMedianUsd();
  if (!ladderKnown() || pool === null) return { pool, limited: false, limitedBy: null };
  const ladder = st.ladderPrice;
  if (pool >= ladder) return { pool, limited: false, limitedBy: null };
  const dayFrom = st.rateDayOpen > 0 ? st.rateDayOpen : st.serviceRate;
  const bars = [
    ['floor', st.poolFloorUsd || 0],
    ['marketInterlock', ladder * (1 - (st.poolMaxDivergencePct || 0) / 100)],
    ['dailyDrop', dayFrom * (1 - (st.poolMaxDailyDropPct || 0) / 100)],
  ].filter(([, v]) => v > pool).sort((a, b) => b[1] - a[1]);
  return { pool, limited: bars.length > 0, limitedBy: bars.length ? bars[0][0] : null };
}

/** Open the day's rate window. poolMaxDailyDropPct is measured from here. */
function rollRateDay() {
  const d = today();
  if (st.rateDayKey !== d || !(st.rateDayOpen > 0)) {
    st.rateDayKey = d;
    st.rateDayOpen = st.serviceRate;
  }
}

// ── transient guard ────────────────────────────────────────────────────────
// A ladder price must be SEEN TWICE, 60s apart, before it is believed.
//
// This is not theoretical. It has now happened twice, both times from routine
// maintenance rather than anything exotic:
//
//   * `ladder-test.mjs` performs real, committed fills against the production
//     ladder and restores them seconds later. A poll landing inside that window
//     read `ladder 0.020831134` and stepped serviceRate 0.015 -> 0.0165.
//   * Directly editing a rung to verify the price-move alert did the same
//     thing, for a 60-second window.
//
// In both cases the ladder was correct before and after; only the middle was
// observed. serviceRate is what four payment products credit real customers at,
// and a step is clamped to 10% but is NOT self-correcting on a useful timescale
// — it walks back one clamped step per retune interval, an hour apart.
//
// So the rule is: agreement across two consecutive polls, or no move. A genuine
// price change is delayed by at most one poll (60s), which costs nothing; a
// transient shorter than that becomes unobservable, which is the entire point.
// `force` (POST /admin/retune) still bypasses everything, deliberately — that is
// the operator saying "I have looked at it myself".
let seenLadder = { price: null, count: 0 };
function ladderPriceConfirmed(p) {
  if (p === seenLadder.price) { seenLadder.count++; }
  else { seenLadder = { price: p, count: 1 }; }
  return seenLadder.count >= 2;
}

/** Pull the ladder's marginal price from the market service on localhost.
 *
 *  A failed poll resolves NOTHING. It does not zero the price, does not fall
 *  back to the AMM, and does not retune: the last known ladder price stays, and
 *  `ladderStale` tells a consumer it is remembered rather than current. Four
 *  payment systems credit real money off this number, and "the market service
 *  restarted" must never read as "PCN is worth a thousandth of what it was". */
async function pollLadder(force = false) {
  if (ROLE !== 'primary') return { ok: false, why: 'not the primary' };
  try {
    const r = await fetch(LADDER, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const v = await r.json();
    // An exhausted ladder reports marginalPrice: null. That is not a price of
    // zero -- it means every rung is sold, so the last rung's price stands.
    const p = v.marginalPrice;
    if (p !== null && !(typeof p === 'number' && isFinite(p) && p > 0)) {
      throw new Error('bad marginalPrice');
    }
    // Sanity-bound the ladder before it becomes the posted price. The market is
    // on this box's loopback and is trusted, but "trusted" is not "incapable of
    // a bug", and this number walks four products' credit rates. A value above
    // the ceiling can only be wrong: the ceiling IS the ladder's last rung.
    if (p !== null && p > st.serviceCeiling * LADDER_SANITY_FACTOR) {
      throw new Error(`ladder price ${p} exceeds the ceiling ${st.serviceCeiling} by more than ` +
                      `${LADDER_SANITY_FACTOR}x -- refusing rather than posting it`);
    }
    // Build the update, then commit it in one assignment. Mutating `st` field by
    // field and only then calling save() left the in-memory state ahead of disk
    // whenever save() threw -- and the catch below logs "keeping last known
    // price" while the process is in fact serving the new one.
    // A price only becomes the retune target once two consecutive polls agree —
    // see the transient guard above. Until then the last confirmed price stands,
    // exactly as it does when the market is unreachable: an unconfirmed reading
    // resolves nothing rather than resolving to itself.
    const confirmed = p !== null && ladderPriceConfirmed(p);
    if (p !== null && !confirmed && p !== st.ladderPrice) {
      console.log(`[price] ladder ${p} seen once; waiting for a second poll to agree ` +
                  `(holding ${st.ladderPrice})`);
    }
    const next = {
      ...(confirmed ? { ladderPrice: p } : {}),
      ladderSoldPcn: Number(v.soldPcn) || 0,
      // Number(undefined) is NaN, which JSON.stringify renders as `null` -- so
      // an omitted field would be published as a real-looking value.
      ladderRemainingPcn: isFinite(Number(v.remainingPcn)) ? Number(v.remainingPcn) : null,
      ladderAt: Date.now(),
      // Mirrored from the market, which owns the switch. Without it this
      // service keeps publishing buybackPrice, feeBps and
      // buybackRemainingToday for a facility that is CLOSED -- and anyone
      // integrating against those would conclude they can sell PCN back at
      // that price. They cannot.
      ...(typeof v.buybackOpen === 'boolean' ? { buybackOpen: v.buybackOpen } : {}),
    };
    const snapshot = { ...st };
    const before = { serviceRate: st.serviceRate };
    Object.assign(st, next);
    rollRateDay();
    const tune = retuneServiceRate(force);
    try { save(st); }
    catch (e) {
      st = snapshot;
      // The rate is applied in memory but did not reach the disk. On the next
      // restart the service silently reverts to the older figure, and the
      // divergence between what was charged and what is stored is invisible.
      await notify(`🔴 <b>State could not be persisted</b>\nThe posted rate is live in memory ` +
        `but NOT saved, so a restart will silently revert it.\n` +
        `<code>${String(e.message).slice(0, 200)}</code>`);
      throw new Error(`state could not be persisted: ${e.message}`);
    }
    if (tune.moved) {
      console.log(`[price] serviceRate -> ${tune.serviceRate} (ladder ${st.ladderPrice})`);
      // Every move, no throttle. This is the number every PCN payment rail
      // credits money at; it moves at most once an hour by construction, and the
      // one time it ran away it did so unobserved for as long as it took someone
      // to look. Do NOT list the rails here: the list said four for days after
      // the fifth went live, and an alert nobody can trust to be complete is
      // worse than one that does not try.
      const flat = noRealMove(before.serviceRate, tune.serviceRate);
      await notify((flat
        ? `🟢 <b>Credit rate unchanged at ${usd6(tune.serviceRate)}</b> (rounding only)\n`
        : `🟢 <b>Credit rate moved ${pctMove(before.serviceRate, tune.serviceRate)}: ` +
          `${usd6(before.serviceRate)} → ${usd6(tune.serviceRate)}</b>\n`) +
        `Every service that takes PCN now credits customers ${usd6(tune.serviceRate)} per PCN.\n` +
        `What to do: nothing.\n` +
        `<i>tech: serviceRate moved <code>${before.serviceRate}</code> → <code>${tune.serviceRate}</code> · ` +
        `ladder ${st.ladderPrice} · ceiling ${st.serviceCeiling} · max move ${st.serviceMaxMovePct}%</i>`);
    }
    if (indexMode()) watchSellVsCredit();
    return { ok: true, ...tune };
  } catch (e) {
    console.warn('[price] ladder poll failed, keeping last known price:', e.message);
    // The last known price stands, which is correct — but if the market service
    // stays unreachable the posted price silently ages, and `stale` is only
    // visible to whoever reads the JSON. Say it once per hour rather than on
    // every failed poll.
    if (Date.now() - lastPollAlert >= 60 * 60 * 1000) {
      lastPollAlert = Date.now();
      await notify(`🟡 <b>price.pc.am cannot read market.pc.am</b>\nThe market price it publishes stays at ` +
        `the last known ${usd6(st.ladderPrice)}. The number is not wrong -- it is just not being refreshed.\n` +
        'What to do: nothing if it clears within the hour; if not, check that market.pc.am is up.\n' +
        // Escaped inline: escHtml is declared further down, and this branch
        // can run during module evaluation (the first pollLadder()).
        `<i>tech: Ladder unreachable: ${String(e.message).slice(0, 200)
          .replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</i>`);
    }
    return { ok: false, why: e.message };
  }
}
if (ROLE === 'primary') {
  await pollLadder();
  setInterval(pollLadder, 60000);
  // The pool is read on the same cadence and only by the primary, for the same
  // reason the ladder is: replicas take the whole state from /state, so three
  // origins cannot disagree about what the pool said.
  await pollPool();
  setInterval(pollPool, 60000);
}
// Replicas need no poll of their own: they take ladderPrice, serviceRate and
// the clock stamps wholesale from the primary's /state, so all three origins
// answer with the same number. A replica that polled the ladder itself could
// not reach it anyway -- the market runs on the primary's loopback.

// ── the PCN index: relayed, in shadow or in use ────────────────────────────
// Only the primary polls, for the same reason as the ladder: three origins
// polling on their own could disagree about what the exchange said.
//
// A failed or unusable read resolves NOTHING: the last accepted reading stays,
// and ageSeconds/stale say how old it is. A reading that moved faster than the
// exchange's own rules allow is REFUSED and alerted -- once per reading -- and
// the last accepted one stays. After a deliberate re-seed on the exchange, an
// operator accepts the new value with POST /admin/index/accept.
//
// In index mode (useIndex = 1) those same rules decide what every rail
// credits. A confirmed, speed-checked, priced reading becomes serviceRate.
// Anything else leaves serviceRate exactly where it is and lets the reading
// AGE; once it is older than indexMaxAgeSeconds the rails hold (/credit-rate
// 503, ladder.stale true). No unconfirmed or refused reading ever moves it.
const INDEX_DOWN_ALERT_MS = 10 * 60 * 1000;
let indexPending = null;          // transient guard, in memory like seenLadder
let indexFailingSince = 0;
let indexDownAlerted = false;
let indexRefusalAlerted = null;
// Whether the last accepted reading carried a price, as last ANNOUNCED. In
// memory and optimistic, like the held state: after a restart an unpriced
// index is announced once and a priced one is not.
let indexPricedAnnounced = true;

// Exchange-supplied text goes into HTML-mode Telegram messages, and Telegram
// REJECTS a message whose markup does not parse -- silently, from our side. A
// JSON.parse error on an HTML error page reads "Unexpected token '<'...", so
// one unescaped reason would lose the very alert that says the feed is broken.
const escHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));


// What an index alert's reader needs to know about the stakes. In shadow mode
// the wording is Phase 2's, unchanged; in index mode it says the rails hold.
const indexTag = () => (indexMode() ? '(IN USE: the rails credit at it)' : '(shadow)');
const indexStakes = () => 'The rails credit at this index. They keep the last accepted value, and once ' +
  `it is more than ${st.indexMaxAgeSeconds} s old GET /credit-rate answers 503 and every rail HOLDS new credits.`;

/** Step 4: set serviceRate from an accepted index price. Called for every
 *  confirmed priced reading in index mode, and once by the switch itself. */
function applyIndexRate(usd, { quiet = false } = {}) {
  const next = rateFromIndex(usd, { floorUsd: st.poolFloorUsd, ceilingUsd: st.serviceCeiling });
  if (next === null) return { moved: false, serviceRate: st.serviceRate };
  const before = st.serviceRate;
  st.serviceRate = next;
  // Stamped on EVERY confirmed reading, not only on a move. serviceRateAt is
  // the walk's clock: if the switch is turned back off, the legacy walk must
  // wait a full serviceRetuneIntervalHours from the last index reading before
  // its first step, so it resumes FROM the index and never jumps off it.
  st.serviceRateAt = Date.now();
  const moved = next !== before;
  if (moved && !quiet) {
    console.log(`[price] serviceRate -> ${next} (PCN index seq ${st.indexSeq})`);
    const m = st.indexMeta || {}, w = m.window || {};
    // Every move, no throttle, exactly as for the walk. The index moves only
    // on new qualifying fills, so this is bounded by trading, and each one is
    // a change in what every rail credits.
    const flat = noRealMove(before, next);
    notify((flat
      ? `🟢 <b>PCN price unchanged at ${usd6(next)}</b> (rounding only)\n`
      : `🟢 <b>PCN price moved ${pctMove(before, next)}: ${usd6(before)} → ${usd6(next)}</b>\n`) +
      `Every service that takes PCN now credits customers ${usd6(next)} per PCN. It follows the ` +
      'PCN price on exchange.pc.am, which moves on real trades between customers or when you ' +
      're-seed it' + (w.trades != null ? ` (${w.trades} trades counted in the last ${w.hours} h)` : '') + '.' +
      (next !== usd ? ` The exchange said ${usd6(usd)}, but the floor/ceiling setting held it at ${usd6(next)}.` : '') + '\n' +
      'What to do: nothing.\n' +
      '<i>tech: serviceRate moved (PCN index) ' +
      `<code>${before}</code> → <code>${next}</code> · index seq ${st.indexSeq}` +
      (next !== usd ? ` · clamped from $${usd} to the floor/ceiling` : '') + ' · ' +
      (w.trades != null
        ? `evidence: ${w.trades} fills, ${w.entities} people, $${escHtml(w.countedUsd ?? '?')} in the ${w.hours} h window`
        : 'evidence: the exchange published no window') +
      (m.limitedBy && m.limitedBy.length ? ` · limited by ${escHtml(m.limitedBy.join(', '))}` : '') + '</i>');
  }
  return { moved, serviceRate: next };
}

/** Index mode: say so when the exchange's index stops (or starts again)
 *  carrying a price. `unknown` or `disabled` stops every rail at once, and the
 *  exchange-side watcher stays quiet about an index that is switched off. */
function announceIndexPriced(reading) {
  const priced = reading.nano !== null;
  if (priced === indexPricedAnnounced) return;
  indexPricedAnnounced = priced;
  notify(priced
    ? `🟢 <b>The PCN price is back -- payment services credit again</b>\n` +
      `The exchange publishes ${usd6(reading.usd)} again, and every service that takes PCN credits at it.\n` +
      'What to do: nothing.\n' +
      `<i>tech: PCN index carries a price again: $${reading.usd} (seq ${reading.seq}, ${escHtml(reading.state)})</i>`
    : `🔴 <b>Payment services are HOLDING PCN credits: the PCN price is ${escHtml(String(reading.state).toUpperCase())}</b>\n` +
      'exchange.pc.am publishes no PCN price right now, so no service that takes PCN can credit a payment ' +
      'until it does. Payments wait; nothing is lost.' +
      (st.indexNano !== null ? ` The last price, ${usd6(Number(st.indexNano) / 1e9)}, is not used meanwhile.` : '') + '\n' +
      'What to do: open admin.pc.am, Exchange, PCN index, find why it has no price, and re-seed it once you know.\n' +
      `<i>tech: PCN index is ${escHtml(String(reading.state).toUpperCase())} on exchange.pc.am; ` +
      'GET /credit-rate answers 503' +
      (reading.reasons && reading.reasons.length ? `; ${escHtml(reading.reasons[0])}` : '') + '</i>');
}

// "A rail never credits more for a PCN than the project charges for one"
// (13195a7) was enforced by the outer min() in retuneTarget(), which belongs to
// the walk -- and in index mode the walk is off. The plan makes it true BY
// CONSTRUCTION instead (Step 3: market.pc.am sells at index x 1.03), and a
// construction is exactly the kind of thing that stops being true without
// telling anyone: Step 3 rolled back, the premium set to 0, a market bug. So
// it is WATCHED: alerted on change, after HELD_CONFIRM_POLLS agreeing ladder
// polls, the same shape as the held-state alert it replaces.
let underPending = null, underPolls = 0, underAnnounced = false;
function watchSellVsCredit() {
  const under = ladderKnown() && st.ladderPrice < st.serviceRate;
  if (under === underPending) underPolls += 1;
  else { underPending = under; underPolls = 1; }
  if (underPolls < HELD_CONFIRM_POLLS || under === underAnnounced) return;
  underAnnounced = under;
  const gap = st.serviceRate > 0 ? ((st.serviceRate - st.ladderPrice) / st.serviceRate) * 100 : 0;
  notify(under
    ? '🔴 <b>Services credit MORE per PCN than market.pc.am charges</b>\n' +
      `Services credit ${usd6(st.serviceRate)} per PCN, but market.pc.am sells PCN at ${usd6(st.ladderPrice)} ` +
      `(${gap.toFixed(2)}% less). Anyone can buy on the market and spend at a service for ${gap.toFixed(2)}% ` +
      'more than they paid, and the project pays that gap.\n' +
      'What to do: check market.pc.am\'s pricing mode (it should sell at the PCN price plus its markup). ' +
      'To stop it at once: <code>POST /admin/state {"useIndex":0}</code> on the price primary.\n' +
      `<i>tech: The rails credit MORE than market.pc.am charges -- serviceRate (the PCN index) ` +
      `$${st.serviceRate}, market $${st.ladderPrice}</i>`
    : '🟢 <b>market.pc.am sells at or above the credit rate again</b>\n' +
      `Services credit ${usd6(st.serviceRate)} per PCN; the market sells at ${usd6(st.ladderPrice)}.\n` +
      'What to do: nothing.\n' +
      `<i>tech: serviceRate $${st.serviceRate}, market $${st.ladderPrice}</i>`);
}

async function pollIndex() {
  if (ROLE !== 'primary') return { ok: false, why: 'not the primary' };
  const nowMs = Date.now();
  const nowS = Math.floor(nowMs / 1000);
  let reading;
  try {
    const r = await fetch(st.indexUrl, { signal: AbortSignal.timeout(8000),
                                         headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    if (text.length > 64 * 1024) throw new Error('body larger than 64 KB');
    const v = validateIndexBody(JSON.parse(text), { nowS });
    if (!v.ok) throw new Error(`${v.kind}: ${v.why}`);
    reading = v.reading;
  } catch (e) {
    const why = String(e && e.message || e).slice(0, 200);
    if (!indexFailingSince) indexFailingSince = nowMs;
    st.indexError = { why, at: nowMs };
    if (!indexDownAlerted && nowMs - indexFailingSince >= INDEX_DOWN_ALERT_MS) {
      indexDownAlerted = true;
      notify(`🟡 <b>price.pc.am cannot read the PCN price from exchange.pc.am</b>\n` +
        `No usable reading for ${Math.round((nowMs - indexFailingSince) / 60000)} min. ` +
        (indexMode() ? indexStakesPlain()
          : 'Nothing credits with it yet, so no money is affected; the shadow record has a gap.') + '\n' +
        'What to do: nothing if a "readable again" message follows soon; if not, check that ' +
        'exchange.pc.am/api/index loads.\n' +
        `<i>tech: PCN index unreachable ${indexTag()}: ${escHtml(why)}</i>`);
    }
    try { save(st); } catch (se) { console.warn('[price] index error not saved:', se.message); }
    return { ok: false, why };
  }
  if (indexDownAlerted) {
    notify(`🟢 <b>price.pc.am can read the PCN price again</b>\n` +
      `It was unreadable for ${Math.round((nowMs - indexFailingSince) / 60000)} min.\n` +
      'What to do: nothing.\n' +
      `<i>tech: PCN index readable again ${indexTag()}</i>`);
  }
  indexFailingSince = 0;
  indexDownAlerted = false;
  st.indexError = null;

  const g = confirmTwice(indexPending, reading);
  indexPending = g.pending;
  if (!g.confirmed) {
    try { save(st); } catch { /* nothing new to lose */ }
    return { ok: true, confirmed: false };
  }
  const prev = st.indexNano !== null && st.indexSeq !== null
    ? { nano: Number(st.indexNano), seq: st.indexSeq } : null;
  const speed = st.indexRebaseArmed
    ? { ok: true }
    : speedCheck({ prev, history: st.indexHistory, reading, nowS });
  if (!speed.ok) {
    const key = `${reading.seq}|${reading.nano}`;
    st.indexRefused = { why: speed.why, seq: reading.seq, usd: reading.usd, at: nowMs };
    if (indexRefusalAlerted !== key) {
      indexRefusalAlerted = key;
      notify(`🔴 <b>price.pc.am refused a new PCN price from the exchange</b>\n` +
        `The exchange says ${usd6(reading.usd)}, a bigger jump from ${prev ? usd6(prev.nano / 1e9) : 'nothing'} ` +
        'than its own rules allow, so price.pc.am keeps the old price. ' +
        (indexMode() ? indexStakesPlain() : 'Nothing credits with the index yet.') + '\n' +
        'What to do: if you just re-seeded the PCN price, accept it with ' +
        '<code>POST /admin/index/accept</code> on the price primary. If you did not, find out why the ' +
        'exchange jumped before accepting anything -- it may be a bug or a break-in.\n' +
        `<i>tech: PCN index reading REFUSED ${indexTag()}: exchange $${reading.usd} (seq ${reading.seq}), ` +
        `kept $${prev ? prev.nano / 1e9 : 'none'} (seq ${prev ? prev.seq : '-'}); ${escHtml(speed.why)}</i>`);
    }
    try { save(st); } catch { /* the refusal is in memory and will be re-derived */ }
    return { ok: false, why: speed.why };
  }
  indexRefusalAlerted = null;
  st.indexRefused = null;
  st.indexState = reading.state;
  st.indexComputedAt = reading.computedAt;
  st.indexAt = nowMs;
  st.indexMeta = { lastMoveAt: reading.lastMoveAt ?? null, window: reading.window ?? null,
                   limitedBy: reading.limitedBy ?? [], reasons: reading.reasons ?? [],
                   rules: reading.rules ?? null };
  // 'unknown' and 'disabled' carry no price. They are relayed as states and
  // leave the last accepted price in place as the speed check's baseline --
  // they never erase it, and the published block shows no price for them.
  if (reading.nano !== null) {
    if (st.indexRebaseArmed) {
      notify(`🟢 <b>price.pc.am accepted the new PCN price ${usd6(reading.usd)}</b>\n` +
        'It is the new starting point for future checks.\n' +
        'What to do: nothing.\n' +
        `<i>tech: PCN index re-based ${indexTag()}: $${reading.usd} (seq ${reading.seq})</i>`);
      st.indexHistory = [];
    }
    st.indexNano = String(reading.nano);
    st.indexSeq = reading.seq;
    st.indexHistory = remember(st.indexHistory, { t: nowS, nano: reading.nano });
    st.indexRebaseArmed = false;
    // Step 4: the accepted index IS the credit rate.
    if (indexMode()) applyIndexRate(reading.usd);
  }
  if (indexMode()) announceIndexPriced(reading);
  try { save(st); } catch (e) { console.warn('[price] index reading not saved:', e.message); }
  return { ok: true, confirmed: true, state: reading.state };
}
if (ROLE === 'primary') {
  // Not awaited: unlike the ladder, nothing needs the index before the first
  // request, and a slow exchange must not hold the oracle's startup.
  pollIndex().catch(e => console.warn('[price] index poll threw:', e && e.message));
  setInterval(() => pollIndex().catch(e => console.warn('[price] index poll threw:', e && e.message)), 60000);
}

/** The `index` block of / and /price. null before the first poll. */
function indexBlock() {
  if (!st.indexState) return null;
  const ageS = st.indexComputedAt ? Math.floor(Date.now() / 1000) - st.indexComputedAt : null;
  const priced = ['held', 'live', 'frozen'].includes(st.indexState) && st.indexNano !== null;
  const m = st.indexMeta || {};
  return {
    usd: priced ? Number(st.indexNano) / 1e9 : null,
    state: st.indexState,
    seq: priced ? st.indexSeq : null,
    ageSeconds: ageS,
    stale: ageS === null || ageS > st.indexMaxAgeSeconds || (ROLE === 'replica' && !syncOk),
    lastMoveAt: m.lastMoveAt ?? null,
    window: m.window ?? null,
    limitedBy: m.limitedBy ?? [],
    reasons: m.reasons ?? [],
    refused: st.indexRefused ? { why: st.indexRefused.why, seq: st.indexRefused.seq, usd: st.indexRefused.usd } : null,
    inUse: indexMode(),
    source: st.indexUrl,
  };
}

function rollDay() {
  const d = today();
  if (st.day !== d) { st.day = d; st.soldToday = 0; }
}

/** USDT in -> PCN out. Fee is taken off the input, so the quote a caller sees
 *  is what they actually receive. */
function quoteBuy(usd) {
  if (!(usd > 0)) throw new Error('amount must be positive');
  const net = usd * (1 - st.feeBps / 10000);
  const newSupply = k() / (st.reserve + net);
  const pcn = st.supply - newSupply;
  return { pcn, effectivePrice: usd / pcn, newPrice: (st.reserve + net) / newSupply };
}

/** PCN in -> USDT out. */
function quoteSell(pcn) {
  if (!(pcn > 0)) throw new Error('amount must be positive');
  const newReserve = k() / (st.supply + pcn);
  const gross = st.reserve - newReserve;
  const usd = gross * (1 - st.feeBps / 10000);
  return { usd, effectivePrice: usd / pcn, newPrice: newReserve / (st.supply + pcn) };
}

function applyBuy(usd) {
  const q = quoteBuy(usd);
  const net = usd * (1 - st.feeBps / 10000);
  st.supply = k() / (st.reserve + net);
  st.reserve += net;
  return q;
}

function applySell(pcn) {
  rollDay();
  const q = quoteSell(pcn);
  if (st.soldToday + q.usd > st.dailySellCapUsd) {
    const e = new Error(`daily buyback cap reached ($${st.dailySellCapUsd}); ` +
                        `$${(st.dailySellCapUsd - st.soldToday).toFixed(2)} left today`);
    e.code = 429; throw e;
  }
  const newReserve = k() / (st.supply + pcn);
  st.supply += pcn;
  st.reserve = newReserve;
  st.soldToday += q.usd;
  return q;
}

/** Move the service rate toward the posted price, damped, rate-limited, capped.
 *
 *  This is the single most consequential function in the system. Customer
 *  balances across four products are denominated in `serviceRate`, so it must
 *  WALK, never jump -- someone who sweeps thirty rungs in one order moves the
 *  ladder +1,700% instantly, and the rate must not follow it there in one step.
 *
 *  Three separate brakes, and all three matter:
 *    - the +/-10% per-step clamp, which is about one rung
 *    - the minimum interval between steps, so polling every 60s does not turn
 *      "10% per step" into "10% per minute"
 *    - the hard ceiling, which is the ladder's terminal price
 *
 *  In index mode (useIndex = 1) there is no walk: the rate IS the index, set by
 *  pollIndex(), and a walk running beside it would pull it toward the ladder
 *  and the pool again. So it returns before touching anything -- not even the
 *  clock, which applyIndexRate() owns while the switch is on. */
function retuneServiceRate(force = false) {
  if (indexMode()) return { moved: false, target: null, serviceRate: st.serviceRate, indexMode: true };
  const target = retuneTarget();
  // A target that is not a usable number resolves nothing. Walking toward NaN
  // makes every comparison false and would silently freeze the rate forever
  // while reporting success.
  if (!(typeof target === 'number' && isFinite(target) && target > 0)) {
    return { moved: false, target, serviceRate: st.serviceRate, unusableTarget: true };
  }
  const waitMs = (st.serviceRetuneIntervalHours || 0) * 3600e3;

  // `serviceRateAt = 0` means UNKNOWN, not "go now". Treating it as "due"
  // defeated the interval entirely: after a restart with 0 on disk, EVERY 60s
  // poll was due, and the rate walked +10% a MINUTE -- 0.0011 to 0.015 in about
  // 27 steps. It stopped only because it hit the ladder price. That is verbatim
  // the failure the comment on serviceRetuneIntervalHours warns about, and it
  // happened because this line said `!st.serviceRateAt`.
  //
  // Unknown now means WAIT a full interval. The clock is started here so it can
  // never be unknown twice, and `force` (POST /admin/retune) stays the single
  // deliberate way to step immediately.
  if (!st.serviceRateAt) {
    st.serviceRateAt = Date.now();
    if (!force) {
      return { moved: false, target, serviceRate: st.serviceRate,
               armed: true, throttled: true };
    }
  }
  const due = force || (Date.now() - st.serviceRateAt) >= waitMs;
  if (!due) return { moved: false, target, serviceRate: st.serviceRate, throttled: true };

  // The ceiling is applied to the TARGET, before the clamp -- not after it.
  // Applied afterwards it overrides the clamp instead of being bounded by it,
  // so lowering serviceCeiling would drop the rate from 8.00 to 0.01 in a
  // single step: the one brake that is supposed to be absolute defeating the
  // one that is supposed to make it walk.
  const aim = Math.min(target, st.serviceCeiling);

  // A multiplicative clamp has zero as an absorbing state: at serviceRate = 0
  // both bounds are 0, every step computes 0, and the rate can never leave.
  // A floor gives it somewhere to stand.
  const from = st.serviceRate > 0 ? st.serviceRate : SERVICE_RATE_FLOOR;
  const max = from * (1 + st.serviceMaxMovePct / 100);
  const min = from * (1 - st.serviceMaxMovePct / 100);
  let next = Math.min(Math.max(aim, min), max);
  const moved = next !== st.serviceRate;
  // Stamp the clock only when a step actually happened. Otherwise a rate that
  // has already converged would keep resetting its own timer and the first real
  // move after a quiet week would be delayed by a full interval.
  if (moved) { st.serviceRate = next; st.serviceRateAt = Date.now(); }
  return { moved, target, serviceRate: next };
}

const json = (res, code, obj) => {
  const b = JSON.stringify(obj, null, 2);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
                        'Access-Control-Allow-Origin': '*' });
  res.end(b);
};

const body = req => new Promise(r => { let s = ''; req.on('data', c => { s += c; if (s.length > 1e5) req.destroy(); }); req.on('end', () => r(s)); });

function isAdmin(req) {
  const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!st.adminToken || !t) return false;
  const a = Buffer.from(t), b = Buffer.from(st.adminToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname.replace(/\/+$/, '') || '/';
  rollDay();
  try {
    // The credit rate, on its own, as text. No object, no second number, no
    // field to choose between -- the shape that cannot be integrated wrongly.
    // (The explorer publishes its supply figures the same way and for the same
    // reason: the smallest correct answer is the one nobody misreads.)
    //
    // It is deliberately NOT served when the feed is stale. A rate that may be
    // hours old is not a rate, and an integrator who gets 503 here holds the
    // credit instead of crediting at a number nobody stands behind -- which is
    // the estate's oldest rule: a failed read resolves nothing.
    //
    // In index mode the rate IS the index, so a remembered index is a
    // remembered rate. Once the index is older than indexMaxAgeSeconds -- or the
    // exchange says `unknown`, or it is switched off there -- this answers 503
    // and the rails hold (plan §2.4 and §2.6), rather than credit at the last
    // number while the one source of it cannot be heard.
    if (p === '/credit-rate') {
      const rate = st.serviceRate;
      if (!Number.isFinite(rate) || rate <= 0 || (ROLE === 'replica' && !syncOk)
          || (indexMode() && !indexUsable(indexBlock()))) {
        return res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8',
                                    'Cache-Control': 'no-store' })
          && res.end('unavailable\n');
      }
      return res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8',
                                  'Cache-Control': 'no-store' })
        && res.end(String(rate) + '\n');
    }

    if (p === '/' || p === '/price') {
      const ladderAgeS = st.ladderAt ? Math.floor((Date.now() - st.ladderAt) / 1000) : null;
      // Step 4 (useIndex = 1) changes exactly five things in this body, every
      // other byte is the legacy body: serviceRate/creditRateUsd carry the
      // index (set by pollIndex, not here), rateFollowsPoolDown is false, the
      // `ladder` block becomes the compatibility block (index-relay.mjs
      // indexLadder), `index.inUse` is true, and the `note` says what the price
      // now is. Same field names on purpose: seven rail codebases read them, and
      // renaming one would be nine deploys (plan §7). sellPriceUsd and `price`
      // stay what market.pc.am charges -- read from its ladder state exactly as
      // before, which after plan Step 3 is the index x (1 + premium).
      const ixMode = indexMode();
      const ix = indexBlock();
      return json(res, 200, {
        // The posted price is the ladder's marginal rung -- the price at which
        // the next PCN can actually be bought. `buybackPrice` is the AMM curve
        // and is what a sell-back pays; they are different numbers on purpose
        // and a consumer must not use one for the other.
        price: Number(postedPrice().toFixed(9)),
        serviceRate: st.serviceRate,

        // THE SAME TWO NUMBERS, NAMED BY WHAT THEY ARE FOR.
        //
        // `price` and `serviceRate` say what they ARE -- a ladder rung and a
        // tracked rate -- and an integrator reading the feed cold has to already
        // know which one credits a customer. One did not: contrib/wpcn-pay
        // credited from `price` for weeks, and `price` is the ONE number that
        // must never credit anything, because it is the ladder and the ladder
        // does not follow the pool down. That is precisely the leak the comment
        // at the top of this file describes -- buy wPCN cheap, redeem 1:1, spend
        // it at a rail crediting above the pool -- and crediting at `price`
        // re-opens it by hand.
        //
        // So the feed now also answers in the language of the question. Same
        // values, no new state, nothing to keep in step:
        //   creditRateUsd -- what you credit an INBOUND payment at. Always this one.
        //   sellPriceUsd  -- what a buyer PAYS us. Never credits anything.
        // The bare number alone is at GET /credit-rate, where there is nothing
        // to pick wrong.
        creditRateUsd: st.serviceRate,
        sellPriceUsd: Number(postedPrice().toFixed(9)),
        rateFieldToUse: 'creditRateUsd',
        // What the rate is tracking, and what is holding it up. Published
        // because "why is the credit rate below the ladder price" has to be
        // answerable from the feed itself, not from a server log.
        //
        // False in index mode: the pool is no input to the rate any more, and
        // this flag is what tells pcnaibot to demand a fresh pool reading.
        rateFollowsPoolDown: ixMode ? false : !!st.poolFollow,
        rateFloorUsd: st.poolFloorUsd,
        pool: st.poolFollow ? {
          spotUsd: st.poolPrice,
          medianUsd: st.poolMedian ?? null,
          windowHours: st.poolTwapHours,
          samples: st.poolSampleCount ?? 0,
          ageSeconds: st.poolAt ? Math.floor((Date.now() - st.poolAt) / 1000) : null,
          rateHeldAboveBy: st.poolHeldBy ?? null,
        } : null,
        // The exchange-anchored PCN index. In shadow (Phase 2) it is published
        // so it can be judged beside creditRateUsd, and `inUse` is false. In
        // index mode (Step 4) `inUse` is true and creditRateUsd IS this `usd`;
        // `stale` and `state` then say whether the rails may credit at all.
        index: ix,
        currency: 'USD',
        // BUYBACK. Every field below describes selling PCN back to us, and it
        // is CLOSED unless `buybackOpen` is true. When it is closed the price
        // is published as null rather than as a number, because a number here
        // is a quote -- and quoting a price for something you will not do is
        // the kind of honest-looking lie that ends in an argument with a
        // customer. The curve's own figures stay visible for transparency.
        buybackOpen: !!st.buybackOpen,
        buybackPrice: st.buybackOpen ? Number(price().toFixed(9)) : null,
        buybackRemainingToday: st.buybackOpen
          ? Number((st.dailySellCapUsd - st.soldToday).toFixed(2)) : 0,
        // reserve, poolSupply and feeBps USED TO BE PUBLISHED HERE and were
        // removed on 2026-09-17. They described the buyback desk's inventory
        // and spread, and that desk has been closed since 2026-09-09 -- so
        // `reserve` advertised a USDT float that is not there, `poolSupply`
        // (10,000,000) matched nothing real, and `feeBps` quoted a spread for
        // trades that cannot happen. The comment above already says why a
        // number here is a quote; these three were simply missed when
        // buybackPrice was fixed.
        //
        // Every consumer was checked first -- aicontrol, webai, webbuilderbot,
        // checker, pcnaibot, 3dmodels, 3dmodel, alik, pcnearner, market and
        // the exchange -- and not one of them read any of the three. If a
        // future integrator needs the curve's internals, publish them under a
        // name that says what they are, not under the old desk's vocabulary.
        //
        // In index mode this is the COMPATIBILITY block of plan §2.6: pcnaibot,
        // docs.pc.am integrations and the exchange's fetchSellPrice() all refuse
        // a feed unless ladder.stale === false, so the flag follows the INDEX
        // (the number they now credit at) and `price` is sellPriceUsd.
        ladder: ladderKnown() ? (ixMode ? indexLadder({
          block: ix, sellPriceUsd: Number(postedPrice().toFixed(9)),
          soldPcn: st.ladderSoldPcn, remainingPcn: st.ladderRemainingPcn,
        }) : {
          price: st.ladderPrice,
          soldPcn: st.ladderSoldPcn,
          remainingPcn: st.ladderRemainingPcn,
          ageSeconds: ladderAgeS,
          // Remembered rather than current. Still the best answer available --
          // but say so, rather than let a consumer assume it is fresh.
          stale: ladderAgeS === null || ladderAgeS > 600,
        }) : null,
        // Stated so nobody mistakes a posted price for a market price.
        // Taken from the same field the response publishes, never retyped: this
        // sentence and rateFloorUsd disagreeing would be worse than either alone.
        //
        // In index mode the note is rewritten (index-relay.mjs indexNote): the
        // price is the index of exchange.pc.am user-to-user fills, its caps,
        // floor and ceiling -- each read from what is enforced or relayed.
        note: ixMode ? indexNote({ floorUsd: st.poolFloorUsd, rules: (st.indexMeta || {}).rules,
                                   maxAgeS: st.indexMaxAgeSeconds, buybackOpen: !!st.buybackOpen }) :
              'Posted from a finite 100,000 PCN order-book ladder, not discovered on a market. ' +
              // "not exchange traded" stood here until 2026-09-24, long after
              // exchange.pc.am opened; the pc.am mini app shows this text to users.
              'PCN also trades on exchange.pc.am, a small order book the project runs, and its ' +
              'wrapped form wPCN trades in a small PancakeSwap ' +
              'pool. Until 2026-09-09 a keeper held that pool to THIS rate. It no longer ' +
              'defends parity: the pool is allowed to fall on real selling, and since ' +
              '2026-09-19 BOTH numbers here follow it down -- what services credit, and what ' +
              'PCN is sold for. Both stop at a published floor of $' + Number(st.poolFloorUsd).toFixed(4) + ', which ' +
              'is also where the keeper starts buying the pool back. The sale price is ' +
              're-anchored at most hourly, against a 6-HOUR MEDIAN rather than the spot, and ' +
              'by at most 8% in one step or 12% in a day; it is never RAISED by a pool read, ' +
              'and rises only when PCN is bought or spent. ' +
              // Both directions, deliberately. This field used to end by telling
              // holders their way out was to sell the pool -- a public API field,
              // read by every integrator, advertising only the exit. The pool is
              // thin enough that saying so shaped behaviour: wrap, dump, and the
              // keeper buys it back out of a small float. State the round trip.
              'The two forms convert both ways: PCN becomes wPCN at ' +
              'https://wrapdesk.pc.am, and wPCN becomes PCN through the token ' +
              "contract's redeem(). " +
              (st.buybackOpen
                ? 'Buying PCN back is a separate constant-product curve at a much lower price.'
                : 'This service is not buying PCN back at present.') +
              // Plain words, no code formatting: the mini app renders this note.
              ' The index block is shadow data from exchange.pc.am and must not be used for crediting yet.',
        role: ROLE,
        // A consumer can tell a fresh price from a remembered one. Both are
        // usable; only one is current, and pretending otherwise is how a stale
        // number gets treated as fact.
        stale: ROLE === 'replica' && !syncOk,
        // `0` on a replica that has NEVER synced would be the same value the
        // primary reports for "I am the source" — the freshest possible answer
        // standing in for the least fresh one. null says "never".
        stateAgeSeconds: ROLE !== 'replica' ? 0
                       : (lastSync ? Math.floor((Date.now() - lastSync) / 1000) : null),
        at: new Date().toISOString(),
      });
    }
    if (p === '/quote/buy')  return json(res, 200, quoteBuy(Number(u.searchParams.get('usd'))));
    if (p === '/quote/sell') return json(res, 200, quoteSell(Number(u.searchParams.get('pcn'))));

    if (p === '/execute' && req.method === 'POST') {
      // Two hosts accepting writes would diverge the curve, and there is no
      // merge for a divergent AMM. Only the primary moves it.
      if (ROLE !== 'primary') return json(res, 409, { error: 'this is a replica; write to the primary' });
      if (!isAdmin(req)) return json(res, 401, { error: 'admin token required' });
      const b = JSON.parse(await body(req));
      // The else arm is the destructive one, so an unrecognised side must not
      // reach it. 'BUY', 'bu', a missing field or a typo all used to route to
      // applySell and move the curve the wrong way.
      if (b.side !== 'buy' && b.side !== 'sell') {
        return json(res, 400, { error: `side must be exactly "buy" or "sell", got ${JSON.stringify(b.side)}` });
      }
      const r = b.side === 'buy' ? applyBuy(Number(b.usd)) : applySell(Number(b.pcn));
      const tune = retuneServiceRate();
      st.history.push({ at: new Date().toISOString(), side: b.side, ref: b.ref || null,
                        price: price(), reserve: st.reserve });
      st.history = st.history.slice(-500);
      save(st);
      return json(res, 200, { ok: true, ...r, price: price(), ...tune });
    }

    if (p === '/admin/state' && req.method === 'POST') {
      // Two hosts accepting writes would diverge the curve, and there is no
      // merge for a divergent AMM. Only the primary moves it.
      if (ROLE !== 'primary') return json(res, 409, { error: 'this is a replica; write to the primary' });
      if (!isAdmin(req)) return json(res, 401, { error: 'admin token required' });
      const b = JSON.parse(await body(req));
      // Bare Number() accepted NaN, Infinity and negatives on nine fields that
      // decide how much money customers are credited. A typo in an admin call
      // should be a 400, not a silently poisoned oracle -- and NaN is
      // especially nasty here because every comparison against it is false, so
      // the clamp stops clamping without ever reporting a problem.
      //
      // serviceRateAt is settable so an operator can re-arm the walk: setting
      // it to 0 makes the next step due immediately instead of an interval away.
      const BOUNDS = {
        reserve:                    { min: 0,  max: 1e12 },
        supply:                     { min: 1e-8, max: 1e15 },
        feeBps:                     { min: 0,  max: 10000 },
        dailySellCapUsd:            { min: 0,  max: 1e9 },
        serviceRate:                { min: 0,  max: 1e6 },
        serviceMaxMovePct:          { min: 0,  max: 100 },
        serviceCeiling:             { min: 0,  max: 1e6 },
        serviceRetuneIntervalHours: { min: 0,  max: 8760 },
        serviceRateAt:              { min: 0,  max: 4e12 },
        indexMaxAgeSeconds:         { min: 60, max: 3600 },
        // THE SWITCH (plan Step 4). An integer, not a truthy value: 0.5, true
        // or "yes" is a typo, and a typo must not decide what every rail
        // credits at.
        useIndex:                   { min: 0,  max: 1, int: true },
      };
      const pending = {};
      for (const [key, bound] of Object.entries(BOUNDS)) {
        if (b[key] === undefined) continue;
        const n = Number(b[key]);
        if (!isFinite(n) || n < bound.min || n > bound.max || (bound.int && !Number.isInteger(n))
            || (bound.int && typeof b[key] !== 'number')) {
          return json(res, 400, {
            error: `${key} must be ${bound.int ? 'an integer' : 'a finite number'} in [${bound.min}, ${bound.max}], got ${JSON.stringify(b[key])}` });
        }
        pending[key] = n;
      }

      // Switching the rails onto the index is REFUSED unless the plan's Step 4
      // precondition holds right now (index-relay.mjs switchCheck): a fresh,
      // priced, unrefused index; the walk within 0.5% of it; market.pc.am
      // selling at or above it. `"force": true` skips the last two only.
      // Switching back off is never refused -- it is the rollback, and the
      // walk resumes from the index's value without a jump.
      const wasIndex = indexMode();
      const toIndex = pending.useIndex === undefined ? wasIndex : pending.useIndex === 1;
      let check = null;
      if (toIndex && !wasIndex) {
        check = switchCheck({ block: indexBlock(), serviceRate: st.serviceRate,
                              sellPriceUsd: ladderKnown() ? st.ladderPrice : null, force: b.force === true });
        if (!check.ok) return json(res, 409, { error: check.why, check });
      }
      // While the rails credit at the index, a hand-typed rate would be
      // published for up to a minute and then silently overwritten. The rate
      // IS the index; to set one by hand, switch off in the same call.
      if (toIndex && (pending.serviceRate !== undefined || pending.serviceRateAt !== undefined)) {
        return json(res, 409, { error: 'serviceRate follows the PCN index while useIndex is 1; ' +
          'send {"useIndex":0} with it to set the rate by hand' });
      }

      const beforeRate = st.serviceRate;
      Object.assign(st, pending);       // all-or-nothing: never a half-applied write
      if (toIndex && !wasIndex) {
        // Applied now rather than at the next poll, so the switch's own answer
        // (and every origin within one sync) already shows the index. Quiet:
        // the switch alert below says it once, with the precondition's numbers.
        applyIndexRate(indexBlock().usd, { quiet: true });
      }
      if (wasIndex !== toIndex) { underPending = null; underPolls = 0; underAnnounced = false; }
      save(st);
      if (toIndex && !wasIndex) {
        notify('🟢 <b>Payment services now credit at the exchange\'s PCN price</b>\n' +
          `The credit rate went ${usd6(beforeRate)} → ${usd6(st.serviceRate)}. From now on it follows the ` +
          'PCN price on exchange.pc.am, and nothing else moves it.' +
          (check.forced ? ' <b>This was FORCED past the safety checks.</b>' : '') + '\n' +
          'What to do: nothing. To undo: <code>POST /admin/state {"useIndex":0}</code> on the price primary.\n' +
          `<i>tech: The rails now credit at the PCN index; serviceRate ${beforeRate} → ${st.serviceRate} ` +
          `(index seq ${st.indexSeq}; the walk was ${check.gapPct}% away)</i>`);
      } else if (wasIndex && !toIndex) {
        notify('🟡 <b>Payment services are back on the old credit rate rule</b>\n' +
          `The credit rate no longer follows the exchange's PCN price. It stays at ${usd6(st.serviceRate)} ` +
          `and starts moving on its own again after ${st.serviceRetuneIntervalHours} h.\n` +
          'What to do: nothing, if you switched it back on purpose.\n' +
          `<i>tech: The rails are back on the legacy walk, from ${st.serviceRate}</i>`);
      }
      return json(res, 200, { ok: true, price: postedPrice(), applied: pending,
        ...(wasIndex !== toIndex ? { useIndex: toIndex ? 1 : 0, serviceRate: st.serviceRate, check } : {}) });
    }

    // Force one retune step now, ignoring the interval but NOT the +/-10% clamp
    // or the ceiling. This is the operator's throttle for the walk from 0.001 to
    // the ladder price: call it repeatedly to advance a step at a time, and
    // watch four products' credit rates move with it.
    if (p === '/admin/retune' && req.method === 'POST') {
      if (ROLE !== 'primary') return json(res, 409, { error: 'this is a replica; write to the primary' });
      if (!isAdmin(req)) return json(res, 401, { error: 'admin token required' });
      // There is no walk to step while the rails credit at the index, and an
      // answer of `moved: false` would read as "already converged".
      if (indexMode()) {
        return json(res, 409, { error: 'the credit rate follows the PCN index (useIndex is 1); there is no ' +
          'walk to step. POST /admin/state {"useIndex":0} to go back to it.' });
      }
      // Refresh the ladder FIRST. Retuning against a ladder price that is up to
      // a minute old steps the rate toward a number the market has already left
      // behind -- and an operator pressing this expects "use what the ladder
      // says now", not "use what it said last minute". pollLadder does the
      // retune itself, so this is one step, not two.
      const before = st.serviceRate;
      const poll = await pollLadder(true);
      // pollLadder swallows its own failures, so `ok: true, moved: false` used
      // to be byte-identical whether the ladder had been read and the rate was
      // simply already converged, or the read had failed and nothing happened
      // at all. Those are different facts and the operator needs to tell them
      // apart -- this is the button they press when something looks wrong.
      if (!poll.ok) {
        return json(res, 503, { ok: false, moved: false, from: before,
                                serviceRate: st.serviceRate,
                                error: `ladder could not be read: ${poll.why}` });
      }
      return json(res, 200, { ok: true, moved: st.serviceRate !== before,
                              from: before, serviceRate: st.serviceRate,
                              target: retuneTarget(), price: postedPrice() });
    }

    // After a DELIBERATE re-seed on the exchange, the speed check refuses the
    // new value -- correctly, since it moved faster than any fill can move it.
    // This is the operator saying "that jump was me": the next reading two polls
    // agree on becomes the new baseline, whatever it is (inside floor/ceiling).
    if (p === '/admin/index/accept' && req.method === 'POST') {
      if (ROLE !== 'primary') return json(res, 409, { error: 'this is a replica; write to the primary' });
      if (!isAdmin(req)) return json(res, 401, { error: 'admin token required' });
      st.indexRebaseArmed = true;
      save(st);
      return json(res, 200, { ok: true, armed: true, refused: st.indexRefused,
        note: 'the next reading two polls agree on becomes the baseline' });
    }

    // Full curve state, so a replica can mirror it. Public: it is the same
    // numbers /price already exposes, just complete.
    if (p === '/state') {
      // ALLOWLIST, not a denylist. This endpoint is public through Cloudflare,
      // and a denylist of one key was publishing `upstream` — the primary's
      // real origin IP, which the proxy exists to hide — together with the SNI
      // and the exact key pin a replica authenticates it with. Anything added
      // to the state in future is private until it is named here.
      //
      // One flat list. The pool keys used to sit in a loop nested INSIDE the
      // main one, which copied them seventeen times over and read as though
      // they were conditional on something.
      //
      // The pool SAMPLES and the index HISTORY stay behind: both are arrays
      // that grow with uptime, and a payload that grows is how a working sync
      // breaks months later against the 256 KB ceiling. Replicas publish the
      // primary's conclusions; only the primary needs the raw memory.
      const PUBLIC_STATE = [
        'reserve','supply','feeBps','dailySellCapUsd','serviceRate',
        'serviceMaxMovePct','serviceCeiling','serviceRetuneIntervalHours',
        'serviceRateAt','ladderPrice','ladderAt','ladderSoldPcn',
        'ladderRemainingPcn','soldToday','day','history','role',
        'poolFollow','poolPrice','poolAt','poolMedian','poolHeldBy',
        'poolSampleCount','poolFloorUsd','poolTwapHours','poolWpcn','poolUsdt',
        'indexUrl','indexMaxAgeSeconds','indexState','indexNano','indexSeq',
        'indexComputedAt','indexAt','indexMeta','indexRefused','indexError',
        // The replicas serve most traffic and build their own responses from
        // this list. Without the switch here they would keep publishing the
        // legacy body -- rateFollowsPoolDown true, the market-clock `ladder` --
        // around a serviceRate that is already the index.
        'useIndex',
      ];
      const pub = {};
      for (const kk of PUBLIC_STATE) if (st[kk] !== undefined) pub[kk] = st[kk];
      return json(res, 200, pub);
    }

    if (p === '/history') return json(res, 200, { history: st.history.slice(-100) });
    return json(res, 404, { error: 'not found', endpoints: ['/price','/quote/buy?usd=','/quote/sell?pcn=','/history'] });
  } catch (e) {
    return json(res, e.code || 400, { error: e.message });
  }
}).listen(PORT, '127.0.0.1', () => console.log(`pcoin-price on 127.0.0.1:${PORT}`));
