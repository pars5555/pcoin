#!/usr/bin/env node
// Exercise the ladder engine against the REAL database.
//
// Safe to run only while the ladder is untouched: it asserts a zeroed ladder on
// entry, does its work under order ids prefixed TEST-, and restores the
// counters to zero on the way out -- then re-asserts. If the entry assertion
// fails it refuses to run at all, because the cleanup would otherwise wipe real
// sales.
//
//   cd /opt/pcoin-market && node ladder-test.mjs

import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import { makeLadder, walkUsd, walkPcn } from './ladder.mjs';

const cfg = JSON.parse(readFileSync('/opt/pcoin-market/config.json', 'utf8'));
const pool = mysql.createPool({ ...cfg.db, connectionLimit: 8, decimalNumbers: false });
const L = makeLadder(pool);
const q = async (s, a = []) => (await pool.query(s, a))[0];

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};
const near = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;

async function invariants(label) {
  const [bad] = await pool.query(
    `SELECT rung_no FROM ladder_rungs WHERE qty_sold + qty_reserved > qty_total OR qty_sold < 0 OR qty_reserved < 0`);
  ok(`${label}: no rung oversold or negative`, bad.length === 0, JSON.stringify(bad));
}

try {
  // ── entry guard ──────────────────────────────────────────────────────────
  const [[start]] = await pool.query(
    `SELECT COUNT(*) n, SUM(qty_sold) sold, SUM(qty_reserved) resv, SUM(qty_total) tot FROM ladder_rungs`);
  const [[fillsNow]] = await pool.query(`SELECT COUNT(*) n FROM ladder_fills`);
  if (Number(start.n) !== 100 || Number(start.sold) !== 0 || Number(start.resv) !== 0 || Number(fillsNow.n) !== 0) {
    console.error(`REFUSING: ladder is not pristine (rungs=${start.n} sold=${start.sold} ` +
                  `reserved=${start.resv} fills=${fillsNow.n}). This test resets counters and ` +
                  `would destroy real sales.`);
    process.exit(2);
  }
  console.log(`ladder pristine: 100 rungs, ${Number(start.tot).toLocaleString()} PCN\n`);

  // ── 1. pure walks ────────────────────────────────────────────────────────
  console.log('1. pure walk arithmetic');
  const rungs = await L.rungsWithStock();
  ok('100 rungs have stock', rungs.length === 100);

  const w50k = walkPcn(rungs, 50000);
  ok('50,000 PCN consumes 50 rungs', w50k.rungsConsumed === 50, `got ${w50k.rungsConsumed}`);
  ok('50,000 PCN costs ~$1,084', near(w50k.cost, 1083.70, 1), `got ${w50k.cost.toFixed(2)}`);
  ok('average price ~0.0217', near(w50k.avgPrice, 0.021674, 1e-4), `got ${w50k.avgPrice}`);
  ok('nothing unfilled', w50k.pcnUnfilled === 0);

  const wAll = walkPcn(rungs, 100000);
  ok('100,000 PCN empties the ladder', wAll.exhausted === true);
  ok('full ladder is ~$112,572', near(wAll.cost, 112572.36, 1), `got ${wAll.cost.toFixed(2)}`);
  ok('marginal after full sweep is null', wAll.marginalAfter === null);

  const wOver = walkPcn(rungs, 150000);
  ok('over-buy reports the shortfall', near(wOver.pcnUnfilled, 50000, 1), `got ${wOver.pcnUnfilled}`);
  ok('over-buy still only fills 100,000', near(wOver.pcn, 100000, 1));

  const wUsd = walkUsd(rungs, 10);
  ok('$10 fills completely', wUsd.usdUnfilled < 0.001, `left ${wUsd.usdUnfilled}`);
  ok('$10 buys ~7,700 PCN', wUsd.pcn > 5000 && wUsd.pcn < 12000, `got ${wUsd.pcn.toFixed(0)}`);
  ok('$10 costs $10', near(wUsd.cost, 10, 0.01), `got ${wUsd.cost}`);

  // ── 2. reserve ───────────────────────────────────────────────────────────
  console.log('\n2. reserve');
  const conn = await pool.getConnection();
  await conn.beginTransaction();
  const r1 = await L.reserveLadder(conn, 'TEST-A', 100);
  await conn.commit();
  conn.release();

  const s1 = await L.ladderState();
  ok('reservation shows as reserved', near(s1.reservedPcn, r1.pcn, 0.01), `${s1.reservedPcn} vs ${r1.pcn}`);
  ok('reservation does NOT count as sold', s1.soldPcn === 0);
  ok('published marginal price is unmoved by a reservation',
     s1.marginalPrice === 0.001, `got ${s1.marginalPrice}`);
  ok('next fill price HAS moved', s1.nextFillPrice > 0.001, `got ${s1.nextFillPrice}`);
  await invariants('after reserve');

  // ── 3. settle ────────────────────────────────────────────────────────────
  console.log('\n3. settle');
  const n1 = await L.settleLadder('TEST-A');
  ok('settle moved every reserved fill', n1 === r1.fills.length, `${n1} vs ${r1.fills.length}`);
  const s2 = await L.ladderState();
  ok('sold now reflects the order', near(s2.soldPcn, r1.pcn, 0.01));
  ok('reserved is back to zero', near(s2.reservedPcn, 0, 0.0001), `got ${s2.reservedPcn}`);
  ok('published marginal price moved once SOLD', s2.marginalPrice > 0.001, `got ${s2.marginalPrice}`);

  const n1b = await L.settleLadder('TEST-A');
  ok('settle is idempotent (a retry is a no-op)', n1b === 0, `got ${n1b}`);
  const s3 = await L.ladderState();
  ok('a retried settle changed nothing', near(s3.soldPcn, s2.soldPcn, 1e-8));
  await invariants('after settle');

  // ── 4. release ───────────────────────────────────────────────────────────
  console.log('\n4. release');
  const c2 = await pool.getConnection();
  await c2.beginTransaction();
  const r2 = await L.reserveLadder(c2, 'TEST-B', 50);
  await c2.commit();
  c2.release();
  const beforeRel = await L.ladderState();
  ok('second reservation is held', near(beforeRel.reservedPcn, r2.pcn, 0.01));

  const rel = await L.releaseLadder('TEST-B');
  ok('release returned every fill', rel === r2.fills.length);
  const s4 = await L.ladderState();
  ok('reserved is zero again', near(s4.reservedPcn, 0, 1e-8), `got ${s4.reservedPcn}`);
  ok('release did NOT un-sell TEST-A', near(s4.soldPcn, s2.soldPcn, 1e-8));
  ok('release is idempotent', (await L.releaseLadder('TEST-B')) === 0);

  // A settle AFTER a release must not resurrect the order: the fills are no
  // longer 'reserved', so there is nothing to move. This is the case where a
  // payment lands after the sweeper expired the order.
  ok('settle after release is a no-op', (await L.settleLadder('TEST-B')) === 0);
  await invariants('after release');

  // ── 5. the race: two buyers, one rung ────────────────────────────────────
  console.log('\n5. concurrency — two buyers hitting the same rungs at once');
  const buy = async id => {
    const c = await pool.getConnection();
    try {
      await c.beginTransaction();
      const w = await L.reserveLadder(c, id, 400);
      await c.commit();
      return w;
    } catch (e) { await c.rollback(); return { error: e.message }; }
    finally { c.release(); }
  };
  const before = await L.ladderState();
  const [pA, pB] = await Promise.all([buy('TEST-C1'), buy('TEST-C2')]);
  const after = await L.ladderState();

  const wonPcn = [pA, pB].filter(x => !x.error).reduce((a, x) => a + x.pcn, 0);
  ok('both concurrent buys resolved', !pA.error && !pB.error,
     `${pA.error || ''} ${pB.error || ''}`);
  ok('reserved total equals exactly what the two buyers were promised',
     near(after.reservedPcn - before.reservedPcn, wonPcn, 0.01),
     `${(after.reservedPcn - before.reservedPcn).toFixed(8)} vs ${wonPcn.toFixed(8)}`);
  ok('the two buyers did NOT get the same coins twice',
     !near(pA.pcn, pB.pcn, 1e-8) || pA.fills[0].rungNo !== pB.fills[0].rungNo,
     'both walks started on the same rung with the same size');
  await invariants('after concurrent buys');

  // ── 6. exhaustion ────────────────────────────────────────────────────────
  console.log('\n6. exhaustion refuses rather than part-fills');
  const c3 = await pool.getConnection();
  let refused = null;
  try {
    await c3.beginTransaction();
    await L.reserveLadder(c3, 'TEST-D', 500000);   // far more than the ladder holds
    await c3.commit();
  } catch (e) { await c3.rollback(); refused = e; }
  finally { c3.release(); }
  ok('an unfillable order is refused', refused !== null);
  ok('refusal is a 409, not a 500', refused && refused.code === 409, `code ${refused?.code}`);
  const [[dRows]] = await pool.query(`SELECT COUNT(*) n FROM ladder_fills WHERE order_id='TEST-D'`);
  ok('a refused order left no fills behind', Number(dRows.n) === 0, `got ${dRows.n}`);

} catch (e) {
  fail++;
  console.error('\nTHREW:', e.stack);
} finally {
  // ── cleanup ──────────────────────────────────────────────────────────────
  console.log('\ncleanup');
  await q(`DELETE FROM ladder_fills WHERE order_id LIKE 'TEST-%'`);
  await q(`UPDATE ladder_rungs SET qty_sold = 0, qty_reserved = 0`);
  const [[end]] = await pool.query(
    `SELECT SUM(qty_sold) sold, SUM(qty_reserved) resv FROM ladder_rungs`);
  const [[ef]] = await pool.query(`SELECT COUNT(*) n FROM ladder_fills`);
  ok('ladder restored to pristine',
     Number(end.sold) === 0 && Number(end.resv) === 0 && Number(ef.n) === 0,
     `sold=${end.sold} reserved=${end.resv} fills=${ef.n}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}
