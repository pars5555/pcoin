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
 * Read-only, and everything on screen comes from one `listtransactions` call.
 * Nothing here is derived, cached or remembered between visits: a stale history
 * is worse than a slow one, because the whole point of the screen is to answer
 * "did my money arrive".
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
    private val ui = Handler(Looper.getMainLooper())

    private lateinit var status: TextView
    private lateinit var rows: LinearLayout
    private lateinit var refresh: Button

    private var busy = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
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

            val when_ = if (e.timeSec > 0) stamp.format(Date(e.timeSec * 1000L)) else ""
            detail.text = if (when_.isEmpty()) e.txid else "$when_\n${e.txid}"
            rows.addView(v)
        }
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
