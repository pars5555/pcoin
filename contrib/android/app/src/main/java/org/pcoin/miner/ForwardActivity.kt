package org.pcoin.miner

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import org.json.JSONArray
import org.json.JSONObject
import org.pcoin.miner.wallet.Redact
import org.pcoin.miner.wallet.SeedGate
import org.pcoin.miner.wallet.SeedStore
import java.io.IOException
import kotlin.concurrent.thread

/**
 * Where the user chooses whether mined coins are forwarded, and to where.
 *
 * The field starts EMPTY and staying empty is a complete answer: the app is
 * itself a wallet backed by the twelve words, so coins accumulating here are
 * exactly as recoverable as coins anywhere else. That is stated on screen in
 * those words rather than implied by an absence.
 *
 * Three things happen before an address is accepted, and none of them is
 * optional:
 *
 *  1. The NODE validates it (validateaddress), so a wrong-chain or mistyped
 *     address is rejected with the character position highlighted.
 *  2. The user retypes the last six characters, which catches transcription and
 *     clipboard-hijack errors a checksum cannot see.
 *  3. A device unlock, bound to a Keystore key, gates the change itself.
 *
 * And then nothing is forwarded anyway until a 1 PCN test payment has confirmed
 * AND the user has said they can see it. A valid address nobody holds the key
 * to accepts coins silently and burns every future reward; a signed-message
 * challenge cannot help, because `verifymessage` in this fork rejects anything
 * that is not P2PKH (common/signmessage.cpp:36) and every modern wallet hands
 * out bech32. A confirmed payment the user can actually see is the only proof
 * available, so it is the one used.
 */
class ForwardActivity : AppCompatActivity() {

    private lateinit var prefs: Prefs
    private lateinit var seedStore: SeedStore
    private lateinit var gate: SeedGate
    private lateinit var node: NodeController

    private lateinit var intro: TextView
    private lateinit var currentState: TextView
    private lateinit var addressField: EditText
    private lateinit var confirmField: EditText
    private lateinit var confirmLabel: TextView
    private lateinit var status: TextView
    private lateinit var saveButton: Button
    private lateinit var stopButton: Button
    private lateinit var clearRecordButton: Button
    private lateinit var noLockWarning: TextView

    private val ui = Handler(Looper.getMainLooper())

    /** True when a device unlock can actually gate this change. */
    private var gateAvailable = false

    /**
     * Set when the device-lock question could not be answered at all.
     *
     * Deliberately NOT the same as "this device has no lock screen". An
     * unanswerable query is an unknown, and quietly picking the weaker path on
     * an unknown is a security control degrading in silence -- so this refuses
     * the change outright, exactly as SeedGate's own doctrine requires.
     */
    private var lockCheckFailed: String? = null

    private var working = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_forward)

        prefs = Prefs(this)
        seedStore = SeedStore(this)
        gate = SeedGate(this)
        node = NodeController(this)

        intro = findViewById(R.id.forward_intro)
        currentState = findViewById(R.id.forward_current)
        addressField = findViewById(R.id.forward_address_field)
        confirmField = findViewById(R.id.forward_confirm_field)
        confirmLabel = findViewById(R.id.forward_confirm_label)
        status = findViewById(R.id.forward_status)
        saveButton = findViewById(R.id.forward_save)
        stopButton = findViewById(R.id.forward_stop)
        clearRecordButton = findViewById(R.id.forward_clear_record)
        noLockWarning = findViewById(R.id.forward_no_lock)

        saveButton.setOnClickListener { submit() }
        stopButton.setOnClickListener { stopForwarding() }
        clearRecordButton.setOnClickListener { clearStuckRecord() }
        findViewById<Button>(R.id.forward_close).setOnClickListener { finish() }

        // Validation needs a node to ask. Bring one up without switching mining
        // on -- that flag is the user's own persisted choice and this screen
        // has no business writing it.
        MinerService.prepare(this)

        gateAvailable = try {
            val hasLock = SeedGate.deviceLockAvailable(this)
            // The gate is only real if there is also a Keystore-backed key to
            // bind it to. On an install that predates recovery phrases there is
            // no stored phrase and therefore no such key, so the prompt would
            // be theatre and the screen says so instead of showing one.
            hasLock && seedStore.exists()
        } catch (e: SeedGate.LockCheckFailed) {
            lockCheckFailed = e.message
            false
        }

        render()
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (gate.onActivityResult(requestCode, resultCode)) return
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
    }

    override fun onPause() {
        super.onPause()
        gate.cancel()
    }

    // ------------------------------------------------------------------ render

    private fun render() {
        val address = prefs.forwardAddress
        val state = prefs.forwardState

        intro.setText(R.string.forward_intro)

        currentState.text = when {
            address == null -> getString(R.string.forward_current_holding)
            state == ForwardState.PROBING_PENDING ->
                getString(R.string.forward_current_probe_pending, address)
            state == ForwardState.PROBING_SENT ->
                getString(R.string.forward_current_probe_sent, address)
            state == ForwardState.ARMED -> getString(R.string.forward_current_armed, address)
            else -> getString(R.string.forward_current_holding)
        }

        stopButton.visibility = if (address == null) View.GONE else View.VISIBLE
        clearRecordButton.visibility =
            if (prefs.forwardSweepRecordJson == null) View.GONE else View.VISIBLE

        when {
            lockCheckFailed != null -> {
                noLockWarning.text = getString(R.string.forward_lock_unknown, lockCheckFailed)
                noLockWarning.visibility = View.VISIBLE
                addressField.isEnabled = false
                confirmField.isEnabled = false
                saveButton.isEnabled = false
            }
            !gateAvailable -> {
                // No screen lock, or no Keystore key to bind one to. The change
                // cannot be gated, so the confirmation is made stronger instead:
                // the WHOLE address has to be typed twice, not just its tail.
                noLockWarning.setText(R.string.forward_no_lock)
                noLockWarning.visibility = View.VISIBLE
                confirmLabel.setText(R.string.forward_confirm_full_label)
            }
            else -> {
                noLockWarning.visibility = View.GONE
                confirmLabel.setText(R.string.forward_confirm_label)
            }
        }
    }

    // ------------------------------------------------------------------ submit

    private fun submit() {
        if (working) return
        status.text = ""

        val typed = ForwardPolicy.normalizeAddress(addressField.text.toString())
        if (typed.isEmpty()) {
            status.text = ForwardPolicy.AddressVerdict.EMPTY.message
            return
        }
        if (typed == prefs.forwardAddress) {
            status.setText(R.string.forward_unchanged)
            return
        }

        // The confirmation is checked before the node is even asked: it costs
        // nothing and it is the check that catches a swapped clipboard.
        val confirmation = confirmField.text.toString().trim()
        val confirmationOk = if (gateAvailable) {
            ForwardPolicy.confirmationMatches(typed, confirmation)
        } else {
            confirmation.equals(typed, ignoreCase = false)
        }
        if (!confirmationOk) {
            status.text = if (gateAvailable) {
                ForwardPolicy.AddressVerdict.CONFIRMATION_MISMATCH.message
            } else {
                getString(R.string.forward_confirm_full_mismatch)
            }
            return
        }

        working = true
        saveButton.isEnabled = false
        status.setText(R.string.forward_checking)

        // The node round trip must not block the UI thread.
        thread(name = "pcoin-forward-validate", isDaemon = true) {
            val outcome = try {
                validate(typed)
            } catch (t: Throwable) {
                Outcome(null, getString(R.string.forward_node_unreachable, Redact.text(t)))
            }
            ui.post {
                working = false
                saveButton.isEnabled = true
                val verdict = outcome.verdict
                if (verdict == null || verdict != ForwardPolicy.AddressVerdict.OK) {
                    status.text = outcome.detail.ifBlank { verdict?.message.orEmpty() }
                    return@post
                }
                // The node's own encoding, not the typed string: see Outcome.
                authorizeAndStore(outcome.canonical.ifBlank { typed })
            }
        }
    }

    private data class Outcome(
        val verdict: ForwardPolicy.AddressVerdict?,
        val detail: String = "",
        /**
         * `validateaddress.address` -- the node's own re-encoding of what was
         * typed, which is what gets stored.
         *
         * The typed string is not necessarily how the node will render this
         * address back to us. An all-uppercase bech32 address is the case that
         * bites: it validates, but every address the node reports is lower
         * case, so a stored uppercase destination would never equal the address
         * in the decoded transaction and every build would abort on assertion
         * (b) -- forever, with a cryptic message. Storing the node's own form
         * removes the whole class.
         */
        val canonical: String = "",
    )

    /**
     * Asks the node. validateaddress is node-level, so it works even with no
     * wallet loaded; getaddressinfo is wallet-scoped and is aimed at the PAYOUT
     * wallet specifically, because asking the wrong wallet whether it owns an
     * address gets a confident, authoritative-looking "no".
     */
    private fun validate(address: String): Outcome {
        val rpc = node.rpc
        val v = rpc.call("validateaddress", JSONArray().put(address), readTimeoutMs = RPC_TIMEOUT_MS)
            as? JSONObject ?: return Outcome(null, getString(R.string.forward_node_unreachable, "no answer"))

        if (!v.optBoolean("isvalid", false)) {
            // error_locations turns "invalid address" into "character 14 looks
            // wrong", which is the difference between a user fixing a typo and
            // a user giving up.
            val where = v.optJSONArray("error_locations")
            val positions = (0 until (where?.length() ?: 0)).map { where!!.optInt(it) + 1 }
            val detail = buildString {
                append(v.optString("error").ifBlank { ForwardPolicy.AddressVerdict.MALFORMED.message })
                if (positions.isNotEmpty()) {
                    append(getString(R.string.forward_error_positions, positions.joinToString(", ")))
                }
            }
            return Outcome(ForwardPolicy.AddressVerdict.MALFORMED, detail)
        }

        val isMine = try {
            (rpc.call(
                "getaddressinfo",
                JSONArray().put(address),
                wallet = prefs.payoutWallet,
                readTimeoutMs = RPC_TIMEOUT_MS,
            ) as? JSONObject)?.optBoolean("ismine", false) == true
        } catch (e: IOException) {
            // Could not ask. That is not evidence that the address is not ours,
            // and forwarding to our own wallet only burns fees -- so refuse
            // rather than guess.
            return Outcome(null, getString(R.string.forward_node_unreachable, Redact.text(e.message)))
        }

        val facts = ForwardPolicy.AddressFacts(
            isValid = true,
            isWitness = v.optBoolean("iswitness", false),
            witnessVersion = v.optInt("witness_version", 0),
            isMine = isMine,
            nodeError = v.optString("error"),
            scriptPubKey = v.optString("scriptPubKey"),
        )
        val verdict = ForwardPolicy.checkAddress(address, facts, confirmTail = null)
        // Fall back to what was typed only if the node returned no address
        // field at all; it always does for a valid one.
        val canonical = v.optString("address").ifBlank { address }
        return Outcome(verdict, verdict.message, canonical)
    }

    /**
     * The device unlock, then the write.
     *
     * The unlock is bound to a Keystore key rather than being a boolean: the
     * same key and the same prompt that stand in front of the recovery phrase.
     * A prompt with nothing behind it would be theatre, which is why the
     * ungated path below is only reached when the screen has already said, in
     * plain words, that nothing can gate this change.
     */
    private fun authorizeAndStore(address: String) {
        if (lockCheckFailed != null) {
            status.text = getString(R.string.forward_lock_unknown, lockCheckFailed)
            return
        }
        if (!gateAvailable) {
            store(address)
            return
        }
        gate.authorize(
            title = getString(R.string.forward_gate_title),
            subtitle = getString(R.string.forward_gate_subtitle),
            gated = true,
            // beginRead() inside the lambda, not before it: on API 24..29 the
            // Cipher.init inside it is exactly what throws
            // UserNotAuthenticatedException, and SeedGate re-runs prepare after
            // the unlock. Nothing is decrypted -- the PendingRead is discarded.
            prepare = { seedStore.beginRead().cipher },
            callback = object : SeedGate.Callback {
                override fun onAuthenticated() = store(address)

                override fun onFailed(reason: String, cancelled: Boolean) {
                    status.setText(
                        if (cancelled) R.string.forward_gate_cancelled else R.string.forward_gate_failed
                    )
                }
            },
        )
    }

    /**
     * Writes the user's intent.
     *
     * If a transaction is in flight the new address is QUEUED rather than
     * applied: the in-flight transaction pays the old address and has to be
     * allowed to complete. A destination cannot be reasoned about halfway
     * through a send.
     *
     * The whole decision runs under [ForwardEngine.INTENT_LOCK], because "is
     * something in flight" and the write that answers it have to be one step.
     * The engine reads the address at the top of an evaluation and can spend a
     * minute inside `sendall` before any record exists; without the lock this
     * would see no record, overwrite the address, and let that build pay the
     * old one. Holding it costs a SharedPreferences commit and never touches
     * the network.
     */
    private fun store(address: String) {
        val queued = synchronized(ForwardEngine.INTENT_LOCK) {
            val inFlight = prefs.forwardSweepRecordJson != null
            if (inFlight) {
                prefs.forwardPendingAddress = address
            } else {
                prefs.forwardAddress = address
                prefs.forwardPendingAddress = null
                // Every change re-probes, including a change made by someone who
                // picked up an unlocked phone: a swapped address cannot receive a
                // full sweep until a test payment has been acknowledged.
                prefs.forwardProbeTxid = null
                prefs.forwardProbeAcked = false
                prefs.forwardProbeConfirmed = false
                prefs.forwardState = ForwardState.PROBING_PENDING
            }
            inFlight
        }
        status.setText(if (queued) R.string.forward_saved_queued else R.string.forward_saved)
        prefs.forwardLastError = null
        addressField.setText("")
        confirmField.setText("")
        // Evaluate now rather than at the next block -- to RECONCILE and
        // re-validate, never to send early: every precondition still applies.
        //
        // A full reconcile, not just an evaluation: this is the first moment an
        // install that was wiped while a send was in flight has any reason to
        // look for one, and bring-up skipped that check because a wiped install
        // is indistinguishable from one that never used forwarding.
        ForwardEngine.requestReconcile()
        render()
    }

    /**
     * Back to holding. Not gated: turning forwarding OFF cannot lose money.
     *
     * Under the same lock as [store]: without it a sweep already past its own
     * intent re-read still goes out afterwards, which reads as a kill switch
     * that does not work. A transaction that IS already committed still runs to
     * a conclusion -- that is deliberate, and it is why the record is checked
     * before the user's state everywhere in the engine.
     */
    private fun stopForwarding() {
        synchronized(ForwardEngine.INTENT_LOCK) {
            prefs.forwardAddress = null
            prefs.forwardPendingAddress = null
            prefs.forwardProbeTxid = null
            prefs.forwardProbeAcked = false
            prefs.forwardProbeConfirmed = false
            prefs.forwardState = ForwardState.HOLDING
        }
        prefs.forwardLastError = null
        ForwardEngine.requestEvaluation()
        status.setText(R.string.forward_stopped)
        render()
    }

    /**
     * The manual escape hatch for a record that can no longer be resolved.
     *
     * Behind the unlock gate because it is the one action that can let a second
     * transaction be built over the same coins. It exists because the automatic
     * path deliberately never rebuilds: a stuck transaction that needs a human
     * is rare, and turning it into two paid transactions automatically would be
     * far worse than asking.
     */
    private fun clearStuckRecord() {
        val act = {
            prefs.forwardSweepRecordJson = null
            prefs.forwardLastError = null
            ForwardEngine.requestEvaluation()
            status.setText(R.string.forward_record_cleared)
            render()
        }
        if (!gateAvailable) {
            act()
            return
        }
        gate.authorize(
            title = getString(R.string.forward_gate_title),
            subtitle = getString(R.string.forward_clear_gate_subtitle),
            gated = true,
            prepare = { seedStore.beginRead().cipher },
            callback = object : SeedGate.Callback {
                override fun onAuthenticated() {
                    act()
                }

                override fun onFailed(reason: String, cancelled: Boolean) {
                    status.setText(
                        if (cancelled) R.string.forward_gate_cancelled else R.string.forward_gate_failed
                    )
                }
            },
        )
    }

    companion object {
        private const val RPC_TIMEOUT_MS = 20_000

        fun intent(context: Context): Intent = Intent(context, ForwardActivity::class.java)
    }
}
