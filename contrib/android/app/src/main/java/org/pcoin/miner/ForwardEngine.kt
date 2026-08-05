package org.pcoin.miner

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import org.json.JSONArray
import org.json.JSONObject
import org.pcoin.miner.wallet.Redact
import java.io.IOException
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * Automatic forwarding of mined coins to an address the user chose.
 *
 * Driven by [MinerService]'s existing control loop -- there is deliberately no
 * second scheduler, no WorkManager job and no alarm. A timer decoupled from the
 * chain can fire in the middle of a reorg or a resync, where whatever it
 * computes is meaningless; the one event that can change the answer is a new
 * block, and the service already reads the height every 3 s. See
 * [ForwardPolicy.shouldEvaluate].
 *
 * Everything that DECIDES lives in [ForwardPolicy] and is unit-tested on a
 * plain JVM. This file is the plumbing: it gathers readings, drives the RPCs in
 * the one order that is safe, and persists.
 *
 * The three rules that make this safe, and the reason each exists:
 *
 *  - **R1. A signed transaction is built at most once.** After that, only the
 *    STORED hex is ever re-broadcast. Verified in node/transaction.cpp:
 *    re-submitting a hex already in the mempool re-announces without
 *    resubmitting, and one already confirmed returns ALREADY_IN_UTXO_SET
 *    (RPC -27) before doing anything. There is no path by which re-sending
 *    produces a second payment; a rebuild is the one thing that could.
 *  - **R2. The record is written to disk BEFORE the broadcast** and cleared
 *    only on a terminal, node-confirmed outcome.
 *  - **R3. An RPC that fails, times out, or says "not found" resolves
 *    nothing.** It cannot advance a record, clear one, or authorise a build.
 *
 * Everything here is scoped to [Prefs.payoutWallet] -- the wallet mining is
 * actually being paid into. On an install created from a recovery phrase that
 * is "pcoin-hd"; on one that predates phrases it is the legacy "m" wallet, and
 * forwarding from it is correct, because that is where that install's block
 * rewards land. No OTHER wallet is ever read or spent from.
 */
class ForwardEngine(context: Context, private val node: NodeController) {

    private val appContext = context.applicationContext
    private val prefs = Prefs(appContext)
    private val rpc = node.rpc

    /** Height at which the last evaluation ran, so a new block triggers one. */
    private var lastEvaluatedHeight = -1L
    private var lastEvaluationMs = 0L

    /**
     * Startup reconciliation has run against the CURRENT node.
     *
     * Cleared on every bring-up. Until it is true no build is permitted, which
     * is what stops a freshly-wiped app from sweeping coins that are already
     * committed to an in-flight transaction.
     */
    @Volatile
    private var reconciled = false

    /**
     * An evaluation is in progress on the worker below.
     *
     * The forwarding work does NOT run on the service's control loop, and that
     * is not a second scheduler -- the decision to run still comes from the
     * loop, and only from it. What moves is the execution. A full evaluation is
     * up to half a dozen RPCs and a build, which can take a minute on a slow
     * phone, and the control loop's 3 s poll is what feeds the node's 45-second
     * dead-man switch (NodeController.MINER_TTL_SECONDS). Blocking it long
     * enough for that to expire would make the phone stop mining every time it
     * forwarded -- a safety mechanism firing because of an unrelated feature.
     *
     * An AtomicBoolean rather than a volatile flag: `if (busy) ... busy = true`
     * is a check-then-set that two callers can both pass. Only one caller
     * exists today, so nothing was actually broken by it, but a flag whose
     * whole job is to admit one thread should not depend on that staying true.
     */
    private val busy = AtomicBoolean(false)

    /**
     * True while a worker is holding wallet locks inside the node.
     *
     * Read by [MinerService] so that a stats poll starved of cs_wallet by this
     * feature is not counted as evidence that the NODE has stopped answering.
     */
    fun isEvaluating(): Boolean = busy.get()

    /**
     * Serialises everything that talks to the wallet.
     *
     * Bring-up reconciliation runs on the control thread while a worker started
     * before the last node failure could still be finishing. Two concurrent
     * paths through the send logic is exactly the shape that builds a second
     * transaction, so they take turns.
     */
    private val workLock = Any()

    /** Observed spacing over the last 100 blocks, seconds. Re-read hourly. */
    private var observedSpacingSec = 0.0
    private var spacingReadAtMs = 0L

    /** So the "forwarding is stuck" notification fires once, not every tick. */
    private var stuckNotified = false
    private var probeAckNotified = false

    init {
        createChannel()
    }

    // ------------------------------------------------------------- lifecycle

    /**
     * Called at the end of every node bring-up, before the first tick.
     *
     * Runs reconciliation: an interrupted send has to be resolved before
     * anything is allowed to build. Never throws -- forwarding failing must
     * never be able to stop the phone mining.
     */
    fun onNodeReady(loadedWallets: Set<String>) {
        reconciled = false
        lastEvaluatedHeight = -1L
        lastEvaluationMs = 0L
        synchronized(workLock) {
            try {
                reconcile(loadedWallets)
                reconciled = true
            } catch (t: Throwable) {
                Log.w(TAG, "reconciliation failed, forwarding stays parked: ${Redact.text(t)}")
                publish(ForwardBlock.NODE_NOT_READY)
            }
        }
    }

    /** The node went away; nothing that follows may be trusted until re-checked. */
    fun onNodeLost() {
        reconciled = false
    }

    /**
     * One tick of the service's control loop.
     *
     * Cheap on almost every call: it compares the height it was given against
     * the height it last evaluated at and usually returns immediately. Never
     * throws.
     */
    fun onTick(stats: NodeController.Stats, loadedWallets: Set<String>, alive: Boolean) {
        if (!alive) return
        val now = System.currentTimeMillis()
        if (!ForwardPolicy.shouldEvaluate(
                height = stats.height,
                lastEvaluatedHeight = lastEvaluatedHeight,
                nowMs = now,
                lastEvaluationMs = lastEvaluationMs,
                force = evaluationRequested,
            )
        ) {
            return
        }
        // A previous evaluation is still running. Skipping rather than queueing
        // is deliberate: the next block will schedule another one, and a queue
        // of stale evaluations is a queue of decisions made on old numbers.
        // Claimed atomically, so "I am the one worker" is a fact and not a
        // race two callers could both win.
        if (!busy.compareAndSet(false, true)) return
        evaluationRequested = false
        lastEvaluatedHeight = stats.height
        lastEvaluationMs = now

        thread(name = "pcoin-forward", isDaemon = true) {
            try {
                synchronized(workLock) { runEvaluation(stats, loadedWallets, alive) }
            } finally {
                busy.set(false)
            }
        }
    }

    private fun runEvaluation(
        stats: NodeController.Stats,
        loadedWallets: Set<String>,
        alive: Boolean,
    ) {
        try {
            if (!reconciled || reconcileRequested) {
                // A bring-up whose reconciliation failed retries here rather
                // than leaving forwarding dead until the next node restart.
                //
                // reconcileRequested is set when forwarding is first armed. The
                // bring-up reconciliation short-circuits for an install that has
                // never forwarded, and "prefs wiped, wallet DB survived" looks
                // exactly like that install -- so adoption and stale-lock
                // release have to be re-run at the moment an address appears,
                // which is the first moment they could matter.
                reconcile(loadedWallets)
                reconciled = true
                reconcileRequested = false
            }
            evaluate(stats, loadedWallets, alive)
            prefs.forwardConsecutiveFailures = 0
            stuckNotified = false
        } catch (t: Throwable) {
            // Redacted: this string reaches the UI and a notification, and the
            // node echoes offending input back inside its error text.
            val why = Redact.text(t.message ?: t.javaClass.simpleName).take(200)
            Log.w(TAG, "forward evaluation failed: $why")
            prefs.forwardLastError = why
            val failures = prefs.forwardConsecutiveFailures + 1
            prefs.forwardConsecutiveFailures = failures
            // Never on the first failure: a phone with one peer on a chain
            // producing a block every ~14 minutes fails transiently all the
            // time, and a notification for that would be noise the user learns
            // to ignore -- which is worse than no notification at all.
            if (failures >= STUCK_AFTER_FAILURES && !stuckNotified) {
                stuckNotified = true
                notifyForward(
                    NOTIF_STUCK,
                    "Forwarding is stuck",
                    "$why Your coins are safe in this wallet.",
                    NotificationManager.IMPORTANCE_DEFAULT,
                )
            }
        }
    }

    // -------------------------------------------------------- reconciliation

    /**
     * Runs on every bring-up, before any build is permitted.
     *
     * Three steps, in this order, and the order is the point: resolve what we
     * know about, then adopt what the WALLET knows about but we do not, and
     * only when both say there is nothing in flight release the locks.
     */
    private fun reconcile(loadedWallets: Set<String>) {
        // Nothing has ever been sent and nothing is configured, so there is
        // genuinely nothing to reconcile. Checked first so that an install
        // which never turned forwarding on -- the overwhelmingly common case --
        // does not report failures, or notify about them, for a feature it is
        // not using.
        if (prefs.forwardState == ForwardState.HOLDING && prefs.forwardSweepRecordJson == null) {
            publish(ForwardBlock.HOLDING)
            return
        }

        val wallet = prefs.payoutWallet
        if (wallet !in loadedWallets) {
            // Not evidence of anything -- and specifically NOT evidence that
            // nothing is in flight. Throwing leaves `reconciled` false, so no
            // build is permitted until the wallet can actually be asked.
            // Returning normally here would let a later evaluation build a
            // sweep having never run adoption.
            publish(ForwardBlock.WALLET_NOT_LOADED)
            throw IOException("the payout wallet is not loaded")
        }

        val record = readRecord()
        if (recordUnreadable) {
            publish(ForwardBlock.PENDING_SWEEP)
            return
        }
        if (record != null && !record.state.terminal) {
            Log.i(TAG, "reconciling ${record.kind} ${record.txid.take(12)} in ${record.state}")
            resolveRecord(record, wallet)
            return
        }
        if (record != null) {
            // Terminal but never cleared -- a kill between marking and clearing.
            clearRecord()
        }

        // Step 2. Covers "app data cleared, wallet DB survived". Without it a
        // freshly-wiped app would immediately build a SECOND sweep over coins
        // already committed to an in-flight transaction.
        val adopted = adoptInFlightSend(wallet)
        if (adopted != null) {
            Log.w(TAG, "adopted an in-flight wallet send ${adopted.txid.take(12)}; no build until it settles")
            writeRecord(adopted)
            return
        }

        // Step 3. No record and nothing in flight, so any persistent lock left
        // behind belongs to a record that no longer exists. Releasing it is
        // self-healing and removes the only downside of locking at all.
        releaseStaleLocks(wallet)
    }

    /**
     * An unconfirmed outgoing transaction the wallet knows about and we do not.
     *
     * @return a record to adopt at [SweepState.BROADCAST], or null when the
     *   wallet definitely has nothing in flight. Throws when it could not be
     *   asked -- an unanswerable question must not read as "nothing in flight".
     */
    private fun adoptInFlightSend(wallet: String): SweepRecord? {
        val list = rpc.call(
            "listtransactions",
            JSONArray().put("*").put(ADOPT_SCAN).put(0).put(true),
            wallet = wallet,
            readTimeoutMs = RPC_TIMEOUT_MS,
        ) as? JSONArray
            // Not an answer. Throwing keeps `reconciled` false, so no build is
            // permitted until the question has actually been answered -- "the
            // node gave us something unexpected" is not "nothing is in flight".
            ?: throw IOException("listtransactions did not return a list")

        for (i in 0 until list.length()) {
            val tx = list.optJSONObject(i) ?: continue
            if (tx.optString("category") != "send") continue
            if (tx.optInt("confirmations", 1) > 0) continue
            if (tx.optBoolean("abandoned", false)) continue
            val txid = tx.optString("txid").takeIf { it.isNotBlank() } ?: continue

            // No hex was ever stored for this one (it predates the record), so
            // recover it from the wallet -- the one case where gettransaction
            // is the right source, because the wallet demonstrably has it.
            val full = rpc.call(
                "gettransaction",
                JSONArray().put(txid).put(false).put(true),
                wallet = wallet,
                readTimeoutMs = RPC_TIMEOUT_MS,
            ) as? JSONObject ?: continue
            val hex = full.optString("hex").takeIf { it.isNotBlank() } ?: continue

            val decoded = decode(hex)
            // Whatever does not come back to us is what was being paid.
            var paidSat = 0L
            var paidTo = ""
            for (out in decoded.outputs) {
                if (out.address.isBlank()) continue
                if (isMine(wallet, out.address)) continue
                paidSat += out.valueSat
                if (paidTo.isBlank()) paidTo = out.address
            }
            return SweepRecord(
                txid = txid,
                hex = hex,
                inputs = decoded.inputs,
                amountSat = paidSat,
                feeSat = -1L,
                address = paidTo,
                state = SweepState.BROADCAST,
                kind = if (txid == prefs.forwardProbeTxid) SweepKind.PROBE else SweepKind.SWEEP,
                createdAtMs = System.currentTimeMillis(),
                broadcastAtMs = System.currentTimeMillis(),
            )
        }
        return null
    }

    private fun releaseStaleLocks(wallet: String) {
        val locked = rpc.call("listlockunspent", wallet = wallet, readTimeoutMs = RPC_TIMEOUT_MS)
            as? JSONArray ?: return
        if (locked.length() == 0) return
        Log.w(TAG, "releasing ${locked.length()} stale lock(s) left by a record that no longer exists")
        try {
            rpc.call(
                "lockunspent",
                JSONArray().put(true).put(locked),
                wallet = wallet,
                readTimeoutMs = RPC_TIMEOUT_MS,
            )
        } catch (e: IOException) {
            Log.w(TAG, "lock release failed: ${Redact.text(e.message)}")
        }
    }

    // ------------------------------------------------------------- evaluation

    private fun evaluate(stats: NodeController.Stats, loadedWallets: Set<String>, alive: Boolean) {
        val wallet = prefs.payoutWallet

        // A non-terminal record is resolved and nothing else happens. One
        // transaction at a time, always.
        //
        // Checked BEFORE the user's forwarding state, deliberately: someone can
        // switch forwarding off while a sweep is in flight, and that
        // transaction still has to be followed to a conclusion. Returning early
        // on HOLDING would strand it -- its inputs locked forever, its outcome
        // never recorded, and the payment invisible in the app that made it.
        val record = readRecord()
        if (recordUnreadable) {
            publish(ForwardBlock.PENDING_SWEEP)
            return
        }
        if (record != null && !record.state.terminal) {
            resolveRecord(record, wallet)
            return
        }
        if (record != null) clearRecord()

        // Only now that nothing is in flight may a queued address change take
        // effect: the in-flight transaction pays the OLD address and has to be
        // allowed to complete rather than be reasoned about mid-send.
        //
        // BEFORE the HOLDING check, not after. A user can stop forwarding while
        // a sweep is in flight and then save a new address; the screen says
        // "saved (queued)", but the state is HOLDING, and returning here first
        // would strand that address permanently -- invisible in the UI, which
        // only renders forwardAddress, and never applied by anything.
        applyPendingAddress()

        // Persisted intent. HOLDING is the common case and a complete answer.
        var state = prefs.forwardState
        if (state == ForwardState.HOLDING) {
            publish(ForwardBlock.HOLDING)
            return
        }

        // Arming is automatic once the node has confirmed the test payment.
        //
        // This used to also require a human "I received it". That was dropped
        // deliberately: the operator watches the destination wallet anyway, and
        // payments that stop arriving are noticed within minutes, so the tap
        // bought a one-off confirmation at the cost of every device needing
        // someone physically at it before it could forward anything.
        //
        // What is LOST by not asking, stated plainly so nobody assumes it is
        // still covered: a confirmed probe proves the transaction reached the
        // chain paying that script. It does NOT prove anyone holds the key. A
        // mistyped-but-valid address has a good checksum, passes validateaddress
        // and confirms identically. The 1 PCN probe is still sent and still has
        // to confirm, so it remains a live canary for the build/sign/broadcast
        // path and for an address the network rejects -- but "these coins are
        // spendable by me" is now the operator's observation, not something this
        // code establishes.
        if (state == ForwardState.PROBING_SENT && prefs.forwardProbeConfirmed) {
            prefs.forwardState = ForwardState.ARMED
            state = ForwardState.ARMED
            Log.i(TAG, "forwarding armed (probe confirmed)")
        }

        val destination = prefs.forwardAddress
        if (destination == null) {
            // An address-less non-HOLDING state should not exist, but if a pref
            // was lost the only safe reading is "hold".
            prefs.forwardState = ForwardState.HOLDING
            publish(ForwardBlock.HOLDING)
            return
        }

        val walletLoaded = wallet in loadedWallets && walletAnswers(wallet)
        // Re-validated on EVERY evaluation, one round trip, because it catches a
        // corrupted or truncated pref before it is used as a payment
        // destination. Failure parks forwarding; it never rewrites the address.
        val facts = if (walletLoaded) addressFacts(destination, wallet) else null
        val destinationValid = facts != null && facts.isValid &&
            !(facts.isWitness && facts.witnessVersion > 1)

        val candidates = if (walletLoaded && destinationValid) vettedCandidates(wallet) else emptyList()

        val conditions = ForwardConditions(
            alive = alive,
            forwardState = state,
            recordNonTerminal = false,
            nodeAnswered = stats.height >= 0 && stats.headers >= 0,
            initialBlockDownload = stats.initialBlockDownload,
            height = stats.height,
            headers = stats.headers,
            tipTimeSec = stats.tipTimeSec,
            nowMs = System.currentTimeMillis(),
            relayPeers = relayPeers(),
            payoutWalletLoaded = walletLoaded,
            destinationValid = destinationValid,
            sweepableSat = ForwardPolicy.totalSat(candidates),
            candidateCount = candidates.size,
            probeCandidateSat = candidates.firstOrNull()?.amountSat ?: 0L,
        )

        val decision = ForwardPolicy.decide(conditions)
        val eta = estimateNextForward(wallet, stats.height)

        if (!decision.clear) {
            if (decision.block == ForwardBlock.ADDRESS_PARKED && facts != null) {
                Log.w(TAG, "forwarding parked: destination no longer validates (${facts.nodeError})")
            }
            publish(decision.block, sweepableSat = conditions.sweepableSat, etaMs = eta)
            return
        }

        when (decision.action) {
            ForwardAction.SWEEP ->
                buildAndSend(SweepKind.SWEEP, candidates, destination, facts!!, wallet, state)
            ForwardAction.PROBE ->
                buildAndSend(SweepKind.PROBE, candidates.take(1), destination, facts!!, wallet, state)
            ForwardAction.NONE -> Unit
        }
    }

    /**
     * Swaps in an address the user chose while a sweep was in flight.
     *
     * @return true when something changed.
     */
    private fun applyPendingAddress(): Boolean {
        val pending = prefs.forwardPendingAddress ?: return false
        prefs.forwardAddress = pending
        prefs.forwardPendingAddress = null
        // Any change re-probes. A swapped address must not be able to receive a
        // full sweep until someone has confirmed a test payment arrived at it.
        prefs.forwardProbeTxid = null
        prefs.forwardProbeAcked = false
        prefs.forwardProbeConfirmed = false
        prefs.forwardState = ForwardState.PROBING_PENDING
        Log.i(TAG, "queued forwarding address applied; re-probing")
        return true
    }

    // ----------------------------------------------------------- the send path

    /**
     * Build, verify, persist, broadcast. In that order, and the order is what
     * makes an Android kill at any point recoverable.
     *
     * `sendall` with explicit inputs and `add_to_wallet: false` is the chosen
     * RPC. It returns a fully signed hex WITHOUT broadcasting, which is the
     * inspect-then-commit shape this needs; `sendtoaddress` has no such option
     * and would broadcast before anything could be checked, and
     * `walletcreatefundedpsbt` adds two more interruptible states for no gain
     * when the wallet is also the signer.
     */
    private fun buildAndSend(
        kind: SweepKind,
        inputs: List<Utxo>,
        destination: String,
        facts: ForwardPolicy.AddressFacts,
        wallet: String,
        expectedState: ForwardState,
    ) {
        if (inputs.isEmpty()) return
        val now = System.currentTimeMillis()

        val built = if (kind == SweepKind.SWEEP) {
            callSendAll(inputs, destination, wallet)
        } else {
            callProbeSend(inputs, destination, wallet)
        }
        if (!built.complete || built.hex.isBlank() || built.txid.isBlank()) {
            abort(kind, "the node did not return a complete signed transaction")
            return
        }

        // The gate between "built" and "committed". Nothing has been sent and
        // nothing has been written; any failure here leaves the coins exactly
        // where they were, which is the safe direction to fail in.
        val decoded = decode(built.hex).let {
            if (kind == SweepKind.PROBE) annotateChange(it, wallet, destination) else it
        }
        val complaint = if (kind == SweepKind.SWEEP) {
            ForwardPolicy.verifySweep(decoded, inputs, destination, facts.scriptPubKey, built.txid)
        } else {
            ForwardPolicy.verifyProbe(decoded, inputs, destination, facts.scriptPubKey, built.txid)
        }
        if (complaint != null) {
            Log.e(TAG, "forward aborted, assertion failed: $complaint")
            abort(kind, "Forward aborted: $complaint")
            return
        }

        // One round trip that catches, for example, an input that turned out
        // immature after all -- before anything is written to disk or sent.
        val rejection = testAccept(built.hex)
        if (rejection != null) {
            abort(kind, "the node would not accept the transaction: $rejection")
            return
        }

        val paid = if (kind == SweepKind.SWEEP) decoded.outputs[0] else
            decoded.outputs.first { it.address == destination }
        val feeSat = inputs.sumOf { it.amountSat } - decoded.outputs.sumOf { it.valueSat }

        // R2: the record exists on disk BEFORE the broadcast. From here on the
        // only recovery action is re-sending this exact hex.
        var record = SweepRecord(
            txid = built.txid,
            hex = built.hex,
            inputs = inputs.map { it.outpoint },
            amountSat = paid.valueSat,
            feeSat = feeSat,
            address = destination,
            state = SweepState.BROADCASTING,
            kind = kind,
            createdAtMs = now,
            attempts = 1,
            lastAttemptMs = now,
        )

        // The commit point, and the one place the user's intent is re-read.
        //
        // Everything above -- sendall (up to 60 s), decoderawtransaction,
        // getaddressinfo, testmempoolaccept -- ran against `destination` as it
        // was at the top of this evaluation. The user can replace that address,
        // or press Stop, at any point during it. Nothing has been sent or
        // written yet, so the correct answer to a changed intent is to throw the
        // built transaction away: the coins have not moved and the next
        // evaluation builds again for the new destination.
        //
        // Under INTENT_LOCK so the re-read and the write that makes the send
        // visible to the activity cannot be interleaved with the activity's own
        // write. Nothing inside talks to the node.
        synchronized(INTENT_LOCK) {
            val current = prefs.forwardAddress
            if (current != destination || prefs.forwardState != expectedState) {
                abort(kind, "the forwarding address changed while the transaction was being built")
                return
            }
            writeRecord(record)
            if (kind == SweepKind.PROBE) {
                // Written WITH the record, not after the broadcast. A kill in
                // between used to leave a record that settled normally while
                // the state machine still said PROBING_PENDING, and the next
                // evaluation then sent a SECOND 1 PCN probe. It also lets
                // adoptInFlightSend recognise this txid as a probe rather than
                // announcing it to the user as a forward.
                prefs.forwardProbeTxid = record.txid
                prefs.forwardState = ForwardState.PROBING_SENT
            }
        }

        // Belt, at the wallet layer, for the case where prefs are wiped but the
        // datadir survives. Not the primary guard -- the record is -- so a
        // failure is logged and does not stop the send.
        lockInputs(wallet, record.inputs)

        val returned = try {
            broadcast(built.hex)
        } catch (e: IOException) {
            // R3: leave the record at BROADCASTING. The resolver decides on the
            // next evaluation whether it actually landed; concluding "it did
            // not" from a failed call is exactly the bug this design exists to
            // prevent.
            record = record.copy(lastError = Redact.text(e.message).take(200))
            writeRecord(record)
            publish(ForwardBlock.PENDING_SWEEP, record = record)
            throw e
        }

        if (returned != built.txid) {
            // Should be impossible. Do NOT clear the record: something is very
            // wrong and the record is the only trail.
            Log.e(TAG, "broadcast returned a different txid than was built")
            record = record.copy(lastError = "the node returned a different transaction id")
            writeRecord(record)
            publish(ForwardBlock.PENDING_SWEEP, record = record)
            return
        }

        record = record.copy(state = SweepState.BROADCAST, broadcastAtMs = System.currentTimeMillis())
        writeRecord(record)
        prefs.forwardLastError = null
        Log.i(TAG, "${kind.name.lowercase()} broadcast ${record.txid.take(12)} for ${record.amountSat} sat")
        publish(ForwardBlock.PENDING_SWEEP, record = record)
    }

    private fun abort(kind: SweepKind, why: String) {
        Log.w(TAG, "${kind.name.lowercase()} not sent: $why")
        prefs.forwardLastError = why.take(200)
        publish(ForwardBlock.NONE)
    }

    private data class Built(val complete: Boolean, val txid: String, val hex: String)

    /**
     * `sendall` -- "all of it, minus the fee, no change".
     *
     * `fee_rate` is passed EXPLICITLY, in sat/vB, at the wallet's own required
     * floor of 1.0 (max of m_min_fee 1000 sat/kvB and relayMinFee 100 sat/kvB).
     * Inheriting it from `fallbackfee` in pcoin.conf would give the same number
     * today and silently stop doing so the moment this chain has enough fee
     * history for estimatesmartfee to answer.
     *
     * minconf/maxconf/send_max are not passed: all three are documented
     * incompatible with explicit `inputs`.
     */
    private fun callSendAll(inputs: List<Utxo>, destination: String, wallet: String): Built {
        val options = JSONObject()
            .put("inputs", inputsJson(inputs))
            .put("add_to_wallet", false)
            .put("fee_rate", ForwardPolicy.FEE_RATE_SAT_VB)
            .put("lock_unspents", false)
        val params = JSONArray()
            .put(JSONArray().put(destination))
            .put(JSONObject.NULL)   // conf_target
            .put("unset")           // estimate_mode
            .put(JSONObject.NULL)   // fee_rate (positional; given in options)
            .put(options)
        val r = rpc.call("sendall", params, wallet = wallet, readTimeoutMs = BUILD_TIMEOUT_MS)
            as? JSONObject ?: return Built(false, "", "")
        return Built(r.optBoolean("complete", false), r.optString("txid"), r.optString("hex"))
    }

    /**
     * `send` for the probe, where an exact amount and change ARE wanted.
     *
     * `add_inputs` defaults to false when `inputs` are given, so the input set
     * is honoured strictly and the build stays deterministic. Change returns on
     * a wpkh() descriptor the recovery phrase recreates -- which is exactly why
     * `changetype=bech32` in pcoin.conf matters here.
     */
    private fun callProbeSend(inputs: List<Utxo>, destination: String, wallet: String): Built {
        val amount = ForwardPolicy.PROBE_SAT / 1e8
        val options = JSONObject()
            .put("inputs", inputsJson(inputs))
            .put("add_to_wallet", false)
            .put("fee_rate", ForwardPolicy.FEE_RATE_SAT_VB)
        val params = JSONArray()
            .put(JSONObject().put(destination, amount))
            .put(JSONObject.NULL)
            .put("unset")
            .put(JSONObject.NULL)
            .put(options)
        val r = rpc.call("send", params, wallet = wallet, readTimeoutMs = BUILD_TIMEOUT_MS)
            as? JSONObject ?: return Built(false, "", "")
        return Built(r.optBoolean("complete", false), r.optString("txid"), r.optString("hex"))
    }

    private fun inputsJson(inputs: List<Utxo>): JSONArray {
        val arr = JSONArray()
        inputs.forEach { arr.put(JSONObject().put("txid", it.txid).put("vout", it.vout)) }
        return arr
    }

    /** @return the reject reason verbatim, or null when the node would take it. */
    private fun testAccept(hex: String): String? {
        val r = rpc.call(
            "testmempoolaccept",
            JSONArray().put(JSONArray().put(hex)).put(ForwardPolicy.BROADCAST_MAX_FEE_RATE),
            readTimeoutMs = RPC_TIMEOUT_MS,
        ) as? JSONArray ?: return "the node did not answer testmempoolaccept"
        val first = r.optJSONObject(0) ?: return "the node did not answer testmempoolaccept"
        if (first.optBoolean("allowed", false)) return null
        return first.optString("reject-reason").ifBlank { "rejected without a reason" }
    }

    /**
     * `sendrawtransaction`.
     *
     * maxfeerate is 0.0001 **PCN/kvB** -- a different unit from the sat/vB the
     * build used two calls ago, on the same concept. 0.0001 PCN/kvB is
     * 10 sat/vB, i.e. 10x the target, which is the intended headroom.
     * maxburnamount 0 refuses anything paying to an unspendable script.
     */
    private fun broadcast(hex: String): String {
        val r = rpc.call(
            "sendrawtransaction",
            JSONArray().put(hex).put(ForwardPolicy.BROADCAST_MAX_FEE_RATE).put(0),
            readTimeoutMs = RPC_TIMEOUT_MS,
        )
        return (r as? String).orEmpty()
    }

    private fun lockInputs(wallet: String, inputs: List<Outpoint>) {
        try {
            val arr = JSONArray()
            inputs.forEach { arr.put(JSONObject().put("txid", it.txid).put("vout", it.vout)) }
            // persistent=true: written to the wallet DB, so it survives a node
            // restart. "Unlock is always persistent", so releasing is safe too.
            rpc.call(
                "lockunspent",
                JSONArray().put(false).put(arr).put(true),
                wallet = wallet,
                readTimeoutMs = RPC_TIMEOUT_MS,
            )
        } catch (e: IOException) {
            Log.w(TAG, "could not lock inputs (the record is the real guard): ${Redact.text(e.message)}")
        }
    }

    private fun unlockInputs(wallet: String, inputs: List<Outpoint>) {
        try {
            val arr = JSONArray()
            inputs.forEach { arr.put(JSONObject().put("txid", it.txid).put("vout", it.vout)) }
            rpc.call("lockunspent", JSONArray().put(true).put(arr), wallet = wallet, readTimeoutMs = RPC_TIMEOUT_MS)
        } catch (e: IOException) {
            Log.w(TAG, "could not unlock inputs: ${Redact.text(e.message)}")
        }
    }

    // ------------------------------------------------------------- resolution

    /**
     * Advances a non-terminal record by exactly what the node could establish.
     *
     * @param depth re-entry count for the ALREADY_IN_UTXO_SET path below, which
     *   calls back into this function. A node giving contradictory answers
     *   (confirmed on chain, unknown to the wallet -- a rescan, or a swapped
     *   wallet file) would otherwise recurse until the stack ran out, and the
     *   StackOverflowError would be swallowed by runEvaluation and counted as a
     *   generic "forwarding is stuck".
     */
    private fun resolveRecord(record: SweepRecord, wallet: String, depth: Int = 0) {
        val obs = observe(record.txid, wallet)
        val now = System.currentTimeMillis()
        when (ForwardPolicy.resolve(obs, record, now)) {
            ForwardPolicy.Resolution.UNRESOLVED -> {
                // Deliberately does nothing at all, including not touching the
                // record. "Checking" is the honest thing to show.
                publish(ForwardBlock.PENDING_SWEEP, record = record, confirmations = -1)
            }

            ForwardPolicy.Resolution.REBROADCAST -> {
                var next = record.copy(attempts = record.attempts + 1, lastAttemptMs = now)
                writeRecord(next)
                try {
                    broadcast(record.hex)
                    // The re-announce clock restarts here. Without this a
                    // record broadcast in the crash window would carry
                    // broadcastAtMs = 0 forever, and the 30-minute
                    // "nobody has taken it" retry would never come round.
                    next = next.copy(state = SweepState.BROADCAST, broadcastAtMs = now)
                    writeRecord(next)
                    Log.i(TAG, "re-announced ${record.txid.take(12)} (attempt ${next.attempts})")
                } catch (e: RpcClient.RpcError) {
                    if (e.code == RPC_ALREADY_IN_UTXO_SET) {
                        // It confirmed while we were not looking. Re-query
                        // rather than assume anything about how deep it is --
                        // but only so many times: if the re-query keeps saying
                        // "not in the mempool" while the broadcast keeps saying
                        // "already confirmed", the node is contradicting itself
                        // and the honest answer is to resolve nothing this time.
                        if (depth >= MAX_RESOLVE_DEPTH) {
                            Log.w(TAG, "${record.txid.take(12)}: node reports it both confirmed and absent")
                            publish(ForwardBlock.PENDING_SWEEP, record = next, confirmations = -1)
                            return
                        }
                        Log.i(TAG, "${record.txid.take(12)} is already in the UTXO set; re-checking depth")
                        resolveRecord(next, wallet, depth + 1)
                        return
                    }
                    writeRecord(next.copy(lastError = Redact.text(e.message).take(200)))
                }
                publish(ForwardBlock.PENDING_SWEEP, record = next, confirmations = 0)
            }

            ForwardPolicy.Resolution.MARK_BROADCAST ->
                advance(record, SweepState.BROADCAST, obs.confirmations, now)

            ForwardPolicy.Resolution.MARK_ACCEPTED ->
                advance(record, SweepState.ACCEPTED, obs.confirmations, now)

            ForwardPolicy.Resolution.MARK_CONFIRMED ->
                advance(record, SweepState.CONFIRMED, obs.confirmations, now)

            ForwardPolicy.Resolution.MARK_SETTLED -> settle(record, wallet, obs.confirmations)

            ForwardPolicy.Resolution.NOTE_CONFLICT -> {
                // Recorded, never acted on. One reading is not enough: acting on
                // it builds a second transaction, and being wrong about that is
                // the most expensive mistake available here.
                val seen = if (record.conflictSeenAtMs == 0L) now else record.conflictSeenAtMs
                writeRecord(record.copy(conflictSeenAtMs = seen))
                publish(ForwardBlock.PENDING_SWEEP, record = record, confirmations = obs.confirmations)
            }

            ForwardPolicy.Resolution.MARK_CONFLICTED -> {
                Log.w(TAG, "${record.txid.take(12)} conflicts with a confirmed transaction, twice over 10 min")
                unlockInputs(wallet, record.inputs)
                clearRecord()
                if (record.kind == SweepKind.PROBE &&
                    prefs.forwardState == ForwardState.PROBING_SENT &&
                    prefs.forwardProbeTxid == record.txid
                ) {
                    // The test payment was dropped, so it will never confirm and
                    // never be acknowledged. Without this the state machine
                    // waits at PROBE_AWAITING_ACK for a transaction that no
                    // longer exists and forwarding never starts.
                    prefs.forwardProbeTxid = null
                    prefs.forwardProbeConfirmed = false
                    prefs.forwardState = ForwardState.PROBING_PENDING
                }
                prefs.forwardLastError =
                    "The last forward conflicted with another transaction and was dropped. " +
                        "The coins are still in this wallet and will be forwarded again."
                publish(ForwardBlock.NONE)
            }
        }
    }

    private fun advance(record: SweepRecord, state: SweepState, confirmations: Int, nowMs: Long) {
        // A record broadcast in the crash window carries broadcastAtMs = 0,
        // because the write that stamps it comes after the broadcast returns.
        // The re-announce clock is measured from that field, so leaving it at
        // zero means `since` is zero on every future evaluation and the
        // 30-minute "no peer has taken it" retry never arrives. Stamping it at
        // the first observation is late by at most one evaluation, which only
        // ever delays a re-announce -- it can never bring one forward.
        val stamped = if (state == SweepState.BROADCAST && record.broadcastAtMs == 0L) {
            record.copy(broadcastAtMs = nowMs)
        } else {
            record
        }
        val next = stamped.copy(state = state)
        if (next != record) writeRecord(next)
        publish(ForwardBlock.PENDING_SWEEP, record = next, confirmations = confirmations)
    }

    /**
     * Terminal, and the only place a record is cleared on success.
     *
     * History is written FIRST: if the process dies between the two, a record
     * that is already settled resolves to settled again next time, which is
     * harmless, whereas history lost is a payment the user can no longer see.
     */
    private fun settle(record: SweepRecord, wallet: String, confirmations: Int) {
        unlockInputs(wallet, record.inputs)
        if (record.kind == SweepKind.SWEEP) {
            prefs.forwardLastTxid = record.txid
            prefs.forwardLastAmountSat = record.amountSat
            prefs.forwardLastAtMs = System.currentTimeMillis()
            prefs.forwardLastAddress = record.address
            notifyForward(
                NOTIF_SETTLED,
                "Forwarded ${Fmt.coinsSat(record.amountSat)}",
                "To ${ForwardPolicy.shortAddress(record.address)}. Tap to open PCoin Miner.",
                NotificationManager.IMPORTANCE_LOW,
            )
        } else {
            // The probe landed. Arming still needs the user to say they can see
            // it -- a confirmed payment proves the address accepted coins, not
            // that anyone holds the key.
            //
            // The record is the authority on "a probe was sent", so it also
            // repairs the state machine: an adopted probe, or one killed in the
            // window between writing the record and committing the state, would
            // otherwise settle here while the state still read PROBING_PENDING
            // and the next evaluation would send a second test payment.
            if (prefs.forwardProbeTxid == null) prefs.forwardProbeTxid = record.txid
            if (prefs.forwardState == ForwardState.PROBING_PENDING) {
                prefs.forwardState = ForwardState.PROBING_SENT
            }
            prefs.forwardProbeConfirmed = true
            if (!prefs.forwardProbeAcked && !probeAckNotified) {
                probeAckNotified = true
                notifyForward(
                    NOTIF_PROBE,
                    "Check your other wallet",
                    "A ${Fmt.coinsSat(ForwardPolicy.PROBE_SAT)} test payment has arrived at " +
                        "${ForwardPolicy.shortAddress(record.address)}. Confirm you can see it to " +
                        "start forwarding.",
                    NotificationManager.IMPORTANCE_DEFAULT,
                )
            }
        }
        clearRecord()
        Log.i(TAG, "${record.kind.name.lowercase()} ${record.txid.take(12)} settled at $confirmations confirmations")
        publish(ForwardBlock.NONE)
    }

    /**
     * One observation of a recorded transaction.
     *
     * Every failure mode is represented explicitly. A gettransaction that threw
     * is `readable = false` and resolves nothing; a gettransaction that
     * answered "no such transaction" is `readable = true, knownToWallet =
     * false`, which is a real fact and means the broadcast never landed.
     */
    private fun observe(txid: String, wallet: String): ForwardPolicy.TxObservation {
        var readable = false
        var known = false
        var confirmations = 0
        try {
            val r = rpc.call(
                "gettransaction",
                JSONArray().put(txid),
                wallet = wallet,
                readTimeoutMs = RPC_TIMEOUT_MS,
            ) as? JSONObject
            if (r != null) {
                readable = true
                known = true
                confirmations = r.optInt("confirmations", 0)
            }
        } catch (e: RpcClient.RpcError) {
            // -5 is the wallet's definite "I have never seen this txid".
            if (e.code == RPC_INVALID_ADDRESS_OR_KEY) readable = true
        } catch (e: IOException) {
            // Could not ask. Not evidence of anything.
        }

        var mempoolReadable = false
        var inMempool = false
        var unbroadcast = true
        if (readable && confirmations <= 0) {
            try {
                val m = rpc.call(
                    "getmempoolentry",
                    JSONArray().put(txid),
                    readTimeoutMs = RPC_TIMEOUT_MS,
                ) as? JSONObject
                if (m != null) {
                    mempoolReadable = true
                    inMempool = true
                    // The honest "did the network actually take it" signal:
                    // cleared in net_processing at the exact point the TX
                    // message is pushed to a peer that asked for it.
                    unbroadcast = m.optBoolean("unbroadcast", true)
                }
            } catch (e: RpcClient.RpcError) {
                if (e.code == RPC_INVALID_ADDRESS_OR_KEY) mempoolReadable = true
            } catch (e: IOException) {
                // Unknown, not absent.
            }
        }

        return ForwardPolicy.TxObservation(
            readable = readable,
            knownToWallet = known,
            confirmations = confirmations,
            mempoolReadable = mempoolReadable,
            inMempool = inMempool,
            unbroadcast = unbroadcast,
        )
    }

    // -------------------------------------------------------------- gathering

    /** True when the wallet is loaded AND answering right now. */
    private fun walletAnswers(wallet: String): Boolean = try {
        rpc.call("getwalletinfo", wallet = wallet, readTimeoutMs = RPC_TIMEOUT_MS) != null
    } catch (e: IOException) {
        false
    }

    /**
     * Peers that would actually accept a transaction from us.
     *
     * getconnectioncount is explicitly not used: a block-relay-only peer never
     * requests our transaction, so a node with only those can broadcast
     * "successfully" to an audience of nobody -- and then report a payment the
     * network has never seen.
     *
     * @return the count, or -1 when the node could not be asked.
     */
    private fun relayPeers(): Int = try {
        val arr = rpc.call("getpeerinfo", readTimeoutMs = RPC_TIMEOUT_MS) as? JSONArray
        if (arr == null) -1 else (0 until arr.length()).count { i ->
            val p = arr.optJSONObject(i)
            p != null &&
                p.optBoolean("relaytxes", false) &&
                p.optString("connection_type") != "block-relay-only"
        }
    } catch (e: IOException) {
        -1
    }

    private fun addressFacts(address: String, wallet: String): ForwardPolicy.AddressFacts? = try {
        // Node-level: works with no wallet loaded, and is the authority on
        // whether the string is a PCoin address at all.
        val v = rpc.call("validateaddress", JSONArray().put(address), readTimeoutMs = RPC_TIMEOUT_MS)
            as? JSONObject
        if (v == null) null else ForwardPolicy.AddressFacts(
            isValid = v.optBoolean("isvalid", false),
            isWitness = v.optBoolean("iswitness", false),
            witnessVersion = v.optInt("witness_version", 0),
            isMine = isMine(wallet, address),
            nodeError = v.optString("error"),
            scriptPubKey = v.optString("scriptPubKey"),
        )
    } catch (e: IOException) {
        null
    }

    /** getaddressinfo is wallet-scoped, so it is always aimed at the PAYOUT wallet. */
    private fun isMine(wallet: String, address: String): Boolean = try {
        (rpc.call("getaddressinfo", JSONArray().put(address), wallet = wallet, readTimeoutMs = RPC_TIMEOUT_MS)
            as? JSONObject)?.optBoolean("ismine", false) == true
    } catch (e: IOException) {
        false
    }

    /**
     * The outputs the node will let us spend right now, vetted and ordered.
     *
     * The `generated` flag comes from gettransaction, batched one call per
     * distinct txid: listunspent carries no coinbase flag at all, so without it
     * there is no way to tell a 50 PCN block reward (needing depth 107 here)
     * from an ordinary 50 PCN payment (needing 6).
     */
    private fun vettedCandidates(wallet: String): List<Utxo> {
        val list = rpc.call(
            "listunspent",
            JSONArray().put(ForwardPolicy.MIN_DEPTH).put(9_999_999),
            wallet = wallet,
            readTimeoutMs = LIST_TIMEOUT_MS,
        ) as? JSONArray ?: return emptyList()

        val raw = ArrayList<Utxo>(list.length())
        for (i in 0 until list.length()) {
            val o = list.optJSONObject(i) ?: continue
            raw.add(
                Utxo(
                    txid = o.optString("txid"),
                    vout = o.optInt("vout", -1),
                    amountSat = toSat(o.optDouble("amount", 0.0)),
                    confirmations = o.optLong("confirmations", 0L),
                    spendable = o.optBoolean("spendable", false),
                    safe = o.optBoolean("safe", false),
                    // Assumed coinbase until proved otherwise: the strict
                    // reading is the one that cannot spend an immature reward.
                    generated = true,
                )
            )
        }
        if (raw.isEmpty()) return emptyList()

        val txids = raw.map { it.txid }.filter { it.isNotBlank() }.distinct()
        val generated = HashMap<String, Boolean>(txids.size)
        txids.chunked(BATCH_SIZE).forEach { chunk ->
            val results = rpc.batchCalls(
                chunk.map { RpcClient.Req("gettransaction", JSONArray().put(it)) },
                wallet = wallet,
                readTimeoutMs = LIST_TIMEOUT_MS,
            )
            chunk.forEachIndexed { i, txid ->
                val o = results.getOrNull(i) as? JSONObject
                // A txid we could not read stays "generated", i.e. held to the
                // stricter 107-confirmation rule. Failing to read must never
                // relax a maturity check.
                if (o != null) generated[txid] = o.optBoolean("generated", false)
            }
        }

        return ForwardPolicy.vetCandidates(
            raw.filter { it.vout >= 0 && it.txid.isNotBlank() }
                .map { it.copy(generated = generated[it.txid] ?: true) }
        )
    }

    /**
     * When the next forward can realistically happen, from OBSERVED spacing.
     *
     * Never from nPowTargetSpacing: the target is 600 s and the measured value
     * on this chain today is 815-868 s, so the target would understate every
     * estimate by about 40%.
     *
     * @return milliseconds, or -1 when it cannot honestly be computed.
     */
    private fun estimateNextForward(wallet: String, height: Long): Long {
        val best = try {
            val list = rpc.call(
                "listtransactions",
                JSONArray().put("*").put(ADOPT_SCAN).put(0).put(true),
                wallet = wallet,
                readTimeoutMs = RPC_TIMEOUT_MS,
            ) as? JSONArray ?: return -1L
            var bestConf = -1L
            for (i in 0 until list.length()) {
                val tx = list.optJSONObject(i) ?: continue
                if (tx.optString("category") != "immature") continue
                val c = tx.optLong("confirmations", -1L)
                if (c in 0 until ForwardPolicy.COINBASE_SWEEP_DEPTH && c > bestConf) bestConf = c
            }
            bestConf
        } catch (e: IOException) {
            return -1L
        }
        return ForwardPolicy.etaMs(best, observedSpacing(height))
    }

    /**
     * Seconds per block over the last 100 blocks, cached for an hour.
     *
     * Two getblockheader calls. Worth it: difficulty is currently pinned by a
     * 357x retarget spike at height 2016, with no further legacy retarget until
     * 4032 and LWMA arriving at 2800, so spacing can drift a long way with no
     * self-correction and only the observed value means anything.
     */
    private fun observedSpacing(height: Long): Double {
        val now = System.currentTimeMillis()
        if (observedSpacingSec > 0.0 && now - spacingReadAtMs < SPACING_CACHE_MS) return observedSpacingSec
        if (height < SPACING_WINDOW) return observedSpacingSec
        return try {
            val tip = headerTime(height)
            val back = headerTime(height - SPACING_WINDOW)
            if (tip <= 0L || back <= 0L || tip <= back) observedSpacingSec else {
                observedSpacingSec = (tip - back).toDouble() / SPACING_WINDOW
                spacingReadAtMs = now
                observedSpacingSec
            }
        } catch (e: IOException) {
            observedSpacingSec
        }
    }

    private fun headerTime(height: Long): Long {
        val hash = rpc.call("getblockhash", JSONArray().put(height), readTimeoutMs = RPC_TIMEOUT_MS)
            as? String ?: return 0L
        return (rpc.call("getblockheader", JSONArray().put(hash), readTimeoutMs = RPC_TIMEOUT_MS)
            as? JSONObject)?.optLong("time", 0L) ?: 0L
    }

    // ------------------------------------------------------------- decoding

    private fun decode(hex: String): DecodedTx {
        val r = rpc.call("decoderawtransaction", JSONArray().put(hex), readTimeoutMs = RPC_TIMEOUT_MS)
            as? JSONObject ?: throw IOException("the node could not decode the transaction it built")
        val vin = r.optJSONArray("vin") ?: JSONArray()
        val vout = r.optJSONArray("vout") ?: JSONArray()
        val inputs = (0 until vin.length()).mapNotNull { i ->
            val o = vin.optJSONObject(i) ?: return@mapNotNull null
            val txid = o.optString("txid")
            if (txid.isBlank()) null else Outpoint(txid, o.optInt("vout", -1))
        }
        val outputs = (0 until vout.length()).mapNotNull { i ->
            val o = vout.optJSONObject(i) ?: return@mapNotNull null
            val spk = o.optJSONObject("scriptPubKey")
            DecodedOut(
                address = spk?.optString("address").orEmpty(),
                scriptHex = spk?.optString("hex").orEmpty(),
                valueSat = toSat(o.optDouble("value", 0.0)),
            )
        }
        return DecodedTx(r.optString("txid"), inputs, outputs)
    }

    /**
     * Fills in ismine/ischange for the probe's change output.
     *
     * This is the assertion that catches a mis-built transaction quietly
     * sending 49 PCN of change to a stranger while the 1 PCN test payment looks
     * perfect, so it is worth the extra round trip.
     */
    private fun annotateChange(tx: DecodedTx, wallet: String, destination: String): DecodedTx {
        val outs = tx.outputs.map { out ->
            if (out.address == destination || out.address.isBlank()) out else {
                val info = try {
                    rpc.call(
                        "getaddressinfo",
                        JSONArray().put(out.address),
                        wallet = wallet,
                        readTimeoutMs = RPC_TIMEOUT_MS,
                    ) as? JSONObject
                } catch (e: IOException) {
                    null
                }
                out.copy(
                    isMine = info?.optBoolean("ismine", false) == true,
                    isChange = info?.optBoolean("ischange", false) == true,
                )
            }
        }
        return tx.copy(outputs = outs)
    }

    // ------------------------------------------------------------ persistence

    /**
     * True when a record exists on disk but could not be parsed.
     *
     * Set by [readRecord] and checked before anything is allowed to build. An
     * unparseable record must NOT read as "no record": that would authorise a
     * build over coins that may already be committed to a transaction we can no
     * longer see. It parks forwarding instead, and the user gets a Clear button
     * behind the unlock gate in the forwarding screen.
     */
    private var recordUnreadable = false

    private fun readRecord(): SweepRecord? {
        recordUnreadable = false
        val json = prefs.forwardSweepRecordJson ?: return null
        return try {
            recordFromJson(JSONObject(json))
        } catch (t: Throwable) {
            recordUnreadable = true
            Log.e(TAG, "sweep record is unreadable; forwarding is parked: ${t.javaClass.simpleName}")
            prefs.forwardLastError =
                "The record of the last forward could not be read, so nothing new will be sent. " +
                    "Your coins are safe in this wallet."
            null
        }
    }

    private fun writeRecord(record: SweepRecord) {
        prefs.forwardSweepRecordJson = recordToJson(record).toString()
    }

    private fun clearRecord() {
        prefs.forwardSweepRecordJson = null
    }

    // ------------------------------------------------------------------- UI

    private fun publish(
        block: ForwardBlock,
        record: SweepRecord? = null,
        confirmations: Int = -1,
        sweepableSat: Long = -1L,
        etaMs: Long = -1L,
    ) {
        prefs.forwardBlockedReason = block.reason.ifBlank { null }
        MinerState.update {
            it.copy(
                forwardState = prefs.forwardState,
                forwardAddress = prefs.forwardAddress.orEmpty(),
                forwardBlocked = block.reason,
                forwardSweepKind = record?.kind,
                forwardSweepState = record?.state,
                forwardSweepAmountSat = record?.amountSat ?: -1L,
                forwardSweepAddress = record?.address.orEmpty(),
                forwardSweepConfirmations = confirmations,
                forwardSweepableSat = sweepableSat,
                forwardEtaMs = etaMs,
                forwardProbeConfirmed = prefs.forwardProbeConfirmed,
                forwardError = prefs.forwardLastError.orEmpty(),
            )
        }
    }

    /**
     * A separate channel from the mining notification, on purpose: nothing here
     * should buzz during ordinary mining, and "no peers" / "syncing" / "nothing
     * mature" never notify at all -- they are ordinary states shown in-app.
     */
    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val mgr = appContext.getSystemService(NotificationManager::class.java) ?: return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "PCoin forwarding",
            NotificationManager.IMPORTANCE_DEFAULT,
        ).apply {
            description = "Tells you when mined coins have been forwarded, or when forwarding needs you."
            setShowBadge(true)
        }
        mgr.createNotificationChannel(channel)
    }

    private fun notifyForward(id: Int, title: String, body: String, importance: Int) {
        val mgr = appContext.getSystemService(NotificationManager::class.java) ?: return
        val open = PendingIntent.getActivity(
            appContext,
            id,
            Intent(appContext, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val n = NotificationCompat.Builder(appContext, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_upload_done)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setPriority(
                if (importance >= NotificationManager.IMPORTANCE_DEFAULT) {
                    NotificationCompat.PRIORITY_DEFAULT
                } else {
                    NotificationCompat.PRIORITY_LOW
                }
            )
            .setContentIntent(open)
            .build()
        try {
            mgr.notify(id, n)
        } catch (t: Throwable) {
            Log.w(TAG, "forward notify failed: ${t.message}")
        }
    }

    companion object {
        const val TAG = "PCoinForward"

        private const val CHANNEL_ID = "pcoin_forward"
        private const val NOTIF_SETTLED = 2001
        private const val NOTIF_PROBE = 2002
        private const val NOTIF_STUCK = 2003

        /** RPC_INVALID_ADDRESS_OR_KEY: the definite "I have never seen it". */
        private const val RPC_INVALID_ADDRESS_OR_KEY = -5

        /** RPC_VERIFY_ALREADY_IN_UTXO_SET: it confirmed. */
        private const val RPC_ALREADY_IN_UTXO_SET = -27

        private const val RPC_TIMEOUT_MS = 30_000
        private const val LIST_TIMEOUT_MS = 30_000
        private const val BUILD_TIMEOUT_MS = 60_000

        /** How far back to look for an unconfirmed outgoing wallet transaction. */
        private const val ADOPT_SCAN = 100

        /** gettransaction calls per batched HTTP round trip. */
        private const val BATCH_SIZE = 50

        private const val SPACING_WINDOW = 100L
        private const val SPACING_CACHE_MS = 60 * 60_000L

        /** Consecutive failed evaluations before the user is told. Never 1. */
        private const val STUCK_AFTER_FAILURES = 3

        /** Re-entries allowed into resolveRecord from the -27 recovery path. */
        private const val MAX_RESOLVE_DEPTH = 2

        /**
         * Set by the UI when the user changes something that should be acted on
         * without waiting for the next block.
         *
         * A plain volatile is the whole mechanism because the activity and the
         * service live in the same process (exactly as [MinerState] does). It
         * only ever asks for an EVALUATION -- it can never make one send early,
         * because every precondition is still checked.
         */
        @Volatile
        private var evaluationRequested = false

        /**
         * Set when forwarding is armed, so the next evaluation re-runs full
         * reconciliation (adoption + stale-lock release) rather than trusting
         * the bring-up short-circuit that fires for an install which has never
         * forwarded -- the state a wiped install is indistinguishable from.
         */
        @Volatile
        private var reconcileRequested = false

        fun requestEvaluation() {
            evaluationRequested = true
        }

        fun requestReconcile() {
            reconcileRequested = true
            evaluationRequested = true
        }

        /**
         * Serialises the user's stored forwarding INTENT against the moment a
         * transaction is committed to.
         *
         * The activity and the service share a process, so the address the
         * engine read at the top of an evaluation can be replaced by the user
         * while a build is running -- `sendall` alone may take up to a minute.
         * Without this, [ForwardActivity.store] would see no record yet, take
         * the "nothing in flight" branch and overwrite the address, and the
         * build in progress would then pay the OLD one and report it as done;
         * "stop forwarding" would likewise be defeated by a sweep that went out
         * afterwards.
         *
         * Held only across a re-read plus a SharedPreferences commit on both
         * sides -- never across an RPC -- so the UI thread is never blocked on
         * the network. Whichever side takes it first wins cleanly: the activity
         * first means the engine sees the change and abandons an unsent
         * transaction; the engine first means the record exists, so the
         * activity queues the new address instead of applying it.
         */
        val INTENT_LOCK = Any()

        // ---------------------------------------------------- record codec

        fun recordToJson(r: SweepRecord): JSONObject {
            val inputs = JSONArray()
            r.inputs.forEach { inputs.put(JSONObject().put("txid", it.txid).put("vout", it.vout)) }
            return JSONObject()
                .put("txid", r.txid)
                .put("hex", r.hex)
                .put("inputs", inputs)
                .put("amountSat", r.amountSat)
                .put("feeSat", r.feeSat)
                .put("address", r.address)
                .put("state", r.state.name)
                .put("kind", r.kind.name)
                .put("createdAtMs", r.createdAtMs)
                .put("broadcastAtMs", r.broadcastAtMs)
                .put("attempts", r.attempts)
                .put("lastAttemptMs", r.lastAttemptMs)
                .put("lastError", r.lastError)
                .put("conflictSeenAtMs", r.conflictSeenAtMs)
        }

        fun recordFromJson(o: JSONObject): SweepRecord {
            val arr = o.optJSONArray("inputs") ?: JSONArray()
            val inputs = (0 until arr.length()).mapNotNull { i ->
                val e = arr.optJSONObject(i) ?: return@mapNotNull null
                Outpoint(e.optString("txid"), e.optInt("vout", -1))
            }
            val txid = o.optString("txid")
            val hex = o.optString("hex")
            // A record with no txid or no hex is not a record: it cannot be
            // resolved and it cannot be re-broadcast. Refuse to parse it rather
            // than hand back something half-true.
            if (txid.isBlank() || hex.isBlank()) throw IllegalArgumentException("record is incomplete")
            return SweepRecord(
                txid = txid,
                hex = hex,
                inputs = inputs,
                amountSat = o.optLong("amountSat", -1L),
                feeSat = o.optLong("feeSat", -1L),
                address = o.optString("address"),
                state = SweepState.entries.firstOrNull { it.name == o.optString("state") }
                    ?: SweepState.BROADCASTING,
                kind = SweepKind.entries.firstOrNull { it.name == o.optString("kind") }
                    ?: SweepKind.SWEEP,
                createdAtMs = o.optLong("createdAtMs", 0L),
                broadcastAtMs = o.optLong("broadcastAtMs", 0L),
                attempts = o.optInt("attempts", 0),
                lastAttemptMs = o.optLong("lastAttemptMs", 0L),
                lastError = o.optString("lastError"),
                conflictSeenAtMs = o.optLong("conflictSeenAtMs", 0L),
            )
        }

        /** PCN as the node reports it, to satoshi. */
        fun toSat(coins: Double): Long = Math.round(coins * 1e8)
    }
}
