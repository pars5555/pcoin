-- Review of 2026-09-27: a claimed message must survive a restart, and a paid user must be told.
--
-- A. A chat message was claimed (tg_updates) and then waited in an IN-MEMORY queue for a free
--    slot. A deploy, crash or OOM in that wait lost it for good: Telegram redelivered it, the claim
--    said "already done", and the user never got an answer. The claim now carries the message and
--    its state, written in the same statement:
--      queued   claimed, not started -- re-run at the next start if still recent (lib/inbox.mjs)
--      started  running -- never re-run by itself (work stays at-most-once); the user is told
--      done     answered (body cleared)
--      lost     given up on at a restart, and the user told to send it again
--    Every older row keeps state NULL: those are finished or were never chat messages.
ALTER TABLE tg_updates ADD COLUMN state TEXT NULL CHECK (state IN ('queued', 'started', 'done', 'lost'));
ALTER TABLE tg_updates ADD COLUMN chat_id INTEGER NULL;
ALTER TABLE tg_updates ADD COLUMN body TEXT NULL;          -- the message JSON while queued/started
ALTER TABLE tg_updates ADD COLUMN started_at INTEGER NULL;
CREATE INDEX ix_tg_updates_open ON tg_updates (state) WHERE state IN ('queued', 'started');

-- B. "✅ Paid" was sent only by the delivery that also wrote the claim, and only after it. A crash
--    between the credit and the claim made the redelivery answer "already credited"; a crash
--    between the claim and the send told the user nothing at all. Now the payment row records
--    when the user was told, and "✅ Paid" is sent -- by the loop or by a sweep -- until it is.
--    Rows that exist today were answered by the old code.
ALTER TABLE stars_payments ADD COLUMN notified_at INTEGER NULL;
UPDATE stars_payments SET notified_at = created_at;
