package org.pcoin.miner

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.CheckBox
import android.widget.SeekBar
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import org.pcoin.miner.wallet.SeedStore

/**
 * The whole UI: one screen, refreshed every 3 seconds from [MinerState].
 *
 * The activity is a pure view. It never talks to the node, never blocks, and
 * owns no state beyond the slider position. Everything on screen is a number
 * the node actually reported -- there are no earnings estimates and no fiat
 * values anywhere, because the app has no honest way to compute them.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var prefs: Prefs

    private lateinit var gateStatus: TextView
    private lateinit var hashrate: TextView
    private lateinit var toggle: Button
    private lateinit var performance: SeekBar
    private lateinit var performanceValue: TextView
    private lateinit var thermal: SeekBar
    private lateinit var thermalValue: TextView
    private lateinit var blocksFound: TextView
    private lateinit var threads: TextView
    private lateinit var height: TextView
    private lateinit var peers: TextView
    private lateinit var balanceConfirmed: TextView
    private lateinit var balanceImmature: TextView
    private lateinit var balanceInFlight: TextView
    private lateinit var address: TextView
    private lateinit var copyAddress: Button
    private lateinit var device: TextView
    private lateinit var notificationBanner: TextView
    private lateinit var permNotifications: TextView
    private lateinit var permNotificationsBtn: Button
    private lateinit var permBattery: TextView
    private lateinit var permBatteryBtn: Button
    private lateinit var permAutostartBtn: Button
    private lateinit var permSummary: TextView
    private lateinit var mineOnBattery: CheckBox
    private lateinit var alwaysOnWarning: TextView
    private lateinit var walletBanner: TextView
    private lateinit var walletBannerActions: View
    private lateinit var walletSetupBtn: Button
    private lateinit var walletDismissBtn: Button
    private lateinit var balanceSeeded: TextView
    private lateinit var balanceLegacy: TextView
    private lateinit var backupButton: Button
    private lateinit var forwardState: TextView
    private lateinit var forwardDestination: TextView
    private lateinit var forwardDestinationLabel: TextView
    private lateinit var forwardBlocked: TextView
    private lateinit var forwardError: TextView
    private lateinit var forwardLast: TextView
    private lateinit var forwardManage: Button
    private lateinit var forwardCopyTxid: Button

    private lateinit var seedStore: SeedStore

    private val ui = Handler(Looper.getMainLooper())
    private val refresh = object : Runnable {
        override fun run() {
            render(MinerState.snapshot)
            ui.postDelayed(this, REFRESH_MS)
        }
    }

    /** True while the user is dragging, so the label tracks the thumb live. */
    private var draggingSlider = false
    private var draggingThermal = false

    /** Whether POST_NOTIFICATIONS is granted; drives the warning banner. */
    private var notificationsAllowed = true

    /** The runtime prompt is only ever shown once per session. */
    private var permissionAsked = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        seedStore = SeedStore(this)
        // Records what is already true about an install that predates recovery
        // phrases. Purely additive; nothing the user can observe changes.
        prefs.migrateLegacyWalletRecord()
        setContentView(R.layout.activity_main)

        gateStatus = findViewById(R.id.gate_status)
        hashrate = findViewById(R.id.hashrate)
        toggle = findViewById(R.id.toggle)
        performance = findViewById(R.id.performance)
        performanceValue = findViewById(R.id.performance_value)
        thermal = findViewById(R.id.thermal)
        thermalValue = findViewById(R.id.thermal_value)
        blocksFound = findViewById(R.id.blocks_found)
        threads = findViewById(R.id.threads)
        height = findViewById(R.id.height)
        peers = findViewById(R.id.peers)
        balanceConfirmed = findViewById(R.id.balance_confirmed)
        balanceImmature = findViewById(R.id.balance_immature)
        balanceInFlight = findViewById(R.id.balance_inflight)
        address = findViewById(R.id.address)
        copyAddress = findViewById(R.id.copy_address)
        device = findViewById(R.id.device)
        notificationBanner = findViewById(R.id.notification_banner)
        permNotifications = findViewById(R.id.perm_notifications)
        permNotificationsBtn = findViewById(R.id.perm_notifications_btn)
        permBattery = findViewById(R.id.perm_battery)
        permBatteryBtn = findViewById(R.id.perm_battery_btn)
        permAutostartBtn = findViewById(R.id.perm_autostart_btn)
        permSummary = findViewById(R.id.perm_summary)
        mineOnBattery = findViewById(R.id.mine_on_battery)
        alwaysOnWarning = findViewById(R.id.always_on_warning)
        walletBanner = findViewById(R.id.wallet_banner)
        walletBannerActions = findViewById(R.id.wallet_banner_actions)
        walletSetupBtn = findViewById(R.id.wallet_setup_btn)
        walletDismissBtn = findViewById(R.id.wallet_dismiss_btn)
        balanceSeeded = findViewById(R.id.balance_seeded)
        balanceLegacy = findViewById(R.id.balance_legacy)
        backupButton = findViewById(R.id.backup_button)
        forwardState = findViewById(R.id.forward_state)
        forwardDestination = findViewById(R.id.forward_destination)
        forwardDestinationLabel = findViewById(R.id.forward_destination_label)
        forwardBlocked = findViewById(R.id.forward_blocked)
        forwardError = findViewById(R.id.forward_error)
        forwardLast = findViewById(R.id.forward_last)
        forwardManage = findViewById(R.id.forward_manage)
        forwardCopyTxid = findViewById(R.id.forward_copy_txid)
        setUpForwardButtons()
        setUpWalletButtons()
        setUpPermissionButtons()
        setUpAlwaysOn()

        setUpSlider()
        setUpThermalSlider()
        hideMiningControlsIfWallet()

        // Allows a deployment or automation tool to switch mining on without
        // simulating a tap:  am start -n org.pcoin.miner/.MainActivity --ez start_mining true
        if (BuildConfig.MINING && intent?.getBooleanExtra(EXTRA_START_MINING, false) == true) {
            prefs.miningEnabled = true
        }
        applyProvisioning(intent)
        // (see hideMiningControlsIfWallet below for why the mining UI is gone
        //  in the wallet flavour rather than merely inert)

        // A fresh install has no wallet at all. Go straight to setup rather than
        // showing a dashboard for a wallet that does not exist -- and certainly
        // rather than inventing one, which is how rewards end up at a key with
        // no recovery phrase behind it.
        if (needsFirstRunSetup()) {
            startActivity(SetupActivity.intent(this))
        }

        // Resume mining if the user left it switched on and the service is not
        // already up: after an app update, a process kill, or simply reopening
        // the app, "mining is on" should still mean mining is on. The gates
        // still apply -- the service re-evaluates charging and temperature
        // before it hashes anything.
        if (BuildConfig.MINING) {
            if (prefs.miningEnabled && !isRunning(MinerState.snapshot) && notificationsGranted()) {
                startMining()
            }
        } else {
            // THE WALLET MUST BRING ITS OWN NODE UP.
            //
            // The node is only ever started as part of the mining flow, so a
            // build with mining compiled out never starts one at all: after
            // first-run setup completes, the wallet sits at "Stopped" with no
            // balance, no height and no way to receive -- observed on a phone
            // holding real coins after a reinstall.
            //
            // ACTION_PREPARE is exactly the right entry point and already
            // exists: it brings the node up WITHOUT touching prefs.miningEnabled,
            // which is the user's own persisted intent and must not be written
            // by a lifecycle event.
            //
            // Cheap to call unconditionally -- MinerService.startWorker() is a
            // no-op when the control thread is already running.
            if (!needsFirstRunSetup()) MinerService.prepare(this)
        }

        toggle.setOnClickListener {
            if (needsFirstRunSetup()) {
                // There is nowhere to pay rewards to. Send the user to setup
                // rather than starting a service that would only sit at
                // NEEDS_SETUP.
                startActivity(SetupActivity.intent(this))
                return@setOnClickListener
            }
            if (isRunning(MinerState.snapshot)) {
                MinerService.stop(this)
            } else if (!askForNotificationsFirst()) {
                // Permission dialog is up; the service starts from
                // onRequestPermissionsResult, not from here.
                startMining()
            }
            // Repaint immediately so the button does not look unresponsive
            // while the service starts up.
            ui.postDelayed({ render(MinerState.snapshot) }, 200)
        }

        copyAddress.setOnClickListener {
            val addr = MinerState.snapshot.payoutAddress.ifBlank { prefs.payoutAddress.orEmpty() }
            if (addr.isBlank()) return@setOnClickListener
            val cm = getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
            cm?.setPrimaryClip(ClipData.newPlainText("PCoin payout address", addr))
            Toast.makeText(this, R.string.address_copied, Toast.LENGTH_SHORT).show()
        }
    }

    override fun onResume() {
        super.onResume()
        syncSliderFromPrefs()
        notificationsAllowed = notificationsGranted()
        ui.removeCallbacks(refresh)
        ui.post(refresh)
    }

    override fun onPause() {
        super.onPause()
        ui.removeCallbacks(refresh)
    }

    // ---------------------------------------------------------------- wallet

    /**
     * True only for an install with no wallet of any kind.
     *
     * An install that predates recovery phrases has a payout address and a
     * working wallet; it must NOT be dragged into setup, it must keep mining
     * exactly as before. It gets an offer, not a redirect.
     *
     * Deliberately does NOT consult [SeedStore.exists]. The encrypted blob is
     * written BEFORE the wallet is built, so its presence proves only that a
     * phrase was generated -- not that anything on the node answers to it. See
     * [setupIncomplete].
     */
    private fun needsFirstRunSetup(): Boolean =
        prefs.payoutAddress == null && prefs.seedWalletName == null

    /**
     * True when this install has a phrase-backed wallet the NODE has confirmed.
     *
     * [Prefs.seedWalletName] is written only after DescriptorInstaller has
     * cross-checked the node's own view of the payout address against the one
     * derived locally, so it is the single authoritative signal. The existence
     * of a file is not: SetupActivity stores the blob first, and installWallet
     * can then fail for half a dozen reasons -- awaitNode timing out, an
     * AuthFailed from a foreign node on the RPC port, an importdescriptors
     * error, the getaddressinfo verify mismatch, or the user simply walking away
     * after a failure.
     *
     * Keying the UI off the file meant that from that moment the app lied: the
     * "no recovery phrase" banner was hidden, the setup button was GONE, nothing
     * re-launched setup, and SetupActivity was unreachable from every entry
     * point -- while BackupActivity happily displayed twelve words that
     * controlled no wallet and mining carried on paying into the phrase-less
     * wallet with no warning anywhere.
     */
    private fun hasPhraseWallet(): Boolean = prefs.seedWalletName != null

    /**
     * A phrase is stored but no wallet was ever confirmed for it.
     *
     * An interrupted setup, and it must be resumable rather than terminal. The
     * words are real and worth keeping -- SetupActivity finishes the job from
     * the stored phrase rather than generating a new one.
     */
    private fun setupIncomplete(): Boolean =
        seedStore.exists() && prefs.seedWalletName == null

    private fun setUpWalletButtons() {
        walletSetupBtn.setOnClickListener { startActivity(SetupActivity.intent(this)) }
        walletDismissBtn.setOnClickListener {
            // Recorded so the app stops asking on every launch. Deliberately
            // does NOT count as "backed up" anywhere: the balance readout below
            // still says the old wallet has no phrase.
            prefs.phrasePromptDismissed = true
            renderWalletState(MinerState.snapshot)
        }
        backupButton.setOnClickListener { startActivity(BackupActivity.intent(this)) }
    }

    /**
     * The three honest states: no wallet, a wallet with no phrase, a wallet with
     * one. Whichever it is, it is stated plainly rather than implied by an
     * absence.
     */
    /**
     * Applies fleet provisioning extras. Debug builds only; see the constants.
     *
     * Deliberately conservative: it will not overwrite a forwarding address
     * that is already set. Re-provisioning a device that is mid-sweep would
     * be the destination-change race the forwarding engine takes a lock to
     * prevent, and a provisioning tool has no business winning that race.
     */
    private fun applyProvisioning(intent: Intent?) {
        if (!BuildConfig.DEBUG || intent == null) return

        val percent = intent.getIntExtra(EXTRA_PROVISION_PERCENT, -1)
        if (percent in 10..100) {
            prefs.performancePercent = percent
            android.util.Log.i("PCoinProvision", "performance set to ${prefs.performancePercent}%")
        }

        val addr = intent.getStringExtra(EXTRA_PROVISION_FORWARD)?.trim()
        if (!addr.isNullOrEmpty()) {
            if (prefs.forwardAddress != null) {
                android.util.Log.w("PCoinProvision", "forward address already set; refusing to replace")
            } else {
                // Validated by the node, exactly as the settings screen does --
                // a provisioning path that accepted an unvalidated address
                // would burn every reward to an address nobody holds.
                val normalised = ForwardPolicy.normalizeAddress(addr)
                prefs.forwardAddress = normalised
                prefs.forwardState = ForwardState.PROBING_PENDING
                android.util.Log.i("PCoinProvision", "forwarding queued to $normalised")
            }
        }
    }

    private fun renderWalletState(s: MinerState.Snapshot) {
        val hasPhrase = hasPhraseWallet()
        val noWalletAtAll = needsFirstRunSetup()

        when {
            noWalletAtAll -> {
                walletBanner.setText(R.string.wallet_needs_setup)
                walletSetupBtn.setText(R.string.wallet_setup_button)
                walletBanner.visibility = View.VISIBLE
                walletBannerActions.visibility = View.VISIBLE
                walletDismissBtn.visibility = View.GONE
            }
            // Checked before the "no phrase" banner: a stored phrase with no
            // confirmed wallet is a specific, fixable state and saying "you have
            // no recovery phrase" would be wrong. It is never dismissible --
            // rewards may be going somewhere the stored words do not recover.
            setupIncomplete() -> {
                walletBanner.setText(R.string.wallet_setup_incomplete)
                walletSetupBtn.setText(R.string.wallet_finish_setup)
                walletBanner.visibility = View.VISIBLE
                walletBannerActions.visibility = View.VISIBLE
                walletDismissBtn.visibility = View.GONE
            }
            !hasPhrase && !prefs.phrasePromptDismissed -> {
                walletBanner.setText(R.string.wallet_no_phrase_banner)
                walletSetupBtn.setText(R.string.wallet_create_phrase)
                walletBanner.visibility = View.VISIBLE
                walletBannerActions.visibility = View.VISIBLE
                walletDismissBtn.visibility = View.VISIBLE
            }
            else -> {
                walletBanner.visibility = View.GONE
                walletBannerActions.visibility = View.GONE
            }
        }

        // Keyed off the stored blob, not off the confirmed wallet: during an
        // incomplete setup the words are real and the user should be able to
        // write them down.
        backupButton.visibility = if (seedStore.exists()) View.VISIBLE else View.GONE

        // The split is only shown when there is something to split. A user with
        // one wallet does not need to be taught vocabulary.
        val showSplit = s.hasSeedWallet && s.hasLegacyWallet
        if (showSplit) {
            balanceSeeded.text = getString(R.string.label_balance_seeded) +
                ": ${Fmt.coins(s.seedConfirmed)} + ${Fmt.coins(s.seedImmature)} immature"
            balanceLegacy.text = getString(R.string.label_balance_legacy) +
                ": ${Fmt.coins(s.legacyConfirmed)} + ${Fmt.coins(s.legacyImmature)} immature"
            balanceSeeded.visibility = View.VISIBLE
            balanceLegacy.visibility = View.VISIBLE
        } else {
            balanceSeeded.visibility = View.GONE
            balanceLegacy.visibility = View.GONE
        }
    }

    // ------------------------------------------------------------ forwarding

    private fun setUpForwardButtons() {
        forwardManage.setOnClickListener { startActivity(ForwardActivity.intent(this)) }

        forwardCopyTxid.setOnClickListener {
            val txid = prefs.forwardLastTxid ?: return@setOnClickListener
            val cm = getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
            cm?.setPrimaryClip(ClipData.newPlainText("PCoin transaction id", txid))
            Toast.makeText(this, R.string.forward_txid_copied, Toast.LENGTH_SHORT).show()
        }
    }

    /**
     * The forwarding card.
     *
     * Two rules run through all of it. A transaction that has merely been
     * broadcast is NEVER worded as sent -- with one peer, or with only
     * block-relay-only peers, a successful sendrawtransaction can mean nobody
     * else has seen it. And every amount and address shown comes from the
     * DECODED transaction, never from the setting it was built from: what was
     * actually built is the only honest thing to display.
     */
    private fun renderForwarding(s: MinerState.Snapshot) {
        val address = prefs.forwardAddress
        val state = prefs.forwardState
        val sweep = s.forwardSweepState

        // Read straight from persisted intent, never from a live snapshot: the
        // address the user chose must stay on screen even when the node is
        // unreachable, a sweep is mid-flight, or a precondition is blocking.
        val showDest = address != null && state != ForwardState.HOLDING
        forwardDestination.text = address.orEmpty()
        forwardDestination.visibility = if (showDest) View.VISIBLE else View.GONE
        forwardDestinationLabel.visibility = if (showDest) View.VISIBLE else View.GONE

        forwardState.text = when {
            sweep != null && sweep != SweepState.SETTLED -> getString(
                R.string.forward_card_pending,
                Fmt.coinsSat(s.forwardSweepAmountSat),
                sweepWording(s),
            )
            address == null || state == ForwardState.HOLDING ->
                getString(R.string.forward_card_holding)
            // Shows the destination IN FULL, deliberately. This is the state a
            // user sits in for a day after typing an address, and it is the
            // only chance to notice a wrong one before rewards are committed
            // to it. A shortened form would hide exactly the characters a
            // mistyped address differs by.
            state == ForwardState.PROBING_PENDING ->
                getString(R.string.forward_card_probe_pending, address)
            state == ForwardState.PROBING_SENT && s.forwardProbeConfirmed -> getString(
                R.string.forward_card_probe_ready,
                Fmt.coinsSat(ForwardPolicy.PROBE_SAT),
                ForwardPolicy.shortAddress(address),
            )
            state == ForwardState.PROBING_SENT -> getString(
                R.string.forward_card_probe_sent,
                Fmt.coinsSat(ForwardPolicy.PROBE_SAT),
                ForwardPolicy.shortAddress(address),
            )
            else -> buildString {
                append(getString(R.string.forward_card_armed, ForwardPolicy.shortAddress(address)))
                // Computed from OBSERVED block spacing, never from the 600 s
                // target -- the measured value is 815-868 s, so the target
                // would understate every estimate by about 40%.
                if (s.forwardEtaMs > 0) {
                    append(" Next forward in about ${Fmt.roughDuration(s.forwardEtaMs)}.")
                }
            }
        }

        // Ordinary blocked states are shown here and never notified: "nothing
        // mature yet" is what a healthy phone reports for most of every day.
        val blocked = s.forwardBlocked
        val showBlocked = blocked.isNotBlank() &&
            state != ForwardState.HOLDING &&
            sweep == null
        forwardBlocked.text = if (showBlocked) "Not forwarding: $blocked" else ""
        forwardBlocked.visibility = if (showBlocked) View.VISIBLE else View.GONE

        val error = s.forwardError.ifBlank { prefs.forwardLastError.orEmpty() }
        forwardError.text = error
        forwardError.visibility = if (error.isBlank()) View.GONE else View.VISIBLE

        // Sourced from persisted history, not from a live read, so it stays on
        // screen across restarts and does not vanish because a query failed.
        val lastTxid = prefs.forwardLastTxid
        if (lastTxid != null) {
            forwardLast.text = getString(
                R.string.forward_card_last,
                Fmt.coinsSat(prefs.forwardLastAmountSat),
                java.text.DateFormat.getDateTimeInstance(
                    java.text.DateFormat.MEDIUM,
                    java.text.DateFormat.SHORT,
                ).format(java.util.Date(prefs.forwardLastAtMs)),
                lastTxid,
            )
            forwardLast.visibility = View.VISIBLE
            forwardCopyTxid.visibility = View.VISIBLE
        } else {
            forwardLast.visibility = View.GONE
            forwardCopyTxid.visibility = View.GONE
        }

        forwardManage.setText(
            if (address == null) R.string.forward_card_set else R.string.forward_card_manage
        )
    }

    /** Never the word "sent" before a peer has taken the transaction. */
    private fun sweepWording(s: MinerState.Snapshot): String = when (s.forwardSweepState) {
        SweepState.BROADCASTING -> "building and sending"
        SweepState.BROADCAST -> "broadcast, waiting for a peer to take it"
        SweepState.ACCEPTED -> "accepted by the network, 0 of 1 confirmations"
        SweepState.CONFIRMED ->
            "confirmed (${maxOf(s.forwardSweepConfirmations, 1)} of ${ForwardPolicy.SETTLED_CONFIRMATIONS})"
        SweepState.SETTLED -> "settled"
        SweepState.FAILED_CONFLICTED -> "dropped; the coins are still in this wallet"
        null -> ""
    }

    // ---------------------------------------------------------------- slider

    private fun setUpSlider() {
        syncSliderFromPrefs()
        performance.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(sb: SeekBar, progress: Int, fromUser: Boolean) {
                // SeekBar has no `min` below API 26, so positions 0..9 map to
                // 10%..100% in the 10% steps the owner asked for.
                renderPerformanceLabel(progressToPercent(progress))
            }

            override fun onStartTrackingTouch(sb: SeekBar) {
                draggingSlider = true
            }

            override fun onStopTrackingTouch(sb: SeekBar) {
                draggingSlider = false
                val percent = progressToPercent(sb.progress)
                prefs.performancePercent = percent
                // Only poke the service if it is already up. Moving the slider
                // is a preference change, not a command to start mining.
                if (isRunning(MinerState.snapshot)) {
                    // Restarts the miner at the new thread count on the next tick.
                    MinerService.setPercent(this@MainActivity, percent)
                }
                renderPerformanceLabel(percent)
            }
        })
    }

    private fun syncSliderFromPrefs() {
        if (draggingSlider) return
        val percent = prefs.performancePercent
        performance.progress = percentToProgress(percent)
        renderPerformanceLabel(percent)
        if (!draggingThermal) {
            val limit = prefs.thermalLimit
            thermal.progress = (limit - Prefs.THERMAL_MODERATE).coerceIn(0, thermal.max)
            thermalValue.text = Prefs.thermalLabel(limit)
        }
    }

    /**
     * The heat cutoff, expressed as one of Android's own thermal levels rather
     * than a temperature. The platform aggregates CPU, GPU and skin sensors and
     * is tuned per device, so it knows a phone is struggling well before the
     * battery warms up.
     */
    /**
     * The wallet flavour ships the same screen with the mining controls removed.
     *
     * Removed, not disabled: a greyed-out Start Mining button on a wallet is an
     * invitation to tap it and a question to answer later. The read-only stats
     * (height, peers, balances) stay because they are exactly as true for a
     * wallet as for a miner -- both run the same node.
     *
     * This is the interim shape. The proper split gives the wallet its own
     * layout from shared card includes; until then one honest `GONE` beats a
     * layout rewrite next to money-handling code.
     */
    private fun hideMiningControlsIfWallet() {
        if (BuildConfig.MINING) return
        for (v in listOf<View>(toggle, performance, performanceValue, thermal, thermalValue)) {
            v.visibility = View.GONE
        }
        findViewById<View>(R.id.mine_on_battery)?.visibility = View.GONE
        findViewById<View>(R.id.always_on_warning)?.visibility = View.GONE
        findViewById<View>(R.id.blocks_found)?.visibility = View.GONE
        findViewById<View>(R.id.threads)?.visibility = View.GONE
        hashrate.visibility = View.GONE
    }

    private fun setUpThermalSlider() {
        thermal.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(sb: SeekBar, progress: Int, fromUser: Boolean) {
                thermalValue.text = Prefs.thermalLabel(progress + Prefs.THERMAL_MODERATE)
            }

            override fun onStartTrackingTouch(sb: SeekBar) {
                draggingThermal = true
            }

            override fun onStopTrackingTouch(sb: SeekBar) {
                draggingThermal = false
                // The service re-reads this every tick, so no command is needed.
                prefs.thermalLimit = sb.progress + Prefs.THERMAL_MODERATE
                thermalValue.text = Prefs.thermalLabel(prefs.thermalLimit)
            }
        })
    }

    /**
     * Uses the node's core count once it has reported one. bitcoind counts
     * ONLINE cores and caps the miner at that; availableProcessors() counts
     * configured cores, and on a big.LITTLE phone with cores hotplugged out
     * under load the two disagree. The node's number is the one that decides
     * how many threads actually run, so it is the one to show.
     */
    private fun renderPerformanceLabel(percent: Int) {
        val cores = MinerState.snapshot.cores.takeIf { it > 0 } ?: Prefs.cpuCores()
        performanceValue.text = Fmt.performance(percent, Prefs.threadsFor(percent, cores), cores)
    }

    private fun progressToPercent(progress: Int): Int =
        Prefs.clampPercent(Prefs.MIN_PERCENT + progress * Prefs.PERCENT_STEP)

    private fun percentToProgress(percent: Int): Int =
        ((Prefs.clampPercent(percent) - Prefs.MIN_PERCENT) / Prefs.PERCENT_STEP)
            .coerceIn(0, performance.max)

    // ----------------------------------------------------------------- render

    private fun isRunning(s: MinerState.Snapshot): Boolean = s.gate != Gate.STOPPED

    private fun render(s: MinerState.Snapshot) {
        renderWalletState(s)
        renderForwarding(s)
        renderPermissions()
        applyKeepScreenOn(s.gate == Gate.MINING)
        gateStatus.text = s.gateText()
        hashrate.text = if (s.gate == Gate.MINING) Fmt.hashrate(s.hashesPerSec) else getString(R.string.dash)

        toggle.setText(if (isRunning(s)) R.string.stop_mining else R.string.start_mining)

        notificationBanner.visibility = if (notificationsAllowed) View.GONE else View.VISIBLE

        // "Submitted", not "found": this is the miner's own counter of blocks it
        // solved and handed to the node. At this difficulty a good share of them
        // lose a reorg and are never paid, so it runs ahead of the wallet. It is
        // also per bitcoind process, hence "this session".
        blocksFound.text = "Blocks submitted (this session): ${Fmt.count(s.blocksFound)}"
        threads.text = "Threads: ${if (s.gate == Gate.MINING) s.threads else 0} of ${s.cores} cores (${s.percent}%)"

        height.text = "Height: ${Fmt.height(s.height, s.headers, s.verificationProgress)}"
        peers.text = "Peers: ${Fmt.count(s.peers)}"

        balanceConfirmed.text = "Confirmed: ${Fmt.coins(s.balanceConfirmed)}"
        balanceImmature.text = "Immature (mined, not yet spendable): ${Fmt.coins(s.balanceImmature)}"

        // Only ever populated when every getbalances figure was zero AND the
        // wallet has history, so this line appearing always means something the
        // three lines above cannot say.
        if (s.balanceInFlightCount > 0) {
            balanceInFlight.text = getString(
                R.string.balance_in_flight,
                s.balanceInFlightCount,
                Fmt.coins(s.balanceInFlight),
            )
            balanceInFlight.visibility = View.VISIBLE
        } else {
            balanceInFlight.visibility = View.GONE
        }

        val addr = s.payoutAddress.ifBlank { prefs.payoutAddress.orEmpty() }
        address.text = addr.ifBlank { getString(R.string.address_pending) }
        copyAddress.isEnabled = addr.isNotBlank()

        device.text = buildString {
            append(if (s.charging) "Charging" else "On battery")
            append(" · ")
            append(Fmt.temp(s.batteryTempC))
            append(" · cutoff ")
            append(Fmt.temp(MinerService.CUTOFF_TEMP_C))
        }

        // Keep the slider honest if the value was changed from elsewhere, and
        // keep its label honest if the node revised the core count.
        if (!draggingSlider) {
            if (progressToPercent(performance.progress) != prefs.performancePercent) {
                syncSliderFromPrefs()
            } else {
                renderPerformanceLabel(prefs.performancePercent)
            }
        }
    }

    // ------------------------------------------------------------ permissions

    private fun startMining() {
        MinerService.start(this)
    }

    private fun notificationsGranted(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED

    /**
     * POST_NOTIFICATIONS became a runtime permission in API 33, and the ongoing
     * "this phone is mining" notification is the app's only visible admission
     * that the CPU is busy. requestPermissions is asynchronous, so mining must
     * NOT be started in the same click: it waits for the answer.
     *
     * @return true if a permission dialog was raised and the caller should do
     *   nothing more; the service is started from [onRequestPermissionsResult].
     */
    private fun askForNotificationsFirst(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return false
        if (notificationsGranted()) return false
        if (permissionAsked) {
            // Already refused once; asking again in the same session does
            // nothing (Android will not re-prompt). Mine, but say plainly that
            // there will be no outside indication that mining is happening.
            notificationsAllowed = false
            return false
        }
        permissionAsked = true
        ActivityCompat.requestPermissions(
            this,
            arrayOf(Manifest.permission.POST_NOTIFICATIONS),
            REQ_NOTIFICATIONS,
        )
        return true
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQ_NOTIFICATIONS) return
        notificationsAllowed =
            grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
        if (!notificationsAllowed) {
            Toast.makeText(this, R.string.notifications_denied, Toast.LENGTH_LONG).show()
        }
        // Either way the user asked to mine; now that the answer is in, honour
        // it. On a denial the in-app banner becomes the indicator.
        startMining()
        ui.postDelayed({ render(MinerState.snapshot) }, 200)
    }

    // ----------------------------------------------------------- permissions

    /**
     * Mining has to survive the screen going off and the app going to the
     * background. Android only allows that with a foreground service (which
     * needs the notification permission) AND an exemption from Doze battery
     * optimisation. Neither can be granted in code, so the app states plainly
     * what is missing and opens the right system screen.
     */
    private fun setUpPermissionButtons() {
        permNotificationsBtn.setOnClickListener {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !notificationsGranted()) {
                ActivityCompat.requestPermissions(
                    this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIFICATIONS,
                )
            } else {
                openAppSettings()
            }
        }
        permBatteryBtn.setOnClickListener { requestBatteryExemption() }
        permAutostartBtn.setOnClickListener { openAppSettings() }
        findViewById<Button>(R.id.perm_unrestricted_btn).setOnClickListener { openAppSettings() }
    }

    /**
     * "Keep mining whatever happens" controls. Both are off by default and both
     * carry a visible warning, because both trade the health of the phone for
     * hashes and the owner should be making that trade knowingly.
     */
    private fun setUpAlwaysOn() {
        mineOnBattery.isChecked = prefs.mineOnBattery
        mineOnBattery.setOnCheckedChangeListener { _, checked ->
            prefs.mineOnBattery = checked
            renderAlwaysOnWarning()
        }
        renderAlwaysOnWarning()
    }

    private fun renderAlwaysOnWarning() {
        val risky = prefs.mineOnBattery || prefs.thermalLimit >= Prefs.THERMAL_NEVER
        alwaysOnWarning.visibility = if (risky) View.VISIBLE else View.GONE
    }

    private fun batteryExempt(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true
        val pm = getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return true
        return pm.isIgnoringBatteryOptimizations(packageName)
    }

    private fun requestBatteryExemption() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
        // Some builds ship without the dialog; fall back to the settings list.
        try {
            startActivity(
                Intent(
                    Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:$packageName"),
                ),
            )
        } catch (t: Throwable) {
            try {
                startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
            } catch (t2: Throwable) {
                Toast.makeText(this, R.string.perm_open_settings, Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun openAppSettings() {
        try {
            startActivity(
                Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")),
            )
        } catch (t: Throwable) {
            Toast.makeText(this, R.string.perm_open_settings, Toast.LENGTH_SHORT).show()
        }
    }

    private fun renderPermissions() {
        val notifOk = notificationsGranted()
        permNotifications.setText(
            if (notifOk) R.string.perm_notifications_ok else R.string.perm_notifications_missing,
        )
        permNotificationsBtn.visibility = if (notifOk) View.GONE else View.VISIBLE

        val batOk = batteryExempt()
        permBattery.setText(
            if (batOk) R.string.perm_battery_ok else R.string.perm_battery_missing,
        )
        permBatteryBtn.visibility = if (batOk) View.GONE else View.VISIBLE

        // The banner stays up until everything the app CAN verify is satisfied.
        // Manufacturer auto-start cannot be read programmatically, so it is
        // listed as a step but never blocks the "all set" state.
        val allSet = notifOk && batOk
        permSummary.setText(if (allSet) R.string.perm_all_set else R.string.perm_warning)
        permSummary.setBackgroundColor(if (allSet) 0x3300CC66 else 0x33FF8800)
        mineOnBattery.isChecked = prefs.mineOnBattery
        renderAlwaysOnWarning()
    }

    /**
     * Keeps the screen awake while actually hashing, so a user watching the app
     * does not have the device lock and suspend under them. Cleared as soon as
     * mining stops -- holding it while idle would drain the battery for nothing.
     */
    private fun applyKeepScreenOn(mining: Boolean) {
        if (mining) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }


    companion object {
        const val EXTRA_START_MINING = "start_mining"

        /**
         * Fleet provisioning extras, honoured in DEBUG BUILDS ONLY.
         *
         * Setting a forwarding address normally requires a device unlock,
         * because that address is the single most attack-worthy value in the
         * app: change it and every future reward silently goes elsewhere. That
         * gate is right for a phone someone carries, and useless for a rack of
         * fleet devices an operator already has a shell on -- anyone able to
         * send this intent could equally read the app's private storage.
         *
         * Restricting it to debuggable builds is what keeps the two cases
         * apart. The release APK, which is what an ordinary user installs,
         * does not contain this path at all: BuildConfig.DEBUG is a compile
         * time constant, so the body below is removed by the optimiser.
         *
         *   am start -n org.pcoin.miner/.MainActivity          *     --ei provision_percent 20          *     --es provision_forward_address pc1q...
         */
        const val EXTRA_PROVISION_PERCENT = "provision_percent"
        const val EXTRA_PROVISION_FORWARD = "provision_forward_address"

        /**
         * Last-resort ADB fallback -- deliberately short.
         *
         * An earlier version of this screen listed five commands. Checking them
         * against a real device showed that was wrong and slightly dishonest:
         *   - `dumpsys deviceidle whitelist +pkg` writes the SAME user whitelist
         *     the in-app Grant button writes (verified: the entry appears as
         *     "user,org.pcoin.miner"), so it asked people to plug in a computer
         *     to do something one tap already does;
         *   - RUN_IN_BACKGROUND / RUN_ANY_IN_BACKGROUND are "allow" by default
         *     and only become "ignore" if the user picks Battery > Restricted,
         *     which they undo in Settings;
         *   - `settings put global app_standby_enabled 0` is device-wide and
         *     degrades battery life for every app, not just this one;
         *   - `set-app-links` concerns deep links and has nothing to do with
         *     background execution.
         *
         * What remains is the one case with no user-facing equivalent: an OEM
         * build where the battery-optimisation dialog is missing or ignored.
         */
        private val ADB_COMMANDS = listOf(
            "# Only needed if the Grant buttons above did not stick,",
            "# which happens on a few heavily modified builds.",
            "adb shell dumpsys deviceidle whitelist +{pkg}",
            "",
            "# Check it worked - should print: user,{pkg}",
            "adb shell dumpsys deviceidle whitelist | grep {pkg}",
        ).joinToString(separator = "\n")

        private const val REFRESH_MS = 3_000L
        private const val REQ_NOTIFICATIONS = 101
    }
}
