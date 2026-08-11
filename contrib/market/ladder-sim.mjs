#!/usr/bin/env node
// Simulate a completed ladder sale, or undo one. Used to prove the whole chain
// -- ladder -> price oracle -> serviceRate -> replica -- without spending money
// at NOWPayments.
//
//   node ladder-sim.mjs sell 2000     reserve + settle $2000 as order TEST-SIM
//   node ladder-sim.mjs reset         undo it and return the ladder to pristine
//
// Only ever touches order ids beginning TEST-, and `reset` refuses to run if any
// non-TEST fill exists, so it cannot erase a real sale.

import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import { makeLadder } from './ladder.mjs';

const cfg = JSON.parse(readFileSync('/opt/pcoin-market/config.json', 'utf8'));
const pool = mysql.createPool({ ...cfg.db, connectionLimit: 4, decimalNumbers: false });
const L = makeLadder(pool);
const [cmd, arg] = process.argv.slice(2);

try {
  if (cmd === 'sell') {
    const usd = Number(arg);
    const conn = await pool.getConnection();
    await conn.beginTransaction();
    const w = await L.reserveLadder(conn, 'TEST-SIM', usd);
    await conn.commit();
    conn.release();
    await L.settleLadder('TEST-SIM');
    console.log(JSON.stringify({ spent: usd, pcn: w.pcn, avgPrice: w.avgPrice,
                                 rungs: w.rungsConsumed, ...(await L.ladderState()) }, null, 2));

  } else if (cmd === 'reset') {
    const [[real]] = await pool.query(
      `SELECT COUNT(*) n FROM ladder_fills WHERE order_id NOT LIKE 'TEST-%'`);
    if (Number(real.n) > 0) {
      console.error(`REFUSING: ${real.n} real fill(s) exist. Reset would erase actual sales.`);
      process.exit(2);
    }
    await pool.query(`DELETE FROM ladder_fills WHERE order_id LIKE 'TEST-%'`);
    await pool.query(`UPDATE ladder_rungs SET qty_sold = 0, qty_reserved = 0`);
    console.log(JSON.stringify(await L.ladderState(), null, 2));

  } else {
    console.error('usage: ladder-sim.mjs sell <usd> | reset');
    process.exit(1);
  }
} finally { await pool.end(); }
