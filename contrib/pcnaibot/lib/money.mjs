// Integer money arithmetic. No floats anywhere in this file's results.
//
// Two traps this exists to avoid:
//
// 1. amount_sat * rate_e12 OVERFLOWS 64-bit signed. A 139 PCN deposit is
//    1.39e10 sat; today's rate_e12 is ~3.59e10; the product is ~5e20 against a
//    2^63 ceiling of ~9.2e18. It must be done in BigInt -- not in a SQL
//    expression, not in a double. A double would not throw; it would round.
//
// 2. The rate must be quantised ONCE, to an integer, and every later
//    computation must use the value that was stamped. DECIMAL(18,10) cannot
//    hold 0.03590242147375549 -- it stores 0.0359024215 -- so
//    amount_sat * credited_rate never reproduces credited_micro_usd, and a
//    Credited-vs-Treasury comparison is then permanently off by a hair with no
//    way to tell rounding drift from a real discrepancy.

export const SATS_PER_PCN = 100000000n;   // 1e8
export const RATE_SCALE = 1000000000000n; // 1e12
export const NANO_PER_MICRO = 1000n;
export const PRICE_SCALE = 1000000000n;   // 1e9, for $/1M-token prices
export const MARGIN_SCALE = 1000000n;     // 1e6, for the house margin

// Parse a decimal STRING (or a finite number) to an integer scaled by 10^dp.
// Truncates toward zero at dp. Refuses anything non-numeric -- "unknown" must
// never arrive here as 0.
export function parseScaled(value, dp) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('parseScaled: not finite');
    value = value.toFixed(Math.min(dp, 20));
  }
  if (typeof value !== 'string') throw new TypeError('parseScaled: not a string or number');
  const s = value.trim();
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[2] === '' && (m[3] === undefined || m[3] === ''))) {
    throw new TypeError(`parseScaled: not a decimal: ${JSON.stringify(s.slice(0, 40))}`);
  }
  const sign = m[1] === '-' ? -1n : 1n;
  const whole = m[2] === '' ? '0' : m[2];
  const frac = (m[3] ?? '').padEnd(dp, '0').slice(0, dp);
  return sign * (BigInt(whole) * 10n ** BigInt(dp) + BigInt(frac === '' ? '0' : frac));
}

// The rate, quantised once. floor(rate * 1e12).
export function rateToE12(rate) {
  const e12 = parseScaled(rate, 12);
  if (e12 <= 0n) throw new RangeError('rateToE12: rate must be positive');
  return e12;
}

// nano_usd = amount_sat * rate_e12 / 1e11
//
// Derivation, so nobody has to re-derive it under pressure:
//   usd      = (amount_sat / 1e8) * rate
//   nano_usd = usd * 1e9 = amount_sat * rate * 10
//   rate     = rate_e12 / 1e12
//   nano_usd = amount_sat * rate_e12 / 1e11
export function satsToNanoUsd(amountSat, rateE12) {
  const sat = BigInt(amountSat);
  if (sat < 0n) throw new RangeError('satsToNanoUsd: negative amount');
  return (sat * BigInt(rateE12)) / 100000000000n; // 1e11
}

// Split nano-USD into whole micro-USD plus a carried remainder.
// FLOOR, never round up, and the remainder is carried PER ADDRESS so that
// flooring each deposit independently does not eat a fraction every time.
// (1 sat is ~0.36 nano-USD at today's rate, so the per-deposit floor loss is
// under $1e-9 -- the carry is correctness, not revenue.)
export function splitNano(nanoTotal) {
  const n = BigInt(nanoTotal);
  if (n < 0n) throw new RangeError('splitNano: negative');
  return { micro: n / NANO_PER_MICRO, remainder: n % NANO_PER_MICRO };
}

// micro_usd for a token count at a $/1M-token price, with the house margin.
//
//   usd   = tokens * pricePerM / 1e6
//   micro = usd * 1e6 = tokens * pricePerM
//   with margin: micro = tokens * pricePerM * M
//
// Scaled: micro = tokens * pricePerM_e9 * margin_e6 / 1e15.
// CEILING, so that a quote is never lower than the bill it bounds.
export function tokensToMicroUsd(tokens, pricePerMe9, marginE6) {
  const t = BigInt(tokens);
  if (t < 0n) throw new RangeError('tokensToMicroUsd: negative tokens');
  const p = BigInt(pricePerMe9);
  if (p < 0n) throw new RangeError('tokensToMicroUsd: negative price');
  const num = t * p * BigInt(marginE6);
  const den = 1000000000000000n; // 1e15
  return ceilDiv(num, den);
}

export function ceilDiv(a, b) {
  const q = a / b;
  return a % b === 0n ? q : q + 1n;
}

export function pcnToSats(pcn) {
  return parseScaled(pcn, 8);
}

export function satsToPcnString(sat) {
  const s = BigInt(sat);
  const neg = s < 0n;
  const abs = neg ? -s : s;
  const whole = abs / SATS_PER_PCN;
  const frac = (abs % SATS_PER_PCN).toString().padStart(8, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

// Display only. Never feed this back into arithmetic.
export function microUsdToString(micro, dp = 6) {
  const m = BigInt(micro);
  const neg = m < 0n;
  const abs = neg ? -m : m;
  const whole = abs / 1000000n;
  const frac = (abs % 1000000n).toString().padStart(6, '0').slice(0, dp);
  return `${neg ? '-' : ''}${whole}${dp > 0 ? `.${frac}` : ''}`;
}

// How much PCN is a given USD amount, at a stamped rate? Used for the deposit
// screen's live minimum, which must be recomputed on every render and never
// stored as static text.
export function usdToPcnString(usdMicro, rateE12) {
  const micro = BigInt(usdMicro);
  if (micro <= 0n) return '0.00000000';
  // sat = micro_usd * 1e11 / rate_e12 / 1e6 * ... derive from satsToNanoUsd:
  //   nano = sat * rate_e12 / 1e11  and  nano = micro * 1e3
  //   => sat = micro * 1e3 * 1e11 / rate_e12 = micro * 1e14 / rate_e12
  const sat = ceilDiv(micro * 100000000000000n, BigInt(rateE12));
  return satsToPcnString(sat);
}
