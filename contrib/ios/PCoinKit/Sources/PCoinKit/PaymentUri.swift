import Foundation

/// What a scanned QR code or a tapped payment link might contain, and what to
/// do with it.
///
/// PURE. No UIKit, no SwiftUI, so every rule below runs under `swift test` on a
/// machine with no simulator. The camera and the decoder live in `ScanView`;
/// this file decides what the decoded TEXT means.
///
/// A line-for-line port of the Android `PaymentUri.kt`, including the three
/// fixes shipped in 0.2.20. Two wallets disagreeing about what an address IS is
/// the worst possible place for them to differ, so the rules are copied rather
/// than reinvented, and `PaymentUriTests` asserts the same cases the Android
/// `PaymentUriTest.kt` asserts.
///
/// WHAT THIS DOES NOT DO. It does not decide that an address is spendable or
/// that it is on this chain. `Address.parse` does that, and the send screen
/// still shows the destination that was actually built. A scan is a faster way
/// to fill a text field and nothing more.
///
/// FORMS ACCEPTED
///
///     pc1q...                    a bare address, which is what the Receive
///                                screen encodes
///     pcoin:pc1q...              a URI, which is what other wallets tend to
///     pcoin:pc1q...?amount=1.5   with an amount, BIP21 style
///     PC1Q...                    upper case, because QR encoders switch to
///                                alphanumeric mode for it
///
/// UPPER CASE IS NOT A CURIOSITY, IT IS THE COMMON CASE. QR alphanumeric mode
/// covers digits and CAPITALS only and is far denser than byte mode, so encoders
/// routinely upper-case a bech32 address to shrink the code. BIP173 allows
/// exactly that. A reader that only accepted lower case would fail on a large
/// share of real codes.
public enum PaymentUri {

    /// `amountSat` is nil when the code did not name an amount, or named one
    /// this app could not read.
    ///
    /// Nil means "not stated", never zero: the send screen leaves the field
    /// empty and the person types what they mean to pay. Inventing a number
    /// here would be inventing a payment.
    public struct Target: Equatable {
        public let address: String
        public let amountSat: Int64?

        public init(address: String, amountSat: Int64?) {
            self.address = address
            self.amountSat = amountSat
        }
    }

    /// Schemes seen in the wild for this chain. Compared case-insensitively.
    private static let schemes = ["pcoin:", "pcn:", "bitcoin:"]

    /// Below this, it is not an address, it is a stray string.
    private static let minAddress = 20

    public static func parse(_ raw: String?) -> Target? {
        var s = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty { return nil }

        // Strip a scheme if there is one. Everything after it, up to '?', is
        // the address.
        for scheme in schemes where s.lowercased().hasPrefix(scheme) {
            s = String(s.dropFirst(scheme.count))
            break
        }
        // Some encoders write pcoin://addr. An empty authority is not a host.
        while s.hasPrefix("/") { s = String(s.dropFirst()) }

        let query: String
        let beforeQuery: String
        if let q = s.firstIndex(of: "?") {
            beforeQuery = String(s[s.startIndex..<q])
            query = String(s[s.index(after: q)...])
        } else {
            beforeQuery = s
            query = ""
        }

        let address = normalise(beforeQuery.trimmingCharacters(in: .whitespaces))
        if address.count < minAddress { return nil }

        // An address is letters and digits, nothing else. Both formats this
        // chain uses are alphanumeric -- bech32 pc1... and base58 P... -- so
        // anything else means the text was not just an address.
        //
        // This used to reject only WHITESPACE, and that was too narrow. A link
        // ending "...nq4j\?amount=7.25" -- one stray escape -- parsed as an
        // address with a trailing backslash, and the payment-request screen
        // showed it as though it were real, all the way through to the send
        // form. Measured on hardware 2026-09-10. Windows already refused the
        // same input, so the two wallets disagreed about what an address is.
        //
        // Nothing could have been LOST -- a node rejects such an address -- but
        // that screen exists so a person can read the true destination, and it
        // must not display a doctored one as legitimate.
        if address.contains(where: { !($0.isLetter || $0.isNumber) }) { return nil }

        return Target(address: address, amountSat: amountFrom(query))
    }

    /// Fold a bech32 address to lower case; leave anything else exactly as it is.
    ///
    /// Base58 IS case-sensitive, so folding it would corrupt a legitimate
    /// address into a different one. Mixed case is left alone because it cannot
    /// be valid bech32 anyway, and the validator will say so.
    private static func normalise(_ a: String) -> String {
        guard a.count >= 3 else { return a }
        guard a.prefix(3).lowercased() == "pc1" else { return a }
        let hasUpper = a.contains(where: { $0.isUppercase })
        let hasLower = a.contains(where: { $0.isLowercase })
        return (hasUpper && hasLower) ? a : a.lowercased()
    }

    /// The amount, if the code states one readably.
    ///
    /// Anything unreadable yields nil rather than an error, and that is the
    /// deliberate direction: an unparsable amount must not stop the address
    /// from reaching the field, because the address is the part that is hard to
    /// type and easy to get wrong. The consequence of nil is an empty amount
    /// box, which the person fills in themselves and then reviews -- a visible
    /// gap, not a silent wrong number.
    private static func amountFrom(_ query: String) -> Int64? {
        if query.isEmpty { return nil }
        for part in query.split(separator: "&", omittingEmptySubsequences: false) {
            let piece = String(part)
            let key: String
            let value: String
            if let eq = piece.firstIndex(of: "=") {
                key = String(piece[piece.startIndex..<eq])
                value = String(piece[piece.index(after: eq)...])
            } else {
                key = piece
                value = ""
            }
            guard key.lowercased() == "amount" else { continue }
            return Amounts.parse(value).satOrNil
        }
        return nil
    }

    /// The URI this wallet hands out, e.g. for a QR code on the Receive screen.
    public static func build(address: String, amountSat: Int64? = nil) -> String {
        var out = "pcoin:" + address
        if let sat = amountSat, sat > 0 {
            out += "?amount=" + Amounts.toPlainString(sat)
        }
        return out
    }
}
