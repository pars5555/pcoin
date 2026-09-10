import Foundation
import CryptoKit

/// The hash primitives BIP32/BIP39 and transaction signing need, and nothing
/// else.
///
/// SHA-256, SHA-512 and HMAC-SHA512 come from CryptoKit. RIPEMD-160 does not
/// exist on Apple platforms at all, so it lives in `RIPEMD160.swift`.
/// PBKDF2-HMAC-SHA512 is implemented here rather than taken from CommonCrypto's
/// `CCKeyDerivationPBKDF`, for the same reason the Android wallet implements it
/// by hand: BIP39 specifies the password as the raw UTF-8 bytes of the NFKD
/// string, and every convenience API in the neighbourhood wants to re-encode a
/// `String` for you. Raw bytes in, raw bytes out, no interpretation.
public enum Hashes {

    public static func sha256(_ data: [UInt8]) -> [UInt8] {
        Array(SHA256.hash(data: data))
    }

    public static func sha512(_ data: [UInt8]) -> [UInt8] {
        Array(SHA512.hash(data: data))
    }

    public static func doubleSha256(_ data: [UInt8]) -> [UInt8] {
        sha256(sha256(data))
    }

    public static func hmacSha512(key: [UInt8], data: [UInt8]) -> [UInt8] {
        var mac = HMAC<SHA512>(key: SymmetricKey(data: key))
        mac.update(data: data)
        return Array(mac.finalize())
    }

    public static func hmacSha256(key: [UInt8], data: [UInt8]) -> [UInt8] {
        var mac = HMAC<SHA256>(key: SymmetricKey(data: key))
        mac.update(data: data)
        return Array(mac.finalize())
    }

    /// HASH160 = RIPEMD160(SHA256(x)). The Bitcoin pubkey-hash function.
    public static func hash160(_ data: [UInt8]) -> [UInt8] {
        RIPEMD160.hash(sha256(data))
    }

    /// PBKDF2-HMAC-SHA512.
    ///
    /// BIP39 uses 2048 iterations and a 64-byte output, which is exactly one
    /// HMAC-SHA512 block, so the block loop below runs once in practice. It is
    /// written for the general case anyway, because a silently-wrong
    /// multi-block path is worse than a slightly longer function.
    public static func pbkdf2HmacSha512(
        password: [UInt8],
        salt: [UInt8],
        iterations: Int,
        dkLen: Int
    ) -> [UInt8] {
        precondition(iterations > 0, "iterations must be positive")
        precondition(dkLen > 0, "dkLen must be positive")

        let key = SymmetricKey(data: password)
        let hLen = 64
        var out = [UInt8]()
        out.reserveCapacity(dkLen)
        var block: UInt32 = 1

        while out.count < dkLen {
            // U1 = PRF(P, S || INT_32_BE(block))
            var first = salt
            first.append(UInt8((block >> 24) & 0xFF))
            first.append(UInt8((block >> 16) & 0xFF))
            first.append(UInt8((block >> 8) & 0xFF))
            first.append(UInt8(block & 0xFF))

            var u = Array(HMAC<SHA512>.authenticationCode(for: first, using: key))
            var t = u

            if iterations > 1 {
                for _ in 1..<iterations {
                    u = Array(HMAC<SHA512>.authenticationCode(for: u, using: key))
                    for k in 0..<hLen { t[k] ^= u[k] }
                }
            }

            let take = min(hLen, dkLen - out.count)
            out.append(contentsOf: t[0..<take])
            Redact.wipe(&t)
            Redact.wipe(&u)
            Redact.wipe(&first)
            block += 1
        }
        return out
    }
}
