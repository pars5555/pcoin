// Tests for the exchange page's "Pay from keeper" -- run with
// `node contrib/admin-panel/pay-keeper-test.mjs`. A fake exchange admin API and
// a fake keeper tool stand in for both hosts; nothing here touches a chain.
// The fake keeper keeps the same promise the real one does (one key, one
// payment -- contrib/wpcn/test_keeper_pay.py proves the real one keeps it), so
// what is tested here is the PANEL: that it pays only what the exchange says,
// only after the code is proved, and records exactly what was sent.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exchangeSection } from './exchange.mjs';
import { readLog } from './send.mjs';
import { usdToMicro, lastJson } from './keeper-pay.mjs';

const GOOD = '123456';
const ADDR = '0x768d89efe2c9238c919c6b6695ffedbb00974210';

// ---- fake exchange --------------------------------------------------------
let W; let failTxidOnce = false;
function resetW(o = {}) {
  W = { id: 21, network: 'BEP20', asset: 'USD', amount: '50.000000', fee: '0.010000', address: ADDR, status: 'requested',
    approveExpiresAt: null, txid: null, email: 'x@example.com', accountId: 52, ageSeconds: 100,
    requestedWithTwofa: true, sources: { pcnDepositsCredited: 2, usdDepositsCredited: 0, trades: 3 }, ...o };
}
const ex = createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; });
  req.on('end', () => {
    const j = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
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
await new Promise((r) => ex.listen(0, '127.0.0.1', r));

// ---- fake keeper: one key, one payment -------------------------------------
const paid = new Map();   // key -> { to, micro, txid }
let keeperMode = 'ok';
const keeper = {
  async status() { return { ok: true, usdt: 251.94, bnb: 0.0187, min_usdt: 5, address: '0x477C9793C0d69283d703010500C86f7335B27521', busy: null }; },
  async send({ key, to, micro }) {
    if (keeperMode === 'refuse') return { state: 'refused', message: 'the keeper is trading right now. Nothing was sent; press again in a minute.' };
    if (keeperMode === 'unknown') { keeperMode = 'ok'; return { state: 'unknown', message: 'The tool did not finish (timeout).' }; }
    const p = paid.get(key);
    if (p) {
      if (p.to !== to || p.micro !== micro) return { state: 'refused', message: 'key reused' };
      return { state: 'already', txid: p.txid, message: 'Already paid' };
    }
    const txid = '0x' + String(paid.size + 1).padStart(64, 'c');
    paid.set(key, { to, micro, txid });
    return { state: 'sent', txid, message: 'Paid' };
  },
};
const sends = () => paid.size;

const logPath = join(mkdtempSync(join(tmpdir(), 'paykeeper-')), 'sends.json');
const creds = { exchange: { apiUrl: `http://127.0.0.1:${ex.address().port}`, readToken: 'read' }, market: {} };
const url = new URL('https://admin.pc.am/exchange?view=withdrawals&id=21');
const section = () => exchangeSection({ base: '', creds, actor: 'owner', sendLogPath: logPath, keeper });
const press = async (code = GOOD) => (await section().action(new URLSearchParams({ action: 'pay_keeper', id: String(W.id), code }), url)).flash;
let n = 0;
const check = async (name, fn) => { await fn(); n += 1; console.log('  ok  ', name); };

await check('usdToMicro is exact and refuses anything that is not a plain amount', async () => {
  assert.equal(usdToMicro('50.000000'), '50000000'); assert.equal(usdToMicro('32.65'), '32650000');
  assert.equal(usdToMicro('0.000001'), '1'); assert.equal(usdToMicro('0'), null);
  for (const bad of ['', '1e3', '-5', '5.1234567', ' ', 'NaN', '1,000.00']) assert.equal(usdToMicro(bad), null, bad);
});
await check('lastJson reads the tool\'s one JSON line and nothing else', async () => {
  assert.deepEqual(lastJson('noise\n{"state":"sent","txid":"0x1"}\n'), { state: 'sent', txid: '0x1' });
  assert.equal(lastJson('no json here'), null); assert.equal(lastJson(''), null);
});
await check('a wrong code sends NOTHING and does not even approve', async () => {
  resetW(); paid.clear();
  const f = await press('000000');
  assert.equal(f.ok, false); assert.match(f.text, /Nothing was sent/);
  assert.equal(sends(), 0); assert.equal(W.status, 'requested');
});
await check('one press: approves, sends exactly 50000000 micro-USDT to the exchange\'s address, records the txid', async () => {
  resetW(); paid.clear();
  const f = await press();
  assert.equal(f.ok, true, f.text); assert.match(f.text, /^PAID: 50\.000000 USDT sent from the keeper/);
  const [p] = [...paid.values()];
  assert.equal(p.to, ADDR); assert.equal(p.micro, '50000000');
  assert.equal(W.status, 'paid_unverified'); assert.equal(W.txid, p.txid);
  const log = readLog(logPath.replace(/sends\.json$/, 'keeper-sends.json'));
  assert.ok(log.some((e) => e.note === 'exchange withdrawal #21' && e.txid === p.txid && e.usdt === 50));
  assert.equal(readLog(logPath).length, 0, 'a USDT payout must not land in the PCN send log');
});
await check('pressing again after it is paid does nothing', async () => {
  const f = await press();
  assert.equal(f.ok, false); assert.match(f.text, /nothing to pay/); assert.equal(sends(), 1);
});
await check('sent but the record step failed: says SENT, and pressing again only RECORDS -- one payment', async () => {
  resetW(); paid.clear(); failTxidOnce = true;
  const f1 = await press();
  assert.equal(f1.ok, false); assert.match(f1.text, /^SENT 50\.000000 USDT .* recording it on #21 failed/);
  const f2 = await press();
  assert.equal(f2.ok, true, f2.text); assert.match(f2.text, /nothing new went out/);
  assert.equal(sends(), 1, 'paid twice!');
});
await check('the tool UNKNOWN -> says UNKNOWN, records nothing; the next press settles it once', async () => {
  resetW(); paid.clear(); keeperMode = 'unknown';
  const f1 = await press();
  assert.equal(f1.ok, false); assert.match(f1.text, /^UNKNOWN: /); assert.equal(W.txid, null);
  const f2 = await press();
  assert.equal(f2.ok, true, f2.text); assert.equal(sends(), 1);
});
await check('the tool refusing -> NOT sent, nothing recorded', async () => {
  resetW(); paid.clear(); keeperMode = 'refuse';
  const f = await press(); keeperMode = 'ok';
  assert.equal(f.ok, false); assert.match(f.text, /^NOT sent: the keeper is trading/); assert.equal(W.txid, null);
});
await check('a TRON withdrawal is refused: the keeper is a BNB Smart Chain wallet', async () => {
  resetW({ network: 'TRC20', address: 'TXYZabcdefghijkmnopqrstuvwxyz12345' }); paid.clear();
  const f = await press();
  assert.equal(f.ok, false); assert.match(f.text, /Only a USDT withdrawal on BNB Smart Chain/); assert.equal(sends(), 0);
});
await check('a PCN withdrawal is refused here', async () => {
  resetW({ network: 'PCN', asset: 'PCN', amount: '1224.00000000', address: 'pc1qq54jdvd4vxwxjmn0ft3z0ugnqj56x97ktj9ww8' }); paid.clear();
  const f = await press();
  assert.equal(f.ok, false); assert.equal(sends(), 0);
});
await check('a malformed address on the exchange record is refused after approval, before sending', async () => {
  resetW({ address: '0x768d89' }); paid.clear();
  const f = await press();
  assert.equal(f.ok, false); assert.match(f.text, /not in a payable state/); assert.equal(sends(), 0);
});
await check('an approval about to expire is refused BEFORE sending', async () => {
  resetW({ status: 'approved', approveExpiresAt: Math.floor(Date.now() / 1000) + 60 }); paid.clear();
  const f = await press();
  assert.equal(f.ok, false); assert.match(f.text, /expires in under 5 minutes/); assert.equal(sends(), 0);
});
await check('the withdrawal page shows the keeper button, its balance and the floor warning', async () => {
  resetW();
  const html = await section().page(url);
  assert.match(html, /Pay 50\.000000 USDT from keeper/);
  assert.match(html, /name="action" value="pay_keeper"/);
  assert.match(html, /the keeper holds 251\.94 USDT/);
  assert.doesNotMatch(html, /from market-hot/, 'a USDT withdrawal must not offer market-hot');
});

ex.close();
console.log(`ALL ${n} CHECKS PASSED`);
