-- orders-payment.sql: what the NOWPayments callback (ipn.mjs) needs in the
-- database, 2026-09-24.
--
-- RUN AS ROOT, ONCE, BEFORE deploying ipn.mjs / server.mjs. The application user
-- has no DDL rights (README "Least privilege"), and the new code reads these
-- columns on every payment callback: without them the callback answers 503 (so
-- NOWPayments retries), /api/buy refuses new orders, and the startup alert says
-- to run this file.
--
--   mysql pcoin_market < /opt/pcoin-market/orders-payment.sql
--
-- SAFE TO RUN AGAIN: IF NOT EXISTS everywhere, and each backfill only fills a
-- NULL. It never changes an order's status, amounts or delivery. The running
-- (old) server.mjs names its columns in every statement, so it keeps working
-- while this is applied.
--
-- The grants need no change: the app user holds SELECT/INSERT/UPDATE/DELETE on
-- pcoin_market.*, which covers new columns.

-- orders.paid_payment_id: THE payment this order belongs to. Written by the
-- statement that takes the order out of the unpaid states (paid, or held for a
-- human), never moved back. UNIQUE: one NOWPayments payment can never pay two
-- orders. (NULLs do not collide, so every unpaid order is fine.)
--
-- orders.invoice_usd: the price the NOWPayments invoice was created for, kept
-- when an underpayment rewrites `usd` to what was paid. NULL means `usd` still
-- is the invoice price.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS invoice_usd DECIMAL(14,2) NULL DEFAULT NULL
    COMMENT 'price the NOWPayments invoice was created for; NULL means usd still is'
    AFTER usd,
  ADD COLUMN IF NOT EXISTS paid_payment_id VARCHAR(64) NULL DEFAULT NULL
    COMMENT 'the NOWPayments payment_id this order is tied to: it paid it, or a human is deciding it'
    AFTER paid_at;

-- ipn_events.outcome / note: what the handler DID with each signed callback
-- (paid, held, needs_human, duplicate, ignored, closed, unknown_order, ...) and
-- why. The Telegram alert can be lost; this row cannot. The admin IPN log shows
-- it, so "which payments are waiting on a human" is a filter, not a memory.
ALTER TABLE ipn_events
  ADD COLUMN IF NOT EXISTS outcome VARCHAR(32) NULL DEFAULT NULL
    COMMENT 'what the IPN handler decided for this callback',
  ADD COLUMN IF NOT EXISTS note TEXT NULL DEFAULT NULL
    COMMENT 'why, in one line';

-- 1. Which payment every already-paid order was paid with. The old handler
--    kept no record of it, but it logged every callback: an order whose money
--    events (confirmed / finished / partially_paid) name exactly one payment
--    was paid by that payment. Orders with more than one (on 2026-09-24 only
--    the two test_completed orders) are left NULL, and ipn.mjs answers them
--    from the event log, conservatively.
UPDATE orders o
  JOIN (SELECT order_id, MIN(payment_id) AS pid
          FROM ipn_events
         WHERE status IN ('confirmed', 'finished', 'partially_paid')
         GROUP BY order_id
        HAVING COUNT(DISTINCT payment_id) = 1) e ON e.order_id = o.order_id
   SET o.paid_payment_id = e.pid
 WHERE o.paid_payment_id IS NULL
   AND o.status NOT IN ('pending', 'expired', 'failed', 'refunded');

-- The index AFTER the backfill. If history ever held one payment_id on two
-- orders (it does not on 2026-09-24: no payment_id names two orders), THIS
-- statement is the one that fails, naming the duplicate, and the backfill above
-- has still recorded everything it could. ipn.mjs enforces the same rule in
-- code; the index is what makes it true even for a writer that forgets.
ALTER TABLE orders ADD UNIQUE INDEX IF NOT EXISTS uq_paid_payment_id (paid_payment_id);

-- 2. The invoice price of an order whose usd a partial payment rewrote to what
--    was paid (on 2026-09-24: Mmte1xvake1040f, invoiced $35.00, usd 33.46).
--    Every other order's usd is still its invoice price, so it stays NULL.
UPDATE orders o
  JOIN (SELECT order_id, MAX(CAST(JSON_VALUE(raw, '$.price_amount') AS DECIMAL(14,2))) AS price
          FROM ipn_events
         WHERE status = 'partially_paid'
         GROUP BY order_id) e ON e.order_id = o.order_id
   SET o.invoice_usd = e.price
 WHERE o.invoice_usd IS NULL
   AND e.price IS NOT NULL
   AND e.price > o.usd;
