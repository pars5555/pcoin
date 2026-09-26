// /pcnaibot — @PcoinAiBot's users, crediting a balance (2026-09-24), and the studio's models (2026-09-26).
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

async function call(creds, path, body = null, timeoutMs = 15000) {
  const c = (creds && creds.pcnaibot) || {};
  if (!c.url || !c.token) return { ok: false, error: 'no "pcnaibot" url/token in upstream.json' };
  try {
    const res = await fetch(c.url + path, {
      method: body ? 'POST' : 'GET',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { authorization: `Bearer ${c.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await res.json().catch(() => null);
    if (!j) return { ok: false, error: `unreadable reply (HTTP ${res.status})` };
    if (!res.ok) return { ok: false, error: j.error || `HTTP ${res.status}` };
    return { ok: true, data: j };
  } catch (e) {
    return { ok: false, error: e.name === 'TimeoutError' ? `the bot did not answer in ${timeoutMs / 1000} s` : e.message };
  }
}

// The studio's models (2026-09-26: the bot became a picture & video studio; the admin chooses the
// chat, picture and video models, never the user). Not money-creating, so no authenticator code:
// the page is IP-locked, and the bot itself refuses a model OonaCode does not serve and tests a new
// chat model live before accepting it.
async function settingsAction(form, { creds }) {
  const body = {
    chatModel: String(form.get('chatModel') || ''),
    pictureModel: String(form.get('pictureModel') || ''),
    videoModel: String(form.get('videoModel') || ''),
    videoSeconds: Number(form.get('videoSeconds') || 0),
    videoResolution: String(form.get('videoResolution') || ''),
  };
  // A new chat model is tested live by the bot (5-10 s), hence the longer wait.
  const r = await call(creds, '/admin/settings', body, 45000);
  if (!r.ok) return { bad: true, flash: `Not saved: ${r.error}.` };
  const s = r.data.settings;
  return { flash: `Saved. Chat ${s.chatModel}; pictures ${s.pictureModel}; video ${s.videoModel}, ${s.videoSeconds} s at ${s.videoResolution}.` };
}

export async function pcnaibotAction(form, { verifyCode, creds }) {
  if (String(form.get('form') || '') === 'settings') return settingsAction(form, { creds });
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
    `<a href="${base}/pcnaibot?chat=${encodeURIComponent(u.chat_id)}">history</a>`,
  ]);

  // The studio's models.
  const st = await call(creds, '/admin/settings');
  let models;
  if (!st.ok) {
    models = failed('the studio settings', st.error);
  } else {
    const { settings: s, choices: c, chatHealth: h } = st.data;
    const opt = (v, cur, text) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(text)}</option>`;
    const vid = (c.video || []).find((v) => v.id === s.videoModel) || (c.video || [])[0] || null;
    const health = h && h.model === s.chatModel
      ? (h.ok === true ? '<span class="ok">answers with a tool call</span>'
        : h.ok === false ? `<span class="bad">FAILING: ${esc(h.why || '')}</span>` : `<span class="muted">unchecked: ${esc(h.why || '')}</span>`)
      : '<span class="muted">not checked yet</span>';
    models = card('Studio models', `
      <form method="POST" action="${base}/pcnaibot" autocomplete="off">
        <input type="hidden" name="form" value="settings">
        <p><label>Chat agent (free for users) <select name="chatModel">${(c.chat || []).map((m) => opt(m, s.chatModel, m)).join('')}</select></label> ${health}</p>
        <p><label>Pictures <select name="pictureModel">${(c.picture || []).map((m) => opt(m.id, s.pictureModel, `${m.id} — ${m.label} — ${m.price} a picture`)).join('')}</select></label></p>
        <p><label>Video <select name="videoModel">${(c.video || []).map((m) => opt(m.id, s.videoModel, `${m.id} — ${m.label}${m.fromPhoto ? '' : ' (no photo-to-video now)'}`)).join('')}</select></label>
          <label>length <input name="videoSeconds" type="number" min="${vid ? esc(vid.durations.min) : 1}" max="${vid ? esc(vid.durations.max) : 15}" value="${esc(s.videoSeconds)}" style="width:5em"> s</label>
          <label>at <select name="videoResolution">${(vid ? vid.resolutions : []).map((r) => opt(r.id, s.videoResolution, `${r.id} — ${r.perSecond}/s`)).join('')}</select></label></p>
        <p class="muted">Video editing: ${c.videoEdit && c.videoEdit.length ? '' : 'no video-edit model is served by OonaCode yet, so "change this video" makes a new version.'}</p>
        <button type="submit">Save models</button>
      </form>`
      + note('Prices include the bot\'s margin and come from OonaCode\'s live list. Users are charged only when they press ✅ on a card, '
        + 'never more than the card\'s price. The chat is free to users; a new chat model is tested live before it is accepted.'
        + (c.listingFresh ? '' : ' <b>OonaCode\'s model list is stale right now — nothing is on sale until it refreshes.</b>')));
  }

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
    + models
    + card('Credit a balance', users.length ? `
      <form method="POST" action="${base}/pcnaibot" class="inline" autocomplete="off">
        <input type="hidden" name="request_id" value="${randomBytes(12).toString('hex')}">
        <select name="chat_id" required><option value="">user…</option>${options}</select>
        <label class="muted">$ <input name="usd" type="text" inputmode="decimal" placeholder="100" style="width:7em" required></label>
        <input name="note" type="text" placeholder="what it is for" maxlength="200" required>
        <input name="code" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="authenticator" style="width:9em" required>
        <button type="submit">Credit</button>
      </form>` + note('Adds to the user\'s balance as an <code>adjust</code> ledger row, marked as an owner credit and not a deposit. '
        + 'They can spend it on pictures and videos at once. At most $1,000 per credit. A user appears here after they first message the bot.')
      : note('No users yet. A user appears here after they first message the bot.'))
    + history
    + card('Users', tbl(['User', 'Balance', 'Spent', 'Deposited', 'Credited', 'Paid items', 'Last paid (UTC)', 'Joined (UTC)', ''],
        rows, 'No users yet.'));
}
