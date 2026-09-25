#!/usr/bin/env node
// announcePurchase() -> the spool. No database, no network: a fake pool answers
// the one SELECT it makes, and a temporary directory stands in for
// /var/lib/pcoin-market/announce-spool.
//
//   node announce-spool-test.mjs
//
// What it pins down (2026-09-25, when the market stopped running pcoin-approve
// itself -- see ANNOUNCE_SPOOL in delivery.mjs):
//   * a paid $20+ order in an announceable status leaves ONE request file, named
//     for the order, carrying the order id and NOTHING else -- no text, no count;
//   * anything else leaves nothing: needs_review, under $20, unknown order, an
//     order id that could leave the directory;
//   * it never throws -- not on a missing spool, not on a database error --
//     because it runs inside the payment callback;
//   * a second call for the same order does not write a second file;
//   * no half-written file is ever visible under the name the drainer reads.

import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeDelivery, ANNOUNCE_SPOOL } from './delivery.mjs';

const ORDERS = {
  Mmu1bc3zrfd6902: { status: 'awaiting_delivery', usd: '25.00' },
  Mdelivered00001: { status: 'delivered', usd: '123.89' },
  Mreview0000001: { status: 'needs_review', usd: '50.00' },
  Msmall00000001: { status: 'delivered', usd: '19.99' },
  Mtest000000001: { status: 'test_completed', usd: '50.00' },
};

function fakePool({ fail = false } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, args) {
      calls.push(sql);
      if (fail) throw new Error('database is down');
      assert.match(sql, /SELECT status, usd FROM orders WHERE order_id=\?/);
      const o = ORDERS[args[0]];
      return [o ? [o] : [], []];
    },
  };
}

const logs = [];
const log = { info: m => logs.push(['info', m]), error: m => logs.push(['error', m]), warn: m => logs.push(['warn', m]) };

let pass = 0;
async function t(name, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'pcm-spool-'));
  try {
    await fn(dir);
    pass += 1;
    console.log('ok   ' + name);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const files = dir => readdirSync(dir).sort();

assert.equal(ANNOUNCE_SPOOL, '/var/lib/pcoin-market/announce-spool');

await t('a paid $20+ order leaves one request: the order id and nothing else', async dir => {
  const D = makeDelivery({ pool: fakePool(), node: null, notify: async () => {}, log, announceSpool: dir });
  await D.announcePurchase('Mmu1bc3zrfd6902');
  assert.deepEqual(files(dir), ['purchase-Mmu1bc3zrfd6902.json']);
  const rec = JSON.parse(readFileSync(join(dir, 'purchase-Mmu1bc3zrfd6902.json'), 'utf8'));
  assert.deepEqual(rec, { v: 1, source: 'market-purchase', orderId: 'Mmu1bc3zrfd6902' });
});

await t('delivered counts too; the second call for the same order adds nothing', async dir => {
  const D = makeDelivery({ pool: fakePool(), node: null, notify: async () => {}, log, announceSpool: dir });
  await D.announcePurchase('Mdelivered00001');
  await D.announcePurchase('Mdelivered00001');
  assert.deepEqual(files(dir), ['purchase-Mdelivered00001.json']);
});

await t('needs_review, under $20, a test order and an unknown order leave nothing', async dir => {
  const D = makeDelivery({ pool: fakePool(), node: null, notify: async () => {}, log, announceSpool: dir });
  for (const id of ['Mreview0000001', 'Msmall00000001', 'Mtest000000001', 'Mnosuchorder01']) {
    await D.announcePurchase(id);
  }
  assert.deepEqual(files(dir), []);
});

await t('an order id that could leave the directory is refused before the database is asked', async dir => {
  const pool = fakePool();
  const D = makeDelivery({ pool, node: null, notify: async () => {}, log, announceSpool: dir });
  for (const id of ['../../etc/passwd', 'a/b', '', 'x'.repeat(65), 'M bad', 'Mé']) {
    await D.announcePurchase(id);
  }
  assert.deepEqual(files(dir), []);
  assert.equal(pool.calls.length, 0);
});

await t('never throws: not on a missing spool directory, not on a database error', async dir => {
  const missing = join(dir, 'not-created');
  const D1 = makeDelivery({ pool: fakePool(), node: null, notify: async () => {}, log, announceSpool: missing });
  const before = logs.length;
  await D1.announcePurchase('Mmu1bc3zrfd6902');          // resolves, does not reject
  assert.ok(logs.slice(before).some(([lvl, m]) => lvl === 'error' && /not spooled/.test(m)),
            'a failed spool write must be logged as an error, not swallowed');
  const D2 = makeDelivery({ pool: fakePool({ fail: true }), node: null, notify: async () => {}, log, announceSpool: dir });
  await D2.announcePurchase('Mmu1bc3zrfd6902');
  assert.deepEqual(files(dir), []);
});

await t('a request already waiting is left alone, and no temp file is left behind', async dir => {
  // The drainer has not got to it yet: a second IPN delivery must not rewrite it.
  writeFileSync(join(dir, 'purchase-Mmu1bc3zrfd6902.json'), 'ORIGINAL');
  const D = makeDelivery({ pool: fakePool(), node: null, notify: async () => {}, log, announceSpool: dir });
  await D.announcePurchase('Mmu1bc3zrfd6902');
  assert.equal(readFileSync(join(dir, 'purchase-Mmu1bc3zrfd6902.json'), 'utf8'), 'ORIGINAL');
  assert.deepEqual(files(dir), ['purchase-Mmu1bc3zrfd6902.json']);
});

console.log(`\n${pass} passed`);
