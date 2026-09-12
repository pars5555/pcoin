#!/usr/bin/env node
// The deposit watcher.
//
// ITS OWN PROCESS AND ITS OWN TIMER, deliberately. Run as a setInterval inside
// the bot it would share one MemoryMax=, so a conversation-history spike would
// OOM-kill the credit path, Restart=always would hide that behind
// `active (running)`, and OnFailure= could never fire for a dead interval.
// Separate processes also mean this one never needs the OonaCode key, and the
// Telegram-facing one never needs the explorer or the rate oracle.
//
// THE ORDER OF THE TICK IS LOAD-BEARING. Each step's comment says which
// incident it comes from.

import { appendFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';

import { loadConfig } from './lib/config.mjs';
import { log, errFields, addrTag, installCrashHandlers, setLevel } from './lib/log.mjs';
import { openDb, assertSchema, pendingMigrations, kvGet, kvSet, kvGetJson, kvSetJson } from './lib/db.mjs';
import { nowSec } from './lib/time.mjs';
import { ExplorerClient, indexHealth, addressTouched, isIndependentHost, BudgetExhausted } from './lib/explorer.mjs';
import { readRate, floorParity } from './lib/rate.mjs';
import { issuedAddresses, poolStats } from './lib/pool.mjs';
import { creditDepositSafe, reconcile, creditedUsdLast30Days, CreditResult } from './lib/deposits.mjs';
import { TelegramClient, escapeHtml } from './lib/telegram.mjs';
import { satsToPcnString, microUsdToString, satsToNanoUsd, splitNano } from './lib/money.mjs';

const cfg = loadConfig();
const RAIL = cfg.strOr('RAIL_NAME', 'pcnaibot');
const DB_PATH = cfg.str('DB_PATH');
const HEARTBEAT_FILE = cfg.strOr('HEARTBEAT_FILE', '/var/lib/pcnaibot/heartbeat.json');
const WATCHER_LOG = cfg.strOr('WATCHER_LOG', '/var/log/pcnaibot/watcher.log');

const MIN_CONF = cfg.int('MIN_CONF', 3);
const MIN_CONF_COINBASE = cfg.int('MIN_CONF_COINBASE', 100);
const MIN_BLOCK_HEIGHT = cfg.int('MIN_BLOCK_HEIGHT', 2800);
const MIN_DEPOSIT_SAT = BigInt(cfg.int('MIN_DEPOSIT_PCN', 1)) * 100000000n;
const CORROBORATE_ABOVE_MICRO = BigInt(Math.round(cfg.num('CORROBORATE_ABOVE_USD', 250) * 1e6));
const CAP_USER_MICRO = BigInt(Math.round(cfg.num('CAP_30D_USD_PER_USER', 2000) * 1e6));
const CAP_GLOBAL_MICRO = BigInt(Math.round(cfg.num('CAP_30D_USD_GLOBAL', 20000) * 1e6));
const MARGIN = cfg.num('MARGIN', 3.0);

const DROP_AFTER_KNOWN_TICKS = 60; // ~1h of ticks in which the mempool WAS readable

// Accumulated by redriveDeposit(), reset at the top of each tick. A module
// scalar rather than a return value because credits happen on two code paths.
let creditedThisTick = 0n;

installCrashHandlers();
// A tick that cannot explain itself is a tick you debug by guesswork.
setLevel(cfg.strOr('LOG_LEVEL', 'info'));

// ---------------------------------------------------------------------------
// Heartbeat.
//
// STAMPED ONLY AFTER A TICK COMPLETES, and STAMPED ON THE DISABLED PATH TOO.
// A disabled tick that stamps nothing produces a misattributed "No tick for 15
// min" DOWN alert; a disabled tick that stamps ok:true with no `skipped` reads
// as perfectly healthy while deposits land on chain uncredited.
//
// `at` in SECONDS. webai wrote milliseconds and its staleness alert could not
// fire at all.
// ---------------------------------------------------------------------------
function writeHeartbeat({ ok, lastError, summary }) {
  const payload = JSON.stringify({
    at: nowSec(),
    ok: !!ok,
    last_error: lastError ?? null,
    summary: summary ?? {},
  });
  // tmp + fsync + rename + fsync(dir): an interrupted write must never leave a
  // truncated heartbeat, which would read as a corrupt rail rather than a
  // healthy one.
  const tmp = `${HEARTBEAT_FILE}.tmp`;
  writeFileSync(tmp, payload);
  const fd = openSync(tmp, 'r');
  fsyncSync(fd);
  closeSync(fd);
  renameSync(tmp, HEARTBEAT_FILE);
  try {
    const dfd = openSync(dirname(HEARTBEAT_FILE), 'r');
    fsyncSync(dfd);
    closeSync(dfd);
  } catch { /* directory fsync is best effort on some filesystems */ }
}

// The tick summary line the monitor greps. It MUST contain `seen=` (that is how
// pcoin-deposit-watch counts a tick) and `skipped=<reason>` when the tick
// credits nothing -- check_holding is file-based and reads exactly this.
function writeSummaryLine(fields) {
  const parts = Object.entries(fields).map(([k, v]) => `${k}=${v}`);
  const line = `${new Date().toISOString()} ${RAIL} ${parts.join(' ')}\n`;
  try { appendFileSync(WATCHER_LOG, line); }
  catch (e) { log.warn('could not append to watcher log', errFields(e)); }
  process.stdout.write(line);
}

// ---------------------------------------------------------------------------

const db = openDb(DB_PATH);
const pend = pendingMigrations(db);
if (pend.length) {
  // Refuse rather than run against a schema we have not migrated. A watcher
  // that credits against the wrong schema is worse than one that does not run.
  log.error('refusing to start: pending migrations', { count: pend.length, first: pend[0].name });
  writeHeartbeat({ ok: false, lastError: 'pending migrations', summary: { skipped: ['migrations_pending'] } });
  process.exit(1);
}
assertSchema(db);

const kvStore = {
  getJson: (k) => kvGetJson(db, k),
  setJson: (k, v) => kvSetJson(db, k, v),
};

const explorer = new ExplorerClient(cfg.strOr('EXPLORER_URL', 'https://explorer.pc.am'), {
  budget: cfg.int('EXPLORER_REQ_BUDGET', 40),
});

// D11. Configured or not, this is resolved ONCE at startup and compared by
// HOSTNAME -- HTTPS://, :443, //api and a trailing dot all slip past a string
// compare and make the oracle corroborate itself.
const corroborateUrl = cfg.strOr('EXPLORER_CORROBORATE_URL', null);
let corroborator = null;
if (corroborateUrl) {
  const ind = isIndependentHost(cfg.strOr('EXPLORER_URL', 'https://explorer.pc.am'), corroborateUrl);
  if (!ind.independent) {
    log.error('EXPLORER_CORROBORATE_URL is NOT an independent host; refusing to use it', { reason: ind.reason });
  } else {
    corroborator = new ExplorerClient(corroborateUrl, { budget: 10 });
  }
}

const tg = (() => {
  try { return new TelegramClient(cfg.str('TELEGRAM_TOKEN')); }
  catch { log.warn('no Telegram token configured; user notifications disabled'); return null; }
})();

async function notify(chatId, html) {
  // Best effort, never fatal, and ALWAYS after the money is committed.
  if (!tg || chatId === null || chatId === undefined) return;
  try { await tg.sendMessage(chatId, html); }
  catch (e) { log.warn('user notification failed', errFields(e)); }
}

// ---------------------------------------------------------------------------
// The tick.
// ---------------------------------------------------------------------------
async function tick() {
  explorer.resetBudget();
  if (corroborator) corroborator.resetBudget();
  creditedThisTick = 0n;

  const skipped = [];
  let seen = 0;
  let credited = 0;
  let held = 0;

  // --- step 1: the enabled master switch --------------------------------
  const enabled = (kvGet(db, 'enabled') ?? (cfg.bool('ENABLED', true) ? '1' : '0')) === '1';
  if (!enabled) {
    // webai's branch, copied deliberately: whether this is a fault depends on
    // whether an address has ever been ISSUED. If one has, anything the user
    // sends is landing on chain and is NOT being credited.
    const stats = poolStats(db);
    skipped.push('disabled');
    writeSummaryLine({ seen: 0, credited: 0, skipped: 'disabled', issued: stats.issued });
    writeHeartbeat({ ok: true, lastError: null, summary: { skipped, issued_addresses: stats.issued } });
    return;
  }

  // --- step 2: watch every ISSUED address -------------------------------
  // `assigned_at IS NOT NULL`, NOT `chat_id IS NOT NULL`. An address shown to a
  // human can receive coin forever; a deleted user nulls chat_id.
  const watched = issuedAddresses(db);
  seen = watched.length;

  // --- step 3: /api/status ----------------------------------------------
  const status = await explorer.status();
  if (!status.readable) {
    // Unreachable. RETURN, CREDIT NOTHING. An errored explorer call is not
    // "no payment".
    skipped.push('explorer_unreadable');
    writeSummaryLine({ seen, credited: 0, skipped: `explorer_unreadable:${status.reason}` });
    writeHeartbeat({ ok: true, lastError: status.reason, summary: { skipped } });
    return;
  }

  // --- step 4: index health, three fields and nothing else --------------
  if (!status.health.healthy) {
    skipped.push('index_unhealthy');
    writeSummaryLine({ seen, credited: 0, skipped: `index_unhealthy:${status.health.reason}` });
    writeHeartbeat({ ok: true, lastError: status.health.reason, summary: { skipped } });
    return;
  }
  const tipHeight = status.health.indexedHeight;

  // A real mid-reorg signal is the CHANGE between two reads, never the value of
  // a lifetime counter.
  const prevCounters = kvGetJson(db, 'watch:index_counters');
  const nowCounters = { reorgCount: status.health.reorgCount, blocksUnwound: status.health.blocksUnwound };
  const reorgMoved = prevCounters
    && (prevCounters.reorgCount !== nowCounters.reorgCount
        || prevCounters.blocksUnwound !== nowCounters.blocksUnwound);
  kvSetJson(db, 'watch:index_counters', nowCounters);
  if (reorgMoved) {
    log.warn('index reorg counters MOVED since last tick (a real signal, unlike their value)', {
      from_reorg: prevCounters.reorgCount, to_reorg: nowCounters.reorgCount,
      from_unwound: prevCounters.blocksUnwound, to_unwound: nowCounters.blocksUnwound,
    });
  }

  // --- the rate, read ONCE per tick -------------------------------------
  const rate = await readRate(kvStore, cfg);
  if (!rate.usable) {
    // Not fatal to the tick -- we still want to RECORD sightings and
    // confirmations. It is fatal to CREDITING, which is gated below.
    log.warn('rate not usable this tick; nothing will be credited', { reason: rate.reason });
  } else if (rate.source === 'cache') {
    log.warn('crediting from a CACHED rate', { ageSeconds: rate.cacheAgeSeconds, reason: rate.reason });
  }

  // Floor parity is a TIMER CHECK, not a credit gate: at credit time we CREDIT
  // AND FLAG. Refusing here would keep coins that are already ours and give
  // nothing back.
  let floorFlag = null;
  if (rate.usable && rate.rateFloorUsd !== null) {
    const fp = floorParity(rate.rate, rate.rateFloorUsd, MARGIN);
    if (fp.evaluable && !fp.ok) {
      floorFlag = `floor_parity ratio=${fp.ratio.toFixed(3)} > M=${MARGIN}`;
      log.warn('floor parity breached -- credit and flag, do NOT stop crediting', { ratio: fp.ratio, margin: MARGIN });
    }
  }

  const byAddress = new Map(watched.map((w) => [w.address, w]));
  let touchedCount = 0;

  try {
    // --- step 5/6: batch balances, detect touched --------------------------
    const touched = [];
    for (let i = 0; i < watched.length; i += 500) {
      const chunk = watched.slice(i, i + 500).map((w) => w.address);
      const res = await explorer.addresses(chunk);
      if (!res.readable) {
        // On a throw, fall back to "CHECK THEM ALL", never "assume none".
        log.warn('address batch unreadable; falling back to checking all', { reason: res.reason });
        for (const a of chunk) touched.push(a);
        continue;
      }
      const entries = Array.isArray(res.json?.addresses) ? res.json.addresses : null;
      if (!entries) {
        log.warn('address batch had an unrecognised body shape; treating all as touched');
        for (const a of chunk) touched.push(a);
        continue;
      }
      for (const entry of entries) {
        const row = byAddress.get(String(entry?.address ?? '').toLowerCase());
        if (!row) continue;
        const prev = row.last_tx_count === null || row.last_tx_count === undefined
          ? null
          : { txCount: row.last_tx_count, received: row.last_received_sat };
        const t = addressTouched(entry, prev);
        if (t.touched) {
          touched.push(row.address);
          log.debug('address touched', { addr: addrTag(row.address), reason: t.reason });
        }
        if (Number.isInteger(t.txCount) && Number.isInteger(t.received)) {
          db.prepare(`UPDATE pcn_addresses SET last_tx_count=?, last_received_sat=?, last_observed_at=?
                       WHERE address=?`).run(t.txCount, t.received, nowSec(), row.address);
        }
      }
    }

    touchedCount = touched.length;
    log.debug('touched set', { count: touched.length, first: touched[0] ? addrTag(touched[0]) : '-' });

    // --- step 7/8/10/11: per touched address ------------------------------
    for (const addr of touched) {
      const txs = await explorer.addressTxs(addr, { limit: 200 });
      if (!txs.readable) { skipped.push('txs_unreadable'); continue; }

      // Re-check index health PER RESPONSE: a reorg can start mid-cycle.
      const h = indexHealth(txs.json);
      if (!h.healthy) { skipped.push('index_unhealthy_midcycle'); break; }

      const row = byAddress.get(addr);
      if (!row) {
        // touched named an address we are not watching. Impossible by
        // construction, so say so rather than skipping quietly.
        log.error('touched address is not in the watch map', { addr: addrTag(addr) });
        continue;
      }

      // --- step 10: the mempool pass -------------------------------------
      const unconf = txs.json?.unconfirmed;
      const mempoolKnown = unconf?.known === true;
      log.debug('mempool pass', {
        addr: addrTag(addr), known: String(unconf?.known),
        items: Array.isArray(unconf?.items) ? unconf.items.length : 'not-an-array',
      });
      if (mempoolKnown && Array.isArray(unconf.items)) {
        for (const item of unconf.items) {
          const txid = String(item?.txid ?? '');
          const recv = item?.received_sat;
          log.debug('mempool item', { txid: txid.slice(0, 12), recv: String(recv) });
          if (!/^[0-9a-f]{64}$/i.test(txid) || !Number.isInteger(recv) || recv <= 0) continue;
          const ins = db.prepare(
            `INSERT INTO pcn_deposits (txid, address, chat_id, status, amount_sat, first_seen_at)
             VALUES (?,?,?,'seen',?,?)
             ON CONFLICT(txid, address) DO NOTHING`
          ).run(txid, addr, row.chat_id, recv, nowSec());
          if (ins.changes === 1) {
            // Message the user ONCE, on the transition only.
            await notify(row.chat_id,
              `Seen your deposit of <b>${escapeHtml(satsToPcnString(recv))} PCN</b> in the mempool. `
              + `It will be credited after ${MIN_CONF} confirmations.`);
          }
        }
      }

      // --- step 11: the confirmed pass -----------------------------------
      const items = Array.isArray(txs.json?.confirmed?.items) ? txs.json.confirmed.items : [];
      for (const item of items) {
        const r = await handleConfirmedItem({ item, addr, row, tipHeight, rate, floorFlag });
        if (r === 'credited') credited++;
        else if (r === 'held') held++;
      }
    }

    // --- step 9: RE-DRIVE HELD ROWS FROM OUR OWN TABLE, EVERY TICK --------
    //
    // The single most valuable thing to do differently from webbuilderbot.
    // Addresses are reused forever, so a held deposit eventually falls out of
    // the 200-tx window -- and from that moment it is money received, recorded,
    // and never credited again, with nothing alerting. Its author documented
    // the cliff and did not remove it.
    const open = db.prepare(
      `SELECT * FROM pcn_deposits WHERE status NOT IN ('credited','rejected') ORDER BY first_seen_at ASC LIMIT 50`
    ).all();
    for (const dep of open) {
      const r = await redriveDeposit({ dep, tipHeight, rate, floorFlag, mempoolKnownHint: null });
      if (r === 'credited') credited++;
      else if (r === 'held') held++;
    }

    // --- step 12: the reorg re-check -------------------------------------
    await reorgRecheck(tipHeight);
  } catch (e) {
    if (e instanceof BudgetExhausted) {
      // Carry the unfinished work to the next tick rather than bursting past
      // the shared 20/s bucket and 429ing the iOS wallet's broadcasts.
      skipped.push('request_budget');
      log.warn('per-tick explorer budget exhausted; carrying work to next tick', { spent: explorer.spent });
    } else {
      log.error('tick failed', errFields(e));
      writeSummaryLine({ seen, credited, skipped: `error:${String(e.message).slice(0, 80)}` });
      writeHeartbeat({ ok: false, lastError: String(e.message).slice(0, 200), summary: { skipped } });
      return;
    }
  }

  if (!rate.usable) skipped.push('rate_unusable');

  // The reconciliation invariant, every tick.
  const rec = reconcile(db);
  if (!rec.ok) {
    log.error('RECONCILIATION DRIFT', { drifts: rec.drifts.length, first: JSON.stringify(rec.drifts[0]).slice(0, 200) });
    skipped.push('reconcile_drift');
  }

  const summaryFields = {
    seen,
    touched: touchedCount,
    credited,
    held,
    credited_usd: microUsdToString(creditedThisTick, 6),
    reqs: explorer.spent,
  };
  if (skipped.length) summaryFields.skipped = skipped.join(',');
  writeSummaryLine(summaryFields);
  writeHeartbeat({
    ok: true,
    lastError: null,
    summary: { seen, credited, held, skipped, reconcile_ok: rec.ok, requests: explorer.spent },
  });
}

// ---------------------------------------------------------------------------
// One confirmed item off the address history.
// ---------------------------------------------------------------------------
async function handleConfirmedItem({ item, addr, row, tipHeight, rate, floorFlag }) {
  const txid = String(item?.txid ?? '');
  if (!/^[0-9a-f]{64}$/i.test(txid)) return null;

  const recv = item?.received_sat;
  if (!Number.isInteger(recv) || recv <= 0) return null;

  // Missing / non-numeric / <= 0 height -> HOLD. Never `rejected`.
  // (int)null is 0, 0 is below any sane min_height, and `rejected` is terminal
  // -- one malformed item would then permanently keep a customer's money.
  // RESERVE `rejected` FOR THINGS YOU POSITIVELY ESTABLISHED FROM DATA YOU
  // ACTUALLY READ.
  const height = item?.height;

  const existing = db.prepare('SELECT * FROM pcn_deposits WHERE txid=? AND address=?').get(txid, addr);

  if (!existing) {
    // Guard the insert against UNIQUE(txid,address): two concurrent ticks, or
    // the mempool pass and the confirmed pass within one tick, will both
    // insert. If the throw aborted the tick, the heartbeat would never be
    // stamped and the rail would read as DOWN rather than as fine.
    const ins = db.prepare(
      `INSERT INTO pcn_deposits (txid, address, chat_id, status, amount_sat, block_height, block_hash, first_seen_at)
       VALUES (?,?,?,'confirming',?,?,?,?)
       ON CONFLICT(txid, address) DO NOTHING`
    ).run(txid, addr, row?.chat_id ?? null, recv,
          Number.isInteger(height) ? height : null,
          typeof item?.block_hash === 'string' ? item.block_hash : null,
          nowSec());
    if (ins.changes === 1) {
      await notify(row?.chat_id,
        `Your deposit of <b>${escapeHtml(satsToPcnString(recv))} PCN</b> is confirming. `
        + `It will be credited at ${MIN_CONF} confirmations.`);
    }
    // Credit on a LATER pass, deliberately: one thing per tick keeps the
    // ordering auditable.
    return 'confirming';
  }

  if (existing.status === 'credited' || existing.status === 'rejected') return null;

  return redriveDeposit({ dep: existing, tipHeight, rate, floorFlag });
}

// ---------------------------------------------------------------------------
// Re-check one open deposit directly, by txid, against the authoritative
// record. This is what makes a held row recoverable forever.
// ---------------------------------------------------------------------------
async function redriveDeposit({ dep, tipHeight, rate, floorFlag }) {
  const hold = (reason) => {
    db.prepare('UPDATE pcn_deposits SET status=?, note=? WHERE id=?').run('held', reason.slice(0, 300), dep.id);
    return 'held';
  };

  const txr = await explorer.tx(dep.txid);
  if (!txr.readable) {
    // Unreadable resolves NOTHING. Not dropped, not rejected.
    return 'unreadable';
  }
  const tx = txr.tx;

  const status = tx.status;
  const height = tx.height;
  const confirmations = tx.confirmations;

  // Mempool / unconfirmed.
  if (!Number.isInteger(height) || height <= 0) {
    // AGEING TO `dropped` IS GATED ON A READABLE MEMPOOL. Increment the counter
    // only on ticks where the mempool was actually observed, and age on THAT --
    // never on wall-clock ticks. Otherwise an explorer whose node link drops for
    // N ticks ages every in-flight deposit to `dropped`, and an unreadable
    // mempool has become a definite "it is gone".
    const mempoolReadable = txr.index && txr.index.node_reachable === true;
    if (mempoolReadable) {
      const ticks = dep.unconfirmed_known_ticks + 1;
      db.prepare('UPDATE pcn_deposits SET unconfirmed_known_ticks=? WHERE id=?').run(ticks, dep.id);
      if (ticks > DROP_AFTER_KNOWN_TICKS && dep.status !== 'dropped') {
        // `dropped` is NOT terminal: step 9 keeps re-driving it and the monitor
        // block queries the same set.
        db.prepare('UPDATE pcn_deposits SET status=? WHERE id=?').run('dropped', dep.id);
      }
    }
    return 'pending';
  }

  // GATE 1: the deposit's OWN block height >= 2800. Not the tip -- a tip gate
  // credits a pre-2800 deposit the instant the tip is high enough, which is
  // exactly wrong. Below 2800 difficulty was frozen under the legacy retarget,
  // so those blocks stay cheap to rewrite FOREVER.
  if (height < MIN_BLOCK_HEIGHT) {
    db.prepare(`UPDATE pcn_deposits SET status='rejected', block_height=?, note=? WHERE id=?`)
      .run(height, `below the ${MIN_BLOCK_HEIGHT} consensus floor (height ${height})`, dep.id);
    await notify(dep.chat_id,
      `A deposit was found in block ${height}, which is below this chain's ${MIN_BLOCK_HEIGHT}-block safety floor, `
      + `so it cannot be credited. Please contact support.`);
    return 'rejected';
  }

  // Self-consistency against the summary we recorded, and GATE 1 asserted a
  // SECOND time from the authoritative record.
  if (Number.isInteger(dep.block_height) && dep.block_height !== height) {
    return hold(`height disagrees: summary ${dep.block_height}, /tx ${height}`);
  }
  if (height < MIN_BLOCK_HEIGHT) return hold('height below floor on re-assert');

  // GATE 3: coinbase maturity. is_coinbase comes from the AUTHORITATIVE /api/tx
  // and is NOT in the address summary. AN ABSENT KEY IS REFUSED, NOT READ AS
  // FALSE -- a coinbase read as non-coinbase matures 100 blocks early, and
  // `startmining "<address>"` needs no wallet, so a user can point a miner
  // straight at their deposit address.
  if (typeof tx.is_coinbase !== 'boolean') {
    return hold('is_coinbase absent from /api/tx (unknown, not false)');
  }
  const needed = tx.is_coinbase ? Math.max(MIN_CONF, MIN_CONF_COINBASE) : MIN_CONF;

  // GATE 2: confirmations.
  if (!Number.isInteger(confirmations)) {
    return hold('confirmations absent or non-integer');
  }
  if (confirmations < needed) {
    db.prepare('UPDATE pcn_deposits SET status=?, block_height=?, block_hash=?, is_coinbase=? WHERE id=?')
      .run('confirming', height, typeof tx.block_hash === 'string' ? tx.block_hash : null,
           tx.is_coinbase ? 1 : 0, dep.id);
    return 'confirming';
  }

  if (status && status !== 'confirmed') {
    return hold(`/tx status is ${JSON.stringify(String(status).slice(0, 40))}`);
  }

  // An orphaned address: money arrived somewhere we issued, for a user who is
  // gone. RECORD IT, HOLD IT, AND ALERT LOUDLY.
  if (dep.chat_id === null || dep.chat_id === undefined) {
    log.error('MONEY ARRIVED AT AN ORPHANED ADDRESS', {
      addr: addrTag(dep.address), txid: dep.txid, sat: dep.amount_sat,
    });
    return hold('orphaned address: no chat_id bound');
  }

  // THE RATE GATE. If the rate is not usable, HOLD. This was documented and not
  // enforced once, and a 21,601-second-old cache produced a full credit.
  if (!rate.usable) {
    db.prepare('UPDATE pcn_deposits SET status=?, block_height=?, block_hash=?, is_coinbase=?, confirmations_at_credit=? WHERE id=?')
      .run('confirming', height, typeof tx.block_hash === 'string' ? tx.block_hash : null,
           tx.is_coinbase ? 1 : 0, confirmations, dep.id);
    return 'held_rate';
  }

  // What is this worth, for the threshold checks below?
  const nano = satsToNanoUsd(BigInt(dep.amount_sat), BigInt(rate.rateE12));
  const valueMicro = splitNano(nano).micro;

  // CORROBORATION above a USD threshold, against a source on a DIFFERENT HOST.
  // Failure HOLDS. If no independent source is configured, a deposit above the
  // threshold is held with flagged_reason='uncorroborated' AND ALERTED FOR A
  // HUMAN -- it does not auto-credit on one source, and it does not sit
  // silently.
  const flags = [];
  if (valueMicro >= CORROBORATE_ABOVE_MICRO) {
    if (!corroborator) {
      db.prepare('UPDATE pcn_deposits SET status=?, flagged_reason=?, note=? WHERE id=?')
        .run('held', 'uncorroborated',
             `worth $${microUsdToString(valueMicro, 2)}, above the $${microUsdToString(CORROBORATE_ABOVE_MICRO, 2)} threshold, and no independent source is configured`,
             dep.id);
      log.error('LARGE DEPOSIT HELD, NO INDEPENDENT SOURCE CONFIGURED -- a human must review', {
        txid: dep.txid, usd: microUsdToString(valueMicro, 2),
      });
      return 'held';
    }
    const second = await corroborator.tx(dep.txid);
    if (!second.readable) return hold(`corroboration unreadable: ${second.reason}`);
    if (second.tx.height !== height || second.tx.block_hash !== tx.block_hash) {
      return hold(`corroboration disagrees: heights ${height}/${second.tx.height}`);
    }
  }

  // 30-DAY CAPS. A deposit that arrives over a cap is CREDITED AND FLAGGED,
  // never kept-and-refused. The coins are already ours; refusing the credit is
  // the worst of both outcomes -- `rejected` is unalerted, and `hold` pages
  // every five minutes forever with no resolution, because there are no refunds
  // and the server holds no key. Caps are enforced BEFORE the money moves, on
  // the deposit screen.
  const userSoFar = creditedUsdLast30Days(db, dep.chat_id);
  const globalSoFar = creditedUsdLast30Days(db, null);
  if (userSoFar + valueMicro > CAP_USER_MICRO) flags.push('over_cap_user');
  if (globalSoFar + valueMicro > CAP_GLOBAL_MICRO) flags.push('over_cap_global');
  if (floorFlag) flags.push('floor_parity');

  const res = creditDepositSafe(db, dep.id, rate, {
    minDepositSat: MIN_DEPOSIT_SAT,
    observed: {
      confirmations,
      isCoinbase: tx.is_coinbase,
      blockHash: typeof tx.block_hash === 'string' ? tx.block_hash : null,
    },
  });

  if (flags.length) {
    db.prepare('UPDATE pcn_deposits SET flagged_reason=COALESCE(flagged_reason,?) WHERE id=?')
      .run(flags.join(','), dep.id);
    log.error('deposit CREDITED AND FLAGGED', { txid: dep.txid, flags: flags.join(','), usd: microUsdToString(valueMicro, 2) });
  }

  if (res.result === CreditResult.CREDITED) {
    creditedThisTick += res.microUsd;
    // Notifications run AFTER the money is committed, and are never fatal.
    if (res.dust) {
      await notify(dep.chat_id,
        `Received <b>${escapeHtml(satsToPcnString(dep.amount_sat))} PCN</b>, which is below the `
        + `${cfg.int('MIN_DEPOSIT_PCN', 1)} PCN minimum. It has been kept against your account and will be `
        + `added to your next top-up.`);
    } else {
      await notify(dep.chat_id,
        `Credited <b>$${escapeHtml(microUsdToString(res.microUsd, 4))}</b> from `
        + `${escapeHtml(satsToPcnString(dep.amount_sat))} PCN at a rate of `
        + `${escapeHtml(rate.rateText)} USD/PCN, read at confirmation time.`);
    }
    return 'credited';
  }
  return res.result;
}

// ---------------------------------------------------------------------------
// Step 12: the reorg re-check.
//
// FLAG AND ALERT; NEVER AUTO-REVERSE. Never judge on an unreachable or
// unhealthy index. Never flag on a TRUNCATED history -- if the fetch hit its
// row limit, an absent transaction may simply be older than the window.
// ---------------------------------------------------------------------------
async function reorgRecheck(tipHeight) {
  const since = nowSec() - 7 * 86400;
  const rows = db.prepare(
    `SELECT id, txid, block_hash, block_height, chat_id FROM pcn_deposits
      WHERE status='credited' AND credited_at >= ? AND block_hash IS NOT NULL
        AND reorg_flagged_at IS NULL
      ORDER BY credited_at DESC LIMIT 25`
  ).all(since);

  for (const r of rows) {
    let res;
    try { res = await explorer.tx(r.txid); }
    catch (e) { if (e instanceof BudgetExhausted) return; throw e; }
    if (!res.readable) continue; // unreadable resolves nothing

    const h = res.tx.block_hash;
    if (typeof h !== 'string') continue;
    if (h !== r.block_hash) {
      db.prepare('UPDATE pcn_deposits SET reorg_flagged_at=?, flagged_reason=COALESCE(flagged_reason,?) WHERE id=?')
        .run(nowSec(), 'reorg', r.id);
      log.error('REORG: a credited deposit now sits in a different block. FLAGGED, NOT REVERSED.', {
        txid: r.txid, was: r.block_hash.slice(0, 16), now: h.slice(0, 16),
      });
    }
  }
}

// ---------------------------------------------------------------------------

tick()
  .then(() => { db.close(); process.exit(0); })
  .catch((e) => {
    log.error('watcher tick threw at top level', errFields(e));
    try {
      writeSummaryLine({ seen: 0, credited: 0, skipped: `fatal:${String(e.message).slice(0, 80)}` });
      writeHeartbeat({ ok: false, lastError: String(e.message).slice(0, 200), summary: { skipped: ['fatal'] } });
    } catch { /* nothing left to do */ }
    process.exit(1);
  });
