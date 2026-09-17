#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// Send PCN out of a vault wallet, from this machine, with the key never leaving it.
// ═══════════════════════════════════════════════════════════════════════════
//
//   node vault-sweep.mjs --system checker --to pc1q... --all
//   node vault-sweep.mjs --system checker --to pc1q... --amount 250
//   node vault-sweep.mjs --system checker --to pc1q... --all --send
//
// WITHOUT --send IT BUILDS AND SIGNS BUT BROADCASTS NOTHING. It prints exactly
// what would leave, from where, with what fee and what change. Read that, then
// run the same command again with --send. A transaction cannot be recalled, so
// the default has to be the safe one.
//
// ───────────────────────────────────────────────────────────────────────────
// THE ORDER OF OPERATIONS IS THE SECURITY DESIGN
// ───────────────────────────────────────────────────────────────────────────
// Everything up to the confirmation is done with the PUBLIC xpub: finding the
// addresses, reading their unspent outputs, choosing coins, computing the fee.
// The passphrase is asked for only when there is a signature to make, and the
// decrypted words are used and dropped inside one function.
//
// That ordering is not cosmetic. It means you see the real numbers BEFORE you
// type the passphrase, and it means a mistyped system name or destination is
// caught while nothing secret has been touched.
//
// ───────────────────────────────────────────────────────────────────────────
// THE CHECK THAT MATTERS MOST: THE SEED MUST MATCH THE XPUB
// ───────────────────────────────────────────────────────────────────────────
// A passphrase that decrypts successfully proves only that the passphrase fits
// the blob. It does NOT prove the blob is the wallet whose coins we just
// counted. If they disagree -- wrong file, wrong system, a restored backup from
// another rail -- the signatures would be made by keys that do not own these
// outputs, and the result is a transaction the network silently rejects, or
// worse, one that spends something nobody meant to touch. So the account xpub
// derived from the decrypted words is compared, character for character,
// against the xpub file that was used to find the money. Mismatch aborts.
//
// ───────────────────────────────────────────────────────────────────────────
// WHAT THIS DELIBERATELY WILL NOT DO
// ───────────────────────────────────────────────────────────────────────────
//   * It refuses the `exchange` wallet outright. Those coins are customers'
//     deposits and the exchange's solvency check counts them; moving them
//     halts trading. Sweeping it is never the right answer to "I need PCN".
//   * It refuses `wpcn-reserve` unless --i-know-the-reserve-backs-wpcn is
//     given AND the amount leaves the backing whole. The reserve is not a
//     balance, it is a promise with a balance attached.
//   * It only sends to a pc1q... address (v0, 20 bytes). Anything else is
//     refused rather than guessed at.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash, scryptSync, createDecipheriv } from 'node:crypto';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { HDKey } from '@scure/bip32';
import { bech32 } from '@scure/base';
import { secp256k1 as secp } from '@noble/curves/secp256k1.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const HRP = 'pc';
const ACCOUNT_PATH = "m/84'/9444'/0'";
const EXPLORER = process.env.PCOIN_EXPLORER || 'https://explorer.pc.am';
const SCRYPT = { N: 1 << 17, r: 8, p: 1, keylen: 32, maxmem: 256 * 1024 * 1024 };

// How far along each branch to look. The pool files are 0..1999; gaps happen
// because a rail hands out addresses in order but customers pay out of order.
const SCAN_TO = Number(process.env.VAULT_SCAN_TO || 2000);
const BULK = 200;

const die = (m) => { console.error('\n  REFUSED: ' + m + '\n'); process.exit(1); };
const sat = (n) => (Number(n) / 1e8).toFixed(8);

// ── tiny helpers ───────────────────────────────────────────────────────────
const sha256 = (b) => createHash('sha256').update(b).digest();
const hash256 = (b) => sha256(sha256(b));
const hash160 = (b) => createHash('ripemd160').update(sha256(b)).digest();

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (!hidden) return rl.question(question, (a) => { rl.close(); resolve(a); });
    // Echo nothing at all rather than asterisks: the length of a passphrase is
    // itself worth not showing to whoever is looking at the screen.
    const onData = (ch) => { if (!String(ch).match(/[\r\n]/)) process.stdout.write(''); };
    process.stdout.write(question);
    rl.input.on('data', onData);
    rl._writeToOutput = () => {};
    rl.question('', (a) => { rl.input.off('data', onData); rl.close(); process.stdout.write('\n'); resolve(a); });
  });
}

function decrypt(blob, passphrase) {
  const key = scryptSync(passphrase, Buffer.from(blob.salt, 'base64'), SCRYPT.keylen, SCRYPT);
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'));
  d.setAuthTag(Buffer.from(blob.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(blob.ciphertext, 'base64')), d.final()]).toString('utf8');
}

function addressOf(pubkey) {
  return bech32.encode(HRP, [0, ...bech32.toWords(hash160(pubkey))]);
}

/** pc1q… → the 20-byte hash it pays. Refuses anything that is not v0/20. */
function decodeAddress(addr) {
  let d;
  try { d = bech32.decode(addr); } catch { die(`"${addr}" is not a valid bech32 address`); }
  if (d.prefix !== HRP) die(`"${addr}" is not a PCoin address (prefix ${d.prefix}, expected ${HRP})`);
  const [version, ...rest] = d.words;
  if (version !== 0) die(`only version-0 (pc1q…) addresses are supported; that one is version ${version}`);
  const prog = Buffer.from(bech32.fromWords(rest));
  if (prog.length !== 20) die(`that address has a ${prog.length}-byte program; a pc1q… address has 20`);
  return prog;
}

// ── explorer ───────────────────────────────────────────────────────────────
async function api(path, body = null) {
  const r = await fetch(EXPLORER + path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(45000),
  });
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* handled below */ }
  if (!r.ok || !j) throw new Error(`explorer ${path} -> HTTP ${r.status} ${text.slice(0, 160)}`);
  return j;
}

/** Every address on both branches that has ever been used, with its balance. */
async function findUsed(xpub) {
  const node = HDKey.fromExtendedKey(xpub);
  const all = [];
  for (const branch of [0, 1]) {
    const b = node.deriveChild(branch);
    for (let i = 0; i < SCAN_TO; i++) {
      all.push({ branch, index: i, address: addressOf(b.deriveChild(i).publicKey) });
    }
  }
  const byAddr = new Map(all.map((a) => [a.address, a]));
  const used = [];
  for (let i = 0; i < all.length; i += BULK) {
    const slice = all.slice(i, i + BULK);
    const res = await api('/api/addresses', { addresses: slice.map((a) => a.address) });
    const rows = res.addresses || res.results || res.items || [];
    for (const row of rows) {
      const a = byAddr.get(row.address);
      const c = (row.balance && row.balance.confirmed) || row.balance || {};
      const spendable = Number(c.spendable_sat ?? 0);
      if (spendable > 0) used.push({ ...a, spendable });
    }
    // Redraw in place only on a real terminal. Piped into a file or a log, a
    // carriage return turns the whole scan into one unreadable line.
    if (process.stdout.isTTY) {
      process.stdout.write(`\r  scanning ${Math.min(i + BULK, all.length)}/${all.length} addresses…   `);
    }
  }
  if (process.stdout.isTTY) process.stdout.write('\r' + ' '.repeat(60) + '\r');
  return used;
}

async function utxosFor(address) {
  const d = await api(`/api/address/${address}/utxos`);
  return (d.utxos || []).filter((u) => !u.is_immature && !u.pending_spend);
}

// ── transaction building ───────────────────────────────────────────────────
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
function varint(n) {
  if (n < 0xfd) return Buffer.from([n]);
  if (n <= 0xffff) return Buffer.concat([Buffer.from([0xfd]), Buffer.from([n & 0xff, n >> 8])]);
  const b = Buffer.alloc(5); b[0] = 0xfe; b.writeUInt32LE(n, 1); return b;
}
const scriptPubKey = (h160) => Buffer.concat([Buffer.from([0x00, 0x14]), h160]);

/** BIP143. The bytes a P2WPKH input actually commits to.
 *
 *  version, locktime and the per-input sequences are parameters rather than
 *  constants ONLY so that --selftest can reproduce the vector published in
 *  BIP143 itself, which uses version 1, locktime 0x11 and two different
 *  sequences. Getting this function wrong produces signatures that are
 *  perfectly well-formed and spend nothing, so it is worth proving against
 *  somebody else's numbers rather than our own.
 */
function sighash(tx, i, scriptCode, amountSat, opts = {}) {
  const version = opts.version ?? 2;
  const locktime = opts.locktime ?? 0;
  const seqOf = (n) => (tx.ins[n].sequence ?? 0xfffffffd);
  const prevouts = Buffer.concat(tx.ins.map((x) => Buffer.concat([Buffer.from(x.txid, 'hex').reverse(), u32(x.vout)])));
  const seqs = Buffer.concat(tx.ins.map((_, n) => u32(seqOf(n))));
  const outs = Buffer.concat(tx.outs.map((o) => Buffer.concat([u64(o.value), varint(o.script.length), o.script])));
  const inp = tx.ins[i];
  return hash256(Buffer.concat([
    u32(version),
    hash256(prevouts),
    hash256(seqs),
    Buffer.from(inp.txid, 'hex').reverse(), u32(inp.vout),
    varint(scriptCode.length), scriptCode,
    u64(amountSat),
    u32(seqOf(i)),
    hash256(outs),
    u32(locktime),
    u32(1),                       // SIGHASH_ALL
  ]));
}

/** Prove the signing maths against numbers this project did not choose.
 *
 *  The vector is the native-P2WPKH example from BIP143. If our sighash matches
 *  the one the BIP publishes, the preimage layout, the byte orders, the varints
 *  and the double-SHA are all correct -- which is everything that stands
 *  between a signature and a coin that can never be moved again.
 */
function selftest() {
  let bad = 0;
  const ok = (label, got, want) => {
    const good = got === want;
    if (!good) bad++;
    console.log(`  ${good ? 'ok  ' : '*** '} ${label}`);
    if (!good) console.log(`        got  ${got}\n        want ${want}`);
  };

  // BIP143, "Native P2WPKH" example. Second input is the witness one.
  const tx = {
    ins: [
      { txid: '9f96ade4b41d5433f4eda31e1738ec2b36f6e7d1420d94a6af99801a88f7f7ff', vout: 0, sequence: 0xffffffee },
      { txid: '8ac60eb9575db5b2d987e29f301b5b819ea83a5c6579d282d189cc04b8e151ef', vout: 1, sequence: 0xffffffff },
    ],
    outs: [
      { value: 0x0000000006b22c20, script: Buffer.from('76a9148280b37df378db99f66f85c95a783a76ac7a6d5988ac', 'hex') },
      { value: 0x0000000d519390, script: Buffer.from('76a9143bde42dbee7e4dbe6a21b2d50ce2f0167faa815988ac', 'hex') },
    ],
  };
  // NOTE: no 0x19 length prefix here. sighash() writes the varint itself, and
  // supplying it twice is exactly the bug this vector caught.
  const code = Buffer.from('76a9141d0f172a0ecb48aee1be1f2687d2963ae33f71a188ac', 'hex');
  const h = sighash(tx, 1, code, 600000000, { version: 1, locktime: 0x11 });
  ok('BIP143 native P2WPKH sighash',
     h.toString('hex'),
     'c37af31116d1b27caf68aae9e3ac82f1477929014d5b917657d0eb49478cb670');

  // A signature over it must verify against the BIP's own public key.
  const priv = Buffer.from('619c335025c7f4012e556c2a58b2506e30b8511b53ade95ea316fd8c3286feb9', 'hex');
  const pub = Buffer.from(secp.getPublicKey(priv, true));
  ok('and the matching public key',
     pub.toString('hex'),
     '025476c2e83188368da1ff3e292e7acafcdb3566bb0ad253f62fc70f07aeee6357');
  const compact = secp.sign(h, priv, { lowS: true });
  ok('a signature over it verifies', String(secp.verify(compact, h, pub)), 'true');

  // DER: the shape a witness actually carries, and the two rules that silently
  // break it. A value with the top bit set must gain a 0x00; a surplus leading
  // zero must be dropped.
  const der = derSig(compact);
  ok('DER starts 0x30 and is self-consistent',
     String(der[0] === 0x30 && der[1] === der.length - 2), 'true');
  const high = derSig(Buffer.concat([Buffer.alloc(31, 0).fill(0), Buffer.from([0x80]), Buffer.alloc(31, 0), Buffer.from([0x01])]));
  ok('DER pads a high-bit value', String(high[4] === 0x00), 'true');
  const lead = derSig(Buffer.concat([Buffer.alloc(31, 0), Buffer.from([0x05]), Buffer.alloc(31, 0), Buffer.from([0x07])]));
  ok('DER strips surplus leading zeros', String(lead[3] === 1 && lead[4] === 0x05), 'true');

  // Address encoding, against the one address in the vault we can check for free.
  ok('p2wpkh address from a pubkey',
     addressOf(Buffer.from('025476c2e83188368da1ff3e292e7acafcdb3566bb0ad253f62fc70f07aeee6357', 'hex')).slice(0, 4),
     'pc1q');

  // Refusing a bad destination is a safety feature, so prove it refuses.
  for (const bad of ['bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'pc1zw508d6qejxtdg4y5r3zarvaryvg6kdaj', 'nonsense']) {
    let threw = false;
    const realExit = process.exit;
    process.exit = () => { threw = true; throw new Error('refused'); };
    try { decodeAddress(bad); } catch { /* expected */ }
    process.exit = realExit;
    ok(`refuses "${bad.slice(0, 22)}…"`, String(threw), 'true');
  }

  console.log(bad ? `\n  ${bad} CHECK(S) FAILED\n` : '\n  ALL CHECKS PASSED\n');
  process.exit(bad ? 1 : 0);
}

/** A 64-byte compact (r‖s) signature as DER, which is what a witness carries.
 *
 *  Written out rather than taken from the library's `format:'der'` because the
 *  encoding has one rule that silently produces invalid signatures if missed:
 *  DER integers are SIGNED, so any value whose top bit is set needs a leading
 *  zero byte, and any leading zero that is NOT needed must be stripped. Both
 *  halves are exercised by --selftest.
 */
function derSig(compact) {
  const trim = (b) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;          // drop surplus zeros
    const v = b.subarray(i);
    return v[0] & 0x80 ? Buffer.concat([Buffer.from([0]), v]) : Buffer.from(v);
  };
  const r = trim(Buffer.from(compact.subarray(0, 32)));
  const s = trim(Buffer.from(compact.subarray(32, 64)));
  const body = Buffer.concat([Buffer.from([0x02, r.length]), r, Buffer.from([0x02, s.length]), s]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

function buildAndSign(tx, keyFor) {
  const witnesses = tx.ins.map((inp, i) => {
    const { priv, pub } = keyFor(inp);
    // The scriptCode of a P2WPKH input is the equivalent P2PKH script, WITHOUT
    // a length prefix -- sighash() adds it as a varint. Carrying the 0x19 here
    // as well produced a double prefix, a wrong preimage, and signatures that
    // were perfectly well-formed and spent nothing. Caught by the BIP143 vector.
    const code = Buffer.concat([Buffer.from([0x76, 0xa9, 0x14]), hash160(pub), Buffer.from([0x88, 0xac])]);
    const h = sighash(tx, i, code, inp.value);
    // lowS is relay policy: a high-S signature is valid maths and a
    // non-standard transaction that never propagates.
    const compact = secp.sign(h, priv, { lowS: true });
    if (!secp.verify(compact, h, pub)) throw new Error(`input ${i}: signature failed self-verification`);
    return [Buffer.concat([derSig(compact), Buffer.from([0x01])]), Buffer.from(pub)];
  });

  const body = Buffer.concat([
    u32(2),
    varint(tx.ins.length),
    ...tx.ins.map((x) => Buffer.concat([Buffer.from(x.txid, 'hex').reverse(), u32(x.vout), Buffer.from([0x00]), u32(0xfffffffd)])),
    varint(tx.outs.length),
    ...tx.outs.map((o) => Buffer.concat([u64(o.value), varint(o.script.length), o.script])),
  ]);
  const wit = Buffer.concat(witnesses.map((w) => Buffer.concat([varint(w.length), ...w.map((x) => Buffer.concat([varint(x.length), x]))])));
  const full = Buffer.concat([u32(2), Buffer.from([0x00, 0x01]), body.subarray(4), wit, u32(0)]);
  const stripped = Buffer.concat([body, u32(0)]);
  return { hex: full.toString('hex'), txid: hash256(stripped).reverse().toString('hex'), vsize: Math.ceil((stripped.length * 3 + full.length) / 4) };
}

// ── main ───────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const has = (n) => argv.includes(n);

if (has('--selftest')) selftest();

/** What every vault wallet holds, read off the chain. No keys, no passphrase.
 *
 *  Exists so "which vault has coins in it" is a question this machine can
 *  answer on its own. It is a full scan of both branches for every system, so
 *  it takes a couple of minutes -- a faster partial scan would report a used
 *  address beyond the cut-off as ZERO, and a wrong zero is worse than a wait.
 */
async function listAll() {
  const names = readdirSync(HERE).filter((f) => f.endsWith('-xpub.txt')).map((f) => f.replace('-xpub.txt', '')).sort();
  console.log(`\n  reading ${names.length} vault wallets off the chain (both branches, ${SCAN_TO} deep)…\n`);
  const rows = [];
  for (const name of names) {
    const xpub = readFileSync(join(HERE, `${name}-xpub.txt`), 'utf8').trim();
    let total = 0;
    let addrs = 0;
    try {
      for (const a of await findUsed(xpub)) { total += a.spendable; addrs++; }
    } catch (e) {
      console.log(`  ${name.padEnd(16)} unreadable: ${e.message.slice(0, 60)}`);
      continue;
    }
    rows.push({ name, total, addrs });
    const note = name === 'exchange' ? '  <- CUSTOMERS\' deposits, never sweep'
      : name === 'wpcn-reserve' ? '  <- backs wPCN 1:1; only the surplus is yours'
        : '';
    console.log(`  ${name.padEnd(16)} ${sat(total).padStart(16)} PCN   ${String(addrs).padStart(3)} address(es)${note}`);
  }
  const sweepable = rows.filter((r) => r.name !== 'exchange' && r.name !== 'wpcn-reserve')
    .reduce((s, r) => s + r.total, 0);
  console.log(`\n  freely sweepable (everything except exchange and the wPCN reserve): ${sat(sweepable)} PCN\n`);
  process.exit(0);
}
if (has('--list')) await listAll();

const system = flag('--system');
const to = flag('--to');
const amountArg = flag('--amount');
const sendAll = has('--all');
const doSend = has('--send');

if (!system || !to || (!amountArg && !sendAll)) {
  const names = readdirSync(HERE).filter((f) => f.endsWith('-xpub.txt')).map((f) => f.replace('-xpub.txt', ''));
  console.log(`
  node vault-sweep.mjs --system <name> --to <pc1q…> (--all | --amount <PCN>) [--send]
  node vault-sweep.mjs --list        what every vault holds, no passphrase needed
  node vault-sweep.mjs --selftest    prove the signing against the BIP143 vector

  Builds and signs, and prints what would be sent. It broadcasts NOTHING until
  you add --send, because a transaction cannot be taken back.

  systems: ${names.join(', ')}
`);
  process.exit(2);
}

if (system === 'exchange') {
  die('the `exchange` wallet holds CUSTOMERS\' deposits and its solvency check counts them.\n'
    + '           Moving coins out of it halts trading. This tool will not do it.');
}
if (system === 'wpcn-reserve' && !has('--i-know-the-reserve-backs-wpcn')) {
  die('`wpcn-reserve` backs every wPCN in circulation 1:1.\n'
    + '           Only the SURPLUS above the wPCN supply is yours to move.\n'
    + '           Re-run with --i-know-the-reserve-backs-wpcn if that is what you mean,\n'
    + '           and check D:\\pc.am\\PCOIN-WPCN-RUNBOOK.md first.');
}

const xpubFile = join(HERE, `${system}-xpub.txt`);
const seedFile = join(HERE, `${system}-seed.enc.json`);
if (!existsSync(xpubFile)) die(`no xpub for "${system}" (looked for ${xpubFile})`);
if (!existsSync(seedFile)) die(`no encrypted seed for "${system}" (looked for ${seedFile})`);

const xpub = readFileSync(xpubFile, 'utf8').trim();
const toHash = decodeAddress(to);

console.log(`\n  system      : ${system}`);
console.log(`  destination : ${to}`);
console.log(`  explorer    : ${EXPLORER}\n`);

const used = await findUsed(xpub);
if (!used.length) die(`"${system}" has no spendable coins at any address on either branch`);

let utxos = [];
for (const a of used) {
  for (const u of await utxosFor(a.address)) {
    utxos.push({ txid: u.txid, vout: u.vout, value: Number(u.value_sat ?? u.value), branch: a.branch, index: a.index, address: a.address });
  }
}
utxos = utxos.filter((u) => u.value > 0).sort((a, b) => b.value - a.value);
const available = utxos.reduce((s, u) => s + u.value, 0);

console.log(`  found       : ${utxos.length} unspent output(s) across ${used.length} address(es)`);
console.log(`  available   : ${sat(available)} PCN\n`);

// ── choose coins ───────────────────────────────────────────────────────────
// Fee: vsize is 10.5 + 68 per P2WPKH input + 31 per output, rounded up. The
// chain has no fee market to speak of, so the floor is what matters; 2 sat/vB
// is comfortably above relay and still costs a fraction of a coin.
const FEE_RATE = Number(process.env.VAULT_FEE_RATE || 2);
const vsizeFor = (ins, outs) => Math.ceil(10.5 + 68 * ins + 31 * outs);

let chosen = [];
let outs = [];
let fee = 0;

if (sendAll) {
  chosen = utxos;
  fee = vsizeFor(chosen.length, 1) * FEE_RATE;
  const value = available - fee;
  if (value <= 0) die(`the whole balance (${sat(available)}) does not cover the fee (${sat(fee)})`);
  outs = [{ value, script: scriptPubKey(toHash) }];
} else {
  const want = Math.round(Number(amountArg) * 1e8);
  if (!Number.isFinite(want) || want <= 0) die(`"${amountArg}" is not a valid amount of PCN`);
  let total = 0;
  for (const u of utxos) {
    chosen.push(u); total += u.value;
    fee = vsizeFor(chosen.length, 2) * FEE_RATE;
    if (total >= want + fee) break;
  }
  if (total < want + fee) {
    die(`not enough: asked for ${sat(want)} + ${sat(fee)} fee, but only ${sat(total)} is spendable here`);
  }
  const change = total - want - fee;
  outs = [{ value: want, script: scriptPubKey(toHash) }];
  // Dust would cost more to spend than it is worth; give it to the fee rather
  // than create an output nobody will ever economically move.
  if (change > 1000) {
    const ch = HDKey.fromExtendedKey(xpub).deriveChild(1).deriveChild(0);
    outs.push({ value: change, script: scriptPubKey(hash160(ch.publicKey)), changeTo: addressOf(ch.publicKey) });
  } else if (change > 0) {
    fee += change;
  }
}

const sending = outs[0].value;
const changeOut = outs[1];

console.log('  ──────────────────────────────────────────────────────────────');
console.log(`   SEND        ${sat(sending)} PCN`);
console.log(`   TO          ${to}`);
console.log(`   from        ${system}  (${chosen.length} input(s))`);
console.log(`   fee         ${sat(fee)} PCN  (${FEE_RATE} sat/vB)`);
if (changeOut) console.log(`   change      ${sat(changeOut.value)} PCN back to ${changeOut.changeTo}`);
console.log('  ──────────────────────────────────────────────────────────────\n');

const tx = { ins: chosen.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, branch: u.branch, index: u.index })), outs };

const pass = await ask('  passphrase for the vault file (nothing is echoed): ', { hidden: true });
if (!pass) die('no passphrase given');

let mnemonic;
try {
  mnemonic = decrypt(JSON.parse(readFileSync(seedFile, 'utf8')), pass).trim();
} catch {
  die('that passphrase does not open this vault file');
}
if (!bip39.validateMnemonic(mnemonic, wordlist)) die('the decrypted text is not a valid recovery phrase');

const master = HDKey.fromMasterSeed(bip39.mnemonicToSeedSync(mnemonic));
const account = master.derive(ACCOUNT_PATH);

// THE CHECK. A passphrase that opens the file proves only that; it does not
// prove this is the wallet whose coins were just counted.
if (account.publicExtendedKey !== xpub) {
  die('the phrase in that file does NOT derive the xpub these coins were found with.\n'
    + '           Nothing has been signed. Check you named the right system.');
}
console.log('  seed matches the xpub the coins were found with. ✓');

const keyFor = (inp) => {
  const child = account.deriveChild(inp.branch).deriveChild(inp.index);
  return { priv: child.privateKey, pub: child.publicKey };
};
const signed = buildAndSign(tx, keyFor);
mnemonic = null;

console.log(`  signed      : txid ${signed.txid}`);
console.log(`  size        : ${signed.vsize} vB, fee ${sat(fee)} PCN\n`);

if (!doSend) {
  console.log('  --- NOT SENT. Nothing has been broadcast. ---');
  console.log('  Re-run the identical command with --send to actually send it.\n');
  process.exit(0);
}

let txid = null;
let error = null;
try {
  const r = await api('/api/tx', { hex: signed.hex });
  txid = r.txid || r.result || signed.txid;
  console.log(`  BROADCAST   ${txid}`);
  console.log(`  ${EXPLORER}/tx/${txid}\n`);
} catch (e) {
  error = e.message;
  console.error(`\n  BROADCAST FAILED: ${e.message}`);
  console.error('  Nothing was sent. The signed transaction is in the receipt if you want to retry it.\n');
}

// A receipt, beside the vault. Never the phrase, never the passphrase -- the
// point is to be able to answer "what did I send, when, and did it land".
const receipt = {
  at: new Date().toISOString(),
  system, to,
  sent_pcn: sat(sending),
  fee_pcn: sat(fee),
  change_pcn: changeOut ? sat(changeOut.value) : '0.00000000',
  inputs: chosen.length,
  txid: txid || signed.txid,
  broadcast: Boolean(txid),
  error,
  raw_hex: signed.hex,
};
const path = join(HERE, `sweep-${system}-${receipt.at.replace(/[:.]/g, '-')}.json`);
writeFileSync(path, JSON.stringify(receipt, null, 2));
console.log(`  receipt     : ${path}\n`);
process.exit(error ? 1 : 0);
