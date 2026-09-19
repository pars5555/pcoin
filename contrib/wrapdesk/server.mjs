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
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { dirname } from 'node:path';

const PORT       = Number(process.env.WRAPDESK_PORT || 8791);
const POOL_FILE  = process.env.WRAPDESK_POOL  || '/opt/wrapdesk/reserve-pool.txt';
const STATE_FILE = process.env.WRAPDESK_STATE || '/var/lib/wrapdesk/requests.json';

// THE OFF SWITCH. The file existing means intake is closed; its contents are a
// note for whoever reads it later.
//
// Read PER REQUEST, deliberately. Every other setting on this desk comes from
// the unit file, so changing one means an edit and a restart -- and restarting
// this service to flip a switch the owner wants to control from a web page is a
// needless risk taken on somebody else's behalf. A file costs one stat per
// request, takes effect on the next click, and survives a reboot.
//
// Closing stops NEW requests and nothing else. Wraps already in flight keep
// counting confirmations and are still paid. Closing the door and repudiating a
// debt are different acts, and only the first one was announced.
// A LIST, and the desk is closed if ANY of them exists.
//
// The first is the one the admin panel owns. It lives under /etc/pcoin/control
// because the panel runs ProtectSystem=strict and /etc/pcoin is read-only to
// it -- which is why the panel's close button could never work until
// 2026-09-19, and failed with "could not change it" every time it was pressed.
// The control directory is granted to the panel precisely because it holds no
// secrets; /etc/pcoin holds this desk's SSO secret and the keeper's private key
// and must never be panel-writable.
//
// The second is where this flag lived until then. It is still honoured, and
// that is deliberate: an operator who creates it from memory or from an older
// runbook must still close the desk. A safety flag that silently stopped
// working because it moved is the worst possible outcome here.
const CLOSED_FILES = (process.env.WRAP_CLOSED_FILES
  || '/etc/pcoin/control/wrapdesk-closed,/etc/pcoin/wrapdesk-closed')
  .split(',').map((x) => x.trim()).filter(Boolean);

// Every flag file that exists, with whatever note is in it.
function closedBy() {
  const out = [];
  for (const path of CLOSED_FILES) {
    // existsSync decides; the read only fetches the note. These were one call
    // before, inside a try/catch that returned null -- so a flag file that
    // existed but could NOT be read (a permission change, a full disk) opened
    // the desk. An unreadable safety flag is UNKNOWN, and unknown must fail
    // closed, not open. This is CLAUDE.md 7.1 on the one switch that decides
    // whether money can arrive.
    if (!existsSync(path)) continue;
    let note = '';
    try { note = readFileSync(path, 'utf8'); }
    catch (e) { note = `(this flag exists but could not be read: ${e.message})`; }
    out.push({ path, note });
  }
  return out;
}
function intakeClosed() {
  const hits = closedBy();
  return hits.length ? hits.map((h) => h.note).join(String.fromCharCode(10)) : null;   // null = open
}
// Shown in place of the request form while the desk is closed.
const CLOSED_FORM_NOTE = `<div class="card"><p class="muted" style="margin:0">
The request form is hidden while the desk is closed, so there is nothing to fill
in. <b>Nothing you have already sent is affected</b> &mdash; follow anything still
confirming on the <a href="/track">track page</a>.</p></div>`;

// pcoin-wrapdesk-watch's ledger. READ-ONLY here, and its absence is tolerated:
// this desk must keep taking requests if the watcher has not run yet.
const WATCH_STATE = process.env.WRAPDESK_WATCH_STATE || '/var/lib/pcoin-wrapdesk/state.json';
// ── accounts: a market.pc.am sign-in raises the per-person limit ────────────
//
// A BSC address is free and infinite, so a limit keyed on one is a limit in
// name only: anyone wanting more just types a different address. An account
// costs an email, a password and an hCaptcha, so it is the first quota key here
// with any cost at all. It is still NOT identity -- accounts are cheap too --
// and it raises the bar rather than closing the door. The TOTAL allocation
// remains the real ceiling.
//
// The secret is shared with market.pc.am, which mints the token. An absent
// secret disables sign-in rather than falling back to something weaker.
const SSO_SECRET = process.env.WRAP_SSO_SECRET || '';
const SSO_ON = Boolean(SSO_SECRET);
const SSO_START = process.env.WRAP_SSO_START || 'https://market.pc.am/sso/wrapdesk';
// Per ACCOUNT, per rolling 30 days, in PCN.
const ACCOUNT_MONTHLY_PCN = Number(process.env.WRAP_ACCOUNT_MONTHLY_PCN || 1000);

// This desk's own cookie is signed with a key DERIVED from the shared secret,
// never the shared secret itself: one secret to provision, but a stolen desk
// cookie is not a market token and cannot be replayed as one.
const COOKIE_KEY = SSO_ON
  ? createHmac('sha256', SSO_SECRET).update('wrapdesk-cookie-v1').digest('hex')
  : '';

// Both tokens are `${email}|${expiry}` signed with HMAC-SHA256, and both are
// split from the RIGHT. market.pc.am records why: an address containing the
// delimiter, split from the left, mints a token that is genuinely signed and
// reads back as somebody else's account.
function verifySigned(tok, key) {
  if (!tok || !key) return null;
  const i = tok.lastIndexOf('.');
  if (i < 0) return null;
  const payload = tok.slice(0, i);
  const want = createHmac('sha256', key).update(payload).digest('hex');
  const got = tok.slice(i + 1);
  if (got.length !== want.length) return null;
  if (!timingSafeEqual(Buffer.from(got), Buffer.from(want))) return null;
  const cut = payload.lastIndexOf('|');
  if (cut < 0) return null;
  const email = payload.slice(0, cut);
  const exp = Number(payload.slice(cut + 1));
  if (!Number.isFinite(exp) || Date.now() > exp) return null;
  return email || null;
}

function signSession(email) {
  const payload = `${email}|${Date.now() + 7 * 864e5}`;
  return `${payload}.${createHmac('sha256', COOKIE_KEY).update(payload).digest('hex')}`;
}

// ── who may be shown an EXISTING deposit address ────────────────────
//
// POST /request used to answer with the stored deposit address for whatever BSC
// address it was given. BSC addresses are public — they are visible in every
// PancakeSwap trade — so anyone could feed one in and learn the PCoin deposit
// address behind it. That is an unauthenticated linkage oracle, and it defeats
// the one privacy property the per-user address pool exists to provide:
// wrapdesk.pc.am deliberately publishes NO BSC address anywhere, because that
// mapping is a link only the desk should hold. Answering with it gave it away.
//
// The fix has to keep the honest case working — the same person coming back for
// the address they were given. So the creator leaves with a signed cookie naming
// the record, and only that cookie, or a signed-in account that owns the record,
// unlocks it again. A stranger submitting the same BSC address is told a request
// exists and nothing more.
//
// One cookie PER record, named by an HMAC of the key, so a browser that made two
// requests does not lose the first. The value is an opaque token: it names no
// address.
//
// Domain-separated with a "claim:" prefix, so a claim token and a session cookie
// — both signed with COOKIE_KEY, both the same shape — can never be presented
// for one another.
// A key of its OWN, not COOKIE_KEY.
//
// COOKIE_KEY is the empty string whenever SSO is off, and an HMAC under an empty
// key, in a repository anyone can read, is a signature anyone can forge -- which
// would leave the oracle wide open while looking closed. This must not depend on
// a setting that has nothing to do with it.
//
// Persisted beside the state file so claims survive a restart. If it cannot be
// written the desk still runs on a fresh random key: claims then stop working
// across restarts, which costs a returning owner a message to us and never
// hands anybody a forgeable token. Fail closed, loudly enough to find later.
const CLAIM_KEY = (() => {
  const f = dirname(STATE_FILE) + '/claim-key';
  try {
    const k = readFileSync(f, 'utf8').trim();
    if (k.length >= 32) return k;
  } catch { /* first run, or unreadable -- fall through and mint one */ }
  const k = randomBytes(32).toString('hex');
  try {
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, k + String.fromCharCode(10), { mode: 0o600 });
  } catch (e) {
    console.error('wrapdesk: could not persist the claim key (%s). Deposit-address '
      + 'claims will not survive a restart.', e && e.message);
  }
  return k;
})();

function claimCookieName(key) {
  return 'wdc_' + createHmac('sha256', CLAIM_KEY).update('name:' + key)
    .digest('hex').slice(0, 12);
}

function signClaim(key) {
  const payload = `claim:${key}|${Date.now() + 180 * 864e5}`;
  return `${payload}.${createHmac('sha256', CLAIM_KEY).update(payload).digest('hex')}`;
}

function claimCookieFor(key) {
  return `${claimCookieName(key)}=${encodeURIComponent(signClaim(key))}; Path=/; ` +
         `Max-Age=${180 * 86400}; HttpOnly; Secure; SameSite=Lax`;
}

function holdsClaim(req, key) {
  const want = claimCookieName(key) + '=';
  const c = (req.headers.cookie || '').split(/;\s*/).find((x) => x.startsWith(want));
  if (!c) return false;
  return verifySigned(decodeURIComponent(c.slice(want.length)), CLAIM_KEY)
         === `claim:${key}`;
}

function accountOf(req) {
  if (!SSO_ON) return null;
  const c = (req.headers.cookie || '').split(/;\s*/).find((x) => x.startsWith('wd='));
  return c ? verifySigned(decodeURIComponent(c.slice(3)), COOKIE_KEY) : null;
}

// What this account has consumed in the last 30 days, in wPCN.
//
// Deposits are the obligation, so a DEPOSITED figure is used wherever the
// watcher has published one for that address; a request with no deposit yet
// falls back to what was asked for, so a fresh request still counts. Same
// reasoning as the total ceiling below.
function accountUsedWpcn(st, email) {
  if (!email) return 0;
  let perAddr = {};
  try {
    const a = JSON.parse(readFileSync(WATCH_STATE, 'utf8')).allocation;
    perAddr = (a && a.per_address) || {};
  } catch { perAddr = {}; }
  const since = Date.now() - 30 * 864e5;
  let used = 0;
  for (const r of Object.values(st.requests || {})) {
    if (r.account !== email) continue;
    if (!(Number(r.created) >= since)) continue;
    const dep = Number(perAddr[r.address] || 0);
    used += dep > 0 ? dep : Math.min(Number(r.amount) || 0, PER_PERSON) * (1 - FEE_PCT / 100);
  }
  return used;
}
const EXPLORER   = process.env.WRAPDESK_EXPLORER || 'https://explorer.pc.am';

const FEE_PCT       = Number(process.env.WRAP_FEE_PCT || 5);
const PER_PERSON    = Number(process.env.WRAP_PER_PERSON || 250);
const TOTAL_ALLOC   = Number(process.env.WRAP_TOTAL_ALLOC || 1500);
const CONFIRMATIONS = Number(process.env.WRAP_CONFIRMATIONS || 100);

// ── hCaptcha ────────────────────────────────────────────────────────────────
// The desk takes no login: it asks for a BSC address and hands back a deposit
// address. The PER_PERSON limit is keyed on the address typed into the form,
// and BSC addresses are free and infinite, so that limit is farmable by anyone
// with a loop. TOTAL_ALLOC is the real ceiling; this raises the cost of
// approaching it from "nothing" to "a human per address".
//
// Both unset  -> the check is skipped and startup says so LOUDLY. A desk that
//                silently stopped checking would look identical to one that is.
// Configured  -> a missing or rejected token REFUSES, and so does an hCaptcha
//                API we could not reach. Failing open would make the whole
//                control decorative the moment their API had a bad minute, and
//                "we could not check" is not "you passed" (§7.1).
const HCAPTCHA_SITEKEY = process.env.HCAPTCHA_SITEKEY || '';
const HCAPTCHA_SECRET  = process.env.HCAPTCHA_SECRET  || '';
const HCAPTCHA_ON = Boolean(HCAPTCHA_SITEKEY && HCAPTCHA_SECRET);

async function hcaptchaVerdict(token, ip) {
  if (!token) return { ok: false, why: 'missing' };
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 10_000);
  try {
    const body = new URLSearchParams({ secret: HCAPTCHA_SECRET, response: token });
    if (ip) body.set('remoteip', ip);
    const r = await fetch('https://api.hcaptcha.com/siteverify',
      { method: 'POST', body, signal: c.signal });
    if (!r.ok) return { ok: false, why: 'unreachable' };
    const j = await r.json();
    return j.success ? { ok: true } : { ok: false, why: 'rejected' };
  } catch {
    return { ok: false, why: 'unreachable' };   // never 'rejected' -- we did not ask
  } finally { clearTimeout(t); }
}

const RESERVE = process.env.WRAP_RESERVE || 'pc1q7hhzmdkkx0zjtzj6qkwmuvhlgwfqjrc6j2dk52';
const TOKEN   = process.env.WPCN_TOKEN   || '0x290A5779a419Cb9cB22fa087CDD1CD16dA2D95F1';
const ISSUED  = Number(process.env.WPCN_ISSUED || 50000);

// ── RETURN redemptions: wPCN comes back to inventory instead of being burned ──
//
// The contract has NO mint. Every redeem() burns supply for ever, so the
// 50,000 only ever shrinks, and once the desk's inventory is gone nothing can
// wrap PCN into wPCN again -- at which point wPCN can trade ABOVE PCN with no
// arbitrage able to pull it back (wPCN cannot follow PCN down without wPCN to
// sell). Recycling keeps the 50,000 usable: a customer transfers wPCN to the
// INVENTORY address, tells the desk which PCoin address to pay, and a person
// sends the PCN exactly as for a burn. totalSupply is unchanged and the
// reserve is unchanged; the payout comes from a non-reserve wallet, as burn
// redemptions already do. Backing on /proof therefore needs no new arithmetic.
//
// The claim is bound to the SENDER, not to whoever posts first: the customer
// signs an EIP-191 message naming the tx hash and the PCoin address with the
// same wallet that sent the wPCN. A stranger watching the inventory address can
// see the transfer, but cannot produce that signature. The desk checks the
// receipt and the signature here; pcoin-redeem-watch checks BOTH again before
// listing anything as payable -- the desk's word is never what pays.
const isBscLower = (s) => typeof s === 'string' && /^0x[0-9a-f]{40}$/.test(s);
const isTxHash = (s) => typeof s === 'string' && /^0x[0-9a-fA-F]{64}$/.test(s);
const INVENTORY = (process.env.WPCN_INVENTORY || '0x37cefF465A3a2f72979062aD781DDa7293477b8a').toLowerCase();
const RETURNS_FILE = process.env.WRAPDESK_RETURNS || '/var/lib/wrapdesk/returns.json';
// eth_getTransactionReceipt for ONE hash is served by every public RPC (the
// range-scanning calls are what they refuse). Tried in order.
const BSC_RPCS = (process.env.WPCN_RPC ||
  'https://bsc-dataseed.bnbchain.org,https://bsc-dataseed.binance.org,https://bsc-dataseed1.defibit.io')
  .split(',').map((s) => s.trim()).filter(Boolean);
// Signature recovery is delegated to the same Python that runs the watcher
// (eth_account). Node has no secp256k1 recovery built in, and a hand-rolled one
// in a money path is a worse risk than a subprocess. Empty = the desk records
// the claim UNVERIFIED and says so; the watcher still verifies before paying.
const RECOVER_CMD = process.env.WRAP_RECOVER_CMD === undefined
  ? '/opt/wpcn/.venv/bin/python /opt/wrapdesk/recover.py'
  : process.env.WRAP_RECOVER_CMD;
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// The EXACT text the customer signs. pcoin-redeem-watch rebuilds it from the
// stored fields and recovers the signer; a single changed character there or
// here and every claim fails verification, which is the safe direction.
const returnMessage = (txhash, pcoin) =>
  `PCoin wrap desk: return wPCN for PCN\n` +
  `BSC transaction: ${txhash}\n` +
  `Send the PCN to: ${pcoin}\n` +
  `I sent the wPCN in that transaction to ${INVENTORY} from the wallet signing this.`;

async function bscRpc(method, params) {
  for (const url of BSC_RPCS) {
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 15000);
      const r = await fetch(url, { method: 'POST', signal: c.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      clearTimeout(t);
      if (!r.ok) continue;
      const j = await r.json();
      if (j && j.error) continue;
      if (j && 'result' in j) return { ok: true, result: j.result };
    } catch { /* next */ }
  }
  return { ok: false, result: null };          // UNKNOWN, never "no such tx"
}
const addrFromTopic = (t) => '0x' + String(t || '').slice(-40).toLowerCase();

function loadReturns() {
  let st;
  try { st = JSON.parse(readFileSync(RETURNS_FILE, 'utf8')); } catch { st = {}; }
  if (!st || typeof st !== 'object' || Array.isArray(st)) st = {};
  if (!st.claims || typeof st.claims !== 'object') st.claims = {};
  return st;
}
function saveReturns(s) {
  mkdirSync(dirname(RETURNS_FILE), { recursive: true });
  const tmp = `${RETURNS_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 1));
  renameSync(tmp, RETURNS_FILE);
}

// 'ok' | 'bad' | 'unknown'. unknown is recorded as unverified, never as ok.
async function recoverSigner(message, signature) {
  if (!RECOVER_CMD) return { verdict: 'unknown', signer: null, why: 'no recover command configured' };
  const [cmd, ...args] = RECOVER_CMD.split(/\s+/);
  return new Promise((resolve) => {
    let out = '', err = '';
    const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { p.kill(); resolve({ verdict: 'unknown', signer: null, why: 'recover timed out' }); }, 20000);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(timer); resolve({ verdict: 'unknown', signer: null, why: `recover failed: ${e.message}` }); });
    p.on('close', (code) => {
      clearTimeout(timer);
      const s = out.trim().toLowerCase();
      if (code === 0 && /^0x[0-9a-f]{40}$/.test(s)) return resolve({ verdict: 'ok', signer: s, why: '' });
      if (code === 3) return resolve({ verdict: 'bad', signer: null, why: 'signature does not parse' });
      resolve({ verdict: 'unknown', signer: null, why: `recover exit ${code}: ${err.trim().slice(0, 200)}` });
    });
    p.stdin.end(JSON.stringify({ message, signature }));
  });
}

// wPCN held by the desk's own inventory + the keeper, i.e. NOT in circulation.
// null = UNKNOWN. Shown on /proof so "how much wPCN is actually out there" is a
// published number rather than a guess.
async function inventoryHeld() {
  const held = async (a) => {
    const r = await bscRpc('eth_call', [{ to: TOKEN, data: '0x70a08231' + a.slice(2).padStart(64, '0') }, 'latest']);
    if (!r.ok || typeof r.result !== 'string' || !/^0x[0-9a-fA-F]*$/.test(r.result)) return null;
    return Number(BigInt(r.result === '0x' ? '0x0' : r.result)) / 1e8;
  };
  const inv = await held(INVENTORY);
  if (inv === null) return null;
  const extra = await Promise.all(HELD_ALSO.map(held));
  return extra.reduce((s, v) => s + (v ?? 0), inv);
}
const HELD_ALSO = (process.env.WPCN_HELD_ALSO || '0x477C9793C0d69283d703010500C86f7335B27521')
  .split(',').map((s) => s.trim().toLowerCase()).filter(isBscLower);
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
  // NORMALISE, do not merely survive an unreadable file.
  //
  // This used to return whatever JSON.parse gave back. A state file that PARSES
  // but has no `requests` key -- a fresh `{}`, or one hand-edited during an
  // incident -- then made `st.requests[key]` throw on every single request, so
  // the desk answered 500 to everybody while the file looked perfectly fine.
  //
  // This is the same defect, in the same shape, that pcoin-wrapdesk-watch was
  // fixed for on 2026-09-08: a fresh `{}` died with KeyError on the first wrap
  // and a first install crashed. It was fixed there and left here.
  let st;
  try { st = JSON.parse(readFileSync(STATE_FILE, 'utf8')); }
  catch { st = {}; }
  if (!st || typeof st !== 'object' || Array.isArray(st)) st = {};
  if (!st.requests || typeof st.requests !== 'object') st.requests = {};
  if (!Number.isInteger(st.nextIndex)) st.nextIndex = FIRST_INDEX;
  return st;
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
// /return has its own, wider bucket. The page retries a claim every 5 s while
// the chain catches up, so the 10/h allocation limit would lock a customer out
// mid-claim. 120/h still bounds the signature-recovery subprocesses one IP can
// spawn, and a recorded claim is idempotent so repeats cost nothing.
const rhits = new Map();
function tooManyReturns(ip) {
  const now = Date.now(), w = 3600_000, cap = 120;
  const a = (rhits.get(ip) || []).filter((t) => now - t < w);
  a.push(now); rhits.set(ip, a);
  if (rhits.size > 5000) rhits.clear();
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
button.ghost{background:#21262d;border:1px solid var(--line);color:var(--fg);font-weight:500;margin-top:0}
button.ghost:hover{background:#30363d}
button.ghost[disabled]{opacity:.55;cursor:default}
/* A LINK that looks like a button. The open direction on a page whose headline
   says "closed" needs to be the most clickable thing on it, or a visitor who
   came to redeem reads the red banner and leaves. */
.golink{display:inline-block;background:#238636;color:#fff;text-decoration:none;
 padding:.7rem 1.4rem;border-radius:8px;font-weight:700;font-size:1rem;margin-top:.2rem}
.golink:hover{background:#2ea043}
.dir{display:flex;gap:.9rem;align-items:flex-start;padding:.85rem 0;border-bottom:1px solid #21262d}
.dir:last-child{border-bottom:none}
.dir .tag{flex:0 0 5.4rem;font-size:.72rem;font-weight:700;letter-spacing:.06em;
 text-transform:uppercase;padding:.28rem 0;text-align:center;border-radius:999px}
.tag.open{background:rgba(63,185,80,.16);color:var(--green)}
.tag.shut{background:rgba(248,81,73,.16);color:var(--red)}
@media (max-width:420px){.dir{flex-direction:column;gap:.35rem}.dir .tag{flex:none;width:5.4rem;text-align:left;padding-left:.6rem}}
.good{color:var(--green)}
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

// ── one-click "add wPCN to my wallet" (EIP-747) ──────────────────────────────
// wPCN is on no token list, so every wallet treats it as unknown and every user
// has to paste a 42-character contract address by hand. That is the step people
// abandon, and it is also the step a phisher imitates -- an address arriving in
// a chat message looks exactly like an attack. wallet_watchAsset lets the page
// hand the wallet the address, the symbol, the decimals and the logo directly.
//
// Progressive enhancement on purpose: the button starts `hidden` and only JS
// with an injected provider reveals it, and the hand-typed details stay on the
// page underneath. Most mobile browsers have no provider at all, and a button
// that does nothing is worse than no button.
const ADD_TOKEN = `<p id="addtok" hidden style="margin:.75rem 0 0">
<button type="button" id="addtokbtn" class="ghost">Add wPCN to my wallet</button>
<span id="addtokmsg" class="muted"></span></p>
<script>
(function () {
  var eth = window.ethereum;
  if (!eth) return;                     // no injected wallet — leave it hidden
  var p = document.getElementById('addtok');
  var b = document.getElementById('addtokbtn');
  var m = document.getElementById('addtokmsg');
  if (!p || !b || !m) return;
  p.hidden = false;
  function say(t, cls) { m.textContent = t ? '  ' + t : ''; m.className = cls || 'muted'; }
  b.onclick = function () {
    say('asking the wallet…'); b.disabled = true;
    // Get the chain right BEFORE watchAsset. Otherwise the wallet cheerfully
    // adds a BNB Smart Chain contract to whatever network happens to be
    // selected, and the user gets an entry that will never show a balance.
    Promise.resolve(eth.request({ method: 'eth_chainId' })).then(function (id) {
      if (String(id).toLowerCase() === '0x38') return;
      return eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x38' }] });
    }).then(function () {
      return eth.request({ method: 'wallet_watchAsset', params: {
        type: 'ERC20',
        options: { address: '${TOKEN}', symbol: 'wPCN', decimals: 8,
                   image: 'https://pc.am/brand/wpcn-round-256.png' } } });
    }).then(function (ok) {
      // EIP-747 returns false for "the user said no" — that is an answer, not
      // an error, and it must not be reported as a failure of ours.
      if (ok === false) say('you declined it in the wallet. Nothing changed.', 'muted');
      else say('added — look for wPCN in your token list.', 'good');
      b.disabled = false;
    }).catch(function (e) {
      say(e && e.code === 4001
            ? 'you dismissed it in the wallet. Nothing changed.'
            : 'the wallet would not add it — use the details above by hand.', 'muted');
      b.disabled = false;
    });
  };
})();
</script>`;

const page = (title, active, body) => `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='7' fill='%230d1117'/><path d='M16 5 L18.4 13.6 L27 16 L18.4 18.4 L16 27 L13.6 18.4 L5 16 L13.6 13.6 Z' fill='%232dd4bf'/></svg>">
<title>${esc(title)}</title><style>${CSS}</style>${HCAPTCHA_ON ? '<script src="https://js.hcaptcha.com/1/api.js" async defer></script>' : ''}</head><body>
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
sharply; <b>we trade that pool ourselves</b> (a bot buys wPCN when the pool falls
well below the rate posted at price.pc.am, within a small daily budget), and the
<b>liquidity is not locked</b> — the project holds the LP tokens. Only send what
you can afford to lose.</p>
<p class="warn"><b>wPCN can trade above PCN, and nothing can pull it back.</b> The
supply is fixed at 50,000 and cannot be minted. Arbitrage can always push wPCN
<i>up</i> to PCN (buy wPCN, redeem, sell PCN), but it can only push wPCN <i>down</i>
to PCN by wrapping more PCN — and once the desk's inventory of wPCN is gone,
nobody can. Redeeming by <a href="/redeem">return</a> instead of burn keeps that
inventory in existence; it does not remove the limit.</p></div>`;

// ── pages ───────────────────────────────────────────────────────────────────
const home = (msg = '', acct = null, leftPcn = null) => page('PCoin wrap desk — wPCN and PCN, both directions', '/', `
${intakeClosed() !== null ? `<div class="card">
<h1 style="margin-top:0">One direction is open</h1>
<p class="lead">Only one way round the desk is working at the moment. Which one
you need decides everything on this page, so it is the first thing here.</p>

<div class="dir">
 <span class="tag open">open</span>
 <div><b>wPCN &rarr; PCN.</b> Hand your wPCN back and the PCN is sent to you,
 1 for 1, no fee on this side. A person pays it, so allow hours rather than
 minutes.<br><a class="golink" href="/redeem">Redeem wPCN &rarr; PCN</a></div>
</div>

<div class="dir">
 <span class="tag shut">closed</span>
 <div><b>PCN &rarr; wPCN.</b> New wrap requests are not being accepted. This is
 temporary, and there is no reopening date.</div>
</div>
</div>

<div class="card" style="border-left:4px solid #e5484d">
<p><b>Nothing you are already owed is affected.</b> Every wrap that reached 100
confirmations has been paid, and anything still confirming will be paid the same
way.</p>
<p><b>Do not send any more PCN to your deposit address.</b> Those addresses
are no longer wrapped. PCN that arrives at one now is <b>returned, not
converted</b> &mdash; by a person, which takes time. This applies even though the
address still belongs to you and still works on the chain.</p>

<p>You can still buy and sell wPCN on PancakeSwap (wPCN/USDT), and buy PCN
directly at <a href="https://market.pc.am">market.pc.am</a>.</p>
</div>` : ''}
${intakeClosed() !== null ? '' : `<h1>Turn PCN into wPCN</h1>
<p class="lead">wPCN is PCoin wrapped as a BEP-20 on BNB Smart Chain, so it can
trade on PancakeSwap. Backed 1:1 by the PCN you send.</p>`}
${msg}
${intakeClosed() !== null ? CLOSED_FORM_NOTE : `<div class="card"><form method="POST" action="/request">
<label>Your BSC address — where the wPCN will be sent. Use a wallet <b>you</b>
control (MetaMask, or any wallet that lets you add a custom BEP-20 token).
<b>Never an exchange deposit address</b> — no exchange lists wPCN, so it could
not credit you.</label>
<input name="bsc" placeholder="0x…" pattern="0x[0-9a-fA-F]{40}"
 title="0x followed by 40 hex characters" autocomplete="off" spellcheck="false" required>
<label>How much PCN do you want to wrap? (max ${PER_PERSON})</label>
<input name="amount" type="number" step="0.00000001" min="0.00000001"
 max="${PER_PERSON}" placeholder="e.g. 100" required>
${HCAPTCHA_ON ? `<div class="h-captcha" data-sitekey="${HCAPTCHA_SITEKEY}" data-theme="dark" style="margin:.9rem 0"></div>` : ''}
<button type="submit">Get my deposit address</button>
</form></div>`}

<h2>How it works</h2><div class="card"><ol class="steps">
<li>You give your BSC address and an amount.</li>
<li>You get a PCoin deposit address that is <b>yours alone</b>.</li>
<li>You send PCN to it — any amount up to ${PER_PERSON}, any number of times.${intakeClosed() !== null ? ' <b>Not while the desk is closed: an address that receives PCN now has it returned, not wrapped.</b>' : ''}</li>
<li>After <b>${CONFIRMATIONS} confirmations</b> (~${WAIT_H}&nbsp;h) a person sends your wPCN.</li>
</ol><p class="muted" style="margin:.6rem 0 0">Track it at any point on the
<a href="/track">track page</a> using your deposit address.</p>
<p class="muted" style="margin:.6rem 0 0">To see the wPCN in your wallet, add it
as a custom token: contract <code>${TOKEN}</code>, symbol wPCN, 8 decimals. It
trades on <a href="https://pancakeswap.finance/swap?chain=bsc&amp;outputCurrency=${TOKEN}"
rel="noopener">PancakeSwap</a>. Want PCN back later? The
<a href="/redeem">redeem page</a> is the same door in the other direction.</p>${ADD_TOKEN}</div>

<h2>The terms</h2><div class="card"><table>
<tr><th>Limit</th><td>${PER_PERSON} PCN per person · ${TOTAL_ALLOC} wPCN total while the desk is new</td></tr>
<tr><th>More</th><td>${acct ? `Signed in as <b>${esc(acct)}</b> &mdash; <b>${n2(leftPcn)} PCN</b> of your ${ACCOUNT_MONTHLY_PCN} PCN monthly allowance left. <a href="/signout">Sign out</a>` : `Sign in with a <a href="${SSO_START}?return=https%3A%2F%2Fwrapdesk.pc.am%2Fsso">market.pc.am account</a> and your limit becomes ${ACCOUNT_MONTHLY_PCN} PCN a month.`}</td></tr>
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

  // Shared with the return flow (RETURN_JS), which must not duplicate the
  // bech32/base58 checker -- two copies is how one of them goes stale.
  window.__wd = { checkAddress: checkAddress, parseAmount: parseAmount, fmt: fmt,
                  errText: errText, ensureBsc: ensureBsc, hex32: hex32,
                  getEth: function () { return eth || provider(); },
                  setEth: function (e) { eth = e; } };
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

const RETURN_JS = String.raw`
(function () {
  'use strict';
  var SEL_TRANSFER = '0xa9059cbb';          // keccak('transfer(address,uint256)')[:4]
  var SEL_BALANCE = '0x70a08231';
  var $ = function (id) { return document.getElementById(id); };
  var W = window.__wd, eth = null, account = null, balance = null, checked = null;
  function say(id, cls, text) { var el = $(id); el.className = cls; el.textContent = text; el.hidden = !text; }
  function readBalance() {
    var data = SEL_BALANCE + account.slice(2).toLowerCase().padStart(64, '0');
    return eth.request({ method: 'eth_call', params: [{ to: TOKEN, data: data }, 'latest'] }).then(function (r) {
      balance = BigInt(r === '0x' ? 0 : r);
      $('rbal').textContent = W.fmt(balance) + ' wPCN';
      $('racct').textContent = account.slice(0, 6) + '…' + account.slice(-4);
      $('rconnected').hidden = false;
    });
  }
  function connect() {
    eth = W.getEth();
    if (!eth) { $('rnowallet').hidden = false; return; }
    W.setEth(eth);
    say('rmsg', 'muted', 'Waiting for the wallet…');
    eth.request({ method: 'eth_requestAccounts' }).then(function (acc) {
      account = acc && acc[0]; if (!account) throw new Error('No account was shared by the wallet.');
      return W.ensureBsc();
    }).then(readBalance).then(function () {
      say('rmsg', '', ''); $('rform').hidden = false; $('rconnectBtn').hidden = true;
    }).catch(function (e) { say('rmsg', 'err', 'Could not connect: ' + W.errText(e)); });
  }
  function review() {
    var v = W.parseAmount($('ramount').value), a = $('raddr').value.trim();
    checked = null; $('rconfirm').hidden = true;
    if (v === null) return say('rmsg', 'err', 'Enter an amount in wPCN, up to 8 decimals, greater than zero.');
    if (balance !== null && v > balance) return say('rmsg', 'err', 'That is more than this account holds (' + W.fmt(balance) + ' wPCN).');
    say('rmsg', 'muted', 'Checking the address…');
    W.checkAddress(a).then(function (r) {
      if (!r.ok) return say('rmsg', 'err', 'PCoin address rejected: ' + r.why + '. Nothing was sent.');
      if (/^pc1/i.test(a)) a = a.toLowerCase();
      checked = { value: v, addr: a };
      $('rc_amount').textContent = W.fmt(v) + ' wPCN';
      $('rc_addr').textContent = a; $('rc_kind').textContent = r.kind; $('rc_acct').textContent = account;
      say('rmsg', '', ''); $('rconfirm').hidden = false;
    });
  }
  // Sign, then POST. Used by both the send flow and the "already sent" form.
  // The signature covers the hash and the address only, so one signature stays
  // valid across every retry while the chain catches up.
  function post(payload) {
    return fetch('/return', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload) }).then(function (r) { return r.json(); });
  }
  function claim(hash, addr, from, msgId, doneCb) {
    hash = hash.toLowerCase();
    var text = RETURN_MSG.replace('%TX%', hash).replace('%ADDR%', addr);
    say(msgId, 'muted', 'Now sign the message in your wallet. It costs nothing and sends nothing — it only proves the wPCN came from you.');
    return eth.request({ method: 'personal_sign', params: [text, from] }).then(function (sig) {
      var payload = { txhash: hash, pcoin: addr, from: from, signature: sig }, tries = 0;
      say(msgId, 'muted', 'Recording your claim…');
      return (function attempt() {
        return post(payload).then(function (j) {
          if (j.ok) { say(msgId, 'ok', j.message); if (doneCb) doneCb(j); return j; }
          if ((j.state === 'pending' || j.state === 'unreachable') && ++tries < 40) {
            say(msgId, 'muted', j.state === 'pending'
              ? 'Waiting for BNB Smart Chain to mine it… (this can take a minute)'
              : 'The desk could not reach BNB Smart Chain; retrying…');
            return new Promise(function (res) { setTimeout(res, 5000); }).then(attempt);
          }
          say(msgId, 'err', (j.message || 'The desk could not record the claim.') +
            ' Your wPCN is safe at the desk address; use "Already sent? Claim it here" with the hash ' + hash + ' to try again.');
          return j;
        });
      })();
    });
  }
  function send() {
    if (!checked) return;
    var c = checked; checked = null; $('rconfirm').hidden = true;
    $('rsendBtn').disabled = true;
    say('rmsg', 'muted', 'Confirm the transfer in your wallet…');
    var data = SEL_TRANSFER + INVENTORY.slice(2).padStart(64, '0') + W.hex32(c.value);
    W.ensureBsc().then(function () {
      return eth.request({ method: 'eth_sendTransaction', params: [{ from: account, to: TOKEN, data: data }] });
    }).then(function (hash) {
      $('rsendBtn').disabled = false; $('rform').hidden = true;
      $('rtxlink').href = 'https://bscscan.com/tx/' + hash; $('rtxlink').textContent = hash;
      $('rdone').hidden = false;
      $('rdonemsg').textContent = 'Sent. Do not close this page yet — one more step: the signature that ties it to your PCoin address.';
      try {
        var k = 'wpcn-redeems', l = JSON.parse(localStorage.getItem(k) || '[]');
        l.unshift({ hash: hash, amount: W.fmt(c.value), to: c.addr, at: new Date().toISOString(), kind: 'return' });
        localStorage.setItem(k, JSON.stringify(l.slice(0, 20)));
      } catch (e) {}
      return claim(hash, c.addr, account, 'rstatus', function () {
        $('rdonemsg').textContent = 'Recorded. Keep the hash — it is your receipt. A person pays ' + c.addr + '; nothing else needs to be done on your side.';
      });
    }).catch(function (e) {
      $('rsendBtn').disabled = false; $('rform').hidden = false;
      say('rmsg', 'err', 'Not sent: ' + W.errText(e));
    });
  }
  function claimExisting() {
    var h = $('ctx').value.trim(), a = $('caddr').value.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(h)) return say('cmsg', 'err', 'That is not a BSC transaction hash (0x + 64 hex characters).');
    W.checkAddress(a).then(function (r) {
      if (!r.ok) return say('cmsg', 'err', 'PCoin address rejected: ' + r.why + '.');
      if (/^pc1/i.test(a)) a = a.toLowerCase();
      eth = W.getEth();
      if (!eth) return say('cmsg', 'err', 'No wallet in this browser. Open this page inside the wallet that sent the wPCN.');
      W.setEth(eth);
      $('cclaimBtn').disabled = true;
      return eth.request({ method: 'eth_requestAccounts' }).then(function (acc) {
        var from = acc && acc[0]; if (!from) throw new Error('No account was shared by the wallet.');
        return claim(h, a, from, 'cmsg');
      }).catch(function (e) { say('cmsg', 'err', W.errText(e)); })
        .then(function () { $('cclaimBtn').disabled = false; });
    });
  }
  $('rconnectBtn').addEventListener('click', connect);
  $('rreviewBtn').addEventListener('click', review);
  $('rsendBtn').addEventListener('click', send);
  $('rmaxBtn').addEventListener('click', function () { if (balance !== null) { $('ramount').value = W.fmt(balance); } });
  $('rbackBtn').addEventListener('click', function () { checked = null; $('rconfirm').hidden = true; });
  $('raddr').addEventListener('input', function () { checked = null; $('rconfirm').hidden = true; });
  $('ramount').addEventListener('input', function () { checked = null; $('rconfirm').hidden = true; });
  $('cclaimBtn').addEventListener('click', claimExisting);
  if (!W.getEth()) setTimeout(function () { if (!W.getEth()) { $('rnowallet').hidden = false; } }, 1200);
})();
`;

const redeem = (msg = '') => page('Redeem wPCN back into PCN', '/redeem', `
<h1>Redeem wPCN back into PCN</h1>
<p class="lead">The door opens both ways. 1 PCN for every 1 wPCN, no fee on this
side, paid by a person — allow hours, not minutes.</p>
${msg}
<div class="card"><p style="margin:0"><b>Two ways to do it, same result for you.</b>
<b>Return</b> sends your wPCN back to the desk's inventory, where it can be wrapped
again by the next person. <b>Burn</b> destroys it through the contract. We ask
you to <b>return</b>: the supply is fixed at 50,000 and cannot be minted, so every
burn permanently shrinks what can ever be wrapped — and once that runs out wPCN
can trade above PCN with nothing able to pull it back. Returning keeps the two
prices linkable. Both pay you the same PCN.</p></div>

<h2>Return — recommended</h2><div class="card" id="retcard">
<ol class="steps" style="margin-bottom:.8rem">
<li>Open this page <b>inside your wallet's browser</b> (MetaMask &rarr; Browser
 &rarr; <code>wrapdesk.pc.am/redeem</code>), or on a computer with the MetaMask
 extension. Tap <b>Connect wallet</b>.</li>
<li>Enter the amount and the PCoin address (<code>pc1q…</code>) to receive the PCN,
 then <b>Review</b>.</li>
<li>Press <b>Send wPCN to the desk</b> and confirm in the wallet. The wPCN goes to
 the desk's inventory address <code>${INVENTORY}</code>.</li>
<li>The wallet then asks you to <b>sign a short message</b> (no fee, nothing is
 sent) naming the transaction and your PCoin address. That signature is what
 proves the wPCN came from you, so nobody else can claim it.</li>
<li>A person sends the PCN to your address. Allow hours, not minutes.</li>
</ol>
<button id="rconnectBtn" type="button" style="margin-top:.4rem">Connect wallet</button>
<div id="rnowallet" hidden>
<p class="warn"><b>No wallet found in this browser.</b>
On a phone, open this page inside your wallet's own browser —
<a href="https://metamask.app.link/dapp/wrapdesk.pc.am/redeem">tap here to open it in MetaMask</a>.
On a computer, use a browser with the MetaMask extension. Or send by hand — see
"Already sent?" below.</p></div>
<div id="rconnected" hidden><table>
<tr><th>Account</th><td><code id="racct"></code></td></tr>
<tr><th>wPCN held</th><td><b id="rbal"></b></td></tr></table></div>
<div id="rform" hidden>
<label for="ramount">Amount to return, in wPCN</label>
<div style="display:flex;gap:.6rem;align-items:center">
<input id="ramount" inputmode="decimal" autocomplete="off" placeholder="1.00000000">
<button id="rmaxBtn" type="button" style="margin:0;padding:.55rem .8rem;background:#21262d">All</button></div>
<label for="raddr">PCoin address to receive the PCN (pc1q…)</label>
<input id="raddr" autocomplete="off" spellcheck="false" placeholder="pc1q…">
<button id="rreviewBtn" type="button">Review</button>
<div id="rconfirm" hidden style="margin-top:1.1rem;border:1px solid var(--amber);border-radius:9px;padding:1rem 1.1rem">
<p style="margin:0 0 .5rem" class="warn"><b>Read this once more before you press the button.</b></p>
<table>
<tr><th>Send</th><td><b id="rc_amount"></b> from <code id="rc_acct"></code></td></tr>
<tr><th>To the desk</th><td><code>${INVENTORY}</code></td></tr>
<tr><th>PCN goes to</th><td><code id="rc_addr"></code><br><span class="muted" id="rc_kind"></span></td></tr></table>
<p class="muted" style="margin:.5rem 0 0">The address has a valid checksum, which
rules out a typo. It does not prove the address is <i>yours</i> — that only you
can check, in the wallet you copied it from.</p>
<button id="rsendBtn" type="button">Send wPCN to the desk</button>
<button id="rbackBtn" type="button" style="background:#21262d;margin-left:.6rem">Back</button></div>
</div>
<div id="rdone" hidden>
<p class="ok"><b>Recorded.</b> Transaction: <a id="rtxlink" rel="noopener" target="_blank" style="overflow-wrap:anywhere"></a></p>
<p class="muted" id="rdonemsg">Keep that hash — it is your receipt. A person pays the
PCoin address you gave; nothing else needs to be done on your side.</p></div>
<p id="rstatus" class="muted" hidden></p>
<p id="rmsg" hidden></p>
<noscript><p class="err">This helper needs JavaScript. See "Already sent?" below for the route without it.</p></noscript>
</div>

<h2>Already sent? Claim it here</h2><div class="card">
<p class="muted" style="margin-top:0">If you transferred wPCN to
<code>${INVENTORY}</code> by hand, or the page closed before the signature step,
give the transaction hash and your PCoin address here and sign with the <b>same
wallet that sent it</b>. Without that signature the desk cannot know the wPCN was
yours, and will not pay it out to a stranger who found the hash first.</p>
<label for="ctx">BSC transaction hash</label>
<input id="ctx" autocomplete="off" spellcheck="false" placeholder="0x…">
<label for="caddr">PCoin address to receive the PCN (pc1q…)</label>
<input id="caddr" autocomplete="off" spellcheck="false" placeholder="pc1q…">
<button id="cclaimBtn" type="button">Sign and claim</button>
<p id="cmsg" hidden></p></div>

<h2>Burn — the contract route</h2><div class="card">
<p class="muted" style="margin-top:0">Also valid, also paid 1:1. The contract burns
your wPCN and logs your PCoin address; the burn cannot be undone and shrinks the
supply for ever. Use it if you prefer not to trust the desk's ledger with your
claim — the burn is a permanent on-chain record nobody can alter.</p>
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
<button id="sendBtn" type="button" style="background:#9e6a03">Burn and request PCN (cannot be undone)</button>
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
what lets arbitrage hold the PCN and wPCN prices together. A <b>return</b> leaves
the supply and the reserve exactly as they were and refills the desk's inventory;
a <b>burn</b> lowers the supply the reserve has to cover, which shows on the
<a href="/proof">proof page</a>. Either way you are paid the same.</p></div>
<script>var TOKEN=${JSON.stringify(TOKEN)}, INVENTORY=${JSON.stringify(INVENTORY)}, RETURN_MSG=${JSON.stringify(returnMessage('%TX%', '%ADDR%'))};</script>
<script>${REDEEM_JS}</script>
<script>${RETURN_JS}</script>`);

async function proof() {
  const [bal, held] = await Promise.all([reserveBalance(), inventoryHeld()]);
  const known = bal !== null;
  const circ = held === null ? null : Math.max(0, ISSUED - held);
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
<div><div class="muted">wPCN outside the desk</div><div class="big">${
  circ === null ? 'UNKNOWN' : n2(circ)}</div>
  <div class="muted" style="font-size:.8rem">issued minus what the desk's inventory and its market bot hold${
  held === null ? '' : ` (${n2(held)})`}. Includes the PancakeSwap pool</div></div>
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
<i>more</i> covered, not less.</p>
<p class="muted"><b>Why the inventory matters.</b> The supply cannot be minted, so
the wPCN sitting in the desk's inventory is the only wPCN that can ever be wrapped
again. Redeeming by <a href="/redeem">return</a> puts tokens back there;
redeeming by burn destroys them. When the inventory is empty nobody can wrap, and
wPCN can then trade <b>above</b> PCN with no arbitrage able to pull it back down.
The reserve is unaffected either way — a return is paid from a separate wallet, so
the backing figure above does not move.</p></div>

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
that accepts PCN charges against. The pool is small and a bot of ours buys wPCN
when it falls well below that rate, within a small daily budget; when the pool
falls on real selling the credit rate follows it down to a published floor, and
the pool is never allowed to push that rate <i>up</i>. Do not read the pool as
the market's verdict on PCN.</p></div>

<h2>How do I get PCN back?</h2><div class="card"><p class="muted">Through the
<a href="/redeem">redeem page</a>, 1 PCN for every 1 wPCN, no fee on that side,
paid by a person so not instant. Two routes: <b>return</b> the wPCN to the desk's
inventory and sign a message naming your PCoin address (recommended), or
<b>burn</b> it through the contract. Both pay the same. Check the PCoin address
twice either way.</p></div>

<h2>Why return rather than burn?</h2><div class="card"><p class="muted">The wPCN
contract has no mint function — that is a safety feature, checkable in the
bytecode — so the 50,000 ever created is all there will be. A burn destroys
tokens for ever; a return puts them back in the desk's inventory, where the next
person can wrap PCN into them. Once the inventory is gone, nobody can turn PCN
into wPCN any more, and then wPCN can trade <b>above</b> PCN with nothing to pull
it back (see the next question). Returning keeps that from happening. The
contract's <code>redeem()</code> is still there for anyone who prefers a
permanent on-chain record.</p></div>

<h2>Can wPCN and PCN have different prices?</h2><div class="card"><p class="muted">
Yes, and the two directions are not symmetric. If wPCN trades <i>below</i> PCN,
anyone can buy wPCN, redeem it 1:1 and end up with cheaper PCN — that pulls wPCN
back up, and it works without limit. If wPCN trades <i>above</i> PCN, the only
thing that pulls it back down is somebody wrapping PCN into wPCN and selling it,
which needs wPCN in the desk's inventory to hand out. So wPCN can sit at a
<b>premium</b> to PCN whenever the desk has no inventory or wrapping is closed,
and no bot or contract can fix that. The rate PCoin's own services credit PCN at
is never raised by the pool (they credit the lower of the posted rate and the
pool), so a premium costs nobody who spends PCN — but somebody buying wPCN on
PancakeSwap may be paying more than PCN costs at market.pc.am. Check both before
you buy.</p></div>

<h2>Who runs this?</h2><div class="card"><p class="muted">The PCoin project. The
same people who run <a href="https://pc.am">pc.am</a>, the explorer and the
pool. There is no separate company and no custodian.</p></div>

<h2>What is the worst case?</h2><div class="card"><p class="muted">You send PCN and
we fail to send wPCN. There is no smart contract enforcing our side of a wrap —
it is a person doing it. That is why the amounts are capped low, why the reserve
is public, and why we would rather you tested with a small amount first.</p></div>`);

// The cap must clear an hCaptcha response token, which is a few KB and can run
// past 8 KB on some flows. It was 4096, which was ample for a form that posted
// only an address and an amount -- and turned into a hard outage the day the
// captcha field was added: over the limit the socket was destroyed, the promise
// never settled, the handler hung, and the proxy answered 502 with an empty
// body. Every real user who solved the captcha got a broken page, and NOTHING
// was logged, because destroying a socket is not an error anyone reports.
//
// Two changes, and the second matters as much as the first: reject rather than
// die in silence, so the handler's catch renders a page that says something and
// the reason reaches the log.
//
// This is the same shape as the collector that broke by GROWING (CLAUDE.md
// 7.15): nothing was wrong with the limit until the thing it measured got
// bigger.
const MAX_BODY = 64 * 1024;
const HARD_BODY = 10 * 1024 * 1024;
const body = (req) => new Promise((res, rej) => {
  let d = '', n = 0, over = false;
  req.on('data', (c) => {
    n += c.length;
    // Over the cap: STOP STORING, but keep draining. Destroying the socket here
    // is what produced the empty 502 -- the rejection reached the handler's
    // catch, and the catch then wrote an error page into a socket that no
    // longer existed. Draining costs nothing and lets the user be told why.
    if (n > MAX_BODY) { over = true;
      if (n > HARD_BODY) { rej(new Error('request body over ' + HARD_BODY + ' bytes; dropped')); req.destroy(); }
      return; }
    d += c;
  });
  req.on('end', () => over
    ? rej(new Error('request body over ' + MAX_BODY + ' bytes'))
    : res(d));
  req.on('error', rej);
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
    if (isGet && p === '/') {
      const who = accountOf(req);
      if (!who) return send(200, home());
      const usedW = accountUsedWpcn(load(), who);
      const capW = ACCOUNT_MONTHLY_PCN * (1 - FEE_PCT / 100);
      return send(200, home('', who, Math.max(0, (capW - usedW) / (1 - FEE_PCT / 100))));
    }
    if (isGet && p === '/track')  return send(200, track());
    if (isGet && p === '/redeem') return send(200, redeem());
    if (isGet && p === '/faq')    return send(200, faq());
    if (isGet && p === '/proof')  return send(200, await proof());

    // ── allocate (or return) a deposit address ──────────────────────────────
    // ---- sign in / out via market.pc.am ----
    if (p === '/sso') {
      if (!SSO_ON) return send(503, home('<p class="err">Sign-in is not configured on this desk.</p>'));
      const who = verifySigned(url.searchParams.get('sso') || '', SSO_SECRET);
      if (!who) {
        // Expired is the common case (the token lives 120 seconds) and is
        // deliberately indistinguishable from forged here. Say what to do, not
        // which of the two it was.
        return send(400, home('<p class="err">That sign-in link is no longer valid. Please start again from market.pc.am.</p>'));
      }
      res.writeHead(302, {
        Location: '/',
        'Set-Cookie': `wd=${encodeURIComponent(signSession(who))}; Path=/; Max-Age=${7 * 86400}; HttpOnly; Secure; SameSite=Lax`,
      });
      return res.end();
    }
    if (p === '/signout') {
      res.writeHead(302, { Location: '/', 'Set-Cookie': 'wd=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax' });
      return res.end();
    }
    // ── a RETURN claim: "I sent wPCN to inventory in tx X; pay PCoin address Y" ─
    if (req.method === 'POST' && p === '/return') {
      const json = (code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8',
          'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' });
        res.end(JSON.stringify(obj));
      };
      if (tooManyReturns(ip)) return json(429, { ok: false, state: 'rate_limited', message: 'Too many requests from your address. Try again in an hour.' });
      let b;
      try { b = JSON.parse(await body(req)); } catch { return json(400, { ok: false, state: 'bad_request', message: 'Body must be JSON.' }); }
      const txhash = String(b.txhash || '').toLowerCase();
      const pcoin = String(b.pcoin || '').trim();
      const from = String(b.from || '').toLowerCase();
      const signature = String(b.signature || '');
      if (!isTxHash(txhash)) return json(400, { ok: false, state: 'bad_request', message: 'txhash must be 0x + 64 hex characters.' });
      if (!isPcn(pcoin)) return json(400, { ok: false, state: 'bad_request', message: 'That is not a PCoin address (pc1…).' });
      if (!isBscLower(from)) return json(400, { ok: false, state: 'bad_request', message: 'from must be a BSC address.' });
      if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return json(400, { ok: false, state: 'bad_request', message: 'The signature is malformed.' });

      // Verify the signature FIRST -- it is the cheap check and the one that
      // stops a stranger claiming somebody else's transfer. A message we
      // cannot verify is recorded UNVERIFIED for the watcher to judge; it is
      // never treated as verified.
      const msg = returnMessage(txhash, pcoin);
      const rec = await recoverSigner(msg, signature);
      if (rec.verdict === 'bad' || (rec.verdict === 'ok' && rec.signer !== from)) {
        console.warn(`[wrapdesk] return claim REJECTED (signer ${rec.signer || '?'} != ${from}) tx ${txhash} from ${ip}`);
        return json(403, { ok: false, state: 'bad_signature',
          message: 'That signature was not made by the wallet that sent the wPCN. Sign with the sending wallet.' });
      }

      const r = await bscRpc('eth_getTransactionReceipt', [txhash]);
      if (!r.ok) return json(503, { ok: false, state: 'unreachable', signature,
        message: 'Could not reach BNB Smart Chain just now. Nothing was recorded — try again in a minute.' });
      const receipt = r.result;
      if (!receipt) return json(202, { ok: false, state: 'pending', signature,
        message: 'That transaction is not visible on chain yet.' });
      if (receipt.status !== '0x1') return json(400, { ok: false, state: 'reverted',
        message: 'That transaction failed on chain; no wPCN moved and nothing is owed.' });
      const transfers = (receipt.logs || []).filter((l) =>
        String(l.address).toLowerCase() === TOKEN.toLowerCase() &&
        String(l.topics && l.topics[0]).toLowerCase() === TRANSFER_TOPIC &&
        addrFromTopic(l.topics[2]) === INVENTORY &&
        addrFromTopic(l.topics[1]) === from);
      if (!transfers.length) return json(400, { ok: false, state: 'no_transfer',
        message: `That transaction contains no wPCN transfer from ${from} to the desk's inventory address.` });

      const st = loadReturns();
      const recorded = [];
      for (const l of transfers) {
        const key = `${txhash}:${parseInt(l.logIndex, 16)}`;    // (txhash, logIndex), never txhash alone
        const wpcn = Number(BigInt(l.data)) / 1e8;
        const prev = st.claims[key];
        if (prev && prev.pcoin !== pcoin) {
          // Same transfer, different destination. Only the sender can sign, so
          // this is the sender changing their mind -- allowed until paid, and
          // the watcher lists both so a person sees the change.
          if (prev.paid) return json(409, { ok: false, state: 'already_paid', message: 'That transfer has already been paid out.' });
          st.claims[key] = { ...prev, pcoin, signature, message: msg, verified: rec.verdict === 'ok', updated_at: Math.floor(Date.now() / 1000), previous_pcoin: prev.pcoin };
        } else if (!prev) {
          st.claims[key] = { txhash, logIndex: parseInt(l.logIndex, 16), from, wpcn, pcoin, signature, message: msg,
            verified: rec.verdict === 'ok', verify_note: rec.verdict === 'ok' ? '' : rec.why,
            block: parseInt(receipt.blockNumber, 16), at: Math.floor(Date.now() / 1000), ip };
        }
        recorded.push({ key, wpcn });
      }
      saveReturns(st);
      const total = recorded.reduce((s, x) => s + x.wpcn, 0);
      console.log(`[wrapdesk] return claim ${recorded.map((x) => x.key).join(',')} ${total} wPCN -> ${pcoin} (${rec.verdict})`);
      return json(200, { ok: true, state: 'recorded', keys: recorded.map((x) => x.key), wpcn: total,
        message: `Recorded: ${n8(total)} wPCN returned in that transaction. A person will send ${n8(total)} PCN to ${pcoin}. Allow hours, not minutes.` });
    }

    if (req.method === 'POST' && p === '/request') {
      // FIRST, before anything is parsed or validated. A closed desk must not
      // reach the allocation, the account cap or the state file at all.
      if (intakeClosed() !== null) {
        return send(503, home(`<p class="err"><b>Wrapping is closed &mdash; but <a href="/redeem">redeeming wPCN &rarr; PCN still works</a>.</b>
          New wrap requests are not being accepted. Nothing you are already owed
          is affected &mdash; every wrap that reached 100 confirmations has been
          paid and anything still confirming will be.<br><br>
          You can still buy and sell on PancakeSwap (wPCN/USDT), and buy PCN
          directly at <a href="https://market.pc.am">market.pc.am</a>.</p>`));
      }
      const f = new URLSearchParams(await body(req));
      const bsc = (f.get('bsc') || '').trim();
      const amount = Number(f.get('amount'));

      if (!isBsc(bsc))
        return send(400, home(`<p class="err">That is not a BSC address. It must
          be <code>0x</code> followed by 40 hex characters.</p>`));
      if (!(amount > 0))
        return send(400, home(`<p class="err">Enter how much PCN you want to wrap.</p>`));
        // An amount over the cap used to be ACCEPTED, clamped in silence, and then
        // echoed back as "You send 9999 PCN / You receive 237.50 wPCN" -- an
        // instruction to send ten times what the desk will wrap, with no mention that
        // the rest comes back. The form has said "(max 250)" all along; it just was
        // not enforced. Refuse it here, where the person can still change it, rather
        // than after they have parted with the coins.
        // Which limit applies depends on whether they are signed in. An account
        // is checked against a ROLLING 30-DAY TOTAL rather than one request, so
        // four requests of 250 cannot walk past it the way per-deposit checks
        // have been walked past on this desk before.
        const acct = accountOf(req);
        if (acct) {
          const usedW = accountUsedWpcn(load(), acct);
          const capW = ACCOUNT_MONTHLY_PCN * (1 - FEE_PCT / 100);
          const leftPcn = Math.max(0, (capW - usedW) / (1 - FEE_PCT / 100));
          if (amount > leftPcn + 1e-8) {
            return send(400, home(`<p class="err">Your account has <b>${n2(leftPcn)} PCN</b> of its
              ${ACCOUNT_MONTHLY_PCN} PCN monthly allowance left. Enter ${n2(leftPcn)} or less.</p>`));
          }
        } else
        if (amount > PER_PERSON)
          return send(400, home(`<p class="err">${n2(amount)} PCN is more than one person
            may wrap. The limit is <b>${PER_PERSON} PCN</b>, across every deposit you
            make &mdash; not per deposit. Enter ${PER_PERSON} or less.</p>`));

      if (HCAPTCHA_ON) {
        const v = await hcaptchaVerdict(f.get('h-captcha-response'), ip);
        if (!v.ok) {
          return send(v.why === 'unreachable' ? 503 : 400, home(v.why === 'unreachable'
            ? `<p class="err">We could not reach the anti-bot check just now, so this
               request was not accepted. Nothing is wrong with your details &mdash;
               please try again in a minute.</p>`
            : `<p class="err">Please complete the &ldquo;I am human&rdquo; check and
               submit again.</p>`));
        }
      }

      const st = load();
      const key = bsc.toLowerCase();

      // ── the total allocation has to REFUSE, not just appear on the page ──
      //
      // TOTAL_ALLOC was advertised in two places ("N wPCN total while the desk
      // is new") and checked in none. PER_PERSON was enforced; the total never
      // was, so the desk would have kept handing out deposit addresses forever
      // while promising a ceiling it did not keep. That is the same defect the
      // comment forty lines above describes for PER_PERSON — a limit the form
      // stated and the code ignored — and this file is where it was fixed once
      // already.
      //
      // Measured in wPCN RELEASED, which is what the page promises: a request
      // for more than PER_PERSON is clamped, and the fee never leaves the desk.
      // A refunded deposit consumes nothing.
      // A REFUNDED deposit consumes no allocation -- the PCN went back and no
      // wPCN was ever issued. requests.json cannot tell us that: its `released`
      // field is written null and never updated, and the real ledger belongs to
      // pcoin-wrapdesk-watch, which keys on wrap:<txid>:<deposit address>.
      // Reading the wrong one of those two files is exactly the mistake this
      // comment exists to stop somebody repeating.
      //
      // Unreadable watcher state falls back to counting everything. That
      // over-counts, which refuses too EARLY -- the safe direction for a cap.
      const refundedAddrs = (() => {
        try {
          const seen = JSON.parse(readFileSync(WATCH_STATE, 'utf8')).seen || {};
          const released = new Set(), refunded = new Set();
          for (const [k, v] of Object.entries(seen)) {
            const addr = k.split(':')[2];           // wrap:<txid>:<address>
            if (!addr) continue;
            if (v && v.released) released.add(addr);
            else if (v && v.refunded) refunded.add(addr);
          }
          for (const a of released) refunded.delete(a);   // released wins
          return refunded;
        } catch { return new Set(); }
      })();
      const wpcnFor = (a) =>
        Math.min(Number(a) || 0, PER_PERSON) * (1 - FEE_PCT / 100);

      // COUNT DEPOSITS, NOT REQUESTS -- and when the two disagree, believe the
      // larger.
      //
      // A request is an intention; a DEPOSIT is the obligation. Counting only
      // requests let the ceiling drift the moment somebody sent more than they
      // asked for: on 2026-09-09 this desk said 2000.00 committed while
      // pcoin-wrapdesk-watch, which reads the chain, said 2152.00 -- one person
      // had sent 500 PCN against a 250 request. The desk was the more permissive
      // of the two, which is the wrong direction for a cap to be wrong in.
      //
      // The watcher is the only component that sees deposits, so it publishes
      // the figure and this reads it. Neither number alone is sufficient:
      //   requested  covers requests made since the watcher last ran, which have
      //              no deposit yet and are therefore invisible to it
      //   deposited  covers over-deposits, which the request rows understate
      // Taking the MAX means neither blind spot can let the ceiling be exceeded.
      //
      // Unreadable or absent watcher state falls back to the requested figure
      // alone: that under-counts over-deposits, but it is the behaviour this had
      // before, and refusing every wrap because a monitoring file is missing
      // would be worse than the drift it fixes.
      const requested = Object.entries(st.requests || {})
        .filter(([k, x]) => k !== key && !x.refunded && !refundedAddrs.has(x.address))
        .reduce((sum, [, x]) => sum + wpcnFor(x.amount), 0);
      const deposited = (() => {
        try {
          const a = JSON.parse(readFileSync(WATCH_STATE, 'utf8')).allocation;
          if (!a) return 0;
          // released_wpcn is the stricter of the watcher's two figures: a release
          // recorded before amounts were logged is charged at the maximum it
          // could have been. Plan against the number that actually refuses.
          return Math.max(Number(a.used_wpcn) || 0, Number(a.released_wpcn) || 0);
        } catch { return 0; }
      })();
      const committed = Math.max(requested, deposited);
      const headroom = TOTAL_ALLOC - committed;
      if (wpcnFor(amount) > headroom + 1e-8) {
        const maxPcn = Math.floor(headroom / (1 - FEE_PCT / 100) * 100) / 100;
        return send(503, home(headroom <= 0
          ? `<p class="err">The desk has allocated its full <b>${TOTAL_ALLOC} wPCN</b>
             and is not taking new wrap requests right now. Nothing is wrong with
             your request — the limit exists because the PancakeSwap pool is
             small, and it will rise. Please check back, or get in touch.</p>`
          : `<p class="err">That would take the desk past its <b>${TOTAL_ALLOC} wPCN</b>
             total allocation. There is <b>${n2(headroom)} wPCN</b> left, so the
             most you can wrap right now is <b>${n2(maxPcn)} PCN</b>. The limit
             exists because the PancakeSwap pool is small, and it will rise.</p>`));
      }

      let r = st.requests[key];
      let setCookie = null;
      if (!r) {
        if (tooMany(ip))
          return send(429, home(`<p class="err">Too many new requests from your
            connection. Please try again later.</p>`));
        if (st.nextIndex >= pool.length)
          return send(503, home(`<p class="err">The desk has run out of deposit
            addresses. That is our problem, not yours — please get in touch.</p>`));
        const slot = pool.find((x) => x.i === st.nextIndex);
        r = { bsc, index: slot.i, address: slot.a, amount,
              created: Date.now(), released: null, account: acct || null };
        st.requests[key] = r; st.nextIndex = slot.i + 1; save(st);
        // The creator, and only the creator, leaves holding the claim.
        setCookie = claimCookieFor(key);
      } else {
        // An EXISTING record: prove ownership before revealing anything.
        // See the note above claimCookieName().
        const owns = holdsClaim(req, key) || (acct && r.account && r.account === acct);
        if (!owns) {
          return send(403, home(`<p class="err">A wrap request already exists for that
            BSC address, and its deposit address is not shown to a visitor we cannot
            recognise — that pairing is private to whoever created it.</p>
            <p class="muted">If it was you: open this page in the browser you used the
            first time, or sign in with the account you created it under. If both are
            gone, get in touch and we will sort it out. Nothing is wrong with the
            request itself and no coins are affected.</p>`));
        }
        // Only the owner may restate the amount. It used to be writable by anyone
        // who knew the BSC address, so a stranger could overwrite the figure on
        // somebody else's record.
        if (amount > 0 && r.amount !== amount) { r.amount = amount; save(st); }
        // Re-issue, so a returning owner's claim does not expire under them.
        setCookie = claimCookieFor(key);
      }

      const eligible = Math.min(amount, PER_PERSON);
      const net = eligible * (1 - FEE_PCT / 100);
      if (setCookie) res.setHeader('Set-Cookie', setCookie);
      return send(200, page('Your deposit address', '/', `
<h1>Send PCN to this address</h1>
<div class="card"><p class="muted">Your deposit address — <b>yours alone</b>, and
reusable. Send to it any time.${intakeClosed() !== null ? ' <b style="color:#e5484d">The desk is closed: PCN sent now is returned, not wrapped.</b>' : ''}</p>
<p><code style="font-size:1.06rem">${esc(r.address)}</code></p></div>
<div class="card"><table>
<tr><th>You send</th><td>${esc(String(amount))} PCN</td></tr>
<tr><th>Fee (${FEE_PCT}%)</th><td>${n8(eligible * FEE_PCT / 100)} wPCN</td></tr>
<tr><th>You receive</th><td><b>${n8(net)} wPCN</b></td></tr>
<tr><th>Sent to</th><td><code>${esc(r.bsc)}</code></td></tr>
<tr><th>Ready after</th><td>${CONFIRMATIONS} confirmations (~${WAIT_H} hours)</td></tr>
</table></div>
<p class="warn"><b>The ${PER_PERSON} PCN limit is for you in total</b>, across every
deposit to this address &mdash; not per deposit. Send more than that and the
excess is returned, not wrapped. <a href="/status?addr=${esc(r.address)}">Your
tracking page</a> shows how much of your limit is left.</p>
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

      // THE CAP IS PER PERSON, ACROSS EVERY DEPOSIT -- not per deposit.
      //
      // This block used to compute `min(deposit, PER_PERSON)` for each card
      // independently, so somebody who sent 250 six times saw six cards each
      // promising 237.50 wPCN: 1425 in total, against an entitlement of 237.50.
      // They were not misreading the page. The page said it. On 2026-09-06 exactly
      // that happened, and the operator alert had the same fault, so nothing
      // contradicted it.
      //
      // Allocation is oldest-first, which is both the fair order and the one a
      // customer can predict: the deposit that arrived first is the one that counts.
      const capPcn = PER_PERSON;
      const ordered = items.slice().sort((a, b) =>
        (a.pending ? 1 : 0) - (b.pending ? 1 : 0) || (b.confirmations - a.confirmations));
      let allowanceUsed = 0;
      for (const it of ordered) {
        const room = Math.max(0, capPcn - allowanceUsed);
        it.eligiblePcn = Math.min(it.pcn, room);
        it.refundPcn = it.pcn - it.eligiblePcn;
        it.wpcn = it.eligiblePcn * (1 - FEE_PCT / 100);
        allowanceUsed += it.eligiblePcn;
      }
      const totalIn = items.reduce((a, b) => a + b.pcn, 0);
      const totalWpcn = items.reduce((a, b) => a + b.wpcn, 0);
      const totalRefund = items.reduce((a, b) => a + b.refundPcn, 0);
      const roomLeft = Math.max(0, capPcn - allowanceUsed);

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
              n8(i.wpcn)} wPCN</div></div>
            <div><div class="muted">Status</div><div style="padding-top:.35rem">
              <span class="pill">${eta}</span></div></div>
          </div>
          <div class="bar"><i style="width:${pct}%"></i></div>
          <p class="muted" style="margin:.2rem 0 0">${state}</p>
          ${i.refundPcn > 0 ? `<p class="warn">Over your ${PER_PERSON} PCN limit by
            ${n2(i.refundPcn)} PCN — that part is returned, not wrapped.</p>` : ''}
          <p class="muted" style="margin:.45rem 0 0">
            <a href="https://explorer.pc.am/tx/${esc(i.txid)}">${esc(i.txid.slice(0, 24))}…</a></p>
        </div>`;
      }).join('');

      const anyReady = items.some((i) => !i.pending && i.confirmations >= CONFIRMATIONS);
      return send(200, page('Your wrap status', '/track', `
<h1>Your wrap</h1>
<p class="lead">Deposits to <code>${esc(addr)}</code></p>
<div class="card">
  <h2 style="margin:0 0 .6rem">Your allowance</h2>
  <div style="display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap">
    <div><div class="muted">Limit, one person</div><div class="big">${n2(capPcn)} PCN</div></div>
    <div><div class="muted">Used</div><div class="big">${n2(allowanceUsed)} PCN</div></div>
    <div><div class="muted">Still available</div><div class="big">${n2(roomLeft)} PCN</div></div>
  </div>
  <div class="bar" style="margin-top:.6rem"><i style="width:${
    Math.max(0, Math.min(100, allowanceUsed / capPcn * 100))}%"></i></div>
  ${roomLeft <= 0
    ? `<p class="warn" style="margin:.6rem 0 0"><b>Your limit is fully used.</b>
       Anything further you send to this address is <b>returned, not wrapped</b>.
       Please do not send more.</p>`
    : `<p class="muted" style="margin:.6rem 0 0">You may still send up to
       <b>${n2(roomLeft)} PCN</b> to this address. Beyond that it is returned.</p>`}
</div>

<div class="card">
  <h2 style="margin:0 0 .6rem">Totals across every deposit</h2>
  <div style="display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap">
    <div><div class="muted">PCN received</div><div class="big">${n8(totalIn)}</div></div>
    <div><div class="muted">wPCN you get</div><div class="big">${n8(totalWpcn)}</div></div>
    <div><div class="muted">PCN returned</div><div class="big">${n8(totalRefund)}</div></div>
  </div>
  <p class="muted" style="margin:.6rem 0 0">${items.length} deposit${
    items.length === 1 ? '' : 's'} to this address. The ${FEE_PCT}% fee is taken in
  wPCN not sent, never in PCN kept back — so the reserve always holds at least
  what the tokens claim.${totalRefund > 0
    ? ` <b>${n2(totalRefund)} PCN is over your limit and will be returned to the
      wallet it came from.</b>`
    : ''}</p>
</div>
${rows}
${anyReady
 ? `<p class="ok">Confirmed. Your wPCN is queued for release — a person sends it,
    so allow some hours.</p>`
 : `<p class="warn">Still confirming. The depth is what protects the desk against
    a chain reorganisation, which is why it is not instant.</p>`}
<div class="card"><p class="muted" style="margin:0">Your wallet will not show
wPCN until you add it — no wallet knows this token yet. Contract
<code>${TOKEN}</code>, symbol wPCN, 8 decimals.</p>${ADD_TOKEN}</div>
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
  console.log(`  allocation ${TOTAL_ALLOC} wPCN total, enforced`);
  console.log(`  returns -> inventory ${INVENTORY}, ledger ${RETURNS_FILE}, ` +
              `signature check ${RECOVER_CMD ? 'via ' + RECOVER_CMD : 'OFF (claims recorded unverified)'}`);
  // Say which state the intake is in, and on whose authority, every start.
  // "The desk is closed" must never be something anyone infers.
  const shut = closedBy();
  if (shut.length) console.log(`  intake CLOSED by: ${shut.map((h) => h.path).join(', ')}`);
  else console.log(`  intake OPEN -- none of ${CLOSED_FILES.join(', ')} exists`);
  // Say which state we are in, every start. "The captcha is on" must never be
  // something anyone infers from the config file they think they deployed.
  if (HCAPTCHA_ON) console.log('  hCaptcha ON');
  else console.warn('[wrapdesk] WARNING: hCaptcha is OFF -- HCAPTCHA_SITEKEY and ' +
                    'HCAPTCHA_SECRET are not both set. The per-person limit is keyed on ' +
                    'a BSC address, which is free to generate, so nothing but the total ' +
                    'allocation is stopping automated farming.');
});
