#!/usr/bin/env node
// Write ONE market setting from a shell on the market host.
//
//   node set-setting.mjs <key> <value>        e.g.  node set-setting.mjs retireSpentCoins false
//
// Price plan Step 3 (D:\pc.am\PCOIN-PRICE-EXCHANGE-ANCHOR-PLAN.md) needs setting
// writes from a shell -- `retireSpentCoins false` in the switch, `true` again in
// the rollback, `marketPremiumPct 3` for decision D10 -- and until now every such
// write got a one-off script of its own (set-divergence.mjs, set-ammk.mjs). This
// is the general one.
//
// THROUGH makeSettings().set, NEVER a raw UPDATE. coerce() checks the key
// against DEFS and the value against that key's own type and bounds, so a typo
// in either is refused here instead of stored as something the server cannot
// read. The server's reload() skips a row it cannot coerce and keeps the
// DEFAULT -- a write that looks done and changed nothing, which is exactly how
// an unregistered ammK once made the curve "not work".
//
// READ BACK FROM THE TABLE, not from the settings cache. set() updates the
// cache itself, and reload() keeps the old cache when the database read fails,
// so reading back through either proves nothing. A fresh SELECT does.
//
// And it leaves the two traces a change in the admin panel leaves: a row in
// admin_audit, and a line in the ops channel. A setting that changed with no
// record of who changed it is the gap admin.mjs already closed for passwords.
//
// The running server picks the new value up on its next reload, within 30 s.
import { readFileSync } from 'node:fs';
import { userInfo, hostname } from 'node:os';
import mysql from 'mysql2/promise';
import { makeSettings, DEFS } from './settings.mjs';
import { makeNotifier, readNotifyConfig } from './notify.mjs';

const CFG = '/opt/pcoin-market/config.json';
const ALERT_CONF = '/etc/pcoin/alert.conf';

const [key, ...rest] = process.argv.slice(2);
if (!key || !rest.length) {
  console.error('usage: node set-setting.mjs <key> <value>\n' +
                '       (pass "" as the value to clear a list or a string)');
  process.exit(2);
}
if (!DEFS[key]) {
  console.error(`REFUSED: ${key} is not a market setting. Known settings:\n  ` +
                Object.keys(DEFS).join(', '));
  process.exit(2);
}
const raw = rest.join(' ');

const esc = s => String(s ?? '').replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const who = (() => {
  try { return `cli:${userInfo().username}@${hostname()}`; } catch { return `cli:?@${hostname()}`; }
})();

const cfg = JSON.parse(readFileSync(CFG, 'utf8'));
const pool = mysql.createPool({ ...cfg.db, connectionLimit: 2, decimalNumbers: false });
const quiet = { warn: () => {}, error: console.error, log: console.log };
const S = makeSettings(pool, quiet);

async function refuse(why) {
  console.error('\n  REFUSED: ' + why + '\n  Nothing was written.');
  await pool.end();
  process.exit(2);
}

// Validate BEFORE touching anything: coerce() needs no database.
let want;
try { want = S.coerce(key, raw); }
catch (e) { await refuse(e.message); }

/** What the TABLE says, coerced the way the server will coerce it. */
async function stored() {
  const [rows] = await pool.query('SELECT v FROM settings WHERE k = ?', [key]);
  if (!rows.length) return { present: false, value: DEFS[key].def };
  return { present: true, value: S.coerce(key, rows[0].v) };
}

let before;
try { before = await stored(); }
catch (e) { await refuse(`cannot read the settings table (${e.message})`); }

const show = v => (typeof v === 'string' ? JSON.stringify(v) : String(v));
console.log(`  ${key} before : ${show(before.value)}${before.present ? '' : '   (no row: the default)'}`);

if (before.present && before.value === want) {
  console.log('  already set; nothing written');
  await pool.end();
  process.exit(0);
}

try { await S.set(key, raw); }
catch (e) { await refuse(`the write failed (${e.message})`); }

let after;
try { after = await stored(); }
catch (e) {
  console.error(`\n  UNVERIFIED: the write returned, but reading it back failed (${e.message}).` +
                `\n  Check it before relying on it:  SELECT k, v FROM settings WHERE k='${key}';`);
  await pool.end();
  process.exit(2);
}
console.log(`  ${key} after  : ${show(after.value)}`);
if (!after.present || after.value !== want) {
  console.error(`\n  MISMATCH: expected ${show(want)}, the table holds ${show(after.value)}.`);
  await pool.end();
  process.exit(2);
}
console.log('  written and read back OK');

// The same audit row the admin panel writes for a settings change.
const detail = `${key}: ${show(before.value)} -> ${show(after.value)}`;
try {
  await pool.query('INSERT INTO admin_audit (email, action, detail, ip) VALUES (?,?,?,?)',
                   [who, 'settings.change.cli', detail, null]);
  console.log(`  audit row written (${who})`);
} catch (e) {
  // The setting IS changed; say so loudly rather than pretend otherwise.
  console.error(`  WARNING: the setting is changed but the audit row was not written (${e.message})`);
}

// Awaited sendNow, not the detached notify(): this process exits next, and a
// detached send would be cut off with it.
const alert = readNotifyConfig(ALERT_CONF, { log: quiet });
const notify = makeNotifier({
  token: alert.TELEGRAM_TOKEN,
  chatId: cfg.telegramChatId || alert.MARKET_CHAT || alert.ALERT_CHAT,
  prefix: '<b>market.pc.am</b>',
  log: quiet,
});
await (notify.sendNow || notify)(
  `⚙️ <b>Setting changed</b> from the shell by ${esc(who)}\n<code>${esc(detail)}</code>\n` +
  `The market applies it within 30 s.`);

await pool.end();
console.log('  the running server applies it within 30 s');
