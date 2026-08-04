package org.pcoin.miner.wallet

import android.app.Activity
import android.app.KeyguardManager
import android.content.Context
import android.hardware.biometrics.BiometricPrompt
import android.os.Build
import android.os.CancellationSignal
import android.security.keystore.UserNotAuthenticatedException
import android.util.Log
import androidx.annotation.RequiresApi
import javax.crypto.Cipher

/**
 * The device-unlock prompt in front of the recovery phrase.
 *
 * The prompt is not the security boundary -- the Keystore key is (see
 * [SeedStore]). What this class does is drive whichever unlock mechanism the
 * running Android version actually supports, and hand back a Cipher that the
 * platform has already authorised.
 *
 * Two paths, both implemented, because minSdk is 24:
 *
 *  - API 30+: the key is auth-per-use, so the unlock is bound to the Cipher via
 *    a BiometricPrompt CryptoObject. Nothing can produce plaintext without it,
 *    on a rooted device or otherwise.
 *  - API 24..29: setUserAuthenticationParameters does not exist, so the key is
 *    instead unlocked for a short window by a device-credential confirmation.
 *    Cipher.init throws UserNotAuthenticatedException until that has happened,
 *    which is the signal this class keys off. Weaker than a CryptoObject
 *    binding (the window is time-based) but it is what the platform offers, and
 *    it is a real Keystore-enforced gate rather than a boolean.
 *
 * The platform BiometricPrompt is used rather than androidx.biometric on
 * purpose: the API 30+ contract needed here (setAllowedAuthenticators with
 * DEVICE_CREDENTIAL plus a CryptoObject) is supported directly, and adding a
 * support-library dependency to a wallet gate is complexity with no payoff.
 */
class SeedGate(private val activity: Activity) {

    /**
     * The device-lock question could not be answered.
     *
     * Deliberately NOT the same as "this device has no lock screen". A device
     * with no lock is a known fact the UI states plainly; an unanswerable query
     * is an unknown, and picking the weaker key path on an unknown is a security
     * control degrading silently. Callers must fail rather than downgrade.
     */
    class LockCheckFailed(message: String) : Exception(message)

    interface Callback {
        /** The platform has authorised use of the key. */
        fun onAuthenticated()

        /**
         * @param cancelled true when the user backed out, as opposed to
         *   something failing. Cancelling is not an error and must not be
         *   presented as one.
         */
        fun onFailed(reason: String, cancelled: Boolean)
    }

    private var pendingCallback: Callback? = null

    /**
     * The work to retry once an API 24..29 credential confirmation comes back.
     *
     * On that path Cipher.init is what throws UserNotAuthenticatedException, so
     * the Cipher does not exist yet when the prompt goes up and MUST be built
     * again afterwards. Forgetting this is subtle and total: the callback would
     * fire, the UI would say "authenticated", and the decryption would then be
     * attempted with a Cipher that was never successfully initialised.
     */
    private var pendingPrepare: (() -> Cipher)? = null

    private var cancellationSignal: CancellationSignal? = null

    /**
     * Runs [prepare] behind a device unlock and calls back on the main thread.
     *
     * @param prepare produces the Cipher to authorise. On API 24..29 it may
     *   throw UserNotAuthenticatedException, which is not a failure but the
     *   platform asking for the unlock; it is retried after one.
     * @param gated when false the phrase is stored under an ungated key
     *   (a device with no secure lock screen at all), so there is nothing to
     *   prompt for and pretending otherwise would be theatre.
     */
    fun authorize(
        title: String,
        subtitle: String,
        gated: Boolean,
        prepare: () -> Cipher,
        callback: Callback,
    ) {
        if (!gated) {
            // No lock screen on this device. The UI says so in plain words
            // elsewhere; there is no prompt that would mean anything here.
            try {
                prepare()
                callback.onAuthenticated()
            } catch (t: Throwable) {
                callback.onFailed(t.javaClass.simpleName, false)
            }
            return
        }

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            // API 24..29: ALWAYS raise an explicit credential confirmation,
            // even though Cipher.init would very likely succeed on its own.
            //
            // The key here is a validity-duration key
            // (setUserAuthenticationValidityDurationSeconds), so for 30 seconds
            // after any device unlock the Cipher initialises without a prompt.
            // Returning onAuthenticated() on that basis meant picking up an
            // already-unlocked phone and opening Backup showed the words with no
            // prompt whatsoever -- which is not the requirement. The requirement
            // is an explicit device-unlock in front of the phrase, so the prompt
            // is raised unconditionally and `prepare` runs only after it comes
            // back OK.
            pendingPrepare = prepare
            confirmCredential(title, subtitle, callback)
            return
        }

        val cipher = try {
            prepare()
        } catch (e: UserNotAuthenticatedException) {
            // Not expected on API 30+ (the key is auth-per-use and binds to the
            // CryptoObject), but handled the same way rather than reported as a
            // failure: the platform is asking for the unlock.
            pendingPrepare = prepare
            confirmCredential(title, subtitle, callback)
            return
        } catch (t: Throwable) {
            callback.onFailed(Redact.text(t), false)
            return
        }

        promptWithCrypto(title, subtitle, cipher, callback)
    }

    @RequiresApi(Build.VERSION_CODES.R)
    private fun promptWithCrypto(
        title: String,
        subtitle: String,
        cipher: Cipher,
        callback: Callback,
    ) {
        val signal = CancellationSignal()
        cancellationSignal = signal
        val prompt = BiometricPrompt.Builder(activity)
            .setTitle(title)
            .setSubtitle(subtitle)
            .apply {
                // Device credential must be allowed, so a phone with no
                // enrolled biometric (or a dead sensor) is not a lockout. Note
                // that setNegativeButton must NOT be combined with
                // DEVICE_CREDENTIAL -- the platform throws if both are set.
                setAllowedAuthenticators(
                    android.hardware.biometrics.BiometricManager.Authenticators.BIOMETRIC_STRONG or
                        android.hardware.biometrics.BiometricManager.Authenticators.DEVICE_CREDENTIAL
                )
                setConfirmationRequired(false)
            }
            .build()

        prompt.authenticate(
            BiometricPrompt.CryptoObject(cipher),
            signal,
            activity.mainExecutor,
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    cancellationSignal = null
                    callback.onAuthenticated()
                }

                override fun onAuthenticationError(code: Int, message: CharSequence?) {
                    cancellationSignal = null
                    // There is no negative-button case to handle: setting a
                    // negative button alongside DEVICE_CREDENTIAL is rejected by
                    // the platform, so this prompt does not have one.
                    val cancelled = code == BiometricPrompt.BIOMETRIC_ERROR_USER_CANCELED ||
                        code == BiometricPrompt.BIOMETRIC_ERROR_CANCELED
                    callback.onFailed(message?.toString().orEmpty(), cancelled)
                }
            },
        )
    }

    private fun confirmCredential(title: String, subtitle: String, callback: Callback) {
        val km = activity.getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
        @Suppress("DEPRECATION")
        val intent = km?.createConfirmDeviceCredentialIntent(title, subtitle)
        if (intent == null) {
            callback.onFailed("this device cannot confirm a screen lock", false)
            return
        }
        pendingCallback = callback
        @Suppress("DEPRECATION")
        activity.startActivityForResult(intent, REQUEST_CONFIRM_CREDENTIAL)
    }

    /**
     * Forward the host activity's onActivityResult here.
     * @return true when this gate consumed the result.
     */
    fun onActivityResult(requestCode: Int, resultCode: Int): Boolean {
        if (requestCode != REQUEST_CONFIRM_CREDENTIAL) return false
        val cb = pendingCallback ?: return true
        val prepare = pendingPrepare
        pendingCallback = null
        pendingPrepare = null
        if (resultCode != Activity.RESULT_OK) {
            cb.onFailed("screen lock not confirmed", true)
            return true
        }
        if (prepare != null) {
            // Rebuild the Cipher now that the key is inside its window. If this
            // still fails, the unlock did not actually authorise the key and
            // reporting success would be a lie.
            try {
                prepare()
            } catch (t: Throwable) {
                cb.onFailed(Redact.text(t), false)
                return true
            }
        }
        cb.onAuthenticated()
        return true
    }

    /** Dismiss any in-flight prompt, e.g. from onPause. */
    fun cancel() {
        try {
            cancellationSignal?.cancel()
        } catch (t: Throwable) {
            Log.d(TAG, "cancel: ${t.javaClass.simpleName}")
        }
        cancellationSignal = null
    }

    companion object {
        private const val TAG = "PCoinSeedGate"
        private const val REQUEST_CONFIRM_CREDENTIAL = 7241

        /**
         * How long an API 24..29 unlock keeps the key usable. Short on purpose:
         * long enough to walk from the prompt to the phrase, not long enough to
         * be a standing grant.
         */
        const val LEGACY_AUTH_WINDOW_SECONDS = 30

        /**
         * True when the device has a PIN, pattern, password or biometric set.
         *
         * Generating a key with setUserAuthenticationRequired(true) on a device
         * with no secure lock screen throws, so this must be checked BEFORE key
         * creation, not after.
         *
         * Fails CLOSED. An earlier version caught every Throwable and returned
         * false, which meant an unexpected exception from the keyguard query --
         * on a device that may well have a PIN -- silently selected the ungated
         * Keystore alias and stored the phrase under a key with no
         * setUserAuthenticationRequired. The downgrade was then recorded in the
         * metadata and trusted forever after, so the Backup screen revealed the
         * phrase with no prompt at all. A security control must not weaken
         * itself because a query it did not expect to fail failed.
         *
         * "This device genuinely has no lock screen" is still an ordinary
         * answer (false), because that is a fact the UI states plainly rather
         * than an unknown.
         *
         * @throws LockCheckFailed when the answer cannot be obtained.
         */
        @Throws(LockCheckFailed::class)
        fun deviceLockAvailable(context: Context): Boolean {
            val km = try {
                context.getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
            } catch (t: Throwable) {
                Log.w(TAG, "keyguard service unavailable: ${t.javaClass.simpleName}")
                throw LockCheckFailed(
                    "this device did not answer whether it has a screen lock " +
                        "(${t.javaClass.simpleName})"
                )
            } ?: throw LockCheckFailed("this device does not provide a keyguard service")

            return try {
                km.isDeviceSecure
            } catch (t: Throwable) {
                Log.w(TAG, "keyguard query failed: ${t.javaClass.simpleName}")
                throw LockCheckFailed(
                    "this device did not answer whether it has a screen lock " +
                        "(${t.javaClass.simpleName})"
                )
            }
        }
    }
}
