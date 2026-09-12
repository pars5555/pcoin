// The explorer API client.
//
// TWO THINGS SHAPE THIS FILE.
//
// 1. THE RATE LIMIT IS SHARED WITH THE iOS WALLET. Reads are 20/s, burst 60,
//    per client, and clients are keyed on the PEER ADDRESS of the socket --
//    X-Forwarded-For is honoured only with --trust-proxy, which the running
//    explorer does NOT have. So every request arriving through Caddy is keyed on
//    127.0.0.1 and shares ONE bucket, including POST /api/tx broadcasts from the
//    iOS wallet. A tick that bursts past 60 429s itself AND the wallet. Hence
//    the per-tick request budget, and hence 429 being treated as UNREADABLE
//    rather than as an answer.
//
// 2. UNKNOWN IS ITS OWN STATE. Every method here returns a discriminated
//    result -- { readable: true, ... } or { readable: false, reason } -- and
//    never a bare value that a caller could `?? 0` into a decision. A request
//    that threw resolves nothing; a 200 whose body says "no transactions" is a
//    real fact. Those are different and must stay different.

export class BudgetExhausted extends Error {
  constructor() {
    super('per-tick explorer request budget exhausted');
    this.name = 'BudgetExhausted';
  }
}

export class ExplorerClient {
  constructor(baseUrl, { budget = 40, timeoutMs = 20000, fetchImpl = fetch } = {}) {
    this.base = baseUrl.replace(/\/+$/, '');
    this.budgetTotal = budget;
    this.budgetLeft = budget;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.spent = 0;
    this.rateLimited = false;
  }

  get hostname() {
    return new URL(this.base).hostname.replace(/\.$/, '').toLowerCase();
  }

  resetBudget() {
    this.budgetLeft = this.budgetTotal;
    this.spent = 0;
    this.rateLimited = false;
  }

  async #request(path, { method = 'GET', body = null } = {}) {
    if (this.budgetLeft <= 0) throw new BudgetExhausted();
    this.budgetLeft--;
    this.spent++;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const init = { method, signal: ctrl.signal, headers: { accept: 'application/json' } };
      if (body !== null) {
        init.headers['content-type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      const res = await this.fetchImpl(`${this.base}${path}`, init);

      if (res.status === 429) {
        this.rateLimited = true;
        const retryAfter = Number(res.headers.get('retry-after'));
        let scope = null;
        try {
          const j = await res.json();
          scope = j?.error?.limit_scope ?? null;
        } catch { /* body shape unknown; the 429 is the fact */ }
        return {
          readable: false,
          reason: `rate limited (429)${scope ? ` scope=${scope}` : ''}`,
          retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : null,
          rateLimited: true,
        };
      }

      if (!res.ok) {
        return { readable: false, reason: `HTTP ${res.status}` };
      }

      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) {
        // HTML from a proxy, or an empty body. Not an answer.
        return { readable: false, reason: `non-JSON content-type ${JSON.stringify(ct.slice(0, 60))}` };
      }

      let json;
      try {
        json = await res.json();
      } catch (e) {
        return { readable: false, reason: `body did not decode: ${e.message}` };
      }
      return { readable: true, json };
    } catch (e) {
      if (e instanceof BudgetExhausted) throw e;
      return { readable: false, reason: `request failed: ${e.name === 'AbortError' ? 'timeout' : e.message}` };
    } finally {
      clearTimeout(timer);
    }
  }

  async status() {
    const r = await this.#request('/api/status');
    if (!r.readable) return r;
    return { readable: true, json: r.json, health: indexHealth(r.json) };
  }

  // POST rather than ?list=: a query string ends up in proxy logs linking every
  // address to every other, which is a customer ledger written by accident.
  // 500 is the documented cap; 413 over it.
  async addresses(addrs) {
    if (addrs.length === 0) return { readable: true, json: { addresses: [] } };
    if (addrs.length > 500) throw new Error('addresses(): batch over the 500 cap');
    return this.#request('/api/addresses', { method: 'POST', body: { addresses: addrs } });
  }

  // limit is CAPPED AT 200. limit=250 is rejected 400 bad_request, which
  // silently stops the watcher reading the chain at all.
  async addressTxs(addr, { limit = 200, cursor = null } = {}) {
    if (limit > 200) throw new Error('addressTxs(): limit over the 200 cap');
    const q = new URLSearchParams({ limit: String(limit) });
    // Prefer cursor over offset: an offset shifts under you when the chain
    // reorgs, so page 2 can skip or repeat rows.
    if (cursor) q.set('cursor', cursor);
    return this.#request(`/api/address/${encodeURIComponent(addr)}/txs?${q}`);
  }

  // The AUTHORITATIVE record for a transaction. is_coinbase lives here and NOT
  // in the address summary, and an ABSENT is_coinbase key is refused rather
  // than read as false -- a coinbase read as non-coinbase matures 100 blocks
  // early, which is a credit for money that can still evaporate.
  async tx(txid) {
    const r = await this.#request(`/api/tx/${encodeURIComponent(txid)}`);
    if (!r.readable) return r;
    const tx = r.json?.tx ?? null;
    if (!tx || typeof tx !== 'object') {
      return { readable: false, reason: 'tx body present but has no tx object' };
    }
    return { readable: true, tx, index: r.json.index ?? null };
  }
}

// THE INDEX HEALTH GATE. Three fields, and nothing else.
//
// NEVER blocks_unwound, NEVER reorg_count. They are CUMULATIVE LIFETIME
// counters: explorer.pc.am reads reorg_count: 1, blocks_unwound: 1 today and
// will never return to 0. Every one of the six existing rails gated on
// `blocks_unwound == 0`, one ordinary 1-block reorg at height 5801 set it to 1
// permanently, and every rail silently refused to credit any deposit for three
// and a half days while exiting clean each tick. docs.pc.am had taught the bad
// gate, which is why all six shared it -- one mistake, copied, not six.
//
// The three-field gate is not thin: index.stale already folds never-polled,
// blocks behind, poll age, indexer status in error|reorg|reindex|init, node IBD
// and zero peers. And it earns its keep -- explorer3.pc.am was observed
// returning stale:false, blocks_behind:0 with node_reachable:false. Two of
// three green and the gate still refuses.
export function indexHealth(statusJson) {
  const idx = statusJson?.index;
  if (!idx || typeof idx !== 'object') {
    return { healthy: false, reason: 'no index block in /api/status' };
  }
  if (idx.stale !== false) return { healthy: false, reason: `index.stale is ${JSON.stringify(idx.stale)}` };
  if (idx.node_reachable !== true) return { healthy: false, reason: `index.node_reachable is ${JSON.stringify(idx.node_reachable)}` };
  if (idx.blocks_behind !== 0) return { healthy: false, reason: `index.blocks_behind is ${JSON.stringify(idx.blocks_behind)}` };
  return {
    healthy: true,
    reason: null,
    indexedHeight: idx.indexed_height,
    nodeHeight: idx.node_height,
    // Carried for the CHANGE-based reorg signal. Never gated on directly.
    reorgCount: idx.reorg_count,
    blocksUnwound: idx.blocks_unwound,
  };
}

// D11: the corroborating source must be a DIFFERENT HOST.
//
// Compared by HOSTNAME, never by string. `HTTPS://`, `:443`, `//api` and a
// trailing dot all slip past a string compare and make the oracle corroborate
// itself -- at which point one outage is two failures and the check is
// decoration.
export function isIndependentHost(urlA, urlB) {
  const h = (u) => {
    try { return new URL(u).hostname.replace(/\.$/, '').toLowerCase(); }
    catch { return null; }
  };
  const a = h(urlA);
  const b = h(urlB);
  if (a === null || b === null) return { independent: false, reason: 'unparseable URL' };
  if (a === b) return { independent: false, reason: `same hostname ${a}` };
  return { independent: true, a, b };
}

// "Touched" is detected on lifetime.tx_count and lifetime.received_sat ONLY.
// Both are monotonic for a rail that never spends.
//
// DO NOT diff mature_sat or spendable_sat:
//   * a COINBASE deposit lands in immature_sat, not mature_sat/spendable_sat --
//     and a user can point `startmining "<addr>"` straight at a deposit address
//     with no wallet, so this is not hypothetical. Diffing the wrong field
//     makes a mined deposit invisible for 100 blocks with NO ROW EVER INSERTED,
//     so the stuck check has nothing to see;
//   * when the mempool cannot be observed the API returns spendable_sat: null
//     and pending_spend_sat: null, and (int)null == 0 is the exact `?? 0` shape
//     rule 3 warns about.
//
// `used` has THREE values: true, false and null. API.md calls null out
// precisely because "a scanner that reads false there stops early and loses the
// rest of the wallet".
//
// Anything unrecognised is TOUCHED (go and check it), never unchanged.
export function addressTouched(entry, previous) {
  if (!entry || typeof entry !== 'object') {
    return { touched: true, reason: 'entry missing or not an object' };
  }
  if (entry.used === null || entry.used === undefined) {
    return { touched: true, reason: 'used is null/absent (unknown, not false)' };
  }
  const lt = entry.lifetime;
  if (!lt || typeof lt !== 'object') {
    return { touched: true, reason: 'lifetime block absent' };
  }
  const txCount = lt.tx_count;
  const received = lt.received_sat;
  if (!Number.isInteger(txCount) || !Number.isInteger(received)) {
    return { touched: true, reason: 'lifetime.tx_count / received_sat absent or non-integer' };
  }
  if (!previous) return { touched: true, reason: 'no previous observation', txCount, received };
  if (txCount !== previous.txCount || received !== previous.received) {
    return { touched: true, reason: 'lifetime moved', txCount, received };
  }
  return { touched: false, txCount, received };
}
