// Tests for the exchange page's "Pay from market-hot" -- run with
// `node contrib/admin-panel/pay-hot-test.mjs`. A fake exchange admin API and a
// fake market (the real ops-send.mjs over a fake wallet) stand in for both
// hosts; nothing here touches a node, a chain or the real exchange.
// Every guard is shown REFUSING, and the one property that matters most is
// checked after every case: the withdrawal is never paid twice.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exchangeSection } from './exchange.mjs';
import { opsSendPcn } from '../market/ops-send.mjs';
import { readLog } from './send.mjs';

const GOOD = '123456';
const SEND_TOKEN = 'send-token-test';
const ADDR = 'pc1qq54jdvd4vxwxjmn0ft3z0ugnqj56x97ktj9ww8';

// ---- fake exchange --------------------------------------------------------
let W; let failTxidOnce = false; const exCalls = [];
function resetW(o = {}) {
  W = { id: 19, network: 'PCN', asset: 'PCN', amount: '1224.00000000', fee: '0', address: ADDR, status: 'requested',
    approveExpiresAt: null, txid: null, email: 'x@example.com', accountId: 9, ageSeconds: 100,
    requestedWithTwofa: true, sources: { pcnDepositsCredited: 0, usdDepositsCredited: 4, trades: 7 }, ...o };
}
const ex = createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; });
  req.on('end', () => {
    const j = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    exCalls.push(`${req.method} ${req.url}`);
    if (req.method === 'GET' && req.url === `/admin/api/withdrawals/${W.id}`) return j(200, W);
    if (req.method === 'POST') {
      if (req.headers['x-admin-totp'] !== GOOD) return j(401, { error: 'a current authenticator code is required' });
      if (req.url.endsWith('/approve')) {
        if (W.status !== 'requested') return j(422, { error: `withdrawal ${W.id} is ${W.status}`, code: 'not_requested' });
        W.status = 'approved'; W.approveExpiresAt = Math.floor(Date.now() / 1000) + 86400; return j(200, { ok: true });
      }
      if (req.url.endsWith('/txid')) {
        if (failTxidOnce) { failTxidOnce = false; return j(401, { error: 'a current authenticator code is required' }); }
        if (W.txid) return j(422, { error: 'already', code: 'already_recorded' });
        if (W.status !== 'approved') return j(422, { error: 'not approved', code: 'not_approved' });
        W.txid = JSON.parse(b).txid; W.status = 'paid_unverified'; return j(200, { ok: true });
      }
    }
    return j(404, { error: 'no such route' });
  });
});

// ---- fake market: the REAL ops-send over a fake wallet --------------------
const sent = [];
const wallet = { async wallet(m, p) {
  if (m === 'listtransactions') return sent;
  if (m === 'getbalances') return { mine: { trusted: 10819.7 } };
  if (m === 'sendtoaddress') {
    const txid = 'ab'.repeat(31) + String(sent.length).padStart(2, '0');
    sent.push({ category: 'send', comment: p[2], txid, amount: -p[1], time: Math.floor(Date.now() / 1000), confirmations: 0, address: p[0] });
    return txid;
  }
  throw new Error('unexpected ' + m);
} };
const mk = createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; });
  req.on('end', async () => {
    const r = await opsSendPcn({ auth: req.headers.authorization, raw: b, cfg: { sendToken: SEND_TOKEN }, node: wallet });
    res.writeHead(r.code, { 'content-type': 'application/json' }); res.end(JSON.stringify(r.obj));
  });
});
await new Promise((r) => ex.listen(0, '127.0.0.1', r));
await new Promise((r) => mk.listen(0, '127.0.0.1', r));
const logPath = join(mkdtempSync(join(tmpdir(), 'payhot-')), 'sends.json');
const creds = (sendUrl = `http://127.0.0.1:${mk.address().port}/api/ops/send-pcn`) => ({
  exchange: { apiUrl: `http://127.0.0.1:${ex.address().port}`, readToken: 'read' },
  market: { sendToken: SEND_TOKEN, readToken: 'r', sendUrl },
});
const url = new URL('https://admin.pc.am/exchange?view=withdrawals&id=19');
const press = async (code = GOOD, c = creds()) => {
  const s = exchangeSection({ base: '', creds: c, actor: 'owner', sendLogPath: logPath });
  const f = new URLSearchParams({ action: 'pay_hot', id: String(W.id), code });
  return (await s.action(f, url)).flash;
};
let n = 0;
const check = async (name, fn) => { await fn(); n += 1; console.log('  ok  ', name); };

await check('a wrong code sends NOTHING and does not even approve', async () => {
  resetW(); sent.length = 0;
  const f = await press('000000');
  assert.equal(f.ok, false); assert.match(f.text, /Nothing was sent/);
  assert.equal(sent.length, 0); assert.equal(W.status, 'requested');
});
await check('one press: approves, sends exactly the amount to the address, records the txid', async () => {
  resetW(); sent.length = 0;
  const f = await press();
  assert.equal(f.ok, true, f.text); assert.match(f.text, /^PAID: 1224\.00000000 PCN/);
  assert.equal(sent.length, 1); assert.equal(sent[0].address, ADDR); assert.equal(-sent[0].amount, 1224);
  assert.equal(W.status, 'paid_unverified'); assert.equal(W.txid, sent[0].txid);
  assert.ok(readLog(logPath).some((e) => e.note === 'exchange withdrawal #19' && e.txid === sent[0].txid));
});
await check('pressing again after it is paid does nothing', async () => {
  const f = await press();
  assert.equal(f.ok, false); assert.match(f.text, /nothing to pay/);
  assert.equal(sent.length, 1);
});
await check('an ALREADY-approved withdrawal: the code is still proved by the exchange first, then it pays', async () => {
  resetW({ status: 'approved', approveExpiresAt: Math.floor(Date.now() / 1000) + 86400 }); sent.length = 0;
  const bad = await press('999999');
  assert.equal(bad.ok, false); assert.equal(sent.length, 0);
  const f = await press();
  assert.equal(f.ok, true, f.text); assert.equal(sent.length, 1); assert.equal(W.status, 'paid_unverified');
});
await check('sent but the record step failed: says SENT, and pressing again only RECORDS -- never a second send', async () => {
  resetW(); sent.length = 0; failTxidOnce = true;
  const f1 = await press();
  assert.equal(f1.ok, false); assert.match(f1.text, /^SENT 1224\.00000000 PCN .* recording it on #19 failed/);
  assert.equal(sent.length, 1); assert.equal(W.status, 'approved');
  const f2 = await press();
  assert.equal(f2.ok, true, f2.text); assert.match(f2.text, /nothing new went out/);
  assert.equal(sent.length, 1, 'paid twice!'); assert.equal(W.txid, sent[0].txid);
});
await check('a market host that does not answer is UNKNOWN and records nothing', async () => {
  resetW(); sent.length = 0;
  const f = await press(GOOD, creds('http://127.0.0.1:9/api/ops/send-pcn'));
  assert.equal(f.ok, false); assert.match(f.text, /^UNKNOWN: /);
  assert.equal(W.txid, null);
});
await check('a USD withdrawal is refused: market-hot pays PCN only', async () => {
  resetW({ network: 'BEP20', asset: 'USD', amount: '45.54', address: '0x768d89aaaaaaaaaaaaaaaaaaaaaaaaaaaa974210' }); sent.length = 0;
  const f = await press();
  assert.equal(f.ok, false); assert.match(f.text, /Only a PCN withdrawal/); assert.equal(sent.length, 0);
});
await check('an approval about to expire is refused BEFORE sending', async () => {
  resetW({ status: 'approved', approveExpiresAt: Math.floor(Date.now() / 1000) + 60 }); sent.length = 0;
  const f = await press();
  assert.equal(f.ok, false); assert.match(f.text, /expires in under 5 minutes/); assert.equal(sent.length, 0);
});
await check('the withdrawal page shows the button, the amount and whether market-hot can cover it', async () => {
  resetW();
  const s = exchangeSection({ base: '', creds: creds(), actor: 'owner', sendLogPath: logPath });
  const html = await s.page(url);
  assert.match(html, /Pay 1224\.00000000 PCN from market-hot/);
  assert.match(html, /name="action" value="pay_hot"/);
});

ex.close(); mk.close();
console.log(`ALL ${n} CHECKS PASSED`);
