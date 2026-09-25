// ═══════════════════════════════════════════════════════════════════════════
// /pcn-index — the exchange-anchored PCN index, IN SHADOW (price plan Phase 2)
// ═══════════════════════════════════════════════════════════════════════════
//
// The price plan (D:\pc.am\PCOIN-PRICE-EXCHANGE-ANCHOR-PLAN.md) replaces the
// pool-follow with one PCN price: the volume-weighted median of qualifying
// user-to-user fills on exchange.pc.am. For at least seven days it runs in
// SHADOW -- computed on the exchange, relayed by price.pc.am, used by nothing --
// and the switch is judged on what this page shows. One exit criterion is that
// every move is explained by fills, which is why the counted fills sit right
// under the number.
//
// Read-only. It uses the exchange's READ token through exchangeCall (the one
// pinned transport, never a second copy) and price.pc.am's public feed. The
// two writes that exist for the index -- re-seed and per-account exclusion --
// need the exchange's own authenticator code and are not offered here.
import { esc, N, USD, PCT, DASH, card, note, kv, tbl, tiles, failed } from './ui.mjs';
import { exchangeCall } from './exchange.mjs';

const when = (t) => (t ? esc(new Date(Number(t) * 1000).toISOString().replace('T', ' ').slice(0, 16)) + ' UTC' : DASH);
const age = (s) => (s === null || s === undefined ? DASH : s < 120 ? `${s} s` : s < 7200 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);
const n = (x) => (x === null || x === undefined || x === '' ? null : Number(x));
const STATE_WORDS = {
  held: 'HELD: not enough new evidence to move',
  live: 'LIVE: moved, or free to move, on recent fills',
  frozen: 'FROZEN by the owner',
  unknown: 'UNKNOWN: its own state could not be trusted; it never re-seeds itself',
  disabled: 'switched off on the exchange',
};

export async function pcnIndexData({ creds }) {
  const ex = creds && creds.exchange ? creds.exchange : null;
  const [admin, price] = await Promise.all([
    ex ? exchangeCall(ex, 'owner', 'GET', '/admin/api/index')
       : Promise.resolve({ readable: false, reason: 'no exchange entry in upstream.json' }),
    fetch('https://price.pc.am/', { signal: AbortSignal.timeout(12000) })
      .then(async (r) => (r.ok ? { ok: true, data: await r.json() } : { ok: false, error: 'HTTP ' + r.status }))
      .catch((e) => ({ ok: false, error: e.message })),
  ]);
  return { admin, price };
}

export function pcnIndexPage(d) {
  const a = d.admin && d.admin.readable && d.admin.status === 200 ? d.admin.json : null;
  const p = d.price && d.price.ok ? d.price.data : null;
  if (!a && !p) {
    return failed('the exchange index and price.pc.am', (d.admin && d.admin.reason) || (d.price && d.price.error) || 'both unreadable')
      + note('Nothing is shown rather than a page of dashes that looks like "no activity".');
  }
  const rel = p && p.index ? p.index : null;
  const idx = a ? n(a.usd) : rel ? rel.usd : null;
  const credit = p ? n(p.creditRateUsd) : null;
  const sell = p ? n(p.sellPriceUsd) : null;
  const gap = idx > 0 && credit > 0 ? (idx / credit - 1) * 100 : null;
  const state = a ? a.state : rel ? rel.state : null;

  // In use once price.pc.am says so (useIndex = 1, plan Step 4, 2026-09-25).
  // Read from the relay, never assumed: a rollback puts `inUse` back to false
  // and this page goes back to calling it a shadow.
  const inUse = !!(rel && rel.inUse);
  const top = tiles([
    [inUse ? 'PCN index' : 'PCN index (shadow)', USD(idx, 6)],
    ['Rails credit at now', USD(credit, 6)],
    ['Index vs credit rate', gap === null ? DASH : (gap >= 0 ? '+' : '') + PCT(gap, 2)],
    ['Market sells at', USD(sell, 6)],
  ]);

  const botSrc = esc(a && a.settings ? a.settings.bot_price_source : 'oracle');
  const banner = card('What this is', note(inUse
    ? '<b>This is the PCN price.</b> price.pc.am publishes it with <code>inUse: true</code>, so '
      + '<code>creditRateUsd</code> is the index and the rails credit at it; market.pc.am sells at it plus its '
      + 'premium; the keeper holds the pool to it when <code>anchor_index</code> is on; the exchange bots quote '
      + 'from <code>bot_price_source = ' + botSrc + '</code>. If it goes <i>unknown</i> or stale, '
      + '<code>/credit-rate</code> answers 503 and the rails hold. Every move should still be explained by the '
      + 'fills below.'
    : '<b>Shadow only. Nothing uses this number yet.</b> The bots quote from price.pc.am (<code>bot_price_source = '
      + botSrc + '</code>), the rails credit at '
      + '<code>creditRateUsd</code>, and price.pc.am publishes the index with <code>inUse: false</code>. '
      + 'The switch is judged on at least 7 days of this page: at least 15 new qualifying fills, zero '
      + '<i>unknown</i> states, every move explained by the fills below, and the owner\'s yes.'));

  let where = '';
  if (a) {
    const w = a.window || {};
    const r = a.rules || {};
    const raw = a.raw || {};
    where = card('Where it stands', kv([
      ['State', `<b>${esc(STATE_WORDS[a.state] || a.state)}</b>`, (a.reasons || []).map(esc).join('<br>')],
      ['Index', USD(n(a.usd), 9), `seq ${esc(a.seq ?? '—')} · computed ${age(a.ageSeconds)} ago · last move ${a.lastMoveAt ? when(a.lastMoveAt) : 'never'}`],
      ['Evidence window', w.hours ? `${esc(w.hours)} h` : DASH,
        `${esc(w.trades ?? '—')} counted fills (need ${esc(r.minTrades ?? '—')}), ${esc(w.entities ?? '—')} separate people (need ${esc(r.minEntities ?? '—')}), `
        + `$${esc(w.countedUsd ?? '—')} counted (need $${esc(r.minNotionalUsd ?? '—')}) — ${w.qualifies ? '<b class="good">enough evidence</b>' : '<b>not enough yet</b>'}`],
      ['What the fills say', raw.medianUsd ? USD(n(raw.medianUsd), 6) : DASH,
        raw.targetUsd ? `target after the ±${esc(r.bandPct)}% clip: $${esc(raw.targetUsd)}${raw.clipped ? ' (clipped)' : ''}` : 'no median until the window has enough evidence'],
      ['Held back by', (a.limitedBy || []).length ? esc(a.limitedBy.join(', ')) : 'nothing', 'a per-fill or per-day cap, the floor or the ceiling'],
      ['Seeded', a.saved && a.saved.seededAt ? when(a.saved.seededAt) : DASH,
        a.saved ? `from index_seed_nano (seq ${esc(a.saved.seedSeq ?? '—')}); fills after trade #${esc(a.saved.lastTradeId ?? '—')} count as new` : ''],
      ['Accounts excluded by hand', N(a.excludedAccounts, 0), 'set per account in the exchange admin, with the authenticator code'],
    ]));
  } else {
    where = failed('the exchange admin index', (d.admin && (d.admin.reason || (d.admin.json && d.admin.json.error))) || 'unreadable');
  }

  const relay = card('What price.pc.am relays', rel ? kv([
    ['Relayed index', USD(rel.usd, 9), `seq ${esc(rel.seq ?? '—')} · ${esc(rel.state)}`],
    ['Agrees with the exchange', a ? (a.seq === rel.seq && Math.abs((n(a.usd) || 0) - (rel.usd || 0)) < 1e-9
      ? '<span class="good">yes</span>' : '<b class="bad">NO</b>') : DASH,
      'price.pc.am believes a value only after two polls agree, and runs its own 2.5%-a-step / 5.5%-a-day check.'],
    ['Age', age(rel.ageSeconds), rel.stale ? '<b class="bad">stale</b>' : 'fresh'],
    ['Refused reading', rel.refused ? `<b class="bad">${esc(rel.refused.why)}</b>` : 'none',
      rel.refused ? 'If this was a deliberate re-seed, accept it with POST /admin/index/accept on the price primary.' : ''],
    ['Used for', rel.inUse ? '<b>IN USE</b>: the credit rate' : 'nothing (shadow)', ''],
  ]) : note(p ? 'price.pc.am is not publishing an index block.' : 'price.pc.am could not be read: ' + esc(d.price && d.price.error)));

  let fills = '', people = '', hist = '', rules = '';
  if (a) {
    const det = a.detail || {};
    fills = card('The fills it counted', tbl(
      ['Trade', 'When', 'Price', 'PCN', 'Counted', 'Buyer', 'Seller', 'New?', 'Capped by'],
      (det.counted || []).map((c) => [
        '#' + esc(c.tradeId), when(c.at), '$' + esc(c.priceUsd), esc(c.pcn), esc(c.countedPcn),
        `<code>${esc(c.buyer)}</code>`, `<code>${esc(c.seller)}</code>`, c.new ? '<b>new</b>' : '', esc(c.cappedBy || ''),
      ]), 'No user-to-user fill qualifies in the window yet.')
      + note('Buyers and sellers are hashed person ids: the same person across several accounts (shared IP, same device) is one id. '
        + 'House bots, our own accounts, accounts under 3 days old or with under $10 of real deposits never count. '
        + (det.excluded && typeof det.excluded === 'object' && !Array.isArray(det.excluded)
          ? 'Fills left out, by reason: ' + Object.entries(det.excluded).map(([k, v]) => `${esc(k)} ${esc(typeof v === 'object' ? JSON.stringify(v) : v)}`).join(', ') + '. '
          : '')
        + (Array.isArray(det.excludedFills) && det.excludedFills.length
          ? 'User fills left out (house fills not listed): ' + det.excludedFills
            .map((f) => `#${esc(f.tradeId)} <i>${esc(f.reason)}</i>`).join(', ') + '.'
          : '')));
    people = (det.entities || []).length ? card('People behind those fills', tbl(
      ['Person (hashed)', 'Accounts', 'Fills', 'PCN counted'],
      det.entities.map((e) => [`<code>${esc(e.id)}</code>`, esc(e.accounts ?? '—'), esc(e.fills), esc(e.countedPcn)]))) : '';
    hist = card('Every move (newest first)', tbl(
      ['Seq', 'When', 'Index', 'Fills said', 'Window', 'Fills / people', 'State', 'Limited by', 'Why'],
      (a.history || []).map((h) => [
        esc(h.seq), when(h.at), '$' + esc(h.usd), h.rawUsd ? '$' + esc(h.rawUsd) : DASH,
        h.windowHours ? esc(h.windowHours) + ' h' : DASH,
        h.trades === null ? DASH : `${esc(h.trades)} / ${esc(h.entities)}`,
        esc(h.state), esc((h.limitedBy || []).join(', ')), esc(h.reason || ''),
      ]), 'No history.'));
    const r = a.rules || {};
    rules = card('The rules (as the exchange runs them)', kv([
      ['Per new fill', `at most ${esc(r.perTradePct)}%`, 'either direction'],
      ['Per 24 hours', `at most ${esc(r.perDayPct)}%`, 'either direction, rolling'],
      ['Band', `±${esc(r.bandPct)}%`, 'each fill\'s price is clipped to this band around the index before the median'],
      ['Evidence', `${esc(r.minTrades)} fills, ${esc(r.minEntities)} people, $${esc(r.minNotionalUsd)}`, `widening window: ${esc((r.windowsHours || []).join(' / '))} h`],
      ['Floor / ceiling', `$${esc(r.floorUsd)} / $${esc(r.ceilingUsd)}`, 'applied even while held'],
      ['Switch', a.settings ? `index_enabled = ${esc(a.settings.index_enabled)}, frozen = ${esc(a.settings.index_frozen)}` : DASH, ''],
    ]));
  }

  return top + banner + where + relay + fills + people + hist + rules
    + note('Read live at page load from the exchange admin API (read token) and https://price.pc.am/.');
}
