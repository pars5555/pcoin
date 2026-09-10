import Foundation

/// PCoin published key derivation.
///
/// This file IS the specification as far as the iOS app is concerned, and it
/// must stay in step with PCOIN.md 6 and with the Android app
/// `wallet/PcoinDerivation.kt`. Any future wallet restoring the same twelve
/// words depends on all three saying exactly the same thing.
///
///     m / 84' / 9444' / account' / change / index
///
/// Purpose 84' is BIP84 (native SegWit P2WPKH), which produces the "pc1q..."
/// bech32 addresses PCoin defaults to.
///
/// Coin type 9444' is PCoin own, matching its P2P port, and is unregistered in
/// SLIP-44. The coin type is load-bearing in a way it is not for most chains:
/// PCoin inherited Bitcoin EXT_SECRET_KEY version bytes, so PCoin extended keys
/// serialise as literal "xprv..." and a Bitcoin xprv parses in a PCoin
/// descriptor. Coin type 0 would therefore make one phrase derive
/// byte-identical keys on both chains. 9444' is the only thing keeping the two
/// trees apart -- never change it, and never use it on a test network, where
/// SLIP-44 universal "coin type 1 = all testnets" applies instead.
public enum PcoinDerivation {

    public struct Network: Equatable {
        public let coinType: UInt32
        /// base58Prefixes[EXT_SECRET_KEY] from kernel/chainparams.cpp.
        public let extSecretKeyVersion: [UInt8]
        /// base58Prefixes[EXT_PUBLIC_KEY] from kernel/chainparams.cpp.
        public let extPublicKeyVersion: [UInt8]
        public let bech32Hrp: String
        /// base58Prefixes[PUBKEY_ADDRESS] -- PCoin mainnet 55, giving "P...".
        public let pubkeyAddressPrefix: UInt8
        /// base58Prefixes[SCRIPT_ADDRESS] -- PCoin mainnet 56.
        public let scriptAddressPrefix: UInt8
        /// Genesis nTime: the true lower bound for a restore rescan.
        public let genesisTime: Int64

        public static let mainnet = Network(
            coinType: 9444,
            extSecretKeyVersion: [0x04, 0x88, 0xAD, 0xE4],
            extPublicKeyVersion: [0x04, 0x88, 0xB2, 0x1E],
            bech32Hrp: Bech32.hrpMainnet,
            pubkeyAddressPrefix: 55,
            scriptAddressPrefix: 56,
            genesisTime: 1_785_600_628
        )

        /// Regtest/testnet share "coin type 1" and the tprv version bytes.
        /// Present so the derivation is testable end to end against a regtest
        /// node without ever putting test coins on the mainnet path.
        public static let regtest = Network(
            coinType: 1,
            extSecretKeyVersion: [0x04, 0x35, 0x83, 0x94],
            extPublicKeyVersion: [0x04, 0x35, 0x87, 0xCF],
            bech32Hrp: Bech32.hrpRegtest,
            pubkeyAddressPrefix: 111,
            scriptAddressPrefix: 196,
            genesisTime: 1_785_600_628
        )
    }

    public static let purpose: UInt32 = 84

    /// Fixed at 0 for v1. Not exposed in the UI; 1', 2', ... are reserved.
    public static let account: UInt32 = 0

    public static let chainExternal: UInt32 = 0
    public static let chainInternal: UInt32 = 1

    /// How far the wallet scans each chain when looking for history.
    ///
    /// Not the BIP44 gap limit (20, a UI concept). The Android wallet imports
    /// 1000 external + 1000 internal descriptors into its own node because that
    /// costs nothing there. Here every address costs one entry in a batched HTTP
    /// call, so the scan walks in windows and stops after `gapLimit` consecutive
    /// unused addresses -- with `scanFloor` addresses always checked, so a
    /// wallet whose first few addresses happen to be unused is not declared
    /// empty. See `WalletScanner`.
    public static let gapLimit = 20
    public static let scanFloor = 40

    /// The mining payout address on Android: index 0, generated once, reused
    /// forever. There is no mining on iOS; this is the receive address.
    public static let payoutPathSuffix: [UInt32] = [chainExternal, 0]

    public static func accountPath(_ network: Network, account: UInt32 = account) -> [UInt32] {
        [Bip32.hardened(purpose), Bip32.hardened(network.coinType), Bip32.hardened(account)]
    }

    /// "m/84h/9444h/0h" -- written with h, identical to ' but safe in JSON and shells.
    public static func accountPathString(_ network: Network, account: UInt32 = account) -> String {
        "m/\(purpose)h/\(network.coinType)h/\(account)h"
    }

    /// The origin field of a descriptor: "[<fingerprint>/84h/9444h/0h]".
    public static func originString(
        masterFingerprintHex: String, network: Network, account: UInt32 = account
    ) -> String {
        "[\(masterFingerprintHex)/\(purpose)h/\(network.coinType)h/\(account)h]"
    }

    /// Everything the wallet needs, derived once from a mnemonic.
    ///
    /// Holds an account-level key, deliberately not the root: a compromise of
    /// this object exposes account 0 and nothing else, and cannot be reversed
    /// into the twelve words. The root private key never outlives `accountKeys`.
    public final class AccountKeys {
        public let network: Network
        public let masterFingerprintHex: String
        private let accountKey: Bip32.ExtendedKey

        init(network: Network, masterFingerprintHex: String, accountKey: Bip32.ExtendedKey) {
            self.network = network
            self.masterFingerprintHex = masterFingerprintHex
            self.accountKey = accountKey
        }

        /// Secret. Never log this, never put it in a notification.
        public func accountXprv() -> String {
            accountKey.serialize(versionBytes: network.extSecretKeyVersion)
        }

        /// Public. This is what `listdescriptors` reports and what the published
        /// vectors in PCOIN.md 6.4 quote.
        public func accountXpub() -> String {
            accountKey.serializePublic(versionBytes: network.extPublicKeyVersion)
        }

        /// The ranged descriptor for one chain, in the private form, e.g.
        /// `wpkh([fp/84h/9444h/0h]xprv.../0/*)`. No checksum -- see
        /// `descriptorWithChecksum`.
        public func descriptor(chain: UInt32) -> String {
            let origin = originString(masterFingerprintHex: masterFingerprintHex, network: network)
            return "wpkh(\(origin)\(accountXprv())/\(chain)/*)"
        }

        /// The public form, which is what the published vectors show.
        public func publicDescriptor(chain: UInt32) -> String {
            let origin = originString(masterFingerprintHex: masterFingerprintHex, network: network)
            return "wpkh(\(origin)\(accountXpub())/\(chain)/*)"
        }

        public func publicDescriptorWithChecksum(chain: UInt32) -> String {
            let d = publicDescriptor(chain: chain)
            return d + "#" + (DescriptorChecksum.checksum(d) ?? "")
        }

        /// The address at m/84'/coin'/0'/change/index, computed locally.
        public func address(chain: UInt32, index: UInt32) throws -> String {
            let leaf = try Bip32.derivePath(accountKey, path: [chain, index])
            defer { leaf.wipe() }
            return Bech32.encodeP2wpkh(
                hrp: network.bech32Hrp, pubKeyHash: Hashes.hash160(leaf.publicKey)
            )
        }

        /// The signing key at m/84'/coin'/0'/change/index.
        ///
        /// SECRET. The only caller is `TxBuilder`, which uses it inside one
        /// function and wipes it before returning. It exists on iOS and has no
        /// counterpart on Android for one reason: Android has a node to do the
        /// signing and this app does not.
        public func privateKey(chain: UInt32, index: UInt32) throws -> Bip32.ExtendedKey {
            try Bip32.derivePath(accountKey, path: [chain, index])
        }

        /// m/84'/coin'/0'/0/0 -- the first receive address.
        public func receiveAddress() throws -> String {
            try address(chain: chainExternal, index: 0)
        }

        public func wipe() { accountKey.wipe() }
    }

    /// mnemonic -> seed -> master -> account key.
    ///
    /// The seed and the master key are wiped before returning: the only secret
    /// that survives this call is the account key.
    public static func accountKeys(
        bip39: Bip39,
        mnemonic: [String],
        network: Network,
        passphrase: String = "",
        account: UInt32 = account
    ) throws -> AccountKeys {
        var seed = bip39.toSeed(mnemonic: mnemonic, passphrase: passphrase)
        defer { Redact.wipe(&seed) }
        let master = try Bip32.fromSeed(seed)
        let fingerprint = master.fingerprint.hex
        let acct = try Bip32.derivePath(master, path: accountPath(network, account: account))
        master.wipe()
        return AccountKeys(network: network, masterFingerprintHex: fingerprint, accountKey: acct)
    }
}
