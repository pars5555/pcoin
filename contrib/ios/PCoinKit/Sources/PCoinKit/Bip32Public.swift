import Foundation

/// BIP32 public-parent derivation (CKDpub), and the xpub that carries it.
///
/// WHY THIS EXISTS ON iOS AND NOT ON ANDROID. Reading a balance must not require
/// an unlock -- nobody expects Face ID to look at their own money, and the
/// Android wallet does not ask for it either, because the node inside the app
/// already holds the descriptors. This app has no node, so it derives its own
/// addresses, and doing that from the PHRASE would mean prompting for Face ID
/// every time the home screen refreshed.
///
/// An account xpub is public information. It can derive every address the wallet
/// owns and it can spend nothing. So the wallet keeps one, ungated, and touches
/// the phrase only for a spend or for a deliberate "show me my words".
///
/// The cost is stated plainly: anyone who obtains the xpub learns every address
/// this wallet has ever used and can watch its whole balance. That is a privacy
/// loss, not a theft risk. It is stored in the Keychain as
/// `...WhenUnlockedThisDeviceOnly` for that reason.
public extension Bip32 {

    /// An extended PUBLIC key. Nothing here is secret.
    final class ExtendedPublicKey {
        public let publicKey: [UInt8]
        public let chainCode: [UInt8]
        public let depth: UInt8
        public let parentFingerprint: [UInt8]
        public let childNumber: UInt32

        public init(
            publicKey: [UInt8],
            chainCode: [UInt8],
            depth: UInt8,
            parentFingerprint: [UInt8],
            childNumber: UInt32
        ) {
            precondition(publicKey.count == 33, "public key must be 33 compressed bytes")
            precondition(chainCode.count == 32, "chain code must be 32 bytes")
            precondition(parentFingerprint.count == 4, "fingerprint must be 4 bytes")
            self.publicKey = publicKey
            self.chainCode = chainCode
            self.depth = depth
            self.parentFingerprint = parentFingerprint
            self.childNumber = childNumber
        }

        public var identifier: [UInt8] { Hashes.hash160(publicKey) }
        public var fingerprint: [UInt8] { Array(identifier[0..<4]) }

        public func serialize(versionBytes: [UInt8]) -> String {
            precondition(versionBytes.count == 4)
            var out = [UInt8]()
            out.reserveCapacity(78)
            out.append(contentsOf: versionBytes)
            out.append(depth)
            out.append(contentsOf: parentFingerprint)
            out.append(UInt8((childNumber >> 24) & 0xFF))
            out.append(UInt8((childNumber >> 16) & 0xFF))
            out.append(UInt8((childNumber >> 8) & 0xFF))
            out.append(UInt8(childNumber & 0xFF))
            out.append(contentsOf: chainCode)
            out.append(contentsOf: publicKey)
            return Base58.encodeCheck(out)
        }

        /// Parse an "xpub..." string.
        ///
        /// Checks the version bytes against the ones passed in rather than
        /// accepting anything that decodes: PCoin kept Bitcoin version bytes, so
        /// a PCoin xpub and a Bitcoin xpub are indistinguishable by prefix, and
        /// the coin type in the path is what separates the trees. Nothing here
        /// can tell which chain an xpub came from, and this deliberately does
        /// not pretend to.
        public static func parse(_ text: String, versionBytes: [UInt8]) -> ExtendedPublicKey? {
            guard let raw = Base58.decodeCheck(text), raw.count == 78 else { return nil }
            guard Array(raw[0..<4]) == versionBytes else { return nil }
            let depth = raw[4]
            let parentFingerprint = Array(raw[5..<9])
            let childNumber = (UInt32(raw[9]) << 24) | (UInt32(raw[10]) << 16)
                | (UInt32(raw[11]) << 8) | UInt32(raw[12])
            let chainCode = Array(raw[13..<45])
            let key = Array(raw[45..<78])
            guard key.count == 33, key[0] == 0x02 || key[0] == 0x03 else { return nil }
            guard Secp256k1.isValidPublicKey(key) else { return nil }
            return ExtendedPublicKey(
                publicKey: key,
                chainCode: chainCode,
                depth: depth,
                parentFingerprint: parentFingerprint,
                childNumber: childNumber
            )
        }
    }

    /// One CKDpub step.
    ///
    /// Returns nil for a hardened index -- not as a failure to handle, but
    /// because it is impossible: hardened derivation hashes the PRIVATE key, and
    /// that is exactly the property that makes an xpub safe to hold.
    static func deriveChildPublic(
        _ parent: ExtendedPublicKey, index: UInt32
    ) -> ExtendedPublicKey? {
        guard index & hardenedBit == 0 else { return nil }

        var data = [UInt8]()
        data.reserveCapacity(37)
        data.append(contentsOf: parent.publicKey)
        data.append(UInt8((index >> 24) & 0xFF))
        data.append(UInt8((index >> 16) & 0xFF))
        data.append(UInt8((index >> 8) & 0xFF))
        data.append(UInt8(index & 0xFF))

        let i = Hashes.hmacSha512(key: parent.chainCode, data: data)
        let il = Array(i[0..<32])
        let ir = Array(i[32..<64])

        // Nil here is BIP32 "invalid, move to the next index", the same ~2^-127
        // case the private path handles.
        guard let child = Secp256k1.publicKeyTweakAdd(parent.publicKey, tweak: il) else {
            return nil
        }
        return ExtendedPublicKey(
            publicKey: child,
            chainCode: ir,
            depth: parent.depth &+ 1,
            parentFingerprint: parent.fingerprint,
            childNumber: index
        )
    }

    static func derivePublicPath(
        _ account: ExtendedPublicKey, path: [UInt32]
    ) throws -> ExtendedPublicKey {
        var node = account
        for rawIndex in path {
            var index = rawIndex
            var child = deriveChildPublic(node, index: index)
            var guardCount = 0
            while child == nil {
                guardCount += 1
                if guardCount >= 8 { throw Error.derivationFailedRepeatedly(index: rawIndex) }
                index &+= 1
                child = deriveChildPublic(node, index: index)
            }
            node = child!
        }
        return node
    }
}

public extension PcoinDerivation {

    /// Everything the wallet needs to WATCH itself: derive addresses, total a
    /// balance, list history. It can sign nothing.
    struct WatchOnlyKeys {
        public let network: Network
        public let masterFingerprintHex: String
        private let accountKey: Bip32.ExtendedPublicKey

        public init(
            network: Network, masterFingerprintHex: String, accountKey: Bip32.ExtendedPublicKey
        ) {
            self.network = network
            self.masterFingerprintHex = masterFingerprintHex
            self.accountKey = accountKey
        }

        /// Rebuild from what was cached: the xpub string and the fingerprint.
        public static func parse(
            xpub: String, masterFingerprintHex: String, network: Network = .mainnet
        ) -> WatchOnlyKeys? {
            guard let k = Bip32.ExtendedPublicKey.parse(
                xpub, versionBytes: network.extPublicKeyVersion
            ) else { return nil }
            return WatchOnlyKeys(
                network: network, masterFingerprintHex: masterFingerprintHex, accountKey: k
            )
        }

        public func accountXpub() -> String {
            accountKey.serialize(versionBytes: network.extPublicKeyVersion)
        }

        public func address(chain: UInt32, index: UInt32) throws -> String {
            let leaf = try Bip32.derivePublicPath(accountKey, path: [chain, index])
            return Bech32.encodeP2wpkh(
                hrp: network.bech32Hrp, pubKeyHash: Hashes.hash160(leaf.publicKey)
            )
        }

        public func receiveAddress() throws -> String {
            try address(chain: chainExternal, index: 0)
        }

        public func publicDescriptor(chain: UInt32) -> String {
            let origin = originString(
                masterFingerprintHex: masterFingerprintHex, network: network
            )
            return "wpkh(\(origin)\(accountXpub())/\(chain)/*)"
        }
    }
}

public extension PcoinDerivation.AccountKeys {
    /// The watch-only half of this wallet. Safe to persist ungated.
    func watchOnly() -> PcoinDerivation.WatchOnlyKeys? {
        PcoinDerivation.WatchOnlyKeys.parse(
            xpub: accountXpub(),
            masterFingerprintHex: masterFingerprintHex,
            network: network
        )
    }
}
