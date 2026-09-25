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
import { qrSvg } from './qr.mjs';
import { makeLister, listParams, cleanListQs, pill } from './exchange-lists.mjs';
import { createHash } from 'node:crypto';
import { marketSend, hotBalance, appendLog } from './send.mjs';
import { keeperStatus, keeperSend, usdToMicro } from './keeper-pay.mjs';

const VIEWS = [
  ['overview', 'Overview'], ['activity', 'Activity'], ['withdrawals', 'Withdrawals'], ['deposits', 'Deposits'], ['settings', 'Settings'],
  ['users', 'Users'], ['referrals', 'Referrals'], ['book', 'Book & trades'], ['orders', 'Orders'], ['price', 'Price influence'], ['policy', 'Policy'], ['pool', 'Address pool'], ['audit', 'Audit log'],
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

// Lifted out of exchangeSection so the DASHBOARD can make the same read-only
// calls without rendering a page.
//
// The transport rules below are a security boundary -- loopback HTTP, or HTTPS
// pinned to the exchange's own CA, and nothing else -- so they get exactly one
// implementation. A second copy written for the dashboard is a second place for
// the pinning to be quietly dropped.
export function exchangeCall(ex, actor, method, path, { body = null, code = null } = {}) {
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

export function exchangeSection({ base, creds, actor, sendLogPath = null,
  keeper = { status: keeperStatus, send: keeperSend } }) {
  // Its own log beside the PCN one: sends.json totals PCN, and a USDT row in it
  // would be summed as PCN.
  const keeperLogPath = sendLogPath ? sendLogPath.replace(/sends\.json$/, 'keeper-sends.json') : null;
  const ex = creds && creds.exchange ? creds.exchange : null;
  const self = `${base}/exchange`;

  const call = (method, path, opts = {}) => exchangeCall(ex, actor, method, path, opts);

  const ok = (r) => r.readable && r.status === 200;
  const tabs = (active) => `<div class="card xtabs">${VIEWS.map(([k, l]) =>
    `<a href="${self}?view=${k}"${k === active ? ' class="on"' : ''}>${esc(l)}</a>`).join('')}</div>`;
  // The list state (search, filters, page) of the page being rendered, carried
  // through every form as `ret` so an action lands back on the same filtered
  // page instead of dumping the owner at the top of an unfiltered list.
  let retQs = '';
  const unknown = (what, r) => `<div class="card"><p class="bad"><b>UNKNOWN</b> — could not read ${esc(what)} from the exchange:
    ${esc(r.reason || (r.json && r.json.error) || `HTTP ${r.status}`)}</p><p class="muted">This is not "nothing to do". Check the pcoin-exchange container on this host.</p></div>`;
  const hidden = (n, v) => `<input type="hidden" name="${esc(n)}" value="${esc(v)}">`;
  const codeInput = '<input name="code" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="exchange 2FA" required style="width:9em">';
  const form = (action, fields, label, danger = false) => `<form method="POST" action="${self}" class="inline" style="margin:4px 0">
    ${hidden('action', action)}${retQs ? hidden('ret', retQs) : ''}${fields}${codeInput}<button type="submit"${danger ? ' style="background:var(--red);border-color:var(--red)"' : ''}>${esc(label)}</button></form>`;
  const table = (head, rows, empty) => `<div class="card" style="padding:0;overflow-x:auto"><table><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr>
    ${rows.length ? rows.join('') : `<tr><td colspan="${head.length}" class="muted">${esc(empty)}</td></tr>`}</table></div>`;
  const mono = (s) => `<code>${esc(s)}</code>`;
  const listPage = makeLister({ self, call, unknown });

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
        <tr><td>Set a bot balance</td><td>${form('house_balance', '<select name="which"><option value="ask:PCN">ask bot PCN</option><option value="bid:USD">bid bot USD</option><option value="bounty:PCN">referral bounty PCN</option></select> <input name="amount" type="text" inputmode="decimal" placeholder="30000" required style="width:120px">', 'Set balance')}</td></tr></table>
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
        <tr><td>PCN deposits vs chain</td><td>${rec ? `${esc(rec.state)} at ${esc(when(rec.at))}${rec.reason ? ` (${esc(String(rec.reason).slice(0, 160))})` : ''}${rec.diff !== undefined ? ` (received minus recorded: ${esc(rec.diff)} sat)` : ''}${rec.pcnOwed !== undefined ? ` · PCN owed ${esc(pcn(rec.pcnOwed))}, exchange wallet holds ${esc(pcn(rec.onchain))}` : ''}` : '<span class="muted">not run yet</span>'}</td></tr>
        <tr><td>House bots</td><td>${bots ? (bots.price && bots.price.usable ? `price ${esc(bots.price.sellPriceUsd)} at ${esc(when(bots.at))}` : `<span class="warn">off the book: ${esc((bots.price && bots.price.reason) || 'price unusable')}</span>`) : '<span class="muted">not run yet</span>'}</td></tr>
      </table></div>
      ${houseCard}
      <div class="card"><h2>Emergency</h2>
        ${o.halted ? '' : form('halt', '<input name="reason" type="text" placeholder="why" required>', 'Halt everything', true)}
        ${form('cancel_all', '<input name="reason" type="text" placeholder="why" required><select name="houseOnly"><option value="true">house orders only</option><option value="false">ALL orders</option></select>', 'Cancel orders')}
      </div>`;
  }

  /**
   * A QR of the destination, so a payout can be sent from a phone instead of
   * retyping an address (owner, 2026-09-17). Typing is the failure mode worth
   * removing here: these are one-way payments to an address the recipient
   * chose, and a single wrong character sends somebody else's money nowhere.
   *
   * PCN gets a `pcoin:` payment URI carrying the amount, which our own wallets
   * parse (PaymentUri.cs accepts pcoin:, PCN: and bitcoin:), so the amount is
   * filled in as well and cannot be mistyped either. USDT gets the bare
   * address: every wallet reads that, whereas an EIP-681 or TRON amount URI is
   * read by some and silently mangled by others, and a mangled amount on a
   * chain with no undo is worse than typing the number by hand.
   *
   * The amount is NOT put in the PCN URI when the status is anything but
   * approved/requested -- a paid withdrawal showing a scannable amount invites
   * paying it twice.
   */
  //! Is this withdrawal still waiting to be sent? Everything else has either
  //! been paid or returned, and neither wants a scannable destination.
  function payable(w) { return ['requested', 'approved'].includes(w.status); }

  //! Enough of the address to recognise it, not enough to pay it by eye.
  // WHERE THE REQUEST CAME FROM. Three states, and they are NOT the same:
  //   no ip at all      -- this row predates the recording, so we never knew
  //   ip but no country -- we asked and the service could not place it
  //   ip and a country  -- the useful case
  // A blank cell would collapse all three into "nothing unusual", which is
  // exactly the reading that makes a location field worthless.
  function flagOf(cc) {
    const c = String(cc || '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(c)) return '';
    return String.fromCodePoint(...[...c].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
  }
  function geoCell(w) {
    if (!w.ip) return '<span class="dim">not recorded — this request predates IP logging</span>';
    const g = w.geo || {};
    const bits = [];
    const place = [g.city, g.country].filter(Boolean).join(', ');
    if (place) bits.push(`${flagOf(g.country)} ${esc(place)}`.trim());
    bits.push(mono(w.ip));
    if (g.isp) bits.push(esc(g.isp));
    if (!place) bits.push('<span class="dim">location unknown</span>');
    return bits.join(' &middot; ');
  }

  function maskAddr(a) {
    const s = String(a || '');
    return s.length <= 18 ? s : s.slice(0, 8) + '…' + s.slice(-6);
  }

  function payQr(w) {
    // ONCE SOMETHING HAS BEEN SENT, THERE IS NOTHING TO SCAN.
    //
    // Owner, 2026-09-17, looking at a paid_unverified row: "it should not show
    // Scan to pay when open that, it should hide the address and tell already
    // paid." He is right, and the reason is worse than untidiness: double
    // payment is the standard failure of every manual payout flow, and a
    // working QR on a row that has already been paid is the mechanism for it.
    // The address is masked too -- recognisable, not re-payable by eye.
    if (!payable(w)) {
      const state = w.status === 'paid'
        ? '<b class="ok">Already paid</b> and confirmed on the chain.'
        : w.status === 'paid_unverified'
          ? '<b class="warn">Already sent.</b> A transaction id is recorded and the chain has not confirmed it yet. <b>Do not send it again.</b>'
          : `<b>${esc(w.status.replace('_', ' '))}</b> — nothing to send.`;
      return `<div class="muted">${state}${w.txid ? `<br>Transaction: ${mono(w.txid)}` : ''}
        <br>Destination ${mono(maskAddr(w.address))} — shown in full only while a payment is still owed.</div>`;
    }
    const payload = w.network === 'PCN'
      ? `pcoin:${w.address}?amount=${String(w.amount).trim()}`
      : String(w.address).trim();
    let svg;
    try {
      svg = qrSvg(payload, { scale: 4, quiet: 3 });
    } catch (e) {
      // Never render a wrong QR. An address too long for the encoder, or any
      // other refusal, shows as text rather than as a symbol that scans to
      // something else.
      return `<span class="bad">no QR (${esc(e.message)})</span>`;
    }
    return `<div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">
      <div style="background:#fff;padding:6px;border-radius:8px;line-height:0">${svg}</div>
      <div class="muted" style="font-size:13px;max-width:30em">
        ${w.network === 'PCN'
          ? 'Scan with a PCoin wallet — address <b>and amount</b> are both in the code.'
          : 'Scan with your USDT wallet. The code carries the <b>address only</b> — set the amount and the network yourself, and check both.'}
        <br>Network: <b>${esc(w.network)}</b>
      </div></div>`;
  }

  // The payout card. Unchanged in substance -- this is what the owner reads
  // before sending money -- only lifted into its own function so the list
  // below can page and filter independently of which withdrawal is open.
  // ONE CLICK TO PAY A PCN WITHDRAWAL FROM market-hot (owner, 2026-09-24: "I
  // click and done, everything should be automatic and set the tx"). One
  // exchange 2FA code does all three steps -- approve, send, record -- and the
  // amount and address come from the exchange's own record of the withdrawal,
  // never from anything typed, so there is nothing to mistype.
  const hotPayable = (w) => w && w.network === 'PCN' && (w.status === 'requested' || w.status === 'approved');
  function payFromHotBox(w, hot) {
    if (!hotPayable(w)) return '';
    if (!(creds && creds.market && creds.market.sendToken)) {
      return '<p class="muted">Paying from market-hot is not configured here (no market sendToken), so send it by hand below.</p>';
    }
    const amt = Number(w.amount);
    const bal = hot && hot.hotPcn !== null
      ? (hot.hotPcn >= amt
        ? `<span class="ok">market-hot holds ${esc(hot.hotPcn.toLocaleString('en-US', { maximumFractionDigits: 8 }))} PCN — enough.</span>`
        : `<span class="bad">market-hot holds only ${esc(hot.hotPcn.toLocaleString('en-US', { maximumFractionDigits: 8 }))} PCN — NOT enough for this; the market host will refuse it.</span>`)
      : `<span class="warn">market-hot's balance could not be read (${esc((hot && hot.hotError) || 'unknown')}); the market host checks it itself.</span>`;
    return `<div style="border:1px solid var(--green);border-radius:8px;padding:10px 12px;margin:0 0 12px">
      <p style="margin:0 0 6px"><b>Pay from market-hot</b> — ${bal}</p>
      <p class="muted" style="margin:0 0 8px">One click, one code: ${w.status === 'requested' ? 'approves it, ' : ''}sends exactly <b>${esc(w.amount)} PCN</b> to the address above from market-hot, and records the transaction here. It can never pay this withdrawal twice.</p>
      ${form('pay_hot', hidden('id', w.id), `Pay ${w.amount} PCN from market-hot`)}</div>`;
  }

  // ONE CLICK TO PAY A USDT (BNB Smart Chain) WITHDRAWAL FROM THE KEEPER
  // (owner, 2026-09-25). Same shape as market-hot above: one code approves,
  // sends and records; amount and address come from the exchange's record;
  // pcoin-keeper-pay's own ledger makes a second press return the same
  // transaction. TRON withdrawals cannot be paid from here: the keeper is a
  // BNB Smart Chain wallet.
  const keeperPayable = (w) => w && w.network === 'BEP20' && (w.status === 'requested' || w.status === 'approved');
  const usd2 = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  function payFromKeeperBox(w, k) {
    if (!keeperPayable(w)) return '';
    const amt = Number(w.amount);
    let bal;
    if (!k || !k.ok) {
      bal = `<span class="warn">the keeper's balance could not be read (${esc((k && k.error) || 'unknown')}); the tool checks it again before sending.</span>`;
    } else {
      const left = k.usdt - amt;
      bal = left >= k.min_usdt
        ? `<span class="ok">the keeper holds ${esc(usd2(k.usdt))} USDT — enough; ${esc(usd2(left))} stays for defending the floor.</span>`
        : `<span class="bad">the keeper holds only ${esc(usd2(k.usdt))} USDT — paying ${esc(usd2(amt))} would take it under its own ${esc(usd2(k.min_usdt))} USDT floor, so the tool will refuse.</span>`;
      if (k.busy) bal += ` <span class="warn">${esc(k.busy)} — wait a minute before pressing.</span>`;
      if (Number(k.bnb) < 0.001) bal += ` <span class="bad">Only ${esc(k.bnb)} BNB for gas.</span>`;
    }
    return `<div style="border:1px solid var(--yellow);border-radius:8px;padding:10px 12px;margin:0 0 12px">
      <p style="margin:0 0 6px"><b>Pay from keeper</b> — ${bal}</p>
      <p class="muted" style="margin:0 0 8px">One click, one code: ${w.status === 'requested' ? 'approves it, ' : ''}sends exactly <b>${esc(w.amount)} USDT on BNB Smart Chain</b> to the address above from the keeper wallet${k && k.address ? ` (<code>${esc(k.address)}</code>)` : ''}, and records the transaction here. It can never pay this withdrawal twice. The keeper's USDT is also what buys wPCN when the pool falls below $0.015, so every dollar paid here is a dollar it cannot defend the floor with.</p>
      ${form('pay_keeper', hidden('id', w.id), `Pay ${w.amount} USDT from keeper`)}</div>`;
  }

  function withdrawalCard(w, hot = null, kst = null) {
    const amount = w.network === 'PCN' ? `${w.amount} PCN` : `${w.amount} USDT`;
    const net = { TRC20: 'TRON (TRC20)', BEP20: 'BNB Smart Chain (BEP20)', PCN: 'PCoin' }[w.network];
    return `<div class="card" style="border-left:4px solid var(--blue)">
        <h2>Withdrawal #${esc(w.id)} — ${esc(w.status.replace('_', ' '))}</h2>
        ${w.requestedWithTwofa ? '' : '<p class="bad"><b>Requested WITHOUT two-factor.</b> Sign-in is shared with market.pc.am; if that account were compromised this is what it would look like. Confirm with the user before paying.</p>'}
        <table>
          <tr><td style="width:28%">User</td><td>${esc(w.email)} (account ${esc(w.accountId)})</td></tr>
          <tr><td>Send exactly</td><td style="font-size:20px"><b>${esc(amount)}</b></td></tr>
          <tr><td>On network</td><td style="font-size:17px"><b>${esc(net)}</b></td></tr>
          <tr><td>To address</td><td style="font-size:16px">${payable(w) ? mono(w.address) : mono(maskAddr(w.address))}</td></tr>
          <tr><td>${payable(w) ? 'Scan to pay' : 'Payment'}</td><td>${payQr(w)}</td></tr>
          <tr><td>Fee charged to the user</td><td>${esc(w.fee)}</td></tr>
          <tr><td>Waiting</td><td${w.ageSeconds >= 18 * 3600 && payable(w) ? ' class="bad"' : ''}>${esc(age(w.ageSeconds))}${payable(w) ? ' (promised within 24 h)' : ''}</td></tr>
          <tr><td>Requested from</td><td>${geoCell(w)}</td></tr>
          <tr><td>Balance came from</td><td>${w.sources.pcnDepositsCredited} PCN deposit(s), ${w.sources.usdDepositsCredited} USD deposit(s), ${w.sources.trades} trade(s)</td></tr>
          ${w.txid ? `<tr><td>Txid</td><td>${mono(w.txid)}</td></tr>` : ''}
          ${w.verifyDetail ? `<tr><td>Chain check</td><td${/MISMATCH/.test(w.verifyDetail) ? ' class="bad"' : ''}>${esc(w.verifyDetail)}</td></tr>` : ''}
          ${w.approveExpiresAt ? `<tr><td>Approval expires</td><td>${esc(when(w.approveExpiresAt))}</td></tr>` : ''}
        </table>
        <div style="margin-top:12px">
        ${payFromHotBox(w, hot)}
        ${payFromKeeperBox(w, kst)}
        ${w.status === 'requested' ? form('approve', hidden('id', w.id), 'Approve') + form('reject', `${hidden('id', w.id)}<input name="reason" type="text" placeholder="reason" required>`, 'Reject and return the funds') : ''}
        ${w.status === 'approved' ? `<p>Send it from your own wallet, then paste the transaction id. It is marked paid only once the chain confirms the amount and address match.</p>
          ${form('txid', `${hidden('id', w.id)}<input name="txid" type="text" placeholder="transaction id" required style="min-width:28em">`, 'Record payment')}
          ${form('reject', `${hidden('id', w.id)}<input name="reason" type="text" placeholder="reason" required>`, 'Reject and return the funds')}` : ''}
        ${w.status === 'paid_unverified' ? `<p class="muted">Waiting for the chain to confirm. If the txid was pasted against the wrong withdrawal, clear it.</p>
          ${form('clear', `${hidden('id', w.id)}<input name="reason" type="text" placeholder="why" required>`, 'Clear the txid')}` : ''}
        </div></div>`;
  }

  // The flag OR the code, never both: Windows draws a flag emoji as its two
  // letters, so "flag + code" read as "AM AM" on the owner's own machine.
  const place = (country, ip) => {
    if (!ip && !country) return '<span class="dim">—</span>';
    const tag = flagOf(country) || esc(country || '');
    return `${tag ? `<span title="${esc(country || '')}">${tag}</span> ` : ''}${ip ? `<span class="dim" style="font-size:11px">${esc(ip)}</span>` : ''}`;
  };
  const who = (email, id) => (email ? esc(email) : `<span class="dim">account ${esc(id)}</span>`);
  const WD_DEFAULTS = { f_status: 'open', sort: 'created', dir: 'asc' };

  async function withdrawals(url) {
    // Which withdrawal is open: the one in the URL, or else the oldest in the
    // queue. Fetched on its own so the focus survives paging and filtering --
    // it used to be found in "the rows on this page", which paging would break.
    let w = null;
    const focusId = url.searchParams.get('id');
    if (focusId && /^\d{1,18}$/.test(focusId)) {
      const r = await call('GET', `/admin/api/withdrawals/${focusId}`);
      if (ok(r)) w = r.json;
    }
    let queueUnknown = null;
    if (!w) {
      const q = await call('GET', '/admin/api/list/withdrawals?f_status=open&sort=created&dir=asc&per=10');
      if (!ok(q)) queueUnknown = unknown('the withdrawal queue', q);
      else if (q.json.rows.length) w = q.json.rows[0];
    }
    const hot = hotPayable(w) && creds && creds.market && creds.market.sendToken ? await hotBalance(creds) : null;
    const kst = keeperPayable(w) ? await keeper.status() : null;
    const focus = queueUnknown || (w ? withdrawalCard(w, hot, kst) :'<div class="card"><p class="ok"><b>Nothing waiting.</b> Every withdrawal has been paid or rejected.</p></div>');
    const keep = listParams(url, WD_DEFAULTS).toString().replace(/&/g, '&amp;');
    const L = await listPage(url, {
      view: 'withdrawals', list: 'withdrawals', title: 'the withdrawal list',
      defaults: WD_DEFAULTS, virtualLabels: { open: 'open — the queue' },
      searchHint: 'Search email, address, txid, #id, IP, city…', dateLabel: 'requested',
      columns: [{ label: '#', sort: 'id' }, { label: 'requested', sort: 'created' }, { label: 'network' },
        { label: 'amount', sort: 'amount' }, { label: 'status', sort: 'status' }, { label: '2FA' }, { label: 'from' }, { label: 'user' }],
      row: (x) => `<tr${w && x.id === w.id ? ' style="background:rgba(96,165,250,.10)"' : ''}>
        <td><a href="${self}?view=withdrawals&amp;id=${esc(x.id)}&amp;${keep}">#${esc(x.id)}</a></td>
        <td>${esc(when(x.createdAt))}${payable(x) || x.status === 'paid_unverified' ? `<br><span class="dim">${esc(age(x.ageSeconds))} ago</span>` : ''}</td>
        <td>${esc(x.network)}</td><td><b>${esc(x.amount)}</b></td><td>${pill(x.status)}</td>
        <td>${x.requestedWithTwofa ? '<span class="ok">2FA</span>' : '<span class="bad">no 2FA</span>'}</td>
        <td>${x.ip ? place(x.geo && x.geo.country, x.ip) : '<span class="dim">not recorded</span>'}</td>
        <td>${who(x.email, x.accountId)}</td></tr>`,
      empty: 'No withdrawals yet.',
    });
    return focus + L.html;
  }

  async function deposits(url) {
    const kind = url.searchParams.get('kind') === 'usd' ? 'usd' : 'pcn';
    const sub = `<div class="xtabs sub">
      <a class="${kind === 'pcn' ? 'on' : ''}" href="${self}?view=deposits&amp;kind=pcn">PCN deposits</a>
      <a class="${kind === 'usd' ? 'on' : ''}" href="${self}?view=deposits&amp;kind=usd">USD (NOWPayments)</a></div>`;
    if (kind === 'pcn') {
      const L = await listPage(url, {
        view: 'deposits', sub: { name: 'kind', value: 'pcn' }, list: 'deposits_pcn', title: 'PCN deposits',
        searchHint: 'Search email, txid, address, #id…', dateLabel: 'seen',
        columns: [{ label: 'id', sort: 'id' }, { label: 'seen', sort: 'seen' }, { label: 'user' }, { label: 'amount', sort: 'amount' },
          { label: 'status' }, { label: 'conf' }, { label: 'height', sort: 'height' }, { label: 'txid' }, { label: 'note' }],
        row: (d) => `<tr><td>${esc(d.id)}</td><td>${esc(when(d.first_seen_at))}</td><td>${who(d.email, d.account_id)}</td>
          <td><b>${esc(pcn(d.amount_sat))}</b>${String(d.is_coinbase) === '1' ? ' <span class="xpill warn">mined</span>' : ''}</td>
          <td>${pill(d.status)}${String(d.reorg_suspect) === '1' ? ' <b class="bad">REORG</b>' : ''}</td>
          <td>${esc(d.confirmations ?? '—')}</td><td>${esc(d.height ?? '—')}</td><td>${mono(d.txid)}</td>
          <td>${esc(d.hold_reason || '')}
          ${['held', 'seen'].includes(d.status) ? form('orphan', `${hidden('id', d.id)}<input name="reason" type="text" placeholder="why this must never be credited" required>`, 'Orphan') : ''}</td></tr>`,
        empty: 'No PCN deposits yet.',
      });
      return sub + L.html;
    }
    const L = await listPage(url, {
      view: 'deposits', sub: { name: 'kind', value: 'usd' }, list: 'deposits_usd', title: 'USD deposits',
      searchHint: 'Search email, payment id, order…', dateLabel: 'updated',
      columns: [{ label: 'payment', sort: 'id' }, { label: 'user' }, { label: 'status' }, { label: 'amount', sort: 'amount' },
        { label: 'credited at', sort: 'credited' }, { label: 'order' }],
      row: (d) => `<tr><td>${esc(d.payment_id)}</td><td>${who(d.email, d.account_id)}</td><td>${pill(d.status)}</td>
        <td>${d.outcome_amount_micro === null ? '—' : `<b>${esc(usd(d.outcome_amount_micro))}</b>`} ${esc(d.outcome_currency || '')}</td>
        <td>${d.credited_at === null ? '<span class="dim">not credited</span>' : esc(when(d.credited_at))}</td><td>${mono(d.order_id)}</td></tr>`,
      empty: 'No USD deposits yet.',
    });
    return sub + L.html;
  }

  async function settings(url) {
    const r = await call('GET', '/admin/api/settings');
    if (!ok(r)) return unknown('settings', r);
    const { values, defs } = r.json;
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
    const changed = url.searchParams.get('changed') === '1';
    const human = (k, v) => {
      if (Array.isArray(v)) return v.join(', ') || '(empty)';
      if (k.endsWith('_micro')) return usd(v);
      if (k.endsWith('_sat')) return pcn(v);
      if (k.endsWith('_ppm')) return `${Number(v) / 10000}% (×${Number(v) / 1e6})`;
      return String(v);
    };
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const all = Object.entries(defs);
    const shown = all.filter(([k, d]) => (!q || k.toLowerCase().includes(q)) && (!changed || !same(values[k], d.default)));
    const rows = shown.map(([k, d]) => {
      const v = values[k];
      const input = d.type === 'bool'
        ? `<select name="value"><option${v === true ? ' selected' : ''}>true</option><option${v === false ? ' selected' : ''}>false</option></select>`
        : d.type === 'enum'
          ? `<select name="value">${d.values.map((x) => `<option${x === v ? ' selected' : ''}>${esc(x)}</option>`).join('')}</select>`
          : `<input name="value" type="text" value="${esc(Array.isArray(v) ? v.join(', ') : v)}" style="width:15em">`;
      const warn = k === 'bot_bid_daily_budget_micro' ? '<br><b class="bad">This is the ONLY limit on what you can owe.</b>' : '';
      return `<tr><td><b>${esc(k)}</b>${warn}</td><td>${esc(human(k, v))}${same(v, d.default) ? '' : ' <span class="xpill warn">changed</span>'}</td><td class="muted">${esc(human(k, d.default))}</td>
        <td>${form('setting', hidden('key', k) + hidden('type', d.type) + input, 'Save')}</td></tr>`;
    });
    return `<div class="card"><form method="GET" action="${self}" class="xfilters">${hidden('view', 'settings')}
        <input type="search" name="q" value="${esc(q)}" placeholder="Search setting names — e.g. bot, fee, withdraw, price">
        <label><input type="checkbox" name="changed" value="1"${changed ? ' checked' : ''}> only the ones changed from default</label>
        <button type="submit">Filter</button><a class="reset" href="${self}?view=settings">Reset</a></form>
      <p class="muted" style="margin-top:12px">Numbers are in base units: <b>_micro</b> = millionths of a dollar ($1 = 1000000),
      <b>_sat</b> = hundred-millionths of a PCN (1 PCN = 100000000), <b>_ppm</b> = parts per million (0.2% = 2000).
      Lists are comma-separated. Every change is audited and announced in the ops channel.
      A fee or limit named in the terms as a <code>{{placeholder}}</code> updates them the moment you save it here, and every user is asked to accept the new version.</p></div>`
      + `<div class="xsummary"><span>Showing <b>${shown.length}</b> of <b>${all.length}</b> settings</span></div>`
      + table(['setting', 'now', 'default', 'change'], rows, q || changed ? 'No setting matches.' : 'No settings.');
  }

  async function users(url) {
    const L = await listPage(url, {
      view: 'users', list: 'users', title: 'users',
      searchHint: 'Search email, account id, IP, country, city…', dateLabel: 'joined',
      columns: [{ label: 'id', sort: 'id' }, { label: 'email', sort: 'email' }, { label: 'joined', sort: 'created' },
        { label: 'last seen', sort: 'seen' }, { label: '2FA' }, { label: 'USD available + locked', sort: 'usd' },
        { label: 'PCN available + locked', sort: 'pcn' },
        { label: 'state' }, { label: '' }],
      row: (u) => `<tr><td>${esc(u.id)}</td><td>${esc(u.email)}</td>
        <td>${esc(when(u.createdAt))}<br>${place(u.signup && u.signup.country, u.signup && u.signup.ip)}</td>
        <td>${u.last && u.last.seenAt ? esc(when(u.last.seenAt)) : '<span class="dim">—</span>'}<br>${place(u.last && u.last.country, u.last && u.last.ip)}</td>
        <td>${u.hasTwofa ? '<span class="ok">2FA</span>' : '<span class="bad">no 2FA</span>'}</td>
        <td>$${esc(u.usd.available)} + $${esc(u.usd.locked)}</td><td>${esc(u.pcn.available)} + ${esc(u.pcn.locked)}</td>
        <td>${pill(u.disabled ? 'disabled' : 'active')}</td>
        <td><details><summary class="muted" style="cursor:pointer">actions</summary><div style="margin-top:6px">
        ${form('user_disable', `${hidden('id', u.id)}${hidden('disabled', u.disabled ? 'false' : 'true')}<input name="reason" type="text" placeholder="reason" required>`, u.disabled ? 'Enable' : 'Disable')}
        ${u.hasTwofa ? form('twofa_reset', `${hidden('id', u.id)}<input name="reason" type="text" placeholder="how you verified them" required>`, 'Reset 2FA') : ''}
        ${form('user_credit', `${hidden('id', u.id)}<select name="asset"><option value="USD">USD</option><option value="PCN">PCN</option></select><input name="amount" type="text" inputmode="decimal" placeholder="amount" required style="width:90px">`, 'Test credit')}
        ${form('user_adjust', `${hidden('id', u.id)}<select name="asset"><option value="USD">USD</option><option value="PCN">PCN</option></select><input name="amount" type="text" inputmode="decimal" placeholder="+ or -" required style="width:80px"><input name="reason" type="text" placeholder="why (required)" required>`, 'Adjust')}
        </div></details></td></tr>`,
      empty: 'No users yet.',
    });
    return '<div class="card"><p class="muted">A 2FA reset is exactly what an impersonator asks for. Verify the person another way first.<br><b>Test credit</b> puts a balance on an account for testing before opening. It is refused the moment the exchange is open, because a real balance comes from a real deposit.<br><b>Adjust</b> is the one that works while the exchange is OPEN: it corrects a balance that is wrong — a payment that arrived but was never credited, a double credit to claw back, a goodwill payment. A minus takes money away. It writes a ledger row so the books still balance, records who did it and why, and sends it to Telegram at once, so an adjustment nobody made is visible in seconds rather than at the next reconciliation.</p></div>'
      + L.html;
  }

  // Who invited whom, and what is left to pay them with.
  //
  // THE BUDGET LINE IS THE IMPORTANT ONE. house:bounty's PCN balance IS the
  // programme's budget: it cannot go negative, so when it empties, qualified
  // referrals simply wait instead of overspending. An empty budget is a normal
  // state and never an outage -- but nobody gets paid until it is topped up, so
  // it is shown first and in red when it is gone.
  async function referrals(url) {
    const b = await call('GET', '/admin/api/referrals?limit=1');
    if (!ok(b)) return unknown('the referral budget', b);
    const budgetPcn = b.json.budgetPcn;
    const empty = Number(budgetPcn) <= 0;
    const L = await listPage(url, {
      view: 'referrals', list: 'referrals', title: 'referrals',
      searchHint: 'Search code, referrer or referee email…', dateLabel: 'created',
      columns: [{ label: 'id', sort: 'id' }, { label: 'code' }, { label: 'referrer' }, { label: 'referee' },
        { label: 'reward', sort: 'reward' }, { label: 'state' }, { label: 'when', sort: 'created' }, { label: '' }],
      row: (x) => {
        const at = x.paidAt ?? x.qualifiedAt ?? x.createdAt;
        const state = x.state === 'refused' ? `${pill('refused')} <span class="muted">${esc(x.refusedReason || '')}</span>`
          : x.state === 'holding' ? `${pill('holding')} <span class="dim">qualified, in the hold</span>` : pill(x.state);
        return `<tr><td>${esc(x.id)}</td><td>${mono(x.code)}</td><td>${esc(x.referrer)}</td><td>${esc(x.referee)}</td>
          <td>${esc(x.rewardPcn)} PCN</td><td>${state}</td><td class="muted">${esc(when(at))}</td>
          <td>${x.state === 'paid' || x.state === 'refused' ? ''
            : form('referral_refuse', `${hidden('id', x.id)}<input name="reason" type="text" placeholder="why (required)" required>`, 'Refuse')}</td></tr>`;
      },
      empty: 'No referrals yet.',
    });
    return `<div class="card"><p>Budget left to pay with: <b class="${empty ? 'bad' : 'good'}">${esc(budgetPcn)} PCN</b>${empty ? ' — nobody is being paid until it is funded.' : ''}</p>
      <p>${form('house_balance', `${hidden('which', 'bounty:PCN')}Set the pool to <input name="amount" type="text" inputmode="decimal" placeholder="3000" required style="width:120px"> PCN`, 'Set pool')}</p>
      <p class="muted">This SETS the pool, it does not add to it: paying out reduces the balance, so topping up means setting it back to the figure you want available.
      No coins move — it is a ledger balance, and real PCN only leaves when somebody actually withdraws.</p>
      <p class="muted">A referral is paid only when the referee has BOTH deposited real money and bought PCN with it, and only after the hold.
Fund it below; the balance is the whole budget and cannot go negative, so a bug costs at most what you funded. <b>Refuse</b> stops one before it is paid — a paid referral is already a ledger fact and cannot be undone here.</p></div>`
      + L.html;
  }

  // Everything that happened, newest first. The exchange writes these rows as it
  // works and sends them to Telegram from its tick loop, so this page and the
  // channel show the same thing — and a Telegram outage delays the channel, never
  // the exchange.
  // EVERY DETAIL OF A FILL (owner, 2026-09-24: "I should see every detail, who
  // and from whom bought and sold, which price and everything else"). The trade
  // EVENT is one line of text ("bot:bid BOUGHT 392 PCN at $0.019134") that
  // names only one side, so the trades view reads the fill itself: both
  // accounts (a bot by its name), both orders -- what each side asked for, how
  // much of it filled, when it was placed -- where each was placed from, who
  // took whom, and the fees.
  const whenS = (t) => (t === null || t === undefined ? '—' : new Date(Number(t) * 1000).toISOString().replace('T', ' ').slice(0, 19));
  const party = (x, s) => {
    const o = s === 'buyer' ? 'buy' : 'sell';
    const name = x[`${s}_email`] ? esc(x[`${s}_email`])
      : x[`${s}_name`] ? `<b>${esc(x[`${s}_name`])}</b>` : `<span class="dim">account ${esc(x[`${s}_id`])}</span>`;
    const ord = x[`${o}_order_price_micro`] !== null && x[`${o}_order_price_micro`] !== undefined
      ? `order #${esc(x[`${o}_order_id`])}: ${esc(pcn(x[`${o}_order_qty_sat`]))} at ${esc(usd(x[`${o}_order_price_micro`]))}, ${esc(pcn(x[`${o}_order_filled_sat`]))} filled, ${esc(x[`${o}_order_status`])}, placed ${esc(whenS(x[`${o}_order_at`]))}`
      : `order #${esc(x[`${o}_order_id`])}`;
    const city = x[`${s}_city`] ? ` <span class="dim" style="font-size:11px">${esc(x[`${s}_city`])}</span>` : '';
    return `${name} <span class="dim">#${esc(x[`${s}_id`])}</span><br><span class="muted" style="font-size:12px">${ord}</span><br>${place(x[`${s}_country`], x[`${s}_ip`])}${city}`;
  };
  const TRADE_COLUMNS = [{ label: '# / time (UTC)', sort: 'id' }, { label: 'price', sort: 'price' }, { label: 'PCN', sort: 'qty' },
    { label: 'value', sort: 'notional' }, { label: 'buyer' }, { label: 'seller' }, { label: 'who took whom' }, { label: 'fees' }];
  const tradeRow = (x) => {
    const took = x.taker_side === 'buy'
      ? `buyer took the seller's resting order #${esc(x.maker_order_id)}`
      : x.taker_side === 'sell' ? `seller took the buyer's resting order #${esc(x.maker_order_id)}` : esc(x.taker_side || '—');
    return `<tr><td style="white-space:nowrap"><b>#${esc(x.id)}</b><br><span class="muted">${esc(whenS(x.at))}</span></td>
      <td>${esc(usd(x.price_micro))}</td><td>${esc(pcn(x.qty_sat))}</td><td><b>${esc(usd(x.notional_micro))}</b></td>
      <td>${party(x, 'buyer')}</td><td>${party(x, 'seller')}</td>
      <td style="font-size:12px">${took}<br>${String(x.house_involved) === '1' ? pill('house bot') : pill('users only')}</td>
      <td style="font-size:12px;white-space:nowrap">buyer ${esc(usd(x.buyer_fee_micro))}<br>seller ${esc(usd(x.seller_fee_micro))}</td></tr>`;
  };

  async function activity(url) {
    // "Activity, type = trade" shows the fills themselves in full, not their
    // one-line events. The kind filter stays in every link (spec.sub), so paging
    // and sorting keep showing trades.
    if (url.searchParams.get('f_kind') === 'trade') {
      const L = await listPage(url, {
        view: 'activity', sub: { name: 'f_kind', value: 'trade' }, list: 'trades', title: 'trades',
        searchHint: 'Search email, bot name, account id, order id, IP, country, city…', dateLabel: 'traded',
        columns: TRADE_COLUMNS, row: tradeRow, empty: 'No trades match.',
      });
      return `<div class="card"><p class="muted">Every fill, both sides in full. <a href="${self}?view=activity">Back to all activity</a> ·
        filter by buyer or seller (a user, <b>bot:bid</b>, <b>bot:ask</b>) with the selects below.</p></div>` + L.html;
    }
    const KIND = { account: '🆕', signin: '🔑', order: '📋', trade: '💱', deposit: '💰', cancel: '✖', adjust: '⚖', check: '🔎', referral: '🎁' };
    const L = await listPage(url, {
      view: 'activity', list: 'events', title: 'the activity feed',
      searchHint: 'Search the text, an email, an IP…', dateLabel: 'from',
      virtualLabels: {},
      columns: [{ label: 'time', sort: 'at' }, { label: 'what', sort: 'kind' }, { label: 'detail' }, { label: 'IP' }, { label: 'telegram' }],
      row: (e) => `<tr><td style="white-space:nowrap">${esc(when(e.at))}</td><td style="white-space:nowrap">${KIND[e.kind] || ''} ${esc(e.kind)}</td>
        <td>${esc(e.text)}</td><td>${e.ip ? `<span class="dim" style="font-size:11px">${esc(e.ip)}</span>` : ''}</td>
        <td>${e.sent_at ? '<span class="muted">sent</span>' : '<b class="warn">waiting</b>'}</td></tr>`,
      empty: 'Nothing yet.',
    });
    const tg = L.data && L.data.facets.telegram ? (L.data.facets.telegram.values.find((v) => v.value === 'waiting') || { count: 0 }).count : null;
    return '<div class="card"><p class="muted">Sign-ups, sign-ins, orders, fills and deposit credits — kept for 30 days. '
      + (tg === null ? '' : tg ? `<b>${tg} waiting to reach Telegram</b> (they go out on the next tick; nothing is lost if it refuses).` : 'Everything has reached Telegram.')
      + ' Withdrawals have their own page, and each request is announced the moment it is made.</p></div>' + L.html;
  }

  async function book(url) {
    const b = await call('GET', '/admin/api/book');
    if (!ok(b)) return unknown('the order book', b);
    const level = (x) => `<tr><td>${esc(usd(x.price_micro))}</td><td>${esc(pcn(x.qty_sat))}</td><td>${esc(x.orders)}</td></tr>`;
    const L = await listPage(url, {
      view: 'book', list: 'trades', title: 'trades',
      searchHint: 'Search email, bot name, account id, order id, IP, country, city…', dateLabel: 'traded',
      columns: TRADE_COLUMNS,
      row: tradeRow,
      empty: 'No trades yet.',
    });
    return `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px">
        <div><div class="card" style="padding:12px 20px"><h2 style="margin:0;color:var(--red)">Asks — selling PCN</h2></div>${table(['price', 'PCN', 'orders'], b.json.asks.map(level), 'No asks.')}</div>
        <div><div class="card" style="padding:12px 20px"><h2 style="margin:0;color:var(--green)">Bids — buying PCN</h2></div>${table(['price', 'PCN', 'orders'], b.json.bids.map(level), 'No bids.')}</div>
      </div><div class="card" style="padding:12px 20px"><h2 style="margin:0">Trades</h2></div>` + L.html;
  }

  // Every order anybody placed, including the house bots' -- the book above
  // shows only what is resting now; this is the history behind it.
  async function orders(url) {
    const L = await listPage(url, {
      view: 'orders', list: 'orders', title: 'orders',
      virtualLabels: { live: 'live — resting on the book' },
      searchHint: 'Search email, account id, order id, IP, country…', dateLabel: 'placed',
      columns: [{ label: '#', sort: 'id' }, { label: 'placed', sort: 'created' }, { label: 'by' }, { label: 'side' },
        { label: 'price', sort: 'price' }, { label: 'PCN', sort: 'qty' }, { label: 'filled' }, { label: 'status' }, { label: 'closed' }, { label: 'from' }],
      row: (o) => {
        const by = o.email ? esc(o.email) : `<span class="xpill warn">${esc(o.account_name || `account ${o.account_id}`)}</span>`;
        const filledPct = big(o.qty_sat) ? Number((big(o.filled_sat) * 10000n) / big(o.qty_sat)) / 100 : 0;
        return `<tr><td>${esc(o.id)}</td><td style="white-space:nowrap">${esc(when(o.created_at))}</td><td>${by}</td>
          <td><b class="${o.side === 'buy' ? 'ok' : 'bad'}">${esc(o.side)}</b></td><td>${esc(usd(o.price_micro))}</td><td>${esc(pcn(o.qty_sat))}</td>
          <td>${filledPct}%</td><td>${pill(o.status)}</td>
          <td>${o.closed_at ? `${esc(when(o.closed_at))}<br><span class="dim">${esc(o.close_reason || '')}</span>` : '<span class="dim">—</span>'}</td>
          <td>${o.ip || o.geo_country ? place(o.geo_country, o.ip) : '<span class="dim">—</span>'}</td></tr>`;
      },
      empty: 'No orders yet.',
    });
    return L.html;
  }

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
      ${p && p.fields ? `<p class="muted">A number written as a placeholder is filled in from Settings, so the terms cannot drift from what the code does. Available now:<br>${Object.entries(p.fields).map(([k, v]) => `<code>{{${esc(k)}}}</code> → ${esc(v)}`).join(' · ')}</p>` : ''}
        <p><textarea name="body" rows="20" style="width:100%">${esc(p ? (p.template ?? p.body) : '')}</textarea></p>
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

  async function audit(url) {
    const L = await listPage(url, {
      view: 'audit', list: 'audit', title: 'the audit log',
      searchHint: 'Search actor, action, subject, values, detail…', dateLabel: 'from',
      columns: [{ label: 'time', sort: 'at' }, { label: 'actor' }, { label: 'action', sort: 'action' }, { label: 'subject' },
        { label: 'old' }, { label: 'new' }, { label: 'detail' }],
      row: (a) => `<tr><td style="white-space:nowrap">${esc(when(a.at))}</td><td>${esc(a.actor)}</td><td>${esc(a.action)}</td>
        <td>${esc(a.subject || '')}</td><td>${esc(a.old_value || '')}</td><td>${esc(a.new_value || '')}</td><td>${esc(a.detail || '')}</td></tr>`,
      empty: 'Nothing yet.',
    });
    return L.html;
  }

  const RENDER = { overview, activity, withdrawals, deposits, settings, users, referrals, book, orders, price, policy, pool, audit };

  async function page(url, flash = null) {
    if (!ex || !ex.apiUrl || !ex.readToken) {
      return '<div class="card"><p class="bad">Not configured.</p><p class="muted">upstream.json needs an <code>exchange</code> entry with <code>apiUrl</code> and <code>readToken</code>. This panel must never hold the exchange admin 2FA secret.</p></div>';
    }
    const requested = url.searchParams.get('view');
    const view = RENDER[requested] ? requested : 'overview';
    const rq = cleanListQs(url.searchParams.toString());
    const kind = url.searchParams.get('kind');
    if (kind === 'pcn' || kind === 'usd') rq.set('kind', kind);
    retQs = rq.toString();
    const note = flash ? `<div class="card" style="border-left:4px solid var(--${flash.ok ? 'green' : 'red'})"><p${flash.ok ? '' : ' class="bad"'}>${esc(flash.text)}</p></div>` : '';
    return `<p class="muted" style="margin-top:-10px;margin-bottom:14px">Read here; every change asks for the code from your <b>PCoin Exchange admin</b> authenticator entry.</p>`
      + tabs(view) + note + await RENDER[view](url);
  }

  async function action(f, url) {
    const back = (view, id = null) => {
      const u = new URL(url);
      u.search = '';
      u.searchParams.set('view', view);
      // Back to the same filtered page the form was posted from -- only list
      // keys survive, so nothing else a form carries can steer the redirect.
      for (const [k, v] of cleanListQs(f.get('ret'))) u.searchParams.set(k, v);
      const k = new URLSearchParams(String(f.get('ret') || '')).get('kind');
      if (view === 'deposits' && (k === 'pcn' || k === 'usd')) u.searchParams.set('kind', k);
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
    if (act === 'pay_hot') {
      let wid;
      try { wid = id(); } catch (e) { return { url: back('withdrawals'), flash: { ok: false, text: e.message } }; }
      return payFromHot(wid, String(f.get('code') || '').trim(), back);
    }
    if (act === 'pay_keeper') {
      let wid;
      try { wid = id(); } catch (e) { return { url: back('withdrawals'), flash: { ok: false, text: e.message } }; }
      return payFromKeeper(wid, String(f.get('code') || '').trim(), back);
    }
    const specs = {
      referral_refuse: () => ['/admin/api/referrals/refuse', { id: Number(id()), reason: reason() }, 'referrals'],
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

  // Approve -> send from market-hot -> record the txid, with ONE exchange code.
  //
  // THE ORDER IS THE SAFETY. Nothing is sent until the exchange itself has
  // accepted the owner's code: the approve call is made even when the
  // withdrawal is already approved, because the exchange checks the code
  // BEFORE the route runs -- 401 means a wrong code, and "not_requested" (422)
  // means the code was right and it was simply approved already.
  //
  // Amount and address are read back from the exchange after approving, never
  // from the form. The send's key is derived from the withdrawal, so pressing
  // the button again after any failure -- a lost answer, an expired code at the
  // record step -- returns the SAME transaction instead of paying twice
  // (ops-send.mjs refuses a key it has already paid). That makes "press it
  // again" the one retry for every partial failure.
  async function payFromHot(wid, code, back) {
    const done = (ok, text) => ({ url: back('withdrawals', wid), flash: { ok, text } });
    const said = (r) => (r.json && r.json.error) || r.reason || `HTTP ${r.status}`;
    if (!(creds && creds.market && creds.market.sendToken)) return done(false, 'Paying from market-hot is not configured (no market sendToken). Nothing was sent.');

    const r0 = await call('GET', `/admin/api/withdrawals/${wid}`);
    if (!ok(r0)) return done(false, `Nothing was sent: withdrawal #${wid} could not be read (${said(r0)}).`);
    if (r0.json.network !== 'PCN') return done(false, 'Only a PCN withdrawal can be paid from market-hot. Nothing was sent.');
    if (!hotPayable(r0.json)) return done(false, `Withdrawal #${wid} is ${r0.json.status}, so there is nothing to pay. Nothing was sent.`);

    // 1. the code, proved by the exchange before anything moves
    const a = await call('POST', `/admin/api/withdrawals/${wid}/approve`, { body: {}, code });
    if (!a.readable) return done(false, `UNKNOWN: the exchange did not answer the approval (${a.reason}). Nothing was sent. Reload and check before trying again.`);
    if (a.status === 401) return done(false, `Refused: ${said(a)}. Nothing was sent.`);
    const alreadyApproved = a.status === 422 && a.json && a.json.code === 'not_requested' && r0.json.status === 'approved';
    if (a.status !== 200 && !alreadyApproved) return done(false, `Refused at approval (${a.status}): ${said(a)}. Nothing was sent.`);

    // 2. the exchange's record, re-read: what to send and where, and whether it can still be recorded
    const r1 = await call('GET', `/admin/api/withdrawals/${wid}`);
    if (!ok(r1)) return done(false, `Approved, but the withdrawal could not be re-read (${said(r1)}). Nothing was sent; press the button again.`);
    const w = r1.json;
    const pcnAmt = Number(w.amount);
    if (w.status !== 'approved' || w.network !== 'PCN' || !(pcnAmt > 0) || !/^pc1[02-9ac-hj-np-z]{20,87}$/.test(String(w.address))) {
      return done(false, `Withdrawal #${wid} is not in a payable state (${w.status}, ${w.amount} to ${w.address}). Nothing was sent.`);
    }
    const nowS = Math.floor(Date.now() / 1000);
    if (w.approveExpiresAt && Number(w.approveExpiresAt) - nowS < 300) {
      return done(false, `The approval of #${wid} expires in under 5 minutes, and a payment recorded after it expires is refused. Nothing was sent; wait for it to lapse back to "requested", then press the button again.`);
    }

    // 3. send, keyed to this withdrawal so it can never be paid twice
    const key = `send:exwd${wid}-${createHash('sha256').update(`${wid}|${w.address}|${w.amount}`).digest('hex').slice(0, 12)}`;
    const note = `exchange withdrawal #${wid}`;
    const s = await marketSend(creds, { key, to: String(w.address), pcn: pcnAmt, note });
    const entry = { at: new Date().toISOString(), key, to: String(w.address), pcn: pcnAmt, note, result: s.state, txid: s.txid || null, error: s.ok ? null : s.out };
    try { if (sendLogPath) appendLog(sendLogPath, entry); } catch { /* the log must never block a payout */ }
    if (!s.ok) {
      return done(false, s.state === 'unknown'
        ? `UNKNOWN: ${s.out} Press "Pay" again with a new code: it cannot pay #${wid} twice.`
        : `NOT sent: ${s.out}`);
    }

    // 4. record it. A failure here leaves money SENT and unrecorded -- say so plainly.
    const t = await call('POST', `/admin/api/withdrawals/${wid}/txid`, { body: { txid: s.txid }, code });
    if (ok(t)) {
      return done(true, `PAID: ${w.amount} PCN sent from market-hot to ${w.address}, transaction ${s.txid}${s.state === 'already' ? ' (sent earlier under this withdrawal; nothing new went out)' : ''}. Recorded on #${wid}; it settles once the chain confirms it.`);
    }
    if (t.status === 422 && t.json && t.json.code === 'already_recorded') {
      return done(true, `Sent (transaction ${s.txid}); #${wid} already had its transaction recorded.`);
    }
    return done(false, `SENT ${w.amount} PCN (transaction ${s.txid}) but recording it on #${wid} failed: ${said(t)}. Press "Pay" again with a new code -- it will not send again, it will only record -- or paste the transaction id in Record payment.`);
  }

  // The keeper twin of payFromHot: the same four steps, the same one code.
  async function payFromKeeper(wid, code, back) {
    const done = (ok, text) => ({ url: back('withdrawals', wid), flash: { ok, text } });
    const said = (r) => (r.json && r.json.error) || r.reason || `HTTP ${r.status}`;

    const r0 = await call('GET', `/admin/api/withdrawals/${wid}`);
    if (!ok(r0)) return done(false, `Nothing was sent: withdrawal #${wid} could not be read (${said(r0)}).`);
    if (r0.json.network !== 'BEP20') return done(false, 'Only a USDT withdrawal on BNB Smart Chain (BEP20) can be paid from the keeper. Nothing was sent.');
    if (!keeperPayable(r0.json)) return done(false, `Withdrawal #${wid} is ${r0.json.status}, so there is nothing to pay. Nothing was sent.`);

    // 1. the code, proved by the exchange before anything moves
    const a = await call('POST', `/admin/api/withdrawals/${wid}/approve`, { body: {}, code });
    if (!a.readable) return done(false, `UNKNOWN: the exchange did not answer the approval (${a.reason}). Nothing was sent. Reload and check before trying again.`);
    if (a.status === 401) return done(false, `Refused: ${said(a)}. Nothing was sent.`);
    const alreadyApproved = a.status === 422 && a.json && a.json.code === 'not_requested' && r0.json.status === 'approved';
    if (a.status !== 200 && !alreadyApproved) return done(false, `Refused at approval (${a.status}): ${said(a)}. Nothing was sent.`);

    // 2. re-read: what to send and where
    const r1 = await call('GET', `/admin/api/withdrawals/${wid}`);
    if (!ok(r1)) return done(false, `Approved, but the withdrawal could not be re-read (${said(r1)}). Nothing was sent; press the button again.`);
    const w = r1.json;
    const micro = usdToMicro(w.amount);
    if (w.status !== 'approved' || w.network !== 'BEP20' || !micro || !/^0x[0-9a-fA-F]{40}$/.test(String(w.address))) {
      return done(false, `Withdrawal #${wid} is not in a payable state (${w.status}, ${w.amount} to ${w.address}). Nothing was sent.`);
    }
    const nowS = Math.floor(Date.now() / 1000);
    if (w.approveExpiresAt && Number(w.approveExpiresAt) - nowS < 300) {
      return done(false, `The approval of #${wid} expires in under 5 minutes, and a payment recorded after it expires is refused. Nothing was sent; wait for it to lapse back to "requested", then press the button again.`);
    }

    // 3. send, keyed to this withdrawal so it can never be paid twice
    const key = `exwd${wid}-${createHash('sha256').update(`${wid}|${w.address}|${w.amount}`).digest('hex').slice(0, 12)}`;
    const note = `exchange withdrawal #${wid}`;
    const s = await keeper.send({ key, to: String(w.address), micro, note });
    const paid = s.state === 'sent' || s.state === 'already';
    const entry = { at: new Date().toISOString(), key, to: String(w.address), usdt: Number(w.amount), from: 'keeper', note,
      result: s.state, txid: s.txid || null, error: paid ? null : (s.message || null) };
    try { if (keeperLogPath) appendLog(keeperLogPath, entry); } catch { /* the log must never block a payout */ }
    if (!paid) {
      return done(false, s.state === 'unknown'
        ? `UNKNOWN: ${s.message} Press "Pay from keeper" again with a new code: it cannot pay #${wid} twice.`
        : `NOT sent: ${s.message}`);
    }

    // 4. record it. A failure here leaves money SENT and unrecorded -- say so plainly.
    const t = await call('POST', `/admin/api/withdrawals/${wid}/txid`, { body: { txid: s.txid }, code });
    if (ok(t)) {
      return done(true, `PAID: ${w.amount} USDT sent from the keeper to ${w.address} on BNB Smart Chain, transaction ${s.txid}${s.state === 'already' ? ' (sent earlier under this withdrawal; nothing new went out)' : ''}. Recorded on #${wid}; it settles once the chain confirms it.`);
    }
    if (t.status === 422 && t.json && t.json.code === 'already_recorded') {
      return done(true, `Sent (transaction ${s.txid}); #${wid} already had its transaction recorded.`);
    }
    return done(false, `SENT ${w.amount} USDT (transaction ${s.txid}) but recording it on #${wid} failed: ${said(t)}. Press "Pay from keeper" again with a new code -- it will not send again, it will only record -- or paste the transaction id in Record payment.`);
  }

  return { page, action };
}
