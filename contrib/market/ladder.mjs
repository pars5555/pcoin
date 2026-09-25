// ═══════════════════════════════════════════════════════════════════════════
// The PCN sale ladder — finite inventory, sold cheapest rung first.
// ═══════════════════════════════════════════════════════════════════════════
//
// WHY A LADDER AND NOT THE AMM
// A constant-product curve is asymptotic: you can always buy more, so "all
// 100,000 sold" is not a point on it and no purchase ever reaches a stated
// price. The requirement was that the price be $10.00 when 100,000 PCN are
// gone. That needs a finite instrument. 100 rungs, exactly 100,000 PCN,
// geometric from $0.015 to $10.00 at +6.79% a rung.
//
// WHAT IT BUYS
// 50,000 PCN costs ~$5,735 here against ~$51 on the AMM. The gap is the whole
// point: it stops one buyer sweeping the inventory at the floor.
//
// INVENTORY ONLY EVER SHRINKS
// Three things claim a rung and none of them ever gives it back:
//   qty_sold      someone paid for it
//   qty_reserved  an unpaid order holds it, until it expires
//   qty_retired   customers spent PCN on the services, so that much came off
//                 sale (see retire.mjs -- the coins are NOT destroyed, they sit
//                 in the treasury; only the ladder shrinks)
// Coins sold back through the buyback do NOT return either. Returning any of
// them would let a buyer walk the marginal price up and then back down.
//
// ARITHMETIC
// Quantities are integer units of 1e-8 PCN. Walking a ladder in floats and
// writing the result into a DECIMAL column with a CHECK constraint means a
// 1e-9 overshoot aborts a transaction someone has already paid for. Integers
// cannot overshoot.

export const UNITS = 1e8;
// 2 hours, not 24. An unpaid order holds real inventory, and on a ladder whose
// rungs are ~1000 PCN a single $50 order holds three of them -- which is enough
// to put every subsequent buyer several rungs up while serviceRate, which tracks
// the reservation-free price, stays put. One abandoned order therefore priced
// every other customer out for a full day. That happened on 2026-08-19.
//
// Shortening this is safe for the customer, and deliberately so: the IPN success
// branch accepts `status IN ('pending','expired')` precisely because "the sweeper
// may have timed the order out minutes before a slow chain confirmed it, and a
// payment that arrived is a payment that arrived". A late payer still gets
// recorded and still gets their coins; what they lose is the RESERVATION, not
// the purchase.
//
// NOWPayments also reports failed/expired/refunded over IPN, and that path
// releases inventory immediately. This constant is only the backstop for an
// order that goes silent -- which is exactly the case that was costing a day.
export const ORDER_TTL_HOURS = 2;       // unpaid orders release their inventory

export const toUnits = pcn => Math.round(Number(pcn) * UNITS);
export const fromUnits = u => u / UNITS;

// Retired inventory is withdrawn from sale as surely as sold inventory is, so
// it comes off availability too. Without this the walk would happily sell coins
// that usage has already taken off the ladder, and the CHECK constraint would
// abort a transaction someone had paid for.
const availUnits = r =>
  toUnits(Number(r.qty_total)) - toUnits(Number(r.qty_sold))
  - toUnits(Number(r.qty_reserved)) - toUnits(Number(r.qty_retired ?? 0));

/** Constant-product pricing over the rung inventory.
 *
 *  Returns the SAME shape as finish(), because every caller expects it -- but
 *  `marginalAfter` is the curve's next price, not a rung price. Reporting a rung
 *  price while charging a curve price is exactly how a quote and an invoice come
 *  to disagree, which is the one failure this file already guards against.
 */
export function ammWalk(rungs, { usd = null, pcn = null }, k, virt, floor = 0) {
  let remUnits = 0;
  for (const r of rungs) { const a = availUnits(r); if (a > 0) remUnits += a; }
  const rem = fromUnits(remUnits);
  if (!(rem > 0 && k > 0)) return null;          // caller falls back to the rungs

  const X = rem + virt;
  const Y = k / X;
  let wantPcn, cost;
  if (usd !== null) {
    const Y1 = Y + usd;
    wantPcn = X - (k / Y1);
    cost = usd;
  } else {
    if (!(pcn > 0 && pcn < X)) return null;
    wantPcn = pcn;
    cost = (k / (X - pcn)) - Y;
  }
  if (!(wantPcn > 0 && isFinite(wantPcn) && cost > 0 && isFinite(cost))) return null;

  // THE FLOOR -- added 2026-09-19, and it was MISSING, not weak.
  //
  // The curve has no bottom of its own: price = k / X^2 goes wherever k goes.
  // `ladderMinPriceUsd` was only ever applied by askCap(), which is on the RUNG
  // FALLBACK path -- so from the day the curve was configured (077fa32) until
  // this line existed, the market had NO floor on what it sold PCN for while
  // the curve was live. The floor read like a floor and protected a code path
  // that was no longer being taken.
  //
  // It matters now because the ask is about to start FOLLOWING the wPCN pool
  // down, which means an automation will be writing k on a schedule. A floor
  // that lives only in the automation is not a floor; it is one bug away from
  // selling the remaining book for nothing.
  //
  // Two directions, because the buyer names one side or the other:
  //   * named the MONEY  -> give no more coins than the floor allows, so the
  //                         effective price is exactly the floor;
  //   * named the COINS  -> charge no less than the coins are worth at it.
  // Neither can ever hand out MORE than the curve would: both clamps move in
  // the direction that favours the desk.
  if (Number.isFinite(floor) && floor > 0) {
    if (usd !== null) {
      const maxPcn = usd / floor;
      if (wantPcn > maxPcn) wantPcn = maxPcn;
    } else {
      const minCost = wantPcn * floor;
      if (cost < minCost) cost = minCost;
    }
    if (!(wantPcn > 0 && isFinite(wantPcn) && cost > 0 && isFinite(cost))) return null;
  }

  // Allocate the inventory. Cheapest rung first, exactly as before -- this is
  // bookkeeping now, not pricing.
  let wantUnits = toUnits(wantPcn);
  const unitPrice = cost / fromUnits(wantUnits || 1);
  let left = wantUnits, gotUnits = 0;
  const fills = [];
  for (const r of rungs) {
    if (left <= 0) break;
    const avail = availUnits(r);
    if (avail <= 0) continue;
    const take = Math.min(avail, left);
    fills.push({ rungNo: r.rung_no, units: take, price: unitPrice });
    gotUnits += take; left -= take;
  }

  // Inventory ran out mid-order: charge only for what was actually allocated.
  const filledPcn = fromUnits(gotUnits);
  const paid = left > 0 ? cost * (gotUnits / (wantUnits || 1)) : cost;
  const X1 = X - filledPcn;
  // Floored too: the price quoted for the next buyer must be a price the next
  // buyer would actually be charged, or the published number and the invoice
  // disagree the moment the curve dips under the floor.
  const rawAfter = X1 > 0 ? (k / X1) / X1 : null;
  const priceAfter = rawAfter === null ? null
    : (Number.isFinite(floor) && floor > 0 ? Math.max(rawAfter, floor) : rawAfter);

  return {
    pcn: filledPcn,
    cost: paid,
    fills,
    rungsConsumed: fills.length,
    avgPrice: gotUnits ? paid / filledPcn : 0,
    marginalAfter: priceAfter,
    usdUnfilled: usd !== null && left > 0 ? usd - paid : 0,
    pcnUnfilled: pcn !== null && left > 0 ? fromUnits(left) : 0,
    exhausted: X1 <= 0,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// INDEX MODE -- price plan Step 3 (D:\pc.am\PCOIN-PRICE-EXCHANGE-ANCHOR-PLAN.md)
// ═══════════════════════════════════════════════════════════════════════════
//
// The owner, 2026-09-24: one PCN price, "natural, depending on the exchange
// average", in place of "10 different pricings and calculations". In index mode
// this market sells every coin at ONE unit price,
//
//     unitPrice = max(index x (1 + marketPremiumPct/100), ladderMinPriceUsd)
//
// flat at every order size. The curve (ammWalk above) stays importable and is
// what `pricingMode = curve` still uses, unchanged, until the plan's Phase 4.
// ladder_rungs stays too, as the INVENTORY ledger: reservations, settlement,
// release and the sweeper all live on it, so allocation below is still cheapest
// rung first -- bookkeeping, exactly as it has been since the curve.

/** The states in which the index carries a price. `held` is not stale -- it
 *  is the index saying "no new evidence, the value stands" (plan §2.4). */
export const INDEX_PRICED_STATES = Object.freeze(['live', 'held', 'frozen']);

/** Is this index reading usable, and what does one PCN cost at it?
 *
 *  `index` is what server.mjs's getIndex() returns: { usd, state, seq,
 *  ageSeconds, stale, error }. Pure: no clock, no network.
 *
 *  Returns { ok: true, unitPrice, indexUsd, premiumPct, floored } or
 *  { ok: false, why }. Every "I do not know" is a refusal, never a number: an
 *  unreadable index is not a price of zero, a missing age is not "fresh", and a
 *  missing `stale` flag is not `false` (CLAUDE.md 7.1 / 7.2). */
export function indexUnitPrice(index, { premiumPct = 0, floor = 0, maxAgeS = 900 } = {}) {
  const because = index && index.error ? ` (${index.error})` : '';
  if (!index || typeof index !== 'object' || !index.state) {
    return { ok: false, why: `the PCN index has not been read from price.pc.am${because}` };
  }
  if (!INDEX_PRICED_STATES.includes(index.state)) {
    return { ok: false, why: `the PCN index is ${String(index.state).slice(0, 20)}, which carries no price` };
  }
  // Number(null) is 0 and Number('') is 0: test the raw value first.
  const usd = (index.usd === null || index.usd === undefined || index.usd === '') ? NaN : Number(index.usd);
  if (!(Number.isFinite(usd) && usd > 0)) return { ok: false, why: 'the PCN index carries no usable price' };
  const age = (index.ageSeconds === null || index.ageSeconds === undefined) ? NaN : Number(index.ageSeconds);
  if (!Number.isFinite(age)) return { ok: false, why: `the age of the PCN index is unknown${because}` };
  const limit = Number(maxAgeS);
  if (!(Number.isFinite(limit) && limit > 0)) return { ok: false, why: 'indexMaxAgeSeconds is not a usable number' };
  if (age > limit) {
    return { ok: false, why: `the PCN index was last confirmed ${Math.round(age)} s ago, past the ${limit} s limit${because}` };
  }
  if (index.stale !== false) return { ok: false, why: 'price.pc.am does not vouch for the PCN index as current' };
  const p = Number(premiumPct);
  if (!(Number.isFinite(p) && p >= 0)) return { ok: false, why: 'marketPremiumPct is not a usable number' };
  const f = Number(floor);
  const raw = usd * (1 + p / 100);
  // THE FLOOR, inside the price and not only in whoever writes the settings:
  // the ammWalk comment above says why a floor that lives elsewhere is not one.
  const unitPrice = (Number.isFinite(f) && f > 0) ? Math.max(raw, f) : raw;
  return { ok: true, unitPrice, indexUsd: usd, premiumPct: p,
           floored: Number.isFinite(f) && f > 0 && raw < f };
}

/** Flat pricing over the rung inventory: every PCN at `unitPrice`.
 *
 *  Same shape as ammWalk and finish(), because every caller expects it.
 *  Allocation is ammWalk's loop, line for line -- cheapest rung first, stock
 *  net of sold, reserved and retired -- so the rows an order reserves do not
 *  depend on which mode priced it (ladder-index-test.mjs proves they match).
 *
 *    named the MONEY -> floor(usd / unitPrice) coins, to the satoshi. Rounding
 *                       DOWN, never to nearest: a fraction of a satoshi more
 *                       than was paid for is still more. The buyer pays `usd`.
 *    named the COINS -> pcn x unitPrice.
 *
 *  `avgPrice` is `unitPrice` itself. With money named, cost/pcn differs from it
 *  only by the sub-satoshi remainder that floor() keeps with the desk, and
 *  reporting that as a different price per coin would make a flat price look
 *  like it moves with order size -- the one thing it does not do.
 *
 *  Inventory running out mid-order is a PARTIAL fill, charged only for what
 *  was allocated, exactly like the other two walks: `usdUnfilled` or
 *  `pcnUnfilled` says how much could not be had, and reserveLadder refuses it.
 *
 *  Returns null only when it cannot price at all (a unit price or an amount
 *  that is not a positive number). The caller must refuse then, never fall
 *  back to another pricing. */
export function flatWalk(rungs, { usd = null, pcn = null }, unitPrice) {
  if (!(Number.isFinite(unitPrice) && unitPrice > 0)) return null;
  let wantUnits;
  if (usd !== null) {
    if (!(Number.isFinite(usd) && usd > 0)) return null;
    wantUnits = Math.floor((usd / unitPrice) * UNITS);
  } else {
    if (!(Number.isFinite(pcn) && pcn > 0)) return null;
    wantUnits = toUnits(pcn);
  }

  let remUnits = 0;
  for (const r of rungs) { const a = availUnits(r); if (a > 0) remUnits += a; }

  let left = wantUnits, gotUnits = 0;
  const fills = [];
  for (const r of rungs) {
    if (left <= 0) break;
    const avail = availUnits(r);
    if (avail <= 0) continue;
    const take = Math.min(avail, left);
    fills.push({ rungNo: r.rung_no, units: take, price: unitPrice });
    gotUnits += take; left -= take;
  }

  const filledPcn = fromUnits(gotUnits);
  const full = left <= 0 && gotUnits > 0;
  const cost = (usd !== null && full) ? usd : filledPcn * unitPrice;
  // Nothing left for the NEXT buyer means there is no next price -- the same
  // null finish() reports for a sold-out rung walk, and what the sale gate
  // reads as "sold out".
  const exhausted = remUnits - gotUnits <= 0;
  return {
    pcn: filledPcn,
    cost,
    fills,
    rungsConsumed: fills.length,
    avgPrice: gotUnits ? unitPrice : 0,
    marginalAfter: exhausted ? null : unitPrice,
    // `gotUnits === 0` too: money that buys no whole satoshi bought nothing, and
    // must read as unfilled rather than as a completed $0 order.
    usdUnfilled: usd !== null && (left > 0 || gotUnits === 0) ? usd - cost : 0,
    pcnUnfilled: pcn !== null && left > 0 ? fromUnits(left) : 0,
    exhausted,
  };
}

function finish(rungs, fills, gotUnits, cost, usdLeft, pcnShort = 0, askCap = Infinity) {
  // Marginal price AFTER this walk: the first rung still holding stock once
  // these fills are applied.
  const taken = new Map(fills.map(f => [f.rungNo, f.units]));
  let marginalAfter = null;
  for (const r of rungs) {
    if (availUnits(r) - (taken.get(r.rung_no) || 0) > 0) {
      // Capped too, so what a buyer is quoted NEXT matches what they would be
      // charged. Reporting a rung price while charging a capped one is how a
      // quote and an invoice come to disagree.
      marginalAfter = Math.min(Number(r.price), askCap); break;
    }
  }
  const pcn = fromUnits(gotUnits);
  return {
    pcn, cost, fills,
    rungsConsumed: fills.length,
    avgPrice: gotUnits ? cost / pcn : 0,
    marginalAfter,
    usdUnfilled: usdLeft,               // > 0 only when inventory ran out
    pcnUnfilled: pcnShort,
    exhausted: marginalAfter === null,
  };
}

/** Spend `usd` across the rungs. Pure — decides nothing, writes nothing. */
export function walkUsd(rungs, usd, askCap = Infinity) {
  let left = usd, gotUnits = 0, cost = 0;
  const fills = [];
  for (const r of rungs) {
    // The cap only ever LOWERS a rung, never raises one, and defaults to
    // Infinity so an uncapped caller is charged exactly as before.
    const price = Math.min(Number(r.price), askCap);
    const avail = availUnits(r);
    if (avail <= 0) continue;
    const want = Math.floor((left / price) * UNITS);
    const take = Math.min(avail, want);
    if (take <= 0) break;
    const c = fromUnits(take) * price;
    fills.push({ rungNo: r.rung_no, units: take, price });
    gotUnits += take; cost += c; left -= c;
  }
  return finish(rungs, fills, gotUnits, cost, left, 0, askCap);
}

/** Take `pcn` across the rungs. Pure. This is what the calculator uses. */
export function walkPcn(rungs, pcn, askCap = Infinity) {
  let needUnits = toUnits(pcn), gotUnits = 0, cost = 0;
  const fills = [];
  for (const r of rungs) {
    if (needUnits <= 0) break;
    const price = Math.min(Number(r.price), askCap);
    const avail = availUnits(r);
    if (avail <= 0) continue;
    const take = Math.min(avail, needUnits);
    const c = fromUnits(take) * price;
    fills.push({ rungNo: r.rung_no, units: take, price });
    gotUnits += take; needUnits -= take; cost += c;
  }
  return finish(rungs, fills, gotUnits, cost, 0, fromUnits(needUnits), askCap);
}

/** What every index-mode price path throws when the index cannot be used.
 *  code 503, the same convention as reserveLadder's 409: server.mjs answers
 *  with it rather than a 500, and the text is written for the buyer, who is
 *  the one who reads it. */
export function indexUnavailableError(why) {
  const e = new Error(
    `sales are paused: the PCN price cannot be confirmed right now — ${why}. ` +
    'The price here is the PCN index from exchange.pc.am, and nothing is sold at a price ' +
    'that cannot be confirmed. Nothing was reserved or charged; this clears itself once ' +
    'the index is current again.');
  e.code = 503;
  e.indexUnavailable = true;
  e.pricingRefusal = true;       // what server.mjs's catch keys on, not the number alone
  return e;
}

export function makeLadder(pool, { notify = null, log = console, getSetting = null,
                                   getIndex = null } = {}) {
  const q = async (sql, args = []) => (await pool.query(sql, args))[0];

  // The admin panel exposes `orderTtlHours`, and until 2026-09-03 nothing read
  // it: the sweep used the ORDER_TTL_HOURS constant, so changing the setting
  // stored a new value and altered no behaviour. That was found the hard way,
  // during an incident, by changing it and watching orders expire on the old
  // number anyway. A dead knob in a money panel is worse than no knob -- the
  // operator changes it, sees it saved, and believes the system changed.
  //
  // A FUNCTION, not the settings object: the caller's binding is declared
  // after this call, and it is re-read per sweep so an admin edit takes effect
  // without a restart. The constant stays as the fallback, because the four
  // ladder test harnesses construct a ladder with no settings at all.
  const ttlHours = () => {
    let v = NaN;
    try { if (getSetting) v = Number(getSetting('orderTtlHours')); } catch { /* fall back */ }
    return Number.isFinite(v) && v > 0 ? v : ORDER_TTL_HOURS;
  };

  // THE MANUAL PRICE CAP. Re-read per call so an admin edit takes effect with
  // no restart, exactly like ttlHours above. 0 or unset means no cap at all.
  //
  // This is deliberately NOT wired to the wPCN pool. The pool holds about
  // $1,300 and a dump into it is reversible, so letting it set this number
  // would sell the remaining book at a 98% discount for under a dollar of swap
  // fees. A number a human sets is the whole defence.
  const askCap = () => {
    let v = NaN, floor = NaN;
    try { if (getSetting) v = Number(getSetting('ladderMaxPriceUsd')); } catch { /* no cap */ }
    if (!(Number.isFinite(v) && v > 0)) return Infinity;          // no cap set
    try { if (getSetting) floor = Number(getSetting('ladderMinPriceUsd')); } catch { /* none */ }
    // The cap may never sink below the floor, whoever set it and however. The
    // schedule that maintains the cap tracks a ~$1,300 pool; a clamp here is
    // what stops a pushed-down pool, a typo, or a stale automation selling the
    // remaining book for a fraction of what it is worth.
    return (Number.isFinite(floor) && floor > 0) ? Math.max(v, floor) : v;
  };
  // CONSTANT-PRODUCT PRICING. Falls back to the old capped rung walk if the
  // curve is not configured or cannot price this order -- an unconfigured
  // curve must never mean 'free', and a market that refuses every order is a
  // worse outcome than one priced the old way.
  // The floor, on its own. askCap() above reads the same setting, but only to
  // stop the CAP sinking below it -- and the cap is inert while the curve is
  // configured. The curve needs the floor handed to it directly.
  const askFloor = () => {
    let f = NaN;
    try { if (getSetting) f = Number(getSetting('ladderMinPriceUsd')); } catch { /* none */ }
    return (Number.isFinite(f) && f > 0) ? f : 0;
  };
  const ammParams = () => {
    let k = 0, v = 0;
    try {
      k = Number(getSetting ? getSetting('ammK') : 0);
      v = Number(getSetting ? getSetting('ammVirtualPcn') : 0);
    } catch { /* unset -> fall back */ }
    return (Number.isFinite(k) && k > 0 && Number.isFinite(v) && v >= 0)
      ? { k, v } : null;
  };
  // PRICING MODE (price plan Step 3). Only an explicit 'index' selects index
  // pricing. Anything else -- including a ladder built with no settings at all,
  // as the test harnesses build it -- is the curve, exactly as before.
  const pricingMode = () => {
    let m;
    try { if (getSetting) m = getSetting('pricingMode'); } catch { /* the curve */ }
    return m === 'index' ? 'index' : 'curve';
  };
  // A setting the index path needs. With no settings object at all (a test
  // harness) the default stands; WITH one, a value that is missing is NaN --
  // unknown -- so indexUnitPrice() refuses instead of quietly pricing at a
  // premium of 0. A default parameter would not do: `undefined` passed in
  // explicitly takes the default, which is the silent fallback itself.
  const setting = (k, dflt) => {
    if (!getSetting) return dflt;
    let v;
    try { v = getSetting(k); } catch { return NaN; }
    return (v === undefined || v === null) ? NaN : v;
  };
  const readIndex = () => {
    try { return getIndex ? getIndex() : null; }
    catch (e) { return { error: String(e && e.message || e).slice(0, 120) }; }
  };
  const indexQuote = (idx = readIndex()) => indexUnitPrice(idx, {
    premiumPct: setting('marketPremiumPct', 0),
    floor: askFloor(),
    maxAgeS: setting('indexMaxAgeSeconds', 900),
  });
  // NEVER falls back to the curve, or to anything else. An index that cannot
  // be trusted CLOSES the market (plan §2.4, state `unknown`): selling on the
  // curve instead would charge a number nobody chose, from a k the ask-follow
  // timer stopped maintaining the day this mode was switched on.
  const indexWalk = (rungs, want) => {
    const q = indexQuote();
    if (!q.ok) throw indexUnavailableError(q.why);
    const w = flatWalk(rungs, want, q.unitPrice);
    if (!w) {
      const e = new Error('that amount cannot be priced');
      e.code = 400; e.pricingRefusal = true; throw e;
    }
    return w;
  };

  const walkUsdCapped = (rungs, usd) => {
    if (pricingMode() === 'index') return indexWalk(rungs, { usd });
    const p = ammParams();
    if (p) { const r = ammWalk(rungs, { usd }, p.k, p.v, askFloor()); if (r) return r; }
    return walkUsd(rungs, usd, askCap());
  };
  const walkPcnCapped = (rungs, pcn) => {
    if (pricingMode() === 'index') return indexWalk(rungs, { pcn });
    const p = ammParams();
    if (p) { const r = ammWalk(rungs, { pcn }, p.k, p.v, askFloor()); if (r) return r; }
    return walkPcn(rungs, pcn, askCap());
  };

  // sweepExpiredOrders is what returns inventory from orders nobody paid for.
  // If it stops working, unpaid reservations accumulate and the ladder quietly
  // runs out of PCN to sell while the rungs are, in fact, untouched — and this
  // module was built with no way to say so. Throttled: a persistent fault
  // repeats every 15 minutes.
  let lastSweepAlert = 0;
  async function alertSweep(text) {
    if (!notify) return;
    if (Date.now() - lastSweepAlert < 60 * 60 * 1000) return;
    lastSweepAlert = Date.now();
    try { await notify(text); } catch (e) { log.warn('[ladder] alert failed:', e.message); }
  }

  /** Rungs with anything left to give, cheapest first. `forUpdate` takes row
   *  locks — every writer walks the same rows in the same order, so two buyers
   *  hitting one rung serialise instead of both being told it is available. */
  async function rungsWithStock(conn = pool, forUpdate = false) {
    const [rows] = await conn.query(
      `SELECT rung_no, price, qty_total, qty_sold, qty_reserved, qty_retired
         FROM ladder_rungs
        WHERE qty_sold + qty_reserved + qty_retired < qty_total
        ORDER BY rung_no` + (forUpdate ? ' FOR UPDATE' : ''));
    return rows;
  }

  /** What the ladder looks like to the outside world.
   *
   *  The published marginal price is driven by qty_sold AND qty_retired, never
   *  by reservations. (It did once count sold alone; retire-on-spend is the
   *  whole reason usage moves the price, so leaving it out would have made the
   *  mechanism invisible in the one number everything reads.) Reserving costs
   *  nothing — an attacker could open orders they
   *  never pay for and walk the published price up, and since serviceRate
   *  follows this number, that would inflate what four products credit real
   *  customers. Quoting still respects reservations, so we cannot oversell;
   *  only the published number ignores them. */
  async function ladderState(conn = pool) {
    const [[agg]] = await conn.query(
      `SELECT SUM(qty_total) tot, SUM(qty_sold) sold, SUM(qty_reserved) resv,
              SUM(qty_retired) retd FROM ladder_rungs`);
    // The published price counts SOLD and RETIRED, never reservations. Selling
    // and usage are both real, irreversible reductions in what is for sale;
    // a reservation is a promise that may expire, and letting it move the
    // published number would let anyone walk the price with orders they never
    // pay for.
    const [[marg]] = await conn.query(
      `SELECT price FROM ladder_rungs WHERE qty_sold + qty_retired < qty_total
        ORDER BY rung_no LIMIT 1`);
    const [[next]] = await conn.query(
      `SELECT price FROM ladder_rungs WHERE qty_sold + qty_reserved + qty_retired < qty_total
        ORDER BY rung_no LIMIT 1`);
    const tot = Number(agg.tot), sold = Number(agg.sold), resv = Number(agg.resv),
          retd = Number(agg.retd || 0);
    // The ladder's own shape, published so the page never has to hardcode it.
    // It already went stale once: the site described a "$0.001 floor, 9.75% a
    // step" ladder for hours after it was rebuilt at $0.015 and 6.7885%, in the
    // first paragraph a buyer reads. Anything the server knows, the server says.
    const [[shape]] = await conn.query(
      `SELECT MIN(price) AS lo, MAX(price) AS hi, COUNT(*) AS n,
              MAX(CASE WHEN rung_no=1 THEN price END) AS p1,
              MAX(CASE WHEN rung_no=2 THEN price END) AS p2
         FROM ladder_rungs`);
    const p1 = Number(shape?.p1), p2 = Number(shape?.p2);
    // ONE read of the index for the whole reply, so marginalPrice, nextFillPrice
    // and the published `index` block cannot come from two different readings.
    const mode = pricingMode();
    const idx = readIndex();
    const iq = indexQuote(idx);
    const idxAge = idx && Number.isFinite(Number(idx.ageSeconds)) && idx.ageSeconds !== null
      ? Math.round(Number(idx.ageSeconds)) : null;
    return {
      // Index mode: ONE price for every coin, so the published price and the
      // next fill are the same number whatever is reserved. null means there
      // is nothing to sell, or -- with priceUnavailable set -- no price we can
      // stand behind; server.mjs tells those two apart, because price.pc.am
      // reads a bare null as "sold out, keep the last price" (see
      // /api/ladder/state there).
      pricingMode: mode,
      premiumPct: setting('marketPremiumPct', 0),
      index: idx && idx.state ? {
        usd: Number.isFinite(Number(idx.usd)) && idx.usd !== null ? Number(idx.usd) : null,
        state: String(idx.state).slice(0, 20),
        seq: Number.isSafeInteger(idx.seq) ? idx.seq : null,
        ageSeconds: idxAge,
        stale: typeof idx.stale === 'boolean' ? idx.stale : null,
        usable: iq.ok,
        ...(iq.ok ? {} : { why: iq.why }),
      } : null,
      priceUnavailable: mode === 'index' && !iq.ok ? iq.why : null,
      // Both capped, so the published price is the price charged. The rate
      // oracle reads marginalPrice into st.ladderPrice and computes
      // min(ladder, pool) -- safe here because the cap is a constant an
      // operator set, not a pool read, so nothing is circular.
      // On the curve when it is configured. marginalPrice still ignores
      // reservations, for the reason given above the two queries: an unpaid
      // order must never be able to move the published price.
      marginalPrice: (() => {
        if (mode === 'index') return iq.ok && (tot - sold - retd) > 0 ? iq.unitPrice : null;
        const p = ammParams();
        if (p) { const X = (tot - sold - retd) + p.v;
                 if (X > 0) return Math.max((p.k / X) / X, askFloor()); }
        return marg ? Math.min(Number(marg.price), askCap()) : null;
      })(),
      // What the next REAL buyer would be charged, so this one does include
      // everyone else's outstanding holds.
      nextFillPrice: (() => {
        if (mode === 'index') return iq.ok && (tot - sold - resv - retd) > 0 ? iq.unitPrice : null;
        const p = ammParams();
        if (p) { const X = (tot - sold - resv - retd) + p.v;
                 if (X > 0) return Math.max((p.k / X) / X, askFloor()); }
        return next ? Math.min(Number(next.price), askCap()) : null;
      })(),
      rungMarginalPrice: marg ? Number(marg.price) : null,  // uncapped, for reference
      askCapUsd: Number.isFinite(askCap()) ? askCap() : null,
      floorPrice: shape ? Number(shape.lo) : null,       // the first rung, ever
      topPrice: shape ? Number(shape.hi) : null,         // the last rung
      rungCount: shape ? Number(shape.n) : null,
      stepPct: (p1 > 0 && p2 > 0) ? ((p2 / p1) - 1) * 100 : null,
      totalPcn: tot,
      soldPcn: sold,
      reservedPcn: resv,
      retiredPcn: retd,
      remainingPcn: tot - sold - resv - retd,
      pctSold: tot ? Number(((sold / tot) * 100).toFixed(4)) : 0,
      pctRetired: tot ? Number(((retd / tot) * 100).toFixed(4)) : 0,
      at: new Date().toISOString(),
    };
  }

  /** Reserve inventory for an order, inside the CALLER's transaction.
   *
   *  Reservation happens at ORDER CREATION, not at payment, because the order
   *  already commits us to a quantity: `orders.quoted_pcn` is written now and
   *  the invoice is for a fixed number of dollars. Without a reservation two
   *  orders could be quoted against the same rungs and we would owe more PCN at
   *  those prices than the rungs hold. */
  async function reserveLadder(conn, orderId, usd) {
    const rungs = await rungsWithStock(conn, true);
    const w = walkUsdCapped(rungs, usd);
    // Refuse a partial fill rather than take money for coins that do not exist.
    // A tenth of a cent of rounding dust is not a shortfall.
    if (w.usdUnfilled > 0.001) {
      // Worded per mode: in index mode there are no rungs to a buyer, only one
      // price, and a message about "current rungs" describes another product.
      const e = new Error(pricingMode() === 'index'
        ? `only ${w.pcn.toFixed(2)} PCN are left for sale here, worth $${w.cost.toFixed(2)} at the ` +
          `current price. Order at or below that.`
        : `the ladder has ${w.pcn.toFixed(2)} PCN left, worth $${w.cost.toFixed(2)} at current rungs. ` +
          `Order at or below that.`);
      e.code = 409; throw e;
    }
    for (const f of w.fills) {
      const qty = fromUnits(f.units).toFixed(8);
      await conn.query(
        `INSERT INTO ladder_fills (order_id, rung_no, qty, price) VALUES (?,?,?,?)`,
        [orderId, f.rungNo, qty, f.price]);
      await conn.query(
        `UPDATE ladder_rungs SET qty_reserved = qty_reserved + ? WHERE rung_no = ?`,
        [qty, f.rungNo]);
    }
    return w;
  }

  /** reserved -> sold. Called when payment confirms.
   *  Idempotent: a second call finds no 'reserved' rows and does nothing, which
   *  is what makes a NOWPayments callback retry safe. */
  async function settleLadder(orderId, conn = null) {
    return moveFills(orderId, 'sold', (c, f) =>
      c.query(`UPDATE ladder_rungs SET qty_sold = qty_sold + ?, qty_reserved = qty_reserved - ?
                WHERE rung_no = ?`, [f.qty, f.qty, f.rung_no]), conn);
  }

  /** reserved -> released. Called when an order fails, expires, or is refunded.
   *  Only ever touches 'reserved' rows, so it can never un-sell a paid order. */
  async function releaseLadder(orderId, conn = null) {
    return moveFills(orderId, 'released', (c, f) =>
      c.query(`UPDATE ladder_rungs SET qty_reserved = qty_reserved - ? WHERE rung_no = ?`,
              [f.qty, f.rung_no]), conn);
  }

  /** `outerConn` runs this inside the CALLER's transaction instead of its own.
   *  The sweeper needs that: expiring an order and giving its rungs back have
   *  to be one atomic act, or there is a window where the order is terminal and
   *  the inventory is already back on sale (see sweepExpiredOrders). */
  async function moveFills(orderId, toState, applyRung, outerConn = null) {
    const conn = outerConn || await pool.getConnection();
    try {
      if (!outerConn) await conn.beginTransaction();

      // LOCK ORDER: ladder_rungs BEFORE ladder_fills, ascending rung_no.
      //
      // This is not decoration. reserveLadder takes rungsWithStock(conn, true)
      // -- a `SELECT ... FROM ladder_rungs ... ORDER BY rung_no FOR UPDATE` --
      // and only then INSERTs into ladder_fills: rungs, then fills. This
      // function used to do the exact opposite, locking ladder_fills first and
      // reaching ladder_rungs afterwards through applyRung. Two transactions
      // running concurrently -- one buyer reserving, one payment settling --
      // could therefore each hold what the other was waiting for, and InnoDB
      // resolves that by killing one of them. The victim is arbitrary: it can
      // be the settle, which is the transaction that runs when a customer has
      // already paid.
      //
      // Acquiring the rung locks first, in the same ascending order, means
      // every writer queues on the same resource in the same sequence. The
      // DISTINCT read below is a plain snapshot read and does not need to lock
      // -- fills for an order are written once, at reservation, and never
      // added to afterwards.
      const [which] = await conn.query(
        `SELECT DISTINCT rung_no FROM ladder_fills
          WHERE order_id = ? AND state = 'reserved' ORDER BY rung_no`, [orderId]);
      if (which.length) {
        await conn.query(
          `SELECT rung_no FROM ladder_rungs WHERE rung_no IN (${which.map(() => '?').join(',')})
            ORDER BY rung_no FOR UPDATE`, which.map(r => r.rung_no));
      }

      const [fills] = await conn.query(
        `SELECT rung_no, qty FROM ladder_fills WHERE order_id = ? AND state = 'reserved' FOR UPDATE`,
        [orderId]);
      for (const f of fills) await applyRung(conn, f);
      await conn.query(
        `UPDATE ladder_fills SET state = ?, settled_at = NOW()
          WHERE order_id = ? AND state = 'reserved'`, [toState, orderId]);
      if (!outerConn) await conn.commit();
      return fills.length;
    } catch (e) {
      if (!outerConn) await conn.rollback();
      throw e;                       // an outer caller owns its own rollback
    } finally { if (!outerConn) conn.release(); }
  }

  /** Take an order out of 'pending' and give its rungs back, in ONE transaction.
   *
   *  THE ONE PLACE THAT DOES THIS. There are three callers -- the sweeper below,
   *  the customer's own cancel button, and the admin panel's Expire action --
   *  and they were three separate implementations, of which only the sweeper had
   *  been fixed. The window the other two still had:
   *
   *    1. commit status='expired'
   *    2. release the rungs; someone else buys them
   *    3. the original buyer's payment lands, the order moves to
   *       awaiting_delivery, and settleLadder finds no 'reserved' fills
   *
   *  The IPN handler accepts a payment for an 'expired' order ON PURPOSE -- a
   *  slow chain can confirm minutes after a timeout -- so that sequence is
   *  reachable, and it ends with a buyer having paid for inventory that was
   *  resold at those prices. Holding both writes in one transaction removes it:
   *  a concurrent payment either sees the order still 'pending' and waits on the
   *  row lock, or sees it expired with the inventory already handed back.
   *
   *  `owner` is optional. Passing it makes the UPDATE the authorisation check
   *  and the race guard in a single statement, which is what the customer-facing
   *  cancel needs: you cannot cancel somebody else's order, and you cannot
   *  cancel one a payment has just moved.
   *
   *  Returns { expired, released }. expired:false means the order was not
   *  pending (or not yours) and NOTHING was touched -- never an error, because
   *  "a payment got there first" is a normal outcome, not a fault.
   */
  async function expireWithRelease(orderId, { owner = null, reason = 'expired' } = {}) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [r] = owner
        ? await conn.query(
            `UPDATE orders SET status = 'expired'
              WHERE order_id = ? AND email = ? AND status = 'pending'`, [orderId, owner])
        : await conn.query(
            `UPDATE orders SET status = 'expired'
              WHERE order_id = ? AND status = 'pending'`, [orderId]);
      if (r.affectedRows !== 1) {
        await conn.rollback();
        return { expired: false, released: 0 };
      }
      const released = await releaseLadder(orderId, conn);
      await conn.commit();
      console.log(`[ladder] ${reason} ${orderId}, released ${released} rung reservation(s)`);
      return { expired: true, released };
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally { conn.release(); }
  }

  /** Abandoned orders must give their inventory back, or the ladder slowly
   *  locks itself up behind invoices nobody ever paid. */
  async function sweepExpiredOrders() {
    try {
      const stale = await q(
        `SELECT order_id FROM orders
          WHERE status = 'pending' AND created_at < (NOW() - INTERVAL ? HOUR)`, [ttlHours()]);
      for (const o of stale) {
        // ONE TRANSACTION for the flip and the release.
        //
        // These used to be two autocommit statements, and the gap between them
        // was a window where the order was already 'expired' and its rungs were
        // already back on sale. The IPN handler accepts a payment for an
        // 'expired' order on purpose -- the sweeper may have timed it out
        // minutes before a slow chain confirmed -- so the sequence was:
        //
        //   1. sweeper commits status='expired'
        //   2. sweeper releases the rungs; someone else buys them
        //   3. the original buyer's payment lands, the order moves to
        //      awaiting_delivery, and settleLadder finds no 'reserved' fills
        //
        // The buyer has paid for inventory that was resold at those prices. The
        // UNBACKED alert in the IPN handler catches it, but only after the money
        // is taken -- it is a smoke alarm, not a fix. Holding both writes in one
        // transaction removes the window: a concurrent payment either sees the
        // order still 'pending' (and the row lock makes it wait), or sees it
        // expired with the inventory already given back.
        // expireWithRelease holds both writes in one transaction; a return of
        // expired:false means a payment landed first, which is normal and means
        // touch nothing.
        try {
          await expireWithRelease(o.order_id, { reason: 'swept' });
        } catch (e) {
          console.error(`[ladder] could not expire ${o.order_id}: ${e.message}`);
        }
      }

      // Self-heal. Everywhere an order leaves 'pending', the status change and
      // the ladder move are two separate transactions — here, on the
      // invoice-failure path, and in the IPN handler. A crash or a lost
      // connection between them leaves an order in a terminal state whose rungs
      // are still marked 'reserved', and nothing would ever look at it again:
      // the sweep above only ever selects status='pending', which that order no
      // longer is. Those rungs would be locked until someone noticed by hand.
      //
      // Reconciling from the FILLS rather than the orders closes it. Safe to run
      // repeatedly, because releaseLadder only touches rows still 'reserved'.
      const orphaned = await q(
        `SELECT DISTINCT f.order_id
           FROM ladder_fills f
           JOIN orders o ON o.order_id = f.order_id
          WHERE f.state = 'reserved'
            AND o.status IN ('expired','failed','refunded')`);
      for (const o of orphaned) {
        const n = await releaseLadder(o.order_id);
        if (n) console.warn(`[ladder] reconciled ${o.order_id}: released ${n} rung reservation(s) ` +
                            `left behind by a terminal order`);
      }

      // The mirror image: fills still 'reserved' whose order was already paid.
      // settleLadder is idempotent, so re-running it is free and turns a
      // half-applied settlement into a complete one.
      const unsettled = await q(
        `SELECT DISTINCT f.order_id
           FROM ladder_fills f
           JOIN orders o ON o.order_id = f.order_id
          WHERE f.state = 'reserved'
            AND o.status IN ('awaiting_delivery','delivered')`);
      for (const o of unsettled) {
        const n = await settleLadder(o.order_id);
        if (n) console.warn(`[ladder] reconciled ${o.order_id}: settled ${n} rung reservation(s) ` +
                            `for an order that was already paid`);
      }
    } catch (e) {
      console.error('[ladder] sweep failed:', e.message);
      // Unpaid reservations are no longer being returned. Nothing else looks
      // at them, so left alone the ladder slowly stops being able to sell.
      await alertSweep(`🟠 <b>Reservation sweep FAILED</b>
Inventory from unpaid orders is not ` +
        `being returned to the ladder. Left alone, the market runs out of PCN to sell while ` +
        `the rungs are actually untouched.
<code>${String(e.message).slice(0, 200)}</code>`);
    }
  }

  // walkUsd/walkPcn are exposed CAPPED: every consumer (quote, calc,
  // maxOrderUsdNow, the backing check) must see the price actually charged.
  // The uncapped originals stay importable for the test harnesses. In index
  // mode the same two names price flat at the index, and THROW (code 503)
  // rather than price at all when the index cannot be used.
  return { rungsWithStock, ladderState, reserveLadder, settleLadder, releaseLadder,
           expireWithRelease, sweepExpiredOrders,
           walkUsd: walkUsdCapped, walkPcn: walkPcnCapped };
}
