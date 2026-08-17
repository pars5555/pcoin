#!/usr/bin/env node
// Lock-ordering and atomicity tests for ladder.mjs.   node ladder-lock-test.mjs
//
// Runs against a fake connection that RECORDS the SQL it is given. No database,
// no ladder, no network — unlike ladder-test.mjs, which drives the real ladder
// and now correctly refuses to run at all because there is a live customer sale
// in it.
//
// WHAT THIS PINS DOWN
//
// 1. LOCK ORDER. reserveLadder locks ladder_rungs (ORDER BY rung_no FOR UPDATE)
//    and then writes ladder_fills. moveFills used to do the reverse: lock
//    ladder_fills first, then reach ladder_rungs through applyRung. Two
//    concurrent transactions — a buyer reserving, a payment settling — could
//    each hold what the other waited for, and InnoDB kills one of them. The
//    victim is arbitrary, so it can be the settle: the transaction that runs
//    when a customer has already paid.
//
// 2. SWEEPER ATOMICITY. Expiring an order and giving its rungs back were two
//    autocommit statements. Between them the order was terminal AND its
//    inventory was back on sale, while the IPN handler still accepts payment
//    for an 'expired' order by design. A payment landing in that window bought
//    rungs that had already been resold.

import { makeLadder } from './ladder.mjs';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}\n         ${d}`); }
};

/** A connection that records every statement, in order. */
function recorder({ fills = [], affected = 1 } = {}) {
  const sql = [];
  const conn = {
    sql,
    began: 0, committed: 0, rolledBack: 0, released: 0,
    async query(q, args = []) {
      sql.push(String(q).replace(/\s+/g, ' ').trim());
      if (/FROM ladder_fills[\s\S]*state = 'reserved' FOR UPDATE/.test(q)) return [fills];
      if (/SELECT DISTINCT rung_no FROM ladder_fills/.test(q)) {
        return [[...new Set(fills.map(f => f.rung_no))].sort((a, b) => a - b).map(rung_no => ({ rung_no }))];
      }
      if (/FROM ladder_rungs WHERE rung_no IN/.test(q)) return [[]];
      if (/UPDATE orders SET status = 'expired'/.test(q)) return [{ affectedRows: affected }];
      if (/FROM orders/.test(q)) return [[]];
      if (/FROM ladder_rungs/.test(q)) return [[]];
      return [{ affectedRows: 1 }];
    },
    async beginTransaction() { conn.began++; sql.push('BEGIN'); },
    async commit() { conn.committed++; sql.push('COMMIT'); },
    async rollback() { conn.rolledBack++; sql.push('ROLLBACK'); },
    release() { conn.released++; },
  };
  return conn;
}
const poolFrom = conn => ({
  getConnection: async () => conn,
  query: (...a) => conn.query(...a),
});

console.log('\n1. moveFills locks ladder_rungs BEFORE ladder_fills');
{
  const conn = recorder({ fills: [{ rung_no: 3, qty: '10.00000000' },
                                  { rung_no: 1, qty: '5.00000000' }] });
  const L = makeLadder(poolFrom(conn));
  await L.settleLadder('ORD-1');
  const rungLock = conn.sql.findIndex(s => /FROM ladder_rungs WHERE rung_no IN/.test(s));
  const fillLock = conn.sql.findIndex(s => /FROM ladder_fills.*FOR UPDATE/.test(s));
  ok('a rung lock is taken at all', rungLock >= 0, conn.sql.join(' | ').slice(0, 200));
  ok('rungs are locked BEFORE fills', rungLock >= 0 && rungLock < fillLock,
     `rungLock@${rungLock} fillLock@${fillLock}`);
  ok('the rung lock is ordered by rung_no',
     /ORDER BY rung_no FOR UPDATE/.test(conn.sql[rungLock] || ''), conn.sql[rungLock]);
  ok('it commits its own transaction when given no outer conn', conn.committed === 1);
}

console.log('\n2. no rung lock is taken when the order has no reserved fills');
{
  const conn = recorder({ fills: [] });
  const L = makeLadder(poolFrom(conn));
  const n = await L.releaseLadder('ORD-EMPTY');
  ok('returns 0', n === 0, String(n));
  ok('takes no pointless rung lock',
     !conn.sql.some(s => /FROM ladder_rungs WHERE rung_no IN/.test(s)), conn.sql.join(' | '));
}

console.log('\n3. an outer connection means ONE transaction, not two');
{
  const conn = recorder({ fills: [{ rung_no: 1, qty: '5.00000000' }] });
  const L = makeLadder(poolFrom(conn));
  await conn.beginTransaction();
  await L.releaseLadder('ORD-2', conn);          // inside the caller's transaction
  ok('does not begin a second transaction', conn.began === 1, `began ${conn.began}`);
  ok('does not commit the caller\'s transaction', conn.committed === 0, `committed ${conn.committed}`);
  ok('does not release the caller\'s connection', conn.released === 0, `released ${conn.released}`);
}

console.log('\n4. the sweeper expires and releases in ONE transaction');
{
  const conn = recorder({ fills: [{ rung_no: 1, qty: '5.00000000' }], affected: 1 });
  const pool = poolFrom(conn);
  pool.query = async (q, a) => {
    const s = String(q).replace(/\s+/g, ' ').trim();
    if (/FROM orders[\s\S]*status = 'pending'/.test(q)) return [[{ order_id: 'OLD-1' }]];
    if (/FROM ladder_fills f/.test(q)) return [[]];
    conn.sql.push('POOL: ' + s);
    return [[]];
  };
  const L = makeLadder(pool);
  await L.sweepExpiredOrders();
  const begin = conn.sql.indexOf('BEGIN');
  const expire = conn.sql.findIndex(s => /UPDATE orders SET status = 'expired'/.test(s));
  const release = conn.sql.findIndex(s => /UPDATE ladder_fills SET state = \?/.test(s));
  const commit = conn.sql.indexOf('COMMIT');
  ok('BEGIN comes first', begin >= 0 && begin < expire, conn.sql.join(' | ').slice(0, 240));
  ok('the expire and the release are both inside it',
     expire > begin && release > expire && commit > release,
     `begin@${begin} expire@${expire} release@${release} commit@${commit}`);
  ok('exactly one COMMIT', conn.committed === 1, `committed ${conn.committed}`);
  ok('no rollback on the happy path', conn.rolledBack === 0);
}

console.log('\n5. a payment that lands first is left alone');
{
  // affected 0 = the UPDATE matched nothing, i.e. the order is no longer pending
  const conn = recorder({ fills: [{ rung_no: 1, qty: '5.00000000' }], affected: 0 });
  const pool = poolFrom(conn);
  pool.query = async (q) => {
    if (/FROM orders[\s\S]*status = 'pending'/.test(q)) return [[{ order_id: 'PAID-1' }]];
    if (/FROM ladder_fills f/.test(q)) return [[]];
    return [[]];
  };
  const L = makeLadder(pool);
  await L.sweepExpiredOrders();
  ok('the inventory is NOT released',
     !conn.sql.some(s => /UPDATE ladder_fills SET state = \?/.test(s)), conn.sql.join(' | '));
  ok('the transaction is rolled back, not committed',
     conn.rolledBack === 1 && conn.committed === 0,
     `rolled ${conn.rolledBack} committed ${conn.committed}`);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
