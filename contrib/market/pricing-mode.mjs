#!/usr/bin/env node
// Switch how market.pc.am prices PCN -- price plan Step 3.
//
//   node pricing-mode.mjs index              sell every PCN at the PCN index x (1 + marketPremiumPct/100)
//   node pricing-mode.mjs curve              back to the constant-product curve, re-anchored first
//                                            so the price does not jump
//   node pricing-mode.mjs curve --at 0.0283  ...anchored at a price you name, for when the index is
//                                            unusable and the market has no price in force
//   --dry-run          read everything, print what would happen, write nothing
//   --no-timer-check   skip the ask-follow timer check (a box without systemd; never production)
//
// D:\pc.am\PCOIN-PRICE-EXCHANGE-ANCHOR-PLAN.md §5 Step 3. The owner, 2026-09-24:
// one PCN price from "the average price of real trading on exchange.pc.am", in
// place of "10 different pricings and calculations". Decision D10: this market
// sells at index x 1.03 (marketPremiumPct = 3).
//
// WHAT IT DOES, index:
//   1. refuses while pcoin-ask-follow.timer is enabled or active. cap-policy.mjs
//      --curve would read a price that is no longer k/X^2, refuse on its model
//      check, and page OnFailure= every hour. Disable it FIRST.
//   2. refuses unless the index is usable right now -- switching into an index
//      the market cannot price with would only close the market.
//   3. writes pricingMode = index, reads it back from the table, waits 35 s (the
//      server re-reads settings every 30 s), then checks the live price is
//      max(index x (1 + p/100), ladderMinPriceUsd) to 1e-6, that the index the
//      server priced with is the one price.pc.am relays, that a quote is flat
//      at that price, and that the sale gate is open.
// WHAT IT DOES, curve:
//   1. re-anchors ammK = P x X^2, where P is the price in force and X is what
//      ladder.mjs's curve uses (unsold, unretired inventory -- reservations
//      INCLUDED, the lesson of cap-policy's 02:04 incident -- plus
//      ammVirtualPcn). ammK is written FIRST: it is inert while the mode is
//      index, so there is no moment the server can combine the new mode with the
//      old k and jump to wherever the curve was left days ago.
//   2. writes pricingMode = curve, reads both back, waits 35 s, and checks the
//      live price is max(k/X^2, floor) to 1e-6 against the LIVE X.
//
// It never rolls itself back. A mismatch prints what it found and the command
// that undoes it; an automatic reversal on a failed check is a second change
// made on the same bad information as the first.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { userInfo, hostname } from 'node:os';
import mysql from 'mysql2/promise';
import { makeSettings } from './settings.mjs';
import { indexUnitPrice } from './ladder.mjs';
import { indexFromPriceBody } from './price-feed.mjs';
import { makeNotifier, readNotifyConfig } from './notify.mjs';

const CFG        = '/opt/pcoin-market/config.json';
const ALERT_CONF = '/etc/pcoin/alert.conf';
// Loopback, so the reply carries the INTERNAL fields (totalPcn, soldPcn,
// reservedPcn, the index block); see the PUBLIC vs INTERNAL note in server.mjs.
const MARKET     = 'http://127.0.0.1:8789';
const PRICE      = 'http://127.0.0.1:8788/price';     // price.pc.am's primary, same box
const TIMER      = 'pcoin-ask-follow.timer';
const WAIT_S     = 35;          // the server reloads settings every 30 s
const TOL        = 1e-6;        // relative, as the plan specifies

const argv = process.argv.slice(2);
const mode = argv[0];
const dryRun = argv.includes('--dry-run');
const noTimerCheck = argv.includes('--no-timer-check');
const atIdx = argv.indexOf('--at');
const atRaw = atIdx >= 0 ? argv[atIdx + 1] : null;
if (!['index', 'curve'].includes(mode) || (atIdx >= 0 && mode !== 'curve')) {
  console.error('usage: node pricing-mode.mjs index|curve [--dry-run] [--no-timer-check]\n' +
                '       node pricing-mode.mjs curve --at <usd> [--dry-run]');
  process.exit(2);
}

// What undoes this run, printed with every failed check. Going back to the
// curve with a dead index needs --at: there is then no price in force to anchor to.
const UNDO = mode === 'index'
  ? 'node pricing-mode.mjs curve   (add --at <usd> if the index is what failed)'
  : 'node pricing-mode.mjs index';

// null is "none", never 0.000000000: a missing price printed as zero reads as a
// price of zero.
const f = (x, n = 9) => (x === null || x === undefined ? 'none'
  : Number.isFinite(Number(x)) ? Number(x).toFixed(n) : String(x));
const pct = (a, b) => ((a - b) / b * 100).toFixed(3) + '%';
const rel = (a, b) => Math.abs(a - b) / Math.abs(b);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const who = (() => { try { return `cli:${userInfo().username}@${hostname()}`; } catch { return 'cli'; } })();

const cfg = JSON.parse(readFileSync(CFG, 'utf8'));
const pool = mysql.createPool({ ...cfg.db, connectionLimit: 2, decimalNumbers: false });
const quiet = { warn: () => {}, error: console.error, log: console.log };
const S = makeSettings(pool, quiet);
const alert = readNotifyConfig(ALERT_CONF, { log: quiet });
const notifier = makeNotifier({
  token: alert.TELEGRAM_TOKEN,
  chatId: cfg.telegramChatId || alert.MARKET_CHAT || alert.ALERT_CHAT,
  prefix: '<b>market.pc.am</b>', log: quiet,
});
// Awaited: this process exits right after, and a detached send would die with it.
const tell = text => (notifier.sendNow || notifier)(text).catch(() => {});

/** How every early end is signalled: thrown, caught once at the bottom of the
 *  file, which sets the exit code and closes the pool. NOT process.exit(): with
 *  fetch sockets still open it aborts on a libuv assertion on Windows AFTER a
 *  successful run -- and the rollback is `pricing-mode.mjs curve && ...`, where
 *  a wrong exit code stops the steps after it. */
class Stop extends Error { constructor(code) { super('stop'); this.stopCode = code; } }

async function refuse(why) {
  console.log('\n  REFUSED: ' + why);
  console.log('  Nothing was written.');
  throw new Stop(2);
}
async function mismatch(why, undo) {
  console.log('\n  MISMATCH: ' + why);
  console.log('  The setting IS written. Look before acting; to undo:\n    ' + undo);
  await tell(`🔴 <b>Market pricing switch to "${esc(mode)}" did not check out</b>\n` +
             `The new setting IS written, but the check after it failed: ${esc(why)}\n` +
             `What to do: look at market.pc.am's price now; if it is wrong, undo with ` +
             `<code>${esc(undo)}</code>\n` +
             `<i>tech: pricing-mode ${esc(mode)}: check FAILED (${esc(who)})</i>`);
  throw new Stop(2);
}

async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  let body = null;
  try { body = await r.json(); } catch { /* not JSON: body stays null */ }
  return { status: r.status, body };
}
/** `written` says which failure this is: before any write it is a refusal
 *  ("nothing was written"), after one it is a failed CHECK of a change that
 *  has already landed -- and saying "nothing was written" then would be a lie
 *  told at the worst possible moment. */
let written = false;
async function fail(why, undo) { return written ? mismatch(why, undo) : refuse(why); }
async function marketState(undo = '') {
  let s;
  try { s = await getJson(`${MARKET}/api/ladder/state`); }
  catch (e) { await fail(`cannot read the market at ${MARKET} (${e.message})`, undo); }
  if (!s.body || typeof s.body !== 'object') await fail(`the market answered HTTP ${s.status} with no JSON`, undo);
  return s;
}
// The index as price.pc.am relays it, from EITHER body shape: the `index` block
// today, the top level of the minimal body (owner, 2026-09-25: "simplify the
// price.pc.am json response"). The same reader server.mjs prices with, so this
// check compares like with like.
async function relayIndex() {
  try { const r = await getJson(PRICE); return indexFromPriceBody(r.body); }
  catch { return null; }
}
/** What the TABLE holds, coerced as the server coerces it. */
async function stored(key) {
  const [rows] = await pool.query('SELECT v FROM settings WHERE k = ?', [key]);
  return rows.length ? S.coerce(key, rows[0].v) : undefined;
}
async function writeAndReadBack(key, value, undo) {
  const want = S.coerce(key, value);
  try { await S.set(key, want); }
  catch (e) { await fail(`writing ${key} failed (${e.message})`, undo); }
  written = true;
  let back;
  try { back = await stored(key); }
  catch (e) { await mismatch(`${key} was written but could not be read back (${e.message})`, undo); }
  if (back !== want) {
    await mismatch(`${key} was written as ${want} but the table holds ${back}`, undo);
  }
  console.log(`  wrote ${key} = ${back}   (read back from the table)`);
  try {
    await pool.query('INSERT INTO admin_audit (email, action, detail, ip) VALUES (?,?,?,?)',
                     [who, 'pricing.mode', `${key} -> ${back} (pricing-mode.mjs ${mode})`, null]);
  } catch (e) { console.log(`  WARNING: no audit row (${e.message}); the write stands`); }
}
async function waitForReload() {
  process.stdout.write(`  waiting ${WAIT_S} s for the server to reload its settings`);
  for (let i = 0; i < WAIT_S; i += 5) {
    await new Promise(r => setTimeout(r, Math.min(5, WAIT_S - i) * 1000));
    process.stdout.write('.');
  }
  process.stdout.write('\n');
}
/** Enabled or active: either one means cap-policy will still run. */
function askFollowTimer() {
  const q = verb => spawnSync('systemctl', [verb, TIMER], { encoding: 'utf8', timeout: 10000 });
  const en = q('is-enabled'), ac = q('is-active');
  if (en.error || ac.error) return { known: false, why: (en.error || ac.error).message };
  const enabled = (en.stdout || '').trim(), active = (ac.stdout || '').trim();
  return { known: true, enabled, active,
           running: /^(enabled|enabled-runtime|linked|linked-runtime|alias)$/.test(enabled) || active === 'active' };
}

async function main() {
  // ── the settings as they stand ─────────────────────────────────────────────
  // reload() keeps the previous values when the read fails, and in a fresh
  // process "the previous values" are the DEFAULTS -- so a failed read must stop
  // this here, not quietly compute a price from defaults nobody chose.
  await S.reload();
  if (!S.loadedAt()) await refuse('the settings table could not be read');
  const floor   = Number(S.get('ladderMinPriceUsd'));
  const premium = Number(S.get('marketPremiumPct'));
  const maxAgeS = Number(S.get('indexMaxAgeSeconds'));
  const modeNow = S.get('pricingMode');

  const live0 = await marketState();
  const st0 = live0.body;
  // A server that predates Step 3 ignores pricingMode entirely. Writing it would
  // "succeed" and change nothing -- the silent no-op this estate keeps paying for.
  if (!('pricingMode' in st0)) {
    await refuse('the running market does not report a pricingMode, so it predates the Step 3 ' +
                 'code. Deploy ladder.mjs, settings.mjs and server.mjs first; writing the ' +
                 'setting now would change nothing.');
  }

  console.log(`\n  market pricing mode  --  ${new Date().toISOString()}`);
  console.log('  ' + '-'.repeat(66));
  console.log(`  table says           ${modeNow}`);
  console.log(`  server is pricing    ${st0.pricingMode}   (HTTP ${live0.status})`);
  console.log(`  price in force       $${f(st0.marginalPrice)}`);
  console.log(`  floor                $${f(floor)}   (ladderMinPriceUsd)`);
  console.log(`  premium              ${premium}%   (marketPremiumPct)`);

  // ═══════════════════════════════════════════════════════════════════════════
  if (mode === 'index') {
    if (!noTimerCheck) {
      const t = askFollowTimer();
      if (!t.known) {
        await refuse(`cannot tell whether ${TIMER} is still running (${t.why}). Disable it ` +
                     `(systemctl disable --now ${TIMER}) and re-run; --no-timer-check only off production.`);
      }
      console.log(`  ${TIMER}  ${t.enabled} / ${t.active}`);
      if (t.running) {
        await refuse(`${TIMER} is ${t.enabled}/${t.active}. In index mode cap-policy.mjs would find ` +
                     `the price is no longer k/X^2, refuse, and page every hour. First:\n` +
                     `             systemctl disable --now ${TIMER}`);
      }
    }
    if (S.get('retireSpentCoins')) {
      console.log('  NOTE                 retireSpentCoins is still ON. It cannot move the price in ' +
                  'index mode;\n                       the plan turns it off: node set-setting.mjs retireSpentCoins false');
    }
    if (!(premium > 0)) {
      console.log('  NOTE                 marketPremiumPct is 0, so the market will sell AT the index. ' +
                  'Decision D10\n                       is 3: node set-setting.mjs marketPremiumPct 3');
    }

    // The index as the SERVER sees it, judged by the same function that prices.
    const q0 = indexUnitPrice(st0.index, { premiumPct: premium, floor, maxAgeS });
    const idx = st0.index || {};
    console.log(`  index (server view)  $${f(idx.usd)}  state ${idx.state}  seq ${idx.seq}  ` +
                `age ${idx.ageSeconds} s  stale ${idx.stale}`);
    if (!q0.ok) {
      await refuse(`the index is not usable right now: ${q0.why}. Switching would only close the market.`);
    }
    console.log(`  price after switch   $${f(q0.unitPrice)}   (${pct(q0.unitPrice, Number(st0.marginalPrice))} ` +
                `from the price in force${q0.floored ? '; the FLOOR binds' : ''})`);

    if (modeNow === 'index' && st0.pricingMode === 'index') {
      console.log('\n  already in index mode; nothing to write. Verifying.');
    } else {
      if (dryRun) { console.log('\n  --dry-run: nothing written.'); return; }
      console.log('');
      await writeAndReadBack('pricingMode', 'index', UNDO);
      await waitForReload();
    }

    // ── verify ──
    // The index can step between two reads (each qualifying fill moves it), so a
    // disagreement on a DIFFERENT seq is retried rather than called a mismatch.
    let st1, rel1;
    for (let attempt = 1; ; attempt++) {
      const s = await marketState(UNDO);
      st1 = s.body;
      if (s.status !== 200) await mismatch(`the market answers HTTP ${s.status}: ${st1.error || st1.priceUnavailable}`, UNDO);
      if (st1.pricingMode !== 'index') {
        await mismatch(`the server still prices in ${st1.pricingMode} mode ${WAIT_S} s after the write`, UNDO);
      }
      rel1 = await relayIndex();
      if (rel1 && st1.index && rel1.seq === st1.index.seq) break;
      if (attempt >= 3) {
        await mismatch(`the index the market priced with (seq ${st1.index && st1.index.seq}) never matched ` +
                       `the one price.pc.am relays (seq ${rel1 && rel1.seq}) in 3 tries`, UNDO);
      }
      console.log(`  the index moved between reads (seq ${st1.index && st1.index.seq} vs ${rel1 && rel1.seq}); again in 5 s`);
      await new Promise(r => setTimeout(r, 5000));
    }
    if (Number(rel1.usd) !== Number(st1.index.usd)) {
      await mismatch(`same seq ${rel1.seq}, different price: market $${st1.index.usd}, price.pc.am $${rel1.usd}`, UNDO);
    }
    const expected = Math.max(Number(st1.index.usd) * (1 + premium / 100), floor > 0 ? floor : 0);
    const got = Number(st1.marginalPrice);
    console.log(`  live marginalPrice   $${f(got)}`);
    console.log(`  expected             $${f(expected)}   = max(index $${f(st1.index.usd)} x ${1 + premium / 100}, floor)`);
    if (!(got > 0) || rel(got, expected) > TOL) {
      await mismatch(`marginalPrice $${f(got)} is not the expected $${f(expected)} (tolerance ${TOL})`, UNDO);
    }
    if (Number(st1.nextFillPrice) !== got) {
      await mismatch(`nextFillPrice $${f(st1.nextFillPrice)} differs from marginalPrice -- index mode is flat`, UNDO);
    }
    // Flat: a quote's average price per coin IS the marginal price.
    const minUsd = Number(S.get('minOrderUsd'));
    const qt = await getJson(`${MARKET}/api/quote?usd=${minUsd}`).catch(e => ({ status: 0, body: { error: e.message } }));
    if (qt.status !== 200) await mismatch(`a $${minUsd} quote answered HTTP ${qt.status}: ${qt.body && qt.body.error}`, UNDO);
    if (rel(Number(qt.body.effectivePrice), got) > TOL) {
      // One more try: a 30-second index refresh may have landed between the reads.
      const again = await marketState(UNDO);
      if (rel(Number(qt.body.effectivePrice), Number(again.body.marginalPrice)) > TOL) {
        await mismatch(`a $${minUsd} quote charges $${f(qt.body.effectivePrice)} a coin, not the flat $${f(got)}`, UNDO);
      }
    }
    console.log(`  $${minUsd} quote         ${f(qt.body.pcn, 8)} PCN at $${f(qt.body.effectivePrice)}  (flat)`);
    const gate = await getJson(`${MARKET}/api/ladder/gate`).catch(e => ({ status: 0, body: { reason: e.message } }));
    // AN OPERATOR PAUSE IS NOT A FAILED SWITCH. On 2026-09-25 the switch was run
    // with sales paused on purpose (the owner closed the market while the price
    // moved to the index), every price check passed, and this still paged a red
    // "check FAILED" because the gate said closed. saleOpen off is the one closed
    // reason that says nothing about the price: report it and go on. Any OTHER
    // closed reason -- an unknown or stale index, a sold-out ladder -- is still a
    // failed switch.
    const pausedByOperator = S.get('saleOpen') === false;
    console.log(`  sale gate            ${gate.body && gate.body.open ? 'OPEN'
      : (pausedByOperator ? 'PAUSED by the operator (saleOpen off) -- the price above is verified; it sells when sales are turned back on'
        : 'CLOSED: ' + (gate.body && gate.body.reason))}`);
    if (!(gate.body && gate.body.open) && !pausedByOperator) {
      await mismatch(`the sale gate is closed: ${gate.body && gate.body.reason}`, UNDO);
    }

    console.log('\n  OK. market.pc.am sells at the PCN index' + (premium > 0 ? ` + ${premium}%` : '') + ', flat.'
      + (pausedByOperator ? ' (Sales are paused by the operator.)' : ''));
    console.log('  price.pc.am\'s sellPriceUsd follows within two of its polls (about 2 minutes).');
    await tell(`🟢 <b>market.pc.am now sells at the PCN price${premium > 0 ? ` + ${premium}%` : ''}</b>\n` +
               `It sells at $${f(got)} a coin: the PCN price $${f(st1.index.usd)}` +
               (premium > 0 ? ` plus its ${premium}% markup` : '') +
               ` (never below the $${f(floor, 4)} floor), the same for any order size. ` +
               `If the PCN price becomes unknown or stale, the market stops selling until it is back.` +
               (pausedByOperator ? ' Sales are paused by you right now.' : '') + '\n' +
               `What to do: nothing. To undo: <code>${esc(UNDO)}</code>\n` +
               `<i>tech: market.pc.am now prices off the PCN index (seq ${st1.index.seq}), ` +
               `max(index x ${1 + premium / 100}, floor); run by ${esc(who)}</i>`);
    return;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  curve
  // ═══════════════════════════════════════════════════════════════════════════
  const virt = Number(S.get('ammVirtualPcn'));
  if (!(Number.isFinite(virt) && virt >= 0)) await refuse(`ammVirtualPcn is ${S.get('ammVirtualPcn')}, not a usable depth`);
  const Xof = st => Number(st.totalPcn) - Number(st.soldPcn) - Number(st.retiredPcn) + virt;
  const floorOr0 = floor > 0 ? floor : 0;

  if (modeNow === 'curve' && st0.pricingMode === 'curve') {
    // --at anchors a SWITCH. Re-pricing a curve already in force is a different
    // decision with its own tools (set-ammk.mjs, cap-policy.mjs), and a flag that
    // silently did nothing here would look exactly like one that worked.
    if (atRaw !== null) {
      await refuse('the market is already on the curve, so there is no switch to anchor. --at only ' +
                   'applies when leaving index mode; to move the curve itself use set-ammk.mjs or cap-policy.mjs.');
    }
    const k = Number(S.get('ammK'));
    const X = Xof(st0);
    const model = Math.max((k / X) / X, floorOr0);
    console.log(`\n  already on the curve; nothing to write. k/X^2 = $${f(model)}, live $${f(st0.marginalPrice)}.`);
    if (!(k > 0) || rel(Number(st0.marginalPrice), model) > TOL) {
      console.log('  WARNING: the live price is not k/X^2 -- the curve may be off (ammK 0) and pricing by rungs.');
      throw new Stop(2);
    }
    return;
  }

  // The anchor: the price in force, or one named with --at.
  let P;
  if (atRaw !== null) {
    P = Number(atRaw);
    if (!(Number.isFinite(P) && P > 0 && P <= 10)) await refuse(`--at ${atRaw} is not a price between 0 and $10`);
    if (floorOr0 && P < floorOr0) await refuse(`--at $${P} is below the $${floorOr0} floor; the market cannot sell there`);
    console.log(`  anchor               $${f(P)}   (named with --at)`);
  } else if (live0.status === 200 && Number(st0.marginalPrice) > 0) {
    P = Number(st0.marginalPrice);
    console.log(`  anchor               $${f(P)}   (the price in force)`);
  } else {
    // No price in force: index mode with an index nobody can vouch for, which is
    // the likeliest reason to be rolling back at all. price.pc.am still holds the
    // last price it confirmed; offer it, never take it silently.
    let hint = '';
    try { const r = await getJson(PRICE); if (r.body && Number(r.body.sellPriceUsd) > 0) hint = String(r.body.sellPriceUsd); }
    catch { /* no hint then */ }
    await refuse(`the market has no price in force (${st0.priceUnavailable || st0.error || 'HTTP ' + live0.status}), ` +
                 'so there is nothing to anchor the curve to.\n' +
                 '           Name one: node pricing-mode.mjs curve --at <usd>' +
                 (hint ? `\n           price.pc.am last confirmed sellPriceUsd = ${hint}` : ''));
  }

  const X0 = Xof(st0);
  const inv = Number(st0.ladderRemainingPcn) + Number(st0.reservedPcn || 0);
  if (!(X0 > 0)) await refuse(`X = ${X0}: no inventory and no virtual depth, so there is no curve to anchor`);
  // The same X two ways: what the curve prices on, and the published inventory
  // with reservations added back. If they disagree this script's model of the
  // server is wrong, and k must not be written against it.
  if (Math.abs((X0 - virt) - inv) > 1e-6) {
    await refuse(`the inventory does not add up: total - sold - retired = ${X0 - virt}, ` +
                 `remaining + reserved = ${inv}`);
  }
  const oldK = Number(S.get('ammK'));
  const newK = P * X0 * X0;
  console.log(`  X                    ${X0}   (unsold, unretired ${X0 - virt} + virtual ${virt})`);
  console.log(`  ammK                 ${oldK}  ->  ${newK}`);
  console.log(`  curve price then     $${f(Math.max(newK / X0 / X0, floorOr0))}   (the old k would have charged ` +
              `$${f(oldK > 0 ? (oldK / X0) / X0 : NaN)})`);
  if (dryRun) { console.log('\n  --dry-run: nothing written.'); return; }

  console.log('');
  await writeAndReadBack('ammK', newK, UNDO);     // FIRST: inert while the mode is index
  await writeAndReadBack('pricingMode', 'curve', UNDO);
  await waitForReload();

  const s1 = await marketState(UNDO);
  const st1 = s1.body;
  if (s1.status !== 200) await mismatch(`the market answers HTTP ${s1.status}: ${st1.error}`, UNDO);
  if (st1.pricingMode !== 'curve') await mismatch(`the server still prices in ${st1.pricingMode} mode`, UNDO);
  // Against the LIVE X: a sale that settled during the wait moves the curve price
  // legitimately, and that is the curve working, not a mismatch.
  const X1 = Xof(st1);
  const expected = Math.max((newK / X1) / X1, floorOr0);
  const got = Number(st1.marginalPrice);
  console.log(`  live marginalPrice   $${f(got)}`);
  console.log(`  expected             $${f(expected)}   = max(k/X^2, floor), X = ${X1}`);
  if (!(got > 0) || rel(got, expected) > TOL) {
    await mismatch(`marginalPrice $${f(got)} is not k/X^2 = $${f(expected)} -- is ammVirtualPcn set? ` +
                   'ammParams() falls back to RUNG pricing when the curve settings do not coerce', UNDO);
  }
  console.log(`  change from anchor   ${pct(got, P)}`);
  console.log('\n  OK. market.pc.am prices on the curve again.');
  console.log('  Nothing maintains ammK until the ask-follow timer runs again. The plan\'s rollback also turns');
  console.log(`  retire-on-spend back on:\n    node set-setting.mjs retireSpentCoins true && systemctl enable --now ${TIMER}`);
  await tell(`🟡 <b>market.pc.am is back on its old pricing curve</b>\n` +
             `It now sells from $${f(got)} and the price rises as coins are sold, instead of following ` +
             `the PCN price.\n` +
             `What to do: if you meant to roll back fully, also turn the hourly price follow and ` +
             `retire-on-spend back on (they are separate steps).\n` +
             `<i>tech: market.pc.am is back on the curve; ammK re-anchored to $${f(P)} (was k=${oldK}); ` +
             `run by ${esc(who)}</i>`);
}

try {
  await main();
} catch (e) {
  if (e instanceof Stop) process.exitCode = e.stopCode;
  else { console.error('\n  ERROR: ' + (e.stack || e.message)); process.exitCode = 1; }
} finally {
  await pool.end().catch(() => {});
}
