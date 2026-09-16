// /programs - who has qualified for a bounty program, and what you decided.
//
// THE OWNER PAYS BY HAND, FROM HIS OWN WALLET. That is the whole shape of this
// page and it is a deliberate choice, not a missing feature: there is no
// bounty hot wallet, no automated payer, and nothing here can move a satoshi.
// The machine's job is to say "this person qualified, here is the evidence";
// the owner's job is to approve it and send the coin; this page's job is to
// record both so the program is auditable from day one.
//
// So a row here is never "paid" because a timer said so. It is paid when a
// human pastes a txid, and the txid is the only proof the page will accept.
//
// WHERE THE DATA COMES FROM. Two files, deliberately owned by different things:
//
//   CLAIMS_FILE      written by the per-program checkers, never by this panel.
//   DECISIONS_FILE   written by this panel, never by a checker.
//
// Merging at render rather than writing back into the claims file is the same
// split the approvals page uses, and it exists so that a panel session cannot
// corrupt the evidence. A stolen session could approve a claim it should not
// have; it could not invent the claim, and it could not forge the chain.
//
// AN UNREADABLE FILE IS NOT AN EMPTY FILE. If the claims file cannot be read the
// page says so in red and shows nothing, because "no qualified claims" and "I
// could not look" are different answers and this project has paid three times
// for code that collapsed them into one.
//
// THE THREE PROGRAMS (D:\pc.am\PCOIN-BOUNTY-PLAN.md, owner-approved 2026-09-16):
//   P1  200 PCN   someone you introduced signs up on exchange.pc.am and buys PCN
//   P2  500 PCN   an independent pool that attracts 5+ miners, sustained 30 days
//   P3  10% back  spending PCN at a public AI rail, max 50 PCN/month
//
// P1 is settled INSIDE the exchange as an internal balance, not as a coin, so
// its rows appear here as a record and are marked accordingly - approving one
// here does not move anything, the exchange credits it from house:bounty.
// P2 and P3 are real sends from the owner's own wallet.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { esc, DASH, N, tbl, card, note, tiles, addr, when, agoEpoch } from './ui.mjs';

const CLAIMS_FILE    = process.env.PROGRAMS_CLAIMS    || '/var/lib/pcoin-programs/claims.json';
const DECISIONS_FILE = process.env.PROGRAMS_DECISIONS || '/var/lib/pcoin-programs/decisions.json';

// The monthly pot, and the split that stops one program eating the others.
// P2 is a rare one-off and sits OUTSIDE the cap on purpose - see the plan.
const MONTH_CAP_PCN = 2000;
const POTS = { P1: 1400, P3: 400 };

const PROGRAM = {
  P1: { name: 'Exchange referral',   pcn: 200, capped: true,  settles: 'exchange' },
  P2: { name: 'Independent pool',    pcn: 500, capped: false, settles: 'wallet' },
  P3: { name: 'AI service rebate',   pcn: null, capped: true, settles: 'wallet' },
};

const COLOUR = {
  qualified: 'yellow', approved: 'blue', paid: 'green',
  refused: 'muted', held: 'muted',
};

const readJson = f => JSON.parse(readFileSync(f, 'utf8'));

function writeAtomic(file, obj) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o640 });
  renameSync(tmp, file);
}

export function loadDecisions() {
  try { const d = readJson(DECISIONS_FILE); return (d && typeof d === 'object') ? d : {}; }
  catch { return {}; }          // absent is genuinely empty; this file is ours
}

// The month a payment counts against is the month it was PAID, not the month it
// qualified. A claim that sat in the hold over a month boundary must not make
// last month's budget look overspent after the fact.
const monthKey = epoch => new Date((epoch || 0) * 1000).toISOString().slice(0, 7);

export function programsData() {
  let claims = null, error = null;
  try {
    const raw = readJson(CLAIMS_FILE);
    claims = Array.isArray(raw) ? raw : (Array.isArray(raw && raw.claims) ? raw.claims : []);
  } catch (e) {
    error = e.message;          // keep it null, do NOT fall back to []
  }

  const decisions = loadDecisions();
  const now = new Date().toISOString().slice(0, 7);

  const rows = (claims || []).map(c => {
    const d = decisions[c.id] || {};
    // A decision can only move a claim FORWARD from what the checker found.
    // It can never resurrect one the checker has since withdrawn.
    const state = d.state && c.state !== 'withdrawn' ? d.state : (c.state || 'qualified');
    return {
      ...c,
      state,
      decided_at: d.at || null,
      decided_by: d.by || null,
      refused_reason: d.refused_reason || c.refused_reason || null,
      paid_txid: d.paid_txid || null,
      paid_at: d.paid_at || null,
    };
  });

  rows.sort((a, b) => (b.qualified_at || 0) - (a.qualified_at || 0));

  const paidThisMonth = rows
    .filter(r => r.state === 'paid' && r.paid_at && monthKey(r.paid_at) === now
                 && PROGRAM[r.program] && PROGRAM[r.program].capped)
    .reduce((s, r) => s + (Number(r.pcn) || 0), 0);

  const owed = rows
    .filter(r => r.state === 'approved')
    .reduce((s, r) => s + (Number(r.pcn) || 0), 0);

  return { rows, error, paidThisMonth, owed, month: now,
           counts: rows.reduce((m, r) => (m[r.state] = (m[r.state] || 0) + 1, m), {}) };
}

// One decision. Approving records an INTENT; only a txid records a payment.
export function programsAction(form) {
  const id = String(form.get('id') || '').slice(0, 64);
  const action = String(form.get('action') || '');
  if (!id) return;

  const d = loadDecisions();
  const prev = d[id] || {};
  const at = new Date().toISOString();

  if (action === 'approve') {
    d[id] = { ...prev, state: 'approved', at, by: 'admin-panel' };
  } else if (action === 'refuse') {
    const why = String(form.get('reason') || '').slice(0, 300).trim();
    d[id] = { ...prev, state: 'refused', at, by: 'admin-panel',
              refused_reason: why || 'no reason given' };
  } else if (action === 'paid') {
    const txid = String(form.get('txid') || '').trim().toLowerCase();
    // A payment with no proof is not a payment. And a txid already recorded is
    // never overwritten - that is how a double send gets written out of the
    // record instead of being caught.
    if (!/^[0-9a-f]{64}$/.test(txid)) return;
    if (prev.paid_txid && prev.paid_txid !== txid) return;
    d[id] = { ...prev, state: 'paid', at, by: 'admin-panel',
              paid_txid: txid, paid_at: Math.floor(Date.now() / 1000) };
  } else if (action === 'reopen') {
    // Undo an approval or a refusal. Deliberately refuses to undo a payment:
    // the coin has left, and a record that can be edited back is not a record.
    if (prev.paid_txid) return;
    delete d[id];
  } else {
    return;
  }
  writeAtomic(DECISIONS_FILE, d);
}

const money = p => (p === null || p === undefined) ? DASH
  : `<b>${esc(N(Number(p), Number(p) % 1 ? 4 : 0))}</b> PCN`;

function evidenceCell(r) {
  const text = esc(String(r.evidence || '').slice(0, 120));
  return r.evidence_url
    ? `<a href="${esc(r.evidence_url)}" rel="noreferrer noopener" target="_blank">${text || 'evidence'}</a>`
    : (text || DASH);
}

function actions(r) {
  const hid = `<input type="hidden" name="id" value="${esc(r.id)}">`;
  const f = inner => `<form method="post" style="display:inline">${hid}${inner}</form>`;
  if (r.state === 'qualified') {
    return f(`<button name="action" value="approve">Approve</button>`)
         + ' ' + f(`<input name="reason" placeholder="reason" style="width:9rem">`
                 + `<button name="action" value="refuse" class="ghost">Refuse</button>`);
  }
  if (r.state === 'approved') {
    if (PROGRAM[r.program] && PROGRAM[r.program].settles === 'exchange') {
      return `<span class="muted">credited inside the exchange &mdash; no send</span> `
           + f(`<button name="action" value="reopen" class="ghost">Undo</button>`);
    }
    return f(`<input name="txid" placeholder="txid of your payment" style="width:13rem" `
           + `pattern="[0-9a-fA-F]{64}" title="64 hex characters">`
           + `<button name="action" value="paid">Record paid</button>`)
         + ' ' + f(`<button name="action" value="reopen" class="ghost">Undo</button>`);
  }
  if (r.state === 'paid') {
    return `<a href="https://explorer.pc.am/tx/${esc(r.paid_txid)}" target="_blank"
             rel="noreferrer noopener">${esc(String(r.paid_txid).slice(0, 12))}&hellip;</a>`;
  }
  if (r.state === 'refused') {
    return `<span class="muted">${esc(r.refused_reason || '')}</span> `
         + f(`<button name="action" value="reopen" class="ghost">Undo</button>`);
  }
  return DASH;
}

export function programsPage(d) {
  const head = '<h1>Programs</h1>';

  if (d.error !== null && d.error !== undefined) {
    return head + card('Could not read the claims file',
      `<p class="bad">${esc(d.error)}</p>`
      + note('This is NOT the same as "nobody has qualified". The page could not '
           + 'look, so it is showing nothing rather than an empty list. Check the '
           + 'program checkers are running and that ' + esc(CLAIMS_FILE) + ' exists.'));
  }

  const left = MONTH_CAP_PCN - d.paidThisMonth;
  const t = tiles([
    ['Awaiting you', esc(String(d.counts.qualified || 0)),
     (d.counts.qualified || 0) ? 'yellow' : null],
    ['Approved, unpaid', esc(N(d.owed, 0)) + ' PCN', d.owed ? 'blue' : null],
    [`Paid in ${d.month}`, esc(N(d.paidThisMonth, 0)) + ' PCN', 'green'],
    [`Left of the ${MONTH_CAP_PCN} pot`, esc(N(left, 0)) + ' PCN',
     left <= 0 ? 'red' : null],
  ]);

  const rows = d.rows.map(r => [
    `<span style="color:var(--${COLOUR[r.state] || 'muted'})">${esc(r.state)}</span>`,
    `<b>${esc(r.program || '?')}</b> <span class="muted">`
      + `${esc((PROGRAM[r.program] || {}).name || '')}</span>`,
    esc(r.who || '') || DASH,
    r.address ? addr(r.address) : DASH,
    evidenceCell(r),
    money(r.pcn),
    r.qualified_at ? agoEpoch(r.qualified_at) : DASH,
    actions(r),
  ]);

  const table = card('Claims', tbl(
    ['State', 'Program', 'Who', 'Pays to', 'Evidence', 'Amount', 'Qualified', ''],
    rows,
    'No claims yet. The checkers write here as people qualify; an empty list means '
    + 'they ran and found nobody, which is the expected state before launch.'));

  const how = card('How this page works', note(
    '<b>Nothing here can send coin.</b> Approving records that you agreed; the '
    + 'payment is one you make yourself, and it is only recorded once you paste '
    + 'the txid. A recorded txid is never overwritten and a paid row cannot be '
    + 'undone &mdash; the coin has left, and a record you can edit back is not a '
    + 'record.<br><br>'
    + '<b>P1 is different.</b> An exchange referral is credited as a balance '
    + 'inside exchange.pc.am from the <code>house:bounty</code> account, so there '
    + 'is no send to make; it becomes a real coin only if that person withdraws, '
    + 'through the normal manual withdrawal path.<br><br>'
    + '<b>The budget is 2,000 PCN a month</b> &mdash; P1 up to '
    + POTS.P1 + ', P3 up to ' + POTS.P3 + ', the rest held back. '
    + 'A P2 pool bounty is a rare one-off and is not counted against it.'));

  return head + t + table + how;
}
