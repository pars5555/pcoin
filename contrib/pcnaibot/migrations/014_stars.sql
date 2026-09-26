-- Telegram Stars top-ups (owner, 2026-09-26: "add telegram stars payment similar to webbuilderbot").
--
-- A Stars payment credits the USD balance at the admin's rate (kv 'studio:settings'.starsUsd),
-- stamped on the row, exactly like a PCN deposit stamps its rate. The ledger gets its own kind,
-- 'deposit_stars', so every total that separates deposits from hand credits stays true.
--
-- SQLite cannot change a CHECK in place, so the ledger is rebuilt: same columns, same rows, same
-- ids, same indexes. UNIQUE(idem_key) is what makes a credit happen once -- assertSchema() checks it
-- is still there on every start.
CREATE TABLE ledger_new (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id         INTEGER NOT NULL,
  delta_micro_usd INTEGER NOT NULL,              -- signed
  kind            TEXT NOT NULL
       CHECK (kind IN ('deposit_pcn','deposit_wpcn','deposit_stars','ai_turn','grant','adjust')),
  idem_key        TEXT NULL UNIQUE,              -- pcn:<txid>:<address>
                                                 -- | wpcn:<txhash>:<logIndex>
                                                 -- | stars:<telegram_payment_charge_id>
                                                 -- | turn:<update_id> | turn:api:proposal:<id>
                                                 -- | grant:<chat_id> | admin:<request id>
  rate_e12        INTEGER NULL,
  note            TEXT NULL,
  created_at      INTEGER NOT NULL
);
INSERT INTO ledger_new (id, chat_id, delta_micro_usd, kind, idem_key, rate_e12, note, created_at)
  SELECT id, chat_id, delta_micro_usd, kind, idem_key, rate_e12, note, created_at FROM ledger;
DROP TABLE ledger;
ALTER TABLE ledger_new RENAME TO ledger;
CREATE INDEX ix_ledger_chat ON ledger (chat_id, id);

-- Every invoice the bot sent, written BEFORE it is sent (webbuilderbot's shape). The pre-checkout
-- answer checks the payment against THIS row -- payer, amount, currency, age -- so an invoice we
-- never issued, or one for another user or another price, is refused before Telegram takes the Stars.
CREATE TABLE stars_invoices (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id     INTEGER NOT NULL,
  payload     TEXT    NOT NULL UNIQUE,
  stars       INTEGER NOT NULL,
  micro_usd   INTEGER NOT NULL,           -- what it credits
  state       TEXT    NOT NULL CHECK (state IN ('pending', 'paid', 'expired')),
  created_at  INTEGER NOT NULL,
  paid_at     INTEGER NULL
);
CREATE INDEX ix_stars_invoices_chat ON stars_invoices (chat_id, id);

-- Every Stars payment Telegram confirmed. The charge id is Telegram's own and unique -- it is the
-- idempotency key (webbuilderbot keyed on its payload) and what a refund names. `micro_usd` is what
-- was credited: the package's price, fixed when the invoice was sent.
CREATE TABLE stars_payments (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id             INTEGER NOT NULL,
  invoice_id          INTEGER NOT NULL,
  charge_id           TEXT    NOT NULL UNIQUE,   -- telegram_payment_charge_id
  stars               INTEGER NOT NULL,
  micro_usd           INTEGER NOT NULL,
  created_at          INTEGER NOT NULL,
  refunded_at         INTEGER NULL,
  refund_note         TEXT    NULL
);
CREATE INDEX ix_stars_chat ON stars_payments (chat_id, id);
