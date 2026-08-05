// Copyright (c) 2026 The PCoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.
//
// Automatic forwarding of mined coins to an address the user chose.
//
// A port of the Android app's ForwardEngine.kt. Driven by the tray's existing
// one-second timer - there is deliberately no second scheduler and no separate
// timer. A timer decoupled from the chain can fire in the middle of a reorg or
// a resync, where whatever it computes is meaningless; the one event that can
// change the answer is a new block, and the tray already reads the height every
// five seconds. See ForwardPolicy.ShouldEvaluate.
//
// Everything that DECIDES lives in ForwardPolicy and is exercised with no node
// by PCoinTray.exe --selftest. This file is the plumbing: it gathers readings,
// drives the RPCs in the one order that is safe, and persists.
//
// The three rules that make this safe, and the reason each exists:
//
//  - R1. A signed transaction is built AT MOST ONCE. After that, only the
//    STORED hex is ever re-broadcast. Verified in node/transaction.cpp:
//    re-submitting a hex already in the mempool re-announces without
//    resubmitting, and one already confirmed returns ALREADY_IN_UTXO_SET
//    (RPC -27) before doing anything. There is no path by which re-sending
//    produces a second payment; a REBUILD is the one thing that could.
//  - R2. The record is written to disk BEFORE the broadcast and cleared only
//    on a terminal, node-confirmed outcome.
//  - R3. An RPC that fails, times out, or says "not found" resolves NOTHING.
//    It cannot advance a record, clear one, or authorise a build.
//
// Everything here is scoped to the payout wallet - the wallet mining is
// actually being paid into, which the tray already persists as `addresswallet`
// in pcoin-tray.cfg. No OTHER wallet is ever read or spent from. Every
// wallet-scoped call passes it explicitly: with two wallets loaded, asking the
// wrong one whether it owns an address gets a confident, authoritative-looking
// "no" (CLAUDE.md section 7.10).
//
// bitcoin-cli is never used anywhere on this path. A 13 kB transaction hex on a
// command line is visible in the Windows process list, Windows caps a command
// line at 32k, and `bitcoin-cli getwalletinfo` fails outright once more than one
// wallet is loaded - a failure that has already once read as "no wallet is
// open". RPC over loopback only.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;

namespace PCoinTray
{
    /** An RPC that did not succeed, with enough detail to tell WHY not. */
    class RpcFailure : Exception
    {
        /** The JSON-RPC error code, when the node answered with one. */
        public readonly int? Code;
        /** True when nothing reached the node at all. Resolves nothing. */
        public readonly bool Transport;

        public RpcFailure(string message, int? code, bool transport)
            : base(message ?? "the node did not answer")
        {
            Code = code;
            Transport = transport;
        }
    }

    /** The chain readings one evaluation needs, from the tray's own poll. */
    class NodeStats
    {
        public long Height = -1;
        public long Headers = -1;
        public bool InitialBlockDownload;
        /** getblockchaininfo.time - the tip's own timestamp, seconds. */
        public long TipTimeSec;
    }

    /**
     * What the tray and the window display. Rebuilt on every publish.
     *
     * The intent fields (State, Address, ProbeConfirmed) are properties of the
     * install and survive the node going away; the sweep fields are live
     * readings and go back to unknown, rather than sitting on screen next to a
     * dead node as though they were still being updated.
     */
    class ForwardStatus
    {
        public ForwardState State = ForwardState.HOLDING;
        public string Address = "";
        /** Why nothing is being forwarded right now. Shown verbatim. */
        public string Blocked = "";
        public bool HasSweep;
        public SweepKind SweepKind = SweepKind.SWEEP;
        public SweepState SweepState = SweepState.BROADCASTING;
        public long SweepAmountSat = -1;
        public string SweepAddress = "";
        /** -1 means the node could not be asked, which is NOT zero. */
        public int SweepConfirmations = -1;
        /** Value of the vetted candidate set, i.e. what a sweep would move. */
        public long SweepableSat = -1;
        /** Milliseconds until the next coinbase matures. -1 when unknowable. */
        public long EtaMs = -1;
        public bool ProbeConfirmed;
        public bool ProbeAcked;
        public string Error = "";
        public bool HasRecord;
        // History, from persisted intent rather than a live read, so it stays
        // on screen across restarts and does not vanish because a query failed.
        public string LastTxid = "";
        public long LastAmountSat = -1;
        public long LastAtMs;
        public string LastAddress = "";
    }

    class ForwardEngine
    {
        /** RPC_INVALID_ADDRESS_OR_KEY: the definite "I have never seen it". */
        const int RPC_INVALID_ADDRESS_OR_KEY = -5;

        /** RPC_VERIFY_ALREADY_IN_UTXO_SET: it confirmed. */
        const int RPC_ALREADY_IN_UTXO_SET = -27;

        const int RPC_TIMEOUT_MS = 30000;
        const int LIST_TIMEOUT_MS = 30000;
        const int BUILD_TIMEOUT_MS = 60000;

        /** How far back to look for an unconfirmed outgoing wallet transaction. */
        const int ADOPT_SCAN = 100;

        /** gettransaction calls per batched HTTP round trip. */
        const int BATCH_SIZE = 50;

        const long SPACING_WINDOW = 100L;
        const long SPACING_CACHE_MS = 60 * 60000L;

        /** Consecutive failed evaluations before the user is told. Never 1. */
        const int STUCK_AFTER_FAILURES = 3;

        /** Re-entries allowed into ResolveRecord from the -27 recovery path. */
        const int MAX_RESOLVE_DEPTH = 2;

        static readonly DateTime EPOCH = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);

        /**
         * Wall clock, not a tick count.
         *
         * Every interval this file measures is compared against a PERSISTED
         * timestamp, so Environment.TickCount (which wraps at 49.7 days) and the
         * Stopwatch the rate graph uses are both wrong here. Sleep, hibernate
         * and NTP corrections can still move it; every difference taken from it
         * is clamped at zero, which can only ever delay a re-announce.
         */
        public static long NowMs() { return (long)(DateTime.UtcNow - EPOCH).TotalMilliseconds; }

        readonly RpcClient _rpc;
        readonly ForwardStore _store;
        readonly Func<string> _payoutWallet;
        readonly Action<string, string, bool> _notify;   // title, body, important
        readonly Action _changed;                        // ask the tray to redraw

        /**
         * Serialises the user's stored forwarding INTENT against the moment a
         * transaction is committed to.
         *
         * The settings dialog and the engine share a process, so the address the
         * engine read at the top of an evaluation can be replaced by the user
         * while a build is running - `sendall` alone may take up to a minute.
         * Without this, Save would see no record yet, take the "nothing in
         * flight" branch and overwrite the address, and the build in progress
         * would then pay the OLD one and report it as done; "stop forwarding"
         * would likewise be defeated by a sweep that went out afterwards.
         *
         * Held only across a re-read plus a store write on both sides - NEVER
         * across an RPC - so the UI thread is never blocked on the network.
         * Whichever side takes it first wins cleanly: the dialog first means the
         * engine sees the change and abandons an unsent transaction; the engine
         * first means the record exists, so the dialog queues the new address
         * instead of applying it.
         */
        public static readonly object INTENT_LOCK = new object();

        /**
         * Serialises everything in THIS process that talks to the wallet.
         *
         * Bring-up reconciliation runs on the startup thread while a worker
         * started before the last node failure could still be finishing. Two
         * concurrent paths through the send logic is exactly the shape that
         * builds a second transaction, so they take turns.
         */
        readonly object _workLock = new object();

        /**
         * Serialises evaluations ACROSS PROCESSES.
         *
         * The tray's single-instance mutex is session-scoped (PCoinTray.cs:109,
         * no `Global\` prefix), so fast user switching or an RDP session gives
         * two interactive sessions, two tray processes, and therefore two
         * forwarding engines over ONE wallet, ONE record file and ONE UTXO set.
         * Android has one process and an in-process lock, so this failure mode
         * does not exist there. CLAUDE.md section 7.3 records this same mutex
         * scoping already causing a two-copies-fighting incident once.
         *
         * Failing to acquire it means another instance is evaluating, and the
         * tick simply SKIPS - the same skip-not-queue rule the debounce uses.
         */
        readonly Mutex _machineLock;
        readonly bool _machineLockIsGlobal;

        long _lastEvaluatedHeight = -1;
        long _lastEvaluationMs;

        /**
         * Startup reconciliation has run against the CURRENT node.
         *
         * Cleared on every bring-up and whenever the node goes away. Until it is
         * true no build is permitted, which is what stops a freshly-wiped
         * install from sweeping coins already committed to an in-flight
         * transaction.
         */
        volatile bool _reconciled;

        /** An evaluation is in progress on the worker below. 0 or 1. */
        int _busy;

        volatile bool _alive = true;
        volatile bool _evaluationRequested;
        volatile bool _reconcileRequested;

        /** Observed spacing over the last 100 blocks, seconds. Re-read hourly. */
        double _observedSpacingSec;
        long _spacingReadAtMs;

        /** So the "forwarding is stuck" notification fires once, not every tick. */
        bool _stuckNotified;
        bool _probeAckNotified;

        /**
         * True when a record exists on disk but could not be parsed.
         *
         * Checked before anything is allowed to build. An unparseable record
         * must NOT read as "no record": that would authorise a build over coins
         * that may already be committed to a transaction we can no longer see.
         * It parks forwarding instead, and the user gets a Clear button behind
         * the unlock gate in the forwarding dialog.
         */
        bool _recordUnreadable;

        volatile ForwardStatus _status = new ForwardStatus();
        public ForwardStatus Status { get { return _status; } }

        public ForwardStore Store { get { return _store; } }

        /** True while a worker is holding wallet locks inside the node. */
        public bool IsEvaluating() { return Interlocked.CompareExchange(ref _busy, 0, 0) != 0; }

        public ForwardEngine(RpcClient rpc, ForwardStore store, Func<string> payoutWallet,
                             Action<string, string, bool> notify, Action changed)
        {
            _rpc = rpc;
            _store = store;
            _payoutWallet = payoutWallet;
            _notify = notify ?? delegate(string a, string b, bool c) { };
            _changed = changed ?? delegate { };
            _machineLock = OpenMachineLock(out _machineLockIsGlobal);
            PublishFromStore();
        }

        static Mutex OpenMachineLock(out bool global)
        {
            global = false;
            try
            {
                // Everyone, because the two sessions may well be two different
                // Windows accounts and the point is to serialise them.
                var sec = new MutexSecurity();
                sec.AddAccessRule(new MutexAccessRule(
                    new SecurityIdentifier(WellKnownSidType.WorldSid, null),
                    MutexRights.Synchronize | MutexRights.Modify,
                    AccessControlType.Allow));
                bool created;
                var m = new Mutex(false, "Global\\PCoinForwardEngine", out created, sec);
                global = true;
                return m;
            }
            catch { }
            try
            {
                bool created;
                return new Mutex(false, "Local\\PCoinForwardEngine", out created);
            }
            catch { return null; }
        }

        bool EnterMachineLock()
        {
            if (_machineLock == null) return true;       // no cross-process guard available
            try { return _machineLock.WaitOne(2000, false); }
            catch (AbandonedMutexException) { return true; }   // the holder died; we own it now
            catch { return false; }
        }

        void ExitMachineLock()
        {
            if (_machineLock == null) return;
            try { _machineLock.ReleaseMutex(); } catch { }
        }

        // ------------------------------------------------------------- lifecycle

        /**
         * Called at the end of every node bring-up, before the first tick.
         *
         * Runs reconciliation: an interrupted send has to be resolved before
         * anything is allowed to build. Never throws - forwarding failing must
         * never be able to stop this PC mining.
         */
        public void OnNodeReady(HashSet<string> loadedWallets)
        {
            _reconciled = false;
            _lastEvaluatedHeight = -1L;
            _lastEvaluationMs = 0L;
            lock (_workLock)
            {
                if (!EnterMachineLock())
                {
                    // Another instance is mid-evaluation. `_reconciled` stays
                    // false, so the next tick tries again.
                    return;
                }
                try
                {
                    _store.Reload();
                    Reconcile(loadedWallets);
                    _reconciled = true;
                }
                catch (Exception ex)
                {
                    Log("reconciliation failed, forwarding stays parked: " + Short(ex));
                    Publish(ForwardBlock.NODE_NOT_READY);
                }
                finally { ExitMachineLock(); }
            }
        }

        /** The node went away; nothing that follows may be trusted until re-checked. */
        public void OnNodeLost()
        {
            _reconciled = false;
            PublishFromStore();
        }

        /** "Stop mining and exit", or a Windows logoff. */
        public void Shutdown() { _alive = false; }

        public void RequestEvaluation() { _evaluationRequested = true; }

        /**
         * Ask for a FULL reconcile on the next tick.
         *
         * Set when forwarding is first armed: the bring-up reconciliation
         * short-circuits for an install that has never forwarded, and "settings
         * wiped, wallet DB survived" looks exactly like that install - so
         * adoption and stale-lock release have to be re-run at the moment an
         * address appears, which is the first moment they could matter.
         */
        public void RequestReconcile() { _reconcileRequested = true; _evaluationRequested = true; }

        /**
         * One tick of the tray's control loop.
         *
         * Cheap on almost every call: it compares the height it was given
         * against the height it last evaluated at and usually returns
         * immediately. Never throws, and never runs the work on the UI thread -
         * `sendall` alone can take a minute.
         */
        public void OnTick(NodeStats stats, HashSet<string> loadedWallets, bool alive)
        {
            if (!alive || !_alive) return;
            long now = NowMs();
            if (!ForwardPolicy.ShouldEvaluate(stats.Height, _lastEvaluatedHeight, now,
                                              _lastEvaluationMs, _evaluationRequested))
            {
                return;
            }
            // A previous evaluation is still running. Skipping rather than
            // queueing is deliberate: the next block schedules another one, and
            // a queue of stale evaluations is a queue of decisions made on old
            // numbers. Claimed atomically, so "I am the one worker" is a fact
            // and not a race two callers could both win.
            if (Interlocked.CompareExchange(ref _busy, 1, 0) != 0) return;
            _evaluationRequested = false;
            _lastEvaluatedHeight = stats.Height;
            _lastEvaluationMs = now;

            var t = new Thread(delegate()
            {
                try
                {
                    lock (_workLock)
                    {
                        if (!EnterMachineLock()) return;
                        try { RunEvaluation(stats, loadedWallets, alive && _alive); }
                        finally { ExitMachineLock(); }
                    }
                }
                catch { }
                finally { Interlocked.Exchange(ref _busy, 0); }
            })
            { IsBackground = true, Name = "pcoin-forward" };
            t.Start();
        }

        void RunEvaluation(NodeStats stats, HashSet<string> loadedWallets, bool alive)
        {
            try
            {
                // The file, not this process's memory, is the authority: a
                // second tray in another session shares it.
                _store.Reload();

                if (!_reconciled || _reconcileRequested)
                {
                    // A bring-up whose reconciliation failed retries here rather
                    // than leaving forwarding dead until the next node restart.
                    Reconcile(loadedWallets);
                    _reconciled = true;
                    _reconcileRequested = false;
                }
                Evaluate(stats, loadedWallets, alive);
                _store.ConsecutiveFailures = 0;
                _stuckNotified = false;
            }
            catch (Exception ex)
            {
                // Redacted: this string reaches the UI and a balloon, and the
                // node echoes offending input back inside its error text.
                string why = Short(ex);
                Log("forward evaluation failed: " + why);
                int failures = _store.ConsecutiveFailures + 1;
                _store.Batch(delegate
                {
                    _store.LastError = why;
                    _store.ConsecutiveFailures = failures;
                });
                // Never on the first failure: a PC with one peer on a chain
                // producing a block every twenty-odd minutes fails transiently
                // all the time, and a notification for that would be noise the
                // user learns to ignore - which is worse than no notification.
                if (failures >= STUCK_AFTER_FAILURES && !_stuckNotified)
                {
                    _stuckNotified = true;
                    _notify("Forwarding is stuck", why + " Your coins are safe in this wallet.", true);
                }
                _changed();
            }
        }

        // -------------------------------------------------------- reconciliation

        /**
         * Runs on every bring-up, before any build is permitted.
         *
         * Three steps, in this order, and the order is the point: resolve what
         * we know about, then adopt what the WALLET knows about but we do not,
         * and only when both say there is nothing in flight release the locks.
         */
        void Reconcile(HashSet<string> loadedWallets)
        {
            // Nothing has ever been sent and nothing is configured, so there is
            // genuinely nothing to reconcile. Checked first so that an install
            // which never turned forwarding on - the overwhelmingly common case
            // - does not report failures, or notify about them, for a feature it
            // is not using.
            if (!_store.Unreadable && _store.State == ForwardState.HOLDING && !_store.HasRecord)
            {
                Publish(ForwardBlock.HOLDING);
                return;
            }

            string wallet = Wallet();
            if (!loadedWallets.Contains(wallet))
            {
                // Not evidence of anything - and specifically NOT evidence that
                // nothing is in flight. Throwing leaves `_reconciled` false, so
                // no build is permitted until the wallet can actually be asked.
                // Returning normally here would let a later evaluation build a
                // sweep having never run adoption.
                Publish(ForwardBlock.WALLET_NOT_LOADED);
                throw new RpcFailure("the payout wallet is not loaded", null, true);
            }

            SweepRecord record = ReadRecord();
            if (_recordUnreadable)
            {
                Publish(ForwardBlock.PENDING_SWEEP);
                return;
            }
            if (record != null && !record.Terminal)
            {
                Log("reconciling " + record.Kind + " " + Head(record.Txid) + " in " + record.State);
                ResolveRecord(record, wallet, 0);
                return;
            }
            if (record != null)
            {
                // Terminal but never cleared - a kill between marking and
                // clearing.
                ClearRecord();
            }

            // Step 2. Covers "settings wiped, wallet DB survived". Without it a
            // freshly-wiped install would immediately build a SECOND sweep over
            // coins already committed to an in-flight transaction.
            SweepRecord adopted = AdoptInFlightSend(wallet);
            if (adopted != null)
            {
                Log("adopted an in-flight wallet send " + Head(adopted.Txid) + "; no build until it settles");
                WriteRecord(adopted);
                Publish(ForwardBlock.PENDING_SWEEP, adopted, -1, -1, -1);
                return;
            }

            // Step 3. No record and nothing in flight, so any persistent lock
            // left behind belongs to a record that no longer exists. Releasing
            // it is self-healing and removes the only downside of locking at all.
            ReleaseStaleLocks(wallet);
        }

        /**
         * An unconfirmed outgoing transaction the wallet knows about and we do
         * not.
         *
         * Returns a record to adopt at BROADCAST, or null when the wallet
         * definitely has nothing in flight. THROWS when it could not be asked -
         * an unanswerable question must not read as "nothing in flight".
         */
        SweepRecord AdoptInFlightSend(string wallet)
        {
            var list = Json.Arr(Call(wallet, "listtransactions",
                "[\"*\"," + ADOPT_SCAN.ToString(CultureInfo.InvariantCulture) + ",0,true]", RPC_TIMEOUT_MS));
            if (list == null)
            {
                // Not an answer. Throwing keeps `_reconciled` false, so no build
                // is permitted until the question has actually been answered -
                // "the node gave us something unexpected" is not "nothing is in
                // flight".
                throw new RpcFailure("listtransactions did not return a list", null, true);
            }

            foreach (var tx in list)
            {
                if (!string.Equals(Json.Str(tx, "category"), "send", StringComparison.Ordinal)) continue;
                double? conf = Json.Number(tx, "confirmations");
                if ((conf.HasValue ? (int)conf.Value : 1) > 0) continue;
                bool? abandoned = Json.Bool(tx, "abandoned");
                if (abandoned.HasValue && abandoned.Value) continue;
                string txid = Json.Str(tx, "txid");
                if (string.IsNullOrEmpty(txid)) continue;

                // No hex was ever stored for this one (it predates the record),
                // so recover it from the wallet - the one case where
                // gettransaction is the right source, because the wallet
                // demonstrably has it.
                var full = Json.Obj(Call(wallet, "gettransaction",
                    "[" + Json.Quote(txid) + ",false,true]", RPC_TIMEOUT_MS));
                if (full == null) continue;
                string hex = Json.Str(full, "hex");
                if (string.IsNullOrEmpty(hex)) continue;

                DecodedTx decoded = Decode(hex);
                // Whatever does not come back to us is what was being paid.
                long paidSat = 0;
                string paidTo = "";
                foreach (var o in decoded.Outputs)
                {
                    if (string.IsNullOrEmpty(o.Address)) continue;
                    if (IsMine(wallet, o.Address)) continue;
                    paidSat += o.ValueSat;
                    if (paidTo.Length == 0) paidTo = o.Address;
                }
                long now = NowMs();
                return new SweepRecord
                {
                    Txid = txid,
                    Hex = hex,
                    Inputs = decoded.Inputs,
                    AmountSat = paidSat,
                    FeeSat = -1L,
                    Address = paidTo,
                    State = SweepState.BROADCAST,
                    Kind = string.Equals(txid, _store.ProbeTxid, StringComparison.Ordinal)
                        ? SweepKind.PROBE : SweepKind.SWEEP,
                    CreatedAtMs = now,
                    BroadcastAtMs = now,
                };
            }
            return null;
        }

        void ReleaseStaleLocks(string wallet)
        {
            List<object> locked;
            try { locked = Json.Arr(Call(wallet, "listlockunspent", "[]", RPC_TIMEOUT_MS)); }
            catch (RpcFailure) { return; }
            if (locked == null || locked.Count == 0) return;

            var sb = new StringBuilder("[true,[");
            for (int i = 0; i < locked.Count; i++)
            {
                string txid = Json.Str(locked[i], "txid");
                double? vout = Json.Number(locked[i], "vout");
                if (txid == null || !vout.HasValue) continue;
                if (sb[sb.Length - 1] != '[') sb.Append(',');
                sb.Append("{\"txid\":").Append(Json.Quote(txid))
                  .Append(",\"vout\":").Append(((int)vout.Value).ToString(CultureInfo.InvariantCulture)).Append('}');
            }
            sb.Append("]]");
            Log("releasing " + locked.Count + " stale lock(s) left by a record that no longer exists");
            try { Call(wallet, "lockunspent", sb.ToString(), RPC_TIMEOUT_MS); }
            catch (RpcFailure e) { Log("lock release failed: " + e.Message); }
        }

        // ------------------------------------------------------------- evaluation

        void Evaluate(NodeStats stats, HashSet<string> loadedWallets, bool alive)
        {
            string wallet = Wallet();

            // A non-terminal record is resolved and nothing else happens. One
            // transaction at a time, always.
            //
            // Checked BEFORE the user's forwarding state, deliberately: someone
            // can switch forwarding off while a sweep is in flight, and that
            // transaction still has to be followed to a conclusion. Returning
            // early on HOLDING would strand it - its inputs locked forever, its
            // outcome never recorded, and the payment invisible in the app that
            // made it.
            SweepRecord record = ReadRecord();
            if (_recordUnreadable)
            {
                Publish(ForwardBlock.PENDING_SWEEP);
                return;
            }
            if (record != null && !record.Terminal)
            {
                ResolveRecord(record, wallet, 0);
                return;
            }
            if (record != null) ClearRecord();

            // Only now that nothing is in flight may a queued address change
            // take effect: the in-flight transaction pays the OLD address and
            // has to be allowed to complete rather than be reasoned about
            // mid-send.
            //
            // BEFORE the HOLDING check, not after. A user can stop forwarding
            // while a sweep is in flight and then save a new address; the dialog
            // says "saved (queued)", but the state is HOLDING, and returning
            // here first would strand that address permanently - invisible in a
            // UI that only renders the live address, and never applied.
            ApplyPendingAddress();

            // Persisted intent. HOLDING is the common case and a complete answer.
            ForwardState state = _store.State;
            if (state == ForwardState.HOLDING)
            {
                Publish(ForwardBlock.HOLDING);
                return;
            }

            // Arming is automatic once the node has confirmed the test payment.
            //
            // This used to also require a human "I received it". That was dropped
            // deliberately: on a fleet the operator watches the destination
            // wallet anyway, and a payment that stops arriving is noticed within
            // minutes, so the click bought a one-off confirmation at the cost of
            // every machine needing someone physically at it before it could
            // forward anything.
            //
            // What is LOST by not asking, stated plainly so nobody assumes it is
            // still covered: a confirmed probe proves the transaction reached the
            // chain paying that script. It does NOT prove anyone holds the key.
            // A mistyped-but-valid address has a good checksum, passes
            // validateaddress and confirms identically. The 1 PCN probe is still
            // sent and still has to confirm, so it remains a live canary for the
            // build/sign/broadcast path and for an address the network rejects --
            // but "these coins are spendable by me" is now the operator's
            // observation, not something this code establishes.
            if (state == ForwardState.PROBING_SENT && _store.ProbeConfirmed)
            {
                _store.State = ForwardState.ARMED;
                state = ForwardState.ARMED;
                Log("forwarding armed (probe confirmed)");
            }

            string destination = _store.Address;
            if (string.IsNullOrEmpty(destination))
            {
                // An address-less non-HOLDING state should not exist, but if the
                // value was lost the only safe reading is "hold".
                _store.State = ForwardState.HOLDING;
                Publish(ForwardBlock.HOLDING);
                return;
            }

            bool walletLoaded = loadedWallets.Contains(wallet) && WalletAnswers(wallet);
            // Re-validated on EVERY evaluation, one round trip, because it
            // catches a corrupted or truncated value before it is used as a
            // payment destination. Failure parks forwarding; it never rewrites
            // the address.
            AddressFacts facts = walletLoaded ? AddressFactsFor(destination, wallet) : null;
            bool destinationValid = facts != null && facts.IsValid &&
                                    !(facts.IsWitness && facts.WitnessVersion > 1);

            List<Utxo> candidates = (walletLoaded && destinationValid)
                ? VettedCandidates(wallet) : new List<Utxo>();

            var conditions = new ForwardConditions
            {
                Alive = alive,
                ForwardState = state,
                RecordNonTerminal = false,
                NodeAnswered = stats.Height >= 0 && stats.Headers >= 0,
                InitialBlockDownload = stats.InitialBlockDownload,
                Height = stats.Height,
                Headers = stats.Headers,
                TipTimeSec = stats.TipTimeSec,
                NowMs = NowMs(),
                RelayPeers = RelayPeers(),
                PayoutWalletLoaded = walletLoaded,
                DestinationValid = destinationValid,
                SweepableSat = ForwardPolicy.TotalSat(candidates),
                CandidateCount = candidates.Count,
                ProbeCandidateSat = candidates.Count > 0 ? candidates[0].AmountSat : 0L,
            };

            ForwardDecision decision = ForwardPolicy.Decide(conditions);
            long eta = EstimateNextForward(wallet, stats.Height);

            if (!decision.Clear)
            {
                if (decision.Block == ForwardBlock.ADDRESS_PARKED && facts != null)
                    Log("forwarding parked: destination no longer validates (" + facts.NodeError + ")");
                Publish(decision.Block, null, -1, conditions.SweepableSat, eta);
                return;
            }

            if (decision.Action == ForwardAction.SWEEP)
            {
                BuildAndSend(SweepKind.SWEEP, candidates, destination, facts, wallet, state);
            }
            else if (decision.Action == ForwardAction.PROBE)
            {
                var one = new List<Utxo>();
                if (candidates.Count > 0) one.Add(candidates[0]);
                BuildAndSend(SweepKind.PROBE, one, destination, facts, wallet, state);
            }
        }

        /** Swaps in an address the user chose while a sweep was in flight. */
        bool ApplyPendingAddress()
        {
            string pending = _store.PendingAddress;
            if (string.IsNullOrEmpty(pending)) return false;
            _store.Batch(delegate
            {
                _store.Address = pending;
                _store.PendingAddress = "";
                // Any change re-probes. A swapped address must not be able to
                // receive a full sweep until someone has confirmed a test
                // payment arrived at it.
                _store.ProbeTxid = "";
                _store.ProbeAcked = false;
                _store.ProbeConfirmed = false;
                _store.State = ForwardState.PROBING_PENDING;
            });
            Log("queued forwarding address applied; re-probing");
            return true;
        }

        // ----------------------------------------------------------- the send path

        /**
         * Build, verify, persist, broadcast. In that order, and the order is
         * what makes a kill at any point recoverable.
         *
         * `sendall` with explicit inputs and `add_to_wallet: false` is the
         * chosen RPC. It returns a fully signed hex WITHOUT broadcasting, which
         * is the inspect-then-commit shape this needs; `sendtoaddress` has no
         * such option and would broadcast before anything could be checked, and
         * `walletcreatefundedpsbt` adds two more interruptible states for no
         * gain when the wallet is also the signer.
         */
        void BuildAndSend(SweepKind kind, List<Utxo> inputs, string destination,
                          AddressFacts facts, string wallet, ForwardState expectedState)
        {
            if (inputs.Count == 0) return;
            long now = NowMs();

            Built built = kind == SweepKind.SWEEP
                ? CallSendAll(inputs, destination, wallet)
                : CallProbeSend(inputs, destination, wallet);
            if (!built.Complete || built.Hex.Length == 0 || built.Txid.Length == 0)
            {
                Abort(kind, "the node did not return a complete signed transaction");
                return;
            }

            // The gate between "built" and "committed". Nothing has been sent
            // and nothing has been written; any failure here leaves the coins
            // exactly where they were, which is the safe direction to fail in.
            DecodedTx decoded = Decode(built.Hex);
            if (kind == SweepKind.PROBE) decoded = AnnotateChange(decoded, wallet, destination);

            string complaint = kind == SweepKind.SWEEP
                ? ForwardPolicy.VerifySweep(decoded, inputs, destination, facts.ScriptPubKey, built.Txid)
                : ForwardPolicy.VerifyProbe(decoded, inputs, destination, facts.ScriptPubKey, built.Txid);
            if (complaint != null)
            {
                Log("forward aborted, assertion failed: " + complaint);
                Abort(kind, "Forward aborted: " + complaint);
                return;
            }

            // One round trip that catches, for example, an input that turned out
            // immature after all - before anything is written to disk or sent.
            string rejection = TestAccept(built.Hex);
            if (rejection != null)
            {
                Abort(kind, "the node would not accept the transaction: " + rejection);
                return;
            }

            DecodedOut paid = decoded.Outputs[0];
            if (kind == SweepKind.PROBE)
            {
                foreach (var o in decoded.Outputs)
                    if (string.Equals(o.Address, destination, StringComparison.Ordinal)) { paid = o; break; }
            }
            long inValue = 0;
            foreach (var u in inputs) inValue += u.AmountSat;
            long outValue = 0;
            foreach (var o in decoded.Outputs) outValue += o.ValueSat;
            long feeSat = inValue - outValue;

            // R2: the record exists on disk BEFORE the broadcast. From here on
            // the only recovery action is re-sending this exact hex.
            var record = new SweepRecord
            {
                Txid = built.Txid,
                Hex = built.Hex,
                Inputs = OutpointsOf(inputs),
                AmountSat = paid.ValueSat,
                FeeSat = feeSat,
                Address = destination,
                State = SweepState.BROADCASTING,
                Kind = kind,
                CreatedAtMs = now,
                Attempts = 1,
                LastAttemptMs = now,
            };

            // The commit point, and the one place the user's intent is re-read.
            //
            // Everything above - sendall (up to 60 s), decoderawtransaction,
            // getaddressinfo, testmempoolaccept - ran against `destination` as it
            // was at the top of this evaluation. The user can replace that
            // address, or press Stop, at any point during it. Nothing has been
            // sent or written yet, so the correct answer to a changed intent is
            // to throw the built transaction away: the coins have not moved and
            // the next evaluation builds again for the new destination.
            //
            // Under INTENT_LOCK so the re-read and the write that makes the send
            // visible to the dialog cannot be interleaved with the dialog's own
            // write. Nothing inside talks to the node.
            lock (INTENT_LOCK)
            {
                if (!string.Equals(_store.Address, destination, StringComparison.Ordinal) ||
                    _store.State != expectedState)
                {
                    Abort(kind, "the forwarding address changed while the transaction was being built");
                    return;
                }
                _store.Batch(delegate
                {
                    WriteRecordLocked(record);
                    if (kind == SweepKind.PROBE)
                    {
                        // Written WITH the record, not after the broadcast. A
                        // kill in between used to leave a record that settled
                        // normally while the state machine still said
                        // PROBING_PENDING, and the next evaluation then sent a
                        // SECOND 1 PCN probe. It also lets AdoptInFlightSend
                        // recognise this txid as a probe rather than announcing
                        // it to the user as a forward.
                        _store.ProbeTxid = record.Txid;
                        _store.State = ForwardState.PROBING_SENT;
                    }
                });
            }

            // Belt, at the wallet layer, for the case where our own file is
            // wiped but the datadir survives. Not the primary guard - the record
            // is - so a failure is logged and does not stop the send.
            LockInputs(wallet, record.Inputs);

            string returned;
            try
            {
                returned = Broadcast(built.Hex);
            }
            catch (RpcFailure e)
            {
                // R3: leave the record at BROADCASTING. The resolver decides on
                // the next evaluation whether it actually landed; concluding "it
                // did not" from a failed call is exactly the bug this design
                // exists to prevent.
                record.LastError = Trim200(e.Message);
                WriteRecord(record);
                Publish(ForwardBlock.PENDING_SWEEP, record, -1, -1, -1);
                throw;
            }

            if (!string.Equals(returned, built.Txid, StringComparison.Ordinal))
            {
                // Should be impossible. Do NOT clear the record: something is
                // very wrong and the record is the only trail.
                Log("broadcast returned a different txid than was built");
                record.LastError = "the node returned a different transaction id";
                WriteRecord(record);
                Publish(ForwardBlock.PENDING_SWEEP, record, -1, -1, -1);
                return;
            }

            record.State = SweepState.BROADCAST;
            record.BroadcastAtMs = NowMs();
            _store.Batch(delegate
            {
                WriteRecordLocked(record);
                _store.LastError = "";
            });
            Log(kind.ToString().ToLowerInvariant() + " broadcast " + Head(record.Txid) +
                " for " + record.AmountSat + " sat");
            Publish(ForwardBlock.PENDING_SWEEP, record, -1, -1, -1);
        }

        void Abort(SweepKind kind, string why)
        {
            Log(kind.ToString().ToLowerInvariant() + " not sent: " + why);
            _store.LastError = Trim200(why);
            Publish(ForwardBlock.NONE);
        }

        class Built
        {
            public bool Complete;
            public string Txid = "";
            public string Hex = "";
        }

        /**
         * `sendall` - "all of it, minus the fee, no change".
         *
         * fee_rate is passed EXPLICITLY, in sat/vB, at the wallet's own required
         * floor of 1.0 (max of m_min_fee 1000 sat/kvB and relayMinFee 100
         * sat/kvB). Inheriting it from `fallbackfee` in pcoin.conf would give the
         * same number today and silently stop doing so the moment this chain has
         * enough fee history for estimatesmartfee to answer.
         *
         * minconf/maxconf/send_max are not passed: all three are documented
         * incompatible with explicit `inputs`.
         */
        Built CallSendAll(List<Utxo> inputs, string destination, string wallet)
        {
            string options = "{\"inputs\":" + InputsJson(inputs) +
                             ",\"add_to_wallet\":false" +
                             ",\"fee_rate\":" + FeeRateJson() +
                             ",\"lock_unspents\":false}";
            string p = "[[" + Json.Quote(destination) + "],null,\"unset\",null," + options + "]";
            return AsBuilt(Call(wallet, "sendall", p, BUILD_TIMEOUT_MS));
        }

        /**
         * `send` for the probe, where an exact amount and change ARE wanted.
         *
         * add_inputs defaults to false when `inputs` are given, so the input set
         * is honoured strictly and the build stays deterministic. Change returns
         * on a wpkh() descriptor the recovery phrase recreates - which is exactly
         * why `changetype=bech32` in pcoin.conf matters here.
         */
        Built CallProbeSend(List<Utxo> inputs, string destination, string wallet)
        {
            string options = "{\"inputs\":" + InputsJson(inputs) +
                             ",\"add_to_wallet\":false" +
                             ",\"fee_rate\":" + FeeRateJson() + "}";
            string p = "[{" + Json.Quote(destination) + ":" + AmountJson(ForwardPolicy.PROBE_SAT) +
                       "},null,\"unset\",null," + options + "]";
            return AsBuilt(Call(wallet, "send", p, BUILD_TIMEOUT_MS));
        }

        static Built AsBuilt(object result)
        {
            var o = Json.Obj(result);
            if (o == null) return new Built();
            bool? complete = Json.Bool(o, "complete");
            return new Built
            {
                Complete = complete.HasValue && complete.Value,
                Txid = Json.Str(o, "txid") ?? "",
                Hex = Json.Str(o, "hex") ?? "",
            };
        }

        //! sat/vB, written with a decimal point so it is unambiguously a number
        //! and never confused with the PCN/kvB unit on the adjacent call.
        static string FeeRateJson()
        {
            return ForwardPolicy.FEE_RATE_SAT_VB.ToString("0.0###", CultureInfo.InvariantCulture);
        }

        //! Satoshi to the PCN string the RPC wants, exactly - eight decimals, no
        //! exponent, no locale. The only place this path leaves integers.
        static string AmountJson(long sat)
        {
            return (sat / 100000000L).ToString(CultureInfo.InvariantCulture) + "." +
                   (sat % 100000000L).ToString("00000000", CultureInfo.InvariantCulture);
        }

        static string InputsJson(List<Utxo> inputs)
        {
            var sb = new StringBuilder("[");
            for (int i = 0; i < inputs.Count; i++)
            {
                if (i > 0) sb.Append(',');
                sb.Append("{\"txid\":").Append(Json.Quote(inputs[i].Txid))
                  .Append(",\"vout\":").Append(inputs[i].Vout.ToString(CultureInfo.InvariantCulture)).Append('}');
            }
            return sb.Append(']').ToString();
        }

        static string OutpointsJson(List<Outpoint> inputs)
        {
            var sb = new StringBuilder("[");
            for (int i = 0; i < inputs.Count; i++)
            {
                if (i > 0) sb.Append(',');
                sb.Append("{\"txid\":").Append(Json.Quote(inputs[i].Txid))
                  .Append(",\"vout\":").Append(inputs[i].Vout.ToString(CultureInfo.InvariantCulture)).Append('}');
            }
            return sb.Append(']').ToString();
        }

        static List<Outpoint> OutpointsOf(List<Utxo> inputs)
        {
            var l = new List<Outpoint>(inputs.Count);
            foreach (var u in inputs) l.Add(u.Outpoint);
            return l;
        }

        /** Returns the reject reason verbatim, or null when the node would take it. */
        string TestAccept(string hex)
        {
            List<object> r;
            try
            {
                r = Json.Arr(Call(null, "testmempoolaccept",
                    "[[" + Json.Quote(hex) + "]," + MaxFeeRateJson() + "]", RPC_TIMEOUT_MS));
            }
            catch (RpcFailure e)
            {
                // A call that failed is itself a rejection here, never a pass.
                return "the node did not answer testmempoolaccept (" + e.Message + ")";
            }
            if (r == null || r.Count == 0) return "the node did not answer testmempoolaccept";
            var first = Json.Obj(r[0]);
            if (first == null) return "the node did not answer testmempoolaccept";
            bool? allowed = Json.Bool(first, "allowed");
            if (allowed.HasValue && allowed.Value) return null;
            string why = Json.Str(first, "reject-reason");
            return string.IsNullOrEmpty(why) ? "rejected without a reason" : why;
        }

        /**
         * `sendrawtransaction`.
         *
         * maxfeerate is 0.0001 PCN/kvB - a different unit from the sat/vB the
         * build used two calls ago, on the same concept. 0.0001 PCN/kvB is
         * 10 sat/vB, i.e. 10x the target, which is the intended headroom.
         * maxburnamount 0 refuses anything paying to an unspendable script.
         */
        string Broadcast(string hex)
        {
            object r = Call(null, "sendrawtransaction",
                "[" + Json.Quote(hex) + "," + MaxFeeRateJson() + ",0]", RPC_TIMEOUT_MS);
            return (r as string) ?? "";
        }

        static string MaxFeeRateJson()
        {
            return ForwardPolicy.BROADCAST_MAX_FEE_RATE.ToString("0.00000000", CultureInfo.InvariantCulture);
        }

        void LockInputs(string wallet, List<Outpoint> inputs)
        {
            try
            {
                // persistent=true: written to the wallet DB, so it survives a
                // node restart. "Unlock is always persistent", so releasing is
                // safe too.
                Call(wallet, "lockunspent", "[false," + OutpointsJson(inputs) + ",true]", RPC_TIMEOUT_MS);
            }
            catch (RpcFailure e)
            {
                Log("could not lock inputs (the record is the real guard): " + e.Message);
            }
        }

        void UnlockInputs(string wallet, List<Outpoint> inputs)
        {
            if (inputs.Count == 0) return;
            try { Call(wallet, "lockunspent", "[true," + OutpointsJson(inputs) + "]", RPC_TIMEOUT_MS); }
            catch (RpcFailure e) { Log("could not unlock inputs: " + e.Message); }
        }

        // ------------------------------------------------------------- resolution

        /**
         * Advances a non-terminal record by exactly what the node could
         * establish.
         *
         * @param depth re-entry count for the ALREADY_IN_UTXO_SET path below,
         *   which calls back into this function. A node giving contradictory
         *   answers (confirmed on chain, unknown to the wallet - a rescan, or a
         *   swapped wallet file) would otherwise recurse until the stack ran out,
         *   and that would be swallowed and counted as a generic "forwarding is
         *   stuck".
         */
        void ResolveRecord(SweepRecord record, string wallet, int depth)
        {
            TxObservation obs = Observe(record.Txid, wallet);
            long now = NowMs();
            switch (ForwardPolicy.Resolve(obs, record, now))
            {
                case Resolution.UNRESOLVED:
                    // Deliberately does nothing at all, including not touching
                    // the record. "Checking" is the honest thing to show.
                    Publish(ForwardBlock.PENDING_SWEEP, record, -1, -1, -1);
                    return;

                case Resolution.REBROADCAST:
                {
                    SweepRecord next = record.Copy();
                    next.Attempts = record.Attempts + 1;
                    next.LastAttemptMs = now;
                    WriteRecord(next);
                    try
                    {
                        Broadcast(record.Hex);
                        // The re-announce clock restarts here. Without this a
                        // record broadcast in the crash window would carry
                        // BroadcastAtMs = 0 forever, and the 30-minute "nobody
                        // has taken it" retry would never come round.
                        next.State = SweepState.BROADCAST;
                        next.BroadcastAtMs = now;
                        WriteRecord(next);
                        Log("re-announced " + Head(record.Txid) + " (attempt " + next.Attempts + ")");
                    }
                    catch (RpcFailure e)
                    {
                        if (!e.Transport && e.Code.HasValue && e.Code.Value == RPC_ALREADY_IN_UTXO_SET)
                        {
                            // It confirmed while we were not looking. Re-query
                            // rather than assume anything about how deep it is -
                            // but only so many times: if the re-query keeps
                            // saying "not in the mempool" while the broadcast
                            // keeps saying "already confirmed", the node is
                            // contradicting itself and the honest answer is to
                            // resolve nothing this time.
                            if (depth >= MAX_RESOLVE_DEPTH)
                            {
                                Log(Head(record.Txid) + ": node reports it both confirmed and absent");
                                Publish(ForwardBlock.PENDING_SWEEP, next, -1, -1, -1);
                                return;
                            }
                            Log(Head(record.Txid) + " is already in the UTXO set; re-checking depth");
                            ResolveRecord(next, wallet, depth + 1);
                            return;
                        }
                        next.LastError = Trim200(e.Message);
                        WriteRecord(next);
                    }
                    Publish(ForwardBlock.PENDING_SWEEP, next, 0, -1, -1);
                    return;
                }

                case Resolution.MARK_BROADCAST:
                    Advance(record, SweepState.BROADCAST, obs.Confirmations, now);
                    return;

                case Resolution.MARK_ACCEPTED:
                    Advance(record, SweepState.ACCEPTED, obs.Confirmations, now);
                    return;

                case Resolution.MARK_CONFIRMED:
                    Advance(record, SweepState.CONFIRMED, obs.Confirmations, now);
                    return;

                case Resolution.MARK_SETTLED:
                    Settle(record, wallet, obs.Confirmations);
                    return;

                case Resolution.NOTE_CONFLICT:
                {
                    // Recorded, never acted on. One reading is not enough: acting
                    // on it builds a second transaction, and being wrong about
                    // that is the most expensive mistake available here.
                    SweepRecord noted = record.Copy();
                    noted.ConflictSeenAtMs = record.ConflictSeenAtMs == 0L ? now : record.ConflictSeenAtMs;
                    WriteRecord(noted);
                    Publish(ForwardBlock.PENDING_SWEEP, record, obs.Confirmations, -1, -1);
                    return;
                }

                case Resolution.MARK_CONFLICTED:
                {
                    Log(Head(record.Txid) + " conflicts with a confirmed transaction, twice over 10 min");
                    UnlockInputs(wallet, record.Inputs);
                    _store.Batch(delegate
                    {
                        _store.RecordJson = "";
                        if (record.Kind == SweepKind.PROBE &&
                            _store.State == ForwardState.PROBING_SENT &&
                            string.Equals(_store.ProbeTxid, record.Txid, StringComparison.Ordinal))
                        {
                            // The test payment was dropped, so it will never
                            // confirm and never be acknowledged. Without this the
                            // state machine waits at PROBE_AWAITING_ACK for a
                            // transaction that no longer exists and forwarding
                            // never starts.
                            _store.ProbeTxid = "";
                            _store.ProbeConfirmed = false;
                            _store.State = ForwardState.PROBING_PENDING;
                        }
                        _store.LastError =
                            "The last forward conflicted with another transaction and was dropped. " +
                            "The coins are still in this wallet and will be forwarded again.";
                    });
                    Publish(ForwardBlock.NONE);
                    return;
                }
            }
        }

        void Advance(SweepRecord record, SweepState state, int confirmations, long nowMs)
        {
            // A record broadcast in the crash window carries BroadcastAtMs = 0,
            // because the write that stamps it comes after the broadcast
            // returns. The re-announce clock is measured from that field, so
            // leaving it at zero means `since` is zero on every future
            // evaluation and the 30-minute "no peer has taken it" retry never
            // arrives. Stamping it at the first observation is late by at most
            // one evaluation, which only ever delays a re-announce - it can
            // never bring one forward.
            SweepRecord next = record.Copy();
            if (state == SweepState.BROADCAST && record.BroadcastAtMs == 0L) next.BroadcastAtMs = nowMs;
            next.State = state;
            if (next.State != record.State || next.BroadcastAtMs != record.BroadcastAtMs) WriteRecord(next);
            Publish(ForwardBlock.PENDING_SWEEP, next, confirmations, -1, -1);
        }

        /**
         * Terminal, and the only place a record is cleared on success.
         *
         * History is written FIRST: if the process dies between the two, a
         * record that is already settled resolves to settled again next time,
         * which is harmless, whereas history lost is a payment the user can no
         * longer see.
         */
        void Settle(SweepRecord record, string wallet, int confirmations)
        {
            UnlockInputs(wallet, record.Inputs);
            if (record.Kind == SweepKind.SWEEP)
            {
                _store.Batch(delegate
                {
                    _store.LastTxid = record.Txid;
                    _store.LastAmountSat = record.AmountSat;
                    _store.LastAtMs = NowMs();
                    _store.LastAddress = record.Address;
                });
                _notify("Forwarded " + ForwardPolicy.CoinsSat(record.AmountSat),
                        "To " + ForwardPolicy.ShortAddress(record.Address) + ". Click to open PCoin Miner.",
                        false);
            }
            else
            {
                // The probe landed. Arming still needs the user to say they can
                // see it - a confirmed payment proves the address accepted
                // coins, not that anyone holds the key.
                //
                // The record is the authority on "a probe was sent", so it also
                // repairs the state machine: an adopted probe, or one killed in
                // the window between writing the record and committing the
                // state, would otherwise settle here while the state still read
                // PROBING_PENDING and the next evaluation would send a second
                // test payment.
                _store.Batch(delegate
                {
                    if (string.IsNullOrEmpty(_store.ProbeTxid)) _store.ProbeTxid = record.Txid;
                    if (_store.State == ForwardState.PROBING_PENDING) _store.State = ForwardState.PROBING_SENT;
                    _store.ProbeConfirmed = true;
                });
                if (!_store.ProbeAcked && !_probeAckNotified)
                {
                    _probeAckNotified = true;
                    _notify("Check your other wallet",
                            "A " + ForwardPolicy.CoinsSat(ForwardPolicy.PROBE_SAT) +
                            " test payment has arrived at " + ForwardPolicy.ShortAddress(record.Address) +
                            ". Confirm you can see it to start forwarding.",
                            true);
                }
            }
            ClearRecord();
            Log(record.Kind.ToString().ToLowerInvariant() + " " + Head(record.Txid) +
                " settled at " + confirmations + " confirmations");
            Publish(ForwardBlock.NONE);
        }

        /**
         * One observation of a recorded transaction.
         *
         * Every failure mode is represented explicitly. A gettransaction that
         * could not be asked is Readable = false and resolves nothing; a
         * gettransaction that ANSWERED "no such transaction" is Readable = true,
         * KnownToWallet = false, which is a real fact and means the broadcast
         * never landed. The distinction between the two is the entire safety
         * property.
         */
        TxObservation Observe(string txid, string wallet)
        {
            var obs = new TxObservation();
            try
            {
                var r = Json.Obj(Call(wallet, "gettransaction", "[" + Json.Quote(txid) + "]", RPC_TIMEOUT_MS));
                if (r != null)
                {
                    obs.Readable = true;
                    obs.KnownToWallet = true;
                    double? c = Json.Number(r, "confirmations");
                    obs.Confirmations = c.HasValue ? (int)c.Value : 0;
                }
            }
            catch (RpcFailure e)
            {
                // -5 is the wallet's definite "I have never seen this txid".
                // Anything else, including every transport failure, leaves
                // Readable false: could not ask, so nothing is evidence.
                if (!e.Transport && e.Code.HasValue && e.Code.Value == RPC_INVALID_ADDRESS_OR_KEY)
                    obs.Readable = true;
            }

            if (obs.Readable && obs.Confirmations <= 0)
            {
                try
                {
                    var m = Json.Obj(Call(null, "getmempoolentry", "[" + Json.Quote(txid) + "]", RPC_TIMEOUT_MS));
                    if (m != null)
                    {
                        obs.MempoolReadable = true;
                        obs.InMempool = true;
                        // The honest "did the network actually take it" signal:
                        // cleared in net_processing at the exact point the TX
                        // message is pushed to a peer that asked for it. A
                        // missing field reads as TRUE - unknown-shaped, not
                        // answer-shaped.
                        bool? u = Json.Bool(m, "unbroadcast");
                        obs.Unbroadcast = !u.HasValue || u.Value;
                    }
                }
                catch (RpcFailure e)
                {
                    if (!e.Transport && e.Code.HasValue && e.Code.Value == RPC_INVALID_ADDRESS_OR_KEY)
                        obs.MempoolReadable = true;
                }
            }
            return obs;
        }

        // -------------------------------------------------------------- gathering

        /** True when the wallet is loaded AND answering right now. */
        bool WalletAnswers(string wallet)
        {
            try { return Call(wallet, "getwalletinfo", "[]", RPC_TIMEOUT_MS) != null; }
            catch (RpcFailure) { return false; }
        }

        /**
         * Peers that would actually accept a transaction from us.
         *
         * getconnectioncount is explicitly not used: a block-relay-only peer
         * never requests our transaction, so a node with only those can
         * broadcast "successfully" to an audience of nobody - and then report a
         * payment the network has never seen.
         *
         * Returns the count, or -1 when the node could not be asked. -1 fails
         * the `>= 1` test, so unknown blocks; it does not pass.
         */
        int RelayPeers()
        {
            try
            {
                var arr = Json.Arr(Call(null, "getpeerinfo", "[]", RPC_TIMEOUT_MS));
                if (arr == null) return -1;
                int n = 0;
                foreach (var p in arr)
                {
                    bool? relay = Json.Bool(p, "relaytxes");
                    if (!relay.HasValue || !relay.Value) continue;
                    if (string.Equals(Json.Str(p, "connection_type"), "block-relay-only", StringComparison.Ordinal))
                        continue;
                    n++;
                }
                return n;
            }
            catch (RpcFailure) { return -1; }
        }

        AddressFacts AddressFactsFor(string address, string wallet)
        {
            try
            {
                // Node-level: works with no wallet loaded, and is the authority
                // on whether the string is a PCoin address at all.
                var v = Json.Obj(Call(null, "validateaddress", "[" + Json.Quote(address) + "]", RPC_TIMEOUT_MS));
                if (v == null) return null;
                bool? valid = Json.Bool(v, "isvalid");
                bool? witness = Json.Bool(v, "iswitness");
                double? version = Json.Number(v, "witness_version");
                return new AddressFacts
                {
                    IsValid = valid.HasValue && valid.Value,
                    IsWitness = witness.HasValue && witness.Value,
                    WitnessVersion = version.HasValue ? (int)version.Value : 0,
                    IsMine = IsMine(wallet, address),
                    NodeError = Json.Str(v, "error") ?? "",
                    ScriptPubKey = Json.Str(v, "scriptPubKey") ?? "",
                };
            }
            catch (RpcFailure) { return null; }
        }

        /** getaddressinfo is wallet-scoped, so it is always aimed at the PAYOUT wallet. */
        bool IsMine(string wallet, string address)
        {
            try
            {
                var o = Json.Obj(Call(wallet, "getaddressinfo", "[" + Json.Quote(address) + "]", RPC_TIMEOUT_MS));
                bool? mine = Json.Bool(o, "ismine");
                return mine.HasValue && mine.Value;
            }
            catch (RpcFailure) { return false; }
        }

        /**
         * The outputs the node will let us spend right now, vetted and ordered.
         *
         * Selection comes from the NODE, so the node enforces maturity; there is
         * no app-side balance guess anywhere on this path.
         *
         * The `generated` flag comes from gettransaction, batched fifty per
         * round trip: listunspent carries no coinbase flag at all, so without it
         * there is no way to tell a 50 PCN block reward (needing depth 107 here)
         * from an ordinary 50 PCN payment (needing 6).
         */
        List<Utxo> VettedCandidates(string wallet)
        {
            var list = Json.Arr(Call(wallet, "listunspent",
                "[" + ForwardPolicy.MIN_DEPTH.ToString(CultureInfo.InvariantCulture) + ",9999999]",
                LIST_TIMEOUT_MS));
            if (list == null) return new List<Utxo>();

            var raw = new List<Utxo>(list.Count);
            foreach (var o in list)
            {
                double? vout = Json.Number(o, "vout");
                double? amount = Json.Number(o, "amount");
                double? conf = Json.Number(o, "confirmations");
                bool? spendable = Json.Bool(o, "spendable");
                bool? safe = Json.Bool(o, "safe");
                raw.Add(new Utxo
                {
                    Txid = Json.Str(o, "txid") ?? "",
                    Vout = vout.HasValue ? (int)vout.Value : -1,
                    AmountSat = ForwardPolicy.ToSat(amount ?? 0.0),
                    Confirmations = (long)(conf ?? 0.0),
                    Spendable = spendable.HasValue && spendable.Value,
                    Safe = safe.HasValue && safe.Value,
                    // Assumed coinbase until proved otherwise: the strict
                    // reading is the one that cannot spend an immature reward.
                    Generated = true,
                });
            }
            if (raw.Count == 0) return new List<Utxo>();

            var txids = new List<string>();
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var u in raw)
                if (u.Txid.Length > 0 && seen.Add(u.Txid)) txids.Add(u.Txid);

            var generated = new Dictionary<string, bool>(StringComparer.Ordinal);
            for (int start = 0; start < txids.Count; start += BATCH_SIZE)
            {
                int n = Math.Min(BATCH_SIZE, txids.Count - start);
                var methods = new List<string>(n);
                var pars = new List<string>(n);
                for (int i = 0; i < n; i++)
                {
                    methods.Add("gettransaction");
                    pars.Add("[" + Json.Quote(txids[start + i]) + "]");
                }
                var results = _rpc.Batch(wallet, methods, pars, LIST_TIMEOUT_MS);
                for (int i = 0; i < n; i++)
                {
                    // A txid we could not read stays "generated", i.e. held to
                    // the stricter 107-confirmation rule. Failing to read must
                    // never relax a maturity check.
                    if (!results[i].Ok) continue;
                    var o = Json.Obj(results[i].Result);
                    if (o == null) continue;
                    bool? g = Json.Bool(o, "generated");
                    generated[txids[start + i]] = g.HasValue && g.Value;
                }
            }

            var usable = new List<Utxo>(raw.Count);
            foreach (var u in raw)
            {
                if (u.Vout < 0 || u.Txid.Length == 0) continue;
                bool g;
                u.Generated = generated.TryGetValue(u.Txid, out g) ? g : true;
                usable.Add(u);
            }
            return ForwardPolicy.VetCandidates(usable);
        }

        /**
         * When the next forward can realistically happen, from OBSERVED spacing.
         *
         * Never from nPowTargetSpacing: the target is 600 s and the measured
         * value on this chain today is far higher, so the target would
         * understate every estimate.
         */
        long EstimateNextForward(string wallet, long height)
        {
            long best;
            try
            {
                var list = Json.Arr(Call(wallet, "listtransactions",
                    "[\"*\"," + ADOPT_SCAN.ToString(CultureInfo.InvariantCulture) + ",0,true]", RPC_TIMEOUT_MS));
                if (list == null) return -1L;
                best = -1L;
                foreach (var tx in list)
                {
                    if (!string.Equals(Json.Str(tx, "category"), "immature", StringComparison.Ordinal)) continue;
                    double? c = Json.Number(tx, "confirmations");
                    if (!c.HasValue) continue;
                    long conf = (long)c.Value;
                    if (conf >= 0 && conf < ForwardPolicy.COINBASE_SWEEP_DEPTH && conf > best) best = conf;
                }
            }
            catch (RpcFailure) { return -1L; }
            return ForwardPolicy.EtaMs(best, ObservedSpacing(height));
        }

        /** Seconds per block over the last 100 blocks, cached for an hour. */
        double ObservedSpacing(long height)
        {
            long now = NowMs();
            if (_observedSpacingSec > 0.0 && Math.Max(0L, now - _spacingReadAtMs) < SPACING_CACHE_MS)
                return _observedSpacingSec;
            if (height < SPACING_WINDOW) return _observedSpacingSec;
            try
            {
                long tip = HeaderTime(height);
                long back = HeaderTime(height - SPACING_WINDOW);
                if (tip <= 0L || back <= 0L || tip <= back) return _observedSpacingSec;
                _observedSpacingSec = (tip - back) / (double)SPACING_WINDOW;
                _spacingReadAtMs = now;
                return _observedSpacingSec;
            }
            catch (RpcFailure) { return _observedSpacingSec; }
        }

        long HeaderTime(long height)
        {
            string hash = Call(null, "getblockhash",
                "[" + height.ToString(CultureInfo.InvariantCulture) + "]", RPC_TIMEOUT_MS) as string;
            if (string.IsNullOrEmpty(hash)) return 0L;
            var h = Json.Obj(Call(null, "getblockheader", "[" + Json.Quote(hash) + "]", RPC_TIMEOUT_MS));
            double? t = Json.Number(h, "time");
            return t.HasValue ? (long)t.Value : 0L;
        }

        // ------------------------------------------------------------- decoding

        DecodedTx Decode(string hex)
        {
            var r = Json.Obj(Call(null, "decoderawtransaction", "[" + Json.Quote(hex) + "]", RPC_TIMEOUT_MS));
            if (r == null) throw new RpcFailure("the node could not decode the transaction it built", null, true);
            var tx = new DecodedTx();
            tx.Txid = Json.Str(r, "txid") ?? "";
            var vin = Json.Arr(Json.Field(r, "vin"));
            if (vin != null)
            {
                foreach (var i in vin)
                {
                    string txid = Json.Str(i, "txid");
                    if (string.IsNullOrEmpty(txid)) continue;
                    double? v = Json.Number(i, "vout");
                    tx.Inputs.Add(new Outpoint(txid, v.HasValue ? (int)v.Value : -1));
                }
            }
            var vout = Json.Arr(Json.Field(r, "vout"));
            if (vout != null)
            {
                foreach (var o in vout)
                {
                    object spk = Json.Field(o, "scriptPubKey");
                    tx.Outputs.Add(new DecodedOut
                    {
                        Address = Json.Str(spk, "address") ?? "",
                        ScriptHex = Json.Str(spk, "hex") ?? "",
                        ValueSat = ForwardPolicy.ToSat(Json.Number(o, "value") ?? 0.0),
                    });
                }
            }
            return tx;
        }

        /**
         * Fills in ismine/ischange for the probe's change output.
         *
         * This is the assertion that catches a mis-built transaction quietly
         * sending 49 PCN of change to a stranger while the 1 PCN test payment
         * looks perfect, so it is worth the extra round trip.
         */
        DecodedTx AnnotateChange(DecodedTx tx, string wallet, string destination)
        {
            foreach (var o in tx.Outputs)
            {
                if (string.Equals(o.Address, destination, StringComparison.Ordinal)) continue;
                if (string.IsNullOrEmpty(o.Address)) continue;
                try
                {
                    var info = Json.Obj(Call(wallet, "getaddressinfo",
                        "[" + Json.Quote(o.Address) + "]", RPC_TIMEOUT_MS));
                    bool? mine = Json.Bool(info, "ismine");
                    bool? change = Json.Bool(info, "ischange");
                    o.IsMine = mine.HasValue && mine.Value;
                    o.IsChange = change.HasValue && change.Value;
                }
                catch (RpcFailure)
                {
                    // Could not ask, so it stays unproved - and an unproved
                    // change output fails the assertion, which is the safe way
                    // round.
                }
            }
            return tx;
        }

        // ------------------------------------------------------------ persistence

        SweepRecord ReadRecord()
        {
            _recordUnreadable = false;
            string json = _store.RecordJson;
            if (string.IsNullOrEmpty(json))
            {
                // A whole file we could not parse might have held a record. It
                // must not read as "no record".
                if (_store.Unreadable)
                {
                    _recordUnreadable = true;
                    _store.LastError =
                        "The record of the last forward could not be read, so nothing new will be sent. " +
                        "Your coins are safe in this wallet.";
                }
                return null;
            }
            try
            {
                return ForwardPolicy.RecordFromJson(json);
            }
            catch (Exception ex)
            {
                _recordUnreadable = true;
                Log("sweep record is unreadable; forwarding is parked: " + ex.GetType().Name);
                _store.LastError =
                    "The record of the last forward could not be read, so nothing new will be sent. " +
                    "Your coins are safe in this wallet.";
                return null;
            }
        }

        void WriteRecord(SweepRecord record) { _store.RecordJson = ForwardPolicy.RecordToJson(record); }

        //! Same, for use inside an already-open store batch.
        void WriteRecordLocked(SweepRecord record) { _store.RecordJson = ForwardPolicy.RecordToJson(record); }

        void ClearRecord() { _store.RecordJson = ""; }

        // ------------------------------------------------------- the user's intent

        /**
         * Save a validated, canonical address as the forwarding destination.
         *
         * If a transaction is in flight the new address is QUEUED rather than
         * applied: the in-flight transaction pays the old address and has to be
         * allowed to complete. A destination cannot be reasoned about halfway
         * through a send.
         *
         * The whole decision runs under INTENT_LOCK, because "is something in
         * flight" and the write that answers it have to be one step.
         *
         * @return true when the address was queued rather than applied.
         */
        public bool StoreAddress(string address)
        {
            bool queued;
            lock (INTENT_LOCK)
            {
                queued = _store.HasRecord;
                if (queued)
                {
                    _store.PendingAddress = address;
                }
                else
                {
                    _store.Batch(delegate
                    {
                        _store.Address = address;
                        _store.PendingAddress = "";
                        // Every change re-probes, including a change made by
                        // someone who sat down at an unlocked PC: a swapped
                        // address cannot receive a full sweep until a test
                        // payment has been acknowledged.
                        _store.ProbeTxid = "";
                        _store.ProbeAcked = false;
                        _store.ProbeConfirmed = false;
                        _store.State = ForwardState.PROBING_PENDING;
                    });
                }
            }
            _store.Batch(delegate
            {
                _store.LastError = "";
                // The reason forwarding was not sending applied to the OLD
                // intent. Leaving it up would tell someone who has just set an
                // address that the app is "holding coins in this wallet". It is
                // derived display, so clearing it is free; the next evaluation
                // republishes whatever is true then.
                _store.BlockedReason = "";
            });
            _probeAckNotified = false;
            // Evaluate now rather than at the next block - to RECONCILE and
            // re-validate, never to send early: every precondition still
            // applies. A full reconcile, because this is the first moment an
            // install that was wiped while a send was in flight has any reason
            // to look for one.
            RequestReconcile();
            PublishFromStore();
            return queued;
        }

        /**
         * Back to holding. Not gated: turning forwarding OFF cannot lose money.
         *
         * Under the same lock as StoreAddress: without it a sweep already past
         * its own intent re-read still goes out afterwards, which reads as a kill
         * switch that does not work. A transaction that IS already committed
         * still runs to a conclusion - that is deliberate, and it is why the
         * record is checked before the user's state everywhere in this file.
         */
        public void StopForwarding()
        {
            lock (INTENT_LOCK)
            {
                _store.Batch(delegate
                {
                    _store.Address = "";
                    _store.PendingAddress = "";
                    _store.ProbeTxid = "";
                    _store.ProbeAcked = false;
                    _store.ProbeConfirmed = false;
                    _store.State = ForwardState.HOLDING;
                    _store.LastError = "";
                    _store.BlockedReason = "";
                });
            }
            RequestEvaluation();
            PublishFromStore();
        }

        /**
         * The manual escape hatch for a record that can no longer be resolved.
         *
         * Behind the unlock gate at the call site because it is the one action
         * that can let a second transaction be built over the same coins. It
         * exists because the automatic path deliberately never rebuilds: a stuck
         * transaction that needs a human is rare, and turning it into two paid
         * transactions automatically would be far worse than asking.
         */
        public void ClearStuckRecord()
        {
            lock (INTENT_LOCK)
            {
                _store.Batch(delegate
                {
                    _store.RecordJson = "";
                    _store.LastError = "";
                });
            }
            RequestEvaluation();
            PublishFromStore();
        }

        /**
         * "I received it".
         *
         * Records the user's intent only. The engine still refuses to arm until
         * the node has ALSO confirmed the test payment six deep - both halves are
         * required, and this button is the half that proves someone can actually
         * see the coins at the far end.
         */
        public void AcknowledgeProbe()
        {
            _store.ProbeAcked = true;
            RequestEvaluation();
            PublishFromStore();
        }

        // ------------------------------------------------------------------- UI

        void Publish(ForwardBlock block) { Publish(block, null, -1, -1, -1); }

        void Publish(ForwardBlock block, SweepRecord record, int confirmations, long sweepableSat, long etaMs)
        {
            string reason = ForwardPolicy.Reason(block);
            _store.BlockedReason = reason;
            var s = BuildStatus();
            s.Blocked = reason;
            if (record != null)
            {
                s.HasSweep = true;
                s.SweepKind = record.Kind;
                s.SweepState = record.State;
                s.SweepAmountSat = record.AmountSat;
                s.SweepAddress = record.Address;
                s.SweepConfirmations = confirmations;
            }
            s.SweepableSat = sweepableSat;
            s.EtaMs = etaMs;
            _status = s;
            _changed();
        }

        /**
         * Republish from persisted intent alone.
         *
         * Used when the node has gone away or the user changed something: the
         * address and the state are properties of the install and stay on
         * screen, while every live reading goes back to unknown rather than
         * sitting there as though it were still being updated.
         */
        public void PublishFromStore()
        {
            _status = BuildStatus();
            _changed();
        }

        ForwardStatus BuildStatus()
        {
            return new ForwardStatus
            {
                State = _store.State,
                Address = _store.Address,
                Blocked = _store.BlockedReason,
                ProbeConfirmed = _store.ProbeConfirmed,
                ProbeAcked = _store.ProbeAcked,
                Error = _store.LastError,
                HasRecord = _store.HasRecord || _store.Unreadable,
                LastTxid = _store.LastTxid,
                LastAmountSat = _store.LastAmountSat,
                LastAtMs = _store.LastAtMs,
                LastAddress = _store.LastAddress,
            };
        }

        // ---------------------------------------------------------- small helpers

        string Wallet()
        {
            string w = _payoutWallet();
            return string.IsNullOrEmpty(w) ? "main" : w;
        }

        object Call(string wallet, string method, string paramsJson, int timeoutMs)
        {
            RpcResult r = _rpc.Call(wallet, method, paramsJson, timeoutMs);
            if (!r.Ok) throw new RpcFailure(r.Error, r.Code, r.Transport);
            return r.Result;
        }

        static string Trim200(string s)
        {
            if (s == null) return "";
            s = RpcClient.Sanitize(s);
            return s.Length <= 200 ? s : s.Substring(0, 200);
        }

        static string Short(Exception ex)
        {
            string m = ex.Message;
            return Trim200(string.IsNullOrEmpty(m) ? ex.GetType().Name : m);
        }

        static string Head(string txid)
        {
            return string.IsNullOrEmpty(txid) ? "" : (txid.Length <= 12 ? txid : txid.Substring(0, 12));
        }

        /**
         * A line in pcoin-tray.log.
         *
         * The forwarding path is the only part of this app that spends money, so
         * what it decided and why has to survive the window being closed. Never
         * carries key material: everything written here has been through
         * RpcClient.Sanitize.
         */
        static void Log(string message)
        {
            try
            {
                string dir = System.IO.Path.GetDirectoryName(
                    System.Windows.Forms.Application.ExecutablePath);
                System.IO.File.AppendAllText(System.IO.Path.Combine(dir, "pcoin-tray.log"),
                    DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture) +
                    "  forward: " + message + Environment.NewLine);
            }
            catch { }
        }
    }
}
