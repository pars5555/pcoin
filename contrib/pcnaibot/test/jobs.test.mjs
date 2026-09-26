// Cards, ✅ and the builder's jobs (lib/jobs.mjs) -- the money in every ending.
//
// Pinned: only ✅ moves money, and never more than the button said; two taps charge once; a
// refusal is released in full; a call that may have run is HELD; a restart never loses a paid job
// nor frees one still being made; a paid result that could not be sent is sent again.

import test from 'node:test';
import assert from 'node:assert/strict';

import { nowSec } from '../lib/db.mjs';
import { Bucket } from '../lib/oonacode.mjs';
import { MediaError } from '../lib/media.mjs';
import { hold, reserve } from '../lib/billing.mjs';
import { reconcile } from '../lib/deposits.mjs';
import {
  quoteSpec, createProposal, beginJob, refusalText, runImageJob, startVideoJob, pollVideos, deliverItem,
  redeliverSweep, sendOriginal, recoverAfterRestart, runningReservationIds, againSpec, cancelProposal,
  expireCards, settleCapped, sourceImages, item,
} from '../lib/jobs.mjs';
import {
  MARGIN_E6, OFFER, LISTING, SETTINGS, PNG, JPEG, freshDb, user, fakeTg, fakeMedia, IMAGE_OK, imageSpec, videoSpec, addItem,
} from './fixtures.mjs';
import { mediaOffer } from '../lib/media.mjs';

const card = (db, spec, chatId = 7) => createProposal(db, chatId, spec, quoteSpec(OFFER[spec.model], spec, MARGIN_E6)).proposal;
const deps = (db, tg, media, notes = []) => ({ db, tg, media, marginE6: MARGIN_E6, note: (c, t) => notes.push({ c, t }) });
const reservations = (db) => db.prepare('SELECT state, micro_usd, req_key FROM reservations ORDER BY id').all();

test('reconcile passes while a reservation is HELD (it used to read as drift)', () => {
  const db = freshDb({ balanceMicro: 1_000_000 });
  const r = reserve(db, { chatId: 7, reqKey: 'proposal:1', model: 'm', microUsd: 270000n });
  hold(db, r.reservationId, 'may have run');
  assert.equal(reconcile(db).ok, true, JSON.stringify(reconcile(db).drifts));
});

test('the card price is exactly what is reserved: inputs, photo-to-video, seconds', () => {
  const db = freshDb();
  const src = addItem(db, { kind: 'upload' });
  assert.equal(card(db, imageSpec()).price_micro, 270000);
  assert.equal(card(db, imageSpec({ model: 'qwen-image-3.0-pro', sources: [src, src] })).price_micro, Number(3n * (48000n + 2n * 3600n)));
  const v = card(db, videoSpec({ sources: [src], startItemId: src, seconds: 3, resolution: '480P' }));
  assert.equal(v.api_model, 'happyhorse-1.1-i2v');
  assert.equal(v.price_micro, 756000);
  const b = beginJob(db, { chatId: 7, proposalId: v.id, offer: OFFER, marginE6: MARGIN_E6 });
  assert.equal(b.ok, true);
  assert.deepEqual(reservations(db), [{ state: 'open', micro_usd: 756000, req_key: `proposal:${v.id}` }]);
});

test('a new card replaces the open one', () => {
  const db = freshDb();
  const a = card(db, imageSpec());
  const b = card(db, imageSpec({ summary: 'another' }));
  assert.equal(db.prepare('SELECT state FROM proposals WHERE id = ?').get(a.id).state, 'replaced');
  assert.equal(db.prepare('SELECT state FROM proposals WHERE id = ?').get(b.id).state, 'open');
  assert.equal(beginJob(db, { chatId: 7, proposalId: a.id, offer: OFFER, marginE6: MARGIN_E6 }).refused, 'replaced');
  assert.equal(reservations(db).length, 0);
});

test('two taps on ✅ make one reservation and one job', () => {
  const db = freshDb();
  const p = card(db, imageSpec());
  const first = beginJob(db, { chatId: 7, proposalId: p.id, offer: OFFER, marginE6: MARGIN_E6 });
  const second = beginJob(db, { chatId: 7, proposalId: p.id, offer: OFFER, marginE6: MARGIN_E6 });
  assert.equal(first.ok, true);
  assert.equal(second.refused, 'started');
  assert.equal(refusalText(second), null, 'a second tap is not an error to the user');
  assert.equal(reservations(db).length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM media_jobs').get().n, 1);
  assert.deepEqual(user(db), { b: 1_000_000 - 270000, r: 270000 });
});

test('✅ on a foreign, expired or cancelled card, or with the price list gone, reserves nothing', () => {
  const db = freshDb({ chats: [7, 8] });
  const p = card(db, imageSpec());
  assert.equal(beginJob(db, { chatId: 8, proposalId: p.id, offer: OFFER, marginE6: MARGIN_E6 }).refused, 'gone');
  assert.equal(beginJob(db, { chatId: 7, proposalId: p.id, offer: {}, marginE6: MARGIN_E6 }).refused, 'unavailable');
  assert.equal(beginJob(db, { chatId: 7, proposalId: p.id, offer: OFFER, marginE6: MARGIN_E6, now: nowSec() + 90000 }).refused, 'expired');
  const q = card(db, imageSpec());
  assert.equal(cancelProposal(db, 7, q.id), true);
  assert.equal(beginJob(db, { chatId: 7, proposalId: q.id, offer: OFFER, marginE6: MARGIN_E6 }).refused, 'cancelled');
  const s = card(db, imageSpec());
  assert.equal(expireCards(db, nowSec() + 90000), 1);
  assert.equal(beginJob(db, { chatId: 7, proposalId: s.id, offer: OFFER, marginE6: MARGIN_E6 }).refused, 'expired');
  assert.equal(reservations(db).length, 0);
});

test('a source that is not this chat\'s any more refuses the card', () => {
  const db = freshDb({ chats: [7, 8] });
  const src = addItem(db, { kind: 'upload' });
  const p = card(db, imageSpec({ sources: [src] }));
  db.prepare('UPDATE items SET chat_id = 8 WHERE id = ?').run(src);
  assert.equal(beginJob(db, { chatId: 7, proposalId: p.id, offer: OFFER, marginE6: MARGIN_E6 }).refused, 'sources');
  assert.equal(reservations(db).length, 0);
});

test('not enough balance: nothing moves, the card stays open, and ✅ after a top-up works', () => {
  const db = freshDb({ balanceMicro: 100_000 });
  const p = card(db, imageSpec());
  const b = beginJob(db, { chatId: 7, proposalId: p.id, offer: OFFER, marginE6: MARGIN_E6 });
  assert.deepEqual(b.short, { needMicro: 270000n, haveMicro: 100000n });
  assert.match(refusalText(b), /costs <b>\$0\.27<\/b> and your balance is <b>\$0\.10<\/b>/);
  assert.deepEqual(user(db), { b: 100_000, r: 0 });
  assert.equal(db.prepare('SELECT state FROM proposals WHERE id = ?').get(p.id).state, 'open');
  db.prepare('UPDATE users SET balance_micro_usd = 500000 WHERE chat_id = 7').run();
  assert.equal(beginJob(db, { chatId: 7, proposalId: p.id, offer: OFFER, marginE6: MARGIN_E6 }).ok, true);
});

test('a price rise re-prices the card and charges nothing', () => {
  const db = freshDb();
  const p = card(db, imageSpec());
  const dearer = mediaOffer(LISTING.map((m) => (m.id === 'wan2.7-image-pro' ? { ...m, pricing: { ...m.pricing, tiers: { default: 0.12 } } } : m)));
  const b = beginJob(db, { chatId: 7, proposalId: p.id, offer: dearer, marginE6: MARGIN_E6 });
  assert.equal(b.repriced, 360000n);
  assert.equal(db.prepare('SELECT price_micro, state FROM proposals WHERE id = ?').get(p.id).price_micro, 360000);
  assert.equal(reservations(db).length, 0);
  assert.equal(beginJob(db, { chatId: 7, proposalId: p.id, offer: dearer, marginE6: MARGIN_E6 }).ok, true, 'the second ✅ is at the price shown');
});

test('a settle above the button is capped at the button; no credits reported is the button', () => {
  const db = freshDb();
  const a = reserve(db, { chatId: 7, reqKey: 'proposal:a', model: 'm', microUsd: 270000n });
  assert.equal(settleCapped(db, a.reservationId, { credits: 120, marginE6: MARGIN_E6, capMicro: 270000, note: 'x' }), 270000n);
  const b = reserve(db, { chatId: 7, reqKey: 'proposal:b', model: 'm', microUsd: 270000n });
  assert.equal(settleCapped(db, b.reservationId, { credits: 48, marginE6: MARGIN_E6, capMicro: 270000, note: 'y' }), 144000n);
  const c = reserve(db, { chatId: 7, reqKey: 'proposal:c', model: 'm', microUsd: 270000n });
  assert.equal(settleCapped(db, c.reservationId, { credits: undefined, marginE6: MARGIN_E6, capMicro: 270000, note: 'z' }), 270000n);
  assert.deepEqual(user(db), { b: 1_000_000 - 270000 - 144000 - 270000, r: 0 });
  assert.equal(reconcile(db).ok, true);
});

test('a picture: charged exactly, made into #N, delivered with its buttons, recorded for the agent', async () => {
  const db = freshDb();
  const tg = fakeTg();
  const media = fakeMedia({ image: IMAGE_OK(90) });
  const notes = [];
  const p = card(db, imageSpec({ shape: 'wide' }));
  const b = beginJob(db, { chatId: 7, proposalId: p.id, offer: OFFER, marginE6: MARGIN_E6 });
  assert.equal(await runImageJob(deps(db, tg, media, notes), b), null);

  assert.equal(media.calls[0].req.size, '2048x1152');
  assert.deepEqual(user(db), { b: 1_000_000 - 270000, r: 0 });
  const led = db.prepare("SELECT * FROM ledger WHERE chat_id = 7 AND kind = 'ai_turn'").get();
  assert.equal(led.delta_micro_usd, -270000);
  assert.equal(led.idem_key, `turn:api:proposal:${p.id}`, 'one charge per card, whatever happens');
  assert.match(led.note, new RegExp(`^media wan2\\.7-image-pro P${p.id} credits=90`));
  const it = db.prepare('SELECT * FROM items').get();
  assert.equal(it.kind, 'image');
  assert.equal(it.summary, 'A red fox in the snow');
  assert.ok(it.delivered_at);
  assert.equal(it.tg_file_id, `PHOTO-${it.tg_message_id}`, 'the largest photo size is kept for editing later');
  const photo = tg.sent.find((s) => s.kind === 'photo');
  assert.match(photo.caption, new RegExp(`^<b>#${it.id}</b>`));
  assert.deepEqual(photo.keyboard.inline_keyboard[0].map((k) => k.callback_data), [`ag:${it.id}`, `of:${it.id}`]);
  assert.equal(db.prepare('SELECT state FROM proposals WHERE id = ?').get(p.id).state, 'done');
  assert.equal(db.prepare('SELECT state, item_id FROM media_jobs').get().item_id, it.id);
  assert.ok(notes.some((n) => n.t.includes(`Picture #${it.id} was made`)));
  assert.equal(reconcile(db).ok, true);
});

test('a refused picture (a content filter) is released in full and says why', async () => {
  const db = freshDb();
  const tg = fakeTg();
  const p = card(db, imageSpec());
  const b = beginJob(db, { chatId: 7, proposalId: p.id, offer: OFFER, marginE6: MARGIN_E6 });
  const text = await runImageJob(deps(db, tg, fakeMedia({ image: new MediaError(Bucket.PERMANENT, 'DataInspectionFailed: input', { status: 400 }) })), b);
  assert.match(text, /refused this request\. <b>Nothing has been charged\.<\/b>/);
  assert.deepEqual(user(db), { b: 1_000_000, r: 0 });
  assert.equal(reservations(db)[0].state, 'released');
  assert.equal(db.prepare('SELECT state FROM media_jobs').get().state, 'failed');
  assert.equal(db.prepare('SELECT state FROM proposals').get().state, 'failed');
});

test('a lost connection is HELD: the picture may have been made and charged', async () => {
  const db = freshDb();
  const p = card(db, imageSpec());
  const b = beginJob(db, { chatId: 7, proposalId: p.id, offer: OFFER, marginE6: MARGIN_E6 });
  const text = await runImageJob(deps(db, fakeTg(), fakeMedia({ image: new MediaError(Bucket.UNKNOWN, 'no answer within 300 s') })), b);
  assert.match(text, /held and comes back/);
  assert.deepEqual(user(db), { b: 1_000_000 - 270000, r: 270000 });
  assert.equal(reservations(db)[0].state, 'held');
  assert.equal(db.prepare('SELECT state FROM media_jobs').get().state, 'unknown');
  assert.equal(reconcile(db).ok, true);
});

test('a source that cannot be fetched releases in full, before the provider is called', async () => {
  const db = freshDb();
  const src = addItem(db, { kind: 'upload' });
  const p = card(db, imageSpec({ sources: [src] }));
  const b = beginJob(db, { chatId: 7, proposalId: p.id, offer: OFFER, marginE6: MARGIN_E6 });
  const media = fakeMedia({ image: IMAGE_OK() });
  await runImageJob(deps(db, fakeTg({ download: null }), media), b);
  assert.equal(media.calls.filter((c) => c.op === 'image').length, 0);
  assert.deepEqual(user(db), { b: 1_000_000, r: 0 });
});

test('sources: the original while it is small, else Telegram\'s copy; never a non-picture', async () => {
  const db = freshDb();
  const withUrl = addItem(db, { kind: 'image', url: 'https://x.example/o.png' });
  const tgOnly = addItem(db, { kind: 'upload' });
  const tg = fakeTg({ download: JPEG });
  const uris = await sourceImages({ db, tg, media: fakeMedia({ bytes: PNG }) }, [withUrl, tgOnly]);
  assert.match(uris[0], /^data:image\/png;base64,/);
  assert.match(uris[1], /^data:image\/jpeg;base64,/);
  const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]);
  const viaTg = await sourceImages({ db, tg, media: fakeMedia({ bytes: big }) }, [withUrl]);
  assert.match(viaTg[0], /^data:image\/jpeg;base64,/, 'too big an original goes via the Telegram copy');
  const vid = addItem(db, { kind: 'video' });
  await assert.rejects(sourceImages({ db, tg, media: fakeMedia() }, [vid]), /not a picture/);
  await assert.rejects(sourceImages({ db, tg: fakeTg({ download: Buffer.from('nope') }), media: fakeMedia() }, [tgOnly]), /not a PNG/);
});

test('a video: started with the job written down, finished by the poller, charged, delivered', async () => {
  const db = freshDb({ balanceMicro: 5_000_000 });
  const tg = fakeTg();
  const src = addItem(db, { kind: 'upload' });
  const p = card(db, videoSpec({ sources: [src], startItemId: src }));
  const b = beginJob(db, { chatId: 7, proposalId: p.id, offer: OFFER, marginE6: MARGIN_E6 });
  assert.ok(runningReservationIds(db).has(b.reservationId), 'a restart must not release it');
  const media = fakeMedia({ video: { id: 'vid_1', status: 'queued' } });
  assert.equal(await startVideoJob(deps(db, tg, media), b), null);
  const req = media.calls.find((c) => c.op === 'video').req;
  assert.equal(req.model, 'happyhorse-1.1-i2v');
  assert.equal(req.ratio, null, 'a first frame decides its own shape');
  assert.match(req.image, /^data:image\/jpeg;base64,/);
  assert.equal(db.prepare('SELECT remote_id FROM media_jobs').get().remote_id, 'vid_1');

  media.getVideo = async () => ({ id: 'vid_1', status: 'completed', credits: 840, duration: 5, resolution: '720P', url: 'https://x.example/v.mp4', expires_at: new Date(Date.now() + 86400e3).toISOString() });
  const c = await pollVideos(deps(db, tg, media));
  assert.equal(c.done, 1);
  assert.deepEqual(user(db), { b: 5_000_000 - 2_520_000, r: 0 });
  const it = db.prepare("SELECT * FROM items WHERE kind = 'video'").get();
  assert.equal(it.start_item_id, src);
  assert.ok(it.delivered_at);
  assert.ok(tg.sent.some((s) => s.kind === 'video'));
  assert.equal((await pollVideos(deps(db, tg, media))).checked, 0, 'a job leaves running once');
  assert.equal(reconcile(db).ok, true);
});

test('text-to-video asks for the shape\'s ratio; a failed clip costs nothing', async () => {
  const db = freshDb({ balanceMicro: 5_000_000 });
  const tg = fakeTg();
  const p = card(db, videoSpec({ shape: 'tall' }));
  const b = beginJob(db, { chatId: 7, proposalId: p.id, offer: OFFER, marginE6: MARGIN_E6 });
  const media = fakeMedia({ video: { id: 'vid_2', status: 'queued' }, videoView: { id: 'vid_2', status: 'failed', error: { message: 'content filter' } } });
  await startVideoJob(deps(db, tg, media), b);
  assert.equal(media.calls.find((c) => c.op === 'video').req.ratio, '9:16');
  await pollVideos(deps(db, tg, media));
  assert.deepEqual(user(db), { b: 5_000_000, r: 0 });
  assert.ok(tg.sent.some((s) => s.kind === 'message' && /Nothing has been charged/.test(s.text)));
});

test('one video at a time: ✅ on a second video card waits', () => {
  const db = freshDb({ balanceMicro: 9_000_000 });
  const p = card(db, videoSpec());
  assert.equal(beginJob(db, { chatId: 7, proposalId: p.id, offer: OFFER, marginE6: MARGIN_E6 }).ok, true);
  const q = card(db, videoSpec({ summary: 'another' }));
  const b = beginJob(db, { chatId: 7, proposalId: q.id, offer: OFFER, marginE6: MARGIN_E6 });
  assert.equal(b.refused, 'busy_video');
  assert.equal(db.prepare('SELECT state FROM proposals WHERE id = ?').get(q.id).state, 'open', 'it can be pressed again later');
  assert.equal(reservations(db).length, 1);
});

test('restart: a picture being drawn is HELD and its owner told; a video with a job id keeps going', () => {
  const db = freshDb({ balanceMicro: 9_000_000 });
  const pic = beginJob(db, { chatId: 7, proposalId: card(db, imageSpec()).id, offer: OFFER, marginE6: MARGIN_E6 });
  const vid = beginJob(db, { chatId: 7, proposalId: card(db, videoSpec()).id, offer: OFFER, marginE6: MARGIN_E6 });
  db.prepare("UPDATE media_jobs SET remote_id = 'vid_9' WHERE id = ?").run(vid.jobId);
  // A stranded one: started, with no job (cannot normally happen).
  const stray = card(db, imageSpec({ summary: 'stray' }));
  db.prepare("UPDATE proposals SET state = 'started' WHERE id = ?").run(stray.id);

  const msgs = recoverAfterRestart({ db, note: () => {} });
  assert.equal(msgs.length, 1);
  assert.match(msgs[0].text, /restarted while your picture was being drawn/);
  assert.equal(db.prepare('SELECT state FROM reservations WHERE id = ?').get(pic.reservationId).state, 'held');
  assert.equal(db.prepare('SELECT state FROM media_jobs WHERE id = ?').get(pic.jobId).state, 'unknown');
  assert.equal(db.prepare('SELECT state FROM media_jobs WHERE id = ?').get(vid.jobId).state, 'running');
  assert.ok(runningReservationIds(db).has(vid.reservationId));
  assert.equal(db.prepare('SELECT state FROM proposals WHERE id = ?').get(stray.id).state, 'failed');
  assert.equal(reconcile(db).ok, true);
});

test('restart: a video whose job id was never recorded is held, and never polled', async () => {
  const db = freshDb({ balanceMicro: 9_000_000 });
  const vid = beginJob(db, { chatId: 7, proposalId: card(db, videoSpec()).id, offer: OFFER, marginE6: MARGIN_E6 });
  const media = fakeMedia();
  assert.equal((await pollVideos(deps(db, fakeTg(), media))).checked, 0, 'no remote id: nothing to poll');
  recoverAfterRestart({ db, note: () => {} });
  assert.equal(db.prepare('SELECT state FROM reservations WHERE id = ?').get(vid.reservationId).state, 'held');
});

test('a send that timed out is not lost: the sweep sends it again; a refused photo goes as a file', async () => {
  const db = freshDb();
  const p = card(db, imageSpec());
  const b = beginJob(db, { chatId: 7, proposalId: p.id, offer: OFFER, marginE6: MARGIN_E6 });
  await runImageJob(deps(db, fakeTg({ unknown: ['photo'] }), fakeMedia({ image: IMAGE_OK() })), b);
  const it = db.prepare('SELECT * FROM items').get();
  assert.equal(it.delivered_at, null, 'paid but not known to have arrived');
  assert.equal((await redeliverSweep(deps(db, fakeTg(), fakeMedia()))).tried, 0, 'not while the first attempt is fresh');
  const later = await redeliverSweep(deps(db, fakeTg(), fakeMedia()), { now: nowSec() + 600 });
  assert.deepEqual(later, { tried: 1, sent: 1 });
  assert.ok(db.prepare('SELECT delivered_at FROM items').get().delivered_at);

  const db2 = freshDb();
  const b2 = beginJob(db2, { chatId: 7, proposalId: card(db2, imageSpec()).id, offer: OFFER, marginE6: MARGIN_E6 });
  const tg2 = fakeTg({ fail: ['photo'] });
  await runImageJob(deps(db2, tg2, fakeMedia({ image: IMAGE_OK() })), b2);
  const it2 = db2.prepare('SELECT * FROM items').get();
  assert.ok(it2.delivered_at);
  assert.equal(it2.tg_file_id, `DOC-${it2.tg_message_id}`);
});

test('"Original file" is free, only for your own results, and refuses an expired one', async () => {
  const db = freshDb({ chats: [7, 8] });
  const tg = fakeTg();
  const id = addItem(db, { kind: 'image', url: 'https://x.example/o.png' });
  const before = user(db).b;
  assert.equal(await sendOriginal({ db, tg, media: fakeMedia() }, { chatId: 7, itemId: id }), null);
  assert.equal(user(db).b, before);
  assert.ok(tg.sent.some((s) => s.kind === 'document'));
  assert.match(await sendOriginal({ db, tg, media: fakeMedia() }, { chatId: 8, itemId: id }), /not available/);
  db.prepare('UPDATE items SET result_expires_at = ? WHERE id = ?').run(nowSec() - 1, id);
  assert.match(await sendOriginal({ db, tg, media: fakeMedia() }, { chatId: 7, itemId: id }), /expired/);
});

test('"Again" makes a new card with today\'s models -- it never charges by itself', async () => {
  const db = freshDb();
  const p = card(db, imageSpec({ model: 'qwen-image-3.0-pro', shape: 'tall' }));
  const b = beginJob(db, { chatId: 7, proposalId: p.id, offer: OFFER, marginE6: MARGIN_E6 });
  await runImageJob(deps(db, fakeTg(), fakeMedia({ image: IMAGE_OK(48) })), b);
  const it = db.prepare('SELECT * FROM items').get();
  const spent = user(db).b;
  const spec = againSpec(db, { chatId: 7, itemId: it.id, settings: SETTINGS });
  assert.equal(spec.model, 'wan2.7-image-pro', 'the admin\'s current picture model');
  assert.equal(spec.shape, 'tall');
  assert.equal(spec.prompt, 'a red fox in snow');
  assert.equal(user(db).b, spent);
  assert.equal(againSpec(db, { chatId: 8, itemId: it.id, settings: SETTINGS }), null);
});

test('items are per chat: the same message id in two chats is two items', () => {
  const db = freshDb({ chats: [7, 8] });
  addItem(db, { chatId: 7, messageId: 55 });
  addItem(db, { chatId: 8, messageId: 55 });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM items WHERE tg_message_id = 55').get().n, 2);
  assert.throws(() => addItem(db, { chatId: 7, messageId: 55 }), /UNIQUE/);
  assert.equal(item(db, 1).chat_id, 7);
});
