// The owner's window into the bot, for admin.pc.am (2026-09-24).
//
// LOOPBACK ONLY, AND A BEARER TOKEN ON TOP. The container runs --network host,
// so 127.0.0.1 here is the host's loopback: the admin panel on the same box can
// reach it and nothing outside can. The token (ADMIN_API_TOKEN) is the second
// lock, for anything else that runs on this host.
//
// It is NOT the public API the owner declined. It lists users, shows a user's
// ledger, and credits a balance -- nothing a customer would call.
//
// A CREDIT GOES THROUGH THE LEDGER, never a bare UPDATE of the balance: the
// watcher checks SUM(ledger) == balance + reserved every tick, and a balance
// that moved without a row is exactly the drift that check exists to catch.
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { immediate } from './db.mjs';
import { nowSec } from './time.mjs';
import { log, errFields } from './log.mjs';

// One credit is capped so a typo (10000 for 100) cannot mint a fortune. Bigger
// amounts are several credits, each deliberate.
export const MAX_CREDIT_MICRO = 1000n * 1000000n; // $1,000

export class CreditRefused extends Error {}

// Credit a user's balance. `requestId` makes it idempotent: the panel mints one
// per form, so a double-submit or a retried POST credits once.
export function adminCredit(db, { chatId, microUsd, note, requestId }) {
  const amount = BigInt(microUsd);
  if (amount <= 0n) throw new CreditRefused('the amount must be positive');
  if (amount > MAX_CREDIT_MICRO) throw new CreditRefused('one credit is at most $1,000');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(String(requestId || ''))) throw new CreditRefused('a request id is required');
  const text = String(note || '').trim().slice(0, 200);
  if (!text) throw new CreditRefused('say what the credit is for');
  const key = `admin:${requestId}`;

  return immediate(db, () => {
    const u = db.prepare('SELECT chat_id FROM users WHERE chat_id = ?').get(chatId);
    if (!u) throw new CreditRefused(`no user ${chatId}: they must have started the bot first`);
    const prior = db.prepare('SELECT chat_id, delta_micro_usd FROM ledger WHERE idem_key = ?').get(key);
    if (prior) {
      const bal = db.prepare('SELECT balance_micro_usd b FROM users WHERE chat_id = ?').get(prior.chat_id).b;
      return { duplicate: true, chatId: prior.chat_id, microUsd: prior.delta_micro_usd, balance: bal };
    }
    db.prepare(
      `INSERT INTO ledger (chat_id, delta_micro_usd, kind, idem_key, note, created_at)
       VALUES (?,?,?,?,?,?)`
    ).run(chatId, Number(amount), 'adjust', key, `owner credit (admin panel): ${text}`, nowSec());
    db.prepare('UPDATE users SET balance_micro_usd = balance_micro_usd + ? WHERE chat_id = ?')
      .run(Number(amount), chatId);
    const bal = db.prepare('SELECT balance_micro_usd b FROM users WHERE chat_id = ?').get(chatId).b;
    return { duplicate: false, chatId, microUsd: Number(amount), balance: bal };
  });
}

// Every user with the figures the owner asks about. Sums come from the ledger
// rows, not from counters, for the same reason reconcile() does.
export function listUsers(db) {
  return db.prepare(
    `SELECT u.chat_id, u.balance_micro_usd, u.reserved_micro_usd, u.created_at,
            COALESCE(SUM(CASE WHEN l.kind = 'ai_turn' THEN -l.delta_micro_usd END), 0) AS spent_micro_usd,
            COALESCE(SUM(CASE WHEN l.kind IN ('deposit_pcn','deposit_wpcn','deposit_stars') THEN l.delta_micro_usd END), 0) AS deposited_micro_usd,
            COALESCE(SUM(CASE WHEN l.kind = 'deposit_stars' THEN l.delta_micro_usd END), 0) AS stars_micro_usd,
            COALESCE(SUM(CASE WHEN l.kind = 'adjust' THEN l.delta_micro_usd END), 0) AS credited_micro_usd,
            COALESCE(SUM(CASE WHEN l.kind = 'gift' THEN l.delta_micro_usd END), 0) AS gift_micro_usd,
            COALESCE(SUM(CASE WHEN l.kind = 'referral' THEN l.delta_micro_usd END), 0) AS referral_micro_usd,
            COUNT(CASE WHEN l.kind = 'ai_turn' THEN 1 END) AS turns,
            MAX(CASE WHEN l.kind = 'ai_turn' THEN l.created_at END) AS last_turn_at,
            u.lang,
            (SELECT r.referrer_chat_id FROM referrals r WHERE r.referred_chat_id = u.chat_id) AS invited_by
       FROM users u LEFT JOIN ledger l ON l.chat_id = u.chat_id
      GROUP BY u.chat_id
      ORDER BY u.created_at DESC`
  ).all();
}

// Every invite: who invited whom, and whether it has paid.
export function listReferrals(db, limit = 200) {
  return db.prepare(
    `SELECT id, referrer_chat_id, referred_chat_id, status, reward_micro_usd, trigger_item_id, void_reason, created_at, rewarded_at
       FROM referrals ORDER BY id DESC LIMIT ?`
  ).all(Math.min(1000, Math.max(1, Number(limit) || 200)));
}

export function userLedger(db, chatId, limit = 50) {
  return db.prepare(
    `SELECT id, delta_micro_usd, kind, note, created_at FROM ledger
      WHERE chat_id = ? ORDER BY id DESC LIMIT ?`
  ).all(chatId, limit);
}

function tokenOk(header, token) {
  const m = /^Bearer (.+)$/.exec(String(header || ''));
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Serialised BEFORE the headers go out: a value JSON cannot write (a BigInt, 2026-09-26) used to
// fail after writeHead, and the error handler's own reply then threw "headers already sent" and
// left the request hanging. Money amounts here are micro-USD, well inside a safe integer.
const json = (res, code, body) => {
  const text = JSON.stringify(body, (k, v) => (typeof v === 'bigint' ? Number(v) : v));
  if (res.headersSent) { res.end(); return; }
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(text);
};

// 64 KB: the chat agent's instructions travel through here (at most 20,000 characters).
const readJson = (req) => new Promise((resolve, reject) => {
  let n = 0; const parts = [];
  req.on('data', (c) => { n += c.length; if (n > 65536) { reject(new Error('body too large')); req.destroy(); } else parts.push(c); });
  req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')); } catch (e) { reject(e); } });
  req.on('error', reject);
});

// `names(chatIds)` resolves Telegram display names; best effort, never fatal.
// `studio` = { get, save, preview, jobs, test }: every setting of the chat agent and the builder
// (owner, 2026-09-26). The bot validates a save against what OonaCode serves, and tests a new chat
// model live before accepting it. `stars` = { get, refund }: Telegram Stars payments.
export function startAdminApi({ db, token, port, host = '127.0.0.1', names = async () => ({}), studio = null, stars = null }) {
  if (!token || token.length < 32) {
    log.warn('admin API off: ADMIN_API_TOKEN is unset or shorter than 32 characters');
    return null;
  }
  const server = createServer(async (req, res) => {
    try {
      if (!tokenOk(req.headers.authorization, token)) return json(res, 401, { error: 'unauthorized' });
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && url.pathname === '/admin/users') {
        const users = listUsers(db);
        const nm = await names(users.map((u) => u.chat_id)).catch(() => ({}));
        return json(res, 200, { users: users.map((u) => ({ ...u, name: nm[u.chat_id] ?? null })) });
      }
      if (req.method === 'GET' && url.pathname === '/admin/referrals') {
        const rows = listReferrals(db, Number(url.searchParams.get('limit') || 200));
        const ids = [...new Set(rows.flatMap((r) => [r.referrer_chat_id, r.referred_chat_id]))];
        const nm = await names(ids).catch(() => ({}));
        return json(res, 200, { referrals: rows, names: nm });
      }
      if (req.method === 'GET' && url.pathname === '/admin/ledger') {
        const chatId = Number(url.searchParams.get('chat_id'));
        if (!Number.isSafeInteger(chatId)) return json(res, 400, { error: 'chat_id required' });
        return json(res, 200, { ledger: userLedger(db, chatId) });
      }
      if (req.method === 'POST' && url.pathname === '/admin/credit') {
        const b = await readJson(req);
        const chatId = Number(b.chat_id);
        if (!Number.isSafeInteger(chatId)) return json(res, 400, { error: 'chat_id required' });
        if (!/^\d+$/.test(String(b.micro_usd ?? ''))) return json(res, 400, { error: 'micro_usd must be a whole number' });
        try {
          const r = adminCredit(db, { chatId, microUsd: b.micro_usd, note: b.note, requestId: b.request_id });
          log.info('admin credit', { chat: chatId, micro_usd: r.microUsd, duplicate: r.duplicate });
          return json(res, 200, r);
        } catch (e) {
          if (e instanceof CreditRefused) return json(res, 422, { error: e.message });
          throw e;
        }
      }
      if (studio && req.method === 'GET' && url.pathname === '/admin/settings') {
        return json(res, 200, studio.get());
      }
      if (studio && req.method === 'POST' && url.pathname === '/admin/settings') {
        const b = await readJson(req);
        const r = await studio.save(b && typeof b === 'object' ? b : {});
        log.info('admin settings', { ok: r.ok, problems: r.ok ? '-' : r.problems.join(' | ') });
        return json(res, r.ok ? 200 : 422, r.ok ? r : { error: r.problems.join('; '), problems: r.problems });
      }
      if (studio && req.method === 'GET' && url.pathname === '/admin/preview') {
        const chatId = Number(url.searchParams.get('chat_id'));
        if (!Number.isSafeInteger(chatId)) return json(res, 400, { error: 'chat_id required' });
        const r = studio.preview({ chatId, text: String(url.searchParams.get('text') || '').slice(0, 2000) });
        return json(res, r.error ? 404 : 200, r);
      }
      if (studio && req.method === 'GET' && url.pathname === '/admin/jobs') {
        return json(res, 200, { jobs: studio.jobs(Number(url.searchParams.get('limit') || 50)) });
      }
      if (studio && req.method === 'POST' && url.pathname === '/admin/test-chat') {
        const b = await readJson(req);
        return json(res, 200, await studio.test(String(b?.model || '')));
      }
      if (stars && req.method === 'GET' && url.pathname === '/admin/stars') {
        return json(res, 200, await stars.get());
      }
      if (stars && req.method === 'POST' && url.pathname === '/admin/stars/refund') {
        const b = await readJson(req);
        const paymentId = Number(b?.payment_id);
        if (!Number.isSafeInteger(paymentId)) return json(res, 400, { error: 'payment_id required' });
        const r = await stars.refund({ paymentId, note: String(b?.note || '').slice(0, 200) });
        log.info('admin stars refund', { payment: paymentId, ok: r.ok, err: r.error ?? '-' });
        return json(res, r.ok ? 200 : 422, r);
      }
      return json(res, 404, { error: 'not found' });
    } catch (e) {
      log.error('admin API request failed', errFields(e));
      return json(res, 500, { error: 'internal error' });
    }
  });
  server.on('error', (e) => log.error('admin API listener failed', errFields(e)));
  server.listen(port, host, () => log.info('admin API listening', { host, port }));
  return server;
}
