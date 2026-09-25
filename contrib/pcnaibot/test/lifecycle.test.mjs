// What happened to a chat while it sat idle, told once to the right person.
//
// OonaCode (2026-09-25) records `session.files_deleted` after an idle hour and `session.expired`
// after an idle day. The bot polls them; these tests pin what each one does to our state and who
// hears about it -- and, as much, who does NOT: a notice about a chat the user has since used, or
// is using right now, is wrong, and the same notice twice looks broken.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, pendingMigrations, applyMigration, nowSec, kvGetJson } from '../lib/db.mjs';
import { liveSession, recordSession, pendingDeletion } from '../lib/agentstore.mjs';
import { pollAgentEvents, decideEvent, eventNumber, EVENTS_CURSOR_KEY, NOTICE_MAX_AGE_SEC } from '../lib/lifecycle.mjs';
import { AgentClient, AgentUnavailable, runOutcome, stopNote } from '../lib/agent.mjs';

const NOW = 1790000000;
const iso = (sec) => new Date(sec * 1000).toISOString();

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'pcnaibot-life-'));
  const db = openDb(join(dir, 'a.db'));
  for (const m of pendingMigrations(db)) applyMigration(db, m);
  for (const chat of [1, 2]) {
    db.prepare('INSERT INTO users (chat_id, model, agent_mode, created_at) VALUES (?,?,?,?)')
      .run(chat, 'glm-5.3-flash', 1, nowSec());
  }
  return db;
}

// A session last used at `usedAt`.
function session(db, chatId, sid, usedAt) {
  recordSession(db, chatId, { sessionId: sid, model: 'glm-5.3-flash' });
  db.prepare('UPDATE agent_sessions SET last_used_at = ? WHERE session_id = ?').run(usedAt, sid);
}

function evt(n, type, sid, createdAt, message = undefined) {
  return {
    id: `evt_${n}`, type, created_at: iso(createdAt),
    session: sid ? { id: sid, model: 'glm-5.3-flash', last_used_at: iso(createdAt - 3600), runs: 3 } : null,
    remembers: { conversation: type !== 'session.expired', files: false },
    next_message: type === 'session.expired' ? 'starts_fresh' : 'restores',
    message: message ?? (type === 'session.expired'
      ? 'This chat had no messages for 24 hours and has ended. The agent no longer remembers it — the next message starts a new conversation.'
      : 'This chat was idle for 60 minutes, so its workspace was deleted: the files the agent made in it are gone. The conversation is kept — the next message restores it and continues where it left off.'),
  };
}

// The events API, as pages. Records every `after` it was asked with.
function fakeClient(pages) {
  const asked = [];
  let i = 0;
  return {
    asked,
    listEvents: async ({ after }) => {
      asked.push(after);
      return pages[i++] ?? { events: [], nextAfter: null };
    },
  };
}

function fakeTg({ fail = false, throws = false } = {}) {
  const sent = [];
  return {
    sent,
    sendLong: async (chatId, html) => {
      if (throws) throw new Error('network');
      sent.push({ chatId, html });
      return [fail ? { ok: false, description: 'Forbidden: bot was blocked by the user' } : { ok: true }];
    },
  };
}

const now = () => NOW;

test('files deleted: the chat is told once, and its session stays live', async () => {
  const db = freshDb();
  session(db, 1, 's-1', NOW - 3700);
  const tg = fakeTg();
  const c = await pollAgentEvents(db, fakeClient([{ events: [evt(7, 'session.files_deleted', 's-1', NOW - 60)], nextAfter: null }]), tg, { now });

  assert.equal(tg.sent.length, 1);
  assert.equal(tg.sent[0].chatId, 1, 'the chat that owns the session, found by session id');
  assert.match(tg.sent[0].html, /idle for 60 minutes/, "OonaCode's own sentence, which names the real window");
  assert.match(tg.sent[0].html, /already sent to you here are not affected/);
  assert.match(tg.sent[0].html, /^<i>.*<\/i>$/s);
  assert.equal(liveSession(db, 1).session_id, 's-1', 'the conversation is kept: the next message restores it');
  assert.deepEqual(c, { handled: 1, retired: 0, told: 1 });
  db.close();
});

test('expired: the session is retired, the chat is told, and the next message gets a NEW session', async () => {
  const db = freshDb();
  session(db, 1, 's-old', NOW - 86500);
  const tg = fakeTg();
  await pollAgentEvents(db, fakeClient([{ events: [evt(8, 'session.expired', 's-old', NOW - 30)], nextAfter: null }]), tg, { now });

  assert.equal(tg.sent.length, 1);
  assert.match(tg.sent[0].html, /no longer remembers it/);
  assert.equal(liveSession(db, 1), null, 'no longer this chat\'s: a run into it would only collect a 404');
  assert.ok(pendingDeletion(db).some((r) => r.session_id === 's-old'), 'queued for the sweeper to delete on OonaCode');

  recordSession(db, 1, { sessionId: 's-new', model: 'glm-5.3-flash' });
  assert.equal(liveSession(db, 1).session_id, 's-new');
  db.close();
});

test('each event is acted on once: the cursor persists and a re-read is skipped', async () => {
  const db = freshDb();
  session(db, 1, 's-1', NOW - 3700);
  const tg = fakeTg();
  const e = evt(9, 'session.files_deleted', 's-1', NOW - 60);

  await pollAgentEvents(db, fakeClient([{ events: [e], nextAfter: null }]), tg, { now });
  assert.deepEqual(kvGetJson(db, EVENTS_CURSOR_KEY), { after: 'evt_9' });

  // The next pass asks from the cursor -- and even if the same event comes back, it is not re-sent.
  const again = fakeClient([{ events: [e], nextAfter: null }]);
  await pollAgentEvents(db, again, tg, { now });
  assert.deepEqual(again.asked, ['evt_9']);
  assert.equal(tg.sent.length, 1);
  db.close();
});

test('a full page is followed by the next one, from the last event handled', async () => {
  const db = freshDb();
  session(db, 1, 's-1', NOW - 3700);
  session(db, 2, 's-2', NOW - 3700);
  const tg = fakeTg();
  const client = fakeClient([
    { events: [evt(1, 'session.files_deleted', 's-1', NOW - 90), evt(2, 'webhook.test', null, NOW - 80)], nextAfter: 'evt_2' },
    { events: [evt(3, 'session.files_deleted', 's-2', NOW - 70)], nextAfter: null },
  ]);
  const c = await pollAgentEvents(db, client, tg, { now, limit: 2 });

  assert.deepEqual(client.asked, [null, 'evt_2']);
  assert.deepEqual(tg.sent.map((s) => s.chatId), [1, 2]);
  assert.equal(c.handled, 3);
  assert.deepEqual(kvGetJson(db, EVENTS_CURSOR_KEY), { after: 'evt_3' });
  db.close();
});

test('the cursor is claimed BEFORE the notice goes out: a failed send is not repeated', async () => {
  const db = freshDb();
  session(db, 1, 's-1', NOW - 3700);
  const e = evt(4, 'session.files_deleted', 's-1', NOW - 60);

  await assert.rejects(pollAgentEvents(db, fakeClient([{ events: [e], nextAfter: null }]), fakeTg({ throws: true }), { now }));
  assert.deepEqual(kvGetJson(db, EVENTS_CURSOR_KEY), { after: 'evt_4' });

  const tg = fakeTg();
  await pollAgentEvents(db, fakeClient([{ events: [e], nextAfter: null }]), tg, { now });
  assert.equal(tg.sent.length, 0, 'at most once: a lost notice costs nothing, a double one looks broken');
  db.close();
});

test('a blocked bot is logged, not retried, and does not stop the pass', async () => {
  const db = freshDb();
  session(db, 1, 's-1', NOW - 3700);
  session(db, 2, 's-2', NOW - 3700);
  const tg = fakeTg({ fail: true });
  const c = await pollAgentEvents(db, fakeClient([{ events: [
    evt(1, 'session.files_deleted', 's-1', NOW - 60), evt(2, 'session.files_deleted', 's-2', NOW - 50),
  ], nextAfter: null }]), tg, { now });
  assert.equal(tg.sent.length, 2);
  assert.equal(c.told, 0);
  assert.equal(c.handled, 2);
  db.close();
});

test('nobody is told about a chat they have used since, are using now, or left long ago', () => {
  const db = freshDb();
  session(db, 1, 's-1', NOW - 3700);

  // Used after the files went: that message already restored the workspace.
  db.prepare('UPDATE agent_sessions SET last_used_at = ? WHERE session_id = ?').run(NOW - 10, 's-1');
  assert.equal(decideEvent(db, evt(1, 'session.files_deleted', 's-1', NOW - 60), { now: NOW }).notify, null);
  db.prepare('UPDATE agent_sessions SET last_used_at = ? WHERE session_id = ?').run(NOW - 3700, 's-1');

  // A turn in progress.
  db.prepare('UPDATE users SET busy_at = ? WHERE chat_id = 1').run(NOW - 20);
  assert.equal(decideEvent(db, evt(1, 'session.files_deleted', 's-1', NOW - 60), { now: NOW }).why, 'a turn is running');
  // ...but a lock gone stale is a crashed turn, not a running one.
  db.prepare('UPDATE users SET busy_at = ? WHERE chat_id = 1').run(NOW - 600);
  assert.equal(decideEvent(db, evt(1, 'session.files_deleted', 's-1', NOW - 60), { now: NOW }).notify, 1);

  // Too old to be news.
  assert.equal(decideEvent(db, evt(1, 'session.files_deleted', 's-1', NOW - NOTICE_MAX_AGE_SEC - 1), { now: NOW }).why, 'too old to tell');

  // Not ours; the test event; no session.
  assert.equal(decideEvent(db, evt(1, 'session.files_deleted', 's-nobody', NOW - 60), { now: NOW }).why, 'unknown session');
  assert.equal(decideEvent(db, evt(1, 'webhook.test', null, NOW - 60), { now: NOW }).notify, null);
  db.close();
});

test('a chat that already moved on hears nothing, even about an expiry', () => {
  const db = freshDb();
  session(db, 1, 's-1', NOW - 90000);
  db.prepare('UPDATE agent_sessions SET retired_at = ? WHERE session_id = ?').run(NOW - 50000, 's-1');
  const d = decideEvent(db, evt(1, 'session.expired', 's-1', NOW - 60), { now: NOW });
  assert.equal(d.notify, null);
  assert.equal(d.retire, null);
  db.close();
});

test('an expiry retires the session even when nobody is told', () => {
  const db = freshDb();
  session(db, 1, 's-1', NOW - 90000);
  // Too old to announce, or a turn running into it: either way it is not this chat's any more.
  const old = decideEvent(db, evt(1, 'session.expired', 's-1', NOW - NOTICE_MAX_AGE_SEC - 5), { now: NOW });
  assert.equal(old.notify, null);
  assert.equal(old.retire, 's-1');

  const bad = { ...evt(2, 'session.expired', 's-1', NOW), created_at: 'not a date' };
  const d = decideEvent(db, bad, { now: NOW });
  assert.equal(d.notify, null, 'an unreadable time resolves nothing about what the user has done since');
  assert.equal(d.retire, 's-1');
  db.close();
});

test('event ids', () => {
  assert.equal(eventNumber('evt_123'), 123);
  assert.equal(eventNumber('evt_test_1790000000'), null);
  assert.equal(eventNumber(null), null);
});

// ---- the API client ----------------------------------------------------------

function respond(status, json) {
  return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
}

test('listEvents asks from the cursor and reads next_after', async () => {
  const urls = [];
  const client = new AgentClient('https://api.example', 'k', {
    fetchImpl: async (url) => { urls.push(url); return respond(200, { events: [{ id: 'evt_6' }], next_after: 'evt_6' }); },
  });
  const r = await client.listEvents({ after: 'evt_5', limit: 100 });
  assert.equal(urls[0], 'https://api.example/v1/agent/events?limit=100&after=evt_5');
  assert.deepEqual(r, { events: [{ id: 'evt_6' }], nextAfter: 'evt_6' });

  const failing = new AgentClient('https://api.example', 'k', { fetchImpl: async () => respond(503, {}) });
  await assert.rejects(failing.listEvents(), AgentUnavailable);
});

test('a run into an expired session is REPLACED, not retried into', async () => {
  // The race the events cannot close: a message sent after the expiry, before the event is read.
  const client = new AgentClient('https://api.example', 'k', {
    fetchImpl: async () => respond(404, { type: 'error', error: { type: 'not_found_error', message: 'session s-1 has expired (code: agent_session_expired)' } }),
  });
  await assert.rejects(
    (async () => { for await (const _ of client.streamRun({ sessionId: 's-1', message: 'hi' })) { /* none */ } })(),
    (e) => e instanceof AgentUnavailable && e.poisoned === true,
  );
});

// ---- the 30-minute deadline ---------------------------------------------------

test('a run stopped by its deadline is a completed partial answer that continues in the same chat', () => {
  const out = runOutcome({ id: 'r1', session_id: 's-1', status: 'completed', stop_reason: 'deadline', text: 'Half done: ...', credits: 12.5, duration_ms: 1800412 });
  assert.equal(out.ok, true);
  assert.equal(out.failed, false);
  assert.equal(out.text, 'Half done: ...');
  assert.equal(out.credits, 12.5, 'settled from what it charged, like any completed run');
  assert.equal(stopNote(out, { maxTurns: 30 }), 'stopped after 30 minutes, the time limit for one task — say "continue" and it picks up where it stopped, in the same chat');

  // The limit is OonaCode's setting; with no duration the note names none.
  const blind = runOutcome({ status: 'completed', stop_reason: 'deadline', text: '' });
  assert.match(stopNote(blind, { maxTurns: 30 }), /^stopped at the time limit for one task — say "continue"/);

  assert.equal(stopNote(runOutcome({ status: 'completed', stop_reason: 'end_turn', text: 'ok' }), { maxTurns: 30 }), null);
  assert.equal(stopNote(runOutcome({ status: 'cancelled', stop_reason: 'interrupted', text: '' }), { maxTurns: 30 }), 'stopped');
  assert.match(stopNote(runOutcome({ status: 'completed', stop_reason: 'max_turns', text: '' }), { maxTurns: 30 }), /30-step limit/);
});
