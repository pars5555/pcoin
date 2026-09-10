import XCTest
@testable import PCoinKit

/// Two rules that are easy to state and easy to break by accident, so they get
/// a test rather than a comment.
final class RedactAndIndexTests: XCTestCase {

    // MARK: - the phrase never reaches a log

    private let burnPhrase =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"

    /// The Android app has a `Redact.kt` whose whole job is keeping "the phrase
    /// is never logged, never put in a notification, never written anywhere
    /// else" true rather than merely intended. This is its counterpart test.
    func testSecretsAreDescribedNeverPrinted() {
        for kind in [Redact.SecretKind.recoveryPhrase, .seed, .privateKey, .extendedPrivateKey] {
            let text = Redact.describe(kind)
            XCTAssertTrue(text.contains(Redact.placeholder))
            // No length, no prefix, no checksum. Every one of those has been
            // proposed somewhere as "harmless for debugging", and every one of
            // them narrows a brute-force search.
            XCTAssertFalse(text.contains(where: { $0.isNumber }), "no digits in \(text)")
        }
    }

    func testLooksSecretCatchesAPhraseAndAnXprv() throws {
        let words = Wordlist.words
        XCTAssertTrue(Redact.looksSecret(burnPhrase, mnemonicWords: words))
        XCTAssertTrue(Redact.looksSecret("here it is: " + burnPhrase, mnemonicWords: words))
        XCTAssertTrue(Redact.looksSecret(
            "xprv9y14Hos54MVJgZi4fDbHMeHQznnF9PCiwjtq5yCv6YKF1nCBFDSzHRtXHxqCWKy4EE5VXRJDdKcyfpSgrrTKKXJLvkPqWfpcLAXQtZcMRwL",
            mnemonicWords: words
        ))
        // Ordinary prose must not trip it, or the check gets turned off.
        XCTAssertFalse(Redact.looksSecret("Sent 1.5 PCN to pc1q...", mnemonicWords: words))
        XCTAssertFalse(Redact.looksSecret("Could not reach the network", mnemonicWords: words))
        XCTAssertFalse(Redact.looksSecret("", mnemonicWords: words))
    }

    /// Nothing this package can print carries a secret. `PlannedSend` is the
    /// riskiest object -- it is built from private keys -- so it is checked
    /// explicitly.
    func testAPlannedSendDescribesNoSecret() throws {
        let b = try Bip39.english()
        let words = Bip39.splitWords(burnPhrase)
        let keys = try PcoinDerivation.accountKeys(bip39: b, mnemonic: words, network: .mainnet)
        let addr = try keys.address(chain: 0, index: 0)
        let script = try Address.parse(addr).get().scriptPubKey
        let utxo = SpendableUtxo(
            outpoint: .init(txid: String(format: "%064x", 1), vout: 0),
            valueSat: 100_000_000, scriptPubKey: script,
            chain: 0, index: 0, confirmations: 6,
            isCoinbase: false, spendableAccordingToIndex: true
        )
        let plan = try TxBuilder.plan(
            utxos: [utxo],
            to: try Address.parse("pc1qj7lccmpqhdgg6enh503hqqyx244e49yespm8pf").get(),
            amountSat: 10_000_000,
            feeRate: .normal,
            changeAddress: try keys.address(chain: 1, index: 0),
            signer: { chain, index in try keys.privateKey(chain: chain, index: index) }
        )
        let printed = String(describing: plan) + plan.rawHex + plan.txid
        XCTAssertFalse(Redact.looksSecret(printed, mnemonicWords: Wordlist.words))
        XCTAssertFalse(printed.contains("xprv"))
        // The raw transaction contains a SIGNATURE, which is public, and a
        // public key, which is public. Not the private key.
        let priv = try keys.privateKey(chain: 0, index: 0)
        XCTAssertFalse(printed.contains(priv.key.hex), "a private key must never appear")
    }

    // MARK: - the index gate

    private func status(
        stale: Bool, reachable: Bool, behind: Int, reorgs: Int, unwound: Int
    ) -> IndexStatus {
        let json = """
        {"chain":"main","status":"ok","indexed_height":7342,"node_height":7342,
         "blocks_behind":\(behind),"stale":\(stale),"stale_reasons":[],
         "node_reachable":\(reachable),"last_poll_age_seconds":3,
         "blocks_behind_now":\(behind),"reorg_count":\(reorgs),
         "blocks_unwound":\(unwound)}
        """
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return try! d.decode(IndexStatus.self, from: Data(json.utf8))
    }

    /// THE GATE IS THREE THINGS AND NONE OF THEM IS A LIFETIME COUNTER.
    ///
    /// Six PCoin payment rails gated on `blocks_unwound == 0`. One ordinary
    /// 1-block reorg at height 5801 set it to 1 permanently, and all six
    /// silently refused to credit anything for three and a half days while
    /// exiting clean every tick. The live API reports `reorg_count: 1,
    /// blocks_unwound: 1` today, so a wallet shipping that gate would refuse to
    /// work from its very first run.
    func testLifetimeCountersDoNotGate() {
        let healthyAfterAReorg = status(
            stale: false, reachable: true, behind: 0, reorgs: 1, unwound: 1
        )
        XCTAssertTrue(healthyAfterAReorg.isTrustworthy,
                      "a reorg that happened once must not disable the wallet forever")
        XCTAssertNil(healthyAfterAReorg.untrustworthyReason)

        let manyReorgs = status(stale: false, reachable: true, behind: 0, reorgs: 99, unwound: 250)
        XCTAssertTrue(manyReorgs.isTrustworthy)
    }

    func testTheThreeThingsThatDoGate() {
        XCTAssertFalse(
            status(stale: true, reachable: true, behind: 0, reorgs: 0, unwound: 0).isTrustworthy,
            "stale"
        )
        XCTAssertFalse(
            status(stale: false, reachable: false, behind: 0, reorgs: 0, unwound: 0).isTrustworthy,
            "node unreachable"
        )
        XCTAssertFalse(
            status(stale: false, reachable: true, behind: 3, reorgs: 0, unwound: 0).isTrustworthy,
            "behind"
        )
        // And each one says why, in words somebody can act on.
        XCTAssertNotNil(
            status(stale: true, reachable: true, behind: 0, reorgs: 0, unwound: 0)
                .untrustworthyReason
        )
    }

    /// The broadcast answer is three-valued and must stay that way. `?? false`
    /// on `network.has_it` tells somebody their payment failed while it may be
    /// confirming.
    func testBroadcastOutcomeKeepsUnknownApart() throws {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase

        let rejected = try d.decode(BroadcastResponse.self, from: Data("""
        {"txid":"aa","accepted_by_node":false,
         "error":{"code":"rejected","message":"bad-txns-inputs-missingorspent","rpc_code":-25},
         "network":{"has_it":false,"state":"rejected","peers":3}}
        """.utf8))
        XCTAssertEqual(rejected.network?.hasIt, false)

        let unknown = try d.decode(BroadcastResponse.self, from: Data("""
        {"txid":"bb","accepted_by_node":true,
         "network":{"has_it":null,"state":"submitted","peers":3}}
        """.utf8))
        XCTAssertNil(unknown.network?.hasIt, "null must survive decoding as nil, not as false")

        let sent = try d.decode(BroadcastResponse.self, from: Data("""
        {"txid":"cc","accepted_by_node":true,
         "network":{"has_it":true,"state":"relayed","peers":3}}
        """.utf8))
        XCTAssertEqual(sent.network?.hasIt, true)
    }
}
