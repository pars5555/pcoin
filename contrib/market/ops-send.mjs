// SEND PCN FROM market-hot, for the admin panel's "Send PCN" page. THIS SPENDS.
//
// The owner asked for it on 2026-09-24: "in the admin there should be a sending
// function from my market hot, so I input the address and amount and send" --
// for things like the 500 PCN pool bounty, which until now meant finding a
// wallet by hand. market-hot is already the wallet this process delivers from,
// so this adds no key, no wallet and no host that was not already spending. It
// adds one narrow, capped, separately-credentialled way to ask it to.
//
// THE GUARDS, and why each is here:
//
//   * ITS OWN TOKEN (`sendToken`), not the read token and not the refund token.
//     Unset means sending is OFF, not open.
//   * THE OWNER'S AUTHENTICATOR CODE is checked by the panel before it calls
//     this. A code is not something this host can verify -- it never holds the
//     owner's TOTP secret -- so the token proves "the panel asked", and the caps
//     below bound what a compromised panel could do with it.
//   * CAPS: `sendMaxPcn` per send (default 1,000) and `sendDayMaxPcn` per rolling
//     24 hours (default 2,000), counted from the WALLET's own history of sends
//     that carry a `send:` key, so a restart cannot reset them. If that history
//     cannot be read, nothing is sent: an unanswerable question must not resolve
//     to the answer that spends money.
//   * IDEMPOTENT BY COMMENT, like the refund path and delivery.mjs: the key goes
//     into the transaction's comment, and a key already on a send returns that
//     txid instead of paying twice. The panel mints the key when it draws the
//     form, so a double-click or a retried request is the same key.
//   * An answer that never came back is reported as exactly that -- the send may
//     or may not have gone out -- never as "failed".

import { timingSafeEqual } from 'node:crypto';

const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};
const DAY_S = 86400;

/**
 * @returns {{ code: number, obj: object }} -- never throws.
 * `node.wallet(method, params)` is the market-hot wallet RPC, as in delivery.mjs.
 */
export async function opsSendPcn({ auth = '', raw = '', cfg = {}, node, notify = () => {}, now = Date.now() }) {
  const want = cfg.sendToken;
  if (!want) {
    return { code: 503, obj: { error: 'no sendToken is configured, so sending from market-hot is '
      + 'switched off here. This is not an authentication failure.' } };
  }
  const m = String(auth).match(/^Bearer\s+(.+)$/i);
  if (!m || !same(m[1], want)) {
    return { code: 401, obj: { error: 'sending needs the send token, which is neither the read '
      + 'token nor the refund token' } };
  }
  let b;
  try { b = JSON.parse(String(raw || '')); } catch { b = null; }
  if (!b || typeof b !== 'object') return { code: 400, obj: { error: 'body must be one JSON object' } };

  const key = String(b.key || '').trim();
  const to = String(b.to || '').trim();
  const pcn = Number(b.pcn);
  const note = String(b.note || '').replace(/[^\x20-\x7e]/g, '').trim().slice(0, 80);
  const MAX = Number(cfg.sendMaxPcn || 1000);
  const DAY_MAX = Number(cfg.sendDayMaxPcn || 2000);

  if (!/^send:[0-9A-Za-z._-]{6,80}$/.test(key)) {
    return { code: 400, obj: { error: 'a send needs its idempotency key (send:...); nothing was sent' } };
  }
  if (!/^pc1[02-9ac-hj-np-z]{20,87}$/.test(to)) {
    return { code: 400, obj: { error: `${to || '(empty)'} does not look like a PCoin address; nothing was sent` } };
  }
  if (!Number.isFinite(pcn) || pcn <= 0 || pcn > MAX) {
    return { code: 400, obj: { error: `amount must be above 0 and at most ${MAX} PCN per send; got ${b.pcn}` } };
  }
  const amount = Number(pcn.toFixed(8));

  // Look before spending: already sent under this key? And how much went out in
  // the last 24 hours? One read answers both, and a read that fails sends nothing.
  let txs;
  try {
    txs = await node.wallet('listtransactions', ['*', 1000, 0, true]);
  } catch (e) {
    return { code: 503, obj: { error: `could not read market-hot's history (${e.message}), so neither `
      + `the duplicate check nor the daily cap can be answered. Nothing was sent.` } };
  }
  const live = (txs || []).filter((t) => t.category === 'send' && t.abandoned !== true
    && Number(t.confirmations) > -1 && String(t.comment || '').startsWith('send:'));
  const prior = live.find((t) => t.comment === key);
  if (prior) {
    return { code: 200, obj: { ok: true, already: true, txid: prior.txid,
      note: 'a send carrying this key already went out; nothing new was broadcast' } };
  }
  const nowS = Math.floor(now / 1000);
  // Grouped by txid: listtransactions lists a multi-output send once per output.
  const byTx = new Map();
  for (const t of live) {
    if (nowS - Number(t.time || 0) >= DAY_S) continue;
    byTx.set(t.txid, (byTx.get(t.txid) || 0) + Math.abs(Number(t.amount || 0)));
  }
  const sentToday = [...byTx.values()].reduce((s, v) => s + v, 0);
  if (sentToday + amount > DAY_MAX + 1e-9) {
    return { code: 400, obj: { error: `this would take the last 24 hours to ${(sentToday + amount).toFixed(8)} PCN, `
      + `over the ${DAY_MAX} PCN daily limit (${sentToday.toFixed(8)} already sent). Nothing was sent.` } };
  }

  let txid;
  try {
    txid = await node.wallet('sendtoaddress', [to, amount, key, note, false]);
  } catch (e) {
    return { code: 502, obj: { error: `the send failed or its answer was lost: ${e.message}. `
      + `Check market-hot for a transaction with comment ${key} BEFORE trying again.` } };
  }
  try {
    notify('market-hot: PCN sent from the admin panel',
      `Sent ${amount} PCN to ${to}${note ? ` (${note})` : ''}.\nkey ${key}\ntx ${txid}`);
  } catch { /* reporting must never break the thing it reports on */ }
  return { code: 200, obj: { ok: true, already: false, txid, pcn: amount, to, sentToday: Number((sentToday + amount).toFixed(8)) } };
}
