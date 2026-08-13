// Prove a block whose coinbase pays SEVERAL miners is accepted by a node.
//
//   node coinbasetest.mjs "<bitcoin-cli> <args...>"
//
// This is the load-bearing test for coinbase payouts. The money math is checked
// offline in storetest.mjs, but arithmetic that a node rejects pays nobody: a
// coinbase that is one satoshi over, or whose outputs are malformed, still
// hashes, still looks like work, and is thrown away at submitblock long after
// the miner was told the share was good.
//
// So the only evidence worth anything is a node saying yes -- and then the
// block, read back off the chain, paying the exact addresses and amounts the
// ledger says it should.

import { execFile } from 'node:child_process';
import {
  addressToScript, buildCoinbase, merkleRoot, buildHeader, serializeBlock,
  bitsToTarget, sha256d,
} from './block.mjs';
import { buildPayoutOutputs, pcn } from './store.mjs';

const CLI = (process.argv[2] || '').split(' ').filter(Boolean);
if (!CLI.length) {
  console.error('usage: node coinbasetest.mjs "<bitcoin-cli> -regtest -datadir=..."');
  process.exit(2);
}
const HRP = process.argv[3] || 'pcrt';

let pass = 0, fail = 0;
const ok = (c, n, d = '') => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${d ? '  --  ' + d : ''}`); } };

const cli = (args) => new Promise((res, rej) => {
  execFile(CLI[0], [...CLI.slice(1), ...args], { maxBuffer: 64 << 20 },
    (e, out, err) => e ? rej(new Error((err || e.message).trim())) : res(out.trim()));
});
const j = async (args) => JSON.parse(await cli(args));

// Three miners with real addresses on this node.
//
// getnewaddress is WALLET-SCOPED and this node may have several loaded, so the
// wallet is named explicitly on every wallet call. Leaving it off does not
// fail safely -- with two wallets loaded a wallet-scoped RPC answers
// confidently about whichever one you did not mean (CLAUDE.md 7.10).
await cli(['createwallet', 'cbtest']).catch(() => {});
const W = ['-rpcwallet=cbtest'];
const miners = [];
for (let i = 0; i < 3; i++) miners.push(await cli([...W, 'getnewaddress', '', 'bech32']));
const poolAddr = await cli([...W, 'getnewaddress', '', 'bech32']);
console.log(`  miners: ${miners.map((m) => m.slice(0, 14) + '…').join(' ')}`);

// Weights chosen so the split has a remainder and no two shares are equal.
const entries = [
  { miner: miners[0], weight: 7n },
  { miner: miners[1], weight: 11n },
  { miner: miners[2], weight: 13n },
];

const tpl = await j(['getblocktemplate', '{"rules":["segwit"]}']);
const split = buildPayoutOutputs({
  value: tpl.coinbasevalue,
  feeBasisPoints: 200,
  entries,
  scriptOf: (a) => addressToScript(a, HRP),
  poolScript: addressToScript(poolAddr, HRP),
});

console.log(`\n  coinbase value ${pcn(tpl.coinbasevalue)} PCN at height ${tpl.height}`);
for (const o of split.outputs) {
  console.log(`    ${(o.miner || '(pool)').padEnd(46)} ${pcn(o.value).padStart(16)} PCN`);
}

const total = split.outputs.reduce((s, o) => s + o.value, 0n);
ok(total === BigInt(tpl.coinbasevalue), 'the outputs sum to the coinbase value exactly',
  `${total} vs ${tpl.coinbasevalue}`);
ok(split.outputs.length === 4, 'three miners plus the pool', `${split.outputs.length} outputs`);

// ── build it and get a node to accept it ────────────────────────────────────
const cb = buildCoinbase({
  height: tpl.height,
  value: tpl.coinbasevalue,
  pays: split.outputs,
  extranonce: 'beef0001',
  witnessCommitment: tpl.default_witness_commitment,
});
const txids = [cb.txid, ...(tpl.transactions || []).map((x) => Buffer.from(x.txid, 'hex').reverse())];
const root = merkleRoot(txids);
const target = BigInt('0x' + bitsToTarget(tpl.bits).toString('hex'));

const header = buildHeader({
  version: tpl.version, prevhash: tpl.previousblockhash,
  merkle: root, time: tpl.curtime, bits: tpl.bits, nonce: 0,
});

// Grind. On regtest this takes a handful of hashes.
const { spawn } = await import('node:child_process');
const v = spawn('./build/validate', ['--serve'], { stdio: ['pipe', 'pipe', 'pipe'] });
const q = []; let vb = '';
v.stdout.on('data', (d) => { vb += d; let i; while ((i = vb.indexOf('\n')) >= 0) { const l = vb.slice(0, i); vb = vb.slice(i + 1); (q.shift() || (() => {}))(l); } });
await new Promise((r) => v.stderr.on('data', (d) => { if (d.toString().includes('ready')) r(); }));
const chk = (h, t) => new Promise((r) => { q.push((l) => r(l.split(' ')[0] === 'ok')); v.stdin.write(`${h} ${t}\n`); });

const targetHex = target.toString(16).padStart(64, '0');
let solved = null;
for (let n = 0; n < 200000 && solved === null; n++) {
  header.writeUInt32LE(n, 76);
  if (await chk(header.toString('hex'), targetHex)) solved = n;
}
v.kill();
ok(solved !== null, 'found a nonce for the multi-output block', solved === null ? 'none in 200k' : `nonce ${solved}`);

header.writeUInt32LE(solved, 76);
const blockHex = serializeBlock(header, cb.witness, (tpl.transactions || []).map((x) => x.data));
const blockId = Buffer.from(sha256d(header)).reverse().toString('hex');

let res;
try { res = await cli(['submitblock', blockHex]); } catch (e) { res = 'threw: ' + e.message; }
ok(res === '', 'THE NODE ACCEPTED A BLOCK PAYING THREE MINERS', res || '(empty = accepted)');

// ── and it pays what the ledger says ────────────────────────────────────────
if (res === '') {
  const blk = await j(['getblock', blockId, '2']);
  const cbtx = blk.tx[0];
  const actual = new Map();
  for (const o of cbtx.vout) {
    const a = o.scriptPubKey?.address;
    if (a) actual.set(a, BigInt(Math.round(o.value * 1e8)));
  }
  let mismatched = 0;
  for (const o of split.outputs) {
    if (!o.miner) continue;
    if (actual.get(o.miner) !== o.value) mismatched++;
  }
  ok(mismatched === 0, 'every miner is paid the exact amount, read back off the chain',
    `${mismatched} mismatched`);
  ok(actual.size >= 4, 'the on-chain coinbase really has one output per miner plus the pool',
    `${actual.size} addressed outputs`);

  // A coinbase is unspendable for 100 blocks. Miners must see that, and it is a
  // consensus rule rather than anything the pool chose.
  ok(cbtx.vout.some((o) => o.scriptPubKey?.type === 'nulldata'),
    'the witness commitment survived the extra outputs');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
