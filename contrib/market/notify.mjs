// Telegram notifications for market.pc.am.
//
// DESTINATION DISCIPLINE. These go to a PRIVATE monitoring channel, never to
// the public announcement channel. That distinction has been broken here once
// already: monitoring output was pointed at @PCoinPCN and subscribers were sent
// "Main process exited, code=exited, status=3/NOTIMPLEMENTED" along with an
// internal hostname. Announcements are written by a person and posted
// deliberately; alerts are for whoever fixes them.
//
// A notification that cannot be delivered must never take a payment down with
// it. Every failure here is logged and swallowed: the coins matter, the message
// about them does not.

import { readFileSync, existsSync } from 'node:fs';

/** Reads TELEGRAM_TOKEN / ALERT_CHAT style config from a shell-ish env file.
 *  Same format the existing pcoin-notify uses, so there is one convention. */
export function readNotifyConfig(path, { log = console } = {}) {
  // THIS MUST NEVER THROW. It is called at MODULE SCOPE by the market server,
  // so anything it raises kills the whole process before the HTTP listener
  // exists — and systemd restarts it into the same failure, forever.
  //
  // It guarded `existsSync` only, which is the wrong half of the problem. On
  // 2026-08-15 alert.conf was REPLACED (new inode) with group `pcoin` instead
  // of `pcoin-alert`, so existsSync still passed — the daemon can traverse the
  // directory — and readFileSync threw EACCES. The running process survived
  // solely because it had read the file into memory days earlier; the next
  // restart, for any reason at all, would have taken market.pc.am down
  // completely and kept it down. A shop that cannot reach its alert channel
  // must still be a shop.
  //
  // Degrading loudly is the right trade: no token means makeNotifier already
  // logs every message instead of sending it, which is a bad day, not an
  // outage.
  try {
    if (!existsSync(path)) {
      log.warn(`[notify] ${path} does not exist — alerts will be LOGGED ONLY`);
      return {};
    }
    const out = {};
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    return out;
  } catch (e) {
    log.error(`[notify] CANNOT READ ${path} (${e.code || e.message}) — alerts are LOGGED ONLY. ` +
              `Fix the permissions; the service is running blind but is NOT down.`);
    return {};
  }
}

// FIRE AND FORGET. Nothing that happens on api.telegram.org may delay a
// customer.
//
// This used to be an ordinary async function that every caller awaited. It
// could not THROW -- failures were already caught and swallowed -- but it could
// still take up to fifteen seconds, and thirty call sites awaited it: placing
// an order, delivering coins, an admin signing in. So a Telegram outage did not
// break the market, it made every one of those operations hang for fifteen
// seconds each, which to anyone using the site is the same thing as broken.
// Owner, 2026-09-18: "if telegram goes down then our requests will die because
// of telegram request".
//
// So the send is DETACHED. notify() hands the message to a background task and
// returns immediately; `await notify(...)` at the call sites still works and now
// costs nothing. Nobody used the return value, which is what makes this safe --
// a caller that needed to know whether the message landed would have to use
// sendNow() instead.
//
// IN-FLIGHT IS CAPPED. A detached send holds a timer for up to fifteen seconds;
// a long outage plus busy traffic would otherwise pile up unboundedly. Past the
// cap messages are dropped with a count, because losing an alert is better than
// exhausting the memory of the process the alert is about.
const MAX_IN_FLIGHT = 100;

export function makeNotifier({ token, chatId, log = console, prefix = '' }) {
  if (!token || !chatId) {
    log.warn('[notify] no token or chat configured — messages will be logged only');
    return async text => { log.log('[notify:disabled]', text.replace(/<[^>]+>/g, '')); return false; };
  }

  let consecutiveFailures = 0;
  let inFlight = 0;
  let dropped = 0;

  async function sendNow(text) {
    const body = prefix ? `${prefix}\n${text}` : text;
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: body,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(15000),
      });
      const j = await r.json().catch(() => ({}));
      if (!j.ok) throw new Error(j.description || `HTTP ${r.status}`);
      consecutiveFailures = 0;
      return true;
    } catch (e) {
      // Never throw. A delivery must not fail because a chat server did.
      consecutiveFailures++;
      // Log the first few loudly, then stop shouting -- a dead chat should not
      // fill the journal and hide the entries that matter.
      if (consecutiveFailures <= 3 || consecutiveFailures % 50 === 0) {
        log.error(`[notify] failed (${consecutiveFailures}x): ${e.message} — message was: ` +
                  body.replace(/<[^>]+>/g, '').replace(/\n/g, ' | ').slice(0, 300));
      }
      return false;
    }
  }

  // The function the rest of the code calls. Returns an already-resolved
  // promise so `await notify(...)` is a no-op rather than a wait.
  function notify(text) {
    if (inFlight >= MAX_IN_FLIGHT) {
      dropped++;
      if (dropped === 1 || dropped % 100 === 0) {
        log.error(`[notify] ${inFlight} sends already in flight — DROPPING alerts (${dropped} so far). ` +
                  `Telegram is probably down; the market is unaffected.`);
      }
      return Promise.resolve(false);
    }
    inFlight++;
    // .finally, not a try/catch around an await: this is deliberately NOT
    // awaited here, and an un-awaited promise that rejects would be an
    // unhandled rejection. sendNow never throws, and the .catch() is the belt
    // to that braces.
    sendNow(text)
      .catch(e => log.error(`[notify] unexpected: ${e && e.message}`))
      .finally(() => { inFlight--; });
    return Promise.resolve(true);
  }

  // For anything that genuinely needs to know the message landed. Nothing does
  // today; it exists so that a future caller does not quietly re-introduce the
  // blocking behaviour by reaching for notify().
  notify.sendNow = sendNow;
  notify.stats = () => ({ inFlight, dropped, consecutiveFailures });
  return notify;
}
