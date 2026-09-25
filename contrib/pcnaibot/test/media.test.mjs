// Pictures and video straight from the model the user picked (lib/media.mjs).
//
// What is pinned here is the money in every ending: a picture settles exactly what OonaCode
// charged times our margin; a refusal is released in full; a lost connection is HELD, never
// released and never settled at a guess; a failed clip costs nothing; a clip still being made
// survives a restart; and nobody overdraws on a picture.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, pendingMigrations, applyMigration, nowSec } from '../lib/db.mjs';
import { parseScaled } from '../lib/money.mjs';
import { Bucket } from '../lib/oonacode.mjs';
import {
  mediaOffer, priceUsd, usdToMicro, runImage, startVideo, pollVideos, runningReservationIds,
  imageKeyboard, MediaClient, MediaError, PromptMemory, sendOriginal,
} from '../lib/media.mjs';

const MARGIN_E6 = parseScaled('3.0', 6);

// OonaCode's list as measured on 2026-09-25.
const LISTING = [
  { id: 'qwen-image-3.0-pro', modality: 'image', pricing: { currency: 'USD', unit: 'image', tiers: { '1k': 0.048, '2k': 0.09 }, input_image: 0.0036 }, limits: { input_images: { min: 0, max: 3 } } },
  { id: 'wan2.7-image-pro', modality: 'image', pricing: { currency: 'USD', unit: 'image', tiers: { default: 0.09 } }, limits: { input_images: { min: 0, max: 9 } } },
  { id: 'happyhorse-1.1-t2v', modality: 'video', pricing: { currency: 'USD', unit: 'second', tiers: { '480P': 0.084, '720P': 0.168, '1080P': 0.216 } }, limits: {} },
  { id: 'happyhorse-1.1-i2v', modality: 'video', pricing: { currency: 'USD', unit: 'second', tiers: { '480P': 0.084, '720P': 0.168, '1080P': 0.216 } }, limits: {} },
  { id: 'glm-5.3-flash', modality: 'chat' },
];
const OFFER = mediaOffer(LISTING);

function freshDb(balanceMicro = 1_000_000) {
  const dir = mkdtempSync(join(tmpdir(), 'pcnaibot-media-'));
  const db = openDb(join(dir, 'm.db'));
  for (const m of pendingMigrations(db)) applyMigration(db, m);
  db.prepare('INSERT INTO users (chat_id, model, agent_mode, created_at, balance_micro_usd) VALUES (?,?,?,?,?)')
    .run(7, 'qwen-image-3.0-pro', 1, nowSec(), balanceMicro);
  return db;
}
const user = (db) => db.prepare('SELECT balance_micro_usd b, reserved_micro_usd r FROM users WHERE chat_id = 7').get();

function fakeTg() {
  const sent = [];
  let mid = 100;
  const ok = (kind, extra = {}) => { sent.push({ kind, ...extra }); return { ok: true, result: { message_id: ++mid } }; };
  return {
    sent,
    downloadFile: async () => ({ ok: true, buffer: Buffer.from('JPEGDATA') }),
    sendPhoto: async (chatId, buf, o) => ok('photo', { chatId, caption: o.caption, keyboard: o.replyMarkup }),
    sendDocument: async (chatId, buf, o) => ok('document', { chatId, caption: o.caption }),
    sendVideo: async (chatId, buf, o) => ok('video', { chatId, caption: o.caption, keyboard: o.replyMarkup }),
    sendMessage: async (chatId, text) => ok('message', { chatId, text }),
    call: async (method, p) => ok(method, p),
  };
}

function fakeMedia({ image = null, video = null, videoView = null } = {}) {
  const calls = [];
  return {
    calls,
    generateImage: async (req) => { calls.push({ op: 'image', req }); if (image instanceof Error) throw image; return image; },
    createVideo: async (req) => { calls.push({ op: 'video', req }); if (video instanceof Error) throw video; return video; },
    getVideo: async (id) => { calls.push({ op: 'get', id }); if (videoView instanceof Error) throw videoView; return videoView; },
    download: async () => Buffer.from('PNGDATA'),
  };
}

const IMAGE_OK = { data: [{ url: 'https://x.example/a.png' }], expires_at: new Date(Date.now() + 86400e3).toISOString(), usage: { images: 1, input_images: 0, credits: 48 } };

test('only what OonaCode is serving is on sale; a video needs its text-to-video model', () => {
  assert.deepEqual(Object.keys(OFFER).sort(), ['happyhorse-1.1', 'qwen-image-3.0-pro', 'wan2.7-image-pro']);
  const noI2v = mediaOffer(LISTING.filter((m) => m.id !== 'happyhorse-1.1-i2v'));
  assert.ok(noI2v['happyhorse-1.1'], 'text-to-video alone still sells');
  assert.equal(noI2v['happyhorse-1.1'].i2v, null);
  assert.equal(mediaOffer(LISTING.filter((m) => m.id !== 'happyhorse-1.1-t2v'))['happyhorse-1.1'], undefined);
  assert.deepEqual(mediaOffer(null), {});
});

test('prices: the typical picture, the most it can cost, and a clip', () => {
  const q = priceUsd(OFFER['qwen-image-3.0-pro']);
  assert.equal(q.typical, 0.048);
  assert.equal(q.hold, 0.09, 'reserved at the dearest tier, as OonaCode holds it');
  assert.ok(Math.abs(priceUsd(OFFER['qwen-image-3.0-pro'], { inputImages: 1 }).typical - 0.0516) < 1e-9, 'an input photo is billed');
  assert.deepEqual(priceUsd(OFFER['wan2.7-image-pro']), { typical: 0.09, hold: 0.09 });
  assert.ok(Math.abs(priceUsd(OFFER['happyhorse-1.1']).typical - 0.84) < 1e-9, '720P x 5 s');
  // x3 margin, in integer micro-USD.
  assert.equal(usdToMicro(0.048, MARGIN_E6), 144000n);
  assert.equal(usdToMicro(0.84, MARGIN_E6), 2520000n);
});

test('a picture settles exactly what was charged, times the margin, and is sent with its buttons', async () => {
  const db = freshDb(1_000_000);
  const tg = fakeTg();
  const media = fakeMedia({ image: IMAGE_OK });
  const memory = new PromptMemory();
  const r = await runImage({ db, tg, media, marginE6: MARGIN_E6, memory }, { chatId: 7, updateId: 501, offer: OFFER['qwen-image-3.0-pro'], prompt: 'a red fox in snow' });

  assert.equal(r, null);
  assert.equal(media.calls[0].req.size, '1024x1024');
  assert.deepEqual(user(db), { b: 1_000_000 - 144000, r: 0 }, '48 credits x3 = $0.144, nothing left reserved');
  const led = db.prepare('SELECT * FROM ledger WHERE chat_id = 7').get();
  assert.equal(led.delta_micro_usd, -144000);
  assert.match(led.note, /^media qwen-image-3\.0-pro credits=48/);
  const photo = tg.sent.find((s) => s.kind === 'photo');
  assert.match(photo.caption, /\$0\.144/);
  const job = db.prepare('SELECT * FROM media_jobs').get();
  assert.equal(job.state, 'done');
  assert.equal(job.result_url, 'https://x.example/a.png');
  assert.deepEqual(photo.keyboard, imageKeyboard(job.id, 'square'));
  assert.equal(memory.get(job.id).prompt, 'a red fox in snow', 'the words live in memory only');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE sql LIKE '%prompt%' AND name = 'media_jobs'").get().n, 0, 'no prompt column');
  db.close();
});

test('the same update twice makes ONE picture', async () => {
  const db = freshDb(1_000_000);
  const media = fakeMedia({ image: IMAGE_OK });
  const deps = { db, tg: fakeTg(), media, marginE6: MARGIN_E6 };
  await runImage(deps, { chatId: 7, updateId: 777, offer: OFFER['qwen-image-3.0-pro'], prompt: 'x' });
  await runImage(deps, { chatId: 7, updateId: 777, offer: OFFER['qwen-image-3.0-pro'], prompt: 'x' });
  assert.equal(media.calls.length, 1);
  db.close();
});

test('no overdraft on a picture: a balance under its price is refused before anything is called', async () => {
  const db = freshDb(100_000); // $0.10, under qwen's $0.27 hold
  const media = fakeMedia({ image: IMAGE_OK });
  const r = await runImage({ db, tg: fakeTg(), media, marginE6: MARGIN_E6 }, { chatId: 7, updateId: 502, offer: OFFER['qwen-image-3.0-pro'], prompt: 'x' });
  assert.match(r, /costs up to <b>\$0\.27<\/b>/);
  assert.equal(media.calls.length, 0);
  assert.deepEqual(user(db), { b: 100_000, r: 0 });
  db.close();
});

test('a refused picture (a content filter) is released in full and says why', async () => {
  const db = freshDb(1_000_000);
  const media = fakeMedia({ image: new MediaError(Bucket.PERMANENT, 'DataInspectionFailed: Green net check rejected text (input)', { status: 400 }) });
  const r = await runImage({ db, tg: fakeTg(), media, marginE6: MARGIN_E6 }, { chatId: 7, updateId: 503, offer: OFFER['qwen-image-3.0-pro'], prompt: 'x' });
  assert.match(r, /refused this request\. <b>Nothing has been charged\.<\/b>/);
  assert.match(r, /DataInspectionFailed/);
  assert.deepEqual(user(db), { b: 1_000_000, r: 0 });
  assert.equal(db.prepare('SELECT state FROM reservations').get().state, 'released');
  db.close();
});

test('a lost connection is HELD: the picture may have been made and charged', async () => {
  const db = freshDb(1_000_000);
  const media = fakeMedia({ image: new MediaError(Bucket.UNKNOWN, 'no answer within 300 s') });
  const r = await runImage({ db, tg: fakeTg(), media, marginE6: MARGIN_E6 }, { chatId: 7, updateId: 504, offer: OFFER['qwen-image-3.0-pro'], prompt: 'x' });
  assert.match(r, /held and released automatically/);
  assert.deepEqual(user(db), { b: 1_000_000 - 270000, r: 270000 });
  assert.equal(db.prepare('SELECT state FROM reservations').get().state, 'held');
  db.close();
});

test('a picture that reports no cost is HELD, never settled at a guess -- and still delivered', async () => {
  const db = freshDb(1_000_000);
  const tg = fakeTg();
  const media = fakeMedia({ image: { ...IMAGE_OK, usage: { images: 1 } } });
  await runImage({ db, tg, media, marginE6: MARGIN_E6 }, { chatId: 7, updateId: 505, offer: OFFER['qwen-image-3.0-pro'], prompt: 'x' });
  assert.equal(db.prepare('SELECT state FROM reservations').get().state, 'held');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ledger').get().n, 0);
  assert.ok(tg.sent.some((s) => s.kind === 'photo'));
  db.close();
});

test('a photo with a caption is sent as the input image, and billed as one', async () => {
  const db = freshDb(1_000_000);
  const media = fakeMedia({ image: { ...IMAGE_OK, usage: { images: 1, input_images: 1, credits: 51.6 } } });
  await runImage({ db, tg: fakeTg(), media, marginE6: MARGIN_E6 }, {
    chatId: 7, updateId: 506, offer: OFFER['qwen-image-3.0-pro'], prompt: 'make it winter',
    inputs: [{ fileId: 'F1', contentType: 'image/jpeg' }], shape: 'wide',
  });
  assert.deepEqual(media.calls[0].req.images, [`data:image/jpeg;base64,${Buffer.from('JPEGDATA').toString('base64')}`]);
  assert.equal(media.calls[0].req.size, '1536x1024');
  assert.equal(user(db).b, 1_000_000 - 154800);
  db.close();
});

// ---- video ------------------------------------------------------------------------------------

async function startedVideo(db, tg, media) {
  return startVideo({ db, tg, media, marginE6: MARGIN_E6, memory: new PromptMemory() }, {
    chatId: 7, updateId: 601, offer: OFFER['happyhorse-1.1'], prompt: 'a horse running on a beach',
  });
}

test('a clip is written down, running, with its money reserved, before the user is told', async () => {
  const db = freshDb(5_000_000);
  const tg = fakeTg();
  const media = fakeMedia({ video: { id: 'vid_1', status: 'queued' } });
  assert.equal(await startedVideo(db, tg, media), null);
  const job = db.prepare('SELECT * FROM media_jobs').get();
  assert.equal(job.state, 'running');
  assert.equal(job.remote_id, 'vid_1');
  assert.equal(job.api_model, 'happyhorse-1.1-t2v');
  assert.deepEqual(media.calls[0].req, { model: 'happyhorse-1.1-t2v', prompt: 'a horse running on a beach', image: null, resolution: '720P', duration: 5, ratio: '16:9' });
  assert.deepEqual(user(db), { b: 5_000_000 - 2_520_000, r: 2_520_000 });
  assert.ok(runningReservationIds(db).has(job.reservation_id), 'a restart must not release it');
  assert.ok(job.status_message_id);
  db.close();
});

test('one clip at a time', async () => {
  const db = freshDb(9_000_000);
  const media = fakeMedia({ video: { id: 'vid_1', status: 'queued' } });
  await startedVideo(db, fakeTg(), media);
  const r = await startVideo({ db, tg: fakeTg(), media, marginE6: MARGIN_E6 }, { chatId: 7, updateId: 602, offer: OFFER['happyhorse-1.1'], prompt: 'again' });
  assert.match(r, /still being made/);
  assert.equal(media.calls.length, 1);
  db.close();
});

test('a finished clip is settled from its credits, delivered, and its status line removed', async () => {
  const db = freshDb(5_000_000);
  const tg = fakeTg();
  const media = fakeMedia({ video: { id: 'vid_1', status: 'queued' } });
  await startedVideo(db, tg, media);
  media.getVideo = async () => ({ id: 'vid_1', status: 'completed', credits: 840, duration: 5, resolution: '720P', url: 'https://x.example/v.mp4', expires_at: new Date(Date.now() + 86400e3).toISOString() });

  const c = await pollVideos({ db, tg, media, marginE6: MARGIN_E6 });
  assert.equal(c.done, 1);
  assert.deepEqual(user(db), { b: 5_000_000 - 2_520_000, r: 0 });
  assert.equal(db.prepare('SELECT state FROM media_jobs').get().state, 'done');
  assert.ok(tg.sent.some((s) => s.kind === 'video' && /\$2\.52/.test(s.caption)));
  assert.ok(tg.sent.some((s) => s.kind === 'deleteMessage'));
  // A second pass finds nothing to do: a job leaves 'running' once.
  assert.equal((await pollVideos({ db, tg, media, marginE6: MARGIN_E6 })).checked, 0);
  db.close();
});

test('a failed clip costs nothing', async () => {
  const db = freshDb(5_000_000);
  const tg = fakeTg();
  const media = fakeMedia({ video: { id: 'vid_1', status: 'queued' } });
  await startedVideo(db, tg, media);
  media.getVideo = async () => ({ id: 'vid_1', status: 'failed', credits: null, error: { type: 'x', message: 'content filter' } });
  await pollVideos({ db, tg, media, marginE6: MARGIN_E6 });
  assert.deepEqual(user(db), { b: 5_000_000, r: 0 });
  assert.equal(db.prepare('SELECT state FROM media_jobs').get().state, 'failed');
  assert.ok(tg.sent.some((s) => s.kind === 'message' && /Nothing has been charged/.test(s.text)));
  db.close();
});

test('a clip we cannot read keeps waiting -- and past its time is HELD, not released', async () => {
  const db = freshDb(5_000_000);
  const tg = fakeTg();
  const media = fakeMedia({ video: { id: 'vid_1', status: 'queued' }, videoView: new Error('socket hang up') });
  await startedVideo(db, tg, media);
  await pollVideos({ db, tg, media, marginE6: MARGIN_E6 });
  assert.equal(db.prepare('SELECT state FROM media_jobs').get().state, 'running', 'not knowing is not an ending');

  await pollVideos({ db, tg, media, marginE6: MARGIN_E6 }, { now: () => nowSec() + 3600 });
  assert.equal(db.prepare('SELECT state FROM media_jobs').get().state, 'unknown');
  assert.equal(db.prepare('SELECT state FROM reservations').get().state, 'held');
  db.close();
});

test('a clip that could not be started is released; one whose start may have happened is held', async () => {
  const db = freshDb(5_000_000);
  const busy = fakeMedia({ video: new MediaError(Bucket.BACKOFF, 'busy', { status: 503 }) });
  assert.match(await startedVideo(db, fakeTg(), busy), /busy right now/);
  assert.deepEqual(user(db), { b: 5_000_000, r: 0 });
  db.close();

  const db2 = freshDb(5_000_000);
  const lost = fakeMedia({ video: new MediaError(Bucket.UNKNOWN, 'no answer within 60 s') });
  await startedVideo(db2, fakeTg(), lost);
  assert.equal(db2.prepare('SELECT state FROM reservations').get().state, 'held');
  db2.close();
});

test('"Original file" is free and refuses an expired result', async () => {
  const db = freshDb(1_000_000);
  const tg = fakeTg();
  await runImage({ db, tg, media: fakeMedia({ image: IMAGE_OK }), marginE6: MARGIN_E6 }, { chatId: 7, updateId: 507, offer: OFFER['wan2.7-image-pro'], prompt: 'x' });
  const job = db.prepare('SELECT * FROM media_jobs').get();
  const before = user(db).b;
  assert.equal(await sendOriginal({ db, tg, media: fakeMedia() }, { chatId: 7, jobId: job.id }), null);
  assert.equal(user(db).b, before);
  assert.ok(tg.sent.some((s) => s.kind === 'document'));
  db.prepare('UPDATE media_jobs SET result_expires_at = ? WHERE id = ?').run(nowSec() - 1, job.id);
  assert.match(await sendOriginal({ db, tg, media: fakeMedia() }, { chatId: 7, jobId: job.id }), /expired/);
  assert.match(await sendOriginal({ db, tg, media: fakeMedia() }, { chatId: 8, jobId: job.id }), /not available/, "another chat's file is not yours");
  db.close();
});

test('the client classifies an answer the way every other gateway call does', async () => {
  const answer = (status, json) => async () => new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
  const refused = new MediaClient('https://api.example', 'k', { fetchImpl: answer(400, { type: 'error', error: { type: 'invalid_request_error', message: 'DataInspectionFailed' } }) });
  await assert.rejects(refused.generateImage({ model: 'm', prompt: 'p', size: '1024x1024' }), (e) => e instanceof MediaError && e.bucket === Bucket.PERMANENT && /DataInspectionFailed/.test(e.message));

  const html502 = new MediaClient('https://api.example', 'k', { fetchImpl: async () => new Response('<html>502</html>', { status: 502, headers: { 'content-type': 'text/html' } }) });
  await assert.rejects(html502.generateImage({ model: 'm', prompt: 'p', size: '1' }), (e) => e.bucket === Bucket.UNKNOWN);

  const dropped = new MediaClient('https://api.example', 'k', { fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(dropped.generateImage({ model: 'm', prompt: 'p', size: '1' }), (e) => e.bucket === Bucket.UNKNOWN);

  const refusedConn = new MediaClient('https://api.example', 'k', { fetchImpl: async () => { const e = new TypeError('fetch failed'); e.cause = { code: 'ECONNREFUSED' }; throw e; } });
  await assert.rejects(refusedConn.generateImage({ model: 'm', prompt: 'p', size: '1' }), (e) => e.bucket === Bucket.PERMANENT);
});

test('the buttons under a picture offer the other shapes', () => {
  const k = imageKeyboard(5, 'wide');
  const labels = k.inline_keyboard.flat().map((b) => b.callback_data);
  assert.deepEqual(labels, ['mj:5:again', 'mj:5:square', 'mj:5:tall', 'mj:5:file']);
});
