// Read all four PCoin-core services through their read-only endpoints.
//
// Each upstream has its own narrowly-scoped credential in upstream.json (0600),
// and every one of them was tested to open EXACTLY the route it is for and
// nothing else -- the ops token cannot reach /fleet or /wrap, the wpcnpay token
// cannot reach /verify or /claims, the market token cannot reach /admin.
//
// THREE RULES THIS FILE KEEPS.
//
//   1. Unknown is never a number. Every upstream reports either a value or an
//      explicit error. An unreadable float renders as "unreadable", never as 0,
//      because "the till is empty" and "I could not look" must not be the same
//      pixel. This estate has been bitten by that specific tie more than once.
//   2. One slow upstream must not blank the page. Each is settled independently
//      and rendered on its own; a service that times out costs its own card.
//   3. Nothing here writes. Not one of these calls is a POST, and none of the
//      tokens could perform one if it were.
import { readFileSync, existsSync } from 'node:fs';
// The ops dashboard runs on THIS host. Read it over loopback: since 2026-09-24
// its public path (explorer.pc.am/admin) is locked to the owner's addresses,
// and a public round trip through Cloudflare was never needed for a neighbour.
const OPS_API = process.env.ADMIN_OPS_API || 'http://127.0.0.1:8787/api';

const UPSTREAM = process.env.ADMIN_UPSTREAM || '/opt/pcoin-admin/upstream.json';
const TTL_MS = 60_000;
const cache = new Map();

const creds = () => {
  try { return existsSync(UPSTREAM) ? JSON.parse(readFileSync(UPSTREAM, 'utf8')) : {}; }
  catch { return {}; }
};

async function get(url, headers = {}) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.val;
  let val;
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    val = { ok: true, data: await r.json() };
  } catch (e) {
    val = { ok: false, error: e.message };
  }
  cache.set(url, { at: Date.now(), val });
  return val;
}

const num = (x, d = 2) => (typeof x === 'number' && isFinite(x))
  ? x.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }) : null;
const or = (v, alt = 'unreadable') => v === null || v === undefined ? alt : v;

export async function collect() {
  const c = creds();
  const bearer = t => (t ? { Authorization: 'Bearer ' + t } : {});

  const [mkt, gate, ops, earner, stats, health, poolApi] = await Promise.all([
    get('https://market.pc.am/api/ops/summary', bearer(c.market?.readToken)),
    get('https://market.pc.am/api/ladder/gate'),
    get(OPS_API, bearer(c.ops?.readToken)),
    get('https://pcnearner.pc.am/v1/admin/overview',
        c.pcnearner?.adminKey ? { 'X-Admin-Key': c.pcnearner.adminKey } : {}),
    get('https://wpcnpay.pc.am/stats', bearer(c.wpcnpay?.readToken)),
      get('https://wpcnpay.pc.am/health'),
      // The pool is the ONLY thing that knows how many miners are actually
      // connected. Public route, no credential.
      get('https://pool.pc.am/api/pools/pcoin'),
  ]);

  const out = [];

  // ── market ───────────────────────────────────────────────────────────────
  {
    const s = { slug: 'market', name: 'market.pc.am', host: '178.105.178.27', rows: [], notes: [] };
    if (mkt.ok) {
      const d = mkt.data, l = d.ladder || {}, b = d.backing, f = d.float, o = d.orders;
      s.status = (gate.ok && gate.data.open) ? 'ok' : 'bad';
      s.rows.push(['Ask price', '$' + num(l.marginalPrice, 6),
        l.askCapUsd && l.marginalPrice >= l.askCapUsd - 1e-9
          ? 'held at the cap (rung $' + num(l.rungMarginalPrice, 6) + ')' : '']);
      if (gate.ok) s.rows.push(['Sale gate', gate.data.open ? 'OPEN' : 'CLOSED',
        'divergence ' + num(gate.data.divergencePct) + '% of ' +
        (d.settings?.maxDivergencePct ?? '?') + '% limit']);
      s.rows.push(['Available to buy', or(num(l.sellableNowPcn, 0)) + ' PCN',
        num(l.remainingPcn, 0) + ' on the ladder, ' + or(num(l.deliverablePcn, 0)) + ' deliverable']);
      s.rows.push(['Hot wallet', f ? num(f.hotWalletPcn, 2) + ' PCN' : 'unreadable',
        f ? 'auto-sends up to $' + d.settings?.autoMaxUsd : d.floatError || '']);
      if (b) s.rows.push(['Owed on orders', num(b.owedPcn, 2) + ' PCN',
        'headroom ' + num(b.headroomPcn, 2) + (b.degraded ? ' (degraded read)' : '')]);
      else s.notes.push('backing unreadable: ' + d.backingError);
      if (o) {
        const line = Object.entries(o)
          .map(([k, v]) => `${k} ${v.count}` + (v.usd ? ` ($${num(v.usd, 0)})` : '')).join(' · ');
        s.rows.push(['Orders', String(Object.values(o).reduce((a, v) => a + v.count, 0)), line]);
      } else s.notes.push('orders unreadable: ' + d.ordersError);
      s.rows.push(['Sold', num(l.soldPcn, 0) + ' PCN', num(l.pctSold) + '% of the book']);

      // MACHINE-READABLE, for the dashboard's "Needs you" panel.
      //
      // The rows above are formatted strings for humans. The dashboard must not
      // parse them back into numbers -- a thousands separator or a renamed label
      // would silently turn a real problem into no problem at all, which is the
      // one failure mode a "what needs doing" list may never have. So the raw
      // values are carried alongside, and nothing is inferred twice.
      s.facts = {
        remainingPcn: l.remainingPcn ?? null,
        deliverablePcn: l.deliverablePcn ?? null,
        sellableNowPcn: l.sellableNowPcn ?? null,
        hotWalletPcn: f ? f.hotWalletPcn : null,
        gateOpen: gate.ok ? !!gate.data.open : null,
        divergencePct: gate.ok ? gate.data.divergencePct : null,
        maxDivergencePct: d.settings?.maxDivergencePct ?? null,
        // true = the backing figure is a number somebody typed, not one measured
        // from the chain. It cannot fall on its own if the coins are spent.
        backingManual: b ? !!b.manual : null,
        backingDegraded: b ? !!b.degraded : null,
        headroomPcn: b ? b.headroomPcn : null,
        orders: o || null,
      };
    } else {
      s.status = 'unreadable';
      s.notes.push('could not read /api/ops/summary: ' + mkt.error);
    }
    out.push(s);
  }

  // ── wpcnpay ──────────────────────────────────────────────────────────────
  {
    const s = { slug: 'wpcnpay', name: 'wpcnpay.pc.am', host: '178.105.3.51', rows: [], notes: [] };
    s.status = health.ok && health.data.ok ? 'ok' : 'bad';
    s.rows.push(['Verifier', health.ok && health.data.ok ? 'up' : 'DOWN',
      'shared by every rail — while it is down, no rail can take wPCN']);
    if (stats.ok) {
      const d = stats.data;
      s.rows.push(['Claims banked', String(d.claims), d.claims_today + ' today']);
      s.rows.push(['Credited', '$' + num(d.usd_credited_total), num(d.wpcn_total, 2) + ' wPCN']);
      s.rows.push(['Projects', String(d.projects_configured) + ' configured',
        Object.entries(d.by_project).map(([k, v]) => `${k} ${v.claims}`).join(' · ')]);
      if (d.unreadable_records) s.notes.push(d.unreadable_records + ' ledger records unreadable');
      if (d.newest_claim_at) s.rows.push(['Newest claim', d.newest_claim_at.replace('T', ' ').slice(0, 19), '']);
    } else {
      s.notes.push('could not read /stats: ' + stats.error);
    }
    out.push(s);
  }

  // ── pcnearner ────────────────────────────────────────────────────────────
  {
    const s = { slug: 'pcnearner', name: 'pcnearner.pc.am', host: '178.105.178.27', rows: [], notes: [] };
    if (earner.ok) {
      const d = earner.data, t = d.totals || {}, q = d.queue || {};
      s.status = 'ok';
      const online = (d.earners || []).filter(e => e.online).length;
      s.rows.push(['Earners', String((d.earners || []).length),
        online + ' online · ' + (d.devices || []).length + ' devices']);
      s.rows.push(['Queue', String(q.queued ?? q.pending ?? Object.values(q)[0] ?? '?'),
        (d.runnable_now || []).length + ' task types runnable']);
      s.rows.push(['Tasks done', String(t.done ?? '?'),
        (t.failed ?? 0) + ' failed · ' + (t.cancelled ?? 0) + ' cancelled']);
      s.rows.push(['Paid out', t.usd !== undefined ? '$' + num(t.usd) : '?',
        t.pcn !== undefined ? num(t.pcn, 2) + ' PCN' : '']);
      s.rows.push(['GPU time', t.gpu_seconds ? num(t.gpu_seconds / 3600, 1) + ' h' : '?', 'lifetime']);
    } else {
      s.status = 'unreadable';
      s.notes.push('could not read /v1/admin/overview: ' + earner.error);
    }
    out.push(s);
  }

  // ── explorer ops ─────────────────────────────────────────────────────────
  {
    const s = { slug: 'explorer', name: 'explorer.pc.am/admin', host: '178.105.3.51', rows: [], notes: [] };
    if (ops.ok) {
      const d = ops.data, ch = d.chain || {};
      s.status = 'ok';
      s.rows.push(['Chain height', String(or(ch.height, '?')),
        ch.blocksBehind !== undefined ? ch.blocksBehind + ' behind' : '']);
      if (ch.tipAge !== undefined) s.rows.push(['Tip age', num(ch.tipAge / 60, 1) + ' min', '']);
      // PCoin's difficulty is a small fraction (0.0586 today), so rounding it to
      // whole numbers printed a flat "0" -- a figure that looked like a dead chain.
      if (ch.difficulty !== undefined) s.rows.push(['Difficulty', num(ch.difficulty, 4), '']);
      if (ch.hashrate !== undefined && ch.hashrate !== null) {
        const h = Number(ch.hashrate);
        s.rows.push(['Network hashrate',
          h >= 1e6 ? num(h / 1e6, 2) + ' MH/s' : h >= 1e3 ? num(h / 1e3, 1) + ' kH/s' : num(h, 0) + ' H/s',
          'derived from recent spacing']);
      }
      if (ch.node_connections !== undefined) s.rows.push(['Peers', String(ch.node_connections), '']);
      // fleet === null now means UNREADABLE rather than empty -- that distinction
      // was added to pcoin-ops today precisely so this line cannot lie.
        // ── WHO IS ACTUALLY MINING ────────────────────────────────────────
        // Asked of the pool, which is the only component that knows. Every value
        // here is a live reading; an unreadable pool prints "unreadable" and
        // never a zero, because "no miners" and "I could not ask" must not look
        // the same (rule 1 at the top of this file).
        const ps = poolApi.ok ? (poolApi.data?.pool?.poolStats || {}) : null;
        const ns = poolApi.ok ? (poolApi.data?.pool?.networkStats || {}) : null;
        const hr = h => (typeof h === 'number' && isFinite(h))
          ? (h >= 1e6 ? num(h / 1e6, 2) + ' MH/s'
             : h >= 1e3 ? num(h / 1e3, 1) + ' kH/s'
             : num(h, 0) + ' H/s')
          : 'unreadable';

        if (ps) {
          s.rows.push(['Miners on our pool', String(or(ps.connectedMiners, 'unreadable')),
                       'machines connected and submitting shares right now']);
          s.rows.push(['Our pool hashrate', hr(ps.poolHashrate),
                       'the combined speed of those machines']);
          if (ps.sharesPerSecond !== undefined)
            s.rows.push(['Shares per second', num(ps.sharesPerSecond, 1),
                         'work arriving from them; a drop to 0 means nobody is mining']);
        } else {
          s.notes.push('pool unreadable, so the miner count is unknown: '
                       + (poolApi.error || 'unknown'));
        }

        if (ps && ns && Number(ns.networkHashrate) > 0) {
          const share = Number(ps.poolHashrate) / Number(ns.networkHashrate) * 100;
          s.rows.push(['Everyone else', hr(Number(ns.networkHashrate) - Number(ps.poolHashrate)),
                       'hashrate mining PCoin that is NOT on our pool']);
          // The one number on this page with a safety meaning. Above 50% a single
          // party could reorganise the chain, which is why it is spelled out here
          // rather than left to be worked out from the two rows above it.
          s.rows.push(['Our pool is this much of the network', num(share, 1) + '%',
                       share >= 50 ? 'ABOVE 50% -- concentration risk, see the alert'
                                   : 'below 50%, which is where it should stay']);
        }

        if (d.fleet === null) s.notes.push('fleet balances unreadable: ' + (d.fleetError || 'unknown'));
        else s.rows.push(['Addresses we watch', String(d.fleet.length),
                          'NOT a miner count -- our machines, the six payment rails and '
                          + 'two addresses that are not ours. See the Miners page for the breakdown']);
    } else {
      s.status = 'unreadable';
      s.notes.push('could not read /admin/api: ' + ops.error);
    }
    out.push(s);
  }

  return out;
}

// The detail pages fetch through the SAME cache and the SAME credential file, so a
// service page and the index can never disagree about what an upstream said, and
// the tokens still exist in exactly one place.
export { get as upstreamGet, creds as upstreamCreds };
