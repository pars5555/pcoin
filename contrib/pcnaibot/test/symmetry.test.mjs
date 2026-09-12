// PCN and wPCN must credit IDENTICALLY.
//
// Since 2026-09-11 the shared verifier credits from `serviceRate` with
// `bonusPercent: 0`. wPCN is a 1:1 claim on PCN, redeemable 1:1, so N wPCN is
// worth exactly what N PCN is worth. These tests are what stops that drifting
// apart again -- in VALUE (the bonus) or in ARITHMETIC (rounding and carry).
//
// wPCN has 8 decimals and a PCN satoshi is 1e-8 PCN, so the two amounts are
// literally the same integer unit. That is what makes the comparison exact
// rather than approximate.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, pendingMigrations, applyMigration, nowSec } from '../lib/db.mjs';
import { importPool, allocateAddress } from '../lib/pool.mjs';
import { creditDeposit, reconcile } from '../lib/deposits.mjs';
import { WpcnService, creditableRows, STATE } from '../lib/wpcn.mjs';
import { rateToE12 } from '../lib/money.mjs';

const ADDR = 'pc1qnfk7xenwzxx7h4mx88g004crlx0m2zcjg3nq4j';
const RATE_TEXT = '0.03590242147375549';
const RATE = {
  usable: true, rateE12: rateToE12(RATE_TEXT), rateText: RATE_TEXT,
  source: 'oracle', readAt: 1789000000,
};

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'pcnaibot-sym-'));
  const db = openDb(join(dir, 's.db'));
  for (const m of pendingMigrations(db)) applyMigration(db, m);
  return db;
}

function addUser(db, chatId) {
  db.prepare('INSERT INTO users (chat_id, model, created_at) VALUES (?,?,?)')
    .run(chatId, 'glm-5.3-flash', nowSec());
}

function balance(db, chatId) {
  return db.prepare('SELECT balance_micro_usd b FROM users WHERE chat_id=?').get(chatId).b;
}

// Credit `sat` satoshis of PCN to chat 1.
function creditPcn(db, sat, txid) {
  const id = db.prepare(
    `INSERT INTO pcn_deposits (txid, address, chat_id, status, amount_sat, block_height, first_seen_at)
     VALUES (?,?,?,'confirming',?,?,?)`
  ).run(txid, ADDR, 1, sat, 7000, nowSec()).lastInsertRowid;
  return creditDeposit(db, id, RATE);
}

// Credit the SAME number of 1e-8 units as wPCN to chat 2, through the verifier
// reply shape. usd is what the verifier stamps: wpcn * serviceRate, bonus 0.
function creditWpcn(db, sat, txhash) {
  const svc = new WpcnService(db, { token: 'x', enabled: true });
  const wpcn = (Number(sat) / 1e8).toFixed(8);
  const usd = (Number(wpcn) * Number(RATE_TEXT)).toFixed(9);
  const rows = creditableRows([{
    state: STATE.CREDITED, logIndex: 0, wpcn, usd, rate_usd: RATE_TEXT, bonus_pct: 0,
  }], STATE.CREDITED);
  // #credit is private; drive it through the same entry point the verifier uses.
  return svc.constructor.prototype['#credit'] === undefined
    ? creditWpcnDirect(db, svc, txhash, rows)
    : null;
}

// The service exposes crediting only through verifyAndCredit(); for a unit test
// we stub the client so no network is touched.
function creditWpcnDirect(db, svc, txhash, rows) {
  svc.client = {
    verify: async () => ({
      state: STATE.CREDITED,
      usd_total: rows.reduce((a, r) => a + Number(r.usdNano) / 1e9, 0),
      transfers: rows.map((r) => ({
        state: STATE.CREDITED,
        logIndex: r.logIndex,
        wpcn: (Number(r.wpcnSat) / 1e8).toFixed(8),
        usd: (Number(r.usdNano) / 1e9).toFixed(9),
        rate_usd: RATE_TEXT,
        bonus_pct: 0,
      })),
    }),
  };
  return svc.verifyAndCredit(2, txhash);
}

test('the same amount credits identically as PCN and as wPCN', async () => {
  for (const sat of [100000000n, 500000000n, 13900000000n, 123456789n, 1n, 999999999n]) {
    const db = freshDb();
    importPool(db, `1000 ${ADDR}`);
    addUser(db, 1);
    addUser(db, 2);
    allocateAddress(db, 1);

    const pcn = creditPcn(db, sat, 'aa'.repeat(32));
    await creditWpcn(db, sat, `0x${'bb'.repeat(32)}`);

    const bPcn = balance(db, 1);
    const bWpcn = balance(db, 2);

    // Dust: the PCN path floors a sub-minimum deposit to zero and carries it.
    // The wPCN path has no minimum, so compare the CARRY-INCLUSIVE totals.
    const carryPcn = db.prepare('SELECT remainder_nano_usd r FROM pcn_addresses WHERE address=?').get(ADDR).r;
    const carryWpcn = db.prepare('SELECT wpcn_remainder_nano_usd r FROM users WHERE chat_id=2').get().r;
    const totalPcn = BigInt(bPcn) * 1000n + BigInt(carryPcn);
    const totalWpcn = BigInt(bWpcn) * 1000n + BigInt(carryWpcn);

    assert.equal(totalWpcn, totalPcn,
      `${sat} units: PCN gave ${totalPcn} nano-USD, wPCN gave ${totalWpcn}`);
    assert.equal(reconcile(db).ok, true);
    db.close();
  }
});

test('both paths FLOOR and carry, never round', async () => {
  // An amount whose USD value has a fractional micro-dollar: the floored part
  // must land in the balance and the fraction must be carried, on both sides.
  const sat = 123456789n;
  const db = freshDb();
  importPool(db, `1000 ${ADDR}`);
  addUser(db, 1);
  addUser(db, 2);
  allocateAddress(db, 1);

  creditPcn(db, sat, 'cc'.repeat(32));
  await creditWpcn(db, sat, `0x${'dd'.repeat(32)}`);

  const carryPcn = db.prepare('SELECT remainder_nano_usd r FROM pcn_addresses WHERE address=?').get(ADDR).r;
  const carryWpcn = db.prepare('SELECT wpcn_remainder_nano_usd r FROM users WHERE chat_id=2').get().r;

  assert.ok(carryPcn > 0, 'PCN carried a sub-micro remainder');
  assert.equal(carryWpcn, carryPcn, 'wPCN carried the SAME remainder');
  assert.ok(carryPcn < 1000 && carryWpcn < 1000, 'a carry is always sub-micro');
  db.close();
});

test('the wPCN carry accumulates across payments, like the PCN one', async () => {
  const db = freshDb();
  addUser(db, 2);
  // Three payments each leaving a fraction behind.
  for (let i = 0; i < 3; i++) {
    await creditWpcn(db, 123456789n, `0x${String(i).repeat(64)}`);
  }
  const carry = db.prepare('SELECT wpcn_remainder_nano_usd r FROM users WHERE chat_id=2').get().r;
  assert.ok(carry >= 0 && carry < 1000, 'the carry stays sub-micro across payments');
  // Nothing was lost: the ledger sums to the balance.
  assert.equal(reconcile(db).ok, true);
  db.close();
});

test('one transaction with TWO Transfer logs writes two rows and credits both', async () => {
  const db = freshDb();
  addUser(db, 2);
  const svc = new WpcnService(db, { token: 'x', enabled: true });
  const mk = (logIndex, wpcn) => ({
    state: STATE.CREDITED, logIndex,
    wpcn: wpcn.toFixed(8),
    usd: (wpcn * Number(RATE_TEXT)).toFixed(9),
    rate_usd: RATE_TEXT, bonus_pct: 0,
  });
  svc.client = {
    verify: async () => ({ state: STATE.CREDITED, usd_total: 1, transfers: [mk(0, 10), mk(7, 25)] }),
  };
  const r = await svc.verifyAndCredit(2, `0x${'ee'.repeat(32)}`);
  assert.equal(r.state, STATE.CREDITED);

  const claims = db.prepare('SELECT log_index FROM wpcn_claims ORDER BY log_index').all();
  assert.deepEqual(claims.map((c) => c.log_index), [0, 7],
    'BOTH logs recorded -- keying on the hash alone would have dropped the second');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM ledger WHERE kind='deposit_wpcn'").get().n, 2,
    'a ledger row per log, including the zero one');
  // 35 wPCN at the rate, floored.
  assert.ok(balance(db, 2) > 1200000, 'credited both logs, not just the first');
  assert.equal(reconcile(db).ok, true);
  db.close();
});

test('replaying the same (txhash, logIndex) credits nothing further', async () => {
  const db = freshDb();
  addUser(db, 2);
  const tx = `0x${'ff'.repeat(32)}`;
  await creditWpcn(db, 1000000000n, tx);
  const first = balance(db, 2);
  const again = await creditWpcn(db, 1000000000n, tx);
  assert.equal(balance(db, 2), first, 'balance unchanged on replay');
  assert.equal(again.duplicate, true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM wpcn_claims').get().n, 1);
  assert.equal(reconcile(db).ok, true);
  db.close();
});
