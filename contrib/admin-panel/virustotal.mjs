// VirusTotal verdicts for every published PCoin artifact.
//
// WHY IT QUERIES BY HASH AND NEVER UPLOADS. Submitting a file to VirusTotal
// makes it available to VT's paying customers. Our release binaries are public
// anyway so that would be harmless for them -- but the same code path would
// happily upload an unreleased build, and a habit that is safe today is a leak
// the first time somebody points it at a private artifact. Looking a SHA-256 up
// is enough: if a binary has been scanned, we get the verdict; if it has not,
// "not scanned yet" is a true and useful answer.
//
// THREE OUTCOMES, NOT TWO. A hash VT has never seen (HTTP 404) is NOT clean and
// is NOT infected -- it is UNSCANNED, and it renders as its own state. Folding
// it into "0 detections" would put a green tick next to a file nobody has ever
// examined, which is worse than showing nothing.
//
// The free API tier allows 4 requests/minute and 500/day. There are about a
// dozen artifacts, so results are cached for six hours on disk: that is well
// inside the quota even if every page load missed, and a verdict does not change
// minute to minute.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const CACHE = process.env.ADMIN_VT_CACHE || '/opt/pcoin-admin/data/vt-cache.json';
const TTL_MS = 6 * 3600 * 1000;
const API = 'https://www.virustotal.com/api/v3/files/';

const loadCache = () => {
  try { return existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {}; }
  catch { return {}; }
};
const saveCache = c => { try { writeFileSync(CACHE, JSON.stringify(c, null, 2)); } catch { /* cache only */ } };

export function vtKey(creds) {
  return (creds && creds.virustotal && creds.virustotal.apiKey) || process.env.VT_API_KEY || '';
}

/**
 * Look up one SHA-256. Returns one of:
 *   {state:'clean'|'flagged', malicious, suspicious, total, at, permalink}
 *   {state:'unscanned'}                      -- VT has never seen this file
 *   {state:'unknown', why}                   -- we could not ask
 * It never returns a number it did not receive.
 */
async function lookup(sha, key) {
  try {
    const r = await fetch(API + sha, {
      headers: { 'x-apikey': key },
      signal: AbortSignal.timeout(20000),
    });
    if (r.status === 404) return { state: 'unscanned' };
    if (r.status === 401 || r.status === 403) return { state: 'unknown', why: 'the API key was rejected' };
    if (r.status === 429) return { state: 'unknown', why: 'rate limited by VirusTotal' };
    if (!r.ok) return { state: 'unknown', why: 'HTTP ' + r.status };
    const j = await r.json();
    const s = (j.data && j.data.attributes && j.data.attributes.last_analysis_stats) || null;
    if (!s) return { state: 'unknown', why: 'VirusTotal answered without analysis stats' };
    const malicious = Number(s.malicious) || 0;
    const suspicious = Number(s.suspicious) || 0;
    const total = ['harmless', 'malicious', 'suspicious', 'undetected', 'timeout']
      .reduce((a, k) => a + (Number(s[k]) || 0), 0);
    const at = (j.data.attributes.last_analysis_date || 0) * 1000;
    return {
      state: (malicious + suspicious) > 0 ? 'flagged' : 'clean',
      malicious, suspicious, total,
      at: at ? new Date(at).toISOString() : '',
      names: (j.data.attributes.names || []).slice(0, 3),
    };
  } catch (e) {
    // Report the TYPE, not the exception: a fetch error can carry the request
    // URL, and a URL can carry a key.
    return { state: 'unknown', why: 'could not reach VirusTotal (' + (e.name || 'error') + ')' };
  }
}

/**
 * Verdicts for a list of {sha, file} rows. Cached on disk; only cache entries
 * that are actual VERDICTS, never an 'unknown' -- caching a failure would turn a
 * transient outage into six hours of stale doubt.
 */
export async function scanAll(rows, key) {
  if (!key) return { configured: false, results: {} };
  const cache = loadCache();
  const now = Date.now();
  const results = {};
  let fetched = 0;

  for (const r of rows) {
    if (!r.sha) continue;
    const hit = cache[r.sha];
    if (hit && now - hit.at_ms < TTL_MS) { results[r.sha] = hit.v; continue; }
    // The free tier is 4 requests a minute. Space them, and stop early rather
    // than get the key rate-limited: a partial answer with the rest marked
    // unknown is honest, a burst that gets us throttled is not.
    if (fetched >= 8) { results[r.sha] = { state: 'unknown', why: 'not fetched this pass (rate budget)' }; continue; }
    const v = await lookup(r.sha, key);
    fetched++;
    results[r.sha] = v;
    if (v.state === 'clean' || v.state === 'flagged' || v.state === 'unscanned') {
      cache[r.sha] = { at_ms: now, v };
    }
    if (fetched < rows.length) await new Promise(s => setTimeout(s, 16000));
  }
  saveCache(cache);
  return { configured: true, results };
}

/**
 * What is already on disk, WITHOUT contacting VirusTotal. The page uses this and
 * only this: a page render must never make eight rate-limited network calls with
 * sixteen-second gaps, which is a two-minute request that times out and looks
 * like an outage. A timer refreshes the cache; the page just reads it.
 */
export function cachedVerdicts(rows) {
  const cache = loadCache();
  const now = Date.now();
  const results = {};
  let fresh = 0, stale = 0, missing = 0;
  for (const r of rows) {
    if (!r.sha) continue;
    const hit = cache[r.sha];
    if (!hit) { results[r.sha] = null; missing++; continue; }
    results[r.sha] = hit.v;
    if (now - hit.at_ms < TTL_MS) fresh++; else stale++;
  }
  return { results, fresh, stale, missing };
}

export function verdictCell(v) {
  if (!v) return '<span class="muted">&mdash;</span>';
  if (v.state === 'clean') {
    return `<span class="ok">0 / ${v.total}</span>` +
      (v.at ? ` <span class="muted" style="font-size:11px">${v.at.slice(0, 10)}</span>` : '');
  }
  if (v.state === 'flagged') {
    return `<span class="bad"><b>${v.malicious + v.suspicious} / ${v.total}</b></span>` +
      (v.at ? ` <span class="muted" style="font-size:11px">${v.at.slice(0, 10)}</span>` : '');
  }
  if (v.state === 'unscanned') return '<span class="warn">never scanned</span>';
  return `<span class="muted">unknown</span>` +
    (v.why ? ` <span class="muted" style="font-size:11px">${v.why}</span>` : '');
}
