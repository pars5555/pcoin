/**
 * wrapdesk.pc.am — the public face of the PCN → wPCN wrap desk.
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
 * The same BSC address always gets the same deposit address. Two reasons, and
 * the second is the important one:
 *
 *   1. a fresh address per request would let anyone exhaust a 2,000-address
 *      pool with a loop;
 *   2. it makes the ledger key (txid, address) rather than (txid, vout) — the
 *      rule all four early deposit rails got wrong. `vout` is always 0 for
 *      these, so keying on it silently DROPS a person's second deposit instead
 *      of erroring. Reuse forces the correct key to be the obvious one.
 *
 * WHAT THIS SERVER MAY NOT DO
 *
 * It never sends wPCN, never touches a key, never marks anything paid, and has
 * no admin surface on this port at all. It records intent and reports what the
 * chain says. A human releases the wPCN from the operator dashboard. That is
 * the same shape as the rest of the desk: the machine observes, a person pays.
 *
 * UNREADABLE IS NOT ZERO. If the explorer cannot be reached, status is reported
 * as UNKNOWN — never as "no deposit found". A failed read that renders as
 * "nothing received" is how a paying customer gets told they did not pay.
 */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const PORT       = Number(process.env.WRAPDESK_PORT || 8791);
const POOL_FILE  = process.env.WRAPDESK_POOL  || '/opt/wrapdesk/reserve-pool.txt';
const STATE_FILE = process.env.WRAPDESK_STATE || '/var/lib/wrapdesk/requests.json';
const EXPLORER   = process.env.WRAPDESK_EXPLORER || 'https://explorer.pc.am';

const FEE_PCT      = Number(process.env.WRAP_FEE_PCT || 5);
const PER_PERSON   = Number(process.env.WRAP_PER_PERSON || 250);
const TOTAL_ALLOC  = Number(process.env.WRAP_TOTAL_ALLOC || 1500);
const CONFIRMATIONS= Number(process.env.WRAP_CONFIRMATIONS || 100);

// Index 0 is the MAIN RESERVE holding the 50,000 PCN of backing. It must never
// be handed to a requester, or a customer deposit becomes indistinguishable
// from the backing itself.
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

// ── validation ──────────────────────────────────────────────────────────────
// Shape only. A well-formed address can still be a typo, which is why the
// operator confirms before sending and why nothing here moves money.
const isBsc = (s) => typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s);

// ── explorer reads. null means UNKNOWN and must never render as zero ─────────
async function deposits(addr) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 20000);
    const r = await fetch(`${EXPLORER}/api/address/${addr}`, { signal: c.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    const d = await r.json();
    const conf = (d.history?.items || [])
      .filter((i) => Number(i.received_pcn) > 0)
      .map((i) => ({ txid: i.txid, pcn: Number(i.received_pcn),
                     confirmations: Number(i.confirmations ?? 0), pending: false }));
    const pend = (d.unconfirmed_history?.items || [])
      .filter((i) => Number(i.received_pcn) > 0)
      .map((i) => ({ txid: i.txid, pcn: Number(i.received_pcn),
                     confirmations: 0, pending: true }));
    return [...pend, ...conf];
  } catch { return null; }
}

// ── rate limit ──────────────────────────────────────────────────────────────
// The pool is a finite resource, so allocation is the thing worth limiting.
const hits = new Map();
function tooMany(ip) {
  const now = Date.now(), w = 3600_000, cap = 10;
  const a = (hits.get(ip) || []).filter((t) => now - t < w);
  a.push(now); hits.set(ip, a);
  if (hits.size > 5000) hits.clear();        // crude, bounded, good enough here
  return a.length > cap;
}

const esc = (s) => String(s).replace(/[&<>"']/g,
  (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

// ── pages ───────────────────────────────────────────────────────────────────
const CSS = `
:root{color-scheme:dark}
*{box-sizing:border-box}
body{background:#0d1117;color:#e6edf3;font:16px/1.65 system-ui,-apple-system,sans-serif;
 max-width:46rem;margin:0 auto;padding:2.5rem 1.25rem 5rem}
h1{font-size:1.6rem;margin:.2rem 0 .3rem}
h2{font-size:1.05rem;margin:2rem 0 .6rem;color:#8b949e;font-weight:600;
 text-transform:uppercase;letter-spacing:.04em}
a{color:#58a6ff}
code{background:#161b22;padding:.15rem .4rem;border-radius:4px;color:#58a6ff;
 font-family:ui-monospace,Menlo,Consolas,monospace;word-break:break-all}
.card{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:1.1rem 1.25rem;margin:1rem 0}
label{display:block;margin:.9rem 0 .3rem;color:#8b949e;font-size:.9rem}
input{width:100%;padding:.6rem .7rem;background:#0d1117;border:1px solid #30363d;
 border-radius:7px;color:#e6edf3;font:15px ui-monospace,Menlo,Consolas,monospace}
button{margin-top:1.1rem;padding:.6rem 1.2rem;background:#238636;border:0;border-radius:7px;
 color:#fff;font-size:15px;font-weight:600;cursor:pointer}
button:hover{background:#2ea043}
.muted{color:#8b949e;font-size:.9rem}
.warn{border-left:3px solid #d29922;padding-left:.9rem;color:#e3b341}
.err{border-left:3px solid #f85149;padding-left:.9rem;color:#ff7b72}
.ok{border-left:3px solid #3fb950;padding-left:.9rem;color:#56d364}
table{width:100%;border-collapse:collapse;margin:.6rem 0}
td,th{text-align:left;padding:.35rem .5rem;border-bottom:1px solid #21262d;font-size:.92rem}
`;

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head><body>${body}
<p class="muted" style="margin-top:3rem">
<a href="/">wrap desk</a> · <a href="https://pc.am">pc.am</a> ·
<a href="https://explorer.pc.am">explorer</a></p></body></html>`;

const home = (msg = '') => page('PCN → wPCN wrap desk', `
<h1>Wrap PCN into wPCN</h1>
<p class="muted">Send PCN, receive <b>wPCN</b> on BNB Smart Chain — the BEP-20 that
trades on PancakeSwap. Backed 1:1 by the PCN you send.</p>
${msg}
<div class="card">
<form method="POST" action="/request">
<label>Your BSC address — where the wPCN will be sent</label>
<input name="bsc" placeholder="0x…" autocomplete="off" spellcheck="false" required>
<label>How much PCN do you want to wrap?</label>
<input name="amount" type="number" step="0.00000001" min="0.00000001"
 max="${PER_PERSON}" placeholder="e.g. 100" required>
<button type="submit">Get my deposit address</button>
</form>
</div>

<h2>How it works</h2>
<div class="card">
<table>
<tr><td>1</td><td>You get a deposit address that is <b>yours alone</b>.</td></tr>
<tr><td>2</td><td>You send PCN to it.</td></tr>
<tr><td>3</td><td>After <b>${CONFIRMATIONS} confirmations</b> (~18 hours) the wPCN is sent by hand.</td></tr>
</table>
</div>

<h2>Read this before sending</h2>
<div class="card">
<p class="warn"><b>Limits.</b> ${PER_PERSON} PCN per person, ${TOTAL_ALLOC} wPCN in total
while the desk is new. Sending more than ${PER_PERSON} does not wrap more — the excess
is returned.</p>
<p class="warn"><b>Fee: ${FEE_PCT}%.</b> Send 100 PCN, receive ${(100*(1-FEE_PCT/100)).toFixed(2)} wPCN.
The fee exists to slow a rush of wrapping-to-dump, not to make money.</p>
<p class="warn"><b>This is manual and slow.</b> A person sends your wPCN after checking.
It is not instant and it is not automated.</p>
<p class="err"><b>wPCN is not PCN.</b> It is a claim on PCN held in a public reserve,
on a different chain. The PancakeSwap pool is small, so its price moves a lot on small
trades, and <b>we trade that pool ourselves</b> to keep it near the rate posted at
price.pc.am. The <b>liquidity is not locked</b> and the project holds the LP tokens.
Only send what you can afford to lose.</p>
</div>

<h2>Already sent? Check your status</h2>
<div class="card">
<form method="GET" action="/status">
<label>Your deposit address (the <code>pc1…</code> you were given)</label>
<input name="addr" placeholder="pc1…" autocomplete="off" spellcheck="false" required>
<button type="submit">Check status</button>
</form>
</div>`);

// ── server ──────────────────────────────────────────────────────────────────
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
    if (req.method === 'GET' && url.pathname === '/') return send(200, home());

    // ── allocate (or return) a deposit address ──────────────────────────────
    if (req.method === 'POST' && url.pathname === '/request') {
      const p = new URLSearchParams(await body(req));
      const bsc = (p.get('bsc') || '').trim();
      const amount = Number(p.get('amount'));

      if (!isBsc(bsc))
        return send(400, home(`<p class="err">That is not a BSC address. It must look
          like <code>0x</code> followed by 40 hex characters.</p>`));
      if (!(amount > 0))
        return send(400, home(`<p class="err">Enter how much PCN you want to wrap.</p>`));

      const st = load();
      const key = bsc.toLowerCase();
      let r = st.requests[key];

      if (!r) {
        if (tooMany(ip))
          return send(429, home(`<p class="err">Too many new requests from your
            connection. Try again later.</p>`));
        if (st.nextIndex >= pool.length)
          return send(503, home(`<p class="err">The desk has run out of deposit
            addresses. This is our problem, not yours — please get in touch.</p>`));
        const slot = pool.find((x) => x.i === st.nextIndex);
        r = { bsc, index: slot.i, address: slot.a, amount,
              created: Date.now(), released: null };
        st.requests[key] = r;
        st.nextIndex = slot.i + 1;
        save(st);
      } else if (r.amount !== amount && amount > 0) {
        r.amount = amount; save(st);      // same person, new intent
      }

      const net = Math.min(amount, PER_PERSON) * (1 - FEE_PCT / 100);
      return send(200, page('Your deposit address', `
<h1>Send PCN to this address</h1>
<div class="card">
<p class="muted">Your deposit address — <b>yours alone</b>. Reusable: send again any time.</p>
<p><code style="font-size:1.05rem">${esc(r.address)}</code></p>
</div>
<div class="card">
<table>
<tr><th>You send</th><td>${esc(String(amount))} PCN</td></tr>
<tr><th>Fee (${FEE_PCT}%)</th><td>${(Math.min(amount,PER_PERSON)*FEE_PCT/100).toFixed(8)} wPCN</td></tr>
<tr><th>You receive</th><td><b>${net.toFixed(8)} wPCN</b></td></tr>
<tr><th>Sent to</th><td><code>${esc(r.bsc)}</code></td></tr>
<tr><th>After</th><td>${CONFIRMATIONS} confirmations (~18 hours)</td></tr>
</table>
</div>
<p class="warn"><b>Save this address.</b> It is how you check your status, and how we
know the PCN is yours. Sending from an exchange is fine; sending to the wrong address
is not recoverable.</p>
<div class="card">
<form method="GET" action="/status">
<input type="hidden" name="addr" value="${esc(r.address)}">
<button type="submit">Check my status</button>
</form>
</div>`));
    }

    // ── live status ─────────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/status') {
      const addr = (url.searchParams.get('addr') || '').trim();
      if (!/^pc1[0-9a-z]{20,}$/.test(addr))
        return send(400, home(`<p class="err">That is not a PCoin address.</p>`));

      const known = pool.some((x) => x.a === addr);
      if (!known)
        return send(404, home(`<p class="err">That address is not one of this desk's
          deposit addresses. Check it against what you were given.</p>`));

      const items = await deposits(addr);

      // UNREADABLE IS NOT ZERO. Never render a failed read as "no deposit".
      if (items === null)
        return send(200, page('Status unknown', `
<h1>Status unavailable</h1>
<p class="warn">We could not reach the explorer just now, so we <b>cannot tell</b>
whether your deposit has arrived. This does <b>not</b> mean it has not.</p>
<p class="muted">Nothing is lost. Reload in a minute, or check
<a href="https://explorer.pc.am/address/${esc(addr)}">the explorer</a> directly.</p>`));

      if (items.length === 0)
        return send(200, page('No deposit yet', `
<h1>Nothing received yet</h1>
<p class="muted">No PCN has arrived at <code>${esc(addr)}</code> yet. If you have just
sent it, it may take a few minutes to appear.</p>`));

      const rows = items.map((i) => {
        const done = !i.pending && i.confirmations >= CONFIRMATIONS;
        const state = i.pending ? 'in the mempool, not yet in a block'
          : done ? `<b>ready</b> — awaiting manual release`
          : `${i.confirmations} of ${CONFIRMATIONS} confirmations`;
        const net = Math.min(i.pcn, PER_PERSON) * (1 - FEE_PCT / 100);
        return `<tr><td>${i.pcn.toFixed(8)} PCN</td><td>${state}</td>
                <td>${net.toFixed(8)} wPCN</td></tr>`;
      }).join('');

      const anyReady = items.some((i) => !i.pending && i.confirmations >= CONFIRMATIONS);
      return send(200, page('Your wrap status', `
<h1>Your wrap</h1>
<div class="card">
<p class="muted">Deposits to <code>${esc(addr)}</code></p>
<table><tr><th>Received</th><th>Status</th><th>You get</th></tr>${rows}</table>
</div>
${anyReady
  ? `<p class="ok">Confirmed. Your wPCN is queued for release — a person sends it,
     so allow some hours.</p>`
  : `<p class="warn">Still confirming. ${CONFIRMATIONS} confirmations take about 18
     hours; the depth is what protects the desk against a chain reorganisation.</p>`}
<p class="muted">This page reads the chain live. Reload any time.</p>`));
    }

    return send(404, home(`<p class="err">Page not found.</p>`));
  } catch (e) {
    // Never leak internals to a public page.
    console.error('[wrapdesk]', e);
    return send(500, page('Error', `<h1>Something broke</h1>
      <p class="err">That is our fault, not yours. Nothing was lost — your deposit
      address stays valid. Please try again shortly.</p>`));
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`wrapdesk on 127.0.0.1:${PORT}, ${pool.length} addresses, ` +
              `fee ${FEE_PCT}%, cap ${PER_PERSON}/person`);
});
