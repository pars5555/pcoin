import Foundation

/// A spendable output, as the explorer reports it and as the wallet knows it.
public struct SpendableUtxo: Equatable {
    public let outpoint: Transaction.OutPoint
    public let valueSat: Int64
    public let scriptPubKey: [UInt8]
    /// Where in the key tree the key for this output lives.
    public let chain: UInt32
    public let index: UInt32
    public let confirmations: Int
    public let isCoinbase: Bool
    /// The explorer own view: mature, not already spent by something in the
    /// mempool, and confirmed.
    public let spendableAccordingToIndex: Bool

    public init(
        outpoint: Transaction.OutPoint,
        valueSat: Int64,
        scriptPubKey: [UInt8],
        chain: UInt32,
        index: UInt32,
        confirmations: Int,
        isCoinbase: Bool,
        spendableAccordingToIndex: Bool
    ) {
        self.outpoint = outpoint
        self.valueSat = valueSat
        self.scriptPubKey = scriptPubKey
        self.chain = chain
        self.index = index
        self.confirmations = confirmations
        self.isCoinbase = isCoinbase
        self.spendableAccordingToIndex = spendableAccordingToIndex
    }

    /// The 20-byte key hash, for the P2WPKH scriptCode. nil if this is not a
    /// P2WPKH output, which would mean the wallet was handed something it
    /// cannot sign.
    public var pubKeyHash: [UInt8]? {
        guard scriptPubKey.count == 22, scriptPubKey[0] == 0x00, scriptPubKey[1] == 0x14 else {
            return nil
        }
        return Array(scriptPubKey[2...])
    }
}

/// The three fixed rates the send screen offers, in satoshi per vbyte.
///
/// Fixed rather than estimated, exactly as on Android, and the wording there
/// says so: "Fixed rates: 1, 5 or 20 sat per vbyte." This chain has almost no
/// fee market, `estimatesmartfee` has nothing to learn from, and PCOIN.md 6.5
/// records that a node wallet here needs `fallbackfee` set for precisely that
/// reason. Three honest constants beat an estimator with no data.
public enum FeeRate: Int, CaseIterable, Equatable {
    case normal = 1
    case fast = 5
    case veryFast = 20

    public var satPerVbyte: Int64 { Int64(rawValue) }
}

/// A transaction that has been built and signed but NOT broadcast.
///
/// Every number on it is measured from the real bytes, not estimated. The review
/// screen says "These are the real figures from the transaction that was just
/// built", and that has to be true.
public struct PlannedSend {
    public let signed: Transaction
    public let destination: Address
    public let amountSat: Int64
    public let feeSat: Int64
    /// nil when the send left no change, either because it was a send-everything
    /// or because the change would have been dust and went to the fee instead.
    public let changeSat: Int64?
    public let changeAddress: String?
    public let inputs: [SpendableUtxo]
    public let sendsEverything: Bool

    public var vsize: Int { signed.vsize }
    public var leavesWalletSat: Int64 { amountSat + feeSat }
    public var rawHex: String { signed.serialized().hex }
    public var txid: String { signed.txid }

    /// The rate actually paid. Always at or above the requested rate; see the
    /// convergence note in `TxBuilder.plan`.
    public var effectiveSatPerVbyte: Double { Double(feeSat) / Double(vsize) }
}

public enum SendPlanError: Swift.Error, Equatable {
    case noSpendableCoins
    case insufficientFunds(neededSat: Int64, availableSat: Int64)
    /// The amount itself is below the dust threshold.
    case amountIsDust(Int64)
    /// Sending everything, but the fee would eat all of it.
    case feeExceedsBalance(feeSat: Int64, availableSat: Int64)
    case unsignableInput(Transaction.OutPoint)
    case signingFailed
    /// The signature this wallet just produced does not verify. Never seen; the
    /// check exists so it can never be broadcast if it ever is.
    case selfCheckFailed
}

/// Builds and signs a spend.
///
/// COIN SELECTION IS DELIBERATELY BORING. Largest-first, with a single-output
/// shortcut when one coin covers the payment on its own. It is not Core
/// branch-and-bound and does not try to avoid change: predictable beats clever
/// for something a person is about to confirm, and a selection nobody can
/// explain is a selection nobody can review.
public enum TxBuilder {

    /// A P2WPKH witness is two items: the signature (DER + one sighash byte)
    /// and the compressed public key. 72 is the largest a low-S DER signature
    /// plus its sighash byte reaches, so estimating with it can only ever
    /// overshoot, and an overshoot is a fee slightly too high rather than a
    /// transaction nobody relays.
    static let maxWitnessBytesPerInput = 1 + 1 + 72 + 1 + 33

    /// Minimum confirmations before this wallet will spend a coin.
    ///
    /// A DIVERGENCE FROM ANDROID, and a deliberate one. Bitcoin Core defaults
    /// `spendzeroconfchange` to true, so the node inside the Android app will
    /// spend its own change the moment it is broadcast. This wallet has no node
    /// and therefore no way to be sure an unconfirmed output is its own change
    /// rather than an incoming payment somebody can still replace -- and
    /// PCoin reorgs routinely (CLAUDE.md 10.12). One confirmation is the
    /// smallest gate that makes the question answerable at all.
    public static let minConfirmationsToSpend = 1

    public static func spendable(_ utxos: [SpendableUtxo]) -> [SpendableUtxo] {
        utxos.filter {
            $0.spendableAccordingToIndex
                && $0.confirmations >= minConfirmationsToSpend
                && $0.pubKeyHash != nil
        }
    }

    /// Plan and sign a payment.
    ///
    /// - Parameter amountSat: nil means "send everything", which is what the
    ///   MAX button does. It is a different operation, not an amount that
    ///   happens to equal the balance: the fee comes out of the payment rather
    ///   than out of the change.
    public static func plan(
        utxos allUtxos: [SpendableUtxo],
        to destination: Address,
        amountSat: Int64?,
        feeRate: FeeRate,
        changeAddress: String?,
        signer: (UInt32, UInt32) throws -> Bip32.ExtendedKey
    ) throws -> PlannedSend {
        let coins = spendable(allUtxos).sorted { $0.valueSat > $1.valueSat }
        guard !coins.isEmpty else { throw SendPlanError.noSpendableCoins }
        let available = coins.reduce(Int64(0)) { $0 + $1.valueSat }

        let sendsEverything = (amountSat == nil)
        if let a = amountSat, Amounts.isDust(a) { throw SendPlanError.amountIsDust(a) }

        let changeScript: [UInt8]?
        if let ca = changeAddress, case .success(let addr) = Address.parse(ca) {
            changeScript = addr.scriptPubKey
        } else {
            changeScript = nil
        }

        // --- choose inputs -------------------------------------------------

        var selected: [SpendableUtxo]
        if sendsEverything {
            selected = coins
        } else {
            let target = amountSat!
            // One coin that covers it on its own, smallest such: fewest inputs,
            // smallest change, no cleverness.
            let single = coins.reversed().first {
                $0.valueSat >= target + estimateFee(
                    inputs: 1, outputScripts: [destination.scriptPubKey, changeScript ?? []],
                    rate: feeRate
                )
            }
            if let s = single {
                selected = [s]
            } else {
                selected = []
                var acc: Int64 = 0
                for c in coins {
                    selected.append(c)
                    acc += c.valueSat
                    let fee = estimateFee(
                        inputs: selected.count,
                        outputScripts: [destination.scriptPubKey, changeScript ?? []],
                        rate: feeRate
                    )
                    if acc >= target + fee { break }
                }
                let fee = estimateFee(
                    inputs: selected.count,
                    outputScripts: [destination.scriptPubKey, changeScript ?? []],
                    rate: feeRate
                )
                guard acc >= target + fee else {
                    throw SendPlanError.insufficientFunds(
                        neededSat: target + fee, availableSat: available
                    )
                }
            }
        }

        let selectedTotal = selected.reduce(Int64(0)) { $0 + $1.valueSat }

        // --- converge on the exact fee -------------------------------------
        //
        // Build, sign, measure, adjust. A DER signature is 71 or 72 bytes
        // depending on the scalar, so the true size is not known until the
        // signing is done. Two passes settle it in every real case; the loop is
        // bounded and the LAST plan that satisfies "fee >= rate * vsize" wins,
        // so it can overshoot but can never underpay.
        var fee = estimateFee(
            inputs: selected.count,
            outputScripts: [destination.scriptPubKey, changeScript ?? []],
            rate: feeRate
        )
        var best: PlannedSend?

        for _ in 0..<4 {
            let payAmount: Int64
            var change: Int64? = nil

            if sendsEverything {
                payAmount = selectedTotal - fee
                guard payAmount > 0 else {
                    throw SendPlanError.feeExceedsBalance(
                        feeSat: fee, availableSat: selectedTotal
                    )
                }
                guard !Amounts.isDust(payAmount) else {
                    throw SendPlanError.amountIsDust(payAmount)
                }
            } else {
                payAmount = amountSat!
                let leftover = selectedTotal - payAmount - fee
                guard leftover >= 0 else {
                    throw SendPlanError.insufficientFunds(
                        neededSat: payAmount + fee, availableSat: available
                    )
                }
                // Change below the dust threshold cannot be spent again, so
                // paying it out as fee is strictly better than creating an
                // output nobody can ever move.
                if leftover > 0 && !Amounts.isDust(leftover) && changeScript != nil {
                    change = leftover
                } else if leftover > 0 {
                    fee += leftover
                }
            }

            var outputs = [Transaction.Output(
                valueSat: payAmount, scriptPubKey: destination.scriptPubKey
            )]
            if let c = change, let cs = changeScript {
                outputs.append(Transaction.Output(valueSat: c, scriptPubKey: cs))
            }

            let unsigned = Transaction(
                inputs: selected.map { Transaction.Input(outpoint: $0.outpoint) },
                outputs: outputs
            )
            let signed = try sign(unsigned, spending: selected, signer: signer)

            let actualFee = selectedTotal - outputs.reduce(Int64(0)) { $0 + $1.valueSat }
            let plan = PlannedSend(
                signed: signed,
                destination: destination,
                amountSat: payAmount,
                feeSat: actualFee,
                changeSat: change,
                changeAddress: change == nil ? nil : changeAddress,
                inputs: selected,
                sendsEverything: sendsEverything
            )

            if actualFee >= feeRate.satPerVbyte * Int64(signed.vsize) {
                best = plan
                break
            }
            // Under the requested rate: raise the fee to what this exact size
            // costs and go round again.
            fee = feeRate.satPerVbyte * Int64(signed.vsize)
            best = plan
        }

        guard let result = best else { throw SendPlanError.signingFailed }
        return result
    }

    /// Sign every input of `tx` as P2WPKH.
    ///
    /// Verifies each signature against the same message hash before returning.
    /// That check is not defensive padding: a wallet that broadcasts a bad
    /// signature has already told the user the money is on its way.
    public static func sign(
        _ tx: Transaction,
        spending utxos: [SpendableUtxo],
        signer: (UInt32, UInt32) throws -> Bip32.ExtendedKey
    ) throws -> Transaction {
        var out = tx
        for (i, u) in utxos.enumerated() {
            guard let pkh = u.pubKeyHash else {
                throw SendPlanError.unsignableInput(u.outpoint)
            }
            let key = try signer(u.chain, u.index)
            defer { key.wipe() }
            let pub = key.publicKey
            // If this fails the wallet is about to sign with the wrong key,
            // which produces a transaction that is valid-looking and unspendable.
            guard Hashes.hash160(pub) == pkh else {
                throw SendPlanError.unsignableInput(u.outpoint)
            }
            let hash = Sighash.p2wpkhSighash(
                tx: out,
                index: i,
                scriptCode: Sighash.p2wpkhScriptCode(pubKeyHash: pkh),
                amountSat: u.valueSat
            )
            let der: [UInt8]
            do {
                der = try Secp256k1.signDER(messageHash: hash, privateKey: key.key)
            } catch {
                throw SendPlanError.signingFailed
            }
            guard Secp256k1.verifyDER(signature: der, messageHash: hash, publicKey: pub) else {
                throw SendPlanError.selfCheckFailed
            }
            out.inputs[i].witness = [der + [Sighash.HashType.all.rawValue], pub]
        }
        return out
    }

    /// The fee a transaction of this shape would cost, before it is signed.
    ///
    /// Overshoots by design -- see `maxWitnessBytesPerInput`.
    public static func estimateFee(inputs: Int, outputScripts: [[UInt8]], rate: FeeRate) -> Int64 {
        Int64(estimateVsize(inputs: inputs, outputScripts: outputScripts)) * rate.satPerVbyte
    }

    public static func estimateVsize(inputs: Int, outputScripts: [[UInt8]]) -> Int {
        let realOutputs = outputScripts.filter { !$0.isEmpty }
        var base = 4 + 4 // version + locktime
        base += [UInt8].varIntSize(UInt64(inputs))
        base += inputs * (32 + 4 + 1 + 4) // outpoint + empty scriptSig + sequence
        base += [UInt8].varIntSize(UInt64(realOutputs.count))
        for s in realOutputs {
            base += 8 + [UInt8].varIntSize(UInt64(s.count)) + s.count
        }
        let witness = 2 + inputs * maxWitnessBytesPerInput // marker + flag + items
        let weight = base * 4 + witness
        return (weight + 3) / 4
    }
}
