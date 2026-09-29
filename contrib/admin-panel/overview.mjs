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
      ['Our pool share', t(m['Our pool is this much of the network']?.v)],
      ['Miners on our pool', t(m['Miners on our pool']?.v)]],
    why: status === 'alert' ? 'no block for over 90 minutes' : status === 'watch' ? 'no block for over 45 minutes' : '' }) };
}

// ONE PRICE CARD, since 2026-09-29. There used to be a Price card and a
// separate PCN index card, which since the index went live (2026-09-25) showed
// the same number twice. The owner also asked for the Pancake price on it.
// Every price that matters is here, each labelled by where it comes from.
function priceCard(base, p, pub, snap) {
  if (!p) {
    return { status: 'alert', html: card({ icon: '&#128178;', title: 'Prices', href: `${base}/pricing`, status: 'alert',
      primary: '&mdash;', plabel: 'PCN index', why: 'price.pc.am could not be read' }) };
  }
  const ix = p.index || null;
  // A stale index means /credit-rate answers 503 and every rail holds its
  // credits, so it is an alert, not a watch.
  const status = p.stale || (ix && (ix.refused || ix.state === 'unknown' || ix.stale)) ? 'alert'
    : !ix ? 'unknown' : 'ok';
  const index = Number(p.creditRateUsd);
  // Pancake: the live pool read from BSC (the snapshot), falling back to the
  // pool figure price.pc.am relays. Both are the same pool; the label says which.
  const snapOk = snap && snap.ok && (Date.now() / 1000 - Number(snap.at)) < 900;
  const pancake = snapOk ? Number(snap.pool_price) : Number(p.pool?.spotUsd);
  const vs = pancake > 0 && index > 0 ? (pancake / index - 1) * 100 : null;
  const book = pub && pub.book ? pub.book : null;
  const bid = book && book.bids && book.bids[0] ? Number(book.bids[0].priceUsd) : null;
  const ask = book && book.asks && book.asks[0] ? Number(book.asks[0].priceUsd) : null;
  return { status, html: card({ icon: '&#128178;', title: 'Prices', href: `${base}/pricing`, status,
    primary: usd(index, 6), plabel: 'PCN index — what every service credits PCN at',
    lines: [
      ['Index state', ix ? `${t(ix.state)}, computed ${ago(ix.ageSeconds)} ago` : '&mdash;'],
      ['wPCN on PancakeSwap', usd(pancake, 6) + (vs === null ? '' : ` <span class="muted">(${vs >= 0 ? '+' : ''}${fmt(vs, 1)}%)</span>`)],
      ['market.pc.am sells at', usd(Number(p.sellPriceUsd), 6)],
      ['Exchange bid / ask', `${usd(bid, 6)} / ${usd(ask, 6)}`],
      ['Floor', usd(Number(p.rateFloorUsd), 4)]],
    why: p.stale ? 'price.pc.am says its data is stale'
      : ix && ix.refused ? 'price.pc.am REFUSED the latest index reading: ' + ix.refused.why
      : ix && ix.state === 'unknown' ? 'the exchange reports the index as unknown'
      : ix && ix.stale ? 'the index is stale: /credit-rate answers 503 and the rails hold'
      : !ix ? 'price.pc.am is not relaying the index' : '' }) };
}

function marketCard(base, svcs, sends) {
  const r = rowsOf(svcs, 'market.pc.am');
  if (!r || r.status === 'unreadable') {
    return { status: 'unknown', html: card({ icon: '&#128722;', title: 'Market & hot wallet', href: `${base}/services/market`,
      status: 'unknown', primary: '&mdash;', plabel: 'market-hot wallet', why: 'market.pc.am could not be read' }) };
  }
  const m = r.m;
  const gate = m['Sale gate']?.v;
  const status = gate === 'CLOSED' ? 'alert' : r.status === 'bad' ? 'watch' : 'ok';
  // Hand sends from market-hot (the old separate "Sends" card, folded in here:
  // it is the same wallet).
  const now = Date.now();
  const day = (sends || []).filter((x) => x && x.result === 'sent' && now - Date.parse(x.at || '') < 86400e3);
  const sentPcn = day.reduce((a, x) => a + (Number(x.pcn) || 0), 0);
  return { status, html: card({ icon: '&#128722;', title: 'Market & hot wallet', href: `${base}/services/market`, status,
    primary: t(m['Hot wallet']?.v), plabel: 'in the market-hot wallet (what market.pc.am can sell)',
    lines: [['Sale gate', t(gate)], ['Next buyer pays', t(m['Ask price']?.v)],
      ['Owed on orders', t(m['Owed on orders']?.v)], ['Orders', t(m['Orders']?.v)],
      ['Your sends, 24 h', day.length ? `${fmt(sentPcn, 2)} PCN in ${day.length}` : 'none']],
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

// The desk numbers its requests (#79) and the watcher names deposits; the
// request number is what the owner sees everywhere else, so show it here too.
function wrapCard(base, state, work, reqNos) {
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
  const nos = (kind) => (items || []).filter((i) => i.kind === kind).map(reqNos).filter(Boolean).join(', ');
  const cnt = (n, kind) => (n === null ? '&mdash;' : String(n) + (n && nos(kind) ? ` <span class="muted">(${esc(nos(kind))})</span>` : ''));
  return { status, html: card({ icon: '&#128260;', title: 'Wrap desk', href: `${base}/wrapdesk`, status,
    primary: nSend === null ? '&mdash;' : String(nSend), plabel: 'wraps ready for you to send',
    lines: [['Intake', state.open ? 'open' : '<span class="warn">closed</span>'],
      ['To send now', cnt(nSend, 'send')], ['Withheld', cnt(nHeld, 'withheld')], ['Confirming', cnt(nWait, 'waiting')],
      ['wPCN left to wrap', a ? `${fmt(a.left, 0)} of ${fmt(a.total, 0)}` : '&mdash;'],
      ['Checked', work && work.ranAt ? ago((Date.now() - Date.parse(work.ranAt)) / 1000) + ' ago' : '&mdash;']],
    why: !work || !work.ok ? 'the wrap-desk watcher could not be run' + (work && work.why ? ': ' + work.why : '')
      : nSend ? `${nSend} wrap(s) ready for you to send` : nHeld ? `${nHeld} wrap(s) withheld` : '' }) };
}

// The keeper's wallet balances come from the BSC snapshot (pcoin-bsc-snapshot,
// every 5 min). Older than 15 min, or unreadable, is UNKNOWN: an old balance
// shown as current is exactly what this page must never do.
const KEEPER_BNB_LOW = 0.005;   // gas; below this it cannot trade at all
const KEEPER_USDT_LOW = 25;     // owner, 2026-09-29: below $100 is fine; near empty is not
function keeperCard(base, k, snap) {
  const tun = k && k.tuning && k.tuning.state === 'ok' ? k.tuning.data : null;
  const eff = k && k.eff && k.eff.state === 'ok' ? k.eff.data : null;
  const st = k && k.st && k.st.state === 'ok' ? k.st.data : null;
  if (!tun) {
    return { status: 'alert', html: card({ icon: '&#9878;&#65039;', title: 'wPCN keeper', href: `${base}/keeper`, status: 'alert',
      primary: '&mdash;', plabel: 'defends the pool at', why: 'the tuning file is unreadable, so the keeper refuses to trade' }) };
  }
  const snapAge = snap ? Date.now() / 1000 - Number(snap.at) : Infinity;
  const bal = snap && snap.ok && snapAge < 900 ? snap : null;
  const lowBnb = bal && Number(bal.keeper_bnb) < KEEPER_BNB_LOW;
  const lowUsdt = bal && Number(bal.keeper_usdt) < KEEPER_USDT_LOW;
  const status = eff && eff.error ? 'alert' : lowBnb ? 'alert' : lowUsdt ? 'watch' : !bal ? 'unknown' : 'ok';
  // Floor mode defends buy_floor_usd; otherwise the keeper holds the pool at its
  // target = anchor x (1 - target_discount_pct/100). This card used to show the
  // floor ($0.0000 with floor mode off) and say "parity" even with a discount set
  // (12.2% since 2026-09-27), so show the target the keeper itself last computed.
  const floor = !!(eff && eff.floor_mode);
  const disc = Number(tun.target_discount_pct) || 0;
  const anchor = t(eff && eff.anchor ? eff.anchor : 'anchor');
  const mode = !eff ? '&mdash;' : floor ? 'floor'
    : disc ? `${anchor} &minus; ${fmt(disc, 1)}%` : `parity with the ${anchor}`;
  const target = floor ? usd(Number(tun.buy_floor_usd), 4) : usd(Number(eff?.target_price), 6);
  return { status, html: card({ icon: '&#9878;&#65039;', title: 'wPCN keeper', href: `${base}/keeper`, status,
    primary: bal ? '$' + fmt(Number(bal.keeper_usdt), 2) : '&mdash;',
    plabel: 'USDT in the keeper (what it buys wPCN with)',
    lines: [['wPCN in the keeper', bal ? fmt(Number(bal.keeper_wpcn), 2) : '&mdash;'],
      ['BNB for gas', bal ? fmt(Number(bal.keeper_bnb), 4) : '&mdash;'],
      ['Holds the pool at', `${target} <span class="muted">(${mode}, &plusmn;${fmt(Number(tun.dead_band) * 100, 0) ?? '?'}%)</span>`],
      ['Pool now', usd(Number(eff?.pool_price), 6)],
      ['Buying / selling', `${tun.buy ? 'on' : 'off'} / ${tun.sell ? 'on' : 'off'}`],
      ['Spent today', st ? `$${fmt(Number(st.usdt_spent || 0), 2)} of $${fmt(Number(tun.daily_usdt_cap), 0)}` : '&mdash;']],
    why: eff && eff.error ? String(eff.error).slice(0, 140)
      : lowBnb ? 'the keeper is almost out of BNB for gas: it cannot trade without it'
      : lowUsdt ? `under $${KEEPER_USDT_LOW} USDT left to defend the pool with`
      : !bal ? (snap ? `balances not refreshed for ${ago(snapAge)} (pcoin-bsc-snapshot)` : 'balances unreadable (pcoin-bsc-snapshot)') : '' }) };
}

// The BSC side beyond the keeper: the pool's depth, our wPCN inventory, and how
// much wPCN sits with people outside our wallets (what could be sold into the
// pool). Same snapshot; same staleness rule.
function bscCard(base, snap) {
  const age = snap ? Date.now() / 1000 - Number(snap.at) : Infinity;
  const b = snap && snap.ok && age < 900 ? snap : null;
  const status = b ? 'ok' : 'unknown';
  return { status, html: card({ icon: '&#129374;', title: 'wPCN on BNB Chain', href: `${base}/keeper`, status,
    primary: b ? fmt(Number(b.outside), 0) : '&mdash;', plabel: 'wPCN held by people outside our wallets',
    lines: [['Pancake pool', b ? `${fmt(Number(b.pool_wpcn), 0)} wPCN + $${fmt(Number(b.pool_usdt), 2)}` : '&mdash;'],
      ['Our wPCN inventory', b ? fmt(Number(b.inventory_wpcn), 0) : '&mdash;'],
      ['Read', snap ? ago(age) + ' ago' : '&mdash;']],
    why: b ? '' : snap ? `not refreshed for ${ago(age)}` : 'the BSC snapshot is missing' }) };
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

// Reporting is not enough: a server can report every half hour while one of its
// timers fails every run. So the card also counts every PCoin timer whose LAST
// run did not succeed, from what the hosts themselves reported.
function hostsCard(base, jobs, expected, staleSeconds) {
  const now = Date.now();
  const rows = expected.map(([h]) => {
    const d = jobs && jobs[h];
    const a = d ? (now - Date.parse(d.at || '')) / 1000 : Infinity;
    return { h, d, fresh: isFinite(a) && a <= staleSeconds };
  });
  const fresh = rows.filter((x) => x.fresh).length;
  const failing = [];
  let nTimers = 0;
  for (const r of rows.filter((x) => x.fresh)) {
    for (const tm of (r.d.timers || [])) {
      nTimers += 1;
      if (tm.last && tm.result && tm.result !== 'success') failing.push(`${tm.unit.replace(/\.timer$/, '')} on ${r.h}`);
    }
  }
  const status = fresh === 0 || failing.length ? 'alert' : fresh < rows.length ? 'watch' : 'ok';
  return { status, html: card({ icon: '&#128421;&#65039;', title: 'Servers & jobs', href: `${base}/jobs`, status,
    primary: String(failing.length), plabel: `scheduled jobs failing (of ${nTimers} on ${fresh} servers)`,
    lines: [['Servers reporting', `${fresh}/${rows.length}`],
      ...failing.slice(0, 4).map((x) => ['Failed', esc(x)]),
      ...rows.filter((x) => !x.fresh).slice(0, 3).map((x) => ['Not reporting', esc(x.h)])],
    why: failing.length ? `${failing.length} job(s) failed their last run`
      : fresh < rows.length ? `${rows.length - fresh} server(s) have not reported in over an hour` : '' }) };
}

export function overviewPage({ base, svcs, ex, exPublic, price, snap, wrap, work, reqNos = () => '', keeper, jobs, expected, staleSeconds, sends, needs = [], needsCard }) {
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
  // 2026-09-29, owner: "remove redundant data ... i should open admin and see
  // everything". Gone: the GPU earner (there is none), the separate PCN index
  // card (same number as Prices), "Services N/N" (each service has its own card
  // and its faults are in Needs you), and "Sends" (folded into Market). Added:
  // keeper balances and the BSC side, from the 5-minute snapshot.
  const cards = [
    chainCard(base, svcs), priceCard(base, price, exPublic, snap), keeperCard(base, keeper, snap),
    wrapCard(base, wrap, work, reqNos), exchangeCard(base, ex), marketCard(base, svcs, sends),
    bscCard(base, snap), payCard(base, svcs), hostsCard(base, jobs, expected, staleSeconds),
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
  ${needsHtml}
  <div class="ov-grid">${cards.map((c) => c.html).join('')}</div>
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
