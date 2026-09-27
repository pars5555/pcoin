// A claimed chat message survives a restart (review, 2026-09-27, item A).
//
// The poll loop claims every update before working on it -- at-least-once DELIVERY becomes
// at-most-once WORK. A chat message then waited for a free slot in an in-memory queue
// (lib/turns.mjs), and a deploy or crash in that wait lost it: Telegram redelivered it, the claim
// said "already done", and the user was never answered. Now the claim carries the message and a
// state (migration 017), written in the same statement as the claim itself:
//
//   claimMessage  INSERT ... 'queued' with the message JSON        (the claim)
//   startTurn     queued -> started, exactly once                  (just before the work)
//   finishTurn    started -> done, body cleared                    (after the answer)
//   recoverTurns  at start: recent 'queued' rows are run again; older ones, and every 'started'
//                 one, become 'lost' and their users are told to send the message again.
//
// A 'started' turn is NEVER re-run by itself. It may have spent money or half-answered; running it
// twice is the bug the claim exists to prevent.
import { nowSec } from './time.mjs';
import { immediate } from './db.mjs';

// A queued message older than this at a restart is not answered late: the user has moved on.
export const TURN_RECOVERY_MAX_AGE_SEC = 30 * 60;

// The claim, carrying the message. Returns false when this update was claimed before.
export function claimMessage(db, up, now = nowSec()) {
  const msg = { ...up.message, __update_id: up.update_id };
  return db.prepare(
    `INSERT OR IGNORE INTO tg_updates (update_id, claimed_at, state, chat_id, body) VALUES (?,?, 'queued', ?, ?)`
  ).run(up.update_id, now, msg.chat?.id ?? null, JSON.stringify(msg)).changes === 1;
}

// queued -> started. False when it was started (or given up on) already: do not run it.
export function startTurn(db, updateId, now = nowSec()) {
  return db.prepare(
    "UPDATE tg_updates SET state = 'started', started_at = ? WHERE update_id = ? AND state = 'queued'"
  ).run(now, updateId).changes === 1;
}

export function finishTurn(db, updateId) {
  db.prepare("UPDATE tg_updates SET state = 'done', body = NULL WHERE update_id = ? AND state = 'started'").run(updateId);
}

// Returns { resume: [message], lost: [{ updateId, chatId, was }] }. The lost rows are marked in the
// same transaction, so a second start does not tell anybody twice.
export function recoverTurns(db, { maxAgeSec = TURN_RECOVERY_MAX_AGE_SEC, now = nowSec() } = {}) {
  return immediate(db, () => {
    const rows = db.prepare(
      "SELECT update_id, chat_id, state, body, claimed_at FROM tg_updates WHERE state IN ('queued', 'started') ORDER BY update_id"
    ).all();
    const resume = [];
    const lost = [];
    const lose = db.prepare("UPDATE tg_updates SET state = 'lost', body = NULL WHERE update_id = ?");
    for (const r of rows) {
      let msg = null;
      if (r.state === 'queued' && now - r.claimed_at <= maxAgeSec) {
        try { msg = JSON.parse(r.body); } catch { msg = null; }
      }
      if (msg && msg.chat?.id !== undefined) {
        resume.push(msg);
      } else {
        lose.run(r.update_id);
        lost.push({ updateId: r.update_id, chatId: r.chat_id, was: r.state });
      }
    }
    return { resume, lost };
  });
}
