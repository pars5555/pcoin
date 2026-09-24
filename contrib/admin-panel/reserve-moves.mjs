// /reserve-moves — tell the solvency watcher about a reserve transfer BEFORE
// making it (2026-09-24).
//
// pcoin-solvency-watch pages "wPCN solvency: CRITICAL" on any spend from the
// core reserve. That is right for a theft and wrong for the owner moving surplus
// to market-hot, and an alarm that fires on the owner's own routine teaches
// everyone to ignore it. A plan registered here lets the watcher recognise ONE
// matching move: same amount within 0.01 PCN (the network fee), inside the
// plan's window, and only while backing stays whole. Anything else still pages
// CRITICAL, including a planned move that breaks backing.
//
// Adding a plan weakens an alarm, so it needs the authenticator code, used
// once (codeOnce, shared with Send PCN). Cancelling one only makes the watcher
// stricter, so it does not. The plans file is written ONLY here; which plans
// were used is the watcher's own record, in its state file.
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { esc, card, note, kv, tbl, failed } from './ui.mjs';
import { codeOnce } from './send.mjs';

const PLANS = process.env.SOLVENCY_PLANS || '/etc/pcoin/control/reserve-planned-moves.json';
const STATE = process.env.SOLVENCY_STATE || '/var/lib/pcoin-wrapdesk/solvency.json';
const ISSUED = 50000;               // wPCN issuedSupply, the same figure the watcher uses
const MAX_HOURS = 72;

function readPlans() {
  if (!existsSync(PLANS)) return { ok: true, plans: [] };
  try {
    const j = JSON.parse(readFileSync(PLANS, 'utf8'));
    return { ok: true, plans: Array.isArray(j.plans) ? j.plans : [] };
  } catch (e) { return { ok: false, error: e.message, plans: [] }; }
}
function writePlans(plans) {
  const tmp = PLANS + '.tmp';
  writeFileSync(tmp, JSON.stringify({ _comment: 'Written by the admin panel (Reserve moves). Read by pcoin-solvency-watch.', plans }, null, 2) + '\n');
  renameSync(tmp, PLANS);
}
function readState() {
  try { return JSON.parse(readFileSync(STATE, 'utf8')); } catch { return null; }
}

export function reserveMovesAction(form, { verifyCode }) {
  const step = form.get('step');
  const r = readPlans();
  if (!r.ok) return { bad: true, flash: `The plans file is unreadable (${r.error}); nothing was changed.` };
  if (step === 'cancel') {
    const id = String(form.get('id') || '');
    const p = r.plans.find((x) => x.id === id);
    if (!p) return { bad: true, flash: 'No such plan.' };
    p.cancelled = true; p.cancelledAt = Math.floor(Date.now() / 1000);
    writePlans(r.plans);
    return { flash: `Plan for ${p.pcn} PCN cancelled: the watcher will page CRITICAL on that move again.` };
  }
  if (step !== 'add') return { bad: true, flash: 'Unknown action.' };
  const pcn = Number(String(form.get('pcn') || '').trim());
  const hours = Number(String(form.get('hours') || '24').trim());
  const noteText = String(form.get('note') || '').trim().slice(0, 200);
  if (!(pcn > 0) || !/^\d+(\.\d{1,8})?$/.test(String(form.get('pcn') || '').trim())) {
    return { bad: true, flash: 'Amount must be a positive number of PCN with at most 8 decimals.' };
  }
  if (!(hours >= 1 && hours <= MAX_HOURS)) return { bad: true, flash: `The window must be 1 to ${MAX_HOURS} hours.` };
  if (!noteText) return { bad: true, flash: 'Say what the move is for (e.g. "surplus to market-hot").' };
  const st = readState();
  if (st && typeof st.total_pcn === 'number' && pcn > st.total_pcn - ISSUED) {
    return { bad: true, flash: `That is more than the surplus above ${ISSUED} wPCN issued (${(st.total_pcn - ISSUED).toFixed(8)} PCN). `
      + 'A move that large breaks backing, and the watcher would page CRITICAL whatever is planned.' };
  }
  if (!codeOnce(form.get('code'), verifyCode)) return { bad: true, flash: 'Wrong or reused authenticator code. Nothing was registered.' };
  const now = Math.floor(Date.now() / 1000);
  r.plans.push({ id: randomBytes(6).toString('hex'), pcn: Math.round(pcn * 1e8) / 1e8, created: now,
    until: now + Math.round(hours * 3600), note: noteText });
  writePlans(r.plans);
  return { flash: `Registered: a move of ${pcn} PCN from the core reserve in the next ${hours} h will be reported as planned, not CRITICAL.` };
}

export function reserveMovesPage({ base, result = null }) {
  const r = readPlans();
  const st = readState();
  const used = (st && st.plans_used) || {};
  const now = Date.now() / 1000;
  const surplus = st && typeof st.total_pcn === 'number' ? st.total_pcn - ISSUED : null;
  const flash = result && result.flash
    ? `<div class="card" style="border-left:3px solid ${result.bad ? 'var(--red)' : 'var(--green)'}"><p class="${result.bad ? 'bad' : 'ok'}">${esc(result.flash)}</p></div>` : '';
  const stateOf = (p) => p.cancelled ? '<span class="muted">cancelled</span>'
    : used[p.id] ? `<span class="ok">done</span> (moved ${esc(used[p.id].moved)} PCN)`
    : p.until < now ? '<span class="muted">expired unused</span>'
    : '<span class="warn">waiting for the move</span>';
  const rows = r.plans.slice().reverse().slice(0, 30).map((p) => [
    esc(new Date(p.created * 1000).toISOString().replace('T', ' ').slice(0, 16)), `<b>${esc(p.pcn)}</b> PCN`,
    esc(new Date(p.until * 1000).toISOString().replace('T', ' ').slice(0, 16)), esc(p.note), stateOf(p),
    !p.cancelled && !used[p.id] && p.until >= now
      ? `<form method="POST" action="${base}/reserve-moves" style="margin:0"><input type="hidden" name="step" value="cancel"><input type="hidden" name="id" value="${esc(p.id)}"><button class="ghost" type="submit">Cancel</button></form>` : '',
  ]);
  return flash
    + card('The reserve right now', st ? kv([
      ['Core reserve', `${Number(st.core_pcn).toFixed(8)} PCN`, 'the address the watcher guards; any spend from it pages CRITICAL unless planned here'],
      ['Total reserve', `${Number(st.total_pcn).toFixed(8)} PCN`, 'core plus wrap deposits'],
      ['wPCN outstanding', `${Number(st.supply).toFixed(8)}`, ''],
      ['Surplus above 50,000 issued', surplus === null ? '&mdash;' : `<b>${surplus.toFixed(8)} PCN</b>`, 'the most a move can take and leave backing whole'],
    ]) : failed('the solvency watcher state', 'unreadable'))
    + card('Register a planned move', `
      <form method="POST" action="${base}/reserve-moves" class="inline" autocomplete="off">
        <input type="hidden" name="step" value="add">
        <label class="muted">PCN <input name="pcn" type="text" inputmode="decimal" placeholder="e.g. 6000" style="width:9em" required></label>
        <label class="muted">valid for <input name="hours" type="number" min="1" max="${MAX_HOURS}" value="24" style="width:5em"> h</label>
        <input name="note" type="text" placeholder="what it is for, e.g. surplus to market-hot" maxlength="200" required>
        <input name="code" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="authenticator" style="width:9em" required>
        <button type="submit">Register</button>
      </form>`
      + note('Register the move <b>before</b> you send it. The watcher then reports the one matching spend from the core '
        + 'reserve (same amount within 0.01 PCN for the fee, inside the window) as "planned move done" instead of '
        + 'CRITICAL, and marks the plan done. A move that breaks backing still pages CRITICAL, planned or not, and so '
        + 'does any spend that matches no plan. Record the move in PCOIN-WPCN-RUNBOOK.md as always.'))
    + card('Plans', r.ok ? tbl(['Registered (UTC)', 'Amount', 'Valid until (UTC)', 'Note', 'State', ''], rows, 'No plans registered yet.')
      : failed('the plans file', r.error));
}
