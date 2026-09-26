-- The bot becomes a picture & video studio (owner, 2026-09-26).
--
-- A free chat agent talks with the user and proposes ONE picture or video as a card with its
-- price; the user's ✅ on that card is the only thing that moves money; the builder makes it. The
-- models are the admin's choice (kv 'studio:settings'), never the user's.
--
-- items      -- everything in a chat that can be pointed at: "#12". The user's own photos and every
--               picture or clip the bot made. How a result is found again for editing: its
--               Telegram file id (kept by Telegram for good) or, for 24 h, the provider's URL.
-- proposals  -- the cards. One open card per chat; a newer one replaces it.
--
-- PROMPTS ARE STORED NOW. Migration 012 kept them in memory only; editing "#12" days later needs
-- what #12 was made from, and the conversation itself was already stored in `conversations`.
CREATE TABLE items (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id            INTEGER NOT NULL,
  kind               TEXT    NOT NULL CHECK (kind IN ('upload', 'image', 'video')),
  job_id             INTEGER NULL,
  proposal_id        INTEGER NULL,
  summary            TEXT    NULL,            -- one line, in the user's language
  prompt             TEXT    NULL,            -- what the generator was asked for
  sources            TEXT    NOT NULL DEFAULT '[]',  -- JSON: the item ids it was made from
  start_item_id      INTEGER NULL,            -- a clip's first frame, when it had one
  tg_file_id         TEXT    NULL,
  tg_message_id      INTEGER NULL,            -- the message that shows it, for reply-to
  result_url         TEXT    NULL,
  result_expires_at  INTEGER NULL,
  delivered_at       INTEGER NULL,
  delivery_attempts  INTEGER NOT NULL DEFAULT 0,
  last_attempt_at    INTEGER NULL,
  created_at         INTEGER NOT NULL
);
-- Message ids are per chat, so a reply is looked up by the pair.
CREATE UNIQUE INDEX ux_items_message ON items (chat_id, tg_message_id) WHERE tg_message_id IS NOT NULL;
CREATE INDEX ix_items_chat ON items (chat_id, id);
CREATE INDEX ix_items_undelivered ON items (delivered_at, kind);

CREATE TABLE proposals (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id         INTEGER NOT NULL,
  kind            TEXT    NOT NULL CHECK (kind IN ('image', 'video')),
  model           TEXT    NOT NULL,           -- the catalogue entry: wan2.7-image-pro, happyhorse-1.1
  api_model       TEXT    NOT NULL,           -- what is called: happyhorse-1.1-i2v
  prompt          TEXT    NOT NULL,
  summary         TEXT    NOT NULL,
  shape           TEXT    NOT NULL,
  seconds         INTEGER NULL,
  resolution      TEXT    NULL,
  sources         TEXT    NOT NULL DEFAULT '[]',  -- JSON: item ids used as input images / first frame
  new_version_of  INTEGER NULL,               -- the clip this one redoes
  price_micro     INTEGER NOT NULL,           -- the price on the button: the most the user pays
  state           TEXT    NOT NULL CHECK (state IN ('open', 'started', 'done', 'failed', 'cancelled', 'replaced', 'expired')),
  message_id      INTEGER NULL,
  expires_at      INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  decided_at      INTEGER NULL
);
CREATE INDEX ix_proposals_chat_state ON proposals (chat_id, state);

ALTER TABLE media_jobs ADD COLUMN proposal_id INTEGER NULL;
ALTER TABLE media_jobs ADD COLUMN item_id INTEGER NULL;

-- The old general-purpose chat must not steer the new agent.
DELETE FROM conversations;
