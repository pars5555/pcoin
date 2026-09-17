// One detail page per service: everything the upstream will tell us about it.
//
// WHY THIS IS NOT A RAW JSON DUMP. "Show everything" and "print the payload" are
// different instructions, and on this estate the difference is a secret.
// pcnearner's /v1/admin/overview returns a LIVE app API key in
// `by_app[].api_key`; a page that pretty-printed what it received would publish
// that key to a browser. So every field below is named on purpose and the app key
// is masked to eight characters -- enough to tell two apps apart, not enough to
// use. That is the "redact by allow-list, never by pattern" rule applied to a
// rendering layer rather than to a grep.
//
// It keeps the same three rules services.mjs keeps: unknown renders as an
// em-dash and never as a zero, one unreadable upstream costs its own card and
// not the page, and nothing here writes.
import { upstreamGet, upstreamCreds } from './services.mjs';
import { esc, DASH, T, num, N, USD, PCT, YN, when, dur, agoIso, agoEpoch,
         hash, addr, card, note, kv, tbl, tiles, failed } from './ui.mjs';

const B = t => (t ? { Authorization: 'Bearer ' + t } : {});

// -- the four services ------------------------------------------------------
export const SERVICES = [
  {
    slug: 'market', name: 'market.pc.am', host: '178.105.178.27',
    unit: 'pcoin-market.service', dir: '/opt/pcoin-market',
    what: 'The PCN sale ladder and order desk. It holds a small hot wallet that ' +
          'auto-sends orders under the auto-send limit; anything larger is sent by hand ' +
          'from a wallet that has never been online.',
    endpoints: [
      ['GET /api/ops/summary', 'read token', 'ladder, backing, float, orders, settings'],
      ['GET /api/ladder/state', 'public', 'the rung state the public page renders from'],
      ['GET /api/ladder/gate', 'public', 'whether selling is open, and the divergence deciding it'],
    ],
    render: renderMarket,
  },
  {
    slug: 'wpcnpay', name: 'wpcnpay.pc.am', host: '178.105.3.51',
    unit: 'pcoin-wpcn-pay.service', dir: '/opt/pcoin-wpcn-pay',
    what: 'The shared wPCN payment verifier. Every rail that accepts wPCN calls this ' +
          'one service, so it is a single point of failure for all of them.',
    endpoints: [
      ['GET /stats', 'read token', 'counts and sums only — no payer, no user reference'],
      ['GET /health', 'public', 'is the verifier up'],
    ],
    render: renderWpcnpay,
  },
  {
    slug: 'pcnearner', name: 'pcnearner.pc.am', host: '178.105.178.27',
    unit: 'pcnearner.service', dir: '/opt/pcnearner',
    what: 'The GPU earner network: people run a worker, the queue hands it jobs, and ' +
          'they are paid in PCN.',
    endpoints: [
      ['GET /v1/admin/overview', 'X-Admin-Key', 'fleet, queue, devices, earners, accounts, totals'],
    ],
    render: renderEarner,
  },
  {
    slug: 'explorer', name: 'explorer.pc.am/admin', host: '178.105.3.51',
    unit: 'pcoin-ops.service', dir: '/opt/pcoin-ops',
    what: 'The ops dashboard: chain health, who is mining, the pool, and the balance of ' +
          'every fleet and payment-rail address in one place.',
    endpoints: [
      ['GET /admin/api', 'read token', 'chain, census, fleet balances, peers, tips, pool'],
    ],
    render: renderExplorer,
  },
];

export const bySlug = Object.fromEntries(SERVICES.map(s => [s.slug, s]));

// -- page assembly ----------------------------------------------------------
export async function detailFor(slug, BASE) {
  const svc = bySlug[slug];
  if (!svc) return null;
  const { status, body } = await svc.render(upstreamCreds());
  const dot = status === 'ok' ? '<span class="ok">&#9679;</span>'
            : status === 'bad' ? '<span class="bad">&#9679;</span>'
                               : '<span class="warn">&#9679;</span>';
  const head = card('Service', kv([
    ['Status', `${dot} ${esc((status || 'unknown').toUpperCase())}`],
    ['Host', `<code>${esc(svc.host)}</code>`],
    ['systemd unit', `<code>${esc(svc.unit)}</code>`,
      `<code>journalctl -u ${esc(svc.unit)} -n 100</code>`],
    ['Working directory', `<code>${esc(svc.dir)}</code>`],
  ]) + `<p style="margin-top:12px">${esc(svc.what)}</p>`);

  const reads = card('How this page reads it',
    tbl(['Endpoint', 'Auth', 'What it returns'],
      svc.endpoints.map(([e, a, w]) =>
        [`<code>${esc(e)}</code>`, esc(a), `<span class="muted">${esc(w)}</span>`])) +
    note('Each token opens exactly the route it is for and nothing else, every call is a GET, ' +
         'and readings are cached for 60 seconds. Nothing on this page can write.'));

  return {
    name: svc.name,
    body: `<p style="margin:-8px 0 16px"><a href="${BASE}/services">&larr; all services</a></p>` +
          body + head + reads,
  };
}

// -- market -----------------------------------------------------------------
async function renderMarket(c) {
  const [sum, state, gate] = await Promise.all([
    upstreamGet('https://market.pc.am/api/ops/summary', B(c.market?.readToken)),
    upstreamGet('https://market.pc.am/api/ladder/state'),
    upstreamGet('https://market.pc.am/api/ladder/gate'),
  ]);
  if (!sum.ok) return { status: 'unreadable', body: failed('market.pc.am', sum.error) };
  const d = sum.data, l = d.ladder || {}, st = state.ok ? state.data : {},
        g = gate.ok ? gate.data : null;
  const open = !!(g && g.open);
  const capped = l.askCapUsd && l.marginalPrice >= l.askCapUsd - 1e-9;

  const body = tiles([
    ['Ask price', USD(l.marginalPrice, 6)],
    ['Sale gate', g ? (open ? '<span class="ok">OPEN</span>' : '<span class="bad">CLOSED</span>') : DASH],
    ['Sellable now', N(l.sellableNowPcn, 0) + ' <span class="muted" style="font-size:14px">PCN</span>'],
    ['Hot wallet', d.float
      ? N(d.float.hotWalletPcn, 0) + ' <span class="muted" style="font-size:14px">PCN</span>' : DASH],
    ['Sold', PCT(l.pctSold, 2)],
    ['Orders delivered', d.orders ? N(d.orders.delivered?.count, 0) : DASH],
  ]) +

  card('Ladder', kv([
    ['Marginal (ask) price', USD(l.marginalPrice, 6),
      capped ? '<span class="warn">held at the cap</span>' : 'the rung the next PCN sells at'],
    ['Next fill price', USD(st.nextFillPrice, 6)],
    ['Ask cap', USD(l.askCapUsd, 6),
      '24-hour median pool price &times;1.05, floored at the service rate'],
    ['Rung marginal price', USD(l.rungMarginalPrice, 6),
      'what the book alone would ask, ignoring the cap'],
    ['Floor price', USD(l.floorPrice, 6)],
    ['Top price', USD(st.topPrice, 2)],
    ['Rungs', N(st.rungCount, 0), st.stepPct !== undefined ? PCT(st.stepPct, 2) + ' per rung' : ''],
    ['Book size', N(st.totalPcn, 0) + ' PCN'],
    ['Sold', N(l.soldPcn, 2) + ' PCN', PCT(l.pctSold, 2) + ' of the book'],
    ['Reserved', N(l.reservedPcn, 2) + ' PCN', 'held against orders not yet delivered'],
    ['Retired', N(l.retiredPcn, 2) + ' PCN', st.pctRetired !== undefined ? PCT(st.pctRetired, 3) : ''],
    ['Remaining on the book', N(l.remainingPcn, 2) + ' PCN'],
    ['Deliverable', N(l.deliverablePcn, 0) + ' PCN', 'PCN actually backing the book'],
    ['Sellable now', N(l.sellableNowPcn, 0) + ' PCN',
      'the smaller of the two — what can really be bought'],
  ]) + (
    (typeof l.remainingPcn === 'number' && typeof l.deliverablePcn === 'number' &&
     l.remainingPcn > l.deliverablePcn + 1)
      ? `<p class="warn" style="margin-top:12px">The book still lists
         ${esc(num(l.remainingPcn, 0))} PCN but only ${esc(num(l.deliverablePcn, 0))} PCN is
         deliverable. The page sells the smaller number, so nobody can buy what is not there
         &mdash; but the two should be reconciled by raising the cap or trimming the book.</p>`
      : '')) +

  (g ? card('Sale gate', kv([
    ['Selling', open ? '<span class="ok">OPEN</span>' : '<span class="bad">CLOSED</span>'],
    ['Divergence', PCT(g.divergencePct, 2),
      'of a ' + esc(String(d.settings?.maxDivergencePct ?? '?')) + '% limit'],
    ['Buyback', YN(st.buybackOpen, 'open', 'closed')],
  ]) + note(
    'Divergence is how far the posted ask has drifted above the pool: ' +
    '<code>1.05 &times; (pool when capped &divide; pool now) &minus; 1</code>. ' +
    'It is the 5% premium <b>plus</b> every point the pool has fallen since the cap was last ' +
    'touched, which is why holding a cap is not free — the gate closes on its own as the ' +
    'pool drops away from it.'))
    : failed('Sale gate', gate.error)) +

  (d.backing ? card('Backing', kv([
    ['Owner holds', N(d.backing.ownerPcn, 2) + ' PCN'],
    ['Owed on orders', N(d.backing.owedPcn, 2) + ' PCN'],
    ['Headroom', N(d.backing.headroomPcn, 2) + ' PCN', 'owner minus owed'],
    ['Reading', d.backing.degraded ? '<span class="warn">degraded</span>'
      : '<span class="ok">clean</span>', d.backing.manual ? 'set by hand' : 'read live'],
    ['Read age', dur((d.backing.ageMs || 0) / 1000)],
  ])) : failed('Backing', d.backingError)) +

  (d.float ? card('Float', kv([
    ['Hot wallet', N(d.float.hotWalletPcn, 8) + ' PCN'],
    ['Auto-sends up to', USD(d.settings?.autoMaxUsd, 2), 'larger orders are sent by hand'],
  ]) + note('This is a till, kept small on purpose. It is one of only two wallets in the ' +
            'estate a server can spend from.')) : failed('Float', d.floatError)) +

  (d.orders ? card('Orders', tbl(['State', 'Count', 'USD'],
    Object.entries(d.orders).map(([k, v]) =>
      [esc(k.replace(/_/g, ' ')), N(v.count, 0), USD(v.usd, 2)])))
    : failed('Orders', d.ordersError)) +

  card('Limits and settings', kv([
    ['Sale open', YN(d.settings?.saleOpen)],
    ['Buyback open', YN(d.settings?.buybackOpen)],
    ['Minimum order', USD(d.settings?.minOrderUsd, 2)],
    ['Maximum order', USD(d.settings?.maxOrderUsd, 2),
      st.maxOrderUsdNow !== undefined ? USD(st.maxOrderUsdNow, 2) + ' available right now' : ''],
    ['Maximum order (PCN)', N(d.settings?.maxOrderPcn, 0) + ' PCN'],
    ['Auto-send ceiling', USD(d.settings?.autoMaxUsd, 2)],
    ['Divergence limit', PCT(d.settings?.maxDivergencePct, 0)],
    ['Ladder price band', USD(d.settings?.ladderMinPriceUsd, 6) + ' – ' +
      USD(d.settings?.ladderMaxPriceUsd, 6)],
  ])) +

  card('Process', kv([
    ['Service', T(d.service)],
    ['Uptime', dur(d.uptimeSeconds)],
    ['Snapshot taken', when(d.at), agoIso(d.at)],
  ]));

  return { status: open ? 'ok' : 'bad', body };
}

// -- wpcnpay ----------------------------------------------------------------
async function renderWpcnpay(c) {
  const [stats, health] = await Promise.all([
    upstreamGet('https://wpcnpay.pc.am/stats', B(c.wpcnpay?.readToken)),
    upstreamGet('https://wpcnpay.pc.am/health'),
  ]);
  const up = !!(health.ok && health.data.ok);
  const d = stats.ok ? stats.data : null;

  const body = tiles([
    ['Verifier', up ? '<span class="ok">UP</span>' : '<span class="bad">DOWN</span>'],
    ['Claims banked', d ? N(d.claims, 0) : DASH],
    ['wPCN taken', d ? N(d.wpcn_total, 2) : DASH],
    ['USD credited', d ? USD(d.usd_credited_total, 2) : DASH],
    ['Projects wired', d ? N(d.projects_configured, 0) : DASH],
    ['Bonus', d ? PCT(d.bonus_percent, 0) : DASH],
  ]) +

  card('Verifier', kv([
    ['State', up ? '<span class="ok">up</span>' : '<span class="bad">DOWN</span>'],
    ['Confirmations required', d ? N(d.min_confirmations, 0) : DASH,
      'BSC blocks before a claim is credited'],
    ['Paid to', d ? addr(d.pay_to) : DASH, 'the BEP-20 address customers send wPCN to'],
  ]) + note(up
    ? 'Every rail that accepts wPCN calls this one service. While it is up they all work; ' +
      'while it is down <b>none</b> of them can take wPCN, and it has no dedicated monitor yet.'
    : '<b class="bad">No rail can take wPCN right now.</b> This is a single point of failure ' +
      'for every wPCN payment across the estate.')) +

  (d ? card('Claims', kv([
    ['Banked', N(d.claims, 0)],
    ['Today', N(d.claims_today, 0)],
    ['Newest', when(d.newest_claim_at), agoIso(d.newest_claim_at)],
    ['wPCN total', N(d.wpcn_total, 2) + ' wPCN'],
    ['USD credited', USD(d.usd_credited_total, 2)],
    ['Unreadable ledger records', d.unreadable_records
      ? `<span class="bad">${N(d.unreadable_records, 0)}</span>` : N(0, 0),
      'a record that cannot be parsed is counted, never skipped silently'],
  ])) : failed('Claims', stats.error)) +

  (d && d.by_project ? card('By project', tbl(['Project', 'Claims', 'wPCN', 'USD credited'],
    Object.entries(d.by_project)
      .sort((a, b) => b[1].claims - a[1].claims)
      .map(([k, v]) => [esc(k), N(v.claims, 0), N(v.wpcn, 2), USD(v.usd, 4)])) +
    note('Configured projects: ' + esc(String(d.projects_configured)) +
         '. A project with no claims still appears in the configuration but not in this table.'))
    : '') +

  (d ? card('Terms', kv([
    ['Bonus over PCN', PCT(d.bonus_percent, 0),
      d.bonus_percent ? 'paying in wPCN earns this much extra credit'
        : 'currently zero — the bonus-versus-wrap-fee loop is still open'],
    ['Ledger key', '<code>(txhash, logIndex)</code>',
      'one transaction can carry several Transfer logs; keying on the hash alone drops the second'],
  ])) : '');

  return { status: up ? 'ok' : 'bad', body };
}

// -- pcnearner --------------------------------------------------------------
async function renderEarner(c) {
  const r = await upstreamGet('https://pcnearner.pc.am/v1/admin/overview',
    c.pcnearner?.adminKey ? { 'X-Admin-Key': c.pcnearner.adminKey } : {});
  if (!r.ok) return { status: 'unreadable', body: failed('pcnearner.pc.am', r.error) };
  const d = r.data, f = d.fleet || {}, q = d.queue || {}, t = d.totals || {}, s = d.settings || {};

  const body = tiles([
    ['Devices online', N(f.devices_online, 0) +
      '<span class="muted" style="font-size:14px">/' + (num(f.devices_total, 0) ?? '?') + '</span>',
      f.devices_online ? 'green' : 'yellow'],
    ['Earners online', N(f.earners_online, 0) +
      '<span class="muted" style="font-size:14px">/' + (num(f.earners_total, 0) ?? '?') + '</span>'],
    ['Queued', N(q.queued, 0)],
    ['Tasks done', N(t.done, 0)],
    ['Paid out', USD(t.usd, 4)],
    ['GPU time', t.gpu_seconds !== undefined
      ? N(t.gpu_seconds / 3600, 1) + ' <span class="muted" style="font-size:14px">h</span>' : DASH],
  ]) +

  card('Fleet', kv([
    ['Devices', N(f.devices_total, 0),
      N(f.devices_online, 0) + ' online &middot; ' + N(f.devices_working, 0) + ' working'],
    ['Earners (workers)', N(f.earners_total, 0),
      N(f.earners_online, 0) + ' online &middot; ' + N(f.earners_working, 0) + ' working &middot; ' +
      N(f.earners_paused, 0) + ' paused'],
    ['Worker processes', N(f.worker_processes, 0)],
    ['VRAM pooled', N(f.vram_total_gb, 0) + ' GB', 'across online devices only'],
    ['Accounts', N(f.accounts_total, 0), N(f.signed_in_devices, 0) + ' signed-in devices'],
  ])) +

  card('Queue', kv([
    ['Queued', N(q.queued, 0)],
    ['Running', N(q.running, 0)],
    ['Done', N(q.done, 0)],
    ['Failed', q.failed ? `<span class="warn">${N(q.failed, 0)}</span>` : N(q.failed, 0)],
    ['Cancelled', N(q.cancelled, 0)],
    ['Runnable right now', (d.runnable_now || []).length
      ? esc((d.runnable_now || []).join(', ')) : '<span class="warn">nothing</span>',
      (d.runnable_now || []).length ? ''
        : 'no online worker holds the models any queued task needs'],
  ])) +

  card('Devices', tbl(['Machine', 'GPU', 'VRAM', 'Disk free', 'State', 'Jobs', 'Earned', 'Last seen'],
    (d.devices || []).map(x => [
      `<code>${esc(x.machine_id)}</code>`, esc(x.gpu || '—'),
      x.vram_gb ? N(x.vram_gb, 0) + ' GB' : DASH,
      x.disk_free_gb ? N(x.disk_free_gb, 1) + ' GB' : DASH,
      x.alive ? (x.working ? '<span class="ok">working</span>' : '<span class="ok">idle</span>')
              : '<span class="muted">offline</span>',
      N(x.jobs_done, 0), USD(x.usage_usd, 4),
      `<span class="muted">${agoIso(x.last_seen)}</span>`]))) +

  card('Earners', tbl(['Worker', 'Account', 'State', 'Models', 'Jobs', 'GPU time', 'Last job'],
    (d.earners || []).map(x => [
      `<code>${esc(x.worker_id)}</code>`, esc(x.account || '—'),
      x.alive ? `<span class="ok">${esc(x.state || 'up')}</span>`
              : `<span class="muted">offline, ${agoIso(x.last_seen)}</span>`,
      N((x.models_held || []).length, 0) + ' held',
      N(x.jobs_done, 0),
      x.usage_gpu_s ? N(x.usage_gpu_s / 60, 1) + ' min' : DASH,
      `<span class="muted">${agoIso(x.last_job_at)}</span>`]))) +

  card('Accounts', tbl(['Account', 'Payout address', 'Devices', 'Earned', 'Paid', 'Unpaid', 'Jobs paid'],
    (d.accounts || []).map(x => [
      esc(x.username) + (x.disabled ? ' <span class="bad">disabled</span>' : ''),
      addr(x.payout_address), N(x.devices, 0),
      USD(x.earned_usd, 4), USD(x.paid_usd, 4),
      x.unpaid_usd > 0.0001 ? `<span class="warn">${USD(x.unpaid_usd, 4)}</span>`
        : USD(x.unpaid_usd, 4),
      N(x.jobs_paid, 0)])) +
    note('A payout address is validated against the node before it is accepted, and the date ' +
         'of that check is kept with it.')) +

  card('Totals', kv([
    ['Tasks', N(t.tasks, 0),
      N(t.done, 0) + ' done &middot; ' + N(t.failed, 0) + ' failed &middot; ' +
      N(t.cancelled, 0) + ' cancelled'],
    ['GPU seconds', N(t.gpu_seconds, 0), N(t.gpu_seconds / 3600, 2) + ' hours'],
    ['Paid in USD', USD(t.usd, 6)],
    ['Paid in PCN', N(t.pcn, 6) + ' PCN'],
    ['Average run', t.avg_run_ms ? N(t.avg_run_ms / 1000, 1) + ' s' : DASH],
    ['Average wait in queue', t.avg_queue_ms ? N(t.avg_queue_ms / 1000, 1) + ' s' : DASH],
  ])) +

  card('By task type', tbl(['Type', 'Tasks', 'Done', 'USD', 'Avg run', 'Max run'],
    (t.by_type || []).map(x => [
      `<code>${esc(x.type)}</code>`, N(x.n, 0), N(x.done, 0), USD(x.usd, 6),
      x.avg_run_ms ? N(x.avg_run_ms / 1000, 1) + ' s' : DASH,
      x.max_run_ms ? N(x.max_run_ms / 1000, 1) + ' s' : DASH]))) +

  card('By calling app', tbl(['App key', 'Tasks', 'Done', 'Failed', 'GPU time', 'USD', 'Last seen'],
    (d.by_app || []).map(x => [
      // Masked on purpose: eight characters tell two apps apart and cannot be used.
      `<code>${esc(String(x.api_key || '').slice(0, 8))}…</code>`,
      N(x.tasks, 0), N(x.done, 0), N(x.failed, 0),
      x.gpu_seconds ? N(x.gpu_seconds / 60, 1) + ' min' : DASH,
      USD(x.usd, 6), `<span class="muted">${agoIso(x.last_seen)}</span>`])) +
    note('App keys are <b>masked to eight characters</b>. They are live credentials and a ' +
         'panel is not a place to print one.')) +

  card('Settings', kv([
    ['Reference GPU', T(s.reference_gpu)],
    ['Anchor rate', USD(s.anchor_usd_per_day, 2) + ' / day',
      USD(s.anchor_usd_per_gpu_hour, 4) + ' per GPU hour'],
    ['Signup bonus', USD(s.signup_bonus_usd, 2)],
    ['Result retention', N(s.retention_hours, 0) + ' h'],
    ['Attempts per task', N(s.max_attempts, 0)],
    ['Queue timeout', N(s.queue_timeout_minutes, 0) + ' min'],
    ['Apps registered', N(s.apps_registered, 0), N(s.api_keys_configured, 0) + ' API keys configured'],
    ['Dev key', YN(s.dev_key_active, 'ACTIVE', 'off')],
    ['Admin login', YN(s.admin_login_configured, 'configured', 'NOT configured')],
    ['Node', T(s.node_version), 'up ' + dur(s.uptime_s)],
  ]));

  return { status: 'ok', body };
}

// -- explorer ops -----------------------------------------------------------
async function renderExplorer(c) {
  const r = await upstreamGet('https://explorer.pc.am/admin/api', B(c.ops?.readToken));
  if (!r.ok) return { status: 'unreadable', body: failed('explorer.pc.am/admin', r.error) };
  const d = r.data, ch = d.chain || {}, cen = d.census || {}, st = d.state || {},
        p = st.peers || {}, tips = st.tips || {}, pool = st.pool || null;

  // ── the page, in words ───────────────────────────────────────────────────
  // See the note inside: several numbers below mean something other than what
  // they look like, and this is where that is said out loud.
  const plain = [];
  plain.push(`The chain is at height <b>${N(ch.height, 0)}</b> and the explorer is `
    + (ch.blocksBehind === 0 ? 'in step with the node'
      : `<b class="warn">${N(ch.blocksBehind, 0)} block(s) behind the node</b>`)
    + (ch.tipAge !== undefined
      ? `. The last block arrived <b>${N(ch.tipAge / 60, 1)} minutes ago</b>; the target is one
         every 10 minutes, and gaps of half an hour happen often and are not a fault.` : '.'));

  if (p && p.total !== undefined) {
    plain.push(`<b>${N(p.total, 0)} connections</b> are open to the seed node — and that is
      connections, <b>not machines</b>. They come from <b>${N(p.distinctIps, 0)} distinct
      addresses</b>${p.inbound !== undefined
        ? `, ${N(p.inbound, 0)} of them dialled in to us and ${N(p.outbound, 0)} dialled out by us`
        : ''}, so the honest count of other computers is nearer
      <b>${N(p.distinctIps, 0)}</b> than ${N(p.total, 0)}. One machine can hold several
      connections. Measured ${p.at ? T(p.at) : 'at an unknown time'}.`);
  }
  if (ch.peersSeenByExplorerNode !== undefined && p && p.total !== undefined) {
    plain.push(`Further down you will see <b>“Peers seen by this node: ${N(ch.peersSeenByExplorerNode, 0)}”</b>,
      which looks like it contradicts the ${N(p.total, 0)} above. It does not: that one is the
      <b>explorer's own node</b>, a separate daemon with its own peers, while ${N(p.total, 0)} is
      the seed's. Two machines, two counts, both right.`);
  }

  if (cen && cen.blocksRead) {
    const soloPct = cen.solo ? (cen.solo.blocks / cen.blocksRead * 100) : 0;
    const poolPct = 100 - soloPct;
    plain.push(`Of the last <b>${N(cen.blocksRead, 0)} blocks</b>, about
      <b>${PCT(poolPct, 0)}</b> were found by <b>${N(cen.poolCount, 0)} pool(s)</b> and
      <b>${PCT(soloPct, 0)}</b> by <b>${N(cen.solo?.miners, 0)} people mining alone</b>.`
      + (cen.poolCount === 1
        ? ' Only one pool has found a block in that window, so pool mining here is still one pool.'
        : ''));
    if (pool && pool.connectedMiners !== undefined) {
      plain.push(`Our own pool has <b>${N(pool.connectedMiners, 0)} machines connected right now</b>,
        but only <b>${N(cen.poolMiners, 0)} addresses were actually paid</b> in those
        ${N(cen.blocksRead, 0)} blocks. Both are true: a machine that has joined but not yet
        earned a share of a block appears in the first number and not the second. The connected
        count comes from the pool itself and is the only figure on this page that is measured
        rather than worked out from the chain.`);
    }
  }

  const body = card('In plain words', plain.map(t => `<p>${t}</p>`).join('')
    + note('Everything in this paragraph is read from the same live data as the cards below, '
         + 'never typed in — a number written into prose is one that goes stale without '
         + 'anybody noticing, and this is the part of the page most likely to be believed.')) +

  tiles([
    ['Height', N(ch.height, 0)],
    ['Tip age', ch.tipAge !== undefined
      ? N(ch.tipAge / 60, 1) + ' <span class="muted" style="font-size:14px">min</span>' : DASH],
    ['Difficulty', N(ch.difficulty, 4)],
    ['Network hashrate', hash(ch.hashrate)],
    ['Peers', N(p.total, 0)],
    ['Mempool', N(ch.mempool?.tx_count ?? st.mempoolCount, 0)],
  ]) +

  card('Chain', kv([
    ['Height', N(ch.height, 0),
      ch.blocksBehind !== undefined ? N(ch.blocksBehind, 0) + ' behind' : ''],
    ['Status', ch.status === 'ok' ? '<span class="ok">ok</span>'
      : `<span class="bad">${T(ch.status)}</span>`],
    ['Tip age', ch.tipAge !== undefined ? N(ch.tipAge / 60, 1) + ' min' : DASH,
      'target spacing is 10 minutes'],
    ['Difficulty', N(ch.difficulty, 6)],
    ['Median spacing', ch.medianSpacing !== undefined ? N(ch.medianSpacing / 60, 1) + ' min' : DASH,
      'judge pace on the median, never the mean'],
    ['Mean spacing', ch.meanSpacing !== undefined ? N(ch.meanSpacing / 60, 1) + ' min' : DASH,
      'skewed by outliers; block timestamps are not monotonic in height'],
    ['Network hashrate', hash(ch.hashrate), 'derived from recent spacing'],
    ['LWMA', YN(ch.lwmaActive, 'active', 'not yet'),
      'gate at height ' + (num(ch.gate, 0) ?? '?') +
      (ch.toGate ? ', ' + num(ch.toGate, 0) + ' to go' : '')],
    ['Peers seen by this node', N(ch.peersSeenByExplorerNode, 0)],
  ])) +

  card('Mempool', kv([
    ['Transactions', N(ch.mempool?.tx_count ?? st.mempoolCount, 0)],
    ['Node reachable', YN(ch.mempool?.node_reachable)],
    ['Observed', ch.mempool?.observed_seconds_ago !== undefined
      ? N(ch.mempool.observed_seconds_ago, 2) + ' s ago' : DASH],
    ['Known', YN(ch.mempool?.known, 'yes', 'UNKNOWN')],
  ]) + note('"Known" is its own state. An unreadable mempool is not an empty one, and a wallet ' +
            'that treats the two the same will hand back an outpoint it has already spent.')) +

  card('Reorgs and tips', kv([
    ['Blocks unwound (lifetime)', N(ch.blocksUnwound, 0)],
    ['Chain tips', N(tips.total, 0),
      N(tips.competing, 0) + ' competing &middot; worst branch ' + (num(tips.worst, 0) ?? '?')],
  ]) + note('<b class="warn">These are cumulative lifetime counters. Never gate on their value.</b> ' +
            'One ordinary 1-block reorg set <code>blocksUnwound</code> to 1 permanently and every ' +
            'one of the six payment rails silently refused to credit anything for three and a half ' +
            'days. The correct gate is <code>index.stale == false</code> plus ' +
            '<code>blocks_behind == 0</code>; for a real mid-reorg signal use the <i>change</i> ' +
            'between two reads.')) +

  card(`Mining census — last ${num(cen.window, 0) ?? '?'} blocks`,
    kv([
      ['Blocks read', N(cen.blocksRead, 0), 'at tip ' + (num(cen.tip, 0) ?? '?')],
      ['Distinct miners', N(cen.distinct, 0)],
      ['Pool blocks', N(cen.poolBlocks, 0),
        cen.total ? PCT(cen.poolBlocks / cen.total * 100, 1) + ' of the window' : ''],
      ['Ours', N(cen.yours, 0)],
    ]) +
    tbl(['Miner', 'Blocks', 'Share', 'Kind'],
      (cen.rows || []).map(x => [
        x.address === '__pool__' ? '<b>the pool</b>' : addr(x.address),
        N(x.blocks, 0), PCT((x.share || 0) * 100, 1),
        x.pool ? '<span class="muted">pool</span>'
          : x.mine ? '<span class="ok">ours</span>' : '<span class="muted">outside</span>'])) +
    note('A pool block pays many addresses and a solo block pays one, which is how they are told ' +
         'apart. Judge concentration on a window of 300+ blocks and on the upper bound of the ' +
         'interval, not the point estimate — a 60-block window swings &plusmn;13 points.')) +

  card(`Who is mining — last ${num(cen.blocksRead, 0) ?? '?'} blocks read`,
    kv([
      ['Pools working', N(cen.poolCount, 0),
        cen.poolCount === 0 ? 'no pool found a block in this window' : ''],
      ['Miners on pools', N(cen.poolMiners, 0), 'distinct payout addresses paid in the window'],
      ['Solo miners', N(cen.solo?.miners, 0),
        N(cen.solo?.blocks, 0) + ' blocks &middot; ' +
        (cen.blocksRead ? PCT((cen.solo?.blocks || 0) / cen.blocksRead * 100, 1) : DASH) + ' of the window'],
      // The age goes NEXT TO the number, not in a footnote. This row says
      // "connected now" and would go on saying it if the collector stopped —
      // a stale figure that looks current is worse than no figure.
      ['Our pool, connected', N(pool?.connectedMiners, 0),
        pool?.at ? 'measured ' + agoEpoch(pool.at) + ' — from the pool itself, and the only '
          + 'authoritative number here; the rest are inferred from the chain'
          : '<b class="warn">no pool snapshot — this number is not being collected</b>'],
    ]) +
    tbl(['Pool', 'Whose', 'Blocks', 'Share', 'Miners paid', 'Last block'],
      (cen.pools || []).map(x => [
        '<code>' + T(x.id) + '</code>',
        x.ours === true ? '<span class="ok">ours</span>'
          : x.ours === false ? '<span class="warn">independent</span>'
          : '<span class="muted">unknown</span>',
        N(x.blocks, 0),
        cen.blocksRead ? PCT(x.blocks / cen.blocksRead * 100, 1) : DASH,
        N(x.miners, 0),
        N(x.lastHeight, 0)]),
      'No pool found a block in this window.') +
    note('<b>The chain does not label pools, so these are inferred.</b> A pool pays its miners in ' +
         'the coinbase, so blocks sharing payout addresses are grouped as one pool. Three things ' +
         'that makes wrong, none fixable from the chain: one person mining on two pools merges ' +
         'them into one; "miners paid" counts distinct ADDRESSES in this window, so one person ' +
         'with three addresses counts three and a miner who earned nothing counts zero; and a pool ' +
         'that pays a single address in a block looks exactly like a solo miner. ' +
         'The live figure above is the only authoritative one, and only for our own pool.' +
         (cen.ourPoolKnown ? '' : ' <b class="warn">Our pool\'s payout address is not known here, ' +
          'so no row could be marked as ours — every pool below shows as unknown rather than ' +
          'being guessed at.</b>'))) +

  (pool ? card('Pool', kv([
    ['Payout address', addr(pool.address)],
    ['Fee', PCT(pool.feePercent, 0)],
    ['Connected miners', N(pool.connectedMiners, 0), N(pool.sharesPerSecond, 0) + ' shares/s'],
    ['Pool hashrate', hash(pool.poolHashrate),
      pool.networkHashrate ? PCT(pool.poolHashrate / pool.networkHashrate * 100, 1) +
        ' of ' + hash(pool.networkHashrate) : ''],
    ['Blocks found', N(pool.blocks?.mature, 0) + ' mature',
      N(pool.blocks?.pending, 0) + ' pending &middot; ' + N(pool.blocks?.orphaned, 0) + ' orphaned'],
    ['Found in 24 h', N(pool.blocks?.found24h, 0)],
    ['Last update', agoEpoch(pool.at)],
  ])) : '') +

  (pool && (pool.miners || []).length
    ? card(`Top pool miners — ${num(pool.miners.length, 0)} total`,
        tbl(['Address', 'Share 24 h', 'Shares 24 h', 'Blocks found', 'Paid', 'Last share'],
          pool.miners.slice()
            .sort((a, b) => (b.share24h || 0) - (a.share24h || 0)).slice(0, 15)
            .map(x => [addr(x.address), PCT((x.share24h || 0) * 100, 2),
              N(x.shares24h, 0), N(x.blocksFound, 0),
              N((x.paidSat || 0) / 1e8, 2) + ' PCN',
              `<span class="muted">${agoEpoch(x.lastShareAt)}</span>`])) +
        note('Showing the 15 largest by 24-hour share.'))
    : '') +

  (d.fleet ? card('Fleet and payment-rail balances',
    tbl(['Address', 'Label', 'Mature', 'Immature', 'Total', 'Lifetime received'],
      d.fleet.slice()
        .sort((a, b) => Number(b.total) - Number(a.total))
        .map(x => [addr(x.address), `<span class="muted">${esc(x.label || '')}</span>`,
          N(Number(x.mature), 2), N(Number(x.immature), 2),
          `<b>${N(Number(x.total), 2)}</b>`, N(Number(x.lifetime), 2)])) +
    note('A low balance on a miner usually means it is <b>working</b> — every forwarding ' +
         'device sweeps to the treasury, so its own balance returns to zero by design. The one ' +
         'address here that never moves is not a forwarding failure: it belongs to a family ' +
         'member and must never be swept.'))
    : failed('Fleet balances', d.fleetError)) +

  card('Peers', kv([
    ['Connections', N(p.total, 0),
      N(p.inbound, 0) + ' inbound &middot; ' + N(p.outbound, 0) + ' outbound'],
    ['Distinct addresses', N(p.distinctIps, 0)],
    ['Read at', T(p.at)],
  ]) + ((p.byIp || []).length
    ? tbl(['Address', 'Connections', 'Height', 'In', 'Out'],
        p.byIp.slice().sort((a, b) => b.connections - a.connections).slice(0, 12)
          .map(x => [`<code>${esc(x.ip)}</code>`, N(x.connections, 0), N(x.height, 0),
            N(x.inbound, 0), N(x.outbound, 0)]))
    : '') +
    note('Showing the 12 addresses with the most connections.')) +

  card('Snapshot', kv([
    ['Collected', when(st.at), agoIso(st.at)],
  ]) + note('A stale snapshot is the collector’s own alarm: this dashboard once displayed ' +
            '54 IPs and 68 connections as current for thirteen days while the truth was 102 and ' +
            '152, because the collector was dying every four minutes into <code>/dev/null</code>.'));

  return { status: 'ok', body };
}
