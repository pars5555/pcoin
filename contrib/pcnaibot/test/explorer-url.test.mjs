// EXPLORER_API_URL: where the watcher READS, kept apart from EXPLORER_URL,
// the link a user is shown.
//
// On 2026-09-27 the watcher skipped deposit ticks with "rate limited (429)":
// it read https://explorer.pc.am from the explorer's own host, so its requests
// went out through Cloudflare and came back as that host's address, sharing a
// rate-limit bucket that another service on the box drained ~250 times an hour.
// The fix points reads at the local explorer. What these tests pin down:
//
//   * with no EXPLORER_API_URL the behaviour is EXACTLY what it was -- that is
//     what made the change safe to ship before the config line existed;
//   * a loopback API URL never leaks into the public link;
//   * a malformed API URL stops the watcher at startup instead of turning every
//     tick into "request failed";
//   * the D11 corroborator check cannot be fooled by the API URL being 127.0.0.1.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig } from '../lib/config.mjs';
import {
  explorerUrls, ExplorerClient, corroboratorIndependence, DEFAULT_EXPLORER_URL,
} from '../lib/explorer.mjs';

// The real loader, from a real file: the fallback must hold for the Config
// class the processes actually use, not for a stand-in.
function cfgFrom(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'pcnaibot-explorer-url-'));
  try {
    const path = join(dir, 'test.conf');
    writeFileSync(path, lines.join('\n') + '\n');
    return loadConfig(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('nothing configured: both are the public explorer', () => {
  const u = explorerUrls(cfgFrom(['RAIL_NAME=pcnaibot']));
  assert.equal(DEFAULT_EXPLORER_URL, 'https://explorer.pc.am');
  assert.deepEqual(u, { publicUrl: DEFAULT_EXPLORER_URL, apiUrl: DEFAULT_EXPLORER_URL });
});

test('only EXPLORER_URL (the config before this change): reads use it, as before', () => {
  const u = explorerUrls(cfgFrom(['EXPLORER_URL=https://explorer.example']));
  assert.deepEqual(u, { publicUrl: 'https://explorer.example', apiUrl: 'https://explorer.example' });
});

test('EXPLORER_API_URL moves the reads and leaves the public link alone', () => {
  const u = explorerUrls(cfgFrom([
    'EXPLORER_URL=https://explorer.pc.am',
    'EXPLORER_API_URL=http://127.0.0.1:8080',
  ]));
  assert.equal(u.apiUrl, 'http://127.0.0.1:8080');
  assert.equal(u.publicUrl, 'https://explorer.pc.am', 'a loopback URL must never become a user-facing link');
});

test('an empty or placeholder EXPLORER_API_URL is unset, not a URL', () => {
  for (const v of ['', 'REPLACE - local explorer']) {
    const u = explorerUrls(cfgFrom(['EXPLORER_URL=https://explorer.pc.am', `EXPLORER_API_URL=${v}`]));
    assert.equal(u.apiUrl, 'https://explorer.pc.am', `value ${JSON.stringify(v)}`);
  }
});

test('the client refuses a base that is not http(s), at construction', () => {
  for (const bad of ['localhost:8080', '127.0.0.1:8080', 'ftp://127.0.0.1', '', 'explorer.pc.am']) {
    assert.throws(() => new ExplorerClient(bad), /http:\/\/ or https:\/\//, `base ${JSON.stringify(bad)}`);
  }
  for (const good of ['http://127.0.0.1:8080', 'https://explorer.pc.am/', 'http://[::1]:8080']) {
    assert.doesNotThrow(() => new ExplorerClient(good), `base ${good}`);
  }
});

test('reads go to the API URL', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    return new Response(JSON.stringify({ index: { stale: false, node_reachable: true, blocks_behind: 0 } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const { apiUrl } = explorerUrls(cfgFrom(['EXPLORER_API_URL=http://127.0.0.1:8080/']));
  const r = await new ExplorerClient(apiUrl, { fetchImpl }).status();
  assert.equal(r.readable, true);
  assert.equal(r.health.healthy, true);
  assert.deepEqual(seen, ['http://127.0.0.1:8080/api/status']);
});

test('D11: the corroborator must be independent of BOTH explorer URLs', () => {
  const urls = { apiUrl: 'http://127.0.0.1:8080', publicUrl: 'https://explorer.pc.am' };
  assert.equal(corroboratorIndependence(urls, 'https://explorer2.pc.am').independent, true);
  // Checking only the API URL (127.0.0.1) would have passed these two.
  assert.equal(corroboratorIndependence(urls, 'https://explorer.pc.am').independent, false);
  assert.equal(corroboratorIndependence(urls, 'HTTPS://EXPLORER.PC.AM.:443/api').independent, false);
  assert.equal(corroboratorIndependence(urls, 'http://127.0.0.1:9999').independent, false);
  // Unchanged when the two URLs are the same one.
  const one = { apiUrl: 'https://explorer.pc.am', publicUrl: 'https://explorer.pc.am' };
  assert.equal(corroboratorIndependence(one, 'https://explorer2.pc.am').independent, true);
  assert.equal(corroboratorIndependence(one, 'https://explorer.pc.am').independent, false);
});

// Source checks: the invariants live in which key each process reads.
const src = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('bot.mjs builds user-facing links from EXPLORER_URL and never from EXPLORER_API_URL', () => {
  const bot = src('bot.mjs');
  assert.match(bot, /cfg\.strOr\('EXPLORER_URL'/);
  assert.doesNotMatch(bot, /EXPLORER_API_URL/);
});

test('watch.mjs reads through explorerUrls(), not straight from EXPLORER_URL', () => {
  const watch = src('watch.mjs');
  assert.match(watch, /new ExplorerClient\(EXPLORER\.apiUrl/);
  assert.doesNotMatch(watch, /cfg\.strOr\('EXPLORER_URL'/);
});
