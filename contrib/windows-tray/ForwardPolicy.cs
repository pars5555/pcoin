// Copyright (c) 2026 The PCoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.
//
// Every decision the auto-forward feature makes, with no UI and no I/O.
//
// A 1:1 port of the Android app's ForwardPolicy.kt. The two clients must decide
// the same things the same way: the same thresholds, the same precondition
// order, the same wording, so a person who has used one already understands the
// other. Where the Kotlin made a deliberate choice, the choice and the reason
// for it are carried across unchanged.
//
// This file is deliberately pure. Not for elegance - because the decisions in
// here are the ones that spend money, and the only way to be sure they are
// right is to run them, exhaustively, against every awkward input a real chain
// produces. ForwardEngine does the talking to the node and owns nothing but
// plumbing; everything that decides IF, WHEN and HOW MUCH is here, and every
// branch of it is covered by SeedSelfTest, which runs with no node.
//
// The doctrine this file exists to enforce, stated once:
//
//   An RPC that failed, timed out, or answered "I do not know" resolves
//   nothing. It can never advance a record, never clear one, and never
//   authorise a build. Three bugs have already shipped on this project from
//   treating a transient read as authoritative state; in a send path that class
//   of bug spends money twice. So every input that could be "unknown" is
//   modelled as an explicit unknown (ForwardConditions.NodeAnswered,
//   TxObservation.Readable, TxObservation.MempoolReadable) rather than
//   collapsed into a boolean that reads as "no".

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace PCoinTray
{
    /**
     * The user's persisted intent about forwarding. Written only by a user
     * action, never by anything derived from a node read.
     *
     * The default is HOLDING and that is a complete, safe, permanent state: the
     * app's own wallet is phrase-backed, so coins accumulating there are as safe
     * as coins anywhere. Forwarding is opt-in, and nothing forwards until the
     * user has both set an address and confirmed a test payment arrived at it.
     */
    enum ForwardState
    {
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
     * BROADCAST is deliberately not called "sent". sendrawtransaction returning
     * a txid only proves the LOCAL mempool took it - with one peer, or with only
     * block-relay-only peers, nobody else has seen it. ACCEPTED is the first
     * state that may be worded as anything other than "waiting for a peer", and
     * it is reached only when the node's own `unbroadcast` flag clears, i.e.
     * when a peer asked for the transaction and got it.
     */
    enum SweepState
    {
        BROADCASTING,
        BROADCAST,
        ACCEPTED,
        CONFIRMED,
        SETTLED,
        FAILED_CONFLICTED,
    }

    enum SweepKind { SWEEP, PROBE }

    /** What this evaluation is allowed to do. */
    enum ForwardAction { NONE, PROBE, SWEEP }

    /**
     * Why forwarding is not sending anything right now.
     *
     * Every one of these is shown to the user verbatim. Most of them are
     * ordinary states, not errors - NOTHING_MATURE is what a healthy PC reports
     * for most of every day - so the wording is chosen to read as a status, not
     * a fault.
     */
    enum ForwardBlock
    {
        NONE,
        SHUTTING_DOWN,
        HOLDING,
        PENDING_SWEEP,
        NODE_NOT_READY,
        SYNCING,
        TIP_STALE,
        NO_RELAY_PEER,
        WALLET_NOT_LOADED,
        ADDRESS_PARKED,
        PROBE_AWAITING_ACK,
        NOTHING_MATURE,
    }

    enum AddressVerdict
    {
        OK,
        EMPTY,
        MALFORMED,
        UNSPENDABLE_WITNESS,
        OWN_WALLET,
        CONFIRMATION_MISMATCH,
    }

    enum Resolution
    {
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

    /** One transaction output, identified. */
    class Outpoint
    {
        public readonly string Txid;
        public readonly int Vout;

        public Outpoint(string txid, int vout) { Txid = txid ?? ""; Vout = vout; }

        // Value equality: verifySweep compares the decoded inputs against the
        // planned ones as a SET, which needs these to mean anything.
        public override bool Equals(object o)
        {
            var b = o as Outpoint;
            return b != null && Vout == b.Vout && string.Equals(Txid, b.Txid, StringComparison.Ordinal);
        }

        public override int GetHashCode() { return Txid.GetHashCode() * 31 + Vout; }

        public override string ToString()
        {
            return Txid + ":" + Vout.ToString(CultureInfo.InvariantCulture);
        }
    }

    /**
     * A candidate input, exactly as `listunspent` plus `gettransaction.generated`
     * describe it.
     *
     * Generated comes from gettransaction, not listunspent: listunspent carries
     * no coinbase flag at all, so without the extra round trip there is no way
     * to tell a 50 PCN block reward (unspendable until depth 101) from an
     * ordinary 50 PCN payment.
     */
    class Utxo
    {
        public string Txid = "";
        public int Vout = -1;
        public long AmountSat;
        public long Confirmations;
        public bool Spendable;
        public bool Safe;
        public bool Generated = true;

        public Outpoint Outpoint { get { return new Outpoint(Txid, Vout); } }
    }

    class DecodedOut
    {
        public string Address = "";
        public string ScriptHex = "";
        public long ValueSat;
        /** From getaddressinfo on the payout wallet. Only asked for probe change. */
        public bool IsMine;
        public bool IsChange;
    }

    /** A transaction as `decoderawtransaction` describes it. */
    class DecodedTx
    {
        public string Txid = "";
        public List<Outpoint> Inputs = new List<Outpoint>();
        public List<DecodedOut> Outputs = new List<DecodedOut>();
    }

    /**
     * The persisted record of a transaction this app has committed to.
     *
     * Written to disk BEFORE the broadcast and cleared only on a terminal,
     * node-confirmed outcome. Hex is persisted rather than re-derived because
     * the build uses `add_to_wallet: false` - so in the crash window between
     * building and broadcasting, gettransaction(txid).hex would not exist.
     * Re-broadcasting the stored hex is the ONLY recovery action; a rebuild is
     * never permitted.
     */
    class SweepRecord
    {
        public string Txid = "";
        public string Hex = "";
        public List<Outpoint> Inputs = new List<Outpoint>();
        public long AmountSat;
        public long FeeSat;
        public string Address = "";
        public SweepState State = SweepState.BROADCASTING;
        public SweepKind Kind = SweepKind.SWEEP;
        public long CreatedAtMs;
        public long BroadcastAtMs;
        public int Attempts;
        public long LastAttemptMs;
        public string LastError = "";
        /** When a `confirmations < 0` reading was FIRST seen. Never acted on alone. */
        public long ConflictSeenAtMs;

        public bool Terminal { get { return ForwardPolicy.IsTerminal(State); } }

        public SweepRecord Copy()
        {
            return new SweepRecord
            {
                Txid = Txid,
                Hex = Hex,
                Inputs = new List<Outpoint>(Inputs),
                AmountSat = AmountSat,
                FeeSat = FeeSat,
                Address = Address,
                State = State,
                Kind = Kind,
                CreatedAtMs = CreatedAtMs,
                BroadcastAtMs = BroadcastAtMs,
                Attempts = Attempts,
                LastAttemptMs = LastAttemptMs,
                LastError = LastError,
                ConflictSeenAtMs = ConflictSeenAtMs,
            };
        }
    }

    /**
     * Everything an evaluation needs to know, gathered fresh every time.
     *
     * Nothing in here is remembered between evaluations, and nothing in here is
     * read from storage except ForwardState and RecordNonTerminal, which are
     * persisted intent. Peer counts, balances, heights and confirmation counts
     * are live readings and are re-derived every time.
     */
    class ForwardConditions
    {
        public bool Alive;
        public ForwardState ForwardState = ForwardState.HOLDING;
        /** True when a sweep record exists in a non-terminal state. */
        public bool RecordNonTerminal;
        /** False when the RPC used to gather these numbers failed. Never "no". */
        public bool NodeAnswered;
        public bool InitialBlockDownload;
        public long Height = -1;
        public long Headers = -1;
        /** `getblockchaininfo.time` - the tip's own timestamp, seconds. */
        public long TipTimeSec;
        public long NowMs;
        /** Peers with relaytxes true that are NOT block-relay-only. */
        public int RelayPeers = -1;
        public bool PayoutWalletLoaded;
        /** Re-derived every evaluation by validateaddress. Never cached. */
        public bool DestinationValid;
        /** Sum of the VETTED candidate set - not getbalances.trusted. */
        public long SweepableSat;
        public int CandidateCount;
        /** Value of the single candidate a probe would spend. 0 when there is none. */
        public long ProbeCandidateSat;
    }

    class ForwardDecision
    {
        public readonly ForwardAction Action;
        public readonly ForwardBlock Block;

        public ForwardDecision(ForwardAction action, ForwardBlock block) { Action = action; Block = block; }

        public bool Clear { get { return Action != ForwardAction.NONE; } }
    }

    /** What `validateaddress` + `getaddressinfo` said about a typed address. */
    enum HistoryKind { RECEIVED, SENT, MINED, MATURING, CONFLICTED }

    /**
     * One line of wallet history.
     *
     * AmountSat is a MAGNITUDE, always positive. Core reports a send as a
     * negative amount, but the direction is already carried by Kind, and
     * keeping a sign in two places is how a screen ends up rendering "-1.5" as
     * received.
     *
     * Confirmations may be 0 (in the mempool) or NEGATIVE (the node has seen a
     * conflicting transaction in a block). Negative is not "fewer
     * confirmations", it is a different state entirely, and the UI must say
     * so rather than clamping it to zero.
     */
    class HistoryEntry
    {
        public string Txid = "";
        public HistoryKind Kind;
        public long AmountSat;
        /** Present only on sends; 0 otherwise. */
        public long FeeSat;
        public long Confirmations;
        public long TimeSec;
        /**
         * What `listtransactions.address` means depends on Kind: the
         * counterparty for SENT, YOUR OWN address for RECEIVED / MINED /
         * MATURING, blank for a send to several destinations.
         */
        public string Address = "";
    }

    /**
     * One page of history, plus how many rows the NODE returned before the
     * classifier dropped any. The raw count is what decides whether more pages
     * exist; the filtered list is what the screen draws. Conflating the two
     * ends the list early on a page that happened to be all-unreadable.
     */
    class HistoryPage
    {
        public List<HistoryEntry> Entries = new List<HistoryEntry>();
        public int RawCount;
    }

    class AddressFacts
    {
        public bool IsValid;
        public bool IsWitness;
        public int WitnessVersion;
        /** getaddressinfo.ismine on the PAYOUT wallet specifically. */
        public bool IsMine;
        public string NodeError = "";
        /**
         * validateaddress.scriptPubKey - the node's own encoding of this
         * address, kept so the decode check can compare the built output
         * against something derived independently of how the address renders.
         */
        public string ScriptPubKey = "";
    }

    /**
     * What the node said about a recorded transaction on this evaluation.
     *
     * The two "readable" flags are the whole point of the type. A failed
     * gettransaction is NOT "the transaction does not exist", and a failed
     * getmempoolentry is NOT "it is not in the mempool" - conflating either with
     * a definite answer is exactly how a second payment gets built.
     */
    class TxObservation
    {
        /** False when the wallet RPC failed or the wallet was not loaded. */
        public bool Readable;
        /** False when the wallet answered but does not know this txid. */
        public bool KnownToWallet;
        public int Confirmations;
        /** False when getmempoolentry could not be asked at all. */
        public bool MempoolReadable;
        public bool InMempool;
        /** getmempoolentry.unbroadcast: no peer has taken it yet. */
        public bool Unbroadcast = true;
    }

    static class ForwardPolicy
    {
        // ------------------------------------------------------------ thresholds

        /**
         * Smallest sweep worth building, 1.00000000 PCN.
         *
         * Not a fee rule. At the 1 sat/vB floor a one-input sweep costs 110 sat
         * against a 50 PCN reward - fees on this chain are irrelevant, and the
         * formal `value >= 1000 x fee` arm below never binds. What this floor
         * actually does is refuse to build a transaction for leftover dust: a
         * stray change output, a tiny inbound payment. At 1/50th of a block
         * reward it can never delay a genuine mining payout by even one block.
         */
        public const long MIN_SWEEP_SAT = 100000000L;

        /**
         * The test payment, 1.00000000 PCN.
         *
         * Big enough to be unmissable in any wallet UI (340,000x the 294 sat
         * P2WPKH dust threshold), small enough that sending it to the wrong
         * place is a lesson rather than a loss. 2% of one block reward.
         */
        public const long PROBE_SAT = 100000000L;

        /**
         * Caps transaction size at 13.6 kvB (well under the 100 kvB standardness
         * limit) and RPC latency when someone arms forwarding after months of
         * holding. The remainder sweeps on the next evaluation.
         */
        public const int MAX_INPUTS_PER_SWEEP = 200;

        /**
         * Depth a coinbase must reach before this app will spend it.
         *
         * Consensus makes it spendable at 101 (`nSpendHeight - coin.nHeight <
         * COINBASE_MATURITY`, COINBASE_MATURITY = 100). Building at exactly 101
         * means a ONE-BLOCK REORG invalidates the signed transaction: the input
         * drops back to immature, the transaction is evicted, and the sweep
         * fails silently. Six blocks of margin removes that whole failure class
         * for about 1.4 h against a ~25 h maturity wait.
         */
        public const long COINBASE_SWEEP_DEPTH = 107L;

        /** Ordinary outputs have no maturity rule; 6 is conventional and enough. */
        public const long MIN_DEPTH = 6L;

        /** Confirmations at which a record becomes terminal. */
        public const int SETTLED_CONFIRMATIONS = 6;

        /**
         * How stale the tip may be before we refuse to send.
         *
         * Measured spacing on PCoin today is 815-868 s, not the 600 s target.
         * With a mean of 868 s, P(gap > 20 min) = 25% - so a 20-minute tolerance
         * would false-alarm a quarter of the time. At 3 h, P = 4e-6, and still
         * only 0.2% if the chain halves in speed before LWMA activates at 2800.
         *
         * This is a backstop, not the primary isolation detector: a PC that is
         * eclipsed keeps MINING, so it extends its own fork and its tip stays
         * fresh. ForwardConditions.RelayPeers is the real detector.
         */
        public const long TIP_AGE_LIMIT_MS = 3 * 60 * 60 * 1000L;

        /** At most one evaluation a minute, however many blocks arrive. */
        public const long EVAL_DEBOUNCE_MS = 60000L;

        /**
         * One evaluation every half hour regardless of blocks, so a pending
         * sweep still gets re-announced and refreshed on a chain that has gone
         * quiet.
         */
        public const long EVAL_BACKSTOP_MS = 30 * 60000L;

        /** How long a transaction may sit unbroadcast before we re-announce it. */
        public const long REANNOUNCE_AFTER_MS = 30 * 60000L;

        /**
         * A `confirmations < 0` reading must be seen twice, this far apart,
         * before a record is declared conflicted. Acting on a single reading is
         * the one place where being wrong builds a SECOND transaction.
         */
        public const long CONFLICT_CONFIRM_MS = 10 * 60000L;

        /** Same tolerance the mining gate uses; blocks and headers arrive apart. */
        public const long SYNC_TOLERANCE_BLOCKS = 3L;

        /**
         * The wallet's own floor, in sat/vB: max(m_min_fee = 1000 sat/kvB,
         * relayMinFee = 100 sat/kvB) = 1.000 sat/vB. Anything lower is rejected
         * outright ("Fee rate is lower than the minimum fee rate setting");
         * anything higher is waste on a chain whose mempool holds one
         * transaction.
         *
         * Passed explicitly rather than inherited from `fallbackfee`, which
         * today happens to give the same number but is only consulted while
         * estimatesmartfee returns nothing. The moment PCoin has fee history
         * that config line stops applying and every sweep would silently change
         * price.
         */
        public const double FEE_RATE_SAT_VB = 1.0;

        /**
         * sendrawtransaction's maxfeerate, in PCN/kvB - a DIFFERENT UNIT from
         * the sat/vB above, on the immediately adjacent call. 0.0001 PCN/kvB =
         * 10 sat/vB = 10x our target, which is the intended headroom.
         */
        public const double BROADCAST_MAX_FEE_RATE = 0.0001;

        /** How many characters of the address the user must retype. */
        public const int CONFIRM_TAIL_LENGTH = 6;

        public static bool IsTerminal(SweepState s)
        {
            return s == SweepState.SETTLED || s == SweepState.FAILED_CONFLICTED;
        }

        /** P2WPKH sweep to one output: weight 166 + 272n, i.e. vsize 41.5 + 68n. */
        public static double EstimatedVsize(int inputs) { return 41.5 + 68.0 * inputs; }

        /** What the sweep should cost at the 1 sat/vB floor. */
        public static long EstimatedFeeSat(int inputs)
        {
            return (long)Math.Ceiling(EstimatedVsize(inputs) * FEE_RATE_SAT_VB);
        }

        /**
         * Hard ceiling asserted against the DECODED transaction before
         * broadcast. 10x headroom over target: 1,095 sat at one input, 136,415
         * at two hundred. This is the assertion that catches a fee-unit blunder
         * before it costs anything.
         */
        public static long MaxFeeSat(int inputs)
        {
            return (long)Math.Ceiling(FEE_CEILING_HEADROOM * EstimatedVsize(inputs));
        }

        /**
         * Every fee ceiling is `rate x this`, in both units: the decoded-fee
         * ceilings (MaxFeeSat, MaxFeeSatFor) and the broadcast maxfeerate. One
         * number so the "raised in lockstep" property is structural.
         */
        public const double FEE_CEILING_HEADROOM = 10.0;

        /**
         * The rates a user can choose on the send screen. STATIC on purpose:
         * this chain has no fee history (blocks are mostly coinbase-only), so
         * `estimatesmartfee` returns an error, not a number, and there is
         * nothing to be dynamic about. A higher tier buys robustness -
         * clearing a miner running a raised `blockmintxfee`, or outbidding a
         * competing tx - not auction position.
         *
         * Only this type can reach the user path's `fee_rate`, so only these
         * three vetted values can ever be sent. A sealed class with three
         * instances rather than an enum, because a C# enum cannot carry the
         * rate; it is the same shape as the Kotlin enum on the Android side.
         */
        public sealed class FeeTier
        {
            public readonly string Name;
            /** What the send screen prints on the button. */
            public readonly string Label;
            public readonly double RateSatVb;

            FeeTier(string name, string label, double rateSatVb)
            {
                Name = name;
                Label = label;
                RateSatVb = rateSatVb;
            }

            public static readonly FeeTier NORMAL = new FeeTier("NORMAL", "Normal", 1.0);
            public static readonly FeeTier FAST = new FeeTier("FAST", "Fast", 5.0);
            public static readonly FeeTier VERY_FAST = new FeeTier("VERY_FAST", "Very fast", 20.0);
            public static readonly FeeTier[] All = { NORMAL, FAST, VERY_FAST };

            /**
             * The `sendrawtransaction`/`testmempoolaccept` maxfeerate for this
             * tier, in PCN/kvB. 1 sat/vB = 1e-5 PCN/kvB; the only place that
             * conversion is written.
             */
            public double BroadcastMaxFeeRatePcnKvb
            {
                get { return RateSatVb * FEE_CEILING_HEADROOM / 100000.0; }
            }

            public override string ToString() { return Name; }

            /** An unrecognised name is the floor, never a guess upwards. */
            public static FeeTier ByName(string name)
            {
                foreach (var t in All) if (string.Equals(t.Name, name, StringComparison.Ordinal)) return t;
                return NORMAL;
            }
        }

        /**
         * The same ceiling as MaxFeeSat, for a transaction the NODE chose the
         * inputs for.
         *
         * A user-directed send does not pass an input set, so the count is only
         * known after decoding. Two outputs rather than one adds 31 vbytes.
         *
         * Scales with the tier's rate so that Fast/Very fast keep the SAME 10x
         * headroom rather than a loosened absolute bound; the floor-rate
         * overload keeps every existing caller and test exactly where it was.
         */
        public static long MaxFeeSatFor(int inputs, int outputs)
        {
            return MaxFeeSatFor(inputs, outputs, FEE_RATE_SAT_VB);
        }

        public static long MaxFeeSatFor(int inputs, int outputs, double rateSatVb)
        {
            return (long)Math.Ceiling(FEE_CEILING_HEADROOM * rateSatVb * (10.5 + 68.0 * inputs + 31.0 * outputs));
        }

        /**
         * A user-directed send, checked against the transaction the node
         * actually built rather than the one we asked for.
         *
         * Everything here is asserted on the DECODED bytes. The request said
         * what we wanted; this says what we got, and only the second one is
         * about to be broadcast.
         *
         * The change assertion is the one that matters, and it is the same
         * reasoning as VerifyProbe: a mis-built transaction could pay the
         * destination perfectly and quietly send the remaining balance to a
         * stranger. Change must be ours AND on a change descriptor.
         *
         * @param sendMax true when the user asked to empty the wallet, in
         *   which case there is no change and exactly one output is expected.
         * @return null when the transaction is exactly what was asked for,
         *   otherwise one sentence saying what is wrong with it.
         */
        public static string VerifyUserSend(
            DecodedTx decoded,
            string destination,
            string expectedScriptHex,
            string expectedTxid,
            long requestedSat,
            bool sendMax,
            long inputValueSat,
            double rateSatVb)
        {
            if (!string.Equals(decoded.Txid, expectedTxid, StringComparison.Ordinal))
                return "txid does not match the decoded transaction";
            if (decoded.Inputs.Count == 0) return "the transaction spends nothing";

            int expectedOutputs = sendMax ? 1 : 2;
            // Core folds sub-dust change into the fee, so an exact-amount send
            // can legitimately come back with one output. More than expected
            // never can.
            if (decoded.Outputs.Count > expectedOutputs)
                return "expected at most " + expectedOutputs + " outputs, got " + decoded.Outputs.Count;
            if (decoded.Outputs.Count == 0) return "the transaction pays nothing";

            int paidIndex = -1;
            for (int i = 0; i < decoded.Outputs.Count; i++)
            {
                if (string.Equals(decoded.Outputs[i].Address, destination, StringComparison.Ordinal)) { paidIndex = i; break; }
            }
            if (paidIndex < 0) return "no output pays the address you entered";
            var paid = decoded.Outputs[paidIndex];

            if (!ScriptMatches(paid.ScriptHex, expectedScriptHex))
                return "the output script does not match that address";
            if (!sendMax && paid.ValueSat != requestedSat)
                return "the amount built is " + paid.ValueSat + " sat, not the " + requestedSat + " sat you asked for";

            if (decoded.Outputs.Count == 2)
            {
                var change = decoded.Outputs[1 - paidIndex];
                if (!change.IsMine) return "change does not come back to this wallet";
                if (!change.IsChange) return "change is not on a change descriptor";
            }

            long outValue = 0;
            foreach (var o in decoded.Outputs) outValue += o.ValueSat;
            long fee = inputValueSat - outValue;
            if (fee <= 0) return "fee is not positive";
            long ceiling = MaxFeeSatFor(decoded.Inputs.Count, decoded.Outputs.Count, rateSatVb);
            if (fee > ceiling)
                return "fee " + fee + " sat exceeds the " + ceiling + " sat ceiling at " +
                    rateSatVb.ToString("0.###", CultureInfo.InvariantCulture) + " sat/vB";
            return null;
        }

        // ------------------------------------------------------------- history

        /**
         * One row of `listtransactions`, classified - or null when the row is
         * dropped. Pure, so the self-test can pin every branch.
         *
         * Categories, all four of which this chain produces: `generate` (a
         * mined block past maturity), `immature` (mined, not yet spendable),
         * `send`, `receive`. `orphan` is a mined block that lost a reorg; on a
         * chain with a ~3% stale rate it is not hypothetical, and it is folded
         * into CONFLICTED because the money is genuinely not there.
         *
         * A row is dropped when it has no txid, when its `amount` field is
         * MISSING (a send whose amount we cannot read is not a send of zero),
         * or when its category is one this chain never produces. The caller
         * counts rows BEFORE this drops any - see HistoryPage.RawCount.
         */
        public static HistoryEntry HistoryRow(object row)
        {
            if (Json.Obj(row) == null) return null;
            string txid = (Json.Str(row, "txid") ?? "").Trim();
            if (txid.Length == 0) return null;
            string category = Json.Str(row, "category") ?? "";
            double? confs = Json.Number(row, "confirmations");
            long confirmations = confs.HasValue ? (long)confs.Value : 0L;
            double? amount = Json.Number(row, "amount");
            if (!amount.HasValue) return null;

            HistoryKind kind;
            if (confirmations < 0 || category == "orphan") kind = HistoryKind.CONFLICTED;
            else if (category == "immature") kind = HistoryKind.MATURING;
            else if (category == "generate") kind = HistoryKind.MINED;
            else if (category == "send") kind = HistoryKind.SENT;
            else if (category == "receive") kind = HistoryKind.RECEIVED;
            else return null;

            var e = new HistoryEntry();
            e.Txid = txid;
            e.Kind = kind;
            e.AmountSat = Math.Abs(ToSat(amount.Value));
            // `fee` is present only on sends, and is negative there.
            e.FeeSat = Math.Abs(ToSat(Json.Number(row, "fee") ?? 0.0));
            e.Confirmations = confirmations;
            e.TimeSec = (long)(Json.Number(row, "time") ?? 0.0);
            e.Address = Json.Str(row, "address") ?? "";
            return e;
        }

        /**
         * The formal floor: max(1 PCN, 1000 x estimated fee). At 1 sat/vB the
         * second arm is 0.0011 PCN for one input, so it never binds today - it
         * is here so that if this chain ever grows a fee market, the sweep stops
         * being worth building before it stops being worth having.
         */
        public static long MinSweepSat(int inputs)
        {
            return Math.Max(MIN_SWEEP_SAT, 1000L * EstimatedFeeSat(Math.Max(inputs, 1)));
        }

        // ------------------------------------------------------------- wording

        /** Shown verbatim. Ordinary states read as a status, not a fault. */
        public static string Reason(ForwardBlock b)
        {
            switch (b)
            {
                case ForwardBlock.NONE: return "";
                case ForwardBlock.SHUTTING_DOWN: return "Stopping.";
                case ForwardBlock.HOLDING: return "Holding coins in this wallet.";
                case ForwardBlock.PENDING_SWEEP: return "Waiting for the previous forward to settle.";
                case ForwardBlock.NODE_NOT_READY: return "Node not ready.";
                case ForwardBlock.SYNCING: return "Node still syncing.";
                case ForwardBlock.TIP_STALE: return "Chain stalled, or this PC is isolated.";
                case ForwardBlock.NO_RELAY_PEER: return "No peer that will accept transactions.";
                case ForwardBlock.WALLET_NOT_LOADED: return "Wallet not loaded.";
                case ForwardBlock.ADDRESS_PARKED: return "The saved forwarding address no longer validates.";
                case ForwardBlock.PROBE_AWAITING_ACK: return "Waiting for you to confirm the test payment arrived.";
                case ForwardBlock.NOTHING_MATURE: return "Nothing mature to forward yet.";
            }
            return "";
        }

        public static string Message(AddressVerdict v)
        {
            switch (v)
            {
                case AddressVerdict.OK: return "";
                case AddressVerdict.EMPTY: return "Enter the address you want your coins forwarded to.";
                case AddressVerdict.MALFORMED: return "That is not a valid PCoin address.";
                case AddressVerdict.UNSPENDABLE_WITNESS:
                    return "That address uses a future address format that nothing on this network can spend yet. " +
                           "Coins sent there would be lost.";
                case AddressVerdict.OWN_WALLET:
                    return "That is this PC's own wallet address. Forwarding there would only pay fees.";
                case AddressVerdict.CONFIRMATION_MISMATCH:
                    return "The confirmation does not match the last 6 characters of the address.";
            }
            return "";
        }

        /** Never the word "sent" before a peer has taken the transaction. */
        public static string SweepWording(SweepState state, int confirmations)
        {
            switch (state)
            {
                case SweepState.BROADCASTING: return "building and sending";
                case SweepState.BROADCAST: return "broadcast, waiting for a peer to take it";
                case SweepState.ACCEPTED: return "accepted by the network, 0 of 1 confirmations";
                case SweepState.CONFIRMED:
                    return "confirmed (" + Math.Max(confirmations, 1).ToString(CultureInfo.InvariantCulture) +
                           " of " + SETTLED_CONFIRMATIONS.ToString(CultureInfo.InvariantCulture) + ")";
                case SweepState.SETTLED: return "settled";
                case SweepState.FAILED_CONFLICTED: return "dropped; the coins are still in this wallet";
            }
            return "";
        }

        /**
         * Coin amounts held in satoshi. Everything on the forwarding path works
         * in integers - a transaction is built, verified and recorded in
         * satoshi, and only the display converts - because a fee assertion done
         * in floating point is an assertion that can be off by a rounding error.
         *
         * The ticker is "PC", the same string the tray already prints and the
         * same one the Android app uses, so the two clients agree.
         */
        public static string CoinsSat(long sat)
        {
            if (sat < 0) return "--";
            return (sat / 100000000L).ToString(CultureInfo.InvariantCulture) + "." +
                   (sat % 100000000L).ToString("00000000", CultureInfo.InvariantCulture) + " PC";
        }

        /**
         * A rough wall-clock duration, for "about 10 h from now" estimates.
         * Deliberately coarse: the underlying number comes from observed block
         * spacing on a chain whose difficulty is currently pinned, so minutes of
         * precision would be false confidence.
         */
        public static string RoughDuration(long ms)
        {
            if (ms < 0) return "--";
            if (ms < 90 * 60000L)
                return Math.Max(1L, ms / 60000L).ToString(CultureInfo.InvariantCulture) + " min";
            if (ms < 48 * 3600000L)
                return ((long)Math.Round(ms / 3600000.0)).ToString(CultureInfo.InvariantCulture) + " h";
            return ((long)Math.Round(ms / 86400000.0)).ToString(CultureInfo.InvariantCulture) + " days";
        }

        // ------------------------------------------------------------- scheduling

        /**
         * Whether this tick should run an evaluation at all.
         *
         * Driven off the one event that can change the answer - a new block -
         * because a timer decoupled from the chain can fire in the middle of a
         * reorg or a resync, where whatever it computes is meaningless. Height
         * is already fetched on the tray's five-second poll, so this costs
         * nothing new.
         *
         * A 1-2 hour timer, which is what was originally asked for, would find
         * nothing to do on most runs: a PC produces a maturing coinbase every
         * few hours at best, and each one is spendable only ~25 h after it was
         * found.
         *
         * `since` is clamped at zero. Windows sleep, hibernate and NTP
         * corrections can move the wall clock backwards, and every interval here
         * is measured against a persisted timestamp; a negative interval must
         * never read as "a very long time ago".
         */
        public static bool ShouldEvaluate(long height, long lastEvaluatedHeight,
                                          long nowMs, long lastEvaluationMs, bool force)
        {
            if (force) return true;
            long since = Math.Max(0L, nowMs - lastEvaluationMs);
            // Backstop first: a pending sweep needs re-announcing and refreshing
            // even on a chain that has produced nothing for half an hour.
            if (lastEvaluationMs != 0L && since >= EVAL_BACKSTOP_MS) return true;
            if (lastEvaluationMs != 0L && since < EVAL_DEBOUNCE_MS) return false;
            if (height < 0) return false;
            return height != lastEvaluatedHeight;
        }

        // -------------------------------------------------------------- candidates

        /**
         * The outputs the node will actually let us spend right now, in the
         * order a sweep will spend them.
         *
         * Deterministic ordering is not cosmetic: it is what guarantees that two
         * attempts at the same moment select the same inputs and therefore
         * CONFLICT rather than both pay.
         */
        public static List<Utxo> VetCandidates(List<Utxo> all)
        {
            var kept = new List<Utxo>();
            foreach (var u in all)
            {
                if (!u.Spendable || !u.Safe) continue;
                if (u.Confirmations < (u.Generated ? COINBASE_SWEEP_DEPTH : MIN_DEPTH)) continue;
                kept.Add(u);
            }
            kept.Sort(delegate(Utxo a, Utxo b)
            {
                int c = string.CompareOrdinal(a.Txid, b.Txid);
                return c != 0 ? c : a.Vout.CompareTo(b.Vout);
            });
            if (kept.Count > MAX_INPUTS_PER_SWEEP) kept.RemoveRange(MAX_INPUTS_PER_SWEEP, kept.Count - MAX_INPUTS_PER_SWEEP);
            return kept;
        }

        public static long TotalSat(List<Utxo> utxos)
        {
            long t = 0;
            foreach (var u in utxos) t += u.AmountSat;
            return t;
        }

        // ------------------------------------------------------------ the decision

        /**
         * The whole trigger, as one predicate over freshly-read state.
         *
         * Order matters: cheap persisted intent first, then node readiness, then
         * network reachability, then value. Each failure carries its own reason,
         * which is what the UI shows - "not forwarding" with no explanation is
         * the thing this design is trying hardest to avoid.
         */
        public static ForwardDecision Decide(ForwardConditions c)
        {
            if (!c.Alive) return Blocked(ForwardBlock.SHUTTING_DOWN);
            // Not an error and never shown as one: no address set is a complete,
            // safe state, and the wallet holding the coins is phrase-backed.
            if (c.ForwardState == ForwardState.HOLDING) return Blocked(ForwardBlock.HOLDING);
            // Before anything else that could build: one record at a time, ever.
            if (c.RecordNonTerminal) return Blocked(ForwardBlock.PENDING_SWEEP);
            // An unanswered node is never clear-to-send. This is the doctrine.
            if (!c.NodeAnswered) return Blocked(ForwardBlock.NODE_NOT_READY);
            if (c.InitialBlockDownload) return Blocked(ForwardBlock.SYNCING);
            if (c.Height < 0 || c.Headers < 0) return Blocked(ForwardBlock.SYNCING);
            if (c.Headers - c.Height > SYNC_TOLERANCE_BLOCKS) return Blocked(ForwardBlock.SYNCING);
            if (TipAgeMs(c.TipTimeSec, c.NowMs) > TIP_AGE_LIMIT_MS) return Blocked(ForwardBlock.TIP_STALE);
            // getconnectioncount > 0 is explicitly NOT sufficient: a
            // block-relay-only peer never requests our transaction, so a node
            // with only those can "successfully" broadcast to an audience of
            // nobody - and then report a payment the network has never seen.
            if (c.RelayPeers < 1) return Blocked(ForwardBlock.NO_RELAY_PEER);
            if (!c.PayoutWalletLoaded) return Blocked(ForwardBlock.WALLET_NOT_LOADED);
            // Parks forwarding; never rewrites or clears the stored address.
            if (!c.DestinationValid) return Blocked(ForwardBlock.ADDRESS_PARKED);

            switch (c.ForwardState)
            {
                case ForwardState.PROBING_SENT:
                    return Blocked(ForwardBlock.PROBE_AWAITING_ACK);
                case ForwardState.PROBING_PENDING:
                    return (c.CandidateCount >= 1 && c.ProbeCandidateSat >= PROBE_SAT + MaxFeeSat(1))
                        ? new ForwardDecision(ForwardAction.PROBE, ForwardBlock.NONE)
                        : Blocked(ForwardBlock.NOTHING_MATURE);
                case ForwardState.ARMED:
                    return (c.CandidateCount >= 1 && c.SweepableSat >= MinSweepSat(c.CandidateCount))
                        ? new ForwardDecision(ForwardAction.SWEEP, ForwardBlock.NONE)
                        : Blocked(ForwardBlock.NOTHING_MATURE);
            }
            return Blocked(ForwardBlock.HOLDING);       // unreachable
        }

        static ForwardDecision Blocked(ForwardBlock b)
        {
            return new ForwardDecision(ForwardAction.NONE, b);
        }

        /**
         * Tip age, clamped at zero.
         *
         * A block timestamp up to LWMA_MAX_FUTURE_BLOCK_TIME (900 s) ahead of
         * local time is perfectly legal, so a negative age is ordinary and must
         * not read as "very fresh" by accident, nor as an error.
         *
         * Uses the tip's own `time`, never `mediantime`: mediantime lags 5
         * blocks by construction, which at this chain's spacing is over an hour,
         * and would make a 3 h check meaningless.
         */
        public static long TipAgeMs(long tipTimeSec, long nowMs)
        {
            if (tipTimeSec <= 0L) return long.MaxValue;
            return Math.Max(0L, nowMs - tipTimeSec * 1000L);
        }

        // -------------------------------------------------- decode-time assertions

        /**
         * The gate between "built" and "committed".
         *
         * Called on the decoded, signed, NOT-yet-broadcast transaction. Every
         * assertion has to hold; the first failure aborts with the coins exactly
         * where they were, which is the safe failure direction. Returns null
         * when everything holds, or the name of the assertion that did not.
         *
         * @param expectedScriptHex an INDEPENDENT second derivation of the
         *   destination, from validateaddress, in case address rendering and
         *   address encoding ever disagree.
         */
        public static string VerifySweep(DecodedTx decoded, List<Utxo> planned, string destination,
                                         string expectedScriptHex, string expectedTxid)
        {
            if (decoded.Outputs.Count != 1)
                return "a: expected exactly 1 output, got " + decoded.Outputs.Count.ToString(CultureInfo.InvariantCulture);
            var outp = decoded.Outputs[0];
            if (!string.Equals(outp.Address, destination, StringComparison.Ordinal))
                return "b: output pays a different address";
            if (!ScriptMatches(outp.ScriptHex, expectedScriptHex))
                return "c: output script does not match the destination's own script";
            string inputsComplaint = InputsMatch(decoded, planned);
            if (inputsComplaint != null) return inputsComplaint;

            long inValue = PlannedValue(planned);
            // The only independent value this can be checked against is the
            // app's own selection, so the fee IS the difference by construction.
            // Do not add "output == inValue - fee" back: it expands to `x != x`
            // and reads as a balance check that can never fire. The real
            // protections are the ceiling below, which does bind, and
            // testmempoolaccept.
            long fee = inValue - outp.ValueSat;
            long ceiling = MaxFeeSat(planned.Count);
            if (fee <= 0) return "e: fee is not positive";
            if (fee > ceiling)
                return "e: fee " + fee.ToString(CultureInfo.InvariantCulture) + " sat exceeds the " +
                       ceiling.ToString(CultureInfo.InvariantCulture) + " sat ceiling";
            if (outp.ValueSat < MIN_SWEEP_SAT) return "f: output is below the minimum sweep";
            if (!string.Equals(decoded.Txid, expectedTxid, StringComparison.Ordinal))
                return "g: txid does not match the decoded transaction";
            return null;
        }

        /**
         * The same gate for the probe, where the shape is different: an exact
         * amount to the destination plus change back to us.
         *
         * The change assertion is the one that matters. Without it a mis-built
         * transaction could quietly send 49 PCN of change to a stranger while
         * the 1 PCN test payment looked perfect.
         */
        public static string VerifyProbe(DecodedTx decoded, List<Utxo> planned, string destination,
                                         string expectedScriptHex, string expectedTxid)
        {
            if (decoded.Outputs.Count != 2)
                return "a: expected exactly 2 outputs, got " + decoded.Outputs.Count.ToString(CultureInfo.InvariantCulture);
            int paidIndex = -1;
            for (int i = 0; i < decoded.Outputs.Count; i++)
            {
                if (string.Equals(decoded.Outputs[i].Address, destination, StringComparison.Ordinal)) { paidIndex = i; break; }
            }
            if (paidIndex < 0) return "b: no output pays the destination";
            var paid = decoded.Outputs[paidIndex];
            if (paid.ValueSat != PROBE_SAT)
                return "b: test payment is not exactly " + PROBE_SAT.ToString(CultureInfo.InvariantCulture) + " sat";
            if (!ScriptMatches(paid.ScriptHex, expectedScriptHex))
                return "c: output script does not match the destination's own script";
            var change = decoded.Outputs[1 - paidIndex];
            if (!change.IsMine) return "c: change does not belong to this wallet";
            if (!change.IsChange) return "c: change is not on a change descriptor";
            string inputsComplaint = InputsMatch(decoded, planned);
            if (inputsComplaint != null) return inputsComplaint;

            long inValue = PlannedValue(planned);
            long fee = inValue - paid.ValueSat - change.ValueSat;
            long ceiling = MaxFeeSat(planned.Count);
            if (fee <= 0) return "e: fee is not positive";
            if (fee > ceiling)
                return "e: fee " + fee.ToString(CultureInfo.InvariantCulture) + " sat exceeds the " +
                       ceiling.ToString(CultureInfo.InvariantCulture) + " sat ceiling";
            if (!string.Equals(decoded.Txid, expectedTxid, StringComparison.Ordinal))
                return "g: txid does not match the decoded transaction";
            return null;
        }

        //! Proves the node did not add or drop an input: compared as a SET and
        //! by count, so a duplicate cannot hide inside a matching set.
        static string InputsMatch(DecodedTx decoded, List<Utxo> planned)
        {
            var plannedSet = new HashSet<Outpoint>();
            foreach (var u in planned) plannedSet.Add(u.Outpoint);
            var decodedSet = new HashSet<Outpoint>(decoded.Inputs);
            if (decoded.Inputs.Count != plannedSet.Count || !decodedSet.SetEquals(plannedSet))
                return "d: inputs are not the ones selected";
            return null;
        }

        static long PlannedValue(List<Utxo> planned)
        {
            long v = 0;
            foreach (var u in planned) v += u.AmountSat;
            return v;
        }

        /**
         * Case-insensitive, and an EMPTY expectation never matches. A blank
         * expected script means validateaddress did not give us one, and letting
         * that compare equal to a blank decode would turn the independent second
         * derivation into no check at all.
         */
        static bool ScriptMatches(string actual, string expected)
        {
            return !string.IsNullOrEmpty(expected) && expected.Trim().Length > 0 &&
                   !string.IsNullOrEmpty(actual) && actual.Trim().Length > 0 &&
                   string.Equals(actual, expected, StringComparison.OrdinalIgnoreCase);
        }

        // ------------------------------------------------------------- resolution

        /**
         * Resolves a non-terminal record against one observation.
         *
         * Re-broadcasting is always safe and is the supported way to re-announce:
         * BroadcastTransaction skips resubmission entirely when the txid is
         * already in the mempool, and returns ALREADY_IN_UTXO_SET (RPC -27)
         * before doing anything if it already confirmed. There is no path by
         * which re-sending a stored hex produces a second payment.
         */
        public static Resolution Resolve(TxObservation obs, SweepRecord record, long nowMs)
        {
            if (!obs.Readable) return Resolution.UNRESOLVED;

            if (obs.KnownToWallet)
            {
                if (obs.Confirmations >= SETTLED_CONFIRMATIONS) return Resolution.MARK_SETTLED;
                if (obs.Confirmations >= 1) return Resolution.MARK_CONFIRMED;
                if (obs.Confirmations < 0)
                {
                    // Core's own definitive "this conflicts with a confirmed
                    // transaction". Still not enough on its own.
                    long first = record.ConflictSeenAtMs;
                    return (first != 0L && Math.Max(0L, nowMs - first) >= CONFLICT_CONFIRM_MS)
                        ? Resolution.MARK_CONFLICTED
                        : Resolution.NOTE_CONFLICT;
                }
            }

            // confirmations == 0, or the wallet has never heard of it (the crash
            // window between persisting the record and the broadcast landing).
            if (!obs.MempoolReadable) return Resolution.UNRESOLVED;
            if (!obs.InMempool)
            {
                // Either it was never broadcast, or the node restarted and lost
                // its mempool. Both are fixed by re-sending the stored hex.
                return Resolution.REBROADCAST;
            }
            if (!obs.Unbroadcast) return Resolution.MARK_ACCEPTED;
            // Clamped: a clock that moved backwards must never make a
            // re-announce come due earlier than it should.
            long since = record.BroadcastAtMs != 0L ? Math.Max(0L, nowMs - record.BroadcastAtMs) : 0L;
            return since >= REANNOUNCE_AFTER_MS ? Resolution.REBROADCAST : Resolution.MARK_BROADCAST;
        }

        // -------------------------------------------------------- address entry

        /**
         * Strips the things people actually paste: surrounding whitespace, and a
         * `pcoin:` URI prefix with any query string a wallet appended to it.
         * Then folds an all-uppercase bech32 address to lower case.
         */
        public static string NormalizeAddress(string raw)
        {
            if (raw == null) return "";
            string s = raw.Trim();
            if (s.StartsWith("pcoin:", StringComparison.Ordinal)) s = s.Substring(6);
            else if (s.StartsWith("PCOIN:", StringComparison.Ordinal)) s = s.Substring(6);
            int q = s.IndexOf('?');
            if (q >= 0) s = s.Substring(0, q);
            s = s.Trim();
            return IsUppercaseBech32(s) ? s.ToLowerInvariant() : s;
        }

        /** The bech32 data charset, which deliberately excludes b, i, o and 1. */
        const string BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

        /**
         * An address written entirely in capitals that is bech32, not base58.
         *
         * BIP173 permits an all-uppercase bech32 string and this fork accepts
         * one: bech32::Decode lower-cases the HRP (src/bech32.cpp) and CHARSET_REV
         * maps upper and lower case to the same values, so `PC1Q...` passes
         * validateaddress. But the node re-encodes every address it reports in
         * lower case, so a stored uppercase destination would never compare equal
         * to the address in the decoded transaction: assertion (b) would abort
         * every build, forever, and forwarding would silently never work.
         *
         * Folding is restricted to strings that cannot be base58 - base58 is
         * case-SENSITIVE, so lowercasing one would corrupt it. The data part of a
         * bech32 address lies inside BECH32_CHARSET, which excludes B, I and O,
         * making a false positive on a real base58 address vanishingly unlikely;
         * and the node still validates the result before anything is stored.
         */
        static bool IsUppercaseBech32(string s)
        {
            int sep = s.LastIndexOf('1');
            if (sep < 1 || sep + 1 >= s.Length) return false;
            foreach (char c in s) if (char.IsLower(c)) return false;
            for (int i = 0; i < sep; i++) if (s[i] < 'A' || s[i] > 'Z') return false;
            for (int i = sep + 1; i < s.Length; i++)
                if (BECH32_CHARSET.IndexOf(char.ToLowerInvariant(s[i])) < 0) return false;
            return true;
        }

        /**
         * The full entry check.
         *
         * Wrong-chain addresses need no special case: PCoin's hrp is "pc" and
         * its base58 versions are 55/56, so a Bitcoin `bc1q...` or `1...` fails
         * validateaddress outright and lands on MALFORMED.
         *
         * @param confirmTail what the user retyped, to catch transcription and
         *   clipboard-hijack errors that a checksum cannot. Pass null to skip
         *   (the caller checks it separately when the field is still being
         *   typed).
         */
        public static AddressVerdict CheckAddress(string normalized, AddressFacts facts, string confirmTail)
        {
            if (string.IsNullOrEmpty(normalized)) return AddressVerdict.EMPTY;
            foreach (char c in normalized) if (char.IsWhiteSpace(c)) return AddressVerdict.MALFORMED;
            if (!facts.IsValid) return AddressVerdict.MALFORMED;
            // Valid to encode, unspendable by anyone: paying one is a silent burn.
            if (facts.IsWitness && facts.WitnessVersion > 1) return AddressVerdict.UNSPENDABLE_WITNESS;
            if (facts.IsMine) return AddressVerdict.OWN_WALLET;
            if (confirmTail != null && !ConfirmationMatches(normalized, confirmTail))
                return AddressVerdict.CONFIRMATION_MISMATCH;
            return AddressVerdict.OK;
        }

        public static bool ConfirmationMatches(string address, string typed)
        {
            if (address == null || typed == null) return false;
            string tail = address.Length <= CONFIRM_TAIL_LENGTH
                ? address
                : address.Substring(address.Length - CONFIRM_TAIL_LENGTH);
            // Bech32 is case-insensitive as an encoding; a user reading six
            // characters off a screen should not be failed for capitalisation.
            return string.Equals(typed.Trim(), tail, StringComparison.OrdinalIgnoreCase);
        }

        public static string ShortAddress(string address)
        {
            if (string.IsNullOrEmpty(address) || address.Length <= 12) return address ?? "";
            return address.Substring(0, 6) + "…" + address.Substring(address.Length - 6);
        }

        // ---------------------------------------------------------------- estimate

        /**
         * How long until the next forward, from OBSERVED spacing.
         *
         * Never from nPowTargetSpacing: the target is 600 s and the measured
         * value is 815-868 s, so the target understates every estimate by ~40%.
         *
         * @param bestImmatureConfirmations confirmations on the immature
         *   coinbase that is closest to maturity, or -1 when there is none.
         * @return milliseconds, or -1 when it cannot honestly be computed.
         */
        public static long EtaMs(long bestImmatureConfirmations, double observedSpacingSec)
        {
            if (bestImmatureConfirmations < 0 || observedSpacingSec <= 0.0) return -1L;
            long remaining = COINBASE_SWEEP_DEPTH - bestImmatureConfirmations;
            if (remaining <= 0) return 0L;
            return (long)(remaining * observedSpacingSec * 1000.0);
        }

        // ---------------------------------------------------------- record codec

        /**
         * The record as ONE JSON blob.
         *
         * One blob in one key, deliberately: a single write is atomic, whereas
         * a field per key would be several writes and a kill between them leaves
         * a record that is internally inconsistent - a txid with no hex - which
         * is worse than no record at all, because the recovery path would then
         * act on half a fact.
         */
        public static string RecordToJson(SweepRecord r)
        {
            var sb = new StringBuilder();
            sb.Append("{\"txid\":").Append(Json.Quote(r.Txid));
            sb.Append(",\"hex\":").Append(Json.Quote(r.Hex));
            sb.Append(",\"inputs\":[");
            for (int i = 0; i < r.Inputs.Count; i++)
            {
                if (i > 0) sb.Append(',');
                sb.Append("{\"txid\":").Append(Json.Quote(r.Inputs[i].Txid))
                  .Append(",\"vout\":").Append(r.Inputs[i].Vout.ToString(CultureInfo.InvariantCulture)).Append('}');
            }
            sb.Append(']');
            sb.Append(",\"amountSat\":").Append(r.AmountSat.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"feeSat\":").Append(r.FeeSat.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"address\":").Append(Json.Quote(r.Address));
            sb.Append(",\"state\":").Append(Json.Quote(r.State.ToString()));
            sb.Append(",\"kind\":").Append(Json.Quote(r.Kind.ToString()));
            sb.Append(",\"createdAtMs\":").Append(r.CreatedAtMs.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"broadcastAtMs\":").Append(r.BroadcastAtMs.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"attempts\":").Append(r.Attempts.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"lastAttemptMs\":").Append(r.LastAttemptMs.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"lastError\":").Append(Json.Quote(r.LastError ?? ""));
            sb.Append(",\"conflictSeenAtMs\":").Append(r.ConflictSeenAtMs.ToString(CultureInfo.InvariantCulture));
            sb.Append('}');
            return sb.ToString();
        }

        /**
         * Parse a stored record. THROWS on anything it cannot make whole sense
         * of, which the caller turns into "parked", never into "no record".
         */
        public static SweepRecord RecordFromJson(string json)
        {
            object parsed = Json.Parse(json);              // throws on malformed JSON
            var r = new SweepRecord();
            r.Txid = Json.Str(parsed, "txid") ?? "";
            r.Hex = Json.Str(parsed, "hex") ?? "";
            // A record with no txid or no hex is not a record: it cannot be
            // resolved and it cannot be re-broadcast. Refuse to parse it rather
            // than hand back something half-true.
            if (r.Txid.Trim().Length == 0 || r.Hex.Trim().Length == 0)
                throw new FormatException("record is incomplete");

            var arr = Json.Arr(Json.Field(parsed, "inputs"));
            if (arr != null)
            {
                foreach (var e in arr)
                {
                    string txid = Json.Str(e, "txid");
                    if (txid == null) continue;
                    double? v = Json.Number(e, "vout");
                    r.Inputs.Add(new Outpoint(txid, v.HasValue ? (int)v.Value : -1));
                }
            }
            r.AmountSat = (long)(Json.Number(parsed, "amountSat") ?? -1.0);
            r.FeeSat = (long)(Json.Number(parsed, "feeSat") ?? -1.0);
            r.Address = Json.Str(parsed, "address") ?? "";
            r.State = ParseSweepState(Json.Str(parsed, "state"));
            r.Kind = string.Equals(Json.Str(parsed, "kind"), "PROBE", StringComparison.Ordinal)
                ? SweepKind.PROBE : SweepKind.SWEEP;
            r.CreatedAtMs = (long)(Json.Number(parsed, "createdAtMs") ?? 0.0);
            r.BroadcastAtMs = (long)(Json.Number(parsed, "broadcastAtMs") ?? 0.0);
            r.Attempts = (int)(Json.Number(parsed, "attempts") ?? 0.0);
            r.LastAttemptMs = (long)(Json.Number(parsed, "lastAttemptMs") ?? 0.0);
            r.LastError = Json.Str(parsed, "lastError") ?? "";
            r.ConflictSeenAtMs = (long)(Json.Number(parsed, "conflictSeenAtMs") ?? 0.0);
            return r;
        }

        //! An unrecognised state falls back to BROADCASTING, the state that
        //! resolves everything from scratch and clears nothing.
        static SweepState ParseSweepState(string name)
        {
            if (name != null)
            {
                foreach (SweepState s in Enum.GetValues(typeof(SweepState)))
                    if (string.Equals(s.ToString(), name, StringComparison.Ordinal)) return s;
            }
            return SweepState.BROADCASTING;
        }

        /**
         * An unrecognised persisted value means a downgrade or a corrupted
         * file. Fall back to HOLDING: the state that sends nothing.
         */
        public static ForwardState ParseForwardState(string name)
        {
            if (name != null)
            {
                foreach (ForwardState s in Enum.GetValues(typeof(ForwardState)))
                    if (string.Equals(s.ToString(), name, StringComparison.Ordinal)) return s;
            }
            return ForwardState.HOLDING;
        }

        /** PCN as the node reports it, to satoshi. */
        public static long ToSat(double coins)
        {
            return (long)Math.Round(coins * 1e8, MidpointRounding.AwayFromZero);
        }
    }
}
