// node contrib/price/server-test.mjs -- runs the REAL server.mjs, hermetically.
//
// index-relay-test.mjs proves the pure pieces and a synthetic body. This runs
// the actual server and proves the WIRING, which is where Step 4 could go wrong
// without any pure function being wrong:
//
//   A. useIndex 0 is today's behaviour BYTE FOR BYTE. The baseline is the
//      server.mjs all three origins ran on 2026-09-25 (git 119ee11), started
//      beside the new one on the same state and the same stubs. Every public
//      answer is compared after masking only the clocks.
//   B. index mode end to end: the switch and each of its refusals, the real
//      body through pcnaibot's validateRateBody and the exchange's
//      fetchSellPrice, a move, the ceiling clamp, the walk staying off,
//      unknown -> 503, a refused reading, the sell-below-credit alarm, and the
//      rollback.
//   C. a stale index: /credit-rate 503, both consumers refuse, and the switch
//      refuses even when forced. That is the state price.pc.am was really in on
//      2026-09-25, when exchange.pc.am was closed and answered it with 403.
//   D. the published body (owner, 2026-09-25: "make it minimal compact json").
//      bodyVersion 1 is production's body with five keys appended and a
//      unified `stale`; 2 is exactly nine keys, compact; /detail is always the
//      old body; the switch both ways; /credit-rate under each; a real replica
//      following the primary, and one following a primary on OLD code.
//
// Part A's "byte for byte" now holds for everything EXCEPT the additive tail
// of GET / and /price and the bodyVersion key at the end of /state: each is
// cut off only after asserting it is there, and what remains must still match
// production to the byte. GET /detail is compared to production's GET / whole.
//
// HERMETIC. The copies it runs have their state file, port, market URL, BSC RPC
// list and alert config rewritten to a temp directory and a stub on 127.0.0.1.
// Every rewrite must match EXACTLY once, or the test stops: a rewrite that
// silently matched nothing would leave a copy pointed at /opt/pcoin-price/
// state.json -- on the primary, production's own state -- or at Telegram.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { indexLadder, indexNote, MINIMAL_KEYS } from './index-relay.mjs';
import { loadConsumers, PCNAIBOT_BOUNDS, EXCHANGE_STALE_SECONDS } from './test-consumers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const BASELINE = process.env.PRICE_BASELINE || '119ee11';   // production on 2026-09-25
const TOKEN = 'test-admin-token-not-a-secret';
const FAST_MS = 150;
const ROOT = mkdtempSync(join(tmpdir(), 'pcoin-price-test-'));
const children = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowS = () => Math.floor(Date.now() / 1000);
let n = 0;
const check = async (name, fn) => { await fn(); n += 1; console.log('  ok  ', name); };

// ── the stub: exchange index, market ladder, and a BSC RPC ─────────────────
const RULES = { perTradePct: 2, perDayPct: 5, bandPct: 25, minTrades: 5, minEntities: 4, minNotionalUsd: 25,
                floorUsd: '0.015000000', ceilingUsd: '0.100000000', windowsHours: [24, 72, 168] };
const WINDOW = { hours: 168, trades: 4, entities: 5, countedPcn: '757.00000000', countedUsd: '16.817790', qualifies: false };
const stub = {
  index: { status: 200, state: 'held', seq: 0, nano: 27335212 },
  ladder: { marginalPrice: 0.028155268, soldPcn: 38571.36624107, remainingPcn: 16387.70607446 },
};
const BAL = { // 20,000 wPCN (8 dp) against 546.70424 USDT (18 dp): $0.027335212
  '0x290a5779a419cb9cb22fa087cdd1cd16da2d95f1': 2000000000000n,
  '0x55d398326f99059ff775485246999027b3197955': 546704240000000000000n,
};
function indexBody() {
  const i = stub.index;
  const common = { enabled: true, computedAt: nowS() - 1, lastMoveAt: null, window: WINDOW, limitedBy: [], rules: RULES };
  if (i.state === 'unknown') return { ...common, usd: null, nano: null, state: 'unknown', seq: null, reasons: ['state unreadable after seeding'] };
  return { ...common, usd: (i.nano / 1e9).toFixed(9), nano: String(i.nano), state: i.state, seq: i.seq, reasons: ['too little evidence'] };
}
const stubServer = createServer((req, res) => {
  const send = (code, obj, type = 'application/json') => {
    res.writeHead(code, { 'content-type': type }); res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
  };
  if (req.url.startsWith('/api/index')) {
    // The exchange's closed gate answers every unlisted IP with an HTML page and 403.
    if (stub.index.status !== 200) return send(stub.index.status, '<!doctype html><title>Closed</title>', 'text/html');
    return send(200, indexBody());
  }
  if (req.url.startsWith('/api/ladder/state')) return send(200, { ...stub.ladder, buybackOpen: false });
  if (req.url === '/rpc' && req.method === 'POST') {
    let s = ''; req.on('data', (c) => { s += c; });
    req.on('end', () => {
      const j = JSON.parse(s);
      const bal = BAL[String(j.params[0].to).toLowerCase()];
      send(200, bal === undefined ? { jsonrpc: '2.0', id: j.id, error: { message: 'unknown token' } }
                                  : { jsonrpc: '2.0', id: j.id, result: '0x' + bal.toString(16) });
    });
    return;
  }
  send(404, { error: 'stub: not found' });
});
await new Promise((r) => stubServer.listen(0, '127.0.0.1', r));
const STUB = `http://127.0.0.1:${stubServer.address().port}`;

async function freePort() {
  const s = createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const p = s.address().port; await new Promise((r) => s.close(r)); return p;
}

// ── a copy of a server.mjs, rewired to the temp dir and the stub ───────────
function prepare(name, src, relaySrc, { port, fast, fastSync }) {
  const dir = join(ROOT, name); mkdirSync(dir);
  let s = src;
  const swap = (from, to) => {
    const k = s.split(from).length - 1;
    if (k !== 1) throw new Error(`${name}: expected exactly one ${JSON.stringify(from.slice(0, 60))}, found ${k} -- refusing to run`);
    s = s.replace(from, () => to);
  };
  swap("const STATE = '/opt/pcoin-price/state.json';", `const STATE = ${JSON.stringify(join(dir, 'state.json'))};`);
  swap('const PORT = 8788;', `const PORT = ${port};`);
  swap("const ALERT_CONF = '/etc/pcoin/alert.conf';", `const ALERT_CONF = ${JSON.stringify(join(dir, 'no-alert.conf'))};`);
  swap("const LADDER = 'http://127.0.0.1:8789/api/ladder/state';", `const LADDER = '${STUB}/api/ladder/state';`);
  const rpcs = s.match(/const POOL_RPCS = \[[^\]]*\];/g) || [];
  if (rpcs.length !== 1) throw new Error(`${name}: expected exactly one POOL_RPCS, found ${rpcs.length}`);
  s = s.replace(rpcs[0], () => `const POOL_RPCS = ['${STUB}/rpc'];`);
  if (fast) {
    let k = 0;
    s = s.split('\n').map((l) => (/setInterval\(.*, 60000\);$/.test(l) ? (k++, l.replace(/, 60000\);$/, `, ${FAST_MS});`)) : l)).join('\n');
    if (k !== 3) throw new Error(`${name}: expected the three 60 s poll intervals, found ${k}`);
  }
  // A replica syncs every 30 s; a test cannot wait for that.
  if (fastSync) swap('setInterval(syncFromPrimary, 30000);', `setInterval(syncFromPrimary, ${FAST_MS});`);
  // Belt and braces: no production path left as a string LITERAL (comments may
  // still mention them, which is harmless).
  for (const bad of ["'/opt/pcoin-price", "'/etc/pcoin/", "'https://bsc-dataseed", "'http://127.0.0.1:8789", 'PORT = 8788']) {
    if (s.includes(bad)) throw new Error(`${name}: still refers to ${bad} after rewiring -- refusing to run`);
  }
  writeFileSync(join(dir, 'server.mjs'), s);
  writeFileSync(join(dir, 'index-relay.mjs'), relaySrc);
  return dir;
}

function state(o = {}) {
  const now = Date.now();
  return {
    role: 'primary', adminToken: TOKEN,
    reserve: 10000, supply: 10000000, feeBps: 150, dailySellCapUsd: 20, buybackOpen: false,
    serviceRate: 0.0273, serviceMaxMovePct: 10, serviceCeiling: 10, serviceRetuneIntervalHours: 1, serviceRateAt: now,
    ladderPrice: 0.028155268, ladderAt: now, ladderSoldPcn: 38571.36624107, ladderRemainingPcn: 16387.70607446,
    soldToday: 0, day: '', history: [{ at: '2026-09-09T00:00:00.000Z', side: 'buy', ref: null, price: 0.001, reserve: 10000 }],
    poolFollow: true, poolFloorUsd: 0.015, poolMaxDivergencePct: 15, poolMaxDailyDropPct: 10, poolTwapHours: 6,
    poolMinSamples: 12, poolPrice: 0.0273, poolAt: now, poolWpcn: 20000, poolUsdt: 546.7,
    poolSamples: Array.from({ length: 20 }, (_, i) => ({ t: now - (20 - i) * 60e3, p: 0.0273 + i * 1e-6 })),
    rateDayKey: '', rateDayOpen: 0, poolMedian: null, poolHeldBy: null, poolSampleCount: 20, poolHeldAnnounced: null,
    indexUrl: `${STUB}/api/index`, indexMaxAgeSeconds: 600, indexState: 'held', indexNano: '27335212', indexSeq: 0,
    indexComputedAt: nowS() - 5, indexAt: now - 5000, indexMeta: { lastMoveAt: null, window: WINDOW, limitedBy: [], reasons: ['too little evidence'] },
    indexRefused: null, indexError: null, indexHistory: [{ t: nowS() - 5, nano: 27335212 }], indexRebaseArmed: false,
    ...o,
  };
}

async function start(name, src, relaySrc, st, { fast = false, fastSync = false } = {}) {
  const port = await freePort();
  const dir = prepare(name, src, relaySrc, { port, fast, fastSync });
  writeFileSync(join(dir, 'state.json'), JSON.stringify(st, null, 2));
  const env = { ...process.env }; delete env.PCOIN_PRICE_INIT;
  const child = spawn(process.execPath, [join(dir, 'server.mjs')], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  const srv = { name, port, dir, child, out: '', err: '', base: `http://127.0.0.1:${port}` };
  child.stdout.on('data', (d) => { srv.out += d; });
  child.stderr.on('data', (d) => { srv.err += d; });
  const t0 = Date.now();
  while (!srv.out.includes(`pcoin-price on 127.0.0.1:${port}`)) {
    if (child.exitCode !== null) throw new Error(`${name} exited ${child.exitCode}:\n${srv.err}`);
    if (Date.now() - t0 > 20000) throw new Error(`${name} did not start:\n${srv.out}\n${srv.err}`);
    await sleep(25);
  }
  return srv;
}

async function http(srv, path, { method = 'GET', body, token } = {}) {
  const r = await fetch(srv.base + path, { method, headers: { 'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* text/plain */ }
  return { status: r.status, type: r.headers.get('content-type'), text, json };
}
const admin = (srv, path, body) => http(srv, path, { method: 'POST', body, token: TOKEN });
const body = async (srv) => (await http(srv, '/')).json;
async function until(what, fn, ms = 10000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn(); if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(40);
  }
}
const polls = (k) => sleep(FAST_MS * k + 100);

const { validateRateBody, RateInsane, fetchSellPrice, exchangeSource } = await loadConsumers();
const NEW_SRC = readFileSync(join(HERE, 'server.mjs'), 'utf8');
const NEW_RELAY = readFileSync(join(HERE, 'index-relay.mjs'), 'utf8');
// What bodyVersion 1 appends to the legacy body, in order (index-relay.mjs phase1Body).
const APPENDED = ['poolUsd', 'floorUsd', 'state', 'seq', 'ageSeconds'];
const PHASE1_TAIL = new RegExp(APPENDED.map((k) => `,\\n {2}"${k}": [^\\n]*`).join('') + '\\n\\}$');
let LEGACY_KEYS = null;          // production's GET / keys, read off the baseline in part A
const bytes = (t) => Buffer.byteLength(t, 'utf8');

try {
  // ═══ A. useIndex 0 == the production baseline, byte for byte ═════════════
  let baseSrc, baseRelay;
  try {
    baseSrc = execFileSync('git', ['-C', REPO, 'show', `${BASELINE}:contrib/price/server.mjs`], { encoding: 'utf8' });
    baseRelay = execFileSync('git', ['-C', REPO, 'show', `${BASELINE}:contrib/price/index-relay.mjs`], { encoding: 'utf8' });
  } catch (e) {
    throw new Error(`cannot read the baseline ${BASELINE} from git (${e.message}); part A cannot be proved, so the test FAILS rather than skip it`);
  }
  console.log(`  -- A. useIndex 0 against production ${BASELINE}`);
  const seed = state();
  const [old, neu] = await Promise.all([start('baseline', baseSrc, baseRelay, seed), start('new', NEW_SRC, NEW_RELAY, seed)]);
  const mask = (t) => t
    .replace(/"at": "[^"]*"/g, '"at": "<at>"')
    .replace(/"(ageSeconds|stateAgeSeconds)": -?\d+/g, '"$1": <age>')
    .replace(/"(ladderAt|poolAt|indexAt|serviceRateAt)": \d+/g, '"$1": <ms>');
  const same = async (label, fn, { phase1 = false, newFn = fn } = {}) => {
    const [a, b] = await Promise.all([fn(old), newFn(neu)]);
    assert.equal(b.status, a.status, `${label}: status`);
    assert.equal(b.type, a.type, `${label}: content-type`);
    let bt = mask(b.text);
    if (label === 'GET /state') {
      const cut = bt.replace(/,\n {2}"useIndex": 0,\n {2}"bodyVersion": 1\n\}$/, '\n}');
      assert.notEqual(cut, bt, '/state carries "useIndex": 0 and "bodyVersion": 1 last, for the replicas');
      bt = cut;
    }
    if (phase1) {
      const cut = bt.replace(PHASE1_TAIL, '\n}');
      assert.notEqual(cut, bt, `${label}: bodyVersion 1 appends ${APPENDED.join(', ')} last`);
      bt = cut;
    }
    assert.equal(bt, mask(a.text), `${label}: body`);
  };
  await check('every public GET answers byte-for-byte what production answers (clocks masked; the additive tail cut)', async () => {
    for (const p of ['/', '/price', '/credit-rate', '/history', '/quote/buy?usd=10', '/quote/sell?pcn=100', '/nope', '/state']) {
      await same(`GET ${p}`, (s) => http(s, p), { phase1: p === '/' || p === '/price' });
    }
    LEGACY_KEYS = Object.keys((await http(old, '/')).json);
  });
  await check('GET /detail is production\'s GET /, byte for byte, with nothing cut', async () => {
    await same('GET /detail', (s) => http(s, '/'), { newFn: (s) => http(s, '/detail') });
  });
  await check('legacy mode, bodyVersion 1: the appended values, and the rate\'s age is the LADDER clock', async () => {
    const j = await body(neu);
    assert.equal(j.stale, false); assert.equal(j.floorUsd, j.rateFloorUsd); assert.equal(j.poolUsd, j.pool.spotUsd);
    assert.equal(j.state, j.index.state); assert.equal(j.seq, j.index.seq);
    assert.equal(j.ageSeconds, j.ladder.ageSeconds, 'not serviceRateAt: a converged walk would read days old');
  });
  await check('the admin answers are unchanged too: 401, a bad value, a good value, a forced retune', async () => {
    await same('no token', (s) => http(s, '/admin/state', { method: 'POST', body: { feeBps: 1 } }));
    await same('bad value', (s) => admin(s, '/admin/state', { feeBps: 'x' }));
    await same('good value', (s) => admin(s, '/admin/state', { serviceRetuneIntervalHours: 1 }));
    await same('retune', (s) => admin(s, '/admin/retune', {}));
    await same('GET / after the retune', (s) => http(s, '/'), { phase1: true });
    await same('/credit-rate after the retune', (s) => http(s, '/credit-rate'));
  });
  await check('the shadow index block still says inUse: false and the note still says shadow', async () => {
    const j = await body(neu);
    assert.equal(j.index.inUse, false); assert.equal(j.rateFollowsPoolDown, true);
    assert.match(j.note, /shadow data from exchange\.pc\.am and must not be used for crediting yet/);
  });
  for (const s of [old, neu]) s.child.kill();

  // ═══ B. index mode, end to end ════════════════════════════════════════════
  console.log(`  -- B. index mode (exchange fetchSellPrice: ${exchangeSource})`);
  const B = await start('index', NEW_SRC, NEW_RELAY, state(), { fast: true });
  const seededAt = state().indexAt;
  await until('a confirmed index reading', async () => (await http(B, '/state')).json.indexAt > seededAt);

  await check('the switch is admin-only, and takes 0 or 1 as a NUMBER, nothing else', async () => {
    assert.equal((await http(B, '/admin/state', { method: 'POST', body: { useIndex: 1 } })).status, 401);
    for (const v of [2, 0.5, '1', true, -1, null]) {
      const r = await admin(B, '/admin/state', { useIndex: v });
      assert.equal(r.status, 400, JSON.stringify(v)); assert.match(r.json.error, /useIndex must be an integer in \[0, 1\]/);
    }
    assert.equal((await body(B)).index.inUse, false);
  });

  await check('the switch REFUSES a gap of 0.5% or more (1.23% here) and changes nothing', async () => {
    assert.equal((await admin(B, '/admin/state', { serviceRate: 0.027 })).status, 200);
    const r = await admin(B, '/admin/state', { useIndex: 1 });
    const g = (Math.abs(0.027 - 0.027335212) / 0.027335212) * 100;   // 1.2263%
    assert.equal(r.status, 409); assert.ok(r.json.error.includes(`${g.toFixed(3)}% from the index`), r.json.error);
    assert.equal(r.json.check.gapPct, Number(g.toFixed(4)));
    const j = await body(B);
    assert.equal(j.index.inUse, false); assert.equal(j.creditRateUsd, 0.027); assert.equal(j.rateFollowsPoolDown, true);
  });

  await check('the switch REFUSES while market.pc.am sells below the index', async () => {
    stub.ladder.marginalPrice = 0.0272;
    await until('the lower ladder price to be confirmed', async () => (await http(B, '/state')).json.ladderPrice === 0.0272);
    assert.equal((await admin(B, '/admin/state', { serviceRate: 0.02733 })).status, 200);
    const r = await admin(B, '/admin/state', { useIndex: 1 });
    assert.equal(r.status, 409); assert.match(r.json.error, /market\.pc\.am sells at 0\.0272, below the index/);
    stub.ladder.marginalPrice = 0.028155268;
    await until('the ladder back at index x 1.03', async () => (await http(B, '/state')).json.ladderPrice === 0.028155268);
  });

  await check('the switch goes through at 0.02%, sets the rate AT ONCE, and alerts', async () => {
    const r = await admin(B, '/admin/state', { useIndex: 1 });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.useIndex, 1); assert.equal(r.json.serviceRate, 0.027335212); assert.equal(r.json.check.ok, true);
    assert.equal(r.json.check.gapPct, Number(((Math.abs(0.02733 - 0.027335212) / 0.027335212) * 100).toFixed(4)));
    assert.equal((await http(B, '/state')).json.useIndex, 1, 'replicated to the replicas through /state');
    assert.match(B.err, /no Telegram token or chat configured/, 'alerts are log-only in this test');
    assert.match(B.err, /The rails now credit at the PCN index/);
  });

  await check('the REAL body: creditRateUsd = serviceRate = index.usd, pool no longer followed, compat ladder, new note', async () => {
    const r = await http(B, '/');
    const j = r.json;
    assert.equal(j.creditRateUsd, 0.027335212); assert.equal(j.serviceRate, 0.027335212); assert.equal(j.index.usd, 0.027335212);
    assert.equal(j.rateFieldToUse, 'creditRateUsd'); assert.equal(j.rateFollowsPoolDown, false); assert.equal(j.index.inUse, true);
    assert.equal(j.sellPriceUsd, 0.028155268, 'what market.pc.am charges, read from its ladder state as before');
    assert.equal(j.price, j.sellPriceUsd);
    assert.deepEqual(j.ladder, indexLadder({ block: j.index, sellPriceUsd: j.sellPriceUsd,
      soldPcn: 38571.36624107, remainingPcn: 16387.70607446 }));
    assert.equal(j.ladder.stale, false); assert.equal(j.ladder.ageSeconds, j.index.ageSeconds);
    assert.equal(j.note, indexNote({ floorUsd: 0.015, rules: { perTradePct: 2, perDayPct: 5 }, maxAgeS: 600, buybackOpen: false }),
      'the caps in the note come from the exchange\'s relayed rules');
    assert.equal(j.stale, false); assert.equal(j.role, 'primary');
    const t = await http(B, '/credit-rate');
    assert.equal(t.status, 200); assert.equal(t.text, '0.027335212\n');
  });

  await check('pcnaibot\'s REAL validateRateBody accepts the real body and credits the index', async () => {
    const r = validateRateBody((await http(B, '/')).text, PCNAIBOT_BOUNDS, { rate: 0.02733 });
    assert.equal(r.rateText, '0.027335212'); assert.equal(r.fieldUsed, 'creditRateUsd'); assert.equal(r.diverged, false);
  });

  await check('the exchange\'s fetchSellPrice accepts the real body, over real HTTP', async () => {
    const r = await fetchSellPrice({ url: B.base + '/', staleSeconds: EXCHANGE_STALE_SECONDS, attempts: 1 });
    assert.equal(r.usable, true, r.reason); assert.equal(r.sellPriceUsd, '0.028155268');
  });

  await check('an index move (-2%, seq 1) becomes the credit rate after two agreeing polls, stamped and alerted', async () => {
    const t0 = Date.now();
    stub.index.seq = 1; stub.index.nano = 26788508;
    await until('the rate to follow the index', async () => (await body(B)).creditRateUsd === 0.026788508);
    const s = (await http(B, '/state')).json;
    assert.equal(s.serviceRate, 0.026788508); assert.ok(s.serviceRateAt >= t0, 'serviceRateAt stamped');
    assert.match(B.err, /serviceRate moved \(PCN index\)[\s\S]*0\.027335212[\s\S]*0\.026788508[\s\S]*index seq 1/);
  });

  await check('the walk stays OFF: a new market price moves sellPriceUsd, never the rate; retune and hand-set rates refused', async () => {
    stub.ladder.marginalPrice = 0.0276;
    await until('the new ladder price', async () => (await body(B)).sellPriceUsd === 0.0276);
    await polls(4);
    assert.equal((await body(B)).creditRateUsd, 0.026788508);
    const rt = await admin(B, '/admin/retune', {});
    assert.equal(rt.status, 409); assert.match(rt.json.error, /follows the PCN index/);
    const hs = await admin(B, '/admin/state', { serviceRate: 0.03 });
    assert.equal(hs.status, 409); assert.match(hs.json.error, /follows the PCN index/);
    // The case the early return in retuneServiceRate() exists for: the index
    // stops confirming (stamping serviceRateAt) and the walk's interval comes
    // due. Interval 0 makes it due on every ladder poll; the rate must not move.
    assert.equal((await admin(B, '/admin/state', { serviceRetuneIntervalHours: 0 })).status, 200);
    stub.index.status = 403;
    await polls(6);
    assert.equal((await body(B)).creditRateUsd, 0.026788508, 'a due walk must not move an index-mode rate');
    stub.index.status = 200;
    assert.equal((await admin(B, '/admin/state', { serviceRetuneIntervalHours: 1 })).status, 200);
  });

  await check('the rate is clamped to serviceCeiling, and comes back off it', async () => {
    assert.equal((await admin(B, '/admin/state', { serviceCeiling: 0.02 })).status, 200);
    await until('the ceiling to bind', async () => (await body(B)).creditRateUsd === 0.02);
    assert.equal((await http(B, '/credit-rate')).text, '0.02\n');
    assert.match(B.err, /clamped from \$0\.026788508 to the floor\/ceiling/);
    assert.equal((await admin(B, '/admin/state', { serviceCeiling: 10 })).status, 200);
    await until('the ceiling to release', async () => (await body(B)).creditRateUsd === 0.026788508);
  });

  await check('a market price BELOW the credit rate is alarmed after three polls, and its clearing too', async () => {
    stub.ladder.marginalPrice = 0.026;
    await until('the under-price alarm', async () => /The rails credit MORE than market\.pc\.am charges/.test(B.err));
    stub.ladder.marginalPrice = 0.0276;
    await until('the all-clear', async () => /market\.pc\.am sells at or above the credit rate again/.test(B.err));
  });

  await check('an UNKNOWN index: /credit-rate 503, ladder.stale true, both consumers refuse, the rate is kept not used', async () => {
    stub.index.state = 'unknown';
    await until('the unknown state', async () => (await body(B)).index.state === 'unknown');
    assert.equal((await http(B, '/credit-rate')).status, 503);
    const r = await http(B, '/');
    assert.equal(r.json.ladder.stale, true); assert.equal(r.json.creditRateUsd, 0.026788508);
    assert.throws(() => validateRateBody(r.text, PCNAIBOT_BOUNDS, { rate: 0.0268 }),
      (e) => e instanceof RateInsane && /ladder\.stale is true/.test(e.reason));
    const ex = await fetchSellPrice({ url: B.base + '/', staleSeconds: EXCHANGE_STALE_SECONDS, attempts: 1 });
    assert.equal(ex.usable, false); assert.equal(ex.kind, 'bad');
    assert.match(B.err, /PCN index is UNKNOWN on exchange\.pc\.am/);
    stub.index.state = 'held';
    await until('crediting to resume', async () => (await http(B, '/credit-rate')).status === 200);
    assert.match(B.err, /PCN index carries a price again/);
  });

  await check('a REFUSED reading (-10% in one step) never moves the rate', async () => {
    stub.index.seq = 2; stub.index.nano = 24109657;
    await until('the refusal', async () => (await http(B, '/state')).json.indexRefused !== null);
    const j = await body(B);
    assert.equal(j.creditRateUsd, 0.026788508); assert.match(j.index.refused.why, /a step/);
    assert.match(B.err, /PCN index reading REFUSED \(IN USE: the rails credit at it\)/);
    stub.index.seq = 1; stub.index.nano = 26788508;
    await until('the refusal to clear', async () => (await http(B, '/state')).json.indexRefused === null);
  });

  await check('ROLLBACK: {"useIndex":0} restores the legacy body; the walk resumes from the index value without a jump', async () => {
    const r = await admin(B, '/admin/state', { useIndex: 0 });
    assert.equal(r.status, 200); assert.equal(r.json.useIndex, 0);
    await polls(6);
    const j = await body(B);
    assert.equal(j.creditRateUsd, 0.026788508, 'no jump: the walk waits a full interval from the last index reading');
    assert.equal(j.rateFollowsPoolDown, true); assert.equal(j.index.inUse, false);
    assert.match(j.note, /^Posted from a finite 100,000 PCN order-book ladder/);
    assert.deepEqual(Object.keys(j.ladder), ['price', 'soldPcn', 'remainingPcn', 'ageSeconds', 'stale']);
    assert.equal(j.ladder.price, 0.0276, 'the legacy block carries the raw ladder price again');
    assert.match(B.err, /The rails are back on the legacy walk/);
    assert.equal((await admin(B, '/admin/retune', {})).status, 200, 'the walk can be stepped again');
  });
  B.child.kill();

  // ═══ C. a stale index -- exchange.pc.am closed, answering 403 ════════════
  console.log('  -- C. a stale index (the live state on 2026-09-25)');
  stub.index = { status: 403, state: 'held', seq: 0, nano: 27335212 };
  const C = await start('stale', NEW_SRC, NEW_RELAY, state({ useIndex: 1, serviceRate: 0.027335212,
    indexComputedAt: nowS() - 700, indexAt: Date.now() - 700e3 }), { fast: true });
  await polls(3);

  await check('in index mode a stale index answers /credit-rate 503 and both consumers refuse', async () => {
    assert.equal((await http(C, '/credit-rate')).status, 503);
    const r = await http(C, '/');
    assert.equal(r.json.index.stale, true); assert.equal(r.json.ladder.stale, true); assert.equal(r.json.index.inUse, true);
    assert.throws(() => validateRateBody(r.text, PCNAIBOT_BOUNDS, { rate: 0.0273 }), (e) => e instanceof RateInsane);
    const ex = await fetchSellPrice({ url: C.base + '/', staleSeconds: EXCHANGE_STALE_SECONDS, attempts: 1 });
    // Same refusal as before bodyVersion existed. Its reason used to name
    // ladder.stale; the top-level flag is unified now and the exchange checks
    // it first, so the reason names that one.
    assert.equal(ex.usable, false); assert.equal(ex.kind, 'bad'); assert.match(ex.reason, /stale/);
    assert.equal((await http(C, '/state')).json.indexError.why, 'HTTP 403');
  });

  await check('bodyVersion 1 says it at the TOP LEVEL now: stale true, the age over 600, while /detail keeps the old flag', async () => {
    const j = await body(C);
    assert.equal(j.stale, true, 'unified: the rate is unusable');
    assert.equal(j.state, 'held', 'the last state stands; the flag is what holds');
    assert.ok(j.ageSeconds >= 700, `ageSeconds ${j.ageSeconds}`);
    const d = (await http(C, '/detail')).json;
    assert.equal(d.stale, false, '/detail is the old body: its top-level flag is the replica sync only');
    assert.equal(d.ladder.stale, true);
  });

  await check('rolling back restores crediting even while the exchange is unreadable', async () => {
    assert.equal((await admin(C, '/admin/state', { useIndex: 0 })).status, 200);
    assert.equal((await http(C, '/credit-rate')).status, 200);
  });

  await check('the switch refuses a stale index EVEN WHEN FORCED', async () => {
    const r = await admin(C, '/admin/state', { useIndex: 1, force: true });
    assert.equal(r.status, 409); assert.match(r.json.error, /the index is stale/);
    assert.equal((await body(C)).index.inUse, false);
  });
  C.child.kill();

  // ═══ D. the published body: bodyVersion 1 and 2, the switch, the replicas ═══
  console.log('  -- D. bodyVersion: phase 1, the minimal body, /detail, the switch, the replicas');
  stub.index = { status: 200, state: 'held', seq: 0, nano: 27335212 };
  stub.ladder.marginalPrice = 0.028155268;
  const P = await start('body-primary', NEW_SRC, NEW_RELAY, state({ useIndex: 1, serviceRate: 0.027335212 }), { fast: true });
  // A REAL replica: its own state file, its own process, syncing from P's
  // /state over HTTP exactly as the two production replicas do (minus the pin).
  const R = await start('body-replica', NEW_SRC, NEW_RELAY,
    state({ role: 'replica', upstream: P.base, adminToken: '', serviceRate: 0.001, bodyVersion: 1 }), { fastSync: true });
  await until('the replica to mirror the primary', async () => (await body(R)).creditRateUsd === 0.027335212);
  await until('the primary\'s first pool sample', async () => (await body(P)).pool.spotUsd !== 0.0273);
  // Everything that is a clock, at any depth: two reads a moment apart differ there and nowhere else.
  const unclock = (o) => JSON.parse(JSON.stringify(o), (k, v) => (k === 'at' || /ageseconds$/i.test(k) ? '<t>' : v));

  let v1Body, detailBody;
  await check('phase 1 (the default): every production key where it was, plus poolUsd floorUsd state seq ageSeconds -- right values', async () => {
    const r = await http(P, '/');
    const j = r.json;
    v1Body = r.text;
    assert.deepEqual(Object.keys(j), [...LEGACY_KEYS, ...APPENDED]);
    assert.equal(j.creditRateUsd, 0.027335212); assert.equal(j.creditRateUsd, j.index.usd);
    assert.equal(j.sellPriceUsd, 0.028155268);
    assert.equal(j.floorUsd, 0.015); assert.equal(j.floorUsd, j.rateFloorUsd);
    assert.ok(Math.abs(j.poolUsd - 546.70424 / 20000) < 1e-15, 'the PancakeSwap spot, read off the stub pair');
    assert.equal(j.poolUsd, j.pool.spotUsd);
    assert.equal(j.state, 'held'); assert.equal(j.seq, 0); assert.equal(j.seq, j.index.seq);
    assert.equal(j.ageSeconds, Math.max(0, j.index.ageSeconds), 'index mode: the index\'s age');
    assert.equal(j.stale, false);
    assert.match(r.text, /^\{\n {2}"price": /, 'still pretty-printed: nothing about phase 1 changes the bytes a consumer already parses');
  });

  await check('/detail is the old body: production\'s keys, and a phase-1 body is it plus the tail (stale unified)', async () => {
    const [v1, d] = await Promise.all([http(P, '/'), http(P, '/detail')]);
    detailBody = d.text;
    assert.deepEqual(Object.keys(d.json), LEGACY_KEYS);
    const cut = { ...v1.json }; for (const k of APPENDED) delete cut[k];
    assert.deepEqual(unclock(cut), unclock(d.json));
  });

  await check('pcnaibot and the exchange treat the REAL phase-1 body exactly as before', async () => {
    const r = validateRateBody((await http(P, '/')).text, PCNAIBOT_BOUNDS, { rate: 0.02733 });
    assert.equal(r.rateText, '0.027335212'); assert.equal(r.fieldUsed, 'creditRateUsd'); assert.equal(r.diverged, false);
    const ex = await fetchSellPrice({ url: P.base + '/', staleSeconds: EXCHANGE_STALE_SECONDS, attempts: 1 });
    assert.equal(ex.usable, true, ex.reason); assert.equal(ex.sellPriceUsd, '0.028155268');
  });

  await check('the switch is admin-only, primary-only, and takes 1 or 2 as a NUMBER, nothing else', async () => {
    assert.equal((await http(P, '/admin/state', { method: 'POST', body: { bodyVersion: 2 } })).status, 401);
    for (const v of [0, 3, 1.5, '2', true, null]) {
      const r = await admin(P, '/admin/state', { bodyVersion: v });
      assert.equal(r.status, 400, JSON.stringify(v)); assert.match(r.json.error, /bodyVersion must be an integer in \[1, 2\]/);
    }
    assert.equal((await admin(R, '/admin/state', { bodyVersion: 2 })).status, 409, 'a replica refuses every write');
    assert.deepEqual(Object.keys((await body(P))), [...LEGACY_KEYS, ...APPENDED], 'nothing changed');
  });

  let v2Body;
  await check('bodyVersion 2: EXACTLY the nine keys, compact, carrying the values phase 1 published', async () => {
    const before = await body(P);
    const sw = await admin(P, '/admin/state', { bodyVersion: 2 });
    assert.equal(sw.status, 200, sw.text); assert.deepEqual(sw.json.applied, { bodyVersion: 2 });
    for (const path of ['/', '/price']) {
      const r = await http(P, path);
      assert.deepEqual(Object.keys(r.json), MINIMAL_KEYS, path);
      assert.deepEqual(MINIMAL_KEYS, ['creditRateUsd', 'sellPriceUsd', 'poolUsd', 'floorUsd', 'state', 'seq', 'stale', 'ageSeconds', 'at']);
      assert.equal(r.text, JSON.stringify(r.json), `${path}: compact, not one byte of whitespace`);
      assert.equal(r.type, 'application/json');
      for (const k of MINIMAL_KEYS.filter((x) => x !== 'at' && x !== 'ageSeconds')) assert.deepEqual(r.json[k], before[k], k);
      assert.ok(Number.isInteger(r.json.ageSeconds) && r.json.ageSeconds >= 0);
      assert.ok(Number.isFinite(Date.parse(r.json.at)));
      v2Body = r.text;
    }
    assert.match(P.err, /now publishes the SHORT price format/);
  });

  await check('under 2, /credit-rate\'s 200 is still the bare number as text; /detail is still the full, pretty body', async () => {
    const c = await http(P, '/credit-rate');
    assert.equal(c.status, 200); assert.match(c.type, /^text\/plain/);
    assert.equal(c.text, '0.027335212\n');
    const d = await http(P, '/detail');
    assert.deepEqual(Object.keys(d.json), LEGACY_KEYS); assert.match(d.text, /^\{\n {2}"price": /);
    assert.equal(d.json.index.inUse, true);
  });

  await check('the replica follows the switch through /state and serves the SAME body', async () => {
    assert.equal((await http(P, '/state')).json.bodyVersion, 2);
    await until('the replica to serve the minimal body', async () => Object.keys(await body(R)).length === MINIMAL_KEYS.length);
    const [a, b] = await Promise.all([http(P, '/'), http(R, '/')]);
    assert.deepEqual(unclock(b.json), unclock(a.json));
    assert.ok(Math.abs(b.json.ageSeconds - a.json.ageSeconds) <= 1, 'both ages come off the primary\'s clock stamps');
    const [ca, cb] = await Promise.all([http(P, '/credit-rate'), http(R, '/credit-rate')]);
    assert.equal(cb.status, 200); assert.equal(cb.text, ca.text);
    const [da, db] = await Promise.all([http(P, '/detail'), http(R, '/detail')]);
    const own = (o) => ({ ...unclock(o), role: '<role>' });
    assert.deepEqual(own(db.json), own(da.json), '/detail too, apart from which origin answered');
    assert.equal(db.json.role, 'replica');
  });

  await check('under 2, an UNKNOWN index: stale true, seq null, /credit-rate 503 -- on both origins -- and back', async () => {
    stub.index.state = 'unknown';
    for (const s of [P, R]) {
      await until(`${s.name}: unknown`, async () => (await body(s)).state === 'unknown');
      const j = await body(s);
      assert.equal(j.stale, true); assert.equal(j.seq, null); assert.equal(j.creditRateUsd, 0.027335212, 'kept, not used');
      const c = await http(s, '/credit-rate');
      assert.equal(c.status, 503); assert.equal(c.text, 'unavailable\n', 'never a number, never the stale body');
    }
    stub.index.state = 'held';
    for (const s of [P, R]) await until(`${s.name}: crediting again`, async () => (await http(s, '/credit-rate')).status === 200);
    assert.equal((await body(P)).stale, false);
  });

  await check('REVERSIBLE: {"bodyVersion":1} restores the phase-1 body and the text /credit-rate, on both origins', async () => {
    const r = await admin(P, '/admin/state', { bodyVersion: 1 });
    assert.equal(r.status, 200); assert.deepEqual(r.json.applied, { bodyVersion: 1 });
    for (const s of [P, R]) {
      await until(`${s.name}: phase 1 again`, async () => Object.keys(await body(s)).length > MINIMAL_KEYS.length);
      assert.deepEqual(Object.keys(await body(s)), [...LEGACY_KEYS, ...APPENDED]);
      const c = await http(s, '/credit-rate');
      assert.equal(c.text, '0.027335212\n'); assert.match(c.type, /^text\/plain/);
    }
    assert.match(P.err, /back on the full price format/);
  });

  await check('the short body exists only ON the index: switching the index off takes body 1 back with it; body 2 off-index is refused', async () => {
    assert.equal((await admin(P, '/admin/state', { bodyVersion: 2 })).status, 200);
    await until('P on 2', async () => Object.keys(await body(P)).length === MINIMAL_KEYS.length);
    const contradiction = await admin(P, '/admin/state', { useIndex: 0, bodyVersion: 2 });
    assert.equal(contradiction.status, 409, 'an explicit ask for both is refused, never silently rewritten');
    assert.equal((await http(P, '/state')).json.useIndex, 1, 'and nothing was applied');
    const off = await admin(P, '/admin/state', { useIndex: 0 });
    assert.equal(off.status, 200, off.text);
    assert.deepEqual(off.json.applied, { useIndex: 0, bodyVersion: 1 }, 'the rollback carries the full body with it');
    assert.equal((await http(P, '/state')).json.bodyVersion, 1);
    assert.ok(Object.keys(await body(P)).length > MINIMAL_KEYS.length, 'GET / is the full body again');
    const refused = await admin(P, '/admin/state', { bodyVersion: 2 });
    assert.equal(refused.status, 409); assert.match(refused.json.error, /only exists while the credit rate IS the PCN index/);
    assert.equal((await http(P, '/state')).json.bodyVersion, 1, 'a refused write changes nothing');
    const both = await admin(P, '/admin/state', { useIndex: 0, bodyVersion: 2 });
    assert.equal(both.status, 409, 'asking for both at once is the same ambiguous state, refused');
    const on = await admin(P, '/admin/state', { useIndex: 1, force: true });
    assert.equal(on.status, 200, on.text);
    assert.equal((await body(P)).index.inUse, true);
  });

  await check('a replica that LOSES the primary says stale under either body, keeps its bodyVersion, and 503s /credit-rate', async () => {
    assert.equal((await admin(P, '/admin/state', { bodyVersion: 2 })).status, 200);
    await until('the replica on 2', async () => Object.keys(await body(R)).length === MINIMAL_KEYS.length);
    P.child.kill();
    await until('the replica to notice', async () => (await body(R)).stale === true);
    const j = await body(R);
    assert.deepEqual(Object.keys(j), MINIMAL_KEYS, 'a failed sync resolves nothing: still the body it was told to serve');
    assert.equal(j.state, 'held', 'the index itself was fine; it is the ORACLE that is out of date');
    assert.equal((await http(R, '/credit-rate')).status, 503);
    assert.equal((await http(R, '/detail')).json.stale, true, 'the old flag says it too');
  });
  R.child.kill();

  await check('a replica of a primary on OLD code (no bodyVersion in /state) serves phase 1, whatever it remembered', async () => {
    const OP = await start('old-primary', baseSrc, baseRelay, state());
    const R2 = await start('replica-of-old', NEW_SRC, NEW_RELAY,
      state({ role: 'replica', upstream: OP.base, adminToken: '', bodyVersion: 2 }), { fastSync: true });
    assert.equal((await http(OP, '/state')).json.bodyVersion, undefined, 'the old primary does not publish it');
    assert.deepEqual(Object.keys(await body(R2)), [...LEGACY_KEYS, ...APPENDED]);
    assert.equal((await http(R2, '/state')).json.bodyVersion, 1);
    OP.child.kill(); R2.child.kill();
  });

  console.log(`  -- index-mode sizes on the stub's figures: today's body (/detail) ${bytes(detailBody)} B, ` +
              `phase 1 ${bytes(v1Body)} B, minimal ${bytes(v2Body)} B`);

  console.log(`ALL ${n} CHECKS PASSED`);
} finally {
  for (const c of children) { try { c.kill(); } catch { /* already gone */ } }
  stubServer.close();
  await sleep(200);
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* Windows may still hold a handle */ }
}
