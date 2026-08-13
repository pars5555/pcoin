// PCoin mining pool — step 2: jobs and shares. NO PAYOUTS YET.
//
// Miners connect, get work, submit shares, and the pool submits real blocks.
// Shares are recorded but nothing is paid: payouts are step 4, deliberately
// after a week of reconciling recorded shares by hand (see DESIGN.md).
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
import fs from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  addressToScript, buildCoinbase, merkleRoot, buildHeader,
  serializeBlock, bitsToTarget, scaleTarget, sha256d,
} from './block.mjs';

// ── config ──────────────────────────────────────────────────────────────────
const cfgPath = process.argv.includes('--config')
  ? process.argv[process.argv.indexOf('--config') + 1]
  : new URL('./pool.config.json', import.meta.url).pathname;
const CFG = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

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
  shares: [],           // step 2: recorded, not paid
  blocks: [],
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
    const ratio = rate / want;
    if (ratio > 1.5 || ratio < 0.67) {
      const next = Math.max(CFG.vardiff.minFactor,
                   Math.min(CFG.vardiff.maxFactor, Math.round(m.diffFactor * ratio)));
      if (next !== m.diffFactor) {
        log(`vardiff ${m.login.slice(0, 12)}… ${m.diffFactor} -> ${next} (${rate.toFixed(3)}/s)`);
        m.diffFactor = next;
      }
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
  // A duplicate nonce is the cheapest way to claim credit twice.
  if (job.seen.has(nonceHex.toLowerCase())) return { error: { code: -1, message: 'duplicate share' } };
  job.seen.add(nonceHex.toLowerCase());

  const header = Buffer.from(job.header);
  header.writeUInt32LE(parseInt(nonceHex, 16) >>> 0, 76);

  // NEVER trust a hash the miner sends. Recompute.
  const r = await validator.check(header.toString('hex'), job.target.toString('hex'));
  if (r.dead) return { error: { code: -1, message: 'pool validator unavailable' } };
  if (r.err) return { error: { code: -1, message: 'malformed share' } };
  if (!r.ok) { m.rejected++; return { error: { code: -1, message: 'share above target' } }; }

  m.accepted++; m.windowShares++;
  state.shares.push({
    at: Date.now(), login: m.login, session: m.id,
    job: job.id, height: job.height, diffFactor: m.diffFactor, hash: r.hash,
  });

  // Does it also clear the NETWORK target? Then it is a block.
  const net = await validator.check(header.toString('hex'), state.netTarget.toString('hex'));
  if (net.ok) {
    const blockHex = serializeBlock(header, job.coinbase.witness, job.txs);
    const blockId = Buffer.from(sha256d(header)).reverse().toString('hex');
    log(`BLOCK CANDIDATE at height ${job.height} by ${m.login} -- ${blockId}`);
    try {
      const res = await cli(['submitblock', blockHex]);
      if (res === '') {
        log(`BLOCK ACCEPTED ${blockId}`);
        state.blocks.push({ at: Date.now(), height: job.height, id: blockId, login: m.login });
      } else {
        log(`block REJECTED by node: ${res}`);
      }
    } catch (e) {
      log(`submitblock threw: ${e.message.slice(0, 160)}`);
    }
    await refreshTemplate();
  }

  retune(m);
  return { result: { status: 'OK' } };
}

// ── server ──────────────────────────────────────────────────────────────────
const validator = new Validator(CFG.validator);

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
  state.script = addressToScript(CFG.poolAddress, CFG.hrp);
  log(`pool pays ${CFG.poolAddress}, fee ${CFG.feePercent}%`);
  log(`allowlist: ${CFG.allowlist.length ? CFG.allowlist.length + ' address(es)' : 'OPEN -- anyone may mine'}`);
  await refreshTemplate();
  if (!state.tpl) { log('FATAL no template at startup'); process.exit(1); }
  setInterval(refreshTemplate, CFG.templatePollMs);
  server.listen(CFG.port, CFG.bind, () => log(`listening on ${CFG.bind}:${CFG.port}`));
})();

// Status on demand, for the operator and for tests.
process.on('SIGUSR2', () => {
  log(`miners=${state.miners.size} shares=${state.shares.length} blocks=${state.blocks.length}`);
});
