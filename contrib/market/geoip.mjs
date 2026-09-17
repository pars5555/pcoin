// ═══════════════════════════════════════════════════════════════════════════
// Where did this event come from? IP → country, city, ISP.
// ═══════════════════════════════════════════════════════════════════════════
//
// The operator's Telegram alerts name an email and an address but nothing about
// where the person actually is, so a $300 order from a regular and a $300 order
// from somewhere nobody has ever bought from look identical. This turns the IP
// we already store into something a human can judge at a glance.
//
// ───────────────────────────────────────────────────────────────────────────
// THE RULE THAT OUTRANKS EVERYTHING ELSE HERE: this must never break a sale.
// ───────────────────────────────────────────────────────────────────────────
// A geo lookup is decoration on a money path. If the API is slow, down, out of
// quota, or returns nonsense, the order must still complete exactly as it would
// have before this file existed. So every entry point:
//
//   * has a hard timeout (LOOKUP_TIMEOUT_MS) and is never awaited without one;
//   * returns null on ANY failure and never throws to its caller;
//   * writes to its own table, never inside the order's transaction.
//
// null means "we do not know", and that is a real answer that must survive to
// the display layer — an unknown location must read as unknown, never as a
// blank country or an empty city, because a blank reads as "domestic" to
// whoever is glancing at the alert.
//
// ───────────────────────────────────────────────────────────────────────────
// WHY THERE IS A CACHE, AND WHY IT IS NOT OPTIONAL
// ───────────────────────────────────────────────────────────────────────────
// The free tier is 1,000 lookups a day. A per-request lookup would spend that
// on page views and then fail on the one order that mattered. IP → location is
// also nearly static, so the cache costs accuracy measured in weeks and saves
// the quota for events worth recording. Anything already known is answered from
// the table with no network call at all.
//
// The cache is keyed on the IP alone. It deliberately does NOT expire rows on
// read: a stale country is far more useful than no country, so an old row is
// returned immediately and refreshed in the background only if it is older than
// REFRESH_AFTER_DAYS.
//
// ───────────────────────────────────────────────────────────────────────────
// THE SNAPSHOT VS THE CACHE — these are two different facts
// ───────────────────────────────────────────────────────────────────────────
// The cache says where an IP is TODAY. An order needs to record where it came
// from at the TIME IT WAS PLACED, because addresses get reassigned and the
// cache will be refreshed. So the important rows keep their own country/city/
// ISP snapshot, and the cache is only how that snapshot is obtained cheaply.
// Reading the location of a year-old order out of the live cache would quietly
// rewrite history.

const LOOKUP_TIMEOUT_MS = 2500;
const REFRESH_AFTER_DAYS = 30;

// Private and loopback ranges never reach the API: they cost quota, always
// answer "unknown", and asking is a small information leak about our own
// topology. Checked BEFORE the cache so they never occupy a row either.
function isPrivate(ip) {
  if (!ip) return true;
  const s = String(ip).trim();
  if (s === '::1' || s === 'localhost') return true;
  if (s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe80')) return true;
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;                       // a public IPv6 is fine to look up
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || a === 0 ||
         (a === 192 && b === 168) ||
         (a === 172 && b >= 16 && b <= 31) ||
         (a === 169 && b === 254) ||
         (a === 100 && b >= 64 && b <= 127);   // CGNAT
}

// A two-letter country code into its flag. Regional-indicator symbols sit at a
// fixed offset from 'A', so this is arithmetic rather than a lookup table of
// 250 emoji that would inevitably go out of date.
export function flagOf(country) {
  const c = String(country || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return '';
  return String.fromCodePoint(...[...c].map(ch => 0x1f1e6 + ch.charCodeAt(0) - 65));
}

/**
 * Create the cache table if we are allowed to.
 *
 * THE APP USER DELIBERATELY HAS NO DDL RIGHTS -- it is granted only SELECT,
 * INSERT, UPDATE and DELETE, which is right for a process facing the internet.
 * So this is best-effort: an admin creates the table out of band, and a denial
 * here is the expected state in production rather than a fault. It still
 * VERIFIES the table is usable afterwards, because "I could not create it" and
 * "it is not there" are different problems and only the second one matters.
 *
 * Returns true if the table can be read, false if the feature must stay off.
 */
export async function ensureSchema(q, log = console) {
  try {
    await createTable(q);
  } catch (e) {
    if (!/denied|permission|priv/i.test(e.message || '')) throw e;
    log.warn?.('[geoip] no DDL rights, which is correct; checking the table exists');
  }
  try {
    await q(`SELECT 1 FROM ip_geo LIMIT 1`);
    return true;
  } catch (e) {
    log.warn?.(`[geoip] ip_geo is not usable (${e.message}) -- lookups are off until it is created`);
    return false;
  }
}

async function createTable(q) {
  await q(`CREATE TABLE IF NOT EXISTS ip_geo (
             ip           VARCHAR(45)  NOT NULL PRIMARY KEY,
             country      CHAR(2)      NULL,
             country_name VARCHAR(64)  NULL,
             city         VARCHAR(128) NULL,
             region       VARCHAR(64)  NULL,
             isp          VARCHAR(128) NULL,
             asn          INT          NULL,
             asn_org      VARCHAR(128) NULL,
             is_mobile    TINYINT(1)   NULL,
             latitude     DECIMAL(9,6) NULL,
             longitude    DECIMAL(9,6) NULL,
             timezone     VARCHAR(64)  NULL,
             fetched_at   INT          NOT NULL,
             ok           TINYINT(1)   NOT NULL DEFAULT 1
           ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

async function fetchGeo(ip, { base, key }) {
  const url = `${String(base).replace(/\/+$/, '')}/geo?ip=${encodeURIComponent(ip)}`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), LOOKUP_TIMEOUT_MS);
  try {
    // The key goes in a HEADER, not the query string: a query string lands in
    // access logs, proxy logs and error reports, and this key is shared across
    // every PCoin project.
    const r = await fetch(url, { signal: ctl.signal, headers: { 'X-API-Key': key } });
    if (!r.ok) {
      // 401 and 400 mean different things and must not be collapsed. A bad key
      // is an operator problem worth shouting about; a bad IP is just this one
      // row being unknowable.
      return { error: r.status === 401 ? 'bad-key' : r.status === 400 ? 'bad-ip' : `http-${r.status}` };
    }
    const d = await r.json();
    if (!d || typeof d !== 'object' || !d.country) return { error: 'empty' };
    return { data: d };
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'timeout' : (e.message || 'failed').slice(0, 80) };
  } finally {
    clearTimeout(t);
  }
}

function rowToGeo(r) {
  if (!r || !r.ok) return null;
  return {
    ip: r.ip, country: r.country, countryName: r.country_name, city: r.city,
    region: r.region, isp: r.isp, asn: r.asn, asnOrg: r.asn_org,
    isMobile: !!r.is_mobile, latitude: r.latitude, longitude: r.longitude,
    timezone: r.timezone, fetchedAt: r.fetched_at,
  };
}

/**
 * Look up an IP, using the cache. Returns a geo object or null.
 *
 * NEVER THROWS. Callers sit on the order path and a rejected promise there
 * would turn a working sale into a 500.
 */
export async function geoFor(ip, opts) {
  const { q, key, base, enabled = true, log = console } = opts || {};
  try {
    if (!enabled || !key || !base || isPrivate(ip)) return null;

    const now = Math.floor(Date.now() / 1000);
    const cached = (await q(`SELECT * FROM ip_geo WHERE ip = ?`, [ip]))[0];
    if (cached) {
      const age = now - Number(cached.fetched_at || 0);
      if (age < REFRESH_AFTER_DAYS * 86400) return rowToGeo(cached);
      // Stale: answer from the cache NOW and refresh without blocking. The
      // caller is mid-order; it must not wait on a network call for a value we
      // already have a usable answer for.
      refresh(ip, opts).catch(() => {});
      return rowToGeo(cached);
    }

    const { data, error } = await fetchGeo(ip, { base, key });
    if (error) {
      if (error === 'bad-key') log.warn?.('[geoip] the API key was refused — lookups are off until it is fixed');
      // Remember the failure briefly so a burst of requests from one unknown IP
      // does not become a burst of failing API calls. ok=0 means "asked, could
      // not answer", which is different from "never asked".
      await q(`INSERT INTO ip_geo (ip, fetched_at, ok) VALUES (?,?,0)
               ON DUPLICATE KEY UPDATE fetched_at = VALUES(fetched_at), ok = 0`,
              [ip, now]).catch(() => {});
      return null;
    }
    await store(q, ip, data, now);
    return rowToGeo({ ...toRow(ip, data, now), ok: 1 });
  } catch (e) {
    (opts?.log || console).warn?.('[geoip] lookup failed, continuing without it:', e.message);
    return null;
  }
}

function toRow(ip, d, now) {
  return {
    ip,
    country: d.country || null,
    country_name: d.countryName || null,
    city: d.city || null,
    region: Array.isArray(d.subdivisions) ? (d.subdivisions[0] || null) : null,
    isp: d.isp || null,
    asn: Number.isFinite(d.asnNumber) ? d.asnNumber : null,
    asn_org: d.asnOrganization || null,
    is_mobile: d.isMobile ? 1 : 0,
    latitude: Number.isFinite(d.latitude) ? d.latitude : null,
    longitude: Number.isFinite(d.longitude) ? d.longitude : null,
    timezone: d.timezone || null,
    fetched_at: now,
  };
}

async function store(q, ip, d, now) {
  const r = toRow(ip, d, now);
  await q(`INSERT INTO ip_geo (ip, country, country_name, city, region, isp, asn, asn_org,
                               is_mobile, latitude, longitude, timezone, fetched_at, ok)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1)
           ON DUPLICATE KEY UPDATE
             country=VALUES(country), country_name=VALUES(country_name), city=VALUES(city),
             region=VALUES(region), isp=VALUES(isp), asn=VALUES(asn), asn_org=VALUES(asn_org),
             is_mobile=VALUES(is_mobile), latitude=VALUES(latitude), longitude=VALUES(longitude),
             timezone=VALUES(timezone), fetched_at=VALUES(fetched_at), ok=1`,
          [r.ip, r.country, r.country_name, r.city, r.region, r.isp, r.asn, r.asn_org,
           r.is_mobile, r.latitude, r.longitude, r.timezone, r.fetched_at]).catch(() => {});
}

async function refresh(ip, opts) {
  const { q, key, base } = opts;
  const { data } = await fetchGeo(ip, { base, key });
  if (data) await store(q, ip, data, Math.floor(Date.now() / 1000));
}

/**
 * One line for a Telegram alert: flag, country, city, IP, network.
 *
 * Says "location unknown" rather than printing nothing, because a MISSING line
 * and a line that could not be resolved look the same to a reader, and only one
 * of them means "this person is somewhere we could not place".
 */
export function geoLine(ip, geo, { html = true } = {}) {
  const code = html ? (s) => `<code>${s}</code>` : (s) => s;
  if (!ip) return 'from an unknown address';
  if (!geo) return `${code(ip)} — location unknown`;
  const bits = [];
  const flag = flagOf(geo.country);
  const place = [geo.city, geo.countryName || geo.country].filter(Boolean).join(', ');
  if (place) bits.push(`${flag ? flag + ' ' : ''}${place}`);
  else if (flag) bits.push(flag);
  bits.push(code(ip));
  if (geo.isp) bits.push(geo.isp + (geo.isMobile ? ' (mobile)' : ''));
  return bits.join(' · ');
}
