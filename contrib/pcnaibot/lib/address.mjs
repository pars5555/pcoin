// Local bech32 validation for PCoin addresses.
//
// This must happen BEFORE any explorer query and BEFORE any display, because
// the explorer answers HTTP 200 with a healthy zero balance for `notanaddress`
// and for a Bitcoin `bc1...`. A remote 200 is not validation; it is an empty
// answer about a string nobody owns.
//
// The other half of the rule: LOWERCASE EVERYTHING before you store or compare.
// Bech32 is valid all-lower or all-upper and those are two different strings to
// a database. Query the uppercase form and the explorer returns 200 with zero
// transactions -- not an error, an empty answer -- and the coins are simply
// invisible.

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

const BECH32_CONST = 1;
const BECH32M_CONST = 0x2bc830a3;

function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}

function hrpExpand(hrp) {
  const out = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

// Returns { hrp, data } or null. Enforces the BIP173 casing rule: an address
// may be all-lower or all-upper, never mixed.
export function bech32Decode(addr) {
  if (typeof addr !== 'string') return null;
  if (addr.length < 8 || addr.length > 90) return null;

  const hasLower = /[a-z]/.test(addr);
  const hasUpper = /[A-Z]/.test(addr);
  if (hasLower && hasUpper) return null; // mixed case is invalid, always

  const s = addr.toLowerCase();
  const pos = s.lastIndexOf('1');
  if (pos < 1 || pos + 7 > s.length) return null;

  const hrp = s.slice(0, pos);
  for (let i = 0; i < hrp.length; i++) {
    const c = hrp.charCodeAt(i);
    if (c < 33 || c > 126) return null;
  }

  const data = [];
  for (let i = pos + 1; i < s.length; i++) {
    const d = CHARSET.indexOf(s[i]);
    if (d === -1) return null;
    data.push(d);
  }

  const chk = polymod([...hrpExpand(hrp), ...data]);
  let encoding = null;
  if (chk === BECH32_CONST) encoding = 'bech32';
  else if (chk === BECH32M_CONST) encoding = 'bech32m';
  else return null;

  return { hrp, data: data.slice(0, data.length - 6), encoding };
}

function convertBits(data, from, to, pad) {
  let acc = 0;
  let bits = 0;
  const out = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    if (value < 0 || value >> from !== 0) return null;
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv)) {
    return null;
  }
  return out;
}

// Full segwit validation for a given human-readable part. `pc` on mainnet.
//
// The witness-version/encoding pairing matters: v0 must be bech32 and v1+ must
// be bech32m. Accepting either for both is the classic permissive bug, and it
// would let a malformed address through to a user as "your deposit address".
export function validatePcoinAddress(addr, { hrp = 'pc' } = {}) {
  const dec = bech32Decode(addr);
  if (!dec) return { valid: false, reason: 'bad bech32 checksum, charset or casing' };
  if (dec.hrp !== hrp) return { valid: false, reason: `wrong network prefix "${dec.hrp}" (expected "${hrp}")` };
  if (dec.data.length < 1) return { valid: false, reason: 'no witness version' };

  const version = dec.data[0];
  if (version > 16) return { valid: false, reason: 'witness version out of range' };

  const program = convertBits(dec.data.slice(1), 5, 8, false);
  if (program === null) return { valid: false, reason: 'bad witness program padding' };
  if (program.length < 2 || program.length > 40) return { valid: false, reason: 'witness program length out of range' };

  if (version === 0) {
    if (program.length !== 20 && program.length !== 32) {
      return { valid: false, reason: 'v0 witness program must be 20 or 32 bytes' };
    }
    if (dec.encoding !== 'bech32') return { valid: false, reason: 'v0 must use bech32, not bech32m' };
  } else if (dec.encoding !== 'bech32m') {
    return { valid: false, reason: 'v1+ must use bech32m, not bech32' };
  }

  return {
    valid: true,
    version,
    programLength: program.length,
    normalized: addr.toLowerCase(),
    // A deposit address we ISSUE is always v0 P2WPKH (m/84'). A taproot pc1p is
    // a valid PCoin address but is not one of ours, and is not something this
    // rail should ever hand out.
    isP2wpkh: version === 0 && program.length === 20,
  };
}

// Normalise for storage/compare. Throws rather than returning a bad string --
// a silently-wrong address is money sent to a stranger.
export function normalizeAddress(addr, opts) {
  const v = validatePcoinAddress(addr, opts);
  if (!v.valid) throw new Error(`invalid PCoin address: ${v.reason}`);
  return v.normalized;
}
