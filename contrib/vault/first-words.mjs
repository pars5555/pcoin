// Which paper card is which rail? Show just enough to tell them apart.
//
// WHY THIS EXISTS. `restore` prints all twelve words -- correct when you are
// about to sign, far too much when you only need to label a stack of paper.
// This prints the FIRST word of each wallet (and its account fingerprint), so
// a card can be matched to a rail at a glance.
//
// ON THE LEAK. One BIP39 word is 11 bits. Revealing it takes a 12-word phrase
// from 128 bits of entropy to about 117 -- still astronomically out of reach,
// so a single word on screen is not a meaningful weakening. That stops being
// true as you raise --words: at 8 or 9 the remainder is no longer a wall, and
// at 11 the checksum can finish the job for an attacker. The cap below is
// deliberate, and the warning above 3 is deliberate too.
//
// SAFE BY CONSTRUCTION: passphrase typed at a prompt (never an argument, so it
// cannot reach shell history or a process list), not echoed; nothing written to
// disk, ever; the rest of the phrase is never printed.
//
//   cd contrib/vault && node first-words.mjs [--words N] [--last]
//
import { readFileSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { scryptSync, createDecipheriv } from 'node:crypto';
import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { HDKey } from '@scure/bip32';

const NL = String.fromCharCode(10);   // built, not escaped, so transit cannot mangle it
const ACCOUNT_PATH = "m/84'/9444'/0'";
const MAXMEM = 256 * 1024 * 1024;
const MAX_WORDS = 4;

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const showLast = argv.includes('--last');
let n = parseInt(flag('--words') || '1', 10);
if (!Number.isFinite(n) || n < 1) n = 1;
if (n > MAX_WORDS) {
  console.log(NL + '  --words is capped at ' + MAX_WORDS + '. Past that you are not labelling a card,');
  console.log('  you are reading out the wallet -- use `pcoin-seed-vault.mjs restore` and');
  console.log('  mean it.' + NL);
  process.exit(2);
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Re-emit the prompt on redraw. Writing it once and muting everything looks
    // identical until you use a real terminal, where readline's redraw erases it.
    rl._writeToOutput = function (str) {
      if (str.includes(question)) rl.output.write(question);
      else rl.output.write('');
    };
    rl.question(question, (a) => { rl.close(); process.stdout.write(NL); resolve(a); });
  });
}

function decrypt(blob, passphrase) {
  const key = scryptSync(passphrase, Buffer.from(blob.salt, 'base64'), 32,
                         { N: blob.N, r: blob.r, p: blob.p, maxmem: MAXMEM });
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'));
  d.setAuthTag(Buffer.from(blob.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(blob.ct, 'base64')), d.final()]).toString('utf8');
}

const files = readdirSync('.').filter((f) => f.endsWith('-seed.enc.json')).sort();
if (!files.length) { console.log('No *-seed.enc.json here. Run from contrib/vault.'); process.exit(1); }

console.log('');
console.log('  Showing the first ' + n + ' word' + (n > 1 ? 's' : '') + ' of ' + files.length + ' wallet(s)'
            + (showLast ? ', plus the last one' : '') + '.');
if (n > 3) console.log('  That is a lot to put on a screen. Close this window when you are done.');
console.log('  The rest of each phrase is never printed and nothing is written to disk.');
console.log('');

const pass = await ask('  Vault passphrase (not echoed): ');
if (!pass) { console.log('  Nothing entered.'); process.exit(1); }
console.log('');

let shown = 0, locked = 0, bad = 0;
for (const file of files) {
  let blob;
  try { blob = JSON.parse(readFileSync(file, 'utf8')); }
  catch { console.log('  ERROR  %s  unreadable / not JSON', file); bad++; continue; }
  const name = (blob.system || file.replace('-seed.enc.json', '')).padEnd(16);

  let phrase;
  try { phrase = decrypt(blob, pass); }
  catch {
    // Not "wrong wallet" -- an unanswered question. Different passphrase, maybe.
    console.log('  LOCKED %s  not this passphrase', name);
    locked++; continue;
  }

  const words = phrase.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim().split(' ');
  if (!bip39.validateMnemonic(words.join(' '), wordlist)) {
    console.log('  BAD    %s  decrypted, but not a valid BIP39 phrase', name);
    bad++; phrase = null; continue;
  }

  const fp = Buffer.from(
    HDKey.fromMasterSeed(bip39.mnemonicToSeedSync(words.join(' '), '')).derive(ACCOUNT_PATH)
         .identifier.slice(0, 4)).toString('hex');

  const head = words.slice(0, n).join(' ');
  const tail = showLast ? '  ...  ' + words[words.length - 1] : '';
  console.log('  %s fp=%s  %d words  |  %s%s', name, fp, words.length, head, tail);
  phrase = null; words.length = 0;
  shown++;
}

console.log('');
console.log('  %d shown, %d locked, %d unreadable', shown, locked, bad);
if (locked) console.log('  LOCKED is not a failure -- those use a different passphrase. Re-run with it.');
console.log('');
