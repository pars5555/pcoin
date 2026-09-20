// /wrapdesk - is the wrap desk taking new requests, and one switch to change it.
//
// The panel and the wrap desk run on the SAME host, so this writes the switch
// file directly. No SSH key, no second credential, no new service to trust --
// the panel gains the ability to flip one flag on one path and nothing else.
//
// WHAT THE SWITCH DOES AND DOES NOT DO, said on the page as well as here,
// because somebody will press it in six months without reading anything:
// closing stops NEW wrap requests. Wraps already in flight keep counting
// confirmations and are still paid. Closing the door and repudiating a debt are
// different acts and only one of them has ever been announced.
//
// The state shown is READ FROM THE FILE the desk itself reads, every render --
// never remembered, never cached. A control that reports its own intention
// rather than the world is the failure mode this whole panel exists to avoid.
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { esc, card, note, tiles } from './ui.mjs';

// The flag this panel OWNS and can actually write.
//
// It was /etc/pcoin/wrapdesk-closed until 2026-09-19, and that is why the
// button on this page had never once worked: the panel runs
// ProtectSystem=strict, so /etc/pcoin is read-only to it and every press
// returned "could not change it". It failed honestly rather than lying, but it
// failed. /etc/pcoin/control is granted to the panel because it holds no
// secrets -- /etc/pcoin holds the keeper's private key and the desk's SSO
// secret and must never be writable from a web page.
export const CLOSED_FILE = '/etc/pcoin/control/wrapdesk-closed';

// Every path the DESK treats as closing it, in the desk's own order. The panel
// can only remove the first; the rest are shown so that a flag it cannot clear
// is never mistaken for one it has.
export const LEGACY_CLOSED_FILES = ['/etc/pcoin/wrapdesk-closed'];
const ALL_CLOSED_FILES = [CLOSED_FILE, ...LEGACY_CLOSED_FILES];

export function wrapdeskState() {
  // Unreadable is NOT open. If this cannot be determined, say so rather than
  // drawing a green light -- "I could not look" and "it is running" must never
  // render the same, and here the difference is whether money can arrive.
  const hits = [];
  for (const path of ALL_CLOSED_FILES) {
    try {
      if (!existsSync(path)) continue;
      let body = '';
      try { body = readFileSync(path, 'utf8'); }
      catch (e) { body = `(exists but could not be read: ${e.message})`; }
      hits.push({ path, note: body });
    } catch (e) {
      return { open: null, note: '', error: `${path}: ${e.message}`, hits: [] };
    }
  }
  return {
    open: hits.length === 0,
    note: hits.map((h) => h.note).join(String.fromCharCode(10)),
    hits,
    // A flag the desk honours but this page cannot delete. Reopening will not
    // work while one of these is present, and saying so beats a button that
    // reports success and changes nothing.
    stuck: hits.filter((h) => h.path !== CLOSED_FILE).map((h) => h.path),
  };
}

// ── WHAT THE DESK IS WAITING FOR ─────────────────────────────────────────────
//
// The page used to be one switch, which answered "is intake open" and nothing
// else. The owner, 2026-09-20: "why wrap desk missing from global admin, there
// should be wrapdesk separate section showing everything related to wrap desk,
// so admin enter and know what is pending and what he should do". Quite right:
// the hourly Telegram alert said "wrap desk: 2 thing(s) need you" and the only
// way to find out WHICH two was to SSH in and read a journal.
//
// This asks THE WATCHER, rather than reimplementing it. The alert and this page
// then come from one piece of code and cannot drift into disagreeing about
// whether somebody is owed money.
//
// TWO RULES, BOTH PAID FOR (CLAUDE.md 7.14):
//
//  * IT MUST RUN WITH THE UNIT'S ENVIRONMENT. Every setting lives in
//    Environment= lines on pcoin-wrapdesk-watch.service, so a bare run is a
//    DIFFERENT PROGRAM: it loses WRAP_OPENED_AT_HEIGHT (no floor, so the
//    reserve's own founding deposit reads as a customer owed 237.50 wPCN) and
//    WRAP_TOTAL_ALLOC (1500 instead of 7500, so payable wraps read as blocked).
//    Reproduced on 2026-09-20, which is how this page came to be written.
//  * IT MUST NOT BE ABLE TO SEND. --dry-run is verified to send nothing, and
//    PCOIN_NOTIFY is pinned to /bin/true as well -- the variable the code reads
//    is PCOIN_NOTIFY, and a session once set NOTIFY= instead and disabled
//    nothing at all while believing it had.
const WATCH = '/usr/local/bin/pcoin-wrapdesk-watch';
const UNIT = 'pcoin-wrapdesk-watch.service';

function unitEnvironment() {
  // systemctl prints: Environment=A=1 B=2 ... on one line.
  const out = execFileSync('systemctl', ['show', UNIT, '-p', 'Environment', '--no-pager'],
    { encoding: 'utf8', timeout: 15000 });
  const env = {};
  const line = String(out).replace(/^Environment=/, '').trim();
  // Values here are numbers and heights, never quoted strings with spaces.
  for (const pair of line.split(/\s+/)) {
    const i = pair.indexOf('=');
    if (i > 0) env[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return env;
}

export function wrapdeskWork() {
  let env;
  try {
    env = unitEnvironment();
  } catch (e) {
    return { ok: false, why: `could not read ${UNIT}'s environment: ${e.message}` };
  }
  if (!env.WRAP_TOTAL_ALLOC || !env.WRAP_OPENED_AT_HEIGHT) {
    // Refuse rather than show numbers computed from defaults. Those numbers
    // look exactly like real ones and have already caused a false alert.
    return { ok: false, why: 'the unit does not define WRAP_OPENED_AT_HEIGHT and '
      + 'WRAP_TOTAL_ALLOC, so any figures here would be computed from defaults '
      + 'and would be wrong in the direction of inventing a debt' };
  }

  let raw;
  try {
    raw = execFileSync(WATCH, ['--dry-run'], {
      encoding: 'utf8',
      timeout: 120000,
      env: { ...process.env, ...env, PCOIN_NOTIFY: '/bin/true', NOTIFY: '/bin/true' },
    });
  } catch (e) {
    // It exits non-zero when work is outstanding, which is not an error.
    if (e && typeof e.stdout === 'string' && e.stdout.length) raw = e.stdout;
    else return { ok: false, why: `the watcher did not run: ${e.message}` };
  }

  const lines = String(raw).split(String.fromCharCode(10));
  const items = [];
  let cur = null;
  let allocation = null;
  const warnings = [];

  const push = () => { if (cur) items.push(cur); cur = null; };

  for (const ln of lines) {
    const t = ln.trim();
    if (!t) continue;

    if (t.startsWith('[action] ACTION: send')) {
      push();
      cur = { kind: 'send', title: t.replace('[action] ', ''), detail: [], close: null, to: null };
      continue;
    }
    if (t.startsWith('[action] WITHHELD')) {
      push();
      cur = { kind: 'withheld', title: 'Withheld - do not send yet', detail: [], close: null, to: null };
      continue;
    }
    if (/^\[info\] WRAP /.test(t)) {
      push();
      cur = { kind: 'waiting', title: t.replace('[info] ', ''), detail: [], close: null, to: null };
      continue;
    }
    const alloc = t.match(/Allocation: ([\d.]+) of ([\d.]+) wPCN used, ([\d.]+) left/);
    if (alloc) {
      allocation = { used: Number(alloc[1]), total: Number(alloc[2]), left: Number(alloc[3]) };
      push();
      continue;
    }
    if (t.startsWith('[warn]')) { warnings.push(t.replace('[warn] ', '')); push(); continue; }
    if (t.startsWith('UNHEALTHY') || t.startsWith('[info] Cycle')) {
      if (t.startsWith('[info] Cycle')) warnings.push(t.replace('[info] ', ''));
      push();
      continue;
    }

    if (cur) {
      const to = t.match(/^TO\s*:\s*(0x[0-9a-fA-F]{40})/);
      if (to) cur.to = to[1];
      if (/^pcoin-wrapdesk-watch --(released|refunded)/.test(t)) cur.close = t;
      else cur.detail.push(t);
    }
  }
  push();

  return { ok: true, items, allocation, warnings, ranAt: new Date().toISOString() };
}

function workCard(w) {
  if (!w.ok) {
    return card('What needs you',
      note('This could not be read, so nothing is shown rather than something wrong. '
        + esc(w.why)));
  }
  const actions = w.items.filter((i) => i.kind === 'send');
  const held = w.items.filter((i) => i.kind === 'withheld');
  const waiting = w.items.filter((i) => i.kind === 'waiting');

  const block = (i, colour) =>
    `<div style="border-left:3px solid var(--${colour});padding:8px 12px;margin:10px 0;`
    + `background:var(--panel-2);border-radius:4px">`
    + `<div style="font-weight:700">${esc(i.title)}</div>`
    + (i.to ? `<div style="margin-top:4px">to <code>${esc(i.to)}</code></div>` : '')
    + `<pre style="white-space:pre-wrap;margin:6px 0 0;font-size:12px">${esc(i.detail.join(String.fromCharCode(10)))}</pre>`
    + (i.close
        ? `<div style="margin-top:8px"><span class="muted">When done, close it out or it repeats hourly:</span>`
          + `<pre style="white-space:pre-wrap;margin:4px 0 0;font-size:12px">${esc(i.close)}</pre></div>`
        : '')
    + `</div>`;

  let body = '';
  if (!actions.length && !held.length) {
    body += '<p><b>Nothing is waiting to be sent.</b></p>';
  }
  if (actions.length) {
    body += `<h3>Send these (${actions.length})</h3>`
      + '<p class="muted">Confirmed past 100 blocks and within the allocation. '
      + 'Send from the inventory wallet, then run the close-out line.</p>'
      + actions.map((i) => block(i, 'green')).join('');
  }
  if (held.length) {
    body += `<h3>Blocked, needs a decision (${held.length})</h3>`
      + '<p class="muted">The PCN is safe in the reserve and nothing is lost by waiting. '
      + 'Raise the allocation, refund the deposit, or pay it and record why &mdash; '
      + 'but decide it deliberately.</p>'
      + held.map((i) => block(i, 'yellow')).join('');
  }
  if (waiting.length) {
    body += `<h3>Still confirming (${waiting.length})</h3>`
      + '<p class="muted">Nothing to do. The depth is the whole defence against a reorg.</p>'
      + waiting.map((i) => block(i, 'blue')).join('');
  }
  for (const wn of w.warnings) body += note(esc(wn));
  return card('What needs you', body);
}

function allocationCard(w) {
  if (!w.ok || !w.allocation) return '';
  const a = w.allocation;
  const pct = a.total > 0 ? Math.min(100, (a.used / a.total) * 100) : 0;
  return card('Allocation',
    `<div style="display:flex;justify-content:space-between;font-size:13px">`
    + `<span>${esc(a.used.toFixed(2))} wPCN issued</span>`
    + `<span class="muted">${esc(a.left.toFixed(2))} left of ${esc(a.total.toFixed(2))}</span></div>`
    + `<div style="height:10px;background:var(--panel-2);border-radius:999px;margin-top:6px;overflow:hidden">`
    + `<div style="height:100%;width:${pct.toFixed(1)}%;background:var(--${pct > 90 ? 'red' : pct > 75 ? 'yellow' : 'green'})"></div></div>`
    + note('This is a RUNNING TOTAL that only counts up, and it is raised by hand. '
      + 'It is the ceiling on how much wPCN the desk may ever issue, not a daily budget.'));
}

export function wrapdeskPage(st, flash, work) {
  const pill = (txt, colour) =>
    `<span style="display:inline-block;padding:4px 12px;border-radius:999px;` +
    `font-weight:700;font-size:12px;letter-spacing:.5px;` +
    `background:var(--${colour});color:#0b1020">${esc(txt)}</span>`;

  let statusPill, button, explain;
  if (st.open === null) {
    statusPill = pill('UNKNOWN', 'yellow');
    button = '';
    explain = 'The switch file could not be read, so the real state is unknown. '
      + 'No button is offered rather than one that might do the opposite of what '
      + 'it says. ' + (st.error ? esc(st.error) : '');
  } else if (st.open) {
    statusPill = pill('OPEN', 'green');
    button = '<form method="post" style="display:inline">'
      + '<input type="hidden" name="action" value="close">'
      + '<button style="background:var(--red);color:#0b1020;border:0;border-radius:999px;'
      + 'padding:8px 20px;cursor:pointer;font-weight:700">Close the desk</button></form>';
    explain = 'New wrap requests are being accepted.';
  } else {
    statusPill = pill('CLOSED', 'red');
    button = '<form method="post" style="display:inline">'
      + '<input type="hidden" name="action" value="open">'
      + '<button style="background:var(--green);color:#0b1020;border:0;border-radius:999px;'
      + 'padding:8px 20px;cursor:pointer;font-weight:700">Reopen the desk</button></form>';
    explain = 'New wrap requests are refused with HTTP 503 and an explanation. '
      + 'Wraps already in flight are unaffected.';
    if (st.stuck && st.stuck.length) {
      button = '';
      explain += ' <b>Reopening is not offered here</b>, because the desk is also held '
        + 'closed by ' + st.stuck.map((p) => `<code>${esc(p)}</code>`).join(', ')
        + ', which this panel cannot delete. Remove it on the host first. A button that '
        + 'reported success and left the desk closed would be worse than no button.';
    }
  }

  const w = work || { ok: false, why: 'not collected' };
  const nSend = w.ok ? w.items.filter((i) => i.kind === 'send').length : null;
  const nHeld = w.ok ? w.items.filter((i) => i.kind === 'withheld').length : null;
  const nWait = w.ok ? w.items.filter((i) => i.kind === 'waiting').length : null;

  return '<h1>Wrap desk</h1>'
    + '<p class="muted">Everything the desk is doing: what is waiting on you, what is '
      + 'still confirming, how much of the allocation is gone, and whether intake is open.</p>'
    + (flash ? `<div class="card" style="border-left:4px solid var(--blue)"><p>${esc(flash)}</p></div>` : '')
    + tiles([
        ['Intake', st.open === null ? 'unknown' : (st.open ? 'open' : 'closed'),
         st.open === null ? 'yellow' : (st.open ? 'green' : 'red')],
        ['To send', nSend === null ? '?' : String(nSend), nSend ? 'green' : 'muted'],
        ['Blocked', nHeld === null ? '?' : String(nHeld), nHeld ? 'yellow' : 'muted'],
        ['Confirming', nWait === null ? '?' : String(nWait), 'blue'],
        ['Allocation left', w.ok && w.allocation ? w.allocation.left.toFixed(0) + ' wPCN' : '?',
         w.ok && w.allocation && w.allocation.left < 300 ? 'yellow' : 'muted'],
      ])
    + workCard(w)
    + allocationCard(w)
    + card('Switch',
        '<div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">'
        + button + statusPill + '</div>'
        + '<p class="muted" style="margin-top:10px">' + explain + '</p>'
        + '<p class="muted">Takes effect on the next request &mdash; the desk reads this '
        + 'per request, so there is no restart and nobody mid-request is interrupted.</p>'
        + '<p class="muted">This page writes <code>' + esc(CLOSED_FILE) + '</code>. The desk '
        + 'is closed if that file <b>or</b> any older flag exists, so a flag created by hand '
        + 'from an out-of-date runbook still shuts the desk.</p>')
    + (st.note
        ? card('Why it was closed',
            `<pre style="white-space:pre-wrap;background:var(--panel-2);padding:12px;`
            + `border-radius:4px;font-size:12px">${esc(st.note)}</pre>`)
        : '')
    + card('What closing does, and does not do',
        '<p><b>It stops new wrap requests.</b> That is all it stops.</p>'
        + note('Wraps already in flight keep counting confirmations and are still paid. '
             + 'Closing the door and repudiating a debt are different acts, and only the '
             + 'first one has ever been announced. If you reopen this, reopen it because '
             + 'the allocation and the PancakeSwap depth can carry it &mdash; the closure '
             + 'on 2026-09-13 was because they could not.'));
}
