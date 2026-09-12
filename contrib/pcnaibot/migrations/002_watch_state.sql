-- Touch-detection state, per address.
--
-- "Touched" is detected on lifetime.tx_count and lifetime.received_sat ONLY --
-- both monotonic for a rail that never spends. These columns hold the previous
-- observation so the diff has something to compare against.
--
-- They are deliberately NOT part of the money record: a wrong value here costs
-- one wasted /txs fetch, never a wrong credit. The watcher treats a NULL (no
-- previous observation) as TOUCHED, so the failure direction is "look again",
-- never "assume nothing happened".

ALTER TABLE pcn_addresses ADD COLUMN last_tx_count     INTEGER NULL;
ALTER TABLE pcn_addresses ADD COLUMN last_received_sat INTEGER NULL;
ALTER TABLE pcn_addresses ADD COLUMN last_observed_at  INTEGER NULL;
