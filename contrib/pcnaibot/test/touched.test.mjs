// The touch detector, against the shape the explorer ACTUALLY sends.
//
// The whole point of `addressTouched` is to avoid fetching a full transaction
// history for an address nothing has happened to. It was reading
// `entry.lifetime`; explorer.pc.am nests that block under `entry.balance`. So
// the lookup was always undefined, every address came back "lifetime block
// absent" -> touched, and the cheap path never once ran.
//
// It failed SAFE -- checking everything is correct, just expensive -- which is
// why it survived. It turns into a real fault at scale: EXPLORER_REQ_BUDGET is
// 40 requests per tick, and when that runs out the addresses after it are not
// checked, so somebody's deposit sits uncredited.
//
// The entry below is the live 2026-09-17 response shape, keys and nesting
// exactly as captured from explorer.pc.am.

import test from 'node:test';
import assert from 'node:assert/strict';

import { addressTouched } from '../lib/explorer.mjs';

// As the explorer really answers: lifetime UNDER balance.
function entry({ txCount = 10, received = 50876149821, used = true } = {}) {
  return {
    address: 'pc1qnfk7xenwzxx7h4mx88g004crlx0m2zcjg3nq4j',
    used,
    balance: {
      confirmed: { mature_sat: received, mature_utxo_count: 10, immature_sat: 0, utxo_count: 10 },
      unconfirmed: { known: true, tx_count: 0, utxo_count: 0, receiving_sat: 0 },
      lifetime: {
        tx_count: txCount, first_height: 7644, last_height: 8100,
        received_sat: received, sent_sat: 0,
      },
    },
  };
}

test('an unchanged address is NOT touched -- the cheap path works at all', () => {
  const prev = { txCount: 10, received: 50876149821 };
  const t = addressTouched(entry(), prev);
  assert.equal(t.touched, false,
    'this returned true for every address on every tick before the fix');
  assert.equal(t.txCount, 10);
  assert.equal(t.received, 50876149821);
});

test('a new transaction IS touched', () => {
  const prev = { txCount: 10, received: 50876149821 };
  const t = addressTouched(entry({ txCount: 11, received: 51376149821 }), prev);
  assert.equal(t.touched, true);
  assert.equal(t.reason, 'lifetime moved');
});

test('more coins at the same tx count is still touched', () => {
  // Defensive: two payments in one transaction move received_sat without
  // moving tx_count. Missing that would drop a real deposit.
  const prev = { txCount: 10, received: 50876149821 };
  const t = addressTouched(entry({ received: 50876149821 + 500000000 }), prev);
  assert.equal(t.touched, true);
});

test('no previous observation means touched -- unknown is not "no"', () => {
  const t = addressTouched(entry(), null);
  assert.equal(t.touched, true);
  assert.equal(t.reason, 'no previous observation');
  // ...and it still reports the figures, so the next tick HAS a baseline.
  assert.equal(t.txCount, 10);
});

test('the top-level spelling is still accepted', () => {
  // So an explorer that hoists the block does not silently put us back to
  // "absent" -> everything touched, forever.
  const e = entry();
  const lifted = { address: e.address, used: true, lifetime: e.balance.lifetime };
  const t = addressTouched(lifted, { txCount: 10, received: 50876149821 });
  assert.equal(t.touched, false);
});

// ---------------------------------------------------------------------------
// The refusals. Each of these must stay TOUCHED: an address we cannot judge
// gets the expensive check, never a shrug.
// ---------------------------------------------------------------------------
test('a genuinely absent lifetime block is touched', () => {
  const t = addressTouched({ address: 'x', used: true, balance: { confirmed: {} } }, { txCount: 1, received: 1 });
  assert.equal(t.touched, true);
  assert.equal(t.reason, 'lifetime block absent');
});

test('`used` being unknown is touched, not treated as false', () => {
  const e = entry(); delete e.used;
  assert.equal(addressTouched(e, { txCount: 10, received: 50876149821 }).touched, true);
});

test('non-integer figures are touched rather than compared', () => {
  const e = entry();
  e.balance.lifetime.received_sat = '50876149821';   // a string is not a satoshi
  const t = addressTouched(e, { txCount: 10, received: 50876149821 });
  assert.equal(t.touched, true);
});

test('a missing entry is touched', () => {
  assert.equal(addressTouched(null, { txCount: 1, received: 1 }).touched, true);
});
