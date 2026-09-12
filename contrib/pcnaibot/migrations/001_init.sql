-- pcnaibot schema v1.
--
-- All timestamps are INTEGER unix epoch SECONDS. Never milliseconds: webai wrote
-- milliseconds into its heartbeat, age = now - at came out about -1.8e12, which
-- is never greater than STALE_SECONDS, and the staleness alert COULD NOT FIRE AT
-- ALL. A check that cannot fire is indistinguishable from a check that passes.
--
-- All money is INTEGER. No floats anywhere near money. SQLite REAL is a float,
-- so it appears nowhere in this file.

-- addresses: the user<->address binding AND the unassigned pool, one table.
CREATE TABLE pcn_addresses (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  derivation_index   INTEGER NOT NULL UNIQUE,
  address            TEXT    NOT NULL UNIQUE,   -- stored LOWERCASE, always
  chat_id            INTEGER NULL UNIQUE,       -- NULL while unassigned
  assigned_at        INTEGER NULL,              -- set ONCE, never cleared
  remainder_nano_usd INTEGER NOT NULL DEFAULT 0 -- sub-unit carry + dust sink
);
-- Claimability is assigned_at IS NULL, never chat_id IS NULL: deleting a user
-- nulls chat_id, but an address that has been SHOWN to somebody can still
-- receive coin years later and must never be re-issued.
CREATE INDEX ix_addr_claimable ON pcn_addresses (assigned_at, derivation_index);

-- deposits: the money trail. Deliberately NO foreign key to users -- deleting a
-- user must not erase the record of money that arrived.
CREATE TABLE pcn_deposits (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  txid                    TEXT NOT NULL,
  address                 TEXT NOT NULL,
  chat_id                 INTEGER NULL,
  status                  TEXT NOT NULL
       CHECK (status IN ('seen','confirming','credited','rejected','dropped','held')),
  amount_sat              INTEGER NOT NULL,     -- exact integer sats, never a float
  block_height            INTEGER NULL,
  block_hash              TEXT NULL,            -- stamped at credit time, for reorg re-checks
  is_coinbase             INTEGER NULL,         -- from /api/tx, NOT the address summary
  confirmations_at_credit INTEGER NULL,
  credited_micro_usd      INTEGER NULL,
  credited_rate_e12       INTEGER NULL,         -- rate x 1e12, stamped ONCE
  credited_rate_text      TEXT NULL,            -- the same rate as read, humans only
  credited_rate_source    TEXT NULL
       CHECK (credited_rate_source IN ('oracle','cache')),  -- never a silent config
  credited_rate_at        INTEGER NULL,         -- when the rate was READ (!= credited_at)
  unconfirmed_known_ticks INTEGER NOT NULL DEFAULT 0,
  reorg_flagged_at        INTEGER NULL,
  flagged_reason          TEXT NULL,
  note                    TEXT NULL,
  first_seen_at           INTEGER NOT NULL,     -- the column the stuck-check ages on
  credited_at             INTEGER NULL,
  -- RULE 1, and the reason there is no vout column: vout is always 0 for these
  -- deposits, so UNIQUE(txid,vout) degenerates to UNIQUE(txid). When one
  -- transaction pays TWO of our addresses the second lookup finds the first
  -- user row, concludes "already recorded", and credits nobody. It fails safe,
  -- which is exactly why nobody sees it. The explorer address-tx summary
  -- carries no vout field at all; received_sat is already aggregated per
  -- address per transaction, so (txid, address) is the right grain.
  UNIQUE (txid, address)
);
CREATE INDEX ix_dep_open   ON pcn_deposits (status, first_seen_at);
CREATE INDEX ix_dep_chat   ON pcn_deposits (chat_id, credited_at);
CREATE INDEX ix_dep_credit ON pcn_deposits (credited_at);

CREATE TABLE users (
  chat_id            INTEGER PRIMARY KEY,
  balance_micro_usd  INTEGER NOT NULL DEFAULT 0,
  grant_micro_usd    INTEGER NOT NULL DEFAULT 0,  -- free-models-only, NOT fungible
  reserved_micro_usd INTEGER NOT NULL DEFAULT 0,  -- = SUM of open reservations
  model              TEXT NOT NULL,
  busy_at            INTEGER NULL,                -- per-user serialisation lock
  created_at         INTEGER NOT NULL
);

CREATE TABLE reservations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id     INTEGER NOT NULL,
  update_id   INTEGER NOT NULL,
  model       TEXT    NOT NULL,
  micro_usd   INTEGER NOT NULL,                  -- the quoted ceiling
  state       TEXT NOT NULL
       CHECK (state IN ('open','settled','released','expired','held')),
  created_at  INTEGER NOT NULL,
  closed_at   INTEGER NULL,
  note        TEXT NULL,
  UNIQUE (update_id)
);
CREATE INDEX ix_resv_open ON reservations (state, created_at);

-- One row per COMMITTED money movement, both directions, with a durable
-- idempotency key. Reservations are deliberately NOT in here: reserve moves
-- balance->reserved and writes nothing, settle writes one negative ai_turn row
-- and releases the remainder, a full release writes nothing. The arithmetic
-- then closes as:
--    SUM(ledger.delta_micro_usd) == balance_micro_usd + reserved_micro_usd
--    reserved_micro_usd          == SUM(reservations.micro_usd WHERE state=open)
CREATE TABLE ledger (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id         INTEGER NOT NULL,
  delta_micro_usd INTEGER NOT NULL,              -- signed
  kind            TEXT NOT NULL
       CHECK (kind IN ('deposit_pcn','deposit_wpcn','ai_turn','grant','adjust')),
  idem_key        TEXT NULL UNIQUE,              -- pcn:<txid>:<address>
                                                 -- | wpcn:<txhash>:<logIndex>
                                                 -- | turn:<update_id> | grant:<chat_id>
  rate_e12        INTEGER NULL,
  note            TEXT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX ix_ledger_chat ON ledger (chat_id, id);

-- The provider price table, cached with OUR OWN freshness stamp, because
-- /api/registry is undocumented and carries no Cache-Control, no ETag, no
-- Last-Modified and no Age. Its body own updatedAt was 13 days old while
-- refreshMinutes: 10 invited "fresh within ten minutes". Both readings are
-- wrong and there is no third, so we stamp our own.
CREATE TABLE model_prices (
  model              TEXT PRIMARY KEY,
  input_price_per_m  TEXT NOT NULL,              -- decimal strings, parsed on use
  output_price_per_m TEXT NOT NULL,
  is_free            INTEGER NOT NULL,
  context_window     INTEGER NULL,
  max_output_tokens  INTEGER NULL,
  notes              TEXT NULL,
  reachable          INTEGER NOT NULL DEFAULT 0, -- present in /v1/models for OUR key
  fetched_at         INTEGER NOT NULL
);

-- Telegram inbound claim table: turns at-least-once DELIVERY into at-most-once
-- WORK. Claim before the expensive call, never after.
CREATE TABLE tg_updates (
  update_id  INTEGER PRIMARY KEY,
  claimed_at INTEGER NOT NULL
);

-- Free-model turns are quoted at $0, so they reserve $0, so any money-based
-- admission check admits them unconditionally. One user spamming a free model
-- would deny service to every paying user at zero cost to themselves. This is
-- the independent bucket.
CREATE TABLE free_usage (
  chat_id  INTEGER NOT NULL,
  hour_key INTEGER NOT NULL,                     -- floor(epoch/3600)
  turns    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_id, hour_key)
);

CREATE TABLE conversations (
  chat_id    INTEGER PRIMARY KEY,
  history    TEXT NOT NULL,                      -- JSON array of {role,content}
  updated_at INTEGER NOT NULL
);

-- wPCN claims. Only written if D3 ever becomes yes.
CREATE TABLE wpcn_claims (
  txhash     TEXT NOT NULL,
  log_index  INTEGER NOT NULL,
  chat_id    INTEGER NOT NULL,
  wpcn_sat   INTEGER NOT NULL,   -- wPCN has 8 decimals, NOT 18. Integer.
  usd_micro  INTEGER NOT NULL,
  rate_e12   INTEGER NOT NULL,
  bonus_pct  INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (txhash, log_index)  -- NEVER the hash alone: one transaction can
                                   -- carry several Transfer logs
);

-- Small key/value store: runtime settings an admin may edit, and the last
-- ACCEPTED rate (which the 10x-jump guard compares against -- the last accepted
-- reading, not the last reading).
CREATE TABLE kv (
  k          TEXT PRIMARY KEY,
  v          TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
