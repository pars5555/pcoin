// Per-order divergence waivers.
//
// WHY THIS EXISTS
//
// The ladder deliberately spans 667x in price across 100,000 coins, and the
// divergence guard refuses any order whose AVERAGE fill price runs more than
// maxDivergencePct above the rate the payment services credit PCN at. Together
// those cap a single order at roughly $180 today. That is not a bug and the
// steepness is not worth flattening: the 20% band is mathematically a cap on
// the price RATIO one order may cross -- solving (m-1)/ln m = 1.20 gives
// m = 1.425, about 5.45% of the ladder -- and that figure is IDENTICAL whether
// the ladder has 50 rungs or 1000. Re-cutting the ladder finer buys at most
// ~15% more headroom and then stops. The constraint is the 667x spread itself,
// which is the product.
//
// So the answer to "let me sell more than $180 at once" is not to widen the
// limit for everybody -- that would sell every buyer into the same gap without
// asking them -- but to let ONE buyer, who has been told exactly what it costs
// them, proceed at the ladder's own price.
//
// WHAT A WAIVER IS NOT
//
// It is not a discount. The buyer pays the ladder's price, unchanged. The only
// thing waived is the refusal.
//
// It is not global. maxDivergencePct still governs the SYSTEMIC interlock (the
// no-usd branch of saleGate), and that must never be relaxed: that branch is
// what catches a stuck or wrong price oracle, and selling through a broken
// oracle is the one failure this market cannot undo.
//
// It is one-shot, time-limited, and tied to one email. A waiver that lingers is
// a permanently raised limit wearing a disguise.
//
// WHAT IS RECORDED, AND WHY
//
// The figures the buyer was shown are stored ON the waiver: the average price,
// the service rate at the time, and the resulting loss-on-spend percentage. If
// a buyer later says "nobody told me", the answer is a row, not a memory. This
// is the same reason credited_rate_usd is stamped on a deposit.

export function makeWaivers(pool, { log = console } = {}) {
  const q = async (sql, args = []) => (await pool.query(sql, args))[0];

  async function ensureTable() {
    await q(`CREATE TABLE IF NOT EXISTS order_waivers (
      id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      email           VARCHAR(190) NOT NULL,
      max_usd         DECIMAL(14,2) NOT NULL,
      granted_by      VARCHAR(190) NOT NULL,
      granted_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at      TIMESTAMP NOT NULL,
      used_order_id   VARCHAR(40) NULL,
      used_at         TIMESTAMP NULL,
      revoked_at      TIMESTAMP NULL,
      shown_price     DECIMAL(18,10) NULL,
      shown_rate      DECIMAL(18,10) NULL,
      shown_loss_pct  DECIMAL(8,4) NULL,
      note            TEXT NULL,
      KEY k_email (email),
      KEY k_live (email, expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).catch(e => {
      // Same posture as settings/admin: no DDL rights in production is CORRECT,
      // the table is created by migration. Say so rather than dying.
      log.log('[waivers] no DDL rights, which is correct if the table exists:', e.code || e.message);
    });
  }

  /** The one waiver that would cover this order, or null.
   *
   *  A waiver covers an order when it belongs to that email, has not been used,
   *  revoked or expired, and its ceiling is at least the order. Ordered by the
   *  SMALLEST sufficient ceiling so a large standing waiver is not burned on a
   *  small order. */
  async function find(email, usd) {
    if (!email || !(usd > 0)) return null;
    const rows = await q(
      `SELECT * FROM order_waivers
        WHERE email = ? AND used_order_id IS NULL AND revoked_at IS NULL
          AND expires_at > NOW() AND max_usd >= ?
        ORDER BY max_usd ASC, id ASC LIMIT 1`, [email, usd]);
    return rows[0] || null;
  }

  /** Consume it. Conditional on still being unused, so two orders racing the
   *  same waiver cannot both spend it -- the second UPDATE matches no row. */
  async function consume(id, orderId, conn = null) {
    const run = conn ? (sql, a) => conn.query(sql, a).then(r => r[0]) : q;
    const r = await run(
      `UPDATE order_waivers SET used_order_id = ?, used_at = NOW()
        WHERE id = ? AND used_order_id IS NULL AND revoked_at IS NULL AND expires_at > NOW()`,
      [orderId, id]);
    return (r.affectedRows || 0) === 1;
  }

  async function grant({ email, maxUsd, hours, grantedBy, shownPrice, shownRate, shownLossPct, note }) {
    const r = await q(
      `INSERT INTO order_waivers
         (email, max_usd, granted_by, expires_at, shown_price, shown_rate, shown_loss_pct, note)
       VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? HOUR), ?, ?, ?, ?)`,
      [email, maxUsd, grantedBy, hours, shownPrice ?? null, shownRate ?? null,
       shownLossPct ?? null, note ?? null]);
    return r.insertId;
  }

  async function revoke(id, by) {
    const r = await q(
      `UPDATE order_waivers SET revoked_at = NOW(), note = CONCAT(COALESCE(note,''), ' | revoked by ', ?)
        WHERE id = ? AND used_order_id IS NULL AND revoked_at IS NULL`, [by, id]);
    return (r.affectedRows || 0) === 1;
  }

  /** Everything still live or recently spent, newest first, for the admin list. */
  async function recent(limit = 25) {
    return q(
      `SELECT id, email, max_usd, granted_by, granted_at, expires_at,
              used_order_id, used_at, revoked_at, shown_price, shown_rate, shown_loss_pct, note,
              (used_order_id IS NULL AND revoked_at IS NULL AND expires_at > NOW()) AS live
         FROM order_waivers ORDER BY id DESC LIMIT ?`, [limit]);
  }

  return { ensureTable, find, consume, grant, revoke, recent };
}

/** What this order would cost the buyer if they spend the coins on the
 *  services, as a percentage. This is the number that means something to a
 *  human -- "32% divergence" does not.
 *
 *  avg is what they pay per PCN; rate is what the services credit per PCN. A
 *  buyer paying 0.035840 for coins credited at 0.027090 loses 1 - 0.027090/0.035840
 *  = 24.4% the moment they spend them. Note this is NOT the divergence figure
 *  (32.3%): divergence measures the gap against the rate, this measures it
 *  against what they paid, and the second is the one that leaves their pocket. */
export function lossOnSpendPct(avg, rate) {
  if (!(avg > 0) || !(rate > 0)) return null;
  return (1 - rate / avg) * 100;
}
