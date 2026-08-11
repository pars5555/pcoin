#!/usr/bin/env node
// Verifies qr.mjs against the reference `qrcode` package, module for module.
//
//   npm i qrcode          (dev only -- it is NOT a dependency of the service)
//   node qr-test.mjs
//
// Byte mode is forced on the reference. Left to itself it splits the input into
// numeric/alphanumeric/byte segments, which is a smaller and equally valid
// encoding but a different matrix -- comparing against that would report
// failures that are not failures. qr.mjs is byte-mode only, which is always
// correct and never optimal, and for a URI that is the right trade.
//
// This test caught two real bugs that a "does it look like a QR code" check
// never would:
//   * the Reed-Solomon generator polynomial built in ascending order while the
//     division routine indexed it as descending -- valid-looking error
//     correction bytes that were simply the wrong ones
//   * format information written transposed, (row, col) against (col, row)
// Both produce a QR that looks entirely normal and decodes to nothing.

import { encode } from './qr.mjs';

let QR;
try { QR = (await import('qrcode')).default; }
catch {
  console.error('needs the reference package: npm i qrcode');
  process.exit(2);
}

const CASES = [
  'hello world',
  'https://market.pc.am/admin',
  'otpauth://totp/market.pc.am:pcoin%40pc.am?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=market.pc.am&period=30&digits=6',
  'a'.repeat(60), 'a'.repeat(110), 'x'.repeat(122),
  'pc1qlvw6kx8wkcz8f6p0d6kswv69fjt33ll079f64e',
  '1', 'PCoin', 'The quick brown fox jumps over the lazy dog 0123456789',
  'ABCDEFGHIJ1234567890', 'otpauth://totp/x:y?secret=AAAA&issuer=z',
];

let pass = 0, fail = 0;
for (const t of CASES) {
  const ref = QR.create([{ data: t, mode: 'byte' }], { errorCorrectionLevel: 'M' });
  const n = ref.modules.size;
  const got = encode(t);
  let ok = got.length === n, diff = 0;
  if (ok) {
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      if ((ref.modules.data[r * n + c] ? 1 : 0) !== got[r][c]) { ok = false; diff++; }
    }
  }
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  v${(n - 17) / 4} ${n}x${n}  ${String(t.length).padStart(3)} chars` +
              (ok ? '' : `  (${diff || 'wrong version'})`));
  ok ? pass++ : fail++;
}

// Over-long input must be refused, not silently truncated.
try { encode('z'.repeat(400)); console.log('  FAIL  over-long input was accepted'); fail++; }
catch { console.log('  ok    over-long input is refused'); pass++; }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
