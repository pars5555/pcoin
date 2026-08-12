// ═══════════════════════════════════════════════════════════════════════════
// Who is actually making this request?
// ═══════════════════════════════════════════════════════════════════════════
//
// This is used for two things that must not disagree: the IP printed in the
// operator's Telegram alert, and the key the login rate-limiter counts against.
// Getting it wrong is not cosmetic — a wrong key means the lockout counts the
// wrong population.
//
// THE HOP CHAIN, as measured on the live box (not assumed):
//
//   browser ──▶ Cloudflare edge ──▶ Caddy (:443) ──▶ node (127.0.0.1:8789)
//
//   * Cloudflare sends  CF-Connecting-IP: <browser>          (always exactly one)
//     and also          X-Forwarded-For:  <browser>
//   * Caddy's reverse_proxy APPENDS the peer it sees, so node receives
//                        X-Forwarded-For: <browser>, <cloudflare edge>
//   * node's socket.remoteAddress is always 127.0.0.1 — Caddy is local.
//
// So neither end of X-Forwarded-For is the answer:
//
//   FIRST entry — client-controlled. Anyone can send X-Forwarded-For: 1.2.3.4
//     and Cloudflare passes it through, so a guesser could reset their own rate
//     limit on every attempt just by varying it. This was the original bug.
//   LAST entry — Caddy's view of its peer, which is the CLOUDFLARE EDGE, not
//     the visitor. Every real visitor collapses onto a handful of edge IPs, so
//     a per-IP lockout becomes very nearly global: eight failures from anyone
//     behind that edge node locks out everyone else behind it. And the operator
//     alert names a Cloudflare datacentre instead of the person signing in.
//     This was the over-correction for the first bug.
//
// The answer is CF-Connecting-IP, which Cloudflare OVERWRITES on every request
// — a client cannot forge it through the edge. It is trustworthy exactly as far
// as "this request really came through Cloudflare" is true, which is why the
// last X-Forwarded-For entry is checked against Cloudflare's ranges first: a
// request that reached the origin directly (someone who found the origin IP and
// skipped the edge) can forge the header freely, and must not be believed.
//
// The firewall restricting :443 to Cloudflare's ranges is the belt to this
// braces. Either alone is sufficient; both is deliberate.

/** Cloudflare's published ranges. https://www.cloudflare.com/ips/
 *  Kept in code rather than fetched: a startup network call that fails would
 *  either block boot or silently degrade to trusting everything, and both are
 *  worse than a list that occasionally needs a refresh. `contrib/market/README`
 *  records how to check it. A range added after this was written fails CLOSED —
 *  such a request falls back to the peer address, which is still a real IP; it
 *  is merely less specific, never forgeable. */
export const CLOUDFLARE_V4 = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
  '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
];
export const CLOUDFLARE_V6 = [
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32',
  '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
];

const v4ToInt = ip => {
  const p = ip.split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const o of p) {
    const b = Number(o);
    if (!Number.isInteger(b) || b < 0 || b > 255 || !/^\d+$/.test(o)) return null;
    n = n * 256 + b;
  }
  return n;
};

/** Expand an IPv6 literal to 8 groups of 16 bits. Returns null if unparseable.
 *  Handles `::` compression and the `::ffff:1.2.3.4` mapped form. */
function v6Groups(ip) {
  let s = ip.trim().toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  s = s.replace(/%.*$/, '');                      // strip a zone index
  const mapped = s.match(/^(.*:)((?:\d{1,3}\.){3}\d{1,3})$/);
  if (mapped) {
    const n = v4ToInt(mapped[2]);
    if (n === null) return null;
    s = mapped[1] + ((n >>> 16) & 0xffff).toString(16) + ':' + (n & 0xffff).toString(16);
  }
  if (!s.includes(':')) return null;
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;
  let parts;
  if (tail === null) {
    parts = head;
  } else {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    parts = [...head, ...Array(fill).fill('0'), ...tail];
  }
  if (parts.length !== 8) return null;
  const out = [];
  for (const p of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(p)) return null;
    out.push(parseInt(p, 16));
  }
  return out;
}

function inV4(ip, cidr) {
  const [net, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw);
  const a = v4ToInt(ip), b = v4ToInt(net);
  if (a === null || b === null) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}

function inV6(ip, cidr) {
  const [net, bitsRaw] = cidr.split('/');
  let bits = Number(bitsRaw);
  const a = v6Groups(ip), b = v6Groups(net);
  if (!a || !b) return false;
  for (let i = 0; i < 8 && bits > 0; i++) {
    const take = Math.min(16, bits);
    const mask = take === 16 ? 0xffff : ((0xffff << (16 - take)) & 0xffff);
    if ((a[i] & mask) !== (b[i] & mask)) return false;
    bits -= take;
  }
  return true;
}

/** Is this address one of Cloudflare's edge servers? */
export function isCloudflare(ip) {
  if (!ip) return false;
  const s = String(ip).replace(/^::ffff:/i, '');
  return s.includes(':')
    ? CLOUDFLARE_V6.some(c => inV6(s, c))
    : CLOUDFLARE_V4.some(c => inV4(s, c));
}

/** The real client address, or null if it genuinely cannot be established.
 *
 *  null is a real answer and callers must handle it as one — see the estate's
 *  standing rule that an unknown must never collapse into a confident value.
 *  Here that means an unknown IP is rate-limited under its own bucket rather
 *  than sharing one with every other unknown, and is reported to the operator
 *  as unknown rather than as a plausible-looking address. */
export function clientIp(req) {
  const hdr = n => {
    const v = req.headers?.[n];
    return Array.isArray(v) ? v[0] : v;
  };
  const xff = String(hdr('x-forwarded-for') || '')
    .split(',').map(s => s.trim()).filter(Boolean);

  // Caddy appended its peer last. That peer is who we are really talking to.
  const peer = xff.length ? xff[xff.length - 1]
                          : String(req.socket?.remoteAddress || '').replace(/^::ffff:/i, '');

  if (isCloudflare(peer)) {
    const cf = String(hdr('cf-connecting-ip') || '').trim();
    // Cloudflare always sets exactly one, and overwrites anything the client
    // sent. Validate the shape anyway: this string is interpolated into an
    // operator alert and used as a map key.
    if (cf && (v4ToInt(cf) !== null || v6Groups(cf))) return cf;
    // Through Cloudflare but no usable CF-Connecting-IP: something is wrong
    // with the assumptions above, and naming the edge would be misleading.
    return null;
  }
  if (!peer) return null;
  return (v4ToInt(peer) !== null || v6Groups(peer)) ? peer : null;
}

/** For display and for audit rows: never blank, never a fabricated address. */
export const ipLabel = ip => ip || 'unknown';
