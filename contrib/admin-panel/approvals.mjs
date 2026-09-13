// /approvals - every message that wanted to be public, and what you decided.
//
// The gate itself runs on the host that polls Telegram; this page is the
// readable record of it, AND a second place to decide from.
//
// A NOTE ON THE SECOND PLACE, because it was argued the other way first.
// This page originally had no buttons on purpose: a panel session is a second
// key to the public channel, and a stolen session would hold it. The owner asked
// for panel-side approval anyway - "everything should be under control from the
// admin panel" - which is a reasonable call for the person whose project it is,
// and the risk is answered rather than ignored:
//
//   * a panel decision is recorded as decided_by "admin-panel", never merged
//     with a Telegram press, so the audit trail distinguishes them for ever;
//   * the gate DMs the owner whenever a panel decision is applied, so a decision
//     he did not make surfaces on his phone within a minute;
//   * the panel cannot publish. It can only record an intent that the gate picks
//     up, and the gate still re-checks the content hash before publishing, so a
//     panel session cannot change what gets posted -- only whether the thing the
//     owner already saw goes out.
//
// That is the difference between a second key and a second doorbell.
import { esc, DASH, tbl, card, note, tiles, when, agoEpoch } from './ui.mjs';

const COLOUR = {
  published: 'green', confirmed: 'blue', awaiting: 'yellow', pending: 'yellow',
  cancelled: 'muted', expired: 'muted', failed: 'red',
};

const WHAT = {
  pending: 'queued, not yet shown to you',
  awaiting: 'waiting for a decision',
  confirmed: 'confirmed; publishing on the next tick',
  published: 'live',
  cancelled: 'cancelled. Never published',
  expired: 'nobody decided it in time. It can never be published now',
  failed: 'refused or undeliverable. NOT published',
};

export function approvalsPage(feed, controls) {
  if (!feed || typeof feed !== 'object' || !Object.keys(feed).length) {
    return '<h1>Approvals</h1>' + card('Nothing reported yet',
      '<p class="bad">No host has posted an approval queue. That is not the same as '
      + '"nothing has been queued" - it means this page could not read the gate.</p>'
      + note('The gate runs on the host that polls Telegram and reports after every '
           + 'tick. If this stays empty, check pcoin-approve.timer there.'));
  }

  const hosts = Object.keys(feed);
  const items = [];
  // The gate reports its own allow-list as {key: label}. Merging across hosts is
  // safe because the allow-list is part of the gate's code, not per-host config:
  // two hosts disagreeing about what "channel" means would be a far larger
  // problem than a label.
  const labels = {};
  for (const h of hosts) Object.assign(labels, feed[h].dests || {});
  for (const h of hosts) for (const i of (feed[h].items || [])) items.push({ ...i, _host: h });
  items.sort((a, b) => (b.created || 0) - (a.created || 0));

  // How far the words travel. This is the most important fact on the page: the
  // difference between Confirm putting text in front of strangers and in front
  // of nobody. It must not depend on the reader knowing what a key means.
  const REACH = {
    channel: { colour: 'red', reach: 'PUBLIC' },
    group: { colour: 'red', reach: 'PUBLIC' },
    test: { colour: 'yellow', reach: 'private test channel' },
    selftest: { colour: 'muted', reach: 'only you' },
  };
  const destCell = i => {
    const k = String(i.dest || '');
    const r = REACH[k] || { colour: 'yellow', reach: 'unknown reach' };
    const label = labels[k] || k || '(not reported)';
    return `<b style="color:var(--${r.colour})">${esc(r.reach)}</b>`
      + `<br>${esc(label)}`
      + `<br><span class="muted"><code>${esc(k)}</code></span>`
      + (i.has_photo ? '<br><span class="muted">with a picture</span>' : '');
  };

  // Decisions taken here that the gate has not yet applied. Shown so a click
  // that is still in flight does not look like a click that did nothing.
  const inflight = new Map();
  for (const d of ((controls && controls.decisions) || [])) {
    if (!d.applied) inflight.set(d.id, d.decision);
  }

  const n = st => items.filter(i => i.state === st).length;
  const head = tiles([
    ['Waiting on you', esc(String(n('awaiting') + n('pending'))), 'yellow'],
    ['Published', esc(String(n('published'))), 'green'],
    ['Cancelled', esc(String(n('cancelled')))],
    ['Expired undecided', esc(String(n('expired')))],
    ['Refused / failed', esc(String(n('failed'))), n('failed') ? 'red' : null],
  ]);

  const waiting = items.filter(i => ['pending', 'awaiting', 'confirmed'].includes(i.state));
  const rest = items.filter(i => !['pending', 'awaiting', 'confirmed'].includes(i.state));

  const buttons = i => {
    if (inflight.has(i.id)) {
      return `<p class="muted">${esc(inflight.get(i.id))} from the panel &mdash; `
           + 'waiting for the gate to apply it (up to a minute)</p>';
    }
    if (!['pending', 'awaiting'].includes(i.state)) return '';
    const k = String(i.dest || '');
    const r = REACH[k] || { colour: 'yellow', reach: 'unknown reach' };
    const warn = (k === 'channel' || k === 'group')
      // Spelled out next to the button, not only in a column three cells away.
      // The cost of confirming the wrong thing here is a public post that
      // cannot be unsent -- the Bot API cannot read channel history, so even
      // finding it again afterwards is guesswork.
      ? `<p style="color:var(--red);margin-top:8px"><b>Confirm publishes this PUBLICLY</b>`
        + ` to ${esc(labels[k] || k)}. It cannot be unsent.</p>`
      : `<p class="muted" style="margin-top:8px">Confirm sends this to `
        + `${esc(labels[k] || k)} &mdash; ${esc(r.reach)}.</p>`;
    return warn + `<form method="post" style="display:flex;gap:6px;margin-top:8px">`
      + `<input type="hidden" name="id" value="${esc(i.id)}">`
      + `<button name="action" value="confirm" style="background:var(--green);color:#062;`
      + `border:0;border-radius:4px;padding:6px 12px;cursor:pointer;font-weight:600">`
      + `Confirm &amp; publish</button>`
      + `<button name="action" value="cancel" style="background:var(--panel-2);`
      + `color:var(--text);border:1px solid var(--border);border-radius:4px;`
      + `padding:6px 12px;cursor:pointer">Cancel</button></form>`;
  };

  const row = i => [
    `<code>${esc(i.id || '')}</code>`,
    `<span style="color:var(--${COLOUR[i.state] || 'muted'})">${esc(i.state || '')}</span>`
      + `<br><span class="muted">${esc(WHAT[i.state] || '')}</span>`
      + (i.decided_by ? `<br><span class="muted">by ${esc(String(i.decided_by))}</span>` : ''),
    destCell(i),
    esc(i.source || ''),
    i.created ? agoEpoch(i.created) : DASH,
    `<div style="max-width:44em;white-space:pre-wrap;background:var(--panel-2);`
      + `padding:8px 10px;border-radius:4px">${esc(String(i.text || '').slice(0, 1200))}`
      + (String(i.text || '').length > 1200 ? '\n…' : '') + '</div>'
      + (i.error ? `<p class="bad">${esc(i.error)}</p>` : '')
      + (i.published_message_id ? `<p class="muted">message ${esc(String(i.published_message_id))}</p>` : '')
      + buttons(i),
  ];

  const heads = ['id', 'State', 'Destination', 'From', 'Queued', 'What it says, and your decision'];

  return '<h1>Approvals</h1>'
    + '<p class="muted">Nothing reaches a public Telegram surface without a Confirm. '
    + 'This is the record of every attempt, and a place to decide from.</p>'
    + head
    + '<div class="card" style="border-left:4px solid var(--blue)">'
    + '<h2>How it works</h2>'
    + '<p>Anything that wants to post publicly - the group answer bot, an announcement - '
    + 'hands its message to the gate instead of sending it. You get the <b>exact picture '
    + 'and exact words</b> as a Telegram DM with Confirm and Cancel under them, and you '
    + 'can also decide here. It is published only on a Confirm.</p>'
    + '<p class="muted">The approved bytes are hashed at submission and re-checked '
    + 'immediately before publishing, so a message cannot be edited between the yes and '
    + 'the post - including by this page, which can only say yes or no to something you '
    + 'have already seen. There is no bypass flag, destinations are an allow-list rather '
    + 'than a parameter, an undecided item expires rather than waiting for ever, and a cap '
    + 'stops a malfunctioning process flooding your DM. Every failure path refuses to '
    + 'publish.</p>'
    + '<p class="muted"><b>A decision made here is announced to your Telegram.</b> The '
    + 'panel is a second way in, so anything decided from it tells you on your phone - '
    + 'if you ever get that message without having clicked, someone else has a session.</p>'
    + '</div>'
    + card('Waiting on you', tbl(heads, waiting.map(row),
        'Nothing is waiting. Every queued message has been decided.'))
    + card('Everything else', tbl(heads, rest.map(row), 'No history yet.'))
    + card('Where this comes from',
        tbl(['Host', 'Reported', 'Items'],
          hosts.map(h => [`<code>${esc(h)}</code>`, when(feed[h].at),
                          esc(String((feed[h].items || []).length))]))
        + note('The gate reports after every tick. A host that stops reporting keeps its '
             + 'last known queue on this page rather than appearing to have an empty one.'));
}
