import Foundation

/// A Bitcoin-format transaction, enough of one to spend P2WPKH outputs.
///
/// PCoin changed the proof of work and the difficulty algorithm and nothing
/// about transaction serialisation, so this is plain BIP141/BIP144. The one
/// PCoin-specific fact worth stating: block IDs on this chain are still
/// double-SHA256 even though the PoW hash is RandomX -- `GetHash()`, prev-block
/// links and every RPC hash are unchanged. Transaction ids were never affected
/// either way, but people ask.
public struct Transaction {

    public struct OutPoint: Equatable, Hashable {
        /// Big-endian, as displayed and as the explorer reports it. Serialised
        /// little-endian; the reversal happens in one place, below.
        public let txid: String
        public let vout: UInt32

        public init(txid: String, vout: UInt32) {
            self.txid = txid
            self.vout = vout
        }
    }

    public struct Input {
        public let outpoint: OutPoint
        public let sequence: UInt32
        /// Empty for a segwit spend: the signature lives in the witness.
        public var scriptSig: [UInt8]
        public var witness: [[UInt8]]

        public init(
            outpoint: OutPoint,
            sequence: UInt32 = Transaction.defaultSequence,
            scriptSig: [UInt8] = [],
            witness: [[UInt8]] = []
        ) {
            self.outpoint = outpoint
            self.sequence = sequence
            self.scriptSig = scriptSig
            self.witness = witness
        }
    }

    public struct Output {
        public let valueSat: Int64
        public let scriptPubKey: [UInt8]

        public init(valueSat: Int64, scriptPubKey: [UInt8]) {
            self.valueSat = valueSat
            self.scriptPubKey = scriptPubKey
        }
    }

    /// Opt-in RBF, which is what Bitcoin Core wallet has defaulted to for
    /// years and therefore what the node inside the Android app produces. The
    /// two wallets should put the same shape of transaction on the wire.
    public static let defaultSequence: UInt32 = 0xFFFF_FFFD

    public var version: Int32 = 2
    public var inputs: [Input]
    public var outputs: [Output]
    public var lockTime: UInt32 = 0

    public init(inputs: [Input], outputs: [Output], version: Int32 = 2, lockTime: UInt32 = 0) {
        self.inputs = inputs
        self.outputs = outputs
        self.version = version
        self.lockTime = lockTime
    }

    public var hasWitness: Bool { inputs.contains { !$0.witness.isEmpty } }

    /// The legacy serialisation: no marker, no flag, no witness.
    ///
    /// This is what the txid is computed over, which is why it still exists on a
    /// segwit-only wallet.
    public func serializedNoWitness() -> [UInt8] {
        var out = [UInt8]()
        out.appendLE(UInt32(bitPattern: version))
        out.appendVarInt(UInt64(inputs.count))
        for i in inputs {
            out.append(contentsOf: Transaction.txidBytes(i.outpoint.txid))
            out.appendLE(i.outpoint.vout)
            out.appendVarInt(UInt64(i.scriptSig.count))
            out.append(contentsOf: i.scriptSig)
            out.appendLE(i.sequence)
        }
        out.appendVarInt(UInt64(outputs.count))
        for o in outputs {
            out.appendLE(UInt64(bitPattern: o.valueSat))
            out.appendVarInt(UInt64(o.scriptPubKey.count))
            out.append(contentsOf: o.scriptPubKey)
        }
        out.appendLE(lockTime)
        return out
    }

    /// BIP144 serialisation, which is what gets broadcast.
    public func serialized() -> [UInt8] {
        guard hasWitness else { return serializedNoWitness() }
        var out = [UInt8]()
        out.appendLE(UInt32(bitPattern: version))
        out.append(0x00) // marker
        out.append(0x01) // flag
        out.appendVarInt(UInt64(inputs.count))
        for i in inputs {
            out.append(contentsOf: Transaction.txidBytes(i.outpoint.txid))
            out.appendLE(i.outpoint.vout)
            out.appendVarInt(UInt64(i.scriptSig.count))
            out.append(contentsOf: i.scriptSig)
            out.appendLE(i.sequence)
        }
        out.appendVarInt(UInt64(outputs.count))
        for o in outputs {
            out.appendLE(UInt64(bitPattern: o.valueSat))
            out.appendVarInt(UInt64(o.scriptPubKey.count))
            out.append(contentsOf: o.scriptPubKey)
        }
        for i in inputs {
            out.appendVarInt(UInt64(i.witness.count))
            for item in i.witness {
                out.appendVarInt(UInt64(item.count))
                out.append(contentsOf: item)
            }
        }
        out.appendLE(lockTime)
        return out
    }

    /// The transaction id, as everything displays it: big-endian hex.
    public var txid: String {
        Array(Hashes.doubleSha256(serializedNoWitness()).reversed()).hex
    }

    public var weight: Int {
        let base = serializedNoWitness().count
        let total = serialized().count
        return base * 3 + total
    }

    /// Virtual size, rounded up, which is what a fee rate is quoted against.
    public var vsize: Int { (weight + 3) / 4 }

    /// A displayed txid is big-endian; the wire wants it reversed.
    static func txidBytes(_ txid: String) -> [UInt8] {
        guard let b = [UInt8](hex: txid), b.count == 32 else {
            // Only reachable if a txid from the explorer is not 32 bytes of
            // hex, which would mean the API changed shape underneath us. There
            // is no safe way to guess, and a wrong outpoint spends nothing, so
            // fail loudly rather than build a transaction that looks fine.
            preconditionFailure("txid is not 32 bytes of hex")
        }
        return b.reversed()
    }
}

// MARK: - little-endian and varint helpers

extension Array where Element == UInt8 {
    mutating func appendLE(_ v: UInt32) {
        append(UInt8(v & 0xFF))
        append(UInt8((v >> 8) & 0xFF))
        append(UInt8((v >> 16) & 0xFF))
        append(UInt8((v >> 24) & 0xFF))
    }

    mutating func appendLE(_ v: UInt64) {
        for i in 0..<8 { append(UInt8((v >> (8 * UInt64(i))) & 0xFF)) }
    }

    mutating func appendVarInt(_ v: UInt64) {
        switch v {
        case ..<0xFD:
            append(UInt8(v))
        case ..<0x1_0000:
            append(0xFD)
            append(UInt8(v & 0xFF))
            append(UInt8((v >> 8) & 0xFF))
        case ..<0x1_0000_0000:
            append(0xFE)
            appendLE(UInt32(v))
        default:
            append(0xFF)
            appendLE(v)
        }
    }

    static func varIntSize(_ v: UInt64) -> Int {
        switch v {
        case ..<0xFD: return 1
        case ..<0x1_0000: return 3
        case ..<0x1_0000_0000: return 5
        default: return 9
        }
    }
}
