// Handing back what the agent produced.
//
// The bug this exists for: asked for a bakery logo the agent rendered
// `lavash-house-logo.png` into its workspace and the user saw nothing, because
// the bot read only the answer text. The two ways a naive fix goes wrong are
// both pinned here -- re-sending the user's own upload, and re-sending the same
// output on every later message in a long-lived session.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, pendingMigrations, applyMigration } from '../lib/db.mjs';
import {
  newDeliverables, deliverFiles, noteUploaded,
  isDeliverable, dropRedundantVectors, extOf, mimeOf,
} from '../lib/deliver.mjs';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'pcnaibot-deliver-'));
  const db = openDb(join(dir, 'd.db'));
  for (const m of pendingMigrations(db)) applyMigration(db, m);
  return db;
}

// The JPEG in the listing below is only there because the bot put it there, so
// a test about what comes BACK has to start from that state -- otherwise it is
// measuring a situation that cannot occur.
function dbWithTheUpload() {
  const db = freshDb();
  noteUploaded(db, 's-1', 'photo-AQADoRprG9riQUl-.jpg', 83078);
  return db;
}

// The workspace exactly as the live session listed it on 2026-09-14.
const REAL_LISTING = [
  { name: 'lavash-house-logo.png', type: 'file', size: 72306, mtime: '2026-09-13T21:26:39.713Z' },
  { name: 'lavash-house-logo.svg', type: 'file', size: 4005, mtime: '2026-09-13T21:26:00.884Z' },
  { name: 'node_modules', type: 'dir', size: 4096, mtime: '2026-09-13T21:25:04.516Z' },
  { name: 'package-lock.json', type: 'file', size: 20323, mtime: '2026-09-13T21:25:05.320Z' },
  { name: 'package.json', type: 'file', size: 398, mtime: '2026-09-13T21:25:05.308Z' },
  { name: 'photo-AQADoRprG9riQUl-.jpg', type: 'file', size: 83078, mtime: '2026-09-13T21:22:39.047Z' },
];

function fakeClient(root = REAL_LISTING, subdirs = {}) {
  return {
    listFiles: async (_id, path = '') => {
      if (path === '') return { path, entries: root };
      if (subdirs[path]) return { path, entries: subdirs[path] };
      return { path, entries: [] };
    },
    downloadFile: async (_id, path) => Buffer.from(`bytes of ${path}`),
  };
}

function fakeTg() {
  const photos = []; const docs = [];
  return {
    photos, docs,
    sendPhoto: async (_c, buf, o) => { photos.push({ name: o.filename, size: buf.length }); return { ok: true }; },
    sendDocument: async (_c, buf, o) => { docs.push({ name: o.filename, size: buf.length }); return { ok: true }; },
  };
}

test('the logo the user never saw is found', async () => {
  const db = freshDb();
  const out = await newDeliverables(db, fakeClient(), 's-1');
  const names = out.map((e) => e.path);
  assert.ok(names.includes('lavash-house-logo.png'), 'the rendered logo is a deliverable');
  db.close();
});

test('build noise is not a deliverable', () => {
  assert.equal(isDeliverable({ name: 'package.json', type: 'file', size: 398 }), false);
  assert.equal(isDeliverable({ name: 'package-lock.json', type: 'file', size: 20323 }), false);
  assert.equal(isDeliverable({ name: 'node_modules', type: 'dir', size: 4096 }), false);
  assert.equal(isDeliverable({ name: '.fonts.conf', type: 'file', size: 200 }), false);
  // An empty file is a failed render, not a result.
  assert.equal(isDeliverable({ name: 'logo.png', type: 'file', size: 0 }), false);
  assert.equal(isDeliverable({ name: 'logo.png', type: 'file', size: 72306 }), true);
});

// ---------------------------------------------------------------------------
// RULE ONE: never hand the user back their own upload.
// ---------------------------------------------------------------------------
test("the user's own photo is never sent back to them", async () => {
  const db = freshDb();
  noteUploaded(db, 's-1', 'photo-AQADoRprG9riQUl-.jpg', 83078);

  const out = await newDeliverables(db, fakeClient(), 's-1');
  assert.ok(!out.some((e) => e.path.startsWith('photo-')),
    'an uploaded file is not a result');
  assert.ok(out.some((e) => e.path === 'lavash-house-logo.png'));
  db.close();
});

test('an upload is excluded even after the agent has touched it', async () => {
  const db = freshDb();
  noteUploaded(db, 's-1', 'photo-AQADoRprG9riQUl-.jpg', 83078);
  // Size and mtime both moved -- the agent cropped it in place. Still ours.
  const touched = REAL_LISTING.map((e) => e.name.startsWith('photo-')
    ? { ...e, size: 4242, mtime: '2026-09-13T22:00:00.000Z' } : e);
  const out = await newDeliverables(db, fakeClient(touched), 's-1');
  assert.ok(!out.some((e) => e.path.startsWith('photo-')));
  db.close();
});

// ---------------------------------------------------------------------------
// RULE TWO: a long session must not re-send its output on every message.
// ---------------------------------------------------------------------------
test('a delivered file is not delivered again', async () => {
  const db = dbWithTheUpload();
  const c = fakeClient(); const tg = fakeTg();

  const first = await newDeliverables(db, c, 's-1');
  await deliverFiles(db, c, tg, 99, 's-1', first);
  assert.equal(tg.photos.length, 1, 'the PNG went as a photo');
  assert.equal(tg.photos[0].name, 'lavash-house-logo.png');

  // The next message in the same session finds nothing new.
  //
  // Including the SVG that was SUPPRESSED rather than sent. Filtering the
  // already-sent files first made it the only candidate left on turn two, so
  // the user received the vector source one message after the picture --
  // suppression has to be decided against the workspace, not against the
  // leftovers.
  const second = await newDeliverables(db, c, 's-1');
  assert.deepEqual(second, [], 'nothing is re-sent, and nothing arrives late');
  db.close();
});

test('a REVISED file under the same name is sent again', async () => {
  const db = dbWithTheUpload();
  const c = fakeClient(); const tg = fakeTg();
  await deliverFiles(db, c, tg, 99, 's-1', await newDeliverables(db, c, 's-1'));
  assert.equal(tg.photos.length, 1);

  // "make it blue" -- same name, new bytes.
  const revised = REAL_LISTING.map((e) => e.name === 'lavash-house-logo.png'
    ? { ...e, size: 81000, mtime: '2026-09-13T21:40:00.000Z' } : e);
  const again = await newDeliverables(db, fakeClient(revised), 's-1');
  assert.ok(again.some((e) => e.path === 'lavash-house-logo.png'),
    'a changed file is a new result');
  db.close();
});

// ---------------------------------------------------------------------------
test('a PNG rendered from an SVG suppresses the SVG', () => {
  const kept = dropRedundantVectors([
    { path: 'lavash-house-logo.svg', size: 4005 },
    { path: 'lavash-house-logo.png', size: 72306 },
    { path: 'diagram.svg', size: 900 },
  ]).map((e) => e.path);
  assert.deepEqual(kept, ['lavash-house-logo.png', 'diagram.svg'],
    'the vector source of a raster we are sending is noise; a lone SVG is not');
});

test('an SVG with no raster still reaches the user, as a document', async () => {
  const db = freshDb();
  const listing = [{ name: 'diagram.svg', type: 'file', size: 900, mtime: '2026-09-13T21:00:00.000Z' }];
  const c = fakeClient(listing); const tg = fakeTg();
  await deliverFiles(db, c, tg, 99, 's-1', await newDeliverables(db, c, 's-1'));
  assert.equal(tg.photos.length, 0, 'Telegram cannot render an SVG as a photo');
  assert.equal(tg.docs.length, 1);
  assert.equal(tg.docs[0].name, 'diagram.svg');
  db.close();
});

test('output directories are read, but only when they exist', async () => {
  const db = freshDb();
  const root = [
    { name: 'output', type: 'dir', size: 4096, mtime: '2026-09-13T21:00:00.000Z' },
    { name: 'node_modules', type: 'dir', size: 4096, mtime: '2026-09-13T21:00:00.000Z' },
  ];
  const asked = [];
  const c = {
    listFiles: async (_id, path = '') => {
      asked.push(path);
      if (path === '') return { path, entries: root };
      if (path === 'output') {
        return { path, entries: [{ name: 'chart.png', type: 'file', size: 5000, mtime: '2026-09-13T21:05:00.000Z' }] };
      }
      return { path, entries: [] };
    },
    downloadFile: async () => Buffer.from('x'),
  };
  const out = await newDeliverables(db, c, 's-1');
  assert.deepEqual(out.map((e) => e.path), ['output/chart.png'], 'nested output is found and keeps its path');
  assert.ok(asked.includes('output'));
  assert.ok(!asked.includes('dist'), 'a directory the listing did not show is never requested');
  assert.ok(!asked.includes('node_modules'), 'node_modules is never walked');
  db.close();
});

// ---------------------------------------------------------------------------
// THE §7.1 RULE, applied to the one read this feature depends on.
// ---------------------------------------------------------------------------
test('a failed listing resolves NOTHING -- it is not "no files"', async () => {
  const db = freshDb();
  const broken = {
    listFiles: async () => { throw new Error('explorer down'); },
    downloadFile: async () => Buffer.from('x'),
  };
  const out = await newDeliverables(db, broken, 's-1');
  assert.equal(out, null, 'unknown is its own state, distinct from an empty array');

  // And nothing was recorded as sent, so a later turn still finds the file.
  const later = await newDeliverables(db, fakeClient(), 's-1');
  assert.ok(later.some((e) => e.path === 'lavash-house-logo.png'));
  db.close();
});

test('a file Telegram refuses stays unsent, and is retried next turn', async () => {
  const db = dbWithTheUpload();
  const c = fakeClient();
  const refusing = {
    sendPhoto: async () => ({ ok: false, description: 'PHOTO_INVALID_DIMENSIONS' }),
    sendDocument: async () => ({ ok: false, description: 'nope' }),
  };
  const r = await deliverFiles(db, c, refusing, 99, 's-1', await newDeliverables(db, c, 's-1'));
  assert.equal(r.sent, 0);
  assert.ok(r.skipped >= 1);

  // Not marked as delivered, so it comes back.
  const tg = fakeTg();
  const again = await newDeliverables(db, c, 's-1');
  assert.ok(again.some((e) => e.path === 'lavash-house-logo.png'),
    'a refused send must not count as delivered');
  await deliverFiles(db, c, tg, 99, 's-1', again);
  assert.equal(tg.photos.length, 1);
  db.close();
});

test('an oversized image goes as a document rather than not at all', async () => {
  const db = freshDb();
  const listing = [{ name: 'huge.png', type: 'file', size: 12 * 1024 * 1024, mtime: '2026-09-13T21:00:00.000Z' }];
  const big = Buffer.alloc(12 * 1024 * 1024);
  const c = { listFiles: async (_i, p = '') => ({ path: p, entries: p === '' ? listing : [] }), downloadFile: async () => big };
  const tg = fakeTg();
  await deliverFiles(db, c, tg, 99, 's-1', await newDeliverables(db, c, 's-1'));
  assert.equal(tg.photos.length, 0, 'over 10 MB Telegram rejects a photo outright');
  assert.equal(tg.docs.length, 1);
  db.close();
});

test('two sessions do not share delivery state', async () => {
  const db = freshDb();
  const c = fakeClient(); const tg = fakeTg();
  await deliverFiles(db, c, tg, 99, 's-1', await newDeliverables(db, c, 's-1'));
  // A different chat, a different session, the same filename: still owed.
  const other = await newDeliverables(db, c, 's-2');
  assert.ok(other.some((e) => e.path === 'lavash-house-logo.png'));
  db.close();
});

test('types are read off the name', () => {
  assert.equal(extOf('output/lavash-house-logo.png'), 'png');
  assert.equal(extOf('README'), '');
  assert.equal(mimeOf('a.png'), 'image/png');
  assert.equal(mimeOf('a.svg'), 'image/svg+xml');
  assert.equal(mimeOf('a.weird'), 'application/octet-stream');
});
