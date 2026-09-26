// /pcnaibot — @PcoinAiBot, the picture & video studio: its users and money, and every setting of
// its chat agent, its builder and its payments (owner, 2026-09-26: "separate subsections for the
// chat agent prompt and every configuration ... similar to webcrafter ... everything in admin").
//
//   /pcnaibot           Overview & users   — totals, credit a balance, a user's history
//   /pcnaibot/chat      Chat agent         — model (tested live), instructions, limits, preview
//   /pcnaibot/studio    Pictures & video   — models, video length/resolution, margin, cards, jobs
//   /pcnaibot/payments  Payments & Stars   — Stars packages, Telegram's books, refunds, support text
//
// The bot owns its database; this page reads and writes it only through the bot's own loopback
// admin API (contrib/pcnaibot/lib/admin-api.mjs). upstream.json:
// "pcnaibot": { "url": "http://127.0.0.1:8797", "token": … }.
//
// MONEY TAKES THE AUTHENTICATOR CODE, once (codeOnce, shared with Send PCN): a credit creates money
// the bot will spend at our cost; a refund gives Stars back. Settings do not move money, and the
// bot itself refuses a model OonaCode does not serve and tests a new chat model before accepting it.
import { randomBytes } from 'node:crypto';
import { esc, card, note, tbl, tiles, failed, DASH } from './ui.mjs';
import { codeOnce } from './send.mjs';

const usd = (micro, dp = 2) => (typeof micro === 'number' && isFinite(micro))
  ? '$' + (micro / 1e6).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp }) : DASH;
const at = (s) => s ? esc(new Date(s * 1000).toISOString().replace('T', ' ').slice(0, 16)) : DASH;
const opt = (v, cur, text) => `<option value="${esc(v)}"${String(v) === String(cur) ? ' selected' : ''}>${esc(text)}</option>`;

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

// The sub-pages, as tabs across the top of each (the sidebar lists them too).
export const PCNAIBOT_SECTIONS = [
  ['', 'Overview & users'], ['chat', 'Chat agent'], ['studio', 'Pictures & video'], ['payments', 'Payments & Stars'],
];
const tabsBar = (base, section) => `<div class="xtabs sub" style="margin-bottom:12px">${PCNAIBOT_SECTIONS.map(([slug, label]) =>
  `<a href="${base}/pcnaibot${slug ? '/' + slug : ''}" style="margin-right:14px;${slug === section ? 'font-weight:600' : ''}">${esc(label)}</a>`).join('')}</div>`;

const flashOf = (result) => (result && result.flash
  ? `<div class="card" style="border-left:3px solid ${result.bad ? 'var(--red)' : 'var(--green)'}"><p class="${result.bad ? 'bad' : 'ok'}">${esc(result.flash)}</p></div>` : '');

// ---- actions --------------------------------------------------------------------------------

async function saveSettings(creds, body, what) {
  // A new chat model is tested live by the bot (5-20 s), hence the longer wait.
  const r = await call(creds, '/admin/settings', body, 60000);
  if (!r.ok) return { bad: true, flash: `${what} not saved: ${r.error}.` };
  return { flash: `${what} saved.` };
}

export async function pcnaibotAction(form, { verifyCode, creds }) {
  const kind = String(form.get('form') || 'credit');
  const g = (k) => String(form.get(k) ?? '');

  if (kind === 'chat') {
    const body = {
      chatModel: g('chatModel'), chatPerHour: g('chatPerHour'), chatDailyBudget: g('chatDailyBudget'),
      chatMaxChars: g('chatMaxChars'), historyMax: g('historyMax'),
    };
    // The instructions travel only with their own form; the model form leaves them alone.
    if (form.get('resetPrompt')) body.chatPromptReset = true;
    else if (form.has('chatPrompt')) body.chatPrompt = g('chatPrompt').replace(/\r\n/g, '\n');
    return saveSettings(creds, body, form.get('resetPrompt') ? 'The instructions were reset to the built-in ones and the chat settings' : 'Chat agent settings');
  }
  if (kind === 'studio') {
    return saveSettings(creds, {
      pictureModel: g('pictureModel'), videoModel: g('videoModel'), videoSeconds: g('videoSeconds'),
      videoResolution: g('videoResolution'), margin: g('margin'), cardTtlHours: g('cardTtlHours'),
    }, 'Pictures & video settings');
  }
  if (kind === 'payments') {
    const pk = [];
    for (let i = 0; i < 8; i++) {
      const u = g(`pkg_usd_${i}`).trim().replace(',', '.'), s = g(`pkg_stars_${i}`).trim();
      if (u === '' && s === '') continue;
      pk.push({ usd: Number(u), stars: Number(s) });
    }
    return saveSettings(creds, { starsEnabled: g('starsEnabled') === 'on', starsPackages: pk, paySupportText: g('paySupportText') }, 'Payment settings');
  }
  if (kind === 'test-chat') {
    const r = await call(creds, '/admin/test-chat', { model: g('model') }, 60000);
    if (!r.ok) return { bad: true, flash: `Test failed: ${r.error}.` };
    return r.data.ok === true ? { flash: `${g('model')} answered with a tool call — it can run the studio.` }
      : { bad: true, flash: `${g('model')} did not propose anything (${r.data.why || 'no tool call'}).` };
  }
  if (kind === 'refund') {
    if (!codeOnce(form.get('code'), verifyCode)) return { bad: true, flash: 'Wrong or reused authenticator code. Nothing was refunded.' };
    const r = await call(creds, '/admin/stars/refund', { payment_id: Number(g('payment_id')), note: g('note').slice(0, 200) }, 30000);
    if (!r.ok) return { bad: true, flash: `Not refunded: ${r.error}.` };
    return { flash: `Refunded ${r.data.stars} ⭐ to ${r.data.chatId}; ${usd(r.data.micro)} was taken off their balance, and they were told.` };
  }

  // A hand credit.
  const chatId = g('chat_id').trim();
  const raw = g('usd').trim().replace(',', '.');
  const noteText = g('note').trim().slice(0, 200);
  if (!/^-?\d+$/.test(chatId)) return { bad: true, flash: 'Pick a user.' };
  if (!/^\d+(\.\d{1,2})?$/.test(raw) || !(Number(raw) > 0)) return { bad: true, flash: 'Amount must be a positive number of dollars, at most 2 decimals.' };
  if (Number(raw) > 1000) return { bad: true, flash: 'One credit is at most $1,000. Do it in parts if you mean more.' };
  if (!noteText) return { bad: true, flash: 'Say what the credit is for.' };
  if (!codeOnce(form.get('code'), verifyCode)) return { bad: true, flash: 'Wrong or reused authenticator code. Nothing was credited.' };
  const [whole, frac = ''] = raw.split('.');
  const micro = String(BigInt(whole) * 1000000n + BigInt((frac + '000000').slice(0, 6)));
  const r = await call(creds, '/admin/credit', {
    chat_id: Number(chatId), micro_usd: micro, note: noteText, request_id: g('request_id'),
  });
  if (!r.ok) return { bad: true, flash: `Not credited: ${r.error}.` };
  const d = r.data;
  return d.duplicate
    ? { flash: `That form was already submitted; nothing more was credited. Balance of ${d.chatId} is ${usd(d.balance, 4)}.` }
    : { flash: `Credited ${usd(d.microUsd)} to ${d.chatId}. Their balance is now ${usd(d.balance, 4)}.` };
}

// ---- pages ----------------------------------------------------------------------------------

export async function pcnaibotPage({ base, creds, result = null, chat = null, section = '', query = null }) {
  const head = flashOf(result) + tabsBar(base, section);
  if (section === 'chat') return head + await chatPage({ base, creds, query });
  if (section === 'studio') return head + await studioPage({ base, creds });
  if (section === 'payments') return head + await paymentsPage({ base, creds });
  return head + await overviewPage({ base, creds, chat });
}

async function overviewPage({ base, creds, chat }) {
  const [r, st] = await Promise.all([call(creds, '/admin/users'), call(creds, '/admin/settings')]);
  if (!r.ok) return failed('@PcoinAiBot users', r.error);
  const users = r.data.users || [];
  const sum = (k) => users.reduce((s, u) => s + (u[k] || 0), 0);
  const label = (u) => u.name ? `${esc(u.name)} <span class="muted">${esc(u.chat_id)}</span>` : `<code>${esc(u.chat_id)}</code>`;
  const x = st.ok ? st.data.stats : null;
  const s = st.ok ? st.data.settings : null;

  const rows = users.map((u) => [
    label(u),
    `<b>${usd(u.balance_micro_usd, 4)}</b>` + (u.reserved_micro_usd ? ` <span class="muted">(+${usd(u.reserved_micro_usd, 4)} being made)</span>` : ''),
    usd(u.spent_micro_usd, 4), usd(u.deposited_micro_usd), usd(u.stars_micro_usd), usd(u.credited_micro_usd),
    esc(u.turns), at(u.last_turn_at), at(u.created_at),
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

  return tiles([
      ['Users', esc(users.length)],
      ['Balances held', usd(sum('balance_micro_usd'))],
      ['Spent, all time', usd(sum('spent_micro_usd'))],
      ['Deposited, all time', usd(sum('deposited_micro_usd'))],
      ['of it by ⭐ Stars', usd(sum('stars_micro_usd'))],
      ['Credited by hand', usd(sum('credited_micro_usd'))],
    ])
    + (x ? tiles([
      ['Pictures, 24 h', esc(x.picturesDay)], ['Videos, 24 h', esc(x.videosDay)], ['Cards, 24 h', esc(x.cardsDay)],
      ['Being made now', esc(x.running)], ['Failed, 24 h', esc(x.failedDay)], ['Spent, 24 h', usd(x.spentDay)],
      ['Free chat today', `${esc(x.chatToday)} / ${esc(s.chatDailyBudget)}`],
    ]) : failed('the studio figures', st.error))
    + card('Credit a balance', users.length ? `
      <form method="POST" action="${base}/pcnaibot" class="inline" autocomplete="off">
        <input type="hidden" name="form" value="credit">
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
    + card('Users', tbl(['User', 'Balance', 'Spent', 'Deposited', '⭐ Stars', 'Credited', 'Paid items', 'Last paid (UTC)', 'Joined (UTC)', ''],
        rows, 'No users yet.'));
}

function healthLine(h, model) {
  if (!h || h.model !== model) return '<span class="muted">not checked yet</span>';
  if (h.ok === true) return `<span class="ok">answers with a tool call</span> <span class="muted">(checked ${at(h.at)} UTC)</span>`;
  if (h.ok === false) return `<span class="bad">FAILING: ${esc(h.why || '')}</span>`;
  return `<span class="muted">unchecked: ${esc(h.why || '')}</span>`;
}

async function chatPage({ base, creds, query }) {
  const [st, us] = await Promise.all([call(creds, '/admin/settings'), call(creds, '/admin/users')]);
  if (!st.ok) return failed('the chat agent settings', st.error);
  const { settings: s, defaults: d, choices: c, chatHealth: h } = st.data;
  const users = us.ok ? us.data.users || [] : [];
  const prompt = s.chatPrompt || d.chatPrompt;

  const pvChat = query && query.get('pv_chat');
  let preview = '';
  if (pvChat && /^-?\d+$/.test(pvChat)) {
    const p = await call(creds, `/admin/preview?chat_id=${encodeURIComponent(pvChat)}&text=${encodeURIComponent(query.get('pv_text') || '')}`);
    preview = p.ok
      ? `<h3>System prompt sent to <code>${esc(p.data.model)}</code></h3><pre style="white-space:pre-wrap;max-height:520px;overflow:auto">${esc(p.data.system)}</pre>`
        + `<h3>Conversation (${esc(p.data.messages.length)} messages, oldest first)</h3>`
        + tbl(['Role', 'Text'], p.data.messages.map((m) => [esc(m.role), `<span style="white-space:pre-wrap">${esc(String(m.content).slice(0, 1500))}</span>`]), 'Empty.')
      : failed('the preview', p.error);
  }

  return card('Model', `
      <form method="POST" action="${base}/pcnaibot/chat" autocomplete="off">
        <input type="hidden" name="form" value="chat">
        <p><label>Chat model (free for users) <select name="chatModel">${(c.chat || []).map((m) => opt(m, s.chatModel, m)).join('')}</select></label>
          ${healthLine(h, s.chatModel)}</p>
        <p><label>Messages per user per hour <input name="chatPerHour" type="number" min="1" max="10000" value="${esc(s.chatPerHour)}" style="width:6em"></label>
          <label>Free chat messages per day, whole bot <input name="chatDailyBudget" type="number" min="0" max="1000000" value="${esc(s.chatDailyBudget)}" style="width:8em"></label></p>
        <p><label>Longest message (characters) <input name="chatMaxChars" type="number" min="100" max="10000" value="${esc(s.chatMaxChars)}" style="width:7em"></label>
          <label>Conversation remembered (messages) <input name="historyMax" type="number" min="2" max="100" value="${esc(s.historyMax)}" style="width:5em"></label></p>
        <button type="submit">Save</button>
      </form>
      <form method="POST" action="${base}/pcnaibot/chat" class="inline" style="margin-top:8px">
        <input type="hidden" name="form" value="test-chat">
        <select name="model">${(c.chat || []).map((m) => opt(m, s.chatModel, m)).join('')}</select>
        <button type="submit">Test a model</button>
      </form>`
    + note('The chat is free to users. After the daily budget, only users with a balance can chat. A new chat model is tested live when you save it '
      + 'and kept only if it proposes a card. "Test a model" asks it once without changing anything.'))
    + card('Instructions (system prompt)', `
      <form method="POST" action="${base}/pcnaibot/chat" autocomplete="off">
        <input type="hidden" name="form" value="chat">
        <input type="hidden" name="chatModel" value="${esc(s.chatModel)}">
        <input type="hidden" name="chatPerHour" value="${esc(s.chatPerHour)}"><input type="hidden" name="chatDailyBudget" value="${esc(s.chatDailyBudget)}">
        <input type="hidden" name="chatMaxChars" value="${esc(s.chatMaxChars)}"><input type="hidden" name="historyMax" value="${esc(s.historyMax)}">
        <textarea name="chatPrompt" rows="26" style="width:100%;font-family:monospace;font-size:12px">${esc(prompt)}</textarea>
        <p><button type="submit">Save instructions</button>
          <button type="submit" name="resetPrompt" value="1" onclick="return confirm('Replace these instructions with the built-in ones?')">Reset to the built-in ones</button>
          <span class="muted">${s.chatPrompt ? 'Custom instructions are in use.' : 'The built-in instructions are in use.'}</span></p>
      </form>`
    + note('After these instructions the bot always adds, for each message: the live prices, the user\'s balance, the user\'s pictures and videos by number, '
      + 'the open card, and the language of the user\'s latest message — so an edit here can never make it quote a stale price. '
      + 'Whatever the instructions say, nothing is charged until the user presses ✅, a card is checked by the bot before it is shown, and the card\'s language is checked too.'))
    + card('Preview — exactly what the model receives', `
      <form method="GET" action="${base}/pcnaibot/chat" class="inline">
        <select name="pv_chat" required><option value="">user…</option>${users.map((u) => opt(u.chat_id, pvChat, `${u.name || u.chat_id} — ${u.chat_id}`)).join('')}</select>
        <input name="pv_text" type="text" placeholder="their next message" value="${esc((query && query.get('pv_text')) || '')}" style="width:22em">
        <button type="submit">Show</button>
      </form>${preview}`
    + note('Built by the same code as a real message, so it is what would be sent right now.'));
}

async function studioPage({ base, creds }) {
  const [st, jb] = await Promise.all([call(creds, '/admin/settings'), call(creds, '/admin/jobs?limit=40')]);
  if (!st.ok) return failed('the studio settings', st.error);
  const { settings: s, defaults: d, choices: c } = st.data;
  const vid = (c.video || []).find((v) => v.id === s.videoModel) || (c.video || [])[0] || null;

  const prices = [
    ...(c.picture || []).map((p) => [`🎨 <b>${esc(p.id)}</b>`, esc(p.label), `${esc(p.price)} a picture`, p.id === s.pictureModel ? '<span class="ok">in use</span>' : '']),
    ...(c.video || []).flatMap((v) => v.resolutions.map((r) => [`🎬 <b>${esc(v.id)}</b>`, `${esc(v.label)} · ${esc(r.id)}${v.fromPhoto ? '' : ' · no photo-to-video now'}`,
      `${esc(r.perSecond)} a second`, v.id === s.videoModel && r.id === s.videoResolution ? '<span class="ok">in use</span>' : ''])),
  ];
  const jobs = jb.ok ? jb.data.jobs : [];

  return card('Models and prices', `
      <form method="POST" action="${base}/pcnaibot/studio" autocomplete="off">
        <input type="hidden" name="form" value="studio">
        <p><label>Pictures <select name="pictureModel">${(c.picture || []).map((m) => opt(m.id, s.pictureModel, `${m.id} — ${m.label} — ${m.price} a picture`)).join('')}</select></label></p>
        <p><label>Video <select name="videoModel">${(c.video || []).map((m) => opt(m.id, s.videoModel, `${m.id} — ${m.label}`)).join('')}</select></label>
          <label>length <input name="videoSeconds" type="number" min="${vid ? esc(vid.durations.min) : 1}" max="${vid ? esc(vid.durations.max) : 15}" value="${esc(s.videoSeconds)}" style="width:5em"> s</label>
          <label>at <select name="videoResolution">${(vid ? vid.resolutions : []).map((r) => opt(r.id, s.videoResolution, `${r.id} — ${r.perSecond}/s`)).join('')}</select></label></p>
        <p><label>Margin (our price = OonaCode's × this) <input name="margin" type="number" step="0.1" min="1" max="20" value="${esc(s.margin)}" style="width:6em"></label>
          <label>A card stays open (hours) <input name="cardTtlHours" type="number" min="1" max="720" value="${esc(s.cardTtlHours)}" style="width:5em"></label></p>
        <p class="muted">Video editing: ${c.videoEdit && c.videoEdit.length ? '' : 'no video-edit model is served by OonaCode yet, so "change this video" makes a new version from the same starting picture.'}</p>
        <button type="submit">Save</button>
      </form>`
    + note(`Prices come from OonaCode's live list × the margin (default ${esc(d.margin)}). A user pays exactly the price on the ✅ button, never more; `
      + 'a changed price shows a new price on the card instead of charging it. Pictures are 2K on wan2.7-image-pro, up to 1536 px on qwen-image-3.0-pro.'
      + (c.listingFresh ? '' : ' <b>OonaCode\'s model list is stale right now — nothing is on sale until it refreshes.</b>')))
    + card('Price list (what users pay)', tbl(['Model', 'What', 'Price', ''], prices, 'Nothing on sale.'))
    + card('Latest cards', jb.ok ? tbl(['Card', 'When (UTC)', 'User', 'What', 'Price', 'Card state', 'Job', 'Result'],
        jobs.map((j) => [`P${esc(j.id)}`, at(j.created_at), `<code>${esc(j.chat_id)}</code>`,
          `${j.kind === 'video' ? '🎬' : '🎨'} ${esc(j.api_model)} ${esc(j.shape)}${j.seconds ? ` ${esc(j.seconds)} s ${esc(j.resolution)}` : ''}<br><span class="muted">${esc(String(j.summary || '').slice(0, 90))}</span>`,
          usd(j.price_micro, 3), esc(j.state), j.job_state ? `${esc(j.job_state)}${j.error ? ` <span class="bad">${esc(String(j.error).slice(0, 80))}</span>` : ''}` : DASH,
          j.item_id ? `#${esc(j.item_id)}` : DASH]), 'No cards yet.') : failed('the latest cards', jb.error));
}

async function paymentsPage({ base, creds }) {
  const [st, sr] = await Promise.all([call(creds, '/admin/settings'), call(creds, '/admin/stars', null, 30000)]);
  if (!st.ok) return failed('the payment settings', st.error);
  const s = st.data.settings;
  const pk = [...(s.starsPackages || [])];
  while (pk.length < 6) pk.push({ usd: '', stars: '' });

  let books = '';
  if (!sr.ok) {
    books = failed('the Stars report', sr.error);
  } else {
    const t = sr.data.telegram, tot = sr.data.totals;
    const ourStars = tot.stars - tot.refunded_stars;
    const theirs = t.ok ? t.incomingStars : null;
    books = tiles([
        ['Stars payments', esc(tot.n)], ['Stars received', `${esc(tot.stars)} ⭐`], ['Credited for them', usd(tot.micro)],
        ['Refunded', `${esc(tot.refunded_stars)} ⭐`],
        ['Bot balance (Telegram)', t.ok ? `${esc(t.balance)} ⭐` : DASH],
        ['Past the 21-day hold', t.ok ? `${esc(t.maturedStars)} ⭐` : DASH],
      ])
      + card('Does Telegram agree with our books?', t.ok
        ? (theirs === tot.stars
          ? `<p class="ok">Yes — Telegram shows ${esc(theirs)} ⭐ received, and our books record ${esc(tot.stars)} ⭐ in ${esc(tot.n)} payments.</p>`
          : `<p class="bad">No — Telegram shows ${esc(theirs)} ⭐ received, our books ${esc(tot.stars)} ⭐. A payment was taken that we did not credit, or the other way round: check the table below against Telegram's.</p>`)
          + note(`Withdrawable: Telegram holds Stars for 21 days and pays out from ${esc(t.withdrawMin)} matured Stars (via Fragment, from the bot's profile in Telegram). `
            + (t.maturedStars >= t.withdrawMin ? '<b>Enough has matured to withdraw.</b>' : `${esc(Math.max(0, t.withdrawMin - t.maturedStars))} more matured Stars needed.`)
            + (t.nextUnlockAt ? ` Next unlock: ${at(t.nextUnlockAt)} UTC.` : ''))
        : failed('Telegram\'s Stars report', t.error))
      + card('Every Stars payment', tbl(['When (UTC)', 'User', 'Stars', 'Credited', 'State', ''],
        (sr.data.payments || []).map((p) => [at(p.created_at), `<code>${esc(p.chat_id)}</code>`, `${esc(p.stars)} ⭐`, usd(p.micro_usd),
          p.refunded_at ? `<span class="muted">refunded ${at(p.refunded_at)}${p.refund_note ? ` — ${esc(p.refund_note)}` : ''}</span>` : 'credited',
          p.refunded_at ? '' : `<form method="POST" action="${base}/pcnaibot/payments" class="inline" autocomplete="off"
              onsubmit="return confirm('Refund ${esc(p.stars)} Stars and take ${usd(p.micro_usd)} off this user\\'s balance?')">
              <input type="hidden" name="form" value="refund"><input type="hidden" name="payment_id" value="${esc(p.id)}">
              <input name="note" type="text" placeholder="why" maxlength="200" style="width:9em">
              <input name="code" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="authenticator" style="width:8em" required>
              <button type="submit">Refund</button></form>`]),
        'No Stars payments yet.')
        + note('A refund gives the Stars back through Telegram and takes the credit off the user\'s balance. It is refused if the user has already spent it. '
          + `Invoices: ${(sr.data.invoices || []).map((i) => `${esc(i.state)} ${esc(i.n)}`).join(', ') || 'none yet'}.`));
  }

  return card('Telegram Stars', `
      <form method="POST" action="${base}/pcnaibot/payments" autocomplete="off">
        <input type="hidden" name="form" value="payments">
        <p><label><input type="checkbox" name="starsEnabled"${s.starsEnabled ? ' checked' : ''}> Sell top-ups for Telegram Stars</label></p>
        <table><tr><th>Package</th><th>User pays (Stars)</th><th>Credited (USD)</th></tr>
        ${pk.map((p, i) => `<tr><td>${i + 1}</td>
          <td><input name="pkg_stars_${i}" type="number" min="1" max="100000" value="${esc(p.stars)}" style="width:8em"> ⭐</td>
          <td>$ <input name="pkg_usd_${i}" type="text" inputmode="decimal" value="${esc(p.usd)}" style="width:7em"></td></tr>`).join('')}
        </table>
        <p><label>/paysupport text<br><textarea name="paySupportText" rows="3" style="width:100%">${esc(s.paySupportText)}</textarea></label></p>
        <button type="submit">Save</button>
      </form>`
    + note('Packages appear under ➕ Top up in this order; leave a row empty to remove it. webbuilderbot sells 50 Stars per dollar ($5 = 250 ⭐). '
      + 'Telegram pays the bot owner about $0.013 per Star after a 21-day hold, so 50 per dollar keeps roughly two thirds. '
      + 'A message starting with SUPPORT is passed to the admin chats.'))
    + books
    + card('PCN and wPCN', note('Top-ups in PCN go to each user\'s own address and are credited by the watcher after 3 confirmations, '
      + 'at price.pc.am\'s rate when the deposit confirms. Their settings stay in /etc/pcoin/pcnaibot.conf on the server.'));
}
