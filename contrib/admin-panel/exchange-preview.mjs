// Serve the admin exchange page locally, against a seeded throwaway database
// and the REAL exchange admin API, with the real shell (style + the live-filter
// script lifted out of server.mjs). Lets the browser exercise the JS for real.
import http from 'node:http';
import { readFileSync } from 'node:fs';
const EX = 'file:///D:/xampp/htdocs/pcoin-exchange';
const AD = 'file:///D:/xampp/htdocs/pcoin/contrib/admin-panel';
const { run } = await import(`${EX}/lib/db.mjs`);
const { parseConfig } = await import(`${EX}/lib/config.mjs`);
const { createApp } = await import(`${EX}/lib/server.mjs`);
const { placeOrder } = await import(`${EX}/lib/engine.mjs`);
const { freshDb, makeUser, PCN, T0 } = await import(`${EX}/test/helpers.mjs`);
const { exchangeSection } = await import(`${AD}/exchange.mjs`);

const db = freshDb({ open: true });
const now = Math.floor(Date.now() / 1000);
const countries = ['AM', 'US', 'DE', 'VN', 'IN', 'BR', null];
const users = [];
for (let i = 1; i <= 64; i++) {
  const email = `user${i}@example.com`;
  const id = makeUser(db, email, { usd: 50_000_000n + BigInt(i) * 1_000_000n, pcn: PCN(1000 + i * 10) });
  run(db, 'INSERT OR IGNORE INTO user_emails (account_id, email, first_seen_at) VALUES (?, ?, ?)', id, email, T0);
  const c = countries[i % countries.length];
  run(db, `UPDATE accounts SET created_at = ?, signup_country = ?, signup_ip = ?, last_country = ?, last_ip = ?, last_seen_at = ?
           WHERE id = ?`, BigInt(now - i * 5000), c, c ? `203.0.113.${i}` : null, c, c ? `198.51.100.${i}` : null,
           BigInt(now - i * 300), id);
  users.push(id);
}
for (let i = 0; i < 20; i++) {
  placeOrder(db, { accountId: users[i], side: 'buy', priceMicro: 20000n + BigInt(i * 100), qtySat: PCN(300) }, { now: BigInt(now - 100) });
}
const kinds = ['signin', 'order', 'trade', 'deposit'];
for (let i = 0; i < 120; i++) {
  run(db, 'INSERT INTO events (at, kind, text, sent_at, ip) VALUES (?, ?, ?, ?, ?)', BigInt(now - i * 900),
    kinds[i % 4], `${kinds[i % 4]}: user${(i % 64) + 1}@example.com`, BigInt(now), `203.0.113.${i % 250}`);
}

const READ = 'r'.repeat(40);
const cfg = parseConfig({ publicUrl: 'https://exchange.test', ssoSecret: 's'.repeat(40), adminReadToken: READ,
  adminTotpSecret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', adminAllowFrom: ['127.0.0.1'],
  explorerUrl: 'https://explorer.test', corroborateUrl: 'https://explorer2.test', nowpayments: null });
const app = createApp({ db, cfg, notify: async () => true, log: { error() {}, warn() {} } });
const api = http.createServer(app.adminHandler);
await new Promise((r) => api.listen(0, '127.0.0.1', r));

const section = exchangeSection({ base: '/adm', creds: { exchange: { apiUrl: `http://127.0.0.1:${api.address().port}`, readToken: READ }, }, actor: 'owner' });
const src = readFileSync('D:/xampp/htdocs/pcoin/contrib/admin-panel/server.mjs', 'utf8');
const css = src.match(/<style>([\s\S]*?)<\/style>/)[1];
const js = src.match(/<script>([\s\S]*?)<\/script>/)[1];

const srv = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/adm/exchange') { res.writeHead(404); return res.end('no'); }
  let body;
  try { body = await section.page(url); } catch (e) { res.writeHead(500); return res.end(String(e.stack)); }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><style>${css}</style><script>
    window.__loads = (window.__loads || 0) + 1;
    </script><script>${js}</script></head><body><div class="layout"><div class="main">
    <h1>exchange.pc.am</h1>${body}</div></div></body></html>`);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
console.log(`http://127.0.0.1:${srv.address().port}/adm/exchange?view=users`);
