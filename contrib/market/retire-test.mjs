#!/usr/bin/env node
// Tests for retire.mjs.   node retire-test.mjs
//
// Runs against a fake node and a fake pool — no database, no chain, no network.
// Deliberately: ladder-test.mjs drives the real ladder and has twice perturbed
// the live posted price, and retirement is the mechanism that MOVES that price.
//
// WHAT THIS PINS DOWN: the daily cap DEFERS, it does not DISCARD.
//
// The original code retired whatever the cap allowed and recorded the output
// anyway, with pcn_retired set to the partial figure. Because retirements are
// keyed UNIQUE (txid, vout), every later scan then skipped that output as
// already-counted — so the shortfall was never retired by anything, ever. A day
// with more than dailyCap/ratio of spending (20,000 PCN at the live settings)
// silently threw the excess away, and the ladder never reflected that usage.
//
// The fix leans entirely on machinery that already existed: outputs handled
// before the cap are protected by the UNIQUE key, and the cursor only advances
// at the end of a fully-processed block. So stopping mid-block costs a re-read
// of a few blocks and nothing else.

import { makeRetire } from './retire.mjs';

const rungs = [{ rung_no: 0, qty_total: 100000, qty_sold: 0, qty_reserved: 0, qty_retired: 0 }];
let cursorH = 100;
const claimed = [];                       // stands in for the retirements table
const settings = {
  vals: { retireSpentCoins: true, retireRatioPct: 10, retireMinConf: 0,
          retireDailyCapPcn: 25, retireSystems: 'checker' },
  get(k) { return this.vals[k]; },
};

// Three blocks, one 100 PCN payment each -> 10 PCN of retirement each at 10%.
// The cap is 25, so exactly two fit and the third must be held over.
const BLOCKS = { 101: 'aaa', 102: 'bbb', 103: 'ccc' };
const node = { rpc: async (m, p) => {
  if (m === 'getblockcount') return 103;
  if (m === 'getblockhash')  return 'h' + p[0];
  if (m === 'getblock') {
    const h = Number(String(p[0]).slice(1));
    return { tx: [{ txid: BLOCKS[h], vout: [{ value: 100, scriptPubKey: { address: 'PAY' } }] }] };
  }
}};

const conn = {
  query: async (sql, a = []) => {
    if (/UPDATE ladder_rungs/.test(sql)) { rungs[0].qty_retired += Number(a[0]); return [{}]; }
    if (/FROM ladder_rungs/.test(sql)) return [rungs];
    if (/INSERT INTO retirements/.test(sql)) {
      const key = a[0] + ':' + a[1];
      if (claimed.find(r => r.key === key)) { const e = new Error('dup'); e.code = 'ER_DUP_ENTRY'; throw e; }
      claimed.push({ key, txid: a[0], height: a[2], got: 0 }); return [{}];
    }
    if (/UPDATE retirements SET pcn_retired/.test(sql)) {
      const r = claimed.find(x => x.txid === a[1]); if (r) r.got = Number(a[0]); return [{}];
    }
    if (/INSERT INTO chain_scan/.test(sql)) { cursorH = Number(a[0]); return [{}]; }
    return [[]];
  },
  beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {},
};
const pool = {
  getConnection: async () => conn,
  query: async (sql, a = []) => {
    if (/FROM chain_scan/.test(sql)) return [[{ height: cursorH }]];
    if (/FROM spend_addresses/.test(sql)) return [a[0] === 'PAY' ? [{ system: 'checker' }] : []];
    if (/SUM\(pcn_retired\).*UTC_DATE/.test(sql)) return [[{ t: claimed.reduce((s, r) => s + r.got, 0) }]];
    if (/INSERT INTO chain_scan/.test(sql)) { cursorH = Number(a[0]); return [{}]; }
    return [[]];
  },
};

const msgs = [];
const R = makeRetire({ pool, node, settings, notify: async m => { msgs.push(m); },
                       log: { log() {}, warn() {}, error() {} } });

let pass = 0, fail = 0;
const ok = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}\n         ${d}`); }
};

console.log('\nthe cap is reached mid-scan');
const r1 = await R.scan();
ok('retires only what fits (2 x 10)', Math.abs(r1.retired - 20) < 1e-9, `got ${r1.retired}`);
ok('reports capped', r1.capped === true);
ok('cursor stops at the last COMPLETE block', cursorH === 102, `cursor ${cursorH}`);
ok('the over-cap output is NOT claimed', claimed.length === 2, `claimed ${claimed.length}`);
ok('operator is told it is deferred, not lost',
   /deferred, not lost|held, not discarded/i.test(msgs.join('')), msgs.join(' ').slice(0, 140));

console.log('\nrunning again the same day changes nothing');
const r2 = await R.scan();
ok('nothing further retired', Math.abs(r2.retired ?? 0) < 1e-9, JSON.stringify(r2));
ok('the held output is still unclaimed', claimed.length === 2, `claimed ${claimed.length}`);

console.log('\nthe next day, the backlog is retired IN FULL');
claimed.forEach(r => { r.got = 0; });     // yesterday's total no longer counts toward today
const r3 = await R.scan();
ok('the deferred payment retires', Math.abs(r3.retired - 10) < 1e-9, `got ${r3.retired}`);
ok('cursor advances past it', cursorH === 103, `cursor ${cursorH}`);
ok('nothing double-counted', claimed.length === 3, `claimed ${claimed.length}`);
ok('30 PCN retired in total, not 20', Math.abs(rungs[0].qty_retired - 30) < 1e-9,
   `${rungs[0].qty_retired}`);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
