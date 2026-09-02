package org.pcoin.miner

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.util.Log
import android.view.View
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import org.pcoin.miner.wallet.Bip39
import org.pcoin.miner.wallet.DescriptorInstaller
import org.pcoin.miner.wallet.PcoinDerivation
import org.pcoin.miner.wallet.Redact
import org.pcoin.miner.wallet.SeedGate
import org.pcoin.miner.wallet.SeedStore
import java.security.SecureRandom
import kotlin.concurrent.thread

/**
 * Creating or restoring the wallet from a twelve-word recovery phrase.
 *
 * The order of operations is the safety property. Nothing is created on the
 * node until the phrase exists, has been written down, has been proved written
 * down, and has been stored. If any step fails, nothing has happened yet and
 * the user can start again.
 *
 * FLAG_SECURE is set for the whole activity. It blocks screenshots and screen
 * recording, and -- the one people forget -- the recents-screen thumbnail,
 * which would otherwise leave a picture of the twelve words sitting in the task
 * switcher after the user backgrounds the app.
 *
 * The phrase is never logged, at any level, in any build. It is never put in a
 * notification, and there is no "copy to clipboard" button: the entire point of
 * twelve words is that they go on paper, and a copy button is the worst habit
 * this screen could teach.
 */
class SetupActivity : AppCompatActivity() {

    private lateinit var prefs: Prefs
    private lateinit var seedStore: SeedStore
    private lateinit var gate: SeedGate
    private lateinit var bip39: Bip39

    private val ui = Handler(Looper.getMainLooper())

    /**
     * The phrase in play, held as chars so it can be blanked. Wiped in
     * [clearPhrase] on the way out of every screen that shows or builds it.
     */
    private var phrase: CharArray? = null

    /** Word count for a newly generated phrase: 12, or 24 behind Advanced. */
    private var wordCount = 12

    /**
     * How many boxes the restore step shows.
     *
     * Selectable, because the only other way to get 24 fields was to paste --
     * which requires the phrase to already be in digital form on the device, the
     * exact opposite of the "write it on paper" instruction setup gives.
     */
    private var restoreWordCount = 12

    /** Positions (0-based) the user must retype to prove they wrote it down. */
    private var challengePositions: List<Int> = emptyList()

    private var restoring = false
    private var working = false

    /** Set when the wordlist failed its digest check; the screen is inert. */
    private var unusable = false

    // Step containers
    private lateinit var stepChoice: View
    private lateinit var stepResume: View
    private lateinit var stepShow: View
    private lateinit var stepConfirm: View
    private lateinit var stepRestore: View
    private lateinit var stepProgress: View
    private lateinit var stepDone: View

    private lateinit var wordGrid: LinearLayout
    private lateinit var confirmGrid: LinearLayout
    private lateinit var restoreGrid: LinearLayout
    private lateinit var restoreStatus: TextView
    private lateinit var restoreButton: Button
    private lateinit var confirmButton: Button
    private lateinit var confirmError: TextView
    private lateinit var progressText: TextView
    private lateinit var progressBar: ProgressBar
    private lateinit var doneText: TextView
    private lateinit var storageNote: TextView

    private val restoreFields = ArrayList<EditText>()
    private val confirmFields = ArrayList<EditText>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Before setContentView: nothing showing this screen should ever be
        // capturable, including the very first frame.
        window.setFlags(
            WindowManager.LayoutParams.FLAG_SECURE,
            WindowManager.LayoutParams.FLAG_SECURE,
        )
        setContentView(R.layout.activity_setup)
        padForSystemBars()

        prefs = Prefs(this)
        seedStore = SeedStore(this)
        gate = SeedGate(this)

        // A wordlist that fails its digest check must stop everything. Deriving
        // keys from a wordlist that is not the canonical BIP39 English list
        // would produce a phrase that restores nothing anywhere else, and it
        // would do so completely silently.
        bip39 = try {
            WordList.load(this)
        } catch (t: Throwable) {
            Log.e(TAG, "wordlist unusable: ${t.javaClass.simpleName}")
            unusable = true
            findViewById<TextView>(R.id.progress_text).text =
                getString(R.string.setup_failed, "the bundled word list is damaged")
            findViewById<View>(R.id.step_choice).visibility = View.GONE
            findViewById<View>(R.id.step_progress).visibility = View.VISIBLE
            findViewById<ProgressBar>(R.id.progress_bar).visibility = View.GONE
            return
        }

        stepChoice = findViewById(R.id.step_choice)
        stepResume = findViewById(R.id.step_resume)
        stepShow = findViewById(R.id.step_show)
        stepConfirm = findViewById(R.id.step_confirm)
        stepRestore = findViewById(R.id.step_restore)
        stepProgress = findViewById(R.id.step_progress)
        stepDone = findViewById(R.id.step_done)

        wordGrid = findViewById(R.id.word_grid)
        confirmGrid = findViewById(R.id.confirm_grid)
        restoreGrid = findViewById(R.id.restore_grid)
        restoreStatus = findViewById(R.id.restore_status)
        restoreButton = findViewById(R.id.restore_button)
        confirmButton = findViewById(R.id.confirm_button)
        confirmError = findViewById(R.id.confirm_error)
        progressText = findViewById(R.id.progress_text)
        progressBar = findViewById(R.id.progress_bar)
        doneText = findViewById(R.id.done_text)
        storageNote = findViewById(R.id.storage_note)

        findViewById<Button>(R.id.choice_create).setOnClickListener { startCreate() }
        findViewById<Button>(R.id.choice_restore).setOnClickListener { startRestore() }
        findViewById<Button>(R.id.show_continue).setOnClickListener { startConfirm() }
        findViewById<Button>(R.id.show_skip).setOnClickListener {
            storeAndInstall(restored = false, confirmed = false)
        }
        confirmButton.setOnClickListener { checkConfirmation() }
        findViewById<Button>(R.id.confirm_back).setOnClickListener { showStep(stepShow) }
        restoreButton.setOnClickListener { submitRestore() }
        findViewById<Button>(R.id.done_button).setOnClickListener { finishSetup() }
        findViewById<Button>(R.id.resume_finish).setOnClickListener { resumeInstall() }
        findViewById<Button>(R.id.resume_view).setOnClickListener {
            startActivity(BackupActivity.intent(this))
        }
        findViewById<Button>(R.id.restore_count_12).setOnClickListener { setRestoreWordCount(12) }
        findViewById<Button>(R.id.restore_count_24).setOnClickListener { setRestoreWordCount(24) }

        findViewById<CheckBox>(R.id.use_24_words).setOnCheckedChangeListener { _, checked ->
            wordCount = if (checked) 24 else 12
        }

        // Bring the node up in the background now, so that by the time the user
        // has written twelve words down it is already synced and the wallet
        // creation is instant. Deliberately does NOT switch mining on -- that is
        // the user's own persisted choice and setup must not write it.
        MinerService.prepare(this)

        // A stored phrase with no wallet recorded against it means setup was
        // interrupted between the two. Offer to finish it rather than the create
        // /restore choice: generating a second phrase here is how the first one
        // used to get silently overwritten.
        showStep(if (setupIncomplete()) stepResume else stepChoice)
    }

    /**
     * Persisted intent, not the presence of a file.
     *
     * [Prefs.seedWalletName] is written only after the node has cross-checked
     * the payout address against the locally derived one, so it -- and not the
     * encrypted blob, which is written first -- is what says this install has a
     * working phrase-backed wallet.
     */
    private fun setupIncomplete(): Boolean =
        seedStore.exists() && prefs.seedWalletName == null

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (gate.onActivityResult(requestCode, resultCode)) return
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
    }

    override fun onPause() {
        super.onPause()
        gate.cancel()
    }

    override fun onDestroy() {
        clearPhrase()
        super.onDestroy()
    }

    /**
     * Back is allowed everywhere except while the wallet is actually being
     * built. Interrupting the activity mid-import would leave the node holding
     * a wallet the app has not yet recorded a payout address for.
     */
    @Suppress("DEPRECATION", "MissingSuperCall")
    override fun onBackPressed() {
        if (unusable) {
            finish()
            return
        }
        if (working) return
        if (stepDone.visibility == View.VISIBLE) {
            finishSetup()
            return
        }
        if (stepChoice.visibility == View.VISIBLE || stepResume.visibility == View.VISIBLE) {
            @Suppress("DEPRECATION")
            super.onBackPressed()
            return
        }
        clearPhrase()
        // Back out of an interrupted setup to the resume offer, never to the
        // create/restore choice: the stored phrase is still the one that matters
        // and the next step must be to finish it, not to make another.
        showStep(if (setupIncomplete()) stepResume else stepChoice)
    }

    // ----------------------------------------------------------------- create

    private fun startCreate() {
        restoring = false
        phrase = bip39.generate(wordCount)
        renderPhrase()
        showStep(stepShow)
    }

    private fun renderPhrase() {
        wordGrid.removeAllViews()
        val words = currentWords()
        for ((i, w) in words.withIndex()) {
            val tv = TextView(this)
            tv.text = "${i + 1}.  $w"
            tv.textSize = 17f
            tv.typeface = android.graphics.Typeface.MONOSPACE
            tv.setPadding(0, 10, 0, 10)
            wordGrid.addView(tv)
        }
    }

    private fun currentWords(): List<String> =
        phrase?.let { Bip39.splitWords(String(it)) } ?: emptyList()

    // ---------------------------------------------------------------- confirm

    /**
     * Three words at positions chosen by SecureRandom.
     *
     * The positions are re-picked on every attempt, so someone who did not
     * write the phrase down cannot brute-force their way through by retrying
     * until they get three words they happen to remember.
     */
    private fun startConfirm() {
        val words = currentWords()
        if (words.isEmpty()) {
            showStep(stepChoice)
            return
        }
        val rnd = SecureRandom()
        val picked = LinkedHashSet<Int>()
        while (picked.size < CONFIRM_WORDS && picked.size < words.size) {
            picked.add(rnd.nextInt(words.size))
        }
        challengePositions = picked.sorted()

        confirmGrid.removeAllViews()
        confirmFields.clear()
        confirmError.visibility = View.GONE
        for (pos in challengePositions) {
            val label = TextView(this)
            label.text = getString(R.string.confirm_word_label, pos + 1)
            label.textSize = 14f
            confirmGrid.addView(label)

            val field = newWordField()
            confirmGrid.addView(field)
            confirmFields.add(field)
        }
        confirmFields.firstOrNull()?.requestFocus()
        showStep(stepConfirm)
    }

    private fun checkConfirmation() {
        val words = currentWords()
        val ok = challengePositions.withIndex().all { (i, pos) ->
            val typed = Bip39.normalize(confirmFields[i].text.toString())
            typed == words.getOrNull(pos)
        }
        if (!ok) {
            confirmError.setText(R.string.confirm_wrong)
            confirmError.visibility = View.VISIBLE
            // New positions on every attempt: see startConfirm.
            ui.postDelayed({ startConfirm() }, 900)
            return
        }
        storeAndInstall(restored = false)
    }

    // ---------------------------------------------------------------- restore

    private fun startRestore() {
        restoring = true
        restoreWordCount = 12
        buildRestoreFields(restoreWordCount)
        markRestoreCountButtons()
        showStep(stepRestore)
        restoreFields.firstOrNull()?.requestFocus()
        updateRestoreStatus()
    }

    /**
     * Switches between a 12- and a 24-word phrase.
     *
     * Anything already typed is kept: someone who typed twelve words, realised
     * their paper has twenty-four and tapped the other button should not have to
     * type those twelve again.
     */
    private fun setRestoreWordCount(count: Int) {
        if (count == restoreWordCount) return
        val typed = typedWords()
        restoreWordCount = count
        buildRestoreFields(count)
        for ((i, field) in restoreFields.withIndex()) {
            field.setText(typed.getOrElse(i) { "" })
        }
        markRestoreCountButtons()
        restoreFields.firstOrNull { it.text.isNullOrBlank() }?.requestFocus()
        updateRestoreStatus()
    }

    private fun markRestoreCountButtons() {
        findViewById<Button>(R.id.restore_count_12).isEnabled = restoreWordCount != 12
        findViewById<Button>(R.id.restore_count_24).isEnabled = restoreWordCount != 24
    }

    private fun buildRestoreFields(count: Int) {
        restoreGrid.removeAllViews()
        restoreFields.clear()
        for (i in 0 until count) {
            val row = LinearLayout(this)
            row.orientation = LinearLayout.HORIZONTAL

            val num = TextView(this)
            num.text = "${i + 1}."
            num.textSize = 15f
            num.width = (44 * resources.displayMetrics.density).toInt()
            row.addView(num)

            val field = newWordField()
            field.layoutParams = LinearLayout.LayoutParams(0, -2, 1f)
            field.addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) = Unit
                override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) = Unit
                override fun afterTextChanged(s: Editable?) {
                    // Pasting a whole phrase into the first box is a normal
                    // thing to do, and refusing it just makes people retype.
                    //
                    // The trigger is "this box now holds a whole phrase", NOT
                    // "this box contains a space". Firing on any space meant
                    // that typing one word plus a trailing space in box 1
                    // re-ran the split, and focus jumped to the last box.
                    if (i == 0 && s != null &&
                        Bip39.splitWords(s.toString()).size in Bip39.VALID_WORD_COUNTS
                    ) {
                        // Deferred: this can rebuild the whole field list, and
                        // tearing down the view whose watcher is running is a
                        // good way to trip over the framework.
                        val pasted = s.toString()
                        ui.post { distributePaste(pasted) }
                        return
                    }
                    updateRestoreStatus()
                }
            })
            field.setOnFocusChangeListener { v, hasFocus ->
                // Per-field feedback on leaving the field, not on submit: a
                // typo found eleven words later is a typo the user has to hunt
                // for.
                if (!hasFocus) markFieldValidity(v as EditText)
            }
            row.addView(field)
            restoreFields.add(field)
            restoreGrid.addView(row)
        }
    }

    /**
     * Splits a pasted phrase across the boxes.
     *
     * Only ever acts on a COMPLETE phrase. The guard used to read
     * `!in VALID_WORD_COUNTS && size < 2`, which is only true for zero or one
     * words -- so pasting an arbitrary count (five, or thirteen from a phrase
     * with a duplicated line) fell straight through, did not rebuild the grid,
     * filled the first N boxes and blanked the rest.
     */
    private fun distributePaste(text: String) {
        val words = Bip39.splitWords(text)
        if (words.size !in Bip39.VALID_WORD_COUNTS) return
        if (words.size != restoreFields.size) {
            restoreWordCount = words.size
            buildRestoreFields(words.size)
            markRestoreCountButtons()
        }
        for ((i, field) in restoreFields.withIndex()) {
            field.setText(words.getOrElse(i) { "" })
            markFieldValidity(field)
        }
        // The first box still needing attention, not the last box. Jumping to
        // the end is only right when everything before it is already filled.
        (restoreFields.firstOrNull { it.text.isNullOrBlank() } ?: restoreFields.lastOrNull())
            ?.requestFocus()
        updateRestoreStatus()
    }

    private fun markFieldValidity(field: EditText) {
        val text = Bip39.normalize(field.text.toString())
        when {
            text.isEmpty() -> field.error = null
            bip39.isWord(text) -> field.error = null
            else -> {
                // Suggestions are offered, never applied. Silently rewriting a
                // word is how someone restores a different wallet than the one
                // they think they are restoring.
                val hints = bip39.suggestions(text, 3)
                field.error = if (hints.isEmpty()) {
                    getString(R.string.restore_word_unknown)
                } else {
                    getString(R.string.restore_word_unknown_did_you_mean, hints.joinToString(", "))
                }
            }
        }
    }

    private fun typedWords(): List<String> =
        restoreFields.map { Bip39.normalize(it.text.toString()) }

    private fun updateRestoreStatus() {
        val words = typedWords()
        val valid = words.count { it.isNotEmpty() && bip39.isWord(it) }
        val total = restoreFields.size
        restoreStatus.text = getString(R.string.restore_progress, valid, total)
        restoreButton.isEnabled = valid == total && !working
    }

    private fun submitRestore() {
        val words = typedWords()
        when (val v = bip39.validate(words)) {
            is Bip39.Validation.Ok -> {
                phrase = words.joinToString(" ").toCharArray()
                wordCount = words.size
                storeAndInstall(restored = true)
            }
            is Bip39.Validation.UnknownWords -> {
                v.positions.forEach { markFieldValidity(restoreFields[it]) }
                restoreStatus.setText(R.string.restore_unknown_words)
            }
            is Bip39.Validation.BadWordCount ->
                restoreStatus.text = getString(R.string.restore_bad_count, v.count)
            Bip39.Validation.ChecksumFailed ->
                // Deliberately does NOT point at a word. The checksum is a hash
                // over the whole phrase and cannot identify which word is wrong;
                // a confident wrong hint sends the user off correcting a word
                // that was fine.
                //
                // It DOES raise the word count when twelve were entered, because
                // "I wrote down 24 and typed the first 12" is a common and
                // completely invisible cause of this exact failure: the first
                // twelve words of a 24-word phrase are not a valid 12-word
                // phrase, so it presents as an ordinary checksum error.
                restoreStatus.text = if (words.size == 12) {
                    getString(R.string.restore_checksum_failed_count, words.size)
                } else {
                    getString(R.string.restore_checksum_failed)
                }
        }
    }

    // ------------------------------------------------------- store then build

    /**
     * Stores the phrase, then builds the wallet. In that order, always.
     *
     * If storing fails the user still has the paper, and nothing has been
     * created on the node, so they can simply try again. If the wallet build
     * were done first, a failure to store would leave a wallet whose phrase the
     * app cannot show again.
     */
    /**
     * @param confirmed whether the user proved they wrote the phrase down.
     *
     * False is a legitimate state, not a failure: a miner that forwards its
     * coins out holds about a day of rewards, and demanding a write-down
     * ceremony before it can mine is friction with no matching risk. The
     * phrase is still generated and stored encrypted either way, so the
     * wallet is recoverable from the Backup screen whenever the owner gets
     * round to it. prefs.phraseConfirmed stays false so the home screen keeps
     * saying so -- deferred, never silently treated as done.
     */
    private fun storeAndInstall(restored: Boolean, confirmed: Boolean = true) {
        val words = phrase ?: return
        if (working) return

        // Refuse before anything else if a phrase is already stored. The Back
        // button from a failed setup returns to the first step, so tapping
        // Create again is reachable inside one session -- and used to replace
        // the stored phrase silently.
        if (seedStore.exists()) {
            failSetup(getString(R.string.error_phrase_exists))
            return
        }

        working = true

        // Fails CLOSED: an unanswerable keyguard query is an unknown, not a
        // "no", and must not quietly select the ungated Keystore alias.
        val gated = try {
            SeedGate.deviceLockAvailable(this)
        } catch (e: SeedGate.LockCheckFailed) {
            working = false
            failSetup(getString(R.string.error_lock_unknown, e.message.orEmpty()))
            return
        }
        showProgress(getString(R.string.progress_saving))

        var pending: SeedStore.PendingWrite? = null
        gate.authorize(
            title = getString(R.string.gate_save_title),
            subtitle = getString(R.string.gate_save_subtitle),
            gated = gated,
            prepare = {
                val p = seedStore.beginWrite(requireDeviceLock = true)
                pending = p
                p.cipher
            },
            callback = object : SeedGate.Callback {
                override fun onAuthenticated() {
                    val p = pending
                    if (p == null) {
                        failSetup(getString(R.string.error_store_failed, "no cipher"))
                        return
                    }
                    try {
                        seedStore.finishWrite(
                            pending = p,
                            mnemonic = words,
                            wordCount = words.let { Bip39.splitWords(String(it)).size },
                            network = NETWORK,
                            birthTimeSec = NETWORK.genesisTime,
                            restored = restored,
                            // Never replace. There is no phrase on this device
                            // at this point -- storeAndInstall checked -- and if
                            // one appeared in between, stopping is right.
                            allowReplace = false,
                        )
                    } catch (e: SeedStore.AlreadyStored) {
                        failSetup(getString(R.string.error_phrase_exists))
                        return
                    } catch (t: Throwable) {
                        failSetup(getString(R.string.error_store_failed, t.javaClass.simpleName))
                        return
                    }
                    prefs.phraseConfirmed = confirmed
                    installWallet(restored, storedWithDeviceLock = p.deviceLockProtected)
                }

                override fun onFailed(reason: String, cancelled: Boolean) {
                    working = false
                    if (cancelled) {
                        showStep(if (restoring) stepRestore else stepShow)
                    } else {
                        failSetup(getString(R.string.error_unlock_failed, reason))
                    }
                }
            },
        )
    }

    // ------------------------------------------------------------- resume

    /**
     * Finishes a setup that stored the phrase but never built the wallet.
     *
     * The phrase is read back out of the encrypted blob rather than generated
     * again, which is the whole point: those words are already on the user's
     * paper, and DescriptorInstaller.install is idempotent -- if the wallet does
     * turn out to exist and own this phrase's address it simply records it.
     *
     * Nothing here can destroy the stored phrase. There is deliberately no
     * "discard and start over" button: a blob whose wallet cannot be confirmed
     * right now may still be a blob whose wallet exists and holds coins, and
     * telling the difference reliably needs the node to be reachable -- which is
     * exactly what is in doubt when this screen appears.
     */
    private fun resumeInstall() {
        if (working) return
        val meta = seedStore.meta()
        if (meta == null) {
            failSetup(getString(R.string.error_store_failed, "metadata unreadable"))
            return
        }
        working = true
        restoring = meta.restored
        showProgress(getString(R.string.resume_reading))

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
                        working = false
                        failSetup(getString(R.string.error_store_failed, "no cipher"))
                        return
                    }
                    phrase = try {
                        seedStore.finishRead(p)
                    } catch (t: Throwable) {
                        working = false
                        failSetup(getString(R.string.error_store_failed, t.javaClass.simpleName))
                        return
                    }
                    // Always rescan on a resume. Whether these keys were ever
                    // used is precisely what is unknown here, and on a chain
                    // this small the scan costs seconds; skipping it to save
                    // them could hide coins.
                    installWallet(
                        restored = true,
                        storedWithDeviceLock = meta.deviceLockProtected,
                    )
                }

                override fun onFailed(reason: String, cancelled: Boolean) {
                    working = false
                    if (cancelled) showStep(stepResume)
                    else failSetup(getString(R.string.error_unlock_failed, reason))
                }
            },
        )
    }

    /**
     * Waits for the node, then creates the wallet and imports the descriptors.
     *
     * Runs on a worker thread: importdescriptors blocks, and on a restore it
     * blocks for the whole rescan. A rescan behind a frozen screen reads as a
     * crash, and a user who force-quits during one thinks their money is gone,
     * so progress is reported throughout.
     */
    private fun installWallet(restored: Boolean, storedWithDeviceLock: Boolean) {
        val words = phrase ?: return
        showProgress(getString(R.string.progress_waiting_node))

        thread(name = "pcoin-wallet-setup", isDaemon = false) {
            val rpc = RpcClient(NativeBinaries.dataDir(this))
            val installer = DescriptorInstaller(rpc)
            var scanPoller: Thread? = null
            try {
                awaitNode(rpc)

                val keys = PcoinDerivation.accountKeys(bip39, words, NETWORK)
                try {
                    // A brand-new phrase provably has no history, so the node is
                    // told "now" and skips scanning entirely. A restore scans
                    // from the genesis time -- the true lower bound. Never 0 or
                    // 1: EnsureBlockDataFromTime already applies its own
                    // two-hour window either side.
                    val fromTime = if (restored) NETWORK.genesisTime else null

                    if (restored) scanPoller = startScanPoller(installer)

                    val result = installer.install(
                        keys = keys,
                        walletName = Prefs.SEED_WALLET,
                        rescanFromTimeSec = fromTime,
                        onProgress = { phase -> ui.post { showProgress(phase) } },
                    )

                    // Record the pre-phrase wallet FIRST. migrateLegacyWalletRecord
                    // keys off seedWalletName being null, so setting the seed
                    // wallet before it would make an existing "m" wallet
                    // invisible to loadKnownWallets -- its balance would vanish
                    // from the UI and it would stop being loaded, which reads
                    // exactly like the coins being gone.
                    prefs.migrateLegacyWalletRecord()

                    // Persisted only after the node's own view of the address
                    // has been checked against the locally derived one.
                    prefs.seedWalletName = result.walletName
                    prefs.payoutWallet = result.walletName
                    prefs.payoutAddress = result.payoutAddress

                    ui.post { setupSucceeded(result, storedWithDeviceLock) }
                } finally {
                    keys.wipe()
                }
            } catch (t: Throwable) {
                // Redacted: an importdescriptors failure can carry the whole
                // descriptor, xprv included, back in its message.
                val safe = Redact.text(t)
                Log.w(TAG, "wallet setup failed: $safe")
                ui.post { failSetup(safe.ifBlank { t.javaClass.simpleName }) }
            } finally {
                scanPoller?.interrupt()
                // clearPhrase touches EditTexts, so it has to run on the main
                // thread -- doing it here would throw CalledFromWrongThread and
                // leave the phrase in memory, which is the opposite of the
                // intent.
                ui.post { clearPhrase() }
            }
        }
    }

    /** Polls the rescan so a restore shows movement instead of a dead screen. */
    private fun startScanPoller(installer: DescriptorInstaller): Thread =
        thread(name = "pcoin-scan-progress", isDaemon = true) {
            try {
                while (!Thread.currentThread().isInterrupted) {
                    val p = installer.scanProgress(Prefs.SEED_WALLET)
                    if (p != null) {
                        val pct = (p * 100).toInt().coerceIn(0, 100)
                        ui.post {
                            progressBar.isIndeterminate = false
                            progressBar.progress = pct
                            progressText.text = getString(R.string.progress_rescanning, pct)
                        }
                    }
                    Thread.sleep(1_000)
                }
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
            } catch (t: Throwable) {
                Log.d(TAG, "scan poller ended: ${t.javaClass.simpleName}")
            }
        }

    /** Blocks until the node answers RPC, or gives up with a readable reason. */
    private fun awaitNode(rpc: RpcClient) {
        val deadline = System.currentTimeMillis() + NODE_WAIT_MS
        var last = "waiting for the node"
        while (System.currentTimeMillis() < deadline) {
            try {
                rpc.call("getblockchaininfo", readTimeoutMs = 10_000)
                return
            } catch (e: RpcClient.NotReady) {
                last = e.message ?: last
                ui.post { showProgress(last) }
            } catch (e: RpcClient.AuthFailed) {
                throw e
            } catch (t: Throwable) {
                last = t.javaClass.simpleName
            }
            Thread.sleep(1_000)
        }
        throw RpcClient.NotReady("the node did not start in time ($last)")
    }

    // ------------------------------------------------------------------- ui

    private fun showStep(step: View) {
        for (v in listOf(
            stepChoice, stepResume, stepShow, stepConfirm, stepRestore, stepProgress, stepDone,
        )) {
            v.visibility = if (v === step) View.VISIBLE else View.GONE
        }
    }

    private fun showProgress(text: String) {
        progressText.text = text
        progressBar.isIndeterminate = true
        showStep(stepProgress)
    }

    /**
     * On a restore, states what the scan actually found.
     *
     * A single mistyped word that happens to be another word from the list
     * passes the 4-bit checksum roughly one time in sixteen, so a valid-but-
     * wrong phrase restores cleanly into an empty wallet -- and without this it
     * looked exactly like a successful restore. "0 transactions, 0 PCN" is the
     * only thing that makes the difference visible while the user is still
     * standing there with the paper in their hand.
     *
     * "Could not ask the node" is reported as its own case. It is not zero.
     */
    private fun setupSucceeded(
        result: DescriptorInstaller.Result,
        storedWithDeviceLock: Boolean,
    ) {
        working = false
        doneText.text = if (restoring) {
            val summary = when {
                result.txCount < 0 || result.balance < 0 ->
                    getString(R.string.done_scan_unknown)
                result.txCount == 0 && result.balance == 0.0 ->
                    getString(R.string.done_scan_empty)
                else ->
                    getString(R.string.done_scan_found, result.txCount, Fmt.coins(result.balance))
            }
            getString(R.string.done_restored, result.payoutAddress, summary)
        } else {
            getString(R.string.done_created, result.payoutAddress)
        }
        storageNote.setText(
            if (storedWithDeviceLock) R.string.storage_note_locked
            else R.string.storage_note_unlocked
        )
        showStep(stepDone)
    }

    private fun failSetup(reason: String) {
        working = false
        progressBar.isIndeterminate = false
        progressText.text = getString(R.string.setup_failed, reason)
        showStep(stepProgress)
        findViewById<Button>(R.id.progress_back).visibility = View.VISIBLE
        findViewById<Button>(R.id.progress_back).setOnClickListener {
            findViewById<Button>(R.id.progress_back).visibility = View.GONE
            clearPhrase()
            showStep(if (setupIncomplete()) stepResume else stepChoice)
        }
    }

    private fun finishSetup() {
        setResult(Activity.RESULT_OK)
        finish()
    }

    private fun newWordField(): EditText {
        val f = EditText(this)
        // textVisiblePassword|textNoSuggestions plus no personalised learning:
        // without these the soft keyboard's dictionary LEARNS the seed words and
        // can later surface them as predictions inside other apps. It is a real,
        // documented leak and it costs three attributes to prevent.
        f.inputType = InputType.TYPE_CLASS_TEXT or
            InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD or
            InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        f.imeOptions = EditorInfo.IME_ACTION_NEXT or EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING
        f.setSingleLine(true)
        // Autofill arrived in API 26; below that there is nothing to opt out of.
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            f.importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
        }
        f.textSize = 16f
        return f
    }

    /**
     * Blanks the phrase in place.
     *
     * Best effort, not a guarantee: some copies inevitably pass through
     * immutable Strings on their way to and from the UI. It costs nothing and
     * removes the longest-lived copy, which is the one that would otherwise sit
     * in the heap until GC and show up in a heap dump or an ANR trace.
     */
    private fun clearPhrase() {
        phrase?.fill(' ')
        phrase = null
        for (f in confirmFields) f.setText("")
        for (f in restoreFields) f.setText("")
    }

    companion object {
        private const val TAG = "PCoinSetup"

        /** The app runs PCoin mainnet. */
        private val NETWORK = PcoinDerivation.Network.MAINNET

        private const val CONFIRM_WORDS = 3
        private const val NODE_WAIT_MS = 300_000L

        fun intent(context: Context): Intent = Intent(context, SetupActivity::class.java)
    }
}
