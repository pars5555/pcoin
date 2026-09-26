// The studio's settings -- every knob the admin turns on admin.pc.am → PcoinAiBot (owner,
// 2026-09-26: "separate subsections for the chat agent prompt and every configuration ... everything
// in admin"). Stored in the bot's own kv table and changed only through the loopback admin API. A
// missing or partial row falls back to the defaults below, so a fresh install needs no admin step.
//
//   Chat agent        chatModel, chatPrompt ('' = the built-in instructions), chatPerHour,
//                     chatDailyBudget, chatMaxChars, historyMax
//   Pictures & video  pictureModel, videoModel, videoSeconds, videoResolution, videoEditModel,
//                     margin (our price = OonaCode's x margin), cardTtlHours
//   Payments          starsEnabled, starsPackages [{usd, stars}], paySupportText
//   Gifts & invites   giftEnabled, giftUsd, invitesEnabled, inviteRewardUsd, inviteMinTopupUsd

import { kvGetJson, kvSetJson } from './db.mjs';
import { MEDIA_MODELS } from './media.mjs';

export const SETTINGS_KEY = 'studio:settings';

// /paysupport (Telegram asks every bot that takes Stars to answer it). A message starting with
// SUPPORT is passed to the admins instead of the chat agent (bot.mjs).
export const DEFAULT_PAY_SUPPORT = 'Problems with a payment? Send a message here that starts with SUPPORT and say what happened and when — it goes to the people who run this bot. A Stars payment you have not spent can be refunded.';

export const DEFAULT_SETTINGS = Object.freeze({
  chatModel: 'mimo-v2.5',
  chatPrompt: '',
  chatPerHour: 120,
  chatDailyBudget: 5000,
  chatMaxChars: 2000,
  historyMax: 24,
  pictureModel: 'wan2.7-image-pro',
  videoModel: 'happyhorse-1.1',
  videoSeconds: 5,
  videoResolution: '720P',
  // A real video-edit model, once OonaCode serves one. Empty: "change this video" makes a new
  // version from the same starting point.
  videoEditModel: '',
  margin: 3,
  cardTtlHours: 24,
  starsEnabled: true,
  // webbuilderbot's packages (50 Stars per USD).
  starsPackages: [{ usd: 5, stars: 250 }, { usd: 10, stars: 500 }, { usd: 25, stars: 1250 }, { usd: 50, stars: 2500 }],
  paySupportText: DEFAULT_PAY_SUPPORT,
  // Free money (lib/rewards.mjs; owner, 2026-09-26). The gift goes to every NEW account once; the
  // invite reward to the inviter once per invited person, when that person's video is delivered
  // after they have topped up at least inviteMinTopupUsd. No caps, by the owner's decision.
  giftEnabled: true,
  giftUsd: 3,
  invitesEnabled: true,
  inviteRewardUsd: 2,
  inviteMinTopupUsd: 1,
});

// `base` lets the process's own config supply a default (the margin lived in pcnaibot.conf before
// it moved here); what the admin stored always wins.
export function getSettings(db, base = {}) {
  const stored = kvGetJson(db, SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...base, ...(stored && typeof stored === 'object' ? stored : {}) };
}

const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

// Check a candidate against what can actually be served. `offer` is mediaOffer() of OonaCode's
// live list; `chatChoices` the chat models the admin may pick. Returns a list of problems.
export function settingsProblems(s, { offer, chatChoices }) {
  const bad = [];
  if (!chatChoices.includes(s.chatModel)) bad.push(`chat model ${s.chatModel} is not one of ${chatChoices.join(', ')}`);
  if (typeof s.chatPrompt !== 'string' || s.chatPrompt.length > 20000) bad.push('the chat instructions must be text under 20,000 characters (empty = the built-in ones)');
  if (!int(s.chatPerHour, 1, 10000)) bad.push('chat messages per hour must be a whole number from 1 to 10,000');
  if (!int(s.chatDailyBudget, 0, 1000000)) bad.push('the daily free chat budget must be a whole number from 0 to 1,000,000');
  if (!int(s.chatMaxChars, 100, 10000)) bad.push('the longest message must be 100 to 10,000 characters');
  if (!int(s.historyMax, 2, 100)) bad.push('the remembered conversation must be 2 to 100 messages');

  const pic = offer[s.pictureModel];
  if (!pic || pic.info.kind !== 'image') bad.push(`picture model ${s.pictureModel} is not on sale`);
  const vid = offer[s.videoModel];
  if (!vid || vid.info.kind !== 'video') {
    bad.push(`video model ${s.videoModel} is not on sale`);
  } else {
    const tiers = Object.keys(vid.t2v.pricing?.tiers ?? {});
    if (!tiers.includes(s.videoResolution)) bad.push(`${s.videoModel} has no ${s.videoResolution} price (it has ${tiers.join(', ')})`);
    const d = vid.t2v.limits?.durations;
    const min = Number(d?.min ?? 1), max = Number(d?.max ?? 15);
    if (!int(s.videoSeconds, min, max)) bad.push(`video length must be a whole number of seconds from ${min} to ${max}`);
  }
  if (s.videoEditModel !== '') bad.push('no video-edit model is served yet; leave it empty');
  // Below 1 we would sell under cost; above 20 is almost certainly a typo (30 for 3.0).
  if (!(typeof s.margin === 'number' && Number.isFinite(s.margin) && s.margin >= 1 && s.margin <= 20)) bad.push('the margin must be a number from 1 to 20 (3 = three times OonaCode\'s price)');
  if (!int(s.cardTtlHours, 1, 720)) bad.push('a card must stay open 1 to 720 hours');

  if (typeof s.starsEnabled !== 'boolean') bad.push('Stars on/off must be true or false');
  if (!Array.isArray(s.starsPackages) || s.starsPackages.length > 8) {
    bad.push('Stars packages must be a list of at most 8');
  } else {
    for (const p of s.starsPackages) {
      if (!(p && Number.isFinite(p.usd) && p.usd >= 0.5 && p.usd <= 1000 && Math.round(p.usd * 100) === p.usd * 100)) bad.push(`a package's USD must be 0.50 to 1000, in cents (got ${JSON.stringify(p?.usd)})`);
      if (!(p && int(p.stars, 1, 100000))) bad.push(`a package's Stars must be a whole number from 1 to 100,000 (got ${JSON.stringify(p?.stars)})`);
    }
    if (s.starsEnabled && s.starsPackages.length === 0) bad.push('Stars are on but there is no package to buy');
  }
  if (typeof s.paySupportText !== 'string' || !s.paySupportText.trim() || s.paySupportText.length > 1000) bad.push('the payment support text must be 1 to 1,000 characters');

  // Free money is created by these numbers, so a typo is bounded: $20 (not $300 for $3.00).
  const cents = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi && Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;
  if (typeof s.giftEnabled !== 'boolean') bad.push('the welcome gift on/off must be true or false');
  if (!cents(s.giftUsd, 0, 20)) bad.push('the welcome gift must be $0 to $20, in cents');
  if (typeof s.invitesEnabled !== 'boolean') bad.push('invites on/off must be true or false');
  if (!cents(s.inviteRewardUsd, 0, 20)) bad.push('the invite reward must be $0 to $20, in cents');
  if (!cents(s.inviteMinTopupUsd, 0, 1000)) bad.push('the top-up an invited person must make must be $0 to $1,000, in cents');
  return bad;
}

export function saveSettings(db, s) {
  const clean = {};
  for (const k of Object.keys(DEFAULT_SETTINGS)) clean[k] = s[k];
  kvSetJson(db, SETTINGS_KEY, clean);
  return clean;
}

// Turn what a form sent into typed settings on top of the current ones. Unknown keys are dropped;
// a field left out keeps its value.
export function mergeSettingsInput(cur, input) {
  const next = { ...cur };
  const str = ['chatModel', 'chatPrompt', 'pictureModel', 'videoModel', 'videoResolution', 'videoEditModel', 'paySupportText'];
  const num = ['chatPerHour', 'chatDailyBudget', 'chatMaxChars', 'historyMax', 'videoSeconds', 'margin', 'cardTtlHours',
    'giftUsd', 'inviteRewardUsd', 'inviteMinTopupUsd'];
  for (const k of str) if (typeof input[k] === 'string') next[k] = input[k];
  for (const k of num) if (input[k] !== undefined && input[k] !== '') next[k] = Number(input[k]);
  for (const k of ['starsEnabled', 'giftEnabled', 'invitesEnabled']) {
    if (input[k] !== undefined) next[k] = input[k] === true || input[k] === 'true' || input[k] === 'on';
  }
  if (Array.isArray(input.starsPackages)) {
    next.starsPackages = input.starsPackages.map((p) => ({ usd: Number(p?.usd), stars: Number(p?.stars) }));
  }
  if (input.chatPromptReset === true || input.chatPromptReset === 'true') next.chatPrompt = '';
  return next;
}

// The media entries the admin may choose from, in the catalogue's order.
export const mediaChoices = (offer, kind) => Object.keys(MEDIA_MODELS).filter((id) => offer[id]?.info.kind === kind);
