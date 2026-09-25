// The OonaCode agent API.
//
// WHAT IT CHANGES, measured 2026-09-13 against the live gateway:
//
//   * THE HISTORY LIVES THERE. Input tokens across three runs in one session:
//     2374 -> 2393 -> 2415. It grows by the new message, not by the whole
//     conversation, so we stop resending it.
//   * `AgentRun.credits` IS A REAL COST FIELD -- "what the pool charged this
//     run", with credits.perUsd = 1000. The /v1/messages API has no cost field
//     at all, which is why that path has to price tokens itself off an
//     undocumented registry. Here we settle from what we were actually charged.
//   * IT COSTS 20-50x MORE PER SHORT TURN. The agent carries its own system
//     prompt before the user's message: 2,374 to 13,260 input tokens for
//     "say ok", against 14 on the plain API. It varied 5x between sessions for
//     identical requests, unexplained.
//
// AND IT IS UNRELIABLE. `agent_sandbox_failed` hit 5 of ~11 runs. Worse, the
// first session created had its first run fail with `connect ECONNREFUSED` and
// then EVERY subsequent run into it failed forever -- a poisoned session never
// recovers, and only a fresh one works. That is why `failures` is counted per
// session and why the caller replaces a session rather than retrying into it.
//
// TWO SHAPES FOR THE SAME FAILURE. A run can fail as HTTP 200 with
// `status: "failed"`, or as an error envelope with `agent_sandbox_failed`. So:
// SWITCH ON `status`, NEVER ON THE HTTP CODE -- the same rule the wPCN verifier
// taught this estate.

import { log, errFields } from './log.mjs';
import { sseEvents } from './stream.mjs';

export const CREDITS_PER_USD = 1000;

// A failure that says nothing about whether the work can ever succeed. The
// caller backs off; it does not give up on the model or bill the user.
export class AgentUnavailable extends Error {
  constructor(message, { code = null, poisoned = false } = {}) {
    super(message);
    this.name = 'AgentUnavailable';
    this.code = code;
    // `poisoned` means THIS SESSION is the problem, not the service: replace it
    // rather than retry into it.
    this.poisoned = poisoned;
  }
}

// A failure that is about the request itself. Retrying identically will fail
// identically.
export class AgentRefused extends Error {
  constructor(message, { status = null, code = null } = {}) {
    super(message);
    this.name = 'AgentRefused';
    this.status = status;
    this.code = code;
  }
}

function codeOf(body) {
  const m = body?.error?.message ?? '';
  const m2 = /\(code:\s*([a-z_]+)\)/i.exec(m);
  return m2 ? m2[1] : (body?.error?.type ?? null);
}

// Encode a workspace path for a URL WITHOUT eating its separators --
// `encodeURIComponent` turns `output/logo.png` into `output%2Flogo.png`, which
// is a different, non-existent file.
function encodePath(path) {
  return String(path).split('/').filter((s) => s !== '').map(encodeURIComponent).join('/');
}

export class AgentClient {
  #key;

  constructor(baseUrl, apiKey, { fetchImpl = fetch, timeoutMs = 300000 } = {}) {
    this.base = baseUrl.replace(/\/+$/, '');
    this.#key = apiKey;
    this.fetchImpl = fetchImpl;
    // An agentic run does real work with tools; it is legitimately slow. This
    // is a total timeout only for the non-streamed calls, which are small.
    this.timeoutMs = timeoutMs;
  }

  #headers(extra = {}) {
    return { 'x-api-key': this.#key, 'content-type': 'application/json', accept: 'application/json', ...extra };
  }

  async #json(method, path, body = null, { timeoutMs = 60000 } = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers: this.#headers(),
        body: body === null ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (res.status === 204) return { ok: true, status: 204, json: null };
      const ct = res.headers.get('content-type') || '';
      let json = null;
      if (ct.includes('application/json')) { try { json = await res.json(); } catch { /* unreadable */ } }
      return { ok: res.ok, status: res.status, json };
    } finally {
      clearTimeout(t);
    }
  }

  // ---- sessions ----------------------------------------------------------

  async createSession({ model, title = null }) {
    const r = await this.#json('POST', '/v1/agent/sessions', { model, title });
    if (r.status === 403) throw new AgentRefused('this key is not an agent key', { status: 403, code: codeOf(r.json) });
    if (!r.ok || !r.json?.id) throw new AgentUnavailable(`could not create a session (HTTP ${r.status})`, { code: codeOf(r.json) });
    return r.json;
  }

  async getSession(id) {
    const r = await this.#json('GET', `/v1/agent/sessions/${encodeURIComponent(id)}`);
    if (r.status === 404) return null;
    if (!r.ok) throw new AgentUnavailable(`could not read the session (HTTP ${r.status})`);
    return r.json;
  }

  async listSessions() {
    const r = await this.#json('GET', '/v1/agent/sessions');
    if (!r.ok) throw new AgentUnavailable(`could not list sessions (HTTP ${r.status})`);
    return Array.isArray(r.json?.sessions) ? r.json.sessions : [];
  }

  // Returns true when the session is gone -- INCLUDING a 404, because "it is
  // not there" is the outcome we wanted. Anything else is a failure to clean
  // up and must be retried later, or we leave a sandbox on their server.
  async deleteSession(id) {
    const r = await this.#json('DELETE', `/v1/agent/sessions/${encodeURIComponent(id)}`, null, { timeoutMs: 60000 });
    if (r.status === 204 || r.status === 404) return true;
    log.warn('agent session delete did not confirm', { status: r.status });
    return false;
  }

  // What happened to our sessions while nobody was talking to them (OonaCode, 2026-09-25): a
  // workspace deleted after an idle hour, a session expired after an idle day. Oldest first;
  // `after` is the id of the last event already handled. `nextAfter` is set only when the page
  // came back full, so it is a "read on" signal, not the cursor -- the cursor is the last event
  // actually handled.
  async listEvents({ after = null, limit = 100 } = {}) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (after) q.set('after', after);
    const r = await this.#json('GET', `/v1/agent/events?${q}`);
    if (!r.ok) throw new AgentUnavailable(`could not read agent events (HTTP ${r.status})`);
    return {
      events: Array.isArray(r.json?.events) ? r.json.events : [],
      nextAfter: typeof r.json?.next_after === 'string' ? r.json.next_after : null,
    };
  }

  async interrupt(id) {
    try {
      const r = await this.#json('POST', `/v1/agent/sessions/${encodeURIComponent(id)}/interrupt`, {});
      return r.json?.interrupted === true;
    } catch (e) {
      log.debug('interrupt failed', errFields(e));
      return false;
    }
  }

  // Upload a file into a session's workspace, then tell the agent the path in
  // the message. This is the ONLY way to give an agent an image:
  // AgentRunRequest.message is a plain STRING -- no content blocks, no
  // attachment field -- unlike /v1/messages, which takes Anthropic image
  // blocks. Verified working: an uploaded PNG was described correctly.
  async uploadFile(sessionId, path, buffer, contentType = 'application/octet-stream') {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 120000);
    try {
      const res = await this.fetchImpl(
        `${this.base}/v1/agent/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(path)}`,
        { method: 'PUT', headers: { 'x-api-key': this.#key, 'content-type': contentType }, body: buffer, signal: ctrl.signal }
      );
      if (!res.ok) return { ok: false, status: res.status };
      let j = null;
      try { j = await res.json(); } catch { /* a 200 with no body is still a store */ }
      return { ok: true, path: j?.path ?? path, size: j?.size ?? buffer.length };
    } catch (e) {
      return { ok: false, reason: e.message };
    } finally {
      clearTimeout(t);
    }
  }

  // The workspace listing. ONE DIRECTORY -- this is not a walk, and their docs
  // say so; `node_modules` comes back as a single `dir` entry, not 4,000 files.
  //
  // The SAME route serves a listing for a directory and BYTES for a file, so
  // the two are told apart by what comes back, never by the path.
  async listFiles(sessionId, path = '') {
    const suffix = path ? `/${encodePath(path)}` : '';
    const r = await this.#json('GET', `/v1/agent/sessions/${encodeURIComponent(sessionId)}/files${suffix}`);
    // A session with no sandbox yet has no workspace. That is genuinely empty,
    // not a failure -- nothing has run, so nothing can have been produced.
    if (r.status === 404) return { path, entries: [] };
    if (!r.ok) throw new AgentUnavailable(`could not list the workspace (HTTP ${r.status})`);
    return { path: r.json?.path ?? path, entries: Array.isArray(r.json?.entries) ? r.json.entries : [] };
  }

  // Fetch one file's bytes. Returns a Buffer, or null when it is not there.
  //
  // Capped because the caller is about to push this through Telegram, which
  // takes at most 50 MB from a bot; their API allows 32 MB, so neither limit
  // can be assumed to be the binding one.
  async downloadFile(sessionId, path, { maxBytes = 50 * 1024 * 1024 } = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 120000);
    try {
      const res = await this.fetchImpl(
        `${this.base}/v1/agent/sessions/${encodeURIComponent(sessionId)}/files/${encodePath(path)}`,
        { method: 'GET', headers: { 'x-api-key': this.#key }, signal: ctrl.signal }
      );
      if (res.status === 404) return null;
      if (!res.ok) throw new AgentUnavailable(`could not read ${path} (HTTP ${res.status})`);
      // A directory answers on this route too, as JSON. Asking for one as a
      // file is a caller bug, and handing back a listing as though it were
      // file content would send the user a page of JSON.
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('application/json')) return null;
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > maxBytes) {
        throw new AgentUnavailable(`${path} is ${declared} bytes, over the ${maxBytes} limit`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes) throw new AgentUnavailable(`${path} is ${buf.length} bytes, over the limit`);
      return buf;
    } finally {
      clearTimeout(t);
    }
  }

  // ---- runs --------------------------------------------------------------

  // Classify a non-2xx or a failed run into "try again" vs "this request is
  // wrong". The distinction decides whether the user is told to wait or told
  // something is broken, and whether we hold or release their money.
  #classify(status, body) {
    const code = codeOf(body);
    const msg = body?.error?.message ?? `HTTP ${status}`;

    if (status === 403) throw new AgentRefused(msg, { status, code });
    if (status === 400) throw new AgentRefused(msg, { status, code });
    if (status === 401) throw new AgentRefused(msg, { status, code });
    if (status === 402) throw new AgentRefused(msg, { status, code });
    if (status === 404) throw new AgentUnavailable(msg, { code, poisoned: true }); // session gone: make a new one
    if (status === 409) throw new AgentUnavailable(msg, { code });                  // busy: one run at a time
    if (status === 429) throw new AgentUnavailable(msg, { code });
    if (status === 503) throw new AgentUnavailable(msg, { code });
    throw new AgentUnavailable(msg, { code });
  }

  // Stream a run. Yields the same shape as the plain-messages stream where it
  // can, so the caller's draft logic is shared:
  //   { type: 'text',  delta }
  //   { type: 'tool',  name, phase: 'started'|'finished', ok, summary }
  //   { type: 'run',   run }        the finished AgentRun
  //   { type: 'end',   ok, aborted }
  async *streamRun({ sessionId = null, message, model = null, maxTurns = null, title = null, system = null, effort = null }, { abortSignal = null, idleTimeoutMs = 180000 } = {}) {
    const path = sessionId
      ? `/v1/agent/sessions/${encodeURIComponent(sessionId)}/runs`
      : '/v1/agent/runs';
    const body = { message, stream: true };
    if (model) body.model = model;
    if (Number.isInteger(maxTurns)) body.max_turns = maxTurns;
    if (title) body.title = title;
    // Standing instructions (OonaCode's `system`, 2026-09-25): appended to the agent's own system
    // prompt and kept on the session, instead of pasted into every message the user sends.
    if (typeof system === 'string') body.system = system;
    if (typeof effort === 'string' && effort) body.effort = effort;

    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    if (abortSignal) {
      if (abortSignal.aborted) ctrl.abort();
      else abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    let idle = null;
    const resetIdle = () => {
      clearTimeout(idle);
      // An agent can legitimately sit silent while a tool runs, so this is far
      // longer than the chat path's. It is still an IDLE timeout, reset on
      // every frame -- a total timeout would kill a long, healthy run.
      idle = setTimeout(() => ctrl.abort(), idleTimeoutMs);
    };

    let run = null;
    let sawEnd = false;
    try {
      resetIdle();
      const res = await this.fetchImpl(`${this.base}${path}`, {
        method: 'POST',
        headers: this.#headers({ accept: 'text/event-stream' }),
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      resetIdle();

      if (!res.ok) {
        const ct = res.headers.get('content-type') || '';
        let j = null;
        if (ct.includes('application/json')) { try { j = await res.json(); } catch { /* unreadable */ } }
        this.#classify(res.status, j);
      }
      if (!res.body) throw new AgentUnavailable('the run returned 200 with no body');

      const reader = res.body.getReader();
      const dec = new TextDecoder();

      for await (const frame of sseEvents(reader, dec, resetIdle)) {
        const type = frame.event ?? frame.data?.type ?? null;
        const d = frame.data ?? {};
        switch (type) {
          case 'run.started':
            if (d.run?.session_id) yield { type: 'session', sessionId: d.run.session_id };
            else if (d.session_id) yield { type: 'session', sessionId: d.session_id };
            break;
          case 'text.delta':
            if (typeof d.text === 'string' && d.text !== '') yield { type: 'text', delta: d.text };
            break;
          case 'thinking.delta':
            // Deliberately not shown. The user asked a question, not to read
            // the model's notes -- and it would dominate the preview.
            break;
          case 'tool.started':
            yield { type: 'tool', phase: 'started', name: d.name ?? 'tool', toolId: d.tool_id ?? null };
            break;
          case 'tool.finished':
            yield { type: 'tool', phase: 'finished', name: d.name ?? 'tool', ok: d.ok !== false, summary: d.summary ?? null, toolId: d.tool_id ?? null };
            break;
          case 'run.completed':
            run = d.run ?? d;
            sawEnd = true;
            break;
          case 'run.failed':
            run = d.run ?? d;
            sawEnd = true;
            break;
          default:
            break;
        }
      }

      if (run) yield { type: 'run', run };
      yield { type: 'end', ok: sawEnd, aborted: false };
    } catch (e) {
      if (e instanceof AgentRefused || e instanceof AgentUnavailable) throw e;
      if (ctrl.signal.aborted) { yield { type: 'end', ok: false, aborted: true }; return; }
      throw new AgentUnavailable(`the run stream failed: ${e.message}`);
    } finally {
      clearTimeout(idle);
      if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
    }
  }

  // Poll a run after a dropped stream. Their own docs: "a dropped stream never
  // stops a run" -- so a lost connection is NOT a lost answer, and must not be
  // billed as an unknown when it can simply be read back.
  async getRun(sessionId, runId) {
    const r = await this.#json('GET', `/v1/agent/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}`);
    if (r.status === 404) return null;
    if (!r.ok) throw new AgentUnavailable(`could not read the run (HTTP ${r.status})`);
    return r.json;
  }
}

// credits -> micro-USD, with the house margin, in integers.
//
// `credits` arrives as a JSON number (2.674), so it is taken through a decimal
// STRING rather than float arithmetic -- the same rule as every other money
// path here.
export function creditsToMicroUsd(credits, marginE6, parseScaled) {
  if (!Number.isFinite(Number(credits)) || Number(credits) < 0) {
    throw new Error(`agent run reported an unusable credits value: ${JSON.stringify(credits)}`);
  }
  // credits / 1000 = USD; USD * 1e6 = micro. So micro = credits * 1000.
  // credits_e6 * margin_e6 / 1e6 / 1e6 * 1e3 ... done in integers:
  const creditsE6 = parseScaled(Number(credits).toFixed(6), 6);   // credits x 1e6
  // micro_usd = credits * 1000 * margin
  const num = creditsE6 * BigInt(1000) * BigInt(marginE6);
  const den = BigInt(1000000) * BigInt(1000000); // undo both 1e6 scalings
  const q = num / den;
  return num % den === BigInt(0) ? q : q + BigInt(1); // ceil
}

// A run's outcome, normalised. SWITCH ON `status`, NEVER ON THE HTTP CODE.
export function runOutcome(run) {
  if (!run || typeof run !== 'object') return { readable: false, reason: 'no run object' };
  const status = run.status;
  if (typeof status !== 'string') return { readable: false, reason: 'run has no status' };
  return {
    readable: true,
    status,
    ok: status === 'completed',
    failed: status === 'failed',
    cancelled: status === 'cancelled',
    running: status === 'running',
    stopReason: typeof run.stop_reason === 'string' ? run.stop_reason : null,
    text: typeof run.text === 'string' ? run.text : '',
    credits: Number.isFinite(Number(run.credits)) ? Number(run.credits) : null,
    modelRequests: Number.isInteger(run.model_requests) ? run.model_requests : null,
    sessionId: typeof run.session_id === 'string' ? run.session_id : null,
    runId: typeof run.id === 'string' ? run.id : null,
    durationMs: Number.isFinite(Number(run.duration_ms)) ? Number(run.duration_ms) : null,
    error: run.error ?? null,
  };
}

// The line under an answer that ended early, or null. Every bound here COMPLETES the run with its
// partial answer and keeps its sandbox, so the user's next message continues in the same chat.
//
// The deadline says how long the run took rather than naming a number: the limit is an OonaCode
// admin setting (600 s until 2026-09-25, 1800 s since), and a figure written here would be the
// first thing to go stale.
export function stopNote(out, { maxTurns } = {}) {
  if (out.cancelled) return 'stopped';
  if (out.stopReason === 'max_turns') return `stopped at the ${maxTurns}-step limit — say "continue" to let it go on`;
  if (out.stopReason === 'deadline') {
    const min = Number.isFinite(out.durationMs) && out.durationMs >= 60000 ? Math.round(out.durationMs / 60000) : null;
    return `${min ? `stopped after ${min} minutes, the time limit for one task` : 'stopped at the time limit for one task'}`
      + ' — say "continue" and it picks up where it stopped, in the same chat';
  }
  if (out.stopReason === 'budget') return 'stopped: the run reached its spending limit';
  return null;
}
