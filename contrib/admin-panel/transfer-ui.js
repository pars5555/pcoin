/* ═══════════════════════════════════════════════════════════════════════════
 * transfer-ui.js -- the page half of the admin panel's "Move PCN".
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Wires the markup transfer.mjs renders to the signer in transfer-core.js.
 * It decides nothing about money: coin choice, fees, change, the guards and
 * the signing are all transfer-core.js, which the tests hold to vault-sweep.mjs.
 *
 * THREE RULES THIS FILE KEEPS, and transfer-test.mjs checks the first two by
 * reading it:
 *   1. It never talks to the network. Every request goes through the core's
 *      makeNet(), so `fetch`, XMLHttpRequest, sendBeacon, WebSocket, forms and
 *      navigation appear nowhere in this file.
 *   2. It never writes HTML as a string -- no innerHTML, no insertAdjacentHTML.
 *      Every node is built by el() below, which sets text as text and accepts
 *      only a short list of attributes.
 *   3. The passphrase box is read ONCE, in sign(), and emptied on the next line,
 *      before anything asynchronous happens. The string is handed to the core
 *      and the reference dropped. Nothing here stores it, and nothing but the
 *      folder handle and the folder's name is ever written to browser storage.
 */
(function () {
  'use strict';

  const root = document.getElementById('mv');
  if (!root) return;
  const $ = (id) => document.getElementById(id);
  const K = window.PCoinTransferCore;
  if (!K) {
    const s = $('mv-folder-status');
    if (s) { s.textContent = 'The signer did not load, so this page cannot do anything. Reload; if it persists, the scripts on the server are broken.'; s.className = 'bad'; }
    return;
  }

  const BASE = root.dataset.base || '';
  const net = K.makeNet({ origin: '', panelBase: BASE });   // '' = this origin, and only this origin

  // ── building DOM without HTML strings ─────────────────────────────────────
  const ATTRS = new Set(['class', 'id', 'title', 'href', 'target', 'rel', 'value', 'label', 'colspan', 'type', 'style']);
  function el(tag, attrs) {
    const n = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === 'disabled' || k === 'selected' || k === 'hidden') { n[k] = Boolean(v); continue; }
        if (!ATTRS.has(k)) throw new Error('el(): attribute "' + k + '" is not allowed');
        // A link may point at this site or at a local blob (the receipt), never
        // anywhere else -- and never at a javascript: URL.
        if (k === 'href' && !/^(\/[^/\\]|blob:)/.test(String(v))) throw new Error('el(): href must be same-origin or a blob');
        n.setAttribute(k, String(v));
      }
    }
    for (let i = 2; i < arguments.length; i++) {
      const kids = [].concat(arguments[i]);
      for (const c of kids) if (c !== null && c !== undefined && c !== false) n.append(c instanceof Node ? c : String(c));
    }
    return n;
  }
  const short = (a) => (a && a.length > 26 ? a.slice(0, 12) + '…' + a.slice(-8) : a || '');
  const last4 = (a) => '…' + String(a || '').slice(-4);
  const say = (id, text, cls) => { const n = $(id); if (!n) return; n.textContent = text || ''; if (cls !== undefined) n.className = cls; };

  function problem(e) {
    // REFUSED is a definite no; UNKNOWN means a read failed and nothing was
    // concluded. Different words because the next step is different.
    const unknownKind = e && e.kind === 'unknown';
    return el('div', { class: 'mv-box ' + (unknownKind ? 'mv-unknown' : 'mv-refused') },
      (unknownKind ? 'UNKNOWN — a read failed, so nothing was concluded:\n' : 'REFUSED: ')
      + String((e && e.message) || e));
  }
  function showProblem(id, e) { const t = $(id); t.replaceChildren(problem(e)); t.hidden = false; }
  function hideProblem(id) { const t = $(id); t.replaceChildren(); t.hidden = true; }

  // ── browser storage: the folder handle, and its name ──────────────────────
  // IndexedDB holds the FileSystemDirectoryHandle so a later visit needs only a
  // permission click. It is a pointer to the folder, not a copy of anything in
  // it. Beside it, in a SEPARATE store, the folder's name as plain text. Nothing
  // else this page handles is ever stored.
  //
  // WHY THE NAME IS KEPT SEPARATELY, AND THE HANDLE IS READ ONLY ON A CLICK.
  // Reading a stored folder handle back out of IndexedDB in an off-the-record
  // window (InPrivate) froze the whole browser in testing (Edge 153: the page
  // and the browser's DevTools endpoint stopped answering). So opening or
  // reloading this page reads only the name, to label the Reconnect button;
  // the handle is deserialised when the owner presses Reconnect and not before.
  // Merely visiting the page can therefore never trigger that freeze.
  const DB = 'pcoin-move-pcn', HANDLES = 'handle', NAMES = 'name', FOLDER_KEY = 'vault-folder';
  function idb(stores, mode, op) {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open(DB, 1);
      open.onupgradeneeded = () => { open.result.createObjectStore(HANDLES); open.result.createObjectStore(NAMES); };
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction(stores, mode);
        const req = op(tx);
        tx.oncomplete = () => { db.close(); resolve(req ? req.result : undefined); };
        tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
      };
    });
  }
  const rememberFolder = (handle) => idb([HANDLES, NAMES], 'readwrite', (tx) => {
    tx.objectStore(HANDLES).put(handle, FOLDER_KEY);
    tx.objectStore(NAMES).put(String(handle.name), FOLDER_KEY);
  });
  const recallFolderName = () => idb([NAMES], 'readonly', (tx) => tx.objectStore(NAMES).get(FOLDER_KEY));
  const recallFolderHandle = () => idb([HANDLES], 'readonly', (tx) => tx.objectStore(HANDLES).get(FOLDER_KEY));
  const forgetFolder = () => idb([HANDLES, NAMES], 'readwrite', (tx) => {
    tx.objectStore(HANDLES).delete(FOLDER_KEY);
    tx.objectStore(NAMES).delete(FOLDER_KEY);
  });

  // ── state ─────────────────────────────────────────────────────────────────
  const S = {
    gen: 0,                     // bumped on every folder load; stale work checks it
    wallets: new Map(),         // name -> wallet
    folder: null,               // the directory handle, when a folder was picked
    dests: { state: 'loading', list: [], invalid: [], error: null },
    plan: null, signed: null, result: null,
    busy: false,
    queue: Promise.resolve(),   // explorer reads run one at a time
  };
  // One reader at a time. The background balance scan queues a wallet at a
  // time, so a Preview waits for at most the wallet being read, not for all.
  function enqueue(fn) {
    const p = S.queue.then(fn, fn);
    S.queue = p.catch(() => {});
    return p;
  }

  // ── step 1: the vault folder ──────────────────────────────────────────────
  const NAME_OK = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

  async function loadEntries(entries, label) {
    const gen = ++S.gen;
    invalidate();
    const xpubs = new Map(), seeds = new Map();
    for (const e of entries) {
      let m = /^(.+)-xpub\.txt$/.exec(e.name);
      if (m && NAME_OK.test(m[1])) { xpubs.set(m[1], e); continue; }
      m = /^(.+)-seed\.enc\.json$/.exec(e.name);
      if (m && NAME_OK.test(m[1])) seeds.set(m[1], e);
    }
    const notes = [];
    const wallets = new Map();
    for (const name of Array.from(xpubs.keys()).sort()) {
      let xpub;
      try { xpub = K.parseXpub(await (await xpubs.get(name).file()).text(), name + '-xpub.txt'); }
      catch (e) { notes.push((e && e.message) || String(e)); continue; }
      const seed = seeds.get(name);
      wallets.set(name, {
        name: name, xpub: xpub, addr0: K.address0(xpub),
        // The seed file is NOT read here. This is a function the signer calls
        // at the moment of signing, which reads it from disk then.
        readSeed: seed ? async () => (await seed.file()).text() : null,
        bal: { state: seed ? 'waiting' : 'none' },
        rail: null,             // address -> {branch, index}, once derived
      });
    }
    for (const name of seeds.keys()) {
      if (!xpubs.has(name)) notes.push(name + '-seed.enc.json has no ' + name + '-xpub.txt beside it, so it is not used here.');
    }
    if (gen !== S.gen) return;
    S.wallets = wallets;
    const signable = Array.from(wallets.values()).filter((w) => w.readSeed).length;
    say('mv-folder-status', 'Read ' + label + ': ' + wallets.size + ' wallet(s), ' + signable
      + ' of them with a seed file. Balances are being read off the chain now, one wallet at a time.', 'mv-progress');
    renderWallets(notes);
    fillSelects();
    $('mv-s2').hidden = !wallets.size;
    onFormChange();
    backgroundScan(gen);
  }

  async function loadFromFolder(handle) {
    const entries = [];
    for await (const [name, entry] of handle.entries()) {
      if (entry.kind === 'file') entries.push({ name: name, file: () => entry.getFile() });
    }
    S.folder = handle;
    $('mv-forget').hidden = false;
    $('mv-reconnect').hidden = true;
    await loadEntries(entries, 'the folder “' + handle.name + '”');
  }

  async function pickFolder() {
    let handle;
    try { handle = await window.showDirectoryPicker({ id: 'pcoin-vault', mode: 'read' }); }
    catch (e) { if (e && e.name === 'AbortError') return; say('mv-folder-status', 'Could not open that folder: ' + ((e && e.message) || e), 'bad'); return; }
    try { await rememberFolder(handle); } catch (e) { /* remembering is a convenience, not a requirement */ }
    try { await loadFromFolder(handle); } catch (e) { say('mv-folder-status', 'Could not read that folder: ' + ((e && e.message) || e), 'bad'); }
  }

  // The handle is read here, on the owner's click, and nowhere else (see the
  // note at idb() above). The click is also the user activation the browser
  // needs before it may show its "let this site read the folder" prompt.
  async function reconnect() {
    let h = null;
    try { h = await recallFolderHandle(); } catch (e) { /* treated as nothing remembered */ }
    if (!h || typeof h.queryPermission !== 'function') {
      say('mv-folder-status', 'This browser no longer holds that folder. Choose it again.', 'warn');
      $('mv-reconnect').hidden = true;
      return;
    }
    let p = 'prompt';
    try { p = await h.queryPermission({ mode: 'read' }); } catch (e) { /* ask */ }
    if (p !== 'granted') {
      try { p = await h.requestPermission({ mode: 'read' }); } catch (e) { p = 'denied'; }
    }
    if (p !== 'granted') { say('mv-folder-status', 'Permission to read “' + h.name + '” was not given.', 'warn'); return; }
    try { await loadFromFolder(h); } catch (e) { say('mv-folder-status', 'Could not read that folder: ' + ((e && e.message) || e), 'bad'); }
  }

  async function forget() {
    try { await forgetFolder(); } catch (e) { /* nothing stored */ }
    S.folder = null;
    $('mv-forget').hidden = true; $('mv-reconnect').hidden = true;
    say('mv-folder-status', 'This browser no longer remembers the folder.', 'mv-progress');
  }

  function balText(w) {
    const b = w.bal || {};
    if (b.state === 'none') return 'destination only';
    if (b.state === 'waiting') return 'waiting to be read';
    if (b.state === 'scanning') return 'reading… ' + Math.round((b.pct || 0) * 100) + '%';
    if (b.state === 'ok') return K.sat(b.sat) + ' PCN';
    return 'UNKNOWN';
  }
  function fromLabel(w) {
    return w.name + ' — ' + balText(w) + ' — ' + last4(w.addr0);
  }

  function renderWallets(notes) {
    const rows = Array.from(S.wallets.values()).map((w) => el('tr', null,
      el('td', null, el('b', null, w.name)),
      el('td', null, el('code', { title: w.addr0 }, short(w.addr0))),
      el('td', null, w.readSeed ? 'yes' : el('span', { class: 'muted' }, 'no seed file — a destination only')),
      el('td', { id: 'mv-bal-' + w.name }, balCell(w))));
    const table = el('div', { style: 'overflow-x:auto' }, el('table', null,
      el('tr', null, el('th', null, 'Wallet'), el('th', null, 'Address #0'), el('th', null, 'Can sign here'),
        el('th', null, 'Spendable now')), rows));
    const out = [table];
    if (notes && notes.length) out.push(el('ul', { class: 'mv-list muted mv-small' }, notes.map((t) => el('li', null, t))));
    $('mv-wallets').replaceChildren.apply($('mv-wallets'), out);
  }
  function balCell(w) {
    const b = w.bal || {};
    if (b.state === 'ok') return el('span', null, el('b', null, K.sat(b.sat) + ' PCN'), el('span', { class: 'muted' }, '  ' + b.addrs + ' address(es)'));
    if (b.state === 'unknown' || b.state === 'error') return el('span', { class: 'warn', title: b.err || '' }, 'UNKNOWN — ' + (b.err || 'could not read'));
    return el('span', { class: 'muted' }, balText(w));
  }
  function updateWallet(w) {
    const cell = $('mv-bal-' + w.name);
    if (cell) cell.replaceChildren(balCell(w));
    const opt = Array.from($('mv-from').options).find((o) => o.value === w.name);
    if (opt) opt.textContent = fromLabel(w);
  }

  // Every wallet with a seed file, one at a time, on both branches 2000 deep
  // -- the same scan vault-sweep --list makes, because a shallower one reports
  // a used address beyond the cut-off as zero, and a wrong zero is worse than
  // a wait.
  function backgroundScan(gen) {
    const todo = Array.from(S.wallets.values()).filter((w) => w.readSeed);
    const next = () => {
      if (gen !== S.gen) return;
      // A preview in progress goes first; the balance list can wait for it.
      if (S.previewing) { setTimeout(next, 400); return; }
      const w = todo.shift();
      if (!w) { if (!S.busy) say('mv-folder-status', 'Every balance has been read.', 'mv-progress'); return; }
      enqueue(() => scanBalance(w, gen)).then(next, next);
    };
    next();
  }
  async function scanBalance(w, gen) {
    if (gen !== S.gen || (w.bal && w.bal.state === 'ok' && Date.now() - w.bal.at < 30000)) return;
    w.bal = { state: 'scanning', pct: 0 }; updateWallet(w);
    try {
      const used = await K.findUsed(net, w.xpub, {
        onDerive: (d, t) => { w.bal.pct = 0.6 * d / t; updateWallet(w); },
        onProgress: (d, t) => { w.bal.pct = 0.6 + 0.4 * d / t; updateWallet(w); },
      });
      w.bal = { state: 'ok', sat: used.reduce((s, a) => s + a.spendable, 0), addrs: used.length, at: Date.now() };
    } catch (e) {
      w.bal = { state: e && e.kind === 'unknown' ? 'unknown' : 'error', err: (e && e.message) || String(e) };
    }
    await attachRail(w);
    if (gen === S.gen) updateWallet(w);
  }

  // ── which addresses belong to a service that credits deposits ─────────────
  // Every vault wallet except wpcn-reserve (its #0 is the main reserve) and
  // market-hot (the float) is a rail, and a rail credits a payment to its
  // receive address to whichever customer holds that address. Its #0 is
  // usually a customer's (CLAUDE.md 8c). The exchange watches its change
  // branch too. Paying any of those needs an explicit tick.
  async function attachRail(w) {
    if (!w.rail && !K.NOT_A_RAIL.has(w.name)) w.rail = await K.railIndex(w.name, w.xpub);
  }
  async function ensureRails(onProgress) {
    const todo = Array.from(S.wallets.values()).filter((w) => !w.rail && !K.NOT_A_RAIL.has(w.name));
    let n = 0;
    for (const w of todo) { if (onProgress) onProgress(w.name, ++n, todo.length); await attachRail(w); }
  }
  const railOf = (address) => K.makeRailOf(Array.from(S.wallets.values()))(address);

  // ── named destinations, from the panel ────────────────────────────────────
  async function loadDestinations() {
    try {
      const d = await net.destinations();
      if (!d || d.ok !== true) throw new K.Refusal((d && d.error) || 'the panel could not read its destinations file', 'unknown');
      S.dests = {
        state: 'ok', configured: Boolean(d.configured), path: String(d.path || ''),
        list: (d.destinations || []).map((x) => ({ name: String(x.name), address: String(x.address), valid: K.isAddress(String(x.address)) })),
        invalid: (d.invalid || []).map((x) => ({ name: String(x.name) })),
      };
    } catch (e) {
      S.dests = { state: 'error', error: (e && e.message) || String(e), list: [], invalid: [] };
    }
    const n = $('mv-dest-note');
    if (S.dests.state === 'error') { n.textContent = 'Named destinations: UNKNOWN — ' + S.dests.error; n.className = 'mv-small warn'; }
    else if (!S.dests.configured) { n.textContent = 'No named destinations are configured (' + S.dests.path + ' does not exist).'; n.className = 'mv-small muted'; }
    else {
      const bad = S.dests.list.filter((x) => !x.valid).length + S.dests.invalid.length;
      n.textContent = S.dests.list.filter((x) => x.valid).length + ' named destination(s)'
        + (bad ? '; ' + bad + ' entr' + (bad === 1 ? 'y is' : 'ies are') + ' not a valid pc1q address and cannot be chosen.' : '.');
      n.className = 'mv-small ' + (bad ? 'warn' : 'muted');
    }
    if (S.wallets.size) fillSelects();
  }

  // ── step 2: the form ──────────────────────────────────────────────────────
  function fillSelects() {
    const from = $('mv-from');
    const keepFrom = from.value;
    from.replaceChildren(el('option', { value: '' }, '— choose a wallet —'));
    for (const w of S.wallets.values()) if (w.readSeed) from.append(el('option', { value: w.name }, fromLabel(w)));
    if (S.wallets.has(keepFrom) && S.wallets.get(keepFrom).readSeed) from.value = keepFrom;
    fillAddressSelect($('mv-to'), 'to');
    fillAddressSelect($('mv-change'), 'change');
    applyFromDefaults(false);
  }
  function fillAddressSelect(sel, kind) {
    const keep = sel.value;
    sel.replaceChildren();
    if (kind === 'to') {
      sel.append(el('option', { value: '' }, '— choose where the PCN goes —'));
    } else {
      sel.append(el('option', { value: '' }, '— choose where the change goes —'));
      sel.append(el('option', { value: 'own' }, 'this wallet’s own change address (m/84\'/9444\'/0\'/1/0) — vault-sweep’s default'));
    }
    const g1 = el('optgroup', { label: 'Vault wallets — receive address #0' });
    for (const w of S.wallets.values()) g1.append(el('option', { value: 'vault:' + w.name }, w.name + ' ' + last4(w.addr0)));
    sel.append(g1);
    if (S.dests.list.length || S.dests.invalid.length) {
      const g2 = el('optgroup', { label: 'Named destinations' });
      S.dests.list.forEach((d, i) => g2.append(el('option', { value: 'named:' + i, disabled: !d.valid },
        d.name + (d.valid ? ' ' + last4(d.address) : ' — not a valid pc1q address'))));
      S.dests.invalid.forEach((d) => g2.append(el('option', { value: 'bad', disabled: true }, d.name + ' — not a valid pc1q address')));
      sel.append(g2);
    }
    sel.append(el('option', { value: 'custom' }, 'Custom address…'));
    const opts = Array.from(sel.options);
    sel.value = opts.some((o) => o.value === keep && !o.disabled) ? keep : (kind === 'to' ? '' : 'own');
  }
  // Where change goes by default, per wallet. wpcn-reserve: the MAIN reserve
  // address, the only place the proof page can see it. exchange: nowhere until
  // chosen, because its own change branch is watched. Everything else:
  // vault-sweep's default, the wallet's own m/.../1/0.
  //
  // A new From wallet RESETS the choice. A change address picked for the
  // previous wallet -- the reserve's main address, say -- must never ride along
  // silently into a send from a different one.
  function applyFromDefaults(fromChanged) {
    const name = $('mv-from').value;
    const sel = $('mv-change');
    const own = Array.from(sel.options).find((o) => o.value === 'own');
    const special = name === 'wpcn-reserve' || name === 'exchange';
    if (own) own.disabled = special;
    const dflt = name === 'wpcn-reserve' ? (S.wallets.has('wpcn-reserve') ? 'vault:wpcn-reserve' : '')
      : name === 'exchange' ? '' : 'own';
    if (fromChanged || (special && sel.value === 'own') || (!special && sel.value === '')) sel.value = dflt;
    $('mv-change-custom').value = fromChanged ? '' : $('mv-change-custom').value;
  }

  /** A select's value -> a canonical pc1q address, or null. Never throws. */
  function resolve(value, customId) {
    let a = null;
    if (value.startsWith('vault:')) { const w = S.wallets.get(value.slice(6)); a = w ? w.addr0 : null; }
    else if (value.startsWith('named:')) { const d = S.dests.list[Number(value.slice(6))]; a = d && d.valid ? d.address : null; }
    else if (value === 'custom') a = $(customId).value.trim();
    if (!a) return null;
    try { return K.canonicalAddress(a); } catch (e) { return null; }
  }
  function resolveOrRefuse(value, customId, what) {
    if (!value) throw new K.Refusal('choose the ' + what);
    if (value === 'custom') {
      const raw = $(customId).value.trim();
      if (!raw) throw new K.Refusal('type the custom ' + what);
      return K.canonicalAddress(raw);             // throws vault-sweep's own refusal
    }
    const a = resolve(value, customId);
    if (!a) throw new K.Refusal('that ' + what + ' is not a usable address');
    return a;
  }
  function describe(id, value, customId, checkId) {
    // Show the WHOLE address that was chosen. "Read the whole thing, not just
    // the first six characters" is the check the vault page asks for.
    const out = $(id);
    if (value === 'custom') {
      const raw = $(customId).value.trim();
      const chk = $(checkId);
      if (!raw) { chk.textContent = ''; out.textContent = ''; return; }
      try { chk.textContent = '✓ valid pc1q address: ' + K.canonicalAddress(raw); chk.className = 'mv-small ok'; }
      catch (e) { chk.textContent = '✗ ' + e.message; chk.className = 'mv-small bad'; }
      out.textContent = '';
      return;
    }
    if (value === 'own') {
      const w = S.wallets.get($('mv-from').value);
      out.textContent = w ? '→ ' + K.ownChangeAddress(w.xpub) + '  (m/84\'/9444\'/0\'/1/0)' : '';
      return;
    }
    const a = value ? resolve(value, customId) : null;
    out.textContent = a ? '→ ' + a : '';
  }

  function onFormChange(ev) {
    if (S.busy) return;
    invalidate();
    if (ev && ev.target && ev.target.id === 'mv-from') applyFromDefaults(true);
    const all = $('mv-all').checked;
    $('mv-amount').disabled = all;
    $('mv-custom-wrap').hidden = $('mv-to').value !== 'custom';
    $('mv-change-row').hidden = all;
    $('mv-change-custom-wrap').hidden = all || $('mv-change').value !== 'custom';
    $('mv-consent-wrap').hidden = $('mv-from').value !== 'wpcn-reserve';
    describe('mv-to-full', $('mv-to').value, 'mv-custom', 'mv-custom-check');
    describe('mv-change-full', all ? '' : $('mv-change').value, 'mv-change-custom', 'mv-change-custom-check');
    updateRailAck();
  }
  function updateRailAck() {
    const flagged = [];
    const to = resolve($('mv-to').value, 'mv-custom');
    if (to) { const r = railOf(to); if (r) flagged.push(['destination', r]); }
    const cv = $('mv-change').value;
    if (!$('mv-all').checked && cv && cv !== 'own') {
      const ch = resolve(cv, 'mv-change-custom');
      if (ch) { const r = railOf(ch); if (r) flagged.push(['change', r]); }
    }
    $('mv-railack-wrap').hidden = !flagged.length;
    if (!flagged.length) { $('mv-railack').checked = false; return; }
    $('mv-railack-text').textContent = flagged.map((f) => 'The ' + f[0] + ' is ' + f[1].wallet + '’s '
      + (f[1].branch ? 'change' : 'receive') + ' address #' + f[1].index + '.').join(' ')
      + ' That service watches its addresses and may credit a payment there to whichever customer holds it. I mean to send there anyway.';
  }

  // Anything that changes the question throws away the answer: the preview,
  // the signature and the broadcast result all belong to one exact form.
  function invalidate() {
    S.plan = null; S.signed = null; S.result = null;
    $('mv-s3').hidden = true; $('mv-s4').hidden = true; $('mv-s5').hidden = true;
    $('mv-pass').value = '';
    hideProblem('mv-refusal'); hideProblem('mv-sign-refusal');
    $('mv-signed').hidden = true; $('mv-signed').replaceChildren();
    $('mv-result').replaceChildren(); $('mv-receipt').hidden = true;
    $('mv-broadcast').disabled = false;
    $('mv-reserve').replaceChildren();
  }

  // ── step 3: preview ───────────────────────────────────────────────────────
  async function preview() {
    if (S.busy) return;
    invalidate();
    const gen = S.gen;
    const btn = $('mv-preview');
    btn.disabled = true;
    S.previewing = true;
    const progress = (t) => say('mv-preview-progress', t);
    try {
      const w = S.wallets.get($('mv-from').value);
      if (!w || !w.readSeed) throw new K.Refusal('choose a wallet to move from');
      const to = resolveOrRefuse($('mv-to').value, 'mv-custom', 'destination');
      const sendAll = $('mv-all').checked;
      const amountText = $('mv-amount').value;
      const amountSat = sendAll ? null : K.parseAmount(amountText);
      let changeTo = null;
      if (!sendAll) {
        const cv = $('mv-change').value;
        if (cv === '' && w.name !== 'exchange') throw new K.Refusal('choose where the change goes');
        if (cv && cv !== 'own') changeTo = resolveOrRefuse(cv, 'mv-change-custom', 'change address');
      }
      const order = {
        system: w.name, xpub: w.xpub, to: to, sendAll: sendAll, amountSat: amountSat, amountText: amountText,
        changeTo: changeTo, feeRate: Number($('mv-fee').value), reserveConsent: $('mv-consent').checked,
        railAck: $('mv-railack').checked,
      };
      // vault-sweep refuses these before it reads anything; so does this page.
      K.precheck(order);
      await ensureRails((name, i, n) => progress('checking the addresses against every vault wallet (' + name + ', ' + i + '/' + n + ')…'));
      updateRailAck();
      order.railAck = $('mv-railack').checked;

      // The scan, the plan, the reserve count and every guard: transfer-core.js,
      // the same function the tests run against vault-sweep.mjs.
      const r = await K.preparePlan(net, order, {
        railOf: railOf,
        exclusive: enqueue,
        onProgress: (stage, d, t) => progress(
          stage === 'derive' ? 'deriving ' + w.name + '’s addresses… ' + Math.round(100 * d / t) + '%'
          : stage === 'scan' ? 'reading ' + w.name + ' off the chain… ' + d + '/' + t + ' addresses'
          : stage === 'utxos' ? 'reading the unspent outputs of ' + t + ' address(es)…'
          : 'counting the reserve the way wrapdesk.pc.am/proof counts it…'),
      });
      if (gen !== S.gen) return;
      w.bal = { state: 'ok', sat: r.used.reduce((s, a) => s + a.spendable, 0), addrs: r.used.length, at: Date.now() };
      updateWallet(w);
      renderPreview(r.plan);
      if (r.reserve) renderReserve(r.reserve);
      if (r.refusal) throw r.refusal;
      S.plan = r.plan;
      $('mv-s4').hidden = false;
      $('mv-pass').focus();
    } catch (e) {
      showProblem('mv-refusal', e);
    } finally {
      S.previewing = false;
      btn.disabled = false;
      progress('');
    }
  }

  function renderPreview(plan) {
    $('mv-preview-text').textContent = K.previewText(plan, location.origin);
    const rows = plan.chosen.map((u) => el('tr', null,
      el('td', null, el('code', { title: u.txid + ':' + u.vout }, short(u.txid) + ':' + u.vout)),
      el('td', null, el('code', { title: u.address }, short(u.address))),
      el('td', { class: 'muted' }, (u.branch ? 'change' : 'receive') + ' #' + u.index),
      el('td', null, K.sat(u.value))));
    $('mv-inputs').replaceChildren(el('table', null,
      el('tr', null, el('th', null, 'Output'), el('th', null, 'Address'), el('th', null, 'Path'), el('th', null, 'PCN')), rows));
    $('mv-s3').hidden = false;
  }

  function renderReserve(r) {
    const pct = (x) => (100 * x / r.issued).toFixed(4) + '%';
    const lines = [
      'wPCN reserve, counted as wrapdesk.pc.am/proof counts it',
      '(the main address + ' + (r.addressesCounted - 1) + ' deposit address(es) the wrap desk handed out)',
      '',
      '  now                ' + K.sat(r.now) + ' PCN',
      '  this move takes    ' + K.sat(r.takes) + ' PCN  (inputs from those addresses)',
      '  and puts back      ' + K.sat(r.returns) + ' PCN  (outputs to those addresses)',
      '  after              ' + K.sat(r.after) + ' PCN   = ' + pct(r.after) + ' of the 50,000 wPCN issued',
    ];
    if (r.pending) lines.push('  already leaving    ' + K.sat(r.pending) + ' PCN  (another transaction in the mempool; counted as gone)');
    if (r.addressesCounted !== r.addressesUnique) {
      lines.push('  note: the proof page lists ' + (r.addressesCounted - r.addressesUnique) + ' address(es) twice and counts them twice;');
      lines.push('        the check below uses each address once.');
    }
    lines.push('');
    lines.push(r.ok ? '  STAYS FULLY BACKED: the lower figure, ' + K.sat(r.floor) + ' PCN, is at or above 50,000.'
      : '  WOULD BE UNDER-BACKED: ' + K.sat(r.floor) + ' PCN is below 50,000. Refused.');
    $('mv-reserve').replaceChildren(el('div', { class: 'mv-box ' + (r.ok ? 'mv-good' : 'mv-refused') }, lines.join('\n')));
  }

  // ── step 4: sign ──────────────────────────────────────────────────────────
  function lockForm(on) {
    S.busy = on;
    for (const id of ['mv-from', 'mv-to', 'mv-custom', 'mv-amount', 'mv-all', 'mv-fee', 'mv-change', 'mv-change-custom',
      'mv-consent', 'mv-railack', 'mv-preview', 'mv-pick', 'mv-files', 'mv-reconnect', 'mv-forget', 'mv-pass', 'mv-sign']) {
      const n = $(id); if (n) n.disabled = on;
    }
    if (!on) $('mv-amount').disabled = $('mv-all').checked;
  }

  async function sign() {
    const plan = S.plan;
    if (!plan || S.signed || S.busy) return;
    const field = $('mv-pass');
    let passphrase = field.value;       // the ONE read of the box...
    field.value = '';                   // ...and it is empty again before anything else happens
    hideProblem('mv-sign-refusal');
    if (!passphrase) { showProblem('mv-sign-refusal', new K.Refusal('type the vault passphrase first')); return; }
    const w = S.wallets.get(plan.system);
    const args = {
      xpubText: w.xpub,
      readSeedText: w.readSeed,
      passphrase: passphrase,
      onProgress: (f) => say('mv-sign-progress', 'opening the vault file (scrypt)… ' + Math.round(f * 100) + '%'),
    };
    passphrase = null;
    lockForm(true);
    say('mv-sign-progress', 'reading the seed file from your disk…');
    try {
      const signed = await K.signPlan(plan, args);
      if (S.plan !== plan) return;
      S.signed = signed;
      renderSigned(plan, signed);
      $('mv-s5').hidden = false;
    } catch (e) {
      showProblem('mv-sign-refusal', e);
    } finally {
      args.passphrase = null;
      field.value = '';
      lockForm(false);
      say('mv-sign-progress', '');
    }
  }

  function renderSigned(plan, s) {
    const rate = (plan.fee / s.vsize).toFixed(2);
    const copy = el('button', { type: 'button', class: 'ghost' }, 'copy the raw transaction');
    copy.addEventListener('click', () => {
      navigator.clipboard.writeText(s.hex).then(() => { copy.textContent = 'copied'; setTimeout(() => { copy.textContent = 'copy the raw transaction'; }, 1400); });
    });
    $('mv-signed').replaceChildren(
      el('div', { class: 'mv-box mv-good' },
        'seed matches the xpub the coins were found with. ✓\n'
        + 'signed      : txid ' + s.txid + '\n'
        + 'size        : ' + s.vsize + ' vB, fee ' + K.sat(plan.fee) + ' PCN (' + rate + ' sat/vB)\n'
        + '\nNOT SENT. Nothing has been broadcast.'),
      el('p', { class: 'muted mv-small' }, 'The signed transaction. It holds signatures and public keys only — it is public the moment it is broadcast.'),
      el('pre', { class: 'mv-pre mv-hex', id: 'mv-hex' }, s.hex),
      el('div', { class: 'mv-row' }, copy));
    $('mv-signed').hidden = false;
  }

  // ── step 5: broadcast ─────────────────────────────────────────────────────
  async function broadcast() {
    const plan = S.plan, signed = S.signed;
    if (!plan || !signed || S.busy) return;
    const change = plan.changeOut ? '\nchange ' + K.sat(plan.changeOut.value) + ' PCN back to ' + plan.changeOut.address : '';
    if (!window.confirm('Broadcast ' + K.sat(plan.sending) + ' PCN to\n' + plan.to + '\n\nfrom ' + plan.system
      + ', fee ' + K.sat(plan.fee) + ' PCN' + change + '\n\nA transaction cannot be recalled.')) return;
    const btn = $('mv-broadcast');
    btn.disabled = true;
    lockForm(true);
    let res;
    try { res = await net.broadcast(signed.hex); }
    catch (e) { res = { ok: false, status: 0, json: null, text: (e && e.message) || String(e) }; }
    finally { lockForm(false); }
    if (S.signed !== signed) return;
    const out = K.interpretBroadcast(res, signed.txid);
    S.result = out;
    const kids = [];
    const cls = out.state === 'accepted' || out.state === 'propagating' ? 'mv-good' : out.state === 'unknown' ? 'mv-unknown' : 'mv-refused';
    kids.push(el('div', { class: 'mv-box ' + cls }, (out.state === 'accepted' || out.state === 'propagating' ? 'BROADCAST — ' : '')
      + out.message + (out.error ? '\n' + out.error : '')));
    const txid = out.txid || signed.txid;
    if (/^[0-9a-f]{64}$/.test(txid)) {
      kids.push(el('p', null, 'txid ', el('a', { href: '/tx/' + txid, target: '_blank', rel: 'noopener noreferrer' }, el('code', null, txid))));
    }
    if (out.mismatch) kids.push(el('div', { class: 'mv-box mv-refused' }, 'The explorer reports txid ' + out.txid + ', but this page signed ' + signed.txid + '. Stop and find out why before doing anything else.'));
    $('mv-result').replaceChildren.apply($('mv-result'), kids);
    $('mv-receipt').hidden = false;
    // A transaction the network has is not re-sent from here. Anything else
    // may be retried: re-sending the identical hex is idempotent.
    btn.disabled = out.state === 'accepted' || out.state === 'propagating';
  }

  function downloadReceipt() {
    if (!S.plan || !S.signed) return;
    const r = K.receipt(S.plan, S.signed, S.result);
    const url = URL.createObjectURL(new Blob([JSON.stringify(r.body, null, 2)], { type: 'application/json' }));
    const a = el('a', { href: url });
    a.download = r.name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // ── wiring ────────────────────────────────────────────────────────────────
  function init() {
    if (!window.isSecureContext || !window.crypto || !window.crypto.subtle) {
      say('mv-folder-status', 'This page needs a secure (https) context for the browser’s own AES-GCM. Nothing can be signed here.', 'bad');
      return;
    }
    if (typeof window.showDirectoryPicker !== 'function') {
      $('mv-pick').hidden = true;
      say('mv-files-label', 'This browser cannot open a folder. Pick the xpub and seed files themselves:');
    }
    $('mv-pick').addEventListener('click', pickFolder);
    $('mv-reconnect').addEventListener('click', reconnect);
    $('mv-forget').addEventListener('click', forget);
    $('mv-files').addEventListener('change', (e) => {
      const files = Array.from(e.target.files || []);
      if (files.length) loadEntries(files.map((f) => ({ name: f.name, file: async () => f })), files.length + ' file(s)')
        .catch((err) => say('mv-folder-status', 'Could not read those files: ' + ((err && err.message) || err), 'bad'));
    });
    for (const id of ['mv-from', 'mv-to', 'mv-custom', 'mv-amount', 'mv-all', 'mv-fee', 'mv-change', 'mv-change-custom', 'mv-consent', 'mv-railack']) {
      $(id).addEventListener('input', onFormChange);
      $(id).addEventListener('change', onFormChange);
    }
    $('mv-preview').addEventListener('click', preview);
    $('mv-sign').addEventListener('click', sign);
    $('mv-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sign(); } });
    $('mv-broadcast').addEventListener('click', broadcast);
    $('mv-receipt').addEventListener('click', downloadReceipt);

    loadDestinations();
    if (typeof window.showDirectoryPicker === 'function') {
      // The NAME only. The handle stays in storage until Reconnect is pressed.
      recallFolderName().then((name) => {
        if (typeof name !== 'string' || !name) return;
        const b = $('mv-reconnect');
        b.textContent = 'Reconnect to “' + name + '”';
        b.hidden = false;
        $('mv-forget').hidden = false;
        say('mv-folder-status', 'This browser remembers the folder “' + name + '”. Press Reconnect to read it again.', 'mv-progress');
      }).catch(() => { /* nothing remembered */ });
    }
  }

  window.addEventListener('unhandledrejection', (e) => say('mv-folder-status', 'Something failed: ' + ((e.reason && e.reason.message) || e.reason), 'bad'));
  init();
})();
