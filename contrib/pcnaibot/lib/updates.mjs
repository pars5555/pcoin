// The one place an update's work may come BEFORE its claim (review, 2026-09-26: "fix the
// lost-payment-on-restart bug").
//
// The poll loop claims each update (INSERT into tg_updates) before working on it, which makes work
// AT-MOST-ONCE -- right for a chat turn that costs money to repeat, wrong for a payment Telegram has
// already taken: a successful_payment update was claimed, then waited for a free slot, and a
// restart in that wait lost the credit for good, because a claimed update is never retried.
//
// A Stars credit is idempotent on Telegram's charge id, so it runs FIRST, synchronously, and the
// claim follows. A restart can then only make it run twice (the second run answers "already
// credited"), never not at all. If `credit` throws, nothing is claimed and the caller fetches the
// same update again.
import { nowSec } from './time.mjs';

export function creditThenClaim(db, up, credit, now = nowSec()) {
  const reply = credit(up.message);
  const claimed = db.prepare('INSERT OR IGNORE INTO tg_updates (update_id, claimed_at) VALUES (?,?)').run(up.update_id, now).changes === 1;
  return { reply, claimed };
}
