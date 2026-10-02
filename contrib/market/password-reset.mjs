// Password reset for market.pc.am accounts -- and so for the exchange and the
// wrap desk, which have no passwords of their own and sign in through here.
//
// Owner, 2026-10-01: "build password reset for market and exchange, they are
// same auth flow". Until this a forgotten password stranded the account and
// whatever it held: there was no reset at all, by email or by hand.
//
// How it holds together, and why each part is there:
//   * The emailed link carries 32 random bytes. Only their SHA-256 is stored,
//     so a read of password_resets cannot be replayed as a reset.
//   * A link lives 30 minutes and works once; using one voids every other
//     outstanding link for the same account.
//   * The token rides in the URL FRAGMENT (/#reset=...). Browsers never send a
//     fragment to a server, so it stays out of the access log, out of
//     Cloudflare, and out of any Referer header.
//   * Asking for a link answers the SAME whatever the email. Whether an
//     account exists is not something this form will tell anyone, and the mail
//     goes out in the background so the response time does not tell either.
//   * A reset signs out every session minted before it (sessions_valid_after).
//     Someone who stole a session must not keep it past the password change.
//   * The ops chat hears about every completed reset and the account gets a
//     "your password was changed" mail, so a reset nobody asked for is seen.
//
// What it does NOT prove: accounts opened before 2026-10-02 never confirmed
// their email, so for them a link proves control of the address the account
// was opened with, nothing more. That is the usual bargain. An account opened
// on a mistyped address still needs a person to sort out. Since 2026-10-02
// new accounts confirm first (email-verify.mjs), and a completed reset counts
// as a confirmation for older ones -- the server marks it after a reset.
//
// The exchange keeps its own sessions after the SSO hand-off, and its own 2FA.
// A market reset does not end an exchange session that is already open; the
// exchange's 2FA, not this file, is what guards withdrawals there.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const LINK_MINUTES = 30;
const LINK_MS = LINK_MINUTES * 60_000;
const HOUR_MS = 3_600_000;
export const PER_EMAIL_PER_HOUR = 3;   // links mailed to one account
export const PER_IP_PER_HOUR = 10;     // link requests from one connection
export const RESETS_PER_IP_PER_HOUR = 20;
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/; // 32 bytes, base64url, no padding

export const hashToken = t => createHash('sha256').update(String(t)).digest('hex');
export function newToken() {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// A sliding one-hour counter per key, in memory. Losing it on a restart only
// resets the counters; the per-email cap is read from the database instead,
// because that is the one an attacker would most like to reset.
export function makeLimiter(max, windowMs, now) {
  const hits = new Map();
  return key => {
    const t = now();
    const recent = (hits.get(key) || []).filter(x => t - x < windowMs);
    if (recent.length >= max) { hits.set(key, recent); return false; }
    recent.push(t);
    hits.set(key, recent);
    if (hits.size > 50_000) hits.clear();   // bounded; a flood only resets counts
    return true;
  };
}

export function makePasswordReset({
  pool, hashPw, validEmail, mailer, notify = async () => {},
  publicUrl = 'https://market.pc.am', sessionMs, now = Date.now, log = console,
}) {
  const q = async (sql, args = []) => (await pool.query(sql, args))[0];
  const ipLimit = makeLimiter(PER_IP_PER_HOUR, HOUR_MS, now);
  const resetLimit = makeLimiter(RESETS_PER_IP_PER_HOUR, HOUR_MS, now);
  let schemaReady = false;

  /** True once the migration is in. Until then the feature is off and session
   *  checks are skipped, so deploying the code before the SQL signs nobody out. */
  async function init() {
    try {
      await q('SELECT sessions_valid_after FROM users LIMIT 0');
      await q('SELECT token_hash FROM password_resets LIMIT 0');
      schemaReady = true;
    } catch (e) {
      schemaReady = false;
      log.warn?.(`[password-reset] OFF: schema missing (${e.message}). Apply password-reset.sql.`);
    }
    return schemaReady;
  }

  const enabled = () => schemaReady && Boolean(mailer);

  /** Is a session token minted at (expMs - sessionMs) still acceptable?
   *  Returns false on a failed read: "could not check" is not "still valid". */
  async function sessionStillValid(email, expMs) {
    if (!schemaReady) return true;
    try {
      const rows = await q('SELECT sessions_valid_after AS v FROM users WHERE email = ?', [email]);
      if (!rows.length) return false;
      const v = rows[0].v;
      if (v === null || v === undefined) return true;
      return expMs - sessionMs >= Number(v);
    } catch (e) {
      log.error?.(`[password-reset] session check failed for ${email}: ${e.message}`);
      return false;
    }
  }

  const SENT = { status: 200, body: { ok: true, message:
    `If an account uses that email, a reset link is on its way. It works once, for ${LINK_MINUTES} minutes. `
    + 'Check your spam folder if it does not arrive within a few minutes.' } };

  /** Ask for a link. Same answer whether or not the account exists. */
  async function request(rawEmail, ip) {
    if (!enabled()) return { status: 503, body: { error: 'password reset by email is not available yet. Ask in the PCoin group and the team will help.' } };
    const email = String(rawEmail || '').trim().toLowerCase();
    if (!validEmail.test(email)) return { status: 400, body: { error: 'invalid email' } };
    if (!ipLimit(ip || '?')) return { status: 429, body: { error: 'too many reset requests from this connection; try again in an hour' } };

    const acc = await q('SELECT email FROM users WHERE email = ?', [email]);
    if (!acc.length) { log.log?.(`[password-reset] request for unknown ${email} from ${ip}`); return SENT; }

    const t = now();
    const [{ n }] = await q('SELECT COUNT(*) AS n FROM password_resets WHERE email = ? AND created_ms > ?', [email, t - HOUR_MS]);
    if (Number(n) >= PER_EMAIL_PER_HOUR) {
      log.warn?.(`[password-reset] ${email}: ${n} links in the last hour, not sending another (from ${ip})`);
      return SENT;
    }
    const { token, hash } = newToken();
    await q('INSERT INTO password_resets (token_hash, email, created_ms, expires_ms, request_ip) VALUES (?,?,?,?,?)',
      [hash, email, t, t + LINK_MS, ip || null]);

    const link = `${publicUrl.replace(/\/+$/, '')}/#reset=${token}`;
    // Not awaited: the response must take the same time for an unknown email.
    mailer.send({ to: email, subject: 'Reset your PCoin password', text:
      `Someone asked to reset the password for the PCoin account ${email}.\n`
      + 'It is the one account you use on market.pc.am, exchange.pc.am and wrapdesk.pc.am.\n\n'
      + `To choose a new password, open this link within ${LINK_MINUTES} minutes:\n\n${link}\n\n`
      + 'The link works once. If you did not ask for this, ignore this email; your password stays as it is.\n\n'
      + 'PCoin will never ask you for your password or your recovery phrase.\n' })
      .then(r => { if (!r.ok) notify(`🟡 <b>Password-reset email failed</b> for ${esc(email)}: ${esc(r.error)}`); })
      .catch(e => log.error?.(`[password-reset] mail: ${e.message}`));
    return SENT;
  }

  /** Spend a link. On success the caller signs the user in with a fresh session. */
  async function reset(token, password, ip) {
    if (!schemaReady) return { status: 503, body: { error: 'password reset is not available yet' } };
    if (!resetLimit(ip || '?')) return { status: 429, body: { error: 'too many attempts from this connection; try again in an hour' } };
    const bad = { status: 400, body: { error: 'This reset link has expired or was already used. Ask for a new one from the sign-in page.' } };
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return bad;
    if (String(password || '').length < 8) return { status: 400, body: { error: 'password must be at least 8 characters' } };
    const hash = hashToken(token);

    const conn = await pool.getConnection();
    let email;
    try {
      await conn.beginTransaction();
      // FOR UPDATE: two tabs racing the same link cannot both spend it.
      const [rows] = await conn.query(
        'SELECT token_hash, email, expires_ms, used_ms FROM password_resets WHERE token_hash = ? FOR UPDATE', [hash]);
      const row = rows[0];
      const t = now();
      if (!row || row.used_ms !== null || Number(row.expires_ms) <= t
          || !timingSafeEqual(Buffer.from(row.token_hash), Buffer.from(hash))) {
        await conn.rollback();
        return bad;
      }
      email = row.email;
      const salt = randomBytes(16).toString('hex');
      const [u] = await conn.query(
        'UPDATE users SET salt = ?, hash = ?, sessions_valid_after = ? WHERE email = ?',
        [salt, hashPw(password, salt), t, email]);
      if (u.affectedRows !== 1) { await conn.rollback(); return bad; }
      // This link and every other one still open for the account.
      await conn.query('UPDATE password_resets SET used_ms = ?, used_ip = ? WHERE email = ? AND used_ms IS NULL',
        [t, ip || null, email]);
      await conn.commit();
    } catch (e) {
      try { await conn.rollback(); } catch { /* already gone */ }
      throw e;
    } finally {
      conn.release();
    }

    notify(`🔑 <b>Password reset</b> for ${esc(email)} from ${esc(ip || '?')}. All their market sessions were signed out.`);
    if (mailer) {
      mailer.send({ to: email, subject: 'Your PCoin password was changed', text:
        `The password for the PCoin account ${email} was just changed using a reset link.\n`
        + 'Every device that was signed in to market.pc.am has been signed out.\n\n'
        + 'If this was you, there is nothing more to do.\n'
        + 'If it was NOT you, reset your password again right away from https://market.pc.am, '
        + 'turn on two-factor sign-in on exchange.pc.am, and tell us at pcoin@pc.am.\n' })
        .catch(e => log.error?.(`[password-reset] confirm mail: ${e.message}`));
    }
    return { status: 200, body: { ok: true, email }, email };
  }

  return { init, enabled, request, reset, sessionStillValid };
}
