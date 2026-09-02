// Which PCN deposit rail does this recovery phrase control?
//
// WHY THIS EXISTS. Five services take PCN deposits. Each holds only an account
// xpub, so no server can spend -- the money moves only with the 12 words, which
// live on paper. But nothing recorded WHICH phrase belongs to WHICH service, so
// nobody could tell which paper reaches which balance. This answers that in
// about a minute per phrase.
//
// SAFE BY CONSTRUCTION:
//   * the phrase is typed at a prompt, never passed as an argument -- so it
//     cannot land in shell history, `ps` output, or a process list;
//   * input is not echoed;
//   * only the ACCOUNT-LEVEL PUBLIC key is derived. No private child, no
//     address, no signing. It is arithmetic on a public key;
//   * nothing is written to disk, ever;
//   * it prints a rail name and a fingerprint. It never prints the phrase.
//
// Coin type 9444' is load-bearing: PCoin kept Bitcoin's xprv/xpub version
// bytes, so the SAME phrase under coin type 0' derives live BITCOIN keys.
//
//   cd contrib/vault && node which-rail.mjs
//
import { createInterface } from 'node:readline';
import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { HDKey } from '@scure/bip32';

const ACCOUNT_PATH = "m/84'/9444'/0'";

// Account fingerprints, verified 2026-08-21: each xpub below was taken from the
// running service and confirmed to derive that service's known deposit address
// at 0/0. See PCOIN-SECRETS.md 12.3-12.7.
const RAILS = {
  // Hosts are in PCOIN-SERVERS.md (off-repo): these rails are behind Cloudflare,
  // so their origin addresses do not belong in a public tree.
  '84147040': 'webbuilderbot',
  '48769b4c': '3dmodels.pc.am         (container on the webbuilderbot host)',
  'b7d3c3e7': '3dmodel.oonak.ai',
  '90762186': 'aicontrol.pc.am        (webbuilderbot host)',
  '61d91155': 'checker.pc.am          (seed 4)',
  // The custody wallet in 12.1. It backs no live rail, but identifying it is
  // still a useful answer.
  //
  // NOTE THE DERIVATION LEVEL. Section 12.1 records the MASTER fingerprint
  // (8bfd604e); every value in this table is the ACCOUNT fingerprint at
  // m/84'/9444'/0'. They are different keys, so comparing one against the other
  // silently never matches -- which is exactly what happened the first time this
  // table was written.
  'db4dbc69': 'aicontrol-custody      (section 12.1 -- NOT a live deposit rail)',
};

function ask(q) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // TRUE echo suppression. The first version redrew the prompt with an escape
    // code, which LOOKS like masking and is not: readline had already echoed
    // every keystroke, so the phrase sat in the terminal scrollback. Overriding
    // _writeToOutput is what actually stops characters reaching the screen.
    const NL = String.fromCharCode(10);   // written this way so no escape can be mangled in transit
    let muted = false;
    rl._writeToOutput = function (str) {
      if (!muted) { rl.output.write(str); return; }
      if (str.includes(NL)) rl.output.write(NL);   // keep newlines, drop the typed characters
    };
    rl.output.write(q);
    muted = true;
    rl.question('', (a) => { muted = false; rl.close(); resolve(a); });
  });
}

const raw = await ask('Recovery phrase (not echoed, not saved): ');
const phrase = raw.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();

if (!phrase) { console.log('\nNothing entered.'); process.exit(1); }
if (!bip39.validateMnemonic(phrase, wordlist)) {
  console.log('\nThat is not a valid BIP39 phrase.');
  console.log('Check for a typo or a wrong word -- the checksum did not pass.');
  console.log('Nothing was derived and nothing was written.');
  process.exit(1);
}

const acct = HDKey.fromMasterSeed(bip39.mnemonicToSeedSync(phrase, ''))
                  .derive(ACCOUNT_PATH);
const fp = Buffer.from(acct.identifier.slice(0, 4)).toString('hex');
const hit = RAILS[fp];

console.log('');
console.log('  account fingerprint : ' + fp);
console.log('  account xpub        : ' + acct.publicExtendedKey.slice(0, 24) + '...');
console.log('');
if (hit) {
  console.log('  THIS PHRASE CONTROLS : ' + hit);
  console.log('');
  console.log('  Write that against the matching table in PCOIN-SECRETS.md 12.3-12.7,');
  console.log('  next to "Seed", and keep the paper where it already is.');
} else {
  console.log('  THIS PHRASE MATCHES NONE of the five live rails or the two custody');
  console.log('  wallets. It is a different wallet -- possibly a miner or treasury');
  console.log('  phrase. Do not discard it on that basis; just label it and move on.');
}
console.log('');
