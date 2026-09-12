-- Probe results, per model.
--
-- WHY THIS EXISTS: /v1/models IS NOT AUTHORITATIVE FOR REACHABILITY.
--
-- Measured 2026-09-11 with a real API key: /v1/models listed all 24 pool models
-- and the diff against registry.oonacode was EMPTY -- yet claude-opus-5,
-- claude-sonnet-5 and claude-haiku-4-5 all refuse at call time with
--     "this model is served by a subscription credential, and the provider
--      accepts it only from the Claude Code engine"
-- so a user who picked one would have a reservation taken and then released,
-- every single turn, forever. The build brief assumed the model list settled
-- this. It does not.
--
-- AND A SECOND, WORSE ONE: max_tokens DOES NOT BOUND OUTPUT on every model.
-- qwen3.7-max returned 9,085 output tokens against max_tokens=32 -- a 284x
-- overrun -- while still reporting stop_reason "max_tokens". max_tokens is the
-- ONLY thing bounding the reservation, so on such a model every settle
-- overruns and, under the no-clamp rule, the whole overrun lands on the
-- customer's balance.
--
-- Neither condition is visible in the registry, in /v1/models, or in the notes
-- field. The only way to know is to ASK THE MODEL, so we ask, and we store the
-- answer.

ALTER TABLE model_prices ADD COLUMN probe_ok         INTEGER NULL;  -- 1 callable, 0 refused, NULL never probed
ALTER TABLE model_prices ADD COLUMN probe_bounded    INTEGER NULL;  -- 1 honours max_tokens, 0 overruns
ALTER TABLE model_prices ADD COLUMN probe_overrun_x  TEXT    NULL;  -- observed output/cap ratio, for humans
ALTER TABLE model_prices ADD COLUMN probe_note       TEXT    NULL;
ALTER TABLE model_prices ADD COLUMN probed_at        INTEGER NULL;
