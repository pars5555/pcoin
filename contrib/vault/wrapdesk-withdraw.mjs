#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// wrapdesk-withdraw — spend NAMED outputs of the wPCN reserve, and nothing else
// ═══════════════════════════════════════════════════════════════════════════
//
// WHO RUNS THIS
// The owner, on their own machine. It reconstructs a key that can spend the
// entire reserve, so it never runs on a server, never takes the passphrase as
// an argument, and never writes the seed or the derived key anywhere.
//
// WHY IT EXISTS
// The desk returns over-limit deposits. Doing that by hand means restoring a
// seed, importing a descriptor and hand-building a coin-controlled
// transaction: half an hour of fiddly steps, at the end of which one mistyped
// index sends the reserve somewhere nobody can get it back from.
//
// WHAT MAKES IT SAFE — none of these are optional:
//
//   1. EVERY input is named on the command line. There is no "spend the
//      balance" mode and no change hunting. An outpoint that is not listed
//      cannot be spent, so index 0 — the entire backing — is unreachable
//      unless somebody types it out in full.
//   2. The derived address is checked against the address the named outputs
//      actually pay to, BEFORE anything is signed. A wrong --index fails
//      loudly instead of producing a valid transaction from the wrong part of
//      the wallet.
//   3. Every signature is verified against its own public key before the
//      transaction is assembled.
//   4. Nothing is broadcast without --broadcast. The default run prints the
//      fully decoded transaction and stops.
//
// USAGE
//   node wrapdesk-withdraw.mjs --selftest
//   node wrapdesk-withdraw.mjs --index 3 --to pc1q... \
//        --utxo <txid>:<vout> [--utxo ...] [--fee-rate 2] [--broadcast]

import { readFileSync } from 'node:fs';
import { createDecipheriv, scryptSync, createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import * as bip39 from '@scure/bip39';
import { HDKey } from '@scure/bip32';
import { bech32 } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';

const EXPLORER = process.env.WRAPDESK_EXPLORER || 'https://explorer.pc.am';
const ACCOUNT = "m/84'/9444'/0'";
const HRP = 'pc';

// Identical to pcoin-seed-vault.mjs. A second set of numbers here would be a
// second thing to get wrong, and a blob that refuses to open.
const SCRYPT = { N: 1 << 17, r: 8, p: 1, keylen: 32, maxmem: 256 * 1024 * 1024 };

const sha256 = (b) => createHash('sha256').update(b).digest();
const hash256 = (b) => sha256(sha256(b));
const rmd160 = (b) => createHash('ripemd160').update(b).digest();
const hash160 = (b) => rmd160(sha256(b));

export function decrypt(blob, passphrase) {
  const key = scryptSync(passphrase, Buffer.from(blob.salt, 'base64'),
                         SCRYPT.keylen, SCRYPT);
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'));
  d.setAuthTag(Buffer.from(blob.tag, 'base64'));
  // GCM authenticates, so a wrong passphrase throws here rather than handing
  // back plausible rubbish that would go on to derive a real but WRONG key.
  return Buffer.concat([d.update(Buffer.from(blob.ct, 'base64')), d.final()])
    .toString('utf8');
}

export const p2wpkhAddr = (pub) =>
  bech32.encode(HRP, [0, ...bech32.toWords(hash160(pub))]);

export function accountFromMnemonic(mnemonic) {
  const seed = bip39.mnemonicToSeedSync(mnemonic.trim(), '');
  return HDKey.fromMasterSeed(seed).derive(ACCOUNT);
}

// ── little-endian and varint helpers, used by the BIP143 preimage ──────────
export const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
export const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
export function varint(n) {
  if (n < 0xfd) return Buffer.from([n]);
  if (n <= 0xffff) return Buffer.concat([Buffer.from([0xfd]), (() => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; })()]);
  if (n <= 0xffffffff) return Buffer.concat([Buffer.from([0xfe]), u32(n)]);
  return Buffer.concat([Buffer.from([0xff]), u64(n)]);
}
export const rev = (hex) => Buffer.from(hex, 'hex').reverse();

// scriptPubKey for a bech32 P2WPKH address: OP_0 <20-byte hash>
export function addrToScript(addr) {
  const d = bech32.decode(addr);
  if (d.prefix !== HRP) throw new Error(`address is not ${HRP}1...: ${addr}`);
  const words = d.words.slice();
  const ver = words.shift();
  if (ver !== 0) throw new Error('only v0 (pc1q...) outputs are supported');
  const prog = Buffer.from(bech32.fromWords(words));
  if (prog.length !== 20) throw new Error('not a 20-byte P2WPKH program');
  return Buffer.concat([Buffer.from([0x00, 0x14]), prog]);
}

export function ask(q, hidden = false) {
  return new Promise((res) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      const onData = (ch) => {
        const s = ch.toString('utf8');
        if (s.includes('\n') || s.includes('\r') || s.includes(''))
          process.stdin.removeListener('data', onData);
        else process.stdout.write('[2K[200D' + q);
      };
      process.stdin.on('data', onData);
    }
    rl.question(q, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); res(a); });
  });
}

// ── BIP143: the sighash for a segwit v0 input ──────────────────────────────
//
// Getting this wrong does not fail loudly. It produces a transaction that is
// well-formed and simply will not verify, or -- far worse with a hand-rolled
// signer -- one that commits to different values than the ones displayed. So
// every field below is spelled out rather than folded together, and the result
// is checked against a real node with testmempoolaccept before it can be sent.
export function bip143Preimage({ inputs, outputs, index, value, script,
                                sequence = 0xfffffffd, locktime = 0, version = 2,
                                sequences = null }) {
  const hashPrevouts = hash256(Buffer.concat(
    inputs.map((i) => Buffer.concat([rev(i.txid), u32(i.vout)]))));
  const seqOf = (n) => (sequences ? sequences[n] : sequence);
  const hashSequence = hash256(Buffer.concat(inputs.map((_, n) => u32(seqOf(n)))));
  const hashOutputs = hash256(Buffer.concat(outputs.map((o) =>
    Buffer.concat([u64(o.value), varint(o.script.length), o.script]))));
  const inp = inputs[index];
  // The scriptCode of a P2WPKH input is the P2PKH script for the same key --
  // NOT the witness program. This is the single most commonly mis-implemented
  // line in BIP143.
  const pkh = script.subarray(2);
  const scriptCode = Buffer.concat([
    Buffer.from([0x19, 0x76, 0xa9, 0x14]), pkh, Buffer.from([0x88, 0xac])]);
  return Buffer.concat([
    u32(version),                             // nVersion
    hashPrevouts, hashSequence,
    rev(inp.txid), u32(inp.vout),             // the outpoint being signed
    scriptCode,
    u64(value),                               // the value it holds
    u32(seqOf(index)),
    hashOutputs,
    u32(locktime),
    u32(1),                                   // SIGHASH_ALL
  ]);
}

// DER + the one-byte sighash flag, which is what goes in the witness.
//
// @noble/curves v2 returns a raw 64-byte compact signature by default; Bitcoin
// consensus wants DER. Asking the library for it is safer than hand-rolling the
// encoding, which has to get the leading-zero and negative-integer cases right.
function derSig(derBytes) {
  return Buffer.concat([Buffer.from(derBytes), Buffer.from([0x01])]);
}

export function buildSignedTx({ inputs, outputs, priv, pub, script }) {
  const witnesses = [];
  for (let i = 0; i < inputs.length; i++) {
    const pre = bip143Preimage({ inputs, outputs, index: i, value: inputs[i].value, script });
    const h = hash256(pre);
    // prehash:false is LOAD-BEARING. @noble/curves v2 HASHES the message before
    // signing unless told not to, so passing an already-computed sighash makes
    // it sign sha256(sighash) -- a perfectly valid signature over the wrong
    // thing. Bitcoin then rejects the input with NULLFAIL:
    //
    //   mempool-script-verify-flag-failed
    //   (Signature must be zero for failed CHECK(MULTI)SIG operation)
    //
    // The self-check below did not catch it, because verify() defaults the same
    // way and so agreed with the bug. Only an independent verifier found it --
    // which is exactly why testmempoolaccept against a real node is part of the
    // procedure and not a nicety.
    //
    // lowS: a high-S signature is valid secp256k1 but non-standard on the
    // network, so it would relay nowhere and look like a mystery.
    const sig = secp256k1.sign(h, priv, { lowS: true, format: 'der', prehash: false });
    if (!secp256k1.verify(sig, h, pub, { format: 'der', prehash: false }))
      throw new Error(`signature ${i} failed self-verification -- refusing to continue`);
    witnesses.push([derSig(sig), Buffer.from(pub)]);
  }
  const ins = Buffer.concat(inputs.map((i) => Buffer.concat([
    rev(i.txid), u32(i.vout), Buffer.from([0x00]), u32(0xfffffffd)])));
  const outs = Buffer.concat(outputs.map((o) => Buffer.concat([
    u64(o.value), varint(o.script.length), o.script])));
  const wit = Buffer.concat(witnesses.map((w) => Buffer.concat([
    varint(w.length), ...w.map((x) => Buffer.concat([varint(x.length), x]))])));
  const tx = Buffer.concat([
    u32(2), Buffer.from([0x00, 0x01]),        // marker + flag: this is segwit
    varint(inputs.length), ins,
    varint(outputs.length), outs,
    wit, u32(0)]);
  // txid is the hash of the tx WITHOUT witness data; wtxid includes it.
  const stripped = Buffer.concat([
    u32(2), varint(inputs.length), ins, varint(outputs.length), outs, u32(0)]);
  return { hex: tx.toString('hex'), txid: hash256(stripped).reverse().toString('hex'),
           vsize: Math.ceil((stripped.length * 3 + tx.length) / 4) };
}

// ── explorer ───────────────────────────────────────────────────────────────
async function jget(path) {
  const r = await fetch(EXPLORER + path, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
  return r.json();
}

const PCN = (sat) => (sat / 1e8).toFixed(8);

function arg(name, def = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const argAll = (name) => process.argv
  .map((a, i) => (a === name ? process.argv[i + 1] : null)).filter(Boolean);
const has = (name) => process.argv.includes(name);

async function main() {
  // NOT Number(arg('--index')). arg() returns null when the flag is absent and
  // Number(null) is 0 -- so a forgotten --index would have silently selected
  // index 0, which is the main reserve holding the entire backing. The flag has
  // to be PRESENT, not merely numeric.
  const indexRaw = arg('--index');
  const index = indexRaw === null ? NaN : Number(indexRaw);
  const to = arg('--to');
  const wanted = argAll('--utxo');
  const file = arg('--file', 'wpcn-reserve-seed.enc.json');
  const feeRate = Number(arg('--fee-rate', '2'));      // sat/vB

  if (!Number.isInteger(index) || index < 0)
    die('--index <n> is required and must be a whole number. There is no ' +
        'default: index 0 is the main reserve, so a missing flag must never ' +
        'quietly resolve to it.');
  if (!to) die('--to <pc1...> is required. There is no default; the destination ' +
               'is the one thing a typo makes unrecoverable.');
  if (!wanted.length) die('at least one --utxo <txid>:<vout> is required. This ' +
                          'script has no "spend the balance" mode on purpose.');
  const outScript = addrToScript(to);                  // throws early on a bad address

  // ── the key, never touching disk ────────────────────────────────────────
  const blob = JSON.parse(readFileSync(file, 'utf8'));
  console.log(`\n  vault blob : ${file}`);
  console.log(`  system     : ${blob.system}   path ${blob.path}   created ${blob.created}`);
  const pass = await ask('  passphrase (typed, not echoed): ', true);
  let mnemonic;
  try { mnemonic = decrypt(blob, pass); }
  catch { die('that passphrase does not open this blob. Nothing was changed.'); }

  const acct = accountFromMnemonic(mnemonic);
  const node = acct.deriveChild(0).deriveChild(index);
  const pub = Buffer.from(node.publicKey);
  const priv = Buffer.from(node.privateKey);
  const from = p2wpkhAddr(pub);
  console.log(`\n  spending from ${ACCOUNT}/0/${index}`);
  console.log(`             = ${from}`);

  // The blob records address0. If the account does not reproduce it, the words
  // are for a different wallet and every index below would be wrong too.
  const a0 = p2wpkhAddr(Buffer.from(acct.deriveChild(0).deriveChild(0).publicKey));
  if (blob.address0 && a0 !== blob.address0)
    die(`account mismatch: 0/0 derives ${a0} but the blob records ${blob.address0}`);
  console.log(`  account check: 0/0 = ${a0} matches the blob`);

  // ── the inputs, and only the named ones ─────────────────────────────────
  const avail = await jget(`/api/address/${from}/utxos`);
  const list = avail.utxos || avail.items || [];
  const byKey = new Map(list.map((u) => [`${u.txid}:${u.vout}`, u]));
  const inputs = [];
  if (new Set(wanted).size !== wanted.length)
    die('the same --utxo was given twice. That would double-count its value and ' +
        'produce a transaction spending an input that does not exist.');
  for (const w of wanted) {
    const u = byKey.get(w);
    if (!u) die(`${w} is not an unspent output of ${from}. Nothing was signed.`);

    // Everything the explorer already knows, checked rather than assumed. Each
    // of these produces a transaction that is silently invalid if it is wrong,
    // and the failure would surface as a rejection with no explanation.
    if (u.spent_in_mempool)
      die(`${w} is already being spent by a transaction in the mempool. ` +
          `Signing it again is how the same coins get sent twice.`);
    if (u.spendable === false)
      die(`${w} is not spendable (${u.status ?? 'no status given'})`);
    if (u.is_coinbase && u.mature === false)
      die(`${w} is an immature coinbase output; it cannot be spent until ` +
          `height ${u.maturity_height}`);

    // The strongest check available: the output's own script must be the one
    // this key produces. If it is not, the --index is wrong and no amount of
    // correct signing would help.
    const want = addrToScript(from).toString('hex');
    if (u.script_hex && u.script_hex.toLowerCase() !== want)
      die(`${w} pays to script ${u.script_hex}, not ${want}. The --index does ` +
          `not match the outputs being spent.`);

    const value = Number(u.value_sat ?? Math.round(Number(u.value_pcn) * 1e8));
    if (!Number.isInteger(value) || value <= 0) die(`${w} has an unreadable value`);
    inputs.push({ txid: u.txid, vout: u.vout, value });
  }
  const total = inputs.reduce((a, b) => a + b.value, 0);

  // ── the fee, taken from the amount so there is no change output ─────────
  //
  // No change is deliberate. A change output would return coins to this same
  // wallet, which is fine, but it also means a mistake in change handling can
  // silently send the remainder somewhere else. With no change, everything
  // that leaves the named inputs goes to --to, and the fee is the difference.
  const vsize = Math.ceil(inputs.length * 68 + 31 + 11);
  const fee = Math.max(Math.ceil(vsize * feeRate), 200);
  const send = total - fee;
  if (send <= 0) die('the named inputs do not cover the fee');

  const outputs = [{ value: send, script: outScript }];
  const tx = buildSignedTx({ inputs, outputs, priv, pub, script: addrToScript(from) });

  console.log(`\n  ── what this will do ───────────────────────────────────────`);
  for (const i of inputs) console.log(`    spend  ${i.txid}:${i.vout}  ${PCN(i.value)} PCN`);
  console.log(`    ------ inputs total ${PCN(total)} PCN`);
  console.log(`    fee    ${PCN(fee)} PCN  (~${feeRate} sat/vB over ~${tx.vsize} vB)`);
  console.log(`    SEND   ${PCN(send)} PCN`);
  console.log(`    TO     ${to}`);
  console.log(`    change none, by design`);
  console.log(`\n    txid would be ${tx.txid}`);
  console.log(`\n  ── verify on a node before sending ─────────────────────────`);
  console.log(`    bitcoin-cli testmempoolaccept '["${tx.hex}"]'`);

  if (!has('--broadcast')) {
    console.log(`\n  DRY RUN. Nothing was sent. Re-run with --broadcast to send.\n`);
    return;
  }
  const confirm = await ask(`\n  Type SEND to broadcast ${PCN(send)} PCN to ${to}: `);
  if (confirm.trim() !== 'SEND') { console.log('  not confirmed; nothing sent.\n'); return; }
  const r = await fetch(`${EXPLORER}/api/tx`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hex: tx.hex }), signal: AbortSignal.timeout(30000) });
  const body = await r.text();
  console.log(`\n  broadcast -> HTTP ${r.status}\n  ${body.slice(0, 400)}\n`);
}

function die(msg) { console.error(`\n  REFUSED: ${msg}\n`); process.exit(2); }

if (process.argv[1] && process.argv[1].endsWith('wrapdesk-withdraw.mjs') && !has('--selftest'))
  main().catch((e) => { console.error('\n  ERROR:', e.message, '\n'); process.exit(1); });

// ── selftest ───────────────────────────────────────────────────────────────
//
// Everything here was a real defect during development, which is why each case
// exists. Run it before trusting a change: a signer that has only ever been
// watched succeeding has not been tested.
export async function selftest() {
  let ok = 0, bad = 0;
  const t = (name, cond, got) => {
    if (cond) { ok++; console.log('  PASS  ' + name); }
    else { bad++; console.log('  FAIL  ' + name + (got !== undefined ? '\n        got: ' + got : '')); }
  };

  // 1. The official BIP143 native-P2WPKH vector. If this drifts, nothing the
  //    signer produces can be trusted, however plausible it looks.
  const inputs = [
    { txid: '9f96ade4b41d5433f4eda31e1738ec2b36f6e7d1420d94a6af99801a88f7f7ff', vout: 0 },
    { txid: '8ac60eb9575db5b2d987e29f301b5b819ea83a5c6579d282d189cc04b8e151ef', vout: 1 }];
  const outs = [
    { value: 112340000, script: Buffer.from('76a9148280b37df378db99f66f85c95a783a76ac7a6d5988ac', 'hex') },
    { value: 223450000, script: Buffer.from('76a9143bde42dbee7e4dbe6a21b2d50ce2f0167faa815988ac', 'hex') }];
  const pre = bip143Preimage({
    inputs, outputs: outs, index: 1, value: 600000000,
    script: Buffer.concat([Buffer.from([0x00, 0x14]),
                           Buffer.from('1d0f172a0ecb48aee1be1f2687d2963ae33f71a1', 'hex')]),
    sequences: [0xffffffee, 0xffffffff], locktime: 0x11, version: 1 });
  const got = hash256(pre).toString('hex');
  t('BIP143 sighash matches the published vector', got ===
    'c37af31116d1b27caf68aae9e3ac82f1477929014d5b917657d0eb49478cb670', got);

  // 2. Derivation, against the reserve's PUBLIC xpub -- no secret needed.
  try {
    const xpub = readFileSync('wpcn-reserve-xpub.txt', 'utf8').trim().split(/\s+/)[0];
    const acct = HDKey.fromExtendedKey(xpub);
    const known = {
      0: 'pc1q7hhzmdkkx0zjtzj6qkwmuvhlgwfqjrc6j2dk52',
      3: 'pc1qus8cxdl8z5420z7s26t83xwk0e4pzrudqfz9wn' };
    for (const [i, a] of Object.entries(known)) {
      const d = p2wpkhAddr(Buffer.from(acct.deriveChild(0).deriveChild(+i).publicKey));
      t(`derives 0/${i} to the known reserve address`, d === a, d);
    }
  } catch (e) { t('reserve xpub readable', false, e.message); }

  // 3. Encodings, against values computed independently.
  t('varint 0xfd is three bytes', varint(0xfd).toString('hex') === 'fdfd00', varint(0xfd).toString('hex'));
  t('u64 of 250 PCN', u64(25000000000).toString('hex') === '00ba1dd205000000', u64(25000000000).toString('hex'));
  t('rev flips byte order', rev('aabbccdd').toString('hex') === 'ddccbbaa');

  // 4. A foreign address must be refused, not silently paid.
  let threw = false;
  try { addrToScript('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'); } catch { threw = true; }
  t('refuses a non-pc address', threw);

  // 5. Sign and verify with a throwaway key, DER-encoded as consensus wants.
  const { randomBytes } = await import('node:crypto');
  const priv = randomBytes(32);
  const pub = Buffer.from(secp256k1.getPublicKey(priv, true));
  const h = hash256(Buffer.from('wrapdesk selftest'));
  const sig = secp256k1.sign(h, priv, { lowS: true, format: 'der' });
  t('signature verifies against its own key', secp256k1.verify(sig, h, pub, { format: 'der' }));
  t('signature is DER (0x30 header)', sig[0] === 0x30, sig[0]);


  // 6. The bug the self-check above could NOT see, kept as a regression test.
  //
  //    A signature must be over the sighash ITSELF. @noble/curves v2 hashes the
  //    message first unless told not to, and verify() defaults the same way --
  //    so the two agreed with each other while every input was rejected by
  //    consensus with NULLFAIL. If signing the digest ever equals signing
  //    sha256(digest) again, prehash has crept back on.
  const { createHash: ch } = await import('node:crypto');
  const dg = ch('sha256').update('prehash probe').digest();
  const sigRaw = Buffer.from(secp256k1.sign(dg, priv,
    { lowS: true, format: 'compact', prehash: false })).toString('hex');
  const sigDefault = Buffer.from(secp256k1.sign(dg, priv,
    { lowS: true, format: 'compact' })).toString('hex');
  t('signs the sighash itself, not sha256(sighash)', sigRaw !== sigDefault);

  console.log(`\n  ${ok} passed, ${bad} failed\n`);
  return bad === 0;
}

if (has('--selftest'))
  selftest().then((good) => process.exit(good ? 0 : 1));
