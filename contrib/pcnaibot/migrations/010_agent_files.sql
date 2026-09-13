-- Files the agent produced, and whether the user has been given them.
--
-- WITHOUT THIS THE BOT CANNOT HAND BACK ANYTHING THE AGENT MAKES. Measured
-- 2026-09-14: asked for a bakery logo, the agent installed `sharp`, staged
-- fonts, wrote an SVG and rendered `lavash-house-logo.png` (72,306 bytes) --
-- all of it correct, and the user saw none of it, because the bot read only
-- the answer TEXT and never looked in the workspace. A tool that can make
-- things is useless if what it makes never arrives.
--
-- `sent_at` is what stops a file being re-sent on every later run in the same
-- session. The (name, size, mtime) key is what notices a file that CHANGED and
-- should therefore be sent again -- a logo the user asked to revise is a new
-- file under the same name.
CREATE TABLE agent_files (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT    NOT NULL,
  name       TEXT    NOT NULL,          -- path within the workspace
  size       INTEGER NULL,
  mtime      TEXT    NULL,              -- their ISO string, stored verbatim
  -- 'uploaded' = WE put it there, so it must never be sent back; 'produced' =
  -- the agent made it. Returning a user's own photo to them would be absurd,
  -- and the uploaded file sits in the same listing as the output.
  origin     TEXT    NOT NULL CHECK (origin IN ('uploaded', 'produced')),
  sent_at    INTEGER NULL,
  UNIQUE (session_id, name, size, mtime)
);

CREATE INDEX ix_agent_files_session ON agent_files (session_id, sent_at);
