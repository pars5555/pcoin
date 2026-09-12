// The OonaCode gateway client.
//
// THE CENTRAL RULE: classify by BUCKET, act on the BUCKET, never on the raw
// code. There are three JSON error envelopes and a fourth shape that is not
// JSON at all:
//
//   /v1/*   {"type":"error","error":{"type":"authentication_error","message":...}}
//   /api/*  {"error":{"code":"unauthorized","message":...}}
//   Apache / Cloudflare -> HTML, or zero bytes
//
// Verified live and unauthenticated: POST /v1/messages with a garbage body and
// no content-type returns 415 BEFORE AUTH; POST /messages returns 405 with an
// EMPTY body and no content-type; dev.oonacode.oonak.ai/v1/models returns an
// Apache HTML 401; /healthz returns 200 with the SPA's HTML. Add Cloudflare
// 524/1020 HTML on the apex and that is five. json_decode('') is null, and a
// client that retries everything non-2xx HOT-LOOPS FOREVER on a 415 caused by
// its own missing content-type.
//
// THE UNKNOWN BUCKET IS THE IMPORTANT ONE. "The upstream provider failed. The
// turn is not billed." is a real, verbatim claim -- but it is a claim about the
// GATEWAY generating a 5xx. An HTML 502 from Apache while the container is
// still generating is a DIFFERENT EVENT WITH THE SAME STATUS CODE. That is
// CLAUDE.md 7.6 word for word: "a 404 usually means the response could not be
// delivered, not that the command failed -- it probably ran."

import { log, errFields } from './log.mjs';

export const Bucket = {
  PERMANENT: 'permanent',   // did not run -> RELEASE IN FULL, never retry
  BACKOFF: 'backoff',       // did not run, come back later -> RELEASE IN FULL
  NOT_BILLED: 'not_billed', // the gateway said so -> RELEASE IN FULL
  UNKNOWN: 'unknown',       // IT MAY HAVE RUN -> HOLD, age out. NEVER retry.
  OK: 'ok',
};

export class UpstreamError extends Error {
  constructor(bucket, message, extra = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.bucket = bucket;
    Object.assign(this, extra);
  }
}

// Classify a completed HTTP exchange.
//
// `decoded` is the parsed body ONLY IF the content-type was JSON and it parsed.
// Anything else arrives here as null, and null pushes a 5xx into UNKNOWN --
// which is the entire point.
export function classify(status, decoded, { hadJsonContentType = false } = {}) {
  if (status >= 200 && status < 300) return Bucket.OK;

  // PERMANENT: the request was rejected before anything ran.
  if ([400, 401, 402, 404, 405, 415].includes(status)) return Bucket.PERMANENT;

  // BACKOFF: did not run, come back later.
  if (status === 429 || status === 503) return Bucket.BACKOFF;

  if (status >= 500) {
    // NOT BILLED only when the GATEWAY itself answered in its own /v1/*
    // envelope. That is the difference between "the upstream provider failed"
    // and "Apache returned HTML while the container kept generating".
    if (hadJsonContentType && decoded && decoded.type === 'error'
        && decoded.error && typeof decoded.error.type === 'string') {
      return Bucket.NOT_BILLED;
    }
    return Bucket.UNKNOWN;
  }
  // Anything else unrecognised is UNKNOWN, never OK.
  return Bucket.UNKNOWN;
}

export class OonaCodeClient {
  #key;

  constructor(baseUrl, apiKey, {
    fetchImpl = fetch,
    // An IDLE timeout, NEVER a total timeout. The gateway cuts on SILENCE and
    // Apache's /v1 ProxyPass is timeout=660, also a silence timeout.
    // AbortSignal.timeout() is a TOTAL timeout and would kill healthy long
    // turns at an arbitrary point where the outcome is UNKNOWN and the
    // reservation must be held. 120s is deliberately well BELOW 660 so the
    // timeout we handle is OURS, with our own classification, rather than an
    // HTML 502 from Apache.
    idleTimeoutMs = 120000,
    connectTimeoutMs = 10000,
    maxConcurrent = 4,
  } = {}) {
    this.base = baseUrl.replace(/\/+$/, '');
    this.#key = apiKey;
    this.fetchImpl = fetchImpl;
    this.idleTimeoutMs = idleTimeoutMs;
    this.connectTimeoutMs = connectTimeoutMs;
    // OUR OWN concurrency cap, regardless of what the gateway permits. The
    // gateway shares a box with PCoin seed 4, checker.pc.am (the busiest PCN
    // rail, and the only host whose deposit-watch watches checker), its CRM,
    // explorer3 and electrum2. This limit protects the ESTATE, not our quota.
    this.maxConcurrent = maxConcurrent;
    this.inFlight = 0;
    this.queue = [];
    this.rateLimitRemaining = null;
    this.rateLimitReset = null;
  }

  #headers(extra = {}) {
    return {
      'x-api-key': this.#key,
      'content-type': 'application/json',
      accept: 'application/json',
      ...extra,
    };
  }

  async #acquire() {
    if (this.inFlight < this.maxConcurrent) { this.inFlight++; return; }
    await new Promise((resolve) => this.queue.push(resolve));
    this.inFlight++;
  }

  #release() {
    this.inFlight--;
    const next = this.queue.shift();
    if (next) next();
  }

  // Public wrappers so the streaming helper can share the SAME concurrency cap
  // as the non-streamed path. A stream that bypassed the semaphore would let a
  // handful of ten-minute answers pin the gateway -- and that gateway shares a
  // box with seed 4, checker.pc.am and the CRM.
  acquireSlot() { return this.#acquire(); }
  releaseSlot() { return this.#release(); }

  // A raw POST that returns the Response untouched, for callers that need the
  // body as a stream rather than as parsed JSON.
  async rawFetch(path, body, signal) {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method: 'POST',
      headers: this.#headers({ accept: 'text/event-stream' }),
      body: JSON.stringify(body),
      signal,
    });
    this.#readRateLimit(res);
    return res;
  }

  #readRateLimit(res) {
    const rem = Number(res.headers.get('x-ratelimit-remaining'));
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    if (Number.isFinite(rem)) this.rateLimitRemaining = rem;
    if (Number.isFinite(reset)) this.rateLimitReset = reset;
  }

  // Parse defensively. IF content-type IS NOT application/json, OR THE BODY
  // DOES NOT DECODE, THE OUTCOME IS `unreadable` -- a state of its own, never
  // an error type, never ''.
  async #parse(res) {
    const ct = res.headers.get('content-type') || '';
    const hadJson = ct.includes('application/json');
    if (!hadJson) {
      return { decoded: null, hadJsonContentType: false };
    }
    try {
      return { decoded: await res.json(), hadJsonContentType: true };
    } catch {
      return { decoded: null, hadJsonContentType: false };
    }
  }

  async health() {
    try {
      const res = await this.fetchImpl(`${this.base}/api/health`, {
        headers: this.#headers(),
        signal: AbortSignal.timeout(10000),
      });
      const { decoded, hadJsonContentType } = await this.#parse(res);
      if (!hadJsonContentType || !decoded) {
        // Gateway, Apache or the box. The "not billed" guarantee does NOT
        // apply in this case.
        return { up: false, reason: 'health endpoint did not return JSON', version: null };
      }
      return { up: decoded.ok === true, version: decoded.version ?? null, features: decoded.features ?? null };
    } catch (e) {
      return { up: false, reason: e.message, version: null };
    }
  }

  async models() {
    const res = await this.fetchImpl(`${this.base}/v1/models`, {
      headers: this.#headers(),
      signal: AbortSignal.timeout(20000),
    });
    this.#readRateLimit(res);
    const { decoded, hadJsonContentType } = await this.#parse(res);
    const bucket = classify(res.status, decoded, { hadJsonContentType });
    if (bucket !== Bucket.OK) {
      throw new UpstreamError(bucket, `GET /v1/models -> ${res.status}`, { status: res.status });
    }
    const ids = Array.isArray(decoded?.data) ? decoded.data.map((m) => m.id).filter((s) => typeof s === 'string') : [];
    return ids;
  }

  // count_tokens: documented as costing nothing and sending nothing upstream,
  // but the pool declares capabilities.countTokens:false, which contradicts
  // that. Q4 settles it; until then the caller falls back to the byte
  // estimator. Returns null when unavailable rather than throwing, because
  // "we could not count" is a normal state here, not a fault.
  async countTokens(body) {
    try {
      const res = await this.fetchImpl(`${this.base}/v1/messages/count_tokens`, {
        method: 'POST',
        headers: this.#headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
      this.#readRateLimit(res);
      const { decoded, hadJsonContentType } = await this.#parse(res);
      if (classify(res.status, decoded, { hadJsonContentType }) !== Bucket.OK) return null;
      const n = decoded?.input_tokens;
      return Number.isInteger(n) ? n : null;
    } catch {
      return null;
    }
  }

  // A non-streamed turn.
  //
  // NOTE ON RETRIES: there are none here, and the client library's own must be
  // off too (`anthropic` and @anthropic-ai/sdk both default to max_retries=2).
  // Combined with "release the reservation on 5xx", one user turn becomes up to
  // THREE upstream generations: we pay for each, the user pays for one, and
  // nothing in the response says a retry happened. Retries belong ABOVE the
  // reservation, where they can be counted and attributed -- and only for the
  // BACKOFF bucket.
  async messages(body) {
    await this.#acquire();
    const ctrl = new AbortController();
    let idleTimer;
    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => ctrl.abort(), this.idleTimeoutMs);
    };
    try {
      resetIdle();
      const res = await this.fetchImpl(`${this.base}/v1/messages`, {
        method: 'POST',
        headers: this.#headers(),
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      resetIdle();
      this.#readRateLimit(res);
      const { decoded, hadJsonContentType } = await this.#parse(res);
      const bucket = classify(res.status, decoded, { hadJsonContentType });

      if (bucket !== Bucket.OK) {
        const retryAfter = this.rateLimitReset;
        throw new UpstreamError(bucket, describeError(res.status, decoded, hadJsonContentType), {
          status: res.status,
          retryAfter,
        });
      }
      if (!decoded || typeof decoded !== 'object') {
        // 200 with a body we cannot read. It RAN. Hold.
        throw new UpstreamError(Bucket.UNKNOWN, 'HTTP 200 with an unreadable body', { status: res.status });
      }
      return decoded;
    } catch (e) {
      if (e instanceof UpstreamError) throw e;
      if (e.name === 'AbortError' || e.name === 'TimeoutError') {
        // A read timeout means IT MAY HAVE RUN. Hold, never release.
        throw new UpstreamError(Bucket.UNKNOWN, 'idle timeout waiting for the gateway', { timeout: true });
      }
      // A CONNECT-phase failure is safely "did not run".
      if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET during connect/i.test(e.message || '')) {
        throw new UpstreamError(Bucket.PERMANENT, `connect failed: ${e.message}`);
      }
      // Anything else mid-flight is UNKNOWN.
      throw new UpstreamError(Bucket.UNKNOWN, `request failed mid-flight: ${e.message}`);
    } finally {
      clearTimeout(idleTimer);
      this.#release();
    }
  }
}

function describeError(status, decoded, hadJson) {
  if (!hadJson || !decoded) return `HTTP ${status} with a non-JSON or empty body`;
  // Two envelopes, and neither field is assumed to exist.
  const t = decoded?.error?.type ?? decoded?.error?.code ?? null;
  const m = decoded?.error?.message ?? null;
  return `HTTP ${status}${t ? ` ${t}` : ''}${m ? `: ${String(m).slice(0, 200)}` : ''}`;
}

// THE CACHE ASSERTION.
//
// We send NO cache_control blocks, deliberately: the registry exposes two rates
// while the platform's own client schema carries four (inputCacheMiss,
// inputCacheHit, cacheWrite, output, each peak and off-peak), so with caching on
// the table we bill FROM is a lossy projection of the one we are billed BY, IN
// BOTH DIRECTIONS AT ONCE. Cache reads are typically ~0.1x input, so pricing
// cached tokens at the full input rate OVER-CHARGES THE USER roughly tenfold on
// the cached prefix of every turn; and a cache write billed above the input rate
// makes settle > reserved on the first turn of every conversation.
//
// So ASSERT IT, DON'T ASSUME IT. Non-zero means the gateway cached on its own
// initiative and we are billing blind.
export function assertNoCacheTokens(usage) {
  const read = usage?.cache_read_input_tokens ?? 0;
  const write = usage?.cache_creation_input_tokens ?? 0;
  if (read !== 0 || write !== 0) {
    return { clean: false, read, write };
  }
  return { clean: true, read: 0, write: 0 };
}

// A stream that ends without message_delta is NOT a complete answer, even if
// the text looks finished. Require stop_reason before treating a turn as
// delivered; never let "the connection closed cleanly" stand in for it -- that
// is exactly what AiClient.php does today.
export function usageFromResponse(resp) {
  const u = resp?.usage;
  if (!u || typeof u !== 'object') {
    return { readable: false, reason: 'no usage block' };
  }
  const inTok = u.input_tokens;
  const outTok = u.output_tokens;
  if (!Number.isInteger(inTok) || !Number.isInteger(outTok)) {
    // `?? 0` here is the bug that made webbuilderbot's turns FREE. Refuse.
    return { readable: false, reason: 'usage present but token counts are absent or non-integer' };
  }
  if (typeof resp.stop_reason !== 'string') {
    return { readable: false, reason: 'no stop_reason: the turn is not proven complete' };
  }
  return { readable: true, inputTokens: inTok, outputTokens: outTok, stopReason: resp.stop_reason };
}
