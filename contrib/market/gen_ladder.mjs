#!/usr/bin/env node
// Generate the PCoin market ladder and emit it as SQL.
//
// Spec (agreed, do not re-derive):
//   100,000 PCN total, 100 rungs, geometric prices 0.001 -> 10.00,
//   ratio 10000^(1/99) ~= +9.75%/rung, qty per rung random in [800,1400],
//   totals trued up so the sum is EXACTLY 100,000.
//
// The quantities are random but the generator is SEEDED, so the ladder is
// reproducible and auditable: re-running this prints byte-identical SQL. A
// ladder nobody can regenerate is a ladder nobody can check.

const N          = 100;
const TOTAL      = 100000;      // PCN
const P0         = 0.001;
const P_END      = 10.00;
const QMIN       = 800;
const QMAX       = 1400;
const SEED       = 0x5CA1AB1E;

// mulberry32 — small, deterministic, and does not depend on a Node version.
function rng(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// price_i = P0 * (P_END/P0)^(i/(N-1))  -> exactly P0 at i=0 and P_END at i=N-1.
const ratio = Math.pow(P_END / P0, 1 / (N - 1));
const priceAt = i => P0 * Math.pow(P_END / P0, i / (N - 1));

// Quantities: the spec is "~1,000 per rung, randomized 800-1,400". Those two
// halves fight: a UNIFORM draw on [800,1400] has mean 1,100, and over 100 rungs
// that is 110,000 PCN against a 100,000 budget. The true-up then claws 10,000
// back out of the tail, pinning the last ~20 rungs -- the most expensive ones --
// at the 800 floor. Inventory shifts into the cheap end and the agreed
// economics break: revenue lands at $91.5k, not $112.5k, and 50,000 PCN costs
// $767 instead of $1,064. The randomization must therefore be centred on 1,000,
// not on the midpoint of the band.
//
// A triangular distribution on [800,1400] with its mode AT 800 has mean
// (800 + 1400 + 800)/3 = exactly 1,000 while still spanning the whole stated
// band: most rungs are near 1,000 or below, a few are large. That satisfies
// "~1,000" and "randomized 800-1,400" simultaneously.
const triangular = (u, a, b) => b - (b - a) * Math.sqrt(1 - u);   // mode at a

// Second correction, for the same reason as the first. Revenue is
// sum(qty_i * price_i), and because prices span 4 orders of magnitude the top
// ten rungs carry more than half of it. With 100 INDEPENDENT draws the expected
// revenue is right ($112,554) but any single ladder misses it by whatever those
// few rungs happened to roll -- the first seed tried came in at $104,867, 7%
// light, purely because rungs 97-99 drew small. Expected-value-correct is not
// good enough when the ladder is drawn exactly once and then sold from.
//
// So the draw is STRATIFIED: each block of 10 consecutive rungs is given a
// budget of exactly 10,000 PCN. Every price decile therefore carries the same
// inventory, revenue lands within a fraction of a percent of the agreed figure,
// and the rung-to-rung sizes stay unpredictable -- which is the only thing the
// randomization was ever for.
const BLOCK = 10;

function quantities() {
  const rand = rng(SEED);
  const q = [];
  for (let b = 0; b < N / BLOCK; b++) {
    let left = TOTAL / (N / BLOCK);               // 10,000 PCN per block
    const block = [];
    for (let j = 0; j < BLOCK; j++) {
      const rest = BLOCK - j - 1;                 // rungs after this one, in-block
      // Clamp each draw so the REMAINING rungs can still be filled inside
      // [QMIN,QMAX]. Guarantees an exact block total with every rung in range --
      // no negative last rung, no rescaling out of band.
      const lo = Math.max(QMIN, left - QMAX * rest);
      const hi = Math.min(QMAX, left - QMIN * rest);
      const draw = triangular(rand(), QMIN, QMAX);
      // Integer PCN per rung keeps the sum exact without decimal drift.
      const v = rest === 0 ? left : Math.round(Math.min(Math.max(draw, lo), hi));
      block.push(v);
      left -= v;
    }
    if (left !== 0) throw new Error(`block ${b} true-up failed, ${left} left over`);

    // The feasibility clamp is applied left-to-right, so it always lands on the
    // END of a block: a run of small draws forces the last rungs up against the
    // 1,400 ceiling. Prices rise ~2.5x across a block, so that correlation
    // between size and position is worth real money -- it put rungs 98 and 99
    // both at 1,400 and pushed revenue 2.7% ABOVE the agreed figure. Shuffling
    // within the block breaks the correlation without touching the block total
    // (a permutation cannot change a sum), which makes revenue unbiased.
    for (let i = block.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [block[i], block[j]] = [block[j], block[i]];
    }
    q.push(...block);
  }
  return q;
}

const qty = quantities();
const price = Array.from({ length: N }, (_, i) => priceAt(i));

// ── checks that must hold before this is allowed to reach a database ────────
const sum = qty.reduce((a, b) => a + b, 0);
if (sum !== TOTAL) throw new Error(`inventory is ${sum}, must be ${TOTAL}`);
if (qty.some(v => v < QMIN || v > QMAX)) throw new Error('a rung is outside [800,1400]');
if (Math.abs(price[0] - P0) > 1e-12) throw new Error('first rung is not 0.001');
if (Math.abs(price[N - 1] - P_END) > 1e-9) throw new Error('last rung is not 10.00');

const revenue = qty.reduce((a, v, i) => a + v * price[i], 0);

// Walk the ladder spending PCN, mirroring the fill engine's arithmetic.
function takePcn(want) {
  let need = want, cost = 0, rungs = 0, marginal = null;
  for (let i = 0; i < N && need > 0; i++) {
    const t = Math.min(need, qty[i]);
    cost += t * price[i]; need -= t; rungs++;
    marginal = t < qty[i] ? price[i] : (i + 1 < N ? price[i + 1] : null);
  }
  return { filled: want - need, cost, rungs, avg: cost / (want - need), marginal };
}

if (process.argv.includes('--report')) {
  console.log(`rungs           ${N}`);
  console.log(`ratio/rung      ${((ratio - 1) * 100).toFixed(4)}%`);
  console.log(`inventory       ${sum.toLocaleString()} PCN`);
  console.log(`qty min/max     ${Math.min(...qty)} / ${Math.max(...qty)}`);
  console.log(`price first     ${price[0].toFixed(10)}`);
  console.log(`price last      ${price[N - 1].toFixed(10)}`);
  console.log(`revenue if all  $${revenue.toFixed(2)}  (avg $${(revenue / TOTAL).toFixed(6)}/PCN)`);
  const h = takePcn(50000);
  console.log(`\n-- handoff sanity check: buy 50,000 PCN --`);
  console.log(`rungs consumed  ${h.rungs}        (handoff: ~50)`);
  console.log(`total cost      $${h.cost.toFixed(2)}   (handoff: ~$1,064)`);
  console.log(`average price   ${h.avg.toFixed(6)}  (handoff: 0.0213)`);
  console.log(`marginal after  ${h.marginal.toFixed(6)}  (handoff: ~0.0954-0.1047)`);
  console.log(`\n-- first 5 and last 3 rungs --`);
  for (const i of [0, 1, 2, 3, 4, N - 3, N - 2, N - 1])
    console.log(`  #${String(i).padStart(3)}  ${price[i].toFixed(10)}  x ${qty[i]}`);
  process.exit(0);
}

// ── SQL ────────────────────────────────────────────────────────────────────
const rows = qty.map((v, i) =>
  `(${i},${price[i].toFixed(10)},${v.toFixed(8)})`).join(',\n  ');

console.log(`-- PCoin market ladder. Generated by gen_ladder.mjs, seed 0x${SEED.toString(16)}.
-- LADDER_SQL_BEGIN
-- ${N} rungs, ${TOTAL} PCN, ${P0} -> ${P_END}, +${((ratio - 1) * 100).toFixed(4)}%/rung.
-- Revenue if fully sold: $${revenue.toFixed(2)} (avg $${(revenue / TOTAL).toFixed(6)}/PCN).
-- Re-running the generator reproduces this file exactly.

CREATE TABLE IF NOT EXISTS ladder_rungs (
  rung_no      SMALLINT UNSIGNED NOT NULL,
  price        DECIMAL(18,10) NOT NULL,
  qty_total    DECIMAL(24,8)  NOT NULL,
  qty_sold     DECIMAL(24,8)  NOT NULL DEFAULT 0,
  qty_reserved DECIMAL(24,8)  NOT NULL DEFAULT 0,
  PRIMARY KEY (rung_no),
  -- The database refuses to oversell even if the application logic is wrong.
  -- This is the backstop, not the mechanism: the fill engine locks rows.
  CONSTRAINT ck_rung_nonneg  CHECK (qty_sold >= 0 AND qty_reserved >= 0),
  CONSTRAINT ck_rung_bounded CHECK (qty_sold + qty_reserved <= qty_total)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ladder_fills (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id   VARCHAR(40)    NOT NULL,
  rung_no    SMALLINT UNSIGNED NOT NULL,
  qty        DECIMAL(24,8)  NOT NULL,
  price      DECIMAL(18,10) NOT NULL,
  state      ENUM('reserved','sold','released') NOT NULL DEFAULT 'reserved',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  settled_at TIMESTAMP NULL DEFAULT NULL,
  PRIMARY KEY (id),
  -- One row per (order, rung) makes re-reserving an order a no-op instead of a
  -- second helping of inventory. NOWPayments retries; so does a flaky tunnel.
  UNIQUE KEY uq_order_rung (order_id, rung_no),
  KEY idx_order (order_id),
  KEY idx_state (state)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Rung seed. This INSERT is NOT idempotent on its own and must never be run
-- against a ladder that already has rows -- re-seeding would reset qty_sold and
-- hand the same inventory out twice. The caller (deploy_ladder.sh) checks
-- COUNT(*) = 0 first and refuses otherwise. Guarding in the shell rather than
-- with INSERT IGNORE is deliberate: IGNORE would silently skip exactly the
-- rungs whose counters had already moved, which is the case that matters.
INSERT INTO ladder_rungs (rung_no, price, qty_total) VALUES
  ${rows};
-- LADDER_SQL_END
`);
