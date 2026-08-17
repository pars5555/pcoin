// Live settings for market.pc.am.
//
// These used to be `const`s in server.mjs, which meant every limit change was a
// deploy. They now live in a table so the admin panel can move them — but the
// code defaults below are still the source of truth for what a setting MEANS,
// its type, and its safe range.
//
// A stored value always wins over a changed default. That is the trap this
// estate has already been caught by twice (serviceCeiling, min_conf), so it is
// stated here rather than discovered later: editing a default in this file does
// NOT change a running install. Change it in the panel, or delete the row.
//
// Every setting is bounded. An admin panel is a form, forms get fat-fingered,
// and these numbers decide how much money can leave.

export const DEFS = {
  saleOpen:            { type: 'bool', def: true,
    label: 'Sales open', help: 'Master switch. Off means no new orders at all.' },
  buybackOpen:         { type: 'bool', def: false,
    label: 'Buyback open', help: 'Selling PCN back to us. Closed while the ladder is proven.' },
  minOrderUsd:         { type: 'num', def: 10,   min: 1,    max: 10000,
    label: 'Minimum order ($)', help: 'Below this the network fee dominates.' },
  maxOrderUsd:         { type: 'num', def: 2000, min: 10,   max: 100000,
    label: 'Maximum order ($)',
    help: 'A hard dollar ceiling, kept as a backstop. The real limit is the PCN cap below.' },
  maxOrderPcn:         { type: 'num', def: 2000, min: 1,    max: 100000,
    label: 'Maximum order (PCN)',
    // The old text quoted the retired $0.001 ladder ("$2,000 buys 57% of the
    // coins"). Under the live $0.015 floor the same $2,000 buys ~35%, so the
    // number an operator was shown while setting a cap was wrong by a factor of
    // 1.6 — on the page where that decision is made.
    help: 'The limit that actually matters. A cap in DOLLARS means something different at ' +
          'each end of the ladder: at the $0.015 floor $2,000 buys around a third of the ' +
          'inventory, and near the $10 top rung it buys a rounding error. A cap in COINS ' +
          'stays the same share of the ladder for its whole life.' },
  accountCapPcn:       { type: 'num', def: 12000, min: 1,   max: 1000000,
    label: 'Per-account cap (PCN)',
    help: 'Total PCN one account may buy within the window below. This is the limit that ' +
          'actually stops one person taking the ladder — a per-ORDER cap does not, because ' +
          'splitting into many small orders defeats it entirely.' },
  accountCapDays:      { type: 'num', def: 7,    min: 1,    max: 365,
    label: 'Per-account cap window (days)',
    help: 'A rolling window, not a calendar period, so nobody gets a fresh allowance at midnight.' },
  maxPendingOrders:    { type: 'num', def: 3,    min: 1,    max: 50,
    label: 'Max unpaid orders per account',
    help: 'Unpaid orders reserve PCN nobody else can buy.' },
  autoMaxUsd:          { type: 'num', def: 25,   min: 0,    max: 10000,
    label: 'Auto-send limit ($)',
    help: 'At or below this the server sends by itself. Above it, you send by hand. 0 disables auto-send.' },
  maxDivergencePct:    { type: 'num', def: 20,   min: 1,    max: 1000,
    label: 'Max price divergence (%)',
    help: 'Sales pause when the ladder price and the credit rate drift further apart than this.' },
  floatTargetPcn:      { type: 'num', def: 30000, min: 0,   max: 10000000,
    label: 'Hot wallet target (PCN)', help: 'Top the sending wallet up to here.' },
  floatWarnPcn:        { type: 'num', def: 24000, min: 0,   max: 10000000,
    label: 'Hot wallet warning (PCN)', help: 'Below this, Telegram nags every 10 minutes.' },
  floatStopPcn:        { type: 'num', def: 1000,  min: 0,   max: 10000000,
    label: 'Hot wallet floor (PCN)', help: 'Below this the server stops sending and queues everything.' },
  orderTtlHours:       { type: 'num', def: 24,   min: 1,    max: 720,
    label: 'Unpaid order lifetime (hours)',
    help: 'After this an unpaid order expires and its PCN goes back on the ladder.' },
  retireSpentCoins:    { type: 'bool', def: true,
    label: 'Retire spent coins',
    help: 'When customers spend PCN on the services, withdraw a matching share of the ladder from ' +
          'sale so usage lifts the price. The coins themselves stay in your treasury — this only ' +
          'takes inventory off the ladder.' },
  retireRatioPct:      { type: 'num', def: 10,   min: 0,    max: 100,
    label: 'Retire ratio (% of PCN spent)',
    help: 'A retired coin can never be sold for money, so this converts revenue into price. At ' +
          '100% and $100/day of spending the whole ladder is gone in about a fortnight with ' +
          'nobody having bought anything. At 10% it lasts around 150 days of usage.' },
  retireDailyCapPcn:   { type: 'num', def: 2000, min: 0,    max: 100000,
    label: 'Retire daily cap (PCN)',
    help: 'The most usage may take off the ladder in one UTC day, whatever arrives. 2,000 PCN is ' +
          '2% of the ladder — roughly two rungs, so the price can never leap on a single busy day.' },
  retireMinConf:       { type: 'num', def: 6,    min: 1,    max: 100,
    label: 'Retire confirmations',
    help: 'How deep a block must be before its payments count. Reorgs are routine on this chain, ' +
          'and inventory retired for a payment that later vanishes cannot be un-retired quietly.' },
  retireSystems:       { type: 'list', def: '', max: 20, kind: 'names',
    label: 'Systems whose spending counts',
    help: 'Which address pools count as customers SPENDING. The market’s own pool must never ' +
          'be here: payments there are people buying from us, not spending on a service.' },
  backingCapPcn:       { type: 'num', def: 0,    min: 0,    max: 100000000,
    label: 'Deliverable cap (PCN) — 0 = watch addresses instead',
    help: 'The maximum PCN the market may owe at once. Set this and the server stops trying to ' +
          'read your wallet: you know what you can deliver, it does not. Watching addresses ' +
          'looks smarter and is not — every spend you make sends change to a NEW address the ' +
          'server has never heard of, and the figure silently collapses. That happened twice.' },
  backingAddresses:    { type: 'list', def: '', max: 200,
    label: 'Backing addresses',
    help: 'One PCN address per line. Their combined balance, plus the hot wallet, is what the ' +
          'market may promise. A single address is not enough: change from your own spends lands ' +
          'on addresses the server cannot see, and the figure silently collapses.' },
};

// Deliberately a shape check, not a checksum: a malformed entry here only skews
// a balance total, it is never a payment destination, and being strict about
// something harmless is how an operator ends up editing the database by hand.
const ADDR_RE = /^pc1[02-9ac-hj-np-z]{20,80}$/;

export function makeSettings(pool, log = console) {
  const q = async (sql, args = []) => (await pool.query(sql, args))[0];
  let cache = Object.fromEntries(Object.entries(DEFS).map(([k, d]) => [k, d.def]));
  let loadedAt = 0;

  // The application database user deliberately has NO DDL rights — creating
  // tables is an install-time root action, so a compromised app cannot reshape
  // its own schema. That means CREATE TABLE fails here with error 1142 even
  // when the table already exists, so a privilege error is only fatal if the
  // table is genuinely missing. Anything else and we would refuse to start over
  // a permission we do not want in the first place.
  async function ensureTable() {
    try {
      await q(`CREATE TABLE IF NOT EXISTS settings (
                 k VARCHAR(64) NOT NULL,
                 v TEXT NOT NULL,
                 updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                   ON UPDATE CURRENT_TIMESTAMP,
                 PRIMARY KEY (k)
               ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    } catch (e) {
      try { await q(`SELECT 1 FROM settings LIMIT 1`); }
      catch { throw new Error(`the settings table is missing and this user cannot create it ` +
                              `(${e.message}). Create it as root — see contrib/market/README.md.`); }
      log.warn('[settings] no DDL rights, which is correct; the table already exists');
    }
  }

  function coerce(key, raw) {
    const d = DEFS[key];
    if (!d) throw new Error(`unknown setting ${key}`);
    if (d.type === 'list') {
      const items = String(raw ?? '').split(/[\s,;]+/).map(x => x.trim()).filter(Boolean);
      // Two kinds of list: PCN addresses, and plain system names.
      const re = d.kind === 'names' ? /^[a-z0-9_-]{1,32}$/i : ADDR_RE;
      const bad = items.filter(x => !re.test(x));
      if (bad.length) {
        throw new Error(d.kind === 'names'
          ? `not valid system names: ${bad.slice(0, 3).join(', ')}`
          : `not PCN addresses: ${bad.slice(0, 3).join(', ')}`);
      }
      if (items.length > (d.max || 200)) throw new Error(`at most ${d.max || 200} entries`);
      return [...new Set(items)].join('\n');       // de-duplicated, one per line
    }
    if (d.type === 'bool') {
      if (typeof raw === 'boolean') return raw;
      const s = String(raw).toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(s)) return true;
      if (['0', 'false', 'no', 'off', ''].includes(s)) return false;
      throw new Error(`${key} must be true or false`);
    }
    const n = Number(raw);
    if (!isFinite(n)) throw new Error(`${key} must be a number`);
    if (n < d.min || n > d.max) throw new Error(`${key} must be between ${d.min} and ${d.max}`);
    return n;
  }

  async function reload() {
    try {
      const rows = await q(`SELECT k, v FROM settings`);
      const next = Object.fromEntries(Object.entries(DEFS).map(([k, d]) => [k, d.def]));
      for (const r of rows) {
        if (!DEFS[r.k]) continue;                     // a setting that no longer exists
        try { next[r.k] = coerce(r.k, r.v); }
        catch (e) { log.warn(`[settings] ignoring bad stored ${r.k}: ${e.message}`); }
      }
      cache = next;
      loadedAt = Date.now();
    } catch (e) {
      // Keep the last known good set. A database blip must not silently reset
      // every limit in the system to its default.
      log.error('[settings] reload failed, keeping the previous values:', e.message);
    }
    return cache;
  }

  async function set(key, raw) {
    const val = coerce(key, raw);
    await q(`INSERT INTO settings (k, v) VALUES (?,?) ON DUPLICATE KEY UPDATE v = VALUES(v)`,
            [key, String(val)]);
    cache[key] = val;
    return val;
  }

  return {
    ensureTable, reload, set, coerce,
    get: key => cache[key],
    all: () => ({ ...cache }),
    loadedAt: () => loadedAt,
    defs: DEFS,
  };
}
