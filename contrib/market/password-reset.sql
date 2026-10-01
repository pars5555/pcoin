-- Password reset for market.pc.am accounts (and so for the exchange and the
-- wrap desk, which sign in through market). See password-reset.mjs.
--
-- Apply as root; the app's own DB user has no DDL rights, on purpose:
--   mysql pcoin_market < /opt/pcoin-market/password-reset.sql
-- Safe to run twice.

-- Every session minted before this instant (epoch ms) is refused. A reset sets
-- it, so a stolen session does not outlive the password change. NULL = no
-- reset has ever happened, and every unexpired session stays good.
ALTER TABLE users ADD COLUMN IF NOT EXISTS sessions_valid_after BIGINT NULL;

-- One row per emailed link. Only the SHA-256 of the token is kept: a read of
-- this table cannot be replayed as a reset. Times are epoch ms, written by the
-- server's own clock, so no timezone sits between the code and the check.
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash  CHAR(64)     NOT NULL PRIMARY KEY,
  email       VARCHAR(190) NOT NULL,
  created_ms  BIGINT       NOT NULL,
  expires_ms  BIGINT       NOT NULL,
  used_ms     BIGINT       NULL,
  request_ip  VARCHAR(64)  NULL,
  used_ip     VARCHAR(64)  NULL,
  KEY by_email (email, created_ms)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
