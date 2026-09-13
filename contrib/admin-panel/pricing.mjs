// ═══════════════════════════════════════════════════════════════════════════
// HOW THE PCN PRICE IS CALCULATED — one page, with the live numbers in it.
// ═══════════════════════════════════════════════════════════════════════════
//
// WHY THIS PAGE EXISTS.
//
// On 2026-09-13 the owner asked, repeatedly and with good reason, why buying
// PCN no longer moves the price when it used to. Answering it took an hour and
// produced several WRONG answers on the way -- including "spending at a service
// never affected the price", which is false: retire-on-spend is shipped and
// running. The chain that sets the price runs through four components on three
// hosts, each individually documented, and the JOIN was written down nowhere.
//
//   PancakeSwap pool -> cap-policy.mjs -> the ladder -> price.pc.am -> the rails
//
// THE ONE SENTENCE: both mechanisms that let usage move the price ARE BUILT AND
// RUNNING. They are pinned, not missing. Every rung is charged at
// min(rungPrice, askCap), and while the cap sits below the ladder's own next
// rung, neither buying nor spending can move the number.
//
// The two figures that prove it are on this page side by side:
// `rungMarginalPrice` (what the ladder wants) and `askCapUsd` (what it may
// charge). While the first exceeds the second, the price is flat at any size.
//
// Everything is read live. Nothing is hardcoded but the explanations.
import { esc, num, N, USD, PCT, card, note, kv, tbl, tiles, failed, DASH } from './ui.mjs';

const TTL_MS = 60_000;
const cache = new Map();

async function get(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.val;
  let val;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    val = { ok: true, data: await r.json() };
  } catch (e) {
    val = { ok: false, error: e.message };
  }
  cache.set(url, { at: Date.now(), val });
  return val;
}

export async function pricingData() {
  const [price, state, gate] = await Promise.all([
    get('https://price.pc.am/'),
    get('https://market.pc.am/api/ladder/state'),
    get('https://market.pc.am/api/ladder/gate'),
  ]);
  return { price, state, gate };
}

export function pricingPage(d) {
  const p = d.price.ok ? d.price.data : null;
  const s = d.state.ok ? d.state.data : null;
  const g = d.gate.ok ? d.gate.data : null;

  if (!p && !s) {
    return failed('the price oracle and the market', 'both unreadable')
      + note('Every figure on this page is read live from price.pc.am and '
             + 'market.pc.am. A page of zeros would be a lie rather than a gap, so '
             + 'nothing is shown.');
  }

  const pool    = p ? Number(p.pool?.spotUsd) : null;
  const median  = p ? Number(p.pool?.medianUsd) : null;
  const ask     = s ? Number(s.marginalPrice) : (p ? Number(p.sellPriceUsd) : null);
  const cap     = s ? Number(s.askCapUsd) : null;
  const wants   = s ? Number(s.rungMarginalPrice) : null;   // the UNCAPPED rung price
  const credit  = p ? Number(p.creditRateUsd) : null;
  const premium = (pool > 0 && ask > 0) ? (ask / pool - 1) * 100 : null;
  const pinned  = (wants > 0 && cap > 0) ? wants > cap * 1.0001 : null;
  const gapPct  = (wants > 0 && cap > 0) ? (wants / cap - 1) * 100 : null;

  const top = tiles([
    ['PCN — you pay',         USD(ask, 8)],
    ['wPCN — PancakeSwap',    USD(pool, 8)],
    ['PCN — rails credit at', USD(credit, 8)],
    ['PCN premium over wPCN', premium === null ? DASH : PCT(premium, 2)],
  ]);

  // ── THE ANSWER TO "why is the price the same for $20 and $200" ────────────
  const pin = card(
    pinned ? 'Why the price is the same at every order size' : 'The ladder is pricing normally',
    kv([
      ['What the ladder WANTS for the next coin', USD(wants, 8),
       'rungMarginalPrice — the real price of the cheapest rung that still has stock.'],
      ['What it is ALLOWED to charge', USD(cap, 8),
       'askCapUsd — set by cap-policy.mjs to the 24-hour pool median x 1.05.'],
      ['The gap', gapPct === null ? DASH : PCT(gapPct, 1),
       pinned
         ? 'The ladder wants more than the cap allows, so <b>every rung is charged at '
           + 'the cap</b> — min(rungPrice, askCap). That is why $20 and $200 cost the '
           + 'same per coin. It is the cap working, not a broken calculator.'
         : 'The cap is above the next rung, so rungs charge their own prices and '
           + 'bigger orders pay more.'],
      ['It un-pins when', pool > 0 && wants > 0 ? USD(wants / 1.05, 8) : DASH,
       'the 24-hour pool MEDIAN reaches this, so that median x 1.05 clears the rung. '
       + 'Nothing needs rebuilding — it resumes by itself.'],
    ]))
    + note(pinned
      ? '<b>Both usage mechanisms are built, correct and running.</b> They are pinned '
        + 'by this one number, not missing.'
      : '');

  // ── the chain in order ────────────────────────────────────────────────────
  const chain = card('The chain that sets the price, in order', kv([
    ['1. wPCN pool (PancakeSwap)', USD(pool, 8),
     'The only market with outside participants. Everything below derives from it.'],
    ['2. 24-hour pool MEDIAN', USD(median, 8),
     'cap-policy uses the median, never the spot. One trade is a single sample '
     + 'against ~1,440, so nobody drags the price with one cheap trade — it takes a '
     + 'sustained, visible campaign of more than 12 hours. This is also why buying '
     + 'wPCN raises the posted price SLOWLY.'],
    ['3. the ask cap', USD(cap, 8),
     'median x 1.05. PCN sits 5% ABOVE wPCN deliberately: below it, people buy PCN '
     + 'cheap from us, wrap it, and dump it into the pool.'],
    ['4. what the ladder charges', USD(ask, 8),
     'min(rungPrice, askCap), per rung.'],
    ['5. posted PCN price', USD(ask, 8), 'price.pc.am publishes the ladder marginal price.'],
    ['6. serviceRate — the rails credit at', USD(credit, 8),
     'min(ladder, pool). The pool may only ever LOWER this, never raise it — a pool '
     + 'trading ABOVE the ladder changes nothing at all.'],
  ]));

  // ── the four cases ────────────────────────────────────────────────────────
  const live = x => `<span class="ok">${x}</span>`;
  const pinnedTag = '<span class="bad">built &amp; running, but PINNED by the cap</span>';
  const cases = card('The four things a user can do, and whether each moves the price', tbl(
    ['User action', 'Mechanism', 'Status now'],
    [
      ['Buys PCN from market.pc.am',
       'consumes rungs, so the marginal price rises',
       pinned ? pinnedTag : live('moves the price')],
      ['Spends PCN at one of the six services',
       '<b>retire-on-spend</b> — retireRatioPct of every PCN spent is withdrawn from '
       + 'the ladder, so less inventory means a higher price. Runs as an in-process '
       + '10-minute scan inside the market server, which is why it appears in no '
       + 'systemctl, no crontab and no docker inspect.',
       pinned ? pinnedTag : live('moves the price')],
      ['Buys wPCN on PancakeSwap',
       'raises the pool, so the cap and the rate follow',
       live('moves it UP — slowly, via the 24h median')],
      ['Sells wPCN on PancakeSwap',
       'lowers the pool; serviceRate = min(ladder, pool) follows it down',
       live('moves it DOWN — immediately')],
    ])
    + note('<b>The asymmetry is deliberate.</b> Falling is automatic because pushing '
           + 'the pool down costs an attacker money and only reduces what we credit — '
           + 'there is no attack in that direction, so none is guarded. Rising is slow '
           + 'because linking the ASK to the pool is what would make a dump '
           + 'profitable; that was proposed, built and REVERTED on 2026-09-11 after '
           + 'being measured at a 98.6% write-down for about $1 of attacker cost.'));

  // ── proof retire-on-spend is real ────────────────────────────────────────
  const retire = s ? card('Retire-on-spend — the proof it is running', kv([
    ['PCN retired so far', N(s.retiredPcn, 4) + ' PCN',
     'Withdrawn from the ladder because customers spent PCN at the services. '
     + 'NOTHING IS DESTROYED — those coins sit in the treasury exactly as before. '
     + '"Retired" describes the ladder inventory, not the coins.'],
    ['as a share of the ladder', PCT(s.pctRetired, 3), ''],
    ['PCN sold', N(s.soldPcn, 2) + ' PCN', PCT(s.pctSold, 2) + ' of the ladder'],
    ['PCN remaining', N(s.remainingPcn, 2) + ' PCN',
     (s.rungCount ? s.rungCount + ' rungs, ' : '') + 'step ' + N(s.stepPct, 3) + '% per rung, '
     + 'floor ' + USD(s.floorPrice, 4) + ', top ' + USD(s.topPrice, 2)],
  ])) : '';

  // ── limits and the sale gate ─────────────────────────────────────────────
  const limits = s ? card('Live limits, and the gate that can refuse an order', kv([
    ['Minimum order', USD(s.minOrderUsd, 2), ''],
    ['Maximum order', USD(s.maxOrderUsd, 2),
     'or ' + N(s.maxOrderPcn, 0) + ' PCN (' + USD(s.maxOrderUsdNow, 2) + ' today) — '
     + 'whichever binds first.'],
    ['Released automatically up to', USD(s.autoMaxUsd, 2),
     'Anything larger is delivered BY HAND. This is the main thing standing between '
     + 'the ladder and anyone trying to drain it quickly.'],
    ['Current divergence', g && g.divergencePct !== undefined ? PCT(g.divergencePct, 2) : DASH,
     'How far the price a buyer would pay sits from serviceRate. <b>At 20% the order '
     + 'is REFUSED.</b> It is measured on |ask - rate| / rate, so it is symmetric, and '
     + 'it is the real limit on how far the ladder may lead the pool.'],
    ['Market open?', g ? (g.open ? '<span class="ok">yes</span>' : '<span class="bad">no</span>') : DASH, ''],
    ['Buyback (we buy PCN back)', s.buybackOpen ? '<span class="ok">open</span>' : 'closed', ''],
  ])) : '';

  const gotchas = card('Mistakes this page exists to prevent', note(
    '<ul>'
    + '<li><b>"The same price for $20 and $200" is not a bug.</b> Recompute from '
    + '<code>ladder_rungs</code> against min(rungPrice, askCap) — it matches to the cent.</li>'
    + '<li><b>The market rounds cost UP to the next cent</b> '
    + '(<code>Math.ceil(n*100)/100</code>), so a quote is never below what is charged. '
    + 'Comparing against ordinary rounding produces a false one-cent mismatch.</li>'
    + '<li><b>Spending PCN at a service DOES affect the price</b>, through '
    + 'retire-on-spend. Finding no systemd unit is not evidence it is missing — it is '
    + 'an in-process timer.</li>'
    + '<li><b>The keeper being off is a decision, not a fault.</b> Capped, out of float, '
    + 'and switched off look identical in a screenshot; only the log distinguishes them.</li>'
    + '<li><b>The ask cap exists only on the servers.</b> The repo copy of '
    + '<code>ladder.mjs</code> has no cap, so deploying the market from git would '
    + 'silently remove it and perform the change that was deliberately reverted.</li>'
    + '<li><b>serviceRate moving is usually the POOL, not a customer.</b> Check the pool '
    + 'history before attributing it to a service payment — the rate walks toward the '
    + 'pool over hours, so the alert can arrive long after the trade that caused it.</li>'
    + '</ul>'));

  return top + pin + chain + cases + retire + limits + gotchas
    + note('Read live from price.pc.am and market.pc.am at page load.');
}
