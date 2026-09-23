// ═══════════════════════════════════════════════════════════════════════════
// MOVE PCN -- send PCN from one of the owner's vault wallets to another, or to
// a named address, signed INSIDE HIS BROWSER.
// ═══════════════════════════════════════════════════════════════════════════
//
// THIS PAGE IS THE DELIBERATE EXCEPTION TO vault.mjs
//
// vault.mjs, the "Vault commands" page, has no input element anywhere, and a
// test asserts it: every vault tool asks for the passphrase at a terminal
// prompt with echo off, which keeps it out of shell history, out of `ps` and
// out of any transcript, and a page offering a passphrase box would quietly
// undo that. That page is unchanged and its test still passes.
//
// This page does have a passphrase box, because the owner chose in-browser
// signing: a sweep should not have to begin with finding a terminal, a
// checkout and a command. The exception is made safe the only way it can be --
// by the passphrase never reaching a server -- and this file is written so
// that anybody reading it can see that it cannot:
//
//   * THE SERVER NEVER RECEIVES A SECRET. Every route here is GET-only and
//     never reads a request body; anything else is answered 405 before a byte
//     of the body is read. No route accepts the passphrase, the mnemonic, a
//     key, or a seed file, because no route accepts anything at all.
//   * THE VAULT FILES ARE READ BY THE BROWSER, FROM THE OWNER'S DISK. The page
//     opens his vault folder with the File System Access API (or a plain file
//     picker) and reads <system>-xpub.txt at once and <system>-seed.enc.json
//     only at the moment of signing. Neither is uploaded.
//   * THE BROWSER TALKS TO FIVE URLS, ALL ON THIS ORIGIN. transfer-core.js
//     makeNet() is the only code that calls fetch, and every value it can send
//     is checked to be a public pc1 address or a parsed signed transaction
//     before it goes. The Content-Security-Policy below (connect-src 'self',
//     form-action 'none') makes the browser enforce the same-origin half.
//   * THE SIGNING IS vault-sweep.mjs, NOT A REWRITE OF IT. transfer-core.js
//     mirrors it line for line, and transfer-test.mjs runs vault-sweep.mjs
//     itself on the same inputs and requires a byte-identical transaction.
//   * NOTHING IS BROADCAST WITHOUT A SECOND, SEPARATE CLICK, which asks again.
//
// What the server DOES send the page: the page itself, three scripts, the named
// destinations (a name -> pc1q address list the owner writes by hand), and the
// PUBLIC addresses the wrap desk counts as the wPCN reserve. It logs nothing
// about any of it beyond a failure to read one of those two files.
//
// THE REMEMBERED FOLDER. The browser keeps the folder's handle in IndexedDB so
// a later visit is one permission click. It is read back ONLY when the owner
// presses Reconnect -- opening the page reads just the folder's name -- because
// in testing, reading a stored handle back in an off-the-record (InPrivate)
// context froze Edge outright: the page and the browser's own DevTools port
// stopped answering. The page says to use the file picker in InPrivate.
//
// WHAT NO CODE HERE CAN REMOVE, said so it is decided rather than discovered:
//   * The panel shares its origin with the public explorer. Script running on
//     any explorer.pc.am page -- an XSS there, or something Cloudflare injects
//     under /cdn-cgi/ -- is same-origin with this page and could read it while
//     the owner types. SRI and the CSP stop other origins, not that. A separate
//     hostname for the panel is the fix, and it is not made here.
//   * JavaScript cannot erase a string. The passphrase as typed and the decrypted
//     phrase are dropped at the earliest point and left to the garbage collector;
//     every byte array holding key material is zeroed, strings cannot be.
//   * A browser may offer to save the passphrase however the box is marked.
//     The page asks the owner to choose Never.
//
// ───────────────────────────────────────────────────────────────────────────
// THE CRYPTO BUNDLE -- how to rebuild it, and the hash it must have
// ───────────────────────────────────────────────────────────────────────────
// transfer-crypto.bundle.js is @noble/hashes, @noble/curves, @scure/bip32,
// @scure/bip39 and @scure/base 2.3.0 -- the exact packages contrib/vault's
// lockfile pins for vault-sweep.mjs -- bundled by esbuild 0.28.0 from the
// ten-line entry file transfer-crypto.entry.mjs, NOT minified, so it can be
// read. Rebuild from THIS directory (the paths esbuild writes into its comments
// are relative to it, so another directory gives other bytes):
//
//   cd contrib/vault && npm ci && cd ../admin-panel
//   NODE_PATH=../vault/node_modules npx esbuild@0.28.0 transfer-crypto.entry.mjs \
//     --bundle --format=iife --global-name=PCoinCrypto --platform=browser \
//     --target=es2022 --charset=utf8 --legal-comments=inline \
//     --outfile=transfer-crypto.bundle.js
//
//   (PowerShell: $env:NODE_PATH='../vault/node_modules'; then the same npx line.)
//
// SHA-256 of the committed bundle:
//   e5aa7f36b5fd685f1fff2b1ebcf594d65c7116e380e957a9b4377fed7a9bec63
//
// That value is BUNDLE_SHA256 below and is enforced three times: the server
// refuses to serve a bundle whose bytes differ (and renders no scripts at all);
// the page loads it with a Subresource Integrity attribute derived from the
// constant, not from the file, so a browser refuses anything else, including a
// copy altered in transit; and transfer-test.mjs fails if a rebuild changed a
// byte without the constant being changed on purpose. .gitattributes marks the
// bundle -text so a Windows checkout cannot rewrite its line endings.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { esc } from './ui.mjs';

export const BUNDLE_SHA256 = 'e5aa7f36b5fd685f1fff2b1ebcf594d65c7116e380e957a9b4377fed7a9bec63';

// The two files this page reads on the server. Neither holds a secret.
export const DESTINATIONS_FILE = process.env.ADMIN_TRANSFER_DESTINATIONS
  || '/opt/pcoin-admin/transfer-destinations.json';
// The wrap desk's own state file and its own default for the main reserve
// address -- the same variables and defaults contrib/wpcn/wrapdesk-server.mjs
// reads, so the panel counts the reserve over exactly the desk's address list.
export const WRAPDESK_STATE_FILE = process.env.WRAPDESK_STATE || '/var/lib/wrapdesk/requests.json';
export const RESERVE_MAIN = process.env.WRAP_RESERVE || 'pc1q7hhzmdkkx0zjtzj6qkwmuvhlgwfqjrc6j2dk52';

const sha256 = (buf) => createHash('sha256').update(buf).digest();

// ── the three scripts, read once at start ──────────────────────────────────
// Read at start rather than per request: a deploy restarts the service, and a
// file that changes under a running panel should not change what it serves.
const ASSETS = {
  'crypto.js': 'transfer-crypto.bundle.js',
  'core.js': 'transfer-core.js',
  'ui.js': 'transfer-ui.js',
};
function loadAssets() {
  const out = {};
  for (const [route, file] of Object.entries(ASSETS)) {
    try {
      const bytes = readFileSync(new URL('./' + file, import.meta.url));
      out[route] = { file, bytes, sri: 'sha256-' + sha256(bytes).toString('base64'), error: null };
    } catch (e) {
      out[route] = { file, bytes: null, sri: null, error: `${file} could not be read (${e.code || e.message})` };
    }
  }
  const b = out['crypto.js'];
  if (b.bytes) {
    const got = sha256(b.bytes).toString('hex');
    if (got !== BUNDLE_SHA256) {
      b.error = `${b.file} has SHA-256 ${got}, but this panel is pinned to ${BUNDLE_SHA256}. `
        + 'Refusing to serve it: the only crypto this page may run is the bundle that was reviewed.';
      b.bytes = null;
    }
  }
  // The integrity attribute for the bundle comes from the PIN, never from the
  // file: even a server that somehow served other bytes could not make a
  // browser run them.
  b.sri = 'sha256-' + Buffer.from(BUNDLE_SHA256, 'hex').toString('base64');
  return out;
}
export const assets = loadAssets();
const assetError = () => Object.values(assets).map((a) => a.error).filter(Boolean);

// ── the named destinations: name -> pc1q address, written by the owner ─────
// Three outcomes, never two: no file (nothing configured), unreadable (say
// so), and read. The server only checks the SHAPE of each address; the page
// checks the bech32 checksum with the same decoder vault-sweep uses before it
// offers one, and shows a bad entry as bad rather than dropping it.
export function readDestinations(path = DESTINATIONS_FILE) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); }
  catch (e) {
    if (e && e.code === 'ENOENT') return { ok: true, configured: false, path, destinations: [], invalid: [] };
    console.error(`[transfer] cannot read ${path}: ${e.code || e.message}`);
    return { ok: false, path, error: `the destinations file could not be read (${e.code || e.message})` };
  }
  let j;
  try { j = JSON.parse(raw); }
  catch { return { ok: false, path, error: 'the destinations file is not valid JSON' }; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) {
    return { ok: false, path, error: 'the destinations file must be one JSON object of "name": "pc1q..." pairs' };
  }
  const destinations = [];
  const invalid = [];
  for (const [name, value] of Object.entries(j)) {
    if (name.startsWith('_')) continue;                        // _comment and friends
    const label = String(name).slice(0, 80);
    const a = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (/^pc1q[02-9ac-hj-np-z]{38}$/.test(a)) destinations.push({ name: label, address: a });
    else invalid.push({ name: label });                        // never echo the bad value back
  }
  return { ok: true, configured: true, path, destinations, invalid };
}

// ── the reserve, as wrapdesk.pc.am/proof counts it ─────────────────────────
// reserveBalance() in contrib/wpcn/wrapdesk-server.mjs sums the main reserve
// address plus `Object.values(requests).map(r => r.address).filter(a => a &&
// a !== RESERVE)` -- so this returns exactly that list, in that order, with
// any repeat left in, and the page does the arithmetic.
//
// ADDRESSES ONLY. requests.json also records each wrap's BSC address, the
// account that asked and the IP it came from. None of that is read out of the
// row, so none of it can leave this function.
//
// Unreadable is NOT an empty list here, unlike the desk's own load(): a page
// that cannot see the deposit addresses would under-count the reserve and
// might refuse a safe move -- or, worse, be trusted. It says it cannot read
// them, and the page refuses any move from wpcn-reserve until it can.
export function readReserveList(path = WRAPDESK_STATE_FILE, main = RESERVE_MAIN) {
  let st;
  try { st = JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) {
    const why = e instanceof SyntaxError ? 'is not valid JSON' : `could not be read (${e.code || e.message})`;
    console.error(`[transfer] wrap desk state ${path} ${why}`);
    return { ok: false, error: `the wrap desk's list of deposit addresses ${why}` };
  }
  const requests = st && typeof st === 'object' && st.requests && typeof st.requests === 'object' ? st.requests : {};
  const deposits = [];
  for (const r of Object.values(requests)) {
    const a = r && typeof r.address === 'string' ? r.address : null;
    if (a && a !== main && /^pc1[02-9ac-hj-np-z]{20,90}$/.test(a)) deposits.push(a);
  }
  return { ok: true, main, deposits };
}

// ── the Content-Security-Policy for the page ───────────────────────────────
// Scripts only from this origin, plus the shell's own inline script by hash
// (computed from the HTML actually being sent, so it cannot drift from it).
// connect-src 'self' is the browser-enforced half of "nothing leaves for
// anywhere else"; form-action 'none' because the page has no form to submit.
export function cspFor(html) {
  const hashes = [...String(html).matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => `'sha256-${sha256(Buffer.from(m[1], 'utf8')).toString('base64')}'`);
  return [
    "default-src 'none'",
    `script-src 'self' ${hashes.join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ');
}

// ── the page ────────────────────────────────────────────────────────────────
export function transferPage(base) {
  const errs = assetError();
  const style = `<style>
    #mv .mv-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px 18px;margin:6px 0 14px}
    #mv label.mv-f{display:flex;flex-direction:column;gap:5px;font-size:12px;color:var(--muted)}
    #mv label.mv-f select,#mv label.mv-f input[type=text],#mv label.mv-f input[type=password]{width:100%;font-size:13px}
    #mv label.mv-c{display:flex;gap:8px;align-items:flex-start;font-size:13px;color:var(--text)}
    #mv label.mv-c input{margin-top:3px}
    #mv .mv-row{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:8px 0}
    #mv .mv-pre{background:#0b1120;border:1px solid var(--border);border-radius:7px;padding:11px 13px;
      overflow-x:auto;font:12.5px/1.55 ui-monospace,"Cascadia Mono",Consolas,monospace;color:#cfe3ff;white-space:pre;margin:8px 0}
    #mv .mv-hex{white-space:pre-wrap;word-break:break-all;max-height:180px;overflow-y:auto}
    #mv .mv-box{border-radius:8px;padding:12px 14px;margin:12px 0;white-space:pre-line}
    #mv .mv-refused{background:#2a1111;border:1px solid #7f1d1d;color:#fecaca}
    #mv .mv-unknown{background:#2a2207;border:1px solid #7a5c0b;color:#fde68a}
    #mv .mv-good{background:#0a1a10;border:1px solid #1f5a33;color:#bbf7d0}
    #mv .mv-note{background:#0b1a26;border:1px solid #1e3a52;color:var(--text)}
    #mv .mv-warnbox{background:#2a1111;border:1px solid #7f1d1d;border-radius:8px;padding:13px 15px;margin:0 0 12px}
    #mv .mv-warnbox b{color:var(--red)}
    #mv ul.mv-list{margin:6px 0 0 20px;line-height:1.7}
    #mv .mv-small{font-size:12px}
    #mv button.danger{background:var(--red);border-color:var(--red);color:#fff}
    #mv button:disabled{opacity:.45;cursor:not-allowed}
    #mv .mv-progress{font-size:12px;color:var(--muted);min-height:1.4em}
    #mv table td code{font-size:12px}
  </style>`;

  const intro = `<div class="card">
    <div class="mv-warnbox"><b>Signed in this browser. Nothing secret leaves it.</b>
      <p class="muted" style="margin-top:6px">This is the one page in the panel with a passphrase box, and it is a
      deliberate exception to the vault page. Your vault files are read from your own disk by this browser and are
      never uploaded. The passphrase is used here and cleared from the box the moment you press Sign. The server
      that sent you this page has no way to receive it.</p></div>
    <p class="muted"><b>What does leave this browser:</b> pc1 addresses, to read their balances from the explorer
    on this same site, and &mdash; only when you press Broadcast &mdash; the signed transaction. Nothing else.</p>
    <p class="muted" style="margin-top:8px"><b>It does exactly what <code>vault-sweep.mjs</code> does:</b> the same
    coins chosen in the same order, the same fee (2&nbsp;sat/vB unless you pick another), the same change rules,
    and a transaction that is byte-for-byte the one the terminal tool would sign &mdash; which a test checks. You
    see the whole preview before the passphrase is asked for, and nothing is broadcast until you press a second,
    separate button.</p>
  </div>`;

  if (errs.length) {
    return style + `<div id="mv">${intro}<div class="card"><h2>This page cannot run</h2>
      ${errs.map((e) => `<p class="bad">${esc(e)}</p>`).join('')}
      <p class="muted">No script was sent to your browser, so nothing can be signed from this page until this is
      fixed. The terminal tools in <a href="${esc(base)}/vault">Vault commands</a> are unaffected.</p></div></div>`;
  }

  const step1 = `<div class="card" id="mv-s1"><h2>1 &middot; Your vault folder</h2>
    <p class="muted">Pick the folder that holds your <code>&lt;wallet&gt;-xpub.txt</code> and
    <code>&lt;wallet&gt;-seed.enc.json</code> files (for example <code>D:\\pc.am\\vault-mirror</code>). This browser
    remembers the folder, not its contents, so next time it only asks for permission. In an InPrivate window,
    pick the files instead: Edge has been seen to freeze when a private window reads a remembered folder back.</p>
    <div class="mv-row">
      <button type="button" id="mv-pick">Choose vault folder&hellip;</button>
      <button type="button" class="ghost" id="mv-reconnect" hidden>Reconnect</button>
      <button type="button" class="ghost" id="mv-forget" hidden>Forget this folder</button>
    </div>
    <div class="mv-row mv-small muted"><span id="mv-files-label">Or pick the files themselves:</span>
      <input type="file" id="mv-files" multiple accept=".txt,.json"></div>
    <p class="mv-progress" id="mv-folder-status"></p>
    <div id="mv-wallets"></div>
  </div>`;

  const step2 = `<div class="card" id="mv-s2" hidden><h2>2 &middot; What to move</h2>
    <div class="mv-grid">
      <label class="mv-f">From (a wallet this folder can sign for)<select id="mv-from"></select></label>
      <label class="mv-f">To<select id="mv-to"></select>
        <code class="mv-small" id="mv-to-full"></code></label>
      <label class="mv-f" id="mv-custom-wrap" hidden>Custom destination (pc1q&hellip;)
        <input type="text" id="mv-custom" spellcheck="false" autocomplete="off" autocapitalize="off" placeholder="pc1q&hellip;">
        <span class="mv-small" id="mv-custom-check"></span></label>
    </div>
    <p class="mv-small muted" id="mv-dest-note">Named destinations: loading&hellip;</p>
    <div class="mv-grid">
      <label class="mv-f">Amount in PCN<input type="text" id="mv-amount" inputmode="decimal" autocomplete="off"
        spellcheck="false" placeholder="e.g. 250"></label>
      <label class="mv-c" style="align-self:end"><input type="checkbox" id="mv-all">
        <span><b>All</b> &mdash; sweep the whole wallet. No change output: nothing is left behind.</span></label>
      <label class="mv-f">Fee rate<select id="mv-fee">
        <option value="1">1 sat/vB</option><option value="2" selected>2 sat/vB (what vault-sweep uses)</option>
        <option value="3">3 sat/vB</option><option value="5">5 sat/vB</option><option value="10">10 sat/vB</option>
      </select></label>
    </div>
    <div class="mv-grid" id="mv-change-row">
      <label class="mv-f">Change goes to (used only when there is change)<select id="mv-change"></select>
        <code class="mv-small" id="mv-change-full"></code></label>
      <label class="mv-f" id="mv-change-custom-wrap" hidden>Custom change address (pc1q&hellip;)
        <input type="text" id="mv-change-custom" spellcheck="false" autocomplete="off" autocapitalize="off" placeholder="pc1q&hellip;">
        <span class="mv-small" id="mv-change-custom-check"></span></label>
    </div>
    <label class="mv-c" id="mv-consent-wrap" hidden><input type="checkbox" id="mv-consent">
      <span><b>I know <code>wpcn-reserve</code> backs every wPCN 1:1.</b> Only the surplus above the 50,000 wPCN
      issued is mine to move. (This is vault-sweep&rsquo;s <code>--i-know-the-reserve-backs-wpcn</code>.)</span></label>
    <label class="mv-c" id="mv-railack-wrap" hidden><input type="checkbox" id="mv-railack">
      <span id="mv-railack-text"></span></label>
    <div class="mv-row"><button type="button" id="mv-preview">Preview</button>
      <span class="mv-progress" id="mv-preview-progress"></span></div>
    <div id="mv-refusal" hidden></div>
  </div>`;

  const step3 = `<div class="card" id="mv-s3" hidden><h2>3 &middot; Preview &mdash; nothing is signed yet</h2>
    <pre class="mv-pre" id="mv-preview-text"></pre>
    <div id="mv-reserve"></div>
    <details><summary class="muted mv-small" style="cursor:pointer">The inputs, largest first</summary>
      <div id="mv-inputs"></div></details>
  </div>`;

  const step4 = `<div class="card" id="mv-s4" hidden><h2>4 &middot; Sign in this browser</h2>
    <p class="muted">The seed file is read from your disk now, opened with this passphrase, and checked: the twelve
    words must derive <b>exactly</b> the xpub the coins above were found with, character for character, or nothing is
    signed. If your browser offers to save this passphrase, choose <b>Never</b>.</p>
    <div class="mv-row">
      <input type="password" id="mv-pass" autocomplete="off" autocapitalize="off" spellcheck="false"
        data-lpignore="true" data-1p-ignore data-bwignore data-form-type="other"
        placeholder="vault passphrase" style="min-width:280px" aria-label="vault passphrase">
      <button type="button" id="mv-sign">Sign</button>
    </div>
    <p class="mv-progress" id="mv-sign-progress"></p>
    <div id="mv-sign-refusal" hidden></div>
    <div id="mv-signed" hidden></div>
  </div>`;

  const step5 = `<div class="card" id="mv-s5" hidden><h2>5 &middot; Broadcast</h2>
    <p class="muted">This sends the signed transaction above to the network through the explorer on this site.
    It cannot be recalled. Your browser will ask once more.</p>
    <div class="mv-row"><button type="button" class="danger" id="mv-broadcast">Broadcast this transaction</button>
      <button type="button" class="ghost" id="mv-receipt" hidden>Download receipt (JSON)</button></div>
    <div id="mv-result"></div>
  </div>`;

  const scripts = ['crypto.js', 'core.js', 'ui.js'].map((r) =>
    `<script src="${esc(base)}/transfer/${r}" integrity="${esc(assets[r].sri)}" defer></script>`).join('\n');

  return style + `<div id="mv" data-base="${esc(base)}">${intro}
    <noscript><div class="card"><p class="bad">This page signs in your browser and needs JavaScript.</p></div></noscript>
    ${step1}${step2}${step3}${step4}${step5}
    <div class="card"><h2>What this page will not do</h2>
      <ul class="mv-list muted">
        <li>Send from <code>wpcn-reserve</code> without the tick above, or leave its change anywhere but the main
        reserve address, or leave the reserve below the 50,000 wPCN issued &mdash; counted the way
        <code>wrapdesk.pc.am/proof</code> counts it.</li>
        <li>Send part of <code>exchange</code> without naming where the change goes, or send that change back to an
        address the exchange watches.</li>
        <li>Send to anything but a <code>pc1q&hellip;</code> address (version 0, 20 bytes), checked with its checksum.</li>
        <li>Sign with a seed that does not derive the xpub the coins were found with.</li>
        <li>Guess. If the explorer cannot say what an address can spend, the answer is <b>unknown</b>, never zero,
        and nothing is built from it.</li>
      </ul></div>
  </div>
  ${scripts}`;
}

// ── routes ──────────────────────────────────────────────────────────────────
// Called by server.mjs for every path under <base>/transfer, AFTER the session
// check. GET and HEAD only. Nothing here reads a request body -- there is no
// readBody() and no req.on('data') in this file -- so there is no place for a
// secret to arrive even by mistake.
const HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
};
function reply(res, code, type, body, extra = {}, head = false) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  res.writeHead(code, { ...HEADERS, 'content-type': type, 'content-length': buf.length, ...extra });
  res.end(head ? undefined : buf);
}

export function transferRoute(sub, req, res, { base, shell }) {
  const head = req.method === 'HEAD';
  if (req.method !== 'GET' && !head) {
    // Refused without reading the body, and the connection is closed so the
    // unread bytes are never parsed as anything.
    return reply(res, 405, 'text/plain; charset=utf-8', 'This page accepts no data. Nothing was read.\n',
      { allow: 'GET, HEAD', connection: 'close' });
  }
  if (sub === '/transfer') {
    const html = shell('transfer', 'Move PCN', transferPage(base));
    return reply(res, 200, 'text/html; charset=utf-8', html, { 'content-security-policy': cspFor(html) }, head);
  }
  const name = sub.slice('/transfer/'.length);
  if (Object.prototype.hasOwnProperty.call(ASSETS, name)) {
    const a = assets[name];
    if (!a.bytes) return reply(res, 500, 'text/plain; charset=utf-8', (a.error || 'unavailable') + '\n', {}, head);
    return reply(res, 200, 'text/javascript; charset=utf-8', a.bytes, {}, head);
  }
  if (name === 'destinations.json') {
    return reply(res, 200, 'application/json; charset=utf-8', JSON.stringify(readDestinations()), {}, head);
  }
  if (name === 'reserve.json') {
    return reply(res, 200, 'application/json; charset=utf-8', JSON.stringify(readReserveList()), {}, head);
  }
  return reply(res, 404, 'text/plain; charset=utf-8', 'not found\n', {}, head);
}
