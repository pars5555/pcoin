package org.pcoin.miner

import android.content.Context
import android.content.SharedPreferences

/**
 * Persisted settings. Small enough that SharedPreferences is the right tool.
 *
 * Two kinds of value live here and they are not interchangeable:
 *
 *  - **Authoritative intent** -- the payout address, the forwarding address and
 *    state, the sweep record. Written with commit(), written only by a user
 *    action or by a node-confirmed terminal outcome, and NEVER cleared because
 *    a read failed.
 *  - **Derived display** -- last error, blocked reason, evaluation bookkeeping.
 *    Written with apply(), freely recomputed, load-bearing for nothing.
 *
 * The one rule the forwarding code must never break:
 *
 * > The sweep record is written before the broadcast and cleared only on a
 * > terminal, node-confirmed outcome. Nothing derived from a single RPC read
 * > may create, mutate, or clear it. An RPC that fails or returns "not found"
 * > resolves nothing.
 */
class Prefs(context: Context) {

    private val sp: SharedPreferences =
        context.applicationContext.getSharedPreferences("pcoin_miner", Context.MODE_PRIVATE)

    /**
     * Share of the device to mine with, 10..100 in steps of 10. Default 50.
     */
    var performancePercent: Int
        get() = clampPercent(sp.getInt(KEY_PERCENT, DEFAULT_PERCENT))
        set(value) = sp.edit().putInt(KEY_PERCENT, clampPercent(value)).apply()

    /**
     * Stop mining once Android's own thermal status reaches this level.
     *
     * This is a better signal than battery temperature, which lags badly and
     * measures the wrong thing: on a Pixel 4a mining at 20%, the battery reads
     * 42 C while the CPU cores are at 66 C and the skin sensor at 45 C. The
     * platform's thermal service aggregates every sensor and is tuned per
     * device by the manufacturer, so it knows the phone is struggling long
     * before the battery warms up.
     *
     * Values are PowerManager.THERMAL_STATUS_* : 2 MODERATE, 3 SEVERE,
     * 4 CRITICAL. Requires API 29; below that only the battery cutoff applies.
     */
    var thermalLimit: Int
        get() = clampThermal(sp.getInt(KEY_THERMAL, DEFAULT_THERMAL))
        set(value) = sp.edit().putInt(KEY_THERMAL, clampThermal(value)).apply()

    /**
     * Mine even when the phone is not plugged in.
     *
     * Off by default, and deliberately so: mining flattens a battery in a
     * couple of hours and warms it while it discharges. The owner of a phone is
     * entitled to make that choice, but it should be a choice, not a default.
     */
    var mineOnBattery: Boolean
        get() = sp.getBoolean(KEY_ON_BATTERY, false)
        set(value) = sp.edit().putBoolean(KEY_ON_BATTERY, value).apply()

    /**
     * Payout address. Created once and reused forever.
     *
     * For a seeded wallet this is m/84'/9444'/0'/0/0, so the twelve words
     * recover it. For an install that predates recovery phrases it is whatever
     * the old "m" wallet handed out, which is equally valid and equally
     * spendable -- it just has no phrase behind it.
     */
    var payoutAddress: String?
        get() = sp.getString(KEY_ADDRESS, null)?.takeIf { it.isNotBlank() }
        @Suppress("ApplySharedPref")
        set(value) {
            // commit(), not apply(): this is the address every block reward is
            // paid to. It must be on disk before anything acts on it.
            sp.edit().putString(KEY_ADDRESS, value).commit()
        }

    /**
     * WHICH wallet [payoutAddress] belongs to.
     *
     * This exists because getaddressinfo is wallet-scoped. With two wallets
     * loaded, asking the wrong one whether it owns an address gets a confident,
     * authoritative-looking "no" for a perfectly good address -- and code that
     * trusts that answer will discard the user's payout address. The wallet name
     * is persisted alongside the address so the check is always aimed correctly.
     *
     * Defaults to [LEGACY_WALLET] so an install that predates this field keeps
     * working with no migration step.
     */
    var payoutWallet: String
        get() = sp.getString(KEY_PAYOUT_WALLET, null)?.takeIf { it.isNotBlank() } ?: LEGACY_WALLET
        @Suppress("ApplySharedPref")
        set(value) {
            sp.edit().putString(KEY_PAYOUT_WALLET, value).commit()
        }

    /**
     * Name of the wallet created from the recovery phrase, or null if there
     * isn't one yet.
     *
     * Persisted intent: it records that this app created a seeded wallet, and
     * nothing derived from a node read is ever allowed to clear it. If the node
     * cannot see the wallet right now that is a node problem to report, not a
     * reason to conclude the user never had a phrase.
     */
    var seedWalletName: String?
        get() = sp.getString(KEY_SEED_WALLET, null)?.takeIf { it.isNotBlank() }
        @Suppress("ApplySharedPref")
        set(value) {
            sp.edit().putString(KEY_SEED_WALLET, value).commit()
        }

    /**
     * True once the user has been shown the phrase and proved they wrote it
     * down. Nothing is created on the node before this is set.
     */
    var phraseConfirmed: Boolean
        get() = sp.getBoolean(KEY_PHRASE_CONFIRMED, false)
        @Suppress("ApplySharedPref")
        set(value) {
            sp.edit().putBoolean(KEY_PHRASE_CONFIRMED, value).commit()
        }

    /**
     * The user was offered a recovery phrase for an existing, pre-phrase wallet
     * and chose to carry on without one for now.
     *
     * Recorded so the app stops nagging on every launch, and deliberately NOT
     * treated as "this wallet is backed up" anywhere -- the balance readout
     * still says the old wallet has no phrase.
     */
    var phrasePromptDismissed: Boolean
        get() = sp.getBoolean(KEY_PHRASE_DISMISSED, false)
        set(value) = sp.edit().putBoolean(KEY_PHRASE_DISMISSED, value).apply()

    /**
     * True when this install has a wallet that predates recovery phrases.
     *
     * Set from the presence of a persisted payout address at first run of the
     * new code, then never recomputed: once an old wallet has been seen, the
     * app must keep loading it and keep showing its balance forever, even if a
     * later read fails.
     */
    var hasLegacyWallet: Boolean
        get() = sp.getBoolean(KEY_HAS_LEGACY, false)
        @Suppress("ApplySharedPref")
        set(value) {
            sp.edit().putBoolean(KEY_HAS_LEGACY, value).commit()
        }

    /**
     * One-time migration for installs made before payout wallets were tracked.
     *
     * Purely additive: it records what is already true and changes nothing the
     * user can observe. Safe to call on every launch.
     */
    fun migrateLegacyWalletRecord() {
        if (payoutAddress != null && seedWalletName == null && !hasLegacyWallet) {
            hasLegacyWallet = true
            payoutWallet = LEGACY_WALLET
        }
    }

    /**
     * Whether the user last left mining switched on. Used to decide whether the
     * service should resume work after a START_STICKY restart.
     */
    var miningEnabled: Boolean
        get() = sp.getBoolean(KEY_ENABLED, false)
        set(value) = sp.edit().putBoolean(KEY_ENABLED, value).apply()

    /**
     * PID of the bitcoind this app last spawned, or 0.
     *
     * Persisted because the app can lose its Process handle (process death +
     * START_STICKY restart) while the node it started keeps running, and a
     * running node with no handle and a wedged RPC would otherwise be
     * unstoppable. Written with commit(), not apply(): it must survive the very
     * process death it exists for.
     */
    var nodePid: Int
        get() = sp.getInt(KEY_NODE_PID, 0)
        @Suppress("ApplySharedPref")
        set(value) {
            sp.edit().putInt(KEY_NODE_PID, value).commit()
        }

    /**
     * One -reindex is owed to the node on its next start.
     *
     * Set when bitcoind exits asking to be restarted with -reindex, cleared the
     * moment a node serves RPC again. Persisted with commit() because it must
     * survive the process death it is most likely to follow -- a SIGKILL
     * mid-flush is what creates the condition in the first place.
     *
     * It is a LATCH, not a counter, and that is the whole safety argument: it is
     * only ever set while it is false, so a rebuild that does not fix the datadir
     * cannot arm a second one. The bring-up loop then reaches its failure
     * ceiling and stops with the reason on screen, which is the old behaviour --
     * self-healing is attempted exactly once and never becomes a loop that
     * rebuilds the chain forever on a phone.
     */
    var nodeReindexPending: Boolean
        get() = sp.getBoolean(KEY_NODE_REINDEX, false)
        @Suppress("ApplySharedPref")
        set(value) {
            sp.edit().putBoolean(KEY_NODE_REINDEX, value).commit()
        }

    // --------------------------------------------------------- address book

    /**
     * The address book, as ONE JSON blob in ONE key. See [AddressBookStore].
     *
     * Authoritative intent: these are names the user typed and expects to find
     * again. commit(), and nothing derived from a node read ever writes it --
     * the node has no opinion about what an address is called.
     */
    var addressBookJson: String?
        get() = sp.getString(KEY_ADDRESS_BOOK, null)?.takeIf { it.isNotBlank() }
        @Suppress("ApplySharedPref")
        set(value) {
            sp.edit().putString(KEY_ADDRESS_BOOK, value).commit()
        }

    /**
     * Keep a copy of an address book blob that could not be parsed.
     *
     * Called before anything overwrites it, so a bad read can never be the
     * reason a book is lost. Written once: a second failure must not overwrite
     * the first preserved copy with the empty book that replaced it.
     */
    @Suppress("ApplySharedPref")
    fun preserveCorruptAddressBook(raw: String) {
        if (sp.contains(KEY_ADDRESS_BOOK_CORRUPT)) return
        sp.edit().putString(KEY_ADDRESS_BOOK_CORRUPT, raw).commit()
    }

    // ------------------------------------------------------------ forwarding

    /**
     * Where mined coins are forwarded to, or null to keep holding them here.
     *
     * Null is the default and a complete, safe state: this app IS a wallet, and
     * "pcoin-hd" is backed by the twelve words, so coins accumulating here are
     * exactly as recoverable as coins anywhere else. Nothing forwards until the
     * user sets this AND confirms a test payment arrived.
     *
     * commit(), and never written from a node read: this is the string every
     * future block reward gets sent to. A failed validateaddress PARKS
     * forwarding (see [forwardBlockedReason]); it does not clear this.
     */
    var forwardAddress: String?
        get() = sp.getString(KEY_FORWARD_ADDRESS, null)?.takeIf { it.isNotBlank() }
        @Suppress("ApplySharedPref")
        set(value) {
            sp.edit().putString(KEY_FORWARD_ADDRESS, value).commit()
        }

    /**
     * Where forwarding is in the opt-in sequence. Persisted intent; only a state
     * transition writes it, and a state transition only ever follows a user
     * action or a node-confirmed fact.
     */
    var forwardState: ForwardState
        get() {
            val name = sp.getString(KEY_FORWARD_STATE, null) ?: return ForwardState.HOLDING
            // An unrecognised value means a downgrade or a corrupted pref. Fall
            // back to HOLDING: the state that sends nothing.
            return ForwardState.entries.firstOrNull { it.name == name } ?: ForwardState.HOLDING
        }
        @Suppress("ApplySharedPref")
        set(value) {
            sp.edit().putString(KEY_FORWARD_STATE, value.name).commit()
        }

    /**
     * An address the user chose while a sweep was still in flight.
     *
     * Swapped into [forwardAddress] only once that record is terminal. The
     * in-flight transaction pays the OLD address and has to be allowed to
     * complete: a destination cannot be reasoned about halfway through a send.
     */
    var forwardPendingAddress: String?
        get() = sp.getString(KEY_FORWARD_PENDING_ADDRESS, null)?.takeIf { it.isNotBlank() }
        @Suppress("ApplySharedPref")
        set(value) {
            sp.edit().putString(KEY_FORWARD_PENDING_ADDRESS, value).commit()
        }

    /** Txid of the test payment, so its confirmations can be followed. */
    var forwardProbeTxid: String?
        get() = sp.getString(KEY_FORWARD_PROBE_TXID, null)?.takeIf { it.isNotBlank() }
        @Suppress("ApplySharedPref")
        set(value) {
            sp.edit().putString(KEY_FORWARD_PROBE_TXID, value).commit()
        }

    /**
     * The probe reached 6 confirmations, as the node reported at the time.
     *
     * Recorded rather than re-read, so arming does not depend on a live query
     * that could fail: this is a node-confirmed fact the app then owns. It is
     * now the ONLY condition for arming.
     *
     * There used to be a second one -- a human pressing "I received it" -- and
     * what that gave up is worth stating where the flag lives, not only where it
     * is read. A valid address nobody holds the key to accepts coins silently
     * and burns every future reward, and `verifymessage` cannot verify a bech32
     * address in this fork (common/signmessage.cpp rejects anything that is not
     * P2PKH), so a signed challenge is not available either. The probe therefore
     * proves the build/sign/broadcast path works and that the network accepts
     * the address; it does NOT prove the coins are spendable by anyone. That
     * last check is the operator watching the destination wallet -- which is the
     * trade that was accepted, so that a device does not need someone physically
     * at it before it can forward.
     */
    var forwardProbeConfirmed: Boolean
        get() = sp.getBoolean(KEY_FORWARD_PROBE_CONFIRMED, false)
        @Suppress("ApplySharedPref")
        set(value) {
            sp.edit().putBoolean(KEY_FORWARD_PROBE_CONFIRMED, value).commit()
        }

    /**
     * The single sweep record, as ONE JSON blob in ONE key, deliberately.
     *
     * commit() of a single key is atomic. Five separate keys would be five
     * atomic writes, and an Android kill between them leaves a record that is
     * internally inconsistent -- a txid with no hex, inputs with no txid --
     * which is worse than no record at all, because the recovery path would
     * then act on half a fact. One blob makes it all-or-nothing.
     */
    var forwardSweepRecordJson: String?
        get() = sp.getString(KEY_FORWARD_RECORD, null)?.takeIf { it.isNotBlank() }
        @Suppress("ApplySharedPref")
        set(value) {
            sp.edit().putString(KEY_FORWARD_RECORD, value).commit()
        }

    // Authoritative history: derived from a node-confirmed fact, then owned by
    // the app. The user relies on this being stable across restarts, so it must
    // not vanish because a later read failed. commit(), on SETTLED only.
    var forwardLastTxid: String?
        get() = sp.getString(KEY_FORWARD_LAST_TXID, null)?.takeIf { it.isNotBlank() }
        @Suppress("ApplySharedPref")
        set(value) {
            sp.edit().putString(KEY_FORWARD_LAST_TXID, value).commit()
        }

    var forwardLastAmountSat: Long
        get() = sp.getLong(KEY_FORWARD_LAST_AMOUNT, -1L)
        @Suppress("ApplySharedPref")
        set(value) {
            sp.edit().putLong(KEY_FORWARD_LAST_AMOUNT, value).commit()
        }

    var forwardLastAtMs: Long
        get() = sp.getLong(KEY_FORWARD_LAST_AT, 0L)
        @Suppress("ApplySharedPref")
        set(value) {
            sp.edit().putLong(KEY_FORWARD_LAST_AT, value).commit()
        }

    var forwardLastAddress: String?
        get() = sp.getString(KEY_FORWARD_LAST_ADDRESS, null)?.takeIf { it.isNotBlank() }
        @Suppress("ApplySharedPref")
        set(value) {
            sp.edit().putString(KEY_FORWARD_LAST_ADDRESS, value).commit()
        }

    /**
     * True once the one-time "mined coins can't be spent for 101 blocks"
     * explainer has been shown. Cosmetic; apply() is right.
     */
    var forwardMaturityExplained: Boolean
        get() = sp.getBoolean(KEY_FORWARD_EXPLAINED, false)
        set(value) = sp.edit().putBoolean(KEY_FORWARD_EXPLAINED, value).apply()

    // Derived display and scheduling. Every one of these can be wrong or stale
    // without costing anything, so apply() is correct and none of them is ever
    // consulted to decide whether to send.
    var forwardLastError: String?
        get() = sp.getString(KEY_FORWARD_LAST_ERROR, null)?.takeIf { it.isNotBlank() }
        set(value) = sp.edit().putString(KEY_FORWARD_LAST_ERROR, value).apply()

    var forwardBlockedReason: String?
        get() = sp.getString(KEY_FORWARD_BLOCKED, null)?.takeIf { it.isNotBlank() }
        set(value) = sp.edit().putString(KEY_FORWARD_BLOCKED, value).apply()

    var forwardConsecutiveFailures: Int
        get() = sp.getInt(KEY_FORWARD_FAILURES, 0)
        set(value) = sp.edit().putInt(KEY_FORWARD_FAILURES, value).apply()

    companion object {
        private const val KEY_PERCENT = "performance_percent"
        private const val KEY_ADDRESS = "payout_address"
        private const val KEY_ENABLED = "mining_enabled"
        private const val KEY_NODE_PID = "node_pid"
        private const val KEY_THERMAL = "thermal_limit"
        private const val KEY_ON_BATTERY = "mine_on_battery"
        private const val KEY_PAYOUT_WALLET = "payout_wallet"
        private const val KEY_SEED_WALLET = "seed_wallet_name"
        private const val KEY_PHRASE_CONFIRMED = "phrase_confirmed"
        private const val KEY_PHRASE_DISMISSED = "phrase_prompt_dismissed"
        private const val KEY_HAS_LEGACY = "has_legacy_wallet"
        private const val KEY_NODE_REINDEX = "node_reindex_pending"
        private const val KEY_ADDRESS_BOOK = "address_book"
        private const val KEY_ADDRESS_BOOK_CORRUPT = "address_book_corrupt"

        private const val KEY_FORWARD_ADDRESS = "forward_address"
        private const val KEY_FORWARD_STATE = "forward_state"
        private const val KEY_FORWARD_PENDING_ADDRESS = "forward_pending_address"
        private const val KEY_FORWARD_PROBE_TXID = "forward_probe_txid"
        private const val KEY_FORWARD_PROBE_CONFIRMED = "forward_probe_confirmed"
        private const val KEY_FORWARD_RECORD = "forward_sweep_record"
        private const val KEY_FORWARD_LAST_TXID = "forward_last_txid"
        private const val KEY_FORWARD_LAST_AMOUNT = "forward_last_amount_sat"
        private const val KEY_FORWARD_LAST_AT = "forward_last_at_ms"
        private const val KEY_FORWARD_LAST_ADDRESS = "forward_last_address"
        private const val KEY_FORWARD_EXPLAINED = "forward_maturity_explained"
        private const val KEY_FORWARD_LAST_ERROR = "forward_last_error"
        private const val KEY_FORWARD_BLOCKED = "forward_blocked_reason"
        private const val KEY_FORWARD_FAILURES = "forward_consecutive_failures"

        /**
         * The wallet name every build before recovery phrases used.
         *
         * Never renamed, never unloaded, never deleted, never sethdseed-ed. The
         * coins in it stay exactly where they are and stay spendable; the
         * seeded wallet is added ALONGSIDE it.
         */
        const val LEGACY_WALLET = "m"

        /** The wallet created from a recovery phrase. A new name, not a reuse. */
        const val SEED_WALLET = "pcoin-hd"

        const val DEFAULT_PERCENT = 50
        const val MIN_PERCENT = 10
        const val MAX_PERCENT = 100
        const val PERCENT_STEP = 10

        // PowerManager.THERMAL_STATUS_* values we let the user choose between.
        const val THERMAL_MODERATE = 2
        const val THERMAL_SEVERE = 3
        const val THERMAL_CRITICAL = 4

        /**
         * "Never stop for heat" -- mine until the platform reports EMERGENCY.
         *
         * There is deliberately no option above this. It is not paternalism: at
         * EMERGENCY the phone is about to power itself off, and a phone that
         * shuts down mines nothing and has to reboot. Stopping one level early
         * produces MORE mining than not stopping, so this is the setting that
         * actually serves "always on".
         */
        const val THERMAL_NEVER = 5

        /**
         * Default to SEVERE. CRITICAL means the device is already throttling
         * hard and shedding performance to protect itself, which is late to be
         * stopping; MODERATE is reached by many older phones under any load and
         * would leave them barely able to mine. Older or heat-prone phones
         * should be set to MODERATE by their owner.
         */
        const val DEFAULT_THERMAL = THERMAL_SEVERE

        fun clampThermal(value: Int): Int = value.coerceIn(THERMAL_MODERATE, THERMAL_NEVER)

        fun thermalLabel(value: Int): String = when (clampThermal(value)) {
            THERMAL_MODERATE -> "Moderate"
            THERMAL_SEVERE -> "Severe"
            THERMAL_CRITICAL -> "Critical"
            else -> "Never stop"
        }

        fun clampPercent(value: Int): Int {
            val snapped = (Math.round(value / PERCENT_STEP.toDouble()) * PERCENT_STEP).toInt()
            return snapped.coerceIn(MIN_PERCENT, MAX_PERCENT)
        }

        /**
         * The owner's mapping, verbatim:
         *   threads = max(1, round(totalCores * percent / 100))
         */
        fun threadsFor(percent: Int, cores: Int = cpuCores()): Int {
            val t = Math.round(cores * clampPercent(percent) / 100.0).toInt()
            return maxOf(1, minOf(t, cores))
        }

        fun cpuCores(): Int = maxOf(1, Runtime.getRuntime().availableProcessors())
    }
}
