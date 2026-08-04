package org.pcoin.miner

/**
 * Why the miner is or is not currently hashing.
 *
 * The gate exists to protect the phone's battery: PCoin only mines while the
 * device is plugged in and cool. Every non-mining state carries a reason that
 * is shown verbatim in the UI and the notification, so it is never a mystery
 * why the phone stopped working.
 */
enum class Gate {
    /** Service is not running at all. */
    STOPPED,

    /** Node is booting: process spawn, RPC warmup, wallet load. */
    STARTING,

    /** Hashing right now. */
    MINING,

    /** Node is up but the user switched mining off. */
    PAUSED_BY_USER,

    /** Not plugged in. Mining on battery is never allowed. */
    PAUSED_NOT_CHARGING,

    /**
     * Android's own thermal service says the device is overheating. Checked
     * before the battery cutoff because it sees CPU, GPU and skin sensors,
     * which react long before the battery warms up.
     */
    PAUSED_THERMAL,

    /** Battery temperature at or above the cutoff. */
    PAUSED_TOO_HOT,

    /**
     * Battery temperature could not be read. The thermal cutoff is the only
     * thing protecting the battery once the phone is plugged in, so an unknown
     * temperature pauses rather than being treated as "cool".
     */
    PAUSED_NO_TEMP,

    /**
     * The chain is not caught up yet. Mining on top of a stale tip only
     * produces blocks that are thrown away by the next reorg.
     */
    WAITING_SYNC,

    /**
     * The node is up but there is no wallet to pay to yet.
     *
     * Reached on a fresh install before the user has created or restored a
     * recovery phrase. Mining is refused rather than quietly paying rewards to
     * a freshly invented key that no phrase could ever recover.
     */
    NEEDS_SETUP,

    /** Node failed to start or died. [MinerState.Snapshot.detail] says how. */
    ERROR,
}

/**
 * Process-wide snapshot of what the miner is doing.
 *
 * The service and the activity live in the same process, so a plain volatile
 * immutable snapshot is all the coupling that is needed: the service writes it
 * from its worker thread, the activity reads it on a 3 s UI timer. No binder,
 * no broadcasts, nothing to leak.
 */
object MinerState {

    data class Snapshot(
        val gate: Gate = Gate.STOPPED,
        /** Human-readable elaboration of [gate]; may be empty. */
        val detail: String = "",

        // --- miner ---
        val hashesPerSec: Double = 0.0,
        val threads: Int = 0,
        val cores: Int = Prefs.cpuCores(),
        val percent: Int = Prefs.DEFAULT_PERCENT,
        val blocksFound: Long = 0,

        // --- chain ---
        val height: Long = -1,
        val headers: Long = -1,
        val peers: Int = -1,
        val verificationProgress: Double = -1.0,

        // --- wallet ---
        /**
         * Totals across every loaded wallet. Shown as the headline number
         * because it is what the user actually has; the split below is what
         * says how much of it a recovery phrase would bring back.
         */
        val balanceConfirmed: Double = -1.0,
        val balanceImmature: Double = -1.0,
        val balancePending: Double = -1.0,
        /**
         * Money the wallet holds that getbalances put in no category at all --
         * an unconfirmed transaction that is no longer in the mempool after an
         * unclean node restart. -1 when there is none.
         *
         * Shown as its own line rather than folded into the others, because the
         * situation it describes (a wallet with coins reporting 0.00 everywhere)
         * is exactly the one that reads as "my money is gone".
         */
        val balanceInFlight: Double = -1.0,
        val balanceInFlightCount: Int = 0,
        val payoutAddress: String = "",

        /** Balance of the wallet the recovery phrase recreates, or null. */
        val seedConfirmed: Double = -1.0,
        val seedImmature: Double = -1.0,
        /** True once a seeded wallet exists and is loaded. */
        val hasSeedWallet: Boolean = false,

        /**
         * Balance still sitting in a pre-phrase wallet, or -1 when there is no
         * such wallet. Reported separately and never merged away: a user has to
         * be able to see, at a glance, how much of their money the twelve words
         * do NOT cover.
         */
        val legacyConfirmed: Double = -1.0,
        val legacyImmature: Double = -1.0,
        val hasLegacyWallet: Boolean = false,

        // --- forwarding ---
        /**
         * Persisted intent, mirrored here so the dashboard can render without
         * touching prefs on every frame. Survives [markStopped] for the same
         * reason hasSeedWallet does: it is a property of the install, not a
         * live reading.
         */
        val forwardState: ForwardState = ForwardState.HOLDING,
        val forwardAddress: String = "",
        /** Why nothing is being forwarded right now. Shown verbatim. */
        val forwardBlocked: String = "",
        /**
         * The in-flight transaction, when there is one. Amount and address are
         * the DECODED values from the transaction itself, never the intended
         * ones -- what was actually built is the only honest thing to show.
         */
        val forwardSweepKind: SweepKind? = null,
        val forwardSweepState: SweepState? = null,
        val forwardSweepAmountSat: Long = -1,
        val forwardSweepAddress: String = "",
        /** -1 means the node could not be asked, which is NOT zero. */
        val forwardSweepConfirmations: Int = -1,
        /** Value of the vetted candidate set, i.e. what a sweep would move. */
        val forwardSweepableSat: Long = -1,
        /** Milliseconds until the next coinbase matures. -1 when unknowable. */
        val forwardEtaMs: Long = -1,
        /** The test payment reached 6 confirmations; the ack button may open. */
        val forwardProbeConfirmed: Boolean = false,
        val forwardError: String = "",

        // --- device ---
        val charging: Boolean = false,
        val batteryTempC: Float = Float.NaN,
        /** PowerManager.THERMAL_STATUS_*, or -1 when unavailable. */
        val thermalStatus: Int = -1,

        val updatedAtMs: Long = 0L,
    ) {
        val isPaused: Boolean
            get() = gate == Gate.PAUSED_BY_USER ||
                gate == Gate.PAUSED_NOT_CHARGING ||
                gate == Gate.PAUSED_THERMAL ||
                gate == Gate.PAUSED_TOO_HOT ||
                gate == Gate.PAUSED_NO_TEMP

        /** One short line for the notification and the status row. */
        fun gateText(): String = when (gate) {
            Gate.STOPPED -> if (detail.isBlank()) "Stopped" else "Stopped: $detail"
            Gate.STARTING -> if (detail.isBlank()) "Starting node" else "Starting: $detail"
            Gate.MINING -> "Mining"
            Gate.PAUSED_BY_USER -> "Paused: switched off"
            Gate.PAUSED_NOT_CHARGING -> "Paused: not charging"
            Gate.PAUSED_THERMAL ->
                "Paused: device too hot (${Prefs.thermalLabel(thermalStatus)})"
            Gate.PAUSED_TOO_HOT -> "Paused: too hot (${Fmt.temp(batteryTempC)})"
            Gate.PAUSED_NO_TEMP -> "Paused: battery temperature unavailable"
            Gate.WAITING_SYNC -> "Waiting: syncing blockchain"
            Gate.NEEDS_SETUP -> "Set up your wallet before mining"
            Gate.ERROR -> if (detail.isBlank()) "Error" else "Error: $detail"
        }
    }

    @Volatile
    var snapshot: Snapshot = Snapshot()
        private set

    @Synchronized
    fun update(transform: (Snapshot) -> Snapshot) {
        snapshot = transform(snapshot).copy(updatedAtMs = System.currentTimeMillis())
    }

    @Synchronized
    fun reset() {
        snapshot = Snapshot()
    }

    /**
     * Service stopped: everything that was a live reading is no longer live.
     *
     * Only the settings and the payout address survive; chain height, peers and
     * balances would otherwise sit on screen next to "Stopped" as though they
     * were still being updated.
     */
    @Synchronized
    fun markStopped() {
        val s = snapshot
        snapshot = Snapshot(
            gate = Gate.STOPPED,
            // A service that stopped because it gave up must still be able to
            // say why; the reason is the only actionable thing the user has.
            detail = if (s.gate == Gate.ERROR) s.detail else "",
            cores = s.cores,
            percent = s.percent,
            payoutAddress = s.payoutAddress,
            // Which wallets exist is a property of the install, not a live
            // reading, so it survives the service stopping. Their balances do
            // not: those go back to "unknown" rather than sitting on screen
            // next to "Stopped" as though still being updated.
            hasSeedWallet = s.hasSeedWallet,
            hasLegacyWallet = s.hasLegacyWallet,
            // Same rule for forwarding: the user's intent and the address they
            // chose are properties of the install and stay on screen. Whether a
            // sweep is in flight, how many confirmations it has and what is
            // blocking it are live readings and go back to unknown.
            forwardState = s.forwardState,
            forwardAddress = s.forwardAddress,
            forwardProbeConfirmed = s.forwardProbeConfirmed,
            updatedAtMs = System.currentTimeMillis(),
        )
    }
}
