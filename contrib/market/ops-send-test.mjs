// Tests for ops-send.mjs -- run with `node contrib/market/ops-send-test.mjs`.
// A fake wallet stands in for market-hot; nothing here touches a node.
// Every guard is shown REFUSING, because a guard only ever seen passing is untested.
import assert from 'node:assert/strict';
import { opsSendPcn } from './ops-send.mjs';

const TOKEN = 'test-send-token';
const TO = 'pc1qclkpmsdklwehq54fztw5qw8ssnuwmee3szaz2e';
const NOW = Date.UTC(2026, 8, 24, 12, 0, 0);
const cfg = { sendToken: TOKEN, sendMaxPcn: 1000, sendDayMaxPcn: 2000 };

function wallet(history = [], { failList = false, failSend = false } = {}) {
  const sent = [];
  return {
    sent,
    async wallet(method, params) {
      if (method === 'listtransactions') {
        if (failList) throw new Error('rpc timeout');
        return [...history, ...sent];
      }
      if (method === 'sendtoaddress') {
        if (failSend) throw new Error('socket hang up');
        const txid = 'f'.repeat(63) + String(sent.length);
        sent.push({ category: 'send', comment: params[2], txid, amount: -params[1], time: Math.floor(NOW / 1000), confirmations: 0 });
        return txid;
      }
      throw new Error('unexpected ' + method);
    },
  };
}
const req = (o) => JSON.stringify({ key: 'send:abc123def', to: TO, pcn: 500, note: 'AionCore bounty', ...o });
let n = 0;
const check = async (name, fn) => { await fn(); n += 1; console.log('  ok  ', name); };

await check('no token configured: OFF, not open', async () => {
  const r = await opsSendPcn({ auth: 'Bearer x', raw: req(), cfg: {}, node: wallet(), now: NOW });
  assert.equal(r.code, 503);
});
await check('wrong token is refused', async () => {
  const r = await opsSendPcn({ auth: 'Bearer nope', raw: req(), cfg, node: wallet(), now: NOW });
  assert.equal(r.code, 401);
});
await check('bad key, bad address, zero and over-cap amounts are refused and nothing is sent', async () => {
  const w = wallet();
  for (const bad of [{ key: 'abc' }, { to: 'bc1qnotours' }, { pcn: 0 }, { pcn: -5 }, { pcn: 1000.01 }, { pcn: 'lots' }]) {
    const r = await opsSendPcn({ auth: 'Bearer ' + TOKEN, raw: req(bad), cfg, node: w, now: NOW });
    assert.equal(r.code, 400, JSON.stringify(bad));
  }
  assert.equal(w.sent.length, 0);
});
await check('a good send goes out once, with the key as the comment', async () => {
  const w = wallet();
  const r = await opsSendPcn({ auth: 'Bearer ' + TOKEN, raw: req(), cfg, node: w, now: NOW });
  assert.equal(r.code, 200);
  assert.equal(r.obj.ok, true);
  assert.equal(r.obj.already, false);
  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0].comment, 'send:abc123def');
});
await check('the same key again returns the first txid and sends NOTHING new', async () => {
  const w = wallet();
  const a = await opsSendPcn({ auth: 'Bearer ' + TOKEN, raw: req(), cfg, node: w, now: NOW });
  const b = await opsSendPcn({ auth: 'Bearer ' + TOKEN, raw: req(), cfg, node: w, now: NOW });
  assert.equal(b.obj.already, true);
  assert.equal(b.obj.txid, a.obj.txid);
  assert.equal(w.sent.length, 1);
});
await check('the daily cap counts earlier sends and refuses the one that would cross it', async () => {
  const earlier = [
    { category: 'send', comment: 'send:earlier1', txid: 'a', amount: -900, time: Math.floor(NOW / 1000) - 3600, confirmations: 3 },
    { category: 'send', comment: 'send:earlier2', txid: 'b', amount: -900, time: Math.floor(NOW / 1000) - 7200, confirmations: 3 },
    // outside the window, and not a panel send: neither counts
    { category: 'send', comment: 'send:old', txid: 'c', amount: -900, time: Math.floor(NOW / 1000) - 90000, confirmations: 99 },
    { category: 'send', comment: 'wrap:refund', txid: 'd', amount: -250, time: Math.floor(NOW / 1000) - 60, confirmations: 1 },
  ];
  const w = wallet(earlier);
  const over = await opsSendPcn({ auth: 'Bearer ' + TOKEN, raw: req({ pcn: 250 }), cfg, node: w, now: NOW });
  assert.equal(over.code, 400);
  assert.match(over.obj.error, /daily limit/);
  const fits = await opsSendPcn({ auth: 'Bearer ' + TOKEN, raw: req({ key: 'send:fits0001', pcn: 200 }), cfg, node: w, now: NOW });
  assert.equal(fits.code, 200);
  assert.equal(fits.obj.sentToday, 2000);
});
await check('a history that cannot be read sends NOTHING', async () => {
  const w = wallet([], { failList: true });
  const r = await opsSendPcn({ auth: 'Bearer ' + TOKEN, raw: req(), cfg, node: w, now: NOW });
  assert.equal(r.code, 503);
  assert.equal(w.sent.length, 0);
});
await check('a send whose answer is lost says "check before retrying", not "failed"', async () => {
  const r = await opsSendPcn({ auth: 'Bearer ' + TOKEN, raw: req(), cfg, node: wallet([], { failSend: true }), now: NOW });
  assert.equal(r.code, 502);
  assert.match(r.obj.error, /BEFORE trying again/);
});
console.log(`ALL ${n} CHECKS PASSED`);
