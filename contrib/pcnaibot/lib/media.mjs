// Pictures and video, made directly by an image or video model -- no agent in between.
//
// Owner, 2026-09-25: "user should select model only from the bot list ... show badge for models
// that has picture generation capability so user will select them". Every chat model could
// already make a picture -- through the agent's generate_image tool, which calls one of these same
// models -- but which image model drew it was the default or whatever the user happened to type.
// A 🎨 or 🎬 entry in /models makes that the user's choice, and is faster and cheaper: a picture
// is one call, ~50 s and $0.048 at retail, where the agent spent 70-180 credits getting there.
//
// Measured 2026-09-25 against the live endpoint: a three-word prompt and an Armenian one both came
// back as good pictures (the model expands a prompt itself), so the user's words go as they are.
//
// MONEY. The same rules as every other turn here: reserve the most it can cost BEFORE the call,
// settle from what OonaCode says it charged (`usage.credits`, 1000 per USD at retail) times our
// margin, release in full when the call positively did not run, and HOLD when it may have. Unlike
// a chat turn there is NO OVERDRAFT: a picture's price is known in advance, and a balance of one
// cent must not buy a $2.52 video.

import { log, errFields, chatTag } from './log.mjs';
import { nowSec } from './time.mjs';
import { classify, Bucket } from './oonacode.mjs';
import { reserve, settle, release, hold, InsufficientFunds } from './billing.mjs';
import { creditsToMicroUsd } from './agent.mjs';
import { parseScaled, microUsdToString, trimZeros } from './money.mjs';
import { escapeHtml } from './telegram.mjs';

export const CREDITS_PER_USD = 1000;

// What the bot sells, and how. OonaCode's own list (`GET /v1/models` with an API key) decides
// WHETHER each is on sale and at WHAT price; this decides how it is presented and asked for.
// The owner, 2026-09-25: no GPT or Grok image models "for now".
export const MEDIA_MODELS = {
  'qwen-image-3.0-pro': {
    kind: 'image', api: 'qwen-image-3.0-pro', tag: '🎨 pictures, text',
    desc: 'Makes a picture from your words. The best at pictures with writing in them — posters, logos, signs. Send a photo with a caption to change it.',
    // All three stay inside Qwen-Image's cheaper "1k" tier (area up to 2,250,000 px).
    sizes: { square: '1024x1024', wide: '1536x1024', tall: '1024x1536' },
  },
  'wan2.7-image-pro': {
    kind: 'image', api: 'wan2.7-image-pro', tag: '🎨 pictures, 2K',
    desc: 'Makes the sharpest, most photographic pictures, at 2K. Send a photo with a caption to change it.',
    // One price at any size, so 2K.
    sizes: { square: '2048x2048', wide: '2048x1152', tall: '1152x2048' },
  },
  'happyhorse-1.1': {
    kind: 'video', t2v: 'happyhorse-1.1-t2v', i2v: 'happyhorse-1.1-i2v', tag: '🎬 video',
    desc: 'Makes a 5-second video clip with sound from your words — or brings a photo to life if you send one with a caption. A clip takes 1–5 minutes.',
    resolution: '720P', duration: 5, ratio: '16:9',
  },
};

export const SHAPES = { square: '⬜ Square', wide: '▭ Wide', tall: '▯ Tall' };

export const badgeOf = (id) => (MEDIA_MODELS[id]?.kind === 'video' ? '🎬' : MEDIA_MODELS[id] ? '🎨' : '🧠');

// ---- what is on sale ------------------------------------------------------------------------

// The entries of OonaCode's list we sell, keyed by OUR id, each with the listing it prices from.
// A video entry needs its text-to-video model; image-to-video is an extra that may be missing.
export function mediaOffer(listing) {
  const byId = new Map((Array.isArray(listing) ? listing : []).map((m) => [m.id, m]));
  const out = {};
  for (const [id, info] of Object.entries(MEDIA_MODELS)) {
    if (info.kind === 'image') {
      const e = byId.get(info.api);
      if (e && e.modality === 'image' && e.pricing?.tiers) out[id] = { id, info, image: e };
    } else {
      const t2v = byId.get(info.t2v);
      if (t2v && t2v.modality === 'video' && Number.isFinite(Number(t2v.pricing?.tiers?.[info.resolution]))) {
        const i2v = byId.get(info.i2v);
        out[id] = { id, info, t2v, i2v: i2v && i2v.modality === 'video' ? i2v : null };
      }
    }
  }
  return out;
}

// Retail USD, before our margin. `typical` is what a picture normally costs (the cheapest tier --
// every size we ask for is in it); `hold` is the most it can cost, which is what is reserved.
export function priceUsd(offer, { inputImages = 0 } = {}) {
  if (offer.info.kind === 'image') {
    const tiers = Object.values(offer.image.pricing.tiers).map(Number).filter(Number.isFinite);
    const input = Number(offer.image.pricing.input_image ?? 0) || 0;
    return { typical: Math.min(...tiers) + inputImages * input, hold: Math.max(...tiers) + inputImages * input };
  }
  const perSecond = Number(offer.t2v.pricing.tiers[offer.info.resolution]);
  const usd = perSecond * offer.info.duration;
  return { typical: usd, hold: usd };
}

export const usdToMicro = (usd, marginE6) => creditsToMicroUsd(Number(usd) * CREDITS_PER_USD, marginE6, parseScaled);
export const moneyLabel = (micro) => `$${trimZeros(microUsdToString(micro, 3))}`;

// ---- the API --------------------------------------------------------------------------------

export class MediaError extends Error {
  constructor(bucket, message, { status = null } = {}) {
    super(message);
    this.name = 'MediaError';
    this.bucket = bucket;
    this.status = status;
  }
}

export class MediaClient {
  #key;

  constructor(baseUrl, apiKey, { fetchImpl = fetch } = {}) {
    this.base = baseUrl.replace(/\/+$/, '');
    this.#key = apiKey;
    this.fetchImpl = fetchImpl;
  }

  // One exchange, classified the way every other gateway call here is: a JSON answer or a
  // MediaError carrying its bucket. A connection that never opened did not run; anything lost
  // after the request left is UNKNOWN -- a picture may have been made and charged.
  async #call(method, path, body, timeoutMs) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers: { 'x-api-key': this.#key, 'content-type': 'application/json', accept: 'application/json' },
        body: body === null ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      const code = e?.cause?.code ?? '';
      if (!ctrl.signal.aborted && /ECONNREFUSED|ENOTFOUND|EAI_AGAIN/.test(code)) {
        throw new MediaError(Bucket.PERMANENT, `could not connect: ${code}`);
      }
      throw new MediaError(Bucket.UNKNOWN, ctrl.signal.aborted ? `no answer within ${Math.round(timeoutMs / 1000)} s` : `the request failed: ${e.message}`);
    } finally {
      clearTimeout(t);
    }
    const ct = res.headers.get('content-type') || '';
    let json = null;
    if (ct.includes('application/json')) { try { json = await res.json(); } catch { /* unreadable */ } }
    const bucket = classify(res.status, json, { hadJsonContentType: json !== null });
    if (bucket !== Bucket.OK) {
      const msg = json?.error?.message ?? `HTTP ${res.status}`;
      throw new MediaError(bucket, String(msg).slice(0, 300), { status: res.status });
    }
    if (!json || typeof json !== 'object') throw new MediaError(Bucket.UNKNOWN, `HTTP ${res.status} with an unreadable body`, { status: res.status });
    return json;
  }

  // Every model this key can call, media included, with prices and limits.
  async listModels() {
    const j = await this.#call('GET', '/v1/models', null, 30000);
    return Array.isArray(j.data) ? j.data : [];
  }

  // One picture. Measured at 45-51 s; the wait allows for a slow provider.
  async generateImage({ model, prompt, size, images = [] }) {
    const body = { model, prompt, n: 1, size };
    if (images.length) body.image = images;
    return this.#call('POST', '/v1/images/generations', body, 300000);
  }

  async createVideo({ model, prompt, image = null, resolution, duration, ratio = null }) {
    const body = { model, resolution, duration };
    if (prompt) body.prompt = prompt;
    if (image) body.image = image;
    if (ratio) body.ratio = ratio;
    return this.#call('POST', '/v1/videos', body, 60000);
  }

  async getVideo(id) {
    return this.#call('GET', `/v1/videos/${encodeURIComponent(id)}`, null, 30000);
  }

  // The result itself, from the provider's short-lived URL.
  async download(url, { maxBytes = 50 * 1024 * 1024 } = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 120000);
    try {
      const res = await this.fetchImpl(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`download HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes) throw new Error(`${buf.length} bytes, over the limit`);
      return buf;
    } finally {
      clearTimeout(t);
    }
  }
}

// ---- words the user reads -------------------------------------------------------------------

function failureText(e, { what }) {
  if (e instanceof InsufficientFunds) return null; // handled by the caller, which knows the price
  if (!(e instanceof MediaError)) return `The ${what} could not be made. <b>Nothing has been charged.</b>`;
  if (e.bucket === Bucket.UNKNOWN) {
    return `We lost contact with the ${what} service part-way through, so nothing has been settled. The amount is held and released automatically if no charge is recorded.`;
  }
  if (e.bucket === Bucket.BACKOFF || e.bucket === Bucket.NOT_BILLED) {
    return `The ${what} service is busy right now. <b>Nothing has been charged.</b> Please try again in a moment.`;
  }
  // PERMANENT: the request itself was refused -- most often a content filter. Say what it said.
  return `The ${what} service refused this request. <b>Nothing has been charged.</b>\n\n<i>${escapeHtml(e.message.slice(0, 200))}</i>`;
}

// Undo a reservation according to how the call failed.
function unwind(db, reservationId, e) {
  const reason = `media: ${e?.message ?? e}`.slice(0, 200);
  if (e instanceof MediaError && e.bucket === Bucket.UNKNOWN) hold(db, reservationId, reason);
  else release(db, reservationId, reason);
}

// A Telegram file as a data URI, for an input image.
async function asDataUri(tg, a) {
  const dl = await tg.downloadFile(a.fileId);
  if (!dl.ok) return null;
  const mime = /^image\//.test(a.contentType ?? '') ? a.contentType : 'image/jpeg';
  return `data:${mime};base64,${dl.buffer.toString('base64')}`;
}

// The picture's own buttons: another one, another shape, the original file.
export function imageKeyboard(jobId, shape) {
  const again = [{ text: '🔁 Again', callback_data: `mj:${jobId}:again` }];
  for (const [s, label] of Object.entries(SHAPES)) if (s !== shape) again.push({ text: label, callback_data: `mj:${jobId}:${s}` });
  return { inline_keyboard: [again, [{ text: '📎 Original file', callback_data: `mj:${jobId}:file` }]] };
}
export function videoKeyboard(jobId) {
  return { inline_keyboard: [[{ text: '🔁 Again', callback_data: `mj:${jobId}:again` }, { text: '📎 Original file', callback_data: `mj:${jobId}:file` }]] };
}

// The words behind the buttons, in memory only (see 012_media.sql). Bounded, and gone on restart.
export class PromptMemory {
  constructor({ max = 5000, ttlSec = 86400 } = {}) { this.map = new Map(); this.max = max; this.ttlSec = ttlSec; }
  set(jobId, v) {
    this.map.set(jobId, { ...v, at: nowSec() });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
  get(jobId) {
    const v = this.map.get(jobId);
    if (!v) return null;
    if (nowSec() - v.at > this.ttlSec) { this.map.delete(jobId); return null; }
    return v;
  }
}

// ---- a picture ------------------------------------------------------------------------------

// One picture, start to finish, inside the user's turn. Returns the text to send, or null when
// it sent everything itself.
//   deps: { db, tg, media, marginE6, memory, draft }   draft: a DraftStream, or null
export async function runImage(deps, { chatId, updateId, offer, prompt, shape = 'square', inputs = [] }) {
  const { db, tg, media, marginE6, memory, draft = null } = deps;
  const maxIn = Number(offer.image.limits?.input_images?.max ?? 0);
  const used = inputs.slice(0, Math.max(0, maxIn));
  const price = priceUsd(offer, { inputImages: used.length });
  const holdMicro = usdToMicro(price.hold, marginE6);

  let resv;
  try {
    resv = reserve(db, { chatId, updateId, model: offer.id, microUsd: holdMicro, allowOverdraft: false });
  } catch (e) {
    if (e instanceof InsufficientFunds) {
      return `A picture from <b>${escapeHtml(offer.id)}</b> costs up to <b>${moneyLabel(holdMicro)}</b> and your balance is ${moneyLabel(e.available)}.\n\nTop up with /topup, or pick another model in /models.`;
    }
    throw e;
  }
  if (resv.duplicate) return null;

  const started = Date.now();
  const status = () => `<i>🎨 Drawing the picture… ${Math.floor((Date.now() - started) / 1000)}s</i>`;
  let tick = null;
  if (draft) {
    await draft.push(status());
    tick = setInterval(() => { draft.push(status()).catch(() => undefined); }, 5000);
  }

  let out;
  try {
    const images = [];
    for (const a of used) {
      const uri = await asDataUri(tg, a);
      if (!uri) throw new MediaError(Bucket.PERMANENT, 'your photo could not be fetched from Telegram (over its 20 MB limit for bots?)');
      images.push(uri);
    }
    const size = offer.info.sizes[shape] ?? offer.info.sizes.square;
    out = await media.generateImage({ model: offer.image.id, prompt, size, images });
  } catch (e) {
    clearInterval(tick);
    unwind(db, resv.reservationId, e);
    log.warn('picture failed', { chat: chatTag(chatId), model: offer.id, bucket: e?.bucket ?? null, err: String(e?.message ?? e).slice(0, 160) });
    return failureText(e, { what: 'picture' });
  }
  clearInterval(tick);

  // SETTLE FROM WHAT WAS CHARGED. No credits field is "we do not know", and that is held, never
  // settled at a number we made up.
  const credits = Number(out?.usage?.credits);
  let chargedMicro = null;
  if (Number.isFinite(credits) && credits >= 0) {
    chargedMicro = creditsToMicroUsd(credits, marginE6, parseScaled);
    const s = settle(db, resv.reservationId, chargedMicro, {
      note: `media ${offer.id} credits=${credits} images=${out.usage.images ?? '?'} in=${out.usage.input_images ?? used.length}`,
    });
    if (s.overran) log.error('PICTURE SETTLE OVERRAN THE RESERVATION -- billed in full', { reserved: String(s.reserved), actual: String(s.actual) });
  } else {
    hold(db, resv.reservationId, 'picture made but no usage.credits reported');
    log.error('picture reported no credits; reservation HELD', { model: offer.id });
  }

  const first = Array.isArray(out.data) ? out.data[0] : null;
  const expires = Date.parse(out.expires_at);
  const job = db.prepare(
    `INSERT INTO media_jobs (chat_id, kind, model, api_model, shape, reservation_id, state, credits,
                             result_url, result_expires_at, created_at, finished_at)
     VALUES (?, 'image', ?, ?, ?, ?, 'done', ?, ?, ?, ?, ?)`
  ).run(chatId, offer.id, offer.image.id, shape, resv.reservationId, Number.isFinite(credits) ? String(credits) : null,
    first?.url ?? null, Number.isFinite(expires) ? Math.floor(expires / 1000) : null, nowSec(), nowSec());
  const jobId = Number(job.lastInsertRowid);
  memory?.set(jobId, { prompt, inputs: used, model: offer.id, kind: 'image', shape });

  let bytes = null;
  try {
    bytes = first?.b64_json ? Buffer.from(first.b64_json, 'base64') : first?.url ? await media.download(first.url) : null;
  } catch (e) {
    log.warn('picture made but could not be downloaded', errFields(e));
  }
  const caption = `<i>${escapeHtml(offer.id)}${chargedMicro !== null ? ` · ${moneyLabel(chargedMicro)}` : ''}</i>`;
  const keyboard = imageKeyboard(jobId, shape);
  if (!bytes) {
    await tg.sendMessage(chatId, `The picture was made (and paid for) but could not be fetched just now. Press <b>📎 Original file</b> to try again.`, { reply_markup: keyboard });
    return null;
  }
  // A photo is shown inline; over Telegram's 10 MB for photos, the file goes as a document.
  let sent = bytes.length <= 10 * 1024 * 1024
    ? await tg.sendPhoto(chatId, bytes, { filename: `${offer.id}.png`, caption, replyMarkup: keyboard })
    : { ok: false };
  if (!sent.ok) sent = await tg.sendDocument(chatId, bytes, { filename: `${offer.id}-${jobId}.png`, contentType: 'image/png', caption, replyMarkup: keyboard });
  if (!sent.ok) log.warn('could not send the picture', { chat: chatTag(chatId), desc: sent.description ?? null });
  log.info('picture delivered', { chat: chatTag(chatId), model: offer.id, credits, ms: Date.now() - started, bytes: bytes.length });
  return null;
}

// ---- a video --------------------------------------------------------------------------------

// Start a clip. It is made while the user does something else; pollVideos delivers it.
export async function startVideo(deps, { chatId, updateId, offer, prompt, inputs = [] }) {
  const { db, tg, media, marginE6, memory } = deps;
  const running = db.prepare("SELECT id FROM media_jobs WHERE chat_id = ? AND kind = 'video' AND state = 'running'").get(chatId);
  if (running) return 'Your previous video is still being made — it will arrive here. One at a time, please.';

  const fromPhoto = inputs.length > 0;
  if (fromPhoto && !offer.i2v) return 'Bringing a photo to life is not available right now. Send a description instead and I will make the clip from that.';
  if (!fromPhoto && !prompt) return 'Describe the video you want, or send a photo with a caption to bring it to life.';
  const api = fromPhoto ? offer.i2v : offer.t2v;
  const holdMicro = usdToMicro(priceUsd(offer).hold, marginE6);

  let resv;
  try {
    resv = reserve(db, { chatId, updateId, model: offer.id, microUsd: holdMicro, allowOverdraft: false });
  } catch (e) {
    if (e instanceof InsufficientFunds) {
      return `A ${offer.info.duration}-second video costs <b>${moneyLabel(holdMicro)}</b> and your balance is ${moneyLabel(e.available)}.\n\nTop up with /topup, or pick another model in /models.`;
    }
    throw e;
  }
  if (resv.duplicate) return null;

  let job;
  try {
    const image = fromPhoto ? await asDataUri(tg, inputs[0]) : null;
    if (fromPhoto && !image) throw new MediaError(Bucket.PERMANENT, 'your photo could not be fetched from Telegram');
    job = await media.createVideo({
      model: api.id, prompt: prompt || null, image,
      resolution: offer.info.resolution, duration: offer.info.duration,
      // A first frame decides its own shape; a ratio is for text-to-video only.
      ratio: fromPhoto ? null : offer.info.ratio,
    });
  } catch (e) {
    unwind(db, resv.reservationId, e);
    log.warn('video could not be started', { chat: chatTag(chatId), bucket: e?.bucket ?? null, err: String(e?.message ?? e).slice(0, 160) });
    return failureText(e, { what: 'video' });
  }
  if (typeof job?.id !== 'string' || !job.id) {
    // It answered but named no job: something may be running that we cannot find. Hold.
    hold(db, resv.reservationId, 'video create answered without a job id');
    return failureText(new MediaError(Bucket.UNKNOWN, 'no job id'), { what: 'video' });
  }

  // WRITTEN DOWN BEFORE THE USER HEARS OF IT: from here a restart resumes it (see pollVideos).
  const row = db.prepare(
    `INSERT INTO media_jobs (chat_id, kind, model, api_model, reservation_id, remote_id, state, created_at)
     VALUES (?, 'video', ?, ?, ?, ?, 'running', ?)`
  ).run(chatId, offer.id, api.id, resv.reservationId, job.id, nowSec());
  const jobId = Number(row.lastInsertRowid);
  memory?.set(jobId, { prompt, inputs: inputs.slice(0, 1), model: offer.id, kind: 'video' });

  const msg = await tg.sendMessage(chatId, `<i>🎬 Making your video — usually 1–5 minutes. It will arrive here; you can keep chatting meanwhile.</i>`);
  if (msg.ok) db.prepare('UPDATE media_jobs SET status_message_id = ? WHERE id = ?').run(msg.result?.message_id ?? null, jobId);
  log.info('video started', { chat: chatTag(chatId), model: api.id, job: jobId });
  return null;
}

// Read every clip still being made, and finish the ones that are done. Runs on a timer and at
// startup; safe to run again on the same job, because a job leaves 'running' exactly once.
export async function pollVideos(deps, { maxAgeSec = 45 * 60, now = nowSec } = {}) {
  const { db, tg, media, marginE6 } = deps;
  const jobs = db.prepare("SELECT * FROM media_jobs WHERE kind = 'video' AND state = 'running' ORDER BY id").all();
  const counts = { checked: 0, done: 0, failed: 0 };
  for (const j of jobs) {
    counts.checked++;
    let v;
    try {
      v = await media.getVideo(j.remote_id);
    } catch (e) {
      // Not knowing is not an ending. Only a clip far past any normal time is given up on, and
      // its money is HELD, never released: it may yet have been made and charged.
      if (now() - j.created_at > maxAgeSec) {
        finish(db, j.id, 'unknown', { error: String(e?.message ?? e).slice(0, 200) });
        if (j.reservation_id) hold(db, j.reservation_id, 'video job unreadable past its time');
        await dropStatus(tg, j);
        await tg.sendMessage(j.chat_id, 'Your video is taking far longer than it should, and I can no longer reach the job. The amount is held and released automatically if no charge is recorded.');
      }
      continue;
    }

    if (v.status === 'failed') {
      finish(db, j.id, 'failed', { error: v.error?.message ?? 'failed' });
      if (j.reservation_id) release(db, j.reservation_id, `video failed: ${v.error?.message ?? ''}`.slice(0, 200));
      await dropStatus(tg, j);
      await tg.sendMessage(j.chat_id, `The video could not be made. <b>Nothing has been charged.</b>${v.error?.message ? `\n\n<i>${escapeHtml(String(v.error.message).slice(0, 200))}</i>` : ''}`);
      counts.failed++;
      continue;
    }
    if (v.status !== 'completed') {
      await touchStatus(tg, j, now());
      continue;
    }

    const credits = Number(v.credits);
    let chargedMicro = null;
    if (j.reservation_id) {
      if (Number.isFinite(credits) && credits >= 0) {
        chargedMicro = creditsToMicroUsd(credits, marginE6, parseScaled);
        const s = settle(db, j.reservation_id, chargedMicro, { note: `media ${j.model} credits=${credits} seconds=${v.duration ?? '?'} ${v.resolution ?? ''}`.trim() });
        if (s.overran) log.error('VIDEO SETTLE OVERRAN THE RESERVATION -- billed in full', { reserved: String(s.reserved), actual: String(s.actual) });
      } else {
        hold(db, j.reservation_id, 'video completed but no credits reported');
      }
    }
    const expires = Date.parse(v.expires_at);
    finish(db, j.id, 'done', {
      credits: Number.isFinite(credits) ? String(credits) : null, url: v.url ?? null,
      expires: Number.isFinite(expires) ? Math.floor(expires / 1000) : null,
    });
    counts.done++;
    await dropStatus(tg, j);

    let bytes = null;
    try { bytes = v.url ? await media.download(v.url) : null; } catch (e) { log.warn('video made but could not be downloaded', errFields(e)); }
    const caption = `<i>${escapeHtml(j.model)}${chargedMicro !== null ? ` · ${moneyLabel(chargedMicro)}` : ''}</i>`;
    if (!bytes) {
      await tg.sendMessage(j.chat_id, 'Your video is ready (and paid for) but could not be fetched just now. Press <b>📎 Original file</b> to try again.', { reply_markup: videoKeyboard(j.id) });
      continue;
    }
    let sent = await tg.sendVideo(j.chat_id, bytes, { filename: `${j.model}-${j.id}.mp4`, caption, replyMarkup: videoKeyboard(j.id) });
    if (!sent.ok) sent = await tg.sendDocument(j.chat_id, bytes, { filename: `${j.model}-${j.id}.mp4`, contentType: 'video/mp4', caption, replyMarkup: videoKeyboard(j.id) });
    if (!sent.ok) log.warn('could not send the video', { chat: chatTag(j.chat_id), desc: sent.description ?? null });
    log.info('video delivered', { chat: chatTag(j.chat_id), job: j.id, credits, secs: now() - j.created_at });
  }
  return counts;
}

function finish(db, id, state, { error = null, credits = null, url = null, expires = null } = {}) {
  db.prepare(
    `UPDATE media_jobs SET state = ?, error = ?, credits = COALESCE(?, credits), result_url = COALESCE(?, result_url),
                           result_expires_at = COALESCE(?, result_expires_at), finished_at = ?
      WHERE id = ? AND state = 'running'`
  ).run(state, error, credits, url, expires, nowSec(), id);
}

async function dropStatus(tg, j) {
  if (!j.status_message_id) return;
  try { await tg.call('deleteMessage', { chat_id: j.chat_id, message_id: j.status_message_id }); } catch { /* untidy, never harmful */ }
}

// The "making your video" line, with the clock moved on -- once a minute is enough.
async function touchStatus(tg, j, nowS) {
  if (!j.status_message_id) return;
  const secs = nowS - j.created_at;
  if (secs < 60 || secs % 60 >= 20) return; // the poller runs every ~15 s; one edit per minute
  const clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  try {
    await tg.call('editMessageText', {
      chat_id: j.chat_id, message_id: j.status_message_id, parse_mode: 'HTML',
      text: `<i>🎬 Making your video… ${clock} so far — usually 1–5 minutes. It will arrive here.</i>`,
    });
  } catch { /* cosmetic */ }
}

// "Original file" under a picture or video: the untouched bytes, as a document. Free.
export async function sendOriginal(deps, { chatId, jobId }) {
  const { db, tg, media } = deps;
  const j = db.prepare('SELECT * FROM media_jobs WHERE id = ? AND chat_id = ?').get(jobId, chatId);
  if (!j || !j.result_url) return 'That file is not available.';
  if (j.result_expires_at && j.result_expires_at < nowSec()) return 'That file has expired — the service keeps results for 24 hours.';
  let bytes;
  try { bytes = await media.download(j.result_url); } catch (e) { return 'The file could not be fetched just now. Please try again in a moment.'; }
  const ext = j.kind === 'video' ? 'mp4' : 'png';
  const sent = await tg.sendDocument(chatId, bytes, { filename: `${j.model}-${j.id}.${ext}`, contentType: j.kind === 'video' ? 'video/mp4' : 'image/png' });
  return sent.ok ? null : 'The file could not be sent just now. Please try again in a moment.';
}

// The reservations a restart must NOT release: clips still being made settle through the poller.
export function runningReservationIds(db) {
  return new Set(db.prepare("SELECT reservation_id FROM media_jobs WHERE state = 'running' AND reservation_id IS NOT NULL").all().map((r) => r.reservation_id));
}
