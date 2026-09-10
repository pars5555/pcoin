import XCTest
@testable import PCoinKit

/// The test vectors published in PCOIN.md 6.4, pinned against this
/// implementation.
///
/// This is the acceptance test for the whole iOS wallet. Publishing vectors is
/// what turns "any future wallet can restore these words" from a claim into
/// something checkable, and that only holds if the numbers in the document are
/// the numbers this code actually produces. Change anything in the derivation
/// and this fails, which is exactly the moment somebody must go and look at the
/// published document.
///
/// The same values are asserted by the Android app `PublishedVectorsTest.kt`.
/// Three implementations agreeing beats any one of them being careful.
///
/// The mnemonic is BIP39 all-zero-entropy phrase: public, famous, and swept
/// within seconds of anything being sent to it. It is a BURN PHRASE. Never put
/// value on it.
final class PublishedVectorsTests: XCTestCase {

    private let burnPhrase =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"

    private func bip39() throws -> Bip39 { try Bip39.english() }

    func testWordlistIsTheCanonicalOne() throws {
        // If this fails, nothing below means anything: a substituted wordlist
        // changes every derived key silently.
        XCTAssertEqual(Wordlist.words.count, 2048)
        XCTAssertEqual(Wordlist.words.first, "abandon")
        XCTAssertEqual(Wordlist.words.last, "zoo")
        XCTAssertEqual(
            Hashes.sha256(Array(Wordlist.text.utf8)).hex,
            "2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda"
        )
        XCTAssertNoThrow(try Bip39.english())
    }

    func testPublishedMainnetVectors() throws {
        let b = try bip39()
        let words = Bip39.splitWords(burnPhrase)
        XCTAssertEqual(b.validate(words), .ok, "the burn phrase must validate")

        let seed = b.toSeed(mnemonic: words)
        let master = try Bip32.fromSeed(seed)
        let keys = try PcoinDerivation.accountKeys(
            bip39: b, mnemonic: words, network: .mainnet
        )

        XCTAssertEqual(
            seed.hex,
            "5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc1"
                + "9a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4",
            "seed"
        )
        XCTAssertEqual(
            master.serialize(versionBytes: PcoinDerivation.Network.mainnet.extSecretKeyVersion),
            "xprv9s21ZrQH143K3GJpoapnV8SFfukcVBSfeCficPSGfubmSFDxo1kuHnLisriDvSnRRuL2Qrg5ggqHKNVpxR86QEC8w35uxmGoggxtQTPvfUu",
            "master xprv"
        )
        XCTAssertEqual(keys.masterFingerprintHex, "73c5da0a", "master fingerprint")

        XCTAssertEqual(
            keys.accountXprv(),
            "xprv9y14Hos54MVJgZi4fDbHMeHQznnF9PCiwjtq5yCv6YKF1nCBFDSzHRtXHxqCWKy4EE5VXRJDdKcyfpSgrrTKKXJLvkPqWfpcLAXQtZcMRwL",
            "account xprv at m/84'/9444'/0'"
        )
        XCTAssertEqual(
            keys.accountXpub(),
            "xpub6BzQhKPxtj3bu3nXmF8HinE9YpcjYqvaJxpRtMcXesrDtaXKnkmEqED19EcyDUGb3tuRih7NACR2HY1WrfkRP1dHpMZS2imgmrTrV8cVpE3",
            "account xpub at m/84'/9444'/0'"
        )

        // The exact strings PCOIN.md 6.4 publishes, checksums included.
        XCTAssertEqual(
            keys.publicDescriptorWithChecksum(chain: PcoinDerivation.chainExternal),
            "wpkh([73c5da0a/84h/9444h/0h]xpub6BzQhKPxtj3bu3nXmF8HinE9YpcjYqvaJxpRtMcXesrDtaXKnkmEqED19EcyDUGb3tuRih7NACR2HY1WrfkRP1dHpMZS2imgmrTrV8cVpE3/0/*)#w8mxel75",
            "external descriptor"
        )
        XCTAssertEqual(
            keys.publicDescriptorWithChecksum(chain: PcoinDerivation.chainInternal),
            "wpkh([73c5da0a/84h/9444h/0h]xpub6BzQhKPxtj3bu3nXmF8HinE9YpcjYqvaJxpRtMcXesrDtaXKnkmEqED19EcyDUGb3tuRih7NACR2HY1WrfkRP1dHpMZS2imgmrTrV8cVpE3/1/*)#ln78y2wv",
            "internal descriptor"
        )

        // First three receive addresses, m/84'/9444'/0'/0/{0,1,2}.
        XCTAssertEqual(try keys.address(chain: 0, index: 0), "pc1qj7lccmpqhdgg6enh503hqqyx244e49yespm8pf")
        XCTAssertEqual(try keys.address(chain: 0, index: 1), "pc1q0ncnjjyklxwts46h7e7jmls0l8d99lhv3wk0sm")
        XCTAssertEqual(try keys.address(chain: 0, index: 2), "pc1qzze3twr9c0cg0s3v2yh7797gae4ufk7zu4wux0")

        // First three change addresses, m/84'/9444'/0'/1/{0,1,2}.
        XCTAssertEqual(try keys.address(chain: 1, index: 0), "pc1qel0k9nyfvgqsgkc4fv9jp9ff37gw48gnsqt2rs")
        XCTAssertEqual(try keys.address(chain: 1, index: 1), "pc1qszm5tcmmewdgjny34klqv3dupm6jd5939k6e20")
        XCTAssertEqual(try keys.address(chain: 1, index: 2), "pc1qxyzkhz58fs86rxjmm96hz58zt3j0qnx8s76tyg")

        // The first receive address is index 0, generated once and reused.
        XCTAssertEqual(try keys.receiveAddress(), try keys.address(chain: 0, index: 0))
    }

    /// The coin type is the only thing separating a PCoin key tree from a
    /// Bitcoin one, because PCoin kept Bitcoin BIP32 version bytes. This asserts
    /// that they really do diverge, rather than trusting the comment that says
    /// they must.
    func testCoinTypeSeparatesPcoinFromBitcoin() throws {
        let b = try bip39()
        let words = Bip39.splitWords(burnPhrase)
        let seed = b.toSeed(mnemonic: words)
        let master = try Bip32.fromSeed(seed)

        let pcoin = try Bip32.derivePath(master, path: Bip32.parsePath("m/84'/9444'/0'/0/0"))
        let bitcoin = try Bip32.derivePath(master, path: Bip32.parsePath("m/84'/0'/0'/0/0"))
        XCTAssertNotEqual(pcoin.publicKey, bitcoin.publicKey)

        // And the well-known BIP84 Bitcoin address for this phrase, as a check
        // that the derivation itself is standard and it really is only the coin
        // type doing the separating.
        XCTAssertEqual(
            Bech32.encodeP2wpkh(hrp: "bc", pubKeyHash: Hashes.hash160(bitcoin.publicKey)),
            "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu"
        )
    }
}
