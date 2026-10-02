// Email confirmation for market.pc.am accounts -- and so for the exchange and
// the wrap desk, which sign in through here.
//
// Owner, 2026-10-02: "everyone has to confirm his email while registering in
// the system". Decided the same day: NEW accounts confirm before they can sign
// in at all; accounts that already existed keep signing in but must confirm
// before their next exchange withdrawal or wrap. Until this the market stored
// whatever address was typed and never checked it, so a password-reset link
// (password-reset.mjs) could go to an inbox the customer never owned.
//
// Built on the same pattern as password-reset.mjs, and for the same reasons:
//   * The link carries 32 random bytes in the URL FRAGMENT (/#verify=...), so
//     it stays out of every log and Referer. Only its SHA-256 is stored.
//   * A link lives 24 hours and works once; using one voids the others.
//   * Asking for a link answers the SAME whatever the email, and the mail goes
//     out in the background, so neither the text nor the timing tells anyone
//     whether an account exists.
//   * Only users.verify_required = 1 rows (opened after this went live) are
//     refused at sign-in. Everything else reads the flag and decides for
//     itself -- the exchange and the wrap desk learn it from the sign-in token.
//   * A failed read is NOT "confirmed". isVerified() answers false when it
//     cannot read, because what it guards is money going out.
//
// It also turns on only when BOTH the schema and the mailer exist. Without a
// mailer nobody could ever confirm, so new accounts are not made to wait.

import { timingSafeEqual } from 'node:crypto';
import { hashToken, newToken, makeLimiter, TOKEN_RE, esc } from './password-reset.mjs';

export const LINK_HOURS = 24;
const LINK_MS = LINK_HOURS * 3_600_000;
const HOUR_MS = 3_600_000;
export const PER_EMAIL_PER_HOUR = 3;     // links mailed to one account
export const PER_IP_PER_HOUR = 10;       // link requests from one connection
export const CONFIRMS_PER_IP_PER_HOUR = 30;

export function makeEmailVerify({
  pool, validEmail, mailer, notify = async () => {},
  publicUrl = 'https://market.pc.am', now = Date.now, log = console,
}) {
  const q = async (sql, args = []) => (await pool.query(sql, args))[0];
  const ipLimit = makeLimiter(PER_IP_PER_HOUR, HOUR_MS, now);
  const confirmLimit = makeLimiter(CONFIRMS_PER_IP_PER_HOUR, HOUR_MS, now);
  let schemaReady = false;
  let lastProbe = 0;

  async function init() {
    lastProbe = now();
    try {
      await q('SELECT email_verified_at, verify_required FROM users LIMIT 0');
      await q('SELECT token_hash FROM email_verifications LIMIT 0');
      schemaReady = true;
    } catch (e) {
      schemaReady = false;
      log.warn?.(`[email-verify] OFF: schema missing (${e.message}). Apply email-verify.sql.`);
    }
    return schemaReady;
  }

  const enabled = () => schemaReady && Boolean(mailer);

  // init() runs once at startup; if the database blipped then, the feature
  // would stay off for the life of the process and new accounts would skip
  // confirmation. So every path that decides anything calls this first: it
  // re-probes at most once every 30 seconds until the schema is seen.
  async function ensure() {
    if (schemaReady) return true;
    const t = now();
    if (t - lastProbe < 30_000) return false;
    lastProbe = t;
    return init();
  }

  /** Has this account confirmed its email? False on any failure to read. */
  async function isVerified(email) {
    if (!schemaReady) return false;
    try {
      const rows = await q('SELECT email_verified_at AS v FROM users WHERE email = ?', [email]);
      return Boolean(rows.length && rows[0].v !== null && rows[0].v !== undefined);
    } catch (e) {
      log.error?.(`[email-verify] read failed for ${email}: ${e.message}`);
      return false;
    }
  }

  /** Must this account confirm before it may sign in? Only accounts opened
   *  after this went live. Throws on a failed read: the caller answers 500
   *  rather than letting an unconfirmed new account in. */
  async function mustConfirmToSignIn(email) {
    await ensure();
    if (!schemaReady) return false;
    const rows = await q('SELECT verify_required AS r, email_verified_at AS v FROM users WHERE email = ?', [email]);
    if (!rows.length) return false;
    return Number(rows[0].r) === 1 && (rows[0].v === null || rows[0].v === undefined);
  }

  const SENT = { status: 200, body: { ok: true, message:
    `If that account still needs confirming, a confirmation link is on its way. It works once, for ${LINK_HOURS} hours. `
    + 'Check your spam folder if it does not arrive within a few minutes.' } };

  /** Mail a confirmation link. Same answer whether or not the account exists
   *  or is already confirmed. */
  async function send(rawEmail, ip) {
    if (!enabled()) return { status: 503, body: { error: 'email confirmation is not available yet' } };
    const email = String(rawEmail || '').trim().toLowerCase();
    if (!validEmail.test(email)) return { status: 400, body: { error: 'invalid email' } };
    if (!ipLimit(ip || '?')) return { status: 429, body: { error: 'too many requests from this connection; try again in an hour' } };

    const acc = await q('SELECT email_verified_at AS v FROM users WHERE email = ?', [email]);
    if (!acc.length) { log.log?.(`[email-verify] request for unknown ${email} from ${ip}`); return SENT; }
    if (acc[0].v !== null && acc[0].v !== undefined) return SENT;

    const t = now();
    const [{ n }] = await q('SELECT COUNT(*) AS n FROM email_verifications WHERE email = ? AND created_ms > ?', [email, t - HOUR_MS]);
    if (Number(n) >= PER_EMAIL_PER_HOUR) {
      log.warn?.(`[email-verify] ${email}: ${n} links in the last hour, not sending another (from ${ip})`);
      return SENT;
    }
    const { token, hash } = newToken();
    await q('INSERT INTO email_verifications (token_hash, email, created_ms, expires_ms, request_ip) VALUES (?,?,?,?,?)',
      [hash, email, t, t + LINK_MS, ip || null]);

    const link = `${publicUrl.replace(/\/+$/, '')}/#verify=${token}`;
    // Not awaited: the response must take the same time for an unknown email.
    mailer.send({ to: email, subject: 'Confirm your PCoin email', text:
      `Please confirm that ${email} is your email address for PCoin.\n`
      + 'It is the one account you use on market.pc.am, exchange.pc.am and wrapdesk.pc.am.\n\n'
      + `Open this link within ${LINK_HOURS} hours to confirm it:\n\n${link}\n\n`
      + 'The link works once. If you did not sign up for PCoin, ignore this email.\n\n'
      + 'PCoin will never ask you for your password or your recovery phrase.\n' })
      .then(r => { if (!r.ok) notify(`🟡 <b>Confirmation email failed</b> for ${esc(email)}: ${esc(r.error)}`); })
      .catch(e => log.error?.(`[email-verify] mail: ${e.message}`));
    return SENT;
  }

  /** Spend a link. On success the caller signs the user in. */
  async function confirm(token, ip) {
    if (!schemaReady) return { status: 503, body: { error: 'email confirmation is not available yet' } };
    if (!confirmLimit(ip || '?')) return { status: 429, body: { error: 'too many attempts from this connection; try again in an hour' } };
    const bad = { status: 400, body: { error: 'This confirmation link has expired or was already used. Sign in to send a new one.' } };
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return bad;
    const hash = hashToken(token);

    const conn = await pool.getConnection();
    let email;
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query(
        'SELECT token_hash, email, expires_ms, used_ms FROM email_verifications WHERE token_hash = ? FOR UPDATE', [hash]);
      const row = rows[0];
      const t = now();
      if (!row || row.used_ms !== null || Number(row.expires_ms) <= t
          || !timingSafeEqual(Buffer.from(row.token_hash), Buffer.from(hash))) {
        await conn.rollback();
        return bad;
      }
      email = row.email;
      // COALESCE keeps the FIRST confirmation time if one already exists.
      const [u] = await conn.query(
        'UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE email = ?', [t, email]);
      if (u.affectedRows !== 1) { await conn.rollback(); return bad; }
      await conn.query('UPDATE email_verifications SET used_ms = ?, used_ip = ? WHERE email = ? AND used_ms IS NULL',
        [t, ip || null, email]);
      await conn.commit();
    } catch (e) {
      try { await conn.rollback(); } catch { /* already gone */ }
      throw e;
    } finally {
      conn.release();
    }
    return { status: 200, body: { ok: true, email }, email };
  }

  /** A completed password reset proves the inbox too. Best effort. */
  async function markVerified(email) {
    if (!schemaReady) return;
    await q('UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE email = ?', [now(), email]);
  }

  return { init, ensure, enabled, isVerified, mustConfirmToSignIn, send, confirm, markVerified,
    schemaReady: () => schemaReady };
}
