// What users told us, filed as work.
//
// A bug report arrives in the group chat at 3am, gets one reply, and is gone by
// morning. This is the queue it lands in instead: the answer bot files every
// report it sees here, with the exact words the person used and a link back to
// the message, and nothing leaves the queue until a human closes it.
//
// THE ORIGINAL TEXT IS KEPT VERBATIM. The bot's one-line summary is a
// convenience, not the record -- a model's paraphrase of a bug is a paraphrase,
// and the detail it drops is usually the detail that reproduces the fault.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { esc, card, tbl, note, tiles, DASH, agoIso, when } from './ui.mjs';

export const reportsFile = dataDir => `${dataDir}/reports.json`;

export function loadReports(dataDir) {
  try {
    const f = reportsFile(dataDir);
    if (!existsSync(f)) return [];
    const d = JSON.parse(readFileSync(f, 'utf8'));
    return Array.isArray(d) ? d : [];
  } catch { return []; }
}

/** Which reports have since been ANSWERED, derived from the approval log.
 *
 *  A report is filed once, by the group bot, and never updated -- so `answered`
 *  is whatever it was at the moment the question arrived, which is always
 *  false. 41 of the first 66 had been answered in the group and every one of
 *  them still read "not answered", so the overview asked the owner to deal with
 *  work that was finished.
 *
 *  The approval log already knows: every public answer goes through the gate
 *  and records the message it replies to. So this is DERIVED at render time
 *  rather than stored -- nothing to write, nothing to drift, and it is right
 *  again the moment an answer is published.
 */
export function answeredReplies(approvals) {
  const out = new Set();
  for (const blob of Object.values(approvals || {})) {
    for (const it of (blob && blob.items) || []) {
      if (it && it.state === 'published' && it.reply_to) out.add(String(it.reply_to));
    }
  }
  return out;
}

/** Report id "tg-347" refers to group message 347. */
export const reportMessageId = (r) => String((r && r.id) || '').replace(/^tg-/, '');

export const reportAnswered = (r, answered) =>
  Boolean(r && (r.answered === true || r.answered === 'True'
    || (answered && answered.has(reportMessageId(r)))));

export function saveReports(dataDir, rows) {
  writeFileSync(reportsFile(dataDir), JSON.stringify(rows, null, 2));
}

const KIND = {
  bug:      '<span class="bad">bug</span>',
  todo:     '<span class="warn">todo</span>',
  question: '<span class="muted">question</span>',
  feature:  '<span class="ok">feature</span>',
};

export function reportsPage(dataDir, BASE, showDone, answered = new Set()) {
  const all = loadReports(dataDir);
  const open = all.filter(r => r.status !== 'done');
  const rows = showDone ? all : open;

  const count = k => open.filter(r => r.kind === k).length;
  const waiting = open.filter(r => !reportAnswered(r, answered)).length;

  return tiles([
    ['Needs an answer', String(waiting), waiting ? 'yellow' : 'green'],
    ['Open', String(open.length)],
    ['Bugs', String(count('bug')), count('bug') ? 'red' : 'green'],
    ['Todos', String(count('todo'))],
    ['Questions', String(count('question'))],
    ['Closed', String(all.length - open.length)],
  ]) +

  card(showDone ? `All reports (${all.length})` : `Open reports (${open.length})`,
    tbl(['', 'What', 'Said by', 'When', ''],
      rows.slice().sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
        .map(r => [
          KIND[r.kind] || `<span class="muted">${esc(r.kind || '?')}</span>`,
          `<div${r.status === 'done' ? ' style="opacity:.5;text-decoration:line-through"' : ''}>` +
          `<b>${esc(r.summary || '(no summary)')}</b>` +
          (r.detail ? `<div class="muted" style="margin-top:4px;white-space:pre-wrap">${esc(r.detail)}</div>` : '') +
          (reportAnswered(r, answered)
            ? `<div class="ok" style="margin-top:4px;font-size:12px">answered in the group</div>`
            : `<div class="warn" style="margin-top:4px;font-size:12px">not answered</div>`) +
          '</div>',
          `<span class="muted">${esc(r.from || 'unknown')}</span>` +
          (r.link ? `<br><a href="${esc(r.link)}" target="_blank" rel="noopener"
                     style="font-size:12px">open message</a>` : ''),
          `<span class="muted">${agoIso(r.at)}</span>`,
          `<form method="POST" action="${BASE}/user-reports" class="inline">
             <input type="hidden" name="id" value="${esc(r.id)}">
             <button class="ghost" name="action" value="${r.status === 'done' ? 'reopen' : 'done'}"
               type="submit">${r.status === 'done' ? 'reopen' : 'done'}</button>
             <button class="ghost" name="action" value="delete" type="submit">delete</button>
           </form>`]),
      showDone ? 'Nothing has been reported yet.'
               : 'Nothing open. Everything users have reported is closed.') +
    `<p style="margin-top:14px"><a href="${BASE}/user-reports${showDone ? '' : '?all=1'}">` +
    `${showDone ? 'Show only open' : 'Show closed too'}</a></p>`) +

  card('Where these come from', `
    <p class="muted">The group answer bot files one of these every time somebody in
    <a href="https://t.me/PCoinPCNChat" target="_blank" rel="noopener">@PCoinPCNChat</a> reports
    something broken or asks for something that does not exist. It files the report whether or
    not it managed to answer, so a question it could not handle still reaches you.</p>
    <p class="muted">The person's own words are kept verbatim under the summary. A model's
    paraphrase of a bug is a paraphrase, and the detail it drops is usually the detail that
    reproduces the fault &mdash; so read the quote, not the summary, before deciding anything.</p>
    <p class="muted">Closing one here does not tell the person anything. If the fix is worth
    saying out loud, say it in the group.</p>`);
}
