// What happened to a chat while nobody was talking to it, told to the person in Telegram.
//
// Owner, 2026-09-25: "send message in bot what happened and what remembered or forgot so user
// know ... if he can continue or it will start fresh or will restore". OonaCode records an event
// when a session's workspace is deleted (idle past its workspace window, 60 min today: the files
// are gone, the conversation is kept and the next message restores it) and when a session expires
// (idle past its lifetime, 24 h today: the agent forgets it and refuses further runs with
// `404 agent_session_expired`). This reads those events and sends each chat one plain notice.
//
// POLLED, NOT A WEBHOOK. A webhook needs a public https endpoint into this process, and this
// process holds balances; a minute of latency is not worth a new door into it. `GET
// /v1/agent/events` carries the same events, kept for seven days.
//
// AT MOST ONCE. The cursor is written BEFORE the notice is sent -- the claim-before-work rule of
// tg_updates -- so a crash between the two loses one notice rather than sending it twice. A
// missed "your files were deleted" costs nothing; the same notice twice looks broken.

import { kvGetJson, kvSetJson } from './db.mjs';
import { nowSec } from './time.mjs';
import { markForDeletion } from './agentstore.mjs';
import { escapeHtml } from './telegram.mjs';
import { log, chatTag } from './log.mjs';

export const EVENTS_CURSOR_KEY = 'agent:events_after';

// A notice about a chat's workspace is news near the moment it happened. After a long outage of
// this bot the backlog would arrive as a burst of messages about chats their owners have long
// left, so an older event still changes our own state but tells nobody.
export const NOTICE_MAX_AGE_SEC = 3 * 3600;

// acquireUserLock's staleness window: a busy_at fresher than this is a turn in progress.
const BUSY_FRESH_SEC = 180;

// Only if an event arrives without OonaCode's own sentence, which names the real idle window.
const FALLBACK = {
  'session.files_deleted': 'This chat was idle, so the files the agent made in it were deleted. '
    + 'It still remembers the conversation: reply and it continues where it left off.',
  'session.expired': 'This chat had no messages for a long time and has ended. '
    + 'The agent no longer remembers it: your next message starts a new conversation.',
};

export function eventNumber(id) {
  const m = /^evt_(\d{1,18})$/.exec(String(id ?? ''));
  return m ? Number(m[1]) : null;
}

export function noticeHtml(ev) {
  const said = typeof ev.message === 'string' && ev.message.trim()
    ? ev.message.trim().slice(0, 600)
    : FALLBACK[ev.type];
  // What the agent lost is its copy. What it already sent is in this chat and stays there.
  const extra = ev.type === 'session.files_deleted'
    ? ' Files already sent to you here are not affected; to work on one again, send it back.'
    : '';
  return `<i>${escapeHtml(said + extra)}</i>`;
}

// What to do about one event. Reads only; the caller acts on the answer:
//   { retire: session id | null, notify: chat id | null, html, why }
export function decideEvent(db, ev, { now = nowSec() } = {}) {
  const none = (why, retire = null) => ({ retire, notify: null, html: null, why });
  const type = ev?.type;
  if (type !== 'session.files_deleted' && type !== 'session.expired') return none(`not a session event: ${type}`);
  const sid = ev.session?.id;
  if (typeof sid !== 'string' || sid === '') return none('no session id');

  const row = db.prepare('SELECT * FROM agent_sessions WHERE session_id = ?').get(sid);
  // Not ours, or a chat that has already moved on (/clear, a replaced session): nothing to say.
  if (!row) return none('unknown session');
  if (row.retired_at !== null) return none('session already retired');

  // An expired session takes no more runs, so it stops being this chat's whatever else is true:
  // the next message starts a new one instead of collecting a 404 first.
  const retire = type === 'session.expired' ? sid : null;

  // An event whose time we cannot read says nothing about what the user has done since.
  const at = Date.parse(ev.created_at);
  if (!Number.isFinite(at)) return none('unreadable created_at', retire);
  const atSec = Math.floor(at / 1000);
  if (now - atSec > NOTICE_MAX_AGE_SEC) return none('too old to tell', retire);

  // Someone talking to the bot right now needs no notice: the turn in progress restores the
  // workspace, or meets the expiry and starts fresh on its own.
  const user = db.prepare('SELECT busy_at FROM users WHERE chat_id = ?').get(row.chat_id);
  if (user?.busy_at != null && user.busy_at >= now - BUSY_FRESH_SEC) return none('a turn is running', retire);

  // Used after the files went: that message already restored the workspace.
  if (type === 'session.files_deleted' && row.last_used_at !== null && row.last_used_at >= atSec) {
    return none('used since');
  }
  return { retire, notify: row.chat_id, html: noticeHtml(ev), why: type };
}

// Read every event past the cursor and act on each. One pass; the caller runs it on a timer and
// must not overlap two passes.
export async function pollAgentEvents(db, client, tg, { limit = 100, maxPages = 10, now = nowSec } = {}) {
  let after = kvGetJson(db, EVENTS_CURSOR_KEY)?.after ?? null;
  const counts = { handled: 0, retired: 0, told: 0 };

  for (let page = 0; page < maxPages; page++) {
    const { events, nextAfter } = await client.listEvents({ after, limit });
    for (const ev of events) {
      const n = eventNumber(ev?.id);
      if (n === null) { log.warn('agent event with an unreadable id; skipped', { id: String(ev?.id).slice(0, 40) }); continue; }
      // At or below the cursor is already handled: an overlapping page, a re-read.
      if (after !== null && n <= (eventNumber(after) ?? 0)) continue;

      after = ev.id;
      kvSetJson(db, EVENTS_CURSOR_KEY, { after });
      counts.handled++;

      const d = decideEvent(db, ev, { now: now() });
      if (d.retire) { markForDeletion(db, d.retire); counts.retired++; }
      log.info('agent session event', {
        type: ev.type, session: String(ev.session?.id ?? '').slice(0, 8),
        chat: d.notify !== null ? chatTag(d.notify) : null, retired: !!d.retire, why: d.why,
      });
      if (d.notify === null) continue;
      const sent = await tg.sendLong(d.notify, d.html);
      if (sent.length && sent.every((r) => r.ok)) counts.told++;
      else log.warn('could not send a session notice', { chat: chatTag(d.notify), desc: sent.at(-1)?.description ?? null });
    }
    // A full page means there may be more; anything short of that is the end.
    if (!nextAfter || events.length === 0) break;
  }
  return counts;
}
