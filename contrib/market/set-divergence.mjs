// Raise maxDivergencePct so market.pc.am never refuses a sale.
//
// OWNER'S DECISION, 2026-09-14: "market should never refuse, anyone should be
// able to buy 20 to ~380, and I'll charge the keeper balance and keeper will do
// the job automatically."
//
// What the gate did: refused EVERY order once |marginalPrice - serviceRate| /
// serviceRate exceeded 20%. It closed the shop for everybody, including a $20
// buyer, and it drifted toward closure on its own because the curve prices on
// inventory while serviceRate tracks the PancakeSwap pool. It reached 16.11%
// today with nobody buying, leaving 3.24% of pool fall before a shutdown.
//
// The mechanism is RAISED, not deleted, so it can be restored with one number.
// 1000 is the schema's own ceiling; at that setting the gate cannot fire,
// because it would need serviceRate to fall to marginalPrice/11 (~$0.0029)
// and ladderMinPriceUsd floors the rate at $0.015.
//
// Written through makeSettings() -- the same path cap-policy.mjs uses -- so the
// schema's own bounds still validate the value. A direct UPDATE would bypass
// coerce() and could store something the app then refuses to read.
import mysql from 'mysql2/promise';
import { readFileSync } from 'node:fs';
import { makeSettings } from '/opt/pcoin-market/settings.mjs';

const KEY = 'maxDivergencePct';
const WANT = 1000;

const cfg = JSON.parse(readFileSync('/opt/pcoin-market/config.json', 'utf8'));
const pool = mysql.createPool({ ...cfg.db, connectionLimit: 2, decimalNumbers: false });
const S = makeSettings(pool, { warn: () => {}, error: console.error });
await S.reload();

const before = Number(S.get(KEY));
console.log(`  ${KEY} before : ${before}`);

if (before === WANT) {
  console.log('  already set; nothing written');
} else {
  await S.set(KEY, WANT);
  await S.reload();
  const after = Number(S.get(KEY));
  console.log(`  ${KEY} after  : ${after}`);
  if (after !== WANT) {
    console.error('  MISMATCH -- the write did not take effect');
    await pool.end();
    process.exit(2);
  }
  console.log('  written and read back OK');
}
await pool.end();
