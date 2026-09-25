#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// market.pc.am — buy PCN with crypto (NOWPayments), sell PCN back.
// ═══════════════════════════════════════════════════════════════════════════
//
// THE ONE RULE THAT MATTERS HERE
// Every other PCoin service is watch-only and its worst bug fails to CREDIT
// someone. This one SENDS coins, so its worst bug sends them to a stranger and
// nothing gets them back. Three consequences run through the whole file:
//
//   1. An IPN is not trusted until its HMAC-SHA512 signature verifies against
//      the IPN secret. An unverified callback endpoint is a mint: anyone who
//      learns the URL can claim they paid.
//   2. One payment, one order, one send. ipn.mjs ties each order to the
//      NOWPayments payment that paid it (orders.paid_payment_id, UNIQUE) and
//      never pays another payment on it automatically; delivery.mjs records
//      its claim on the order before it spends. NOWPayments retries callbacks;
//      a retry must never send twice.
//   3. The destination address is validated LOCALLY (bech32 checksum + `pc`
//      hrp) before an order is accepted, not after taking the money.
//
// LIMITS
//   Every limit is a LIVE SETTING in the admin panel, not a constant -- see
//   settings.mjs. Hardcoding them here is how this comment came to advertise a
//   $10 minimum long after it became $20.
//
// PAYOUTS ARE AUTOMATIC BELOW `autoMaxUsd`, AND THERE IS A SPENDING KEY ON THIS
// BOX. This paragraph used to say the opposite -- that nothing is sent
// automatically and no spending key is present -- and both stopped being true
// when auto-send shipped. A confirmed purchase at or below the limit is signed
// and broadcast by this process from the `market-hot` wallet, usually within a
// minute; anything larger is queued for a human and sent from a wallet that has
// never been online. The float is what bounds the loss from a break-in here,
// which is why it is kept small and why delivery.mjs is the only file that can
// spend.

import { createServer } from 'node:http';
import { createHmac, randomBytes, timingSafeEqual, scryptSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';

const CFG   = '/opt/pcoin-market/config.json';
const DB    = '/opt/pcoin-market/db.json';
const PORT  = 8789;
const PRICE = 'http://127.0.0.1:8788';
const SELL_CAP_USD_PER_DAY = 20;

// Order limits, the auto-send cutoff, the float levels and the buyback switch
// are LIVE SETTINGS now, not constants -- see settings.mjs for what each one
// means and its safe range, and the admin panel for changing them. Two of them
// exist for reasons worth keeping in view:
//
//   maxOrderUsd / maxPendingOrders — a reservation is free and lasts until the
//   sweeper runs. With no ceiling on order size and no limit on concurrent
//   unpaid orders, one signed-up account could POST /api/buy for the whole
//   ladder, reserve all 100,000 PCN, never pay, and take the market offline for
//   a day at zero cost, repeatedly. Neither limit is about revenue; both are
//   about how much inventory an unproven promise may hold hostage.
//
//   buybackOpen — selling PCN back is the only path here that pays money OUT,
//   and it is the least exercised: one shared deposit address, attribution by
//   amount and timing done by hand, and a payout released manually against a
//   curve the market never actually drives. It is off while the ladder is
//   proven with real buyers. Nothing underneath was deleted, so re-opening it
//   is one switch in the panel.

const cfg = JSON.parse(readFileSync(CFG, 'utf8'));

// ── hCaptcha on the account forms ──────────────────────────────────────────
//
// Accounts are about to become a QUOTA KEY: a signed-in market account raises
// the wrap desk's per-person limit well above the anonymous one. That only
// holds if an account costs something to create. Signup is the vector that
// matters here -- mass free accounts would defeat the quota outright -- and
// login gets the same check because credential stuffing is the other cheap
// automated attack on this form.
//
// Signup does NOT verify the email address, so without this an account costs a
// made-up string. That is the gap this closes.
//
// Unset -> skipped, and the startup banner says so LOUDLY. A form that shows a
// captcha nobody checks is worse than no captcha, so the widget is injected
// only when a sitekey exists (see the HCAPTCHA marker in index.html).
// ── single sign-on for the wrap desk ───────────────────────────────────────
// Deliberately NOT cfg.sessionSecret -- see the /sso/wrapdesk route for why.
// Absent secret disables the route rather than falling back to another key.
const SSO_ON = Boolean(cfg.ssoSecret);
const SSO_RETURN_OK = cfg.ssoReturnPrefixes || ['https://wrapdesk.pc.am/'];
const HCAPTCHA_SITEKEY = cfg.hcaptchaSitekey || '';
const HCAPTCHA_SECRET  = cfg.hcaptchaSecret  || '';
const HCAPTCHA_ON = Boolean(HCAPTCHA_SITEKEY && HCAPTCHA_SECRET);

// The SLOT only. The script that fills it is loaded by the page, lazily, the
// first time the sign-in panel is actually shown (see ensureCaptcha() in
// index.html). Emitting the <script> here meant every visitor -- including
// every signed-in one, on every refresh -- fetched js.hcaptcha.com and watched
// a checkbox render into a panel that was about to be hidden.
//
// The page detects "captcha configured" by the presence of this div, so when
// HCAPTCHA_ON is false nothing is emitted and the button is never gated.
const HCAPTCHA_TAG = HCAPTCHA_ON
  ? '<div class="h-captcha" data-sitekey="' + HCAPTCHA_SITEKEY + '" style="margin:.8rem 0"></div>'
  : '';

// Returns {ok} or {ok:false, why}. 'unreachable' is deliberately distinct from
// 'rejected': one is an answer, the other is not having asked.
async function hcaptchaVerdict(token, ip) {
  if (!token) return { ok: false, why: 'missing' };
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 10_000);
  try {
    const b = new URLSearchParams({ secret: HCAPTCHA_SECRET, response: token });
    if (ip) b.set('remoteip', ip);
    const r = await fetch('https://api.hcaptcha.com/siteverify',
      { method: 'POST', body: b, signal: c.signal });
    if (!r.ok) return { ok: false, why: 'unreachable' };
    const j = await r.json();
    return j.success ? { ok: true } : { ok: false, why: 'rejected' };
  } catch {
    return { ok: false, why: 'unreachable' };
  } finally { clearTimeout(t); }
}

// One gate for both forms. FAILS CLOSED, including when hCaptcha itself cannot
// be reached: "we could not check" is not "you passed". The cost is real and
// worth stating -- an hCaptcha outage stops new sign-ins until it recovers.
// The alternative is an outage that silently disables the control instead, and
// on the form that guards a quota key that is the worse of the two.
async function captchaGate(req, res, f) {
  if (!HCAPTCHA_ON) return true;
  const v = await hcaptchaVerdict(f['h-captcha-response'], clientIp(req));
  if (v.ok) return true;
  json(res, v.why === 'unreachable' ? 503 : 400, {
    error: v.why === 'unreachable'
      ? 'the anti-bot check is unreachable right now — nothing is wrong with your details, please try again shortly'
      : 'please complete the "I am human" check and try again',
  });
  return false;
}

// Small pool: this box also runs a node and an explorer, and the market is not
// the thing that should exhaust its memory.
const pool = mysql.createPool({
  ...cfg.db, waitForConnections: true, connectionLimit: 8, queueLimit: 0,
  // DECIMAL comes back as a string by default, which is correct -- turning a
  // money column into a float is how rounding errors get into ledgers.
  decimalNumbers: false,
});
const q = async (sql, args = []) => (await pool.query(sql, args))[0];


// ── bech32, locally ────────────────────────────────────────────────────────
// Validated here rather than by asking the explorer: an integration that trusts
// a remote service to reject bad input is one outage from accepting money for
// an address that cannot receive it.
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
function polymod(v) {
  let chk = 1;
  for (const x of v) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ x;
    for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}
function hrpExpand(h) {
  const a = [], b = [];
  for (const c of h) { a.push(c.charCodeAt(0) >> 5); b.push(c.charCodeAt(0) & 31); }
  return [...a, 0, ...b];
}
/** Strips whitespace and the invisible characters that survive a copy-paste
 *  from a chat window, spreadsheet or PDF. A zero-width space inside an address
 *  is impossible to see and rejects a perfectly good address, leaving the
 *  customer staring at a field that looks exactly right. */
export function cleanAddress(s) {
  return String(s ?? '').replace(/[\s​-‏⁠﻿]/g, '');
}

function validAddress(addr) {
  if (typeof addr !== 'string') return false;
  const s = cleanAddress(addr);
  if (s.length < 14 || s.length > 90) return false;
  if (s !== s.toLowerCase() && s !== s.toUpperCase()) return false;
  const l = s.toLowerCase();
  const pos = l.lastIndexOf('1');
  if (pos < 1) return false;
  const hrp = l.slice(0, pos);
  if (hrp !== 'pc') return false;                 // reject bc1…, tb1… on the hrp
  const data = [];
  for (const c of l.slice(pos + 1)) {
    const i = CHARSET.indexOf(c);
    if (i < 0) return false;
    data.push(i);
  }
  if (data.length < 6) return false;
  const chk = polymod([...hrpExpand(hrp), ...data]);
  return chk === 1 || chk === 0x2bc830a3;         // bech32 or bech32m
}

// ── the PCN index (price plan Step 3) ──────────────────────────────────────
// With `pricingMode = index` every PCN is sold at the PCN index from
// exchange.pc.am x (1 + marketPremiumPct/100) -- the owner's one anchor, "the
// average price of real trading on exchange.pc.am" (2026-09-24). The market
// does not read the exchange itself. price.pc.am's primary, on THIS box, already
// polls it every 60 s and checks each reading on its own terms -- fresh on its
// own clock, two polls agreeing, a speed cap per step and per day, the floor and
// ceiling (contrib/price/index-relay.mjs) -- and publishes what it accepted as
// the `index` block of /price. One checked number, not two readers that could
// come to disagree.
//
// Cached, refreshed every 30 s, and read SYNCHRONOUSLY by ladder.mjs on every
// quote. A failed refresh resolves NOTHING: the last reading stays, and
// getIndex() adds the time since it was taken to its age, so an unreachable
// relay turns the reading stale on its own and, past indexMaxAgeSeconds, the
// market closes. It never keeps selling on a number nobody is confirming.
//
// Declared ABOVE makeLadder on purpose. The price watch below calls
// ladderState() while this module is still evaluating -- across its top-level
// awaits -- and a `let` declared further down would still be in its temporal
// dead zone when that call lands. This file has been caught by that ordering
// more than once already (see the notes at makeLadder and at watchGate).
const INDEX_URL = `${PRICE}/price`;
const INDEX_REFRESH_MS = 30_000;
let _index = { block: null, at: 0, error: 'not read yet' };
let _indexLoggedError = null;
async function refreshIndex() {
  try {
    const r = await fetch(INDEX_URL, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { said: `price.pc.am answered HTTP ${r.status}` });
    const j = await r.json();
    const b = j && j.index;
    // No index block is an ANSWER, not a failure: the relay is up and has no
    // index to give. The old reading is dropped rather than aged, because the
    // relay has just said it no longer vouches for it.
    _index = (b && typeof b === 'object')
      ? { block: { usd: b.usd, state: b.state, seq: b.seq, ageSeconds: b.ageSeconds, stale: b.stale },
          at: Date.now(), error: null }
      : { block: null, at: Date.now(), error: 'price.pc.am publishes no index' };
  } catch (e) {
    // The text reaches the public gate reason, so it names the service, never
    // the loopback address or port.
    const said = e.said || (e.name === 'TimeoutError' ? 'price.pc.am did not answer within 5 s'
                                                      : 'price.pc.am could not be read');
    _index = { ..._index, error: said };
    if (_indexLoggedError !== said) console.warn('[index]', said, '--', e.message);
  }
  // Transitions only: a relay that stays down must not write a line every 30 s.
  if (_index.error !== _indexLoggedError) {
    if (!_index.error) console.log('[index] readable again');
    _indexLoggedError = _index.error;
  }
}
/** The last index reading, aged to NOW. Synchronous: ladder.mjs prices with it. */
function getIndex() {
  const b = _index.block;
  if (!b) return { state: null, error: _index.error };
  const since = (Date.now() - _index.at) / 1000;
  const relayAge = (b.ageSeconds === null || b.ageSeconds === undefined) ? NaN : Number(b.ageSeconds);
  return { usd: b.usd, state: b.state, seq: b.seq, stale: b.stale,
           ageSeconds: Number.isFinite(relayAge) ? relayAge + since : null,
           error: _index.error };
}
// Awaited once, so the first quote after a restart is not refused for want of
// a read that was about to land. Bounded by the 5 s timeout and it cannot
// throw; a relay that is down only means the market starts closed in index
// mode, which is the correct state for it to be in.
await refreshIndex();
setInterval(() => { refreshIndex().catch(() => {}); }, INDEX_REFRESH_MS).unref?.();

// ── the ladder ─────────────────────────────────────────────────────────────
// The engine lives in ladder.mjs so it can be exercised against a real database
// without starting an HTTP server or touching NOWPayments. The race it has to
// survive -- two buyers landing on one rung -- is the same race the $20/day cap
// already lost once when it was a JSON file, and an engine you cannot run in
// isolation is an engine nobody re-tests after changing it.
import { makeLadder } from './ladder.mjs';
import { makeWaivers, lossOnSpendPct } from './waivers.mjs';
// The notifier is passed in so a failing reservation sweep can say so; without
// it the ladder silently stops returning inventory from unpaid orders.
//
// Wrapped in an arrow, NOT passed directly: `notify` is declared further down
// this file, so `{ notify }` here reads it during module evaluation and throws
// "Cannot access 'notify' before initialization" — which took the whole market
// offline for the length of one deploy. The arrow defers the read to call time,
// by which point the binding exists. (Same class of mistake as the CSRF-reject
// path and the gate watcher above; the file's ordering makes it easy to repeat.)
// `getSetting` is a function for the same reason `notify` is: S is declared
// below, so passing the binding itself would throw at startup.
const L = makeLadder(pool, { notify: (...args) => notify(...args),
                             getSetting: k => S.get(k), getIndex });
setInterval(L.sweepExpiredOrders, 15 * 60 * 1000).unref?.();
const W = makeWaivers(pool);
await W.ensureTable();

// ── settings ───────────────────────────────────────────────────────────────
// Loaded BEFORE delivery, because delivery reads its limits from here. Awaited
// at module scope on purpose: starting the HTTP server with defaults and
// swapping them in a moment later would mean the first request after a restart
// could be answered under limits nobody chose.
import { makeSettings } from './settings.mjs';
const S = makeSettings(pool);
await S.ensureTable();
await S.reload();
// Re-read periodically so a change made in the panel reaches this process even
// if it was made against another worker or straight in the database.
setInterval(() => S.reload(), 30_000).unref?.();

// ── delivery ───────────────────────────────────────────────────────────────
import { makeNodeRpc, makeDelivery, makeBacking } from './delivery.mjs';
import { makeNotifier, readNotifyConfig } from './notify.mjs';
import { clientIp } from './clientip.mjs';
import { geoFor, geoLine, ensureSchema as ensureGeoSchema } from './geoip.mjs';
import { makeIpn, readRawBody, REQUIRED_COLUMNS } from './ipn.mjs';

// Settings are read at CALL time, not captured here: the key can be rotated
// and the feature switched off from the admin panel without a restart.
const geoOpts = () => ({ q, key: S.get('geoipKey'), base: S.get('geoipBaseUrl'),
                         enabled: S.get('geoipEnabled'), log: console });


const alertCfg = readNotifyConfig('/etc/pcoin/alert.conf');
const notify = makeNotifier({
  token: alertCfg.TELEGRAM_TOKEN,
  chatId: cfg.telegramChatId || alertCfg.MARKET_CHAT || alertCfg.ALERT_CHAT,
  prefix: '<b>market.pc.am</b>',
});

// `rpcAuth` in config.json is the least-privilege identity — see makeNodeRpc.
// In production it is set and the cookie is unreadable by this process; the
// cookie fallback exists so a developer can run this locally without one.
const node = makeNodeRpc({
  url: cfg.nodeRpcUrl || 'http://127.0.0.1:9443',
  cookiePath: cfg.nodeCookie || '/var/lib/pcoin/.cookie',
  walletName: cfg.hotWallet || 'market-hot',
  rpcAuth: cfg.rpcAuth || null,
});

const D = makeDelivery({ pool, node, notify, settings: S });
const B = makeBacking({
  pool,
  explorerUrl: cfg.explorerUrl || 'https://explorer.pc.am',
  ownerAddress: cfg.ownerAddress,
  settings: S,
  floatBalance: () => D.floatBalance(),
  // Without this, every way the market can STOP SELLING was silent: an
  // explorer outage, one unreadable backing address, or a node restart pauses
  // sales and the first signal was noticing the takings had stopped.
  notify,
});

// ── price watch ────────────────────────────────────────────────────────────
// Announce every move of the published ladder price. Deliberately a watcher on
// the number itself rather than an alert bolted to each thing that can move it
// — see pricewatch.mjs for why that distinction is load-bearing.
import { makePriceWatch } from './pricewatch.mjs';
const PW = makePriceWatch({ pool, ladder: L, notify });
setInterval(() => PW.check().catch(e => console.error('[pricewatch]', e.message)), 60_000).unref?.();
PW.check().catch(e => console.error('[pricewatch]', e.message));

// ── is the market open? ─────────────────────────────────────────────────────
// saleGate() can shut the market for four different reasons — the operator
// switch, a sold-out ladder, an unreadable rate oracle, or the ladder and
// serviceRate drifting apart — and it told NOBODY. It is consulted only from
// request handlers, so with no traffic nothing even calls it, and "closed" and
// "quiet" look identical from the outside. The first sign was the takings
// stopping.
//
// Polled rather than hooked into the handlers for exactly that reason: a
// closure at 3am with zero visitors must still reach the operator. Only
// TRANSITIONS are announced, so a market that stays shut does not nag.
let lastGateOpen = null;
async function watchGate() {
  let g;
  try { g = await saleGate(); }
  catch (e) { console.error('[gatewatch]', e.message); return; }
  if (lastGateOpen === null) {                    // first look after a restart
    const [r] = await q(`SELECT v FROM market_state WHERE k='saleGateOpen'`).catch(() => [[]]);
    lastGateOpen = r?.[0] ? r[0].v === '1' : g.open;
  }
  if (g.open === lastGateOpen) return;
  lastGateOpen = g.open;
  await q(`INSERT INTO market_state (k,v) VALUES ('saleGateOpen',?)
             ON DUPLICATE KEY UPDATE v=VALUES(v)`, [g.open ? '1' : '0']).catch(() => {});
  await notify(g.open
    ? `🟢 <b>Sales have REOPENED</b>\nThe market is accepting orders again.`
    : `🔴 <b>SALES ARE PAUSED</b>\nmarket.pc.am is refusing every order.\n${esc(g.reason || 'no reason given')}`
  ).catch(e => console.error('[gatewatch] alert failed:', e.message));
}
setInterval(() => watchGate(), 60_000).unref?.();
// Deferred, not immediate: `esc` and the settings this reads are declared
// further down the file, so calling it during module evaluation would throw a
// ReferenceError out of its temporal dead zone. Five seconds is after the
// module has finished evaluating and long before anyone needs the answer.
setTimeout(watchGate, 5_000).unref?.();

// Every 10 minutes: nag if the float is low, and rescue anything stuck between
// "claimed for sending" and "recorded as sent".
setInterval(() => { D.checkFloat(); D.reconcileSending(); }, 10 * 60 * 1000).unref?.();

/** How much PCN this account has already bought inside the rolling window.
 *
 *  Counts everything that is still a live claim or a completed sale — pending,
 *  paid, delivered, under review. Orders that expired, failed or were refunded
 *  released their coins, so they do not count against anyone.
 *
 *  `lock` matters for exactly the reason the sell cap's did: under REPEATABLE
 *  READ a plain SELECT inside a transaction reads the snapshot from when the
 *  transaction opened, so two orders placed together would both see the old
 *  total and both pass. A cap that only holds when nobody is in a hurry is not
 *  a cap. */
async function accountBoughtPcn(email, conn = pool, lock = false) {
  const [r] = await conn.query(
    `SELECT COALESCE(SUM(quoted_pcn),0) AS t FROM orders
      WHERE email = ?
        AND created_at >= (NOW() - INTERVAL ? DAY)
        AND status IN ('pending','awaiting_delivery','sending','delivered','needs_review')` +
    (lock ? ' FOR UPDATE' : ''),
    [email, S.get('accountCapDays')]);
  return Number(r[0].t);
}

/** The per-order cap, expressed in COINS rather than dollars.
 *
 *  A dollar cap is not one limit, it is a different limit at every point on the
 *  ladder: $2,000 buys 56,660 PCN at the $0.001 floor -- 57% of the entire
 *  inventory -- and about 200 PCN once the price reaches $10. The scarce thing
 *  here is coins, so that is what gets capped.
 *
 *  Returns an error string, or null if the order is fine. The dollar equivalent
 *  is computed against the live rungs so the buyer is told a real number rather
 *  than "too big". */
function tooMuchPcn(rungs, pcn) {
  const cap = S.get('maxOrderPcn');
  if (!(pcn > cap)) return null;
  const atCap = L.walkPcn(rungs, cap);
  return `the most one order may take is ${cap.toLocaleString()} PCN — about ` +
         `$${atCap.cost.toFixed(2)} at today's prices. Larger holdings are built up over ` +
         (S.get('pricingMode') === 'index'
           ? `several orders, so no single buyer takes the whole stock at once.`
           : `several orders, so no single buyer takes the ladder at the floor.`);
}

// ── retire-on-spend ────────────────────────────────────────────────────────
// Watches the chain for customers paying the services and withdraws a share of
// the ladder from sale, so real usage lifts the price. Every 10 minutes: often
// enough to track demand, far less often than blocks arrive, and the scan is
// idempotent so a missed run costs nothing but lag.
import { makeRetire } from './retire.mjs';
// Constant-product pricing. Pure functions; nothing here can spend or
// reserve. The ladder itself now prices on this curve (ladder.mjs);
// this import is kept so anything here can compute a quote without
// going through the database.
import * as AMM from './amm.mjs';
const R = makeRetire({ pool, node, settings: S, notify });
setInterval(() => R.scan().catch(e => console.error('[retire]', e.message)),
            10 * 60 * 1000).unref?.();

// ── admin panel ────────────────────────────────────────────────────────────
import { makeAdmin } from './admin.mjs';
import { opsSendPcn } from './ops-send.mjs';
const ADMIN = makeAdmin({ pool, cfg, settings: S, ladder: L, delivery: D, backing: B,
                          waivers: W, notify });
await ADMIN.ensureTable();

// ── the divergence interlock ───────────────────────────────────────────────
// Selling PCN off the ladder is only honest while the four products credit PCN
// at something close to the ladder's price. If they drift apart, a customer can
// buy a coin here for one price and have it accepted over there at another --
// and the gap is unbounded, because the ladder runs to $10.00 while the credit
// rate walks at 10% an hour and could be pinned by a fault.
//
// It is pinned right now. `price.pc.am` is answered by an origin we have not
// been able to identify, running older code whose upstream is `price.pc.am`
// itself, so it mirrors its own state and has never seen the primary. It sits
// at the 0.001 floor. The error direction is in the customer's disfavour --
// they are credited LESS than their PCN is worth, never more -- but that is not
// a reason to keep selling into it.
//
// So the interlock compares the ladder against the rate the PRODUCTS actually
// read, which is the PUBLIC url, not this box's loopback oracle. Those are
// different services and that distinction is the entire point: the loopback one
// is correct and nobody consumes it.
//
// It is self-clearing. Nothing needs to be remembered to turn selling back on:
// when the oracle is fixed and serviceRate catches up, sales resume by
// themselves.
const PUBLIC_RATE_URL   = 'https://price.pc.am/price';
const RATE_CACHE_MS      = 30_000;    // do not hammer Cloudflare on every keystroke
const RATE_MAX_AGE_MS    = 300_000;   // past this a remembered rate is refused, not used

// price.pc.am does NOT answer with one voice. It is Cloudflare-proxied across
// several origins and at least one of them is a mirror that syncs from itself
// and is stuck, so consecutive requests return DIFFERENT serviceRates -- and a
// given product credits at whichever one it happened to reach. A single reading
// would therefore let the gate open on a lucky sample while a customer's
// service credits off an unlucky one.
//
// So we sample, and judge on the WORST reading. "Some origin out there still
// disagrees" is exactly the condition we must not sell into.
const RATE_SAMPLES = 3;
let _rates = { values: [], at: 0 };

async function publicServiceRates() {
  const age = Date.now() - _rates.at;
  if (_rates.values.length && age < RATE_CACHE_MS) return { rates: _rates.values, ageMs: age };
  const got = await Promise.allSettled(
    Array.from({ length: RATE_SAMPLES }, () => jget(PUBLIC_RATE_URL)));
  const rates = got
    .filter(r => r.status === 'fulfilled')
    .map(r => Number(r.value.serviceRate))
    .filter(r => r > 0);
  if (rates.length) {
    _rates = { values: rates, at: Date.now() };
    return { rates, ageMs: 0 };
  }
  // A failed read is not a rate. Fall back to a recent reading -- serviceRate
  // moves at most 10% an hour, so a few minutes old is still meaningful -- but
  // never to a stale one, and never to a default.
  if (_rates.values.length && Date.now() - _rates.at < RATE_MAX_AGE_MS) {
    return { rates: _rates.values, ageMs: Date.now() - _rates.at, degraded: true };
  }
  const why = got.find(r => r.status === 'rejected');
  return { rates: [], error: why ? why.reason?.message : 'no usable serviceRate' };
}

/** May we sell right now? Fails CLOSED: an unreadable oracle blocks the sale.
 *  This path takes money, and "I could not check" is not "it is fine". */
async function saleGate(usd = null, email = null) {
  // The master switch, checked first: an operator turning sales off means off,
  // regardless of what every other signal says.
  if (!S.get('saleOpen')) {
    return { open: false, reason: 'sales are paused by the operator.' };
  }
  const st = await L.ladderState();

  // INDEX MODE (price plan Step 3). No divergence branch: the market price and
  // the credit rate come from the same index by construction, so the question
  // it exists to ask -- "will what you buy here be worth the same to the
  // services?" -- has no gap left to measure (plan section 3). What closes the market
  // instead is an index nobody can vouch for. Checked BEFORE sold-out, because
  // both publish marginalPrice as null and they need different words.
  if (st.pricingMode === 'index') {
    if (st.priceUnavailable) {
      return { open: false, pricingMode: 'index', index: st.index, reason:
        `sales are paused: the PCN price cannot be confirmed right now \u2014 ${st.priceUnavailable}. ` +
        `The price here is the PCN index from exchange.pc.am, and nothing is sold at a price that ` +
        `cannot be confirmed. This clears itself once the index is current again.` };
    }
    if (st.marginalPrice === null) {
      return { open: false, pricingMode: 'index',
               reason: 'the market is sold out \u2014 there is no more PCN to sell here.' };
    }
    return { open: true, pricingMode: 'index', judgedPrice: st.marginalPrice,
             marginalPrice: st.marginalPrice, nextFillPrice: st.nextFillPrice,
             premiumPct: st.premiumPct, index: st.index };
  }

  if (st.marginalPrice === null) {
    return { open: false, reason: 'the ladder is sold out \u2014 there is no more PCN to sell here.' };
  }
  const { rates, ageMs, error } = await publicServiceRates();
  if (!rates.length) {
    return { open: false, reason:
      `sales are paused: the rate oracle at price.pc.am cannot be read (${error}), ` +
      `so we cannot confirm that what you buy here is worth the same to the services that accept it.` };
  }

  // JUDGE ON THE PRICE THE BUYER ACTUALLY PAYS.
  //
  // This used to judge on max(marginalPrice, nextFillPrice) -- the worst rung
  // anywhere in the book. That paused the entire market over a single unpaid
  // $50 order, and it was not an edge case: the rung step is 6.79%, so any
  // order spanning three rungs exceeds a 20% limit on its own. With
  // maxOrderUsd at $2000 the market advertised orders it structurally could
  // not process without shutting itself down. Measured on the live book:
  // $40 -> 14.0% (fine), $45 -> 21.8% (paused), $100 -> 38.9%, $2000 -> 833%.
  //
  // Worse, the two numbers being compared come from the SAME ladder.
  // /opt/pcoin-price/server.mjs polls this box's own /api/ladder/state and
  // takes marginalPrice to drive serviceRate. marginalPrice ignores
  // reservations (deliberately -- see ladder.mjs, so nobody can walk the
  // published price with orders they never pay for) while nextFillPrice
  // includes them. So the gate was comparing the ladder against itself under
  // two different reservation policies, and ANY pending order guaranteed a
  // gap. It reintroduced, in the gate, exactly the griefing vector ladder.mjs
  // had closed in the published price.
  //
  // walkUsd prices the order against rungsWithStock, and availUnits subtracts
  // qty_reserved -- so avgPrice is what THIS buyer pays given everyone else's
  // outstanding holds. That answers the question the gate actually exists to
  // ask ("will this customer be shortchanged?") instead of a hypothetical one
  // about the worst rung some other, larger order might reach.
  //
  // With no usd (the status banner, /api/ladder/gate, the gate watcher) there
  // is no buyer, so judge on the published price -- the number serviceRate
  // tracks. That answers "is the system in step?", which is what a banner
  // should say.
  let judged, judgedLabel;
  if (typeof usd === 'number' && usd > 0) {
    const rungs = await L.rungsWithStock();
    const w = L.walkUsd(rungs, usd);
    // An order that cannot be filled is not a divergence problem; the quote and
    // checkout paths report that themselves with a clearer message.
    judged = w.pcn > 0 ? w.avgPrice : st.marginalPrice;
    judgedLabel = 'the price you would pay';
  } else {
    judged = st.marginalPrice;
    judgedLabel = 'the ladder price';
  }

  const div = r => Math.abs(judged - r) / r * 100;
  const worst = rates.reduce((a, b) => (div(b) > div(a) ? b : a));
  const divergencePct = div(worst);
  const spread = rates.length > 1 && Math.min(...rates) !== Math.max(...rates)
    ? { oracleDisagrees: true, ratesSeen: [...new Set(rates)].sort() } : {};
  if (divergencePct > S.get('maxDivergencePct')) {
    // ONE refusal, TWO different things to say.
    //
    // With a usd amount this is a judgement about THIS ORDER, not about the
    // market: the rungs left after everyone else's holds would price this buyer
    // above what the services credit PCN at. The market may be perfectly in
    // step -- on 2026-09-03 it was, the published price and serviceRate exactly
    // equal -- while every individual quote was refused because unpaid orders
    // held the cheap rungs. Saying "sales are paused" there sent the operator
    // (and me) looking for an outage that did not exist.
    //
    // Without one, it IS systemic: the ladder itself has drifted from the rate,
    // and nothing anyone orders will fix that.
    const perOrder = typeof usd === 'number' && usd > 0;

    // A waiver lifts the refusal for ONE buyer who has been told what it costs
    // them. It never touches the systemic branch below: that one exists to
    // catch a stuck or wrong oracle, and no operator convenience is worth
    // selling through that.
    if (perOrder && email) {
      const waiver = await W.find(email, usd).catch(() => null);
      if (waiver) {
        const loss = lossOnSpendPct(judged, worst);
        return { open: true, waived: true, waiverId: waiver.id,
          divergencePct, serviceRate: worst, judgedPrice: judged,
          marginalPrice: st.marginalPrice, nextFillPrice: st.nextFillPrice, ...spread,
          notice:
          `You are buying above the rate the services credit PCN at. You would pay ` +
          `$${judged.toFixed(6)} per PCN; the services credit PCN at $${worst.toFixed(6)}. ` +
          `If you spend these coins there you lose ${loss.toFixed(1)}% immediately, and the ` +
          `wPCN pool is held to the same rate, so it is not a better exit. This order was ` +
          `allowed by a one-time waiver at your request; the price is the ladder's own.` };
      }
    }

    return { open: false, divergencePct, serviceRate: worst, judgedPrice: judged,
      marginalPrice: st.marginalPrice, nextFillPrice: st.nextFillPrice,
      scope: perOrder ? 'order' : 'market', ...spread,
      reason: perOrder
        ? `this order cannot be filled at a fair price right now: the PCN still on ` +
          `sale would cost you $${judged.toFixed(6)} each, and the services credit PCN at ` +
          `$${worst.toFixed(6)} — so spending these coins there would lose you ` +
          `${(lossOnSpendPct(judged, worst) ?? 0).toFixed(1)}% immediately. That is past the ` +
          `${S.get('maxDivergencePct')}% limit, so the order is refused rather than sold into ` +
          `the gap. **Buy it in several smaller orders instead** — each one starts again at the ` +
          `cheapest PCN still on sale, so the same money buys more coins than one large order ` +
          `would. The market itself is open.`
        : `sales are paused: ${judgedLabel} ($${judged.toFixed(6)}) and the rate the ` +
          `services credit PCN at ($${worst.toFixed(6)}) have drifted ${divergencePct.toFixed(1)}% apart, ` +
          `past the ${S.get('maxDivergencePct')}% limit. Selling into that gap would shortchange you. ` +
          `This clears itself once the two are back in step.` };
  }
  return { open: true, divergencePct, serviceRate: worst, judgedPrice: judged,
           marginalPrice: st.marginalPrice, nextFillPrice: st.nextFillPrice,
           rateAgeMs: ageMs, ...spread };
}

// ── auth ───────────────────────────────────────────────────────────────────
// '|' is the session-token delimiter, so it must not appear in an identity.
// Without that exclusion, registering `victim@example.com|9999999999999` yields
// a correctly-signed token that parses back as `victim@example.com` — a full
// account takeover with no forgery and no stolen secret. The delimiter is also
// parsed from the right now; either fix alone closes it, and both are cheap.
const VALID_EMAIL = /^[^@\s|]+@[^@\s|]+\.[^@\s|]+$/;

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };
const hashPw = (pw, salt) => scryptSync(pw, salt, 64, SCRYPT).toString('hex');
function sign(p) { return `${p}.${createHmac('sha256', cfg.sessionSecret).update(p).digest('hex')}`; }
function verifyTok(t) {
  if (!t) return null;
  const i = t.lastIndexOf('.');
  if (i < 0) return null;
  const p = t.slice(0, i);
  const want = createHmac('sha256', cfg.sessionSecret).update(p).digest('hex');
  const got = t.slice(i + 1);
  if (got.length !== want.length || !timingSafeEqual(Buffer.from(got), Buffer.from(want))) return null;
  // Split from the RIGHT. The payload is `${email}|${expiry}`, and splitting
  // from the left made the FIRST field the identity -- so an address containing
  // the delimiter, e.g. `victim@example.com|99999999999999`, minted a token that
  // is genuinely signed for the attacker's own account and reads back as the
  // victim's. Registration also rejects '|' now (see VALID_EMAIL); this is the
  // second lock on the same door, because the tokens already issued under the
  // old rule are still valid until they expire.
  const cut = p.lastIndexOf('|');
  if (cut < 1) return null;
  const email = p.slice(0, cut);
  const exp = p.slice(cut + 1);
  if (!VALID_EMAIL.test(email)) return null;
  const expMs = Number(exp);
  if (!isFinite(expMs) || Date.now() >= expMs) return null;
  return email;
}

// ── helpers ────────────────────────────────────────────────────────────────
const today = () => new Date().toISOString().slice(0, 10);
async function jget(u) {
  const r = await fetch(u, { signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`${u} -> ${r.status}`);
  return r.json();
}
const json = (res, code, o) => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(o, null, 2));
};
const body = req => new Promise((r, j) => {
  let s = ''; req.on('data', c => { s += c; if (s.length > 2e5) req.destroy(); });
  req.on('end', () => r(s)); req.on('error', j);
});

/** How much USD this user has already taken out today (UTC).
 *
 *  `lock` matters. Under REPEATABLE READ — MariaDB's default — a plain SELECT
 *  inside a transaction is a non-locking consistent read against the snapshot
 *  taken when the transaction began. Two concurrent sells therefore BOTH read
 *  the pre-transaction total, both conclude there is room, and both insert:
 *  the cap becomes a suggestion, which is exactly the race the move from a JSON
 *  file to a transaction was supposed to have ended. It did not, because a
 *  transaction alone is not a lock.
 *
 *  `FOR UPDATE` makes it a locking read and takes gap locks over the range, so
 *  the second transaction blocks until the first commits and then sees its row. */
async function soldTodayUsd(email, conn = pool, lock = false) {
  const [r] = await conn.query(
    `SELECT COALESCE(SUM(usd),0) AS t FROM sells
      WHERE email = ? AND created_at >= UTC_DATE()` + (lock ? ' FOR UPDATE' : ''), [email]);
  return Number(r[0].t);
}

// ── NOWPayments ────────────────────────────────────────────────────────────
async function npCreateInvoice({ usd, orderId, address }) {
  const r = await fetch('https://api.nowpayments.io/v1/invoice', {
    method: 'POST',
    headers: { 'x-api-key': cfg.nowpaymentsApiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      price_amount: usd,
      price_currency: 'usd',
      order_id: orderId,
      order_description: `PCN to ${address}`,
      ipn_callback_url: `${cfg.publicUrl}/ipn`,
      success_url: `${cfg.publicUrl}/order/${orderId}`,
      // The ORDER page, not the home page. Sending someone who pressed the
      // gateway's cancel button back to the front door put them on the one
      // screen that re-quotes -- against the rungs their own unpaid order was
      // still holding. The order page is where the invoice and the cancel
      // button are.
      cancel_url: `${cfg.publicUrl}/order/${orderId}`,
    }),
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.message || `NOWPayments ${r.status}`);
  return j;
}

// The IPN signature check lives in ipn.mjs (signatureVariant). It checks the
// RAW body bytes first -- what NOWPayments was measured to sign -- and keeps the
// sorted, source-text-preserving form this file used before as a fallback, so a
// callback that verified under the old check still verifies.

/** Report what a completed sale actually earned, from the gateway's own fee
 *  breakdown. Never throws into the IPN path — a reporting bug must not cost a
 *  delivery. */
const saleReported = new Set();
async function reportSaleEconomics(d, opts = {}) {
  // `opts.basisUsd` is what the customer ACTUALLY paid in fiat, when that differs
  // from what the invoice asked for. It matters because the fee percentage below
  // divides by it.
  //
  // On a partial payment `price_amount` is the INVOICE, not the payment, so
  // dividing by it charges the shortfall to "fees". Order Mmte1xvake1040f was
  // $35.00 invoiced and $33.46 paid: 4.4% of that gap is a customer underpaying,
  // not the gateway taking a cut, and on its own that is nearly the >5% warning
  // threshold. A warning that cries about the wrong thing is how the real one
  // gets ignored.
  // Once per payment. The branch that calls this accepts BOTH 'confirmed' and
  // 'finished', and the gateway retries callbacks — so without this the same
  // sale is announced two or more times, and an operator who sees two "Sale
  // settled" messages reasonably concludes two people bought something.
  const key = String(d.payment_id ?? d.order_id ?? '');
  if (!key || saleReported.has(key)) return;
  if (saleReported.size > 5000) saleReported.clear();   // bounded; worst case is a repeat
  saleReported.add(key);

  const invoiced   = Number(d.price_amount);
  const givenBasis = Number(opts.basisUsd);
  const partial    = !!opts.partial;
  // No explicit basis means a full payment, where the two are the same number.
  const usd = isFinite(givenBasis) && givenBasis > 0 ? givenBasis : invoiced;
  const out = Number(d.outcome_amount);
  const f = d.fee || {};

  // NOT `?? 0`. A fee object the gateway did not send, or sent under a
  // different name after an API change, would become 0 and print the single
  // most misleading sentence this function can produce: "No per-order
  // withdrawal fee — this is what Custody was turned on for." That is a
  // confident all-clear manufactured from an absent field, and it is exactly
  // the `optInt("x", 0)` trap this estate has been bitten by before. A missing
  // fee is UNKNOWN, and unknown says so.
  const num = v => (v === undefined || v === null || !isFinite(Number(v)) ? null : Number(v));
  const wd = num(f.withdrawalFee), dep = num(f.depositFee), svc = num(f.serviceFee);
  const money = v => (v === null ? 'unknown' : v.toFixed(6));
  if (!isFinite(usd) || usd <= 0) return;

  // outcome_amount is in outcome_currency. It is a stablecoin in every
  // configuration this market has used, so treating it as dollars is right
  // here — but say which currency, so a future switch to a volatile payout
  // asset is visible rather than silently compared against USD.
  const netKnown = isFinite(out) && out > 0;
  const lostPct = netKnown ? ((usd - out) / usd) * 100 : null;

  // Three states, and the unknown one never masquerades as the good one.
  let verdict;
  if (wd === null) {
    verdict = `❔ The gateway sent no withdrawal fee field, so whether Custody is holding funds ` +
              `is <b>unknown</b> from this callback — not confirmed either way. Check the ` +
              `Custody balance directly.`;
  } else if (wd > 0) {
    verdict = `⚠️ <b>The per-order withdrawal fee is STILL being charged</b> (${wd.toFixed(2)}). ` +
              `Funds are being forwarded per payment instead of accumulating in Custody — ` +
              `check Store Settings → Payout wallets.`;
  } else if (netKnown && lostPct !== null && lostPct > 5) {
    verdict = `⚠️ Fees took <b>${lostPct.toFixed(1)}%</b>, which is high for a sale with no ` +
              `withdrawal fee. Worth a look at the gateway settings.`;
  } else {
    verdict = `✅ No per-order withdrawal fee. This is what Custody was turned on for.`;
  }

  // Say the shortfall out loud. Without it a PARTIAL line reads as a smaller sale
  // rather than an underpaid one, which is the fact the operator actually needs.
  const shortNote = partial && isFinite(invoiced) && invoiced > usd
    ? ` (invoice $${invoiced.toFixed(2)} — ${(((invoiced - usd) / invoiced) * 100).toFixed(1)}% short)`
    : '';
  await notify(
    `💵 <b>Sale settled${partial ? ' — PARTIAL' : ''}</b>  <code>${esc(String(d.order_id ?? '?'))}</code>\n` +
    `customer paid <b>$${usd.toFixed(2)}</b> in ${esc(String(d.pay_currency ?? '?'))}${shortNote}\n` +
    (netKnown ? `you received <b>${out} ${esc(String(d.outcome_currency ?? ''))}</b>` +
                (lostPct !== null ? ` — ${lostPct.toFixed(1)}% to fees\n` : `\n`) : '') +
    `deposit ${money(dep)} · service ${money(svc)} · withdrawal <b>${money(wd)}</b>\n` +
    verdict);
}

// ── pages ──────────────────────────────────────────────────────────────────
// Throttles for alerts a stranger can trigger. Unbounded, they would be a
// denial of service against the one channel carrying the double-send alarm.
// (The bad-signature throttle lives with the IPN, in ipn.mjs.)
let lastCrashAlert = 0, lastGatewayAlert = 0, lastSchemaAlert = 0;

// A body that is not JSON is a client error. Returns null AFTER answering 400,
// so the caller returns immediately and never sees a half-parsed object.
const jsonBodyOr400 = (raw, res) => {
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === 'object') return v;
  } catch { /* falls through to the 400 below */ }
  res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: 'body must be a JSON object' }));
  return null;
};

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const CSS = readFileSync('/opt/pcoin-market/style.css', 'utf8');
const shell = (title, b) => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='7' fill='%230d1117'/><path d='M16 5 L18.4 13.6 L27 16 L18.4 18.4 L16 27 L13.6 18.4 L5 16 L13.6 13.6 Z' fill='%232dd4bf'/></svg>">
<style>${CSS}</style></head><body>${b}</body></html>`;

// ── the payment callback ───────────────────────────────────────────────────
// All of it is in ipn.mjs: the signature, what a callback is worth, the tie
// between an order and the one payment that paid it, and the hand-off to
// delivery. What stays here is what happens once an order is PAID:
//
// SAY THANK YOU NOW, NOT WHEN THE COINS GO OUT. Owner's instruction 2026-09-14:
// "once payment received on nowpayment it should post on channel." A manual
// delivery can be hours after the payment (order Mmu1bc3zrfd6902 was paid at
// 14:22 UTC and had announced nothing by evening). announcePurchase() re-reads
// the order and posts nothing unless it is a real paid purchase; recordSent()
// still calls it too, and pcoin-approve's `--key purchase-<id>` makes whichever
// arrives second a no-op.
//
// WHAT DID THIS SALE ACTUALLY EARN? The gateway's fee breakdown arrives in the
// callback. The first real sale took $20 and credited $14.34 because every
// order triggered its own ~$5.39 on-chain withdrawal; this report is how a
// silent change to the payout configuration shows up as a fee reappearing. For
// an underpayment the basis is what actually arrived, so the customer's
// shortfall is not billed to the gateway as "fees". A payment that is held for
// a human (a child, a mismatch, an unbacked order) is not a sale and is not
// reported as one.
const IPN = makeIpn({
  pool, ladder: L, delivery: D, notify,
  secret: () => cfg.ipnSecret,
  onPaid: d => {
    D.announcePurchase(String(d.order_id)).catch(e => console.error('[ipn] announce:', e.message));
    reportSaleEconomics(d).catch(e => console.error('[ipn] fee report:', e.message));
  },
  onUnderpaid: (d, paidUsd) => {
    reportSaleEconomics(d, { basisUsd: paidUsd, partial: true })
      .catch(e => console.error('[ipn] fee report (partial):', e.message));
  },
});

// ── the columns the payment callback needs ─────────────────────────────────
// ipn.mjs reads orders.paid_payment_id / invoice_usd and writes
// ipn_events.outcome / note on every callback. orders-payment.sql adds them, as
// root, because this process has no DDL rights. Deployed without them the
// callback cannot decide anything -- so say it at startup instead of on the
// first sale, answer callbacks 503 (NOWPayments retries them, nothing is lost)
// and take no new orders: taking money that cannot be processed is the one
// outcome worse than a closed shop. Re-checked on each refused request, so
// running the migration reopens everything without a restart.
let ipnSchemaOk = false;
async function checkIpnSchema() {
  try {
    for (const [table, cols] of Object.entries(REQUIRED_COLUMNS)) {
      await q(`SELECT ${cols.join(', ')} FROM ${table} LIMIT 0`);
    }
    ipnSchemaOk = true;
    return null;
  } catch (e) {
    ipnSchemaOk = false;
    return e.message;
  }
}
function schemaAlert(missing) {
  if (Date.now() - lastSchemaAlert < 30 * 60 * 1000) return;
  lastSchemaAlert = Date.now();
  console.error(`[market] MIGRATION MISSING (${missing}). Run orders-payment.sql as root; until then ` +
                `payment callbacks answer 503 and /api/buy refuses orders.`);
  notify(`🔴 <b>Payments cannot be processed — migration missing</b>\n` +
         `<code>${esc(String(missing).slice(0, 200))}</code>\nRun <code>mysql pcoin_market &lt; ` +
         `/opt/pcoin-market/orders-payment.sql</code> as root. Until then every payment callback is ` +
         `answered 503 (NOWPayments retries it), nothing is paid or delivered, and new orders are ` +
         `refused.`).catch(() => {});
}
{
  const missing = await checkIpnSchema();
  if (missing) schemaAlert(missing);
}

// ── server ─────────────────────────────────────────────────────────────────
createServer(async (req, res) => {
  // A request target is INPUT. Node throws on one it cannot parse, and this is
  // the first statement in the handler: left unguarded the throw escaped before
  // anything was written, so the connection hung until the client gave up and
  // each attempt raised an unhandled rejection that paged the owner. A scanner
  // sending a few hundred of those is a denial of service with an alert attached.
  let u;
  try {
    u = new URL(req.url, 'http://x');
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('bad request target\n');
  }
  const p = u.pathname.replace(/\/+$/, '') || '/';

  // ---- admin panel, mounted before anything customer-facing ----
  // Its own cookie, its own session secret, its own CSRF. Nothing about a
  // customer session grants anything here.
  if (p === '/admin' || p.startsWith('/admin/')) {
    try {
      const raw = req.method === 'POST' ? await body(req) : '';
      return await ADMIN.handle(req, res, u, raw,
        (code, html, extra = {}) => {
          res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8',
                                'Cache-Control': 'no-store',
                                'X-Frame-Options': 'DENY',
                                'Referrer-Policy': 'no-referrer',
                                ...extra });
          res.end(html);
        },
        (code, obj) => json(res, code, obj));
    } catch (e) {
      console.error('[admin]', e.stack || e.message);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      return res.end('admin error');
    }
  }

  const cookie = (req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith('mkt='));
  const email = verifyTok(cookie ? cookie.slice(4) : '');

  try {
    // ---- IPN. No session, signature only. ----
    // Everything about a payment callback is in ipn.mjs: it verifies the
    // signature over the raw bytes before touching anything, decides what the
    // callback is worth (R1-R8, see its header), ties the order to the payment,
    // and hands a paid order to delivery. A throw from it lands in the catch
    // below, answers 500 and pages; NOWPayments then retries, which is safe
    // because every step there is idempotent.
    if (p === '/ipn' && req.method === 'POST') {
      let raw;
      try { raw = await readRawBody(req); }
      catch (e) {
        if (e.code === 'BODY_TOO_LARGE') return json(res, 413, { error: 'body too large' });
        throw e;
      }
      if (!ipnSchemaOk) {
        const missing = await checkIpnSchema();
        if (missing) {
          schemaAlert(missing);
          // Verified and logged (old columns only), then 503: see handlePaused.
          const r = await IPN.handlePaused(raw, req.headers['x-nowpayments-sig']);
          return json(res, r.http, r.body);
        }
      }
      const r = await IPN.handle(raw, req.headers['x-nowpayments-sig']);
      return json(res, r.http, r.body);
    }

    // ---- public price ----
    if (p === '/api/price') return json(res, 200, await jget(`${PRICE}/price`));

    // Quotes come from the ladder now, not from the oracle's AMM curve. The
    // oracle still owns `serviceRate` (what the four products credit at) and
    // still runs the buyback; it no longer prices a purchase.
    if (p === '/api/quote') {
      const usd = Number(u.searchParams.get('usd'));
      if (!(usd >= S.get('minOrderUsd'))) return json(res, 400, { error: `minimum order is $${S.get('minOrderUsd')}` });
      if (!(usd <= S.get('maxOrderUsd'))) return json(res, 400, { error: `maximum order is $${S.get('maxOrderUsd')}` });
      const rungs = await L.rungsWithStock();
      const w = L.walkUsd(rungs, usd);
      if (w.usdUnfilled > 0.001) {
        return json(res, 409, { error: `only ${w.pcn.toFixed(2)} PCN left, worth $${w.cost.toFixed(2)}` });
      }
      const overCap = tooMuchPcn(rungs, w.pcn);
      if (overCap) return json(res, 400, { error: overCap });
      // A quote is still honest when sales are shut -- it says what the ladder
      // holds. But it must carry the gate, so the page can grey the button out
      // and explain, rather than let someone fill in an address and a payment
      // amount only to be refused at the click that matters.
      const gate = await saleGate(usd, email);
      return json(res, 200, {
        // So the page can describe the price it is showing: in index mode there
        // are no steps of a ladder to talk about, only one price.
        pricingMode: S.get('pricingMode') === 'index' ? 'index' : 'curve',
        // Names kept from the AMM response so nothing downstream has to change.
        pcn: w.pcn,
        effectivePrice: w.avgPrice,
        newPrice: w.marginalAfter,
        rungsConsumed: w.rungsConsumed,
        totalCost: Number(w.cost.toFixed(2)),
        saleOpen: gate.open,
        saleBlockedReason: gate.open ? null : gate.reason,
      });
    }

    // ---- the ladder, in public ----
    // Read-only and unauthenticated on purpose: this is the price, and the
    // price oracle on this same box polls it to drive `serviceRate`.
    // REFUND PCN, for the wrap desk on another host. THIS ONE SPENDS.
    //
    // The wrap desk lives on a different box and holds no PCN it can spend:
    // deposit addresses and the reserve are deliberately unspendable from any
    // server, so a refund has to come from a different pot. `market-hot` is
    // that pot -- it is already the wallet this process sends deliveries from,
    // so this adds no key, no wallet and no host that was not already
    // spending. It adds one narrow, capped, separately-credentialled way to
    // ask it to.
    //
    // ITS OWN TOKEN, NOT readToken. A read credential must never authorise a
    // spend: they are handed out for different reasons and rotated on
    // different days, and the panel holds both. Unset means refunds are OFF,
    // not open -- a missing credential fails closed.
    //
    // IDEMPOTENT BY COMMENT, which is how delivery.mjs already does it: the
    // wrap key goes into the transaction's comment, and before sending we look
    // for a transaction already carrying it. An RPC that TIMES OUT says nothing
    // about whether the node broadcast -- so a lookup that THROWS resolves
    // nothing and refuses, rather than collapsing into "nothing was sent" and
    // paying twice (delivery.mjs:139-150 is the same rule, learned the hard way).
    // SEND PCN from market-hot, for the admin panel's Send page. ops-send.mjs holds
    // the guards: its own token, per-send and 24h caps, idempotent by key.
    if (p === '/api/ops/send-pcn' && req.method === 'POST') {
      const r = await opsSendPcn({ auth: req.headers.authorization || '', raw: await body(req), cfg, node, notify });
      return json(res, r.code, r.obj);
    }

    if (p === '/api/ops/refund-pcn' && req.method === 'POST') {
      const want = cfg.refundToken;
      if (!want) {
        return json(res, 503, { error: 'no refundToken is configured, so refunds are '
          + 'switched off here. This is not an authentication failure.' });
      }
      const m = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
      if (!m || m[1] !== want) {
        return json(res, 401, { error: 'refunds need the refund token, which is not '
          + 'the read token' });
      }
      const b = jsonBodyOr400(await body(req), res);
      if (b === null) return undefined;
      const key = String(b.key || '').trim();
      const to = String(b.to || '').trim();
      const pcn = Number(b.pcn);
      // A cap that is generous for a refund and useless for a drain. The
      // largest legitimate single refund this desk can produce is one
      // over-cap deposit, and those have run to a few hundred PCN.
      const MAX_REFUND_PCN = Number(cfg.refundMaxPcn || 600);
      if (!/^[0-9a-zA-Z:._-]{4,160}$/.test(key)) {
        return json(res, 400, { error: 'a refund needs an idempotency key (the wrap key)' });
      }
      // bech32 as PCoin uses it: hrp `pc1`, then the bech32 charset, which
      // deliberately excludes 1, b, i and o so a transcription slip is caught
      // rather than silently becoming a different address.
      if (!/^pc1[02-9ac-hj-np-z]{20,87}$/.test(to)) {
        return json(res, 400, { error: `${to} does not look like a PCoin bech32 `
          + 'address; nothing was sent' });
      }
      if (!Number.isFinite(pcn) || pcn <= 0 || pcn > MAX_REFUND_PCN) {
        return json(res, 400, { error: `amount must be above 0 and at most `
          + `${MAX_REFUND_PCN} PCN; got ${b.pcn}` });
      }
      // NO validateaddress PRE-CHECK, DELIBERATELY. This wallet's RPC identity
      // runs under rpcwhitelistdefault=0 and `validateaddress` is not on its
      // list -- it answers 403. Widening a live wallet's RPC permissions to buy
      // a nicety is the wrong trade, and it buys nothing: `sendtoaddress`
      // validates the address itself and refuses a malformed one without
      // moving a satoshi. So the authoritative check simply happens one step
      // later, and an address that cannot be paid is still never paid.
      //
      // This is NOT "unknown became yes" -- nothing is resolved optimistically
      // here. The shape filter below only turns an obvious typo into a fast,
      // readable error instead of an RPC round trip. A typo that is still
      // valid bech32 is caught by neither, and nothing can catch that.

      // Already done? Look before spending.
      let prior;
      try {
        const txs = await node.wallet('listtransactions', ['*', 1000, 0, true]);
        prior = (txs || []).find(t => t.comment === key && t.category === 'send'
          && t.abandoned !== true && Number(t.confirmations) > -1) || null;
      } catch (e) {
        return json(res, 503, { error: `could not check whether ${key} was already `
          + `refunded (${e.message}). Nothing was sent -- an unanswerable question `
          + `must not resolve to the answer that spends money.` });
      }
      if (prior) {
        return json(res, 200, { ok: true, already: true, txid: prior.txid,
          note: 'a refund carrying this key was already sent; nothing new was broadcast' });
      }

      try {
        const txid = await node.wallet('sendtoaddress', [
          to,
          Number(pcn.toFixed(8)),
          key,              // comment -- THE recovery handle, see above
          '',
          false,            // the customer gets the full amount; we pay the fee
        ]);
        try {
          notify('wrap desk: PCN refunded',
            `Sent ${pcn} PCN to ${to} for ${key}.\ntx ${txid}`);
        } catch { /* reporting must never break the thing it reports on */ }
        return json(res, 200, { ok: true, already: false, txid, pcn, to });
      } catch (e) {
        // The send may or may not have gone out. Say exactly that.
        return json(res, 502, { error: `the send failed or its answer was lost: `
          + `${e.message}. Check for a transaction with comment ${key} BEFORE retrying.` });
      }
    }

    // Read-only operator summary for the unified admin panel. Token-gated with
    // its own credential -- a customer session must never reach it, and this
    // token opens nothing else. GET only; it writes nothing anywhere.
    if (p === '/api/ops/summary') {
      const want = cfg.readToken;
      const m = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
      if (!want || !m || m[1] !== want) {
        return json(res, 401, { error: 'the operator summary requires the read-only token' });
      }

      // Each of these can fail independently, and a failure must not take the
      // whole reply down -- a dashboard that shows nothing because one RPC
      // hiccuped is worse than one that shows three of four panels.
      const settle = p2 => p2.then(v => ({ ok: true, v })).catch(e => ({ ok: false, e: e.message }));
      const [st, hr, fl, counts] = await Promise.all([
        settle(L.ladderState()),
        settle(B.headroomPcn()),
        settle(D.floatBalance()),
        settle(pool.query(
          'SELECT status, COUNT(*) AS n, COALESCE(SUM(usd),0) AS usd FROM orders GROUP BY status')),
      ]);

      const byStatus = {};
      if (counts.ok) for (const r of counts.v[0]) {
        byStatus[r.status] = { count: Number(r.n), usd: Number(r.usd) };
      }

      return json(res, 200, {
        ok: true,
        service: 'pcoin-market',
        at: new Date().toISOString(),
        uptimeSeconds: Math.round(process.uptime()),

        ladder: st.ok ? {
          marginalPrice: st.v.marginalPrice, askCapUsd: st.v.askCapUsd,
          rungMarginalPrice: st.v.rungMarginalPrice, floorPrice: st.v.floorPrice,
          soldPcn: st.v.soldPcn, reservedPcn: st.v.reservedPcn,
          retiredPcn: st.v.retiredPcn, remainingPcn: st.v.remainingPcn,
          deliverablePcn: hr.ok ? hr.v.pcn : null,
          sellableNowPcn: (hr.ok && Number.isFinite(Number(st.v.remainingPcn)))
            ? Math.min(Number(st.v.remainingPcn), hr.v.pcn) : null,
          pctSold: st.v.pctSold,
          pricingMode: st.v.pricingMode, premiumPct: st.v.premiumPct,
          index: st.v.index, priceUnavailable: st.v.priceUnavailable,
        } : null,
        ladderError: st.ok ? null : st.e,

        backing: hr.ok ? {
          headroomPcn: hr.v.pcn, ownerPcn: hr.v.ownerPcn, owedPcn: hr.v.owed,
          ageMs: hr.v.ageMs ?? null, degraded: !!hr.v.degraded, manual: !!hr.v.manual,
        } : null,
        backingError: hr.ok ? null : hr.e,

        float: fl.ok ? { hotWalletPcn: fl.v } : null,
        floatError: fl.ok ? null : fl.e,

        orders: counts.ok ? byStatus : null,
        ordersError: counts.ok ? null : counts.e,

        settings: {
          saleOpen: S.get('saleOpen'), buybackOpen: S.get('buybackOpen'),
          minOrderUsd: S.get('minOrderUsd'), maxOrderUsd: S.get('maxOrderUsd'),
          maxOrderPcn: S.get('maxOrderPcn'), autoMaxUsd: S.get('autoMaxUsd'),
          maxDivergencePct: S.get('maxDivergencePct'),
          ladderMaxPriceUsd: S.get('ladderMaxPriceUsd'),
          ladderMinPriceUsd: S.get('ladderMinPriceUsd'),
          pricingMode: S.get('pricingMode'), marketPremiumPct: S.get('marketPremiumPct'),
          indexMaxAgeSeconds: S.get('indexMaxAgeSeconds'),
        },
      });
    }

    if (p === '/api/ladder/state') {
      // The page renders its limits from here rather than hardcoding them. A
      // number typed into the HTML is a number that goes stale the first time
      // the setting changes -- the minimum said $10 on the page while the real
      // minimum was $15, which is exactly the kind of quiet lie that costs
      // someone a failed order.
      // The coin cap is what a buyer runs into, so tell them what it is worth
      // right now rather than making them discover it at the quote.
      const capPcn = S.get('maxOrderPcn');
      let capUsd = null;
      try { capUsd = Number(L.walkPcn(await L.rungsWithStock(), capPcn).cost.toFixed(2)); } catch {}
      const ladSt = await L.ladderState();
      // What is LEFT on the ladder and what we will actually SELL are different
      // numbers, and only the second one is a promise we can keep. The book runs
      // to 84,538 PCN while the deliverable cap is 50,000 -- set by hand against
      // coins that exist, and enforced on the buy path below. Advertising the
      // larger figure over-promises by 69%.
      //
      // null means UNKNOWN and must stay null: zero would read as sold out, and
      // falling back to remainingPcn would put the over-promise straight back.
      let deliverablePcn = null, sellableNowPcn = null;
      try {
        const hr = await B.headroomPcn();
        if (hr && hr.pcn !== null && Number.isFinite(Number(hr.pcn))) {
          deliverablePcn = Number(hr.pcn);
          const rem = Number(ladSt.remainingPcn);
          sellableNowPcn = Number.isFinite(rem) ? Math.min(rem, deliverablePcn) : deliverablePcn;
        }
      } catch { /* unreadable backing stays unknown, never a number */ }
      // PUBLIC vs INTERNAL. See the header of ladder_trim_patch.py: the page
      // needs price, stock and limits, and nothing else. The policy fields
      // (askCapUsd, rungMarginalPrice) let anyone compute how much buying trips
      // the sale gate, which closes the market to everybody.
      //
      // X-Forwarded-For, not remoteAddress: Caddy proxies to 127.0.0.1 so every
      // request looks like loopback. Caddy always sets XFF and a public caller
      // cannot strip it, so its ABSENCE means one of our own processes on this
      // box. A Bearer read token grants the same, for the admin on another host.
      const viaProxy = !!req.headers['x-forwarded-for'];
      const tokMatch = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
      const internal = !viaProxy || (cfg.readToken && tokMatch && tokMatch[1] === cfg.readToken);

      const full = {
        ...ladSt,
        deliverablePcn,
        sellableNowPcn,
        // THE HEADLINE FIGURE IS WHAT WE WILL ACTUALLY SELL.
        //
        // ...ladSt above carries the ladder's own remainingPcn -- the internal
        // price book, 100,000 PCN less what has sold and been retired. That is
        // not a promise we can keep, and this endpoint is public and
        // uncredentialled, so anything reading it as available supply was being
        // misled. The book figure is still published, under a name that says
        // what it is.
        //
        // null when the backing is unreadable, deliberately: falling back to the
        // book number would restore the over-statement at the one moment nobody
        // can verify it.
        remainingPcn: sellableNowPcn,
        ladderRemainingPcn: ladSt.remainingPcn,
        // The oracle mirrors this so it can stop advertising a buyback that is
        // switched off. The market owns the switch; one source of truth.
        buybackOpen: S.get('buybackOpen'),
        minOrderUsd: S.get('minOrderUsd'),
        maxOrderUsd: S.get('maxOrderUsd'),
        maxOrderPcn: capPcn,
        maxOrderUsdNow: capUsd,
        autoMaxUsd: S.get('autoMaxUsd'),
      };

      // Everything the PUBLIC may see. Anything not on this list is ours.
      // pricingMode, premiumPct and index are public on purpose: in index mode
      // the price IS "the index x a published constant" (plan §2.1), and the page
      // builds its description of the price from them rather than hardcoding 3%.
      const PUBLIC_FIELDS = [
        'at', 'marginalPrice', 'floorPrice', 'topPrice', 'rungCount', 'stepPct',
        'totalPcn', 'pctSold', 'remainingPcn', 'ladderRemainingPcn', 'sellableNowPcn',
        'buybackOpen', 'minOrderUsd', 'maxOrderUsd', 'maxOrderPcn', 'maxOrderUsdNow',
        'autoMaxUsd', 'pricingMode', 'premiumPct', 'index', 'priceUnavailable',
      ];
      // INDEX MODE, NO PRICE: 503 to OUR OWN callers, a normal 200 to the public.
      //
      // price.pc.am polls this over loopback and reads `marginalPrice: null` as
      // "the ladder is sold out, the last rung's price stands" -- it keeps the
      // old price AND refreshes its age, so it would go on publishing a fresh-
      // looking sellPriceUsd for a market that is closed. A failed poll is what
      // it treats as "no longer refreshed": the last price stays, `ladder.stale`
      // turns true after 10 minutes, and consumers that require a fresh ladder
      // (the exchange's fetchSellPrice, pcnaibot) stand down. That is plan §2.4's
      // `unknown` row. The public page still gets its limits and the reason.
      if (internal && full.pricingMode === 'index' && full.priceUnavailable) {
        return json(res, 503, { ...full, error: `no price: ${full.priceUnavailable}` });
      }
      if (internal) return json(res, 200, full);
      const pub = {};
      for (const k of PUBLIC_FIELDS) if (k in full) pub[k] = full[k];
      return json(res, 200, pub);
    }

    // Whether selling is currently open, and why not if it is not. Public so
    // the page can say so plainly instead of failing at the last click.
    if (p === '/api/ladder/gate') return json(res, 200, await saleGate());

    /** The average-price calculator: enter a quantity, see what it really
     *  costs. The whole reason the ladder exists is that the average price of
     *  a large purchase is nothing like the price on the front of the site,
     *  so the site has to show that rather than let someone discover it at
     *  checkout. */
    if (p === '/api/ladder/calc') {
      const pcn = Number(u.searchParams.get('pcn'));
      if (!(pcn > 0)) return json(res, 400, { error: 'amount must be positive' });
      const st = await L.ladderState();
      const w = L.walkPcn(await L.rungsWithStock(), pcn);
      const flat = st.pricingMode === 'index';
      return json(res, 200, {
        pricingMode: st.pricingMode,
        requestedPcn: pcn,
        filledPcn: w.pcn,
        unfilledPcn: w.pcnUnfilled,          // > 0 means the ladder ran out
        // NOT rounded to cents. At $0.015 a coin, toFixed(2) turned the true
        // cost of 1 PCN into $0.01 while the average beside it still read
        // $0.015 — so the page showed 1 x $0.015 = $0.01 and argued with
        // itself. Cheap coins mean sub-cent totals are real; the client
        // decides how many decimals to show, and the server does not destroy
        // precision it cannot get back.
        totalCost: w.cost,
        averagePrice: w.avgPrice,
        // How many rungs this order TOUCHES. It is not how many it uses up: an
        // order smaller than one rung touches exactly 1 and consumes a sliver
        // of it, which is why the page reports the fraction of the ladder as
        // well, and why "consumes 1 of the 100 steps" was the wrong sentence.
        rungsTouched: w.rungsConsumed,
        rungsConsumed: w.rungsConsumed,      // kept: older clients read this name
        pctOfLadder: st.totalPcn ? (w.pcn / Number(st.totalPcn)) * 100 : null,
        priceBefore: st.nextFillPrice,
        marginalPriceAfter: w.marginalAfter,
        // Whether the NEXT buyer would pay a different price than they would
        // have before this order. Small orders genuinely do not move it, and
        // saying "moves the price from $0.015 to $0.015" reads as a bug even
        // though it is arithmetically true.
        // Index mode is flat by definition. Comparing the two numbers there
        // would report a "move" whenever the 30-second index refresh happened
        // to land between the state read and the walk.
        priceMoves: !flat && w.marginalAfter !== null && w.marginalAfter !== st.nextFillPrice,
        exhausted: w.exhausted,
      });
    }

    // ---- auth ----
    // ---- SSO: hand the wrap desk a signed statement of who is signed in ----
    //
    // The wrap desk raises its per-person limit for a market account, so it must
    // learn the account WITHOUT being able to forge one. This mints a short-lived
    // token the desk verifies with a shared secret.
    //
    // FOUR things here are load-bearing, and three of them are ways this goes
    // wrong rather than features:
    //
    // 1. A SEPARATE SECRET from sessionSecret. Same-secret tokens mean a stolen
    //    market session cookie is also a wrap-desk grant and vice versa; the two
    //    systems would share a blast radius for no benefit. Different audience,
    //    different key.
    // 2. The return URL is ALLOWLISTED. Redirecting to whatever ?return= says,
    //    with a signed identity token in the query string, is an open redirect
    //    that hands the token to anyone who can get a link clicked.
    // 3. 120 SECONDS. The token exists only to survive one browser redirect. The
    //    desk swaps it for its own cookie immediately, so a long life buys
    //    nothing and a leaked URL in a log or Referer stays useful for longer.
    // 4. Not signed in is a REDIRECT HOME, not an error page: the caller is a
    //    browser mid-bounce, and the useful thing to show is the login form.
    if (p === '/sso/wrapdesk') {
      if (!SSO_ON) return json(res, 503, { error: 'single sign-on is not configured' });
      const back = String(u.searchParams.get('return') || '');
      if (!SSO_RETURN_OK.some((pre) => back.startsWith(pre))) {
        return json(res, 400, { error: 'return url is not an allowed destination' });
      }
      if (!email) {
        // Send them to the login form, remembering where they were going.
        res.writeHead(302, { Location: '/?next=' + encodeURIComponent(back) });
        return res.end();
      }
      const payload = `${email}|${Date.now() + 120_000}`;
      const tok = `${payload}.${createHmac('sha256', cfg.ssoSecret).update(payload).digest('hex')}`;
      const sep = back.includes('?') ? '&' : '?';
      res.writeHead(302, { Location: back + sep + 'sso=' + encodeURIComponent(tok) });
      return res.end();
    }

    // ---- SSO: hand exchange.pc.am a signed statement of who is signed in ----
    // Owner, 2026-09-15: market and exchange share one login. Same shape as
    // /sso/wrapdesk above, with three differences that matter for money:
    // 1. Its OWN secret, cfg.ssoExchangeSecret -- not sessionSecret and not the wrap
    //    desk's ssoSecret, so a wrap-desk compromise cannot mint exchange sign-ins.
    // 2. The audience 'exchange' is inside the signed payload and the exchange
    //    refuses any other, so a wrap-desk token can never be replayed there.
    // 3. The return URL must match EXACTLY, never by prefix.
    // The exchange also makes each token single-use and asks its own 2FA.
    if (p === '/sso/exchange') {
      if (!cfg.ssoExchangeSecret) return json(res, 503, { error: 'exchange sign-on is not configured' });
      const back = String(u.searchParams.get('return') || '');
      if (back !== 'https://exchange.pc.am/sso') {
        return json(res, 400, { error: 'return url is not an allowed destination' });
      }
      if (!email) {
        res.writeHead(302, { Location: '/?next=' + encodeURIComponent('/sso/exchange?return=' + encodeURIComponent(back)) });
        return res.end();
      }
      const payload = `${email}|exchange|${Date.now() + 120_000}`;
      const tok = `${payload}.${createHmac('sha256', cfg.ssoExchangeSecret).update(payload).digest('hex')}`;
      res.writeHead(302, { Location: back + '?sso=' + encodeURIComponent(tok) });
      return res.end();
    }

    if (p === '/api/register' && req.method === 'POST') {
      const f = jsonBodyOr400(await body(req), res);
      if (f === null) return;
      if (!(await captchaGate(req, res, f))) return;
      const em = String(f.email || '').trim().toLowerCase();
      if (!VALID_EMAIL.test(em)) return json(res, 400, { error: 'invalid email' });
      if (String(f.password || '').length < 8) return json(res, 400, { error: 'password must be at least 8 characters' });
      const salt = randomBytes(16).toString('hex');
      try {
        // The PRIMARY KEY decides, not a read-then-write check that two
        // simultaneous signups could both pass.
        await q(`INSERT INTO users (email, salt, hash, signup_ip, last_ip, last_login)
                 VALUES (?,?,?,?,?,NOW())`,
                [em, salt, hashPw(f.password, salt), clientIp(req), clientIp(req)]);
      } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') return json(res, 409, { error: 'account already exists' });
        throw e;
      }
      const tok = sign(`${em}|${Date.now() + 7 * 864e5}`);
      res.writeHead(200, { 'Content-Type': 'application/json',
        'Set-Cookie': `mkt=${tok}; Path=/; Max-Age=${7 * 86400}; HttpOnly; Secure; SameSite=Lax` });
      return res.end(JSON.stringify({ ok: true, email: em }));
    }
    if (p === '/api/login' && req.method === 'POST') {
      const f = jsonBodyOr400(await body(req), res);
      if (f === null) return;
      if (!(await captchaGate(req, res, f))) return;
      const em = String(f.email || '').trim().toLowerCase();
      const accRows = await q(`SELECT salt, hash FROM users WHERE email = ?`, [em]);
      const acc = accRows[0];
      // Same generic message either way, so this cannot be used to enumerate
      // which emails have accounts.
      const bad = () => json(res, 401, { error: 'wrong email or password' });
      if (!acc) return bad();
      const h = Buffer.from(hashPw(f.password || '', acc.salt), 'hex');
      const w = Buffer.from(acc.hash, 'hex');
      if (h.length !== w.length || !timingSafeEqual(h, w)) return bad();
      // Where this customer comes back from. Best-effort and unawaited: a
      // bookkeeping write must never be able to stop someone signing in.
      q(`UPDATE users SET last_ip = ?, last_login = NOW() WHERE email = ?`,
        [clientIp(req), em]).catch(e => console.warn('[login] last_ip:', e.message));
      const tok = sign(`${em}|${Date.now() + 7 * 864e5}`);
      res.writeHead(200, { 'Content-Type': 'application/json',
        'Set-Cookie': `mkt=${tok}; Path=/; Max-Age=${7 * 86400}; HttpOnly; Secure; SameSite=Lax` });
      return res.end(JSON.stringify({ ok: true, email: em }));
    }
    if (p === '/api/logout') {
      res.writeHead(200, { 'Content-Type': 'application/json',
        'Set-Cookie': 'mkt=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax' });
      return res.end('{"ok":true}');
    }
    if (p === '/api/me') {
      if (!email) return json(res, 401, { error: 'not signed in' });
      const sold = await soldTodayUsd(email);
      const orders = await q(
        `SELECT order_id AS orderId, usd, address, quoted_pcn AS quotedPcn, status,
                created_at AS createdAt, invoice_url AS invoiceUrl
           FROM orders WHERE email = ? ORDER BY created_at DESC LIMIT 25`, [email]);
      const boughtPcn = await accountBoughtPcn(email);
      return json(res, 200, {
        email,
        buybackOpen: S.get('buybackOpen'),
        accountCapPcn: S.get('accountCapPcn'),
        accountCapDays: S.get('accountCapDays'),
        accountBoughtPcn: Number(boughtPcn.toFixed(8)),
        accountRemainingPcn: Number(Math.max(0, S.get('accountCapPcn') - boughtPcn).toFixed(8)),
        soldTodayUsd: Number(sold.toFixed(2)),
        sellCapUsd: SELL_CAP_USD_PER_DAY,
        sellRemainingUsd: Number((SELL_CAP_USD_PER_DAY - sold).toFixed(2)),
        orders,
      });
    }

    // ---- buy ----
    if (p === '/api/buy' && req.method === 'POST') {
      if (!email) return json(res, 401, { error: 'sign in first' });
      const f = jsonBodyOr400(await body(req), res);
      if (f === null) return;

      // No order the payment callback could not process (see checkIpnSchema).
      // First, before anything is priced or reserved: nothing else matters
      // while a payment for this order could not be handled.
      if (!ipnSchemaOk) {
        const missing = await checkIpnSchema();
        if (missing) {
          schemaAlert(missing);
          return json(res, 503, { error: 'orders are paused: payments cannot be processed right ' +
            'now. Nothing was reserved or charged. Try again shortly.', saleOpen: false });
        }
      }

      const usd = Number(f.usd);
      const addr = String(f.address || '').trim();
      if (!(usd >= S.get('minOrderUsd'))) return json(res, 400, { error: `minimum order is $${S.get('minOrderUsd')}` });
      if (!(usd <= S.get('maxOrderUsd'))) return json(res, 400, { error: `maximum order is $${S.get('maxOrderUsd')}` });
      if (!validAddress(addr)) return json(res, 400, { error: 'that is not a valid PCN address (must start pc1)' });

      // The interlock, checked before anything is reserved or any invoice is
      // raised. Fails closed by construction: saleGate() returns open:false
      // when it cannot read the rate at all.
      const gate = await saleGate(usd, email);
      if (!gate.open) return json(res, 503, { error: gate.reason, saleOpen: false });

      // Checked inside the transaction below as well; this is the cheap early
      // answer so a user with three unpaid orders gets a clear message instead
      // of a rolled-back one.
      //
      // IT RETURNS THE ORDERS THEMSELVES, not just a count. This used to answer
      // a bare 429 telling the customer to "pay or cancel one" when there was no
      // cancel route anywhere on the site, and no link to the invoice they had
      // already been given. 17 of the 30 genuinely-expired orders were the same
      // customer trying again in the same session -- and because their own unpaid
      // order still holds the cheap rungs, the retry is quoted 5.7-8.2% WORSE
      // than the attempt they abandoned. They are bidding against themselves and
      // the page never told them so.
      const pendingOrders = await q(
        `SELECT order_id AS orderId, usd, quoted_pcn AS quotedPcn, invoice_url AS invoiceUrl,
                created_at AS createdAt
           FROM orders WHERE email = ? AND status = 'pending'
          ORDER BY created_at DESC`, [email]);
      if (pendingOrders.length >= S.get('maxPendingOrders')) {
        return json(res, 429, {
          error: `you already have ${pendingOrders.length} unpaid order` +
            `${pendingOrders.length === 1 ? '' : 's'}. Finish paying it, or cancel it, before ` +
            (S.get('pricingMode') === 'index'
              // One price for everyone in index mode, so there are no "dearer
              // rungs" to be quoted from; the hold on the coins is the whole cost.
              ? `starting another — an unpaid order holds PCN nobody else can buy until it is ` +
                `paid, cancelled or expires.`
              : `starting another — an unpaid order holds PCN nobody else can buy, including you: ` +
                `your next order would be quoted from dearer rungs because of it.`),
          pendingOrders,
        });
      }

      // Rate, not just concurrency. maxPendingOrders bounds how many unpaid
      // orders exist at once, which one address walked straight around by
      // letting them expire and starting more: seven orders over two days,
      // ~$323 quoted, nothing ever paid. Every one of them reserved rungs, and
      // on 2026-09-03 three at once pushed the price a real buyer would pay past
      // the divergence limit and closed the market to everybody.
      //
      // Counts orders CREATED in the window whatever became of them -- expired
      // ones are exactly the churn being bounded, so excluding them would defeat
      // the check.
      const [{ recent }] = await q(
        `SELECT COUNT(*) recent FROM orders
          WHERE email = ? AND created_at > (NOW() - INTERVAL 1 HOUR)`, [email]);
      if (Number(recent) >= S.get('maxOrdersPerHour')) {
        // Deliberately counts cancelled orders too. Cancelling gives the RUNGS
        // back immediately, which is the expensive half; this counter bounds
        // churn against the ladder, and a cancel-and-retry loop is still churn.
        // Do not "fix" it to exclude them without re-reading the 2026-09-03
        // incident described just above.
        return json(res, 429, { error:
          `you have started ${recent} orders in the last hour, which is the limit. ` +
          `Try again later — each order holds PCN that nobody else can buy until it is paid ` +
          `or expires.` });
      }

      const orderId = 'M' + Date.now().toString(36) + randomBytes(3).toString('hex');

      // Reserve the inventory and write the order in ONE transaction, BEFORE
      // asking NOWPayments for an invoice. Two reasons, in order of how much
      // they cost:
      //
      //  1. The old sequence created the invoice first and inserted the order
      //     second. A crash or a dropped response in between left a live
      //     invoice with no order row -- the customer pays, the IPN arrives,
      //     and the handler logs 'unknown order ignored'. Money in, nothing
      //     recorded. Writing the order first cannot lose a payment; the worst
      //     case is an order with no invoice, which the sweeper expires.
      //  2. Two buyers must not be quoted the same rungs. The row locks taken
      //     inside reserveLadder are what serialise them.
      // How much PCN can still be promised. The ladder says what we have to
      // sell; this says what we can actually hand over. They are different
      // questions and both have to be yes.
      const backing = await B.headroomPcn();
      if (backing.pcn === null) {
        return json(res, 503, { error:
          'orders are paused: we cannot currently confirm the coin supply backing this sale, ' +
          'and selling something we cannot confirm we can deliver is not something we will do. ' +
          'Try again shortly.' });
      }

      let w;
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        w = await L.reserveLadder(conn, orderId, usd);

        // The coin cap, re-checked against the rungs as actually reserved. The
        // quote path checks it too, but that read happened outside this
        // transaction and the ladder may have moved underneath it.
        const over = tooMuchPcn(await L.rungsWithStock(conn), w.pcn);
        if (over) { await conn.rollback(); return json(res, 400, { error: over }); }

        // The cumulative per-account cap — the one that actually stops a single
        // buyer taking the ladder, since a per-order limit is defeated by
        // placing more orders. Locking read, inside this transaction.
        const capPcn = S.get('accountCapPcn');
        const already = await accountBoughtPcn(email, conn, true);
        if (already + w.pcn > capPcn) {
          await conn.rollback();
          const left = Math.max(0, capPcn - already);
          return json(res, 429, { error:
            `you have bought ${Math.round(already).toLocaleString()} PCN in the last ` +
            `${S.get('accountCapDays')} days, and the limit is ${capPcn.toLocaleString()}. ` +
            (left > 0
              ? `You can still buy ${Math.round(left).toLocaleString()} PCN — try a smaller amount.`
              : `Your allowance frees up as those orders pass ${S.get('accountCapDays')} days old.`),
            accountRemainingPcn: left });
        }

        // Re-checked INSIDE the transaction, against the obligations as they
        // stand right now: two orders placed a second apart must not both be
        // sold against the same coins.
        const owed = await B.outstandingOwed(conn, true);   // locking: see the note there
        if (w.pcn > backing.ownerPcn - owed) {
          await conn.rollback();
          const left = Math.max(0, backing.ownerPcn - owed);
          return json(res, 409, { error:
            `that is more PCN than we can deliver right now — ${left.toFixed(2)} PCN is ` +
            `available against undelivered orders. Try a smaller amount.` });
        }
        await conn.query(
          // Who placed this, and from where. The panel had the email but nothing
          // else, so an operator looking at a flagged order could not tell a
          // regular from a stranger, or two orders from one person behind two
          // addresses. clientIp is the same resolver the admin login uses: it
          // trusts CF-Connecting-IP only when the peer really is Cloudflare, so
          // what lands here cannot be set by the buyer.
          `INSERT INTO orders (order_id, email, usd, address, quoted_pcn, quoted_price, status,
                               ip, user_agent)
           VALUES (?,?,?,?,?,?, 'pending', ?, ?)`,
          [orderId, email, usd, addr, w.pcn.toFixed(8), w.avgPrice.toFixed(10),
           clientIp(req), String(req.headers['user-agent'] || '').slice(0, 255) || null]);

        // Spend the waiver inside the SAME transaction as the order. Outside it,
        // a crash between the two leaves either a waiver spent on no order or an
        // order that consumed nothing and could be repeated.
        if (gate.waived && gate.waiverId) {
          const took = await W.consume(gate.waiverId, orderId, conn);
          if (!took) throw new Error('that waiver was already used; nothing was ordered');
        }
        await conn.commit();
      } catch (e) {
        await conn.rollback();
        if (e.code === 409) return json(res, 409, { error: e.message });
        // Index mode: the index went stale between the gate and the reservation.
        // Rolled back above, so nothing is held and nothing will be invoiced.
        if (e.pricingRefusal && e.code === 503) return json(res, 503, { error: e.message, saleOpen: false });
        throw e;
      } finally { conn.release(); }

      let invoice;
      try { invoice = await npCreateInvoice({ usd, orderId, address: addr }); }
      catch (e) {
        // No invoice means nobody can pay this order, so the inventory must go
        // straight back rather than wait out the 24h sweep.
        await q(`UPDATE orders SET status='failed' WHERE order_id=? AND status='pending'`, [orderId]);
        await L.releaseLadder(orderId);
        // A customer just tried to buy and could not. Silent, this is the most
        // expensive kind of outage: every visitor bounces off the last step and
        // the market looks fine from the outside — the gate is open, the price
        // is current, and nothing is refusing anything except the one call that
        // takes money. Throttled, because if the gateway is down this fires for
        // every visitor.
        if (Date.now() - lastGatewayAlert >= 15 * 60 * 1000) {
          lastGatewayAlert = Date.now();
          notify(`🔴 <b>Payment gateway refused an order</b>\nA customer could not pay. ` +
            `The order was cancelled and its inventory released.\n` +
            `<code>${esc(String(e.message).slice(0, 250))}</code>\n` +
            `If this persists, nobody can buy — the site will not look broken.`).catch(() => {});
        }
        return json(res, 502, { error: `payment gateway: ${e.message}` });
      }
      await q(`UPDATE orders SET invoice_id=?, invoice_url=? WHERE order_id=?`,
              [invoice.id || null, invoice.invoice_url || null, orderId]);

      const willAutoSend = S.get('autoMaxUsd') > 0 && usd <= S.get('autoMaxUsd');

      // WHERE DID THIS COME FROM. Deliberately AFTER the order is committed:
      // the lookup is a network call and an order must never wait on one, nor
      // fail because a geo service is slow. geoFor() cannot throw and returns
      // null when it does not know, so every branch below is safe.
      const orderIp = clientIp(req);
      let orderGeo = null;
      try {
        orderGeo = await geoFor(orderIp, geoOpts());
        if (orderGeo) {
          // Snapshot it ON THE ORDER. The ip_geo cache says where that address
          // is today; this records where the order came from when it was
          // placed, which is the fact an operator needs a year from now.
          await q(`UPDATE orders SET geo_country=?, geo_city=?, geo_isp=? WHERE order_id=?`,
                  [orderGeo.country || null, orderGeo.city || null, orderGeo.isp || null, orderId])
            .catch(e => console.warn('[geoip] order snapshot:', e.message));
        }
      } catch (e) {
        console.warn('[geoip] order lookup:', e.message);
      }

      await notify(
        `🔵 <b>New order</b>\n<code>${orderId}</code>\n` +
        `$${usd.toFixed(2)} → <b>${w.pcn.toFixed(8)} PCN</b> @ ${w.avgPrice.toFixed(8)}\n` +
        `to <code>${addr}</code>\n` +
        `${email}\n` +
        `Delivery: <b>${willAutoSend ? 'automatic once paid' : 'MANUAL — you will send this one'}</b>\n` +
        `${geoLine(orderIp, orderGeo)}\n` +
        `Not paid yet — this is the order being created.`);

      return json(res, 200, {
        ok: true, orderId, invoiceUrl: invoice.invoice_url,
        autoDelivery: willAutoSend,
        // Say the waiting time before they pay, not after. Someone who expects
        // coins in a minute and waits a day feels defrauded even when nothing
        // went wrong.
        deliveryNote: willAutoSend
          ? 'Your PCN is sent automatically, usually within a minute of the payment confirming.'
          : `Orders above ${S.get('autoMaxUsd')} are released by hand: allow anywhere from a minute ` +
            `to 24 working hours after the payment confirms.`,
        quote: {
          pcn: w.pcn, effectivePrice: w.avgPrice, newPrice: w.marginalAfter,
          rungsConsumed: w.rungsConsumed, totalCost: Number(w.cost.toFixed(2)),
        },
      });
    }

    // ---- sell ----
    if (p === '/api/sell' && req.method === 'POST') {
      // Refused at the door, before the session is even read: a closed money
      // path should not be doing work, and hiding the panel while leaving the
      // endpoint live would be a payout route nobody is watching.
      if (!S.get('buybackOpen')) {
        return json(res, 503, { error:
          'buying back PCN is closed for now. market.pc.am is buy-only while the ladder ' +
          'is being proven. Nothing is lost — this reopens without any action from you.',
          buybackOpen: false });
      }
      if (!email) return json(res, 401, { error: 'sign in first' });
      const f = jsonBodyOr400(await body(req), res);
      if (f === null) return;
      const pcn = Number(f.pcn);
      if (!(pcn > 0)) return json(res, 400, { error: 'amount must be positive' });
      const quote = await jget(`${PRICE}/quote/sell?pcn=${pcn}`);
      const id = 'S' + Date.now().toString(36) + randomBytes(3).toString('hex');

      // The cap is checked and the row written in ONE transaction. Outside a
      // transaction two simultaneous requests both read "you have $20 left" and
      // both pass, which is how a daily limit becomes a suggestion.
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const already = await soldTodayUsd(email, conn, true);   // locking read
        if (already + quote.usd > SELL_CAP_USD_PER_DAY) {
          await conn.rollback();
          return json(res, 429, {
            error: `daily sell limit is $${SELL_CAP_USD_PER_DAY}. You have $${(SELL_CAP_USD_PER_DAY - already).toFixed(2)} left today.`,
            soldTodayUsd: already,
          });
        }
        await conn.query(`INSERT INTO sells (sell_id, email, pcn, usd) VALUES (?,?,?,?)`,
                         [id, email, pcn, quote.usd]);
        await conn.commit();
      } catch (e) { await conn.rollback(); throw e; }
      finally { conn.release(); }

      return json(res, 200, { ok: true, id, quote, depositTo: cfg.sellDepositAddress,
        note: 'Send the PCN to the address shown. Payout is released after it confirms.' });
    }

    // ---- cancel an unpaid order of your own ----
    //
    // The counterpart to the 429 above. Without it the site told people to
    // cancel and gave them no way to, so they abandoned instead -- and an
    // abandoned order holds its rungs for the full TTL, where a cancelled one
    // gives them back in the same second.
    //
    // The flip and the release happen inside ladder.expireWithRelease, which is
    // one transaction and the only implementation of this operation; the reason
    // that matters is written out in full there. Passing `owner` makes the
    // UPDATE the authorisation check and the race guard at once.
    //
    // It lands the order in 'expired', NOT a new 'cancelled' status, and that is
    // deliberate: the IPN handler still accepts a payment for an order in one of
    // ipn.mjs's UNPAID states ('pending','expired','failed','refunded') precisely
    // because a slow chain can confirm after a timeout. A status this rail's
    // money path does not know reads as a paid order, and a late payment would
    // sit with a human instead of reaching the buyer.
    if (req.method === 'POST' && p.startsWith('/api/order/') && p.endsWith('/cancel')) {
      if (!email) return json(res, 401, { error: 'sign in first' });
      const orderId = p.slice('/api/order/'.length, -'/cancel'.length);
      if (!/^[A-Za-z0-9]{1,40}$/.test(orderId)) return json(res, 400, { error: 'bad order id' });

      const out = await L.expireWithRelease(orderId, { owner: email, reason: 'cancelled by buyer' });
      if (!out.expired) {
        return json(res, 409, { error:
          'that order is not yours, or is no longer waiting to be paid. Nothing was changed.' });
      }
      return json(res, 200, { ok: true, orderId, released: out.released, note:
        'Cancelled. The PCN it was holding is back on sale. If you have already sent payment ' +
        'for it, it will still be credited — send nothing more.' });
    }

    // ---- pages ----
    if (p === '/' || p.startsWith('/order/')) {
      return res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' })
        && res.end(shell('Buy PCoin',
             readFileSync('/opt/pcoin-market/index.html', 'utf8')
               .replace('<!--HCAPTCHA-->', HCAPTCHA_TAG)));
    }
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    // A REFUSAL from the pricing engine, not a crash: in index mode ladder.mjs
    // throws code 503 when the index cannot be vouched for (and 400 for an
    // amount it cannot price). The buyer gets that answer, and the operator is
    // not paged "request crashed on a money path" for what is the market
    // correctly declining to sell -- the gate watcher already reports the
    // closure itself, once, with the reason. Keyed on ladder.mjs's own tag, not
    // on the number: anything else that happens to carry a code still falls
    // through to the crash alert below.
    if (e.pricingRefusal && (e.code === 503 || e.code === 400)) {
      return json(res, e.code, { error: e.message, ...(e.code === 503 ? { saleOpen: false } : {}) });
    }
    console.error('[market]', e.stack || e.message);
    // A throw inside /ipn is the expensive one: the money path. It can land
    // between recording the payment and delivering, leaving a paid order that
    // nothing will pick up, and the gateway retrying against a request that
    // fails the same way every time. Alert on the money paths only — a 500 on
    // a page request is noise, and this handler is publicly reachable.
    // /api/order/*/cancel is on this list because it MOVES LADDER INVENTORY.
    // A throw inside it, after the status flip but before the release, is the
    // orphaned-reservation shape the sweeper has to reconcile later.
    if (p === '/ipn' || p === '/api/buy' || p.startsWith('/order/') ||
        (p.startsWith('/api/order/') && p.endsWith('/cancel'))) {
      if (Date.now() - lastCrashAlert >= 10 * 60 * 1000) {
        lastCrashAlert = Date.now();
        notify(`🔴 <b>Request crashed on a money path</b>\n<code>${esc(p)}</code>\n` +
          `<code>${esc(String(e.message).slice(0, 300))}</code>\n` +
          (p === '/ipn'
            ? `A payment callback failed. Check for a paid order stuck in <b>pending</b>.`
            : `Check the order and the ladder reservations.`)).catch(() => {});
      }
    }
    return json(res, 500, { error: e.message });
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`pcoin-market on 127.0.0.1:${PORT}`);
  // Say which state it is in every start. "The captcha is on" must never be
  // something anyone infers from the config file they think they deployed.
  if (HCAPTCHA_ON) console.log('  hCaptcha ON for /api/register and /api/login');
  else console.warn('[market] WARNING: hCaptcha is OFF -- hcaptchaSitekey and ' +
                    'hcaptchaSecret are not both set in config.json. Signup does not ' +
                    'verify email either, so an account currently costs a made-up string.');
});

// Nothing should ever reach these. If something does, the process is in an
// undefined state and the operator must hear about it before the box quietly
// keeps serving from it.
process.on('unhandledRejection', r => {
  console.error('[market] unhandled rejection:', r);
  notify(`🔴 <b>Unhandled rejection</b>\n<code>${esc(String(r?.message || r).slice(0, 300))}</code>`)
    .catch(() => {});
});
process.on('uncaughtException', e => {
  console.error('[market] uncaught exception:', e.stack || e.message);
  notify(`🚨 <b>Uncaught exception — the market process may be dead</b>\n` +
    `<code>${esc(String(e.message).slice(0, 300))}</code>`).catch(() => {});
});
