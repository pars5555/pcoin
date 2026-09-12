// Streaming a turn, and the SSE parsing under it.
//
// STREAMING WAS MEANT TO CARRY AN EARLY-ABORT GUARD, AND ON THIS GATEWAY IT
// CANNOT. On Anthropic's own API `message_start` carries the EXACT input_tokens
// before a single output token exists, which is the only mechanism that STOPS a
// mid-answer overrun rather than discovering it on the bill. Measured here on
// 2026-09-11, this gateway sends `input_tokens: 0` in `message_start` and the
// real figure only in `message_delta` -- so the guard is INERT, and the code
// below reports a non-positive count as null and says so out loud rather than
// leaving a dead check that looks live.
//
// What streaming still buys, which is not nothing: the user sees the answer as
// it is written, a ten-minute turn stops looking like a hung bot, and a
// truncated answer becomes recoverable at a known stage instead of being one
// undifferentiated failure.
//
// A STREAM THAT ENDS WITHOUT `message_delta` IS NOT A COMPLETE ANSWER, even if
// the text looks finished. `stop_reason` is what proves delivery; "the
// connection closed cleanly" is not a substitute, and treating it as one is
// exactly what AiClient.php does today.
//
// And note: "charge nothing on 5xx" CANNOT apply to a stream that already
// returned HTTP 200 and then died. A stream carries its errors INSIDE the 200,
// and the status code is committed at the first byte.
//
// The timeout is an IDLE timeout reset on every chunk, so a ten-minute answer
// is fine as long as tokens keep arriving. A total timeout would kill a healthy
// long turn at an arbitrary point where the outcome is UNKNOWN.

import { Bucket, UpstreamError, classify } from './oonacode.mjs';

// How far a stream got. This is what decides how a broken one settles.
export const StreamStage = {
  // Died before message_start: nothing was generated, most likely -- but
  // "most likely" is not "certainly", so this is still UNKNOWN and is HELD.
  NOTHING: 'nothing',
  // After message_start: the model definitely began. Input MAY be known
  // exactly (Anthropic) or not at all (this gateway sends 0), so the caller
  // falls back to the quoted figure rather than billing the input as zero.
  INPUT_KNOWN: 'input_known',
  // message_delta seen: usage is complete and authoritative.
  COMPLETE: 'complete',
};

// Split an SSE byte stream into frames.
//
// Frames are separated by a BLANK LINE, and CRLF is tolerated throughout
// because a proxy in the path may rewrite line endings -- a parser that only
// understood LF would buffer the entire answer and emit nothing, which looks
// exactly like a model that never responded.
export async function* sseEvents(reader, decoder, resetIdle) {
  const SEP = /\r?\n\r?\n/;
  let buf = '';

  function* drain() {
    for (;;) {
      const m = SEP.exec(buf);
      if (!m) return;
      const raw = buf.slice(0, m.index);
      buf = buf.slice(m.index + m[0].length);

      let event = null;
      const dataLines = [];
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length === 0) continue;

      const text = dataLines.join('\n');
      let json = null;
      try { json = JSON.parse(text); } catch { /* a keepalive, or a shape we do not know */ }
      yield { event: event ?? json?.type ?? null, data: json, raw: text };
    }
  }

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    resetIdle();
    buf += decoder.decode(value, { stream: true });
    yield* drain();
  }

  buf += decoder.decode();
  // A final frame with no trailing blank line still has to be delivered.
  if (buf.trim() !== '') {
    buf += '\n\n';
    yield* drain();
  }
}

// Stream a turn.
//
// Yields, in order:
//   { type: 'input', inputTokens, cacheRead, cacheCreation }  exact, pre-output
//   { type: 'text',  delta }                                  answer text
//   { type: 'usage', inputTokens, outputTokens, stopReason }   authoritative
//   { type: 'error', error }                                   an error INSIDE the 200
//   { type: 'end',   stage, aborted }                          always last
//
// `abortSignal` lets the caller stop mid-answer. Both the input-overrun guard
// and the user's own stop button use it, and an abort is NOT an unknown -- we
// know exactly how far it got, which is why `end` carries the stage.
export async function* streamMessages(client, body, { abortSignal = null } = {}) {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (abortSignal) {
    if (abortSignal.aborted) ctrl.abort();
    else abortSignal.addEventListener('abort', onAbort, { once: true });
  }

  let idleTimer = null;
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => ctrl.abort(), client.idleTimeoutMs);
  };

  let stage = StreamStage.NOTHING;

  await client.acquireSlot();
  try {
    resetIdle();
    const res = await client.rawFetch('/v1/messages', { ...body, stream: true }, ctrl.signal);
    resetIdle();

    if (!res.ok) {
      // This failed BEFORE the stream began, so the ordinary classification
      // applies and the reservation can be released rather than held.
      const ct = res.headers.get('content-type') || '';
      const hadJson = ct.includes('application/json');
      let decoded = null;
      if (hadJson) { try { decoded = await res.json(); } catch { /* unreadable */ } }
      throw new UpstreamError(
        classify(res.status, decoded, { hadJsonContentType: hadJson }),
        `stream refused: HTTP ${res.status}`,
        { status: res.status }
      );
    }

    if (!res.body) {
      throw new UpstreamError(Bucket.UNKNOWN, 'stream returned 200 with no body');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    for await (const frame of sseEvents(reader, decoder, resetIdle)) {
      const d = frame.data;
      if (!d || typeof d !== 'object') continue;

      switch (d.type) {
        case 'message_start': {
          const u = d.message?.usage ?? {};
          stage = StreamStage.INPUT_KNOWN;
          // MEASURED 2026-09-11 on this gateway: message_start reports
          // input_tokens: 0, and the real figure (24, in that test) arrives
          // only in message_delta. Anthropic's own API puts the exact count
          // here, which is what the early-abort guard was designed around --
          // on THIS gateway that guard cannot fire.
          //
          // So a non-positive count is reported as NULL, not as zero. Zero
          // would make the overrun check compare against nothing and pass
          // every time, and would make a truncated settle bill a long prompt
          // as if it had been empty. A check that cannot fire is
          // indistinguishable from a check that passes; this makes the
          // difference visible to the caller instead.
          const rawIn = u.input_tokens;
          yield {
            type: 'input',
            inputTokens: Number.isInteger(rawIn) && rawIn > 0 ? rawIn : null,
            cacheRead: u.cache_read_input_tokens ?? 0,
            cacheCreation: u.cache_creation_input_tokens ?? 0,
          };
          break;
        }
        case 'content_block_delta': {
          const t = d.delta?.text;
          if (typeof t === 'string' && t !== '') yield { type: 'text', delta: t };
          break;
        }
        case 'message_delta': {
          stage = StreamStage.COMPLETE;
          yield {
            type: 'usage',
            outputTokens: Number.isInteger(d.usage?.output_tokens) ? d.usage.output_tokens : null,
            inputTokens: Number.isInteger(d.usage?.input_tokens) ? d.usage.input_tokens : null,
            stopReason: typeof d.delta?.stop_reason === 'string' ? d.delta.stop_reason : null,
          };
          break;
        }
        case 'error': {
          // An error carried INSIDE a 200. The status code said nothing about
          // it, because the status was committed at the first byte.
          yield { type: 'error', error: d.error ?? null };
          break;
        }
        default:
          break; // ping, content_block_start/stop, message_stop
      }
    }

    yield { type: 'end', stage, aborted: false };
  } catch (e) {
    if (e instanceof UpstreamError) throw e;
    if (ctrl.signal.aborted) {
      // WE stopped it -- the input overran the reservation, the user pressed
      // stop, or the idle watchdog fired. Not an unknown: the stage says
      // exactly how far it got.
      yield { type: 'end', stage, aborted: true };
      return;
    }
    throw new UpstreamError(Bucket.UNKNOWN, `stream failed: ${e.message}`, { stage });
  } finally {
    clearTimeout(idleTimer);
    if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
    client.releaseSlot();
  }
}
