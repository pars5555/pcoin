// Prove a nonce counts exactly once.
//
// The end-to-end run did NOT prove this: at low share difficulty every share
// was also a block, which moved the tip and cleared the job cache, so the
// replay was refused as "stale" and the duplicate check was never reached. A
// rejection for the wrong reason looks identical in a log to the right one.
//
// KNOWN LIMITATION -- this test cannot pass on regtest, and that is a fact
// about regtest, not about the pool. At regtest difficulty the network target
// is 7fffff00..., so roughly HALF of all hashes are valid blocks. A share is
// therefore almost always also a block, which moves the tip and clears the job
// cache before the replay lands. No share difficulty fixes this: the share
// target is already capped at 2^256-1 and every hash clears it.
//
// Run this against a chain whose difficulty is high enough for a share to not
// be a block -- testnet, or mainnet with a large factor. Until then the
// duplicate-nonce path (job.seen in pool.mjs) is UNPROVEN. It is three lines
// and obviously correct on reading, which is exactly the kind of thing that
// turns out to be wrong, so do not mark it done on inspection.
import net from 'node:net';
import { spawn } from 'node:child_process';

const login = process.argv[2];
const PORT = Number(process.argv[3] || 3333);

const v = spawn('./build/validate', ['--serve'], { stdio: ['pipe', 'pipe', 'pipe'] });
const q = []; let vb = '';
v.stdout.on('data', (d) => { vb += d; let i; while ((i = vb.indexOf('\n')) >= 0) { const l = vb.slice(0, i); vb = vb.slice(i + 1); (q.shift() || (() => {}))(l); } });
await new Promise((r) => v.stderr.on('data', (d) => { if (d.toString().includes('ready')) r(); }));
const chk = (h, t) => new Promise((r) => { q.push((l) => r(l.split(' ')[0] === 'ok')); v.stdin.write(`${h} ${t}\n`); });

const s = net.createConnection({ host: '127.0.0.1', port: PORT }); s.setEncoding('utf8');
let id = 0; const pend = new Map(); let buf = '';
s.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!l) continue; const m = JSON.parse(l); if (m.method === 'job') continue; const w = pend.get(m.id); if (w) { pend.delete(m.id); w(m); } } });
const rpc = (method, params) => new Promise((r) => { const i = ++id; pend.set(i, r); s.write(JSON.stringify({ id: i, method, params }) + '\n'); });

await new Promise((r) => s.once('connect', r));
const lg = await rpc('login', { login, pass: 'x' });
if (lg.error) { console.log('login refused: ' + lg.error.message); process.exit(1); }
const sess = lg.result.id, job = lg.result.job;
console.log(`  job ${job.job_id}  target ${job.target.slice(0, 12)}…`);

let found = null;
for (let n = 0; n < 6000 && found === null; n++) {
  const h = Buffer.from(job.blob, 'hex'); h.writeUInt32LE(n, 76);
  if (await chk(h.toString('hex'), job.target)) found = n;
}
if (found === null) { console.log('  no share found in 6000 nonces'); process.exit(1); }
const nh = found.toString(16).padStart(8, '0');

const a = await rpc('submit', { id: sess, job_id: job.job_id, nonce: nh });
const b = await rpc('submit', { id: sess, job_id: job.job_id, nonce: nh });
const c = await rpc('submit', { id: sess, job_id: job.job_id, nonce: nh.toUpperCase() });

console.log(`  1st submit      : ${a.result ? 'ACCEPTED' : 'rejected: ' + a.error.message}`);
console.log(`  2nd same nonce  : ${b.result ? 'ACCEPTED (BAD)' : 'rejected: ' + b.error.message}`);
console.log(`  3rd UPPERCASED  : ${c.result ? 'ACCEPTED (BAD)' : 'rejected: ' + c.error.message}`);
const dupMsg = (b.error?.message || '') + (c.error?.message || '');
const ok = a.result && b.error && c.error && dupMsg.includes('duplicate');
console.log(ok ? '  PASS: counted once, and case does not launder it'
               : '  FAIL: ' + (dupMsg.includes('duplicate') ? 'first submit did not land' : 'rejected for the WRONG reason -- dedup not reached'));
v.kill(); s.end(); process.exit(ok ? 0 : 1);
