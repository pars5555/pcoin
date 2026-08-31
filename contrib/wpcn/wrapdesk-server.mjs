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
  const d = await jget(`/api/address/${RESERVE}`);
  if (d === null) return null;
  const sat = d.balance?.confirmed?.onchain_unspent_sat;
  return sat == null ? null : sat / 1e8;
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
<p class="muted" style="margin-top:3.5rem;border-top:1px solid var(--line);padding-top:1rem">
<a href="https://pc.am">pc.am</a> · <a href="https://explorer.pc.am">explorer</a> ·
<a href="https://price.pc.am">price</a></p></div></body></html>`;

// ── the honest block, shown wherever someone might be about to commit ────────
const RISKS = `<h2>Before you send anything</h2><div class="card">
<p class="warn"><b>wPCN is not PCN.</b> It is a claim on PCN held in a public
reserve, on a different chain. You can check that reserve yourself on the
<a href="/proof">proof page</a>.</p>
<p class="warn"><b>This is manual.</b> A person releases your wPCN after checking.
It is not instant and it is not automated.</p>
<p class="err"><b>The market for wPCN is small.</b> A ~$20 trade moves the
PancakeSwap price about 10%, <b>we trade that pool ourselves</b> to keep it near
the rate posted at price.pc.am, and the <b>liquidity is not locked</b> — the
project holds the LP tokens. Only send what you can afford to lose.</p></div>`;

// ── pages ───────────────────────────────────────────────────────────────────
const home = (msg = '') => page('PCoin wrap desk — turn PCN into wPCN', '/', `
<h1>Turn PCN into wPCN</h1>
<p class="lead">wPCN is PCoin wrapped as a BEP-20 on BNB Smart Chain, so it can
trade on PancakeSwap. Backed 1:1 by the PCN you send.</p>
${msg}
<div class="card"><form method="POST" action="/request">
<label>Your BSC address — where the wPCN will be sent</label>
<input name="bsc" placeholder="0x…" autocomplete="off" spellcheck="false" required>
<label>How much PCN do you want to wrap? (max ${PER_PERSON})</label>
<input name="amount" type="number" step="0.00000001" min="0.00000001"
 max="${PER_PERSON}" placeholder="e.g. 100" required>
<button type="submit">Get my deposit address</button>
</form></div>

<h2>How it works</h2><div class="card"><ol class="steps">
<li>You give your BSC address and an amount.</li>
<li>You get a PCoin deposit address that is <b>yours alone</b>.</li>
<li>You send PCN to it — any amount up to ${PER_PERSON}, any number of times.</li>
<li>After <b>${CONFIRMATIONS} confirmations</b> (~18&nbsp;h) a person sends your wPCN.</li>
</ol><p class="muted" style="margin:.6rem 0 0">Track it at any point on the
<a href="/track">track page</a> using your deposit address.</p></div>

<h2>The terms</h2><div class="card"><table>
<tr><th>Limit</th><td>${PER_PERSON} PCN per person · ${TOTAL_ALLOC} wPCN total while the desk is new</td></tr>
<tr><th>Fee</th><td>${FEE_PCT}% — send 100 PCN, receive ${100 - FEE_PCT} wPCN</td></tr>
<tr><th>Wait</th><td>${CONFIRMATIONS} confirmations, about 18 hours</td></tr>
<tr><th>Backing</th><td>1:1, <a href="/proof">verifiable</a></td></tr>
</table><p class="muted" style="margin:.7rem 0 0">The limit and the fee exist to
slow a rush of wrapping-to-sell, not to make money — ${FEE_PCT}% of the entire
allocation is under $2.</p></div>
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

const redeem = () => page('Redeem wPCN back into PCN', '/redeem', `
<h1>Redeem wPCN back into PCN</h1>
<p class="lead">The door opens both ways. Redemption is handled by the token
contract itself, not by this website.</p>

<h2>How</h2><div class="card"><ol class="steps">
<li>Open the wPCN contract on
 <a href="https://bscscan.com/address/${TOKEN}#writeContract">BscScan</a> and
 connect the wallet holding your wPCN.</li>
<li>Call <code>redeem(value, pcoinAddress)</code> — the amount in satoshi-units
 (8 decimals), and the PCoin address you want the PCN sent to.</li>
<li>The contract <b>burns your wPCN immediately</b> and logs your address.</li>
<li>A person sends the PCN. Allow hours, not minutes.</li>
</ol></div>

<div class="card">
<p class="err"><b>Check the address twice.</b> The burn happens first and cannot
be undone. If the PCoin address is wrong or mistyped, your wPCN is gone and we
have nowhere valid to send the PCN — we will have to contact you to fix it.</p>
<p class="warn"><b>Redemption is manual, like wrapping.</b> The contract cannot
send PCN by itself: no contract on BNB Smart Chain can move a coin on the PCoin
chain. A person does it.</p></div>

<h2>Why it matters</h2><div class="card"><p class="muted">A wrapped token nobody
can redeem is an IOU resting on trust. A redeemable one is checkable — and it is
what lets arbitrage hold the PCN and wPCN prices together. Every redemption also
shows up in the <a href="/proof">backing figures</a>, because burning lowers the
supply the reserve has to cover.</p></div>`);

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
<div><div class="muted">PCN in the reserve</div>
 <div class="big" style="color:${known ? 'var(--green)' : 'var(--amber)'}">${
   known ? n2(bal) : 'UNKNOWN'}</div></div>
<div><div class="muted">wPCN issued</div><div class="big">${n2(ISSUED)}</div></div>
<div><div class="muted">Backing</div><div class="big">${
  ratio === null ? '—' : (ratio * 100).toFixed(1) + '%'}</div></div>
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

<h2>Check it yourself</h2><div class="card"><table>
<tr><th>Reserve address</th><td><a href="https://explorer.pc.am/address/${RESERVE}"><code>${RESERVE}</code></a></td></tr>
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

<h2>Why does it take 18 hours?</h2><div class="card"><p class="muted">${CONFIRMATIONS}
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
is friction rather than income — ${FEE_PCT}% of the entire allocation is under
$2. It exists to slow a rush of people wrapping purely to sell.</p></div>

<h2>Can I send more than once to the same address?</h2><div class="card">
<p class="muted">Yes. Your deposit address is permanent and reusable. Each deposit
is handled separately, and the per-person limit applies across all of them.</p></div>

<h2>I sent the wrong amount / to the wrong place</h2><div class="card">
<p class="muted">If you sent more than ${PER_PERSON} PCN, the excess is returned.
If you sent to an address that is not yours, tell us — the deposit addresses all
belong to one reserve wallet, so the PCN is not lost, but working out whose it is
takes a human.</p></div>

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
    if (req.method === 'GET' && p === '/')       return send(200, home());
    if (req.method === 'GET' && p === '/track')  return send(200, track());
    if (req.method === 'GET' && p === '/redeem') return send(200, redeem());
    if (req.method === 'GET' && p === '/faq')    return send(200, faq());
    if (req.method === 'GET' && p === '/proof')  return send(200, await proof());

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
<tr><th>Ready after</th><td>${CONFIRMATIONS} confirmations (~18 hours)</td></tr>
</table></div>
<p class="warn"><b>Save this address.</b> It is how you track your wrap, and how we
know the PCN is yours. Sending from an exchange is fine.</p>
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
        const state = i.pending ? 'In the mempool — not yet in a block'
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
