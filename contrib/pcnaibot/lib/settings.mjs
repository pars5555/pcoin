// The studio's settings: which model chats, which draws, which films (owner, 2026-09-26: "we put
// the model settings in the bot admin settings section and admin will choose").
//
// Stored in the bot's own kv table and changed only through the loopback admin API. A missing or
// partial row falls back to the defaults below, so a fresh install works with no admin step.

import { kvGetJson, kvSetJson } from './db.mjs';
import { MEDIA_MODELS } from './media.mjs';

export const SETTINGS_KEY = 'studio:settings';

export const DEFAULT_SETTINGS = Object.freeze({
  chatModel: 'mimo-v2.5',
  pictureModel: 'wan2.7-image-pro',
  videoModel: 'happyhorse-1.1',
  videoSeconds: 5,
  videoResolution: '720P',
  // A real video-edit model, once OonaCode serves one. Empty: "change this video" makes a new
  // version from the same starting point.
  videoEditModel: '',
});

export function getSettings(db) {
  const stored = kvGetJson(db, SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(stored && typeof stored === 'object' ? stored : {}) };
}

// Check a candidate against what can actually be served. `offer` is mediaOffer() of OonaCode's
// live list; `chatChoices` the chat models the admin may pick. Returns a list of problems.
export function settingsProblems(s, { offer, chatChoices }) {
  const bad = [];
  if (!chatChoices.includes(s.chatModel)) bad.push(`chat model ${s.chatModel} is not one of ${chatChoices.join(', ')}`);

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
    if (!Number.isInteger(s.videoSeconds) || s.videoSeconds < min || s.videoSeconds > max) {
      bad.push(`video length must be a whole number of seconds from ${min} to ${max}`);
    }
  }
  if (s.videoEditModel !== '') bad.push('no video-edit model is served yet; leave it empty');
  return bad;
}

export function saveSettings(db, s) {
  const clean = {};
  for (const k of Object.keys(DEFAULT_SETTINGS)) clean[k] = s[k];
  kvSetJson(db, SETTINGS_KEY, clean);
  return clean;
}

// The media entries the admin may choose from, in the catalogue's order.
export const mediaChoices = (offer, kind) => Object.keys(MEDIA_MODELS).filter((id) => offer[id]?.info.kind === kind);
