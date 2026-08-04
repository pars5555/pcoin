package org.pcoin.miner

import android.content.Context
import android.content.Intent
import android.graphics.Typeface
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import org.pcoin.miner.wallet.Bip39
import org.pcoin.miner.wallet.SeedGate
import org.pcoin.miner.wallet.SeedStore

/**
 * Shows the recovery phrase again, behind a device unlock.
 *
 * The unlock is cryptographically bound to the decryption, not merely displayed
 * in front of it. The Keystore key was created with
 * setUserAuthenticationRequired(true), so the Cipher physically cannot produce
 * plaintext until the platform has authenticated the user -- there is no
 * boolean callback here that a rooted device could skip past, because the
 * plaintext does not exist until the unlock happens.
 *
 * FLAG_SECURE blocks screenshots, screen recording and the recents thumbnail.
 * The phrase is additionally hidden again on every onPause and after a short
 * timeout, so it does not sit on a screen the user has walked away from.
 */
class BackupActivity : AppCompatActivity() {

    private lateinit var seedStore: SeedStore
    private lateinit var gate: SeedGate

    private lateinit var words: LinearLayout
    private lateinit var status: TextView
    private lateinit var revealButton: Button
    private lateinit var note: TextView

    private val ui = Handler(Looper.getMainLooper())
    private val autoHide = Runnable { hidePhrase(getString(R.string.backup_hidden_timeout)) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setFlags(
            WindowManager.LayoutParams.FLAG_SECURE,
            WindowManager.LayoutParams.FLAG_SECURE,
        )
        setContentView(R.layout.activity_backup)

        seedStore = SeedStore(this)
        gate = SeedGate(this)

        words = findViewById(R.id.backup_words)
        status = findViewById(R.id.backup_status)
        revealButton = findViewById(R.id.backup_reveal)
        note = findViewById(R.id.backup_note)

        revealButton.setOnClickListener { reveal() }
        findViewById<Button>(R.id.backup_close).setOnClickListener { finish() }

        if (!seedStore.exists()) {
            status.setText(R.string.backup_none)
            revealButton.visibility = View.GONE
            note.setText(R.string.backup_none_note)
        } else {
            val meta = seedStore.meta()
            note.setText(
                if (meta?.deviceLockProtected == false) R.string.storage_note_unlocked
                else R.string.storage_note_locked
            )
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (gate.onActivityResult(requestCode, resultCode)) return
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
    }

    override fun onPause() {
        super.onPause()
        gate.cancel()
        // Hidden on the way out, not on the way back in: the phrase must not
        // survive in a view hierarchy that the system may snapshot.
        hidePhrase(getString(R.string.backup_hidden_paused))
    }

    private fun reveal() {
        val meta = seedStore.meta()
        if (meta == null) {
            status.text = getString(R.string.backup_unavailable, "no metadata")
            return
        }

        // beginRead() happens INSIDE the prepare lambda, not before it. On API
        // 24..29 the Cipher.init inside beginRead is exactly what throws
        // UserNotAuthenticatedException, and SeedGate re-runs prepare after the
        // unlock. Building the Cipher up front would turn that into an
        // unexplained "phrase unavailable" on every pre-API-30 device.
        var pending: SeedStore.PendingRead? = null

        gate.authorize(
            title = getString(R.string.gate_view_title),
            subtitle = getString(R.string.gate_view_subtitle),
            gated = meta.deviceLockProtected,
            prepare = {
                val p = seedStore.beginRead()
                pending = p
                p.cipher
            },
            callback = object : SeedGate.Callback {
                override fun onAuthenticated() {
                    val p = pending
                    if (p == null) {
                        status.text = getString(R.string.backup_unavailable, "no cipher")
                        return
                    }
                    showPhrase(p)
                }

                override fun onFailed(reason: String, cancelled: Boolean) {
                    if (reason.contains("KeyLost", ignoreCase = true) ||
                        reason.contains("no longer", ignoreCase = true)
                    ) {
                        // Honest, and deliberately not alarming: the money is
                        // not affected. The node holds the keys and the user
                        // has the paper. What is lost is only the ability to
                        // re-display the phrase on this device.
                        status.text = getString(R.string.backup_key_lost, reason)
                        revealButton.visibility = View.GONE
                        return
                    }
                    status.setText(
                        if (cancelled) R.string.backup_cancelled else R.string.backup_auth_failed
                    )
                }
            },
        )
    }

    private fun showPhrase(pending: SeedStore.PendingRead) {
        val chars = try {
            seedStore.finishRead(pending)
        } catch (t: Throwable) {
            status.text = getString(R.string.backup_unavailable, t.javaClass.simpleName)
            return
        }
        try {
            val list = Bip39.splitWords(String(chars))
            words.removeAllViews()
            for ((i, w) in list.withIndex()) {
                val tv = TextView(this)
                tv.text = "${i + 1}.  $w"
                tv.textSize = 17f
                tv.typeface = Typeface.MONOSPACE
                tv.setPadding(0, 10, 0, 10)
                words.addView(tv)
            }
            words.visibility = View.VISIBLE
            status.setText(R.string.backup_shown)
            revealButton.visibility = View.GONE
            ui.removeCallbacks(autoHide)
            ui.postDelayed(autoHide, AUTO_HIDE_MS)
        } finally {
            chars.fill(' ')
        }
    }

    private fun hidePhrase(reason: String) {
        ui.removeCallbacks(autoHide)
        if (words.childCount == 0 && words.visibility != View.VISIBLE) return
        words.removeAllViews()
        words.visibility = View.GONE
        if (seedStore.exists()) {
            revealButton.visibility = View.VISIBLE
            status.text = reason
        }
    }

    companion object {
        /** Long enough to copy twelve words onto paper, short enough to matter. */
        private const val AUTO_HIDE_MS = 120_000L

        fun intent(context: Context): Intent = Intent(context, BackupActivity::class.java)
    }
}
