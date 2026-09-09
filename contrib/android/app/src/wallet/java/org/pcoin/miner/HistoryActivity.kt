package org.pcoin.miner

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.TextWatcher
import android.view.LayoutInflater
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
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
    private lateinit var scroll: ScrollView

    private var busy = false

    /**
     * Every row loaded so far, oldest page last. The screen appends rather than
     * replaces, so scrolling back up does not re-ask the node for pages it has
     * already drawn.
     */
    private val loaded = ArrayList<ForwardEngine.HistoryEntry>()

    /**
     * How many pages have been requested. The node's `skip` is counted in ITS
     * rows, so the offset is `pages * HISTORY_LIMIT` -- never `loaded.size`,
     * which is smaller whenever a row was dropped and would re-request rows
     * already shown.
     */
    private var pages = 0

    /** Set when a page comes back with no node rows at all. Then we stop asking. */
    private var reachedEnd = false

    /**
     * Which directions to show. MINED and MATURING are coins arriving, so they
     * count as RECEIVED -- a wallet that mined a block was paid, and hiding
     * that under "sent" or under neither would lose it entirely.
     */
    private enum class Filter { ALL, SENT, RECEIVED }

    private var filter = Filter.ALL

    /** Lower-cased, trimmed. Empty means no search. */
    private var query = ""

    private lateinit var searchBox: EditText
    private lateinit var filterAll: Button
    private lateinit var filterSent: Button
    private lateinit var filterReceived: Button

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
        padForSystemBars()

        status = findViewById(R.id.history_status)
        rows = findViewById(R.id.row_container)
        refresh = findViewById(R.id.history_refresh)
        scroll = findViewById(R.id.history_scroll)
        refresh.setOnClickListener { load() }

        searchBox = findViewById(R.id.history_search)
        filterAll = findViewById(R.id.filter_all)
        filterSent = findViewById(R.id.filter_sent)
        filterReceived = findViewById(R.id.filter_received)

        // Filtering and searching NEVER re-ask the node. They narrow the rows
        // already fetched, which is why they are instant and why the empty
        // state says how many rows were actually looked at -- claiming "no
        // matches" over a wallet that has loaded 50 of 400 rows would be a
        // confident wrong answer of exactly the kind this project keeps
        // paying for.
        filterAll.setOnClickListener { setFilter(Filter.ALL) }
        filterSent.setOnClickListener { setFilter(Filter.SENT) }
        filterReceived.setOnClickListener { setFilter(Filter.RECEIVED) }
        markFilterButtons()

        searchBox.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) = Unit
            override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) = Unit
            override fun afterTextChanged(s: Editable?) {
                val next = s?.toString()?.trim()?.lowercase().orEmpty()
                if (next == query) return
                query = next
                applyFilters()
            }
        })

        // Endless scroll. Fires when the view is within one screen-height of the
        // bottom, so the next page is usually already drawn by the time the user
        // gets there. `load()` guards on `busy`, so a fling that crosses the
        // threshold repeatedly still only starts one request.
        scroll.setOnScrollChangeListener { v, _, scrollY, _, _ ->
            val child = (v as ScrollView).getChildAt(0) ?: return@setOnScrollChangeListener
            val remaining = child.height - v.height - scrollY
            if (remaining <= v.height) loadMore()
        }

        status.text = getString(R.string.history_loading)
        load()
    }

    /** Reload from the top: forget every page and ask again. */
    private fun load() {
        if (busy) return
        loaded.clear()
        pages = 0
        reachedEnd = false
        fetchPage(replace = true)
    }

    /** Append the next page, unless one is in flight or the list has ended. */
    private fun loadMore() {
        if (busy || reachedEnd || pages == 0) return
        fetchPage(replace = false)
    }

    private fun fetchPage(replace: Boolean) {
        busy = true
        refresh.isEnabled = false
        refresh.alpha = 0.6f
        refresh.text = getString(R.string.history_loading_short)
        if (!replace) status.text = getString(R.string.history_loading_more, loaded.size)

        val wallet = prefs.payoutWallet
        val skip = pages * HISTORY_LIMIT
        Thread {
            var page: ForwardEngine.HistoryPage? = null
            var err: String? = null
            try {
                page = MinerService.engine()?.listHistoryPage(wallet, HISTORY_LIMIT, skip)
                    ?: throw IllegalStateException(getString(R.string.history_no_service))
            } catch (e: Exception) {
                err = e.message ?: e.javaClass.simpleName
            }
            val got = page
            ui.post {
                busy = false
                refresh.isEnabled = true
                refresh.alpha = 1f
                refresh.text = getString(R.string.history_refresh)
                if (got == null) {
                    // Deliberately leaves whatever is already on screen in place.
                    status.text = getString(R.string.history_failed, err.orEmpty())
                    return@post
                }
                pages++
                // The NODE's row count decides the end, not the filtered one.
                if (got.rawCount == 0) reachedEnd = true
                if (replace) loaded.clear()
                loaded.addAll(got.entries)
                render(loaded)
            }
        }.start()
    }

    /**
     * Does this row match the current filter and search?
     *
     * Searching covers the txid, the counterparty address, and the NAME saved
     * for that address -- the three things someone actually remembers a
     * payment by. Matching is a plain case-insensitive substring: a bech32
     * address and a txid are both hex-ish strings where a prefix or a tail
     * fragment is what a person has to hand, and anything cleverer would
     * surprise more often than it helped.
     */
    private fun matches(e: ForwardEngine.HistoryEntry): Boolean {
        val dirOk = when (filter) {
            Filter.ALL -> true
            Filter.SENT -> e.kind == ForwardEngine.HistoryEntry.Kind.SENT
            // Mined and maturing coins are money arriving. Excluding them from
            // "received" would make a mined block invisible under every filter
            // except All, which is a hiding place, not a filter.
            Filter.RECEIVED -> e.kind == ForwardEngine.HistoryEntry.Kind.RECEIVED ||
                e.kind == ForwardEngine.HistoryEntry.Kind.MINED ||
                e.kind == ForwardEngine.HistoryEntry.Kind.MATURING
        }
        if (!dirOk) return false
        if (query.isEmpty()) return true
        if (e.txid.lowercase().contains(query)) return true
        if (e.address.lowercase().contains(query)) return true
        val name = AddressBook.labelFor(bookEntries, e.address)
        return name != null && name.lowercase().contains(query)
    }

    private fun setFilter(f: Filter) {
        if (filter == f) return
        filter = f
        markFilterButtons()
        applyFilters()
    }

    private fun applyFilters() {
        // bookEntries is what name search reads; refresh it before matching or
        // a rename made on the previous screen would not be searchable yet.
        bookEntries = book.load()
        render(loaded)
    }

    private fun markFilterButtons() {
        for ((b, f) in listOf(filterAll to Filter.ALL, filterSent to Filter.SENT, filterReceived to Filter.RECEIVED)) {
            val on = f == filter
            // Filled, not just a different alpha. An alpha-only selected state
            // shipped once on the send screen and the owner could not see
            // which tier was chosen; the same mistake is available here.
            b.setBackgroundResource(if (on) R.drawable.btn_primary else R.drawable.btn_ghost)
            b.setTextColor(resources.getColor(if (on) R.color.on_brand else R.color.brand, theme))
        }
    }

    private fun copy(text: String, toastRes: Int) {
        val cm = getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
        if (cm == null) {
            Toast.makeText(this, R.string.book_copy_failed, Toast.LENGTH_SHORT).show()
            return
        }
        cm.setPrimaryClip(ClipData.newPlainText(null, text))
        // Android 13+ shows its own copy confirmation.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            Toast.makeText(this, toastRes, Toast.LENGTH_SHORT).show()
        }
    }

    private fun render(all: List<ForwardEngine.HistoryEntry>) {
        rows.removeAllViews()
        bookEntries = book.load()
        val filtering = filter != Filter.ALL || query.isNotEmpty()
        val list = if (filtering) all.filter { matches(it) } else all

        if (list.isEmpty() && filtering) {
            // NOT "no transactions" -- that is a claim about the wallet, and
            // this is a claim about the rows fetched so far. Saying which is
            // the difference between "you have none" and "scroll for more".
            status.text =
                if (reachedEnd) getString(R.string.history_no_matches, all.size)
                else getString(R.string.history_no_matches_more, all.size)
            return
        }
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
        // The list is no longer capped -- scrolling loads more -- so the count
        // is only qualified while more pages may still exist. Saying a bare
        // total before the end is reached would present a page as the whole
        // history, which is the thing the old cap message existed to prevent.
        status.text = when {
            filtering && reachedEnd -> getString(R.string.history_count_filtered, list.size, all.size)
            filtering -> getString(R.string.history_count_filtered_more, list.size, all.size)
            reachedEnd -> resources.getQuantityString(R.plurals.history_count, list.size, list.size)
            else -> getString(R.string.history_count_more, list.size)
        }

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
        (txidView.parent as? View)?.visibility = View.GONE
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
        // Visibility belongs to the row that holds the id AND its copy button;
        // showing only the TextView would leave the button hidden beside it.
        (txidView.parent as? View)?.visibility = View.VISIBLE
        (txidView.parent as? View)?.findViewById<ImageButton>(R.id.row_more_txid_copy)
            ?.setOnClickListener { copy(d.txid, R.string.history_copied_txid) }

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
            row.findViewById<ImageButton>(R.id.party_copy)
                .setOnClickListener { copy(address, R.string.history_copied_address) }
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
