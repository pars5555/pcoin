import Foundation
import CSecp256k1

/// The curve, as the chain itself computes it.
///
/// This is a thin wrapper over the vendored libsecp256k1 -- the same library the
/// PCoin node links against. Two reasons it is not a Swift reimplementation:
///
/// 1. **iOS signs.** The Android wallet has its own small Kotlin curve, and says
///    of it, correctly, "It must never be reused for signing": it is a plain
///    double-and-add ladder, not constant time. Android gets away with that
///    because the node inside the app does the signing. There is no node inside
///    an iOS app, so every spend is signed here, with a live private key, on a
///    device that runs other people's code. That is precisely the case the
///    Kotlin file rules itself out of.
/// 2. **A signature the network rejects is indistinguishable from a wallet that
///    is broken.** Using the same implementation as the validator removes a
///    whole class of "works in the test, not on the chain".
///
/// Nonce generation is libsecp256k1's default: RFC6979, deterministic. Two
/// signatures over the same message with the same key are byte-identical, which
/// is what makes signing testable at all.
public enum Secp256k1 {

    public enum Error: Swift.Error, Equatable {
        case invalidPrivateKey
        case invalidPublicKey
        case signingFailed
        case serializationFailed
    }

    /// One context for the process.
    ///
    /// Created once and randomized once. `secp256k1_context_randomize` blinds
    /// the scalar multiplications against side-channel leakage; the library
    /// recommends it for any context that will sign, and this one does.
    private static let ctx: OpaquePointer = {
        guard let c = secp256k1_context_create(UInt32(SECP256K1_CONTEXT_NONE)) else {
            // Only reachable on allocation failure, where nothing else will
            // work either.
            fatalError("secp256k1 context could not be created")
        }
        var seed = [UInt8](repeating: 0, count: 32)
        let rc = SecRandomCopyBytes(kSecRandomDefault, 32, &seed)
        if rc == errSecSuccess {
            _ = secp256k1_context_randomize(c, seed)
        }
        // If the system CSPRNG refuses, the context is still correct -- it is
        // only unblinded. Refusing to start the wallet over that would trade a
        // side-channel hardening measure for a total outage.
        Redact.wipe(&seed)
        return c
    }()

    /// Is this 32-byte scalar a usable private key, i.e. in [1, n)?
    public static func isValidPrivateKey(_ key: [UInt8]) -> Bool {
        guard key.count == 32 else { return false }
        return secp256k1_ec_seckey_verify(ctx, key) == 1
    }

    /// Compressed SEC1 public key (33 bytes: 0x02/0x03 || X) for `privKey`.
    public static func publicKeyCompressed(_ privKey: [UInt8]) throws -> [UInt8] {
        guard privKey.count == 32 else { throw Error.invalidPrivateKey }
        var pub = secp256k1_pubkey()
        guard secp256k1_ec_pubkey_create(ctx, &pub, privKey) == 1 else {
            throw Error.invalidPrivateKey
        }
        var out = [UInt8](repeating: 0, count: 33)
        var len = 33
        guard secp256k1_ec_pubkey_serialize(
            ctx, &out, &len, &pub, UInt32(SECP256K1_EC_COMPRESSED)
        ) == 1, len == 33 else {
            throw Error.serializationFailed
        }
        return out
    }

    /// `seckey + tweak (mod n)`, which is BIP32's CKDpriv step.
    ///
    /// Returns nil for the cases BIP32 calls invalid -- a tweak at or above the
    /// curve order, or a sum of zero -- because BIP32's specified behaviour
    /// there is to move to the next child index, not to fail. Roughly a 2^-127
    /// event; `Bip32.derivePath` implements the retry.
    public static func privateKeyTweakAdd(_ seckey: [UInt8], tweak: [UInt8]) -> [UInt8]? {
        guard seckey.count == 32, tweak.count == 32 else { return nil }
        var out = seckey
        guard secp256k1_ec_seckey_tweak_add(ctx, &out, tweak) == 1 else { return nil }
        return out
    }

    /// `pubkey + tweak*G`, which is BIP32 CKDpub.
    ///
    /// The public counterpart of `privateKeyTweakAdd`, and it exists for one
    /// reason: reading a balance must not require an unlock. An account xpub is
    /// public information, so the wallet can derive every address it owns
    /// without touching the phrase, and Face ID is asked for only when
    /// something is actually being spent.
    ///
    /// Non-hardened indices only -- hardened derivation is impossible from a
    /// public key by construction, which is the whole point of the split.
    public static func publicKeyTweakAdd(_ pubkey: [UInt8], tweak: [UInt8]) -> [UInt8]? {
        guard tweak.count == 32 else { return nil }
        var pub = secp256k1_pubkey()
        guard secp256k1_ec_pubkey_parse(ctx, &pub, pubkey, pubkey.count) == 1 else { return nil }
        guard secp256k1_ec_pubkey_tweak_add(ctx, &pub, tweak) == 1 else { return nil }
        var out = [UInt8](repeating: 0, count: 33)
        var len = 33
        guard secp256k1_ec_pubkey_serialize(
            ctx, &out, &len, &pub, UInt32(SECP256K1_EC_COMPRESSED)
        ) == 1, len == 33 else {
            return nil
        }
        return out
    }

    /// Is this 33- or 65-byte string a point on the curve?
    public static func isValidPublicKey(_ key: [UInt8]) -> Bool {
        var pub = secp256k1_pubkey()
        return secp256k1_ec_pubkey_parse(ctx, &pub, key, key.count) == 1
    }

    /// A DER-encoded ECDSA signature over a 32-byte message hash.
    ///
    /// Low-S normalised, which libsecp256k1 does by default: Bitcoin Core (and
    /// therefore every PCoin node) enforces BIP62's low-S rule as a relay
    /// policy, so a high-S signature produces a transaction that is valid by
    /// consensus and that nobody will forward. That is the worst kind of
    /// failure -- it looks like the network is down.
    public static func signDER(messageHash: [UInt8], privateKey: [UInt8]) throws -> [UInt8] {
        guard messageHash.count == 32 else { throw Error.signingFailed }
        guard privateKey.count == 32 else { throw Error.invalidPrivateKey }
        var sig = secp256k1_ecdsa_signature()
        guard secp256k1_ecdsa_sign(ctx, &sig, messageHash, privateKey, nil, nil) == 1 else {
            throw Error.signingFailed
        }
        var der = [UInt8](repeating: 0, count: 72)
        var len = 72
        guard secp256k1_ecdsa_signature_serialize_der(ctx, &der, &len, &sig) == 1 else {
            throw Error.serializationFailed
        }
        return Array(der[0..<len])
    }

    /// Verify a DER signature. Used by the tests and by `TxBuilder`'s own
    /// check that what it just signed actually verifies before it is broadcast.
    public static func verifyDER(
        signature der: [UInt8], messageHash: [UInt8], publicKey: [UInt8]
    ) -> Bool {
        guard messageHash.count == 32 else { return false }
        var pub = secp256k1_pubkey()
        guard secp256k1_ec_pubkey_parse(ctx, &pub, publicKey, publicKey.count) == 1 else {
            return false
        }
        var sig = secp256k1_ecdsa_signature()
        guard secp256k1_ecdsa_signature_parse_der(ctx, &sig, der, der.count) == 1 else {
            return false
        }
        return secp256k1_ecdsa_verify(ctx, &sig, messageHash, &pub) == 1
    }
}
