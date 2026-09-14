// Handing back what the agent MAKES.
//
// The bot read only the answer text, so everything the agent wrote stayed in
// its workspace. Measured 2026-09-14: asked for a bakery logo, the agent
// installed `sharp`, worked around a sandbox with no fontconfig, rendered
// `lavash-house-logo.png`, said "here is your logo" -- and the user saw a
// paragraph of prose and no picture. The work was done and paid for; only the
// delivery was missing.
//
// Two rules shape this file:
//
//   * NEVER send back what we uploaded. The user's own photo sits in the same
//     directory as the output, and returning it is nonsense.
//   * NEVER send the same file twice. A session is long-lived, so a naive
//     "send every image in the workspace" re-sends the logo on every later
//     message in the conversation.
//
// Both are decided from the database, not from a guess about mtimes: the
// listing is the only thing we can observe, and it has no notion of which run
// produced what.

import { log, errFields } from './log.mjs';
import { nowSec } from './time.mjs';

// Build noise. Nothing here is a deliverable, and sending it would bury the one
// file the user actually asked for.
const IGNORE_NAMES = new Set([
  'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  'requirements.txt', 'tsconfig.json', 'Cargo.toml', 'Cargo.lock', 'go.sum',
]);

// Directories an agent commonly tidies output into. The listing is ONE
// directory, not a walk -- their docs are explicit -- so these are checked
// individually, and only when the root listing shows they exist. Recursing
// into node_modules would be slow and would find nothing worth sending.
const OUTPUT_DIRS = ['output', 'out', 'dist', 'build', 'images', 'img', 'assets'];

const IMAGE_EXT = new Map([
  ['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'],
  ['webp', 'image/webp'], ['gif', 'image/gif'], ['bmp', 'image/bmp'],
]);

const DOC_EXT = new Map([
  ['svg', 'image/svg+xml'], ['pdf', 'application/pdf'], ['txt', 'text/plain'],
  ['md', 'text/markdown'], ['csv', 'text/csv'], ['json', 'application/json'],
  ['html', 'text/html'], ['zip', 'application/zip'], ['mp3', 'audio/mpeg'],
  ['wav', 'audio/wav'], ['ogg', 'audio/ogg'], ['mp4', 'video/mp4'],
  ['webm', 'video/webm'], ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
]);

// Telegram's own caps on what a BOT may upload. A photo over 10 MB is rejected
// outright, so an oversized image goes as a document rather than not at all.
export const PHOTO_MAX_BYTES = 10 * 1024 * 1024;
export const DOC_MAX_BYTES = 50 * 1024 * 1024;

// At most this many per turn. An agent that writes forty frames of an animation
// should not produce forty Telegram messages.
export const MAX_PER_TURN = 5;

export function extOf(name) {
  const base = name.slice(name.lastIndexOf('/') + 1);
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i + 1).toLowerCase() : '';
}

export function mimeOf(name) {
  const e = extOf(name);
  return IMAGE_EXT.get(e) ?? DOC_EXT.get(e) ?? 'application/octet-stream';
}

// Is this something a person would want sent to them?
export function isDeliverable(entry) {
  if (!entry || entry.type !== 'file') return false;
  const base = String(entry.name ?? '');
  if (base === '' || base.startsWith('.')) return false;
  if (IGNORE_NAMES.has(base)) return false;
  if (!(entry.size > 0)) return false;              // an empty file is a failure, not a result
  const e = extOf(base);
  return IMAGE_EXT.has(e) || DOC_EXT.has(e);
}

// Record a file WE put in the workspace, already marked as sent so it can never
// come back to the user as though the agent had produced it.
export function noteUploaded(db, sessionId, name, size) {
  db.prepare(
    `INSERT INTO agent_files (session_id, name, size, mtime, origin, sent_at)
     VALUES (?, ?, ?, NULL, 'uploaded', ?)
     ON CONFLICT(session_id, name, size, mtime) DO NOTHING`
  ).run(sessionId, name, size ?? null, nowSec());
}

// Has this exact file already been dealt with?
//
// Keyed on name AND size AND mtime, so a REVISED file under the same name is a
// new thing to send -- which is what happens when the user asks for a change.
// An upload is matched on name alone, because we never want it back whatever
// the agent did to it.
function alreadyHandled(db, sessionId, name, size, mtime) {
  const up = db.prepare(
    `SELECT 1 FROM agent_files
      WHERE session_id = ? AND name = ? AND origin = 'uploaded' LIMIT 1`
  ).get(sessionId, name);
  if (up) return true;

  const sent = db.prepare(
    `SELECT 1 FROM agent_files
      WHERE session_id = ? AND name = ? AND sent_at IS NOT NULL
        AND COALESCE(size, -1) = COALESCE(?, -1)
        AND COALESCE(mtime, '') = COALESCE(?, '') LIMIT 1`
  ).get(sessionId, name, size ?? null, mtime ?? null);
  return !!sent;
}

function markSent(db, sessionId, name, size, mtime) {
  db.prepare(
    `INSERT INTO agent_files (session_id, name, size, mtime, origin, sent_at)
     VALUES (?, ?, ?, ?, 'produced', ?)
     ON CONFLICT(session_id, name, size, mtime)
       DO UPDATE SET sent_at = excluded.sent_at`
  ).run(sessionId, name, size ?? null, mtime ?? null, nowSec());
}

// A RASTER BEATS ITS OWN SOURCE. An agent asked for a logo typically writes
// `logo.svg` and then renders `logo.png` from it. Both are the same picture;
// sending both is noise, and the SVG is the one Telegram cannot display. So
// when a stem has a raster, its vector source is dropped.
export function dropRedundantVectors(entries) {
  const rasterStems = new Set();
  for (const e of entries) {
    if (IMAGE_EXT.has(extOf(e.path))) rasterStems.add(e.path.replace(/\.[^./]+$/, ''));
  }
  return entries.filter((e) => !(extOf(e.path) === 'svg' && rasterStems.has(e.path.replace(/\.[^./]+$/, ''))));
}

// Everything in this session's workspace that the user has not been given.
//
// A listing failure is NOT "there is nothing" -- it resolves nothing, and the
// files stay unsent so a later turn can find them. That is the §7.1 rule
// applied to the one read this feature depends on.
// `since` (ISO time) is when THIS run started: files older than that were made by an earlier
// run and never sent -- typically a run the user stopped -- and trailing them out five per turn
// for the next several answers buried the one file the current turn actually produced (the red
// circle the user asked for came behind n6.txt..n10.txt, 2026-09-14). They are marked handled
// and named to the caller instead, so they neither vanish nor keep coming.
export async function newDeliverables(db, client, sessionId, { since = null } = {}) {
  let root;
  try {
    root = await client.listFiles(sessionId, '');
  } catch (e) {
    log.warn('could not list the agent workspace; nothing is resolved by this', errFields(e));
    return null;
  }

  // EVERY deliverable in the workspace, sent or not. The already-sent filter
  // comes LAST, because suppression has to be decided against what is on disk
  // rather than against what happens to be unsent: with the filter first, a
  // logo.svg suppressed on turn one (its PNG was going out beside it) came back
  // on turn two as the only candidate left, and the user got the vector source
  // one message after the picture.
  const all = [];
  const collect = (dir, entries) => {
    for (const e of entries) {
      if (!isDeliverable(e)) continue;
      all.push({ path: dir ? `${dir}/${e.name}` : e.name, size: e.size, mtime: e.mtime ?? null });
    }
  };

  collect('', root.entries);

  // Only look inside an output directory the root listing actually showed.
  const dirs = new Set(root.entries.filter((e) => e.type === 'dir').map((e) => e.name));
  for (const d of OUTPUT_DIRS) {
    if (!dirs.has(d)) continue;
    try {
      const sub = await client.listFiles(sessionId, d);
      collect(d, sub.entries);
    } catch (e) {
      log.debug('could not list a workspace subdirectory', { dir: d, ...errFields(e) });
    }
  }

  const worth = dropRedundantVectors(all)
    .filter((e) => !alreadyHandled(db, sessionId, e.path, e.size, e.mtime));

  // Newest last, so the final message in the chat is the most recent thing the
  // agent made -- which is what the user was waiting for.
  worth.sort((a, b) => String(a.mtime ?? '').localeCompare(String(b.mtime ?? '')));

  if (since === null) return worth;
  const fresh = [];
  const stale = [];
  for (const e of worth) {
    if (e.mtime && String(e.mtime) < since) stale.push(e);
    else fresh.push(e);
  }
  for (const e of stale) markSent(db, sessionId, e.path, e.size, e.mtime);
  // More than a turn sends: keep the NEWEST, mark the rest handled, and tell the caller their
  // names -- the files are still in the workspace, and a user who wants one can ask for it.
  const left = fresh.length > MAX_PER_TURN ? fresh.slice(0, fresh.length - MAX_PER_TURN) : [];
  for (const e of left) markSent(db, sessionId, e.path, e.size, e.mtime);
  const keep = fresh.slice(-MAX_PER_TURN);
  keep.left = [...stale, ...left].map((e) => e.path);
  return keep;
}

// Fetch each file and send it: images as photos so they are VISIBLE in the
// chat, everything else as a document so it is not mangled.
//
// A file is marked sent only after Telegram has accepted it. A failure here
// leaves it unsent, so the next turn tries again rather than losing it
// silently -- the same distinction the money path makes between "failed" and
// "resolved".
export async function deliverFiles(db, client, tg, chatId, sessionId, entries, { max = MAX_PER_TURN } = {}) {
  if (!entries || entries.length === 0) return { sent: 0, skipped: 0 };
  let sent = 0;
  let skipped = 0;

  for (const e of entries.slice(0, max)) {
    if (e.size > DOC_MAX_BYTES) {
      log.warn('the agent produced a file too large for Telegram', { name: e.path, size: e.size });
      skipped++;
      continue;
    }

    let bytes = null;
    try {
      bytes = await client.downloadFile(sessionId, e.path);
    } catch (err) {
      log.warn('could not download a file the agent produced', { name: e.path, ...errFields(err) });
      skipped++;
      continue;
    }
    if (!bytes || bytes.length === 0) { skipped++; continue; }

    const asPhoto = IMAGE_EXT.has(extOf(e.path)) && bytes.length <= PHOTO_MAX_BYTES;
    const filename = e.path.slice(e.path.lastIndexOf('/') + 1);
    let res;
    try {
      res = asPhoto
        ? await tg.sendPhoto(chatId, bytes, { filename, caption: null, contentType: mimeOf(e.path) })
        : await tg.sendDocument(chatId, bytes, { filename, caption: null, contentType: mimeOf(e.path) });
    } catch (err) {
      log.warn('sending a produced file threw', { name: e.path, ...errFields(err) });
      skipped++;
      continue;
    }

    if (res?.ok) {
      markSent(db, sessionId, e.path, e.size, e.mtime);
      sent++;
    } else {
      log.warn('Telegram refused a produced file', { name: e.path, why: res?.description ?? 'unknown' });
      skipped++;
    }
  }

  if (entries.length > max) {
    log.info('more produced files than one turn sends', { total: entries.length, max });
  }
  if (sent || skipped) log.info('delivered agent output', { sent, skipped });
  return { sent, skipped };
}
