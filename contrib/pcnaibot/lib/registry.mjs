// The model price table, from GET /api/registry.
//
// THE /v1/messages RESPONSE CONTAINS NO COST FIELD OF ANY KIND. openapi.json's
// MessagesResponse declares exactly id, type, role, model, content, stop_reason
// and usage{4 counters}. Cumulative costUsd exists only behind a BROWSER
// SESSION TOKEN -- an API key on /api/me/usage returns 401. So we price the
// tokens ourselves, and everything in this file follows from that.

import { parseScaled } from './money.mjs';
import { nowSec } from './time.mjs';

export class PriceUnknown extends Error {
  constructor(model, why) {
    super(`price unknown for ${model}: ${why}`);
    this.name = 'PriceUnknown';
    this.model = model;
  }
}

export const POOL_PROVIDER_ID = 'oonacode';

// RULE (a): THE KEY IS (provider.id === 'oonacode', model.id), NEVER model.id
// ALONE.
//
// 23 ids appear under two or three providers, and providers[0] is
// `anthropic-subscription`, whose claude-opus-5, claude-sonnet-5 and
// claude-haiku-4-5 rows OMIT THE PRICE KEY ENTIRELY. The natural one-liner
//     providers.flatMap(p => p.models).find(m => m.id === id)
// returns the unpriced row for exactly the models we sell. In JS that is NaN
// and every Claude turn is refused (loud). In PHP `null * $n` is 0: quote $0,
// reserve $0, and Sonnet is free to every user with no error anywhere.
export function findPoolModel(registry, id) {
  const providers = Array.isArray(registry?.providers) ? registry.providers : [];
  const pool = providers.find((p) => p?.id === POOL_PROVIDER_ID);
  if (!pool) throw new PriceUnknown(id, `no provider with id "${POOL_PROVIDER_ID}" in the registry`);
  const models = Array.isArray(pool.models) ? pool.models : [];
  return models.find((m) => m?.id === id) ?? null;
}

// The exclusion rule is "ABSENT, NULL, NON-NUMERIC OR NON-FINITE => REFUSE",
// not `=== null`. Nothing in the live registry uses a literal null -- the
// unpriced rows OMIT the key -- and isset() / === null / `in` all behave
// differently on that.
function requirePrice(value, model, field) {
  if (value === undefined || value === null) throw new PriceUnknown(model, `${field} is absent`);
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) throw new PriceUnknown(model, `${field} is not finite`);
  if (n < 0) throw new PriceUnknown(model, `${field} is negative`);
  return value;
}

// RULE (c): PROMPT-SIZE TIERING IS LIVE AND THE REGISTRY EXPOSES IT ONLY AS
// PROSE.
//
// Six pool models carry a `notes` string saying the published price is the HIGH
// tier: grok-4.6/4.5 ("this is the >=200k price; below 200k xAI charges half"),
// grok-4.3, grok-build-0.1, qwen3.7-plus ("below 256k $0.40/$1.60"),
// qwen3.6-flash. A Telegram chat prompt is essentially NEVER above 200k tokens,
// so a flat per-M calculation OVER-CHARGES THE USER 2x to 4.8x on every turn.
//
// This must REFUSE, not warn: the day a new tiered model enters the pool the
// bot stops rather than over-charging. A check that only prints is not a check.
const TIERED_PATTERNS = [
  /\bbelow\s+\d+\s*k\b/i,
  /\bthis is the\s*[>≥]=?\s*\d+\s*k\s*price\b/i,
  /\bhigh tier\b/i,
  /\bcharges? half\b/i,
  /\bTIERED\b/i,
];

export function looksTiered(notes) {
  if (typeof notes !== 'string' || notes === '') return false;
  return TIERED_PATTERNS.some((re) => re.test(notes));
}

// Normalise one pool model into the row we store. Throws PriceUnknown rather
// than producing a zero or a NaN.
export function normalizeModel(m) {
  if (!m || typeof m !== 'object' || typeof m.id !== 'string') {
    throw new PriceUnknown('<unknown>', 'model row is not an object with an id');
  }
  const inP = requirePrice(m.inputPricePerM, m.id, 'inputPricePerM');
  const outP = requirePrice(m.outputPricePerM, m.id, 'outputPricePerM');

  const inNum = Number(inP);
  const outNum = Number(outP);
  const isFree = inNum === 0 && outNum === 0;

  return {
    model: m.id,
    inputPricePerM: String(inP),
    outputPricePerM: String(outP),
    // Scaled integers for the money path. Prices are decimal strings in the
    // feed; they must never reach arithmetic as doubles.
    inputPricePerMe9: parseScaled(String(inP), 9),
    outputPricePerMe9: parseScaled(String(outP), 9),
    isFree,
    contextWindow: Number.isInteger(m.contextWindow) ? m.contextWindow : null,
    maxOutputTokens: Number.isInteger(m.maxOutputTokens) ? m.maxOutputTokens : null,
    notes: typeof m.notes === 'string' ? m.notes : null,
    tiered: looksTiered(m.notes),
    supportsThinking: m.supportsThinking === true,
  };
}

export async function fetchRegistry(url, { fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) return { readable: false, reason: `HTTP ${res.status}` };
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) return { readable: false, reason: `non-JSON content-type` };
    return { readable: true, json: await res.json() };
  } catch (e) {
    return { readable: false, reason: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

// RULE (d): /api/registry IS UNDOCUMENTED AND HAS NO USABLE FRESHNESS SIGNAL.
// openapi.json declares exactly three paths and this is not one of them. No
// Cache-Control, no ETag, no Last-Modified, no Age. Its body says
// "refreshMinutes": 10 while "updatedAt" is 13 days old, and the pool's own
// note admits "this list is hand-maintained". `refreshMinutes` invites "fresh
// within ten minutes"; `updatedAt` invites "stale by 13 days"; BOTH READINGS
// ARE WRONG AND THERE IS NO THIRD. So we persist with OUR OWN fetched_at.
//
// RULE: refuse any model whose price moved more than 2x against the stored
// value -- log loudly, KEEP THE OLD ONE.
export const MAX_PRICE_MOVE = 2;

export function upsertPrices(db, rows, { reachableIds = null } = {}) {
  const now = nowSec();
  const kept = [];
  const moved = [];

  const getPrev = db.prepare('SELECT * FROM model_prices WHERE model = ?');
  const put = db.prepare(
    `INSERT INTO model_prices
       (model, input_price_per_m, output_price_per_m, is_free, context_window,
        max_output_tokens, notes, reachable, supports_thinking, fetched_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(model) DO UPDATE SET
       input_price_per_m = excluded.input_price_per_m,
       output_price_per_m = excluded.output_price_per_m,
       is_free = excluded.is_free,
       context_window = excluded.context_window,
       max_output_tokens = excluded.max_output_tokens,
       notes = excluded.notes,
       reachable = excluded.reachable,
       supports_thinking = excluded.supports_thinking,
       fetched_at = excluded.fetched_at`
  );
  const touchFetched = db.prepare('UPDATE model_prices SET fetched_at = ?, reachable = ? WHERE model = ?');

  for (const r of rows) {
    const prev = getPrev.get(r.model);
    if (prev) {
      const pi = Number(prev.input_price_per_m);
      const po = Number(prev.output_price_per_m);
      const ni = Number(r.inputPricePerM);
      const no = Number(r.outputPricePerM);
      const jumped = (a, b) => a > 0 && b > 0 && (b / a > MAX_PRICE_MOVE || a / b > MAX_PRICE_MOVE);
      if (jumped(pi, ni) || jumped(po, no)) {
        moved.push({ model: r.model, from: `${pi}/${po}`, to: `${ni}/${no}` });
        // Keep the OLD price, but refresh freshness so we do not also trip the
        // expiry rule while refusing the new number.
        touchFetched.run(now, reachableIds ? (reachableIds.has(r.model) ? 1 : 0) : prev.reachable, r.model);
        continue;
      }
    }
    put.run(
      r.model, r.inputPricePerM, r.outputPricePerM, r.isFree ? 1 : 0,
      r.contextWindow, r.maxOutputTokens, r.notes,
      reachableIds ? (reachableIds.has(r.model) ? 1 : 0) : 0,
      r.supportsThinking ? 1 : 0,
      now
    );
    kept.push(r.model);
  }
  return { kept, moved };
}

export function storedPrice(db, model) {
  const row = db.prepare('SELECT * FROM model_prices WHERE model = ?').get(model);
  if (!row) throw new PriceUnknown(model, 'not in the stored price table');
  return row;
}

// An EXPIRED price table is UNKNOWN, and unknown does not bill. After the
// max age we STOP SELLING PAID MODELS rather than bill from a stale table.
export function priceTableAge(db) {
  const row = db.prepare('SELECT MAX(fetched_at) AS f FROM model_prices').get();
  if (!row || !row.f) return null; // never fetched = unknown, not fresh
  return nowSec() - row.f;
}

// RULE (e): THE BILLABLE SET IS
//     models(key) INTERSECT priced(registry.oonacode) INTERSECT allowlist
// recomputed on every refresh.
//
// Four states exist and two are dangerous:
//   * CALLABLE BUT UNPRICED must be REFUSED (otherwise it is free);
//   * PRICED BUT UNREACHABLE must be HIDDEN (otherwise a selected model 404s
//     AFTER the reservation is taken).
export function billableSet(db, allowlist) {
  const allow = new Set(allowlist);
  const rows = db.prepare('SELECT * FROM model_prices').all();
  const out = [];
  for (const r of rows) {
    if (!allow.has(r.model)) continue;
    if (!r.reachable) continue;              // absent from /v1/models: HIDE
    if (looksTiered(r.notes)) continue;      // tiered prose: never sell

    // AND THE TWO THINGS /v1/models DOES NOT TELL YOU (see lib/probe.mjs):
    //   * probe_ok = 0  -> listed but refuses at call time (all three Claude
    //     models are subscription-only and cannot be reached with an API key);
    //   * probe_bounded = 0 -> max_tokens does not bound its output, so every
    //     reservation is too small and, under the no-clamp rule, the overrun
    //     lands on the customer. qwen3.7-max returned 284x its cap.
    //
    // NULL means NEVER PROBED, which is unknown -- and unknown does not sell.
    if (r.probe_ok !== 1) continue;
    if (r.probe_bounded !== 1) continue;

    out.push(r);
  }
  return out;
}

// Startup assertions. These REFUSE TO START rather than warn.
export function assertSellable(db, allowlist, { bundledCost = null } = {}) {
  const problems = [];
  for (const model of allowlist) {
    let row;
    try { row = storedPrice(db, model); }
    catch { problems.push(`${model}: no stored price`); continue; }

    // (c) Tiered models over-charge 2-5x on every ordinary chat turn.
    if (looksTiered(row.notes)) {
      problems.push(`${model}: notes indicate PROMPT-SIZE TIERING (${String(row.notes).slice(0, 80)}) -- a flat per-M price over-charges every turn`);
    }

    // (b) THE REGISTRY IS RETAIL; THE SDK BUNDLE IS COST; the gap was exactly
    // 1.2x in every case measured. A live price BELOW known cost means the feed
    // is wrong, and the bot should refuse rather than sell below cost.
    if (bundledCost && bundledCost[model]) {
      const c = bundledCost[model];
      if (Number(row.input_price_per_m) < Number(c.inputPricePerM)
          || Number(row.output_price_per_m) < Number(c.outputPricePerM)) {
        problems.push(`${model}: registry price is BELOW known cost (${row.input_price_per_m}/${row.output_price_per_m} vs cost ${c.inputPricePerM}/${c.outputPricePerM})`);
      }
    }
  }
  if (problems.length) {
    throw new Error(`refusing to start:\n  - ${problems.join('\n  - ')}`);
  }
}

// The smallest max_tokens worth accepting for a model that reasons before it
// answers. Below this the reasoning budget swallows the whole allowance and the
// caller is billed in full for an empty reply -- measured, not theorised.
export const THINKING_MIN_MAX_TOKENS = 1024;
// A model that does not reason still needs room for a sentence.
export const PLAIN_MIN_MAX_TOKENS = 64;

export function minMaxTokensFor(row) {
  return row && row.supports_thinking ? THINKING_MIN_MAX_TOKENS : PLAIN_MIN_MAX_TOKENS;
}

// ---------------------------------------------------------------------------
// WHAT WE CHARGE, as opposed to what a model COSTS US.
//
// Two of the pool's models are priced 0/0 because the vendor gives that tier
// away. That is a fact about OUR cost, not about what the service is worth to a
// customer, and the two are not the same question.
//
// `PRICE_MIRROR` bills a zero-priced model at the LIVE registry price of a
// named sibling -- `mimo-v2.5:free` at `mimo-v2.5`, for instance. Deriving it
// from the feed rather than writing a number in a config file is the whole
// point: a hardcoded rate is how 3dmodels credited a batch at one fifteenth of
// value, and a mirrored price follows the vendor automatically.
//
// `FREE_TO_USER` is the short list that really is free to the customer. It is
// an ALLOW-LIST, so a model is billable unless it is named -- the safe
// direction, since the failure mode of the opposite default is giving work away
// silently.
// ---------------------------------------------------------------------------

// Parse "a>b,c>d" into a Map. Model ids contain ':' and '/', so '>' and ',' are
// the only separators that cannot collide with an id.
export function parseMirrors(spec) {
  const out = new Map();
  for (const pair of String(spec || '').split(',')) {
    const t = pair.trim();
    if (t === '') continue;
    const i = t.indexOf('>');
    if (i < 1) continue;
    const from = t.slice(0, i).trim();
    const to = t.slice(i + 1).trim();
    if (from && to) out.set(from, to);
  }
  return out;
}

// Every model whose price we need in the table: the ones we sell, plus any
// sibling a mirror points at. A mirror target that was never fetched would
// leave the mirrored model unpriceable -- and unpriceable means unsellable,
// which would silently drop it from the menu.
export function modelsToFetch(allowlist, mirrors) {
  const set = new Set(allowlist);
  for (const target of mirrors.values()) set.add(target);
  return [...set];
}

// The price a CUSTOMER is charged for a turn on `row`, as decimal strings.
// Throws rather than returning zero when a mirror target is missing: billing a
// model at zero because its price row was absent is the exact shape of the
// naive-lookup bug this file opens with.
export function chargePriceFor(db, row, mirrors) {
  const target = mirrors.get(row.model);
  if (!target) return { inputPerM: row.input_price_per_m, outputPerM: row.output_price_per_m, mirroredFrom: null };
  const t = db.prepare('SELECT input_price_per_m i, output_price_per_m o FROM model_prices WHERE model = ?').get(target);
  if (!t) throw new PriceUnknown(row.model, `price mirror target "${target}" is not in the stored price table`);
  return { inputPerM: t.i, outputPerM: t.o, mirroredFrom: target };
}
