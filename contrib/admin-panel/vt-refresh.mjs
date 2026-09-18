#!/usr/bin/env node
// Refresh the VirusTotal verdict cache for every published artifact.
//
// Run from a timer, never from a page render: the free tier is 4 requests a
// minute, so this deliberately spaces its calls and would be a two-minute web
// request if it were inline. The panel reads the cache this writes.
//
//   node vt-refresh.mjs            refresh what is stale
//   node vt-refresh.mjs --status   say what is cached, contact nobody
import { scanAll, vtKey, cachedVerdicts } from './virustotal.mjs';
import { upstreamCreds } from './services.mjs';

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
} catch (e) {
  // An unreadable list is not an empty list -- refuse rather than cache nothing
  // and call it done.
  console.error('  could not read pc.am/dl/SHA256SUMS.txt: ' + e.message);
  process.exit(2);
}
console.log(`  ${rows.length} published artifact(s)`);

if (process.argv.includes('--status')) {
  const c = cachedVerdicts(rows);
  console.log(`  cached: ${c.fresh} fresh, ${c.stale} stale, ${c.missing} never fetched`);
  for (const r of rows) {
    const v = c.results[r.sha];
    console.log('   %s  %s', (v ? v.state : 'not cached').padEnd(12), r.file);
  }
  process.exit(0);
}

const key = vtKey(upstreamCreds());
if (!key) {
  console.error('  NO VirusTotal API key configured. Add it to /opt/pcoin-admin/upstream.json\n' +
                '  as {"virustotal": {"apiKey": "..."}} (0600). Refusing to pretend a scan happened.');
  process.exit(2);
}
const out = await scanAll(rows, key);
let clean = 0, flagged = 0, unscanned = 0, unknown = 0;
for (const r of rows) {
  const v = out.results[r.sha];
  if (!v) { unknown++; continue; }
  if (v.state === 'clean') clean++;
  else if (v.state === 'flagged') { flagged++; console.log(`  FLAGGED: ${r.file} ${v.malicious + v.suspicious}/${v.total}`); }
  else if (v.state === 'unscanned') { unscanned++; console.log(`  never scanned: ${r.file}`); }
  else unknown++;
}
console.log(`  clean ${clean} | flagged ${flagged} | never scanned ${unscanned} | unknown ${unknown}`);
