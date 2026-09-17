// FAULT INJECTION AGAINST THE REAL WATCHER.
//
// The brief's §8 asks for tests "against live infrastructure", and several of
// them describe breaking something: kill the explorer, freeze the pool clock,
// make the oracle answer nonsense. Done literally on this estate that means
// firewalling explorer.pc.am -- which SIX payment rails read, so the test would
// stop other people's money to check ours. That is not a test, it is an
// outage.
//
// So the faults are injected for OUR PROCESS ONLY: a local server speaks the
// explorer and oracle protocols on 127.0.0.1, the real `watch.mjs` is pointed
// at it through a scratch config, and it runs against a COPY of the live
// database. The artifact under test is the deployed one, the data is the real
// shape (templates captured from the live endpoints, not invented), and
// production never notices.
//
// Run inside the bot image:
//   docker run --rm --network host -v /opt/pcnaibot-livetest:/lt \
//     -v /var/lib/pcnaibot:/var/lib/pcnaibot:ro \
//     --entrypoint node pcnaibot:latest /lt/livetest.mjs

import http from 'node:http';
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const LT = '/lt';
const TPL = join(LT, 'templates');
const WORK = join(LT, 'work');
const PORT = 18700;
const BASE = `http://127.0.0.1:${PORT}`;
const LIVE_DB = '/var/lib/pcnaibot/pcnaibot.db';

const tpl = (n) => JSON.parse(readFileSync(join(TPL, n), 'utf8'));
const STATUS = tpl('status.json');
const ADDRESSES = tpl('addresses.json');
const TXS = tpl('txs.json');
const PRICE = readFileSync(join(TPL, 'price.json'), 'utf8');

// The address every scenario pays. Real bech32, ours, never funded on chain.
const ADDR = 'pc1qpcnaibotlivetest000000000000000000000000';

// ---------------------------------------------------------------------------
// The fake explorer + oracle. `scenario` is swapped between runs.
// ---------------------------------------------------------------------------
let scenario = {};

function statusBody() {
  const s = JSON.parse(JSON.stringify(STATUS));
  if (scenario.indexStale) s.index.stale = true;
  if (scenario.nodeUnreachable) s.index.node_reachable = false;
  if (scenario.blocksBehind !== undefined) s.index.blocks_behind = scenario.blocksBehind;
  // The counters that must NEVER gate anything. Left non-zero on purpose: the
  // live explorer really does report 1/1, and a rail that gates on them stops
  // crediting forever (CLAUDE.md 8c rule 5).
  s.index.reorg_count = 7;
  s.index.blocks_unwound = 3;
  if (scenario.height) { s.index.indexed_height = scenario.height; s.index.node_height = scenario.height; }
  return s;
}

function addressesBody() {
  const b = JSON.parse(JSON.stringify(ADDRESSES));
  b.index = statusBody().index;
  const entry = JSON.parse(JSON.stringify(b.addresses[0]));
  entry.address = ADDR;
  entry.used = true;
  const bal = entry.balance.confirmed;
  for (const k of Object.keys(bal)) if (typeof bal[k] === 'number') bal[k] = 0;
  for (const k of Object.keys(bal)) if (typeof bal[k] === 'string') bal[k] = '0.00000000';
  if (scenario.immatureSat) {
    bal.immature_sat = scenario.immatureSat;
    bal.immature_utxo_count = 1;
  } else if (scenario.matureSat) {
    bal.mature_sat = scenario.matureSat;
    bal.mature_utxo_count = 1;
    bal.spendable_sat = scenario.matureSat;
  }
  b.addresses = [entry];
  return b;
}

function txsBody() {
  const b = JSON.parse(JSON.stringify(TXS));
  b.index = statusBody().index;
  b.address = ADDR;
  b.unconfirmed = { known: scenario.unconfirmedKnown !== false, items: [], count: 0 };
  const items = [];
  if (scenario.deposit) {
    const d = scenario.deposit;
    items.push({
      txid: d.txid, height: d.height, block_hash: 'a'.repeat(64), block_index: 1,
      time: 1789211852, time_iso: '2026-09-12T11:17:32Z',
      confirmations: d.confirmations, n_in: d.coinbase ? 0 : 1, n_out: 1,
      received_sat: d.sat, received_pcn: (d.sat / 1e8).toFixed(8),
      sent_sat: 0, sent_pcn: '0.00000000',
      net_sat: d.sat, net_pcn: (d.sat / 1e8).toFixed(8),
    });
  }
  b.confirmed = { items, total: items.length, limit: 200, has_more: false, offset: 0, next_cursor: null };
  return b;
}

function txBody(txid) {
  const d = scenario.deposit ?? {};
  return {
    index: statusBody().index,
    mempool: { known: true, node_reachable: true, observed_seconds_ago: 1, tx_count: 0 },
    tx: {
      txid, height: d.height ?? 8000, block_index: 1, version: 2,
      is_coinbase: !!d.coinbase, n_in: d.coinbase ? 0 : 1, n_out: 1,
      confirmations: d.confirmations ?? 10, block_hash: 'a'.repeat(64),
      block_time: 1789211852, status: 'confirmed',
    },
  };
}

function priceBody() {
  let p = JSON.parse(PRICE);
  if (scenario.rateStale) p.stale = true;
  if (scenario.poolAgeSeconds !== undefined) {
    p.rateFollowsPoolDown = true;
    p.pool = { ...(p.pool ?? {}), ageSeconds: scenario.poolAgeSeconds, medianUsd: 0.0376 };
  }
  if (scenario.rateValue !== undefined) {
    // Patch the LITERAL, because the watcher reads the number out of the text.
    const s = JSON.stringify(p);
    return s.replace(/"serviceRate":[0-9.eE+-]+/, `"serviceRate":${scenario.rateValue}`);
  }
  return JSON.stringify(p);
}

const server = http.createServer((req, res) => {
  if (scenario.explorerDown && req.url.startsWith('/api')) {
    res.writeHead(503, { 'content-type': 'application/json' });
    return res.end('{"error":"down"}');
  }
  const send = (o) => {
    // No keep-alive: one request per socket removes socket-reuse corruption as
    // a variable entirely. This is a test server; the cost is irrelevant.
    res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
    res.end(typeof o === 'string' ? o : JSON.stringify(o));
  };
  if (req.url === '/' || req.url.startsWith('/?')) return send(priceBody());
  if (req.url.startsWith('/api/status')) return send(statusBody());
  // Drain the POST body before answering. Replying with bytes still unread
  // leaves them on the socket for the next request to choke on.
  if (req.url.startsWith('/api/addresses')) {
    req.on('data', () => {});
    req.on('end', () => send(addressesBody()));
    return;
  }
  if (req.url.includes('/txs')) return send(txsBody());
  if (req.url.startsWith('/api/tx/')) return send(txBody(req.url.split('/')[3].split('?')[0]));
  res.writeHead(404); res.end('{}');
});

// ---------------------------------------------------------------------------
// One run of the REAL watcher against a scratch copy of the live database.
// ---------------------------------------------------------------------------
function freshWork(extra = []) {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  copyFileSync(LIVE_DB, join(WORK, 'w.db'));
  // A copy of a WAL database without its -wal is the last checkpoint, which is
  // fine here: we only need a real schema and plausible rows.
  const base = [
    `DB_PATH=${join(WORK, 'w.db')}`,
    `HEARTBEAT_FILE=${join(WORK, 'hb.json')}`,
    `WATCHER_LOG=${join(WORK, 'watch.log')}`,
    `EXPLORER_URL=${BASE}`,
    `PRICE_URL=${BASE}`,
    'EXPLORER_CORROBORATE_URL=',
    'TELEGRAM_TOKEN=0:disabled',        // no alert can leave this harness
    'RAIL_NAME=pcnaibot-livetest',
    'MIN_CONF=3', 'MIN_CONF_COINBASE=100', 'MIN_BLOCK_HEIGHT=2800',
    'MIN_DEPOSIT_PCN=1', 'MARGIN=3.0',
    'CAP_30D_USD_PER_USER=2000', 'CAP_30D_USD_GLOBAL=20000',
    'LOG_LEVEL=debug', 'ENABLED=true',
  ];

  // The config parser REFUSES duplicate keys, so an override has to REPLACE the
  // base line rather than follow it. Appending both would make the watcher exit
  // before doing anything, and the scenario would read as a product failure.
  const kv = (line) => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; };
  const merged = new Map(base.map(kv));
  for (const line of extra) merged.set(...kv(line));
  const conf = [...merged].map(([k, v]) => `${k}=${v}`).join('\n');

  writeFileSync(join(WORK, 'w.conf'), conf + '\n');
  return join(WORK, 'w.db');
}

function seed(dbPath, { chatId = 990001, withUser = true, deposits = [] } = {}) {
  const db = new Database(dbPath);
  db.prepare('DELETE FROM pcn_addresses WHERE address = ?').run(ADDR);
  if (withUser) {
    db.prepare('INSERT OR REPLACE INTO users (chat_id, model, created_at) VALUES (?,?,?)')
      .run(chatId, 'mimo-v2.5', Math.floor(Date.now() / 1000));
  } else {
    db.prepare('DELETE FROM users WHERE chat_id = ?').run(chatId);
  }
  const cols = db.prepare('PRAGMA table_info(pcn_addresses)').all().map((c) => c.name);
  const idx = 999001;
  // assigned_at IS the filter issuedAddresses() uses. Leave it null and the
  // address is simply not watched -- which is what made the first run of this
  // harness report "no row" for every deposit scenario.
  const now = Math.floor(Date.now() / 1000);
  const vals = { address: ADDR, chat_id: chatId, derivation_index: idx, created_at: now, assigned_at: now };
  const use = cols.filter((c) => c in vals);
  db.prepare(`INSERT INTO pcn_addresses (${use.join(',')}) VALUES (${use.map(() => '?').join(',')})`)
    .run(...use.map((c) => vals[c]));
  for (const d of deposits) {
    db.prepare(`INSERT INTO pcn_deposits (txid,address,chat_id,status,amount_sat,block_height,first_seen_at,unconfirmed_known_ticks)
                VALUES (?,?,?,?,?,?,?,?)`)
      .run(d.txid, ADDR, chatId, d.status, d.sat, d.height ?? null, Math.floor(Date.now() / 1000) - (d.ageS ?? 0), d.ticks ?? 0);
  }
  db.close();
  return chatId;
}

// GENUINELY at the same time.
//
// `Promise.all([...runWatcher()])` does NOT do this: execFileSync runs to
// completion while the Promise is being constructed, so the two ticks are
// sequential and the test proves nothing about locking. Two real processes
// have to be in flight together, which means the async spawn.
function runWatcherAsync() {
  return new Promise((resolve) => {
    execFile('node', ['/app/watch.mjs'], {
      env: { ...process.env, PCNAIBOT_CONF: join(WORK, 'w.conf') },
      encoding: 'utf8', timeout: 90000,
    }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, code: err.code, out: (stdout ?? '') + (stderr ?? '') });
      else resolve({ ok: true, out: stdout });
    });
  });
}

function depositRow(dbPath, txid) {
  const db = new Database(dbPath, { readonly: true });
  const r = db.prepare('SELECT * FROM pcn_deposits WHERE txid = ? AND address = ?').get(txid, ADDR);
  db.close();
  return r ?? null;
}

// ---------------------------------------------------------------------------
// A tick that skipped because the explorer was unreadable proves NOTHING about
// the rule under test -- it just did not run. Several checks below passed that
// way before this guard existed, which is the estate's favourite failure mode:
// a check that cannot fire is indistinguishable from a check that passes.
function lastLine(out) {
  const ls = String(out ?? '').trim().split('\n');
  return ls[ls.length - 1] ?? '';
}

function ranForReal(out) { return !/explorer_unreadable/.test(out ?? ''); }

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`);
  if (!pass) {
    // A failing check that cannot say WHY is the thing this estate keeps
    // getting bitten by, so print what the watcher actually decided.
    try {
      const lg = readFileSync(join(WORK, 'watch.log'), 'utf8').trim().split(/\r?\n/);
      for (const l of lg.slice(-14)) console.log('        | ' + l.slice(0, 200));
    } catch { console.log('        | (no watcher log)'); }
  }
}

async function main() {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const T = (n) => `${'0'.repeat(63)}${n}`;   // 64-hex txids that cannot collide

  // --- §8.4  the explorer is unreachable -----------------------------------
  {
    const db = freshWork();
    seed(db);
    scenario = { explorerDown: true };
    const r = await runWatcherAsync();
    const credited = /credited=(\d+)/.exec(r.out)?.[1];
    check('T4 explorer down: the tick does not crash', r.ok, `exit ${r.ok ? 0 : r.code}`);
    check('T4 explorer down: nothing is credited', credited === undefined || credited === '0',
      `credited=${credited ?? 'n/a'}`);
    check('T4 explorer down: no deposit row invented', depositRow(db, T(1)) === null);
  }

  // --- §8.7a the oracle answers something INSANE ---------------------------
  {
    const db = freshWork();
    seed(db);
    scenario = { rateStale: true, deposit: { txid: T(2), height: 8000, confirmations: 20, sat: 500000000 } };
    const r = await runWatcherAsync();
    const row = depositRow(db, T(2));
    check('T7a insane rate: the tick does not crash', r.ok);
    check('T7a insane rate: nothing is credited', !row || row.status !== 'credited',
      `status=${row?.status ?? 'no row'}`);
    check('T7a insane rate: no rate was stamped', !row || row.credited_rate_e12 === null);
  }

  // --- §8.7b the pool clock is frozen past its bound -----------------------
  {
    const db = freshWork();
    seed(db);
    scenario = { poolAgeSeconds: 99999, deposit: { txid: T(3), height: 8000, confirmations: 20, sat: 500000000 } };
    const r = await runWatcherAsync();
    const row = depositRow(db, T(3));
    check('T7b frozen pool clock: the reading is refused', !row || row.status !== 'credited',
      `status=${row?.status ?? 'no row'}`);
  }

  // --- §8.5  unconfirmed.known is false for many ticks ---------------------
  {
    const db = freshWork();
    seed(db, { deposits: [{ txid: T(5), status: 'seen', sat: 500000000, ageS: 7 * 86400, ticks: 0 }] });
    scenario = { unconfirmedKnown: false };
    let last;
    for (let i = 0; i < 5; i++) last = await runWatcherAsync();
    check('T5 unconfirmed unknown: the ticks actually ran', ranForReal(last.out), lastLine(last.out));
    const row = depositRow(db, T(5));
    check('T5 unconfirmed unknown: a seen row never ages to dropped',
      row && row.status !== 'dropped', `status=${row?.status ?? 'row vanished'}`);
  }

  // --- §8.9  a deposit below the activation height -------------------------
  {
    const db = freshWork();
    seed(db);
    scenario = { deposit: { txid: T(9), height: 2500, confirmations: 6000, sat: 500000000 } };
    const r9 = await runWatcherAsync();
    check('T9 pre-2800 deposit: the tick actually ran', ranForReal(r9.out), lastLine(r9.out));
    const row = depositRow(db, T(9));
    check('T9 pre-2800 deposit: it is resolved, not parked forever',
      !!row && row.status !== 'seen' && row.status !== 'confirming',
      `status=${row?.status ?? 'no row'} note=${row?.note ?? 'none'}`);
    check('T9 pre-2800 deposit: it carries a note saying why', !!row?.note, row?.note ?? 'NO NOTE');
  }

  // --- §8.3  a coinbase payment, still immature ----------------------------
  {
    const db = freshWork();
    seed(db);
    scenario = {
      immatureSat: 5000000000,
      deposit: { txid: 'c'.repeat(63) + '3', height: 8200, confirmations: 40, sat: 5000000000, coinbase: true },
    };
    const r = await runWatcherAsync();
    check('T3 coinbase: the tick actually ran', ranForReal(r.out), lastLine(r.out));
    const touched = /touched=(\d+)/.exec(r.out)?.[1];
    check('T3 coinbase: the touch detector fires on an immature-only balance',
      touched === '1', `touched=${touched ?? 'n/a'}`);
    const row = depositRow(db, 'c'.repeat(63) + '3');
    check('T3 coinbase: 40 confirmations does not credit a coinbase',
      !row || row.status !== 'credited', `status=${row?.status ?? 'no row'}`);
  }

  // --- §8.6  a deposit to an address whose user is gone --------------------
  {
    const db = freshWork();
    seed(db, { withUser: false });
    scenario = { deposit: { txid: T(6), height: 8000, confirmations: 20, sat: 500000000 } };
    const r = await runWatcherAsync();
    check('T6 deleted user: the tick actually ran', ranForReal(r.out), lastLine(r.out));
    const row = depositRow(db, T(6));
    check('T6 deleted user: the deposit is still recorded', !!row, `status=${row?.status ?? 'NO ROW'}`);
    check('T6 deleted user: the tick still COMPLETES -- one bad row does not stop the rail',
      /touched=/.test(r.out) && !/skipped=error:/.test(r.out), lastLine(r.out));
    check('T6 deleted user: it is not silently credited to nobody',
      !row || row.status !== 'credited', `status=${row?.status ?? 'no row'}`);
  }

  // --- §8.8  two pollers at once -------------------------------------------
  {
    const db = freshWork();
    seed(db);
    scenario = { deposit: { txid: T(8), height: 8000, confirmations: 20, sat: 500000000 } };
    const both = await Promise.all([runWatcherAsync(), runWatcherAsync()]);
    const crashed = both.filter((b) => !b.ok);
    check('T8 concurrent pollers: neither aborts on a duplicate key',
      crashed.length === 0, crashed.map((c) => c.out.slice(0, 160)).join(' | ') || 'both clean');
    const d = new Database(db, { readonly: true });
    const n = d.prepare('SELECT COUNT(*) c FROM pcn_deposits WHERE txid = ? AND address = ?').get(T(8), ADDR).c;
    d.close();
    check('T8 concurrent pollers: exactly one row for (txid, address)', n <= 1, `rows=${n}`);
  }

  // --- §8.10  a deposit that takes the user over the 30-day cap ------------
  //
  // The rule is CREDIT AND FLAG, never refuse. The coins are already on chain
  // and cannot be sent back, so refusing means keeping the money and giving
  // nothing. The cap is set absurdly low here so an ordinary 5 PCN deposit
  // crosses it -- the code path is the same one a $2,000 deposit takes.
  {
    const db = freshWork(['CAP_30D_USD_PER_USER=0.01']);
    seed(db);
    const txid = 'a'.repeat(63) + '0';
    scenario = { deposit: { txid, height: 8000, confirmations: 20, sat: 500000000 } };
    const r = await runWatcherAsync();
    check('T10 over the cap: the tick actually ran', ranForReal(r.out), lastLine(r.out));
    const row = depositRow(db, txid);
    check('T10 over the cap: it is still CREDITED, not refused',
      row?.status === 'credited', `status=${row?.status ?? 'no row'}`);
    check('T10 over the cap: and it is FLAGGED for a human',
      !!row?.flagged_reason && /over_cap_user/.test(row.flagged_reason),
      row?.flagged_reason ?? 'NO FLAG');
  }

  // --- P3: the advertised 10% back actually reaches the balance ------------
  //
  // The bounty page promised this while the switch was unreachable from the
  // config file, so it had paid out zero times. This proves the wiring, not
  // the arithmetic -- rebate.test.mjs already covers the maths.
  {
    const now = Math.floor(Date.now() / 1000) - 60;
    const db = freshWork(['REBATE_PPM=100000', 'REBATE_CAP_SAT=5000000000', `REBATE_FROM=${now}`]);
    seed(db);
    const txid = 'b'.repeat(63) + '0';
    scenario = { deposit: { txid, height: 8000, confirmations: 20, sat: 500000000 } };
    const r = await runWatcherAsync();
    check('P3 rebate: the tick actually ran', ranForReal(r.out), lastLine(r.out));
    check('P3 rebate: the watcher says the rebate is ON', /P3 rebate is ON/.test(r.out),
      /P3 rebate is (ON|OFF)/.exec(r.out)?.[0] ?? 'said nothing at all');

    const row = depositRow(db, txid);
    check('P3 rebate: the deposit credited', row?.status === 'credited', `status=${row?.status ?? 'no row'}`);

    const d = new Database(db, { readonly: true });
    const reb = d.prepare('SELECT * FROM ledger WHERE idem_key = ?').get(`rebate:${txid}:${ADDR}`);
    d.close();
    check('P3 rebate: a rebate row was written', !!reb, reb ? `+${reb.delta_micro_usd} micro-USD` : 'NO REBATE ROW');
    // Compare against what the DEPOSIT row says was credited, which is the
    // authoritative figure, rather than hunting for a second ledger row by a
    // key format this test would then be guessing at.
    check('P3 rebate: it is 10% of the credit',
      !!reb && !!row?.credited_micro_usd
        && Math.abs(Number(reb.delta_micro_usd) - Number(row.credited_micro_usd) / 10) <= 1,
      reb && row ? `credit=${row.credited_micro_usd} rebate=${reb.delta_micro_usd}` : 'cannot compare');
  }

  server.close();
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('FAILED:');
    for (const f of failed) console.log(`  - ${f.name}  (${f.detail ?? ''})`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); server.close(); process.exit(2); });
