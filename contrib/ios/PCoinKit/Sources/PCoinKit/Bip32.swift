import Foundation

/// BIP32 hierarchical deterministic key derivation.
///
/// Private derivation only, exactly as on Android: the wallet never needs to
/// walk an xpub, and leaving public-parent derivation out means there is no code
/// path that could produce a watch-only branch by accident.
///
/// The HMAC key for the master seed is the literal ASCII string "Bitcoin seed".
/// That constant is part of BIP32 itself, NOT part of any chain parameters:
/// changing it to "PCoin seed" would buy nothing and would make every standard
/// BIP32 library on earth unable to restore a PCoin wallet from the same words.
/// Do not change it.
public enum Bip32 {

    private static let masterHmacKey = Array("Bitcoin seed".utf8)

    /// BIP32 marks a hardened child by setting the top bit of the index.
    public static let hardenedBit: UInt32 = 0x8000_0000

    public static func hardened(_ index: UInt32) -> UInt32 { index | hardenedBit }

    public enum Error: Swift.Error, Equatable {
        case seedLengthOutOfRange
        case invalidMasterKey
        case derivationFailedRepeatedly(index: UInt32)
        case badPathElement(String)
    }

    /// An extended private key.
    ///
    /// `key` is the 32-byte private scalar and `chainCode` the 32-byte chain
    /// code. Both are secrets; nothing in this type ever converts them to a
    /// String except `serialize`, whose result is equally secret and must never
    /// be logged. See `Redact`.
    public final class ExtendedKey {
        public private(set) var key: [UInt8]
        public private(set) var chainCode: [UInt8]
        public let depth: UInt8
        public let parentFingerprint: [UInt8]
        public let childNumber: UInt32

        private var cachedPublicKey: [UInt8]?

        public init(
            key: [UInt8],
            chainCode: [UInt8],
            depth: UInt8,
            parentFingerprint: [UInt8],
            childNumber: UInt32
        ) {
            precondition(key.count == 32, "private key must be 32 bytes")
            precondition(chainCode.count == 32, "chain code must be 32 bytes")
            precondition(parentFingerprint.count == 4, "fingerprint must be 4 bytes")
            self.key = key
            self.chainCode = chainCode
            self.depth = depth
            self.parentFingerprint = parentFingerprint
            self.childNumber = childNumber
        }

        /// Compressed public key (33 bytes). Public information.
        public var publicKey: [UInt8] {
            if let c = cachedPublicKey { return c }
            // The key was validated when this object was built, so the throw
            // below is unreachable; force it rather than hand back an optional
            // that every call site would have to pretend to handle.
            let p = try! Secp256k1.publicKeyCompressed(key)
            cachedPublicKey = p
            return p
        }

        /// HASH160 of the public key: this key own identifier.
        public var identifier: [UInt8] { Hashes.hash160(publicKey) }

        /// First 4 bytes of the identifier, as children record it.
        public var fingerprint: [UInt8] { Array(identifier[0..<4]) }

        /// Base58Check "xprv..." form.
        ///
        /// - Parameter versionBytes: EXT_SECRET_KEY for the target network.
        ///   PCoin mainnet kept Bitcoin 0x0488ADE4, which is precisely why the
        ///   coin type in the derivation path must not be Bitcoin 0.
        public func serialize(versionBytes: [UInt8]) -> String {
            Base58.encodeCheck(header(versionBytes) + [0] + key)
        }

        /// Base58Check "xpub..." form. Public information, unlike `serialize`.
        public func serializePublic(versionBytes: [UInt8]) -> String {
            Base58.encodeCheck(header(versionBytes) + publicKey)
        }

        private func header(_ versionBytes: [UInt8]) -> [UInt8] {
            precondition(versionBytes.count == 4)
            var out = [UInt8]()
            out.reserveCapacity(45)
            out.append(contentsOf: versionBytes)
            out.append(depth)
            out.append(contentsOf: parentFingerprint)
            out.append(UInt8((childNumber >> 24) & 0xFF))
            out.append(UInt8((childNumber >> 16) & 0xFF))
            out.append(UInt8((childNumber >> 8) & 0xFF))
            out.append(UInt8(childNumber & 0xFF))
            out.append(contentsOf: chainCode)
            return out
        }

        /// Overwrites the secret material. Best effort; see `Redact.wipe`.
        public func wipe() {
            Redact.wipe(&key)
            Redact.wipe(&chainCode)
        }
    }

    /// Master key from a BIP39 (or any) seed.
    public static func fromSeed(_ seed: [UInt8]) throws -> ExtendedKey {
        guard seed.count >= 16, seed.count <= 64 else { throw Error.seedLengthOutOfRange }
        var i = Hashes.hmacSha512(key: masterHmacKey, data: seed)
        let il = Array(i[0..<32])
        let ir = Array(i[32..<64])
        Redact.wipe(&i)
        guard Secp256k1.isValidPrivateKey(il) else { throw Error.invalidMasterKey }
        return ExtendedKey(
            key: il, chainCode: ir, depth: 0, parentFingerprint: [0, 0, 0, 0], childNumber: 0
        )
    }

    /// One CKDpriv step.
    ///
    /// Returns nil for the (roughly 2^-127) case BIP32 calls invalid, where the
    /// specified behaviour is to move on to the next index rather than to fail.
    /// `derivePath` implements that.
    public static func deriveChild(_ parent: ExtendedKey, index: UInt32) -> ExtendedKey? {
        var data = [UInt8]()
        data.reserveCapacity(37)
        if index & hardenedBit != 0 {
            data.append(0)
            data.append(contentsOf: parent.key)
        } else {
            data.append(contentsOf: parent.publicKey)
        }
        data.append(UInt8((index >> 24) & 0xFF))
        data.append(UInt8((index >> 16) & 0xFF))
        data.append(UInt8((index >> 8) & 0xFF))
        data.append(UInt8(index & 0xFF))

        var i = Hashes.hmacSha512(key: parent.chainCode, data: data)
        Redact.wipe(&data)
        var il = Array(i[0..<32])
        let ir = Array(i[32..<64])
        Redact.wipe(&i)

        // libsecp256k1 returns 0 for exactly the two cases BIP32 calls invalid:
        // a tweak at or above the curve order, and a resulting scalar of zero.
        guard let child = Secp256k1.privateKeyTweakAdd(parent.key, tweak: il) else {
            Redact.wipe(&il)
            return nil
        }
        Redact.wipe(&il)

        return ExtendedKey(
            key: child,
            chainCode: ir,
            depth: parent.depth &+ 1,
            parentFingerprint: parent.fingerprint,
            childNumber: index
        )
    }

    /// Derives a whole path, e.g. `[hardened(84), hardened(9444), hardened(0), 0, 0]`.
    public static func derivePath(_ master: ExtendedKey, path: [UInt32]) throws -> ExtendedKey {
        var node = master
        for rawIndex in path {
            var index = rawIndex
            var child = deriveChild(node, index: index)
            var guardCount = 0
            while child == nil {
                // BIP32: "proceed with the next value for i". Reaching here at
                // all is a ~2^-127 event; the guard exists so a bug can never
                // turn it into an unbounded loop.
                guardCount += 1
                if guardCount >= 8 { throw Error.derivationFailedRepeatedly(index: rawIndex) }
                index &+= 1
                child = deriveChild(node, index: index)
            }
            node = child!
        }
        return node
    }

    /// Parses "m/84'/9444'/0'/0/0" (also accepts "h" or "H" for hardened).
    public static func parsePath(_ path: String) throws -> [UInt32] {
        let parts = path.trimmingCharacters(in: .whitespaces)
            .split(separator: "/", omittingEmptySubsequences: true)
            .map(String.init)
        var out = [UInt32]()
        for (i, p) in parts.enumerated() {
            if i == 0 && (p == "m" || p == "M") { continue }
            let isHardened = p.hasSuffix("'") || p.hasSuffix("h") || p.hasSuffix("H")
            let numText = isHardened ? String(p.dropLast()) : p
            guard let n = UInt32(numText), n <= 0x7FFF_FFFF else {
                throw Error.badPathElement(p)
            }
            out.append(isHardened ? hardened(n) : n)
        }
        return out
    }
}
