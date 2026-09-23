#!/usr/bin/env node
// ONE message listing everything waiting on the owner, instead of several
// unrelated nags he has to assemble in his head.
//
// Owner, 2026-09-18: "any pending action by me should be in bold in monitoring
// channel and it should group all pending actions by me and show in 1 message,
// like market and exchange if there are multiple pending actions by me, then it
// should list all in bold and describe each what should i do or where to visit
// in admin and do it."
//
// WHY IT REUSES needs-you.mjs. The admin dashboard already computes exactly
// this list. Writing a second implementation for Telegram would mean two sets
// of thresholds that drift apart, and then the channel and the panel disagree
// about whether anything is wrong -- which is worse than either being wrong on
// its own, because now nobody knows which to believe. One source, two renderings.
//
// WHAT IT WILL NOT DO. It never repeats "all clear". A monitor that posts
// "all clear" every ten minutes is a monitor people mute, and a muted channel
// takes the one message that mattered with it. The list is re-sent whenever it
// changes, so a resolved item disappears by the list shrinking -- and when the
// LAST item resolves, one short message says so, once. (Before 2026-09-23 that
// case sent nothing, and the last alarm stood in the channel as if still true.)
//
// SENDING IS VIA pcoin-notify, never a raw API call: that is where the token
// lives, where the ops-vs-announce channel is decided, and where the length and
// Markdown fallbacks are. No script that detects a problem should carry a
// credential.
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';

import { collect, upstreamCreds } from './services.mjs';
import { exchangeCall } from './exchange.mjs';
import { wrapdeskState } from './wrapdesk.mjs';
import { needsYou } from './needs-you.mjs';

const NOTIFY = process.env.PCOIN_NOTIFY || '/usr/local/bin/pcoin-notify';
const STATE = process.env.OWNER_ACTIONS_STATE || '/var/lib/pcoin-monitor/owner-actions.json';
// NO DEFAULT, because a default would have to contain the panel's unguessable
// path and this repository is PUBLIC. That path is not the security -- the
// password and the second factor are -- but publishing it hands scanners the
// front door for nothing. It is set in a systemd drop-in that stays on the box.
// Unset, the message still lists every item and simply names the page instead of
// linking it: degraded, never silent.
const ADMIN_URL = process.env.ADMIN_URL || '';
// Re-send an unchanged list this often, so a thing sitting for days is not
// forgotten just because it has not changed.
const REMIND_HOURS = Number(process.env.OWNER_ACTIONS_REMIND_HOURS || 12);
const DRY = process.argv.includes('--dry-run');

// Where each kind of item is actually dealt with. The owner should never have
// to hunt for the page; the message says where to go.
const WHERE = {
  withdrawal: ['Exchange → Withdrawals', '/exchange?view=withdrawals'],
  deposits:   ['Exchange → Deposits', '/exchange?view=deposits'],
  pool:       ['Exchange → Address pool', '/exchange?view=pool'],
  exchange:   ['Exchange', '/exchange'],
  market:     ['Services → market.pc.am', '/services/market'],
  services:   ['All services', '/services'],
  wrapdesk:   ['Wrap desk', '/wrapdesk'],
  reports:    ['User reports', '/user-reports'],
  tasks:      ['Tasks', '/tasks'],
};

function whereFor(href) {
  const tail = String(href || '').replace(/^.*?(\/[a-z].*)$/i, '$1');
  for (const [, [label, path]] of Object.entries(WHERE)) {
    if (tail === path) return [label, path];
  }
  return ['Dashboard', '/'];
}

/** What the owner should actually DO. The items carry a diagnosis; this turns
 *  each into an instruction, because "market book lists more than it can
 *  deliver" is a fact and not a next step. */
function instruction(item) {
  const t = item.title.toLowerCase();
  if (t.includes('withdrawal')) {
    return 'Send the USDT or PCN from your own wallet, then paste the txid in the admin to close it out. '
         + 'The exchange holds no key — nothing goes out until you send it.';
  }
  if (t.includes('more than it can deliver')) {
    return 'Either raise `backingCapPcn` — but ONLY against coins you have actually checked — '
         + 'or trim the ladder so the book stops listing stock that is not there.';
  }
  if (t.includes('hand-set')) {
    return 'Count the real coins and confirm the cap still matches them. Nothing will tell you if it stops matching.';
  }
  if (t.includes('cached backing')) {
    return 'The backing read is failing. When its cache expires the market stops selling entirely.';
  }
  if (t.includes('sale gate')) {
    return 'Nobody can buy from market.pc.am while this is closed. Check the divergence against the pool price.';
  }
  if (t.includes('need review')) {
    return 'A delivery did not finish cleanly. These never resolve themselves — look at each one.';
  }
  if (t.includes('reorg')) {
    return 'A credit may rest on a block that was unwound. Credits are never auto-reversed by design, so decide this one by hand.';
  }
  if (t.includes('deposit') && t.includes('held')) {
    return 'Held deposits are credited to nobody until you look at them.';
  }
  if (t.includes('halted')) {
    return 'Trading is stopped. Find out why before restarting it.';
  }
  if (t.includes('invariant')) {
    return 'The exchange is failing its own consistency check. Do not move money until this is understood.';
  }
  if (t.includes('deposit addresses left')) {
    return 'Refill the address pool from the offline vault before it empties — new users cannot be given an address without it.';
  }
  if (t.includes('do not match the chain')) {
    return 'PCN received at the deposit addresses and the deposits recorded disagree. This is the check '
         + 'that catches real loss. Open the exchange page and find the deposit that differs before paying anything.';
  }
  if (t.includes('could not read the chain')) {
    return 'The balance check failed on two runs a quarter of an hour apart, so a real mismatch could go unseen. '
         + 'Check that the exchange server can reach explorer.pc.am.';
  }
  if (t.includes('stopped running')) {
    return 'The exchange has stopped refreshing its balance check. Look at its tick loop and its log.';
  }
  return item.detail;
}

function render(items) {
  const actions = items.filter(i => i.sev === 'action');
  const checks  = items.filter(i => i.sev === 'warn');
  const todo    = items.filter(i => i.sev === 'info');

  const lines = [];
  let n = 0;

  const block = (list, heading) => {
    if (!list.length) return;
    lines.push('');
    lines.push(heading);
    for (const it of list) {
      n += 1;
      const [label, path] = whereFor(it.href);
      // BOLD, because the owner asked for the pending actions to stand out and
      // because these are the lines that cost money if skipped.
      lines.push('');
      lines.push(`*${n}. ${it.title}*`);
      lines.push(`    ${instruction(it)}`);
      lines.push(ADMIN_URL
        ? `    Where: *${label}*  →  \`${ADMIN_URL}${path}\``
        : `    Where: *${label}*  (admin panel)`);
    }
  };

  block(actions, '\u{1F534} *DO THIS*');
  block(checks,  '\u{1F7E1} *CHECK THIS*');
  block(todo,    '\u{1F4DD} *ON THE LIST*');

  lines.push('');
  lines.push('—');
  lines.push('This is every open item in one place. It is re-sent when the list');
  lines.push('changes, and repeated every ' + REMIND_HOURS + 'h while anything is still open.');
  return lines.join('\n').replace(/^\n+/, '');
}

function loadState() {
  try { return JSON.parse(readFileSync(STATE, 'utf8')); } catch { return {}; }
}
function saveState(s) {
  if (DRY) return true;            // a dry run must not change what the next real run sees
  try { mkdirSync(dirname(STATE), { recursive: true }); writeFileSync(STATE, JSON.stringify(s, null, 2)); return true; }
  catch (e) { console.error('could not save state:', e.message); return false; }
}

function notify(subject, body) {
  return new Promise((resolve) => {
    execFile(NOTIFY, [subject, body], { timeout: 60000 }, (err, out, errOut) => {
      if (err) { console.error('notify failed:', (errOut || err.message || '').slice(0, 300)); return resolve(false); }
      resolve(true);
    });
  });
}

async function main() {
  let svcs = [];
  try { svcs = await collect(); } catch (e) { svcs = []; }

  const c = upstreamCreds();
  let exOver = null;
  if (c && c.exchange) {
    try { exOver = await exchangeCall(c.exchange, 'owner-actions', 'GET', '/admin/api/overview'); }
    catch (e) { exOver = { readable: false, status: 0, json: null, reason: e.message }; }
  }

  const found = needsYou({ svcs, tasks: [], exOver, wrap: wrapdeskState(), reports: [], base: '' });
  const st = loadState();
  const now = Math.floor(Date.now() / 1000);

  // SETTLE. An item that says "could not read" is often a blip that is gone by
  // the next check. Such items carry `settle: n` and are pushed only once n
  // runs in a row have seen them; a real outage survives that, a network
  // hiccup does not. The dashboard is not delayed -- it shows every item at
  // once -- only the page to the owner's phone is.
  const streak = {};
  for (const i of found) {
    if (i.settle > 1) streak[i.title] = ((st.streak || {})[i.title] || 0) + 1;
  }
  const items = found.filter(i => !(i.settle > 1) || streak[i.title] >= i.settle);
  for (const i of found.filter(x => !items.includes(x))) {
    console.log(`holding "${i.title}": seen ${streak[i.title]} of ${i.settle} runs in a row`);
  }

  if (!items.length) {
    // THE LIST EMPTIED. Until 2026-09-23 this sent nothing, so the last
    // message -- "1 thing(s) need you to act" -- stood in the channel as if
    // still true, and the only way to learn otherwise was to go and look. One
    // short message on the way to empty, never again until something new
    // appears: that is not the every-ten-minutes all-clear warned about above.
    if (st.sig) {
      const was = Array.isArray(st.titles) && st.titles.length
        ? st.titles.map(t => `• ${t}`).join('\n')
        : `the ${st.count || ''} item(s) in the message sent at `
          + `${st.at ? new Date(st.at * 1000).toISOString().slice(11, 16) + ' UTC' : 'the last run'}`;
      const subject = 'PCoin: nothing needs you now';
      const body = `Cleared since the last message:\n${was}\n\n—\n`
        + 'The next message comes when something new needs you.';
      if (DRY) {
        console.log('--- DRY RUN, nothing sent ---');
        console.log(subject);
        console.log(body);
        return 0;
      }
      if (!(await notify(subject, body))) {
        saveState({ ...st, streak });          // sig kept, so the all-clear is retried next run
        return 1;
      }
      console.log('list emptied — sent the all-clear once');
    } else {
      console.log('nothing open — sending nothing');
    }
    // Clear the signature so the NEXT thing that appears is sent immediately
    // rather than being mistaken for an unchanged list.
    return saveState({ sig: '', at: now, streak }) ? 0 : 1;
  }

  // The signature is built from severities and TITLES only, never from the
  // detail text. Details carry ages and prices that move every run; hashing
  // them would make every single run look like a change and turn this into the
  // every-ten-minutes spam the channel must not become.
  const sig = createHash('sha256')
    .update(items.map(i => `${i.sev}|${i.title}`).sort().join('\n')).digest('hex').slice(0, 32);

  const ageH = st.at ? (now - st.at) / 3600 : 1e9;
  if (st.sig === sig && ageH < REMIND_HOURS) {
    console.log(`unchanged (${items.length} item(s), last sent ${ageH.toFixed(1)}h ago) — sending nothing`);
    return saveState({ ...st, streak }) ? 0 : 1;
  }

  const nAct = items.filter(i => i.sev === 'action').length;
  const subject = nAct
    ? `PCoin: ${nAct} thing(s) need you to act`
    : `PCoin: ${items.length} thing(s) to check`;
  const body = render(items);

  if (DRY) {
    console.log('--- DRY RUN, nothing sent ---');
    console.log(subject);
    console.log(body);
    return 0;
  }

  const ok = await notify(subject, body);
  // The titles are kept so the all-clear can say WHAT cleared. A failed send
  // still records the streaks, so a settling item does not start over.
  const saved = ok
    ? saveState({ sig, at: now, count: items.length, titles: items.map(i => i.title), streak })
    : saveState({ ...st, streak });
  return ok && saved ? 0 : 1;
}

main().then(c => process.exit(c)).catch(e => { console.error(e); process.exit(1); });
