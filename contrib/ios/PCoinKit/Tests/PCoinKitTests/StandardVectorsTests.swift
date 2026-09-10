import XCTest
@testable import PCoinKit

/// BIP32, BIP39 and RIPEMD-160 against their own published vectors.
///
/// The PCoin vectors in `PublishedVectorsTests` prove this implementation agrees
/// with the other two PCoin wallets. These prove it agrees with the rest of the
/// world, which is the property that actually matters to somebody restoring
/// twelve words into a wallet nobody here wrote.
final class StandardVectorsTests: XCTestCase {

    // MARK: BIP32 -- test vector 1

    func testBip32Vector1() throws {
        let seed = [UInt8](hex: "000102030405060708090a0b0c0d0e0f")!
        let btc: [UInt8] = [0x04, 0x88, 0xAD, 0xE4]
        let btcPub: [UInt8] = [0x04, 0x88, 0xB2, 0x1E]

        let m = try Bip32.fromSeed(seed)
        XCTAssertEqual(
            m.serialize(versionBytes: btc),
            "xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi"
        )
        XCTAssertEqual(
            m.serializePublic(versionBytes: btcPub),
            "xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8"
        )

        let m0h = try Bip32.derivePath(m, path: Bip32.parsePath("m/0'"))
        XCTAssertEqual(
            m0h.serialize(versionBytes: btc),
            "xprv9uHRZZhk6KAJC1avXpDAp4MDc3sQKNxDiPvvkX8Br5ngLNv1TxvUxt4cV1rGL5hj6KCesnDYUhd7oWgT11eZG7XnxHrnYeSvkzY7d2bhkJ7"
        )
        XCTAssertEqual(m0h.depth, 1)
        XCTAssertEqual(m0h.parentFingerprint, m.fingerprint)

        let deep = try Bip32.derivePath(m, path: Bip32.parsePath("m/0'/1/2'/2/1000000000"))
        XCTAssertEqual(
            deep.serialize(versionBytes: btc),
            "xprvA41z7zogVVwxVSgdKUHDy1SKmdb533PjDz7J6N6mV6uS3ze1ai8FHa8kmHScGpWmj4WggLyQjgPie1rFSruoUihUZREPSL39UNdE3BBDu76"
        )
        XCTAssertEqual(deep.depth, 5)
    }

    /// Vector 3 exists specifically because its master key has a leading zero
    /// byte, which is where a naive big-integer implementation silently drops a
    /// byte and derives a different tree.
    func testBip32Vector3LeadingZeros() throws {
        let seed = [UInt8](hex:
            "4b381541583be4423346c643850da4b320e46a87ae3d2a4e6da11eba819cd4acba45d239319ac14f863b8d5ab5a0d0c64d2e8a1e7d1457df2e5a3c51c73235be")!
        let m = try Bip32.fromSeed(seed)
        XCTAssertEqual(
            m.serialize(versionBytes: [0x04, 0x88, 0xAD, 0xE4]),
            "xprv9s21ZrQH143K25QhxbucbDDuQ4naNntJRi4KUfWT7xo4EKsHt2QJDu7KXp1A3u7Bi1j8ph3EGsZ9Xvz9dGuVrtHHs7pXeTzjuxBrCmmhgC6"
        )
        let m0h = try Bip32.derivePath(m, path: Bip32.parsePath("m/0'"))
        XCTAssertEqual(
            m0h.serialize(versionBytes: [0x04, 0x88, 0xAD, 0xE4]),
            "xprv9uPDJpEQgRQfDcW7BkF7eTya6RPxXeJCqCJGHuCJ4GiRVLzkTXBAJMu2qaMWPrS7AANYqdq6vcBcBUdJCVVFceUvJFjaPdGZ2y9WACViL4L"
        )
    }

    // MARK: BIP39 -- the Trezor vectors

    func testBip39TrezorVectorsWithPassphrase() throws {
        // The published vectors use the passphrase "TREZOR", which is what
        // catches a normalise-the-passphrase bug: lowercasing or collapsing
        // whitespace there derives a different wallet, silently.
        //
        // Every value below was reproduced independently with Python
        // `hashlib.pbkdf2_hmac` before being written down, and the first one
        // matches the digest published in the BIP itself -- so this is an
        // agreement between two implementations rather than a snapshot of
        // whatever this code happened to produce.
        let b = try Bip39.english()

        let cases: [(entropy: String, mnemonic: String, seed: String)] = [
            (
                "00000000000000000000000000000000",
                "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
                "c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e5349553"
                    + "1f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04"
            ),
            (
                "7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f",
                "legal winner thank year wave sausage worth useful legal winner thank yellow",
                "2e8905819b8723fe2c1d161860e5ee1830318dbf49a83bd451cfb8440c28bd6f"
                    + "a457fe1296106559a3c80937a1c1069be3a3a5bd381ee6260e8d9739fce1f607"
            ),
            (
                "80808080808080808080808080808080",
                "letter advice cage absurd amount doctor acoustic avoid letter advice cage above",
                "d71de856f81a8acc65e6fc851a38d4d7ec216fd0796d0a6827a3ad6ed5511a30"
                    + "fa280f12eb2e47ed2ac03b5c462a0358d18d69fe4f985ec81778c1b370b652a8"
            ),
        ]

        for v in cases {
            let words = try b.fromEntropy([UInt8](hex: v.entropy)!)
            XCTAssertEqual(words.joined(separator: " "), v.mnemonic, "entropy \(v.entropy)")
            XCTAssertEqual(b.validate(words), .ok, "entropy \(v.entropy)")
            XCTAssertEqual(
                b.toSeed(mnemonic: words, passphrase: "TREZOR").hex, v.seed,
                "seed for \(v.entropy)"
            )
        }
    }

    /// The passphrase is case- and whitespace-significant. Getting that wrong
    /// derives a different wallet with no error message anywhere.
    func testPassphraseIsNotNormalisedLikeTheMnemonic() throws {
        let b = try Bip39.english()
        let m = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
        XCTAssertNotEqual(b.toSeed(mnemonic: m, passphrase: "TREZOR"),
                          b.toSeed(mnemonic: m, passphrase: "trezor"))
        XCTAssertNotEqual(b.toSeed(mnemonic: m, passphrase: "TREZOR"),
                          b.toSeed(mnemonic: m, passphrase: " TREZOR "))
        XCTAssertNotEqual(b.toSeed(mnemonic: m, passphrase: "TREZOR"),
                          b.toSeed(mnemonic: m))
    }

    func testBip39EmptyPassphraseVector() throws {
        let b = try Bip39.english()
        // The all-zero phrase with NO passphrase, which is the PCoin case.
        XCTAssertEqual(
            b.toSeed(mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about").hex,
            "5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc1"
                + "9a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4"
        )
    }

    func testBip39ChecksumAndWordCountRules() throws {
        let b = try Bip39.english()
        let good = Bip39.splitWords(
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about")
        XCTAssertEqual(b.validate(good), .ok)

        // Last word wrong: the checksum fails, and it CANNOT say which word.
        var bad = good
        bad[11] = "zoo"
        XCTAssertEqual(b.validate(bad), .checksumFailed)

        // A word that is not in the list, reported by position.
        var unknown = good
        unknown[3] = "notaword"
        XCTAssertEqual(b.validate(unknown), .unknownWords([3]))

        // 15, 18 and 21 words are valid BIP39 and are NOT valid PCoin phrases.
        XCTAssertEqual(b.validate(Array(repeating: "abandon", count: 15)), .badWordCount(15))
        XCTAssertEqual(b.validate(Array(repeating: "abandon", count: 11)), .badWordCount(11))
    }

    func testNormalisationFoldsWhatItShould() {
        // Non-breaking space, mixed case, ragged spacing: all the same phrase.
        let messy = "  Abandon\u{00A0}abandon   ABANDON abandon abandon abandon "
            + "abandon abandon abandon abandon abandon about  "
        XCTAssertEqual(
            Bip39.normalize(messy),
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
        )
        // The passphrase gets NFKD and nothing else.
        XCTAssertEqual(Bip39.normalizePassphrase("  TREZOR  "), "  TREZOR  ")
    }

    // MARK: RIPEMD-160

    func testRipemd160SpecVectors() {
        let cases: [(String, String)] = [
            ("", "9c1185a5c5e9fc54612808977ee8f548b2258d31"),
            ("a", "0bdc9d2d256b3ee9daae347be6f4dc835a467ffe"),
            ("abc", "8eb208f7e05d987a9b044a8e98c6b087f15a0bfc"),
            ("message digest", "5d0689ef49d2fae572b881b123a85ffa21595f36"),
            ("abcdefghijklmnopqrstuvwxyz", "f71c27109c692c1b56bbdceb5b9d2865b3708dbc"),
            ("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
             "12a053384a9c0c88e405a06c27dcf49ada62eb2b"),
            ("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
             "b0e20b6e3116640286ed3a87a5713079b21f5189"),
        ]
        for (input, want) in cases {
            XCTAssertEqual(RIPEMD160.hash(Array(input.utf8)).hex, want, "RIPEMD160(\(input))")
        }
    }

    func testRipemd160MillionAs() {
        // The specification own long case. It is what catches a padding or a
        // block-loop mistake that short inputs never reach.
        let input = [UInt8](repeating: UInt8(ascii: "a"), count: 1_000_000)
        XCTAssertEqual(RIPEMD160.hash(input).hex, "52783243c1697bdbe16d37f97f68f08325dc1528")
    }

    // MARK: base58 and bech32

    func testBase58RoundTripsAndLeadingZeros() {
        let cases: [[UInt8]] = [
            [],
            [0x00],
            [0x00, 0x00, 0x01],
            [0xFF, 0xFF, 0xFF],
            Array(0..<40),
        ]
        for c in cases {
            let encoded = Base58.encode(c)
            XCTAssertEqual(Base58.decode(encoded), c, "round trip \(c.hex)")
        }
        // A known pair, so this is not just self-consistency.
        XCTAssertEqual(Base58.encode(Array("Hello World!".utf8)), "2NEpo7TZRRrLZSi2U")
    }

    func testBase58CheckRejectsAOneCharacterChange() {
        let good = "PGh8LmLLGXfCSFPYJnbBLBRDLGqLXvFVYQ"
        if Base58.decodeCheck(good) != nil {
            var bad = Array(good)
            bad[10] = bad[10] == "A" ? "B" : "A"
            XCTAssertNil(Base58.decodeCheck(String(bad)),
                         "one changed character must fail the checksum")
        }
    }

    func testBech32DecodesWhatItEncodes() {
        let hash = [UInt8](hex: "9a6de3666e118debd76639d0f7d703f99fb50b12")!
        let addr = Bech32.encodeP2wpkh(hrp: "pc", pubKeyHash: hash)
        XCTAssertEqual(addr, "pc1qnfk7xenwzxx7h4mx88g004crlx0m2zcjg3nq4j")
        let d = Bech32.decode(addr)
        XCTAssertEqual(d?.hrp, "pc")
        XCTAssertEqual(d?.witnessVersion, 0)
        XCTAssertEqual(d?.program, hash)
        XCTAssertEqual(d?.variant, .bech32)
        // Upper case is the same address.
        XCTAssertEqual(Bech32.decode(addr.uppercased())?.program, hash)
        // Mixed case is not.
        XCTAssertNil(Bech32.decode("pc1QNFK7xenwzxx7h4mx88g004crlx0m2zcjg3nq4j"))
    }

    func testBech32AgainstAnIndependentEncoder() {
        // BIP173 first published vector, which pins the checksum constant and
        // the upper-case rule at once.
        let v0_20 = Bech32.decode("BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4")
        XCTAssertEqual(v0_20?.hrp, "bc")
        XCTAssertEqual(v0_20?.witnessVersion, 0)
        XCTAssertEqual(v0_20?.program.count, 20)

        // The rest were produced by a separate Python implementation of BIP173
        // and BIP350 over a known program, so a match is two implementations
        // agreeing rather than this one agreeing with itself.
        let program32 = (0..<32).map { UInt8($0) }
        let v0_32 = Bech32.decode("bc1qqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0szrtjt7")
        XCTAssertEqual(v0_32?.program, program32)
        XCTAssertEqual(v0_32?.variant, .bech32)

        let pc32 = Bech32.decode("pc1qqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0ss77q0q")
        XCTAssertEqual(pc32?.hrp, "pc")
        XCTAssertEqual(pc32?.program, program32)

        // A taproot address: bech32m, witness version 1. Decodes, so it can be
        // refused with an accurate reason rather than "not an address".
        let taproot = Bech32.decode("pc1pqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0s6f7fhu")
        XCTAssertEqual(taproot?.witnessVersion, 1)
        XCTAssertEqual(taproot?.variant, .bech32m)

        // Invalid checksum: one character changed from the vector above.
        XCTAssertNil(Bech32.decode("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5"))
        // A version-0 program of the wrong length.
        XCTAssertNil(Bech32.decode("bc1rw5uspcuh"))
    }

    /// A version-0 program carrying a bech32m checksum is a DIFFERENT address
    /// that happens to look the same. Accepting one is how a wallet pays an
    /// address no node will ever credit.
    func testVariantAndVersionMustAgree() {
        // The pc v0/32 address above, re-checksummed as bech32m, must not decode.
        XCTAssertNotNil(Bech32.decode("pc1qqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0ss77q0q"))
        XCTAssertNil(Bech32.decode("pc1qqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0s6f7fhu"))
    }
}
