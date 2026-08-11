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
//   2. Delivery is idempotent on the NOWPayments payment_id, under a UNIQUE
//      index. NOWPayments retries callbacks; a retry must never send twice.
//   3. The destination address is validated LOCALLY (bech32 checksum + `pc`
//      hrp) before an order is accepted, not after taking the money.
//
// LIMITS
//   min order      $10
//   sell cap       $20 per user per day (a global backstop also lives in the
//                  price oracle, so one compromised account cannot drain it)
//
// Payouts are NOT automatic in this version. A confirmed purchase is recorded
// as `awaiting_delivery` and an operator releases it. That keeps a spending key
// off this box entirely until the flow has been watched working with real money.

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
function validAddress(addr) {
  if (typeof addr !== 'string') return false;
  const s = addr.trim();
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

// ── the ladder ─────────────────────────────────────────────────────────────
// The engine lives in ladder.mjs so it can be exercised against a real database
// without starting an HTTP server or touching NOWPayments. The race it has to
// survive -- two buyers landing on one rung -- is the same race the $20/day cap
// already lost once when it was a JSON file, and an engine you cannot run in
// isolation is an engine nobody re-tests after changing it.
import { makeLadder } from './ladder.mjs';
const L = makeLadder(pool);
setInterval(L.sweepExpiredOrders, 15 * 60 * 1000).unref?.();

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

const alertCfg = readNotifyConfig('/etc/pcoin/alert.conf');
const notify = makeNotifier({
  token: alertCfg.TELEGRAM_TOKEN,
  chatId: cfg.telegramChatId || alertCfg.MARKET_CHAT || alertCfg.ALERT_CHAT,
  prefix: '<b>market.pc.am</b>',
});

const node = makeNodeRpc({
  url: cfg.nodeRpcUrl || 'http://127.0.0.1:9443',
  cookiePath: cfg.nodeCookie || '/var/lib/pcoin/.cookie',
  walletName: cfg.hotWallet || 'market-hot',
});

const D = makeDelivery({ pool, node, notify, settings: S });
const B = makeBacking({
  pool,
  explorerUrl: cfg.explorerUrl || 'https://explorer.pc.am',
  ownerAddress: cfg.ownerAddress,
  settings: S,
  floatBalance: () => D.floatBalance(),
});

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
         `several orders, so no single buyer takes the ladder at the floor.`;
}

// ── admin panel ────────────────────────────────────────────────────────────
import { makeAdmin } from './admin.mjs';
const ADMIN = makeAdmin({ pool, cfg, settings: S, ladder: L, delivery: D, backing: B, notify });
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
async function saleGate() {
  // The master switch, checked first: an operator turning sales off means off,
  // regardless of what every other signal says.
  if (!S.get('saleOpen')) {
    return { open: false, reason: 'sales are paused by the operator.' };
  }
  const st = await L.ladderState();
  if (st.marginalPrice === null) {
    return { open: false, reason: 'the ladder is sold out — there is no more PCN to sell here.' };
  }
  const { rates, ageMs, error } = await publicServiceRates();
  if (!rates.length) {
    return { open: false, reason:
      `sales are paused: the rate oracle at price.pc.am cannot be read (${error}), ` +
      `so we cannot confirm that what you buy here is worth the same to the services that accept it.` };
  }
  // Measure against the price a buyer will ACTUALLY be charged, not only the
  // published one. `marginalPrice` counts sold rungs alone, so that
  // reservations cannot walk the public number up (see ladder.mjs). But that
  // means large pending reservations can leave the published price sitting next
  // to serviceRate while the next real fill happens several rungs higher — the
  // gate would read "in step" and sell at a price it never checked. Judge on
  // whichever of the two is further from the credit rate.
  const prices = [st.marginalPrice, st.nextFillPrice].filter(x => typeof x === 'number' && x > 0);
  const div = r => Math.max(...prices.map(pp => Math.abs(pp - r) / r * 100));
  const worst = rates.reduce((a, b) => (div(b) > div(a) ? b : a));
  const divergencePct = div(worst);
  const spread = rates.length > 1 && Math.min(...rates) !== Math.max(...rates)
    ? { oracleDisagrees: true, ratesSeen: [...new Set(rates)].sort() } : {};
  if (divergencePct > S.get('maxDivergencePct')) {
    const shown = Math.max(...prices.map(pp => Math.abs(pp - worst))) === Math.abs(st.marginalPrice - worst)
      ? st.marginalPrice : st.nextFillPrice;
    return { open: false, divergencePct, serviceRate: worst, marginalPrice: st.marginalPrice,
      nextFillPrice: st.nextFillPrice, ...spread,
      reason:
      `sales are paused: the ladder price ($${shown.toFixed(6)}) and the rate the ` +
      `services credit PCN at ($${worst.toFixed(6)}) have drifted ${divergencePct.toFixed(1)}% apart, ` +
      `past the ${S.get('maxDivergencePct')}% limit. Selling into that gap would shortchange you. ` +
      `This clears itself once the two are back in step.` };
  }
  return { open: true, divergencePct, serviceRate: worst, marginalPrice: st.marginalPrice,
           nextFillPrice: st.nextFillPrice, rateAgeMs: ageMs, ...spread };
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
      cancel_url: `${cfg.publicUrl}/`,
    }),
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.message || `NOWPayments ${r.status}`);
  return j;
}

/** NOWPayments signs the IPN body with HMAC-SHA512 over the JSON with keys
 *  sorted. Anything that does not verify is discarded without touching an
 *  order — a callback is a claim, not a fact, until the signature says so. */
function ipnValid(rawBody, sigHeader) {
  if (!sigHeader || !cfg.ipnSecret) return false;

  // Re-serialise with keys sorted, but preserve each value's ORIGINAL source
  // text. JSON.stringify would render 10.0 as "10" and 1e3 as "1000", and the
  // HMAC would then be computed over a different string than the sender signed
  // -- so every payment with a round amount would be rejected as a bad
  // signature. That failure is silent and looks like an attack, which is the
  // worst possible way to lose real payments. The reviver's `context.source`
  // (Node 21+) gives the literal as it arrived.
  let raws;
  try {
    // Record TOP-LEVEL keys only. The reviver visits every key at every depth
    // and walks bottom-up, so a nested object whose child shared a top-level
    // key name would overwrite the real entry and change the string being
    // signed -- silently rejecting a legitimate callback. The payload is flat
    // today; this stops it mattering if that ever changes.
    //
    // The root cannot be identified while descending, so every entry is tagged
    // with the object that holds it and filtered at the end: the reviver's
    // final call is `k === ''`, and its `v` IS the finished root.
    const seen = [];
    let rootObj = null;
    JSON.parse(rawBody, function (k, v, ctx) {
      if (this === undefined) return v;
      if (k === '') { rootObj = v; return v; }
      seen.push({ holder: this, key: k,
                  src: ctx && ctx.source !== undefined ? ctx.source : JSON.stringify(v) });
      return v;
    });
    if (rootObj === null || typeof rootObj !== 'object' || Array.isArray(rootObj)) return false;
    raws = new Map();
    for (const e of seen) if (e.holder === rootObj) raws.set(e.key, e.src);
  } catch { return false; }

  const canonical = '{' + [...raws.keys()].sort()
    .map(k => JSON.stringify(k) + ':' + raws.get(k)).join(',') + '}';
  const want = createHmac('sha512', cfg.ipnSecret).update(canonical).digest('hex');
  const a = Buffer.from(want), b = Buffer.from(String(sigHeader));
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── pages ──────────────────────────────────────────────────────────────────
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const CSS = readFileSync('/opt/pcoin-market/style.css', 'utf8');
const shell = (title, b) => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>${CSS}</style></head><body>${b}</body></html>`;

// ── server ─────────────────────────────────────────────────────────────────
createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
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
    if (p === '/ipn' && req.method === 'POST') {
      const raw = await body(req);
      if (!ipnValid(raw, req.headers['x-nowpayments-sig'])) {
        console.warn('[ipn] REJECTED bad signature');
        return json(res, 401, { error: 'bad signature' });
      }
      const d = JSON.parse(raw);

      // Record the event. The UNIQUE(payment_id, status) key stops the same
      // callback being *logged* twice.
      //
      // What it must NOT do is skip the work. This row is written before any
      // order or ladder change, so if the handler then died -- a deadlock in
      // settleLadder, a dropped connection, a restart mid-request -- the retry
      // NOWPayments sends would hit the duplicate key, be answered
      // `200 {ok:true}`, and the payment would never be applied at all. The
      // gateway would consider it delivered and stop retrying. That is a paid
      // order silently lost.
      //
      // So a duplicate is not an early return: it falls through and repeats the
      // work, which is safe precisely because every step below is idempotent --
      // the orders UPDATE is guarded on status and settleLadder only ever moves
      // rows still marked 'reserved'.
      let duplicate = false;
      try {
        await q(`INSERT INTO ipn_events (payment_id, order_id, status, raw) VALUES (?,?,?,?)`,
                [String(d.payment_id), d.order_id ?? null, String(d.payment_status), raw.slice(0, 60000)]);
      } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') duplicate = true;
        else throw e;
      }

      // `d.order_id ?? null` above, and the same here: mysql2 rejects an
      // `undefined` bind with "Bind parameters must not contain undefined",
      // which would throw into the 500 handler and make NOWPayments retry a
      // callback that can never succeed.
      const rows = await q(`SELECT order_id, status FROM orders WHERE order_id = ?`,
                           [d.order_id ?? null]);
      if (!rows.length) return json(res, 200, { ok: true, note: 'unknown order ignored', duplicate });

      if (['finished', 'confirmed'].includes(d.payment_status)) {
        // A human releases the coins; this only records that payment landed.
        // 'expired' is accepted here too: the sweeper may have timed the order
        // out minutes before a slow chain confirmed it, and a payment that
        // arrived is a payment that arrived.
        await q(`UPDATE orders SET status='awaiting_delivery', paid_at=NOW(),
                        paid_amount=?, pay_currency=? WHERE order_id=? AND status IN ('pending','expired')`,
                [d.actually_paid ?? d.pay_amount ?? null, d.pay_currency || null, d.order_id]);

        // Settle unconditionally rather than only when the UPDATE moved a row:
        // settleLadder is idempotent, so this also repairs the case where a
        // previous delivery of this callback set the status and then died
        // before the ladder was written.
        const moved = await L.settleLadder(d.order_id);
        if (moved === 0) {
          const [{ c }] = await q(
            `SELECT COUNT(*) c FROM ladder_fills WHERE order_id = ? AND state = 'sold'`, [d.order_id]);
          if (!Number(c)) {
            // Paid, but no inventory is backing it -- the reservation was
            // released before the money landed. Do NOT silently re-price the
            // order at today's rungs and do NOT quietly drop it: the customer
            // paid the quoted amount.
            //
            // A log line is not enough. The operator releasing coins works from
            // the orders table, where this looked like any other
            // `awaiting_delivery` row -- so the same rungs could be handed out
            // twice, once here and once to whoever bought them after the
            // release. The state has to be visible where the decision is made.
            await q(`UPDATE orders SET status='needs_review' WHERE order_id=?`, [d.order_id]);
            console.error(`[ladder] UNBACKED PAID ORDER ${d.order_id} -- reservation was ` +
                          `released before payment confirmed. Marked needs_review. DO NOT DELIVER ` +
                          `until someone has decided what this customer is owed.`);
          }
        }

        // The amount is recorded but nothing compared it to what was ordered.
        // Delivery is manual, so this is a flag for the human rather than a
        // gate -- but an underpayment that reaches an operator unannounced is
        // an operator about to hand over coins that were not paid for.
        // Both figures are in `pay_currency` — `actually_paid` against the
        // `pay_amount` that was asked for. Do NOT compare against
        // `price_amount`, which is denominated in USD: for anyone paying in a
        // coin worth more or less than a dollar that comparison is meaningless
        // in both directions, and it would fire constantly or never.
        const paid = Number(d.actually_paid ?? NaN);
        const wanted = Number(d.pay_amount ?? NaN);
        let underpaid = false;
        if (isFinite(paid) && isFinite(wanted) && wanted > 0 && paid < wanted * 0.99) {
          underpaid = true;
          console.error(`[ipn] UNDERPAID ${d.order_id}: ${paid} of ${wanted} ${d.pay_currency || ''}. ` +
                        `Marked needs_review.`);
          await q(`UPDATE orders SET status='needs_review' WHERE order_id=? AND status='awaiting_delivery'`,
                  [d.order_id]);
          await notify(`🔴 <b>Underpaid</b>\n<code>${d.order_id}</code>\n` +
                       `Paid ${paid} of ${wanted} ${d.pay_currency || ''}. Marked needs_review — ` +
                       `nothing was sent.`);
        }

        // Hand it to delivery: small orders send themselves, larger ones queue
        // and message the operator. deliver() never throws — a delivery problem
        // must not turn into a non-200 that makes NOWPayments retry a payment
        // we have already recorded.
        if (!underpaid) await D.deliver(d.order_id);
      } else if (['failed', 'expired', 'refunded'].includes(d.payment_status)) {
        // Guarded on 'pending', exactly like the success branch is. Unguarded,
        // a late 'expired' callback for an earlier attempt overwrote an order
        // that a LATER payment had already moved to 'awaiting_delivery' — the
        // customer's paid order silently reverting to a failed one. A different
        // status is a different row under UNIQUE(payment_id, status), so the
        // dedup key does not stop this.
        const r = await q(`UPDATE orders SET status=? WHERE order_id=? AND status='pending'`,
                          [d.payment_status, d.order_id ?? null]);
        if (r.affectedRows === 1) {
          // Give the rungs back. Only touches 'reserved' rows, so a refund
          // after delivery cannot un-sell inventory.
          await L.releaseLadder(d.order_id);
        } else {
          console.warn(`[ipn] ${d.payment_status} for ${d.order_id} ignored — the order is ` +
                       `no longer pending. Inventory left alone.`);
        }
      }
      return json(res, 200, { ok: true });
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
      const gate = await saleGate();
      return json(res, 200, {
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
      return json(res, 200, {
        ...(await L.ladderState()),
        minOrderUsd: S.get('minOrderUsd'),
        maxOrderUsd: S.get('maxOrderUsd'),
        maxOrderPcn: capPcn,
        maxOrderUsdNow: capUsd,
        autoMaxUsd: S.get('autoMaxUsd'),
      });
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
      return json(res, 200, {
        requestedPcn: pcn,
        filledPcn: w.pcn,
        unfilledPcn: w.pcnUnfilled,          // > 0 means the ladder ran out
        totalCost: Number(w.cost.toFixed(2)),
        averagePrice: w.avgPrice,
        rungsConsumed: w.rungsConsumed,
        priceBefore: st.nextFillPrice,
        marginalPriceAfter: w.marginalAfter,
        exhausted: w.exhausted,
      });
    }

    // ---- auth ----
    if (p === '/api/register' && req.method === 'POST') {
      const f = JSON.parse(await body(req));
      const em = String(f.email || '').trim().toLowerCase();
      if (!VALID_EMAIL.test(em)) return json(res, 400, { error: 'invalid email' });
      if (String(f.password || '').length < 8) return json(res, 400, { error: 'password must be at least 8 characters' });
      const salt = randomBytes(16).toString('hex');
      try {
        // The PRIMARY KEY decides, not a read-then-write check that two
        // simultaneous signups could both pass.
        await q(`INSERT INTO users (email, salt, hash) VALUES (?,?,?)`,
                [em, salt, hashPw(f.password, salt)]);
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
      const f = JSON.parse(await body(req));
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
      const f = JSON.parse(await body(req));
      const usd = Number(f.usd);
      const addr = String(f.address || '').trim();
      if (!(usd >= S.get('minOrderUsd'))) return json(res, 400, { error: `minimum order is $${S.get('minOrderUsd')}` });
      if (!(usd <= S.get('maxOrderUsd'))) return json(res, 400, { error: `maximum order is $${S.get('maxOrderUsd')}` });
      if (!validAddress(addr)) return json(res, 400, { error: 'that is not a valid PCN address (must start pc1)' });

      // The interlock, checked before anything is reserved or any invoice is
      // raised. Fails closed by construction: saleGate() returns open:false
      // when it cannot read the rate at all.
      const gate = await saleGate();
      if (!gate.open) return json(res, 503, { error: gate.reason, saleOpen: false });

      // Checked inside the transaction below as well; this is the cheap early
      // answer so a user with three unpaid orders gets a clear message instead
      // of a rolled-back one.
      const [{ pending }] = await q(
        `SELECT COUNT(*) pending FROM orders WHERE email = ? AND status = 'pending'`, [email]);
      if (Number(pending) >= S.get('maxPendingOrders')) {
        return json(res, 429, { error:
          `you already have ${pending} unpaid orders. Pay or cancel one before starting another — ` +
          `unpaid orders hold PCN that nobody else can buy.` });
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
        const owed = await B.outstandingOwed(conn);
        if (w.pcn > backing.ownerPcn - owed) {
          await conn.rollback();
          const left = Math.max(0, backing.ownerPcn - owed);
          return json(res, 409, { error:
            `that is more PCN than we can deliver right now — ${left.toFixed(2)} PCN is ` +
            `available against undelivered orders. Try a smaller amount.` });
        }
        await conn.query(
          `INSERT INTO orders (order_id, email, usd, address, quoted_pcn, quoted_price, status)
           VALUES (?,?,?,?,?,?, 'pending')`,
          [orderId, email, usd, addr, w.pcn.toFixed(8), w.avgPrice.toFixed(10)]);
        await conn.commit();
      } catch (e) {
        await conn.rollback();
        if (e.code === 409) return json(res, 409, { error: e.message });
        throw e;
      } finally { conn.release(); }

      let invoice;
      try { invoice = await npCreateInvoice({ usd, orderId, address: addr }); }
      catch (e) {
        // No invoice means nobody can pay this order, so the inventory must go
        // straight back rather than wait out the 24h sweep.
        await q(`UPDATE orders SET status='failed' WHERE order_id=? AND status='pending'`, [orderId]);
        await L.releaseLadder(orderId);
        return json(res, 502, { error: `payment gateway: ${e.message}` });
      }
      await q(`UPDATE orders SET invoice_id=?, invoice_url=? WHERE order_id=?`,
              [invoice.id || null, invoice.invoice_url || null, orderId]);

      const willAutoSend = S.get('autoMaxUsd') > 0 && usd <= S.get('autoMaxUsd');
      await notify(
        `🔵 <b>New order</b>\n<code>${orderId}</code>\n` +
        `$${usd.toFixed(2)} → <b>${w.pcn.toFixed(8)} PCN</b> @ ${w.avgPrice.toFixed(8)}\n` +
        `to <code>${addr}</code>\n` +
        `${email}\n` +
        `Delivery: <b>${willAutoSend ? 'automatic once paid' : 'MANUAL — you will send this one'}</b>\n` +
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
      const f = JSON.parse(await body(req));
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

    // ---- pages ----
    if (p === '/' || p.startsWith('/order/')) {
      return res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' })
        && res.end(shell('Buy PCoin', readFileSync('/opt/pcoin-market/index.html', 'utf8')));
    }
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('[market]', e.message);
    return json(res, 500, { error: e.message });
  }
}).listen(PORT, '127.0.0.1', () => console.log(`pcoin-market on 127.0.0.1:${PORT}`));
