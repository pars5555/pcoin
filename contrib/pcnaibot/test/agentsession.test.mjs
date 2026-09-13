// One session per chat, reused until /clear, then a NEW one.
//
// The case that matters most is the one that was broken: a /clear whose remote
// DELETE fails. Measured 2026-09-13, DELETE returns 400 when called in quick
// succession, so this is not hypothetical -- and while retirement and deletion
// were one column, a failed delete left the session live and the next message
// carried on the conversation the user had just cleared.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, pendingMigrations, applyMigration, nowSec } from '../lib/db.mjs';
import {
  liveSession, recordSession, touchSession, retireSession,
  sweepDeletions, reconcileRemote, pendingDeletion,
} from '../lib/agentstore.mjs';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'pcnaibot-agent-'));
  const db = openDb(join(dir, 'a.db'));
  for (const m of pendingMigrations(db)) applyMigration(db, m);
  db.prepare('INSERT INTO users (chat_id, model, agent_mode, created_at) VALUES (?,?,?,?)')
    .run(1, 'mimo-v2.5', 1, nowSec());
  return db;
}

// A client whose delete outcome the test controls.
function fakeClient({ deleteOk = true, remote = [] } = {}) {
  const deleted = [];
  return {
    deleted,
    deleteSession: async (id) => { if (deleteOk) { deleted.push(id); return true; } return false; },
    listSessions: async () => remote,
  };
}

test('one session is reused across messages', () => {
  const db = freshDb();
  recordSession(db, 1, { sessionId: 's-1', model: 'mimo-v2.5' });

  // Every later message finds the same session rather than making another.
  assert.equal(liveSession(db, 1).session_id, 's-1');
  touchSession(db, 's-1', { credits: 2.5 });
  assert.equal(liveSession(db, 1).session_id, 's-1');
  touchSession(db, 's-1', { credits: 1.5 });
  const s = liveSession(db, 1);
  assert.equal(s.session_id, 's-1');
  assert.equal(s.runs, 2);
  assert.equal(Number(s.credits_spent), 4);
  db.close();
});

test('a second live session for one chat is refused', () => {
  const db = freshDb();
  recordSession(db, 1, { sessionId: 's-1', model: 'mimo-v2.5' });
  // The partial unique index plus the explicit check: one live session, always.
  assert.throws(() => recordSession(db, 1, { sessionId: 's-2', model: 'mimo-v2.5' }), /already holds live session/);
  assert.equal(liveSession(db, 1).session_id, 's-1');
  db.close();
});

test('after /clear the next message gets a NEW session', async () => {
  const db = freshDb();
  const c = fakeClient();
  recordSession(db, 1, { sessionId: 's-1', model: 'mimo-v2.5' });

  const r = await retireSession(db, c, 1, { reason: '/clear' });
  assert.equal(r.had, true);
  assert.equal(r.deleted, true);
  assert.deepEqual(c.deleted, ['s-1']);
  assert.equal(liveSession(db, 1), null, 'nothing live after a clear');

  // The next message can bind a fresh one.
  recordSession(db, 1, { sessionId: 's-2', model: 'mimo-v2.5' });
  assert.equal(liveSession(db, 1).session_id, 's-2');
  db.close();
});

// ---------------------------------------------------------------------------
// THE BUG THIS FILE EXISTS FOR.
// ---------------------------------------------------------------------------
test('a /clear whose DELETE FAILS still unbinds the chat', async () => {
  const db = freshDb();
  const c = fakeClient({ deleteOk: false });   // the server says 400
  recordSession(db, 1, { sessionId: 's-1', model: 'mimo-v2.5' });

  const r = await retireSession(db, c, 1, { reason: '/clear' });
  assert.equal(r.had, true);
  assert.equal(r.deleted, false, 'the remote delete did not confirm');

  // ...and yet the user is NOT still talking to it.
  assert.equal(liveSession(db, 1), null,
    'a failed delete must not leave the cleared session live');

  // A fresh session binds immediately, without waiting for the cleanup.
  recordSession(db, 1, { sessionId: 's-2', model: 'mimo-v2.5' });
  assert.equal(liveSession(db, 1).session_id, 's-2');

  // And the old one is still owed a delete -- retired is not deleted.
  const owed = pendingDeletion(db).map((x) => x.session_id);
  assert.ok(owed.includes('s-1'), 'the undeleted session is still queued for cleanup');
  db.close();
});

test('the sweeper eventually deletes what a failed clear left behind', async () => {
  const db = freshDb();
  recordSession(db, 1, { sessionId: 's-1', model: 'mimo-v2.5' });
  await retireSession(db, fakeClient({ deleteOk: false }), 1, { reason: '/clear' });

  const good = fakeClient({ deleteOk: true });
  const swept = await sweepDeletions(db, good, { limit: 10 });
  assert.equal(swept.deleted, 1);
  assert.deepEqual(good.deleted, ['s-1']);

  // Once confirmed, it stops being owed.
  assert.equal(pendingDeletion(db).length, 0);
  db.close();
});

test('a retired-but-undeleted session never comes back as live', async () => {
  const db = freshDb();
  recordSession(db, 1, { sessionId: 's-1', model: 'mimo-v2.5' });
  await retireSession(db, fakeClient({ deleteOk: false }), 1, { reason: '/clear' });
  // Several sweeps that all fail must not resurrect it.
  for (let i = 0; i < 3; i++) await sweepDeletions(db, fakeClient({ deleteOk: false }), { limit: 10 });
  assert.equal(liveSession(db, 1), null);
  db.close();
});

test('a model change retires the session so the new model is actually used', async () => {
  const db = freshDb();
  const c = fakeClient();
  recordSession(db, 1, { sessionId: 's-1', model: 'mimo-v2.5' });
  // A session keeps the model it was created with, so switching must replace it.
  await retireSession(db, c, 1, { reason: 'model mimo-v2.5 -> gpt-5' });
  assert.equal(liveSession(db, 1), null);
  recordSession(db, 1, { sessionId: 's-2', model: 'gpt-5' });
  assert.equal(liveSession(db, 1).model, 'gpt-5');
  db.close();
});

test('sessions on the server we have no record of are found and deleted', async () => {
  const db = freshDb();
  recordSession(db, 1, { sessionId: 'known', model: 'mimo-v2.5' });
  const c = fakeClient({
    remote: [
      { id: 'known', runs: 1, credits_spent: 2 },
      { id: 'orphan-a', runs: 0, credits_spent: 0 },
      { id: 'orphan-b', runs: 3, credits_spent: 9 },
    ],
  });
  const r = await reconcileRemote(db, c);
  assert.equal(r.checked, 3);
  assert.equal(r.orphans, 2);
  assert.deepEqual(c.deleted.sort(), ['orphan-a', 'orphan-b']);
  // The one we know about is left alone.
  assert.equal(liveSession(db, 1).session_id, 'known');
  db.close();
});

test('two chats hold independent sessions', () => {
  const db = freshDb();
  db.prepare('INSERT INTO users (chat_id, model, agent_mode, created_at) VALUES (?,?,?,?)')
    .run(2, 'gpt-5', 1, nowSec());
  recordSession(db, 1, { sessionId: 's-1', model: 'mimo-v2.5' });
  recordSession(db, 2, { sessionId: 's-2', model: 'gpt-5' });
  assert.equal(liveSession(db, 1).session_id, 's-1');
  assert.equal(liveSession(db, 2).session_id, 's-2');
  db.close();
});
