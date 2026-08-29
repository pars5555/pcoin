#!/usr/bin/env node
// Overnight watch for market.pc.am.
//
// The market already announces the things that HAPPEN: a new order, a payment
// that landed and needs sending by hand, an underpayment, a crash, sales
// opening or closing. What it does not do is repeat itself. A single "manual
// delivery needed" at 03:00 is one notification, and a person who is asleep
// gets exactly one chance to see it.
//
// So this nags. Any order that has been PAID and not yet delivered is
// re-reported every NAG_MINUTES until it is dealt with. Customer money sitting
// undelivered is the one state where being annoying is correct.
//
// It also answers the question nothing else on this box answers: is the market
// actually reachable from the internet? The process being up and the site being
// up are different claims -- systemd restarts the process, Cloudflare and Caddy
// sit in front of it, and a 502 to real customers looks perfectly healthy from
// in here.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import mysql from 'mysql2/promise';

const CFG   = JSON.parse(readFileSync('/opt/pcoin-market/config.json', 'utf8'));
const STATE = '/var/lib/pcoin-market-watch/state.json';
const NAG_MINUTES   = 45;    // re-report an undelivered paid order this often
const DOWN_NAG_MIN  = 30;    // re-report an unreachable market this often
const PAID_STATES   = ['awaiting_delivery', 'needs_review'];

function alertCfg() {
  const out = {};
  try {
    for (const line of readFileSync('/etc/pcoin/alert.conf', 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (e) { console.error('[watch] cannot read alert.conf:', e.message); }
  return out;
}
const A = alertCfg();
const TOKEN = A.TELEGRAM_TOKEN;
const CHAT  = CFG.telegramChatId || A.MARKET_CHAT || A.ALERT_CHAT;

async function tg(text) {
  if (!TOKEN || !CHAT) { console.log('[watch:no-telegram]', text.replace(/<[^>]+>/g, '')); return false; }
  try {
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT, text: `<b>market.pc.am</b>\n${text}`,
                             parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) console.error('[watch] telegram', r.status, (await r.text()).slice(0, 160));
    return r.ok;
  } catch (e) { console.error('[watch] telegram failed:', e.message); return false; }
}

let st = { nagged: {}, downSince: null, lastDownNag: 0 };
try { st = { ...st, ...JSON.parse(readFileSync(STATE, 'utf8')) }; } catch { /* first run */ }
const save = () => {
  try { mkdirSync('/var/lib/pcoin-market-watch', { recursive: true }); writeFileSync(STATE, JSON.stringify(st)); }
  catch (e) { console.error('[watch] cannot save state:', e.message); }
};

const now = Date.now();
const mins = ms => Math.round(ms / 60000);

// ── 1. is the market reachable from the PUBLIC internet? ────────────────────
// Deliberately the public URL and not 127.0.0.1. Those are different claims and
// only one of them is the one a customer makes.
let reachable = null;   // null = could not tell, which is NOT the same as down
try {
  const r = await fetch('https://market.pc.am/api/ladder/state', { signal: AbortSignal.timeout(20000) });
  reachable = r.ok;
  if (r.ok) await r.json();          // must be parseable, not merely 200
} catch (e) {
  reachable = false;
  console.error('[watch] public fetch failed:', e.message);
}

if (reachable === false) {
  if (!st.downSince) st.downSince = now;
  if (now - (st.lastDownNag || 0) > DOWN_NAG_MIN * 60000) {
    st.lastDownNag = now;
    await tg(`🔴 <b>Market unreachable from the internet</b>\n` +
             `https://market.pc.am/api/ladder/state is not answering.\n` +
             `Down for about ${mins(now - st.downSince)} min. Customers cannot buy.\n` +
             `The process may still be up — check Caddy and Cloudflare, not just systemd.`);
  }
} else if (reachable === true && st.downSince) {
  await tg(`🟢 <b>Market reachable again</b>\nAfter about ${mins(now - st.downSince)} min.`);
  st.downSince = null; st.lastDownNag = 0;
}

// ── 2. paid orders that nobody has delivered ────────────────────────────────
// This is the money question. An order here means a customer has paid and is
// waiting; the market said so once, and this keeps saying so.
let pool;
try {
  pool = mysql.createPool(CFG.db);
  const [rows] = await pool.query(
    `SELECT order_id, usd, quoted_pcn, address, status, paid_at, delivery_mode,
            TIMESTAMPDIFF(MINUTE, paid_at, NOW()) AS waited
       FROM orders
      WHERE status IN (?) AND delivered_txid IS NULL
      ORDER BY paid_at ASC`, [PAID_STATES]);

  for (const o of rows) {
    const last = st.nagged[o.order_id] || 0;
    const waited = o.waited ?? 0;
    if (waited < 15) continue;                       // give the auto path a chance first
    if (now - last < NAG_MINUTES * 60000) continue;  // already nagged recently
    st.nagged[o.order_id] = now;
    await tg(
      `🟠 <b>STILL UNDELIVERED — customer is waiting</b>\n` +
      `<code>${o.order_id}</code>\n` +
      `$${Number(o.usd).toFixed(2)} → <b>${Number(o.quoted_pcn).toFixed(8)} PCN</b>\n` +
      `to <code>${o.address}</code>\n\n` +
      `Paid ${waited} min ago, status <code>${o.status}</code>` +
      (o.delivery_mode ? ` (${o.delivery_mode})` : '') + `.\n` +
      `Open <b>market.pc.am/admin → Orders</b> and press <b>Send</b> — it pays from the hot wallet and records it in one step.`);
  }

  // Forget orders that are no longer waiting, so the state file cannot grow
  // without bound and a re-used id cannot inherit an old timestamp.
  const live = new Set(rows.map(r => r.order_id));
  for (const k of Object.keys(st.nagged)) if (!live.has(k)) delete st.nagged[k];

  // ── 3. one-line heartbeat to the log (NOT telegram — that would be noise) ──
  const [[c]] = await pool.query(
    `SELECT
       SUM(status='pending') pending,
       SUM(status IN ('awaiting_delivery','needs_review')) undelivered,
       SUM(status='delivered') delivered
     FROM orders`);
  console.log(`[watch] reachable=${reachable} pending=${c.pending || 0} ` +
              `undelivered=${c.undelivered || 0} delivered=${c.delivered || 0}`);
} catch (e) {
  // A database we cannot read is not "no orders waiting". Say so, once per nag
  // window, rather than reporting a clean sweep we never performed.
  console.error('[watch] db error:', e.message);
  if (now - (st.lastDbNag || 0) > DOWN_NAG_MIN * 60000) {
    st.lastDbNag = now;
    await tg(`🔴 <b>Market watch cannot read the database</b>\n` +
             `<code>${String(e.message).slice(0, 180)}</code>\n` +
             `Undelivered orders are NOT being checked. This is a blind spot, not an all-clear.`);
  }
} finally {
  if (pool) await pool.end().catch(() => {});
}

save();
