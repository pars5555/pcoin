import Foundation

/// Keeping secrets out of places they must never reach.
///
/// The Android wallet has a `Redact.kt` whose whole job is making "the phrase is
/// never logged, never put in a notification, never written anywhere else" true
/// rather than merely intended. This is its counterpart, and it exists for the
/// same reason: the rule is easy to state and easy to break by accident, so it
/// needs something a test can hold on to.
///
/// The rule for this codebase: a recovery phrase, a seed, a private key or an
/// xprv is NEVER interpolated into a string. If you need to refer to one in a
/// message, use `Redact.describe`.
public enum Redact {

    /// What a secret is allowed to look like in any human-readable output.
    public static let placeholder = "(redacted)"

    /// A safe stand-in for a secret. Says the shape, never the value.
    ///
    /// Deliberately does NOT include a prefix, a suffix, a length or a
    /// checksum. Every one of those has been proposed somewhere as "harmless
    /// for debugging", and every one of them narrows a brute-force search.
    public static func describe(_ kind: SecretKind) -> String {
        switch kind {
        case .recoveryPhrase: return "\(placeholder) recovery phrase"
        case .seed: return "\(placeholder) seed"
        case .privateKey: return "\(placeholder) private key"
        case .extendedPrivateKey: return "\(placeholder) xprv"
        }
    }

    public enum SecretKind {
        case recoveryPhrase
        case seed
        case privateKey
        case extendedPrivateKey
    }

    /// Overwrite secret bytes in place.
    ///
    /// Best effort, and honest about it: Swift arrays can be copied by the
    /// runtime (a `reserveCapacity` growth reallocates, an escaping closure
    /// captures), so this cannot promise every copy is gone. It costs nothing
    /// and removes the copy we hold, which is the one that lives longest.
    public static func wipe(_ bytes: inout [UInt8]) {
        for i in bytes.indices { bytes[i] = 0 }
    }

    public static func wipe(_ chars: inout [Character]) {
        for i in chars.indices { chars[i] = " " }
    }

    /// True if `text` contains anything that must never be logged.
    ///
    /// Used by the tests, not by the logger: a logger that filters its own
    /// input is a logger somebody will eventually route around. The check
    /// belongs where it fails the build.
    public static func looksSecret(_ text: String, mnemonicWords: [String]) -> Bool {
        if text.contains("xprv") { return true }
        // Four consecutive BIP39 words is a phrase, not a coincidence.
        let words = text.lowercased().split(whereSeparator: { !$0.isLetter }).map(String.init)
        guard words.count >= 4 else { return false }
        let set = Set(mnemonicWords)
        var run = 0
        for w in words {
            run = set.contains(w) ? run + 1 : 0
            if run >= 4 { return true }
        }
        return false
    }
}
