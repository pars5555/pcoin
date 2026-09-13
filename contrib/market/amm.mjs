// ═══════════════════════════════════════════════════════════════════════════
// Constant-product pricing for the PCN ladder — the PancakeSwap formula.
// ═══════════════════════════════════════════════════════════════════════════
//
// WHY. The rung ladder cannot price by size any more. Every rung is charged at
// min(rungPrice, askCap), and the cap has sat below the ladder's own next rung
// since the wPCN pool fell behind the schedule — so $20 and $380 cost exactly
// the same per coin, and buying moves nothing. The owner asked for the
// PancakeSwap shape instead, and he is right that it is the better fit:
//
//   * impact is CONTINUOUS, so every order moves the price a little;
//   * it CANNOT BE GAMED BY SPLITTING — one $100 order and five sequential $20
//     orders return the identical number of PCN, exactly (verified to 0.00000000
//     PCN, which is a property of x*y=k and not an approximation);
//   * retire-on-spend starts working again for free: retiring inventory shrinks
//     x, and price = y/x, so spending at a service raises the price with no new
//     mechanism at all;
//   * no cap is needed, because there are no rungs to clamp.
//
// THE ONE KNOB is `depth` (L). Both reserves are scaled by it, so the SPOT
// PRICE IS UNCHANGED and only the steepness moves. Scaling one side alone
// changes the price instead of the depth — that mistake was made once while
// deriving this and produced a 3,900% price, so the invariant is asserted below
// rather than trusted.
//
// NOTHING HERE TOUCHES STATE. It is a pure function of (inventory, price, depth,
// order size). Whoever wires it in owns the reserve bookkeeping; this file
// cannot spend, reserve, or write anything.

/** Virtual reserves that price at `price` with `depth` times the steepness of
 *  the bare inventory. x is PCN, y is USD, and the spot price is y/x. */
export function reserves(remainingPcn, price, depth = 1) {
  const x = Number(remainingPcn) * Number(depth);
  const y = Number(remainingPcn) * Number(price) * Number(depth);
  if (!(x > 0 && y > 0 && isFinite(x) && isFinite(y))) {
    throw new Error('reserves: inventory and price must both be positive and finite');
  }
  return { x, y, k: x * y };
}

/** Spend `usd` along the curve. Returns what the buyer gets and what the price
 *  becomes for the NEXT buyer. */
export function quoteUsd(r, usd) {
  const spend = Number(usd);
  if (!(spend > 0 && isFinite(spend))) throw new Error('quoteUsd: usd must be positive');
  const y2 = r.y + spend;
  const x2 = r.k / y2;
  const pcn = r.x - x2;
  if (!(pcn > 0 && isFinite(pcn))) throw new Error('quoteUsd: produced no PCN');
  return {
    pcn,
    avgPrice: spend / pcn,
    priceBefore: r.y / r.x,
    priceAfter: y2 / x2,
    impactPct: ((y2 / x2) / (r.y / r.x) - 1) * 100,
    reservesAfter: { x: x2, y: y2, k: r.k },
  };
}

/** Buy a quantity of PCN instead of spending an amount. The mirror of the above;
 *  both walk the same curve, so they agree. */
export function quotePcn(r, pcn) {
  const want = Number(pcn);
  if (!(want > 0 && want < r.x)) throw new Error('quotePcn: quantity must be positive and below the reserve');
  const x2 = r.x - want;
  const y2 = r.k / x2;
  const cost = y2 - r.y;
  return {
    cost,
    pcn: want,
    avgPrice: cost / want,
    priceBefore: r.y / r.x,
    priceAfter: y2 / x2,
    impactPct: ((y2 / x2) / (r.y / r.x) - 1) * 100,
    reservesAfter: { x: x2, y: y2, k: r.k },
  };
}

/** The largest order whose AVERAGE price stays within `gatePct` of `serviceRate`.
 *  The sale gate refuses anything past that, so quoting above it would advertise
 *  an order the market will not fill. Bisection, because the closed form is not
 *  worth the risk of getting wrong. */
export function maxOrderUsd(r, serviceRate, gatePct, marginPct = 0) {
  const limit = Number(serviceRate) * (1 + (Number(gatePct) - Number(marginPct)) / 100);
  let lo = 0, hi = r.y;                       // spending the whole reserve is an upper bound
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (mid <= 0) break;
    let avg;
    try { avg = quoteUsd(r, mid).avgPrice; } catch { hi = mid; continue; }
    if (avg <= limit) lo = mid; else hi = mid;
  }
  return lo;
}

/** Self-check. Exercised before this is trusted, per the rule that a check which
 *  has only ever been seen passing has not been tested. */
export function selftest() {
  const out = [];
  const X = 84538.6413646, P = 0.03169394;

  // 1. depth must not move the spot price -- the mistake this file exists to avoid
  const a = reserves(X, P, 1), b = reserves(X, P, 5);
  const pa = quoteUsd(a, 0.01).avgPrice, pb = quoteUsd(b, 0.01).avgPrice;
  out.push(['depth leaves the spot price alone', Math.abs(pa - pb) / pa < 1e-4, `${pa} vs ${pb}`]);

  // 2. splitting an order must be exactly neutral
  const r = reserves(X, P, 1.45);
  const once = quoteUsd(r, 100).pcn;
  let cur = r, sum = 0;
  for (let i = 0; i < 5; i++) {
    const q = quoteUsd(cur, 20);
    sum += q.pcn;
    cur = { ...q.reservesAfter };
  }
  out.push(['5 x $20 equals one $100', Math.abs(sum - once) < 1e-6, `${sum} vs ${once}`]);

  // 3. bigger orders must pay more per coin
  const small = quoteUsd(r, 20).avgPrice, big = quoteUsd(r, 380).avgPrice;
  out.push(['a larger order pays more per coin', big > small, `${small} -> ${big}`]);

  // 4. usd and pcn directions must agree
  const q1 = quoteUsd(r, 100);
  const q2 = quotePcn(r, q1.pcn);
  out.push(['usd and pcn directions agree', Math.abs(q2.cost - 100) < 1e-6, `${q2.cost} vs 100`]);

  // 5. retiring inventory must RAISE the price (this is retire-on-spend working)
  const before = reserves(X, P, 1.45);
  const after = reserves(X - 1000, P, 1.45);
  // same y, smaller x -> dearer. Rebuild `after` with the ORIGINAL y to model a
  // retirement rather than a re-anchoring.
  const retired = { x: after.x, y: before.y, k: after.x * before.y };
  out.push(['retiring inventory raises the price',
            retired.y / retired.x > before.y / before.x,
            `${before.y / before.x} -> ${retired.y / retired.x}`]);

  return out;
}
