// The entry point of transfer-crypto.bundle.js -- the ONLY cryptography the
// "Move PCN" page (transfer.mjs) runs in the owner's browser.
//
// It re-exports, and adds nothing to, the audited @noble / @scure packages that
// contrib/vault/node_modules already pins for vault-sweep.mjs and
// pcoin-seed-vault.mjs (versions in contrib/vault/package-lock.json, all 2.3.0).
// The browser signer and the terminal signer therefore run the SAME library
// code, which is what makes "byte-identical to vault-sweep" a claim a test can
// check rather than a hope.
//
// What each export is for, so a reviewer can see nothing here is spare:
//   scrypt, scryptAsync     open the encrypted seed blob (N=2^17 r=8 p=1)
//   sha256, ripemd160       hash160 for addresses, hash256 for sighash and txid
//   sha512, hmac, pbkdf2    what BIP32 and BIP39 are built from; exported so
//                           the tests can pin them against published vectors
//   secp256k1               RFC6979 low-S signing and self-verification
//   HDKey                   the account at m/84'/9444'/0' and its children
//   mnemonicToSeedSync,
//   validateMnemonic,
//   wordlist                BIP39, exactly as vault-sweep calls it
//   bech32                  pc1q... addresses, checksum included
//
// AES-256-GCM is NOT here: the browser's own WebCrypto does it (crypto.subtle),
// so no third-party code touches the decryption key's use.
//
// REBUILD: see the header of transfer.mjs. The output is committed, and its
// SHA-256 is pinned there; a rebuild that changes one byte fails the tests
// until the pin is updated on purpose.
export { scrypt, scryptAsync } from '@noble/hashes/scrypt.js';
export { sha256, sha512 } from '@noble/hashes/sha2.js';
export { hmac } from '@noble/hashes/hmac.js';
export { pbkdf2 } from '@noble/hashes/pbkdf2.js';
export { ripemd160 } from '@noble/hashes/legacy.js';
export { secp256k1 } from '@noble/curves/secp256k1.js';
export { HDKey } from '@scure/bip32';
export { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
export { wordlist } from '@scure/bip39/wordlists/english.js';
export { bech32 } from '@scure/base';
