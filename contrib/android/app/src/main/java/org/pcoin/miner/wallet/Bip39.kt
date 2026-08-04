package org.pcoin.miner.wallet

import java.security.SecureRandom
import java.text.Normalizer

/**
 * BIP39 mnemonic generation, validation and seed derivation.
 *
 * English only, always. A phrase generated against a localised wordlist cannot
 * be restored by any wallet that does not guess the same language, and picking
 * the list from the device locale is a well-known way to lose coins
 * permanently. There is deliberately no language parameter anywhere here.
 *
 * The BIP39 passphrase ("25th word") is fixed at "" — see PCOIN wallet spec
 * §6.5. A forgotten passphrase is indistinguishable from a wrong one and is
 * unrecoverable, and it buys nothing for a mining wallet whose threat model is
 * device loss. The stored phrase record carries a scheme version so a future
 * version can tell which rules a given wallet was created under.
 */
class Bip39(words: List<String>) {

    /** The 2048 words, in index order. */
    val wordList: List<String> = words

    private val indexOf: Map<String, Int> =
        HashMap<String, Int>(4096).apply { words.forEachIndexed { i, w -> put(w, i) } }

    init {
        require(words.size == WORD_COUNT) { "BIP39 wordlist must have $WORD_COUNT words" }
    }

    // ------------------------------------------------------------- generation

    /**
     * A fresh mnemonic.
     *
     * Entropy comes from `SecureRandom()` with no seeding and no algorithm
     * name. Both matter: `SecureRandom.setSeed` on Android replaces rather than
     * mixes on some implementations, and `getInstance("SHA1PRNG")` selects the
     * historically broken Crypto provider. The no-argument constructor is the
     * platform CSPRNG and is the only correct choice.
     */
    fun generate(wordCount: Int = 12): CharArray {
        val entropyBits = entropyBitsFor(wordCount)
        val entropy = ByteArray(entropyBits / 8)
        SecureRandom().nextBytes(entropy)
        val mnemonic = fromEntropy(entropy)
        entropy.fill(0)
        return mnemonic
    }

    /** Entropy -> mnemonic. Exposed for the published test vectors. */
    fun fromEntropy(entropy: ByteArray): CharArray {
        val entropyBits = entropy.size * 8
        require(entropyBits in VALID_ENTROPY_BITS) { "unsupported entropy length" }
        val checksumBits = entropyBits / 32
        val hash = Hashes.sha256(entropy)

        // Bit string of entropy || first (ENT/32) bits of SHA256(entropy),
        // consumed 11 bits at a time.
        val total = entropyBits + checksumBits
        val indices = IntArray(total / 11)
        for (i in indices.indices) {
            var v = 0
            for (b in 0 until 11) {
                val bit = i * 11 + b
                val set = if (bit < entropyBits) {
                    (entropy[bit / 8].toInt() shr (7 - bit % 8)) and 1
                } else {
                    val cb = bit - entropyBits
                    (hash[cb / 8].toInt() shr (7 - cb % 8)) and 1
                }
                v = (v shl 1) or set
            }
            indices[i] = v
        }
        hash.fill(0)

        val sb = StringBuilder()
        for ((i, idx) in indices.withIndex()) {
            if (i > 0) sb.append(' ')
            sb.append(wordList[idx])
        }
        val out = CharArray(sb.length)
        sb.getChars(0, sb.length, out, 0)
        // StringBuilder's backing array is not reachable for wiping, so blank it
        // in place before it is dropped. Best effort, but free.
        for (i in 0 until sb.length) sb.setCharAt(i, ' ')
        return out
    }

    // ------------------------------------------------------------- validation

    sealed class Validation {
        object Ok : Validation()

        /** One or more words are not in the BIP39 list, by 0-based position. */
        data class UnknownWords(val positions: List<Int>) : Validation()

        data class BadWordCount(val count: Int) : Validation()

        /**
         * Every word is a real BIP39 word but the phrase's own checksum fails.
         *
         * The checksum CANNOT identify which word is wrong: it is a hash over
         * the whole phrase. Any UI that points at a specific word here is
         * guessing, and a confident wrong hint sends the user off "correcting" a
         * word that was fine.
         */
        object ChecksumFailed : Validation()
    }

    fun validate(words: List<String>): Validation {
        if (words.size !in VALID_WORD_COUNTS) return Validation.BadWordCount(words.size)
        val unknown = words.indices.filter { indexOf[words[it]] == null }
        if (unknown.isNotEmpty()) return Validation.UnknownWords(unknown)
        return if (checksumOk(words)) Validation.Ok else Validation.ChecksumFailed
    }

    fun isWord(word: String): Boolean = indexOf.containsKey(word)

    /**
     * Words sharing a prefix, for autocomplete. BIP39 guarantees the first four
     * letters of every English word are unique, so four characters is always
     * enough to identify one — but shorter prefixes are still offered as a list
     * the user must choose from. Nothing here ever rewrites what was typed.
     */
    fun suggestions(prefix: String, limit: Int = 5): List<String> {
        if (prefix.isEmpty()) return emptyList()
        return wordList.asSequence().filter { it.startsWith(prefix) }.take(limit).toList()
    }

    private fun checksumOk(words: List<String>): Boolean {
        val totalBits = words.size * 11
        val entropyBits = totalBits * 32 / 33
        val checksumBits = totalBits - entropyBits
        val bits = BooleanArray(totalBits)
        for ((i, w) in words.withIndex()) {
            val idx = indexOf[w] ?: return false
            for (b in 0 until 11) bits[i * 11 + b] = ((idx shr (10 - b)) and 1) == 1
        }
        val entropy = ByteArray(entropyBits / 8)
        for (i in 0 until entropyBits) {
            if (bits[i]) entropy[i / 8] = (entropy[i / 8].toInt() or (1 shl (7 - i % 8))).toByte()
        }
        val hash = Hashes.sha256(entropy)
        var ok = true
        for (i in 0 until checksumBits) {
            val expected = ((hash[i / 8].toInt() shr (7 - i % 8)) and 1) == 1
            if (bits[entropyBits + i] != expected) ok = false
        }
        entropy.fill(0)
        hash.fill(0)
        return ok
    }

    // ------------------------------------------------------------------ seed

    /**
     * Mnemonic -> 64-byte seed, per BIP39:
     * PBKDF2-HMAC-SHA512(NFKD(mnemonic), "mnemonic" + NFKD(passphrase), 2048, 64).
     */
    fun toSeed(mnemonic: CharArray, passphrase: String = ""): ByteArray {
        val normalized = normalize(String(mnemonic))
        val password = normalized.toByteArray(Charsets.UTF_8)
        // The passphrase gets NFKD and NOTHING else. It is case-sensitive and
        // whitespace-significant by definition, so the lowercasing and
        // whitespace collapsing that [normalize] applies to the mnemonic would
        // silently derive the wrong wallet. Caught by the reference vectors,
        // which are published with the passphrase "TREZOR".
        val salt = ("mnemonic" + normalizePassphrase(passphrase)).toByteArray(Charsets.UTF_8)
        val seed = Hashes.pbkdf2HmacSha512(password, salt, PBKDF2_ITERATIONS, SEED_LENGTH)
        password.fill(0)
        salt.fill(0)
        return seed
    }

    companion object {
        const val WORD_COUNT = 2048
        const val PBKDF2_ITERATIONS = 2048
        const val SEED_LENGTH = 64

        /**
         * SHA-256 of the shipped english.txt, LF-terminated, 13116 bytes.
         *
         * This is the canonical BIP39 English list's published digest, and the
         * shipped copy was additionally diffed word-for-word against an
         * unrelated third-party implementation. Verified at load time: a
         * corrupted or substituted wordlist silently changes every derived key,
         * which would be undetectable until the money was already gone.
         */
        const val WORDLIST_SHA256 =
            "2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda"

        /**
         * What counts as a PCoin recovery phrase: 12 words, or 24.
         *
         * BIP39 itself also defines 15, 18 and 21, and this used to accept all
         * five -- while the Windows client accepted only 12 and 24 and PCOIN.md
         * documented only 12 and 24. Three places disagreeing about what a valid
         * phrase IS is worse than any one of the three answers, and the
         * published spec is the one that has to win: it is the contract a future
         * wallet restores against.
         *
         * Nothing is lost by it. Neither client has ever generated 15, 18 or 21
         * words, so no PCoin wallet in existence has a phrase of that length.
         */
        val VALID_WORD_COUNTS = setOf(12, 24)
        private val VALID_ENTROPY_BITS = setOf(128, 256)

        fun entropyBitsFor(wordCount: Int): Int {
            require(wordCount in VALID_WORD_COUNTS) { "unsupported word count $wordCount" }
            return wordCount * 11 * 32 / 33
        }

        /**
         * NFKD, lowercase, trimmed, internal whitespace runs collapsed.
         *
         * NFKD is mandated by BIP39 and matters even for English: a soft
         * keyboard or a paste from a note-taking app can easily introduce a
         * non-breaking space or a composed character, and an un-normalised
         * phrase produces a completely different seed with no error message.
         */
        fun normalize(text: String): String =
            Normalizer.normalize(text, Normalizer.Form.NFKD)
                .lowercase()
                .trim()
                .replace(WHITESPACE, " ")

        /** NFKD only. See the note in [toSeed]. */
        fun normalizePassphrase(text: String): String =
            Normalizer.normalize(text, Normalizer.Form.NFKD)

        fun splitWords(text: String): List<String> =
            normalize(text).split(' ').filter { it.isNotEmpty() }

        private val WHITESPACE = Regex("\\s+")
    }
}
