import Foundation

/// Display formatting.
///
/// Deliberately dumb, exactly as the Android `Fmt.kt` is: it prints what was
/// read and nothing else. No earnings projections, no fiat conversions, no
/// extrapolated "coins per day" anywhere in this app, because none of those
/// numbers would be real.
///
/// Note what is missing. There is no hashrate, no temperature, no thread count
/// and no performance line: this is the wallet, and there is no miner on iOS.
/// Apple prohibits on-device mining and one must never be added.
public enum Fmt {

    /// Coin amounts held in satoshi.
    ///
    /// Everything works in integers -- a transaction is built, verified and
    /// recorded in satoshi and only the display converts -- because a fee
    /// assertion done in floating point is an assertion that can be off by a
    /// rounding error.
    ///
    /// A negative value means "not known yet" and prints an em dash. It is never
    /// printed as 0.00000000: a balance nobody has managed to read is not a
    /// balance of nothing.
    public static func coinsSat(_ sat: Int64) -> String {
        sat < 0 ? unknown : Amounts.toPlainString(sat) + " PCN"
    }

    /// The em dash the whole app uses for "not known".
    public static let unknown = "\u{2014}"

    public static func count(_ v: Int) -> String { v < 0 ? unknown : String(v) }

    /// A rough wall-clock duration, for "updated 5 min ago" style lines.
    ///
    /// Deliberately coarse. It is used for how long ago something was READ,
    /// never for how long something will take: this chain block spacing is
    /// noisy and routinely far from its 600 s target in both directions, so an
    /// ETA rendered from a hardcoded spacing is a guess wearing a number
    /// clothes.
    public static func roughDuration(seconds: TimeInterval) -> String {
        let ms = seconds * 1000
        switch ms {
        case ..<0: return unknown
        case ..<(90 * 60_000): return "\(max(1, Int(ms / 60_000))) min"
        case ..<(48 * 3_600_000): return "\(Int((ms / 3_600_000).rounded())) h"
        default: return "\(Int((ms / 86_400_000).rounded())) days"
        }
    }

    /// "Block 7342 - 51 peers", or the not-connected line.
    ///
    /// Both come from the explorer index block. On Android this describes the
    /// node inside the app; here it describes the node the explorer is reading,
    /// which is a different claim and the wording on screen says so.
    public static func chainLine(height: Int?, behind: Int?) -> String? {
        guard let h = height else { return nil }
        if let b = behind, b > 0 { return "Block \(h) - index \(b) behind" }
        return "Block \(h)"
    }

    /// Confirmations, as the history screen states them.
    ///
    /// nil in means nil out. A transaction whose confirmation count could not be
    /// read is not a transaction with zero confirmations -- that conversion is
    /// the one that authorises spending the same coins twice.
    public static func confirmations(_ n: Int?) -> String {
        guard let n = n else { return unknown }
        if n <= 0 { return "Waiting to be included in a block" }
        return n == 1 ? "1 confirmation" : "\(n) confirmations"
    }

    /// A shortened address for a tight row: first 12 and last 8, joined by an
    /// ellipsis. Never used where the destination is being CONFIRMED -- the
    /// review screen shows the whole thing, because a lookalike address is the
    /// attack and the eye is the only defence against it.
    public static func shortAddress(_ a: String) -> String {
        guard a.count > 24 else { return a }
        return a.prefix(12) + "\u{2026}" + a.suffix(8)
    }
}
