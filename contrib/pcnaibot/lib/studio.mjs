// The chat agent: a cheap model that talks with the user about ONE picture or video, and hands the
// agreed job to the bot as a `propose` tool call (owner, 2026-09-26, after webbuilderbot).
//
// FREE, and ON TOPIC ONLY. Chat costs the user nothing ("it only talks around the picture and video
// generation and never answers other questions"), so it declines everything else, and the house's
// cost is bounded by per-user and daily limits instead of a price.
//
// NON-AGENTIC. Plain /v1/messages with one tool -- no sandbox, no session. Measured 2026-09-26:
// mimo-v2.5 returns a correct tool_use in 5-9 s. It also wrote an English user's card summary in
// Spanish, which is why the prompt pins the reply language to the user's latest message.
//
// NOTHING THE MODEL SAYS IS TRUSTED FOR MONEY. It proposes; validateProposal() checks every field
// against the database and the live price list; the user's ✅ on the resulting card is what pays.

import { kvGetJson, kvSetJson } from './db.mjs';
import { nowSec } from './time.mjs';
import { takeFreeTurn } from './billing.mjs';
import { SHAPES, maxInputs, videoDurations, priceFor, usdToMicro, moneyLabel, balanceLabel } from './media.mjs';
import { item } from './jobs.mjs';
import { t } from './i18n.mjs';

export const HISTORY_MAX = 24;
export const MESSAGE_MAX_CHARS = 2000;

// ---- history --------------------------------------------------------------------------------
//
// Plain strings only: the tool call and its result live inside one turn, and what is kept is the
// user's words, the agent's words, and the bot's records in parentheses ("(Picture #12 was made
// and sent: …)"). Stored tool blocks break the moment a trimmed window starts at a tool_result.

export function normalizeHistory(msgs, max = HISTORY_MAX) {
  const out = [];
  for (const m of msgs) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string' || !m.content.trim()) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content = `${last.content}\n\n${m.content}`;
    else out.push({ role: m.role, content: m.content });
  }
  let trimmed = out.slice(-max);
  while (trimmed.length && trimmed[0].role !== 'user') trimmed = trimmed.slice(1);
  return trimmed;
}

export function loadHistory(db, chatId, max = HISTORY_MAX) {
  const row = db.prepare('SELECT history FROM conversations WHERE chat_id = ?').get(chatId);
  if (!row) return [];
  try { return normalizeHistory(JSON.parse(row.history), max); } catch { return []; }
}

// Re-read and append in ONE synchronous call: a record written while the model was thinking (a
// picture delivered meanwhile) is never overwritten by the turn that started before it.
export function appendHistory(db, chatId, entries) {
  const row = db.prepare('SELECT history FROM conversations WHERE chat_id = ?').get(chatId);
  let cur = [];
  if (row) { try { cur = JSON.parse(row.history); } catch { cur = []; } }
  // Records may start a conversation (an assistant line first); normalizeHistory drops it only from
  // what is SENT, so keep the raw list here and trim generously.
  const merged = [...(Array.isArray(cur) ? cur : []), ...entries].slice(-200);
  db.prepare(`INSERT INTO conversations (chat_id, history, updated_at) VALUES (?,?,?)
              ON CONFLICT(chat_id) DO UPDATE SET history=excluded.history, updated_at=excluded.updated_at`)
    .run(chatId, JSON.stringify(merged), nowSec());
}

// A record of what the bot did, kept for the agent.
export const noteFor = (db) => (chatId, text) => appendHistory(db, chatId, [{ role: 'assistant', content: text }]);

// ---- what the agent is told -----------------------------------------------------------------

const ago = (sec) => (sec < 90 ? 'just now' : sec < 5400 ? `${Math.round(sec / 60)} min ago` : sec < 129600 ? `${Math.round(sec / 3600)} h ago` : `${Math.round(sec / 86400)} days ago`);

export function recentItems(db, chatId, limit = 12) {
  return db.prepare('SELECT * FROM items WHERE chat_id = ? ORDER BY id DESC LIMIT ?').all(chatId, limit);
}

export function itemLine(it, now = nowSec()) {
  const what = it.kind === 'upload' ? "the user's photo" : it.kind === 'video' ? 'video' : 'picture';
  const from = it.kind === 'video' && it.start_item_id ? ` — started from #${it.start_item_id}` : '';
  const desc = it.summary ? ` — "${String(it.summary).slice(0, 120)}"` : '';
  return `#${it.id} — ${what} — ${ago(now - it.created_at)}${desc}${from}`;
}

export const PROPOSE_TOOL = {
  name: 'propose',
  description: 'Show the user a card for ONE picture or ONE video, with its price and a ✅ button. '
    + 'Call it when you and the user agree what to make. The user presses ✅ to make it and pay; you never make anything yourself.',
  input_schema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['image', 'video'], description: 'image = a picture; video = a short video clip.' },
      prompt: { type: 'string', description: 'The full description for the generator, in English. For a change to an existing picture: exactly what to change and what to keep.' },
      // Seen live: mimo-v2.5 pasted the user's own message (".animate #2: the snow keeps …") as the summary.
      summary: { type: 'string', description: "One short sentence for the card, in the user's language, describing what will be made — e.g. \"A red fox in a snowy meadow, snow falling.\" Not the user's message copied, no item numbers, no instructions." },
      shape: { type: 'string', enum: ['square', 'wide', 'tall'] },
      seconds: { type: 'integer', description: 'Video length in seconds. Videos only; leave it out for the usual length.' },
      sources: { type: 'array', items: { type: 'integer' }, description: 'Numbers of the items to change or start from (#12 -> 12). Leave empty to make something new.' },
    },
    required: ['kind', 'prompt', 'summary', 'shape'],
  },
};

// The live prices, from the list x our margin, as figures: { picture: { price, edit } | null,
// video: { seconds, price, per, min, max, res } | null }. Worded by priceLines, in any language.
export function priceFacts(offer, settings, marginE6) {
  const pic = offer[settings.pictureModel];
  const vid = offer[settings.videoModel];
  let picture = null;
  let video = null;
  try {
    if (pic) {
      const a = usdToMicro(priceFor(pic, { kind: 'image', inputs: 0 }).usd, marginE6);
      const b = usdToMicro(priceFor(pic, { kind: 'image', inputs: 1 }).usd, marginE6);
      picture = { price: moneyLabel(a), edit: b !== a ? moneyLabel(b) : null };
    }
  } catch { picture = null; }
  try {
    if (vid) {
      const d = videoDurations(vid);
      const whole = usdToMicro(priceFor(vid, { kind: 'video', seconds: settings.videoSeconds, resolution: settings.videoResolution }).usd, marginE6);
      const one = usdToMicro(priceFor(vid, { kind: 'video', seconds: 1, resolution: settings.videoResolution }).usd, marginE6);
      video = { seconds: settings.videoSeconds, price: moneyLabel(whole), per: moneyLabel(one), min: d.min, max: d.max, res: settings.videoResolution };
    }
  } catch { video = null; }
  return { picture, video };
}

// The prices as sentences. English for the agent (its instructions are English); the bot's screens
// pass the user's language.
export function priceLines(offer, settings, marginE6, lang = 'en') {
  const { picture, video } = priceFacts(offer, settings, marginE6);
  return [
    !picture ? t(lang, 'price.picture_off')
      : picture.edit ? t(lang, 'price.picture_edit', picture) : t(lang, 'price.picture', picture),
    video ? t(lang, 'price.video', video) : t(lang, 'price.video_off'),
  ];
}

// THE INSTRUCTIONS -- the part the admin may edit (admin.pc.am → PcoinAiBot → Chat agent). Facts
// that change (prices, balance, the user's items, the open card, the language of this message) are
// NOT here: systemPrompt() appends them after whatever the admin wrote, so an edit can never make
// the agent quote a stale price or lose track of the user's pictures.
export const DEFAULT_CHAT_PROMPT = [
  'You are the assistant of a Telegram bot that makes AI pictures and short AI videos for its users. '
  + 'You only help with that: planning, making and changing pictures and videos. If the user asks for anything else '
  + '(questions, chat, facts, code, other services), say briefly and kindly that you only make pictures and videos, and offer to make one.',
  '',
  "LANGUAGE: always reply in the language of the user's latest message. The card `summary` is in that same language. The generator `prompt` is always in English.",
  '',
  'HOW IT WORKS',
  '- Understand what the user wants. Ask at most one or two short questions, and only when something important is unclear '
  + "(for example picture or video, when they did not say). Otherwise choose good details yourself.",
  '- Then call the `propose` tool. The bot shows the user a card with the price and two buttons, ✅ Make it and ✖ Cancel. '
  + "Only the user's ✅ makes it and charges them. You never make anything yourself, and never say that something is made, being made or done.",
  '- After proposing, write at most one short sentence, e.g. "Here is the card — press ✅ to make it, or tell me what to change." Do not repeat the card or the price.',
  '- One card at a time. If the user wants changes before pressing ✅, propose again; the new card replaces the old one.',
  '- For several variations, propose one; after it is made the user can press 🔁 Again or ask for another.',
  '- Write a rich, specific English prompt: subject, setting, style, lighting, composition, mood. Text that must appear in the picture goes in the prompt in quotes, exactly as the user wrote it.',
  '',
  'CHANGING PICTURES AND VIDEOS',
  '- The user\'s pictures, videos and photos are listed below by number. To change a picture, propose kind "image" with sources [its number] '
  + 'and a prompt that says exactly what to change and what to keep. Several pictures can be combined (the limit is given below).',
  '- To make a video from a picture (animate it), propose kind "video" with sources [the picture\'s number].',
  '- A video cannot be edited frame by frame yet. To change a video, propose kind "video" with sources [the video\'s number]: '
  + 'the bot makes a NEW version with your corrected prompt, from the same starting picture if it had one. Tell the user it will be a new version.',
  '- "It", "this" or "the last one" usually means the newest item, or the one the user replies to.',
  '',
  'Pictures take under a minute; videos 1–5 minutes. Money is charged only when the user presses ✅. Below the price the user still gets the card and can top up with the ➕ Top up button.',
  '',
  'Lines in parentheses in the conversation, such as "(Picture #12 was made and sent: …)", are the bot\'s records of what happened. Never write such lines yourself.',
].join('\n');

export function systemPrompt({ instructions = DEFAULT_CHAT_PROMPT, items = [], openCard = null, prices = [], balanceMicro = 0n, pictureInputs = 1, latest = '', now = nowSec() }) {
  return [
    String(instructions || DEFAULT_CHAT_PROMPT).trim(),
    '',
    '==== CONTEXT (written by the bot for this message; always current) ====',
    `PRICES: ${prices.join('; ')}.`,
    `The user's balance is ${balanceLabel(balanceMicro)}. Up to ${pictureInputs} pictures can be combined in one change.`,
    '',
    "THE USER'S ITEMS, newest first:",
    items.length ? items.map((it) => itemLine(it, now)).join('\n') : '(none yet)',
    '',
    openCard
      ? `OPEN CARD P${openCard.id}: ${openCard.kind === 'video' ? 'video' : 'picture'}, ${openCard.shape} — "${openCard.summary}" — ${moneyLabel(openCard.price_micro)}. It is waiting for the user's ✅.`
      : 'No card is open.',
    // LAST, where it weighs most: the language of THIS message. Seen live 2026-09-26: after one
    // Armenian request, mimo-v2.5 wrote the next English request's card summary in Armenian.
    ...(latest ? ['', `THE USER'S LATEST MESSAGE: "${latest.slice(0, 300)}". Reply, and write the card summary, in the language of THAT message — even if earlier messages used another language.`] : []),
  ].join('\n');
}

// ---- checking what the agent proposed ------------------------------------------------------

const toIds = (v) => (Array.isArray(v) ? v : [])
  .map((x) => Number(String(x).replace(/[^0-9]/g, '')))
  .filter((n) => Number.isInteger(n) && n > 0);

// { spec } or { error } -- the error goes back to the model as the tool result.
export function validateProposal(db, chatId, input, { offer, settings }) {
  const kind = input?.kind;
  if (kind !== 'image' && kind !== 'video') return { error: 'kind must be "image" or "video".' };
  const prompt = String(input.prompt ?? '').trim();
  const summary = String(input.summary ?? '').trim().replace(/^[\s.,:;·—–-]+/, '');
  if (prompt.length < 3) return { error: 'prompt is empty.' };
  if (summary.length < 3) return { error: 'summary is empty.' };
  if (prompt.length > 2000) return { error: 'prompt is too long; keep it under 2000 characters.' };
  const shape = SHAPES[input.shape] ? input.shape : 'square';
  const ids = [...new Set(toIds(input.sources))];
  const its = [];
  for (const id of ids) {
    const it = item(db, id);
    if (!it || it.chat_id !== chatId) return { error: `#${id} is not one of this user's items.` };
    its.push(it);
  }

  if (kind === 'image') {
    const o = offer[settings.pictureModel];
    if (!o) return { error: 'pictures are unavailable right now; tell the user to try again later.' };
    for (const it of its) {
      if (it.kind === 'video') return { error: `#${it.id} is a video. To change a video, propose kind "video" with sources [${it.id}].` };
    }
    const max = maxInputs(o);
    if (its.length > max) return { error: `at most ${max} pictures can be used at once.` };
    return { spec: { kind, model: o.id, prompt, summary: summary.slice(0, 300), shape, seconds: null, resolution: null,
      sources: its.map((it) => it.id), startItemId: null, newVersionOf: null } };
  }

  const o = offer[settings.videoModel];
  if (!o) return { error: 'videos are unavailable right now; tell the user to try again later.' };
  if (its.length > 1) return { error: 'a video starts from at most one picture.' };
  let start = null;
  let newVersionOf = null;
  if (its.length) {
    if (its[0].kind === 'video') { newVersionOf = its[0].id; start = its[0].start_item_id ?? null; }
    else start = its[0].id;
  }
  if (start !== null && !o.i2v) return { error: 'a video cannot start from a picture right now; propose it without sources.' };
  const d = videoDurations(o);
  const want = Number.isInteger(input.seconds) ? input.seconds : settings.videoSeconds;
  const seconds = Math.min(d.max, Math.max(d.min, want));
  return { spec: { kind, model: o.id, prompt, summary: summary.slice(0, 300), shape, seconds, resolution: settings.videoResolution,
    sources: start !== null ? [start] : [], startItemId: start, newVersionOf } };
}

// ---- the card's language --------------------------------------------------------------------
//
// A prompt alone did not hold it: twice on 2026-09-26, after one Armenian request, mimo-v2.5 wrote
// an English request's card summary in Armenian -- the second time with "reply in the language of
// THAT message" as the last line of its instructions. So the script is checked in code, and a
// mismatch goes back to the model once. (Script, not language: English and Spanish share one,
// which is the mistake a script check cannot see and a person can live with.)
const SCRIPTS = [
  ['Armenian', /[԰-֏]/], ['Cyrillic', /[Ѐ-ӿ]/], ['Arabic', /[؀-ۿ]/],
  ['Georgian', /[Ⴀ-ჿ]/], ['Greek', /[Ͱ-Ͽ]/], ['Hebrew', /[֐-׿]/],
  ['Devanagari', /[ऀ-ॿ]/], ['CJK', /[぀-ヿ一-鿿가-힯]/],
  ['Latin', /[A-Za-zÀ-ɏ]/],
];
export function dominantScript(text) {
  const counts = {};
  for (const ch of String(text ?? '')) {
    for (const [name, re] of SCRIPTS) if (re.test(ch)) { counts[name] = (counts[name] ?? 0) + 1; break; }
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total < 3) return null;
  const [name, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return n / total >= 0.6 ? name : null;
}
export function languageProblem(latest, summary) {
  const want = dominantScript(latest);
  const got = dominantScript(summary);
  return want && got && want !== got
    ? `the summary is written in ${got} script, but the user's latest message is in ${want} script. Write the summary, and your reply, in the language of the user's latest message.`
    : null;
}

// ---- the free chat's limits -----------------------------------------------------------------

const dayKey = () => `studio:chatcalls:${new Date().toISOString().slice(0, 10)}`;

// { ok } or { refuse: text }. Per user per hour, and a daily budget for the whole bot after which
// only people who have paid something may chat (Telegram accounts are free to make).
export function chatGate(db, chatId, { perHour, dailyBudget, balanceMicro, rateRemaining = null, rlFloor = 0, lang = 'en' }) {
  if (rateRemaining !== null && rateRemaining < rlFloor) {
    return { refuse: t(lang, 'gate.busy') };
  }
  const day = kvGetJson(db, dayKey()) ?? { n: 0 };
  if (day.n >= dailyBudget && !(BigInt(balanceMicro) > 0n)) {
    return { refuse: t(lang, 'gate.resting', { topup: t(lang, 'kb.topup') }) };
  }
  const q = takeFreeTurn(db, chatId, { perHour });
  if (!q.allowed) return { refuse: t(lang, 'gate.hourly', { n: q.limit }) };
  kvSetJson(db, dayKey(), { n: day.n + 1 });
  return { ok: true };
}

// ---- one turn -------------------------------------------------------------------------------

const RECORD_LINE = /^\s*\((Card P\d+|Picture #\d+|Video #\d+|The (picture|video) being made|The user )[^\n]*\)\s*$/gm;

function readReply(resp) {
  const blocks = Array.isArray(resp?.content) ? resp.content : [];
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').replace(RECORD_LINE, '').trim();
  const tool = blocks.find((b) => b.type === 'tool_use' && b.name === PROPOSE_TOOL.name) ?? null;
  return { text, tool, stop: resp?.stop_reason ?? null };
}

// Talk once. Returns { text, spec, failed }: `spec` is a validated job for a card, or null.
// Sends nothing and stores nothing -- the caller does both, in that order.
//   deps: { db, oona, settings, offer, marginE6, balanceMicro }
// Exactly what the chat model receives for this chat and message -- used by every turn AND by the
// admin's preview, so the preview cannot drift from what is really sent (webbuilderbot's did).
export function buildRequest(deps, { chatId, userContent }) {
  const { db, settings, offer, marginE6 } = deps;
  const openCard = db.prepare("SELECT * FROM proposals WHERE chat_id = ? AND state = 'open' ORDER BY id DESC LIMIT 1").get(chatId) ?? null;
  const pic = offer[settings.pictureModel];
  // The user's own words, without the bot's notes ("(The user is replying to #12.)").
  const latest = userContent.split('\n').filter((l) => !/^\(The user /.test(l)).join(' ').trim();
  const system = systemPrompt({
    instructions: settings.chatPrompt || DEFAULT_CHAT_PROMPT,
    items: recentItems(db, chatId),
    openCard,
    prices: priceLines(offer, settings, marginE6),
    balanceMicro: deps.balanceMicro ?? 0n,
    pictureInputs: pic ? Math.max(1, maxInputs(pic)) : 1,
    latest,
  });
  const max = settings.historyMax ?? HISTORY_MAX;
  const messages = normalizeHistory([...loadHistory(db, chatId, max), { role: 'user', content: userContent }], max);
  return { latest, body: { model: settings.chatModel, max_tokens: 2048, system, tools: [PROPOSE_TOOL], messages } };
}

export async function chatTurn(deps, { chatId, userContent }) {
  const { db, oona, settings, offer } = deps;
  const { latest, body } = buildRequest(deps, { chatId, userContent });
  const messages = body.messages;

  const resp = await oona.messages(body);
  const r = readReply(resp);
  // Cut off mid-answer: a half-written tool call is not a proposal.
  if (r.stop === 'max_tokens') return { text: '', spec: null, failed: 'max_tokens' };
  if (!r.tool) return { text: r.text, spec: null, failed: null };

  const v = validateProposal(db, chatId, r.tool.input, { offer, settings });
  const wrongLanguage = v.spec ? (languageProblem(latest, v.spec.summary) ?? languageProblem(latest, r.text)) : null;
  if (v.spec && !wrongLanguage) return { text: r.text, spec: v.spec, failed: null };

  // ONE retry, told why. The model's own blocks go back untouched (thinking included).
  const resp2 = await oona.messages({
    ...body,
    messages: [...messages,
      { role: 'assistant', content: resp.content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: r.tool.id, is_error: true,
        content: `Not accepted: ${v.error ?? wrongLanguage} Fix it and call propose again, or ask the user.` }] },
    ],
  });
  const r2 = readReply(resp2);
  if (r2.stop === 'max_tokens') return { text: '', spec: null, failed: 'max_tokens' };
  if (!r2.tool) return { text: r2.text || r.text, spec: null, failed: null };
  const v2 = validateProposal(db, chatId, r2.tool.input, { offer, settings });
  return { text: r2.text || r.text, spec: v2.spec ?? null, failed: v2.spec ? null : 'invalid', error: v2.error ?? null };
}

// Does a chat model call the tool at all? Asked on startup, daily, and before the admin may pick a
// new one. One tiny request.
export async function testChatModel(oona, model) {
  try {
    const resp = await oona.messages({
      model, max_tokens: 2048,
      system: 'You make pictures for the user. When the request is clear, call the propose tool.',
      tools: [PROPOSE_TOOL],
      messages: [{ role: 'user', content: 'Make a picture of a red apple on a wooden table, square, photorealistic.' }],
    });
    const r = readReply(resp);
    return r.tool ? { ok: true } : { ok: false, why: `no tool call (stop_reason ${r.stop ?? '?'})` };
  } catch (e) {
    return { ok: null, why: String(e?.message ?? e).slice(0, 160) };
  }
}
