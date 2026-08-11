#!/usr/bin/env node
// Operator tool for market.pc.am deliveries. Runs on the host, as root.
//
//   market-admin list                     what is waiting to be delivered
//   market-admin float                    hot wallet balance + funding address
//   market-admin backing                  how much more PCN can be sold
//   market-admin deliver <order> <txid>   record a delivery you made by hand
//   market-admin send <order>             send it from the HOT wallet now
//
// `deliver` records; `send` spends. They are separate verbs on purpose: the one
// that moves money should never be the one you reach for by muscle memory.

import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import { makeNodeRpc, makeDelivery, makeBacking, AUTO_MAX_USD, FLOAT_TARGET, FLOAT_WARN, FLOAT_STOP }
  from '/opt/pcoin-market/delivery.mjs';
import { makeNotifier, readNotifyConfig } from '/opt/pcoin-market/notify.mjs';

const cfg = JSON.parse(readFileSync('/opt/pcoin-market/config.json', 'utf8'));
const pool = mysql.createPool({ ...cfg.db, connectionLimit: 4, decimalNumbers: false });

const alertCfg = readNotifyConfig('/etc/pcoin/alert.conf');
const notify = makeNotifier({
  token: alertCfg.TELEGRAM_TOKEN,
  chatId: cfg.telegramChatId || alertCfg.MARKET_CHAT || alertCfg.ALERT_CHAT,
  prefix: '<b>market.pc.am</b>',
});
const node = makeNodeRpc({
  url: cfg.nodeRpcUrl || 'http://127.0.0.1:9443',
  cookiePath: cfg.nodeCookie || '/var/lib/pcoin/.cookie',
  walletName: cfg.hotWallet || 'market-hot',
});
const { makeSettings } = await import('/opt/pcoin-market/settings.mjs');
const SET = makeSettings(pool);
await SET.ensureTable();
await SET.reload();

const D = makeDelivery({ pool, node, notify, settings: SET });
const B = makeBacking({ pool, explorerUrl: cfg.explorerUrl || 'https://explorer.pc.am',
                        ownerAddress: cfg.ownerAddress, settings: SET,
                        floatBalance: () => D.floatBalance() });

const [cmd, a1, a2] = process.argv.slice(2);
const money = n => Number(n).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');

try {
  if (cmd === 'list') {
    const rows = await D.pendingDeliveries();
    if (!rows.length) { console.log('Nothing waiting. Every paid order has been delivered.'); }
    else {
      console.log(`${rows.length} order(s) waiting:\n`);
      for (const o of rows) {
        console.log(`  ${o.order_id}   ${o.status}${o.delivery_mode ? ' / ' + o.delivery_mode : ''}`);
        console.log(`    $${Number(o.usd).toFixed(2)}  ->  ${money(o.quoted_pcn)} PCN`);
        console.log(`    to   ${o.address}`);
        console.log(`    who  ${o.email}`);
        console.log(`    paid ${o.paid_at ? new Date(o.paid_at).toISOString() : '(not yet)'}`);
        if (o.delivery_error) console.log(`    ERR  ${o.delivery_error}`);
        console.log(`    ->   market-admin send ${o.order_id}       (pay from the hot wallet)`);
        console.log(`    ->   market-admin deliver ${o.order_id} <txid>   (you sent it yourself)`);
        console.log();
      }
    }

  } else if (cmd === 'float') {
    // Read the LIVE settings, not the module defaults. Printing the constants
    // meant this could report "LOW" while the server had already stopped
    // auto-sending, which is the worst kind of wrong: confidently reassuring.
    const bal = await D.floatBalance();
    const stop = SET.get('floatStopPcn'), warn = SET.get('floatWarnPcn'),
          target = SET.get('floatTargetPcn'), autoMax = SET.get('autoMaxUsd');
    const state = bal < stop ? 'STOPPED — below the auto-send floor'
                : bal < warn ? 'LOW — warning level'
                : 'ok';
    console.log(`hot wallet : ${money(bal)} PCN   [${state}]`);
    console.log(`levels     : stop ${stop} / warn ${warn} / target ${target}`);
    console.log(`auto-send  : orders up to $${autoMax}`);
    console.log(`top up to  : ${await D.receiveAddress()}`);

  } else if (cmd === 'backing') {
    const h = await B.headroomPcn();
    if (h.pcn === null) { console.log(`UNKNOWN — ${h.error}. The market is refusing new orders.`); }
    else {
      console.log(h.manual
        ? `deliverable   : ${money(h.ownerPcn)} PCN  (a cap YOU set, not a wallet reading)`
        : `your wallet   : ${money(h.ownerPcn)} PCN${h.degraded ? '  (cached: ' + h.degraded + ')' : ''}`);
      console.log(`already owed  : ${money(h.owed)} PCN on undelivered orders`);
      console.log(`sellable now  : ${money(h.pcn)} PCN`);
      if (h.ageMs) console.log(`reading age   : ${Math.round(h.ageMs / 1000)}s`);
    }

  } else if (cmd === 'deliver') {
    if (!a1 || !a2) throw new Error('usage: market-admin deliver <order_id> <txid>');
    await D.markDelivered(a1, a2);
    console.log(`recorded: ${a1} delivered in ${a2}`);

  } else if (cmd === 'send') {
    if (!a1) throw new Error('usage: market-admin send <order_id>');
    const [[o]] = await pool.query(
      `SELECT order_id, usd, quoted_pcn, address, status, delivered_txid, delivery_error
         FROM orders WHERE order_id=?`, [a1]);
    if (!o) throw new Error(`no such order: ${a1}`);
    if (o.delivered_txid) throw new Error(`already delivered in ${o.delivered_txid}`);
    if (!['awaiting_delivery', 'needs_review'].includes(o.status)) {
      throw new Error(`order is '${o.status}', not awaiting delivery — refusing`);
    }

    // Ask the WALLET before spending. This command exists to re-send, so it is
    // the most likely place to pay twice, and "the lookup failed" must never be
    // read as "nothing was sent".
    const seen = await D.alreadySent(a1);
    if (!seen.known) {
      throw new Error(`cannot check whether this was already sent (${seen.why}) — refusing. ` +
                      `Nothing was sent.`);
    }
    if (seen.txid) {
      throw new Error(`this order ALREADY left the wallet in ${seen.txid}. ` +
                      `Record it instead:  market-admin deliver ${a1} ${seen.txid}`);
    }

    // A flagged order must not be released without the reason being read.
    if (o.status === 'needs_review') {
      if (a2 !== '--reviewed') {
        console.log(`\n  ${a1} is flagged NEEDS REVIEW:`);
        console.log(`    ${o.delivery_error || '(no reason recorded — check the journal)'}\n`);
        console.log(`  Read that, then repeat with --reviewed if you still want to send:`);
        console.log(`    market-admin send ${a1} --reviewed\n`);
        throw new Error('refusing to send a flagged order without --reviewed');
      }
      console.log(`proceeding on a flagged order: ${o.delivery_error || '(no reason recorded)'}`);
    }

    const bal = await D.floatBalance();
    const pcn = Number(o.quoted_pcn);
    console.log(`about to send ${money(pcn)} PCN to ${o.address}`);
    console.log(`hot wallet holds ${money(bal)} PCN`);
    if (bal - pcn < 0) throw new Error('the hot wallet does not hold enough — top it up first');
    // Deliberately re-uses the same claim-and-record path as the automatic
    // route, so a manual push cannot double-send against an automatic one.
    await pool.query(`UPDATE orders SET status='awaiting_delivery' WHERE order_id=? AND status='needs_review'`,
                     [a1]);
    const r = await D.deliverForce(a1);
    console.log(r.ok ? `sent: ${r.txid}` : `FAILED: ${r.why}`);

  } else if (cmd === 'set-password') {
    // Read from the terminal, never from argv: a password on a command line is
    // in the shell history, in `ps`, and in anyone's scrollback.
    const email = a1 || 'pcoin@pc.am';
    const { createInterface } = await import('node:readline');
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const ask = qs => new Promise(r => {
      const onData = () => process.stdout.write('\x1b[2K\r' + qs);   // keep it off the screen
      process.stdin.on('data', onData);
      rl.question(qs, ans => { process.stdin.off('data', onData); r(ans); });
    });
    const pw1 = await ask(`new password for ${email}: `);
    const pw2 = await ask('\nagain: ');
    rl.close();
    console.log();
    if (pw1 !== pw2) throw new Error('they did not match');
    const { makeAdmin } = await import('/opt/pcoin-market/admin.mjs');
    const A = makeAdmin({ pool, cfg, settings: null, ladder: null, delivery: null,
                          backing: null, notify });
    await A.ensureTable();
    await A.setPassword(email, pw1);
    console.log(`password set for ${email}. Sign in at https://market.pc.am/admin and turn on 2FA.`);

  } else {
    console.log(`market-admin — deliveries for market.pc.am

  list                      orders waiting to be delivered
  float                     hot wallet balance, levels, funding address
  backing                   how much more PCN can be sold right now
  deliver <order> <txid>    record a delivery you made yourself
  send <order>              send it now from the hot wallet
  set-password [email]      set the admin panel password (prompts; default pcoin@pc.am)

Auto-send covers orders up to the configured limit; anything larger is yours to release.`);
  }
} catch (e) {
  console.error('error:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
