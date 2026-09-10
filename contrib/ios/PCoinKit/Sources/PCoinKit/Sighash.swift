import Foundation

/// BIP143 signature hashes, which is the only kind this wallet produces.
///
/// Every input it spends is P2WPKH, so every signature is a segwit v0 one. The
/// pre-segwit algorithm is deliberately absent: it is quadratic in transaction
/// size, it is not needed to spend anything this wallet can hold, and an unused
/// half-right implementation of a signing primitive is a liability.
public enum Sighash {

    public enum HashType: UInt8 {
        case all = 0x01
        // SIGHASH_NONE, SIGHASH_SINGLE and ANYONECANPAY are not implemented.
        // Nothing in a plain send needs them, and every one of them is a way to
        // sign something other than what the user reviewed.
    }

    /// The scriptCode for a P2WPKH input: BIP143 says it is the P2PKH script
    /// for the same key hash, length-prefixed.
    public static func p2wpkhScriptCode(pubKeyHash: [UInt8]) -> [UInt8] {
        precondition(pubKeyHash.count == 20)
        return [0x19, 0x76, 0xa9, 0x14] + pubKeyHash + [0x88, 0xac]
    }

    /// The 32-byte hash to sign for input `index`.
    ///
    /// `amountSat` is the value of the output BEING SPENT, and getting it wrong
    /// produces a signature that verifies against nothing. That is BIP143 whole
    /// point -- pre-segwit, a wallet could be lied to about an input value and
    /// sign away the difference as fee -- so the value is committed to here.
    public static func p2wpkhSighash(
        tx: Transaction,
        index: Int,
        scriptCode: [UInt8],
        amountSat: Int64,
        hashType: HashType = .all
    ) -> [UInt8] {
        var prevouts = [UInt8]()
        var sequences = [UInt8]()
        for i in tx.inputs {
            prevouts.append(contentsOf: Transaction.txidBytes(i.outpoint.txid))
            prevouts.appendLE(i.outpoint.vout)
            sequences.appendLE(i.sequence)
        }
        var outputsBytes = [UInt8]()
        for o in tx.outputs {
            outputsBytes.appendLE(UInt64(bitPattern: o.valueSat))
            outputsBytes.appendVarInt(UInt64(o.scriptPubKey.count))
            outputsBytes.append(contentsOf: o.scriptPubKey)
        }

        let hashPrevouts = Hashes.doubleSha256(prevouts)
        let hashSequence = Hashes.doubleSha256(sequences)
        let hashOutputs = Hashes.doubleSha256(outputsBytes)

        let input = tx.inputs[index]
        var pre = [UInt8]()
        pre.appendLE(UInt32(bitPattern: tx.version))
        pre.append(contentsOf: hashPrevouts)
        pre.append(contentsOf: hashSequence)
        pre.append(contentsOf: Transaction.txidBytes(input.outpoint.txid))
        pre.appendLE(input.outpoint.vout)
        // scriptCode arrives already length-prefixed, as BIP143 serialises it.
        pre.append(contentsOf: scriptCode)
        pre.appendLE(UInt64(bitPattern: amountSat))
        pre.appendLE(input.sequence)
        pre.append(contentsOf: hashOutputs)
        pre.appendLE(tx.lockTime)
        pre.appendLE(UInt32(hashType.rawValue))
        return Hashes.doubleSha256(pre)
    }
}
