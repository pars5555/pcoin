#!/usr/bin/env node
// The NOWPayments IPN (ipn.mjs) against a THROWAWAY database.
//
//   PCOIN_IPN_TEST_DB=pcm_ipn_test PCOIN_IPN_TEST_HOST=127.0.0.1 PCOIN_IPN_TEST_PORT=3306 \
//   PCOIN_IPN_TEST_USER=root PCOIN_IPN_TEST_PASS= node ipn-test.mjs
//
// It creates that database from nothing and drops it at the end, so it refuses
// any name that does not start with "pcm_ipn_test": it cannot be pointed at
// pcoin_market. The tables are production's (SHOW CREATE TABLE, 2026-09-23),
// the session runs production's sql_mode, and orders-payment.sql is applied on
// top exactly as a deploy applies it -- twice, to prove it can be.
//
// NOTHING IS PAID OUT. ladder.mjs and delivery.mjs run for real (the reserve,
// the settle, the delivery claim, the look-before-you-send, the record), but the
// node behind delivery is a fake wallet that remembers every sendtoaddress and
// never touches a chain.
//
// PCOIN_IPN_IMPL=<path> runs the same cases against another implementation of
// the makeIpn() interface: that is how the old server.mjs handler was measured
// against these rules, and how each fix was reverted to check its test fails.

import { createHmac, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import mysql from 'mysql2/promise';
import { makeLadder } from './ladder.mjs';
import { makeDelivery } from './delivery.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const IMPL = process.env.PCOIN_IPN_IMPL
  ? pathToFileURL(resolve(process.env.PCOIN_IPN_IMPL)).href : './ipn.mjs';
const MOD = await import(IMPL);

const DBN = process.env.PCOIN_IPN_TEST_DB || 'pcm_ipn_test';
if (!/^pcm_ipn_test\w*$/.test(DBN)) {
  console.error(`REFUSING: PCOIN_IPN_TEST_DB must start with "pcm_ipn_test" (got "${DBN}"). ` +
                `This test drops and recreates the database it is given.`);
  process.exit(2);
}
const CONN = {
  host: process.env.PCOIN_IPN_TEST_HOST || '127.0.0.1',
  port: Number(process.env.PCOIN_IPN_TEST_PORT || 3306),
  user: process.env.PCOIN_IPN_TEST_USER || 'root',
  password: process.env.PCOIN_IPN_TEST_PASS || '',
};
const SQL_MODE = 'STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_AUTO_CREATE_USER,NO_ENGINE_SUBSTITUTION';
const SECRET = 'test-only-ipn-secret';
const ADDR = 'pc1qtestbuyer0000000000000000000000000000';
const AUTO_MAX = 50;                                   // the live autoMaxUsd on 2026-09-24

// ── the database ────────────────────────────────────────────────────────────

const SCHEMA = [
  `CREATE TABLE orders (
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
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE ipn_events (
     id bigint(20) unsigned NOT NULL AUTO_INCREMENT, payment_id varchar(64) NOT NULL,
     order_id varchar(40) DEFAULT NULL, status varchar(32) NOT NULL, raw mediumtext NOT NULL,
     received_at timestamp NOT NULL DEFAULT current_timestamp(),
     PRIMARY KEY (id), UNIQUE KEY uq_payment_status (payment_id, status), KEY idx_order (order_id)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE ladder_rungs (
     rung_no smallint(5) unsigned NOT NULL, price decimal(18,10) NOT NULL, qty_total decimal(24,8) NOT NULL,
     qty_sold decimal(24,8) NOT NULL DEFAULT 0, qty_reserved decimal(24,8) NOT NULL DEFAULT 0,
     qty_retired decimal(24,8) NOT NULL DEFAULT 0, PRIMARY KEY (rung_no),
     CONSTRAINT ck_rung_bounded CHECK (qty_sold + qty_reserved + qty_retired <= qty_total),
     CONSTRAINT ck_rung_nonneg CHECK (qty_sold >= 0 AND qty_reserved >= 0 AND qty_retired >= 0)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE ladder_fills (
     id bigint(20) unsigned NOT NULL AUTO_INCREMENT, order_id varchar(40) NOT NULL,
     rung_no smallint(5) unsigned NOT NULL, qty decimal(24,8) NOT NULL, price decimal(18,10) NOT NULL,
     state enum('reserved','sold','released') NOT NULL DEFAULT 'reserved',
     created_at timestamp NOT NULL DEFAULT current_timestamp(), settled_at timestamp NULL DEFAULT NULL,
     PRIMARY KEY (id), UNIQUE KEY uq_order_rung (order_id, rung_no), KEY idx_order (order_id),
     KEY idx_state (state)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

const admin = await mysql.createConnection({ ...CONN, multipleStatements: true });
await admin.query(`SET SESSION sql_mode = '${SQL_MODE}'`);
await admin.query(`DROP DATABASE IF EXISTS \`${DBN}\``);
await admin.query(`CREATE DATABASE \`${DBN}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
await admin.query(`USE \`${DBN}\``);
for (const s of SCHEMA) await admin.query(s);
// A ladder deep enough that no test runs it dry: 6 rungs of 1,000,000 PCN.
for (let i = 1; i <= 6; i++) {
  await admin.query(`INSERT INTO ladder_rungs (rung_no, price, qty_total) VALUES (?,?,?)`,
                    [i, (0.01 * i).toFixed(10), '1000000.00000000']);
}
const [[ver]] = await admin.query(`SELECT VERSION() AS v`);

// Production (MariaDB 11.8) runs innodb_snapshot_isolation=ON, the 11.8
// default: a REPEATABLE READ transaction that locks or changes a row changed
// since its snapshot fails with ER_CHECKREAD instead of carrying on. 10.6.18+ /
// 10.11.8+ have the switch but default it OFF, 10.4 does not have it. Every
// session here runs production's setting wherever the server has it, so the
// races below meet the same errors they meet there.
const [[si]] = await admin.query(
  `SELECT COUNT(*) AS n FROM information_schema.SYSTEM_VARIABLES WHERE VARIABLE_NAME = 'INNODB_SNAPSHOT_ISOLATION'`)
  .catch(() => [[{ n: 0 }]]);
const SNAPSHOT_ISOLATION = Number(si.n) > 0 && process.env.PCOIN_IPN_TEST_SNAPSHOT !== '0';
const pool = mysql.createPool({ ...CONN, database: DBN, connectionLimit: 12, decimalNumbers: false });
pool.on('connection', c => {
  c.query(`SET SESSION sql_mode = '${SQL_MODE}'`);
  if (SNAPSHOT_ISOLATION) c.query(`SET SESSION innodb_snapshot_isolation = ON`);
});
const q = async (s, a = []) => (await pool.query(s, a))[0];

// ── the harness ─────────────────────────────────────────────────────────────

let pass = 0, fail = 0, skipped = 0;
const failures = [];
let current = '';
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(`${current} :: ${name}`); console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`); }
};
const alerts = [];
const quiet = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
const notify = async text => { alerts.push(String(text)); return true; };
const alertsLike = re => alerts.filter(a => re.test(a));

// The fake wallet. listtransactions shows every send; `crash` makes the NEXT
// sendtoaddress broadcast and then fail its answer, like an RPC timeout;
// `crashBlind` does the same and leaves listtransactions failing too (the
// correlated failure delivery.mjs describes); `hang` makes it broadcast NOTHING
// and never answer, like a process that died between recording its claim and
// sending; `balanceThrows` makes the balance read fail, which delivery reports
// as a crash; `gate` (a promise) holds every balance read until it settles,
// counting the readers held in `gated`.
const wallet = { sends: [], crash: false, crashBlind: false, unreadable: false, hang: false, balanceThrows: false,
                 gate: null, gated: 0 };
const node = {
  async wallet(method, params = []) {
    if (method === 'getbalances') {
      if (wallet.gate) { wallet.gated++; await wallet.gate; }
      if (wallet.balanceThrows) throw new Error('fake wallet: balance unreadable');
      return { mine: { trusted: 10_000_000 } };
    }
    if (method === 'listtransactions') {
      if (wallet.unreadable) throw new Error('fake wallet: unreadable');
      return wallet.sends.map(s => ({ txid: s.txid, comment: s.comment, category: 'send', confirmations: 1 }));
    }
    if (method === 'sendtoaddress') {
      if (wallet.hang) { wallet.hang = false; return new Promise(() => {}); }
      const [to, amount, comment] = params;
      const txid = createHash('sha256').update(`${comment}|${wallet.sends.length}|${to}`).digest('hex');
      wallet.sends.push({ txid, to, amount: Number(amount), comment });
      if (wallet.crash) { wallet.crash = false; throw new Error('fake wallet: answer lost after broadcast'); }
      if (wallet.crashBlind) {
        wallet.crashBlind = false; wallet.unreadable = true;
        throw new Error('fake wallet: answer lost after broadcast, and the node stopped answering');
      }
      return txid;
    }
    if (method === 'getaddressesbylabel') return { pc1qfloattopup: { purpose: 'receive' } };
    throw new Error(`fake wallet: unexpected ${method}`);
  },
};
const settings = { get: k => ({ autoMaxUsd: AUTO_MAX, floatTargetPcn: 8000, floatWarnPcn: 0,
                                floatStopPcn: 1000 })[k] };

// A pool whose NEXT statement matching `re` throws: a crash at that point.
function crashingPool(re) {
  let armed = true;
  return new Proxy(pool, {
    get(t, k) {
      if (k === 'query') {
        return (sql, args) => {
          if (armed && re.test(String(sql))) { armed = false; return Promise.reject(new Error('simulated crash')); }
          return t.query(sql, args);
        };
      }
      const v = t[k];
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

// A pool whose statements matching `re` run at once but ANSWER `ms` late: the
// commit is visible to every other connection while the caller still waits.
function slowPool(re, ms) {
  return new Proxy(pool, {
    get(t, k) {
      if (k === 'query') {
        return async (sql, args) => {
          const out = await t.query(sql, args);
          if (re.test(String(sql))) await new Promise(r => setTimeout(r, ms));
          return out;
        };
      }
      const v = t[k];
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}
const until = async (cond, what) => {
  for (let i = 0; i < 300; i++) { if (await cond()) return true; await new Promise(r => setTimeout(r, 10)); }
  throw new Error(`timed out waiting for ${what}`);
};

const L = makeLadder(pool);
const D = makeDelivery({ pool, node, notify, settings, log: quiet });
const hooks = { paid: [], underpaid: [] };
const build = (delivery = D, p = pool) => MOD.makeIpn({
  pool: p, ladder: L, delivery, notify, secret: SECRET, log: quiet,
  onPaid: d => hooks.paid.push(String(d.payment_id)),
  onUnderpaid: (d, usd) => hooks.underpaid.push([String(d.payment_id), usd]),
});
let IPN = build();

let seq = 0, pidSeq = 5100000000;
/** A pending order with its rungs reserved, the way /api/buy leaves it. */
async function newOrder({ usd = 20, storeInvoice = true } = {}) {
  const id = `T${(++seq).toString().padStart(3, '0')}${Date.now().toString(36)}`;
  const invoiceId = String(4000000000 + seq);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const w = await L.reserveLadder(conn, id, usd);
    await conn.query(
      `INSERT INTO orders (order_id, email, usd, address, quoted_pcn, quoted_price, status, invoice_id, invoice_url)
       VALUES (?,?,?,?,?,?, 'pending', ?, ?)`,
      [id, 'buyer@example.com', usd, ADDR, w.pcn.toFixed(8), w.avgPrice.toFixed(10),
       storeInvoice ? invoiceId : null, storeInvoice ? `https://nowpayments.io/payment/?iid=${invoiceId}` : null]);
    await conn.commit();
    return { id, usd, pcn: Number(w.pcn.toFixed(8)), price: w.avgPrice, invoiceId, pid: String(++pidSeq) };
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
}
const newPid = () => String(++pidSeq);

/** A callback shaped like NOWPayments' own: compact JSON, keys sorted. */
function body(o, x = {}) {
  const due = x.due ?? 0.19197548;
  const b = {
    actually_paid: x.paid === undefined ? due : x.paid,
    actually_paid_at_fiat: x.fiat ?? 0,
    fee: { currency: 'sol', depositFee: 0, serviceFee: 0, withdrawalFee: 0 },
    invoice_id: x.invoiceId === undefined ? Number(o.invoiceId) : x.invoiceId,
    order_description: `PCN to ${ADDR}`,
    order_id: o.id,
    outcome_amount: 19.9,
    outcome_currency: 'usdcbase',
    parent_payment_id: x.parent === undefined ? null : x.parent,
    pay_address: 'FakePayAddress111',
    pay_amount: due,
    pay_currency: x.cur ?? 'sol',
    payin_extra_id: null,
    payment_id: x.pid === undefined ? Number(o.pid) : x.pid,
    payment_status: x.status ?? 'finished',
    price_amount: x.price === undefined ? Number(o.usd) : x.price,
    price_currency: x.pcur === undefined ? 'usd' : x.pcur,
    purchase_id: '6000000001',
    updated_at: 1790000000000,
  };
  for (const k of x.omit || []) delete b[k];
  return b;
}
function callback(o, x = {}) {
  const b = body(o, x);
  const keys = x.unsorted ? Object.keys(b).reverse() : Object.keys(b).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + JSON.stringify(b[k])).join(',') + '}';
}
const sign = (raw, secret = SECRET) => createHmac('sha512', secret).update(raw).digest('hex');
const post = (raw, sig = sign(raw)) => IPN.handle(raw, sig);
const pay = (o, x = {}) => post(callback(o, x));

const row = async id => (await q(`SELECT * FROM orders WHERE order_id = ?`, [id]))[0];
const fills = async id => Object.fromEntries(
  (await q(`SELECT state, COUNT(*) AS n FROM ladder_fills WHERE order_id = ? GROUP BY state`, [id]))
    .map(r => [r.state, Number(r.n)]));
const sendsFor = id => wallet.sends.filter(s => s.comment === id);
const events = async (id) => q(`SELECT payment_id, status, outcome, note FROM ipn_events WHERE order_id = ? ORDER BY id`, [id]);
/** What the admin's Send (reviewed) does: admin.mjs order/send (and market-admin send --reviewed). */
async function adminSendReviewed(id, delivery = D) {
  const seen = await delivery.alreadySent(id);
  if (!seen.known || seen.txid) return { refused: true };
  await q(`UPDATE orders SET status='awaiting_delivery' WHERE order_id=? AND status='needs_review'`, [id]);
  return delivery.deliverForce(id);
}

async function test(title, fn) {
  current = title;
  console.log(`\n# ${title}`);
  alerts.length = 0;
  try { await fn(); } catch (e) {
    fail++; failures.push(`${title} (threw)`);
    console.log(`  FAIL threw: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e}`);
  }
}
const skip = (title, why) => { skipped++; console.log(`\n# ${title}\n  skip ${why}`); };

console.log(`database ${DBN} on MariaDB ${ver.v}, implementation ${IMPL}, ` +
            `innodb_snapshot_isolation ${SNAPSHOT_ISOLATION ? 'ON (as production)' : 'not available / off'}`);

// ── 0. the migration ────────────────────────────────────────────────────────

await test('migration: backfills what the old handler knew, and can run twice', async () => {
  // Orders shaped like production's on 2026-09-24, written BEFORE the
  // migration: a delivered order with one payment, a test order with two, the
  // partial whose usd was rewritten ($35 invoiced, 33.46 paid), an expired one.
  const mk = async (id, usd, status) => q(
    `INSERT INTO orders (order_id, email, usd, address, quoted_pcn, quoted_price, status, paid_at)
     VALUES (?,?,?,?,?,?,?, NOW())`, [id, 'old@example.com', usd, ADDR, '1000.00000000', '0.0200000000', status]);
  const ev = (pid, id, status, price) => q(`INSERT INTO ipn_events (payment_id, order_id, status, raw) VALUES (?,?,?,?)`,
    [pid, id, status, JSON.stringify({ payment_id: pid, order_id: id, payment_status: status, price_amount: price })]);
  await mk('MIG-DELIVERED', '20.00', 'delivered');
  await ev('9000000001', 'MIG-DELIVERED', 'confirmed', 20); await ev('9000000001', 'MIG-DELIVERED', 'finished', 20);
  await mk('MIG-TEST', '15.00', 'test_completed');
  await ev('TESTPAY-1', 'MIG-TEST', 'finished', 15); await ev('SECOND-PAYMENT', 'MIG-TEST', 'finished', 15);
  await mk('MIG-PARTIAL', '33.46', 'delivered');
  await ev('9000000002', 'MIG-PARTIAL', 'partially_paid', 35);
  await mk('MIG-EXPIRED', '50.00', 'expired');
  await ev('9000000003', 'MIG-EXPIRED', 'expired', 50);
  // Expired with a money EVENT on record (a short 'confirmed' that never
  // finished): it was never paid, so it must not be tied to that payment -- or
  // a genuine late payment would read as "another payment" and be refused.
  await mk('MIG-EXPIRED-SHORT', '30.00', 'expired');
  await ev('9000000004', 'MIG-EXPIRED-SHORT', 'confirmed', 30);

  const sql = readFileSync(join(HERE, 'orders-payment.sql'), 'utf8');
  await admin.query(sql);
  const snap = async () => (await q(`SELECT order_id, paid_payment_id, invoice_usd FROM orders
                                      WHERE order_id LIKE 'MIG-%' ORDER BY order_id`))
    .map(r => `${r.order_id}:${r.paid_payment_id}:${r.invoice_usd}`).join(' ');
  const first = await snap();
  ok('the delivered order is tied to its one payment', first.includes('MIG-DELIVERED:9000000001:null'), first);
  ok('the two-payment test order is left for the event log', first.includes('MIG-TEST:null:null'), first);
  ok('the rewritten partial gets its $35.00 invoice price back',
     first.includes('MIG-PARTIAL:9000000002:35.00'), first);
  ok('an unpaid order is not tied to anything', first.includes('MIG-EXPIRED:null:null'), first);
  ok('nor is an unpaid one with a money event on record', first.includes('MIG-EXPIRED-SHORT:null:null'), first);
  await admin.query(sql);
  ok('running it again changes nothing', (await snap()) === first);
  const [idx] = await admin.query(`SHOW INDEX FROM orders WHERE Key_name = 'uq_paid_payment_id'`);
  ok('paid_payment_id is UNIQUE', idx.length === 1 && Number(idx[0].Non_unique) === 0, JSON.stringify(idx));
  const [cols] = await admin.query(`SHOW COLUMNS FROM ipn_events WHERE Field IN ('outcome','note')`);
  ok('ipn_events has outcome and note', cols.length === 2);
});

// ── the signature ───────────────────────────────────────────────────────────

await test('signature: the raw body is what is verified first', async () => {
  const o = await newOrder();
  // Keys NOT sorted: only the raw bytes reproduce what was signed.
  const r = await pay(o, { unsorted: true });
  ok('an unsorted body signed as sent verifies', r.http === 200, JSON.stringify(r));
  ok('and pays', sendsFor(o.id).length === 1);
});

await test('signature: a nested number written with trailing zeros, signed as sent', async () => {
  // The fee object is nested, so the old market form re-serialised it with
  // JSON.stringify and wrote 0.10 as 0.1: a genuine callback of this shape was
  // a 401. Only the raw bytes reproduce it.
  const o = await newOrder();
  const raw = callback(o).replace('"depositFee":0,', '"depositFee":0.10,');
  const r = await post(raw);
  ok('verifies', r.http === 200, JSON.stringify(r));
  ok('and pays', sendsFor(o.id).length === 1);
});

await test('signature: the raw BYTES, not a decoding of them', async () => {
  // A body that is not valid UTF-8 cannot survive a decode and re-encode. The
  // HMAC is over what arrived.
  const o = await newOrder();
  const text = callback(o).replace('"order_description":"PCN to ', '"order_description":"PCN ÿ to ');
  const bytes = Buffer.from(text, 'utf8');
  const at = bytes.indexOf(0xc3);                        // the lead byte of U+00FF
  const broken = Buffer.concat([bytes.subarray(0, at), Buffer.from([0xff]), bytes.subarray(at + 2)]);
  const r = await IPN.handle(broken, sign(broken));
  ok('a Buffer signed over its own bytes verifies', r.http === 200, JSON.stringify(r));
  ok('and pays', sendsFor(o.id).length === 1);
});

await test('signature: the forms this market and NOWPayments\' sample sign still verify', async () => {
  const o = await newOrder();
  const raw = callback(o, { unsorted: true });
  const d = JSON.parse(raw);
  const sorted = '{' + Object.keys(d).sort().map(k => JSON.stringify(k) + ':' + JSON.stringify(d[k])).join(',') + '}';
  const r = await post(raw, sign(sorted));
  ok('a body signed over its sorted form verifies', r.http === 200, JSON.stringify(r));

  // A number written with trailing zeros at the TOP level: the old market
  // form kept "0.000" as sent; the raw body is unsorted, so only that form fits.
  const o2 = await newOrder();
  const zeros = s => s.replace('"actually_paid_at_fiat":0,', '"actually_paid_at_fiat":0.000,');
  const r2 = await post(zeros(callback(o2, { unsorted: true })), sign(zeros(callback(o2))));
  ok('including a value whose source text is not what JSON.stringify writes', r2.http === 200, JSON.stringify(r2));

  // NOWPayments' documented sample sorts EVERY level. A body whose nested fee
  // arrives in another order is verified against that form.
  const o3 = await newOrder();
  const b = body(o3);
  b.fee = { withdrawalFee: 0, serviceFee: 0, depositFee: 0, currency: 'sol' };
  const unsortedNested = JSON.stringify(Object.keys(b).sort().reduce((r0, k) => { r0[k] = b[k]; return r0; }, {}));
  const sortAll = v => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.keys(v).sort().reduce((r0, k) => { r0[k] = sortAll(v[k]); return r0; }, {}) : v);
  const r3 = await post(unsortedNested, sign(JSON.stringify(sortAll(b))));
  ok('a body signed over the recursively sorted form verifies', r3.http === 200, JSON.stringify(r3));
});

await test('signature: a wrong one touches nothing and pages once an hour', async () => {
  const o = await newOrder();
  const before = (await q(`SELECT COUNT(*) AS n FROM ipn_events`))[0].n;
  const r1 = await post(callback(o), sign(callback(o), 'not-the-secret'));
  const r2 = await post(callback(o), 'deadbeef');
  const r3 = await post(callback(o), '');
  const after = (await q(`SELECT COUNT(*) AS n FROM ipn_events`))[0].n;
  ok('401', r1.http === 401 && r2.http === 401 && r3.http === 401);
  ok('nothing logged, nothing paid', Number(after) === Number(before) && sendsFor(o.id).length === 0);
  ok('one alert, not three', alertsLike(/bad signature/).length === 1, `${alertsLike(/bad signature/).length}`);
  ok('the order is untouched', (await row(o.id)).status === 'pending');
});

await test('signature: an upper-case hex signature is the same signature', async () => {
  const o = await newOrder();
  const raw = callback(o);
  const r = await post(raw, sign(raw).toUpperCase());
  ok('verifies', r.http === 200, JSON.stringify(r));
});

await test('body: a character split across two chunks survives', async () => {
  if (typeof MOD.readRawBody !== 'function') { ok('readRawBody exists', false); return; }
  const text = '{"order_description":"PCN → pc1q","n":1}';
  const bytes = Buffer.from(text, 'utf8');
  const cut = bytes.indexOf(0xe2) + 1;                  // inside the 3-byte arrow
  const req = new EventEmitter();
  req.destroy = () => {};
  const p = MOD.readRawBody(req);
  req.emit('data', bytes.subarray(0, cut));
  req.emit('data', bytes.subarray(cut));
  req.emit('end');
  const got = await p;
  ok('the bytes arrive whole', Buffer.from(got).equals(bytes));
});

await test('body: an oversized body is refused, not left hanging', async () => {
  if (typeof MOD.readRawBody !== 'function') { ok('readRawBody exists', false); return; }
  const req = new EventEmitter();
  let destroyed = false;
  req.destroy = () => { destroyed = true; };
  const p = MOD.readRawBody(req, 10);
  req.emit('data', Buffer.alloc(11));
  let code = null;
  try { await Promise.race([p, new Promise((_, j) => setTimeout(() => j(new Error('hung')), 500))]); }
  catch (e) { code = e.code || e.message; }
  ok('rejected as too large', code === 'BODY_TOO_LARGE' && destroyed, String(code));
});

// ── R1: 'confirmed' pays only when paid in full ─────────────────────────────

await test('R1: a short confirmed does nothing', async () => {
  const o = await newOrder();
  const r = await pay(o, { status: 'confirmed', paid: 0.19197548 * 0.999 });
  const w = await row(o.id);
  ok('200', r.http === 200);
  ok('nothing sent', sendsFor(o.id).length === 0);
  ok('still pending, rungs still reserved', w.status === 'pending' && (await fills(o.id)).reserved > 0, w.status);
  ok('no alert', alerts.length === 0, alerts.join(' || '));
});

await test('R1: 99% at confirmed is still short', async () => {
  const o = await newOrder();
  await pay(o, { status: 'confirmed', due: 100, paid: 99 });
  ok('nothing sent', sendsFor(o.id).length === 0);
  ok('still pending', (await row(o.id)).status === 'pending');
});

await test('R1: a confirmed with no readable amount waits', async () => {
  const o = await newOrder();
  await pay(o, { status: 'confirmed', omit: ['actually_paid'] });
  ok('nothing sent', sendsFor(o.id).length === 0);
  ok('still pending', (await row(o.id)).status === 'pending');
});

await test('R1: confirmed in full pays once; the finished after it is a duplicate', async () => {
  const o = await newOrder();
  await pay(o, { status: 'confirmed', due: 19.99041427, paid: 20 });
  const n1 = alerts.length;
  await pay(o, { status: 'finished', due: 19.99041427, paid: 20 });
  const w = await row(o.id);
  ok('one send, of the quote', sendsFor(o.id).length === 1 && Math.abs(sendsFor(o.id)[0].amount - o.pcn) < 1e-8,
     JSON.stringify(sendsFor(o.id)));
  ok('delivered, tied to the payment', w.status === 'delivered' && w.paid_payment_id === o.pid,
     `${w.status} ${w.paid_payment_id}`);
  ok('the finished raised no alert', alerts.length === n1, alerts.slice(n1).join(' || '));
  ok('the paid hook ran once', hooks.paid.filter(p => p === o.pid).length === 1);
});

// ── R2: 'finished' pays at 99.5%; below that a human decides ────────────────

await test('R2: finished at 99.6% pays in full', async () => {
  const o = await newOrder();
  await pay(o, { due: 1, paid: 0.996 });
  ok('one send of the whole quote', sendsFor(o.id).length === 1 && Math.abs(sendsFor(o.id)[0].amount - o.pcn) < 1e-8);
});

await test('R2: finished at 99.2% is an underpayment, held for a human', async () => {
  const o = await newOrder();
  await pay(o, { due: 1, paid: 0.992 });
  const w = await row(o.id);
  ok('nothing sent', sendsFor(o.id).length === 0);
  ok('needs_review, tied to the payment', w.status === 'needs_review' && w.paid_payment_id === o.pid);
  ok('set to what was paid', Math.abs(Number(w.quoted_pcn) - o.pcn * 0.992) < 1e-6 && w.usd === '19.84',
     `${w.quoted_pcn} ${w.usd}`);
  ok('the invoice price is kept', w.invoice_usd === '20.00', w.invoice_usd);
  ok('one alert', alertsLike(/Partial payment/).length === 1, alerts.join(' || '));
});

await test('R2: a partially_paid is priced from the ratio, never actually_paid_at_fiat', async () => {
  // Order Mmte1xvake1040f, 2026-08-29: $35, 0.000431 of 0.00045094 BTC.
  const o = await newOrder({ usd: 35 });
  await pay(o, { status: 'partially_paid', due: 0.00045094, paid: 0.000431, cur: 'btc', fiat: 33.455944 });
  const w = await row(o.id);
  const ratio = 0.000431 / 0.00045094;
  ok('nothing sent', sendsFor(o.id).length === 0);
  ok('usd from the ratio: 33.45, not the fiat field\'s 33.46', w.usd === (35 * ratio).toFixed(2), w.usd);
  ok('PCN from the ratio', Math.abs(Number(w.quoted_pcn) - o.pcn * ratio) < 1e-4, `${w.quoted_pcn} vs ${o.pcn * ratio}`);
  ok('the underpaid fee hook ran', hooks.underpaid.some(([p]) => p === o.pid));
});

await test('R2: a finished whose amount cannot be read is held, not paid', async () => {
  const o = await newOrder();
  await pay(o, { paid: 'about twenty' });
  const w = await row(o.id);
  ok('nothing sent', sendsFor(o.id).length === 0);
  ok('held for a human', w.status === 'needs_review' && /UNREADABLE/.test(w.delivery_error || ''), w.delivery_error);
});

await test('R2: a second partial is priced from the original, not the first partial', async () => {
  const o = await newOrder();
  await pay(o, { status: 'partially_paid', due: 1, paid: 0.5 });
  await pay(o, { status: 'partially_paid', due: 1, paid: 0.97 });
  const w = await row(o.id);
  ok('97% of the quote, not 97% of 50%', Math.abs(Number(w.quoted_pcn) - o.pcn * 0.97) < 1e-6, w.quoted_pcn);
  ok('97% of the invoice', w.usd === '19.40', w.usd);
  ok('the new amount was reported', alertsLike(/More money/).length === 1, alerts.join(' || '));
  ok('nothing sent', sendsFor(o.id).length === 0);
});

await test('R2: the rest arriving on the held payment raises the release, still held', async () => {
  const o = await newOrder();
  await pay(o, { status: 'partially_paid', due: 1, paid: 0.8 });
  await pay(o, { status: 'finished', due: 1, paid: 1 });
  const w = await row(o.id);
  ok('the release is now the whole quote', Math.abs(Number(w.quoted_pcn) - o.pcn) < 1e-8, w.quoted_pcn);
  ok('still needs_review, nothing sent', w.status === 'needs_review' && sendsFor(o.id).length === 0);
  const r = await adminSendReviewed(o.id);
  ok('Send (reviewed) releases it once', sendsFor(o.id).length === 1 && !r.refused);
  await pay(o, { status: 'finished', due: 1, paid: 1 });
  ok('a repeat after that sends nothing', sendsFor(o.id).length === 1);
});

await test('R2: a short confirmed then partially_paid pages once', async () => {
  const o = await newOrder();
  await pay(o, { status: 'confirmed', due: 1, paid: 0.844 });
  await pay(o, { status: 'partially_paid', due: 1, paid: 0.844 });
  ok('one alert', alerts.length === 1, alerts.join(' || '));
  ok('nothing sent', sendsFor(o.id).length === 0);
});

await test('R2: a paid-in-full confirmed on a manual order, then a short finished: held before anyone sends', async () => {
  const o = await newOrder({ usd: 100 });               // above autoMaxUsd: waits for a human
  await pay(o, { status: 'confirmed', due: 1, paid: 1 });
  ok('accepted, waiting for a human', (await row(o.id)).status === 'awaiting_delivery');
  await pay(o, { status: 'finished', due: 1, paid: 0.9 });
  const w = await row(o.id);
  ok('held in needs_review', w.status === 'needs_review' && /now reports/.test(w.delivery_error || ''), `${w.status} ${w.delivery_error}`);
  ok('a human is told', alertsLike(/now reports less/).length === 1, alerts.join(' || '));
  ok('nothing sent', sendsFor(o.id).length === 0);
});

// ── R3: a child payment is never paid automatically ─────────────────────────

await test('R3: a child payment in full is held for a human', async () => {
  const o = await newOrder();
  await pay(o, { parent: 5099999999 });
  const w = await row(o.id);
  ok('nothing sent', sendsFor(o.id).length === 0);
  ok('needs_review, CHILD PAYMENT', w.status === 'needs_review' && /CHILD PAYMENT/.test(w.delivery_error || ''), w.delivery_error);
  ok('one alert', alertsLike(/CHILD PAYMENT/).length === 1);
});

await test('R3: a child paid in full at confirmed is held too', async () => {
  const o = await newOrder();
  await pay(o, { status: 'confirmed', parent: '5099999997' });
  ok('nothing sent', sendsFor(o.id).length === 0);
  ok('held', (await row(o.id)).status === 'needs_review');
});

await test('R3: null, "", 0 and "0" all mean no parent', async () => {
  for (const parent of [null, '', 0, '0']) {
    const o = await newOrder();
    await pay(o, { parent });
    ok(`parent ${JSON.stringify(parent)} pays`, sendsFor(o.id).length === 1);
  }
});

await test('R3: a child of the payment that already paid pays nothing and tells a human', async () => {
  const o = await newOrder();
  await pay(o);
  const child = newPid();
  await pay(o, { pid: Number(child), parent: Number(o.pid), due: 0.05, paid: 0.05 });
  ok('one send in all', sendsFor(o.id).length === 1);
  ok('the human is told', alertsLike(new RegExp(`Another payment[\\s\\S]*${child}`)).length === 1, alerts.join(' || '));
});

// ── R4: another payment on a paid order ─────────────────────────────────────

await test('R4: a second payment on a delivered order pays nothing and tells a human', async () => {
  const o = await newOrder();
  await pay(o);
  const b = newPid();
  const r = await pay(o, { pid: Number(b) });
  const w = await row(o.id);
  ok('one send in all', sendsFor(o.id).length === 1);
  ok('still delivered, still tied to the first', w.status === 'delivered' && w.paid_payment_id === o.pid);
  ok('the alert names both payments', alertsLike(new RegExp(`${o.pid}[\\s\\S]*${b}`)).length === 1, alerts.join(' || '));
  ok('outcome says so', r.body && r.body.outcome === 'needs_human', JSON.stringify(r.body));
  ok('the alert says to refund, and never to settle by hand',
     alertsLike(/Refund it in NOWPayments/).length === 1 && alertsLike(/settle it by hand/i).length === 0,
     alerts.join(' || '));
});

await test('R4: its confirmed and its finished page once, not twice', async () => {
  const o = await newOrder();
  await pay(o);
  const b = newPid();
  await pay(o, { pid: Number(b), status: 'confirmed' });
  await pay(o, { pid: Number(b), status: 'finished' });
  ok('one alert for the one extra payment', alertsLike(/Another payment/).length === 1, alerts.join(' || '));
});

await test('R4: a second payment on a manual order waiting for a human', async () => {
  const o = await newOrder({ usd: 100 });
  await pay(o);
  const b = newPid();
  const n = alertsLike(/Manual delivery needed/).length;
  await pay(o, { pid: Number(b) });
  ok('nothing sent', sendsFor(o.id).length === 0);
  ok('no second "manual delivery needed"', alertsLike(/Manual delivery needed/).length === n);
  ok('the human is told the market sends once per order',
     alertsLike(/Another payment[\s\S]*ONCE per order/).length === 1, alerts.join(' || '));
  await adminSendReviewed(o.id);
  ok('the operator\'s send goes out once', sendsFor(o.id).length === 1);
});

await test('R4: two payments racing for one order: one wins, one goes to a human', async () => {
  const o = await newOrder();
  const b = newPid();
  const rs = await Promise.all([pay(o), pay(o, { pid: Number(b) })]);
  const w = await row(o.id);
  ok('both answered 200', rs.every(r => r.http === 200), JSON.stringify(rs.map(r => r.body)));
  ok('one send', sendsFor(o.id).length === 1);
  ok('tied to one of them', [o.pid, b].includes(w.paid_payment_id), w.paid_payment_id);
  ok('the other went to a human', alertsLike(/Another payment/).length === 1, alerts.join(' || '));
});

if (MOD.makeIpn({ pool, ladder: L, delivery: D, notify, secret: SECRET, log: quiet })._internals) {
  await test('R4: a payment decided on a stale read cannot take an order another payment won', async () => {
    const o = await newOrder();
    const stale = (await q(`SELECT * FROM orders WHERE order_id = ?`, [o.id]))[0];
    await pay(o);                                        // payment A wins
    const b = newPid();
    const d = JSON.parse(callback(o, { pid: Number(b) }));
    const ev = { id: 0, fresh: true };
    const r = await IPN._internals.accept(stale, d, MOD.classify(d), b, ev, 0);
    const w = await row(o.id);
    ok('the order stays with A', w.paid_payment_id === o.pid && w.status === 'delivered', `${w.paid_payment_id} ${w.status}`);
    ok('one send', sendsFor(o.id).length === 1);
    ok('B goes to a human', r.body.outcome === 'needs_human', JSON.stringify(r.body));
  });
} else skip('R4: stale-read race', 'this implementation exposes no _internals');

if (MOD.makeIpn({ pool, ladder: L, delivery: D, notify, secret: SECRET, log: quiet })._internals) {
  await test('R8: the tie is the latch, whatever the status says', async () => {
    // A human put a tied order back into an unpaid-looking status by hand. The
    // status check alone would let another payment take it; the tie must not.
    for (const how of ['accept', 'hold']) {
      const o = await newOrder({ usd: 100 });
      const stale = (await q(`SELECT * FROM orders WHERE order_id = ?`, [o.id]))[0];
      await pay(o);                                      // payment A: tied, manual
      await q(`UPDATE orders SET status='expired' WHERE order_id=?`, [o.id]);
      const b = newPid();
      const d = JSON.parse(callback(o, { pid: Number(b) }));
      const ev = { id: 0, fresh: true };
      const r = how === 'accept'
        ? await IPN._internals.accept(stale, d, MOD.classify(d), b, ev, 0)
        : await IPN._internals.holdForHuman(stale, d, MOD.classify(d), b, ev,
                                            { code: 'CHILD PAYMENT', detail: 'test' }, 0);
      const w = await row(o.id);
      ok(`${how}: still tied to A, nothing sent, B to a human`,
         w.paid_payment_id === o.pid && sendsFor(o.id).length === 0 && r.body.outcome === 'needs_human',
         `${w.paid_payment_id} ${sendsFor(o.id).length} ${JSON.stringify(r.body)}`);
    }
  });
} else skip('R8: the tie is the latch', 'this implementation exposes no _internals');

await test('R4/R7: one payment can never pay two orders', async () => {
  const a = await newOrder();
  await pay(a);
  const b = await newOrder();
  // The same payment_id, naming ANOTHER order whose invoice it otherwise matches.
  const r = await pay(b, { pid: Number(a.pid) });
  const w = await row(b.id);
  ok('nothing sent for the second order', sendsFor(b.id).length === 0);
  ok('the second order is untouched', w.status === 'pending' && w.paid_payment_id === null, `${w.status} ${w.paid_payment_id}`);
  ok('a human is told', alertsLike(/One payment, two orders/).length === 1, alerts.join(' || '));
  ok('outcome needs_human', r.body.outcome === 'needs_human', JSON.stringify(r.body));
});

await test('R4/R7: one payment, two orders, on a database that lost the UNIQUE index', async () => {
  // The code's own check, alone: the index is dropped for this case and put back.
  await admin.query(`ALTER TABLE orders DROP INDEX uq_paid_payment_id`);
  try {
    const a = await newOrder();
    await pay(a);
    const b = await newOrder();
    await pay(b, { pid: Number(a.pid) });
    const w = await row(b.id);
    ok('nothing sent for the second order', sendsFor(b.id).length === 0);
    ok('the second order is untouched', w.status === 'pending' && w.paid_payment_id === null, `${w.status} ${w.paid_payment_id}`);
  } finally {
    await admin.query(`ALTER TABLE orders ADD UNIQUE INDEX uq_paid_payment_id (paid_payment_id)`);
  }
});

if (MOD.makeIpn({ pool, ladder: L, delivery: D, notify, secret: SECRET, log: quiet })._internals) {
  await test('R4/R7: the UNIQUE index has the last word when the code check is raced', async () => {
    // accept() and holdForHuman() are handed an order the check never saw
    // tied, as a concurrent callback would be; the index refuses the tie.
    const a = await newOrder();
    await pay(a);
    for (const how of ['accept', 'hold']) {
      const b = await newOrder();
      const stale = (await q(`SELECT * FROM orders WHERE order_id = ?`, [b.id]))[0];
      const d = JSON.parse(callback(b, { pid: Number(a.pid) }));
      const ev = { id: 0, fresh: true };
      const r = how === 'accept'
        ? await IPN._internals.accept(stale, d, MOD.classify(d), a.pid, ev, 0)
        : await IPN._internals.holdForHuman(stale, d, MOD.classify(d), a.pid, ev,
                                            { code: 'CHILD PAYMENT', detail: 'test' }, 0);
      const w = await row(b.id);
      ok(`${how}: a human is told, the order is untouched, nothing sent`,
         r.body.outcome === 'needs_human' && w.status === 'pending' && w.paid_payment_id === null &&
         sendsFor(b.id).length === 0, `${JSON.stringify(r.body)} ${w.status}`);
    }
  });
} else skip('R4/R7: the UNIQUE index under a raced check', 'this implementation exposes no _internals');

// ── R5: the callback must match its invoice ─────────────────────────────────

await test('R5: a $1 invoice under a $20 order_id is held', async () => {
  const o = await newOrder();
  await pay(o, { price: 1 });
  const w = await row(o.id);
  ok('nothing sent', sendsFor(o.id).length === 0);
  ok('held: DOES NOT MATCH', w.status === 'needs_review' && /DOES NOT MATCH/.test(w.delivery_error || ''), w.delivery_error);
});

for (const [label, x, pays] of [
  ['a price one cent short', { price: 19.99 }, false],
  ['a price one cent over', { price: 20.01 }, false],
  ['a price as a numeric string', { price: '20' }, true],
  ['a price of 20.0', { price: 20.0 }, true],
  ['a price of "20.00"', { price: '20.00' }, true],
  ['price_currency USD in capitals', { pcur: 'USD' }, true],
  ['price_currency eur', { pcur: 'eur' }, false],
  ['price_currency missing', { omit: ['price_currency'] }, false],
  ['price_amount missing', { omit: ['price_amount'] }, false],
  ['price_amount not a number', { price: 'twenty' }, false],
  ['another invoice_id', { invoiceId: 4999999999 }, false],
  ['no invoice_id in the callback', { omit: ['invoice_id'] }, false],
]) {
  await test(`R5: ${label}`, async () => {
    const o = await newOrder();
    await pay(o, x);
    ok(pays ? 'pays' : 'held, nothing sent', sendsFor(o.id).length === (pays ? 1 : 0));
    if (!pays) ok('and the order is with a human', (await row(o.id)).status === 'needs_review');
  });
}

await test('R5: an order whose invoice id was never recorded is held, not judged on price alone', async () => {
  const o = await newOrder({ storeInvoice: false });
  await pay(o);
  const w = await row(o.id);
  ok('nothing sent', sendsFor(o.id).length === 0);
  ok('held: no recorded invoice id', w.status === 'needs_review' && /no recorded invoice id/.test(w.delivery_error || ''),
     w.delivery_error);
});

await test('R5: a failure callback that does not match its invoice does not close the order', async () => {
  // Another API key on the shared account can open an invoice under this
  // order id; its 'expired' must not hand this order's rungs back while the
  // buyer is paying ours.
  for (const [label, x] of [['another invoice_id', { invoiceId: 4999999998 }], ['another price', { price: 1 }]]) {
    const o = await newOrder();
    const r = await pay(o, { pid: Number(newPid()), status: 'expired', paid: 0, ...x });
    const w = await row(o.id);
    const f = await fills(o.id);
    ok(`${label}: still pending, rungs still reserved`, w.status === 'pending' && f.reserved > 0 && !f.released,
       `${w.status} ${JSON.stringify(f)}`);
    ok(`${label}: a human is told`, r.body && r.body.outcome === 'needs_human', JSON.stringify(r.body));
    await pay(o);
    ok(`${label}: the genuine payment then pays`, sendsFor(o.id).length === 1 && (await row(o.id)).status === 'delivered');
  }
  ok('one alert each', alertsLike(/does not match its invoice/).length === 2, alerts.join(' || '));
});

await test('R5: a sub-cent order matches its invoice in whole cents', async () => {
  const o = await newOrder({ usd: 20.005 });             // stored as 20.01
  await pay(o, { price: 20.005 });
  ok('pays', sendsFor(o.id).length === 1);
});

// ── R6: a duplicate is recognised before any alert ──────────────────────────

await test('R6: a duplicate on a delivered UNBACKED order stays silent and delivered', async () => {
  const o = await newOrder();
  await L.expireWithRelease(o.id, { reason: 'test' });   // rungs back on sale
  await pay(o, { status: 'confirmed' });
  const w1 = await row(o.id);
  ok('UNBACKED: held, nothing sent', w1.status === 'needs_review' && sendsFor(o.id).length === 0 &&
     /UNBACKED/.test(w1.delivery_error || ''), `${w1.status} ${w1.delivery_error}`);
  await adminSendReviewed(o.id);
  ok('the human sent it', (await row(o.id)).status === 'delivered' && sendsFor(o.id).length === 1);
  alerts.length = 0;
  await pay(o, { status: 'finished' });
  const w2 = await row(o.id);
  ok('still delivered', w2.status === 'delivered', w2.status);
  ok('no alert', alerts.length === 0, alerts.join(' || '));
  ok('one send', sendsFor(o.id).length === 1);
});

await test('R6: a short finished after the order was paid in full and sent raises nothing', async () => {
  const o = await newOrder();
  await pay(o, { status: 'confirmed', due: 1, paid: 1 });
  alerts.length = 0;
  await pay(o, { status: 'finished', due: 1, paid: 0.9 });
  ok('no alert', alerts.length === 0, alerts.join(' || '));
  ok('still delivered, one send', (await row(o.id)).status === 'delivered' && sendsFor(o.id).length === 1);
});

await test('R6: a manual order pages "manual delivery needed" once, not per callback', async () => {
  const o = await newOrder({ usd: 100 });
  await pay(o, { status: 'confirmed' });
  await pay(o, { status: 'finished' });
  await pay(o, { status: 'finished' });
  ok('one page', alertsLike(/Manual delivery needed/).length === 1, `${alertsLike(/Manual delivery needed/).length}`);
  ok('nothing sent', sendsFor(o.id).length === 0);
});

await test('R6: two deliveries racing on a manual order page once', async () => {
  const o = await newOrder({ usd: 100 });
  await q(`UPDATE orders SET status='awaiting_delivery', paid_at=NOW() WHERE order_id=?`, [o.id]);
  await Promise.all([D.deliver(o.id), D.deliver(o.id), D.deliver(o.id)]);
  ok('one page', alertsLike(/Manual delivery needed/).length === 1, `${alertsLike(/Manual delivery needed/).length}`);
});

// ── R7: idempotent across crashes and concurrent deliveries; refunds ────────

await test('R7: a crash between the send and its record never sends twice', async () => {
  const o = await newOrder();
  const crashing = makeDelivery({ pool: crashingPool(/SET status='delivered', delivered_txid/),
                                  node, notify, settings, log: quiet });
  IPN = build(crashing);
  await pay(o, { status: 'confirmed' });
  IPN = build();
  const w1 = await row(o.id);
  ok('left in sending, with one transaction out', w1.status === 'sending' && sendsFor(o.id).length === 1,
     `${w1.status} ${sendsFor(o.id).length}`);
  await pay(o, { status: 'finished' });
  await pay(o, { status: 'confirmed' });
  ok('retries send nothing more', sendsFor(o.id).length === 1);
  await q(`UPDATE orders SET paid_at = NOW() - INTERVAL 10 MINUTE WHERE order_id = ?`, [o.id]);
  await D.reconcileSending();
  const w2 = await row(o.id);
  ok('the sweep records the one that went', w2.status === 'delivered' && w2.delivered_txid === sendsFor(o.id)[0].txid);
});

await test('R7: a crash after the claim is recorded, before the send: never sent on a retry', async () => {
  // The process dies holding its claim: status 'sending', nothing broadcast.
  // It has its own delivery instance, as a process does: what it held in
  // memory dies with it.
  const o = await newOrder();
  wallet.hang = true;
  IPN = build(makeDelivery({ pool, node, notify, settings, log: quiet }));
  const dying = post(callback(o, { status: 'confirmed' }));   // never settles: the process "died"
  dying.catch(() => {});
  for (let i = 0; i < 200 && (await row(o.id)).status !== 'sending'; i++) await new Promise(r => setTimeout(r, 10));
  const w1 = await row(o.id);
  ok('the claim was recorded before the send', w1.status === 'sending' && sendsFor(o.id).length === 0,
     `${w1.status} ${sendsFor(o.id).length}`);
  IPN = build();                                              // the restarted process
  await pay(o, { status: 'finished' });
  await pay(o, { status: 'confirmed' });
  ok('the retries send nothing', sendsFor(o.id).length === 0);
  await q(`UPDATE orders SET paid_at = NOW() - INTERVAL 10 MINUTE WHERE order_id = ?`, [o.id]);
  await D.reconcileSending();
  const w2 = await row(o.id);
  ok('the sweep finds nothing sent and hands it to a human, without sending',
     w2.status === 'needs_review' && sendsFor(o.id).length === 0, `${w2.status} ${sendsFor(o.id).length}`);
  await pay(o, { status: 'finished' });
  ok('and a callback after that still sends nothing', sendsFor(o.id).length === 0);
});

await test('R7: the stuck-send sweep leaves a send that is still in flight alone', async () => {
  // An order paid long ago, sent now (the operator's Send, or a late
  // callback): its paid_at is past the sweep's grace the moment it is claimed.
  // The sweep must not read the wallet mid-send, find nothing, and hand it to
  // a human as "no transaction was found" -- the cue to send it again.
  const o = await newOrder({ usd: 100 });                // manual: waits for a human
  await pay(o);
  await q(`UPDATE orders SET paid_at = NOW() - INTERVAL 3 HOUR WHERE order_id = ?`, [o.id]);
  // The claim's own answer arrives late, so its commit is visible to the
  // sweep before the claiming call has read it.
  const inFlight = makeDelivery({ pool: slowPool(/SET status='sending', delivery_mode='auto'/, 400),
                                  node, notify, settings, log: quiet });
  // Send pressed twice at once: both get past every check (held at the
  // balance read) before either claims. sendtoaddress never answers: the
  // winner's send is on its way for as long as this test looks.
  let open;
  wallet.gate = new Promise(r => { open = r; });
  wallet.gated = 0;
  wallet.hang = true;
  const p1 = inFlight.deliverForce(o.id), p2 = inFlight.deliverForce(o.id);
  p1.catch(() => {}); p2.catch(() => {});
  try {
    await until(() => wallet.gated === 2, 'both Sends at the balance read');
  } finally { wallet.gate = null; open(); }
  await until(async () => (await row(o.id)).status === 'sending', 'the claim');
  await inFlight.reconcileSending();                     // the claim is visible, not yet answered
  const w0 = await row(o.id);
  ok('the sweep leaves a claim it has not seen answered', w0.status === 'sending', `${w0.status} ${w0.delivery_error}`);
  const loser = await Promise.race([p1, p2]);            // the winner never answers
  ok('one of the two Sends stands down', loser.ok && loser.already && sendsFor(o.id).length === 0, JSON.stringify(loser));
  await inFlight.reconcileSending();                     // the loser has left; the winner is still sending
  const w = await row(o.id);
  ok('still sending, not handed to a human', w.status === 'sending' && !/no transaction was found/.test(w.delivery_error || ''),
     `${w.status} ${w.delivery_error}`);
  ok('no "stuck send" alert', alertsLike(/Stuck send/).length === 0, alerts.join(' || '));
  // Another process's sweep (a restart, say) cannot see this one's sends and
  // does examine it -- which is the behaviour a crashed send needs.
  await D.reconcileSending();
  ok('a process that is not sending it does examine it', (await row(o.id)).status === 'needs_review');
});

await test('R7: a send whose fate was unknown is resolved by the same process\'s next sweep', async () => {
  // sendtoaddress broadcast, its answer was lost, and the wallet stopped
  // answering too: delivery leaves the order 'sending' for the sweep. The sweep
  // of the SAME process must still examine it once the send is over.
  const o = await newOrder();
  wallet.crashBlind = true;
  await pay(o);
  const w1 = await row(o.id);
  ok('left sending, unresolved, one transaction out', w1.status === 'sending' && sendsFor(o.id).length === 1,
     `${w1.status} ${sendsFor(o.id).length}`);
  wallet.unreadable = false;
  await q(`UPDATE orders SET paid_at = NOW() - INTERVAL 10 MINUTE WHERE order_id = ?`, [o.id]);
  await D.reconcileSending();
  const w2 = await row(o.id);
  ok('the sweep records the one that went, and sends nothing more',
     w2.status === 'delivered' && w2.delivered_txid === sendsFor(o.id)[0].txid && sendsFor(o.id).length === 1,
     `${w2.status} ${sendsFor(o.id).length}`);
});

await test('R7: a crash after accepting, before delivery, is finished by the retry', async () => {
  const o = await newOrder();
  let calls = 0;
  const dying = { ...D, deliver: async () => { calls++; throw new Error('simulated crash'); } };
  IPN = build(dying);
  let threw = false;
  try { await pay(o); } catch { threw = true; }
  IPN = build();
  ok('the first attempt died after accepting', threw && calls === 1 && (await row(o.id)).status === 'awaiting_delivery');
  await pay(o);
  ok('the retry sends it, once', sendsFor(o.id).length === 1 && (await row(o.id)).status === 'delivered');
});

await test('R7: the send answer lost on the wire is found, not repeated', async () => {
  const o = await newOrder();
  wallet.crash = true;
  await pay(o);
  await pay(o, { status: 'confirmed' });
  ok('one send', sendsFor(o.id).length === 1);
  ok('recorded', (await row(o.id)).status === 'delivered');
});

await test('R7: confirmed and finished arriving together send once', async () => {
  const o = await newOrder();
  const rs = await Promise.all([pay(o, { status: 'confirmed' }), pay(o, { status: 'finished' }),
                                pay(o, { status: 'finished' }), pay(o, { status: 'confirmed' })]);
  ok('all 200', rs.every(r => r.http === 200), JSON.stringify(rs.map(r => r.http)));
  ok('one send', sendsFor(o.id).length === 1);
  ok('delivered', (await row(o.id)).status === 'delivered');
});

await test('R7: a refund of a paid order that has not been sent holds it', async () => {
  const o = await newOrder({ usd: 100 });               // manual: waits for a human
  await pay(o);
  alerts.length = 0;
  await pay(o, { status: 'refunded' });
  const w = await row(o.id);
  ok('held in needs_review, marked REFUNDED', w.status === 'needs_review' && /^REFUNDED/.test(w.delivery_error || ''),
     `${w.status} ${w.delivery_error}`);
  ok('a human is told', alertsLike(/refunded the payment this order was paid with/).length === 1, alerts.join(' || '));
  const r = await D.deliver(o.id);
  ok('delivery refuses it', !r.ok && sendsFor(o.id).length === 0);
  await pay(o, { status: 'refunded' });
  ok('a repeat pages nobody', alerts.length === 1);
});

await test('R7: failed or expired for the paying payment holds an unsent order too', async () => {
  for (const status of ['failed', 'expired']) {
    const o = await newOrder({ usd: 100 });
    await pay(o);
    await pay(o, { status, paid: 0 });
    const w = await row(o.id);
    ok(`${status}: held, marked, nothing sent`,
       w.status === 'needs_review' && w.delivery_error.startsWith(status.toUpperCase()) && sendsFor(o.id).length === 0,
       `${w.status} ${w.delivery_error}`);
  }
  ok('a human is told each time', alertsLike(/the payment this order was paid with/).length === 2, alerts.join(' || '));
});

await test('R7: a refund after delivery reverses nothing and tells a human', async () => {
  const o = await newOrder();
  await pay(o);
  alerts.length = 0;
  await pay(o, { status: 'refunded' });
  const w = await row(o.id);
  ok('still delivered', w.status === 'delivered');
  ok('rungs still sold', (await fills(o.id)).sold > 0 && !(await fills(o.id)).released);
  ok('the alert says the PCN already went', alertsLike(/ALREADY SENT/).length === 1, alerts.join(' || '));
});

await test('R7: a refund while the send is in flight leaves the send to the sweep', async () => {
  const o = await newOrder();
  const crashing = makeDelivery({ pool: crashingPool(/SET status='delivered', delivered_txid/),
                                  node, notify, settings, log: quiet });
  IPN = build(crashing);
  await pay(o);
  IPN = build();
  alerts.length = 0;
  await pay(o, { status: 'refunded' });
  const w = await row(o.id);
  ok('still sending', w.status === 'sending');
  ok('the human is told to check the wallet', alertsLike(/in flight or unresolved/).length === 1, alerts.join(' || '));
});

await test('R7: failed / expired / refunded on an unpaid order: bookkeeping only', async () => {
  for (const status of ['expired', 'failed', 'refunded']) {
    const o = await newOrder();
    await pay(o, { status, paid: 0 });
    const w = await row(o.id);
    const f = await fills(o.id);
    ok(`${status}: the order closes and its rungs go back`, w.status === status && f.released > 0 && !f.reserved,
       `${w.status} ${JSON.stringify(f)}`);
  }
  ok('no alerts', alerts.length === 0, alerts.join(' || '));
});

await test('R7: an expired sibling payment does not touch a paid order', async () => {
  const o = await newOrder();
  await pay(o);
  await pay(o, { pid: Number(newPid()), status: 'expired', paid: 0 });
  ok('still delivered', (await row(o.id)).status === 'delivered');
  ok('silent', alerts.length === 0 || alertsLike(/expired/i).length === 0, alerts.join(' || '));
});

await test('R7: a failure callback without a payment_id on a paid order tells a human, changes nothing', async () => {
  const o = await newOrder({ usd: 100 });
  await pay(o);
  alerts.length = 0;
  await pay(o, { status: 'refunded', omit: ['payment_id'] });
  const w = await row(o.id);
  ok('unchanged', w.status === 'awaiting_delivery' && w.paid_payment_id === o.pid, `${w.status}`);
  ok('a human is told', alertsLike(/without a payment_id/).length === 1, alerts.join(' || '));
});

// ── R8: after a human, nothing pays twice ───────────────────────────────────

await test('R8: a partial settled by hand, then the rest arrives: nothing more is sent', async () => {
  const o = await newOrder();
  await pay(o, { status: 'partially_paid', due: 1, paid: 0.6 });
  await D.markDelivered(o.id, 'a'.repeat(64));           // sent from the cold wallet, recorded
  alerts.length = 0;
  await pay(o, { status: 'finished', due: 1, paid: 1 });
  await pay(o, { pid: Number(newPid()), parent: Number(o.pid), due: 0.4, paid: 0.4 });
  const w = await row(o.id);
  ok('nothing sent automatically', sendsFor(o.id).length === 0);
  ok('still delivered with the hand txid', w.status === 'delivered' && w.delivered_txid === 'a'.repeat(64));
  ok('only the child is reported', alerts.length === 1 && /Another payment/.test(alerts[0]), alerts.join(' || '));
});

await test('R8: a held child released by hand is never sent again', async () => {
  const o = await newOrder();
  await pay(o, { parent: 5099999998 });
  await adminSendReviewed(o.id);
  ok('sent once, by the human', sendsFor(o.id).length === 1);
  await pay(o, { parent: 5099999998 });
  await pay(o, { pid: Number(newPid()) });
  ok('still once', sendsFor(o.id).length === 1);
});

await test('R8: a human\'s Send that stalled is the human\'s -- a later callback never sends it', async () => {
  // Held (a child), the operator presses Send (reviewed), and delivery stops
  // before its claim (the balance read fails). The order is awaiting_delivery
  // again, with nothing recorded as sent -- exactly what it looks like after an
  // operator who then sends by hand from the cold wallet, before recording it.
  const o = await newOrder();
  await pay(o, { parent: 5099999996 });
  wallet.balanceThrows = true;
  await adminSendReviewed(o.id);
  wallet.balanceThrows = false;
  const w1 = await row(o.id);
  ok('the operator\'s send stopped before sending', w1.status === 'awaiting_delivery' && sendsFor(o.id).length === 0,
     `${w1.status} ${sendsFor(o.id).length}`);
  await pay(o, { parent: 5099999996 });                 // the held payment's own callback again
  await pay(o, { parent: 5099999996, status: 'confirmed' });
  ok('no callback sends it behind the operator\'s back', sendsFor(o.id).length === 0);
});

// ── the record: every signed callback says what it did ──────────────────────

await test('record: each decision is written on its ipn_events row', async () => {
  const paid = await newOrder();
  await pay(paid, { status: 'confirmed', paid: 0.1 });       // short: waits
  await pay(paid, { status: 'finished' });                    // pays
  await pay(paid, { status: 'finished' });                    // the same callback again
  await pay(paid, { pid: Number(newPid()) });                 // another payment
  const held = await newOrder();
  await pay(held, { price: 1 });
  const closed = await newOrder();
  await pay(closed, { status: 'expired', paid: 0 });
  await pay({ id: 'NO-SUCH-ORDER-REC', usd: 20, invoiceId: '1', pid: newPid() });
  const ev = await events(paid.id);
  const by = s => ev.filter(e => e.status === s).map(e => e.outcome);
  ok('the short confirmed: ignored, and why', by('confirmed')[0] === 'ignored' &&
     /not paid in full/.test(ev.find(e => e.status === 'confirmed').note || ''), JSON.stringify(ev));
  ok('the finished: paid (the retry does not overwrite it)', by('finished').join() === 'paid,needs_human',
     JSON.stringify(ev));
  ok('the held one says why', (await events(held.id))[0]?.outcome === 'held' &&
     /DOES NOT MATCH/.test((await events(held.id))[0]?.note || ''));
  ok('the closed one', (await events(closed.id))[0]?.outcome === 'closed');
  ok('the unknown order', (await events('NO-SUCH-ORDER-REC'))[0]?.outcome === 'unknown_order');
});

// ── legacy orders, unknown orders, late payments ────────────────────────────

await test('an order paid before the migration: its own late callback is a duplicate, a new payment is not', async () => {
  const o = await newOrder();
  await q(`UPDATE orders SET status='delivered', delivered_txid=?, paid_at=NOW() WHERE order_id=?`, ['b'.repeat(64), o.id]);
  await q(`INSERT INTO ipn_events (payment_id, order_id, status, raw) VALUES (?,?,?,?)`,
          [o.pid, o.id, 'confirmed', callback(o, { status: 'confirmed' })]);
  alerts.length = 0;
  await pay(o, { status: 'finished' });
  ok('its own finished: silent', alerts.length === 0, alerts.join(' || '));
  await pay(o, { pid: Number(newPid()) });
  ok('a new payment: a human is told', alertsLike(/Another payment/).length === 1, alerts.join(' || '));
  ok('nothing sent', sendsFor(o.id).length === 0);
});

await test('a payment for an unknown order pages once', async () => {
  const ghost = { id: 'NO-SUCH-ORDER', usd: 20, invoiceId: '1', pid: newPid() };
  const r1 = await pay(ghost);
  const r2 = await pay(ghost);
  ok('200 both times', r1.http === 200 && r2.http === 200);
  ok('one alert', alertsLike(/unknown order/).length === 1, `${alertsLike(/unknown order/).length}`);
});

await test('a money callback without a payment_id changes nothing', async () => {
  const o = await newOrder();
  await pay(o, { omit: ['payment_id'] });
  ok('nothing sent, still pending', sendsFor(o.id).length === 0 && (await row(o.id)).status === 'pending');
  ok('a human is told', alerts.length === 1, alerts.join(' || '));
});

await test('a late payment on an expired order whose rungs are still reserved is paid', async () => {
  const o = await newOrder();
  await q(`UPDATE orders SET status='expired' WHERE order_id=?`, [o.id]);   // crash before the release
  await pay(o);
  ok('paid', sendsFor(o.id).length === 1 && (await row(o.id)).status === 'delivered');
});

await test('an amount too large for the column is recorded as unknown, not a failed callback', async () => {
  const o = await newOrder({ usd: 100 });
  const r = await pay(o, { due: 1e20, paid: 1e20 });
  const w = await row(o.id);
  ok('answered 200', r.http === 200, JSON.stringify(r));
  ok('accepted with the amount unrecorded', w.status === 'awaiting_delivery' && w.paid_amount === null,
     `${w.status} ${w.paid_amount}`);
});

// ── the end ─────────────────────────────────────────────────────────────────

await new Promise(r => setTimeout(r, 50));
await pool.end();
if (process.env.PCOIN_IPN_TEST_KEEP !== '1') await admin.query(`DROP DATABASE IF EXISTS \`${DBN}\``);
await admin.end();
console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''} (${IMPL}, MariaDB ${ver.v})`);
if (failures.length) console.log('FAILED:\n  ' + failures.join('\n  '));
process.exit(fail ? 1 : 0);
