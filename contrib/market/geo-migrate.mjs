// Migration: the ip_geo cache, the per-order snapshot, and the API key.
//
// Run on the market host. Idempotent -- every step checks before it acts, so a
// re-run after a half-failure finishes the job instead of erroring.
//
// The snapshot columns on `orders` are deliberately separate from the cache:
// the cache says where an IP is today, the order must remember where it came
// from when it was placed. Reading an old order's location out of the live
// cache would quietly rewrite history.
import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import { ensureSchema, geoFor, geoLine } from '/opt/pcoin-market/geoip.mjs';

const cfg = JSON.parse(readFileSync('/opt/pcoin-market/config.json', 'utf8'));
const pool = mysql.createPool({ ...cfg.db, connectionLimit: 2, decimalNumbers: false });
const q = async (sql, args = []) => (await pool.query(sql, args))[0];

const KEY = process.argv[2];
if (!KEY) { console.error('usage: node market-geo-migrate.mjs <apikey>'); process.exit(2); }

await ensureSchema(q);
console.log('ip_geo table ready');

// Snapshot columns on orders.
const cols = await q(`SELECT COLUMN_NAME c FROM information_schema.COLUMNS
                      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders'`);
const have = new Set(cols.map(r => r.c));
for (const [name, ddl] of [
  ['geo_country', 'CHAR(2) NULL'],
  ['geo_city', 'VARCHAR(128) NULL'],
  ['geo_isp', 'VARCHAR(128) NULL'],
]) {
  if (have.has(name)) { console.log(`orders.${name} already there`); continue; }
  await q(`ALTER TABLE orders ADD COLUMN ${name} ${ddl}`);
  console.log(`orders.${name} added`);
}

// The key and base URL, into the settings table the app reads.
for (const [k, v] of [
  ['geoipKey', KEY],
  ['geoipBaseUrl', 'http://116.203.221.42:65333'],
  ['geoipEnabled', 'true'],
]) {
  await q(`INSERT INTO settings (k, v) VALUES (?,?) ON DUPLICATE KEY UPDATE v = VALUES(v)`, [k, v]);
  console.log(`setting ${k} stored${k === 'geoipKey' ? ' (value not printed)' : ': ' + v}`);
}

// Prove the whole path end to end against the LIVE service and the LIVE table,
// rather than declaring it done because the DDL ran.
const opts = { q, key: KEY, base: 'http://116.203.221.42:65333', enabled: true };
for (const ip of ['8.8.8.8', '46.182.172.50']) {
  const t0 = Date.now();
  const geo = await geoFor(ip, opts);
  console.log(`  ${ip} -> ${geoLine(ip, geo, { html: false })}   (${Date.now() - t0}ms)`);
}
// Second call must be served from the cache, so it should be far faster and
// must not consume quota.
const t1 = Date.now();
await geoFor('8.8.8.8', opts);
console.log(`  cached re-read took ${Date.now() - t1}ms`);
console.log('rows in ip_geo:', (await q(`SELECT COUNT(*) n FROM ip_geo`))[0].n);

await pool.end();
