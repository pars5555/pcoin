import Foundation

/// The output-descriptor checksum, as Bitcoin Core computes it
/// (`src/script/descriptor.cpp`, `DescriptorChecksum`).
///
/// The wallet does not need this to spend -- it derives its own addresses. It is
/// here because PCOIN.md 6.4 publishes the two descriptor strings WITH their
/// checksums, and the point of a published vector is that somebody can check it.
/// Computing the checksum lets the test assert the exact strings in the document
/// rather than a prefix of them.
///
/// A checksum covers the exact string, so the same descriptor written with an
/// `xprv` instead of an `xpub` has a different one. That is expected and is
/// noted in the document.
public enum DescriptorChecksum {

    private static let inputCharset =
        "0123456789()[],'/*abcdefgh@:$%{}IJKLMNOPQRSTUVWXYZ&+-.;<=>?!^_|~ijklmnopqrstuvwxyzABCDEFGH`#\"\\ "
    private static let checksumCharset = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"

    /// nil when the descriptor contains a character the charset does not cover,
    /// which means it was never a descriptor.
    public static func checksum(_ descriptor: String) -> String? {
        let input = Array(inputCharset)
        let output = Array(checksumCharset)
        var c: UInt64 = 1
        var cls = 0
        var clscount = 0

        for ch in descriptor {
            guard let pos = input.firstIndex(of: ch) else { return nil }
            c = polymod(c, UInt64(pos & 31))
            cls = cls * 3 + (pos >> 5)
            clscount += 1
            if clscount == 3 {
                c = polymod(c, UInt64(cls))
                cls = 0
                clscount = 0
            }
        }
        if clscount > 0 { c = polymod(c, UInt64(cls)) }
        for _ in 0..<8 { c = polymod(c, 0) }
        c ^= 1

        var out = ""
        for j in 0..<8 {
            out.append(output[Int((c >> (5 * (7 - UInt64(j)))) & 31)])
        }
        return out
    }

    /// The BCH code over GF(32) that Core uses. Constants are from
    /// `descriptor.cpp` and are not the bech32 ones.
    private static func polymod(_ c: UInt64, _ val: UInt64) -> UInt64 {
        let c0 = c >> 35
        var r = ((c & 0x7ff_ffff_ffff) << 5) ^ val
        if (c0 & 1) != 0 { r ^= 0xf5dee51989 }
        if (c0 & 2) != 0 { r ^= 0xa9fdca3312 }
        if (c0 & 4) != 0 { r ^= 0x1bab10e32d }
        if (c0 & 8) != 0 { r ^= 0x3706b1677a }
        if (c0 & 16) != 0 { r ^= 0x644d626ffd }
        return r
    }
}
