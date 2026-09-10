import Foundation

/// RIPEMD-160, per the original Dobbertin/Bosselaers/Preneel specification.
///
/// Ported line for line from the Android wallet's `Hashes.ripemd160`
/// (`contrib/android/.../wallet/Hashes.kt`), for the same reason it exists
/// there: the function is in neither CryptoKit nor CommonCrypto, and HASH160 is
/// what turns a public key into an address. A wrong RIPEMD-160 does not fail
/// loudly -- it produces a perfectly well-formed address belonging to nobody.
///
/// Verified in `HashesTests` against the specification's own vectors, including
/// the "million a" case, and end to end by the BIP32 vectors, whose key
/// identifiers are HASH160 values.
public enum RIPEMD160 {

    public static func hash(_ message: [UInt8]) -> [UInt8] {
        var h0: UInt32 = 0x67452301
        var h1: UInt32 = 0xEFCDAB89
        var h2: UInt32 = 0x98BADCFE
        var h3: UInt32 = 0x10325476
        var h4: UInt32 = 0xC3D2E1F0

        // MD4-style padding: 0x80, zero fill to 56 mod 64, 64-bit LE bit length.
        let bitLen = UInt64(message.count) &* 8
        let padLen = ((55 - message.count) % 64 + 64) % 64 + 1
        var padded = message
        padded.append(0x80)
        padded.append(contentsOf: [UInt8](repeating: 0, count: padLen - 1))
        for i in 0..<8 { padded.append(UInt8((bitLen >> (8 * UInt64(i))) & 0xFF)) }

        var x = [UInt32](repeating: 0, count: 16)
        var pos = 0
        while pos < padded.count {
            for i in 0..<16 {
                let b = pos + i * 4
                x[i] = UInt32(padded[b])
                    | (UInt32(padded[b + 1]) << 8)
                    | (UInt32(padded[b + 2]) << 16)
                    | (UInt32(padded[b + 3]) << 24)
            }

            var a = h0, b = h1, c = h2, d = h3, e = h4
            var aa = h0, bb = h1, cc = h2, dd = h3, ee = h4

            for j in 0..<80 {
                var t = a &+ f(j, b, c, d) &+ x[RL[j]] &+ K[j / 16]
                t = rol(t, SL[j]) &+ e
                a = e; e = d; d = rol(c, 10); c = b; b = t

                t = aa &+ f(79 - j, bb, cc, dd) &+ x[RR[j]] &+ KK[j / 16]
                t = rol(t, SR[j]) &+ ee
                aa = ee; ee = dd; dd = rol(cc, 10); cc = bb; bb = t
            }

            let tmp = h1 &+ c &+ dd
            h1 = h2 &+ d &+ ee
            h2 = h3 &+ e &+ aa
            h3 = h4 &+ a &+ bb
            h4 = h0 &+ b &+ cc
            h0 = tmp

            pos += 64
        }

        var out = [UInt8]()
        out.reserveCapacity(20)
        for v in [h0, h1, h2, h3, h4] {
            out.append(UInt8(v & 0xFF))
            out.append(UInt8((v >> 8) & 0xFF))
            out.append(UInt8((v >> 16) & 0xFF))
            out.append(UInt8((v >> 24) & 0xFF))
        }
        return out
    }

    private static func rol(_ v: UInt32, _ n: Int) -> UInt32 {
        (v << UInt32(n)) | (v >> UInt32(32 - n))
    }

    private static func f(_ j: Int, _ x: UInt32, _ y: UInt32, _ z: UInt32) -> UInt32 {
        switch j / 16 {
        case 0: return x ^ y ^ z
        case 1: return (x & y) | (~x & z)
        case 2: return (x | ~y) ^ z
        case 3: return (x & z) | (y & ~z)
        default: return x ^ (y | ~z)
        }
    }

    private static let K: [UInt32] = [0x00000000, 0x5A827999, 0x6ED9EBA1, 0x8F1BBCDC, 0xA953FD4E]
    private static let KK: [UInt32] = [0x50A28BE6, 0x5C4DD124, 0x6D703EF3, 0x7A6D76E9, 0x00000000]

    /// Message-word order, left line.
    private static let RL: [Int] = [
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
        7, 4, 13, 1, 10, 6, 15, 3, 12, 0, 9, 5, 2, 14, 11, 8,
        3, 10, 14, 4, 9, 15, 8, 1, 2, 7, 0, 6, 13, 11, 5, 12,
        1, 9, 11, 10, 0, 8, 12, 4, 13, 3, 7, 15, 14, 5, 6, 2,
        4, 0, 5, 9, 7, 12, 2, 10, 14, 1, 3, 8, 11, 6, 15, 13,
    ]

    /// Message-word order, right line.
    private static let RR: [Int] = [
        5, 14, 7, 0, 9, 2, 11, 4, 13, 6, 15, 8, 1, 10, 3, 12,
        6, 11, 3, 7, 0, 13, 5, 10, 14, 15, 8, 12, 4, 9, 1, 2,
        15, 5, 1, 3, 7, 14, 6, 9, 11, 8, 12, 2, 10, 0, 4, 13,
        8, 6, 4, 1, 3, 11, 15, 0, 5, 12, 2, 13, 9, 7, 10, 14,
        12, 15, 10, 4, 1, 5, 8, 7, 6, 2, 13, 14, 0, 3, 9, 11,
    ]

    /// Rotate-left amounts, left line.
    private static let SL: [Int] = [
        11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8,
        7, 6, 8, 13, 11, 9, 7, 15, 7, 12, 15, 9, 11, 7, 13, 12,
        11, 13, 6, 7, 14, 9, 13, 15, 14, 8, 13, 6, 5, 12, 7, 5,
        11, 12, 14, 15, 14, 15, 9, 8, 9, 14, 5, 6, 8, 6, 5, 12,
        9, 15, 5, 11, 6, 8, 13, 12, 5, 12, 13, 14, 11, 8, 5, 6,
    ]

    /// Rotate-left amounts, right line.
    private static let SR: [Int] = [
        8, 9, 9, 11, 13, 15, 15, 5, 7, 7, 8, 11, 14, 14, 12, 6,
        9, 13, 15, 7, 12, 8, 9, 11, 7, 7, 12, 7, 6, 15, 13, 11,
        9, 7, 15, 11, 8, 6, 6, 14, 12, 13, 5, 14, 13, 13, 7, 5,
        15, 5, 8, 11, 14, 14, 6, 14, 6, 9, 12, 9, 12, 5, 15, 8,
        8, 5, 12, 9, 12, 5, 14, 6, 8, 13, 6, 5, 15, 13, 11, 11,
    ]
}
