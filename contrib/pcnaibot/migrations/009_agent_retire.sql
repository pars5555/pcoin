-- Separate "this chat is done with it" from "it is gone from their server".
--
-- These were one column, `deleted_at`, set only when a DELETE confirmed. And
-- DELETE does fail: measured 2026-09-13, seven fired in quick succession all
-- returned 400 while the same ids spaced out returned 204.
--
-- So /clear could leave `deleted_at` NULL, liveSession() would still return the
-- session, and the user's NEXT MESSAGE WOULD CONTINUE THE CONVERSATION THEY
-- JUST CLEARED -- with its files and its memory intact. The one thing /clear
-- promises is the one thing it failed to do.
--
--   retired_at  this chat is no longer bound to it. Set IMMEDIATELY on /clear,
--               on a model change, and on a poisoned session -- unconditionally,
--               because it is our own record and cannot fail.
--   deleted_at  confirmed gone from OonaCode. Set only on a 204 or a 404, and
--               what tells the sweeper to stop retrying.
--
-- A session can be retired and not yet deleted. That is the normal state
-- between a /clear and the sweeper catching up, and it must not make the
-- session reusable.
ALTER TABLE agent_sessions ADD COLUMN retired_at INTEGER NULL;

-- Anything already deleted is certainly retired too.
UPDATE agent_sessions SET retired_at = deleted_at WHERE deleted_at IS NOT NULL AND retired_at IS NULL;

-- The live-session constraint now keys on RETIREMENT, not deletion: a retired
-- session must not block a chat from starting a fresh one while we are still
-- trying to delete it.
DROP INDEX IF EXISTS ux_agent_live;
CREATE UNIQUE INDEX ux_agent_live ON agent_sessions (chat_id) WHERE retired_at IS NULL;
