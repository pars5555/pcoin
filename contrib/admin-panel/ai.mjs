// /ai — what the automatic AI in this estate is actually doing.
//
// THE QUESTION THIS PAGE EXISTS TO ANSWER, asked 2026-09-13: "is the admin
// automatic ai working for monitoring everything like you?"
//
// The honest answer is NO, and the page says so at the top rather than burying
// it. Every monitor in this estate is deterministic shell or Python on a systemd
// timer -- pcoin-deposit-watch, pcoin-seed-watch, pcoin-fork-watch,
// pcoin-payment-report, pcoin-solvency-watch and the rest. None of them calls a
// model. That is a design choice and worth defending: a check that asks a model
// "does this look wrong" cannot be reasoned about, cannot be proven to FIRE
// against known-bad input, and can answer differently twice on the same input.
// The 2026-08-30 outage -- six rails refusing every deposit for three and a half
// days behind a holding check that was arithmetically unable to fire -- was
// found by making a check provable, not by making it clever.
//
// So this page inventories the AI that DOES run by itself, which is a different
// and smaller set: one bot that answers questions in the PCoin group, and two
// products that sell model access for PCN. For each it shows the model, what it
// is permitted to do, what it may never do, and live counters.
//
// Live counters arrive through /ingest/ai, same shape as /ingest/jobs: each host
// writes only its own entry. A host that has never reported renders as NOT
// REPORTING -- never as zero. "Nothing happened" and "I could not look" must not
// share a pixel.
import { esc, DASH, tbl, tiles, card, note, kv, when, agoIso, agoEpoch } from './ui.mjs';

// ── the registry ───────────────────────────────────────────────────────────
// Descriptive facts live here because they are DECISIONS, not measurements: a
// host cannot report what it is forbidden to do, only what it did. Anything a
// host can measure comes from the feed and is never duplicated here.
const REGISTRY = [
  {
    key: 'group-answer',
    name: 'PCoin group answer bot',
    what: 'Answers questions asked in the public PCoin Chat group.',
    host: '178.105.178.27',
    unit: 'pcoin-group-answer.timer',
    gateway: 'OonaCode (Anthropic-compatible)',
    reads: 'a spool written by pcoin-group-watch',
    may: [
      'post one reply per question into @PCoinPCNChat',
      'file a bug or a to-do into /user-reports',
      'say that it does not know',
    ],
    mayNot: [
      'state a live figure from memory - rate, supply, height, balance',
      'ask for or accept a recovery phrase, under any framing',
      'give financial advice, or predict a price',
      'promise anything that has not shipped',
      'print an IP, a server path, a server command, or anything credential-shaped',
    ],
    guard: 'Every draft passes an output filter before it can be posted. A draft '
         + 'that trips it is HELD and filed to /user-reports - never posted, and '
         + 'never silently dropped.',
    why: 'It never calls Telegram getUpdates. getUpdates is exclusive - two '
       + 'consumers each see half a conversation - so pcoin-group-watch is the '
       + 'only poller in the estate and this bot reads what that wrote.',
  },
  {
    key: 'pcnaibot',
    name: '@PcoinAiBot',
    what: 'A product, not a monitor: a Telegram bot that sells paid model access '
        + 'and takes payment in PCN. It is the seventh PCN rail.',
    host: '178.105.3.51',
    unit: 'pcnaibot.service, plus pcnaibot-watch.timer and pcnaibot-heartbeat.timer',
    gateway: 'OonaCode',
    reads: 'its own users, in its own Telegram conversation',
    may: ['answer its own paying users on whatever they ask about'],
    mayNot: [
      'speak for PCoin, or post in the PCoin group',
      'read or write anything in the PCoin admin',
    ],
    guard: 'Out of PCoin scope by the owner’s own instruction - "PcoinAiBot is '
         + 'separate ai bot, not related to pcoin itself". It is listed here '
         + 'because it runs automatically on a PCoin host and takes PCN, so a '
         + 'page called "every AI running by itself" that omitted it would be wrong.',
    why: 'Its watch and heartbeat timers are monitored like any other rail.',
  },
  {
    key: 'webai',
    name: 'webai.pc.am',
    what: 'A product: an in-browser AI assistant that takes PCN. Sixth PCN rail.',
    host: '35.239.156.16, containers webai and webai-sandbox',
    unit: 'docker - not a timer; it answers requests as they arrive',
    gateway: 'runs the Claude agent stack inside its container',
    reads: 'its own users, in the browser',
    may: ['answer its own users'],
    mayNot: ['speak for PCoin', 'touch the PCoin admin, or any PCoin wallet'],
    guard: 'No model is named anywhere in its configuration, so this page does '
         + 'not name one. A guessed model would render exactly like a measured one.',
    why: 'Its deposit rail is watched from its own host.',
  },
];

// ── the page ───────────────────────────────────────────────────────────────
export function aiPage(feed, jobsFile, controls) {
  // feed: { "<host>": { at, hostname, agents: [ {key, model, fallback, ...counters} ] } }
  feed = feed || {};
  const hosts = Object.keys(feed);
  const byKey = new Map();
  for (const h of hosts) {
    for (const a of (feed[h].agents || [])) byKey.set(a.key, { ...a, host: h, at: feed[h].at });
  }

  // How many monitors are NOT AI. Counted from the jobs feed rather than typed,
  // because a number typed into a page is a number that rots.
  let monitorCount = null, monitorHosts = 0;
  try {
    const j = jobsFile || {};
    let n = 0;
    for (const h of Object.keys(j)) {
      const timers = (j[h].timers || []).filter(t =>
        /watch|report|heartbeat|solvency|concentration|fork|seed|disk|prune/i.test(t.unit || ''));
      if (timers.length) monitorHosts++;
      n += timers.length;
    }
    monitorCount = n;
  } catch { monitorCount = null; }

  const countLine = monitorCount !== null
    ? 'There are <b>' + esc(String(monitorCount)) + '</b> such checks across <b>'
      + esc(String(monitorHosts)) + '</b> hosts right now'
    : 'The count is unavailable because the jobs feed could not be read, which is '
      + 'shown as unknown rather than as zero';

  const banner = '<div class="card" style="border-left:4px solid var(--green)">'
    + '<h2>No AI monitors this estate</h2>'
    + '<p>Every check that watches the chain, the rails, the pool, the wrap desk '
    + 'and the disks is <b>deterministic shell or Python on a systemd timer</b>. '
    + 'None of them calls a model. ' + countLine + ', and '
    + '<a href="jobs">Scheduled jobs</a> lists every one.</p>'
    + '<p class="muted">That is deliberate, not a gap. A check that asks a model '
    + '"does this look wrong" cannot be proven to fire against known-bad input, '
    + 'and can answer differently twice on the same input. The worst outage this '
    + 'project has had - six payment rails silently refusing every deposit for '
    + 'three and a half days - was hidden behind a check that was arithmetically '
    + 'incapable of firing, and it was fixed by making checks provable rather '
    + 'than clever. The AI below talks to people. None of it decides whether '
    + 'anything is healthy.</p></div>';

  const rows = REGISTRY.map(r => {
    const live = byKey.get(r.key);
    return [
      '<b>' + esc(r.name) + '</b><br><span class="muted">' + esc(r.what) + '</span>',
      '<code>' + esc(r.host) + '</code>',
      live
        ? '<code>' + esc(live.model || '') + '</code>'
          + (live.fallback ? '<br><span class="muted">falls back to <code>'
              + esc(live.fallback) + '</code></span>' : '')
        : '<span class="muted">not reported</span>',
      live ? agoEpoch(live.last_run) : '<span class="bad">NOT REPORTING</span>',
      live && typeof live.answered === 'number'
        ? esc(String(live.answered)) + ' posted / ' + esc(String(live.held ?? 0)) + ' held'
        : DASH,
    ];
  });

  const wanted = (controls && controls.agents) || {};

  const cards = REGISTRY.map(r => {
    const live = byKey.get(r.key) || null;
    const counters = live ? tiles([
      ['Last run', live.last_run ? agoEpoch(live.last_run) : DASH],
      ['Answers posted', typeof live.answered === 'number' ? esc(String(live.answered)) : DASH, 'green'],
      ['Held, not posted', typeof live.held === 'number' ? esc(String(live.held)) : DASH, 'yellow'],
      ['Messages seen', typeof live.handled === 'number' ? esc(String(live.handled)) : DASH],
      ['Posting', live.live === undefined ? DASH
        : (live.live ? '<span class="ok">live</span>' : '<span class="muted">shadow</span>')],
    ]) : '<p class="bad">This agent is not reporting, so none of its counters are '
       + 'shown. An agent that cannot be read is not an agent that did nothing.</p>';

    // ---- the switch -----------------------------------------------------
    // `disabled` is the agent REPORTING its own flag file. `want` is what the
    // panel asked for. Those are different facts and are never merged: a switch
    // that shows OFF while the thing still runs is a switch that lies.
    const reported = live && typeof live.disabled === 'boolean' ? !live.disabled : null;
    const want = wanted[r.key] ? !!wanted[r.key].enabled : null;
    const disagree = reported !== null && want !== null && reported !== want;

    let control = '';
    if (r.key === 'group-answer') {
      // Three states, and the third one is not a mistake: an agent that is not
      // reporting has an UNKNOWN state, which must never be drawn as either
      // running or stopped. That is the same rule the rest of this panel keeps --
      // "I could not look" and "it is off" are different facts.
      const pill = (txt, colour) =>
        `<span style="display:inline-block;padding:4px 12px;border-radius:999px;`
        + `font-weight:700;font-size:12px;letter-spacing:.5px;`
        + `background:var(--${colour});color:#0b1020">${esc(txt)}</span>`;

      let statusPill, button, explain;
      if (reported === null) {
        statusPill = pill('UNKNOWN', 'yellow');
        button = '';
        explain = 'This agent is not reporting, so its real state cannot be read. '
          + 'No switch is offered rather than one that might do the opposite of what it says.';
      } else if (disagree) {
        statusPill = pill(reported ? 'RUNNING' : 'STOPPED', reported ? 'green' : 'red');
        button = '';
        explain = `You asked for it to be turned ${want ? 'ON' : 'OFF'} and it still reports `
          + `itself as ${reported ? 'RUNNING' : 'STOPPED'}. The change is applied by the gate `
          + `on its own timer; if this lasts more than a minute, the switch has NOT taken `
          + `effect and something is wrong on that host.`;
      } else {
        statusPill = pill(reported ? 'RUNNING' : 'STOPPED', reported ? 'green' : 'red');
        button = '<form method="post" style="display:inline">'
          + `<input type="hidden" name="agent" value="${esc(r.key)}">`
          + `<input type="hidden" name="state" value="${reported ? 'off' : 'on'}">`
          + `<button style="background:${reported ? 'var(--red)' : 'var(--green)'};`
          + `color:#0b1020;border:0;border-radius:999px;padding:8px 20px;cursor:pointer;`
          + `font-weight:700">${reported ? 'Turn OFF' : 'Turn ON'}</button></form>`;
        explain = reported
          ? 'It reads the group and drafts answers. Nothing it writes is published until you '
            + 'approve it.'
          : 'It is stopped: it reads nothing, calls no model and answers nobody.';
      }

      control = '<div style="border:1px solid var(--border);border-radius:6px;padding:14px;'
        + 'margin:0 0 14px;background:var(--panel-2)">'
        + '<div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">'
        + button + statusPill + '</div>'
        + '<p class="muted" style="margin-top:10px">' + explain + '</p>'
        + '<p class="muted">Off is a file on the agent\'s host, checked before it reads its '
        + 'config, opens the spool or contacts any model, so a stopped agent cannot even '
        + 'reach an API key. It survives a reboot. Takes a few seconds to apply.</p></div>';
    }

    // ---- what it actually did ------------------------------------------
    const acts = (live && Array.isArray(live.actions)) ? live.actions.slice().reverse() : null;
    const actionBlock = acts === null
      ? note('This agent reports no action log. That is not the same as having done '
           + 'nothing &mdash; it means the log could not be read.')
      : acts.length === 0
        ? note('No actions recorded yet.')
        : tbl(['When', 'What it did', 'Who asked', 'They said', 'What it drafted', 'Model'],
            acts.slice(0, 60).map(a => [
              a.at ? agoEpoch(a.at) : DASH,
              a.action === 'queued-for-approval'
                ? '<span class="ok">drafted an answer and queued it for you</span>'
                : a.action === 'held'
                  ? '<span style="color:var(--yellow)">HELD &mdash; not queued</span>'
                    + (a.reason ? '<br><span class="muted">' + esc(a.reason) + '</span>' : '')
                  : esc(String(a.action || '')),
              esc(String(a.who || '')),
              '<div style="max-width:22em;white-space:pre-wrap">' + esc(String(a.asked || '')) + '</div>',
              '<div style="max-width:26em;white-space:pre-wrap">' + esc(String(a.answer || '')) + '</div>',
              esc(String(a.model || '')) + (a.confidence ? '<br><span class="muted">'
                + esc(String(a.confidence)) + ' confidence</span>' : ''),
            ]));

    // ---- the prompt ------------------------------------------------------
    const promptBlock = (live && live.prompt)
      ? '<details style="margin-top:10px"><summary style="cursor:pointer;color:var(--blue)">'
        + `Show the full prompt this agent works from (${esc(String(live.prompt.length))} `
        + 'characters' + (live.prompt_at ? ', last changed ' + when(live.prompt_at) : '')
        + ')</summary>'
        + '<pre style="white-space:pre-wrap;background:var(--panel-2);padding:12px;'
        + 'border-radius:4px;margin-top:8px;max-height:34em;overflow:auto;font-size:12px">'
        + esc(live.prompt) + '</pre></details>'
      : note('This agent does not report a prompt.');

    return card(r.name,
      control +
      counters +
      kv([
        ['What it is', esc(r.what)],
        ['Host', '<code>' + esc(r.host) + '</code>'],
        ['Runs as', '<code>' + esc(r.unit) + '</code>'],
        ['Model gateway', esc(r.gateway)],
        ['Input', esc(r.reads)],
        live && live.model
          ? ['Model in use', '<code>' + esc(live.model) + '</code>'
             + (live.fallback ? ' <span class="muted">then <code>' + esc(live.fallback)
                 + '</code> if that fails</span>' : '')]
          : null,
        live && live.allowlist ? ['Models it may offer', '<code>' + esc(live.allowlist) + '</code>'] : null,
        live && live.config_at ? ['Config last changed', when(live.config_at)] : null,
      ]) +
      '<p><b>It may:</b></p><ul>' + r.may.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>' +
      '<p><b>It may never:</b></p><ul>' + r.mayNot.map(x => '<li class="bad">' + esc(x) + '</li>').join('') + '</ul>' +
      note(esc(r.guard)) + note(esc(r.why)) +
      '<h3 style="margin-top:16px">The prompt it works from</h3>' + promptBlock +
      '<h3 style="margin-top:16px">What it actually did</h3>' + actionBlock);
  }).join('');

  const feedTable = hosts.length ? tbl(
    ['Host', 'Reported', 'Agents'],
    hosts.sort().map(h => [
      '<code>' + esc(h) + '</code>',
      when(feed[h].at) + ' <span class="muted">(' + agoIso(feed[h].at) + ')</span>',
      esc((feed[h].agents || []).map(a => a.key).join(', ') || 'none'),
    ]))
    : '<p class="bad">No host has ever posted to /ingest/ai, so everything above '
      + 'is the written registry only - what these agents are ALLOWED to do - '
      + 'with no live counters behind it.</p>';

  return '<h1>AI activity</h1>'
    + '<p class="muted">What runs by itself and talks to people, and what does not.</p>'
    + banner
    + card('Every AI that runs automatically',
        tbl(['Agent', 'Host', 'Model', 'Last run', 'Answers'], rows))
    + cards
    + card('Where these numbers come from', feedTable +
        note('Each host posts only its own entry, with its own token, exactly like '
           + 'the scheduled-jobs feed. A host that stops reporting shows as NOT '
           + 'REPORTING rather than dropping off the page, because a missing agent '
           + 'and a quiet agent are different facts.'));
}
