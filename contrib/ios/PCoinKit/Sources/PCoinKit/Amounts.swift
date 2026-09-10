import Foundation

/// Decimal text to satoshis, and back.
///
/// A port of the Android `Amounts.kt`, and it keeps that file rules exactly,
/// because this is the one place where a slip becomes a 100,000,000x error.
///
///  * Integer arithmetic only. `Double("0.1")! * 1e8` is 10000000.000000002 and
///    rounding that is a coin flip on the last satoshi. Foundation `Decimal` is
///    better but still has a fixed 38-digit mantissa and its own rounding
///    surprises, so the parser below works on the digits as written and never
///    builds a floating value at all.
///  * At most 8 decimal places. More is a typo, not a tiny amount, and silently
///    rounding it would send something other than what was typed.
///  * The separator is a literal '.', never the locale one. A phone set to
///    German renders 1,5 but the node parses 1.5, and accepting both spellings
///    from one field is how somebody sends 15 PCN meaning 1.5.
///  * Rejects negatives, blanks, and anything non-finite.
public enum Amounts {

    public static let satsPerCoin: Int64 = 100_000_000

    /// The dust threshold for P2WPKH: an output below this is unspendable.
    public static let dustSat: Int64 = 294

    /// 21 M, in satoshis. Anything past it cannot exist.
    public static let maxSupplySat: Int64 = 21_000_000 * 100_000_000

    public enum Reason: Equatable {
        case empty
        case notANumber
        case tooManyDecimals
        case negative
        case zero
        case dust
        case tooLarge
    }

    public enum Parsed: Equatable {
        case ok(Int64)
        case bad(Reason)

        /// The satoshi value, or nil.
        ///
        /// Deliberately optional and deliberately never zero-defaulted. A
        /// caller that writes `?? 0` here has turned "this is not an amount"
        /// into "the amount is nothing", which is the exact shape of mistake
        /// section 7.1 of CLAUDE.md is about.
        public var satOrNil: Int64? {
            if case .ok(let s) = self { return s }
            return nil
        }
    }

    /// Parse user input.
    ///
    /// Accepts a leading/trailing space and a leading '+', because people
    /// paste. Accepts no grouping separators at all: "1,000" is ambiguous
    /// across locales and is rejected rather than guessed at.
    public static func parse(_ raw: String?) -> Parsed {
        var s = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("+") { s.removeFirst() }
        s = s.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty { return .bad(.empty) }
        if s.contains(",") { return .bad(.notANumber) }

        guard let d = DecimalText(s) else { return .bad(.notANumber) }
        if d.isNegative { return .bad(.negative) }
        // `scale` is the number of digits after the point once any exponent has
        // been applied, which is what BigDecimal.scale() means on Android.
        if d.scale > 8 { return .bad(.tooManyDecimals) }
        if d.isZero { return .bad(.zero) }
        guard let sat = d.satoshis() else { return .bad(.tooLarge) }
        if sat > maxSupplySat { return .bad(.tooLarge) }

        // Dust is deliberately NOT checked here. "Is this a number?" and "is
        // this worth sending?" are different questions: the first belongs to
        // the field as somebody types, the second to the send path, which is
        // also the only place that knows whether this is an exact amount or a
        // send-everything.
        return .ok(sat)
    }

    /// Would this output be unspendable? Asked at send time, not at parse time.
    public static func isDust(_ sat: Int64) -> Bool { sat < dustSat }

    /// Satoshis to the exact fixed-point string, e.g. "1.50000000".
    ///
    /// NOT built from a Double. Every amount that crosses a wire or reaches a
    /// screen goes through here.
    public static func toPlainString(_ sat: Int64) -> String {
        let negative = sat < 0
        let v = negative ? -sat : sat
        let whole = v / satsPerCoin
        let frac = v % satsPerCoin
        return (negative ? "-" : "") + String(whole) + "." + String(format: "%08lld", frac)
    }

    /// Same digits, for the places that historically called it this.
    public static func toNodeString(_ sat: Int64) -> String { toPlainString(sat) }

    /// A whole-coin `Double` for a JSON amount, converted to satoshis without
    /// ever letting the Double reach a balance.
    ///
    /// The explorer returns amounts as bare JSON numbers -- there is no string
    /// form, so this conversion has to happen somewhere. It happens here, once,
    /// with an explicit round, and everything downstream is `Int64`.
    public static func satoshis(fromCoins coins: Double) -> Int64 {
        (coins * 1e8).rounded() >= 9.2e18 ? Int64.max : Int64((coins * 1e8).rounded())
    }
}

/// A decimal number as written, kept as digits plus a scale.
///
/// Exists so `Amounts.parse` never constructs a binary floating value. Accepts
/// the same grammar `BigDecimal(String)` does on the JVM, including an exponent,
/// so the two wallets agree about odd-but-legal input such as "1.5e3".
struct DecimalText {
    /// Digits with the point removed, most significant first. No sign.
    let digits: [UInt8]
    /// Digits after the decimal point, after the exponent has been applied.
    let scale: Int
    let isNegative: Bool

    var isZero: Bool { digits.allSatisfy { $0 == 0 } }

    init?(_ text: String) {
        let chars = Array(text)
        var i = 0
        var negative = false
        if i < chars.count, chars[i] == "-" || chars[i] == "+" {
            negative = chars[i] == "-"
            i += 1
        }
        var intPart = [UInt8]()
        var fracPart = [UInt8]()
        var sawDigit = false
        while i < chars.count, let v = chars[i].wholeNumberValue, chars[i].isASCII, chars[i].isNumber {
            intPart.append(UInt8(v)); i += 1; sawDigit = true
        }
        if i < chars.count, chars[i] == "." {
            i += 1
            while i < chars.count, let v = chars[i].wholeNumberValue, chars[i].isASCII, chars[i].isNumber {
                fracPart.append(UInt8(v)); i += 1; sawDigit = true
            }
        }
        guard sawDigit else { return nil }

        var exponent = 0
        if i < chars.count, chars[i] == "e" || chars[i] == "E" {
            i += 1
            var expNegative = false
            if i < chars.count, chars[i] == "-" || chars[i] == "+" {
                expNegative = chars[i] == "-"
                i += 1
            }
            var expDigits = 0
            var value = 0
            while i < chars.count, let v = chars[i].wholeNumberValue, chars[i].isASCII, chars[i].isNumber {
                // A wildly large exponent is not a number anybody typed. Bail
                // rather than overflow.
                if value > 1_000_000 { return nil }
                value = value * 10 + v
                expDigits += 1
                i += 1
            }
            guard expDigits > 0 else { return nil }
            exponent = expNegative ? -value : value
        }
        guard i == chars.count else { return nil }

        self.digits = intPart + fracPart
        self.scale = fracPart.count - exponent
        self.isNegative = negative
    }

    /// The value in satoshis, or nil if it does not fit in `Int64`.
    ///
    /// Only called once `scale <= 8` has been checked, so the shift is never
    /// negative and no rounding is ever needed.
    func satoshis() -> Int64? {
        let shift = 8 - scale
        guard shift >= 0 else { return nil }
        var acc: Int64 = 0
        for d in digits {
            let (m, o1) = acc.multipliedReportingOverflow(by: 10)
            if o1 { return nil }
            let (a, o2) = m.addingReportingOverflow(Int64(d))
            if o2 { return nil }
            acc = a
        }
        for _ in 0..<shift {
            let (m, o) = acc.multipliedReportingOverflow(by: 10)
            if o { return nil }
            acc = m
        }
        return acc
    }
}
