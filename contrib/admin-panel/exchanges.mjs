// /exchanges - every exchange and tracker conversation, in the words actually used.
//
// WHY IT EXISTS. The owner asked: "nonkyc blocked and i dont see any message
// anymore, i need my chat history, you have all them, i forwarded you, please
// put in admin let me see all messages in admin somewhere". A Telegram block
// takes the conversation with it -- he cannot open the chat, cannot scroll back,
// and there is no export. The only surviving copy of that correspondence is what
// he pasted into the working session, so it is reconstructed here and kept.
//
// THE RULE THIS PAGE IS BUILT AROUND, and it is not decoration. Somewhere in the
// handling of this rejection, an ANALYSIS of why a listing desk might object --
// unresolved wallet bugs, unverified supply distribution, a small network -- got
// written down as though NonKYC had said it. They never did. Re-reading the
// actual messages, the only objection NonKYC ever raised was to being asked for
// a discount, and the block came with no reason at all.
//
// That is exactly the failure this project keeps paying for: an inference
// hardening into a quoted fact, and then decisions being made against it. So the
// page renders quotes and analysis in visibly different boxes, and every quote is
// verbatim. If a line is not in quotation marks, nobody said it.
import { esc, DASH, tbl, card, note, kv, tiles } from './ui.mjs';

const STATE_COLOUR = {
  blocked: 'red', declined: 'red', unanswered: 'yellow',
  dormant: 'muted', 'invited us': 'green', listed: 'green',
};

const CH_COLOUR = {
  'listed': 'green', 'already lists us': 'green',
  'in their verification queue': 'yellow', 'unanswered': 'yellow',
  'not applied': 'yellow', 'rejected': 'red',
};
const chColour = (st) => CH_COLOUR[st] || (String(st).startsWith('running') ? 'green'
  : String(st).startsWith('active') ? 'green' : 'muted');

/** Everywhere PCoin is represented that is NOT an exchange desk: the trackers we
 *  have not applied to, the one subreddit that tolerates us, the server
 *  directories, and the independent pool somebody else runs.
 *
 *  Separate from the venues above because they are a different question with
 *  different answers -- and because mixing a Discord directory into a page built
 *  around verbatim listing-desk quotes would blur the one rule that page keeps. */
function channelsCard(channels) {
  if (!Array.isArray(channels) || !channels.length) return '';
  const byKind = {};
  for (const c of channels) (byKind[c.kind] = byKind[c.kind] || []).push(c);
  const KIND_ORDER = ['tracker', 'community', 'directory', 'profitability site', 'independent operator', 'software'];
  const kinds = [...KIND_ORDER.filter(k => byKind[k]), ...Object.keys(byKind).filter(k => !KIND_ORDER.includes(k))];

  return card('Where else PCoin stands',
    '<p class="muted">Everything that is not an exchange desk. Every status here is copied '
    + 'from a record rather than recalled &mdash; where the truth is &ldquo;nobody '
    + 'replied&rdquo;, it says so.</p>'
    + kinds.map((k) => `<h3 style="margin:18px 0 6px;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)">${esc(k)}</h3>`
      + tbl(['', 'State', 'Where it stands', 'What is next', 'Blocker'],
        byKind[k].map((c) => [
          `<b>${esc(c.name)}</b>`,
          `<span class="${chColour(c.state)}">${esc(c.state)}</span>`,
          esc(c.summary || ''),
          esc(c.next || ''),
          `<span class="muted">${esc(c.blocker || '')}</span>`,
        ]))).join(''));
}

export function exchangesPage(data) {
  if (!data || !Array.isArray(data.venues)) {
    return '<h1>Exchange listings</h1>' + card('No record',
      '<p class="bad">exchanges.json could not be read. That is an error, not an empty ' +
      'history - nothing is shown rather than showing you a page that says there were ' +
      'no conversations.</p>');
  }
  const v = data.venues;
  const counts = s => v.filter(x => x.state === s).length;

  const head = tiles([
    ['Venues tracked', esc(String(v.length))],
    ['Blocked or declined', esc(String(counts('blocked') + counts('declined'))), 'red'],
    ['Waiting on them', esc(String(counts('unanswered'))), 'yellow'],
    ['They approached us', esc(String(counts('invited us'))), 'green'],
    ['Paid listings bought', '0'],
  ]);

  const overview = tbl(
    ['Venue', 'State', 'Fee', 'Where it stands'],
    v.map(x => [
      '<b>' + esc(x.name) + '</b>',
      `<span style="color:var(--${STATE_COLOUR[x.state] || 'muted'})">${esc(x.state)}</span>`,
      esc(x.fee || ''),
      esc(x.summary || ''),
    ]));

  const detail = v.map(x => {
    const msgs = (x.timeline || []).length
      ? '<div style="overflow-x:auto"><table><tr><th>When</th><th>Who</th><th>What was said</th></tr>' +
        x.timeline.map(t => {
          const mine = t.who === 'us';
          const body = t.quote
            // Verbatim. Rendered as a quotation so it can never be mistaken for
            // a paraphrase, and never edited to read better.
            ? `<div style="border-left:3px solid var(--${mine ? 'blue' : 'purple'});` +
              `padding:6px 10px;margin:6px 0;background:var(--panel-2);white-space:pre-wrap">` +
              esc(t.quote) + '</div>'
            : '<p class="muted">No message. ' + esc(t.what) + '</p>';
          return '<tr><td style="white-space:nowrap">' + esc(t.at) + '</td>' +
                 `<td><b style="color:var(--${mine ? 'blue' : 'purple'})">` +
                 (mine ? 'PCoin' : esc(x.name)) + '</b></td>' +
                 '<td>' + (t.quote ? '<span class="muted">' + esc(t.what) + '</span>' + body : body) + '</td></tr>';
        }).join('') + '</table></div>'
      : note('No message-by-message record was kept for this venue.');

    const analysis = (x.inferred || []).length
      ? '<div style="border:1px dashed var(--border);border-radius:6px;padding:10px;margin-top:10px">' +
        '<p><b>Our analysis - nobody at ' + esc(x.name) + ' said any of this</b></p><ul>' +
        x.inferred.map(i => '<li>' + esc(i) + '</li>').join('') + '</ul></div>'
      : '';

    return card(x.name,
      kv([
        ['State', `<span style="color:var(--${STATE_COLOUR[x.state] || 'muted'})">${esc(x.state)}</span>`],
        ['Fee', esc(x.fee || '')],
        ['Contact', esc(x.contact || '')],
      ]) + msgs + analysis +
      (x.next ? '<p><b>Next step:</b> ' + esc(x.next) + '</p>' : ''));
  }).join('');

  return '<h1>Exchange listings</h1>'
    + '<p class="muted">Every exchange and tracker conversation, in the words actually used. '
    + 'Last updated ' + esc(data.updated || 'unknown') + '.</p>'
    + head
    + '<div class="card" style="border-left:4px solid var(--yellow)">'
    + '<h2>Read the quotes, not the summary</h2>'
    + '<p>Quotes on this page are <b>verbatim</b>. Boxes marked <i>our analysis</i> are '
    + 'guesses and are kept separate on purpose.</p>'
    + '<p class="muted">This matters because it has already gone wrong once. A list of '
    + 'plausible reasons a listing desk might reject PCoin - wallet bugs, unverified '
    + 'supply distribution, too little hashrate - was written down and then repeated as '
    + 'though NonKYC had given them as their reasons. Going back to the actual messages: '
    + 'they never said any of it. The only thing NonKYC ever objected to was being asked '
    + 'for a discount, and the block came with no reason at all. Work done against the '
    + 'invented reasons was still worth doing; believing they came from NonKYC was not.</p>'
    + '</div>'
    + card('Every venue', overview)
    + channelsCard(data.channels)
    + detail
    + card('Why this page is the only copy',
        note('A Telegram block removes the conversation from the owner\'s app entirely - '
           + 'no scrollback, no export, no way to reread what was agreed. Everything above '
           + 'was reconstructed from what he pasted into the working session while the chat '
           + 'was still open. There is no other copy anywhere. Anything said to a venue from '
           + 'now on should be pasted in here at the time, not afterwards.'));
}
