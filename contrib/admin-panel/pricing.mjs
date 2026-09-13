// ═══════════════════════════════════════════════════════════════════════════
// HOW THE PCN PRICE IS CALCULATED — one page, with the live numbers in it.
// ═══════════════════════════════════════════════════════════════════════════
//
// WHY THIS PAGE EXISTS.
//
// On 2026-09-13 the owner asked, repeatedly and with good reason, why buying
// PCN no longer moved the price when it used to. Answering it took an hour and
// produced several WRONG answers on the way, because the chain that sets the
// price runs through four components on three hosts and nothing described the
// JOIN. This page is that description, kept beside the live figures so it
// cannot quietly go stale the way prose does.
//
// WHAT CHANGED THAT EVENING. The ladder used to charge min(rungPrice, askCap),
// and the cap had sat below its own cheapest remaining rung since the wPCN pool
// fell behind the schedule — so every order size paid exactly the same price
// and buying moved nothing. Pricing is now a CONSTANT-PRODUCT CURVE, the same
// shape PancakeSwap uses:
//
//     X = PCN still for sale + ammVirtualPcn      (virtual depth, a constant)
//     Y = ammK / X
//     price = Y / X = ammK / X²
//
// Three properties came with it, and they are the reason it is the right shape:
//   * impact is CONTINUOUS, so every order moves the price a little;
//   * it CANNOT BE GAMED BY SPLITTING — one $100 order and five sequential $20
//     orders return the identical PCN to the satoshi, which is a property of
//     x·y=k rather than an approximation;
//   * RETIRE-ON-SPEND works again for free: spending PCN at a service retires
//     ladder inventory, X falls, and the price rises. No separate mechanism.
//
// The rungs still exist and still record inventory. They no longer set price.
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
  // Quote a few real sizes, so the page SHOWS that size changes the price
  // instead of asserting it.
  const sizes = [20, 50, 100, 200, 380];
  const quotes = await Promise.all(
    sizes.map(u => get('https://market.pc.am/api/quote?usd=' + u).then(r => ({ usd: u, r }))));
  return { price, state, gate, quotes };
}

export function pricingPage(d) {
  const p = d.price.ok ? d.price.data : null;
  const s = d.state.ok ? d.state.data : null;
  const g = d.gate.ok ? d.gate.data : null;

  if (!p && !s) {
    return failed('the price oracle and the market', 'both unreadable')
      + note('Every figure here is read live. A page of zeros would be a lie '
             + 'rather than a gap, so nothing is shown.');
  }

  const pool   = p ? Number(p.pool?.spotUsd) : null;
  const median = p ? Number(p.pool?.medianUsd) : null;
  const ask    = s ? Number(s.marginalPrice) : (p ? Number(p.sellPriceUsd) : null);
  const credit = p ? Number(p.creditRateUsd) : null;
  const premium = (pool > 0 && ask > 0) ? (ask / pool - 1) * 100 : null;

  const top = tiles([
    ['PCN — you pay now',     USD(ask, 8)],
    ['wPCN — PancakeSwap',    USD(pool, 8)],
    ['PCN — rails credit at', USD(credit, 8)],
    ['PCN premium over wPCN', premium === null ? DASH : PCT(premium, 2)],
  ]);

  // ── the thing people come here to check ──────────────────────────────────
  const rows = (d.quotes || []).map(({ usd, r }) => {
    if (!r.ok || r.data?.error) {
      return [`$${usd}`, `<span class="bad">${esc(String(r.data?.error || r.error))}</span>`, '', ''];
    }
    const q = r.data;
    return [
      `$${usd}`,
      N(q.pcn, 2) + ' PCN',
      USD(q.effectivePrice, 8),
      q.newPrice ? USD(q.newPrice, 8) : DASH,
    ];
  });

  const sizeCard = card('What each order size costs, right now', tbl(
    ['Order', 'PCN you get', 'Price you pay', 'Price the NEXT buyer pays'], rows,
    'No quote could be read.')
    + note('These are live quotes from market.pc.am, fetched when this page loaded — '
           + 'not a model of what it should charge. <b>The price rises with size, and '
           + 'each purchase raises it for whoever comes next.</b> Before 2026-09-13 '
           + 'every row here showed the same price, which is the bug this replaced.'));

  // ── the curve itself ─────────────────────────────────────────────────────
  const curve = card('The curve', kv([
    ['Shape', 'price = k / X&sup2;, where X = PCN for sale + virtual depth',
     'Constant product, the same shape PancakeSwap uses. Buying lowers X, so the '
     + 'price rises; retiring inventory lowers X too, which is why spending at a '
     + 'service moves the price with no separate mechanism.'],
    ['PCN still for sale', s ? N(s.remainingPcn, 2) + ' PCN' : DASH, ''],
    ['Current price', USD(ask, 8), 'What the next buyer pays for their first coin.'],
    ['Cannot be split-gamed', 'one $100 order = five sequential $20 orders, exactly',
     'A property of x&middot;y=k, not an approximation. Verified to 0.00000000 PCN.'],
  ]));

  // ── the four cases ───────────────────────────────────────────────────────
  const ok = x => `<span class="ok">${x}</span>`;
  const cases = card('The four things a user can do, and whether each moves the price', tbl(
    ['User action', 'Mechanism', 'Does it move the price?'],
    [
      ['Buys PCN from market.pc.am',
       'walks the curve — X falls, so price = k/X&sup2; rises',
       ok('yes, immediately')],
      ['Spends PCN at one of the six services',
       '<b>retire-on-spend</b>: retireRatioPct of every PCN spent is withdrawn from '
       + 'the ladder, which lowers X. Runs as an in-process 10-minute scan inside the '
       + 'market server, so it appears in no systemctl, no crontab and no docker '
       + 'inspect — finding no unit is not evidence it is missing.',
       ok('yes, via the same curve')],
      ['Buys wPCN on PancakeSwap',
       'raises the pool, so the credit rate and the ceiling follow',
       ok('yes — slowly, via the 24h median')],
      ['Sells wPCN on PancakeSwap',
       'lowers the pool; serviceRate = min(ladder, pool) follows it down',
       ok('yes — immediately')],
    ])
    + note('<b>All four now work.</b> Before 2026-09-13 the first two were inert: the '
           + 'ask cap clamped every rung to the pool price, so neither buying nor '
           + 'spending could move the published number. Both mechanisms were built and '
           + 'running the whole time — they were pinned, not missing.'));

  // ── what still anchors it ────────────────────────────────────────────────
  const anchor = card('What still anchors the price to the outside world', kv([
    ['The wPCN pool', USD(pool, 8),
     'The only market with participants who are not us.'],
    ['24-hour pool median', USD(median, 8),
     'The ceiling is derived from the MEDIAN, never the spot. One trade is a single '
     + 'sample against ~1,440, so nobody can drag the price with one cheap trade — it '
     + 'takes a sustained, visible campaign of more than 12 hours.'],
    ['serviceRate — what the rails credit', USD(credit, 8),
     'min(ladder, pool). The pool may only ever LOWER this, never raise it: a pool '
     + 'trading ABOVE the ladder changes nothing at all.'],
    ['The sale gate', g && g.divergencePct !== undefined ? PCT(g.divergencePct, 2) + ' of 20%' : DASH,
     'An order whose AVERAGE price sits more than 20% from serviceRate is REFUSED. '
     + 'Measured on |ask − rate| / rate, so it is symmetric. <b>This is the real limit '
     + 'on how far the curve may lead the pool</b>, and it is what stops the price '
     + 'running away from the only external market there is.'],
  ]));

  const limits = s ? card('Live limits', kv([
    ['Minimum order', USD(s.minOrderUsd, 2), ''],
    ['Maximum order', USD(s.maxOrderUsd, 2),
     'or ' + N(s.maxOrderPcn, 0) + ' PCN — whichever binds first.'],
    ['Released automatically up to', USD(s.autoMaxUsd, 2),
     'Anything larger is delivered BY HAND. With 3 orders per hour and 3 pending at '
     + 'once, this is the main thing between the ladder and anyone trying to drain it.'],
    ['PCN retired by spending', N(s.retiredPcn, 4) + ' PCN',
     'Withdrawn from the ladder because customers spent PCN at the services. NOTHING '
     + 'IS DESTROYED — those coins sit in the treasury; "retired" describes the ladder.'],
    ['Sold', N(s.soldPcn, 2) + ' PCN', PCT(s.pctSold, 2) + ' of the original 100,000'],
  ])) : '';

  const gotchas = card('Mistakes this page exists to prevent', note(
    '<ul>'
    + '<li><b>The market rounds cost UP to the next cent</b> '
    + '(<code>Math.ceil(n*100)/100</code>), so a quote is never below what is charged. '
    + 'Comparing against ordinary rounding produces a false one-cent mismatch.</li>'
    + '<li><b>Spending PCN at a service DOES affect the price.</b> Finding no systemd '
    + 'unit for retire-on-spend is not evidence it is missing — it is an in-process '
    + 'timer inside the market server.</li>'
    + '<li><b>A serviceRate alert is usually the POOL, not a customer.</b> The rate '
    + 'walks toward the pool over hours, so the alert can arrive long after the trade. '
    + 'On 2026-09-13 the pool moved at 12:06 and the alert fired at 14:58, with no '
    + 'service payment that day at all.</li>'
    + '<li><b>The keeper being off is a decision, not a fault.</b> Capped, out of '
    + 'float, and switched off look identical in a screenshot; only the log tells them '
    + 'apart. <code>KEEPER_BUY</code> and <code>KEEPER_SELL</code> are both off.</li>'
    + '<li><b>The market code lives only on its server.</b> Deploying from git without '
    + 'checking would overwrite the curve and the cap together. Diff before deploying.</li>'
    + '<li><b>Never wire the ask to the pool.</b> It was built and reverted on '
    + '2026-09-11: a reversible dump lets a stranger buy the whole remaining book at a '
    + '98.6% discount for about a dollar. The curve is anchored to inventory, not to '
    + 'the pool, which is what makes it safe.</li>'
    + '</ul>'));

  return top + sizeCard + curve + cases + anchor + limits + gotchas
    + note('Read live from price.pc.am and market.pc.am at page load.');
}
