#!/usr/bin/env node
// The public API: an Anthropic-compatible proxy in front of OonaCode, billed to
// the caller's PCN-funded balance.
//
// A THIRD PROCESS, deliberately. It is the only PUBLIC NETWORK SURFACE this
// rail has, so it gets its own memory limit, its own restart behaviour and its
// own blast radius. The Telegram bot staying up must not depend on it, and a
// flood here must not OOM the credit path.
//
// It BINDS TO LOOPBACK ONLY and is fronted by the host's existing Caddy, which
// already terminates TLS. That needs no ufw change.
//
// THE BILLING PATH IS THE SAME ONE THE BOT USES -- the same reserve, the same
// settle, the same no-clamp rule, the same ledger. A turn costs the same
// whether it arrived from Telegram or from curl, and both land in one ledger
// that the reconciliation invariant closes over. Writing a second billing path
// here would be the "one mistake, copied" shape this whole project is written
// against.

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

import { loadConfig } from './lib/config.mjs';
import { log, errFields, installCrashHandlers, chatTag } from './lib/log.mjs';
import { openDb, assertSchema, pendingMigrations } from './lib/db.mjs';
import { nowSec } from './lib/time.mjs';
import { parseScaled, microUsdToString, tokensToMicroUsd } from './lib/money.mjs';
import { billableSet, priceTableAge, minMaxTokensFor, parseMirrors, modelsToFetch, chargePriceFor } from './lib/registry.mjs';
import { OonaCodeClient, Bucket, UpstreamError, usageFromResponse, assertNoCacheTokens } from './lib/oonacode.mjs';
import {
  reserve, settle, release, hold, acquireUserLock,
  takeFreeTurn, quoteTurn, InsufficientFunds, Busy,
} from './lib/billing.mjs';
import { resolveKey, touchKey, RateBucket } from './lib/apikeys.mjs';
import { estimateRequestTokens } from './lib/tokens.mjs';

const cfg = loadConfig();
installCrashHandlers();

const db = openDb(cfg.str('DB_PATH'));
if (pendingMigrations(db).length) {
  log.error('refusing to start: pending migrations');
  process.exit(1);
}
assertSchema(db);

const oona = new OonaCodeClient(
  cfg.strOr('OONACODE_BASE', 'https://api.oonacode.oonak.ai'),
  cfg.str('OONACODE_KEY'),
  {
    idleTimeoutMs: cfg.int('UPSTREAM_IDLE_TIMEOUT_MS', 120000),
    maxConcurrent: cfg.int('MAX_CONCURRENT_UPSTREAM', 4),
  }
);

const MARGIN_E6 = parseScaled(String(cfg.num('MARGIN', 3.0)), 6);
const ALLOWLIST_MODELS = cfg.list('MODEL_ALLOWLIST');
const REGISTRY_MAX_AGE = cfg.int('REGISTRY_MAX_AGE_SECONDS', 21600);

// What a CUSTOMER pays, which is a different question from what a model costs
// us. See lib/registry.mjs: mirrors bill a zero-cost model at a named
// sibling's LIVE price, and FREE_TO_USER is an allow-list so a model is
// billable unless it is explicitly named free.
const PRICE_MIRRORS = parseMirrors(cfg.strOr('PRICE_MIRROR', ''));
const FREE_TO_USER = new Set(cfg.list('FREE_TO_USER'));
const HOUSE_INPUT_CAP = cfg.int('HOUSE_INPUT_TOKEN_CAP', 16000);
const FREE_PER_HOUR = cfg.int('FREE_TURNS_PER_HOUR', 10);
const PORT = cfg.int('API_PORT', 8799);
const HOST = cfg.strOr('API_BIND', '127.0.0.1');
const MAX_BODY = cfg.int('API_MAX_BODY_BYTES', 1048576); // 1 MiB
const ALLOW_OVERDRAFT = cfg.bool('ALLOW_OVERDRAFT', false);
// Six of the ten sellable models declare no output limit. Probed 2026-09-11:
// all ten accept 32000. A 4096 fallback here would reject a legitimate request
// for a long answer with a limit the model does not actually have.
const UNDECLARED_OUTPUT_CAP = cfg.int('UNDECLARED_OUTPUT_CAP', 32000);

// MEASURED 2026-09-11: count_tokens UNDER-COUNTS the input the model actually
// bills. Same body, same model:
//     glm-5.3-flash   count=14  actual=19   (+5, a constant framing overhead)
//     glm-5.3-flash   count=8   actual=13   (+5 again)
//     mimo-v2.5:free  count=14  actual=62   (+48, 77% of the real figure)
//     gpt-5-mini      count=14  actual=13   (count >= actual, fine)
//
// So counting is BETTER than estimating but is NOT a ceiling, and the
// reservation must be one -- "a quote is never lower than the bill" is what
// stops a settle overrunning, and an overrun is BILLED IN FULL and never
// clamped, so it lands on the customer as a surprise negative balance.
//
// The gap behaves like a per-model constant (a system prefix the counter does
// not see), not a ratio, so the guard is a flat token allowance rather than a
// percentage. At glm-5.3-flash's price 128 tokens of headroom reserves an extra
// $0.00007 -- the settle gives it straight back, so it costs the user nothing.
const INPUT_SAFETY_TOKENS = cfg.int('INPUT_SAFETY_TOKENS', 128);

const bucket = new RateBucket({
  perMinute: cfg.int('API_RATE_PER_MINUTE', 60),
  burst: cfg.int('API_RATE_BURST', 20),
});
setInterval(() => bucket.sweep(), 300000).unref();

// ---------------------------------------------------------------------------
// Anthropic-shaped errors, so an off-the-shelf SDK understands us.
// ---------------------------------------------------------------------------
function send(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function apiError(res, status, type, message, extra = {}) {
  send(res, status, { type: 'error', error: { type, message } }, extra);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('body too large'), { tooLarge: true }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sellable() {
  const age = priceTableAge(db);
  // AN EXPIRED PRICE TABLE IS UNKNOWN, AND UNKNOWN DOES NOT BILL.
  if (age === null || age > REGISTRY_MAX_AGE) return null;
  return billableSet(db, ALLOWLIST_MODELS);
}

// ---------------------------------------------------------------------------
// POST /v1/messages
// ---------------------------------------------------------------------------
async function handleMessages(req, res, keyRow) {
  let raw;
  try {
    raw = await readBody(req, MAX_BODY);
  } catch (e) {
    if (e.tooLarge) return apiError(res, 413, 'invalid_request_error', `request body exceeds ${MAX_BODY} bytes`);
    return apiError(res, 400, 'invalid_request_error', 'could not read the request body');
  }

  let body;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    return apiError(res, 400, 'invalid_request_error', 'body is not valid JSON');
  }
  if (!body || typeof body !== 'object') {
    return apiError(res, 400, 'invalid_request_error', 'body must be a JSON object');
  }

  const models = sellable();
  if (models === null) {
    return apiError(res, 503, 'api_error', 'model prices are unavailable, so paid models are temporarily closed');
  }

  const row = models.find((m) => m.model === body.model);
  if (!row) {
    return apiError(res, 404, 'not_found_error',
      `model "${String(body.model ?? '')}" is not available. GET /v1/models for the current list.`);
  }

  // max_tokens MANDATORY AND FINITE. It is the only thing bounding the
  // reservation, and an unbounded request is an unbounded liability. We do not
  // default it: a caller who omits it must be told, not quietly charged for a
  // ceiling they never chose.
  const maxTokens = body.max_tokens;
  if (!Number.isInteger(maxTokens) || maxTokens < 1) {
    return apiError(res, 400, 'invalid_request_error', 'max_tokens is required and must be a positive integer');
  }
  const modelCap = row.max_output_tokens ?? UNDECLARED_OUTPUT_CAP;
  if (maxTokens > modelCap) {
    return apiError(res, 400, 'invalid_request_error',
      `max_tokens ${maxTokens} exceeds this model's limit of ${modelCap}`);
  }

  // A FLOOR, and it is REFUSED rather than silently raised.
  //
  // Measured 2026-09-11: at max_tokens=40 four of the ten sellable models
  // returned 200, spent output tokens, and delivered an EMPTY answer -- the
  // reasoning budget had consumed the whole allowance. Billed in full, nothing
  // delivered. Raising the value quietly would charge the caller more than they
  // asked for; refusing tells them why.
  const floor = minMaxTokensFor(row);
  if (maxTokens < floor) {
    return apiError(res, 400, 'invalid_request_error',
      `max_tokens must be at least ${floor} for ${row.model}: it reasons before answering, and a smaller allowance is consumed entirely by reasoning -- you would be billed for tokens with no answer to show for them`);
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return apiError(res, 400, 'invalid_request_error', 'messages must be a non-empty array');
  }

  // WE SEND NO cache_control, AND WE REFUSE ONE WE ARE GIVEN. The registry
  // exposes two rates while the platform's own schema carries four, so with
  // caching on, the table we bill from is a lossy projection of the one we are
  // billed by -- in both directions at once. A caller must not be able to opt
  // us into billing blind.
  if (JSON.stringify(body).includes('cache_control')) {
    return apiError(res, 400, 'invalid_request_error',
      'cache_control is not supported on this endpoint');
  }

  // Streaming is not implemented yet; say so rather than silently returning a
  // non-streamed body an SDK will fail to parse.
  if (body.stream === true) {
    return apiError(res, 400, 'invalid_request_error',
      'stream is not supported on this endpoint yet; omit it or set it to false');
  }

  const chatId = keyRow.chat_id;
  const isFree = FREE_TO_USER.has(row.model);

  // The free-model quota, enforced INDEPENDENTLY of balance and shared with the
  // Telegram side: a $0 quote reserves $0, so a money check admits it
  // unconditionally.
  if (isFree) {
    const q = takeFreeTurn(db, chatId, { perHour: FREE_PER_HOUR });
    if (!q.allowed) {
      return apiError(res, 429, 'rate_limit_error',
        `free-model quota exhausted (${q.limit}/hour). Use a paid model or wait for the next hour.`,
        { 'retry-after': '600' });
    }
  }

  const upstream = {
    model: row.model,
    max_tokens: maxTokens,
    messages: body.messages,
  };
  if (typeof body.system === 'string') upstream.system = body.system;
  if (typeof body.temperature === 'number') upstream.temperature = body.temperature;

  // COUNT the input where we can rather than estimating it. count_tokens was
  // verified working on this gateway (2026-09-11) despite the registry
  // declaring capabilities.countTokens:false, and it costs nothing -- so this
  // is not a trade. The byte estimator is the fallback.
  let inputTokens = await oona.countTokens(upstream);
  const counted = inputTokens !== null;
  if (!counted) inputTokens = estimateRequestTokens({ system: upstream.system ?? '', messages: upstream.messages });

  if (inputTokens > (row.context_window ? row.context_window - maxTokens : HOUSE_INPUT_CAP)) {
    return apiError(res, 400, 'invalid_request_error',
      'the request is too long for this model once max_tokens is reserved for the answer');
  }

  const charge = chargePriceFor(db, row, PRICE_MIRRORS);
  const priceRow = {
    inputPricePerMe9: parseScaled(charge.inputPerM, 9),
    outputPricePerMe9: parseScaled(charge.outputPerM, 9),
  };
  const quote = isFree ? 0n : quoteTurn({
    inputTokens: BigInt(inputTokens + INPUT_SAFETY_TOKENS),
    maxTokens: BigInt(maxTokens),
    priceRow,
    marginE6: MARGIN_E6,
  });

  // Serialise per user, exactly as the Telegram path does -- otherwise a caller
  // with N parallel requests can hold N reservations against one balance and
  // the per-user accounting stops meaning anything.
  let unlock;
  try {
    unlock = acquireUserLock(db, chatId);
  } catch (e) {
    if (e instanceof Busy) {
      return apiError(res, 429, 'rate_limit_error',
        'another request for this account is still in flight; this endpoint is one-at-a-time',
        { 'retry-after': '5' });
    }
    throw e;
  }

  // The idempotency key. A caller may supply one so a retry after a lost
  // response cannot be billed twice; otherwise we mint one, which makes each
  // call distinct.
  const supplied = req.headers['idempotency-key'];
  const reqKey = typeof supplied === 'string' && supplied.length > 0 && supplied.length <= 128
    ? `k${keyRow.id}:${supplied}`
    : `k${keyRow.id}:${randomUUID()}`;

  let resv;
  try {
    resv = reserve(db, { chatId, reqKey, model: row.model, microUsd: quote, allowOverdraft: ALLOW_OVERDRAFT });
  } catch (e) {
    unlock();
    if (e instanceof InsufficientFunds) {
      return apiError(res, 402, 'invalid_request_error',
        `insufficient balance: this request could cost up to $${microUsdToString(e.needed, 6)} and the balance is $${microUsdToString(e.available, 6)}. Top up in Telegram with /topup.`);
    }
    throw e;
  }

  if (resv.duplicate) {
    unlock();
    return apiError(res, 409, 'invalid_request_error',
      'that Idempotency-Key has already been used; the original request was already billed');
  }

  try {
    const resp = await oona.messages(upstream);

    const cache = assertNoCacheTokens(resp.usage);
    if (!cache.clean && !isFree) {
      log.error('gateway cached without being asked; billing blind on this model',
        { model: row.model, read: cache.read, write: cache.write });
    }

    const usage = usageFromResponse(resp);
    if (!usage.readable) {
      // A 200 whose usage we cannot read is NOT a free turn. It ran; HOLD.
      hold(db, resv.reservationId, `usage unreadable: ${usage.reason}`);
      log.error('api turn returned 200 with unusable usage; reservation HELD', { reason: usage.reason });
      return apiError(res, 502, 'api_error',
        'the upstream answer could not be accounted for; nothing has been settled and this will be reconciled');
    }

    const actual = isFree ? 0n
      : tokensToMicroUsd(BigInt(usage.inputTokens), priceRow.inputPricePerMe9, MARGIN_E6)
      + tokensToMicroUsd(BigInt(usage.outputTokens), priceRow.outputPricePerMe9, MARGIN_E6);

    const settled = settle(db, resv.reservationId, actual, {
      note: `api ${row.model} in=${usage.inputTokens} out=${usage.outputTokens} counted=${counted}`,
    });
    if (settled.overran) {
      log.error('API SETTLE OVERRAN THE RESERVATION -- billed in full, not clamped',
        { model: row.model, reserved: String(settled.reserved), actual: String(settled.actual), ratio: settled.ratio });
    }
    touchKey(db, keyRow.id);

    // Pass the model's answer through unchanged, plus our own cost headers so a
    // caller can reconcile against their balance without a second request.
    return send(res, 200, resp, {
      'x-pcn-cost-usd': microUsdToString(actual, 6),
      'x-pcn-balance-usd': microUsdToString(settled.balanceAfter, 6),
      'x-pcn-input-tokens': String(usage.inputTokens),
      'x-pcn-output-tokens': String(usage.outputTokens),
    });
  } catch (e) {
    if (e instanceof UpstreamError) {
      if (e.bucket === Bucket.PERMANENT || e.bucket === Bucket.BACKOFF || e.bucket === Bucket.NOT_BILLED) {
        release(db, resv.reservationId, `${e.bucket}: ${e.message}`);
        const status = e.bucket === Bucket.BACKOFF ? 429 : 502;
        return apiError(res, status,
          e.bucket === Bucket.BACKOFF ? 'rate_limit_error' : 'api_error',
          e.bucket === Bucket.BACKOFF
            ? 'the model service is queueing requests; nothing has been charged'
            : 'the model service refused this request; nothing has been charged',
          e.bucket === Bucket.BACKOFF ? { 'retry-after': '10' } : {});
      }
      // UNKNOWN: it MAY have run. Hold, and never retry on the caller's behalf.
      hold(db, resv.reservationId, `unknown: ${e.message}`);
      log.error('api turn ended UNKNOWN; reservation held', { err: e.message });
      return apiError(res, 504, 'api_error',
        'contact with the model was lost part-way through, so we cannot tell whether the answer was generated. Nothing has been settled; the amount is held and released automatically if no usage is recorded. Do not retry immediately.');
    }
    release(db, resv.reservationId, `internal: ${e.message}`);
    log.error('api handler threw', errFields(e));
    return apiError(res, 500, 'api_error', 'internal error');
  } finally {
    unlock();
  }
}

// ---------------------------------------------------------------------------
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/health' && req.method === 'GET') {
    return send(res, 200, { ok: true, service: 'pcnaibot-api', at: nowSec() });
  }

  // Authenticate. `x-api-key` or `Authorization: Bearer`, matching the upstream
  // convention so an Anthropic SDK works unchanged.
  const presented = req.headers['x-api-key']
    ?? (typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bearer ')
        ? req.headers.authorization.slice(7)
        : null);

  const keyRow = presented ? resolveKey(db, presented) : null;
  if (!keyRow) {
    // Absent, malformed, unknown and revoked are ONE answer from the outside.
    // The difference is only useful to somebody guessing.
    return apiError(res, 401, 'authentication_error', 'invalid or missing API key');
  }

  // Per-key admission control, independent of money.
  const t = bucket.take(String(keyRow.id));
  if (!t.allowed) {
    return apiError(res, 429, 'rate_limit_error', 'too many requests for this key',
      { 'retry-after': String(t.retryAfter) });
  }

  if (url.pathname === '/v1/models' && req.method === 'GET') {
    const models = sellable() ?? [];
    return send(res, 200, {
      data: models.map((m) => ({
        id: m.model,
        display_name: m.model,
        // Our price, margin included, so a caller can budget without guessing.
        free: FREE_TO_USER.has(m.model),
        input_usd_per_mtok: FREE_TO_USER.has(m.model) ? '0.000000'
          : (Number(chargePriceFor(db, m, PRICE_MIRRORS).inputPerM) * cfg.num('MARGIN', 3)).toFixed(6),
        output_usd_per_mtok: FREE_TO_USER.has(m.model) ? '0.000000'
          : (Number(chargePriceFor(db, m, PRICE_MIRRORS).outputPerM) * cfg.num('MARGIN', 3)).toFixed(6),
        max_output_tokens: m.max_output_tokens,
        context_window: m.context_window,
      })),
    });
  }

  if (url.pathname === '/v1/balance' && req.method === 'GET') {
    const u = db.prepare('SELECT balance_micro_usd, reserved_micro_usd FROM users WHERE chat_id = ?')
      .get(keyRow.chat_id);
    if (!u) return apiError(res, 404, 'not_found_error', 'no account for this key');
    return send(res, 200, {
      balance_usd: microUsdToString(u.balance_micro_usd, 6),
      reserved_usd: microUsdToString(u.reserved_micro_usd, 6),
      currency: 'USD',
    });
  }

  if (url.pathname === '/v1/messages' && req.method === 'POST') {
    return handleMessages(req, res, keyRow);
  }

  return apiError(res, 404, 'not_found_error', `no route for ${req.method} ${url.pathname}`);
});

// Below Apache's 660s and above a slow generation: the timeout we handle should
// be ours, with our own classification.
server.requestTimeout = 0;      // we bound the upstream call ourselves
server.headersTimeout = 30000;
server.keepAliveTimeout = 65000;

server.listen(PORT, HOST, () => {
  log.info('pcnaibot API listening', { host: HOST, port: PORT });
});
