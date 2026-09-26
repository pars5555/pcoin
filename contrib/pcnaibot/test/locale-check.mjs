// Compare a locale with English. Used by test/i18n.test.mjs, and runnable on its own (it needs no
// database, so it runs anywhere node does):
//
//   node test/locale-check.mjs ru        one language
//   node test/locale-check.mjs           every language (also what `node --test test/` runs)
//
// Prints the problems and exits 1, or prints "ok" and exits 0.
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { readdirSync } from 'node:fs';

const TAG = /<\/?(b|i|code|a)\b[^>]*>/g;
const VAR = /\{(\w+)\}/g;
// Things the bot matches literally or the user must type exactly: they may not be translated.
const LITERALS = [/\/(invite|help|topup|paysupport|language|start)\b/g, /\bSUPPORT\b/g, /#\{?\w+\}?/g, /\b0x\b/g, /\bPCN\b/g, /\bwPCN\b/g];

const sorted = (a) => [...a].sort();
const all = (re, s) => [...String(s).matchAll(re)].map((m) => m[0]);

export function compareLocale(en, other) {
  const bad = [];
  for (const k of Object.keys(en)) {
    if (!Object.hasOwn(other, k)) { bad.push(`${k}: missing`); continue; }
    const e = en[k], o = other[k];
    if (typeof o !== 'string' || !o.trim()) { bad.push(`${k}: empty or not text`); continue; }
    if (JSON.stringify(sorted(all(VAR, e))) !== JSON.stringify(sorted(all(VAR, o)))) bad.push(`${k}: placeholders differ (en ${all(VAR, e).join(' ') || 'none'} / here ${all(VAR, o).join(' ') || 'none'})`);
    if (JSON.stringify(sorted(all(TAG, e))) !== JSON.stringify(sorted(all(TAG, o)))) bad.push(`${k}: HTML tags differ (en ${all(TAG, e).join('') || 'none'} / here ${all(TAG, o).join('') || 'none'})`);
    for (const re of LITERALS) {
      const need = all(re, e);
      const have = all(re, o);
      for (const x of new Set(need)) {
        if (have.filter((y) => y === x).length < need.filter((y) => y === x).length) bad.push(`${k}: "${x}" must stay exactly as in English`);
      }
    }
    if (/[<>]/.test(o.replace(TAG, '')) && !/[<>]/.test(e.replace(TAG, ''))) bad.push(`${k}: a stray < or > (Telegram rejects the message)`);
    if (k.startsWith('kb.') && [...o].length > 32) bad.push(`${k}: a menu button is at most 32 characters (${[...o].length})`);
    if (k.startsWith('btn.') && [...o].length > 40) bad.push(`${k}: a button is at most 40 characters (${[...o].length})`);
    if (k.startsWith('toast.') && [...o].length > 190) bad.push(`${k}: a pop-up is at most 190 characters`);
    if (k.startsWith('cmd.') && ([...o].length < 3 || [...o].length > 256)) bad.push(`${k}: a command description is 3 to 256 characters`);
    if (k.startsWith('pc.') && /[<>]/.test(o)) bad.push(`${k}: payment errors are plain text`);
  }
  for (const k of Object.keys(other)) if (!Object.hasOwn(en, k)) bad.push(`${k}: not in English (remove it)`);
  // Two menu buttons with the same label would make the keyboard ambiguous.
  const kb = Object.keys(en).filter((k) => k.startsWith('kb.')).map((k) => other[k]);
  if (new Set(kb).size !== kb.length) bad.push('two kb.* labels are the same');
  return bad;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'locales');
  const codes = process.argv[2] ? [process.argv[2]]
    : readdirSync(dir).filter((f) => f.endsWith('.mjs') && f !== 'en.mjs').map((f) => f.slice(0, -4));
  const en = (await import(pathToFileURL(join(dir, 'en.mjs')).href)).default;
  let failed = false;
  for (const code of codes) {
    const other = (await import(pathToFileURL(join(dir, `${code}.mjs`)).href)).default;
    const bad = compareLocale(en, other);
    if (bad.length) { failed = true; console.log(`${code}:\n  ${bad.join('\n  ')}`); }
    else console.log(`ok: ${code} has all ${Object.keys(en).length} texts`);
  }
  if (failed) process.exit(1);
}
