#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// transfer-test.mjs -- the checks behind the admin panel's "Move PCN" page.
// ═══════════════════════════════════════════════════════════════════════════
//
//   cd contrib/vault && npm ci            # once: the packages vault-sweep and the bundle use
//   node contrib/admin-panel/transfer-test.mjs
//   node contrib/admin-panel/transfer-test.mjs --browser    # ...and the real page, headless
//
// WHAT IT PROVES, in order
//   1. transfer-crypto.bundle.js is the bundle pinned in transfer.mjs, and the
//      page loads each script with an integrity hash that matches what is served.
//   2. vault-sweep.mjs --selftest's vectors (BIP143 sighash, the published DER
//      signature, DER edge cases, the `ct` field, wrong passphrase, refused
//      destinations) pass through the BROWSER signer, and the published PCoin
//      derivation vectors (PCOIN.md 6.4) come out of the bundle.
//   3. EQUIVALENCE: for throwaway wallets and fake UTXOs, the browser signer --
//      transfer-core.js run under Node against the same bundle -- produces a
//      raw transaction and txid BYTE-IDENTICAL to vault-sweep.mjs itself, run
//      unmodified as a subprocess on the same files, destination, amount and fee
//      rate. One input with change, several inputs with a tie in value, a sweep
//      with no change, explicit change, dust change folded into the fee, another
//      fee rate, exchange with change-to, wpcn-reserve with consent. The printed
//      preview lines and the receipt fields are compared too.
//   4. Every guard fires: xpub mismatch (both tools), wrong passphrase, the
//      wPCN reserve below 50,000 (page) and without consent or change-to (both),
//      exchange without change-to (both) and with change to its own address
//      (page), non-pc1q-v0 destinations (both), dust, rail addresses.
//   5. NOTHING THE PAGE SENDS CONTAINS A SECRET. Every request the page's network
//      layer made during all of the above -- scans, reserve reads, broadcasts --
//      is searched for the passphrase, each mnemonic and every 3-word run of it,
//      the seeds, the xprvs, every private key that signed, the AES keys, and the
//      seed files whole and field by field. Plus static checks on the two client
//      files and the server routes.
//   6. vault.mjs, the Vault commands page, still renders no input element.
//
// WHAT IT TOUCHES: NOTHING REAL
//   Every wallet is a mnemonic generated here, encrypted in the real blob format
//   (scrypt N=2^17 r=8 p=1, AES-256-GCM) with a test passphrase, in a temporary
//   directory deleted at the end. vault-sweep.mjs is COPIED there -- and the copy
//   checked byte-identical -- so it reads those files and writes its receipts
//   there. The "explorer" is an HTTP server on 127.0.0.1 inside this process;
//   vault-sweep's PCOIN_EXPLORER points at it, and it answers every broadcast with
//   HTTP 503 after recording it. That refusal is how vault-sweep's own receipt,
//   with its raw_hex, is obtained: run with --send, it tries the local mock, is
//   refused, and writes the receipt. Nothing leaves this machine, and the fake
//   UTXOs have random txids that exist on no chain.
//
//   --browser (section 9) additionally starts the real server.mjs on 127.0.0.1
//   and drives the page in a HEADLESS browser this script launches with a
//   throwaway profile in the same temporary directory. It never attaches to a
//   browser anyone is using -- in particular never the automation instance on
//   :9761 -- and it closes and deletes its own when it is done.
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, cpSync, rmSync, readdirSync, existsSync, copyFileSync } from 'node:fs';
import { createHash, randomBytes, scryptSync, createCipheriv } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { tmpdir, hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const VAULT = join(HERE, '..', 'vault');
const NM = join(VAULT, 'node_modules');
// --browser: also drive the REAL page in a real browser (section 9) -- a
// HEADLESS Edge/Chromium this script launches itself, with a throwaway profile
// inside the test's temporary directory, and closes and deletes afterwards.
// It never attaches to a browser somebody is using: not the owner's, and not
// the dedicated automation instance on :9761, which a person signs in with.
// TRANSFER_TEST_BROWSER overrides the executable (e.g. chromium on Linux).
const BROWSER = process.argv.includes('--browser');
const BROWSER_EXE = process.env.TRANSFER_TEST_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ok    ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (detail !== undefined ? '\n          ' + String(detail).split('\n').join('\n          ') : '')); }
};
const section = (t) => console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(2, 72 - t.length)));
const sha256 = (b) => createHash('sha256').update(b).digest();
const hash160 = (b) => createHash('ripemd160').update(sha256(b)).digest();
async function refusalOf(fn) {
  try { await fn(); return null; } catch (e) { return e; }
}
// Source with comments removed, so a file's own prose about what it must not
// do can neither trip nor satisfy a check on what its code does.
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');

if (!existsSync(join(NM, '@scure', 'bip39', 'index.js'))) {
  console.error('contrib/vault/node_modules is missing. Run `npm ci` in contrib/vault first.');
  process.exit(2);
}
const mod = (p) => import(pathToFileURL(join(NM, p)).href);
const bip39 = await mod('@scure/bip39/index.js');
const { wordlist } = await mod('@scure/bip39/wordlists/english.js');
const { HDKey } = await mod('@scure/bip32/index.js');
const { bech32, bech32m } = await mod('@scure/base/index.js');
const p2wpkh = (pub) => bech32.encode('pc', [0, ...bech32.toWords(hash160(Buffer.from(pub)))]);

// ── a throwaway workspace ────────────────────────────────────────────────────
const TMP = mkdtempSync(join(tmpdir(), 'pcoin-transfer-test-'));
const SWEEP_DIR = join(TMP, 'vault');
mkdirSync(SWEEP_DIR);
const PASS = 'transfer test ' + randomBytes(12).toString('base64');     // throwaway
const ACCOUNT = "m/84'/9444'/0'";

function encryptBlob(plaintext, pass, N) {
  // pcoin-seed-vault.mjs encrypt(), exactly: the real format, the real costs.
  const salt = randomBytes(16);
  const key = scryptSync(pass, salt, 32, { N, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return { blob: { v: 1, kdf: 'scrypt', N, r: 8, p: 1, salt: salt.toString('base64'), iv: iv.toString('base64'),
                   ct: ct.toString('base64'), tag: c.getAuthTag().toString('base64') }, key };
}

const SECRETS = [];          // [label, string] -- what must never appear in a request
function makeWallet(name, { mnemonic = bip39.generateMnemonic(wordlist, 128), xpubFrom = null, N = 1 << 17 } = {}) {
  const acct = HDKey.fromMasterSeed(bip39.mnemonicToSeedSync(mnemonic)).derive(ACCOUNT);
  const xpub = (xpubFrom || acct).publicExtendedKey;
  const addr = (branch, i) => p2wpkh(HDKey.fromExtendedKey(xpub).deriveChild(branch).deriveChild(i).publicKey);
  const { blob, key } = encryptBlob(mnemonic, PASS, N);
  Object.assign(blob, { system: name, chain: 'pcn', path: ACCOUNT, xpub: acct.publicExtendedKey,
                        address0: p2wpkh(acct.deriveChild(0).deriveChild(0).publicKey), created: '2026-09-24' });
  const xpubFile = join(SWEEP_DIR, name + '-xpub.txt');
  const seedFile = join(SWEEP_DIR, name + '-seed.enc.json');
  writeFileSync(xpubFile, xpub + '\n');
  writeFileSync(seedFile, JSON.stringify(blob, null, 2) + '\n');
  // Everything secret about this wallet, in every spelling a leak could take.
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const words = mnemonic.split(' ');
  SECRETS.push([name + ': mnemonic', mnemonic], [name + ': mnemonic, url-encoded', encodeURIComponent(mnemonic)]);
  for (let i = 0; i + 3 <= words.length; i++) SECRETS.push([name + ': mnemonic words ' + i + '..' + (i + 2), words.slice(i, i + 3).join(' ')]);
  SECRETS.push([name + ': seed', Buffer.from(seed).toString('hex')]);
  SECRETS.push([name + ': master xprv', HDKey.fromMasterSeed(seed).privateExtendedKey]);
  SECRETS.push([name + ': account xprv', acct.privateExtendedKey]);
  SECRETS.push([name + ': account private key', Buffer.from(acct.privateKey).toString('hex')]);
  SECRETS.push([name + ': AES key', key.toString('hex')]);
  SECRETS.push([name + ': seed file', readFileSync(seedFile, 'utf8')]);
  for (const f of ['ct', 'salt', 'iv', 'tag']) SECRETS.push([name + ': blob.' + f, blob[f]]);
  const privAt = (branch, i) => Buffer.from(acct.deriveChild(branch).deriveChild(i).privateKey).toString('hex');
  return { name, mnemonic, xpub, addr, xpubFile, seedFile, privAt, acct };
}
SECRETS.push(['passphrase', PASS], ['passphrase, url-encoded', encodeURIComponent(PASS)],
             ['passphrase, base64', Buffer.from(PASS).toString('base64')], ['passphrase, hex', Buffer.from(PASS).toString('hex')]);

// The wallets. `exchange` and `wpcn-reserve` by those names, because the guards
// key on the name exactly as vault-sweep's do.
const A = makeWallet('zzalpha');
const X = makeWallet('exchange');
const R = makeWallet('wpcn-reserve');
const B = makeWallet('zzbravo');                                   // a second, unrelated wallet
const MIS = makeWallet('zzmismatch', { mnemonic: B.mnemonic, xpubFrom: A.acct });   // A's xpub, B's seed
const EXT = p2wpkh(HDKey.fromMasterSeed(randomBytes(32)).derive("m/0").publicKey);     // someone else's
const EXT2 = p2wpkh(HDKey.fromMasterSeed(randomBytes(32)).derive("m/1").publicKey);

// transfer.mjs reads these at import; point them at test files.
const REQUESTS = join(TMP, 'requests.json');
const DESTS = join(TMP, 'destinations.json');
process.env.WRAPDESK_STATE = REQUESTS;
process.env.ADMIN_TRANSFER_DESTINATIONS = DESTS;
process.env.WRAP_RESERVE = R.addr(0, 0);
writeFileSync(REQUESTS, JSON.stringify({
  nextIndex: 4,
  requests: {
    '0xaaaa000000000000000000000000000000000001': { bsc: '0xAAAA000000000000000000000000000000000001', index: 1, address: R.addr(0, 1), amount: 10, account: 'alice@example.test', ip: '203.0.113.9', created: 1 },
    '0xbbbb000000000000000000000000000000000002': { bsc: '0xBBBB000000000000000000000000000000000002', index: 2, address: R.addr(0, 2), amount: 5, account: 'bob@example.test', ip: '198.51.100.23', created: 2 },
    '0xcccc000000000000000000000000000000000003': { bsc: '0xCCCC000000000000000000000000000000000003', index: 0, address: R.addr(0, 0), amount: 1, account: 'carol@example.test', ip: '192.0.2.77', created: 3 },
  },
}, null, 1));
const PRIVATE_ROW_VALUES = ['0xAAAA', '0xaaaa', 'alice@example.test', '203.0.113.9', 'bob@example.test', '198.51.100.23', 'carol@example.test', '192.0.2.77'];

const T = await import('./transfer.mjs');

// ── the browser code, under Node, against the same bundle ───────────────────
const BUNDLE = readFileSync(join(HERE, 'transfer-crypto.bundle.js'));
vm.runInThisContext(BUNDLE.toString('utf8'), { filename: 'transfer-crypto.bundle.js' });
vm.runInThisContext(readFileSync(join(HERE, 'transfer-core.js'), 'utf8'), { filename: 'transfer-core.js' });
const C = globalThis.PCoinCrypto;
const K = globalThis.PCoinTransferCore;

// ── the mock explorer (and the panel's two routes, served by the REAL code) ──
const M = {
  utxos: new Map(), onchainExtra: new Map(), pending: new Map(),
  tx: { status: 503, body: { error: { code: 'test_mock', message: 'test mock: nothing is broadcast' } } },
  broadcasts: [], unknownMempool: false, hasMore: false, badScript: null, stale: false,
};
// The block the real API puts on every answer (pcoin_indexer/queries.py health()).
const INDEX = () => (M.stale
  ? { stale: true, stale_reasons: ['index is 2 block(s) behind the last observed node tip'], indexed_height: 98, blocks_behind: 2 }
  : { stale: false, stale_reasons: [], indexed_height: 100, blocks_behind: 0 });
function addUtxo(address, valueSat) {
  if (!M.utxos.has(address)) M.utxos.set(address, []);
  const script = '0014' + Buffer.from(bech32.fromWords(bech32.decode(address).words.slice(1))).toString('hex');
  M.utxos.get(address).push({ txid: randomBytes(32).toString('hex'), vout: randomBytes(1)[0] % 4, value_sat: valueSat, script_hex: script });
}
const SHELL = (page, title, body) => `<!doctype html><html><head><title>${title}</title>`
  + `<script>/* the panel's inline script stands here */ var x = 1;</script></head><body>${body}</body></html>`;
let PANEL_PORT = 0;          // section 9: /tp/* goes to the REAL server.mjs on this port
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (PANEL_PORT && (url.pathname === '/tp' || url.pathname.startsWith('/tp/'))) {
    // Same origin for the page and /api, as on explorer.pc.am: the panel behind
    // a path, the explorer beside it.
    const p = httpRequest({ host: '127.0.0.1', port: PANEL_PORT, method: req.method, path: req.url, headers: req.headers },
      (pr) => { res.writeHead(pr.statusCode, pr.headers); pr.pipe(res); });
    p.on('error', () => { res.writeHead(502); res.end(); });
    return req.pipe(p);
  }
  if (url.pathname.startsWith('/tp/transfer')) {
    return T.transferRoute(url.pathname.slice('/tp'.length), req, res, { base: '/tp', shell: SHELL });
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString('utf8');
  const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.method === 'POST' && url.pathname === '/api/addresses') {
    const seen = [];
    for (const a of JSON.parse(body).addresses) if (!seen.includes(a)) seen.push(a);
    return json(200, { index: INDEX(), mempool: { known: !M.unknownMempool }, count: seen.length, addresses: seen.map((a) => {
      const sp = (M.utxos.get(a) || []).reduce((s, u) => s + u.value_sat, 0);
      const on = sp + (M.onchainExtra.get(a) || 0);
      return { address: a, used: on > 0, balance: { confirmed: {
        mature_sat: sp, spendable_sat: M.unknownMempool ? null : sp - (M.pending.get(a) || 0), onchain_unspent_sat: on,
        pending_spend_sat: M.unknownMempool ? null : (M.pending.get(a) || 0),
      } } };
    }) });
  }
  const m = /^\/api\/address\/([^/]+)\/utxos$/.exec(url.pathname);
  if (req.method === 'GET' && m) {
    const list = (M.utxos.get(m[1]) || []).map((u) => ({
      txid: u.txid, vout: u.vout, value_sat: u.value_sat, value_pcn: (u.value_sat / 1e8).toFixed(8), height: 100,
      is_coinbase: false, mature: true, spent_in_mempool: false, spendable: true, status: 'confirmed',
      script_hex: M.badScript || u.script_hex, script_type: 'witness_v0_keyhash',
    }));
    return json(200, { index: INDEX(), address: m[1], utxos: list, count: list.length, total: list.length, has_more: M.hasMore, mempool: { known: true } });
  }
  if (req.method === 'POST' && url.pathname === '/api/tx') {
    M.broadcasts.push(JSON.parse(body).hex);
    return json(M.tx.status, M.tx.body);
  }
  return json(404, { error: { code: 'not_found' } });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const MOCK = 'http://127.0.0.1:' + server.address().port;

// Everything the page's network layer sends, recorded on the way out.
const SENT = [];
const recFetch = async (url, init) => {
  SENT.push({ url: String(url), method: init.method, headers: JSON.stringify(init.headers || {}), body: init.body == null ? '' : String(init.body) });
  return fetch(url, init);
};
const pageNet = () => K.makeNet({ origin: MOCK, panelBase: '/tp', fetch: recFetch });

// ── vault-sweep.mjs, the real one, copied beside the test wallets ───────────
copyFileSync(join(VAULT, 'vault-sweep.mjs'), join(SWEEP_DIR, 'vault-sweep.mjs'));
cpSync(NM, join(SWEEP_DIR, 'node_modules'), { recursive: true });
async function sweep(args, feeRate = 2) {
  for (const f of readdirSync(SWEEP_DIR)) if (/^sweep-.*\.json$/.test(f)) rmSync(join(SWEEP_DIR, f));
  // It may only ever talk to the mock. PCOIN_EXPLORER is the variable it reads.
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(MOCK)) throw new Error('refusing to run vault-sweep against anything but 127.0.0.1');
  const env = { ...process.env, PCOIN_EXPLORER: MOCK, VAULT_FEE_RATE: String(feeRate) };
  delete env.VAULT_SCAN_TO;
  const child = spawn(process.execPath, [join(SWEEP_DIR, 'vault-sweep.mjs'), ...args, '--send'],
    { cwd: SWEEP_DIR, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  child.stdin.on('error', () => { /* it refused before reading the passphrase */ });
  child.stdin.end(PASS + '\n');
  const code = await new Promise((r) => child.on('close', r));
  const files = readdirSync(SWEEP_DIR).filter((f) => /^sweep-.*\.json$/.test(f));
  const receipt = files.length === 1 ? JSON.parse(readFileSync(join(SWEEP_DIR, files[0]), 'utf8')) : null;
  const txid = (/signed\s+:\s+txid ([0-9a-f]{64})/.exec(out) || [])[1] || null;
  return { code, out, err, receipt, txid };
}
// The lines both tools print for a preview, compared verbatim.
const previewLines = (text) => text.split(/\r?\n/)
  .filter((l) => /^ {3}(SEND|TO|from|fee|change) /.test(l) || /^ {2}(found|available) /.test(l))
  .map((l) => l.replace(/\s+$/, ''));

// The page's whole flow for one order: the SAME preparePlan and signPlan the page calls.
async function page(w, o) {
  const order = {
    system: w.name, xpub: w.xpub, to: o.to, sendAll: Boolean(o.all),
    amountSat: o.amount ? K.parseAmount(o.amount) : null, amountText: o.amount,
    changeTo: o.changeTo || null, feeRate: o.feeRate || 2, reserveConsent: Boolean(o.consent), railAck: Boolean(o.railAck),
  };
  const r = await K.preparePlan(pageNet(), order, { railOf: o.railOf || (() => null) });
  if (r.refusal) return { refusal: r.refusal, plan: r.plan, reserve: r.reserve };
  const signed = await K.signPlan(r.plan, {
    xpubText: readFileSync(w.xpubFile, 'utf8'),
    readSeedText: async () => readFileSync(w.seedFile, 'utf8'),
    passphrase: PASS,
  });
  const bres = await pageNet().broadcast(signed.hex);          // to the mock, which refuses it
  return { plan: r.plan, reserve: r.reserve, signed, broadcast: K.interpretBroadcast(bres, signed.txid) };
}

try {
  // ═════════════════════════════════════════════════════════════════════════
  section('1. the bundle is the pinned one, and the page pins what it loads');
  const bundleHash = sha256(BUNDLE).toString('hex');
  ok('transfer-crypto.bundle.js has the SHA-256 pinned in transfer.mjs', bundleHash === T.BUNDLE_SHA256, bundleHash + ' vs ' + T.BUNDLE_SHA256);
  ok('...and transfer.mjs\'s header states the same hash', readFileSync(join(HERE, 'transfer.mjs'), 'utf8').split('import ')[0].includes(T.BUNDLE_SHA256));
  ok('the server loaded all three scripts without error', Object.values(T.assets).every((a) => a.bytes && !a.error),
    Object.values(T.assets).map((a) => a.error).filter(Boolean).join('; '));
  const pageHtml = T.transferPage('/tp');
  for (const [route, file] of [['crypto.js', 'transfer-crypto.bundle.js'], ['core.js', 'transfer-core.js'], ['ui.js', 'transfer-ui.js']]) {
    const want = 'sha256-' + sha256(readFileSync(join(HERE, file))).toString('base64');
    ok(`the page loads ${route} with integrity ${want.slice(0, 20)}…, matching ${file}`,
      pageHtml.includes(`src="/tp/transfer/${route}" integrity="${want}"`));
    const got = await fetch(MOCK + '/tp/transfer/' + route);
    const bytes = Buffer.from(await got.arrayBuffer());
    ok(`GET /transfer/${route} serves exactly ${file}`, got.status === 200 && bytes.equals(readFileSync(join(HERE, file))));
  }
  ok('the bundle\'s integrity attribute comes from the pin, not from the file',
    T.assets['crypto.js'].sri === 'sha256-' + Buffer.from(T.BUNDLE_SHA256, 'hex').toString('base64'));
  ok('every script is loaded from this origin, and nothing else is loaded',
    [...pageHtml.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].every((m) => m[1].startsWith('/tp/transfer/'))
    && ![...pageHtml.matchAll(/\b(?:src|href)="(https?:)?\/\//g)].length);

  // ═════════════════════════════════════════════════════════════════════════
  section('2. vault-sweep --selftest\'s vectors, through the browser signer');
  {
    const tx = { ins: [
      { txid: '9f96ade4b41d5433f4eda31e1738ec2b36f6e7d1420d94a6af99801a88f7f7ff', vout: 0, sequence: 0xffffffee },
      { txid: '8ac60eb9575db5b2d987e29f301b5b819ea83a5c6579d282d189cc04b8e151ef', vout: 1, sequence: 0xffffffff }],
    outs: [
      { value: 0x0000000006b22c20, script: K.fromHex('76a9148280b37df378db99f66f85c95a783a76ac7a6d5988ac') },
      { value: 0x0000000d519390, script: K.fromHex('76a9143bde42dbee7e4dbe6a21b2d50ce2f0167faa815988ac') }] };
    const code = K.fromHex('76a9141d0f172a0ecb48aee1be1f2687d2963ae33f71a188ac');
    const h = K.sighash(tx, 1, code, 600000000, { version: 1, locktime: 0x11 });
    ok('BIP143 native P2WPKH sighash', K.toHex(h) === 'c37af31116d1b27caf68aae9e3ac82f1477929014d5b917657d0eb49478cb670', K.toHex(h));
    const priv = K.fromHex('619c335025c7f4012e556c2a58b2506e30b8511b53ade95ea316fd8c3286feb9');
    const pub = C.secp256k1.getPublicKey(priv, true);
    ok('and the matching public key', K.toHex(pub) === '025476c2e83188368da1ff3e292e7acafcdb3566bb0ad253f62fc70f07aeee6357');
    const compact = C.secp256k1.sign(h, priv, { lowS: true, prehash: false });
    ok('a signature over it verifies', C.secp256k1.verify(compact, h, pub, { prehash: false }) === true);
    ok('and matches the signature BIP143 publishes', K.toHex(K.derSig(compact)) ===
      '304402203609e17b84f6a7d30c80bfa610b5b4542f32a8a0d5447a12fb1366d7f01cc44a'
      + '0220573a954c4518331561406f90300e8f3358f51928d43c212a8caed02de67eebee');
    const der = K.derSig(compact);
    ok('DER starts 0x30 and is self-consistent', der[0] === 0x30 && der[1] === der.length - 2);
    const high = K.derSig(Uint8Array.from([...new Uint8Array(31), 0x80, ...new Uint8Array(31), 0x01]));
    ok('DER pads a high-bit value', high[4] === 0x00);
    const lead = K.derSig(Uint8Array.from([...new Uint8Array(31), 0x05, ...new Uint8Array(31), 0x07]));
    ok('DER strips surplus leading zeros', lead[3] === 1 && lead[4] === 0x05);
    ok('p2wpkh address from a pubkey', K.addressOf(K.fromHex('025476c2e83188368da1ff3e292e7acafcdb3566bb0ad253f62fc70f07aeee6357')).slice(0, 4) === 'pc1q');

    // The `ct` field, a wrong passphrase, and the legacy `ciphertext` name -- at
    // the cheap N vault-sweep's own selftest uses, then at the real one.
    for (const N of [1 << 14, 1 << 17]) {
      const secret = 'abandon abandon ability';
      const { blob } = encryptBlob(secret, 'correct horse', N);
      const got = await K.openBlob(JSON.stringify(blob), new TextEncoder().encode('correct horse'));
      ok(`openBlob reads the \`ct\` field the vault files use (N=2^${Math.log2(N)})`, new TextDecoder().decode(got) === secret);
      const e = await refusalOf(() => K.openBlob(JSON.stringify(blob), new TextEncoder().encode('wrong passphrase')));
      ok(`and a wrong passphrase is still refused (N=2^${Math.log2(N)})`, e && e.kind === 'refused' && /does not open/.test(e.message), e && e.message);
      if (N === 1 << 14) {
        const legacy = { ...blob, ciphertext: blob.ct }; delete legacy.ct;
        ok('a blob that calls it `ciphertext` still opens (vault-sweep: blob.ct ?? blob.ciphertext)',
          new TextDecoder().decode(await K.openBlob(JSON.stringify(legacy), new TextEncoder().encode('correct horse'))) === secret);
        const evm = { ...blob, chain: 'evm' };
        const ee = await refusalOf(() => K.openBlob(JSON.stringify(evm), new TextEncoder().encode('correct horse')));
        ok('an EVM seed blob is refused as not PCN', ee && /evm chain/.test(ee.message), ee && ee.message);
      }
    }
    for (const bad of ['bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'pc1zw508d6qejxtdg4y5r3zarvaryvg6kdaj', 'nonsense']) {
      const e = await refusalOf(() => K.decodeAddress(bad));
      ok(`refuses "${bad.slice(0, 22)}…"`, e && e.kind === 'refused', e && e.message);
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  section('3. derivation: the published PCoin vectors, and the bundle vs node_modules');
  {
    const BURN = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const acct = C.HDKey.fromMasterSeed(C.mnemonicToSeedSync(BURN)).derive(K.ACCOUNT_PATH);
    ok('published account xpub (PCOIN.md 6.4)', acct.publicExtendedKey ===
      'xpub6BzQhKPxtj3bu3nXmF8HinE9YpcjYqvaJxpRtMcXesrDtaXKnkmEqED19EcyDUGb3tuRih7NACR2HY1WrfkRP1dHpMZS2imgmrTrV8cVpE3');
    const R0 = ['pc1qj7lccmpqhdgg6enh503hqqyx244e49yespm8pf', 'pc1q0ncnjjyklxwts46h7e7jmls0l8d99lhv3wk0sm', 'pc1qzze3twr9c0cg0s3v2yh7797gae4ufk7zu4wux0'];
    const C0 = ['pc1qel0k9nyfvgqsgkc4fv9jp9ff37gw48gnsqt2rs', 'pc1qszm5tcmmewdgjny34klqv3dupm6jd5939k6e20', 'pc1qxyzkhz58fs86rxjmm96hz58zt3j0qnx8s76tyg'];
    const d = await K.deriveBranches(acct.publicExtendedKey, 3);
    ok('published receive addresses #0..2', JSON.stringify(d.receive) === JSON.stringify(R0), d.receive.join(' '));
    ok('published change addresses #0..2', JSON.stringify(d.change) === JSON.stringify(C0), d.change.join(' '));
    ok('address0() is receive #0', K.address0(acct.publicExtendedKey) === R0[0]);
    ok('ownChangeAddress() is change #0, where vault-sweep sends change', K.ownChangeAddress(acct.publicExtendedKey) === C0[0]);
    const wipe = [];
    const master = C.HDKey.fromMasterSeed(C.mnemonicToSeedSync(BURN));
    ok('deriveAccount() (step by step, to wipe each key) equals derive("m/84\'/9444\'/0\'")',
      K.deriveAccount(master, wipe).publicExtendedKey === acct.publicExtendedKey && wipe.length === 3);
    for (const k of wipe) k.wipePrivateData();
    ok('wipePrivateData() really clears the intermediate keys', wipe.every((k) => k.privateKey === null));

    const node = HDKey.fromExtendedKey(A.xpub);
    const mine = await K.deriveBranches(A.xpub, 300);
    let same = true;
    for (const b of [0, 1]) for (let i = 0; i < 300; i++) {
      if (p2wpkh(node.deriveChild(b).deriveChild(i).publicKey) !== (b ? mine.change : mine.receive)[i]) same = false;
    }
    ok('the bundle derives the same 600 addresses as node_modules\' own @scure/bip32', same);
    ok('parseXpub refuses an xprv without echoing it', (() => {
      try { K.parseXpub(A.acct.privateExtendedKey, 'x-xpub.txt'); return false; }
      catch (e) { return e.kind === 'refused' && !e.message.includes(A.acct.privateExtendedKey.slice(4, 30)); }
    })());
  }

  // ═════════════════════════════════════════════════════════════════════════
  section('4. equivalence: the page\'s transaction is vault-sweep\'s, byte for byte');
  // zzalpha: both branches, index 1999 on each, two outputs at one address, and
  // a TIE in value (receive #3 and change #2 both hold 1 PCN) so the order the
  // scan finds them in decides which is spent first -- the stable-sort trap.
  addUtxo(A.addr(0, 0), 5_00000000);
  addUtxo(A.addr(0, 3), 1_00000000);
  addUtxo(A.addr(0, 3), 50000000);
  addUtxo(A.addr(0, 1999), 25000000);
  addUtxo(A.addr(1, 2), 1_00000000);
  addUtxo(A.addr(1, 1999), 3_00000000);
  addUtxo(X.addr(0, 1000), 10_00000000);
  addUtxo(X.addr(1, 5), 2_00000000);
  addUtxo(R.addr(0, 0), 50000_50000000);                      // the main reserve: 50,000.5
  addUtxo(R.addr(0, 1), 10_00000000);                         // two deposit addresses the desk handed out
  addUtxo(R.addr(0, 2), 5_00000000);
  addUtxo(R.addr(1, 0), 1_00000000);                          // change branch: not counted by the proof page

  const CASES = [
    { title: 'zzalpha: 1 input, change to its own m/.../1/0', w: A, o: { to: EXT, amount: '2' }, ins: 1, change: true },
    { title: 'zzalpha: 4 inputs, including the tie', w: A, o: { to: EXT, amount: '9.5' }, ins: 4, change: true },
    { title: 'zzalpha: sweep everything, no change', w: A, o: { to: EXT, all: true }, ins: 6, change: false },
    { title: 'zzalpha: explicit change address (--change-to)', w: A, o: { to: EXT, amount: '2.5', changeTo: EXT2 }, ins: 1, change: true },
    { title: 'zzalpha: 500-sat change is fee, not an output', w: A, o: { to: EXT, amount: '4.99999218' }, ins: 1, change: false },
    { title: 'zzalpha: 5 sat/vB', w: A, o: { to: EXT, amount: '7.5', feeRate: 5 }, ins: 2, change: true },
    { title: 'exchange: part of it, change to an outside address', w: X, o: { to: EXT, amount: '3', changeTo: EXT2 }, ins: 1, change: true },
    { title: 'exchange: sweep everything', w: X, o: { to: EXT, all: true }, ins: 2, change: false },
    { title: 'wpcn-reserve: 12 PCN of surplus, change to the main address', w: R, o: { to: EXT, amount: '12', changeTo: R.addr(0, 0), consent: true }, ins: 1, change: true },
  ];
  const signedHexes = [];
  const VS = {};              // vault-sweep's results by case, for the browser run
  for (const c of CASES) {
    const args = ['--system', c.w.name, '--to', c.o.to];
    if (c.o.all) args.push('--all'); else args.push('--amount', c.o.amount);
    if (c.o.changeTo) args.push('--change-to', c.o.changeTo);
    if (c.o.consent) args.push('--i-know-the-reserve-backs-wpcn');
    const vs = await sweep(args, c.o.feeRate || 2);
    const pg = await page(c.w, c.o);
    const hex = vs.receipt && vs.receipt.raw_hex;
    VS[c.title] = vs;
    if (!hex) console.log('          vault-sweep said:\n' + (vs.out + vs.err).split('\n').map((l) => '          | ' + l).join('\n'));
    ok(c.title + ' -- raw transaction byte-identical', !!hex && pg.signed && pg.signed.hex === hex,
      pg.refusal ? 'page refused: ' + pg.refusal.message : `vault-sweep ${hex ? hex.slice(0, 40) : '(none)'}…\npage        ${pg.signed ? pg.signed.hex.slice(0, 40) : '(none)'}…`);
    ok('   and the txid', pg.signed && vs.txid === pg.signed.txid && vs.receipt.txid === pg.signed.txid, vs.txid + ' vs ' + (pg.signed && pg.signed.txid));
    if (pg.plan) {
      ok('   and the preview lines vault-sweep prints', JSON.stringify(previewLines(vs.out)) === JSON.stringify(previewLines(K.previewText(pg.plan))),
        previewLines(vs.out).join('\n') + '\n  vs\n' + previewLines(K.previewText(pg.plan)).join('\n'));
      ok(`   and it has ${c.ins} input(s) and ${c.change ? 'a' : 'no'} change output`, pg.plan.chosen.length === c.ins && Boolean(pg.plan.changeOut) === c.change,
        pg.plan.chosen.length + ' inputs, change ' + Boolean(pg.plan.changeOut));
    }
    if (pg.signed && vs.receipt) {
      const mine = K.receipt(pg.plan, pg.signed, pg.broadcast).body;
      const keys = (o) => Object.keys(o).sort().join(',');
      ok('   and the receipt: same fields, same values', keys(mine) === keys(vs.receipt)
        && ['system', 'to', 'sent_pcn', 'fee_pcn', 'change_pcn', 'inputs', 'txid', 'broadcast', 'raw_hex'].every((k) => mine[k] === vs.receipt[k]),
        JSON.stringify(mine).slice(0, 300) + '\n' + JSON.stringify(vs.receipt).slice(0, 300));
      ok('   and both tools POSTed exactly {hex} of that transaction to /api/tx',
        M.broadcasts.slice(-2).length === 2 && M.broadcasts.slice(-2).every((h) => h === pg.signed.hex));
      signedHexes.push(pg.signed.hex);
    }
    if (c.w === R && pg.reserve) {
      ok('   and the reserve stays whole, counted the proof page\'s way', pg.reserve.ok && pg.reserve.now === 50015_50000000
        && pg.reserve.addressesCounted === 3, JSON.stringify(pg.reserve));
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  section('5. the guards');
  {
    // xpub mismatch: zzmismatch carries A's xpub and B's seed. Both refuse.
    const vs = await sweep(['--system', 'zzmismatch', '--to', EXT, '--amount', '2']);
    ok('vault-sweep refuses a seed that does not derive the xpub', vs.code !== 0 && /does NOT derive the xpub/.test(vs.err) && !vs.receipt, vs.err.slice(0, 200));
    const net = pageNet();
    const r = await K.preparePlan(net, { system: 'zzmismatch', xpub: A.xpub, to: EXT, sendAll: false, amountSat: K.parseAmount('2'), amountText: '2', feeRate: 2 });
    let touchedTx = false;
    const watched = new Proxy(r.plan, { get(t, k) { if (k === 'tx') touchedTx = true; return t[k]; } });
    const e = await refusalOf(() => K.signPlan(watched, { xpubText: A.xpub, readSeedText: async () => readFileSync(MIS.seedFile, 'utf8'), passphrase: PASS }));
    ok('the page refuses it too, with vault-sweep\'s words', e && e.kind === 'refused' && /does NOT derive the xpub/.test(e.message), e && e.message);
    ok('...before it looked at the transaction to sign', !touchedTx);
    const wrong = await refusalOf(() => K.signPlan(r.plan, { xpubText: A.xpub, readSeedText: async () => readFileSync(A.seedFile, 'utf8'), passphrase: PASS + 'x' }));
    ok('a wrong passphrase is refused', wrong && /does not open this vault file/.test(wrong.message), wrong && wrong.message);
    const other = await refusalOf(() => K.signPlan(r.plan, { xpubText: B.xpub, readSeedText: async () => readFileSync(B.seedFile, 'utf8'), passphrase: PASS }));
    ok('a preview built from one xpub cannot be signed against another', other && /different xpub/.test(other.message), other && other.message);

    // wPCN reserve.
    const under = await page(R, { to: EXT, amount: '16', changeTo: R.addr(0, 0), consent: true });
    ok('wpcn-reserve: 16 PCN would leave 49,999.49999718 < 50,000 -- REFUSED', under.refusal && /below the 50000\.00000000 wPCN issued/.test(under.refusal.message)
      && under.reserve && !under.reserve.ok && under.reserve.after === 49999_49999718, under.refusal ? under.refusal.message : 'signed!');
    const vsUnder = await sweep(['--system', 'wpcn-reserve', '--to', EXT, '--amount', '16', '--change-to', R.addr(0, 0), '--i-know-the-reserve-backs-wpcn']);
    ok('   (vault-sweep itself would have signed that one -- the page is stricter)', !!(vsUnder.receipt && vsUnder.receipt.raw_hex));
    const noConsent = await refusalOf(() => page(R, { to: EXT, amount: '12', changeTo: R.addr(0, 0) }));
    const vsNoConsent = await sweep(['--system', 'wpcn-reserve', '--to', EXT, '--amount', '12', '--change-to', R.addr(0, 0)]);
    ok('wpcn-reserve without consent: the page refuses', noConsent && /backs every wPCN/.test(noConsent.message), noConsent && noConsent.message);
    ok('   and so does vault-sweep', vsNoConsent.code !== 0 && /backs every wPCN/.test(vsNoConsent.err) && !vsNoConsent.receipt);
    const noChangeTo = await refusalOf(() => page(R, { to: EXT, amount: '12', consent: true }));
    const vsNoChangeTo = await sweep(['--system', 'wpcn-reserve', '--to', EXT, '--amount', '12', '--i-know-the-reserve-backs-wpcn']);
    ok('wpcn-reserve change to a derived address: the page refuses', noChangeTo && /change at a derived address/.test(noChangeTo.message), noChangeTo && noChangeTo.message);
    ok('   and so does vault-sweep', vsNoChangeTo.code !== 0 && /change at a derived address/.test(vsNoChangeTo.err));
    const elsewhere = await page(R, { to: EXT, amount: '1', changeTo: EXT2, consent: true });
    ok('wpcn-reserve change anywhere but the MAIN address: REFUSED', elsewhere.refusal && /MAIN reserve address/.test(elsewhere.refusal.message), elsewhere.refusal && elsewhere.refusal.message);

    // The reserve arithmetic on its own: repeats in the list, and a pending spend.
    const plan0 = { chosen: [{ address: 'pcA', value: 100 }], outs: [{ address: 'pcA', value: 60 }, { address: 'pcX', value: 30 }] };
    const rows = new Map([['pcA', { onchain_unspent_sat: 1000, pending_spend_sat: 0 }], ['pcB', { onchain_unspent_sat: 50, pending_spend_sat: 20 }]]);
    const ra = K.reserveAfter(plan0, 'pcA', ['pcB', 'pcB', 'pcA'], rows);
    ok('the proof page\'s arithmetic: a repeated deposit address counts twice, as it does there', ra.now === 1100 && ra.after === 1060 && ra.addressesCounted === 3 && ra.addressesUnique === 2, JSON.stringify(ra));
    ok('...and the refusal uses the lower figure: each address once, minus what the mempool is already spending', ra.safeAfter === 990 && ra.floor === 990, JSON.stringify(ra));
    const raUnknown = await refusalOf(() => K.reserveAfter(plan0, 'pcA', ['pcB'], new Map([['pcA', { onchain_unspent_sat: 1, pending_spend_sat: null }], ['pcB', { onchain_unspent_sat: 1, pending_spend_sat: 0 }]])));
    ok('an unreadable reserve balance is UNKNOWN, never zero', raUnknown && raUnknown.kind === 'unknown', raUnknown && raUnknown.message);

    // exchange.
    const xNoChange = await refusalOf(() => page(X, { to: EXT, amount: '3' }));
    const vsXNoChange = await sweep(['--system', 'exchange', '--to', EXT, '--amount', '3']);
    ok('exchange without a change address: the page refuses', xNoChange && /needs a change address/.test(xNoChange.message), xNoChange && xNoChange.message);
    ok('   and so does vault-sweep', vsXNoChange.code !== 0 && /needs --change-to/.test(vsXNoChange.err) && !vsXNoChange.receipt);
    const xOwn = await page(X, { to: EXT, amount: '3', changeTo: X.addr(0, 7) });
    ok('exchange change to one of its OWN addresses: REFUSED (a customer would be credited)', xOwn.refusal && /address of the exchange wallet/.test(xOwn.refusal.message), xOwn.refusal && xOwn.refusal.message);

    // Destinations that are not pc1q v0 / 20 bytes.
    const BAD = {
      'a Bitcoin address': 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
      'a testnet address': 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
      'pc1p (taproot, version 1)': bech32m.encode('pc', [1, ...bech32m.toWords(randomBytes(32))]),
      'pc1q with a 32-byte program (P2WSH)': bech32.encode('pc', [0, ...bech32.toWords(randomBytes(32))]),
      'a pc1q with one character changed': EXT.slice(0, 20) + (EXT[20] === 'q' ? 'p' : 'q') + EXT.slice(21),
      'a legacy base58 address': 'PGr8mxCEo8N5QFNmmT8AAAx4X3QyuA4r7k',
      'an empty string': '',
      'twelve words': 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    };
    for (const [what, addr] of Object.entries(BAD)) {
      const e2 = await refusalOf(() => K.planTransaction({ system: 'zzalpha', xpub: A.xpub, to: addr, amountSat: 1e8, amountText: '1', used: [{}], utxos: [] }));
      ok(`refuses ${what} as a destination`, e2 && e2.kind === 'refused', e2 ? e2.message : 'accepted');
    }
    for (const what of ['pc1p (taproot, version 1)', 'pc1q with a 32-byte program (P2WSH)']) {
      const v = await sweep(['--system', 'zzalpha', '--to', BAD[what], '--all']);
      ok(`   vault-sweep refuses ${what} too`, v.code !== 0 && /REFUSED/.test(v.err) && !v.receipt);
    }
    const pasted = await refusalOf(() => K.canonicalAddress(A.mnemonic));
    const pastedAmt = await refusalOf(() => K.parseAmount(PASS));
    ok('a phrase or passphrase pasted into the wrong box is refused WITHOUT being shown back',
      pasted && !pasted.message.includes(A.mnemonic.split(' ')[0] + ' ' + A.mnemonic.split(' ')[1]) && pastedAmt && !pastedAmt.message.includes(PASS),
      (pasted && pasted.message) + ' / ' + (pastedAmt && pastedAmt.message));
    const eChange = await refusalOf(() => K.planTransaction({ system: 'zzalpha', xpub: A.xpub, to: EXT, changeTo: BAD['pc1p (taproot, version 1)'], amountSat: 1e8, amountText: '1', used: [{}], utxos: [] }));
    ok('refuses a non-pc1q change address the same way', eChange && eChange.kind === 'refused');
    ok('an UPPERCASE pc1q address is accepted and written in its canonical lowercase', K.canonicalAddress(EXT.toUpperCase()) === EXT);

    // Dust: vault-sweep would sign an output no node relays.
    const dustPlan = K.planTransaction({ system: 'zzalpha', xpub: A.xpub, to: EXT, sendAll: true, feeRate: 2,
      used: [{}], utxos: [{ txid: 'aa'.repeat(32), vout: 0, value: 500, branch: 0, index: 0, address: A.addr(0, 0) }] });
    const eDust = await refusalOf(() => K.pageGuards(dustPlan, {}));
    ok('a 280-sat output is refused as dust', eDust && /dust/.test(eDust.message), eDust && eDust.message);

    // Rails: paying a service's deposit address needs an explicit tick.
    const rail = K.makeRailOf([{ name: 'checker', addr0: EXT, rail: null }, { name: 'wpcn-reserve', addr0: R.addr(0, 0), rail: null }]);
    const railPlan = K.planTransaction({ system: 'zzalpha', xpub: A.xpub, to: EXT, sendAll: true, feeRate: 2,
      used: [{}], utxos: [{ txid: 'bb'.repeat(32), vout: 0, value: 1e8, branch: 0, index: 0, address: A.addr(0, 0) }] });
    const eRail = await refusalOf(() => K.pageGuards(railPlan, { railOf: rail }));
    ok('paying a rail\'s address #0 without the tick is refused', eRail && /checker/.test(eRail.message), eRail && eRail.message);
    ok('...and allowed with it', K.pageGuards(railPlan, { railOf: rail, railAck: true }) === true);
    ok('wpcn-reserve #0 (the main reserve) is not a rail', rail(R.addr(0, 0)) === null);

    // Amounts: vault-sweep's Math.round(Number(x) * 1e8), but only for plain decimals.
    ok('amounts: "12.5" is 1250000000 sat and "0.00000001" is 1', K.parseAmount('12.5') === 1250000000 && K.parseAmount('0.00000001') === 1 && K.parseAmount(' 7 ') === 700000000);
    for (const bad of ['1e3', '-1', '1.123456789', '0', '0.00000000', '21000000.00000001', '1,5', 'Infinity', '']) {
      const e3 = await refusalOf(() => K.parseAmount(bad));
      ok(`amounts: "${bad}" is refused`, e3 && e3.kind === 'refused');
    }

    // Reads that fail resolve nothing.
    M.unknownMempool = true;
    const eMem = await refusalOf(() => K.findUsed(pageNet(), B.xpub, { scanTo: 5 }));
    M.unknownMempool = false;
    ok('an explorer that cannot see the mempool makes the balance UNKNOWN, not zero', eMem && eMem.kind === 'unknown', eMem && eMem.message);
    M.stale = true;
    const eStale1 = await refusalOf(() => K.findUsed(pageNet(), B.xpub, { scanTo: 5 }));
    const eStale2 = await refusalOf(() => K.collectUtxos(pageNet(), [{ branch: 0, index: 0, address: A.addr(0, 0) }]));
    const eStale3 = await refusalOf(() => page(R, { to: EXT, amount: '12', changeTo: R.addr(0, 0), consent: true }));
    M.stale = false;
    ok('an explorer whose index is not current is not believed: balances, outputs and the reserve all UNKNOWN',
      [eStale1, eStale2, eStale3].every((e) => e && e.kind === 'unknown' && /index is not current/.test(e.message)),
      [eStale1, eStale2, eStale3].map((e) => e && e.message).join(' | '));
    M.hasMore = true;
    const eMore = await refusalOf(() => K.collectUtxos(pageNet(), [{ branch: 0, index: 0, address: A.addr(0, 0) }]));
    M.hasMore = false;
    ok('a paged UTXO list is refused rather than half-spent', eMore && /more unspent outputs/.test(eMore.message), eMore && eMore.message);
    M.badScript = '0014' + '00'.repeat(20);
    const eScript = await refusalOf(() => K.collectUtxos(pageNet(), [{ branch: 0, index: 0, address: A.addr(0, 0) }]));
    M.badScript = null;
    ok('an output whose script is not the address it was listed under is refused', eScript && /pays script/.test(eScript.message), eScript && eScript.message);

    // What a broadcast answer means.
    const sig = signedHexes[0];
    const ib = (status, body) => K.interpretBroadcast({ status, ok: status >= 200 && status < 300, json: body, text: JSON.stringify(body) }, 'ab'.repeat(32));
    ok('broadcast 200: the network has it', ib(200, { txid: 'ab'.repeat(32) }).state === 'accepted');
    ok('broadcast 202: accepted, propagation not yet seen', ib(202, { txid: 'ab'.repeat(32) }).state === 'propagating');
    ok('broadcast 400: rejected', ib(400, { error: { code: 'rejected', message: 'bad-txns-inputs-missingorspent' } }).state === 'rejected');
    ok('broadcast 502 outcome-unknown: UNKNOWN, not failed', ib(502, { error: { code: 'broadcast_outcome_unknown', message: 'x' } }).state === 'unknown');
    ok('broadcast with no answer at all: UNKNOWN, not failed', K.interpretBroadcast({ ok: false, status: 0, json: null, text: 'socket hang up' }, 'ab'.repeat(32)).state === 'unknown');
    ok('a 200 whose txid is not ours is flagged', ib(200, { txid: 'cd'.repeat(32) }).mismatch === true);
    M.tx = { status: 200, body: { txid: 'placeholder' } };
    const n1 = pageNet();
    const got = await n1.broadcast(sig);
    M.tx = { status: 503, body: { error: { code: 'test_mock', message: 'test mock: nothing is broadcast' } } };
    ok('the page\'s broadcast sends exactly {hex} and reads the answer', got.ok && M.broadcasts[M.broadcasts.length - 1] === sig);
  }

  // ═════════════════════════════════════════════════════════════════════════
  section('6. the server: what it serves, and that it takes nothing');
  {
    const rl = T.readReserveList();
    ok('reserve.json lists the deposit addresses, without the main one', rl.ok && JSON.stringify(rl.deposits) === JSON.stringify([R.addr(0, 1), R.addr(0, 2)]) && rl.main === R.addr(0, 0), JSON.stringify(rl));
    const served = await (await fetch(MOCK + '/tp/transfer/reserve.json')).text();
    ok('...and ONLY addresses: no BSC address, account or IP leaves the server', PRIVATE_ROW_VALUES.every((v) => !served.includes(v)), served);
    writeFileSync(REQUESTS + '.bad', '{ not json');
    ok('an unreadable wrap desk file is an error, not an empty list', T.readReserveList(REQUESTS + '.bad').ok === false && T.readReserveList(join(TMP, 'absent.json')).ok === false);

    ok('no destinations file: nothing configured, and it says so', (() => { const d = T.readDestinations(); return d.ok && d.configured === false && d.destinations.length === 0; })());
    copyFileSync(join(HERE, 'transfer-destinations.example.json'), DESTS);
    const ex = T.readDestinations();
    ok('the example\'s placeholders are all refused, so none can be chosen', ex.ok && ex.destinations.length === 0 && ex.invalid.length === 3, JSON.stringify(ex));
    // The server checks SHAPE only (it carries no bech32 code); the page checks
    // the checksum before it offers anything. Both halves are tested.
    const typo = EXT.slice(0, -1) + (EXT.endsWith('q') ? 'p' : 'q');
    writeFileSync(DESTS, JSON.stringify({ _comment: 'x', treasury: EXT.toUpperCase(), typo, number: 7, words: 'twelve words here' }));
    const dd = T.readDestinations();
    ok('the server offers well-shaped entries in lowercase, and names malformed ones without echoing their values',
      dd.ok && dd.destinations.length === 2 && dd.destinations[0].address === EXT && dd.destinations[1].address === typo
      && dd.invalid.length === 2 && !JSON.stringify(dd).includes('twelve words'), JSON.stringify(dd));
    ok('...and the page\'s checksum refuses the one-character typo the shape check let through',
      K.isAddress(dd.destinations[0].address) && !K.isAddress(dd.destinations[1].address));
    writeFileSync(DESTS, '[1,2]');
    ok('a destinations file that is not an object is an error', T.readDestinations().ok === false);

    // A POST to any route is refused WITHOUT READING THE BODY.
    const tripwire = () => { throw new Error('the request body was read'); };
    for (const sub of ['/transfer', '/transfer/core.js', '/transfer/reserve.json', '/transfer/anything']) {
      const req = { method: 'POST', on: tripwire, once: tripwire, read: tripwire, pipe: tripwire, resume: tripwire, [Symbol.asyncIterator]: tripwire };
      let code = 0, headers = {};
      const res = { writeHead: (c, h) => { code = c; headers = h; }, end: () => {} };
      let threw = null;
      try { T.transferRoute(sub, req, res, { base: '/tp', shell: SHELL }); } catch (e) { threw = e; }
      ok(`POST ${sub}: 405, and the body is never read`, !threw && code === 405 && headers.allow === 'GET, HEAD', threw ? threw.message : code);
    }
    const src = readFileSync(join(HERE, 'transfer.mjs'), 'utf8');
    ok('transfer.mjs has no way to read a request body (no readBody, readJson, req.on, pipe)',
      !/readBody|readJson|req\.on\(|\.pipe\(|for await \(.* of req/.test(code(src)));

    // The page's HTML and its Content-Security-Policy.
    const html = SHELL('transfer', 'Move PCN', T.transferPage('/tp'));
    const csp = T.cspFor(html);
    const inline = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
    ok('the CSP allows the shell\'s inline script by its hash, and nothing inline besides',
      csp.includes(`'sha256-${sha256(Buffer.from(inline)).toString('base64')}'`) && !/script-src[^;]*unsafe-inline/.test(csp));
    ok('the CSP confines requests to this origin and forbids forms', /connect-src 'self'/.test(csp) && /form-action 'none'/.test(csp) && /default-src 'none'/.test(csp));
    const served2 = await fetch(MOCK + '/tp/transfer');
    ok('GET /transfer sends that CSP with the page', (served2.headers.get('content-security-policy') || '').includes("connect-src 'self'"));
    const pass = /<input[^>]*type="password"[^>]*>/.exec(pageHtml);
    ok('the passphrase box is type=password, autocomplete=off, with no name to submit under',
      !!pass && /autocomplete="off"/.test(pass[0]) && !/\bname=/.test(pass[0]));
    ok('the page has no <form> anywhere', !/<form\b/i.test(pageHtml));
  }

  // ═════════════════════════════════════════════════════════════════════════
  section('7. nothing the page sent contains a secret');
  {
    const bodies = SENT.map((s) => s.method + ' ' + s.url + '\n' + s.headers + '\n' + s.body);
    const hay = bodies.join('\n\n');
    ok(`the page made ${SENT.length} requests during these tests (scans, reserve reads, broadcasts)`, SENT.length > 100
      && SENT.some((s) => s.url.endsWith('/api/tx')) && SENT.some((s) => s.url.endsWith('/transfer/reserve.json')));
    // Every private key that signed anything above, in hex.
    const signingKeys = [];
    for (const [w, spots] of [[A, [[0, 0], [0, 3], [0, 1999], [1, 2], [1, 1999]]], [X, [[0, 1000], [1, 5]]], [R, [[0, 0], [0, 1], [0, 2], [1, 0]]]]) {
      for (const [b, i] of spots) signingKeys.push([w.name + ' private key ' + b + '/' + i, w.privAt(b, i)]);
    }
    let leaks = [];
    for (const [label, s] of SECRETS.concat(signingKeys)) {
      if (!s || s.length < 8) continue;
      // Hex is case-free, so hex secrets are matched case-free. Anything else is
      // matched exactly: a lowercased base64 IV could match bech32 text by chance.
      const hex = /^[0-9a-f]+$/i.test(s);
      if (hex ? hay.toLowerCase().includes(s.toLowerCase()) : hay.includes(s)) leaks.push(label);
    }
    ok(`none of ${SECRETS.length + signingKeys.length} secrets (passphrase, phrases, seeds, xprvs, signing keys, AES keys, seed files) appears in any of them`,
      leaks.length === 0, leaks.join(', '));
    ok('every request went to this origin: the mock explorer or the panel', SENT.every((s) => s.url.startsWith(MOCK + '/api/') || s.url.startsWith(MOCK + '/tp/transfer/')));
    ok('every request body is {addresses:[pc1…]} or {hex} and nothing else', SENT.every((s) => {
      if (!s.body) return s.method === 'GET';
      const j = JSON.parse(s.body);
      const k = Object.keys(j).join(',');
      return (k === 'addresses' && j.addresses.every((a) => /^pc1[02-9ac-hj-np-z]+$/.test(a))) || (k === 'hex' && /^[0-9a-f]+$/.test(j.hex));
    }));

    // The network layer refuses anything that is not public BEFORE it sends.
    const before = SENT.length;
    const n = pageNet();
    const refusals = await Promise.all([
      refusalOf(() => n.broadcast(A.privAt(0, 0))),
      refusalOf(() => n.broadcast(Buffer.from(A.mnemonic).toString('hex'))),
      refusalOf(() => n.broadcast('02000000000100')),
      refusalOf(() => n.addresses([A.mnemonic])),
      refusalOf(() => n.addresses([PASS])),
      refusalOf(() => n.utxos(A.acct.privateExtendedKey)),
      refusalOf(() => n.utxos('pc1q' + A.privAt(0, 0))),
    ]);
    ok('a private key, a phrase or a passphrase handed to the network layer is refused, and nothing is sent',
      refusals.every(Boolean) && SENT.length === before, refusals.map((e) => (e ? 'refused' : 'SENT')).join(' '));

    // Static: the two client files, read as text.
    const core = readFileSync(join(HERE, 'transfer-core.js'), 'utf8');
    const ui = readFileSync(join(HERE, 'transfer-ui.js'), 'utf8');
    const FORBIDDEN = ['XMLHttpRequest', 'sendBeacon', 'WebSocket', 'EventSource', 'importScripts', 'Worker(', 'window.open',
      'location.href', 'location.assign', 'location.replace', 'document.cookie', 'localStorage', 'sessionStorage',
      'innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'postMessage',
      'srcdoc', '.submit(', '<form', 'navigator.credentials'];
    for (const [file, text] of [['transfer-core.js', code(core)], ['transfer-ui.js', code(ui)]]) {
      const hits = FORBIDDEN.filter((f) => text.includes(f));
      ok(`${file} uses none of ${FORBIDDEN.length} other ways to send, store or inject anything`, hits.length === 0, hits.join(', '));
    }
    ok('transfer-ui.js never calls fetch: every request goes through the core', !/\bfetch\s*\(/.test(code(ui)) && !/\.fetch\b/.test(code(ui)));
    ok('transfer-core.js calls fetch at exactly one place, inside makeNet', (code(core).match(/doFetch\(/g) || []).length === 1
      && (code(core).match(/\bfetch\b/g) || []).length === 2 && /const doFetch = o\.fetch \|\| root\.fetch\.bind\(root\)/.test(core));
    ok('the page builds its network layer once, for this origin only', /K\.makeNet\(\{ origin: '', panelBase: BASE \}\)/.test(ui) && (code(ui).match(/makeNet\(/g) || []).length === 1);
    ok('the passphrase box is read once and emptied on the very next statement',
      (code(ui).match(/\bfield\.value\b(?!\s*=)/g) || []).length === 1 && /let passphrase = field\.value;[^\n]*\n\s*field\.value = '';/.test(ui)
      && (code(ui).match(/\$\('mv-pass'\)\.value(?! = '')/g) || []).length === 0);
    ok('the only things the page stores in the browser are the folder handle and the folder\'s name',
      (code(ui).match(/\.put\(/g) || []).length === 2 && /objectStore\(HANDLES\)\.put\(handle, FOLDER_KEY\)/.test(ui)
      && /objectStore\(NAMES\)\.put\(String\(handle\.name\), FOLDER_KEY\)/.test(ui));
    ok('opening the page reads only the folder\'s NAME; the stored handle is read only by Reconnect',
      (code(ui).match(/recallFolderHandle\(\)/g) || []).length === 1 && /async function reconnect\(\) \{\s*let h = null;\s*try \{ h = await recallFolderHandle\(\);/.test(ui)
      && /recallFolderName\(\)\.then/.test(ui));
  }

  // ═════════════════════════════════════════════════════════════════════════
  section('8. vault.mjs is unchanged in spirit: no input element, no machine name');
  {
    const { vaultPage } = await import('./vault.mjs');
    const v = vaultPage();
    ok('the Vault commands page renders no <input>, <textarea>, <select> or contenteditable',
      !/<input\b|<textarea\b|<select\b|contenteditable/i.test(v));
    ok('...and no machine name', !v.toLowerCase().includes(hostname().toLowerCase()));
    ok('vault.mjs does not load the Move PCN page or its scripts', !/import[^;]*transfer|transfer[-.](core|ui|crypto)/.test(readFileSync(join(HERE, 'vault.mjs'), 'utf8')));
    ok('the passphrase box lives only on the separate Move PCN page', /type="password"/.test(T.transferPage('/tp')));
  }

  // ═════════════════════════════════════════════════════════════════════════
  if (BROWSER) {
    section('9. the real page, in a real browser (a headless Edge of its own, throwaway profile)');
    await browserSuite(VS);
  } else {
    console.log('\n  (section 9, the real-browser run, is skipped; add --browser to drive the page in a headless browser of its own)');
  }
} catch (e) {
  failed++;
  console.log('\n  FAIL  the test run itself threw: ' + ((e && e.stack) || e));
} finally {
  server.close();
  // Retries: on Windows a just-closed browser can hold its profile for a moment.
  rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

console.log(failed ? `\n  ${failed} FAILED, ${passed} passed\n` : `\n  ALL ${passed} CHECKS PASSED\n`);
process.exit(failed ? 1 : 0);

// ═════════════════════════════════════════════════════════════════════════════
// Section 9: the page itself -- server.mjs, the HTML, the three scripts and the
// UI -- driven through the Chrome DevTools Protocol, compared with vault-sweep.
// ═════════════════════════════════════════════════════════════════════════════
async function browserSuite(VS) {
  // OUR OWN BROWSER. Headless, a profile that exists only for this run, a
  // debugging port the OS picks, and read back from the profile's own
  // DevToolsActivePort file -- so there is no port to confuse with anyone
  // else's instance, and nothing to attach to except what was launched here.
  if (!existsSync(BROWSER_EXE)) { ok('a browser to launch headless (set TRANSFER_TEST_BROWSER)', false, BROWSER_EXE + ' not found'); return; }
  const PROFILE = join(TMP, 'browser-profile');
  mkdirSync(PROFILE);
  const browser = spawn(BROWSER_EXE, ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + PROFILE,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync',
    '--disable-background-networking', '--disable-component-update', 'about:blank'], { stdio: 'ignore' });
  let wsUrl = null;
  for (let i = 0; i < 80 && !wsUrl; i++) {
    await sleep(250);
    try {
      const [p, path] = readFileSync(join(PROFILE, 'DevToolsActivePort'), 'utf8').split(/\r?\n/);
      if (/^\d+$/.test(p) && path) wsUrl = 'ws://127.0.0.1:' + p + path;
    } catch { /* not written yet */ }
  }
  if (!wsUrl) { browser.kill(); ok('the headless browser started and opened its debugging port', false); return; }
  ok('a headless browser of its own started, with a throwaway profile', true);
  const ver = { webSocketDebuggerUrl: wsUrl };

  // The real server.mjs, on a free port, with a session written here so no
  // login is needed, and the same test files transfer.mjs reads above.
  const sid = randomBytes(32).toString('base64url');
  const PANEL_DIR = join(TMP, 'panel');
  mkdirSync(join(PANEL_DIR, 'data'), { recursive: true });
  writeFileSync(join(PANEL_DIR, 'sessions.json'), JSON.stringify({ [sid]: { at: Date.now(), ip: '127.0.0.1' } }));
  writeFileSync(DESTS, JSON.stringify({ _comment: 'test', 'a named destination': EXT2, 'a placeholder': 'pc1q-REPLACE-ME' }));
  const port = await new Promise((r) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const panel = spawn(process.execPath, [join(HERE, 'server.mjs')], { cwd: HERE, stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, ADMIN_PREFIX: 'tp', ADMIN_PORT: String(port), ADMIN_DATA: join(PANEL_DIR, 'data'),
    ADMIN_CRED: join(PANEL_DIR, 'credential.json'), ADMIN_SESSION_FILE: join(PANEL_DIR, 'sessions.json'),
    ADMIN_TRANSFER_DESTINATIONS: DESTS, WRAPDESK_STATE: REQUESTS, WRAP_RESERVE: R.addr(0, 0) } });
  let panelLog = '';
  panel.stdout.on('data', (d) => { panelLog += d; });
  panel.stderr.on('data', (d) => { panelLog += d; });
  for (let i = 0; i < 60 && !panelLog.includes('pcoin-admin on'); i++) await sleep(250);
  ok('server.mjs starts with the Move PCN route in it', panelLog.includes('pcoin-admin on'), panelLog.slice(0, 300));
  PANEL_PORT = port;

  // A minimal CDP client over Node's own WebSocket.
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let seq = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      if (msg.error) p.j(new Error(msg.error.message)); else p.r(msg.result);
    } else if (msg.method) for (const l of listeners) l(msg);
  };
  const send = (method, params = {}, sessionId) => new Promise((r, j) => {
    const id = ++seq;
    pending.set(id, { r, j });
    ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); j(new Error('CDP timeout: ' + method)); } }, 90000);
  });

  // The browser's DEFAULT context. The whole browser is a throwaway with its own
  // temporary profile, so an off-the-record context would add no isolation --
  // and in one (below) Edge freezes reading a stored folder handle back.
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: S } = await send('Target.attachToTarget', { targetId, flatten: true });
  const DL = join(TMP, 'downloads');
  mkdirSync(DL);
  await send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: DL, eventsEnabled: true });

  const reqs = [];
  const problems = [];
  const downloads = new Map();
  listeners.push((m) => {
    if (m.method === 'Browser.downloadProgress') downloads.set(m.params.guid, m.params.state);
    if (m.sessionId !== S) return;
    if (m.method === 'Network.requestWillBeSent') {
      const q = m.params.request;
      reqs.push({ id: m.params.requestId, url: q.url, method: q.method, headers: JSON.stringify(q.headers || {}),
        body: q.postData || '', hasPostData: Boolean(q.hasPostData), type: m.params.type });
    }
    if (m.method === 'Runtime.exceptionThrown') problems.push('exception: ' + JSON.stringify(m.params.exceptionDetails).slice(0, 400));
    if (m.method === 'Log.entryAdded' && (m.params.entry.source === 'security' || m.params.entry.level === 'error')) {
      problems.push(m.params.entry.source + ': ' + m.params.entry.text + ' ' + (m.params.entry.url || ''));
    }
  });
  for (const d of ['Network.enable', 'Runtime.enable', 'Log.enable', 'Page.enable', 'DOM.enable']) await send(d, {}, S);
  await send('Network.setCookie', { name: 'pcadm', value: sid, url: MOCK + '/tp/transfer', path: '/tp', httpOnly: true }, S);

  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, S);
    if (r.exceptionDetails) throw new Error('in the page: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
    return r.result.value;
  };
  const waitFor = async (expression, ms = 180000) => {
    const t0 = Date.now();
    for (;;) {
      const v = await ev(expression);
      if (v) return v;
      if (Date.now() - t0 > ms) throw new Error('timed out waiting for: ' + expression.slice(0, 120));
      await sleep(250);
    }
  };

  try {
    await send('Page.navigate', { url: MOCK + '/tp/transfer' }, S);
    await waitFor(`document.readyState === 'complete'`, 30000);
    const loaded = await ev(`({ core: !!window.PCoinTransferCore, crypto: !!window.PCoinCrypto, nav: !!document.querySelector('a.active[href$="/transfer"]'), title: document.title })`);
    ok('the page loads through server.mjs, with all three scripts past their integrity check', loaded.core && loaded.crypto, JSON.stringify(loaded));
    ok('...and "Move PCN" is in the navigation, marked as the current page', loaded.nav && /Move PCN/.test(loaded.title), JSON.stringify(loaded));

    // Step 1: the fallback file picker, fed the test wallets' files.
    const doc = await send('DOM.getDocument', { depth: 1 }, S);
    const { nodeId } = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#mv-files' }, S);
    const files = ['zzalpha', 'exchange', 'wpcn-reserve', 'zzbravo', 'zzmismatch']
      .flatMap((n) => [join(SWEEP_DIR, n + '-xpub.txt'), join(SWEEP_DIR, n + '-seed.enc.json')]);
    await send('DOM.setFileInputFiles', { files, nodeId }, S);
    await waitFor(`/Every balance has been read/.test(document.getElementById('mv-folder-status').textContent)`, 300000);
    const listed = await ev(`Array.from(document.querySelectorAll('#mv-from option')).map((o) => o.textContent)`);
    const alphaRow = listed.find((t) => t.startsWith('zzalpha'));
    ok('every wallet is listed with its balance and the last 4 of its address #0', listed.length === 6
      && alphaRow === 'zzalpha — 10.75000000 PCN — …' + A.addr(0, 0).slice(-4), JSON.stringify(listed));
    const toOpts = await ev(`Array.from(document.querySelectorAll('#mv-to option')).map((o) => [o.value, o.textContent, o.disabled])`);
    ok('To offers each vault #0 as "name …abcd", the named destination, and a custom address',
      toOpts.some(([v, t]) => v === 'vault:wpcn-reserve' && t === 'wpcn-reserve …' + R.addr(0, 0).slice(-4))
      && toOpts.some(([v, t, d]) => v === 'named:0' && !d && t === 'a named destination …' + EXT2.slice(-4))
      && toOpts.some(([v, , d]) => v === 'bad' && d) && toOpts.some(([v]) => v === 'custom'), JSON.stringify(toOpts));

    const setForm = (f) => ev(`(() => {
      const set = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); };
      const chk = (id, on) => { const e = document.getElementById(id); if (e.checked !== on) { e.checked = on; e.dispatchEvent(new Event('change', { bubbles: true })); } };
      set('mv-from', ${JSON.stringify(f.from)});
      set('mv-to', 'custom'); set('mv-custom', ${JSON.stringify(f.to)});
      chk('mv-all', ${Boolean(f.all)});
      set('mv-amount', ${JSON.stringify(f.amount || '')});
      ${f.change ? `set('mv-change', ${JSON.stringify(f.change)});` : ''}
      ${f.changeCustom ? `set('mv-change-custom', ${JSON.stringify(f.changeCustom)});` : ''}
      chk('mv-consent', ${Boolean(f.consent)});
      document.getElementById('mv-preview').click();
      return true; })()`);
    const previewDone = () => waitFor(`(() => {
      if (document.getElementById('mv-preview').disabled) return null;
      const r = document.getElementById('mv-refusal'), s3 = document.getElementById('mv-s3');
      return { ready: !document.getElementById('mv-s4').hidden, refusal: r.hidden ? null : r.textContent,
               preview: s3.hidden ? null : document.getElementById('mv-preview-text').textContent,
               reserve: document.getElementById('mv-reserve').textContent,
               change: document.getElementById('mv-change').value }; })()`);
    const signNow = async (pass) => {
      await ev(`document.getElementById('mv-pass').focus(); true`);
      await send('Input.insertText', { text: pass }, S);
      const typed = await ev(`document.getElementById('mv-pass').value.length`);
      const leftInBox = await ev(`(() => { const f = document.getElementById('mv-pass'); document.getElementById('mv-sign').click(); return f.value; })()`);
      const st = await waitFor(`(() => {
        if (document.getElementById('mv-sign').disabled) return null;
        const r = document.getElementById('mv-sign-refusal'), s = document.getElementById('mv-signed');
        if (!r.hidden) return { refusal: r.textContent };
        if (!s.hidden) return { hex: document.getElementById('mv-hex').textContent, text: s.textContent };
        return null; })()`, 60000);
      return Object.assign({ typed, leftInBox }, st);
    };

    const UI_CASES = [
      { title: 'zzalpha: 1 input, change to its own m/.../1/0', f: { from: 'zzalpha', to: EXT, amount: '2' } },
      { title: 'zzalpha: sweep everything, no change', f: { from: 'zzalpha', to: EXT, all: true } },
      { title: 'exchange: part of it, change to an outside address', f: { from: 'exchange', to: EXT, amount: '3', change: 'custom', changeCustom: EXT2 } },
      { title: 'wpcn-reserve: 12 PCN of surplus, change to the main address', f: { from: 'wpcn-reserve', to: EXT, amount: '12', consent: true } },
    ];
    let first = null;
    for (const c of UI_CASES) {
      await setForm(c.f);
      const p = await previewDone();
      ok('browser, ' + c.title + ': the preview matches vault-sweep\'s lines', p.ready
        && JSON.stringify(previewLines(p.preview || '')) === JSON.stringify(previewLines(VS[c.title].out)),
        (p.refusal || '') + '\n' + (p.preview || ''));
      if (c.f.from === 'wpcn-reserve') {
        ok('   change defaulted to the MAIN reserve address, and the reserve block says it stays whole',
          p.change === 'vault:wpcn-reserve' && /STAYS FULLY BACKED/.test(p.reserve), p.change + ' / ' + p.reserve);
      }
      const s = await signNow(PASS);
      ok('   the passphrase box was emptied the moment Sign was pressed', s.typed === PASS.length && s.leftInBox === '', JSON.stringify({ typed: s.typed, left: s.leftInBox.length }));
      ok('   signed in the browser: BYTE-IDENTICAL to vault-sweep\'s raw transaction', s.hex === VS[c.title].receipt.raw_hex,
        (s.refusal || '') + '\n' + String(s.hex).slice(0, 60));
      if (!first) first = { c, s };
    }

    // Undo must not bring the passphrase back into the emptied box.
    await ev(`document.getElementById('mv-pass').focus(); true`);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, commands: ['undo'] }, S);
    await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90 }, S);
    ok('Ctrl+Z in the emptied box does not bring the passphrase back', (await ev(`document.getElementById('mv-pass').value`)) === '');

    // Broadcast (the mock says the network has it), then the receipt.
    await setForm(UI_CASES[0].f);
    await previewDone();
    const s1 = await signNow(PASS);
    const txid = VS[UI_CASES[0].title].receipt.txid;
    M.tx = { status: 200, body: { txid, accepted_by_node: true, network: { has_it: true } } };
    const before = M.broadcasts.length;
    await ev(`window.confirm = () => true; document.getElementById('mv-broadcast').click(); true`);
    const out = await waitFor(`(() => { const r = document.getElementById('mv-result'); if (!r.textContent) return null;
      const a = r.querySelector('a'); return { text: r.textContent, href: a ? a.getAttribute('href') : null, again: !document.getElementById('mv-broadcast').disabled }; })()`, 30000);
    M.tx = { status: 503, body: { error: { code: 'test_mock', message: 'test mock: nothing is broadcast' } } };
    ok('Broadcast sends that exact transaction, once, and shows the txid with an explorer link',
      M.broadcasts.length === before + 1 && M.broadcasts[before] === s1.hex && /the network has it/.test(out.text)
      && out.href === '/tx/' + txid && !out.again, JSON.stringify(out));
    await ev(`document.getElementById('mv-receipt').click(); true`);
    for (let i = 0; i < 40 && !Array.from(downloads.values()).includes('completed'); i++) await sleep(250);
    const got = readdirSync(DL).map((f) => { try { return JSON.parse(readFileSync(join(DL, f), 'utf8')); } catch { return null; } }).filter(Boolean)[0];
    const vr = VS[UI_CASES[0].title].receipt;
    ok('the receipt downloads with vault-sweep\'s fields and values (broadcast now true), and nothing secret',
      !!got && Object.keys(got).sort().join() === Object.keys(vr).sort().join()
      && ['system', 'to', 'sent_pcn', 'fee_pcn', 'change_pcn', 'inputs', 'txid', 'raw_hex'].every((k) => got[k] === vr[k])
      && got.broadcast === true && got.error === null && !SECRETS.some(([, v]) => v.length >= 8 && JSON.stringify(got).includes(v)),
      JSON.stringify(got).slice(0, 300));

    // Refusals, as the owner would meet them.
    await setForm({ from: 'wpcn-reserve', to: EXT, amount: '16', consent: true });
    const under = await previewDone();
    ok('browser: 16 PCN from wpcn-reserve is REFUSED, with the reserve block showing why',
      !under.ready && /below the 50000\.00000000 wPCN issued/.test(under.refusal || '') && /WOULD BE UNDER-BACKED/.test(under.reserve), (under.refusal || '') + ' | ' + under.reserve);
    await setForm({ from: 'exchange', to: EXT, amount: '3' });
    const xr = await previewDone();
    ok('browser: exchange with no change address chosen is REFUSED before anything is read', !xr.ready && /needs a change address/.test(xr.refusal || ''), xr.refusal);
    await setForm({ from: 'zzalpha', to: bech32m.encode('pc', [1, ...bech32m.toWords(randomBytes(32))]), amount: '1' });
    const tr = await previewDone();
    // A real pc1p is bech32m, so vault-sweep's bech32 (v0) decoder rejects its
    // checksum before it ever reads the version: same refusal, same words.
    ok('browser: a pc1p destination is REFUSED', !tr.ready && /REFUSED: .*(not a valid bech32 address|version-0)/.test(tr.refusal || ''), tr.refusal);
    await setForm({ from: 'zzmismatch', to: EXT, amount: '2' });
    const mp = await previewDone();
    const ms = mp.ready ? await signNow(PASS) : {};
    ok('browser: a seed that does not derive the xpub is REFUSED at signing, and nothing is signed',
      mp.ready && /does NOT derive the xpub/.test(ms.refusal || '') && !ms.hex, JSON.stringify(ms).slice(0, 300));
    await setForm({ from: 'zzalpha', to: EXT, amount: '2' });
    await previewDone();
    const wp = await signNow(PASS + 'x');
    ok('browser: a wrong passphrase is REFUSED', /does not open this vault file/.test(wp.refusal || '') && wp.leftInBox === '', JSON.stringify(wp).slice(0, 200));

    // Step 1 as the owner will usually meet it: a REMEMBERED folder. The page
    // keeps the FileSystemDirectoryHandle in IndexedDB and the folder's name
    // beside it. The native picker cannot be driven from here, so the test puts
    // a handle to a folder in this browser's private file system (OPFS) -- a
    // FileSystemDirectoryHandle like the one the picker returns -- where the
    // page keeps its own, and reloads. What follows is the page's own code:
    // offering the folder by name, reading the handle only when Reconnect is
    // pressed, listing the folder, and reading the seed file through the
    // handle at the moment of signing.
    const folderFiles = {};
    for (const f of ['zzalpha-xpub.txt', 'zzalpha-seed.enc.json', 'README-not-a-wallet.md']) {
      folderFiles[f] = f.endsWith('.md') ? 'ignored' : readFileSync(join(SWEEP_DIR, f), 'utf8');
    }
    const STORE_FOLDER = `(async () => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('vault-mirror-test', { create: true });
      const files = ${JSON.stringify(folderFiles)};
      for (const name of Object.keys(files)) {
        const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
        await w.write(files[name]); await w.close();
      }
      await new Promise((res, rej) => {
        const o = indexedDB.open('pcoin-move-pcn', 1);
        o.onupgradeneeded = () => { o.result.createObjectStore('handle'); o.result.createObjectStore('name'); };
        o.onerror = () => rej(o.error);
        o.onsuccess = () => { const tx = o.result.transaction(['handle', 'name'], 'readwrite');
          tx.objectStore('handle').put(dir, 'vault-folder'); tx.objectStore('name').put(dir.name, 'vault-folder');
          tx.oncomplete = () => { o.result.close(); res(); }; tx.onerror = () => rej(tx.error); };
      });
      return true; })()`;
    const OFFERED = `(() => { const b = document.getElementById('mv-reconnect');
      return document.readyState === 'complete' && b && !b.hidden
        ? { text: b.textContent, wallets: document.querySelectorAll('#mv-from option').length } : null; })()`;
    await ev(STORE_FOLDER);
    await send('Page.reload', {}, S);
    const offered = await waitFor(OFFERED, 30000);
    ok('a remembered folder is offered by name on the next visit, and NOT opened until Reconnect is pressed',
      offered.text === 'Reconnect to \u201cvault-mirror-test\u201d' && offered.wallets === 0, JSON.stringify(offered));
    await send('Runtime.evaluate', { expression: `document.getElementById('mv-reconnect').click(); true`, userGesture: true }, S);
    await waitFor(`/Every balance has been read/.test(document.getElementById('mv-folder-status').textContent)`, 120000);
    const remembered = await ev(`({ from: Array.from(document.querySelectorAll('#mv-from option')).map((o) => o.value),
      forget: !document.getElementById('mv-forget').hidden })`);
    ok('...Reconnect reads the folder, and files that are not wallet files are ignored',
      JSON.stringify(remembered.from) === JSON.stringify(['', 'zzalpha']) && remembered.forget, JSON.stringify(remembered));
    await setForm(UI_CASES[0].f);
    const rp = await previewDone();
    const rs = rp.ready ? await signNow(PASS) : {};
    ok('...and signing through the folder handle is byte-identical to vault-sweep too',
      rs.hex === VS[UI_CASES[0].title].receipt.raw_hex, (rp.refusal || '') + (rs.refusal || ''));
    await ev(`document.getElementById('mv-forget').click(); true`);
    await sleep(500);
    const gone = await ev(`new Promise((res) => { const o = indexedDB.open('pcoin-move-pcn', 1);
      o.onsuccess = () => { const tx = o.result.transaction(['handle', 'name']);
        const a = tx.objectStore('handle').count('vault-folder'), b = tx.objectStore('name').count('vault-folder');
        tx.oncomplete = () => { o.result.close(); res(a.result === 0 && b.result === 0); }; }; })`);
    ok('"Forget this folder" removes both the handle and the name from browser storage', gone === true);

    // Everything the browser sent while all of that happened.
    for (const q of reqs) {
      if (q.hasPostData && !q.body) {
        try { q.body = (await send('Network.getRequestPostData', { requestId: q.id }, S)).postData || ''; } catch { /* gone */ }
      }
    }
    const fetches = reqs.filter((q) => q.type === 'Fetch' || q.type === 'XHR');
    ok(`the browser made ${fetches.length} fetches, every one to this origin`, fetches.length > 50
      && reqs.every((q) => q.url.startsWith(MOCK + '/') || /^(data|blob|about|chrome-extension):/.test(q.url)),
      reqs.filter((q) => !q.url.startsWith(MOCK + '/')).map((q) => q.url).join(' '));
    ok('   and only to /api/addresses, /api/address/…/utxos, /api/tx and the panel\'s two lists',
      fetches.every((q) => /^\/(api\/addresses|api\/address\/pc1[0-9a-z]+\/utxos\?require_mempool=1|api\/tx|tp\/transfer\/(destinations|reserve)\.json)$/.test(q.url.slice(MOCK.length))),
      fetches.map((q) => q.url.slice(MOCK.length)).filter((u) => !/^\/api\//.test(u) && !/^\/tp\/transfer\//.test(u)).join(' '));
    const hay = reqs.map((q) => q.method + ' ' + q.url + '\n' + q.headers + '\n' + q.body).join('\n\n');
    const leaks = SECRETS.filter(([, v]) => v && v.length >= 8 && (/^[0-9a-f]+$/i.test(v) ? hay.toLowerCase().includes(v.toLowerCase()) : hay.includes(v))).map(([k]) => k);
    ok(`none of the ${SECRETS.length} secrets appears in anything the browser sent`, leaks.length === 0, leaks.join(', '));
    ok('no script error and no Content-Security-Policy violation in the page', problems.length === 0, problems.join('\n'));

    // THE FREEZE THIS PAGE WAS CHANGED FOR. In an off-the-record context
    // (InPrivate), reading a stored folder handle back out of IndexedDB froze
    // Edge -- the page and the browser's own DevTools endpoint stopped
    // answering. So the page now reads only the folder's NAME when it opens,
    // and the handle only on Reconnect. This proves that opening the page there,
    // with a handle stored, leaves both the page and the browser answering. It
    // deliberately does NOT press Reconnect in that context.
    {
      const { browserContextId: otr } = await send('Target.createBrowserContext', { disposeOnDetach: true });
      const { targetId: t2 } = await send('Target.createTarget', { url: 'about:blank', browserContextId: otr });
      const { sessionId: S2 } = await send('Target.attachToTarget', { targetId: t2, flatten: true });
      const ev2 = async (expression, ms = 8000) => {
        const r = await Promise.race([send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, S2), sleep(ms).then(() => null)]);
        return r && r.result ? r.result.value : null;
      };
      await send('Network.setCookie', { name: 'pcadm', value: sid, url: MOCK + '/tp/transfer', path: '/tp', httpOnly: true }, S2);
      await send('Page.navigate', { url: MOCK + '/tp/transfer' }, S2);
      for (let i = 0; i < 40 && (await ev2(`document.readyState`)) !== 'complete'; i++) await sleep(250);
      const stored = await ev2(STORE_FOLDER, 15000);
      await send('Page.reload', {}, S2);
      let seen = null;
      for (let i = 0; i < 40 && !seen; i++) { await sleep(250); seen = await ev2(OFFERED, 3000); }
      const still = await ev2(`1 + 1`, 3000);
      let browserUp = false;
      try { browserUp = (await fetch(wsUrl.replace(/^ws:/, 'http:').replace(/\/devtools\/.*$/, '/json/version'), { signal: AbortSignal.timeout(3000) })).ok; } catch { /* down */ }
      ok('InPrivate-like context, handle stored, page reopened: the page and the browser keep answering, Reconnect is offered',
        stored === true && !!seen && still === 2 && browserUp, JSON.stringify({ stored, seen, still, browserUp }));
      try { await send('Target.closeTarget', { targetId: t2 }); } catch { /* gone */ }
      try { await send('Target.disposeBrowserContext', { browserContextId: otr }); } catch { /* gone */ }
    }
  } finally {
    try { await send('Target.closeTarget', { targetId }); } catch { /* already closed */ }
    // It is our own headless browser, so it is closed outright -- and killed if
    // it does not go -- before its profile directory is deleted with TMP.
    try { await send('Browser.close'); } catch { /* already gone */ }
    ws.close();
    for (let i = 0; i < 20 && browser.exitCode === null; i++) await sleep(250);
    if (browser.exitCode === null) browser.kill();
    PANEL_PORT = 0;
    panel.kill();
  }
}
