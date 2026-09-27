// What the bot's heartbeat says (review, 2026-09-27, item F2: this used to be built inline in
// main(), where no test could see it).
//
// A fresh heartbeat alone is not a healthy bot. `ok` is false while a Stars payment Telegram took is
// parked uncredited, and heartbeat-check.sh (host, root) alerts on `stars_parked` and on
// `stars_books` -- the hourly check of Telegram's Stars books against ours (lib/stars-books.mjs).
export function botHeartbeat({ processed, offset, inFlight, waiting, making, starsParked, starsBooks = null, stopping = false }) {
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
    stopping,
    last_error: parked ? `${parked} Stars payment(s) parked, not credited` : null,
  };
}
