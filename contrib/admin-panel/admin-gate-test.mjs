// node contrib/admin-panel/admin-gate-test.mjs
// Proves the admin.pc.am address lock FIRES, not just that it lets the owner in:
// the real server.mjs in ADMIN_ROOT mode, on a free port, against a temp list.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), 'admingate-'));
mkdirSync(join(TMP, 'data'));
const ALLOW = join(TMP, 'allowed-ips.json');
writeFileSync(ALLOW, JSON.stringify({ ips: [{ ip: '46.182.172.50', label: 'home' }] }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = await new Promise((r) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

function start(env) {
  const p = spawn(process.execPath, [join(HERE, 'server.mjs')], { cwd: HERE, stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, ADMIN_PORT: String(port), ADMIN_DATA: join(TMP, 'data'), ADMIN_CRED: join(TMP, 'credential.json'),
    ADMIN_SESSION_FILE: join(TMP, 'sessions.json'), ADMIN_ALLOW_FILE: ALLOW, ADMIN_INGEST: join(TMP, 'ingest.json'), ...env } });
  let log = '';
  p.stdout.on('data', (d) => { log += d; }); p.stderr.on('data', (d) => { log += d; });
  return { p, log: () => log };
}
const get = (path, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
    let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ code: res.statusCode, body: b, headers: res.headers }));
  });
  req.on('error', reject); req.end();
});
let n = 0;
const check = async (name, fn) => { await fn(); n += 1; console.log('  ok  ', name); };

// Without a prefix and without ADMIN_ROOT it must refuse to start at all.
await check('no ADMIN_PREFIX and no ADMIN_ROOT: refuses to start', async () => {
  const s = start({ ADMIN_PREFIX: '', ADMIN_ROOT: '' });
  const code = await new Promise((r) => s.p.on('exit', r));
  assert.equal(code, 2, s.log());
});

const s = start({ ADMIN_PREFIX: '', ADMIN_ROOT: '1' });
for (let i = 0; i < 60 && !s.log().includes('pcoin-admin on'); i++) await sleep(200);
assert.ok(s.log().includes('pcoin-admin on'), s.log());

await check('the owner\'s address (as Caddy forwards it) reaches the login page at /', async () => {
  const r = await get('/', { 'x-forwarded-for': '46.182.172.50' });
  assert.equal(r.code, 200); assert.match(r.body, /Sign in/);
  assert.match(r.body, /action="\/login"/, 'links are root-relative on admin.pc.am');
});
await check('any other address gets 404 -- not even the login page', async () => {
  const r = await get('/', { 'x-forwarded-for': '8.8.8.8' });
  assert.equal(r.code, 404); assert.doesNotMatch(r.body, /Sign in/);
  assert.equal((await get('/login', { 'x-forwarded-for': '8.8.8.8' }, 'POST')).code, 404);
});
await check('a spoofed chain cannot smuggle the owner\'s address in second place', async () => {
  const r = await get('/', { 'x-forwarded-for': '8.8.8.8, 46.182.172.50' });
  assert.equal(r.code, 404);
});
await check('a tool on the box itself (loopback, no forwarded header) is let through', async () => {
  assert.equal((await get('/')).code, 200);
});
await check('/ingest/ is not address-gated, and a bad token still answers 404', async () => {
  const r = await get('/ingest/jobs', { 'x-forwarded-for': '8.8.8.8', authorization: 'Bearer nope' }, 'POST');
  assert.equal(r.code, 404); assert.equal(r.body, 'not found\n');
});
await check('an unreadable list refuses every remote client (after the 10 s cache)', async () => {
  writeFileSync(ALLOW, '{ broken');
  await sleep(10_500);
  assert.equal((await get('/', { 'x-forwarded-for': '46.182.172.50' })).code, 404);
  assert.equal((await get('/')).code, 200, 'the box itself still gets in, to fix it');
});

s.p.kill();
console.log(`ALL ${n} CHECKS PASSED`);
