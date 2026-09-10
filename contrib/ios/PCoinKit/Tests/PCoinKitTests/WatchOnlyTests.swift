import XCTest
@testable import PCoinKit

/// Watch-only derivation must agree with the private path, address for address.
///
/// This is the invariant the whole "read a balance without Face ID" design rests
/// on. If CKDpub and CKDpriv ever disagreed, the wallet would show a balance for
/// addresses it cannot spend from -- money that appears to be there and is not,
/// which is the worst failure a wallet has.
final class WatchOnlyTests: XCTestCase {

    private let burnPhrase =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"

    func testWatchOnlyDerivesTheSameAddressesAsThePrivatePath() throws {
        let b = try Bip39.english()
        let keys = try PcoinDerivation.accountKeys(
            bip39: b, mnemonic: Bip39.splitWords(burnPhrase), network: .mainnet
        )
        let watch = try XCTUnwrap(keys.watchOnly())

        XCTAssertEqual(watch.masterFingerprintHex, keys.masterFingerprintHex)
        XCTAssertEqual(watch.accountXpub(), keys.accountXpub())

        for chain in [PcoinDerivation.chainExternal, PcoinDerivation.chainInternal] {
            for index in UInt32(0)..<UInt32(25) {
                XCTAssertEqual(
                    try watch.address(chain: chain, index: index),
                    try keys.address(chain: chain, index: index),
                    "m/84'/9444'/0'/\(chain)/\(index)"
                )
            }
        }
    }

    /// And the published vectors, straight from an xpub with no phrase in sight.
    func testWatchOnlyMatchesThePublishedAddresses() throws {
        let watch = try XCTUnwrap(PcoinDerivation.WatchOnlyKeys.parse(
            xpub: "xpub6BzQhKPxtj3bu3nXmF8HinE9YpcjYqvaJxpRtMcXesrDtaXKnkmEqED19EcyDUGb3tuRih7NACR2HY1WrfkRP1dHpMZS2imgmrTrV8cVpE3",
            masterFingerprintHex: "73c5da0a"
        ))
        XCTAssertEqual(try watch.address(chain: 0, index: 0), "pc1qj7lccmpqhdgg6enh503hqqyx244e49yespm8pf")
        XCTAssertEqual(try watch.address(chain: 0, index: 1), "pc1q0ncnjjyklxwts46h7e7jmls0l8d99lhv3wk0sm")
        XCTAssertEqual(try watch.address(chain: 0, index: 2), "pc1qzze3twr9c0cg0s3v2yh7797gae4ufk7zu4wux0")
        XCTAssertEqual(try watch.address(chain: 1, index: 0), "pc1qel0k9nyfvgqsgkc4fv9jp9ff37gw48gnsqt2rs")
        XCTAssertEqual(
            watch.publicDescriptor(chain: 0),
            "wpkh([73c5da0a/84h/9444h/0h]xpub6BzQhKPxtj3bu3nXmF8HinE9YpcjYqvaJxpRtMcXesrDtaXKnkmEqED19EcyDUGb3tuRih7NACR2HY1WrfkRP1dHpMZS2imgmrTrV8cVpE3/0/*)"
        )
    }

    /// Hardened derivation from a public key is impossible, not merely
    /// unsupported. That impossibility is exactly what makes an xpub safe to
    /// cache without a biometric gate.
    func testHardenedPublicDerivationIsRefused() throws {
        let watch = try XCTUnwrap(PcoinDerivation.WatchOnlyKeys.parse(
            xpub: "xpub6BzQhKPxtj3bu3nXmF8HinE9YpcjYqvaJxpRtMcXesrDtaXKnkmEqED19EcyDUGb3tuRih7NACR2HY1WrfkRP1dHpMZS2imgmrTrV8cVpE3",
            masterFingerprintHex: "73c5da0a"
        ))
        _ = watch
        let key = try XCTUnwrap(Bip32.ExtendedPublicKey.parse(
            "xpub6BzQhKPxtj3bu3nXmF8HinE9YpcjYqvaJxpRtMcXesrDtaXKnkmEqED19EcyDUGb3tuRih7NACR2HY1WrfkRP1dHpMZS2imgmrTrV8cVpE3",
            versionBytes: PcoinDerivation.Network.mainnet.extPublicKeyVersion
        ))
        XCTAssertNil(Bip32.deriveChildPublic(key, index: Bip32.hardened(0)))
        XCTAssertNotNil(Bip32.deriveChildPublic(key, index: 0))
    }

    func testXpubParsingRejectsRubbish() {
        let v = PcoinDerivation.Network.mainnet.extPublicKeyVersion
        XCTAssertNil(Bip32.ExtendedPublicKey.parse("", versionBytes: v))
        XCTAssertNil(Bip32.ExtendedPublicKey.parse("not an xpub", versionBytes: v))
        // An xPRV must not parse as an xpub: the version bytes differ, and
        // accepting one would put a private key where a public one was expected.
        XCTAssertNil(Bip32.ExtendedPublicKey.parse(
            "xprv9y14Hos54MVJgZi4fDbHMeHQznnF9PCiwjtq5yCv6YKF1nCBFDSzHRtXHxqCWKy4EE5VXRJDdKcyfpSgrrTKKXJLvkPqWfpcLAXQtZcMRwL",
            versionBytes: v
        ))
        // One character changed: the base58 checksum fails.
        XCTAssertNil(Bip32.ExtendedPublicKey.parse(
            "xpub6BzQhKPxtj3bu3nXmF8HinE9YpcjYqvaJxpRtMcXesrDtaXKnkmEqED19EcyDUGb3tuRih7NACR2HY1WrfkRP1dHpMZS2imgmrTrV8cVpE4",
            versionBytes: v
        ))
    }
}
