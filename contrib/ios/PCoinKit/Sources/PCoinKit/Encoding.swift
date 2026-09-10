import Foundation

/// Base58Check, as used for extended keys (xprv/xpub) and PCoin legacy
/// `P...` addresses.
public enum Base58 {

    private static let alphabet = Array("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz")

    private static let decodeMap: [Int8] = {
        var m = [Int8](repeating: -1, count: 128)
        for (i, c) in alphabet.enumerated() { m[Int(c.asciiValue!)] = Int8(i) }
        return m
    }()

    public static func encodeCheck(_ payload: [UInt8]) -> String {
        let checksum = Array(Hashes.doubleSha256(payload)[0..<4])
        return encode(payload + checksum)
    }

    /// nil when the string is not base58, or when the checksum does not match.
    ///
    /// The two are deliberately the same answer. A caller asking "is this a
    /// valid address" gets one bit back and cannot accidentally act on a
    /// half-decoded one, which is the mistake this whole app is built to avoid.
    public static func decodeCheck(_ text: String) -> [UInt8]? {
        guard let raw = decode(text), raw.count > 4 else { return nil }
        let payload = Array(raw[0..<(raw.count - 4)])
        let given = Array(raw[(raw.count - 4)...])
        let want = Array(Hashes.doubleSha256(payload)[0..<4])
        var diff: UInt8 = 0
        for i in 0..<4 { diff |= given[i] ^ want[i] }
        return diff == 0 ? payload : nil
    }

    /// Byte-wise long division, the same shape Bitcoin Core uses. No big-integer
    /// type is needed and none is imported.
    public static func encode(_ input: [UInt8]) -> String {
        if input.isEmpty { return "" }
        let leadingZeros = input.prefix(while: { $0 == 0 }).count
        var digits = [UInt8]()
        digits.reserveCapacity(input.count * 138 / 100 + 1)
        for byte in input {
            var carry = Int(byte)
            for i in 0..<digits.count {
                carry += Int(digits[i]) << 8
                digits[i] = UInt8(carry % 58)
                carry /= 58
            }
            while carry > 0 {
                digits.append(UInt8(carry % 58))
                carry /= 58
            }
        }
        var out = String(repeating: alphabet[0], count: leadingZeros)
        for d in digits.reversed() { out.append(alphabet[Int(d)]) }
        return out
    }

    public static func decode(_ text: String) -> [UInt8]? {
        if text.isEmpty { return [] }
        let leadingOnes = text.prefix(while: { $0 == alphabet[0] }).count
        var bytes = [UInt8]()
        bytes.reserveCapacity(text.count)
        for ch in text {
            guard let a = ch.asciiValue, a < 128 else { return nil }
            let v = decodeMap[Int(a)]
            guard v >= 0 else { return nil }
            var carry = Int(v)
            for i in 0..<bytes.count {
                carry += Int(bytes[i]) * 58
                bytes[i] = UInt8(carry & 0xFF)
                carry >>= 8
            }
            while carry > 0 {
                bytes.append(UInt8(carry & 0xFF))
                carry >>= 8
            }
        }
        return [UInt8](repeating: 0, count: leadingOnes) + bytes.reversed()
    }
}

/// Bech32 (BIP173) for P2WPKH addresses.
///
/// Both directions, unlike the Android wallet, which only encodes. That is not a
/// gratuitous addition: Android hands a typed address to its own node and asks
/// `validateaddress`, and there is no node here to ask. An iOS wallet that
/// cannot tell a good address from a bad one either refuses every send or
/// accepts a typo, so decoding is a requirement of the light-client shape rather
/// than a nicety.
///
/// Only witness version 0 is produced. Bech32m (BIP350, witness version 1+) is
/// implemented for DECODING only, and solely so a taproot address can be
/// recognised and refused with an accurate reason instead of "not an address".
public enum Bech32 {

    private static let charset = Array("qpzry9x8gf2tvdw0s3jn54khce6mua7l")

    /// PCoin mainnet HRP, from chainparams.cpp: bech32_hrp = "pc".
    public static let hrpMainnet = "pc"
    /// Regtest/testnet HRP, for completeness.
    public static let hrpRegtest = "pcrt"

    public enum Variant { case bech32, bech32m }

    public struct Decoded {
        public let hrp: String
        public let witnessVersion: UInt8
        public let program: [UInt8]
        public let variant: Variant
    }

    public static func encodeP2wpkh(hrp: String, pubKeyHash: [UInt8]) -> String {
        precondition(pubKeyHash.count == 20, "P2WPKH program must be 20 bytes")
        let data: [UInt8] = [0] + convertBits(pubKeyHash, from: 8, to: 5, pad: true)!
        return encode(hrp: hrp, data: data, variant: .bech32)
    }

    /// Decode a segwit address. nil for anything that is not one.
    ///
    /// Enforces every rule BIP173 states, including the ones that look pedantic:
    /// mixed case is rejected outright (it is what makes the upper-case QR trick
    /// safe), the total length cap is checked, and the witness-version/variant
    /// pairing is checked, because a version-0 program carrying a bech32m
    /// checksum is a different address that happens to look the same.
    public static func decode(_ address: String) -> Decoded? {
        guard address.count >= 8, address.count <= 90 else { return nil }
        let hasUpper = address.contains(where: { $0.isUppercase })
        let hasLower = address.contains(where: { $0.isLowercase })
        if hasUpper && hasLower { return nil }
        let s = address.lowercased()
        guard let sep = s.lastIndex(of: "1") else { return nil }
        let hrp = String(s[s.startIndex..<sep])
        let dataPart = String(s[s.index(after: sep)...])
        guard !hrp.isEmpty, dataPart.count >= 6 else { return nil }
        guard hrp.allSatisfy({ ch in
            guard let a = ch.asciiValue else { return false }
            return a >= 33 && a <= 126
        }) else { return nil }

        var values = [UInt8]()
        values.reserveCapacity(dataPart.count)
        for ch in dataPart {
            guard let idx = charset.firstIndex(of: ch) else { return nil }
            values.append(UInt8(idx))
        }

        let chk = polymod(hrpExpand(hrp) + values.map { Int($0) })
        let variant: Variant
        switch chk {
        case 1: variant = .bech32
        case 0x2bc830a3: variant = .bech32m
        default: return nil
        }

        let payload = Array(values[0..<(values.count - 6)])
        guard let version = payload.first, version <= 16 else { return nil }
        guard let program = convertBits(Array(payload[1...]), from: 5, to: 8, pad: false) else {
            return nil
        }
        guard program.count >= 2, program.count <= 40 else { return nil }
        if version == 0 {
            guard variant == .bech32, program.count == 20 || program.count == 32 else { return nil }
        } else {
            guard variant == .bech32m else { return nil }
        }
        return Decoded(hrp: hrp, witnessVersion: version, program: program, variant: variant)
    }

    private static func encode(hrp: String, data: [UInt8], variant: Variant) -> String {
        let checksum = createChecksum(hrp: hrp, data: data, variant: variant)
        var out = hrp + "1"
        for b in data { out.append(charset[Int(b)]) }
        for b in checksum { out.append(charset[b]) }
        return out
    }

    /// nil when `pad` is false and the input does not divide evenly, or when the
    /// discarded padding is non-zero. BIP173 requires both to be rejected rather
    /// than trimmed.
    public static func convertBits(_ data: [UInt8], from: Int, to: Int, pad: Bool) -> [UInt8]? {
        var acc = 0
        var bits = 0
        var out = [UInt8]()
        out.reserveCapacity(data.count * from / to + 2)
        let maxv = (1 << to) - 1
        for b in data {
            let value = Int(b)
            if (value >> from) != 0 { return nil }
            acc = (acc << from) | value
            bits += from
            while bits >= to {
                bits -= to
                out.append(UInt8((acc >> bits) & maxv))
            }
        }
        if pad {
            if bits > 0 { out.append(UInt8((acc << (to - bits)) & maxv)) }
        } else if bits >= from || ((acc << (to - bits)) & maxv) != 0 {
            return nil
        }
        return out
    }

    private static func polymod(_ values: [Int]) -> Int {
        let gen = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
        var chk = 1
        for v in values {
            let top = chk >> 25
            chk = ((chk & 0x1ffffff) << 5) ^ v
            for i in 0..<5 where ((top >> i) & 1) != 0 { chk ^= gen[i] }
        }
        return chk
    }

    private static func hrpExpand(_ hrp: String) -> [Int] {
        let scalars = Array(hrp.unicodeScalars).map { Int($0.value) }
        return scalars.map { $0 >> 5 } + [0] + scalars.map { $0 & 31 }
    }

    private static func createChecksum(hrp: String, data: [UInt8], variant: Variant) -> [Int] {
        let constant = variant == .bech32 ? 1 : 0x2bc830a3
        let values = hrpExpand(hrp) + data.map { Int($0) } + [0, 0, 0, 0, 0, 0]
        let mod = polymod(values) ^ constant
        return (0..<6).map { (mod >> (5 * (5 - $0))) & 31 }
    }
}

public extension Array where Element == UInt8 {
    /// Lowercase hex, for fingerprints and test vectors. Never for secrets.
    var hex: String {
        var s = ""
        s.reserveCapacity(count * 2)
        let digits = Array<Character>("0123456789abcdef")
        for b in self {
            s.append(digits[Int(b >> 4)])
            s.append(digits[Int(b & 0x0F)])
        }
        return s
    }

    init?(hex: String) {
        let chars = Array<Character>(hex)
        guard chars.count % 2 == 0 else { return nil }
        var out = [UInt8]()
        out.reserveCapacity(chars.count / 2)
        var i = 0
        while i < chars.count {
            guard let hi = chars[i].hexDigitValue, let lo = chars[i + 1].hexDigitValue else {
                return nil
            }
            out.append(UInt8(hi << 4 | lo))
            i += 2
        }
        self = out
    }
}
