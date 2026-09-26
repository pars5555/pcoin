-- A welcome gift, invites that pay the inviter, and the user's language (owner, 2026-09-26: "each
-- new user should get 3$ gift balance, and also bounty program similar to webcrafter ... 2$ gift each
-- invite, when created first video. and we need multilingual same as webcrafter").
--
-- Two new ledger kinds, so every total that separates deposits, hand credits and free money stays
-- true: 'gift' (the welcome gift, idem_key welcome:<chat_id>) and 'referral' (an inviter's reward,
-- idem_key referral:<invited chat_id>). SQLite cannot change a CHECK in place, so the ledger is
-- rebuilt exactly as 014 did: same columns, same rows, same ids, same indexes.
CREATE TABLE ledger_new (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id         INTEGER NOT NULL,
  delta_micro_usd INTEGER NOT NULL,              -- signed
  kind            TEXT NOT NULL
       CHECK (kind IN ('deposit_pcn','deposit_wpcn','deposit_stars','ai_turn','grant','adjust','gift','referral')),
  idem_key        TEXT NULL UNIQUE,              -- pcn:<txid>:<address>
                                                 -- | wpcn:<txhash>:<logIndex>
                                                 -- | stars:<telegram_payment_charge_id>
                                                 -- | turn:<update_id> | turn:api:proposal:<id>
                                                 -- | grant:<chat_id> | admin:<request id>
                                                 -- | welcome:<chat_id> | referral:<invited chat_id>
  rate_e12        INTEGER NULL,
  note            TEXT NULL,
  created_at      INTEGER NOT NULL
);
INSERT INTO ledger_new (id, chat_id, delta_micro_usd, kind, idem_key, rate_e12, note, created_at)
  SELECT id, chat_id, delta_micro_usd, kind, idem_key, rate_e12, note, created_at FROM ledger;
DROP TABLE ledger;
ALTER TABLE ledger_new RENAME TO ledger;
CREATE INDEX ix_ledger_chat ON ledger (chat_id, id);

-- The language the bot speaks to this user: one of lib/i18n.mjs LANGS. NULL = not set yet (users
-- from before this migration); they are read as Telegram's language_code on their next message.
ALTER TABLE users ADD COLUMN lang TEXT NULL;

-- Who invited whom. ONE ROW PER INVITED PERSON, for life (UNIQUE referred_chat_id): the first
-- inviter wins and can never be replaced, and a bad row is set 'void', never deleted -- deleting it
-- would let somebody else claim the same person. Written only when /start r<id> is the update that
-- CREATED the account, so an existing user cannot be "invited".
--
-- 'pending' -> 'rewarded' happens once, by a conditional UPDATE ... WHERE status = 'pending' in
-- the same transaction as the ledger row (whose idem_key referral:<referred> is the second lock).
CREATE TABLE referrals (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  referrer_chat_id    INTEGER NOT NULL,
  referred_chat_id    INTEGER NOT NULL UNIQUE,
  status              TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'rewarded', 'void')),
  reward_micro_usd    INTEGER NULL,          -- what was paid, stamped at payout
  trigger_item_id     INTEGER NULL,          -- the delivered video that paid it
  void_reason         TEXT    NULL,
  created_at          INTEGER NOT NULL,
  rewarded_at         INTEGER NULL,
  CHECK (referrer_chat_id <> referred_chat_id)
);
CREATE INDEX ix_referrals_referrer ON referrals (referrer_chat_id, status);
