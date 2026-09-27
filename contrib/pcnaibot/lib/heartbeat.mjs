// What the bot's heartbeat says (review, 2026-09-27, item F2: this used to be built inline in
// main(), where no test could see it).
//
// A fresh heartbeat alone is not a healthy bot. `ok` is false while a Stars payment Telegram took is
// parked uncredited, and heartbeat-check.sh (host, root) alerts on `stars_parked` and on
// `stars_books` -- the hourly check of Telegram's Stars books against ours (lib/stars-books.mjs).
// `started_at` (unix seconds) lets that script tell "no books check has completed since the bot
// started, hours ago" from "the bot only just started" -- without it a check that never completes
// reads 'pending' (or null) for ever and nothing alerts.
export function botHeartbeat({ processed, offset, inFlight, waiting, making, starsParked, starsBooks = null, startedAt = null, stopping = false }) {
  const parked = Number(starsParked) || 0;
  return {
    ok: parked === 0,
    processed,
    offset,
    in_flight: inFlight,
    waiting,
    making,
    stars_parked: parked,
    stars_books: starsBooks,
    started_at: startedAt,
    stopping,
    last_error: parked ? `${parked} Stars payment(s) parked, not credited` : null,
  };
}
