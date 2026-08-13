#!/usr/bin/env node
//
// pcoin-vault-bundle — encrypt the off-repo sensitive files into ONE blob, so
// they can live in three places without living in three places in the clear.
//
//   node pcoin-vault-bundle.mjs --selftest
//   node pcoin-vault-bundle.mjs pack    [--root D:\pc.am] [--out pcoin-bundle.enc.json]
//   node pcoin-vault-bundle.mjs verify  --file pcoin-bundle.enc.json
//   node pcoin-vault-bundle.mjs list    --file pcoin-bundle.enc.json
//   node pcoin-vault-bundle.mjs restore --file pcoin-bundle.enc.json --out <dir>
//
// WHY THIS EXISTS
// D:\pc.am holds the things that cannot be regenerated: the Android release
// keystore (lose it and no user can ever upgrade), the TLS private key, the
// retired first-generation seed phrases, every wallet backup, and the secrets
// file that names every host. One disk. The obvious fix — copy it to the two
// vault hosts — would put all of that in the clear on two internet-facing
// machines, which is worse than the problem.
//
// So it goes as one authenticated blob. Three copies, one secret.
//
// The format is deliberately IDENTICAL to pcoin-seed-vault.mjs: scrypt N=2^17
// over AES-256-GCM, same field names. A second bespoke crypto format in the
// same directory is a second thing to get wrong, and `verify` here would not
// help anyone holding a blob made by the other tool.
//
// THREE THINGS THAT ARE DELIBERATE
//
//   The passphrase is TYPED, never an argument. An argv passphrase is in the
//   shell history, in `ps` output for every user on the box, and in any
//   transcript. The custody runbook says this in bigger letters than this file.
//
//   VERIFY RE-DERIVES. It decrypts, recomputes each file's SHA-256, and
//   compares against the manifest recorded at pack time. That proves the blob
//   reproduces *those bytes*, not merely that it is well-formed JSON with the
//   right passphrase. A backup is not a backup until it has been loaded.
//
//   NOTHING IS EVER WRITTEN IN THE CLEAR. `restore` is the only path that
//   produces plaintext, it demands an explicit --out, and it refuses to run
//   into a directory that already has files in it.

import { createHash, randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, mkdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createInterface } from 'node:readline';

// Same parameters as pcoin-seed-vault.mjs. Do not "tune" these: a blob made
// with different ones still decrypts (N/r/p travel inside it), but divergence
// means two formats to reason about.
const SCRYPT = { N: 1 << 17, r: 8, p: 1, keylen: 32, maxmem: 256 * 1024 * 1024 };

// What goes in. Paths are relative to --root. Directories are taken whole.
// Anything absent is reported and skipped rather than failing the run — this
// list is shared between machines that do not all hold the same files.
const PAYLOAD = [
  'PCOIN-SECRETS.md',
  'PCOIN-SERVERS.md',
  'PCOIN-CUSTODY-RUNBOOK.md',
  'PCN-INTEGRATIONS.md',
  'MYMINERS.md',
  'servers.md',
  'SYSTEM-README.md',
  'pcoin-release.keystore',   // IRREPLACEABLE: no keystore, no app upgrades, ever
  'pcoin-debug.keystore',
  'pc.crt',
  'pc.key',
  'wallet-backups',           // includes the retired plaintext SEED files
];

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

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
  // GCM authenticates: a wrong passphrase or a flipped bit throws here instead
  // of returning plausible rubbish. That is the entire reason for an AEAD.
  return Buffer.concat([d.update(Buffer.from(blob.ct, 'base64')), d.final()]).toString('utf8');
}

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      const onData = (ch) => {
        if (['\n', '\r', '\u0004'].includes(ch.toString('utf8'))) process.stdin.removeListener('data', onData);
        else process.stdout.write('\x1b[2K\r' + question);   // repaint, echo nothing
      };
      process.stdin.on('data', onData);
    }
    rl.question(question, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a); });
  });
}

/** Walk a file or directory into [{path, size, sha256, b64}] with paths relative to root. */
function collect(root, entry) {
  const abs = join(root, entry);
  if (!existsSync(abs)) return { missing: entry, files: [] };
  const st = statSync(abs);
  if (st.isFile()) {
    const buf = readFileSync(abs);
    return { files: [{ path: entry.split(sep).join('/'), size: buf.length, sha256: sha256(buf), b64: buf.toString('base64') }] };
  }
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else {
        const buf = readFileSync(p);
        out.push({ path: relative(root, p).split(sep).join('/'), size: buf.length, sha256: sha256(buf), b64: buf.toString('base64') });
      }
    }
  };
  walk(abs);
  return { files: out };
}

async function selftest() {
  console.log('pcoin-vault-bundle selftest\n');
  let pass = 0, fail = 0;
  const ok = (name, cond) => { cond ? (pass++, console.log('  PASS  ' + name)) : (fail++, console.log('  FAIL  ' + name)); };

  const secret = JSON.stringify({ hello: 'world', bytes: randomBytes(64).toString('base64') });
  const blob = encrypt(secret, 'correct horse battery staple');
  ok('round-trip returns the same plaintext', decrypt(blob, 'correct horse battery staple') === secret);

  let threw = false;
  try { decrypt(blob, 'wrong passphrase'); } catch { threw = true; }
  ok('wrong passphrase THROWS rather than returning rubbish', threw);

  // Tamper with one ciphertext byte; GCM must reject it.
  const t = { ...blob };
  const ct = Buffer.from(t.ct, 'base64'); ct[0] ^= 0x01; t.ct = ct.toString('base64');
  threw = false;
  try { decrypt(t, 'correct horse battery staple'); } catch { threw = true; }
  ok('a single flipped ciphertext bit is DETECTED', threw);

  const t2 = { ...blob };
  const tag = Buffer.from(t2.tag, 'base64'); tag[0] ^= 0x01; t2.tag = tag.toString('base64');
  threw = false;
  try { decrypt(t2, 'correct horse battery staple'); } catch { threw = true; }
  ok('a flipped AUTH TAG bit is DETECTED', threw);

  // These two are separate on purpose. An earlier single check compared only
  // ciphertexts and PASSED against a build with a hardcoded salt, because the
  // IV is independently random so the ciphertext differs regardless. A fixed
  // salt means one passphrase always derives one key, which is precomputation
  // across every blob ever made — so the salt is asserted directly.
  const e1 = encrypt(secret, 'x'), e2 = encrypt(secret, 'x');
  ok('SALT is fresh per blob (not hardcoded)', e1.salt !== e2.salt);
  ok('IV is fresh per blob (not hardcoded)', e1.iv !== e2.iv);
  ok('ciphertexts of identical input differ', e1.ct !== e2.ct);
  ok('scrypt cost is the vault standard (N=2^17)', SCRYPT.N === 131072);

  console.log('\n  %d passed, %d failed', pass, fail);
  if (fail) { console.log('  SELFTEST FAILED — do not use this to store anything.'); process.exit(1); }
  console.log('  ALL CHECKS PASSED');
}

async function pack(args) {
  const root = args.root || 'D:\\pc.am';
  const out = args.out || 'pcoin-bundle.enc.json';
  console.log('packing from %s\n', root);

  const files = [];
  const missing = [];
  for (const entry of PAYLOAD) {
    const r = collect(root, entry);
    if (r.missing) { missing.push(r.missing); continue; }
    files.push(...r.files);
  }
  if (!files.length) { console.log('nothing to pack — is --root right?'); process.exit(2); }

  const total = files.reduce((a, f) => a + f.size, 0);
  for (const f of files.slice(0, 12)) console.log('  %s  %d bytes', f.path.padEnd(46), f.size);
  if (files.length > 12) console.log('  … and %d more', files.length - 12);
  if (missing.length) console.log('\n  NOT FOUND (skipped): %s', missing.join(', '));
  console.log('\n  %d files, %s total', files.length, (total / 1048576).toFixed(2) + ' MB');

  const pass1 = await ask('\npassphrase (12+ chars, typed not echoed): ', { hidden: true });
  if (pass1.length < 12) { console.log('too short — 12 characters minimum.'); process.exit(2); }
  const pass2 = await ask('again: ', { hidden: true });
  if (pass1 !== pass2) { console.log('they do not match. Nothing written.'); process.exit(2); }

  const payload = JSON.stringify({
    kind: 'pcoin-vault-bundle', v: 1,
    packedAt: new Date().toISOString(),
    root,
    manifest: files.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
    files,
  });

  const blob = encrypt(payload, pass1);
  // Prove it before writing: a blob that cannot be opened is worse than none.
  const check = JSON.parse(decrypt(blob, pass1));
  if (check.files.length !== files.length) { console.log('round-trip mismatch — NOT written.'); process.exit(1); }
  for (const f of check.files) {
    if (sha256(Buffer.from(f.b64, 'base64')) !== f.sha256) {
      console.log('round-trip corrupted %s — NOT written.', f.path); process.exit(1);
    }
  }

  writeFileSync(out, JSON.stringify(blob));
  console.log('\n  wrote %s  (%s MB encrypted)', out, (statSync(out).size / 1048576).toFixed(2));
  console.log('  verified by decrypting it back and re-hashing every file before writing.');
  console.log('\n  Now copy it to BOTH vault hosts and run `verify` on each, from the copy');
  console.log('  that is actually there. A backup is not a backup until it has been loaded.');
}

async function openBlob(args) {
  if (!args.file) { console.log('need --file'); process.exit(2); }
  const blob = JSON.parse(readFileSync(args.file, 'utf8'));
  const pass = await ask('passphrase: ', { hidden: true });
  let data;
  try { data = JSON.parse(decrypt(blob, pass)); }
  catch (e) { console.log('\n  CANNOT DECRYPT: %s', e.message);
              console.log('  Either the passphrase is wrong or the file is damaged. GCM cannot tell you which.');
              process.exit(1); }
  return data;
}

async function verify(args) {
  const data = await openBlob(args);
  console.log('\n  packed %s from %s', data.packedAt, data.root);
  let bad = 0;
  for (const f of data.files) {
    const actual = sha256(Buffer.from(f.b64, 'base64'));
    const rec = data.manifest.find((m) => m.path === f.path);
    if (!rec || rec.sha256 !== actual) { bad++; console.log('  MISMATCH  %s', f.path); }
  }
  console.log('  %d files, %d mismatched', data.files.length, bad);
  if (bad) { console.log('\n  THIS BLOB DOES NOT REPRODUCE WHAT IT CLAIMS. Do not rely on it.'); process.exit(1); }
  console.log('\n  VERIFIED: every file re-hashes to the value recorded at pack time.');
}

async function list(args) {
  const data = await openBlob(args);
  console.log('\n  packed %s from %s\n', data.packedAt, data.root);
  for (const m of data.manifest) console.log('  %s  %8d  %s', m.path.padEnd(50), m.size, m.sha256.slice(0, 16));
  console.log('\n  %d files', data.manifest.length);
}

async function restore(args) {
  if (!args.out) { console.log('need --out <dir>  (restore is the only path that writes plaintext)'); process.exit(2); }
  if (existsSync(args.out) && readdirSync(args.out).length) {
    console.log('%s is not empty. Refusing, so nothing can be silently overwritten.', args.out); process.exit(2);
  }
  const data = await openBlob(args);
  for (const f of data.files) {
    const dest = join(args.out, ...f.path.split('/'));
    mkdirSync(join(dest, '..'), { recursive: true });
    const buf = Buffer.from(f.b64, 'base64');
    if (sha256(buf) !== f.sha256) { console.log('  REFUSING %s — hash mismatch', f.path); process.exit(1); }
    writeFileSync(dest, buf);
  }
  console.log('\n  restored %d files to %s', data.files.length, args.out);
  console.log('  These are PLAINTEXT secrets. Delete this directory when you are done.');
}

const argv = process.argv.slice(2);
const cmd = argv.find((a) => !a.startsWith('--')) || (argv.includes('--selftest') ? 'selftest' : 'help');
const args = {};
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1];

const cmds = { selftest, pack, verify, list, restore };
if (!cmds[cmd]) {
  console.log('usage: pcoin-vault-bundle.mjs [--selftest|pack|verify|list|restore] [--root D] [--file F] [--out O]');
  process.exit(2);
}
await cmds[cmd](args);
