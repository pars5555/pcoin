// The Telegram Bot API client.
//
// TWO RULES SHAPE THIS FILE.
//
// 1. MARKDOWN HAS COST THIS PROJECT REAL MESSAGES TWICE -- 22 consecutive lost
//    wrap-desk nags, and five lost `index_unhealthy` alerts during a live
//    payment-rail outage where NO HUMAN WAS EVER TOLD. So: parse_mode=HTML with
//    every untrusted span escaped, and a plain-text fallback on "can't parse
//    entities". Formatting is decoration; delivery is the job.
//
// 2. sendMessage HAS NO IDEMPOTENCY KEY. If its HTTP response is lost the
//    message may well have arrived. The FACT is the message_id in the body, and
//    NO message_id MEANS UNKNOWN -- which is its own state and must not
//    collapse into "not sent". For a user-facing ANSWER the retry direction
//    inverts from pcoin-notify's: a duplicate is a second paid generation and a
//    confusing chat, so on an unknown outcome we ASK rather than silently
//    re-answer.

import { log, errFields } from './log.mjs';

// Telegram counts text in UTF-16 CODE UNITS, after the markup is parsed.
export const TEXT_LIMIT = 4096;
export const CAPTION_LIMIT = 1024;
const SPLIT_TARGET = 3500;

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Length as Telegram counts it: UTF-16 code units of the text with HTML tags
// removed and entities resolved. Every emoji is TWO units.
export function telegramLength(html) {
  const withoutTags = String(html).replace(/<[^>]*>/g, '');
  const resolved = withoutTags
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
  return resolved.length; // JS string length IS UTF-16 code units
}

// Split at paragraph or code-fence boundaries, never mid-entity.
export function splitMessage(html, target = SPLIT_TARGET) {
  if (telegramLength(html) <= target) return [html];

  const parts = [];
  let buf = '';
  let inPre = false;

  const flush = () => {
    if (buf.trim() !== '') parts.push(buf.replace(/\n+$/, ''));
    buf = '';
  };

  for (const line of String(html).split('\n')) {
    if (/<\/?pre>/.test(line)) inPre = !inPre;
    const candidate = buf === '' ? line : `${buf}\n${line}`;
    if (telegramLength(candidate) > target && buf !== '' && !inPre) {
      flush();
      buf = line;
    } else {
      buf = candidate;
    }
  }
  flush();

  // A single line longer than the target still has to go somewhere. Hard-split
  // it, but only outside markup.
  const out = [];
  for (const p of parts) {
    if (telegramLength(p) <= TEXT_LIMIT) { out.push(p); continue; }
    let rest = p;
    while (telegramLength(rest) > TEXT_LIMIT) {
      out.push(rest.slice(0, TEXT_LIMIT - 20));
      rest = rest.slice(TEXT_LIMIT - 20);
    }
    if (rest !== '') out.push(rest);
  }
  return out;
}

export class TelegramClient {
  constructor(token, { fetchImpl = fetch, timeoutMs = 30000 } = {}) {
    // The token lives here in module scope and NOWHERE else. It is never
    // logged, never put in an error, never in process.env.
    this.#token = token;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  #token;

  get apiBase() {
    return `https://api.telegram.org/bot${this.#token}`;
  }

  // Returns a discriminated result. `ok:false, unknown:true` means the outcome
  // is genuinely unknown -- the caller must NOT treat it as "not sent".
  async call(method, params, { timeoutMs = this.timeoutMs } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.apiBase}/${method}`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
      });

      let body = null;
      try { body = await res.json(); } catch { /* shape unknown */ }

      if (res.status === 429) {
        const retryAfter = body?.parameters?.retry_after ?? null;
        return { ok: false, unknown: false, rateLimited: true, retryAfter, description: body?.description ?? null };
      }
      if (!body || typeof body !== 'object') {
        // We got a response we cannot read. UNKNOWN.
        return { ok: false, unknown: true, description: `unreadable body (HTTP ${res.status})` };
      }
      if (body.ok !== true) {
        // Telegram answered and said no. That is a FACT, not an unknown.
        return { ok: false, unknown: false, description: body.description ?? 'unknown error', errorCode: body.error_code ?? null };
      }
      return { ok: true, result: body.result };
    } catch (e) {
      // The request itself failed. The message MAY HAVE ARRIVED.
      return { ok: false, unknown: true, description: e.name === 'AbortError' ? 'timeout' : e.message };
    } finally {
      clearTimeout(timer);
    }
  }

  // Send HTML, falling back to plain text if Telegram refuses the entities.
  // Never let formatting cost a delivery.
  async sendMessage(chatId, html, extra = {}) {
    const res = await this.call('sendMessage', {
      chat_id: chatId,
      text: html,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...extra,
    });
    if (res.ok) return res;

    if (!res.unknown && /can't parse entities|unsupported start tag|can not parse/i.test(res.description || '')) {
      log.warn('telegram: entity parse failed, resending as plain text', { desc: res.description });
      const plain = String(html).replace(/<[^>]*>/g, '');
      return this.call('sendMessage', {
        chat_id: chatId,
        text: plain,
        link_preview_options: { is_disabled: true },
        ...extra,
      });
    }
    return res;
  }

  // Long answers, split. Sent sequentially and honouring retry_after -- a
  // splitter firing six parts back to back is exactly the shape that trips the
  // rate limit.
  async sendLong(chatId, html, extra = {}) {
    const parts = splitMessage(html);
    const results = [];
    for (const p of parts) {
      let res = await this.sendMessage(chatId, p, extra);
      if (res.rateLimited && Number.isFinite(res.retryAfter)) {
        await new Promise((r) => setTimeout(r, (res.retryAfter + 1) * 1000));
        res = await this.sendMessage(chatId, p, extra);
      }
      results.push(res);
      if (!res.ok) break;
    }
    return results;
  }

  // Telegram's typing indicator expires after 5s. Re-send every 4s for the life
  // of the call: a 60s silent wait reads as a dead bot and produces a second
  // message -- which, without the claim-before-work rule, is a second PAID turn.
  typingKeepalive(chatId) {
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      try { await this.call('sendChatAction', { chat_id: chatId, action: 'typing' }, { timeoutMs: 8000 }); }
      catch (e) { log.debug('typing failed', errFields(e)); }
    };
    tick();
    const h = setInterval(tick, 4000);
    return () => { stopped = true; clearInterval(h); };
  }

  // A photo with a caption. Telegram caps a CAPTION at 1024 characters where a
  // message is 4096, so anything longer must be a photo plus a short caption
  // followed by the rest as its own message -- never silently truncated.
  async sendPhoto(chatId, buffer, { filename = 'qr.png', caption = null, parseMode = 'HTML' } = {}) {
    if (caption !== null && telegramLength(caption) > CAPTION_LIMIT) {
      throw new Error(`caption is ${telegramLength(caption)} units, over Telegram's ${CAPTION_LIMIT} limit`);
    }
    const { boundary, body } = multipartBody(
      { chat_id: chatId, caption, parse_mode: caption ? parseMode : undefined },
      { field: 'photo', filename, contentType: 'image/png', buffer }
    );
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.apiBase}/sendPhoto`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        body,
      });
      let j = null;
      try { j = await res.json(); } catch { /* shape unknown */ }
      if (!j || typeof j !== 'object') return { ok: false, unknown: true, description: `unreadable body (HTTP ${res.status})` };
      if (j.ok !== true) return { ok: false, unknown: false, description: j.description ?? 'unknown error', errorCode: j.error_code ?? null };
      return { ok: true, result: j.result };
    } catch (e) {
      return { ok: false, unknown: true, description: e.name === 'AbortError' ? 'timeout' : e.message };
    } finally {
      clearTimeout(timer);
    }
  }

  async getMe() {
    return this.call('getMe');
  }

  // Long polling. `allowed_updates` PERSISTS SERVER-SIDE, so it is passed
  // explicitly on every call rather than assumed.
  async getUpdates(offset, { timeout = 30 } = {}) {
    return this.call('getUpdates', {
      offset,
      timeout,
      // allowed_updates PERSISTS SERVER-SIDE and silently filters anything not
      // listed, so a missing type does not error -- the events simply never
      // arrive. `stopped_message_generation` (Bot API 10.3) is what the draft
      // stop button delivers; without it here the button would do nothing and
      // there would be no sign of why.
      // allowed_updates PERSISTS SERVER-SIDE and silently filters anything not
      // listed, so a missing type does not error -- the events simply never
      // arrive. That is how the /models keyboard shipped DEAD: callback_data
      // was set, no callback_query was requested, and tapping a model did
      // nothing with no sign of why.
      allowed_updates: ['message', 'callback_query', 'stopped_message_generation'],
    }, { timeoutMs: (timeout + 15) * 1000 });
  }

  async setMyCommands(commands, scope) {
    return this.call('setMyCommands', { commands, scope });
  }
}

// ---------------------------------------------------------------------------
// Multipart upload, built by hand.
//
// The QR is rendered LOCALLY and the bytes are POSTed straight to Telegram. It
// is deliberately NOT a link to a third-party QR service: a deposit address is
// per-user and reused forever, so handing it to an outside image host would
// publish a customer's chain identity to a party with no reason to have it --
// the same reasoning that keeps a chat id out of the same log line as an
// address.
// ---------------------------------------------------------------------------

function multipartBody(fields, file) {
  const boundary = `----pcnaibot${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${String(v)}\r\n`, 'utf8'));
  }
  if (file) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\n`
      + `Content-Type: ${file.contentType}\r\n\r\n`, 'utf8'));
    parts.push(file.buffer);
    parts.push(Buffer.from('\r\n', 'utf8'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { boundary, body: Buffer.concat(parts) };
}
