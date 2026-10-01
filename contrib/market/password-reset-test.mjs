// Tests for password-reset.mjs and mailer.mjs. Run: node password-reset-test.mjs
//
// Pure: a fake pool that understands exactly the queries password-reset.mjs
// sends, a fake mailer that records instead of sending, and a clock we move by
// hand. What matters most is asserted directly: a link works once and only
// within its window, an unknown email gets the same answer as a known one, a
// reset ends the sessions that existed before it, and "could not check" never
// reads as "still signed in".

import { makePasswordReset, hashToken, PER_EMAIL_PER_HOUR, PER_IP_PER_HOUR } from './password-reset.mjs';
import { buildMessage, makeMailer } from './mailer.mjs';

let pass = 0, fail = 0;
const ok = (name, got, want) => {
  const good = JSON.stringify(got) === JSON.stringify(want);
  good ? pass++ : fail++;
  console.log(`  ${good ? 'ok  ' : 'FAIL'} ${name}${good ? '' : `\n         got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

const VALID_EMAIL = /^[^@\s|]+@[^@\s|]+\.[^@\s|]+$/;
const hashPw = (pw, salt) => `h(${pw},${salt})`;
const SESSION_MS = 7 * 864e5;

function fakeDb({ schema = true } = {}) {
  const db = { users: new Map(), resets: new Map(), failNext: false };
  db.users.set('alice@example.com', { salt: 's0', hash: 'h0', sva: null });
  const query = async (sql, a = []) => {
    if (db.failNext) { db.failNext = false; throw new Error('db down'); }
    if (/LIMIT 0/.test(sql)) { if (!schema) throw new Error("Unknown column 'sessions_valid_after'"); return [[]]; }
    if (/^SELECT sessions_valid_after AS v FROM users/.test(sql)) {
      const u = db.users.get(a[0]); return [u ? [{ v: u.sva }] : []];
    }
    if (/^SELECT email FROM users/.test(sql)) return [db.users.has(a[0]) ? [{ email: a[0] }] : []];
    if (/^SELECT COUNT\(\*\) AS n FROM password_resets/.test(sql)) {
      return [[{ n: [...db.resets.values()].filter(r => r.email === a[0] && r.created_ms > a[1]).length }]];
    }
    if (/^INSERT INTO password_resets/.test(sql)) {
      db.resets.set(a[0], { token_hash: a[0], email: a[1], created_ms: a[2], expires_ms: a[3], used_ms: null, request_ip: a[4] });
      return [{ affectedRows: 1 }];
    }
    if (/^SELECT token_hash, email, expires_ms, used_ms FROM password_resets/.test(sql)) {
      const r = db.resets.get(a[0]); return [r ? [{ ...r }] : []];
    }
    if (/^UPDATE users SET salt/.test(sql)) {
      const u = db.users.get(a[3]); if (!u) return [{ affectedRows: 0 }];
      Object.assign(u, { salt: a[0], hash: a[1], sva: a[2] }); return [{ affectedRows: 1 }];
    }
    if (/^UPDATE password_resets SET used_ms/.test(sql)) {
      let n = 0;
      for (const r of db.resets.values()) if (r.email === a[2] && r.used_ms === null) { r.used_ms = a[0]; r.used_ip = a[1]; n++; }
      return [{ affectedRows: n }];
    }
    throw new Error('fake db: unexpected query ' + sql);
  };
  db.pool = {
    query,
    getConnection: async () => ({ query, beginTransaction: async () => {}, commit: async () => {},
      rollback: async () => {}, release: () => {} }),
  };
  return db;
}

function setup({ schema = true, mail = true } = {}) {
  const db = fakeDb({ schema });
  const sent = [], alerts = [];
  let t = 1_790_000_000_000;
  const mailer = mail ? { from: 'noreply@pc.am', send: async m => { sent.push(m); return { ok: true }; } } : null;
  const PR = makePasswordReset({ pool: db.pool, hashPw, validEmail: VALID_EMAIL, mailer, sessionMs: SESSION_MS,
    notify: async m => { alerts.push(m); }, now: () => t, log: { log() {}, warn() {}, error() {} } });
  return { db, PR, sent, alerts, tick: ms => { t += ms; }, now: () => t };
}
const flush = () => new Promise(r => setImmediate(r));
const tokenFrom = m => /#reset=([A-Za-z0-9_-]{43})/.exec(m.text)?.[1];

console.log('\nswitched off until both halves exist');
{
  const a = setup({ schema: false }); await a.PR.init();
  ok('no schema -> request 503', (await a.PR.request('alice@example.com', '1.1.1.1')).status, 503);
  ok('no schema -> reset 503', (await a.PR.reset('x'.repeat(43), 'longenough', '1.1.1.1')).status, 503);
  ok('no schema -> sessions not checked (nobody signed out by a deploy)', await a.PR.sessionStillValid('alice@example.com', 0), true);
  const b = setup({ mail: false }); await b.PR.init();
  ok('no mailer -> enabled() false', b.PR.enabled(), false);
  ok('no mailer -> request 503', (await b.PR.request('alice@example.com', '1.1.1.1')).status, 503);
}

console.log('\nasking for a link');
{
  const a = setup(); await a.PR.init();
  const known = await a.PR.request('  Alice@Example.com ', '1.1.1.1');
  const unknown = await a.PR.request('nobody@example.com', '1.1.1.2');
  await flush();
  ok('known email -> 200', known.status, 200);
  ok('unknown email -> the SAME answer', JSON.stringify(unknown), JSON.stringify(known));
  ok('one mail, to the known account only', a.sent.map(m => m.to), ['alice@example.com']);
  const tok = tokenFrom(a.sent[0]);
  ok('link carries the token in the FRAGMENT', a.sent[0].text.includes('https://market.pc.am/#reset=' + tok), true);
  ok('only the token HASH is stored', a.db.resets.has(hashToken(tok)) && !a.db.resets.has(tok), true);
  ok('bad email format -> 400', (await a.PR.request('not-an-email', '1.1.1.3')).status, 400);
  ok('email with | -> 400', (await a.PR.request('a|b@example.com', '1.1.1.3')).status, 400);
}

console.log('\nlimits');
{
  const a = setup(); await a.PR.init();
  for (let i = 0; i < PER_EMAIL_PER_HOUR + 2; i++) await a.PR.request('alice@example.com', `2.2.2.${i}`);
  await flush();
  ok(`at most ${PER_EMAIL_PER_HOUR} mails an hour per account`, a.sent.length, PER_EMAIL_PER_HOUR);
  ok('the capped requests still answer 200 (no tell)', (await a.PR.request('alice@example.com', '2.2.2.99')).status, 200);
  a.tick(3_600_001);
  await a.PR.request('alice@example.com', '2.2.2.50'); await flush();
  ok('an hour later, one more is allowed', a.sent.length, PER_EMAIL_PER_HOUR + 1);
  const b = setup(); await b.PR.init();
  let last;
  for (let i = 0; i < PER_IP_PER_HOUR + 1; i++) last = await b.PR.request(`x${i}@example.com`, '3.3.3.3');
  ok(`request ${PER_IP_PER_HOUR + 1} from one connection -> 429`, last.status, 429);
}

console.log('\nspending a link');
{
  const a = setup(); await a.PR.init();
  const sessionBefore = a.now() + SESSION_MS;            // a session minted now
  ok('existing session valid before any reset', await a.PR.sessionStillValid('alice@example.com', sessionBefore), true);
  await a.PR.request('alice@example.com', '4.4.4.4');
  a.tick(1000);
  await a.PR.request('alice@example.com', '4.4.4.4'); await flush();
  const [t1, t2] = a.sent.map(tokenFrom);
  ok('malformed token -> 400', (await a.PR.reset('short', 'newpassword', '4.4.4.4')).status, 400);
  ok('unknown token -> 400', (await a.PR.reset('A'.repeat(43), 'newpassword', '4.4.4.4')).status, 400);
  ok('short password -> 400 and the link survives', (await a.PR.reset(t1, 'short', '4.4.4.4')).status, 400);
  a.tick(5000);
  const r = await a.PR.reset(t1, 'newpassword', '4.4.4.5');
  await flush();
  ok('valid link -> 200 with the email', [r.status, r.email], [200, 'alice@example.com']);
  const u = a.db.users.get('alice@example.com');
  ok('password hash replaced, with a new salt', u.hash === hashPw('newpassword', u.salt) && u.salt !== 's0', true);
  ok('same link again -> 400 (works once)', (await a.PR.reset(t1, 'another-one', '4.4.4.5')).status, 400);
  ok('the OTHER open link was voided too', (await a.PR.reset(t2, 'another-one', '4.4.4.5')).status, 400);
  ok('session minted before the reset -> signed out', await a.PR.sessionStillValid('alice@example.com', sessionBefore), false);
  ok('session minted after the reset -> fine', await a.PR.sessionStillValid('alice@example.com', a.now() + SESSION_MS), true);
  ok('ops chat told', a.alerts.some(m => m.includes('Password reset') && m.includes('alice@example.com')), true);
  ok('"your password was changed" mail sent', a.sent.some(m => m.subject === 'Your PCoin password was changed'), true);
}

console.log('\nexpiry, and reads that fail');
{
  const a = setup(); await a.PR.init();
  await a.PR.request('alice@example.com', '5.5.5.5'); await flush();
  const tok = tokenFrom(a.sent[0]);
  a.tick(30 * 60_000);
  ok('at exactly 30 minutes -> expired', (await a.PR.reset(tok, 'newpassword', '5.5.5.5')).status, 400);
  ok('password untouched', a.db.users.get('alice@example.com').hash, 'h0');
  a.db.failNext = true;
  ok('session check that cannot read -> NOT valid', await a.PR.sessionStillValid('alice@example.com', a.now() + SESSION_MS), false);
  ok('session for an account that no longer exists -> not valid', await a.PR.sessionStillValid('gone@example.com', a.now() + SESSION_MS), false);
}

console.log('\nmail message');
{
  const m = buildMessage({ from: 'noreply@pc.am', name: 'PCoin', to: 'a@b.co', subject: 'Hi', text: 'line one\n.dot line\nend',
    now: new Date(0), id: 'abc' });
  ok('CRLF line endings', m.includes('line one\r\n..dot line\r\nend\r\n'), true);
  ok('leading dot doubled', m.includes('\r\n..dot line'), true);
  ok('headers then a blank line', m.split('\r\n\r\n')[0].includes('Subject: Hi'), true);
  const threw = f => { try { f(); return false; } catch { return true; } };
  ok('CR/LF in the recipient refused', threw(() => buildMessage({ from: 'noreply@pc.am', to: 'a@b.co\r\nBcc: x@y.z', subject: 's', text: '' })), true);
  ok('CR/LF in the subject refused', threw(() => buildMessage({ from: 'noreply@pc.am', to: 'a@b.co', subject: 's\r\nBcc: x@y.z', text: '' })), true);
  ok('non-ASCII subject is encoded', /Subject: =\?UTF-8\?B\?/.test(buildMessage({ from: 'noreply@pc.am', to: 'a@b.co', subject: 'Пароль', text: '' })), true);
  ok('no mail block -> no mailer', makeMailer(undefined), null);
  ok('no netrc -> no mailer (never a password in config)', makeMailer({ url: 'smtps://x:465', from: 'a@b.co' }), null);
  let seen;
  const mm = makeMailer({ url: 'smtps://smtp.zoho.com:465', from: 'noreply@pc.am', netrc: '/etc/pcoin/n' },
    { run: async (args, input) => { seen = { args, input }; return { ok: true }; }, log: { error() {} } });
  ok('send resolves ok', await mm.send({ to: 'a@b.co', subject: 's', text: 't' }), { ok: true });
  ok('password comes from the netrc file, not argv', seen.args.includes('--netrc-file') && !seen.args.some(x => /pass/i.test(x)), true);
  ok('recipient passed as its own argument', seen.args[seen.args.indexOf('--mail-rcpt') + 1], 'a@b.co');
  ok('bad recipient -> {ok:false}, no throw', (await mm.send({ to: 'x\n@y.z', subject: 's', text: 't' })).ok, false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
