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
export function readNotifyConfig(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

export function makeNotifier({ token, chatId, log = console, prefix = '' }) {
  if (!token || !chatId) {
    log.warn('[notify] no token or chat configured — messages will be logged only');
    return async text => { log.log('[notify:disabled]', text.replace(/<[^>]+>/g, '')); return false; };
  }

  let consecutiveFailures = 0;

  return async function notify(text) {
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
  };
}
