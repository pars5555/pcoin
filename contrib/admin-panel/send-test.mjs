// End-to-end test of the Send PCN page -- `node contrib/admin-panel/send-test.mjs`.
// The panel's sendAction() calls a LOCAL stand-in market server that runs the
// real contrib/market/ops-send.mjs against a fake wallet. Nothing touches a node.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendAction, parseSend, codeOnce, newKey, readLog, sendPage } from './send.mjs';
import { opsSendPcn } from '../market/ops-send.mjs';

const TOKEN = 'panel-test-send-token';
const TO = 'pc1qclkpmsdklwehq54fztw5qw8ssnuwmee3szaz2e';
const sent = [];
const fakeWallet = {
  async wallet(method, params) {
    if (method === 'listtransactions') return sent;
    if (method === 'sendtoaddress') {
      const txid = 'e'.repeat(62) + String(sent.length).padStart(2, '0');
      sent.push({ category: 'send', comment: params[2], txid, amount: -params[1], time: Math.floor(Date.now() / 1000), confirmations: 0 });
      return txid;
    }
    throw new Error('unexpected ' + method);
  },
};
// The market's config, per test: none of its caps are set by default (owner, 2026-09-24).
let marketCfg = { sendToken: TOKEN };
const srv = createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; });
  req.on('end', async () => {
    const r = await opsSendPcn({ auth: req.headers.authorization, raw: b, cfg: marketCfg, node: fakeWallet });
    res.writeHead(r.code, { 'content-type': 'application/json' }); res.end(JSON.stringify(r.obj));
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const creds = { market: { sendToken: TOKEN, sendUrl: `http://127.0.0.1:${srv.address().port}/api/ops/send-pcn` } };
const logPath = join(mkdtempSync(join(tmpdir(), 'sendlog-')), 'sends.json');
const form = (o) => new URLSearchParams(o);
let codeCounter = 100000;
const nextCode = () => String(codeCounter++);
const goodCode = () => true;
let n = 0;
const check = async (name, fn) => { await fn(); n += 1; console.log('  ok  ', name); };
const acheck = async (name, fn) => { await fn(); n += 1; console.log('  ok  ', name); };

await check('parseSend refuses a stale form, a non-PCoin address and a bad amount', () => {
  const key = newKey();
  assert.equal(parseSend(form({ key: 'send:x', to: TO, pcn: '1' })).ok, false);
  assert.equal(parseSend(form({ key, to: 'bc1qsomebitcoin', pcn: '1' })).ok, false);
  assert.equal(parseSend(form({ key, to: TO, pcn: '1.123456789' })).ok, false, 'more than 8 decimals');
  assert.equal(parseSend(form({ key, to: TO, pcn: '0' })).ok, false);
  const ok = parseSend(form({ key, to: ' ' + TO.toUpperCase() + ' ', pcn: '500', note: 'AionCore bounty' }));
  assert.equal(ok.ok, true); assert.equal(ok.to, TO); assert.equal(ok.pcn, 500);
});

await check('step one only PREVIEWS: nothing is sent and no code is asked', async () => {
  const r = await sendAction(form({ step: 'preview', key: newKey(), to: TO, pcn: '500' }), { verifyCode: goodCode, creds, logPath });
  assert.equal(r.view, 'confirm');
  assert.equal(sent.length, 0);
  const html = sendPage({ base: '/x', result: r, hotPcn: 11320.85 });
  assert.ok(html.includes(TO), 'the confirm page shows the WHOLE address');
  assert.ok(html.includes('name="code"'));
});

await check('a wrong code sends nothing, and a code cannot be used twice', async () => {
  const r = await sendAction(form({ step: 'send', key: newKey(), to: TO, pcn: '500', code: '123456' }), { verifyCode: () => false, creds, logPath });
  assert.equal(r.bad, true); assert.equal(sent.length, 0);
  assert.equal(codeOnce('654321', goodCode), true);
  assert.equal(codeOnce('654321', goodCode), false, 'replayed code refused');
});

await acheck('step two with a good code SENDS once, logs it, and a double submit pays nothing more', async () => {
  const key = newKey();
  const f = { step: 'send', key, to: TO, pcn: '500', note: 'AionCore bounty' };
  const r1 = await sendAction(form({ ...f, code: nextCode() }), { verifyCode: goodCode, creds, logPath });
  assert.equal(r1.bad, undefined, r1.flash);
  assert.match(r1.flash, /^SENT\. 500 PCN to pc1qclkp/);
  assert.equal(sent.length, 1);
  const r2 = await sendAction(form({ ...f, code: nextCode() }), { verifyCode: goodCode, creds, logPath });
  assert.match(r2.flash, /Already sent earlier/);
  assert.equal(sent.length, 1, 'the same form cannot pay twice');
  const log = readLog(logPath);
  assert.equal(log.length, 2); assert.equal(log[1].result, 'sent'); assert.equal(log[0].result, 'already');
});

await acheck('a per-send cap, IF the market config sets one, is refused there and shown as NOT sent', async () => {
  marketCfg = { sendToken: TOKEN, sendMaxPcn: 1000 };
  try {
    const r = await sendAction(form({ step: 'send', key: newKey(), to: TO, pcn: '1500', code: nextCode() }), { verifyCode: goodCode, creds, logPath });
    assert.match(r.flash, /^NOT sent: amount must be at most 1000 PCN per send/);
    assert.equal(sent.length, 1);
  } finally { marketCfg = { sendToken: TOKEN }; }
});

await acheck('no send token configured: switched off, nothing sent', async () => {
  const r = await sendAction(form({ step: 'send', key: newKey(), to: TO, pcn: '5', code: nextCode() }), { verifyCode: goodCode, creds: { market: {} }, logPath });
  assert.match(r.flash, /switched off/);
  assert.equal(sent.length, 1);
});

await acheck('an unreachable market host is UNKNOWN, not failed, and keeps the confirm page with the same key', async () => {
  const key = newKey();
  const r = await sendAction(form({ step: 'send', key, to: TO, pcn: '5', code: nextCode() }),
    { verifyCode: goodCode, creds: { market: { sendToken: TOKEN, sendUrl: 'http://127.0.0.1:9/api/ops/send-pcn' } }, logPath });
  assert.match(r.flash, /^UNKNOWN: /);
  assert.equal(r.view, 'confirm'); assert.equal(r.s.key, key);
});

await acheck('with no cap configured, 1,500 PCN in one manual send goes out', async () => {
  const before = sent.length;
  const r = await sendAction(form({ step: 'send', key: newKey(), to: TO, pcn: '1500', code: nextCode() }), { verifyCode: goodCode, creds, logPath });
  assert.match(r.flash, /^SENT\. 1500 PCN/);
  assert.equal(sent.length, before + 1);
});

srv.close();
console.log(`ALL ${n} CHECKS PASSED`);
