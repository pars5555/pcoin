// "Needs you" — everything across the estate that is waiting on the owner,
// gathered into one list and rendered at the top of the dashboard.
//
// WHY THIS EXISTS. The dashboard already had an "Open tasks" number, but it
// counted only tasks somebody had TYPED IN by hand. Meanwhile a withdrawal
// could sit in the exchange queue, the market could be listing more PCN than it
// can deliver, and the wrap desk could be holding something — and none of it
// appeared anywhere on the front page. The owner's words for this: "so i enter
// the admin and see all pending tasks in dashboard".
//
// THE RULE THIS FILE KEEPS, AND IT IS THE WHOLE POINT:
//
//   AN UNREADABLE SOURCE PRODUCES AN ITEM, NEVER SILENCE.
//
// A "what needs doing" list is read as "if this is empty, nothing needs doing".
// So a source that could not be reached must say so IN THE LIST, loudly. The
// alternative — swallowing the error and rendering an empty panel — turns an
// outage into a clean bill of health, which is the single most dangerous thing
// a page like this can do. Every catch below emits an item.
//
// Nothing here writes. Every call is a GET against a read-only token.

const SEV = { action: 0, warn: 1, info: 2 };

const n2 = (x, d = 2) => (typeof x === 'number' && isFinite(x))
  ? x.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })
  : null;

const hours = (s) => (typeof s === 'number' && isFinite(s))
  ? (s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`)
  : '?';

/** Collect everything waiting on a human.
 *
 *  @param svcs    the array from services.collect() — already fetched by the
 *                 dashboard, so this costs no extra upstream calls.
 *  @param tasks   the hand-written task list.
 *  @param exOver  {readable, json} from the exchange /admin/api/overview, or a
 *                 failure shape. Never null-and-ignored.
 *  @param wrap    wrapdeskState().
 *  @param reports user-submitted reports, if the panel has them.
 */
export function needsYou({ svcs = [], tasks = [], exOver = null, wrap = null,
                           reports = [], base = '' } = {}) {
  const items = [];
  const add = (sev, title, detail, href) => items.push({ sev, title, detail, href });

  // ── market ───────────────────────────────────────────────────────────────
  const mkt = svcs.find(x => x.slug === 'market');
  if (!mkt || mkt.status === 'unreadable') {
    add('warn', 'market.pc.am could not be read',
      'This is not "nothing to do" — the ladder, the backing and the order queue '
      + 'are all unknown right now.', `${base}/services/market`);
  } else {
    const f = mkt.facts || {};

    // The book vs what can actually be handed over.
    if (typeof f.remainingPcn === 'number' && typeof f.deliverablePcn === 'number'
        && f.remainingPcn > f.deliverablePcn + 0.5) {
      const gap = f.remainingPcn - f.deliverablePcn;
      // Deliberately NOT "listed for sale". market.pc.am's own page binds
      // "Available to buy" to sellableNowPcn -- the SMALLER figure -- and the
      // buy path enforces it, so no customer is shown or sold the larger one.
      // Calling it "listed" overstated this and made a bookkeeping gap read as
      // an over-promise to buyers. What is actually exposed is the public API
      // field remainingPcn, which an integrator could read as available supply.
      add('warn', `Market ladder holds ${n2(gap, 0)} PCN more than it can deliver`,
        `The ladder's internal stock is ${n2(f.remainingPcn, 0)} PCN but only `
        + `${n2(f.deliverablePcn, 0)} is deliverable. Customers are neither shown nor sold `
        + `the larger number — the page and the buy path both use the smaller one — so this `
        + `is a bookkeeping gap, not an over-promise. It still leaks through the PUBLIC `
        + `api/ladder/state field remainingPcn, which an integrator may read as supply.`,
        `${base}/services/market`);
    }

    // A hand-set backing figure is an assertion, not a measurement.
    if (f.backingManual) {
      add('warn', 'The market’s deliverable figure is hand-set, not measured',
        'backingCapPcn is configured, so the explorer is never consulted and the figure '
        + 'cannot fall on its own if those coins are spent elsewhere. It is only as true '
        + 'as the last time somebody checked it against real coins.',
        `${base}/services/market`);
    }
    if (f.backingDegraded) {
      add('action', 'Market is selling on a cached backing figure',
        'The backing read is failing and sales are continuing on a stale number. '
        + 'When the cache expires, sales stop.', `${base}/services/market`);
    }
    if (f.gateOpen === false) {
      add('action', 'Market sale gate is CLOSED — nobody can buy',
        `Divergence ${n2(f.divergencePct)}% against a ${f.maxDivergencePct}% limit.`,
        `${base}/services/market`);
    }
    const pend = f.orders && f.orders.pending ? f.orders.pending.count : 0;
    if (pend > 0) {
      add('info', `${pend} market order${pend === 1 ? '' : 's'} awaiting payment`,
        'Pending orders hold stock until they expire.', `${base}/services/market`);
    }
    const nr = f.orders && f.orders.needs_review ? f.orders.needs_review.count : 0;
    if (nr > 0) {
      add('action', `${nr} market order${nr === 1 ? '' : 's'} need review`,
        'A delivery did not complete cleanly. These do not resolve themselves.',
        `${base}/services/market`);
    }
  }

  // ── exchange ─────────────────────────────────────────────────────────────
  if (!exOver) {
    add('warn', 'exchange.pc.am was not checked',
      'No exchange credential is configured in upstream.json, so pending withdrawals '
      + 'cannot be seen from here.', `${base}/exchange`);
  } else if (!exOver.readable || exOver.status !== 200) {
    add('action', 'exchange.pc.am could not be read',
      `${exOver.reason || 'HTTP ' + exOver.status}. Withdrawals may be queued and `
      + 'unseen — this is UNKNOWN, not an empty queue.', `${base}/exchange`);
  } else {
    const o = exOver.json || {};
    const q = o.queue || {};

    if (q.open > 0) {
      // 24 hours is the promise made to users on the site.
      const late = typeof q.oldestAgeSeconds === 'number' && q.oldestAgeSeconds > 86400;
      add('action',
        `${q.open} withdrawal${q.open === 1 ? '' : 's'} waiting for you to pay`,
        `Oldest has been waiting ${hours(q.oldestAgeSeconds)}`
        + (late ? ' — PAST the 24 hour promise on the site.' : ' of the 24 hours promised.')
        + ' The exchange holds no spending key; only you can send this.',
        `${base}/exchange?view=withdrawals`);
    }
    if (o.halted) {
      add('action', 'The exchange is HALTED',
        String(o.halted).slice(0, 200), `${base}/exchange`);
    }
    if (Array.isArray(o.invariants) && o.invariants.length) {
      add('action', `${o.invariants.length} exchange invariant(s) failing`,
        o.invariants.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join('; ').slice(0, 300),
        `${base}/exchange`);
    }
    if (o.exchangeOpen === false) {
      add('warn', 'The exchange is closed to trading', 'exchangeOpen is false.',
        `${base}/exchange?view=settings`);
    }
    const dep = o.deposits || {};
    if (dep.held > 0) {
      add('action', `${dep.held} exchange deposit(s) held`,
        'Held deposits are not credited to anyone until you look at them.',
        `${base}/exchange?view=deposits`);
    }
    if (dep.reorgSuspects > 0) {
      add('action', `${dep.reorgSuspects} deposit(s) flagged as reorg suspects`,
        'A credit may rest on a block that was unwound. Credits are never auto-reversed, '
        + 'by design — so this needs a person.', `${base}/exchange?view=deposits`);
    }
    const rec = o.lastReconcile || {};
    if (rec.state && rec.state !== 'balanced') {
      add('action', `Exchange reconcile is ${rec.state}`,
        `on-chain ${rec.onchain} vs recorded ${rec.recorded} (diff ${rec.diff}).`,
        `${base}/exchange`);
    }
    const pool = o.pool || {};
    if (typeof pool.free === 'number' && pool.free < 50) {
      add('warn', `Only ${pool.free} deposit addresses left in the pool`,
        'When the pool runs out, new users cannot be given a deposit address. '
        + 'Refilling it is an offline vault job.', `${base}/exchange?view=pool`);
    }
  }

  // ── wrap desk ────────────────────────────────────────────────────────────
  if (wrap && wrap.open === null) {
    add('warn', 'Wrap desk state is unreadable',
      wrap.error || 'Could not tell whether the desk is open.', `${base}/wrapdesk`);
  }

  // ── services ─────────────────────────────────────────────────────────────
  for (const s of svcs) {
    if (s.status === 'bad') {
      add('action', `${s.name} is reporting a fault`,
        (s.notes || []).join('; ') || `on ${s.host}`, `${base}/services`);
    } else if (s.status === 'unreadable' && s.slug !== 'market') {
      add('warn', `${s.name} could not be read`,
        (s.notes || []).join('; ') || `on ${s.host}`, `${base}/services`);
    }
  }

  // ── user reports ─────────────────────────────────────────────────────────
  const openReports = (reports || []).filter(r => r && !r.done && !r.resolved).length;
  if (openReports > 0) {
    add('info', `${openReports} user report${openReports === 1 ? '' : 's'} unresolved`,
      'Somebody wrote in and has not been answered.', `${base}/user-reports`);
  }

  // ── the hand-written list ────────────────────────────────────────────────
  for (const t of (tasks || []).filter(t => !t.done)) {
    add('info', t.text, `Added ${(t.at || '').slice(0, 10)}`, `${base}/tasks`);
  }

  items.sort((a, b) => SEV[a.sev] - SEV[b.sev]);
  return items;
}

/** Render the panel. `esc` is passed in so this file needs no import from ui. */
export function needsYouCard(items, esc) {
  const colour = s => s === 'action' ? 'var(--red)' : s === 'warn' ? 'var(--yellow)' : 'var(--muted)';
  const label = s => s === 'action' ? 'ACTION' : s === 'warn' ? 'CHECK' : 'TODO';
  const nAction = items.filter(i => i.sev === 'action').length;

  if (!items.length) {
    return `<div class="card"><h2>Needs you</h2>
      <p class="ok">Nothing is waiting on you right now.</p>
      <p class="muted">This line means every source was READ and each said it had nothing —
      not that nothing was checked. A source that cannot be reached appears above as an
      item, never as silence.</p></div>`;
  }

  return `<div class="card" style="border-left:3px solid ${nAction ? 'var(--red)' : 'var(--yellow)'}">
    <h2>Needs you (${items.length}${nAction ? `, ${nAction} needing action` : ''})</h2>
    <table>${items.map(i => `<tr>
      <td style="width:76px;white-space:nowrap;color:${colour(i.sev)};font-weight:700;font-size:11px">
        ${label(i.sev)}</td>
      <td><a href="${esc(i.href)}">${esc(i.title)}</a>
        <div class="muted" style="font-size:12px">${esc(i.detail)}</div></td>
    </tr>`).join('')}</table>
  </div>`;
}
