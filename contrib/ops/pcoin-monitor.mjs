#!/usr/bin/env node
// PCoin network monitor — the thing whose absence has been the oldest open item.
//
// Checks, in order of how much damage the failure does:
//   1. seed.pc.am reachable on P2P 9444        — nobody new can join without it
//   2. local node answers RPC                  — is our own node alive
//   3. chain advancing                         — "container up, chain stalled"
//   4. peers > 0                               — connected to anything at all
//   5. no deep reorg                           — 6-confirmation deposits assume this
//   6. pc.am checksums match GitHub            — download-page tamper check
//
// DOCTRINE (the one this codebase is built on): a check that could not run
// resolves NOTHING. It is reported as `unknown` and never as `ok`, and never as
// a failure either. A fetch that times out must not page you at 3am claiming the
// download page was tampered with.
//
// Exit 0 = all checks ok or unknown. Exit 1 = at least one real ALERT.
//
// Alerts go to Telegram if /etc/pcoin-monitor.conf defines TG_TOKEN and TG_CHAT.
// That file is the ONLY place a token lives; this script carries none.
// Alerts are private ops traffic — never the public @PCoinPCN channel.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { connect } from 'node:net';
import { resolve4 } from 'node:dns/promises';

const CLI       = '/opt/pcoin/bin/bitcoin-cli';
const DATADIR   = '/var/lib/pcoin';
const STATE     = '/var/lib/pcoin-monitor/state.json';
const LOG       = '/var/log/pcoin-monitor.log';
const CONF      = '/etc/pcoin-monitor.conf';
const SEED_NAME = 'seed.pc.am';
const SEED_PORT = 9444;
const STALL_MIN = 90;    // 9x the 600s target; a real stall, not bad luck
const REORG_ALERT_DEPTH = 3;
const KEEP_BLOCKS = 40;

const results = [];
const add = (level, name, detail) => results.push({ level, name, detail });
const ok      = (n, d) => add('ok', n, d);
const alert   = (n, d) => add('ALERT', n, d);
const unknown = (n, d) => add('unknown', n, d);

const cfg = {};
if (existsSync(CONF)) {
  for (const line of readFileSync(CONF, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m) cfg[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

function cli(...args) {
  return JSON.parse(execFileSync(CLI, [`-datadir=${DATADIR}`, ...args],
    { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] }).trim());
}
function cliRaw(...args) {
  return execFileSync(CLI, [`-datadir=${DATADIR}`, ...args],
    { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

const tcpProbe = (host, port, ms = 8000) => new Promise(res => {
  const s = connect({ host, port });
  const done = v => { try { s.destroy(); } catch {} res(v); };
  s.setTimeout(ms);
  s.on('connect', () => done(true));
  s.on('timeout', () => done(false));
  s.on('error',   () => done(false));
});

async function fetchText(url, ms = 15000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { signal: c.signal, redirect: 'follow' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally { clearTimeout(t); }
}

let state = { blocks: [], lastHeight: null, lastHeightAt: null };
try { state = { ...state, ...JSON.parse(readFileSync(STATE, 'utf8')) }; } catch {}

// ── 1. seed.pc.am — the only bootstrap point ─────────────────────────────
try {
  const ips = await resolve4(SEED_NAME);
  const reachable = [];
  for (const ip of ips) if (await tcpProbe(ip, SEED_PORT)) reachable.push(ip);
  if (!reachable.length) {
    alert('seed-bootstrap', `${SEED_NAME} (${ips.join(', ')}) refuses P2P ${SEED_PORT} — no new node can join the network`);
  } else {
    ok('seed-bootstrap', `${reachable.join(', ')}:${SEED_PORT} accepting`);
  }
} catch (e) {
  // DNS failure here is genuinely bad, but it may also be our resolver.
  unknown('seed-bootstrap', `could not resolve/probe ${SEED_NAME}: ${e.message}`);
}

// ── 2-5. local node ───────────────────────────────────────────────────────
let info = null;
try { info = cli('getblockchaininfo'); ok('node-rpc', `responding, chain=${info.chain}`); }
catch (e) { alert('node-rpc', `local node not answering RPC: ${e.message.split('\n')[0]}`); }

if (info) {
  const h = info.blocks, now = Date.now();

  if (state.lastHeight === null) {
    ok('chain-advancing', `first run, height ${h}`);
    state.lastHeight = h; state.lastHeightAt = now;
  } else if (h > state.lastHeight) {
    ok('chain-advancing', `height ${state.lastHeight} -> ${h}`);
    state.lastHeight = h; state.lastHeightAt = now;
  } else {
    const mins = Math.round((now - (state.lastHeightAt ?? now)) / 60000);
    if (mins >= STALL_MIN) alert('chain-advancing', `height stuck at ${h} for ${mins} min (target spacing is 10 min) — node up but chain stalled`);
    else ok('chain-advancing', `height ${h}, ${mins} min since last block`);
  }

  try {
    const peers = cli('getconnectioncount');
    if (peers > 0) ok('peers', `${peers} connected`);
    else alert('peers', 'zero peers — this node is isolated from the network');
  } catch (e) { unknown('peers', e.message.split('\n')[0]); }

  // Reorg: re-check hashes we recorded earlier. A hash that is no longer at its
  // height means the chain reorganised past it.
  try {
    let depth = 0;
    for (const b of state.blocks) {
      let cur = null;
      try { cur = cliRaw('getblockhash', String(b.height)); } catch { continue; }
      if (cur !== b.hash) depth = Math.max(depth, h - b.height + 1);
    }
    if (depth >= REORG_ALERT_DEPTH) {
      alert('reorg', `reorg ${depth} blocks deep — deposits credited at 6 confirmations may be affected; check pcn_deposits across all four services`);
    } else if (depth > 0) {
      ok('reorg', `${depth}-block reorg (below the ${REORG_ALERT_DEPTH} alert threshold; routine on this chain)`);
    } else {
      ok('reorg', 'none since last run');
    }
    const hash = cliRaw('getblockhash', String(h));
    state.blocks = [...state.blocks.filter(b => b.height !== h), { height: h, hash }]
      .sort((a, b) => a.height - b.height).slice(-KEEP_BLOCKS);
  } catch (e) { unknown('reorg', e.message.split('\n')[0]); }
}

// ── 6. download-page integrity ────────────────────────────────────────────
// pc.am shares a host with ~215 unrelated vhosts on end-of-life PHP. If that box
// is compromised, install.sh AND the checksums it is verified against can be
// rewritten together. GitHub is the independent second channel — so compare.
try {
  const [site, gh] = await Promise.all([
    fetchText('https://pc.am/dl/SHA256SUMS.txt'),
    fetchText('https://github.com/pars5555/pcoin/releases/latest/download/SHA256SUMS'),
  ]);
  const parse = t => {
    const m = new Map();
    for (const line of t.split('\n')) {
      // The trailing `# v1.3.0` on pc.am's lines is why this check reported
      // "unknown" 178 times out of 178 and never once compared anything.
      // GitHub writes `<hash>  <name>`; pc.am appends the release tag so a
      // reader can see which version each line belongs to. Anchoring the
      // filename to end-of-line matched every GitHub line and no pc.am line,
      // so `shared` was always empty and the comparison silently became a
      // no-op. A monitor stuck on "cannot tell" forever is indistinguishable
      // from one that is working -- the exact collapse this file guards
      // against everywhere else.
      const g = line.trim().match(/^([0-9a-f]{64})\s+\*?(\S+?)(?:\s+#.*)?$/i);
      if (g) m.set(g[2].replace(/^.*[\\/]/, ''), g[1].toLowerCase());
    }
    return m;
  };
  const a = parse(site), b = parse(gh);
  const shared = [...a.keys()].filter(k => b.has(k));
  const bad = shared.filter(k => a.get(k) !== b.get(k));

  if (!shared.length) unknown('download-integrity', 'no overlapping filenames between pc.am and GitHub — cannot compare');
  else if (bad.length) alert('download-integrity', `pc.am checksums DISAGREE with GitHub for: ${bad.join(', ')} — treat pc.am as compromised until proven otherwise`);
  else ok('download-integrity', `${shared.length} file(s) match GitHub`);
} catch (e) {
  // Could not fetch != tampered. This is exactly the collapse the doctrine forbids.
  unknown('download-integrity', `could not compare: ${e.message}`);
}

// ── report ────────────────────────────────────────────────────────────────
try { mkdirSync('/var/lib/pcoin-monitor', { recursive: true }); } catch {}
try { writeFileSync(STATE, JSON.stringify(state)); } catch {}

const alerts   = results.filter(r => r.level === 'ALERT');
const unknowns = results.filter(r => r.level === 'unknown');
const stamp    = new Date().toISOString();
const line     = `${stamp} ${alerts.length ? 'ALERT' : 'ok'} ` +
  results.map(r => `${r.name}=${r.level}`).join(' ');
try { appendFileSync(LOG, line + '\n'); } catch {}

if (process.argv.includes('--verbose') || process.argv.includes('-v')) {
  for (const r of results) console.log(`${r.level.padEnd(7)} ${r.name.padEnd(20)} ${r.detail}`);
}

if (alerts.length && cfg.TG_TOKEN && cfg.TG_CHAT) {
  const text = `PCoin monitor — ${alerts.length} alert(s)\n\n` +
    alerts.map(a => `• ${a.name}: ${a.detail}`).join('\n') +
    (unknowns.length ? `\n\nunknown (not failures): ${unknowns.map(u => u.name).join(', ')}` : '');
  try {
    await fetch(`https://api.telegram.org/bot${cfg.TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.TG_CHAT, text, disable_web_page_preview: true }),
    });
  } catch (e) { try { appendFileSync(LOG, `${stamp} alert-delivery-failed ${e.message}\n`); } catch {} }
}

process.exit(alerts.length ? 1 : 0);
