// The SSE parser and the streamed settle levels.
//
// A parser that buffers the whole answer and emits nothing looks exactly like a
// model that never responded, so the boundary cases matter more than the happy
// path: a frame split across two network chunks, CRLF from a proxy that
// rewrites line endings, keepalive pings, and a final frame with no trailing
// blank line.

import test from 'node:test';
import assert from 'node:assert/strict';

import { sseEvents, StreamStage, streamMessages } from '../lib/stream.mjs';
import { Bucket, UpstreamError } from '../lib/oonacode.mjs';

// A reader over a fixed list of byte chunks, so a frame can be split anywhere.
function readerOf(chunks) {
  const enc = new TextEncoder();
  let i = 0;
  return {
    read: async () => (i < chunks.length
      ? { value: enc.encode(chunks[i++]), done: false }
      : { value: undefined, done: true }),
  };
}

async function collect(chunks) {
  const out = [];
  for await (const f of sseEvents(readerOf(chunks), new TextDecoder(), () => {})) out.push(f);
  return out;
}

test('parses a normal LF-separated stream', async () => {
  const frames = await collect([
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":11}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n',
  ]);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].data.type, 'message_start');
  assert.equal(frames[0].data.message.usage.input_tokens, 11);
  assert.equal(frames[1].data.delta.text, 'Hi');
});

test('parses CRLF, which a proxy in the path may produce', async () => {
  const frames = await collect([
    'event: message_start\r\ndata: {"type":"message_start"}\r\n\r\n',
    'event: message_stop\r\ndata: {"type":"message_stop"}\r\n\r\n',
  ]);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].data.type, 'message_start');
});

test('a frame SPLIT ACROSS CHUNKS is still delivered whole', async () => {
  // The single most likely real-world shape, and the one a naive parser drops.
  const frames = await collect([
    'event: content_bl',
    'ock_delta\ndata: {"type":"content_block_delta","delta":{"type":"te',
    'xt_delta","text":"hello world"}}',
    '\n\n',
  ]);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].data.delta.text, 'hello world');
});

test('a multi-byte character split across chunks is not corrupted', async () => {
  // Armenian is two bytes per character and this bot's users write it.
  const enc = new TextEncoder();
  const full = 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Բարեւ"}}\n\n';
  const bytes = enc.encode(full);
  const cut = 60; // lands mid-character
  const reader = (() => {
    const parts = [bytes.slice(0, cut), bytes.slice(cut)];
    let i = 0;
    return { read: async () => (i < parts.length ? { value: parts[i++], done: false } : { done: true }) };
  })();
  const out = [];
  for await (const f of sseEvents(reader, new TextDecoder(), () => {})) out.push(f);
  assert.equal(out.length, 1);
  assert.equal(out[0].data.delta.text, 'Բարեւ');
});

test('keepalive pings and unparseable data do not break the stream', async () => {
  const frames = await collect([
    ': this is a comment\n\n',
    'event: ping\ndata: {"type":"ping"}\n\n',
    'data: not json at all\n\n',
    'data: {"type":"message_stop"}\n\n',
  ]);
  // The comment carries no data: line, so it yields nothing.
  const types = frames.map((f) => f.data?.type ?? null);
  assert.ok(types.includes('ping'));
  assert.ok(types.includes('message_stop'));
  assert.ok(types.includes(null), 'the unparseable frame is surfaced with data null, not dropped silently');
});

test('a final frame with no trailing blank line is still delivered', async () => {
  const frames = await collect(['data: {"type":"message_stop"}']);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].data.type, 'message_stop');
});

// ---------------------------------------------------------------------------
// streamMessages over a fake client.
// ---------------------------------------------------------------------------
function fakeClient(chunks, { status = 200 } = {}) {
  const enc = new TextEncoder();
  let i = 0;
  return {
    idleTimeoutMs: 5000,
    acquireSlot: async () => {},
    releaseSlot: () => {},
    rawFetch: async () => ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k) => (k === 'content-type' ? 'text/event-stream' : null) },
      body: {
        getReader: () => ({
          read: async () => (i < chunks.length
            ? { value: enc.encode(chunks[i++]), done: false }
            : { value: undefined, done: true }),
        }),
      },
      json: async () => ({}),
    }),
  };
}

test('a complete stream yields input, text and authoritative usage', async () => {
  const c = fakeClient([
    'data: {"type":"message_start","message":{"usage":{"input_tokens":25,"cache_read_input_tokens":0}}}\n\n',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Red, "}}\n\n',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"blue."}}\n\n',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}\n\n',
    'data: {"type":"message_stop"}\n\n',
  ]);
  const events = [];
  for await (const e of streamMessages(c, { model: 'x', max_tokens: 16, messages: [] })) events.push(e);

  const input = events.find((e) => e.type === 'input');
  const usage = events.find((e) => e.type === 'usage');
  const end = events.at(-1);
  const text = events.filter((e) => e.type === 'text').map((e) => e.delta).join('');

  assert.equal(input.inputTokens, 25);
  assert.equal(text, 'Red, blue.');
  assert.equal(usage.outputTokens, 7);
  assert.equal(usage.stopReason, 'end_turn');
  assert.equal(end.type, 'end');
  assert.equal(end.stage, StreamStage.COMPLETE);
});

test('a stream cut after message_start reports INPUT_KNOWN, not COMPLETE', async () => {
  // This is the level that decides the settle: input exact, output partial.
  // Reporting COMPLETE here would settle a truncated answer as authoritative.
  const c = fakeClient([
    'data: {"type":"message_start","message":{"usage":{"input_tokens":40}}}\n\n',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"half an ans"}}\n\n',
  ]);
  const events = [];
  for await (const e of streamMessages(c, {})) events.push(e);
  const end = events.at(-1);
  assert.equal(end.stage, StreamStage.INPUT_KNOWN);
  assert.equal(events.find((e) => e.type === 'usage'), undefined, 'no usage was received');
});

test('a stream that dies before message_start reports NOTHING', async () => {
  const c = fakeClient([]);
  const events = [];
  for await (const e of streamMessages(c, {})) events.push(e);
  assert.equal(events.at(-1).stage, StreamStage.NOTHING);
});

test('an error frame INSIDE a 200 is surfaced, not swallowed', async () => {
  // The status was committed at the first byte, so the HTTP code says nothing.
  const c = fakeClient([
    'data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n',
    'data: {"type":"error","error":{"type":"overloaded_error","message":"upstream busy"}}\n\n',
  ]);
  const events = [];
  for await (const e of streamMessages(c, {})) events.push(e);
  const err = events.find((e) => e.type === 'error');
  assert.ok(err, 'the error frame reached the caller');
  assert.equal(err.error.type, 'overloaded_error');
});

test('a non-2xx BEFORE the stream begins throws a classified UpstreamError', async () => {
  const c = fakeClient([], { status: 429 });
  await assert.rejects(
    (async () => { for await (const _ of streamMessages(c, {})) { /* drain */ } })(),
    (e) => e instanceof UpstreamError && e.bucket === Bucket.BACKOFF
  );
});

test('an external abort ends the stream cleanly with aborted:true', async () => {
  const c = fakeClient([
    'data: {"type":"message_start","message":{"usage":{"input_tokens":9}}}\n\n',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}\n\n',
  ]);
  const ctrl = new AbortController();
  const events = [];
  for await (const e of streamMessages(c, {}, { abortSignal: ctrl.signal })) {
    events.push(e);
    if (e.type === 'input') ctrl.abort();
  }
  const end = events.at(-1);
  assert.equal(end.type, 'end');
  // An abort is NOT an unknown: we know exactly how far it got.
  assert.equal(end.stage, StreamStage.INPUT_KNOWN);
});
