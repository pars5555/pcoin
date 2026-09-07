// TOTP (RFC 6238) for the ops dashboard.
//
// Mirrors the implementation in contrib/market/admin.mjs so both panels accept
// the same codes from the same authenticator app. Kept as its own file because
// server.mjs is deployed as a directory and cannot import across contrib/.
//
// Enrolment is deliberately manual: `node server.mjs --gen-totp` prints a fresh
// secret and the otpauth URI; the operator pastes the secret into config.json
// as "totpSecret" and adds it to their authenticator. Until that key exists the
// panel is password-only and says so loudly at startup -- a deploy must never
// lock the operator out before they have had a chance to enrol.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(s) {
  let bits = 0, value = 0; const out = [];
  for (const c of String(s).replace(/=+$/, '').toUpperCase()) {
    const i = B32.indexOf(c);
    if (i < 0) continue;
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

function totpAt(secretB32, counter) {
  const key = base32Decode(secretB32);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const h = createHmac('sha1', key).update(buf).digest();
  const off = h[h.length - 1] & 0x0f;
  const code = ((h[off] & 0x7f) << 24 | h[off + 1] << 16 | h[off + 2] << 8 | h[off + 3]) % 1e6;
  return String(code).padStart(6, '0');
}

/** Accepts the step before and after, so a phone whose clock is a few seconds
 *  out still works. Wider than that and a stolen code stays useful too long. */
export function totpValid(secretB32, code, at = Date.now()) {
  const c = String(code || '').replace(/\D/g, '');
  if (c.length !== 6) return false;
  const step = Math.floor(at / 1000 / 30);
  for (const d of [-1, 0, 1]) {
    const want = Buffer.from(totpAt(secretB32, step + d));
    const got = Buffer.from(c);
    if (want.length === got.length && timingSafeEqual(want, got)) return true;
  }
  return false;
}

/** A fresh 160-bit secret (RFC 4226's recommended minimum) and the URI an
 *  authenticator app scans or has typed into it. */
export function newSecret(label = 'PCoin ops', issuer = 'PCoin') {
  const secret = base32Encode(randomBytes(20));
  const uri = `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}` +
              `?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
  return { secret, uri };
}
