// Authentication for the unified PCoin admin.
//
// ONE operator account. No registration, no password reset, no "forgot password"
// email — every one of those is a way in, and there is exactly one person to let
// in. The credential is set from the command line by someone who is already root
// on this box (see setup.mjs), which is a strictly higher bar than any reset flow.
//
// THE SECRET URL IS NOT THE SECURITY. The panel sits on an unguessable path, and
// that is worth having — it keeps the login out of opportunistic scanner traffic,
// and unlike a secret SUBDOMAIN it never appears in Certificate Transparency logs.
// But a path leaks through Referer headers, browser history, proxy and CDN logs,
// and anything it is ever pasted into. What actually protects this panel is the
// password, the second factor, and the rate limiter below.
import { randomBytes, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const CRED = process.env.ADMIN_CRED || '/opt/pcoin-admin/credential.json';

// scrypt parameters. N=2^15 costs ~100ms per attempt here, which is irrelevant
// once a day for the operator and ruinous for anyone grinding the hash offline.
const N = 32768, r = 8, p = 1, KEYLEN = 64;
// OpenSSL needs a little MORE than the textbook 128*N*r, so maxmem must carry
// headroom: sized exactly, scryptSync throws "memory limit exceeded" and the
// panel cannot hash a password at all.
const MAXMEM = 128 * N * r * 2;

export function hashPassword(plain, salt = randomBytes(32)) {
  const key = scryptSync(Buffer.from(plain, 'utf8'), salt, KEYLEN, { N, r, p, maxmem: MAXMEM });
  return { salt: salt.toString('base64'), key: key.toString('base64') };
}

export function loadCredential() {
  if (!existsSync(CRED)) return null;
  try { return JSON.parse(readFileSync(CRED, 'utf8')); } catch { return null; }
}

export function saveCredential(obj) {
  // 0600: the process reads it, nothing else on the box should.
  writeFileSync(CRED, JSON.stringify(obj, null, 2), { mode: 0o600 });
}

/** Constant-time password check. Returns false for a missing credential rather
 *  than throwing — an unconfigured panel must refuse, not crash open. */
export function checkPassword(plain, cred) {
  if (!cred || !cred.salt || !cred.key) return false;
  const want = Buffer.from(cred.key, 'base64');
  const got = scryptSync(Buffer.from(plain, 'utf8'), Buffer.from(cred.salt, 'base64'),
                         want.length, { N, r, p, maxmem: MAXMEM });
  return timingSafeEqual(want, got);
}

// ── TOTP, RFC 6238 ─────────────────────────────────────────────────────────
// SHA-1 / 6 digits / 30-second step, because that is what every authenticator
// app implements. SHA-1 is not a weakness here: TOTP's security rests on the
// shared secret and the 30-second window, not on collision resistance.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function newTotpSecret() {
  const buf = randomBytes(20);                     // 160 bits, the RFC 4226 size
  let bits = '', out = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function b32decode(s) {
  let bits = '';
  for (const c of s.toUpperCase().replace(/=+$/, '')) {
    const v = B32.indexOf(c);
    if (v < 0) continue;
    bits += v.toString(2).padStart(5, '0');
  }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}

export function totpAt(secret, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', b32decode(secret)).update(buf).digest();
  const off = mac[mac.length - 1] & 0x0f;
  const code = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(code % 1_000_000).padStart(6, '0');
}

/** Accept the current step and one either side: phone clocks drift, and a user
 *  who types a code as it rolls over should not be told their password is wrong.
 *  Wider than ±1 would meaningfully enlarge the guessing window. */
export function checkTotp(code, secret, now = Date.now()) {
  // NOTE: a MISSING secret means "not enrolled", and the caller decides what that
  // means -- see totpRequired(). This function only answers "does this code match
  // this secret", and answers false when there is no secret to match against.
  if (!secret || !/^\d{6}$/.test(String(code || '').trim())) return false;
  const step = Math.floor(now / 30000);
  const given = Buffer.from(String(code).trim());
  for (const c of [step - 1, step, step + 1]) {
    const want = Buffer.from(totpAt(secret, c));
    if (want.length === given.length && timingSafeEqual(want, given)) return true;
  }
  return false;
}

// ── sessions ───────────────────────────────────────────────────────────────
// Held in memory AND on disk, since 2026-09-13. This used to say: "Held in
// memory on purpose. A restart logs the operator out, which costs one login and
// means a stolen session cannot outlive the process."
//
// True, and it cost more than it was worth. The owner was being logged out
// constantly and asked for 24 hours -- but the timeout was already 8 hours and
// was never what ended his session. 27 restarts of this service in one day
// while features were deployed is what ended it. Raising 8 to 24 without this
// would have changed nothing he could feel.
//
// The trade: the file is 0600 root, beside credential.json and the Telegram
// tokens. Anybody who can read it already has root, and with root a session
// token is the least of what they have. It buys no attacker anything they did
// not already hold, and it stops a deploy logging the owner out.
//
// The absolute expiry is KEPT and is the reason this is safe: a restored
// session is still measured from its ORIGINAL login, so a stolen file is worth
// nothing after 24 hours, and using a session cannot refresh it into
// immortality.
const SESSION_FILE = process.env.ADMIN_SESSION_FILE || '/opt/pcoin-admin/sessions.json';
const SESSION_MS = 24 * 3600e3;

const sessions = new Map();
(() => {
  // Unreadable is EMPTY here, deliberately, and it is the one place in this
  // panel where that is right: failing to read the session store must mean
  // "nobody is logged in", never "everybody is".
  try {
    const raw = JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
    const now = Date.now();
    for (const [id, s] of Object.entries(raw || {})) {
      if (s && typeof s.at === 'number' && now - s.at <= SESSION_MS) sessions.set(id, s);
    }
  } catch { /* first run, or unreadable: start with nobody logged in */ }
})();

function persist() {
  try {
    writeFileSync(SESSION_FILE, JSON.stringify(Object.fromEntries(sessions)), { mode: 0o600 });
  } catch { /* a panel that cannot save sessions still works; it just forgets */ }
}

export function newSession(meta = {}) {
  const id = randomBytes(32).toString('base64url');
  sessions.set(id, { ...meta, at: Date.now() });
  persist();
  return id;
}

export function checkSession(id) {
  if (!id) return null;
  const s = sessions.get(id);
  if (!s) return null;
  if (Date.now() - s.at > SESSION_MS) { sessions.delete(id); persist(); return null; }
  return s;
}

export function dropSession(id) { if (id) { sessions.delete(id); persist(); } }
export function sessionCount() { return sessions.size; }

// ── rate limiting ──────────────────────────────────────────────────────────
// Per-IP exponential backoff. The point is not to stop a determined attacker who
// already knows the URL — it is to make an online guessing attack against a
// 6-digit second factor arithmetically hopeless. After 5 failures the delay
// doubles from 2s, so the 10th attempt waits over a minute.
const fails = new Map();

export function throttleMs(ip) {
  const f = fails.get(ip);
  if (!f || f.n < 5) return 0;
  const wait = Math.min(2000 * 2 ** (f.n - 5), 15 * 60_000);
  const left = f.last + wait - Date.now();
  return left > 0 ? left : 0;
}

export function noteFailure(ip) {
  const f = fails.get(ip) || { n: 0, last: 0 };
  f.n += 1; f.last = Date.now();
  fails.set(ip, f);
}

export function clearFailures(ip) { fails.delete(ip); }

/** Is a second factor enrolled? The login asks for a code only when this is true.
 *
 *  2FA is OPTIONAL by design here, not because it is unimportant but because the
 *  alternative is worse: a panel that demands a code its owner cannot produce is
 *  a locked door with the key inside. Enrolment happens from the Security page,
 *  and enabling it REQUIRES entering a working code first — so it is impossible
 *  to switch on a secret your authenticator does not actually hold.
 *
 *  While it is off the panel says so on every page. That nag is the point. */
export function totpRequired(cred) {
  return !!(cred && cred.totp && cred.totpEnabled !== false);
}
