// ═══════════════════════════════════════════════════════════════════════════
// SEND PCN FROM market-hot -- the owner's own payout button.
// ═══════════════════════════════════════════════════════════════════════════
//
// Asked for on 2026-09-24: "in the admin there should be a sending function
// from my market hot, so I input the address and amount and send" (first use:
// the 500 PCN independent-pool bounty). market-hot lives on the market host;
// this page asks that host to send, through contrib/market/ops-send.mjs.
//
// TWO STEPS, ON PURPOSE. Step one shows the WHOLE address and the amount back to
// the owner and asks nothing secret. Only step two takes his authenticator code,
// and only a correct, unused code sends. So a mistyped address is seen in full
// before anything can move, and a code cannot be replayed for a second send.
//
// WHAT THIS HOST HOLDS: a send token, in upstream.json beside the read and
// refund tokens. There is NO amount cap on these manual sends: the owner removed
// it on 2026-09-24 ("capping transactions is ok for market only ... i wanna send
// manually there should not be cap"). The market host can still enforce one
// (sendMaxPcn / sendDayMaxPcn in its config), but none is set. His authenticator
// code, good once, is the gate.
//
// NOTHING IS GUESSED. An answer that never came back is recorded and shown as
// "unknown -- check before retrying", never as failed, because the send may
// have gone out (CLAUDE.md 7.1). The same key is reused on a retry, and the
// market refuses to pay a key twice.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { esc } from './ui.mjs';

const ADDRESS = /^pc1[02-9ac-hj-np-z]{20,87}$/;
const KEY = /^send:[0-9a-z]{6,20}-[0-9a-f]{12}$/;

export const newKey = () => `send:${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`;

// A code is good once. checkTotp accepts a code for its whole window, so without
// this the same six digits could approve a second send inside 30-90 seconds.
const usedCodes = new Map();
export function codeOnce(code, verify, now = Date.now()) {
  for (const [c, at] of usedCodes) if (now - at > 5 * 60000) usedCodes.delete(c);
  const c = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(c) || usedCodes.has(c)) return false;
  if (!verify(c)) return false;
  usedCodes.set(c, now);
  return true;
}

export function readLog(path) {
  try { const j = JSON.parse(readFileSync(path, 'utf8')); return Array.isArray(j) ? j : []; }
  catch (e) { if (e && e.code === 'ENOENT') return []; return [{ at: new Date().toISOString(), result: 'log-unreadable', error: e.message }]; }
}
// Exported for the exchange page's "Pay from market-hot": its sends belong in
// the same history as the ones made on this page.
export function appendLog(path, entry) {
  const log = readLog(path).filter((x) => x.result !== 'log-unreadable');
  log.unshift(entry);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(log.slice(0, 500), null, 1));
  renameSync(tmp, path);
}

/** Validate the fields of either step. Returns { ok, to, pcn, note, key } or { ok: false, why }. */
export function parseSend(form) {
  const key = String(form.get('key') || '');
  const to = String(form.get('to') || '').trim().toLowerCase();
  const pcnRaw = String(form.get('pcn') || '').trim().replace(',', '.');
  const note = String(form.get('note') || '').replace(/[^\x20-\x7e]/g, '').trim().slice(0, 80);
  if (!KEY.test(key)) return { ok: false, why: 'The form is out of date; reload the page and start again. Nothing was sent.' };
  if (!ADDRESS.test(to)) return { ok: false, why: `"${to}" is not a PCoin address (pc1...). Nothing was sent.` };
  if (!/^\d+(\.\d{1,8})?$/.test(pcnRaw) || !(Number(pcnRaw) > 0)) return { ok: false, why: `"${pcnRaw}" is not an amount of PCN. Nothing was sent.` };
  return { ok: true, key, to, pcn: Number(pcnRaw), note };
}

/** Step two: the code was checked by the caller. Ask the market host to send. */
export async function marketSend(creds, s) {
  const m = (creds && creds.market) || {};
  if (!m.sendToken) return { ok: false, state: 'off', out: 'No market sendToken is configured in upstream.json, so sending is switched off. Nothing was sent.' };
  const url = m.sendUrl || 'https://market.pc.am/api/ops/send-pcn';
  // fetch, not a synchronous curl: a send can take a while, and blocking the
  // event loop would freeze every other page of the panel until it returned.
  let body;
  try {
    const res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(120000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${m.sendToken}` },
      body: JSON.stringify({ key: s.key, to: s.to, pcn: s.pcn, note: s.note }) });
    body = await res.text();
  } catch (e) {
    return { ok: false, state: 'unknown', out: `The call to the market host did not complete (${e.message}). It may or may not have sent -- press Send again: the same key cannot pay twice.` };
  }
  let r; try { r = JSON.parse(body); } catch { r = null; }
  if (r && r.ok === true) return { ok: true, state: r.already ? 'already' : 'sent', txid: r.txid, sentToday: r.sentToday };
  const err = (r && r.error) || `the market host answered something unreadable: ${String(body).slice(0, 200)}`;
  return { ok: false, state: /answer was lost|BEFORE trying again/.test(err) ? 'unknown' : 'refused', out: err };
}

export async function sendAction(form, { verifyCode, creds, logPath }) {
  const s = parseSend(form);
  const step = String(form.get('step') || '');
  if (!s.ok) return { view: 'form', flash: s.why, bad: true };
  if (step === 'preview') return { view: 'confirm', s };
  if (step !== 'send') return { view: 'form', flash: 'Unknown step; nothing was sent.', bad: true };
  if (!codeOnce(form.get('code'), verifyCode)) {
    return { view: 'confirm', s, flash: 'That authenticator code was not right, or was already used. Nothing was sent.', bad: true };
  }
  const r = await marketSend(creds, s);
  const entry = { at: new Date().toISOString(), key: s.key, to: s.to, pcn: s.pcn, note: s.note,
    result: r.ok ? r.state : r.state, txid: r.txid || null, error: r.ok ? null : r.out };
  try { appendLog(logPath, entry); } catch (e) { entry.logError = e.message; }
  if (r.ok) {
    return { view: 'form', flash: (r.state === 'already' ? 'Already sent earlier under this key -- nothing new went out. ' : 'SENT. ')
      + `${s.pcn} PCN to ${s.to}, transaction ${r.txid}.` + (entry.logError ? ` (Not written to the log: ${entry.logError})` : ''), txid: r.txid };
  }
  return { view: r.state === 'unknown' ? 'confirm' : 'form', s, flash: (r.state === 'unknown' ? 'UNKNOWN: ' : 'NOT sent: ') + r.out, bad: true };
}

/** market-hot's balance from the market's read-only summary. Unknown is not zero. */
export async function hotBalance(creds) {
  const m = (creds && creds.market) || {};
  if (!m.readToken) return { hotPcn: null, hotError: 'no market read token configured' };
  try {
    const r = await fetch('https://market.pc.am/api/ops/summary', {
      headers: { authorization: `Bearer ${m.readToken}` }, signal: AbortSignal.timeout(10000) });
    const j = await r.json();
    const v = j && j.float ? j.float.hotWalletPcn : undefined;
    return Number.isFinite(Number(v)) && v !== null ? { hotPcn: Number(v), hotError: null }
      : { hotPcn: null, hotError: (j && j.floatError) || 'the summary carried no balance' };
  } catch (e) { return { hotPcn: null, hotError: e.message }; }
}

const hidden = (k, v) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`;

const fmt = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 8 });

/** PCN sent from this page in the last 24 h, from its own log. Shown for
 *  information only: manual sends have NO cap (owner, 2026-09-24). */
export function sentLast24h(log, now = Date.now()) {
  return log.filter((x) => x.result === 'sent' && now - Date.parse(x.at) < 86400000)
    .reduce((s, x) => s + (Number(x.pcn) || 0), 0);
}

/** Said BEFORE the code is asked for: an amount market-hot cannot cover. */
export function sendProblems(pcn, hotPcn) {
  return hotPcn !== null && pcn > hotPcn
    ? [`market-hot holds only ${fmt(hotPcn)} PCN, less than ${fmt(pcn)} PCN, so the market host will refuse this.`]
    : [];
}

export function sendPage({ base, result = null, hotPcn = null, hotError = null, log = [] }) {
  const flash = result && result.flash
    ? `<div class="card"><p class="${result.bad ? 'bad' : 'good'}">${esc(result.flash)}</p>`
      + (result.txid ? `<p><a href="https://explorer.pc.am/tx/${esc(result.txid)}" target="_blank" rel="noopener">View the transaction on the explorer</a></p>` : '')
      + '</div>'
    : '';
  // THE BALANCE IS THE FIRST THING ON THE PAGE, large (owner, 2026-09-24: "here I
  // should see market hot balance so I know if there is enough PCN to send").
  const bal = hotPcn !== null
    ? `<div style="display:flex;gap:32px;flex-wrap:wrap;margin:6px 0 10px">
        <div><div class="muted">market-hot balance -- the most you can send</div><div style="font-size:30px;font-weight:700">${esc(fmt(hotPcn))} PCN</div></div>
        <div><div class="muted">sent from this page in the last 24 h</div><div style="font-size:30px;font-weight:700">${esc(fmt(sentLast24h(log)))} PCN</div></div>
      </div>`
    : `<p class="bad">market-hot's balance could not be read (${esc(hotError || 'unknown')}). Sending still works; the market host checks the balance itself.</p>`;
  const intro = `<div class="card"><h2>Send PCN from market-hot</h2>${bal}
    <p class="muted">For payouts you decide -- a bounty, a refund by hand, an exchange withdrawal, a transfer to another wallet of yours.
    Two steps: check the address and amount, then confirm with your authenticator code. There is no amount limit on
    these manual sends (the market's automatic deliveries keep their own). A form is never paid twice, and every
    send is posted to the ops channel.</p></div>`;

  let body;
  if (result && result.view === 'confirm' && result.s) {
    const s = result.s;
    body = `<div class="card"><h2>Confirm</h2>
      <table><tr><td>Send</td><td><b>${esc(s.pcn)} PCN</b></td></tr>
      <tr><td>To</td><td><code style="font-size:15px">${esc(s.to)}</code><br><span class="muted">ends in <b>${esc(s.to.slice(-4))}</b> -- check every character</span></td></tr>
      ${s.note ? `<tr><td>Note</td><td>${esc(s.note)}</td></tr>` : ''}
      <tr><td>From</td><td>market-hot</td></tr></table>
      ${sendProblems(s.pcn, hotPcn).map((p) => `<p class="bad">${esc(p)}</p>`).join('')}
      <form method="post" action="${esc(base)}/send" style="margin-top:12px">
        ${hidden('step', 'send')}${hidden('key', s.key)}${hidden('to', s.to)}${hidden('pcn', String(s.pcn))}${hidden('note', s.note)}
        <label>Authenticator code <input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required style="width:110px"></label>
        <button type="submit" class="danger">Send ${esc(s.pcn)} PCN</button>
        <a href="${esc(base)}/send" style="margin-left:12px">Cancel</a>
      </form></div>`;
  } else {
    body = `<div class="card"><h2>New send</h2>
      <form method="post" action="${esc(base)}/send">
        ${hidden('step', 'preview')}${hidden('key', newKey())}
        <p><label>To (pc1...)<br><input name="to" required spellcheck="false" autocomplete="off" style="width:100%;max-width:520px;font-family:monospace"></label></p>
        <p><label>Amount in PCN<br><input name="pcn" required inputmode="decimal" autocomplete="off" style="width:180px"></label></p>
        <p><label>Note (optional, e.g. "AionCore pool bounty")<br><input name="note" maxlength="80" autocomplete="off" style="width:100%;max-width:520px"></label></p>
        <button type="submit">Check</button>
      </form></div>`;
  }

  const rows = log.slice(0, 20).map((x) => `<tr><td>${esc(String(x.at || '').replace('T', ' ').slice(0, 16))}</td>
    <td>${esc(x.pcn ?? '')}</td><td><code>${esc(String(x.to || '').slice(0, 10))}...${esc(String(x.to || '').slice(-6))}</code></td>
    <td>${esc(x.note || '')}</td><td>${esc(x.result || '')}</td>
    <td>${x.txid ? `<a href="https://explorer.pc.am/tx/${esc(x.txid)}" target="_blank" rel="noopener">${esc(x.txid.slice(0, 10))}...</a>` : esc((x.error || '').slice(0, 80))}</td></tr>`).join('');
  const history = `<div class="card"><h2>Sends from this page</h2>${rows
    ? `<table><tr><th>when (UTC)</th><th>PCN</th><th>to</th><th>note</th><th>result</th><th>transaction</th></tr>${rows}</table>`
    : '<p class="muted">None yet.</p>'}</div>`;
  return flash + intro + body + history;
}
