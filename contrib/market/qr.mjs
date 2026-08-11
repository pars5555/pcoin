// A QR encoder, in one file with no dependencies.
//
// WHY NOT `npm i qrcode`
// This module is imported by the same process that holds the hot wallet's
// spending keys. A drawing routine is not worth widening that process's supply
// chain for, and the failure mode of getting this wrong is benign and instantly
// visible: the code does not scan, and the secret is printed as text beside it
// anyway.
//
// Byte mode, error correction level M, versions 1-10 (up to 122 characters),
// which covers any `otpauth://` URI. Verified module-for-module against the
// reference `qrcode` package for a spread of inputs — see qr-test.mjs.

// ── GF(256), the field Reed-Solomon lives in ───────────────────────────────
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x; LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;      // the primitive polynomial QR specifies
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const mul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

/** Generator polynomial for `degree` error-correction codewords: the product of
 *  (x - a^i) for i in 0..degree-1, in DESCENDING order so poly[0] is the leading
 *  coefficient. The order matters and is invisible if you get it wrong: the
 *  synthetic division below indexes gen[i+1], so an ascending polynomial
 *  produces perfectly well-formed error-correction bytes that are simply the
 *  wrong ones, and the resulting QR looks entirely normal and scans as nothing. */
function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];                      // multiply by x
      next[j + 1] ^= mul(poly[j], EXP[i]);     // multiply by a^i
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data, ecLen) {
  const gen = rsGenerator(ecLen);
  const res = new Array(ecLen).fill(0);
  for (const byte of data) {
    const factor = byte ^ res[0];
    res.shift(); res.push(0);
    for (let i = 0; i < ecLen; i++) res[i] ^= mul(gen[i + 1], factor);
  }
  return res;
}

// ── per-version parameters, error correction level M ───────────────────────
// [ total data codewords, EC codewords per block, block count ]
// Blocks split into two groups when the data does not divide evenly; the spec
// puts the larger blocks last.
const VERSIONS = {
  1:  [16,  10, 1], 2:  [28,  16, 1], 3:  [44,  26, 1], 4:  [64,  18, 2],
  5:  [86,  24, 2], 6:  [108, 16, 4], 7:  [124, 18, 4], 8:  [154, 22, 4],
  9:  [182, 22, 5], 10: [216, 26, 5],
};
const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

function pickVersion(byteLen) {
  for (let v = 1; v <= 10; v++) {
    const [dataCw] = VERSIONS[v];
    const countBits = v <= 9 ? 8 : 16;
    const needBits = 4 + countBits + byteLen * 8;
    if (needBits <= dataCw * 8) return v;
  }
  throw new Error(`${byteLen} bytes is more than this encoder handles (max 122)`);
}

// ── bit stream → codewords ─────────────────────────────────────────────────
function buildCodewords(bytes, version) {
  const [dataCw] = VERSIONS[version];
  const countBits = version <= 9 ? 8 : 16;
  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };

  push(0b0100, 4);                 // byte mode
  push(bytes.length, countBits);
  for (const b of bytes) push(b, 8);

  const capacity = dataCw * 8;
  push(0, Math.min(4, capacity - bits.length));      // terminator
  while (bits.length % 8) bits.push(0);              // to a byte boundary

  const cw = [];
  for (let i = 0; i < bits.length; i += 8) {
    cw.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  }
  // The two alternating pad bytes the spec names.
  for (let i = 0; cw.length < dataCw; i++) cw.push(i % 2 === 0 ? 0xec : 0x11);
  return cw;
}

/** Split into blocks, error-correct each, then interleave. */
function interleave(dataCw, version) {
  const [totalData, ecPerBlock, blocks] = VERSIONS[version];
  const shortLen = Math.floor(totalData / blocks);
  const longCount = totalData % blocks;               // these get one extra byte

  const dataBlocks = [], ecBlocks = [];
  let at = 0;
  for (let b = 0; b < blocks; b++) {
    const len = shortLen + (b >= blocks - longCount ? 1 : 0);
    const block = dataCw.slice(at, at + len);
    at += len;
    dataBlocks.push(block);
    ecBlocks.push(rsEncode(block, ecPerBlock));
  }

  const out = [];
  const maxData = Math.max(...dataBlocks.map(b => b.length));
  for (let i = 0; i < maxData; i++)
    for (const b of dataBlocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < ecPerBlock; i++)
    for (const b of ecBlocks) out.push(b[i]);
  return out;
}

// ── the matrix ─────────────────────────────────────────────────────────────
function blankMatrix(size) {
  return { m: Array.from({ length: size }, () => new Array(size).fill(null)), size };
}

function placeFunction(mx, version) {
  const { m, size } = mx;
  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      const rr = r0 + r, cc = c0 + c;
      if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
      const on = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                 (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
                 (r >= 2 && r <= 4 && c >= 2 && c <= 4);
      m[rr][cc] = on ? 1 : 0;
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

  for (let i = 8; i < size - 8; i++) {                 // timing
    const on = i % 2 === 0 ? 1 : 0;
    m[6][i] = on; m[i][6] = on;
  }

  const centers = ALIGN[version];
  for (const r of centers) for (const c of centers) {
    // Skip the three that would sit on a finder.
    if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) continue;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
      m[r + dr][c + dc] = (Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0)) ? 1 : 0;
    }
  }

  m[size - 8][8] = 1;                                  // the always-dark module

  // Reserve the format areas (filled in after masking).
  for (let i = 0; i < 9; i++) {
    if (m[8][i] === null) m[8][i] = 0;
    if (m[i][8] === null) m[i][8] = 0;
  }
  for (let i = 0; i < 8; i++) {
    if (m[8][size - 1 - i] === null) m[8][size - 1 - i] = 0;
    if (m[size - 1 - i][8] === null) m[size - 1 - i][8] = 0;
  }
  if (version >= 7) {
    for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) {
      m[size - 11 + j][i] = 0;
      m[i][size - 11 + j] = 0;
    }
  }
}

function placeData(mx, codewords) {
  const { m, size } = mx;
  const bits = [];
  for (const cw of codewords) for (let i = 7; i >= 0; i--) bits.push((cw >> i) & 1);

  let idx = 0, upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right = 5;                        // the timing column is skipped
    for (let v = 0; v < size; v++) {
      const row = upward ? size - 1 - v : v;
      for (const col of [right, right - 1]) {
        if (m[row][col] !== null) continue;
        m[row][col] = idx < bits.length ? bits[idx] : 0;
        idx++;
      }
    }
    upward = !upward;
  }
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function penalty(m, size) {
  let score = 0;
  // Rule 1: runs of five or more of the same colour.
  for (let i = 0; i < size; i++) {
    for (const line of [m[i], m.map(row => row[i])]) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        if (line[j] === line[j - 1]) { run++; if (run === 5) score += 3; else if (run > 5) score++; }
        else run = 1;
      }
    }
  }
  // Rule 2: 2x2 blocks of one colour.
  for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) {
    const v = m[r][c];
    if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
  }
  // Rule 3: the finder-like 1:1:3:1:1 pattern.
  const p1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], p2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const match = (line, pat) => pat.every((v, k) => line[k] === v);
  for (let i = 0; i < size; i++) {
    const row = m[i], col = m.map(r => r[i]);
    for (let j = 0; j + 11 <= size; j++) {
      if (match(row.slice(j, j + 11), p1) || match(row.slice(j, j + 11), p2)) score += 40;
      if (match(col.slice(j, j + 11), p1) || match(col.slice(j, j + 11), p2)) score += 40;
    }
  }
  // Rule 4: deviation from an even split of dark and light.
  let dark = 0;
  for (const row of m) for (const v of row) if (v) dark++;
  const pct = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}

function bch(value, generator, bitLen) {
  let v = value << (bitLen - 1);
  const genBits = 32 - Math.clz32(generator);
  while (32 - Math.clz32(v) >= genBits) v ^= generator << (32 - Math.clz32(v) - genBits);
  return v;
}

function applyFormat(m, size, mask) {
  // ECC level M is 0b00 in the format indicator; the 5 data bits are
  // level<<3 | mask, then a BCH(15,5) remainder, then the fixed 0x5412 mask.
  const data = (0b00 << 3) | mask;
  const bits = ((data << 10) | bch(data, 0x537, 11)) ^ 0x5412;
  const get = i => (bits >> i) & 1;

  // Both copies are written as (row, col). Getting these the wrong way round is
  // the easy mistake -- the reference implementations are written in (x, y),
  // which reads as (col, row), and transposing them produces a QR that looks
  // perfectly plausible, decodes to nothing, and differs from a correct one by
  // only a few dozen modules.
  //
  // Copy 1, around the top-left finder: bits 0-5 run DOWN column 8.
  for (let i = 0; i <= 5; i++) m[i][8] = get(i);
  m[7][8] = get(6);
  m[8][8] = get(7);
  m[8][7] = get(8);
  for (let i = 9; i <= 14; i++) m[8][14 - i] = get(i);

  // Copy 2: bits 0-7 run LEFT along row 8 from the right edge, bits 8-14 run UP
  // column 8 from the bottom edge.
  for (let i = 0; i <= 7; i++) m[8][size - 1 - i] = get(i);
  for (let i = 8; i <= 14; i++) m[size - 15 + i][8] = get(i);

  m[size - 8][8] = 1;                    // the module that is always dark
}

function applyVersionInfo(m, size, version) {
  if (version < 7) return;
  const bits = (version << 12) | bch(version, 0x1f25, 13);
  for (let i = 0; i < 18; i++) {
    const bit = (bits >> i) & 1;
    m[Math.floor(i / 3)][size - 11 + (i % 3)] = bit;
    m[size - 11 + (i % 3)][Math.floor(i / 3)] = bit;
  }
}

/** text -> a 2D array of 0/1, ready to draw. */
export function encode(text, forceMask = null) {
  const bytes = [...new TextEncoder().encode(text)];
  const version = pickVersion(bytes.length);
  const size = 17 + 4 * version;
  const codewords = interleave(buildCodewords(bytes, version), version);

  // Which modules are function patterns has to be decided BEFORE masking:
  // the mask applies to data modules only.
  const probe = blankMatrix(size);
  placeFunction(probe, version);
  const isFunction = probe.m.map(row => row.map(v => v !== null));

  let best = null, bestScore = Infinity;
  for (const mask of forceMask === null ? [0, 1, 2, 3, 4, 5, 6, 7] : [forceMask]) {
    const mx = blankMatrix(size);
    placeFunction(mx, version);
    placeData(mx, codewords);
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
      if (!isFunction[r][c] && MASKS[mask](r, c)) mx.m[r][c] ^= 1;
    }
    applyFormat(mx.m, size, mask);
    applyVersionInfo(mx.m, size, version);
    const s = penalty(mx.m, size);
    if (s < bestScore) { bestScore = s; best = mx.m; }
  }
  return best;
}

/** Inline SVG. No external fetch, so it survives any content-security policy. */
export function toSvg(text, { scale = 6, margin = 4, dark = '#111', light = '#fff' } = {}) {
  const m = encode(text);
  const n = m.length;
  const dim = (n + margin * 2) * scale;
  let path = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (m[r][c]) path += `M${(c + margin) * scale} ${(r + margin) * scale}h${scale}v${scale}h-${scale}z`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" ` +
         `viewBox="0 0 ${dim} ${dim}" role="img" aria-label="QR code">` +
         `<rect width="${dim}" height="${dim}" fill="${light}"/>` +
         `<path d="${path}" fill="${dark}"/></svg>`;
}
