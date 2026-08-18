#!/usr/bin/env node
// PCoin crawler-backed DNS seed.
//
// WHY THIS EXISTS
// ---------------
// `seed.pc.am` is a static A/AAAA record naming our own four machines. It can
// therefore only ever hand a new node OUR hosts -- if they are down, or gone,
// or simply not accepting, a newcomer cannot join at all. That is the single
// largest dependency the project has on us, and adding more of our own boxes
// does not fix it, because they are all still ours.
//
// A real DNS seed answers with WHOEVER IS CURRENTLY LISTENING. It crawls the
// network, keeps the nodes that actually accept connections and speak PCoin,
// and serves those. We still operate the name, but the ANSWERS come from the
// network. The day a third party runs a reachable node, newcomers start being
// pointed at it without anyone editing anything.
//
// This is deliberately a SECOND name, not a replacement. `seed.pc.am` keeps
// working exactly as it does today; this serves a new zone that gets added to
// vSeeds alongside it. If this daemon breaks, bootstrapping is no worse than
// it already is.
//
// WHAT IT IS NOT
// --------------
// Not a resolver. It answers only for its own zone and REFUSES everything
// else, so it cannot be used as an open resolver or an amplifier. Responses
// are a handful of A/AAAA records -- there is no large payload to reflect --
// and per-source rate limiting is applied on top.
//
// SERVICE-BIT SUBDOMAINS
// ----------------------
// Core does not query the bare name. It queries `x<hex-service-bits>.<name>`
// (src/net.cpp, strprintf("x%x", requiredServiceBits)) and only falls back to
// the bare name -- via a single slow ADDR_FETCH connection -- when that
// subdomain does not resolve. Today `x9.seed.pc.am` is NXDOMAIN, so EVERY
// PCoin node in existence takes the degraded path. This daemon answers the
// x-subdomains, filtered by the bits actually asked for.
import dgram from 'node:dgram';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';

const CONF = process.env.PCOIN_DNSSEED_CONF || '/etc/pcoin-dnsseed.json';
const cfg = {
  zone: 'dnsseed.pc.am',
  ns: ['ns1.pc.am'],
  soaMail: 'hostmaster.pc.am',
  bind: '0.0.0.0',
  port: 53,
  p2pPort: 9444,
  magic: 'cfa2d1b8',
  protocolVersion: 70016,
  userAgent: '/pcoin-dnsseed:0.1/',
  seeds: ['35.239.156.16', '35.238.47.14', '178.105.3.51', '152.53.171.190'],
  state: '/var/lib/pcoin-dnsseed/nodes.json',
  maxAnswers: 16,
  ttl: 60,
  crawlConcurrency: 24,
  crawlIntervalMs: 60000,
  goodForMs: 3 * 3600000,
  retireAfterMs: 14 * 86400000,
  minSuccesses: 2,
  handshakeTimeoutMs: 8000,
  ratePerMinute: 60,
  ...(fs.existsSync(CONF) ? JSON.parse(fs.readFileSync(CONF, 'utf8')) : {}),
};

const MAGIC = Buffer.from(cfg.magic, 'hex');
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------- node store
const nodes = new Map();
const nkey = (host, port) => host + '/' + port;
const isV6 = h => h.includes(':');

function remember(host, port) {
  if (!host || !port) return false;
  const k = nkey(host, port);
  if (nodes.has(k)) return false;
  nodes.set(k, {
    host, port, v6: isV6(host), ok: 0, fail: 0,
    firstSeen: Date.now(), lastOk: 0, lastTry: 0, services: 0, height: 0, ua: '',
  });
  return true;
}

try {
  for (const n of JSON.parse(fs.readFileSync(cfg.state, 'utf8'))) nodes.set(nkey(n.host, n.port), n);
  log('loaded ' + nodes.size + ' nodes from ' + cfg.state);
} catch { log('no saved state; starting from the configured seeds'); }
for (const s of cfg.seeds) remember(s, cfg.p2pPort);

function saveState() {
  try {
    fs.mkdirSync(cfg.state.replace(/[/][^/]+$/, ''), { recursive: true });
    fs.writeFileSync(cfg.state, JSON.stringify([...nodes.values()]));
  } catch (e) { log('could not save state: ' + e.message); }
}

// A node is servable only once it has actually completed a handshake recently.
// "A peer told us about it" is NOT evidence that it accepts connections --
// testing that claim instead of repeating it is the whole point of a DNS seed.
const good = (n, now = Date.now()) => n.ok >= cfg.minSuccesses && (now - n.lastOk) < cfg.goodForMs;

// --------------------------------------------------------------- p2p speaker
function msg(command, payload = Buffer.alloc(0)) {
  const c = Buffer.alloc(12);
  c.write(command, 0, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(payload.length, 0);
  const sum = crypto.createHash('sha256')
    .update(crypto.createHash('sha256').update(payload).digest())
    .digest().subarray(0, 4);
  return Buffer.concat([MAGIC, c, len, sum, payload]);
}

function varint(n) {
  if (n < 0xfd) return Buffer.from([n]);
  if (n <= 0xffff) { const b = Buffer.alloc(3); b[0] = 0xfd; b.writeUInt16LE(n, 1); return b; }
  const b = Buffer.alloc(5); b[0] = 0xfe; b.writeUInt32LE(n, 1); return b;
}

function netaddr() {
  const b = Buffer.alloc(26);
  b[18] = 0xff; b[19] = 0xff;
  return b;
}

function versionPayload() {
  const ua = Buffer.from(cfg.userAgent, 'ascii');
  const ver = Buffer.alloc(4); ver.writeInt32LE(cfg.protocolVersion, 0);
  const svc = Buffer.alloc(8); svc.writeBigUInt64LE(0n, 0);
  const ts = Buffer.alloc(8); ts.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000)), 0);
  const h = Buffer.alloc(4); h.writeInt32LE(0, 0);
  return Buffer.concat([
    ver, svc, ts, netaddr(), netaddr(), crypto.randomBytes(8),
    varint(ua.length), ua, h, Buffer.from([0]),
  ]);
}

// Parse a legacy `addr` payload. We deliberately never send `sendaddrv2`, so
// peers reply in this format -- which keeps the parser small and still carries
// both IPv4 and IPv6. Tor addresses are of no use to a DNS seed anyway.
function parseAddr(buf) {
  const out = [];
  let o = 0, count;
  const first = buf[o];
  if (first === undefined) return out;
  if (first < 0xfd) { count = first; o = 1; }
  else if (first === 0xfd) { count = buf.readUInt16LE(1); o = 3; }
  else if (first === 0xfe) { count = buf.readUInt32LE(1); o = 5; }
  else return out;
  if (count > 2000) count = 2000;
  const V4 = Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff]);
  for (let i = 0; i < count && o + 30 <= buf.length; i++) {
    o += 12;
    const ip = buf.subarray(o, o + 16); o += 16;
    const port = buf.readUInt16BE(o); o += 2;
    if (ip.subarray(0, 12).equals(V4)) {
      const a = ip[12], b = ip[13];
      if (a === 0 || a === 10 || a === 127 || a >= 224) continue;
      if (a === 192 && b === 168) continue;
      if (a === 172 && b >= 16 && b <= 31) continue;
      if (a === 169 && b === 254) continue;
      out.push([a + '.' + b + '.' + ip[14] + '.' + ip[15], port]);
    } else if (!ip.every(x => x === 0)) {
      const parts = [];
      for (let j = 0; j < 16; j += 2) parts.push(ip.readUInt16BE(j).toString(16));
      const h = parts.join(':');
      if (h.startsWith('fe80') || h.startsWith('fc') || h.startsWith('fd')) continue;
      if (parts.every(p => p === '0')) continue;
      out.push([h, port]);
    }
  }
  return out;
}

function probe(n) {
  return new Promise(resolve => {
    const started = Date.now();
    let done = false;
    const result = { ok: false, services: 0, height: 0, ua: '', addrs: [], rttMs: 0 };
    let sock;
    const finish = () => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* already gone */ }
      resolve(result);
    };
    try {
      sock = net.connect({ host: n.host, port: n.port, family: n.v6 ? 6 : 4 });
    } catch { return resolve(result); }
    sock.setTimeout(cfg.handshakeTimeoutMs);
    sock.on('timeout', finish);
    sock.on('error', finish);
    sock.on('close', finish);
    sock.on('connect', () => sock.write(msg('version', versionPayload())));

    let buf = Buffer.alloc(0);
    sock.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > 4000000) return finish();
      while (buf.length >= 24) {
        if (!buf.subarray(0, 4).equals(MAGIC)) return finish();
        const cmd = buf.subarray(4, 16).toString('ascii').replace(/\0+$/, '');
        const len = buf.readUInt32LE(16);
        if (len > 4000000) return finish();
        if (buf.length < 24 + len) return;
        const payload = buf.subarray(24, 24 + len);
        buf = buf.subarray(24 + len);
        if (cmd === 'version') {
          try {
            result.services = Number(payload.readBigUInt64LE(4));
            let o = 4 + 8 + 8 + 26 + 26 + 8;
            const uaLen = payload[o]; o += 1;
            result.ua = payload.subarray(o, o + uaLen).toString('ascii'); o += uaLen;
            result.height = payload.readInt32LE(o);
          } catch { /* a short version message is not fatal */ }
          sock.write(msg('verack'));
        } else if (cmd === 'verack') {
          result.ok = true;
          result.rttMs = Date.now() - started;
          sock.write(msg('getaddr'));
          setTimeout(finish, 3000);
        } else if (cmd === 'addr') {
          try { result.addrs.push(...parseAddr(payload)); } catch { /* ignore junk */ }
        } else if (cmd === 'ping') {
          sock.write(msg('pong', payload));
        }
      }
    });
  });
}

let crawling = false;
async function crawl() {
  if (crawling) return;
  crawling = true;
  try {
    const now = Date.now();
    const due = [...nodes.values()]
      .filter(n => now - n.lastTry > (good(n, now) ? 1200000 : 300000))
      .sort((a, b) => a.lastTry - b.lastTry)
      .slice(0, 400);
    let i = 0, ok = 0, learned = 0;
    const worker = async () => {
      while (i < due.length) {
        const n = due[i++];
        n.lastTry = Date.now();
        const r = await probe(n);
        if (r.ok) {
          n.ok++; n.fail = 0; n.lastOk = Date.now();
          n.services = r.services; n.height = r.height; n.ua = r.ua;
          ok++;
          for (const [h, p] of r.addrs) {
            if (p !== cfg.p2pPort) continue;
            if (nodes.size < 20000 && remember(h, p)) learned++;
          }
        } else {
          n.fail++;
        }
      }
    };
    await Promise.all(Array.from({ length: cfg.crawlConcurrency }, worker));

    // Forget nodes unreachable for a fortnight, but NEVER forget the configured
    // seeds -- they are the floor this whole thing stands on, and a bad week
    // must not leave the crawler with nothing to crawl from.
    const cutoff = Date.now() - cfg.retireAfterMs;
    for (const [k, n] of nodes) {
      if (cfg.seeds.includes(n.host)) continue;
      if (n.ok === 0 && n.firstSeen < cutoff) nodes.delete(k);
      else if (n.lastOk && n.lastOk < cutoff) nodes.delete(k);
    }
    const g = [...nodes.values()].filter(n => good(n)).length;
    log('crawl: probed ' + due.length + ', ' + ok + ' answered, learned ' + learned +
        ', ' + g + ' good of ' + nodes.size + ' known');
    saveState();
  } finally {
    crawling = false;
  }
}

// ---------------------------------------------------------------- dns server
const rate = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const w = rate.get(ip);
  if (!w || now - w.at > 60000) { rate.set(ip, { at: now, n: 1 }); return false; }
  w.n++;
  return w.n > cfg.ratePerMinute;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, w] of rate) if (now - w.at > 120000) rate.delete(ip);
}, 60000).unref();

function encodeName(name) {
  const parts = name.split('.').filter(Boolean);
  const bits = parts.map(p => {
    const b = Buffer.from(p, 'ascii');
    return Buffer.concat([Buffer.from([b.length]), b]);
  });
  return Buffer.concat([...bits, Buffer.from([0])]);
}

function readName(buf, off) {
  const parts = [];
  let jumped = false, safety = 0, o = off, end = off;
  while (safety++ < 128) {
    const len = buf[o];
    if (len === undefined) break;
    if ((len & 0xc0) === 0xc0) {
      if (!jumped) end = o + 2;
      jumped = true;
      o = ((len & 0x3f) << 8) | buf[o + 1];
      continue;
    }
    o += 1;
    if (len === 0) { if (!jumped) end = o; break; }
    parts.push(buf.subarray(o, o + len).toString('ascii'));
    o += len;
  }
  return [parts.join('.').toLowerCase(), end];
}

const TYPE = { A: 1, NS: 2, SOA: 6, AAAA: 28, ANY: 255 };

function answersFor(qname, qtype) {
  const zone = cfg.zone.toLowerCase();
  if (qname !== zone && !qname.endsWith('.' + zone)) return null;

  if (qname === zone) {
    if (qtype === TYPE.NS) return cfg.ns.map(h => ({ type: TYPE.NS, name: h }));
    if (qtype === TYPE.SOA) return [{ type: TYPE.SOA }];
  }
  if (qtype !== TYPE.A && qtype !== TYPE.AAAA && qtype !== TYPE.ANY) return [];

  // x<hex>.<zone> asks for nodes advertising particular service bits. Core
  // always asks this way; the bare name is only its fallback.
  let requiredBits = 0;
  const sub = qname === zone ? '' : qname.slice(0, -(zone.length + 1));
  if (sub) {
    const m = /^x([0-9a-f]{1,16})$/.exec(sub);
    if (!m) return [];
    requiredBits = parseInt(m[1], 16);
  }

  const now = Date.now();
  let pool = [...nodes.values()].filter(n => good(n, now));
  if (requiredBits) pool = pool.filter(n => (n.services & requiredBits) === requiredBits);
  if (qtype !== TYPE.ANY) pool = pool.filter(n => n.v6 === (qtype === TYPE.AAAA));

  // Shuffle: a seed that always answers in the same order concentrates the
  // whole network onto whichever node happens to sort first.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, cfg.maxAnswers).map(n => ({ type: n.v6 ? TYPE.AAAA : TYPE.A, host: n.host }));
}

const v4buf = h => Buffer.from(h.split('.').map(Number));
function v6buf(h) {
  const b = Buffer.alloc(16);
  const half = h.split('::');
  const L = half[0] ? half[0].split(':').filter(Boolean) : [];
  const R = half.length > 1 ? (half[1] ? half[1].split(':').filter(Boolean) : []) : null;
  const groups = R === null ? L : [...L, ...Array(Math.max(0, 8 - L.length - R.length)).fill('0'), ...R];
  groups.slice(0, 8).forEach((g, i) => b.writeUInt16BE(parseInt(g || '0', 16) & 0xffff, i * 2));
  return b;
}

function rrBuf(name, type, ttl, rdata) {
  const meta = Buffer.alloc(8);
  meta.writeUInt16BE(type, 0);
  meta.writeUInt16BE(1, 2);
  meta.writeUInt32BE(ttl, 4);
  const rlen = Buffer.alloc(2);
  rlen.writeUInt16BE(rdata.length, 0);
  return Buffer.concat([encodeName(name), meta, rlen, rdata]);
}

function soaRdata() {
  const tail = Buffer.alloc(20);
  tail.writeUInt32BE(Math.floor(Date.now() / 60000), 0);
  tail.writeUInt32BE(900, 4);
  tail.writeUInt32BE(300, 8);
  tail.writeUInt32BE(86400, 12);
  tail.writeUInt32BE(60, 16);
  return Buffer.concat([encodeName(cfg.ns[0]), encodeName(cfg.soaMail), tail]);
}

function handle(buf, respond) {
  if (buf.length < 12) return;
  const id = buf.readUInt16BE(0);
  const flags = buf.readUInt16BE(2);
  if ((flags & 0x8000) !== 0) return;
  if (buf.readUInt16BE(4) < 1) return;
  const opcode = (flags >> 11) & 0xf;

  const [qname, afterName] = readName(buf, 12);
  if (afterName + 4 > buf.length) return;
  const qtype = buf.readUInt16BE(afterName);
  const qclass = buf.readUInt16BE(afterName + 2);
  const question = buf.subarray(12, afterName + 4);

  const mk = (rcode, ans = [], auth = []) => {
    // QR=1, AA=1 (authoritative for this zone), RA=0 -- we are NOT a resolver.
    const f = 0x8400 | (opcode << 11) | rcode;
    const head = Buffer.alloc(12);
    head.writeUInt16BE(id, 0);
    head.writeUInt16BE(f, 2);
    head.writeUInt16BE(1, 4);
    head.writeUInt16BE(ans.length, 6);
    head.writeUInt16BE(auth.length, 8);
    return Buffer.concat([head, question, ...ans, ...auth]);
  };

  if (opcode !== 0 || qclass !== 1) return respond(mk(4));
  const rr = answersFor(qname, qtype);
  if (rr === null) return respond(mk(5));   // REFUSED: not our zone

  const ans = [];
  for (const r of rr) {
    if (r.type === TYPE.A) ans.push(rrBuf(qname, TYPE.A, cfg.ttl, v4buf(r.host)));
    else if (r.type === TYPE.AAAA) ans.push(rrBuf(qname, TYPE.AAAA, cfg.ttl, v6buf(r.host)));
    else if (r.type === TYPE.NS) ans.push(rrBuf(qname, TYPE.NS, 3600, encodeName(r.name)));
    else if (r.type === TYPE.SOA) ans.push(rrBuf(qname, TYPE.SOA, 900, soaRdata()));
  }
  // No data: still NOERROR, with the SOA in the authority section. That says
  // "this name exists, there is just nothing of this type" rather than
  // "this name does not exist", which is what a resolver needs to hear.
  const auth = ans.length === 0 ? [rrBuf(cfg.zone, TYPE.SOA, 900, soaRdata())] : [];
  respond(mk(0, ans, auth));
}

const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
udp.on('message', (buf, rinfo) => {
  if (rateLimited(rinfo.address)) return;
  try {
    handle(buf, out => {
      // Never emit a UDP response over 512 bytes without EDNS0. A truncated
      // answer with TC=1 tells the resolver to retry over TCP, which is both
      // honest and the thing that stops this being an amplifier.
      let o = out;
      if (o.length > 512) {
        o = Buffer.from(o.subarray(0, 512));
        o.writeUInt16BE(o.readUInt16BE(2) | 0x0200, 2);
      }
      udp.send(o, rinfo.port, rinfo.address);
    });
  } catch (e) { log('udp handler error: ' + e.message); }
});
udp.on('error', e => { log('udp error: ' + e.message); process.exit(1); });
udp.bind(cfg.port, cfg.bind, () => log('DNS listening on ' + cfg.bind + ':' + cfg.port + ' for zone ' + cfg.zone));

const tcp = net.createServer(sock => {
  sock.setTimeout(10000, () => sock.destroy());
  let buf = Buffer.alloc(0);
  sock.on('error', () => {});
  sock.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    if (buf.length > 8192) return sock.destroy();
    while (buf.length >= 2) {
      const len = buf.readUInt16BE(0);
      if (buf.length < 2 + len) return;
      const q = buf.subarray(2, 2 + len);
      buf = buf.subarray(2 + len);
      if (rateLimited(sock.remoteAddress || '?')) return sock.destroy();
      try {
        handle(q, out => {
          const l = Buffer.alloc(2);
          l.writeUInt16BE(out.length, 0);
          sock.write(Buffer.concat([l, out]));
        });
      } catch (e) { log('tcp handler error: ' + e.message); }
    }
  });
});
tcp.on('error', e => log('tcp error: ' + e.message));
tcp.listen(cfg.port, cfg.bind);

crawl();
setInterval(crawl, cfg.crawlIntervalMs).unref();
setInterval(saveState, 300000).unref();
process.on('SIGTERM', () => { saveState(); process.exit(0); });
process.on('SIGINT', () => { saveState(); process.exit(0); });
