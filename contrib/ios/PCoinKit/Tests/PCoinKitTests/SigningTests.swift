import XCTest
@testable import PCoinKit

/// Signing, against BIP143 own published vector.
///
/// This is the test that matters most after the derivation vectors, because
/// signing is the part iOS does that Android does not. The Android wallet runs a
/// node and asks it to sign; there is no node here, so every spend is signed by
/// this code, and a wrong signature is a transaction that looks perfectly fine
/// and that nobody will ever relay.
///
/// The vector is the "Native P2WPKH" example from BIP143, which is convenient
/// beyond being published: it pins the sighash, the DER signature and the final
/// serialisation all at once. The signature match is also a check that RFC6979
/// nonce generation is being used -- a random nonce would produce a different,
/// equally valid signature and this assertion would fail.
final class SigningTests: XCTestCase {

    // The unsigned transaction from BIP143.
    private func bip143Unsigned() -> Transaction {
        var tx = Transaction(
            inputs: [
                Transaction.Input(
                    outpoint: .init(
                        txid: "9f96ade4b41d5433f4eda31e1738ec2b36f6e7d1420d94a6af99801a88f7f7ff",
                        vout: 0
                    ),
                    sequence: 0xFFFFFFEE
                ),
                Transaction.Input(
                    outpoint: .init(
                        txid: "8ac60eb9575db5b2d987e29f301b5b819ea83a5c6579d282d189cc04b8e151ef",
                        vout: 1
                    ),
                    sequence: 0xFFFFFFFF
                ),
            ],
            outputs: [
                Transaction.Output(
                    valueSat: 112_340_000,
                    scriptPubKey: [UInt8](hex: "76a9148280b37df378db99f66f85c95a783a76ac7a6d5988ac")!
                ),
                Transaction.Output(
                    valueSat: 223_450_000,
                    scriptPubKey: [UInt8](hex: "76a9143bde42dbee7e4dbe6a21b2d50ce2f0167faa815988ac")!
                ),
            ],
            version: 1,
            lockTime: 0x11
        )
        tx.inputs[0].scriptSig = []
        return tx
    }

    func testUnsignedSerialisationMatchesBip143() {
        let tx = bip143Unsigned()
        XCTAssertEqual(
            tx.serializedNoWitness().hex,
            "0100000002fff7f7881a8099afa6940d42d1e7f6362bec38171ea3edf433541db4e4ad969f"
                + "0000000000eeffffffef51e1b804cc89d182d279655c3aa89e815b1b309fe287d9b2b5"
                + "5d57b90ec68a0100000000ffffffff02202cb206000000001976a9148280b37df378db"
                + "99f66f85c95a783a76ac7a6d5988ac9093510d000000001976a9143bde42dbee7e4dbe"
                + "6a21b2d50ce2f0167faa815988ac11000000"
        )
    }

    func testBip143SighashAndSignature() throws {
        let tx = bip143Unsigned()
        let pubKeyHash = [UInt8](hex: "1d0f172a0ecb48aee1be1f2687d2963ae33f71a1")!
        let privKey = [UInt8](hex: "619c335025c7f4012e556c2a58b2506e30b8511b53ade95ea316fd8c3286feb9")!

        // The public key the vector publishes, from the private key.
        XCTAssertEqual(
            try Secp256k1.publicKeyCompressed(privKey).hex,
            "025476c2e83188368da1ff3e292e7acafcdb3566bb0ad253f62fc70f07aeee6357"
        )
        // ...and the key hash the scriptPubKey commits to.
        XCTAssertEqual(
            Hashes.hash160(try Secp256k1.publicKeyCompressed(privKey)).hex,
            "1d0f172a0ecb48aee1be1f2687d2963ae33f71a1"
        )

        let sighash = Sighash.p2wpkhSighash(
            tx: tx,
            index: 1,
            scriptCode: Sighash.p2wpkhScriptCode(pubKeyHash: pubKeyHash),
            amountSat: 600_000_000
        )
        XCTAssertEqual(
            sighash.hex,
            "c37af31116d1b27caf68aae9e3ac82f1477929014d5b917657d0eb49478cb670",
            "BIP143 sigHash"
        )

        let der = try Secp256k1.signDER(messageHash: sighash, privateKey: privKey)
        XCTAssertEqual(
            der.hex,
            "304402203609e17b84f6a7d30c80bfa610b5b4542f32a8a0d5447a12fb1366d7f01cc44a"
                + "0220573a954c4518331561406f90300e8f3358f51928d43c212a8caed02de67eebee",
            "the published signature -- a match also proves RFC6979 determinism"
        )
        XCTAssertTrue(Secp256k1.verifyDER(
            signature: der,
            messageHash: sighash,
            publicKey: try Secp256k1.publicKeyCompressed(privKey)
        ))
    }

    func testFullySignedSerialisationMatchesBip143() throws {
        var tx = bip143Unsigned()
        // Input 0 is a P2PK spend, which BIP143 signs the old way. Its scriptSig
        // is taken from the vector: this test is about the SERIALISATION being
        // right when only some inputs carry a witness.
        tx.inputs[0].scriptSig = [UInt8](hex:
            "4830450221008b9d1dc26ba6a9cb62127b02742fa9d754cd3bebf337f7a55d114c8e5cdd30be"
            + "022040529b194ba3f9281a99f2b1c0a19c0489bc22ede944ccf4ecbab4cc618ef3ed01")!

        let pubKeyHash = [UInt8](hex: "1d0f172a0ecb48aee1be1f2687d2963ae33f71a1")!
        let privKey = [UInt8](hex: "619c335025c7f4012e556c2a58b2506e30b8511b53ade95ea316fd8c3286feb9")!
        let sighash = Sighash.p2wpkhSighash(
            tx: tx,
            index: 1,
            scriptCode: Sighash.p2wpkhScriptCode(pubKeyHash: pubKeyHash),
            amountSat: 600_000_000
        )
        let der = try Secp256k1.signDER(messageHash: sighash, privateKey: privKey)
        tx.inputs[1].witness = [
            der + [Sighash.HashType.all.rawValue],
            try Secp256k1.publicKeyCompressed(privKey),
        ]

        XCTAssertEqual(
            tx.serialized().hex,
            "01000000000102fff7f7881a8099afa6940d42d1e7f6362bec38171ea3edf433541db4e4ad969f"
                + "00000000494830450221008b9d1dc26ba6a9cb62127b02742fa9d754cd3bebf337f7a55d"
                + "114c8e5cdd30be022040529b194ba3f9281a99f2b1c0a19c0489bc22ede944ccf4ecbab4"
                + "cc618ef3ed01eeffffffef51e1b804cc89d182d279655c3aa89e815b1b309fe287d9b2b5"
                + "5d57b90ec68a0100000000ffffffff02202cb206000000001976a9148280b37df378db99"
                + "f66f85c95a783a76ac7a6d5988ac9093510d000000001976a9143bde42dbee7e4dbe6a21"
                + "b2d50ce2f0167faa815988ac000247304402203609e17b84f6a7d30c80bfa610b5b4542f"
                + "32a8a0d5447a12fb1366d7f01cc44a0220573a954c4518331561406f90300e8f3358f519"
                + "28d43c212a8caed02de67eebee0121025476c2e83188368da1ff3e292e7acafcdb3566bb"
                + "0ad253f62fc70f07aeee635711000000",
            "BIP144 serialisation, including the empty witness for input 0"
        )
    }

    /// Deterministic signing means the same inputs always produce the same
    /// bytes, which is what makes a signed transaction reproducible and
    /// reviewable. A random nonce would break this and would also risk leaking
    /// the key if the randomness ever repeated.
    func testSigningIsDeterministic() throws {
        let key = [UInt8](hex: "619c335025c7f4012e556c2a58b2506e30b8511b53ade95ea316fd8c3286feb9")!
        let hash = Hashes.sha256(Array("pcoin".utf8))
        let a = try Secp256k1.signDER(messageHash: hash, privateKey: key)
        let b = try Secp256k1.signDER(messageHash: hash, privateKey: key)
        XCTAssertEqual(a, b)
    }

    func testInvalidPrivateKeysAreRefused() {
        XCTAssertFalse(Secp256k1.isValidPrivateKey([UInt8](repeating: 0, count: 32)))
        // n itself, and n+1, are both out of range.
        XCTAssertFalse(Secp256k1.isValidPrivateKey(
            [UInt8](hex: "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141")!
        ))
        XCTAssertTrue(Secp256k1.isValidPrivateKey(
            [UInt8](hex: "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140")!
        ))
    }
}
