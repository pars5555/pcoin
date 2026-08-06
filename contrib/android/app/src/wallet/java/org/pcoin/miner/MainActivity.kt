package org.pcoin.miner

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import kotlin.math.roundToInt

/**
 * The PCoin Wallet home screen.
 *
 * WHY THIS IS A SEPARATE FILE RATHER THAN A FLAVOUR LAYOUT.
 * The miner's MainActivity binds 44 view ids, all declared only in
 * main/res/layout/activity_main.xml. A flavour layout REPLACES that file rather
 * than merging into it, so a wallet layout omitting the mining ids deletes them
 * from this variant's R class and shared code that names them stops compiling.
 * So each flavour supplies its own MainActivity under the same fully-qualified
 * name -- which src/main requires anyway, because MinerService and
 * ForwardEngine both hold Intent(ctx, MainActivity::class.java).
 *
 * WHAT THIS SCREEN WILL NOT DO.
 *  * It never renders an unread value as a number. A balance nobody has managed
 *    to read is an em dash, not 0.00000000. The Snapshot uses -1.0 for exactly
 *    this and the whole screen keys off it.
 *  * It never turns blocks into a time. Spacing on this chain is not constant,
 *    so "spendable in about 40 more blocks" is honest and "in about 8 hours" is
 *    a guess wearing a number's clothes.
 *  * It never shows Snapshot.gateText(). decideGate tests !userWantsMining
 *    before it tests syncing, and wantsMining() is `BuildConfig.MINING && ...`,
 *    so in this build the gate is permanently "Paused: switched off" -- which
 *    would tell someone with a healthy, syncing wallet that they switched it
 *    off, next to no switch. The status line is derived from the chain numbers
 *    instead.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var prefs: Prefs
    private val ui = Handler(Looper.getMainLooper())

    private lateinit var nodeDot: View
    private lateinit var nodeStatus: TextView
    private lateinit var balanceAmount: TextView
    private lateinit var balanceNote: TextView
    private lateinit var balanceCheckedAt: TextView
    private lateinit var refreshButton: Button
    private lateinit var receiveAddress: TextView
    private lateinit var copyButton: Button
    private lateinit var shareButton: Button
    private lateinit var backupCard: LinearLayout
    private lateinit var backupButton: Button
    private lateinit var chainLine: TextView

    /** When a balance was last actually READ, not when the screen last drew. */
    private var lastGoodReadAtMs = 0L

    /** True from the moment Refresh is pressed until a newer reading lands. */
    private var refreshing = false
    private var refreshStartedAtMs = 0L
    private var balanceAtRefreshStart = -1.0

    private val tick = object : Runnable {
        override fun run() {
            render(MinerState.snapshot)
            ui.postDelayed(this, REFRESH_MS)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)

        // A wallet with no wallet is a setup problem, not a home screen.
        if (prefs.payoutAddress == null) {
            startActivity(SetupActivity.intent(this))
            finish()
            return
        }

        setContentView(R.layout.activity_wallet)

        nodeDot = findViewById(R.id.node_dot)
        nodeStatus = findViewById(R.id.node_status)
        balanceAmount = findViewById(R.id.balance_amount)
        balanceNote = findViewById(R.id.balance_note)
        balanceCheckedAt = findViewById(R.id.balance_checked_at)
        refreshButton = findViewById(R.id.refresh_button)
        receiveAddress = findViewById(R.id.receive_address)
        copyButton = findViewById(R.id.copy_button)
        shareButton = findViewById(R.id.share_button)
        backupCard = findViewById(R.id.backup_card)
        backupButton = findViewById(R.id.backup_button)
        chainLine = findViewById(R.id.chain_line)

        balanceAmount.text = getString(R.string.wallet_amount_unknown)
        balanceCheckedAt.text = getString(R.string.wallet_checked_never)

        refreshButton.setOnClickListener { onRefresh() }
        copyButton.setOnClickListener { copyAddress() }
        shareButton.setOnClickListener { shareAddress() }
        backupButton.setOnClickListener { startActivity(Intent(this, BackupActivity::class.java)) }

        // The wallet must bring its own node up: the node is otherwise only
        // started by the mining flow, which is compiled out here.
        MinerService.prepare(this)
    }

    override fun onResume() {
        super.onResume()
        // Cheap and idempotent -- the service no-ops if its control thread is
        // already running. Covers the case where Android killed the service
        // while the screen was in the background.
        MinerService.prepare(this)
        renderAddress()
        ui.post(tick)
    }

    override fun onPause() {
        super.onPause()
        ui.removeCallbacks(tick)
    }

    // ------------------------------------------------------------------ refresh

    /**
     * Ask for a fresh reading.
     *
     * This does NOT open its own RPC connection. The service's control thread
     * already owns the node; a second reader would race it and could sit on a
     * socket for the full timeout while holding nothing useful. All this does is
     * ask that thread to go round again, then watch the snapshot for a value
     * newer than the one showing.
     *
     * "In flight" is time-boxed: if no newer reading arrives within
     * REFRESH_TIMEOUT_MS the button returns to idle and says the check did not
     * complete. It must never sit on "Checking…" forever, and it must never
     * silently fall back to the stale number as though it were fresh.
     */
    private fun onRefresh() {
        if (refreshing) return
        refreshing = true
        refreshStartedAtMs = System.currentTimeMillis()
        balanceAtRefreshStart = MinerState.snapshot.balanceConfirmed
        refreshButton.isEnabled = false
        refreshButton.alpha = 0.6f
        refreshButton.text = getString(R.string.wallet_refresh_busy)
        MinerService.prepare(this)
        render(MinerState.snapshot)
    }

    private fun endRefresh(succeeded: Boolean) {
        refreshing = false
        refreshButton.isEnabled = true
        refreshButton.alpha = 1f
        refreshButton.text = getString(R.string.wallet_refresh)
        if (!succeeded) balanceCheckedAt.text = getString(R.string.wallet_check_failed)
    }

    // ------------------------------------------------------------------- render

    private fun render(s: MinerState.Snapshot) {
        val now = System.currentTimeMillis()

        // A SYNCING NODE'S BALANCE IS NOT A BALANCE.
        //
        // getbalances answers 0.00000000 quite happily while the chain is only
        // partly downloaded -- it is telling the truth about the blocks it has
        // seen, which is not the truth about the wallet. A bare `>= 0` test
        // therefore reads that as "known" and prints a confident zero over
        // someone's actual holdings. Observed on a phone showing 0.00000000 at
        // 11% synced against a real balance of 106,550 PCN.
        //
        // So the balance counts as read only when the node has caught up.
        // Headers arrive far ahead of blocks, which is what makes this testable
        // before the wallet has finished scanning.
        val caughtUp = s.height >= 0 && s.headers >= 0 && s.height >= s.headers
        val known = caughtUp && s.balanceConfirmed >= 0.0

        if (known) {
            lastGoodReadAtMs = now
            balanceAmount.text = Fmt.coins(s.balanceConfirmed)
        } else {
            // Deliberately leaves any previously-shown figure in place rather
            // than blanking it: a number that was true a minute ago is more
            // useful than an em dash, as long as the line underneath says when
            // it was read.
            if (lastGoodReadAtMs == 0L) {
                balanceAmount.text = getString(R.string.wallet_amount_unknown)
            }
        }

        if (refreshing) {
            val movedOn = known && (s.balanceConfirmed != balanceAtRefreshStart || now - refreshStartedAtMs > 1_500)
            if (movedOn) endRefresh(true)
            else if (now - refreshStartedAtMs > REFRESH_TIMEOUT_MS) endRefresh(false)
        }

        if (!refreshing) balanceCheckedAt.text = checkedAtText(now, caughtUp)
        renderNote(s, caughtUp)
        renderNode(s)
        renderBackupCard()
    }

    private fun checkedAtText(now: Long, caughtUp: Boolean): String = when {
        // Say why there is no figure, rather than "Not checked yet", which
        // sounds like something the user should go and do.
        !caughtUp && lastGoodReadAtMs == 0L -> getString(R.string.wallet_checked_syncing)
        lastGoodReadAtMs == 0L -> getString(R.string.wallet_checked_never)
        now - lastGoodReadAtMs < 20_000 -> getString(R.string.wallet_checked_just_now)
        else -> getString(R.string.wallet_checked_ago, shortAge(now - lastGoodReadAtMs))
    }

    private fun shortAge(ms: Long): String {
        val sec = ms / 1000
        return when {
            sec < 90 -> "${sec}s"
            sec < 3600 -> "${sec / 60}m"
            else -> "${sec / 3600}h"
        }
    }

    /**
     * Pending and immature, only when there is something to say.
     *
     * Immature coinbase is expressed in BLOCKS remaining, never converted to a
     * duration.
     */
    private fun renderNote(s: MinerState.Snapshot, caughtUp: Boolean) {
        // Same rule as the headline figure: a partly-synced node's zeroes are
        // not evidence that nothing is pending.
        val pending = if (caughtUp && s.balancePending > 0.0) s.balancePending else 0.0
        val immature = if (caughtUp && s.balanceImmature > 0.0) s.balanceImmature else 0.0
        if (pending <= 0.0 && immature <= 0.0) {
            balanceNote.visibility = View.GONE
            return
        }
        balanceNote.visibility = View.VISIBLE
        balanceNote.text = when {
            pending > 0.0 && immature > 0.0 ->
                getString(R.string.wallet_note_both, Fmt.coins(pending), Fmt.coins(immature), MATURITY_BLOCKS)
            pending > 0.0 -> getString(R.string.wallet_note_pending, Fmt.coins(pending))
            else -> getString(R.string.wallet_note_immature, Fmt.coins(immature), MATURITY_BLOCKS)
        }
    }

    /**
     * Node state derived from the chain numbers, not from the mining gate.
     *
     * -1 means "not read", which is why every branch tests for it before it
     * decides anything.
     */
    private fun renderNode(s: MinerState.Snapshot) {
        val h = s.height
        val hh = s.headers
        val peers = s.peers

        val (text, colour) = when {
            h < 0 || hh < 0 -> getString(R.string.wallet_node_starting) to R.color.ink_muted
            peers == 0 -> getString(R.string.wallet_node_no_peers) to R.color.wait
            hh > 0 && h < hh -> {
                val pct = ((h.toDouble() / hh.toDouble()) * 100.0).roundToInt().coerceIn(0, 99)
                getString(R.string.wallet_node_syncing, pct) to R.color.wait
            }
            else -> getString(R.string.wallet_node_ready) to R.color.good
        }
        nodeStatus.text = text
        nodeDot.background.setTint(getColor(colour))

        chainLine.text =
            if (h >= 0 && peers >= 0) getString(R.string.wallet_chain_line, h, peers)
            else getString(R.string.wallet_chain_line_unknown)
    }

    private fun renderAddress() {
        val addr = prefs.payoutAddress
        receiveAddress.text = addr ?: getString(R.string.wallet_address_unknown)
        copyButton.isEnabled = addr != null
        shareButton.isEnabled = addr != null
    }

    /** Only nag while the phrase is genuinely unconfirmed. */
    private fun renderBackupCard() {
        backupCard.visibility = if (prefs.phraseConfirmed) View.GONE else View.VISIBLE
    }

    // -------------------------------------------------------------------- share

    private fun copyAddress() {
        val addr = prefs.payoutAddress ?: return
        val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText("PCoin address", addr))
        Toast.makeText(this, R.string.wallet_copied, Toast.LENGTH_SHORT).show()
    }

    private fun shareAddress() {
        val addr = prefs.payoutAddress ?: return
        startActivity(
            Intent.createChooser(
                Intent(Intent.ACTION_SEND).apply {
                    type = "text/plain"
                    putExtra(Intent.EXTRA_SUBJECT, getString(R.string.wallet_share_subject))
                    putExtra(Intent.EXTRA_TEXT, addr)
                },
                getString(R.string.wallet_share_subject)
            )
        )
    }

    private companion object {
        const val REFRESH_MS = 2_000L
        const val REFRESH_TIMEOUT_MS = 30_000L

        /** Consensus coinbase maturity. Stated in blocks, never as a duration. */
        const val MATURITY_BLOCKS = 100
    }
}
