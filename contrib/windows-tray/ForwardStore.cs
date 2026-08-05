// Copyright (c) 2026 The PCoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.
//
// Where the forwarding feature keeps what it must not forget.
//
// NOT in pcoin-tray.cfg. install.ps1 reads that file, keeps only `address` and
// `addresswallet`, and rewrites it wholesale with four lines on every upgrade
// (install.ps1:100-115) - so any forwarding key placed there is DESTROYED by
// the next install, including the sweep record of a transaction that is in
// flight at that moment. That is the same reasoning that put the recovery
// phrase in its own file (SeedStore.cs:93-100), and it applies with more force
// here, because losing the record does not lose a convenience, it authorises a
// second payment over coins already committed.
//
// Two kinds of value live here and they are not interchangeable:
//
//  - AUTHORITATIVE INTENT - the forwarding address and state, the probe fields,
//    the sweep record, the history of the last forward. Written only by a user
//    action or by a node-confirmed terminal outcome, and NEVER cleared because
//    a read failed.
//  - DERIVED DISPLAY - last error, blocked reason, the consecutive-failure
//    counter. Freely recomputed, load-bearing for nothing, never consulted to
//    decide whether to send.
//
// The one rule the forwarding code must never break:
//
//   The sweep record is written before the broadcast and cleared only on a
//   terminal, node-confirmed outcome. Nothing derived from a single RPC read
//   may create, mutate, or clear it.
//
// Note (documented, not solved): this file lives in the install directory,
// which is shared by every Windows account on the PC, while the recovery phrase
// is DPAPI-encrypted for one account. Two accounts can therefore share a
// forwarding record but not a phrase.

using System;
using System.Globalization;
using System.IO;
using System.Text;

namespace PCoinTray
{
    class ForwardStore
    {
        const string FILE = "pcoin-forward.json";
        const int VERSION = 1;

        readonly string _path;
        readonly object _lock = new object();
        int _suspend;                    // >0 while a batch is being assembled

        // ---- authoritative intent ----
        string _address = "";
        ForwardState _state = ForwardState.HOLDING;
        string _pendingAddress = "";
        string _probeTxid = "";
        bool _probeAcked;
        bool _probeConfirmed;
        string _recordJson = "";
        string _lastTxid = "";
        long _lastAmountSat = -1;
        long _lastAtMs;
        string _lastAddress = "";

        // ---- derived display ----
        string _lastError = "";
        string _blockedReason = "";
        int _consecutiveFailures;

        /**
         * The file exists but could not be read.
         *
         * Never treated as "nothing is configured". A file we cannot parse may
         * have held a record for a transaction that is in flight right now, and
         * reading that as "no record" would authorise a build over coins that
         * are already committed.
         */
        public bool Unreadable;
        public string UnreadableWhy = "";

        public ForwardStore(string dir)
        {
            _path = Path.Combine(dir, FILE);
            Reload();
        }

        public string Path_ { get { return _path; } }

        // ---------- reading ----------

        /**
         * Re-read from disk.
         *
         * Called at the top of every evaluation rather than trusting the copy
         * in memory. The tray's single-instance mutex is session-scoped, so fast
         * user switching or an RDP session can put two tray processes on one PC
         * over one wallet and one record file; the file, not any process's
         * memory, is the authority.
         */
        public void Reload()
        {
            lock (_lock)
            {
                Unreadable = false;
                UnreadableWhy = "";
                if (!File.Exists(_path))
                {
                    // A fresh install. Not an error, and not "unreadable":
                    // HOLDING with no record is exactly right.
                    return;
                }
                try
                {
                    object o = Json.Parse(File.ReadAllText(_path));
                    _address = Str(o, "address");
                    _state = ForwardPolicy.ParseForwardState(Json.Str(o, "state"));
                    _pendingAddress = Str(o, "pendingAddress");
                    _probeTxid = Str(o, "probeTxid");
                    _probeAcked = Json.Bool(o, "probeAcked") ?? false;
                    _probeConfirmed = Json.Bool(o, "probeConfirmed") ?? false;
                    _recordJson = Str(o, "record");
                    _lastTxid = Str(o, "lastTxid");
                    _lastAmountSat = (long)(Json.Number(o, "lastAmountSat") ?? -1.0);
                    _lastAtMs = (long)(Json.Number(o, "lastAtMs") ?? 0.0);
                    _lastAddress = Str(o, "lastAddress");
                    _lastError = Str(o, "lastError");
                    _blockedReason = Str(o, "blockedReason");
                    _consecutiveFailures = (int)(Json.Number(o, "consecutiveFailures") ?? 0.0);
                }
                catch (Exception ex)
                {
                    // Deliberately NOT the `catch { }` LoadConfig uses for
                    // pcoin-tray.cfg. A broken config may be ignored; an
                    // unreadable forwarding file parks forwarding.
                    Unreadable = true;
                    UnreadableWhy = ex.Message;
                }
            }
        }

        static string Str(object o, string key) { return Json.Str(o, key) ?? ""; }

        // ---------- writing ----------

        /**
         * Apply several changes as ONE file write.
         *
         * Every setter below writes the whole file, so a compound change made
         * one setter at a time would be several writes with kill windows
         * between them. Inside a batch there is exactly one, at the end.
         */
        public void Batch(Action work)
        {
            lock (_lock)
            {
                _suspend++;
                try { work(); }
                finally
                {
                    _suspend--;
                    if (_suspend == 0) Save();
                }
            }
        }

        void Save()
        {
            if (_suspend > 0) return;
            var sb = new StringBuilder();
            sb.Append("{\n");
            sb.Append("  \"version\": ").Append(VERSION.ToString(CultureInfo.InvariantCulture)).Append(",\n");
            sb.Append("  \"address\": ").Append(Json.Quote(_address)).Append(",\n");
            sb.Append("  \"state\": ").Append(Json.Quote(_state.ToString())).Append(",\n");
            sb.Append("  \"pendingAddress\": ").Append(Json.Quote(_pendingAddress)).Append(",\n");
            sb.Append("  \"probeTxid\": ").Append(Json.Quote(_probeTxid)).Append(",\n");
            sb.Append("  \"probeAcked\": ").Append(_probeAcked ? "true" : "false").Append(",\n");
            sb.Append("  \"probeConfirmed\": ").Append(_probeConfirmed ? "true" : "false").Append(",\n");
            sb.Append("  \"record\": ").Append(Json.Quote(_recordJson)).Append(",\n");
            sb.Append("  \"lastTxid\": ").Append(Json.Quote(_lastTxid)).Append(",\n");
            sb.Append("  \"lastAmountSat\": ").Append(_lastAmountSat.ToString(CultureInfo.InvariantCulture)).Append(",\n");
            sb.Append("  \"lastAtMs\": ").Append(_lastAtMs.ToString(CultureInfo.InvariantCulture)).Append(",\n");
            sb.Append("  \"lastAddress\": ").Append(Json.Quote(_lastAddress)).Append(",\n");
            sb.Append("  \"lastError\": ").Append(Json.Quote(_lastError)).Append(",\n");
            sb.Append("  \"blockedReason\": ").Append(Json.Quote(_blockedReason)).Append(",\n");
            sb.Append("  \"consecutiveFailures\": ").Append(_consecutiveFailures.ToString(CultureInfo.InvariantCulture)).Append("\n");
            sb.Append("}\n");

            // Temp file plus File.Replace, in ONE operation - the same recipe
            // SeedStore.Save uses and for the same reason: an interrupted write
            // must never be able to leave a truncated file, or no file at all.
            // This is the Windows equivalent of SharedPreferences.commit()'s
            // all-or-nothing property, which the single-blob record depends on.
            string tmp = _path + ".tmp";
            File.WriteAllText(tmp, sb.ToString(), new UTF8Encoding(false));
            try
            {
                if (File.Exists(_path)) File.Replace(tmp, _path, null);
                else File.Move(tmp, _path);
            }
            catch
            {
                try { File.Delete(tmp); } catch { }
                throw;
            }
        }

        // ---------- authoritative intent ----------

        /**
         * Where mined coins are forwarded to, or empty to keep holding them.
         *
         * Empty is the default and a complete, safe state: this app IS a wallet
         * and the wallet is phrase-backed, so coins accumulating here are
         * exactly as recoverable as coins anywhere else. Nothing forwards until
         * the user sets this AND confirms a test payment arrived.
         *
         * Never written from a node read: this is the string every future block
         * reward gets sent to. A failed validateaddress PARKS forwarding; it
         * does not clear this.
         */
        public string Address
        {
            get { lock (_lock) { return _address; } }
            set { lock (_lock) { _address = value ?? ""; Save(); } }
        }

        /**
         * Where forwarding is in the opt-in sequence. Persisted intent; only a
         * state transition writes it, and a state transition only ever follows a
         * user action or a node-confirmed fact.
         */
        public ForwardState State
        {
            get { lock (_lock) { return _state; } }
            set { lock (_lock) { _state = value; Save(); } }
        }

        /**
         * An address the user chose while a sweep was still in flight.
         *
         * Swapped into Address only once that record is terminal. The in-flight
         * transaction pays the OLD address and has to be allowed to complete: a
         * destination cannot be reasoned about halfway through a send.
         */
        public string PendingAddress
        {
            get { lock (_lock) { return _pendingAddress; } }
            set { lock (_lock) { _pendingAddress = value ?? ""; Save(); } }
        }

        /** Txid of the test payment, so its confirmations can be followed. */
        public string ProbeTxid
        {
            get { lock (_lock) { return _probeTxid; } }
            set { lock (_lock) { _probeTxid = value ?? ""; Save(); } }
        }

        /**
         * The user pressed "I received it" for the test payment.
         *
         * This is the whole safety property of the feature: a valid address that
         * nobody holds the key to accepts coins silently and burns every future
         * reward, and `verifymessage` cannot verify a bech32 address in this
         * fork (common/signmessage.cpp rejects anything that is not P2PKH), so a
         * signed challenge is not available. A confirmed payment the user can
         * see in their own wallet is the only proof left. If they never press
         * it, the app never forwards more than the 1 PCN probe.
         */
        public bool ProbeAcked
        {
            get { lock (_lock) { return _probeAcked; } }
            set { lock (_lock) { _probeAcked = value; Save(); } }
        }

        /**
         * The probe reached 6 confirmations, as the node reported at the time.
         *
         * Recorded rather than re-read, so the acknowledge button does not
         * depend on a live query that could fail: this is a node-confirmed fact
         * the app then owns. Arming requires BOTH this and ProbeAcked.
         */
        public bool ProbeConfirmed
        {
            get { lock (_lock) { return _probeConfirmed; } }
            set { lock (_lock) { _probeConfirmed = value; Save(); } }
        }

        /** The single sweep record, as one JSON blob. Empty when there is none. */
        public string RecordJson
        {
            get { lock (_lock) { return _recordJson; } }
            set { lock (_lock) { _recordJson = value ?? ""; Save(); } }
        }

        public bool HasRecord
        {
            get { lock (_lock) { return _recordJson.Length > 0; } }
        }

        // Authoritative history: derived from a node-confirmed fact, then owned
        // by the app. The user relies on this being stable across restarts, so
        // it must not vanish because a later read failed. Written on SETTLED
        // only.
        public string LastTxid
        {
            get { lock (_lock) { return _lastTxid; } }
            set { lock (_lock) { _lastTxid = value ?? ""; Save(); } }
        }

        public long LastAmountSat
        {
            get { lock (_lock) { return _lastAmountSat; } }
            set { lock (_lock) { _lastAmountSat = value; Save(); } }
        }

        public long LastAtMs
        {
            get { lock (_lock) { return _lastAtMs; } }
            set { lock (_lock) { _lastAtMs = value; Save(); } }
        }

        public string LastAddress
        {
            get { lock (_lock) { return _lastAddress; } }
            set { lock (_lock) { _lastAddress = value ?? ""; Save(); } }
        }

        // ---------- derived display ----------

        public string LastError
        {
            get { lock (_lock) { return _lastError; } }
            set { lock (_lock) { _lastError = value ?? ""; Save(); } }
        }

        public string BlockedReason
        {
            get { lock (_lock) { return _blockedReason; } }
            set { lock (_lock) { _blockedReason = value ?? ""; Save(); } }
        }

        public int ConsecutiveFailures
        {
            get { lock (_lock) { return _consecutiveFailures; } }
            set { lock (_lock) { _consecutiveFailures = value; Save(); } }
        }
    }
}
