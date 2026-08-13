// A miner just real enough to prove the pool works end to end.
//
//   node testminer.mjs <host> <port> <payout address> [seconds]
//
// It speaks the same protocol a real miner will, grinds nonces through the C++
// validator (slow, but this is a test, not a miner), and reports what the pool
// said. It deliberately also submits things a real miner would not -- a
// duplicate nonce, a bogus job id -- because the pool's rejections are as
// important as its acceptances and are the half nobody tests.

import net from 'node:net';
import { spawn } from 'node:child_process';

const [host, port, login, secsArg] = process.argv.slice(2);
const SECS = Number(secsArg || 30);
if (!host || !port || !login) {
  console.error('usage: node testminer.mjs <host> <port> <payout address> [seconds]');
  process.exit(2);
}

const VALIDATOR = process.env.VALIDATOR || new URL('./build/validate', import.meta.url).pathname;

class V {
  constructor(bin) {
    this.p = spawn(bin, ['--serve'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.q = []; let buf = '';
    this.p.stdout.on('data', (d) => {
      buf += d.toString(); let i;
      while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); (this.q.shift() || (() => {}))(l); }
    });
    this.ready = new Promise((r) => this.p.stderr.on('data', (d) => { if (d.toString().includes('ready')) r(); }));
  }
  check(h, t) { return new Promise((res) => { this.q.push((l) => res(l.split(' ')[0] === 'ok')); this.p.stdin.write(`${h} ${t}\n`); }); }
  kill() { this.p.kill(); }
}

const v = new V(VALIDATOR);
await v.ready;

const sock = net.createConnection({ host, port: Number(port) });
sock.setEncoding('utf8');
let id = 0, session = null, job = null;
const pending = new Map();
const stats = { accepted: 0, rejected: 0, reasons: new Map() };

const rpc = (method, params) => new Promise((res) => {
  const myId = ++id;
  pending.set(myId, res);
  sock.write(JSON.stringify({ id: myId, method, params }) + '\n');
});

let buf = '';
sock.on('data', (d) => {
  buf += d; let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    if (m.method === 'job') { job = m.params; console.log(`  <- new job ${job.job_id} height ${job.height}`); continue; }
    const w = pending.get(m.id); if (w) { pending.delete(m.id); w(m); }
  }
});

await new Promise((r) => sock.once('connect', r));
const lg = await rpc('login', { login, pass: 'x' });
if (lg.error) { console.log(`  login refused: ${lg.error.message}`); v.kill(); sock.end(); process.exit(1); }
session = lg.result.id; job = lg.result.job;
console.log(`  logged in, session ${session}`);
console.log(`  first job ${job.job_id}, height ${job.height}, target ${job.target.slice(0, 16)}…`);

const note = (r) => {
  if (r.result?.status === 'OK') stats.accepted++;
  else { stats.rejected++; const k = r.error?.message || '?'; stats.reasons.set(k, (stats.reasons.get(k) || 0) + 1); }
};

// ── the deliberately-wrong submissions, first ───────────────────────────────
console.log('  -- probing rejections a real miner would never send --');
note(await rpc('submit', { id: session, job_id: 'nosuchjob', nonce: '00000000' }));
console.log(`     bogus job id      -> ${stats.rejected ? 'rejected' : 'ACCEPTED (bad)'}`);
const before = stats.rejected;
note(await rpc('submit', { id: session, job_id: job.job_id, nonce: 'zzzz' }));
console.log(`     non-hex nonce     -> ${stats.rejected > before ? 'rejected' : 'ACCEPTED (bad)'}`);

// ── grind ───────────────────────────────────────────────────────────────────
console.log(`  -- grinding for ${SECS}s --`);
const deadline = Date.now() + SECS * 1000;
let tried = 0, firstAccepted = null;
while (Date.now() < deadline) {
  const j = job;
  const nonce = (Math.floor(Math.random() * 0xffffffff) >>> 0);
  const hdr = Buffer.from(j.blob, 'hex');
  hdr.writeUInt32LE(nonce, 76);
  tried++;
  if (await v.check(hdr.toString('hex'), j.target)) {
    const nh = nonce.toString(16).padStart(8, '0');
    const r = await rpc('submit', { id: session, job_id: j.job_id, nonce: nh });
    note(r);
    if (r.result) {
      if (!firstAccepted) firstAccepted = nh;
      // Immediately replay it -- a pool that credits the same nonce twice is
      // paying for one piece of work repeatedly.
      const dup = await rpc('submit', { id: session, job_id: j.job_id, nonce: nh });
      console.log(`     share ok; replayed -> ${dup.error ? 'rejected (' + dup.error.message + ')' : 'ACCEPTED AGAIN (BAD)'}`);
    }
  }
}

console.log('');
console.log(`  hashed ${tried}, accepted ${stats.accepted}, rejected ${stats.rejected}`);
for (const [k, n] of stats.reasons) console.log(`     ${n}x ${k}`);
v.kill(); sock.end();
process.exit(stats.accepted > 0 ? 0 : 1);
