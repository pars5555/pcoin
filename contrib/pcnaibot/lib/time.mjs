// Unix epoch SECONDS. Never milliseconds.
//
// webai wrote milliseconds into its heartbeat; `age = now - at` came out about
// -1.8e12, which is never greater than STALE_SECONDS, so the staleness alert
// COULD NOT FIRE AT ALL. Everything in this codebase that stamps a time uses
// this function, so there is one place to be wrong and it is right.
export function nowSec() {
  return Math.floor(Date.now() / 1000);
}
