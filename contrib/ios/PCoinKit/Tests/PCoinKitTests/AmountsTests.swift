import XCTest
@testable import PCoinKit

/// Amount parsing, which is the one place where a slip becomes a 100,000,000x
/// error.
///
/// Mirrors the Android `AmountsTest.kt`. Both wallets have to agree about what
/// somebody typed, because the same person will type the same thing into both.
final class AmountsTests: XCTestCase {

    private func sat(_ s: String) -> Int64? { Amounts.parse(s).satOrNil }

    func testPlainDecimals() {
        XCTAssertEqual(sat("1"), 100_000_000)
        XCTAssertEqual(sat("1.5"), 150_000_000)
        XCTAssertEqual(sat("0.00000001"), 1)
        XCTAssertEqual(sat("7.25"), 725_000_000)
        XCTAssertEqual(sat("21000000"), 2_100_000_000_000_000)
        XCTAssertEqual(sat("  1.5  "), 150_000_000, "people paste")
        XCTAssertEqual(sat("+1.5"), 150_000_000, "people paste")
        XCTAssertEqual(sat(".5"), 50_000_000)
    }

    /// No floating point anywhere near this. `Double("0.1")! * 1e8` is
    /// 10000000.000000002 and rounding that is a coin flip on the last satoshi.
    func testNoFloatingPointDrift() {
        XCTAssertEqual(sat("0.1"), 10_000_000)
        XCTAssertEqual(sat("0.3"), 30_000_000)
        XCTAssertEqual(sat("1.1"), 110_000_000)
        XCTAssertEqual(sat("2.675"), 267_500_000)
        XCTAssertEqual(sat("0.07"), 7_000_000)
        // The classic: 0.1 + 0.2 in binary floating point is not 0.3.
        XCTAssertEqual(sat("0.1")! + sat("0.2")!, sat("0.3")!)
    }

    func testRejections() {
        XCTAssertEqual(Amounts.parse(""), .bad(.empty))
        XCTAssertEqual(Amounts.parse("   "), .bad(.empty))
        XCTAssertEqual(Amounts.parse(nil), .bad(.empty))
        XCTAssertEqual(Amounts.parse("abc"), .bad(.notANumber))
        XCTAssertEqual(Amounts.parse("1.2.3"), .bad(.notANumber))
        XCTAssertEqual(Amounts.parse("0"), .bad(.zero))
        XCTAssertEqual(Amounts.parse("0.0"), .bad(.zero))
        XCTAssertEqual(Amounts.parse("-1"), .bad(.negative))
        XCTAssertEqual(Amounts.parse("1.123456789"), .bad(.tooManyDecimals))
        XCTAssertEqual(Amounts.parse("21000001"), .bad(.tooLarge))
    }

    /// The separator is a literal '.', never the locale one. A phone set to
    /// German renders 1,5 but the node parses 1.5, and accepting both spellings
    /// from one field is how somebody sends 15 PCN meaning 1.5.
    func testCommaIsRefusedRatherThanGuessedAt() {
        XCTAssertEqual(Amounts.parse("1,5"), .bad(.notANumber))
        XCTAssertEqual(Amounts.parse("1,000"), .bad(.notANumber))
        XCTAssertEqual(Amounts.parse("1,000.50"), .bad(.notANumber))
    }

    /// `BigDecimal(String)` on the JVM accepts an exponent, so the Android
    /// parser does too. Matching that keeps the two wallets from disagreeing
    /// about an odd-but-legal payment link.
    func testExponentsMatchTheJvmParser() {
        XCTAssertEqual(sat("1e2"), 10_000_000_000)
        XCTAssertEqual(sat("1.5e3"), 150_000_000_000)
        XCTAssertEqual(sat("1e-8"), 1)
        // scale() > 8 once the exponent is applied.
        XCTAssertEqual(Amounts.parse("1e-9"), .bad(.tooManyDecimals))
        XCTAssertEqual(Amounts.parse("1e"), .bad(.notANumber))
    }

    func testFormattingIsExactFixedPoint() {
        XCTAssertEqual(Amounts.toPlainString(0), "0.00000000")
        XCTAssertEqual(Amounts.toPlainString(1), "0.00000001")
        XCTAssertEqual(Amounts.toPlainString(100_000_000), "1.00000000")
        XCTAssertEqual(Amounts.toPlainString(150_000_000), "1.50000000")
        XCTAssertEqual(Amounts.toPlainString(2_100_000_000_000_000), "21000000.00000000")
        // Never "1.0E-8", which is what a Double round trip produces and what a
        // node rejects.
        XCTAssertFalse(Amounts.toPlainString(1).contains("E"))
    }

    func testRoundTrip() {
        for s in [Int64(1), 294, 100_000_000, 123_456_789, 2_100_000_000_000_000] {
            XCTAssertEqual(sat(Amounts.toPlainString(s)), s, "round trip \(s)")
        }
    }

    /// Dust is deliberately NOT a parse error. "Is this a number?" and "is this
    /// worth sending?" are different questions, and conflating them once made a
    /// valid 1-satoshi amount unparseable.
    func testDustParsesAndIsJudgedLater() {
        XCTAssertEqual(sat("0.00000001"), 1)
        XCTAssertTrue(Amounts.isDust(1))
        XCTAssertTrue(Amounts.isDust(293))
        XCTAssertFalse(Amounts.isDust(294))
    }

    /// `satOrNil` must never be defaulted to zero by a caller. This asserts the
    /// shape that makes `?? 0` visible at the call site rather than silent.
    func testUnknownIsOptionalNotZero() {
        XCTAssertNil(Amounts.parse("nonsense").satOrNil)
        XCTAssertNil(Amounts.parse("0").satOrNil, "zero is refused, not returned")
    }
}
