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
  // ── where an order came from ──────────────────────────────────────────
  // Turns the IP we already record into a country and city for the operator's
  // alert and the admin panel. Decoration on a money path: if any of this is
  // wrong or the service is down, orders must proceed untouched.
  geoipEnabled:        { type: 'bool', def: true,
                         help: 'Look up the country/city for the IP behind each order.' },
  geoipBaseUrl:        { type: 'str', def: 'https://geoip.pc.am', max: 200,
                         re: /^https?:\/\/[\w.\-]+(:\d{1,5})?(\/\S*)?$/,
                         help: 'GeoIP API base. NOTE geoip.pc.am serves only the marketing site; '
                             + 'the API answers on this host and port, over plain HTTP.' },
  geoipKey:            { type: 'str', def: '', max: 128,
                         help: 'GeoIP API key. Sent as the X-API-Key header, never in the query string.' },
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
  orderTtlHours:       { type: 'num', def: 2,    min: 1,    max: 720,
    label: 'Unpaid order lifetime (hours)',
    help: 'After this an unpaid order expires and its PCN goes back on the ladder. Short is ' +
          'kinder to everyone else: an unpaid order holds rungs, and enough of them push the ' +
          'price a real buyer would pay past the divergence limit, which closes the market.' },
  maxOrdersPerHour:    { type: 'num', def: 3,    min: 1,    max: 100,
    label: 'New orders per email per hour',
    help: 'How many orders one email may START in a rolling hour, whatever became of them. ' +
          'maxPendingOrders bounds how many exist at once; this bounds the churn. One address ' +
          'created seven orders over two days and paid for none, and each one reserved rungs.' },
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
  ammK:                { type: 'num', def: 0, min: 0, max: 1e15, step: 0.00000001,
    label: 'Constant-product k \u2014 0 = off, fall back to rung pricing',
    help: 'The invariant of the pricing curve: price = k / X^2 where X is the PCN still for ' +
          'sale plus ammVirtualPcn. It was set ONCE by hand when the curve was switched on, ' +
          'from the inventory and price at that moment so the price did not jump; since ' +
          '2026-09-19 `cap-policy.mjs --curve --apply` also re-anchors it, DOWNWARD ONLY, to ' +
          'follow the wPCN pool — rate-limited per run and per day, and never below ' +
          'ladderMinPriceUsd. Editing it here sets the price directly: price = k / X^2, so ' +
          'k = price * X^2. Selling lowers X and raises the price; so ' +
          'does retire-on-spend, which is how spending PCN at a service moves the price with no ' +
          'separate mechanism. 0 disables the curve and the ladder prices by rungs again.' },
  ammVirtualPcn:       { type: 'num', def: 0, min: 0, max: 1e9, step: 0.00000001,
    label: 'Constant-product virtual depth (PCN)',
    help: 'Added to the real inventory when pricing, and to nothing else \u2014 it is never ' +
          'sold and never delivered. It is the only knob on steepness: larger means a gentler ' +
          'price impact per dollar, smaller means orders move the price harder and hit the ' +
          'divergence gate sooner. It does NOT change the current price, only the slope.' },
  ladderMaxPriceUsd:   { type: 'num', def: 0, min: 0, max: 10, step: 0.0000000001,
    label: 'Ladder price cap (USD) — 0 = off',
    help: 'Sell at min(rung price, this). PCN can only be SOLD by wrapping it and selling wPCN, ' +
          'so when that pool trades below the ladder the rungs are asking more than the market ' +
          'pays, and a buyer here would lose the difference the moment they spent the coins. ' +
          'Set this to about the wPCN price to close that gap. It is a NUMBER YOU SET, never ' +
          'read from the pool: the pool holds ~$1,300 and a dump into it is reversible, so ' +
          'letting it drive this would sell the book at a 98% discount for under a dollar.' },
  ladderMinPriceUsd:   { type: 'num', def: 0.025, min: 0, max: 10, step: 0.0000000001,
    label: 'Ladder price FLOOR (USD) — the lowest PCN is ever sold for',
    help: 'THE hard bottom on the ask, and since 2026-09-19 it is enforced on BOTH pricing ' +
          'paths — it clamps ladderMaxPriceUsd on the rung path, and it clamps the ' +
          'constant-product curve inside ladder.mjs. Until that date it only did the former, ' +
          'and because the curve had been in force since 077fa32 the market had no floor at ' +
          'all while it was. It matters more now: cap-policy.mjs --curve walks the ask DOWN ' +
          'after the wPCN pool on a schedule, that pool holds about $650, pushing it down is ' +
          'cheap and reversible, and this number is the bound on what that can cost. Raise it ' +
          'to be more conservative; only lower it deliberately. 0 disables it — do not.' },
  // ── price plan Step 3: the market prices off the PCN index ──────────────
  // D:\pc.am\PCOIN-PRICE-EXCHANGE-ANCHOR-PLAN.md §5 Step 3. Owner, 2026-09-24:
  // one anchor, "the average price of real trading on exchange.pc.am", with
  // every other price the index times a published constant. For this market
  // that constant is 1.03 (decision D10: "index x 1.03, the same as the
  // exchange ask").
  //
  // All three MUST stay registered here. reload() skips a stored row whose key
  // is not in DEFS, so an unregistered pricingMode would sit in the table
  // reading 'index' while the server priced on the curve -- the same silent
  // fallback that once made an ammK write look like it had not worked.
  pricingMode:         { type: 'str', def: 'curve', max: 5, re: /^(curve|index)$/,
    // A closed list, not just the regex: coerce() lets an EMPTY string past
    // `re`, and an empty pricingMode reads as 'curve' -- a silent switch back to
    // a curve nobody re-anchored. The admin form renders these as a <select>.
    options: ['curve', 'index'],
    label: 'Pricing mode \u2014 curve or index',
    help: 'curve: the constant-product curve, price = ammK / X^2, re-anchored by the ask-follow ' +
          'timer. index: every PCN at ONE price, the PCN index from exchange.pc.am (relayed ' +
          'by price.pc.am on this box) x (1 + marketPremiumPct/100), never below ' +
          'ladderMinPriceUsd, the same for any order size. In index mode an unknown or stale ' +
          'index CLOSES the market; it never falls back to the curve. Switch with ' +
          '`node pricing-mode.mjs index|curve`, not here: going back to curve needs ammK ' +
          're-anchored first, or the price jumps to wherever the old curve was left.' },
  marketPremiumPct:    { type: 'num', def: 0, min: 0, max: 20, step: 0.01,
    label: 'Premium over the PCN index (%) \u2014 index mode only',
    help: 'What this market adds to the PCN index. The owner approved 3 (plan decision D10): ' +
          'one house selling price, equal to the exchange\u2019s house ask, which also covers ' +
          'NOWPayments and network costs. Read on every quote; nothing else uses it.' },
  indexMaxAgeSeconds:  { type: 'num', def: 900, min: 60, max: 7200,
    label: 'PCN index max age (seconds) \u2014 index mode only',
    help: 'An index reading older than this closes the market rather than prices it. The age ' +
          'is the exchange\u2019s own computation time plus however long ago this server last ' +
          'read price.pc.am, so an unreachable relay ages the reading by itself. price.pc.am ' +
          'also marks the index stale after its OWN limit (600 s on 2026-09-24), and either ' +
          'one closes the market: this setting can make the market stricter than the relay, ' +
          'never looser.' },
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
  backingFloatOnly:    { type: 'bool', def: false,
    label: 'Back sales with the HOT WALLET only',
    help: 'On, the market may promise exactly what is in the hot wallet right now -- read live ' +
          'from the wallet that actually sends the coins, so it falls with every sale and rises ' +
          'when you top it up. No address list, no cap to re-type, nothing to go stale. This is ' +
          'the setting for "we sell what is in the till and no more". It overrides both the ' +
          'deliverable cap and the backing addresses. If the wallet cannot be read, sales STOP ' +
          'rather than continue against a guess.' },
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
    if (d.type === 'str') {
      // Deliberately permissive about CONTENT and strict about SHAPE: this
      // holds an API key and a base URL, and guessing at their format is how a
      // valid credential gets rejected on a rotation day.
      const v = String(raw ?? '').trim();
      if (v.length > (d.max || 200)) throw new Error(`${key} must be at most ${d.max || 200} characters`);
      if (d.re && v && !d.re.test(v)) throw new Error(`${key} does not look right`);
      // A closed list of values. Checked even when `v` is empty, which the
      // line above deliberately lets through for optional strings.
      if (d.options && !d.options.includes(v)) {
        throw new Error(`${key} must be one of: ${d.options.join(', ')}`);
      }
      return v;
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
