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
import { TelegramClient, escapeHtml, splitMessage } from './lib/telegram.mjs';
import { readRate } from './lib/rate.mjs';
import { allocateAddress, poolStats, PoolEmpty } from './lib/pool.mjs';
import { creditedUsdLast30Days } from './lib/deposits.mjs';
import { microUsdToString, trimZeros, usdToPcnString, satsToPcnString, parseScaled } from './lib/money.mjs';
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
import { startAdminApi } from './lib/admin-api.mjs';
import QRCode from 'qrcode';
import { extractSvgs, svgToPng, unknownBlockTypes } from './lib/render.mjs';
import { newDeliverables, deliverFiles, noteUploaded } from './lib/deliver.mjs';
import { AgentClient, AgentUnavailable, AgentRefused, creditsToMicroUsd, runOutcome, stopNote } from './lib/agent.mjs';
import { liveSession, recordSession, setSessionModel, touchSession, retireSession, sweepDeletions, reconcileRemote } from './lib/agentstore.mjs';
import { pollAgentEvents } from './lib/lifecycle.mjs';
import { streamMessages, StreamStage } from './lib/stream.mjs';
import { mdToHtml } from './lib/markdown.mjs';
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
// OPEN_TO_ALL=1 answers everybody; ALLOWLIST_CHAT_IDS then no longer gates.
// Kept separate from the list so an empty list still means "nobody".
const OPEN_TO_ALL = cfg.bool('OPEN_TO_ALL', false);
const mayUse = (chatId) => OPEN_TO_ALL || ALLOWED_CHATS.has(chatId) || ADMIN_CHATS.has(chatId);
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

// ---- agentic mode --------------------------------------------------------
// A SEPARATE KEY. /v1/messages keys are refused by the agent API with a clear
// 403 ("this is an API key for /v1/messages"), and vice versa.
const AGENT_ENABLED = cfg.bool('AGENT_ENABLED', false);
const AGENT_MAX_TURNS = cfg.int('AGENT_MAX_TURNS', 12);
// Reasoning effort per model, "model:level,..." -- sent on each run. ONLY for models that take
// one: every other model answers 400 "takes no effort level" (probed 2026-09-25: only gpt-5 and
// gpt-5-mini accept it). gpt-5-mini at its default spent 27 s and 2,776 tokens thinking before a
// 369-character answer; at `low` the same question ran in 4.3 s instead of 10.4 s, for less.
const AGENT_EFFORT = new Map(cfg.list('AGENT_EFFORT').map((p) => p.split(':').map((s) => s.trim())).filter(([m, e]) => m && e));
// The reservation ceiling for one agentic run, in CREDITS. Unlike a plain turn
// there is no max_tokens to price a worst case from -- an agent may make many
// model calls -- so the ceiling is declared rather than derived, and max_turns
// is what actually bounds it. Measured: a trivial run costs 1.1-2.7 credits.
const AGENT_MAX_CREDITS = cfg.num('AGENT_MAX_CREDITS_PER_RUN', 400);
const agent = (() => {
  if (!AGENT_ENABLED) return null;
  const k = cfg.strOr('OONACODE_AGENT_KEY', null);
  if (!k) { log.warn('AGENT_ENABLED but no OONACODE_AGENT_KEY; agentic mode is off'); return null; }
  return new AgentClient(cfg.strOr('OONACODE_BASE', 'https://api.oonacode.oonak.ai'), k);
})();

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
  // agent_mode is set EXPLICITLY rather than left to the column default. The
  // default is 0 for historical reasons and cannot be changed in SQLite without
  // rebuilding the table -- and a new user silently arriving in the wrong mode
  // is precisely the bug that produced this comment.
  db.prepare('INSERT INTO users (chat_id, model, agent_mode, created_at) VALUES (?,?,?,?)')
    .run(chatId, DEFAULT_MODEL, agent ? 1 : 0, nowSec());
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
const ONE_WAY = 'Deposits are <b>one-way</b>: PCN in, credit out. Balances are held in <b>USD</b>, are not withdrawable, and are not refundable.';

// THE MENU: a keyboard that stays under the composer, so the current model is always on screen
// (owner, 2026-09-14: "user should see the current selected model … always visible"). The top
// button IS the model; tapping it opens the chooser. Telegram sends a tapped button's text as a
// message, so `quickAction` turns those texts back into screens before anything can be billed.
// The keyboard is re-sent with every answer and every model change, which is how it stays current.
const QUICK = {
  balance: '💳 Balance', topup: '➕ Top up', clear: '🆕 New chat', help: '❓ How it works',
};
function quickKeyboard(u) {
  return {
    keyboard: [
      [{ text: `🧠 Model: ${u.model}` }],
      [{ text: QUICK.balance }, { text: QUICK.topup }],
      [{ text: QUICK.clear }, { text: QUICK.help }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}
function quickAction(text) {
  if (text.startsWith('🧠 Model:')) return 'models';
  for (const [k, v] of Object.entries(QUICK)) if (text === v) return k;
  return null;
}
const BACK_KEYBOARD = { inline_keyboard: [[{ text: '« Menu', callback_data: 'nav:start' }]] };

function startScreen(u) {
  return [
    '👋 <b>Hi! I am PCoin AI</b> — an AI agent you pay for in PCN.',
    '',
    '<b>What I can do</b>',
    '• Answer questions and chat, in any language',
    '• Read what you send me: photos, screenshots, documents, PDFs, spreadsheets, voice notes, audio and video',
    '• Write and run code, make pictures, charts, PDFs and files — and send them back to you here',
    '• Search the web and read pages for you',
    '• Remember our conversation until you start a new chat',
    '',
    `Model: <code>${escapeHtml(u.model)}</code> · Balance: <b>$${escapeHtml(trimZeros(microUsdToString(u.balance_micro_usd, 4)))}</b>`,
    GRANT_MICRO > 0
      ? `Free grant: <b>$${escapeHtml(microUsdToString(u.grant_micro_usd, 4))}</b> — spendable on <b>free models only</b>.`
      : '',
    '',
    '<b>Just type a message to begin.</b> The buttons below stay with you: the top one shows the model in use — tap it to change. Send /stop to halt an answer that is being written.',
    '',
    `<i>${ONE_WAY}</i>`,
  ].filter(Boolean).join('\n');
}

function helpScreen() {
  return [
    '<b>How it works</b>',
    '',
    '• You talk to an <b>agent</b>: it keeps your conversation and files on the server and can use tools — run code, read the web, make files — not only answer.',
    '• Each message is billed by what the model actually used: tokens in and out, at the price shown in <b>Choose model</b> (per 1M tokens, our margin included). Reasoning tokens count as output.',
    `• One message can take up to <b>${AGENT_MAX_TURNS} steps</b>; a longer job stops there and continues when you say "continue".`,
    '• <b>Send files</b> as photos, documents, voice notes or videos, with a caption saying what to do. Files the agent makes come back as pictures or documents.',
    '• <b>Stop</b> an answer with /stop or the ⏹ button; you pay only for what was written.',
    '• <b>New chat</b> forgets the conversation and deletes its files from the server.',
    '• <b>Top up</b> by sending PCN to your own permanent address; credit lands after 3 confirmations.',
    '',
    ONE_WAY,
    'This is a service credit, not an account balance you can withdraw. We hold no keys for you and send no PCN.',
  ].join('\n');
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
      // The user is WAITING for an answer. Telling the admins is important but
      // it is not their problem: awaiting a send per admin chat delays the
      // person's own message by one Telegram timeout each, and if the admin
      // chat is unreachable they wait for all of them. Fire the alerts off and
      // answer the user now.
      for (const a of ADMIN_CHATS) {
        tg.sendMessage(a, 'The pcnaibot deposit address pool is EMPTY. New users cannot be given an address.')
          .catch(err => log.error('admin alert failed', errFields(err)));
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
  return {
    ok: true,
    model: row.model,
    msg: `Model set to <b>${escapeHtml(row.model)}</b> — ${escapeHtml(price)}.`
      + `

The conversation continues on the new model — its history and files are kept. Use <b>New chat</b> to start over.`,
  };
}

// One screen, sent with its buttons. The text is what the slash command would have returned;
// the keyboard is what makes it a menu.
async function sendScreen(chatId, html, keyboard = BACK_KEYBOARD) {
  const parts = splitMessage(html);
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1;
    await tg.sendMessage(chatId, parts[i], last && keyboard ? { reply_markup: keyboard } : {});
  }
}

// What each menu button (and its typed alias) shows. `null` from a handler means it sent its own
// messages. Shared by the slash commands and the inline buttons so the two can never drift.
async function showScreen(chatId, u, which) {
  switch (which) {
    case 'start':
      await sendScreen(chatId, startScreen(u), quickKeyboard(u));
      return null;
    case 'help':
      await sendScreen(chatId, helpScreen());
      return null;
    case 'balance':
      await sendScreen(chatId, balanceScreen(u), {
        inline_keyboard: [[{ text: '➕ Top up', callback_data: 'nav:topup' }, { text: '« Menu', callback_data: 'nav:start' }]],
      });
      return null;
    case 'models': {
      const m = modelsScreen();
      const rows = m.keyboard ? [...m.keyboard.inline_keyboard] : [];
      rows.push([{ text: '« Menu', callback_data: 'nav:start' }]);
      await tg.sendMessage(chatId, m.text, { reply_markup: { inline_keyboard: rows } });
      return null;
    }
    case 'topup': {
      if (!WPCN_ENABLED) return showScreen(chatId, u, 'topup_pcn');
      await tg.sendMessage(chatId, '<b>How would you like to top up?</b>', {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'PCN — on the PCoin chain', callback_data: 'nav:topup_pcn' }],
            [{ text: 'wPCN — on BNB Smart Chain', callback_data: 'nav:topup_wpcn' }],
            [{ text: '« Menu', callback_data: 'nav:start' }],
          ],
        },
      });
      return null;
    }
    case 'topup_pcn': {
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
      await sendScreen(chatId, await depositScreen(chatId));
      return null;
    }
    case 'topup_wpcn':
      await sendScreen(chatId, await wpcnScreen());
      return null;
    case 'clear': {
      db.prepare('DELETE FROM conversations WHERE chat_id = ?').run(chatId);
      // AND DELETE THE REMOTE SESSION. Dropping only our local history would
      // leave a sandbox, a workspace and a transcript on OonaCode's server
      // until it expired -- and the user would still be talking to the same
      // agent memory they just asked to clear.
      let text = 'New chat started — the previous conversation is forgotten.';
      if (agent) {
        const r = await retireSession(db, agent, chatId, { reason: '/clear' });
        if (r.had && !r.deleted) text += ' Its files on the server could not be confirmed deleted just now; that is retried automatically.';
        else if (r.had) text += ' Its files and transcript were deleted from the server.';
      }
      await sendScreen(chatId, text);
      return null;
    }
    default:
      return null;
  }
}

// What each model is FOR, so a user can choose without knowing the names (owner, 2026-09-24).
// `tag` rides on the button, which a phone cuts at ~30 characters; `desc` goes in the message
// above. Written from the registry's own figures on 2026-09-24 (speed = aaOutputTps/aaTtft,
// smarts = aaIntelligence/aaCoding, 📷 = supportsVision). A model missing here still sells,
// just without a description.
const MODEL_INFO = {
  'deepseek-v4.1-flash': { tag: '⚡ fastest', desc: 'Fastest by far, cheap and smart. Best pick for quick answers. Text only.' },
  'mimo-v2.5':           { tag: 'cheapest', desc: 'The cheapest. Fine for everyday chat and short questions. Text only.' },
  'gpt-5-mini':          { tag: '📷 cheap', desc: 'Cheap and reliable for simple tasks. Reads photos.' },
  'qwen3.8-flash':       { tag: '📷 cheap', desc: 'Cheap, reads photos and documents. Can be slow on long tasks.' },
  'glm-5.3-flash':       { tag: '📷 cheap, smart', desc: 'Cheap and surprisingly smart, good at code. Reads photos. Slow to start.' },
  'deepseek-v4-flash':   { tag: 'code', desc: 'Cheap and good at code. Text only. The newer v4.1-flash is faster.' },
  'deepseek-v4-pro':     { tag: 'reasoning', desc: 'Strong reasoning and code at a mid price. Text only.' },
  'glm-5.3':             { tag: 'smart, code', desc: 'Very smart and great at code, for harder problems.' },
  'gpt-5':               { tag: '📷 premium', desc: 'Strong all-rounder for writing and analysis. Reads photos. Premium price.' },
  'qwen3.8-max':         { tag: '📷 smartest', desc: 'The smartest and best at code, reads photos. The most expensive and slowest.' },
};

function modelsScreen() {
  const s = sellableModels();
  if (s.expired) {
    return { text: 'Model prices are not available right now, so paid models are temporarily closed. Free models still work.', keyboard: null };
  }
  const lines = [];
  const rows = s.models.map((m) => {
    let price;
    if (FREE_TO_USER.has(m.model)) {
      price = 'FREE';
    } else {
      // The price shown is the price CHARGED, mirror included -- a menu that
      // advertised the vendor's 0 while the turn debited a balance would be the
      // deposit-screen-vs-oracle mismatch all over again.
      const c = chargePriceFor(db, m, PRICE_MIRRORS);
      const inUsd = trimZeros((Number(c.inputPerM) * Number(cfg.num('MARGIN', 3))).toFixed(4));
      const outUsd = trimZeros((Number(c.outputPerM) * Number(cfg.num('MARGIN', 3))).toFixed(4));
      price = `$${inUsd} / $${outUsd} per 1M`;
    }
    const info = MODEL_INFO[m.model];
    lines.push(`<b>${escapeHtml(m.model)}</b> — ${info ? escapeHtml(info.desc) + ' ' : ''}<i>${escapeHtml(price)}</i>`);
    return [{ text: info ? `${m.model} · ${info.tag}` : m.model, callback_data: `m:${m.model}` }];
  });
  return {
    text: '<b>Choose a model.</b>\n\n' + lines.join('\n\n')
      + '\n\n<i>Prices are per 1M tokens, input / output, and include our margin. Reasoning tokens are billed as output. 📷 = reads photos.</i>',
    keyboard: rows.length ? { inline_keyboard: rows } : null,
  };
}

// A ledger row as a person reads it: WHAT it was (the model for a turn, the rail for a deposit)
// and WHEN, not the row's kind tag (owner, 2026-09-14: "ai_turn is ugly, show the model name").
// The model is read off the settle note, which the billing path writes as "agent <model> …",
// "stream <model> …" or "<model> in=…".
function ledgerLabel(l) {
  if (l.kind === 'ai_turn') {
    const words = String(l.note ?? '').trim().split(/\s+/);
    const model = words[0] === 'agent' || words[0] === 'stream' ? words[1] : words[0];
    return model ? `<code>${escapeHtml(model)}</code>` : 'a turn';
  }
  if (l.kind === 'deposit_pcn') return 'PCN deposit';
  if (l.kind === 'deposit_wpcn') return 'wPCN deposit';
  if (l.kind === 'grant') return 'free grant';
  return 'adjustment';
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function whenLabel(sec) {
  const d = new Date(sec * 1000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${hh}:${mm}`;
}

function balanceScreen(u) {
  const led = db.prepare('SELECT * FROM ledger WHERE chat_id=? ORDER BY id DESC LIMIT 10').all(u.chat_id);
  const lines = [
    `Balance: <b>$${escapeHtml(trimZeros(microUsdToString(u.balance_micro_usd, 4)))}</b>`,
    u.reserved_micro_usd > 0 ? `Reserved for a turn in flight: $${escapeHtml(microUsdToString(u.reserved_micro_usd, 4))}` : '',
    GRANT_MICRO > 0 ? `Free grant (free models only): $${escapeHtml(microUsdToString(u.grant_micro_usd, 4))}` : '',
    `Model: <code>${escapeHtml(u.model)}</code>`,
  ].filter(Boolean);
  if (u.balance_micro_usd < 0) {
    lines.push('', '<b>Your balance is negative.</b> A turn cost more than was reserved for it. Top up to continue.');
  }
  if (led.length) {
    lines.push('', '<b>Recent activity</b> <i>(times in UTC)</i>');
    for (const l of led) {
      const sign = l.delta_micro_usd >= 0 ? '+' : '−';
      lines.push(`· ${escapeHtml(whenLabel(l.created_at))} · ${ledgerLabel(l)} ${sign}$${escapeHtml(microUsdToString(Math.abs(l.delta_micro_usd), 4))}`);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// The AI turn.
// ---------------------------------------------------------------------------
async function runTurn(chatId, updateId, text, attachments = []) {
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
  // ONE reservation, whichever mode this is. Two reserve() calls with the same
  // update_id would be idempotent by design -- the second returns the first as
  // a duplicate -- and the turn would then be silently dropped.
  const isAgentic = !!(agent && u.agent_mode);
  const quote = isFree
    ? 0n
    : isAgentic
      // An agentic run has no max_tokens to price a worst case from: the agent
      // may make many model calls. The ceiling is declared instead, and
      // max_turns is what actually bounds it.
      ? creditsToMicroUsd(AGENT_MAX_CREDITS, MARGIN_E6, parseScaled)
      : quoteTurn({
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
      return `This turn could cost up to <b>$${escapeHtml(need)}</b> and your balance is $${escapeHtml(trimZeros(microUsdToString(e.available, 4)))}.\n\nTop up with /topup, or switch to a free model with /models.`;
    }
    throw e;
  }
  if (res.duplicate) {
    log.warn('duplicate reservation for an update we already claimed', { update: updateId });
    return null;
  }

  // THE AGENTIC PATH, when this chat has opted in.
  //
  // Settles from run.credits -- what the pool actually charged -- rather than
  // from a token count priced off an undocumented registry.
  if (isAgentic) {
    let r;
    let turnStartedAt = null;
    try {
      // RETRY A SANDBOX FAILURE. It is transient and common -- measured at
      // 0/5 then 6/8 within minutes as the provider worked on it -- and a
      // user should not have to resend their message because a container
      // did not start. A poisoned session is NOT retried into: it is replaced,
      // because one of those never recovers.
      // Files made before this moment belong to an earlier run (see newDeliverables' `since`);
      // the margin covers the sandbox's clock and the file API's second granularity.
      turnStartedAt = new Date(Date.now() - 15000).toISOString();
      r = await withSandboxRetry(() => runTurnAgentic({ chatId, updateId, model: row.model, text, resv: res, attachments }), chatId);
    } catch (e) {
      if (e instanceof AgentRefused) {
        release(db, res.reservationId, `agent refused: ${e.message}`);
        return `The agent refused that request. <b>Nothing has been charged.</b>

<i>${escapeHtml(e.message.slice(0, 200))}</i>`;
      }
      if (e instanceof AgentUnavailable) {
        release(db, res.reservationId, `agent unavailable: ${e.message}`);
        // A poisoned session never recovers -- replace it rather than let the
        // user retry into something that will fail forever.
        if (e.poisoned) {
          try { await retireSession(db, agent, chatId, { reason: 'poisoned session' }); }
          catch (e2) { log.warn('could not retire the poisoned session', errFields(e2)); }
          return 'That conversation could not be resumed, so it has been reset. <b>Nothing has been charged.</b> Please send your message again.';
        }
        return 'The agent service is busy or starting up. <b>Nothing has been charged.</b> Please try again in a moment.';
      }
      release(db, res.reservationId, `agent internal: ${e.message}`);
      throw e;
    }

    const { out } = r;

    if (!out.readable || out.running) {
      // We never saw a terminal run. It MAY still be running on their side --
      // their own docs say a dropped stream never stops a run -- so this is
      // UNKNOWN and is held, not released.
      hold(db, res.reservationId, `agent run never reported a terminal status`);
      log.error('agent run produced no terminal status; reservation HELD');
      return 'We lost contact with the agent part-way through. Nothing has been settled; the amount is held and released automatically if no usage is recorded.';
    }

    if (out.credits === null) {
      // `credits` is the ONLY cost signal here. Without it we cannot settle,
      // and inventing a number is exactly what this codebase refuses to do.
      hold(db, res.reservationId, 'agent run reported no credits');
      log.error('agent run had no credits field; reservation HELD', { status: out.status });
      return 'The agent finished but did not report what it cost, so nothing has been settled. This has been logged and will be reconciled.';
    }

    // A FAILED run still reports credits -- measured as 0 for a sandbox
    // failure. Settle whatever it actually charged, which for a failure is
    // usually nothing.
    const actual = creditsToMicroUsd(out.credits, MARGIN_E6, parseScaled);
    const settled = settle(db, res.reservationId, actual, {
      note: `agent ${row.model} status=${out.status} credits=${out.credits} requests=${out.modelRequests}`,
    });
    if (settled.overran) {
      log.error('AGENT SETTLE OVERRAN THE RESERVATION -- billed in full, not clamped',
        { reserved: String(settled.reserved), actual: String(settled.actual), credits: out.credits });
    }
    if (out.sessionId) touchSession(db, out.sessionId, { credits: out.credits, failed: !out.ok });

    const answer = (out.text || r.text || '').trim();

    // A STOPPED run is an answer that ends early, not a failure: the user asked for the stop,
    // the text so far is theirs, and whatever the agent wrote before the stop is delivered
    // below like any other output. Since 2026-09-14 the API reports it as `cancelled` with
    // `stop_reason: interrupted` and carries the partial text.
    if (out.failed) {
      const why = out.error?.message ? escapeHtml(String(out.error.message).slice(0, 180)) : 'the run failed';
      // The sandbox failing is their side and costs nothing; say so plainly
      // rather than leaving the user wondering what they paid for.
      return `${answer ? `${mdToHtml(answer)}\n\n` : ''}The agent could not finish: <i>${why}</i>

You were charged $${escapeHtml(microUsdToString(actual, 6))} for this.`;
    }

    const stop = stopNote(out, { maxTurns: AGENT_MAX_TURNS });
    const note = stop ? `\n\n<i>${escapeHtml(stop)}</i>` : '';

    // SENDING THIS IS WHAT ENDS THE DRAFT -- see the note where clear() used to
    // live in drafts.mjs. Nothing else is needed, and the empty-text push that
    // used to follow here is what put a "Thinking..." spinner under every answer.
    //
    // The answer is Markdown as the model wrote it; Telegram gets its HTML dialect.
    await tg.sendLong(chatId, (answer ? mdToHtml(answer) : (out.cancelled ? '<i>stopped before it wrote anything</i>' : '(the agent returned no text)')) + note, { reply_markup: quickKeyboard(u) });
    if (r.timing) {
      const t = r.timing; const ms = (x) => (x === null ? null : x - t.start);
      log.info('agent turn timing', {
        model: row.model, stream_ms: ms(t.stream), first_text_ms: ms(t.firstText),
        run_done_ms: ms(t.runDone), answer_sent_ms: Date.now() - t.start, chars: answer.length,
      });
    }

    // WHAT THE AGENT MADE, not just what it said about it.
    //
    // This is the difference between an assistant and a chat: asked for a logo
    // the agent installed an image library, worked around a sandbox with no
    // fontconfig, rendered a PNG and reported success -- and the user got a
    // paragraph of prose, because nothing ever looked in the workspace.
    //
    // It runs AFTER settlement and cannot change what anybody was charged: the
    // work is already paid for, so failing to deliver it costs the user money
    // for nothing, and that is the failure worth avoiding here.
    if (out.sessionId) {
      try {
        const produced = await newDeliverables(db, agent, out.sessionId, { since: turnStartedAt });
        if (produced && produced.length) {
          await deliverFiles(db, agent, tg, chatId, out.sessionId, produced);
        }
        if (produced?.left?.length) {
          const names = produced.left.slice(0, 8).map((n) => `<code>${escapeHtml(n)}</code>`).join(', ');
          await tg.sendMessage(chatId, `<i>${produced.left.length} more file(s) stayed in the workspace: ${names}${produced.left.length > 8 ? ', …' : ''}. Ask for one by name if you want it.</i>`);
        }
      } catch (e) {
        log.warn('could not deliver the files the agent produced', errFields(e));
      }
    }

    for (const svg of extractSvgs(answer).slice(0, 3)) {
      const png = await svgToPng(svg);
      if (!png) continue;
      try { await tg.sendPhoto(chatId, png, { filename: 'render.png', caption: 'Rendered from the SVG in the answer above.' }); }
      catch (e) { log.warn('could not send the rendered image', errFields(e)); }
    }
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

      // Sending the real message is itself what removes the draft, so the
      // streamed preview is replaced by the permanent answer in one step and
      // there is never a moment with neither on screen.
      const note = r.aborted && !r.overranInput ? '\n\n<i>stopped</i>'
        : (r.reconstructed ? '\n\n<i>the answer was cut short; billed on what was generated</i>' : '');
      await tg.sendLong(chatId, `${answer ? mdToHtml(answer) : '(the model returned no text)'}${note}`, { reply_markup: quickKeyboard(u) });

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
    return `${answer ? mdToHtml(answer) : '(the model returned no text)'}\n\n<i>${escapeHtml(cost)} · ${usage.inputTokens} in / ${usage.outputTokens} out</i>`;
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

// Tool names as a person would say them. The engine emits identifiers -- Read,
// Bash, Glob -- and "<i>Read…</i>" sitting above an answer is both meaningless
// to a reader and ugly.
//
// Anything unmapped falls back to a plain "Working…" rather than leaking an
// internal name into a stranger's chat.
const TOOL_VERBS = {
  Read: 'Reading', Write: 'Writing', Edit: 'Editing', MultiEdit: 'Editing',
  NotebookEdit: 'Editing', Bash: 'Running a command', BashOutput: 'Running a command',
  Glob: 'Looking through files', Grep: 'Searching', LS: 'Looking through files',
  WebFetch: 'Reading a page', WebSearch: 'Searching the web',
  TodoWrite: 'Planning', Task: 'Working', Agent: 'Working',
  // OonaCode's media tools (2026-09-25). They arrive MCP-prefixed -- mcp__oonacode__generate_image
  // -- and each takes a while (an image ~70 s, a video minutes), so the status says what and
  // roughly how long rather than a bare "Working".
  generate_image: 'Drawing the picture (about a minute)',
  generate_video: 'Making the video (a few minutes)',
  check_video: 'Finishing the video',
};
function toolVerb(name) {
  const bare = String(name).replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '');
  return TOOL_VERBS[name] ?? TOOL_VERBS[bare] ?? 'Working';
}

const SANDBOX_RETRIES = 3;
// 5 s, then 10 s, then 20 s: a gateway deploy restarts its sandbox service for about half a
// minute, and the old 4 + 8 s sat entirely inside that window (three failures, 07:21:45 to
// 07:21:50 on 2026-09-14, while the service was "Up 22 seconds").
const SANDBOX_BACKOFF_MS = 5000;

// Retry an agentic run through a sandbox failure.
//
// `agent_sandbox_failed` is the provider's own container not starting. It is
// transient: measured 0 of 5 at one moment and 6 of 8 twenty minutes later. A
// user should not have to resend because of it.
//
// A POISONED session is the exception. The first session created during
// testing had its first run fail with ECONNREFUSED and then EVERY subsequent
// run into it failed forever -- retrying there is an infinite loop, so it is
// retired and the next attempt starts a fresh one.
async function withSandboxRetry(fn, chatId) {
  let last = null;
  for (let attempt = 1; attempt <= SANDBOX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof AgentUnavailable)) throw e;
      last = e;
      if (e.poisoned) {
        try { await retireSession(db, agent, chatId, { reason: 'poisoned session' }); }
        catch (e2) { log.warn('could not retire a poisoned session', errFields(e2)); }
      }
      if (attempt < SANDBOX_RETRIES) {
        log.warn('agent sandbox failed; retrying', { attempt, code: e.code });
        await new Promise((r) => setTimeout(r, SANDBOX_BACKOFF_MS * 2 ** (attempt - 1)));
      }
    }
  }
  throw last;
}

// ---------------------------------------------------------------------------
// AN AGENTIC turn.
//
// The conversation, the workspace and the transcript live on OonaCode's side,
// addressed by a session id, so NO HISTORY IS SENT -- measured, input tokens
// grow ~20 per run rather than by the whole conversation.
//
// Billing settles from `run.credits`, which is what the pool actually charged.
// That is the one thing the plain /v1/messages path cannot do at all.
//
// THE SANDBOX IS FLAKY: `agent_sandbox_failed` hit 5 of ~11 runs when measured,
// and a session whose run failed that way can stay poisoned forever. So a
// failure replaces the session rather than retrying into it.
// ---------------------------------------------------------------------------
async function runTurnAgentic({ chatId, updateId, model, text, resv, attachments = [] }) {
  const draft = new DraftStream(tg, chatId, draftIdFor(updateId), { canStop: true });

  // What the user sees while the run works, declared BEFORE anything that renders it: these
  // used to sit below the attachment block that called render(), and `let` has no hoisting --
  // every photo or file sent to the bot crashed the turn with "Cannot access 'activity' before
  // initialization" (2026-09-14, the first photo the owner sent).
  let shown = '';
  let activity = null;
  let run = null;
  let sessionIdSeen = null;
  // ONE line of status, and ONLY while there is nothing better to show. The moment real text
  // arrives the status disappears: the answer is what the user is waiting for. The elapsed time
  // rides on the status so a long model call reads as progress rather than as a stall.
  const startedMs = Date.now();
  const elapsed = () => {
    const s = Math.floor((Date.now() - startedMs) / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  // HOLD THE FIRST SECONDS OF TEXT BACK FROM THE DRAFT. Telegram animates a draft's text as if
  // it were being typed, at its own pace -- about 50 characters a second in Telegram Web. A
  // short answer arrives from the model in one burst of ~1.5 s, so streaming it into the draft
  // made a finished answer spend another 4-6 s typing itself out (measured 2026-09-25: the run
  // done at +5.4 s, the text still growing at +9.7 s). The final sendMessage shows at once. So
  // text goes into the draft only once it has been arriving for TEXT_HOLD_MS -- an answer
  // short enough to finish inside that window is delivered whole, and a long one still streams.
  const TEXT_HOLD_MS = 2500;
  let textFirstAt = null;
  const holdingText = () => textFirstAt === null || Date.now() - textFirstAt < TEXT_HOLD_MS;
  const render = () => {
    if (shown !== '' && !holdingText()) return escapeHtml(shown);
    return `<i>${escapeHtml(activity ?? (shown !== '' ? 'Writing' : 'Thinking'))}… ${elapsed()}</i>`;
  };
  // Per-turn timings, logged when the turn ends: where a slow answer's seconds went.
  const timing = { start: startedMs, stream: null, firstText: null, runDone: null };
  // A Telegram draft expires after ~30 s of silence, and a single model call on a slow model
  // takes 40 s and more (measured 2026-09-14: qwen3.8-flash up to 43 s, glm-5.3 up to 127 s)
  // -- so the status vanished mid-call and the chat looked stuck ("it still thinking, why it
  // is so slow"). Re-push it every 15 s while the run works; it is the same line with the
  // clock moved on, and it stops the moment real text streams or the run ends.
  const keepalive = setInterval(() => {
    if (shown === '' || holdingText()) draft.push(render()).catch(() => undefined);
  }, 15000);

  // STOPPING MEANS INTERRUPTING THE RUN, NOT DROPPING THE STREAM. Aborting our fetch left the
  // run going on the server -- their docs: a dropped stream never stops a run -- so /stop and
  // the stop button "worked" while the agent kept working and billing, and the turn ended as
  // "we lost contact" with the money held. Now a stop asks the API to interrupt the run and
  // keeps reading until the run reports itself cancelled; the fetch is cut only if that never
  // comes. `stopper` is what every stop control reaches; `hardAbort` is the last resort.
  const stopper = new AbortController();
  const hardAbort = new AbortController();
  let stopRequested = false;
  let stopTarget = null;
  const requestStop = () => {
    stopRequested = true;
    if (!stopTarget) return; // the run.started event carries the session; it fires then
    const target = stopTarget;
    stopTarget = null; // once
    void agent.interrupt(target).then((ok) => {
      log.info('agent run interrupt requested', { chat: chatTag(chatId), ok });
      if (!ok) hardAbort.abort();
    });
    setTimeout(() => hardAbort.abort(), 45000).unref?.();
  };
  stopper.signal.addEventListener('abort', requestStop, { once: true });
  activeStreams.set(chatId, stopper);

  // KEEP THE PER-USER LOCK FRESH WHILE THE RUN WORKS (the streamed path does the same). busy_at
  // goes stale after 180 s; an agent run is often longer, and a lock that expired underneath it
  // let the same user start a second run -- two reservations, two drafts.
  const lockTimer = setInterval(() => {
    try { db.prepare('UPDATE users SET busy_at = ? WHERE chat_id = ?').run(nowSec(), chatId); }
    catch (e) { log.warn('could not refresh the per-user lock', errFields(e)); }
  }, 60000);

  await draft.push('');

  // A MODEL SWITCH KEEPS THE CONVERSATION (owner, 2026-09-25: "i changed model and history was
  // gone ... it should continue on previous session until user clears it"). A session keeps the
  // model it last ran on only when a run names none -- so every run below names the user's
  // current choice, OonaCode switches the same session to it (its host resumes the history on the
  // new model), and here the switch is only a note in our own row. It used to retire the session
  // and start a new one, which threw the whole conversation away on every switch.
  {
    const cur = liveSession(db, chatId);
    if (cur && cur.model !== model) {
      log.info('model changed; the session continues on the new model', { from: cur.model, to: model });
      try { setSessionModel(db, cur.session_id, model); }
      catch (e) { log.warn('could not record the model switch', errFields(e)); }
    }
  }

  let sess = liveSession(db, chatId);
  stopTarget = sess?.session_id ?? null;
  sessionIdSeen = sess?.session_id ?? null;

  // ATTACHMENTS GO IN BEFORE THE RUN THAT NEEDS THEM.
  //
  // The file lands in the session's workspace and its path is named in the message: that works
  // for every kind of file, every model (a vision model reads the image itself with its Read
  // tool; a text model reads what it can), and the agent can transform and send it back. (The
  // API also takes image and PDF content blocks since 2026-09-14; the workspace route is kept
  // because it is the one that covers documents, audio and video too.)
  //
  // A file needs a session to live in, so one is created explicitly here rather
  // than waiting for the run to make it. Their docs: creating a session "costs
  // nothing; the sandbox starts on the first run or file operation".
  let uploaded = [];
  const notFetched = [];
  if (attachments.length) {
    if (!sess) {
      const created = await agent.createSession({ model, title: `pcnaibot ${chatId}` });
      sess = recordSession(db, chatId, { sessionId: created.id, model });
      stopTarget = created.id;
      sessionIdSeen = created.id;
      log.info('session created for an upload', { session: created.id.slice(0, 8) });
    }
    activity = 'Reading your file';
    await draft.push(render());
    for (const a of attachments) {
      const dl = await tg.downloadFile(a.fileId);
      if (!dl.ok) {
        // Telegram lets a bot fetch at most 20 MB. Say so in the message rather than pretend
        // the file was never sent -- the agent would otherwise answer a question about a file
        // it cannot see.
        log.warn('could not download an attachment', { reason: dl.reason });
        notFetched.push(a.name);
        continue;
      }
      const up = await agent.uploadFile(sess.session_id, a.name, dl.buffer, a.contentType);
      if (up.ok) {
        uploaded.push({ name: up.path, size: up.size, kind: a.kind });
        // Write it down as OURS. It lands in the same listing as whatever the
        // agent goes on to produce, and without this the user's own photo
        // would be handed straight back to them as though it were a result.
        try { noteUploaded(db, sess.session_id, up.path, up.size); }
        catch (e) { log.warn('could not record an upload', errFields(e)); }
      }
      else log.warn('could not upload an attachment to the workspace', { status: up.status, reason: up.reason });
    }
    log.info('attachments uploaded', { count: uploaded.length, of: attachments.length });
  }

  // Name the paths in the message, because that is how the agent learns they
  // exist. Without this the file sits in the workspace unmentioned.
  let message = text;
  if (uploaded.length || notFetched.length) {
    const kinds = new Set(uploaded.map((u) => u.kind));
    const list = uploaded.map((u) => `${u.name} (${u.kind}, ${u.size} bytes)`).join(', ');
    const parts = [];
    if (uploaded.length === 1) parts.push(`I have uploaded a file to your workspace: ${list}.`);
    else if (uploaded.length > 1) parts.push(`I have uploaded these files to your workspace: ${list}.`);
    if (notFetched.length) parts.push(`(${notFetched.join(', ')} could not be fetched from Telegram — over its 20 MB limit for bots — so it is not in the workspace.)`);
    if (kinds.has('voice') || kinds.has('audio') || kinds.has('video') || kinds.has('video_note')) {
      parts.push('If you need what is said in a recording, extract or transcribe it with the tools you have (ffmpeg is installed) and say what you could not do.');
    }
    const ask = text || (kinds.has('photo') || kinds.has('sticker')
      ? 'Please look at it and describe what you see.'
      : 'Please look at it and tell me what it contains.');
    message = `${parts.join('\n')}\n\n${ask}`;
  }
  // The agent cannot see this bot, so it does not know that what it saves is delivered: asked
  // for a picture it made one and then said "I can't transmit files anywhere from here"
  // (2026-09-14). Since 2026-09-25 this rides as the run's SYSTEM instructions (OonaCode keeps
  // them on the session and puts them in the agent's own system prompt) instead of being pasted
  // under every message the user typed.
  const system = 'You are the assistant behind the PCoin AI Telegram bot; the user talks to you from Telegram and can send you photos, documents, voice notes and video, which land in your workspace. Any file you save in the workspace is sent to the user automatically as an attachment: when asked for a picture, chart, document or file, make it and name it in your answer, and never say you cannot send it. Do not create files nobody asked for. Answer as a general assistant, not as a coding tool, unless the user is coding.'
    // Real pictures (2026-09-25): asked for "a realistic picture", an agent scraped Wikimedia and
    // collaged stock photos for twenty minutes. The sandbox now has image and video models.
    + ' For any picture, photo, illustration, logo or video, use the generate_image and generate_video tools — they make real AI-generated images and videos — never stock photos from the web or drawings in code, unless the user asks for that.'
    // THE STEP BUDGET, SAID OUT LOUD. Asked for a logo (2026-09-24), qwen3.8-flash made one, saw
    // its curved text was off, and spent every remaining step debugging the arc maths -- the run
    // hit the limit mid-fix after six minutes and the user got the broken first draft. A model
    // that knows it has N steps delivers something good early and refines within them.
    + ` You have at most ${AGENT_MAX_TURNS} tool steps per message: produce a good result early, refine only while steps remain, and always finish with a short answer to the user. The user is waiting on a phone, so prefer the simplest approach that works.`;

  try {
    for await (const ev of agent.streamRun({
      sessionId: sess?.session_id ?? null,
      message,
      // Always: a run that names the model is how a switch reaches an existing session.
      model,
      maxTurns: AGENT_MAX_TURNS,
      title: sess ? null : `pcnaibot ${chatId}`,
      system,
      effort: AGENT_EFFORT.get(model) ?? null,
    }, { abortSignal: hardAbort.signal })) {
      if (ev.type === 'session') {
        if (timing.stream === null) timing.stream = Date.now();
        // WRITE THE ID DOWN THE MOMENT WE LEARN IT. A session id we lose is a
        // sandbox on their server we can never delete.
        sessionIdSeen = ev.sessionId;
        if (!sess) {
          try { sess = recordSession(db, chatId, { sessionId: ev.sessionId, model }); }
          catch (e) { log.error('could not record the agent session', errFields(e)); }
        }
        // A stop that arrived before we knew the session goes out now.
        if (stopRequested && !stopTarget) { stopTarget = ev.sessionId; requestStop(); }
        else if (!stopTarget) stopTarget = ev.sessionId;
      } else if (ev.type === 'text') {
        shown += ev.delta;
        if (textFirstAt === null) { textFirstAt = Date.now(); timing.firstText = textFirstAt; }
        if (!holdingText()) await draft.maybePush(render());
      } else if (ev.type === 'tool') {
        // Only `started` sets the status; finishing simply clears it.
        //
        // That was originally a workaround -- `tool.finished` had been observed
        // arriving with the literal "tool" instead of the tool's name. Re-probed
        // 2026-09-17 against the raw stream and it now carries `"name":"Bash"`
        // correctly, so the workaround is no longer load-bearing. Kept anyway,
        // because it is also just the right shape: the verb belongs on screen
        // while the tool RUNS, and the answer replaces it when it is done.
        activity = ev.phase === 'started' ? toolVerb(ev.name) : null;
        await draft.maybePush(render());
      } else if (ev.type === 'run') {
        run = ev.run;
      }
    }
  } finally {
    timing.runDone = Date.now();
    clearInterval(keepalive);
    clearInterval(lockTimer);
    activeStreams.delete(chatId);
  }

  // If we never recorded the session (the stream died before run.started), ask
  // for it rather than leak it.
  if (!sess && sessionIdSeen) {
    try { sess = recordSession(db, chatId, { sessionId: sessionIdSeen, model }); }
    catch (e) { log.error('late session record failed', errFields(e)); }
  }

  const out = runOutcome(run);

  // A FAILED RUN THAT COST NOTHING IS WORTH ONE MORE ATTEMPT.
  //
  // This class does not throw: it arrives as HTTP 200 with status "failed", so
  // it sailed straight past withSandboxRetry and the user saw the raw provider
  // message. Measured 2026-09-17, fourteen identical runs of `echo hi` on
  // mimo-v2.5: three failed, each with
  //
  //   "There's an issue with the selected model (mimo-v2.5). It may not exist
  //    or you may not have access to it."
  //
  // for a model that completed the other eleven turns in the same batch and is
  // the configured default. Roughly one turn in five, transient, and the
  // message is actively misleading -- nothing is wrong with the model or the
  // key. Reported upstream; retried here because a user should not see a one-in
  // -five failure for something that works on the next attempt.
  //
  // GATED ON credits === 0. That is what makes the retry free and therefore
  // safe: nothing was charged, so nothing is charged twice. A failure that DID
  // cost something is surfaced and settled as it always was -- work happened,
  // and re-running it would bill the user for the same turn again.
  if (out.readable && out.failed && out.credits === 0) {
    throw new AgentUnavailable(
      out.text || out.error?.message || 'the run failed before doing any billable work',
      { code: 'failed_zero_credits' },
    );
  }

  return { draft, out, sessionId: sessionIdSeen, text: shown, timing };
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
        // CACHING IS EXPECTED, AND IT IS THE THING THAT MAKES A REPEATED PROMPT
        // CHEAP. This used to be logged as an ERROR -- "billing blind" -- which
        // was backwards: it fired on the normal, desirable case.
        //
        // Measured 2026-09-17 on a fresh agent session, three identical turns:
        //   turn 1  input 17,469  cache_read 0       -> 2.947 credits
        //   turn 2  input 126     cache_read 17,408  -> 0.086 credits
        //   turn 3  input 108     cache_read 17,472  -> 0.083 credits
        // The big system prompt is charged fresh ONCE and read from cache after,
        // so turn 2 costs about 34x less than turn 1.
        //
        // On THIS path we price `input_tokens` and `output_tokens` ourselves,
        // and Anthropic's `input_tokens` EXCLUDES cache reads -- so a cached
        // turn bills the user only the small fresh part and nothing at all for
        // the cached portion. That is conservative: we under-charge, never
        // over-charge, and no customer is harmed by it. Whether to bill cache
        // reads at their own lower rate is a pricing decision, not a bug.
        //
        // Still logged, because a change in this behaviour should be visible
        // rather than inferred from a bill.
        if (ev.cacheRead !== 0 || ev.cacheCreation !== 0) {
          log.info('gateway served part of the input from cache; that part is not billed to the user',
            { model: row.model, read: ev.cacheRead, write: ev.cacheCreation, billedInput: ev.inputTokens });
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
    // The half-written preview is left standing. It expires on its own within
    // ~30s, and the error message the caller is about to send removes it sooner
    // -- whereas the empty-text "clear" that used to be here would have replaced
    // it with a spinner that outlived the error.
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
  '/start', '/menu', '/help', '/models', '/model', '/balance', '/topup',
  '/pcn', '/topup_pcn', '/wpcn', '/topup_wpcn', '/clear', '/stats', '/stop',
]);

// What a message is carrying besides words.
//
// `photo` is an ARRAY of sizes, smallest first -- the last entry is the largest
// and is the one worth sending; taking [0] would hand the agent a thumbnail.
// A photo sent as a `document` keeps its original bytes and filename, which is
// what a user does when they care about quality.
function collectAttachments(msg) {
  const out = [];
  if (Array.isArray(msg.photo) && msg.photo.length) {
    const biggest = msg.photo[msg.photo.length - 1];
    if (biggest?.file_id) {
      out.push({ fileId: biggest.file_id, name: `photo-${biggest.file_unique_id ?? 'image'}.jpg`, contentType: 'image/jpeg', kind: 'photo' });
    }
  }
  if (msg.document?.file_id) {
    out.push({
      fileId: msg.document.file_id,
      name: safeName(msg.document.file_name) || `document-${msg.document.file_unique_id ?? 'file'}`,
      contentType: msg.document.mime_type || 'application/octet-stream',
      kind: 'document',
    });
  }
  // Everything else a person can drop into a chat (owner, 2026-09-14: "send image, file,
  // anything"). Each keeps Telegram's own mime type and gets a name the agent can open.
  const extOf = (mime, fallback) => ({
    'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'audio/mpeg': 'mp3',
    'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/wav': 'wav',
    'audio/flac': 'flac', 'image/gif': 'gif', 'image/webp': 'webp',
  })[mime] ?? fallback;
  const media = [
    ['video', msg.video, 'video/mp4', 'mp4'],
    ['animation', msg.animation, 'video/mp4', 'mp4'],
    ['audio', msg.audio, 'audio/mpeg', 'mp3'],
    ['voice', msg.voice, 'audio/ogg', 'ogg'],
    ['video_note', msg.video_note, 'video/mp4', 'mp4'],
  ];
  for (const [kind, m, defaultMime, defaultExt] of media) {
    if (!m?.file_id) continue;
    const mime = m.mime_type || defaultMime;
    out.push({
      fileId: m.file_id,
      name: safeName(m.file_name) || `${kind}-${m.file_unique_id ?? 'media'}.${extOf(mime, defaultExt)}`,
      contentType: mime,
      kind,
    });
  }
  // A static sticker is a WebP picture; an animated one (TGS) or a video one (WebM) is not
  // something a model can look at, so only the picture kind is passed on.
  if (msg.sticker?.file_id && !msg.sticker.is_animated) {
    const video = msg.sticker.is_video === true;
    out.push({
      fileId: msg.sticker.file_id,
      name: `sticker-${msg.sticker.file_unique_id ?? 'sticker'}.${video ? 'webm' : 'webp'}`,
      contentType: video ? 'video/webm' : 'image/webp',
      kind: 'sticker',
    });
  }
  return out;
}

// A filename from a stranger becomes a PATH on somebody else's filesystem.
// Strip directories and anything that could climb out of the workspace; the
// API rejects an escape, but not sending one is better than being refused.
function safeName(name) {
  if (typeof name !== 'string') return null;
  const base = name.replace(/[/\\]/g, '_')   // both separators, explicitly
    .replace(/^[.\s]+/, '')                   // no leading dots: no ../ and no hidden files
    .trim();
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
  return cleaned === '' ? null : cleaned;
}

async function handleMessage(msg) {
  // `from` CAN BE ABSENT -- channel posts and anonymous admins carry
  // sender_chat. State keyed on message.from.id would collide or crash.
  const chat = msg.chat;
  if (!chat || chat.type !== 'private') return;          // DM-only
  if (msg.from?.is_bot) return;                          // never answer a bot
  if (msg.is_automatic_forward) return;                  // nor our own announcements
  const chatId = chat.id;

  // A photo or a document arrives with its words in `caption`, not `text`. The
  // bot used to read only `text`, so an image with a question attached looked
  // like an empty message and was dropped in silence.
  const attachments = collectAttachments(msg);
  const text = (typeof msg.text === 'string' ? msg.text : (typeof msg.caption === 'string' ? msg.caption : '')).trim();
  if (text === '' && attachments.length === 0) {
    // Something the bot cannot take (an animated sticker, a poll, a contact, a location).
    if (msg.sticker || msg.poll || msg.contact || msg.location || msg.venue || msg.dice) {
      return 'I can read text, photos, documents, voice notes, audio and video — not this one.';
    }
    return;
  }

  // DISPATCH ON EXACT MATCH OF THE FIRST TOKEN, so /topup_pcn cannot be
  // swallowed by /topup.
  const first = text.split(/\s+/)[0].split('@')[0];

  // Intercept a bare 0x + 64 hex ABOVE the AI handler even while wPCN is off.
  // Charging somebody for pasting a payment receipt is the worst possible
  // response to "here is my money".
  if (isTxHash(text)) {
    // Allow-listed users get a real verification; everybody else still must not
    // be charged for pasting a receipt.
    if (!mayUse(chatId)) {
      return 'This bot is not open yet. Thanks for your interest — it will be announced when it is.';
    }
    ensureUser(chatId);
    return handleTxHash(chatId, text);
  }

  const u = ensureUser(chatId);

  // THE ALLOW-LIST. Empty means the bot answers nobody -- that is the launch
  // gate, not a bug.
  if (!mayUse(chatId)) {
    if (COMMANDS.has(first)) {
      return 'This bot is not open yet. Thanks for your interest — it will be announced when it is.';
    }
    return null;
  }

  switch (first) {
    case '/start':
    case '/menu':
      return showScreen(chatId, u, 'start');
    case '/help':
      return showScreen(chatId, u, 'help');
    case '/balance':
      return showScreen(chatId, u, 'balance');
    case '/clear':
      return showScreen(chatId, u, 'clear');
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
      if (wanted !== '') {
        const r = setModel(chatId, wanted);
        await sendScreen(chatId, r.msg, quickKeyboard(ensureUser(chatId)));
        return null;
      }
      return showScreen(chatId, u, 'models');
    }
    case '/pcn':
    case '/topup_pcn':
      return showScreen(chatId, u, 'topup_pcn');
    case '/topup':
      return showScreen(chatId, u, 'topup');
    case '/wpcn':
    case '/topup_wpcn':
      return showScreen(chatId, u, 'topup_wpcn');
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
        `agent: ${agent ? 'enabled' : 'off'}` + (agent ? ` — live sessions ${db.prepare('SELECT COUNT(*) n FROM agent_sessions WHERE deleted_at IS NULL').get().n}, owed deletes ${db.prepare('SELECT COUNT(*) n FROM agent_sessions WHERE deleted_at IS NULL AND (expires_at = 0 OR failures >= 3)').get().n}` : ''),
      ].join(NEWLINE);
    }
    default:
      break;
  }

  // A tapped keyboard button arrives as its text. It is a screen, never a billed turn.
  const quick = quickAction(text);
  if (quick) return showScreen(chatId, u, quick);

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
    return await runTurn(chatId, msg.__update_id, text, attachments);
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
  { command: 'start',   description: 'Menu — what I can do, your balance' },
  { command: 'models',  description: 'Choose a model, with live prices' },
  { command: 'balance', description: 'Balance and recent activity' },
  { command: 'topup',   description: 'Add credit with PCN' },
  { command: 'stop',    description: 'Stop the answer being written' },
  { command: 'clear',   description: 'New chat — forget the conversation' },
  { command: 'help',    description: 'How it works' },
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

// Display names for the admin Users page. The bot stores no names, so ask
// Telegram, and remember the answer for an hour -- the page reloads often and
// a user's name rarely changes.
const nameCache = new Map();
async function telegramNames(chatIds) {
  const out = {};
  const now = Date.now();
  await Promise.all(chatIds.map(async (id) => {
    const hit = nameCache.get(id);
    if (hit && now - hit.at < 3600000) { out[id] = hit.name; return; }
    const r = await tg.call('getChat', { chat_id: id }, { timeoutMs: 5000 }).catch(() => null);
    if (!r || !r.ok) return;
    const c = r.result || {};
    const name = [[c.first_name, c.last_name].filter(Boolean).join(' '), c.username ? `@${c.username}` : '']
      .filter(Boolean).join(' ') || null;
    nameCache.set(id, { name, at: now });
    out[id] = name;
  }));
  return out;
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

  // A RESTART ENDS EVERY TURN. Whatever was running died with the old process,
  // so its per-user lock and its open reservation belong to nobody. Left alone
  // they cost the user 3 minutes of "still busy" and 60 minutes of money they
  // cannot spend (2026-09-24: a deploy caught a new user mid-turn and her next
  // messages were refused). Held reservations are different -- the turn MAY
  // have run -- and stay with the age-out.
  const unlocked = db.prepare('UPDATE users SET busy_at = NULL WHERE busy_at IS NOT NULL').run().changes;
  const orphans = db.prepare("SELECT id FROM reservations WHERE state = 'open'").all();
  for (const r of orphans) release(db, r.id, 'bot restarted mid-turn');
  if (unlocked || orphans.length) log.info('cleared turns cut off by the restart', { unlocked, released: orphans.length });

  await publishCommands();

  // admin.pc.am's Users page. Before the probe, so the panel works during the
  // ~2.5 minutes the probe takes.
  startAdminApi({
    db,
    token: cfg.strOr('ADMIN_API_TOKEN', ''),
    port: cfg.int('ADMIN_API_PORT', 8797),
    names: telegramNames,
  });

  await refreshPrices();

  // PROBE BEFORE SELLING ANYTHING. /v1/models is not authoritative for
  // reachability -- all three Claude models are listed and refuse at call time
  // -- and nothing anywhere says whether a model honours max_tokens. Both are
  // only knowable by asking. Costs a few hundredths of a cent.
  // Probe on the path that will actually serve the turn. Probing the plain API
  // and then serving agent runs is how mimo-v2.5:free passed a probe and then
  // refused every real request.
  const probes = await probeAll(db, oona, ALLOWLIST_MODELS, { agentClient: agent });
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

  if (agent) {
    // A session we failed to delete is still ours to clean up -- it does not
    // stop being our sandbox because one HTTP call did not land.
    setInterval(() => {
      sweepDeletions(db, agent).catch((e) => log.error('agent delete sweep failed', errFields(e)));
    }, 600000);
    // And anything on their side we have NO record of is, by definition, a
    // leak: nothing else will ever remove it.
    setInterval(() => {
      reconcileRemote(db, agent).catch((e) => log.error('agent reconcile failed', errFields(e)));
    }, 3600000);
    sweepDeletions(db, agent).catch(() => {});
    reconcileRemote(db, agent).catch(() => {});

    // What happened to a chat while it sat idle -- its files deleted, or the chat ended -- told
    // to the person (lib/lifecycle.mjs). One pass at a time: a pass held up by Telegram's rate
    // limit must not have a second one reading the same events under it.
    let eventsBusy = false;
    const pollEvents = () => {
      if (eventsBusy) return;
      eventsBusy = true;
      pollAgentEvents(db, agent, tg)
        .then((c) => { if (c.handled) log.info('agent session events', c); })
        .catch((e) => log.warn('agent events poll failed', errFields(e)))
        .finally(() => { eventsBusy = false; });
    };
    setInterval(pollEvents, cfg.int('AGENT_EVENTS_POLL_SECONDS', 60) * 1000);
    pollEvents();
  }

  let offset = (kvGetJson(db, 'tg:offset') ?? { offset: 0 }).offset;
  let processed = 0;
  let pollFailures = 0;
  const POLL_WARN_AFTER = 3;

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
      // A LONE TIMEOUT IS NOT A FAULT. The long poll holds the connection for
      // 30s and we give up at 45s; about 0.3% of polls (~9 a day, measured
      // 2026-09-24) lose that race to a network blip between here and
      // Telegram. Nothing is lost -- the offset has not moved, so the next poll
      // re-reads the same updates -- so retry at once, quietly. Only a RUN of
      // failures is an outage worth a warning, and only then do we back off.
      pollFailures++;
      const blip = res.unknown && res.description === 'timeout' && pollFailures < POLL_WARN_AFTER;
      if (blip) {
        log.debug('getUpdates timed out; retrying', { inARow: pollFailures });
        continue;
      }
      log.warn('getUpdates failed', { desc: res.description, unknown: !!res.unknown, inARow: pollFailures });
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    if (pollFailures >= POLL_WARN_AFTER) log.info('getUpdates recovered', { afterFailures: pollFailures });
    pollFailures = 0;

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
          } else if (cid !== null && mayUse(cid) && data.startsWith('m:')) {
            ensureUser(cid);
            const r = setModel(cid, data.slice(2));
            toast = r.ok ? `Model: ${r.model}` : 'Not available';
            await sendScreen(cid, r.msg, quickKeyboard(ensureUser(cid)));
          } else if (cid !== null && mayUse(cid) && data.startsWith('nav:')) {
            // A menu button is the same screen its slash command shows.
            const u = ensureUser(cid);
            await showScreen(cid, u, data.slice(4));
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
