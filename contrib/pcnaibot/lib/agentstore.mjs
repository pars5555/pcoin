// Agent session bookkeeping.
//
// THE POINT OF THIS FILE IS THAT WE CAN ALWAYS DELETE. A session id we have
// lost is a sandbox, a workspace and a transcript sitting on somebody else's
// server with no way for us to remove it. So the id is written down BEFORE the
// session is used, `deleted_at` is set only after a delete is CONFIRMED, and a
// sweeper retries the ones that did not confirm.
//
// A failed delete is therefore not "gone" -- it is "still ours to clean up".

import { immediate } from './db.mjs';
import { nowSec } from './time.mjs';
import { log, errFields, chatTag } from './log.mjs';

// Between deletes.
//
// Was 1500ms, to work around a provider bug: measured 2026-09-13, seven deletes
// fired ~335ms apart ALL returned 400, and the same ids spaced out returned 204.
// OonaCode fixed that, and it is re-measured 2026-09-17: six deletes issued back
// to back, with no pacing at all, every one 204.
//
// Not dropped to zero. A small gap costs nothing here -- a session lives 24h and
// nothing about this sweep is urgent -- and it keeps the sweeper from behaving
// like a burst against a shared endpoint. What it no longer does is crawl: at
// 1500ms a twenty-session backlog took half a minute.
export const DELETE_PACING_MS = 250;

// The session this chat is CURRENTLY bound to.
//
// Keys on `retired_at`, not `deleted_at`. A session we have retired but not yet
// managed to delete is no longer this chat's -- treating it as live is how
// /clear silently kept the conversation it promised to remove.
export function liveSession(db, chatId) {
  return db.prepare(
    'SELECT * FROM agent_sessions WHERE chat_id = ? AND retired_at IS NULL'
  ).get(chatId) ?? null;
}

export function recordSession(db, chatId, { sessionId, model, expiresAt = null }) {
  return immediate(db, () => {
    // One live session per chat -- the partial unique index enforces it, but
    // an existing one must be retired first or the insert simply fails.
    const existing = db.prepare(
      'SELECT session_id FROM agent_sessions WHERE chat_id = ? AND retired_at IS NULL'
    ).get(chatId);
    if (existing && existing.session_id !== sessionId) {
      throw new Error(`chat already holds live session ${existing.session_id}`);
    }
    db.prepare(
      `INSERT INTO agent_sessions (chat_id, session_id, model, created_at, last_used_at, expires_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(session_id) DO UPDATE SET last_used_at = excluded.last_used_at`
    ).run(chatId, sessionId, model, nowSec(), nowSec(), expiresAt);
    return db.prepare('SELECT * FROM agent_sessions WHERE session_id = ?').get(sessionId);
  });
}

// The model a session runs on, as the user last chose it. OonaCode takes `model` on every run and
// switches the SAME conversation to it (the host resumes the history on the new model), so a
// switch is a column update here -- not a new session (owner, 2026-09-25: "i changed model and
// history was gone ... it should continue on previous session until user clears it").
export function setSessionModel(db, sessionId, model) {
  db.prepare('UPDATE agent_sessions SET model = ? WHERE session_id = ?').run(model, sessionId);
}

export function touchSession(db, sessionId, { credits = null, failed = false } = {}) {
  const row = db.prepare('SELECT * FROM agent_sessions WHERE session_id = ?').get(sessionId);
  if (!row) return null;
  const spent = credits === null
    ? row.credits_spent
    : (Number(row.credits_spent) + Number(credits)).toFixed(6);
  db.prepare(
    `UPDATE agent_sessions
        SET last_used_at = ?, runs = runs + 1, credits_spent = ?,
            failures = CASE WHEN ? THEN failures + 1 ELSE 0 END
      WHERE session_id = ?`
  ).run(nowSec(), spent, failed ? 1 : 0, sessionId);
  return db.prepare('SELECT * FROM agent_sessions WHERE session_id = ?').get(sessionId);
}

// Retire a session: this chat is done with it, whatever the server says.
//
// This is OUR record and cannot fail, which is the point -- unbinding must not
// depend on an HTTP call that we have measured failing. `expires_at = 0` is
// what puts it in the sweeper's queue.
export function markForDeletion(db, sessionId) {
  db.prepare(
    'UPDATE agent_sessions SET expires_at = 0, retired_at = COALESCE(retired_at, ?) WHERE session_id = ?'
  ).run(nowSec(), sessionId);
}

export function confirmDeleted(db, sessionId) {
  db.prepare('UPDATE agent_sessions SET deleted_at = ? WHERE session_id = ? AND deleted_at IS NULL')
    .run(nowSec(), sessionId);
}

// Sessions we still owe a delete on: explicitly retired (expires_at 0), past
// their expiry, or poisoned beyond use.
export function pendingDeletion(db, { maxFailures = 3, limit = 20 } = {}) {
  const now = nowSec();
  return db.prepare(
    `SELECT * FROM agent_sessions
      WHERE deleted_at IS NULL
        AND (retired_at IS NOT NULL OR expires_at = 0
             OR (expires_at IS NOT NULL AND expires_at < ?) OR failures >= ?)
      ORDER BY id ASC LIMIT ?`
  ).all(now, maxFailures, limit);
}

// Retire a chat's session: ask the API to delete it, and only record success
// when it confirms. Always clears the chat's live binding locally, so a user is
// never stuck talking to a session we are trying to remove.
export async function retireSession(db, client, chatId, { reason = 'user request' } = {}) {
  const row = liveSession(db, chatId);
  if (!row) return { had: false, deleted: false };

  markForDeletion(db, row.session_id);
  let deleted = false;
  try {
    deleted = await client.deleteSession(row.session_id);
  } catch (e) {
    log.warn('agent session delete threw; it will be retried by the sweeper', errFields(e));
  }
  if (deleted) {
    confirmDeleted(db, row.session_id);
    log.info('agent session deleted', { chat: chatTag(chatId), reason });
  } else {
    // The chat is ALREADY unbound by markForDeletion above, so the user gets a
    // fresh session on their next message regardless. All that is outstanding
    // is removing it from their server.
    log.warn('agent session retired but NOT confirmed deleted; left for the sweeper', { chat: chatTag(chatId) });
  }
  return { had: true, deleted, sessionId: row.session_id };
}

// Retry every delete we still owe. Runs on a timer: a session that survives our
// attempt to remove it would otherwise sit on their server until it expires,
// and we would never know.
export async function sweepDeletions(db, client, opts = {}) {
  const rows = pendingDeletion(db, opts);
  let done = 0;
  for (const r of rows) {
    try {
      if (await client.deleteSession(r.session_id)) {
        confirmDeleted(db, r.session_id);
        done++;
      }
    } catch (e) {
      log.debug('sweeper delete failed; will try again', errFields(e));
    }
    // PACE THE DELETES. Measured 2026-09-13: seven deletes fired ~335ms apart
    // all returned 400; the same ids spaced out returned 204. So hammering the
    // endpoint is itself a cause of the failure we are retrying. Nothing here
    // is urgent -- a session lives 24h -- so going slowly costs nothing and
    // stops the sweeper fighting itself.
    await new Promise((res) => setTimeout(res, DELETE_PACING_MS));
  }
  if (rows.length) log.info('agent session sweep', { owed: rows.length, deleted: done });
  return { owed: rows.length, deleted: done };
}

// Sessions on their side that we have no record of -- a leak, by definition,
// because nothing else will ever delete them. Only ever called with a client
// whose key is ours.
export async function reconcileRemote(db, client) {
  let remote;
  try { remote = await client.listSessions(); }
  catch (e) { log.warn('could not list remote agent sessions', errFields(e)); return { checked: 0, orphans: 0 }; }

  const known = new Set(
    db.prepare('SELECT session_id FROM agent_sessions').all().map((r) => r.session_id)
  );
  const orphans = remote.filter((s) => !known.has(s.id));
  for (const o of orphans) {
    log.error('agent session exists on the server that we have NO RECORD OF -- deleting', {
      session: o.id.slice(0, 8), runs: o.runs, credits: o.credits_spent,
    });
    try { await client.deleteSession(o.id); } catch (e) { log.warn('orphan delete failed', errFields(e)); }
    await new Promise((res) => setTimeout(res, DELETE_PACING_MS));
  }
  return { checked: remote.length, orphans: orphans.length };
}
