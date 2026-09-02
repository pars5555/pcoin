package org.pcoin.miner

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The decisions that spend money, run exhaustively on a plain JVM.
 *
 * These are shaped around the failure modes this chain actually produces --
 * ~868 s blocks, one peer, a coinbase that is immature for a day, a node that
 * loses its mempool on restart -- rather than around convenient inputs. The
 * cases that matter most are the ones asserting that something does NOT happen:
 * that an unreadable RPC never resolves anything, that a barely-mature coinbase
 * is not selected, and that a peer that will not relay is not a peer.
 */
class ForwardPolicyTest {

    private val destination = "pc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"
    private val destScript = "0014751e76e8199196d454941c45d1b3a323f1433bd6"

    // ------------------------------------------------------------ preconditions

    /** Everything clear, ARMED, two mature coinbases waiting. */
    private fun healthy(
        state: ForwardState = ForwardState.ARMED,
        sweepableSat: Long = 10_000_000_000L,
        candidateCount: Int = 2,
    ) = ForwardConditions(
        alive = true,
        forwardState = state,
        recordNonTerminal = false,
        nodeAnswered = true,
        initialBlockDownload = false,
        height = 2080,
        headers = 2080,
        tipTimeSec = 1_000_000L,
        nowMs = 1_000_000L * 1000L + 60_000L,
        relayPeers = 1,
        payoutWalletLoaded = true,
        destinationValid = true,
        sweepableSat = sweepableSat,
        candidateCount = candidateCount,
        probeCandidateSat = 5_000_000_000L,
    )

    @Test
    fun sweepsWhenEverythingIsClear() {
        val d = ForwardPolicy.decide(healthy())
        assertEquals(ForwardAction.SWEEP, d.action)
        assertTrue(d.clear)
    }

    @Test
    fun holdingIsTheDefaultAndSendsNothing() {
        val d = ForwardPolicy.decide(healthy(state = ForwardState.HOLDING))
        assertEquals(ForwardAction.NONE, d.action)
        assertEquals(ForwardBlock.HOLDING, d.block)
    }

    @Test
    fun anExistingRecordBlocksEverythingElse() {
        val d = ForwardPolicy.decide(healthy().copy(recordNonTerminal = true))
        assertEquals(ForwardBlock.PENDING_SWEEP, d.block)
    }

    @Test
    fun aRecordBlocksEvenBeforeTheNodeIsConsulted() {
        // Both are wrong; the record must win, so that a node that cannot
        // answer never causes a second transaction to be considered.
        val d = ForwardPolicy.decide(
            healthy().copy(recordNonTerminal = true, nodeAnswered = false)
        )
        assertEquals(ForwardBlock.PENDING_SWEEP, d.block)
    }

    @Test
    fun anUnansweredNodeIsNeverClearToSend() {
        val d = ForwardPolicy.decide(healthy().copy(nodeAnswered = false))
        assertEquals(ForwardBlock.NODE_NOT_READY, d.block)
    }

    @Test
    fun syncingBlocks() {
        assertEquals(
            ForwardBlock.SYNCING,
            ForwardPolicy.decide(healthy().copy(initialBlockDownload = true)).block,
        )
        assertEquals(
            ForwardBlock.SYNCING,
            ForwardPolicy.decide(healthy().copy(headers = 2090)).block,
        )
        // Within the tolerance the existing mining gate uses.
        assertEquals(
            ForwardAction.SWEEP,
            ForwardPolicy.decide(healthy().copy(headers = 2083)).action,
        )
    }

    @Test
    fun aTwentyMinuteBlockGapIsOrdinaryAndDoesNotBlock() {
        // P(gap > 20 min) = 25% at this chain's measured 868 s spacing. A check
        // that fired here would false-alarm a quarter of the time.
        val c = healthy().copy(nowMs = 1_000_000L * 1000L + 20 * 60_000L)
        assertEquals(ForwardAction.SWEEP, ForwardPolicy.decide(c).action)
    }

    @Test
    fun aThreeHourOldTipBlocks() {
        val c = healthy().copy(nowMs = 1_000_000L * 1000L + 3 * 60 * 60_000L + 1000L)
        assertEquals(ForwardBlock.TIP_STALE, ForwardPolicy.decide(c).block)
    }

    @Test
    fun aTipTimestampInTheFutureIsLegalAndClampsToZeroAge() {
        // Up to 900 s ahead of local time is consensus-legal.
        val c = healthy().copy(nowMs = 1_000_000L * 1000L - 800_000L)
        assertEquals(0L, ForwardPolicy.tipAgeMs(c.tipTimeSec, c.nowMs))
        assertEquals(ForwardAction.SWEEP, ForwardPolicy.decide(c).action)
    }

    @Test
    fun anUnknownTipTimeBlocks() {
        assertEquals(ForwardBlock.TIP_STALE, ForwardPolicy.decide(healthy().copy(tipTimeSec = 0L)).block)
    }

    @Test
    fun noRelayingPeerBlocks() {
        // The failure this exists for: sendrawtransaction succeeds against the
        // local mempool with zero peers, so "it returned a txid" is not proof
        // that anyone else has seen it.
        assertEquals(ForwardBlock.NO_RELAY_PEER, ForwardPolicy.decide(healthy().copy(relayPeers = 0)).block)
        // -1 is "could not ask", which is likewise not clear-to-send.
        assertEquals(ForwardBlock.NO_RELAY_PEER, ForwardPolicy.decide(healthy().copy(relayPeers = -1)).block)
    }

    @Test
    fun anUnloadedWalletBlocks() {
        assertEquals(
            ForwardBlock.WALLET_NOT_LOADED,
            ForwardPolicy.decide(healthy().copy(payoutWalletLoaded = false)).block,
        )
    }

    @Test
    fun anAddressThatNoLongerValidatesParksRatherThanSends() {
        assertEquals(
            ForwardBlock.ADDRESS_PARKED,
            ForwardPolicy.decide(healthy().copy(destinationValid = false)).block,
        )
    }

    @Test
    fun aShuttingDownServiceSendsNothing() {
        assertEquals(ForwardBlock.SHUTTING_DOWN, ForwardPolicy.decide(healthy().copy(alive = false)).block)
    }

    // -------------------------------------------------------------- threshold

    @Test
    fun belowTheMinimumSweepNothingIsBuilt() {
        val c = healthy(sweepableSat = ForwardPolicy.MIN_SWEEP_SAT - 1, candidateCount = 1)
        assertEquals(ForwardBlock.NOTHING_MATURE, ForwardPolicy.decide(c).block)
    }

    @Test
    fun exactlyTheMinimumSweepIsBuilt() {
        val c = healthy(sweepableSat = ForwardPolicy.MIN_SWEEP_SAT, candidateCount = 1)
        assertEquals(ForwardAction.SWEEP, ForwardPolicy.decide(c).action)
    }

    @Test
    fun noCandidatesMeansNothingMatureEvenWithABalance() {
        // sweepableValue is the vetted candidate set, never getbalances.trusted.
        val c = healthy(sweepableSat = 10_000_000_000L, candidateCount = 0)
        assertEquals(ForwardBlock.NOTHING_MATURE, ForwardPolicy.decide(c).block)
    }

    @Test
    fun theThousandTimesFeeArmNeverBindsAtTheCurrentFeeFloor() {
        // 1000 x 110 sat = 0.0011 PCN, far under the 1 PCN floor, so the floor
        // is what actually applies today. Stated as a test so that if this
        // chain ever grows a fee market the change is visible here first.
        assertEquals(ForwardPolicy.MIN_SWEEP_SAT, ForwardPolicy.minSweepSat(1))
        assertEquals(ForwardPolicy.MIN_SWEEP_SAT, ForwardPolicy.minSweepSat(200))
    }

    // ------------------------------------------------------------ maturity

    private fun utxo(
        txid: String,
        vout: Int = 0,
        sat: Long = 5_000_000_000L,
        confirmations: Long = 200,
        generated: Boolean = true,
        spendable: Boolean = true,
        safe: Boolean = true,
    ) = Utxo(txid, vout, sat, confirmations, spendable, safe, generated)

    @Test
    fun aCoinbaseIsNotSweptAtConsensusMaturity() {
        // Spendable at 101 by consensus. Building there means a ONE-block reorg
        // invalidates the signed transaction, so this app waits for 107.
        assertTrue(ForwardPolicy.vetCandidates(listOf(utxo("aa", confirmations = 101))).isEmpty())
        assertTrue(ForwardPolicy.vetCandidates(listOf(utxo("aa", confirmations = 106))).isEmpty())
        assertEquals(1, ForwardPolicy.vetCandidates(listOf(utxo("aa", confirmations = 107))).size)
    }

    @Test
    fun ordinaryOutputsAreNotHeldToTheCoinbaseDepth() {
        // Holding change to 107 would strand it for a day for no reason.
        val ordinary = utxo("bb", confirmations = 6, generated = false)
        assertEquals(1, ForwardPolicy.vetCandidates(listOf(ordinary)).size)
        assertTrue(
            ForwardPolicy.vetCandidates(listOf(ordinary.copy(confirmations = 5))).isEmpty()
        )
    }

    @Test
    fun unspendableAndUnsafeOutputsAreNeverSelected() {
        assertTrue(ForwardPolicy.vetCandidates(listOf(utxo("aa", spendable = false))).isEmpty())
        assertTrue(ForwardPolicy.vetCandidates(listOf(utxo("aa", safe = false))).isEmpty())
    }

    @Test
    fun selectionIsDeterministicAndCapped() {
        // Deterministic order is what makes two racing attempts CONFLICT rather
        // than both pay, so it is a safety property, not a cosmetic one.
        val shuffled = listOf(
            utxo("ff", vout = 1), utxo("aa", vout = 2), utxo("aa", vout = 0), utxo("cc"),
        )
        val vetted = ForwardPolicy.vetCandidates(shuffled)
        assertEquals(listOf("aa" to 0, "aa" to 2, "cc" to 0, "ff" to 1), vetted.map { it.txid to it.vout })

        val many = (0 until 300).map { utxo("%064x".format(it)) }
        assertEquals(ForwardPolicy.MAX_INPUTS_PER_SWEEP, ForwardPolicy.vetCandidates(many).size)
        // And the cap keeps the FIRST ones, so the next evaluation continues
        // from a known place rather than reshuffling.
        assertEquals("%064x".format(0), ForwardPolicy.vetCandidates(many).first().txid)
    }

    // ------------------------------------------------------------- scheduling

    @Test
    fun evaluationIsDrivenByNewBlocksNotByAClock() {
        val now = 10_000_000L
        // Same height, nothing to reconsider.
        assertFalse(ForwardPolicy.shouldEvaluate(2080, 2080, now, now - 120_000L))
        // New block.
        assertTrue(ForwardPolicy.shouldEvaluate(2081, 2080, now, now - 120_000L))
    }

    @Test
    fun aBurstOfBlocksDoesNotCauseABurstOfEvaluations() {
        val now = 10_000_000L
        assertFalse(ForwardPolicy.shouldEvaluate(2085, 2080, now, now - 5_000L))
    }

    @Test
    fun theBackstopFiresOnAChainThatHasGoneQuiet() {
        // A pending sweep still needs re-announcing when no block arrives.
        val now = 10_000_000L
        assertTrue(ForwardPolicy.shouldEvaluate(2080, 2080, now, now - 31 * 60_000L))
    }

    @Test
    fun theFirstEvaluationRunsAndAForcedOneAlwaysRuns() {
        assertTrue(ForwardPolicy.shouldEvaluate(2080, -1, 10_000_000L, 0L))
        // Forced, i.e. the user just changed the address: evaluate to reconcile
        // and re-validate. It cannot send early -- the preconditions still run.
        assertTrue(ForwardPolicy.shouldEvaluate(2080, 2080, 10_000_000L, 9_999_000L, force = true))
    }

    // -------------------------------------------------------------- assertions

    private fun decoded(
        txid: String = "tx",
        inputs: List<Outpoint> = listOf(Outpoint("aa", 0)),
        outputs: List<DecodedOut> = listOf(DecodedOut(destination, destScript, 4_999_999_890L)),
    ) = DecodedTx(txid, inputs, outputs)

    private val onePlanned = listOf(utxo("aa", vout = 0, sat = 5_000_000_000L))

    @Test
    fun aWellFormedSweepPasses() {
        assertNull(ForwardPolicy.verifySweep(decoded(), onePlanned, destination, destScript, "tx"))
    }

    @Test
    fun aSweepPayingSomeoneElseIsRefused() {
        val bad = decoded(outputs = listOf(DecodedOut("pc1qsomebodyelse", destScript, 4_999_999_890L)))
        assertNotNull(ForwardPolicy.verifySweep(bad, onePlanned, destination, destScript, "tx"))
    }

    @Test
    fun aSweepWhoseScriptDisagreesWithTheAddressIsRefused() {
        val bad = decoded(outputs = listOf(DecodedOut(destination, "0014deadbeef", 4_999_999_890L)))
        assertNotNull(ForwardPolicy.verifySweep(bad, onePlanned, destination, destScript, "tx"))
    }

    @Test
    fun aMissingScriptFromValidateaddressIsNotAPass() {
        // A blank expectation comparing equal to a blank decode would turn the
        // independent second derivation into no check at all.
        val blank = decoded(outputs = listOf(DecodedOut(destination, "", 4_999_999_890L)))
        assertNotNull(ForwardPolicy.verifySweep(blank, onePlanned, destination, "", "tx"))
    }

    @Test
    fun aSweepWithAnExtraOutputIsRefused() {
        val bad = decoded(
            outputs = listOf(
                DecodedOut(destination, destScript, 4_000_000_000L),
                DecodedOut("pc1qstranger", "0014aa", 999_999_890L),
            )
        )
        assertNotNull(ForwardPolicy.verifySweep(bad, onePlanned, destination, destScript, "tx"))
    }

    @Test
    fun aSweepSpendingAnInputWeDidNotSelectIsRefused() {
        val bad = decoded(inputs = listOf(Outpoint("aa", 0), Outpoint("zz", 3)))
        assertNotNull(ForwardPolicy.verifySweep(bad, onePlanned, destination, destScript, "tx"))
    }

    @Test
    fun aFeeUnitBlunderIsCaughtAtDecodeTime() {
        // sendall.fee_rate is sat/vB while sendrawtransaction.maxfeerate is
        // PCN/kvB, on adjacent calls. This assertion is the backstop.
        val ceiling = ForwardPolicy.maxFeeSat(1)
        val justOver = DecodedOut(destination, destScript, 5_000_000_000L - ceiling - 1)
        assertNotNull(
            ForwardPolicy.verifySweep(decoded(outputs = listOf(justOver)), onePlanned, destination, destScript, "tx")
        )
        val justUnder = DecodedOut(destination, destScript, 5_000_000_000L - ceiling)
        assertNull(
            ForwardPolicy.verifySweep(decoded(outputs = listOf(justUnder)), onePlanned, destination, destScript, "tx")
        )
    }

    @Test
    fun aZeroOrNegativeFeeIsRefused() {
        val noFee = DecodedOut(destination, destScript, 5_000_000_000L)
        assertNotNull(
            ForwardPolicy.verifySweep(decoded(outputs = listOf(noFee)), onePlanned, destination, destScript, "tx")
        )
    }

    @Test
    fun aTxidMismatchIsRefused() {
        assertNotNull(
            ForwardPolicy.verifySweep(decoded(txid = "other"), onePlanned, destination, destScript, "tx")
        )
    }

    @Test
    fun aProbeMustPayExactlyOneCoinAndReturnChangeToUs() {
        val good = DecodedTx(
            "tx",
            listOf(Outpoint("aa", 0)),
            listOf(
                DecodedOut(destination, destScript, ForwardPolicy.PROBE_SAT),
                DecodedOut("pc1qourchange", "0014bb", 4_899_999_890L, isMine = true, isChange = true),
            ),
        )
        assertNull(ForwardPolicy.verifyProbe(good, onePlanned, destination, destScript, "tx"))

        // The assertion that matters: change to a stranger, with a perfect
        // looking 1 PCN test payment beside it.
        val stolenChange = good.copy(
            outputs = listOf(
                good.outputs[0],
                good.outputs[1].copy(isMine = false, isChange = false),
            )
        )
        assertNotNull(ForwardPolicy.verifyProbe(stolenChange, onePlanned, destination, destScript, "tx"))

        val wrongAmount = good.copy(
            outputs = listOf(
                good.outputs[0].copy(valueSat = ForwardPolicy.PROBE_SAT * 10),
                good.outputs[1],
            )
        )
        assertNotNull(ForwardPolicy.verifyProbe(wrongAmount, onePlanned, destination, destScript, "tx"))
    }

    // -------------------------------------------------------------- resolution

    private fun record(
        state: SweepState = SweepState.BROADCAST,
        broadcastAtMs: Long = 1_000_000L,
        conflictSeenAtMs: Long = 0L,
    ) = SweepRecord(
        txid = "tx", hex = "00", inputs = listOf(Outpoint("aa", 0)),
        amountSat = 5_000_000_000L, feeSat = 110, address = destination,
        state = state, kind = SweepKind.SWEEP, createdAtMs = 1_000_000L,
        broadcastAtMs = broadcastAtMs, conflictSeenAtMs = conflictSeenAtMs,
    )

    @Test
    fun anUnreadableWalletResolvesNothing() {
        // The doctrine, as a test. A failed read is not "no transaction".
        val obs = ForwardPolicy.TxObservation(readable = false)
        assertEquals(ForwardPolicy.Resolution.UNRESOLVED, ForwardPolicy.resolve(obs, record(), 2_000_000L))
    }

    @Test
    fun anUnreadableMempoolResolvesNothing() {
        // The wallet answered "confirmations 0" but getmempoolentry threw. That
        // is not permission to re-broadcast blindly, nor to conclude anything.
        val obs = ForwardPolicy.TxObservation(
            readable = true, knownToWallet = true, confirmations = 0, mempoolReadable = false,
        )
        assertEquals(ForwardPolicy.Resolution.UNRESOLVED, ForwardPolicy.resolve(obs, record(), 2_000_000L))
    }

    @Test
    fun inTheMempoolButUntakenIsBroadcastNotSent() {
        val obs = ForwardPolicy.TxObservation(
            readable = true, knownToWallet = true, confirmations = 0,
            mempoolReadable = true, inMempool = true, unbroadcast = true,
        )
        assertEquals(
            ForwardPolicy.Resolution.MARK_BROADCAST,
            ForwardPolicy.resolve(obs, record(), 1_000_000L + 60_000L),
        )
    }

    @Test
    fun aPeerTakingItIsTheFirstHonestSuccess() {
        val obs = ForwardPolicy.TxObservation(
            readable = true, knownToWallet = true, confirmations = 0,
            mempoolReadable = true, inMempool = true, unbroadcast = false,
        )
        assertEquals(
            ForwardPolicy.Resolution.MARK_ACCEPTED,
            ForwardPolicy.resolve(obs, record(), 1_000_000L + 60_000L),
        )
    }

    @Test
    fun aTransactionNobodyTookForHalfAnHourIsReannounced() {
        val obs = ForwardPolicy.TxObservation(
            readable = true, knownToWallet = true, confirmations = 0,
            mempoolReadable = true, inMempool = true, unbroadcast = true,
        )
        assertEquals(
            ForwardPolicy.Resolution.REBROADCAST,
            ForwardPolicy.resolve(obs, record(), 1_000_000L + 31 * 60_000L),
        )
    }

    @Test
    fun anUnstampedBroadcastTimeNeverAgesIntoAReannounce() {
        // A record broadcast in the crash window carries broadcastAtMs = 0, so
        // `since` is 0 however long it actually sat there and this can only ever
        // return MARK_BROADCAST. That is why the ENGINE stamps the field the
        // first time it observes such a record: the clock has to start
        // somewhere, and policy cannot invent a broadcast time it was not given.
        val obs = ForwardPolicy.TxObservation(
            readable = true, knownToWallet = false, confirmations = 0,
            mempoolReadable = true, inMempool = true, unbroadcast = true,
        )
        assertEquals(
            ForwardPolicy.Resolution.MARK_BROADCAST,
            ForwardPolicy.resolve(obs, record(broadcastAtMs = 0L), 10L * 365 * 24 * 3_600_000L),
        )
    }

    @Test
    fun aLostMempoolCausesAReBroadcastOfTheStoredHexNotARebuild() {
        // Node restarted, mempool gone. There is exactly one recovery action.
        val obs = ForwardPolicy.TxObservation(
            readable = true, knownToWallet = true, confirmations = 0,
            mempoolReadable = true, inMempool = false,
        )
        assertEquals(ForwardPolicy.Resolution.REBROADCAST, ForwardPolicy.resolve(obs, record(), 2_000_000L))
    }

    @Test
    fun theCrashWindowBetweenPersistAndBroadcastIsRecoverable() {
        // Record on disk, wallet has never heard of the txid, mempool says no.
        val obs = ForwardPolicy.TxObservation(
            readable = true, knownToWallet = false, mempoolReadable = true, inMempool = false,
        )
        assertEquals(
            ForwardPolicy.Resolution.REBROADCAST,
            ForwardPolicy.resolve(obs, record(state = SweepState.BROADCASTING), 2_000_000L),
        )
    }

    @Test
    fun confirmationsAdvanceThenSettle() {
        fun at(c: Int) = ForwardPolicy.resolve(
            ForwardPolicy.TxObservation(readable = true, knownToWallet = true, confirmations = c),
            record(), 2_000_000L,
        )
        assertEquals(ForwardPolicy.Resolution.MARK_CONFIRMED, at(1))
        assertEquals(ForwardPolicy.Resolution.MARK_CONFIRMED, at(5))
        assertEquals(ForwardPolicy.Resolution.MARK_SETTLED, at(6))
    }

    @Test
    fun oneConflictSightingIsNeverActedOn() {
        // Acting on a single reading here is the one place where being wrong
        // builds a SECOND transaction.
        val obs = ForwardPolicy.TxObservation(readable = true, knownToWallet = true, confirmations = -1)
        assertEquals(
            ForwardPolicy.Resolution.NOTE_CONFLICT,
            ForwardPolicy.resolve(obs, record(), 2_000_000L),
        )
        // Seen once, but not long enough ago.
        assertEquals(
            ForwardPolicy.Resolution.NOTE_CONFLICT,
            ForwardPolicy.resolve(obs, record(conflictSeenAtMs = 2_000_000L), 2_000_000L + 60_000L),
        )
        // Twice, ten minutes apart.
        assertEquals(
            ForwardPolicy.Resolution.MARK_CONFLICTED,
            ForwardPolicy.resolve(obs, record(conflictSeenAtMs = 2_000_000L), 2_000_000L + 11 * 60_000L),
        )
    }

    @Test
    fun terminalStatesAreTheOnlyOnesThatMayClearARecord() {
        assertTrue(SweepState.SETTLED.terminal)
        assertTrue(SweepState.FAILED_CONFLICTED.terminal)
        assertFalse(SweepState.BROADCASTING.terminal)
        assertFalse(SweepState.BROADCAST.terminal)
        assertFalse(SweepState.ACCEPTED.terminal)
        assertFalse(SweepState.CONFIRMED.terminal)
    }

    // ----------------------------------------------------------- address entry

    @Test
    fun aValidAddressWithAMatchingTailIsAccepted() {
        val facts = ForwardPolicy.AddressFacts(isValid = true, isWitness = true, witnessVersion = 0)
        assertEquals(
            ForwardPolicy.AddressVerdict.OK,
            ForwardPolicy.checkAddress(destination, facts, destination.takeLast(6)),
        )
    }

    @Test
    fun aBitcoinAddressIsRejectedByTheNodeAndReadsAsMalformed() {
        // hrp "pc" and base58 55/56 mean a bc1.../1... never validates here.
        val facts = ForwardPolicy.AddressFacts(isValid = false, nodeError = "Invalid HRP")
        assertEquals(
            ForwardPolicy.AddressVerdict.MALFORMED,
            ForwardPolicy.checkAddress("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", facts, null),
        )
    }

    @Test
    fun aFutureWitnessVersionIsRefusedBecauseNothingCanSpendIt() {
        val facts = ForwardPolicy.AddressFacts(isValid = true, isWitness = true, witnessVersion = 2)
        assertEquals(
            ForwardPolicy.AddressVerdict.UNSPENDABLE_WITNESS,
            ForwardPolicy.checkAddress(destination, facts, null),
        )
        // v1 (taproot) is spendable on PCoin from height 1 and is allowed.
        assertEquals(
            ForwardPolicy.AddressVerdict.OK,
            ForwardPolicy.checkAddress(
                destination,
                ForwardPolicy.AddressFacts(isValid = true, isWitness = true, witnessVersion = 1),
                null,
            ),
        )
    }

    @Test
    fun forwardingToOurOwnWalletIsRefused() {
        val facts = ForwardPolicy.AddressFacts(isValid = true, isMine = true)
        assertEquals(
            ForwardPolicy.AddressVerdict.OWN_WALLET,
            ForwardPolicy.checkAddress(destination, facts, null),
        )
    }

    @Test
    fun aMistypedConfirmationIsRefused() {
        val facts = ForwardPolicy.AddressFacts(isValid = true)
        assertEquals(
            ForwardPolicy.AddressVerdict.CONFIRMATION_MISMATCH,
            ForwardPolicy.checkAddress(destination, facts, "zzzzzz"),
        )
        // Reading six characters off a screen must not fail on capitalisation.
        assertTrue(ForwardPolicy.confirmationMatches(destination, destination.takeLast(6).uppercase()))
    }

    @Test
    fun whatPeopleActuallyPasteIsNormalised() {
        assertEquals(destination, ForwardPolicy.normalizeAddress("  $destination \n"))
        assertEquals(destination, ForwardPolicy.normalizeAddress("pcoin:$destination"))
        assertEquals(destination, ForwardPolicy.normalizeAddress("pcoin:$destination?amount=1.0"))
    }

    @Test
    fun anUppercaseBech32AddressIsFoldedRatherThanLeftToDeadEnd() {
        // BIP173 allows it and this fork accepts it -- bech32::Decode lowercases
        // the HRP and CHARSET_REV maps both cases -- so it passes
        // validateaddress. But the node reports every address in lower case, so
        // an uppercase destination would fail the output comparison on every
        // build, forever. It has to be folded before it is ever stored.
        assertEquals(destination, ForwardPolicy.normalizeAddress(destination.uppercase()))
        assertEquals(destination, ForwardPolicy.normalizeAddress(" PCOIN:${destination.uppercase()} "))
    }

    @Test
    fun aBase58AddressIsNeverFoldedBecauseBase58IsCaseSensitive() {
        // Lowercasing one of these would silently corrupt it. B, I and O are
        // outside the bech32 charset, which is what keeps them apart.
        val base58 = "PBmSY1FVbTzHUAmoDBTyJmyQ1Bo9NKuiwo"
        assertEquals(base58, ForwardPolicy.normalizeAddress(base58))
        // All-caps, digits included, still base58: the 'B' and 'O' disqualify it.
        val shouty = "P1BOZZZZZZ"
        assertEquals(shouty, ForwardPolicy.normalizeAddress(shouty))
    }

    @Test
    fun anEmptyAddressIsAnOrdinaryStateNotAnError() {
        assertEquals(
            ForwardPolicy.AddressVerdict.EMPTY,
            ForwardPolicy.checkAddress("", ForwardPolicy.AddressFacts(isValid = false), null),
        )
    }

    @Test
    fun anAddressWithEmbeddedWhitespaceIsRejected() {
        val facts = ForwardPolicy.AddressFacts(isValid = true)
        assertEquals(
            ForwardPolicy.AddressVerdict.MALFORMED,
            ForwardPolicy.checkAddress("pc1qw508 d6qejxtdg", facts, null),
        )
    }

    // ---------------------------------------------------------------- probe

    @Test
    fun theProbeIsSentOnceMatureCoinsExist() {
        val c = healthy(state = ForwardState.PROBING_PENDING, candidateCount = 1)
        assertEquals(ForwardAction.PROBE, ForwardPolicy.decide(c).action)
    }

    @Test
    fun aProbeIsNotBuiltFromACandidateTooSmallToCoverIt() {
        val c = healthy(state = ForwardState.PROBING_PENDING, candidateCount = 1)
            .copy(probeCandidateSat = ForwardPolicy.PROBE_SAT)
        assertEquals(ForwardBlock.NOTHING_MATURE, ForwardPolicy.decide(c).block)
    }

    @Test
    fun nothingIsSweptUntilTheProbeIsAcknowledged() {
        // The whole safety property: an unacknowledged probe means the app has
        // no evidence anyone holds the key at the far end.
        val c = healthy(state = ForwardState.PROBING_SENT)
        assertEquals(ForwardAction.NONE, ForwardPolicy.decide(c).action)
        assertEquals(ForwardBlock.PROBE_AWAITING_ACK, ForwardPolicy.decide(c).block)
    }

    // ---------------------------------------------------------------- estimate

    @Test
    fun theEstimateUsesObservedSpacingNotTheSixHundredSecondTarget() {
        // 100 blocks to go at the measured 868 s, not the 600 s target: the
        // target would understate this by about 40%.
        val ms = ForwardPolicy.etaMs(bestImmatureConfirmations = 7, observedSpacingSec = 868.0)
        assertEquals(100 * 868 * 1000L, ms)
        assertEquals(0L, ForwardPolicy.etaMs(107, 868.0))
        // No honest answer available.
        assertEquals(-1L, ForwardPolicy.etaMs(-1, 868.0))
        assertEquals(-1L, ForwardPolicy.etaMs(7, 0.0))
    }

    @Test
    fun feeArithmeticMatchesTheSizeFormula() {
        // vsize = 41.5 + 68n for a P2WPKH sweep to one output.
        assertEquals(110L, ForwardPolicy.estimatedFeeSat(1))
        assertEquals(722L, ForwardPolicy.estimatedFeeSat(10))
        assertEquals(13_642L, ForwardPolicy.estimatedFeeSat(200))
        assertEquals(1_095L, ForwardPolicy.maxFeeSat(1))
        assertEquals(136_415L, ForwardPolicy.maxFeeSat(200))
    }

    // -------------------------------------------------------------- fee tiers

    @Test
    fun tierRatesAreTheShippedConstants() {
        // The rates the send screen advertises. If one moves, the
        // send_fee_hint string and these assertions move with it.
        assertEquals(1.0, ForwardPolicy.FeeTier.NORMAL.rateSatVb, 0.0)
        assertEquals(5.0, ForwardPolicy.FeeTier.FAST.rateSatVb, 0.0)
        assertEquals(20.0, ForwardPolicy.FeeTier.VERY_FAST.rateSatVb, 0.0)
    }

    @Test
    fun everyTierBroadcastCapIsHeadroomTimesRateInPcnPerKvb() {
        // 1 sat/vB = 1e-5 PCN/kvB. The broadcast cap and the decoded-fee
        // ceiling are BOTH rate x 10, so raising a tier raises them in
        // lockstep by construction.
        for (t in ForwardPolicy.FeeTier.values()) {
            assertEquals(t.rateSatVb * 10.0 / 100_000.0, t.broadcastMaxFeeRatePcnKvb, 0.0)
        }
        assertEquals(0.0001, ForwardPolicy.FeeTier.NORMAL.broadcastMaxFeeRatePcnKvb, 0.0)
        assertEquals(0.0005, ForwardPolicy.FeeTier.FAST.broadcastMaxFeeRatePcnKvb, 0.0)
        assertEquals(0.002, ForwardPolicy.FeeTier.VERY_FAST.broadcastMaxFeeRatePcnKvb, 0.0)
    }

    @Test
    fun theFloorTierBroadcastCapEqualsTheSweepCap() {
        // The automatic sweep path still uses the global constant; NORMAL
        // must be exactly that, or "default tier changes nothing" is false.
        assertEquals(
            ForwardPolicy.BROADCAST_MAX_FEE_RATE,
            ForwardPolicy.FeeTier.NORMAL.broadcastMaxFeeRatePcnKvb,
            0.0,
        )
    }

    @Test
    fun perTierCeilingsKeepTheSameHeadroom() {
        // 1-in/2-out modelled vsize is 140.5 vB; ceiling = rate x 10 x that.
        assertEquals(1_405L, ForwardPolicy.maxFeeSatFor(1, 2))
        assertEquals(7_025L, ForwardPolicy.maxFeeSatFor(1, 2, 5.0))
        assertEquals(28_100L, ForwardPolicy.maxFeeSatFor(1, 2, 20.0))
        // No rate argument means the floor: the pre-tier ceiling, unchanged.
        assertEquals(
            ForwardPolicy.maxFeeSatFor(1, 2),
            ForwardPolicy.maxFeeSatFor(1, 2, ForwardPolicy.FEE_RATE_SAT_VB),
        )
    }

    @Test
    fun aFeeUnitBlunderIsCaughtAtEveryTier() {
        // The blunder the ceilings exist for: a sat/vB figure sent where
        // PCN/kvB belongs is ~1e5 off. Whatever the tier, its ceiling must
        // sit far below that -- i.e. headroom must stay orders of magnitude
        // under the unit-confusion factor.
        for (t in ForwardPolicy.FeeTier.values()) {
            val blunderFeeSat = (t.rateSatVb * 100_000.0 * 140.5).toLong()
            val ceiling = ForwardPolicy.maxFeeSatFor(1, 2, t.rateSatVb)
            assertTrue(
                "tier $t ceiling $ceiling would let a unit blunder ($blunderFeeSat sat) through",
                blunderFeeSat > ceiling,
            )
        }
    }
}
