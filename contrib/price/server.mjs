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

import { createServer } from 'node:http';
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https';
import { readFileSync, writeFileSync, existsSync, renameSync,
         openSync, closeSync, fsyncSync } from 'node:fs';
import { dirname } from 'node:path';
import { timingSafeEqual, createHash, X509Certificate } from 'node:crypto';

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
async function notify(html) {
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
// The lowest rate the walk can stand on. Only used to escape serviceRate = 0,
// which a multiplicative clamp can otherwise never leave.
const SERVICE_RATE_FLOOR = 1e-8;
// How far above serviceCeiling a reported ladder price may be before it is
// treated as a fault rather than a price. The ceiling is the ladder's last rung,
// so anything above it is already impossible; the factor is slack for a future
// ceiling change landing before the ladder is regenerated.
const LADDER_SANITY_FACTOR = 2;
const LADDER = 'http://127.0.0.1:8789/api/ladder/state';   // market.pc.am, same box

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
  // rung is +9.75%, so one step is almost exactly one rung: in normal trading
  // serviceRate keeps up with the ladder, but a buyer who sweeps thirty rungs
  // at once (+1,700%) moves it 10% an hour and a human has time to look. Set
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
const retuneTarget = () => (ladderKnown() ? st.ladderPrice : null);

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
      await notify(`💱 <b>serviceRate moved</b>\n` +
        `<code>${before.serviceRate}</code> → <b><code>${tune.serviceRate}</code></b>\n` +
        `ladder ${st.ladderPrice} · ceiling ${st.serviceCeiling} · max move ${st.serviceMaxMovePct}%\n` +
        `Every service that credits PCN deposits reads this number and uses the new rate from now on.`);
    }
    return { ok: true, ...tune };
  } catch (e) {
    console.warn('[price] ladder poll failed, keeping last known price:', e.message);
    // The last known price stands, which is correct — but if the market service
    // stays unreachable the posted price silently ages, and `stale` is only
    // visible to whoever reads the JSON. Say it once per hour rather than on
    // every failed poll.
    if (Date.now() - lastPollAlert >= 60 * 60 * 1000) {
      lastPollAlert = Date.now();
      await notify(`🟠 <b>Ladder unreachable</b>\nThe price is frozen at the last known ` +
        `figure (${st.ladderPrice}). Nothing is wrong with the number — it is just ` +
        `no longer being refreshed.\n<code>${String(e.message).slice(0, 200)}</code>`);
    }
    return { ok: false, why: e.message };
  }
}
if (ROLE === 'primary') {
  await pollLadder();
  setInterval(pollLadder, 60000);
}
// Replicas need no poll of their own: they take ladderPrice, serviceRate and
// the clock stamps wholesale from the primary's /state, so all three origins
// answer with the same number. A replica that polled the ladder itself could
// not reach it anyway -- the market runs on the primary's loopback.

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
 *    - the hard ceiling, which is the ladder's terminal price */
function retuneServiceRate(force = false) {
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
    if (p === '/' || p === '/price') {
      const ladderAgeS = st.ladderAt ? Math.floor((Date.now() - st.ladderAt) / 1000) : null;
      return json(res, 200, {
        // The posted price is the ladder's marginal rung -- the price at which
        // the next PCN can actually be bought. `buybackPrice` is the AMM curve
        // and is what a sell-back pays; they are different numbers on purpose
        // and a consumer must not use one for the other.
        price: Number(postedPrice().toFixed(9)),
        serviceRate: st.serviceRate,
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
        reserve: Number(st.reserve.toFixed(6)),
        poolSupply: Number(st.supply.toFixed(6)),
        feeBps: st.feeBps,
        ladder: ladderKnown() ? {
          price: st.ladderPrice,
          soldPcn: st.ladderSoldPcn,
          remainingPcn: st.ladderRemainingPcn,
          ageSeconds: ladderAgeS,
          // Remembered rather than current. Still the best answer available --
          // but say so, rather than let a consumer assume it is fresh.
          stale: ladderAgeS === null || ladderAgeS > 600,
        } : null,
        // Stated so nobody mistakes a posted price for a market price.
        note: 'Posted from a finite 100,000 PCN order-book ladder, not discovered on a market. ' +
              'PCN is not exchange traded; its wrapped form wPCN trades in a small PancakeSwap ' +
              'pool that a keeper holds to THIS rate, so that pool follows this feed and must ' +
              'not be read as a price. ' +
              (st.buybackOpen
                ? 'Buying PCN back is a separate constant-product curve at a much lower price.'
                : 'This service is not buying PCN back at present; the way out is to wrap PCN ' +
                  'into wPCN at https://wrapdesk.pc.am and sell that pool.'),
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
      };
      const pending = {};
      for (const [key, bound] of Object.entries(BOUNDS)) {
        if (b[key] === undefined) continue;
        const n = Number(b[key]);
        if (!isFinite(n) || n < bound.min || n > bound.max) {
          return json(res, 400, {
            error: `${key} must be a finite number in [${bound.min}, ${bound.max}], got ${JSON.stringify(b[key])}` });
        }
        pending[key] = n;
      }
      Object.assign(st, pending);       // all-or-nothing: never a half-applied write
      save(st);
      return json(res, 200, { ok: true, price: postedPrice(), applied: pending });
    }

    // Force one retune step now, ignoring the interval but NOT the +/-10% clamp
    // or the ceiling. This is the operator's throttle for the walk from 0.001 to
    // the ladder price: call it repeatedly to advance a step at a time, and
    // watch four products' credit rates move with it.
    if (p === '/admin/retune' && req.method === 'POST') {
      if (ROLE !== 'primary') return json(res, 409, { error: 'this is a replica; write to the primary' });
      if (!isAdmin(req)) return json(res, 401, { error: 'admin token required' });
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

    // Full curve state, so a replica can mirror it. Public: it is the same
    // numbers /price already exposes, just complete.
    if (p === '/state') {
      // ALLOWLIST, not a denylist. This endpoint is public through Cloudflare,
      // and a denylist of one key was publishing `upstream` — the primary's
      // real origin IP, which the proxy exists to hide — together with the SNI
      // and the exact key pin a replica authenticates it with. Anything added
      // to the state in future is private until it is named here.
      const pub = {};
      for (const kk of ['reserve','supply','feeBps','dailySellCapUsd','serviceRate',
                        'serviceMaxMovePct','serviceCeiling','serviceRetuneIntervalHours',
                        'serviceRateAt','ladderPrice','ladderAt','ladderSoldPcn',
                        'ladderRemainingPcn','soldToday','day','history','role']) {
        if (st[kk] !== undefined) pub[kk] = st[kk];
      }
      return json(res, 200, pub);
    }

    if (p === '/history') return json(res, 200, { history: st.history.slice(-100) });
    return json(res, 404, { error: 'not found', endpoints: ['/price','/quote/buy?usd=','/quote/sell?pcn=','/history'] });
  } catch (e) {
    return json(res, e.code || 400, { error: e.message });
  }
}).listen(PORT, '127.0.0.1', () => console.log(`pcoin-price on 127.0.0.1:${PORT}`));
