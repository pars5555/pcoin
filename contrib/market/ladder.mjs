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
export const ORDER_TTL_HOURS = 24;      // unpaid orders release their inventory

export const toUnits = pcn => Math.round(Number(pcn) * UNITS);
export const fromUnits = u => u / UNITS;

// Retired inventory is withdrawn from sale as surely as sold inventory is, so
// it comes off availability too. Without this the walk would happily sell coins
// that usage has already taken off the ladder, and the CHECK constraint would
// abort a transaction someone had paid for.
const availUnits = r =>
  toUnits(Number(r.qty_total)) - toUnits(Number(r.qty_sold))
  - toUnits(Number(r.qty_reserved)) - toUnits(Number(r.qty_retired ?? 0));

function finish(rungs, fills, gotUnits, cost, usdLeft, pcnShort = 0) {
  // Marginal price AFTER this walk: the first rung still holding stock once
  // these fills are applied.
  const taken = new Map(fills.map(f => [f.rungNo, f.units]));
  let marginalAfter = null;
  for (const r of rungs) {
    if (availUnits(r) - (taken.get(r.rung_no) || 0) > 0) { marginalAfter = Number(r.price); break; }
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
export function walkUsd(rungs, usd) {
  let left = usd, gotUnits = 0, cost = 0;
  const fills = [];
  for (const r of rungs) {
    const price = Number(r.price);
    const avail = availUnits(r);
    if (avail <= 0) continue;
    const want = Math.floor((left / price) * UNITS);
    const take = Math.min(avail, want);
    if (take <= 0) break;
    const c = fromUnits(take) * price;
    fills.push({ rungNo: r.rung_no, units: take, price });
    gotUnits += take; cost += c; left -= c;
  }
  return finish(rungs, fills, gotUnits, cost, left);
}

/** Take `pcn` across the rungs. Pure. This is what the calculator uses. */
export function walkPcn(rungs, pcn) {
  let needUnits = toUnits(pcn), gotUnits = 0, cost = 0;
  const fills = [];
  for (const r of rungs) {
    if (needUnits <= 0) break;
    const price = Number(r.price);
    const avail = availUnits(r);
    if (avail <= 0) continue;
    const take = Math.min(avail, needUnits);
    const c = fromUnits(take) * price;
    fills.push({ rungNo: r.rung_no, units: take, price });
    gotUnits += take; needUnits -= take; cost += c;
  }
  return finish(rungs, fills, gotUnits, cost, 0, fromUnits(needUnits));
}

export function makeLadder(pool) {
  const q = async (sql, args = []) => (await pool.query(sql, args))[0];

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
    return {
      marginalPrice: marg ? Number(marg.price) : null,   // null = inventory gone
      nextFillPrice: next ? Number(next.price) : null,   // what a buyer pays next
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
    const w = walkUsd(rungs, usd);
    // Refuse a partial fill rather than take money for coins that do not exist.
    // A tenth of a cent of rounding dust is not a shortfall.
    if (w.usdUnfilled > 0.001) {
      const e = new Error(
        `the ladder has ${w.pcn.toFixed(2)} PCN left, worth $${w.cost.toFixed(2)} at current rungs. ` +
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
  async function settleLadder(orderId) {
    return moveFills(orderId, 'sold', (c, f) =>
      c.query(`UPDATE ladder_rungs SET qty_sold = qty_sold + ?, qty_reserved = qty_reserved - ?
                WHERE rung_no = ?`, [f.qty, f.qty, f.rung_no]));
  }

  /** reserved -> released. Called when an order fails, expires, or is refunded.
   *  Only ever touches 'reserved' rows, so it can never un-sell a paid order. */
  async function releaseLadder(orderId) {
    return moveFills(orderId, 'released', (c, f) =>
      c.query(`UPDATE ladder_rungs SET qty_reserved = qty_reserved - ? WHERE rung_no = ?`,
              [f.qty, f.rung_no]));
  }

  async function moveFills(orderId, toState, applyRung) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [fills] = await conn.query(
        `SELECT rung_no, qty FROM ladder_fills WHERE order_id = ? AND state = 'reserved' FOR UPDATE`,
        [orderId]);
      for (const f of fills) await applyRung(conn, f);
      await conn.query(
        `UPDATE ladder_fills SET state = ?, settled_at = NOW()
          WHERE order_id = ? AND state = 'reserved'`, [toState, orderId]);
      await conn.commit();
      return fills.length;
    } catch (e) { await conn.rollback(); throw e; }
    finally { conn.release(); }
  }

  /** Abandoned orders must give their inventory back, or the ladder slowly
   *  locks itself up behind invoices nobody ever paid. */
  async function sweepExpiredOrders() {
    try {
      const stale = await q(
        `SELECT order_id FROM orders
          WHERE status = 'pending' AND created_at < (NOW() - INTERVAL ? HOUR)`, [ORDER_TTL_HOURS]);
      for (const o of stale) {
        // Flip the order first, and only if it is STILL pending. If a payment
        // landed in between, the IPN has already moved it and this affects no
        // rows — so we must not release inventory the buyer has now paid for.
        const r = await q(
          `UPDATE orders SET status = 'expired' WHERE order_id = ? AND status = 'pending'`,
          [o.order_id]);
        if (r.affectedRows === 1) {
          const n = await releaseLadder(o.order_id);
          console.log(`[ladder] expired ${o.order_id}, released ${n} rung reservation(s)`);
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
    } catch (e) { console.error('[ladder] sweep failed:', e.message); }
  }

  return { rungsWithStock, ladderState, reserveLadder, settleLadder, releaseLadder,
           sweepExpiredOrders, walkUsd, walkPcn };
}
