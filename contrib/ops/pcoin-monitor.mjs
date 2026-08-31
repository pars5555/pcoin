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
import { resolve4, resolve6 } from 'node:dns/promises';

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

// basename, for either separator, so a path in a checksum file cannot smuggle
// a different filename past the comparison.
const base = s => s.replace(/^.*[\\\/]/, '');

// `<hash>  <name>` as sha256sum writes it, or `<hash> *<name>` in binary mode,
// which is what the release SHA256SUMS for the Android builds use.
function parseSums(text) {
  const m = new Map();
  for (const line of text.split('\n')) {
    const g = line.trim().match(/^([0-9a-f]{64})\s+\*?(\S+?)(?:\s+#.*)?$/i);
    if (g) m.set(base(g[2]), g[1].toLowerCase());
  }
  return m;
}

let state = { blocks: [], lastHeight: null, lastHeightAt: null };
try { state = { ...state, ...JSON.parse(readFileSync(STATE, 'utf8')) }; } catch {}

// ── 1. seed.pc.am — the only bootstrap point ─────────────────────────────
try {
  // Probe EVERY published address, v4 and v6.
  //
  // This used to report ok when ANY single address answered. With one seed that
  // was the same statement; with four it is not. Three of the four could be
  // refusing connections and this check would still say "ok", so the entire
  // point of having four — bootstrap redundancy — could erode to nothing
  // without a single alert. A partial outage is now its own ALERT, naming the
  // addresses that are down.
  //
  // v6 is included because seed.pc.am publishes an AAAA record: a dual-stack
  // node may reach for that address FIRST, so a broken v6 seed is a real
  // bootstrap failure that a v4-only probe cannot see.
  const v4 = await resolve4(SEED_NAME).catch(() => []);
  const v6 = await resolve6(SEED_NAME).catch(() => []);
  const ips = [...v4, ...v6];
  if (!ips.length) throw new Error('no A or AAAA records for ' + SEED_NAME);
  const reachable = [], dead = [];
  for (const ip of ips) ((await tcpProbe(ip, SEED_PORT)) ? reachable : dead).push(ip);
  if (!reachable.length) {
    alert('seed-bootstrap', `${SEED_NAME} (${ips.join(', ')}) refuses P2P ${SEED_PORT} — no new node can join the network`);
  } else if (dead.length) {
    alert('seed-bootstrap', `${dead.join(', ')} refusing P2P ${SEED_PORT} — ${reachable.length}/${ips.length} still accepting, so bootstrap still works but redundancy is degraded`);
  } else {
    ok('seed-bootstrap', `all ${ips.length} accepting on ${SEED_PORT}: ${reachable.join(', ')}`);
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
//
// EVERY pc.am LINE IS COMPARED AGAINST THE RELEASE IT NAMES, never against
// /releases/latest/. Two distinct failures made that necessary, both seen on
// 2026-08-31:
//
//   COVERAGE. `latest` is whatever shipped most recently and releases are
//   per-component, so the two files overlap only on the filenames that
//   component happens to publish. After the Android-only v1.3.13 the overlap
//   was exactly one name: the Windows and Linux checksums on pc.am were
//   compared against nothing at all, and this check still said "ok". What was
//   actually verified silently tracked whichever component shipped last —
//   the same shape of blind spot as the `shared`-is-empty bug below it.
//
//   FALSE POSITIVES. GitHub resolves `latest` the instant a release exists,
//   while pc.am's checksum file is updated by hand minutes later. That gap is
//   a release in progress, not tampering, and it fired "treat pc.am as
//   compromised" twice in one release before clearing itself. An alarm that
//   cries wolf on every release is an alarm people learn to ignore.
//
// pc.am already writes the tag on every line (`<hash>  <name>    # v1.3.13`),
// so the correct reference was in the data the whole time. Comparing per-tag
// fixes both at once: every line is checked, and a line still naming the old
// release keeps matching that release until pc.am is updated to name the new
// one. CLAUDE.md 4 repealed /releases/latest/download/ for the site links for
// this exact reason; this check had kept it.
try {
  const site = await fetchText('https://pc.am/dl/SHA256SUMS.txt');

  // `<hash>  <name>    # <tag>`. The trailing tag is CAPTURED, not stripped:
  // it is the whole point. Trailing prose after the tag is tolerated so a
  // human note on a line can never make it silently unparseable.
  const rows = [];
  for (const line of site.split('\n')) {
    const g = line.trim().match(/^([0-9a-f]{64})\s+\*?(\S+?)(?:\s+#\s*(\S+).*)?\s*$/i);
    if (g) rows.push({ hash: g[1].toLowerCase(), file: base(g[2]), tag: g[3] || null });
  }
  if (!rows.length) throw new Error('no checksum lines parsed from pc.am');

  const untagged = rows.filter(r => !r.tag).map(r => r.file);
  const tags = [...new Set(rows.filter(r => r.tag).map(r => r.tag))];

  // One fetch per distinct release, not one per line.
  const releases = new Map();
  const unreachable = [];
  await Promise.all(tags.map(async tag => {
    const url = `https://github.com/pars5555/pcoin/releases/download/${encodeURIComponent(tag)}/SHA256SUMS`;
    try { releases.set(tag, parseSums(await fetchText(url))); }
    catch (e) { unreachable.push(`${tag} (${e.message})`); }
  }));

  const bad = [], missing = [], checked = [];
  for (const r of rows) {
    if (!r.tag) continue;
    const rel = releases.get(r.tag);
    if (!rel) continue;                       // already counted in `unreachable`
    if (!rel.has(r.file))              missing.push(`${r.file} @ ${r.tag}`);
    else if (rel.get(r.file) !== r.hash)   bad.push(`${r.file} @ ${r.tag}`);
    else                               checked.push(r.file);
  }

  if (bad.length) {
    alert('download-integrity', `pc.am checksums DISAGREE with GitHub for: ${bad.join(', ')} — treat pc.am as compromised until proven otherwise`);
  } else if (missing.length) {
    // Not a hash mismatch, and not a fetch failure either: pc.am is publishing
    // a checksum for a file the release it names never shipped. Distinct fault,
    // distinct wording, so nobody reads it as tampering or as noise.
    alert('download-integrity', `pc.am lists ${missing.join(', ')} but that release does not publish the file — pc.am is advertising a download GitHub never shipped`);
  } else if (!checked.length) {
    unknown('download-integrity', `nothing could be compared: ${rows.length} line(s), ${untagged.length} untagged, ${unreachable.length} release(s) unreachable${unreachable.length ? ' — ' + unreachable.join(', ') : ''}`);
  } else {
    // Anything NOT compared is named in the result. A partial check that reads
    // as a clean one is precisely how the previous version hid its blind spot,
    // so a caveat downgrades this to `unknown` rather than being appended to an
    // "ok" nobody reads to the end of.
    const detail = `${checked.length}/${rows.length} file(s) match their own release across ${releases.size} tag(s)`;
    const caveats = [];
    if (untagged.length)    caveats.push(`${untagged.length} line(s) carry no tag and cannot be aimed at a release: ${untagged.join(', ')}`);
    if (unreachable.length) caveats.push(`${unreachable.length} release(s) unreachable: ${unreachable.join(', ')}`);
    if (caveats.length) unknown('download-integrity', `${detail}; NOT checked: ${caveats.join('; ')}`);
    else ok('download-integrity', detail);
  }
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
