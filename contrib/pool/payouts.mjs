// The pool ledger, for reconciling by hand.
//
//   node payouts.mjs --config pool.config.json
//   node payouts.mjs --config pool.config.json --miner pc1q...
//   node payouts.mjs --config pool.config.json --block 3300
//   node payouts.mjs --config pool.config.json --sql "SELECT ..."
//
// STEP 3 IS THIS TOOL'S WHOLE REASON TO EXIST. The pool computes payouts and
// writes them down; nothing is sent. For a week, the numbers below get checked
// against the chain by hand before step 4 wires any of it to a wallet. Anything
// that does not add up is supposed to be visible here rather than inferred from
// a log.
//
// Every check it prints is arithmetic it re-derives from the stored rows, not a
// value the pool wrote down as its own answer. A ledger that reports its own
// opinion of itself is not a check.

import { Store, loadConfig, pcn, splitPot, feeOf } from './store.mjs';

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const CFG = loadConfig(arg('config', new URL('./pool.config.json', import.meta.url).pathname));
const store = await new Store({
  path: CFG.db, sqlite3: CFG.sqlite3, feeBasisPoints: CFG.feeBasisPoints,
  windowMultiplier: CFG.pplns.windowMultiplier, maturity: CFG.pplns.maturity, log: () => {},
}).open();

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const rule = (s) => console.log(`\n${bold(s)}\n${'─'.repeat(74)}`);

// Raw SQL, because hand reconciliation means asking questions this file did not
// anticipate.
const raw = arg('sql');
if (raw) {
  for (const line of await store.sql(raw)) console.log(line);
  store.close();
  process.exit(0);
}

// ── shares ──────────────────────────────────────────────────────────────────
rule('SHARES — last 24 hours');
{
  const since = Date.now() - 24 * 3600 * 1000;
  const rows = await store.shareSummary(since);
  if (!rows.length) console.log(dim('  none'));
  const totalWeight = rows.reduce((a, r) => a + r.weight, 0n);
  for (const r of rows) {
    const pct = totalWeight > 0n ? Number(r.weight * 10000n / totalWeight) / 100 : 0;
    console.log(`  ${r.miner.padEnd(46)} ${String(r.shares).padStart(7)} shares  `
      + `${String(r.weight).padStart(14)} work  ${pct.toFixed(2).padStart(6)}%  `
      + dim(`last ${new Date(r.last).toISOString().slice(11, 19)}`));
  }
  if (rows.length) {
    console.log(dim(`  ${'─'.repeat(46)} ${String(rows.reduce((a, r) => a + r.shares, 0)).padStart(7)} shares  `
      + `${String(totalWeight).padStart(14)} work`));
    console.log(dim('  "work" is expected hashes (2^256 / share target). It is what PPLNS pays on,'));
    console.log(dim('  and why a miner with fewer shares at a harder target is not being short-changed.'));
  }
}

// ── blocks ──────────────────────────────────────────────────────────────────
rule('BLOCKS');
const blocks = await store.blocks();
{
  if (!blocks.length) console.log(dim('  none found yet'));
  for (const b of blocks) {
    const conf = b.confirmations === null ? dim('  conf ?') : `  conf ${String(b.confirmations).padStart(4)}`;
    const state = b.state === 'mature' ? 'MATURE  ' : b.state === 'orphaned' ? 'ORPHANED' : 'PENDING ';
    const eta = b.state === 'pending' && b.confirmations !== null
      ? dim(`  ${CFG.pplns.maturity - b.confirmations} blocks to maturity`) : '';
    console.log(`  ${String(b.height).padStart(7)}  ${state}${conf}  ${pcn(b.value).padStart(14)} PCN`
      + `  ${String(b.miners).padStart(3)} miners${eta}`);
    console.log(dim(`           ${b.hash}  found by ${b.finder}`));
    if (b.alarm) console.log(`           ${bold('*** ALARM ***')} ${b.alarm} — ledger unchanged, decide by hand`);
  }
}

// ── the reconciliation ──────────────────────────────────────────────────────
// The invariant, re-derived per block from the stored rows:
//
//     sum(payouts) + dust + fee  ==  coinbase value
//     fee                        ==  value * feeBasisPoints / 10000
//     each amount                ==  pot * weight / window_weight
//
// The third is the one worth the effort: it recomputes every individual share
// of the split from the weights stored on the rows themselves, so a payout that
// was mis-split at the time does not get to certify itself now.
rule('RECONCILIATION');
{
  let bad = 0;
  for (const b of blocks) {
    const rows = await store.sql(
      `SELECT miner, amount, weight, window_weight, pot FROM payouts `
      + `WHERE block_height=${b.height} AND block_hash='${b.hash}' ORDER BY miner;`);
    if (!rows.length) {
      console.log(`  ${b.height}  ${dim('no payout rows')}`);
      continue;
    }
    const parsed = rows.map((l) => {
      const [miner, amount, weight, windowWeight, pot] = l.split('|');
      return { miner, amount: BigInt(amount), weight: BigInt(weight), W: BigInt(windowWeight), pot: BigInt(pot) };
    });
    const problems = [];

    const paid = parsed.reduce((a, r) => a + r.amount, 0n);
    if (paid + b.dust + b.fee !== b.value) {
      problems.push(`sum ${paid} + dust ${b.dust} + fee ${b.fee} != value ${b.value}`);
    }
    const expectFee = feeOf(b.value, BigInt(CFG.feeBasisPoints));
    if (b.fee !== expectFee) problems.push(`fee ${b.fee} != ${CFG.feeBasisPoints}bp of ${b.value} (${expectFee})`);

    const W = parsed[0].W;
    const pot = parsed[0].pot;
    if (parsed.some((r) => r.W !== W || r.pot !== pot)) problems.push('rows disagree about the window or the pot');
    if (pot + b.fee !== b.value) problems.push(`pot ${pot} + fee ${b.fee} != value ${b.value}`);
    const sumWeights = parsed.reduce((a, r) => a + r.weight, 0n);
    if (sumWeights !== W) problems.push(`the miners' weights sum to ${sumWeights}, but window_weight says ${W}`);

    // Re-run the split from the stored weights and compare, row by row.
    const redone = splitPot(pot, parsed.map((r) => ({ miner: r.miner, weight: r.weight })));
    for (let i = 0; i < parsed.length; i++) {
      if (redone.amounts[i].amount !== parsed[i].amount) {
        problems.push(`${parsed[i].miner}: stored ${parsed[i].amount}, recomputes to ${redone.amounts[i].amount}`);
      }
    }
    if (redone.dust !== b.dust) problems.push(`dust ${b.dust} recomputes to ${redone.dust}`);

    if (problems.length) {
      bad++;
      console.log(`  ${bold('FAIL')} height ${b.height}`);
      for (const p of problems) console.log(`         ${p}`);
    } else {
      console.log(`  ok   height ${b.height}  ${pcn(b.value)} = ${pcn(paid)} to ${parsed.length} miners`
        + ` + ${pcn(b.fee)} fee + ${b.dust} sat dust`);
    }
  }
  if (!blocks.length) console.log(dim('  nothing to reconcile yet'));
  else console.log(bad ? `\n  ${bold(`${bad} block(s) DO NOT RECONCILE`)}` : '\n  every block reconciles to the satoshi');
}

// ── balances ────────────────────────────────────────────────────────────────
rule('BALANCES — nothing here has been sent');
{
  const bals = await store.balances();
  const only = arg('miner');
  const rows = only ? bals.filter((b) => b.miner === only) : bals;
  if (!rows.length) console.log(dim('  none'));
  console.log(dim(`  ${'miner'.padEnd(46)} ${'pending'.padStart(15)} ${'payable'.padStart(15)} ${'void'.padStart(13)}`));
  let tp = 0n, tv = 0n, to = 0n;
  for (const b of rows) {
    tp += b.pending; tv += b.payable; to += b.void;
    console.log(`  ${b.miner.padEnd(46)} ${pcn(b.pending).padStart(15)} ${pcn(b.payable).padStart(15)} ${pcn(b.void).padStart(13)}`);
  }
  if (rows.length) {
    console.log(dim(`  ${'─'.repeat(46)} ${pcn(tp).padStart(15)} ${pcn(tv).padStart(15)} ${pcn(to).padStart(13)}`));
    console.log('');
    console.log(dim(`  pending  the block is real, its coinbase is under ${CFG.pplns.maturity} confirmations`));
    console.log(dim('  payable  mature and owed. STEP 4 will send this. Step 3 never does.'));
    console.log(dim('  void     the block was orphaned. The work was real; the coins never were.'));
  }

  const fees = await store.sql('SELECT IFNULL(SUM(fee),0), IFNULL(SUM(dust),0) FROM pool_fees;');
  const [f, d] = fees[0].split('|');
  console.log(`\n  pool fee accrued ${pcn(f)} PCN  ${dim(`(+ ${d} sat of rounding dust)`)}`);
}

// ── the thing that must stay true ───────────────────────────────────────────
{
  const [sent] = await store.sql('SELECT COUNT(*) FROM payouts WHERE sent_txid IS NOT NULL;');
  console.log('');
  if (Number(sent) === 0) {
    console.log(bold('  STEP 3: nothing has been sent, and no code in this tree can send it.'));
  } else {
    console.log(bold(`  ${sent} payout(s) are marked SENT — that is step 4 code, and it should not be here yet.`));
  }
}

store.close();
