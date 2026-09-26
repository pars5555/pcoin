// The languages the bot speaks (owner, 2026-09-26: "we need multilingual same as webcrafter").
//
// webbuilderbot's eight, chosen the same way: Telegram's language_code when the account is created,
// then whatever the user picks (/language, 🌐 on the menu). Stored in users.lang; the watcher, a
// separate process, reads the same column.
//
// Texts live in lib/locales/<code>.mjs, one object per language with the SAME keys as en.mjs --
// test/i18n.test.mjs refuses a missing key, a key English does not have, a placeholder that differs,
// or HTML tags that differ. {name} placeholders are filled by t(); values are inserted as given, so
// the caller escapes anything that came from a user.
//
// A missing text falls back to English, never to the key's name (webbuilderbot showed users raw
// keys when a row was missing).
//
// The chat agent is NOT driven from here: it answers in the language of the user's latest message
// (lib/studio.mjs), which is what people expect of a conversation. These texts are the bot's own
// screens, buttons, cards and notices.

import en from './locales/en.mjs';
import ru from './locales/ru.mjs';
import hy from './locales/hy.mjs';
import fa from './locales/fa.mjs';
import ar from './locales/ar.mjs';
import fr from './locales/fr.mjs';
import de from './locales/de.mjs';
import es from './locales/es.mjs';

export const LANGS = Object.freeze({
  en: { name: 'English', flag: '🇬🇧', locale: 'en-GB' },
  ru: { name: 'Русский', flag: '🇷🇺', locale: 'ru-RU' },
  hy: { name: 'Հայերեն', flag: '🇦🇲', locale: 'hy-AM' },
  fa: { name: 'فارسی', flag: '🇮🇷', locale: 'fa-IR-u-nu-latn' },
  ar: { name: 'العربية', flag: '🇸🇦', locale: 'ar-u-nu-latn' },
  fr: { name: 'Français', flag: '🇫🇷', locale: 'fr-FR' },
  de: { name: 'Deutsch', flag: '🇩🇪', locale: 'de-DE' },
  es: { name: 'Español', flag: '🇪🇸', locale: 'es-ES' },
});
export const LANG_CODES = Object.keys(LANGS);
export const DICTS = Object.freeze({ en, ru, hy, fa, ar, fr, de, es });

export const isLang = (code) => typeof code === 'string' && Object.hasOwn(LANGS, code);

// Telegram's language_code ('ru', 'pt-br', 'hy') -> one of ours, or English.
export function detectLang(languageCode) {
  const c = String(languageCode ?? '').toLowerCase().split(/[-_]/)[0];
  return isLang(c) ? c : 'en';
}

export function t(lang, key, vars = {}) {
  let s = DICTS[isLang(lang) ? lang : 'en'][key];
  if (typeof s !== 'string') s = en[key];
  if (typeof s !== 'string') return key; // a programming error; the i18n test makes it unreachable
  return s.replace(/\{(\w+)\}/g, (m, k) => (Object.hasOwn(vars, k) && vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : m));
}

// The language of a chat, from its user row. Unknown -> English.
export function langOf(db, chatId) {
  const r = db.prepare('SELECT lang FROM users WHERE chat_id = ?').get(chatId);
  return isLang(r?.lang) ? r.lang : 'en';
}

// A button label in every language -- the menu keyboard sends its label back as text, and a user
// who switched language may still tap a keyboard drawn in the old one.
export function everyLabel(key) {
  return new Set(LANG_CODES.map((c) => t(c, key)));
}

// "26 Sep 14:05" in the user's language, UTC, Latin digits.
export function whenLabel(lang, sec) {
  try {
    return new Intl.DateTimeFormat(LANGS[isLang(lang) ? lang : 'en'].locale, {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC',
    }).format(new Date(sec * 1000));
  } catch {
    return new Date(sec * 1000).toISOString().slice(5, 16).replace('T', ' ');
  }
}
