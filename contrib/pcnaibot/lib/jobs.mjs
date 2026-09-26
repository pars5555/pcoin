// Cards, the ✅ that pays, and the builder's jobs -- every place money moves in the studio.
//
// THE RULES (owner, 2026-09-26, and this repo's money doctrine):
//   * Money moves ONLY when the user presses ✅ on a card. Chat is free; "Again" opens a card.
//   * The button's price is the most the user pays. Exactly that is reserved; the settle is what
//     OonaCode charged x our margin, CAPPED at the button (a cap that bites is the house's loss and
//     is logged as an error). With our fixed sizes, tiers and lengths the two are equal.
//   * No overdraft: a balance under the price is refused before anything is called.
//   * A call that positively did not run is released in full; one that MAY have run is HELD (the
//     age-out returns it within the hour). A failed read resolves nothing.
//   * The ✅ path is SYNCHRONOUS up to the reservation (better-sqlite3 is synchronous, so nothing
//     can interleave): card state, reservation and job row are written before the first await.
//     Two taps, two callbacks or a tap racing a new card can never charge twice -- and the
//     reservation's UNIQUE req_key ('proposal:<id>') makes a second one impossible at the database.
//   * A job row exists BEFORE the provider is called, so a restart always knows what was running.
//   * A paid result that could not be sent is re-sent (a duplicate picture is harmless; a missing
//     paid one is not).

import { log, errFields, chatTag } from './log.mjs';
import { nowSec } from './time.mjs';
import { immediate } from './db.mjs';
import { Bucket } from './oonacode.mjs';
import { reserve, settle, release, hold, InsufficientFunds } from './billing.mjs';
import { creditsToMicroUsd } from './money.mjs';
import { MEDIA_MODELS, MediaError, priceFor, usdToMicro, moneyLabel, balanceLabel } from './media.mjs';
import { escapeHtml } from './telegram.mjs';

export const CARD_TTL_SEC = 24 * 3600;
// Telegram refuses a PHOTO over 10 MB; a bigger picture goes as a file.
export const PHOTO_MAX_BYTES = 10 * 1024 * 1024;
// An input image larger than this is sent from Telegram's own (smaller) copy instead of the original.
const ORIGINAL_INPUT_MAX_BYTES = 4 * 1024 * 1024;
const INPUT_MAX_BYTES = 10 * 1024 * 1024;
const REDELIVER_AFTER_SEC = 300;
const MAX_DELIVERY_ATTEMPTS = 4;

const parseIds = (json) => { try { const a = JSON.parse(json || '[]'); return Array.isArray(a) ? a.map(Number).filter(Number.isInteger) : []; } catch { return []; } };
export const item = (db, id) => db.prepare('SELECT * FROM items WHERE id = ?').get(id);

// ---- pricing a job --------------------------------------------------------------------------

// The price on the button, in micro-USD with our margin, and the model that will be called.
export function quoteSpec(offer, spec, marginE6) {
  const q = priceFor(offer, {
    kind: spec.kind,
    inputs: spec.kind === 'image' ? spec.sources.length : 0,
    seconds: spec.seconds ?? 0,
    resolution: spec.resolution ?? null,
    fromImage: spec.kind === 'video' && spec.startItemId !== null && spec.startItemId !== undefined,
  });
  return { priceMicro: usdToMicro(q.usd, marginE6), apiModel: q.apiModel };
}

// ---- cards ----------------------------------------------------------------------------------

// A new card replaces every open one of the chat. Returns the new row and the cards it replaced
// (their messages are edited by sendCard).
export function createProposal(db, chatId, spec, { priceMicro, apiModel }, now = nowSec()) {
  return immediate(db, () => {
    const replaced = db.prepare("SELECT id, message_id FROM proposals WHERE chat_id = ? AND state = 'open'").all(chatId);
    if (replaced.length) {
      db.prepare("UPDATE proposals SET state = 'replaced', decided_at = ? WHERE chat_id = ? AND state = 'open'").run(now, chatId);
    }
    const r = db.prepare(
      `INSERT INTO proposals (chat_id, kind, model, api_model, prompt, summary, shape, seconds, resolution,
                              sources, new_version_of, price_micro, state, expires_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'open', ?, ?)`
    ).run(chatId, spec.kind, spec.model, apiModel, spec.prompt, spec.summary, spec.shape,
      spec.kind === 'video' ? spec.seconds : null, spec.kind === 'video' ? spec.resolution : null,
      JSON.stringify(spec.sources), spec.newVersionOf ?? null, Number(priceMicro), now + CARD_TTL_SEC, now);
    return { proposal: db.prepare('SELECT * FROM proposals WHERE id = ?').get(r.lastInsertRowid), replaced };
  });
}

export function cardText(p, { balanceMicro = null, status = null } = {}) {
  const sources = parseIds(p.sources);
  const lines = [
    p.kind === 'video'
      ? `🎬 <b>Video</b> · ${escapeHtml(p.shape)} · ${escapeHtml(String(p.seconds))} s · ${escapeHtml(p.resolution ?? '')}`
      : `🎨 <b>Picture</b> · ${escapeHtml(p.shape)}`,
    escapeHtml(p.summary),
  ];
  if (p.new_version_of) lines.push(`<i>A new version of #${p.new_version_of}${sources.length ? `, starting from #${sources[0]}` : ''}.</i>`);
  else if (p.kind === 'video' && sources.length) lines.push(`<i>Starts from #${sources[0]}.</i>`);
  else if (sources.length) lines.push(`<i>Changes ${sources.map((s) => `#${s}`).join(', ')}.</i>`);
  lines.push('', `Price: <b>${moneyLabel(p.price_micro)}</b>`
    + (balanceMicro === null ? '' : ` · your balance ${balanceLabel(balanceMicro)}`));
  if (status) lines.push('', `<i>${status}</i>`);
  return lines.join('\n');
}

export const cardKeyboard = (p) => ({
  inline_keyboard: [[
    { text: `✅ Make it · ${moneyLabel(p.price_micro)}`, callback_data: `sc:${p.id}` },
    { text: '✖ Cancel', callback_data: `sx:${p.id}` },
  ]],
});

const balanceOf = (db, chatId) => db.prepare('SELECT balance_micro_usd b FROM users WHERE chat_id = ?').get(chatId)?.b ?? 0;

// Show a card, and mark the ones it replaced.
export async function sendCard(deps, { proposal: p, replaced = [] }) {
  const { db, tg } = deps;
  for (const r of replaced) await setCardStatus(deps, r.id, 'Replaced by a newer card.');
  const sent = await tg.sendMessage(p.chat_id, cardText(p, { balanceMicro: balanceOf(db, p.chat_id) }), { reply_markup: cardKeyboard(p) });
  if (sent.ok) db.prepare('UPDATE proposals SET message_id = ? WHERE id = ?').run(sent.result?.message_id ?? null, p.id);
  return sent;
}

// Re-render a card with a status line and no buttons. Cosmetic: a card that cannot be edited
// (too old, deleted) changes nothing about the money.
export async function setCardStatus(deps, proposalId, status, { keepButtons = false } = {}) {
  const { db, tg } = deps;
  const p = db.prepare('SELECT * FROM proposals WHERE id = ?').get(proposalId);
  if (!p?.message_id) return;
  try {
    await tg.call('editMessageText', {
      chat_id: p.chat_id, message_id: p.message_id, parse_mode: 'HTML',
      text: cardText(p, { status, balanceMicro: keepButtons ? balanceOf(db, p.chat_id) : null }),
      reply_markup: keepButtons ? cardKeyboard(p) : { inline_keyboard: [] },
    });
  } catch { /* cosmetic */ }
}

export function cancelProposal(db, chatId, proposalId, now = nowSec()) {
  return db.prepare("UPDATE proposals SET state = 'cancelled', decided_at = ? WHERE id = ? AND chat_id = ? AND state = 'open'")
    .run(now, proposalId, chatId).changes === 1;
}

export function expireCards(db, now = nowSec()) {
  return db.prepare("UPDATE proposals SET state = 'expired', decided_at = ? WHERE state = 'open' AND expires_at < ?").run(now, now).changes;
}

// ---- ✅ -----------------------------------------------------------------------------------

// Everything up to and including the reservation, SYNCHRONOUSLY (see the header). Returns
//   { ok, proposal, reservationId, jobId }                  -- the job may start
//   { repriced: priceMicro, proposal }                      -- the card now shows the new price
//   { short: { needMicro, haveMicro }, proposal }           -- not enough balance; card still open
//   { refused: <reason>, proposal? }                        -- nothing happened
export function beginJob(db, { chatId, proposalId, offer, marginE6, now = nowSec() }) {
  const p = db.prepare('SELECT * FROM proposals WHERE id = ?').get(proposalId);
  if (!p || p.chat_id !== chatId) return { refused: 'gone' };
  if (p.state !== 'open') return { refused: p.state, proposal: p };
  if (p.expires_at < now) {
    db.prepare("UPDATE proposals SET state = 'expired', decided_at = ? WHERE id = ? AND state = 'open'").run(now, p.id);
    return { refused: 'expired', proposal: p };
  }
  const o = offer[p.model];
  if (!o) return { refused: 'unavailable', proposal: p };

  // The sources must still be this chat's.
  const sources = parseIds(p.sources);
  for (const id of sources) {
    const it = item(db, id);
    if (!it || it.chat_id !== chatId) return { refused: 'sources', proposal: p };
  }

  // RE-PRICE. The user agreed to the number on the button; if OonaCode's price moved since, they
  // see the new one and press again. Never charge a number they did not see.
  let quote;
  try {
    quote = quoteSpec(o, {
      kind: p.kind, sources, seconds: p.seconds, resolution: p.resolution,
      startItemId: p.kind === 'video' && sources.length ? sources[0] : null,
    }, marginE6);
  } catch {
    return { refused: 'unavailable', proposal: p };
  }
  if (quote.priceMicro !== BigInt(p.price_micro) || quote.apiModel !== p.api_model) {
    db.prepare('UPDATE proposals SET price_micro = ?, api_model = ? WHERE id = ?').run(Number(quote.priceMicro), quote.apiModel, p.id);
    return { repriced: quote.priceMicro, proposal: db.prepare('SELECT * FROM proposals WHERE id = ?').get(p.id) };
  }

  // One running job of each kind per chat.
  const running = db.prepare("SELECT id FROM media_jobs WHERE chat_id = ? AND kind = ? AND state = 'running'").get(chatId, p.kind);
  if (running) return { refused: p.kind === 'video' ? 'busy_video' : 'busy_image', proposal: p };

  if (db.prepare("UPDATE proposals SET state = 'started', decided_at = ? WHERE id = ? AND state = 'open'").run(now, p.id).changes !== 1) {
    return { refused: 'raced', proposal: p };
  }
  let resv;
  try {
    resv = reserve(db, { chatId, reqKey: `proposal:${p.id}`, model: p.model, microUsd: BigInt(p.price_micro), allowOverdraft: false });
  } catch (e) {
    // Put the card back -- unless a newer one appeared meanwhile, which replaces it.
    const newer = db.prepare("SELECT id FROM proposals WHERE chat_id = ? AND state = 'open' AND id > ?").get(chatId, p.id);
    db.prepare('UPDATE proposals SET state = ?, decided_at = NULL WHERE id = ?').run(newer ? 'replaced' : 'open', p.id);
    if (e instanceof InsufficientFunds) return { short: { needMicro: BigInt(p.price_micro), haveMicro: BigInt(e.available) }, proposal: p };
    throw e;
  }
  if (resv.duplicate) return { refused: 'raced', proposal: p };

  const job = db.prepare(
    `INSERT INTO media_jobs (chat_id, kind, model, api_model, shape, reservation_id, state, proposal_id, created_at)
     VALUES (?,?,?,?,?,?, 'running', ?, ?)`
  ).run(chatId, p.kind, p.model, p.api_model, p.shape, resv.reservationId, p.id, now);
  return { ok: true, proposal: { ...p, state: 'started' }, reservationId: resv.reservationId, jobId: Number(job.lastInsertRowid) };
}

// The words for every refusal of ✅.
export function refusalText(r) {
  const m = moneyLabel;
  if (r.short) {
    return `This costs <b>${m(r.short.needMicro)}</b> and your balance is <b>${balanceLabel(r.short.haveMicro)}</b>. `
      + 'Top up and press ✅ again — the card stays open.';
  }
  if (r.repriced !== undefined) return `The price changed to <b>${m(r.repriced)}</b> since the card was made. Press ✅ again if that is fine.`;
  switch (r.refused) {
    case 'started': case 'raced': return null; // a second tap on a card already being made
    case 'done': return 'That card was already made.';
    case 'cancelled': return 'That card was cancelled — ask for it again if you want it.';
    case 'replaced': return 'That card was replaced by a newer one.';
    case 'expired': return 'That card has expired — ask for it again and I will make a new one.';
    case 'failed': return 'That card did not work out — ask for it again if you like.';
    case 'unavailable': return 'That model is not available right now. <b>Nothing has been charged.</b> Please try again in a little while.';
    case 'sources': return 'A picture that card uses is no longer available. <b>Nothing has been charged.</b>';
    case 'busy_image': return 'Your previous picture is still being made — press ✅ again when it arrives.';
    case 'busy_video': return 'Your previous video is still being made — press ✅ again when it arrives.';
    default: return 'That card is no longer available.';
  }
}

// ---- running a job --------------------------------------------------------------------------

function failureText(e, { what }) {
  if (!(e instanceof MediaError)) return `The ${what} could not be made. <b>Nothing has been charged.</b>`;
  if (e.bucket === Bucket.UNKNOWN) {
    return `We lost contact with the ${what} service part-way through. The amount is held and comes back to your balance automatically within the hour unless a charge is recorded.`;
  }
  if (e.bucket === Bucket.BACKOFF || e.bucket === Bucket.NOT_BILLED) {
    return `The ${what} service is busy right now. <b>Nothing has been charged.</b> Press ✅ on a new card to try again.`;
  }
  // PERMANENT: the request itself was refused -- most often a content filter. Say what it said.
  return `The ${what} service refused this request. <b>Nothing has been charged.</b>\n\n<i>${escapeHtml(e.message.slice(0, 200))}</i>`;
}

// Undo a reservation according to how the call failed, and close the job and the card.
function unwind(deps, begun, e, { what }) {
  const { db } = deps;
  const unknown = e instanceof MediaError && e.bucket === Bucket.UNKNOWN;
  const reason = `media: ${e?.message ?? e}`.slice(0, 200);
  if (unknown) hold(db, begun.reservationId, reason);
  else release(db, begun.reservationId, reason);
  db.prepare('UPDATE media_jobs SET state = ?, error = ?, finished_at = ? WHERE id = ? AND state = \'running\'')
    .run(unknown ? 'unknown' : 'failed', String(e?.message ?? e).slice(0, 200), nowSec(), begun.jobId);
  if (begun.proposal.id) {
    db.prepare("UPDATE proposals SET state = 'failed' WHERE id = ?").run(begun.proposal.id);
    deps.note?.(begun.proposal.chat_id, `(Card P${begun.proposal.id} failed: ${String(e?.message ?? e).slice(0, 120)}. ${unknown ? 'Its amount is held.' : 'Nothing was charged.'})`);
  }
  return failureText(e, { what });
}

// Settle what OonaCode charged, capped at the button's price. No credits reported -> the button's
// price: the user agreed to it, and the thing was made.
export function settleCapped(db, reservationId, { credits, marginE6, capMicro, note }) {
  const cap = BigInt(capMicro);
  let charge = cap;
  const c = Number(credits);
  if (Number.isFinite(c) && c >= 0) {
    const actual = creditsToMicroUsd(c, marginE6);
    if (actual > cap) log.error('MEDIA CHARGE ABOVE THE CARD PRICE -- capped at the card; the difference is the house\'s', { reserved: String(cap), actual: String(actual), note });
    charge = actual < cap ? actual : cap;
  } else {
    log.warn('media result reported no credits; settled at the card price', { note });
  }
  settle(db, reservationId, charge, { note });
  return charge;
}

// Pictures a job starts from, as data URIs. The provider's original while it is small and still
// downloadable; otherwise Telegram's own copy (kept for good).
const sniffMime = (b) => (b[0] === 0x89 && b[1] === 0x50 ? 'image/png'
  : b[0] === 0xff && b[1] === 0xd8 ? 'image/jpeg'
  : b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP' ? 'image/webp' : null);

export async function sourceImages(deps, ids) {
  const { db, tg, media } = deps;
  const out = [];
  for (const id of ids) {
    const it = item(db, id);
    if (!it || (it.kind !== 'image' && it.kind !== 'upload')) throw new Error(`#${id} is not a picture`);
    let buf = null;
    if (it.result_url && it.result_expires_at > nowSec() + 60) {
      try { buf = await media.download(it.result_url, { maxBytes: ORIGINAL_INPUT_MAX_BYTES }); } catch { buf = null; }
    }
    if (!buf && it.tg_file_id) {
      const dl = await tg.downloadFile(it.tg_file_id, { maxBytes: INPUT_MAX_BYTES });
      if (dl.ok) buf = dl.buffer;
    }
    if (!buf) throw new Error(`#${id} could not be fetched`);
    const mime = sniffMime(buf);
    if (!mime) throw new Error(`#${id} is not a PNG, JPEG or WebP picture`);
    out.push(`data:${mime};base64,${buf.toString('base64')}`);
  }
  return out;
}

// Make a picture: the ✅ has been paid for (beginJob). Returns text for the user, or null.
export async function runImageJob(deps, begun, { draft = null } = {}) {
  const { db, media, marginE6 } = deps;
  const p = begun.proposal;
  const started = Date.now();
  const status = () => `<i>🎨 Drawing… ${Math.floor((Date.now() - started) / 1000)}s</i>`;
  let tick = null;
  if (draft) {
    await draft.push(status()).catch(() => undefined);
    tick = setInterval(() => { draft.push(status()).catch(() => undefined); }, 5000);
  }
  await setCardStatus(deps, p.id, '⏳ Making it…');

  let images;
  try {
    images = await sourceImages(deps, parseIds(p.sources));
  } catch (e) {
    clearInterval(tick);
    // Nothing was sent to the provider: release in full.
    return unwind(deps, begun, new MediaError(Bucket.PERMANENT, String(e.message)), { what: 'picture' });
  }

  let out;
  try {
    const size = MEDIA_MODELS[p.model]?.sizes?.[p.shape] ?? MEDIA_MODELS[p.model]?.sizes?.square;
    out = await media.generateImage({ model: p.api_model, prompt: p.prompt, size, images });
  } catch (e) {
    clearInterval(tick);
    log.warn('picture failed', { chat: chatTag(p.chat_id), model: p.api_model, bucket: e?.bucket ?? null, err: String(e?.message ?? e).slice(0, 160) });
    await setCardStatus(deps, p.id, e instanceof MediaError && e.bucket === Bucket.UNKNOWN ? 'Interrupted — the amount is held.' : 'Not made — nothing charged.');
    return unwind(deps, begun, e, { what: 'picture' });
  }
  clearInterval(tick);

  // FROM HERE THE PICTURE EXISTS AND IS PAID FOR. Nothing below may unwind the money.
  const credits = out?.usage?.credits;
  settleCapped(db, begun.reservationId, {
    credits, marginE6, capMicro: p.price_micro,
    note: `media ${p.model} P${p.id} credits=${credits ?? '?'} in=${out?.usage?.input_images ?? images.length}`,
  });
  const first = Array.isArray(out?.data) ? out.data[0] : null;
  const expires = Date.parse(out?.expires_at);
  const it = finishJob(db, begun, {
    kind: 'image', credits, url: first?.url ?? null,
    expires: Number.isFinite(expires) ? Math.floor(expires / 1000) : null,
  });
  deps.note?.(p.chat_id, `(Picture #${it.id} was made and sent: ${p.summary})`);
  await setCardStatus(deps, p.id, `✅ Made — #${it.id}`);
  const bytes = first?.b64_json ? Buffer.from(first.b64_json, 'base64') : null;
  await deliverItem(deps, it.id, { bytes });
  log.info('picture delivered', { chat: chatTag(p.chat_id), model: p.api_model, item: it.id, credits, ms: Date.now() - started });
  return null;
}

// The job is done: the item exists (not yet delivered), the card is done.
function finishJob(db, begun, { kind, credits, url, expires }) {
  const p = begun.proposal;
  return immediate(db, () => {
    const sources = parseIds(p.sources);
    const r = db.prepare(
      `INSERT INTO items (chat_id, kind, job_id, proposal_id, summary, prompt, sources, start_item_id,
                          result_url, result_expires_at, delivery_attempts, last_attempt_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?, 0, ?, ?)`
    ).run(p.chat_id, kind, begun.jobId, p.id, p.summary, p.prompt, p.sources,
      kind === 'video' && sources.length ? sources[0] : null, url, expires, nowSec(), nowSec());
    const itemId = Number(r.lastInsertRowid);
    db.prepare(
      `UPDATE media_jobs SET state = 'done', credits = ?, result_url = ?, result_expires_at = ?, item_id = ?, finished_at = ?
        WHERE id = ?`
    ).run(credits === undefined || credits === null ? null : String(credits), url, expires, itemId, nowSec(), begun.jobId);
    db.prepare("UPDATE proposals SET state = 'done' WHERE id = ?").run(p.id);
    return item(db, itemId);
  });
}

// Start a clip. It is made while the user does something else; pollVideos delivers it.
export async function startVideoJob(deps, begun) {
  const { db, tg, media } = deps;
  const p = begun.proposal;
  await setCardStatus(deps, p.id, '⏳ Starting the video…');
  const sources = parseIds(p.sources);
  let image = null;
  try {
    if (sources.length) image = (await sourceImages(deps, [sources[0]]))[0];
  } catch (e) {
    return unwind(deps, begun, new MediaError(Bucket.PERMANENT, String(e.message)), { what: 'video' });
  }

  let job;
  try {
    job = await media.createVideo({
      model: p.api_model, prompt: p.prompt, image,
      resolution: p.resolution, duration: p.seconds,
      // A first frame decides its own shape; a ratio is for text-to-video only.
      ratio: image ? null : (MEDIA_MODELS[p.model]?.ratios?.[p.shape] ?? null),
    });
  } catch (e) {
    log.warn('video could not be started', { chat: chatTag(p.chat_id), bucket: e?.bucket ?? null, err: String(e?.message ?? e).slice(0, 160) });
    await setCardStatus(deps, p.id, e instanceof MediaError && e.bucket === Bucket.UNKNOWN ? 'Interrupted — the amount is held.' : 'Not started — nothing charged.');
    return unwind(deps, begun, e, { what: 'video' });
  }
  if (typeof job?.id !== 'string' || !job.id) {
    // It answered but named no job: something may be running that we cannot find. Hold.
    return unwind(deps, begun, new MediaError(Bucket.UNKNOWN, 'the video service named no job'), { what: 'video' });
  }
  db.prepare('UPDATE media_jobs SET remote_id = ? WHERE id = ?').run(job.id, begun.jobId);
  await setCardStatus(deps, p.id, '⏳ Making the video…');
  const msg = await tg.sendMessage(p.chat_id, '<i>🎬 Making your video — usually 1–5 minutes. It will arrive here; you can keep chatting meanwhile.</i>');
  if (msg.ok) db.prepare('UPDATE media_jobs SET status_message_id = ? WHERE id = ?').run(msg.result?.message_id ?? null, begun.jobId);
  log.info('video started', { chat: chatTag(p.chat_id), model: p.api_model, job: begun.jobId });
  return null;
}

// Read every clip still being made; finish the ones that are done. Safe to run again on the same
// job: a job leaves 'running' exactly once. A row with no remote id is never polled (restart
// recovery handles it).
export async function pollVideos(deps, { maxAgeSec = 45 * 60, now = nowSec } = {}) {
  const { db, tg, media, marginE6 } = deps;
  const jobs = db.prepare("SELECT * FROM media_jobs WHERE kind = 'video' AND state = 'running' AND remote_id IS NOT NULL ORDER BY id").all();
  const counts = { checked: 0, done: 0, failed: 0 };
  for (const j of jobs) {
    counts.checked++;
    const p = j.proposal_id ? db.prepare('SELECT * FROM proposals WHERE id = ?').get(j.proposal_id) : null;
    const begun = { proposal: p ?? { id: null, chat_id: j.chat_id, summary: '', prompt: '', sources: '[]', price_micro: null }, reservationId: j.reservation_id, jobId: j.id };
    let v;
    try {
      v = await media.getVideo(j.remote_id);
    } catch (e) {
      // Not knowing is not an ending. Only a clip far past any normal time is given up on, and
      // its money is HELD, never released: it may yet have been made and charged.
      if (now() - j.created_at > maxAgeSec) {
        const text = unwind(deps, begun, new MediaError(Bucket.UNKNOWN, `unreadable past its time: ${e?.message ?? e}`), { what: 'video' });
        await dropStatus(tg, j);
        await tg.sendMessage(j.chat_id, `Your video is taking far longer than it should, and I can no longer reach the job. ${text}`);
      }
      continue;
    }

    if (v.status === 'failed') {
      const text = unwind(deps, begun, new MediaError(Bucket.PERMANENT, v.error?.message ?? 'failed'), { what: 'video' });
      await dropStatus(tg, j);
      if (p) await setCardStatus(deps, p.id, 'Not made — nothing charged.');
      await tg.sendMessage(j.chat_id, text);
      counts.failed++;
      continue;
    }
    if (v.status !== 'completed') {
      await touchStatus(tg, j, now());
      continue;
    }

    const cap = p ? p.price_micro : null;
    if (j.reservation_id && cap !== null) {
      settleCapped(db, j.reservation_id, {
        credits: v.credits, marginE6, capMicro: cap,
        note: `media ${j.model} P${p.id} credits=${v.credits ?? '?'} seconds=${v.duration ?? '?'} ${v.resolution ?? ''}`.trim(),
      });
    } else if (j.reservation_id) {
      // A clip started by the previous version of the bot (no card): its reservation was its price.
      const r = db.prepare('SELECT micro_usd FROM reservations WHERE id = ?').get(j.reservation_id);
      settleCapped(db, j.reservation_id, { credits: v.credits, marginE6, capMicro: r?.micro_usd ?? 0, note: `media ${j.model} credits=${v.credits ?? '?'}` });
    }
    const expires = Date.parse(v.expires_at);
    const it = finishJob(db, begun, {
      kind: 'video', credits: v.credits, url: v.url ?? null,
      expires: Number.isFinite(expires) ? Math.floor(expires / 1000) : null,
    });
    counts.done++;
    await dropStatus(tg, j);
    if (p) {
      deps.note?.(j.chat_id, `(Video #${it.id} was made and sent: ${p.summary})`);
      await setCardStatus(deps, p.id, `✅ Made — #${it.id}`);
    }
    await deliverItem(deps, it.id);
    log.info('video delivered', { chat: chatTag(j.chat_id), job: j.id, item: it.id, credits: v.credits, secs: now() - j.created_at });
  }
  return counts;
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

// ---- delivery -------------------------------------------------------------------------------

export const resultKeyboard = (itemId) => ({
  inline_keyboard: [[
    { text: '🔁 Again', callback_data: `ag:${itemId}` },
    { text: '📎 Original file', callback_data: `of:${itemId}` },
  ]],
});

const fileIdOf = (result) => {
  if (!result) return null;
  if (Array.isArray(result.photo) && result.photo.length) return result.photo[result.photo.length - 1].file_id ?? null;
  return result.video?.file_id ?? result.document?.file_id ?? result.animation?.file_id ?? null;
};

// Send a made item. The attempt is recorded BEFORE sending, so the re-send sweep never races a
// send in progress. A send that definitely failed falls back to a file; one whose outcome is
// unknown is left to the sweep (a duplicate is harmless, a missing paid result is not).
export async function deliverItem(deps, itemId, { bytes = null } = {}) {
  const { db, tg, media } = deps;
  const it = item(db, itemId);
  if (!it || it.delivered_at) return { ok: !!it?.delivered_at };
  db.prepare('UPDATE items SET delivery_attempts = delivery_attempts + 1, last_attempt_at = ? WHERE id = ?').run(nowSec(), it.id);
  let buf = bytes;
  if (!buf && it.result_url && (it.result_expires_at ?? 0) > nowSec()) {
    try { buf = await media.download(it.result_url); } catch (e) { log.warn('result could not be downloaded for delivery', { item: it.id, ...errFields(e) }); }
  }
  if (!buf) return { ok: false };

  const caption = `<b>#${it.id}</b> · ${escapeHtml(String(it.summary ?? '').slice(0, 300))}`;
  const opts = { caption, replyMarkup: resultKeyboard(it.id) };
  const isVideo = it.kind === 'video';
  let sent = isVideo
    ? await tg.sendVideo(it.chat_id, buf, { ...opts, filename: `video-${it.id}.mp4` })
    : buf.length <= PHOTO_MAX_BYTES
      ? await tg.sendPhoto(it.chat_id, buf, { ...opts, filename: `picture-${it.id}.png`, contentType: sniffMime(buf) ?? 'image/png' })
      : { ok: false, unknown: false };
  if (!sent.ok && !sent.unknown) {
    sent = await tg.sendDocument(it.chat_id, buf, {
      ...opts, filename: `${isVideo ? 'video' : 'picture'}-${it.id}.${isVideo ? 'mp4' : 'png'}`,
      contentType: isVideo ? 'video/mp4' : (sniffMime(buf) ?? 'image/png'),
    });
  }
  if (!sent.ok) {
    log.warn('could not deliver a made item; the sweep will try again', { chat: chatTag(it.chat_id), item: it.id, desc: sent.description ?? null });
    return { ok: false };
  }
  try {
    db.prepare('UPDATE items SET delivered_at = ?, tg_file_id = ?, tg_message_id = ? WHERE id = ?')
      .run(nowSec(), fileIdOf(sent.result), sent.result?.message_id ?? null, it.id);
  } catch (e) {
    // (chat, message) is unique; a clash would mean Telegram reused an id -- keep the delivery.
    db.prepare('UPDATE items SET delivered_at = ?, tg_file_id = ? WHERE id = ?').run(nowSec(), fileIdOf(sent.result), it.id);
    log.warn('item message id not recorded', { item: it.id, ...errFields(e) });
  }
  return { ok: true };
}

// Paid results that never arrived, re-sent while the provider still has them.
export async function redeliverSweep(deps, { now = nowSec() } = {}) {
  const rows = deps.db.prepare(
    `SELECT id FROM items
      WHERE delivered_at IS NULL AND kind IN ('image', 'video') AND delivery_attempts < ?
        AND (last_attempt_at IS NULL OR last_attempt_at < ?)
        AND result_url IS NOT NULL AND result_expires_at > ?`
  ).all(MAX_DELIVERY_ATTEMPTS, now - REDELIVER_AFTER_SEC, now);
  let sent = 0;
  for (const r of rows) if ((await deliverItem(deps, r.id)).ok) sent++;
  return { tried: rows.length, sent };
}

// "Original file": the untouched bytes, as a document. Free.
export async function sendOriginal(deps, { chatId, itemId }) {
  const { db, tg, media } = deps;
  const it = item(db, itemId);
  if (!it || it.chat_id !== chatId || it.kind === 'upload') return 'That file is not available.';
  if (!it.result_url || (it.result_expires_at ?? 0) < nowSec()) {
    return 'The original file is kept for 24 hours and this one has expired — the copy in the chat is still yours to save.';
  }
  let bytes;
  try { bytes = await media.download(it.result_url); } catch { return 'The file could not be fetched just now. Please try again in a moment.'; }
  const video = it.kind === 'video';
  const sent = await tg.sendDocument(chatId, bytes, {
    filename: `${video ? 'video' : 'picture'}-${it.id}.${video ? 'mp4' : 'png'}`,
    contentType: video ? 'video/mp4' : (sniffMime(bytes) ?? 'image/png'),
  });
  return sent.ok ? null : 'The file could not be sent just now. Please try again in a moment.';
}

// ---- a restart ------------------------------------------------------------------------------

// Whatever was being made when the process died. Returns the messages to send to users.
//   * a picture being drawn, or a video whose job id was never recorded: the amount is HELD (it
//     may have been made and charged), the job 'unknown', the card failed, the user told;
//   * a video with a job id keeps running -- pollVideos finishes it;
//   * a card left 'started' with no job (cannot normally happen) becomes 'failed'.
export function recoverAfterRestart(deps) {
  const { db } = deps;
  const msgs = [];
  const lost = db.prepare(
    "SELECT * FROM media_jobs WHERE state = 'running' AND (kind = 'image' OR remote_id IS NULL)"
  ).all();
  for (const j of lost) {
    if (j.reservation_id) hold(db, j.reservation_id, 'bot restarted while this was being made');
    db.prepare("UPDATE media_jobs SET state = 'unknown', error = 'interrupted by a restart', finished_at = ? WHERE id = ?").run(nowSec(), j.id);
    if (j.proposal_id) db.prepare("UPDATE proposals SET state = 'failed' WHERE id = ?").run(j.proposal_id);
    deps.note?.(j.chat_id, `(The ${j.kind === 'video' ? 'video' : 'picture'} being made was interrupted by a restart; its amount is held.)`);
    msgs.push({
      chatId: j.chat_id,
      text: `The bot restarted while your ${j.kind === 'video' ? 'video was starting' : 'picture was being drawn'}. `
        + 'Its amount is held and comes back to your balance within the hour unless a charge is recorded. Sorry — ask me again and I will make a new card.',
    });
  }
  const orphaned = db.prepare(
    "UPDATE proposals SET state = 'failed' WHERE state = 'started' AND id NOT IN (SELECT proposal_id FROM media_jobs WHERE proposal_id IS NOT NULL)"
  ).run().changes;
  const expired = expireCards(db);
  if (lost.length || orphaned || expired) log.info('studio restart recovery', { interrupted: lost.length, orphaned, expired });
  return msgs;
}

// The reservations a restart must NOT release: clips still being made settle through the poller.
export function runningReservationIds(db) {
  return new Set(db.prepare("SELECT reservation_id FROM media_jobs WHERE state = 'running' AND reservation_id IS NOT NULL").all().map((r) => r.reservation_id));
}

// ---- "Again" --------------------------------------------------------------------------------

// A new card for another one like #N, with today's models and prices. Never charges by itself.
export function againSpec(db, { chatId, itemId, settings }) {
  const it = item(db, itemId);
  if (!it || it.chat_id !== chatId || it.kind === 'upload') return null;
  const p = it.proposal_id ? db.prepare('SELECT * FROM proposals WHERE id = ?').get(it.proposal_id) : null;
  if (!p) return null;
  const sources = parseIds(p.sources);
  return {
    kind: p.kind,
    model: p.kind === 'video' ? settings.videoModel : settings.pictureModel,
    prompt: p.prompt,
    summary: p.summary,
    shape: p.shape,
    seconds: p.kind === 'video' ? settings.videoSeconds : null,
    resolution: p.kind === 'video' ? settings.videoResolution : null,
    sources,
    startItemId: p.kind === 'video' && sources.length ? sources[0] : null,
    newVersionOf: null,
  };
}
