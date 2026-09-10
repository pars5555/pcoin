import Foundation

/// A PCoin address, and the scriptPubKey it pays to.
///
/// THIS FILE HAS NO COUNTERPART ON ANDROID, and the reason is the whole shape of
/// this app. The Android wallet types an address into `validateaddress` on the
/// node it runs inside, and believes the answer. There is no node here to ask,
/// so iOS has to know for itself what a PCoin address is -- which means it also
/// has to be right, because it is now the only thing between a typo and a
/// payment to nobody.
///
/// Every rejection carries a reason. "Not an address" and "that is a Bitcoin
/// address" and "that is a taproot address this wallet cannot pay" are three
/// different problems with three different fixes, and collapsing them into one
/// red line is how somebody spends twenty minutes retyping a perfectly good
/// address.
public struct Address: Equatable {

    public enum Kind: Equatable {
        case p2wpkh(hash160: [UInt8])
        case p2wsh(hash256: [UInt8])
        case p2tr(x: [UInt8])
        /// Any future witness version. Payable -- the network defines it, we do
        /// not -- but flagged, because paying one is unusual.
        case witnessUnknown(version: UInt8, program: [UInt8])
        case p2pkh(hash160: [UInt8])
        case p2sh(hash160: [UInt8])
    }

    public enum Failure: Swift.Error, Equatable {
        /// Nothing about this is an address.
        case notAnAddress
        /// Well-formed for another chain. `hrp` or the base58 version says so.
        case wrongNetwork(detail: String)
        /// A real segwit address whose checksum does not match. Almost always
        /// one mistyped character, and worth saying so, because "not an
        /// address" sends somebody hunting for the wrong thing.
        case badChecksum
        /// A witness program of a size the encoding does not allow.
        case malformedProgram
    }

    public let text: String
    public let kind: Kind
    public let network: PcoinDerivation.Network

    /// The scriptPubKey this address pays to.
    public var scriptPubKey: [UInt8] {
        switch kind {
        case .p2wpkh(let h):
            return [0x00, 0x14] + h
        case .p2wsh(let h):
            return [0x00, 0x20] + h
        case .p2tr(let x):
            return [0x51, 0x20] + x
        case .witnessUnknown(let v, let p):
            // OP_1..OP_16 are 0x51..0x60.
            return [0x50 + v, UInt8(p.count)] + p
        case .p2pkh(let h):
            // OP_DUP OP_HASH160 <20> OP_EQUALVERIFY OP_CHECKSIG
            return [0x76, 0xa9, 0x14] + h + [0x88, 0xac]
        case .p2sh(let h):
            // OP_HASH160 <20> OP_EQUAL
            return [0xa9, 0x14] + h + [0x87]
        }
    }

    /// True when this wallet can hold change on it. A phrase-backed wallet holds
    /// only `wpkh` descriptors, so change is always P2WPKH -- see PCOIN.md 6.5,
    /// which is the same reason the node wallet needs `changetype=bech32`.
    public var isNativeSegwitV0: Bool {
        if case .p2wpkh = kind { return true }
        return false
    }

    /// The bytes a fee estimate needs before anything is signed.
    public var estimatedOutputVbytes: Int { 8 + 1 + scriptPubKey.count }

    public static func parse(
        _ raw: String, network: PcoinDerivation.Network = .mainnet
    ) -> Result<Address, Failure> {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return .failure(.notAnAddress) }

        // Bech32 first: it is what this chain uses, and its errors are the ones
        // worth being precise about.
        if let sep = trimmed.lastIndex(of: "1") {
            let hrp = String(trimmed[trimmed.startIndex..<sep]).lowercased()
            if !hrp.isEmpty, hrp.allSatisfy({ $0.isLetter }) {
                if let d = Bech32.decode(trimmed) {
                    guard d.hrp == network.bech32Hrp else {
                        return .failure(.wrongNetwork(detail: d.hrp))
                    }
                    switch (d.witnessVersion, d.program.count) {
                    case (0, 20): return .success(Address(text: trimmed.lowercased(), kind: .p2wpkh(hash160: d.program), network: network))
                    case (0, 32): return .success(Address(text: trimmed.lowercased(), kind: .p2wsh(hash256: d.program), network: network))
                    case (1, 32): return .success(Address(text: trimmed.lowercased(), kind: .p2tr(x: d.program), network: network))
                    default:
                        return .success(Address(
                            text: trimmed.lowercased(),
                            kind: .witnessUnknown(version: d.witnessVersion, program: d.program),
                            network: network
                        ))
                    }
                }
                // It looked like a segwit address for a known hrp and did not
                // decode. Say "checksum", not "not an address".
                if hrp == network.bech32Hrp || hrp == "bc" || hrp == "tb" || hrp == "bcrt"
                    || hrp == PcoinDerivation.Network.regtest.bech32Hrp {
                    if hrp != network.bech32Hrp {
                        return .failure(.wrongNetwork(detail: hrp))
                    }
                    return .failure(.badChecksum)
                }
            }
        }

        // Base58Check. PCoin mainnet: 55 -> "P..." (P2PKH), 56 -> P2SH.
        if let payload = Base58.decodeCheck(trimmed) {
            guard payload.count == 21 else { return .failure(.malformedProgram) }
            let version = payload[0]
            let hash = Array(payload[1...])
            if version == network.pubkeyAddressPrefix {
                return .success(Address(text: trimmed, kind: .p2pkh(hash160: hash), network: network))
            }
            if version == network.scriptAddressPrefix {
                return .success(Address(text: trimmed, kind: .p2sh(hash160: hash), network: network))
            }
            return .failure(.wrongNetwork(detail: "version byte \(version)"))
        }

        return .failure(.notAnAddress)
    }

    /// Convenience for code that only wants to know whether it can pay this.
    public static func isValid(_ raw: String, network: PcoinDerivation.Network = .mainnet) -> Bool {
        if case .success = parse(raw, network: network) { return true }
        return false
    }
}
