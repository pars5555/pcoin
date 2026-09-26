-- Payment safety (review of 2026-09-26): a Stars refund that cannot race a purchase, an invite
-- reward that a refund cannot farm, and a pasted wPCN hash that survives a restart.
--
-- 1. A Stars refund now takes the money off the balance FIRST (in one BEGIN IMMEDIATE, refused
--    if the balance does not cover it), THEN asks Telegram. It used to check, await Telegram, and
--    deduct after -- a ✅ pressed during the await spent the same money, the balance went negative
--    and the house paid for the picture as well as returning the Stars.
--      refund_state     NULL (none) | 'pending' (deducted, Telegram's answer not yet final) | 'done'
--      refund_clawback  1 = on success, also take the invite reward back from the inviter
--    A definite refusal from Telegram puts the money back with its own ledger row; no answer leaves
--    it 'pending' and the admin asks again (a charge Telegram already refunded answers
--    CHARGE_ALREADY_REFUNDED, which settles it).
ALTER TABLE stars_payments ADD COLUMN refund_state TEXT NULL CHECK (refund_state IN ('pending', 'done'));
ALTER TABLE stars_payments ADD COLUMN refund_started_at INTEGER NULL;
ALTER TABLE stars_payments ADD COLUMN refund_clawback INTEGER NOT NULL DEFAULT 0;

-- 2. The top-up an invite reward required, stamped when it was paid. A Stars refund that would take
--    the invited person's paid-in money below it is refused unless the reward is taken back too.
ALTER TABLE referrals ADD COLUMN min_topup_micro_usd INTEGER NULL;

-- 3. Every pasted wPCN hash, written BEFORE the verifier is asked. The verifier commits its claim
--    before it answers; a restart between the two used to park the payment there until the user
--    happened to paste the hash again. Open rows are re-checked every minute (and at start) until
--    they reach a final answer, so a restart loses nothing and a payment pasted while still
--    confirming is credited by itself.
CREATE TABLE wpcn_checks (
  chat_id     INTEGER NOT NULL,
  txhash      TEXT    NOT NULL,             -- lower-case 0x + 64 hex
  created_at  INTEGER NOT NULL,
  checked_at  INTEGER NULL,                 -- last time the verifier was asked
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_state  TEXT    NULL,
  done_at     INTEGER NULL,                 -- a final answer (or given up: last_state 'expired')
  PRIMARY KEY (chat_id, txhash)
);
CREATE INDEX ix_wpcn_checks_open ON wpcn_checks (done_at, created_at);

-- The welcome gift's daily total is read on every new account.
CREATE INDEX ix_ledger_kind_time ON ledger (kind, created_at);
