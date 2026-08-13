package org.pcoin.miner

import android.app.Activity
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.TextWatcher
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.ScrollView
import android.content.Context
import android.content.Intent
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import org.pcoin.miner.wallet.SeedGate
import org.pcoin.miner.wallet.SeedStore

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
 *
 * THE ADDRESS BOOK TOUCHES THIS SCREEN IN THREE PLACES, AND NONE OF THEM DECIDE
 * ANYTHING. Compose says whether the typed address has a name and offers saved
 * ones to fill the field with; review shows the name for the destination the
 * node actually built, above the address and never instead of it; the result
 * offers to name an address that has just been paid. A name is a note this
 * phone keeps and nothing verifies it -- see [AddressBook].
 */
class SendActivity : AppCompatActivity() {

    private lateinit var prefs: Prefs
    private lateinit var book: AddressBookStore
    private val ui = Handler(Looper.getMainLooper())

    private lateinit var available: TextView
    private lateinit var gateNotice: TextView
    private lateinit var composeCard: LinearLayout
    private lateinit var addressField: EditText
    private lateinit var addressLabel: TextView
    private lateinit var bookBlock: LinearLayout
    private lateinit var bookRows: LinearLayout
    private lateinit var bookScroll: ScrollView
    private lateinit var amountField: EditText
    private lateinit var maxButton: Button
    private lateinit var composeError: TextView
    private lateinit var reviewButton: Button

    private lateinit var reviewCard: LinearLayout
    private lateinit var reviewNamed: TextView
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
    private lateinit var resultTo: TextView
    private lateinit var resultNamed: TextView
    private lateinit var resultTxid: TextView
    private lateinit var saveBlock: LinearLayout
    private lateinit var saveNameField: EditText
    private lateinit var saveError: TextView
    private lateinit var saveButton: Button
    private lateinit var doneButton: Button

    private var sendMax = false
    private var prepared: ForwardEngine.Prepared? = null
    private var busy = false

    /**
     * The destination of the payment shown on the result card.
     *
     * Kept separately from [prepared] because that is nulled when the compose
     * step is shown again, and because this must be the NODE's spelling -- it
     * is what gets stored if the address is named, and storing what was typed
     * would put a differently-cased duplicate in the book.
     */
    private var sentTo: String? = null

    /**
     * The address book, held in a field rather than re-read per lookup.
     *
     * The address field's TextWatcher fires on every keystroke, and each lookup
     * used to load and JSON-parse the whole book on the UI thread -- the exact
     * cost HistoryActivity was already fixed for, reintroduced one screen over.
     * Refreshed in onResume and after any write from this screen, which is the
     * only way it can change while this activity is alive.
     */
    private var bookEntries: List<AddressBook.Entry> = emptyList()

    private lateinit var gate: SeedGate
    private lateinit var seedStore: SeedStore

    /** True when there is both a device lock AND a Keystore key to bind it to. */
    private var gateAvailable = false

    /**
     * Non-null when the platform would not say whether a lock exists.
     *
     * Held separately from `gateAvailable = false` because the two mean opposite
     * things: no lock is a known fact this screen states and works around, while
     * an unanswered query is an unknown that must stop the send.
     */
    private var lockCheckFailed: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        book = AddressBookStore(this)
        setContentView(R.layout.activity_send)

        available = findViewById(R.id.send_available)
        gateNotice = findViewById(R.id.send_gate_notice)
        composeCard = findViewById(R.id.compose_card)
        addressField = findViewById(R.id.address_field)
        addressLabel = findViewById(R.id.address_label)
        bookBlock = findViewById(R.id.book_block)
        bookRows = findViewById(R.id.book_rows)
        bookScroll = findViewById(R.id.book_scroll)
        amountField = findViewById(R.id.amount_field)
        maxButton = findViewById(R.id.max_button)
        composeError = findViewById(R.id.compose_error)
        reviewButton = findViewById(R.id.review_button)

        reviewCard = findViewById(R.id.review_card)
        reviewNamed = findViewById(R.id.review_named)
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
        resultTo = findViewById(R.id.result_to)
        resultNamed = findViewById(R.id.result_named)
        resultTxid = findViewById(R.id.result_txid)
        saveBlock = findViewById(R.id.save_block)
        saveNameField = findViewById(R.id.save_name_field)
        saveError = findViewById(R.id.save_error)
        saveButton = findViewById(R.id.save_button)
        doneButton = findViewById(R.id.done_button)

        // Prefilled when this screen was opened by tapping a name in the
        // address book. It goes in the field like anything else typed or
        // pasted, and takes exactly the same route through validation.
        intent?.getStringExtra(EXTRA_ADDRESS)?.trim()?.takeIf { it.isNotEmpty() }?.let {
            addressField.setText(it)
            amountField.requestFocus()
        }

        addressField.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) = Unit
            override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) = Unit
            override fun afterTextChanged(s: Editable?) = renderAddressLabel()
        })
        // Guarded on `busy` like every other control that can change the
        // compose step. Without it a pick could land after showReview had run,
        // leaving the hidden compose field disagreeing with the reviewed
        // destination -- harmless for where the money goes, since Confirm
        // broadcasts `prepared`, but a confusing thing to come back to.
        // The saved-address list scrolls inside a page that also scrolls. Without
        // this the outer ScrollView intercepts the drag and the inner list never
        // moves, which reads as a frozen list. Returning false leaves the inner
        // ScrollView to handle the gesture as normal.
        @Suppress("ClickableViewAccessibility")
        bookScroll.setOnTouchListener { v, _ ->
            v.parent?.requestDisallowInterceptTouchEvent(true)
            false
        }
        findViewById<ImageButton>(R.id.scan_button).setOnClickListener {
            if (busy) return@setOnClickListener
            startActivityForResult(ScanActivity.intent(this), REQUEST_SCAN)
        }
        saveButton.setOnClickListener { saveName() }

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

        seedStore = SeedStore(this)
        gate = SeedGate(this)
        gateAvailable = try {
            // Both halves are required. A device lock with no Keystore-backed
            // key behind it gives a prompt that gates nothing, and this screen
            // says so rather than showing one.
            SeedGate.deviceLockAvailable(this) && seedStore.exists()
        } catch (e: SeedGate.LockCheckFailed) {
            lockCheckFailed = e.message
            false
        }

        renderAvailable()
        renderGateNotice()
        reloadBook()
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        // Checked before the gate, with a request code of its own: swallowing
        // one of SeedGate's codes here would leave a completed device unlock
        // with nothing listening, and the payment would silently never send.
        if (requestCode == REQUEST_SCAN) {
            if (resultCode == Activity.RESULT_OK) {
                onScanned(data?.getStringExtra(ScanActivity.EXTRA_TEXT))
            }
            return
        }
        // The API 24..29 path returns through here; without this the credential
        // confirmation completes and nothing ever hears about it.
        if (gate.onActivityResult(requestCode, resultCode)) return
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
    }

    /**
     * launchMode is singleTop, so an intent aimed at an instance that already
     * exists arrives here instead of at onCreate. Prefill has to be handled in
     * both places, or tapping a name would open a send screen still holding the
     * address from last time.
     *
     * Refused outright while a broadcast is in flight, for the same reason Back
     * is: nothing may re-target a payment that is already on its way.
     */
    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        setIntent(intent)
        // `busy` alone is not enough: it is false while the device-unlock
        // prompt is up, and it is false on the result card. Refusing whenever
        // the compose step is not the thing on screen covers both, and stops a
        // new address quietly throwing away a review the user is reading.
        if (busy) return
        if (reviewCard.visibility == View.VISIBLE || resultCard.visibility == View.VISIBLE) return
        val address = intent?.getStringExtra(EXTRA_ADDRESS)?.trim().orEmpty()
        if (address.isEmpty()) return
        showCompose()
        fillAddress(address)
    }

    override fun onResume() {
        super.onResume()
        renderAvailable()
        // The book can have changed while this screen was in the background --
        // a name added from the address book, or removed there.
        reloadBook()
    }

    // -------------------------------------------------------------- the book

    /** Re-read the book and redraw everything that depends on it. */
    private fun reloadBook() {
        bookEntries = book.load()
        renderBook()
        renderAddressLabel()
        if (resultCard.visibility == View.VISIBLE) renderSaveBlock()
    }

    /**
     * Says whether the address in the field has a name, in both directions.
     *
     * The negative case is deliberate. Someone who pastes what they believe is
     * a saved address and sees nothing has learned something worth knowing --
     * a clipboard that handed over a different address than the one that was
     * copied is a real attack, and silence is what makes it work. It is stated
     * only once the field holds something long enough to be an address, so it
     * does not accuse a half-typed one.
     */
    private fun renderAddressLabel() {
        val typed = addressField.text?.toString()?.trim().orEmpty()
        val name = AddressBook.labelFor(bookEntries, typed)
        when {
            name != null -> {
                addressLabel.text = getString(R.string.send_known_address, name)
                addressLabel.setTextColor(getColorCompat(R.color.brand))
                addressLabel.visibility = View.VISIBLE
            }
            typed.length >= AddressBook.LOOKS_LIKE_ADDRESS -> {
                addressLabel.setText(R.string.send_unknown_address)
                addressLabel.setTextColor(getColorCompat(R.color.ink_muted))
                addressLabel.visibility = View.VISIBLE
            }
            else -> addressLabel.visibility = View.GONE
        }
    }

    /**
     * Every saved address, tappable, most recently used first.
     *
     * All of them, not a preview: paying someone already named is the common
     * case, and it should never cost a screen change. The list keeps its natural
     * height while it is short and becomes a scroller once it would push the
     * amount box and the review button too far down the page.
     */
    private fun renderBook() {
        val entries = AddressBook.ordered(bookEntries)
        bookRows.removeAllViews()
        if (entries.isEmpty()) {
            bookBlock.visibility = View.GONE
            return
        }
        bookBlock.visibility = View.VISIBLE

        val inflater = LayoutInflater.from(this)
        for (e in entries) {
            val v = inflater.inflate(R.layout.row_book_pick, bookRows, false)
            v.findViewById<TextView>(R.id.pick_name).text = e.name
            v.findViewById<TextView>(R.id.pick_address).text = e.address
            v.setOnClickListener { fillAddress(e.address) }
            bookRows.addView(v)
        }

        // Clamp in code, not in the layout: a fixed height would leave a short
        // list sitting in a half-empty box, and wrap_content alone would let a
        // long one run off the bottom of the card.
        val lp = bookScroll.layoutParams
        lp.height =
            if (entries.size > VISIBLE_BOOK_ROWS) (BOOK_MAX_HEIGHT_DP * resources.displayMetrics.density).toInt()
            else ViewGroup.LayoutParams.WRAP_CONTENT
        bookScroll.layoutParams = lp
    }

    /**
     * A QR was decoded. It fills fields; it decides nothing.
     *
     * [PaymentUri] says whether the text is a payment at all. A code that is
     * not one is reported and dropped rather than half-applied -- putting a URL
     * into the address box would only produce a confusing failure two steps
     * later, at the node.
     *
     * An amount is filled in when the code states one readably, and announced,
     * because money that appeared without being typed deserves to be pointed
     * at. When the code states no amount, or one that cannot be read, the box
     * is left ALONE rather than zeroed: an untouched field is a question the
     * user answers, a zero is an answer nobody gave.
     */
    private fun onScanned(text: String?) {
        val target = PaymentUri.parse(text)
        if (target == null) {
            composeError.setText(R.string.scan_not_payment)
            composeError.visibility = View.VISIBLE
            return
        }
        fillAddress(target.address)
        target.amountSat?.let { sat ->
            if (sendMax) toggleMax()          // an explicit amount contradicts "All"
            amountField.setText(Amounts.toPlainString(sat))
            Toast.makeText(
                this,
                getString(R.string.scan_filled_amount, Fmt.coinsSat(sat)),
                Toast.LENGTH_LONG,
            ).show()
        }
    }

    /** Fills the address field and moves on to the amount. Sends nothing. */
    private fun fillAddress(address: String) {
        addressField.setText(address)
        addressField.setSelection(address.length)
        composeError.visibility = View.GONE
        renderAddressLabel()
        if (!sendMax) amountField.requestFocus()
    }

    /**
     * Says, before the user commits to anything, whether this send can be
     * gated at all. Stating it up front rather than at the moment of confirming
     * is deliberate: it is a property of the phone, not of this payment.
     */
    private fun renderGateNotice() {
        val text = when {
            lockCheckFailed != null -> getString(R.string.send_lock_unknown, lockCheckFailed)
            !gateAvailable -> getString(R.string.send_gate_unavailable)
            else -> null
        }
        gateNotice.text = text.orEmpty()
        gateNotice.visibility = if (text == null) View.GONE else View.VISIBLE
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

        // Looked up against p.destination -- what the node put in the
        // transaction -- and not against what was typed. Those differ whenever
        // the address was entered in another case, and a name shown here has to
        // be the name of the address the money is actually going to.
        val name = AddressBook.labelFor(bookEntries, p.destination)
        reviewNamed.text = if (name == null) "" else getString(R.string.send_review_named, name)
        reviewNamed.visibility = if (name == null) View.GONE else View.VISIBLE

        reviewTo.text = p.destination
        reviewAmount.text = getString(R.string.send_review_amount, Fmt.coinsSat(p.paidSat))
        reviewFee.text = getString(R.string.send_review_fee, Fmt.coinsSat(p.feeSat))
        reviewTotal.text =
            if (p.sendMax) getString(R.string.send_review_all)
            else getString(R.string.send_review_total, Fmt.coinsSat(p.paidSat + p.feeSat))
    }

    /**
     * Device unlock, then broadcast.
     *
     * The action that moves the coins gets at least the protection that
     * READING the recovery phrase already has. Without this, the Keystore work
     * guarded a convenience copy of twelve words while anyone who got the phone
     * past its lock screen once could tap Send, All, Confirm.
     *
     * Three states, and the difference between the last two is the point:
     *
     *   gate available     prompt, and broadcast only on success.
     *   no device lock     broadcast, having said plainly on screen that
     *                      nothing can gate it. A prompt with nothing behind it
     *                      is theatre, and refusing outright would brick sending
     *                      on a phone with no PIN.
     *   lock check FAILED  refuse. "I could not ask whether this device has a
     *                      lock" is not "it has none" -- silently taking the
     *                      ungated path on an unknown is a security control
     *                      degrading without anyone noticing.
     *
     * Same shape as ForwardActivity.authorizeAndStore, deliberately: changing
     * where coins go and actually sending them deserve the same treatment.
     */
    private fun onConfirm() {
        if (prepared == null || busy) return

        lockCheckFailed?.let {
            reviewError.text = getString(R.string.send_lock_unknown, it)
            reviewError.visibility = View.VISIBLE
            return
        }
        if (!gateAvailable) {
            broadcast()
            return
        }

        reviewError.visibility = View.GONE
        gate.authorize(
            title = getString(R.string.send_gate_title),
            subtitle = getString(R.string.send_gate_subtitle),
            gated = true,
            // beginRead() inside the lambda, not before: on API 24..29 the
            // Cipher.init inside it is what throws UserNotAuthenticatedException
            // and SeedGate re-runs prepare after the unlock. Nothing is
            // decrypted -- the phrase is not needed to send, the node holds the
            // keys. This is the Keystore being used purely as an authorisation
            // token, which is exactly what ForwardActivity does.
            prepare = { seedStore.beginRead().cipher },
            callback = object : SeedGate.Callback {
                override fun onAuthenticated() = broadcast()

                override fun onFailed(reason: String, cancelled: Boolean) {
                    reviewError.setText(
                        if (cancelled) R.string.send_gate_cancelled else R.string.send_gate_failed
                    )
                    reviewError.visibility = View.VISIBLE
                }
            },
        )
    }

    private fun broadcast() {
        val p = prepared
        if (p == null) {
            // A completed device unlock must never end in silence. I could not
            // construct a path that reaches this -- the only thing that nulls
            // `prepared` is showCompose(), which cannot run while the gate is
            // up -- but a bare `return` here fails in the worst direction: the
            // user unlocked, nothing happened, and nothing said so.
            reviewError.setText(R.string.send_not_ready)
            reviewError.visibility = View.VISIBLE
            return
        }
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
                    showResult(t, p.destination)
                }
            }
        }.start()
    }

    private fun showResult(txid: String, destination: String) {
        composeCard.visibility = View.GONE
        reviewCard.visibility = View.GONE
        resultCard.visibility = View.VISIBLE
        resultTitle.text = getString(R.string.send_ok_title)
        resultBody.text = getString(R.string.send_ok_body)
        resultTxid.text = txid
        resultTxid.visibility = View.VISIBLE

        sentTo = destination
        saveNameField.setText("")
        saveError.visibility = View.GONE

        // The address is shown here, not only on the review step. This card
        // asks for a name, and a name typed against a destination that is off
        // screen is the mislabelling rule 1 in AddressBook.kt exists to stop.
        resultTo.text = getString(R.string.send_result_to, destination)
        resultTo.visibility = View.VISIBLE

        // Ordering only, and only for an address that already has a name --
        // touch() never creates an entry, so a send to an unnamed address
        // leaves the book exactly as it was.
        book.touch(destination)
        reloadBook()
    }

    /**
     * Either "you paid Market", or the offer to name the address.
     *
     * Asked here rather than before the send: the payment is done, the node has
     * accepted the address, and the person still knows who they were paying.
     * One more field in front of the money would have been the wrong trade.
     */
    private fun renderSaveBlock() {
        val to = sentTo
        val name = AddressBook.labelFor(bookEntries, to)
        if (name != null) {
            resultNamed.text = getString(R.string.send_paid_named, name)
            resultNamed.visibility = View.VISIBLE
            saveBlock.visibility = View.GONE
            return
        }
        resultNamed.visibility = View.GONE
        saveBlock.visibility = if (to == null) View.GONE else View.VISIBLE
    }

    private fun saveName() {
        val to = sentTo ?: return
        val typed = saveNameField.text?.toString()
        val problem = AddressBook.nameProblem(typed, bookEntries)
        if (problem != null) {
            saveError.text = when (problem) {
                AddressBook.NameProblem.EMPTY -> getString(R.string.book_err_empty)
                AddressBook.NameProblem.TOO_LONG ->
                    getString(R.string.book_err_long, AddressBook.MAX_NAME)
                AddressBook.NameProblem.DUPLICATE -> getString(R.string.book_err_duplicate)
                AddressBook.NameProblem.BOOK_FULL ->
                    getString(R.string.book_err_full, AddressBook.MAX_ENTRIES)
            }
            saveError.visibility = View.VISIBLE
            return
        }

        val clean = AddressBook.cleanName(typed)
        saveError.visibility = View.GONE
        book.put(to, clean)
        // Straight to lastUsed: this address was paid a moment ago, so it
        // belongs at the top of the list next time, not at the bottom.
        book.touch(to)
        Toast.makeText(this, getString(R.string.send_saved_confirmation, clean), Toast.LENGTH_SHORT)
            .show()
        reloadBook()
    }

    @Suppress("DEPRECATION")
    private fun getColorCompat(id: Int): Int = resources.getColor(id, theme)

    companion object {
        private const val EXTRA_ADDRESS = "org.pcoin.miner.extra.SEND_TO"

        /**
         * Distinct from SeedGate's REQUEST_CONFIRM_CREDENTIAL (7241). Both
         * arrive at the same onActivityResult, and a collision would route a
         * device-unlock result into the address picker.
         */
        /** Distinct from SeedGate's unlock (7241). */
        private const val REQUEST_SCAN = 8312

        /** Above this many saved addresses the list starts scrolling. */
        private const val VISIBLE_BOOK_ROWS = 4

        /** Roughly four rows. Deep enough to be worth scrolling, shallow enough
         *  to leave the amount box and the review button on screen. */
        private const val BOOK_MAX_HEIGHT_DP = 248

        /**
         * Open Send with an address already filled in.
         *
         * Internal only -- this activity is `exported="false"` precisely so
         * that no other app can launch a payment screen with a destination it
         * chose. The address still goes through validateaddress and still has
         * to be reviewed.
         */
        fun intentFor(ctx: Context, address: String): Intent =
            Intent(ctx, SendActivity::class.java).putExtra(EXTRA_ADDRESS, address)
    }
}
