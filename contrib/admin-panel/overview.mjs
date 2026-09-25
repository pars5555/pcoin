// ═══════════════════════════════════════════════════════════════════════════
// The Overview: every PCoin subsystem on one screen (admin.pc.am, 2026-09-24)
// ═══════════════════════════════════════════════════════════════════════════
//
// Owner, 2026-09-24: "nice unified admin for all subsystems, exchange price,
// market, wrap everything nice embedded in that".
//
// One card per subsystem, each with a status light, the one number that
// matters most, a few supporting figures, and a link to its full page. The
// cards only SUMMARISE pages that already exist -- every figure here is read
// by the same code, or from the same source, as its detail page, so the two
// cannot disagree.
//
// The rule every card follows: an unreadable source is UNKNOWN (grey), never
// a zero and never green. "I could not look" and "all is well" must not look
// the same, on the one page the owner reads first.
import { esc } from './ui.mjs';

const LABEL = { ok: 'OK', watch: 'WATCH', alert: 'ALERT', unknown: 'UNKNOWN' };
const RANK = { alert: 3, unknown: 2, watch: 1, ok: 0 };
const worst = (...s) => s.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'ok');
const fmt = (x, d = 2) => (typeof x === 'number' && isFinite(x))
  ? x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : null;
const usd = (x, d = 5) => (fmt(x, d) === null ? '&mdash;' : '$' + fmt(x, d));
const t = (v) => (v === null || v === undefined || v === '' ? '&mdash;' : esc(v));
const ago = (s) => (s === null || s === undefined || !isFinite(s) ? '&mdash;'
  : s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : s < 172800 ? `${(s / 3600).toFixed(1)} h` : `${Math.round(s / 86400)} d`);

function rowsOf(svcs, name) {
  const s = (svcs || []).find((x) => x.name === name);
  if (!s) return null;
  const m = {};
  for (const r of s.rows || []) m[r[0]] = { v: r[1], n: r[2] };
  return { status: s.status, m };
}

function card({ icon, title, href, status, primary, plabel, lines = [], why = '' }) {
  return `<a class="ov-card ov-${status}" href="${href}">
  <div class="ov-head"><span class="ov-icon">${icon}</span><span class="ov-title">${esc(title)}</span>
    <span class="ov-pill ov-p-${status}">${LABEL[status]}</span></div>
  <div class="ov-primary">${primary}</div><div class="ov-plabel">${esc(plabel)}</div>
  <div class="ov-lines">${lines.filter(Boolean).map(([k, v]) =>
    `<div><span>${esc(k)}</span><b>${v}</b></div>`).join('')}</div>
  ${why ? `<div class="ov-why">${esc(why)}</div>` : ''}
  <div class="ov-open">Open &rsaquo;</div>
</a>`;
}

// ── one builder per subsystem; each returns {status, html} ────────────────
function chainCard(base, svcs) {
  const r = rowsOf(svcs, 'explorer.pc.am/admin');
  if (!r || r.status === 'unreadable') {
    return { status: 'unknown', html: card({ icon: '&#9939;', title: 'Chain', href: `${base}/services/explorer`,
      status: 'unknown', primary: '&mdash;', plabel: 'block height', why: 'the explorer could not be read' }) };
  }
  const m = r.m;
  const tipMin = m['Tip age'] ? parseFloat(m['Tip age'].v) : null;
  // At a 600 s target a 30-minute gap happens to about 1 block in 20 (e^-3), so
  // WATCH starts at 45 min (1 in 90) and ALERT at 90 min (1 in 8,000).
  const status = tipMin === null ? 'unknown' : tipMin > 90 ? 'alert' : tipMin > 45 ? 'watch' : 'ok';
  return { status, html: card({ icon: '&#9939;', title: 'Chain', href: `${base}/services/explorer`, status,
    primary: t(m['Chain height']?.v), plabel: 'block height',
    lines: [['Last block', t(m['Tip age']?.v) + ' ago'], ['Network hashrate', t(m['Network hashrate']?.v)],
      ['Peers on our seed', t(m['Peers']?.v)], ['Our pool share', t(m['Our pool is this much of the network']?.v)],
      ['Miners on our pool', t(m['Miners on our pool']?.v)]],
    why: status === 'alert' ? 'no block for over 90 minutes' : status === 'watch' ? 'no block for over 45 minutes' : '' }) };
}

function priceCard(base, p) {
  if (!p) {
    return { status: 'alert', html: card({ icon: '&#128178;', title: 'Price', href: `${base}/pricing`, status: 'alert',
      primary: '&mdash;', plabel: 'rails credit PCN at', why: 'price.pc.am could not be read' }) };
  }
  const held = p.pool && p.pool.rateHeldAboveBy;
  const status = p.stale ? 'alert' : held ? 'watch' : 'ok';
  return { status, html: card({ icon: '&#128178;', title: 'Price', href: `${base}/pricing`, status,
    primary: usd(Number(p.creditRateUsd), 6), plabel: 'rails credit PCN at (creditRateUsd)',
    lines: [['Market sells PCN at', usd(Number(p.sellPriceUsd), 6)], ['wPCN pool, spot', usd(Number(p.pool?.spotUsd), 6)],
      ['wPCN pool, 6 h median', usd(Number(p.pool?.medianUsd), 6)], ['Floor', usd(Number(p.rateFloorUsd), 4)]],
    why: p.stale ? 'price.pc.am says its data is stale' : held ? `the rate is held above the pool by ${held}` : '' }) };
}

function indexCard(base, p) {
  const ix = p && p.index;
  if (!ix) {
    return { status: 'unknown', html: card({ icon: '&#128200;', title: 'PCN index (shadow)', href: `${base}/pcn-index`,
      status: 'unknown', primary: '&mdash;', plabel: 'from real exchange trades', why: 'price.pc.am is not relaying the index' }) };
  }
  // In use (price.pc.am useIndex = 1, since 2026-09-25) a stale index means the
  // rails are holding every credit, so it is an alert, not a watch.
  const inUse = ix.inUse === true;
  const status = ix.refused || ix.state === 'unknown' ? 'alert' : ix.stale ? (inUse ? 'alert' : 'watch') : 'ok';
  const credit = Number(p.creditRateUsd);
  const gap = ix.usd > 0 && credit > 0 ? (ix.usd / credit - 1) * 100 : null;
  return { status, html: card({ icon: '&#128200;', title: inUse ? 'PCN index' : 'PCN index (shadow)', href: `${base}/pcn-index`, status,
    primary: usd(ix.usd, 6), plabel: inUse ? 'from real exchange trades — THE credit rate' : 'from real exchange trades — used by nothing yet',
    lines: [['State', t(ix.state)], ['vs credit rate', gap === null ? '&mdash;' : (gap >= 0 ? '+' : '') + fmt(gap, 2) + '%'],
      ['Evidence', ix.window ? `${t(ix.window.trades)} fills, ${t(ix.window.entities)} people, $${t(ix.window.countedUsd)}` : '&mdash;'],
      ['Computed', ago(ix.ageSeconds) + ' ago']],
    why: ix.refused ? 'price.pc.am REFUSED the latest reading: ' + ix.refused.why : ix.state === 'unknown' ? 'the exchange reports the index as unknown'
      : ix.stale && inUse ? 'the index is stale: /credit-rate answers 503 and the rails hold' : '' }) };
}

function marketCard(base, svcs) {
  const r = rowsOf(svcs, 'market.pc.am');
  if (!r || r.status === 'unreadable') {
    return { status: 'unknown', html: card({ icon: '&#128722;', title: 'Market', href: `${base}/services/market`,
      status: 'unknown', primary: '&mdash;', plabel: 'PCN for sale now', why: 'market.pc.am could not be read' }) };
  }
  const m = r.m;
  const gate = m['Sale gate']?.v;
  const status = gate === 'CLOSED' ? 'alert' : r.status === 'bad' ? 'watch' : 'ok';
  return { status, html: card({ icon: '&#128722;', title: 'Market', href: `${base}/services/market`, status,
    primary: t(m['Available to buy']?.v), plabel: 'for sale now on market.pc.am',
    lines: [['Sale gate', t(gate)], ['Next buyer pays', t(m['Ask price']?.v)], ['Hot wallet', t(m['Hot wallet']?.v)],
      ['Owed on orders', t(m['Owed on orders']?.v)], ['Orders', t(m['Orders']?.v)]],
    why: gate === 'CLOSED' ? 'the sale gate is closed: nobody can buy' : '' }) };
}

function exchangeCard(base, ex) {
  const j = ex && ex.readable && ex.status === 200 ? ex.json : null;
  if (!j) {
    return { status: 'unknown', html: card({ icon: '&#127974;', title: 'Exchange', href: `${base}/exchange`,
      status: 'unknown', primary: '&mdash;', plabel: 'withdrawals waiting', why: 'exchange.pc.am could not be read' + (ex && ex.reason ? ': ' + ex.reason : '') }) };
  }
  const inv = Array.isArray(j.invariants) ? j.invariants.length : null;
  const halted = j.halted !== null && j.halted !== undefined && j.halted !== false;   // haltState(): null = running, a record = halted
  const q = j.queue || {};
  const status = halted || inv ? 'alert' : q.open > 0 ? 'watch' : 'ok';
  const bots = j.lastBots || {};
  return { status, html: card({ icon: '&#127974;', title: 'Exchange', href: `${base}/exchange`, status,
    primary: t(q.open), plabel: 'withdrawals waiting for you',
    lines: [['Oldest waiting', q.open ? ago(q.oldestAgeSeconds) : '&mdash;'], ['Books balance', inv === 0 ? 'yes' : inv === null ? '&mdash;' : `<span class="bad">${inv} broken</span>`],
      ['Trading', halted ? '<span class="bad">HALTED</span>' : j.exchangeOpen ? 'open' : 'closed'],
      ['Deposits held / confirming', `${t(j.deposits?.held)} / ${t(j.deposits?.confirming)}`],
      ['Bots last ran', bots.at ? ago(Date.now() / 1000 - Number(bots.at)) + ' ago' : '&mdash;']],
    why: halted ? 'trading is halted' : inv ? 'an accounting invariant is broken' : q.open ? 'a withdrawal is waiting to be paid' : '' }) };
}

function wrapCard(base, state, work) {
  if (!state || state.open === null) {
    return { status: 'alert', html: card({ icon: '&#128260;', title: 'Wrap desk', href: `${base}/wrapdesk`, status: 'alert',
      primary: '&mdash;', plabel: 'wPCN left to wrap', why: 'cannot tell whether the desk is open' + (state && state.error ? ': ' + state.error : '') }) };
  }
  const items = work && work.ok ? (work.items || []) : null;
  // Only 'send' needs the owner. 'withheld' is held back on purpose (cap,
  // blocklist) and worth a look; 'waiting' is a deposit gathering confirmations.
  const nSend = items ? items.filter((i) => i.kind === 'send').length : null;
  const nHeld = items ? items.filter((i) => i.kind === 'withheld').length : null;
  const nWait = items ? items.filter((i) => i.kind === 'waiting').length : null;
  const status = !work || !work.ok ? 'unknown' : nSend ? 'alert' : nHeld ? 'watch' : 'ok';
  const a = work && work.allocation;
  return { status, html: card({ icon: '&#128260;', title: 'Wrap desk', href: `${base}/wrapdesk`, status,
    primary: a ? fmt(a.left, 2) : '&mdash;', plabel: 'wPCN left to wrap' + (a ? ` of ${fmt(a.total, 0)}` : ''),
    lines: [['Intake', state.open ? 'open' : '<span class="warn">closed</span>'], ['To send now', nSend === null ? '&mdash;' : String(nSend)],
      ['Withheld', nHeld === null ? '&mdash;' : String(nHeld)], ['Confirming', nWait === null ? '&mdash;' : String(nWait)],
      ['Warnings', work && work.ok ? String((work.warnings || []).length) : '&mdash;'],
      ['Checked', work && work.ranAt ? ago((Date.now() - Date.parse(work.ranAt)) / 1000) + ' ago' : '&mdash;']],
    why: !work || !work.ok ? 'the wrap-desk watcher could not be run' + (work && work.why ? ': ' + work.why : '')
      : nSend ? `${nSend} wrap(s) ready for you to send` : nHeld ? `${nHeld} wrap(s) withheld` : '' }) };
}

function keeperCard(base, k) {
  const tun = k && k.tuning && k.tuning.state === 'ok' ? k.tuning.data : null;
  const eff = k && k.eff && k.eff.state === 'ok' ? k.eff.data : null;
  const st = k && k.st && k.st.state === 'ok' ? k.st.data : null;
  if (!tun) {
    return { status: 'alert', html: card({ icon: '&#9878;&#65039;', title: 'wPCN keeper', href: `${base}/keeper`, status: 'alert',
      primary: '&mdash;', plabel: 'defends the pool at', why: 'the tuning file is unreadable, so the keeper refuses to trade' }) };
  }
  const status = eff && eff.error ? 'alert' : 'ok';
  return { status, html: card({ icon: '&#9878;&#65039;', title: 'wPCN keeper', href: `${base}/keeper`, status,
    primary: usd(Number(tun.buy_floor_usd), 4), plabel: 'buys wPCN only below this floor',
    lines: [['Mode', eff && eff.floor_mode ? 'floor' : eff ? 'parity' : '&mdash;'], ['Pool now', usd(Number(eff?.pool_price), 6)],
      ['Buying', tun.buy ? 'on' : 'off'], ['Selling', tun.sell ? 'on' : 'off'],
      ['Spent today', st ? `$${fmt(Number(st.usdt_spent || 0), 2)} of $${fmt(Number(tun.daily_usdt_cap), 0)}` : '&mdash;']],
    why: eff && eff.error ? String(eff.error).slice(0, 140) : '' }) };
}

function payCard(base, svcs) {
  const r = rowsOf(svcs, 'wpcnpay.pc.am');
  if (!r || r.status === 'unreadable') {
    return { status: 'unknown', html: card({ icon: '&#128179;', title: 'wPCN payments', href: `${base}/services/wpcnpay`,
      status: 'unknown', primary: '&mdash;', plabel: 'claims banked', why: 'wpcnpay.pc.am could not be read' }) };
  }
  const m = r.m;
  const status = m['Verifier']?.v === 'DOWN' ? 'alert' : 'ok';
  return { status, html: card({ icon: '&#128179;', title: 'wPCN payments', href: `${base}/services/wpcnpay`, status,
    primary: t(m['Claims banked']?.v), plabel: 'claims banked',
    lines: [['Verifier', t(m['Verifier']?.v)], ['Today', t(m['Claims banked']?.n)], ['Credited', t(m['Credited']?.v)],
      ['Newest claim', t(m['Newest claim']?.v)]],
    why: status === 'alert' ? 'the verifier is down' : '' }) };
}

function earnerCard(base, svcs) {
  const r = rowsOf(svcs, 'pcnearner.pc.am');
  if (!r || r.status === 'unreadable') {
    return { status: 'unknown', html: card({ icon: '&#127912;', title: 'GPU earner', href: `${base}/services/pcnearner`,
      status: 'unknown', primary: '&mdash;', plabel: 'earners', why: 'pcnearner.pc.am could not be read' }) };
  }
  const m = r.m;
  const status = r.status === 'bad' ? 'watch' : 'ok';
  return { status, html: card({ icon: '&#127912;', title: 'GPU earner', href: `${base}/services/pcnearner`, status,
    primary: t(m['Earners']?.v), plabel: 'earners connected',
    lines: [['Queue', t(m['Queue']?.v)], ['Tasks done', t(m['Tasks done']?.v)], ['Paid out', t(m['Paid out']?.v)]] }) };
}

function hostsCard(base, jobs, expected, staleSeconds) {
  const now = Date.now();
  const rows = expected.map(([h]) => {
    const d = jobs && jobs[h];
    const a = d ? (now - Date.parse(d.at || '')) / 1000 : Infinity;
    return { h, fresh: isFinite(a) && a <= staleSeconds };
  });
  const fresh = rows.filter((x) => x.fresh).length;
  const status = fresh === rows.length ? 'ok' : fresh === 0 ? 'alert' : 'watch';
  return { status, html: card({ icon: '&#128421;&#65039;', title: 'Servers & jobs', href: `${base}/jobs`, status,
    primary: `${fresh}/${rows.length}`, plabel: 'servers reporting their scheduled jobs',
    lines: rows.filter((x) => !x.fresh).slice(0, 4).map((x) => ['Not reporting', esc(x.h)]),
    why: fresh < rows.length ? `${rows.length - fresh} server(s) have not reported in over an hour` : '' }) };
}

function servicesCard(base, svcs) {
  const n = (svcs || []).length;
  const bad = (svcs || []).filter((x) => x.status === 'bad' || x.status === 'unreadable');
  const status = !n ? 'unknown' : bad.length ? 'alert' : 'ok';
  return { status, html: card({ icon: '&#129513;', title: 'Services', href: `${base}/services`, status,
    primary: n ? `${n - bad.length}/${n}` : '&mdash;', plabel: 'services healthy',
    lines: bad.slice(0, 4).map((x) => [x.name, `<span class="bad">${esc((x.status || '').toUpperCase())}</span>`]) }) };
}

function sendsCard(base, log) {
  const now = Date.now();
  const sent = (log || []).filter((x) => x && x.result === 'sent');
  const day = sent.filter((x) => now - Date.parse(x.at || '') < 86400e3);
  const sum = day.reduce((a, x) => a + (Number(x.pcn) || 0), 0);
  const last = sent[sent.length - 1];
  return { status: 'ok', html: card({ icon: '&#128228;', title: 'Sends from market-hot', href: `${base}/send`, status: 'ok',
    primary: fmt(sum, 2) + ' PCN', plabel: 'sent in the last 24 h (cap 2,000)',
    lines: [['Sends in 24 h', String(day.length)], ['Last send', last ? `${fmt(Number(last.pcn), 2)} PCN, ${ago((now - Date.parse(last.at)) / 1000)} ago` : 'none yet']] }) };
}

export function overviewPage({ base, svcs, ex, price, wrap, work, keeper, jobs, expected, staleSeconds, sends, needs = [], needsCard }) {
  // Urgent items (action / warn) stay in view; the hand-kept task list is
  // folded away, or its thirty rows bury every card above them.
  const urgent = needs.filter((i) => i.sev === 'action' || i.sev === 'warn');
  const tasks = needs.filter((i) => !(i.sev === 'action' || i.sev === 'warn'));
  const needCount = urgent.length;
  const needsHtml = (urgent.length ? needsCard(urgent)
      : '<div class="card" style="border-left:3px solid var(--green)"><h2>Needs you</h2><p class="ok">Nothing urgent. Every source '
        + 'was read and none needs action; a source that cannot be read would show here as an item.</p></div>')
    + (tasks.length ? `<details class="card ov-tasks"><summary><h2 style="display:inline">Open tasks (${tasks.length})</h2>`
        + ` <span class="muted" style="font-size:12px">&mdash; show</span></summary><div style="margin-top:12px">`
        + `${needsCard(tasks).replace(/^<div class="card"[^>]*>/, '<div>')}</div></details>` : '');
  const cards = [
    chainCard(base, svcs), priceCard(base, price), indexCard(base, price), marketCard(base, svcs),
    exchangeCard(base, ex), wrapCard(base, wrap, work), keeperCard(base, keeper), payCard(base, svcs),
    earnerCard(base, svcs), hostsCard(base, jobs, expected, staleSeconds), servicesCard(base, svcs), sendsCard(base, sends),
  ];
  const overall = worst(...cards.map((c) => c.status));
  const counts = { alert: 0, watch: 0, unknown: 0, ok: 0 };
  for (const c of cards) counts[c.status] += 1;
  const headline = overall === 'ok' ? 'Everything is running normally'
    : overall === 'watch' ? `${counts.watch} thing(s) to keep an eye on`
    : overall === 'unknown' ? `${counts.unknown} subsystem(s) could not be read`
    : `${counts.alert} subsystem(s) need attention`;
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  return `<style>
.ov-hero{display:flex;align-items:center;gap:16px;flex-wrap:wrap;background:linear-gradient(135deg,#15233b,#1e293b);
border:1px solid var(--border);border-radius:14px;padding:18px 22px;margin-bottom:18px}
.ov-dot{width:14px;height:14px;border-radius:50%;flex-shrink:0;box-shadow:0 0 0 4px rgba(255,255,255,.04)}
.ov-hero h2{font-size:18px;font-weight:600;margin:0;color:var(--text);text-transform:none;letter-spacing:0}
.ov-hero .ov-sub{color:var(--muted);font-size:12px;margin-left:auto;text-align:right}
.ov-counts{display:flex;gap:8px;flex-wrap:wrap}
.ov-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:14px;margin-bottom:18px}
.ov-card{display:flex;flex-direction:column;background:var(--panel);border:1px solid var(--border);border-radius:12px;
padding:16px 16px 12px;text-decoration:none;color:var(--text);border-top:3px solid var(--border);transition:transform .08s,border-color .15s}
.ov-card:hover{transform:translateY(-2px);border-color:var(--blue)}
.ov-ok{border-top-color:var(--green)}.ov-watch{border-top-color:var(--yellow)}.ov-alert{border-top-color:var(--red)}.ov-unknown{border-top-color:#64748b}
.ov-head{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.ov-icon{font-size:18px}.ov-title{font-weight:600;font-size:14px}
.ov-pill{margin-left:auto;font-size:10px;font-weight:700;letter-spacing:.6px;padding:2px 8px;border-radius:999px;border:1px solid}
.ov-p-ok{color:var(--green);border-color:rgba(34,197,94,.45);background:rgba(34,197,94,.08)}
.ov-p-watch{color:var(--yellow);border-color:rgba(234,179,8,.45);background:rgba(234,179,8,.08)}
.ov-p-alert{color:var(--red);border-color:rgba(239,68,68,.5);background:rgba(239,68,68,.1)}
.ov-p-unknown{color:#94a3b8;border-color:#475569;background:rgba(148,163,184,.08)}
.ov-primary{font-size:26px;font-weight:700;color:var(--blue);line-height:1.15}
.ov-plabel{color:var(--muted);font-size:11px;margin-bottom:10px}
.ov-lines{display:flex;flex-direction:column;gap:3px;font-size:12.5px}
.ov-lines div{display:flex;justify-content:space-between;gap:10px;border-bottom:1px dashed rgba(51,65,85,.6);padding:2px 0}
.ov-lines span{color:var(--muted)}.ov-lines b{font-weight:500;text-align:right}
.ov-why{margin-top:8px;font-size:12px;color:var(--yellow)}.ov-alert .ov-why{color:var(--red)}
.ov-open{margin-top:auto;padding-top:10px;font-size:12px;color:var(--blue);text-align:right}
.ov-tasks>summary{cursor:pointer}
</style>
<div id="ov">
  <div class="ov-hero">
    <span class="ov-dot" style="background:var(--${overall === 'ok' ? 'green' : overall === 'watch' ? 'yellow' : overall === 'alert' ? 'red' : 'muted'})"></span>
    <div><h2>${esc(headline)}</h2>
      <div class="ov-counts">${['alert', 'watch', 'unknown', 'ok'].filter((s) => counts[s]).map((s) =>
        `<span class="ov-pill ov-p-${s}" style="margin:6px 0 0">${counts[s]} ${LABEL[s]}</span>`).join('')}
        ${needCount ? `<span class="ov-pill ov-p-alert" style="margin:6px 0 0">${needCount} need you</span>` : ''}
        ${tasks.length ? `<span class="ov-pill ov-p-unknown" style="margin:6px 0 0">${tasks.length} open tasks</span>` : ''}</div></div>
    <div class="ov-sub">Updated ${esc(stamp)}<br>refreshes every minute</div>
  </div>
  <div class="ov-grid">${cards.map((c) => c.html).join('')}</div>
  ${needsHtml}
</div>
<script>
/* Refresh the cards in place once a minute. If anything fails -- signed out,
   a network error -- the page is simply left as it is, with its timestamp
   showing how old it is. */
(function () {
  if (!window.fetch || !window.DOMParser) return;
  setInterval(function () {
    if (document.hidden) return;
    fetch(location.href, { credentials: 'same-origin' }).then(function (r) { return r.text(); }).then(function (h) {
      var nu = new DOMParser().parseFromString(h, 'text/html').getElementById('ov');
      var cur = document.getElementById('ov');
      if (nu && cur) cur.innerHTML = nu.innerHTML;
    }).catch(function () {});
  }, 60000);
})();
</script>`;
}
