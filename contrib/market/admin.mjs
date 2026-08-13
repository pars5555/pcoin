// ═══════════════════════════════════════════════════════════════════════════
// market.pc.am admin panel — everything about the market, in one place.
// ═══════════════════════════════════════════════════════════════════════════
//
// This panel can pause sales, change limits, and send coins. It is therefore
// the most attackable surface on the box, and it is built accordingly:
//
//   * Password is scrypt-hashed, never stored or logged in the clear, and is
//     set from the CLI — never from a config file, never from a chat message.
//   * TOTP (RFC 6238) is required once enrolled. The panel enrols it itself so
//     the shared secret is shown exactly once.
//   * Login is rate-limited per account AND per IP, because one without the
//     other just moves the guessing.
//   * Every state-changing request needs a CSRF token bound to the session.
//   * The session cookie is HttpOnly, Secure, SameSite=Strict.
//   * serviceRate and the ladder's prices are deliberately NOT editable here.
//     They move money in four other systems; a web form is the wrong place for
//     them and the CLI is a fine place.
//
// Read paths are generous — every table, filterable and sortable — because
// hiding data from the operator has never once prevented a loss.

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { toSvg } from './qr.mjs';
import { clientIp, ipLabel } from './clientip.mjs';

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };
const SESSION_HOURS = 12;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_TRIES = 8;

// ── TOTP, RFC 6238 ─────────────────────────────────────────────────────────
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
  for (const c of s.replace(/=+$/, '').toUpperCase()) {
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

// ── the panel ──────────────────────────────────────────────────────────────
export function makeAdmin({ pool, cfg, settings, ladder, delivery, backing, notify, log = console }) {
  const q = async (sql, args = []) => (await pool.query(sql, args))[0];
  const esc = s => String(s ?? '').replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // See settings.mjs: the app user has no DDL rights on purpose. A privilege
  // error here is only fatal if the tables are actually absent.
  async function ensureTable() {
    try { await ensureTableDdl(); }
    catch (e) {
      try {
        await q(`SELECT 1 FROM admins LIMIT 1`);
        await q(`SELECT 1 FROM admin_audit LIMIT 1`);
      } catch {
        throw new Error(`the admin tables are missing and this user cannot create them ` +
                        `(${e.message}). Create them as root — see contrib/market/README.md.`);
      }
      log.warn('[admin] no DDL rights, which is correct; the tables already exist');
    }
  }

  async function ensureTableDdl() {
    await q(`CREATE TABLE IF NOT EXISTS admins (
               email        VARCHAR(190) NOT NULL,
               salt         CHAR(32)     NOT NULL,
               hash         CHAR(128)    NOT NULL,
               totp_secret  VARCHAR(64)  NULL,
               totp_enabled TINYINT(1)   NOT NULL DEFAULT 0,
               last_login   TIMESTAMP    NULL DEFAULT NULL,
               created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
               PRIMARY KEY (email)
             ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await q(`CREATE TABLE IF NOT EXISTS admin_audit (
               id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
               email      VARCHAR(190) NOT NULL,
               action     VARCHAR(64)  NOT NULL,
               detail     TEXT         NULL,
               ip         VARCHAR(64)  NULL,
               at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
               PRIMARY KEY (id), KEY idx_at (at)
             ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  }

  /** Do the limits currently allow ANY order at all? Returns a description of
   *  the contradiction, or null if they are coherent. */
  async function limitsIncoherent() {
    if (!settings || !ladder) return null;
    try {
      const minUsd = settings.get('minOrderUsd');
      const capPcn = settings.get('maxOrderPcn');
      const rungs = await ladder.rungsWithStock();
      const capUsd = ladder.walkPcn(rungs, capPcn).cost;
      if (capUsd < minUsd) {
        return `no order is possible: the ${capPcn.toLocaleString()} PCN cap is worth only ` +
               `$${capUsd.toFixed(2)} at today's prices, below the $${minUsd} minimum. ` +
               `Raise the PCN cap to at least ` +
               `${Math.ceil(ladder.walkUsd(rungs, minUsd).pcn).toLocaleString()} PCN, ` +
               `or lower the minimum.`;
      }
      return null;
    } catch { return null; }
  }

  const hashPw = (pw, salt) => scryptSync(pw, salt, 64, SCRYPT).toString('hex');

  async function setPassword(email, password) {
    if (String(password).length < 12) {
      throw new Error('an admin password must be at least 12 characters');
    }
    const salt = randomBytes(16).toString('hex');
    const em = String(email).toLowerCase();
    const [before] = await q(`SELECT email FROM admins WHERE email=?`, [em]);
    await q(`INSERT INTO admins (email, salt, hash) VALUES (?,?,?)
             ON DUPLICATE KEY UPDATE salt=VALUES(salt), hash=VALUES(hash)`,
            [em, salt, hashPw(password, salt)]);
    // Changing the password to this panel — which can pause sales, move limits
    // and send coins — left no trace whatever: no audit row, no alert. Someone
    // who reached the CLI could take the account over silently, and there was
    // nothing to notice afterwards either. It is run as root from a terminal,
    // so it is normally the owner; "normally" is not a control.
    await audit(em, before?.length ? 'password.changed' : 'admin.created', null, 'cli');
    await notify(before?.length
      ? `🔑 <b>Admin password CHANGED</b> for ${esc(em)}\nSet from the server CLI. If this was ` +
        `not you, that account is compromised and so is the box it was run on.`
      : `🔑 <b>New admin account created</b>: ${esc(em)}\nSet from the server CLI.`
    ).catch(() => {});
    return { ok: true };
  }

  async function audit(email, action, detail, ip) {
    try {
      await q(`INSERT INTO admin_audit (email, action, detail, ip) VALUES (?,?,?,?)`,
              [email || '-', action, detail ? String(detail).slice(0, 4000) : null, ip || null]);
    } catch (e) { log.warn('[admin] audit write failed:', e.message); }
  }

  // ── sessions ─────────────────────────────────────────────────────────────
  // Same HMAC shape as the customer session, with the delimiter bug already
  // fixed: the payload is parsed from the RIGHT, so an identity containing the
  // delimiter cannot masquerade as another. Admin rows are only ever created by
  // root through the CLI, so there is no registration path to validate here.
  const secret = () => cfg.sessionSecret + '|admin';
  const sign = p => `${p}.${createHmac('sha256', secret()).update(p).digest('hex')}`;
  function verify(tok) {
    if (!tok) return null;
    const i = tok.lastIndexOf('.');
    if (i < 1) return null;
    const p = tok.slice(0, i);
    const want = createHmac('sha256', secret()).update(p).digest('hex');
    const got = tok.slice(i + 1);
    if (got.length !== want.length || !timingSafeEqual(Buffer.from(got), Buffer.from(want))) return null;
    const cut = p.lastIndexOf('|');
    if (cut < 1) return null;
    const email = p.slice(0, cut);
    const exp = Number(p.slice(cut + 1));
    if (!isFinite(exp) || Date.now() >= exp) return null;
    return email;
  }
  // CSRF bound to the SESSION, not to the identity.
  //
  // This used to be HMAC(email), which made it a constant: the same admin got
  // the same token on every login, forever. It survived signing out, session
  // expiry, and a password change — so one leak (a screenshot of the page
  // source, a browser extension, a proxy log, a bug report with the HTML in it)
  // was a token that stayed valid for the life of the account, with no way to
  // revoke it short of rotating sessionSecret and logging everyone out.
  //
  // Deriving it from the session token instead ties its lifetime to the
  // session's: signing in mints a new one, and every earlier token is dead the
  // moment the session it belonged to is. The session payload already carries
  // an expiry, so no two logins share a token.
  const csrfFor = sessTok => createHmac('sha256', secret() + '|csrf')
    .update(String(sessTok || '')).digest('hex');

  // ── flash messages across a redirect ─────────────────────────────────────
  // Every write answers with a redirect to a GET page (post/redirect/get), so
  // the browser never sits on a URL that only accepts POST. Without this,
  // refreshing after saving lands on a route with no GET handler and shows
  // "no such page" -- or worse, silently re-submits the write.
  //
  // The message therefore has to survive the redirect. It goes in a signed,
  // short-lived cookie rather than the query string: it can contain a txid or
  // an error, and neither belongs in a URL that ends up in browser history.
  function flashCookie(cls, text) {
    const payload = Buffer.from(JSON.stringify({ cls, text })).toString('base64url');
    const mac = createHmac('sha256', secret() + '|flash').update(payload).digest('hex').slice(0, 32);
    return `mktflash=${payload}.${mac}; Path=/admin; Max-Age=20; HttpOnly; Secure; SameSite=Strict`;
  }
  function readFlash(req) {
    const c = (req.headers.cookie || '').split(/;\s*/).find(x => x.startsWith('mktflash='));
    if (!c) return null;
    const raw = c.slice(9);
    const i = raw.lastIndexOf('.');
    if (i < 1) return null;
    const payload = raw.slice(0, i), mac = raw.slice(i + 1);
    const want = createHmac('sha256', secret() + '|flash').update(payload).digest('hex').slice(0, 32);
    if (mac.length !== want.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;
    try { return JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { return null; }
  }
  const CLEAR_FLASH = 'mktflash=; Path=/admin; Max-Age=0; HttpOnly; Secure; SameSite=Strict';

  const tries = new Map();   // key -> {n, until}
  function throttled(key) {
    const t = tries.get(key);
    if (!t) return false;
    if (Date.now() > t.until) { tries.delete(key); return false; }
    return t.n >= LOGIN_MAX_TRIES;
  }
  function noteFail(key) {
    // Bounded, and swept. Anyone can post arbitrary emails at the login form,
    // and an unbounded Map keyed by them is a memory-exhaustion primitive that
    // needs no account at all.
    if (tries.size > 5000) {
      const now = Date.now();
      for (const [k, v] of tries) if (v.until < now) tries.delete(k);
      if (tries.size > 5000) tries.clear();   // last resort: lose the window, keep the process
    }
    const t = tries.get(key) || { n: 0, until: Date.now() + LOGIN_WINDOW_MS };
    t.n++; t.until = Date.now() + LOGIN_WINDOW_MS;
    tries.set(key, t);
  }

  // Send an alert at most once per key per window. Anything a stranger can
  // trigger has to be rate-limited before it reaches Telegram, or the alert
  // channel becomes the attack: a scanner posting the login form a thousand
  // times would bury the float warning and the double-send alarm under its own
  // noise, and Telegram would rate-limit the bot for hours afterwards.
  const alerted = new Map();   // key -> expiry
  async function alertOnce(key, build) {
    const now = Date.now();
    if (alerted.size > 5000) {
      for (const [k, exp] of alerted) if (exp < now) alerted.delete(k);
      if (alerted.size > 5000) alerted.clear();
    }
    const exp = alerted.get(key);
    if (exp && exp > now) return false;
    alerted.set(key, now + LOGIN_WINDOW_MS);
    try { await notify(build()); } catch (e) { log.warn('[admin] alert failed:', e.message); }
    return true;
  }

  // ── rendering ────────────────────────────────────────────────────────────
  const CSS = `
  :root{--bg:#fbfaf8;--fg:#241f1b;--dim:#7c736b;--line:#e5ded4;--card:#fff;--accent:#8a5a2b;
        --ok:#2f6f43;--warn:#8a6d1f;--bad:#a3342a}
  @media(prefers-color-scheme:dark){:root{--bg:#171513;--fg:#efe9e2;--dim:#a49a90;--line:#332e29;
        --card:#1f1c19;--accent:#d99a55;--ok:#6fbf8a;--warn:#d9b45a;--bad:#e08376}}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);
    font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
  a{color:var(--accent)}
  header{display:flex;gap:18px;align-items:center;padding:12px 20px;border-bottom:1px solid var(--line);
    background:var(--card);position:sticky;top:0;flex-wrap:wrap;z-index:5}
  header b{font-size:15px}
  nav a{margin-right:14px;text-decoration:none;color:var(--fg);opacity:.72}
  nav a.on{opacity:1;font-weight:600;color:var(--accent)}
  main{padding:20px;max-width:1500px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:20px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
  .k{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim)}
  .v{font-size:20px;font-weight:600;margin-top:2px;font-variant-numeric:tabular-nums}
  .s{font-size:12px;color:var(--dim)}
  table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);
    border-radius:10px;overflow:hidden;font-variant-numeric:tabular-nums}
  th,td{padding:8px 10px;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap}
  th{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--dim);background:var(--bg)}
  th a{color:inherit;text-decoration:none}
  tr:last-child td{border-bottom:0}
  .mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}
  .wrap{overflow-x:auto}
  .pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;border:1px solid var(--line)}
  .ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}
  form.inline{display:inline}
  input,select,button{font:inherit;padding:6px 9px;border:1px solid var(--line);border-radius:7px;
    background:var(--bg);color:var(--fg)}
  button{background:var(--accent);color:#fff;border-color:transparent;cursor:pointer}
  button.ghost{background:transparent;color:var(--fg)}
  .filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;align-items:center}
  .msg{padding:10px 12px;border-radius:8px;margin-bottom:14px;border:1px solid var(--line)}
  .msg.err{border-color:var(--bad);color:var(--bad)}
  .msg.ok{border-color:var(--ok);color:var(--ok)}
  .set{display:grid;grid-template-columns:280px 160px 1fr;gap:10px;align-items:center;
    padding:9px 0;border-bottom:1px solid var(--line)}
  .set label{font-weight:600}.set .h{color:var(--dim);font-size:12px}
  .login{max-width:380px;margin:80px auto}
  code{background:var(--bg);padding:1px 5px;border-radius:5px}`;

  const NAV = [['', 'Dashboard'], ['orders', 'Orders'], ['ladder', 'Ladder'], ['fills', 'Fills'],
               ['ipn', 'IPN log'], ['users', 'Users'], ['settings', 'Settings'], ['audit', 'Audit']];

  const page = (title, active, body, email, csrfTok = '') => `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · market admin</title><style>${CSS}</style></head><body>
<header><b>market.pc.am</b><nav>${NAV.map(([h, l]) =>
  `<a class="${active === h ? 'on' : ''}" href="/admin/${h}">${l}</a>`).join('')}</nav>
<span style="margin-left:auto" class="s">${esc(email || '')}</span>
<form class="inline" method="POST" action="/admin/logout">
<input type="hidden" name="csrf" value="${csrfTok}">
<button class="ghost">Sign out</button></form></header>
<main>${body}</main></body></html>`;

  const loginPage = (msg, needCode) => `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>market admin</title><style>${CSS}</style></head><body><main class="login">
<h2>market.pc.am admin</h2>
${msg ? `<div class="msg err">${esc(msg)}</div>` : ''}
<form method="POST" action="/admin/login">
<p><input name="email" type="email" placeholder="email" style="width:100%" required autofocus></p>
<p><input name="password" type="password" placeholder="password" style="width:100%" required></p>
<p><input name="code" inputmode="numeric" autocomplete="one-time-code"
   placeholder="6-digit code${needCode ? '' : ' (if enrolled)'}" style="width:100%"></p>
<p><button style="width:100%">Sign in</button></p>
</form></main></body></html>`;

  // ── list helper: filtering, sorting, paging, all bound to allowlists ─────
  function listQuery(u, { cols, sortable, defaultSort, table, where = [], args = [] }) {
    const sort = sortable.includes(u.searchParams.get('sort')) ? u.searchParams.get('sort') : defaultSort;
    const dir = u.searchParams.get('dir') === 'asc' ? 'ASC' : 'DESC';
    const page = Math.max(1, Number(u.searchParams.get('page')) || 1);
    const per = Math.min(200, Math.max(10, Number(u.searchParams.get('per')) || 50));
    // `sort` is chosen from an allowlist, never interpolated from raw input.
    const sql = `SELECT ${cols} FROM ${table}` +
                (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
                ` ORDER BY ${sort} ${dir} LIMIT ? OFFSET ?`;
    return { sql, args: [...args, per, (page - 1) * per], page, per, sort, dir };
  }
  const sortLink = (u, col) => {
    const p = new URLSearchParams(u.searchParams);
    const cur = p.get('sort'), dir = p.get('dir');
    p.set('sort', col);
    p.set('dir', cur === col && dir !== 'asc' ? 'asc' : 'desc');
    return `?${p}`;
  };
  const pager = (u, page, rows, per) => {
    const p = new URLSearchParams(u.searchParams);
    const mk = n => { p.set('page', n); return `?${p}`; };
    return `<p class="s">page ${page}${rows === per ? ` · <a href="${mk(page + 1)}">next</a>` : ''}` +
           `${page > 1 ? ` · <a href="${mk(page - 1)}">previous</a>` : ''}</p>`;
  };

  const statusPill = s => {
    const cls = ['delivered'].includes(s) ? 'ok'
              : ['needs_review', 'failed', 'refunded'].includes(s) ? 'bad'
              : ['awaiting_delivery', 'sending'].includes(s) ? 'warn' : '';
    return `<span class="pill ${cls}">${esc(String(s).replace(/_/g, ' '))}</span>`;
  };
  const money = n => Number(n).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');

  // ── the handler ──────────────────────────────────────────────────────────
  async function handle(req, res, u, body, rawSendHtml, sendJson) {
    const path = u.pathname.replace(/\/+$/, '') || '/admin';
    const sub = path.replace(/^\/admin\/?/, '');
    // The LAST X-Forwarded-For entry, not the first. Caddy APPENDS the real
    // client to whatever the client sent, so the first entry is attacker-chosen
    // and using it let anyone reset their own rate limit by varying a header.
    // Behind Cloudflare AND Caddy, so neither end of X-Forwarded-For is the
    // visitor — see clientip.mjs for the measured hop chain. `null` here means
    // genuinely unidentifiable and is kept as its own value: it gets its own
    // rate-limit bucket and reads as "unknown" in the alert, rather than being
    // rendered as some real-looking address nobody actually connected from.
    const ip = clientIp(req);
    const ipTxt = ipLabel(ip);
    const cookie = (req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith('mktadm='));
    const sessTok = cookie ? cookie.slice(7) : '';
    const email = verify(sessTok);
    // Derived once per request and threaded into every page, so the token a
    // form carries is always the one this session's POST will be checked against.
    const csrfTok = csrfFor(sessTok);

    // ---- login ----
    if (sub === 'login' && req.method === 'POST') {
      const f = new URLSearchParams(body);
      const em = String(f.get('email') || '').trim().toLowerCase();
      const pw = String(f.get('password') || '');
      const code = String(f.get('code') || '');
      if (throttled(`ip:${ip}`) || throttled(`em:${em}`)) {
        await audit(em, 'login.throttled', null, ip);
        await alertOnce(`lock:${ip}`, () =>
          `⛔️ <b>Admin login locked out</b>\n<code>${esc(ipTxt)}</code> hit ${LOGIN_MAX_TRIES} ` +
          `failed attempts and is blocked for 15 minutes.\nThis is someone guessing. If it ` +
          `is not you, no action is required — but if it keeps up, say so and the panel can ` +
          `be put behind an IP allowlist.`);
        return rawSendHtml(429, loginPage('Too many attempts. Wait 15 minutes.'));
      }
      const [acc] = await q(`SELECT email, salt, hash, totp_secret, totp_enabled FROM admins WHERE email=?`, [em]);
      // One message for every failure: which of the three was wrong is not the
      // guesser's business.
      const bad = async why => {
        noteFail(`ip:${ip}`); noteFail(`em:${em}`);
        await audit(em, 'login.fail', why, ip);
        // The panel is reachable from the whole internet, so somebody guessing
        // at it must reach the operator, not just the audit table nobody reads
        // until after the fact. Rate-limited to one message per IP per window:
        // an unthrottled alert on every failure is its own denial of service,
        // against the one channel that carries the double-send alarm.
        await alertOnce(`fail:${ip}`, () =>
          `🚨 <b>Failed admin login</b>\n<code>${esc(em || '(blank)')}</code> from ` +
          `<code>${esc(ipTxt)}</code> — ${esc(why)}\nFurther failures from this address are ` +
          `suppressed for 15 minutes. If this was not you, nothing is wrong yet: the ` +
          `password is scrypt-hashed and 2FA is enrolled.`);
        return rawSendHtml(401, loginPage('Wrong email, password or code.'));
      };
      if (!acc) return bad('no such admin');
      const h = Buffer.from(hashPw(pw, acc.salt), 'hex');
      const w = Buffer.from(acc.hash, 'hex');
      if (h.length !== w.length || !timingSafeEqual(h, w)) return bad('bad password');
      if (acc.totp_enabled) {
        if (!totpValid(acc.totp_secret, code)) return bad('bad totp');
      }
      tries.delete(`ip:${ip}`); tries.delete(`em:${em}`);
      await q(`UPDATE admins SET last_login=NOW() WHERE email=?`, [em]);
      await audit(em, 'login.ok', acc.totp_enabled ? '2fa' : 'no 2fa', ip);
      await notify(`🔐 <b>Admin signed in</b>\n${esc(em)} from <code>${esc(ipTxt)}</code>` +
                   `${acc.totp_enabled ? '' : '\n⚠️ 2FA is NOT enrolled on this account'}`);
      const tok = sign(`${em}|${Date.now() + SESSION_HOURS * 3600e3}`);
      res.writeHead(302, { Location: '/admin', 'Set-Cookie':
        `mktadm=${tok}; Path=/admin; Max-Age=${SESSION_HOURS * 3600}; HttpOnly; Secure; SameSite=Strict` });
      return res.end();
    }

    if (!email) {
      if (req.method === 'POST') return rawSendHtml(401, loginPage('Session expired. Sign in again.'));
      return rawSendHtml(200, loginPage(null));
    }

    // ---- everything below is authenticated ----
    if (sub === 'logout' && req.method === 'POST') {
      res.writeHead(302, { Location: '/admin',
        'Set-Cookie': 'mktadm=; Path=/admin; Max-Age=0; HttpOnly; Secure; SameSite=Strict' });
      return res.end();
    }

    // CSRF on every write. A GET can never change anything here.
    if (req.method === 'POST') {
      const f = new URLSearchParams(body);
      const want = csrfTok;
      const got = String(f.get('csrf') || '');
      if (got.length !== want.length || !timingSafeEqual(Buffer.from(got), Buffer.from(want))) {
        await audit(email, 'csrf.fail', path, ip);
        // rawSendHtml, not sendHtml: the latter is declared further down and is
        // in its temporal dead zone here, so this branch used to throw a
        // ReferenceError and answer 500. The request was still refused and the
        // audit row still written, so nothing was ever let through — but the
        // operator saw an opaque crash instead of "Bad CSRF token", which is
        // the difference between "I need to reload" and "the panel is broken".
        // A rejection has no flash to clear, so the wrapper is not wanted here.
        return rawSendHtml(403, page('Forbidden', '',
          `<div class="msg err">Bad CSRF token — reload the page and try again. ` +
          `This is normal if you left the tab open across a sign-out.</div>`, email, csrfTok));
      }
    }

    const csrf = `<input type="hidden" name="csrf" value="${csrfTok}">`;

    // Any message left by the write that redirected us here. Read once, then
    // cleared, so it does not follow you around the panel.
    const fl = readFlash(req);
    const flash = fl ? `<div class="msg ${fl.cls === 'err' ? 'err' : 'ok'}">${esc(fl.text)}</div>` : '';
    const sendHtml = (code, html) =>
      rawSendHtml(code, html, fl ? { 'Set-Cookie': CLEAR_FLASH } : {});

    // A GET on a write-only route is a refresh, or a pasted URL. Send it
    // somewhere that renders instead of answering "no such page".
    if (req.method === 'GET' &&
        ['settings', 'order/deliver', 'order/send', 'order/expire',
         'totp/enrol', 'totp/confirm', 'totp/disable', 'logout'].includes(sub)) {
      if (sub !== 'settings') {
        res.writeHead(303, { Location: sub.startsWith('order/') ? '/admin/orders'
                                   : sub === 'logout' ? '/admin' : '/admin/settings' });
        return res.end();
      }
    }

    /** Finish a write: 303 to a page that answers GET, carrying the message. */
    const done = (to, cls, text) => {
      res.writeHead(303, { Location: to, 'Set-Cookie': flashCookie(cls, text) });
      return res.end();
    };

    // ---- actions ----
    if (req.method === 'POST') {
      const f = new URLSearchParams(body);
      const act = sub;
      try {
        if (act === 'settings') {
          // `changed` is declared OUTSIDE the try that wraps this whole action.
          //
          // settings.set() writes each key in its own autocommit statement —
          // there is no transaction around the loop — so a key that fails
          // validation half-way leaves every earlier key already saved AND
          // live. The rejection then unwound to the outer catch, which only
          // showed a flash message, and `changed` (block-scoped here before)
          // was out of scope by then: no audit row, no Telegram, no record
          // that anything had been applied at all. The operator saw an error
          // and reasonably concluded nothing had happened, while several
          // settings had in fact changed underneath them.
          //
          // A partial apply is not something this can prevent without a
          // transaction the settings store does not offer. What it can do is
          // never hide it.
          var changed = [];
          for (const key of Object.keys(settings.defs)) {
            if (!f.has(`s_${key}`)) {
              // An unchecked checkbox sends nothing at all.
              if (settings.defs[key].type === 'bool' && f.has(`present_${key}`)) {
                if (settings.get(key) !== false) { await settings.set(key, false); changed.push(`${key}=false`); }
              }
              continue;
            }
            const raw = settings.defs[key].type === 'bool' ? true : f.get(`s_${key}`);
            const before = settings.get(key);
            const after = await settings.set(key, raw);
            if (before !== after) changed.push(`${key}: ${before} -> ${after}`);
          }
          if (changed.length) {
            await audit(email, 'settings.change', changed.join('; '), ip);
            await notify(`⚙️ <b>Settings changed</b> by ${esc(email)}\n<code>${esc(changed.join('\n'))}</code>`);
          }
          // Limits can contradict each other, and the contradiction is silent:
          // a coin cap worth less than the minimum order makes EVERY order
          // impossible while each setting looks perfectly reasonable on its own.
          // That happened once already. Say so at the moment it is created.
          const warn = await limitsIncoherent();
          if (warn) {
            await notify(`⚠️ <b>Settings are contradictory</b>\n${esc(warn)}`);
            return done('/admin/settings', 'err', warn);
          }
          return done('/admin/settings', 'ok',
                      changed.length ? changed.join(' · ') : 'No changes.');
        } else if (act === 'order/deliver') {
          await delivery.markDelivered(f.get('order_id'), f.get('txid'));
          await audit(email, 'order.deliver', `${f.get('order_id')} ${f.get('txid')}`, ip);
          return done('/admin/orders', 'ok', `Recorded ${f.get('order_id')} as delivered.`);
        } else if (act === 'order/send') {
          const id = f.get('order_id');
          // Ask the wallet BEFORE spending, and treat an unanswerable lookup as
          // a refusal. This button exists to re-send, so it is exactly where a
          // double payment would happen.
          const seen = await delivery.alreadySent(id);
          if (!seen.known) {
            await audit(email, 'order.send.refused', `${id}: wallet unreadable`, ip);
            return done('/admin/orders', 'err',
              `Refused: the wallet could not be asked whether ${id} was already sent. Nothing was sent.`);
          }
          if (seen.txid) {
            await audit(email, 'order.send.already', `${id} -> ${seen.txid}`, ip);
            return done('/admin/orders', 'err',
              `Refused: ${id} already left the wallet in ${seen.txid}. Record it instead.`);
          }
          const [ord] = await q(`SELECT status, delivery_error FROM orders WHERE order_id=?`, [id]);
          if (ord?.status === 'needs_review' && f.get('reviewed') !== '1') {
            return done('/admin/orders', 'err',
              `${id} is flagged: ${ord.delivery_error || 'no reason recorded'} — ` +
              `use the Send (reviewed) button if you still want to release it.`);
          }
          if (ord?.status === 'needs_review') {
            await q(`UPDATE orders SET status='awaiting_delivery' WHERE order_id=? AND status='needs_review'`, [id]);
          }
          const r = await delivery.deliverForce(id);
          await audit(email, 'order.send', `${id} -> ${r.txid || r.why}`, ip);
          return done('/admin/orders', r.ok ? 'ok' : 'err',
                      r.ok ? `Sent: ${r.txid || 'recorded'}` : r.why);
        } else if (act === 'order/expire') {
          const id = f.get('order_id');
          const r = await q(`UPDATE orders SET status='expired' WHERE order_id=? AND status='pending'`, [id]);
          if (r.affectedRows === 1) await ladder.releaseLadder(id);
          await audit(email, 'order.expire', id, ip);
          return done('/admin/orders', 'ok',
                      r.affectedRows ? 'Expired, inventory released.' : 'Not pending — nothing done.');
        } else if (act === 'totp/enrol') {
          // Generate, store, then REDIRECT to a page that shows what is stored.
          // Rendering it straight from the POST meant a refresh hit a route with
          // no GET handler; generating it on GET instead would issue a new
          // secret every refresh and invalidate the one just scanned.
          const secretB32 = base32Encode(randomBytes(20));
          const [was] = await q(`SELECT totp_enabled FROM admins WHERE email=?`, [email]);
          await q(`UPDATE admins SET totp_secret=?, totp_enabled=0 WHERE email=?`, [secretB32, email]);
          // Starting an enrolment TURNS 2FA OFF until the new code is confirmed.
          // That is a real weakening of the account and it used to happen with
          // no audit row and no alert, so an abandoned enrolment left the panel
          // password-only and nobody knew.
          await audit(email, 'totp.enrol.start', was?.totp_enabled ? '2FA was ON and is now OFF until confirmed' : '2FA was already off', ip);
          if (was?.totp_enabled) {
            await notify(`⚠️ <b>2FA temporarily OFF</b> for ${esc(email)}
` +
                         `An enrolment was started, which disables the old code. If you did not ` +
                         `do this, change the password now — the panel is password-only until ` +
                         `the new code is confirmed.`);
          }
          return done('/admin/totp/setup', 'ok',
                      'Scan the code below, then confirm it. 2FA is OFF until you do.');
        } else if (act === 'totp/confirm') {
          const [acc] = await q(`SELECT totp_secret FROM admins WHERE email=?`, [email]);
          if (!acc?.totp_secret) throw new Error('start the enrolment again');
          if (!totpValid(acc.totp_secret, f.get('code'))) throw new Error('that code did not match');
          await q(`UPDATE admins SET totp_enabled=1 WHERE email=?`, [email]);
          await audit(email, 'totp.enabled', null, ip);
          await notify(`🔐 <b>2FA enabled</b> for ${esc(email)}`);
          return done('/admin/settings', 'ok',
                      'Two-factor is on. You will need a code next time you sign in.');
        } else if (act === 'totp/disable') {
          await q(`UPDATE admins SET totp_enabled=0, totp_secret=NULL WHERE email=?`, [email]);
          await audit(email, 'totp.disabled', null, ip);
          await notify(`⚠️ <b>2FA DISABLED</b> for ${esc(email)}`);
          return done('/admin/settings', 'err', 'Two-factor is off.');
        } else {
          return done('/admin', 'err', `Unknown action: ${act}`);
        }
      } catch (e) {
        // A settings save that threw part-way has ALREADY written every key it
        // reached, and they are already live. Record and announce that before
        // reporting the failure, or the operator is told "it did not work"
        // about a change that partly did.
        if (act === 'settings' && typeof changed !== 'undefined' && changed.length) {
          await audit(email, 'settings.change.partial',
                      `APPLIED BEFORE FAILING: ${changed.join('; ')} || failed on: ${e.message}`, ip);
          await notify(`⚠️ <b>Settings change PARTLY applied</b> by ${esc(email)}\n` +
            `These are live now:\n<code>${esc(changed.join('\n'))}</code>\n` +
            `Then it failed: <code>${esc(String(e.message).slice(0, 200))}</code>\n` +
            `The form will show the old values for anything after that point — re-check the page.`
          ).catch(() => {});
        }
        // Errors redirect too. Rendering the error inline would leave the
        // browser on a POST-only URL, and the refresh after reading it would
        // 404 — which is exactly the fault being fixed here.
        const back = act.startsWith('order/') ? '/admin/orders'
                   : act.startsWith('totp/')  ? '/admin/settings'
                   : `/admin/${act}`;
        return done(back, 'err', e.message);
      }
    }

    // ---- views ----
    if (sub === '' || sub === 'dashboard' || path === '/admin') {
      const [[o]] = await pool.query(
        `SELECT COUNT(*) n,
                SUM(status='pending') pending,
                SUM(status='awaiting_delivery') awaiting,
                SUM(status='sending') sending,
                SUM(status='needs_review') review,
                SUM(status='delivered') delivered,
                COALESCE(SUM(CASE WHEN status IN ('awaiting_delivery','delivered','sending')
                     THEN usd END),0) paidUsd
           FROM orders`);
      const lad = await ladder.ladderState();
      let float = null, back = null;
      try { float = await delivery.floatBalance(); } catch {}
      try { back = await backing.headroomPcn(); } catch {}
      const s = settings.all();
      const card = (k, v, sub2, cls = '') =>
        `<div class="card"><div class="k">${k}</div><div class="v ${cls}">${v}</div><div class="s">${sub2}</div></div>`;
      return sendHtml(200, page('Dashboard', '', flash + `
        <div class="grid">
          ${card('Ladder price', '$' + money(lad.marginalPrice ?? 0), `${lad.pctSold.toFixed(2)}% sold`)}
          ${card('Remaining', Math.round(lad.remainingPcn).toLocaleString(), 'of 100,000 PCN')}
          ${card('Reserved', Math.round(lad.reservedPcn).toLocaleString(), 'held by unpaid orders')}
          ${card('Hot wallet', float === null ? '—' : money(float),
                 float === null ? 'node unreachable'
                 : float < s.floatStopPcn ? 'BELOW FLOOR — auto-send off'
                 : float < s.floatWarnPcn ? 'low' : 'ok',
                 float !== null && float < s.floatStopPcn ? 'bad' : float !== null && float < s.floatWarnPcn ? 'warn' : 'ok')}
          ${card('Sellable', back?.pcn == null ? '—' : Math.round(back.pcn).toLocaleString(),
                 back?.pcn == null ? 'balance unreadable — sales paused' : 'PCN backing available',
                 back?.pcn == null ? 'bad' : '')}
          ${card('Awaiting delivery', o.awaiting || 0, 'paid, not sent', (o.awaiting > 0) ? 'warn' : '')}
          ${card('Needs review', o.review || 0, 'look at these', (o.review > 0) ? 'bad' : '')}
          ${card('Paid orders', '$' + Number(o.paidUsd).toFixed(2), `${o.delivered || 0} delivered`)}
        </div>
        <p class="s">Sales are <b>${s.saleOpen ? 'open' : 'CLOSED'}</b> ·
           buyback <b>${s.buybackOpen ? 'open' : 'closed'}</b> ·
           auto-send at or below <b>$${s.autoMaxUsd}</b> ·
           orders $${s.minOrderUsd}–$${s.maxOrderUsd}</p>`, email, csrfTok));
    }

    if (sub === 'orders') {
      const where = [], args = [];
      const st = u.searchParams.get('status'), qy = u.searchParams.get('q');
      if (st) { where.push('status = ?'); args.push(st); }
      if (qy) { where.push('(order_id LIKE ? OR email LIKE ? OR address LIKE ? OR delivered_txid LIKE ?)');
                args.push(`%${qy}%`, `%${qy}%`, `%${qy}%`, `%${qy}%`); }
      const L2 = listQuery(u, {
        table: 'orders', where, args,
        cols: `order_id, email, usd, quoted_pcn, quoted_price, address, status, delivery_mode,
               delivered_txid, delivery_error, created_at, paid_at, delivered_at`,
        sortable: ['created_at', 'paid_at', 'delivered_at', 'usd', 'quoted_pcn', 'status', 'order_id'],
        defaultSort: 'created_at',
      });
      const rows = await q(L2.sql, L2.args);
      const opts = ['', 'pending', 'awaiting_delivery', 'sending', 'delivered', 'needs_review',
                    'expired', 'failed', 'refunded']
        .map(s => `<option value="${s}"${s === st ? ' selected' : ''}>${s || 'any status'}</option>`).join('');
      return sendHtml(200, page('Orders', 'orders', flash + `
        <form class="filters" method="GET">
          <select name="status">${opts}</select>
          <input name="q" placeholder="order, email, address or txid" value="${esc(qy || '')}">
          <input name="per" type="number" min="10" max="200" value="${L2.per}" style="width:80px">
          <button>Filter</button>
          <a class="s" href="/admin/orders">clear</a>
        </form>
        <div class="wrap"><table><thead><tr>
        ${[['order_id', 'Order'], ['created_at', 'Created'], ['paid_at', 'Paid'], ['usd', 'USD'],
           ['quoted_pcn', 'PCN'], ['status', 'Status']]
          .map(([c, l]) => `<th><a href="${sortLink(u, c)}">${l}</a></th>`).join('')}
        <th>To</th><th>Txid</th><th>Actions</th></tr></thead><tbody>
        ${rows.map(o => `<tr>
          <td class="mono">${esc(o.order_id)}</td>
          <td class="s">${o.created_at ? new Date(o.created_at).toISOString().slice(0, 16).replace('T', ' ') : ''}</td>
          <td class="s">${o.paid_at ? new Date(o.paid_at).toISOString().slice(0, 16).replace('T', ' ') : '—'}</td>
          <td>$${Number(o.usd).toFixed(2)}</td>
          <td>${money(o.quoted_pcn)}</td>
          <td>${statusPill(o.status)}${o.delivery_mode ? ` <span class="s">${esc(o.delivery_mode)}</span>` : ''}
              ${o.delivery_error ? `<div class="s bad">${esc(String(o.delivery_error).slice(0, 80))}</div>` : ''}</td>
          <td class="mono s">${esc(String(o.address).slice(0, 18))}…</td>
          <td class="mono s">${o.delivered_txid ? esc(o.delivered_txid.slice(0, 14)) + '…' : '—'}</td>
          <td>${['awaiting_delivery', 'needs_review'].includes(o.status) ? `
            <form class="inline" method="POST" action="/admin/order/send"
                  onsubmit="return confirm(${o.status === 'needs_review'
                    ? `'FLAGGED: ${esc(String(o.delivery_error || 'no reason recorded')).replace(/'/g, '')}\n\nSend ${money(o.quoted_pcn)} PCN anyway?'`
                    : `'Send ${money(o.quoted_pcn)} PCN from the hot wallet?'`})">
              ${csrf}<input type="hidden" name="order_id" value="${esc(o.order_id)}">
              ${o.status === 'needs_review' ? '<input type="hidden" name="reviewed" value="1">' : ''}
              <button>${o.status === 'needs_review' ? 'Send (reviewed)' : 'Send'}</button></form>
            <form class="inline" method="POST" action="/admin/order/deliver">
              ${csrf}<input type="hidden" name="order_id" value="${esc(o.order_id)}">
              <input name="txid" placeholder="txid" size="10" required>
              <button class="ghost">Record</button></form>` : ''}
            ${o.status === 'pending' ? `
            <form class="inline" method="POST" action="/admin/order/expire"
                  onsubmit="return confirm('Expire this order and release its PCN?')">
              ${csrf}<input type="hidden" name="order_id" value="${esc(o.order_id)}">
              <button class="ghost">Expire</button></form>` : ''}
          </td></tr>`).join('')}
        </tbody></table></div>${pager(u, L2.page, rows.length, L2.per)}`, email, csrfTok));
    }

    if (sub === 'ladder') {
      const rows = await q(`SELECT rung_no, price, qty_total, qty_sold, qty_reserved,
                                   (qty_total - qty_sold - qty_reserved) AS qty_left
                              FROM ladder_rungs ORDER BY rung_no`);
      const st2 = await ladder.ladderState();
      return sendHtml(200, page('Ladder', 'ladder', flash + `
        <div class="grid">
          <div class="card"><div class="k">Marginal price</div><div class="v">$${money(st2.marginalPrice ?? 0)}</div><div class="s">published</div></div>
          <div class="card"><div class="k">Next fill</div><div class="v">$${money(st2.nextFillPrice ?? 0)}</div><div class="s">what a buyer pays</div></div>
          <div class="card"><div class="k">Sold</div><div class="v">${Math.round(st2.soldPcn).toLocaleString()}</div><div class="s">${st2.pctSold.toFixed(3)}%</div></div>
          <div class="card"><div class="k">Reserved</div><div class="v">${Math.round(st2.reservedPcn).toLocaleString()}</div><div class="s">unpaid orders</div></div>
        </div>
        <div class="wrap"><table><thead><tr><th>#</th><th>Price</th><th>Total</th><th>Sold</th>
          <th>Reserved</th><th>Left</th></tr></thead><tbody>
        ${rows.map(r => `<tr${Number(r.qty_left) > 0 && Number(r.qty_sold) === 0 ? '' : ' style="opacity:.6"'}>
          <td>${r.rung_no}</td><td>$${money(r.price)}</td><td>${money(r.qty_total)}</td>
          <td>${money(r.qty_sold)}</td><td>${money(r.qty_reserved)}</td>
          <td><b>${money(r.qty_left)}</b></td></tr>`).join('')}
        </tbody></table></div>`, email, csrfTok));
    }

    if (sub === 'fills') {
      const L2 = listQuery(u, {
        table: 'ladder_fills',
        cols: 'id, order_id, rung_no, qty, price, state, created_at, settled_at',
        sortable: ['created_at', 'settled_at', 'qty', 'price', 'rung_no', 'id'],
        defaultSort: 'id',
      });
      const rows = await q(L2.sql, L2.args);
      return sendHtml(200, page('Fills', 'fills', flash + `
        <p class="s">One row per (order, rung). This is the order book of what was actually taken.</p>
        <div class="wrap"><table><thead><tr>
        ${[['id', '#'], ['order_id', 'Order'], ['rung_no', 'Rung'], ['qty', 'PCN'], ['price', 'Price'],
           ['created_at', 'Created'], ['settled_at', 'Settled']]
          .map(([c, l]) => `<th><a href="${sortLink(u, c)}">${l}</a></th>`).join('')}<th>State</th>
        </tr></thead><tbody>
        ${rows.map(r => `<tr><td>${r.id}</td><td class="mono">${esc(r.order_id)}</td>
          <td>${r.rung_no}</td><td>${money(r.qty)}</td><td>$${money(r.price)}</td>
          <td class="s">${new Date(r.created_at).toISOString().slice(0, 16).replace('T', ' ')}</td>
          <td class="s">${r.settled_at ? new Date(r.settled_at).toISOString().slice(0, 16).replace('T', ' ') : '—'}</td>
          <td><span class="pill ${r.state === 'sold' ? 'ok' : r.state === 'released' ? 'bad' : 'warn'}">${r.state}</span></td>
          </tr>`).join('')}
        </tbody></table></div>${pager(u, L2.page, rows.length, L2.per)}`, email, csrfTok));
    }

    if (sub === 'ipn') {
      const L2 = listQuery(u, {
        table: 'ipn_events', cols: 'id, payment_id, order_id, status, received_at',
        sortable: ['id', 'received_at', 'status'], defaultSort: 'id',
      });
      let rows = [];
      try { rows = await q(L2.sql, L2.args); }
      catch { rows = await q(`SELECT id, payment_id, order_id, status FROM ipn_events ORDER BY id DESC LIMIT 100`); }
      return sendHtml(200, page('IPN log', 'ipn', flash + `
        <p class="s">Every callback NOWPayments has delivered. Duplicates are expected — the handler is idempotent.</p>
        <div class="wrap"><table><thead><tr><th>#</th><th>Payment</th><th>Order</th><th>Status</th></tr></thead><tbody>
        ${rows.map(r => `<tr><td>${r.id}</td><td class="mono">${esc(r.payment_id)}</td>
          <td class="mono">${esc(r.order_id || '—')}</td><td>${statusPill(r.status)}</td></tr>`).join('')}
        </tbody></table></div>${pager(u, L2.page, rows.length, L2.per)}`, email, csrfTok));
    }

    if (sub === 'users') {
      const L2 = listQuery(u, {
        table: 'users u', cols: `u.email,
          (SELECT COUNT(*) FROM orders o WHERE o.email=u.email) AS orders,
          (SELECT COALESCE(SUM(o.usd),0) FROM orders o WHERE o.email=u.email
             AND o.status IN ('awaiting_delivery','delivered','sending')) AS spent`,
        sortable: ['u.email', 'orders', 'spent'], defaultSort: 'spent',
      });
      const rows = await q(L2.sql, L2.args);
      return sendHtml(200, page('Users', 'users', flash + `
        <div class="wrap"><table><thead><tr>
        ${[['u.email', 'Email'], ['orders', 'Orders'], ['spent', 'Paid $']]
          .map(([c, l]) => `<th><a href="${sortLink(u, c)}">${l}</a></th>`).join('')}
        </tr></thead><tbody>
        ${rows.map(r => `<tr><td>${esc(r.email)}</td><td>${r.orders}</td>
          <td>$${Number(r.spent).toFixed(2)}</td></tr>`).join('')}
        </tbody></table></div>${pager(u, L2.page, rows.length, L2.per)}`, email, csrfTok));
    }

    // GET: show the pending enrolment. Refreshing this shows the SAME secret,
    // because it reads what is stored rather than generating something new.
    if (sub === 'totp/setup') {
      const [acc] = await q(`SELECT totp_secret, totp_enabled FROM admins WHERE email=?`, [email]);
      if (!acc?.totp_secret || acc.totp_enabled) {
        return done('/admin/settings', 'err',
                    acc?.totp_enabled ? 'Two-factor is already on.' : 'Start the enrolment first.');
      }
      const uri = `otpauth://totp/market.pc.am:${encodeURIComponent(email)}` +
                  `?secret=${acc.totp_secret}&issuer=market.pc.am&period=30&digits=6`;
      // Inline SVG, generated here. Nothing is fetched, so no third party ever
      // sees a secret that is one factor of this panel's login.
      const qr = toSvg(uri, { scale: 6, margin: 3 });
      return sendHtml(200, page('Two-factor', 'settings', flash + `
        <h2>Set up two-factor authentication</h2>
        <p>Scan this with your authenticator app, then type a code back to switch it on.
           You can refresh this page &mdash; the code stays the same until you enrol again.</p>
        <div style="display:flex;gap:24px;flex-wrap:wrap;align-items:flex-start">
          <div class="card" style="background:#fff;padding:10px;line-height:0">${qr}</div>
          <div style="flex:1;min-width:260px">
            <p class="s">Cannot scan? Enter it by hand instead:</p>
            <p class="mono card" style="font-size:15px;letter-spacing:.08em;word-break:break-all">
              ${esc(acc.totp_secret.replace(/(.{4})/g, '$1 ').trim())}</p>
            <p class="s">Account <code>${esc(email)}</code> · issuer <code>market.pc.am</code>
               · time-based · 6 digits · 30 seconds</p>
            <form method="POST" action="/admin/totp/confirm">${csrf}
              <input name="code" inputmode="numeric" autocomplete="one-time-code"
                     placeholder="6-digit code" required>
              <button>Turn on 2FA</button></form>
            <p class="s"><a href="/admin/settings">Back to settings</a></p>
          </div>
        </div>`, email, csrfTok));
    }

    if (sub === 'settings') {
      const [acc] = await q(`SELECT totp_enabled FROM admins WHERE email=?`, [email]);
      const s = settings.all();
      const field = k => {
        const d = settings.defs[k];
        if (d.type === 'bool') {
          return `<input type="hidden" name="present_${k}" value="1">
                  <input type="checkbox" name="s_${k}" value="1"${s[k] ? ' checked' : ''}>`;
        }
        if (d.type === 'list') {
          return `<textarea name="s_${k}" rows="6" style="width:100%;font-family:ui-monospace,monospace;
                    font-size:12px;padding:6px;border:1px solid var(--line);border-radius:7px;
                    background:var(--bg);color:var(--fg)"
                    placeholder="pc1…&#10;pc1…">${esc(s[k])}</textarea>`;
        }
        return `<input name="s_${k}" type="number" step="any" min="${d.min}" max="${d.max}" value="${s[k]}">`;
      };
      return sendHtml(200, page('Settings', 'settings', flash + `
        <h2>Market settings</h2>
        <p class="s">Stored in the database and applied live. <b>serviceRate and the ladder's own
        prices are deliberately not here</b> — they move money in four other products, and belong
        behind the CLI where a mistyped form cannot reach them.</p>
        <form method="POST" action="/admin/settings">${csrf}
        ${Object.keys(settings.defs).map(k => `<div class="set">
          <label for="s_${k}">${esc(settings.defs[k].label)}</label>
          <div>${field(k)}</div>
          <div class="h">${esc(settings.defs[k].help)}</div></div>`).join('')}
        <p><button>Save settings</button></p></form>
        <h2>Two-factor authentication</h2>
        ${acc?.totp_enabled
          ? `<p class="ok">2FA is <b>on</b> for ${esc(email)}.</p>
             <form method="POST" action="/admin/totp/disable"
                   onsubmit="return confirm('Turn OFF two-factor authentication?')">${csrf}
             <button class="ghost">Turn off 2FA</button></form>`
          : `<p class="bad">2FA is <b>off</b>. Anyone with the password can sign in.</p>
             <form method="POST" action="/admin/totp/enrol">${csrf}<button>Set up 2FA</button></form>`}
        <h2>Password</h2>
        <p class="s">Changed from the host, never from a browser and never from a message:
        <code>market-admin set-password ${esc(email)}</code></p>`, email, csrfTok));
    }

    if (sub === 'audit') {
      const L2 = listQuery(u, {
        table: 'admin_audit', cols: 'id, email, action, detail, ip, at',
        sortable: ['id', 'at', 'action', 'email'], defaultSort: 'id',
      });
      const rows = await q(L2.sql, L2.args);
      return sendHtml(200, page('Audit', 'audit', flash + `
        <div class="wrap"><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th><th>IP</th>
        </tr></thead><tbody>
        ${rows.map(r => `<tr><td class="s">${new Date(r.at).toISOString().slice(0, 19).replace('T', ' ')}</td>
          <td>${esc(r.email)}</td><td class="mono">${esc(r.action)}</td>
          <td class="s">${esc(String(r.detail || '').slice(0, 120))}</td>
          <td class="mono s">${esc(r.ip || '')}</td></tr>`).join('')}
        </tbody></table></div>${pager(u, L2.page, rows.length, L2.per)}`, email, csrfTok));
    }

    return sendHtml(404, page('Not found', '', '<p>No such page.</p>', email, csrfTok));
  }

  return { handle, ensureTable, setPassword, audit };
}
