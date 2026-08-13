// Block assembly for the PCoin pool.
//
// Turns a getblocktemplate into (a) the 80-byte header a miner grinds and
// (b) the full serialized block to submit when someone solves it.
//
// This is the part that is easy to get subtly wrong and hard to notice: a
// header that is one byte off still hashes, still looks like work, and is
// rejected by the network with a terse error long after the miner was told
// "share accepted". So the test for this file is not a unit test -- it is
// getting a regtest node to ACCEPT a block we assembled here. Nothing less
// proves the serialization.
//
// Byte-order rules that cause most of the bugs:
//   * hashes arrive from RPC in DISPLAY order (big-endian) and go into the
//     header in INTERNAL order (little-endian). Reverse them exactly once.
//   * everything else in the header is little-endian.

import { createHash } from 'node:crypto';

const sha256 = (b) => createHash('sha256').update(b).digest();
export const sha256d = (b) => sha256(sha256(b));

/** RPC hex (display order) -> internal little-endian bytes. */
export const hexToLE = (hex) => Buffer.from(hex, 'hex').reverse();

export function varint(n) {
  if (n < 0xfd) return Buffer.from([n]);
  if (n <= 0xffff) { const b = Buffer.alloc(3); b[0] = 0xfd; b.writeUInt16LE(n, 1); return b; }
  if (n <= 0xffffffff) { const b = Buffer.alloc(5); b[0] = 0xfe; b.writeUInt32LE(n, 1); return b; }
  const b = Buffer.alloc(9); b[0] = 0xff; b.writeBigUInt64LE(BigInt(n), 1); return b;
}

/**
 * Encode an integer exactly as Bitcoin's `CScript() << n` does, INCLUDING the
 * push opcode. BIP34 is checked by rebuilding that script and comparing bytes,
 * so "a minimal push of the number" is not enough -- it has to be the same
 * encoding CScript would have produced.
 *
 * The trap: for 1..16 CScript emits a single OP_N opcode (0x51..0x60), NOT a
 * length-prefixed push. Encoding height 2 as [0x01][0x02] instead of [0x52]
 * gives bad-cb-height. Mainnet is long past height 16 so this would never have
 * shown up in production -- regtest at height 2 is the only place it surfaces,
 * which is exactly why block assembly is tested there.
 */
function pushInt(n) {
  if (n === 0) return Buffer.from([0x00]);                 // OP_0
  if (n >= 1 && n <= 16) return Buffer.from([0x50 + n]);   // OP_1 .. OP_16
  const out = [];
  let v = n;
  while (v > 0) { out.push(v & 0xff); v >>= 8; }
  // A high bit in the top byte would read as negative; pad it.
  if (out[out.length - 1] & 0x80) out.push(0x00);
  return Buffer.concat([Buffer.from([out.length]), Buffer.from(out)]);
}

/**
 * bech32 pc1... -> the P2WPKH scriptPubKey (OP_0 <20-byte program>).
 * Only v0/20-byte is accepted on purpose: that is what the pool pays itself to,
 * and silently accepting a taproot or a decode error would send a block reward
 * to a script nobody can spend.
 */
export function addressToScript(addr, expectHrp = 'pc') {
  const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const lower = addr.toLowerCase();
  const pos = lower.lastIndexOf('1');
  if (pos < 1) throw new Error(`not a bech32 address: ${addr}`);
  const hrp = lower.slice(0, pos);
  // The hrp is per network -- pc mainnet, pcrt regtest, tpc testnet. It is
  // checked rather than ignored because the failure it prevents is permanent:
  // a Bitcoin bc1 address here would send the block reward to a script nobody
  // involved can spend, and nothing downstream would notice.
  if (hrp !== expectHrp) {
    throw new Error(`wrong hrp '${hrp}' -- expected '${expectHrp}'. A mainnet pool must never pay a `
      + `regtest or Bitcoin address; the reward would be unspendable.`);
  }
  const data = [];
  for (const ch of lower.slice(pos + 1)) {
    const v = CHARSET.indexOf(ch);
    if (v < 0) throw new Error(`bad bech32 character '${ch}'`);
    data.push(v);
  }
  if (data.length < 7) throw new Error('bech32 payload too short');
  const payload = data.slice(0, -6);          // drop the checksum
  const version = payload[0];
  if (version !== 0) throw new Error(`witness v${version} not supported; pool pays P2WPKH only`);

  // 5-bit groups -> 8-bit bytes
  let acc = 0, bits = 0;
  const prog = [];
  for (const v of payload.slice(1)) {
    acc = (acc << 5) | v; bits += 5;
    while (bits >= 8) { bits -= 8; prog.push((acc >> bits) & 0xff); }
  }
  if (prog.length !== 20) throw new Error(`witness program is ${prog.length} bytes, expected 20`);
  return Buffer.concat([Buffer.from([0x00, 0x14]), Buffer.from(prog)]);
}

/**
 * Build the coinbase transaction.
 *
 * extranonce is what makes two miners search different spaces: it changes the
 * coinbase, which changes its txid, which changes the merkle root, which
 * changes the header. Without it every miner would grind identical work.
 */
export function buildCoinbase({ height, value, script, extranonce, witnessCommitment }) {
  const en = Buffer.from(extranonce, 'hex');
  const scriptSig = Buffer.concat([
    pushInt(height),                                // BIP34: height first, always
    Buffer.from([en.length]), en,
  ]);
  if (scriptSig.length > 100) throw new Error('coinbase scriptSig over the 100-byte consensus limit');

  const outputs = [];
  const val = Buffer.alloc(8); val.writeBigUInt64LE(BigInt(value));
  outputs.push(Buffer.concat([val, varint(script.length), script]));

  // Every PCoin block's coinbase carries the zero-value OP_RETURN witness
  // commitment. getblocktemplate hands us the exact scriptPubKey; use it
  // verbatim rather than recomputing it.
  if (witnessCommitment) {
    const wc = Buffer.from(witnessCommitment, 'hex');
    const zero = Buffer.alloc(8);
    outputs.push(Buffer.concat([zero, varint(wc.length), wc]));
  }

  const version = Buffer.alloc(4); version.writeInt32LE(2);
  const prevout = Buffer.concat([Buffer.alloc(32), Buffer.from([0xff, 0xff, 0xff, 0xff])]);
  const sequence = Buffer.from([0xff, 0xff, 0xff, 0xff]);
  const locktime = Buffer.alloc(4);

  // Two serializations of the same transaction:
  //   legacy  -> hashed for the txid, which feeds the merkle root
  //   witness -> what goes in the block
  const legacy = Buffer.concat([
    version, varint(1), prevout, varint(scriptSig.length), scriptSig, sequence,
    varint(outputs.length), ...outputs, locktime,
  ]);
  const witness = Buffer.concat([
    version, Buffer.from([0x00, 0x01]),             // segwit marker + flag
    varint(1), prevout, varint(scriptSig.length), scriptSig, sequence,
    varint(outputs.length), ...outputs,
    varint(1), varint(32), Buffer.alloc(32),        // one witness item: the reserved value
    locktime,
  ]);
  return { legacy, witness, txid: sha256d(legacy) };
}

/** Merkle root over txids already in internal byte order. */
export function merkleRoot(txids) {
  if (txids.length === 0) throw new Error('a block always has at least a coinbase');
  let layer = txids.slice();
  while (layer.length > 1) {
    if (layer.length % 2) layer.push(layer[layer.length - 1]);  // duplicate the odd tail
    const next = [];
    for (let i = 0; i < layer.length; i += 2) next.push(sha256d(Buffer.concat([layer[i], layer[i + 1]])));
    layer = next;
  }
  return layer[0];
}

/** The 80 bytes RandomX hashes. nonce is written by the miner. */
export function buildHeader({ version, prevhash, merkle, time, bits, nonce = 0 }) {
  const h = Buffer.alloc(80);
  h.writeInt32LE(version, 0);
  hexToLE(prevhash).copy(h, 4);
  merkle.copy(h, 36);
  h.writeUInt32LE(time, 68);
  h.writeUInt32LE(parseInt(bits, 16), 72);
  h.writeUInt32LE(nonce >>> 0, 76);
  return h;
}

/** Header + txcount + transactions, ready for submitblock. */
export function serializeBlock(header, coinbaseWitness, otherTxHex = []) {
  return Buffer.concat([
    header,
    varint(1 + otherTxHex.length),
    coinbaseWitness,
    ...otherTxHex.map((h) => Buffer.from(h, 'hex')),
  ]).toString('hex');
}

/** nBits -> 32-byte big-endian target, matching the C++ validator exactly. */
export function bitsToTarget(bitsHex) {
  const bits = parseInt(bitsHex, 16);
  const exponent = bits >>> 24;
  const mantissa = bits & 0x007fffff;
  const t = Buffer.alloc(32);
  if (exponent <= 3) {
    const m = mantissa >>> (8 * (3 - exponent));
    t[31] = m & 0xff;
    if (exponent >= 2) t[30] = (m >>> 8) & 0xff;
    if (exponent >= 3) t[29] = (m >>> 16) & 0xff;
  } else {
    const i = 32 - exponent;
    if (i >= 0 && i + 2 < 32) {
      t[i] = (mantissa >>> 16) & 0xff;
      t[i + 1] = (mantissa >>> 8) & 0xff;
      t[i + 2] = mantissa & 0xff;
    }
  }
  return t;
}

/** Scale a target by 1/factor to get an easier share target. */
export function scaleTarget(targetBE, factor) {
  let v = BigInt('0x' + targetBE.toString('hex')) / BigInt(factor);
  const max = (1n << 256n) - 1n;
  if (v > max) v = max;
  return Buffer.from(v.toString(16).padStart(64, '0'), 'hex');
}
