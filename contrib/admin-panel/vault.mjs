// ═══════════════════════════════════════════════════════════════════════════
// THE VAULT COMMANDS — every command that touches a PCoin wallet, as a
// procedure: what to check first, what to type, what you should see, and how
// to tell it worked.
// ═══════════════════════════════════════════════════════════════════════════
//
// WHY THIS PAGE EXISTS
//
// The vault tools are the only way money leaves any of these wallets, and they
// run on ONE machine -- the owner's -- because that is the only place the keys
// can be reconstructed. That is the right design and it has one cost: the
// commands live nowhere he can look them up, so every sweep has begun with him
// asking for the command and waiting for someone to compose it. That is slow,
// and it is the exact moment a wrong flag gets typed into a tool that spends.
//
// NOTHING HERE EXECUTES. The page renders command TEXT. He copies one, runs it
// in his own terminal, and types the passphrase at the prompt.
//
// THE PASSPHRASE IS NEVER PART OF A COMMAND, and no command here has a place to
// put one. Every tool prompts for it with echo suppressed, which is what keeps
// it out of shell history, out of `ps`, and out of any transcript. A page with
// a passphrase field would quietly undo that, so there is deliberately no input
// element anywhere on this page and a test asserts it.
//
// WHY EVERY SPENDING COMMAND IS A TWO-PHASE PROCEDURE. The tools build and sign
// and then STOP. The dry run is not a formality: on 2026-09-18 it is what caught
// a wPCN reserve spend that would have published "14.3% backed" on the public
// proof page. The expected output printed here is REAL output from that session,
// not an invention, so a difference between the page and the terminal means
// something actually changed.
import { esc, card, note } from './ui.mjs';

// The one place the path appears. The tools resolve their key files relative to
// the working directory, so the `cd` is part of every command rather than an
// assumption about where a terminal happens to be.
const DIR = 'D:\\xampp\\htdocs\\pcoin\\contrib\\vault';
const cmd = (line) => `cd ${DIR}\nnode ${line}`;

let uid = 0;

// A command block with its own copy button. The clipboard gets pre.textContent,
// so what is copied is what is shown -- not an HTML-escaped copy of it, which
// is how a stray &amp; ends up pasted into a terminal.
const block = (text) => {
  const id = `c${++uid}`;
  return `<div class="cmd"><button class="copy" data-for="${id}">copy</button>`
       + `<pre id="${id}">${esc(text)}</pre></div>`;
};

// Real terminal output. Deliberately NOT copyable -- it is something to compare
// against, and a copy button on it would invite pasting it back in.
const expect = (text) => `<div class="expect"><div class="elabel">what you should see</div>`
  + `<pre>${esc(text)}</pre></div>`;

const list = (cls, label, items) => !items || !items.length ? '' :
  `<div class="${cls}"><div class="elabel">${esc(label)}</div><ul>`
  + items.map((i) => `<li>${i}</li>`).join('') + `</ul></div>`;

const step = (n, title, inner) =>
  `<div class="step"><div class="snum">${n}</div><div class="sbody">`
  + `<div class="stitle">${esc(title)}</div>${inner}</div></div>`;

// One procedure.
const proc = ({ title, needs, danger, what, before, body, wrong }) => `
  <div class="ventry${danger ? ' danger' : ''}">
    <div class="vhead"><b>${esc(title)}</b>${
      needs ? `<span class="tag ${danger ? 'tag-red' : 'tag-amber'}">${esc(needs)}</span>` : ''}</div>
    <p class="muted">${what}</p>
    ${list('before', 'before you run it', before)}
    ${body}
    ${wrong ? `<div class="wrong"><div class="elabel">if it does not look like that</div>
      <p class="muted">${wrong}</p></div>` : ''}
  </div>`;

const group = (title, blurb, entries) =>
  card(title, (blurb ? note(blurb) : '') + entries.join(''));

export function vaultPage() {
  uid = 0;

  const style = `<style>
    .ventry{border-left:3px solid var(--border);padding:2px 0 14px 15px;margin:26px 0}
    .ventry.danger{border-left-color:var(--red)}
    .vhead{display:flex;align-items:center;gap:10px;margin-bottom:5px;flex-wrap:wrap}
    .tag{font-size:11px;padding:2px 8px;border-radius:9px;white-space:nowrap}
    .tag-amber{background:#3a2e07;color:var(--yellow)}
    .tag-red{background:#3d1414;color:var(--red)}
    .cmd{position:relative;margin:9px 0}
    .cmd pre{background:#0b1120;border:1px solid var(--border);border-radius:7px;
      padding:11px 62px 11px 13px;overflow-x:auto;font:13px/1.55 ui-monospace,
      "Cascadia Mono",Consolas,monospace;color:#cfe3ff;white-space:pre}
    .copy{position:absolute;top:7px;right:7px;background:var(--panel);
      color:var(--muted);border:1px solid var(--border);border-radius:5px;
      padding:3px 9px;font-size:11px;cursor:pointer}
    .copy:hover{color:var(--text);border-color:var(--blue)}
    .copy.done{color:var(--green);border-color:var(--green)}
    .expect pre{background:#0a1410;border:1px solid #1f3b2c;border-radius:7px;
      padding:10px 13px;overflow-x:auto;font:12.5px/1.5 ui-monospace,
      "Cascadia Mono",Consolas,monospace;color:#a7d8bd;white-space:pre;margin:0}
    .elabel{font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;
      color:var(--muted);margin:11px 0 5px}
    .before ul,.check ul,.wrong ul{margin:0 0 0 19px;line-height:1.75}
    .before li{color:var(--muted)}
    .check{background:#0b1a26;border:1px solid #1e3a52;border-radius:7px;
      padding:4px 14px 11px;margin:11px 0}
    .check li{color:var(--text)}
    .check li::marker{content:'\\2713  ';color:var(--green)}
    .wrong{border-left:3px solid var(--yellow);padding:0 0 0 12px;margin:11px 0}
    .step{display:flex;gap:12px;margin:15px 0}
    .snum{flex:0 0 26px;height:26px;border-radius:50%;background:var(--panel-2);
      border:1px solid var(--border);color:var(--blue);display:flex;
      align-items:center;justify-content:center;font-size:13px;font-weight:600}
    .sbody{flex:1;min-width:0}
    .stitle{font-weight:600;margin-bottom:2px}
    .warnbox{background:#2a1111;border:1px solid #7f1d1d;border-radius:8px;
      padding:13px 15px;margin:14px 0}
    .warnbox b{color:var(--red)}
  </style>`;

  const script = `<script>
    document.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.copy') : null; if (!b) return;
      var pre = document.getElementById(b.dataset.for); if (!pre) return;
      navigator.clipboard.writeText(pre.textContent).then(function () {
        b.textContent = 'copied'; b.classList.add('done');
        setTimeout(function () { b.textContent = 'copy'; b.classList.remove('done'); }, 1400);
      });
    });
  </script>`;

  const intro = card('Before you run any of these', `
    <div class="warnbox">
      <b>These run on your own PC and nowhere else.</b>
      <p class="muted" style="margin-top:6px">The keys exist only while one of
      these commands is running, and only on the machine you type the passphrase
      into. Never paste one into a server shell, a remote session, or a chat.</p>
    </div>
    <p class="muted"><b>The passphrase is never part of a command.</b> Every tool
    that needs it stops and asks, and does not echo what you type &mdash; that is
    what keeps it out of your shell history and out of any log. If a command
    seems to want a passphrase as an argument, it is the wrong command.</p>
    <p class="muted" style="margin-top:9px"><b>Nothing sends until you say so.</b>
    <code>vault-sweep.mjs</code> builds the transaction, signs it, prints exactly
    what would leave and where, and stops. It broadcasts only with
    <code>--send</code>; <code>wrapdesk-withdraw.mjs</code> only with
    <code>--broadcast</code>. <b>Read the dry run every time.</b> On 18 September
    the dry run is what caught a reserve spend that would have published
    &ldquo;14.3% backed&rdquo; on the public proof page.</p>
    <p class="muted" style="margin-top:9px"><b>The expected output below is real.</b>
    It was captured from actual runs, not written from memory. If your terminal
    differs from this page in any number that matters, stop and find out why
    before typing <code>--send</code>.</p>
    <p class="muted" style="margin-top:9px"><b>Two things the tool checks for you,
    so you do not have to.</b> It refuses any destination that is not a valid
    <code>pc1q</code> address, and before signing it re-derives the wallet from
    your passphrase and confirms it matches the xpub the coins were actually
    found with &mdash; printing <code>seed matches the xpub the coins were found
    with.</code> A wrong <code>--system</code> therefore fails loudly instead of
    signing for the wrong wallet.</p>`);

  // ── reading ───────────────────────────────────────────────────────────────
  const reading = group('Reading &mdash; safe at any time',
    'None of these can move a coin. The first two do not even ask for the passphrase.', [

    proc({
      title: 'Where is the money? — every wallet, read off the chain',
      what: 'Scans all 13 vault wallets against the chain &mdash; both the receive and '
          + 'change branches, 2000 addresses deep. It uses only the public xpubs, so it '
          + 'asks for no passphrase and cannot spend. This is the first command to run '
          + 'when you want the whole picture.',
      before: ['Nothing. It is read-only and safe to run at any time.'],
      body: block(cmd('vault-sweep.mjs --list'))
        + expect(`  reading 13 vault wallets off the chain (both branches, 2000 deep)…

  3dmodels               0.00000000 PCN     0 address(es)
  exchange           29490.54755499 PCN     7 address(es)  <- CUSTOMERS' deposits, never sweep
  market-hot         13265.70631132 PCN     4 address(es)  <- watch-only here (no seed file)
  pcnaibot               5.00000000 PCN     1 address(es)
  wpcn-reserve       50000.25999718 PCN    31 address(es)  <- backs wPCN 1:1; only the surplus is yours
  ──────────────────────────────────────────────────────────────────────
  sweepable from this machine        20.00000000 PCN
  yours, but signed elsewhere     13265.70631132 PCN   (watch-only above)
  spoken for (exchange + wPCN)    79490.80755217 PCN   NOT yours to move`)
        + list('check', 'check before going on', [
            'It says <b>13 vault wallets</b>. Fewer means an xpub file is missing from the folder.',
            '<code>exchange</code> and <code>wpcn-reserve</code> carry their warning notes.',
            'The three totals at the bottom add up to the line above them.',
          ]),
      wrong: 'Every row reading <code>0.00000000</code> usually means the explorer was '
           + 'unreachable rather than that the wallets are empty. Open '
           + '<code>explorer.pc.am</code> and try again &mdash; do not conclude the coins '
           + 'are gone from a failed read.',
    }),

    proc({
      title: 'Is the signer still correct? — prove it against the published vector',
      what: 'Signs a transaction from the published BIP143 test vector and compares the '
          + 'result byte-for-byte against the known-good signature, then proves that a '
          + 'wrong passphrase is still refused and a bad destination still rejected. It '
          + 'touches no wallet and needs no passphrase.',
      before: ['Run this after any change to the tool, and before a large sweep if you want the reassurance.'],
      body: block(cmd('vault-sweep.mjs --selftest'))
        + expect(`  REFUSED: "nonsense" is not a valid bech32 address

  ok   refuses "nonsense…"

  ALL CHECKS PASSED`)
        + list('check', 'check before going on', [
            'The last line is <b>ALL CHECKS PASSED</b>.',
            'The <code>REFUSED: "nonsense"</code> line is EXPECTED &mdash; that is the test '
            + 'proving a bad address is rejected, not a failure.',
          ]),
      wrong: 'Anything other than ALL CHECKS PASSED means <b>do not sweep</b>. The signer '
           + 'is the one component where a subtle fault produces a transaction that looks '
           + 'right and cannot be spent.',
    }),

    proc({
      title: 'Does my passphrase still open every vault?',
      needs: 'passphrase',
      what: 'Asks once, then tries that passphrase against all 13 encrypted blobs and '
          + 'ticks off each one it opens. It decrypts, checks, and discards &mdash; nothing '
          + 'is written and nothing can be spent.',
      before: ['Run this occasionally on its own. It is the cheapest way to find out you have '
             + 'lost access to something, and the worst time to find out is with money on the line.'],
      body: block(cmd('vault-sweep.mjs --check-all'))
        + expect(`  passphrase for the vault files (nothing is echoed):

  ✓  3dmodels          pc1q…  opens
  ✓  aicontrol         pc1q…  opens
  ✓  checker           pc1q…  opens
  …
  ✓  wpcn-reserve      pc1q…  opens

  12 of 13 opened.  market-hot has no seed file (Core wallet, signed where it lives).`)
        + list('check', 'check before going on', [
            '<b>12 of 13</b> is the correct, healthy answer.',
            '<code>market-hot</code> is the expected exception &mdash; it is a Core-generated '
            + 'wallet with no twelve words, so there is nothing here to open.',
          ]),
      wrong: 'A vault that will not open is the one emergency on this page. Do not delete '
           + 'or overwrite anything. The blobs also exist on both vault hosts; check those '
           + 'copies before concluding the passphrase is wrong.',
    }),

    proc({
      title: 'Check one wallet, and see its first address',
      needs: 'passphrase',
      what: 'The same check against a single system, and it prints address 0 so you can '
          + 'compare it against what the live service shows. Replace <code>checker</code> '
          + 'with any name from the list at the bottom of this page.',
      before: ['Have the service open in another tab if you intend to compare addresses.'],
      body: block(cmd('vault-sweep.mjs --check checker'))
        + list('check', 'check before going on', [
            'The printed address 0 matches the deposit address that service hands out at index 0.',
          ]),
    }),

    proc({
      title: 'Do the backups really contain the right wallets?',
      needs: 'passphrase',
      what: 'A blob can be correctly labelled and still hold the wrong twelve words, and '
          + 'the first time you would find out is with money on the line. This opens every '
          + 'blob, re-derives the wallet from the phrase inside it, and checks it against '
          + 'the xpub written on the label.',
      before: ['<b>A backup is not a backup until it has been loaded.</b> This is that load. '
             + 'Run it before anything destructive, and after creating any new wallet.'],
      body: block(cmd('verify-blobs.mjs'))
        + list('check', 'check before going on', [
            'Every blob reports that the phrase inside derives the xpub on its label.',
          ]),
      wrong: 'A mismatch means a blob is mislabelled &mdash; the coins are not lost, but the '
           + 'map to them is wrong. Do not overwrite anything; work out which phrase belongs '
           + 'to which rail with <code>which-rail.mjs</code> first.',
    }),

    proc({
      title: 'Which rail does this paper phrase control?',
      what: 'Type the twelve words and it tells you which service they belong to. It derives '
          + 'only the account-level <i>public</i> key &mdash; arithmetic on a public key, no '
          + 'private child, no address, no signing. The phrase is typed at a prompt and never '
          + 'echoed, so it cannot reach your shell history or a process list.',
      before: ['Use this when you have a paper card and do not know which service it is for.'],
      body: block(cmd('which-rail.mjs')),
    }),

    proc({
      title: 'Label a stack of paper cards',
      needs: 'passphrase',
      what: 'Prints the first word and account fingerprint of each wallet &mdash; just enough '
          + 'to match a card to a rail without reading out a whole phrase.',
      before: ['One BIP39 word leaves about 117 bits of entropy, which is still far out of '
             + 'reach. <b>Do not raise <code>--words</code></b> to satisfy curiosity: at 8 or 9 '
             + 'the remainder stops being a wall, and at 11 the checksum finishes the job.'],
      body: block(cmd('first-words.mjs')),
    }),
  ]);

  // ── spending ──────────────────────────────────────────────────────────────
  const moving = group('Moving coins &mdash; every one of these is a two-phase procedure',
    'Phase one builds and signs and sends NOTHING. Phase two is the identical command with '
  + 'the broadcast flag added. Never skip phase one.', [

    proc({
      title: 'Sweep one wallet empty',
      needs: 'passphrase · spends',
      danger: true,
      what: 'Collects every unspent output the wallet owns and sends the whole balance to '
          + 'one address, minus the network fee. There is no change output, because nothing '
          + 'is left behind.',
      before: [
        'Run <code>--list</code> first and note the balance you expect to move.',
        'Have the destination address on your clipboard from a trusted place &mdash; your own '
        + 'wallet app, not a chat message.',
        '<b>Never use <code>--all</code> on <code>wpcn-reserve</code>.</b> It would unback '
        + 'every wPCN in circulation.',
      ],
      body:
        step(1, 'Build and sign it — this sends nothing',
          block(cmd('vault-sweep.mjs --system checker --to pc1qYOURADDRESS --all'))
          + expect(`   SEND        1234.56780000 PCN
   TO          pc1qYOURADDRESS
   from        checker  (3 input(s))
   fee         0.00000628 PCN  (2 sat/vB)
  ──────────────────────────────────────────────────────────────
  passphrase for the vault file (nothing is echoed):
  seed matches the xpub the coins were found with. ✓
  signed      : txid 4a81e686…

  --- NOT SENT. Nothing has been broadcast. ---`)
          + list('check', 'check every one of these before step 2', [
              '<b>TO</b> is character-for-character the address you meant. Read the whole thing, '
              + 'not just the first six characters.',
              '<b>SEND</b> matches what <code>--list</code> told you this wallet holds.',
              'The line <b>seed matches the xpub the coins were found with</b> is present.',
              'There is <b>no change line</b> &mdash; a sweep empties the wallet.',
              'The fee is a few hundred satoshi, not a whole coin.',
            ]))
        + step(2, 'Broadcast it — the same line with --send',
          block(cmd('vault-sweep.mjs --system checker --to pc1qYOURADDRESS --all --send'))
          + list('check', 'after it returns', [
              'It prints <b>BROADCAST</b> and a txid, and writes a <code>sweep-*.json</code> receipt.',
              'Open the explorer link. The transaction should appear in the mempool immediately.',
              'Re-run <code>--list</code>: that wallet should now read <code>0.00000000</code> '
              + 'once the transaction confirms.',
            ])),
      wrong: 'If the destination or the amount is not exactly what you intended, just do not '
           + 'run step 2. Nothing has been sent and the signed transaction is discarded when '
           + 'you close the terminal.',
    }),

    proc({
      title: 'Send a specific amount, leaving the rest behind',
      needs: 'passphrase · spends',
      danger: true,
      what: 'Bounded to an amount in PCN, with the remainder returned as change. '
          + '<b>The fee comes out of the change, not out of the amount</b> &mdash; the '
          + 'destination receives exactly what you asked for and the wallet keeps slightly '
          + 'less than you might expect. That matters whenever you are sweeping down to a '
          + 'target balance.',
      before: [
        'Decide the amount, and remember the fee reduces what STAYS, not what goes.',
        'Add <code>--change-to &lt;address&gt;</code> if it matters where the remainder lands '
        + '&mdash; see the wPCN procedure below for why it can matter a great deal.',
      ],
      body:
        step(1, 'Build and sign it',
          block(cmd('vault-sweep.mjs --system market --to pc1qYOURADDRESS --amount 1000'))
          + list('check', 'check before step 2', [
              'The <b>change</b> line names an address you recognise as belonging to this wallet.',
              '<code>SEND + change + fee</code> equals the input total exactly. If it does not, stop.',
            ]))
        + step(2, 'Broadcast it',
          block(cmd('vault-sweep.mjs --system market --to pc1qYOURADDRESS --amount 1000 --send'))),
    }),

    proc({
      title: 'Take the wPCN surplus',
      needs: 'passphrase · spends · guarded',
      danger: true,
      what: 'The reserve backs every wPCN one-for-one, so only the amount <i>above</i> the '
          + 'issued supply is yours. The tool refuses this wallet outright without the long '
          + 'flag, so it cannot be swept by reflex.',
      before: [
        'Read the current <b>Surplus</b> from <code>wrapdesk.pc.am/proof</code>.',
        '<b>Round it DOWN to a whole number.</b> The fee comes out of the change, so taking '
        + 'the exact surplus leaves the reserve a hair under 1:1 and the public proof page '
        + 'stops saying &ldquo;fully backed&rdquo;.',
        '<b><code>--change-to</code> is not optional and the tool refuses without it.</b> This '
        + 'spend takes the 50,000 PCN founding deposit as its input, and that deposit sits on '
        + 'the MAIN reserve address. The proof page sums the main address plus the deposit '
        + 'addresses rather than scanning the wallet, so change sent anywhere else is '
        + 'invisible to it and the page would publish a backing figure of about 14%.',
      ],
      body:
        step(1, 'Build and sign it — this is the step that catches mistakes',
          block(cmd('vault-sweep.mjs --system wpcn-reserve --to pc1qYOURADDRESS \\\n'
                  + '  --amount <SURPLUS> --i-know-the-reserve-backs-wpcn \\\n'
                  + '  --change-to pc1q7hhzmdkkx0zjtzj6qkwmuvhlgwfqjrc6j2dk52'))
          + expect(`  found       : 34 unspent output(s) across 31 address(es)
  available   : 57164.26000000 PCN
  ──────────────────────────────────────────────────────────────
   SEND        7164.00000000 PCN
   TO          pc1qlvw6kx8wkcz8f6p0d6kswv69fjt33ll079f64e
   from        wpcn-reserve  (1 input(s))
   fee         0.00000282 PCN  (2 sat/vB)
   change      42835.99999718 PCN back to pc1q7hhzmdkkx0zjtzj6qkwmuvhlgwfqjrc6j2dk52
  ──────────────────────────────────────────────────────────────
  seed matches the xpub the coins were found with. ✓
  signed      : txid cdf6e941…

  --- NOT SENT. Nothing has been broadcast. ---`)
          + list('check', 'all four, before step 2', [
              'The <b>change</b> line ends with <code>pc1q7hhzmdkkx0zjtzj6qkwmuvhlgwfqjrc6j2dk52</code> '
              + '&mdash; the MAIN reserve address. Any other address and the proof page will '
              + 'under-report.',
              '<code>SEND + change + fee</code> equals the input exactly. In the real run: '
              + '<code>7164 + 42835.99999718 + 0.00000282 = 50000.00000000</code>.',
              '<b>change + the deposit addresses stays at or above the issued supply.</b> In the '
              + 'real run: <code>42835.99999718 + 7164.26 = 50000.26</code> against 50,000 issued '
              + '&mdash; 100.0005% backed.',
              'The line <b>seed matches the xpub the coins were found with</b> is present.',
            ]))
        + step(2, 'Broadcast it',
          block(cmd('vault-sweep.mjs --system wpcn-reserve --to pc1qYOURADDRESS \\\n'
                  + '  --amount <SURPLUS> --i-know-the-reserve-backs-wpcn \\\n'
                  + '  --change-to pc1q7hhzmdkkx0zjtzj6qkwmuvhlgwfqjrc6j2dk52 --send'))
          + list('check', 'after it confirms', [
              'Open <code>wrapdesk.pc.am/proof</code>. It must still say <b>Fully backed</b>, '
              + 'with backing just above 100%.',
              'Write the movement into <code>PCOIN-WPCN-RUNBOOK.md</code> &mdash; an undocumented '
              + 'one previously caused four days of false &ldquo;237.50 wPCN owed&rdquo; alerts.',
            ])),
      wrong: 'If the tool <b>REFUSES</b> and talks about change at a derived address, that is '
           + 'the guard doing its job: you left out <code>--change-to</code>. Add it and run '
           + 'again. Never work around this refusal.',
    }),

    proc({
      title: 'Return one over-limit wrap deposit',
      needs: 'passphrase · spends',
      danger: true,
      what: 'Spends <i>named</i> outputs of the wPCN reserve and nothing else &mdash; built for '
          + 'returning a deposit that was too large to wrap. You give it the exact '
          + '<code>txid:vout</code> and the deposit index it came from, so it cannot reach the '
          + 'rest of the reserve.',
      before: [
        'Prove the signer first: <code>node wrapdesk-withdraw.mjs --selftest</code>. It needs no keys.',
        'Have the exact <code>txid:vout</code> of the deposit being returned, and the customer address.',
      ],
      body:
        step(1, 'Build and sign it',
          block(cmd('wrapdesk-withdraw.mjs --index 3 --to pc1qTHEIRADDRESS \\\n  --utxo <txid>:<vout>'))
          + list('check', 'check before step 2', [
              'The decoded transaction spends only the outputs you named.',
              'The destination is the customer&rsquo;s address, not ours.',
            ]))
        + step(2, 'Broadcast it',
          block(cmd('wrapdesk-withdraw.mjs --index 3 --to pc1qTHEIRADDRESS \\\n'
                  + '  --utxo <txid>:<vout> --broadcast'))),
    }),
  ]);

  // ── making ────────────────────────────────────────────────────────────────
  const making = group('Creating, restoring and sealing',
    'These make new wallets or open sealed backups. The twelve words appear on screen exactly '
  + 'once, and only on your machine.', [

    proc({
      title: 'Create a wallet for a new service',
      needs: 'passphrase',
      what: 'Generates twelve words, shows them once, derives the account xpub at '
          + 'm/84&#39;/9444&#39;/0&#39;, and writes two files: the public '
          + '<code>-xpub.txt</code> for the server and the encrypted '
          + '<code>-seed.enc.json</code> for both vault hosts. The private side never leaves '
          + 'this machine.',
      before: [
        'Have pen and paper ready before you start. The words are shown once.',
        'Nobody behind you, and nothing recording the screen.',
      ],
      body: block(cmd('pcoin-seed-vault.mjs new --system <name>'))
        + list('check', 'immediately afterwards', [
            'Write the twelve words down and label the card with the system name.',
            'Run <code>node verify-blobs.mjs</code> &mdash; a backup nobody has opened is not '
            + 'yet a backup.',
            'Copy the <code>.enc.json</code> to <b>both</b> vault hosts.',
            'Give the server only the <code>-xpub.txt</code>. Never the seed file.',
          ]),
    }),

    proc({
      title: 'Generate the deposit-address pool for a service',
      needs: 'passphrase',
      what: 'Derives a flat list of addresses for the server to hand out, one per customer. '
          + 'The server gets only this list &mdash; never the seed, never the xpub &mdash; so '
          + 'it can watch deposits and cannot spend them.',
      before: ['Know which index range the service has already issued, so you do not overlap it.'],
      body: block(cmd('pcoin-seed-vault.mjs pool --system <name> --count 1000 --start 0'))
        + list('check', 'check', [
            'The first address in the file matches what <code>--check &lt;system&gt;</code> prints '
            + 'as address 0, when you start at 0.',
          ]),
    }),

    proc({
      title: 'Read the twelve words back out',
      needs: 'passphrase',
      what: 'Prints the phrase from a sealed blob, for writing onto paper or restoring into a '
          + 'wallet app. Everything else on this page avoids showing the words; this is the '
          + 'deliberate exception.',
      before: ['Nobody behind you. Nothing recording the screen. Clear the terminal afterwards.'],
      body: block(cmd('pcoin-seed-vault.mjs restore --file <name>-seed.enc.json')),
    }),

    proc({
      title: 'Check a sealed blob opens, without printing anything secret',
      needs: 'passphrase',
      what: 'Opens the blob, re-derives, and reports whether it matches its own label. Use this '
          + 'rather than <code>restore</code> whenever the question is only &ldquo;does this '
          + 'still work&rdquo;.',
      body: block(cmd('pcoin-seed-vault.mjs verify --file <name>-seed.enc.json')),
    }),

    proc({
      title: 'Seal a secret that is not a seed phrase',
      needs: 'passphrase',
      what: 'The same encrypted format for things that are not twelve words &mdash; a raw EVM '
          + 'private key, a bearer token, an API secret. It refuses to overwrite an existing '
          + 'blob and refuses to seal an empty file.',
      body: block(cmd('pcoin-key-seal.mjs seal --in <secret file> --out <name>.enc.json'))
        + list('check', 'check', [
            'Verify it opens before deleting the plaintext original.',
          ]),
    }),

    proc({
      title: 'Back up everything off-repo into one blob',
      needs: 'passphrase',
      what: 'Encrypts the files that cannot be regenerated &mdash; the Android release keystore, '
          + 'TLS keys, the server and secrets notes &mdash; into a single blob that can safely '
          + 'sit in three places.',
      before: ['Losing the Android keystore means no user can ever upgrade the app. This is the '
             + 'backup that matters most.'],
      body: block(cmd('pcoin-vault-bundle.mjs pack --root D:\\pc.am --out pcoin-bundle.enc.json'))
        + list('check', 'then, every time', [
            '<code>node pcoin-vault-bundle.mjs verify --file pcoin-bundle.enc.json</code>',
            '<code>node pcoin-vault-bundle.mjs list --file pcoin-bundle.enc.json</code> shows what '
            + 'is inside without unpacking it.',
          ]),
    }),
  ]);

  const systems = card('The wallet names', `
    <p class="muted">Anywhere a command says <code>--system &lt;name&gt;</code>, it takes one
    of these:</p>
    <p style="margin:10px 0"><code>3dmodels</code> · <code>aicontrol</code> ·
    <code>checker</code> · <code>exchange</code> · <code>market-hot</code> ·
    <code>market</code> · <code>oonak3d</code> · <code>pcnaibot</code> ·
    <code>pcnearner</code> · <code>portrait2video</code> · <code>webai</code> ·
    <code>webbuilderbot</code> · <code>wpcn-reserve</code></p>
    <p class="muted"><b>Three of them will not sweep, and each refusal is deliberate:</b></p>
    <ul class="muted" style="margin:8px 0 0 20px;line-height:1.75">
      <li><code>exchange</code> &mdash; refused outright. Those are customers&#39; deposits and
      the exchange&#39;s own solvency check counts them; moving them halts trading.</li>
      <li><code>wpcn-reserve</code> &mdash; refused without
      <code>--i-know-the-reserve-backs-wpcn</code>, and refused again if change would land
      anywhere but the main address.</li>
      <li><code>market-hot</code> &mdash; watch-only here. It is a Core-generated wallet with no
      twelve words, so it is signed where it lives, not from this machine.</li>
    </ul>`);

  return style + intro + reading + moving + making + systems + script;
}
