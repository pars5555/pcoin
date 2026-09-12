#!/usr/bin/env node
// The Telegram-facing process.
//
// It never touches the explorer and never reads the rate oracle for crediting
// -- that is the watcher's job, in its own process. It does read the rate to
// RENDER the deposit screen, because a screen quoting a config constant while
// the watcher credits at the oracle is the pc.am 1/15th incident reproduced
// per-user.
//
// LONG POLLING, NOT A WEBHOOK. ufw is active on this host and long polling
// opens nothing -- outbound HTTPS only, no firewall change at all. It also
// survives a Caddy reload, a cert renewal and an IP change.

import { loadConfig } from './lib/config.mjs';
import { log, errFields, installCrashHandlers, chatTag, addrTag } from './lib/log.mjs';
import { openDb, assertSchema, pendingMigrations, kvGetJson, kvSetJson } from './lib/db.mjs';
import { nowSec } from './lib/time.mjs';
import { TelegramClient, escapeHtml } from './lib/telegram.mjs';
import { readRate } from './lib/rate.mjs';
import { allocateAddress, poolStats, PoolEmpty } from './lib/pool.mjs';
import { creditedUsdLast30Days } from './lib/deposits.mjs';
import { microUsdToString, usdToPcnString, satsToPcnString, parseScaled } from './lib/money.mjs';
import {
  fetchRegistry, findPoolModel, normalizeModel, upsertPrices, billableSet,
  storedPrice, priceTableAge, looksTiered, PriceUnknown, POOL_PROVIDER_ID,
  minMaxTokensFor, parseMirrors, modelsToFetch, chargePriceFor,
} from './lib/registry.mjs';
import { OonaCodeClient, Bucket, UpstreamError, usageFromResponse, assertNoCacheTokens } from './lib/oonacode.mjs';
import {
  reserve, settle, release, hold, ageOutReservations, acquireUserLock,
  takeFreeTurn, quoteTurn, InsufficientFunds, Busy,
} from './lib/billing.mjs';
import { estimateRequestTokens } from './lib/tokens.mjs';
import { WpcnService, isTxHash, STATE as WSTATE, humanMessage } from './lib/wpcn.mjs';
import { probeAll } from './lib/probe.mjs';
import { issueKey, listKeys, revokeKey } from './lib/apikeys.mjs';
import QRCode from 'qrcode';
import { extractSvgs, svgToPng, unknownBlockTypes } from './lib/render.mjs';
import { streamMessages, StreamStage } from './lib/stream.mjs';
import { DraftStream } from './lib/drafts.mjs';
import { tokensToMicroUsd } from './lib/money.mjs';

const cfg = loadConfig();
installCrashHandlers();

const DB_PATH = cfg.str('DB_PATH');
const db = openDb(DB_PATH);
if (pendingMigrations(db).length) {
  log.error('refusing to start: pending migrations');
  process.exit(1);
}
assertSchema(db);

const kvStore = { getJson: (k) => kvGetJson(db, k), setJson: (k, v) => kvSetJson(db, k, v) };

const tg = new TelegramClient(cfg.str('TELEGRAM_TOKEN'));
const oona = new OonaCodeClient(
  cfg.strOr('OONACODE_BASE', 'https://api.oonacode.oonak.ai'),
  cfg.str('OONACODE_KEY'),
  {
    idleTimeoutMs: cfg.int('UPSTREAM_IDLE_TIMEOUT_MS', 120000),
    connectTimeoutMs: cfg.int('UPSTREAM_CONNECT_TIMEOUT_MS', 10000),
    maxConcurrent: cfg.int('MAX_CONCURRENT_UPSTREAM', 4),
  }
);

const MARGIN_E6 = parseScaled(String(cfg.num('MARGIN', 3.0)), 6);
const ALLOWLIST_MODELS = cfg.list('MODEL_ALLOWLIST');
const DEFAULT_MODEL = cfg.strOr('DEFAULT_MODEL', 'glm-5.3-flash');
const ALLOWED_CHATS = new Set(cfg.intList('ALLOWLIST_CHAT_IDS'));
const ADMIN_CHATS = new Set(cfg.intList('ADMIN_CHAT_IDS'));
const GRANT_MICRO = cfg.int('GRANT_MICRO_USD', 100000);
const MIN_CONF = cfg.int('MIN_CONF', 3);
const PUBLISHED_MIN_USD = cfg.num('PUBLISHED_MIN_USD', 5);
const CAP_USER_MICRO = BigInt(Math.round(cfg.num('CAP_30D_USD_PER_USER', 2000) * 1e6));
const HOUSE_INPUT_CAP = cfg.int('HOUSE_INPUT_TOKEN_CAP', 16000);
const FREE_PER_HOUR = cfg.int('FREE_TURNS_PER_HOUR', 10);
const RL_FLOOR = cfg.int('RATELIMIT_REMAINING_FLOOR', 30);
const REGISTRY_URL = cfg.strOr('OONACODE_REGISTRY_URL', 'https://api.oonacode.oonak.ai/api/registry');
const REGISTRY_MAX_AGE = cfg.int('REGISTRY_MAX_AGE_SECONDS', 21600);

// What a CUSTOMER pays, which is a different question from what a model costs
// us. See lib/registry.mjs: mirrors bill a zero-cost model at a named
// sibling's LIVE price, and FREE_TO_USER is an allow-list so a model is
// billable unless it is explicitly named free.
const PRICE_MIRRORS = parseMirrors(cfg.strOr('PRICE_MIRROR', ''));
const FREE_TO_USER = new Set(cfg.list('FREE_TO_USER'));
const WPCN_ENABLED = cfg.bool('WPCN_ENABLED', false);
const EXPLORER_PUBLIC = cfg.strOr('EXPLORER_URL', 'https://explorer.pc.am');

const wpcn = new WpcnService(db, {
  token: cfg.strOr('WPCN_PAY_TOKEN', null),
  endpoint: cfg.strOr('WPCN_PAY_URL', 'https://wpcnpay.pc.am'),
  enabled: WPCN_ENABLED && !!cfg.strOr('WPCN_PAY_TOKEN', null),
});

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
const STREAMING = cfg.bool('STREAMING', true);
// A global ceiling on turns being handled at once. Not about money -- about not
// letting a burst of users open an unbounded number of upstream streams against
// a gateway that shares a box with seed 4 and checker.pc.am.
const MAX_CONCURRENT_TURNS = cfg.int('MAX_CONCURRENT_TURNS', 8);
const ALLOW_OVERDRAFT = cfg.bool('ALLOW_OVERDRAFT', false);

// DIAGNOSTIC ONLY. When set, this string is appended to every text chunk
// received from the provider, so the delivered answer shows exactly where the
// SSE frame boundaries fell and how many of them a single Telegram frame
// carried. Leave it EMPTY in normal operation -- it is inserted into what the
// customer reads, and it is billed for as part of nothing, since the marker is
// added after the token counts are taken.
const CHUNK_MARKER = cfg.strOr('DEBUG_CHUNK_MARKER', '');

// An inline Stop button lives on a REAL message, because sendMessageDraft takes
// no reply_markup -- a draft cannot carry a keyboard. It is only sent once a
// turn has actually run for a few seconds, so short answers stay clean.
const STOP_BUTTON_AFTER_MS = cfg.int('STOP_BUTTON_AFTER_MS', 4000);
const MAX_OUTPUT_TOKENS = cfg.int('MAX_OUTPUT_TOKENS', 8192);
const MIN_OUTPUT_TOKENS = cfg.int('MIN_OUTPUT_TOKENS', 1024);
// What to assume when the registry declares NO output limit -- which is the
// case for six of the ten models we sell. The old fallback was 4096, and since
// Math.min() takes the smaller of the two, THAT was the real ceiling on most
// models, not the configured cap. Probed 2026-09-11: all ten accept 32000.
const UNDECLARED_OUTPUT_CAP = cfg.int('UNDECLARED_OUTPUT_CAP', 32000);

// Streams currently in flight, keyed by chat, so the user's stop button can
// reach the right one. A chat can only have one turn at a time (the busy_at
// lock), so a plain Map is exactly right.
const activeStreams = new Map();

// Turns currently being handled. THE POLL LOOP MUST NOT AWAIT A TURN.
//
// It used to, and that made the stop button impossible: a ten-minute stream
// blocked getUpdates for ten minutes, so `stopped_message_generation` sat
// unread in Telegram's queue until the answer it was meant to stop had already
// finished. A control that cannot be delivered in time is not a control.
// It also meant one long answer blocked every other user.
//
// Per-user serialisation is unaffected -- that is the busy_at lock, and a
// second message from the same chat is still refused while their turn runs.
const inFlightTurns = new Set();

// draft_id MUST be non-zero, and must be stable for the life of one answer:
// frames sharing an id animate into each other, a new id starts a new bubble.
// The Telegram update_id is already unique per turn.
function draftIdFor(updateId) {
  const n = Number(updateId) | 0;
  return n === 0 ? 1 : Math.abs(n);
}

// ---------------------------------------------------------------------------
// The price table refresh.
// ---------------------------------------------------------------------------
async function refreshPrices() {
  const reg = await fetchRegistry(REGISTRY_URL);
  if (!reg.readable) {
    // A FETCH FAILURE KEEPS THE PREVIOUS SET. An empty answer from a call that
    // failed is not an empty set.
    log.warn('registry unreadable; keeping the stored price table', { reason: reg.reason });
    return;
  }
  let reachable = null;
  try {
    reachable = new Set(await oona.models());
  } catch (e) {
    log.warn('could not list reachable models; keeping previous reachability', errFields(e));
  }

  const rows = [];
  for (const id of modelsToFetch(ALLOWLIST_MODELS, PRICE_MIRRORS)) {
    const m = findPoolModel(reg.json, id);
    if (!m) { log.warn('allow-listed model is not in the pool', { model: id }); continue; }
    try { rows.push(normalizeModel(m)); }
    catch (e) { log.error('allow-listed model has no usable price; it will not be sold', { model: id, err: e.message }); }
  }
  const res = upsertPrices(db, rows, { reachableIds: reachable });
  for (const m of res.moved) {
    log.error('price moved more than 2x; KEEPING THE OLD VALUE', { model: m.model, from: m.from, to: m.to });
  }
  log.info('price table refreshed', { kept: res.kept.length, refused: res.moved.length });
}

function sellableModels() {
  const age = priceTableAge(db);
  // AN EXPIRED PRICE TABLE IS UNKNOWN, AND UNKNOWN DOES NOT BILL.
  if (age === null || age > REGISTRY_MAX_AGE) return { expired: true, age, models: [] };
  return { expired: false, age, models: billableSet(db, ALLOWLIST_MODELS) };
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------
function ensureUser(chatId) {
  const u = db.prepare('SELECT * FROM users WHERE chat_id = ?').get(chatId);
  if (u) return u;
  db.prepare('INSERT INTO users (chat_id, model, created_at) VALUES (?,?,?)')
    .run(chatId, DEFAULT_MODEL, nowSec());
  // The one-off grant, in its OWN column. NOT fungible with the paid balance:
  // a fungible $0.10 is exactly one claude-opus-5 turn, and Telegram accounts
  // are free.
  if (GRANT_MICRO > 0) {
    db.prepare('UPDATE users SET grant_micro_usd = ? WHERE chat_id = ?').run(GRANT_MICRO, chatId);
    db.prepare(`INSERT INTO ledger (chat_id, delta_micro_usd, kind, idem_key, note, created_at)
                VALUES (?,?,?,?,?,?) ON CONFLICT(idem_key) DO NOTHING`)
      .run(chatId, 0, 'grant', `grant:${chatId}`, 'free-model-only grant, not spendable on paid models', nowSec());
  }
  return db.prepare('SELECT * FROM users WHERE chat_id = ?').get(chatId);
}

function history(chatId) {
  const row = db.prepare('SELECT history FROM conversations WHERE chat_id = ?').get(chatId);
  if (!row) return [];
  try { return JSON.parse(row.history); } catch { return []; }
}

function saveHistory(chatId, msgs) {
  db.prepare(`INSERT INTO conversations (chat_id, history, updated_at) VALUES (?,?,?)
              ON CONFLICT(chat_id) DO UPDATE SET history=excluded.history, updated_at=excluded.updated_at`)
    .run(chatId, JSON.stringify(msgs), nowSec());
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------
const NEWLINE = String.fromCharCode(10);
const BSLASH = String.fromCharCode(92);
const SQ = String.fromCharCode(39);
const ONE_WAY = 'Deposits are <b>one-way</b>: PCN in, credit out. Balances are held in <b>USD</b>, are not withdrawable, and are not refundable.';

function startScreen(u) {
  return [
    '<b>PCoin AI</b> — talk to paid AI models and pay in PCN.',
    '',
    `Balance: <b>$${escapeHtml(microUsdToString(u.balance_micro_usd, 4))}</b>`,
    GRANT_MICRO > 0
      ? `Free grant: <b>$${escapeHtml(microUsdToString(u.grant_micro_usd, 4))}</b> — spendable on <b>free models only</b>.`
      : '',
    '',
    ONE_WAY,
    'This is a service credit, not an account balance you can withdraw. We hold no keys for you and send no PCN.',
    '',
    '/models — choose a model     /topup — add credit',
    '/balance — balance and history     /help — how it works',
  ].filter(Boolean).join('\n');
}

// The QR carries a BARE ADDRESS, not a pcoin: payment URI.
//
// A URI scheme does exist -- contrib/windows-tray/PaymentUri.cs parses
// `pcoin:` / `pcn:` / `bitcoin:` with ?amount= and ?label= -- but ONLY the
// Windows wallet parses it; nothing in the Android or iOS trees does. A bare
// bech32 address is what every scanner handles, and a QR that some of our own
// wallets cannot read is worse than one with no amount pre-filled.
//
// Rendered LOCALLY. Never a link to a third-party QR service: a deposit address
// is per-user and reused forever, so handing it to an outside image host would
// publish a customer's chain identity to a party with no reason to have it.
async function depositQr(address) {
  return QRCode.toBuffer(address, {
    type: 'png',
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 512,
    color: { dark: '#000000ff', light: '#ffffffff' },
  });
}

async function depositScreen(chatId) {
  let alloc;
  try {
    alloc = allocateAddress(db, chatId);
  } catch (e) {
    if (e instanceof PoolEmpty) {
      log.error('ADDRESS POOL EMPTY -- a user could not be given a deposit address', { chat: chatTag(chatId) });
      for (const a of ADMIN_CHATS) {
        await tg.sendMessage(a, 'The pcnaibot deposit address pool is EMPTY. New users cannot be given an address.');
      }
      return 'We could not allocate a deposit address just now. This has been reported and will be fixed — please try again shortly.';
    }
    throw e;
  }

  // QUOTE THE LIVE ORACLE, OR SAY "RATE UNAVAILABLE". Never a config constant.
  const rate = await readRate(kvStore, cfg);

  const lines = [
    '<b>Top up with PCN</b>',
    '',
    'Send PCN to your own permanent address:',
    `<code>${escapeHtml(alloc.address)}</code>`,
    '',
  ];

  if (rate.usable) {
    const minPcn = usdToPcnString(BigInt(Math.round(PUBLISHED_MIN_USD * 1e6)), rate.rateE12);
    lines.push(
      `Rate right now: <b>1 PCN = $${escapeHtml(Number(rate.rateText).toFixed(6))}</b>`,
      `Suggested minimum: <b>${escapeHtml(minPcn)} PCN</b> (about $${PUBLISHED_MIN_USD})`,
      '',
      `<b>The rate is read when your deposit confirms, not now.</b> It can move while you wait, and that move is yours either way.`,
    );
    // 30-day headroom, stated in PCN at the live rate. CAPS ARE ENFORCED BEFORE
    // THE MONEY MOVES -- a deposit that lands over a cap is credited and
    // flagged, never kept and refused.
    const used = creditedUsdLast30Days(db, chatId);
    const headroom = CAP_USER_MICRO > used ? CAP_USER_MICRO - used : 0n;
    if (headroom <= 0n) {
      lines.push('', '<b>Your 30-day top-up limit is used up.</b> Please do not send more until it frees up.');
    } else {
      lines.push('', `30-day headroom left: <b>$${escapeHtml(microUsdToString(headroom, 2))}</b> (~${escapeHtml(usdToPcnString(headroom, rate.rateE12))} PCN)`);
    }
  } else {
    lines.push('<b>Rate unavailable right now.</b> Your deposit will still be credited — the rate is read when it confirms, not now.');
  }

  lines.push(
    '',
    `Credited after <b>${MIN_CONF} confirmations</b> (about 30 minutes, sometimes longer).`,
    'Coinbase (freshly mined) payments need 100 confirmations.',
    '',
    ONE_WAY,
    '',
    `<a href="${EXPLORER_PUBLIC}/address/${encodeURIComponent(alloc.address)}">View this address on the explorer</a>`,
  );

  const recent = db.prepare(
    `SELECT amount_sat, status, credited_micro_usd FROM pcn_deposits
      WHERE chat_id = ? ORDER BY id DESC LIMIT 10`
  ).all(chatId);
  if (recent.length) {
    lines.push('', '<b>Recent deposits</b>');
    for (const d of recent) {
      lines.push(`· ${escapeHtml(satsToPcnString(d.amount_sat))} PCN — ${escapeHtml(d.status)}`
        + (d.credited_micro_usd !== null ? ` — $${escapeHtml(microUsdToString(d.credited_micro_usd, 4))}` : ''));
    }
  }
  return lines.join('\n');
}

async function wpcnScreen() {
  if (!WPCN_ENABLED) {
    return 'wPCN top-ups are not enabled yet. Please top up with PCN using /topup.';
  }
  const info = await wpcn.paymentInfo();
  if (!info) {
    return 'The wPCN payment service is unreachable right now. Please try again shortly, or top up with PCN using /topup.';
  }
  return [
    '<b>Top up with wPCN</b>',
    '',
    'wPCN is the wrapped form of PCN on <b>BNB Smart Chain (BEP-20)</b>.',
    `Token contract: <code>0x290A5779a419Cb9cB22fa087CDD1CD16dA2D95F1</code>`,
    '<b>wPCN has 8 decimals, not 18.</b>',
    '',
    'Send wPCN to:',
    `<code>${escapeHtml(info.payTo)}</code>`,
    '',
    // wPCN is a 1:1 claim on PCN, redeemable 1:1, so it credits at PARITY --
    // and the screen must say whatever is actually true rather than a number
    // baked in here. bonusPercent went 10 -> 0 on 2026-09-11 precisely because
    // a bonus on a 1:1 claim contradicts the property that makes it work; if it
    // is ever non-zero again, the user is told, not silently given a rate the
    // code did not expect.
    info.bonusPct === 0
      ? 'wPCN credits <b>exactly the same</b> as the same amount of PCN.'
      : `Paying in wPCN currently credits <b>${escapeHtml(String(info.bonusPct))}% more</b> than the same amount of PCN.`,
    info.minConfirmations ? `Credited after ${info.minConfirmations} BSC confirmations.` : '',
    '',
    '<b>Then paste your transaction hash here</b> (the 0x… value) and it will be verified.',
    '',
    ONE_WAY,
  ].filter(Boolean).join('\n');
}

async function handleTxHash(chatId, txhash) {
  if (!WPCN_ENABLED) {
    return 'That looks like a BNB Smart Chain transaction hash. wPCN top-ups are not enabled yet — please top up with PCN using /topup.';
  }
  const r = await wpcn.verifyAndCredit(chatId, txhash);

  if (r.state === WSTATE.CREDITED && r.creditedMicro > 0n) {
    return `Credited <b>$${escapeHtml(microUsdToString(r.creditedMicro, 4))}</b>${r.healed ? ' (recovered from an earlier interrupted payment)' : ''}.`;
  }
  if (r.state === WSTATE.CREDITED && r.duplicate) {
    return 'That transaction was already credited to your balance.';
  }
  if (r.state === WSTATE.ALREADY_CLAIMED) {
    return r.yours
      ? 'That transaction is already credited to your balance.'
      : 'That transaction has already been claimed by another account. If you believe that is wrong, please report it.';
  }
  // 503 unreadable -> THE QUESTION IS UNANSWERED. Resolve nothing, and never
  // say "payment not found".
  if (r.state === WSTATE.UNREADABLE) {
    return 'We could not reach the blockchain just now. <b>Your payment is safe</b> — please try again in a minute.';
  }
  return escapeHtml(humanMessage({ state: r.state }));
}

// Set a user's model, refusing anything not currently sellable. The billable
// set is recomputed from the probe on every call, so a model that went away
// between rendering the keyboard and the user tapping it is refused rather
// than stored and 404d on the next turn.
function setModel(chatId, model) {
  const s = sellableModels();
  if (s.expired) return { ok: false, msg: 'Model prices are unavailable right now, so paid models are temporarily closed.' };
  const row = s.models.find((m) => m.model === model);
  if (!row) {
    return { ok: false, msg: `<code>${escapeHtml(model)}</code> is not available. Use /models for the current list.` };
  }
  db.prepare('UPDATE users SET model = ? WHERE chat_id = ?').run(row.model, chatId);
  let price;
  if (FREE_TO_USER.has(row.model)) {
    price = 'free';
  } else {
    const c = chargePriceFor(db, row, PRICE_MIRRORS);
    price = `$${(Number(c.inputPerM) * cfg.num('MARGIN', 3)).toFixed(4)} in / $${(Number(c.outputPerM) * cfg.num('MARGIN', 3)).toFixed(4)} out per 1M tokens`;
  }
  return { ok: true, model: row.model, msg: `Model set to <b>${escapeHtml(row.model)}</b> — ${escapeHtml(price)}.

Just send a message to use it.` };
}

function modelsScreen() {
  const s = sellableModels();
  if (s.expired) {
    return { text: 'Model prices are not available right now, so paid models are temporarily closed. Free models still work.', keyboard: null };
  }
  const rows = s.models.map((m) => {
    let label;
    if (FREE_TO_USER.has(m.model)) {
      label = `${m.model} — FREE`;
    } else {
      // The price shown is the price CHARGED, mirror included -- a menu that
      // advertised the vendor's 0 while the turn debited a balance would be the
      // deposit-screen-vs-oracle mismatch all over again.
      const c = chargePriceFor(db, m, PRICE_MIRRORS);
      const inUsd = (Number(c.inputPerM) * Number(cfg.num('MARGIN', 3))).toFixed(4);
      const outUsd = (Number(c.outputPerM) * Number(cfg.num('MARGIN', 3))).toFixed(4);
      label = `${m.model} — $${inUsd}/$${outUsd} per 1M`;
    }
    return [{ text: label, callback_data: `m:${m.model}` }];
  });
  return {
    text: '<b>Choose a model.</b> Prices are per 1M tokens, input/output, and include our margin.\n\nReasoning tokens are billed as output.',
    keyboard: rows.length ? { inline_keyboard: rows } : null,
  };
}

const API_BASE_PUBLIC = cfg.strOr('API_PUBLIC_URL', null);

function apiHelpScreen() {
  if (!API_BASE_PUBLIC) {
    return 'The HTTP API is not enabled on this deployment.';
  }
  return [
    '<b>Use your balance outside Telegram</b>',
    '',
    'Create a key with /apikey, then call the API the same way you would call Anthropic:',
    '',
    // Built with explicit character codes: a backslash-continuation and a
    // single quote inside a shell example are exactly the two characters that
    // get mangled by every layer between here and the user's terminal.
    '<pre>curl ' + escapeHtml(API_BASE_PUBLIC) + '/v1/messages ' + BSLASH,
    '  -H "x-api-key: $PCN_KEY" ' + BSLASH,
    '  -H "content-type: application/json" ' + BSLASH,
    '  -d ' + SQ + '{"model":"glm-5.3-flash","max_tokens":256,',
    '        "messages":[{"role":"user","content":"Hello"}]}' + SQ + '</pre>',
    '',
    'Endpoints:',
    '· <code>POST /v1/messages</code> — a turn, billed to your balance',
    '· <code>GET /v1/models</code> — what you can call, with your prices',
    '· <code>GET /v1/balance</code> — your balance',
    '',
    'Every reply carries <code>x-pcn-cost-usd</code> and <code>x-pcn-balance-usd</code>.',
    '<code>max_tokens</code> is required. Send <code>Idempotency-Key</code> to make a retry safe.',
    '',
    '/apikeys — list your keys     /revoke &lt;prefix&gt; — revoke one',
  ].join(NEWLINE);
}

function apiKeysScreen(chatId) {
  const rows = listKeys(db, chatId);
  if (rows.length === 0) return 'You have no API keys. Create one with /apikey.';
  const lines = ['<b>Your API keys</b>', ''];
  for (const k of rows) {
    lines.push(`· <code>${escapeHtml(k.key_prefix)}…</code>`
      + (k.revoked_at ? ' — <b>revoked</b>' : '')
      + ` — ${k.calls} call(s)`
      + (k.last_used_at ? `, last used ${new Date(k.last_used_at * 1000).toISOString().slice(0, 16)}Z` : ', never used'));
  }
  lines.push('', 'Revoke one with <code>/revoke &lt;prefix&gt;</code>.');
  return lines.join(NEWLINE);
}

function balanceScreen(u) {
  const led = db.prepare('SELECT * FROM ledger WHERE chat_id=? ORDER BY id DESC LIMIT 10').all(u.chat_id);
  const lines = [
    `Balance: <b>$${escapeHtml(microUsdToString(u.balance_micro_usd, 6))}</b>`,
    `Reserved for a turn in flight: $${escapeHtml(microUsdToString(u.reserved_micro_usd, 6))}`,
    GRANT_MICRO > 0 ? `Free grant (free models only): $${escapeHtml(microUsdToString(u.grant_micro_usd, 6))}` : '',
    `Model: <code>${escapeHtml(u.model)}</code>`,
  ].filter(Boolean);
  if (u.balance_micro_usd < 0) {
    lines.push('', '<b>Your balance is negative.</b> A turn cost more than was reserved for it. Top up to continue.');
  }
  if (led.length) {
    lines.push('', '<b>Recent activity</b>');
    for (const l of led) {
      const sign = l.delta_micro_usd >= 0 ? '+' : '-';
      lines.push(`· ${escapeHtml(l.kind)} ${sign}$${escapeHtml(microUsdToString(Math.abs(l.delta_micro_usd), 6))}`);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// The AI turn.
// ---------------------------------------------------------------------------
async function runTurn(chatId, updateId, text) {
  const u = ensureUser(chatId);

  const s = sellableModels();
  const row = s.models.find((m) => m.model === u.model);
  if (s.expired) {
    return 'Model prices are not available right now, so paid models are temporarily closed. Please try again shortly.';
  }
  if (!row) {
    // The model left the billable set. Move the user to the house default with
    // one line, rather than 404ing after a reservation.
    db.prepare('UPDATE users SET model=? WHERE chat_id=?').run(DEFAULT_MODEL, chatId);
    return `Your model is no longer available, so you have been moved to <code>${escapeHtml(DEFAULT_MODEL)}</code>. Please send your message again.`;
  }

  const isFree = FREE_TO_USER.has(row.model);

  // FREE-MODEL QUOTA, ENFORCED INDEPENDENTLY OF BALANCE. A $0 quote reserves
  // $0, so a money check would admit it unconditionally -- one user spamming a
  // free model would deny service to every paying user at zero cost.
  if (isFree) {
    const q = takeFreeTurn(db, chatId, { perHour: FREE_PER_HOUR });
    if (!q.allowed) {
      return `You have used your ${q.limit} free turns for this hour. Free models reset hourly, or you can top up with /topup to use a paid model.`;
    }
  }

  // SHED FREE TRAFFIC FIRST when the shared 300/60 budget runs low. NEVER SPEND
  // THE LAST OF A SHARED BUDGET ON A $0 TURN.
  if (isFree && oona.rateLimitRemaining !== null && oona.rateLimitRemaining < RL_FLOOR) {
    return 'The model service is busy right now. Free models are paused for a moment so paid turns can go through — please try again shortly.';
  }

  // CIRCUIT BREAKER BEFORE THE RESERVATION, so a user with money is told the
  // service is unavailable rather than having money reserved against a call
  // that never happens.
  const breaker = kvGetJson(db, 'breaker') ?? { consecutiveUnknown: 0, openUntil: 0 };
  if (breaker.openUntil > nowSec()) {
    return 'The model service is unavailable at the moment. <b>Your balance is untouched.</b> Please try again in a few minutes.';
  }

  const msgs = history(chatId);
  msgs.push({ role: 'user', content: text });

  // WHAT BOUNDS THE LENGTH OF AN ANSWER.
  //
  // This used to read Math.min(Math.max(1024, 2048), cap), which is a
  // roundabout way of writing 2048 -- so every answer was capped at 2048
  // output tokens. Measured: mimo writes ~741 tokens in 21s, so 2048 is about
  // a minute. A ten-minute answer was ARITHMETICALLY IMPOSSIBLE, whatever the
  // streaming machinery could carry.
  //
  // The floor stays because a reasoning model given less than ~1024 spends the
  // whole allowance thinking and returns nothing, billed in full.
  //
  // Raising this raises the RESERVATION, since max_tokens is the only thing
  // bounding it: at gpt-5's $36/1M output, 8192 tokens reserves ~$0.29 per turn
  // up front. The settle gives back whatever is unused, but the balance has to
  // cover the ceiling before the turn starts.
  const maxTokens = Math.min(
    Math.max(MIN_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS),
    row.max_output_tokens ?? UNDECLARED_OUTPUT_CAP
  );
  const contextWindow = row.context_window ?? null;
  const inputCap = contextWindow ? Math.floor(contextWindow - maxTokens - contextWindow * 0.1) : HOUSE_INPUT_CAP;

  // Trim oldest-first so the request is bounded BEFORE it is quoted -- never
  // discover the real limit as a 400 taken AFTER the reservation.
  let trimmed = msgs;
  while (trimmed.length > 2 && estimateRequestTokens({ messages: trimmed }) > inputCap) {
    trimmed = trimmed.slice(1);
  }

  const body = {
    model: row.model,
    max_tokens: maxTokens,
    messages: trimmed,
  };

  // COUNT THE INPUT IF WE CAN; estimate only as a fallback.
  let inputTokens = await oona.countTokens(body);
  let counted = inputTokens !== null;
  if (!counted) inputTokens = estimateRequestTokens({ messages: trimmed });

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

  let res;
  try {
    res = reserve(db, { chatId, updateId, model: row.model, microUsd: quote, allowOverdraft: ALLOW_OVERDRAFT });
  } catch (e) {
    if (e instanceof InsufficientFunds) {
      const need = microUsdToString(e.needed, 4);
      return `This turn could cost up to <b>$${escapeHtml(need)}</b> and your balance is $${escapeHtml(microUsdToString(e.available, 4))}.\n\nTop up with /topup, or switch to a free model with /models.`;
    }
    throw e;
  }
  if (res.duplicate) {
    log.warn('duplicate reservation for an update we already claimed', { update: updateId });
    return null;
  }

  // THE STREAMED PATH. Preferred for every turn, because message_start gives
  // the exact input count before any output exists -- the only way to STOP an
  // overrun rather than discover it on the bill.
  if (STREAMING) {
    try {
      const r = await runTurnStreamed({
        chatId, updateId, row, upstream: body, priceRow, isFree, quote, resv: res, counted,
        quotedInputTokens: inputTokens,
      });

      if (r.held) {
        return 'We lost contact with the model before it began answering, so nothing has been settled. '
          + 'The amount is held and released automatically if no usage is recorded. Please do not resend immediately.';
      }

      if (r.overranInput) {
        return 'That message is longer than your balance covers, so it was stopped before the model began writing. '
          + 'You have been charged only for reading it. Shorten it, use /clear to drop the conversation history, or top up with /topup.';
      }

      const answer = r.text.trim();
      if (answer !== '') {
        msgs.push({ role: 'assistant', content: answer });
        saveHistory(chatId, msgs);
      }

      // Send the real message BEFORE clearing the draft, so the answer is never
      // absent from the screen. The draft is ephemeral and would expire on its
      // own anyway; clearing is only tidiness.
      const note = r.aborted && !r.overranInput ? '\n\n<i>stopped</i>'
        : (r.reconstructed ? '\n\n<i>the answer was cut short; billed on what was generated</i>' : '');
      await tg.sendLong(chatId, `${escapeHtml(answer) || '(the model returned no text)'}${note}`);
      try { await r.draft.clear(); } catch (e) { log.debug('draft clear failed', errFields(e)); }

      // AN SVG IS AN IMAGE. No model here can emit a raster one, but several
      // will happily write SVG when asked for an icon or a diagram -- and
      // 3,000 characters of markup is not what the user asked for. Rasterise
      // and send the picture; the text still follows, so a render failure
      // costs nothing.
      for (const svg of extractSvgs(answer).slice(0, 3)) {
        const png = await svgToPng(svg);
        if (!png) continue;
        try {
          await tg.sendPhoto(chatId, png, {
            filename: 'render.png',
            caption: 'Rendered from the SVG in the answer above.',
          });
        } catch (e) { log.warn('could not send the rendered image', errFields(e)); }
      }

      // Already sent above, before the draft was cleared. Returning null stops
      // the poll loop sending it a second time.
      //
      // The per-turn cost is deliberately NOT appended to the answer -- it is
      // noise on every message, and /balance carries the same information on
      // demand with the last ten movements for context. A turn that ended
      // abnormally still says so, because that changes what the user is
      // looking at.
      return null;
    } catch (e) {
      if (e instanceof UpstreamError) throw e;
      release(db, res.reservationId, `internal: ${e.message}`);
      throw e;
    }
  }

  const stopTyping = tg.typingKeepalive(chatId);
  try {
    const resp = await oona.messages(body);

    const cache = assertNoCacheTokens(resp.usage);
    if (!cache.clean) {
      log.error('GATEWAY CACHED WITHOUT US ASKING -- we are billing blind on this model', {
        model: row.model, read: cache.read, write: cache.write,
      });
    }

    const usage = usageFromResponse(resp);
    if (!usage.readable) {
      // A 200 whose usage we cannot read is NOT a free turn -- that is exactly
      // webbuilderbot's bug. It ran; hold and let the reconciler settle it.
      hold(db, res.reservationId, `usage unreadable: ${usage.reason}`);
      log.error('turn returned 200 with unusable usage; reservation HELD', { reason: usage.reason });
      return 'The answer could not be accounted for, so nothing has been settled yet. This has been logged and will be reconciled — your balance is not affected right now.';
    }

    const actual = tokensToMicroUsd(BigInt(usage.inputTokens), priceRow.inputPricePerMe9, MARGIN_E6)
                 + tokensToMicroUsd(BigInt(usage.outputTokens), priceRow.outputPricePerMe9, MARGIN_E6);

    const settled = settle(db, res.reservationId, isFree ? 0n : actual, {
      note: `${row.model} in=${usage.inputTokens} out=${usage.outputTokens} counted=${counted}`,
    });

    if (settled.overran) {
      log.error('SETTLE OVERRAN THE RESERVATION -- billed in full, not clamped', {
        model: row.model, reserved: String(settled.reserved), actual: String(settled.actual),
        ratio: settled.ratio, counted,
      });
    }

    // Reset the breaker on any completed turn.
    kvSetJson(db, 'breaker', { consecutiveUnknown: 0, openUntil: 0 });

    const answer = (Array.isArray(resp.content) ? resp.content : [])
      .filter((c) => c?.type === 'text')
      .map((c) => c.text)
      .join('\n')
      .trim();

    msgs.push({ role: 'assistant', content: answer });
    saveHistory(chatId, msgs);

    const cost = isFree ? 'free' : `$${microUsdToString(actual, 6)}`;
    return `${escapeHtml(answer) || '(the model returned no text)'}\n\n<i>${escapeHtml(cost)} · ${usage.inputTokens} in / ${usage.outputTokens} out</i>`;
  } catch (e) {
    if (e instanceof UpstreamError) {
      if (e.bucket === Bucket.PERMANENT || e.bucket === Bucket.BACKOFF || e.bucket === Bucket.NOT_BILLED) {
        release(db, res.reservationId, `${e.bucket}: ${e.message}`);
        log.warn('turn released in full', { bucket: e.bucket, err: e.message });
        if (e.bucket === Bucket.BACKOFF) {
          return 'The model service is queueing requests right now. <b>Nothing has been charged.</b> Please try again in a moment.';
        }
        return 'That turn could not be run. <b>Nothing has been charged.</b> If it keeps happening, please report it.';
      }
      // UNKNOWN: it MAY have run. Hold, and never retry.
      hold(db, res.reservationId, `unknown: ${e.message}`);
      const b = kvGetJson(db, 'breaker') ?? { consecutiveUnknown: 0, openUntil: 0 };
      b.consecutiveUnknown = (b.consecutiveUnknown ?? 0) + 1;
      if (b.consecutiveUnknown >= 3) b.openUntil = nowSec() + 300;
      kvSetJson(db, 'breaker', b);
      log.error('turn ended in an UNKNOWN state; reservation held', { err: e.message });
      return 'We lost contact with the model part-way through, so we cannot tell whether your answer was generated. Nothing has been settled; the amount is held and will be released automatically if no usage is recorded. Please do not resend immediately.';
    }
    release(db, res.reservationId, `internal: ${e.message}`);
    throw e;
  } finally {
    stopTyping();
  }
}

// ---------------------------------------------------------------------------
// A STREAMED turn.
//
// The streamed path is preferred for every paid turn because of one property
// that the non-streamed path cannot have: `message_start` gives the EXACT input
// token count BEFORE any output is generated, so an under-quoted input can be
// stopped instead of discovered on the bill. Everything else here follows from
// that, plus the rule that a settle which overruns is billed IN FULL and never
// clamped -- so it is worth a great deal to not overrun in the first place.
// ---------------------------------------------------------------------------
async function runTurnStreamed({ chatId, updateId, row, upstream, priceRow, isFree, quote, resv, counted, quotedInputTokens }) {
  const draft = new DraftStream(tg, chatId, draftIdFor(updateId), { canStop: true });
  const stopper = new AbortController();
  activeStreams.set(chatId, stopper);

  // KEEP THE PER-USER LOCK FRESH WHILE WORK IS GENUINELY HAPPENING.
  //
  // busy_at goes stale after 180s so a crashed process cannot wedge a user out
  // forever. But a turn that runs LONGER than that would have its own lock
  // expire underneath it, letting the same user start a SECOND concurrent turn
  // -- two reservations, two bills, and two streams writing over each other's
  // draft. Refreshing the stamp is what distinguishes "still working" from
  // "died holding the lock": a dead process stops refreshing and the lock ages
  // out on schedule.
  const lockTimer = setInterval(() => {
    try { db.prepare('UPDATE users SET busy_at = ? WHERE chat_id = ?').run(nowSec(), chatId); }
    catch (e) { log.warn('could not refresh the per-user lock', errFields(e)); }
  }, 60000);

  // An empty first frame renders as Telegram's own "Thinking..." placeholder,
  // which is a better opening than a blank bubble while the prompt is read.
  await draft.push('');

  // OUR OWN stop control, on a real message.
  //
  // Telegram's native can_stop button rides on the draft, and whether a client
  // renders it is outside our control -- so this does not depend on it. It
  // appears only after the turn has run for a few seconds, so a fast answer
  // never grows an extra bubble, and it is removed the moment the turn ends.
  let controlMsgId = null;
  const controlTimer = setTimeout(async () => {
    try {
      const r = await tg.sendMessage(chatId, '<i>Generating…</i>', {
        reply_markup: { inline_keyboard: [[{ text: '⏹ Stop', callback_data: `stop:${chatId}` }]] },
      });
      if (r.ok) controlMsgId = r.result?.message_id ?? null;
    } catch (e) { log.debug('stop control failed to send', errFields(e)); }
  }, STOP_BUTTON_AFTER_MS);

  const clearControl = async () => {
    clearTimeout(controlTimer);
    if (controlMsgId === null) return;
    // Best effort: a leftover control is untidy, never harmful.
    try { await tg.call('deleteMessage', { chat_id: chatId, message_id: controlMsgId }); }
    catch (e) { log.debug('stop control could not be removed', errFields(e)); }
    controlMsgId = null;
  };

  let text = '';
  let exactInput = null;
  let usage = null;
  let streamError = null;
  let stage = StreamStage.NOTHING;
  let aborted = false;
  let overranInput = false;
  let earlyAbortWarned = false;
  // Per-turn telemetry. Without it, "was it incremental?" can only be answered
  // by guessing from token counts -- which is how this question came up.
  const tStart = Date.now();
  let sseFrames = 0;
  let firstTextMs = null;

  try {
    for await (const ev of streamMessages(oona, upstream, { abortSignal: stopper.signal })) {
      if (ev.type === 'input') {
        exactInput = ev.inputTokens;
        stage = StreamStage.INPUT_KNOWN;

        if (!isFree && Number.isInteger(exactInput)) {
          // THE EARLY ABORT -- the one thing that STOPS an overrun rather than
          // discovering it on the bill. It only works when message_start
          // actually carries the input count.
          const inputCost = tokensToMicroUsd(BigInt(exactInput), priceRow.inputPricePerMe9, MARGIN_E6);
          if (inputCost > resv.microUsd) {
            overranInput = true;
            log.error('input exceeded the reservation; aborting before any output', {
              model: row.model, exactInput, reserved: String(resv.microUsd), inputCost: String(inputCost),
            });
            stopper.abort();
            continue;
          }
        } else if (!isFree && !earlyAbortWarned) {
          // This gateway sends input_tokens: 0 in message_start and the real
          // count only in message_delta, so the guard above can never fire
          // here. Say so ONCE rather than leave a dead check looking live.
          earlyAbortWarned = true;
          log.warn('message_start carried no usable input count; the early-abort guard is INERT on this gateway '
            + '-- an under-quoted input can only be caught at settle time, where it is billed in full');
        }
        if (ev.cacheRead !== 0 || ev.cacheCreation !== 0) {
          log.error('gateway cached without being asked; billing blind on this model',
            { model: row.model, read: ev.cacheRead, write: ev.cacheCreation });
        }
      } else if (ev.type === 'text') {
        // The marker goes on AFTER the provider's counts are taken, so it can
        // never affect what anybody is billed.
        sseFrames++;
        if (firstTextMs === null) firstTextMs = Date.now() - tStart;
        text += ev.delta + CHUNK_MARKER;
        await draft.maybePush(escapeHtml(text));
      } else if (ev.type === 'usage') {
        usage = ev;
        stage = StreamStage.COMPLETE;
      } else if (ev.type === 'error') {
        streamError = ev.error;
      } else if (ev.type === 'end') {
        stage = ev.stage;
        aborted = !!ev.aborted;
      }
    }
  } catch (e) {
    clearInterval(lockTimer);
    activeStreams.delete(chatId);
    await clearControl();
    // On the error path there IS no final message to protect, so clearing the
    // half-written preview is the right thing.
    await draft.clear();
    throw e; // an UpstreamError: the caller's bucket handling owns it
  }
  clearInterval(lockTimer);
  activeStreams.delete(chatId);
  await clearControl();

  // THE DRAFT IS DELIBERATELY NOT CLEARED HERE.
  //
  // Clearing empties it, so the streamed text VANISHES -- and the real message
  // is not sent until the caller has rendered any SVG (a rasterise plus a photo
  // upload, which can take seconds) and returned. The user watched their answer
  // disappear and then reappear as a new message.
  //
  // So: leave the finished text standing, let the CALLER send the real message,
  // and clear only afterwards. One last forced push makes sure what is left on
  // screen is the complete answer rather than the last throttled frame.
  try { await draft.push(escapeHtml(text)); }
  catch (e) { log.debug('final draft push failed', errFields(e)); }

  log.info('stream telemetry', {
    model: row.model,
    sse_frames: sseFrames,
    telegram_frames: draft.pushes,
    throttled_out: Math.max(0, draft.offered - draft.pushes),
    first_text_ms: firstTextMs ?? -1,
    total_ms: Date.now() - tStart,
    chars: text.length,
    stage,
    aborted,
  });

  // --- settle ---------------------------------------------------------------
  //
  // Three recoverable levels, and which one applies is decided by how far the
  // stream got -- NOT by whether the text looks finished.
  const outTokens = usage && Number.isInteger(usage.outputTokens) ? usage.outputTokens : null;
  const inTokens = (usage && Number.isInteger(usage.inputTokens)) ? usage.inputTokens : exactInput;

  if (stage === StreamStage.COMPLETE && Number.isInteger(inTokens) && Number.isInteger(outTokens)) {
    // Usage is complete and authoritative. Settle normally -- and note this is
    // true even if message_stop never arrived.
    const actual = isFree ? 0n
      : tokensToMicroUsd(BigInt(inTokens), priceRow.inputPricePerMe9, MARGIN_E6)
      + tokensToMicroUsd(BigInt(outTokens), priceRow.outputPricePerMe9, MARGIN_E6);
    const settled = settle(db, resv.reservationId, actual, {
      note: `stream ${row.model} in=${inTokens} out=${outTokens} counted=${counted}${aborted ? ' aborted' : ''}`,
    });
    if (settled.overran) {
      log.error('STREAM SETTLE OVERRAN THE RESERVATION -- billed in full, not clamped', {
        model: row.model, reserved: String(settled.reserved), actual: String(settled.actual), ratio: settled.ratio,
      });
    }
    return { text, actual, stopReason: usage.stopReason, aborted, overranInput, settled , draft };
  }

  // If message_start gave no usable count, fall back to what the turn was
  // QUOTED on. Settling a long prompt as though its input were zero would
  // under-charge by exactly the amount that matters most.
  const inputForTruncated = Number.isInteger(exactInput) ? exactInput : quotedInputTokens;

  if (stage === StreamStage.INPUT_KNOWN && Number.isInteger(inputForTruncated)) {
    // Died (or was stopped) after message_start but before message_delta. The
    // INPUT is known exactly; the output is not. Settle on the input plus the
    // output we actually received, and HOLD nothing back from the user -- but
    // record that the figure is reconstructed, because the nightly console
    // check is what settles whether it was right.
    const seen = BigInt(Math.ceil(text.length / 4)); // a floor-ish reconstruction
    const actual = isFree ? 0n
      : tokensToMicroUsd(BigInt(inputForTruncated), priceRow.inputPricePerMe9, MARGIN_E6)
      + tokensToMicroUsd(seen, priceRow.outputPricePerMe9, MARGIN_E6);
    const settled = settle(db, resv.reservationId, actual, {
      note: `stream TRUNCATED ${row.model} in=${inputForTruncated}${Number.isInteger(exactInput) ? '' : '(quoted)'} out~=${seen} reconstructed${aborted ? ' aborted' : ''}`,
    });
    log.warn('stream ended without usage; settled on a reconstructed figure', {
      model: row.model, input: inputForTruncated, inputExact: Number.isInteger(exactInput),
      reconstructed: String(seen),
    });
    return { text, actual, stopReason: null, aborted, overranInput, settled, reconstructed: true , draft };
  }

  // Died before message_start. Most likely nothing was generated -- but "most
  // likely" is not "certainly", and an UNKNOWN is HELD, never released.
  hold(db, resv.reservationId, `stream died before message_start${streamError ? `: ${JSON.stringify(streamError).slice(0, 120)}` : ''}`);
  log.error('stream produced no usage at all; reservation HELD', { model: row.model, aborted });
  return { text, actual: null, stopReason: null, aborted, overranInput, held: true , draft };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------
const COMMANDS = new Set([
  '/start', '/help', '/models', '/model', '/balance', '/topup',
  '/pcn', '/topup_pcn', '/wpcn', '/topup_wpcn', '/clear',
  '/apikey', '/apikeys', '/revoke', '/api', '/stats', '/stop',
]);

async function handleMessage(msg) {
  // `from` CAN BE ABSENT -- channel posts and anonymous admins carry
  // sender_chat. State keyed on message.from.id would collide or crash.
  const chat = msg.chat;
  if (!chat || chat.type !== 'private') return;          // DM-only
  if (msg.from?.is_bot) return;                          // never answer a bot
  if (msg.is_automatic_forward) return;                  // nor our own announcements
  const chatId = chat.id;

  const text = typeof msg.text === 'string' ? msg.text.trim() : '';
  if (text === '') return;

  // DISPATCH ON EXACT MATCH OF THE FIRST TOKEN, so /topup_pcn cannot be
  // swallowed by /topup.
  const first = text.split(/\s+/)[0].split('@')[0];

  // Intercept a bare 0x + 64 hex ABOVE the AI handler even while wPCN is off.
  // Charging somebody for pasting a payment receipt is the worst possible
  // response to "here is my money".
  if (isTxHash(text)) {
    // Allow-listed users get a real verification; everybody else still must not
    // be charged for pasting a receipt.
    if (!ALLOWED_CHATS.has(chatId) && !ADMIN_CHATS.has(chatId)) {
      return 'This bot is not open yet. Thanks for your interest — it will be announced when it is.';
    }
    ensureUser(chatId);
    return handleTxHash(chatId, text);
  }

  const u = ensureUser(chatId);

  // THE ALLOW-LIST. Empty means the bot answers nobody -- that is the launch
  // gate, not a bug.
  if (!ALLOWED_CHATS.has(chatId) && !ADMIN_CHATS.has(chatId)) {
    if (COMMANDS.has(first)) {
      return 'This bot is not open yet. Thanks for your interest — it will be announced when it is.';
    }
    return null;
  }

  switch (first) {
    case '/start':
      return startScreen(u);
    case '/help':
      return `${startScreen(u)}\n\nPrices are per 1M tokens and include our margin. Reasoning tokens are billed as output. Use /models to see the current list.`;
    case '/balance':
      return balanceScreen(u);
    case '/clear':
      db.prepare('DELETE FROM conversations WHERE chat_id = ?').run(chatId);
      return 'Conversation cleared.';
    case '/stop': {
      // Works because the poll loop no longer awaits a turn -- this update is
      // read WHILE the stream it stops is still running.
      const ctrl = activeStreams.get(chatId);
      if (!ctrl) return 'Nothing is generating right now.';
      ctrl.abort();
      return 'Stopping. You are billed for what was generated up to that point.';
    }
    case '/models':
    case '/model': {
      // `/model <name>` sets it directly -- a typed fallback for anyone whose
      // client will not render an inline keyboard, and the only path that works
      // if a keyboard is ever stale.
      const wanted = text.slice(first.length).trim();
      if (wanted !== '') return setModel(chatId, wanted).msg;
      const m = modelsScreen();
      await tg.sendMessage(chatId, m.text, m.keyboard ? { reply_markup: m.keyboard } : {});
      return null;
    }
    case '/pcn':
    case '/topup_pcn': {
      // The QR goes FIRST, with a short caption carrying the address itself --
      // a caption is capped at 1024 where a message is 4096, so the full detail
      // follows as its own message rather than being truncated.
      let alloc = null;
      try { alloc = allocateAddress(db, chatId); } catch { /* depositScreen reports it properly */ }
      if (alloc) {
        try {
          const png = await depositQr(alloc.address);
          await tg.sendPhoto(chatId, png, {
            filename: `pcn-${alloc.address.slice(0, 10)}.png`,
            caption: `<b>Your PCN deposit address</b>
<code>${escapeHtml(alloc.address)}</code>

Scan or copy. It is yours permanently.`,
          });
        } catch (e) {
          // A QR that fails to render must never cost the user the address.
          log.warn('QR render/send failed; sending the address as text only', errFields(e));
        }
      }
      return depositScreen(chatId);
    }
    case '/topup': {
      if (!WPCN_ENABLED) return depositScreen(chatId);
      await tg.sendMessage(chatId,
        '<b>How would you like to top up?</b>\n\n'
        + '/topup_pcn — send PCN on the PCoin chain\n'
        + '/topup_wpcn — send wPCN on BNB Smart Chain (credits the same)');
      return null;
    }
    case '/wpcn':
    case '/topup_wpcn':
      return wpcnScreen();
    case '/stats': {
      if (!ADMIN_CHATS.has(chatId)) return 'That command does not exist here. Try /help.';
      const st = poolStats(db);
      const dep = db.prepare("SELECT status, COUNT(*) n FROM pcn_deposits GROUP BY status").all();
      const sm = sellableModels();
      return [
        '<b>Rail status</b>',
        `pool: ${st.issued} issued / ${st.total} (free ${st.free}, index ${st.minIndex}-${st.maxIndex})`,
        `deposits: ${dep.length ? dep.map((d) => `${d.status}=${d.n}`).join(' ') : 'none yet'}`,
        `models sellable: ${sm.expired ? 'PRICE TABLE EXPIRED' : sm.models.length}`,
        `wPCN: ${WPCN_ENABLED ? 'enabled' : 'off'}`,
      ].join(NEWLINE);
    }
    case '/api':
      return apiHelpScreen();
    case '/apikeys':
      return apiKeysScreen(chatId);
    case '/apikey': {
      if (!API_BASE_PUBLIC) return 'The HTTP API is not enabled on this deployment.';
      let key;
      try {
        key = issueKey(db, chatId, { name: text.slice('/apikey'.length).trim() || null });
      } catch (e) {
        return escapeHtml(e.message);
      }
      // SHOWN ONCE. Only a hash is stored, so this cannot be recovered later.
      await tg.sendMessage(chatId,
        '<b>Your new API key</b>' + NEWLINE + NEWLINE
        + `<code>${escapeHtml(key)}</code>` + NEWLINE + NEWLINE
        + '<b>Copy it now — it is shown once and cannot be recovered.</b> '
        + 'It spends the same balance as this chat. Treat it like a password; /revoke it if it leaks.'
        + NEWLINE + NEWLINE + 'See /api for how to use it.');
      return null;
    }
    case '/revoke': {
      const prefix = text.slice('/revoke'.length).trim();
      if (!prefix) return 'Usage: <code>/revoke &lt;prefix&gt;</code> — see /apikeys for the prefixes.';
      const n = revokeKey(db, chatId, prefix);
      return n > 0
        ? `Revoked <code>${escapeHtml(prefix)}…</code>. It will stop working immediately.`
        : 'No active key of yours has that prefix. See /apikeys.';
    }
    default:
      break;
  }

  // A DEAD COMMAND MUST NEVER FALL THROUGH TO THE AI HANDLER. Telegram caches
  // the per-chat command menu and only refreshes it on that user's next
  // /start, so an unregistered command would otherwise be BILLED AS A TURN.
  if (first.startsWith('/')) {
    return 'That command does not exist here. Try /help.';
  }

  let unlock;
  try {
    unlock = acquireUserLock(db, chatId);
  } catch (e) {
    if (e instanceof Busy) return 'Your previous message is still being answered — one at a time, please.';
    throw e;
  }
  try {
    return await runTurn(chatId, msg.__update_id, text);
  } finally {
    unlock();
  }
}

// ---------------------------------------------------------------------------
// The poll loop
// ---------------------------------------------------------------------------
const HEARTBEAT = cfg.strOr('BOT_HEARTBEAT_FILE', '/var/lib/pcnaibot/bot-heartbeat.json');

async function writeBotHeartbeat(fields) {
  const { writeFileSync, renameSync } = await import('node:fs');
  const payload = JSON.stringify({ at: nowSec(), ...fields });
  try {
    writeFileSync(`${HEARTBEAT}.tmp`, payload);
    renameSync(`${HEARTBEAT}.tmp`, HEARTBEAT);
  } catch (e) { log.warn('could not write bot heartbeat', errFields(e)); }
}

// The tap-to-select menu.
//
// Registered with BotCommandScopeAllPrivateChats, and the ADMIN list is a
// SEPARATE per-chat scope -- a single global list would show admin commands to
// everybody, which is both confusing and an invitation.
//
// Telegram CACHES this list per chat and only refreshes it on that user's next
// /start, which is why every command the bot answers must stay registered even
// when it is a stub: an UNREGISTERED command does not fail politely, it falls
// through to the AI handler and is BILLED TO THE USER AS A TURN.
const PUBLIC_COMMANDS = [
  { command: 'start',      description: 'What this is, and your balance' },
  { command: 'models',     description: 'Choose a model, with live prices' },
  { command: 'balance',    description: 'Balance, reserved, recent activity' },
  { command: 'topup',      description: 'Add credit with PCN or wPCN' },
  { command: 'topup_pcn',  description: 'Deposit address + QR (PCN)' },
  { command: 'topup_wpcn', description: 'Pay with wPCN on BNB Smart Chain' },
  { command: 'apikey',     description: 'Create an API key for use outside Telegram' },
  { command: 'apikeys',    description: 'List your API keys' },
  { command: 'revoke',     description: 'Revoke an API key by its prefix' },
  { command: 'api',        description: 'How to call the API' },
  { command: 'stop',       description: 'Stop the answer being generated' },
  { command: 'clear',      description: 'Clear this conversation' },
  { command: 'help',       description: 'How it works' },
];

const ADMIN_EXTRA = [
  { command: 'stats', description: 'Admin: rail status' },
];

async function publishCommands() {
  const r = await tg.setMyCommands(PUBLIC_COMMANDS, { type: 'all_private_chats' });
  if (!r.ok) log.warn('setMyCommands (public) failed', { desc: r.description });
  else log.info('command menu published', { count: PUBLIC_COMMANDS.length });

  // Admin commands are scoped to each admin's own chat, never global.
  for (const id of ADMIN_CHATS) {
    const a = await tg.setMyCommands([...PUBLIC_COMMANDS, ...ADMIN_EXTRA], { type: 'chat', chat_id: id });
    if (!a.ok) log.warn('setMyCommands (admin scope) failed', { desc: a.description });
  }
}

async function main() {
  const me = await tg.getMe();
  if (!me.ok) { log.error('getMe failed; refusing to start', { desc: me.description }); process.exit(1); }
  // Verify privacy mode from getMe, NOT from the BotFather screen.
  log.info('bot identity', {
    username: me.result.username,
    can_read_all_group_messages: me.result.can_read_all_group_messages,
  });
  if (me.result.can_read_all_group_messages === true) {
    log.warn('PRIVACY MODE IS OFF -- this bot would see every message in any group it is added to. Turn it ON in BotFather.');
  }

  await publishCommands();

  await refreshPrices();

  // PROBE BEFORE SELLING ANYTHING. /v1/models is not authoritative for
  // reachability -- all three Claude models are listed and refuse at call time
  // -- and nothing anywhere says whether a model honours max_tokens. Both are
  // only knowable by asking. Costs a few hundredths of a cent.
  const probes = await probeAll(db, oona, ALLOWLIST_MODELS);
  const usable = probes.filter((p) => p.ok === true && p.bounded === true).map((p) => p.model);
  log.info('model probe complete', {
    usable: usable.join(',') || '(none)',
    refused: probes.filter((p) => p.ok === false).map((p) => p.model).join(',') || '-',
    unbounded: probes.filter((p) => p.bounded === false).map((p) => p.model).join(',') || '-',
  });
  if (usable.length === 0) {
    log.error('refusing to start: not one allow-listed model is both callable and bounded');
    process.exit(1);
  }

  setInterval(() => refreshPrices().catch((e) => log.error('price refresh failed', errFields(e))),
    cfg.int('REGISTRY_REFRESH_SECONDS', 600) * 1000);
  // Re-probe daily: a provider can change a credential or a model's behaviour
  // under us, and the registry will not mention it.
  setInterval(() => probeAll(db, oona, ALLOWLIST_MODELS).catch((e) => log.error('probe failed', errFields(e))),
    86400 * 1000);
  setInterval(() => {
    try { ageOutReservations(db, { olderThanMinutes: cfg.int('RESERVATION_AGE_OUT_MINUTES', 60) }); }
    catch (e) { log.error('age-out failed', errFields(e)); }
  }, 300000);

  let offset = (kvGetJson(db, 'tg:offset') ?? { offset: 0 }).offset;
  let processed = 0;

  for (;;) {
    const res = await tg.getUpdates(offset, { timeout: 30 });
    if (!res.ok) {
      if (res.errorCode === 409) {
        // TWO CONSUMERS STEAL EACH OTHER'S UPDATES AND EACH SEES HALF A
        // CONVERSATION. Report loudly rather than retrying -- retrying is what
        // makes the two of you fight.
        log.error('409 from getUpdates: ANOTHER CONSUMER IS POLLING THIS TOKEN. Not retrying.');
        process.exit(1);
      }
      log.warn('getUpdates failed', { desc: res.description, unknown: !!res.unknown });
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }

    for (const up of res.result) {
      offset = up.update_id + 1;

      // CLAIM BEFORE WORK. This turns at-least-once DELIVERY into at-most-once
      // WORK, and it must happen before the expensive call, never after.
      const claim = db.prepare('INSERT OR IGNORE INTO tg_updates (update_id, claimed_at) VALUES (?,?)')
        .run(up.update_id, nowSec());
      if (claim.changes !== 1) {
        log.info('update already claimed; skipping', { update: up.update_id });
        continue;
      }
      // Advance the offset only AFTER the claim is durable.
      kvSetJson(db, 'tg:offset', { offset });

      // THE STOP BUTTON. `can_stop` on a draft gives the user a way to halt a
      // long answer; pressing it delivers this update (Bot API 10.3). Aborting
      // the stream is not a cancellation of the charge -- whatever was
      // generated was generated, and the settle reflects exactly that.
      if (up.stopped_message_generation) {
        const sc = up.stopped_message_generation?.chat?.id ?? null;
        const ctrl = sc === null ? null : activeStreams.get(sc);
        if (ctrl) {
          log.info('user stopped generation', { chat: chatTag(sc) });
          ctrl.abort();
        }
        continue;
      }

      // The /models keyboard. Answer the callback FIRST -- an unanswered
      // callback leaves a spinner on the user's button for a minute, which
      // reads as a hung bot even when the model was set correctly.
      if (up.callback_query) {
        const cq = up.callback_query;
        const cid = cq.message?.chat?.id ?? cq.from?.id ?? null;
        const data = typeof cq.data === 'string' ? cq.data : '';
        let toast = '';
        try {
          if (cid !== null && data.startsWith('stop:')) {
            const ctrl = activeStreams.get(cid);
            if (ctrl) { ctrl.abort(); toast = 'Stopping…'; log.info('user pressed the inline stop button', { chat: chatTag(cid) }); }
            else toast = 'Nothing is generating.';
          } else if (cid !== null && (ALLOWED_CHATS.has(cid) || ADMIN_CHATS.has(cid)) && data.startsWith('m:')) {
            ensureUser(cid);
            const r = setModel(cid, data.slice(2));
            toast = r.ok ? `Model: ${r.model}` : 'Not available';
            await tg.sendMessage(cid, r.msg);
          } else if (cid !== null) {
            toast = 'This bot is not open yet.';
          }
        } catch (e) {
          log.error('callback handler threw', errFields(e));
          toast = 'Something went wrong.';
        }
        try { await tg.call('answerCallbackQuery', { callback_query_id: cq.id, text: toast }); }
        catch (e) { log.warn('answerCallbackQuery failed', errFields(e)); }
        continue;
      }

      if (!up.message) continue;
      up.message.__update_id = up.update_id;

      // Wait for a slot, but NEVER for this particular turn to finish.
      if (inFlightTurns.size >= MAX_CONCURRENT_TURNS) {
        await Promise.race(inFlightTurns);
      }

      const msg = up.message;
      const task = (async () => {
        try {
          const reply = await handleMessage(msg);
          if (reply) await tg.sendLong(msg.chat.id, reply);
        } catch (e) {
          log.error('handler threw', errFields(e));
          try { await tg.sendMessage(msg.chat.id, 'Something went wrong handling that. It has been logged.'); }
          catch { /* best effort */ }
        }
      })();
      // Added before the .finally so the set can never be left holding a
      // settled promise, and errors are already handled inside the task -- an
      // unhandled rejection here would take the whole bot down.
      inFlightTurns.add(task);
      task.finally(() => inFlightTurns.delete(task));

      processed++;
    }

    await writeBotHeartbeat({ ok: true, processed, offset, in_flight: inFlightTurns.size, streaming: activeStreams.size, last_error: null });
  }
}

main().catch((e) => {
  log.error('bot exited', errFields(e));
  process.exit(1);
});
