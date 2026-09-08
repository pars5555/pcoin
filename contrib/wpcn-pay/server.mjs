#!/usr/bin/env node
//
// pcoin-wpcn-pay -- one verifier that lets every PCoin project accept wPCN.
//
// WHAT IT IS
// A project sends a customer's BSC transaction hash here. This service reads
// the transaction receipt off BNB Smart Chain, proves it contains a wPCN
// Transfer into our payment address, records the claim so no two projects can
// bank the same payment, and answers with an amount in USD. The project credits
// its own user. This service never touches user balances and never holds a key.
//
// WHY A TX HASH AND NOT A DEPOSIT ADDRESS PER USER
// The PCN rails give every customer their own address and watch the chain. That
// does not port to BEP-20:
//   * there is no memo field, so one shared address cannot tell payers apart;
//   * a per-user address needs BNB in it before anything can be swept out,
//     which means funding thousands of addresses with gas;
//   * watching would mean eth_getLogs over a range, and the public BSC RPCs now
//     refuse that outright ("limit exceeded") -- measured 2026-09-08.
// eth_getTransactionReceipt for ONE hash is still served by every public RPC.
// So the customer hands us the hash. It is one extra field in a form, and it
// removes the gas problem, the sweeping problem and the indexing problem at
// once.
//
// THE FOUR RULES, WHICH THIS FILE EXISTS TO ENFORCE
// docs.pc.am states them for PCN; every one has cost money at least once. They
// carry over to wPCN with one change each:
//   1. Key the ledger on (txhash, logIndex). NOT the hash alone -- one
//      transaction can carry several Transfer logs, and keying on the hash
//      silently DROPS the second. This is the BEP-20 shape of the
//      (txid, address) rule that all four original rails shipped wrong.
//   2. Read the rate at credit time and STAMP it on the row.
//   3. A failed, timed-out or stale read resolves NOTHING. Hold, never credit.
//      There is no `?? 0` in this file on any value that decides money.
//   4. Gate on confirmations, and detect reorgs without ever auto-reversing.
//
// AND THE FIFTH, LEARNED THE EXPENSIVE WAY
//   5. Never gate on a cumulative counter. One ordinary reorg set
//      blocks_unwound to 1 on 2026-08-30 and every PCN rail refused to credit
//      anything for three and a half days while exiting clean each tick.
//      Health here is "the node answered and the receipt is buried deep
//      enough", never "nothing has ever gone wrong".

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { join } from 'node:path';

const CONFIG = process.env.WPCN_PAY_CONFIG || '/etc/pcoin/wpcn-pay.json';

if (!existsSync(CONFIG)) {
  console.error(`no config at ${CONFIG}`);
  process.exit(1);
}
// stripBom: a config edited on Windows arrives with a UTF-8 byte-order mark,
// and JSON.parse rejects it with "Unexpected token" pointing at character one --
// which reads like a corrupt file, not an encoding. Cost a debugging round on
// 2026-09-08. PowerShell's `Set-Content -Encoding utf8` writes one by default.
const cfg = JSON.parse(readFileSync(CONFIG, 'utf8').replace(/^\uFEFF/, ''));

// ---------------------------------------------------------------------------
// Configuration, and refusing to run on a guess.
//
// A script that silently defaults is a different program from the one you
// tested. pcoin-wrapdesk-watch defaulted a height floor to 0 when run outside
// its unit, re-read the reserve's own founding deposit as a customer owed
// 50,000 PCN, and paged the owner at 15:20 UTC with an alert indistinguishable
// from a real one. Nothing below gets a default that could be mistaken for a
// decision.
// ---------------------------------------------------------------------------
const TOKEN      = (cfg.token      || '').toLowerCase();  // wPCN contract
const PAY_TO     = (cfg.payTo      || '').toLowerCase();  // where customers pay
const DECIMALS   = cfg.decimals;                          // wPCN is 8, not 18
const MIN_CONF   = cfg.minConfirmations;
const BONUS_PCT  = cfg.bonusPercent;                      // the wPCN discount
const RPCS       = cfg.rpcUrls || [];
const PRICE_URL  = cfg.priceUrl || 'https://price.pc.am';
const DB_DIR     = cfg.dbDir    || '/var/lib/pcoin-wpcn-pay/claims';
const CLIENTS    = cfg.clients  || {};                    // token -> project name
const PORT       = cfg.port     || 8792;
const BIND       = cfg.bind     || '127.0.0.1';

const missing = [];
if (!/^0x[0-9a-f]{40}$/.test(TOKEN))  missing.push('token (wPCN contract address)');
if (!/^0x[0-9a-f]{40}$/.test(PAY_TO)) missing.push('payTo (the address customers pay)');
if (!Number.isInteger(DECIMALS))      missing.push('decimals');
if (!Number.isInteger(MIN_CONF))      missing.push('minConfirmations');
if (typeof BONUS_PCT !== 'number')    missing.push('bonusPercent');
if (!RPCS.length)                     missing.push('rpcUrls');
if (!Object.keys(CLIENTS).length)     missing.push('clients');
if (missing.length) {
  console.error('refusing to start; these are unset and have no safe default:\n  ' +
    missing.join('\n  '));
  process.exit(1);
}

// keccak256("Transfer(address,address,uint256)")
const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// Ledger. One JSON file per claim, named for its (txhash, logIndex).
//
// The uniqueness guarantee is the FILESYSTEM's: writeFileSync with flag 'wx'
// is an O_CREAT|O_EXCL create, which either makes the file or throws EEXIST,
// atomically, with no read-then-write window. Two projects racing on the same
// hash, or one project retrying after a lost response, both land on the same
// name and exactly one wins. That is the whole anti-double-credit mechanism.
//
// Deliberately NOT node:sqlite. That API is still flagged experimental and
// prints a warning on every start; a financial ledger should not be one node
// upgrade away from behaving differently. It also confined this service to the
// two hosts running node >= 22.5, which is a silly constraint for something
// that needs an append-only set of small records. A directory of files is
// greppable, backs up with rsync, and needs no dependency at all.
mkdirSync(DB_DIR, { recursive: true });

const claimPath = (txhash, logIndex) => join(DB_DIR, txhash + '-' + logIndex + '.json');

function readClaim(txhash, logIndex) {
  try { return JSON.parse(readFileSync(claimPath(txhash, logIndex), 'utf8')); }
  catch { return null; }
}

/** Returns false if this claim already existed. Never overwrites. */
function insertClaim(rec) {
  const p = claimPath(rec.txhash, rec.log_index);
  try {
    writeFileSync(p, JSON.stringify(rec, null, 2) + '\n', { flag: 'wx', mode: 0o640 });
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  }
  // A credit that is not on disk when the process dies is a credit the customer
  // can claim twice. fsync before we tell anyone it happened.
  const fd = openSync(p, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
  return true;
}

function claimsFor(project, userRef) {
  return readdirSync(DB_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => { try { return JSON.parse(readFileSync(join(DB_DIR, f), 'utf8')); } catch { return null; } })
    .filter(c => c && c.project === project && c.user_ref === userRef)
    .sort((a, b) => b.at - a.at)
    .slice(0, 50)
    .map(claimWireShape);
}

// The stored record and the /verify reply had grown DIFFERENT NAMES for the
// same three fields, and /claims returned the stored record verbatim:
//
//            log index    amount         rate
//   /verify  logIndex     usd            rate_usd
//   /claims  log_index    usd_credited   credited_rate_usd
//
// Two endpoints of one service disagreeing about what to call a log index is a
// defect in this service, not in the clients that read it. It was found by an
// integrator whose heal path read the /verify names off a /claims row and got
// undefined for all three — a heal that would have failed even with a correct
// HTTP client, and would have failed SILENTLY, because "no amount here" and
// "amount is zero" look alike once a number goes missing.
//
// Fixed additively: every /claims row now carries BOTH spellings. Adding names
// cannot break a reader; renaming would have broken the one integrator who had
// already coded to the stored names. The stored file is untouched — it is the
// ledger, and its shape is not an API.
function claimWireShape(c) {
  return {
    ...c,
    logIndex: c.log_index,
    usd: c.usd_credited,
    rate_usd: c.credited_rate_usd,
  };
}

const claimCount = () => readdirSync(DB_DIR).filter(f => f.endsWith('.json')).length;

// RPC. Every public BSC endpoint rate-limits, so try them in turn -- but an
// exhausted list THROWS. It must never return a shape that reads like "no
// transfer found", because that is the difference between "we could not look"
// and "the customer did not pay", and collapsing the two is how a rail credits
// a payment that never happened or refuses one that did.
// ---------------------------------------------------------------------------
async function rpc(method, params) {
  let lastErr;
  for (const url of RPCS) {
    try {
      const ctl = AbortSignal.timeout(12000);
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: ctl,
      });
      if (!r.ok) { lastErr = new Error(`${url}: HTTP ${r.status}`); continue; }
      const j = await r.json();
      if (j.error) { lastErr = new Error(`${url}: ${j.error.message}`); continue; }
      return j.result;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`every RPC failed for ${method}: ${lastErr && lastErr.message}`);
}

const hexToBig = h => BigInt(h);
const addrFromTopic = t => '0x' + String(t).slice(26).toLowerCase();

// ---------------------------------------------------------------------------
// The rate. An unreadable rate is not a rate of zero -- it is a reason to stop.
// pc.am once advertised a stale price for hours and 3dmodels credited a batch
// at one fifteenth of value; both were a number standing in for an answer.
// ---------------------------------------------------------------------------
async function usdRate() {
  const r = await fetch(PRICE_URL, { signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`price feed HTTP ${r.status}`);
  const j = await r.json();
  const rate = Number(j.price);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error('price feed gave no usable rate');
  // The feed says so itself when it is serving a remembered number. Rule 3.
  if (j.stale === true) throw new Error('price feed reports itself stale');
  return rate;
}

// ---------------------------------------------------------------------------
// Verify one transaction hash.
// ---------------------------------------------------------------------------
async function verify(txhash, project, userRef) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txhash)) {
    return { ok: false, state: 'bad_request', message: 'txhash must be 0x + 64 hex characters' };
  }
  txhash = txhash.toLowerCase();

  const receipt = await rpc('eth_getTransactionReceipt', [txhash]);

  // null here is genuinely ambiguous -- unmined, dropped, or simply not yet
  // visible to the node we happened to reach. It is NOT "no payment".
  if (!receipt) {
    return { ok: false, state: 'pending',
             message: 'not visible on chain yet; ask again shortly' };
  }
  if (receipt.status !== '0x1') {
    return { ok: false, state: 'reverted',
             message: 'that transaction failed on chain; nothing was transferred' };
  }

  const head    = Number(hexToBig(await rpc('eth_blockNumber', [])));
  const blockNo = Number(hexToBig(receipt.blockNumber));
  const confs   = head - blockNo + 1;

  // Find every wPCN Transfer in this receipt that paid us. Several is legal.
  const transfers = (receipt.logs || []).filter(l =>
    String(l.address).toLowerCase() === TOKEN &&
    String(l.topics && l.topics[0]).toLowerCase() === TRANSFER_TOPIC &&
    addrFromTopic(l.topics[2]) === PAY_TO);

  if (!transfers.length) {
    return { ok: false, state: 'no_payment',
             message: 'that transaction contains no wPCN transfer to the payment address' };
  }

  if (confs < MIN_CONF) {
    return { ok: false, state: 'confirming', confirmations: confs, required: MIN_CONF,
             message: `seen, waiting for confirmations (${confs}/${MIN_CONF})` };
  }

  // Reorg check: the receipt we just read must still be on the canonical chain.
  // Detect, refuse, and say so -- never silently accept, never auto-reverse
  // anything already credited (rule 4).
  const block = await rpc('eth_getBlockByNumber', ['0x' + blockNo.toString(16), false]);
  if (!block || String(block.hash).toLowerCase() !== String(receipt.blockHash).toLowerCase()) {
    return { ok: false, state: 'reorged',
             message: 'the block holding this transaction is no longer canonical; not crediting' };
  }

  const results = [];
  for (const log of transfers) {
    const logIndex = Number(hexToBig(log.logIndex));

    const already = readClaim(txhash, logIndex);
    if (already) {
      // Idempotent by construction. A retry after a lost response, or a second
      // project trying the same hash, both land here instead of double-crediting.
      results.push({
        state: 'already_claimed',
        txhash, logIndex,
        wpcn: already.wpcn,
        usd: already.usd_credited,
        project: already.project,
        user_ref: already.user_ref,
        at: already.at,
        yours: already.project === project && already.user_ref === String(userRef),
      });
      continue;
    }

    const raw  = hexToBig(log.data);
    const wpcn = Number(raw) / 10 ** DECIMALS;

    // Rate is read AFTER we know there is something to credit, and stamped.
    // If this throws, nothing is written and the caller retries later; that is
    // the correct outcome, and much better than banking a guessed rate.
    const rate = await usdRate();
    const usd  = wpcn * rate * (1 + BONUS_PCT / 100);

    const rec = {
      txhash, log_index: logIndex,
      block_number: blockNo,
      block_hash: String(receipt.blockHash).toLowerCase(),
      payer: addrFromTopic(log.topics[1]),
      wpcn_raw: raw.toString(),
      wpcn,
      credited_rate_usd: rate,       // rule 2: stamped once, never recomputed
      bonus_pct: BONUS_PCT,
      usd_credited: usd,
      project, user_ref: String(userRef),
      at: Math.floor(Date.now() / 1000),
    };

    // Lost the race. Somebody claimed this between our read above and here --
    // two projects submitting the same hash at once. Report it as claimed
    // rather than crediting, and re-read to say who got it.
    if (!insertClaim(rec)) {
      const won = readClaim(txhash, logIndex);
      results.push({
        state: 'already_claimed',
        txhash, logIndex,
        wpcn: won && won.wpcn,
        usd: won && won.usd_credited,
        project: won && won.project,
        user_ref: won && won.user_ref,
        yours: !!won && won.project === project && won.user_ref === String(userRef),
      });
      continue;
    }

    results.push({
      state: 'credited',
      txhash, logIndex,
      wpcn,
      rate_usd: rate,
      bonus_pct: BONUS_PCT,
      usd,
      confirmations: confs,
    });
  }

  const credited = results.filter(r => r.state === 'credited');
  return {
    ok: credited.length > 0,
    state: credited.length ? 'credited' : 'already_claimed',
    confirmations: confs,
    transfers: results,
    usd_total: credited.reduce((a, r) => a + r.usd, 0),
    wpcn_total: credited.reduce((a, r) => a + r.wpcn, 0),
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const readBody = req => new Promise((res, rej) => {
  let b = ''; let n = 0;
  req.on('data', c => { n += c.length; if (n > 64 * 1024) { rej(new Error('body too large')); req.destroy(); } b += c; });
  req.on('end', () => res(b));
  req.on('error', rej);
});

function projectFor(req) {
  const auth = req.headers.authorization || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  return CLIENTS[m[1].trim()] || null;
}

createServer(async (req, res) => {
  const send = (code, obj) => {
    const body = JSON.stringify(obj, null, 2) + '\n';
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  };
  try {
    const url = new URL(req.url, 'http://x');

    if (url.pathname === '/health') {
      // Deliberately NOT a chain call: a health endpoint that depends on a
      // third party goes red when the third party hiccups, and then nobody
      // trusts it. It answers "this process is up and its ledger is writable".
      const n = claimCount();
      return send(200, { ok: true, claims: n, payTo: PAY_TO, bonusPercent: BONUS_PCT,
                         minConfirmations: MIN_CONF });
    }

    const project = projectFor(req);
    if (!project) return send(401, { ok: false, error: 'unknown or missing bearer token' });

    if (url.pathname === '/verify' && req.method === 'POST') {
      let body;
      try { body = JSON.parse(await readBody(req) || '{}'); }
      catch { return send(400, { ok: false, error: 'body must be JSON' }); }

      const { txhash, user_ref } = body;
      if (!txhash || !user_ref) {
        return send(400, { ok: false, error: 'txhash and user_ref are both required' });
      }
      try {
        const out = await verify(String(txhash), project, String(user_ref));
        // 200 for a definite answer either way; 503 when we could not look.
        return send(out.state === 'bad_request' ? 400 : 200, out);
      } catch (e) {
        // Rule 3, at the outermost edge: we could not read, so we resolve
        // nothing. 503 tells the caller to retry rather than to give up.
        return send(503, { ok: false, state: 'unreadable', message: String(e.message) });
      }
    }

    if (url.pathname === '/claims' && req.method === 'GET') {
      const userRef = url.searchParams.get('user_ref');
      if (!userRef) return send(400, { ok: false, error: 'user_ref is required' });
      return send(200, { ok: true, project, claims: claimsFor(project, userRef) });
    }

    return send(404, { ok: false, error: 'no such endpoint' });
  } catch (e) {
    return send(500, { ok: false, error: String(e && e.message) });
  }
}).listen(PORT, BIND, () => {
  console.log(`pcoin-wpcn-pay on ${BIND}:${PORT}`);
  console.log(`  paying to ${PAY_TO}, ${MIN_CONF} confirmations, +${BONUS_PCT}% bonus`);
  console.log(`  ${Object.keys(CLIENTS).length} project token(s) configured`);
});
