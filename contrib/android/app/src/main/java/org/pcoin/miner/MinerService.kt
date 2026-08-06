package org.pcoin.miner

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.os.BatteryManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import org.pcoin.miner.wallet.Redact
import java.io.IOException
import kotlin.concurrent.thread

/**
 * The foreground service that runs the PCoin node and drives the miner.
 *
 * It is a foreground service because that is the honest thing to do: if the
 * phone is burning every spare cycle on RandomX, there must be a permanent
 * notification saying so, with a one-tap stop. It is also the only way Android
 * will let sustained background CPU work continue with the screen off.
 *
 * All node interaction happens on one worker thread. The UI never blocks on it;
 * it reads [MinerState.snapshot].
 *
 * The single most important invariant in this file: **the phone must never be
 * hashing while the gate is closed.** Every path that could leave a miner
 * running -- a failed RPC, a control-loop exception, a re-attach after the
 * process was killed -- sends stopmining before doing anything else.
 */
class MinerService : Service() {

    private lateinit var prefs: Prefs
    private lateinit var node: NodeController

    /**
     * Automatic forwarding, driven from this loop rather than a scheduler of
     * its own. It evaluates at most once a minute and only when the height
     * changed, so on almost every tick it costs one comparison. It never
     * throws: forwarding failing must not be able to stop the phone mining.
     */
    private lateinit var forward: ForwardEngine

    private var wakeLock: PowerManager.WakeLock? = null

    @Volatile
    private var alive = false

    @Volatile
    private var userWantsMining = true

    private var worker: Thread? = null

    /** Payout address, read from persisted state during bring-up. */
    @Volatile
    private var address: String = ""

    /** Wallets the node currently has loaded for us. */
    @Volatile
    private var loadedWallets: Set<String> = emptySet()

    /**
     * Set when the payout address changed under a running miner.
     *
     * The node's miner keeps paying whatever address it was started with, and
     * getcpuminerinfo does not report that address -- so without this flag a
     * miner that is already running at the right thread count looks perfectly
     * healthy while quietly paying every reward to the previous wallet.
     */
    @Volatile
    private var payoutAddressChanged = false

    /**
     * Temperature hysteresis latch. Once we pause for heat we stay paused until
     * the battery drops well below the cutoff, otherwise the miner would flap
     * on and off around 42 degrees, which is worse for the phone than either
     * state.
     */
    private var heatLatched = false

    /** Latched copy of the Android thermal gate, with one level of hysteresis. */
    private var thermalLatched = false

    /** Last thermal status read, for display. -1 when unavailable. */
    private var lastThermalStatus = -1

    /** Consecutive ticks where the node did not answer RPC. */
    private var rpcMisses = 0

    /** Consecutive failed bring-ups; too many means giving up rather than looping. */
    private var bringUpFailures = 0

    /** When the current node finished bring-up; used for the sync grace window. */
    @Volatile
    private var readyAtMs = 0L

    /**
     * Re-acquires the wake lock the moment the charger goes in.
     *
     * The lock is dropped while paused on battery (see [updateWakeLock]), which
     * means the control loop can be suspended in deep sleep exactly when we
     * would want it to notice that mining may resume. Plugging in wakes the
     * device to deliver this broadcast, which is the cheapest possible way to
     * get the loop ticking again.
     */
    private val powerReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == Intent.ACTION_POWER_CONNECTED && alive) acquireWakeLock()
        }
    }
    private var powerReceiverRegistered = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        prefs = Prefs(this)
        node = NodeController(this)
        forward = ForwardEngine(this, node)
        createChannel()
        // startForegroundService() gives us ~5 s to show a notification, so do
        // it before anything that could block.
        goForeground(buildNotification(MinerState.snapshot))
        acquireWakeLock()
        registerPowerReceiver()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                prefs.miningEnabled = false
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_SET_PERCENT -> {
                val p = intent.getIntExtra(EXTRA_PERCENT, Prefs.DEFAULT_PERCENT)
                prefs.performancePercent = p
                // The control loop notices the change on its next tick and
                // restarts the miner at the new thread count.
                MinerState.update { it.copy(percent = prefs.performancePercent) }
                if (worker?.isAlive != true) {
                    // Moving the slider must never be what starts mining. If the
                    // service was not already running, persist and get out.
                    stopSelf()
                    return START_NOT_STICKY
                }
                return START_STICKY
            }
            ACTION_PREPARE -> {
                // Bring the node up WITHOUT switching mining on.
                //
                // Wallet setup needs a running node to talk to, and it must be
                // able to get one without that being read as "the user asked to
                // mine". Deliberately does not touch prefs.miningEnabled: that
                // flag is the user's own persisted intent and nothing but a
                // user action may write it.
                Log.i(TAG, "preparing node for wallet setup")
            }
            else -> {
                // ACTION_START, or a null intent from a START_STICKY restart.
                // MINING=false means this build has no mining UI to have sent
                // ACTION_START, but a START_STICKY restart delivers a null
                // intent and lands here too -- so it is guarded rather than
                // trusted.
                if (BuildConfig.MINING) prefs.miningEnabled = true
            }
        }

        userWantsMining = wantsMining()
        startWorker()
        return START_STICKY
    }

    /**
     * Does this build mine at all?
     *
     * The wallet flavour ships the same node and the same wallet but must never
     * mine, so the answer is the user's persisted intent AND a build constant.
     * Read through this rather than off `prefs.miningEnabled` directly: the
     * pref is the user's intent and stays whatever it was, which matters if a
     * datadir is ever moved between the two apps.
     *
     * Note this only stops THIS APP from asking. The bundled bitcoind contains
     * the CPU miner regardless, which is why the wallet also sends an explicit
     * stopmining at bring-up.
     */
    private fun wantsMining(): Boolean = BuildConfig.MINING && prefs.miningEnabled

    /**
     * Starts the control thread if it is not already running.
     *
     * The liveness check matters: a thread that exited (interrupted mid-sleep,
     * say) would otherwise leave a non-null handle behind forever, and every
     * later start request would silently do nothing while the service kept its
     * foreground notification and its wake lock.
     */
    @Synchronized
    private fun startWorker() {
        if (worker?.isAlive == true) return
        alive = true
        val t = thread(start = false, name = "pcoin-miner-control", isDaemon = false) {
            try {
                workerLoop()
            } finally {
                clearWorker(Thread.currentThread())
            }
        }
        worker = t
        t.start()
    }

    @Synchronized
    private fun clearWorker(self: Thread) {
        if (worker === self) worker = null
    }

    override fun onDestroy() {
        alive = false
        MinerState.markStopped()
        worker?.interrupt()

        // bitcoind must be asked to stop cleanly: it flushes the chainstate on
        // shutdown, and a kill mid-flush costs a long reindex next launch. Do it
        // off the main thread so onDestroy cannot ANR, but join briefly so the
        // request is definitely sent before the process can be reclaimed.
        val stopper = thread(name = "pcoin-shutdown", isDaemon = false) {
            try {
                node.shutdown()
            } catch (t: Throwable) {
                Log.w(TAG, "shutdown error: ${t.message}")
            }
        }
        stopper.join(DESTROY_JOIN_MS)

        unregisterPowerReceiver()
        releaseWakeLock()
        // An in-flight tick can re-post the notification after startForeground
        // state is gone; make sure nothing survives this call.
        try {
            getSystemService(NotificationManager::class.java)?.cancel(NOTIF_ID)
        } catch (t: Throwable) {
            Log.w(TAG, "notification cancel: ${t.message}")
        }
        super.onDestroy()
    }

    // ------------------------------------------------------------ control loop

    private fun workerLoop() {
        while (alive) {
            try {
                bringUp()
                bringUpFailures = 0
                runTicks()
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
                return
            } catch (t: Throwable) {
                if (!alive) return
                // Whatever went wrong, the node may still be hashing: the miner
                // outlives an RPC failure, an exception in this loop and even
                // this process. Closing the gate is the first thing to do.
                node.stopMining(STOP_MINING_TIMEOUT_MS)
                Log.w(TAG, "control loop failed, retrying: ${Redact.text(t)}")
                bringUpFailures++
                // Redacted before it goes anywhere: `why` ends up in
                // MinerState.detail, which is rendered into the ONGOING
                // NOTIFICATION. Notifications are persisted by the system,
                // visible on the lock screen, and readable by any app with
                // notification-listener access, so a node error string that
                // echoed a descriptor back would be about the worst place for
                // it to land.
                val why = Redact.text(t.message ?: t.javaClass.simpleName).take(200)
                if (bringUpFailures >= MAX_BRINGUP_FAILURES) {
                    // Looping forever on an unrecoverable node (corrupt datadir
                    // asking for -reindex, for example) burns battery and tells
                    // the user nothing new. Stop, leaving the reason on screen.
                    MinerState.update {
                        it.copy(
                            gate = Gate.ERROR,
                            detail = "gave up after $bringUpFailures attempts: $why",
                            hashesPerSec = 0.0,
                            threads = 0,
                        )
                    }
                    pushNotification()
                    alive = false
                    stopSelf()
                    return
                }
                MinerState.update {
                    it.copy(gate = Gate.ERROR, detail = why, hashesPerSec = 0.0, threads = 0)
                }
                pushNotification()
                if (!sleepInterruptibly(RETRY_DELAY_MS)) return
            }
        }
    }

    /** Node bring-up. Throws on anything that makes mining impossible. */
    private fun bringUp() {
        readyAtMs = 0L
        // Whatever the forwarding engine believed about the previous node is no
        // longer evidence of anything; it re-reconciles below.
        forward.onNodeLost()
        setStarting("preparing datadir")
        node.writeConf()

        when (node.probe()) {
            NodeController.Probe.OURS_READY, NodeController.Probe.OURS_WARMUP -> {
                // A node we started earlier is still alive (service restart).
                // Re-attach: spawning a second one would mean two RandomX
                // caches and two miners contending for the same cores.
                node.markAttached()
                setStarting("re-attaching to running node")
            }
            NodeController.Probe.FOREIGN -> throw NodeController.NodeStartException(
                "Port ${node.rpc.port} is already in use by another PCoin node. " +
                    "Stop it before mining from this app."
            )
            NodeController.Probe.NO_NODE -> {
                setStarting("launching node")
                node.spawn()
            }
        }

        node.awaitRpc { phase -> setStarting(phase) }

        // The node we just attached to may have been left mining by a previous
        // instance of this service (START_STICKY restart, process kill). Nothing
        // below has looked at the battery yet, and ensureWallet/ensureAddress can
        // block for a minute, so silence the miner before going any further.
        node.stopMining(STOP_MINING_TIMEOUT_MS)

        setStarting("opening wallet")
        // Loads the wallets this install owns and creates none. A fresh install
        // has none at all, and that is a correct state to be in: the wallet is
        // created by the setup flow, from a recovery phrase, not here.
        loadedWallets = node.loadKnownWallets()

        // The persisted payout address is authoritative. It is not verified
        // here and it is certainly not replaced here -- see
        // NodeController.payoutAddressStillOwned for why an "authoritative"
        // false from a wallet-scoped RPC is not trustworthy enough to act on.
        address = node.payoutAddress().orEmpty()
        MinerState.update {
            it.copy(
                payoutAddress = address,
                hasSeedWallet = prefs.seedWalletName?.let { w -> w in loadedWallets } == true,
                hasLegacyWallet = Prefs.LEGACY_WALLET in loadedWallets &&
                    Prefs.LEGACY_WALLET != prefs.seedWalletName,
            )
        }

        // Startup reconciliation, before the first tick and before any build is
        // permitted: an interrupted send has to be resolved (or an in-flight
        // wallet transaction adopted) before forwarding may consider a new one.
        setStarting("checking forwarding")
        forward.onNodeReady(loadedWallets)

        readyAtMs = System.currentTimeMillis()
    }

    /** Steady-state loop. Returns only when the service is stopping; throws to force a re-bring-up. */
    private fun runTicks() {
        while (alive) {
            tick()
            if (!sleepInterruptibly(TICK_MS)) return
        }
    }

    private fun tick() {
        if (!node.nodeAlive) {
            throw NodeController.NodeStartException("bitcoind exited: ${node.startupError()}")
        }

        val battery = readBattery()
        val percent = prefs.performancePercent
        userWantsMining = wantsMining()

        // The setup flow can finish while the service is already running, and it
        // writes the payout address straight to Prefs. Pick it up without
        // demanding a restart.
        //
        // This reads PERSISTED INTENT, which is authoritative, so adopting a
        // change is correct -- unlike the node observations elsewhere in this
        // file, which are not allowed to overwrite it. The guard is one-way: a
        // blank or missing value never clears an address we already hold.
        //
        // Adopting the change promptly is the whole point of the migration
        // plan's "redirect mining payouts immediately" step: from the moment a
        // user with a pre-phrase wallet creates a phrase, every block reward
        // must go to the wallet those words recover, not the old one.
        val saved = node.payoutAddress()
        if (!saved.isNullOrBlank() && saved != address) {
            val previous = address
            address = saved
            payoutAddressChanged = previous.isNotBlank()
            loadedWallets = node.loadKnownWallets()
            Log.i(TAG, "payout address updated from settings; wallets loaded: $loadedWallets")
            MinerState.update { it.copy(payoutAddress = saved) }
        }

        val stats = try {
            node.stats(loadedWallets).also { rpcMisses = 0 }
        } catch (e: RpcClient.NotReady) {
            if (!alive) return
            // A forward evaluation holds cs_wallet inside the node for the
            // length of a listunspent, a batch of gettransaction calls and a
            // sendall, and getbalances below needs the same lock. Counting a
            // stats poll starved by our OWN feature as evidence that the node
            // has stopped answering would tear the node down and stop mining
            // because a forward was in progress. A genuinely dead node fails
            // the worker's RPCs just as fast, so this only ever defers
            // detection by that worker's remaining timeout.
            if (!forward.isEvaluating()) rpcMisses++
            // The gate applies even when the node is not answering. Nothing here
            // proves the miner has stopped -- getcpuminerinfo failing tells us
            // exactly nothing about whether RandomX threads are running -- so if
            // the gate is closed, keep asking it to stop.
            if (decideGate(battery, syncing = false) != Gate.MINING) {
                node.stopMining(STOP_MINING_TIMEOUT_MS)
            }
            // Only after the stop attempt: dropping the lock first could let the
            // device suspend in the middle of it.
            updateWakeLock(battery.charging)
            if (rpcMisses >= MAX_RPC_MISSES) {
                // Persistently unreachable. This is the only way to notice that
                // a node we merely ATTACHED to (no Process handle, so nodeAlive
                // cannot tell) has gone away. Force a full re-bring-up.
                rpcMisses = 0
                throw NodeController.NodeStartException(
                    "node stopped answering RPC: ${e.message}"
                )
            }
            // Transient: the node is busy (reindex, big block). Keep the last
            // chain numbers on screen rather than flashing "--" at the user, but
            // never keep claiming a hash rate we can no longer observe.
            MinerState.update {
                it.copy(gate = Gate.STARTING, detail = "node busy", hashesPerSec = 0.0, threads = 0)
            }
            pushNotification()
            return
        }

        // The service may have been stopped while that round trip was in flight.
        // Anything below would resurrect the notification and the dashboard.
        if (!alive) return

        // Thread counts must be expressed in the core count the NODE uses.
        // availableProcessors() reports configured cores; bitcoind caps threads
        // at hardware_concurrency() (online cores), and on a big.LITTLE phone
        // under thermal pressure those differ. Comparing against our own number
        // would re-issue startmining every tick, and each one tears down and
        // recreates every worker thread.
        val cores = stats.miner?.cores?.takeIf { it > 0 } ?: Prefs.cpuCores()
        val threads = Prefs.threadsFor(percent, cores)

        val gate = decideGate(battery, syncing = isSyncing(stats))
        val justStarted = reconcileMiner(gate, threads, stats.miner)
        updateWakeLock(battery.charging)
        if (!alive) return

        val miner = stats.miner
        // For the tick on which the miner was (re)started, "Mining" would be a
        // lie: the RandomX dataset is still being built and the node has not
        // produced a hash rate sample yet. Say "starting" until it has.
        val minerRunning = !justStarted && miner?.mining == true
        val shown = if (gate == Gate.MINING && !minerRunning) Gate.STARTING else gate
        val detail = if (shown == Gate.STARTING) "starting miner ($threads threads)" else ""

        val total = stats.totalBalance
        MinerState.update {
            it.copy(
                gate = shown,
                // Gate.gateText() already spells out every steady-state reason,
                // so `detail` is only carried for STARTING and ERROR.
                detail = detail,
                hashesPerSec = if (shown == Gate.MINING) (miner?.hashesPerSec ?: 0.0) else 0.0,
                threads = if (shown == Gate.MINING) (miner?.threads ?: threads) else 0,
                cores = cores,
                percent = percent,
                blocksFound = miner?.blocksFound ?: it.blocksFound,
                height = stats.height,
                headers = stats.headers,
                verificationProgress = stats.verificationProgress,
                peers = stats.peers,
                balanceConfirmed = total.confirmed,
                balanceImmature = total.immature,
                balancePending = total.pending,
                balanceInFlight = total.inFlight,
                balanceInFlightCount = total.inFlightCount,
                seedConfirmed = stats.seedBalance?.confirmed ?: -1.0,
                seedImmature = stats.seedBalance?.immature ?: -1.0,
                hasSeedWallet = prefs.seedWalletName?.let { w -> w in loadedWallets } == true,
                legacyConfirmed = stats.legacyBalance?.confirmed ?: -1.0,
                legacyImmature = stats.legacyBalance?.immature ?: -1.0,
                hasLegacyWallet = Prefs.LEGACY_WALLET in loadedWallets &&
                    Prefs.LEGACY_WALLET != prefs.seedWalletName,
                payoutAddress = address,
                charging = battery.charging,
                batteryTempC = battery.tempC,
                thermalStatus = lastThermalStatus,
            )
        }

        // Forwarding rides on this tick rather than a scheduler of its own: the
        // decision to evaluate is made here, from the height this loop already
        // reads. The evaluation itself is handed to a worker, because it is up
        // to half a dozen RPCs and this loop's 3 s poll is what feeds the
        // node's 45-second miner dead-man switch. On almost every tick this
        // call is one comparison, and it swallows its own errors.
        forward.onTick(stats, loadedWallets, alive)

        pushNotification()
    }

    /**
     * Brings the node's miner into line with what the gate allows.
     *
     * startmining is idempotent in PCoin (CpuMiner::Start restarts cleanly when
     * already running), so a performance-slider change is one call with no gap
     * in hashing.
     *
     * @return true if a start was issued on this call.
     */
    private fun reconcileMiner(gate: Gate, threads: Int, info: NodeController.MinerInfo?): Boolean {
        // The service may have been told to stop while this tick was in flight;
        // do not start hashing on the way out.
        if (!alive) return false
        try {
            if (gate == Gate.MINING) {
                // The node caps threads at its own core count, so compare
                // against what it could actually have started.
                val effective = if (info != null && info.cores > 0) minOf(threads, info.cores) else threads
                // payoutAddressChanged forces a restart even when the miner
                // looks fine: the node cannot be asked which address it is
                // paying, so a running miner is NOT evidence that it is paying
                // the right one.
                val needsStart = payoutAddressChanged ||
                    info == null || !info.mining || info.threads != effective
                if (needsStart) {
                    if (address.isBlank()) return false
                    // The very first start builds the ~256 MiB RandomX cache and
                    // can take a few seconds; say so instead of looking hung.
                    MinerState.update { it.copy(gate = Gate.STARTING, detail = "starting miner ($threads threads)") }
                    pushNotification()
                    node.startMining(address, threads)
                    // Only cleared once a start has actually been issued for
                    // the new address, so a failed call gets retried next tick
                    // rather than being forgotten.
                    payoutAddressChanged = false
                    return true
                }
            } else {
                // A null miner section means "unknown", NOT "idle": batch()
                // maps a failed getcpuminerinfo to null, and assuming idle there
                // is how a phone ends up hashing on battery while the UI says
                // it is paused. stopmining is cheap and idempotent, so send it
                // whenever the miner is not known to be stopped.
                if (info == null || info.mining) {
                    node.stopMining(STOP_MINING_TIMEOUT_MS)
                }
            }
        } catch (e: IOException) {
            // A gate transition must never take the service down. Log it, leave
            // the state alone, and try again on the next tick.
            Log.w(TAG, "miner reconcile failed: ${e.message}")
        }
        return false
    }

    private fun decideGate(battery: Battery, syncing: Boolean): Gate {
        val gate = when {
            // Checked first, before even the user's own switch: with no payout
            // address there is nothing to mine TO. startmining only validates
            // that an address parses -- it never checks that a wallet owns it --
            // so an empty or invented address means block rewards paid to a key
            // nobody can ever recover. Refuse, and say why.
            address.isBlank() -> Gate.NEEDS_SETUP
            !userWantsMining -> Gate.PAUSED_BY_USER
            !battery.charging && !prefs.mineOnBattery -> Gate.PAUSED_NOT_CHARGING
            isThermallyStressed() -> Gate.PAUSED_THERMAL
            // "Never stop for heat" also retires the battery-temperature
            // cutoff. Leaving it in would make the setting a lie: the platform
            // gate would be off while a second, cruder one still stopped
            // mining at 42 C.
            prefs.thermalLimit < Prefs.THERMAL_NEVER && battery.tempC.isNaN() -> Gate.PAUSED_NO_TEMP
            prefs.thermalLimit < Prefs.THERMAL_NEVER && isTooHot(battery.tempC) -> Gate.PAUSED_TOO_HOT
            syncing -> Gate.WAITING_SYNC
            else -> Gate.MINING
        }
        Log.i(
            TAG_THERMAL,
            "gate=$gate charging=${battery.charging} onBatteryAllowed=${prefs.mineOnBattery} " +
                "batteryTemp=${battery.tempC} thermal=${lastThermalStatus} " +
                "thermalLimit=${prefs.thermalLimit} syncing=$syncing",
        )
        return gate
    }

    /**
     * Android's own view of whether the device is overheating.
     *
     * Checked before the battery cutoff because it is the better signal: the
     * platform aggregates CPU, GPU, skin and battery sensors, tuned per device.
     * Returns false when unavailable (API < 29, or the call throws), in which
     * case the battery cutoff below is the only thermal protection.
     *
     * Latched with one level of hysteresis so a phone hovering on the boundary
     * does not start and stop mining every few seconds.
     */
    private fun isThermallyStressed(): Boolean {
        val status = readThermalStatus()
        lastThermalStatus = status
        if (status < 0) {
            // Fail CLOSED. An earlier version returned false here, i.e. "not
            // hot, carry on" -- the wrong default for a safety check, and the
            // reason a phone was able to cook itself. If the platform will not
            // tell us how hot it is, we do not mine.
            //
            // The one exception is a device too old to have the API at all
            // (below Android 10), where the battery cutoff is the only
            // protection available and refusing to mine would be pointless.
            return Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
        }
        val limit = prefs.thermalLimit
        val was = thermalLatched
        thermalLatched = if (thermalLatched) status >= limit - 1 else status >= limit
        // Logged every tick on purpose: when a phone overheats, the first
        // question is always "was the check actually running?", and a silent
        // safety check is impossible to trust after the fact.
        Log.i(
            TAG_THERMAL,
            "status=$status (${thermalName(status)}) limit=$limit (${Prefs.thermalLabel(limit)}) " +
                "latched=$thermalLatched decision=${if (thermalLatched) "STOP MINING" else "ok to mine"}",
        )
        if (thermalLatched != was) {
            Log.w(TAG_THERMAL, if (thermalLatched) "THERMAL GATE CLOSED at status=$status" else "thermal gate reopened at status=$status")
        }
        return thermalLatched
    }

    private fun thermalName(status: Int): String = when (status) {
        0 -> "NONE"; 1 -> "LIGHT"; 2 -> "MODERATE"; 3 -> "SEVERE"
        4 -> "CRITICAL"; 5 -> "EMERGENCY"; 6 -> "SHUTDOWN"; else -> "UNKNOWN"
    }

    private fun readThermalStatus(): Int {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return -1
        return try {
            (getSystemService(Context.POWER_SERVICE) as PowerManager).currentThermalStatus
        } catch (t: Throwable) {
            Log.w(TAG, "thermal status unavailable: ${t.message}")
            -1
        }
    }

    /**
     * True while the node is still catching up.
     *
     * Mining before the chain is synced produces blocks on top of a stale tip
     * that the next reorg discards -- wasted CPU, and an "Immature" balance
     * that vanishes minutes later.
     *
     * The test is height >= headers rather than the node's own
     * initialblockdownload flag, because IsInitialBlockDownload() also stays
     * true when the real tip is simply older than a day; keying on it alone
     * could pause mining forever on a quiet chain. initialblockdownload is
     * still honoured for the first [SYNC_GRACE_MS] after bring-up, which is the
     * window where the node has a height but has not learned any headers yet
     * and height >= headers is trivially (and wrongly) satisfied.
     */
    private fun isSyncing(stats: NodeController.Stats): Boolean {
        if (stats.height < 0 || stats.headers < 0) return true
        // Tolerate being a couple of blocks behind. `height == headers` is far
        // too strict on a fast chain: PCoin is currently producing a block
        // every ~6 s, so a node at the tip is momentarily "behind" almost
        // constantly, and an exact test made the gate flap -- observed on a
        // Pixel 4a starting and stopping the miner every 18 s, never mining
        // usefully. A node within a few blocks of the tip is mining on top of
        // the real chain, which is the thing this check exists to guarantee.
        if (stats.headers - stats.height > SYNC_TOLERANCE_BLOCKS) return true
        val ready = readyAtMs
        return stats.initialBlockDownload &&
            ready != 0L &&
            System.currentTimeMillis() - ready < SYNC_GRACE_MS
    }

    /**
     * Cutoff at [CUTOFF_TEMP_C], resume only once back under [RESUME_TEMP_C].
     *
     * An unreadable temperature counts as too hot. The thermal cutoff is the
     * only protection left once the phone is plugged in, and treating "unknown"
     * as "cool" would silently disable it.
     */
    private fun isTooHot(tempC: Float): Boolean {
        // Leave the latch untouched: a single unreadable sample must not be
        // able to clear a hot latch and resume mining.
        if (tempC.isNaN()) return true
        heatLatched = if (heatLatched) tempC > RESUME_TEMP_C else tempC >= CUTOFF_TEMP_C
        return heatLatched
    }

    // ---------------------------------------------------------------- battery

    private data class Battery(val charging: Boolean, val tempC: Float)

    /**
     * Reads the sticky ACTION_BATTERY_CHANGED broadcast. Passing a null receiver
     * just returns the last value; nothing is registered, so nothing leaks and
     * no RECEIVER_EXPORTED flag is involved.
     */
    private fun readBattery(): Battery {
        val i = try {
            registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        } catch (t: Throwable) {
            Log.w(TAG, "battery read failed: ${t.message}")
            null
        } ?: return Battery(charging = false, tempC = Float.NaN)

        // EXTRA_PLUGGED is the ONLY signal used, deliberately. EXTRA_STATUS is
        // derived and unreliable in both directions:
        //   - Samsung kernels latch status=FULL at level 100 for a long window
        //     after the charger is pulled;
        //   - a Pixel 4a keeps reporting status=CHARGING (2) with every
        //     *_powered flag false, verified here after `dumpsys battery
        //     unplug` -- so OR-ing it in meant the phone happily mined on
        //     battery.
        // Plugged is unambiguous: 0 means no external power, anything else is
        // AC / USB / wireless / dock. That is exactly the question being asked.
        val plugged = i.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0)
        val charging = plugged != 0

        // EXTRA_TEMPERATURE is tenths of a degree Celsius. -1 means unknown.
        val raw = i.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Int.MIN_VALUE)
        val tempC = if (raw == Int.MIN_VALUE || raw <= 0) Float.NaN else raw / 10.0f

        return Battery(charging, tempC)
    }

    // ----------------------------------------------------------- notification

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val mgr = getSystemService(NotificationManager::class.java) ?: return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "PCoin mining",
            // LOW: always visible, never makes a sound. This notification is
            // present for the entire mining session.
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "Shows that the phone is mining PCoin, and its hash rate."
            setShowBadge(false)
        }
        mgr.createNotificationChannel(channel)
    }

    private fun goForeground(n: Notification) {
        ServiceCompat.startForeground(this, NOTIF_ID, n, foregroundServiceType())
    }

    /**
     * From API 34 the type must match one declared in the manifest.
     *
     * specialUse is the honest description of a cryptocurrency node and, unlike
     * dataSync, it is not subject to the 6-hour-per-day cap Android 15 applies
     * once targetSdk reaches 35 -- which would otherwise kill an overnight
     * mining session. dataSync remains for API 29..33, where specialUse does
     * not exist.
     */
    private fun foregroundServiceType(): Int = when {
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE ->
            ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ->
            ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
        else -> 0
    }

    private fun pushNotification() {
        if (!alive) return
        val mgr = getSystemService(NotificationManager::class.java) ?: return
        try {
            mgr.notify(NOTIF_ID, buildNotification(MinerState.snapshot))
        } catch (t: Throwable) {
            // Missing POST_NOTIFICATIONS on API 33+ makes notify a no-op, but be
            // defensive: mining must not stop because a notification failed.
            Log.w(TAG, "notify failed: ${t.message}")
        }
    }

    private fun buildNotification(s: MinerState.Snapshot): Notification {
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val stop = PendingIntent.getService(
            this,
            1,
            Intent(this, MinerService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val title = if (s.gate == Gate.MINING) {
            "Mining — ${Fmt.hashrate(s.hashesPerSec)}"
        } else {
            s.gateText()
        }
        val body = buildString {
            if (s.gate == Gate.MINING) {
                append("${s.threads} of ${s.cores} cores · ${Fmt.temp(s.batteryTempC)} · block ${Fmt.count(s.height)}")
            } else {
                append("PCoin node running · block ${Fmt.count(s.height)}")
            }
            // One extra line only while a forward is actually in flight, and
            // never worded as "sent" before a peer has taken it.
            forwardLine(s)?.let { append("\n"); append(it) }
        }

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setContentIntent(open)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Stop", stop)
            .build()
    }

    /**
     * The forwarding line for the ongoing notification, or null for none.
     *
     * BROADCAST is deliberately not called "sent": sendrawtransaction returning
     * a txid only proves the local mempool took it, and on a phone with one
     * peer that can mean nobody else has seen it. ACCEPTED is the first state
     * where the node's own unbroadcast flag has cleared, i.e. a peer asked for
     * the transaction and got it.
     */
    private fun forwardLine(s: MinerState.Snapshot): String? {
        val state = s.forwardSweepState ?: return null
        val amount = Fmt.coinsSat(s.forwardSweepAmountSat)
        return when (state) {
            SweepState.BROADCASTING -> "Forwarding $amount — sending"
            SweepState.BROADCAST -> "Forwarding $amount — waiting for a peer"
            SweepState.ACCEPTED -> "Forwarding $amount — accepted by the network"
            SweepState.CONFIRMED -> "Forwarding $amount — confirming"
            SweepState.SETTLED, SweepState.FAILED_CONFLICTED -> null
        }
    }

    // ----------------------------------------------------------------- misc

    private fun setStarting(phase: String) {
        MinerState.update {
            it.copy(gate = Gate.STARTING, detail = phase, hashesPerSec = 0.0, threads = 0)
        }
        pushNotification()
    }

    private fun registerPowerReceiver() {
        if (powerReceiverRegistered) return
        try {
            ContextCompat.registerReceiver(
                this,
                powerReceiver,
                IntentFilter(Intent.ACTION_POWER_CONNECTED),
                ContextCompat.RECEIVER_NOT_EXPORTED,
            )
            powerReceiverRegistered = true
        } catch (t: Throwable) {
            Log.w(TAG, "power receiver: ${t.message}")
        }
    }

    private fun unregisterPowerReceiver() {
        if (!powerReceiverRegistered) return
        try {
            unregisterReceiver(powerReceiver)
        } catch (t: Throwable) {
            Log.w(TAG, "power receiver unregister: ${t.message}")
        }
        powerReceiverRegistered = false
    }

    /**
     * The wake lock exists so hashing survives the screen going off. Holding it
     * on battery would do the opposite of what the gate is for: it would keep
     * the CPU (and a full node syncing to flash) awake on the user's charge
     * with no mining to show for it. So it follows the charger.
     */
    private fun updateWakeLock(charging: Boolean) {
        if (charging) acquireWakeLock() else releaseWakeLock()
    }

    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) return
        val pm = getSystemService(PowerManager::class.java) ?: return
        val lock = wakeLock ?: pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "pcoin:miner").apply {
            setReferenceCounted(false)
        }
        wakeLock = lock
        try {
            lock.acquire()
        } catch (t: Throwable) {
            Log.w(TAG, "wakelock acquire: ${t.message}")
        }
    }

    private fun releaseWakeLock() {
        try {
            wakeLock?.takeIf { it.isHeld }?.release()
        } catch (t: Throwable) {
            Log.w(TAG, "wakelock release: ${t.message}")
        }
    }

    /** @return false if the service is stopping and the loop should exit. */
    private fun sleepInterruptibly(ms: Long): Boolean {
        val end = System.currentTimeMillis() + ms
        while (alive && System.currentTimeMillis() < end) {
            try {
                Thread.sleep(minOf(250L, end - System.currentTimeMillis()).coerceAtLeast(1L))
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
                return false
            }
        }
        return alive
    }

    companion object {
        const val TAG = "PCoinService"

        const val ACTION_START = "org.pcoin.miner.action.START"
        const val ACTION_STOP = "org.pcoin.miner.action.STOP"
        const val ACTION_SET_PERCENT = "org.pcoin.miner.action.SET_PERCENT"
        const val ACTION_PREPARE = "org.pcoin.miner.action.PREPARE"
        const val EXTRA_PERCENT = "percent"

        private const val CHANNEL_ID = "pcoin_mining"
        private const val NOTIF_ID = 1001

        private const val TICK_MS = 3_000L

        /**
         * Five missed ticks before we assume the node is gone and rebuild. With
         * a 10 s stats timeout that is at most ~65 s, and the gate is enforced
         * (stopmining is re-sent) on every one of those ticks.
         */
        private const val MAX_RPC_MISSES = 5

        /** stopmining must not block a gate transition for long. */
        private const val STOP_MINING_TIMEOUT_MS = 15_000

        private const val RETRY_DELAY_MS = 20_000L
        private const val DESTROY_JOIN_MS = 8_000L

        /** Consecutive failed bring-ups before the service gives up entirely. */
        private const val MAX_BRINGUP_FAILURES = 5

        /** How long after bring-up the node's own IBD flag is trusted. */
        /** Dedicated tag so the safety decisions can be filtered out of logcat. */
        const val TAG_THERMAL = "PCoinThermal"

        private const val SYNC_GRACE_MS = 120_000L

        /**
         * How many blocks behind the header tip still counts as synced.
         *
         * Blocks and headers arrive as separate messages, so a node at the tip
         * of a fast chain reads as "behind" for a fraction of a second on every
         * new block. Requiring exact equality turned that into a start/stop
         * loop that never mined.
         */
        private const val SYNC_TOLERANCE_BLOCKS = 3L

        /** Non-negotiable battery protection. */
        const val CUTOFF_TEMP_C = 42.0f

        /** Hysteresis: resume only once comfortably back below the cutoff. */
        const val RESUME_TEMP_C = 40.0f

        fun start(context: Context) = send(context, Intent(context, MinerService::class.java).setAction(ACTION_START))

        fun stop(context: Context) = send(context, Intent(context, MinerService::class.java).setAction(ACTION_STOP))

        /** Bring the node up for wallet setup, without switching mining on. */
        fun prepare(context: Context) =
            send(context, Intent(context, MinerService::class.java).setAction(ACTION_PREPARE))

        fun setPercent(context: Context, percent: Int) = send(
            context,
            Intent(context, MinerService::class.java)
                .setAction(ACTION_SET_PERCENT)
                .putExtra(EXTRA_PERCENT, percent),
        )

        /**
         * Always a foreground start, including for STOP: a plain startService()
         * from the background (the notification's Stop action, after the service
         * has already died) throws on API 26+. onCreate calls startForeground
         * before anything else, so this is safe for every action.
         */
        private fun send(context: Context, intent: Intent) {
            try {
                ContextCompat.startForegroundService(context, intent)
            } catch (t: Throwable) {
                Log.w(TAG, "service start failed: ${t.message}")
            }
        }
    }
}
