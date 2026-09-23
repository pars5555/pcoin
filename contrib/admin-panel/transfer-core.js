/* ═══════════════════════════════════════════════════════════════════════════
 * transfer-core.js -- the signer behind the admin panel's "Move PCN" page.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Loaded by the page (transfer.mjs) straight after the pinned crypto bundle,
 * and loaded UNCHANGED by the tests (transfer-test.mjs), which run it under
 * Node against the same bundle. It touches no DOM; transfer-ui.js does that.
 *
 * WHAT IT IS A COPY OF, AND WHY THAT IS THE POINT
 * Every step that decides money is a line-for-line mirror of
 * contrib/vault/vault-sweep.mjs: finding used addresses from the xpub on both
 * branches, reading UTXOs, largest-first coin selection, the fee (2 sat/vB,
 * vsize = ceil(10.5 + 68*ins + 31*outs)), the 1000-sat change rule, where
 * change goes, the xpub-vs-seed check, BIP143 signing, DER, serialisation and
 * the txid. The test suite runs vault-sweep.mjs itself on the same inputs and
 * requires the raw transaction to come out BYTE-IDENTICAL. A mirror nobody
 * compares is a fork; this one is compared on every test run.
 *
 * Where this file is STRICTER than vault-sweep it says so at the spot, and it
 * is only ever stricter by refusing: it never builds a different transaction,
 * it declines to build one. Every such refusal is a case where vault-sweep
 * would have signed something that is wrong, unknowable or unrelayable.
 *
 * WHERE SECRETS LIVE -- the whole map
 * Only signPlan(), and openBlob() which it calls, ever see the passphrase, the
 * decrypted phrase, the seed or a private key. signPlan receives the
 * passphrase as an argument, reads the encrypted blob through a callback at
 * that moment and no earlier, and returns { hex, txid, vsize } -- a signed
 * transaction, which is public by definition.
 * Every Uint8Array it creates that holds key material is zeroed in a finally
 * block. JavaScript strings (the passphrase as typed, the mnemonic) cannot be
 * zeroed by any means; they are dropped at the earliest point and left to the
 * garbage collector. That limit is real and is stated rather than hidden.
 *
 * WHERE THE NETWORK IS -- the whole map
 * makeNet() is the only code in the page that talks to anything, and it is the
 * only place `fetch` appears in either client file (a test asserts that). It
 * offers exactly five requests, and every field of every request is either a
 * public address (checked against the bech32 alphabet before it is sent) or a
 * signed transaction (parsed before it is sent: only DER signatures and 33-byte
 * public keys may appear in its witness). There is no general-purpose "send
 * this" function, so there is nothing a secret could be passed to.
 */
(function (root) {
  'use strict';

  var C = root.PCoinCrypto;
  if (!C || !C.HDKey || !C.secp256k1 || !C.scryptAsync) {
    throw new Error('transfer-core.js: the pinned crypto bundle (PCoinCrypto) is not loaded');
  }

  // ── constants, each the same value vault-sweep.mjs uses ────────────────────
  const HRP = 'pc';
  const ACCOUNT_PATH = "m/84'/9444'/0'";
  const HARDENED = 0x80000000;
  const SCRYPT = Object.freeze({ N: 1 << 17, r: 8, p: 1, keylen: 32, maxmem: 256 * 1024 * 1024 });
  const SCAN_TO = 2000;          // how far along each branch to look
  const BULK = 200;              // addresses per POST /api/addresses
  const FEE_RATE_DEFAULT = 2;    // sat/vB
  const CHANGE_MIN_SAT = 1000;   // change above this becomes an output; at or below, it is fee
  const SEQUENCE = 0xfffffffd;
  // Page-only: Core's relay dust threshold for a P2WPKH output at the default
  // 3 sat/vB dust fee, (31 + 67) * 3. See contrib/explorer/pcoin_api/service.py.
  const DUST_SAT = 294;
  // wPCN issuedSupply, fixed at creation (contrib/wpcn/wrapdesk-server.mjs ISSUED).
  const WPCN_ISSUED_SAT = 50000 * 1e8;
  const MAX_SAT = 21000000 * 1e8;
  // The two vault wallets whose addresses no service credits to a customer:
  // wpcn-reserve #0 is the MAIN reserve address, market-hot is the market float.
  const NOT_A_RAIL = new Set(['wpcn-reserve', 'market-hot']);

  // ── refusals ──────────────────────────────────────────────────────────────
  // Two kinds, never merged: REFUSED is a definite no; UNKNOWN is "a read
  // failed, so nothing may be concluded" (CLAUDE.md 7.1). The page renders them
  // differently because the right next step differs.
  class Refusal extends Error {
    constructor(message, kind) { super(message); this.name = 'Refusal'; this.kind = kind || 'refused'; }
  }
  const refuse = (m) => new Refusal(m, 'refused');
  const unknown = (m) => new Refusal(m, 'unknown');

  // ── bytes ─────────────────────────────────────────────────────────────────
  const te = new TextEncoder();
  function concat() {
    let n = 0;
    for (let i = 0; i < arguments.length; i++) n += arguments[i].length;
    const out = new Uint8Array(n);
    let o = 0;
    for (let i = 0; i < arguments.length; i++) { out.set(arguments[i], o); o += arguments[i].length; }
    return out;
  }
  const concatList = (list) => concat.apply(null, list);
  const HEX = '0123456789abcdef';
  function toHex(b) {
    let s = '';
    for (let i = 0; i < b.length; i++) s += HEX[b[i] >> 4] + HEX[b[i] & 15];
    return s;
  }
  function fromHex(s) {
    if (typeof s !== 'string' || s.length % 2 || !/^[0-9a-fA-F]*$/.test(s)) throw new Error('not hex');
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
    return out;
  }
  const reversed = (b) => Uint8Array.from(b).reverse();
  function fromB64(s) {
    if (typeof s !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new Error('not base64');
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function u32(n) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n >>> 0, true);
    return b;
  }
  function u64(n) {
    // vault-sweep: BigInt(n), which throws on a fraction. Same refusal here,
    // plus the range check BigInt would not make.
    if (!Number.isSafeInteger(n) || n < 0) throw new Error('amount is not a whole number of satoshi: ' + n);
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
    return b;
  }
  function varint(n) {
    if (n < 0xfd) return Uint8Array.of(n);
    if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, n >> 8);
    const b = new Uint8Array(5); b[0] = 0xfe;
    new DataView(b.buffer).setUint32(1, n, true);
    return b;
  }

  // ── hashes and addresses (vault-sweep: sha256 / hash256 / hash160 / addressOf)
  const sha256 = (b) => C.sha256(b);
  const hash256 = (b) => C.sha256(C.sha256(b));
  const hash160 = (b) => C.ripemd160(C.sha256(b));
  const addressOf = (pubkey) => C.bech32.encode(HRP, [0].concat(Array.from(C.bech32.toWords(hash160(pubkey)))));
  const scriptPubKey = (h160) => concat(Uint8Array.of(0x00, 0x14), h160);
  const sat = (n) => (Number(n) / 1e8).toFixed(8);

  /** What a refusal may quote back. vault-sweep prints the bad input in its
   *  terminal; a page is looked at by more eyes, and the one input worth never
   *  echoing is a phrase or passphrase pasted into the wrong box. So only text
   *  that could plausibly BE what the box asks for is quoted. */
  const quote = (s, shape) => (typeof s === 'string' && shape.test(s) ? '"' + s + '"' : 'that');
  const ADDRESS_LIKE = /^[A-Za-z0-9]{1,90}$/;

  /** pc1q... -> the 20-byte hash it pays. Refuses anything that is not v0/20.
   *  vault-sweep.mjs decodeAddress(), message for message. */
  function decodeAddress(addr) {
    let d;
    try { d = C.bech32.decode(addr); } catch (e) { throw refuse(quote(addr, ADDRESS_LIKE) + ' is not a valid bech32 address'); }
    if (d.prefix !== HRP) throw refuse('"' + addr + '" is not a PCoin address (prefix ' + d.prefix + ', expected ' + HRP + ')');
    const version = d.words[0];
    if (version !== 0) throw refuse('only version-0 (pc1q…) addresses are supported; that one is version ' + version);
    let prog;
    // vault-sweep lets a malformed padding throw out of fromWords unhandled;
    // here it is the same refusal with a readable reason.
    try { prog = Uint8Array.from(C.bech32.fromWords(d.words.slice(1))); }
    catch (e) { throw refuse('"' + addr + '" does not decode to a whole program'); }
    if (prog.length !== 20) throw refuse('that address has a ' + prog.length + '-byte program; a pc1q… address has 20');
    return prog;
  }
  /** The canonical (lowercase) spelling of a valid pc1q address, or a refusal. */
  function canonicalAddress(addr) {
    const prog = decodeAddress(addr);
    return C.bech32.encode(HRP, [0].concat(Array.from(C.bech32.toWords(prog))));
  }
  function isAddress(addr) {
    try { decodeAddress(addr); return true; } catch (e) { return false; }
  }

  /** An xpub file's contents -> the account xpub string. Public data only. */
  function parseXpub(text, label) {
    const x = String(text == null ? '' : text).trim();
    // The file's content is never echoed in a message: if somebody ever put an
    // xprv here, the refusal must not print it onto the screen.
    if (!/^xpub[1-9A-HJ-NP-Za-km-z]{100,120}$/.test(x)) {
      throw refuse((label || 'that file') + ' does not contain an account xpub');
    }
    let node;
    try { node = C.HDKey.fromExtendedKey(x); } catch (e) { throw refuse((label || 'that file') + ' is not a readable xpub'); }
    if (node.privateKey) throw refuse((label || 'that file') + ' contains a PRIVATE key. Refusing.');
    return x;
  }

  // ── derivation, cached per xpub ───────────────────────────────────────────
  // Exactly vault-sweep's derivation (HDKey.fromExtendedKey(xpub).deriveChild(
  // branch).deriveChild(i)), 2000 deep on both branches. It is slow -- about a
  // second per thousand addresses -- so it yields to the page every hundred and
  // is remembered for the life of the page.
  const derivedCache = new Map();
  const nextTick = () => new Promise((r) => setTimeout(r, 0));
  async function deriveBranches(xpub, scanTo, onProgress) {
    const key = xpub + '#' + scanTo;
    if (derivedCache.has(key)) return derivedCache.get(key);
    const node = C.HDKey.fromExtendedKey(xpub);
    const out = { receive: [], change: [] };
    let done = 0;
    for (const branch of [0, 1]) {
      const b = node.deriveChild(branch);
      const list = branch === 0 ? out.receive : out.change;
      for (let i = 0; i < scanTo; i++) {
        list.push(addressOf(b.deriveChild(i).publicKey));
        if (++done % 100 === 0) {
          if (onProgress) onProgress(done, 2 * scanTo);
          await nextTick();
        }
      }
    }
    Object.freeze(out.receive); Object.freeze(out.change);
    derivedCache.set(key, Object.freeze(out));
    return out;
  }
  function address0(xpub) {
    return addressOf(C.HDKey.fromExtendedKey(xpub).deriveChild(0).deriveChild(0).publicKey);
  }
  function ownChangeAddress(xpub) {
    return addressOf(C.HDKey.fromExtendedKey(xpub).deriveChild(1).deriveChild(0).publicKey);
  }

  // ── the network: the ONLY place this page talks to anything ────────────────
  // Five requests exist, each with a fixed shape. Every value that can appear
  // in one is checked to BE a public address or a signed transaction before it
  // is sent -- the check is the allow-list, and there is no sixth door.
  const ADDRESS_SHAPE = /^pc1[02-9ac-hj-np-z]{6,87}$/;
  function publicAddress(a) {
    if (typeof a !== 'string' || !ADDRESS_SHAPE.test(a)) {
      throw new Error('refusing to send something that is not an address');
    }
    return a;
  }
  function makeNet(opts) {
    const o = opts || {};
    const origin = o.origin || '';                   // '' in the page: same origin only
    const panelBase = String(o.panelBase || '');
    const doFetch = o.fetch || root.fetch.bind(root);
    const timeoutMs = o.timeoutMs || 45000;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    if (panelBase && !/^\/[^\s?#"'<>\\]+$/.test(panelBase)) {
      throw new Error('panel base path is malformed');
    }

    // THE ONE CALL SITE OF fetch IN THE PAGE. `body` is only ever built by the
    // five methods below, from values already checked.
    async function call(method, path, body, retry429) {
      for (let attempt = 0; ; attempt++) {
        const init = { method: method, headers: {}, credentials: 'same-origin', cache: 'no-store',
                       redirect: 'error', signal: AbortSignal.timeout(timeoutMs) };
        if (body !== undefined) {
          init.headers['content-type'] = 'application/json';
          init.body = JSON.stringify(body);
        }
        let r, text;
        try { r = await doFetch(origin + path, init); text = await r.text(); }
        catch (e) { throw unknown(method + ' ' + path.split('?')[0] + ' got no answer (' + ((e && e.message) || e) + ')'); }
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* reported by the caller */ }
        if (r.status === 429 && retry429 && attempt < 6) {
          const ra = Number(r.headers.get('retry-after'));
          await sleep((Number.isFinite(ra) && ra > 0 ? ra : 2) * 1000);
          continue;
        }
        return { status: r.status, ok: r.ok, json: json, text: text };
      }
    }
    const readOrUnknown = (what, r) => {
      if (!r.ok || !r.json) {
        const t = String(r.text || '');
        const msg = r.json && r.json.error ? (r.json.error.message || r.json.error.code || JSON.stringify(r.json.error))
          : /^\s*</.test(t) ? 'a web page came back instead of data -- if your panel session expired, reload and sign in'
          : t.slice(0, 160);
        throw unknown(what + ' -> HTTP ' + r.status + ' ' + msg);
      }
      return r.json;
    };

    return Object.freeze({
      /** 1. POST /api/addresses {addresses: [pc1...]} -- balances, a batch of addresses. */
      addresses: async function (list) {
        if (!Array.isArray(list) || !list.length || list.length > 500) throw new Error('bad address batch');
        const addresses = list.map(publicAddress);
        return readOrUnknown('explorer /api/addresses', await call('POST', '/api/addresses', { addresses: addresses }, true));
      },
      /** 2. GET /api/address/<pc1...>/utxos -- one address's spendable outputs.
       *  require_mempool=1: without it the explorer answers even when it cannot
       *  see the mempool, and an output already being spent reads as spendable. */
      utxos: async function (address) {
        const a = publicAddress(address);
        return readOrUnknown('explorer /api/address/…/utxos',
          await call('GET', '/api/address/' + a + '/utxos?require_mempool=1', undefined, true));
      },
      /** 3. POST /api/tx {hex} -- broadcast. The hex is parsed first. */
      broadcast: async function (hex) {
        const parsed = parseSignedTx(hex);
        return call('POST', '/api/tx', { hex: parsed.hex }, false);
      },
      /** 4. GET <panel>/transfer/destinations.json -- the named destinations. */
      destinations: async function () {
        return readOrUnknown('panel destinations', await call('GET', panelBase + '/transfer/destinations.json', undefined, false));
      },
      /** 5. GET <panel>/transfer/reserve.json -- the addresses the proof page counts. */
      reserve: async function () {
        return readOrUnknown('panel reserve list', await call('GET', panelBase + '/transfer/reserve.json', undefined, false));
      },
    });
  }

  /** Parse a signed segwit transaction and prove its witness holds nothing but
   *  signatures and public keys. Refuses anything else, so the broadcast door
   *  can only ever carry a transaction, never arbitrary bytes. */
  function parseSignedTx(hex) {
    if (typeof hex !== 'string' || !/^[0-9a-f]+$/.test(hex) || hex.length % 2 || hex.length > 400000) {
      throw new Error('refusing to broadcast: not a lowercase hex transaction');
    }
    const b = fromHex(hex);
    let p = 0;
    const need = (n) => { if (p + n > b.length) throw new Error('refusing to broadcast: truncated transaction'); };
    const rd = (n) => { need(n); const s = b.subarray(p, p + n); p += n; return s; };
    const rdU32 = () => { need(4); const v = new DataView(b.buffer, b.byteOffset + p, 4).getUint32(0, true); p += 4; return v; };
    const rdVar = () => {
      need(1); const f = b[p++];
      if (f < 0xfd) return f;
      if (f === 0xfd) { need(2); const v = b[p] | (b[p + 1] << 8); p += 2; return v; }
      if (f === 0xfe) { return rdU32(); }
      throw new Error('refusing to broadcast: varint too large');
    };
    if (rdU32() !== 2) throw new Error('refusing to broadcast: version is not 2');
    if (rd(2).join(',') !== '0,1') throw new Error('refusing to broadcast: not a segwit transaction');
    const nIn = rdVar();
    if (nIn < 1 || nIn > 5000) throw new Error('refusing to broadcast: input count');
    for (let i = 0; i < nIn; i++) {
      rd(36);                                        // outpoint
      if (rdVar() !== 0) throw new Error('refusing to broadcast: non-empty scriptSig');
      rdU32();
    }
    const nOut = rdVar();
    if (nOut < 1 || nOut > 2) throw new Error('refusing to broadcast: output count');
    for (let i = 0; i < nOut; i++) {
      rd(8);
      const len = rdVar();
      const s = rd(len);
      if (len !== 22 || s[0] !== 0x00 || s[1] !== 0x14) throw new Error('refusing to broadcast: an output is not P2WPKH');
    }
    for (let i = 0; i < nIn; i++) {
      if (rdVar() !== 2) throw new Error('refusing to broadcast: a witness is not [signature, public key]');
      const sl = rdVar(); const sig = rd(sl);
      if (sl < 9 || sl > 73 || sig[0] !== 0x30 || sig[1] !== sl - 3 || sig[sl - 1] !== 0x01) {
        throw new Error('refusing to broadcast: a witness item is not a DER signature');
      }
      const kl = rdVar(); const key = rd(kl);
      if (kl !== 33 || (key[0] !== 2 && key[0] !== 3)) throw new Error('refusing to broadcast: a witness item is not a public key');
    }
    if (rdU32() !== 0) throw new Error('refusing to broadcast: locktime is not 0');
    if (p !== b.length) throw new Error('refusing to broadcast: trailing bytes');
    return { hex: hex, inputs: nIn, outputs: nOut };
  }

  // ── reading the chain (vault-sweep: findUsed, utxosFor) ────────────────────
  /** STRICTER than vault-sweep: every explorer answer carries an `index` block,
   *  and when it says the index is not current -- behind the node, a node that
   *  has not been polled, a reorg in progress -- nothing read from it is used.
   *  That is the gate CLAUDE.md 8c prescribes for the payment rails, and it
   *  matters most for the reserve count, which a stale index can over-state. */
  function checkFresh(res, what) {
    const ix = res && res.index;
    if (!ix || ix.stale !== false) {
      const why = (ix && Array.isArray(ix.stale_reasons) && ix.stale_reasons.join('; ')) || 'its answer carries no index state';
      throw unknown(what + ': the explorer says its index is not current (' + why + '), so nothing it said can be relied on yet. Try again in a minute.');
    }
  }

  /** Every address on both branches that has ever been used, with its balance.
   *  vault-sweep.mjs findUsed(), in the same order, from the same fields. */
  async function findUsed(net, xpub, opts) {
    const o = opts || {};
    const scanTo = o.scanTo || SCAN_TO, bulk = o.bulk || BULK;
    const d = await deriveBranches(xpub, scanTo, o.onDerive);
    const all = [];
    for (const branch of [0, 1]) {
      const list = branch === 0 ? d.receive : d.change;
      for (let i = 0; i < scanTo; i++) all.push({ branch: branch, index: i, address: list[i] });
    }
    const byAddr = new Map(all.map((a) => [a.address, a]));
    const used = [];
    for (let i = 0; i < all.length; i += bulk) {
      const slice = all.slice(i, i + bulk);
      const res = await net.addresses(slice.map((a) => a.address));
      checkFresh(res, 'reading balances');
      const rows = res.addresses || res.results || res.items || [];
      // STRICTER: vault-sweep trusts the row set. An answer about an address
      // nobody asked for, or a missing one, is refused rather than guessed at.
      const asked = new Set(slice.map((a) => a.address));
      const seen = new Set();
      for (const row of rows) {
        const a = row && byAddr.get(row.address);
        if (!a || !asked.has(row.address)) throw unknown('the explorer answered about an address it was not asked about');
        seen.add(row.address);
        const c = (row.balance && row.balance.confirmed) || row.balance || {};
        // STRICTER: vault-sweep reads `spendable_sat ?? 0`, so an explorer that
        // cannot see the mempool (spendable_sat: null) made a funded wallet
        // read EMPTY. Unknown is not zero (CLAUDE.md 7.1): refuse instead.
        if (typeof c.spendable_sat !== 'number') {
          throw unknown('the explorer cannot say what ' + row.address + ' can spend right now ('
            + (c.spendable_unknown_reason || 'no spendable figure in its answer') + ')');
        }
        const spendable = Number(c.spendable_sat ?? 0);
        if (!Number.isSafeInteger(spendable) || spendable < 0) throw unknown('unreadable balance for ' + row.address);
        if (spendable > 0) used.push(Object.assign({}, a, { spendable: spendable }));
      }
      if (seen.size !== asked.size) throw unknown('the explorer answered for ' + seen.size + ' of ' + asked.size + ' addresses');
      if (o.onProgress) o.onProgress(Math.min(i + bulk, all.length), all.length);
    }
    return used;
  }

  /** Every spendable output of the used addresses, largest first.
   *  vault-sweep.mjs: utxosFor() per used address, then filter and sort. */
  async function collectUtxos(net, used) {
    let utxos = [];
    const seen = new Set();
    for (const a of used) {
      const d = await net.utxos(a.address);
      checkFresh(d, 'reading unspent outputs');
      // STRICTER: a paged answer would silently leave outputs behind.
      if (d.has_more) throw refuse(a.address + ' has more unspent outputs than the explorer returns in one page');
      const want = '0014' + toHex(decodeAddress(a.address));
      const list = (d.utxos || []).filter((u) => !u.is_immature && !u.pending_spend);
      for (const u of list) {
        // STRICTER, all of these: each is a transaction that would be invalid
        // or would spend the wrong thing, and vault-sweep would sign it anyway.
        if (typeof u.txid !== 'string' || !/^[0-9a-f]{64}$/.test(u.txid)) throw unknown('an output of ' + a.address + ' has an unreadable txid');
        if (!Number.isInteger(u.vout) || u.vout < 0) throw unknown('an output of ' + a.address + ' has an unreadable vout');
        if (u.spendable !== true || u.mature === false || u.spent_in_mempool === true) {
          throw unknown(u.txid + ':' + u.vout + ' is listed but not marked spendable by the explorer');
        }
        if (String(u.script_hex || '').toLowerCase() !== want) {
          throw refuse(u.txid + ':' + u.vout + ' pays script ' + u.script_hex + ', not ' + a.address);
        }
        const key = u.txid + ':' + u.vout;
        if (seen.has(key)) throw unknown(key + ' was listed twice');
        seen.add(key);
        const value = Number(u.value_sat ?? u.value);
        if (!Number.isSafeInteger(value)) throw unknown(key + ' has an unreadable value');
        utxos.push({ txid: u.txid, vout: u.vout, value: value, branch: a.branch, index: a.index, address: a.address });
      }
    }
    // Array.prototype.sort is stable, as in Node: equal values keep scan order.
    utxos = utxos.filter((u) => u.value > 0).sort((x, y) => y.value - x.value);
    return utxos;
  }

  // ── choosing coins (vault-sweep: the "choose coins" block) ─────────────────
  const vsizeFor = (ins, outs) => Math.ceil(10.5 + 68 * ins + 31 * outs);

  /** The refusals vault-sweep makes BEFORE it reads the chain, in its order:
   *  exchange without --change-to, wpcn-reserve without consent, then the
   *  destination and the change address. The page runs this before its scan
   *  too, so a mistake fails in a second rather than after a minute of reading. */
  function precheck(o) {
    const system = String(o.system || '');
    const feeRate = o.feeRate == null ? FEE_RATE_DEFAULT : o.feeRate;
    if (!Number.isSafeInteger(feeRate) || feeRate < 1 || feeRate > 1000) throw refuse('the fee rate must be a whole number of sat/vB');
    if (system === 'exchange' && !o.sendAll && !o.changeTo) {
      throw refuse('sweeping `exchange` without All needs a change address.\n'
        + 'Change would otherwise return to an address this exchange WATCHES,\n'
        + 'and a customer would be credited with your coins.');
    }
    if (system === 'wpcn-reserve' && !o.reserveConsent) {
      throw refuse('`wpcn-reserve` backs every wPCN in circulation 1:1.\n'
        + 'Only the SURPLUS above the wPCN supply is yours to move.\n'
        + 'Tick "I know the reserve backs wPCN" if that is what you mean,\n'
        + 'and check D:\\pc.am\\PCOIN-WPCN-RUNBOOK.md first.');
    }
    const to = canonicalAddress(o.to);
    // Validated next to the destination, before anything else, as vault-sweep does.
    const changeTo = o.changeTo ? canonicalAddress(o.changeTo) : null;
    return { system: system, feeRate: feeRate, to: to, changeTo: changeTo };
  }

  /** Build the unsigned transaction exactly as vault-sweep would.
   *
   *  o = { system, xpub, used (from findUsed), utxos (from collectUtxos), to,
   *        sendAll, amountSat, amountText, changeTo (an address, or null for
   *        the wallet's own m/.../1/0), feeRate, reserveConsent }
   *  The guards and their order are vault-sweep's; the refusal messages are
   *  its words. Nothing here reads the network. */
  function planTransaction(o) {
    const pre = precheck(o);
    const system = pre.system, feeRate = pre.feeRate, to = pre.to, changeTo = pre.changeTo;
    const toHash = decodeAddress(to);
    const changeToHash = changeTo ? decodeAddress(changeTo) : null;

    const utxos = o.utxos || [];
    const available = utxos.reduce((s, u) => s + u.value, 0);
    if (!o.used || !o.used.length) throw refuse('"' + system + '" has no spendable coins at any address on either branch');

    let chosen = [];
    let outs = [];
    let fee = 0;

    if (o.sendAll) {
      chosen = utxos.slice();
      fee = vsizeFor(chosen.length, 1) * feeRate;
      const value = available - fee;
      if (value <= 0) throw refuse('the whole balance (' + sat(available) + ') does not cover the fee (' + sat(fee) + ')');
      outs = [{ value: value, script: scriptPubKey(toHash), address: to, role: 'destination' }];
    } else {
      const want = o.amountSat;
      if (!Number.isSafeInteger(want) || want <= 0) throw refuse(quote(o.amountText, /^[0-9.,eE+-]{0,24}$/) + ' is not a valid amount of PCN');
      let total = 0;
      for (const u of utxos) {
        chosen.push(u); total += u.value;
        fee = vsizeFor(chosen.length, 2) * feeRate;
        if (total >= want + fee) break;
      }
      if (total < want + fee) {
        throw refuse('not enough: asked for ' + sat(want) + ' + ' + sat(fee) + ' fee, but only ' + sat(total) + ' is spendable here');
      }
      const change = total - want - fee;
      outs = [{ value: want, script: scriptPubKey(toHash), address: to, role: 'destination' }];
      // Dust would cost more to spend than it is worth; give it to the fee.
      if (change > CHANGE_MIN_SAT) {
        // The proof-of-backing page counts the MAIN reserve address plus the
        // deposit addresses; change on a derived address is invisible to it.
        if (system === 'wpcn-reserve' && !changeToHash) {
          throw refuse('this would leave ' + sat(change) + ' PCN as change at a derived address.\n'
            + 'The proof-of-backing page counts the MAIN reserve address plus\n'
            + 'the deposit addresses it handed out -- it does NOT scan the whole\n'
            + 'wallet, so change would be invisible to it and\n'
            + 'wrapdesk.pc.am/proof would under-report the backing publicly.\n\n'
            + 'Send the change to the main reserve address so the remainder goes\n'
            + 'back where the page can see it.');
        }
        if (changeToHash) {
          outs.push({ value: change, script: scriptPubKey(changeToHash), address: changeTo, role: 'change' });
        } else {
          const ch = C.HDKey.fromExtendedKey(o.xpub).deriveChild(1).deriveChild(0);
          outs.push({ value: change, script: scriptPubKey(hash160(ch.publicKey)), address: addressOf(ch.publicKey), role: 'change' });
        }
      } else if (change > 0) {
        fee += change;
      }
    }

    const plan = {
      system: system,
      xpub: o.xpub,
      to: to,
      sendAll: Boolean(o.sendAll),
      feeRate: feeRate,
      available: available,
      usedCount: o.used.length,
      utxoCount: utxos.length,
      chosen: chosen.map((u) => Object.freeze(Object.assign({}, u))),
      outs: outs.map((x) => Object.freeze(x)),
      fee: fee,
      sending: outs[0].value,
      changeOut: outs[1] || null,
      // true when the change address was chosen (vault-sweep's --change-to),
      // false when it is the wallet's own m/84'/9444'/0'/1/0.
      changeExplicit: Boolean(changeToHash),
      estimatedVsize: vsizeFor(chosen.length, outs.length),
    };
    plan.tx = {
      ins: plan.chosen.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, branch: u.branch, index: u.index, address: u.address })),
      outs: plan.outs.map((x) => ({ value: x.value, script: x.script })),
    };
    // The arithmetic a reader should be able to check on the screen, checked here.
    const inTotal = plan.chosen.reduce((s, u) => s + u.value, 0);
    const outTotal = plan.outs.reduce((s, x) => s + x.value, 0);
    if (inTotal !== outTotal + plan.fee) throw new Error('internal: inputs ' + inTotal + ' != outputs ' + outTotal + ' + fee ' + plan.fee);
    return Object.freeze(plan);
  }

  /** The page's own refusals, applied to a plan vault-sweep would have built.
   *  Each is a case where that plan is wrong for reasons vault-sweep does not
   *  check. None of them changes the transaction; they only decline it.
   *
   *  ctx = { reserveMain, exchangeAddresses:Set, railOf(address) -> {wallet,
   *          branch, index} | null, railAck }                              */
  function pageGuards(plan, ctx) {
    const c = ctx || {};
    for (const x of plan.outs) {
      if (x.value < DUST_SAT) {
        throw refuse('the ' + x.role + ' output would be ' + x.value + ' sat, below the ' + DUST_SAT
          + '-sat dust limit; no node would relay it');
      }
    }
    if (plan.system === 'wpcn-reserve' && plan.changeOut) {
      if (!c.reserveMain) throw unknown('the main reserve address is not known, so where change lands cannot be checked');
      if (plan.changeOut.address !== c.reserveMain) {
        throw refuse('change from wpcn-reserve must go to the MAIN reserve address ' + c.reserveMain
          + ', not ' + plan.changeOut.address + '. The proof page counts only that address and the deposit addresses.');
      }
    }
    if (plan.system === 'exchange' && plan.changeOut && c.exchangeAddresses && c.exchangeAddresses.has(plan.changeOut.address)) {
      throw refuse('change must not return to an address of the exchange wallet: the exchange watches them, and a change output '
        + 'on a customer\u2019s deposit address is credited to that customer.');
    }
    if (c.railOf && !c.railAck) {
      const flagged = railAddresses(plan, c.railOf);
      if (flagged.length) {
        const r = flagged[0];
        throw refuse(r.address + ' (the ' + r.role + ') is ' + r.wallet + '\u2019s ' + (r.branch ? 'change' : 'receive')
          + ' address #' + r.index + '. ' + r.wallet + ' watches its addresses, and a payment there may be credited to '
          + 'whichever customer holds it. Tick the acknowledgement if that is really what you mean.');
      }
    }
    return true;
  }

  /** A lookup: address -> { wallet, branch, index } when it belongs to a vault
   *  wallet that is a RAIL -- a service that credits a payment to its receive
   *  address to whichever customer holds it (CLAUDE.md 8c: a rail's #0 is
   *  usually a customer's). wpcn-reserve (#0 is the main reserve) and
   *  market-hot (the float) are not rails. The exchange also watches its change
   *  branch. `wallets` is [{ name, addr0, rail: Map|null }]; #0 is always
   *  checked, the full branches once railIndex() has derived them. */
  function makeRailOf(wallets) {
    return function railOf(address) {
      for (const w of wallets) {
        if (NOT_A_RAIL.has(w.name)) continue;
        if (w.addr0 === address) return { wallet: w.name, branch: 0, index: 0 };
        const hit = w.rail && w.rail.get(address);
        if (hit) return { wallet: w.name, branch: hit.branch, index: hit.index };
      }
      return null;
    };
  }
  async function railIndex(name, xpub, onProgress) {
    if (NOT_A_RAIL.has(name)) return null;
    const d = await deriveBranches(xpub, SCAN_TO, onProgress);
    const m = new Map();
    d.receive.forEach((a, i) => m.set(a, { branch: 0, index: i }));
    if (name === 'exchange') d.change.forEach((a, i) => m.set(a, { branch: 1, index: i }));
    return m;
  }

  /** Which of the plan's addresses belong to a service that credits deposits.
   *  The destination always counts; change counts only when it was chosen --
   *  the wallet's own m/.../1/0 is where vault-sweep sends change by default. */
  function railAddresses(plan, railOf) {
    const out = [];
    const t = railOf(plan.to);
    if (t) out.push(Object.assign({ address: plan.to, role: 'destination' }, t));
    if (plan.changeOut && plan.changeExplicit) {
      const ch = railOf(plan.changeOut.address);
      if (ch) out.push(Object.assign({ address: plan.changeOut.address, role: 'change' }, ch));
    }
    return out;
  }

  /** What an answer from POST /api/tx means. Four outcomes, never two: the
   *  explorer's 502 "broadcast_outcome_unknown" is NOT a rejection and must not
   *  be shown as one -- re-sending the identical hex is safe (CLAUDE.md 7.1). */
  function interpretBroadcast(res, signedTxid) {
    const j = (res && res.json) || {};
    const err = j.error || {};
    if (res && res.ok) {
      const txid = j.txid || j.result || signedTxid;
      return {
        state: res.status === 200 ? 'accepted' : 'propagating', txid: txid, error: null,
        mismatch: txid !== signedTxid,
        message: res.status === 200 ? 'the network has it' : 'accepted by the node; propagation not yet confirmed',
      };
    }
    const msg = 'explorer /api/tx -> HTTP ' + (res ? res.status : '?') + ' '
      + (err.message || err.code || String((res && res.text) || '').slice(0, 160));
    if (!res || !res.status) {
      // No answer at all. The request may well have arrived; only the reply was
      // lost. vault-sweep prints "Nothing was sent" here, which it cannot know.
      return { state: 'unknown', txid: null, error: 'no answer from explorer /api/tx: ' + String((res && res.text) || '').slice(0, 160),
               message: 'UNKNOWN whether it was sent: the explorer did not answer. Re-sending the identical transaction is safe.' };
    }
    if (res && res.status === 502 && err.code === 'broadcast_outcome_unknown') {
      return { state: 'unknown', txid: null, error: msg, message: 'UNKNOWN whether it was sent. This is not a rejection: re-sending the identical transaction is safe.' };
    }
    if (res && (res.status === 503 || res.status === 429)) {
      return { state: 'unavailable', txid: null, error: msg, message: 'the explorer is not broadcasting right now; nothing was sent' };
    }
    return { state: 'rejected', txid: null, error: msg, message: 'the node refused it; nothing was sent' };
  }

  // ── the wPCN reserve, counted the way wrapdesk.pc.am/proof counts it ───────
  /** reserveBalance() in contrib/wpcn/wrapdesk-server.mjs sums, per address,
   *  balance.confirmed.onchain_unspent_sat over the MAIN address plus every
   *  deposit address in requests.json -- as a list, so an address listed twice
   *  counts twice. This returns that figure now and after the plan confirms,
   *  and a conservative figure that also removes outputs another transaction
   *  in the mempool is already spending. The move is refused unless BOTH stay
   *  at or above the 50,000 wPCN issued.
   *
   *  rows: Map address -> { onchain_unspent_sat, pending_spend_sat } */
  function reserveAfter(plan, main, deposits, rows) {
    const counted = [main].concat(deposits.filter((a) => a && a !== main));
    const unique = Array.from(new Set(counted));
    const delta = new Map(unique.map((a) => [a, 0]));
    let takes = 0, returns = 0;
    for (const u of plan.chosen) if (delta.has(u.address)) { delta.set(u.address, delta.get(u.address) - u.value); takes += u.value; }
    for (const x of plan.outs) if (delta.has(x.address)) { delta.set(x.address, delta.get(x.address) + x.value); returns += x.value; }
    let now = 0, after = 0, safeAfter = 0, pending = 0;
    for (const a of unique) {
      const r = rows.get(a);
      if (!r || typeof r.onchain_unspent_sat !== 'number') throw unknown('the reserve balance of ' + a + ' could not be read');
      if (typeof r.pending_spend_sat !== 'number') throw unknown('whether ' + a + ' is already being spent could not be read (the explorer cannot see the mempool)');
      pending += r.pending_spend_sat;
      safeAfter += r.onchain_unspent_sat - r.pending_spend_sat + delta.get(a);
    }
    for (const a of counted) {
      now += rows.get(a).onchain_unspent_sat;
      after += rows.get(a).onchain_unspent_sat + delta.get(a);
    }
    const floor = Math.min(after, safeAfter);
    return {
      main: main, addressesCounted: counted.length, addressesUnique: unique.length,
      now: now, after: after, safeAfter: safeAfter, pending: pending, takes: takes, returns: returns,
      issued: WPCN_ISSUED_SAT, ok: floor >= WPCN_ISSUED_SAT, floor: floor,
    };
  }

  /** Read the list the proof page counts from the panel, check its main address
   *  IS this wallet's #0, read every balance, and count. */
  async function reserveCheck(net, plan, exclusive) {
    const ex = exclusive || ((fn) => fn());
    const r = await ex(() => net.reserve());
    if (!r || r.ok !== true) throw unknown((r && r.error) || 'the panel could not list the reserve addresses');
    let main;
    try { main = canonicalAddress(String(r.main)); } catch (e) { throw unknown('the panel’s main reserve address is not a valid address'); }
    const addr0 = address0(plan.xpub);
    if (main !== addr0) {
      throw refuse('the panel counts the main reserve as ' + main + ', but this wallet’s address #0 is ' + addr0
        + '. They must be the same wallet; nothing can be checked until they are.');
    }
    const deposits = Array.isArray(r.deposits) ? r.deposits.filter((a) => typeof a === 'string') : [];
    const unique = Array.from(new Set([main].concat(deposits)));
    const rows = new Map();
    for (let i = 0; i < unique.length; i += BULK) {
      const res = await ex(() => net.addresses(unique.slice(i, i + BULK)));
      checkFresh(res, 'counting the reserve');
      for (const row of (res.addresses || [])) {
        const c = (row && row.balance && row.balance.confirmed) || {};
        rows.set(row.address, { onchain_unspent_sat: c.onchain_unspent_sat, pending_spend_sat: c.pending_spend_sat });
      }
    }
    return reserveAfter(plan, main, deposits, rows);
  }

  /** Everything between "Preview" and the passphrase, in one place, so the
   *  page and the tests run the same code:
   *    vault-sweep's pre-scan refusals -> the scan -> the UTXOs -> the plan
   *    -> (wpcn-reserve) the reserve count -> the page's own refusals.
   *  Refusals found BEFORE a plan exists are thrown. One found AFTER is
   *  returned beside the plan, so the page can show the numbers it refused. */
  async function preparePlan(net, order, opt) {
    const o = opt || {};
    const ex = o.exclusive || ((fn) => fn());
    const say = o.onProgress || function () {};
    precheck(order);
    const got = await ex(async () => {
      const used = await findUsed(net, order.xpub, {
        onDerive: (d, t) => say('derive', d, t),
        onProgress: (d, t) => say('scan', d, t),
      });
      say('utxos', 0, used.length);
      return { used: used, utxos: await collectUtxos(net, used) };
    });
    const plan = planTransaction(Object.assign({}, order, { used: got.used, utxos: got.utxos }));
    let reserve = null, refusal = null;
    try {
      const ctx = { railOf: o.railOf, railAck: Boolean(order.railAck) };
      if (plan.system === 'wpcn-reserve') {
        say('reserve', 0, 0);
        reserve = await reserveCheck(net, plan, ex);
        ctx.reserveMain = reserve.main;
      }
      if (plan.system === 'exchange') {
        const d = await deriveBranches(plan.xpub, SCAN_TO);
        ctx.exchangeAddresses = new Set(d.receive.concat(d.change));
      }
      pageGuards(plan, ctx);
      if (reserve && !reserve.ok) {
        throw refuse('this would leave the reserve at ' + sat(reserve.floor) + ' PCN, below the '
          + sat(reserve.issued) + ' wPCN issued. Only the surplus above 50,000 may leave.');
      }
    } catch (e) {
      if (!(e instanceof Refusal)) throw e;
      refusal = e;
    }
    return { used: got.used, utxos: got.utxos, plan: plan, reserve: reserve, refusal: refusal };
  }

  // ── signing (vault-sweep: sighash, derSig, buildAndSign) ───────────────────
  /** BIP143. The bytes a P2WPKH input actually commits to. */
  function sighash(tx, i, scriptCode, amountSat, opts) {
    const op = opts || {};
    const version = op.version ?? 2;
    const locktime = op.locktime ?? 0;
    const seqOf = (n) => (tx.ins[n].sequence ?? SEQUENCE);
    const prevouts = concatList(tx.ins.map((x) => concat(reversed(fromHex(x.txid)), u32(x.vout))));
    const seqs = concatList(tx.ins.map((_, n) => u32(seqOf(n))));
    const outs = concatList(tx.outs.map((x) => concat(u64(x.value), varint(x.script.length), x.script)));
    const inp = tx.ins[i];
    return hash256(concat(
      u32(version),
      hash256(prevouts),
      hash256(seqs),
      reversed(fromHex(inp.txid)), u32(inp.vout),
      varint(scriptCode.length), scriptCode,
      u64(amountSat),
      u32(seqOf(i)),
      hash256(outs),
      u32(locktime),
      u32(1)                          // SIGHASH_ALL
    ));
  }

  /** A 64-byte compact (r||s) signature as DER. Same two rules as vault-sweep:
   *  a high top bit gains a 0x00, and surplus leading zeros are stripped. */
  function derSig(compact) {
    const trim = (b) => {
      let i = 0;
      while (i < b.length - 1 && b[i] === 0) i++;
      const v = b.subarray(i);
      return (v[0] & 0x80) ? concat(Uint8Array.of(0), v) : Uint8Array.from(v);
    };
    const r = trim(Uint8Array.from(compact.subarray(0, 32)));
    const s = trim(Uint8Array.from(compact.subarray(32, 64)));
    const body = concat(Uint8Array.of(0x02, r.length), r, Uint8Array.of(0x02, s.length), s);
    return concat(Uint8Array.of(0x30, body.length), body);
  }

  function buildAndSign(tx, keyFor) {
    const witnesses = tx.ins.map((inp, i) => {
      const k = keyFor(inp);
      const code = concat(Uint8Array.of(0x76, 0xa9, 0x14), hash160(k.pub), Uint8Array.of(0x88, 0xac));
      const h = sighash(tx, i, code, inp.value);
      // lowS: relay policy. prehash:false is LOAD-BEARING: without it the
      // library signs sha256(sighash), which verifies against itself and is
      // rejected by every node (NULLFAIL). Both sign and verify must be told.
      const compact = C.secp256k1.sign(h, k.priv, { lowS: true, prehash: false });
      if (!C.secp256k1.verify(compact, h, k.pub, { prehash: false })) {
        throw new Error('input ' + i + ': signature failed self-verification');
      }
      return [concat(derSig(compact), Uint8Array.of(0x01)), Uint8Array.from(k.pub)];
    });
    const body = concat(
      u32(2),
      varint(tx.ins.length),
      concatList(tx.ins.map((x) => concat(reversed(fromHex(x.txid)), u32(x.vout), Uint8Array.of(0x00), u32(SEQUENCE)))),
      varint(tx.outs.length),
      concatList(tx.outs.map((x) => concat(u64(x.value), varint(x.script.length), x.script)))
    );
    const wit = concatList(witnesses.map((w) => concat(varint(w.length), concatList(w.map((x) => concat(varint(x.length), x))))));
    const full = concat(u32(2), Uint8Array.of(0x00, 0x01), body.subarray(4), wit, u32(0));
    const stripped = concat(body, u32(0));
    return { hex: toHex(full), txid: toHex(reversed(hash256(stripped))), vsize: Math.ceil((stripped.length * 3 + full.length) / 4) };
  }

  /** m/84'/9444'/0' one step at a time, so each intermediate private key can be
   *  wiped. Equal to master.derive(ACCOUNT_PATH), which the tests assert. */
  function deriveAccount(master, wipeLater) {
    const a = master.deriveChild(84 + HARDENED); wipeLater.push(a);
    const b = a.deriveChild(9444 + HARDENED); wipeLater.push(b);
    const acct = b.deriveChild(0 + HARDENED); wipeLater.push(acct);
    return acct;
  }

  function checkBlob(blob) {
    if (!blob || typeof blob !== 'object' || Array.isArray(blob)) throw refuse('that seed file is not a vault blob');
    if (blob.chain && blob.chain !== 'pcn') throw refuse('that seed file is for the ' + blob.chain + ' chain, not PCN');
    if ((blob.kdf || 'scrypt') !== 'scrypt') throw refuse('that seed file uses ' + blob.kdf + ', not scrypt');
    const N = blob.N ?? SCRYPT.N, r = blob.r ?? SCRYPT.r, p = blob.p ?? SCRYPT.p;
    // STRICTER: vault-sweep hands any N/r/p to scrypt and relies on maxmem.
    // A blob asking for more than the vault ever used is refused by name.
    if (!Number.isInteger(N) || N < 2 || (N & (N - 1)) !== 0 || N > (1 << 18)) throw refuse('that seed file asks for an unusual scrypt N (' + N + ')');
    if (!Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 16) throw refuse('that seed file asks for unusual scrypt r/p');
    // THE FIELD IS `ct`, NOT `ciphertext` (vault-sweep's decrypt()).
    const ct = blob.ct ?? blob.ciphertext;
    if (!ct) throw refuse('this vault file has no ciphertext field (expected `ct`)');
    let out;
    try {
      out = { N: N, r: r, p: p, salt: fromB64(blob.salt), iv: fromB64(blob.iv), tag: fromB64(blob.tag), ct: fromB64(ct) };
    } catch (e) { throw refuse('that seed file has a field that is not base64'); }
    if (out.tag.length !== 16) throw refuse('that seed file has a ' + out.tag.length + '-byte GCM tag; the vault writes 16');
    if (out.iv.length < 12 || !out.salt.length || !out.ct.length) throw refuse('that seed file is missing its salt, iv or ciphertext');
    return out;
  }

  /** Open a vault blob: scrypt with the blob's own N/r/p (vault-sweep reads
   *  them from the blob, not from a constant, so a future cost change cannot
   *  lock old vaults), then AES-256-GCM through the browser's own WebCrypto.
   *  Returns the plaintext BYTES, which the caller must zero. The derived key
   *  is zeroed here. GCM authenticates, so a wrong passphrase is refused rather
   *  than decrypting to plausible rubbish. */
  async function openBlob(blobText, pass, onProgress) {
    let blob;
    try { blob = checkBlob(JSON.parse(blobText)); }
    catch (e) { if (e instanceof Refusal) throw e; throw refuse('that seed file is not valid JSON'); }
    let key = null;
    try {
      key = await C.scryptAsync(pass, blob.salt, { N: blob.N, r: blob.r, p: blob.p, dkLen: SCRYPT.keylen,
                                                   maxmem: SCRYPT.maxmem, onProgress: onProgress });
      const aes = await root.crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['decrypt']);
      key.fill(0); key = null;
      try {
        return new Uint8Array(await root.crypto.subtle.decrypt({ name: 'AES-GCM', iv: blob.iv, tagLength: 128 }, aes, concat(blob.ct, blob.tag)));
      } catch (e) {
        throw refuse('that passphrase does not open this vault file');
      }
    } finally {
      if (key) key.fill(0);
    }
  }

  /** THE ONLY FUNCTION THAT SEES A SECRET.
   *
   *  In:  the plan the owner previewed; the xpub text the coins were found
   *       with; readSeedText(), called now and only now; the passphrase.
   *  Out: { hex, txid, vsize } -- public -- or a Refusal.
   *
   *  Order is vault-sweep's: decrypt, validate the phrase, derive the account,
   *  compare its xpub CHARACTER FOR CHARACTER with the xpub file, and only then
   *  sign. A passphrase that opens the blob proves only that it fits the blob. */
  async function signPlan(plan, args) {
    const a = args || {};
    const want = parseXpub(a.xpubText, 'the xpub file');
    if (!plan || plan.xpub !== want) throw refuse('this preview was built from a different xpub; preview again');
    const wipe = [];                 // HDKeys holding private keys
    let pass = null, pt = null, seed = null, mnemonic = null;
    try {
      pass = te.encode(String(a.passphrase == null ? '' : a.passphrase));
      a.passphrase = null;           // the caller's reference to the string, dropped now
      if (!pass.length) throw refuse('no passphrase given');
      // The seed file is read from disk HERE, at the moment of signing.
      let text = await a.readSeedText();
      pt = await openBlob(text, pass, a.onProgress);
      text = null;
      pass.fill(0); pass = null;
      mnemonic = new TextDecoder('utf-8').decode(pt).trim();
      pt.fill(0); pt = null;
      if (!C.validateMnemonic(mnemonic, C.wordlist)) throw refuse('the decrypted text is not a valid recovery phrase');
      seed = C.mnemonicToSeedSync(mnemonic);
      mnemonic = null;
      const master = C.HDKey.fromMasterSeed(seed); wipe.push(master);
      seed.fill(0); seed = null;
      const account = deriveAccount(master, wipe);

      // THE CHECK. The derived xpub must equal the file, character for character.
      if (account.publicExtendedKey !== want) {
        throw refuse('the phrase in that file does NOT derive the xpub these coins were found with.\n'
          + 'Nothing has been signed. Check you picked the right wallet.');
      }

      const keyFor = (inp) => {
        const br = account.deriveChild(inp.branch); wipe.push(br);
        const child = br.deriveChild(inp.index); wipe.push(child);
        // STRICTER: the key must own the address the coins were found at.
        if (addressOf(child.publicKey) !== inp.address) {
          throw refuse('the key at branch ' + inp.branch + ' index ' + inp.index + ' does not own ' + inp.address);
        }
        return { priv: child.privateKey, pub: child.publicKey };
      };
      const signed = buildAndSign(plan.tx, keyFor);
      return { hex: signed.hex, txid: signed.txid, vsize: signed.vsize };
    } finally {
      for (const k of wipe) { try { k.wipePrivateData(); } catch (e) { /* already wiped */ } }
      if (pass) pass.fill(0);
      if (pt) pt.fill(0);
      if (seed) seed.fill(0);
      pass = pt = seed = mnemonic = null;
    }
  }

  // ── what the page shows and what it saves ─────────────────────────────────
  /** The preview, laid out as vault-sweep prints it, so the owner reads the
   *  same shape he reads in his terminal. */
  function previewText(plan, explorerLabel) {
    const L = [];
    L.push('  system      : ' + plan.system);
    L.push('  destination : ' + plan.to);
    L.push('  explorer    : ' + (explorerLabel || 'this page’s own origin'));
    L.push('');
    L.push('  found       : ' + plan.utxoCount + ' unspent output(s) across ' + plan.usedCount + ' address(es)');
    L.push('  available   : ' + sat(plan.available) + ' PCN');
    L.push('');
    L.push('  ──────────────────────────────────────────────────────────────');
    L.push('   SEND        ' + sat(plan.sending) + ' PCN');
    L.push('   TO          ' + plan.to);
    L.push('   from        ' + plan.system + '  (' + plan.chosen.length + ' input(s))');
    L.push('   fee         ' + sat(plan.fee) + ' PCN  (' + plan.feeRate + ' sat/vB)');
    if (plan.changeOut) L.push('   change      ' + sat(plan.changeOut.value) + ' PCN back to ' + plan.changeOut.address);
    L.push('  ──────────────────────────────────────────────────────────────');
    return L.join('\n');
  }

  /** The receipt vault-sweep writes, field for field. Never a secret. */
  function receipt(plan, signed, result) {
    const r = result || {};
    const at = new Date().toISOString();
    return {
      name: 'sweep-' + plan.system + '-' + at.replace(/[:.]/g, '-') + '.json',
      body: {
        at: at,
        system: plan.system, to: plan.to,
        sent_pcn: sat(plan.sending),
        fee_pcn: sat(plan.fee),
        change_pcn: plan.changeOut ? sat(plan.changeOut.value) : '0.00000000',
        inputs: plan.chosen.length,
        txid: r.txid || signed.txid,
        broadcast: Boolean(r.txid),
        error: r.error || null,
        raw_hex: signed.hex,
      },
    };
  }

  /** "12.5" -> 1250000000. Digits and at most 8 decimals, nothing else; and it
   *  must agree with vault-sweep's Math.round(Number(x) * 1e8) or it is refused. */
  function parseAmount(text) {
    const s = String(text == null ? '' : text).trim();
    const q = quote(s, /^[0-9.,eE+-]{0,24}$/);
    if (!/^\d{1,8}(\.\d{1,8})?$/.test(s)) throw refuse(q + ' is not a valid amount of PCN (digits, at most 8 decimals)');
    const parts = s.split('.');
    const exact = BigInt(parts[0]) * 100000000n + BigInt((parts[1] || '').padEnd(8, '0'));
    const vs = Math.round(Number(s) * 1e8);
    if (exact > BigInt(MAX_SAT) || BigInt(vs) !== exact) throw refuse(q + ' is not a valid amount of PCN');
    if (vs <= 0) throw refuse(q + ' is not a valid amount of PCN');
    return vs;
  }

  root.PCoinTransferCore = Object.freeze({
    HRP: HRP, ACCOUNT_PATH: ACCOUNT_PATH, SCAN_TO: SCAN_TO, BULK: BULK, FEE_RATE_DEFAULT: FEE_RATE_DEFAULT,
    DUST_SAT: DUST_SAT, CHANGE_MIN_SAT: CHANGE_MIN_SAT, WPCN_ISSUED_SAT: WPCN_ISSUED_SAT, NOT_A_RAIL: NOT_A_RAIL,
    Refusal: Refusal,
    sat: sat, toHex: toHex, fromHex: fromHex,
    addressOf: addressOf, decodeAddress: decodeAddress, canonicalAddress: canonicalAddress, isAddress: isAddress,
    parseXpub: parseXpub, address0: address0, ownChangeAddress: ownChangeAddress, deriveBranches: deriveBranches,
    makeNet: makeNet, parseSignedTx: parseSignedTx,
    findUsed: findUsed, collectUtxos: collectUtxos,
    vsizeFor: vsizeFor, precheck: precheck, planTransaction: planTransaction, pageGuards: pageGuards, railAddresses: railAddresses,
    makeRailOf: makeRailOf, railIndex: railIndex,
    reserveAfter: reserveAfter, reserveCheck: reserveCheck, preparePlan: preparePlan, interpretBroadcast: interpretBroadcast,
    sighash: sighash, derSig: derSig, buildAndSign: buildAndSign, deriveAccount: deriveAccount,
    checkBlob: checkBlob, openBlob: openBlob, signPlan: signPlan, previewText: previewText, receipt: receipt, parseAmount: parseAmount,
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
