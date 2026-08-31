#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// PCoin ops dashboard — private. Chain health, miner census, peers, fleet.
// ═══════════════════════════════════════════════════════════════════════════
//
// WHY THIS IS PRIVATE
// It links payout addresses to balances and to the operator's own fleet. That
// is exactly the deanonymisation surface the explorer deliberately does not
// offer: on this chain a deposit address IS a customer, and index order IS
// signup order. Never expose it, never let it be indexed.
//
// WHAT IT CANNOT TELL YOU, AND WHY
// "How many miners are there" is not answerable from a blockchain. A block
// records who was PAID, not who was mining. One person can rotate a fresh
// address per block; a pool of a hundred looks like one address; anyone who
// found nothing this window is invisible. Distinct payout addresses is a
// PROXY with those biases, and it is labelled as such in the UI rather than
// dressed up as a miner count.
//
// Peer IPs are a different measurement entirely: they are the nodes connected
// to our seed. A peer is not necessarily a miner, and nothing links a peer to
// the block it may have mined. The two panels are kept apart on purpose so
// they are not read as one number.
//
// LAYOUT
// One page per subject, a shared left rail, and numbered pagination on every
// listing. Every internal link is RELATIVE and every page sits exactly one
// path segment under the mount (./census, ./address?a=…) — that is what lets
// the app live under /admin/ without knowing it (see README, "the trailing
// slash is load-bearing"). Detail pages use query strings, not path segments,
// so relative resolution never changes depth.
//
// Listens on loopback only; Caddy terminates TLS and proxies.

import { createServer } from 'node:http';
import { createHash, randomBytes, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';

const CONFIG = '/opt/pcoin-ops/config.json';
const STATE  = '/opt/pcoin-ops/state.json';
const PORT   = 8787;
const EXPLORER = 'http://127.0.0.1:8080/api';   // the explorer runs on this box
const GATE = 2800;
const PER  = 25;                                 // rows per page, everywhere

const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));

// Addresses we know are ours. Anything else is reported as "not in your
// records" -- never as "a stranger", because only the owner can tell the
// difference between someone else's miner and their own forgotten config.
const FLEET = cfg.fleet || {};
const isPayment = label => String(label || '').startsWith('PAYMENT - ');

// ── auth ───────────────────────────────────────────────────────────────────
function hashPw(pw) {
  return scryptSync(pw, cfg.salt, 64, { ...cfg.scrypt }).toString('hex');
}
function checkPw(pw) {
  // Constant-time: a length-varying or early-exit compare leaks the prefix.
  const a = Buffer.from(hashPw(pw), 'hex');
  const b = Buffer.from(cfg.hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
function sign(payload) {
  const mac = createHmac('sha256', cfg.sessionSecret).update(payload).digest('hex');
  return `${payload}.${mac}`;
}
function verify(cookie) {
  if (!cookie) return false;
  const i = cookie.lastIndexOf('.');
  if (i < 0) return false;
  const payload = cookie.slice(0, i);
  const want = createHmac('sha256', cfg.sessionSecret).update(payload).digest('hex');
  const got = cookie.slice(i + 1);
  if (got.length !== want.length) return false;
  if (!timingSafeEqual(Buffer.from(got), Buffer.from(want))) return false;
  const exp = Number(payload.split('|')[1] || 0);
  return Date.now() < exp;
}

// Login throttle. Without it, a 12-character password is still guessable at a
// few thousand attempts a second over HTTP.
const attempts = new Map();
function throttled(ip) {
  const a = attempts.get(ip);
  if (!a) return false;
  if (Date.now() - a.first > 15 * 60e3) { attempts.delete(ip); return false; }
  return a.n >= 8;
}
function noteFail(ip) {
  const a = attempts.get(ip) || { n: 0, first: Date.now() };
  a.n++; attempts.set(ip, a);
}

// ── data ───────────────────────────────────────────────────────────────────
const cache = new Map();
async function j(url, ttl = 20e3) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < ttl) return hit.v;
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  const v = await r.json();
  cache.set(url, { at: Date.now(), v });
  return v;
}

/** Who won each of the last N blocks. Every block is counted ONCE:
 *
 *  A solo block's coinbase pays exactly one address, and that address gets
 *  the block. A POOL block's coinbase pays every recent worker (that is how
 *  this pool pays out), so the split coinbase itself is the signature: more
 *  than one addressed output means "the pool won this block", and it is
 *  attributed to the pool as one entity — NOT to each participant, which
 *  would count one block twenty times and drown the solo miners. The real
 *  workers behind the pool entity are on the ./pool page, from the pool's
 *  own share log.
 *
 *  Still a PROXY for solo miner count, not a miner count -- see the header. */
const POOL_KEY = '__pool__';
async function census(window = 200) {
  const st = await j(`${EXPLORER}/status`, 15e3);
  const tip = st.index.indexed_height;
  const key = `census:${tip}:${window}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 300e3) return hit.v;

  const counts = new Map();
  let read = 0;
  for (let h = tip; h > tip - window && h > 0; h--) {
    let b;
    try { b = await j(`${EXPLORER}/block/${h}/txs?limit=1`, 3600e3); } catch { continue; }
    const cb = (b.txs || [])[0];
    if (!cb) continue;
    read++;
    const paid = [...new Set((cb.outputs || [])
      .filter(o => o.address && (o.value_sat || 0) > 0).map(o => o.address))];
    if (paid.length > 1)      counts.set(POOL_KEY, (counts.get(POOL_KEY) || 0) + 1);
    else if (paid.length === 1) counts.set(paid[0], (counts.get(paid[0]) || 0) + 1);
  }
  const rows = [...counts.entries()]
    .map(([address, blocks]) => address === POOL_KEY
      ? { address, blocks, pool: true, mine: false, label: null }
      : { address, blocks, pool: false, mine: !!FLEET[address], label: FLEET[address] || null })
    .sort((a, b) => b.blocks - a.blocks);
  const total = rows.reduce((s, r) => s + r.blocks, 0) || 1;
  rows.forEach(r => { r.share = r.blocks / total; });
  const v = {
    tip, window, blocksRead: read, rows, total,
    distinct: rows.filter(r => !r.pool).length,
    poolBlocks: counts.get(POOL_KEY) || 0,
    yours: rows.filter(r => r.mine).reduce((s, r) => s + r.blocks, 0),
  };
  cache.set(key, { at: Date.now(), v });
  return v;
}

async function chain() {
  const st = await j(`${EXPLORER}/status`, 15e3);
  const blocks = await j(`${EXPLORER}/blocks?limit=60`, 15e3);
  const bs = blocks.blocks || blocks.items || [];
  const times = bs.map(b => b.time).filter(Boolean).sort((a, b) => a - b);
  const gaps = times.slice(1).map((t, i) => t - times[i]).filter(g => g > 0);
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted.length ? sorted[sorted.length >> 1] : null;
  const mean = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null;
  const tipBlock = bs[0] || {};
  const diff = Number(tipBlock.difficulty || 0);
  // Network hashrate from OBSERVED spacing, not the 600 s target -- using the
  // target would misstate it by however far the chain is from schedule.
  const hashrate = median && diff ? (diff * 2 ** 32) / median : null;
  return {
    height: st.index.indexed_height,
    status: st.index.status,
    blocksBehind: st.index.blocks_behind,
    blocksUnwound: st.index.blocks_unwound,
    peersSeenByExplorerNode: st.index.node_connections,
    tipAge: Math.max(0, Math.floor(Date.now() / 1000) - (st.index.indexed_time || 0)),
    difficulty: diff,
    medianSpacing: median,
    meanSpacing: mean ? Math.round(mean) : null,
    hashrate,
    gate: GATE,
    toGate: Math.max(0, GATE - st.index.indexed_height),
    lwmaActive: st.index.indexed_height >= GATE,
    mempool: st.mempool || null,
  };
}

async function fleetBalances() {
  const addrs = Object.keys(FLEET);
  if (!addrs.length) return [];
  const r = await fetch(`${EXPLORER}/addresses`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ addresses: addrs }), signal: AbortSignal.timeout(25000),
  });
  if (!r.ok) throw new Error(`addresses -> HTTP ${r.status}`);
  const d = await r.json();
  return (d.addresses || []).map(a => ({
    address: a.address,
    label: FLEET[a.address] || '',
    mature: a.balance.confirmed.mature_pcn,
    immature: a.balance.confirmed.immature_pcn,
    total: a.balance.confirmed.onchain_unspent_pcn,
    lifetime: a.balance.lifetime.received_pcn,
  })).sort((x, y) => Number(y.total) - Number(x.total));
}

/** One page of recent blocks, newest first, with the coinbase payout address
 *  of each displayed block. Page N is computed from the tip, so page numbers
 *  shift when the chain extends -- fine for an operator view. */
async function blocksList(pageNo) {
  const st = await j(`${EXPLORER}/status`, 15e3);
  const tip = st.index.indexed_height;
  const pages = Math.max(1, Math.ceil((tip + 1) / PER));
  const p = Math.min(Math.max(1, pageNo), pages);
  const before = tip - (p - 1) * PER + 1;   // exclusive upper bound
  const q = p === 1 ? '' : `&before_height=${before}`;
  const d = await j(`${EXPLORER}/blocks?limit=${PER}${q}`, p === 1 ? 15e3 : 300e3);
  const blocks = d.blocks || [];
  await Promise.all(blocks.map(async b => {
    // Same cache key the census uses, so this is usually already warm.
    try {
      const t = await j(`${EXPLORER}/block/${b.height}/txs?limit=1`, 3600e3);
      const paid = [...new Set(((t.txs || [])[0]?.outputs || [])
        .filter(o => o.address && (o.value_sat || 0) > 0).map(o => o.address))];
      b.poolPaid = paid.length > 1;            // split coinbase = a pool block
      b.miner = paid[0] ?? null;               // null: no addressed output (e.g. genesis)
    } catch { b.miner = undefined; }           // undefined: unreadable, NOT "none"
  }));
  return { tip, page: p, pages, blocks };
}

function readState() {
  if (!existsSync(STATE)) return {};
  try { return JSON.parse(readFileSync(STATE, 'utf8')); } catch { return {}; }
}

// ── html ───────────────────────────────────────────────────────────────────
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pcn = n => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dur = s => s == null ? '—' : s < 0 ? `−${dur(-s)}` : s < 90 ? `${s}s` : s < 5400 ? `${(s / 60).toFixed(1)}m` : `${(s / 3600).toFixed(1)}h`;
const short = a => a && a.length > 22 ? `${a.slice(0, 13)}…${a.slice(-6)}` : (a || '');
const intp = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : d; };

const CSS = `
:root{--bg:#0d0f14;--panel:#151823;--edge:#242938;--ink:#e8eaf2;--dim:#98a0b4;
      --accent:#8b5cf6;--teal:#2dd4bf;--warn:#fbbf24;--bad:#f87171;--good:#34d399;
      --mono:ui-monospace,"Cascadia Code",Menlo,Consolas,monospace}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
h1{font-size:19px;margin:0;letter-spacing:-.01em}
h2{font-size:15px;margin:0 0 12px;color:var(--dim);text-transform:uppercase;letter-spacing:.07em}
.muted{color:var(--dim);font-size:13px}
.layout{display:flex;min-height:100vh}
.sidebar{width:226px;flex-shrink:0;background:var(--panel);border-right:1px solid var(--edge);
         display:flex;flex-direction:column;position:sticky;top:0;height:100vh;overflow-y:auto}
.sb-logo{padding:18px 20px 14px;border-bottom:1px solid var(--edge)}
.sb-logo h2{margin:0;font-size:16px;color:var(--ink);text-transform:none;letter-spacing:-.01em}
.sb-logo small{color:var(--dim);font-size:11px}
.sidebar nav{flex:1;padding:8px 0 14px}
.sb-sec{padding:14px 20px 4px;color:var(--dim);font-size:10px;text-transform:uppercase;letter-spacing:.09em}
.sidebar nav a{display:block;padding:8px 20px;color:var(--ink);text-decoration:none;font-size:13.5px;
               border-left:3px solid transparent}
.sidebar nav a:hover{background:rgba(139,92,246,.06)}
.sidebar nav a.active{background:rgba(139,92,246,.13);border-left-color:var(--accent);color:#c4b5fd}
.sb-foot{padding:14px 20px;border-top:1px solid var(--edge);font-size:13px}
.sb-foot a{color:var(--dim)}
.main{flex:1;min-width:0;padding:22px 30px}
.tophead{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;
         border-bottom:1px solid var(--edge);padding-bottom:12px;margin-bottom:20px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(178px,1fr));gap:12px;margin-bottom:22px}
.card{background:var(--panel);border:1px solid var(--edge);border-radius:12px;padding:14px 16px}
.card .k{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.07em}
.card .v{font-size:24px;font-weight:650;margin-top:5px;letter-spacing:-.02em}
.card .s{color:var(--dim);font-size:12px;margin-top:3px}
.panel{background:var(--panel);border:1px solid var(--edge);border-radius:12px;padding:16px 18px;margin-bottom:22px}
.panel .more{float:right;font-size:12px}
table{width:100%;border-collapse:collapse;font-size:13.5px;display:block;overflow-x:auto}
th{text-align:left;color:var(--dim);font-weight:600;font-size:11px;text-transform:uppercase;
   letter-spacing:.06em;padding:7px 9px;border-bottom:1px solid var(--edge)}
td{padding:7px 9px;border-bottom:1px solid rgba(255,255,255,.045)}
tr:last-child td{border-bottom:0}
tr.total td{border-top:1px solid var(--edge);border-bottom:0;font-weight:700}
.mono{font-family:var(--mono);font-size:12.5px}
.num{text-align:right;font-variant-numeric:tabular-nums}
.tag{display:inline-block;padding:1px 7px;border-radius:999px;font-size:11px;font-weight:600}
.tag.you{background:rgba(45,212,191,.14);color:var(--teal)}
.tag.pay{background:rgba(139,92,246,.16);color:#c4b5fd}
.tag.other{background:rgba(255,255,255,.06);color:var(--dim)}
.ok{color:var(--good)} .warn{color:var(--warn)} .bad{color:var(--bad)}
.bar{height:5px;border-radius:3px;background:rgba(255,255,255,.07);overflow:hidden;margin-top:6px}
.bar>i{display:block;height:100%;background:linear-gradient(90deg,var(--accent),var(--teal))}
.note{border-left:3px solid var(--accent);background:rgba(139,92,246,.07);padding:11px 14px;
      border-radius:0 8px 8px 0;color:var(--dim);font-size:13px;margin:14px 0 0}
.note.warn{border-left-color:var(--warn);background:rgba(251,191,36,.07)}
a{color:var(--accent)}
.pager{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:14px;font-size:13px}
.pager a,.pager .cur,.pager .off,.pager .gap{padding:4px 10px;border-radius:7px}
.pager a{background:var(--panel);border:1px solid var(--edge);text-decoration:none}
.pager a:hover{border-color:var(--accent)}
.pager .cur{background:var(--accent);color:#0d0f14;font-weight:700}
.pager .off{color:var(--dim);opacity:.5}
.pager .gap{color:var(--dim)}
.wrap{max-width:1180px;margin:0 auto;padding:22px}
.login{max-width:340px;margin:14vh auto;padding:26px}
input,select{padding:10px 12px;border-radius:9px;border:1px solid var(--edge);
      background:var(--bg);color:var(--ink);font:inherit}
.login input{width:100%;margin-top:6px}
button{padding:10px;border-radius:9px;border:0;cursor:pointer;
       background:linear-gradient(135deg,var(--accent),var(--teal));color:#0d0f14;font-weight:700;font:inherit;font-weight:700}
.login button{margin-top:14px;width:100%}
@media(max-width:880px){
  .layout{flex-direction:column}
  .sidebar{width:100%;height:auto;position:static;border-right:0;border-bottom:1px solid var(--edge)}
  .sidebar nav{display:flex;flex-wrap:wrap;gap:2px;padding:6px 10px}
  .sb-sec{width:100%;padding:8px 10px 2px}
  .sidebar nav a{border-left:0;border-radius:7px;padding:6px 10px}
  .sidebar nav a.active{border-left:0}
  .sb-foot{display:none}
  .main{padding:16px}
}`;

function page(title, body) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<title>${esc(title)}</title><style>${CSS}</style></head><body>${body}</body></html>`;
}

const NAV = [
  ['Overview', [['.', 'dash', 'Dashboard']]],
  ['Chain',    [['./blocks', 'blocks', 'Blocks']]],
  ['Miners',   [['./census', 'census', 'Miner census'],
                ['./pool', 'pool', 'Pool miners']]],
  ['Network',  [['./peers', 'peers', 'Peers on the seed']]],
  ['Money',    [['./fleet', 'fleet', 'Fleet balances'],
                ['./payments', 'payments', 'Payment rails'],
                ['./wrap', 'wrap', 'Wrap desk']]],
];

function shell(active, title, sub, inner) {
  const nav = NAV.map(([sec, items]) =>
    `<div class="sb-sec">${esc(sec)}</div>` +
    items.map(([href, key, label]) =>
      `<a href="${href}"${key === active ? ' class="active"' : ''}>${esc(label)}</a>`).join('')
  ).join('');
  return page(`PCoin ops — ${title}`, `<div class="layout">
  <aside class="sidebar">
    <div class="sb-logo"><h2>⛏ PCoin ops</h2><small>private operator view</small></div>
    <nav>${nav}</nav>
    <div class="sb-foot"><a href="./logout">Sign out</a></div>
  </aside>
  <main class="main">
    <div class="tophead">
      <div><h1>${esc(title)}</h1>${sub ? `<div class="muted">${sub}</div>` : ''}</div>
      <div class="muted">refreshed ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC · <a href="./logout">sign out</a></div>
    </div>
    ${inner}
  </main></div>`);
}

/** Standard numbered pagination bar. Keeps whatever query the base carries. */
function pager(base, p, pages) {
  if (pages <= 1) return '';
  const link = n => `${base}${base.includes('?') ? '&' : '?'}p=${n}`;
  const wanted = [...new Set([1, 2, p - 2, p - 1, p, p + 1, p + 2, pages - 1, pages]
    .filter(n => n >= 1 && n <= pages))].sort((a, b) => a - b);
  let prev = 0;
  const items = [];
  for (const n of wanted) {
    if (n - prev > 1) items.push('<span class="gap">…</span>');
    items.push(n === p ? `<span class="cur">${n}</span>` : `<a href="${link(n)}">${n}</a>`);
    prev = n;
  }
  return `<div class="pager">
    ${p > 1 ? `<a href="${link(p - 1)}">‹ prev</a>` : '<span class="off">‹ prev</span>'}
    ${items.join('')}
    ${p < pages ? `<a href="${link(p + 1)}">next ›</a>` : '<span class="off">next ›</span>'}
  </div>`;
}

function loginPage(err) {
  return page('PCoin ops', `<div class="wrap"><form class="login panel" method="POST" action="./login">
    <h1>PCoin ops</h1>
    <p class="muted">Private. Chain, miners and fleet.</p>
    ${err ? `<p class="bad" style="font-size:13px">${esc(err)}</p>` : ''}
    <label class="muted">User<input name="u" autocomplete="username" autofocus></label>
    <label class="muted">Password<input name="p" type="password" autocomplete="current-password"></label>
    <button type="submit">Sign in</button>
  </form></div>`);
}

const addrCell = a => `<a class="mono" href="./address?a=${encodeURIComponent(a)}">${esc(short(a))}</a>`;
const identTag = (mine, label) => mine
  ? `<span class="tag ${isPayment(label) ? 'pay' : 'you'}">${esc(label)}</span>`
  : '<span class="tag other">not in your records</span>';

/** One census table row. The pool is a single entity here on purpose — its
 *  real workers live on ./pool, not in this table. */
const censusCells = r => r.pool
  ? `<td><a href="./pool"><b>Mining pool</b></a> <span class="muted">(split coinbase — workers on the pool page)</span></td>
     <td><span class="tag pay">POOL</span></td>`
  : `<td class="mono"><a href="./address?a=${encodeURIComponent(r.address)}">${esc(r.address)}</a></td>
     <td>${identTag(r.mine, r.label)}</td>`;

/** Freshness of one collector snapshot. Takes that snapshot's OWN timestamp —
 *  epoch seconds, ISO, or "YYYY-MM-DD HH:MM UTC" — never the state file's
 *  global one, because several collectors share the file and the freshest
 *  would mask a dead one. Unknown-shaped: no timestamp is reported as
 *  "unknown", never as "fresh". */
function snapshotAge(t) {
  if (t == null || t === '') return { text: 'no snapshot timestamp', stale: true };
  const ms = typeof t === 'number' ? t * 1000
    : Date.parse(String(t).replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(:\d{2})? UTC$/, '$1T$2$3Z')
        .replace(/T(\d{2}:\d{2})Z$/, 'T$1:00Z'));
  const age = Date.now() - ms;
  if (!Number.isFinite(age)) return { text: `unparseable timestamp ${t}`, stale: true };
  const s = Math.floor(age / 1000);
  return { text: `collected ${dur(s)} ago`, stale: s > 15 * 60, sec: s };
}

// ── pages ──────────────────────────────────────────────────────────────────
async function dashboardPage() {
  const [c, ce, fl] = await Promise.all([chain(), census(200), fleetBalances().catch(() => null)]);
  const st = readState();
  const age = snapshotAge(st.peers?.at ?? st.at);
  const pool = st.pool || null;
  const poolAge = pool ? snapshotAge(pool.at) : null;

  const health = c.status === 'ok' && c.blocksUnwound === 0
    ? '<span class="ok">healthy</span>' : `<span class="bad">${esc(c.status)} · unwound ${c.blocksUnwound}</span>`;
  const gateCard = c.lwmaActive
    ? `<div class="card"><div class="k">LWMA</div><div class="v ok">active</div><div class="s">since height ${c.gate}</div></div>`
    : `<div class="card"><div class="k">To LWMA gate</div><div class="v warn">${c.toGate}</div><div class="s">blocks to ${c.gate}</div></div>`;
  const yoursPct = ce.total ? (ce.yours / ce.total * 100) : 0;
  const mp = st.mempoolCount ?? c.mempool?.tx_count;   // unknown stays unknown

  const topMiners = ce.rows.slice(0, 6).map(r => `<tr>
      ${r.pool ? '<td><a href="./pool"><b>Mining pool</b></a></td><td><span class="tag pay">POOL</span></td>'
               : `<td>${addrCell(r.address)}</td><td>${identTag(r.mine, r.label)}</td>`}
      <td class="num">${r.blocks}</td>
      <td class="num">${(r.share * 100).toFixed(1)}%</td>
    </tr>`).join('');

  const miners = (fl || []).filter(f => !isPayment(f.label));
  const rails  = (fl || []).filter(f => isPayment(f.label));
  const sum = rows => rows.reduce((s, r) => s + Number(r.total || 0), 0);

  const moneyRows = fl === null
    ? '<tr><td colspan="3" class="muted">balances unreadable right now — not zero, unread</td></tr>'
    : `<tr><td><a href="./fleet">Your miners</a></td><td class="num">${miners.length}</td><td class="num">${pcn(sum(miners))}</td></tr>
       <tr><td><a href="./payments">Payment rails</a></td><td class="num">${rails.length}</td><td class="num">${pcn(sum(rails))}</td></tr>`;

  const peers = st.peers || null;
  const tips = st.tips || null;

  return shell('dash', 'Dashboard', `${health} · tip ${dur(c.tipAge)} old`, `
  <div class="grid">
    <div class="card"><div class="k">Height</div><div class="v">${c.height.toLocaleString()}</div><div class="s">mempool ${mp == null ? '—' : mp} tx</div></div>
    ${gateCard}
    <div class="card"><div class="k">Network hashrate</div><div class="v">${c.hashrate ? Math.round(c.hashrate).toLocaleString() : '—'}<span style="font-size:14px;color:var(--dim)"> H/s</span></div><div class="s">from observed spacing</div></div>
    <div class="card"><div class="k">Block spacing</div><div class="v">${c.medianSpacing ? dur(c.medianSpacing) : '—'}</div><div class="s">median · mean ${dur(c.meanSpacing)} · target 10m</div></div>
    <div class="card"><div class="k">Difficulty</div><div class="v" style="font-size:18px">${c.difficulty ? c.difficulty.toExponential(4) : '—'}</div><div class="s">retargets ${c.lwmaActive ? 'every block' : 'every 2016'}</div></div>
    <div class="card"><div class="k">Your solo blocks</div><div class="v">${yoursPct.toFixed(0)}%</div>
      <div class="bar"><i style="width:${Math.min(100, yoursPct).toFixed(1)}%"></i></div>
      <div class="s">${ce.yours} of ${ce.total} last ${ce.blocksRead} · pool work not included</div></div>
  </div>

  <div class="panel">
    <a class="more" href="./census">full census →</a>
    <h2>Who won the blocks — last ${ce.blocksRead}</h2>
    <table><thead><tr><th>Winner</th><th>Identified</th><th class="num">Blocks</th><th class="num">Share</th></tr></thead>
    <tbody>${topMiners}</tbody></table>
    <div class="note">${ce.distinct} distinct solo payout addresses plus the pool as one entity — a <b>proxy</b>, not a miner count. Details on the census page.</div>
  </div>

  <div class="panel">
    <a class="more" href="./pool">pool miners →</a>
    <h2>Mining pool</h2>
    ${pool ? `<p style="margin:0">${pool.connectedMiners ?? '—'} workers connected ·
       ${pool.poolHashrate != null ? Math.round(pool.poolHashrate).toLocaleString() + ' H/s' : '—'}
       ${pool.poolHashrate && pool.networkHashrate ? ` (${(pool.poolHashrate / pool.networkHashrate * 100).toFixed(0)}% of network)` : ''}
       · ${pool.blocks?.found24h ?? '—'} blocks in 24 h · fee ${pool.feePercent ?? '—'}%</p>
       <p class="muted" style="margin:6px 0 0">${poolAge.stale ? `<span class="warn">⚠ snapshot ${esc(poolAge.text)} — the collector on the pool host may be down</span>` : esc(poolAge.text)}</p>`
      : '<p class="muted">No pool snapshot yet. The collector on the pool host posts one every few minutes.</p>'}
  </div>

  <div class="panel">
    <a class="more" href="./peers">peer list →</a>
    <h2>Network</h2>
    ${peers ? `<p style="margin:0">${peers.distinctIps} distinct IPs · ${peers.total} connections to the seed
       ${tips ? ` · ${tips.total} chain tips (${tips.competing} competing, worst branch ${tips.worst})` : ''}</p>
       <p class="muted" style="margin:6px 0 0">${age.stale ? `<span class="warn">⚠ snapshot ${esc(age.text)} — the collector on the seed may be down</span>` : esc(age.text)}</p>`
      : '<p class="muted">No peer snapshot yet. The collector on the seed posts one every few minutes.</p>'}
  </div>

  <div class="panel">
    <h2>Money</h2>
    <table><thead><tr><th>Group</th><th class="num">Addresses</th><th class="num">On-chain PCN</th></tr></thead>
    <tbody>${moneyRows}</tbody></table>
  </div>`);
}

async function censusPage(url) {
  const w = [100, 200, 500].includes(intp(url.searchParams.get('w'), 200)) ? intp(url.searchParams.get('w'), 200) : 200;
  const ce = await census(w);
  const pages = Math.max(1, Math.ceil(ce.rows.length / PER));
  const p = Math.min(intp(url.searchParams.get('p'), 1), pages);
  const rows = ce.rows.slice((p - 1) * PER, p * PER).map((r, i) => `<tr>
      <td class="num muted">${(p - 1) * PER + i + 1}</td>
      ${censusCells(r)}
      <td class="num">${r.blocks}</td>
      <td class="num">${(r.share * 100).toFixed(1)}%</td>
    </tr>`).join('');
  const winSel = [100, 200, 500].map(n => n === w ? `<span class="cur" style="padding:4px 10px;border-radius:7px;background:var(--accent);color:#0d0f14;font-weight:700">${n}</span>`
    : `<a style="padding:4px 10px" href="./census?w=${n}">${n}</a>`).join(' ');

  return shell('census', 'Miner census', `${ce.distinct} distinct solo winners + the pool (${ce.poolBlocks} blocks) over the last ${ce.blocksRead} · your solo: ${ce.yours} of ${ce.total}`, `
  <div class="panel">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:8px">
      <h2 style="margin:0">Who won the blocks</h2>
      <div class="muted" style="font-size:13px">window: ${winSel} blocks</div>
    </div>
    <table><thead><tr><th class="num">#</th><th>Winner</th><th>Identified</th><th class="num">Blocks</th><th class="num">Share</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="5" class="muted">nothing in this window</td></tr>'}</tbody></table>
    ${pager(`./census?w=${w}`, p, pages)}
    <div class="note"><b>Every block is counted once.</b> A split coinbase — one paying several addresses — is a
    pool block and is attributed to the <a href="./pool">pool</a> as a single entity, because those outputs are
    the pool's payout run, not twenty separate wins. The pool's real workers, with live hashrates from its share
    log, are on the pool page.<br><br>
    <b>The solo rows are still a proxy, not a miner count.</b> A blockchain records who was <i>paid</i>, not who
    was mining: one operator can rotate a fresh address every block, and anyone who found nothing in this window
    is invisible. Read it as a floor on the number of independent solo participants, never as a total.</div>
  </div>`);
}

async function peersPage(url) {
  const st = readState();
  const peers = st.peers || null;
  if (!peers) {
    return shell('peers', 'Peers on the seed', null,
      '<div class="panel"><p class="muted">No peer snapshot yet. The collector on the seed posts one every few minutes.</p></div>');
  }
  const age = snapshotAge(st.peers?.at ?? st.at);
  const c = await chain().catch(() => null);
  // Labels live in config, not in the collector: the seed should not need to
  // know which IP is whose, and the map changes far more often than the script.
  const LABELS = cfg.peerLabels || {};
  const all = (peers.byIp || []).map(pr => ({ ...pr, label: LABELS[pr.ip] || null }));
  const pages = Math.max(1, Math.ceil(all.length / PER));
  const p = Math.min(intp(url.searchParams.get('p'), 1), pages);
  const rows = all.slice((p - 1) * PER, p * PER).map(pr => `<tr>
      <td class="mono">${esc(pr.ip)}</td>
      <td>${pr.label ? `<span class="tag you">${esc(pr.label)}</span>` : '<span class="tag other">unidentified</span>'}</td>
      <td class="num">${pr.connections}</td>
      <td class="num">${pr.inbound ?? '—'} / ${pr.outbound ?? '—'}</td>
      <td class="num">${pr.height ?? '—'}${c && pr.height != null && pr.height < c.height - 2 ? ` <span class="warn">(${c.height - pr.height} behind)</span>` : ''}</td>
    </tr>`).join('');

  return shell('peers', 'Peers on the seed', `${peers.distinctIps} distinct IPs · ${peers.total} connections`, `
  ${age.stale ? `<div class="note warn" style="margin:0 0 18px"><b>Snapshot is stale</b> — ${esc(age.text)}. The collector on the seed normally posts every few minutes; this list describes the network as of then, not now.</div>` : ''}
  <div class="panel">
    <h2>Connected IPs</h2>
    <table><thead><tr><th>IP</th><th>Identified</th><th class="num">Conns</th><th class="num">In / out</th><th class="num">Height</th></tr></thead>
    <tbody>${rows}</tbody></table>
    ${pager('./peers', p, pages)}
    <div class="note">A peer is a <b>node</b>, not a miner, and nothing here links an IP to a block it may have
    mined — the chain does not record that. Several connections from one IP usually means several nodes behind
    one NAT, not several miners. Collected ${esc(peers.at || 'unknown')}.</div>
  </div>`);
}

async function poolPage(url) {
  const st = readState();
  const pool = st.pool || null;
  if (!pool) {
    return shell('pool', 'Pool miners', null,
      '<div class="panel"><p class="muted">No pool snapshot yet. The collector on the pool host posts one every few minutes.</p></div>');
  }
  const age = snapshotAge(pool.at);
  const now = Math.floor(Date.now() / 1000);
  const hr = n => n == null ? '—'
    : n >= 1e6 ? `${(n / 1e6).toFixed(2)} MH/s`
    : n >= 1e3 ? `${(n / 1e3).toFixed(1)} kH/s`
    : `${Math.round(n)} H/s`;
  const netPct = pool.poolHashrate && pool.networkHashrate
    ? (pool.poolHashrate / pool.networkHashrate * 100) : null;
  const b = pool.blocks || {};

  const all = pool.miners || [];
  const activeNow = all.filter(m => m.lastShareAt && now - m.lastShareAt < 600).length;
  const pages = Math.max(1, Math.ceil(all.length / PER));
  const p = Math.min(intp(url.searchParams.get('p'), 1), pages);
  const rows = all.slice((p - 1) * PER, p * PER).map((m, i) => {
    const lastAge = m.lastShareAt ? now - m.lastShareAt : null;
    const active = lastAge != null && lastAge < 10 * 60;
    return `<tr>
      <td class="num muted">${(p - 1) * PER + i + 1}</td>
      <td class="mono"><a href="./address?a=${encodeURIComponent(m.address)}">${esc(m.address)}</a>
          ${FLEET[m.address] ? `<span class="tag you">${esc(FLEET[m.address])}</span>` : ''}</td>
      <td>${active ? '<span class="tag you">⛏ mining</span>' : '<span class="tag other">idle</span>'}</td>
      <td class="num">${(m.share24h * 100).toFixed(1)}%</td>
      <td class="num">${m.share24h && pool.poolHashrate ? hr(m.share24h * pool.poolHashrate) : '—'}</td>
      <td class="num ${active ? 'ok' : 'muted'}">${lastAge == null ? 'over a week' : dur(lastAge) + ' ago'}</td>
      <td class="num">${m.blocksFound || ''}</td>
      <td class="num">${pcn(m.paidSat / 1e8)}</td>
    </tr>`;
  }).join('');

  // One sentence of context from the chain side, so "how many miners are
  // there" has a complete answer on this one page. Optional: if the explorer
  // is unreachable the page still renders, just without this line.
  let censusLine = '';
  try {
    const ce = await census(200);
    const pct = ce.total ? Math.round(ce.poolBlocks / ce.total * 100) : 0;
    censusLine = ` The pool won <b>${ce.poolBlocks} of the last ${ce.blocksRead} blocks</b> (${pct}%);
      the rest went to <a href="./census">${ce.distinct} solo miner${ce.distinct === 1 ? '' : 's'}</a> mining on their own.`;
  } catch { /* explorer unreadable -- say nothing rather than guess */ }

  return shell('pool', 'Pool miners', `who is actually mining through the pool — from its own log; the chain cannot show this`, `
  ${age.stale ? `<div class="note warn" style="margin:0 0 18px"><b>Snapshot is stale</b> — ${esc(age.text)}. The collector on the pool host normally posts every few minutes; these numbers describe the pool as of then, not now.</div>` : ''}

  <div class="panel" style="font-size:15px;line-height:1.7">
    <b>${pool.connectedMiners ?? '—'} machines are connected to the pool right now</b>, of which
    ${activeNow} actually sent work in the last 10 minutes. Over the past week
    <b>${all.length} different miners</b> used the pool at least once. Together the connected ones run at
    <b>${hr(pool.poolHashrate)}</b>${netPct != null ? ` — about <b>${netPct.toFixed(0)}%</b> of the whole network's mining power` : ''}.${censusLine}
  </div>

  <div class="grid">
    <div class="card"><div class="k">Mining right now</div><div class="v">${pool.connectedMiners ?? '—'}</div><div class="s">machines connected this minute</div></div>
    <div class="card"><div class="k">Pool speed</div><div class="v" style="font-size:20px">${hr(pool.poolHashrate)}</div><div class="s">all connected machines combined</div></div>
    <div class="card"><div class="k">Blocks won</div><div class="v">${(b.mature ?? 0) + (b.pending ?? 0)}</div><div class="s">${b.found24h ?? '—'} in the last 24 h · ${b.pending ?? 0} reward${(b.pending ?? 0) === 1 ? '' : 's'} still locked · ${b.orphaned ?? 0} lost</div></div>
    <div class="card"><div class="k">Pool fee</div><div class="v">${pool.feePercent ?? '—'}%</div><div class="s">the other ${pool.feePercent != null ? 100 - pool.feePercent : '—'}% goes to the miners</div></div>
  </div>

  <div class="panel">
    <h2>Every miner in the pool</h2>
    <table><thead><tr><th class="num">#</th><th>Miner (payout address)</th><th>Status</th><th class="num">Share of work (24 h)</th><th class="num">≈ Speed</th><th class="num">Last seen</th><th class="num">Blocks found</th><th class="num">Earned PCN</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="8" class="muted">no workers on record</td></tr>'}</tbody></table>
    ${pager('./pool', p, pages)}
    <div class="note"><b>How to read this table.</b><br>
    <b>Miner</b> — the PCoin address a machine asked to be paid at. One person can run several machines on one
    address, so this is "one payee", not necessarily "one computer".<br>
    <b>Status</b> — <i>mining</i> means it sent the pool a piece of work within the last 10 minutes; <i>idle</i>
    means it is connected or recent, but not currently working.<br>
    <b>Share of work (24 h)</b> — of all the work the whole pool received in the last 24 hours, how much came
    from this miner. This is also roughly the share of every reward they earn.<br>
    <b>≈ Speed</b> — that share applied to the pool's current speed. A machine that joined or left recently
    reads low until a full day passes.<br>
    <b>Last seen</b> — when their most recent piece of work arrived.<br>
    <b>Blocks found</b> — blocks this miner personally solved. Finding a block is luck; earnings do NOT depend
    on it, because every reward is split among everyone by work done.<br>
    <b>Earned PCN</b> — everything the pool's blocks have paid to this address so far.<br><br>
    Payment is automatic and happens inside each won block itself: ${pool.feePercent ?? '—'}% to the pool,
    the rest split in proportion to recent work. A new block's reward unlocks after 100 more blocks are mined
    on top of it (that is what "still locked" above means).</div>
  </div>`);
}

async function moneyPage(url, wantPayments) {
  const fl = await fleetBalances();
  const rows0 = fl.filter(f => isPayment(f.label) === wantPayments);
  const pages = Math.max(1, Math.ceil(rows0.length / PER));
  const p = Math.min(intp(url.searchParams.get('p'), 1), pages);
  const slice = rows0.slice((p - 1) * PER, p * PER);
  const rows = slice.map(f => `<tr>
      <td class="mono"><a href="./address?a=${encodeURIComponent(f.address)}">${esc(f.address)}</a></td>
      <td>${esc(wantPayments ? String(f.label).replace(/^PAYMENT - /, '') : f.label)}</td>
      <td class="num">${pcn(f.mature)}</td>
      <td class="num">${pcn(f.immature)}</td>
      <td class="num">${pcn(f.total)}</td>
      <td class="num">${pcn(f.lifetime)}</td>
    </tr>`).join('');
  const sum = k => rows0.reduce((s, r) => s + Number(r[k] || 0), 0);
  const totalRow = rows0.length ? `<tr class="total"><td></td><td>Total (all ${rows0.length})</td>
      <td class="num">${pcn(sum('mature'))}</td><td class="num">${pcn(sum('immature'))}</td>
      <td class="num">${pcn(sum('total'))}</td><td class="num">${pcn(sum('lifetime'))}</td></tr>` : '';

  const [key, title, head, note] = wantPayments
    ? ['payments', 'Payment rails', 'Service',
       'One row per service that accepts PCN. Deposit addresses are per-user and <b>reused</b> — a deposit address IS a customer, which is why this page is private. Balances only; whether the watcher on each service is crediting is monitored by <code>pcoin-deposit-watch</code>, not visible here.']
    : ['fleet', 'Fleet balances', 'Device',
       'Balances only. Whether a miner is <i>running</i> is not visible from the chain — a machine that is on but unlucky looks identical to one that is off. Use the peers page as a liveness hint: if a site’s IP is not connected, nothing there is mining. A LOW balance on a forwarding device usually means it is <b>working</b> — it sweeps to the treasury by design.'];

  return shell(key, title, `${rows0.length} address${rows0.length === 1 ? '' : 'es'} on record`, `
  <div class="panel">
    <h2>On-chain balances</h2>
    <table><thead><tr><th>Address</th><th>${head}</th><th class="num">Mature</th><th class="num">Immature</th><th class="num">Total PCN</th><th class="num">Lifetime in</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="6" class="muted">no ${wantPayments ? 'payment' : 'fleet'} addresses configured</td></tr>`}${totalRow}</tbody></table>
    ${pager(`./${key}`, p, pages)}
    <div class="note">${note}</div>
  </div>`);
}

async function blocksPage(url) {
  const d = await blocksList(intp(url.searchParams.get('p'), 1));
  const now = Math.floor(Date.now() / 1000);
  const rows = d.blocks.map(b => {
    const minerCell = b.miner === undefined ? '<span class="muted">unreadable</span>'
      : b.miner === null ? '—'
      : b.poolPaid ? '<a href="./pool"><b>Mining pool</b></a> <span class="tag pay">POOL</span>'
      : `${addrCell(b.miner)} ${FLEET[b.miner] ? `<span class="tag ${isPayment(FLEET[b.miner]) ? 'pay' : 'you'}">${esc(FLEET[b.miner])}</span>` : ''}`;
    const reward = b.subsidy_pcn != null ? pcn(Number(b.subsidy_pcn) + Number(b.total_fees_pcn || 0)) : '—';
    return `<tr>
      <td class="num"><a href="/block/${esc(b.hash)}" target="_blank" rel="noopener">${b.height.toLocaleString()}</a></td>
      <td class="muted">${esc((b.time_iso || '').replace('T', ' ').replace('Z', ''))}</td>
      <td class="num">${dur(now - (b.time || now))}</td>
      <td class="num">${b.n_tx ?? '—'}</td>
      <td class="num">${reward}</td>
      <td class="num">${b.difficulty ? Number(b.difficulty).toExponential(3) : '—'}</td>
      <td>${minerCell}</td>
    </tr>`;
  }).join('');

  return shell('blocks', 'Blocks', `tip ${d.tip.toLocaleString()} · newest first`, `
  <div class="panel">
    <h2>Recent blocks</h2>
    <table><thead><tr><th class="num">Height</th><th>Time (UTC)</th><th class="num">Age</th><th class="num">Txs</th><th class="num">Reward</th><th class="num">Difficulty</th><th>Paid to</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="7" class="muted">nothing indexed yet</td></tr>'}</tbody></table>
    ${pager('./blocks', d.page, d.pages)}
    <div class="note">Height links open the public explorer view (by hash, so a reorg cannot swap the page under
    you). Block timestamps are <b>not monotonic</b> on this chain — a negative age is a real timestamp, not a bug.
    Page numbers are anchored to the tip, so they shift as the chain extends.</div>
  </div>`);
}

async function addressPage(url) {
  const a = String(url.searchParams.get('a') || '');
  if (!/^[0-9a-z]{8,120}$/i.test(a)) {
    return shell('dash', 'Address', null, '<div class="panel"><p class="bad">That does not look like an address.</p></div>');
  }
  const info = await j(`${EXPLORER}/address/${encodeURIComponent(a)}`, 15e3);
  const per = PER;
  const total = info.balance?.lifetime?.tx_count ?? 0;
  const pages = Math.max(1, Math.ceil(total / per));
  const p = Math.min(intp(url.searchParams.get('p'), 1), pages);
  const hist = await j(`${EXPLORER}/address/${encodeURIComponent(a)}/txs?limit=${per}&offset=${(p - 1) * per}`, 15e3);

  const label = FLEET[a] || null;
  const conf = info.balance?.confirmed || {};
  const life = info.balance?.lifetime || {};
  const unconf = info.balance?.unconfirmed || {};

  // Unknown-shaped rendering: a null spendable is "could not observe the
  // mempool", never zero. See §7.1.
  const spendable = conf.spendable_sat === null
    ? `<span class="warn" title="${esc(conf.spendable_unknown_reason || '')}">unknown</span>`
    : pcn(conf.spendable_pcn);

  const cards = `
  <div class="grid">
    <div class="card"><div class="k">Mature</div><div class="v">${pcn(conf.mature_pcn)}</div><div class="s">${conf.mature_utxo_count ?? '—'} UTXOs</div></div>
    <div class="card"><div class="k">Immature</div><div class="v">${pcn(conf.immature_pcn)}</div>
      <div class="s">${conf.next_maturity_in_blocks != null ? `next matures in ${conf.next_maturity_in_blocks} blocks` : `${conf.immature_utxo_count ?? 0} coinbase UTXOs < 100 conf`}</div></div>
    <div class="card"><div class="k">Spendable now</div><div class="v">${spendable}</div><div class="s">mature minus pending spends</div></div>
    <div class="card"><div class="k">On-chain total</div><div class="v">${pcn(conf.onchain_unspent_pcn)}</div><div class="s">as of height ${conf.as_of_height ?? '—'}</div></div>
    <div class="card"><div class="k">Lifetime received</div><div class="v">${pcn(life.received_pcn)}</div><div class="s">sent ${pcn(life.sent_pcn)} · ${life.tx_count ?? 0} txs</div></div>
    <div class="card"><div class="k">Active</div><div class="v" style="font-size:18px">${life.first_height != null ? `${life.first_height.toLocaleString()} → ${life.last_height.toLocaleString()}` : '—'}</div><div class="s">first / last block height</div></div>
  </div>`;

  const mempoolPanel = unconf.known === false
    ? `<div class="note warn" style="margin:0 0 18px"><b>Mempool unobservable</b> — ${esc(unconf.reason || 'node unreachable')}. Unconfirmed activity is <i>unknown</i>, not zero.</div>`
    : (unconf.tx_count > 0
      ? `<div class="note" style="margin:0 0 18px">${unconf.tx_count} unconfirmed tx: receiving ${pcn(unconf.receiving_pcn)} PCN, spending ${pcn(unconf.spending_pcn)} PCN. Unconfirmed items are kept out of the paged history below so pages do not shift.</div>`
      : '');

  const items = hist.confirmed?.items || [];
  const histRows = items.map(t => `<tr>
      <td class="num"><a href="/block/${esc(t.block_hash || '')}" target="_blank" rel="noopener">${t.height?.toLocaleString() ?? '—'}</a></td>
      <td class="muted">${esc((t.time_iso || '').replace('T', ' ').replace('Z', ''))}</td>
      <td class="mono"><a href="/tx/${esc(t.txid)}" target="_blank" rel="noopener">${esc(short(t.txid))}</a></td>
      <td class="num ok">${Number(t.received_sat) ? `+${pcn(t.received_pcn)}` : ''}</td>
      <td class="num bad">${Number(t.sent_sat) ? `−${pcn(t.sent_pcn)}` : ''}</td>
      <td class="num">${pcn(t.net_pcn)}</td>
      <td class="num muted">${t.confirmations ?? '—'}</td>
    </tr>`).join('');

  const histTotal = hist.confirmed?.total ?? total;
  const histPages = Math.max(1, Math.ceil(histTotal / per));

  return shell(label ? (isPayment(label) ? 'payments' : 'fleet') : 'census',
    label || 'Address', `<span class="mono" style="font-size:12px">${esc(a)}</span>`, `
  ${label ? `<p style="margin:0 0 14px">${identTag(true, label)} <a class="muted" style="margin-left:10px" href="/address/${encodeURIComponent(a)}" target="_blank" rel="noopener">open in public explorer ↗</a></p>`
          : `<p style="margin:0 0 14px"><span class="tag other">not in your records</span> <a class="muted" style="margin-left:10px" href="/address/${encodeURIComponent(a)}" target="_blank" rel="noopener">open in public explorer ↗</a></p>`}
  ${info.used === false ? '<div class="note warn" style="margin:0 0 18px">This address has never appeared on chain.</div>' : ''}
  ${mempoolPanel}
  <h2 style="margin-bottom:10px">Balance</h2>
  ${cards}
  <div class="panel">
    <h2>History — ${histTotal.toLocaleString()} confirmed transaction${histTotal === 1 ? '' : 's'}</h2>
    <table><thead><tr><th class="num">Height</th><th>Time (UTC)</th><th>Txid</th><th class="num">Received</th><th class="num">Sent</th><th class="num">Net PCN</th><th class="num">Conf</th></tr></thead>
    <tbody>${histRows || '<tr><td colspan="7" class="muted">no confirmed history</td></tr>'}</tbody></table>
    ${pager(`./address?a=${encodeURIComponent(a)}`, p, histPages)}
    <div class="note">Newest first, paged by offset — if the chain extends or reorgs between two clicks, a row can
    shift across a page boundary. Coinbase rewards need 100 confirmations before they are spendable.</div>
  </div>`);
}

// ── server ─────────────────────────────────────────────────────────────────
function body(req) {
  return new Promise(res => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > 1e5) req.destroy(); });
    req.on('end', () => res(s));
  });
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname.replace(/^\/admin/, '') || '/';
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
  const send = (code, type, payload, extra = {}) => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer', ...extra });
    res.end(payload);
  };

  try {
    // Collector endpoint: the seed posts peer/tip data here. Bearer-only, no session.

/* -- wrap desk ---------------------------------------------------------------
 * Every PCN -> wPCN request and exactly what is owed on each.
 *
 * READ-ONLY ON PURPOSE. This page sends no wPCN and marks nothing paid. The
 * release happens by hand from the inventory wallet and is recorded with
 *   pcoin-wrapdesk-watch --released <txid> <bsc_txhash>
 * so the record carries a transaction that can be checked afterwards. A "mark
 * as sent" button here would let an operator record a payment that never left,
 * which is the one failure this whole desk is built to avoid.
 *
 * An address that cannot be read renders as UNKNOWN, never as "no deposit".
 * A failed read shown as zero is how a paying customer is recorded as unpaid.
 */
const WRAP_REQUESTS      = '/var/lib/wrapdesk/requests.json';
const WRAP_STATE         = '/var/lib/pcoin-wrapdesk/state.json';
const WRAP_FEE_PCT       = 5;
const WRAP_PER_PERSON    = 250;
const WRAP_CONFIRMATIONS = 100;

function wrapRead(f) {
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; }
}

async function wrapPage() {
  const reqs  = wrapRead(WRAP_REQUESTS);
  const state = wrapRead(WRAP_STATE) || {};
  const seen  = state.seen || {};

  if (reqs === null) {
    return shell('wrap', 'Wrap desk', '',
      '<div class="card"><p>Could not read <code>' + esc(WRAP_REQUESTS) + '</code>. ' +
      'That is <b>UNKNOWN</b>, not "no requests" &mdash; deposits may exist that this ' +
      'page cannot see.</p></div>');
  }

  const rows = [];
  let owed = 0, unknown = 0, pending = 0;

  for (const r of Object.values(reqs.requests || {})) {
    let info = null;
    try { info = await j(EXPLORER + '/address/' + encodeURIComponent(r.address), 15e3); }
    catch { info = null; }

    if (info === null) {
      unknown++;
      rows.push('<tr><td><code>' + esc(r.bsc) + '</code></td><td><code>' +
        esc(r.address) + '</code></td><td colspan="4"><b>UNKNOWN</b> &mdash; ' +
        'explorer unreadable, this is not "no deposit"</td></tr>');
      continue;
    }

    const items = ((info.history && info.history.items) || [])
      .filter(function (i) { return Number(i.received_pcn) > 0; });

    if (!items.length) {
      rows.push('<tr><td><code>' + esc(r.bsc) + '</code></td><td><code>' +
        esc(r.address) + '</code></td><td colspan="4" class="muted">no deposit yet</td></tr>');
      continue;
    }

    for (const i of items) {
      const rec   = seen['wrap:' + i.txid];
      const done  = !!(rec && rec.released);
      const confs = Number(i.confirmations == null ? 0 : i.confirmations);
      const pcn   = Number(i.received_pcn);
      const net   = Math.min(pcn, WRAP_PER_PERSON) * (1 - WRAP_FEE_PCT / 100);
      const ready = confs >= WRAP_CONFIRMATIONS;
      if (!done && ready) owed += net;
      if (!done && !ready) pending++;
      const status = done ? 'released'
        : ready ? '<b>SEND ' + net.toFixed(2) + ' wPCN</b>'
        : confs + '/' + WRAP_CONFIRMATIONS + ' confs';
      const over = pcn > WRAP_PER_PERSON
        ? '<br><small>over the ' + WRAP_PER_PERSON + ' cap &mdash; return ' +
          (pcn - WRAP_PER_PERSON).toFixed(2) + ' PCN</small>' : '';
      rows.push('<tr><td><code>' + esc(r.bsc) + '</code></td><td><code>' +
        esc(r.address) + '</code></td><td>' + pcn.toFixed(2) + ' PCN' + over +
        '</td><td>' + net.toFixed(2) + ' wPCN</td><td>' + status +
        '</td><td><code style="font-size:.8em">' + esc(String(i.txid).slice(0, 16)) +
        '&hellip;</code></td></tr>');
    }
  }

  const head = '<div class="card"><p><b>' + owed.toFixed(2) + ' wPCN</b> owed and ready ' +
    'to send now. ' + pending + ' still confirming.' +
    (unknown ? ' <b>' + unknown + ' address(es) could not be read &mdash; UNKNOWN.</b>' : '') +
    '</p><p class="muted">Release by hand from the inventory wallet, then record it so it ' +
    'stops being reported:<br><code>pcoin-wrapdesk-watch --released &lt;txid&gt; ' +
    '&lt;bsc_txhash&gt;</code></p></div>';

  return shell('wrap', 'Wrap desk', 'PCN &rarr; wPCN requests, read live from the chain',
    head + '<div class="card"><table><tr><th>Requester (BSC)</th><th>Deposit address</th>' +
    '<th>Received</th><th>Owed</th><th>Status</th><th>Tx</th></tr>' +
    (rows.join('') || '<tr><td colspan="6" class="muted">No requests yet.</td></tr>') +
    '</table></div>');
}

    if (path === '/collect' && req.method === 'POST') {
      const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const want = Buffer.from(cfg.collectorToken), got = Buffer.from(auth);
      if (got.length !== want.length || !timingSafeEqual(got, want)) return send(401, 'text/plain', 'no');
      const payload = JSON.parse(await body(req));
      const prev = readState();
      writeFileSync(STATE, JSON.stringify({ ...prev, ...payload, at: new Date().toISOString() }, null, 2));
      return send(200, 'application/json', '{"ok":true}');
    }

    const cookie = (req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith('ops='));
    const authed = verify(cookie ? cookie.slice(4) : '');

    if (path === '/logout') {
      return send(302, 'text/html', '', { 'Set-Cookie': 'ops=; Path=/admin; Max-Age=0; HttpOnly; Secure; SameSite=Lax', Location: './' });
    }

    if (path === '/login' && req.method === 'POST') {
      if (throttled(ip)) return send(429, 'text/html', loginPage('Too many attempts. Wait 15 minutes.'));
      const f = new URLSearchParams(await body(req));
      if (f.get('u') === cfg.user && checkPw(f.get('p') || '')) {
        attempts.delete(ip);
        const tok = sign(`${randomBytes(9).toString('hex')}|${Date.now() + 12 * 3600e3}`);
        return send(302, 'text/html', '', {
          'Set-Cookie': `ops=${tok}; Path=/admin; Max-Age=${12 * 3600}; HttpOnly; Secure; SameSite=Lax`,
          Location: './',
        });
      }
      noteFail(ip);
      return send(401, 'text/html', loginPage('Wrong user or password.'));
    }

    if (!authed) return send(200, 'text/html', loginPage(null));

    if (path === '/api') {
      const [c, ce, fl] = await Promise.all([chain(), census(200), fleetBalances().catch(() => [])]);
      return send(200, 'application/json', JSON.stringify({ chain: c, census: ce, fleet: fl, state: readState() }, null, 2));
    }

    if (path === '/')         return send(200, 'text/html', await dashboardPage());
    if (path === '/census')   return send(200, 'text/html', await censusPage(url));
    if (path === '/pool')     return send(200, 'text/html', await poolPage(url));
    if (path === '/peers')    return send(200, 'text/html', await peersPage(url));
    if (path === '/fleet')    return send(200, 'text/html', await moneyPage(url, false));
    if (path === '/payments') return send(200, 'text/html', await moneyPage(url, true));
    if (path === '/wrap')     return send(200, 'text/html', await wrapPage());
    if (path === '/blocks')   return send(200, 'text/html', await blocksPage(url));
    if (path === '/address')  return send(200, 'text/html', await addressPage(url));

    return send(302, 'text/html', '', { Location: './' });
  } catch (err) {
    return send(500, 'text/html', page('error', `<div class="wrap"><div class="panel"><h1>Upstream error</h1>
      <p class="muted">${esc(err.message)}</p><p class="muted">Nothing is inferred from a failed read — the
      numbers above are simply not shown rather than guessed.</p><p><a href="./">retry</a></p></div></div>`));
  }
}).listen(PORT, '127.0.0.1', () => console.log(`pcoin-ops on 127.0.0.1:${PORT}`));
