// Tests for email-verify.mjs. Run: node email-verify-test.mjs
//
// Pure, same harness as password-reset-test.mjs: a fake pool that understands
// exactly the queries email-verify.mjs sends, a fake mailer that records, and a
// hand-moved clock. Asserted directly: a link works once and only within 24
// hours, an unknown or already-confirmed email gets the same answer, only NEW
// accounts are refused at sign-in, and a failed read never counts as confirmed.

import { makeEmailVerify, PER_EMAIL_PER_HOUR, PER_IP_PER_HOUR, LINK_HOURS } from './email-verify.mjs';

let pass = 0, fail = 0;
const ok = (name, got, want) => {
  const good = JSON.stringify(got) === JSON.stringify(want);
  good ? pass++ : fail++;
  console.log(`  ${good ? 'ok  ' : 'FAIL'} ${name}${good ? '' : `\n         got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

const VALID_EMAIL = /^[^@\s|]+@[^@\s|]+\.[^@\s|]+$/;

function fakeDb({ schema = true } = {}) {
  const db = { users: new Map(), links: new Map(), failNext: false };
  db.users.set('old@example.com', { req: 0, v: null });   // opened before this went live
  db.users.set('new@example.com', { req: 1, v: null });   // opened after
  db.users.set('done@example.com', { req: 1, v: 123 });   // already confirmed
  const query = async (sql, a = []) => {
    if (db.failNext) { db.failNext = false; throw new Error('db down'); }
    if (/LIMIT 0/.test(sql)) { if (!schema) throw new Error("Unknown column 'email_verified_at'"); return [[]]; }
    if (/^SELECT email_verified_at AS v FROM users/.test(sql)) {
      const u = db.users.get(a[0]); return [u ? [{ v: u.v }] : []];
    }
    if (/^SELECT verify_required AS r, email_verified_at AS v FROM users/.test(sql)) {
      const u = db.users.get(a[0]); return [u ? [{ r: u.req, v: u.v }] : []];
    }
    if (/^SELECT COUNT\(\*\) AS n FROM email_verifications/.test(sql)) {
      return [[{ n: [...db.links.values()].filter(r => r.email === a[0] && r.created_ms > a[1]).length }]];
    }
    if (/^INSERT INTO email_verifications/.test(sql)) {
      db.links.set(a[0], { token_hash: a[0], email: a[1], created_ms: a[2], expires_ms: a[3], used_ms: null });
      return [{ affectedRows: 1 }];
    }
    if (/^SELECT token_hash, email, expires_ms, used_ms FROM email_verifications/.test(sql)) {
      const r = db.links.get(a[0]); return [r ? [{ ...r }] : []];
    }
    if (/^UPDATE users SET email_verified_at = COALESCE/.test(sql)) {
      const u = db.users.get(a[1]); if (!u) return [{ affectedRows: 0 }];
      if (u.v === null) u.v = a[0]; return [{ affectedRows: 1 }];
    }
    if (/^UPDATE email_verifications SET used_ms/.test(sql)) {
      let n = 0;
      for (const r of db.links.values()) if (r.email === a[2] && r.used_ms === null) { r.used_ms = a[0]; n++; }
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
  const mailer = mail ? { from: 'pcoinpcn@gmail.com', send: async m => { sent.push(m); return { ok: true }; } } : null;
  const EV = makeEmailVerify({ pool: db.pool, validEmail: VALID_EMAIL, mailer,
    notify: async m => { alerts.push(m); }, now: () => t, log: { log() {}, warn() {}, error() {} } });
  return { db, EV, sent, alerts, tick: ms => { t += ms; } };
}
const flush = () => new Promise(r => setImmediate(r));
const tokenFrom = m => /#verify=([A-Za-z0-9_-]{43})/.exec(m.text)?.[1];

console.log('\nswitched off until both halves exist');
{
  const a = setup({ schema: false }); await a.EV.init();
  ok('no schema -> send 503', (await a.EV.send('new@example.com', '1.1.1.1')).status, 503);
  ok('no schema -> confirm 503', (await a.EV.confirm('x'.repeat(43), '1.1.1.1')).status, 503);
  ok('no schema -> nobody refused at sign-in', await a.EV.mustConfirmToSignIn('new@example.com'), false);
  ok('no schema -> not verified (fail closed)', await a.EV.isVerified('done@example.com'), false);
  const b = setup({ mail: false }); await b.EV.init();
  ok('no mailer -> not enabled', b.EV.enabled(), false);
  ok('no mailer -> send 503', (await b.EV.send('new@example.com', '1.1.1.1')).status, 503);
}

console.log('\na database blip at startup does not leave it off');
{
  const a = setup(); a.db.failNext = true; await a.EV.init();
  ok('blip -> off', a.EV.enabled(), false);
  ok('ensure() within 30 s does not re-probe', [await a.EV.ensure(), a.EV.enabled()], [false, false]);
  a.tick(30_001);
  ok('ensure() later re-probes and turns it on', [await a.EV.ensure(), a.EV.enabled()], [true, true]);
  const b = setup(); b.db.failNext = true; await b.EV.init(); b.tick(30_001);
  ok('sign-in check re-probes on its own, so a new account is still refused', await b.EV.mustConfirmToSignIn('new@example.com'), true);
}

console.log('\nwho must confirm to sign in');
{
  const a = setup(); await a.EV.init();
  ok('new unconfirmed account -> refused', await a.EV.mustConfirmToSignIn('new@example.com'), true);
  ok('old account -> not refused', await a.EV.mustConfirmToSignIn('old@example.com'), false);
  ok('new confirmed account -> not refused', await a.EV.mustConfirmToSignIn('done@example.com'), false);
  ok('unknown -> not refused here (password check decides)', await a.EV.mustConfirmToSignIn('x@example.com'), false);
  a.db.failNext = true;
  let threw = false; try { await a.EV.mustConfirmToSignIn('new@example.com'); } catch { threw = true; }
  ok('failed read -> throws (500), never lets in', threw, true);
  a.db.failNext = true;
  ok('failed read -> isVerified false', await a.EV.isVerified('done@example.com'), false);
}

console.log('\nsending links: same answer for everyone');
{
  const a = setup(); await a.EV.init();
  const r1 = await a.EV.send('new@example.com', '1.1.1.1'); await flush();
  const r2 = await a.EV.send('nobody@example.com', '1.1.1.2'); await flush();
  const r3 = await a.EV.send('done@example.com', '1.1.1.3'); await flush();
  ok('known/unknown/confirmed answer identically', [r1, r2, r3].map(r => JSON.stringify(r)).every(s => s === JSON.stringify(r1)), true);
  ok('only the unconfirmed account got mail', a.sent.map(m => m.to), ['new@example.com']);
  ok('link points at the market fragment', /https:\/\/market\.pc\.am\/#verify=/.test(a.sent[0].text), true);
  ok('bad email -> 400', (await a.EV.send('not-an-email', '1.1.1.4')).status, 400);
  for (let i = 0; i < PER_EMAIL_PER_HOUR + 2; i++) await a.EV.send('new@example.com', '9.9.9.' + i);
  await flush();
  ok(`at most ${PER_EMAIL_PER_HOUR} links an hour per account`, a.sent.filter(m => m.to === 'new@example.com').length, PER_EMAIL_PER_HOUR);
  const b = setup(); await b.EV.init();
  let last;
  for (let i = 0; i <= PER_IP_PER_HOUR; i++) last = await b.EV.send(`u${i}@example.com`, '7.7.7.7');
  ok(`connection limited after ${PER_IP_PER_HOUR}`, last.status, 429);
}

console.log('\nconfirming');
{
  const a = setup(); await a.EV.init();
  await a.EV.send('new@example.com', '1.1.1.1'); await flush();
  const tok = tokenFrom(a.sent[0]);
  ok('token mailed', typeof tok, 'string');
  ok('only the hash is stored', [...a.db.links.keys()].includes(tok), false);
  const c = await a.EV.confirm(tok, '1.1.1.1');
  ok('confirm -> 200 with email', [c.status, c.email], [200, 'new@example.com']);
  ok('account now verified', await a.EV.isVerified('new@example.com'), true);
  ok('account no longer refused at sign-in', await a.EV.mustConfirmToSignIn('new@example.com'), false);
  ok('same link twice -> 400', (await a.EV.confirm(tok, '1.1.1.1')).status, 400);
  ok('garbage token -> 400', (await a.EV.confirm('nope', '1.1.1.1')).status, 400);

  const b = setup(); await b.EV.init();
  await b.EV.send('new@example.com', '1.1.1.1'); await flush();
  b.tick(LINK_HOURS * 3_600_000 + 1);
  ok('expired link -> 400', (await b.EV.confirm(tokenFrom(b.sent[0]), '1.1.1.1')).status, 400);
  ok('still unverified after expired link', await b.EV.isVerified('new@example.com'), false);

  const c2 = setup(); await c2.EV.init();
  await c2.EV.send('new@example.com', '1.1.1.1'); await c2.EV.send('new@example.com', '1.1.1.1'); await flush();
  await c2.EV.confirm(tokenFrom(c2.sent[1]), '1.1.1.1');
  ok('using one link voids the other', (await c2.EV.confirm(tokenFrom(c2.sent[0]), '1.1.1.1')).status, 400);
}

console.log('\npassword reset counts as confirmation');
{
  const a = setup(); await a.EV.init();
  await a.EV.markVerified('old@example.com');
  ok('markVerified sets it', await a.EV.isVerified('old@example.com'), true);
  const before = a.db.users.get('done@example.com').v;
  await a.EV.markVerified('done@example.com');
  ok('keeps the FIRST confirmation time', a.db.users.get('done@example.com').v, before);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
