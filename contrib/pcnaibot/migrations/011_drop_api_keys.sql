-- The outside-Telegram API is gone (owner, 2026-09-14: "we dont need that now, keep it simple,
-- only to use in telegram"), and with it the per-user keys. `reservations.req_key` stays: the
-- column is nullable, the CHECK still holds for Telegram rows, and rebuilding the table again
-- for an unused column is risk for nothing.
DROP TABLE IF EXISTS api_keys;
