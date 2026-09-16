// The unified PCoin admin.
//
// WHAT THIS IS FOR. PCoin's own operational surface is spread across four panels
// on two hosts — market.pc.am/admin, explorer.pc.am/admin, pcnearner.pc.am/admin
// and wpcnpay.pc.am/admin — plus control that has no panel at all: the price
// oracle (an admin token, no page), the wrap desk (CLI only), the keeper (systemd
// environment), and the Telegram bot. This gathers the SEEING of all of it into
// one page.
//
// IT IS READ-ONLY ACROSS SERVICES, DELIBERATELY. The existing panels keep their
// own authentication and keep doing the acting. That is not timidity: one panel
// with full control over the market, the wrap desk, the oracle and the rails
// means one stolen session loses all four at once, and two-factor authentication
// protects the login, not the session that follows it. Unify the reading, leave
// the writing distributed. The only things this panel owns outright are its own
// task list and its own release-scan view — neither of which can move money.
//
// PancakeSwap is absent and always will be: it needs a private key, and that key
// belongs in the owner's wallet, not in a web service.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  loadCredential, saveCredential, checkPassword, checkTotp, totpRequired,
  newTotpSecret, totpAt,
  newSession, checkSession, dropSession,
  throttleMs, noteFailure, clearFailures,
} from './auth.mjs';
import { execFileSync } from 'node:child_process';
import { collect, upstreamCreds } from './services.mjs';
import { detailFor } from './detail.mjs';
import { telegramPage } from './telegram.mjs';
import { jobsPage } from './jobs.mjs';
import { aiPage } from './ai.mjs';
import { exchangesPage } from './exchanges.mjs';
import { approvalsPage } from './approvals.mjs';
import { wrapdeskPage, wrapdeskState, CLOSED_FILE } from './wrapdesk.mjs';
import { minersPage, minersData } from './miners.mjs';
import { pricingPage, pricingData } from './pricing.mjs';
import { exchangeSection } from './exchange.mjs';
import { programsPage, programsData, programsAction } from './programs.mjs';
import { reportsPage, loadReports, saveReports } from './reports.mjs';
import { cachedVerdicts, verdictCell, vtKey } from './virustotal.mjs';

const PORT   = Number(process.env.ADMIN_PORT || 8795);
const PREFIX = (process.env.ADMIN_PREFIX || '').replace(/^\/*|\/*$/g, '');
const DATA   = process.env.ADMIN_DATA || '/opt/pcoin-admin/data';

if (!PREFIX) {
  console.error('ADMIN_PREFIX is not set. Refusing to start: without it every route ' +
                'would answer at /, which is exactly what the unguessable path exists to avoid.');
  process.exit(2);
}
mkdirSync(DATA, { recursive: true });

const BASE = '/' + PREFIX;
const HOSTLABEL = 'explorer.pc.am \u00b7 read-only';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ── tasks: the one thing this panel owns ───────────────────────────────────
// Open work has been living in chat replies, which means it is lost the moment a
// session ends. A file the panel reads and writes makes it outlast the session.
// Pending 2FA secrets: in memory only, one per session, never written to disk
// until a code confirms the authenticator holds it.
const pendingTotp = new Map();
// Half-finished logins: password accepted, code still owed. Random, in memory,
// single-use, 5 minutes. Not a session -- it buys one thing, the code prompt.
const pendingLogin = new Map();

// The ingest token. It is NOT the login: it can write exactly two files in the
// panel's own data directory and can read nothing at all. Hosts hold a copy so
// they can report their own scheduled jobs, and the group answer bot holds one
// so it can file what users say. A stolen ingest token lets someone write
// nonsense onto two pages; it cannot reach a service, a wallet or a session.
const INGEST = process.env.ADMIN_INGEST || '/opt/pcoin-admin/ingest.json';
const ingestTokens = () => {
  try { return JSON.parse(readFileSync(INGEST, 'utf8')).tokens || {}; }
  catch { return {}; }
};
// Compared in constant time, and only against tokens of the same length, so the
// comparison itself cannot be used to learn one.
const ingestWho = tok => {
  if (!tok || tok.length < 24) return null;
  const buf = Buffer.from(tok);
  for (const [who, want] of Object.entries(ingestTokens())) {
    const w = Buffer.from(String(want));
    if (w.length === buf.length && timingSafeEqual(w, buf)) return who;
  }
  return null;
};

// Bodies are capped. An ingest route that will read whatever it is sent is a way
// to fill the disk of the host the panel runs on.
const readJson = (req, limit = 512 * 1024) => new Promise((resolve, reject) => {
  let n = 0; const chunks = [];
  req.on('data', c => {
    n += c.length;
    if (n > limit) { reject(new Error('body too large')); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
    catch (e) { reject(e); }
  });
  req.on('error', reject);
});

const JOBS = `${DATA}/jobs.json`;
const CH10 = String.fromCharCode(10);
const AI = `${DATA}/ai.json`;
const EXCH = `${DATA}/exchanges.json`;
const APPR = `${DATA}/approvals.json`;
const CTRL = `${DATA}/controls.json`;
const loadJobsFile = () => { try { return JSON.parse(readFileSync(JOBS, 'utf8')); } catch { return {}; } };
// Unreadable and empty collapse to the same object here ONLY because aiPage
// renders a host that never reported as NOT REPORTING rather than as zero.
// If that ever stops being true, this has to distinguish them.
const loadAiFile = () => { try { return JSON.parse(readFileSync(AI, 'utf8')); } catch { return {}; } };
// Returns null, not {}, when it cannot be read: the exchanges page must show
// an error there rather than an empty history. 'No conversations happened' and
// 'I could not read the record' are very different things to tell someone whose
// only copy of that correspondence is this file.
const loadExchanges = () => { try { return JSON.parse(readFileSync(EXCH, 'utf8')); } catch { return null; } };
const loadApprovals = () => { try { return JSON.parse(readFileSync(APPR, 'utf8')); } catch { return {}; } };
// Controls are INTENTS, not state. `decisions` are approvals recorded here and
// not yet applied by the gate; `agents` is the desired on/off of each AI. The
// gate is the only thing that turns an intent into an effect, and it
// acknowledges what it applied -- so this file can never disagree with reality
// for longer than one tick.
const loadControls = () => { try { return JSON.parse(readFileSync(CTRL, 'utf8')); } catch { return { decisions: [], agents: {} }; } };
const saveControls = c => writeFileSync(CTRL, JSON.stringify(c, null, 2));

const TASKS = `${DATA}/tasks.json`;
const loadTasks = () => { try { return JSON.parse(readFileSync(TASKS, 'utf8')); } catch { return []; } };
const saveTasks = t => writeFileSync(TASKS, JSON.stringify(t, null, 2));

// ── release scans ──────────────────────────────────────────────────────────
// The published checksum list is the source of truth for what we ship. The panel
// fetches it, and links each artifact to its VirusTotal report so a malware claim
// can be checked in one click instead of argued about.
//
// Cached for an hour: these change at release time, not continuously, and a
// dashboard that refetches an external list on every page load is a way to get
// rate-limited at the worst moment.
let scanCache = { at: 0, rows: [] };
async function releaseScans() {
  if (Date.now() - scanCache.at < 3600e3 && scanCache.rows.length) return scanCache.rows;
  const rows = [];
  try {
    const txt = await (await fetch('https://pc.am/dl/SHA256SUMS.txt',
      { signal: AbortSignal.timeout(20000) })).text();
    let tag = '';
    for (const line of txt.split('\n')) {
      const t = line.match(/^#\s*from release\s+(\S+)/);
      if (t) { tag = t[1]; continue; }
      const m = line.match(/^([0-9a-f]{64})\s+(\S+)\s*$/);
      if (m) rows.push({ sha: m[1], file: m[2], tag });
    }
    scanCache = { at: Date.now(), rows };
  } catch (e) {
    // An unreadable list is not an empty list. Keep the last good copy and say so.
    return scanCache.rows.length ? scanCache.rows : [{ error: e.message }];
  }
  return rows;
}

// ── pages ──────────────────────────────────────────────────────────────────
const NAV = [
  ['Overview', [['', '\u{1F4CA} Dashboard']]],
  ['Mining',   [['miners', '⛏️ My miners']]],
  ['Services', [['services', '\u{1F5A7} All services'],
                ['services/market',    '\u2022 market.pc.am', 'sub'],
                ['pricing', '💲 How the PCN price works'],
                ['exchange', '\u{1F3E6} exchange.pc.am'],
                ['services/wpcnpay',   '\u2022 wpcnpay.pc.am', 'sub'],
                ['services/pcnearner', '\u2022 pcnearner.pc.am', 'sub'],
                ['services/explorer',  '\u2022 explorer.pc.am', 'sub'],
                ['releases', '\u{1F4E6} Releases & scans']]],
  ['Operations', [['jobs', '\u{1F553} Scheduled jobs'],
                  ['ai', '\u{1F916} AI activity'],
                  ['exchanges', '\u{1F4B1} Exchange listings'],
                  ['approvals', '\u{2705} Approvals'],
                  ['wrapdesk', '\u{1F512} Wrap desk'],
                  ['telegram', '\u{1F4AC} Telegram']]],
  ['Work',     [['programs', '\u{1F381} Programs'],
                ['tasks', '\u{1F4CB} Tasks'],
                ['user-reports', '\u{1F41E} User reports']]],
  ['Config',   [['security', '\u{1F512} Security (2FA)']]],
];

const shell2 = (page, title, body) => shell(title, body, page);
const shell = (title, body, page = null) => `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>&#9889;</text></svg>">
<title>${esc(title)} — PCoin admin</title><style>
:root{--bg:#0f0f23;--panel:#1e293b;--panel-2:#15233b;--border:#334155;
--text:#e2e8f0;--muted:#94a3b8;--blue:#60a5fa;--green:#22c55e;--yellow:#eab308;
--red:#ef4444;--purple:#a78bfa}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);
font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
a{color:var(--blue)}
.layout{display:flex;min-height:100vh}
.sidebar{width:240px;background:var(--panel);border-right:1px solid var(--border);
padding:20px 0;flex-shrink:0;overflow-y:auto}
.sidebar-logo{padding:0 20px 16px;border-bottom:1px solid var(--border)}
.sidebar-logo h2{color:var(--blue);font-size:16px;margin-bottom:2px}
.sidebar-logo small{color:var(--muted);font-size:11px}
.sidebar nav{padding:16px 0}
.sidebar-section{padding:10px 20px 4px;color:var(--muted);font-size:10px;
text-transform:uppercase;letter-spacing:.8px}
.sidebar a{display:block;padding:8px 20px;color:var(--text);text-decoration:none;
font-size:13px;border-left:3px solid transparent}
.sidebar a:hover{background:rgba(96,165,250,.05)}
.sidebar a.active{background:rgba(96,165,250,.1);border-left-color:var(--blue);color:var(--blue)}
.sidebar a.sub{padding:5px 20px 5px 38px;font-size:12px;color:var(--muted)}
.sidebar a.sub.active{color:var(--blue)}
.main{flex:1;padding:24px 32px;overflow-y:auto;position:relative}
.logout-btn{position:absolute;top:24px;right:32px;font-size:12px;color:var(--muted);
text-decoration:none;border:1px solid var(--border);padding:6px 12px;border-radius:6px}
.logout-btn:hover{color:var(--text);border-color:var(--muted)}
h1{font-size:20px;margin-bottom:18px;font-weight:600}
.card{background:var(--panel);border:1px solid var(--border);border-radius:10px;
padding:20px;margin-bottom:16px}
.card h2{font-size:12px;color:var(--muted);text-transform:uppercase;
letter-spacing:.8px;font-weight:600;margin-bottom:12px}
.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
.stat-box{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:16px}
.stat-box .label{color:var(--muted);font-size:11px;text-transform:uppercase}
.stat-box .value{font-size:24px;font-weight:600;color:var(--blue);margin-top:4px}
table{width:100%;border-collapse:collapse;font-size:13px}
table th,table td{padding:8px 12px;border-bottom:1px solid var(--border);
text-align:left;vertical-align:top}
table th{color:var(--muted);font-weight:500;font-size:11px;text-transform:uppercase}
table tr:hover{background:rgba(255,255,255,.02)}
code{font:12px Menlo,Consolas,monospace;color:var(--purple);word-break:break-all}
input,select,textarea,button{background:#0f172a;border:1px solid var(--border);
color:var(--text);padding:8px 10px;border-radius:6px;font-size:13px;font-family:inherit}
input:focus,select:focus{outline:none;border-color:var(--blue)}
button{background:var(--blue);border-color:var(--blue);color:#0b1220;cursor:pointer;font-weight:600}
button:hover{filter:brightness(1.08)}
button.ghost{background:transparent;color:var(--muted);border-color:var(--border);font-weight:400}
button.ghost:hover{color:var(--text);border-color:var(--muted)}
p{margin-bottom:10px}p:last-child{margin-bottom:0}
.muted{color:var(--muted)}.bad{color:var(--red)}.ok{color:var(--green)}.warn{color:var(--yellow)}
.done td{opacity:.45;text-decoration:line-through}
form.inline{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
form.inline input[type=text]{flex:1;min-width:240px}
@media(max-width:760px){.layout{flex-direction:column}.sidebar{width:100%}
.main{padding:20px 16px}.logout-btn{top:20px;right:16px}}
</style></head><body>
${page === null ? `<div style="padding:24px">${body}</div>` : `<div class="layout">
<div class="sidebar">
  <div class="sidebar-logo"><h2>&#9889; PCoin admin</h2><small>${esc(HOSTLABEL)}</small></div>
  <nav>${NAV.map(([sec, items]) => `<div class="sidebar-section">${esc(sec)}</div>` +
    items.map(([slug, label, cls]) =>
      `<a href="${BASE}/${slug}" class="${cls || ''}${page === slug ? ' active' : ''}">${label}</a>`).join('')
  ).join('')}</nav>
</div>
<div class="main">
  <a href="${BASE}/logout" class="logout-btn">Sign out</a>
  <h1>${esc(title)}</h1>
  ${body}
</div></div>`}
</body></html>`;

const loginPage = (msg = '') => {
  const need2fa = totpRequired(loadCredential());
  return shell('Sign in', `
<div class="card" style="max-width:380px;margin:8vh auto">
  <h2>PCoin admin</h2>
  ${msg ? `<p class="bad">${esc(msg)}</p>` : ''}
  <form method="POST" action="${BASE}/login">
    <p><input name="username" type="text" placeholder="Username" autocomplete="username"
       style="width:100%" autofocus required></p>
    <p><input name="password" type="password" placeholder="Password" autocomplete="current-password"
       style="width:100%" required></p>
    <p><button type="submit" style="width:100%">Sign in</button></p>
  </form>
  ${need2fa ? '' : `<p class="warn" style="margin:12px 0 0;font-size:13px">
    Two-factor is not enabled. Turn it on from Security once you are in.</p>`}
</div>`, null);
};

const codePage = (ticket, msg = '') => shell('Two-factor', `
<div class="card" style="max-width:380px;margin:8vh auto">
  <h2>Two-factor</h2>
  ${msg ? `<p class="bad">${esc(msg)}</p>` : ''}
  <p class="muted">Enter the 6-digit code from your authenticator app.</p>
  <form method="POST" action="${BASE}/login/2fa">
    <input type="hidden" name="ticket" value="${esc(ticket)}">
    <p><input name="code" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6"
       placeholder="6-digit code" autocomplete="one-time-code" style="width:100%" autofocus required></p>
    <p><button type="submit" style="width:100%">Continue</button></p>
  </form>
</div>`, null);

// ── request handling ───────────────────────────────────────────────────────
const readBody = req => new Promise(resolve => {
  let b = ''; req.on('data', c => { b += c; if (b.length > 1e5) req.destroy(); });
  req.on('end', () => resolve(new URLSearchParams(b)));
});

const cookies = req => Object.fromEntries(
  (req.headers.cookie || '').split(/;\s*/).filter(Boolean)
    .map(p => { const i = p.indexOf('='); return [p.slice(0, i), p.slice(i + 1)]; }));

const send = (res, code, body, extra = {}) => {
  res.writeHead(code, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',            // keeps the secret path out of Referer
    'x-frame-options': 'DENY',
    ...extra,
  });
  res.end(body);
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname.replace(/\/+$/, '') || '/';

  // Anything outside the prefix does not exist. Not 403 — 404, so a scanner that
  // stumbles onto the host learns nothing about whether a panel is here at all.
  if (path !== BASE && !path.startsWith(BASE + '/')) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('not found\n');
  }
  const sub = path.slice(BASE.length) || '/';
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
             || req.socket.remoteAddress || 'unknown';

  // ── ingest ───────────────────────────────────────────────────────────────
  // Token-authenticated rather than session-authenticated, and placed before the
  // login routes because a host reporting its own cron table has no session and
  // should never be handed a login page. A bad token answers 404, the same as a
  // route that does not exist: a prober learns nothing about whether it is here.
  if (sub.startsWith('/ingest/') && req.method === 'POST') {
    const kind = sub.slice('/ingest/'.length);
    const who = ingestWho((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    if (!who) {
      noteFailure(ip);
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found\n');
    }
    let payload;
    try { payload = await readJson(req); }
    catch (e) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      return res.end('bad payload: ' + e.message + '\n');
    }
    const ok = (msg) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(msg + '\n'); };

    if (kind === 'approvals') {
      // The gate pushing its whole queue. Same contract as every other feed: a
      // host writes only its own entry.
      const host = String(payload.host || '').trim();
      if (!host) { res.writeHead(400, { 'content-type': 'text/plain' }); return res.end('no host' + String.fromCharCode(10)); }
      const all = loadApprovals();
      all[host] = {
        at: new Date().toISOString(),
        items: Array.isArray(payload.items) ? payload.items.slice(0, 300) : [],
        dests: payload.dests && typeof payload.dests === 'object' ? payload.dests : {},
      };
      writeFileSync(APPR, JSON.stringify(all, null, 2));
      return ok(`stored ${all[host].items.length} approval item(s)`);
    }

    if (kind === 'controls') {
      // The gate FETCHING what the owner decided here, and acknowledging what it
      // applied. Read-then-ack rather than a push, so the panel never needs to
      // reach the gate host and the gate never accepts an inbound connection.
      const c = loadControls();
      if (payload.ack && Array.isArray(payload.ack)) {
        for (const d of (c.decisions || [])) if (payload.ack.includes(d.id)) d.applied = true;
        saveControls(c);
        return ok(`acknowledged ${payload.ack.length}`);
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        decisions: (c.decisions || []).filter(d => !d.applied),
        agents: c.agents || {},
      }));
    }

    if (kind === 'ai') {
      // Same contract as jobs: a host may only write its OWN entry, keyed by
      // the host it names. The descriptive half of that page -- what an agent
      // is FORBIDDEN to do -- is deliberately not accepted here. A host may
      // report what it did; it must not be able to redefine what it is
      // allowed to do by posting a different answer.
      const host = String(payload.host || '').trim();
      if (!host) { res.writeHead(400, { 'content-type': 'text/plain' }); return res.end('no host\n'); }
      const all = loadAiFile();
      all[host] = {
        at: new Date().toISOString(),
        hostname: String(payload.hostname || ''),
        agents: Array.isArray(payload.agents) ? payload.agents.slice(0, 40) : [],
      };
      writeFileSync(AI, JSON.stringify(all, null, 2));
      return ok(`stored ${all[host].agents.length} agent(s)`);
    }

    if (kind === 'jobs') {
      // A host may only write its OWN entry, and the key is the host it named.
      const host = String(payload.host || '').trim();
      if (!host) { res.writeHead(400, { 'content-type': 'text/plain' }); return res.end('no host\n'); }
      const all = loadJobsFile();
      all[host] = {
        at: new Date().toISOString(),
        hostname: String(payload.hostname || ''),
        timers: Array.isArray(payload.timers) ? payload.timers.slice(0, 400) : [],
        cron: Array.isArray(payload.cron) ? payload.cron.slice(0, 400) : [],
        other_count: Number.isFinite(payload.other_count) ? payload.other_count : null,
        skipped_cron_files: Array.isArray(payload.skipped_cron_files)
          ? payload.skipped_cron_files.slice(0, 50) : [],
        // Added after the 2026-09-13 audit found that six of the seven live PCN
        // credit paths were invisible here. A timer list answers "what will run
        // later"; most of what matters on this estate is a daemon that is
        // running NOW, a container a restart policy brings back, or a
        // setInterval inside a Node process.
        services: Array.isArray(payload.services) ? payload.services.slice(0, 200) : [],
        docker: Array.isArray(payload.docker) ? payload.docker.slice(0, 150) : [],
        // null, NOT []. null means this host has never declared its in-process
        // timers; [] means it declared none. The page renders those differently
        // on purpose -- "nothing declared" and "nothing running" are not the
        // same fact, and conflating them is how the six rails went missing.
        inprocess: Array.isArray(payload.inprocess) ? payload.inprocess.slice(0, 80)
                 : (payload.inprocess === null || payload.inprocess === undefined ? null : []),
      };
      writeFileSync(JOBS, JSON.stringify(all, null, 2));
      return ok(`stored ${all[host].timers.length} timers, ${all[host].cron.length} cron`);
    }

    if (kind === 'reports') {
      // Keyed on the report's own id so a retry after a lost response cannot file
      // the same bug twice -- the transport can drop a reply, and this route will
      // be called again when it does.
      const incoming = Array.isArray(payload.reports) ? payload.reports
                     : payload.id ? [payload] : [];
      const rows = loadReports(DATA);
      const have = new Set(rows.map(r => r.id));
      let added = 0;
      for (const r of incoming.slice(0, 100)) {
        const id = String(r.id || '').trim();
        if (!id || have.has(id)) continue;
        rows.push({
          id,
          at: r.at || new Date().toISOString(),
          kind: ['bug', 'todo', 'question', 'feature'].includes(r.kind) ? r.kind : 'question',
          summary: String(r.summary || '').slice(0, 300),
          detail: String(r.detail || '').slice(0, 4000),
          from: String(r.from || '').slice(0, 100),
          link: /^https:\/\/t\.me\//.test(String(r.link || '')) ? r.link : '',
          answered: !!r.answered,
          status: 'open',
          source: who,
        });
        have.add(id);
        added++;
      }
      saveReports(DATA, rows);
      return ok(`filed ${added} new, ${incoming.length - added} already known`);
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('unknown ingest kind\n');
  }

  const sid = cookies(req).pcadm;
  const session = checkSession(sid);

  if (sub === '/login' && req.method === 'POST') {
    const wait = throttleMs(ip);
    if (wait > 0) return send(res, 429, loginPage(`Too many attempts. Wait ${Math.ceil(wait / 1000)}s.`));
    const form = await readBody(req);
    const cred = loadCredential();
    // Both factors are checked before either verdict is returned, and the failure
    // message never says WHICH was wrong — that distinction is free information.
    if (!cred) return send(res, 500, loginPage('No credential is configured. Run setup.mjs on the host.'));

    const wantUser = (cred.username || 'admin').trim().toLowerCase();
    const gotUser = String(form.get('username') || '').trim().toLowerCase();
    const okPw = checkPassword(form.get('password') || '', cred);
    // One message for both fields. Saying which was wrong hands an attacker a free
    // oracle for enumerating usernames.
    if (gotUser !== wantUser || !okPw) {
      noteFailure(ip);
      return send(res, 401, loginPage('Wrong username or password.'));
    }

    // Password proven. If no second factor is enrolled, that is the whole login.
    if (!totpRequired(cred)) {
      clearFailures(ip);
      const id = newSession({ ip });
      return send(res, 303, '', {
        location: BASE + '/',
        'set-cookie': `pcadm=${id}; HttpOnly; Secure; SameSite=Strict; Path=${BASE}; Max-Age=28800`,
      });
    }

    // Otherwise ask for the code as a second step. The ticket is not a session.
    const ticket = randomBytes(24).toString('base64url');
    pendingLogin.set(ticket, { ip, at: Date.now() });
    return send(res, 200, codePage(ticket));
  }

  if (sub === '/login/2fa' && req.method === 'POST') {
    const wait = throttleMs(ip);
    if (wait > 0) return send(res, 429, loginPage(`Too many attempts. Wait ${Math.ceil(wait / 1000)}s.`));
    const form = await readBody(req);
    const ticket = form.get('ticket') || '';
    const p = pendingLogin.get(ticket);
    // Five minutes, and bound to the address that proved the password. An expired
    // or unknown ticket goes back to the start rather than hinting at why.
    if (!p || Date.now() - p.at > 5 * 60000 || p.ip !== ip) {
      pendingLogin.delete(ticket);
      return send(res, 401, loginPage('That sign-in expired. Start again.'));
    }
    const cred = loadCredential();
    if (!checkTotp(form.get('code') || '', cred && cred.totp)) {
      noteFailure(ip);                      // the code step shares the password backoff
      return send(res, 401, codePage(ticket, 'That code was not right.'));
    }
    pendingLogin.delete(ticket);            // single use
    clearFailures(ip);
    const id = newSession({ ip });
    return send(res, 303, '', {
      location: BASE + '/',
      'set-cookie': `pcadm=${id}; HttpOnly; Secure; SameSite=Strict; Path=${BASE}; Max-Age=28800`,
    });
  }

  if (sub === '/logout') {
    dropSession(sid);
    return send(res, 303, '', {
      location: BASE + '/',
      'set-cookie': `pcadm=; HttpOnly; Secure; SameSite=Strict; Path=${BASE}; Max-Age=0`,
    });
  }

  if (!session) return send(res, 200, loginPage());

  // ── authenticated ────────────────────────────────────────────────────────
  if (sub === '/tasks' && req.method === 'POST') {
    const form = await readBody(req);
    const tasks = loadTasks();
    const act = form.get('action');
    if (act === 'add' && (form.get('text') || '').trim()) {
      tasks.push({ id: randomBytes(6).toString('hex'), text: form.get('text').trim(),
                   done: false, at: new Date().toISOString() });
    } else if (act === 'toggle') {
      const t = tasks.find(x => x.id === form.get('id'));
      if (t) t.done = !t.done;
    } else if (act === 'delete') {
      const i = tasks.findIndex(x => x.id === form.get('id'));
      if (i >= 0) tasks.splice(i, 1);
    }
    saveTasks(tasks);
    return send(res, 303, '', { location: BASE + '/tasks' });
  }

  if (sub === '/tasks') {
    const tasks = loadTasks();
    const open = tasks.filter(t => !t.done), done = tasks.filter(t => t.done);
    const row = t => `<tr class="${t.done ? 'done' : ''}">
      <td>${esc(t.text)}</td>
      <td class="muted" style="white-space:nowrap">${esc((t.at || '').slice(0, 10))}</td>
      <td style="white-space:nowrap">
        <form method="POST" style="display:inline"><input type="hidden" name="action" value="toggle">
          <input type="hidden" name="id" value="${esc(t.id)}">
          <button class="ghost" type="submit">${t.done ? 'reopen' : 'done'}</button></form>
        <form method="POST" style="display:inline"><input type="hidden" name="action" value="delete">
          <input type="hidden" name="id" value="${esc(t.id)}">
          <button class="ghost" type="submit">delete</button></form>
      </td></tr>`;
    return send(res, 200, shell2('tasks', 'Tasks', `
      <div class="card"><h2>Open (${open.length})</h2>
        <form class="inline" method="POST"><input type="hidden" name="action" value="add">
          <input type="text" name="text" placeholder="What still needs doing?" required>
          <button type="submit">Add</button></form>
        ${open.length ? `<table>${open.map(row).join('')}</table>`
                      : '<p class="muted">Nothing open.</p>'}
      </div>
      ${done.length ? `<div class="card"><h2>Done (${done.length})</h2>
        <table>${done.map(row).join('')}</table></div>` : ''}`));
  }

  // -- security: enrol or remove the second factor ---------------------------
  if (sub === '/security' && req.method === 'POST') {
    const form = await readBody(req);
    const act = form.get('action');
    const cred = loadCredential();
    if (!cred) return send(res, 500, shell('Security', '<p class="bad">No credential configured.</p>', 'security'));

    if (act === 'enable') {
      const pending = pendingTotp.get(sid);
      if (!pending || Date.now() - pending.at > 15 * 60000) {
        pendingTotp.delete(sid);
        return send(res, 303, '', { location: BASE + '/security?e=expired' });
      }
      // Written ONLY after a code proves the app really holds this secret.
      if (!checkTotp(form.get('code') || '', pending.secret)) {
        return send(res, 303, '', { location: BASE + '/security?e=badcode' });
      }
      try {
        saveCredential({ ...cred, totp: pending.secret, totpEnabled: true,
                         totpSetAt: new Date().toISOString() });
      } catch (e) {
        return send(res, 303, '', { location: BASE + '/security?e=save' });
      }
      pendingTotp.delete(sid);
      return send(res, 303, '', { location: BASE + '/security?ok=on' });
    }

    if (act === 'disable') {
      // Turning it off still needs a working code. Whoever is here already holds a
      // session, so this is a speed bump rather than a wall -- but it stops a
      // borrowed session quietly weakening the account.
      if (totpRequired(cred) && !checkTotp(form.get('code') || '', cred.totp)) {
        return send(res, 303, '', { location: BASE + '/security?e=badcode' });
      }
      try { saveCredential({ ...cred, totpEnabled: false }); }
      catch (e) { return send(res, 303, '', { location: BASE + '/security?e=save' }); }
      return send(res, 303, '', { location: BASE + '/security?ok=off' });
    }
    return send(res, 303, '', { location: BASE + '/security' });
  }

  if (sub === '/security') {
    const cred = loadCredential();
    const on = totpRequired(cred);
    const q = url.searchParams;
    const note =
        q.get('ok') === 'on'  ? '<p class="ok">Two-factor is now ON. Keep the key somewhere offline.</p>'
      : q.get('ok') === 'off' ? '<p class="warn">Two-factor is now OFF. The password is the only thing protecting this panel.</p>'
      : q.get('e') === 'badcode' ? '<p class="bad">That code was not right. Check the phone clock is set automatically, then use the code showing now.</p>'
      : q.get('e') === 'expired' ? '<p class="bad">That setup expired. Reload to start again.</p>'
      : q.get('e') === 'save' ? '<p class="bad">Could not write the credential file. The service may not have permission to write it &mdash; check ReadWritePaths in pcoin-admin.service.</p>' : '';

    let body;
    if (on) {
      body = '<div class="card"><h2>Two-factor: <span class="ok">ON</span></h2>' + note +
        '<p class="muted">Enrolled ' + esc((cred.totpSetAt || '').slice(0, 19).replace('T', ' ') || 'earlier') +
        '. Sign-in asks for your password and a 6-digit code.</p>' +
        '<form method="POST" class="inline" style="margin-top:12px">' +
        '<input type="hidden" name="action" value="disable">' +
        '<input type="text" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" ' +
        'placeholder="current 6-digit code" required>' +
        '<button class="ghost" type="submit">Turn off</button></form>' +
        '<p class="muted" style="margin-top:10px">Lost the phone? On the host: ' +
        '<code>node /opt/pcoin-admin/setup.mjs --rotate-2fa</code></p></div>';
    } else {
      // One pending secret per session, kept across refreshes so reloading does not
      // invalidate the QR somebody is halfway through scanning.
      let pending = pendingTotp.get(sid);
      if (!pending || Date.now() - pending.at > 15 * 60000) {
        pending = { secret: newTotpSecret(), at: Date.now() };
        pendingTotp.set(sid, pending);
      }
      const uri = 'otpauth://totp/' + encodeURIComponent('PCoin admin') +
                  '?secret=' + pending.secret + '&issuer=' + encodeURIComponent('pc.am') +
                  '&digits=6&period=30';
      let svg = '';
      try {
        svg = execFileSync('qrencode', ['-t', 'SVG', '-o', '-', '-m', '1'],
                           { input: uri, maxBuffer: 1 << 20 }).toString()
              .replace(/<\?xml[^>]*\?>/, '').replace(/<!--[\s\S]*?-->/g, '');
      } catch (e) { svg = ''; }
      const grouped = pending.secret.replace(/(.{4})/g, '$1 ').trim();

      body = '<div class="card"><h2>Two-factor: <span class="bad">OFF</span></h2>' + note +
        '<p>Right now your password is the only thing protecting this panel. Scan this with an ' +
        'authenticator app, then enter the code it shows to switch it on.</p>' +
        '<div style="display:flex;gap:24px;flex-wrap:wrap;align-items:flex-start;margin:14px 0">' +
        '<div style="background:#fff;padding:10px;border-radius:8px;width:210px">' +
        (svg || '<p style="color:#a00">QR could not be generated &mdash; use the key.</p>') + '</div>' +
        '<div style="flex:1;min-width:260px">' +
        '<p class="muted" style="margin:0 0 6px">Or type it in by hand:</p>' +
        '<p><code style="font-size:15px;letter-spacing:.06em">' + esc(grouped) + '</code></p>' +
        '<p class="muted">Account <b>PCoin admin</b> &middot; time-based &middot; 6 digits &middot; 30 seconds</p>' +
        '<form method="POST" class="inline" style="margin-top:14px">' +
        '<input type="hidden" name="action" value="enable">' +
        '<input type="text" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" ' +
        'placeholder="code from the app" required autofocus>' +
        '<button type="submit">Turn on</button></form>' +
        '<p class="muted" style="margin-top:10px">It is only switched on once a working code proves ' +
        'your app really has the key &mdash; so this cannot lock you out.</p>' +
        '</div></div>' +
        '<p class="muted">Google Authenticator, Microsoft Authenticator, Aegis, 1Password and Bitwarden ' +
        'all work. Write the key down offline too: it is how you re-enrol if the phone is lost.</p></div>';
    }
    return send(res, 200, shell('Security', body, 'security'));
  }

  if (sub === '/telegram') {
    return send(res, 200, shell2('telegram', 'Telegram', telegramPage()));
  }

  if (sub === '/pricing') {
    return send(res, 200, shell2('pricing', 'How the PCN price works',
                                 pricingPage(await pricingData())));
  }
  if (sub === '/miners') {
    return send(res, 200, shell2('miners', 'Miners', minersPage(await minersData())));
  }

  // exchange.pc.am. This panel holds only the exchange's READ token (upstream.json);
  // every write carries the owner's exchange-admin 2FA code, which the exchange
  // itself checks. See exchange.mjs.
  if (sub === '/exchange' && req.method === 'POST') {
    const form = await readBody(req);
    const cred = loadCredential();
    const section = exchangeSection({ base: BASE, creds: upstreamCreds(), actor: String((cred && cred.username) || 'owner') });
    const r = await section.action(form, url);
    return send(res, 200, shell2('exchange', 'exchange.pc.am', await section.page(r.url, r.flash)));
  }
  if (sub === '/exchange') {
    const section = exchangeSection({ base: BASE, creds: upstreamCreds(), actor: 'owner' });
    return send(res, 200, shell2('exchange', 'exchange.pc.am', await section.page(url)));
  }

  if (sub === '/wrapdesk' && req.method === 'POST') {
    const form = await readBody(req);
    const action = String(form.get('action') || '');
    let flash = '';
    try {
      if (action === 'close') {
        // The reason is written WITH the flag. A switch with no note on it is a
        // switch somebody flips back in six months without knowing what it cost.
        writeFileSync(CLOSED_FILE,
          'Closed from the admin panel at ' + new Date().toISOString() + '.' + CH10 +
          'Delete this file, or press Reopen in the panel, to take requests again.' + CH10);
        flash = 'The wrap desk is now CLOSED. New requests get HTTP 503 with an explanation; '
              + 'wraps already in flight are unaffected and will still be paid.';
      } else if (action === 'open') {
        try { unlinkSync(CLOSED_FILE); } catch { /* already open */ }
        flash = 'The wrap desk is now OPEN and accepting new requests.';
      }
    } catch (e) {
      flash = 'Could not change it: ' + e.message + ' -- nothing was altered.';
    }
    return send(res, 200, shell2('wrapdesk', 'Wrap desk',
      wrapdeskPage(wrapdeskState(), flash)));
  }

  if (sub === '/wrapdesk') {
    return send(res, 200, shell2('wrapdesk', 'Wrap desk',
      wrapdeskPage(wrapdeskState())));
  }

  if (sub === '/programs' && req.method === 'POST') {
    programsAction(await readBody(req));
    res.writeHead(302, { location: 'programs' });
    return res.end();
  }
  if (sub === '/programs') {
    return send(res, 200, shell2('programs', 'Programs', programsPage(programsData())));
  }

  if (sub === '/approvals' && req.method === 'POST') {
    const form = await readBody(req);
    const id = String(form.get('id') || '').slice(0, 40);
    const action = String(form.get('action') || '');
    if (id && (action === 'confirm' || action === 'cancel')) {
      const c = loadControls();
      c.decisions = (c.decisions || []).filter(d => d.id !== id || d.applied);
      c.decisions.push({
        id, decision: action, at: new Date().toISOString(),
        by: 'admin-panel', applied: false,
      });
      // Keep the tail bounded; applied decisions are history the gate already has.
      c.decisions = c.decisions.slice(-200);
      saveControls(c);
    }
    res.writeHead(302, { location: 'approvals' });
    return res.end();
  }

  if (sub === '/approvals') {
    return send(res, 200, shell2('approvals', 'Approvals',
      approvalsPage(loadApprovals(), loadControls())));
  }

  if (sub === '/ai' && req.method === 'POST') {
    const form = await readBody(req);
    const key = String(form.get('agent') || '').slice(0, 40);
    const want = String(form.get('state') || '');
    if (key && (want === 'on' || want === 'off')) {
      const c = loadControls();
      c.agents = c.agents || {};
      // Recorded as a WISH. The page renders it as "requested" until the agent's
      // own report says the change actually took -- an off switch that shows OFF
      // before the thing is off is the worst possible lie for this control.
      c.agents[key] = { enabled: want === 'on', at: new Date().toISOString(), by: 'admin-panel' };
      saveControls(c);
    }
    res.writeHead(302, { location: 'ai' });
    return res.end();
  }

  if (sub === '/exchanges') {
    return send(res, 200, shell2('exchanges', 'Exchange listings',
      exchangesPage(loadExchanges())));
  }

  if (sub === '/ai') {
    return send(res, 200, shell2('ai', 'AI activity',
      aiPage(loadAiFile(), loadJobsFile(), loadControls())));
  }

  if (sub === '/jobs') {
    return send(res, 200, shell2('jobs', 'Scheduled jobs',
      jobsPage(DATA)));
  }

  if (sub === '/user-reports' && req.method === 'POST') {
    const form = await readBody(req);
    const id = form.get('id'), action = form.get('action');
    const rows = loadReports(DATA);
    if (action === 'delete') saveReports(DATA, rows.filter(r => r.id !== id));
    else {
      for (const r of rows) if (r.id === id) r.status = action === 'reopen' ? 'open' : 'done';
      saveReports(DATA, rows);
    }
    return send(res, 303, '', { location: BASE + '/user-reports' });
  }

  if (sub === '/user-reports') {
    return send(res, 200, shell2('user-reports', 'User reports',
      reportsPage(DATA, BASE, url.searchParams.get('all') === '1')));
  }

  if (sub.startsWith('/services/')) {
    const slug = sub.slice('/services/'.length);
    const d = await detailFor(slug, BASE);
    if (!d) return send(res, 404, shell2('services', 'Unknown service',
      `<div class="card"><p class="bad">There is no service by that name.</p>
       <p><a href="${BASE}/services">Back to all services</a></p></div>`));
    return send(res, 200, shell2('services/' + slug, d.name, d.body));
  }

  if (sub === '/services') {
    const svcs = await collect();
    const dot = st => st === 'ok' ? '<span class="ok">&#9679;</span>'
                    : st === 'bad' ? '<span class="bad">&#9679;</span>'
                                   : '<span class="warn">&#9679;</span>';
    return send(res, 200, shell2('services', 'Services', svcs.map(s => `
      <div class="card">
        <h2>${dot(s.status)} <a href="${BASE}/services/${esc(s.slug)}"
          style="text-transform:none;font-size:14px;letter-spacing:0">${esc(s.name)}</a>
          <span class="muted" style="text-transform:none;
          font-weight:400">&nbsp;${esc(s.host)}</span></h2>
        ${(s.notes || []).map(x => `<p class="bad">${esc(x)}</p>`).join('')}
        ${s.rows.length ? `<table>${s.rows.map(r => `<tr><td>${esc(r[0])}</td>
          <td><b>${esc(r[1])}</b></td><td class="muted">${esc(r[2] || '')}</td></tr>`).join('')}</table>` : ''}
        <p style="margin-top:12px"><a href="${BASE}/services/${esc(s.slug)}">Everything about
          ${esc(s.name)} &rarr;</a></p>
      </div>`).join('') + `
      <div class="card"><h2>How this is read</h2>
        <p class="muted">All four now answer in JSON through read-only endpoints, each with its own
        narrowly-scoped token. Every token was tested to open exactly the route it is for and
        nothing else: the ops token cannot reach /fleet or /wrap, the wpcnpay token cannot reach
        /verify or /claims, and the market token cannot reach /admin. Nothing here can write.</p>
        <p class="muted">A service that cannot be read shows as <b>unreadable</b>, never as zero
        and never as healthy. Readings are cached for 60 seconds.</p>
      </div>`));
  }

  if (sub === '/releases') {
    const rows = await releaseScans();
    const err = rows.find(r => r.error);
    // Cache only. A page render must never make rate-limited network calls.
    const vt = err ? { results: {}, fresh: 0, stale: 0, missing: 0 } : cachedVerdicts(rows);
    const vtOn = !!vtKey(upstreamCreds());
    const body = err
      ? `<p class="bad">Could not read the published checksum list: ${esc(err.error)}</p>
         <p class="muted">This is shown as an error rather than an empty table on purpose —
         "no releases" and "could not ask" must never look the same.</p>`
      : `<table><tr><th>Artifact</th><th>Release</th><th>VirusTotal</th><th>SHA-256</th></tr>
         ${rows.map(r => `<tr>
           <td>${esc(r.file)}</td>
           <td class="muted">${esc(r.tag || '—')}</td>
           <td>${verdictCell(vt.results[r.sha])}
               <a href="https://www.virustotal.com/gui/file/${esc(r.sha)}"
                  target="_blank" rel="noopener" style="font-size:11px">open &rarr;</a></td>
           <td><code style="font-size:11px">${esc(r.sha)}</code></td>
         </tr>`).join('')}</table>`;
    return send(res, 200, shell2('releases', 'Releases & scans', `
      <div class="card"><h2>Published artifacts</h2>
        <p class="muted">Read live from
        <a href="https://pc.am/dl/SHA256SUMS.txt" target="_blank" rel="noopener">pc.am/dl/SHA256SUMS.txt</a>,
        cached for an hour. Every row links to its VirusTotal report by hash, so a
        malware claim can be checked against the file we actually publish rather
        than against whatever build someone else scanned.</p>
        ${body}
        ${vtOn
          ? `<p class="muted" style="margin-top:12px">Verdicts are read from the VirusTotal
              API by hash and cached for six hours: ${vt.fresh} fresh, ${vt.stale} stale,
              ${vt.missing} never fetched. <b>Nothing is ever uploaded</b> &mdash; a hash lookup
              tells us what VirusTotal already knows, and a file it has never seen shows as
              <span class="warn">never scanned</span> rather than as clean.
              Refresh with <code>node /opt/pcoin-admin/vt-refresh.mjs</code>.</p>`
          : `<p class="warn" style="margin-top:12px">No VirusTotal API key is configured, so
              these are links only &mdash; the panel cannot tell you a verdict without you
              clicking each one. Add a free key to <code>/opt/pcoin-admin/upstream.json</code>
              as <code>{"virustotal": {"apiKey": "..."}}</code> and the detection ratio
              appears in this table.</p>`}
      </div>
      <div class="card"><h2>Reading a scan</h2>
        <p class="muted">A handful of engines flagging an unsigned mining wallet is
        expected and is not a finding. Read the labels, not the count: a verdict ending
        <code>!ml</code>, or containing <code>MachineLearning</code>,
        <code>Anomalous</code> or <code>confidence_NN%</code>, is a guess rather than an
        identification, and a label beginning <code>Not-a-virus:</code> says so outright.
        What matters is whether any engine names a real malware family, and whether the
        signature-based majors — Kaspersky, ESET, Bitdefender, Sophos, Symantec — are
        clean. The permanent fix is a code-signing certificate.</p>
      </div>`));
  }

  // ── overview ─────────────────────────────────────────────────────────────
  const tasks = loadTasks();
  // Pull the same live reads the Services page uses, so the tiles cannot drift
  // from the detail behind them.
  let svcs = [];
  try { svcs = await collect(); } catch { svcs = []; }
  const byName = Object.fromEntries(svcs.map(x => [x.name, x]));
  const val = (name, label) => {
    const svc = byName[name];
    if (!svc) return null;
    const row = (svc.rows || []).find(r => r[0] === label);
    return row ? row[1] : null;
  };
  const dash = v => (v === null || v === undefined || v === '') ? '&mdash;' : esc(v);
  const bad = svcs.filter(x => x.status === 'bad' || x.status === 'unreadable').length;
  const openTasks = tasks.filter(t => !t.done).length;

  return send(res, 200, shell2('', 'Overview', `
    <div class="stats-grid">
      <div class="stat-box"><div class="label">Services healthy</div>
        <div class="value" style="color:${bad ? 'var(--red)' : 'var(--green)'}">
          ${svcs.length - bad}/${svcs.length || '?'}</div></div>
      <div class="stat-box"><div class="label">Open tasks</div>
        <div class="value">${openTasks}</div></div>
      <div class="stat-box"><div class="label">PCN ask price</div>
        <div class="value">${dash(val('market.pc.am', 'Ask price'))}</div></div>
      <div class="stat-box"><div class="label">Sale gate</div>
        <div class="value">${dash(val('market.pc.am', 'Sale gate'))}</div></div>
      <div class="stat-box"><div class="label">wPCN claims</div>
        <div class="value">${dash(val('wpcnpay.pc.am', 'Claims banked'))}</div></div>
      <div class="stat-box"><div class="label">Chain height</div>
        <div class="value">${dash(val('explorer.pc.am/admin', 'Chain height'))}</div></div>
    </div>

    <div class="card"><h2>Services</h2>
      <table><tr><th>Service</th><th>Host</th><th>State</th></tr>
      ${svcs.map(x => `<tr><td><a href="${BASE}/services">${esc(x.name)}</a></td>
        <td class="muted">${esc(x.host)}</td>
        <td class="${x.status === 'ok' ? 'ok' : x.status === 'bad' ? 'bad' : 'warn'}">
          ${esc((x.status || 'unknown').toUpperCase())}</td></tr>`).join('')
       || '<tr><td colspan="3" class="bad">Could not read any service.</td></tr>'}
      </table>
    </div>

    <div class="card"><h2>What this panel is</h2>
      <p>One place to <b>see</b> PCoin's own operational surface. It is read-only across
      services by design: the four existing panels keep their own authentication and keep
      doing the acting, so a stolen session here cannot move money anywhere.</p>
      <p class="muted">The unguessable path keeps this out of scanner traffic. It is not the
      security &mdash; the password and the second factor are. Treat the URL as convenience,
      not as a secret that protects anything.</p>
      <p class="muted">Control with no panel at all, and therefore new work rather than a
      migration: the price oracle (an admin token, no page), the wrap desk (CLI only), the
      keeper (systemd environment) and the Telegram bot. PancakeSwap is deliberately absent
      &mdash; it needs a private key, which belongs in a wallet and not in a web service.</p>
    </div>`));
});

server.listen(PORT, '127.0.0.1', () =>
  console.log(`pcoin-admin on 127.0.0.1:${PORT} at ${BASE}/  (credential ` +
              `${loadCredential() ? 'present' : 'NOT SET — every login will be refused'})`));
