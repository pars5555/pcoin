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
// Listens on loopback only; Caddy terminates TLS and proxies.

import { createServer } from 'node:http';
import { createHash, randomBytes, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';

const CONFIG = '/opt/pcoin-ops/config.json';
const STATE  = '/opt/pcoin-ops/state.json';
const PORT   = 8787;
const EXPLORER = 'http://127.0.0.1:8080/api';   // the explorer runs on this box
const GATE = 2800;

const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));

// Addresses we know are ours. Anything else is reported as "not in your
// records" -- never as "a stranger", because only the owner can tell the
// difference between someone else's miner and their own forgotten config.
const FLEET = cfg.fleet || {};

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

/** Distinct coinbase payout addresses over the last N blocks. A PROXY for
 *  miner count, not a miner count -- see the header. */
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
    for (const o of cb.outputs || []) {
      if (o.address && (o.value_sat || 0) > 0) {
        counts.set(o.address, (counts.get(o.address) || 0) + 1);
      }
    }
  }
  const rows = [...counts.entries()]
    .map(([address, blocks]) => ({ address, blocks, mine: !!FLEET[address], label: FLEET[address] || null }))
    .sort((a, b) => b.blocks - a.blocks);
  const total = rows.reduce((s, r) => s + r.blocks, 0) || 1;
  rows.forEach(r => { r.share = r.blocks / total; });
  const v = {
    tip, window, blocksRead: read, distinct: rows.length, rows,
    yours: rows.filter(r => r.mine).reduce((s, r) => s + r.blocks, 0),
    total,
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

function readState() {
  if (!existsSync(STATE)) return {};
  try { return JSON.parse(readFileSync(STATE, 'utf8')); } catch { return {}; }
}

// ── html ───────────────────────────────────────────────────────────────────
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pcn = n => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dur = s => s == null ? '—' : s < 90 ? `${s}s` : s < 5400 ? `${(s / 60).toFixed(1)}m` : `${(s / 3600).toFixed(1)}h`;

const CSS = `
:root{--bg:#0d0f14;--panel:#151823;--edge:#242938;--ink:#e8eaf2;--dim:#98a0b4;
      --accent:#8b5cf6;--teal:#2dd4bf;--warn:#fbbf24;--bad:#f87171;--good:#34d399;
      --mono:ui-monospace,"Cascadia Code",Menlo,Consolas,monospace}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:22px}
header{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;
       border-bottom:1px solid var(--edge);padding-bottom:14px;margin-bottom:22px}
h1{font-size:19px;margin:0;letter-spacing:-.01em}
h2{font-size:15px;margin:0 0 12px;color:var(--dim);text-transform:uppercase;letter-spacing:.07em}
.muted{color:var(--dim);font-size:13px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(178px,1fr));gap:12px;margin-bottom:22px}
.card{background:var(--panel);border:1px solid var(--edge);border-radius:12px;padding:14px 16px}
.card .k{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.07em}
.card .v{font-size:24px;font-weight:650;margin-top:5px;letter-spacing:-.02em}
.card .s{color:var(--dim);font-size:12px;margin-top:3px}
.panel{background:var(--panel);border:1px solid var(--edge);border-radius:12px;padding:16px 18px;margin-bottom:22px}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th{text-align:left;color:var(--dim);font-weight:600;font-size:11px;text-transform:uppercase;
   letter-spacing:.06em;padding:7px 9px;border-bottom:1px solid var(--edge)}
td{padding:7px 9px;border-bottom:1px solid rgba(255,255,255,.045)}
tr:last-child td{border-bottom:0}
.mono{font-family:var(--mono);font-size:12.5px}
.num{text-align:right;font-variant-numeric:tabular-nums}
.tag{display:inline-block;padding:1px 7px;border-radius:999px;font-size:11px;font-weight:600}
.tag.you{background:rgba(45,212,191,.14);color:var(--teal)}
.tag.other{background:rgba(255,255,255,.06);color:var(--dim)}
.ok{color:var(--good)} .warn{color:var(--warn)} .bad{color:var(--bad)}
.bar{height:5px;border-radius:3px;background:rgba(255,255,255,.07);overflow:hidden;margin-top:6px}
.bar>i{display:block;height:100%;background:linear-gradient(90deg,var(--accent),var(--teal))}
.note{border-left:3px solid var(--accent);background:rgba(139,92,246,.07);padding:11px 14px;
      border-radius:0 8px 8px 0;color:var(--dim);font-size:13px;margin:14px 0 0}
a{color:var(--accent)}
.login{max-width:340px;margin:14vh auto;padding:26px}
input{width:100%;padding:10px 12px;border-radius:9px;border:1px solid var(--edge);
      background:var(--bg);color:var(--ink);font:inherit;margin-top:6px}
button{margin-top:14px;width:100%;padding:10px;border-radius:9px;border:0;cursor:pointer;
       background:linear-gradient(135deg,var(--accent),var(--teal));color:#0d0f14;font-weight:700;font:inherit;font-weight:700}
`;

function page(title, body) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<title>${esc(title)}</title><style>${CSS}</style></head><body>${body}</body></html>`;
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

function dash(d) {
  const c = d.chain, ce = d.census, st = d.state || {};
  const gateCard = c.lwmaActive
    ? `<div class="card"><div class="k">LWMA</div><div class="v ok">active</div><div class="s">since height ${c.gate}</div></div>`
    : `<div class="card"><div class="k">To LWMA gate</div><div class="v warn">${c.toGate}</div><div class="s">blocks to ${c.gate}</div></div>`;

  const health = c.status === 'ok' && c.blocksUnwound === 0
    ? '<span class="ok">healthy</span>' : `<span class="bad">${esc(c.status)} · unwound ${c.blocksUnwound}</span>`;

  const yoursPct = ce.total ? (ce.yours / ce.total * 100) : 0;

  const censusRows = ce.rows.map(r => `<tr>
      <td class="mono">${esc(r.address)}</td>
      <td>${r.mine ? `<span class="tag you">${esc(r.label)}</span>` : '<span class="tag other">not in your records</span>'}</td>
      <td class="num">${r.blocks}</td>
      <td class="num">${(r.share * 100).toFixed(1)}%</td>
    </tr>`).join('');

  // Labels live in config, not in the collector: the seed should not need to
  // know which IP is whose, and the map changes far more often than the script.
  const LABELS = cfg.peerLabels || {};
  const peers = st.peers || null;
  const peerRows = peers ? (peers.byIp || []).map(p => ({ ...p, label: LABELS[p.ip] || null })).map(p => `<tr>
      <td class="mono">${esc(p.ip)}</td>
      <td>${p.label ? `<span class="tag you">${esc(p.label)}</span>` : '<span class="tag other">unidentified</span>'}</td>
      <td class="num">${p.connections}</td>
      <td class="num">${p.height ?? '—'}</td>
    </tr>`).join('') : '';

  const fleetRows = (d.fleet || []).map(f => `<tr>
      <td class="mono">${esc(f.address)}</td>
      <td>${esc(f.label)}</td>
      <td class="num">${pcn(f.mature)}</td>
      <td class="num">${pcn(f.immature)}</td>
      <td class="num">${pcn(f.total)}</td>
    </tr>`).join('');

  return page('PCoin ops', `<div class="wrap">
  <header>
    <div><h1>PCoin ops</h1><div class="muted">private · refreshed ${new Date().toISOString().replace('T',' ').slice(0,19)} UTC</div></div>
    <div class="muted">${health} · tip ${dur(c.tipAge)} old · <a href="./logout">sign out</a></div>
  </header>

  <div class="grid">
    <div class="card"><div class="k">Height</div><div class="v">${c.height.toLocaleString()}</div><div class="s">mempool ${st.mempoolCount ?? c.mempool?.tx_count ?? 0} tx</div></div>
    ${gateCard}
    <div class="card"><div class="k">Network hashrate</div><div class="v">${c.hashrate ? Math.round(c.hashrate).toLocaleString() : '—'}<span style="font-size:14px;color:var(--dim)"> H/s</span></div><div class="s">from observed spacing</div></div>
    <div class="card"><div class="k">Block spacing</div><div class="v">${c.medianSpacing ? dur(c.medianSpacing) : '—'}</div><div class="s">median · mean ${dur(c.meanSpacing)} · target 10m</div></div>
    <div class="card"><div class="k">Difficulty</div><div class="v" style="font-size:18px">${c.difficulty ? c.difficulty.toExponential(4) : '—'}</div><div class="s">retargets ${c.lwmaActive ? 'every block' : 'every 2016'}</div></div>
    <div class="card"><div class="k">Your share of blocks</div><div class="v">${yoursPct.toFixed(0)}%</div>
      <div class="bar"><i style="width:${Math.min(100,yoursPct).toFixed(1)}%"></i></div>
      <div class="s">${ce.yours} of ${ce.total} last ${ce.blocksRead}</div></div>
  </div>

  <div class="panel">
    <h2>Miner census — last ${ce.blocksRead} blocks</h2>
    <table><thead><tr><th>Payout address</th><th>Identified</th><th class="num">Blocks</th><th class="num">Share</th></tr></thead>
    <tbody>${censusRows}</tbody></table>
    <div class="note"><b>${ce.distinct} distinct payout addresses</b> — this is a proxy, not a miner count.
    A blockchain records who was <i>paid</i>, not who was mining: one operator can rotate a fresh address every
    block, a pool of a hundred looks like one address, and anyone who found nothing in this window is invisible.
    Read it as a floor on the number of independent participants, never as a total.</div>
  </div>

  <div class="panel">
    <h2>Peers on the seed${peers ? ` — ${peers.distinctIps} distinct IPs, ${peers.total} connections` : ''}</h2>
    ${peers ? `<table><thead><tr><th>IP</th><th>Identified</th><th class="num">Conns</th><th class="num">Height</th></tr></thead>
      <tbody>${peerRows}</tbody></table>
      <div class="note">A peer is a <b>node</b>, not a miner, and nothing here links an IP to a block it may have
      mined — the chain does not record that. Several connections from one IP usually means several nodes behind
      one NAT, not several miners. Collected ${esc(peers.at || 'unknown')}.</div>`
    : `<p class="muted">No peer snapshot yet. The collector on the seed posts one every few minutes.</p>`}
  </div>

  <div class="panel">
    <h2>Your fleet — on-chain balances</h2>
    <table><thead><tr><th>Address</th><th>Device</th><th class="num">Mature</th><th class="num">Immature</th><th class="num">Total PCN</th></tr></thead>
    <tbody>${fleetRows || '<tr><td colspan="5" class="muted">no fleet addresses configured</td></tr>'}</tbody></table>
    <div class="note">Balances only. Whether a miner is <i>running</i> is not visible from the chain — a machine
    that is on but unlucky looks identical to one that is off. Use the peer panel above as a liveness hint: if a
    site's IP is not connected, nothing there is mining.</div>
  </div>
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

    const [c, ce, fl] = await Promise.all([chain(), census(200), fleetBalances().catch(() => [])]);
    return send(200, 'text/html', dash({ chain: c, census: ce, fleet: fl, state: readState() }));
  } catch (err) {
    return send(500, 'text/html', page('error', `<div class="wrap"><div class="panel"><h1>Upstream error</h1>
      <p class="muted">${esc(err.message)}</p><p class="muted">Nothing is inferred from a failed read — the
      numbers above are simply not shown rather than guessed.</p><p><a href="./">retry</a></p></div></div>`));
  }
}).listen(PORT, '127.0.0.1', () => console.log(`pcoin-ops on 127.0.0.1:${PORT}`));
