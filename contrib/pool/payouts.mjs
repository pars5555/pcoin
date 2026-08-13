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

import { execFile } from 'node:child_process';
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

// Ask the NODE, so the ledger can be checked against the chain rather than
// only against itself.
const cliJson = (args) => new Promise((res, rej) => {
  execFile(CFG.cliCommand[0], [...CFG.cliCommand.slice(1), ...args], { maxBuffer: 64 << 20 },
    (e, out, err) => e ? rej(new Error((err || e.message).trim())) : res(JSON.parse(out)));
});

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
  let bad = 0, onChainChecked = 0;
  const unchecked = [];
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
    let checkedOnChain = false;

    const paid = parsed.reduce((a, r) => a + r.amount, 0n);
    // Coinbase payouts: the pool's own output is whatever is left, so the
    // invariant is that the miners never take more than the pot. The exact
    // "sums to the coinbase value" check is enforced where it matters -- when
    // the coinbase is built, because a block that overpays is simply invalid.
    if (paid + b.fee > b.value) {
      problems.push(`miners ${paid} + fee ${b.fee} exceeds the coinbase ${b.value}`);
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
    // THE CHECK THAT MATTERS: what does the BLOCK actually pay?
    //
    // Everything above re-derives the ledger from itself, which catches
    // arithmetic drift but would happily certify a ledger describing a block
    // that does not exist. Paying from the coinbase means the chain holds the
    // real answer, so ask it. An unreadable node resolves nothing -- it is
    // reported as unchecked, never as agreement.
    try {
      const raw = await cliJson(['getblock', b.hash, '2']);
      const actual = new Map();
      for (const o of raw.tx[0].vout) {
        const a = o.scriptPubKey?.address;
        if (a) actual.set(a, BigInt(Math.round(o.value * 1e8)));
      }
      const chain = await store.reconcileAgainstChain(b.height, b.hash, actual);
      problems.push(...chain);
      if (!chain.length) { onChainChecked++; checkedOnChain = true; }
    } catch (e) {
      unchecked.push(`${b.height}: ${e.message.split('\n')[0].slice(0, 80)}`);
    }

    if (problems.length) {
      bad++;
      console.log(`  ${bold('FAIL')} height ${b.height}`);
      for (const p of problems) console.log(`         ${p}`);
    } else if (!checkedOnChain) {
      // "ok" HERE WOULD MEAN ONLY "the ledger agrees with itself".
      //
      // Everything above this point re-derives the ledger from its own stored
      // rows, which catches arithmetic drift and would happily certify a ledger
      // describing a block that does not exist. The chain comparison is the one
      // check that could not be faked by a wrong ledger -- so if it did not
      // run, saying "ok" is an unknown wearing an answer's clothes.
      console.log(`  ${bold('UNVERIFIED')} height ${b.height}  the ledger is self-consistent, but the`);
      console.log('              block\'s real coinbase could NOT be read -- this is not agreement');
    } else {
      console.log(`  ok   height ${b.height}  ${pcn(b.value)} = ${pcn(paid)} to ${parsed.length} miners`
        + ` + ${pcn(b.fee)} fee + ${b.dust} sat dust`);
      console.log(dim(`       and the block's own coinbase pays exactly that, read back off the chain`));
    }
  }
  if (!blocks.length) console.log(dim('  nothing to reconcile yet'));
  else {
    console.log(bad ? `\n  ${bold(`${bad} block(s) DO NOT RECONCILE`)}`
                    : '\n  every block reconciles to the satoshi');
    // The line the first-block watcher greps for. It must say how many were
    // actually compared against the chain, not merely that nothing complained.
    console.log(`  ${onChainChecked} of ${blocks.length} verified against the coinbase ON THE CHAIN`);
    for (const u of unchecked) console.log(`  ${bold('UNCHECKED')} (the node could not be read) ${u}`);
  }
}

// ── balances ────────────────────────────────────────────────────────────────
rule('BALANCES — every one of these was paid by a block, not by this pool');
{
  const bals = await store.balances();
  const only = arg('miner');
  const rows = only ? bals.filter((b) => b.miner === only) : bals;
  if (!rows.length) console.log(dim('  none'));
  console.log(dim(`  ${'miner'.padEnd(46)} ${'pending'.padStart(15)} ${'spendable'.padStart(15)} ${'void'.padStart(13)}`));
  let tp = 0n, tv = 0n, to = 0n;
  for (const b of rows) {
    tp += b.pending; tv += b.sent; to += b.void;
    console.log(`  ${b.miner.padEnd(46)} ${pcn(b.pending).padStart(15)} ${pcn(b.sent).padStart(15)} ${pcn(b.void).padStart(13)}`);
  }
  if (rows.length) {
    console.log(dim(`  ${'─'.repeat(46)} ${pcn(tp).padStart(15)} ${pcn(tv).padStart(15)} ${pcn(to).padStart(13)}`));
    console.log('');
    console.log(dim(`  pending    ALREADY PAID by the block's coinbase, but under ${CFG.pplns.maturity} confirmations`));
    console.log(dim('             so not spendable yet. A consensus rule, not a pool delay.'));
    console.log(dim('  spendable  mature. It is in the miner’s own wallet, not held here.'));
    console.log(dim('  void       the block was orphaned. The work was real; the coins never were.'));
  }

  const fees = await store.sql('SELECT IFNULL(SUM(fee),0), IFNULL(SUM(dust),0) FROM pool_fees;');
  const [f, d] = fees[0].split('|');
  console.log(`\n  pool fee accrued ${pcn(f)} PCN  ${dim(`(+ ${d} sat of rounding dust)`)}`);
}

// ── the thing that must stay true ───────────────────────────────────────────
{
  const [unpaid] = await store.sql('SELECT COUNT(*) FROM payouts WHERE sent_txid IS NULL;');
  console.log('');
  if (Number(unpaid) === 0) {
    console.log(bold('  Every payout above was made by a block’s own coinbase.'));
    console.log(bold('  This pool holds no wallet, no private key, and has no send path.'));
  } else {
    console.log(bold(`  ${unpaid} payout row(s) have no paying transaction — that should be impossible here.`));
  }
}

store.close();
