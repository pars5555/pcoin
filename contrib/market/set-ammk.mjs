// Cut the posted PCN price by a fixed percentage, by scaling ammK.
//
// price = ammK / X^2 where X = remainingPcn + ammVirtualPcn. X does not change
// here, so the price scales linearly with ammK: -20% on ammK is -20% on the
// price at EVERY order size, not just at the margin. That is the whole reason
// this is the right lever -- it cannot tilt the curve, only shift it.
//
// Owner instruction 2026-09-17: "i think we should reduce the price.pc.am price
// for 20%, mean reduce pcn price for 20%" -> "cut now yes".
//
// It prints the before and after and REFUSES if the arithmetic does not land on
// the expected price, because a settings write that silently does nothing looks
// exactly like one that worked (CLAUDE.md 12: an unregistered key makes
// ammParams() fall back to rungs, silently).
import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';

const PCT = Number(process.argv[2]);
if (!Number.isFinite(PCT) || PCT <= 0 || PCT >= 90) {
  console.error('usage: node set-ammk.mjs <percent-to-cut>   e.g. 20');
  process.exit(2);
}

const cfg = JSON.parse(readFileSync('/opt/pcoin-market/config.json', 'utf8'));
const c = await mysql.createConnection({
  host: cfg.db.host, user: cfg.db.user, password: cfg.db.password,
  database: cfg.db.database, port: cfg.db.port || 3306,
});

const get = async k => {
  const [r] = await c.query('SELECT v FROM settings WHERE k = ?', [k]);
  if (!r.length) throw new Error(`setting ${k} is not present -- refusing`);
  return Number(r[0].v);
};

const oldK = await get('ammK');
const virt = await get('ammVirtualPcn');

// remainingPcn comes from the live ladder, not from settings.
const state = await fetch('http://127.0.0.1:8789/api/ladder/state').then(r => r.json());
const rem = Number(state.remainingPcn);
const liveBefore = Number(state.marginalPrice);
if (!(rem > 0) || !(liveBefore > 0)) throw new Error('could not read the live ladder -- refusing');

const X = rem + virt;
const priceBefore = oldK / (X * X);
if (Math.abs(priceBefore - liveBefore) / liveBefore > 1e-6) {
  throw new Error(`model disagrees with the live price (${priceBefore} vs ${liveBefore}) -- refusing`);
}

const newK = oldK * (1 - PCT / 100);
const priceAfter = newK / (X * X);

console.log(`ammK           ${oldK}  ->  ${newK}`);
console.log(`ammVirtualPcn  ${virt}   (unchanged)`);
console.log(`remainingPcn   ${rem}`);
console.log(`posted price   $${priceBefore.toFixed(9)}  ->  $${priceAfter.toFixed(9)}  (-${PCT}%)`);

const [res] = await c.query('UPDATE settings SET v = ?, updated_at = NOW() WHERE k = ?',
  [String(newK), 'ammK']);
if (res.affectedRows !== 1) throw new Error(`UPDATE touched ${res.affectedRows} rows -- refusing`);

const check = await get('ammK');
if (check !== newK) throw new Error(`read back ${check}, expected ${newK}`);
console.log('written and read back OK');
await c.end();
