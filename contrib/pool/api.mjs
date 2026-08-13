// The pool's public HTTP API.
//
//   GET /api/pools          MiningCore-shaped, which is what the mining
//                           directories parse. MiningPoolStats, CryptUnit,
//                           hashrate.no and minerstat all expect this shape, and
//                           several will only list a pool "if a public API can
//                           be identified" -- so the shape is the deliverable,
//                           not a nicety.
//   GET /api/pools/pcoin    the same single pool object
//   GET /health             for uptime checks
//
// Public, no auth, CORS open, read-only. It exposes AGGREGATES only: no miner
// addresses, no share detail, nothing that identifies who is mining here. The
// pool is allowlisted to a handful of machines right now and publishing their
// payout addresses would be a gift to nobody.
//
// TWO RULES IT FOLLOWS, both of which are this project's own:
//
//   A number nobody measured is not reported. Every field is derived from the
//   ledger or from a node reading. Where a value could not be read, it is null
//   with a timestamp saying when it last was -- never 0, because a directory
//   showing "0 H/s" reads as "this pool is dead" and a stale-but-honest number
//   with an age is strictly better than a confident wrong one (7.1).
//
//   It binds to LOOPBACK. Caddy terminates TLS and proxies in. This process
//   handles money-adjacent state and has no business parsing hostile bytes off
//   the open internet when something better already does it.

import http from 'node:http';

const ISO = (ms) => (ms ? new Date(ms).toISOString() : null);

/**
 * @param {object} o
 * @param {object} o.cfg          the pool config
 * @param {function} o.snapshot   async () => live numbers (see pool.mjs)
 * @param {function} o.log
 */
export function createApi({ cfg, snapshot, log }) {
  const send = (res, code, body) => {
    const json = JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? Number(v) : v), 2);
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'cache-control': 'public, max-age=30',
      'x-content-type-options': 'nosniff',
    });
    res.end(json);
  };

  async function poolObject() {
    const s = await snapshot();
    const portKey = String(cfg.port);
    return {
      id: 'pcoin',
      coin: {
        type: 'PCN',
        name: 'PCoin',
        symbol: 'PCN',
        family: 'bitcoin',
        algorithm: 'RandomX',
        // Not a decoration: it is the one thing a miner integrating with this
        // chain has to get right, and it never rotates.
        randomxKey: 'PCoin/RandomX/v1',
        website: 'https://pc.am',
        explorer: 'https://explorer.pc.am',
      },
      ports: {
        [portKey]: {
          listenAddress: '0.0.0.0',
          name: 'Stratum',
          tls: false,
          tlsAuto: false,
          varDiff: {
            minDiff: cfg.vardiff.minFactor,
            maxDiff: cfg.vardiff.maxFactor,
            targetTime: cfg.vardiff.targetSeconds,
            retargetTime: cfg.vardiff.retuneSeconds,
          },
        },
      },
      paymentProcessing: {
        enabled: true,
        // PAID BY THE COINBASE. There is no wallet, no payout transaction and
        // no operator float: each block pays its miners directly, so the
        // minimum is the relay dust limit rather than a threshold we chose.
        payoutScheme: 'PPLNS',
        payoutSchemeConfig: { factor: cfg.pplns.windowMultiplier },
        minimumPayment: Number((cfg.dustLimit ?? 294) / 1e8),
        payoutMethod: 'coinbase',
        payoutInterval: 'every block found',
      },
      poolFeePercent: cfg.feeBasisPoints / 100,
      addressInfoLink: null,
      poolStats: {
        connectedMiners: s.connectedMiners,
        poolHashrate: s.poolHashrate,
        sharesPerSecond: s.sharesPerSecond,
      },
      networkStats: {
        networkType: s.chain || null,
        networkHashrate: s.networkHashrate,
        networkDifficulty: s.networkDifficulty,
        lastNetworkBlockTime: ISO(s.lastNetworkBlockTime),
        blockHeight: s.blockHeight,
        connectedPeers: s.connectedPeers,
        rewardType: 'POW',
      },
      lastPoolBlockTime: ISO(s.lastPoolBlockTime),
      totalBlocks: s.totalBlocks,
      totalPaid: s.totalPaid,
      blockRefreshInterval: cfg.templatePollMs,
      // Honesty fields, not part of MiningCore's shape. A consumer that ignores
      // them loses nothing; one that reads them can tell a stale number from a
      // fresh one, which is the difference between "quiet" and "broken".
      pcoin: {
        nodeReadAt: ISO(s.nodeReadAt),
        nodeReadable: s.nodeReadable,
        open: s.open,
        note: s.open
          ? 'open to any miner'
          : 'invite-only while payout accounting is reconciled against the chain',
      },
    };
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') { send(res, 204, {}); return; }
      if (req.method !== 'GET') { send(res, 405, { error: 'GET only' }); return; }
      const path = (req.url || '/').split('?')[0].replace(/\/+$/, '') || '/';

      if (path === '/health') { send(res, 200, { status: 'ok', time: ISO(Date.now()) }); return; }
      if (path === '/api/pools') { send(res, 200, { pools: [await poolObject()] }); return; }
      if (path === '/api/pools/pcoin') { send(res, 200, { pool: await poolObject() }); return; }
      send(res, 404, { error: 'not found', endpoints: ['/api/pools', '/api/pools/pcoin', '/health'] });
    } catch (e) {
      // A broken API must never take the mining pool down with it.
      log(`api: ${e.message.slice(0, 160)}`);
      try { send(res, 500, { error: 'internal' }); } catch { /* client gone */ }
    }
  });
  server.on('clientError', (_e, sock) => { try { sock.destroy(); } catch { /* gone */ } });
  return server;
}
