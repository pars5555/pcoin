// "Pay with PCN, get 10% back" -- the line on the balance and top-up screens (owner, 2026-09-27).
//
// It reads the SAME `REBATE` object the credit path reads (lib/deposits.mjs), so the line can only
// be shown while the rebate is actually paying, and it states the real percent and cap rather than
// a number typed into a sentence. Every case in which rebateFor() would pay nothing returns null:
//
//   ppm 0                      the rebate is off
//   from 0, or now < from      not started (0 means never)
//   capSat <= 0                rebateFor() compares `usedSat >= capSat`, so a zero cap pays nobody --
//                              unlike webbuilderbot, where 0 means "no cap". Do not "fix" one to
//                              match the other without changing its rebateFor() as well.
//
// Pure, no imports, so the test runs on plain node without the database driver.

// A bigint ratio as a short decimal: 100000/10000 -> "10", 125000/10000 -> "12.5".
function ratio(n, d) {
  const whole = n / d;
  const rest = n % d;
  if (rest === 0n) return whole.toString();
  const digits = d.toString().length - 1;
  return `${whole}.${rest.toString().padStart(digits, '0').replace(/0+$/, '')}`;
}

// -> { key, vars } for t(), or null when nothing should be advertised.
export function rebatePromo(rebate, now) {
  if (!rebate) return null;
  const { ppm, capSat, from } = rebate;
  if (typeof ppm !== 'bigint' || typeof capSat !== 'bigint' || typeof from !== 'bigint') return null;
  if (ppm <= 0n || capSat <= 0n || from <= 0n) return null;
  if (BigInt(Math.floor(Number(now))) < from) return null;
  return { key: 'promo.rebate', vars: { percent: ratio(ppm, 10000n), cap: ratio(capSat, 100000000n) } };
}
