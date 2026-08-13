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

/** Minimal JSON-RPC client for the local node.
 *
 *  TWO CREDENTIALS, DELIBERATELY UNEQUAL.
 *
 *  `rpcAuth` ("user:pass") is the daemon's identity. On the server it is an
 *  `rpcauth=` line whose `rpcwhitelist=` names exactly the seven methods this
 *  file calls. That is the whole point: this process is web-facing — checkout,
 *  the payment IPN, the admin panel — so a remote code execution here must not
 *  be able to ask the node for `listdescriptors`, which would hand over the hot
 *  wallet's xprv and with it every key it will ever derive, nor `dumpprivkey`,
 *  `sethdseed`, `sendall`, `unloadwallet` or `stop`. The node refuses those with
 *  a 403 before this code is consulted, so the restriction survives any bug in
 *  it. Bounding the float bounds the loss; bounding the RPC bounds the reach.
 *
 *  `cookiePath` is the fallback and is FULL POWER — every RPC the node has. It
 *  is root-only on disk, so it is what the human operator tool runs with, and
 *  what a developer gets locally where no rpcauth line exists. The daemon must
 *  never be the process holding it.
 *
 *  Either way the credential is read per call: bitcoind rewrites the cookie on
 *  every restart, and a client that cached it would start failing silently the
 *  first time the node came back. */
export function makeNodeRpc({ url, cookiePath, walletName, rpcAuth = null }) {
  async function rpc(method, params = [], wallet = null) {
    const auth = rpcAuth || readFileSync(cookiePath, 'utf8').trim();
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
    // 1000, not 200: this is the ONLY way a crashed send is ever found again,
    // and a window that silently scrolls past an order turns "already sent"
    // into "send it again".
    const txs = await node.wallet('listtransactions', ['*', 1000, 0, true]);
    // A transaction that was abandoned or conflicted away did NOT pay anyone,
    // so treating it as a delivery would strand the buyer with nothing while
    // the order reads 'delivered'. Core marks these explicitly.
    const hit = (txs || []).find(t =>
      t.comment === orderId && t.category === 'send' &&
      t.abandoned !== true && Number(t.confirmations) > -1);
    return hit ? hit.txid : null;
  }

  /** Did this order already leave the wallet? Three answers, not two.
   *
   *  `unknown` is the one that matters. The header of this file promises
   *  "recovery never retries blind", but every caller that treated a THROWN
   *  lookup as "nothing was sent" broke that promise — the operator Send
   *  buttons most of all, since they exist precisely to re-send. An
   *  unanswerable question must never resolve to the answer that spends money.
   */
  async function alreadySent(orderId) {
    try { return { known: true, txid: await findSentTx(orderId) }; }
    catch (e) { return { known: false, txid: null, why: e.message }; }
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

      // An order that is not awaiting delivery must not be delivered, and must
      // not be ANNOUNCED as awaiting delivery either. Without this test a
      // needs_review order -- one flagged UNBACKED / DO NOT DELIVER, or
      // underpaid -- still produced a cheerful "Manual delivery needed ... Send
      // it, then record it" message, which is an instruction to hand over coins
      // whose rungs may already have been re-sold to somebody else.
      if (order.status !== 'awaiting_delivery') {
        log.warn(`[delivery] ${orderId} is '${order.status}', not awaiting_delivery — refusing`);
        return { ok: false, why: `order is '${order.status}', not awaiting delivery`,
                 status: order.status };
      }

      // Never spend without looking first, and never let "I could not look"
      // read as "nothing was sent".
      const seen = await alreadySent(orderId);
      if (!seen.known) {
        await q(`UPDATE orders SET delivery_error=? WHERE order_id=?`,
                [`could not check the wallet for a previous send: ${seen.why}`.slice(0, 2000), orderId]);
        await notify(`🔴 <b>Delivery held</b>\n<code>${orderId}</code>\n` +
                     `The wallet could not be asked whether this was already sent ` +
                     `(<code>${String(seen.why).slice(0, 160)}</code>).\n` +
                     `Nothing was sent. Retry once the node answers.`);
        return { ok: false, why: `wallet unreadable: ${seen.why}` };
      }
      if (seen.txid) {
        // It already went out; the record simply never caught up.
        await recordSent(orderId, seen.txid);
        log.warn(`[delivery] ${orderId} was already sent in ${seen.txid} — recorded, not resent`);
        return { ok: true, already: true, txid: seen.txid, recovered: true };
      }

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
          `${S.stop()} reserve.\n\n` +
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

  /** Record a send. Guarded on delivered_txid IS NULL: overwriting an existing
   *  txid would erase the evidence of the first payment, which is precisely the
   *  record you need when two have gone out. If it does not match, something
   *  sent twice and a human must see it. */
  async function recordSent(orderId, txid) {
    const r = await q(
      `UPDATE orders SET status='delivered', delivered_txid=?, delivered_at=NOW(),
              delivery_error=NULL
        WHERE order_id=? AND delivered_txid IS NULL`, [txid, orderId]);
    if (r.affectedRows !== 1) {
      const [row] = await q(`SELECT delivered_txid FROM orders WHERE order_id=?`, [orderId]);
      const existing = row?.delivered_txid;
      if (existing && existing !== txid) {
        log.error(`[delivery] DOUBLE SEND on ${orderId}: ${existing} and ${txid}`);
        await notify(`🚨 <b>DOUBLE SEND</b>\n<code>${orderId}</code>\n` +
                     `already recorded <code>${existing}</code>\n` +
                     `and now <code>${txid}</code>\nBoth left the wallet. Investigate now.`);
      }
    }
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

  let lastFloatWarn = 0, lastReconcileWarn = 0;
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
      // The alarm going quiet is not the same as nothing being wrong, and from
      // the outside the two look identical. checkFloat is the ONLY thing
      // watching the hot wallet; if it cannot read the balance, auto-send is
      // almost certainly broken too — and a bitcoind restart alone does it,
      // because the wallet comes back unloaded. Reuse the existing throttle so
      // this cannot outpace the low-float warning it replaces.
      if (Date.now() - lastFloatWarn >= 10 * 60 * 1000) {
        lastFloatWarn = Date.now();
        await notify(
          `🔴 <b>Float unreadable</b>\nThe hot wallet balance could not be read, so the ` +
          `low-balance alarm is BLIND and auto-send is probably down.\n` +
          `<code>${String(e.message).slice(0, 200)}</code>`).catch(() => {});
      }
      return { error: e.message };
    }
  }

  /** Orders stuck mid-send. Resolved from the WALLET, never by resending.
   *  This is the only path that can rescue a crash between claim and record. */
  async function reconcileSending() {
    try {
      // `paid_at IS NULL OR paid_at < …` — the NULL half is not defensive
      // padding. SQL comparisons against NULL are neither true nor false, so a
      // row with no paid_at could never match, and this sweep is the ONLY exit
      // from status='sending' (the admin panel offers no button for that
      // state). Such a row is reachable: a failed or refunded callback moves an
      // order out of 'pending' before paid_at is ever written, and any later
      // path that claims it for sending strands it permanently — a buyer's
      // order frozen forever, invisible to the one thing that looks for frozen
      // orders. NOW() - 5 MIN is a grace period for a send still in flight; an
      // order with no payment time at all has no in-flight window to protect,
      // so it is examined immediately.
      const stuck = await q(
        `SELECT order_id FROM orders
          WHERE status='sending' AND delivered_txid IS NULL
            AND (paid_at IS NULL OR paid_at < (NOW() - INTERVAL 5 MINUTE))`);
      for (const o of stuck) {
        // Per-order, so one order that cannot be resolved does not abort the
        // sweep for every order queued behind it. Previously a single failing
        // findSentTx or UPDATE killed the whole pass, on every tick, forever —
        // the orders behind it would never be looked at again.
        try {
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
        } catch (e) {
          log.error(`[delivery] reconcile failed for ${o.order_id}:`, e.message);
          await notify(`🔴 <b>Could not reconcile a stuck order</b>\n<code>${o.order_id}</code>\n` +
            `It is still <b>sending</b> and the buyer has paid. Nothing was sent by this pass.\n` +
            `<code>${String(e.message).slice(0, 200)}</code>`).catch(() => {});
        }
      }
    } catch (e) {
      log.error('[delivery] reconcile failed:', e.message);
      // reconcileSending is the ONLY exit from status='sending' — the admin
      // panel offers no button for an order in that state. If this sweep is
      // failing persistently (listtransactions off the RPC whitelist, wallet
      // unloaded, stale cookie), buyers who have paid are frozen indefinitely
      // and nothing anywhere says so.
      if (Date.now() - lastReconcileWarn >= 30 * 60 * 1000) {
        lastReconcileWarn = Date.now();
        await notify(`🔴 <b>Reconcile sweep FAILED</b>\nStuck sends were not examined this pass. ` +
          `Orders may be frozen in <b>sending</b> with the buyer already paid.\n` +
          `<code>${String(e.message).slice(0, 250)}</code>`).catch(() => {});
      }
    }
  }

  return { deliver, deliverForce: id => deliver(id, { force: true }),
           markDelivered, pendingDeliveries, checkFloat, reconcileSending,
           floatBalance, receiveAddress, findSentTx, alreadySent, isAuto };
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
                              floatBalance = null, notify = null, log = console }) {
  const q = async (sql, args = []) => (await pool.query(sql, args))[0];
  let cache = { pcn: null, at: 0 };

  // This module decides whether the market may sell AT ALL, and it was built
  // without a notifier — so every way it can fail ended at a log line on a box
  // nobody watches. The failures are not exotic: the explorer 500s, one backing
  // address stops resolving, the node is restarting. Any of them pauses sales,
  // the site starts answering 503 to paying customers, and the first signal is
  // a human noticing the takings stopped.
  //
  // Throttled per kind, because these repeat every request while broken. An
  // alert that fires forty times an hour is one the reader learns to swipe away.
  const lastAlert = new Map();
  async function alert(kind, build, everyMs = 30 * 60 * 1000) {
    if (!notify) return;
    const now = Date.now();
    if (lastAlert.size > 200) lastAlert.clear();
    if (now - (lastAlert.get(kind) || 0) < everyMs) return;
    lastAlert.set(kind, now);
    try { await notify(build()); } catch (e) { log.warn('[backing] alert failed:', e.message); }
  }
  /** Say it once when it breaks and once when it comes back, not on every poll. */
  function clearAlert(kind) { lastAlert.delete(kind); }

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
    // A number you set beats a number the server infers. With a cap configured
    // the explorer is not consulted at all: no address list to maintain, no
    // change addresses to chase, nothing to go stale behind your back. The
    // trade is that it does not fall on its own if you spend the coins
    // elsewhere -- which is why it is YOUR number to keep honest.
    const cap = settings ? Number(settings.get('backingCapPcn')) : 0;
    if (cap > 0) return { pcn: cap, ageMs: 0, manual: true };

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
        try {
          v += Number(await floatBalance()) || 0;
          clearAlert('float');
        } catch (e) {
          log.warn('[backing] hot wallet unreadable, excluded from backing:', e.message);
          // Not fatal to the reading, but it silently SHRINKS the backing by the
          // whole float, so the market starts refusing orders it could fill.
          await alert('float', () =>
            `🟠 <b>Hot wallet unreadable</b>\nThe float is being excluded from the backing ` +
            `total, so the market will refuse orders it could actually fill.\n` +
            `<code>${String(e.message).slice(0, 200)}</code>`);
        }
      }
      cache = { pcn: v, at: Date.now() };
      clearAlert('read');
      clearAlert('expired');
      return { pcn: v, ageMs: 0, addresses: addrs.length };
    } catch (e) {
      if (cache.pcn !== null && Date.now() - cache.at < OWNER_BAL_MAX_AGE_MS) {
        // Selling continues on a cached number. That is the intended behaviour,
        // but it is a decision to keep taking money on a figure nobody can
        // currently confirm, and it must not be the one branch here that is
        // completely silent — its two neighbours both at least log.
        await alert('read', () =>
          `🟠 <b>Backing read failing</b>\nSelling is continuing on a cached figure ` +
          `(${Math.round((Date.now() - cache.at) / 1000)}s old, limit ` +
          `${Math.round(OWNER_BAL_MAX_AGE_MS / 60000)} min). When it expires, <b>sales stop</b>.\n` +
          `<code>${String(e.message).slice(0, 200)}</code>`);
        return { pcn: cache.pcn, ageMs: Date.now() - cache.at, degraded: e.message };
      }
      log.warn('[backing] owner balance unreadable and the cache has expired:', e.message);
      // This one actually stops the market. It is the single most important
      // alert in the file: the site is now answering 503 to every buyer.
      await alert('expired', () =>
        `🔴 <b>SALES STOPPED</b>\nThe coin supply backing sales cannot be confirmed and the ` +
        `cached reading has expired, so market.pc.am is refusing every order.\n` +
        `<code>${String(e.message).slice(0, 200)}</code>\n` +
        `Check the explorer and the node; this clears itself once a reading succeeds.`,
        10 * 60 * 1000);
      return { pcn: null, error: e.message };
    }
  }

  /** PCN already sold and not yet in the buyer's hands. Includes 'pending'
   *  because an unpaid order is still a live promise until it expires.
   *
   *  `lock` is not optional garnish when this is called inside a transaction
   *  that is about to sell against the answer. InnoDB's default REPEATABLE READ
   *  serves a plain SELECT from the snapshot taken at the transaction's FIRST
   *  read — which, in the buy path, is back inside reserveLadder. So an
   *  unlocked read here does not mean "what is owed now"; it means "what was
   *  owed when this transaction started", and an order committed in between is
   *  invisible. Two buyers could each be told the coins were free.
   *
   *  A locking read is exempt from that: it sees the latest committed row and
   *  takes gap locks that block a concurrent INSERT into the range. Today the
   *  rung locks in reserveLadder happen to serialise every buyer, so the
   *  unlocked read was correct by accident — narrowing that lock to only the
   *  rungs being filled, an obvious future optimisation, would silently
   *  reintroduce the oversell. Correct by construction beats correct by luck. */
  async function outstandingOwed(conn = pool, lock = false) {
    const [r] = await conn.query(
      `SELECT COALESCE(SUM(quoted_pcn),0) AS owed FROM orders
        WHERE status IN ('pending','awaiting_delivery','sending','needs_review')` +
      (lock ? ' FOR UPDATE' : ''));
    return Number(r[0].owed);
  }

  /** How much more PCN may be sold right now. null = unknown, which must be
   *  treated as "do not sell", never as "unlimited". */
  async function headroomPcn(conn = pool) {
    const bal = await ownerSpendable();
    if (bal.pcn === null) return { pcn: null, error: bal.error };
    const owed = await outstandingOwed(conn);
    return { pcn: Math.max(0, bal.pcn - owed), ownerPcn: bal.pcn, owed,
             ageMs: bal.ageMs, degraded: bal.degraded, manual: !!bal.manual };
  }

  return { ownerSpendable, outstandingOwed, headroomPcn };
}
