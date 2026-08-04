package org.pcoin.miner

import android.content.Context
import org.pcoin.miner.wallet.Bip39
import org.pcoin.miner.wallet.Hashes
import org.pcoin.miner.wallet.toHex

/**
 * Loads the BIP39 English wordlist out of the APK's assets, once.
 *
 * The digest check is not ceremony. A corrupted or substituted wordlist changes
 * every key the phrase derives, silently and undetectably: the phrase would
 * still validate, the wallet would still be created, and the words written on
 * paper would restore a completely different wallet on any other implementation.
 * Failing loudly at load time is the only way that ever gets noticed.
 *
 * English, always -- never the device locale. A phrase generated against a
 * localised wordlist cannot be restored by a wallet that does not guess the
 * same language, and that is a classic cause of permanent loss.
 */
object WordList {

    private const val ASSET = "bip39/english.txt"

    @Volatile
    private var cached: Bip39? = null

    class CorruptWordlist(message: String) : IllegalStateException(message)

    fun load(context: Context): Bip39 {
        cached?.let { return it }
        synchronized(this) {
            cached?.let { return it }
            val bytes = context.applicationContext.assets.open(ASSET).use { it.readBytes() }
            val digest = Hashes.sha256(bytes).toHex()
            if (digest != Bip39.WORDLIST_SHA256) {
                throw CorruptWordlist(
                    "the bundled BIP39 wordlist does not match its expected digest"
                )
            }
            val words = String(bytes, Charsets.UTF_8)
                .split('\n')
                .map { it.trim() }
                .filter { it.isNotEmpty() }
            val b = Bip39(words)
            cached = b
            return b
        }
    }
}
