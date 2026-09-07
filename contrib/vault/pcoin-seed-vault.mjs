#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// pcoin-seed-vault — create a system's PCN wallet and back it up, without ever
// putting a spendable key on a server.
// ═══════════════════════════════════════════════════════════════════════════
//
// WHO RUNS THIS
// The OWNER, in their own terminal, on their own machine. Not an assistant, not
// CI, not over a remote shell. The twelve words appear on screen exactly once
// and the passphrase is typed rather than passed as an argument, so neither ends
// up in a transcript, a shell history or a log.
//
// WHAT IT PRODUCES
//   <system>-xpub.txt       the ACCOUNT XPUB at m/84'/9444'/0'. Public. The only
//                           piece that goes on a server. It sees every deposit
//                           and cannot spend a satoshi.
//   <system>-seed.enc.json  the twelve words, encrypted with YOUR passphrase.
//                           Safe to copy to both vault hosts: a breach of those
//                           machines yields a blob, not money.
//
// WHY ENCRYPTED RATHER THAN PLAIN
// A plaintext phrase on a vault host means that host can spend everything. In
// the week this was written, a live RCE was found on one of those boxes and
// three bot tokens leaked from a repo. Encrypted, the same breach costs nothing.
//
// WHY NOT PAPER ALONE
// Paper burns, floods and gets tidied away. Paper stays primary; the encrypted
// copy is the redundancy. Two independent failure modes, neither sufficient.
//
// THE TRAP THAT COSTS REAL MONEY
// PCoin kept Bitcoin's xprv/xpub version bytes, so the SAME seed under coin type
// 0' derives LIVE BITCOIN KEYS. The account path is m/84'/9444'/0' and is
// asserted against a published vector in --selftest. Never change it.
//
// USAGE
//   node pcoin-seed-vault.mjs --selftest
//   node pcoin-seed-vault.mjs new     --system webbuilderbot
//   node pcoin-seed-vault.mjs verify  --file webbuilderbot-seed.enc.json
//   node pcoin-seed-vault.mjs restore --file webbuilderbot-seed.enc.json
//
// DEPENDENCIES
//   npm i @scure/bip39 @scure/bip32 @scure/base
// Encryption uses Node's built-in crypto (scrypt + AES-256-GCM) rather than a
// fourth dependency: fewer packages in the path of a key is worth the verbosity.

import { createHash, randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

function die(m) {
  console.error('\n  ' + m + '\n');
  process.exit(1);
}

// ── dependencies ───────────────────────────────────────────────────────────
// Reported BY NAME on failure. One catch around all four once printed "missing
// dependencies" when the packages were installed and only the wordlist subpath
// had moved between major versions -- an error that sends the reader to
// reinstall something already present.
let bip39, wordlist, HDKey, bech32, keccak256, secp;

async function need(spec, take) {
  try {
    return take(await import(spec));
  } catch (e) {
    const first = String(e.message).split('\n')[0];
    die('cannot load ' + spec + '\n  ' + first +
        '\n\n  Try: npm i @scure/bip39 @scure/bip32 @scure/base');
  }
}

bip39 = await need('@scure/bip39', (m) => m);
wordlist = await (async () => {
  // v2 exports './wordlists/english.js'; v1 used the same path without the
  // extension. Try current first, fall back rather than demanding a version.
  for (const c of ['@scure/bip39/wordlists/english.js', '@scure/bip39/wordlists/english']) {
    try { return (await import(c)).wordlist; } catch { /* try the next */ }
  }
  die('cannot load the English wordlist from @scure/bip39');
})();
HDKey = await need('@scure/bip32', (m) => m.HDKey);
bech32 = await need('@scure/base', (m) => m.bech32);
keccak256 = await need('@noble/hashes/sha3.js', (m) => m.keccak_256);
secp = await need('@noble/curves/secp256k1.js', (m) => m.secp256k1);

const ACCOUNT_PATH = "m/84'/9444'/0'";
const HRP = 'pc';

// -- EVM (BNB Smart Chain) --------------------------------------------------
// Added 2026-09-08 for the wPCN payment address. Same twelve words, same
// encrypted blob, same verify path: ONE custody procedure, not two.
//
// The coin type is 60', Ethereum's, NOT 9444'. Every EVM chain shares 60'
// because an address is a function of the key alone -- BSC and Ethereum derive
// byte-identically, which is what you want here: the same words restore the
// same address in MetaMask with no custom path to remember.
//
// The address is the last 20 bytes of keccak256 over the UNCOMPRESSED public
// key with its 0x04 tag stripped. Strip the wrong byte and you get a
// valid-LOOKING address nobody can ever spend from, so the selftest pins a
// published vector rather than trusting this comment.
const ACCOUNT_PATH_EVM = "m/44'/60'/0'";

// ── derivation ─────────────────────────────────────────────────────────────
function accountFromMnemonic(mnemonic, passphrase = '') {
  const seed = bip39.mnemonicToSeedSync(mnemonic, passphrase);
  return HDKey.fromMasterSeed(seed).derive(ACCOUNT_PATH);
}

/** The EVM account key. Only its public side is ever written to a file. */
function evmAccountFromMnemonic(mnemonic, passphrase = '') {
  const seed = bip39.mnemonicToSeedSync(mnemonic, passphrase);
  return HDKey.fromMasterSeed(seed).derive(ACCOUNT_PATH_EVM);
}

/** EIP-55 checksummed address #index from an ACCOUNT xpub. No key material. */
function evmAddressFromXpub(xpub, index) {
  const child = HDKey.fromExtendedKey(xpub).deriveChild(0).deriveChild(index);
  const uncompressed = secp.Point.fromBytes(child.publicKey).toBytes(false);
  const hex = Buffer.from(keccak256(uncompressed.slice(1))).toString('hex').slice(-40);
  // EIP-55: uppercase each hex digit whose matching hash nibble is >= 8.
  const h = Buffer.from(keccak256(Buffer.from(hex, 'utf8'))).toString('hex');
  let out = '0x';
  for (let i = 0; i < 40; i++) out += parseInt(h[i], 16) >= 8 ? hex[i].toUpperCase() : hex[i];
  return out;
}

/** Receive address #index from an ACCOUNT xpub. Non-hardened: no key material. */
function addressFromXpub(xpub, index) {
  const child = HDKey.fromExtendedKey(xpub).deriveChild(0).deriveChild(index);
  const h160 = createHash('ripemd160')
    .update(createHash('sha256').update(child.publicKey).digest())
    .digest();
  return bech32.encode(HRP, [0, ...bech32.toWords(h160)]);
}

// ── encryption ─────────────────────────────────────────────────────────────
// scrypt is deliberately expensive: the only thing between a stolen blob and
// the coins is the passphrase, so brute-forcing it must be slow.
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
  // GCM authenticates, so a wrong passphrase throws here rather than returning
  // plausible rubbish. That is the whole reason for using an AEAD.
  return Buffer.concat([d.update(Buffer.from(blob.ct, 'base64')), d.final()]).toString('utf8');
}

// ── prompting ──────────────────────────────────────────────────────────────
function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      // Suppress echo so the passphrase never reaches the screen or a scrollback
      // buffer somebody later screenshots.
      rl._writeToOutput = function (str) {
        if (str.includes(question)) rl.output.write(question);
        else rl.output.write('');
      };
    }
    rl.question(question, (a) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(a);
    });
  });
}

// ── commands ───────────────────────────────────────────────────────────────
async function cmdNew(system, chain = 'pcn') {
  if (!system) die('--system <name> is required, e.g. --system webbuilderbot');
  if (chain !== 'pcn' && chain !== 'evm') die("--chain must be 'pcn' or 'evm'");
  const evm = chain === 'evm';
  // Distinct filenames per chain, so one system can hold both without either
  // silently overwriting the other -- and so a glob for *-seed.enc.json still
  // finds every blob there is.
  const xpubFile = evm ? system + '-evm-address.txt' : system + '-xpub.txt';
  const blobFile = evm ? system + '-evm-seed.enc.json' : system + '-seed.enc.json';
  for (const f of [xpubFile, blobFile]) {
    // Never silently replace a wallet file. Overwriting one that already holds
    // coins is unrecoverable.
    if (existsSync(f)) die(f + ' already exists - refusing to overwrite. Move it aside first.');
  }

  const mnemonic = bip39.generateMnemonic(wordlist, 128); // 128 bits -> 12 words
  const acct = evm ? evmAccountFromMnemonic(mnemonic) : accountFromMnemonic(mnemonic);
  const xpub = acct.publicExtendedKey;
  const addr0 = evm ? evmAddressFromXpub(xpub, 0) : addressFromXpub(xpub, 0);

  console.log('\n' + '='.repeat(68));
  console.log('  ' + system + ' - WRITE THESE TWELVE WORDS ON PAPER, NOW');
  console.log('='.repeat(68));
  const words = mnemonic.split(' ');
  for (let i = 0; i < words.length; i++) {
    process.stdout.write(String(i + 1).padStart(4) + '. ' + words[i].padEnd(12));
    if ((i + 1) % 3 === 0) process.stdout.write('\n');
  }
  console.log('='.repeat(68));
  console.log('  Anyone with these words can spend every coin this system ever');
  console.log('  receives. Paper only: not a photo, not a password manager, not');
  console.log('  a chat message.\n');

  await ask('  Written down? Press Enter to continue. ');
  // console.clear() only wipes the visible screen. On Windows Terminal, and on
  // most xterm-compatible emulators, the words stay in the scrollback where a
  // later select-all still finds them. ESC[3J clears that buffer too, which is
  // the difference between 'off the screen' and 'gone'.
  console.clear();
  process.stdout.write('\x1b[3J');
  console.log('  Screen and scrollback cleared.\n');

  // Prove the paper copy is right BEFORE anything depends on it.
  //
  // Typed BLIND, like the passphrase. Echoing the words here undid the whole
  // point of the console.clear() above: it put them straight back on screen,
  // where they sit in the scrollback for the rest of the session. That is not
  // theoretical -- two wallets were burned in one sitting by an operator
  // pasting this block to show progress, because the words were sitting in it.
  // A phrase that is never rendered cannot be copied by accident.
  //
  // Three attempts rather than one abort, because blind-typing twelve words
  // produces typos, and an operator who has to restart from scratch is an
  // operator tempted to photograph the screen instead.
  console.log('  Now type the words back, from the paper, to prove the copy is good.');
  console.log('  Your typing is hidden, exactly like a passphrase.');
  let verified = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const check = (await ask('  Twelve words: ', { hidden: true }))
      .trim().replace(/\s+/g, ' ').toLowerCase();
    if (check === mnemonic) { verified = true; break; }
    if (attempt < 3) console.log('  That does not match. Read from the paper and try again.\n');
  }
  if (!verified) {
    die('Those words do not match what was generated. Nothing was written.\n' +
        '  Run this again and copy more carefully - a backup that has not been\n' +
        '  verified is not a backup.');
  }
  console.log('  Paper copy verified.\n');

  let pass;
  for (;;) {
    pass = await ask('  Passphrase to encrypt the backup: ', { hidden: true });
    if (pass.length < 12) { console.log('  Too short - use at least 12 characters.\n'); continue; }
    const again = await ask('  Again: ', { hidden: true });
    if (pass !== again) { console.log('  They do not match.\n'); continue; }
    break;
  }
  console.log('\n  Encrypting...');

  const blob = encrypt(mnemonic, pass);
  blob.system = system;
  blob.chain = chain;
  blob.path = evm ? ACCOUNT_PATH_EVM : ACCOUNT_PATH;
  blob.xpub = xpub;          // public, and lets verify/restore prove the match
  blob.address0 = addr0;
  blob.created = new Date().toISOString().slice(0, 10);

  // Prove the encrypted copy decrypts before anyone relies on it.
  if (decrypt(blob, pass) !== mnemonic) die('Encrypted copy failed to round-trip. Nothing written.');

  writeFileSync(blobFile, JSON.stringify(blob, null, 2) + '\n');
  writeFileSync(xpubFile, xpub + '\n');

  console.log('\n  Wrote:');
  console.log('    ' + xpubFile + '   -> the server. Public, cannot spend.');
  console.log('    ' + blobFile + '  -> BOTH vault hosts. Encrypted.');
  console.log('\n  Account path : ' + ACCOUNT_PATH);
  console.log('  Address #0   : ' + addr0);
  console.log('  Blob SHA-256 : ' + createHash('sha256').update(readFileSync(blobFile)).digest('hex'));
  console.log('\n  Check address #0 against your wallet app before importing a pool.');
  console.log('  Keep the passphrase somewhere separate from the blob: together');
  console.log('  they are the money, apart neither is.\n');
}

/**
 * Derive a batch of receive addresses from the account xpub.
 *
 * checker and webbuilderbot hand each user a row from a PRE-DERIVED pool, so
 * they need a list to paste into their admin import box. AiControl derives on
 * demand from the stored xpub and needs none of this.
 *
 * Deliberately takes only the xpub file: no passphrase, no phrase, nothing that
 * can spend. This is the one step of the whole procedure that is safe to run on
 * any machine, including a server.
 */
async function cmdPool(system, count, start) {
  if (!system) die('--system <name> is required, e.g. --system checker');
  const xpubFile = system + '-xpub.txt';
  if (!existsSync(xpubFile)) die(xpubFile + ' not found. Run `new --system ' + system + '` first.');

  const n = Number(count ?? 1000);
  const from = Number(start ?? 0);
  if (!Number.isInteger(n) || n < 1 || n > 100000) die('--count must be 1..100000');
  if (!Number.isInteger(from) || from < 0) die('--start must be 0 or more');

  const xpub = readFileSync(xpubFile, 'utf8').trim();
  // An xprv here would still derive correct addresses, so nothing downstream
  // would notice -- and a spendable key would be sitting in a file destined for
  // a paste box. Refuse loudly.
  if (!xpub.startsWith('xpub')) die(xpubFile + ' does not contain an xpub. Refusing.');
  if (HDKey.fromExtendedKey(xpub).privateKey) die(xpubFile + ' contains a PRIVATE key. Refusing.');

  const out = [];
  for (let i = from; i < from + n; i++) out.push(addressFromXpub(xpub, i));

  const outFile = system + '-pool-' + from + '-' + (from + n - 1) + '.txt';
  writeFileSync(outFile, out.join('\n') + '\n');

  console.log('\n  Wrote ' + outFile);
  console.log('  ' + n + ' addresses, derivation index ' + from + '..' + (from + n - 1) + '\n');
  console.log('  first : ' + out[0] + '   (index ' + from + ')');
  console.log('  last  : ' + out[out.length - 1] + '   (index ' + (from + n - 1) + ')');
  console.log('  sha256: ' + createHash('sha256').update(readFileSync(outFile)).digest('hex'));
  console.log('\n  Paste into the admin import box with START INDEX = ' + from + '.');
  console.log('  The order is load-bearing: the row a user is handed is identified by');
  console.log('  its index, and an off-by-one sends their deposit to a different row.\n');
}

async function cmdVerify(file) {
  if (!file || !existsSync(file)) die('--file <blob.json> is required');
  const blob = JSON.parse(readFileSync(file, 'utf8'));
  const pass = await ask('  Passphrase: ', { hidden: true });
  let mnemonic;
  try { mnemonic = decrypt(blob, pass); }
  catch { die('Wrong passphrase, or the file is damaged.'); }

  // The real test: does the decrypted phrase reproduce the recorded xpub?
  //
  // The chain comes from the BLOB, never from a flag. An EVM blob checked with
  // PCN derivation would report a perfectly good backup as broken, which is the
  // one wrong answer this command must never give. Blobs written before
  // 2026-09-08 have no chain field and are all PCN.
  const isEvm = (blob.chain || 'pcn') === 'evm';
  const acct = isEvm ? evmAccountFromMnemonic(mnemonic) : accountFromMnemonic(mnemonic);
  const xpubOk = acct.publicExtendedKey === blob.xpub;
  const addr = isEvm ? evmAddressFromXpub(acct.publicExtendedKey, 0)
                     : addressFromXpub(acct.publicExtendedKey, 0);
  const addrOk = addr === blob.address0;
  console.log('\n  decrypts        : yes');
  console.log('  xpub matches    : ' + (xpubOk ? 'yes' : 'NO'));
  console.log('  address #0      : ' + addr + (addrOk ? '  (matches)' : '  MISMATCH'));
  console.log('  words recovered : ' + mnemonic.split(' ').length + ' (not shown)');
  console.log(xpubOk && addrOk
    ? '\n  This backup is good.\n'
    : '\n  This backup does NOT reproduce the wallet. Do not rely on it.\n');
  if (!xpubOk || !addrOk) process.exit(1);
}

/**
 * Which wallet is this paper?
 *
 * Three papers from three runs look identical, and destroying the wrong two
 * loses the live wallet. `restore` answers the question but prints the phrase
 * in clear, which is the exposure this tool exists to avoid.
 *
 * This takes the phrase blind and prints only what it derives. The words are
 * never rendered, so the output is safe to paste anywhere.
 */
async function cmdIdentify(file) {
  console.log('\n  Type a phrase from paper. Your typing is hidden, and the phrase is');
  console.log('  never printed back - only the address it derives.\n');

  const phrase = (await ask('  Twelve words: ', { hidden: true }))
    .trim().replace(/\s+/g, ' ').toLowerCase();

  if (!phrase) die('Nothing entered.');
  if (phrase.split(' ').length !== 12) die('That is not twelve words.');
  if (!bip39.validateMnemonic(phrase, wordlist)) {
    die('That is not a valid BIP39 phrase - check for a mistyped word.\n' +
        '  Nothing about the phrase is shown, so re-read it from the paper.');
  }

  // No blob here -- the operator typed a phrase -- so show BOTH derivations
  // rather than guessing which chain they meant.
  const xpub = accountFromMnemonic(phrase).publicExtendedKey;
  const addr0 = addressFromXpub(xpub, 0);
  const evmXpub = evmAccountFromMnemonic(phrase).publicExtendedKey;
  const evmAddr0 = evmAddressFromXpub(evmXpub, 0);

  // Both derivations, because the operator typed a phrase and no blob said
  // which chain they meant. Guessing one and printing it as THE address is
  // how somebody funds the wrong chain.
  console.log('\n  PCN  ' + ACCOUNT_PATH + '      -> ' + addr0);
  console.log('  EVM  ' + ACCOUNT_PATH_EVM + '/0/0 -> ' + evmAddr0);

  console.log('\n  Account path : ' + ACCOUNT_PATH);
  console.log('  Address #0   : ' + addr0);
  console.log('  xpub         : ' + xpub.slice(0, 14) + '...' + xpub.slice(-6));

  if (file) {
    if (!existsSync(file)) die(file + ' not found');
    const blob = JSON.parse(readFileSync(file, 'utf8'));
    const match = blob.xpub === xpub;
    console.log('\n  ' + (match ? 'MATCH' : 'DOES NOT MATCH') + ' ' + file +
                '  (system ' + blob.system + ', address #0 ' + blob.address0 + ')');
    if (!match) {
      console.log('  This paper is NOT the wallet in that file. Do not destroy the other papers.');
      process.exitCode = 1;
    }
  }
  console.log('');
}

async function cmdRestore(file) {
  if (!file || !existsSync(file)) die('--file <blob.json> is required');
  const blob = JSON.parse(readFileSync(file, 'utf8'));
  console.log('\n  This prints the twelve words in clear. Only do it on a machine you');
  console.log('  trust, when you are about to sign a transaction.\n');
  const pass = await ask('  Passphrase: ', { hidden: true });
  let mnemonic;
  try { mnemonic = decrypt(blob, pass); }
  catch { die('Wrong passphrase, or the file is damaged.'); }
  console.log('\n  ' + mnemonic + '\n');
  console.log('  Account: ' + blob.path + '   Address #0: ' + blob.address0 + '\n');
}

// ── self-test ──────────────────────────────────────────────────────────────
function selftest() {
  let fail = 0;
  const t = (name, got, want) => {
    const ok = got === want;
    console.log('  ' + (ok ? 'ok  ' : 'FAIL') + ' ' + name);
    if (!ok) { console.log('       got  ' + got + '\n       want ' + want); fail++; }
  };

  // The published all-zeros BIP39 vector: public, worthless, and the only way to
  // prove the derivation without risking a real wallet.
  const BURN = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const acct = accountFromMnemonic(BURN);
  const btcAcct = HDKey.fromMasterSeed(bip39.mnemonicToSeedSync(BURN)).derive("m/84'/0'/0'");

  // The published PCoin vectors (PCOIN.md 6.4). These are what make this tool
  // INTEROPERABLE rather than merely self-consistent: the same numbers a node's
  // `deriveaddresses` and the Android wallet produce. If any of these move, this
  // tool and the wallet have diverged and coins would land where nothing looks.
  t('published account xpub', acct.publicExtendedKey,
    'xpub6BzQhKPxtj3bu3nXmF8HinE9YpcjYqvaJxpRtMcXesrDtaXKnkmEqED19EcyDUGb3tuRih7NACR2HY1WrfkRP1dHpMZS2imgmrTrV8cVpE3');
  const RECEIVE = [
    'pc1qj7lccmpqhdgg6enh503hqqyx244e49yespm8pf',
    'pc1q0ncnjjyklxwts46h7e7jmls0l8d99lhv3wk0sm',
    'pc1qzze3twr9c0cg0s3v2yh7797gae4ufk7zu4wux0',
  ];
  RECEIVE.forEach((want, i) =>
    t('published receive address #' + i, addressFromXpub(acct.publicExtendedKey, i), want));

  // Negative control: coin type 0' on the burn phrase is a well-known BITCOIN
  // address wearing a pc prefix. PCoin kept Bitcoin's version bytes, so nothing
  // else would notice the substitution. This is the assertion that catches it.
  t('coin type 0 yields the known Bitcoin address',
    addressFromXpub(btcAcct.publicExtendedKey, 0),
    'pc1qcr8te4kr609gcawutmrza0j4xv80jy8z0afhyv');
  t('9444 derives something different from coin type 0',
    addressFromXpub(acct.publicExtendedKey, 0) !== addressFromXpub(btcAcct.publicExtendedKey, 0), true);
  t('xpub is watch-only', HDKey.fromExtendedKey(acct.publicExtendedKey).privateKey, null);
  t('mnemonic is 12 words', bip39.generateMnemonic(wordlist, 128).split(' ').length, 12);

  const blob = encrypt(BURN, 'correct horse battery staple');
  t('round-trips', decrypt(blob, 'correct horse battery staple'), BURN);
  let threw = false;
  try { decrypt(blob, 'wrong passphrase entirely'); } catch { threw = true; }
  t('wrong passphrase throws rather than returning rubbish', threw, true);

  const a = addressFromXpub(acct.publicExtendedKey, 0);
  t('address is pc1 bech32 of the right length', a.startsWith('pc1q') && a.length === 42, true);
  t('index 1 differs from index 0', addressFromXpub(acct.publicExtendedKey, 1) !== a, true);
  t('re-derivation is deterministic', accountFromMnemonic(BURN).publicExtendedKey, acct.publicExtendedKey);

  // -- EVM, pinned to a PUBLISHED vector -------------------------------------
  // This is the whole reason the EVM path is trustworthy. m/44'/60'/0'/0/0 of
  // the standard all-'abandon' phrase is a number thousands of wallets agree
  // on, so if this line passes, our derivation matches MetaMask, Trust and
  // every other EVM wallet. Self-consistency would prove nothing: a stripped
  // 0x04 tag or a missed EIP-55 pass still yields a plausible 40-hex address
  // that simply belongs to nobody.
  const evmAcct = evmAccountFromMnemonic(BURN);
  t('published EVM address #0', evmAddressFromXpub(evmAcct.publicExtendedKey, 0),
    '0x9858EfFD232B4033E47d90003D41EC34EcaEda94');
  t('EVM address is EIP-55 mixed case, not all lower',
    evmAddressFromXpub(evmAcct.publicExtendedKey, 0) !==
    evmAddressFromXpub(evmAcct.publicExtendedKey, 0).toLowerCase(), true);
  t('EVM index 1 differs from index 0',
    evmAddressFromXpub(evmAcct.publicExtendedKey, 1) !==
    evmAddressFromXpub(evmAcct.publicExtendedKey, 0), true);
  t('EVM account path is coin type 60, not 9444', ACCOUNT_PATH_EVM, "m/44'/60'/0'");
  t('EVM xpub is watch-only',
    HDKey.fromExtendedKey(evmAcct.publicExtendedKey).privateKey, null);
  t('the two chains derive different keys from one phrase',
    evmAcct.publicExtendedKey !== acct.publicExtendedKey, true);

  console.log(fail ? '\n  ' + fail + ' FAILED\n' : '\n  ALL CHECKS PASSED\n');
  process.exit(fail ? 1 : 0);
}

// ── entry ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const cmd = argv[0];

if (argv.includes('--selftest')) selftest();
else if (cmd === 'new') await cmdNew(flag('--system'), flag('--chain') || 'pcn');
else if (cmd === 'pool') await cmdPool(flag('--system'), flag('--count'), flag('--start'));
else if (cmd === 'verify') await cmdVerify(flag('--file'));
else if (cmd === 'identify') await cmdIdentify(flag('--file'));
else if (cmd === 'restore') await cmdRestore(flag('--file'));
else {
  console.log('\n  pcoin-seed-vault - create and back up a system\'s PCN wallet\n');
  console.log('    node pcoin-seed-vault.mjs --selftest');
  console.log('    node pcoin-seed-vault.mjs new     --system <name>');
  console.log('    node pcoin-seed-vault.mjs pool    --system <name> --count 1000 [--start 0]');
  console.log('    node pcoin-seed-vault.mjs verify  --file <name>-seed.enc.json');
  console.log('    node pcoin-seed-vault.mjs identify [--file <name>-seed.enc.json]');
  console.log('    node pcoin-seed-vault.mjs restore  --file <name>-seed.enc.json\n');
  console.log('  Run "new" yourself, in your own terminal. The twelve words show once');
  console.log('  and the passphrase is typed, so neither reaches a log or transcript.');
  console.log('  "pool" needs only the xpub and can safely run anywhere.\n');
}
