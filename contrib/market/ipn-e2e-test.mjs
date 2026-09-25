#!/usr/bin/env node
// The payment callback END TO END: a copy of the real server.mjs, started as a
// process, against a THROWAWAY database and a fake node.
//
//   PCOIN_IPN_TEST_HOST=127.0.0.1 PCOIN_IPN_TEST_PORT=3306 PCOIN_IPN_TEST_USER=root \
//   PCOIN_IPN_TEST_PASS= node ipn-e2e-test.mjs
//
// ipn-test.mjs proves the decisions. This proves the wiring in server.mjs that
// no unit test can see: the /ipn route hands ipn.mjs the body as BYTES; until
// orders-payment.sql has run, callbacks answer 503 (a signed one logged, an
// unsigned one still 401) and /api/buy takes no orders, and both open again
// without a restart once it has; a paid callback goes all the way to one send.
//
// The copy runs from a temporary directory beside the node_modules this test
// loads mysql2 from (so the copy finds it too), removed at the end. Every
// '/opt/pcoin-market/' in server.mjs points there, the Telegram config at a file that does not exist
// (alerts go to stdout, never to Telegram), and delivery.mjs's public purchase
// announcement at a spool directory that does not exist. Each patch is counted and the
// test refuses to start if one did not apply. The config it writes points every
// service at 127.0.0.1, with test-only secrets. The price watch still reads the
// public price.pc.am once at startup, as the server always does. Run it on a
// development machine, with a MariaDB where it may create and drop the
// database pcm_ipn_test_e2e.
//
// PCOIN_IPN_E2E_SRC=<dir> runs another copy of the market files (how a reverted
// fix is shown to fail this test).

import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { createHmac, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, readdirSync, copyFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import mysql from 'mysql2/promise';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = process.env.PCOIN_IPN_E2E_SRC || HERE;
const DBN = 'pcm_ipn_test_e2e';
const DB = {
  host: process.env.PCOIN_IPN_TEST_HOST || '127.0.0.1',
  port: Number(process.env.PCOIN_IPN_TEST_PORT || 3306),
  user: process.env.PCOIN_IPN_TEST_USER || 'root',
  password: process.env.PCOIN_IPN_TEST_PASS || '',
};
const SECRET = 'e2e-only-ipn-secret';
const SESSION = 'e2e-only-session-secret';
const WEBPORT = Number(process.env.PCOIN_IPN_E2E_PORT || 38789);
const RPCPORT = WEBPORT + 1;

// ── the app copy ────────────────────────────────────────────────────────────
const mysqlMain = createRequire(import.meta.url).resolve('mysql2');
const NODE_MODULES = mysqlMain.slice(0, mysqlMain.lastIndexOf('node_modules') + 'node_modules'.length);
const APP = mkdtempSync(join(dirname(NODE_MODULES), '.pcm-ipn-e2e-'));
const APPP = APP.replace(/\\/g, '/') + '/';
for (const f of readdirSync(SRC)) if (/\.(mjs|css|html|sql)$/.test(f)) copyFileSync(join(SRC, f), join(APP, f));

function patch(file, pairs) {
  let s = readFileSync(join(APP, file), 'utf8');
  for (const [from, to, want] of pairs) {
    const n = s.split(from).length - 1;
    if (want === undefined ? n < 1 : n !== want) {
      throw new Error(`REFUSING: ${file} has ${n} of ${JSON.stringify(from)}, expected ${want ?? 'at least 1'}`);
    }
    s = s.split(from).join(to);
  }
  writeFileSync(join(APP, file), s);
}
patch('server.mjs', [
  ['/opt/pcoin-market/', APPP],
  ['const PORT  = 8789;', `const PORT  = ${WEBPORT};`, 1],
  ["readNotifyConfig('/etc/pcoin/alert.conf')", `readNotifyConfig('${APPP}no-such-alert.conf')`, 1],
]);
// The purchase post is a request file in a spool a root timer drains
// (delivery.mjs ANNOUNCE_SPOOL). Aimed at a directory that does not exist, the
// write fails, is logged, and nothing is announced.
patch('delivery.mjs', [["'/var/lib/pcoin-market/announce-spool'", `'${APPP}no-such-announce-spool'`, 1]]);
// Nothing the server loads may still name a production path it would act on.
{
  const seen = new Set(), todo = ['server.mjs'];
  while (todo.length) {
    const f = todo.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    const s = readFileSync(join(APP, f), 'utf8');
    for (const m of s.matchAll(/from '\.\/([\w-]+\.mjs)'/g)) todo.push(m[1]);
    for (const bad of ['/opt/pcoin-market', '/etc/pcoin/', '/usr/local/bin/', '/var/lib/pcoin-market/']) {
      if (s.split('\n').some(l => l.includes(bad) && !/^\s*(\/\/|\*)/.test(l))) {
        throw new Error(`REFUSING: ${f} still names ${bad} after patching`);
      }
    }
  }
}
writeFileSync(join(APP, 'config.json'), JSON.stringify({
  publicUrl: 'http://127.0.0.1', nowpaymentsApiKey: 'not-a-key', ipnSecret: SECRET, sessionSecret: SESSION,
  db: { ...DB, database: DBN },
  nodeRpcUrl: `http://127.0.0.1:${RPCPORT}`, rpcAuth: 'e2e:e2e', hotWallet: 'market-hot',
  explorerUrl: 'http://127.0.0.1:9', ownerAddress: 'pc1qowner',
}));

// ── the fake node ───────────────────────────────────────────────────────────
const sends = [];
const rpc = createServer((req, res) => {
  let b = '';
  req.on('data', c => { b += c; });
  req.on('end', () => {
    const { method, params } = JSON.parse(b);
    let result = null;
    if (method === 'getbalances') result = { mine: { trusted: 10_000_000 } };
    else if (method === 'listtransactions') {
      result = sends.map(s => ({ txid: s.txid, comment: s.comment, category: 'send', confirmations: 1 }));
    } else if (method === 'sendtoaddress') {
      const txid = createHash('sha256').update(`${params[2]}|${sends.length}`).digest('hex');
      sends.push({ txid, to: params[0], amount: params[1], comment: params[2] });
      result = txid;
    } else if (method === 'getaddressesbylabel') result = { pc1qfloat: { purpose: 'receive' } };
    else { res.end(JSON.stringify({ error: { code: -32601, message: `fake node: ${method}` } })); return; }
    res.end(JSON.stringify({ result, error: null }));
  });
}).listen(RPCPORT, '127.0.0.1');

// ── the database, WITHOUT the migration ─────────────────────────────────────
const root = await mysql.createConnection({ ...DB, multipleStatements: true });
await root.query(`SET SESSION sql_mode='STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_AUTO_CREATE_USER,NO_ENGINE_SUBSTITUTION'`);
await root.query(`DROP DATABASE IF EXISTS \`${DBN}\`; CREATE DATABASE \`${DBN}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; USE \`${DBN}\`;`);
// production's tables as of 2026-09-24 (SHOW CREATE TABLE), before orders-payment.sql
await root.query(`
CREATE TABLE orders (
  order_id varchar(40) NOT NULL, email varchar(190) NOT NULL, usd decimal(14,2) NOT NULL,
  address varchar(90) NOT NULL, quoted_pcn decimal(24,8) NOT NULL, quoted_price decimal(18,10) NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'pending', invoice_id varchar(64) DEFAULT NULL,
  invoice_url text DEFAULT NULL, paid_amount decimal(24,8) DEFAULT NULL,
  pay_currency varchar(24) DEFAULT NULL, delivered_txid char(64) DEFAULT NULL,
  created_at timestamp NOT NULL DEFAULT current_timestamp(), paid_at timestamp NULL DEFAULT NULL,
  delivery_mode varchar(8) DEFAULT NULL, delivery_error text DEFAULT NULL,
  delivered_at timestamp NULL DEFAULT NULL, ip varchar(64) DEFAULT NULL,
  user_agent varchar(255) DEFAULT NULL, geo_country char(2) DEFAULT NULL,
  geo_city varchar(128) DEFAULT NULL, geo_isp varchar(128) DEFAULT NULL,
  PRIMARY KEY (order_id), KEY idx_email (email), KEY idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE ipn_events (
  id bigint(20) unsigned NOT NULL AUTO_INCREMENT, payment_id varchar(64) NOT NULL,
  order_id varchar(40) DEFAULT NULL, status varchar(32) NOT NULL, raw mediumtext NOT NULL,
  received_at timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (id), UNIQUE KEY uq_payment_status (payment_id, status), KEY idx_order (order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE ladder_rungs (
  rung_no smallint(5) unsigned NOT NULL, price decimal(18,10) NOT NULL, qty_total decimal(24,8) NOT NULL,
  qty_sold decimal(24,8) NOT NULL DEFAULT 0, qty_reserved decimal(24,8) NOT NULL DEFAULT 0,
  qty_retired decimal(24,8) NOT NULL DEFAULT 0, PRIMARY KEY (rung_no),
  CONSTRAINT ck_rung_bounded CHECK (qty_sold + qty_reserved + qty_retired <= qty_total),
  CONSTRAINT ck_rung_nonneg CHECK (qty_sold >= 0 AND qty_reserved >= 0 AND qty_retired >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE ladder_fills (
  id bigint(20) unsigned NOT NULL AUTO_INCREMENT, order_id varchar(40) NOT NULL,
  rung_no smallint(5) unsigned NOT NULL, qty decimal(24,8) NOT NULL, price decimal(18,10) NOT NULL,
  state enum('reserved','sold','released') NOT NULL DEFAULT 'reserved',
  created_at timestamp NOT NULL DEFAULT current_timestamp(), settled_at timestamp NULL DEFAULT NULL,
  PRIMARY KEY (id), UNIQUE KEY uq_order_rung (order_id, rung_no), KEY idx_order (order_id), KEY idx_state (state)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE market_state (k varchar(64) NOT NULL, v text, PRIMARY KEY (k)) ENGINE=InnoDB;`);
for (let i = 1; i <= 6; i++) {
  await root.query(`INSERT INTO ladder_rungs (rung_no, price, qty_total) VALUES (?,?,?)`,
                   [i, (0.01 * i).toFixed(10), '1000000.00000000']);
}
const pool = mysql.createPool({ ...DB, database: DBN, decimalNumbers: false });
const q = async (s, a = []) => (await pool.query(s, a))[0];
const { makeLadder } = await import(pathToFileURL(join(APP, 'ladder.mjs')).href);
const L = makeLadder(pool);

let seq = 0;
/** $15: auto-sent (under the default $25 limit), and under the $20 a purchase
 *  is announced at -- the announcement is disabled above as well. */
async function newOrder(usd = 15) {
  const id = `E2E${++seq}${Date.now().toString(36)}`;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const w = await L.reserveLadder(conn, id, usd);
    await conn.query(`INSERT INTO orders (order_id, email, usd, address, quoted_pcn, quoted_price, status, invoice_id)
                      VALUES (?,?,?,?,?,?,'pending',?)`,
                     [id, 'e2e@example.com', usd, 'pc1qe2ebuyer', w.pcn.toFixed(8), w.avgPrice.toFixed(10),
                      String(7000000000 + seq)]);
    await conn.commit();
    return { id, usd, invoiceId: 7000000000 + seq, pid: 8000000000 + seq, pcn: w.pcn };
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
}
/** A callback shaped like NOWPayments' own, with a multi-byte character in it. */
const cb = (o, x = {}) => {
  const b = { actually_paid: 1, fee: { currency: 'sol', depositFee: 0, serviceFee: 0, withdrawalFee: 0 },
    invoice_id: o.invoiceId, order_description: 'PCN → pc1q', order_id: o.id, outcome_amount: 14.9,
    outcome_currency: 'usdcbase', parent_payment_id: null, pay_amount: 1, pay_currency: 'sol',
    payment_id: o.pid, payment_status: x.status || 'finished', price_amount: x.price ?? o.usd, price_currency: 'usd' };
  return JSON.stringify(Object.keys(b).sort().reduce((r, k) => { r[k] = b[k]; return r; }, {}));
};
const sign = raw => createHmac('sha512', SECRET).update(raw).digest('hex');
function http(path, raw, headers = {}, split = false) {
  return new Promise(resolve => {
    const buf = Buffer.from(raw, 'utf8');
    const r = request({ host: '127.0.0.1', port: WEBPORT, path, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': buf.length, ...headers } }, res => {
      let t = '';
      res.on('data', c => { t += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch { /* not JSON */ } resolve({ http: res.statusCode, body: j }); });
    });
    r.on('error', e => resolve({ http: 0, error: e.code || e.message }));
    if (split) {                                      // cut inside the 3-byte arrow
      const cut = buf.indexOf(0xe2) + 1;
      r.write(buf.subarray(0, cut));
      setTimeout(() => { r.end(buf.subarray(cut)); }, 30);
    } else r.end(buf);
  });
}
const post = (raw, sig = sign(raw), split = false) => http('/ipn', raw, { 'x-nowpayments-sig': sig }, split);
// A signed-in buyer, as server.mjs's own sign() mints the cookie.
const tokPayload = `e2e@example.com|${Date.now() + 3600_000}`;
const cookie = `mkt=${tokPayload}.${createHmac('sha256', SESSION).update(tokPayload).digest('hex')}`;
const buy = f => http('/api/buy', JSON.stringify(f), { cookie });

// ── run the server ──────────────────────────────────────────────────────────
let log = '', child = null;
async function start() {
  log = '';
  child = spawn(process.execPath, ['server.mjs'], { cwd: APP });
  child.stdout.on('data', c => { log += c; });
  child.stderr.on('data', c => { log += c; });
  for (let i = 0; i < 150; i++) {
    if (log.includes(`pcoin-market on 127.0.0.1:${WEBPORT}`)) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const gone = new Promise(r => child.once('exit', r));
  child.kill();
  await gone;
}
const MIGRATE = readFileSync(join(APP, 'orders-payment.sql'), 'utf8');
const UNMIGRATE = `ALTER TABLE orders DROP INDEX uq_paid_payment_id, DROP COLUMN paid_payment_id, DROP COLUMN invoice_usd;
                   ALTER TABLE ipn_events DROP COLUMN outcome, DROP COLUMN note;`;
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}${d ? `\n         ${d}` : ''}`); } };

try {
  // Each of the two routes re-checks for the migration on its own. They share
  // one flag, so each is shown opening again FIRST, in its own server run.
  console.log('# run 1: a callback is the first request after the migration');
  ok('the server starts without the migration', await start(), log.slice(-800));
  ok('and says the migration is missing', /MIGRATION MISSING/.test(log));

  const a = await newOrder();
  const r0 = await post(cb(a));
  ok('a signed callback is answered 503 until it has run', r0.http === 503, JSON.stringify(r0));
  const logged = await q(`SELECT payment_id, status, raw FROM ipn_events`);
  ok('it is logged all the same (old columns), and nothing is sent',
     logged.length === 1 && logged[0].payment_id === String(a.pid) && logged[0].raw === cb(a) && sends.length === 0,
     JSON.stringify(logged));
  const rBad = await post(cb(a, { status: 'confirmed' }), 'ab'.repeat(64));
  ok('an unsigned callback is still a 401 while paused, and not logged',
     rBad.http === 401 && Number((await q(`SELECT COUNT(*) n FROM ipn_events`))[0].n) === 1, JSON.stringify(rBad));
  const b0 = await buy({ usd: 0, address: 'pc1q' });
  ok('/api/buy takes no order until it has run', b0.http === 503 && /orders are paused/.test(b0.body?.error || ''),
     JSON.stringify(b0));

  await root.query(MIGRATE);
  const r1 = await post(cb(a), undefined, true);
  ok('after the migration, WITHOUT a restart, the same callback pays, its body split inside a character',
     r1.http === 200 && r1.body?.outcome === 'paid', JSON.stringify(r1));
  const [ra] = await q(`SELECT status, paid_payment_id, delivered_txid FROM orders WHERE order_id=?`, [a.id]);
  ok('delivered, tied to its payment, one send of the quote',
     ra.status === 'delivered' && ra.paid_payment_id === String(a.pid) && sends.length === 1 &&
     sends[0].comment === a.id && Math.abs(Number(sends[0].amount) - a.pcn) < 1e-8, JSON.stringify({ ra, sends }));
  const ea = await q(`SELECT outcome FROM ipn_events WHERE order_id=?`, [a.id]);
  ok('the row logged while paused now says paid', ea.length === 1 && ea[0].outcome === 'paid', JSON.stringify(ea));

  const r2 = await post(cb(a));
  ok('the retry is a duplicate', r2.http === 200 && r2.body?.outcome === 'duplicate' && sends.length === 1, JSON.stringify(r2));
  const r3 = await post(cb(a, { status: 'confirmed' }));
  ok('its confirmed is a duplicate too', r3.http === 200 && sends.length === 1, JSON.stringify(r3));
  const r4 = await post(cb(a), 'ab'.repeat(64));
  ok('a bad signature is 401', r4.http === 401);

  const b = await newOrder();
  const r5 = await post(cb(b, { price: 1 }));
  const [rb] = await q(`SELECT status FROM orders WHERE order_id=?`, [b.id]);
  ok('a $1 invoice under a $15 order is held, nothing sent',
     r5.body?.outcome === 'held' && rb.status === 'needs_review' && sends.length === 1, JSON.stringify(r5));
  ok('and the alert went to the (logged) channel', /Payment held for a human/.test(log));

  const big = '{"x":"' + 'a'.repeat(210_000) + '"}';
  const r6 = await post(big, sign(big));
  ok('an oversized body is refused (413 or reset), not left hanging', r6.http === 413 || r6.http === 0, JSON.stringify(r6));
  const r7 = await post('{"order_id":"x"}', sign('{"order_id":"x"}'));
  ok('a signed body naming no order is answered 200', r7.http === 200, JSON.stringify(r7));

  console.log('# run 2: an order is the first request after the migration');
  await stop();
  await root.query(UNMIGRATE);
  ok('the server starts again without the migration', await start(), log.slice(-800));
  const b2 = await buy({ usd: 0, address: 'pc1q' });
  ok('/api/buy takes no order', b2.http === 503 && /orders are paused/.test(b2.body?.error || ''), JSON.stringify(b2));
  await root.query(MIGRATE);
  const b3 = await buy({ usd: 0, address: 'pc1q' });
  ok('after the migration, WITHOUT a restart, /api/buy is open again (and judges the order)',
     b3.http === 400 && /minimum order/.test(b3.body?.error || ''), JSON.stringify(b3));
} finally {
  await stop();
  rpc.close();
  await pool.end();
  await root.query(`DROP DATABASE IF EXISTS \`${DBN}\``);
  await root.end();
  try { rmSync(APP, { recursive: true, force: true }); } catch { /* a temp dir */ }
}
console.log(`\n${pass} passed, ${fail} failed (the real server.mjs from ${SRC}, MariaDB ${DB.host}:${DB.port})`);
if (fail) console.log('--- server log tail ---\n' + log.slice(-3000));
process.exit(fail ? 1 : 0);
