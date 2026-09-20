#!/usr/bin/env node
// Parse the panel's inline script AS IT WILL BE SERVED, not as it is written.
//
//   node check-inline-script.mjs            # check the source in this directory
//   node check-inline-script.mjs <url>      # ...and what a running panel serves
//
// WHY THIS EXISTS. The script is embedded in a JavaScript TEMPLATE LITERAL, so
// what reaches the browser is not what is in the file: the template eats one
// level of backslashes. On 2026-09-20 a regex /\[email/ was served as /[email/
// -- an unterminated character class -- and that one character took out the
// whole script, so the live filters stopped working and the Filter button came
// back. `node --check server.mjs` passes happily: the FILE is valid JavaScript.
// Only the rendered text is not.
//
// Nothing here executes the script; it is parsed with new Function, which
// compiles without running.
import { readFileSync } from 'node:fs';

const SRC = new URL('./server.mjs', import.meta.url);
let bad = 0;

function parses(what, js) {
  try {
    new Function(js);                       // compiles, never runs
    console.log(`  OK    ${what} parses (${js.length} chars)`);
    return true;
  } catch (e) {
    console.log(`  FAIL  ${what}: ${e.message}`);
    bad++;
    return false;
  }
}

const src = readFileSync(SRC, 'utf8');
const m = src.match(/<script>([\s\S]*?)<\/script>/);
if (!m) {
  console.log('  FAIL  no inline <script> found in server.mjs');
  process.exit(1);
}
parses('the script as WRITTEN', m[1]);

// Render it the way Node will when the shell template is evaluated. Escaping
// only the backtick and ${ keeps the text intact while making it a literal.
const rendered = new Function('return `' + m[1].replace(/`/g, '\\`').replace(/\$\{/g, '\\${') + '`;')();
parses('the script as SERVED', rendered);

const slashes = (rendered.match(/\\/g) || []).length;
console.log(`  note  backslashes surviving into the served script: ${slashes}` +
  (slashes ? '  <-- each one is a place the template already ate one; check it' : ''));

const url = process.argv[2];
if (url) {
  const res = await fetch(url, { redirect: 'follow' });
  const html = await res.text();
  const live = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((x) => x[1]);
  console.log(`  note  ${url} -> HTTP ${res.status}, ${live.length} inline script(s)`);
  live.forEach((js, i) => parses(`live script ${i}`, js));
}

process.exit(bad ? 1 : 0);
