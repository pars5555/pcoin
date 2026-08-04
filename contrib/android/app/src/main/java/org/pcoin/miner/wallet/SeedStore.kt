package org.pcoin.miner.wallet

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The recovery phrase at rest.
 *
 * The Backup screen requirement means the phrase must be retrievable, so "do
 * not store it" is not available. It is stored as AES-256-GCM ciphertext in a
 * file in app-private storage, under a key that lives in the AndroidKeyStore
 * and never leaves it.
 *
 * The authentication gate is the KEY, not the UI. Because the key is created
 * with setUserAuthenticationRequired(true), the Cipher physically cannot
 * produce plaintext without a fresh device unlock -- a rooted device cannot
 * skip past a boolean callback, because there is no boolean. [SeedGate] drives
 * the prompt; this class only ever hands out a Cipher that is already bound to
 * it.
 *
 * The plaintext phrase is NEVER logged, never put in a notification, and never
 * written anywhere but this one encrypted blob. The paper the user wrote it on
 * is the real backup; this file is a convenience, and the code says so out loud
 * because that is what makes [readable] safe to report honestly.
 */
class SeedStore(context: Context) {

    private val appContext = context.applicationContext

    private val dir: File get() = File(appContext.filesDir, "wallet").apply { mkdirs() }
    private val blobFile: File get() = File(dir, BLOB_NAME)

    /**
     * Everything about the phrase that is NOT secret.
     *
     * [deviceLockProtected] is persisted rather than re-derived: it records
     * which Keystore alias the ciphertext was actually written under. Deciding
     * that at read time from "does this device have a lock screen right now"
     * would be an observation overwriting a fact, and the fact is the only
     * thing that can decrypt the file.
     *
     * [birthTimeSec] exists from day one even though v1 always writes the
     * genesis time. Once PCoin's chain is long enough for a full rescan to
     * matter, a restore wants the phrase's own birth time as its lower bound --
     * and that field cannot be retrofitted onto phrases already in the wild.
     */
    data class Meta(
        val version: Int,
        val wordCount: Int,
        val network: String,
        /** Derivation scheme id; bumped if the path or passphrase rule changes. */
        val derivation: String,
        val birthTimeSec: Long,
        val deviceLockProtected: Boolean,
        val restored: Boolean,
    )

    fun exists(): Boolean = blobFile.isFile

    fun meta(): Meta? {
        if (!blobFile.isFile) return null
        return try {
            val o = JSONObject(blobFile.readText())
            Meta(
                version = o.optInt("version", 1),
                wordCount = o.optInt("wordCount", 12),
                network = o.optString("network", "mainnet"),
                derivation = o.optString("derivation", DERIVATION_ID),
                birthTimeSec = o.optLong("birthTimeSec", 0L),
                deviceLockProtected = o.optBoolean("deviceLockProtected", true),
                restored = o.optBoolean("restored", false),
            )
        } catch (t: Throwable) {
            Log.w(TAG, "phrase metadata unreadable: ${t.javaClass.simpleName}")
            null
        }
    }

    // ------------------------------------------------------------------ write

    /**
     * A Cipher ready to encrypt, plus the alias it belongs to.
     *
     * Returned rather than used immediately because on an auth-required key the
     * caller has to walk it through [SeedGate] first.
     */
    class PendingWrite internal constructor(
        val cipher: Cipher,
        internal val deviceLockProtected: Boolean,
    )

    /**
     * Prepares to store a phrase.
     *
     * @param requireDeviceLock ask for a key gated on the device lock. Falls
     *   back to an ungated key when the device has no secure lock screen at all,
     *   because generating an auth-required key on such a device throws and an
     *   uncaught throw here would brick setup on a phone with no PIN. The
     *   fallback is recorded in [Meta.deviceLockProtected] and the UI states it
     *   plainly rather than pretending the phrase is protected.
     */
    fun beginWrite(requireDeviceLock: Boolean = true): PendingWrite {
        val gated = requireDeviceLock && SeedGate.deviceLockAvailable(appContext)
        val alias = if (gated) ALIAS_GATED else ALIAS_UNGATED
        val key = getOrCreateKey(alias, gated)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key)
        return PendingWrite(cipher, gated)
    }

    /** Thrown rather than replacing a phrase that is already stored. */
    class AlreadyStored(message: String) : Exception(message)

    /**
     * Deletes the stored phrase.
     *
     * Only ever called from a path where the user has explicitly said "discard
     * the phrase on this device and start over", and only when that phrase has
     * no wallet behind it. Never called to make room for a write.
     */
    fun discard(): Boolean {
        File(dir, "$BLOB_NAME.tmp").delete()
        return !blobFile.exists() || blobFile.delete()
    }

    /**
     * Encrypts and writes the phrase. The caller keeps ownership of [mnemonic]
     * and is responsible for wiping it.
     *
     * Written to a temp file and renamed, so an interrupted write can never
     * leave a truncated blob where a good one used to be.
     *
     * @param allowReplace the caller has PROVED replacing is safe -- meaning the
     *   node already demonstrated it owns this phrase's address, so the write is
     *   a repeat of the same setup rather than a different phrase landing on top
     *   of an old one. Defaults to false: replacing a phrase destroys access to
     *   whatever it was holding, so it must never happen as a side effect. This
     *   is reachable inside a single setup session -- after a failure the Back
     *   button returns to the first step, and tapping Create again generates a
     *   second phrase -- which is exactly the case this guard exists for.
     * @throws AlreadyStored when a phrase is present and [allowReplace] is false.
     */
    fun finishWrite(
        pending: PendingWrite,
        mnemonic: CharArray,
        wordCount: Int,
        network: PcoinDerivation.Network,
        birthTimeSec: Long,
        restored: Boolean,
        allowReplace: Boolean = false,
    ) {
        if (blobFile.isFile && !allowReplace) {
            throw AlreadyStored(
                "a recovery phrase is already stored on this device; refusing to overwrite it"
            )
        }
        val plaintext = String(mnemonic).toByteArray(Charsets.UTF_8)
        val ciphertext = try {
            pending.cipher.doFinal(plaintext)
        } finally {
            plaintext.fill(0)
        }
        val json = JSONObject()
            .put("version", VERSION)
            .put("wordCount", wordCount)
            .put("network", network.name.lowercase())
            .put("derivation", DERIVATION_ID)
            .put("birthTimeSec", birthTimeSec)
            .put("deviceLockProtected", pending.deviceLockProtected)
            .put("restored", restored)
            .put("iv", Base64.encodeToString(pending.cipher.iv, Base64.NO_WRAP))
            .put("ct", Base64.encodeToString(ciphertext, Base64.NO_WRAP))
            .toString()

        val tmp = File(dir, "$BLOB_NAME.tmp")
        tmp.writeText(json)
        if (!tmp.renameTo(blobFile)) {
            blobFile.writeText(json)
            tmp.delete()
        }
    }

    // ------------------------------------------------------------------- read

    class PendingRead internal constructor(
        val cipher: Cipher,
        val meta: Meta,
        internal val ciphertext: ByteArray,
    )

    /** Thrown when the blob exists but its Keystore key is gone for good. */
    class KeyLost(message: String) : Exception(message)

    /**
     * Prepares to decrypt. The returned Cipher must be authenticated through
     * [SeedGate] before [finishRead] will produce anything.
     */
    fun beginRead(): PendingRead {
        val meta = meta() ?: throw KeyLost("no recovery phrase is stored on this device")
        val o = JSONObject(blobFile.readText())
        val iv = Base64.decode(o.getString("iv"), Base64.NO_WRAP)
        val ct = Base64.decode(o.getString("ct"), Base64.NO_WRAP)

        val alias = if (meta.deviceLockProtected) ALIAS_GATED else ALIAS_UNGATED
        val key = loadKey(alias)
            ?: throw KeyLost(
                "the key protecting the stored phrase is no longer on this device"
            )
        val cipher = Cipher.getInstance(TRANSFORMATION)
        try {
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(GCM_TAG_BITS, iv))
        } catch (e: android.security.keystore.KeyPermanentlyInvalidatedException) {
            // Should not happen: setInvalidatedByBiometricEnrollment(false) is
            // set precisely so enrolling a fingerprint does not destroy the key.
            // Reported honestly rather than swallowed -- the money is still
            // safe (the node holds the keys, and the user has the paper), it is
            // only the "show me the phrase again" convenience that is gone.
            throw KeyLost("the stored phrase can no longer be decrypted on this device")
        }
        return PendingRead(cipher, meta, ct)
    }

    /**
     * @return the phrase as a CharArray the caller must wipe. Held as chars
     *   rather than a String so it can be blanked; an immutable String would sit
     *   in the heap until GC and show up in heap dumps and ANR traces.
     */
    fun finishRead(pending: PendingRead): CharArray {
        val plain = pending.cipher.doFinal(pending.ciphertext)
        val text = String(plain, Charsets.UTF_8)
        plain.fill(0)
        val out = CharArray(text.length)
        text.toCharArray(out, 0, 0, text.length)
        return out
    }

    // -------------------------------------------------------------- keystore

    private fun keyStore(): KeyStore =
        KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    private fun loadKey(alias: String): SecretKey? = try {
        keyStore().getKey(alias, null) as? SecretKey
    } catch (t: Throwable) {
        Log.w(TAG, "keystore load failed: ${t.javaClass.simpleName}")
        null
    }

    private fun getOrCreateKey(alias: String, gated: Boolean): SecretKey {
        loadKey(alias)?.let { return it }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
            return generateKey(alias, gated, strongBox = false)
        }
        return try {
            generateKey(alias, gated, strongBox = true)
        } catch (t: Throwable) {
            // StrongBox is absent on plenty of devices, and OEM builds are not
            // consistent about which exception they raise -- some throw the
            // documented StrongBoxUnavailableException, others a plain
            // ProviderException. Falling back is not optional: an uncaught
            // throw here would abort setup with no way forward. Anything that
            // is clearly NOT a StrongBox problem is re-thrown so a real
            // Keystore failure is not silently downgraded.
            if (!isStrongBoxFailure(t)) throw t
            Log.i(TAG, "StrongBox unavailable (${t.javaClass.simpleName}); using TEE-backed key")
            generateKey(alias, gated, strongBox = false)
        }
    }

    private fun isStrongBoxFailure(t: Throwable): Boolean {
        var e: Throwable? = t
        while (e != null) {
            if (e.javaClass.simpleName.contains("StrongBox", ignoreCase = true)) return true
            if (e.message?.contains("StrongBox", ignoreCase = true) == true) return true
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P &&
                e is StrongBoxUnavailableException
            ) return true
            e = e.cause
        }
        return false
    }

    private fun generateKey(alias: String, gated: Boolean, strongBox: Boolean): SecretKey {
        val builder = KeyGenParameterSpec.Builder(
            alias,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setRandomizedEncryptionRequired(true)

        if (gated) {
            builder.setUserAuthenticationRequired(true)
            // Default is TRUE, which destroys the key the moment the user
            // enrols a new fingerprint -- silently costing them the ability to
            // ever see their backup phrase again. Never leave this at default.
            builder.setInvalidatedByBiometricEnrollment(false)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                // Timeout 0 = authenticate for every single use, enforced by
                // the Cipher itself via a CryptoObject. Device credential is
                // always allowed so a broken fingerprint sensor, or a user with
                // no biometric enrolled, is not a lockout.
                builder.setUserAuthenticationParameters(
                    0,
                    KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL,
                )
            } else {
                // API 24..29 has no setUserAuthenticationParameters. The key is
                // instead unlocked for a short window by a device-credential
                // confirmation; SeedGate raises that via KeyguardManager.
                @Suppress("DEPRECATION")
                builder.setUserAuthenticationValidityDurationSeconds(
                    SeedGate.LEGACY_AUTH_WINDOW_SECONDS
                )
            }
        }

        if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            builder.setIsStrongBoxBacked(true)
        }

        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        gen.init(builder.build())
        return gen.generateKey()
    }

    companion object {
        private const val TAG = "PCoinSeedStore"

        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val GCM_TAG_BITS = 128

        /**
         * Two aliases, not one, so the regime a blob was written under is never
         * ambiguous: a gated blob can only ever be opened by the gated key.
         */
        private const val ALIAS_GATED = "pcoin_seed_v1"
        private const val ALIAS_UNGATED = "pcoin_seed_v1_nolock"

        private const val BLOB_NAME = "seed.v1.json"
        private const val VERSION = 1

        /**
         * Identifies the whole derivation scheme, not just the path: BIP39
         * English, empty passphrase, BIP84, coin type 9444'. A future version
         * that adds an optional BIP39 passphrase must write a different id here,
         * so a wallet created today is never re-derived under tomorrow's rules.
         */
        const val DERIVATION_ID = "bip84-9444-nopass-v1"
    }
}
