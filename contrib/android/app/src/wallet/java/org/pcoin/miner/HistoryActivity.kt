package org.pcoin.miner

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.LayoutInflater
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Wallet history.
 *
 * The LIST comes from one `listtransactions` call and is never cached between
 * visits: a stale history is worse than a slow one, because the whole point of
 * the screen is to answer "did my money arrive".
 *
 * A row can be TAPPED OPEN for details, and that part is fetched on demand -- one
 * `gettransaction` plus one `getrawtransaction`, only for the row that was
 * opened, never for the list. Closing and reopening re-uses what was already
 * fetched for that row, and leaving the screen forgets all of it. That is the
 * whole extent of the caching, and it is why the earlier claim that "nothing
 * here is derived" no longer holds: it is derived, per row, on request.
 *
 * Two rules this screen follows that are easy to get wrong:
 *
 *   Maturity is stated in BLOCKS, never as a time. PCoin block spacing is not
 *   constant -- it has run anywhere from 49 s to 1200 s -- so "ready in about
 *   3 hours" would be a confident guess presented as a fact.
 *
 *   A failed load leaves the previous list ALONE and says the load failed. It
 *   does not clear the list, because "I could not ask" is not "you have no
 *   transactions", and an empty screen reads as the second one.
 */
class HistoryActivity : AppCompatActivity() {

    private lateinit var prefs: Prefs
    private lateinit var book: AddressBookStore
    private val ui = Handler(Looper.getMainLooper())

    private lateinit var status: TextView
    private lateinit var rows: LinearLayout
    private lateinit var refresh: Button

    private var busy = false

    /**
     * The address book, read once per draw rather than once per row.
     *
     * Fifty rows would otherwise be fifty reads and fifty JSON parses on the
     * UI thread for a list that cannot change while it is being built.
     */
    private var bookEntries: List<AddressBook.Entry> = emptyList()

    /**
     * Details already fetched this visit, keyed by txid, so reopening a row does
     * not ask the node again. Cleared with the activity: a transaction gains
     * confirmations and this must never show a number from ten minutes ago as if
     * it were current.
     */
    private val details = HashMap<String, ForwardEngine.TxDetails>()

    /** Txids whose fetch is in flight, so a double tap cannot start two. */
    private val fetching = HashSet<String>()

    /** Our own addresses, so a change output is not offered as a counterparty. */
    private var myAddresses: Set<String> = emptySet()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        book = AddressBookStore(this)
        // Only the receiving address is known here, which is enough for the case
        // that matters: coins moved between your own addresses. Change addresses
        // are not enumerated, and are not needed -- a send's counterparty comes
        // from listtransactions rather than from its outputs.
        myAddresses = setOfNotNull(prefs.payoutAddress)
        setContentView(R.layout.activity_history)

        status = findViewById(R.id.history_status)
        rows = findViewById(R.id.row_container)
        refresh = findViewById(R.id.history_refresh)
        refresh.setOnClickListener { load() }

        status.text = getString(R.string.history_loading)
        load()
    }

    private fun load() {
        if (busy) return
        busy = true
        refresh.isEnabled = false
        refresh.alpha = 0.6f
        refresh.text = getString(R.string.history_loading_short)

        val wallet = prefs.payoutWallet
        Thread {
            var list: List<ForwardEngine.HistoryEntry>? = null
            var err: String? = null
            try {
                list = MinerService.engine()?.listHistory(wallet, HISTORY_LIMIT)
                    ?: throw IllegalStateException(getString(R.string.history_no_service))
            } catch (e: Exception) {
                err = e.message ?: e.javaClass.simpleName
            }
            val got = list
            ui.post {
                busy = false
                refresh.isEnabled = true
                refresh.alpha = 1f
                refresh.text = getString(R.string.history_refresh)
                if (got == null) {
                    // Deliberately leaves whatever is already on screen in place.
                    status.text = getString(R.string.history_failed, err.orEmpty())
                } else {
                    render(got)
                }
            }
        }.start()
    }

    private fun render(list: List<ForwardEngine.HistoryEntry>) {
        rows.removeAllViews()
        bookEntries = book.load()
        if (list.isEmpty()) {
            // "Nothing yet" is a claim about the wallet. A node that has not
            // caught up cannot support it -- it has not seen the blocks the
            // transactions are in. This fires hardest during a phrase restore,
            // which is exactly the moment somebody is least sure their twelve
            // words worked, so saying "no transactions" there is the worst
            // possible time to be confidently wrong.
            status.text =
                if (MinerState.snapshot.balanceIsTrustworthy) getString(R.string.history_empty)
                else getString(R.string.history_empty_syncing)
            return
        }
        // Say so when the list is cut off, rather than presenting the cap as the
        // total. A restored mining phrase passes 50 coinbases inside a day, and
        // silently hiding everything older reads as "my payments are missing".
        status.text =
            if (list.size >= HISTORY_LIMIT) getString(R.string.history_count_capped, list.size)
            else resources.getQuantityString(R.plurals.history_count, list.size, list.size)

        val inflater = LayoutInflater.from(this)
        val stamp = SimpleDateFormat("d MMM yyyy, HH:mm", Locale.getDefault())
        for (e in list) {
            val v = inflater.inflate(R.layout.row_history, rows, false)
            val kind = v.findViewById<TextView>(R.id.row_kind)
            val amount = v.findViewById<TextView>(R.id.row_amount)
            val rowStatus = v.findViewById<TextView>(R.id.row_status)
            val detail = v.findViewById<TextView>(R.id.row_detail)

            kind.text = when (e.kind) {
                ForwardEngine.HistoryEntry.Kind.RECEIVED -> getString(R.string.history_received)
                ForwardEngine.HistoryEntry.Kind.SENT -> getString(R.string.history_sent)
                ForwardEngine.HistoryEntry.Kind.MINED -> getString(R.string.history_mined)
                ForwardEngine.HistoryEntry.Kind.MATURING -> getString(R.string.history_maturing)
                ForwardEngine.HistoryEntry.Kind.CONFLICTED -> getString(R.string.history_conflicted)
            }

            // The sign is a direction, not arithmetic: it is drawn from the kind
            // rather than from the amount, which is already a magnitude.
            val sign = if (e.kind == ForwardEngine.HistoryEntry.Kind.SENT) "-" else "+"
            amount.text = sign + Fmt.coinsSat(e.amountSat)
            amount.setTextColor(
                when (e.kind) {
                    ForwardEngine.HistoryEntry.Kind.SENT -> getColorCompat(R.color.ink)
                    ForwardEngine.HistoryEntry.Kind.CONFLICTED -> getColorCompat(R.color.ink_muted)
                    ForwardEngine.HistoryEntry.Kind.MATURING -> getColorCompat(R.color.ink_muted)
                    else -> getColorCompat(R.color.brand)
                }
            )

            rowStatus.text = statusLine(e)

            val when_ = if (e.timeSec > 0) stamp.format(Date(e.timeSec * 1000L)) + relative(e.timeSec) else ""
            detail.text = listOf(when_, party(e), e.txid)
                .filter { it.isNotEmpty() }
                .joinToString("\n")

            // Tap anywhere on the row to open it. The whole card is the target
            // rather than a small chevron: this is a list read with a thumb.
            val more = v.findViewById<LinearLayout>(R.id.row_more)
            v.setOnClickListener {
                if (more.visibility == View.VISIBLE) {
                    more.visibility = View.GONE
                } else {
                    more.visibility = View.VISIBLE
                    showDetails(e, more)
                }
            }
            rows.addView(v)
        }
    }

    /**
     * Fill an opened row, fetching once and reusing after that.
     *
     * The fetch is off the UI thread and the result is checked against the row
     * it was asked for: a list can be refreshed while a lookup is in flight, and
     * writing a stale answer into a recycled view would put one transaction's
     * counterparty under another's amount.
     */
    private fun showDetails(e: ForwardEngine.HistoryEntry, more: LinearLayout) {
        val status = more.findViewById<TextView>(R.id.row_more_status)
        val facts = more.findViewById<TextView>(R.id.row_more_facts)
        val txidView = more.findViewById<TextView>(R.id.row_more_txid)
        val parties = more.findViewById<LinearLayout>(R.id.row_more_parties)

        details[e.txid]?.let { render(e, it, status, facts, txidView, parties); return }

        status.text = getString(R.string.history_more_loading)
        facts.visibility = View.GONE
        txidView.visibility = View.GONE
        parties.removeAllViews()
        if (!fetching.add(e.txid)) return

        val wallet = prefs.payoutWallet
        Thread {
            var got: ForwardEngine.TxDetails? = null
            var err: String? = null
            try {
                got = MinerService.engine()?.txDetails(e.txid, wallet)
                    ?: throw IllegalStateException(getString(R.string.history_no_service))
            } catch (t: Exception) {
                err = t.message ?: t.javaClass.simpleName
            }
            val d = got
            ui.post {
                fetching.remove(e.txid)
                if (d == null) {
                    status.text = getString(R.string.history_more_failed, err.orEmpty())
                    return@post
                }
                details[e.txid] = d
                // Only paint if this view is still showing the same transaction.
                if (more.tag == null || more.tag == e.txid) {
                    render(e, d, status, facts, txidView, parties)
                }
            }
        }.start()
        more.tag = e.txid
    }

    private fun render(
        e: ForwardEngine.HistoryEntry,
        d: ForwardEngine.TxDetails,
        status: TextView,
        facts: TextView,
        txidView: TextView,
        parties: LinearLayout,
    ) {
        val height = if (d.blockHeight >= 0) d.blockHeight.toString() else "—"
        facts.text =
            if (d.feeSat > 0) getString(R.string.history_more_facts, height, d.confirmations, Fmt.coinsSat(d.feeSat))
            else getString(R.string.history_more_facts_nofee, height, d.confirmations)
        facts.visibility = View.VISIBLE
        txidView.text = d.txid
        txidView.visibility = View.VISIBLE

        parties.removeAllViews()

        // A SEND's destination is already known exactly -- listtransactions puts
        // it in `address` -- so it needs NO block lookup and works while the
        // payment is still unconfirmed. Gating it on unresolvedReason (as this
        // first did) hid "Send again" behind a confirmation the destination
        // never depended on, and told someone their own outgoing payment's
        // origin was unknown, which is not even the question.
        //
        // Deriving it from the outputs instead would mean telling change apart
        // from payment, which needs every internal address the wallet ever
        // derived -- work with a wrong answer at the end of it.
        //
        // A RECEIVE has no such field, because there is no sender in the
        // protocol. Its inputs are the closest thing, and only THEY need the
        // block.
        val sent = e.kind == ForwardEngine.HistoryEntry.Kind.SENT
        val payable = if (sent) {
            TxParties.payable(listOf(e.address), emptySet())
        } else {
            if (d.unresolvedReason != null) {
                status.text = getString(R.string.history_more_unresolved, d.unresolvedReason)
                return
            }
            TxParties.payable(d.inputAddresses, myAddresses)
        }
        if (payable.isEmpty()) {
            status.text =
                if (sent) getString(R.string.history_sent_multi)
                else getString(R.string.history_no_parties)
            return
        }
        status.text = getString(if (sent) R.string.history_paid_to else R.string.history_paid_from)

        val inflater = LayoutInflater.from(this)
        for (address in payable) {
            val row = inflater.inflate(R.layout.row_party, parties, false)
            val name = AddressBook.labelFor(bookEntries, address)
            val nameView = row.findViewById<TextView>(R.id.party_name)
            nameView.visibility = if (name == null) View.GONE else View.VISIBLE
            nameView.text = name.orEmpty()
            row.findViewById<TextView>(R.id.party_address).text = address
            val pay = row.findViewById<Button>(R.id.party_pay)
            pay.setText(if (sent) R.string.history_pay_again else R.string.history_pay_this)
            // Fills the compose field and nothing more: validateaddress still
            // runs and the review step still shows what the node built.
            pay.setOnClickListener { startActivity(SendActivity.intentFor(this, address)) }
            parties.addView(row)
        }
    }

    /**
     * Who the money went to, or which of your addresses it arrived at.
     *
     * This has to be kind-aware, and the reason is the whole difficulty of the
     * feature: `listtransactions` puts a DIFFERENT thing in `address` depending
     * on the category. For a send it is the destination -- genuinely the
     * counterparty. For a receive, a generate or an immature coinbase it is
     * YOUR OWN address, the one the coins landed on. Printing it under one
     * label would tell someone their own address was the person who paid them.
     *
     * There is no "from" for a receive, and none is invented. The sender is not
     * in the wallet's record at all; recovering it means fetching the funding
     * transaction and looking at the addresses its inputs spent, which is a
     * different question with no single answer when there are several inputs.
     * An empty address -- which is what a send to multiple destinations
     * produces -- prints nothing rather than a blank label.
     */
    private fun party(e: ForwardEngine.HistoryEntry): String {
        if (e.address.isBlank()) return ""
        return when (e.kind) {
            // A name from the address book if there is one, and the address
            // either way. The name is this phone's own note -- nothing signs
            // it and nothing checks it -- so it is shown WITH the address it
            // refers to and never in place of it. Looked up live on every draw
            // rather than stored against the transaction, which is what lets a
            // rename change every screen at once and keeps this one incapable
            // of disagreeing with the address book.
            ForwardEngine.HistoryEntry.Kind.SENT ->
                when (val name = AddressBook.labelFor(bookEntries, e.address)) {
                    null -> getString(R.string.history_party_to, e.address)
                    else -> getString(R.string.history_party_to_named, name, e.address)
                }
            ForwardEngine.HistoryEntry.Kind.RECEIVED ->
                getString(R.string.history_party_received_at, e.address)
            ForwardEngine.HistoryEntry.Kind.MINED,
            ForwardEngine.HistoryEntry.Kind.MATURING ->
                getString(R.string.history_party_mined_to, e.address)
            ForwardEngine.HistoryEntry.Kind.CONFLICTED -> ""
        }
    }

    /**
     * " (3 hours 12 minutes ago)" for anything within the last day, else "".
     *
     * Only the last 24 hours, because that is the window where "when did this
     * happen" is a live question. Past that the timestamp already answers it and
     * a running count of days would just be noise.
     *
     * A transaction timestamped in the FUTURE gets nothing rather than a
     * negative or a cheerful "0 minutes ago". That is not hypothetical here:
     * block timestamps on this chain are only required to beat the median of
     * the last eleven, so they are not monotonic in height and a block can
     * legitimately carry a time a little ahead of the clock reading it.
     */
    private fun relative(timeSec: Long): String {
        val deltaSec = System.currentTimeMillis() / 1000L - timeSec
        if (deltaSec < 0 || deltaSec >= 24 * 3600) return ""
        val hours = deltaSec / 3600
        val minutes = (deltaSec % 3600) / 60
        val parts = when {
            hours > 0 -> resources.getQuantityString(R.plurals.history_rel_hours, hours.toInt(), hours) +
                " " + resources.getQuantityString(R.plurals.history_rel_minutes, minutes.toInt(), minutes)
            minutes > 0 -> resources.getQuantityString(R.plurals.history_rel_minutes, minutes.toInt(), minutes)
            else -> return " " + getString(R.string.history_rel_just_now)
        }
        return " " + getString(R.string.history_rel_ago, parts)
    }

    private fun statusLine(e: ForwardEngine.HistoryEntry): String = when {
        // Negative confirmations mean the node has seen a CONFLICTING transaction
        // in a block. This is not "less confirmed" -- these coins are not coming.
        e.confirmations < 0 ->
            resources.getQuantityString(
                R.plurals.history_status_conflicted, -e.confirmations, -e.confirmations,
            )

        e.kind == ForwardEngine.HistoryEntry.Kind.MATURING -> {
            // Maturity in blocks. COINBASE_MATURITY is 100, and a coinbase becomes
            // spendable at depth 101, so what remains is 101 - confirmations.
            val left = (COINBASE_SPENDABLE_DEPTH - e.confirmations).coerceAtLeast(1)
            resources.getQuantityString(R.plurals.history_status_maturing, left, left)
        }

        // Zero confirmations means one of two very different things, and the
        // difference matters: either the transaction is genuinely waiting for a
        // block, or this node has not finished catching up and cannot yet see
        // the block it is already in. Observed on the test device -- after an
        // unclean restart the node resynced from genesis and every settled
        // transaction read as 0 until it caught up.
        e.confirmations == 0 && !MinerState.snapshot.balanceIsTrustworthy ->
            getString(R.string.history_status_catching_up)

        e.confirmations == 0 -> getString(R.string.history_status_pending)

        e.kind == ForwardEngine.HistoryEntry.Kind.SENT && e.feeSat > 0 ->
            resources.getQuantityString(
                R.plurals.history_status_confirmed_fee,
                e.confirmations, e.confirmations, Fmt.coinsSat(e.feeSat),
            )

        else -> resources.getQuantityString(
            R.plurals.history_status_confirmed, e.confirmations, e.confirmations,
        )
    }

    @Suppress("DEPRECATION")
    private fun getColorCompat(id: Int): Int = resources.getColor(id, theme)

    private companion object {
        /** Depth at which a coinbase becomes spendable. Consensus, not a guess. */
        const val COINBASE_SPENDABLE_DEPTH = 101

        /**
         * How many entries to fetch and show.
         *
         * Named here rather than left to listHistory's default so the screen can
         * tell whether it is looking at a complete list or a truncated one --
         * a cap presented as a total is indistinguishable from missing money.
         */
        const val HISTORY_LIMIT = 50
    }
}
