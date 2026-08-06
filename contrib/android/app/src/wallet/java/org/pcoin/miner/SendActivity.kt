package org.pcoin.miner

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity

/**
 * Send PCoin.
 *
 * Two steps, and the split is the point:
 *
 *   COMPOSE  address + amount, or All.
 *   REVIEW   the node BUILDS the transaction and we show what it actually
 *            contains -- amount, fee, total. Nothing is broadcast.
 *   RESULT   only after an explicit second press.
 *
 * Building is free and leaves no trace: the node is asked with
 * `add_to_wallet = false`, so it signs and hands back bytes without recording
 * anything. Backing out of the review costs nothing and locks nothing.
 *
 * Everything the user is shown at review comes from DECODING the built
 * transaction, never from what they typed. The fee in particular cannot be known
 * any other way -- it is inputs minus outputs, and both sides have to be
 * observed. That is why there is no "estimated fee" on the compose step: an
 * estimate there would be a guess, and this screen does not guess about money.
 *
 * All RPC happens on a background thread. Failures are shown verbatim and
 * resolve nothing: a send that could not be checked is never treated as a send
 * that is fine.
 */
class SendActivity : AppCompatActivity() {

    private lateinit var prefs: Prefs
    private val ui = Handler(Looper.getMainLooper())

    private lateinit var available: TextView
    private lateinit var composeCard: LinearLayout
    private lateinit var addressField: EditText
    private lateinit var amountField: EditText
    private lateinit var maxButton: Button
    private lateinit var composeError: TextView
    private lateinit var reviewButton: Button

    private lateinit var reviewCard: LinearLayout
    private lateinit var reviewTo: TextView
    private lateinit var reviewAmount: TextView
    private lateinit var reviewFee: TextView
    private lateinit var reviewTotal: TextView
    private lateinit var reviewError: TextView
    private lateinit var confirmButton: Button
    private lateinit var backButton: Button

    private lateinit var resultCard: LinearLayout
    private lateinit var resultTitle: TextView
    private lateinit var resultBody: TextView
    private lateinit var resultTxid: TextView
    private lateinit var doneButton: Button

    private var sendMax = false
    private var prepared: ForwardEngine.Prepared? = null
    private var busy = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        setContentView(R.layout.activity_send)

        available = findViewById(R.id.send_available)
        composeCard = findViewById(R.id.compose_card)
        addressField = findViewById(R.id.address_field)
        amountField = findViewById(R.id.amount_field)
        maxButton = findViewById(R.id.max_button)
        composeError = findViewById(R.id.compose_error)
        reviewButton = findViewById(R.id.review_button)

        reviewCard = findViewById(R.id.review_card)
        reviewTo = findViewById(R.id.review_to)
        reviewAmount = findViewById(R.id.review_amount)
        reviewFee = findViewById(R.id.review_fee)
        reviewTotal = findViewById(R.id.review_total)
        reviewError = findViewById(R.id.review_error)
        confirmButton = findViewById(R.id.confirm_button)
        backButton = findViewById(R.id.back_button)

        resultCard = findViewById(R.id.result_card)
        resultTitle = findViewById(R.id.result_title)
        resultBody = findViewById(R.id.result_body)
        resultTxid = findViewById(R.id.result_txid)
        doneButton = findViewById(R.id.done_button)

        maxButton.setOnClickListener { toggleMax() }
        reviewButton.setOnClickListener { onReview() }
        confirmButton.setOnClickListener { onConfirm() }
        // Same guard as onBackPressed, and for the same reason. Guarding the
        // hardware button but not the on-screen one left the only route by which
        // this screen can pay twice: showCompose() nulls `prepared`, so a
        // recompose builds DIFFERENT bytes over different inputs, and the
        // already-sent detection in broadcastPrepared -- which keys on the exact
        // prepared transaction -- can never fire for the first one.
        backButton.setOnClickListener {
            if (busy) {
                Toast.makeText(this, R.string.send_busy_back, Toast.LENGTH_SHORT).show()
            } else {
                showCompose()
            }
        }
        doneButton.setOnClickListener { finish() }

        renderAvailable()
    }

    /**
     * Back is refused while a broadcast is in flight.
     *
     * The transaction may already be on the network by the time the press
     * lands; leaving now means the only place the txid was going to appear is
     * gone. It is a second or two of being unable to leave, against not knowing
     * whether your money moved.
     */
    @Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
    override fun onBackPressed() {
        if (busy) {
            Toast.makeText(this, R.string.send_busy_back, Toast.LENGTH_SHORT).show()
            return
        }
        super.onBackPressed()
    }

    override fun onResume() {
        super.onResume()
        renderAvailable()
    }

    private fun renderAvailable() {
        val s = MinerState.snapshot
        available.text =
            if (s.balanceIsTrustworthy && s.balanceConfirmed >= 0.0)
                getString(R.string.send_available, Fmt.coins(s.balanceConfirmed))
            else getString(R.string.send_available_unknown)
    }

    private fun toggleMax() {
        sendMax = !sendMax
        amountField.isEnabled = !sendMax
        amountField.alpha = if (sendMax) 0.4f else 1f
        if (sendMax) amountField.setText("")
        maxButton.alpha = if (sendMax) 1f else 0.75f
    }

    // ------------------------------------------------------------------ compose

    private fun onReview() {
        if (busy) return
        composeError.visibility = View.GONE

        val addr = addressField.text?.toString()?.trim().orEmpty()
        if (addr.isEmpty()) return composeFail(getString(R.string.send_err_no_address))

        // Refuse to send while the chain is behind. A partly-synced node has an
        // incomplete view of which coins exist, so both the balance and the
        // input selection would be built on a half-truth -- and a node that has
        // just restarted at height 0 would see no coins at all.
        if (!MinerState.snapshot.balanceIsTrustworthy) {
            return composeFail(getString(R.string.send_err_syncing))
        }

        var amountSat = 0L
        if (!sendMax) {
            when (val p = Amounts.parse(amountField.text?.toString())) {
                is Amounts.Parsed.Ok -> amountSat = p.sat
                is Amounts.Parsed.Bad -> return composeFail(
                    when (p.why) {
                        Amounts.Reason.EMPTY -> getString(R.string.send_err_amount_empty)
                        Amounts.Reason.NOT_A_NUMBER -> getString(R.string.send_err_amount_bad)
                        Amounts.Reason.TOO_MANY_DECIMALS -> getString(R.string.send_err_amount_decimals)
                        Amounts.Reason.NEGATIVE -> getString(R.string.send_err_amount_negative)
                        Amounts.Reason.ZERO -> getString(R.string.send_err_amount_zero)
                        Amounts.Reason.TOO_LARGE -> getString(R.string.send_err_amount_huge)
                        Amounts.Reason.DUST -> getString(R.string.send_err_amount_dust)
                    }
                )
            }
            if (Amounts.isDust(amountSat)) return composeFail(getString(R.string.send_err_amount_dust))
        }

        busy = true
        reviewButton.isEnabled = false
        reviewButton.alpha = 0.6f
        reviewButton.text = getString(R.string.send_preparing)

        val wallet = prefs.payoutWallet
        Thread {
            var built: ForwardEngine.Prepared? = null
            var err: String? = null
            try {
                built = MinerService.engine()?.prepareSend(addr, amountSat, sendMax, wallet)
                    ?: throw ForwardEngine.SendRefused("The wallet service is not running yet.")
            } catch (e: Exception) {
                err = e.message ?: e.javaClass.simpleName
            }
            val f = built
            ui.post {
                busy = false
                reviewButton.isEnabled = true
                reviewButton.alpha = 1f
                reviewButton.text = getString(R.string.send_review)
                if (f == null) composeFail(err ?: "Could not prepare the payment.")
                else showReview(f)
            }
        }.start()
    }

    private fun composeFail(msg: String) {
        composeError.text = msg
        composeError.visibility = View.VISIBLE
    }

    // ------------------------------------------------------------------- review

    private fun showCompose() {
        prepared = null
        composeCard.visibility = View.VISIBLE
        reviewCard.visibility = View.GONE
        resultCard.visibility = View.GONE
    }

    private fun showReview(p: ForwardEngine.Prepared) {
        prepared = p
        composeCard.visibility = View.GONE
        reviewCard.visibility = View.VISIBLE
        resultCard.visibility = View.GONE
        reviewError.visibility = View.GONE

        reviewTo.text = p.destination
        reviewAmount.text = getString(R.string.send_review_amount, Fmt.coinsSat(p.paidSat))
        reviewFee.text = getString(R.string.send_review_fee, Fmt.coinsSat(p.feeSat))
        reviewTotal.text =
            if (p.sendMax) getString(R.string.send_review_all)
            else getString(R.string.send_review_total, Fmt.coinsSat(p.paidSat + p.feeSat))
    }

    private fun onConfirm() {
        val p = prepared ?: return
        if (busy) return
        busy = true
        reviewError.visibility = View.GONE
        confirmButton.isEnabled = false
        confirmButton.alpha = 0.6f
        confirmButton.text = getString(R.string.send_sending)

        Thread {
            var txid: String? = null
            var err: String? = null
            try {
                txid = MinerService.engine()?.broadcastPrepared(p)
                    ?: throw ForwardEngine.SendRefused("The wallet service is not running yet.")
            } catch (e: Exception) {
                err = e.message ?: e.javaClass.simpleName
            }
            val t = txid
            ui.post {
                busy = false
                confirmButton.isEnabled = true
                confirmButton.alpha = 1f
                confirmButton.text = getString(R.string.send_confirm)
                if (t == null) {
                    // Stay on review. The prepared bytes are still valid and the
                    // user can try again without retyping anything.
                    reviewError.text = err ?: "Could not send."
                    reviewError.visibility = View.VISIBLE
                } else {
                    showResult(t)
                }
            }
        }.start()
    }

    private fun showResult(txid: String) {
        composeCard.visibility = View.GONE
        reviewCard.visibility = View.GONE
        resultCard.visibility = View.VISIBLE
        resultTitle.text = getString(R.string.send_ok_title)
        resultBody.text = getString(R.string.send_ok_body)
        resultTxid.text = txid
        resultTxid.visibility = View.VISIBLE
    }
}
