// /pcnaibot — @PcoinAiBot's users, and crediting a balance (2026-09-24).
//
// The bot owns its database; this page reads it and writes to it only through
// the bot's own loopback admin API (contrib/pcnaibot/lib/admin-api.mjs), which
// records every credit as a ledger row so the bot's reconciliation still
// closes. upstream.json: "pcnaibot": { "url": "http://127.0.0.1:8797", "token": … }.
//
// A credit creates money the bot will spend at our cost, so it takes the
// authenticator code, once (codeOnce, shared with Send PCN). Each render mints
// a request id, so a double-submitted form credits once.
import { randomBytes } from 'node:crypto';
import { esc, card, note, tbl, tiles, failed, DASH } from './ui.mjs';
import { codeOnce } from './send.mjs';

const usd = (micro, dp = 2) => (typeof micro === 'number' && isFinite(micro))
  ? '$' + (micro / 1e6).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp }) : DASH;
const at = (s) => s ? esc(new Date(s * 1000).toISOString().replace('T', ' ').slice(0, 16)) : DASH;

async function call(creds, path, body = null) {
  const c = (creds && creds.pcnaibot) || {};
  if (!c.url || !c.token) return { ok: false, error: 'no "pcnaibot" url/token in upstream.json' };
  try {
    const res = await fetch(c.url + path, {
      method: body ? 'POST' : 'GET',
      signal: AbortSignal.timeout(15000),
      headers: { authorization: `Bearer ${c.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await res.json().catch(() => null);
    if (!j) return { ok: false, error: `unreadable reply (HTTP ${res.status})` };
    if (!res.ok) return { ok: false, error: j.error || `HTTP ${res.status}` };
    return { ok: true, data: j };
  } catch (e) {
    return { ok: false, error: e.name === 'TimeoutError' ? 'the bot did not answer in 15 s' : e.message };
  }
}

export async function pcnaibotAction(form, { verifyCode, creds }) {
  const chatId = String(form.get('chat_id') || '').trim();
  const raw = String(form.get('usd') || '').trim().replace(',', '.');
  const noteText = String(form.get('note') || '').trim().slice(0, 200);
  if (!/^-?\d+$/.test(chatId)) return { bad: true, flash: 'Pick a user.' };
  if (!/^\d+(\.\d{1,2})?$/.test(raw) || !(Number(raw) > 0)) return { bad: true, flash: 'Amount must be a positive number of dollars, at most 2 decimals.' };
  if (Number(raw) > 1000) return { bad: true, flash: 'One credit is at most $1,000. Do it in parts if you mean more.' };
  if (!noteText) return { bad: true, flash: 'Say what the credit is for.' };
  if (!codeOnce(form.get('code'), verifyCode)) return { bad: true, flash: 'Wrong or reused authenticator code. Nothing was credited.' };
  const [whole, frac = ''] = raw.split('.');
  const micro = String(BigInt(whole) * 1000000n + BigInt((frac + '000000').slice(0, 6)));
  const r = await call(creds, '/admin/credit', {
    chat_id: Number(chatId), micro_usd: micro, note: noteText, request_id: String(form.get('request_id') || ''),
  });
  if (!r.ok) return { bad: true, flash: `Not credited: ${r.error}.` };
  const d = r.data;
  return d.duplicate
    ? { flash: `That form was already submitted; nothing more was credited. Balance of ${d.chatId} is ${usd(d.balance, 4)}.` }
    : { flash: `Credited ${usd(d.microUsd)} to ${d.chatId}. Their balance is now ${usd(d.balance, 4)}.` };
}

export async function pcnaibotPage({ base, creds, result = null, chat = null }) {
  const flash = result && result.flash
    ? `<div class="card" style="border-left:3px solid ${result.bad ? 'var(--red)' : 'var(--green)'}"><p class="${result.bad ? 'bad' : 'ok'}">${esc(result.flash)}</p></div>` : '';
  const r = await call(creds, '/admin/users');
  if (!r.ok) return flash + failed('@PcoinAiBot users', r.error);
  const users = r.data.users || [];
  const sum = (k) => users.reduce((s, u) => s + (u[k] || 0), 0);
  const label = (u) => u.name ? `${esc(u.name)} <span class="muted">${esc(u.chat_id)}</span>` : `<code>${esc(u.chat_id)}</code>`;

  const rows = users.map((u) => [
    label(u),
    `<b>${usd(u.balance_micro_usd, 4)}</b>` + (u.reserved_micro_usd ? ` <span class="muted">(+${usd(u.reserved_micro_usd, 4)} in flight)</span>` : ''),
    usd(u.spent_micro_usd, 4), usd(u.deposited_micro_usd), usd(u.credited_micro_usd),
    esc(u.turns), at(u.last_turn_at), at(u.created_at),
    `<code>${esc(u.model)}</code>${u.agent_mode ? ' <span class="muted">agent</span>' : ''}`,
    `<a href="${base}/pcnaibot?chat=${encodeURIComponent(u.chat_id)}">history</a>`,
  ]);

  let history = '';
  if (chat !== null) {
    const h = await call(creds, `/admin/ledger?chat_id=${encodeURIComponent(chat)}`);
    const who = users.find((u) => String(u.chat_id) === String(chat));
    history = h.ok
      ? card(`History — ${who && who.name ? who.name : chat}`, tbl(['When (UTC)', 'Kind', 'Amount', 'Note'],
          (h.data.ledger || []).map((l) => [at(l.created_at), esc(l.kind),
            `<span class="${l.delta_micro_usd < 0 ? 'bad' : 'ok'}">${l.delta_micro_usd < 0 ? '−' : '+'}${usd(Math.abs(l.delta_micro_usd), 4)}</span>`,
            esc(l.note || '')]), 'No ledger rows yet.'))
      : failed('that user\'s history', h.error);
  }

  const options = users.map((u) => `<option value="${esc(u.chat_id)}"${String(u.chat_id) === String(chat) ? ' selected' : ''}>`
    + `${esc(u.name || u.chat_id)} — ${esc(u.chat_id)} (${usd(u.balance_micro_usd)})</option>`).join('');

  return flash
    + tiles([
      ['Users', esc(users.length)],
      ['Balances held', usd(sum('balance_micro_usd'))],
      ['Spent, all time', usd(sum('spent_micro_usd'))],
      ['Deposited, all time', usd(sum('deposited_micro_usd'))],
      ['Credited by hand', usd(sum('credited_micro_usd'))],
    ])
    + card('Credit a balance', users.length ? `
      <form method="POST" action="${base}/pcnaibot" class="inline" autocomplete="off">
        <input type="hidden" name="request_id" value="${randomBytes(12).toString('hex')}">
        <select name="chat_id" required><option value="">user…</option>${options}</select>
        <label class="muted">$ <input name="usd" type="text" inputmode="decimal" placeholder="100" style="width:7em" required></label>
        <input name="note" type="text" placeholder="what it is for" maxlength="200" required>
        <input name="code" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="authenticator" style="width:9em" required>
        <button type="submit">Credit</button>
      </form>` + note('Adds to the user\'s balance as an <code>adjust</code> ledger row, marked as an owner credit and not a deposit. '
        + 'They can spend it on any paid model at once. At most $1,000 per credit. A user appears here after they first message the bot.')
      : note('No users yet. A user appears here after they first message the bot.'))
    + history
    + card('Users', tbl(['User', 'Balance', 'Spent', 'Deposited', 'Credited', 'Turns', 'Last turn (UTC)', 'Joined (UTC)', 'Model', ''],
        rows, 'No users yet.'));
}
