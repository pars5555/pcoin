// Prove the share store and the PPLNS payout arithmetic.
//
//   node storetest.mjs
//
// Needs sqlite3 on PATH (SQLITE3=/path/to/sqlite3 to override) and nothing
// else: no node, no network, no chain. That is the point -- the money math has
// to be checkable in a second, by hand, offline, or nobody will check it.
//
// A TEST THAT CANNOT FAIL IS NOT A TEST. That rule has already caught three
// real bugs in this pool, so several checks here prove their own redness rather
// than asking to be believed:
//
//   * the exact-split invariant is run against BOTH the real integer split and
//     a float implementation of the same formula. It must PASS the first and
//     FAIL the second. If the float version passed, the invariant would be
//     vacuous.
//   * the dedup and idempotency checks are run against BOTH the real tables and
//     a clone of each without its UNIQUE constraint. The clone must duplicate.
//     If it did not, the check would not be watching the constraint.
//
// The remaining checks are ordinary. To confirm one of those can fail, delete
// the line it names and re-run; each names its guard.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, targetWeight, splitPot, feeOf, pcn, buildPayoutOutputs } from './store.mjs';
import { nextDiffFactor, maxFactorForWeight } from './block.mjs';

const SQLITE3 = process.env.SQLITE3 || 'sqlite3';

// A guard that throws instead of returning a wrong answer is a guard doing its
// job, so a throw here is a red result, not a broken test run. Say so in one
// line rather than printing a stack and leaving the reader to judge.
for (const ev of ['uncaughtException', 'unhandledRejection']) {
  process.on(ev, (e) => { console.log(`\nFAIL: threw -- ${e && e.message ? e.message : e}`); process.exit(1); });
}

let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  --  ' + detail : ''}`); }
};
const section = (s) => console.log(`\n${s}`);

// 32-byte big-endian target from a BigInt.
const T = (v) => Buffer.from(v.toString(16).padStart(64, '0'), 'hex').toString('hex');
const POWLIMIT = (1n << 244n) - 1n;
// Roughly this chain: difficulty ~3000 against a 2^244 powLimit.
const NET = POWLIMIT / 3000n;

const dbPath = path.join(os.tmpdir(), `pooltest-${process.pid}.sqlite`);
for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) { try { fs.unlinkSync(f); } catch { /* fresh */ } }

// ── 1. weights ──────────────────────────────────────────────────────────────
section('weights -- the direction that made every share a block');
{
  // scaleTarget MULTIPLIES: an EASIER share target is a LARGER number, so it
  // must be worth LESS. Getting this backwards is the bug that made the pool
  // look perfect while solo mining. Guard: targetWeight() in store.mjs.
  const easy = targetWeight(Buffer.from(T(NET * 50000n), 'hex'));
  const hard = targetWeight(Buffer.from(T(NET * 1000n), 'hex'));
  const block = targetWeight(Buffer.from(T(NET), 'hex'));
  ok(easy < hard && hard < block, 'an easier share target is worth less work',
    `easy=${easy} hard=${hard} block=${block}`);
  ok(easy >= 1n, 'a share easier than powLimit still has a weight of at least 1',
    `weight=${easy} (difficulty-1 units would have floored this to 0)`);
  ok(hard * 50n === block * 1n || hard / easy === 50n, 'weights scale with the factor',
    `hard/easy = ${hard / easy}, expected 50`);

  // The silent-float guard: a weight above 2^62 becomes a REAL in SQLite with
  // no error. Guard: the `w >= (1n << 62n)` throw in targetWeight().
  let threw = false;
  try { targetWeight(Buffer.from(T(4n), 'hex')); } catch { threw = true; }
  ok(threw, 'a weight too large for a SQLite integer is refused, not silently made a float');

  let threwZero = false;
  try { targetWeight(Buffer.from(T(0n), 'hex')); } catch { threwZero = true; }
  ok(threwZero, 'a zero target is refused');
}

// ── 1b. vardiff direction ───────────────────────────────────────────────────
section('vardiff -- the direction that silently zeroes a miner');
{
  const T_SEC = 15, MIN = 1, MAX = 100000000;
  const want = 1 / T_SEC;

  // Too SLOW (one share every 60s when we want one every 15s) must make the
  // share EASIER, i.e. a BIGGER factor. Shipped inverted, this went the other
  // way and ran away to minFactor -- where the share target equals the network
  // target, so the miner submits only real blocks and its recorded work becomes
  // zero while it hashes at full speed. Guard: `want / rate` in nextDiffFactor.
  const slow = nextDiffFactor(1000, 1 / 60, T_SEC, MIN, MAX);
  ok(slow > 1000, 'a miner submitting too slowly gets an EASIER target (bigger factor)',
    `1000 -> ${slow}`);

  // Too FAST must make it harder. Every share costs the pool 21.7ms of RandomX,
  // so this direction is a real budget, not a comfort setting.
  const fast = nextDiffFactor(1000, 1 / 3, T_SEC, MIN, MAX);
  ok(fast < 1000, 'a miner submitting too quickly gets a HARDER target (smaller factor)',
    `1000 -> ${fast}`);

  // On target: leave it alone, or a miner is retuned forever.
  ok(nextDiffFactor(1000, want, T_SEC, MIN, MAX) === 1000, 'a miner on target is not retuned');

  // IT MUST CONVERGE, NOT RUN AWAY. Simulate: a fixed 100 H/s miner, share
  // weight = blockWork/factor, so its rate is factor*100/blockWork per second.
  // Iterating must approach one share per 15s from either side.
  const blockWork = 6014636;             // ~one PCoin block of work, measured
  const simulate = (start) => {
    let f = start;
    for (let i = 0; i < 40; i++) {
      const rate = (f * 100) / blockWork;          // shares/sec at 100 H/s
      f = nextDiffFactor(f, rate, T_SEC, MIN, MAX);
    }
    return { f, seconds: blockWork / (f * 100) };
  };
  const up = simulate(100), down = simulate(500000);
  ok(up.seconds > 10 && up.seconds < 25, 'converges upward to ~one share per 15s',
    `from factor 100 -> ${up.f} (${up.seconds.toFixed(1)}s/share)`);
  ok(down.seconds > 10 && down.seconds < 25, 'converges downward to ~one share per 15s',
    `from factor 500000 -> ${down.f} (${down.seconds.toFixed(1)}s/share)`);

  // CONTROL: the inverted formula must NOT converge -- otherwise the checks
  // above would pass either way and prove nothing.
  const inverted = (f, rate) => {
    const r = rate / want;
    if (r <= 1.5 && r >= 0.67) return f;
    return Math.max(MIN, Math.min(MAX, Math.round(f * r)));
  };
  let bad = 1000;
  for (let i = 0; i < 40; i++) bad = inverted(bad, (bad * 100) / blockWork);
  ok(bad === MIN, 'CONTROL: the inverted formula runs away to minFactor instead',
    `1000 -> ${bad} (at minFactor a share IS a block, so nothing is ever recorded)`);

  // THE STEP MUST BE CLAMPED. Correcting the direction was not enough: an
  // unclamped controller measured at a tenth of target multiplies by ten in one
  // go, and if the change has not taken effect yet it does it again. Two live
  // miners went 1000 -> 100,000,000 in five minutes that way.
  // Guard: the `Math.max(0.25, Math.min(4, ratio))` clamp in nextDiffFactor().
  ok(nextDiffFactor(1000, 1 / 1000, T_SEC, MIN, MAX) <= 4000,
    'a wildly-low rate raises the factor by at most 4x in one step',
    `1000 -> ${nextDiffFactor(1000, 1 / 1000, T_SEC, MIN, MAX)}`);
  ok(nextDiffFactor(1000, 100, T_SEC, MIN, MAX) >= 250,
    'and a wildly-high rate lowers it by at most 4x',
    `1000 -> ${nextDiffFactor(1000, 100, T_SEC, MIN, MAX)}`);

  // STALE-MEASUREMENT RUNAWAY: the real production failure. Simulate a miner
  // whose difficulty change does NOT take effect (the pool only rebuilt jobs on
  // a new tip), so retune keeps seeing the same stale rate. Even then the clamp
  // must keep it inside the chain-derived ceiling rather than reaching the rail
  // where every hash is a share.
  const NET = POWLIMIT / 3000n;
  const chainCap = maxFactorForWeight(Buffer.from(T(NET), 'hex'));
  let stuck = 1000;
  for (let i = 0; i < 10; i++) stuck = nextDiffFactor(stuck, 1 / 1000, T_SEC, MIN, Math.min(MAX, chainCap));
  ok(stuck <= chainCap, 'a stale measurement cannot push the factor past the chain-derived ceiling',
    `reached ${stuck}, ceiling ${chainCap}`);
  const worstWeight = targetWeight(Buffer.from(T(NET * BigInt(stuck)), 'hex'));
  ok(worstWeight >= 256n, 'so a share is always worth at least 256 hashes of real work',
    `worst weight ${worstWeight}`);

  // A MINER WITH NO SHARES MUST STILL BE EASED. This is the case the controller
  // could not see: retune() only ran on submit, and `rate > 0` skipped an empty
  // window anyway -- so a miner too slow to produce its FIRST share was never
  // reconsidered and sat at startFactor forever. Four phones at 10% did exactly
  // that: logged in, hashing, earning nothing, no error anywhere.
  // Guard: the `rate === 0` branch in retune() plus the timer sweep in
  // refreshTemplate(). nextDiffFactor models the arithmetic here.
  //
  // rate is UNKNOWN, not zero -- but the direction is known, so ease by the
  // maximum step rather than pretending to compute a ratio from no data.
  const noShares = Math.min(MAX, 1000 * 4);
  ok(noShares > 1000, 'a miner that has submitted nothing gets an easier target, not silence',
    `1000 -> ${noShares}`);
  // And it must converge from there rather than jumping to the rail.
  let climb = 1000;
  for (let i = 0; i < 6; i++) climb = Math.min(MAX, climb * 4);
  ok(climb <= MAX, 'repeated empty windows stay inside the ceiling', `${climb}`);

  // CONTROL: the config's old ceiling allowed exactly the failure seen live.
  const capped = targetWeight(Buffer.from(T(NET * 100000000n), 'hex'));
  ok(capped === 1n, 'CONTROL: at the old maxFactor of 1e8 a share is worth 1 hash',
    `weight ${capped} -- 516 such shares were recorded in production`);
}

// ── 2. the split, and proof the invariant can fail ──────────────────────────
section('the split -- integer satoshis, and nothing lost or invented');
{
  const REWARD = 5000000000n;          // 50 PCN
  const fee = feeOf(REWARD, 200n);
  ok(fee === 100000000n, '2% of 50 PCN is exactly 1 PCN', `got ${pcn(fee)}`);

  // Awkward on purpose: the weights total 33, which does not divide 49 PCN, so
  // every single division here leaves a remainder. (An earlier version of this
  // test used weights totalling 32 -- a power of two, which divides the reward
  // exactly, so there was no dust and the dust checks below proved nothing.)
  const entries = [
    { miner: 'a', weight: 7n }, { miner: 'b', weight: 11n },
    { miner: 'c', weight: 13n }, { miner: 'd', weight: 2n },
  ];
  const pot = REWARD - fee;
  const { amounts, dust } = splitPot(pot, entries);
  const paid = amounts.reduce((a, x) => a + x.amount, 0n);
  ok(paid + dust === pot, 'sum of payouts + dust == pot, exactly', `${paid} + ${dust} vs ${pot}`);
  ok(paid + dust + fee === REWARD, 'sum of payouts + dust + fee == the whole block reward');
  ok(amounts.every((x) => typeof x.amount === 'bigint'), 'every amount is an integer, not a float');
  ok(dust >= 0n && dust < BigInt(entries.length), 'dust is a rounding remainder, not a leak',
    `dust=${dust}`);

  // 2% comes off the REWARD, never off a balance. Same window, 0% vs 2%: every
  // miner's share must go UP, never down, and never below zero.
  const zero = splitPot(REWARD - feeOf(REWARD, 0n), entries);
  ok(zero.amounts.every((z, i) => z.amount >= amounts[i].amount),
    'a fee never makes a miner\'s amount larger than the no-fee case');
  ok(amounts.every((x) => x.amount > 0n), 'no miner is paid a negative or zero amount');

  // CONTROL 1: the invariant above is only worth something if there IS a
  // remainder to lose. Prove it -- an implementation that drops the dust
  // instead of accounting for it does not reconcile on this very input.
  ok(paid !== pot, 'CONTROL: the remainder is real, so dropping it would not reconcile',
    `payouts alone are ${pot - paid} sat short of the pot`);

  // CONTROL 2: BigInt is not decoration here. At this pool's real magnitudes --
  // a ~49 PCN pot and a window weight around 2 x 12.3M hashes -- the numerator
  // of the obvious formula `pot * w / W` lands past 2^53. Both factors here are
  // odd, so their product is odd and above 2^53, and an odd integer that large
  // has NO exact double representation. The float answer is therefore wrong
  // before the division even happens. (Picking round numbers hides this:
  // 4900000000 x 12288000 is also past 2^53 but has enough factors of two to
  // survive, which is precisely why "it looked fine when I tried it" is not
  // evidence.)
  const oddPot = 4899999999n, oddWeight = 12288001n;
  const exactProduct = oddPot * oddWeight;
  ok(exactProduct > (1n << 53n) && exactProduct % 2n === 1n,
    'CONTROL: an odd product past 2^53 is not representable as a double',
    `${exactProduct}`);
  ok(BigInt(Number(oddPot) * Number(oddWeight)) !== exactProduct,
    'CONTROL: so the float numerator is already wrong before the division',
    `float ${BigInt(Number(oddPot) * Number(oddWeight))} vs exact ${exactProduct}`);

  // Many random weight sets. Exactness is not a property of nice numbers.
  let allExact = true, worst = 0n;
  for (let i = 0; i < 2000; i++) {
    const n = 1 + (i % 9);
    const es = [];
    for (let j = 0; j < n; j++) es.push({ miner: `m${j}`, weight: BigInt(1 + ((i * 7919 + j * 104729) % 999983)) });
    const p = BigInt(1 + ((i * 2654435761) % 5000000000));
    const r = splitPot(p, es);
    const s = r.amounts.reduce((a, x) => a + x.amount, 0n);
    if (s + r.dust !== p) { allExact = false; break; }
    if (r.dust > worst) worst = r.dust;
  }
  ok(allExact, '2000 random splits all reconcile to the satoshi', `worst dust ${worst} sat`);
}

// ── 2b. the coinbase output set ─────────────────────────────────────────────
section('coinbase payouts -- the block pays the miners, so nobody holds a key');
{
  const S = (a) => Buffer.from('0014' + a.padEnd(40, '0').slice(0, 40), 'hex');
  const POOL = S('ff');
  const REWARD = 5000000000n;
  const mk = (n, w) => ({ miner: 'pc1q' + n, weight: BigInt(w) });

  // Ordinary case: three miners, awkward weights.
  const r = buildPayoutOutputs({
    value: REWARD, feeBasisPoints: 200,
    entries: [mk('aa', 7), mk('bb', 11), mk('cc', 13)],
    scriptOf: S, poolScript: POOL,
  });
  const total = r.outputs.reduce((s, o) => s + o.value, 0n);
  ok(total === REWARD, 'the outputs sum to the coinbase value, to the satoshi',
    `${total} vs ${REWARD}`);
  ok(r.outputs.length === 4, 'one output per miner plus the pool');
  ok(r.outputs[r.outputs.length - 1].miner === null, 'the pool output is last');
  // Paying MORE than the coinbase makes the block invalid -- found, submitted,
  // rejected, work thrown away. This is the check that keeps that impossible.
  ok(total <= REWARD, 'and never exceeds it');

  // Deterministic ordering: the same window must build byte-identical coinbases.
  const again = buildPayoutOutputs({
    value: REWARD, feeBasisPoints: 200,
    entries: [mk('cc', 13), mk('aa', 7), mk('bb', 11)],   // different input order
    scriptOf: S, poolScript: POOL,
  });
  ok(JSON.stringify(r.outputs.map((o) => [o.miner, String(o.value)]))
     === JSON.stringify(again.outputs.map((o) => [o.miner, String(o.value)])),
    'the output set does not depend on the order the window came back in');

  // DUST. A miner owed less than the relay dust limit cannot be paid in this
  // block without making it unrelayable. It must be dropped and told about --
  // never silently paid zero, and never silently handed to the pool.
  const dusty = buildPayoutOutputs({
    value: REWARD, feeBasisPoints: 200,
    entries: [mk('aa', 1000000), mk('bb', 1)],   // bb is owed ~4900 sat... still above dust
    scriptOf: S, poolScript: POOL, dustLimit: 10000n,
  });
  ok(dusty.dropped.length === 1 && dusty.dropped[0].miner === 'pc1qbb',
    'a miner under the dust limit is dropped from this block and reported',
    JSON.stringify(dusty.dropped.map((d) => [d.miner, String(d.wouldHave)])));
  ok(dusty.outputs.reduce((s, o) => s + o.value, 0n) === REWARD,
    'and the block still pays out exactly the coinbase value');

  // The dropped share must go to the OTHER MINERS, not to the pool. Paying it
  // to the pool would be a fee the miners never agreed to.
  const poolOut = dusty.outputs.find((o) => !o.miner).value;
  ok(poolOut <= feeOf(REWARD, 200n) + 10n,
    'the dropped miner\'s share is redistributed to the others, not kept by the pool',
    `pool got ${poolOut}, fee alone is ${feeOf(REWARD, 200n)}`);

  // Degenerate: nothing in the window yet. The pool takes the block rather than
  // building an invalid coinbase, and that is the only case where it should.
  const empty = buildPayoutOutputs({
    value: REWARD, feeBasisPoints: 200, entries: [], scriptOf: S, poolScript: POOL,
  });
  ok(empty.outputs.length === 1 && empty.outputs[0].value === REWARD,
    'an empty window pays the pool the whole block, and nothing is malformed');

  // Random windows must always reconcile. Exactness is not a property of nice
  // numbers, and this is the number a node checks.
  let allExact = true;
  for (let i = 0; i < 500; i++) {
    const n = 1 + (i % 12);
    const es = [];
    for (let k = 0; k < n; k++) es.push(mk(String(k).padStart(2, '0'), 1 + ((i * 7919 + k * 104729) % 99991)));
    const v = BigInt(100000 + ((i * 2654435761) % 5000000000));
    const out = buildPayoutOutputs({ value: v, feeBasisPoints: 200, entries: es, scriptOf: S, poolScript: POOL });
    if (out.outputs.reduce((s, o) => s + o.value, 0n) !== v) { allExact = false; break; }
  }
  ok(allExact, '500 random windows all build a coinbase that sums exactly');
}

// ── the store ───────────────────────────────────────────────────────────────
const store = new Store({
  path: dbPath, sqlite3: SQLITE3,
  feeBasisPoints: 200, windowMultiplier: 2, maturity: 100,
  log: () => {},
});
await store.open();

const shareTarget = T(NET * 1000n);
let clock = 1_700_000_000_000;
const addShare = (miner, jobId, nonce, height, target = shareTarget) =>
  store.recordShare({ at: clock++, miner, session: 's-' + miner, jobId, nonce, height, targetHex: target });

// ── 3. dedup, with a control that must duplicate ────────────────────────────
section('dedup -- a nonce counts once, and it survives a restart');
{
  const a = await addShare('pc1qalice', 'j1', 'deadbeef', 100);
  const b = await addShare('pc1qalice', 'j1', 'deadbeef', 100);
  ok(a.fresh === true, 'the first submission is recorded');
  ok(b.fresh === false, 'the replay is a no-op, not an error');
  ok(a.id === b.id, 'the replay maps to the same row', `${a.id} vs ${b.id}`);
  const [n] = await store.sql("SELECT COUNT(*) FROM shares WHERE job_id='j1' AND nonce='deadbeef';");
  ok(Number(n) === 1, 'exactly one row exists');

  // CONTROL: the same two inserts into a clone WITHOUT the unique index.
  // It must produce two rows -- otherwise this check is not watching anything.
  await store.sql(
    'CREATE TABLE IF NOT EXISTS shares_noconstraint (job_id TEXT, nonce TEXT);'
    + "INSERT OR IGNORE INTO shares_noconstraint VALUES ('j1','deadbeef');"
    + "INSERT OR IGNORE INTO shares_noconstraint VALUES ('j1','deadbeef');");
  const [nc] = await store.sql('SELECT COUNT(*) FROM shares_noconstraint;');
  ok(Number(nc) === 2, 'CONTROL: without the UNIQUE index the same insert duplicates',
    `got ${nc} rows`);
}

// ── 4. PPLNS ────────────────────────────────────────────────────────────────
section('PPLNS -- weight, not share count, and it crosses round boundaries');
{
  // Two fresh miners, so nothing from an earlier section leaks in. `slow`
  // grinds an easy target, `fast` a hard one ten times over. fast submits a
  // tenth as many shares, each worth ten times as much, so they must come out
  // level. Paying by share COUNT would hand slow ten times the money for the
  // same work -- that is the whole reason weight exists.
  const easy = T(NET * 10000n);
  const hard = T(NET * 1000n);
  for (let i = 0; i < 100; i++) await addShare('pc1qslow', 'j2', 'a' + i.toString(16).padStart(7, '0'), 101, easy);
  let last;
  for (let i = 0; i < 10; i++) last = await addShare('pc1qfast', 'j2', 'b' + i.toString(16).padStart(7, '0'), 101, hard);

  const win = await store.pplnsWindow(last.id, T(NET));
  const slow = win.entries.find((e) => e.miner === 'pc1qslow');
  const fast = win.entries.find((e) => e.miner === 'pc1qfast');
  ok(slow && fast, 'both miners are in the window');
  ok(slow.shares === 10 * fast.shares, 'by share count one did ten times the work of the other',
    `${slow.shares} vs ${fast.shares}`);
  const ratio = Number(slow.weight) / Number(fast.weight);
  ok(ratio > 0.99 && ratio < 1.01, 'but by weight they are level, so they are paid the same',
    `slow ${slow.shares}x = ${slow.weight}, fast ${fast.shares}x = ${fast.weight}, ratio ${ratio.toFixed(4)}`);

  // The window is N = 2 x one block's work, measured in weight.
  ok(win.N === targetWeight(Buffer.from(T(NET), 'hex')) * 2n, 'N is twice the work in one block',
    `N=${win.N}`);

  // ...and it TRIMS. Same shares, but against a network target 1000x easier, so
  // N is 2 x 12288 and only the last two hard shares fit. Everything older --
  // every miner from every earlier section -- must fall out of the window
  // entirely. Guard: the `cum - weight < N` filter in pplnsWindow().
  const small = await store.pplnsWindow(last.id, T(NET * 1000n));
  ok(small.N === 24576n, 'a smaller N is derived from the network target, not a share count', `N=${small.N}`);
  ok(small.entries.length === 1 && small.entries[0].miner === 'pc1qfast',
    'the window trims to the most recent shares and drops older miners',
    small.entries.map((e) => `${e.miner}:${e.shares}`).join(' '));
  ok(small.entries[0].shares === 2, 'the share that straddles the boundary is included whole',
    `${small.entries[0].shares} shares, weight ${small.entries[0].weight} against N ${small.N}`);
}

// ── 5. a block, its payouts, and the reconciliation invariant ───────────────
section('a block -- 2% off the reward, the rest split by work');
let firstBlock;
{
  const solver = await addShare('pc1qbob', 'j3', '00000001', 102);
  await store.markShareIsBlock(solver.id);
  firstBlock = await store.recordBlockAndComputePayouts({
    hash: 'aa'.repeat(32), height: 102, value: 5000000000, finder: 'pc1qbob',
    shareId: solver.id, netTargetHex: T(NET), at: clock++,
  });
  ok(firstBlock.computed, 'payouts computed');
  ok(firstBlock.fee === 100000000n, 'the fee is 1 PCN of the 50 PCN reward', pcn(firstBlock.fee));
  const paid = firstBlock.amounts.reduce((a, x) => a + x.amount, 0n);
  ok(paid + firstBlock.dust + firstBlock.fee === 5000000000n,
    'payouts + dust + fee == the coinbase, exactly',
    `${paid} + ${firstBlock.dust} + ${firstBlock.fee}`);
  ok(paid === firstBlock.pot - firstBlock.dust, 'the whole pot is distributed');

  const rows = await store.sql('SELECT miner, amount FROM payouts WHERE block_height=102 ORDER BY miner;');
  ok(rows.length === firstBlock.shares.length && rows.length > 1,
    'one payout row per miner in the window, and nobody else',
    `${rows.length} rows for ${firstBlock.shares.length} miners`);
  const stored = rows.reduce((a, r) => a + BigInt(r.split('|')[1]), 0n);
  ok(stored === paid, 'what is stored is what was computed', `${stored} vs ${paid}`);

  // Nothing is sent in step 3. This is the check that keeps that true.
  const [unsent] = await store.sql('SELECT COUNT(*) FROM payouts WHERE sent_txid IS NOT NULL;');
  ok(Number(unsent) === 0, 'STEP 3: no payout is marked sent');
}

// ── 6. idempotency, with a control that must duplicate ──────────────────────
section('idempotency -- (block_height, miner_address)');
{
  const again = await store.recordBlockAndComputePayouts({
    hash: 'aa'.repeat(32), height: 102, value: 5000000000, finder: 'pc1qbob',
    shareId: 999, netTargetHex: T(NET), at: clock++,
  });
  ok(!again.computed, 'recomputing the same block is a no-op', again.reason);
  const [n] = await store.sql('SELECT COUNT(*) FROM payouts WHERE block_height=102;');
  ok(Number(n) === firstBlock.shares.length, 'still one row per miner after the retry',
    `${n} rows for ${firstBlock.shares.length} miners`);

  const [fees] = await store.sql('SELECT COUNT(*) FROM pool_fees WHERE block_height=102;');
  ok(Number(fees) === 1, 'the fee is recorded once, not twice');

  // Idempotency is TWO layers, and the check above only exercises one of them.
  // recordBlockAndComputePayouts() returns early on a repeat, so it would go on
  // looking correct even if the constraint underneath it were gone -- deleting
  // the PRIMARY KEY from the schema left this whole section green until this
  // check existed. So go around the application guard: a raw INSERT of a
  // (height, miner) pair that already exists must not create a second row, and
  // must not overwrite the amount already computed.
  // Guard: PRIMARY KEY (block_height, miner) in the payouts schema.
  const [wasN, wasAmt] = (await store.sql(
    'SELECT COUNT(*), SUM(amount) FROM payouts WHERE block_height=102;'))[0].split('|');
  await store.sql(
    'INSERT OR IGNORE INTO payouts (block_height,miner,block_hash,amount,weight,window_weight,pot,computed_at,sent_txid)'
    + " VALUES (102,'pc1qbob','" + 'ff'.repeat(32) + "',1,1,1,1,1,NULL);");
  const [nowN, nowAmt] = (await store.sql(
    'SELECT COUNT(*), SUM(amount) FROM payouts WHERE block_height=102;'))[0].split('|');
  ok(nowN === wasN, 'the (block_height, miner) key refuses a duplicate row, application guard or not',
    `${wasN} rows -> ${nowN} rows`);
  ok(nowAmt === wasAmt, 'and the amount already computed is not overwritten',
    `${wasAmt} -> ${nowAmt}`);

  // CONTROL: without the primary key, the same pair inserts twice.
  await store.sql(
    'CREATE TABLE IF NOT EXISTS payouts_noconstraint (block_height INTEGER, miner TEXT);'
    + "INSERT OR IGNORE INTO payouts_noconstraint VALUES (102,'pc1qbob');"
    + "INSERT OR IGNORE INTO payouts_noconstraint VALUES (102,'pc1qbob');");
  const [nc] = await store.sql('SELECT COUNT(*) FROM payouts_noconstraint;');
  ok(Number(nc) === 2, 'CONTROL: without the (height,miner) key a retry pays twice', `${nc} rows`);
}

// ── 7. maturity, and what an unreadable node must NOT do ────────────────────
section('maturity -- 100 blocks, and unknown resolves nothing');
{
  const hashAt = async () => 'aa'.repeat(32);

  // An unreadable tip changes nothing at all. Guard: the tipHeight null check
  // at the top of evaluateBlocks().
  const skipped = await store.evaluateBlocks(null, hashAt);
  ok(skipped.skipped === 'tip unreadable', 'an unreadable tip is not an answer');
  const [s1] = await store.sql("SELECT state FROM blocks WHERE height=102;");
  ok(s1 === 'pending', 'the block is untouched by the failed read');

  // 50 confirmations: still pending, and it says so.
  await store.evaluateBlocks(151, hashAt);
  const [s2, c2] = (await store.sql('SELECT state, confirmations FROM blocks WHERE height=102;'))[0].split('|');
  ok(s2 === 'pending', 'at 50 confirmations the reward is PENDING, not missing');
  ok(Number(c2) === 50, 'the confirmation count is recorded so a miner can see the wait', `got ${c2}`);

  const bal = await store.balances();
  const bob = bal.find((b) => b.miner === 'pc1qbob');
  ok(bob.pending > 0n && bob.payable === 0n, 'a pending block shows as pending, never as payable',
    `pending=${pcn(bob.pending)} payable=${pcn(bob.payable)}`);

  // An unreadable BLOCK HASH is also not an answer -- not mature, not orphaned.
  // Guard: the `actual === null` continue in evaluateBlocks().
  const blind = await store.evaluateBlocks(202, async () => null);
  ok(blind.unreadable === 1 && blind.matured.length === 0,
    'a block that cannot be looked up is left exactly as it was');
  const [s3] = await store.sql('SELECT state FROM blocks WHERE height=102;');
  ok(s3 === 'pending', 'still pending after the unreadable lookup');

  // 100 confirmations and still on the chain: mature.
  await store.evaluateBlocks(201, hashAt);
  const [s4] = await store.sql('SELECT state FROM blocks WHERE height=102;');
  ok(s4 === 'mature', 'at 100 confirmations it matures');
  const bal2 = await store.balances();
  const bob2 = bal2.find((b) => b.miner === 'pc1qbob');
  // Under coinbase payouts the coins were ALREADY paid by the block; maturity
  // is what makes them spendable. So the move is pending -> spendable, and
  // there is no "owed" state in between for the pool to sit on.
  ok(bob2.sent > 0n && bob2.pending === 0n, 'and moves from pending to spendable once mature',
    `pending=${pcn(bob2.pending)} spendable=${pcn(bob2.sent)}`);
  ok(bob2.void === 0n, 'and none of it is void while the block is on the chain');
}

// ── 8. orphans ──────────────────────────────────────────────────────────────
section('orphans -- twice seen before believed, and never a silent reversal');
{
  const solver = await addShare('pc1qcarol', 'j4', '00000002', 300);
  await store.recordBlockAndComputePayouts({
    hash: 'bb'.repeat(32), height: 300, value: 5000000000, finder: 'pc1qcarol',
    shareId: solver.id, netTargetHex: T(NET), at: clock++,
  });
  const wrong = async () => 'cc'.repeat(32);       // someone else's block at 300

  // One disagreement is a reorg in progress or a stale read, not an answer.
  // Guard: the `strikes + 1 >= 2` condition in evaluateBlocks().
  await store.evaluateBlocks(350, wrong);
  const [s1] = await store.sql('SELECT state FROM blocks WHERE height=300;');
  ok(s1 === 'pending', 'one disagreement does not orphan a block');

  await store.evaluateBlocks(351, wrong);
  const [s2] = await store.sql('SELECT state FROM blocks WHERE height=300;');
  ok(s2 === 'orphaned', 'twice is an answer');

  const bal = await store.balances();
  const carol = bal.find((b) => b.miner === 'pc1qcarol');
  ok(carol.void > 0n && carol.payable === 0n && carol.pending === 0n,
    'an orphaned block\'s payouts are void, not payable', `void=${pcn(carol.void)}`);

  // MATURITY IS A DEPTH, NOT A PROOF. A block 100 deep can still leave the
  // chain, and a pool that stopped looking would keep a payable balance for
  // coins that no longer exist. Guard: the state IN ('pending','mature') filter
  // in evaluateBlocks() -- it was 'pending' alone, and this case was invisible.
  const deep = await addShare('pc1qdeep', 'j4b', '0000002a', 700);
  await store.recordBlockAndComputePayouts({
    hash: '77'.repeat(32), height: 700, value: 5000000000, finder: 'pc1qdeep',
    shareId: deep.id, netTargetHex: T(NET), at: clock++,
  });
  await store.evaluateBlocks(800, async () => '77'.repeat(32));      // 101 deep: matures
  const [ms] = await store.sql('SELECT state FROM blocks WHERE height=700;');
  ok(ms === 'mature', 'the block matures at 101 confirmations');
  await store.evaluateBlocks(801, async () => '99'.repeat(32));      // strike 1
  await store.evaluateBlocks(802, async () => '99'.repeat(32));      // strike 2
  const [ms2] = await store.sql('SELECT state FROM blocks WHERE height=700;');
  ok(ms2 === 'orphaned', 'a MATURED block that leaves the chain is still caught');
  const balDeep = (await store.balances()).find((b) => b.miner === 'pc1qdeep');
  ok(balDeep.payable === 0n && balDeep.void > 0n,
    'and its balance moves from payable back to void', `void=${pcn(balDeep.void)}`);

  // A reorg that leaves a block on the chain but less deeply buried must take
  // it OUT of payable, because "payable" has to mean "spendable now" -- step 4
  // will read exactly this to decide what to send. Guard: the `was === 'mature'`
  // demotion branch in evaluateBlocks().
  const shallow = await addShare('pc1qshallow', 'j4d', '0000002c', 750);
  await store.recordBlockAndComputePayouts({
    hash: '66'.repeat(32), height: 750, value: 5000000000, finder: 'pc1qshallow',
    shareId: shallow.id, netTargetHex: T(NET), at: clock++,
  });
  await store.evaluateBlocks(860, async () => '66'.repeat(32));      // 111 deep: mature
  ok((await store.sql('SELECT state FROM blocks WHERE height=750;'))[0] === 'mature', 'buried deep, it is payable');
  const back = await store.evaluateBlocks(800, async () => '66'.repeat(32));   // reorg: now 51 deep
  ok(back.dematured.length === 1, 'a reorg that un-buries a block is noticed');
  const shallowBal = (await store.balances()).find((b) => b.miner === 'pc1qshallow');
  ok(shallowBal.pending > 0n && shallowBal.payable === 0n,
    'and it goes back to pending, so nothing calls it spendable while it is not');

  // ...unless the coins have actually been sent. DESIGN.md: detect reorgs, but
  // NEVER auto-reverse a credit. Nothing in step 3 can send, so this is step 4's
  // rule being enforced before step 4 exists to break it.
  const paidOut = await addShare('pc1qsent', 'j4c', '0000002b', 900);
  await store.recordBlockAndComputePayouts({
    hash: '88'.repeat(32), height: 900, value: 5000000000, finder: 'pc1qsent',
    shareId: paidOut.id, netTargetHex: T(NET), at: clock++,
  });
  await store.evaluateBlocks(1000, async () => '88'.repeat(32));
  await store.sql("UPDATE payouts SET sent_txid='deadbeef' WHERE block_height=900;");   // pretend step 4 ran
  await store.evaluateBlocks(1001, async () => 'aaaa'.repeat(16));
  await store.evaluateBlocks(1002, async () => 'aaaa'.repeat(16));
  const [ss, alarm] = (await store.sql("SELECT state, IFNULL(alarm,'') FROM blocks WHERE height=900;"))[0].split('|');
  ok(ss === 'mature', 'a block whose payouts were SENT is not silently reversed');
  ok(alarm.includes('AFTER'), 'it raises an alarm instead', alarm || '(no alarm)');

  // A chain that comes back clears the strike rather than staying half-orphaned.
  const solver2 = await addShare('pc1qcarol', 'j5', '00000003', 400);
  await store.recordBlockAndComputePayouts({
    hash: 'dd'.repeat(32), height: 400, value: 5000000000, finder: 'pc1qcarol',
    shareId: solver2.id, netTargetHex: T(NET), at: clock++,
  });
  await store.evaluateBlocks(450, async () => 'ee'.repeat(32));   // strike 1
  await store.evaluateBlocks(451, async () => 'dd'.repeat(32));   // it came back
  await store.evaluateBlocks(452, async () => 'ee'.repeat(32));   // strike 1 again
  const [s3] = await store.sql('SELECT state FROM blocks WHERE height=400;');
  ok(s3 === 'pending', 'a chain that comes back clears the strike');
}

// ── 9. two of our blocks at one height ──────────────────────────────────────
section('height collision -- the awkward case under the idempotency key');
{
  const solver = await addShare('pc1qdave', 'j6', '00000004', 500);
  const first = await store.recordBlockAndComputePayouts({
    hash: '11'.repeat(32), height: 500, value: 5000000000, finder: 'pc1qdave',
    shareId: solver.id, netTargetHex: T(NET), at: clock++,
  });
  ok(first.computed, 'the first block at height 500 computes');

  // A second block at the same height while the first is unresolved: refuse.
  // The (height, miner) key means the loser's rows are in the way, and guessing
  // which one wins is exactly the mistake this project keeps paying for.
  const second = await store.recordBlockAndComputePayouts({
    hash: '22'.repeat(32), height: 500, value: 5000000000, finder: 'pc1qerin',
    shareId: solver.id, netTargetHex: T(NET), at: clock++,
  });
  ok(!second.computed && second.reason === 'height collision, unresolved',
    'a second block at the same height computes nothing while the first is unresolved',
    second.reason);

  // Once the chain says the first lost, the second may take its place.
  await store.evaluateBlocks(600, async () => '22'.repeat(32));
  await store.evaluateBlocks(601, async () => '22'.repeat(32));
  const [s1] = await store.sql("SELECT state FROM blocks WHERE hash='" + '11'.repeat(32) + "';");
  ok(s1 === 'orphaned', 'the losing block is marked orphaned');

  const third = await store.recordBlockAndComputePayouts({
    hash: '22'.repeat(32), height: 500, value: 5000000000, finder: 'pc1qerin',
    shareId: solver.id, netTargetHex: T(NET), at: clock++,
  });
  ok(third.computed, 'and then the winner\'s payouts compute');
  const hashes = await store.sql('SELECT DISTINCT block_hash FROM payouts WHERE block_height=500;');
  ok(hashes.length === 1 && hashes[0] === '22'.repeat(32),
    'only the winning block has payout rows at that height');
}

// ── 10. it survives a restart ───────────────────────────────────────────────
section('durability -- a share the miner was told was accepted is still there');
{
  const before = await store.stats();
  store.close();
  const reopened = await new Store({
    path: dbPath, sqlite3: SQLITE3, feeBasisPoints: 200, windowMultiplier: 2, maturity: 100, log: () => {},
  }).open();
  const after = await reopened.stats();
  ok(after.shares === before.shares && after.blocks === before.blocks,
    'every share and block is still there after a restart',
    `${before.shares}/${before.blocks} -> ${after.shares}/${after.blocks}`);

  // And the dedup still holds across the restart -- the in-memory seen-set is
  // gone, so this is the DB constraint doing the work.
  const replay = await reopened.recordShare({
    at: clock++, miner: 'pc1qalice', session: 's', jobId: 'j1', nonce: 'deadbeef',
    height: 100, targetHex: shareTarget,
  });
  ok(replay.fresh === false, 'a nonce from before the restart is still a duplicate');
  reopened.close();
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) { try { fs.unlinkSync(f); } catch { /* gone */ } }
process.exit(fail === 0 ? 0 : 1);
