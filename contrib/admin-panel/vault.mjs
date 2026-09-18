// ═══════════════════════════════════════════════════════════════════════════
// THE VAULT COMMANDS — every command that touches a PCoin wallet, in one page.
// ═══════════════════════════════════════════════════════════════════════════
//
// WHY THIS PAGE EXISTS
//
// The vault tools are the only way money leaves any of these wallets, and they
// run on ONE machine -- the owner's -- because that is the only place the keys
// can be reconstructed. That is the right design and it has one cost: the
// commands live nowhere the owner can look them up. Every sweep so far has
// started with him asking for the command and waiting for someone to compose
// it, which is both slow and the exact moment a wrong flag gets typed.
//
// So this page is a reference, not a control panel. NOTHING HERE EXECUTES.
// It renders the text of each command with what it does beside it; he copies
// one, runs it in his own terminal, and types the passphrase at the prompt.
//
// THE PASSPHRASE IS NEVER PART OF A COMMAND, and no command shown here has a
// place to put one. Every tool prompts for it with echo suppressed, which is
// what keeps it out of shell history, out of `ps`, and out of any transcript.
// A page that offered a passphrase field would undo the whole design.
//
// WHY THE DANGEROUS ONES ARE SHOWN IN TWO PIECES. Anything that can move coins
// is written twice: once as it runs by default (builds, signs, prints, and
// broadcasts NOTHING) and once with the flag that actually sends. They are
// deliberately not one copyable line -- the dry run is meant to be read before
// the send exists as text on the screen.
import { esc, card, note } from './ui.mjs';

// The one place the path appears. The tools resolve their key files relative to
// the working directory, so the `cd` is part of every command rather than an
// assumption about where a terminal happens to be.
const DIR = 'D:\\xampp\\htdocs\\pcoin\\contrib\\vault';

const cmd = (line) => `cd ${DIR}\nnode ${line}`;

// A command block with its own copy button. `data-cmd` carries the exact text,
// so what reaches the clipboard is what is shown -- not an HTML-escaped copy of
// it, which is how a stray &amp; ends up pasted into a terminal.
let uid = 0;
const block = (text) => {
  const id = `c${++uid}`;
  return `<div class="cmd"><button class="copy" data-for="${id}">copy</button>`
       + `<pre id="${id}">${esc(text)}</pre></div>`;
};

// One command: what it is, what it does, and (where it matters) what it cannot do.
const entry = ({ title, what, needs, danger, text, after }) => `
  <div class="ventry${danger ? ' danger' : ''}">
    <div class="vhead"><b>${esc(title)}</b>${
      needs ? `<span class="tag ${danger ? 'tag-red' : 'tag-amber'}">${esc(needs)}</span>` : ''}</div>
    <p class="muted">${what}</p>
    ${block(text)}
    ${after || ''}
  </div>`;

const group = (title, blurb, entries) =>
  card(title, (blurb ? note(blurb) : '') + entries.join(''));

export function vaultPage() {
  uid = 0;
  const style = `<style>
    .ventry{border-left:3px solid var(--border);padding:2px 0 2px 14px;margin:18px 0}
    .ventry.danger{border-left-color:var(--red)}
    .vhead{display:flex;align-items:center;gap:10px;margin-bottom:4px;flex-wrap:wrap}
    .tag{font-size:11px;padding:2px 7px;border-radius:9px;white-space:nowrap}
    .tag-amber{background:#3a2e07;color:var(--yellow)}
    .tag-red{background:#3d1414;color:var(--red)}
    .cmd{position:relative;margin:8px 0}
    .cmd pre{background:#0b1120;border:1px solid var(--border);border-radius:7px;
      padding:11px 62px 11px 13px;overflow-x:auto;font:13px/1.55 ui-monospace,
      "Cascadia Mono",Consolas,monospace;color:#cfe3ff;white-space:pre}
    .copy{position:absolute;top:7px;right:7px;background:var(--panel);
      color:var(--muted);border:1px solid var(--border);border-radius:5px;
      padding:3px 9px;font-size:11px;cursor:pointer}
    .copy:hover{color:var(--text);border-color:var(--blue)}
    .copy.done{color:var(--green);border-color:var(--green)}
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
      <p class="muted" style="margin-top:6px">The keys only exist while one of
      these commands is running, and only on the machine you type the passphrase
      into. Never paste one of these into a server shell, a remote session, or a
      chat.</p>
    </div>
    <p class="muted"><b>The passphrase is never part of a command.</b> Every tool
    that needs it stops and asks, and does not echo what you type &mdash; that is
    what keeps it out of your shell history and out of any log. If a command ever
    seems to want a passphrase as an argument, it is the wrong command.</p>
    <p class="muted" style="margin-top:9px"><b>Nothing sends until you say so.</b>
    <code>vault-sweep.mjs</code> builds and signs the transaction and then stops,
    printing exactly what would leave and where it would go. It broadcasts only
    with <code>--send</code>. <code>wrapdesk-withdraw.mjs</code> is the same with
    <code>--broadcast</code>. Read the dry run first, every time: a transaction
    cannot be taken back.</p>
    <p class="muted" style="margin-top:9px"><b>Destinations are checked.</b> The
    sweeper refuses anything that is not a <code>pc1q</code> address, and verifies
    that the key it derived matches the stored xpub before it signs &mdash; so a
    wrong <code>--system</code> fails loudly instead of signing for the wrong
    wallet.</p>`);

  const reading = group('Reading &mdash; safe at any time',
    'None of these can move a coin. The first two do not even ask for the passphrase.', [
    entry({
      title: 'What does every wallet hold?',
      what: 'Scans all 13 vault wallets against the chain &mdash; both the receive and '
          + 'change branches, 2000 addresses deep &mdash; and prints a balance for each. '
          + 'Uses only the public xpubs, so it needs no passphrase and cannot spend. '
          + 'This is the one to run when the question is &ldquo;where is the money&rdquo;.',
      text: cmd('vault-sweep.mjs --list'),
    }),
    entry({
      title: 'Is the signer still correct?',
      what: 'Signs a transaction from the published BIP143 test vector and checks the '
          + 'result byte-for-byte against the known-good signature, then proves a wrong '
          + 'passphrase is still refused and a bad destination still rejected. Run it '
          + 'after any change to the tool, and before a large sweep if you want the '
          + 'reassurance.',
      text: cmd('vault-sweep.mjs --selftest'),
    }),
    entry({
      title: 'Does my passphrase open every vault?',
      needs: 'passphrase',
      what: 'Asks once, then tries it against all 13 encrypted blobs and ticks off each '
          + 'one it opens. Reads only &mdash; it decrypts, checks, and discards. This is '
          + 'the fastest way to confirm you still have access to everything.',
      text: cmd('vault-sweep.mjs --check-all'),
    }),
    entry({
      title: 'Check one wallet, and see its first address',
      needs: 'passphrase',
      what: 'The same check against a single system, and it prints address 0 so you can '
          + 'compare it against what the service shows. Replace <code>checker</code> with '
          + 'any name from the list below.',
      text: cmd('vault-sweep.mjs --check checker'),
    }),
    entry({
      title: 'Do the backups really contain the right wallets?',
      needs: 'passphrase',
      what: 'A blob can be correctly labelled and still hold the wrong twelve words, and '
          + 'the first time you would find out is with money on the line. This opens every '
          + 'blob, re-derives the wallet from the phrase inside it, and checks that it '
          + 'matches the xpub written on the label. A backup is not a backup until it has '
          + 'been loaded &mdash; this is that load.',
      text: cmd('verify-blobs.mjs'),
    }),
    entry({
      title: 'Which rail does this paper phrase control?',
      what: 'Type the twelve words and it tells you which service they belong to. It '
          + 'derives only the account-level <i>public</i> key &mdash; arithmetic on a public '
          + 'key, no private child, no address, no signing. The phrase is typed at a prompt '
          + 'and never echoed.',
      text: cmd('which-rail.mjs'),
    }),
    entry({
      title: 'Label a stack of paper cards',
      needs: 'passphrase',
      what: 'Prints the first word and account fingerprint of each wallet &mdash; just '
          + 'enough to match a card to a rail without reading out a whole phrase. One BIP39 '
          + 'word leaves about 117 bits of entropy, which is still far out of reach; do not '
          + 'raise <code>--words</code> to satisfy curiosity.',
      text: cmd('first-words.mjs'),
    }),
  ]);

  const moving = group('Moving coins &mdash; read the dry run first',
    'Each of these is shown twice on purpose: the command as it runs by default, which '
  + 'sends nothing, and then the same command with the flag that broadcasts.', [
    entry({
      title: 'Sweep one wallet empty',
      needs: 'passphrase · spends',
      danger: true,
      what: 'Collects every unspent output the wallet owns and sends the whole balance to '
          + 'one address, minus the network fee. Run it exactly as shown first: it prints '
          + 'the inputs, the total, the fee and the destination, and stops.',
      text: cmd('vault-sweep.mjs --system checker --to pc1qYOURADDRESS --all'),
      after: '<p class="muted">Then, once the printed destination and amount are right, '
           + 'the same line with <code>--send</code> on the end:</p>'
           + block(cmd('vault-sweep.mjs --system checker --to pc1qYOURADDRESS --all --send')),
    }),
    entry({
      title: 'Send a specific amount, leaving the rest',
      needs: 'passphrase · spends',
      danger: true,
      what: 'The same thing bounded to an amount in PCN, with the remainder returned to a '
          + 'change address of the same wallet. <b>The fee comes out of the change, not out '
          + 'of the amount</b> &mdash; the destination receives exactly what you asked for, '
          + 'and the wallet keeps slightly less than you might expect. That matters when '
          + 'you are sweeping down to a target balance.',
      text: cmd('vault-sweep.mjs --system market --to pc1qYOURADDRESS --amount 1000'),
      after: note('Add <code>--send</code> to broadcast, exactly as above.'),
    }),
    entry({
      title: 'Take the wPCN surplus',
      needs: 'passphrase · spends · guarded',
      danger: true,
      what: 'The reserve backs every wPCN one-for-one, so only the amount <i>above</i> the '
          + 'issued supply is yours. The tool refuses this wallet outright unless you add '
          + 'the long flag, which exists so it cannot be swept by reflex. '
          + '<b>Read the current surplus from <code>wrapdesk.pc.am/proof</code> and round '
          + 'DOWN</b> &mdash; the fee comes out of the change, so taking the exact figure '
          + 'leaves the reserve a hair under 1:1 and the public proof page stops saying '
          + '&ldquo;fully backed&rdquo;.',
      text: cmd('vault-sweep.mjs --system wpcn-reserve --to pc1qYOURADDRESS \\\n'
              + '  --amount <SURPLUS> --i-know-the-reserve-backs-wpcn \
'
              + '  --change-to pc1q7hhzmdkkx0zjtzj6qkwmuvhlgwfqjrc6j2dk52'),
      after: note('Add <code>--send</code> to broadcast. Never <code>--all</code> on this '
                + 'wallet: it would unback every wPCN in circulation.'),
    }),
    entry({
      title: 'Return one over-limit wrap deposit',
      needs: 'passphrase · spends',
      danger: true,
      what: 'Spends <i>named</i> outputs of the wPCN reserve and nothing else &mdash; built '
          + 'for returning a deposit that was too large to wrap. You give it the exact '
          + '<code>txid:vout</code> to spend and the deposit index it came from, so it '
          + 'cannot reach the rest of the reserve. Broadcasts only with '
          + '<code>--broadcast</code>.',
      text: cmd('wrapdesk-withdraw.mjs --index 3 --to pc1qTHEIRADDRESS \\\n'
              + '  --utxo <txid>:<vout>'),
      after: note('<code>node wrapdesk-withdraw.mjs --selftest</code> proves the signer '
                + 'first, and takes no keys to run.'),
    }),
  ]);

  const making = group('Creating, restoring and sealing',
    'These make new wallets or open sealed backups. The twelve words appear on screen '
  + 'exactly once, and only on your machine.', [
    entry({
      title: 'Create a wallet for a new service',
      needs: 'passphrase',
      what: 'Generates twelve words, shows them once, derives the account xpub at '
          + 'm/84&#39;/9444&#39;/0&#39;, and writes two files: the public '
          + '<code>-xpub.txt</code> that goes to the server, and the encrypted '
          + '<code>-seed.enc.json</code> that goes to both vault hosts. The private side '
          + 'never leaves the machine you run this on.',
      text: cmd('pcoin-seed-vault.mjs new --system <name>'),
    }),
    entry({
      title: 'Generate the deposit-address pool for a service',
      needs: 'passphrase',
      what: 'Derives a flat list of addresses for the server to hand out, one per customer. '
          + 'The server gets only this list &mdash; never the seed and never the xpub &mdash; '
          + 'so it can watch deposits and cannot spend them.',
      text: cmd('pcoin-seed-vault.mjs pool --system <name> --count 1000 --start 0'),
    }),
    entry({
      title: 'Read the twelve words back out',
      needs: 'passphrase',
      what: 'Prints the phrase from a sealed blob, for writing onto paper or restoring into '
          + 'a wallet app. Everything else on this page avoids showing the words; this one '
          + 'is the deliberate exception, so run it when nobody is looking over your '
          + 'shoulder and nothing is recording the screen.',
      text: cmd('pcoin-seed-vault.mjs restore --file <name>-seed.enc.json'),
    }),
    entry({
      title: 'Check a sealed blob opens, without printing anything secret',
      needs: 'passphrase',
      what: 'Opens the blob, re-derives, and reports whether it matches its own label. Use '
          + 'this rather than <code>restore</code> whenever the question is just '
          + '&ldquo;does this still work&rdquo;.',
      text: cmd('pcoin-seed-vault.mjs verify --file <name>-seed.enc.json'),
    }),
    entry({
      title: 'Seal a secret that is not a seed phrase',
      needs: 'passphrase',
      what: 'The same encrypted format for things that are not twelve words &mdash; a raw '
          + 'EVM private key, a bearer token, an API secret. It refuses to overwrite an '
          + 'existing blob and refuses to seal an empty file.',
      text: cmd('pcoin-key-seal.mjs seal --in <secret file> --out <name>.enc.json'),
    }),
    entry({
      title: 'Back up everything off-repo into one blob',
      needs: 'passphrase',
      what: 'Encrypts the files that cannot be regenerated &mdash; the Android release '
          + 'keystore, TLS keys, the server and secrets notes &mdash; into a single blob '
          + 'that can safely sit in three places. <code>list</code> shows what is inside '
          + 'without unpacking it; <code>restore</code> writes it back out.',
      text: cmd('pcoin-vault-bundle.mjs pack --root D:\\pc.am --out pcoin-bundle.enc.json'),
      after: note('Then <code>node pcoin-vault-bundle.mjs verify --file pcoin-bundle.enc.json</code> '
                + '&mdash; a backup nobody has opened is not yet a backup.'),
    }),
  ]);

  const systems = card('The wallet names', `
    <p class="muted">Anywhere a command above says <code>--system &lt;name&gt;</code>, it
    takes one of these:</p>
    <p style="margin:10px 0"><code>3dmodels</code> · <code>aicontrol</code> ·
    <code>checker</code> · <code>exchange</code> · <code>market-hot</code> ·
    <code>market</code> · <code>oonak3d</code> · <code>pcnaibot</code> ·
    <code>pcnearner</code> · <code>portrait2video</code> · <code>webai</code> ·
    <code>webbuilderbot</code> · <code>wpcn-reserve</code></p>
    <p class="muted"><b>Three of them will not sweep, and each refusal is deliberate:</b></p>
    <ul class="muted" style="margin:8px 0 0 20px;line-height:1.7">
      <li><code>exchange</code> &mdash; refused outright. Those are customers&#39; deposits
      and the exchange&#39;s own solvency check counts them.</li>
      <li><code>wpcn-reserve</code> &mdash; refused without the long flag, because it backs
      every wPCN in circulation.</li>
      <li><code>market-hot</code> &mdash; watch-only here. It is a Core-generated wallet with
      no twelve words, so it is signed where it lives, not from this machine.</li>
    </ul>`);

  return style + intro + reading + moving + making + systems + script;
}
