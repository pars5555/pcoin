// Shared setup for the studio tests: OonaCode's media list as measured, a fresh database, and fakes
// for Telegram, the builder and the chat model. No tests here.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, pendingMigrations, applyMigration, nowSec } from '../lib/db.mjs';
import { parseScaled } from '../lib/money.mjs';
import { mediaOffer } from '../lib/media.mjs';
import { DEFAULT_SETTINGS } from '../lib/settings.mjs';

export const MARGIN_E6 = parseScaled('3.0', 6);

// OonaCode's list as measured on 2026-09-25/26.
export const LISTING = [
  { id: 'qwen-image-3.0-pro', modality: 'image', pricing: { currency: 'USD', unit: 'image', tiers: { '1k': 0.048, '2k': 0.09 }, input_image: 0.0036 }, limits: { input_images: { min: 0, max: 3 } } },
  { id: 'wan2.7-image-pro', modality: 'image', pricing: { currency: 'USD', unit: 'image', tiers: { default: 0.09 } }, limits: { input_images: { min: 0, max: 9 } } },
  { id: 'happyhorse-1.1-t2v', modality: 'video', pricing: { currency: 'USD', unit: 'second', tiers: { '480P': 0.084, '720P': 0.168, '1080P': 0.216 } }, limits: { durations: { min: 3, max: 15 } } },
  { id: 'happyhorse-1.1-i2v', modality: 'video', pricing: { currency: 'USD', unit: 'second', tiers: { '480P': 0.084, '720P': 0.168, '1080P': 0.216 } }, limits: { durations: { min: 3, max: 15 } } },
  { id: 'mimo-v2.5', modality: 'chat' },
];
export const OFFER = mediaOffer(LISTING);
export const SETTINGS = { ...DEFAULT_SETTINGS };

export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('PNGBODY')]);
export const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('JPEGBODY')]);

export function freshDb({ balanceMicro = 1_000_000, chats = [7] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pcnaibot-studio-'));
  const db = openDb(join(dir, 's.db'));
  for (const m of pendingMigrations(db)) applyMigration(db, m);
  for (const c of chats) {
    db.prepare('INSERT INTO users (chat_id, model, created_at, balance_micro_usd) VALUES (?,?,?,?)').run(c, 'studio', nowSec(), balanceMicro);
    // The money came from somewhere: a ledger row, so reconcile() closes from the start.
    db.prepare(`INSERT INTO ledger (chat_id, delta_micro_usd, kind, idem_key, note, created_at) VALUES (?,?, 'adjust', ?, 'test seed', ?)`)
      .run(c, balanceMicro, `seed:${c}`, nowSec());
  }
  return db;
}
export const user = (db, chatId = 7) => db.prepare('SELECT balance_micro_usd b, reserved_micro_usd r FROM users WHERE chat_id = ?').get(chatId);

// Telegram. `fail` names methods that answer a definite refusal; `unknown` methods that time out.
export function fakeTg({ fail = [], unknown = [], download = JPEG } = {}) {
  const sent = [];
  let mid = 100;
  const send = (kind, extra, result) => {
    if (unknown.includes(kind)) { sent.push({ kind, lost: true, ...extra }); return { ok: false, unknown: true, description: 'timeout' }; }
    if (fail.includes(kind)) { sent.push({ kind, refused: true, ...extra }); return { ok: false, unknown: false, description: 'Bad Request' }; }
    const message_id = ++mid;
    sent.push({ kind, message_id, ...extra });
    return { ok: true, result: { message_id, ...result } };
  };
  return {
    sent,
    downloads: 0,
    async downloadFile() { this.downloads++; return download ? { ok: true, buffer: download } : { ok: false, reason: 'gone' }; },
    sendPhoto: async (chatId, buf, o) => send('photo', { chatId, caption: o.caption, keyboard: o.replyMarkup }, { photo: [{ file_id: 'small' }, { file_id: `PHOTO-${mid + 1}` }] }),
    sendDocument: async (chatId, buf, o) => send('document', { chatId, caption: o.caption }, { document: { file_id: `DOC-${mid + 1}` } }),
    sendVideo: async (chatId, buf, o) => send('video', { chatId, caption: o.caption, keyboard: o.replyMarkup }, { video: { file_id: `VID-${mid + 1}` } }),
    sendMessage: async (chatId, text, extra = {}) => send('message', { chatId, text, keyboard: extra.reply_markup }),
    call: async (method, p) => send(method, p),
  };
}

// The builder.
export function fakeMedia({ image = null, video = null, videoView = null, bytes = PNG } = {}) {
  const calls = [];
  return {
    calls,
    generateImage: async (req) => { calls.push({ op: 'image', req }); if (image instanceof Error) throw image; return image; },
    createVideo: async (req) => { calls.push({ op: 'video', req }); if (video instanceof Error) throw video; return video; },
    getVideo: async (id) => { calls.push({ op: 'get', id }); if (videoView instanceof Error) throw videoView; return typeof videoView === 'function' ? videoView() : videoView; },
    download: async (url, opts = {}) => {
      calls.push({ op: 'download', url });
      if (bytes instanceof Error) throw bytes;
      if (opts.maxBytes && bytes.length > opts.maxBytes) throw new Error('too big');
      return bytes;
    },
  };
}

export const IMAGE_OK = (credits = 90) => ({
  data: [{ url: 'https://x.example/a.png' }],
  expires_at: new Date(Date.now() + 86400e3).toISOString(),
  usage: { images: 1, input_images: 0, credits },
});

export function imageSpec(over = {}) {
  return { kind: 'image', model: 'wan2.7-image-pro', prompt: 'a red fox in snow', summary: 'A red fox in the snow', shape: 'square',
    seconds: null, resolution: null, sources: [], startItemId: null, newVersionOf: null, ...over };
}
export function videoSpec(over = {}) {
  return { kind: 'video', model: 'happyhorse-1.1', prompt: 'a horse on a beach', summary: 'A horse running on a beach', shape: 'wide',
    seconds: 5, resolution: '720P', sources: [], startItemId: null, newVersionOf: null, ...over };
}

// An item row, as the bot would have made it.
export function addItem(db, { chatId = 7, kind = 'image', summary = 'a thing', startItemId = null, url = null, fileId = 'F1', messageId = null, proposalId = null } = {}) {
  const r = db.prepare(
    `INSERT INTO items (chat_id, kind, summary, prompt, start_item_id, tg_file_id, tg_message_id, result_url, result_expires_at,
                        delivered_at, proposal_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(chatId, kind, summary, summary, startItemId, fileId, messageId, url, url ? nowSec() + 3600 : null, nowSec(), proposalId, nowSec());
  return Number(r.lastInsertRowid);
}
