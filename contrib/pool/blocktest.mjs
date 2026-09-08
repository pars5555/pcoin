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

// How to reach the node. Defaults to the docker container this was written
// against, but CLI_CMD lets it run anywhere a bitcoin-cli exists -- a host with
// a plain regtest datadir, for instance. Hardcoding one deployment shape is how
// a test ends up unrunnable on the machine that actually needs it.
//
//   CLI_CMD="/opt/pcoin/bin/bitcoin-cli -regtest -datadir=/var/lib/pcoin-regtest"
const CLI_CMD = process.env.CLI_CMD
  ? process.env.CLI_CMD.split(/\s+/)
  : ['sudo', 'docker', 'exec', CONTAINER, 'bitcoin-cli', '-regtest'];

const cli = (...args) => {
  const out = execFileSync(CLI_CMD[0], [...CLI_CMD.slice(1), ...args],
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
  const addr = cli('getnewaddress', '', 'bech32');
  console.log(`  paying ${addr}`);

  // Put a REAL fee-paying transaction in the mempool BEFORE asking for a
  // template.
  //
  // Without this the mempool is empty on a fresh regtest chain, every template
  // carries zero transactions, and the entire multi-transaction path goes
  // untested: varint(2) instead of varint(1), the extra transaction bytes after
  // the coinbase, a coinbasevalue ABOVE the bare subsidy, and a witness
  // commitment computed over a non-empty transaction set.
  //
  // That is not hypothetical. On 2026-09-08 the live pool had never once been
  // asked to build a block containing a fee -- the chain carried nothing but
  // coinbases -- and the first one that arrived crashed it. This test passed
  // throughout, because it was proving the same empty-block case the pool had
  // already been proving in production every ten minutes.
  if (Number(cli('getbalance')) <= 1) {
    console.log('  maturing coins to spend (101 blocks)...');
    cli('generatetoaddress', '101', addr);
  }
  const feeTxid = cli('sendtoaddress', cli('getnewaddress', '', 'bech32'), '1.0');
  console.log(`  seeded a fee-paying tx: ${feeTxid.slice(0, 16)}…`);

  // Height is read HERE, after the maturity blocks and the fee-paying send --
  // not before them. Reading it first made the success check compare against a
  // height 101 blocks stale, and the test reported REJECTED on a block the node
  // had in fact accepted.
  const before = Number(cli('getblockcount'));

  const tpl = cliJson('getblocktemplate', '{"rules":["segwit"]}');

  // Refuse to "pass" on a template that proves nothing. A test that silently
  // exercises the trivial case is worse than no test: it reports green.
  const txs = tpl.transactions || [];
  if (!txs.length) {
    console.log('  ABORT: the template carries no transactions, so this run would');
    console.log('  prove only the empty-block case that already works. Check the mempool.');
    process.exit(1);
  }
  const subsidy = txs.reduce((s2, t) => s2 - (t.fee || 0), tpl.coinbasevalue);
  console.log(`  template: ${txs.length} tx, coinbasevalue ${tpl.coinbasevalue} `
    + `(subsidy ${subsidy} + ${tpl.coinbasevalue - subsidy} in fees)`);
  if (tpl.coinbasevalue <= subsidy) {
    console.log('  ABORT: coinbasevalue is not above the subsidy; no fee is being tested.');
    process.exit(1);
  }
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
  console.log(`  block is ${blockHex.length / 2} bytes, ${1 + txs.length} transaction(s)`);

  // The verdict. submitblock returns empty on success, or a reason.
  const res = cli('submitblock', blockHex);
  const after = Number(cli('getblockcount'));
  const sha = Buffer.from(sha256d(solved.header)).reverse().toString('hex');

  console.log('');
  if (res === '' && after === before + 1) {
    console.log(`  ACCEPTED -- height ${before} -> ${after}`);
    console.log(`  block id ${sha}`);
    console.log(`  node agrees: ${cli('getblockhash', String(after)) === sha ? 'the tip IS our block' : 'MISMATCH'}`);
    // The point of the whole exercise: the fee-paying transaction is IN the
    // block we built, and the node kept it.
    const mined = cliJson('getblock', sha);
    const carried = (mined.tx || []).includes(feeTxid);
    console.log(`  fee tx in the accepted block: ${carried ? 'YES' : 'NO -- it was dropped'}`);
    console.log(`  mempool now: ${cliJson('getmempoolinfo').size} tx (0 = it was mined, not orphaned)`);
    process.exit(carried ? 0 : 1);
  }
  console.log(`  REJECTED: ${res || '(empty, but height did not move)'}`);
  console.log(`  height ${before} -> ${after}`);
  process.exit(1);
};

main().catch((e) => { console.error('  ERROR', e.message); process.exit(2); });
