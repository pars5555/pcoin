-- Per-user API keys, so a user can call the models from outside Telegram.
--
-- The key is stored as a SHA-256 HASH, never in plaintext. A database that
-- holds usable credentials for other people's money is a different class of
-- liability from one that holds balances, and the difference costs nothing to
-- avoid: the key is shown ONCE at issue and is unrecoverable afterwards.
--
-- `key_prefix` exists so a human can identify a key in a list ("pcn_3f9a...")
-- and so a support conversation never needs the secret itself.
CREATE TABLE api_keys (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id      INTEGER NOT NULL,
  key_hash     TEXT    NOT NULL UNIQUE,   -- sha256(key), lowercase hex
  key_prefix   TEXT    NOT NULL,          -- first 12 chars, for display only
  name         TEXT    NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER NULL,
  revoked_at   INTEGER NULL,              -- set once; a revoked key is never reused
  calls        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ix_apikeys_chat ON api_keys (chat_id, revoked_at);

-- Rebuild `reservations` so a turn can be keyed EITHER by a Telegram update_id
-- OR by an API request id.
--
-- Why a rebuild rather than an ALTER: update_id is INTEGER NOT NULL UNIQUE and
-- SQLite cannot drop a NOT NULL in place. Inventing a synthetic integer for API
-- calls instead would put two different id spaces in one unique column, which
-- is exactly the (txid, vout) mistake wearing a different hat -- a collision
-- there would silently reuse another turn's reservation.
--
-- The CHECK enforces that exactly one of the two is present, so there is no
-- third state for anything downstream to guess at.
CREATE TABLE reservations_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id     INTEGER NOT NULL,
  update_id   INTEGER NULL UNIQUE,        -- Telegram
  req_key     TEXT    NULL UNIQUE,        -- API
  model       TEXT    NOT NULL,
  micro_usd   INTEGER NOT NULL,
  state       TEXT NOT NULL
       CHECK (state IN ('open','settled','released','expired','held')),
  created_at  INTEGER NOT NULL,
  closed_at   INTEGER NULL,
  note        TEXT NULL,
  CHECK ((update_id IS NULL) <> (req_key IS NULL))
);

INSERT INTO reservations_new (id, chat_id, update_id, req_key, model, micro_usd, state, created_at, closed_at, note)
SELECT id, chat_id, update_id, NULL, model, micro_usd, state, created_at, closed_at, note FROM reservations;

DROP TABLE reservations;
ALTER TABLE reservations_new RENAME TO reservations;
CREATE INDEX ix_resv_open ON reservations (state, created_at);
