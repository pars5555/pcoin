// The bot's languages (lib/i18n.mjs, lib/locales/*).
//
// Pinned:
//   * every language has exactly English's keys, with the same placeholders, the same HTML tags and
//     the literal commands / SUPPORT / #N kept (test/locale-check.mjs);
//   * every key the code asks for exists in English (a missing one would show a user its name);
//   * Telegram's language_code maps to ours, anything else to English;
//   * a menu label in ANY language is recognised, and no two actions share a label.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { t, detectLang, LANG_CODES, DICTS, everyLabel, whenLabel } from '../lib/i18n.mjs';
import { compareLocale } from './locale-check.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('every language has every text, with the same placeholders, tags and literals', () => {
  for (const code of LANG_CODES) {
    if (code === 'en') continue;
    assert.deepEqual(compareLocale(DICTS.en, DICTS[code]), [], code);
  }
  assert.deepEqual(readdirSync(join(ROOT, 'lib', 'locales')).map((f) => f.replace('.mjs', '')).sort(), [...LANG_CODES].sort());
});

test('every key the code uses exists in English, and every English key is used', () => {
  const files = ['bot.mjs', 'watch.mjs', ...readdirSync(join(ROOT, 'lib')).filter((f) => f.endsWith('.mjs')).map((f) => join('lib', f))];
  const src = files.map((f) => readFileSync(join(ROOT, f), 'utf8')).join('\n');
  const used = new Set([...src.matchAll(/\bt\(\s*[\w.?()]+\s*,\s*'([a-z_]+\.[a-z_.]+)'/g)].map((m) => m[1]));
  // Keys built at run time: refuse.<reason>, fail.<what>.<how>, pcn.st.<status>, shape.<shape>,
  // kb.<action>, cmd.<command>, card.st.<status> (passed to setCardStatus).
  const dynamic = /^(refuse|fail|pcn\.st|shape|kb|cmd|card\.st)\./;
  for (const k of used) assert.ok(Object.hasOwn(DICTS.en, k), `the code asks for ${k}, which en.mjs does not have`);
  for (const m of src.matchAll(/setCardStatus\([^,]+,[^,]+,\s*'([a-z_.]+)'/g)) assert.ok(Object.hasOwn(DICTS.en, m[1]), m[1]);
  const unused = Object.keys(DICTS.en).filter((k) => !used.has(k) && !dynamic.test(k) && !src.includes(`'${k}'`));
  assert.deepEqual(unused, [], 'texts nothing uses');
});

test('t() fills placeholders, leaves unknown ones, and falls back to English', () => {
  assert.equal(t('en', 'invite.joined', { n: 3 }), 'Joined: <b>3</b>');
  assert.equal(t('en', 'invite.joined'), 'Joined: <b>{n}</b>');
  assert.equal(t('xx', 'kb.help'), DICTS.en['kb.help']);
  assert.equal(t('en', 'no.such.key'), 'no.such.key');
  assert.notEqual(t('hy', 'kb.help'), t('en', 'kb.help'), 'Armenian is not English');
});

test("Telegram's language_code picks our language, or English", () => {
  assert.equal(detectLang('hy'), 'hy');
  assert.equal(detectLang('ru-RU'), 'ru');
  assert.equal(detectLang('es_MX'), 'es');
  assert.equal(detectLang('pt-br'), 'en');
  assert.equal(detectLang(undefined), 'en');
  assert.equal(detectLang(''), 'en');
});

test('menu labels are distinct across actions in every language', () => {
  const owner = new Map();
  for (const k of ['balance', 'topup', 'invite', 'language', 'clear', 'help']) {
    for (const label of everyLabel(`kb.${k}`)) {
      assert.ok(!owner.has(label) || owner.get(label) === k, `"${label}" means both ${owner.get(label)} and ${k}`);
      owner.set(label, k);
    }
  }
});

test('dates are UTC with Latin digits in every language', () => {
  for (const code of LANG_CODES) {
    const s = whenLabel(code, 1790000000);
    assert.match(s, /\d/, code);
    assert.doesNotMatch(s, /[٠-٩۰-۹]/, `${code}: ${s}`);
  }
});
