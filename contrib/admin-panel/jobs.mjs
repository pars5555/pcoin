// Everything on this estate that runs on a schedule, from every host.
//
// WHY IT IS PUSHED AND NOT PULLED. The obvious design is for the panel to SSH to
// each host and run `systemctl list-timers`. That would mean giving the panel a
// key to every box in the estate -- turning a read-only dashboard into the one
// machine that can log into everything. The admin host deliberately holds no SSH
// key to any other host today, and that property is worth more than the
// convenience. So each host reports its OWN jobs to one narrow ingest route, and
// the panel only ever renders what it was told.
//
// EXPECTED is the load-bearing part. Without it, a host that stops reporting
// simply vanishes from the page and the page still looks complete -- which is
// exactly how a payment rail went unwatched for weeks on this estate: every
// check that could not find its config did not fail, it disappeared.
// A host in EXPECTED that has not reported is rendered loudly, as its own row.
//
// Only PCoin's own jobs are transported. Two of these hosts are shared
// production carrying other people's work, so the collector sends our jobs and a
// COUNT of everything else -- enough to say "there is more here", without
// putting somebody else's cron table on our dashboard.
import { readFileSync, existsSync } from 'node:fs';
import { esc, card, tbl, note, tiles, DASH, agoIso } from './ui.mjs';

// The estate. A host here that has not reported is a fault, not an absence.
export const EXPECTED = [
  ['178.105.3.51',    'explorer, ops, wpcnpay, wrapdesk, keeper, admin'],
  ['178.105.178.27',  'market, pcnearner, pool, price primary, group-watch'],
  ['35.239.156.16',   'seed, pc.am, announcements'],
  ['152.53.171.190',  'seed, explorer3, miner'],
  ['167.233.113.189', 'seed, third price origin'],
  ['116.203.221.42',  'three payment rails, deposit-watch, bootstrap-watch'],
  // Added 2026-09-13. BOTH of these ran live PCN payment rails while being
  // absent from this list, which meant they did not render as NOT REPORTING --
  // they did not render at all, and the page looked complete without them.
  // That is the precise failure this list exists to prevent, and it had it.
  ['202.61.252.202', '3dmodel.oonak.ai rail + its own deposit watcher'],
  ['167.233.206.186', 'portrait2video rail, its own pcoind, and dev workers'],
];

// Twice the collector's half-hourly cadence, so one missed run is not an alarm
// but two in a row is.
const STALE_SECONDS = 3900;

export function loadJobs(dataDir) {
  const f = `${dataDir}/jobs.json`;
  try {
    if (!existsSync(f)) return {};
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch { return {}; }
}

const age = iso => {
  const t = Date.parse(iso || '');
  return isFinite(t) ? (Date.now() - t) / 1000 : Infinity;
};

// systemd's Result for a service that has never run is "success", which would
// render a job that has never fired as healthy. An empty last-run is its own
// state and says so.
const resultCell = (r, last) => !last ? '<span class="muted">never run</span>'
  : !r ? DASH
  : r === 'success' ? '<span class="ok">success</span>'
  : `<span class="bad">${esc(r)}</span>`;

export function jobsPage(dataDir) {
  const data = loadJobs(dataDir);
  const reported = Object.keys(data);

  const rows = EXPECTED.map(([host, what]) => {
    const d = data[host];
    const a = d ? age(d.at) : Infinity;
    return { host, what, d, a, stale: a > STALE_SECONDS };
  });
  // A host that reported but is NOT in EXPECTED is worth seeing too: it means the
  // list above is out of date, which is the failure this page exists to prevent.
  for (const h of reported) {
    if (!EXPECTED.some(([e]) => e === h)) {
      const d = data[h];
      rows.push({ host: h, what: 'not in the expected list', d, a: age(d.at),
                  stale: age(d.at) > STALE_SECONDS, unexpected: true });
    }
  }

  const jobs = rows.flatMap(r => [
    ...((r.d && r.d.timers) || []).map(t => ({ ...t, host: r.host, kind: 'timer' })),
    ...((r.d && r.d.cron) || []).map(t => ({ ...t, host: r.host, kind: 'cron' })),
  ]);
  // A timer that is disabled, masked or inactive is PRESENT but not SCHEDULED.
  // Counting it as a running job is how a unit stood down this morning still
  // appeared here as live work -- exactly the wrong answer for a page being
  // used to decide what to switch off.
  const standDown = j => j.kind === 'timer' &&
    (j.enabled === 'disabled' || j.enabled === 'masked' || j.active === 'inactive');
  const live = jobs.filter(j => !standDown(j));
  const down = jobs.filter(standDown);
  // null means the host has not reported the figure yet; 0 means it measured
  // zero. Summing them together would turn "unknown" into a number.
  const counted = rows.filter(r => r.d && Number.isFinite(r.d.other_count));
  const otherCount = counted.reduce((a, r) => a + r.d.other_count, 0);
  const otherKnown = counted.length === rows.filter(r => r.d).length;
  // Files cron is REFUSING to read. These are the dangerous ones: they look like
  // scheduled work and are not. Reported loudly and counted separately.
  const ignored = rows.flatMap(r => ((r.d && r.d.skipped_cron_files) || [])
    .map(x => ({ ...x, host: r.host })));
  const bad = live.filter(j => j.last && j.result && j.result !== 'success');
  const never = live.filter(j => j.kind === 'timer' && !j.last);
  const missing = rows.filter(r => !r.d);
  const stale = rows.filter(r => r.d && r.stale);

  const head = tiles([
    ['Scheduled jobs', String(live.length), live.length ? null : 'yellow'],
    ['Stood down', String(down.length), down.length ? 'yellow' : null],
    ['Hosts reporting', `${rows.filter(r => r.d && !r.stale).length}` +
      `<span class="muted" style="font-size:14px">/${EXPECTED.length}</span>`,
      (missing.length || stale.length) ? 'red' : 'green'],
    ['Failing', String(bad.length), bad.length ? 'red' : 'green'],
    ['Never run', String(never.length), never.length ? 'yellow' : null],
    ['Ignored by cron', String(ignored.length), ignored.length ? 'red' : null],
    ['Other jobs, not sent', otherKnown ? String(otherCount) : DASH],
  ]);

  const hostCard = card('Hosts',
    tbl(['Host', 'What runs there', 'Reported', 'Timers', 'Cron', 'Other', 'State'],
      rows.map(r => [
        `<code>${esc(r.host)}</code>` + (r.unexpected ? ' <span class="warn">unexpected</span>' : ''),
        `<span class="muted">${esc(r.what)}</span>`,
        r.d ? `<span class="muted">${agoIso(r.d.at)}</span>` : DASH,
        r.d ? String((r.d.timers || []).length) : DASH,
        r.d ? String((r.d.cron || []).length) : DASH,
        r.d && Number.isFinite(r.d.other_count)
          ? `<span class="muted">${r.d.other_count}</span>` : DASH,
        !r.d ? '<span class="bad">NOT REPORTING</span>'
          : r.stale ? '<span class="bad">STALE</span>' : '<span class="ok">ok</span>'])) +
    ((missing.length || stale.length)
      ? `<p class="bad" style="margin-top:12px">${missing.length} host(s) have never reported and
         ${stale.length} have gone quiet. A host that is not reporting is not a host with no
         jobs &mdash; nothing on this page can speak for it.</p>`
      : note('Every expected host has reported inside the last hour.')));

  const ignoredCard = ignored.length
    ? card('Files cron refuses to read',
        tbl(['Host', 'File', 'Active lines', 'Why'],
          ignored.map(x => [
            `<code>${esc(x.host)}</code>`,
            `<code>${esc(x.file)}</code>` + (x.pcoin ? ' <span class="warn">PCoin</span>' : ''),
            String(x.lines),
            `<span class="bad">${esc(x.why)}</span>`])) +
        note('Debian cron accepts only letters, digits, underscores and hyphens in an ' +
             '<code>/etc/cron.d</code> filename, and skips anything else <b>silently</b> &mdash; ' +
             'it logs no complaint. These files therefore contain what looks like scheduled ' +
             'work and have never run. This panel listed one of them as a live job until ' +
             '2026-09-13. A job that quietly does not run while the dashboard shows green is ' +
             'the most expensive failure this estate has.'))
    : '';

  const failCard = (bad.length || never.length)
    ? card('Needs a look',
        tbl(['Host', 'Job', 'Last run', 'Result'],
          bad.concat(never).map(j => [
            `<code>${esc(j.host)}</code>`,
            `<code>${esc(j.unit || j.program)}</code>`,
            j.last ? `<span class="muted">${agoIso(j.last)}</span>` : DASH,
            resultCell(j.result, j.last)])) +
        note('A timer that has never run is listed here too. It is not an error, but it is not ' +
             'evidence of anything working either, and the two get confused.'))
    : '';

  const byHost = {};
  for (const j of jobs) (byHost[j.host] = byHost[j.host] || []).push(j);

  const jobCards = Object.entries(byHost).map(([host, js]) => card(host,
    tbl(['Job', 'Kind', 'Schedule', 'State', 'Last run', 'Next', 'Result', 'What it does'],
      js.slice().sort((a, b) =>
        String(a.unit || a.program).localeCompare(String(b.unit || b.program)))
        .map(j => [
          `<code>${esc(j.unit || j.program || '?')}</code>`,
          `<span class="muted">${esc(j.kind)}</span>`,
          `<code>${esc(j.schedule || '?')}</code>`,
          j.kind === 'cron' ? '<span class="ok">cron</span>'
            : standDown(j) ? `<span class="bad">${esc(j.enabled || '?')}/${esc(j.active || '?')}</span>`
            : `<span class="ok">${esc(j.enabled || 'on')}</span>`,
          j.last ? `<span class="muted">${agoIso(j.last)}</span>` : DASH,
          j.next ? `<span class="muted">${agoIso(j.next)}</span>` : DASH,
          resultCell(j.result, j.last),
          `<span class="muted">${esc(j.description || j.args || '')}</span>`])))).join('');

  // ---- everything that is not a timer or a cron line ---------------------
  // Kept in their own sections, not merged: a timer that stops firing leaves
  // nothing running, a service that dies stays dead until something restarts
  // it, and a container with restart=unless-stopped comes BACK by itself --
  // which is exactly why a Docker restart policy counts as a scheduler.
  const svcRows = [];
  const dkrRows = [];
  // `data`, not `byHost`: byHost holds flattened job ROWS, so j.services was
  // always undefined and both tables rendered empty while the collector was
  // sending 206 services and 113 containers. An empty table that should be
  // full is the same lie this page exists to stop.
  for (const [host, j] of Object.entries(data)) {
    for (const v of (j.services || [])) {
      if (!v.pcoin_related) continue;          // other people's daemons stay theirs
      svcRows.push([
        `<code>${esc(host)}</code>`,
        `<b>${esc(v.unit || '')}</b>`,
        `<span class="muted">${esc(v.description || '')}</span>`,
        `<code>${esc(v.runs || '')}</code>`,
        esc(v.restart || ''),
      ]);
    }
    for (const v of (j.docker || [])) {
      if (!v.pcoin_related) continue;
      dkrRows.push([
        `<code>${esc(host)}</code>`,
        `<b>${esc(v.name || '')}</b>`,
        `<span class="muted">${esc(v.image || '')}</span>`,
        esc(v.status || ''),
        v.restart && v.restart !== 'no'
          ? `<b>${esc(v.restart)}</b>`
          : `<span class="muted">${esc(v.restart || 'no')}</span>`,
      ]);
    }
  }

  const svcCounts = Object.values(data).reduce((a, j) => a + (j.services || []).length, 0);
  const dkrCounts = Object.values(data).reduce((a, j) => a + (j.docker || []).length, 0);

  const runningCard = card(
    `Long-running services (${svcRows.length} ours, of ${svcCounts} running)`,
    tbl(['Host', 'Unit', 'What it is', 'Command', 'Restart'], svcRows,
        'No host has reported a running service yet.') +
    note('A timer list answers "what will run later". It does not answer "what is running ' +
         'now", and almost everything that matters here is the second kind: every pcoind, ' +
         'the pool, the indexers, ElectrumX, the DNS seed, the market and the price oracle. ' +
         'None of them appeared on this page until 2026-09-13.'));

  const dockerCard = dkrRows.length ? card(
    `Containers (${dkrRows.length} ours, of ${dkrCounts})`,
    tbl(['Host', 'Name', 'Image', 'Status', 'Restart policy'], dkrRows) +
    note('A restart policy IS a scheduler. <code>unless-stopped</code> brings a container ' +
         'back after a crash or a reboot with nothing in cron or systemd naming it, and two ' +
         'PCN rails live exactly that way.')) : '';

  const undeclared = Object.entries(data)
    .filter(([, j]) => j.inprocess === null || j.inprocess === undefined)
    .map(([h]) => h);
  const inproc = [];
  for (const [host, j] of Object.entries(data))
    for (const t of (j.inprocess || []))
      inproc.push([`<code>${esc(host)}</code>`, `<b>${esc(t.owner || '')}</b>`,
                   esc(t.interval || ''), esc(t.what || ''),
                   `<span class="muted">${esc(t.evidence || '')}</span>`,
                   t.verified ? esc(t.verified) : `<span class="bad">never verified</span>`]);

  const inprocCard = card('Work scheduled inside a running process',
    tbl(['Host', 'Owner', 'Every', 'What it does', 'Evidence', 'Checked'], inproc,
        'Nothing declared yet.') +
    (undeclared.length
      ? `<p class="bad">${esc(String(undeclared.length))} host(s) have never declared any: ` +
        `${undeclared.map(h => '<code>' + esc(h) + '</code>').join(', ')}. That is NOT the same ` +
        `as having none.</p>`
      : '') +
    note('A setInterval inside a Node process cannot be discovered from outside it, so these ' +
         'are DECLARED in /etc/pcoin/inprocess.json rather than measured &mdash; a written ' +
         'record, like the Telegram directory. They matter more than anything else on this ' +
         'page: webai and aicontrol both credit real money from a 60-second setInterval that ' +
         'appears in no systemctl, no crontab and no docker inspect.'));

  return head + hostCard + ignoredCard + failCard + runningCard + dockerCard + inprocCard +
    (jobs.length ? jobCards : card('Jobs',
      '<p class="muted">Nothing has been reported yet. The collector runs every 30 minutes on ' +
      'each host; give it one cycle after install.</p>')) +
    card('How this is collected', `
      <p class="muted">Each host runs <code>pcoin-jobs-report</code> on a 30-minute timer and
      POSTs its own inventory here. The panel holds no SSH key to any host, and adding one to
      build this page would have made the dashboard the single machine that can log into
      everything.</p>
      <p class="muted">The collector reads all three places cron actually lives &mdash; the
      per-user spools, <code>/etc/cron.d</code> and <code>/etc/crontab</code> itself &mdash;
      plus the <code>run-parts</code> directories and every systemd timer. Reading only one of
      them is how an audit of "every cron job" on this estate came out wrong before.</p>
      <p class="muted">Command lines are <b>not</b> transported whole. A cron line on a shared
      box is a secrets file &mdash; <code>/etc/cron.d/checker_pc_am</code> carries an API key
      inside the URL it curls &mdash; so an argument survives only if it looks like a plain path
      or word, URLs lose their query strings, and everything else becomes
      <code>&lt;arg&gt;</code>. That is an allow-list: a pattern that tries to spot secrets will
      miss one, and here it already has.</p>
      <p class="muted">A host is marked stale after ${Math.round(STALE_SECONDS / 60)} minutes,
      which is two missed runs rather than one.</p>`);
}
