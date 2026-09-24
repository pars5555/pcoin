// ═══════════════════════════════════════════════════════════════════════════
// NOWPayments IPN: verify the callback, decide what it is worth, and hand a
// paid order to delivery. server.mjs mounts handle() on POST /ipn.
// ═══════════════════════════════════════════════════════════════════════════
//
// WHY THIS IS ITS OWN FILE. The handler used to live inline in server.mjs,
// which reads /opt/pcoin-market/config.json and opens a listener when it is
// imported, so nothing could run it without production. ipn-test.mjs drives it
// against a throwaway database, with the real ladder.mjs and delivery.mjs and a
// fake wallet in place of the node.
//
// THE POLICY. Every rail on the one NOWPayments account follows the same rules
// since 2026-09-23 (reference: checker.pc.am src/NowPaymentsIpn.php, 3ee728c).
// This rail is the one whose payout cannot be undone: it SENDS PCN on-chain.
// So where the reference credits a balance a human can correct later, this file
// holds the order for a human instead. It is stricter than the reference, never
// looser.
//
//   PAYS OUT (the only way an order reaches 'awaiting_delivery'):
//     'confirmed' with actually_paid >= pay_amount, no tolerance          (R1)
//     'finished'  with actually_paid >= 99.5% of pay_amount               (R2)
//   and only for a payment with no parent (R3), on an order no other payment
//   is tied to (R4), whose price_amount (in whole cents), price_currency and
//   invoice_id match the invoice this market created and recorded (R5).
//
//   GOES TO A HUMAN (order -> 'needs_review', tied to the payment, a Telegram
//   alert, the decision written on the ipn_events row, NOTHING SENT):
//     'partially_paid', or a 'finished' below 99.5%: an underpayment. The order
//         is set to what the money buys at the locked price, so Send (reviewed)
//         releases exactly that (the owner's rule since 2026-08-29). Never
//         released automatically, whatever the size.
//     a 'finished' / 'partially_paid' whose amounts cannot be read. The
//         reference pays an unreadable 'finished'; a payout that cannot be
//         recalled does not.
//     a CHILD payment (parent_payment_id set). NOWPayments sets a child's
//         pay_amount to what arrived, so its ratio always reads 100% and says
//         nothing about the invoice price.
//     a callback that does not match its invoice, or an order that never had
//         its invoice id recorded. Any API key on the shared account can open a
//         $1 invoice under one of our order ids, and its callback is signed with
//         the same secret as ours.
//     a payment on an order whose inventory was already released (UNBACKED).
//
//   TELLS A HUMAN, CHANGES NO ORDER: a money callback for a payment that is not
//   the one the order is tied to (a second payment, a re-used invoice link, a
//   child), a money callback without a payment_id, a payment the UNIQUE index
//   says already belongs to another order, a 'failed' / 'expired' / 'refunded'
//   that does not match the invoice of the pending order it would close.
//
//   DOES NOTHING: a short 'confirmed' (both underpayments measured on the
//   account were already short at 'confirmed' and went 'partially_paid' later),
//   and 'waiting' / 'confirming' / 'sending'.
//
// ONE PAYMENT PER ORDER, ONE ORDER PER PAYMENT: orders.paid_payment_id, UNIQUE.
// The first payment an order accepts, or holds for a human, is written on the
// order by the same statement that moves it out of the unpaid states, and
// nothing moves it back. So
//   - a later callback for THAT payment (the usual 'confirmed' then 'finished',
//     or a retry) is a duplicate, recognised as one before any alert is
//     considered (R6);
//   - a callback for ANY OTHER payment on the order tells a human and pays
//     nothing (R4, R8);
//   - once a human has the order (needs_review, or released by hand), nothing on
//     it is paid automatically again (R8);
//   - one payment can never be tied to two orders: the index refuses it.
// The payout stays keyed on the ORDER in delivery.mjs (the 'sending' claim is
// recorded before the send, the wallet comment is the order id, delivered_txid
// is written once), so the two keys meet: one payment, one order, one send.
//
// ATOMICITY. Accepting a payment settles the ladder and moves the order in ONE
// transaction, rungs locked before the order row, which is the order /api/buy
// takes them in. The old handler moved the order to 'awaiting_delivery' first
// and only afterwards found out the inventory had been released; in between, a
// duplicate callback could hand an UNBACKED order to auto-delivery.
//
// REFUNDS. Nothing here reverses a send (R7). A 'refunded' / 'failed' /
// 'expired' for the payment an order is tied to holds the order if the PCN has
// not left yet, and tells a human either way. Unwinding is a human decision.

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Shortfall a 'finished' payment may carry and still pay the whole order:
 *  gateway rounding on the crypto leg, not wide enough to give coins away. */
export const FINISHED_TOLERANCE = 0.005;

/** Order states that have never been paid, where a payment may still land.
 *  'expired' is here on purpose (a slow chain can confirm after the sweeper
 *  timed the order out, see ladder.mjs ORDER_TTL_HOURS), and 'failed' /
 *  'refunded' are the same shape: another payment on the invoice ended first.
 *  An order whose inventory was released on the way here goes to a human as
 *  UNBACKED, not to delivery. */
export const UNPAID = ['pending', 'expired', 'failed', 'refunded'];

/** The columns this file needs. server.mjs checks them at startup, and refuses
 *  new orders until orders-payment.sql has been run. */
export const REQUIRED_COLUMNS = {
  orders: ['paid_payment_id', 'invoice_usd'],
  ipn_events: ['outcome', 'note'],
};

const esc = s => String(s ?? '').replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ── the body, as bytes ──────────────────────────────────────────────────────

/** The request body as the BYTES that arrived.
 *
 *  server.mjs's body() appends each chunk to a string, which decodes chunk by
 *  chunk: a multi-byte character split across two TCP chunks turns into two
 *  U+FFFD, and an HMAC over the body can then never match what NOWPayments
 *  signed. Every market callback so far has been ASCII, so it never bit; the
 *  signature is now checked over the raw body first, so it would. The bytes are
 *  what is signed, so the bytes are what is kept. */
export function readRawBody(req, limit = 200_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0, settled = false;
    req.on('data', c => {
      if (settled) return;
      const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
      n += b.length;
      if (n > limit) {
        settled = true;
        reject(Object.assign(new Error('body too large'), { code: 'BODY_TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(b);
    });
    req.on('end', () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', e => { if (!settled) { settled = true; reject(e); } });
  });
}

// ── the signature ───────────────────────────────────────────────────────────

/** The form this market verified before 2026-09-24: top-level keys sorted,
 *  each value's SOURCE TEXT kept (the reviver's `context.source`, Node 21+),
 *  so 10.0 stays 10.0. Kept as a fallback so nothing that verified before can
 *  stop verifying. */
function sortedSourceForm(text) {
  const seen = [];
  let root = null;
  JSON.parse(text, function (k, v, ctx) {
    if (this === undefined) return v;
    if (k === '') { root = v; return v; }
    seen.push({ holder: this, key: k,
                src: ctx && ctx.source !== undefined ? ctx.source : JSON.stringify(v) });
    return v;
  });
  if (root === null || typeof root !== 'object' || Array.isArray(root)) return null;
  const raws = new Map();
  for (const e of seen) if (e.holder === root) raws.set(e.key, e.src);
  return '{' + [...raws.keys()].sort().map(k => JSON.stringify(k) + ':' + raws.get(k)).join(',') + '}';
}

/** Parse, sort the top level, JSON.stringify: the estate's shared JS helper's
 *  legacy_stringify (ai_control_server src/lib/nowpayments-sig.js). */
function sortedStringifyForm(text) {
  const d = JSON.parse(text);
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  return JSON.stringify(Object.keys(d).sort().reduce((r, k) => { r[k] = d[k]; return r; }, {}));
}

/** NOWPayments' documented sample: sort EVERY level, JSON.stringify. */
function sortedRecursiveForm(text) {
  const d = JSON.parse(text);
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  const sort = v => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.keys(v).sort().reduce((r, k) => { r[k] = sort(v[k]); return r; }, {})
    : v);
  return JSON.stringify(sort(d));
}

/**
 * Which string, if any, the signature was computed over.
 *
 * RAW FIRST, and raw means the BYTES. Measured 2026-09-23: NOWPayments signs the
 * body exactly as it sends it (20/20 genuine callbacks on checker.pc.am, where
 * the secret could be tried), and all 86 bodies this market ever stored are
 * already in that canonical shape, so the old re-serialised form reproduces
 * them only because they arrive canonical. Each re-serialisation can diverge
 * for a shape not seen yet (a number written with trailing zeros, a nested
 * object with its own key order, a character JSON.stringify writes
 * differently). They stay as fallbacks. Every candidate is a full HMAC-SHA512
 * under the secret, so trying several weakens nothing.
 *
 * @param {Buffer|string} raw
 * @returns {'raw'|'sorted_source'|'sorted_stringify'|'sorted_recursive'|null}
 */
export function signatureVariant(raw, sig, secret) {
  const got = Buffer.from(String(sig ?? '').trim().toLowerCase());
  if (!got.length || !secret) return null;
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(typeof raw === 'string' ? raw : '', 'utf8');
  if (!bytes.length) return null;
  const text = bytes.toString('utf8');
  const forms = [['sorted_source', sortedSourceForm],
                 ['sorted_stringify', sortedStringifyForm],
                 ['sorted_recursive', sortedRecursiveForm]];
  const matches = data => {
    const want = Buffer.from(createHmac('sha512', secret).update(data).digest('hex'));
    return want.length === got.length && timingSafeEqual(want, got);
  };
  if (matches(bytes)) return 'raw';
  const tried = new Set([text]);
  for (const [name, make] of forms) {
    let t;
    try { t = make(text); } catch { t = null; }
    if (t === null || tried.has(t)) continue;
    tried.add(t);
    if (matches(Buffer.from(t, 'utf8'))) return name;
  }
  return null;
}

// ── what a callback is worth ────────────────────────────────────────────────

const DECIMAL_RE = /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?\s*$/;

/** A plain decimal, as a JSON number or a string. Anything else is unreadable. */
export function readNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && DECIMAL_RE.test(v)) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** actually_paid / pay_amount, or null when either is unreadable. NEVER from
 *  actually_paid_at_fiat: the shared policy forbids it (it is 0 on the
 *  account's genuine callbacks, and on this market's one partial it disagreed
 *  with the ratio). */
export function paidRatio(d) {
  const paid = readNumber(d?.actually_paid);
  const due = readNumber(d?.pay_amount);
  if (paid === null || due === null || !(due > 0) || paid < 0) return null;
  return paid / due;
}

/**
 * @returns {{status: string, kind: 'pay'|'underpaid'|'unreadable'|'wait'|'fail', ratio: number|null}}
 */
export function classify(d) {
  const status = String(d?.payment_status ?? '');
  const ratio = paidRatio(d);
  switch (status) {
    case 'failed': case 'expired': case 'refunded':
      return { status, kind: 'fail', ratio };
    case 'partially_paid':
      return { status, kind: ratio === null ? 'unreadable' : 'underpaid', ratio };
    case 'finished':
      if (ratio === null) return { status, kind: 'unreadable', ratio };
      return { status, kind: ratio >= 1 - FINISHED_TOLERANCE ? 'pay' : 'underpaid', ratio };
    case 'confirmed':
      // R1: no tolerance, and an unreadable amount waits -- 'finished' or
      // 'partially_paid' follows.
      return { status, kind: ratio !== null && ratio >= 1 ? 'pay' : 'wait', ratio };
    default:
      return { status, kind: 'wait', ratio };
  }
}

/** The parent's payment_id when this is a CHILD payment, else null.
 *  null, '', 0 and '0' all mean "no parent" (R3). */
export function parentPaymentId(d) {
  const p = d ? d.parent_payment_id : undefined;
  if (p === undefined || p === null || p === '' || p === 0 || p === '0') return null;
  return String(p);
}

/** A dollar amount in whole cents, or null. The toFixed step stops 20.005 * 100
 *  = 2000.4999999999998 from rounding the other way to how MariaDB rounded the
 *  same number into a DECIMAL(14,2). Out-of-range values are not a price. */
export function cents(v) {
  const n = readNumber(v);
  if (n === null || Math.abs(n) >= 1e13) return null;
  return Math.round(Number((n * 100).toFixed(6)));
}

/** The price the NOWPayments invoice was created for. orders.usd IS that price
 *  until an underpayment rewrites it to what was paid; invoice_usd keeps the
 *  original from then on (NULL means usd has not been rewritten). */
export const invoicePrice = order => (order.invoice_usd ?? order.usd);

/**
 * Does this callback belong to THIS order's invoice (R5)? Every genuine
 * callback carries the invoice's USD price and the NOWPayments invoice id (all
 * 81 genuine callbacks this market stored match both).
 *
 * @returns {string|null} why it does not match (a missing field counts), or null
 */
export function invoiceMismatch(d, order) {
  const price = cents(d?.price_amount);
  if (price === null) return `no readable price_amount (${JSON.stringify(d?.price_amount ?? null)})`;
  const ours = cents(invoicePrice(order));
  if (ours === null) return `the order has no readable invoice price (${invoicePrice(order)})`;
  if (price !== ours) return `price_amount ${d.price_amount} vs invoice $${(ours / 100).toFixed(2)}`;
  const cur = d.price_currency;
  if (typeof cur !== 'string' || cur.toLowerCase() !== 'usd') {
    return `price_currency ${cur === undefined ? 'missing' : JSON.stringify(cur)}`;
  }
  // No recorded invoice id is a mismatch, not a pass. /api/buy records it
  // before the buyer is shown the invoice link, so a genuine payment always
  // finds one; an order without one was never shown an invoice at all.
  const iid = order.invoice_id === null || order.invoice_id === undefined ? '' : String(order.invoice_id).trim();
  if (!iid) return 'this order has no recorded invoice id, so no callback can be matched to it';
  const got = d.invoice_id === undefined || d.invoice_id === null ? '' : String(d.invoice_id);
  if (got !== iid) return `invoice_id ${got || 'missing'} vs ${iid}`;
  return null;
}

// ── the handler ─────────────────────────────────────────────────────────────

const ORDER_COLS = `order_id, usd, invoice_usd, address, quoted_pcn, quoted_price, status,
                    invoice_id, paid_amount, pay_currency, paid_at, paid_payment_id,
                    delivered_txid, delivery_mode, delivery_error`;

/**
 * @param {object}   o
 * @param {object}   o.pool      mysql2 pool
 * @param {object}   o.ladder    makeLadder(): settleLadder / releaseLadder(orderId, conn)
 * @param {object}   o.delivery  makeDelivery(): deliver(orderId) -- never throws
 * @param {Function} o.notify    Telegram, the market's PRIVATE alert channel (notify.mjs)
 * @param {Function|string} o.secret  the IPN secret, read at call time
 * @param {Function} [o.onPaid]      (callback) after an order is accepted: announce, fee report
 * @param {Function} [o.onUnderpaid] (callback, paidUsd) after an underpayment is held
 */
export function makeIpn({ pool, ladder, delivery, notify, secret,
                          onPaid = null, onUnderpaid = null, log = console }) {
  const q = async (sql, args = []) => (await pool.query(sql, args))[0];
  const secretNow = () => (typeof secret === 'function' ? secret() : secret) || '';
  const answer = (outcome, note, extra = {}) =>
    ({ http: 200, body: { ok: true, outcome, ...extra }, outcome, note });

  // ── telling a human, once ─────────────────────────────────────────────────
  // Keyed on what makes an alert news: the order, the payment, the reason and
  // the amount it reports. A retry of the same callback, or the operator
  // re-sending it from the NOWPayments dashboard, pages nobody twice; more
  // money arriving on a payment somebody is settling by hand is new, so it
  // pages again. In memory and bounded: a restart costs at most one repeat, and
  // one extra alert is the right way for this to fail. The durable record is
  // the ipn_events row (outcome, note), written for every signed callback.
  const told = new Set();
  function tell(key, text) {
    if (key !== null) {
      if (told.has(key)) return false;
      if (told.size >= 5000) told.clear();
      told.add(key);
    }
    try {
      Promise.resolve(notify(text)).catch(e => log.error('[ipn] alert failed:', e?.message));
    } catch (e) { log.error('[ipn] alert failed:', e?.message); }
    return true;
  }

  const pct = r => (r === null || r === undefined ? 'unknown %' : `${(r * 100).toFixed(2)}%`);
  const paidLine = (d, r) =>
    `paid ${esc(d.actually_paid ?? '?')} of ${esc(d.pay_amount ?? '?')} ` +
    `${esc(String(d.pay_currency ?? '').toUpperCase())} (${pct(r)})`;
  const currency = d => (String(d.pay_currency ?? '').slice(0, 24) || null);
  // DECIMAL(24,8): anything that does not fit is recorded as unknown rather
  // than failing the statement that ties the order.
  const paidValue = d => {
    const n = readNumber(d.actually_paid);
    return n === null || Math.abs(n) >= 1e16 ? null : n;
  };

  /** One transaction on its own connection, retried on a deadlock. The IPN
   *  takes rungs before the order row; the sweeper and the admin's Expire take
   *  them the other way round, so a collision is possible and InnoDB resolves
   *  it by killing one side. A retry is correct because the work is idempotent.
   *
   *  READ COMMITTED, for this transaction only. Production runs MariaDB 11.8
   *  with innodb_snapshot_isolation=ON (its default there): under REPEATABLE
   *  READ, a transaction that locks a row changed since its first read fails
   *  with ER_CHECKREAD ("Record has changed since last read"). settleLadder
   *  reads the order's fills without a lock and then locks the rungs, so every
   *  callback that met another callback, a purchase or the sweeper on the same
   *  rung threw, answered 500 and paged, and the order stayed pending until
   *  NOWPayments retried (measured: 71 of 90 first deliveries in a burst).
   *  Nothing here relies on a snapshot: every decision is taken on a locking
   *  read or a conditional UPDATE, which read the latest committed row at any
   *  isolation level. */
  async function withTx(fn) {
    const conn = await pool.getConnection();
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          await conn.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
          await conn.beginTransaction();
          const out = await fn(conn);
          if (out && out.rollback) { await conn.rollback(); return out.value; }
          await conn.commit();
          return out ? out.value : undefined;
        } catch (e) {
          await conn.rollback().catch(() => {});
          if (attempt < 3 && (e.code === 'ER_LOCK_DEADLOCK' || e.code === 'ER_LOCK_WAIT_TIMEOUT')) continue;
          throw e;
        }
      }
    } finally { conn.release(); }
  }

  async function loadOrder(orderId) {
    if (orderId === null) return null;
    const [o] = await q(`SELECT ${ORDER_COLS} FROM orders WHERE order_id = ?`, [orderId]);
    return o || null;
  }

  /** What the order's inventory looks like, for a human deciding on it. */
  async function inventoryNote(orderId) {
    try {
      const rows = await q(`SELECT state, COUNT(*) AS n FROM ladder_fills WHERE order_id = ? GROUP BY state`, [orderId]);
      if (!rows.length) return 'no ladder reservation on record';
      const by = Object.fromEntries(rows.map(r => [r.state, Number(r.n)]));
      if (by.released && !by.reserved && !by.sold) {
        return '<b>RELEASED</b>: its rungs went back on sale and may have been sold to somebody else';
      }
      return rows.map(r => `${r.n} rung(s) ${r.state}`).join(', ');
    } catch (e) { return `unreadable (${esc(e.message)})`; }
  }

  /** Which payment this order belongs to, or null while it is unpaid.
   *
   *  paid_payment_id answers it for every order this file has touched, and
   *  orders-payment.sql backfilled the orders paid before it existed. The event
   *  log is the fallback for an order paid by the old handler that the backfill
   *  could not settle (one paid between the migration and the deploy, the two
   *  test orders): the first money event on record is the payment it paid.
   *  `ev` bounds the search so that THIS callback, freshly logged, can never
   *  vouch for itself -- a repeat of an earlier callback may. */
  async function tiedPayment(order, ev) {
    if (order.paid_payment_id !== null && order.paid_payment_id !== undefined && order.paid_payment_id !== '') {
      return String(order.paid_payment_id);
    }
    if (UNPAID.includes(order.status)) return null;
    const [first] = await q(
      `SELECT payment_id FROM ipn_events
        WHERE order_id = ? AND status IN ('confirmed','finished','partially_paid')
          AND ${ev.fresh ? 'id < ?' : 'id <= ?'}
        ORDER BY id LIMIT 1`, [order.order_id, ev.id ?? 0]);
    return first ? String(first.payment_id) : '(none on record)';
  }

  /** What an underpayment buys: the owner's rule is "deliver exactly what was
   *  paid for" at the price locked on the order. From the ORIGINAL invoice
   *  price and the ORIGINAL quote (the order's ladder fills, which never
   *  change), so a second partial callback cannot compound on the first. */
  async function releaseFor(order, ratio, base) {
    const price = Number(order.quoted_price);
    const [f] = await q(`SELECT COALESCE(SUM(qty), 0) AS pcn FROM ladder_fills WHERE order_id = ?`, [order.order_id]);
    const quote = Number(f?.pcn) > 0 ? Number(f.pcn) : Number(order.quoted_pcn);
    const b = Number(base);
    if (ratio === null || !(b > 0) || !(price > 0) || !(quote > 0)) return null;
    const r = Math.max(0, Math.min(1, ratio));
    const full = r >= 1 - FINISHED_TOLERANCE;
    const usd = full ? b : b * r;
    const pcn = full ? quote : Math.min(quote, usd / price);
    return { usd: usd.toFixed(2), pcn: pcn.toFixed(8), usdNum: usd, quote, base: b, price, full, ratio: r };
  }

  function partialText(d, c, rel) {
    const head = `PARTIAL PAYMENT (${c.status}): ${d.actually_paid} of ${d.pay_amount} ${d.pay_currency || ''} ` +
                 `(${c.ratio === null ? '?' : ((1 - c.ratio) * 100).toFixed(1) + '% short'}).`;
    return rel
      ? `${head} Set to what was paid: ${rel.pcn} PCN for $${rel.usd} at the locked quote ${rel.price}` +
        ` (the order was ${rel.quote.toFixed(8)} PCN for $${rel.base.toFixed(2)}). Press Send (reviewed) to release it.`
      : `${head} Could not compute a deliverable amount. Held for review.`;
  }

  /** The decision, next to the callback it was made on. First decision wins:
   *  a retry of the same callback is the same event row, and what that row
   *  should say is what the callback DID. Best effort -- the order row and the
   *  alert are the load-bearing records; this one makes them findable. */
  async function record(ev, res) {
    if (!ev || !ev.id || !res || !res.outcome) return;
    try {
      await q(`UPDATE ipn_events SET outcome = ?, note = ? WHERE id = ? AND outcome IS NULL`,
              [String(res.outcome).slice(0, 32), res.note ? String(res.note).slice(0, 2000) : null, ev.id]);
    } catch (e) { log.error('[ipn] could not record the outcome:', e.message); }
  }

  // ── entry point ───────────────────────────────────────────────────────────

  /** @param {Buffer|string} raw  the body exactly as received
   *  @returns {Promise<{http: number, body: object, outcome?: string, note?: string}>} */
  async function handle(raw, sigHeader) {
    if (!signatureVariant(raw, sigHeader, secretNow())) return badSignature(raw, sigHeader);
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);

    let d = null;
    try { d = JSON.parse(text); } catch { /* answered below */ }
    if (!d || typeof d !== 'object' || Array.isArray(d)) {
      return { http: 400, body: { error: 'body must be a JSON object' } };
    }
    const pid = d.payment_id === undefined || d.payment_id === null ? '' : String(d.payment_id);
    const orderId = d.order_id === undefined || d.order_id === null ? null : String(d.order_id);
    const status = String(d.payment_status ?? '');

    // Record the event. UNIQUE(payment_id, status) stops the same callback being
    // LOGGED twice. It must not skip the work: this row is written before any
    // order or ladder change, so if the handler then died, the retry would hit
    // the duplicate key and a paid order would never be applied. Every step
    // below is idempotent, so a repeat simply runs again.
    const ev = { id: null, fresh: true };
    try {
      const r = await q(`INSERT INTO ipn_events (payment_id, order_id, status, raw) VALUES (?,?,?,?)`,
                        [pid, orderId, status, text.slice(0, 60000)]);
      ev.id = r.insertId;
    } catch (e) {
      if (e.code !== 'ER_DUP_ENTRY') throw e;
      ev.fresh = false;
      const [row] = await q(`SELECT id FROM ipn_events WHERE payment_id = ? AND status = ?`, [pid, status]);
      ev.id = row ? row.id : null;
    }

    const res = await decide(d, pid, orderId, ev);
    await record(ev, res);
    return res;
  }

  async function decide(d, pid, orderId, ev) {
    const order = await loadOrder(orderId);
    if (!order) return unknownOrder(d, orderId, pid);

    const c = classify(d);
    if (c.kind === 'fail') return terminal(order, d, c, pid, ev);
    if (c.kind === 'wait') {
      return answer('ignored', c.status === 'confirmed'
        ? `confirmed at ${pct(c.ratio)} of pay_amount: not paid in full, waiting for finished / partially_paid`
        : `status ${c.status || '(none)'}: not money yet`, { status: c.status });
    }

    if (!pid) {
      tell(`nopid|${order.order_id}|${c.status}|${d.actually_paid}`,
        `⚠️ <b>Payment callback without a payment_id</b>\n<code>${esc(order.order_id)}</code> (${esc(c.status)}), ` +
        `${paidLine(d, c.ratio)}\nNothing was done and the order is unchanged: without a payment id the ` +
        `payment cannot be tied to it. Check NOWPayments.`);
      return answer('needs_human', 'money callback without a payment_id; order unchanged', { reason: 'no payment_id' });
    }
    return money(order, d, c, pid, ev, 0);
  }

  // ── a callback that reports money ─────────────────────────────────────────

  async function money(order, d, c, pid, ev, depth) {
    // R6: already this payment's order -- the usual 'confirmed' then
    // 'finished', or a retry. Answered BEFORE any rule that could raise an alert.
    const tied = await tiedPayment(order, ev);
    if (tied === pid) return samePayment(order, d, c, pid, ev);
    if (tied !== null) return otherPayment(order, d, c, pid, tied);

    // One payment, one order. The UNIQUE index on paid_payment_id is what makes
    // this hold under concurrency; this read is the same rule for a database
    // where the index is missing, and the clearer answer when it is not.
    const [elsewhere] = await q(
      `SELECT order_id FROM orders WHERE paid_payment_id = ? AND order_id <> ? LIMIT 1`, [pid, order.order_id]);
    if (elsewhere) return paymentTiedElsewhere(order, d, c, pid);

    // An unpaid order. The most specific thing wrong with the callback is the
    // reason a human is given.
    const parent = parentPaymentId(d);
    const mismatch = invoiceMismatch(d, order);
    let hold = null;
    if (parent) {
      hold = { code: 'CHILD PAYMENT', detail:
        `a child of payment ${parent}. NOWPayments sets a child's pay_amount to what arrived, so its ` +
        `ratio always reads 100% and says nothing about the $${Number(invoicePrice(order)).toFixed(2)} invoice` };
    } else if (mismatch) {
      hold = { code: 'DOES NOT MATCH ITS INVOICE', detail:
        `${mismatch}. Any API key on the shared NOWPayments account can open an invoice under one of ` +
        `our order ids, signed with the same secret` };
    } else if (c.kind === 'unreadable') {
      hold = { code: 'AMOUNT UNREADABLE', detail:
        `status ${c.status} without a readable actually_paid / pay_amount; nothing is guessed` };
    } else if (c.kind === 'underpaid') {
      hold = { code: 'PARTIAL PAYMENT', underpaid: true };
    }
    if (hold) return holdForHuman(order, d, c, pid, ev, hold, depth);
    return accept(order, d, c, pid, ev, depth);
  }

  /** The order moved while this callback was deciding: decide again on what
   *  is there now. Twice at most; the second look always finds it tied. */
  async function afterRace(order, d, c, pid, ev, depth) {
    if (depth >= 2) {
      log.error(`[ipn] ${order.order_id}: still racing after ${depth} re-reads; nothing done for ${pid}`);
      return answer('raced', 'the order kept changing underneath this callback; nothing done');
    }
    const fresh = await loadOrder(order.order_id);
    return fresh ? money(fresh, d, c, pid, ev, depth + 1) : answer('raced', 'the order disappeared');
  }

  /** The UNIQUE index on orders.paid_payment_id refused the tie: this payment
   *  already belongs to another order. One payment never pays two orders. */
  async function paymentTiedElsewhere(order, d, c, pid) {
    let other = '?';
    try {
      const [o] = await q(`SELECT order_id FROM orders WHERE paid_payment_id = ?`, [pid]);
      if (o) other = o.order_id;
    } catch { /* the alert still goes */ }
    tell(`elsewhere|${order.order_id}|${pid}`,
      `🚨 <b>One payment, two orders</b>\nPayment <code>${esc(pid)}</code> (${esc(c.status)}) names order ` +
      `<code>${esc(order.order_id)}</code>, but it already belongs to order <code>${esc(other)}</code>.\n` +
      `<b>Nothing was sent</b> and <code>${esc(order.order_id)}</code> is unchanged. A genuine NOWPayments ` +
      `payment has one order; find out where this callback came from.`);
    return answer('needs_human', `payment ${pid} already belongs to order ${other}; nothing done`,
                  { reason: 'payment already tied to another order' });
  }

  /** Pay it: settle the ladder and accept the order in one transaction, then
   *  hand it to delivery. */
  async function accept(order, d, c, pid, ev, depth) {
    let outcome;
    try {
      outcome = await withTx(async conn => {
        // Rungs first (settleLadder locks them in rung order, then the fills),
        // then the order row: the lock order /api/buy uses.
        const moved = await ladder.settleLadder(order.order_id, conn);
        const [[row]] = await conn.query(
          `SELECT status, paid_payment_id, delivered_txid FROM orders WHERE order_id = ? FOR UPDATE`,
          [order.order_id]);
        if (!row || row.paid_payment_id || row.delivered_txid || !UNPAID.includes(row.status)) {
          return { rollback: true, value: 'raced' };            // undoes the settle too
        }
        let backed = moved > 0;
        if (!backed) {
          const [[s]] = await conn.query(
            `SELECT COUNT(*) AS n FROM ladder_fills WHERE order_id = ? AND state = 'sold' FOR UPDATE`,
            [order.order_id]);
          backed = Number(s.n) > 0;
        }
        // Paid, but no inventory backs it: the reservation was released before
        // the money landed. Straight to a human, never through awaiting_delivery,
        // so no concurrent callback can hand it to delivery in between.
        await conn.query(
          `UPDATE orders SET invoice_usd = COALESCE(invoice_usd, usd), status = ?, paid_payment_id = ?,
                  paid_at = NOW(), paid_amount = ?, pay_currency = ?, delivery_error = ?
            WHERE order_id = ?`,
          [backed ? 'awaiting_delivery' : 'needs_review', pid, paidValue(d), currency(d),
           backed ? null : 'UNBACKED: the ladder reservation was released before the payment confirmed, ' +
                           'so these rungs may already have been sold to someone else',
           order.order_id]);
        return { value: backed ? 'accepted' : 'unbacked' };
      });
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') return paymentTiedElsewhere(order, d, c, pid);
      throw e;
    }

    if (outcome === 'raced') return afterRace(order, d, c, pid, ev, depth);

    if (outcome === 'unbacked') {
      log.error(`[ladder] UNBACKED PAID ORDER ${order.order_id} -- reservation was released before ` +
                `payment confirmed. Marked needs_review. DO NOT DELIVER until someone has decided what ` +
                `this customer is owed.`);
      tell(`unbacked|${order.order_id}|${pid}`,
        `🚨 <b>UNBACKED PAID ORDER — do not deliver yet</b>\n<code>${esc(order.order_id)}</code>\n` +
        `The customer paid (payment <code>${esc(pid)}</code>, ${esc(c.status)}), but the ladder reservation ` +
        `had already been released, so the rungs behind this order may have been sold to somebody else.\n` +
        `Marked <b>needs_review</b>; <b>nothing was sent</b> and nothing will be automatically. Decide what ` +
        `they are owed; Send (reviewed) on the order releases it once.`);
      return answer('held', 'UNBACKED: paid after its inventory was released', { reason: 'UNBACKED' });
    }

    // SAY THANK YOU NOW, NOT WHEN THE COINS GO OUT (owner, 2026-09-14), and
    // report what the sale earned. Both are best effort and cannot throw here.
    if (onPaid) { try { onPaid(d); } catch (e) { log.error('[ipn] onPaid:', e.message); } }

    // Small orders send themselves; larger ones queue and message the operator.
    // deliver() never throws, and claims the order before it spends.
    const r = await delivery.deliver(order.order_id);
    const dv = deliveryOutcome(r);
    return answer('paid', `${c.status} at ${pct(c.ratio)}; delivery: ${dv}`, { delivery: dv });
  }

  const deliveryOutcome = r => (r?.txid ? 'sent' : r?.mode || (r?.already ? 'already' : r?.ok ? 'queued' : 'held'));

  /** Tie the order to this payment and hold it for a human. One conditional
   *  UPDATE: it only moves an order that is still unpaid and untied. */
  async function holdForHuman(order, d, c, pid, ev, hold, depth) {
    let rel = null;
    if (hold.underpaid) rel = await releaseFor(order, c.ratio, invoicePrice(order));
    const why = hold.underpaid ? partialText(d, c, rel) : `${hold.code}: ${hold.detail}.`;

    // invoice_usd first. Left-to-right assignment and MariaDB's
    // SIMULTANEOUS_ASSIGNMENT mode both give it usd's ORIGINAL value here, so
    // the invoice price survives the underpayment rewriting usd.
    const sets = [`invoice_usd = COALESCE(invoice_usd, usd)`, `status = 'needs_review'`,
                  `paid_payment_id = ?`, `paid_at = COALESCE(paid_at, NOW())`, `paid_amount = ?`,
                  `pay_currency = ?`, `delivery_error = ?`];
    const args = [pid, paidValue(d), currency(d), why.slice(0, 2000)];
    if (rel) { sets.push('usd = ?', 'quoted_pcn = ?'); args.push(rel.usd, rel.pcn); }
    let r;
    try {
      r = await q(
        `UPDATE orders SET ${sets.join(', ')}
          WHERE order_id = ? AND paid_payment_id IS NULL AND delivered_txid IS NULL
            AND status IN (${UNPAID.map(() => '?').join(',')})`,
        [...args, order.order_id, ...UNPAID]);
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') return paymentTiedElsewhere(order, d, c, pid);
      throw e;
    }
    if (r.affectedRows !== 1) return afterRace(order, d, c, pid, ev, depth);

    const inv = await inventoryNote(order.order_id);
    const icon = hold.underpaid ? '🟠' : '⚠️';
    tell(`hold|${order.order_id}|${pid}`,
      `${icon} <b>${hold.underpaid ? 'Partial payment — review and send' : 'Payment held for a human — ' + esc(hold.code)}</b>\n` +
      `<code>${esc(order.order_id)}</code> · payment <code>${esc(pid)}</code> (${esc(c.status)})\n` +
      `${paidLine(d, c.ratio)} · invoice $${Number(invoicePrice(order)).toFixed(2)}\n` +
      (hold.underpaid
        ? (rel ? `That buys <b>${rel.pcn} PCN</b> at the locked $${esc(order.quoted_price)} ` +
                 `(was ${rel.quote.toFixed(8)} PCN for $${rel.base.toFixed(2)}).\n`
               : `Could not compute a deliverable amount.\n`)
        : `${esc(hold.detail)}.\n`) +
      `Inventory: ${inv}\n` +
      `<b>Nothing was sent</b>, and nothing on this order will be paid automatically. Open ` +
      `<b>market.pc.am/admin → Orders</b>: Send (reviewed) releases ` +
      `${esc(rel ? rel.pcn : order.quoted_pcn)} PCN once, or refund the payment in NOWPayments.`);

    if (hold.underpaid && rel && onUnderpaid) {
      try { onUnderpaid(d, rel.usdNum); } catch (e) { log.error('[ipn] onUnderpaid:', e.message); }
    }
    return answer('held', why, { reason: hold.code });
  }

  /** A callback for the payment this order is already tied to. */
  async function samePayment(order, d, c, pid, ev) {
    if (order.delivered_txid) return answer('duplicate', 'the PCN for this payment already left');
    if (order.status === 'awaiting_delivery') {
      if (c.kind === 'pay') {
        // Accepted, and delivery never started: the process died between the
        // acceptance commit and deliver(). Finish it -- but only when nobody has
        // touched the order since. delivery_mode is set by every decision
        // delivery makes (sent, queued for a human, stopped on the float), and
        // delivery_error by every failure and by every hold a human released
        // with Send (reviewed). An order a human is handling is the human's: if
        // they send by hand and have not recorded it yet, an automatic send
        // here would pay it twice.
        if (!order.delivery_mode && !order.delivery_error) {
          const r = await delivery.deliver(order.order_id);
          const dv = deliveryOutcome(r);
          return answer('duplicate', `accepted earlier, delivery finished by this callback: ${dv}`, { delivery: dv });
        }
        return answer('duplicate', 'accepted earlier; delivery already decided');
      }
      // The payment this order was accepted on now positively reports LESS:
      // NOWPayments turned a paid-in-full 'confirmed' into a short one. Nothing
      // has left, so hold it before anybody sends the full amount. (An
      // UNREADABLE later amount proves nothing either way and stays a
      // duplicate.)
      if (c.kind === 'underpaid') return contradicted(order, d, c, pid);
      return answer('duplicate', `accepted earlier; this ${c.status} changes nothing`);
    }
    if (order.status === 'needs_review') {
      const paid = readNumber(d.actually_paid);
      const had = readNumber(order.paid_amount);
      // More than the column's own rounding: a repeat must stay silent.
      if (paid !== null && (had === null || paid - had > 1e-8)) return moreMoney(order, d, c, pid);
    }
    return answer('duplicate', `tied to this payment already (order ${order.status})`);
  }

  /** The payment an unsent, accepted order was paid with now reports less than
   *  it was accepted on. Held; a human told. */
  async function contradicted(order, d, c, pid) {
    const why = `NOWPayments now reports this payment ${c.status}: ${d.actually_paid} of ${d.pay_amount} ` +
                `${d.pay_currency || ''} (${pct(c.ratio)}). It was accepted as paid in full; nothing has been sent.`;
    const r = await q(
      `UPDATE orders SET status = 'needs_review', delivery_error = ?
        WHERE order_id = ? AND paid_payment_id = ? AND status = 'awaiting_delivery' AND delivered_txid IS NULL`,
      [why.slice(0, 2000), order.order_id, pid]);
    if (r.affectedRows !== 1) return answer('duplicate', 'the order moved on before it could be held');
    tell(`contradicted|${order.order_id}|${pid}|${c.status}|${d.actually_paid}`,
      `🟠 <b>A paid order's payment now reports less</b>\n<code>${esc(order.order_id)}</code> · payment ` +
      `<code>${esc(pid)}</code> now says ${esc(c.status)}: ${paidLine(d, c.ratio)}.\n` +
      `It was accepted as paid in full and <b>nothing has been sent</b>. Held in <b>needs_review</b>: check the ` +
      `payment in NOWPayments before Send (reviewed).`);
    return answer('held', why, { reason: 'payment now reports less' });
  }

  /** The payment a human is deciding on reports more money than when it was
   *  held: record it, re-work an underpayment's release amount, and say so.
   *  Still held; nothing is sent. */
  async function moreMoney(order, d, c, pid) {
    const partialHold = /^PARTIAL PAYMENT/.test(String(order.delivery_error || ''));
    const base = order.invoice_usd ?? d.price_amount;
    const rel = partialHold ? await releaseFor(order, c.ratio, base) : null;
    const sets = ['paid_amount = ?', 'invoice_usd = COALESCE(invoice_usd, ?)'];
    const args = [readNumber(d.actually_paid), cents(base) === null ? null : (cents(base) / 100).toFixed(2)];
    if (rel) {
      sets.push('usd = ?', 'quoted_pcn = ?', 'delivery_error = ?');
      args.push(rel.usd, rel.pcn, partialText(d, c, rel).slice(0, 2000));
    }
    const r = await q(
      `UPDATE orders SET ${sets.join(', ')}
        WHERE order_id = ? AND paid_payment_id = ? AND status = 'needs_review'
          AND delivered_txid IS NULL AND (paid_amount IS NULL OR paid_amount < ?)`,
      [...args, order.order_id, pid, readNumber(d.actually_paid)]);
    if (r.affectedRows !== 1) return answer('duplicate', 'held already; nothing new');
    tell(`more|${order.order_id}|${pid}|${c.status}|${d.actually_paid}`,
      `🟠 <b>More money on a held payment</b>\n<code>${esc(order.order_id)}</code> · payment ` +
      `<code>${esc(pid)}</code> now reports ${esc(c.status)}: ${paidLine(d, c.ratio)}; it was ` +
      `${esc(order.paid_amount ?? 'unreadable')}.\n` +
      (rel ? `The release amount is now <b>${rel.pcn} PCN</b> for $${rel.usd} (was ${esc(order.quoted_pcn)} PCN).\n`
           : `The order's reason for review is unchanged: ${esc(String(order.delivery_error || '').slice(0, 200))}\n`) +
      `Still held — <b>nothing was sent</b>. Send (reviewed) releases ${esc(rel ? rel.pcn : order.quoted_pcn)} PCN once.`);
    return answer('held', `more money on the held payment: ${d.actually_paid}`, { reason: 'more money on a held payment' });
  }

  /** A money callback for a payment that is NOT the one this order is tied to:
   *  a second payment, a re-used invoice link, a child (R4). Never paid
   *  automatically; the order is not touched.
   *
   *  The market sends once per ORDER, keyed on the order. So the only honest
   *  instructions are "that one send is for whichever payment you decide" and
   *  "refund the other" -- never "send for this one as well", which would be a
   *  second payout nothing here keys or can see. */
  async function otherPayment(order, d, c, pid, tied) {
    const parent = parentPaymentId(d);
    const mismatch = invoiceMismatch(d, order);
    const sent = !!order.delivered_txid;
    tell(`other|${order.order_id}|${pid}|${d.actually_paid}`,
      `⚠️ <b>Another payment on an order that already has one</b>\n` +
      `<code>${esc(order.order_id)}</code> is tied to payment <code>${esc(tied)}</code>; this is ` +
      `payment <code>${esc(pid)}</code> (${esc(c.status)}${parent ? `, a child of ${esc(parent)}` : ''}).\n` +
      `${paidLine(d, c.ratio)} · price $${esc(d.price_amount ?? '?')}` +
      (mismatch ? ` · <b>does not match the invoice</b>: ${esc(mismatch)}` : ' · matches the invoice') + `\n` +
      (sent
        ? `The PCN for this order already went in <code>${esc(order.delivered_txid)}</code>. ` +
          `<b>Nothing was sent for this payment and nothing will be.</b> Refund it in NOWPayments.`
        : `The order is <b>${esc(order.status)}</b> and nothing has been sent for it. The market sends ` +
          `ONCE per order, whichever payment it is for: decide which one this order is delivered for, and ` +
          `refund the other in NOWPayments. Nothing will be sent for this payment automatically.`));
    return answer('needs_human', `another payment on an order tied to ${tied}` +
                  (parent ? ` (child of ${parent})` : '') + '; nothing sent for it',
                  { reason: 'order already tied to another payment' });
  }

  // ── failed / expired / refunded ───────────────────────────────────────────

  async function terminal(order, d, c, pid, ev) {
    const tied = await tiedPayment(order, ev);
    if (tied !== null && !pid) {
      // A paid order, and a failure callback that does not say which payment
      // failed. It cannot be the paying payment's reversal on this evidence,
      // and it cannot be ignored either.
      tell(`nopid-fail|${order.order_id}|${c.status}`,
        `⚠️ <b>A ${esc(c.status)} callback without a payment_id, on a paid order</b>\n` +
        `<code>${esc(order.order_id)}</code> is tied to payment <code>${esc(tied)}</code> and is ` +
        `<b>${esc(order.status)}</b>. Nothing was changed. Check NOWPayments.`);
      return answer('needs_human', `${c.status} without a payment_id on an order tied to ${tied}; nothing changed`);
    }
    if (tied === null) {
      // Never paid. Bookkeeping only: a pending order is closed and its rungs
      // go back on sale, in one transaction. Anything else is left alone: a
      // late 'expired' for an earlier attempt must not overwrite an order a
      // later payment already moved (UNIQUE(payment_id, status) does not stop
      // that -- a different status is a different row).
      if (order.status !== 'pending') {
        log.warn(`[ipn] ${c.status} for ${order.order_id} ignored — the order is '${order.status}', ` +
                 `no longer pending. Inventory left alone.`);
        return answer('ignored', `${c.status} for an order that is ${order.status}, not pending`);
      }
      // R5 for the callbacks that close an order, too. An invoice another API
      // key on the shared account opened under this order id is signed with the
      // same secret; its 'expired' must not give this order's rungs back while
      // the buyer is still paying ours -- their payment would then land
      // UNBACKED. The order stays pending and the sweeper expires it on time.
      const mismatch = invoiceMismatch(d, order);
      if (mismatch) {
        tell(`fail-mismatch|${order.order_id}|${pid}|${c.status}`,
          `⚠️ <b>A ${esc(c.status)} callback that does not match its invoice</b>\n` +
          `<code>${esc(order.order_id)}</code> · payment <code>${esc(pid || '?')}</code>: ${esc(mismatch)}.\n` +
          `The order was left <b>pending</b> and its PCN stays reserved; it expires on its own if nobody ` +
          `pays. Nothing was sent. Find out where this callback came from.`);
        return answer('needs_human', `${c.status} that does not match the invoice (${mismatch}); order left pending`,
                      { reason: 'does not match its invoice' });
      }
      const closed = await withTx(async conn => {
        // Rungs first, then the order: the same order as accept().
        await ladder.releaseLadder(order.order_id, conn);
        const [r] = await conn.query(
          `UPDATE orders SET status = ? WHERE order_id = ? AND status = 'pending' AND paid_payment_id IS NULL`,
          [c.status, order.order_id]);
        return r.affectedRows === 1 ? { value: true } : { rollback: true, value: false };
      });
      return closed ? answer('closed', `order ${c.status}; its rungs went back on sale`)
                    : answer('ignored', `${c.status}: the order moved on first`);
    }
    if (tied === pid) return paidPaymentReversed(order, d, c, pid);
    if (c.status === 'refunded') {
      tell(`refund-other|${order.order_id}|${pid}`,
        `🟡 <b>Refund of another payment on a paid order</b>\n<code>${esc(order.order_id)}</code> is tied ` +
        `to payment <code>${esc(tied)}</code>; NOWPayments refunded payment <code>${esc(pid)}</code>. ` +
        `Nothing on the order was changed.`);
      return answer('noted', `refund of payment ${pid}, not the one the order is tied to (${tied})`);
    }
    return answer('ignored', `${c.status} for payment ${pid}; the order is tied to ${tied}`);
  }

  /** NOWPayments refunded, failed or expired the payment this order is tied to
   *  (R7). Never reversed here. Held if the PCN has not left; a human told
   *  either way. */
  async function paidPaymentReversed(order, d, c, pid) {
    const tag = `${c.status.toUpperCase()} by NOWPayments (payment ${pid})`;
    const advice = c.status === 'refunded'
      ? 'The money went back to the customer. Do not send unless the refund was a mistake.'
      : 'Check this payment in NOWPayments before sending anything.';
    if (!order.delivered_txid && ['awaiting_delivery', 'needs_review'].includes(order.status)) {
      await q(
        `UPDATE orders SET status = 'needs_review',
                delivery_error = LEFT(CONCAT(?, IFNULL(CONCAT(' | before: ', delivery_error), '')), 2000)
          WHERE order_id = ? AND delivered_txid IS NULL AND status IN ('awaiting_delivery','needs_review')
            AND (delivery_error IS NULL OR delivery_error NOT LIKE CONCAT(?, '%'))`,
        [`${tag}. ${advice}`, order.order_id, tag]);
    }
    const now = (await loadOrder(order.order_id)) || order;
    const state = now.delivered_txid
      ? `<b>PCN WAS ALREADY SENT</b> in <code>${esc(now.delivered_txid)}</code>. Nothing was reversed — decide by hand.`
      : now.status === 'sending'
        ? `A send is in flight or unresolved (status <b>sending</b>). Check the hot wallet for a ` +
          `transaction with comment <code>${esc(now.order_id)}</code> before doing anything else.`
        : now.status === 'needs_review'
          ? `Held in <b>needs_review</b>; nothing was sent. ${esc(advice)}`
          : `The order is <b>${esc(now.status)}</b>.`;
    tell(`reversed|${order.order_id}|${pid}|${c.status}`,
      `🔴 <b>NOWPayments ${esc(c.status)} the payment this order was paid with</b>\n` +
      `<code>${esc(order.order_id)}</code> · payment <code>${esc(pid)}</code>\n${state}`);
    return answer('needs_human', `${c.status} of the payment the order is tied to; order now ${now.status}` +
                  (now.delivered_txid ? ', PCN already sent' : ''), { reason: `${c.status} of the paying payment` });
  }

  // ── the two answers that touch no order ───────────────────────────────────

  function unknownOrder(d, orderId, pid) {
    // A SIGNED callback naming an order this database has never heard of:
    // somebody paid for something we have no record of. Answered 200 (a retry
    // cannot help), which is exactly why it must not also be invisible.
    log.error('[ipn] SIGNED callback for an unknown order:', orderId);
    tell(`unknown|${orderId}|${pid}|${d.payment_status}`,
      `🔴 <b>Payment for an unknown order</b>\n<code>${esc(orderId ?? 'null')}</code>\n` +
      `payment <code>${esc(pid || '?')}</code> · status <code>${esc(d.payment_status ?? '?')}</code>\n` +
      `The signature verified, so this is a real callback — but no such order exists ` +
      `here. Somebody may have paid and be waiting with nothing.`);
    return { http: 200, body: { ok: true, note: 'unknown order ignored' },
             outcome: 'unknown_order', note: 'no such order' };
  }

  // The dangerous case is NOT forgery -- a forged callback is refused and costs
  // nothing. It is a WRONG SECRET: unset, mistyped or rotated at NOWPayments,
  // this rejects every GENUINE payment, and the only signal is the absence of
  // a follow-up to the "new order" message. Nothing from the unverified body is
  // echoed (notify posts HTML). Throttled hourly: this endpoint is public and
  // gets scanned.
  let lastSigAlert = 0;
  function badSignature(raw, sigHeader) {
    log.warn('[ipn] REJECTED bad signature');
    if (Date.now() - lastSigAlert >= 60 * 60 * 1000) {
      lastSigAlert = Date.now();
      tell(null, `⚠️ <b>Payment callback rejected: bad signature</b>\n` +
        (secretNow()
          ? `If a real customer just paid, the IPN secret here no longer matches ` +
            `NOWPayments — every genuine payment is being refused. If nobody is ` +
            `waiting, this is just a scanner and can be ignored.`
          : `<b>ipnSecret IS NOT SET — every genuine payment is being rejected.</b>`) +
        `\nbody ${raw?.length ?? 0}B, signature header ${sigHeader ? 'present' : 'absent'}\n` +
        `Further reports suppressed for an hour.`);
    }
    return { http: 401, body: { error: 'bad signature' } };
  }

  // `_internals` is for ipn-test.mjs: it lets a test hand accept() an order
  // read BEFORE a concurrent payment committed, which is the race the
  // re-check inside the transaction exists for and which cannot be timed
  // reliably from outside.
  return { handle, _internals: { accept, holdForHuman, tiedPayment } };
}
