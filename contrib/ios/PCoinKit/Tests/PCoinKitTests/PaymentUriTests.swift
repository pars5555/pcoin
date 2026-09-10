import XCTest
@testable import PCoinKit

/// The payment-link rules, asserted against the same cases the Android
/// `PaymentUriTest.kt` asserts.
///
/// Two wallets disagreeing about what an address IS is the worst possible place
/// for them to differ, so these are copied rather than reinvented. The three
/// cases in section 3 of the iOS brief are the last three tests.
final class PaymentUriTests: XCTestCase {

    private let addr = "pc1qnfk7xenwzxx7h4mx88g004crlx0m2zcjg3nq4j"

    func testBareAddress() {
        let t = PaymentUri.parse(addr)
        XCTAssertEqual(t?.address, addr)
        XCTAssertNil(t?.amountSat, "a bare address states no amount")
    }

    func testSchemePrefixes() {
        for scheme in ["pcoin:", "PCOIN:", "pcn:", "bitcoin:", "pcoin://"] {
            let t = PaymentUri.parse(scheme + addr)
            XCTAssertEqual(t?.address, addr, "scheme \(scheme)")
        }
    }

    func testUpperCaseBech32IsFoldedDown() {
        // QR encoders switch to alphanumeric mode for capitals, which is far
        // denser. BIP173 allows it and real codes use it.
        let t = PaymentUri.parse(addr.uppercased())
        XCTAssertEqual(t?.address, addr)
    }

    func testMixedCaseIsLeftAloneAndLaterRejected() {
        // Mixed case cannot be valid bech32. PaymentUri does not judge that --
        // it leaves the text alone and the validator says so.
        let mixed = "pc1QNFK7xenwzxx7h4mx88g004crlx0m2zcjg3nq4j"
        XCTAssertEqual(PaymentUri.parse(mixed)?.address, mixed)
        XCTAssertFalse(Address.isValid(mixed))
    }

    func testBase58IsNotFolded() {
        // Base58 IS case-sensitive; folding it would corrupt a legitimate
        // address into a different one.
        let p = "PGh8LmLLGXfCSFPYJnbBLBRDLGqLXvFVYQ"
        XCTAssertEqual(PaymentUri.parse(p)?.address, p)
    }

    func testAmountIsRead() {
        let t = PaymentUri.parse("pcoin:\(addr)?amount=7.25")
        XCTAssertEqual(t?.amountSat, 725_000_000)
    }

    func testAmountAmongOtherParameters() {
        let t = PaymentUri.parse("pcoin:\(addr)?label=Shop&amount=1.5&message=hi")
        XCTAssertEqual(t?.amountSat, 150_000_000)
    }

    /// FIX 1 of three. An unreadable amount yields nil, never zero.
    ///
    /// Nil means "not stated" and leaves the box empty, which is a visible gap
    /// somebody fills in and reviews. Zero would be a confident answer to a
    /// question nobody asked.
    func testUnreadableAmountIsNilNotZero() {
        for bad in ["", "abc", "-1", "1,5", "0", "1.123456789"] {
            let t = PaymentUri.parse("pcoin:\(addr)?amount=\(bad)")
            XCTAssertEqual(t?.address, addr, "the address must still get through: \(bad)")
            XCTAssertNil(t?.amountSat, "amount=\(bad) must not become a number")
        }
    }

    func testNoAmountParameterIsNil() {
        XCTAssertNil(PaymentUri.parse("pcoin:\(addr)?label=Shop")?.amountSat)
    }

    /// FIX 3 of three, and the one that was found on hardware.
    ///
    /// "...nq4j\?amount=7.25" -- one stray escape -- used to parse as an address
    /// with a trailing backslash and was displayed as legitimate all the way to
    /// the send form. Windows already refused it, so the two wallets disagreed.
    func testStrayEscapeIsRefusedOutright() {
        let doctored = "pcoin:" + addr + "\\?amount=7.25"
        XCTAssertNil(PaymentUri.parse(doctored),
                     "a backslash in the address means the text was not just an address")
    }

    func testNonAlphanumericIsRefused() {
        // NOT a space: PaymentUri trims the whole string first, exactly as
        // the Android parser does, so trailing whitespace is not junk -- it is
        // whitespace somebody pasted.
        for junk in ["\\", "/", "-", "_", ".", "@", "%", "+"] {
            XCTAssertNil(
                PaymentUri.parse("pcoin:" + addr + junk),
                "a trailing \(junk) must refuse the whole request"
            )
        }
    }

    func testSurroundingWhitespaceIsTrimmedNotRefused() {
        XCTAssertEqual(PaymentUri.parse("  pcoin:" + addr + "  ")?.address, addr)
        XCTAssertEqual(PaymentUri.parse(addr + "\n")?.address, addr)
    }

    func testTooShortIsNotAnAddress() {
        XCTAssertNil(PaymentUri.parse("pcoin:pc1qshort"))
        XCTAssertNil(PaymentUri.parse("hello"))
        XCTAssertNil(PaymentUri.parse(""))
        XCTAssertNil(PaymentUri.parse(nil))
    }

    func testBuildRoundTrips() {
        XCTAssertEqual(PaymentUri.build(address: addr), "pcoin:" + addr)
        XCTAssertEqual(
            PaymentUri.build(address: addr, amountSat: 725_000_000),
            "pcoin:\(addr)?amount=7.25000000"
        )
        let round = PaymentUri.parse(PaymentUri.build(address: addr, amountSat: 725_000_000))
        XCTAssertEqual(round?.address, addr)
        XCTAssertEqual(round?.amountSat, 725_000_000)
    }
}
