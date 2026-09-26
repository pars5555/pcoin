#!/usr/bin/env node
// The Telegram-facing process: a picture & video studio since 2026-09-26.
//
// A free chat agent (lib/studio.mjs) talks with the user and proposes ONE picture or video as a
// card with its price; the user's ✅ on that card is the only thing that moves money
// (lib/jobs.mjs); the builder makes it (lib/media.mjs). The chat, picture and video models are
// the admin's choice (lib/settings.mjs, admin.pc.am → PcoinAiBot), never the user's.
//
// It never touches the explorer and never reads the rate oracle for crediting -- that is the
// watcher's job, in its own process. It does read the rate to RENDER the deposit screen, because
// a screen quoting a config constant while the watcher credits at the oracle is the pc.am 1/15th
// incident reproduced per-user.
//
// LONG POLLING, NOT A WEBHOOK. ufw is active on this host and long polling opens nothing --
// outbound HTTPS only, no firewall change at all. It also survives a Caddy reload, a cert renewal
// and an IP change.

import { loadConfig } from './lib/config.mjs';
import { log, errFields, installCrashHandlers, chatTag } from './lib/log.mjs';
import { openDb, assertSchema, pendingMigrations, kvGetJson, kvSetJson } from './lib/db.mjs';
import { nowSec } from './lib/time.mjs';
import { TelegramClient, escapeHtml, splitMessage } from './lib/telegram.mjs';
import { readRate } from './lib/rate.mjs';
import { allocateAddress, poolStats, PoolEmpty } from './lib/pool.mjs';
import { creditedUsdLast30Days } from './lib/deposits.mjs';
import { microUsdToString, trimZeros, usdToPcnString, satsToPcnString, parseScaled } from './lib/money.mjs';
import { OonaCodeClient } from './lib/oonacode.mjs';
import { release, ageOutReservations } from './lib/billing.mjs';
import { WpcnService, isTxHash, STATE as WSTATE, humanMessage } from './lib/wpcn.mjs';
import { startAdminApi } from './lib/admin-api.mjs';
import QRCode from 'qrcode';
import { MEDIA_MODELS, MediaClient, mediaOffer, priceFor, usdToMicro, moneyLabel, videoDurations } from './lib/media.mjs';
import { getSettings, saveSettings, settingsProblems, mediaChoices, mergeSettingsInput, DEFAULT_SETTINGS } from './lib/settings.mjs';
import {
  quoteSpec, createProposal, sendCard, setCardStatus, cancelProposal, expireCards, beginJob, refusalText,
  runImageJob, startVideoJob, pollVideos, redeliverSweep, sendOriginal, recoverAfterRestart,
  runningReservationIds, againSpec,
} from './lib/jobs.mjs';
import { chatTurn, chatGate, noteFor, appendHistory, testChatModel, priceLines, buildRequest, DEFAULT_CHAT_PROMPT } from './lib/studio.mjs';
import {
  packages as starsPackages, packageButtonText, sendStarsInvoice, checkPreCheckout, creditStarsPayment,
  expireInvoices, refundStarsPayment, starsReport, RefundRefused,
} from './lib/stars.mjs';
import { mdToHtml } from './lib/markdown.mjs';
import { DraftStream } from './lib/drafts.mjs';

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
// The chat agent's client: plain /v1/messages on the API key, NOT the agentic API.
const oona = new OonaCodeClient(
  cfg.strOr('OONACODE_BASE', 'https://api.oonacode.oonak.ai'),
  cfg.str('OONACODE_KEY'),
  {
    idleTimeoutMs: cfg.int('UPSTREAM_IDLE_TIMEOUT_MS', 120000),
    connectTimeoutMs: cfg.int('UPSTREAM_CONNECT_TIMEOUT_MS', 10000),
    maxConcurrent: cfg.int('MAX_CONCURRENT_UPSTREAM', 4),
  }
);
// The builder's client: the same key, which is the kind OonaCode serves its media models to.
const media = new MediaClient(cfg.strOr('OONACODE_BASE', 'https://api.oonacode.oonak.ai'), cfg.str('OONACODE_KEY'));

// EVERY STUDIO KNOB IS THE ADMIN'S (admin.pc.am → PcoinAiBot), read fresh on each use. The margin
// lived in pcnaibot.conf before; that value is now only the default until the admin sets one.
const SETTINGS_BASE = { margin: cfg.num('MARGIN', 3.0) };
const settings = () => getSettings(db, SETTINGS_BASE);
const marginE6 = () => parseScaled(String(settings().margin), 6);
// The chat models the admin may choose from.
const CHAT_MODEL_CHOICES = cfg.list('MODEL_ALLOWLIST');
const ALLOWED_CHATS = new Set(cfg.intList('ALLOWLIST_CHAT_IDS'));
const ADMIN_CHATS = new Set(cfg.intList('ADMIN_CHAT_IDS'));
// OPEN_TO_ALL=1 answers everybody; ALLOWLIST_CHAT_IDS then no longer gates.
// Kept separate from the list so an empty list still means "nobody".
const OPEN_TO_ALL = cfg.bool('OPEN_TO_ALL', false);
const mayUse = (chatId) => OPEN_TO_ALL || ALLOWED_CHATS.has(chatId) || ADMIN_CHATS.has(chatId);
const MIN_CONF = cfg.int('MIN_CONF', 3);
const PUBLISHED_MIN_USD = cfg.num('PUBLISHED_MIN_USD', 5);
const CAP_USER_MICRO = BigInt(Math.round(cfg.num('CAP_30D_USD_PER_USER', 2000) * 1e6));
const RL_FLOOR = cfg.int('RATELIMIT_REMAINING_FLOOR', 30);
const REGISTRY_MAX_AGE = cfg.int('REGISTRY_MAX_AGE_SECONDS', 21600);
const WPCN_ENABLED = cfg.bool('WPCN_ENABLED', false);
const EXPLORER_PUBLIC = cfg.strOr('EXPLORER_URL', 'https://explorer.pc.am');
// `users.model` is NOT NULL and no longer means anything: the admin picks the models.
const USERS_MODEL_PLACEHOLDER = 'studio';

const wpcn = new WpcnService(db, {
  token: cfg.strOr('WPCN_PAY_TOKEN', null),
  endpoint: cfg.strOr('WPCN_PAY_URL', 'https://wpcnpay.pc.am'),
  enabled: WPCN_ENABLED && !!cfg.strOr('WPCN_PAY_TOKEN', null),
});

// A global ceiling on work being handled at once. Not about money -- about not letting a burst of
// users open an unbounded number of upstream calls against a gateway that shares a box.
const MAX_CONCURRENT_TURNS = cfg.int('MAX_CONCURRENT_TURNS', 8);
// Work in flight. THE POLL LOOP MUST NOT AWAIT A TURN: a picture takes up to a minute and every
// other user would wait for it.
const inFlightTurns = new Set();
const track = (p) => { inFlightTurns.add(p); p.finally(() => inFlightTurns.delete(p)); return p; };

// draft_id MUST be non-zero, and stable for the life of one answer. The update_id is unique.
function draftIdFor(updateId) {
  const n = Number(updateId) | 0;
  return n === 0 ? 1 : Math.abs(n);
}

// ---------------------------------------------------------------------------
// What is on sale: OonaCode's live list of media models. A failed read keeps the last good one;
// one older than REGISTRY_MAX_AGE sells nothing -- an unknown price does not bill.
// ---------------------------------------------------------------------------
async function refreshMedia() {
  try {
    const all = await media.listModels();
    const entries = all.filter((m) => m.modality === 'image' || m.modality === 'video');
    kvSetJson(db, 'media:listing', { at: nowSec(), entries });
    log.info('media models refreshed', { offered: Object.keys(mediaOffer(entries)).join(',') || '(none)' });
  } catch (e) {
    log.warn('could not list media models; keeping the previous list', errFields(e));
  }
}
function currentOffer() {
  const l = kvGetJson(db, 'media:listing');
  if (!l || nowSec() - l.at > REGISTRY_MAX_AGE) return {};
  return mediaOffer(l.entries);
}

// The chat model's last health check (a tool call it must make), for /stats and the logs.
let chatHealth = { model: null, ok: null, why: 'not checked yet', at: 0 };
async function checkChatModel() {
  const model = settings().chatModel;
  const r = await testChatModel(oona, model);
  chatHealth = { model, ok: r.ok, why: r.why ?? null, at: nowSec() };
  if (r.ok) log.info('chat model answers with a tool call', { model });
  else log.error('CHAT MODEL CHECK FAILED -- the studio cannot propose anything', { model, why: r.why ?? null });
}

const note = noteFor(db);
const jobDeps = (draft = null) => ({ db, tg, media, marginE6: marginE6(), note, draft });

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------
function ensureUser(chatId) {
  const u = db.prepare('SELECT * FROM users WHERE chat_id = ?').get(chatId);
  if (u) return u;
  db.prepare('INSERT INTO users (chat_id, model, created_at) VALUES (?,?,?)').run(chatId, USERS_MODEL_PLACEHOLDER, nowSec());
  return db.prepare('SELECT * FROM users WHERE chat_id = ?').get(chatId);
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------
const NEWLINE = String.fromCharCode(10);
const ONE_WAY = 'Deposits are <b>one-way</b>: PCN in, credit out. Balances are held in <b>USD</b>, are not withdrawable, and are not refundable.';

// THE MENU: a keyboard that stays under the composer. Telegram sends a tapped button's text as a
// message, so `quickAction` turns those texts back into screens before anything reaches the agent.
const QUICK = {
  balance: '💳 Balance', topup: '➕ Top up', clear: '🆕 New chat', help: '❓ How it works',
};
function quickKeyboard() {
  return {
    keyboard: [
      [{ text: QUICK.balance }, { text: QUICK.topup }],
      [{ text: QUICK.clear }, { text: QUICK.help }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}
function quickAction(text) {
  // The keyboard before 2026-09-26 had a "🧠 Model: …" button, and it stays on users' screens until
  // replaced. It opens the start screen, which sends the new keyboard.
  if (/^(🧠|🎨|🎬) Model:/u.test(text)) return 'start';
  for (const [k, v] of Object.entries(QUICK)) if (text === v) return k;
  return null;
}
const BACK_KEYBOARD = { inline_keyboard: [[{ text: '« Menu', callback_data: 'nav:start' }]] };

const balanceLabel = (micro) => `$${escapeHtml(trimZeros(microUsdToString(micro, 4)))}`;

function startScreen(u) {
  const prices = priceLines(currentOffer(), settings(), marginE6());
  return [
    '👋 <b>Hi! I make pictures 🎨 and short videos 🎬</b> — you pay in PCN.',
    '',
    '<b>Just tell me what you want</b>, in any language: "a cat astronaut, cartoon style", "a poster for my café", "animate this photo".',
    'Send a photo to change it or bring it to life. Reply to a picture I made to change it.',
    '',
    'I show you a card with exactly what I will make and its price. <b>Nothing is charged until you press ✅.</b> Talking with me is free.',
    '',
    `<i>Now: ${escapeHtml(prices.join('; '))}.</i>`,
    '',
    `Balance: <b>${balanceLabel(u.balance_micro_usd)}</b>`,
    '',
    `<i>${ONE_WAY}</i>`,
  ].join('\n');
}

function helpScreen() {
  const prices = priceLines(currentOffer(), settings(), marginE6());
  return [
    '<b>How it works</b>',
    '',
    '• <b>Describe</b> the picture or video you want. I may ask one or two short questions.',
    '• I show a <b>card</b>: what I will make, its shape and its price. Press <b>✅ Make it</b> to make it, or tell me what to change — a new card replaces the old one.',
    '• <b>Only ✅ charges you</b>, and never more than the price on the button. Talking with me is free.',
    '• Pictures take under a minute. Videos take 1–5 minutes and arrive by themselves; you can keep chatting meanwhile.',
    '• <b>Change</b> a picture: reply to it, or say "#12, make it night". A video can\'t be edited frame by frame yet — changing one makes a <b>new version</b>.',
    '• <b>Send a photo</b> to change it or bring it to life as a video.',
    '• Under each result: <b>🔁 Again</b> (a new card for another one) and <b>📎 Original file</b> (full quality, free, for 24 hours).',
    '• <b>New chat</b> forgets our conversation. Your pictures stay in the chat.',
    '• <b>Top up</b> by sending PCN to your own permanent address; credit lands after 3 confirmations.',
    '',
    `<i>Now: ${escapeHtml(prices.join('; '))}.</i>`,
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
      await sendScreen(chatId, startScreen(u), quickKeyboard());
      return null;
    case 'help':
      await sendScreen(chatId, helpScreen());
      return null;
    case 'balance':
      await sendScreen(chatId, balanceScreen(u), {
        inline_keyboard: [[{ text: '➕ Top up', callback_data: 'nav:topup' }, { text: '« Menu', callback_data: 'nav:start' }]],
      });
      return null;
    case 'topup': {
      // Telegram Stars first -- paid in two taps, credited at once -- then the PCN rails.
      const pk = starsPackages(settings());
      const rows = pk.map((p) => [{ text: packageButtonText(p), callback_data: `st:${p.index}` }]);
      rows.push([{ text: 'PCN — on the PCoin chain', callback_data: 'nav:topup_pcn' }]);
      if (WPCN_ENABLED) rows.push([{ text: 'wPCN — on BNB Smart Chain', callback_data: 'nav:topup_wpcn' }]);
      rows.push([{ text: '« Menu', callback_data: 'nav:start' }]);
      await tg.sendMessage(chatId, [
        `<b>Top up</b> · your balance is <b>${balanceLabel(u.balance_micro_usd)}</b>`,
        '',
        pk.length ? '⭐ <b>Telegram Stars</b> — pay inside Telegram, credited instantly:' : '',
        pk.length ? '' : null,
        '<b>PCN</b> — send PCN to your own address; credited after 3 confirmations.',
      ].filter((l) => l !== null && l !== undefined).join('\n'), { reply_markup: { inline_keyboard: rows } });
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
      const open = db.prepare("SELECT id FROM proposals WHERE chat_id = ? AND state = 'open'").all(chatId);
      for (const p of open) {
        cancelProposal(db, chatId, p.id);
        await setCardStatus(jobDeps(), p.id, 'Cancelled — a new chat was started.');
      }
      await sendScreen(chatId, 'New chat started — I have forgotten our conversation. Your pictures and videos are still here, and I can still change them by their number.');
      return null;
    }
    default:
      return null;
  }
}

// A ledger row as a person reads it: WHAT it was and WHEN, not the row's kind tag. A studio charge
// is noted "media <model> P<card> …"; older rows name the chat model ("agent <model> …",
// "stream <model> …", "<model> in=…").
function ledgerLabel(l) {
  if (l.kind === 'ai_turn') {
    const words = String(l.note ?? '').trim().split(/\s+/);
    if (words[0] === 'media') {
      const kind = MEDIA_MODELS[words[1]]?.kind ?? (/video|t2v|i2v|horse/.test(words[1] ?? '') ? 'video' : 'image');
      return kind === 'video' ? '🎬 video' : '🎨 picture';
    }
    const model = words[0] === 'agent' || words[0] === 'stream' ? words[1] : words[0];
    return model ? `<code>${escapeHtml(model)}</code>` : 'a turn';
  }
  if (l.kind === 'deposit_pcn') return 'PCN deposit';
  if (l.kind === 'deposit_wpcn') return 'wPCN deposit';
  if (l.kind === 'deposit_stars') return `⭐ ${escapeHtml(String(l.note ?? 'Stars').replace(/ Telegram Stars$/, ''))} Stars`;
  if (l.kind === 'grant') return 'free grant';
  if (String(l.idem_key ?? '').startsWith('stars-refund:')) return '⭐ Stars refund';
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
  // A grant row moves nothing and no longer means anything; it is not shown.
  const led = db.prepare("SELECT * FROM ledger WHERE chat_id=? AND kind <> 'grant' ORDER BY id DESC LIMIT 10").all(u.chat_id);
  const lines = [
    `Balance: <b>${balanceLabel(u.balance_micro_usd)}</b>`,
    u.reserved_micro_usd > 0 ? `Set aside for something being made: $${escapeHtml(microUsdToString(u.reserved_micro_usd, 4))}` : '',
  ].filter(Boolean);
  if (u.balance_micro_usd < 0) {
    lines.push('', '<b>Your balance is negative.</b> Top up to continue.');
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
// The studio: what the user sends, and the buttons on cards and results.
// ---------------------------------------------------------------------------

// What a picture model can take: a photo, an image sent as a file, a still sticker. Anything else
// (a voice note, a PDF, a clip) is answered for free and never reaches the agent.
function collectPictures(msg) {
  const out = [];
  if (Array.isArray(msg.photo) && msg.photo.length) {
    const biggest = msg.photo[msg.photo.length - 1];
    if (biggest?.file_id) out.push(biggest.file_id);
  }
  if (msg.document?.file_id && /^image\/(png|jpe?g|webp)$/.test(msg.document.mime_type ?? '')) out.push(msg.document.file_id);
  if (msg.sticker?.file_id && !msg.sticker.is_animated && !msg.sticker.is_video) out.push(msg.sticker.file_id);
  return out;
}
const carriesOtherMedia = (msg) => !!(msg.video || msg.animation || msg.audio || msg.voice || msg.video_note
  || (msg.document && !/^image\/(png|jpe?g|webp)$/.test(msg.document.mime_type ?? '')));

// A picture the user sent becomes item #N, so the agent can point at it.
function registerUpload(chatId, fileId, messageId) {
  const r = db.prepare(
    `INSERT INTO items (chat_id, kind, tg_file_id, tg_message_id, delivered_at, created_at)
     VALUES (?, 'upload', ?, ?, ?, ?)
     ON CONFLICT (chat_id, tg_message_id) WHERE tg_message_id IS NOT NULL DO NOTHING`
  ).run(chatId, fileId, messageId, nowSec(), nowSec());
  if (r.changes === 1) return Number(r.lastInsertRowid);
  return db.prepare('SELECT id FROM items WHERE chat_id = ? AND tg_message_id = ?').get(chatId, messageId)?.id ?? null;
}

// A reply points at an item: looked up by (chat, message) -- message ids are per chat. A reply to a
// picture that is not an item yet (one the bot sent before 2026-09-26) becomes one on the spot.
function itemFromReply(chatId, msg) {
  const r = msg.reply_to_message;
  if (!r || r.chat?.id !== chatId) return null;
  const hit = db.prepare('SELECT id FROM items WHERE chat_id = ? AND tg_message_id = ?').get(chatId, r.message_id);
  if (hit) return hit.id;
  const pics = collectPictures(r);
  if (!pics.length) return null;
  const kind = r.from?.is_bot ? 'image' : 'upload';
  const ins = db.prepare(
    `INSERT INTO items (chat_id, kind, tg_file_id, tg_message_id, delivered_at, created_at)
     VALUES (?,?,?,?,?,?) ON CONFLICT (chat_id, tg_message_id) WHERE tg_message_id IS NOT NULL DO NOTHING`
  ).run(chatId, kind, pics[0], r.message_id, r.date ?? nowSec(), r.date ?? nowSec());
  return ins.changes === 1 ? Number(ins.lastInsertRowid) : null;
}

// One conversation at a time per chat, in order; a picture being drawn does not block talking.
const chatQueues = new Map();
function enqueueChat(chatId, fn) {
  const q = chatQueues.get(chatId) ?? { tail: Promise.resolve(), depth: 0 };
  if (q.depth >= 3) return null;
  q.depth++;
  q.tail = q.tail.then(fn).catch((e) => log.error('chat turn threw', errFields(e))).finally(() => {
    q.depth--;
    if (q.depth === 0) chatQueues.delete(chatId);
  });
  chatQueues.set(chatId, q);
  return q.tail;
}

// Albums arrive as several messages; the caption-less ones get one short answer between them.
const answeredAlbums = new Map();

async function sendAgentText(chatId, text, fallback) {
  const html = text ? mdToHtml(text) : fallback;
  if (html) await tg.sendLong(chatId, html, { reply_markup: quickKeyboard() });
}

// One free chat turn: the agent talks, and may propose a card.
async function runChat(chatId, updateId, userContent) {
  const u = ensureUser(chatId);
  const s = settings();
  const gate = chatGate(db, chatId, {
    perHour: s.chatPerHour, dailyBudget: s.chatDailyBudget, balanceMicro: u.balance_micro_usd,
    rateRemaining: oona.rateLimitRemaining, rlFloor: RL_FLOOR,
  });
  if (gate.refuse) { await tg.sendMessage(chatId, gate.refuse); return; }

  const m = marginE6();
  const offer = currentOffer();
  const draft = new DraftStream(tg, chatId, draftIdFor(updateId), { canStop: false });
  await draft.push('<i>✍️ …</i>').catch(() => undefined);

  let r;
  const started = Date.now();
  try {
    r = await chatTurn({ db, oona, settings: s, offer, marginE6: m, balanceMicro: BigInt(u.balance_micro_usd) }, { chatId, userContent });
  } catch (e) {
    log.warn('chat turn failed', { chat: chatTag(chatId), model: s.chatModel, ...errFields(e) });
    await tg.sendMessage(chatId, 'The assistant is unavailable for a moment — please try again shortly. Nothing is charged for chatting.');
    return;
  }
  log.info('chat turn', { chat: chatTag(chatId), model: s.chatModel, ms: Date.now() - started, card: !!r.spec, failed: r.failed ?? null });

  if (r.failed === 'max_tokens') {
    await tg.sendMessage(chatId, 'Sorry, I lost my thread — could you say that again?');
    appendHistory(db, chatId, [{ role: 'user', content: userContent }]);
    return;
  }

  let cardNote = null;
  if (r.spec) {
    let quote = null;
    try { quote = quoteSpec(offer[r.spec.model], r.spec, m); } catch (e) { log.warn('a proposal could not be priced', { chat: chatTag(chatId), ...errFields(e) }); }
    if (quote) {
      const created = createProposal(db, chatId, r.spec, quote, { ttlSec: s.cardTtlHours * 3600 });
      if (r.text) await sendAgentText(chatId, r.text);
      await sendCard(jobDeps(), created);
      const p = created.proposal;
      cardNote = `(Card P${p.id} shown: ${p.kind === 'video' ? `video ${p.seconds} s` : 'picture'}, ${p.shape} — "${p.summary}" — ${moneyLabel(p.price_micro)}; waiting for the user's ✅.)`;
    } else {
      await sendAgentText(chatId, r.text, 'That cannot be priced right now — please try again in a little while.');
      cardNote = '(The card could not be priced, so none was shown.)';
    }
  } else {
    await sendAgentText(chatId, r.text, r.failed === 'invalid'
      ? 'I could not set that up — could you describe it once more?'
      : 'Tell me what picture or video you would like.');
  }
  appendHistory(db, chatId, [
    { role: 'user', content: userContent },
    { role: 'assistant', content: [r.text, cardNote].filter(Boolean).join('\n\n') || '(no reply)' },
  ]);
}

// ✅ on a card: everything up to the reservation is synchronous (lib/jobs.mjs beginJob), then the
// job runs in the background.
function confirmCard(chatId, updateId, proposalId) {
  const b = beginJob(db, { chatId, proposalId, offer: currentOffer(), marginE6: marginE6() });
  if (b.ok) {
    note(chatId, `(The user pressed ✅ on card P${proposalId}; it is being made.)`);
    const work = b.proposal.kind === 'image'
      ? runImageJob(jobDeps(), b, { draft: new DraftStream(tg, chatId, draftIdFor(updateId), { canStop: false }) })
      : startVideoJob(jobDeps(), b);
    track(work.then((text) => (text ? tg.sendMessage(chatId, text) : null))
      .catch((e) => log.error('studio job threw', { chat: chatTag(chatId), job: b.jobId, ...errFields(e) })));
    return b.proposal.kind === 'image' ? 'Making it…' : 'Starting the video…';
  }
  const text = refusalText(b);
  track((async () => {
    if (b.short) {
      note(chatId, `(The user pressed ✅ on card P${proposalId}, but the balance was short.)`);
      await tg.sendMessage(chatId, text, { reply_markup: { inline_keyboard: [[{ text: '➕ Top up', callback_data: 'nav:topup' }]] } });
    } else if (b.repriced !== undefined) {
      await setCardStatus(jobDeps(), proposalId, 'The price was updated.', { keepButtons: true });
      await tg.sendMessage(chatId, text);
    } else if (text) {
      await tg.sendMessage(chatId, text);
    }
  })().catch((e) => log.warn('card refusal could not be sent', errFields(e))));
  return b.short ? 'Not enough balance' : b.refused === 'started' || b.refused === 'raced' ? 'Already being made' : 'Not made';
}

async function againCard(chatId, itemId) {
  const s = settings();
  const spec = againSpec(db, { chatId, itemId, settings: s });
  if (!spec) { await tg.sendMessage(chatId, 'I cannot repeat that one — tell me what you would like instead.'); return; }
  const offer = currentOffer();
  let quote;
  try { quote = quoteSpec(offer[spec.model], spec, marginE6()); } catch {
    await tg.sendMessage(chatId, 'That is not available right now — please try again in a little while.');
    return;
  }
  const created = createProposal(db, chatId, spec, quote, { ttlSec: s.cardTtlHours * 3600 });
  await sendCard(jobDeps(), created);
  note(chatId, `(The user pressed Again on #${itemId}; card P${created.proposal.id} shown, ${moneyLabel(created.proposal.price_micro)}.)`);
}

// ---------------------------------------------------------------------------
// Payments by Telegram Stars (lib/stars.mjs), and messages to the admins
// ---------------------------------------------------------------------------

// Telegram has taken the Stars. Credit once (keyed on Telegram's charge id), and say so. A credit
// that cannot be made is an ERROR for the admins -- the user paid -- and the user is told it will
// be sorted out, never that it failed silently.
async function handleStarsPaid(chatId, sp) {
  ensureUser(chatId);
  let r;
  try { r = creditStarsPayment(db, { chatId, sp }); } catch (e) { r = { refused: e.message }; }
  if (r.credited) {
    log.info('stars payment credited', { chat: chatTag(chatId), stars: r.stars, micro: Number(r.micro) });
    return `✅ Paid <b>${r.stars} ⭐</b> — <b>${moneyLabel(r.micro)}</b> added. Your balance is <b>${balanceLabel(r.balance)}</b>.`;
  }
  if (r.duplicate) return `That payment was already credited. Your balance is <b>${balanceLabel(r.balance)}</b>.`;
  log.error('STARS PAYMENT NOT CREDITED -- the user paid; credit or refund by hand', {
    chat: chatTag(chatId), stars: sp?.total_amount ?? null, charge: String(sp?.telegram_payment_charge_id ?? '').slice(0, 24), why: r.refused,
  });
  for (const a of ADMIN_CHATS) {
    tg.sendMessage(a, `⚠️ A Stars payment of ${escapeHtml(String(sp?.total_amount ?? '?'))} ⭐ from chat ${chatId} could not be credited: ${escapeHtml(String(r.refused))}. Credit or refund it on admin.pc.am → PcoinAiBot → Payments.`)
      .catch(() => undefined);
  }
  return 'Your payment arrived, but it could not be added to your balance automatically. The team has been told and will sort it out — nothing is lost.';
}

// A message that starts with SUPPORT (the /paysupport text asks for it) goes to the admins.
async function relaySupport(chatId, msg, text) {
  const who = (await telegramNames([chatId]).catch(() => ({})))[chatId] ?? String(chatId);
  const u = ensureUser(chatId);
  let told = 0;
  for (const a of ADMIN_CHATS) {
    const r = await tg.sendMessage(a, `🆘 <b>Support</b> from ${escapeHtml(who)} (<code>${chatId}</code>, balance ${balanceLabel(u.balance_micro_usd)}):\n\n${escapeHtml(text.slice(0, 3000))}`).catch(() => ({ ok: false }));
    if (r.ok) told++;
  }
  log.info('support message relayed', { chat: chatTag(chatId), admins: told });
  return told
    ? 'Thank you — your message was passed to the people who run this bot. They will get back to you.'
    : 'Your message could not be passed on just now. Please try again in a little while.';
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------
const COMMANDS = new Set([
  '/start', '/menu', '/help', '/models', '/model', '/balance', '/topup', '/paysupport',
  '/pcn', '/topup_pcn', '/wpcn', '/topup_wpcn', '/clear', '/stats', '/stop',
]);

async function handleMessage(msg) {
  // `from` CAN BE ABSENT -- channel posts and anonymous admins carry
  // sender_chat. State keyed on message.from.id would collide or crash.
  const chat = msg.chat;
  if (!chat || chat.type !== 'private') return;          // DM-only
  if (msg.from?.is_bot) return;                          // never answer a bot
  if (msg.is_automatic_forward) return;                  // nor our own announcements
  const chatId = chat.id;

  // A STARS PAYMENT, before anything else -- the allow-list, commands, the agent. Telegram has
  // already taken the Stars; the credit must happen whatever else is true.
  if (msg.successful_payment) return handleStarsPaid(chatId, msg.successful_payment);

  const pictures = collectPictures(msg);
  const text = (typeof msg.text === 'string' ? msg.text : (typeof msg.caption === 'string' ? msg.caption : '')).trim();
  if (text === '' && pictures.length === 0) {
    if (carriesOtherMedia(msg) || msg.sticker || msg.poll || msg.contact || msg.location || msg.venue || msg.dice) {
      return mayUse(chatId) ? 'I can use photos and pictures — send one as a photo, or describe what you would like me to make.' : null;
    }
    return;
  }

  // DISPATCH ON EXACT MATCH OF THE FIRST TOKEN, so /topup_pcn cannot be
  // swallowed by /topup.
  const first = text.split(/\s+/)[0].split('@')[0];

  // Intercept a bare 0x + 64 hex ABOVE the agent even while wPCN is off: a
  // payment receipt is not a picture request.
  if (isTxHash(text)) {
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
    // Telegram caches the old menu per chat, so these still arrive for a while.
    case '/models':
    case '/model':
      return 'There is no model to choose any more — just tell me what picture or video you want, and I will show you a card with its price.';
    case '/paysupport':
      return escapeHtml(settings().paySupportText);
    case '/stop':
      return 'Nothing to stop: a picture or video is made only after you press ✅, and then it runs to the end.';
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
      return statsText();
    }
    default:
      break;
  }

  // A tapped keyboard button arrives as its text. It is a screen, never a chat turn.
  const quick = quickAction(text);
  if (quick) return showScreen(chatId, u, quick);

  // A dead command never reaches the agent.
  if (first.startsWith('/')) {
    return 'That command does not exist here. Try /help.';
  }

  // A message to the people who run the bot (the /paysupport text says how): passed to the admin
  // chats, never to the agent.
  if (/^support\b/i.test(text)) return relaySupport(chatId, msg, text);

  // ---- the studio ----
  const notes = [];
  const replyTo = itemFromReply(chatId, msg);
  if (replyTo) notes.push(`(The user is replying to #${replyTo}.)`);
  const uploaded = pictures.map((fid) => registerUpload(chatId, fid, msg.message_id)).filter((id) => id !== null);
  if (uploaded.length) notes.push(`(The user sent a photo: #${uploaded.join(', #')}.)`);

  if (text === '') {
    // A photo alone (or an album): kept as an item, answered once, no model call.
    note(chatId, `(The user sent photo #${uploaded.join(', #')} without a caption.)`);
    if (msg.media_group_id) {
      if (answeredAlbums.has(msg.media_group_id)) return null;
      answeredAlbums.set(msg.media_group_id, nowSec());
      for (const [k, at] of answeredAlbums) if (nowSec() - at > 600) answeredAlbums.delete(k);
    }
    return `Got it — that is #${uploaded.join(', #')}. Tell me what to do with it: change something in it, or bring it to life as a video.`;
  }
  const maxChars = settings().chatMaxChars;
  if (text.length > maxChars) {
    return `That is a long message — please keep it under ${maxChars} characters.`;
  }

  const queued = enqueueChat(chatId, () => runChat(chatId, msg.__update_id, [...notes, text].join('\n')));
  if (!queued) return 'One moment — I am still answering your earlier messages.';
  await queued;
  return null;
}

function statsText() {
  const st = poolStats(db);
  const dep = db.prepare('SELECT status, COUNT(*) n FROM pcn_deposits GROUP BY status').all();
  const s = settings();
  const offer = currentOffer();
  const running = db.prepare("SELECT kind, COUNT(*) n FROM media_jobs WHERE state = 'running' GROUP BY kind").all();
  const openCards = db.prepare("SELECT COUNT(*) n FROM proposals WHERE state = 'open'").get().n;
  const calls = kvGetJson(db, `studio:chatcalls:${new Date().toISOString().slice(0, 10)}`)?.n ?? 0;
  return [
    '<b>Rail status</b>',
    `pool: ${st.issued} issued / ${st.total} (free ${st.free}, index ${st.minIndex}-${st.maxIndex})`,
    `deposits: ${dep.length ? dep.map((d) => `${d.status}=${d.n}`).join(' ') : 'none yet'}`,
    `wPCN: ${WPCN_ENABLED ? 'enabled' : 'off'}`,
    '',
    '<b>Studio</b>',
    `chat: ${escapeHtml(s.chatModel)} — ${chatHealth.ok === true ? 'OK' : chatHealth.ok === false ? `FAILING (${escapeHtml(chatHealth.why ?? '')})` : `unchecked (${escapeHtml(chatHealth.why ?? '')})`}`,
    `picture: ${escapeHtml(s.pictureModel)} ${offer[s.pictureModel] ? 'on sale' : 'NOT ON SALE'}`,
    `video: ${escapeHtml(s.videoModel)} ${s.videoSeconds} s ${escapeHtml(s.videoResolution)} ${offer[s.videoModel] ? 'on sale' : 'NOT ON SALE'}`,
    `running: ${running.length ? running.map((r) => `${r.kind}=${r.n}`).join(' ') : 'nothing'} · open cards: ${openCards}`,
    `chat messages today: ${calls} of ${s.chatDailyBudget} free`,
  ].join(NEWLINE);
}

// ---------------------------------------------------------------------------
// The admin's studio settings (admin.pc.am → PcoinAiBot, through lib/admin-api.mjs)
// ---------------------------------------------------------------------------
function studioChoices() {
  const offer = currentOffer();
  const label = (micro) => moneyLabel(micro);
  return {
    chat: CHAT_MODEL_CHOICES,
    picture: mediaChoices(offer, 'image').map((id) => ({
      id, label: MEDIA_MODELS[id].label,
      price: label(usdToMicro(priceFor(offer[id], { kind: 'image' }).usd, marginE6())),
    })),
    video: mediaChoices(offer, 'video').map((id) => ({
      id, label: MEDIA_MODELS[id].label,
      durations: videoDurations(offer[id]),
      resolutions: Object.keys(offer[id].t2v.pricing.tiers).map((res) => ({
        id: res, perSecond: label(usdToMicro(priceFor(offer[id], { kind: 'video', seconds: 1, resolution: res }).usd, marginE6())),
      })),
      fromPhoto: !!offer[id].i2v,
    })),
    videoEdit: [],
    listingFresh: Object.keys(offer).length > 0,
  };
}

async function saveStudioSettings(input) {
  const cur = settings();
  const next = mergeSettingsInput(cur, input && typeof input === 'object' ? input : {});
  // Instructions saved unchanged from the built-in text are stored as "use the built-in ones", so
  // they keep following the code's version.
  if (next.chatPrompt.trim() === DEFAULT_CHAT_PROMPT.trim()) next.chatPrompt = '';
  const problems = settingsProblems(next, { offer: currentOffer(), chatChoices: CHAT_MODEL_CHOICES });
  if (problems.length) return { ok: false, problems };
  // A new chat model must actually call the tool, or the studio could never propose anything.
  if (next.chatModel !== cur.chatModel) {
    const t = await testChatModel(oona, next.chatModel);
    if (t.ok !== true) return { ok: false, problems: [`${next.chatModel} did not propose anything when tested (${t.why ?? 'no tool call'}); kept ${cur.chatModel}`] };
  }
  const saved = saveSettings(db, next);
  // What changed, by name (the instructions can be long: their length, not their text).
  const changed = Object.keys(saved).filter((k) => JSON.stringify(saved[k]) !== JSON.stringify(cur[k]))
    .map((k) => (k === 'chatPrompt' ? `chatPrompt(${String(saved[k]).length} chars)` : `${k}=${JSON.stringify(saved[k])}`));
  log.info('studio settings changed', { changed: changed.join(' ') || '(nothing)' });
  if (next.chatModel !== cur.chatModel) chatHealth = { model: next.chatModel, ok: true, why: null, at: nowSec() };
  return { ok: true, settings: saved };
}

// Everything the admin pages show about the studio.
function studioGet() {
  const s = settings();
  const today = new Date().toISOString().slice(0, 10);
  const count = (sql, ...a) => db.prepare(sql).get(...a).n;
  const since = nowSec() - 86400;
  return {
    settings: s,
    defaults: { ...DEFAULT_SETTINGS, margin: SETTINGS_BASE.margin, chatPrompt: DEFAULT_CHAT_PROMPT },
    choices: studioChoices(),
    chatHealth,
    stats: {
      chatToday: kvGetJson(db, `studio:chatcalls:${today}`)?.n ?? 0,
      cardsDay: count('SELECT COUNT(*) n FROM proposals WHERE created_at > ?', since),
      openCards: count("SELECT COUNT(*) n FROM proposals WHERE state = 'open'"),
      picturesDay: count("SELECT COUNT(*) n FROM items WHERE kind = 'image' AND job_id IS NOT NULL AND created_at > ?", since),
      videosDay: count("SELECT COUNT(*) n FROM items WHERE kind = 'video' AND created_at > ?", since),
      running: count("SELECT COUNT(*) n FROM media_jobs WHERE state = 'running'"),
      failedDay: count("SELECT COUNT(*) n FROM media_jobs WHERE state IN ('failed','unknown') AND created_at > ?", since),
      spentDay: db.prepare("SELECT COALESCE(-SUM(delta_micro_usd), 0) n FROM ledger WHERE kind = 'ai_turn' AND created_at > ?").get(since).n,
    },
  };
}

// What the chat model would receive right now for this user and message -- built by the SAME code
// a real turn uses (lib/studio.mjs buildRequest), so the preview cannot drift from the truth.
function studioPreview({ chatId, text }) {
  const u = db.prepare('SELECT * FROM users WHERE chat_id = ?').get(chatId);
  if (!u) return { error: `no user ${chatId}` };
  const { body } = buildRequest({ db, settings: settings(), offer: currentOffer(), marginE6: marginE6(), balanceMicro: BigInt(u.balance_micro_usd) },
    { chatId, userContent: String(text || 'make me a picture of a cat') });
  return { model: body.model, system: body.system, messages: body.messages };
}

// The latest cards and what became of them.
function studioJobs(limit = 50) {
  return db.prepare(
    `SELECT p.id, p.chat_id, p.kind, p.model, p.api_model, p.shape, p.seconds, p.resolution, p.summary, p.price_micro,
            p.state, p.created_at, p.decided_at, j.state AS job_state, j.credits, j.error, i.id AS item_id
       FROM proposals p
       LEFT JOIN media_jobs j ON j.proposal_id = p.id
       LEFT JOIN items i ON i.proposal_id = p.id AND i.kind IN ('image','video')
      ORDER BY p.id DESC LIMIT ?`
  ).all(Math.min(200, Math.max(1, Number(limit) || 50)));
}

// Stars, for the Payments page: our books, and Telegram's.
async function starsAdmin() {
  const payments = db.prepare(
    `SELECT id, chat_id, stars, micro_usd, created_at, refunded_at, refund_note, charge_id FROM stars_payments ORDER BY id DESC LIMIT 200`
  ).all();
  const totals = db.prepare(
    `SELECT COUNT(*) n, COALESCE(SUM(stars),0) stars, COALESCE(SUM(micro_usd),0) micro,
            COALESCE(SUM(CASE WHEN refunded_at IS NOT NULL THEN stars END),0) refunded_stars
       FROM stars_payments`
  ).get();
  const invoices = db.prepare("SELECT state, COUNT(*) n FROM stars_invoices GROUP BY state").all();
  const telegram = await starsReport(tg).catch((e) => ({ ok: false, error: e.message }));
  return { payments, totals, invoices, telegram, packages: starsPackages(settings()) };
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
// /start, which is why /models and /stop are still ANSWERED though no longer listed.
const PUBLIC_COMMANDS = [
  { command: 'start',   description: 'What I make, prices, your balance' },
  { command: 'balance', description: 'Balance and recent activity' },
  { command: 'topup',   description: 'Add credit with PCN' },
  { command: 'clear',   description: 'New chat — forget the conversation' },
  { command: 'help',    description: 'How it works' },
  // Telegram asks every bot that takes Stars to answer /paysupport.
  { command: 'paysupport', description: 'Help with a payment' },
];

const ADMIN_EXTRA = [
  { command: 'stats', description: 'Admin: rail and studio status' },
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

// A button from before 2026-09-26: `mj:<job>:<action>` under a picture, `m:<model>` on the model
// list, `stop:` on a streaming answer. Answered, never charged.
async function legacyButton(chatId, data) {
  if (data.startsWith('mj:') && data.endsWith(':file')) {
    const j = db.prepare('SELECT * FROM media_jobs WHERE id = ? AND chat_id = ?').get(Number(data.split(':')[1]), chatId);
    if (j?.result_url && (j.result_expires_at ?? 0) > nowSec()) {
      try {
        const bytes = await media.download(j.result_url);
        await tg.sendDocument(chatId, bytes, { filename: `${j.model}-${j.id}.${j.kind === 'video' ? 'mp4' : 'png'}`, contentType: j.kind === 'video' ? 'video/mp4' : 'image/png' });
        return;
      } catch { /* fall through */ }
    }
    await tg.sendMessage(chatId, 'That original file has expired — the copy in the chat is still yours to save.');
    return;
  }
  await tg.sendMessage(chatId, 'That button is from an older version of the bot. Just tell me what picture or video you would like — reply to a picture to change it.', { reply_markup: quickKeyboard() });
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

  // A RESTART ENDS EVERY TURN -- but not every JOB. First: whatever was being made. A picture being
  // drawn, or a clip whose job id was never recorded, is HELD (it may have been made and charged)
  // and its owner told; a clip with a job id keeps going and the poller finishes it.
  const recovered = recoverAfterRestart(jobDeps());
  // Then the rest, as before: locks from the old process, and open reservations that belong to
  // nothing still running.
  const unlocked = db.prepare('UPDATE users SET busy_at = NULL WHERE busy_at IS NOT NULL').run().changes;
  const stillMaking = runningReservationIds(db);
  const orphans = db.prepare("SELECT id FROM reservations WHERE state = 'open'").all().filter((r) => !stillMaking.has(r.id));
  for (const r of orphans) release(db, r.id, 'bot restarted mid-turn');
  if (unlocked || orphans.length) log.info('cleared turns cut off by the restart', { unlocked, released: orphans.length });

  // Clips being made, and paid results that never arrived: before anything that can be slow.
  let videosBusy = false;
  const pollClips = () => {
    if (videosBusy) return;
    videosBusy = true;
    pollVideos(jobDeps())
      .then((c) => { if (c.done || c.failed) log.info('video jobs', c); })
      .catch((e) => log.warn('video poll failed', errFields(e)))
      .finally(() => { videosBusy = false; });
  };
  setInterval(pollClips, 15000);
  pollClips();
  let sweepBusy = false;
  const sweep = () => {
    if (sweepBusy) return;
    sweepBusy = true;
    redeliverSweep(jobDeps())
      .then((c) => { if (c.tried) log.info('re-sent paid results', c); })
      .catch((e) => log.warn('re-send sweep failed', errFields(e)))
      .finally(() => { sweepBusy = false; });
  };
  setInterval(sweep, 120000);
  sweep();

  for (const m of recovered) {
    await tg.sendMessage(m.chatId, m.text).catch(() => undefined);
  }

  await publishCommands();

  startAdminApi({
    db,
    token: cfg.strOr('ADMIN_API_TOKEN', ''),
    port: cfg.int('ADMIN_API_PORT', 8797),
    names: telegramNames,
    studio: {
      get: studioGet,
      save: saveStudioSettings,
      preview: studioPreview,
      jobs: studioJobs,
      test: async (model) => testChatModel(oona, model),
    },
    stars: {
      get: starsAdmin,
      refund: async ({ paymentId, note: why }) => {
        try {
          const r = await refundStarsPayment({ db, tg }, { paymentId, note: why });
          await tg.sendMessage(r.chatId, `⭐ ${r.stars} Stars were refunded to you, and ${moneyLabel(r.micro)} was taken off your balance.`).catch(() => undefined);
          return { ok: true, ...r, micro: Number(r.micro) };
        } catch (e) {
          if (e instanceof RefundRefused) return { ok: false, error: e.message };
          throw e;
        }
      },
    },
  });

  await refreshMedia();
  setInterval(() => refreshMedia().catch((e) => log.error('media refresh failed', errFields(e))),
    cfg.int('REGISTRY_REFRESH_SECONDS', 600) * 1000);

  // The chat model must call its tool. Checked now and daily; a failure is logged loudly and the
  // chat says "unavailable" -- the bot does NOT exit, because clips being made must still arrive.
  checkChatModel().catch((e) => log.error('chat model check failed', errFields(e)));
  setInterval(() => checkChatModel().catch((e) => log.error('chat model check failed', errFields(e))), 86400 * 1000);

  setInterval(() => {
    try {
      ageOutReservations(db, { olderThanMinutes: cfg.int('RESERVATION_AGE_OUT_MINUTES', 60) });
      expireInvoices(db);
      expireCards(db);
    } catch (e) { log.error('age-out failed', errFields(e)); }
  }, 300000);

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

      // A stop press on a draft from the old streaming answers. Nothing streams now.
      if (up.stopped_message_generation) continue;

      // TELEGRAM'S LAST CHECK BEFORE IT TAKES THE STARS, answered within 10 seconds: a synchronous
      // look-up against the invoice we wrote (lib/stars.mjs), then the answer. Never queued behind
      // other work.
      if (up.pre_checkout_query) {
        const q = up.pre_checkout_query;
        let verdict;
        try { verdict = checkPreCheckout(db, q); } catch (e) { log.error('pre-checkout check threw', errFields(e)); verdict = { ok: false, error: 'Something went wrong — please try again.' }; }
        const a = await tg.call('answerPreCheckoutQuery', verdict.ok
          ? { pre_checkout_query_id: q.id, ok: true }
          : { pre_checkout_query_id: q.id, ok: false, error_message: verdict.error });
        log.info('stars pre-checkout', { chat: chatTag(q.from?.id ?? 0), stars: q.total_amount, ok: verdict.ok, why: verdict.error ?? '-', answered: a.ok });
        continue;
      }

      // Buttons. Answer the callback FIRST in spirit -- an unanswered callback leaves a spinner on
      // the button for a minute -- so anything slow runs in the background.
      if (up.callback_query) {
        const cq = up.callback_query;
        const cid = cq.message?.chat?.id ?? cq.from?.id ?? null;
        const data = typeof cq.data === 'string' ? cq.data : '';
        let toast = '';
        try {
          if (cid === null || !mayUse(cid)) {
            toast = 'This bot is not open yet.';
          } else if (/^sc:\d+$/.test(data)) {
            ensureUser(cid);
            toast = confirmCard(cid, up.update_id, Number(data.slice(3)));
          } else if (/^st:\d+$/.test(data)) {
            // A Stars package: write the invoice, send it.
            ensureUser(cid);
            toast = 'Opening the payment…';
            track(sendStarsInvoice({ db, tg }, { chatId: cid, settings: settings(), index: Number(data.slice(3)) })
              .then((r) => (r.ok ? null : tg.sendMessage(cid, r.text)))
              .catch((e) => log.error('stars invoice threw', errFields(e))));
          } else if (/^sx:\d+$/.test(data)) {
            const id = Number(data.slice(3));
            if (cancelProposal(db, cid, id)) {
              toast = 'Cancelled';
              note(cid, `(The user cancelled card P${id}.)`);
              track(setCardStatus(jobDeps(), id, 'Cancelled.'));
            } else {
              toast = 'That card is no longer open.';
            }
          } else if (/^ag:\d+$/.test(data)) {
            toast = 'A new card…';
            track(againCard(cid, Number(data.slice(3))).catch((e) => log.error('again threw', errFields(e))));
          } else if (/^of:\d+$/.test(data)) {
            toast = 'Sending the file…';
            track(sendOriginal(jobDeps(), { chatId: cid, itemId: Number(data.slice(3)) })
              .then((t) => (t ? tg.sendMessage(cid, t) : null))
              .catch((e) => log.error('original file threw', errFields(e))));
          } else if (data.startsWith('nav:')) {
            // A menu button is the same screen its slash command shows.
            const u = ensureUser(cid);
            await showScreen(cid, u, data.slice(4));
          } else if (data.startsWith('mj:') || data.startsWith('m:') || data.startsWith('stop:')) {
            toast = data.startsWith('stop:') ? 'Nothing to stop' : '';
            track(legacyButton(cid, data).catch((e) => log.warn('legacy button threw', errFields(e))));
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
      track((async () => {
        try {
          const reply = await handleMessage(msg);
          if (reply) await tg.sendLong(msg.chat.id, reply);
        } catch (e) {
          log.error('handler threw', errFields(e));
          try { await tg.sendMessage(msg.chat.id, 'Something went wrong handling that. It has been logged.'); }
          catch { /* best effort */ }
        }
      })());

      processed++;
    }

    const making = db.prepare("SELECT COUNT(*) n FROM media_jobs WHERE state = 'running'").get().n;
    await writeBotHeartbeat({ ok: true, processed, offset, in_flight: inFlightTurns.size, making, last_error: null });
  }
}

main().catch((e) => {
  log.error('bot exited', errFields(e));
  process.exit(1);
});
