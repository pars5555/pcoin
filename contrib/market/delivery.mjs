// ═══════════════════════════════════════════════════════════════════════════
// Delivery — getting the PCN to the buyer once their payment has confirmed.
// ═══════════════════════════════════════════════════════════════════════════
//
// This is the only code in the PCoin estate that can SPEND. Everything else is
// watch-only, and its worst bug fails to credit somebody; this one's worst bug
// sends coins to a stranger, or sends them twice, and nothing brings them back.
//
// THE SHAPE
//   order <= AUTO_MAX_USD   -> the server signs and sends from a small hot
//                              wallet, usually within a minute
//   order >  AUTO_MAX_USD   -> the server sends NOTHING. It queues the order,
//                              messages the operator on Telegram, and a human
//                              sends from a wallet that has never been online
//
// So the money a break-in on this box can reach is bounded by the float, not by
// the business. That is the whole reason for the split.
//
// THE RULE THAT MATTERS: NEVER SEND TWICE.
// A double send is unrecoverable, so no step here is optimistic:
//   1. An order is CLAIMED with a conditional UPDATE. Exactly one caller can win
//      that row; everyone else sees affectedRows = 0 and stops.
//   2. The send carries the order id as its wallet comment, so if this process
//      dies between "claimed" and "recorded" the transaction can be FOUND again
//      rather than guessed at.
//   3. Recovery never retries blind. If a claimed order has no recorded txid,
//      the wallet is searched for that comment: found means record it, not
//      found means the send never happened and the order is handed back. An
//      order whose fate cannot be established is escalated to a human, never
//      resent.

import { readFileSync } from 'node:fs';

export const AUTO_MAX_USD   = 25;      // at or below this, the server sends
export const FLOAT_TARGET   = 30000;   // PCN — top the hot wallet up to here
export const FLOAT_WARN     = 24000;   // PCN — below this, nag every 10 minutes
export const FLOAT_STOP     = 1000;    // PCN — below this, stop sending entirely
export const OWNER_BAL_MAX_AGE_MS = 30 * 60 * 1000;   // stop selling past this

/** Minimal JSON-RPC client for the local node, using cookie auth.
 *  Reads the cookie per call: bitcoind rewrites it on every restart, and a
 *  client that cached it would start failing silently after a node restart. */
export function makeNodeRpc({ url, cookiePath, walletName }) {
  async function rpc(method, params = [], wallet = null) {
    const auth = readFileSync(cookiePath, 'utf8').trim();
    const endpoint = wallet ? `${url}/wallet/${encodeURIComponent(wallet)}` : url;
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Basic ' + Buffer.from(auth).toString('base64'),
      },
      body: JSON.stringify({ jsonrpc: '1.0', id: 'market', method, params }),
      signal: AbortSignal.timeout(30000),
    });
    const text = await r.text();
    let j;
    try { j = JSON.parse(text); }
    catch { throw new Error(`node returned non-JSON (HTTP ${r.status}): ${text.slice(0, 200)}`); }
    if (j.error) {
      const e = new Error(j.error.message || 'rpc error');
      e.rpcCode = j.error.code;
      throw e;
    }
    return j.result;
  }
  return {
    rpc,
    wallet: (method, params = []) => rpc(method, params, walletName),
  };
}

export function makeDelivery({ pool, node, notify, settings = null, log = console }) {
  const q = async (sql, args = []) => (await pool.query(sql, args))[0];
  // Limits are live settings when a store is wired in, and the module constants
  // otherwise. The constants stay meaningful: they are what a fresh install
  // does before anyone has touched the panel.
  const S = {
    autoMaxUsd: () => settings ? settings.get("autoMaxUsd")   : AUTO_MAX_USD,
    target:     () => settings ? settings.get("floatTargetPcn") : FLOAT_TARGET,
    warn:       () => settings ? settings.get("floatWarnPcn")   : FLOAT_WARN,
    stop:       () => settings ? settings.get("floatStopPcn")   : FLOAT_STOP,
  };

  // ── the hot wallet ───────────────────────────────────────────────────────

  /** Spendable PCN in the float. `trusted` only: untrusted_pending is change
   *  from our own unconfirmed sends and coins nobody has confirmed yet, and
   *  spending against either is how a wallet talks itself into an overdraft. */
  async function floatBalance() {
    const b = await node.wallet('getbalances');
    return Number(b?.mine?.trusted ?? 0);
  }

  /** Has this order already been paid out? Answered from the WALLET, not from
   *  our own bookkeeping, because the question that matters after a crash is
   *  "did a transaction leave", and only the wallet knows that. */
  async function findSentTx(orderId) {
    // 200 is far more than a day of orders at any plausible volume, and the
    // window only has to cover the gap between a claim and its record.
    const txs = await node.wallet('listtransactions', ['*', 200, 0, true]);
    const hit = (txs || []).find(t => t.comment === orderId && t.category === 'send');
    return hit ? hit.txid : null;
  }

  // ── deciding ─────────────────────────────────────────────────────────────

  const isAuto = usdValue => S.autoMaxUsd() > 0 && Number(usdValue) <= S.autoMaxUsd();

  /** Called once, when a payment confirms. Returns what happened, for the log.
   *
   *  Never throws into the IPN handler: NOWPayments retries anything that is
   *  not a 200, and a retry storm on a payment we have already recorded is the
   *  last thing this path needs. Failures become an operator message. */
  async function deliver(orderId, { force = false } = {}) {
    try {
      const [order] = await q(
        `SELECT order_id, email, usd, address, quoted_pcn, status, delivered_txid
           FROM orders WHERE order_id = ?`, [orderId]);
      if (!order) return { ok: false, why: 'unknown order' };
      if (order.delivered_txid) return { ok: true, already: true, txid: order.delivered_txid };

      const pcn = Number(order.quoted_pcn);
      const usd = Number(order.usd);

      // `force` is the operator saying "send this one from the hot wallet
      // anyway". It skips the size rule, never the float floor, never the
      // claim, and never the double-send checks.
      if (!force && !isAuto(usd)) {
        await q(`UPDATE orders SET delivery_mode='manual'
                  WHERE order_id=? AND delivery_mode IS NULL`, [orderId]);
        await notify(
          `🟠 <b>Manual delivery needed</b>\n` +
          `<code>${orderId}</code>\n` +
          `$${usd.toFixed(2)} → <b>${pcn.toFixed(8)} PCN</b>\n` +
          `to <code>${order.address}</code>\n\n` +
          `Above the $${S.autoMaxUsd()} auto limit, so nothing was sent.\n` +
          `Send it, then record it:\n` +
          `<code>market-deliver ${orderId} &lt;txid&gt;</code>`);
        return { ok: true, mode: 'manual' };
      }

      // ---- automatic ----
      const bal = await floatBalance();
      if (bal - pcn < S.stop()) {
        // Refuse rather than half-send. Falling back to the queue is always
        // safe; a failed send that already broadcast is not.
        await q(`UPDATE orders SET delivery_mode='manual',
                        delivery_error=? WHERE order_id=?`,
                [`float too low: ${bal.toFixed(8)} PCN, need ${pcn.toFixed(8)} + ${S.stop()} reserve`,
                 orderId]);
        await notify(
          `🔴 <b>Auto-send skipped — float too low</b>\n` +
          `<code>${orderId}</code>  $${usd.toFixed(2)} → <b>${pcn.toFixed(8)} PCN</b>\n` +
          `to <code>${order.address}</code>\n` +
          `Hot wallet holds ${bal.toFixed(2)} PCN; this needs ${pcn.toFixed(2)} plus a ` +
          `${FLOAT_STOP} reserve.\n\n` +
          `Top up <code>${await receiveAddress()}</code> to ${S.target()} PCN, ` +
          `or send this one by hand:\n<code>market-deliver ${orderId} &lt;txid&gt;</code>`);
        return { ok: true, mode: 'manual', why: 'float too low' };
      }

      // CLAIM. One winner; a concurrent caller gets 0 rows and stops. The
      // 'sending' state is what makes a crash detectable afterwards.
      const claim = await q(
        `UPDATE orders SET status='sending', delivery_mode='auto'
          WHERE order_id=? AND status='awaiting_delivery' AND delivered_txid IS NULL`,
        [orderId]);
      if (claim.affectedRows !== 1) {
        return { ok: true, already: true, why: 'another worker owns this order' };
      }

      let txid;
      try {
        // The comment is the idempotency key. It is what lets a crashed send be
        // found instead of repeated.
        txid = await node.wallet('sendtoaddress', [
          order.address,          // to
          Number(pcn.toFixed(8)), // amount
          orderId,                // comment  <- the recovery handle
          '',                     // comment_to
          false,                  // subtractfeefromamount: the buyer gets the full quote
        ]);
      } catch (e) {
        // The send may or may not have gone out — an RPC timeout says nothing
        // about whether the node broadcast it. Look before concluding.
        const found = await findSentTx(orderId).catch(() => null);
        if (found) {
          await recordSent(orderId, found);
          await notify(`🟢 <b>Sent</b> (recovered after an RPC error)\n<code>${orderId}</code>\n` +
                       `<code>${found}</code>`);
          return { ok: true, mode: 'auto', txid: found, recovered: true };
        }
        await q(`UPDATE orders SET status='needs_review', delivery_error=? WHERE order_id=?`,
                [String(e.message).slice(0, 2000), orderId]);
        await notify(
          `🔴 <b>Auto-send FAILED</b>\n<code>${orderId}</code>\n` +
          `$${usd.toFixed(2)} → ${pcn.toFixed(8)} PCN to <code>${order.address}</code>\n` +
          `<code>${String(e.message).slice(0, 300)}</code>\n\n` +
          `No transaction was found for this order, so nothing was sent. ` +
          `Marked <b>needs_review</b> — check before sending by hand.`);
        return { ok: false, why: e.message };
      }

      await recordSent(orderId, txid);
      await notify(
        `🟢 <b>Sent automatically</b>\n<code>${orderId}</code>\n` +
        `$${usd.toFixed(2)} → <b>${pcn.toFixed(8)} PCN</b>\n` +
        `to <code>${order.address}</code>\n` +
        `<code>${txid}</code>`);
      await checkFloat();
      return { ok: true, mode: 'auto', txid };
    } catch (e) {
      log.error('[delivery] unexpected failure:', e.message);
      try {
        await notify(`🔴 <b>Delivery crashed</b> for <code>${orderId}</code>\n` +
                     `<code>${String(e.message).slice(0, 300)}</code>`);
      } catch {}
      return { ok: false, why: e.message };
    }
  }

  async function recordSent(orderId, txid) {
    await q(`UPDATE orders SET status='delivered', delivered_txid=?, delivered_at=NOW(),
                    delivery_error=NULL WHERE order_id=?`, [txid, orderId]);
  }

  async function receiveAddress() {
    try { return await node.wallet('getnewaddress', ['float', 'bech32']); }
    catch { return '(could not reach the node)'; }
  }

  // ── the operator's side ──────────────────────────────────────────────────

  /** Record a delivery the operator made by hand. Refuses to overwrite one that
   *  is already recorded — that would hide a double payment rather than reveal
   *  it. */
  async function markDelivered(orderId, txid) {
    if (!/^[0-9a-f]{64}$/i.test(String(txid))) throw new Error('that is not a txid');
    const [order] = await q(
      `SELECT status, delivered_txid, quoted_pcn, address FROM orders WHERE order_id=?`, [orderId]);
    if (!order) throw new Error(`no such order: ${orderId}`);
    if (order.delivered_txid) {
      throw new Error(`already recorded as delivered in ${order.delivered_txid} — ` +
                      `if that is wrong, fix it in the database deliberately`);
    }
    const r = await q(
      `UPDATE orders SET status='delivered', delivered_txid=?, delivered_at=NOW(),
              delivery_mode=COALESCE(delivery_mode,'manual'), delivery_error=NULL
        WHERE order_id=? AND delivered_txid IS NULL`, [txid, orderId]);
    if (r.affectedRows !== 1) throw new Error('another writer recorded this first');
    await notify(`✅ <b>Marked delivered by hand</b>\n<code>${orderId}</code>\n<code>${txid}</code>`);
    return { ok: true };
  }

  async function pendingDeliveries() {
    return q(
      `SELECT order_id, email, usd, quoted_pcn, address, status, delivery_mode,
              delivery_error, created_at, paid_at
         FROM orders
        WHERE status IN ('awaiting_delivery','sending','needs_review')
        ORDER BY paid_at IS NULL, paid_at ASC, created_at ASC`);
  }

  // ── monitors ─────────────────────────────────────────────────────────────

  let lastFloatWarn = 0;
  async function checkFloat() {
    try {
      const bal = await floatBalance();
      if (bal >= S.warn()) return { bal, warned: false };
      // Every 10 minutes, not every check: the same message on every order
      // would train the reader to ignore it.
      if (Date.now() - lastFloatWarn < 10 * 60 * 1000) return { bal, warned: false };
      lastFloatWarn = Date.now();
      const addr = await receiveAddress();
      await notify(
        `🟡 <b>Hot wallet is low</b>\n` +
        `Holds <b>${bal.toFixed(2)} PCN</b>, warning level ${S.warn()}.\n` +
        `Auto-send stops below ${S.stop()}.\n\n` +
        `Top up to ${S.target()} PCN:\n<code>${addr}</code>`);
      return { bal, warned: true };
    } catch (e) {
      log.warn('[delivery] float check failed:', e.message);
      return { error: e.message };
    }
  }

  /** Orders stuck mid-send. Resolved from the WALLET, never by resending.
   *  This is the only path that can rescue a crash between claim and record. */
  async function reconcileSending() {
    try {
      const stuck = await q(
        `SELECT order_id FROM orders
          WHERE status='sending' AND delivered_txid IS NULL
            AND paid_at < (NOW() - INTERVAL 5 MINUTE)`);
      for (const o of stuck) {
        const txid = await findSentTx(o.order_id);
        if (txid) {
          await recordSent(o.order_id, txid);
          await notify(`🟢 <b>Recovered a stuck send</b>\n<code>${o.order_id}</code>\n` +
                       `<code>${txid}</code>`);
        } else {
          // Nothing left the wallet. Hand it back so it can be dealt with --
          // deliberately NOT an automatic resend, because "I could not find it"
          // is not the same as "it did not happen".
          await q(`UPDATE orders SET status='needs_review',
                          delivery_error='claimed for sending but no transaction was found'
                    WHERE order_id=? AND status='sending'`, [o.order_id]);
          await notify(`🔴 <b>Stuck send, no transaction found</b>\n<code>${o.order_id}</code>\n` +
                       `Marked <b>needs_review</b>. Check the wallet before sending anything.`);
        }
      }
    } catch (e) { log.error('[delivery] reconcile failed:', e.message); }
  }

  return { deliver, deliverForce: id => deliver(id, { force: true }),
           markDelivered, pendingDeliveries, checkFloat, reconcileSending,
           floatBalance, receiveAddress, findSentTx, isAuto };
}

// ── how much we can promise ────────────────────────────────────────────────
//
// The market must never sell more PCN than the owner can actually hand over.
// The backing is the owner's own wallet, read from the explorer; the claim
// against it is every order already sold and not yet delivered.
//
// A balance read that FAILS resolves nothing. The last good reading is still a
// real fact -- a wallet does not empty by surprise -- so it stands for
// OWNER_BAL_MAX_AGE_MS. Past that it is a guess, and the market stops selling
// rather than promise coins nobody has confirmed exist.
export function makeBacking({ pool, explorerUrl, ownerAddress, settings = null,
                              floatBalance = null, log = console }) {
  const q = async (sql, args = []) => (await pool.query(sql, args))[0];
  let cache = { pcn: null, at: 0 };

  /** Every address whose coins we can actually hand over.
   *
   *  A LIST, not one address, and that distinction is not theoretical: funding
   *  the hot wallet with 30,000 PCN spent 112,402 PCN of inputs from the payout
   *  address and sent 82,452 back as CHANGE — to a different address. Watching
   *  the one address showed the backing collapsing by 92%, when nothing had
   *  actually left the owner's control. Every spend creates a new change
   *  address, so this list needs maintaining; that is the cost of the accuracy.
   */
  function addressList() {
    const raw = settings ? settings.get('backingAddresses') : '';
    const items = String(raw || '').split(/[\s,;]+/).map(x => x.trim()).filter(Boolean);
    if (!items.length && ownerAddress) return [ownerAddress];
    return items;
  }

  async function addressBalance(addr) {
    const r = await fetch(`${explorerUrl}/api/address/${addr}`,
                          { signal: AbortSignal.timeout(12000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const v = Number(j?.balance?.confirmed?.spendable_pcn);
    if (!isFinite(v) || v < 0) throw new Error(`no usable spendable_pcn for ${addr}`);
    return v;
  }

  async function ownerSpendable() {
    try {
      const addrs = addressList();
      if (!addrs.length) throw new Error('no backing addresses configured');
      // Every address must answer. A partial sum is an UNDERSTATEMENT of what we
      // can deliver, which would quietly refuse legitimate orders -- so a single
      // unreadable address fails the whole reading rather than shrinking it.
      const parts = await Promise.all(addrs.map(addressBalance));
      let v = parts.reduce((a, b) => a + b, 0);
      // The hot wallet holds deliverable coins too. Leaving it out understates
      // the backing by exactly the float.
      if (floatBalance) {
        try { v += Number(await floatBalance()) || 0; }
        catch (e) { log.warn('[backing] hot wallet unreadable, excluded from backing:', e.message); }
      }
      cache = { pcn: v, at: Date.now() };
      return { pcn: v, ageMs: 0, addresses: addrs.length };
    } catch (e) {
      if (cache.pcn !== null && Date.now() - cache.at < OWNER_BAL_MAX_AGE_MS) {
        return { pcn: cache.pcn, ageMs: Date.now() - cache.at, degraded: e.message };
      }
      log.warn('[backing] owner balance unreadable and the cache has expired:', e.message);
      return { pcn: null, error: e.message };
    }
  }

  /** PCN already sold and not yet in the buyer's hands. Includes 'pending'
   *  because an unpaid order is still a live promise until it expires. */
  async function outstandingOwed(conn = pool) {
    const [r] = await conn.query(
      `SELECT COALESCE(SUM(quoted_pcn),0) AS owed FROM orders
        WHERE status IN ('pending','awaiting_delivery','sending','needs_review')`);
    return Number(r[0].owed);
  }

  /** How much more PCN may be sold right now. null = unknown, which must be
   *  treated as "do not sell", never as "unlimited". */
  async function headroomPcn(conn = pool) {
    const bal = await ownerSpendable();
    if (bal.pcn === null) return { pcn: null, error: bal.error };
    const owed = await outstandingOwed(conn);
    return { pcn: Math.max(0, bal.pcn - owed), ownerPcn: bal.pcn, owed,
             ageMs: bal.ageMs, degraded: bal.degraded };
  }

  return { ownerSpendable, outstandingOwed, headroomPcn };
}
