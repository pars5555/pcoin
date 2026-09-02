package org.pcoin.miner

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * [ForwardPolicy.verifyUserSend] -- the last check between a person pressing
 * Send now and their coins leaving.
 *
 * The two "good" cases are not invented. They are the transactions a real PCoin
 * regtest node built when asked exactly the way [ForwardEngine.prepareSend] asks
 * it, transcribed field for field: the 1-in/2-out exact send and the 5-in/1-out
 * sendall. Made-up fixtures would only prove the checker agrees with my idea of
 * a transaction; these prove it agrees with the node's.
 *
 * Everything else here is that same transaction with exactly one thing wrong,
 * because a checker that passes valid input is worth nothing on its own -- what
 * matters is that each individual assertion is actually load-bearing.
 */
class UserSendTest {

    // ---- observed on regtest, `send` with add_to_wallet=false, fee_rate 1 ----
    // txid 59aaa047d6e35d0a89e7909f37c262faf976ec0bbfbd2a7cf416460f219a8748
    // in   48fa2bafd8949307fcc15d3e113fb617e9ff7d85295861f088adddb35d4a57fd:0
    //      value 50.00000000 (coinbase)
    // out0 48.49999859 change  pcrt1q64eg28xmta7jansumf4v6v0w3wgnxqr55nne64
    // out1  1.50000000 paid    pcrt1qj6f8wmkzsrnx4nh39xyz3ty3gqkrfnredu09tc
    // fee 141 sat, vsize 141
    private val txid = "59aaa047d6e35d0a89e7909f37c262faf976ec0bbfbd2a7cf416460f219a8748"
    private val dest = "pcrt1qj6f8wmkzsrnx4nh39xyz3ty3gqkrfnredu09tc"
    private val destScript = "00149692776ec280e66acef1298828ac91402c34cc79"
    private val changeAddr = "pcrt1q64eg28xmta7jansumf4v6v0w3wgnxqr55nne64"
    private val changeScript = "0014d572851cdb5f7d2ece1cda6acd31ee8b91330074"
    private val inValue = 5_000_000_000L
    private val paidSat = 150_000_000L
    private val changeSat = 4_849_999_859L

    private fun exactSend(
        outputs: List<DecodedOut> = listOf(
            DecodedOut(changeAddr, changeScript, changeSat, isMine = true, isChange = true),
            DecodedOut(dest, destScript, paidSat),
        ),
        inputs: List<Outpoint> = listOf(
            Outpoint("48fa2bafd8949307fcc15d3e113fb617e9ff7d85295861f088adddb35d4a57fd", 0)
        ),
        id: String = txid,
    ) = DecodedTx(id, inputs, outputs)

    private fun verify(
        tx: DecodedTx,
        requested: Long = paidSat,
        sendMax: Boolean = false,
        inValueSat: Long = inValue,
        expectedTxid: String = txid,
        destination: String = dest,
        script: String = destScript,
        rateSatVb: Double = ForwardPolicy.FEE_RATE_SAT_VB,
    ) = ForwardPolicy.verifyUserSend(
        decoded = tx,
        destination = destination,
        expectedScriptHex = script,
        expectedTxid = expectedTxid,
        requestedSat = requested,
        sendMax = sendMax,
        inputValueSat = inValueSat,
        rateSatVb = rateSatVb,
    )

    // ------------------------------------------------------------ the real ones

    @Test
    fun `the transaction the node actually built passes`() {
        assertNull(verify(exactSend()))
    }

    @Test
    fun `the sendall the node actually built passes`() {
        // 5 inputs, 1 output, 249.99999619 out of 250.00000000 in, fee 381 sat.
        // The address and the amounts are the node's; the script hex is a
        // placeholder, since only the script/address AGREEMENT is under test
        // here and the probe did not print it.
        val sweepDest = "pcrt1qc0vvelsr2ayhm3s6pszx2kgfc0fkzh0hc4wrjg"
        val sweepScript = "0014c3d8ccfe0357497dc61a0c04655909c3d3615df7"
        val tx = DecodedTx(
            "sweep",
            (0 until 5).map { Outpoint("aa".repeat(32), it) },
            listOf(DecodedOut(sweepDest, sweepScript, 24_999_999_619L)),
        )
        assertNull(
            ForwardPolicy.verifyUserSend(
                decoded = tx,
                destination = sweepDest,
                expectedScriptHex = sweepScript,
                expectedTxid = "sweep",
                requestedSat = 0L,          // ignored when sendMax
                sendMax = true,
                inputValueSat = 25_000_000_000L,
            )
        )
    }

    @Test
    fun `the real fee sits well under the ceiling`() {
        // 141 sat actual against the 1-in 2-out ceiling. If a refactor ever makes
        // this tight, the send path starts refusing perfectly good transactions.
        val ceiling = ForwardPolicy.maxFeeSatFor(1, 2)
        assertTrue("ceiling $ceiling should exceed the observed 141 sat", ceiling > 141L)
        assertTrue("ceiling $ceiling is too loose to be a check", ceiling < 10_000L)
        // And the 5-in sendall: 381 sat actual.
        assertTrue(ForwardPolicy.maxFeeSatFor(5, 1) > 381L)
    }

    // -------------------------------------------------- one thing wrong, each

    @Test
    fun `a txid that does not match the decoded bytes is refused`() {
        assertNotNull(verify(exactSend(id = "ff".repeat(32))))
    }

    @Test
    fun `a transaction that pays someone else is refused`() {
        val tx = exactSend(
            outputs = listOf(
                DecodedOut(changeAddr, changeScript, changeSat, isMine = true, isChange = true),
                DecodedOut("pcrt1qstranger", "0014deadbeef", paidSat),
            )
        )
        assertNotNull(verify(tx))
    }

    @Test
    fun `the right address with the wrong script is refused`() {
        // The address label and the script must agree. If they can disagree, the
        // address on the review screen is decoration.
        val tx = exactSend(
            outputs = listOf(
                DecodedOut(changeAddr, changeScript, changeSat, isMine = true, isChange = true),
                DecodedOut(dest, "0014" + "00".repeat(20), paidSat),
            )
        )
        assertNotNull(verify(tx))
    }

    @Test
    fun `paying a different amount than asked is refused`() {
        val tx = exactSend(
            outputs = listOf(
                DecodedOut(changeAddr, changeScript, changeSat, isMine = true, isChange = true),
                DecodedOut(dest, destScript, paidSat - 1),
            )
        )
        val why = verify(tx)
        assertNotNull(why)
        assertTrue(why!!.contains("not the"))
    }

    @Test
    fun `change to an address we do not own is refused`() {
        // The whole point. A transaction can pay the destination perfectly and
        // still hand the remaining 48.5 PCN to a stranger.
        val tx = exactSend(
            outputs = listOf(
                DecodedOut(changeAddr, changeScript, changeSat, isMine = false, isChange = false),
                DecodedOut(dest, destScript, paidSat),
            )
        )
        assertNotNull(verify(tx))
    }

    @Test
    fun `change to an address we own but is not a change address is refused`() {
        val tx = exactSend(
            outputs = listOf(
                DecodedOut(changeAddr, changeScript, changeSat, isMine = true, isChange = false),
                DecodedOut(dest, destScript, paidSat),
            )
        )
        assertNotNull(verify(tx))
    }

    @Test
    fun `an extra output is refused`() {
        val tx = exactSend(
            outputs = listOf(
                DecodedOut(changeAddr, changeScript, changeSat - 1000, isMine = true, isChange = true),
                DecodedOut(dest, destScript, paidSat),
                DecodedOut("pcrt1qextra", "0014ababab", 1000),
            )
        )
        assertNotNull(verify(tx))
    }

    @Test
    fun `a sendMax with change is refused`() {
        // sendall must produce exactly one output. Two means something built a
        // change output on a transaction the user asked to empty.
        val tx = exactSend()
        assertNotNull(verify(tx, sendMax = true))
    }

    @Test
    fun `a transaction spending nothing is refused`() {
        assertNotNull(verify(exactSend(inputs = emptyList())))
    }

    @Test
    fun `a negative fee is refused`() {
        // Outputs exceeding inputs cannot happen on a well-formed transaction,
        // which is exactly why it must be checked: reaching it means one of the
        // gettxout reads was wrong.
        assertNotNull(verify(exactSend(), inValueSat = paidSat + changeSat - 1))
    }

    @Test
    fun `a zero fee is refused`() {
        assertNotNull(verify(exactSend(), inValueSat = paidSat + changeSat))
    }

    @Test
    fun `a fee above the ceiling is refused`() {
        // Same outputs, far more input value: every extra satoshi is fee.
        val why = verify(exactSend(), inValueSat = inValue + 1_000_000L)
        assertNotNull(why)
        assertTrue(why!!.contains("ceiling"))
    }

    @Test
    fun `a fee above the FAST ceiling is refused at FAST but passes at VERY FAST`() {
        // The ceiling must move with the tier in BOTH directions: 10,000 sat
        // is over FAST's 7,025 sat ceiling and under VERY_FAST's 28,100.
        val inWithBigFee = paidSat + changeSat + 10_000L
        val why = verify(
            exactSend(),
            inValueSat = inWithBigFee,
            rateSatVb = ForwardPolicy.FeeTier.FAST.rateSatVb,
        )
        assertNotNull(why)
        assertTrue(why!!.contains("ceiling"))
        assertNull(
            verify(
                exactSend(),
                inValueSat = inWithBigFee,
                rateSatVb = ForwardPolicy.FeeTier.VERY_FAST.rateSatVb,
            )
        )
    }

    @Test
    fun `the normal tier is judged by exactly the old ceiling`() {
        // The default-parameter refactor must not have moved the floor bound:
        // a fee AT the old ceiling passes, one satoshi over refuses.
        val ceiling = ForwardPolicy.maxFeeSatFor(1, 2)
        assertNull(verify(exactSend(), inValueSat = paidSat + changeSat + ceiling))
        assertNotNull(verify(exactSend(), inValueSat = paidSat + changeSat + ceiling + 1))
    }

    @Test
    fun `tier ceilings stay proportionally tight`() {
        // The same tight/loose bounds the floor test pins, scaled per tier --
        // so no tier's ceiling quietly stops being a check.
        for (t in ForwardPolicy.FeeTier.values()) {
            val ceiling = ForwardPolicy.maxFeeSatFor(1, 2, t.rateSatVb)
            assertTrue("tier $t ceiling $ceiling too tight", ceiling > (141L * t.rateSatVb).toLong())
            assertTrue("tier $t ceiling $ceiling too loose", ceiling < (10_000L * t.rateSatVb).toLong())
        }
    }

    @Test
    fun `sub-dust change folded into the fee still passes`() {
        // Core drops a change output below the dust threshold and lets the
        // amount become fee. One output on a non-max send is legitimate.
        val tx = exactSend(outputs = listOf(DecodedOut(dest, destScript, paidSat)))
        assertNull(verify(tx, inValueSat = paidSat + 200))
    }

    // --------------------------------------------- the conflict-sighting clock

    private fun conflicted(seenAtMs: Long) = SweepRecord(
        txid = txid,
        hex = "00",
        inputs = listOf(Outpoint("aa".repeat(32), 0)),
        amountSat = paidSat,
        feeSat = 141L,
        address = dest,
        state = SweepState.BROADCAST,
        kind = SweepKind.SWEEP,
        createdAtMs = 1_000L,
        conflictSeenAtMs = seenAtMs,
    )

    private fun obs(
        readable: Boolean = true,
        known: Boolean = true,
        confirmations: Int = 1,
    ) = ForwardPolicy.TxObservation(
        readable = readable,
        knownToWallet = known,
        confirmations = confirmations,
    )

    @Test
    fun `a healthy confirmed reading clears an earlier conflict sighting`() {
        // Without this the two-sightings rule is decorative: a conflict noted
        // once and then undone by a reorg would leave the clock running, and the
        // next single transient negative reading would mark the record
        // conflicted immediately.
        assertTrue(ForwardPolicy.clearsConflict(obs(confirmations = 3), conflicted(1_000L)))
    }

    @Test
    fun `a healthy zero-confirmation reading also clears it`() {
        // Back in the mempool and no longer conflicting is still a positive
        // statement that the transaction is alive.
        assertTrue(ForwardPolicy.clearsConflict(obs(confirmations = 0), conflicted(1_000L)))
    }

    @Test
    fun `an unreadable observation does NOT clear it`() {
        // The doctrine: a failed read resolves nothing, in either direction.
        assertFalse(ForwardPolicy.clearsConflict(obs(readable = false), conflicted(1_000L)))
    }

    @Test
    fun `a wallet that does not know the transaction does NOT clear it`() {
        assertFalse(ForwardPolicy.clearsConflict(obs(known = false), conflicted(1_000L)))
    }

    @Test
    fun `a still-negative reading does NOT clear it`() {
        assertFalse(ForwardPolicy.clearsConflict(obs(confirmations = -1), conflicted(1_000L)))
    }

    @Test
    fun `there is nothing to clear when no conflict was ever seen`() {
        assertFalse(ForwardPolicy.clearsConflict(obs(confirmations = 1), conflicted(0L)))
    }

    @Test
    fun `a stale sighting would otherwise trip on a single reading`() {
        // The bug this guards, stated as a test: an hours-old sighting plus one
        // fresh negative reading is enough for MARK_CONFLICTED.
        val stale = conflicted(1_000L)
        val muchLater = 1_000L + ForwardPolicy.CONFLICT_CONFIRM_MS + 1
        assertEquals(
            ForwardPolicy.Resolution.MARK_CONFLICTED,
            ForwardPolicy.resolve(obs(confirmations = -1), stale, muchLater),
        )
        // ...and that after clearing, the same reading only notes it.
        assertEquals(
            ForwardPolicy.Resolution.NOTE_CONFLICT,
            ForwardPolicy.resolve(obs(confirmations = -1), stale.copy(conflictSeenAtMs = 0L), muchLater),
        )
    }

    @Test
    fun `the ceiling grows with inputs`() {
        // A sweep of many coinbases is a big transaction and a bigger fee; a
        // fixed ceiling would refuse it.
        assertTrue(ForwardPolicy.maxFeeSatFor(20, 1) > ForwardPolicy.maxFeeSatFor(1, 2))
        assertEquals(ForwardPolicy.maxFeeSatFor(1, 2), ForwardPolicy.maxFeeSatFor(1, 2))
    }
}
