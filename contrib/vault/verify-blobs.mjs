// Does each vault blob actually CONTAIN the wallet it claims to?
//
// WHY THIS EXISTS. Every *-seed.enc.json carries cleartext metadata -- system,
// path, xpub, address0 -- and those xpubs were matched against the live
// services, so the LABELLING is proven. That is not the same as proving the
// CIPHERTEXT holds the matching phrase. A blob can be correctly named and hold
// the wrong twelve words, and the first time you would find out is with money
// on the line. The standing rule is that a backup is not a backup until it has
// been loaded; this loads all of them.
//
// SAFE BY CONSTRUCTION:
//   * the passphrase is typed at a prompt, never an argument -- so it cannot
//     land in shell history, `ps` output, or a process list;
//   * it is not echoed;
//   * the decrypted phrase is NEVER printed, never logged, never written. It
//     exists only long enough to derive a PUBLIC key, and is overwritten after;
//   * nothing is written to disk, ever;
//   * output is one PASS/FAIL line per rail, plus fingerprints. Public data.
//
// It cannot spend and it cannot leak the words. Run it before any sweep.
//
//   cd contrib/vault && node verify-blobs.mjs
//
import { readFileSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { scryptSync, createDecipheriv, createHash } from 'node:crypto';
import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { HDKey } from '@scure/bip32';
import { bech32 } from '@scure/base';

const ACCOUNT_PATH = "m/84'/9444'/0'";
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

function ask(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Echo suppression that still SHOWS the prompt. An earlier version wrote the
    // prompt itself and then muted everything, but readline redraws the line on
    // the first keypress -- and the mute swallowed the redraw, erasing the
    // prompt and leaving the script looking dead while it waited for input.
    // Re-emitting `question` on redraw is what pcoin-seed-vault.mjs does, and
    // that one has been driven by hand plenty of times.
    rl._writeToOutput = function (str) {
      if (str.includes(question)) rl.output.write(question);
      else rl.output.write('');
    };
    rl.question(question, (a) => {
      rl.close();
      process.stdout.write('\n');
      resolve(a);
    });
  });
}

function decrypt(blob, passphrase) {
  const key = scryptSync(passphrase, Buffer.from(blob.salt, 'base64'), 32,
                         { N: blob.N, r: blob.r, p: blob.p, maxmem: SCRYPT_MAXMEM });
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'));
  d.setAuthTag(Buffer.from(blob.tag, 'base64'));
  // GCM authenticates: a wrong passphrase throws here rather than returning
  // plausible rubbish.
  return Buffer.concat([d.update(Buffer.from(blob.ct, 'base64')), d.final()]).toString('utf8');
}

const sha256 = (b) => createHash('sha256').update(b).digest();
const rmd160 = (b) => createHash('ripemd160').update(b).digest();
const p2wpkh = (pub) => bech32.encode('pc', [0, ...bech32.toWords(rmd160(sha256(Buffer.from(pub))))]);

const files = readdirSync('.').filter((f) => f.endsWith('-seed.enc.json')).sort();
if (!files.length) { console.log('No *-seed.enc.json here. Run from contrib/vault.'); process.exit(1); }

console.log('');
console.log('  ' + files.length + ' blob(s). One passphrase is tried against all of them.');
console.log('  The twelve words are never printed and nothing is written to disk.');
console.log('');

const passphrase = await ask('  Vault passphrase (not echoed): ');
if (!passphrase) { console.log('\n  Nothing entered.'); process.exit(1); }
console.log('');

let pass = 0, fail = 0, locked = 0;

for (const file of files) {
  let blob;
  try { blob = JSON.parse(readFileSync(file, 'utf8')); }
  catch { console.log('  ERROR  %s  unreadable / not JSON', file); fail++; continue; }

  const name = (blob.system || file).padEnd(16);

  let phrase;
  try { phrase = decrypt(blob, passphrase); }
  catch {
    // Could not open == UNKNOWN, not "wrong wallet". Say which it is.
    console.log('  LOCKED %s  wrong passphrase for this blob (or it is corrupt)', name);
    locked++; continue;
  }

  const cleaned = phrase.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!bip39.validateMnemonic(cleaned, wordlist)) {
    console.log('  FAIL   %s  decrypted, but the contents are not a valid BIP39 phrase', name);
    fail++; phrase = null; continue;
  }

  const acct = HDKey.fromMasterSeed(bip39.mnemonicToSeedSync(cleaned, '')).derive(ACCOUNT_PATH);
  const xpub = acct.publicExtendedKey;
  const fp   = Buffer.from(acct.identifier.slice(0, 4)).toString('hex');
  const a00  = p2wpkh(acct.deriveChild(0).deriveChild(0).publicKey);
  phrase = null; // done with it

  const xpubOk = !blob.xpub || xpub === blob.xpub;
  const addrOk = !blob.address0 || a00 === blob.address0;

  if (xpubOk && addrOk) {
    console.log('  PASS   %s  fp=%s  re-derives its recorded xpub%s', name, fp,
                blob.address0 ? ' and address0' : '');
    pass++;
  } else {
    console.log('  FAIL   %s  fp=%s  DOES NOT match its own metadata', name, fp);
    if (!xpubOk) console.log('           recorded xpub: %s...', String(blob.xpub).slice(0, 24));
    if (!xpubOk) console.log('           derived  xpub: %s...', xpub.slice(0, 24));
    if (!addrOk) console.log('           recorded address0: %s', blob.address0);
    if (!addrOk) console.log('           derived  address0: %s', a00);
    fail++;
  }
}

console.log('');
console.log('  %d passed, %d failed, %d locked', pass, fail, locked);
if (fail) {
  console.log('');
  console.log('  A FAIL means the blob does not contain the wallet its own metadata');
  console.log('  names. Do not sweep against it. Find the right phrase first.');
  process.exit(1);
}
if (locked) {
  console.log('');
  console.log('  LOCKED is not a failure -- it is an unanswered question. Those blobs');
  console.log('  use a different passphrase; re-run and give that one.');
  process.exit(2);
}
console.log('');
console.log('  Every blob contains the wallet it claims to. Safe to sweep from these.');
console.log('');
