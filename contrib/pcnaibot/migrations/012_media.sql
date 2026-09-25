-- Pictures and video made directly by an image or video model (2026-09-25).
--
-- Owner: "user should select model only from the bot list ... show badge for models that has
-- picture generation capability". A 🎨 or 🎬 entry in /models sends the user's words straight to
-- OonaCode's image or video endpoint -- no agent in between.
--
-- WHAT THIS TABLE IS FOR IS A VIDEO THAT OUTLIVES THE PROCESS. A clip takes 1-5 minutes and is a
-- job on OonaCode's side that is charged when it completes, whether or not we are still running.
-- So the job id and the reservation it will settle are written down BEFORE the user is told it
-- has started, and a poller -- at startup too -- reads every job still 'running' until it ends.
-- A restart must not release the money of a clip that is still being made, and must not lose the
-- clip.
--
-- NO PROMPT IS STORED. The words stay in memory for the buttons under a picture (Again, Wide,
-- Tall) and are gone on restart, when the buttons say so.
CREATE TABLE media_jobs (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id            INTEGER NOT NULL,
  kind               TEXT    NOT NULL CHECK (kind IN ('image', 'video')),
  model              TEXT    NOT NULL,        -- the /models entry: qwen-image-3.0-pro, happyhorse-1.1
  api_model          TEXT    NOT NULL,        -- what was called: happyhorse-1.1-t2v
  shape              TEXT    NULL,            -- square | wide | tall, for a picture
  reservation_id     INTEGER NULL,
  remote_id          TEXT    NULL,            -- the video job id
  state              TEXT    NOT NULL CHECK (state IN ('running', 'done', 'failed', 'unknown')),
  credits            TEXT    NULL,            -- what OonaCode charged, a decimal string
  result_url         TEXT    NULL,            -- valid until result_expires_at; for "Original file"
  result_expires_at  INTEGER NULL,
  status_message_id  INTEGER NULL,            -- the "making your video" message, removed at the end
  error              TEXT    NULL,
  created_at         INTEGER NOT NULL,
  finished_at        INTEGER NULL
);

CREATE INDEX ix_media_jobs_running ON media_jobs (state, kind);
