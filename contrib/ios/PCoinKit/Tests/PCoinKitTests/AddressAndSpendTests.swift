import XCTest
@testable import PCoinKit

/// Address validation and coin selection.
///
/// `Address` has no Android counterpart -- there, a typed address goes to
/// `validateaddress` on the node inside the app. There is no node here, so this
/// code is now the only thing between a typo and a payment to nobody, which is
/// why it is tested this hard.
final class AddressAndSpendTests: XCTestCase {

    private let good = "pc1qnfk7xenwzxx7h4mx88g004crlx0m2zcjg3nq4j"

    func testAcceptsPcoinNativeSegwit() throws {
        let a = try XCTUnwrap(try? Address.parse(good).get())
        XCTAssertEqual(a.text, good)
        XCTAssertTrue(a.isNativeSegwitV0)
        XCTAssertEqual(
            a.scriptPubKey.hex,
            "00149a6de3666e118debd76639d0f7d703f99fb50b12",
            "P2WPKH scriptPubKey"
        )
    }

    func testUpperCaseIsTheSameAddress() throws {
        let a = try XCTUnwrap(try? Address.parse(good.uppercased()).get())
        XCTAssertEqual(a.text, good, "folded to lower case")
    }

    /// Every rejection carries a reason. "Not an address", "that is a Bitcoin
    /// address" and "one character is wrong" are three different problems with
    /// three different fixes, and collapsing them into one red line is how
    /// somebody spends twenty minutes retyping a perfectly good address.
    func testRejectionsSayWhichKind() {
        XCTAssertEqual(Address.parse("").failure, .notAnAddress)
        XCTAssertEqual(Address.parse("hello world").failure, .notAnAddress)

        // A Bitcoin address is well formed and on the wrong chain. This one
        // matters more than most: PCoin kept Bitcoin BIP32 version bytes, so
        // the two ecosystems look alike everywhere except the hrp.
        XCTAssertEqual(
            Address.parse("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4").failure,
            .wrongNetwork(detail: "bc")
        )

        // One character changed: a checksum failure, not "not an address".
        var broken = Array(good)
        broken[20] = broken[20] == "a" ? "b" : "a"
        XCTAssertEqual(Address.parse(String(broken)).failure, .badChecksum)
    }

    func testMixedCaseIsRefused() {
        XCTAssertEqual(
            Address.parse("pc1QNFK7xenwzxx7h4mx88g004crlx0m2zcjg3nq4j").failure,
            .badChecksum,
            "mixed case cannot be valid bech32"
        )
    }

    /// Taproot decodes so it can be refused accurately, and paid: the network
    /// defines what is payable, not this wallet. What it cannot be is CHANGE --
    /// a phrase-backed wallet holds only wpkh descriptors.
    func testTaprootIsRecognisedAndIsNotChange() throws {
        let a = try XCTUnwrap(try? Address.parse(
            "pc1pqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0s6f7fhu"
        ).get())
        if case .p2tr = a.kind {} else { XCTFail("expected p2tr, got \(a.kind)") }
        XCTAssertFalse(a.isNativeSegwitV0, "taproot must never be used for change")
        XCTAssertEqual(a.scriptPubKey.first, 0x51, "OP_1")
    }

    // MARK: - coin selection and fees

    private func utxo(_ valueSat: Int64, index: UInt32, confirmations: Int = 6) -> SpendableUtxo {
        SpendableUtxo(
            outpoint: .init(
                txid: String(format: "%064x", index + 1),
                vout: 0
            ),
            valueSat: valueSat,
            scriptPubKey: [UInt8](hex: "00149a6de3666e118debd76639d0f7d703f99fb50b12")!,
            chain: 0,
            index: index,
            confirmations: confirmations,
            isCoinbase: false,
            spendableAccordingToIndex: true
        )
    }

    /// A signer that returns the key for the burn phrase, so a plan can actually
    /// be signed and measured.
    private func burnSigner() throws -> (UInt32, UInt32) throws -> Bip32.ExtendedKey {
        let b = try Bip39.english()
        let keys = try PcoinDerivation.accountKeys(
            bip39: b,
            mnemonic: Bip39.splitWords(
                "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
            ),
            network: .mainnet
        )
        return { chain, index in try keys.privateKey(chain: chain, index: index) }
    }

    /// The UTXOs must be ones the burn phrase can actually sign, or the plan is
    /// refused by the key check inside `TxBuilder.sign`.
    private func burnUtxos(_ values: [Int64]) throws -> [SpendableUtxo] {
        let b = try Bip39.english()
        let keys = try PcoinDerivation.accountKeys(
            bip39: b,
            mnemonic: Bip39.splitWords(
                "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
            ),
            network: .mainnet
        )
        return try values.enumerated().map { i, v in
            let addr = try keys.address(chain: 0, index: UInt32(i))
            let script = try Address.parse(addr).get().scriptPubKey
            return SpendableUtxo(
                outpoint: .init(txid: String(format: "%064x", i + 1), vout: 0),
                valueSat: v,
                scriptPubKey: script,
                chain: 0,
                index: UInt32(i),
                confirmations: 6,
                isCoinbase: false,
                spendableAccordingToIndex: true
            )
        }
    }

    func testUnconfirmedCoinsAreNotSpent() {
        let unconfirmed = utxo(1_000_000, index: 0, confirmations: 0)
        XCTAssertTrue(TxBuilder.spendable([unconfirmed]).isEmpty)
        XCTAssertEqual(TxBuilder.spendable([utxo(1_000_000, index: 0, confirmations: 1)]).count, 1)
    }

    func testIndexJudgementIsRespected() {
        let notSpendable = SpendableUtxo(
            outpoint: .init(txid: String(repeating: "0", count: 64), vout: 0),
            valueSat: 1_000_000,
            scriptPubKey: [UInt8](hex: "00149a6de3666e118debd76639d0f7d703f99fb50b12")!,
            chain: 0, index: 0, confirmations: 99,
            isCoinbase: true,
            spendableAccordingToIndex: false
        )
        XCTAssertTrue(TxBuilder.spendable([notSpendable]).isEmpty,
                      "an immature coinbase is not spendable however many confirmations it has")
    }

    func testPlanPaysAtLeastTheRequestedFeeRate() throws {
        let signer = try burnSigner()
        let utxos = try burnUtxos([500_000_000])
        let dest = try Address.parse("pc1qj7lccmpqhdgg6enh503hqqyx244e49yespm8pf").get()
        let change = "pc1qel0k9nyfvgqsgkc4fv9jp9ff37gw48gnsqt2rs"

        for rate in FeeRate.allCases {
            let plan = try TxBuilder.plan(
                utxos: utxos, to: dest, amountSat: 100_000_000,
                feeRate: rate, changeAddress: change, signer: signer
            )
            XCTAssertEqual(plan.amountSat, 100_000_000)
            XCTAssertGreaterThanOrEqual(
                plan.feeSat, Int64(plan.vsize) * rate.satPerVbyte,
                "must never underpay the requested rate (\(rate))"
            )
            // And not wildly over: the estimate uses a 72-byte signature, so the
            // overshoot is a couple of bytes worth at most.
            XCTAssertLessThan(
                plan.feeSat, Int64(plan.vsize + 8) * rate.satPerVbyte,
                "overshoot should be small"
            )
            // Conservation: everything in is either paid, returned as change,
            // or paid as fee. Nothing evaporates.
            let inTotal = utxos.reduce(Int64(0)) { $0 + $1.valueSat }
            XCTAssertEqual(inTotal, plan.amountSat + (plan.changeSat ?? 0) + plan.feeSat)
        }
    }

    func testSendEverythingLeavesNoChange() throws {
        let signer = try burnSigner()
        let utxos = try burnUtxos([100_000_000, 50_000_000])
        let dest = try Address.parse("pc1qj7lccmpqhdgg6enh503hqqyx244e49yespm8pf").get()

        let plan = try TxBuilder.plan(
            utxos: utxos, to: dest, amountSat: nil,
            feeRate: .normal,
            changeAddress: "pc1qel0k9nyfvgqsgkc4fv9jp9ff37gw48gnsqt2rs",
            signer: signer
        )
        XCTAssertTrue(plan.sendsEverything)
        XCTAssertNil(plan.changeSat)
        XCTAssertEqual(plan.signed.outputs.count, 1)
        XCTAssertEqual(plan.amountSat + plan.feeSat, 150_000_000,
                       "the fee comes out of the payment, not out of change")
    }

    /// Change below the dust threshold cannot be spent again, so paying it out
    /// as fee is strictly better than creating an output nobody can ever move.
    func testDustChangeGoesToTheFee() throws {
        let signer = try burnSigner()
        let utxos = try burnUtxos([100_000_000])
        let dest = try Address.parse("pc1qj7lccmpqhdgg6enh503hqqyx244e49yespm8pf").get()

        // Leave a hair above the fee, so the leftover is under the dust limit.
        let estimated = TxBuilder.estimateFee(
            inputs: 1, outputScripts: [dest.scriptPubKey], rate: .normal
        )
        let amount = 100_000_000 - estimated - 100
        let plan = try TxBuilder.plan(
            utxos: utxos, to: dest, amountSat: amount, feeRate: .normal,
            changeAddress: "pc1qel0k9nyfvgqsgkc4fv9jp9ff37gw48gnsqt2rs",
            signer: signer
        )
        XCTAssertNil(plan.changeSat, "dust change must not become an output")
        XCTAssertEqual(plan.signed.outputs.count, 1)
        XCTAssertEqual(plan.amountSat + plan.feeSat, 100_000_000)
    }

    func testInsufficientFundsIsAnError() throws {
        let signer = try burnSigner()
        let utxos = try burnUtxos([1000])
        let dest = try Address.parse("pc1qj7lccmpqhdgg6enh503hqqyx244e49yespm8pf").get()
        XCTAssertThrowsError(try TxBuilder.plan(
            utxos: utxos, to: dest, amountSat: 100_000_000, feeRate: .normal,
            changeAddress: nil, signer: signer
        )) { error in
            guard case SendPlanError.insufficientFunds = error else {
                return XCTFail("expected insufficientFunds, got \(error)")
            }
        }
    }

    /// Every signature is verified against the same message hash before the
    /// plan is returned. A wallet that broadcasts a bad signature has already
    /// told somebody the money is on its way.
    func testEverySignatureVerifies() throws {
        let signer = try burnSigner()
        let utxos = try burnUtxos([100_000_000, 200_000_000, 300_000_000])
        let dest = try Address.parse("pc1qj7lccmpqhdgg6enh503hqqyx244e49yespm8pf").get()
        let plan = try TxBuilder.plan(
            utxos: utxos, to: dest, amountSat: 550_000_000, feeRate: .fast,
            changeAddress: "pc1qel0k9nyfvgqsgkc4fv9jp9ff37gw48gnsqt2rs",
            signer: signer
        )
        XCTAssertEqual(plan.signed.inputs.count, 3)
        for (i, input) in plan.signed.inputs.enumerated() {
            XCTAssertEqual(input.witness.count, 2, "P2WPKH witness is signature + pubkey")
            let sig = Array(input.witness[0].dropLast())
            let pub = input.witness[1]
            let u = plan.inputs[i]
            let hash = Sighash.p2wpkhSighash(
                tx: plan.signed, index: i,
                scriptCode: Sighash.p2wpkhScriptCode(pubKeyHash: u.pubKeyHash!),
                amountSat: u.valueSat
            )
            XCTAssertTrue(
                Secp256k1.verifyDER(signature: sig, messageHash: hash, publicKey: pub),
                "input \(i)"
            )
            XCTAssertEqual(input.witness[0].last, 0x01, "SIGHASH_ALL")
        }
        // The txid is stable, because signing is deterministic.
        XCTAssertEqual(plan.txid.count, 64)
        XCTAssertFalse(plan.rawHex.isEmpty)
    }
}

private extension Result where Success == Address, Failure == Address.Failure {
    var failure: Address.Failure? {
        if case .failure(let f) = self { return f }
        return nil
    }
}
