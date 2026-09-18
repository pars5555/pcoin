// QR encoder — byte mode, error correction level M, versions 1..10.
//
// WHY THIS EXISTS RATHER THAN A DEPENDENCY. Two-factor is now required before
// anyone can withdraw, so the enrolment QR is on the path between a user and
// their own money. A wrong QR does not fail loudly: the app scans it, stores a
// different secret, and the person is locked out of their balance with no way
// back except an operator. That risk is worth 200 lines we can test, and this
// repo has no runtime dependencies by rule (README rule 2).
//
// THE SECRET NEVER LEAVES THE PAGE ANY MORE THAN IT ALREADY DID. This renders
// the same otpauth:// URI the enrolment response already contains, into an SVG
// the browser draws. No image service, no third-party script, no extra request.
//
// Scope is deliberately small: byte mode only (an otpauth URI is ASCII), EC
// level M (what every authenticator expects), versions 1..7 (a URI runs ~100
// bytes; version 7 holds 124). Anything longer throws rather than silently
// truncating -- a truncated QR is a wrong QR.
//
// Verified against the `qrcode` Python reference implementation: every module
// of the matrix must match, for several inputs including a real otpauth URI.
// See test/qr.test.mjs.

// ── Galois field GF(256) for Reed-Solomon ─────────────────────────────────
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;              // the QR generator polynomial
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];

const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= mul(poly[j], EXP[i]);
      next[j + 1] ^= poly[j];
    }
    poly = next;
  }
  // Built constant-first; rsRemainder divides leading-coefficient-first, so
  // hand it back the other way round. Getting this wrong produces a QR whose
  // DATA is perfect and whose error correction is noise -- the first 128 bits
  // matched the reference exactly and everything after them was wrong, which
  // is how it was found.
  return poly.reverse();
}

function rsRemainder(data, degree) {
  const gen = rsGenerator(degree);
  const rem = new Array(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem[0];
    rem.shift();
    rem.push(0);
    for (let i = 0; i < degree; i++) rem[i] ^= mul(gen[i + 1], factor);
  }
  return rem;
}

// ── per-version tables for EC level M ─────────────────────────────────────
// [total codewords, EC codewords per block, group1 blocks, group2 blocks]
// Group 2 blocks hold one more data codeword than group 1.
const VERSIONS = {
  1:  { total: 26,  ecPerBlock: 10, g1: 1, g2: 0 },
  2:  { total: 44,  ecPerBlock: 16, g1: 1, g2: 0 },
  3:  { total: 70,  ecPerBlock: 26, g1: 1, g2: 0 },
  4:  { total: 100, ecPerBlock: 18, g1: 2, g2: 0 },
  5:  { total: 134, ecPerBlock: 24, g1: 2, g2: 0 },
  6:  { total: 172, ecPerBlock: 16, g1: 4, g2: 0 },
  7:  { total: 196, ecPerBlock: 18, g1: 4, g2: 0 },
  // STOPS AT 7 ON PURPOSE. Versions 8 and up split the data into two groups of
  // DIFFERENT block lengths, and that interleaving is a second code path I could
  // not get to reproduce a reference byte-for-byte. Version 7 already holds 124
  // bytes at EC level M, and the longest otpauth URI this exchange can produce
  // -- issuer, a long email, and the secret -- is comfortably under 120. So the
  // untested path is removed rather than shipped: a QR that is wrong is worse
  // than one that refuses to exist, because only one of them is noticed.
};

const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38],
};

const size = (v) => 17 + 4 * v;
const dataCodewords = (v) => {
  const t = VERSIONS[v];
  return t.total - t.ecPerBlock * (t.g1 + t.g2);
};

// ── bit stream ────────────────────────────────────────────────────────────
class Bits {
  constructor() { this.bits = []; }
  push(value, length) {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >> i) & 1);
  }
  get length() { return this.bits.length; }
}

function encodeData(text, version) {
  const bytes = new TextEncoder().encode(text);
  const capacity = dataCodewords(version) * 8;
  const countBits = version < 10 ? 8 : 16;
  const b = new Bits();
  b.push(0b0100, 4);                       // byte mode
  b.push(bytes.length, countBits);
  for (const byte of bytes) b.push(byte, 8);
  if (b.length > capacity) return null;     // needs a bigger version
  b.push(0, Math.min(4, capacity - b.length));            // terminator
  while (b.length % 8 !== 0) b.bits.push(0);              // pad to a byte
  const out = [];
  for (let i = 0; i < b.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | b.bits[i + j];
    out.push(byte);
  }
  const PAD = [0xec, 0x11];
  for (let i = 0; out.length < dataCodewords(version); i++) out.push(PAD[i % 2]);
  return out;
}

// Interleave the data and EC blocks exactly as the spec orders them. Getting
// this wrong produces a QR that scans on a forgiving reader and fails on a
// strict one -- which is the worst outcome, because it looks like it works.
function interleave(data, version) {
  const t = VERSIONS[version];
  const blocks = t.g1 + t.g2;
  const shortLen = Math.floor(dataCodewords(version) / blocks);
  const chunks = [];
  let at = 0;
  for (let i = 0; i < blocks; i++) {
    const len = i < t.g1 ? shortLen : shortLen + 1;
    chunks.push(data.slice(at, at + len));
    at += len;
  }
  const ec = chunks.map((c) => rsRemainder(c, t.ecPerBlock));
  const out = [];
  const maxData = Math.max(...chunks.map((c) => c.length));
  for (let i = 0; i < maxData; i++) for (const c of chunks) if (i < c.length) out.push(c[i]);
  for (let i = 0; i < t.ecPerBlock; i++) for (const e of ec) out.push(e[i]);
  return out;
}

// ── matrix ────────────────────────────────────────────────────────────────
function buildMatrix(version, codewords, mask) {
  const n = size(version);
  const m = Array.from({ length: n }, () => new Array(n).fill(null));
  const fixed = Array.from({ length: n }, () => new Array(n).fill(false));

  const setF = (r, c, v) => { if (r >= 0 && r < n && c >= 0 && c < n) { m[r][c] = v; fixed[r][c] = true; } };

  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const inner = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const on = inner && (r === 0 || r === 6 || c === 0 || c === 6
          || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        setF(r0 + r, c0 + c, on ? 1 : 0);
      }
    }
  };
  finder(0, 0); finder(0, n - 7); finder(n - 7, 0);

  for (let i = 8; i < n - 8; i++) {                       // timing patterns
    setF(6, i, i % 2 === 0 ? 1 : 0);
    setF(i, 6, i % 2 === 0 ? 1 : 0);
  }

  const centres = ALIGN[version];
  for (const r of centres) {
    for (const c of centres) {
      if ((r === 6 && c === 6) || (r === 6 && c === n - 7) || (r === n - 7 && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const on = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          setF(r + dr, c + dc, on ? 1 : 0);
        }
      }
    }
  }

  setF(n - 8, 8, 1);                                      // the dark module

  // Format information: EC level M = 0b00, with its own BCH code and mask.
  const fmt = (0b00 << 3) | mask;
  let bch = fmt << 10;
  for (let i = 4; i >= 0; i--) if (bch & (1 << (i + 10))) bch ^= 0b10100110111 << i;
  const format = ((fmt << 10) | bch) ^ 0b101010000010010;
  for (let i = 0; i < 15; i++) {
    const bit = (format >> i) & 1;
    if (i < 6) setF(i, 8, bit);
    else if (i < 8) setF(i + 1, 8, bit);
    else setF(n - 15 + i, 8, bit);
    // The horizontal copy runs along row 8 and must SKIP column 6, which is the
    // vertical timing line. Writing 14-i for every i>=8 put a format bit into
    // the timing pattern and left column 7 unclaimed -- so the data placement
    // then used (8,7) and every subsequent bit landed one position out. The
    // data and the error correction were both provably correct; the matrix was
    // not, which is why it only showed up module-by-module against a reference.
    if (i < 8) setF(8, n - 1 - i, bit);
    else setF(8, i === 8 ? 7 : 14 - i, bit);
  }

  // Version information, 18 bits, only from version 7.
  if (version >= 7) {
    let v = version << 12;
    for (let i = 5; i >= 0; i--) if (v & (1 << (i + 12))) v ^= 0b1111100100101 << i;
    const vinfo = (version << 12) | v;
    for (let i = 0; i < 18; i++) {
      const bit = (vinfo >> i) & 1;
      setF(Math.floor(i / 3), n - 11 + (i % 3), bit);
      setF(n - 11 + (i % 3), Math.floor(i / 3), bit);
    }
  }

  // Zigzag placement, skipping column 6 (the vertical timing line).
  let bitIndex = 0;
  const totalBits = codewords.length * 8;
  let upward = true;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < n; step++) {
      const row = upward ? n - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (fixed[row][col]) continue;
        let bit = 0;
        if (bitIndex < totalBits) {
          bit = (codewords[bitIndex >> 3] >> (7 - (bitIndex & 7))) & 1;
          bitIndex++;
        }
        const maskOn = [
          (r, c) => (r + c) % 2 === 0,
          (r) => r % 2 === 0,
          (r, c) => c % 3 === 0,
          (r, c) => (r + c) % 3 === 0,
          (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
          (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
          (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
          (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
        ][mask](row, col);
        m[row][col] = maskOn ? bit ^ 1 : bit;
      }
    }
    upward = !upward;
  }
  return m;
}

// The spec's four penalty rules. The mask with the lowest score is chosen;
// picking a fixed mask is legal but scans worse on cheap cameras.
function penalty(m) {
  const n = m.length;
  let score = 0;
  const run = (get) => {
    for (let a = 0; a < n; a++) {
      let last = -1, len = 0;
      for (let b = 0; b < n; b++) {
        const v = get(a, b);
        if (v === last) { len++; if (len === 5) score += 3; else if (len > 5) score += 1; }
        else { last = v; len = 1; }
      }
    }
  };
  run((r, c) => m[r][c]);
  run((c, r) => m[r][c]);
  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
    }
  }
  const PAT = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const RPAT = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const scan = (get) => {
    for (let a = 0; a < n; a++) {
      for (let b = 0; b + 11 <= n; b++) {
        let f = true, g = true;
        for (let k = 0; k < 11; k++) {
          const v = get(a, b + k);
          if (v !== PAT[k]) f = false;
          if (v !== RPAT[k]) g = false;
        }
        if (f) score += 40;
        if (g) score += 40;
      }
    }
  };
  scan((r, c) => m[r][c]);
  scan((c, r) => m[r][c]);
  let dark = 0;
  for (const row of m) for (const v of row) dark += v;
  const pct = (dark * 100) / (n * n);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}

/** The QR matrix for `text` as an array of rows of 0/1. Throws if too long. */
export function qrMatrix(text) {
  for (let version = 1; version <= 7; version++) {
    const data = encodeData(text, version);
    if (!data) continue;
    const codewords = interleave(data, version);
    let best = null;
    for (let mask = 0; mask < 8; mask++) {
      const m = buildMatrix(version, codewords, mask);
      const p = penalty(m);
      if (!best || p < best.p) best = { m, p };
    }
    return best.m;
  }
  throw new Error('too long to encode: over 124 bytes at version 7, EC level M');
}

/** An SVG string, sized in CSS pixels, with a quiet zone. */
export function qrSvg(text, { scale = 6, quiet = 4, dark = '#0b0d13', light = '#ffffff' } = {}) {
  const m = qrMatrix(text);
  const n = m.length;
  const dim = (n + quiet * 2) * scale;
  let path = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (m[r][c]) path += `M${(c + quiet) * scale} ${(r + quiet) * scale}h${scale}v${scale}h-${scale}z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" `
    + `viewBox="0 0 ${dim} ${dim}" role="img" aria-label="Two-factor setup QR code">`
    + `<rect width="${dim}" height="${dim}" fill="${light}"/>`
    + `<path d="${path}" fill="${dark}"/></svg>`;
}
