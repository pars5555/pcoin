#!/usr/bin/env node
// Submit the published artifacts VirusTotal has never seen, so "never scanned"
// becomes a real verdict.
//
// WHY THIS IS A SEPARATE PROGRAM FROM vt-refresh.mjs. Looking a hash up is
// read-only and safe to run on a timer. UPLOADING is not: it publishes the file
// to every VirusTotal customer who can search by hash, it costs quota, and it
// can only sensibly happen once per artifact. Those belong to different
// programs with different trigger conditions, and folding the upload into the
// refresh timer would mean every new release silently uploaded itself.
//
// THE CHECK THAT MAKES THIS SAFE. Each artifact is downloaded from its GitHub
// release and its SHA-256 is compared against the value published at
// pc.am/dl/SHA256SUMS.txt BEFORE a single byte is uploaded. If they disagree,
// nothing is uploaded and it is reported loudly -- because a mismatch between
// what GitHub serves and what we publish is either a broken release process or
// a tampered artifact, and submitting it to a malware scanner is not the right
// response to either. It also means the thing scanned is provably the thing our
// users download, which is the entire argument for scanning by hash in the
// first place.
//
// Nothing here decides a verdict. Upload returns an analysis id; the verdict
// arrives minutes later and vt-refresh.mjs picks it up on its own timer.
//
//   node vt-submit.mjs --dry     say what would be submitted, contact nobody
//   node vt-submit.mjs           submit everything VirusTotal has never seen
//   node vt-submit.mjs --file X  submit one artifact by filename
import { createHash } from 'crypto';
import { vtKey, cachedVerdicts } from './virustotal.mjs';
import { upstreamCreds } from './services.mjs';

const DRY = process.argv.includes('--dry');
const ONE = (() => { const i = process.argv.indexOf('--file'); return i > 0 ? process.argv[i + 1] : null; })();
const REPO = process.env.PCOIN_REPO || 'pars5555/pcoin';
// Free tier: 4 requests a minute. An upload is one request, but the download
// that precedes it is from GitHub and does not count.
const GAP_MS = 20000;
// VirusTotal takes a direct POST up to 32 MB; above that it hands out a
// one-time upload URL. Every PCoin artifact is well under, but a release that
// grows past the line must not fail silently years from now.
const DIRECT_LIMIT = 32 * 1024 * 1024;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── what is published ──────────────────────────────────────────────────────
// The SAME parser vt-refresh.mjs uses: provenance is a "# from release vX.Y.Z"
// comment ABOVE the checksum line, and it belongs to the next checksum entry
// only. Getting this wrong once already made the Windows miner report the
// Android version as its own.
const rows = [];
let txt;
try {
  txt = await (await fetch('https://pc.am/dl/SHA256SUMS.txt',
    { signal: AbortSignal.timeout(20000) })).text();
} catch (e) {
  console.error('  could not read pc.am/dl/SHA256SUMS.txt: ' + e.message);
  console.error('  An unreadable list is not an empty list. Nothing submitted.');
  process.exit(2);
}
let tag = '';
for (const line of txt.split('\n')) {
  const t = line.match(/^#\s*from release\s+(\S+)/);
  if (t) { tag = t[1]; continue; }
  const m = line.match(/^([0-9a-f]{64})\s+(\S+)\s*$/);
  if (m) rows.push({ sha: m[1], file: m[2], tag });
}
if (!rows.length) { console.error('  the published list named no artifacts'); process.exit(2); }
console.log(`  ${rows.length} published artifact(s), tags: ${[...new Set(rows.map(r => r.tag))].join(', ')}`);

// ── which of them VirusTotal has never seen ────────────────────────────────
const cache = cachedVerdicts(rows);
let todo = rows.filter(r => {
  if (ONE) return r.file === ONE;
  const v = cache.results[r.sha];
  // Only 'unscanned' is submitted. 'unknown' means the LOOKUP failed, which
  // resolves nothing -- uploading on an unreadable answer would upload files
  // VirusTotal already has, every run, for ever.
  return v && v.state === 'unscanned';
});
if (ONE && !todo.length) { console.error(`  no published artifact named ${ONE}`); process.exit(2); }

if (!todo.length) {
  console.log('  nothing to submit: every published artifact is already known to VirusTotal,');
  console.log('  or its verdict could not be read this run (which is not the same thing and');
  console.log('  is deliberately NOT treated as a reason to upload).');
  process.exit(0);
}
console.log(`  ${todo.length} never scanned:`);
for (const r of todo) console.log(`    ${r.file}  (${r.tag})`);

if (DRY) { console.log('  --dry: nothing downloaded, nothing uploaded.'); process.exit(0); }

const key = vtKey(upstreamCreds());
if (!key) {
  console.error('  NO VirusTotal API key in /opt/pcoin-admin/upstream.json. Refusing to pretend.');
  process.exit(2);
}

// ── download, verify, upload ───────────────────────────────────────────────
let ok = 0, mismatched = 0, failed = 0;
for (const [i, r] of todo.entries()) {
  const url = `https://github.com/${REPO}/releases/download/${r.tag}/${r.file}`;
  console.log(`\n  [${i + 1}/${todo.length}] ${r.file}`);
  let buf;
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(180000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    console.error(`    download FAILED: ${e.message}  (${url})`);
    failed++;
    continue;
  }
  const got = createHash('sha256').update(buf).digest('hex');
  console.log(`    ${(buf.length / 1048576).toFixed(2)} MB, sha256 ${got.slice(0, 16)}…`);
  if (got !== r.sha) {
    // Do NOT upload. What GitHub served is not what pc.am publishes, and that is
    // either a broken release process or a tampered artifact. Either way the
    // answer is to look, not to scan it.
    console.error('    HASH MISMATCH -- NOT UPLOADED.');
    console.error(`      published: ${r.sha}`);
    console.error(`      downloaded: ${got}`);
    console.error('      The file our users download does not match the list that is supposed');
    console.error('      to verify it. Investigate before doing anything else.');
    mismatched++;
    continue;
  }

  try {
    let endpoint = 'https://www.virustotal.com/api/v3/files';
    if (buf.length > DIRECT_LIMIT) {
      const u = await fetch('https://www.virustotal.com/api/v3/files/upload_url',
        { headers: { 'x-apikey': key }, signal: AbortSignal.timeout(30000) });
      if (!u.ok) throw new Error(`upload_url HTTP ${u.status}`);
      endpoint = (await u.json()).data;
      console.log('    over 32 MB: using a one-time upload URL');
    }
    const form = new FormData();
    form.append('file', new Blob([buf]), r.file);
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'x-apikey': key },
      body: form,
      signal: AbortSignal.timeout(300000),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    let id = '';
    try { id = JSON.parse(body).data.id; } catch { /* keep going; the upload landed */ }
    console.log(`    submitted. analysis ${id ? id.slice(0, 24) + '…' : '(id not parsed)'}`);
    console.log(`    verdict will appear at https://www.virustotal.com/gui/file/${r.sha}`);
    ok++;
  } catch (e) {
    console.error(`    upload FAILED: ${e.message}`);
    failed++;
  }
  if (i < todo.length - 1) await sleep(GAP_MS);   // free tier: 4 requests a minute
}

console.log(`\n  submitted ${ok} | hash mismatch ${mismatched} | failed ${failed}`);
console.log('  Verdicts are NOT available yet. VirusTotal takes a few minutes; the panel');
console.log('  will show them once vt-refresh.mjs next runs. Until then they correctly read');
console.log('  as unknown rather than as clean.');
process.exit(mismatched ? 3 : failed ? 1 : 0);
