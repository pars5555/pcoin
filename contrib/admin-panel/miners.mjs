// /miners - what the owner's own machines have actually earned.
//
// The old explorer dashboard had this and the unified panel did not, so the
// question "how are my miners doing" had no answer here at all.
//
// WHERE THE LIST COMES FROM. /opt/pcoin-ops/config.json, the old dashboard's
// own fleet map, which is the only place the labels live. THAT FILE ALSO HOLDS
// SECRETS -- a password hash, a TOTP secret, a session secret and two API
// tokens. Only the `fleet` key is ever read here, by name, and nothing else in
// the object is touched or rendered. Reading a config by picking named keys
// rather than by pattern is the rule this project has paid for five times.
//
// BALANCES ARE READ LIVE from the explorer index, cached briefly. A page render
// must not make fifteen HTTP calls every time somebody clicks, and a stale
// number is fine here as long as the page SAYS how stale -- which it does.
//
// OVER LOOPBACK FIRST. This panel runs on the box that IS the explorer, so
// reaching it by its public name would send every one of those calls out
// through DNS, Cloudflare, the rate limiter and TLS and back to 127.0.0.1.
// All four can fail while the index is perfectly healthy, and on 2026-09-18
// three of them did -- the explorer spent part of that day refusing 44% of all
// traffic with 429s, our own rails included. The public name stays as a
// fallback; PCOIN_EXPLORER overrides both.
//
// The payment rails in that same map are deliberately NOT shown. They are not
// miners, they are somebody's deposit address, and four of them belong to
// individual customers rather than to us. They have their own page.
import { readFileSync } from 'node:fs';
import { esc, DASH, N, tbl, card, note, tiles, agoIso } from './ui.mjs';

const OPS_CONFIG = '/opt/pcoin-ops/config.json';
const CACHE_MS = 90e3;
let cache = { at: 0, rows: null, error: null, pool: null };

// How a label is classified. The labels are prose written by hand over months,
// so this reads them rather than pretending there is a schema.
// Addresses that are NOT the project's, confirmed by the owner 2026-09-13.
// Both belong to his son: the varujdesk earner payout, and the office01+02
// machines, which mine straight to his wallet rather than forwarding to the
// treasury. 2,800 PCN between them, none of it ours to move.
const NOT_OURS = new Set([
  'pc1qsl67w7cs8gsvd9jekdrnjxj873du7x5n6nj82l',   // varujdesk earner payout
  'pc1qdxevq6dz82hyrxfqgc30n0t9txntmax5zffp3m',   // office01 + office02
]);

function classify(label, a) {
  const l = (label || '').toLowerCase();
  // ORDER MATTERS, and getting it wrong is not cosmetic. The legacy labels read
  // "legacy DESKTOP-5SH2116 (now pays treasury)" -- they CONTAIN the word
  // treasury while not being the treasury. Testing for treasury first filed
  // four retired desktops as the treasury address, which would have had the
  // reader believe the project's main balance was spread across four machines
  // that stopped mining months ago. Most specific test first.
  // NOT OURS, and checked before anything else. Its label says the miner was
  // uninstalled, so every other rule here would file it under "retired" -- a
  // quiet row among four phones with dust on them. It holds 2,500 PCN, it is
  // the largest unswept balance in the estate, and the coins belong to the
  // owner's son. Burying it is how somebody eventually sweeps it.
  if (NOT_OURS.has(a)) return 'notours';
  if (l.startsWith('payment -')) return 'rail';
  if (l.startsWith('legacy')) return 'legacy';
  if (l.includes('retired') || l.includes('uninstalled') || l.includes('removed')) return 'retired';
  if (l.startsWith('treasury') || l.includes('- treasury')) return 'treasury';
  if (l.includes('treasury')) return 'treasury';
  return 'mining';
}

export function fleet() {
  // ONLY the fleet key. The rest of that file is credentials.
  const raw = JSON.parse(readFileSync(OPS_CONFIG, 'utf8'));
  const f = raw.fleet;
  if (!f || typeof f !== 'object') throw new Error('no fleet map in the ops config');
  return Object.entries(f).map(([address, v]) => {
    const label = typeof v === 'string' ? v : (v && (v.label || v.name)) || '';
    return { address, label, kind: classify(label, address) };
  });
}

const EXPLORERS = [process.env.PCOIN_EXPLORER, 'http://127.0.0.1:8080',
                   'https://explorer.pc.am'].filter(Boolean);

async function addressInfo(a) {
  // Try each base in order and take the first that answers. A base that fails
  // is not an answer of zero -- if every one of them fails we throw, and the
  // caller renders the error instead of a balance, because a zero balance and
  // an unreachable explorer look identical in a number and could not differ
  // more in meaning.
  let d = null, last = null;
  for (const base of EXPLORERS) {
    try {
      const r = await fetch(`${base}/api/address/${a}`,
        { signal: AbortSignal.timeout(15000) });
      if (!r.ok) { last = new Error('HTTP ' + r.status); continue; }
      d = await r.json();
      break;
    } catch (e) {
      last = e;
    }
  }
  if (d === null) throw last || new Error('no explorer answered');
  const c = (d.balance || {}).confirmed || {};
  const lt = (d.balance || {}).lifetime || {};
  return {
    mature: Number(c.mature_pcn), immature: Number(c.immature_pcn),
    received: Number(lt.received_pcn), sent: Number(lt.sent_pcn),
    lastHeight: lt.last_height, txs: lt.tx_count,
  };
}

export async function minersData() {
  if (cache.rows && Date.now() - cache.at < CACHE_MS) return cache;
  let rows = [], error = null, pool = null;
  try {
    const list = fleet().filter(x => x.kind !== 'rail');
    // Sequential on purpose, and still so over loopback. The original reason
    // was rate limiting -- fifteen parallel requests at a public explorer from
    // one IP is the shape of something that gets blocked. Going direct removes
    // that, but replaces it with a better one: the explorer serves from a
    // BOUNDED pool of 16 SQLite connections, so fifteen at once from one admin
    // page render would occupy nearly the whole pool and make every other
    // caller queue behind a page nobody is waiting on. This page is not urgent
    // enough to be rude in either direction.
    for (const m of list) {
      try { rows.push({ ...m, ...(await addressInfo(m.address)) }); }
      catch (e) { rows.push({ ...m, error: e.message }); }
    }
  } catch (e) {
    // An unreadable fleet is an ERROR, never an empty fleet. "You have no
    // miners" and "I could not read the list" must not render the same.
    error = e.message;
  }
  try {
    const r = await fetch('https://pool.pc.am/api/pools', { signal: AbortSignal.timeout(12000) });
    const d = await r.json();
    const p = (d.pools || [])[0];
    if (p) pool = { miners: p.poolStats?.connectedMiners, hashrate: p.poolStats?.poolHashrate };
  } catch { /* the pool is a nice-to-have here, not the point of the page */ }

  cache = { at: Date.now(), rows, error, pool };
  return cache;
}

const PCN = v => (typeof v === 'number' && isFinite(v))
  ? N(v, 2) + ' <span class="muted">PCN</span>' : DASH;

export function minersPage(data) {
  if (data.error) {
    return '<h1>Miners</h1>' + card('Could not read the fleet',
      `<p class="bad">${esc(data.error)}</p>`
      + note('Shown as an error rather than as an empty list. "You have no miners" and '
           + '"I could not read the list" are different facts.'));
  }
  const rows = data.rows || [];
  const of = k => rows.filter(r => r.kind === k);
  const sum = (rs, f) => rs.reduce((a, r) => a + (isFinite(r[f]) ? r[f] : 0), 0);

  const active = of('mining');
  const mature = sum(rows, 'mature'), immature = sum(rows, 'immature');

  const head = tiles([
    ['Mature, all addresses', PCN(mature), 'green'],
    ['Immature (still maturing)', PCN(immature), 'yellow'],
    ['Addresses tracked', esc(String(rows.length))],
    ['Pool miners (whole network)', data.pool?.miners != null ? esc(String(data.pool.miners)) : DASH],
    ['Pool hashrate', data.pool?.hashrate != null
      ? N(Number(data.pool.hashrate) / 1000, 1) + ' <span class="muted">kH/s</span>' : DASH],
  ]);

  const row = r => [
    `<b>${esc(r.label || '(no label)')}</b>`,
    `<code title="${esc(r.address)}">${esc(r.address.slice(0, 14))}…${esc(r.address.slice(-6))}</code>`,
    r.error ? `<span class="bad">${esc(r.error)}</span>` : PCN(r.mature),
    r.error ? DASH : (r.immature > 0 ? `<span style="color:var(--yellow)">${PCN(r.immature)}</span>` : PCN(r.immature)),
    // NET, not gross. This column said "Earned, lifetime" and showed
    // `received`, which counts every receipt INCLUDING change returning from
    // the address's own spends. The treasury showed 588,930 PCN against a total
    // supply of 390,500 -- more coins than exist -- and the owner reasonably
    // read it as "half a million mined". Net is what the address actually kept.
    r.error ? DASH : PCN((r.received || 0) - (r.sent || 0)),
    r.error ? DASH : `<span class="muted">${N(r.received, 0)} in / ${N(r.sent, 0)} out</span>`,
    r.error ? DASH : (r.lastHeight != null ? esc(String(r.lastHeight)) : DASH),
  ];
  const heads = ['What it is', 'Address', 'Mature', 'Immature', 'Net, lifetime', 'Gross flow', 'Last block'];

  const section = (title, kind, blurb) => {
    const rs = of(kind);
    return rs.length ? card(title, tbl(heads, rs.map(row)) + (blurb ? note(blurb) : '')) : '';
  };

  return '<h1>Miners</h1>'
    + '<p class="muted">Your own machines and what they have earned. Balances are read from '
    + 'the explorer index and cached for 90 seconds &mdash; last read '
    + (data.at ? agoIso(new Date(data.at).toISOString()) : DASH) + '.</p>'
    + head
    + section('Mining now', 'mining',
        'A low balance here is usually correct, not a fault: most setups forward what they '
        + 'earn to the treasury, so a working miner often shows almost nothing locally. Read '
        + 'the lifetime column instead.')
    + section('Treasury', 'treasury',
        'Where the forwarding miners send what they earn.')
    + section('Legacy addresses', 'legacy',
        'Machines that used to pay these addresses directly and now pay the treasury. Kept '
        + 'because coins mined before the change still live here.')
    + section('Retired', 'retired',
        'Miners uninstalled on the owner’s instruction. Listed so a balance sitting on a '
        + 'retired device is never forgotten.')
    + (of('notours').length ? card('NOT OURS — do not sweep this',
        tbl(heads, of('notours').map(row))) : '')
    + card('Why that address is listed separately',
        note('<code>pc1qsl67w7cs8gsvd9jekdrnjxj873du7x5n6nj82l</code> is labelled as an earner '
           + 'payout and holds the largest unswept balance in the estate. <b>The coins belong '
           + 'to the owner’s son.</b> It looks exactly like a forwarding failure and is not '
           + 'one &mdash; every other address forwards ~99.99% of lifetime receipts and keeps '
           + 'dust. Never sweep it.'))
    + card('Why "gross flow" is so much larger than anything mined',
        note('Gross received counts EVERY receipt, including change coming back from the '
           + 'address’s own spends. The treasury shows 588,930 PCN received against a '
           + 'total supply of 390,500 — more coins than exist — because the same '
           + 'coins pass through it repeatedly: forwarded in, spent out, change returns, '
           + 'counted again. Over 3,110 transactions that adds up fast. The NET column is '
           + 'what the address actually kept, and the supply figure to compare against is '
           + 'total_supply from the explorer, currently 390,500 PCN.'))
    + card('Where this comes from',
        note('The address labels come from the old ops dashboard’s fleet map, which is still '
           + 'the only place they are written down. That file also holds a password hash, a '
           + 'TOTP secret and two API tokens &mdash; only the fleet key is read, by name, and '
           + 'nothing else in it is touched. Payment rails in the same map are deliberately '
           + 'excluded: they are not miners, and four of them are individual customers’ '
           + 'deposit addresses.'));
}
