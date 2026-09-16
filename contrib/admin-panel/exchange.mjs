// /exchange — exchange.pc.am, inside the unified admin panel.
//
// Owner, 2026-09-15: "integrate the exchange admin into existing admin that has
// all other pcoin related things in it" and "everything should be configurable
// from admin".
//
// THIS PAGE HOLDS NOTHING THAT CAN CHANGE THE EXCHANGE. upstream.json carries the
// exchange's READ token only. Every write forwards the owner's live code from the
// "PCoin Exchange admin" authenticator entry in x-admin-totp, and the EXCHANGE
// checks it against a secret this panel never has. So a compromise of this panel
// can read the exchange and cannot approve a payout, move a budget or open it.
//
// The exchange runs on this same host, so it is reached over loopback HTTP only;
// anything else is refused rather than sent in the clear.
//
// Unknown is its own state: an unreadable API renders as UNKNOWN, never as an
// empty queue, and a write whose answer was lost says the change may or may not
// have happened.
import http from 'node:http';
import https from 'node:https';
import { esc } from './ui.mjs';

const VIEWS = [
  ['overview', 'Overview'], ['activity', 'Activity'], ['withdrawals', 'Withdrawals'], ['deposits', 'Deposits'], ['settings', 'Settings'],
  ['users', 'Users'], ['book', 'Book & trades'], ['price', 'Price influence'], ['policy', 'Policy'], ['pool', 'Address pool'], ['audit', 'Audit log'],
];

const big = (v) => { try { return BigInt(String(v)); } catch { return null; } };
const usd = (micro) => {
  const n = big(micro); if (n === null) return '?';
  const neg = n < 0n; const a = neg ? -n : n;
  return `${neg ? '-' : ''}$${a / 1000000n}.${(a % 1000000n).toString().padStart(6, '0').replace(/0{1,4}$/, '')}`;
};
const pcn = (sat) => {
  const n = big(sat); if (n === null) return '?';
  const neg = n < 0n; const a = neg ? -n : n;
  return `${neg ? '-' : ''}${a / 100000000n}.${(a % 100000000n).toString().padStart(8, '0')} PCN`;
};
const age = (s) => (s === null || s === undefined ? '—' : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);
const when = (t) => (t === null || t === undefined ? '—' : `${new Date(Number(t) * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC`);

export function exchangeSection({ base, creds, actor }) {
  const ex = creds && creds.exchange ? creds.exchange : null;
  const self = `${base}/exchange`;

  function call(method, path, { body = null, code = null } = {}) {
    return new Promise((resolve) => {
      let u;
      try { u = new URL(path, ex.apiUrl); } catch (e) { return resolve({ readable: false, status: 0, json: null, reason: `bad apiUrl: ${e.message}` }); }
      const loopback = u.protocol === 'http:' && ['127.0.0.1', '::1', 'localhost'].includes(u.hostname);
      // Off this host, only HTTPS pinned to the exchange's own CA (caPem in
      // upstream.json). Plain HTTP to anything but loopback is refused.
      if (!loopback && !(u.protocol === 'https:' && ex.caPem)) {
        return resolve({ readable: false, status: 0, json: null, reason: 'the exchange API must be loopback HTTP, or HTTPS pinned with caPem in upstream.json' });
      }
      const payload = body === null ? null : JSON.stringify(body);
      const headers = { authorization: `Bearer ${ex.readToken}`, accept: 'application/json' };
      if (payload) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(payload); }
      if (code !== null) { headers['x-admin-totp'] = code; headers['x-admin-actor'] = actor; }
      const transport = loopback ? http : https;
      const req = transport.request({
        method, hostname: u.hostname, port: u.port || (loopback ? 80 : 443), path: u.pathname + u.search, headers, timeout: 15000,
        ...(loopback ? {} : { ca: ex.caPem, servername: ex.servername || undefined }),
      }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; if (data.length > 5e6) req.destroy(new Error('response too large')); });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch { /* not JSON */ }
          resolve({ readable: json !== null, status: res.statusCode, json, reason: json === null ? `HTTP ${res.statusCode}, non-JSON body` : null });
        });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (e) => resolve({ readable: false, status: 0, json: null, reason: e.message }));
      if (payload) req.write(payload);
      req.end();
    });
  }

  const ok = (r) => r.readable && r.status === 200;
  const tabs = (active) => `<div class="card" style="display:flex;flex-wrap:wrap;gap:14px">${VIEWS.map(([k, l]) =>
    `<a href="${self}?view=${k}"${k === active ? ' style="font-weight:700;text-decoration:underline"' : ''}>${esc(l)}</a>`).join('')}</div>`;
  const unknown = (what, r) => `<div class="card"><p class="bad"><b>UNKNOWN</b> — could not read ${esc(what)} from the exchange:
    ${esc(r.reason || (r.json && r.json.error) || `HTTP ${r.status}`)}</p><p class="muted">This is not "nothing to do". Check the pcoin-exchange container on this host.</p></div>`;
  const hidden = (n, v) => `<input type="hidden" name="${esc(n)}" value="${esc(v)}">`;
  const codeInput = '<input name="code" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="exchange 2FA" required style="width:9em">';
  const form = (action, fields, label, danger = false) => `<form method="POST" action="${self}" class="inline" style="margin:4px 0">
    ${hidden('action', action)}${fields}${codeInput}<button type="submit"${danger ? ' style="background:var(--red);border-color:var(--red)"' : ''}>${esc(label)}</button></form>`;
  const table = (head, rows, empty) => `<div class="card" style="padding:0;overflow-x:auto"><table><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr>
    ${rows.length ? rows.join('') : `<tr><td colspan="${head.length}" class="muted">${esc(empty)}</td></tr>`}</table></div>`;
  const mono = (s) => `<code>${esc(s)}</code>`;

  async function overview() {
    const [r, h] = await Promise.all([call('GET', '/admin/api/overview'), call('GET', '/admin/api/house')]);
    if (!ok(r)) return unknown('the overview', r);
    const hb = ok(h) ? h.json : null;
    const houseCard = !hb
      ? `<div class="card"><h2>House bots</h2><p class="bad"><b>UNKNOWN</b> — could not read the house accounts: ${esc(h.reason || (h.json && h.json.error) || `HTTP ${h.status}`)}</p></div>`
      : `<div class="card"><h2>House bots</h2><table>
        <tr><td style="width:40%">Ask bot PCN — what it can sell</td><td><b>${esc(hb.ask.pcn.available)}</b> available · ${esc(hb.ask.pcn.locked)} in orders</td></tr>
        <tr><td>Ask bot deposit address</td><td>${hb.ask.depositAddress ? mono(hb.ask.depositAddress) : form('house_address', '', 'Show the ask bot deposit address')}</td></tr>
        <tr><td>Bid bot USD — negative is what its purchases owe</td><td>${esc(hb.bid.usd.available)} · ${esc(hb.bid.usd.locked)} in orders</td></tr>
        <tr><td>Bid bot PCN bought</td><td>${esc(hb.bid.pcn.available)}</td></tr>
        <tr><td>Set a bot balance</td><td>${form('house_balance', '<select name="which"><option value="ask:PCN">ask bot PCN</option><option value="bid:USD">bid bot USD</option></select> <input name="amount" type="text" inputmode="decimal" placeholder="30000" required style="width:120px">', 'Set balance')}</td></tr></table>
        <p class="muted" style="margin-top:10px">Bot balances are house credit you set here: nothing is sent on chain. A user who buys PCN from the ask bot, or sells PCN to the bid bot for USD, is paid by you from any wallet only when they withdraw. The bid bot still buys at most its daily budget. Switch the bots on in Settings (bot_ask_enabled, bot_bid_enabled).</p></div>`;
    const o = r.json;
    const l = o.liability;
    const q = o.queue;
    const late = q.oldestAgeSeconds !== null && q.oldestAgeSeconds >= 18 * 3600;
    const rec = o.lastReconcile;
    const bots = o.lastBots;
    return `
      ${o.halted ? `<div class="card" style="border-left:4px solid var(--red)"><p class="bad"><b>HALTED</b> ${esc(when(o.halted.at))} by ${esc(o.halted.actor)}: ${esc(o.halted.reason)}</p>
        <p class="muted">Trading, new withdrawals and the house bots are stopped. Clearing is refused while the books still do not balance.</p>${form('halt_clear', '', 'Clear the halt')}</div>` : ''}
      ${o.invariants.length ? `<div class="card" style="border-left:4px solid var(--red)"><p class="bad"><b>The books do not balance</b></p><ul style="margin-left:18px">${o.invariants.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>`
        : '<div class="card"><p class="ok">Books balance — every invariant passes.</p></div>'}
      <div class="stats-grid" style="margin-bottom:16px">
        <div class="stat-box"><div class="label">Public access</div><div class="value" style="color:var(--${o.exchangeOpen ? 'green' : 'yellow'})">${o.exchangeOpen ? 'OPEN' : 'CLOSED'}</div></div>
        <div class="stat-box"><div class="label">Withdrawal queue</div><div class="value"${late ? ' style="color:var(--red)"' : ''}>${q.open}</div></div>
        <div class="stat-box"><div class="label">Oldest waiting</div><div class="value"${late ? ' style="color:var(--red)"' : ''}>${esc(age(q.oldestAgeSeconds))}</div></div>
        <div class="stat-box"><div class="label">USD owed to users</div><div class="value">${esc(l.usdOwedToUsers)}</div></div>
      </div>
      <div class="card"><h2>Public access</h2>
        ${o.exchangeOpen
          ? form('setting', hidden('key', 'exchange_open') + hidden('type', 'bool') + hidden('value', 'false'), 'Close to the public')
          : `<p class="muted">Opening is a public-surface change: create the exchange.pc.am DNS record, drop "tls internal" from its Caddy site, and publish the pc.am page and an owner-approved announcement with it.</p>
             ${form('setting', hidden('key', 'exchange_open') + hidden('type', 'bool') + hidden('value', 'true'), 'OPEN to the public', true)}`}</div>
      <div class="card"><h2>Withdrawals</h2><p${late ? ' class="bad"' : ''}><b>${q.open}</b> open, oldest ${esc(age(q.oldestAgeSeconds))}${late ? ' — the site promises 24 hours' : ''}.
        <a href="${self}?view=withdrawals">Open the queue</a></p></div>
      <div class="card"><h2>What you owe</h2><table>
        <tr><td style="width:40%">USD owed to users</td><td><b>${esc(l.usdOwedToUsers)}</b></td></tr>
        <tr><td>PCN owed to users</td><td>${esc(l.pcnOwedToUsers)} PCN</td></tr>
        <tr><td>Bid bot USD (negative = PCN it bought on your behalf)</td><td>${esc(l.bidBotUsd)}</td></tr>
        <tr><td>Bid bot spent today</td><td>${esc(l.bidBotSpentTodayUsd)}</td></tr>
        <tr><td>Bid bot PCN held</td><td>${esc(l.bidBotPcn)}</td></tr>
        <tr><td>Fees earned</td><td>${esc(l.feesEarnedUsd)}</td></tr>
        <tr><td>PCN network fees paid</td><td>${esc(l.networkFeesPaidPcn)}</td></tr></table>
        <p class="muted" style="margin-top:10px">Information only: a liability ceiling was considered and declined. The bid bot's daily budget is the only limit.</p></div>
      <div class="card"><h2>Deposits and chain</h2><table>
        <tr><td style="width:40%">PCN deposits held for review</td><td${o.deposits.held ? ' class="bad"' : ''}>${o.deposits.held}</td></tr>
        <tr><td>PCN deposits confirming</td><td>${o.deposits.confirming}</td></tr>
        <tr><td>Credited deposits moved by a reorg</td><td${o.deposits.reorgSuspects ? ' class="bad"' : ''}>${o.deposits.reorgSuspects}</td></tr>
        <tr><td>Deposit addresses free / issued / change</td><td${o.pool.free < 20 ? ' class="warn"' : ''}>${o.pool.free} / ${o.pool.issued} / ${o.pool.change}${o.pool.free === 0 ? ' — no PCN deposits possible until a pool is imported' : ''}</td></tr>
        <tr><td>What trading here says PCN is worth</td><td>${o.price && o.price.indexMicro ? `${esc(usd(o.price.indexMicro))} · ${o.price.enabled ? 'nudging the published price' : 'measured only, switched off'}` : '<span class="muted">not enough trading yet</span>'}</td></tr>
        <tr><td>PCN deposits vs chain</td><td>${rec ? `${esc(rec.state)} at ${esc(when(rec.at))}${rec.diff !== undefined ? ` (received minus recorded: ${esc(rec.diff)} sat)` : ''}${rec.pcnOwed !== undefined ? ` · PCN owed ${esc(pcn(rec.pcnOwed))}, exchange wallet holds ${esc(pcn(rec.onchain))}` : ''}` : '<span class="muted">not run yet</span>'}</td></tr>
        <tr><td>House bots</td><td>${bots ? (bots.price && bots.price.usable ? `price ${esc(bots.price.sellPriceUsd)} at ${esc(when(bots.at))}` : `<span class="warn">off the book: ${esc((bots.price && bots.price.reason) || 'price unusable')}</span>`) : '<span class="muted">not run yet</span>'}</td></tr>
      </table></div>
      ${houseCard}
      <div class="card"><h2>Emergency</h2>
        ${o.halted ? '' : form('halt', '<input name="reason" type="text" placeholder="why" required>', 'Halt everything', true)}
        ${form('cancel_all', '<input name="reason" type="text" placeholder="why" required><select name="houseOnly"><option value="true">house orders only</option><option value="false">ALL orders</option></select>', 'Cancel orders')}
      </div>`;
  }

  async function withdrawals(url) {
    const all = url.searchParams.get('all') === '1';
    const r = await call('GET', `/admin/api/withdrawals${all ? '?all=1' : ''}`);
    if (!ok(r)) return unknown('the withdrawal queue', r);
    const rows = r.json;
    const focusId = url.searchParams.get('id') || (rows.find((w) => ['requested', 'approved', 'paid_unverified'].includes(w.status)) || {}).id;
    const w = rows.find((x) => x.id === focusId);
    let focus = '<div class="card"><p>Nothing waiting.</p></div>';
    if (w) {
      const amount = w.network === 'PCN' ? `${w.amount} PCN` : `${w.amount} USDT`;
      const net = { TRC20: 'TRON (TRC20)', BEP20: 'BNB Smart Chain (BEP20)', PCN: 'PCoin' }[w.network];
      focus = `<div class="card" style="border-left:4px solid var(--blue)">
        <h2>Withdrawal #${esc(w.id)} — ${esc(w.status.replace('_', ' '))}</h2>
        ${w.requestedWithTwofa ? '' : '<p class="bad"><b>Requested WITHOUT two-factor.</b> Sign-in is shared with market.pc.am; if that account were compromised this is what it would look like. Confirm with the user before paying.</p>'}
        <table>
          <tr><td style="width:28%">User</td><td>${esc(w.email)} (account ${esc(w.accountId)})</td></tr>
          <tr><td>Send exactly</td><td style="font-size:20px"><b>${esc(amount)}</b></td></tr>
          <tr><td>On network</td><td style="font-size:17px"><b>${esc(net)}</b></td></tr>
          <tr><td>To address</td><td style="font-size:16px">${mono(w.address)}</td></tr>
          <tr><td>Fee charged to the user</td><td>${esc(w.fee)}</td></tr>
          <tr><td>Waiting</td><td${w.ageSeconds >= 18 * 3600 ? ' class="bad"' : ''}>${esc(age(w.ageSeconds))} (promised within 24 h)</td></tr>
          <tr><td>Balance came from</td><td>${w.sources.pcnDepositsCredited} PCN deposit(s), ${w.sources.usdDepositsCredited} USD deposit(s), ${w.sources.trades} trade(s)</td></tr>
          ${w.txid ? `<tr><td>Txid</td><td>${mono(w.txid)}</td></tr>` : ''}
          ${w.verifyDetail ? `<tr><td>Chain check</td><td${/MISMATCH/.test(w.verifyDetail) ? ' class="bad"' : ''}>${esc(w.verifyDetail)}</td></tr>` : ''}
          ${w.approveExpiresAt ? `<tr><td>Approval expires</td><td>${esc(when(w.approveExpiresAt))}</td></tr>` : ''}
        </table>
        <div style="margin-top:12px">
        ${w.status === 'requested' ? form('approve', hidden('id', w.id), 'Approve') + form('reject', `${hidden('id', w.id)}<input name="reason" type="text" placeholder="reason" required>`, 'Reject and return the funds') : ''}
        ${w.status === 'approved' ? `<p>Send it from your own wallet, then paste the transaction id. It is marked paid only once the chain confirms the amount and address match.</p>
          ${form('txid', `${hidden('id', w.id)}<input name="txid" type="text" placeholder="transaction id" required style="min-width:28em">`, 'Record payment')}
          ${form('reject', `${hidden('id', w.id)}<input name="reason" type="text" placeholder="reason" required>`, 'Reject and return the funds')}` : ''}
        ${w.status === 'paid_unverified' ? `<p class="muted">Waiting for the chain to confirm. If the txid was pasted against the wrong withdrawal, clear it.</p>
          ${form('clear', `${hidden('id', w.id)}<input name="reason" type="text" placeholder="why" required>`, 'Clear the txid')}` : ''}
        </div></div>`;
    }
    const list = rows.map((x) => `<tr><td><a href="${self}?view=withdrawals&amp;id=${esc(x.id)}">#${esc(x.id)}</a></td><td>${esc(age(x.ageSeconds))}</td>
      <td>${esc(x.network)}</td><td>${esc(x.amount)}</td><td>${esc(x.status)}</td><td>${x.requestedWithTwofa ? '2FA' : '<span class="bad">no 2FA</span>'}</td><td>${esc(x.email)}</td></tr>`);
    return focus + table(['#', 'waiting', 'network', 'amount', 'status', '2FA', 'user'], list, all ? 'No withdrawals yet.' : 'Queue empty.')
      + `<p class="muted"><a href="${self}?view=withdrawals${all ? '' : '&amp;all=1'}">${all ? 'show open only' : 'show all, including paid and rejected'}</a></p>`;
  }

  async function deposits() {
    const r = await call('GET', '/admin/api/deposits');
    if (!ok(r)) return unknown('deposits', r);
    const p = r.json.pcn.map((d) => `<tr><td>${esc(d.id)}</td><td>${esc(d.email || '—')}</td><td>${esc(pcn(d.amount_sat))}</td>
      <td${d.status === 'held' ? ' class="bad"' : ''}>${esc(d.status)}${String(d.reorg_suspect) === '1' ? ' <b class="bad">REORG</b>' : ''}</td>
      <td>${esc(d.confirmations ?? '—')}</td><td>${mono(d.txid)}</td><td>${esc(d.hold_reason || '')}
      ${['held', 'seen'].includes(d.status) ? form('orphan', `${hidden('id', d.id)}<input name="reason" type="text" placeholder="why this must never be credited" required>`, 'Orphan') : ''}</td></tr>`);
    const u = r.json.usd.map((d) => `<tr><td>${esc(d.payment_id)}</td><td>${esc(d.email || '—')}</td><td>${esc(d.status)}</td>
      <td>${d.outcome_amount_micro === null ? '—' : esc(usd(d.outcome_amount_micro))} ${esc(d.outcome_currency || '')}</td><td>${esc(when(d.credited_at))}</td><td>${mono(d.order_id)}</td></tr>`);
    return '<div class="card"><h2>PCN</h2></div>' + table(['id', 'user', 'amount', 'status', 'conf', 'txid', 'note'], p, 'No PCN deposits.')
      + '<div class="card"><h2>USD (NOWPayments)</h2></div>' + table(['payment', 'user', 'status', 'credited', 'at', 'order'], u, 'No USD deposits.');
  }

  async function settings() {
    const r = await call('GET', '/admin/api/settings');
    if (!ok(r)) return unknown('settings', r);
    const { values, defs } = r.json;
    const human = (k, v) => {
      if (Array.isArray(v)) return v.join(', ') || '(empty)';
      if (k.endsWith('_micro')) return usd(v);
      if (k.endsWith('_sat')) return pcn(v);
      if (k.endsWith('_ppm')) return `${Number(v) / 10000}% (×${Number(v) / 1e6})`;
      return String(v);
    };
    const rows = Object.entries(defs).map(([k, d]) => {
      const v = values[k];
      const input = d.type === 'bool'
        ? `<select name="value"><option${v === true ? ' selected' : ''}>true</option><option${v === false ? ' selected' : ''}>false</option></select>`
        : d.type === 'enum'
          ? `<select name="value">${d.values.map((x) => `<option${x === v ? ' selected' : ''}>${esc(x)}</option>`).join('')}</select>`
          : `<input name="value" type="text" value="${esc(Array.isArray(v) ? v.join(', ') : v)}" style="width:15em">`;
      const warn = k === 'bot_bid_daily_budget_micro' ? '<br><b class="bad">This is the ONLY limit on what you can owe.</b>' : '';
      return `<tr><td><b>${esc(k)}</b>${warn}</td><td>${esc(human(k, v))}</td><td class="muted">${esc(human(k, d.default))}</td>
        <td>${form('setting', hidden('key', k) + hidden('type', d.type) + input, 'Save')}</td></tr>`;
    });
    return `<div class="card"><p class="muted">Numbers are in base units: <b>_micro</b> = millionths of a dollar ($1 = 1000000),
      <b>_sat</b> = hundred-millionths of a PCN (1 PCN = 100000000), <b>_ppm</b> = parts per million (0.2% = 2000).
      Lists are comma-separated. Every change is audited and announced in the ops channel.
      If a fee or limit changes, publish a new policy so users see it.</p></div>`
      + table(['setting', 'now', 'default', 'change'], rows, 'No settings.');
  }

  async function users() {
    const r = await call('GET', '/admin/api/users');
    if (!ok(r)) return unknown('users', r);
    const rows = r.json.map((u) => `<tr><td>${esc(u.id)}</td><td>${esc(u.email)}</td><td>${u.hasTwofa ? '2FA' : '<span class="bad">no 2FA</span>'}</td>
      <td>$${esc(u.usd.available)} + $${esc(u.usd.locked)}</td><td>${esc(u.pcn.available)} + ${esc(u.pcn.locked)}</td><td>${u.disabled ? '<b class="bad">disabled</b>' : 'active'}</td>
      <td>${form('user_disable', `${hidden('id', u.id)}${hidden('disabled', u.disabled ? 'false' : 'true')}<input name="reason" type="text" placeholder="reason" required>`, u.disabled ? 'Enable' : 'Disable')}
      ${u.hasTwofa ? form('twofa_reset', `${hidden('id', u.id)}<input name="reason" type="text" placeholder="how you verified them" required>`, 'Reset 2FA') : ''}
      ${form('user_credit', `${hidden('id', u.id)}<select name="asset"><option value="USD">USD</option><option value="PCN">PCN</option></select><input name="amount" type="text" inputmode="decimal" placeholder="amount" required style="width:90px">`, 'Test credit')}
      ${form('user_adjust', `${hidden('id', u.id)}<select name="asset"><option value="USD">USD</option><option value="PCN">PCN</option></select><input name="amount" type="text" inputmode="decimal" placeholder="+ or -" required style="width:80px"><input name="reason" type="text" placeholder="why (required)" required>`, 'Adjust')}</td></tr>`);
    return '<div class="card"><p class="muted">A 2FA reset is exactly what an impersonator asks for. Verify the person another way first.<br><b>Test credit</b> puts a balance on an account for testing before opening. It is refused the moment the exchange is open, because a real balance comes from a real deposit.<br><b>Adjust</b> is the one that works while the exchange is OPEN: it corrects a balance that is wrong — a payment that arrived but was never credited, a double credit to claw back, a goodwill payment. A minus takes money away. It writes a ledger row so the books still balance, records who did it and why, and sends it to Telegram at once, so an adjustment nobody made is visible in seconds rather than at the next reconciliation.</p></div>'
      + table(['id', 'email', '2FA', 'USD available + locked', 'PCN available + locked', 'state', ''], rows, 'No users yet.');
  }

  // Everything that happened, newest first. The exchange writes these rows as it
  // works and sends them to Telegram from its tick loop, so this page and the
  // channel show the same thing — and a Telegram outage delays the channel, never
  // the exchange.
  async function activity() {
    const r = await call('GET', '/admin/api/activity');
    if (!ok(r)) return unknown('the activity feed', r);
    const KIND = { account: '🆕', signin: '🔑', order: '📋', trade: '💱', deposit: '💰' };
    const rows = r.json.events.map((e) => `<tr><td>${esc(when(e.at))}</td><td>${KIND[e.kind] || ''} ${esc(e.kind)}</td>
      <td>${esc(e.text)}</td><td>${e.sent_at ? '<span class="muted">sent</span>' : '<b>waiting</b>'}</td></tr>`);
    const waiting = Number(r.json.waitingToSend || 0);
    return '<div class="card"><p class="muted">Sign-ups, sign-ins, orders, fills and deposit credits — kept for 30 days. '
      + (waiting ? `<b>${waiting} waiting to reach Telegram</b> (they go out on the next tick; nothing is lost if it refuses).` : 'Everything has reached Telegram.')
      + ' Withdrawals have their own page, and each request is announced the moment it is made.</p></div>'
      + table(['time', 'what', 'detail', 'telegram'], rows, 'Nothing yet.');
  }

  async function book() {
    const [b, t] = await Promise.all([call('GET', '/admin/api/book'), call('GET', '/admin/api/trades')]);
    if (!ok(b)) return unknown('the order book', b);
    if (!ok(t)) return unknown('trades', t);
    const level = (x) => `<tr><td>${esc(usd(x.price_micro))}</td><td>${esc(pcn(x.qty_sat))}</td><td>${esc(x.orders)}</td></tr>`;
    return '<div class="card"><h2>Asks</h2></div>' + table(['price', 'PCN', 'orders'], b.json.asks.map(level), 'No asks.')
      + '<div class="card"><h2>Bids</h2></div>' + table(['price', 'PCN', 'orders'], b.json.bids.map(level), 'No bids.')
      + '<div class="card"><h2>Trades</h2></div>' + table(['time', 'price', 'PCN', 'taker', 'house'],
        t.json.map((x) => `<tr><td>${esc(when(x.at))}</td><td>${esc(usd(x.price_micro))}</td><td>${esc(pcn(x.qty_sat))}</td><td>${esc(x.taker_side)}</td><td>${String(x.house_involved) === '1' ? 'house' : 'users'}</td></tr>`), 'No trades.');
  }

  // What trading here is doing to the PCN price everyone reads.
  async function price() {
    const r = await call('GET', '/admin/api/price');
    if (!ok(r)) return unknown('the price influence', r);
    const p = r.json;
    const pct = (v) => { const n = big(v); return n === null ? '?' : `${n > 0n ? '+' : ''}${(Number(n) / 10000).toFixed(2)}%`; };
    const list = (xs) => (Array.isArray(xs) && xs.length ? xs.map((x) => esc(String(x))).join('; ') : '—');
    const state = p.enabled
      ? '<b class="good">ON</b> — the nudge below is applied to the price the exchange publishes'
      : '<b>OFF</b> — everything below is measured, nothing is applied';
    return `<div class="card"><h2>What trading here does to the PCN price</h2>
      <p>${state}. ${form('setting', hidden('key', 'price_influence_enabled') + '<select name="value"><option value="true">switch it ON</option><option value="false">switch it OFF</option></select>', 'Apply')}</p>
      <table>
        <tr><td style="width:46%">price.pc.am right now (the anchor)</td><td><b>${esc(p.anchorUsd ?? '—')}</b></td></tr>
        <tr><td>What this exchange's own trading says</td><td><b>${esc(p.indexUsd ?? '—')}</b> ${p.indexMicro ? '' : '<span class="muted">not enough trading</span>'}</td></tr>
        <tr><td>Published price after the nudge</td><td><b>${esc(p.suggestedUsd ?? '—')}</b> (${esc(pct(p.appliedPpm))} from the anchor)</td></tr>
        <tr><td>Where it is heading</td><td>${esc(pct(p.targetPpm))}, moving ${esc(pct(p.movedPpm))} this tick</td></tr>
        <tr><td>Held back by</td><td>${list(p.limitedBy)}</td></tr>
        <tr><td>Why it is not moving further</td><td>${list(p.reasons)}</td></tr>
      </table></div>
      <div class="card"><h2>The trading it counted</h2><table>
        <tr><td style="width:46%">User-to-user fills in the window</td><td>${esc(String(p.trades ?? 0))} across ${esc(String(p.accounts ?? 0))} accounts, ${esc(String(p.pairs ?? 0))} pairs</td></tr>
        <tr><td>PCN that counted</td><td>${esc(p.volumePcn ?? '0')}</td></tr>
        <tr><td>Ignored: outside the band around the anchor</td><td>${esc(String(p.outsideBand ?? 0))}</td></tr>
        <tr><td>Ignored: over one pair's limit</td><td>${esc(String(p.cappedTrades ?? 0))}</td></tr>
        <tr><td>Last worked out</td><td>${p.at ? esc(when(p.at)) : '<span class="muted">no tick yet</span>'}</td></tr>
      </table>
      <p class="muted" style="margin-top:10px">How it works. Someone buying PCN here lifts the price of the fills, someone selling pushes it down, and the middle of that trading (weighted by size) is what this exchange says PCN is worth. The published price walks toward it slowly.<br><br>
      Three rules stop anyone steering it. <b>Fills against our own bots do not count at all</b> — the bots quote off price.pc.am, so counting them would let someone buy from us to push our own price up. <b>One pair of accounts can only count so much volume</b>, because two accounts trading with each other is not a market. <b>And the move is limited</b>: each trade may move it only so far (0.5% by default), with a daily cap and a total distance it may never pass from price.pc.am. Time alone never pushes it further out — but a nudge does unwind on its own when trading stops. Too few trades, too few accounts or too little volume means no nudge at all, and the price fades back to the anchor.<br><br>
      Every limit is in Settings: price_index_* choose which trading counts, price_influence_* choose how far and how fast it may move.</p></div>`;
  }

  async function policy() {
    const r = await call('GET', '/admin/api/policy');
    if (!r.readable) return unknown('the policy', r);
    const p = r.json;
    return `<div class="card"><p>${p ? `Version <b>${esc(p.version)}</b>, published ${esc(when(p.created_at))}.` : '<b class="bad">No policy published — nobody can trade or withdraw until one is.</b>'}</p>
      <p class="muted">Publishing a new version makes every user accept it again before they can trade or withdraw.</p>
      <form method="POST" action="${self}">${hidden('action', 'policy')}
        <p><textarea name="body" rows="20" style="width:100%">${esc(p ? p.body : '')}</textarea></p>
        <div class="inline" style="display:flex;gap:8px">${codeInput} <button type="submit">Publish</button></div></form></div>`;
  }

  function pool() {
    return `<div class="card"><h2>Import deposit addresses</h2>
      <p class="muted">Pre-derived offline from the ONE exchange wallet (contrib/vault/pcoin-seed-vault.mjs). Paste the list only — never an xpub, never a key.
      The two expected addresses are the ones the vault tool printed: a wrong-wallet file has the right shape and the wrong content, and this is what catches it.
      Import the receive chain AND a range of the change chain, or every PCN withdrawal will look like the wallet lost its change.</p>
      <form method="POST" action="${self}">${hidden('action', 'pool')}
        <p><select name="chain"><option value="0">receive chain (0) — one address per user</option><option value="1">change chain (1) — watched, never credited</option></select>
        <input name="expectStartIndex" type="text" placeholder="start index" style="width:9em"></p>
        <p><input name="expectFirst" type="text" placeholder="first address, as printed by the vault tool" style="width:100%"></p>
        <p><input name="expectLast" type="text" placeholder="last address, as printed by the vault tool" style="width:100%"></p>
        <p><textarea name="text" rows="12" style="width:100%;font-family:Menlo,Consolas,monospace" placeholder="1000 pc1q...&#10;1001 pc1q..."></textarea></p>
        <div style="display:flex;gap:8px">${codeInput} <button type="submit">Import</button></div></form></div>`;
  }

  async function audit() {
    const r = await call('GET', '/admin/api/audit');
    if (!ok(r)) return unknown('the audit log', r);
    return table(['time', 'actor', 'action', 'subject', 'old', 'new', 'detail'], r.json.map((a) => `<tr><td>${esc(when(a.at))}</td><td>${esc(a.actor)}</td>
      <td>${esc(a.action)}</td><td>${esc(a.subject || '')}</td><td>${esc(a.old_value || '')}</td><td>${esc(a.new_value || '')}</td><td>${esc(a.detail || '')}</td></tr>`), 'Nothing yet.');
  }

  const RENDER = { overview, activity, withdrawals, deposits, settings, users, book, price, policy, pool, audit };

  async function page(url, flash = null) {
    if (!ex || !ex.apiUrl || !ex.readToken) {
      return '<div class="card"><p class="bad">Not configured.</p><p class="muted">upstream.json needs an <code>exchange</code> entry with <code>apiUrl</code> and <code>readToken</code>. This panel must never hold the exchange admin 2FA secret.</p></div>';
    }
    const requested = url.searchParams.get('view');
    const view = RENDER[requested] ? requested : 'overview';
    const note = flash ? `<div class="card" style="border-left:4px solid var(--${flash.ok ? 'green' : 'red'})"><p${flash.ok ? '' : ' class="bad"'}>${esc(flash.text)}</p></div>` : '';
    return `<p class="muted" style="margin-top:-10px;margin-bottom:14px">Read here; every change asks for the code from your <b>PCoin Exchange admin</b> authenticator entry.</p>`
      + tabs(view) + note + await RENDER[view](url);
  }

  async function action(f, url) {
    const back = (view, id = null) => {
      const u = new URL(url);
      u.search = '';
      u.searchParams.set('view', view);
      if (id) u.searchParams.set('id', id);
      return u;
    };
    if (!ex || !ex.apiUrl || !ex.readToken) return { url: back('overview'), flash: { ok: false, text: 'The exchange is not configured in upstream.json.' } };
    const act = String(f.get('action') || '');
    const id = () => {
      const v = String(f.get('id') || '');
      if (!/^\d{1,18}$/.test(v)) throw new Error('bad id');
      return v;
    };
    const reason = () => String(f.get('reason') || '');
    const specs = {
      setting: () => ['/admin/api/settings', { key: f.get('key'),
        value: f.get('type') === 'list' ? String(f.get('value') || '').split(',').map((x) => x.trim()).filter(Boolean) : f.get('value') }, 'settings'],
      approve: () => [`/admin/api/withdrawals/${id()}/approve`, {}, 'withdrawals'],
      reject: () => [`/admin/api/withdrawals/${id()}/reject`, { reason: reason() }, 'withdrawals'],
      txid: () => [`/admin/api/withdrawals/${id()}/txid`, { txid: String(f.get('txid') || '').trim() }, 'withdrawals'],
      clear: () => [`/admin/api/withdrawals/${id()}/clear`, { reason: reason() }, 'withdrawals'],
      orphan: () => [`/admin/api/deposits/${id()}/orphan`, { reason: reason() }, 'deposits'],
      user_disable: () => [`/admin/api/users/${id()}/disable`, { disabled: f.get('disabled') === 'true', reason: reason() }, 'users'],
      twofa_reset: () => [`/admin/api/users/${id()}/2fa-reset`, { reason: reason() }, 'users'],
      policy: () => ['/admin/api/policy', { body: String(f.get('body') || '') }, 'policy'],
      pool: () => ['/admin/api/pool', { chain: Number(f.get('chain')), text: String(f.get('text') || ''),
        expectStartIndex: f.get('expectStartIndex') ? Number(f.get('expectStartIndex')) : null,
        expectFirst: f.get('expectFirst') || null, expectLast: f.get('expectLast') || null }, 'pool'],
      house_address: () => ['/admin/api/house/ask-address', {}, 'overview'],
      user_credit: () => [`/admin/api/users/${id()}/credit`, { asset: f.get('asset'), amount: String(f.get('amount') || '').trim() }, 'users'],
      user_adjust: () => [`/admin/api/users/${id()}/adjust`, { asset: f.get('asset'), amount: String(f.get('amount') || '').trim(), reason: String(f.get('reason') || '').trim() }, 'users'],
      house_balance: () => {
        const [bot, asset] = String(f.get('which') || '').split(':');
        return ['/admin/api/house/balance', { bot, asset, amount: String(f.get('amount') || '').trim() }, 'overview'];
      },
      halt: () => ['/admin/api/halt', { reason: reason() }, 'overview'],
      halt_clear: () => ['/admin/api/halt/clear', {}, 'overview'],
      cancel_all: () => ['/admin/api/orders/cancel-all', { houseOnly: f.get('houseOnly') !== 'false', reason: reason() }, 'overview'],
    };
    if (!specs[act]) return { url: back('overview'), flash: { ok: false, text: `Unknown action ${act}.` } };
    let path; let body; let view;
    try { [path, body, view] = specs[act](); } catch (e) { return { url: back('overview'), flash: { ok: false, text: e.message } }; }

    const r = await call('POST', path, { body, code: String(f.get('code') || '').trim() });
    const text = !r.readable
      ? `UNKNOWN — the exchange did not answer (${r.reason}). The change may or may not have happened. Reload and check before trying again.`
      : r.status === 200 ? `Done: ${act.replace('_', ' ')}.` : `Refused (${r.status}): ${r.json.error}`;
    return { url: back(view, view === 'withdrawals' ? f.get('id') : null), flash: { ok: ok(r), text } };
  }

  return { page, action };
}
