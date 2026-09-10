import Foundation
import Security

/// BIP39 mnemonic generation, validation and seed derivation.
///
/// A port of the Android wallet `Bip39.kt`, deliberately down to the rules it
/// enforces, because the two must agree about what a valid PCoin recovery phrase
/// IS. Three wallets disagreeing on that is worse than any one of the answers.
///
/// The BIP39 passphrase ("25th word") is fixed at "" -- see PCOIN.md 6.5. A
/// forgotten passphrase is indistinguishable from a wrong one and is
/// unrecoverable, and it buys nothing against this wallet threat model, which is
/// device loss.
public struct Bip39 {

    /// The 2048 words, in index order.
    public let wordList: [String]
    private let indexOf: [String: Int]

    public init(words: [String]) {
        precondition(words.count == Bip39.wordCount, "BIP39 wordlist must have 2048 words")
        self.wordList = words
        var m = [String: Int](minimumCapacity: 4096)
        for (i, w) in words.enumerated() { m[w] = i }
        self.indexOf = m
    }

    public enum Error: Swift.Error, Equatable {
        case wordlistCorrupted(expected: String, got: String)
        case unsupportedWordCount(Int)
        case unsupportedEntropyLength(Int)
        case entropyUnavailable(OSStatus)
    }

    /// The shipped English list, integrity-checked.
    ///
    /// Throws rather than returning a best effort: a wordlist that is not the
    /// canonical one derives different keys from the same words, silently. That
    /// is not a degraded mode, it is a wrong wallet.
    public static func english() throws -> Bip39 {
        let got = Hashes.sha256(Array(Wordlist.text.utf8)).hex
        guard got == Wordlist.sha256Hex else {
            throw Error.wordlistCorrupted(expected: Wordlist.sha256Hex, got: got)
        }
        return Bip39(words: Wordlist.words)
    }

    // MARK: - generation

    /// A fresh mnemonic.
    ///
    /// Entropy comes from `SecRandomCopyBytes`, the system CSPRNG, and a failure
    /// is thrown rather than swallowed. `arc4random_buf` would also be fine;
    /// what is NOT fine is any path that produces bytes when the system said it
    /// could not, which is why the status is checked.
    public func generate(wordCount: Int = 12) throws -> [String] {
        let bits = try Bip39.entropyBits(for: wordCount)
        var entropy = [UInt8](repeating: 0, count: bits / 8)
        let rc = SecRandomCopyBytes(kSecRandomDefault, entropy.count, &entropy)
        guard rc == errSecSuccess else { throw Error.entropyUnavailable(rc) }
        defer { Redact.wipe(&entropy) }
        return try fromEntropy(entropy)
    }

    /// Entropy -> mnemonic. Exposed for the published test vectors.
    public func fromEntropy(_ entropy: [UInt8]) throws -> [String] {
        let entropyBits = entropy.count * 8
        guard Bip39.validEntropyBits.contains(entropyBits) else {
            throw Error.unsupportedEntropyLength(entropyBits)
        }
        let checksumBits = entropyBits / 32
        var hash = Hashes.sha256(entropy)
        defer { Redact.wipe(&hash) }

        // Bit string of entropy || first (ENT/32) bits of SHA256(entropy),
        // consumed 11 bits at a time.
        let total = entropyBits + checksumBits
        var words = [String]()
        words.reserveCapacity(total / 11)
        for i in 0..<(total / 11) {
            var v = 0
            for b in 0..<11 {
                let bit = i * 11 + b
                let set: Int
                if bit < entropyBits {
                    set = Int((entropy[bit / 8] >> (7 - UInt8(bit % 8))) & 1)
                } else {
                    let cb = bit - entropyBits
                    set = Int((hash[cb / 8] >> (7 - UInt8(cb % 8))) & 1)
                }
                v = (v << 1) | set
            }
            words.append(wordList[v])
        }
        return words
    }

    // MARK: - validation

    public enum Validation: Equatable {
        case ok
        /// One or more words are not in the BIP39 list, by 0-based position.
        case unknownWords([Int])
        case badWordCount(Int)
        /// Every word is a real BIP39 word but the phrase own checksum fails.
        ///
        /// The checksum CANNOT identify which word is wrong: it is a hash over
        /// the whole phrase. Any UI that points at a specific word here is
        /// guessing, and a confident wrong hint sends someone off "correcting" a
        /// word that was fine.
        case checksumFailed
    }

    public func validate(_ words: [String]) -> Validation {
        guard Bip39.validWordCounts.contains(words.count) else {
            return .badWordCount(words.count)
        }
        let unknown = words.indices.filter { indexOf[words[$0]] == nil }
        if !unknown.isEmpty { return .unknownWords(unknown) }
        return checksumOk(words) ? .ok : .checksumFailed
    }

    public func isWord(_ word: String) -> Bool { indexOf[word] != nil }

    /// Words sharing a prefix, for autocomplete.
    ///
    /// BIP39 guarantees the first four letters of every English word are
    /// unique, so four characters always identify one -- but shorter prefixes
    /// are still offered as a list to choose from. Nothing here ever rewrites
    /// what was typed.
    public func suggestions(prefix: String, limit: Int = 5) -> [String] {
        if prefix.isEmpty { return [] }
        var out = [String]()
        for w in wordList where w.hasPrefix(prefix) {
            out.append(w)
            if out.count == limit { break }
        }
        return out
    }

    private func checksumOk(_ words: [String]) -> Bool {
        let totalBits = words.count * 11
        let entropyBits = totalBits * 32 / 33
        let checksumBits = totalBits - entropyBits
        var bits = [Bool](repeating: false, count: totalBits)
        for (i, w) in words.enumerated() {
            guard let idx = indexOf[w] else { return false }
            for b in 0..<11 { bits[i * 11 + b] = ((idx >> (10 - b)) & 1) == 1 }
        }
        var entropy = [UInt8](repeating: 0, count: entropyBits / 8)
        for i in 0..<entropyBits where bits[i] {
            entropy[i / 8] |= (1 << (7 - UInt8(i % 8)))
        }
        var hash = Hashes.sha256(entropy)
        var ok = true
        for i in 0..<checksumBits {
            let expected = ((hash[i / 8] >> (7 - UInt8(i % 8))) & 1) == 1
            if bits[entropyBits + i] != expected { ok = false }
        }
        Redact.wipe(&entropy)
        Redact.wipe(&hash)
        return ok
    }

    // MARK: - seed

    /// Mnemonic -> 64-byte seed, per BIP39:
    /// PBKDF2-HMAC-SHA512(NFKD(mnemonic), "mnemonic" + NFKD(passphrase), 2048, 64).
    public func toSeed(mnemonic: [String], passphrase: String = "") -> [UInt8] {
        toSeed(mnemonic: mnemonic.joined(separator: " "), passphrase: passphrase)
    }

    public func toSeed(mnemonic: String, passphrase: String = "") -> [UInt8] {
        var password = Array(Bip39.normalize(mnemonic).utf8)
        // The passphrase gets NFKD and NOTHING else. It is case-sensitive and
        // whitespace-significant by definition, so the lowercasing and
        // whitespace collapsing that `normalize` applies to the mnemonic would
        // silently derive the wrong wallet. Caught by the reference vectors,
        // which are published with the passphrase "TREZOR".
        var salt = Array(("mnemonic" + Bip39.normalizePassphrase(passphrase)).utf8)
        let seed = Hashes.pbkdf2HmacSha512(
            password: password, salt: salt,
            iterations: Bip39.pbkdf2Iterations, dkLen: Bip39.seedLength
        )
        Redact.wipe(&password)
        Redact.wipe(&salt)
        return seed
    }

    // MARK: - constants

    public static let wordCount = 2048
    public static let pbkdf2Iterations = 2048
    public static let seedLength = 64

    /// What counts as a PCoin recovery phrase: 12 words, or 24.
    ///
    /// BIP39 also defines 15, 18 and 21. The Android app accepted all five once
    /// while the Windows client accepted only 12 and 24 and PCOIN.md documented
    /// only 12 and 24; the published spec is the one that has to win, because it
    /// is the contract a future wallet restores against. Nothing is lost by it:
    /// no PCoin wallet in existence has a phrase of any other length.
    public static let validWordCounts: Set<Int> = [12, 24]
    private static let validEntropyBits: Set<Int> = [128, 256]

    public static func entropyBits(for wordCount: Int) throws -> Int {
        guard validWordCounts.contains(wordCount) else {
            throw Error.unsupportedWordCount(wordCount)
        }
        return wordCount * 11 * 32 / 33
    }

    /// NFKD, lowercase, trimmed, internal whitespace runs collapsed.
    ///
    /// NFKD is mandated by BIP39 and matters even for English: a soft keyboard
    /// or a paste from a notes app can introduce a non-breaking space or a
    /// composed character, and an un-normalised phrase produces a completely
    /// different seed with no error message.
    public static func normalize(_ text: String) -> String {
        let nfkd = text.decomposedStringWithCompatibilityMapping.lowercased()
        let parts = nfkd.split(whereSeparator: { $0.isWhitespace || $0.isNewline })
        return parts.joined(separator: " ")
    }

    /// NFKD only. See the note in `toSeed`.
    public static func normalizePassphrase(_ text: String) -> String {
        text.decomposedStringWithCompatibilityMapping
    }

    public static func splitWords(_ text: String) -> [String] {
        normalize(text).split(separator: " ").map(String.init)
    }
}
