// /wrapdesk - is the wrap desk taking new requests, and one switch to change it.
//
// The panel and the wrap desk run on the SAME host, so this writes the switch
// file directly. No SSH key, no second credential, no new service to trust --
// the panel gains the ability to flip one flag on one path and nothing else.
//
// WHAT THE SWITCH DOES AND DOES NOT DO, said on the page as well as here,
// because somebody will press it in six months without reading anything:
// closing stops NEW wrap requests. Wraps already in flight keep counting
// confirmations and are still paid. Closing the door and repudiating a debt are
// different acts and only one of them has ever been announced.
//
// The state shown is READ FROM THE FILE the desk itself reads, every render --
// never remembered, never cached. A control that reports its own intention
// rather than the world is the failure mode this whole panel exists to avoid.
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { esc, card, note, tiles } from './ui.mjs';

// The flag this panel OWNS and can actually write.
//
// It was /etc/pcoin/wrapdesk-closed until 2026-09-19, and that is why the
// button on this page had never once worked: the panel runs
// ProtectSystem=strict, so /etc/pcoin is read-only to it and every press
// returned "could not change it". It failed honestly rather than lying, but it
// failed. /etc/pcoin/control is granted to the panel because it holds no
// secrets -- /etc/pcoin holds the keeper's private key and the desk's SSO
// secret and must never be writable from a web page.
export const CLOSED_FILE = '/etc/pcoin/control/wrapdesk-closed';

// Where a deposit transaction can be read. Only ever used to build a link for a
// person to click -- nothing on this page is decided from the explorer.
const EXPLORER = process.env.WRAPDESK_EXPLORER || 'https://explorer.pc.am';

// Our own treasury. Used ONLY to pre-fill the destination on a rehearsal row,
// never on a real refund -- a test wrap has no depositor to resolve, and an
// address that is ours is the only safe thing to suggest.
const TREASURY = process.env.PCOIN_TREASURY
  || 'pc1qlvw6kx8wkcz8f6p0d6kswv69fjt33ll079f64e';

// Every path the DESK treats as closing it, in the desk's own order. The panel
// can only remove the first; the rest are shown so that a flag it cannot clear
// is never mistaken for one it has.
export const LEGACY_CLOSED_FILES = ['/etc/pcoin/wrapdesk-closed'];
const ALL_CLOSED_FILES = [CLOSED_FILE, ...LEGACY_CLOSED_FILES];

export function wrapdeskState() {
  // Unreadable is NOT open. If this cannot be determined, say so rather than
  // drawing a green light -- "I could not look" and "it is running" must never
  // render the same, and here the difference is whether money can arrive.
  const hits = [];
  for (const path of ALL_CLOSED_FILES) {
    try {
      if (!existsSync(path)) continue;
      let body = '';
      try { body = readFileSync(path, 'utf8'); }
      catch (e) { body = `(exists but could not be read: ${e.message})`; }
      hits.push({ path, note: body });
    } catch (e) {
      return { open: null, note: '', error: `${path}: ${e.message}`, hits: [] };
    }
  }
  return {
    open: hits.length === 0,
    note: hits.map((h) => h.note).join(String.fromCharCode(10)),
    hits,
    // A flag the desk honours but this page cannot delete. Reopening will not
    // work while one of these is present, and saying so beats a button that
    // reports success and changes nothing.
    stuck: hits.filter((h) => h.path !== CLOSED_FILE).map((h) => h.path),
  };
}

// ── WHAT THE DESK IS WAITING FOR ─────────────────────────────────────────────
//
// The page used to be one switch, which answered "is intake open" and nothing
// else. The owner, 2026-09-20: "why wrap desk missing from global admin, there
// should be wrapdesk separate section showing everything related to wrap desk,
// so admin enter and know what is pending and what he should do". Quite right:
// the hourly Telegram alert said "wrap desk: 2 thing(s) need you" and the only
// way to find out WHICH two was to SSH in and read a journal.
//
// This asks THE WATCHER, rather than reimplementing it. The alert and this page
// then come from one piece of code and cannot drift into disagreeing about
// whether somebody is owed money.
//
// TWO RULES, BOTH PAID FOR (CLAUDE.md 7.14):
//
//  * IT MUST RUN WITH THE UNIT'S ENVIRONMENT. Every setting lives in
//    Environment= lines on pcoin-wrapdesk-watch.service, so a bare run is a
//    DIFFERENT PROGRAM: it loses WRAP_OPENED_AT_HEIGHT (no floor, so the
//    reserve's own founding deposit reads as a customer owed 237.50 wPCN) and
//    WRAP_TOTAL_ALLOC (1500 instead of 7500, so payable wraps read as blocked).
//    Reproduced on 2026-09-20, which is how this page came to be written.
//  * IT MUST NOT BE ABLE TO SEND. --dry-run is verified to send nothing, and
//    PCOIN_NOTIFY is pinned to /bin/true as well -- the variable the code reads
//    is PCOIN_NOTIFY, and a session once set NOTIFY= instead and disabled
//    nothing at all while believing it had.
const UNIT = 'pcoin-wrapdesk-watch.service';

// RUN WHAT THE UNIT RUNS -- including the INTERPRETER.
//
// /usr/local/bin/pcoin-wrapdesk-watch opens `#!/usr/bin/env python3`, but the
// unit runs it as `/opt/wpcn/.venv/bin/python /usr/local/bin/...`, and only that
// venv has web3. Exec'ing the script by path therefore ran a DIFFERENT program:
// every BSC read inside it raised ModuleNotFoundError, was swallowed by a broad
// `except Exception: return None`, and this page reported the PancakeSwap
// reserves unreadable while the timer -- sixteen minutes either side of it --
// read them perfectly. It degraded quietly, in the direction of "unknown",
// which is the safe direction and is still the wrong answer.
//
// That is CLAUDE.md 7.14 one level lower down: not the environment this time
// but the binary. So the argv is READ OFF THE UNIT rather than written here,
// and if it cannot be read the page says so instead of guessing.
function watchArgv() {
  const out = execFileSync('systemctl', ['show', UNIT, '-p', 'ExecStart', '--no-pager'],
    { encoding: 'utf8', timeout: 15000 });
  // systemctl prints: ExecStart={ path=... ; argv[]=/a/python /b/script ; ... }
  // A unit with a drop-in that resets ExecStart prints BOTH the cleared entry
  // and the live one, so take the LAST argv[] -- the first is the empty reset.
  const all = [...String(out).matchAll(/argv\[\]=([^;]*);/g)]
    .map((m) => m[1].trim().split(/\s+/).filter(Boolean))
    .filter((a) => a.length);
  if (!all.length) throw new Error(`could not read ExecStart from ${UNIT}`);
  const argv = all[all.length - 1];
  if (argv.length < 2) throw new Error(`${UNIT}'s ExecStart has no script argument`);
  return argv;
}

function unitEnvironment() {
  // systemctl prints: Environment=A=1 B=2 ... on one line.
  const out = execFileSync('systemctl', ['show', UNIT, '-p', 'Environment', '--no-pager'],
    { encoding: 'utf8', timeout: 15000 });
  const env = {};
  const line = String(out).replace(/^Environment=/, '').trim();
  // Values here are numbers and heights, never quoted strings with spaces.
  for (const pair of line.split(/\s+/)) {
    const i = pair.indexOf('=');
    if (i > 0) env[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return env;
}

// Everything both entry points need before they may run the watcher at all.
// Returned rather than thrown so a caller can render the reason.
function watchContext() {
  let argv;
  try {
    argv = watchArgv();
  } catch (e) {
    return { ok: false, why: e.message };
  }
  let env;
  try {
    env = unitEnvironment();
  } catch (e) {
    return { ok: false, why: `could not read ${UNIT}'s environment: ${e.message}` };
  }
  if (!env.WRAP_TOTAL_ALLOC || !env.WRAP_OPENED_AT_HEIGHT) {
    // Refuse rather than show numbers computed from defaults. Those numbers
    // look exactly like real ones and have already caused a false alert.
    return { ok: false, why: 'the unit does not define WRAP_OPENED_AT_HEIGHT and '
      + 'WRAP_TOTAL_ALLOC, so any figures here would be computed from defaults '
      + 'and would be wrong in the direction of inventing a debt' };
  }
  return {
    ok: true,
    argv,
    env: { ...process.env, ...env, PCOIN_NOTIFY: '/bin/true', NOTIFY: '/bin/true' },
  };
}

// CLOSE OUT A WRAP THAT HAS BEEN PAID.
//
// The panel does not decide anything here and does not touch the state file
// itself: it hands the BSC transaction hash to the watcher, which reads the
// receipt off BNB Smart Chain and refuses every hash that does not show the
// right amount of wPCN reaching the right address. So this button cannot mark
// a customer paid who was not paid -- which is the only reason it is a button.
//
// No --dry-run here, obviously: that is the flag that makes it do nothing.
export function markReleased(key, txhash) {
  const ctx = watchContext();
  if (!ctx.ok) return { ok: false, out: ctx.why };
  // Shape-check before spending an RPC call on it. The watcher checks too; this
  // just turns a typo into an instant answer.
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(txhash || ''))) {
    return { ok: false, out: 'That is not a BSC transaction hash. It is 0x followed '
      + 'by 64 hex characters -- copy it from MetaMask or BscScan. Nothing was changed.' };
  }
  if (!/^[0-9a-f]{64}:[0-9a-z]+$/i.test(String(key || ''))) {
    return { ok: false, out: 'That wrap key does not look right, so nothing was sent '
      + 'to the watcher. Reload the page and try again.' };
  }
  try {
    const out = execFileSync(ctx.argv[0], [...ctx.argv.slice(1), '--released', key, txhash],
      { encoding: 'utf8', timeout: 120000, env: ctx.env });
    return { ok: true, out: String(out).trim() };
  } catch (e) {
    // Exit 2 is "refused", 3 is "could not check" -- both print their reason on
    // stdout and both mean nothing was written. Show the reason, not the code.
    const said = [e && e.stdout, e && e.stderr].map((x) => String(x || '').trim())
      .filter(Boolean).join(String.fromCharCode(10));
    return { ok: false, out: said || `the watcher did not run: ${e.message}` };
  }
}

// SEND THE wPCN, rather than telling the operator to go and do it by hand.
//
// The keeper already holds a server-side key and already signs BSC
// transactions daily, so this spends custody that was ALREADY taken -- it is
// not a new key and not a new host. What it removes is the half-hour of
// MetaMask in the middle of a payout.
//
// The panel does none of it. The watcher re-resolves the key, re-checks the
// per-address ceiling INCLUDING what previous runs already paid (the one
// guard the alerting path is missing), checks the daily cap, refuses to
// re-broadcast anything whose receipt was never recorded, and only then signs.
// After the receipt it runs the same chain verification `Mark as sent` uses.
// So this button cannot pay someone twice and cannot pay someone over the cap.
export function sendWrap(key) {
  const ctx = watchContext();
  if (!ctx.ok) return { ok: false, out: ctx.why };
  if (!/^[0-9a-f]{64}:[0-9a-z]+$/i.test(String(key || ''))) {
    return { ok: false, out: 'That wrap key does not look right, so nothing was sent. '
      + 'Reload the page and try again.' };
  }
  try {
    // Longer than markReleased's budget on purpose: this waits for a block.
    const out = execFileSync(ctx.argv[0], [...ctx.argv.slice(1), '--send', key],
      { encoding: 'utf8', timeout: 360000, env: ctx.env });
    return { ok: true, out: String(out).trim() };
  } catch (e) {
    const said = [e && e.stdout, e && e.stderr].map((x) => String(x || '').trim())
      .filter(Boolean).join(String.fromCharCode(10));
    return { ok: false, out: said || `the send did not run: ${e.message}` };
  }
}

// WHO DO WE GIVE IT BACK TO? The desk never records it.
//
// The public page says "it does not matter which wallet or address you send
// from", so there is no customer address on file. It is recoverable anyway:
// the deposit transaction's own inputs are the depositor's addresses, and a
// refund to inputs[0] goes back where the money came from. Verified against
// the live explorer on 2026-09-21 and used by hand for the 2026-09-17 refund
// before it was ever automated.
//
// Returns null when it cannot be determined, and null must stay null: a
// refund to a guessed address is money given to a stranger.
function depositorOf(txid) {
  const bases = [process.env.PCOIN_EXPLORER, 'http://127.0.0.1:8080',
    'https://explorer.pc.am'].filter(Boolean);
  for (const base of bases) {
    try {
      const out = execFileSync('curl', ['-s', '--max-time', '20',
        `${base}/api/tx/${encodeURIComponent(txid)}`], { encoding: 'utf8', timeout: 30000 });
      const tx = (JSON.parse(out) || {}).tx;
      const a = ((tx && tx.inputs) || []).map((i) => i && i.address).filter(Boolean)[0];
      if (a) return a;
    } catch { /* try the next base */ }
  }
  return null;
}

// GIVE THE PCN BACK, from the panel.
//
// Two steps, in this order, and the order is the whole design:
//   1. the market host sends the PCN -- it is the only box with a spendable
//      PCN wallet, because deposit addresses and the reserve are deliberately
//      unspendable from any server. It is idempotent on the wrap key, so a
//      lost response costs a retry and never a second refund.
//   2. only once a txid exists is the wrap recorded refunded.
// Doing it the other way round would mark a customer repaid on the strength of
// an intention. The hash written down is the one the market host broadcast --
// not one typed by an operator -- so it cannot be a hash of something else.
export function refundWrap(key, pcn, to) {
  const ctx = watchContext();
  if (!ctx.ok) return { ok: false, out: ctx.why };
  if (!/^[0-9a-f]{64}:[0-9a-z]+$/i.test(String(key || ''))) {
    return { ok: false, out: 'That wrap key does not look right; nothing was sent.' };
  }
  const amount = Number(pcn);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, out: `"${pcn}" is not an amount of PCN; nothing was sent.` };
  }
  const txid = String(key).split(':')[0];
  const dest = String(to || '').trim() || depositorOf(txid);
  if (!dest) {
    return { ok: false, out: 'Could not work out who to refund: the deposit transaction '
      + 'could not be read, so its sender is unknown. Nothing was sent. Type the address '
      + 'in by hand if you know it.' };
  }
  let creds;
  try {
    creds = JSON.parse(readFileSync('/opt/pcoin-admin/upstream.json', 'utf8'));
  } catch (e) {
    return { ok: false, out: `could not read the upstream credentials: ${e.message}` };
  }
  const tok = creds && creds.market && creds.market.refundToken;
  const url = (creds && creds.market && creds.market.refundUrl)
    || 'https://market.pc.am/api/ops/refund-pcn';
  if (!tok) {
    return { ok: false, out: 'No market refundToken is configured in upstream.json, so '
      + 'refunds are switched off. Nothing was sent.' };
  }
  let body;
  try {
    body = execFileSync('curl', ['-s', '--max-time', '120', '-X', 'POST', url,
      '-H', 'content-type: application/json',
      '-H', `authorization: Bearer ${tok}`,
      '--data-binary', JSON.stringify({ key, to: dest, pcn: amount })],
    { encoding: 'utf8', timeout: 140000 });
  } catch (e) {
    return { ok: false, out: `the refund call did not complete (${e.message}). It may or `
      + `may not have sent -- check the market wallet for a transaction with comment `
      + `${key} BEFORE trying again.` };
  }
  let r;
  try { r = JSON.parse(body); } catch { r = null; }
  if (!r || r.ok !== true) {
    return { ok: false, out: (r && r.error) || `the market host answered something `
      + `unreadable: ${String(body).slice(0, 200)}` };
  }
  // Sent. Now record it -- and if RECORDING fails, say so loudly, because the
  // money has already moved and the ledger has not caught up.
  try {
    const out = execFileSync(ctx.argv[0],
      [...ctx.argv.slice(1), '--refunded', key, r.txid],
      { encoding: 'utf8', timeout: 120000, env: ctx.env });
    return { ok: true, out: `${r.already ? 'Already refunded earlier' : 'Refunded'} `
      + `${amount} PCN to ${dest}, tx ${r.txid}. ${String(out).trim()}` };
  } catch (e) {
    return { ok: false, out: `THE PCN WAS SENT (tx ${r.txid}) BUT THE WRAP WAS NOT `
      + `RECORDED AS REFUNDED. Close it by hand: --refunded ${key} ${r.txid}. `
      + `(${e.message})` };
  }
}

// THE MONEY VIEW, NETTED. See the long note on reconcile() in the watcher.
//
// Short version: on 2026-09-22 an audit read GROSS PCN received against the
// cap and reported 2,000 PCN owed across two customers. The truth was 250
// across one -- it had never subtracted refunds already paid. That sum now
// lives in the watcher and is rendered here, so the netted figure is the one
// on screen and nobody has to recompute it in a throwaway script again.
export function wrapdeskReconcile() {
  const ctx = watchContext();
  if (!ctx.ok) return { ok: false, why: ctx.why };
  try {
    const out = execFileSync(ctx.argv[0],
      [...ctx.argv.slice(1), '--reconcile', '--json'],
      { encoding: 'utf8', timeout: 180000, env: ctx.env });
    return JSON.parse(String(out));
  } catch (e) {
    const said = [e && e.stdout, e && e.stderr].map((x) => String(x || '').trim())
      .filter(Boolean).join(' ');
    return { ok: false, why: said || `could not reconcile: ${e.message}` };
  }
}

export function wrapdeskWork() {
  const ctx = watchContext();
  if (!ctx.ok) return { ok: false, why: ctx.why };

  let raw;
  try {
    raw = execFileSync(ctx.argv[0], [...ctx.argv.slice(1), '--dry-run'], {
      encoding: 'utf8',
      timeout: 120000,
      env: ctx.env,
    });
  } catch (e) {
    // It exits non-zero when work is outstanding, which is not an error.
    if (e && typeof e.stdout === 'string' && e.stdout.length) raw = e.stdout;
    else return { ok: false, why: `the watcher did not run: ${e.message}` };
  }

  const lines = String(raw).split(String.fromCharCode(10));
  const items = [];
  let cur = null;
  let allocation = null;
  const warnings = [];

  const push = () => { if (cur) items.push(cur); cur = null; };

  for (const ln of lines) {
    const t = ln.trim();
    if (!t) continue;

    if (t.startsWith('[action] ACTION: send')) {
      push();
      cur = { kind: 'send', title: t.replace('[action] ', ''), detail: [], close: null, to: null, key: null };
      continue;
    }
    if (t.startsWith('[action] WITHHELD')) {
      push();
      cur = { kind: 'withheld', title: 'Withheld - do not send yet', detail: [], close: null, to: null, key: null };
      continue;
    }
    if (/^\[info\] WRAP /.test(t)) {
      push();
      cur = { kind: 'waiting', title: t.replace('[info] ', ''), detail: [], close: null, to: null, key: null };
      continue;
    }
    const alloc = t.match(/Allocation: ([\d.]+) of ([\d.]+) wPCN used, ([\d.]+) left/);
    if (alloc) {
      allocation = { used: Number(alloc[1]), total: Number(alloc[2]), left: Number(alloc[3]) };
      push();
      continue;
    }
    if (t.startsWith('[warn]')) { warnings.push(t.replace('[warn] ', '')); push(); continue; }
    if (t.startsWith('UNHEALTHY') || t.startsWith('[info] Cycle')) {
      if (t.startsWith('[info] Cycle')) warnings.push(t.replace('[info] ', ''));
      push();
      continue;
    }

    if (cur) {
      const to = t.match(/^TO\s*:\s*(0x[0-9a-fA-F]{40})/);
      if (to) cur.to = to[1];
      if (/^pcoin-wrapdesk-watch --(released|refunded)/.test(t)) {
        cur.close = t;
        // The wrap's identity, <pcoin-txid>:<deposit-address>. Taken from the
        // line the watcher itself printed rather than reassembled here, so the
        // button can only ever close a wrap the watcher just described.
        const k = t.match(/--(?:released|refunded)\s+(\S+)/);
        if (k) cur.key = k[1];
      } else if (!/^(WHEN (SENT|REFUNDED)|Easiest: the wrap desk page)/.test(t)) {
        // Those two lines exist for the TELEGRAM alert, where the only way to
        // close a wrap is a command line. On this page they would be the page
        // describing the box printed immediately below them.
        cur.detail.push(t);
      }
    }
  }
  push();

  // WHY a deposit was withheld decides what you do about it, and the three
  // reasons want three different answers. Two of them are judgement calls --
  // one depositor over their own limit, or a single instruction over the
  // per-send ceiling -- and you might legitimately raise a limit and pay.
  //
  // The allocation being full is NOT a judgement call. No wPCN exists to issue,
  // so the PCN goes back, and that case is separated here so it stops reading
  // as one more thing to think about.
  //
  // Classified off the watcher's own REASON line rather than recomputed from
  // the numbers, so this page can only ever describe a refusal the watcher
  // actually made. An unrecognised reason falls to 'other' and is shown as a
  // decision, never silently as a refund.
  for (const i of items) {
    if (i.kind !== 'withheld') continue;
    const reason = i.detail.find((d) => d.startsWith('REASON:')) || '';
    i.why = /against a .* allocation/.test(reason) ? 'cap'
      : /a single person may receive/.test(reason) ? 'person'
        : /ceiling on any single instruction/.test(reason) ? 'single'
          : 'other';
    // How much PCN to send back, and which transaction it arrived in. Both are
    // read out of lines the watcher printed; the txid comes from the close-out
    // key for the same reason the key itself does.
    const m = i.detail.map((d) => d.match(/^([\d.]+) PCN, tx /)).find(Boolean);
    i.pcn = m ? m[1] : null;
    i.txid = i.key ? i.key.split(':')[0] : null;
  }

  return { ok: true, items, allocation, warnings, ranAt: new Date().toISOString() };
}

function workCard(w) {
  if (!w.ok) {
    return card('What needs you',
      note('This could not be read, so nothing is shown rather than something wrong. '
        + esc(w.why)));
  }
  const actions = w.items.filter((i) => i.kind === 'send');
  const held = w.items.filter((i) => i.kind === 'withheld');
  const refund = held.filter((i) => i.why === 'cap');
  const decide = held.filter((i) => i.why !== 'cap');
  const waiting = w.items.filter((i) => i.kind === 'waiting');

  // THE CLOSE-OUT, AS A BOX YOU CAN TYPE IN.
  //
  // Sending the wPCN does not close the wrap: the desk has no view of the
  // inventory wallet, so somebody has to tell it the payment happened. That used
  // to mean SSH and a copied command line, which is why the owner asked "there
  // is no action button to click after send".
  //
  // It is NOT a button that takes your word for it. The hash goes to the
  // watcher, which fetches the receipt from BNB Smart Chain and refuses unless
  // the right amount of wPCN reached the right address. A wrong hash, a
  // reverted send, or a send to the previous customer is refused with the
  // reason and nothing is written -- so pressing this can only ever record
  // something the chain already agrees happened.
  // SEND IT FROM HERE. One button, one confirm, no MetaMask.
  //
  // Deliberately a separate <form> from "Mark as sent" rather than a second
  // button inside it: that form REQUIRES a transaction hash, and a browser
  // will not submit it while the box is empty. Sharing it would make this
  // button silently do nothing, which is the failure mode this whole page
  // exists to avoid.
  // The amount is read back out of the title the watcher printed ("ACTION:
  // send 237.50 wPCN") rather than carried as a field, because the title is
  // what the operator is looking at. If it cannot be parsed the button still
  // works and simply says "Send now" -- the watcher decides the amount, not
  // this label, so a missing label is cosmetic and never changes what is paid.
  const amountOf = (i) => (String(i.title || '').match(/([\d,]+\.?\d*)\s*wPCN/) || [])[1];
  // A rehearsal row, labelled by the watcher. Only used to decide how much
  // hand-holding the refund form needs -- it changes no amount and no address
  // on a real payout.
  const isTest = (i) => /TEST WRAP/.test(String(i.title || ''));
  const sendForm = (i) => (i.kind !== 'send' || !i.key ? '' :
    `<form method="post" style="margin-top:10px"`
    + ` onsubmit="return confirm('Send ${esc(amountOf(i) || '')} wPCN from the keeper`
    + ` now? This moves real money and cannot be undone.')">`
    + `<input type="hidden" name="action" value="send">`
    + `<input type="hidden" name="key" value="${esc(i.key)}">`
    + `<button style="background:var(--accent,#2dd4bf);color:#0b1020;border:0;`
    + `border-radius:999px;padding:8px 18px;cursor:pointer;font-weight:700">`
    + `Send ${esc(amountOf(i) ? `${amountOf(i)} wPCN ` : '')}now</button>`
    + `<p class="muted" style="margin:6px 0 0;font-size:12px">Pays from the keeper wallet `
    + `and closes the wrap in one step. Refused if this address has already been paid, `
    + `if it would cross the per-address ceiling or the daily cap, or if an earlier `
    + `attempt broadcast something whose receipt was never recorded. The receipt is `
    + `checked on BNB Smart Chain before anything is written down.</p></form>`);

  // REFUND, ON EVERY RECORD THAT HAS A KEY -- not only the over-cap ones.
  //
  // The reason to give PCN back is not always "the allocation was full": a
  // customer can change their mind, a deposit can be a mistake, a wrap can be
  // withheld for a reason that never resolves. Offering the button only where
  // the code had already decided a refund was due meant every other case went
  // back to SSH, which is where the mistakes live.
  //
  // The amount and the destination are both editable and both pre-filled:
  // the destination from the deposit transaction's own inputs (the desk never
  // records who paid), the amount left blank because only a person knows
  // whether this is the whole deposit or the part above the cap.
  const refundForm = (i) => (!i.key ? '' :
    // A PLAIN <summary> WAS NOT FINDABLE. It rendered as a line of coloured
    // text under a large green button, and the operator pressed Send three
    // times in a row while trying to reach the refund -- each press moving
    // real money. A control that is one of two choices must LOOK like one of
    // two choices, so this is styled as the button it is and says what it
    // does. Still collapsed: six real rows with two open input boxes each is
    // a page that invites a mis-click on somebody's money.
    `<details style="margin-top:10px"><summary style="cursor:pointer;`
    + `display:inline-block;background:transparent;color:var(--yellow);`
    + `border:2px solid var(--yellow);border-radius:999px;padding:7px 18px;`
    + `font-weight:700;list-style:none">`
    + `&#8617; Refund PCN instead &mdash; tap to open</summary>`
    + `<form method="post" style="margin-top:8px"`
    + ` onsubmit="return confirm('Send this PCN back from the market wallet now? `
    + `This moves real money and cannot be undone.')">`
    + `<input type="hidden" name="action" value="refund">`
    + `<input type="hidden" name="key" value="${esc(i.key)}">`
    + `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">`
    + `<input name="pcn" required inputmode="decimal" pattern="[0-9]*\\.?[0-9]*"`
    + ` value="${esc(isTest(i) ? '1' : '')}"`
    + ` placeholder="PCN to give back" style="flex:0 1 170px;padding:7px 10px;`
    + `border-radius:4px;border:1px solid var(--line);background:var(--panel);`
    + `color:inherit;font-family:ui-monospace,monospace;font-size:12px">`
    // A TEST ROW CAN NEVER RESOLVE ITS OWN DESTINATION, so it is filled in.
    // Its txid is random and pays nobody, so "leave blank to use the deposit's
    // own sender" is advice that cannot work here -- and following it returns
    // a refusal that reads like a fault. Pre-filled with the treasury, which
    // is ours, visible in any PCoin wallet and on the explorer, so the
    // rehearsal can actually be watched arriving. A real row is left blank,
    // because there the blank has a correct meaning.
    + `<input name="to" spellcheck="false" autocomplete="off"`
    + (isTest(i) ? ` required value="${esc(TREASURY)}"` : '')
    + ` placeholder="${esc(isTest(i) ? 'where to send the test PCN'
        : "leave blank to use the deposit's own sender")}"`
    + ` style="flex:1 1 320px;min-width:240px;padding:7px 10px;border-radius:4px;`
    + `border:1px solid var(--line);background:var(--panel);color:inherit;`
    + `font-family:ui-monospace,monospace;font-size:12px">`
    + `<button style="background:var(--yellow);color:#0b1020;border:0;border-radius:999px;`
    + `padding:8px 18px;cursor:pointer;font-weight:700">Refund</button></div>`
    + `<p class="muted" style="margin:6px 0 0;font-size:12px">Paid from the market wallet `
    + `&mdash; deposit addresses and the reserve are deliberately unspendable from any `
    + `server. Idempotent on the wrap key, so a lost answer costs a retry and never a `
    + `second refund. Left blank, the destination is read from the deposit transaction's `
    + `own inputs; if that cannot be read, nothing is sent and you are told.</p>`
    + `</form></details>`);

  const closeForm = (i) => (i.kind !== 'send' || !i.key ? '' :
    `<form method="post" style="margin-top:10px">`
    + `<input type="hidden" name="action" value="released">`
    + `<input type="hidden" name="key" value="${esc(i.key)}">`
    + `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">`
    + `<input name="txhash" required spellcheck="false" autocomplete="off"`
    + ` pattern="0x[0-9a-fA-F]{64}" placeholder="BSC transaction hash of the send (0x...)"`
    + ` style="flex:1 1 380px;min-width:260px;padding:7px 10px;border-radius:4px;`
    + `border:1px solid var(--line);background:var(--panel);color:inherit;`
    + `font-family:ui-monospace,monospace;font-size:12px">`
    + `<button style="background:var(--green);color:#0b1020;border:0;border-radius:999px;`
    + `padding:8px 18px;cursor:pointer;font-weight:700">Mark as sent</button></div>`
    + `<p class="muted" style="margin:6px 0 0;font-size:12px">Checked against BNB Smart `
    + `Chain before anything is recorded: right token, right recipient, at least the right `
    + `amount, and the transaction did not revert. If it does not match, nothing changes `
    + `and you are told why.</p></form>`);

  // THE DEPOSIT THAT ARRIVED TOO LATE, SAID PLAINLY.
  //
  // A deposit address is permanent and the public page promises it is reusable
  // "any number of times", so the obligation is created by the DEPOSIT, which
  // lands after the request gate has already let the request through. When the
  // allocation is full there is nothing to issue and the only honest answer is
  // to give the PCN back.
  //
  // WHO to give it back to is NOT recorded anywhere. The desk knows the deposit
  // address and the transaction; it never learns who paid. So this links the
  // transaction and says to read the sender off its inputs. Naming an address
  // here would mean guessing a payee for real money, and a wrong guess pays a
  // stranger while the customer is still owed.
  const refundLine = (i) => (i.why !== 'cap' ? '' :
    `<div style="margin-top:8px;padding:8px 10px;border-radius:4px;`
    + `background:var(--panel);border:1px solid var(--yellow)">`
    + `<b>Refund needed &mdash; send ${esc(i.pcn || 'the deposit')} PCN back.</b> `
    + `The desk had already committed its whole allocation when this arrived, so no `
    + `wPCN can be issued for it. The PCN is safe in the reserve until you return it.`
    + (i.txid
      ? ` <a href="${EXPLORER}/tx/${esc(i.txid)}" target="_blank" rel="noopener">Open `
        + `the deposit on the explorer</a> and take the sender from its inputs &mdash; `
        + `the desk records the deposit address, never who paid into it.`
      : '')
    + `</div>`);

  const block = (i, colour) =>
    `<div style="border-left:3px solid var(--${colour});padding:8px 12px;margin:10px 0;`
    + `background:var(--panel-2);border-radius:4px">`
    + `<div style="font-weight:700">${esc(i.title)}</div>`
    + (i.to ? `<div style="margin-top:4px">to <code>${esc(i.to)}</code></div>` : '')
    + `<pre style="white-space:pre-wrap;margin:6px 0 0;font-size:12px">${esc(i.detail.join(String.fromCharCode(10)))}</pre>`
    + refundLine(i)
    + sendForm(i)
    + refundForm(i)
    + closeForm(i)
    + (i.close
        ? `<details style="margin-top:8px"><summary class="muted" style="cursor:pointer;font-size:12px">`
          + `or close it out on the host</summary>`
          + `<pre style="white-space:pre-wrap;margin:4px 0 0;font-size:12px">${esc(i.close)}</pre></details>`
        : '')
    + `</div>`;

  let body = '';
  if (!actions.length && !held.length) {
    body += '<p><b>Nothing is waiting to be sent.</b></p>';
  }
  if (actions.length) {
    body += `<h3>Send these (${actions.length})</h3>`
      + '<p class="muted">Confirmed past 100 blocks and within the allocation. '
      + 'Send from the inventory wallet, then paste the BSC transaction hash below &mdash; '
      + 'sending does not close anything on its own, and an unclosed wrap is re-alerted '
      + 'every hour for ever.</p>'
      + actions.map((i) => block(i, 'green')).join('');
  }
  if (refund.length) {
    body += `<h3>Refund the PCN &mdash; the allocation is full (${refund.length})</h3>`
      + '<p class="muted">These arrived after the desk had committed its whole allocation, '
      + 'so there is no wPCN to issue for them and raising the ceiling afterwards would be '
      + 'issuing against a limit that was already spent. Send the PCN back to whoever paid '
      + 'it, then close the wrap out or it is re-alerted every hour for ever.</p>'
      + refund.map((i) => block(i, 'red')).join('');
  }
  if (decide.length) {
    body += `<h3>Blocked, needs a decision (${decide.length})</h3>`
      + '<p class="muted">The PCN is safe in the reserve and nothing is lost by waiting. '
      + 'Raise the limit, refund the deposit, or pay it and record why &mdash; '
      + 'but decide it deliberately.</p>'
      + decide.map((i) => block(i, 'yellow')).join('');
  }
  if (waiting.length) {
    body += `<h3>Still confirming (${waiting.length})</h3>`
      + '<p class="muted">Nothing to do. The depth is the whole defence against a reorg.</p>'
      + waiting.map((i) => block(i, 'blue')).join('');
  }
  for (const wn of w.warnings) body += note(esc(wn));
  return card('What needs you', body);
}

function allocationCard(w) {
  if (!w.ok || !w.allocation) return '';
  const a = w.allocation;
  const pct = a.total > 0 ? Math.min(100, (a.used / a.total) * 100) : 0;
  return card('Allocation',
    `<div style="display:flex;justify-content:space-between;font-size:13px">`
    + `<span>${esc(a.used.toFixed(2))} wPCN issued</span>`
    + `<span class="muted">${esc(a.left.toFixed(2))} left of ${esc(a.total.toFixed(2))}</span></div>`
    + `<div style="height:10px;background:var(--panel-2);border-radius:999px;margin-top:6px;overflow:hidden">`
    + `<div style="height:100%;width:${pct.toFixed(1)}%;background:var(--${pct > 90 ? 'red' : pct > 75 ? 'yellow' : 'green'})"></div></div>`
    + note('This is a RUNNING TOTAL that only counts up, and it is raised by hand. '
      + 'It is the ceiling on how much wPCN the desk may ever issue, not a daily budget.'));
}

// EVERY DEPOSIT ADDRESS, NETTED, ON THE PAGE.
//
// This card exists because of a specific mistake. On 2026-09-22 an audit
// compared each address's GROSS PCN received against the 250 cap and reported
// 2,000 PCN owed across two customers. The real figure was 250 across one: it
// had never subtracted refunds already paid, so a customer settled in full in
// September still read as an open debt. The arithmetic lived in a throwaway
// script, which is exactly where that error could survive unchallenged.
//
// The column that matters is HELD:
//
//     held = received - refunded - (wPCN issued / 0.95)
//
// A positive HELD is PCN sitting with us that nobody was entitled to wrap.
// Zero means square. `received` on its own means nothing and is shown only so
// the subtraction can be checked by eye.
function reconcileCard() {
  const r = wrapdeskReconcile();
  if (!r.ok) {
    return card('Every deposit address, netted',
      note('This could not be computed, so nothing is shown rather than a figure that '
        + 'might be wrong. ' + esc(r.why || 'unknown')));
  }
  const open = r.rows.filter((x) => x.readable && x.held_pcn > 1e-9);
  const bad = r.rows.filter((x) => !x.readable);
  const money = (n) => Number(n || 0).toLocaleString('en-US',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const row = (x) =>
    `<tr><td style="font-family:ui-monospace,monospace;font-size:11px">${esc(x.address)}</td>`
    + `<td style="text-align:right">${money(x.received_pcn)}</td>`
    + `<td style="text-align:right">${money(x.refunded_pcn)}</td>`
    + `<td style="text-align:right">${money(x.wpcn_issued)}</td>`
    + `<td style="text-align:right">${money(x.backing_pcn)}</td>`
    + `<td style="text-align:right;font-weight:700">${money(x.held_pcn)}</td></tr>`;
  const table = !open.length ? '' :
    `<table style="width:100%;border-collapse:collapse;font-size:12px;margin-top:10px">`
    + `<tr class="muted"><th style="text-align:left">deposit address</th>`
    + `<th style="text-align:right">received</th><th style="text-align:right">refunded</th>`
    + `<th style="text-align:right">wPCN out</th><th style="text-align:right">backing</th>`
    + `<th style="text-align:right">HELD</th></tr>`
    + open.map(row).join('') + `</table>`;
  return card('Every deposit address, netted',
    `<p><b>${esc(String(r.square))} of ${esc(String(r.addresses))}</b> addresses are square `
    + `&mdash; received, refunded and backing all cancel out.</p>`
    + (open.length
        ? `<p><b>${money(r.total_held_pcn)} PCN</b> is held beyond backing and refunds, `
          + `across ${esc(String(open.length))} address(es). That is PCN nobody was `
          + `entitled to wrap: refund it, or wrap it if there is allocation headroom.</p>`
          + table
        : `<p>Nothing is held beyond backing and refunds.</p>`)
    + (bad.length
        ? note(`${bad.length} address(es) could not be read, so they are counted in `
             + `neither column. Unreadable is not settled.`)
        : '')
    + note('HELD = received &minus; refunded &minus; (wPCN issued / 0.95). Read that column, '
         + 'never `received`: on 2026-09-22 comparing gross receipts against the cap '
         + 'reported 2,000 PCN owed when the true figure was 250, because refunds already '
         + 'paid were never subtracted. This sum is computed live from the chain on every '
         + 'page load so it cannot go stale.'));
}

export function wrapdeskPage(st, flash, work) {
  const pill = (txt, colour) =>
    `<span style="display:inline-block;padding:4px 12px;border-radius:999px;` +
    `font-weight:700;font-size:12px;letter-spacing:.5px;` +
    `background:var(--${colour});color:#0b1020">${esc(txt)}</span>`;

  let statusPill, button, explain;
  if (st.open === null) {
    statusPill = pill('UNKNOWN', 'yellow');
    button = '';
    explain = 'The switch file could not be read, so the real state is unknown. '
      + 'No button is offered rather than one that might do the opposite of what '
      + 'it says. ' + (st.error ? esc(st.error) : '');
  } else if (st.open) {
    statusPill = pill('OPEN', 'green');
    button = '<form method="post" style="display:inline">'
      + '<input type="hidden" name="action" value="close">'
      + '<button style="background:var(--red);color:#0b1020;border:0;border-radius:999px;'
      + 'padding:8px 20px;cursor:pointer;font-weight:700">Close the desk</button></form>';
    explain = 'New wrap requests are being accepted.';
  } else {
    statusPill = pill('CLOSED', 'red');
    button = '<form method="post" style="display:inline">'
      + '<input type="hidden" name="action" value="open">'
      + '<button style="background:var(--green);color:#0b1020;border:0;border-radius:999px;'
      + 'padding:8px 20px;cursor:pointer;font-weight:700">Reopen the desk</button></form>';
    explain = 'New wrap requests are refused with HTTP 503 and an explanation. '
      + 'Wraps already in flight are unaffected.';
    if (st.stuck && st.stuck.length) {
      button = '';
      explain += ' <b>Reopening is not offered here</b>, because the desk is also held '
        + 'closed by ' + st.stuck.map((p) => `<code>${esc(p)}</code>`).join(', ')
        + ', which this panel cannot delete. Remove it on the host first. A button that '
        + 'reported success and left the desk closed would be worse than no button.';
    }
  }

  const w = work || { ok: false, why: 'not collected' };
  const nSend = w.ok ? w.items.filter((i) => i.kind === 'send').length : null;
  const nHeld = w.ok ? w.items.filter((i) => i.kind === 'withheld').length : null;
  const nRefund = w.ok
    ? w.items.filter((i) => i.kind === 'withheld' && i.why === 'cap').length : null;
  const nWait = w.ok ? w.items.filter((i) => i.kind === 'waiting').length : null;

  return '<h1>Wrap desk</h1>'
    + '<p class="muted">Everything the desk is doing: what is waiting on you, what is '
      + 'still confirming, how much of the allocation is gone, and whether intake is open.</p>'
    + (flash ? `<div class="card" style="border-left:4px solid var(--blue)"><p>${esc(flash)}</p></div>` : '')
    + tiles([
        ['Intake', st.open === null ? 'unknown' : (st.open ? 'open' : 'closed'),
         st.open === null ? 'yellow' : (st.open ? 'green' : 'red')],
        ['To send', nSend === null ? '?' : String(nSend), nSend ? 'green' : 'muted'],
        ['Blocked', nHeld === null ? '?' : String(nHeld), nHeld ? 'yellow' : 'muted'],
        ['PCN to refund', nRefund === null ? '?' : String(nRefund), nRefund ? 'red' : 'muted'],
        ['Confirming', nWait === null ? '?' : String(nWait), 'blue'],
        ['Allocation left', w.ok && w.allocation ? w.allocation.left.toFixed(0) + ' wPCN' : '?',
         w.ok && w.allocation && w.allocation.left < 300 ? 'yellow' : 'muted'],
      ])
    + workCard(w)
    + allocationCard(w)
    + reconcileCard()
    + card('Switch',
        '<div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">'
        + button + statusPill + '</div>'
        + '<p class="muted" style="margin-top:10px">' + explain + '</p>'
        + '<p class="muted">Takes effect on the next request &mdash; the desk reads this '
        + 'per request, so there is no restart and nobody mid-request is interrupted.</p>'
        + '<p class="muted">This page writes <code>' + esc(CLOSED_FILE) + '</code>. The desk '
        + 'is closed if that file <b>or</b> any older flag exists, so a flag created by hand '
        + 'from an out-of-date runbook still shuts the desk.</p>')
    + (st.note
        ? card('Why it was closed',
            `<pre style="white-space:pre-wrap;background:var(--panel-2);padding:12px;`
            + `border-radius:4px;font-size:12px">${esc(st.note)}</pre>`)
        : '')
    + card('What closing does, and does not do',
        '<p><b>It stops new wrap requests.</b> That is all it stops.</p>'
        + note('Wraps already in flight keep counting confirmations and are still paid. '
             + 'Closing the door and repudiating a debt are different acts, and only the '
             + 'first one has ever been announced. If you reopen this, reopen it because '
             + 'the allocation and the PancakeSwap depth can carry it &mdash; the closure '
             + 'on 2026-09-13 was because they could not.'));
}
