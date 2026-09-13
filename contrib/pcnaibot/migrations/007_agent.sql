-- Agentic sessions.
--
-- The agent API keeps the conversation, the workspace and the transcript on
-- OonaCode's side, addressed by a session id. Measured 2026-09-13: input tokens
-- across three runs in one session went 2374 -> 2393 -> 2415, so the history is
-- genuinely held there and only the new message is added. We stop resending it.
--
-- WHAT THIS TABLE IS FOR IS DELETION. A session we forget the id of is a
-- sandbox, a workspace and a transcript sitting on somebody else's server until
-- it expires, with no way for us to remove it. So every session id is written
-- down BEFORE it can be used, and `deleted_at` records that we cleaned up.
CREATE TABLE agent_sessions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id       INTEGER NOT NULL,
  session_id    TEXT    NOT NULL UNIQUE,
  model         TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER NULL,
  -- Their `expires_at`, as epoch seconds. 24h from creation when measured.
  -- After it, the session 404s and a new one must be created.
  expires_at    INTEGER NULL,
  deleted_at    INTEGER NULL,        -- set once we have confirmed a 204
  runs          INTEGER NOT NULL DEFAULT 0,
  failures      INTEGER NOT NULL DEFAULT 0,  -- consecutive sandbox failures
  credits_spent TEXT    NOT NULL DEFAULT '0' -- decimal string; never a float
);

-- At most ONE live session per chat. A partial unique index is what enforces
-- that without preventing a chat from having many historical, deleted ones.
CREATE UNIQUE INDEX ux_agent_live ON agent_sessions (chat_id) WHERE deleted_at IS NULL;
CREATE INDEX ix_agent_cleanup ON agent_sessions (deleted_at, expires_at);

-- Which mode a chat is in.
--
-- NOTE THE DEFAULT IS 0, AND THAT IS DELIBERATE HISTORY. This migration ran
-- with 0 before agentic became the only mode; editing this line afterwards
-- would NOT have changed the live schema -- the migration was already recorded
-- as applied -- and the file would then describe a database that does not
-- exist. That mistake was made and caught: new users kept arriving with
-- agent_mode 0 while the file claimed 1.
--
-- The value a new user gets is now set EXPLICITLY by the code from config
-- (see ensureUser), which is both honest and changeable without a migration.
ALTER TABLE users ADD COLUMN agent_mode INTEGER NOT NULL DEFAULT 0;
