// Prove block.mjs by getting a real node to ACCEPT a block we assembled.
//
// No unit test can substitute for this. A header one byte out of place still
// hashes and still looks like work; the only authority on whether the
// serialization is right is a node's own acceptance. Run against regtest.
//
//   node blocktest.mjs
//
// It mines by asking the C++ validator (serve mode) whether a candidate nonce
// beats the target -- the same code path the pool will use for shares, so this
// exercises the validator pipe as well as the assembly.

import { spawn, execFileSync } from 'node:child_process';
import {
  addressToScript, buildCoinbase, merkleRoot, buildHeader,
  serializeBlock, bitsToTarget, sha256d,
} from './block.mjs';

const CONTAINER = process.env.CONTAINER || 'pcoin-regtest';
const VALIDATOR = process.env.VALIDATOR || new URL('./build/validate', import.meta.url).pathname;

const cli = (...args) => {
  const out = execFileSync('sudo', ['docker', 'exec', CONTAINER, 'bitcoin-cli', '-regtest', ...args],
                           { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return out.trim();
};
const cliJson = (...args) => JSON.parse(cli(...args));

// ── the validator, kept warm on a pipe ──────────────────────────────────────
class Validator {
  constructor(bin) {
    this.p = spawn(bin, ['--serve'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.q = [];
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
    this.ready = new Promise((res) => {
      this.p.stderr.once('data', (d) => { if (d.toString().includes('ready')) res(); });
    });
  }
  check(headerHex, targetHex) {
    return new Promise((res) => {
      this.q.push((line) => {
        const [verdict, hash] = line.split(' ');
        res({ ok: verdict === 'ok', verdict, hash });
      });
      this.p.stdin.write(`${headerHex} ${targetHex}\n`);
    });
  }
  close() { this.p.stdin.end(); this.p.kill(); }
}

const main = async () => {
  const before = Number(cli('getblockcount'));
  const addr = cli('getnewaddress', '', 'bech32');
  console.log(`  height ${before}, paying ${addr}`);

  const tpl = cliJson('getblocktemplate', '{"rules":["segwit"]}');
  const script = addressToScript(addr, process.env.HRP || 'pcrt');  // regtest
  console.log(`  scriptPubKey ${script.toString('hex')}`);

  const cb = buildCoinbase({
    height: tpl.height,
    value: tpl.coinbasevalue,
    script,
    extranonce: '00000001',
    witnessCommitment: tpl.default_witness_commitment,
  });

  const txids = [cb.txid, ...(tpl.transactions || []).map((t) => Buffer.from(t.txid, 'hex').reverse())];
  const root = merkleRoot(txids);
  const target = bitsToTarget(tpl.bits);
  console.log(`  merkle ${Buffer.from(root).reverse().toString('hex')}`);
  console.log(`  target ${target.toString('hex')}`);

  const v = new Validator(VALIDATOR);
  await v.ready;

  let solved = null;
  const t0 = Date.now();
  for (let nonce = 0; nonce < 20000; nonce++) {
    const header = buildHeader({
      version: tpl.version, prevhash: tpl.previousblockhash,
      merkle: root, time: tpl.curtime, bits: tpl.bits, nonce,
    });
    const r = await v.check(header.toString('hex'), target.toString('hex'));
    if (r.ok) { solved = { nonce, header, hash: r.hash }; break; }
  }
  v.close();

  if (!solved) { console.log('  no solution found -- unexpected at regtest difficulty'); process.exit(1); }
  console.log(`  solved at nonce ${solved.nonce} in ${Date.now() - t0} ms`);
  console.log(`  randomx  ${solved.hash}`);

  const blockHex = serializeBlock(solved.header, cb.witness,
                                  (tpl.transactions || []).map((t) => t.data));
  console.log(`  block is ${blockHex.length / 2} bytes`);

  // The verdict. submitblock returns empty on success, or a reason.
  const res = cli('submitblock', blockHex);
  const after = Number(cli('getblockcount'));
  const sha = Buffer.from(sha256d(solved.header)).reverse().toString('hex');

  console.log('');
  if (res === '' && after === before + 1) {
    console.log(`  ACCEPTED -- height ${before} -> ${after}`);
    console.log(`  block id ${sha}`);
    console.log(`  node agrees: ${cli('getblockhash', String(after)) === sha ? 'the tip IS our block' : 'MISMATCH'}`);
    process.exit(0);
  }
  console.log(`  REJECTED: ${res || '(empty, but height did not move)'}`);
  console.log(`  height ${before} -> ${after}`);
  process.exit(1);
};

main().catch((e) => { console.error('  ERROR', e.message); process.exit(2); });
