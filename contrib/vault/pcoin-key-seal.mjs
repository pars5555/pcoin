#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// pcoin-key-seal — seal an arbitrary secret FILE into the same .enc.json blob
// format pcoin-seed-vault.mjs produces, so it can sit on the vault hosts.
// ═══════════════════════════════════════════════════════════════════════════
//
// WHY THIS EXISTS SEPARATELY FROM pcoin-seed-vault.mjs
// That tool creates and seals a BIP39 *seed phrase*: it derives an account
// xpub, checks a published vector, and refuses anything that is not twelve
// words. Some secrets are not seed phrases. `/etc/pcoin/keeper.conf` holds a
// raw EVM private key; there are also bearer tokens and API secrets. They need
// the same protection and none of the derivation.
//
// WHO RUNS THIS — the same rule as the seed vault, for the same reason.
// The OWNER, in their own terminal. Not an assistant, not CI, not over a remote
// shell. The passphrase is TYPED, never passed as an argument: argv is visible
// in `ps` to every user on the box and lands in shell history at both ends.
// This tool cannot be run non-interactively on purpose.
//
// WHAT IT PRODUCES
//   <name>.enc.json   scrypt(N=2^17) + AES-256-GCM, byte-compatible with the
//                     seed vault's blobs, so one passphrase habit covers both
//                     and `verify` behaves identically.
//
// WHY ENCRYPTED
// A plaintext key on a vault host means a breach of that host spends the money.
// Encrypted, the same breach yields a blob. That is the entire argument, and it
// is why a plaintext copy is a stopgap and not a destination.
//
// USAGE
//   node pcoin-key-seal.mjs --selftest
//   node pcoin-key-seal.mjs seal   --in keeper.conf --out wpcn-keeper.enc.json
//   node pcoin-key-seal.mjs verify --file wpcn-keeper.enc.json
//   node pcoin-key-seal.mjs open   --file wpcn-keeper.enc.json [--out restored]
//
// `verify` proves the passphrase opens the blob and that the plaintext matches
// the recorded sha256 — WITHOUT printing the secret. Run it after every copy.
// A backup nobody has opened is a hope, not a backup.

import { createHash, randomBytes, scryptSync, createCipheriv, createDecipheriv,
         timingSafeEqual } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

function die(m) { console.error('\n  ' + m + '\n'); process.exit(1); }

// Identical parameters to pcoin-seed-vault.mjs. Deliberately expensive: the
// passphrase is the only thing between a stolen blob and the money.
const SCRYPT = { N: 1 << 17, r: 8, p: 1, keylen: 32, maxmem: 256 * 1024 * 1024 };

function encrypt(plaintext, passphrase) {
  const salt = randomBytes(16);
  const key = scryptSync(passphrase, salt, SCRYPT.keylen, SCRYPT);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return {
    v: 1, kdf: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
    salt: salt.toString('base64'), iv: iv.toString('base64'),
    ct: ct.toString('base64'), tag: c.getAuthTag().toString('base64'),
  };
}

function decrypt(blob, passphrase) {
  const key = scryptSync(passphrase, Buffer.from(blob.salt, 'base64'), SCRYPT.keylen,
                         { N: blob.N, r: blob.r, p: blob.p, maxmem: SCRYPT.maxmem });
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'));
  d.setAuthTag(Buffer.from(blob.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(blob.ct, 'base64')), d.final()]).toString('utf8');
}

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = function (str) {
        if (str.includes(question)) rl.output.write(question); else rl.output.write('');
      };
    }
    rl.question(question, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a); });
  });
}

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
const sha = (s) => createHash('sha256').update(s).digest('hex');

// ── selftest ───────────────────────────────────────────────────────────────
// Proves the round trip AND proves a wrong passphrase FAILS. A decrypt that
// silently returned garbage would be worse than no backup, because it would
// pass a casual check.
function selftest() {
  let n = 0, bad = 0;
  const ok = (label, cond) => { n++; if (!cond) { bad++; console.log('  FAIL  ' + label); } else console.log('  ok    ' + label); };

  const secret = 'KEEPER_PRIVATE_KEY=0x' + 'ab'.repeat(32) + '\n';
  const blob = encrypt(secret, 'correct horse battery staple');
  ok('blob declares v/kdf/N', blob.v === 1 && blob.kdf === 'scrypt' && blob.N === (1 << 17));
  ok('ciphertext is not the plaintext', !Buffer.from(blob.ct, 'base64').toString('utf8').includes('KEEPER'));
  ok('round trip returns the exact bytes', decrypt(blob, 'correct horse battery staple') === secret);

  let threw = false;
  try { decrypt(blob, 'wrong passphrase'); } catch { threw = true; }
  ok('a WRONG passphrase throws, never returns garbage', threw);

  const b2 = encrypt(secret, 'correct horse battery staple');
  ok('same secret twice gives different salt', b2.salt !== blob.salt);
  ok('same secret twice gives different ciphertext', b2.ct !== blob.ct);

  const tampered = { ...blob, ct: Buffer.from(Buffer.from(blob.ct, 'base64').map((x, i) => i === 0 ? x ^ 1 : x)).toString('base64') };
  let caught = false;
  try { decrypt(tampered, 'correct horse battery staple'); } catch { caught = true; }
  ok('a TAMPERED blob is rejected by the GCM tag', caught);

  console.log(`\n  ${n - bad}/${n} checks passed\n`);
  process.exit(bad ? 1 : 0);
}

// ── main ───────────────────────────────────────────────────────────────────
const cmd = process.argv[2];
if (cmd === '--selftest') selftest();

if (cmd === 'seal') {
  const inFile = arg('--in'), outFile = arg('--out');
  if (!inFile || !outFile) die('usage: seal --in <secret file> --out <name>.enc.json');
  if (!existsSync(inFile)) die(`${inFile} not found`);
  if (existsSync(outFile)) die(`${outFile} already exists — refusing to overwrite a sealed blob`);
  const plain = readFileSync(inFile, 'utf8');
  if (!plain.trim()) die(`${inFile} is empty — refusing to seal nothing`);

  console.log(`\n  Sealing ${inFile}  (${Buffer.byteLength(plain)} bytes, sha256 ${sha(plain).slice(0, 16)}…)`);
  console.log('  The passphrase is typed, never echoed, and never stored. If you lose');
  console.log('  it the blob is unrecoverable — that is the point.\n');
  const p1 = await ask('  Passphrase: ', { hidden: true });
  if (p1.length < 12) die('use at least 12 characters');
  const p2 = await ask('  Again     : ', { hidden: true });
  if (p1 !== p2) die('the two passphrases differ');

  const blob = encrypt(plain, p1);
  blob.sha256_plaintext = sha(plain);     // lets verify() prove content without printing it
  blob.sealed_at = new Date().toISOString();
  blob.source = inFile;
  writeFileSync(outFile, JSON.stringify(blob, null, 2) + '\n', { mode: 0o600 });

  // Open it again immediately. An unverified seal is how a corrupt backup gets
  // filed and trusted for a year.
  const back = decrypt(JSON.parse(readFileSync(outFile, 'utf8')), p1);
  if (back !== plain) die('re-opening the blob did NOT return the original — do not trust this file');
  console.log(`\n  Sealed  : ${outFile}`);
  console.log(`  Verified: re-opened and byte-identical to the source`);
  console.log(`  sha256  : ${sha(plain)}`);
  console.log('\n  Copy it to both vault hosts, then delete the plaintext once you are');
  console.log('  sure the passphrase is recorded somewhere you will still have in a year.\n');
  process.exit(0);
}

if (cmd === 'verify' || cmd === 'open') {
  const f = arg('--file');
  if (!f) die(`usage: ${cmd} --file <name>.enc.json`);
  if (!existsSync(f)) die(`${f} not found`);
  const blob = JSON.parse(readFileSync(f, 'utf8'));
  const p = await ask('  Passphrase: ', { hidden: true });
  let plain;
  try { plain = decrypt(blob, p); }
  catch { die('could not open it: wrong passphrase, or the file is damaged'); }

  if (blob.sha256_plaintext) {
    const a = Buffer.from(sha(plain), 'hex'), b = Buffer.from(blob.sha256_plaintext, 'hex');
    const match = a.length === b.length && timingSafeEqual(a, b);
    console.log(`  content : ${match ? 'matches the recorded sha256' : 'DOES NOT MATCH the recorded sha256'}`);
    if (!match) process.exit(1);
  }
  console.log(`  opened  : ${Buffer.byteLength(plain)} bytes, sha256 ${sha(plain).slice(0, 16)}…`);
  console.log(`  sealed  : ${blob.sealed_at || 'unknown'}  from ${blob.source || 'unknown'}`);

  if (cmd === 'open') {
    const out = arg('--out');
    if (!out) die('open needs --out <file>; this tool will not print a secret to a terminal');
    if (existsSync(out)) die(`${out} exists — refusing to overwrite`);
    writeFileSync(out, plain, { mode: 0o600 });
    console.log(`  written : ${out} (mode 600) — delete it when you are done`);
  } else {
    console.log('  the secret was NOT printed; use `open --out <file>` if you need it back');
  }
  process.exit(0);
}

die('usage:\n    node pcoin-key-seal.mjs --selftest\n' +
    '    node pcoin-key-seal.mjs seal   --in <secret file> --out <name>.enc.json\n' +
    '    node pcoin-key-seal.mjs verify --file <name>.enc.json\n' +
    '    node pcoin-key-seal.mjs open   --file <name>.enc.json --out <file>');
