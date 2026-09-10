import Foundation
import PCoinKit

/// Everything the app remembers between launches.
///
/// SPLIT INTO TWO KINDS, and the split is the point. The Android `Prefs.kt`
/// makes the same one after an incident where a transient read overwrote
/// authoritative state three separate times:
///
///  * **Authoritative intent** is what a person chose, or what a confirmed
///    terminal outcome established. It is written only by a user action or by a
///    fact the chain has settled, and never by an observation that might have
///    failed.
///  * **Derived display** is anything that can be recomputed from a fresh read.
///    It may be written freely, and losing it costs nothing.
///
/// The rule that follows: a read that failed, timed out, or answered "I do not
/// know" resolves NOTHING. It can never advance a record and never clear one.
final class Prefs {

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    // MARK: - authoritative intent

    private enum Key {
        static let feeRate = "pref.feeRate.v1"
        static let walletCreatedAt = "intent.walletCreatedAt.v1"
        static let phraseWrittenDown = "intent.phraseWrittenDown.v1"
        static let receiveAddress = "intent.receiveAddress.v1"
        static let masterFingerprint = "intent.masterFingerprint.v1"
        static let lastGoodReadAt = "display.lastGoodReadAt.v1"
        static let lastKnownHeight = "display.lastKnownHeight.v1"
    }

    /// Which speed the send screen starts on. A preference, so a user action.
    var defaultFeeRate: FeeRate {
        get { FeeRate(rawValue: defaults.integer(forKey: Key.feeRate)) ?? .normal }
        set { defaults.set(newValue.rawValue, forKey: Key.feeRate) }
    }

    /// When the wallet was set up. Set once, by the setup flow.
    var walletCreatedAt: Date? {
        get {
            let t = defaults.double(forKey: Key.walletCreatedAt)
            return t > 0 ? Date(timeIntervalSince1970: t) : nil
        }
        set { defaults.set(newValue?.timeIntervalSince1970 ?? 0, forKey: Key.walletCreatedAt) }
    }

    /// Has the person confirmed they wrote the twelve words down?
    ///
    /// Their claim, not a fact anybody can check -- so it only ever moves when
    /// they say so, and the home screen keeps offering the backup card until
    /// they do.
    var phraseWrittenDown: Bool {
        get { defaults.bool(forKey: Key.phraseWrittenDown) }
        set { defaults.set(newValue, forKey: Key.phraseWrittenDown) }
    }

    /// The receive address, cached so the home screen can draw before any
    /// network call.
    ///
    /// AUTHORITATIVE, and guarded one-way: a blank never clears one already
    /// held. This is the exact shape of the Android bug where a wallet-scoped
    /// `getaddressinfo` answered confidently about the wrong wallet and the code
    /// that believed it discarded the payout address -- after which block
    /// rewards went to a key nobody had.
    var receiveAddress: String? {
        get { defaults.string(forKey: Key.receiveAddress) }
        set {
            guard let v = newValue, !v.isEmpty else { return }
            defaults.set(v, forKey: Key.receiveAddress)
        }
    }

    /// The master fingerprint of the wallet these settings belong to.
    ///
    /// Exists so a restored-different-wallet can be detected instead of
    /// inheriting the previous one cached address. Same one-way guard.
    var masterFingerprint: String? {
        get { defaults.string(forKey: Key.masterFingerprint) }
        set {
            guard let v = newValue, !v.isEmpty else { return }
            defaults.set(v, forKey: Key.masterFingerprint)
        }
    }

    // MARK: - derived display

    /// When a balance was last actually READ, not when the screen last drew.
    var lastGoodReadAt: Date? {
        get {
            let t = defaults.double(forKey: Key.lastGoodReadAt)
            return t > 0 ? Date(timeIntervalSince1970: t) : nil
        }
        set { defaults.set(newValue?.timeIntervalSince1970 ?? 0, forKey: Key.lastGoodReadAt) }
    }

    var lastKnownHeight: Int? {
        get {
            let h = defaults.integer(forKey: Key.lastKnownHeight)
            return h > 0 ? h : nil
        }
        set {
            guard let v = newValue, v > 0 else { return }
            defaults.set(v, forKey: Key.lastKnownHeight)
        }
    }

    /// Forget everything about a wallet that is no longer on this phone.
    ///
    /// Called only from the deliberate "remove this wallet" path, never from an
    /// error handler.
    func clearWalletIdentity() {
        defaults.removeObject(forKey: Key.receiveAddress)
        defaults.removeObject(forKey: Key.masterFingerprint)
        defaults.removeObject(forKey: Key.walletCreatedAt)
        defaults.removeObject(forKey: Key.phraseWrittenDown)
        defaults.removeObject(forKey: Key.lastGoodReadAt)
        defaults.removeObject(forKey: Key.lastKnownHeight)
    }
}
