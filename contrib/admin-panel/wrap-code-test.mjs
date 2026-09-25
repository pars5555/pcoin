// node contrib/admin-panel/wrap-code-test.mjs
// The wrap desk's money buttons (Send: wPCN from the keeper; Refund: PCN from
// market-hot) need a FRESH authenticator code, not just a signed-in session
// (owner, 2026-09-25). This runs the real server.mjs, signs in with a throwaway
// credential, and proves the guard FIRES: no code and a wrong code are refused
// before the send is even attempted, and the right code gets past it (on this
// machine the send itself then fails for want of a watcher -- which is the
// proof that the guard, not the environment, stopped the first two).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword, newTotpSecret, totpAt } from './auth.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), 'wrapcode-'));
mkdirSync(join(TMP, 'data'));
const IP = '46.182.172.50';
writeFileSync(join(TMP, 'allowed-ips.json'), JSON.stringify({ ips: [{ ip: IP, label: 'home' }] }));
const SECRET = newTotpSecret();
writeFileSync(join(TMP, 'credential.json'), JSON.stringify({ username: 'admin', ...hashPassword('pw-test'), totp: SECRET, totpEnabled: true }));
const code = () => totpAt(SECRET, Math.floor(Date.now() / 30000));
const port = await new Promise((r) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const srv = spawn(process.execPath, [join(HERE, 'server.mjs')], { cwd: HERE, stdio: ['ignore', 'pipe', 'pipe'], env: {
  ...process.env, ADMIN_PORT: String(port), ADMIN_ROOT: '1', ADMIN_PREFIX: '', ADMIN_DATA: join(TMP, 'data'),
  ADMIN_CRED: join(TMP, 'credential.json'), ADMIN_SESSION_FILE: join(TMP, 'sessions.json'),
  ADMIN_ALLOW_FILE: join(TMP, 'allowed-ips.json'), ADMIN_INGEST: join(TMP, 'ingest.json') } });
let log = ''; srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
const post = (path, form, cookie = '') => new Promise((resolve, reject) => {
  const body = new URLSearchParams(form).toString();
  const req = request({ host: '127.0.0.1', port, path, method: 'POST', headers: {
    'x-forwarded-for': IP, 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body),
    ...(cookie ? { cookie } : {}) } }, (res) => {
    let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ code: res.statusCode, body: b, headers: res.headers }));
  });
  req.on('error', reject); req.end(body);
});
for (let i = 0; i < 50 && !/pcoin-admin on/.test(log); i++) await new Promise((r) => setTimeout(r, 100));

let n = 0;
const check = async (name, fn) => { await fn(); n += 1; console.log('  ok  ', name); };
const flashOf = (html) => ((html.match(/(NOT sent[^<]*|NOT refunded[^<]*|SENT and closed[^<]*|REFUNDED[^<]*)/) || [''])[0]);

// sign in: password, then code
const r1 = await post('/login', { username: 'admin', password: 'pw-test' });
const ticket = (r1.body.match(/name="ticket" value="([^"]+)"/) || [])[1];
assert.ok(ticket, 'no 2FA ticket: ' + r1.code);
const r2 = await post('/login/2fa', { ticket, code: code() });
const cookie = String((r2.headers['set-cookie'] || [])[0] || '').split(';')[0];
assert.match(cookie, /^pcadm=/, 'not signed in');
const KEY = 'ab'.repeat(32) + ':pc1qexampleexampleexampleexampleexamplexx';

for (const action of ['send', 'refund']) {
  await check(`${action}: NO code -> refused by the guard, nothing attempted`, async () => {
    const r = await post('/wrapdesk', { action, key: KEY }, cookie);
    assert.match(flashOf(r.body), /authenticator code was not right\. Nothing moved/, flashOf(r.body));
  });
  await check(`${action}: a WRONG code -> refused by the guard`, async () => {
    const wrong = String((Number(code()) + 1) % 1000000).padStart(6, '0');
    const r = await post('/wrapdesk', { action, key: KEY, code: wrong }, cookie);
    assert.match(flashOf(r.body), /authenticator code was not right/, flashOf(r.body));
  });
  await check(`${action}: the RIGHT code gets past the guard (the send itself then runs)`, async () => {
    const r = await post('/wrapdesk', { action, key: KEY, code: code() }, cookie);
    const f = flashOf(r.body);
    assert.ok(f && !/authenticator code/.test(f), 'the guard refused a correct code: ' + f);
  });
}
await check('not signed in at all -> no wrap desk action runs', async () => {
  const r = await post('/wrapdesk', { action: 'send', key: KEY, code: code() });
  assert.ok(r.code === 302 || r.code === 401 || /action="\/login"/.test(r.body), 'status ' + r.code);
  assert.equal(flashOf(r.body), '');
});

srv.kill();
console.log(`ALL ${n} CHECKS PASSED`);
