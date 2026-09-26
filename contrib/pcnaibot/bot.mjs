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
import { WpcnService, isTxHash, STATE as WSTATE } from './lib/wpcn.mjs';
import { startAdminApi } from './lib/admin-api.mjs';
import QRCode from 'qrcode';
import { MEDIA_MODELS, MediaClient, mediaOffer, priceFor, usdToMicro, moneyLabel, videoDurations } from './lib/media.mjs';
import { getSettings, saveSettings, settingsProblems, mediaChoices, mergeSettingsInput, DEFAULT_SETTINGS, DEFAULT_PAY_SUPPORT } from './lib/settings.mjs';
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
import { t, langOf, LANGS, LANG_CODES, detectLang, isLang, everyLabel, whenLabel } from './lib/i18n.mjs';
import { openAccount, parseInvite, inviteLink, inviteStats, payInviteReward, usdToMicro as dollarsToMicro } from './lib/rewards.mjs';

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
const jobDeps = (draft = null) => ({ db, tg, media, marginE6: marginE6(), note, draft, onDelivered: afterDelivery });

// The bot's @username, for invite links (read from getMe at start).
let BOT_USERNAME = null;

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

// Find or create the user. Creating one is the ONLY moment the welcome gift is given and an invite
// recorded (lib/rewards.mjs), and it is when the language is first read from Telegram. A user from
// before languages existed gets theirs from Telegram on their next message.
function account(chatId, from = null, invitedBy = null) {
  const existing = db.prepare('SELECT * FROM users WHERE chat_id = ?').get(chatId);
  if (existing) {
    if (!isLang(existing.lang) && from) {
      const lang = detectLang(from.language_code);
      db.prepare('UPDATE users SET lang = ? WHERE chat_id = ? AND lang IS NULL').run(lang, chatId);
      existing.lang = lang;
    }
    return { user: existing, created: false, giftMicro: 0n, invite: null };
  }
  const s = settings();
  const open = mayUse(chatId);
  const r = openAccount(db, {
    chatId, model: USERS_MODEL_PLACEHOLDER, lang: detectLang(from?.language_code),
    giftMicro: open && s.giftEnabled ? dollarsToMicro(s.giftUsd) : 0n,
    invitedBy: open && s.invitesEnabled ? invitedBy : null,
  });
  if (r.created) {
    log.info('new user', { chat: chatTag(chatId), lang: r.user.lang, gift: Number(r.giftMicro), invite: r.invite ?? '-' });
  }
  return r;
}
const ensureUser = (chatId, from = null) => account(chatId, from).user;
const langOfUser = (u) => (isLang(u?.lang) ? u.lang : 'en');

// A delivered result (lib/jobs.mjs deliverItem). A VIDEO may pay the person who invited its maker:
// once, and only after the maker has topped up (lib/rewards.mjs). The inviter is told in their own
// language.
async function afterDelivery(it) {
  if (it.kind !== 'video') return;
  const s = settings();
  const r = payInviteReward(db, {
    referredId: it.chat_id, itemId: it.id, enabled: s.invitesEnabled,
    rewardMicro: dollarsToMicro(s.inviteRewardUsd), minTopupMicro: dollarsToMicro(s.inviteMinTopupUsd),
  });
  if (!r.paid) {
    if (r.why !== 'none' && r.why !== 'off') log.info('invite reward not paid', { chat: chatTag(it.chat_id), why: r.why });
    return;
  }
  log.info('invite reward paid', { inviter: chatTag(r.referrerId), invited: chatTag(it.chat_id), micro: Number(r.micro), item: it.id });
  const L = langOf(db, r.referrerId);
  await tg.sendMessage(r.referrerId, t(L, 'invite.earned_msg', { reward: dollars(Number(r.micro) / 1e6), balance: balanceLabel(r.balance) }))
    .catch((e) => log.warn('invite reward notice failed', errFields(e)));
}

// ---------------------------------------------------------------------------
// Screens -- every text is in lib/locales, in the user's language.
// ---------------------------------------------------------------------------
const NEWLINE = String.fromCharCode(10);

// A settings amount ($3, $2.50) as people write it.
const dollars = (usd) => (Number.isInteger(Number(usd)) ? `$${Number(usd)}` : `$${Number(usd).toFixed(2)}`);

// THE MENU: a keyboard that stays under the composer. Telegram sends a tapped button's text as a
// message, so `quickAction` turns those texts back into screens before anything reaches the agent
// -- in ANY language, because a keyboard drawn before a language change stays on screen.
const QUICK_KEYS = ['balance', 'topup', 'invite', 'language', 'clear', 'help'];
const QUICK_BY_LABEL = new Map(QUICK_KEYS.flatMap((k) => [...everyLabel(`kb.${k}`)].map((label) => [label, k])));
// The four labels of the keyboard before 2026-09-26 (English only).
for (const [label, k] of [['💳 Balance', 'balance'], ['➕ Top up', 'topup'], ['🆕 New chat', 'clear'], ['❓ How it works', 'help']]) QUICK_BY_LABEL.set(label, k);
function quickKeyboard(L) {
  const b = (k) => ({ text: t(L, `kb.${k}`) });
  return {
    keyboard: [
      [b('balance'), b('topup')],
      [b('invite'), b('language')],
      [b('clear'), b('help')],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}
function quickAction(text) {
  // The keyboard before 2026-09-26 had a "🧠 Model: …" button, and it stays on users' screens until
  // replaced. It opens the start screen, which sends the new keyboard.
  if (/^(🧠|🎨|🎬) Model:/u.test(text)) return 'start';
  return QUICK_BY_LABEL.get(text) ?? null;
}
const backKeyboard = (L) => ({ inline_keyboard: [[{ text: t(L, 'btn.menu'), callback_data: 'nav:start' }]] });

const balanceLabel = (micro) => `$${escapeHtml(trimZeros(microUsdToString(micro, 4)))}`;

// Button names used inside sentences, in the sentence's language.
const buttonNames = (L) => ({
  make: t(L, 'btn.make'), cancel: t(L, 'btn.cancel'), again: t(L, 'btn.again'), original: t(L, 'btn.original'),
  topup: t(L, 'kb.topup'), help: t(L, 'kb.help'), newchat: t(L, 'kb.clear'), language: t(L, 'kb.language'),
});
const pricesNow = (L) => escapeHtml(priceLines(currentOffer(), settings(), marginE6(), L).join(t(L, 'price.sep')));

// What a user reads first (/start) and in full (/help): what the bot makes, how to change a photo
// or a picture it made, what video can and cannot do yet, and how paying works. Prices, video length
// and resolution are read live, so the text stays true when the admin changes them. `fresh` is the
// account just opened by this very message: its gift and invite are said once, here.
function startScreen(u, fresh = null) {
  const L = langOfUser(u);
  const s = settings();
  const names = buttonNames(L);
  const lines = [t(L, 'start.title')];
  if (fresh?.giftMicro > 0n) lines.push('', t(L, 'start.gift', { amount: dollars(Number(fresh.giftMicro) / 1e6) }));
  if (fresh?.invite === 'recorded') lines.push(t(L, 'start.invited'));
  lines.push(
    '',
    t(L, 'start.can_title'),
    t(L, 'start.can_picture'),
    t(L, 'start.can_edit_photo'),
    t(L, 'start.can_edit_mine'),
    t(L, 'start.can_video'),
    t(L, 'start.can_animate'),
    t(L, 'start.can_edit_video'),
    '',
    t(L, 'start.how_title'),
    t(L, 'start.how_1'),
    t(L, 'start.how_2'),
    t(L, 'start.how_3', names),
    '',
    t(L, 'start.now', { prices: pricesNow(L) }),
  );
  if (s.invitesEnabled && s.inviteRewardUsd > 0) lines.push('', t(L, 'start.invite', { reward: dollars(s.inviteRewardUsd) }));
  lines.push('', t(L, 'start.balance', { balance: balanceLabel(u.balance_micro_usd), ...names }));
  return lines.join('\n');
}

function helpScreen(L) {
  const s = settings();
  const names = buttonNames(L);
  const lines = [
    t(L, 'help.title'),
    '',
    t(L, 'help.pic_title'), t(L, 'help.pic_1'), t(L, 'help.pic_2'), t(L, 'help.pic_3', names),
    '',
    t(L, 'help.edit_title'), t(L, 'help.edit_1'), t(L, 'help.edit_2'), t(L, 'help.edit_3'),
    '',
    t(L, 'help.vid_title'),
    t(L, 'help.vid_1', { seconds: escapeHtml(String(s.videoSeconds)), res: escapeHtml(s.videoResolution) }),
    t(L, 'help.vid_2'), t(L, 'help.vid_3'), t(L, 'help.vid_4'),
    '',
    t(L, 'help.pay_title'), t(L, 'help.pay_1', names), t(L, 'help.pay_2'), t(L, 'help.pay_3'), t(L, 'help.pay_4', names),
    '',
    t(L, 'help.top_title'),
  ];
  if (starsPackages(s).length) lines.push(t(L, 'help.top_stars'));
  lines.push(t(L, 'help.top_pcn', { conf: MIN_CONF }));
  if (WPCN_ENABLED) lines.push(t(L, 'help.top_wpcn'));
  if (s.invitesEnabled && s.inviteRewardUsd > 0) {
    lines.push('', t(L, 'help.inv_title'), s.inviteMinTopupUsd > 0
      ? t(L, 'help.inv_1', { reward: dollars(s.inviteRewardUsd), min: dollars(s.inviteMinTopupUsd) })
      : t(L, 'help.inv_1_nomin', { reward: dollars(s.inviteRewardUsd) }));
  }
  lines.push(
    '',
    t(L, 'help.know_title'), t(L, 'help.know_1'), t(L, 'help.know_2', names), t(L, 'help.know_3', names), t(L, 'help.know_4'),
    '',
    t(L, 'start.now', { prices: pricesNow(L) }),
    '',
    `<i>${t(L, 'terms.studio')}</i>`,
  );
  return lines.join('\n');
}

// 🤝 Invite friends: the user's own link, what it pays, and how it has gone.
function inviteScreen(chatId, L) {
  const s = settings();
  if (!s.invitesEnabled || !(s.inviteRewardUsd > 0) || !BOT_USERNAME) {
    return { html: t(L, 'invite.off'), keyboard: backKeyboard(L) };
  }
  const link = inviteLink(BOT_USERNAME, chatId);
  const st = inviteStats(db, chatId);
  const reward = dollars(s.inviteRewardUsd);
  const html = [
    t(L, 'invite.title', { reward }),
    '',
    s.inviteMinTopupUsd > 0 ? t(L, 'invite.how', { reward, min: dollars(s.inviteMinTopupUsd) }) : t(L, 'invite.how_nomin', { reward }),
    '',
    t(L, 'invite.link_title'),
    `<code>${escapeHtml(link)}</code>`,
    t(L, 'invite.tap_copy'),
    '',
    t(L, 'invite.stats_title'),
    t(L, 'invite.joined', { n: st.joined }),
    t(L, 'invite.rewarded', { n: st.rewarded }),
    t(L, 'invite.earned', { amount: dollars(Number(st.earnedMicro) / 1e6) }),
    '',
    t(L, 'invite.fine'),
  ].join('\n');
  const shareText = s.giftEnabled && s.giftUsd > 0 ? t(L, 'invite.share_text', { gift: dollars(s.giftUsd) }) : t(L, 'invite.share_text_nogift');
  const share = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(shareText)}`;
  return {
    html,
    keyboard: { inline_keyboard: [[{ text: t(L, 'btn.share'), url: share }], [{ text: t(L, 'btn.menu'), callback_data: 'nav:start' }]] },
  };
}

// 🌐 Language: every language, the current one ticked, two to a row.
function languageKeyboard(L) {
  const rows = [];
  for (let i = 0; i < LANG_CODES.length; i += 2) {
    rows.push(LANG_CODES.slice(i, i + 2).map((c) => ({ text: `${c === L ? '✓ ' : ''}${LANGS[c].flag} ${LANGS[c].name}`, callback_data: `lang:${c}` })));
  }
  return { inline_keyboard: rows };
}

// The "/" menu, in one language; admins also see /stats.
function commandsFor(L, admin = false) {
  const list = ['start', 'balance', 'topup', 'invite', 'language', 'clear', 'help', 'paysupport']
    .map((c) => ({ command: c, description: t(L, `cmd.${c}`) }));
  return admin ? [...list, { command: 'stats', description: 'Admin: rail and studio status' }] : list;
}

// A new language: saved, said in that language, and the keyboard and "/" menu redrawn in it.
async function setLanguage(chatId, code) {
  if (!isLang(code)) return;
  db.prepare('UPDATE users SET lang = ? WHERE chat_id = ?').run(code, chatId);
  log.info('language changed', { chat: chatTag(chatId), lang: code });
  await tg.sendMessage(chatId, t(code, 'lang.changed', { flag: LANGS[code].flag, name: LANGS[code].name }), { reply_markup: quickKeyboard(code) });
  const r = await tg.setMyCommands(commandsFor(code, ADMIN_CHATS.has(chatId)), { type: 'chat', chat_id: chatId });
  if (!r.ok) log.warn('setMyCommands (chat language) failed', { desc: r.description });
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

// ➕ → PCN: the user's own permanent address, in webbuilderbot's three steps, with the live rate,
// the 30-day headroom and the last deposits. Returns { html, keyboard }.
async function depositScreen(chatId, L) {
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
      return { html: t(L, 'pcn.pool_empty'), keyboard: backKeyboard(L) };
    }
    throw e;
  }

  // QUOTE THE LIVE ORACLE, OR SAY "RATE UNAVAILABLE". Never a config constant.
  const rate = await readRate(kvStore, cfg);

  const lines = [
    t(L, 'pcn.title'),
    '',
    t(L, 'pcn.step1'),
    '',
    `<code>${escapeHtml(alloc.address)}</code>`,
    t(L, 'pcn.tap_copy'),
    '',
    t(L, 'pcn.step2'),
    '',
    t(L, 'pcn.step3'),
    '',
  ];

  if (rate.usable) {
    const minPcn = usdToPcnString(BigInt(Math.round(PUBLISHED_MIN_USD * 1e6)), rate.rateE12);
    lines.push(
      t(L, 'pcn.rate', { rate: escapeHtml(Number(rate.rateText).toFixed(6)) }),
      t(L, 'pcn.min', { pcn: escapeHtml(minPcn), usd: PUBLISHED_MIN_USD }),
    );
    // 30-day headroom, stated in PCN at the live rate. CAPS ARE ENFORCED BEFORE
    // THE MONEY MOVES -- a deposit that lands over a cap is credited and
    // flagged, never kept and refused.
    const used = creditedUsdLast30Days(db, chatId);
    const headroom = CAP_USER_MICRO > used ? CAP_USER_MICRO - used : 0n;
    lines.push(headroom <= 0n
      ? t(L, 'pcn.cap_used')
      : t(L, 'pcn.headroom', { usd: escapeHtml(microUsdToString(headroom, 2)), pcn: escapeHtml(usdToPcnString(headroom, rate.rateE12)) }));
    lines.push(t(L, 'pcn.conf', { conf: MIN_CONF }), '', t(L, 'pcn.rate_note'));
  } else {
    lines.push(t(L, 'pcn.rate_off'), t(L, 'pcn.conf', { conf: MIN_CONF }));
  }
  lines.push('', t(L, 'terms.one_way'));

  const recent = db.prepare(
    `SELECT amount_sat, status, credited_micro_usd FROM pcn_deposits
      WHERE chat_id = ? ORDER BY id DESC LIMIT 10`
  ).all(chatId);
  if (recent.length) {
    lines.push('', t(L, 'pcn.recent'));
    for (const d of recent) {
      const st = ['seen', 'confirming', 'credited', 'rejected', 'held'].includes(d.status) ? t(L, `pcn.st.${d.status}`) : escapeHtml(d.status);
      lines.push(`· ${escapeHtml(satsToPcnString(d.amount_sat))} PCN — ${st}`
        + (d.credited_micro_usd !== null ? ` — $${escapeHtml(microUsdToString(d.credited_micro_usd, 4))}` : ''));
    }
  }
  return {
    html: lines.join('\n'),
    keyboard: {
      inline_keyboard: [
        [{ text: t(L, 'btn.buy_pcn'), url: 'https://market.pc.am' }],
        [{ text: t(L, 'btn.explorer'), url: `${EXPLORER_PUBLIC}/address/${encodeURIComponent(alloc.address)}` }],
        [{ text: t(L, 'btn.menu'), callback_data: 'nav:start' }],
      ],
    },
  };
}

// The wPCN token and the one PancakeSwap route to it, pinned by contract address -- a search for
// "wPCN" can land on any token that claims the name, and buying the wrong one is unrecoverable
// (webbuilderbot's WPCN_SWAP_URL).
const WPCN_CONTRACT = '0x290A5779a419Cb9cB22fa087CDD1CD16dA2D95F1';
const WPCN_SWAP_URL = `https://pancakeswap.finance/swap?inputCurrency=0x55d398326f99059fF775485246999027B3197955&outputCurrency=${WPCN_CONTRACT}`;

// ➕ → wPCN: pay the shared address, paste the hash. Returns { html, keyboard }.
async function wpcnScreen(chatId, L) {
  if (!WPCN_ENABLED) return { html: t(L, 'wpcn.off'), keyboard: backKeyboard(L) };
  const info = await wpcn.paymentInfo();
  if (!info) return { html: t(L, 'wpcn.unreachable'), keyboard: backKeyboard(L) };
  const lines = [
    t(L, 'wpcn.title'),
    '',
    t(L, 'wpcn.what'),
    // wPCN is a 1:1 claim on PCN, redeemable 1:1, so it credits at PARITY --
    // and the screen must say whatever is actually true rather than a number
    // baked in here. bonusPercent went 10 -> 0 on 2026-09-11 precisely because
    // a bonus on a 1:1 claim contradicts the property that makes it work; if it
    // is ever non-zero again, the user is told, not silently given a rate the
    // code did not expect.
    info.bonusPct === 0 ? t(L, 'wpcn.parity') : t(L, 'wpcn.bonus', { pct: escapeHtml(String(info.bonusPct)) }),
    '',
    t(L, 'wpcn.step1'),
    `<code>${escapeHtml(info.payTo)}</code>`,
    '',
    t(L, 'wpcn.network', { contract: WPCN_CONTRACT }),
    '',
    t(L, 'wpcn.step2'),
    '',
    t(L, 'wpcn.step3'),
    '',
    t(L, 'wpcn.conf', { conf: escapeHtml(String(info.minConfirmations ?? '?')) }),
    '',
    t(L, 'terms.one_way'),
  ];
  const paid = db.prepare(
    `SELECT txhash, SUM(wpcn_sat) sat, SUM(usd_micro) usd FROM wpcn_claims WHERE chat_id = ?
      GROUP BY txhash ORDER BY MAX(created_at) DESC LIMIT 10`
  ).all(chatId);
  if (paid.length) {
    lines.push('', t(L, 'wpcn.recent'));
    for (const p of paid) {
      lines.push(t(L, 'wpcn.recent_row', {
        wpcn: escapeHtml(satsToPcnString(p.sat)), usd: escapeHtml(microUsdToString(p.usd, 4)), hash: escapeHtml(String(p.txhash).slice(0, 12)),
      }));
    }
  }
  return {
    html: lines.join('\n'),
    keyboard: {
      inline_keyboard: [
        [{ text: t(L, 'btn.buy_wpcn'), url: WPCN_SWAP_URL }],
        [{ text: t(L, 'btn.bscscan'), url: `https://bscscan.com/address/${encodeURIComponent(info.payTo)}` }],
        [{ text: t(L, 'btn.menu'), callback_data: 'nav:start' }],
      ],
    },
  };
}

// A pasted 0x hash: "checking…" at once (the verifier can take several seconds), then the verdict.
async function handleTxHash(chatId, txhash, L) {
  if (!WPCN_ENABLED) return t(L, 'wpcn.hash_off');
  await tg.sendMessage(chatId, t(L, 'wpcn.checking')).catch(() => undefined);
  const r = await wpcn.verifyAndCredit(chatId, txhash);

  if (r.state === WSTATE.CREDITED && r.creditedMicro > 0n) {
    const bal = db.prepare('SELECT balance_micro_usd b FROM users WHERE chat_id = ?').get(chatId)?.b ?? 0;
    return t(L, 'wpcn.credited', { usd: escapeHtml(microUsdToString(r.creditedMicro, 4)), balance: balanceLabel(bal) })
      + (r.healed ? `\n\n${t(L, 'wpcn.healed')}` : '');
  }
  if (r.state === WSTATE.CREDITED && r.duplicate) return t(L, 'wpcn.dup');
  if (r.state === WSTATE.ALREADY_CLAIMED) return r.yours ? t(L, 'wpcn.dup') : t(L, 'wpcn.claimed_other');
  // 503 unreadable -> THE QUESTION IS UNANSWERED. Resolve nothing, and never
  // say "payment not found".
  if (r.state === WSTATE.UNREADABLE) return t(L, 'wpcn.unreadable');
  switch (r.state) {
    case WSTATE.PENDING: return t(L, 'wpcn.st.pending');
    case WSTATE.CONFIRMING: return t(L, 'wpcn.st.confirming', { n: escapeHtml(String(r.confirmations ?? '?')), req: escapeHtml(String(r.required ?? '?')) });
    case WSTATE.NO_PAYMENT: return t(L, 'wpcn.st.no_payment');
    case WSTATE.REVERTED: return t(L, 'wpcn.st.reverted');
    case WSTATE.REORGED: return t(L, 'wpcn.st.reorged');
    case WSTATE.BAD_REQUEST: return t(L, 'wpcn.st.bad_request');
    // Anything else is NOT "you did not pay" -- it is "we could not check".
    default: return t(L, 'wpcn.unreadable');
  }
}

// One screen, sent with its buttons. The text is what the slash command would have returned;
// the keyboard is what makes it a menu.
async function sendScreen(chatId, html, keyboard) {
  const parts = splitMessage(html);
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1;
    await tg.sendMessage(chatId, parts[i], last && keyboard ? { reply_markup: keyboard } : {});
  }
}

// What each menu button (and its typed alias) shows. `null` from a handler means it sent its own
// messages. Shared by the slash commands and the inline buttons so the two can never drift.
// `fresh` is set when this very message opened the account (lib/rewards.mjs openAccount).
async function showScreen(chatId, u, which, fresh = null) {
  const L = langOfUser(u);
  switch (which) {
    case 'start':
      await sendScreen(chatId, startScreen(u, fresh), quickKeyboard(L));
      // A new user is asked their language once -- it was guessed from Telegram's.
      if (fresh?.created) await tg.sendMessage(chatId, t(L, 'lang.choose'), { reply_markup: languageKeyboard(L) });
      return null;
    case 'help':
      await sendScreen(chatId, helpScreen(L), backKeyboard(L));
      return null;
    case 'invite': {
      const s = inviteScreen(chatId, L);
      await sendScreen(chatId, s.html, s.keyboard);
      return null;
    }
    case 'language':
      await tg.sendMessage(chatId, t(L, 'lang.choose'), { reply_markup: languageKeyboard(L) });
      return null;
    case 'balance':
      await sendScreen(chatId, balanceScreen(u), {
        inline_keyboard: [[{ text: t(L, 'btn.topup'), callback_data: 'nav:topup' }, { text: t(L, 'btn.menu'), callback_data: 'nav:start' }]],
      });
      return null;
    case 'topup': {
      // Telegram Stars first -- paid in two taps, credited at once -- then the PCN rails.
      const pk = starsPackages(settings());
      const rows = pk.map((p) => [{ text: packageButtonText(p), callback_data: `st:${p.index}` }]);
      rows.push([{ text: t(L, 'btn.pcn'), callback_data: 'nav:topup_pcn' }]);
      if (WPCN_ENABLED) rows.push([{ text: t(L, 'btn.wpcn'), callback_data: 'nav:topup_wpcn' }]);
      rows.push([{ text: t(L, 'btn.menu'), callback_data: 'nav:start' }]);
      await tg.sendMessage(chatId, [
        t(L, 'topup.title', { balance: balanceLabel(u.balance_micro_usd) }),
        '',
        pk.length ? t(L, 'topup.stars') : null,
        pk.length ? '' : null,
        t(L, 'topup.pcn', { conf: MIN_CONF }),
        WPCN_ENABLED ? t(L, 'topup.wpcn') : null,
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
            caption: t(L, 'pcn.qr_caption', { address: escapeHtml(alloc.address) }),
          });
        } catch (e) {
          // A QR that fails to render must never cost the user the address.
          log.warn('QR render/send failed; sending the address as text only', errFields(e));
        }
      }
      const s = await depositScreen(chatId, L);
      await sendScreen(chatId, s.html, s.keyboard);
      return null;
    }
    case 'topup_wpcn': {
      const s = await wpcnScreen(chatId, L);
      await sendScreen(chatId, s.html, s.keyboard);
      return null;
    }
    case 'clear': {
      db.prepare('DELETE FROM conversations WHERE chat_id = ?').run(chatId);
      const open = db.prepare("SELECT id FROM proposals WHERE chat_id = ? AND state = 'open'").all(chatId);
      for (const p of open) {
        cancelProposal(db, chatId, p.id);
        await setCardStatus(jobDeps(), p.id, 'card.st.new_chat');
      }
      await sendScreen(chatId, t(L, 'clear.done'), backKeyboard(L));
      return null;
    }
    default:
      return null;
  }
}

// A ledger row as a person reads it: WHAT it was and WHEN, not the row's kind tag. A studio charge
// is noted "media <model> P<card> …"; older rows name the chat model ("agent <model> …",
// "stream <model> …", "<model> in=…").
function ledgerLabel(l, L) {
  if (l.kind === 'ai_turn') {
    const words = String(l.note ?? '').trim().split(/\s+/);
    if (words[0] === 'media') {
      const kind = MEDIA_MODELS[words[1]]?.kind ?? (/video|t2v|i2v|horse/.test(words[1] ?? '') ? 'video' : 'image');
      return kind === 'video' ? t(L, 'led.video') : t(L, 'led.picture');
    }
    const model = words[0] === 'agent' || words[0] === 'stream' ? words[1] : words[0];
    return model ? `<code>${escapeHtml(model)}</code>` : t(L, 'led.turn');
  }
  const key = String(l.idem_key ?? '');
  if (l.kind === 'deposit_pcn') return t(L, 'led.pcn');
  if (l.kind === 'deposit_wpcn') return t(L, 'led.wpcn');
  if (l.kind === 'deposit_stars') return t(L, 'led.stars', { n: escapeHtml(String(l.note ?? '').replace(/ Telegram Stars$/, '')) });
  if (l.kind === 'gift') return t(L, 'led.gift');
  if (l.kind === 'referral') return t(L, 'led.referral');
  if (l.kind === 'grant') return t(L, 'led.grant');
  if (key.startsWith('stars-refund:')) return t(L, 'led.stars_refund');
  if (key.startsWith('rebate:')) return t(L, 'led.rebate');
  return t(L, 'led.adjust');
}

function balanceScreen(u) {
  const L = langOfUser(u);
  // A grant row moves nothing and no longer means anything; it is not shown.
  const led = db.prepare("SELECT * FROM ledger WHERE chat_id=? AND kind <> 'grant' ORDER BY id DESC LIMIT 10").all(u.chat_id);
  const lines = [t(L, 'bal.balance', { balance: balanceLabel(u.balance_micro_usd) })];
  if (u.reserved_micro_usd > 0) lines.push(t(L, 'bal.reserved', { amount: `$${escapeHtml(microUsdToString(u.reserved_micro_usd, 4))}` }));
  if (u.balance_micro_usd < 0) lines.push('', t(L, 'bal.negative'));
  if (led.length) {
    lines.push('', t(L, 'bal.recent'));
    for (const l of led) {
      const sign = l.delta_micro_usd >= 0 ? '+' : '−';
      lines.push(`· ${escapeHtml(whenLabel(L, l.created_at))} · ${ledgerLabel(l, L)} ${sign}$${escapeHtml(microUsdToString(Math.abs(l.delta_micro_usd), 4))}`);
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

async function sendAgentText(chatId, text, fallback, L = langOf(db, chatId)) {
  const html = text ? mdToHtml(text) : fallback;
  if (html) await tg.sendLong(chatId, html, { reply_markup: quickKeyboard(L) });
}

// One free chat turn: the agent talks, and may propose a card.
async function runChat(chatId, updateId, userContent) {
  const u = ensureUser(chatId);
  const L = langOfUser(u);
  const s = settings();
  const gate = chatGate(db, chatId, {
    perHour: s.chatPerHour, dailyBudget: s.chatDailyBudget, balanceMicro: u.balance_micro_usd,
    rateRemaining: oona.rateLimitRemaining, rlFloor: RL_FLOOR, lang: L,
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
    await tg.sendMessage(chatId, t(L, 'chat.unavailable'));
    return;
  }
  log.info('chat turn', { chat: chatTag(chatId), model: s.chatModel, ms: Date.now() - started, card: !!r.spec, failed: r.failed ?? null });

  if (r.failed === 'max_tokens') {
    await tg.sendMessage(chatId, t(L, 'chat.lost_thread'));
    appendHistory(db, chatId, [{ role: 'user', content: userContent }]);
    return;
  }

  let cardNote = null;
  if (r.spec) {
    let quote = null;
    try { quote = quoteSpec(offer[r.spec.model], r.spec, m); } catch (e) { log.warn('a proposal could not be priced', { chat: chatTag(chatId), ...errFields(e) }); }
    if (quote) {
      const created = createProposal(db, chatId, r.spec, quote, { ttlSec: s.cardTtlHours * 3600 });
      if (r.text) await sendAgentText(chatId, r.text, null, L);
      await sendCard(jobDeps(), created);
      const p = created.proposal;
      cardNote = `(Card P${p.id} shown: ${p.kind === 'video' ? `video ${p.seconds} s` : 'picture'}, ${p.shape} — "${p.summary}" — ${moneyLabel(p.price_micro)}; waiting for the user's ✅.)`;
    } else {
      await sendAgentText(chatId, r.text, t(L, 'chat.unpriced'), L);
      cardNote = '(The card could not be priced, so none was shown.)';
    }
  } else {
    await sendAgentText(chatId, r.text, r.failed === 'invalid' ? t(L, 'chat.invalid') : t(L, 'chat.ask'), L);
  }
  appendHistory(db, chatId, [
    { role: 'user', content: userContent },
    { role: 'assistant', content: [r.text, cardNote].filter(Boolean).join('\n\n') || '(no reply)' },
  ]);
}

// ✅ on a card: everything up to the reservation is synchronous (lib/jobs.mjs beginJob), then the
// job runs in the background.
function confirmCard(chatId, updateId, proposalId) {
  const L = langOf(db, chatId);
  const b = beginJob(db, { chatId, proposalId, offer: currentOffer(), marginE6: marginE6() });
  if (b.ok) {
    note(chatId, `(The user pressed ✅ on card P${proposalId}; it is being made.)`);
    const work = b.proposal.kind === 'image'
      ? runImageJob(jobDeps(), b, { draft: new DraftStream(tg, chatId, draftIdFor(updateId), { canStop: false }) })
      : startVideoJob(jobDeps(), b);
    track(work.then((text) => (text ? tg.sendMessage(chatId, text) : null))
      .catch((e) => log.error('studio job threw', { chat: chatTag(chatId), job: b.jobId, ...errFields(e) })));
    return b.proposal.kind === 'image' ? t(L, 'toast.making') : t(L, 'toast.starting_video');
  }
  const text = refusalText(b, L);
  track((async () => {
    if (b.short) {
      note(chatId, `(The user pressed ✅ on card P${proposalId}, but the balance was short.)`);
      await tg.sendMessage(chatId, text, { reply_markup: { inline_keyboard: [[{ text: t(L, 'btn.topup'), callback_data: 'nav:topup' }]] } });
    } else if (b.repriced !== undefined) {
      await setCardStatus(jobDeps(), proposalId, 'card.st.price_updated', { keepButtons: true });
      await tg.sendMessage(chatId, text);
    } else if (text) {
      await tg.sendMessage(chatId, text);
    }
  })().catch((e) => log.warn('card refusal could not be sent', errFields(e))));
  return b.short ? t(L, 'toast.short') : b.refused === 'started' || b.refused === 'raced' ? t(L, 'toast.already') : t(L, 'toast.not_made');
}

async function againCard(chatId, itemId) {
  const L = langOf(db, chatId);
  const s = settings();
  const spec = againSpec(db, { chatId, itemId, settings: s });
  if (!spec) { await tg.sendMessage(chatId, t(L, 'again.cannot')); return; }
  const offer = currentOffer();
  let quote;
  try { quote = quoteSpec(offer[spec.model], spec, marginE6()); } catch {
    await tg.sendMessage(chatId, t(L, 'again.unavailable'));
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
async function handleStarsPaid(chatId, sp, from = null) {
  const L = langOfUser(ensureUser(chatId, from));
  let r;
  try { r = creditStarsPayment(db, { chatId, sp }); } catch (e) { r = { refused: e.message }; }
  if (r.credited) {
    log.info('stars payment credited', { chat: chatTag(chatId), stars: r.stars, micro: Number(r.micro) });
    return t(L, 'stars.paid', { stars: r.stars, usd: moneyLabel(r.micro), balance: balanceLabel(r.balance) });
  }
  if (r.duplicate) return t(L, 'stars.dup', { balance: balanceLabel(r.balance) });
  log.error('STARS PAYMENT NOT CREDITED -- the user paid; credit or refund by hand', {
    chat: chatTag(chatId), stars: sp?.total_amount ?? null, charge: String(sp?.telegram_payment_charge_id ?? '').slice(0, 24), why: r.refused,
  });
  for (const a of ADMIN_CHATS) {
    tg.sendMessage(a, `⚠️ A Stars payment of ${escapeHtml(String(sp?.total_amount ?? '?'))} ⭐ from chat ${chatId} could not be credited: ${escapeHtml(String(r.refused))}. Credit or refund it on admin.pc.am → PcoinAiBot → Payments.`)
      .catch(() => undefined);
  }
  return t(L, 'stars.not_credited');
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
  return t(langOfUser(u), told ? 'support.passed' : 'support.failed');
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------
const COMMANDS = new Set([
  '/start', '/menu', '/help', '/models', '/model', '/balance', '/topup', '/paysupport',
  '/pcn', '/topup_pcn', '/wpcn', '/topup_wpcn', '/clear', '/stats', '/stop', '/invite', '/language', '/lang',
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
  if (msg.successful_payment) return handleStarsPaid(chatId, msg.successful_payment, msg.from);

  // Before the account exists, speak the language Telegram says they use.
  const guess = () => {
    const r = db.prepare('SELECT lang FROM users WHERE chat_id = ?').get(chatId);
    return isLang(r?.lang) ? r.lang : detectLang(msg.from?.language_code);
  };

  const pictures = collectPictures(msg);
  const text = (typeof msg.text === 'string' ? msg.text : (typeof msg.caption === 'string' ? msg.caption : '')).trim();
  if (text === '' && pictures.length === 0) {
    if (carriesOtherMedia(msg) || msg.sticker || msg.poll || msg.contact || msg.location || msg.venue || msg.dice) {
      return mayUse(chatId) ? t(guess(), 'msg.photos_only') : null;
    }
    return;
  }

  // DISPATCH ON EXACT MATCH OF THE FIRST TOKEN, so /topup_pcn cannot be
  // swallowed by /topup.
  const words = text.split(/\s+/);
  const first = words[0].split('@')[0];

  // THE ALLOW-LIST. Empty means the bot answers nobody -- that is the launch
  // gate, not a bug. Checked BEFORE an account (and its welcome gift) exists.
  if (!mayUse(chatId)) {
    return COMMANDS.has(first) || isTxHash(text) ? t(guess(), 'msg.not_open') : null;
  }

  // The account. An invite link opens the bot with "/start r<inviter>"; only the message that
  // CREATES the account can record it (lib/rewards.mjs).
  const acct = account(chatId, msg.from, first === '/start' ? parseInvite(words[1]) : null);
  const u = acct.user;
  const L = langOfUser(u);
  const fresh = acct.created ? acct : null;

  // Intercept a bare 0x + 64 hex ABOVE the agent even while wPCN is off: a
  // payment receipt is not a picture request.
  if (isTxHash(text)) {
    if (fresh) await showScreen(chatId, u, 'start', fresh);
    return handleTxHash(chatId, text, L);
  }

  switch (first) {
    case '/start':
    case '/menu':
      return showScreen(chatId, u, 'start', fresh);
    default:
      break;
  }
  // Someone new whose first message is not /start still sees what the bot does -- and their gift.
  if (fresh) await showScreen(chatId, u, 'start', fresh);

  switch (first) {
    case '/help':
      return showScreen(chatId, u, 'help');
    case '/balance':
      return showScreen(chatId, u, 'balance');
    case '/clear':
      return showScreen(chatId, u, 'clear');
    case '/invite':
      return showScreen(chatId, u, 'invite');
    case '/language':
    case '/lang':
      return showScreen(chatId, u, 'language');
    // Telegram caches the old menu per chat, so these still arrive for a while.
    case '/models':
    case '/model':
      return t(L, 'msg.no_models');
    case '/paysupport': {
      // The admin's own text if they wrote one; the built-in one is said in the user's language.
      const txt = settings().paySupportText;
      return txt.trim() === DEFAULT_PAY_SUPPORT.trim() ? t(L, 'paysupport.default') : escapeHtml(txt);
    }
    case '/stop':
      return t(L, 'msg.nothing_to_stop');
    case '/pcn':
    case '/topup_pcn':
      return showScreen(chatId, u, 'topup_pcn');
    case '/topup':
      return showScreen(chatId, u, 'topup');
    case '/wpcn':
    case '/topup_wpcn':
      return showScreen(chatId, u, 'topup_wpcn');
    case '/stats': {
      if (!ADMIN_CHATS.has(chatId)) return t(L, 'msg.no_command');
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
    return t(L, 'msg.no_command');
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
    return t(L, 'msg.got_photo', { ids: `#${uploaded.join(', #')}` });
  }
  const maxChars = settings().chatMaxChars;
  if (text.length > maxChars) {
    return t(L, 'msg.too_long', { n: maxChars });
  }

  const queued = enqueueChat(chatId, () => runChat(chatId, msg.__update_id, [...notes, text].join('\n')));
  if (!queued) return t(L, 'msg.busy');
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
//
// One list per language (commandsFor), published for each Telegram language_code, English as the
// default. A user who picks a language in the bot gets their own per-chat list (setLanguage).
// Telegram asks every bot that takes Stars to answer /paysupport.
async function publishCommands() {
  const r = await tg.setMyCommands(commandsFor('en'), { type: 'all_private_chats' });
  if (!r.ok) log.warn('setMyCommands (public) failed', { desc: r.description });
  for (const code of LANG_CODES.filter((c) => c !== 'en')) {
    const x = await tg.setMyCommands(commandsFor(code), { type: 'all_private_chats' }, code);
    if (!x.ok) log.warn('setMyCommands (language) failed', { lang: code, desc: x.description });
  }
  log.info('command menu published', { languages: LANG_CODES.length });

  // Admin commands are scoped to each admin's own chat, never global -- in the admin's language.
  for (const id of ADMIN_CHATS) {
    const a = await tg.setMyCommands(commandsFor(langOf(db, id), true), { type: 'chat', chat_id: id });
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
  const L = langOf(db, chatId);
  if (data.startsWith('mj:') && data.endsWith(':file')) {
    const j = db.prepare('SELECT * FROM media_jobs WHERE id = ? AND chat_id = ?').get(Number(data.split(':')[1]), chatId);
    if (j?.result_url && (j.result_expires_at ?? 0) > nowSec()) {
      try {
        const bytes = await media.download(j.result_url);
        await tg.sendDocument(chatId, bytes, { filename: `${j.model}-${j.id}.${j.kind === 'video' ? 'mp4' : 'png'}`, contentType: j.kind === 'video' ? 'video/mp4' : 'image/png' });
        return;
      } catch { /* fall through */ }
    }
    await tg.sendMessage(chatId, t(L, 'legacy.expired_file'));
    return;
  }
  await tg.sendMessage(chatId, t(L, 'legacy.old_button'), { reply_markup: quickKeyboard(L) });
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
  BOT_USERNAME = me.result.username ?? null;

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
          await tg.sendMessage(r.chatId, t(langOf(db, r.chatId), 'stars.refunded', { stars: r.stars, usd: moneyLabel(r.micro) })).catch(() => undefined);
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
        try { verdict = checkPreCheckout(db, q); } catch (e) { log.error('pre-checkout check threw', errFields(e)); verdict = { ok: false, error: t(detectLang(q.from?.language_code), 'pc.error') }; }
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
        // The pop-up's language: the user's, or Telegram's before they have an account.
        let L = detectLang(cq.from?.language_code);
        try {
          if (cid === null || !mayUse(cid)) {
            toast = t(L, 'toast.not_open');
          } else {
            L = langOfUser(ensureUser(cid, cq.from));
            if (/^sc:\d+$/.test(data)) {
              toast = confirmCard(cid, up.update_id, Number(data.slice(3)));
            } else if (/^st:\d+$/.test(data)) {
              // A Stars package: write the invoice, send it.
              toast = t(L, 'toast.opening_payment');
              track(sendStarsInvoice({ db, tg }, { chatId: cid, settings: settings(), index: Number(data.slice(3)) })
                .then((r) => (r.ok ? null : tg.sendMessage(cid, r.text)))
                .catch((e) => log.error('stars invoice threw', errFields(e))));
            } else if (/^sx:\d+$/.test(data)) {
              const id = Number(data.slice(3));
              if (cancelProposal(db, cid, id)) {
                toast = t(L, 'toast.cancelled');
                note(cid, `(The user cancelled card P${id}.)`);
                track(setCardStatus(jobDeps(), id, 'card.st.cancelled'));
              } else {
                toast = t(L, 'toast.card_closed');
              }
            } else if (/^ag:\d+$/.test(data)) {
              toast = t(L, 'toast.new_card');
              track(againCard(cid, Number(data.slice(3))).catch((e) => log.error('again threw', errFields(e))));
            } else if (/^of:\d+$/.test(data)) {
              toast = t(L, 'toast.sending_file');
              track(sendOriginal(jobDeps(), { chatId: cid, itemId: Number(data.slice(3)) })
                .then((text) => (text ? tg.sendMessage(cid, text) : null))
                .catch((e) => log.error('original file threw', errFields(e))));
            } else if (/^lang:[a-z]{2}$/.test(data)) {
              const code = data.slice(5);
              if (isLang(code)) {
                toast = `${LANGS[code].flag} ${LANGS[code].name}`;
                track(setLanguage(cid, code).catch((e) => log.error('language change threw', errFields(e))));
              }
            } else if (data.startsWith('nav:')) {
              // A menu button is the same screen its slash command shows.
              await showScreen(cid, ensureUser(cid, cq.from), data.slice(4));
            } else if (data.startsWith('mj:') || data.startsWith('m:') || data.startsWith('stop:')) {
              toast = data.startsWith('stop:') ? t(L, 'toast.nothing_to_stop') : '';
              track(legacyButton(cid, data).catch((e) => log.warn('legacy button threw', errFields(e))));
            }
          }
        } catch (e) {
          log.error('callback handler threw', errFields(e));
          toast = t(L, 'toast.error');
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
          try { await tg.sendMessage(msg.chat.id, t(langOf(db, msg.chat.id), 'msg.error')); }
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
