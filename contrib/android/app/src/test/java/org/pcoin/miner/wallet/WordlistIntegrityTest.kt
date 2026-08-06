package org.pcoin.miner.wallet

import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File
import java.security.MessageDigest

/**
 * The shipped BIP39 wordlist is byte-for-byte what the app expects.
 *
 * This exists because of a real failure, and the failure mode is worth stating
 * plainly. `WordList.load` verifies the asset against [Bip39.WORDLIST_SHA256]
 * at runtime and throws `CorruptWordlist` if it differs -- deliberately loud,
 * because a substituted wordlist silently changes every derived key. But that
 * check only fires on a device. Nothing in the build noticed that a plain
 * `git checkout` on Windows rewrote all 2048 line endings to CRLF, taking the
 * file from 13116 to 15164 bytes and changing its digest. The result was an APK
 * that builds, installs, and then cannot create or restore a wallet at all --
 * from a clean clone, with no local edit to blame.
 *
 * `.gitattributes` now marks the file `-text` so it is never converted. This
 * test is the tripwire that says so if that protection is ever lost, on the
 * machine doing the build rather than on a phone in somebody's hand.
 */
class WordlistIntegrityTest {

    private val wordlist = File("src/main/assets/bip39/english.txt")

    @Test
    fun `the shipped wordlist matches the digest the app enforces`() {
        val bytes = wordlist.readBytes()
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
            .joinToString("") { "%02x".format(it) }
        assertEquals(
            "wordlist digest (size ${bytes.size}); if this fails after a fresh " +
                "clone, check .gitattributes still marks it -text",
            Bip39.WORDLIST_SHA256,
            digest,
        )
    }

    @Test
    fun `the wordlist is LF-terminated and the documented size`() {
        val bytes = wordlist.readBytes()
        assertEquals("byte count", 13116, bytes.size)
        assertEquals("no CR bytes anywhere", 0, bytes.count { it == '\r'.code.toByte() })
    }

    @Test
    fun `it holds exactly 2048 unique words`() {
        // 2048 = 11 bits per word, which is what makes the checksum arithmetic
        // work at all. A short or duplicated list would derive silently wrong.
        val words = wordlist.readText().split("\n").map { it.trim() }.filter { it.isNotEmpty() }
        assertEquals("word count", 2048, words.size)
        assertEquals("all distinct", 2048, words.toSet().size)
        assertEquals("sorted", words.sorted(), words)
    }
}
