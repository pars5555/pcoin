/**
 * wrapdesk.pc.am — the public face of the PCN ⇄ wPCN desk.
 *
 * WHAT PROBLEM THIS SOLVES
 *
 * PCoin has no memo or destination-tag field, so a deposit cannot carry the BSC
 * address it should pay out to. Something has to link "this PCN arrived" to
 * "this person wants wPCN here". The answer used by every one of the six live
 * payment rails is a DEPOSIT ADDRESS PER USER, and that is what this does:
 * each requester is handed their own PCoin address, derived in advance from the
 * reserve wallet's xpub, so the deposit identifies them by construction.
 *
 * NO KEY MATERIAL LIVES HERE. The address pool was derived from the ACCOUNT
 * XPUB on a vault host — public derivation, which can produce addresses and can
 * never produce a spending key. This server reads a flat text file of addresses.
 * If this box is compromised the attacker learns which addresses exist, which
 * is already public on the explorer, and gains no ability to move a satoshi.
 *
 * ADDRESSES ARE REUSED PER PERSON, DELIBERATELY.
 *
 *   1. a fresh address per request would let anyone exhaust the pool in a loop;
 *   2. it makes the ledger key (txid, address) rather than (txid, vout) — the
 *      rule all four early deposit rails got wrong. `vout` is always 0 for
 *      these, so keying on it silently DROPS a person's second deposit.
 *
 * WHAT THIS SERVER MAY NOT DO
 *
 * It never sends wPCN, never touches a key, never marks anything paid, and has
 * no admin surface on this port. It records intent and reports what the chain
 * says. A human releases the wPCN. The machine observes; a person pays.
 *
 * The one thing the browser does on its own is /redeem: a page-side helper
 * encodes redeem(value, pcoinAddress) and asks the VISITOR'S wallet to sign it.
 * No key of ours is involved and the server never sees the transaction. It
 * exists because BscScan's Write Contract form hands MetaMask for Android a
 * transaction with null fee fields and fails; the helper sends only
 * {from, to, data} and lets the wallet fill in the rest.
 *
 * PRIVACY: a BSC address is never shown on any public page. Linking someone's
 * PCoin deposit address to their BSC address is a connection only we hold, and
 * publishing it would create a leak that does not otherwise exist. /activity
 * therefore shows amounts and states, never who.
 *
 * UNREADABLE IS NOT ZERO. If the explorer cannot be reached, status is reported
 * as UNKNOWN — never as "no deposit found". A failed read rendered as "nothing
 * received" is how a paying customer gets told they did not pay.
 */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const PORT       = Number(process.env.WRAPDESK_PORT || 8791);
const POOL_FILE  = process.env.WRAPDESK_POOL  || '/opt/wrapdesk/reserve-pool.txt';
const STATE_FILE = process.env.WRAPDESK_STATE || '/var/lib/wrapdesk/requests.json';
const EXPLORER   = process.env.WRAPDESK_EXPLORER || 'https://explorer.pc.am';

const FEE_PCT       = Number(process.env.WRAP_FEE_PCT || 5);
const PER_PERSON    = Number(process.env.WRAP_PER_PERSON || 250);
const TOTAL_ALLOC   = Number(process.env.WRAP_TOTAL_ALLOC || 1500);
const CONFIRMATIONS = Number(process.env.WRAP_CONFIRMATIONS || 100);

const RESERVE = process.env.WRAP_RESERVE || 'pc1q7hhzmdkkx0zjtzj6qkwmuvhlgwfqjrc6j2dk52';
const TOKEN   = process.env.WPCN_TOKEN   || '0x290A5779a419Cb9cB22fa087CDD1CD16dA2D95F1';
const ISSUED  = Number(process.env.WPCN_ISSUED || 50000);
// Shown wherever the wait or the fee is described. Derived, so a change to
// CONFIRMATIONS or the allocation cannot leave a stale number on a public page.
const WAIT_H    = Math.round(CONFIRMATIONS / 6);          // 600 s target: 6 blocks an hour
const FEE_TOTAL = TOTAL_ALLOC * FEE_PCT / 100;            // PCN, if the whole allocation wraps

// Index 0 is the MAIN RESERVE holding the backing. Never handed out, or a
// customer deposit becomes indistinguishable from the backing itself.
const FIRST_INDEX = 1;

// ── address pool ────────────────────────────────────────────────────────────
const pool = readFileSync(POOL_FILE, 'utf8').trim().split('\n')
  .map((l) => { const [i, a] = l.split('\t'); return { i: Number(i), a }; })
  .filter((r) => Number.isInteger(r.i) && /^pc1[0-9a-z]{20,}$/.test(r.a || ''));
if (pool.length < 100) throw new Error(`address pool too small: ${pool.length}`);

// ── state ───────────────────────────────────────────────────────────────────
function load() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); }
  catch { return { requests: {}, nextIndex: FIRST_INDEX }; }
}
function save(s) {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 1));
  renameSync(tmp, STATE_FILE);        // atomic; a torn file loses who is owed
}

const isBsc = (s) => typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s);
const isPcn = (s) => typeof s === 'string' && /^pc1[0-9a-z]{20,}$/.test(s);

// ── explorer. null means UNKNOWN and must never render as zero ───────────────
async function jget(path) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 20000);
    const r = await fetch(`${EXPLORER}${path}`, { signal: c.signal });
    clearTimeout(t);
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

async function deposits(addr) {
  const d = await jget(`/api/address/${addr}`);
  if (d === null) return null;
  const map = (items, pending) => (items || [])
    .filter((i) => Number(i.received_pcn) > 0)
    .map((i) => ({ txid: i.txid, pcn: Number(i.received_pcn), pending,
                   confirmations: pending ? 0 : Number(i.confirmations ?? 0) }));
  return [...map(d.unconfirmed_history?.items, true),
          ...map(d.history?.items, false)];
}

async function reserveBalance() {
  // The reserve is a WALLET, not one address. Customer deposits land on the
  // per-user addresses this desk hands out — all derived from the same xpub —
  // so counting only index 0 made a confirmed, fee-bearing wrap invisible on
  // the proof page: 10 PCN arrived and Surplus still read 0.00. Sum index 0
  // plus every allocated address.
  //
  // Failure shape matters on a solvency page: if INDEX 0 is unreadable the
  // whole figure is UNKNOWN (return null — never render a failed read as a
  // zero balance). If an ALLOCATED address is unreadable, skip it: that can
  // only UNDERCOUNT the surplus, never the core backing, which is the safe
  // direction to be wrong in.
  const one = async (a) => {
    const d = await jget(`/api/address/${a}`);
    if (d === null) return null;
    const sat = d.balance?.confirmed?.onchain_unspent_sat;
    return sat == null ? null : sat / 1e8;
  };
  const main = await one(RESERVE);
  if (main === null) return null;
  const allocated = Object.values(load().requests || {})
    .map((r) => r.address).filter((a) => a && a !== RESERVE);
  const extras = await Promise.all(allocated.map(one));
  return extras.reduce((sum, v) => sum + (v ?? 0), main);
}

// ── rate limit: the pool is finite, so allocation is what needs limiting ─────
const hits = new Map();
function tooMany(ip) {
  const now = Date.now(), w = 3600_000, cap = 10;
  const a = (hits.get(ip) || []).filter((t) => now - t < w);
  a.push(now); hits.set(ip, a);
  if (hits.size > 5000) hits.clear();
  return a.length > cap;
}

const esc = (s) => String(s).replace(/[&<>"']/g,
  (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const n8 = (x) => Number(x).toFixed(8);
const n2 = (x) => Number(x).toFixed(2);

// ── chrome ──────────────────────────────────────────────────────────────────
const CSS = `
:root{color-scheme:dark;--bg:#0d1117;--fg:#e6edf3;--mut:#8b949e;--card:#161b22;
 --line:#30363d;--blue:#58a6ff;--green:#3fb950;--amber:#d29922;--red:#f85149}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--fg);margin:0;
 font:16px/1.65 system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:47rem;margin:0 auto;padding:0 1.25rem 5rem}
header{border-bottom:1px solid var(--line);background:#0b0f14;position:sticky;top:0;z-index:9}
header .wrap{display:flex;align-items:center;gap:1.25rem;padding:.85rem 1.25rem;flex-wrap:wrap}
header b{font-size:1.02rem;letter-spacing:.01em}
nav{display:flex;gap:1.1rem;flex-wrap:wrap}
nav a{color:var(--mut);text-decoration:none;font-size:.94rem}
nav a:hover,nav a.on{color:var(--fg)}
nav a.on{border-bottom:2px solid var(--blue);padding-bottom:2px}
h1{font-size:1.55rem;margin:1.8rem 0 .35rem}
h2{font-size:.86rem;margin:2.1rem 0 .5rem;color:var(--mut);font-weight:600;
 text-transform:uppercase;letter-spacing:.06em}
a{color:var(--blue)}
code{background:var(--card);padding:.15rem .42rem;border-radius:5px;color:var(--blue);
 font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.92em;word-break:break-all}
.card{background:var(--card);border:1px solid var(--line);border-radius:11px;
 padding:1.1rem 1.25rem;margin:1rem 0}
.lead{color:var(--mut);font-size:1.03rem}
label{display:block;margin:.9rem 0 .3rem;color:var(--mut);font-size:.9rem}
input{width:100%;padding:.62rem .7rem;background:var(--bg);border:1px solid var(--line);
 border-radius:8px;color:var(--fg);font:15px ui-monospace,Menlo,Consolas,monospace}
input:focus{outline:2px solid var(--blue);outline-offset:-1px}
button{margin-top:1.1rem;padding:.62rem 1.25rem;background:#238636;border:0;
 border-radius:8px;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
button:hover{background:#2ea043}
.muted{color:var(--mut);font-size:.92rem}
.warn{border-left:3px solid var(--amber);padding-left:.9rem;color:#e3b341}
.err{border-left:3px solid var(--red);padding-left:.9rem;color:#ff7b72}
.ok{border-left:3px solid var(--green);padding-left:.9rem;color:#56d364}
table{width:100%;border-collapse:collapse;margin:.4rem 0}
td,th{text-align:left;padding:.42rem .5rem;border-bottom:1px solid #21262d;font-size:.93rem}
th{color:var(--mut);font-weight:600}
.big{font-size:1.5rem;font-weight:700}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(9.5rem,1fr));gap:1rem}
.bar{height:9px;background:#21262d;border-radius:99px;overflow:hidden;margin:.55rem 0}
.bar>i{display:block;height:100%;background:linear-gradient(90deg,var(--blue),#a371f7)}
.steps{counter-reset:s;padding:0;list-style:none;margin:0}
.steps li{counter-increment:s;position:relative;padding:.42rem 0 .42rem 2.4rem}
.steps li::before{content:counter(s);position:absolute;left:0;top:.42rem;width:1.6rem;
 height:1.6rem;border-radius:99px;background:#21262d;color:var(--fg);font-size:.85rem;
 display:grid;place-items:center;font-weight:700}
.pill{display:inline-block;padding:.1rem .55rem;border-radius:99px;font-size:.8rem;
 border:1px solid var(--line);color:var(--mut)}
a,td,li,.lead{overflow-wrap:anywhere}
th{white-space:nowrap;vertical-align:top}
input{min-width:0}
nav a{display:inline-block;padding:.35rem 0}
.help{margin-top:3.5rem;border-top:1px solid var(--line);padding-top:1rem}
@media (max-width:420px){
 .wrap{padding:0 1rem 4rem}
 header .wrap{gap:.5rem .9rem;padding:.6rem 1rem}
 nav{gap:.7rem}
 nav a{font-size:.9rem}
 h1{font-size:1.35rem}
 .card{padding:.9rem 1rem}
 .big{font-size:1.3rem}
 /* every table here is label/value: on a phone stack each row instead of squeezing two columns */
 table,tbody,tr,td,th{display:block}
 tr{padding:.5rem 0;border-bottom:1px solid #21262d}
 tr:last-child{border-bottom:none}
 td,th{padding:0;border-bottom:none;font-size:.93rem}
 th{white-space:normal;font-size:.78rem;text-transform:uppercase;letter-spacing:.05em;margin-bottom:.15rem}
 #connectBtn,#reviewBtn,#sendBtn,#backBtn,form>button{width:100%}
 #backBtn{margin-left:0!important;margin-top:.6rem}
}
`;

const NAV = [['/', 'Wrap'], ['/track', 'Track'], ['/redeem', 'Redeem'],
             ['/proof', 'Proof of backing'], ['/faq', 'FAQ']];

const page = (title, active, body) => `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head><body>
<header><div class="wrap"><b>PCoin wrap desk</b><nav>${
 NAV.map(([h, l]) => `<a href="${h}"${h === active ? ' class="on"' : ''}>${l}</a>`).join('')
}</nav></div></header>
<div class="wrap">${body}
<p class="muted help">Help: <a href="https://t.me/PCoinPCN" rel="noopener">Telegram @PCoinPCN</a> ·
<a href="https://github.com/pars5555/pcoin/issues" rel="noopener">report a problem</a><br>
<a href="https://pc.am">pc.am</a> · <a href="https://explorer.pc.am">explorer</a> ·
<a href="https://price.pc.am">price feed (JSON)</a> · <a href="https://docs.pc.am">docs</a></p></div></body></html>`;

// ── the honest block, shown wherever someone might be about to commit ────────
const RISKS = `<h2>Before you send anything</h2><div class="card">
<p class="warn"><b>wPCN is not PCN.</b> It is a claim on PCN held in a public
reserve, on a different chain. You can check that reserve yourself on the
<a href="/proof">proof page</a>.</p>
<p class="warn"><b>This is manual.</b> A person releases your wPCN after checking.
It is not instant and it is not automated.</p>
<p class="err"><b>The market for wPCN is small.</b> The PancakeSwap pool holds
only a few hundred dollars of liquidity, so even a small trade moves its price
sharply; <b>we trade that pool ourselves</b> to keep it near the rate posted at
price.pc.am, and the <b>liquidity is not locked</b> — the project holds the LP
tokens. Only send what you can afford to lose.</p></div>`;

// ── pages ───────────────────────────────────────────────────────────────────
const home = (msg = '') => page('PCoin wrap desk — turn PCN into wPCN', '/', `
<h1>Turn PCN into wPCN</h1>
<p class="lead">wPCN is PCoin wrapped as a BEP-20 on BNB Smart Chain, so it can
trade on PancakeSwap. Backed 1:1 by the PCN you send.</p>
${msg}
<div class="card"><form method="POST" action="/request">
<label>Your BSC address — where the wPCN will be sent. Use a wallet <b>you</b>
control (MetaMask, or any wallet that lets you add a custom BEP-20 token).
<b>Never an exchange deposit address</b> — no exchange lists wPCN, so it could
not credit you.</label>
<input name="bsc" placeholder="0x…" pattern="0x[0-9a-fA-F]{40}"
 title="0x followed by 40 hex characters" autocomplete="off" spellcheck="false" required>
<label>How much PCN do you want to wrap? (max ${PER_PERSON})</label>
<input name="amount" type="number" step="0.00000001" min="0.00000001"
 max="${PER_PERSON}" placeholder="e.g. 100" required>
<button type="submit">Get my deposit address</button>
</form></div>

<h2>How it works</h2><div class="card"><ol class="steps">
<li>You give your BSC address and an amount.</li>
<li>You get a PCoin deposit address that is <b>yours alone</b>.</li>
<li>You send PCN to it — any amount up to ${PER_PERSON}, any number of times.</li>
<li>After <b>${CONFIRMATIONS} confirmations</b> (~${WAIT_H}&nbsp;h) a person sends your wPCN.</li>
</ol><p class="muted" style="margin:.6rem 0 0">Track it at any point on the
<a href="/track">track page</a> using your deposit address.</p>
<p class="muted" style="margin:.6rem 0 0">To see the wPCN in your wallet, add it
as a custom token: contract <code>${TOKEN}</code>, symbol wPCN, 8 decimals. It
trades on <a href="https://pancakeswap.finance/swap?chain=bsc&amp;outputCurrency=${TOKEN}"
rel="noopener">PancakeSwap</a>. Want PCN back later? The
<a href="/redeem">redeem page</a> is the same door in the other direction.</p></div>

<h2>The terms</h2><div class="card"><table>
<tr><th>Limit</th><td>${PER_PERSON} PCN per person · ${TOTAL_ALLOC} wPCN total while the desk is new</td></tr>
<tr><th>Fee</th><td>${FEE_PCT}% — send 100 PCN, receive ${100 - FEE_PCT} wPCN</td></tr>
<tr><th>Wait</th><td>${CONFIRMATIONS} confirmations, about ${WAIT_H} hours</td></tr>
<tr><th>Backing</th><td>1:1, <a href="/proof">verifiable</a></td></tr>
</table><p class="muted" style="margin:.7rem 0 0">The limit and the fee exist to
slow a rush of wrapping-to-sell, not to make money — ${FEE_PCT}% of the entire
allocation comes to ${FEE_TOTAL} PCN.</p></div>
${RISKS}`);

const track = (msg = '') => page('Track a wrap', '/track', `
<h1>Track a wrap</h1>
<p class="lead">Enter the PCoin deposit address the desk gave you. This page
reads the chain live.</p>${msg}
<div class="card"><form method="GET" action="/status">
<label>Your deposit address</label>
<input name="addr" placeholder="pc1…" autocomplete="off" spellcheck="false" required>
<button type="submit">Check status</button>
</form></div>
<p class="muted">Lost the address? It is the one you sent PCN to — find it in your
wallet's sent transactions. Every address this desk hands out belongs to the
public reserve, so you can also look it up on
<a href="https://explorer.pc.am">explorer.pc.am</a>.</p>`);

const REDEEM_JS = String.raw`
(function () {
  'use strict';
  var SEL_REDEEM = '0x24b76fd5';            // keccak('redeem(uint256,string)')[:4]
  var SEL_BALANCE = '0x70a08231';           // keccak('balanceOf(address)')[:4]
  var BSC = '0x38';
  var $ = function (id) { return document.getElementById(id); };
  var eth = null, account = null, balance = null, checked = null;

  // ── ABI encoding (only what redeem() needs) ─────────────────────────────
  function hex32(n) { return n.toString(16).padStart(64, '0'); }
  function encodeRedeem(value, addr) {
    var b = new TextEncoder().encode(addr), h = '';
    for (var i = 0; i < b.length; i++) h += b[i].toString(16).padStart(2, '0');
    h = h.padEnd(Math.ceil(b.length / 32) * 64, '0');
    return SEL_REDEEM + hex32(value) + hex32(64n) + hex32(BigInt(b.length)) + h;
  }
  function parseAmount(t) {
    t = String(t).trim().replace(',', '.');
    if (!/^(\d+(\.\d{0,8})?|\.\d{1,8})$/.test(t)) return null;
    var parts = t.split('.'), i = parts[0] || '0', f = parts[1] || '';
    var v = BigInt(i) * 100000000n + BigInt((f + '00000000').slice(0, 8));
    return v > 0n ? v : null;
  }
  function fmt(v) {
    var t = v.toString().padStart(9, '0');
    return t.slice(0, -8) + '.' + t.slice(-8);
  }

  // ── PCoin address checks: bech32/bech32m (pc1…) and base58check (P…) ────
  var CS = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  var GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  function polymod(vals) {
    var chk = 1;
    for (var i = 0; i < vals.length; i++) {
      var top = chk >>> 25; chk = ((chk & 0x1ffffff) << 5) ^ vals[i];
      for (var j = 0; j < 5; j++) if ((top >>> j) & 1) chk ^= GEN[j];
    }
    return chk >>> 0;
  }
  function convertBits(data, from, to) {
    var acc = 0, bits = 0, out = [], maxv = (1 << to) - 1;
    for (var i = 0; i < data.length; i++) {
      acc = ((acc << from) | data[i]) & 0x3ffffff; bits += from;
      while (bits >= to) { bits -= to; out.push((acc >>> bits) & maxv); }
    }
    if (bits >= from || ((acc << (to - bits)) & maxv)) return null;
    return out;
  }
  function checkBech32(a) {
    if (a !== a.toLowerCase() && a !== a.toUpperCase()) return { ok: false, why: 'mixed upper and lower case' };
    a = a.toLowerCase();
    var pos = a.lastIndexOf('1');
    if (pos < 1 || pos + 7 > a.length || a.length > 90) return { ok: false, why: 'not an address' };
    var hrp = a.slice(0, pos);
    if (hrp !== 'pc') return { ok: false, why: 'this is not a PCoin address (PCoin addresses start with pc1)' };
    var data = [], hrpx = [], i;
    for (i = 0; i < hrp.length; i++) hrpx.push(hrp.charCodeAt(i) >> 5);
    hrpx.push(0);
    for (i = 0; i < hrp.length; i++) hrpx.push(hrp.charCodeAt(i) & 31);
    for (i = pos + 1; i < a.length; i++) {
      var d = CS.indexOf(a[i]); if (d < 0) return { ok: false, why: 'invalid character "' + a[i] + '"' };
      data.push(d);
    }
    var ver = data[0], want = ver === 0 ? 1 : 0x2bc830a3;
    if (polymod(hrpx.concat(data)) !== want) return { ok: false, why: 'checksum failed — one character is wrong' };
    var prog = convertBits(data.slice(1, -6), 5, 8);
    if (!prog || ver > 16 || prog.length < 2 || prog.length > 40) return { ok: false, why: 'malformed' };
    if (ver === 0 && prog.length !== 20 && prog.length !== 32) return { ok: false, why: 'malformed' };
    return { ok: true, kind: ver === 0 ? (prog.length === 20 ? 'native SegWit (pc1q…)' : 'SegWit script (pc1q…)') : ver === 1 ? 'Taproot (pc1p…)' : 'SegWit v' + ver };
  }
  var B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  function checkBase58(a) {
    var n = 0n, i, zeros = 0;
    for (i = 0; i < a.length; i++) {
      var d = B58.indexOf(a[i]); if (d < 0) return Promise.resolve({ ok: false, why: 'invalid character "' + a[i] + '"' });
      n = n * 58n + BigInt(d);
    }
    for (i = 0; i < a.length && a[i] === '1'; i++) zeros++;
    var h = n.toString(16); if (h.length % 2) h = '0' + h;
    var bytes = new Uint8Array(zeros + h.length / 2);
    for (i = 0; i < h.length / 2; i++) bytes[zeros + i] = parseInt(h.substr(i * 2, 2), 16);
    if (bytes.length !== 25) return Promise.resolve({ ok: false, why: 'not an address' });
    if (bytes[0] !== 55 && bytes[0] !== 56) return Promise.resolve({ ok: false, why: 'this is not a PCoin address' });
    return crypto.subtle.digest('SHA-256', bytes.slice(0, 21)).then(function (h1) {
      return crypto.subtle.digest('SHA-256', h1);
    }).then(function (h2) {
      var c = new Uint8Array(h2);
      for (var k = 0; k < 4; k++) if (c[k] !== bytes[21 + k]) return { ok: false, why: 'checksum failed — one character is wrong' };
      return { ok: true, kind: bytes[0] === 55 ? 'legacy (P…)' : 'legacy script (P…)' };
    });
  }
  function checkAddress(a) {
    a = a.trim();
    if (!a) return Promise.resolve({ ok: false, why: 'empty' });
    if (/^pc1/i.test(a)) return Promise.resolve(checkBech32(a));
    if (/^P[1-9A-HJ-NP-Za-km-z]{33}$/.test(a)) return checkBase58(a);
    if (/^(bc1|1|3|0x)/.test(a)) return Promise.resolve({ ok: false, why: 'that is a Bitcoin or BSC address, not a PCoin one — PCoin addresses start with pc1' });
    return Promise.resolve({ ok: false, why: 'not a PCoin address (pc1… or P…)' });
  }

  // ── UI ──────────────────────────────────────────────────────────────────
  function say(id, cls, text) {
    var el = $(id); el.className = cls; el.textContent = text; el.hidden = !text;
  }
  function errText(e) {
    if (!e) return 'unknown error';
    if (e.code === 4001) return 'You rejected the request in the wallet. Nothing was sent.';
    var m = (e.data && e.data.message) || e.message || String(e);
    return m.length > 300 ? m.slice(0, 300) + '…' : m;
  }
  function provider() {
    return window.ethereum || null;
  }
  function ensureBsc() {
    return eth.request({ method: 'eth_chainId' }).then(function (id) {
      if (String(id).toLowerCase() === BSC) return;
      return eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: BSC }] })
        .catch(function (e) {
          if (e && (e.code === 4902 || /4902|unrecognized|not added|Unrecognized chain/i.test(e.message || ''))) {
            return eth.request({ method: 'wallet_addEthereumChain', params: [{
              chainId: BSC, chainName: 'BNB Smart Chain',
              nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
              rpcUrls: ['https://bsc-dataseed.binance.org/'], blockExplorerUrls: ['https://bscscan.com'] }] });
          }
          throw e;
        }).then(function () { return eth.request({ method: 'eth_chainId' }); })
        .then(function (id2) {
          if (String(id2).toLowerCase() !== BSC) throw new Error('The wallet is not on BNB Smart Chain. Switch network in the wallet and try again.');
        });
    });
  }
  function readBalance() {
    var data = SEL_BALANCE + account.slice(2).toLowerCase().padStart(64, '0');
    return eth.request({ method: 'eth_call', params: [{ to: TOKEN, data: data }, 'latest'] }).then(function (r) {
      balance = BigInt(r === '0x' ? 0 : r);
      $('bal').textContent = fmt(balance) + ' wPCN';
      $('acct').textContent = account.slice(0, 6) + '…' + account.slice(-4);
      $('connected').hidden = false;
    });
  }
  function connect() {
    eth = provider();
    if (!eth) { $('nowallet').hidden = false; return; }
    say('msg', 'muted', 'Waiting for the wallet…');
    eth.request({ method: 'eth_requestAccounts' }).then(function (acc) {
      account = acc && acc[0]; if (!account) throw new Error('No account was shared by the wallet.');
      return ensureBsc();
    }).then(readBalance).then(function () {
      say('msg', '', ''); $('form').hidden = false; $('connectBtn').hidden = true;
    }).catch(function (e) { say('msg', 'err', 'Could not connect: ' + errText(e)); });
  }
  function review() {
    var v = parseAmount($('amount').value), a = $('addr').value.trim();
    checked = null; $('confirm').hidden = true;
    if (v === null) return say('msg', 'err', 'Enter an amount in wPCN, up to 8 decimals, greater than zero.');
    if (balance !== null && v > balance) return say('msg', 'err', 'That is more than this account holds (' + fmt(balance) + ' wPCN).');
    say('msg', 'muted', 'Checking the address…');
    checkAddress(a).then(function (r) {
      if (!r.ok) return say('msg', 'err', 'PCoin address rejected: ' + r.why + '. Nothing was sent.');
      // bech32 is case-insensitive but the desk's tooling expects lower case
      if (/^pc1/i.test(a)) a = a.toLowerCase();
      checked = { value: v, addr: a };
      $('c_amount').textContent = fmt(v) + ' wPCN';
      $('c_addr').textContent = a;
      $('c_kind').textContent = r.kind;
      $('c_acct').textContent = account;
      say('msg', '', ''); $('confirm').hidden = false;
    });
  }
  function send() {
    if (!checked) return;
    var c = checked; checked = null; $('confirm').hidden = true;
    $('sendBtn').disabled = true;
    say('msg', 'muted', 'Confirm the transaction in your wallet…');
    ensureBsc().then(function () {
      var data = encodeRedeem(c.value, c.addr);
      // Only from/to/data. Every fee field is left to the wallet on purpose: a
      // pre-filled null here is exactly what breaks BscScan's form on MetaMask.
      return eth.request({ method: 'eth_sendTransaction', params: [{ from: account, to: TOKEN, data: data }] });
    }).then(function (hash) {
      $('sendBtn').disabled = false;
      $('form').hidden = true;
      $('txlink').href = 'https://bscscan.com/tx/' + hash; $('txlink').textContent = hash;
      $('done').hidden = false;
      say('msg', '', '');
      try {
        var k = 'wpcn-redeems', l = JSON.parse(localStorage.getItem(k) || '[]');
        l.unshift({ hash: hash, amount: fmt(c.value), to: c.addr, at: new Date().toISOString() });
        localStorage.setItem(k, JSON.stringify(l.slice(0, 20)));
      } catch (e) {}
      watch(hash);
    }).catch(function (e) {
      $('sendBtn').disabled = false; $('form').hidden = false;
      say('msg', 'err', 'Not sent: ' + errText(e));
    });
  }
  function watch(hash) {
    var tries = 0;
    (function poll() {
      eth.request({ method: 'eth_getTransactionReceipt', params: [hash] }).then(function (r) {
        if (r && r.blockNumber) {
          var okk = r.status === '0x1' || r.status === 1 || r.status === true;
          say('status', okk ? 'ok' : 'err', okk
            ? 'Burn confirmed in BSC block ' + parseInt(r.blockNumber, 16) + '. Once BSC finalises it (a minute or two) the desk sees it on its next check; a person then sends your PCN. Allow hours, not minutes.'
            : 'The transaction was mined but REVERTED — nothing was burned and no PCN is owed. Check the balance and try again.');
          return;
        }
        if (++tries < 60) setTimeout(poll, 4000);
        else say('status', 'muted', 'Still pending after 4 minutes. Keep the hash; the burn counts when it is mined.');
      }).catch(function () { if (++tries < 60) setTimeout(poll, 4000); });
    })();
  }
  function showPrevious() {
    try {
      var l = JSON.parse(localStorage.getItem('wpcn-redeems') || '[]');
      if (!l.length) return;
      var ul = $('prevlist');
      l.forEach(function (r) {
        var li = document.createElement('li'), a = document.createElement('a');
        a.href = 'https://bscscan.com/tx/' + r.hash; a.rel = 'noopener'; a.textContent = r.hash.slice(0, 10) + '…' + r.hash.slice(-6);
        li.appendChild(document.createTextNode(r.at.slice(0, 16).replace('T', ' ') + ' UTC · ' + r.amount + ' wPCN → ' + r.to + ' · '));
        li.appendChild(a); ul.appendChild(li);
      });
      $('prev').hidden = false;
    } catch (e) {}
  }

  $('connectBtn').addEventListener('click', connect);
  $('reviewBtn').addEventListener('click', review);
  $('sendBtn').addEventListener('click', send);
  $('maxBtn').addEventListener('click', function () { if (balance !== null) { $('amount').value = fmt(balance); } });
  $('backBtn').addEventListener('click', function () { checked = null; $('confirm').hidden = true; });
  $('addr').addEventListener('input', function () { checked = null; $('confirm').hidden = true; });
  $('amount').addEventListener('input', function () { checked = null; $('confirm').hidden = true; });
  showPrevious();
  if (!provider()) {
    // MetaMask injects at document start; give a slow in-app browser a moment.
    setTimeout(function () { if (!provider()) { $('nowallet').hidden = false; } }, 1200);
  }
})();
`;

const redeem = () => page('Redeem wPCN back into PCN', '/redeem', `
<h1>Redeem wPCN back into PCN</h1>
<p class="lead">The door opens both ways. Redemption is done by the token
contract itself — this page only helps your wallet call it.</p>

<h2>From your wallet</h2><div class="card">
<ol class="steps" style="margin-bottom:.8rem">
<li>On a phone, open this page <b>inside your wallet's own browser</b>
 (MetaMask &rarr; Browser tab &rarr; <code>wrapdesk.pc.am/redeem</code>). On a
 computer, use a browser with the MetaMask extension.</li>
<li>Tap <b>Connect wallet</b> and approve. The page switches the wallet to BNB
 Smart Chain and shows your wPCN balance.</li>
<li>Enter the amount and the PCoin address (<code>pc1q…</code>) the PCN should
 go to, then <b>Review</b>.</li>
<li>Read the summary, press <b>Burn and request PCN</b>, and confirm in the
 wallet. The account needs a little BNB for the network fee — with none, the
 wallet refuses and it looks as if this page is broken.</li>
<li>A person sends the PCN to your address. Allow hours, not minutes.</li>
</ol>
<p class="muted" style="margin-top:0">The page checks the PCoin address, shows you
exactly what will be burned, and asks the wallet to sign one transaction.</p>
<button id="connectBtn" type="button" style="margin-top:.4rem">Connect wallet</button>
<div id="nowallet" hidden>
<p class="warn"><b>No wallet found in this browser.</b>
On a phone, open this page inside your wallet's own browser —
<a href="https://metamask.app.link/dapp/wrapdesk.pc.am/redeem">tap here to open it in MetaMask</a>.
On a computer, use a browser with the MetaMask extension. Or use the manual
route further down.</p></div>
<div id="connected" hidden><table>
<tr><th>Account</th><td><code id="acct"></code></td></tr>
<tr><th>wPCN held</th><td><b id="bal"></b></td></tr></table></div>
<div id="form" hidden>
<label for="amount">Amount to redeem, in wPCN</label>
<div style="display:flex;gap:.6rem;align-items:center">
<input id="amount" inputmode="decimal" autocomplete="off" placeholder="1.00000000">
<button id="maxBtn" type="button" style="margin:0;padding:.55rem .8rem;background:#21262d">All</button></div>
<label for="addr">PCoin address to receive the PCN (pc1q…)</label>
<input id="addr" autocomplete="off" spellcheck="false" placeholder="pc1q…">
<button id="reviewBtn" type="button">Review</button>
<div id="confirm" hidden style="margin-top:1.1rem;border:1px solid var(--amber);border-radius:9px;padding:1rem 1.1rem">
<p style="margin:0 0 .5rem" class="warn"><b>Read this once more before you press the button.</b></p>
<table>
<tr><th>Burn</th><td><b id="c_amount"></b> from <code id="c_acct"></code></td></tr>
<tr><th>PCN goes to</th><td><code id="c_addr"></code><br><span class="muted" id="c_kind"></span></td></tr></table>
<p class="muted" style="margin:.5rem 0 0">The address has a valid checksum, which
rules out a typo. It does not prove the address is <i>yours</i> — that only you
can check, in the wallet you copied it from.</p>
<button id="sendBtn" type="button" style="background:#9e6a03">Burn and request PCN</button>
<button id="backBtn" type="button" style="background:#21262d;margin-left:.6rem">Back</button></div>
</div>
<div id="done" hidden>
<p class="ok"><b>Sent.</b> Transaction: <a id="txlink" rel="noopener" target="_blank" style="overflow-wrap:anywhere"></a></p>
<p class="muted">Keep that hash — it is your receipt. The desk pays the PCoin
address you gave; nothing else needs to be done on your side.</p></div>
<p id="status" class="muted" hidden></p>
<p id="msg" hidden></p>
<div id="prev" hidden><h2 style="margin-top:1.4rem">Redemptions from this device</h2>
<ul id="prevlist" class="muted" style="padding-left:1.1rem;font-size:.88rem"></ul></div>
<noscript><p class="err">This helper needs JavaScript. The manual route below works without it.</p></noscript>
</div>

<div class="card">
<p class="err"><b>Check the address twice.</b> The burn happens first and cannot
be undone. If the PCoin address is wrong, your wPCN is gone and we have nowhere
valid to send the PCN — we will have to contact you to fix it.</p>
<p class="warn"><b>Redemption is manual, like wrapping.</b> The contract cannot
send PCN by itself: no contract on BNB Smart Chain can move a coin on the PCoin
chain. A person does it. Allow hours, not minutes.</p></div>

<h2>Manual route</h2><div class="card"><ol class="steps">
<li>Open the wPCN contract on
 <a href="https://bscscan.com/address/${TOKEN}#writeContract">BscScan</a> and
 connect the wallet holding your wPCN.</li>
<li>Call <code>redeem(value, pcoinAddress)</code> — the amount in satoshi-units
 (8 decimals, so 1 wPCN is <code>100000000</code>), and the PCoin address you
 want the PCN sent to.</li>
<li>The contract <b>burns your wPCN immediately</b> and logs your address.</li>
<li>A person sends the PCN.</li>
</ol>
<p class="muted" style="margin-bottom:0">Known problem: BscScan's form fails on
MetaMask for Android with <i>"Invalid params … maxFeePerGas … received:
null"</i>. That is BscScan's page, not your wallet — use the button above.</p></div>

<h2>Why it matters</h2><div class="card"><p class="muted">A wrapped token nobody
can redeem is an IOU resting on trust. A redeemable one is checkable — and it is
what lets arbitrage hold the PCN and wPCN prices together. Every redemption also
shows up in the <a href="/proof">backing figures</a>, because burning lowers the
supply the reserve has to cover.</p></div>
<script>var TOKEN=${JSON.stringify(TOKEN)};</script>
<script>${REDEEM_JS}</script>`);

async function proof() {
  const bal = await reserveBalance();
  const known = bal !== null;
  const ratio = known && ISSUED > 0 ? bal / ISSUED : null;
  const bar = ratio === null ? 0 : Math.max(0, Math.min(100, ratio * 100));
  return page('Proof of backing', '/proof', `
<h1>Proof of backing</h1>
<p class="lead">Every wPCN is backed by PCN in a public address. Do not take our
word for it — both numbers below are things you can check yourself.</p>

<div class="card"><div class="grid">
<div><div class="muted">PCN in the reserve wallet <span class="muted" style="font-size:.8rem">(main address + deposit addresses)</span></div>
 <div class="big" style="color:${known ? 'var(--green)' : 'var(--amber)'}">${
   known ? n2(bal) : 'UNKNOWN'}</div></div>
<div><div class="muted">wPCN issued <span style="font-size:.8rem">(issuedSupply, fixed at creation)</span></div><div class="big">${n2(ISSUED)}</div>
  <div class="muted" style="font-size:.8rem">outstanding totalSupply is lower by everything redeemed</div></div>
<div><div class="muted">Backing</div><div class="big">${
  ratio === null ? '—' : (ratio * 100).toFixed(1) + '%'}</div></div>
<div><div class="muted">Surplus</div><div class="big">${
  known ? n2(Math.max(0, bal - ISSUED)) : '—'}</div>
  <div class="muted" style="font-size:.8rem">PCN above 1:1</div></div>
</div>
<div class="bar"><i style="width:${bar}%"></i></div>
${known
 ? (ratio >= 1
   ? `<p class="ok">Fully backed. The reserve holds at least one PCN for every wPCN in existence.</p>`
   : `<p class="err"><b>UNDER-BACKED.</b> The reserve holds less PCN than there is wPCN. Do not wrap or buy until this is explained.</p>`)
 : `<p class="warn"><b>Could not read the reserve just now.</b> This means
    <b>unknown</b>, not zero and not a problem — the explorer may simply be
    unreachable. Check the address directly.</p>`}
</div>

<div class="card"><p class="muted"><b>What the surplus is.</b> wPCN is never
minted — a wrap moves existing tokens from the desk's inventory, so every deposit
raises the reserve without raising the supply it has to cover. The surplus is that
excess: PCN in the reserve over and above the 1:1 requirement. It exists because
the desk charges ${FEE_PCT}% and because wrapping adds backing faster than it adds
circulating tokens. It is not customer money and holding it makes the token
<i>more</i> covered, not less.</p></div>

<h2>Check it yourself</h2><div class="card"><table>
<tr><th>Reserve address</th><td><a href="https://explorer.pc.am/address/${RESERVE}"><code>${RESERVE}</code></a><br>
<span class="muted" style="font-size:.85rem">The figure above also counts the deposit addresses this desk has handed out, which belong to the same wallet — so it can read slightly higher than this one address.</span></td></tr>
<tr><th>wPCN contract</th><td><a href="https://bscscan.com/address/${TOKEN}#readContract"><code>${TOKEN}</code></a></td></tr>
</table>
<p class="muted" style="margin-top:.7rem">On BscScan read <code>issuedSupply</code>
(what was ever created — immutable) and <code>totalSupply</code> (what is still
outstanding). The difference is everything ever redeemed. Compare
<code>totalSupply</code> against the reserve balance above.</p></div>

<h2>What the contract cannot do</h2><div class="card"><table>
<tr><th>Mint more</th><td>There is no mint function. The whole supply was created once, in the constructor.</td></tr>
<tr><th>Be controlled</th><td>There is no owner and no admin. Nobody can pause, freeze or seize.</td></tr>
<tr><th>Accept deposits</th><td>Deliberately absent. A bridge that lets anyone deposit and mint is what a majority miner monetises.</td></tr>
</table></div>

<h2>What this does <i>not</i> prove</h2><div class="card">
<p class="muted">That the reserve address is controlled honestly. No contract on
BNB Smart Chain can verify a balance on the PCoin chain, so the 1:1 claim rests
on the reserve being real and on us not spending it. What you get is
<b>visibility</b>: the address is published, so a breach of that promise would be
public the moment it happened.</p></div>`);
}

const faq = () => page('FAQ', '/faq', `
<h1>Questions people actually ask</h1>

<h2>Is wPCN the same as PCN?</h2><div class="card"><p class="muted">No. wPCN is a
token on BNB Smart Chain that represents PCN held in a reserve. It is useful
because it can trade on PancakeSwap; it is <b>not</b> the coin itself, and you
cannot use it to pay for anything that takes PCN.</p></div>

<h2>Why does it take about ${WAIT_H} hours?</h2><div class="card"><p class="muted">${CONFIRMATIONS}
confirmations at roughly ten minutes a block. The depth is what protects the desk
against a chain reorganisation — if we released wPCN after two confirmations and
the deposit were later reversed, the wPCN would exist with nothing behind it.
The wait is the defence.</p></div>

<h2>Why is there a limit?</h2><div class="card"><p class="muted">${PER_PERSON} PCN
per person, ${TOTAL_ALLOC} wPCN in total. The PancakeSwap pool is small, so a
large amount of new wPCN arriving at once would move the price hard against
whoever sold second. The limit protects the people using it, and it will rise as
the pool deepens.</p></div>

<h2>What is the fee for?</h2><div class="card"><p class="muted">${FEE_PCT}%, and it
is friction rather than income — ${FEE_PCT}% of the entire allocation comes to
${FEE_TOTAL} PCN. It exists to slow a rush of people wrapping purely to sell.</p></div>

<h2>Can I send more than once to the same address?</h2><div class="card">
<p class="muted">Yes. Your deposit address is permanent and reusable. Each deposit
is handled separately, and the per-person limit applies across all of them.</p></div>

<h2>I sent the wrong amount / to the wrong place</h2><div class="card">
<p class="muted">If you sent more than ${PER_PERSON} PCN, the excess is returned.
If you sent to an address that is not yours, tell us — the deposit addresses all
belong to one reserve wallet, so the PCN is not lost, but working out whose it is
takes a human.</p></div>

<h2>I typed the wrong BSC address on the form</h2><div class="card">
<p class="muted">If you have not sent PCN yet, simply submit the form again with
the right address — a new request gets its own deposit address. If you have
already sent PCN, <b>get in touch before the wPCN is released</b> (Telegram
<a href="https://t.me/PCoinPCN" rel="noopener">@PCoinPCN</a>) and quote your
deposit address; the release is done by a person, who can hold it.</p></div>

<h2>Which wallet do I need?</h2><div class="card"><p class="muted">For wPCN:
MetaMask, or any wallet on BNB Smart Chain that lets you add a custom BEP-20
token (contract <code>${TOKEN}</code>, 8 decimals). Not an exchange deposit
address — exchanges do not list wPCN and cannot credit it. For the PCN side you
need a PCoin address, from the <a href="https://pc.am/#download">PCoin wallet
app</a> or a node.</p></div>

<h2>Is the PancakeSwap price the PCN price?</h2><div class="card">
<p class="muted">No. The PCN price is the one posted at
<a href="https://price.pc.am">price.pc.am</a>, and that is what every service
that accepts PCN charges against. The pool is small and we trade it ourselves to
keep it near that rate — so the pool follows price.pc.am, never the other way
round. Do not read the pool as the market's verdict on PCN.</p></div>

<h2>How do I get PCN back?</h2><div class="card"><p class="muted">Through the
<a href="/redeem">redeem page</a>: your wallet burns the wPCN and names a PCoin
address, and a person sends the PCN there — 1 PCN for every 1 wPCN burned, no
fee on that side, but not instant. The burn is done by the token contract and
cannot be undone, so check the PCoin address twice.</p></div>

<h2>Who runs this?</h2><div class="card"><p class="muted">The PCoin project. The
same people who run <a href="https://pc.am">pc.am</a>, the explorer and the
pool. There is no separate company and no custodian.</p></div>

<h2>What is the worst case?</h2><div class="card"><p class="muted">You send PCN and
we fail to send wPCN. There is no smart contract enforcing our side of a wrap —
it is a person doing it. That is why the amounts are capped low, why the reserve
is public, and why we would rather you tested with a small amount first.</p></div>`);

const body = (req) => new Promise((res) => {
  let d = ''; req.on('data', (c) => { d += c; if (d.length > 4096) req.destroy(); });
  req.on('end', () => res(d));
});

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
           || req.socket.remoteAddress || '?';
  const send = (code, html) => {
    res.writeHead(code, { 'content-type': 'text/html; charset=utf-8',
      'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' });
    res.end(html);
  };

  try {
    const p = url.pathname;
    // HEAD answers like GET (Node drops the body itself): link checkers, uptime
    // monitors and social-card fetchers all probe with HEAD and read 404 as "dead".
    const isGet = req.method === 'GET' || req.method === 'HEAD';
    if (isGet && p === '/')       return send(200, home());
    if (isGet && p === '/track')  return send(200, track());
    if (isGet && p === '/redeem') return send(200, redeem());
    if (isGet && p === '/faq')    return send(200, faq());
    if (isGet && p === '/proof')  return send(200, await proof());

    // ── allocate (or return) a deposit address ──────────────────────────────
    if (req.method === 'POST' && p === '/request') {
      const f = new URLSearchParams(await body(req));
      const bsc = (f.get('bsc') || '').trim();
      const amount = Number(f.get('amount'));

      if (!isBsc(bsc))
        return send(400, home(`<p class="err">That is not a BSC address. It must
          be <code>0x</code> followed by 40 hex characters.</p>`));
      if (!(amount > 0))
        return send(400, home(`<p class="err">Enter how much PCN you want to wrap.</p>`));

      const st = load();
      const key = bsc.toLowerCase();
      let r = st.requests[key];
      if (!r) {
        if (tooMany(ip))
          return send(429, home(`<p class="err">Too many new requests from your
            connection. Please try again later.</p>`));
        if (st.nextIndex >= pool.length)
          return send(503, home(`<p class="err">The desk has run out of deposit
            addresses. That is our problem, not yours — please get in touch.</p>`));
        const slot = pool.find((x) => x.i === st.nextIndex);
        r = { bsc, index: slot.i, address: slot.a, amount,
              created: Date.now(), released: null };
        st.requests[key] = r; st.nextIndex = slot.i + 1; save(st);
      } else if (amount > 0 && r.amount !== amount) { r.amount = amount; save(st); }

      const eligible = Math.min(amount, PER_PERSON);
      const net = eligible * (1 - FEE_PCT / 100);
      return send(200, page('Your deposit address', '/', `
<h1>Send PCN to this address</h1>
<div class="card"><p class="muted">Your deposit address — <b>yours alone</b>, and
reusable. Send to it any time.</p>
<p><code style="font-size:1.06rem">${esc(r.address)}</code></p></div>
<div class="card"><table>
<tr><th>You send</th><td>${esc(String(amount))} PCN</td></tr>
<tr><th>Fee (${FEE_PCT}%)</th><td>${n8(eligible * FEE_PCT / 100)} wPCN</td></tr>
<tr><th>You receive</th><td><b>${n8(net)} wPCN</b></td></tr>
<tr><th>Sent to</th><td><code>${esc(r.bsc)}</code></td></tr>
<tr><th>Ready after</th><td>${CONFIRMATIONS} confirmations (~${WAIT_H} hours)</td></tr>
</table></div>
<p class="warn"><b>Save this address.</b> It is how you track your wrap, and how we
know the PCN is yours. It does not matter which wallet or address you send
from — the deposit address alone identifies you.</p>
<div class="card"><form method="GET" action="/status">
<input type="hidden" name="addr" value="${esc(r.address)}">
<button type="submit">Track my wrap</button></form></div>`));
    }

    // ── live status ─────────────────────────────────────────────────────────
    if (req.method === 'GET' && p === '/status') {
      const addr = (url.searchParams.get('addr') || '').trim();
      if (!isPcn(addr))
        return send(400, track(`<p class="err">That is not a PCoin address.</p>`));
      if (!pool.some((x) => x.a === addr))
        return send(404, track(`<p class="err">That is not one of this desk's
          deposit addresses. Check it against what you were given.</p>`));

      const items = await deposits(addr);
      if (items === null)
        return send(200, page('Status unknown', '/track', `
<h1>Status unavailable</h1>
<p class="warn">We could not reach the explorer, so we <b>cannot tell</b> whether
your deposit has arrived. This does <b>not</b> mean it has not.</p>
<p class="muted">Nothing is lost. Reload in a minute, or check
<a href="https://explorer.pc.am/address/${esc(addr)}">the explorer</a> directly.</p>`));

      if (!items.length)
        return send(200, page('No deposit yet', '/track', `
<h1>Nothing received yet</h1>
<p class="muted">No PCN has arrived at <code>${esc(addr)}</code>. If you have just
sent it, it can take a few minutes to appear.</p>
<p class="muted">This page reads the chain live — reload any time.</p>`));

      const rows = items.map((i) => {
        const pct = i.pending ? 0
          : Math.max(0, Math.min(100, i.confirmations / CONFIRMATIONS * 100));
        const ready = !i.pending && i.confirmations >= CONFIRMATIONS;
        const left = Math.max(0, CONFIRMATIONS - (i.pending ? 0 : i.confirmations));
        const eta = ready ? 'ready now'
          : `about ${Math.max(1, Math.round(left * 10 / 60))} h left`;
        // A customer watching "in the mempool" for half an hour will assume
        // something is broken. Block finding is a Poisson process: at a ~9 min
        // mean, gaps over 25 min happen roughly one block in eighteen. Saying so
        // costs a sentence and prevents a support message.
        const state = i.pending
          ? 'In the mempool — waiting to be included in a block. Blocks average '
            + 'about ten minutes but are random: a gap of half an hour is '
            + 'uncommon and not a problem.'
          : ready ? '<b>Confirmed — waiting for a person to release it</b>'
          : `${i.confirmations} of ${CONFIRMATIONS} confirmations`;
        return `<div class="card">
          <div style="display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap">
            <div><div class="muted">Received</div><div class="big">${n8(i.pcn)} PCN</div></div>
            <div><div class="muted">You get</div><div class="big">${
              n8(Math.min(i.pcn, PER_PERSON) * (1 - FEE_PCT / 100))} wPCN</div></div>
            <div><div class="muted">Status</div><div style="padding-top:.35rem">
              <span class="pill">${eta}</span></div></div>
          </div>
          <div class="bar"><i style="width:${pct}%"></i></div>
          <p class="muted" style="margin:.2rem 0 0">${state}</p>
          ${i.pcn > PER_PERSON ? `<p class="warn">Above the ${PER_PERSON} PCN cap —
            ${n2(i.pcn - PER_PERSON)} PCN will be returned.</p>` : ''}
          <p class="muted" style="margin:.45rem 0 0">
            <a href="https://explorer.pc.am/tx/${esc(i.txid)}">${esc(i.txid.slice(0, 24))}…</a></p>
        </div>`;
      }).join('');

      const anyReady = items.some((i) => !i.pending && i.confirmations >= CONFIRMATIONS);
      return send(200, page('Your wrap status', '/track', `
<h1>Your wrap</h1>
<p class="lead">Deposits to <code>${esc(addr)}</code></p>
${rows}
${anyReady
 ? `<p class="ok">Confirmed. Your wPCN is queued for release — a person sends it,
    so allow some hours.</p>`
 : `<p class="warn">Still confirming. The depth is what protects the desk against
    a chain reorganisation, which is why it is not instant.</p>`}
<p class="muted">This page reads the chain live. Reload any time.
Times are estimates: PCoin blocks average ten minutes but vary a lot.</p>`));
    }

    return send(404, page('Not found', '', `<h1>Page not found</h1>
      <p class="muted">Try the <a href="/">wrap desk</a>.</p>`));
  } catch (e) {
    console.error('[wrapdesk]', e);
    return send(500, page('Error', '', `<h1>Something broke</h1>
      <p class="err">That is our fault, not yours. Nothing is lost — your deposit
      address stays valid. Please try again shortly.</p>`));
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`wrapdesk on 127.0.0.1:${PORT}, ${pool.length} addresses, ` +
              `fee ${FEE_PCT}%, cap ${PER_PERSON}/person`);
});
