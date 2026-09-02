package org.pcoin.miner

import kotlin.math.ceil
import kotlin.math.max

/**
 * Every decision the auto-forward feature makes, with no Android and no I/O.
 *
 * This file is deliberately pure. Not for elegance -- because the decisions in
 * here are the ones that spend money, and the only way to be sure they are
 * right is to run them, exhaustively, on a plain JVM against every awkward
 * input a real chain produces. [ForwardEngine] does the talking to the node and
 * owns nothing but plumbing; everything that decides IF, WHEN and HOW MUCH is
 * here, and every branch of it is covered by ForwardPolicyTest.
 *
 * The doctrine this file exists to enforce, stated once:
 *
 *   **An RPC that failed, timed out, or answered "I do not know" resolves
 *   nothing.** It can never advance a record, never clear one, and never
 *   authorise a build. Three bugs have already shipped on this project from
 *   treating a transient read as authoritative state; in a send path that class
 *   of bug spends money twice. So every input that could be "unknown" is
 *   modelled as an explicit unknown ([ForwardConditions.nodeAnswered],
 *   [TxObservation.readable], [TxObservation.mempoolReadable]) rather than
 *   collapsed into a boolean that reads as "no".
 */

/**
 * The user's persisted intent about forwarding. Written only by a user action,
 * never by anything derived from a node read.
 *
 * The default is [HOLDING] and that is a complete, safe, permanent state: the
 * app's own wallet is phrase-backed, so coins accumulating there are as safe as
 * coins anywhere. Forwarding is opt-in, and nothing forwards until the user has
 * both set an address and confirmed a test payment arrived at it.
 */
enum class ForwardState {
    /** No address set. Accumulate in this wallet forever. The default. */
    HOLDING,

    /** Address set and validated; a test payment is owed but not yet sent. */
    PROBING_PENDING,

    /** Test payment broadcast. Full forwarding stays off until it is acked. */
    PROBING_SENT,

    /** Test payment acknowledged and confirmed. Sweeps may run. */
    ARMED,
}

/**
 * Lifecycle of one signed transaction this app built.
 *
 * BROADCAST is deliberately not called "sent". `sendrawtransaction` returning a
 * txid only proves the LOCAL mempool took it -- with one peer, or with only
 * block-relay-only peers, nobody else has seen it. ACCEPTED is the first state
 * that may be worded as anything other than "waiting for a peer", and it is
 * reached only when the node's own `unbroadcast` flag clears, i.e. when a peer
 * asked for the transaction and got it.
 */
enum class SweepState {
    BROADCASTING,
    BROADCAST,
    ACCEPTED,
    CONFIRMED,
    SETTLED,
    FAILED_CONFLICTED;

    /** Terminal states are the only ones that may clear a record. */
    val terminal: Boolean get() = this == SETTLED || this == FAILED_CONFLICTED
}

enum class SweepKind { SWEEP, PROBE }

/** One transaction output, identified. */
data class Outpoint(val txid: String, val vout: Int)

/**
 * A candidate input, exactly as `listunspent` plus `gettransaction.generated`
 * describe it.
 *
 * [generated] comes from `gettransaction`, not `listunspent`: listunspent
 * carries no coinbase flag at all, so without the extra round trip there is no
 * way to tell a 50 PCN block reward (unspendable until depth 101) from an
 * ordinary 50 PCN payment.
 */
data class Utxo(
    val txid: String,
    val vout: Int,
    val amountSat: Long,
    val confirmations: Long,
    val spendable: Boolean,
    val safe: Boolean,
    val generated: Boolean,
) {
    val outpoint: Outpoint get() = Outpoint(txid, vout)
}

/** A transaction as `decoderawtransaction` describes it. */
data class DecodedTx(
    val txid: String,
    val inputs: List<Outpoint>,
    val outputs: List<DecodedOut>,
)

data class DecodedOut(
    val address: String,
    val scriptHex: String,
    val valueSat: Long,
    /** From getaddressinfo on the payout wallet. Only asked for probe change. */
    val isMine: Boolean = false,
    val isChange: Boolean = false,
)

/**
 * The persisted record of a transaction this app has committed to.
 *
 * Written to disk BEFORE the broadcast and cleared only on a terminal,
 * node-confirmed outcome. [hex] is persisted rather than re-derived because the
 * build uses `add_to_wallet: false` -- so in the crash window between building
 * and broadcasting, `gettransaction(txid).hex` would not exist. Re-broadcasting
 * the stored hex is the ONLY recovery action; a rebuild is never permitted.
 */
data class SweepRecord(
    val txid: String,
    val hex: String,
    val inputs: List<Outpoint>,
    val amountSat: Long,
    val feeSat: Long,
    val address: String,
    val state: SweepState,
    val kind: SweepKind,
    val createdAtMs: Long,
    val broadcastAtMs: Long = 0L,
    val attempts: Int = 0,
    val lastAttemptMs: Long = 0L,
    val lastError: String = "",
    /** When a `confirmations < 0` reading was FIRST seen. Never acted on alone. */
    val conflictSeenAtMs: Long = 0L,
)

/** What this evaluation is allowed to do. */
enum class ForwardAction { NONE, PROBE, SWEEP }

/**
 * Why forwarding is not sending anything right now.
 *
 * Every one of these is shown to the user verbatim. Most of them are ordinary
 * states, not errors -- NOTHING_MATURE is what a healthy phone reports for most
 * of every day -- so the wording is chosen to read as a status, not a fault.
 */
enum class ForwardBlock(val reason: String) {
    NONE(""),
    SHUTTING_DOWN("Stopping."),
    HOLDING("Holding coins in this wallet."),
    PENDING_SWEEP("Waiting for the previous forward to settle."),
    NODE_NOT_READY("Node not ready."),
    SYNCING("Node still syncing."),
    TIP_STALE("Chain stalled, or this phone is isolated."),
    NO_RELAY_PEER("No peer that will accept transactions."),
    WALLET_NOT_LOADED("Wallet not loaded."),
    ADDRESS_PARKED("The saved forwarding address no longer validates."),
    PROBE_AWAITING_ACK("Waiting for you to confirm the test payment arrived."),
    NOTHING_MATURE("Nothing mature to forward yet."),
}

data class ForwardDecision(val action: ForwardAction, val block: ForwardBlock) {
    val clear: Boolean get() = action != ForwardAction.NONE
}

/**
 * Everything an evaluation needs to know, gathered fresh every time.
 *
 * Nothing in here is remembered between evaluations, and nothing in here is
 * read from prefs except [forwardState] and [recordNonTerminal], which are
 * persisted intent. Peer counts, balances, heights and confirmation counts are
 * live readings and are re-derived every time.
 */
data class ForwardConditions(
    val alive: Boolean,
    val forwardState: ForwardState,
    /** True when a sweep record exists in a non-terminal state. */
    val recordNonTerminal: Boolean,
    /** False when the RPC used to gather these numbers failed. Never "no". */
    val nodeAnswered: Boolean,
    val initialBlockDownload: Boolean,
    val height: Long,
    val headers: Long,
    /** `getblockchaininfo.time` -- the tip's own timestamp, seconds. */
    val tipTimeSec: Long,
    val nowMs: Long,
    /** Peers with relaytxes true that are NOT block-relay-only. */
    val relayPeers: Int,
    val payoutWalletLoaded: Boolean,
    /** Re-derived every evaluation by validateaddress. Never cached. */
    val destinationValid: Boolean,
    /** Sum of the VETTED candidate set -- not getbalances.trusted. */
    val sweepableSat: Long,
    val candidateCount: Int,
    /** Value of the single candidate a probe would spend. 0 when there is none. */
    val probeCandidateSat: Long,
)

object ForwardPolicy {

    // ------------------------------------------------------------ thresholds

    /**
     * Smallest sweep worth building, 1.00000000 PCN.
     *
     * Not a fee rule. At the 1 sat/vB floor a one-input sweep costs 110 sat
     * against a 50 PCN reward -- fees on this chain are irrelevant, and the
     * formal `value >= 1000 x fee` arm below never binds. What this floor
     * actually does is refuse to build a transaction for leftover dust: a stray
     * change output, a tiny inbound payment. At 1/50th of a block reward it can
     * never delay a genuine mining payout by even one block.
     */
    const val MIN_SWEEP_SAT = 100_000_000L

    /**
     * The test payment, 1.00000000 PCN.
     *
     * Big enough to be unmissable in any wallet UI (340,000x the 294 sat
     * P2WPKH dust threshold), small enough that sending it to the wrong place
     * is a lesson rather than a loss. 2% of one block reward.
     */
    const val PROBE_SAT = 100_000_000L

    /**
     * Caps transaction size at 13.6 kvB (well under the 100 kvB standardness
     * limit) and RPC latency when someone arms forwarding after months of
     * holding. The remainder sweeps on the next evaluation.
     */
    const val MAX_INPUTS_PER_SWEEP = 200

    /**
     * Depth a coinbase must reach before this app will spend it.
     *
     * Consensus makes it spendable at 101 (`nSpendHeight - coin.nHeight <
     * COINBASE_MATURITY`, COINBASE_MATURITY = 100). Building at exactly 101
     * means a ONE-BLOCK REORG invalidates the signed transaction: the input
     * drops back to immature, the transaction is evicted, and the sweep fails
     * silently. Six blocks of margin removes that whole failure class for about
     * 1.4 h against a ~25 h maturity wait.
     */
    const val COINBASE_SWEEP_DEPTH = 107L

    /** Ordinary outputs have no maturity rule; 6 is conventional and enough. */
    const val MIN_DEPTH = 6L

    /** Confirmations at which a record becomes terminal. */
    const val SETTLED_CONFIRMATIONS = 6

    /**
     * How stale the tip may be before we refuse to send.
     *
     * Measured spacing on PCoin today is 815-868 s, not the 600 s target. With
     * a mean of 868 s, P(gap > 20 min) = 25% -- so a 20-minute tolerance would
     * false-alarm a quarter of the time. At 3 h, P = 4e-6, and still only 0.2%
     * if the chain halves in speed before LWMA activates at height 2800.
     *
     * This is a backstop, not the primary isolation detector: a phone that is
     * eclipsed keeps MINING, so it extends its own fork and its tip stays
     * fresh. [ForwardConditions.relayPeers] is the real detector.
     */
    const val TIP_AGE_LIMIT_MS = 3 * 60 * 60 * 1000L

    /** At most one evaluation a minute, however many blocks arrive. */
    const val EVAL_DEBOUNCE_MS = 60_000L

    /**
     * One evaluation every half hour regardless of blocks, so a pending sweep
     * still gets re-announced and refreshed on a chain that has gone quiet.
     */
    const val EVAL_BACKSTOP_MS = 30 * 60_000L

    /** How long a transaction may sit unbroadcast before we re-announce it. */
    const val REANNOUNCE_AFTER_MS = 30 * 60_000L

    /**
     * A `confirmations < 0` reading must be seen twice, this far apart, before
     * a record is declared conflicted. Acting on a single reading is the one
     * place where being wrong builds a SECOND transaction.
     */
    const val CONFLICT_CONFIRM_MS = 10 * 60_000L

    /** Same tolerance the mining gate uses; blocks and headers arrive apart. */
    const val SYNC_TOLERANCE_BLOCKS = 3L

    /**
     * The wallet's own floor, in sat/vB: max(m_min_fee = 1000 sat/kvB,
     * relayMinFee = 100 sat/kvB) = 1.000 sat/vB. Anything lower is rejected
     * outright ("Fee rate is lower than the minimum fee rate setting");
     * anything higher is waste on a chain whose mempool holds one transaction.
     *
     * Passed explicitly rather than inherited from `fallbackfee`, which today
     * happens to give the same number but is only consulted while
     * estimatesmartfee returns nothing. The moment PCoin has fee history that
     * config line stops applying and every sweep would silently change price.
     */
    const val FEE_RATE_SAT_VB = 1.0

    /**
     * `sendrawtransaction`'s maxfeerate, in PCN/kvB -- a DIFFERENT UNIT from
     * the sat/vB above, on the immediately adjacent call. 0.0001 PCN/kvB =
     * 10 sat/vB = 10x our target, which is the intended headroom.
     *
     * This is the cap for the AUTOMATIC sweep/probe path, which always pays
     * the floor rate. A user-directed send carries its tier's own cap
     * ([FeeTier.broadcastMaxFeeRatePcnKvb]) instead; for [FeeTier.NORMAL] the
     * two are equal by construction, and a test asserts it.
     */
    const val BROADCAST_MAX_FEE_RATE = 0.0001

    /**
     * Every fee ceiling is `rate x this`, in both units: the decoded-fee
     * ceilings ([maxFeeSat], [maxFeeSatFor]) and the broadcast maxfeerate.
     * One number so the "raised in lockstep" property is structural.
     */
    const val FEE_CEILING_HEADROOM = 10.0

    /**
     * The rates a user can choose on the send screen. STATIC on purpose:
     * this chain has no fee history (blocks are mostly coinbase-only), so
     * `estimatesmartfee` returns an error, not a number, and there is nothing
     * to be dynamic about. A higher tier buys robustness -- clearing a miner
     * running a raised `blockmintxfee`, or outbidding a competing tx -- not
     * auction position.
     *
     * Only this enum can reach the user path's `fee_rate`, so only these
     * three vetted values can ever be sent.
     */
    enum class FeeTier(val rateSatVb: Double) {
        NORMAL(1.0),
        FAST(5.0),
        VERY_FAST(20.0);

        /**
         * The `sendrawtransaction`/`testmempoolaccept` maxfeerate for this
         * tier, in PCN/kvB. 1 sat/vB = 1e-5 PCN/kvB; the only place that
         * conversion is written.
         */
        val broadcastMaxFeeRatePcnKvb: Double
            get() = rateSatVb * FEE_CEILING_HEADROOM / 100_000.0
    }

    /** P2WPKH sweep to one output: weight 166 + 272n, i.e. vsize 41.5 + 68n. */
    fun estimatedVsize(inputs: Int): Double = 41.5 + 68.0 * inputs

    /** What the sweep should cost at the 1 sat/vB floor. */
    fun estimatedFeeSat(inputs: Int): Long = ceil(estimatedVsize(inputs) * FEE_RATE_SAT_VB).toLong()

    /**
     * Hard ceiling asserted against the DECODED transaction before broadcast.
     * 10x headroom over target: 1,095 sat at one input, 136,415 at two hundred.
     * This is the assertion that catches a fee-unit blunder before it costs
     * anything.
     */
    fun maxFeeSat(inputs: Int): Long = ceil(FEE_CEILING_HEADROOM * estimatedVsize(inputs)).toLong()

    /**
     * The same ceiling for a transaction the NODE chose the inputs for.
     *
     * A user-directed send does not pass an input set, so the count is only
     * known after decoding. Two outputs rather than one adds 31 vbytes.
     *
     * Scales with the tier's rate so that Fast/Very fast keep the SAME 10x
     * headroom rather than a loosened absolute bound; the default keeps every
     * floor-rate caller and test exactly where it was.
     */
    fun maxFeeSatFor(inputs: Int, outputs: Int, rateSatVb: Double = FEE_RATE_SAT_VB): Long =
        ceil(FEE_CEILING_HEADROOM * rateSatVb * (10.5 + 68.0 * inputs + 31.0 * outputs)).toLong()

    /**
     * A user-directed send, checked against the transaction the node actually
     * built rather than the one we asked for.
     *
     * Everything here is asserted on the DECODED bytes. The request said what we
     * wanted; this says what we got, and only the second one is about to be
     * broadcast.
     *
     * The change assertion is the one that matters, and it is the same reasoning
     * as [verifyProbe]: a mis-built transaction could pay the destination
     * perfectly and quietly send the remaining balance to a stranger. Change
     * must be ours AND on a change descriptor.
     *
     * @param sendMax true when the user asked to empty the wallet, in which case
     *   there is no change and exactly one output is expected.
     */
    fun verifyUserSend(
        decoded: DecodedTx,
        destination: String,
        expectedScriptHex: String,
        expectedTxid: String,
        requestedSat: Long,
        sendMax: Boolean,
        inputValueSat: Long,
        rateSatVb: Double = FEE_RATE_SAT_VB,
    ): String? {
        if (decoded.txid != expectedTxid) return "txid does not match the decoded transaction"
        if (decoded.inputs.isEmpty()) return "the transaction spends nothing"

        val expectedOutputs = if (sendMax) 1 else 2
        // Core folds sub-dust change into the fee, so an exact-amount send can
        // legitimately come back with one output. More than expected never can.
        if (decoded.outputs.size > expectedOutputs) {
            return "expected at most $expectedOutputs outputs, got ${decoded.outputs.size}"
        }
        if (decoded.outputs.isEmpty()) return "the transaction pays nothing"

        val paidIndex = decoded.outputs.indexOfFirst { it.address == destination }
        if (paidIndex < 0) return "no output pays the address you entered"
        val paid = decoded.outputs[paidIndex]

        if (!scriptMatches(paid.scriptHex, expectedScriptHex)) {
            return "the output script does not match that address"
        }
        if (!sendMax && paid.valueSat != requestedSat) {
            return "the amount built is ${paid.valueSat} sat, not the ${requestedSat} sat you asked for"
        }

        if (decoded.outputs.size == 2) {
            val change = decoded.outputs[1 - paidIndex]
            if (!change.isMine) return "change does not come back to this wallet"
            if (!change.isChange) return "change is not on a change descriptor"
        }

        val outValue = decoded.outputs.sumOf { it.valueSat }
        val fee = inputValueSat - outValue
        if (fee <= 0) return "fee is not positive"
        val ceiling = maxFeeSatFor(decoded.inputs.size, decoded.outputs.size, rateSatVb)
        if (fee > ceiling) return "fee $fee sat exceeds the $ceiling sat ceiling at $rateSatVb sat/vB"
        return null
    }

    /**
     * The formal floor: `max(1 PCN, 1000 x estimated fee)`. At 1 sat/vB the
     * second arm is 0.0011 PCN for one input, so it never binds today -- it is
     * here so that if this chain ever grows a fee market, the sweep stops being
     * worth building before it stops being worth having.
     */
    fun minSweepSat(inputs: Int): Long =
        max(MIN_SWEEP_SAT, 1000L * estimatedFeeSat(max(inputs, 1)))

    // ------------------------------------------------------------- scheduling

    /**
     * Whether this tick should run an evaluation at all.
     *
     * Driven off the one event that can change the answer -- a new block --
     * because a timer decoupled from the chain can fire in the middle of a
     * reorg or a resync, where whatever it computes is meaningless. Height is
     * already fetched every 3 s tick, so this costs nothing new.
     *
     * A 1-2 hour timer, which is what was originally asked for, would find
     * nothing to do on 60-95% of runs depending on the device: a flagship
     * produces a maturing coinbase every ~2.2 h and an entry phone every ~20 h,
     * and each one is spendable only ~25 h after it was found.
     */
    fun shouldEvaluate(
        height: Long,
        lastEvaluatedHeight: Long,
        nowMs: Long,
        lastEvaluationMs: Long,
        force: Boolean = false,
    ): Boolean {
        if (force) return true
        val since = nowMs - lastEvaluationMs
        // Backstop first: a pending sweep needs re-announcing and refreshing
        // even on a chain that has produced nothing for half an hour.
        if (lastEvaluationMs != 0L && since >= EVAL_BACKSTOP_MS) return true
        if (lastEvaluationMs != 0L && since < EVAL_DEBOUNCE_MS) return false
        if (height < 0) return false
        return height != lastEvaluatedHeight
    }

    // -------------------------------------------------------------- candidates

    /**
     * The outputs the node will actually let us spend right now, in the order a
     * sweep will spend them.
     *
     * Deterministic ordering is not cosmetic: it is what guarantees that two
     * attempts at the same moment select the same inputs and therefore CONFLICT
     * rather than both pay.
     */
    fun vetCandidates(all: List<Utxo>): List<Utxo> = all
        .filter { it.spendable && it.safe }
        .filter { it.confirmations >= if (it.generated) COINBASE_SWEEP_DEPTH else MIN_DEPTH }
        .sortedWith(compareBy({ it.txid }, { it.vout }))
        .take(MAX_INPUTS_PER_SWEEP)

    fun totalSat(utxos: List<Utxo>): Long = utxos.sumOf { it.amountSat }

    // ------------------------------------------------------------ the decision

    /**
     * The whole trigger, as one predicate over freshly-read state.
     *
     * Order matters and is the order the spec lists: cheap persisted intent
     * first, then node readiness, then network reachability, then value. Each
     * failure carries its own reason, which is what the UI shows -- "not
     * forwarding" with no explanation is the thing this design is trying hardest
     * to avoid.
     */
    fun decide(c: ForwardConditions): ForwardDecision {
        if (!c.alive) return blocked(ForwardBlock.SHUTTING_DOWN)
        // Not an error and never shown as one: no address set is a complete,
        // safe state, and the wallet holding the coins is phrase-backed.
        if (c.forwardState == ForwardState.HOLDING) return blocked(ForwardBlock.HOLDING)
        // Before anything else that could build: one record at a time, ever.
        if (c.recordNonTerminal) return blocked(ForwardBlock.PENDING_SWEEP)
        // An unanswered node is never clear-to-send. This is the doctrine.
        if (!c.nodeAnswered) return blocked(ForwardBlock.NODE_NOT_READY)
        if (c.initialBlockDownload) return blocked(ForwardBlock.SYNCING)
        if (c.height < 0 || c.headers < 0) return blocked(ForwardBlock.SYNCING)
        if (c.headers - c.height > SYNC_TOLERANCE_BLOCKS) return blocked(ForwardBlock.SYNCING)
        if (tipAgeMs(c.tipTimeSec, c.nowMs) > TIP_AGE_LIMIT_MS) return blocked(ForwardBlock.TIP_STALE)
        // getconnectioncount > 0 is explicitly NOT sufficient: a
        // block-relay-only peer never requests our transaction, so a node with
        // only those can "successfully" broadcast to an audience of nobody.
        if (c.relayPeers < 1) return blocked(ForwardBlock.NO_RELAY_PEER)
        if (!c.payoutWalletLoaded) return blocked(ForwardBlock.WALLET_NOT_LOADED)
        // Parks forwarding; never rewrites or clears the stored address.
        if (!c.destinationValid) return blocked(ForwardBlock.ADDRESS_PARKED)

        return when (c.forwardState) {
            ForwardState.PROBING_SENT -> blocked(ForwardBlock.PROBE_AWAITING_ACK)
            ForwardState.PROBING_PENDING ->
                if (c.candidateCount >= 1 && c.probeCandidateSat >= PROBE_SAT + maxFeeSat(1)) {
                    ForwardDecision(ForwardAction.PROBE, ForwardBlock.NONE)
                } else {
                    blocked(ForwardBlock.NOTHING_MATURE)
                }
            ForwardState.ARMED ->
                if (c.candidateCount >= 1 && c.sweepableSat >= minSweepSat(c.candidateCount)) {
                    ForwardDecision(ForwardAction.SWEEP, ForwardBlock.NONE)
                } else {
                    blocked(ForwardBlock.NOTHING_MATURE)
                }
            ForwardState.HOLDING -> blocked(ForwardBlock.HOLDING) // unreachable
        }
    }

    private fun blocked(b: ForwardBlock) = ForwardDecision(ForwardAction.NONE, b)

    /**
     * Tip age, clamped at zero.
     *
     * A block timestamp up to LWMA_MAX_FUTURE_BLOCK_TIME (900 s) ahead of local
     * time is perfectly legal, so a negative age is ordinary and must not read
     * as "very fresh" by accident, nor as an error.
     *
     * Uses the tip's own `time`, never `mediantime`: mediantime lags 5 blocks
     * by construction, which at this chain's ~868 s spacing is ~72 minutes, and
     * would make a 3 h check meaningless.
     */
    fun tipAgeMs(tipTimeSec: Long, nowMs: Long): Long =
        if (tipTimeSec <= 0L) Long.MAX_VALUE else max(0L, nowMs - tipTimeSec * 1000L)

    // -------------------------------------------------- decode-time assertions

    /**
     * The gate between "built" and "committed".
     *
     * Called on the decoded, signed, NOT-yet-broadcast transaction. Every
     * assertion has to hold; the first failure aborts with the coins exactly
     * where they were, which is the safe failure direction. Returns null when
     * everything holds, or the name of the assertion that did not.
     *
     * @param expectedScriptHex an INDEPENDENT second derivation of the
     *   destination, from validateaddress, in case address rendering and
     *   address encoding ever disagree.
     */
    fun verifySweep(
        decoded: DecodedTx,
        planned: List<Utxo>,
        destination: String,
        expectedScriptHex: String,
        expectedTxid: String,
    ): String? {
        if (decoded.outputs.size != 1) return "a: expected exactly 1 output, got ${decoded.outputs.size}"
        val out = decoded.outputs[0]
        if (out.address != destination) return "b: output pays a different address"
        if (!scriptMatches(out.scriptHex, expectedScriptHex)) {
            return "c: output script does not match the destination's own script"
        }
        val plannedSet = planned.map { it.outpoint }.toSet()
        if (decoded.inputs.size != plannedSet.size || decoded.inputs.toSet() != plannedSet) {
            return "d: inputs are not the ones selected"
        }
        val inValue = planned.sumOf { it.amountSat }
        // The only independent value this can be checked against is the app's
        // own selection, so the fee IS the difference by construction. Do not
        // add "output == inValue - fee" back: it expands to `x != x` and reads
        // as a balance check that can never fire. The real protections are the
        // ceiling below, which does bind, and testmempoolaccept.
        val fee = inValue - out.valueSat
        val ceiling = maxFeeSat(planned.size)
        if (fee <= 0) return "e: fee is not positive"
        if (fee > ceiling) return "e: fee $fee sat exceeds the $ceiling sat ceiling"
        if (out.valueSat < MIN_SWEEP_SAT) return "f: output is below the minimum sweep"
        if (decoded.txid != expectedTxid) return "g: txid does not match the decoded transaction"
        return null
    }

    /**
     * The same gate for the probe, where the shape is different: an exact
     * amount to the destination plus change back to us.
     *
     * The change assertion is the one that matters. Without it a mis-built
     * transaction could quietly send 49 PCN of change to a stranger while the
     * 1 PCN test payment looked perfect.
     */
    fun verifyProbe(
        decoded: DecodedTx,
        planned: List<Utxo>,
        destination: String,
        expectedScriptHex: String,
        expectedTxid: String,
    ): String? {
        if (decoded.outputs.size != 2) return "a: expected exactly 2 outputs, got ${decoded.outputs.size}"
        val paidIndex = decoded.outputs.indexOfFirst { it.address == destination }
        if (paidIndex < 0) return "b: no output pays the destination"
        val paid = decoded.outputs[paidIndex]
        if (paid.valueSat != PROBE_SAT) return "b: test payment is not exactly $PROBE_SAT sat"
        if (!scriptMatches(paid.scriptHex, expectedScriptHex)) {
            return "c: output script does not match the destination's own script"
        }
        val change = decoded.outputs[1 - paidIndex]
        if (!change.isMine) return "c: change does not belong to this wallet"
        if (!change.isChange) return "c: change is not on a change descriptor"
        val plannedSet = planned.map { it.outpoint }.toSet()
        if (decoded.inputs.size != plannedSet.size || decoded.inputs.toSet() != plannedSet) {
            return "d: inputs are not the ones selected"
        }
        val inValue = planned.sumOf { it.amountSat }
        val fee = inValue - paid.valueSat - change.valueSat
        val ceiling = maxFeeSat(planned.size)
        if (fee <= 0) return "e: fee is not positive"
        if (fee > ceiling) return "e: fee $fee sat exceeds the $ceiling sat ceiling"
        if (decoded.txid != expectedTxid) return "g: txid does not match the decoded transaction"
        return null
    }

    /**
     * Case-insensitive, and an EMPTY expectation never matches. A blank
     * expected script means validateaddress did not give us one, and letting
     * that compare equal to a blank decode would turn the independent
     * second derivation into no check at all.
     */
    private fun scriptMatches(actual: String, expected: String): Boolean =
        expected.isNotBlank() && actual.isNotBlank() && actual.equals(expected, ignoreCase = true)

    // ------------------------------------------------------------- resolution

    /**
     * What the node said about a recorded transaction on this evaluation.
     *
     * The two "readable" flags are the whole point of the type. A failed
     * gettransaction is NOT "the transaction does not exist", and a failed
     * getmempoolentry is NOT "it is not in the mempool" -- conflating either
     * with a definite answer is exactly how a second payment gets built.
     */
    data class TxObservation(
        /** False when the wallet RPC failed or the wallet was not loaded. */
        val readable: Boolean,
        /** False when the wallet answered but does not know this txid. */
        val knownToWallet: Boolean = false,
        val confirmations: Int = 0,
        /** False when getmempoolentry could not be asked at all. */
        val mempoolReadable: Boolean = false,
        val inMempool: Boolean = false,
        /** getmempoolentry.unbroadcast: no peer has taken it yet. */
        val unbroadcast: Boolean = true,
    )

    enum class Resolution {
        /** Nothing could be established. Do nothing, build nothing. */
        UNRESOLVED,

        /** Re-send the STORED hex. Never a rebuild. */
        REBROADCAST,

        /** In the mempool, no peer has taken it yet. */
        MARK_BROADCAST,

        /** A peer requested and received it. The first honest "sent". */
        MARK_ACCEPTED,

        MARK_CONFIRMED,
        MARK_SETTLED,

        /** First sighting of a conflict. Recorded, not acted on. */
        NOTE_CONFLICT,

        /** Conflict seen twice, far enough apart. Now it may be acted on. */
        MARK_CONFLICTED,
    }

    /**
     * Whether a healthy observation should erase an earlier conflict sighting.
     *
     * The two-sightings rule ([CONFLICT_CONFIRM_MS]) only means anything if the
     * clock is reset when the transaction turns out to be fine. Without this, a
     * conflict noted once and then resolved by a reorg leaves `conflictSeenAtMs`
     * set forever -- and the NEXT transient negative reading, hours or days
     * later, satisfies `now - first >= CONFLICT_CONFIRM_MS` immediately and
     * marks the record conflicted off a SINGLE observation. That is exactly the
     * thing the delay exists to prevent, and reorgs are routine on this chain.
     *
     * Only a positive statement clears it: the wallet knows the transaction AND
     * reports it at zero or more confirmations. An unreadable observation still
     * resolves nothing, so it leaves the sighting standing.
     */
    fun clearsConflict(obs: TxObservation, record: SweepRecord): Boolean =
        record.conflictSeenAtMs != 0L &&
            obs.readable &&
            obs.knownToWallet &&
            obs.confirmations >= 0

    /**
     * Resolves a non-terminal record against one observation.
     *
     * Re-broadcasting is always safe and is the supported way to re-announce:
     * BroadcastTransaction skips resubmission entirely when the txid is already
     * in the mempool, and returns ALREADY_IN_UTXO_SET (RPC -27) before doing
     * anything if it already confirmed. There is no path by which re-sending a
     * stored hex produces a second payment.
     */
    fun resolve(obs: TxObservation, record: SweepRecord, nowMs: Long): Resolution {
        if (!obs.readable) return Resolution.UNRESOLVED

        if (obs.knownToWallet) {
            if (obs.confirmations >= SETTLED_CONFIRMATIONS) return Resolution.MARK_SETTLED
            if (obs.confirmations >= 1) return Resolution.MARK_CONFIRMED
            if (obs.confirmations < 0) {
                // Core's own definitive "this conflicts with a confirmed
                // transaction". Still not enough on its own.
                val first = record.conflictSeenAtMs
                return if (first != 0L && nowMs - first >= CONFLICT_CONFIRM_MS) {
                    Resolution.MARK_CONFLICTED
                } else {
                    Resolution.NOTE_CONFLICT
                }
            }
        }

        // confirmations == 0, or the wallet has never heard of it (the crash
        // window between persisting the record and the broadcast landing).
        if (!obs.mempoolReadable) return Resolution.UNRESOLVED
        if (!obs.inMempool) {
            // Either it was never broadcast, or the node restarted and lost its
            // mempool. Both are fixed by re-sending the stored hex.
            return Resolution.REBROADCAST
        }
        if (!obs.unbroadcast) return Resolution.MARK_ACCEPTED
        val since = if (record.broadcastAtMs != 0L) nowMs - record.broadcastAtMs else 0L
        return if (since >= REANNOUNCE_AFTER_MS) Resolution.REBROADCAST else Resolution.MARK_BROADCAST
    }

    // -------------------------------------------------------- address entry

    /** What `validateaddress` + `getaddressinfo` said about a typed address. */
    data class AddressFacts(
        val isValid: Boolean,
        val isWitness: Boolean = false,
        val witnessVersion: Int = 0,
        /** getaddressinfo.ismine on the PAYOUT wallet specifically. */
        val isMine: Boolean = false,
        val nodeError: String = "",
        /**
         * validateaddress.scriptPubKey -- the node's own encoding of this
         * address, kept so the decode check can compare the built output
         * against something derived independently of how the address renders.
         */
        val scriptPubKey: String = "",
    )

    enum class AddressVerdict(val message: String) {
        OK(""),
        EMPTY("Enter the address you want your coins forwarded to."),
        MALFORMED("That is not a valid PCoin address."),
        UNSPENDABLE_WITNESS(
            "That address uses a future address format that nothing on this network can spend yet. " +
                "Coins sent there would be lost."
        ),
        OWN_WALLET(
            "That is this phone's own wallet address. Forwarding there would only pay fees."
        ),
        CONFIRMATION_MISMATCH("The confirmation does not match the last 6 characters of the address."),
    }

    /**
     * Strips the things people actually paste: surrounding whitespace, and a
     * `pcoin:` URI prefix with any query string a wallet appended to it. Then
     * folds an all-uppercase bech32 address to lower case.
     */
    fun normalizeAddress(raw: String): String {
        var s = raw.trim()
        for (scheme in listOf("pcoin:", "PCOIN:")) {
            if (s.startsWith(scheme)) s = s.substring(scheme.length)
        }
        s = s.substringBefore('?')
        s = s.trim()
        return if (isUppercaseBech32(s)) s.lowercase() else s
    }

    /** The bech32 data charset, which deliberately excludes b, i, o and 1. */
    private const val BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"

    /**
     * An address written entirely in capitals that is bech32, not base58.
     *
     * BIP173 permits an all-uppercase bech32 string and this fork accepts one:
     * bech32::Decode lower-cases the HRP (src/bech32.cpp) and CHARSET_REV maps
     * upper and lower case to the same values, so `PC1Q...` passes
     * validateaddress. But the node re-encodes every address it reports in
     * lower case, so a stored uppercase destination would never compare equal
     * to the address in the decoded transaction: assertion (b) would abort
     * every build, forever, and forwarding would silently never work.
     *
     * Folding is restricted to strings that cannot be base58 -- base58 is
     * case-SENSITIVE, so lowercasing one would corrupt it. The data part of a
     * bech32 address lies inside [BECH32_CHARSET], which excludes B, I and O,
     * making a false positive on a real base58 address vanishingly unlikely;
     * and the node still validates the result before anything is stored.
     */
    private fun isUppercaseBech32(s: String): Boolean {
        val sep = s.lastIndexOf('1')
        if (sep < 1 || sep + 1 >= s.length) return false
        if (s.any { it.isLowerCase() }) return false
        if (!s.take(sep).all { it in 'A'..'Z' }) return false
        return s.drop(sep + 1).all { it.lowercaseChar() in BECH32_CHARSET }
    }

    /**
     * The full entry check.
     *
     * Wrong-chain addresses need no special case: PCoin's hrp is "pc" and its
     * base58 versions are 55/56, so a Bitcoin `bc1q...` or `1...` fails
     * validateaddress outright and lands on MALFORMED.
     *
     * @param confirmTail what the user retyped, to catch transcription and
     *   clipboard-hijack errors that a checksum cannot. Pass null to skip (the
     *   caller checks it separately when the field is still being typed).
     */
    fun checkAddress(
        normalized: String,
        facts: AddressFacts,
        confirmTail: String?,
    ): AddressVerdict {
        if (normalized.isEmpty()) return AddressVerdict.EMPTY
        if (normalized.any { it.isWhitespace() }) return AddressVerdict.MALFORMED
        if (!facts.isValid) return AddressVerdict.MALFORMED
        // Valid to encode, unspendable by anyone: paying one is a silent burn.
        if (facts.isWitness && facts.witnessVersion > 1) return AddressVerdict.UNSPENDABLE_WITNESS
        if (facts.isMine) return AddressVerdict.OWN_WALLET
        if (confirmTail != null && !confirmationMatches(normalized, confirmTail)) {
            return AddressVerdict.CONFIRMATION_MISMATCH
        }
        return AddressVerdict.OK
    }

    /** How many characters of the address the user must retype. */
    const val CONFIRM_TAIL_LENGTH = 6

    fun confirmationMatches(address: String, typed: String): Boolean {
        val tail = address.takeLast(CONFIRM_TAIL_LENGTH)
        val given = typed.trim()
        // Bech32 is case-insensitive as an encoding; a user reading six
        // characters off a screen should not be failed for capitalisation.
        return given.equals(tail, ignoreCase = true)
    }

    fun shortAddress(address: String): String =
        if (address.length <= 12) address else address.take(6) + "â€¦" + address.takeLast(6)

    // ---------------------------------------------------------------- estimate

    /**
     * How long until the next forward, from OBSERVED spacing.
     *
     * Never from nPowTargetSpacing: the target is 600 s and the measured value
     * is 815-868 s, so the target understates every estimate by ~40%. Difficulty
     * is currently pinned by a 357x retarget spike at height 2016 with no
     * further legacy retarget until 4032 and LWMA arriving at 2800, so observed
     * spacing is the only number with any claim to being real.
     *
     * @param bestImmatureConfirmations confirmations on the immature coinbase
     *   that is closest to maturity, or -1 when there is none.
     * @return milliseconds, or -1 when it cannot honestly be computed.
     */
    fun etaMs(bestImmatureConfirmations: Long, observedSpacingSec: Double): Long {
        if (bestImmatureConfirmations < 0 || observedSpacingSec <= 0.0) return -1L
        val remaining = COINBASE_SWEEP_DEPTH - bestImmatureConfirmations
        if (remaining <= 0) return 0L
        return (remaining * observedSpacingSec * 1000.0).toLong()
    }
}
