// Config loader.
//
// The whole point of this file is that the three credentials live in module
// scope and NOT in `process.env`. systemd passes only PCNAIBOT_CONF (a path);
// the process reads the file itself. See pcnaibot.conf.example for why.
//
// Nothing here ever prints a value. `describe()` prints NAMES ONLY -- redact by
// allow-list, never by pattern, because every leak this project has had came
// from printing a line NEAR a match rather than the match itself.

import { readFileSync } from 'node:fs';

const SECRET_KEYS = new Set(['TELEGRAM_TOKEN', 'OONACODE_KEY', 'WPCN_PAY_TOKEN']);

// A value still carrying the placeholder is NOT a value. Shipping with
// `REPLACE - ...` in place of a key must fail loudly at startup rather than
// produce a 401 an hour later that reads like a provider outage.
const PLACEHOLDER = /^REPLACE\b/i;

function parse(text) {
  const out = new Map();
  let lineNo = 0;
  for (const raw of text.split(/\r?\n/)) {
    lineNo++;
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) throw new Error(`config line ${lineNo}: not KEY=value`);
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (val.length >= 2 && ((val[0] === '"' && val.endsWith('"')) ||
                            (val[0] === "'" && val.endsWith("'")))) {
      val = val.slice(1, -1);
    }
    if (out.has(key)) throw new Error(`config line ${lineNo}: duplicate key ${key}`);
    out.set(key, val);
  }
  return out;
}

class Config {
  #map;
  constructor(map) { this.#map = map; }

  // Required string. Absent, empty or still-placeholder all throw.
  str(key) {
    const v = this.#map.get(key);
    if (v === undefined) throw new Error(`config: ${key} is missing`);
    if (v === '') throw new Error(`config: ${key} is empty`);
    if (PLACEHOLDER.test(v)) throw new Error(`config: ${key} is still the placeholder`);
    return v;
  }

  // Optional string. Returns fallback when absent OR still-placeholder -- a
  // placeholder is an unset value, not a value.
  strOr(key, fallback) {
    const v = this.#map.get(key);
    if (v === undefined || v === '' || PLACEHOLDER.test(v)) return fallback;
    return v;
  }

  // Numbers refuse anything non-finite. `Number('')` is 0 and `Number('abc')`
  // is NaN; both would otherwise become a silent money constant.
  num(key, fallback = undefined) {
    const v = this.#map.get(key);
    if (v === undefined || v === '') {
      if (fallback === undefined) throw new Error(`config: ${key} is missing`);
      return fallback;
    }
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`config: ${key} is not a finite number`);
    return n;
  }

  int(key, fallback = undefined) {
    const n = this.num(key, fallback);
    if (!Number.isInteger(n)) throw new Error(`config: ${key} must be an integer`);
    return n;
  }

  bool(key, fallback = false) {
    const v = this.#map.get(key);
    if (v === undefined || v === '') return fallback;
    if (v === '1' || /^(true|yes|on)$/i.test(v)) return true;
    if (v === '0' || /^(false|no|off)$/i.test(v)) return false;
    throw new Error(`config: ${key} is not a boolean`);
  }

  // Comma-separated list. An EMPTY value is an empty list, deliberately -- that
  // is how ALLOWLIST_CHAT_IDS= means "answer nobody" rather than "answer all".
  list(key) {
    const v = this.#map.get(key);
    if (v === undefined || v.trim() === '') return [];
    return v.split(',').map((s) => s.trim()).filter((s) => s !== '');
  }

  intList(key) {
    return this.list(key).map((s) => {
      const n = Number(s);
      if (!Number.isSafeInteger(n)) throw new Error(`config: ${key} has a non-integer entry`);
      return n;
    });
  }

  has(key) { return this.#map.has(key); }

  // NAMES ONLY. Never values, never a context line.
  describe() {
    return [...this.#map.keys()].sort().map((k) => (SECRET_KEYS.has(k) ? `${k}=<secret>` : k));
  }
}

export function loadConfig(path = process.env.PCNAIBOT_CONF) {
  if (!path) throw new Error('PCNAIBOT_CONF is not set');
  const cfg = new Config(parse(readFileSync(path, 'utf8')));

  // Belt and braces: if anything secret-shaped reached the environment anyway
  // (a stray EnvironmentFile=, a developer's shell), remove it now so a later
  // crash dump or a logged error object cannot carry it.
  for (const k of SECRET_KEYS) delete process.env[k];

  return cfg;
}

export { SECRET_KEYS };
