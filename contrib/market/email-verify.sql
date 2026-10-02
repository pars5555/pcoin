-- Email confirmation for market.pc.am accounts (email-verify.mjs).
-- Owner, 2026-10-02: new accounts confirm their email before they can sign in;
-- existing accounts confirm before their next exchange withdrawal or wrap.
--
-- Apply as root BEFORE deploying the code that uses it:
--   mysql pcoin_market < /opt/pcoin-market/email-verify.sql
-- Safe to run twice.
--
-- users.verify_required: 1 only for accounts opened after this went live.
--   Existing rows get 0, so nobody already signed up is locked out.
-- users.email_verified_at: epoch ms of the first confirmation; NULL = never.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_verified_at BIGINT NULL,
  ADD COLUMN IF NOT EXISTS verify_required TINYINT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS email_verifications (
  token_hash  CHAR(64)     NOT NULL PRIMARY KEY,
  email       VARCHAR(190) NOT NULL,
  created_ms  BIGINT       NOT NULL,
  expires_ms  BIGINT       NOT NULL,
  used_ms     BIGINT       NULL,
  request_ip  VARCHAR(64)  NULL,
  used_ip     VARCHAR(64)  NULL,
  KEY by_email (email, created_ms)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
