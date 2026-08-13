// PCoin mining pool — jobs, shares, PPLNS, and payouts made BY THE COINBASE.
//
//   *** THIS POOL HOLDS NO WALLET, NO PRIVATE KEY, AND HAS NO SEND PATH. ***
//
// Miners connect, get work, and submit shares. Every accepted share is written
// to SQLite before the miner is told "OK". When the pool builds a template it
// splits that block's reward across the PPLNS window and emits ONE COINBASE
// OUTPUT PER MINER, so the block itself pays them. There is nothing to send
// afterwards and no float for an operator to hold or lose.
//
// What that buys, beyond not holding anyone's money:
//
//   * idempotency stops being a database constraint and becomes a property of
//     the chain -- a block either exists or it does not, so a retry cannot pay
//     twice and a lost response resolves nothing
//   * an orphaned block reverses itself; there is no credit to claw back
//   * a miner can verify its own payment inside the block it helped find,
//     without trusting this pool's bookkeeping
//
// The cost, stated plainly: the split is fixed when the TEMPLATE is built,
// because the coinbase is committed to by the merkle root. A share submitted a
// second before a block lands may be paid by the NEXT block instead. Nothing is
// lost, only deferred. And a miner owed less than the dust limit is left out of
// that block and accumulates instead -- see buildPayoutOutputs().
//
// Read the ledger with:  node payouts.mjs --config pool.config.json
//
//   node pool.mjs --config pool.config.json
//
// PROTOCOL — Monero's stratum-like convention, JSON per line over TCP, rather
// than something invented here. Existing RandomX mining software speaks it and
// anyone who has run a Monero pool can read this.
//
//   -> {"id":1,"method":"login","params":{"login":"<payout address>","pass":"x"}}
//   <- {"id":1,"result":{"id":"<session>","job":{...},"status":"OK"}}
//   -> {"id":2,"method":"submit","params":{"id":"<session>","job_id":"..","nonce":"xxxxxxxx"}}
//   <- {"id":2,"result":{"status":"OK"}}   or   {"id":2,"error":{"code":-1,"message":".."}}
//   <- {"jsonrpc":"2.0","method":"job","params":{...}}          pushed on new tip
//
// The job carries the 80-byte header as hex with the nonce field zeroed, plus
// the share target. A miner writes its nonce at offset 76 and hashes.

import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  addressToScript, buildCoinbase, merkleRoot, buildHeader,
  serializeBlock, bitsToTarget, scaleTarget, sha256d, nextDiffFactor, maxFactorForWeight,
} from './block.mjs';
import { Store, loadConfig, pcn, buildPayoutOutputs } from './store.mjs';
import { createApi } from './api.mjs';

// ── config ──────────────────────────────────────────────────────────────────
const cfgPath = process.argv.includes('--config')
  ? process.argv[process.argv.indexOf('--config') + 1]
  : new URL('./pool.config.json', import.meta.url).pathname;
const CFG = loadConfig(cfgPath);

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ── the node ────────────────────────────────────────────────────────────────
// Shelling out to bitcoin-cli rather than speaking JSON-RPC: the node's RPC is
// loopback-bound INSIDE its container, which is deliberate (see CLAUDE.md), and
// docker exec is the supported way in. One process per call is cheap next to a
// 21.7 ms share.
const cli = (args) => new Promise((res, rej) => {
  execFile(CFG.cliCommand[0], [...CFG.cliCommand.slice(1), ...args],
    { maxBuffer: 64 * 1024 * 1024 }, (e, out, err) => e ? rej(new Error(err || e.message)) : res(out.trim()));
});
const cliJson = async (args) => JSON.parse(await cli(args));

// ── the validator, kept warm ────────────────────────────────────────────────
// Building the RandomX VM costs ~834 ms and each hash ~21.7 ms. One long-lived
// process, one request at a time, requests queued in order.
class Validator {
  constructor(bin) {
    this.p = spawn(bin, ['--serve'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.q = [];
    this.alive = true;
    let buf = '';
    this.p.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        const w = this.q.shift();
        if (w) w(line);
      }
    });
    // If the validator dies the pool cannot verify anything. Do NOT keep
    // accepting shares -- a pool that credits unverified work is worse than a
    // pool that is down.
    this.p.on('exit', (code) => {
      this.alive = false;
      log(`FATAL validator exited (${code}); refusing further shares`);
      while (this.q.length) this.q.shift()('err validator gone');
    });
    this.ready = new Promise((res) => {
      this.p.stderr.on('data', (d) => { if (d.toString().includes('ready')) res(); });
    });
  }
  check(headerHex, targetHex) {
    if (!this.alive) return Promise.resolve({ ok: false, dead: true });
    return new Promise((res) => {
      this.q.push((line) => {
        const [verdict, hash] = line.split(' ');
        res({ ok: verdict === 'ok', err: verdict === 'err', hash });
      });
      this.p.stdin.write(`${headerHex} ${targetHex}\n`);
    });
  }
}

// ── job state ───────────────────────────────────────────────────────────────
const state = {
  tpl: null,            // last getblocktemplate
  script: null,         // pool payout scriptPubKey
  netTarget: null,      // 32-byte BE
  jobs: new Map(),      // job_id -> { header base, merkle, coinbase, height, target, seen:Set }
  jobSeq: 0,
  miners: new Map(),    // session id -> miner
  payout: null,         // the coinbase output set for the current template
  net: null,            // last good node reading, for the public API
  accepted: 0,          // this process's counters; the ledger lives in SQLite
  blocksFound: 0,
  storeDown: null,      // set to a reason if the store dies
};

const shareTargetFor = (m) => scaleTarget(state.netTarget, m.diffFactor);

function makeJob(miner) {
  const t = state.tpl;
  if (!t) return null;
  // Per-miner extranonce: it changes the coinbase, hence the txid, hence the
  // merkle root, hence the header. Without it every miner grinds the same work
  // and the pool pays several people for one search.
  const extranonce = miner.extranonce + (miner.jobCounter++ & 0xffff).toString(16).padStart(4, '0');
  const cb = buildCoinbase({
    height: t.height,
    value: t.coinbasevalue,
    script: state.script,
    // THE PAYOUT SET. Every miner's job carries the same outputs -- only the
    // extranonce in the scriptSig differs -- so whichever miner solves it, the
    // block pays the same people the same amounts. This is what replaces a
    // wallet, a private key and a send path.
    pays: state.payout ? state.payout.outputs : null,
    extranonce,
    witnessCommitment: t.default_witness_commitment,
  });
  const txids = [cb.txid, ...(t.transactions || []).map((x) => Buffer.from(x.txid, 'hex').reverse())];
  const root = merkleRoot(txids);
  const header = buildHeader({
    version: t.version, prevhash: t.previousblockhash,
    merkle: root, time: t.curtime, bits: t.bits, nonce: 0,
  });
  const id = (++state.jobSeq).toString(16);
  const job = {
    id, header, coinbase: cb, height: t.height, bits: t.bits,
    prevhash: t.previousblockhash,
    txs: (t.transactions || []).map((x) => x.data),
    target: shareTargetFor(miner),
    // Pinned to THIS job rather than read from state at submit time. The two
    // agree today because jobs are cleared whenever the tip moves, but the
    // network target is what decides whether a share is a block and what one
    // block's work is worth in the PPLNS window -- both are properties of the
    // job, so read them off the job.
    netTarget: bitsToTarget(t.bits),
    value: t.coinbasevalue,
    // Pinned to the job, because the coinbase this miner is hashing pays THIS
    // set. A later template may pay a different one; the block that gets
    // submitted must be recorded as paying what it actually pays.
    payout: state.payout,
    seen: new Set(),
    miner: miner.id,
  };
  state.jobs.set(id, job);
  // Bounded: a job nobody solves is dead once the tip moves, and an unbounded
  // map is a memory leak with a miner-controlled growth rate.
  if (state.jobs.size > 500) {
    const oldest = state.jobs.keys().next().value;
    state.jobs.delete(oldest);
  }
  return {
    job_id: id,
    blob: job.header.toString('hex'),
    target: job.target.toString('hex'),
    height: t.height,
    algo: 'rx/pcoin',
  };
}

const send = (sock, obj) => { try { sock.write(JSON.stringify(obj) + '\n'); } catch { /* gone */ } };

function pushJobs(reason) {
  for (const m of state.miners.values()) {
    const j = makeJob(m);
    if (j) send(m.sock, { jsonrpc: '2.0', method: 'job', params: j });
  }
  if (state.miners.size) log(`pushed new job to ${state.miners.size} miner(s) (${reason})`);
}

// ── template polling ────────────────────────────────────────────────────────
async function refreshTemplate() {
  try {
    const t = await cliJson(['getblocktemplate', '{"rules":["segwit"]}']);
    const changed = !state.tpl || state.tpl.previousblockhash !== t.previousblockhash;
    state.tpl = t;
    state.netTarget = bitsToTarget(t.bits);

    // Recompute who this template would pay. Done here, once per refresh, so
    // every job built from it carries the same outputs -- and so the window is
    // as fresh as the template is.
    //
    // A FAILURE HERE MUST NOT PAY THE POOL EVERYTHING. If the window cannot be
    // read, the honest thing is to keep the previous payout set rather than
    // build a coinbase that quietly pays the pool address alone: an unreadable
    // ledger is not "nobody is owed anything".
    try {
      const win = await store.currentWindow(state.netTarget.toString('hex'));
      state.payout = buildPayoutOutputs({
        value: t.coinbasevalue,
        feeBasisPoints: CFG.feeBasisPoints,
        entries: win.entries,
        scriptOf: (addr) => addressToScript(addr, CFG.hrp),
        poolScript: state.script,
        dustLimit: BigInt(CFG.dustLimit ?? 294),
      });
      // NOTE: buildPayoutOutputs already returns windowWeight for the LIVE set
      // -- the miners actually being paid, after dust exclusion. Overwriting it
      // with the full window would store a divisor that does not reproduce the
      // amounts, and every reconciliation afterwards would disagree with a
      // ledger that was in fact correct.
      for (const d of state.payout.dropped) {
        log(`payout: ${d.miner.slice(0, 14)}… would get ${d.wouldHave} sat, under the dust limit — `
          + 'left in the window to accumulate, not lost');
      }
    } catch (e) {
      log(`payout set NOT rebuilt (${e.message.slice(0, 120)}); keeping the previous one`);
    }

    if (changed) {
      log(`tip -> height ${t.height - 1}, next ${t.height}, bits ${t.bits}`);
      state.jobs.clear();          // work on a stale tip is wasted
      pushJobs('new tip');
    }
  } catch (e) {
    // An unreadable node is UNKNOWN, not "no new work". Keep serving the last
    // job rather than inventing one; miners keep hashing on work that was valid.
    log(`template refresh failed: ${e.message.slice(0, 120)}`);
  }
}

// ── vardiff ─────────────────────────────────────────────────────────────────
// Every share costs the pool 21.7 ms of CPU, so share rate is a real budget,
// not a comfort setting. Hold each miner near one share per SHARE_INTERVAL.
function retune(m) {
  const now = Date.now();
  const elapsed = (now - m.windowStart) / 1000;
  if (elapsed < CFG.vardiff.retuneSeconds) return;
  const rate = m.windowShares / elapsed;                 // shares/sec
  const want = 1 / CFG.vardiff.targetSeconds;
  if (rate > 0) {
    // The direction is load-bearing and got shipped inverted; it now lives in
    // block.mjs next to scaleTarget, which is the other half of the same trap,
    // and storetest.mjs holds it there.
    // The ceiling comes from the CHAIN, not the config: a factor beyond this
    // makes every hash a share worth ~nothing, which costs the pool 21.7 ms
    // each to validate. config maxFactor is only an additional operator bound.
    const chainCap = state.netTarget ? maxFactorForWeight(state.netTarget) : CFG.vardiff.maxFactor;
    const next = nextDiffFactor(m.diffFactor, rate, CFG.vardiff.targetSeconds,
                                CFG.vardiff.minFactor,
                                Math.min(CFG.vardiff.maxFactor, chainCap));
    if (next !== m.diffFactor) {
      log(`vardiff ${m.login.slice(0, 12)}… ${m.diffFactor} -> ${next} (${rate.toFixed(3)}/s, want ${want.toFixed(3)}/s)`);
      m.diffFactor = next;
      // PUSH THE NEW DIFFICULTY IMMEDIATELY.
      //
      // Jobs were only rebuilt on a new tip, so a vardiff change did nothing
      // for up to ten minutes while retune kept measuring the OLD difficulty
      // and "correcting" again every 60 s. That feedback loop is what actually
      // drove the runaway -- the controller was reacting to a rate its own
      // previous change had not yet been allowed to affect.
      const j = makeJob(m);
      if (j) send(m.sock, { jsonrpc: '2.0', method: 'job', params: j });
    }
  }
  m.windowStart = now; m.windowShares = 0;
}

// ── share handling ──────────────────────────────────────────────────────────
async function handleSubmit(m, params, id) {
  const job = state.jobs.get(params.job_id);
  if (!job) return { error: { code: -1, message: 'job not found or stale' } };
  if (job.miner !== m.id) return { error: { code: -1, message: 'job belongs to another session' } };

  const nonceHex = String(params.nonce || '');
  if (!/^[0-9a-fA-F]{8}$/.test(nonceHex)) return { error: { code: -1, message: 'nonce must be 8 hex chars' } };
  const nonce = nonceHex.toLowerCase();
  // A duplicate nonce is the cheapest way to claim credit twice. This in-memory
  // set exists to avoid paying 21.7 ms of RandomX for a replay; the UNIQUE
  // index in the store is what actually makes it true across a restart.
  if (job.seen.has(nonce)) return { error: { code: -1, message: 'duplicate share' } };
  job.seen.add(nonce);

  const header = Buffer.from(job.header);
  header.writeUInt32LE(parseInt(nonceHex, 16) >>> 0, 76);

  // NEVER trust a hash the miner sends. Recompute.
  const r = await validator.check(header.toString('hex'), job.target.toString('hex'));
  if (r.dead) { job.seen.delete(nonce); return { error: { code: -1, message: 'pool validator unavailable' } }; }
  if (r.err) return { error: { code: -1, message: 'malformed share' } };
  if (!r.ok) { m.rejected++; return { error: { code: -1, message: 'share above target' } }; }

  // RECORD BEFORE ACKNOWLEDGING. A share the pool cannot store is a share the
  // pool will not pay, and answering "OK" for it is the exact shape of the bug
  // this project has already paid for three times: an unwritable store is
  // UNKNOWN, and unknown must never become a definite yes.
  //
  // On failure the nonce comes back out of the seen-set so an honest retry can
  // land. That is safe because the retry is idempotent at the store: the same
  // (job_id, nonce) maps to the same row, so a write that actually succeeded
  // and merely lost its response cannot be counted twice.
  let stored;
  try {
    stored = await store.recordShare({
      at: Date.now(), miner: m.login, session: m.id, jobId: job.id,
      nonce, height: job.height, targetHex: job.target.toString('hex'),
    });
  } catch (e) {
    job.seen.delete(nonce);
    log(`SHARE NOT RECORDED for ${m.login}: ${e.message.slice(0, 140)}`);
    return { error: { code: -1, message: 'pool could not record the share; retry' } };
  }
  if (stored.fresh) { m.accepted++; m.windowShares++; state.accepted++; }

  // Does it also clear the NETWORK target? Then it is a block.
  const net = await validator.check(header.toString('hex'), job.netTarget.toString('hex'));
  if (net.ok) {
    const blockHex = serializeBlock(header, job.coinbase.witness, job.txs);
    const blockId = Buffer.from(sha256d(header)).reverse().toString('hex');
    log(`BLOCK CANDIDATE at height ${job.height} by ${m.login} -- ${blockId}`);
    try {
      const res = await cli(['submitblock', blockHex]);
      if (res === '') {
        log(`BLOCK ACCEPTED ${blockId}`);
        state.blocksFound++;
        await store.markShareIsBlock(stored.id).catch(() => {});
        await recordBlock(job, blockId, m, stored.id);
      } else {
        // Rejected by the node: no coins exist, so there is nothing to pay and
        // nothing is written. The share itself stays -- the work was real.
        log(`block REJECTED by node: ${res}`);
      }
    } catch (e) {
      // submitblock threw: we do NOT know whether the node took the block.
      // Record nothing. The maturity pass will find it if it was accepted --
      // by then getblockhash can answer, which a lost RPC response cannot.
      log(`submitblock threw (outcome UNKNOWN, computing no payouts): ${e.message.slice(0, 160)}`);
    }
    await refreshTemplate();
  }

  retune(m);
  return { result: { status: 'OK' } };
}

/**
 * A block landed. Work out what it owes, write it down, print it.
 *
 * Nothing here sends anything. The point of step 3 is that this arithmetic runs
 * against real shares for a week and gets checked by hand before it is wired to
 * a wallet.
 */
async function recordBlock(job, blockId, m, shareId) {
  const payout = job.payout;
  try {
    const coinbaseTxid = Buffer.from(job.coinbase.txid).reverse().toString('hex');
    const p = await store.recordBlockPaidByCoinbase({
      hash: blockId, height: job.height, value: job.value, finder: m.login,
      shareId, at: Date.now(), coinbaseTxid,
      outputs: payout ? payout.outputs : [],
      fee: payout ? payout.fee : 0n,
      windowWeight: payout ? payout.windowWeight : 0n,
    });
    log(`── height ${p.height} PAID BY ITS OWN COINBASE ──────────────`);
    log(`   reward ${pcn(p.value)} PCN   fee ${CFG.feeBasisPoints / 100}% = ${pcn(p.fee)}`);
    if (payout) {
      const W = payout.windowWeight || 1n;
      for (const o of payout.outputs) {
        const who = o.miner ? o.miner : '(pool fee + rounding)';
        const pct = o.miner ? ` (${(Number(o.weight * 10000n / W) / 100).toFixed(2)}%)` : '';
        log(`   ${who.padEnd(46)} ${pcn(o.value).padStart(16)} PCN${pct}`);
      }
    }
    log(`   coinbase ${coinbaseTxid}`);
    log(`   spendable by everyone after ${CFG.pplns.maturity} confirmations. Nothing to send.`);
  } catch (e) {
    // The block is on the chain and has already paid, whatever this says. A
    // failure here is a BOOKKEEPING failure, not a payment one -- which is the
    // point of paying from the coinbase, and worth saying so nobody goes
    // looking for a stuck payment that never existed.
    log(`LEDGER WRITE FAILED for height ${job.height}: ${e.message.slice(0, 200)}`);
    log('   the block itself already paid; this is a bookkeeping gap, not a missing payment');
  }
}

/**
 * Network numbers for the public API, refreshed on a slow timer.
 *
 * Kept SEPARATE from the template poll because a failure here must not affect
 * mining, and because an unreadable node has to leave the previous reading in
 * place with its timestamp rather than replace it with zeros. A directory
 * showing "0 H/s" reads as a dead pool.
 */
async function refreshNetworkStats() {
  try {
    const [info, hps] = await Promise.all([
      cliJson(['getblockchaininfo']),
      cli(['getnetworkhashps']).then(Number).catch(() => null),
    ]);
    let peers = null;
    try { peers = Number(await cli(['getconnectioncount'])); } catch { /* leave unknown */ }
    state.net = {
      chain: info.chain,
      blockHeight: info.blocks,
      networkDifficulty: info.difficulty,
      networkHashrate: hps,
      lastNetworkBlockTime: info.mediantime ? info.time * 1000 || null : null,
      connectedPeers: peers,
      readAt: Date.now(),
      readable: true,
    };
  } catch (e) {
    if (state.net) state.net.readable = false;   // keep the last good reading, flagged
    log(`network stats unreadable (${e.message.slice(0, 80)}) — serving the last known values`);
  }
}

/** Everything the public API reports. Measured, never invented. */
async function apiSnapshot() {
  const n = state.net || {};
  let poolHashrate = null, sharesPerSecond = null, totalBlocks = null,
    totalPaid = null, lastPoolBlockTime = null;
  try {
    // Pool hashrate straight from the ledger: share weight IS expected hashes,
    // so summing a window and dividing by its length is a direct measurement
    // rather than a model.
    const WINDOW_S = 600;
    const since = Date.now() - WINDOW_S * 1000;
    const rows = await store.shareSummary(since);
    const work = rows.reduce((a, r) => a + r.weight, 0n);
    const count = rows.reduce((a, r) => a + r.shares, 0);
    poolHashrate = Number(work) / WINDOW_S;
    sharesPerSecond = count / WINDOW_S;
    const st = await store.stats();
    totalBlocks = st.blocks;
    totalPaid = Number(st.computed) / 1e8;
    const [last] = await store.sql('SELECT IFNULL(MAX(found_at),0) FROM blocks;');
    lastPoolBlockTime = Number(last) || null;
  } catch (e) {
    log(`api snapshot: ledger unreadable (${e.message.slice(0, 80)})`);
  }
  return {
    connectedMiners: state.miners.size,
    poolHashrate, sharesPerSecond, totalBlocks, totalPaid, lastPoolBlockTime,
    chain: n.chain ?? null,
    blockHeight: n.blockHeight ?? null,
    networkDifficulty: n.networkDifficulty ?? null,
    networkHashrate: n.networkHashrate ?? null,
    lastNetworkBlockTime: n.lastNetworkBlockTime ?? null,
    connectedPeers: n.connectedPeers ?? null,
    nodeReadAt: n.readAt ?? null,
    nodeReadable: n.readable ?? false,
    open: CFG.allowlist.length === 0,
  };
}

/**
 * Maturity and orphans. A found block's coinbase cannot be spent for 100
 * blocks, so its payouts sit as PENDING for ~17 hours. Miners must be able to
 * see that wait, or they report it as a bug — and they are right to.
 */
async function evaluateMaturity() {
  let tip = null;
  try { tip = (await cliJson(['getblockchaininfo'])).blocks; }
  catch (e) { log(`maturity: tip unreadable (${e.message.slice(0, 80)}) — resolving nothing`); }
  const hashAt = async (h) => { try { return await cli(['getblockhash', String(h)]); } catch { return null; } };
  try {
    const r = await store.evaluateBlocks(tip, hashAt);
    if (r.skipped) return;
    for (const b of r.matured) log(`block ${b.height} MATURED — its payouts are now payable (still unsent)`);
    for (const b of r.orphaned) {
      log(`block ${b.height} ORPHANED${b.wasMature ? ' AFTER MATURING' : ''} — its payouts are void`);
    }
    for (const b of r.dematured) {
      log(`block ${b.height} fell back to PENDING at ${b.confirmations} confirmations (a reorg buried it less deeply)`);
    }
    for (const a of r.alarms) log(`*** ALARM *** block ${a.height} ${a.message}. Ledger NOT changed — decide by hand.`);
  } catch (e) {
    log(`maturity pass failed: ${e.message.slice(0, 140)}`);
  }
}

// ── server ──────────────────────────────────────────────────────────────────
const validator = new Validator(CFG.validator);

// If the store dies the pool can still validate shares — and must not accept
// them. Same rule as the validator: a pool that credits work it cannot record
// is worse than a pool that is down, because the miner is told it was paid for.
const store = new Store({
  path: CFG.db, sqlite3: CFG.sqlite3, feeBasisPoints: CFG.feeBasisPoints,
  windowMultiplier: CFG.pplns.windowMultiplier, maturity: CFG.pplns.maturity,
  log,
  onFatal: (e) => {
    state.storeDown = e.message;
    log(`FATAL store gone (${e.message}); refusing further shares`);
  },
});

const server = net.createServer((sock) => {
  sock.setEncoding('utf8');
  let buf = '';
  let miner = null;

  sock.on('data', async (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { send(sock, { id: null, error: { code: -1, message: 'bad json' } }); continue; }

      if (msg.method === 'login') {
        const login = String(msg.params?.login || '').trim();
        // FLEET-ONLY IS ENFORCED, NOT INTENDED. A stranger who finds the port
        // gets told plainly rather than silently accruing a balance nobody
        // planned to pay.
        if (CFG.allowlist.length && !CFG.allowlist.includes(login)) {
          log(`rejected login from ${sock.remoteAddress}: ${login.slice(0, 24)}… not on the allowlist`);
          send(sock, { id: msg.id, error: { code: -1, message: 'this pool is not open yet' } });
          sock.end();
          return;
        }
        try { addressToScript(login, CFG.hrp); }
        catch (e) { send(sock, { id: msg.id, error: { code: -1, message: `bad payout address: ${e.message}` } }); sock.end(); return; }

        miner = {
          id: randomBytes(8).toString('hex'),
          login, sock,
          extranonce: randomBytes(2).toString('hex'),
          jobCounter: 0,
          diffFactor: CFG.vardiff.startFactor,
          accepted: 0, rejected: 0,
          windowStart: Date.now(), windowShares: 0,
        };
        state.miners.set(miner.id, miner);
        log(`login ${login} from ${sock.remoteAddress} (session ${miner.id})`);
        send(sock, { id: msg.id, result: { id: miner.id, job: makeJob(miner), status: 'OK' } });

      } else if (msg.method === 'submit') {
        if (!miner) { send(sock, { id: msg.id, error: { code: -1, message: 'not logged in' } }); continue; }
        if (state.storeDown) {
          send(sock, { id: msg.id, error: { code: -1, message: 'pool ledger unavailable; not accepting shares' } });
          continue;
        }
        const out = await handleSubmit(miner, msg.params || {}, msg.id);
        send(sock, { id: msg.id, ...out });

      } else if (msg.method === 'getjob') {
        if (!miner) { send(sock, { id: msg.id, error: { code: -1, message: 'not logged in' } }); continue; }
        send(sock, { id: msg.id, result: makeJob(miner) });

      } else if (msg.method === 'keepalived') {
        send(sock, { id: msg.id, result: { status: 'KEEPALIVED' } });

      } else {
        send(sock, { id: msg.id ?? null, error: { code: -1, message: `unknown method ${msg.method}` } });
      }
    }
  });

  const bye = () => {
    if (miner) {
      log(`bye ${miner.login} (accepted ${miner.accepted}, rejected ${miner.rejected})`);
      state.miners.delete(miner.id);
    }
  };
  sock.on('close', bye);
  sock.on('error', bye);
});

// ── start ───────────────────────────────────────────────────────────────────
(async () => {
  await validator.ready;
  log('validator warm');
  await store.open();
  state.script = addressToScript(CFG.poolAddress, CFG.hrp);
  log(`pool pays ${CFG.poolAddress}, fee ${CFG.feeBasisPoints / 100}% off the block reward`);
  log(`PPLNS window N = ${CFG.pplns.windowMultiplier}x one block's work; maturity ${CFG.pplns.maturity} blocks`);
  log('PAYOUTS ARE MADE BY THE COINBASE: each block pays its miners directly.');
  log('This pool holds no wallet, no private key, and has no send path.');
  log(`allowlist: ${CFG.allowlist.length ? CFG.allowlist.length + ' address(es)' : 'OPEN -- anyone may mine'}`);
  await refreshTemplate();
  if (!state.tpl) { log('FATAL no template at startup'); process.exit(1); }
  setInterval(refreshTemplate, CFG.templatePollMs);
  setInterval(evaluateMaturity, CFG.maturityPollMs || 60000);
  await evaluateMaturity();
  await refreshNetworkStats();
  setInterval(refreshNetworkStats, CFG.networkStatsPollMs || 30000);

  // The public API. Bound to loopback on purpose: Caddy terminates TLS and
  // proxies in, so this process never parses bytes off the open internet.
  if (CFG.apiPort) {
    const api = createApi({ cfg: CFG, snapshot: apiSnapshot, log });
    api.on('error', (e) => log(`api server error: ${e.message}`));
    api.listen(CFG.apiPort, CFG.apiBind || '127.0.0.1',
      () => log(`api on ${CFG.apiBind || '127.0.0.1'}:${CFG.apiPort} (/api/pools)`));
  }
  server.listen(CFG.port, CFG.bind, () => log(`listening on ${CFG.bind}:${CFG.port}`));
})();

// Status on demand, for the operator and for tests.
process.on('SIGUSR2', async () => {
  const s = await store.stats().catch(() => null);
  if (!s) { log(`miners=${state.miners.size} store=UNREADABLE`); return; }
  log(`miners=${state.miners.size} shares=${s.shares} blocks=${s.blocks} `
    + `(pending ${s.pending}, mature ${s.mature}, orphaned ${s.orphaned}) computed=${pcn(s.computed)} PCN, sent 0`);
});
