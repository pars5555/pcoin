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
//
// AND THEN, ON 2026-09-25, THE CURVE WAS RETIRED TOO. The PCN price is now the
// PCN INDEX: the volume-weighted median of qualifying user-to-user fills on
// exchange.pc.am (price plan Phase 3). market.pc.am sells at index x (1 +
// premium), flat at every size; price.pc.am's creditRateUsd IS the index; the
// keeper holds the pool to it both ways; the exchange bots quote off it.
// indexPage() below renders that. The curve rendering is kept, unchanged, for
// a rollback: the page picks one from the LIVE pricingMode / index.inUse, never
// from a constant.
import { esc, num, N, USD, PCT, card, note, kv, tbl, tiles, failed, DASH } from './ui.mjs';
import { upstreamCreds } from './services.mjs';
import { readPrice } from './price-feed.mjs';

// The market's read-only token. /api/ladder/state serves the pricing-policy
// fields only to our own callers now; an anonymous caller gets the public
// subset. Without this the page would quietly render dashes for soldPcn and
// retiredPcn rather than say anything was wrong, which is the failure mode this
// panel exists to avoid.
const mktAuth = () => {
  const t = upstreamCreds()?.market?.readToken;
  return t ? { Authorization: 'Bearer ' + t } : {};
};

const TTL_MS = 60_000;
const cache = new Map();

async function get(url, headers = {}) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.val;
  let val;
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(12000) });
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
    // /detail first, through this page's own cache, either body shape
    // (price-feed.mjs): the pool median and the index block this page explains
    // leave the ROOT body in the 2026-09-25 simplification.
    readPrice((u) => get(u)),
    // soldPcn and retiredPcn are no longer served to anonymous callers --
    // /api/ladder/state now gives the public only what the public page needs,
    // because the policy fields let anyone compute how much buying trips the
    // sale gate. The read token gets us the full view.
    get('https://market.pc.am/api/ladder/state', mktAuth()),
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

  // Index mode is read, not assumed: the market's own pricingMode (plan Step
  // 3) or price.pc.am's index.inUse (Step 4). Either one on means the curve
  // below no longer describes what customers are charged.
  if ((s && s.pricingMode === 'index') || (p && p.index && p.index.inUse === true)) {
    return indexPage(d, { p, s, pool, ask, credit });
  }

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
       ok('yes — slowly, via the 6h median')],
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
    ['6-hour pool median', USD(median, 8),
     'The ask follows the MEDIAN down, never the spot: at most hourly, 8% a step and 12% a '
     + 'day, and never below $0.015. One trade is one sample against ~360, so nobody can '
     + 'drag the price with one cheap trade — it takes a sustained campaign of more than 3 '
     + 'hours. (It was 24 hours and x1.05 until 2026-09-23.)'],
    ['serviceRate — what the rails credit', USD(credit, 8),
     'min(ladder, pool). The pool may only ever LOWER this, never raise it: a pool '
     + 'trading ABOVE the ladder changes nothing at all.'],
    ['The sale gate', g && g.divergencePct !== undefined ? PCT(g.divergencePct, 2) + ' (refused at maxDivergencePct, 1000% since 2026-09-14)' : DASH,
     'An order whose AVERAGE price sits further than maxDivergencePct from serviceRate is REFUSED. '
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

  const shadow = card('Coming: one price from real trades', note(
    'A PCN index built from user-to-user fills on exchange.pc.am has run in <b>shadow</b> since '
    + '2026-09-24: computed, relayed by price.pc.am, used by nothing. See <b>PCN index</b> '
    + 'in the menu for the number, the fills behind it and every move.'));

  return top + shadow + sizeCard + curve + cases + anchor + limits + gotchas
    + note('Read live from price.pc.am and market.pc.am at page load.');
}

// ── index mode (price plan Phase 3, since 2026-09-25) ──────────────────────
// A missing number stays missing: Number(null) is 0, and a $0 tile on the page
// that explains the price would be the worst kind of wrong.
const numOrNull = (x) => (x === null || x === undefined || x === '' || !isFinite(Number(x)) ? null : Number(x));

function indexPage(d, { p, s, pool, credit }) {
  const ix = p && p.index ? p.index : null;
  const idx = ix ? numOrNull(ix.usd) : null;
  const ask = s ? numOrNull(s.marginalPrice) : (p ? numOrNull(p.sellPriceUsd) : null);
  const railsOnIndex = !!(ix && ix.inUse === true);
  const marketOnIndex = !!(s && s.pricingMode === 'index');
  const usable = !!(ix && ix.stale === false && ['live', 'held', 'frozen'].includes(ix.state) && idx > 0);
  const poolGap = (pool > 0 && idx > 0) ? (pool / idx - 1) * 100 : null;

  const top = tiles([
    ['PCN index', USD(idx, 8)],
    ['PCN — you pay now', USD(ask, 8)],
    ['PCN — rails credit at', USD(credit, 8)],
    ['wPCN pool vs index', poolGap === null ? DASH : (poolGap >= 0 ? '+' : '') + PCT(poolGap, 2)],
  ]);

  const warn = usable ? '' : card('THE INDEX IS NOT USABLE RIGHT NOW', note(
    `<b class="bad">state ${esc(ix ? ix.state : 'not relayed')}${ix && ix.stale ? ', stale' : ''}.</b> `
    + (railsOnIndex ? '<code>/credit-rate</code> answers 503 and every rail HOLDS new credits. ' : '')
    + (marketOnIndex ? 'market.pc.am does not sell until it is back. ' : '')
    + 'Nothing falls back to a guessed price. The PCN index page shows why.'));

  const how = card('How the PCN price is set (since 2026-09-25)', kv([
    ['The PCN index', USD(idx, 8),
     (ix ? `state <b>${esc(ix.state)}</b>${ix.stale ? ' — <b class="bad">STALE</b>' : ''}, computed `
         + `${esc(ix.ageSeconds ?? '—')} s ago. ` : 'not relayed by price.pc.am. ')
     + 'The volume-weighted median of qualifying user-to-user fills on exchange.pc.am: house bots, our own '
     + 'accounts, linked accounts and accounts under 3 days old never count. At most 2% per qualifying fill '
     + 'and 5% a day, within $0.015–$0.10, and it HOLDS when the evidence is thin. The fills behind it are on '
     + 'the <b>PCN index</b> page.'],
    ['market.pc.am sells at', USD(ask, 8),
     marketOnIndex
       ? `index × (1 + ${esc(s.premiumPct ?? '—')}%), one flat price at every order size. An unknown or stale `
         + 'index closes the sale; it never falls back to the curve.'
       : '<b class="bad">still on the curve</b> (pricingMode is not index), so the market is priced as before.'],
    ['Rails credit at (creditRateUsd)', USD(credit, 8),
     railsOnIndex
       ? '= the index. <code>/credit-rate</code> answers 503 while the index is unknown or stale, and every rail holds.'
       : '<b class="bad">not the index yet</b> (useIndex is 0): the legacy walk still sets it.'],
    ['Exchange house bots', 'ask index + 3% · bid index − 30%',
     'Ask up to $120 a day; bid up to $50 a day in five $10 rounds (00:00, 04:48, 09:36, 14:24, 19:12 UTC). '
     + 'House fills never count toward the index. Live state: the Exchange page.'],
    ['Keeper (wPCN pool)', USD(pool, 8),
     'Held within its dead band (3%) of the index in BOTH directions when <code>anchor_index</code> is on, every '
     + 'minute, at most $10 / 400 wPCN a run and $50 / 2,000 wPCN a day. The pool is NOT an input to the price. '
     + 'Settings: the Keeper page.'],
  ]));

  const rows = (d.quotes || []).map(({ usd, r }) => {
    if (!r.ok || r.data?.error) {
      return [`$${usd}`, `<span class="bad">${esc(String(r.data?.error || r.error))}</span>`, '', ''];
    }
    const q = r.data;
    return [`$${usd}`, N(q.pcn, 2) + ' PCN', USD(q.effectivePrice, 8), q.newPrice ? USD(q.newPrice, 8) : DASH];
  });
  const sizeCard = card('What each order size costs, right now', tbl(
    ['Order', 'PCN you get', 'Price you pay', 'Price the NEXT buyer pays'], rows,
    'No quote could be read.')
    + note('Live quotes from market.pc.am, fetched when this page loaded. <b>In index mode every row shows the '
           + 'same price</b> &mdash; the index plus the premium, flat at every size. A row that differs means the '
           + 'market is not in index mode, or that quote failed.'));

  const limits = s ? card('Live limits', kv([
    ['Minimum order', USD(s.minOrderUsd, 2), ''],
    ['Maximum order', USD(s.maxOrderUsd, 2),
     'or ' + N(s.maxOrderPcn, 0) + ' PCN — whichever binds first.'],
    ['Released automatically up to', USD(s.autoMaxUsd, 2), 'Anything larger is delivered BY HAND.'],
    ['PCN still for sale', N(s.remainingPcn, 2) + ' PCN',
     'The rung table is now only the inventory ledger; its prices are unused.'],
    ['Sold', N(s.soldPcn, 2) + ' PCN', PCT(s.pctSold, 2) + ' of the original 100,000'],
  ])) : '';

  const gotchas = card('Mistakes this page exists to prevent', note(
    '<ul>'
    + '<li><b>Held is not stale.</b> A held index is still the price: it is re-published every tick with a '
    + 'fresh time. Only <code>stale</code>, state <i>unknown</i>, or a 503 from <code>/credit-rate</code> stops the rails.</li>'
    + '<li><b>The index and the last trade are different numbers.</b> The index is a capped median that can hold '
    + 'still for days; the exchange\'s last trade is one fill.</li>'
    + '<li><b>A credit-rate move now comes from an index move</b>, not from the pool. The PCN index page shows the '
    + 'fills behind every move.</li>'
    + '<li><b>The market rounds cost UP to the next cent</b> (<code>Math.ceil(n*100)/100</code>), so a quote is '
    + 'never below what is charged.</li>'
    + '<li><b>Retired, not deleted:</b> the curve, retire-on-spend, the hourly ask-follow and the divergence sale '
    + 'gate. They come back only on a rollback (<code>pricing-mode.mjs curve</code>, <code>useIndex 0</code>), and '
    + 'this page then shows the curve again.</li>'
    + '<li><b>Never wire the ask to the pool.</b> Built and reverted on 2026-09-11 (a 98.6% write-down for about a '
    + 'dollar). The index takes the pool out of the price altogether.</li>'
    + '</ul>'));

  return top + warn + how + sizeCard + limits + gotchas
    + note('Read live from price.pc.am and market.pc.am at page load.');
}
