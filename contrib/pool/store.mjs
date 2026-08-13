// PCoin mining pool — the share store and PPLNS payout computation.
//
//   *** STEP 3. PAYOUTS ARE COMPUTED AND RECORDED. NOTHING IS SENT. ***
//
// There is no send path in this file, deliberately. `payouts.sent_txid` exists
// in the schema and is written by nothing here; step 4 fills it in only after a
// week of reconciling these numbers by hand against the chain. DESIGN.md says
// "do not skip 3" and the reason is that a payout engine which has never been
// checked against a real week of shares is how a pool loses its operator's
// money rather than its users'.
//
// WHY SQLITE VIA THE CLI. The rest of the pool has no dependencies: block.mjs
// uses node:crypto, pool.mjs uses node:net, the validator is compiled from the
// vendored randomx. Node 18 on the build hosts has no `node:sqlite`, and the
// only alternative was a native npm module needing a toolchain on every host
// this ever runs on. So the store is one long-lived `sqlite3` process spoken to
// over stdin/stdout -- exactly the shape already proven for the validator in
// pool.mjs, for the same reason: process startup is the expensive part, so pay
// it once.
//
// THREE RULES THIS FILE ENFORCES, each of which is a lesson already paid for
// elsewhere in this project:
//
//   1. A share is acknowledged to the miner only AFTER it is durable. The write
//      is fsynced (synchronous=FULL) and its presence is confirmed by reading
//      the row back, not by "the call returned" (CLAUDE.md §7.6).
//   2. A failed or unreadable store operation resolves NOTHING. It never
//      becomes "share rejected" and never becomes "share accepted"; the caller
//      is told the truth and the miner is invited to retry (CLAUDE.md §7.1).
//   3. Integer satoshis only. Every amount in this file is a BigInt, and the
//      one place a float could sneak in silently -- a SQL integer literal above
//      2^63, which SQLite quietly stores as REAL -- is guarded explicitly.

import { spawn } from 'node:child_process';
import fs from 'node:fs';

const SENTINEL = '<<<END>>>';

// ── pure arithmetic ─────────────────────────────────────────────────────────
// Everything below is a pure function of BigInts so storetest.mjs can check the
// money math without a database, a node, or a network.

/**
 * A share's weight: the expected number of hashes needed to find it.
 *
 *     weight = 2^256 / share_target
 *
 * This, and not "one share = one point", is what makes PPLNS survive both
 * vardiff and LWMA. Two miners on different share targets contribute in
 * proportion to the work they actually did, and because PCoin retargets EVERY
 * BLOCK, a window that spans a retarget still weighs its shares correctly.
 *
 * Difficulty-1 (powLimit) was the obvious unit and is the wrong one here: at a
 * share factor of 50000 against this chain's difficulty a share is EASIER than
 * powLimit, so its difficulty-1 weight floors to 0 and the share becomes worth
 * nothing. 2^256 is above every possible target, so the weight is always >= 1.
 */
export function targetWeight(targetBE) {
  const t = typeof targetBE === 'bigint' ? targetBE : BigInt('0x' + Buffer.from(targetBE).toString('hex'));
  if (t <= 0n) throw new Error('share target is zero -- no hash can be below it');
  const w = (1n << 256n) / t;
  // THE SILENT FLOAT TRAP. SQLite integers are int64; a SQL literal larger than
  // that is parsed as REAL, with no error and no warning. An amount that became
  // a float somewhere in here would still print, still sum, and be quietly
  // wrong. Refuse loudly instead. 2^62 leaves ~1e12x headroom over this chain's
  // difficulty, so hitting it means something is wrong, not that we grew.
  if (w >= (1n << 62n)) {
    throw new Error(`share weight ${w} exceeds 2^62; a SQLite integer literal that large `
      + 'becomes a silent REAL. Refusing rather than storing a float.');
  }
  return w;
}

/** Pool fee, taken off the BLOCK REWARD. Never off a miner's balance. */
export function feeOf(value, basisPoints) {
  if (basisPoints < 0n || basisPoints > 10000n) throw new Error(`fee ${basisPoints}bp out of range`);
  return (value * basisPoints) / 10000n;
}

/**
 * Split `pot` across weighted entries, integer satoshis, exactly.
 *
 *     amount_i = pot * w_i / W        (floor)
 *     dust     = pot - sum(amount_i)
 *
 * The floors always lose a little; that remainder is `dust` and it goes to the
 * pool, alongside the fee. It is returned separately rather than folded in so
 * the reconciliation report can show it, because "the numbers nearly add up" is
 * the state this whole step exists to make impossible.
 *
 * INVARIANT, asserted here and re-asserted per block by payouts.mjs:
 *     sum(amounts) + dust == pot
 */
export function splitPot(pot, entries) {
  if (pot < 0n) throw new Error('negative pot');
  const total = entries.reduce((a, e) => a + e.weight, 0n);
  if (total <= 0n) throw new Error('window has zero total weight');
  const amounts = [];
  let paid = 0n;
  for (const e of entries) {
    if (e.weight < 0n) throw new Error('negative weight');
    const amount = (pot * e.weight) / total;   // BigInt division floors
    amounts.push({ miner: e.miner, weight: e.weight, amount });
    paid += amount;
  }
  const dust = pot - paid;
  if (dust < 0n) throw new Error(`split overpaid by ${-dust} -- arithmetic is wrong`);
  if (paid + dust !== pot) throw new Error('split does not reconcile');
  return { amounts, dust, windowWeight: total };
}

/**
 * Turn a PPLNS window into the coinbase's output set.
 *
 * THE POOL NEVER HOLDS ANYONE'S MONEY. Each miner is an output of the block
 * they helped find, so the chain pays them directly: no wallet on the server,
 * no private key, no send path, and no "did the payment land?" to get wrong.
 * Idempotency stops being a database constraint and becomes a property of the
 * chain -- the block either exists or it does not.
 *
 * Two rules that make it safe:
 *
 *   DUST. An output below the relay dust limit is non-standard and would make
 *   the block unrelayable. A miner under it is dropped from THIS block and
 *   nothing is lost: its shares are still in the window, so it accumulates and
 *   is paid by a later block. The split is then RECOMPUTED over who is left, so
 *   the dropped share goes to the other miners rather than to the pool. (That
 *   recompute cannot cascade -- removing an entry only ever makes the remaining
 *   amounts larger -- but it is still a second pass, and skipping it would hand
 *   the difference to the pool.)
 *
 *   EXACTNESS. The pool output is whatever is left, so the outputs sum to the
 *   coinbase value to the satoshi. Paying one satoshi more than
 *   subsidy+fees makes the block INVALID: found, submitted, rejected, work
 *   thrown away. Under-paying silently donates to nobody.
 *
 * @returns {{outputs, fee, dropped, windowWeight, paid}}
 */
export function buildPayoutOutputs({ value, feeBasisPoints, entries, scriptOf,
                                     poolScript, dustLimit = 294n }) {
  const V = BigInt(value);
  if (V <= 0n) throw new Error(`coinbase value ${value} is not positive`);
  const fee = feeOf(V, BigInt(feeBasisPoints));
  const pot = V - fee;

  let live = entries.filter((e) => e.weight > 0n);
  const dropped = [];
  let amounts = [];
  for (let pass = 0; pass < 64; pass++) {
    if (!live.length) { amounts = []; break; }
    const r = splitPot(pot, live);
    const under = r.amounts.filter((a) => a.amount < dustLimit);
    if (!under.length) { amounts = r.amounts; break; }
    for (const u of under) dropped.push({ miner: u.miner, wouldHave: u.amount });
    const drop = new Set(under.map((u) => u.miner));
    live = live.filter((e) => !drop.has(e.miner));
  }

  // Deterministic order, so two runs over the same window build byte-identical
  // coinbases. Sorted by address: any ordering works, an unstable one does not.
  amounts.sort((a, b) => (a.miner < b.miner ? -1 : a.miner > b.miner ? 1 : 0));

  const outputs = [];
  let paid = 0n;
  for (const a of amounts) {
    outputs.push({ miner: a.miner, script: scriptOf(a.miner), value: a.amount, weight: a.weight });
    paid += a.amount;
  }
  const poolValue = V - paid;                 // fee + rounding + anything dropped
  if (poolValue < 0n) throw new Error('payout outputs exceed the coinbase value');
  outputs.push({ miner: null, script: poolScript, value: poolValue });

  const total = outputs.reduce((s, o) => s + o.value, 0n);
  if (total !== V) throw new Error(`coinbase outputs sum to ${total}, not ${V}`);

  return {
    outputs, fee, dropped, paid,
    windowWeight: live.reduce((s, e) => s + e.weight, 0n),
  };
}

// ── the sqlite3 process ─────────────────────────────────────────────────────
class Sqlite {
  constructor(bin, path, onFatal) {
    this.path = path;
    this.onFatal = onFatal;
    this.p = spawn(bin, ['-batch', path], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.alive = true;
    this.q = [];
    this.rows = [];
    this.errBuf = '';
    // total_changes() is CUMULATIVE for the life of the connection, not the
    // count for the statement just run. Reading it as a per-statement count
    // made every insert look freshly written, including replays -- so a
    // duplicate share reported itself as newly recorded. Keep the running value
    // and hand callers the delta.
    this.lastTotal = 0;
    let buf = '';
    this.p.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (line.startsWith(SENTINEL)) {
          const w = this.q.shift();
          const rows = this.rows; this.rows = [];
          const err = this.errBuf.trim(); this.errBuf = '';
          if (w) {
            clearTimeout(w.timer);
            // sqlite3 reports errors on stderr and carries on to the next
            // statement, so the sentinel still arrives. Only one request is ever
            // in flight, so whatever stderr said belongs to this one.
            const total = Number(line.slice(SENTINEL.length));
            const changed = total - this.lastTotal;
            this.lastTotal = total;
            if (err) w.reject(new Error(err.split('\n')[0]));
            else w.resolve({ rows, totalChanges: total, changed });
          }
        } else {
          this.rows.push(line);
        }
      }
    });
    this.p.stderr.on('data', (d) => { this.errBuf += d.toString(); });
    this.p.on('exit', (code) => {
      this.alive = false;
      const e = new Error(`sqlite3 exited (${code})`);
      while (this.q.length) { const w = this.q.shift(); clearTimeout(w.timer); w.reject(e); }
      if (this.onFatal) this.onFatal(e);
    });
  }

  /**
   * Run SQL and return its rows, plus `changed`: how many rows this request
   * altered, as a delta of the connection's cumulative total_changes().
   *
   * A delta of 0 means the request changed nothing -- whether because it was an
   * OR IGNORE no-op or because it failed. Callers that care distinguish the two
   * by reading the row back, never by assuming.
   */
  run(sql) {
    if (!this.alive) return Promise.reject(new Error('store is not running'));
    return new Promise((resolve, reject) => {
      const w = { resolve, reject };
      // A request that never returns would stall every miner silently. Bound it.
      w.timer = setTimeout(() => {
        const i = this.q.indexOf(w);
        if (i >= 0) this.q.splice(i, 1);
        reject(new Error('store timed out after 15s'));
      }, 15000);
      this.q.push(w);
      this.p.stdin.write(`${sql}\nSELECT '${SENTINEL}'||total_changes();\n`);
    });
  }

  close() { this.alive = false; try { this.p.stdin.end(); this.p.kill(); } catch { /* gone */ } }
}

/** SQL string literal. Doubling the quote is SQLite's escape. */
const lit = (s) => {
  const v = String(s);
  if (/[\x00-\x1f]/.test(v)) throw new Error('control character in a SQL value');
  return `'${v.replace(/'/g, "''")}'`;
};
const num = (n) => {
  const v = BigInt(n);
  if (v >= (1n << 62n) || v <= -(1n << 62n)) throw new Error(`integer ${v} too large for a SQLite integer literal`);
  return v.toString();
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS shares (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       INTEGER NOT NULL,
  miner    TEXT    NOT NULL,
  session  TEXT    NOT NULL,
  job_id   TEXT    NOT NULL,
  nonce    TEXT    NOT NULL,
  height   INTEGER NOT NULL,
  weight   INTEGER NOT NULL,
  target   TEXT    NOT NULL,
  is_block INTEGER NOT NULL DEFAULT 0
);
-- The dedup key. pool.mjs also keeps an in-memory seen-set per job to avoid
-- paying 21.7 ms of RandomX for a replay, but THIS is what makes it true: the
-- memory set dies with the process and this does not.
CREATE UNIQUE INDEX IF NOT EXISTS shares_job_nonce ON shares(job_id, nonce);
CREATE INDEX IF NOT EXISTS shares_miner ON shares(miner);

CREATE TABLE IF NOT EXISTS blocks (
  hash          TEXT PRIMARY KEY,
  height        INTEGER NOT NULL,
  found_at      INTEGER NOT NULL,
  value         INTEGER NOT NULL,
  finder        TEXT    NOT NULL,
  share_id      INTEGER NOT NULL,
  state         TEXT    NOT NULL,     -- pending | mature | orphaned
  state_at      INTEGER NOT NULL,
  confirmations INTEGER,              -- NULL = never successfully read
  orphan_strikes INTEGER NOT NULL DEFAULT 0,
  alarm         TEXT                  -- set, never acted on: see evaluateBlocks
);

-- Idempotency key, exactly as the owner decided: (block_height, miner_address).
-- A recomputation for the same block is a no-op, so a retry after a lost
-- response cannot pay anyone twice.
CREATE TABLE IF NOT EXISTS payouts (
  block_height  INTEGER NOT NULL,
  miner         TEXT    NOT NULL,
  block_hash    TEXT    NOT NULL,
  amount        INTEGER NOT NULL,
  weight        INTEGER NOT NULL,     -- this miner's weight in the window
  window_weight INTEGER NOT NULL,     -- W: the whole window's weight
  pot           INTEGER NOT NULL,     -- value - fee
  computed_at   INTEGER NOT NULL,
  sent_txid     TEXT,                 -- STEP 4. Written by nothing in step 3.
  PRIMARY KEY (block_height, miner)
);

CREATE TABLE IF NOT EXISTS pool_fees (
  block_height INTEGER PRIMARY KEY,
  block_hash   TEXT    NOT NULL,
  value        INTEGER NOT NULL,      -- the whole coinbase
  fee          INTEGER NOT NULL,      -- value * bp / 10000
  dust         INTEGER NOT NULL       -- rounding remainder from the split
);
`;

// ── the store ───────────────────────────────────────────────────────────────
export class Store {
  /**
   * @param {object} o
   * @param {string} o.path        sqlite file
   * @param {string} [o.sqlite3]   path to the sqlite3 binary
   * @param {number} o.feeBasisPoints
   * @param {number} o.windowMultiplier   N = this x the work in one block
   * @param {number} o.maturity           coinbase maturity in blocks (100)
   * @param {function} [o.log]
   * @param {function} [o.onFatal]
   */
  constructor(o) {
    this.o = o;
    this.log = o.log || (() => {});
    this.feeBp = BigInt(o.feeBasisPoints);
    this.windowMultiplier = BigInt(o.windowMultiplier);
    this.maturity = BigInt(o.maturity);
    this.db = null;
  }

  async open() {
    this.db = new Sqlite(this.o.sqlite3 || 'sqlite3', this.o.path, this.o.onFatal);
    await this.db.run([
      '.mode list',
      '.headers off',
      // WAL so the reconciliation report can read while the pool writes.
      // synchronous=FULL so "recorded" means fsynced, not "in a buffer" -- this
      // is the difference between a crash losing nothing and a crash losing the
      // shares a miner has already been told were accepted.
      'PRAGMA journal_mode=WAL;',
      'PRAGMA synchronous=FULL;',
      'PRAGMA busy_timeout=5000;',
      SCHEMA,
    ].join('\n'));
    await this.migrate();
    const [n] = (await this.db.run('SELECT COUNT(*) FROM shares;')).rows;
    this.log(`store ${this.o.path}: ${n} share(s) already recorded`);
    return this;
  }

  /**
   * CREATE TABLE IF NOT EXISTS does nothing to a table that already exists, so
   * a column added later never appears in a ledger that has already been
   * opened once. Add them explicitly. Deliberately additive only: this file
   * will never drop or rewrite a column in a ledger of who is owed what.
   */
  async migrate() {
    const have = (await this.db.run("SELECT name FROM pragma_table_info('blocks');")).rows;
    for (const [col, decl] of [['alarm', 'TEXT']]) {
      if (!have.includes(col)) {
        await this.db.run(`ALTER TABLE blocks ADD COLUMN ${col} ${decl};`);
        this.log(`store: added blocks.${col}`);
      }
    }
  }

  close() { if (this.db) this.db.close(); }

  /**
   * Record one accepted share, durably.
   *
   * Returns {id, fresh}. `fresh` false means this exact (job_id, nonce) was
   * already stored -- a replay, or our own retry after a lost response. Either
   * way it is a no-op and it is NOT an error.
   *
   * THROWS if the share could not be stored. The caller must then not
   * acknowledge it: a share the pool cannot record is a share the pool will not
   * pay, and telling the miner "OK" for it is the exact shape of the bug this
   * project has already paid for three times.
   */
  async recordShare({ at, miner, session, jobId, nonce, height, targetHex }) {
    const weight = targetWeight(Buffer.from(targetHex, 'hex'));
    const key = `job_id=${lit(jobId)} AND nonce=${lit(nonce)}`;
    const r = await this.db.run(
      `INSERT OR IGNORE INTO shares (at,miner,session,job_id,nonce,height,weight,target) VALUES (`
      + `${num(at)},${lit(miner)},${lit(session)},${lit(jobId)},${lit(nonce)},${num(height)},${num(weight)},${lit(targetHex)});\n`
      + `SELECT id FROM shares WHERE ${key};`);
    // VERIFY BY CONTENT, NOT BY "THE CALL RETURNED" (CLAUDE.md §7.6). An empty
    // result means the row is not there, whatever the insert appeared to do.
    if (!r.rows.length) throw new Error('share insert reported no error but the row is not there');
    return { id: Number(r.rows[0]), fresh: r.changed > 0, weight };
  }

  async markShareIsBlock(id) {
    await this.db.run(`UPDATE shares SET is_block=1 WHERE id=${num(id)};`);
  }

  /**
   * The PPLNS window: the most recent shares, walking backwards from the share
   * that found the block, until their weights sum to N.
   *
   *     N = windowMultiplier x (2^256 / network_target)
   *
   * i.e. N is a multiple of the work one block is expected to take, not a share
   * count. That is what makes it self-adjusting: LWMA retargets every block, and
   * a fixed share count would silently mean "half a round" after a difficulty
   * doubling.
   *
   * The share that straddles the boundary is included whole. Early on, before N
   * shares exist, W < N and the pot is still distributed in full -- everyone in
   * the window simply gets a larger slice, which is correct.
   */
  /**
   * The PPLNS window as of right now, for building a template's coinbase.
   *
   * Coinbase payouts have to decide the split when the TEMPLATE is built, not
   * when the nonce is found, because the coinbase is committed to by the merkle
   * root. So the window is snapshotted every template refresh (~2 s). A share
   * submitted a second before the block lands may therefore miss that block and
   * be paid by the next one -- inherent to paying from the coinbase, and the
   * shares are not lost, only deferred.
   */
  async currentWindow(netTargetHex) {
    const [maxId] = (await this.db.run('SELECT IFNULL(MAX(id),0) FROM shares;')).rows;
    if (Number(maxId) === 0) return { entries: [], N: 0n, blockWork: 0n };
    return this.pplnsWindow(Number(maxId), netTargetHex);
  }

  async pplnsWindow(lastShareId, netTargetHex) {
    const blockWork = targetWeight(Buffer.from(netTargetHex, 'hex'));
    const N = blockWork * this.windowMultiplier;
    const r = await this.db.run(
      `SELECT miner, SUM(weight), COUNT(*) FROM (`
      + `  SELECT miner, weight, SUM(weight) OVER (ORDER BY id DESC ROWS UNBOUNDED PRECEDING) AS cum`
      + `  FROM shares WHERE id <= ${num(lastShareId)}`
      + `) WHERE cum - weight < ${num(N)} GROUP BY miner ORDER BY 2 DESC;`);
    const entries = r.rows.map((line) => {
      const [m, w, n] = line.split('|');
      return { miner: m, weight: BigInt(w), shares: Number(n) };
    });
    return { entries, N, blockWork };
  }

  /**
   * A block we found: record it and compute what it owes, once.
   *
   * Returns {computed:true, ...} the first time and {computed:false, reason}
   * on any repeat, so the caller can log the difference honestly.
   */
  /**
   * A block we found, whose COINBASE already paid everyone.
   *
   * There is nothing to send and nothing to compute after the fact: the split
   * was fixed when the template was built and is now on the chain. This records
   * what that coinbase paid so it can be reconciled against the block itself.
   *
   * `sent_txid` is set to the coinbase txid immediately, because it genuinely
   * has been paid -- by the block. That is the whole point of this design: the
   * "computed but not sent" state, and every retry hazard that came with it,
   * does not exist.
   *
   * Note what is deliberately NOT duplicated from recordBlockAndComputePayouts:
   * the two-blocks-at-one-height guard. It mattered there because the ledger
   * decided who got sent money. Here the ledger decides nothing -- the chain
   * already paid -- so a wrong row is a bookkeeping error, and
   * reconcileAgainstChain() catches exactly that by comparing against the
   * block's real outputs. A guard that cannot prevent a payment error is not
   * worth the code it takes to get wrong.
   */
  async recordBlockPaidByCoinbase({ hash, height, value, finder, shareId, at,
                                    coinbaseTxid, outputs, fee, windowWeight }) {
    const V = BigInt(value);
    await this.db.run(
      `INSERT OR IGNORE INTO blocks (hash,height,found_at,value,finder,share_id,state,state_at) VALUES (`
      + `${lit(hash)},${num(height)},${num(at)},${num(V)},${lit(finder)},${num(shareId)},'pending',${num(at)});`);

    const paid = outputs.filter((o) => o.miner);
    const rows = paid.map((o) =>
      `(${num(height)},${lit(o.miner)},${lit(hash)},${num(o.value)},${num(o.weight || 0)},`
      + `${num(windowWeight || 0)},${num(V - fee)},${num(at)},${lit(coinbaseTxid)})`);

    if (rows.length) {
      await this.db.run(
        'BEGIN IMMEDIATE;\n'
        + 'INSERT OR IGNORE INTO payouts (block_height,miner,block_hash,amount,weight,window_weight,pot,computed_at,sent_txid) VALUES\n'
        + rows.join(',\n') + ';\n'
        + `INSERT OR IGNORE INTO pool_fees (block_height,block_hash,value,fee,dust) VALUES (`
        + `${num(height)},${lit(hash)},${num(V)},${num(fee)},0);\n`
        + 'COMMIT;');
    } else {
      await this.db.run(
        `INSERT OR IGNORE INTO pool_fees (block_height,block_hash,value,fee,dust) VALUES (`
        + `${num(height)},${lit(hash)},${num(V)},${num(fee)},0);`);
    }

    // Read it back. The rows are the product; "the INSERT returned" is not.
    const check = await this.db.run(
      `SELECT COUNT(*), IFNULL(SUM(amount),0) FROM payouts WHERE block_height=${num(height)};`);
    const [cnt, sum] = check.rows[0].split('|');
    return { height, hash, value: V, fee, miners: Number(cnt), paid: BigInt(sum) };
  }

  /**
   * Reconcile a block against the CHAIN, not against this database.
   *
   * The stored rows say what the coinbase was built to pay. `actual` is what
   * the node reports that block's coinbase outputs actually are. If those
   * disagree, the ledger is describing a block that does not exist.
   */
  async reconcileAgainstChain(height, hash, actualOutputs) {
    const rows = await this.sql(
      `SELECT miner, amount FROM payouts WHERE block_height=${num(height)} AND block_hash=${lit(hash)};`);
    const problems = [];
    const want = new Map();
    for (const line of rows) {
      const [m, a] = line.split('|');
      want.set(m, BigInt(a));
    }
    for (const [addr, amt] of want) {
      const got = actualOutputs.get(addr);
      if (got === undefined) problems.push(`${addr}: ledger says ${amt}, the block pays it nothing`);
      else if (got !== amt) problems.push(`${addr}: ledger says ${amt}, the block pays ${got}`);
    }
    return problems;
  }

  async recordBlockAndComputePayouts({ hash, height, value, finder, shareId, netTargetHex, at }) {
    const V = BigInt(value);
    if (V <= 0n) throw new Error(`coinbase value ${value} is not positive`);

    await this.db.run(
      `INSERT OR IGNORE INTO blocks (hash,height,found_at,value,finder,share_id,state,state_at) VALUES (`
      + `${lit(hash)},${num(height)},${num(at)},${num(V)},${lit(finder)},${num(shareId)},'pending',${num(at)});`);

    // Idempotency, and the one genuinely awkward case underneath it.
    const existing = await this.db.run(
      `SELECT DISTINCT block_hash FROM payouts WHERE block_height=${num(height)};`);
    if (existing.rows.length) {
      const other = existing.rows[0];
      if (other === hash) return { computed: false, reason: 'already computed for this block' };
      // Two of OUR blocks at one height. Only one can be on the active chain, so
      // only one may pay -- but the idempotency key the owner chose is
      // (block_height, miner_address), so the loser's rows are in the way.
      // Resolve it ONLY when the chain has already said the other one lost.
      const st = await this.db.run(`SELECT state FROM blocks WHERE hash=${lit(other)};`);
      if (st.rows[0] === 'orphaned') {
        this.log(`height ${height}: replacing payouts from orphaned block ${other.slice(0, 16)}…`);
        await this.db.run(
          `DELETE FROM payouts WHERE block_height=${num(height)};\n`
          + `DELETE FROM pool_fees WHERE block_height=${num(height)};`);
      } else {
        // UNKNOWN RESOLVES NOTHING. Do not guess which one wins, and do not
        // overwrite a payout row on a hunch.
        this.log(`UNRESOLVED height ${height}: payouts exist for ${other.slice(0, 16)}… `
          + `(state ${st.rows[0] || 'unknown'}) and we also found ${hash.slice(0, 16)}…. `
          + 'Computing nothing until the chain resolves it.');
        return { computed: false, reason: 'height collision, unresolved' };
      }
    }

    const { entries, N, blockWork } = await this.pplnsWindow(shareId, netTargetHex);
    if (!entries.length) throw new Error('block found but the PPLNS window is empty');

    // 2% OFF THE BLOCK REWARD, NEVER OFF A BALANCE. 50 PCN found -> 49 into
    // PPLNS, 1 to the pool. A fee that can make an accrued balance go down is
    // the kind of thing people screenshot.
    const fee = feeOf(V, this.feeBp);
    const pot = V - fee;
    const { amounts, dust, windowWeight } = splitPot(pot, entries);

    const paid = amounts.reduce((a, x) => a + x.amount, 0n);
    // The reconciliation invariant. If this ever fails, nothing is written.
    if (paid + dust + fee !== V) {
      throw new Error(`payout does not reconcile: ${paid} + ${dust} + ${fee} != ${V}`);
    }

    const rows = amounts.map((x) =>
      `(${num(height)},${lit(x.miner)},${lit(hash)},${num(x.amount)},${num(x.weight)},`
      + `${num(windowWeight)},${num(pot)},${num(at)},NULL)`);
    await this.db.run(
      'BEGIN IMMEDIATE;\n'
      + 'INSERT OR IGNORE INTO payouts (block_height,miner,block_hash,amount,weight,window_weight,pot,computed_at,sent_txid) VALUES\n'
      + rows.join(',\n') + ';\n'
      + `INSERT OR IGNORE INTO pool_fees (block_height,block_hash,value,fee,dust) VALUES (`
      + `${num(height)},${lit(hash)},${num(V)},${num(fee)},${num(dust)});\n`
      + 'COMMIT;');

    // Read it back. The rows are the product; "the INSERT returned" is not.
    const check = await this.db.run(
      `SELECT COUNT(*), IFNULL(SUM(amount),0) FROM payouts WHERE block_height=${num(height)};`);
    const [cnt, sum] = check.rows[0].split('|');
    if (Number(cnt) !== amounts.length || BigInt(sum) !== paid) {
      throw new Error(`payouts did not store as computed: ${cnt} rows summing ${sum}, expected ${amounts.length}/${paid}`);
    }

    return {
      computed: true, height, hash, value: V, fee, dust, pot,
      windowWeight, N, blockWork, amounts, shares: entries,
    };
  }

  /**
   * Maturity and orphan detection.
   *
   * @param tipHeight  null if the node could not be read
   * @param hashAt     async (height) => hash | null   (null = could not read)
   *
   * Nothing here ever resolves a block on a failed read. An unreadable node
   * leaves every block exactly as it was, which is the only honest answer and
   * costs one more pass a minute later.
   */
  async evaluateBlocks(tipHeight, hashAt, now = Date.now()) {
    if (tipHeight === null || tipHeight === undefined) {
      return { skipped: 'tip unreadable' };
    }
    const tip = BigInt(tipHeight);
    // MATURE BLOCKS ARE RE-CHECKED TOO, not just pending ones. Maturity is a
    // depth, not a proof: a block 100 deep can still leave the chain, and a
    // pool that stopped looking would keep a payable balance for coins that no
    // longer exist. Reorgs are routine here -- the live chain has carried a ~3%
    // stale rate (CLAUDE.md §10.12) -- so "it matured, we are done" is not a
    // safe assumption to bake in.
    const r = await this.db.run(
      "SELECT hash, height, orphan_strikes, state FROM blocks WHERE state IN ('pending','mature') ORDER BY height;");
    const out = { matured: [], dematured: [], orphaned: [], alarms: [], pending: 0, unreadable: 0 };
    for (const line of r.rows) {
      const [hash, hs, strikesRaw, was] = line.split('|');
      const h = BigInt(hs);
      const strikes = Number(strikesRaw);
      const confs = tip - h + 1n;

      const actual = await hashAt(Number(h));
      if (actual === null || actual === undefined) {
        // Unreadable. Not orphaned, not mature, not a strike.
        out.unreadable++;
        continue;
      }

      if (actual !== hash) {
        // Seen once is a reorg in progress or a stale read; seen twice is an
        // answer. The same two-observation rule the forwarding engine uses for
        // a negative confirmation count (CLAUDE.md §7.2).
        if (strikes + 1 < 2) {
          await this.db.run(`UPDATE blocks SET orphan_strikes=${num(strikes + 1)} WHERE hash=${lit(hash)};`);
          out.pending++;
          continue;
        }
        // DETECT A REORG, BUT NEVER AUTO-REVERSE A CREDIT. If any of this
        // block's payouts have actually been sent -- which nothing in step 3
        // can do, and step 4 will -- the coins are gone and clawing back a
        // balance is not the pool's call to make silently. Raise it and leave
        // the ledger alone. Only an unsent block may be voided automatically.
        const [sent] = (await this.db.run(
          `SELECT COUNT(*) FROM payouts WHERE block_hash=${lit(hash)} AND sent_txid IS NOT NULL;`)).rows;
        if (Number(sent) > 0) {
          const msg = `left the chain at ${confs} confirmations AFTER ${sent} payout(s) were sent`;
          await this.db.run(`UPDATE blocks SET alarm=${lit(msg)} WHERE hash=${lit(hash)};`);
          out.alarms.push({ hash, height: Number(h), message: msg });
          continue;
        }
        await this.db.run(
          `UPDATE blocks SET state='orphaned', state_at=${num(now)}, confirmations=${num(confs)} `
          + `WHERE hash=${lit(hash)};`);
        out.orphaned.push({ hash, height: Number(h), wasMature: was === 'mature' });
        continue;
      }

      // On the active chain. Clear any strike -- a chain that came back is not
      // half-orphaned.
      if (confs >= this.maturity) {
        await this.db.run(
          `UPDATE blocks SET state='mature', state_at=${num(now)}, confirmations=${num(confs)}, `
          + `orphan_strikes=0, alarm=NULL WHERE hash=${lit(hash)};`);
        if (was !== 'mature') out.matured.push({ hash, height: Number(h) });
      } else {
        // Not deep enough -- or not any more. "payable" has to mean "spendable
        // now", so a block a reorg pushed back under the maturity depth returns
        // to pending rather than latching at mature. Otherwise the report would
        // call coins payable that the wallet would refuse to spend, and step 4
        // would read that as permission.
        if (was === 'mature') out.dematured.push({ hash, height: Number(h), confirmations: Number(confs) });
        await this.db.run(
          `UPDATE blocks SET state='pending', confirmations=${num(confs)}, orphan_strikes=0, alarm=NULL `
          + `WHERE hash=${lit(hash)};`);
        out.pending++;
      }
    }
    return out;
  }

  // ── reads, for the operator ───────────────────────────────────────────────

  async stats() {
    const r = await this.db.run(
      'SELECT (SELECT COUNT(*) FROM shares), (SELECT COUNT(*) FROM blocks),'
      + " (SELECT COUNT(*) FROM blocks WHERE state='pending'),"
      + " (SELECT COUNT(*) FROM blocks WHERE state='mature'),"
      + " (SELECT COUNT(*) FROM blocks WHERE state='orphaned'),"
      + ' (SELECT IFNULL(SUM(amount),0) FROM payouts);');
    const [shares, blocks, pending, mature, orphaned, owed] = r.rows[0].split('|');
    return {
      shares: Number(shares), blocks: Number(blocks),
      pending: Number(pending), mature: Number(mature), orphaned: Number(orphaned),
      computed: BigInt(owed),
    };
  }

  /**
   * Per-miner balances, split by the state of the block each payout came from.
   *
   *   pending  — already paid by the block's coinbase, but that coinbase is
   *               under 100 confirmations so nobody can spend it yet
   *   paid     — mature and spendable, sitting in the miner's own wallet
   *   void     — the block was orphaned; the work was real, the coins never were
   *
   * There is no "owed" state, because the pool never owes anyone anything: the
   * block paid them. PENDING IS STILL SHOWN, NOT HIDDEN -- a miner who cannot
   * see the ~17 hours of immaturity reports it as a bug, and is not wrong to.
   */
  async balances() {
    const r = await this.db.run(
      'SELECT p.miner, b.state, IFNULL(p.sent_txid,\'\'), SUM(p.amount), COUNT(*)'
      + ' FROM payouts p JOIN blocks b ON b.hash = p.block_hash'
      + ' GROUP BY p.miner, b.state, p.sent_txid IS NULL ORDER BY p.miner;');
    const byMiner = new Map();
    for (const line of r.rows) {
      const [miner, state, txid, sum] = line.split('|');
      const e = byMiner.get(miner) || { miner, pending: 0n, payable: 0n, sent: 0n, void: 0n };
      const amt = BigInt(sum);
      // Order matters: with coinbase payouts sent_txid is ALWAYS set, so
      // checking it first would report an immature block as spendable. The
      // block's state is what decides, not whether a txid exists.
      if (state === 'orphaned') e.void += amt;
      else if (state === 'mature') e.sent += amt;      // paid AND spendable
      else e.pending += amt;                            // paid, not yet spendable
      byMiner.set(miner, e);
    }
    return [...byMiner.values()];
  }

  async blocks() {
    const r = await this.db.run(
      'SELECT b.height, b.hash, b.state, IFNULL(b.confirmations,-1), b.value, b.finder, b.found_at,'
      + ' IFNULL((SELECT SUM(amount) FROM payouts WHERE block_height=b.height AND block_hash=b.hash),0),'
      + ' IFNULL((SELECT fee FROM pool_fees WHERE block_height=b.height),0),'
      + ' IFNULL((SELECT dust FROM pool_fees WHERE block_height=b.height),0),'
      + ' IFNULL((SELECT COUNT(*) FROM payouts WHERE block_height=b.height AND block_hash=b.hash),0),'
      + " IFNULL(b.alarm,'')"
      + ' FROM blocks b ORDER BY b.height;');
    return r.rows.map((line) => {
      const [height, hash, state, confs, value, finder, foundAt, paid, fee, dust, miners, alarm] = line.split('|');
      return {
        height: Number(height), hash, state,
        confirmations: Number(confs) < 0 ? null : Number(confs),
        value: BigInt(value), finder, foundAt: Number(foundAt),
        paid: BigInt(paid), fee: BigInt(fee), dust: BigInt(dust), miners: Number(miners),
        alarm: alarm || null,
      };
    });
  }

  async shareSummary(sinceMs) {
    const r = await this.db.run(
      `SELECT miner, COUNT(*), SUM(weight), MAX(at) FROM shares WHERE at >= ${num(sinceMs)} GROUP BY miner ORDER BY 3 DESC;`);
    return r.rows.map((line) => {
      const [miner, n, w, last] = line.split('|');
      return { miner, shares: Number(n), weight: BigInt(w), last: Number(last) };
    });
  }

  /** Raw access, for hand reconciliation. */
  async sql(text) { return (await this.db.run(text)).rows; }
}

/** Convenience for scripts: satoshis -> a PCN string, integer arithmetic only. */
export function pcn(sats) {
  const v = BigInt(sats);
  const neg = v < 0n;
  const a = neg ? -v : v;
  return (neg ? '-' : '') + (a / 100000000n) + '.' + (a % 100000000n).toString().padStart(8, '0');
}

export function loadConfig(path) {
  const cfg = JSON.parse(fs.readFileSync(path, 'utf8'));
  // The fee is converted to basis points ONCE, here, on a config constant --
  // not per payout. Everything downstream of this line is integer-only.
  const bp = cfg.feeBasisPoints !== undefined
    ? cfg.feeBasisPoints
    : Math.round((cfg.feePercent ?? 0) * 100);
  if (!Number.isInteger(bp) || bp < 0 || bp > 10000) {
    throw new Error(`fee resolves to ${bp} basis points, which is not a whole number in 0..10000`);
  }
  cfg.feeBasisPoints = bp;
  return cfg;
}
