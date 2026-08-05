// Fleet provisioning: set the forwarding destination without a desktop.
//
// WHY THIS EXISTS. The forwarding destination is normally set through the
// settings dialog, which validates the address against the node, canonicalises
// it, and makes the operator retype its last six characters. On a fleet machine
// reached over a remote-execution tunnel there is no desktop to do that in, and
// the alternative -- hand-writing pcoin-forward.json from a deploy script -- is
// exactly the shape of mistake this app is built to prevent: it would skip
// validateaddress, skip canonicalisation, and skip the transcription check, so a
// wrong or wrong-chain address would be committed silently and every future
// block reward would be sent to it.
//
// So this is the SAME code path as the dialog, driven from argv:
//
//     PCoinTray.exe --fleet-forward <address> <last-6-characters>
//
// WHAT IT DELIBERATELY DOES NOT DO.
//
//   * It does not arm forwarding. It writes PROBING_PENDING, exactly as the
//     dialog does, so the 1 PCN test payment and the human "I received it" are
//     still required before a full sweep can ever run. Provisioning a fleet must
//     not be a way to skip the gate that proves the address is reachable.
//
//   * It writes NOTHING unless the node answered. A validateaddress that timed
//     out resolves nothing -- it is not a reason to store an address, and it is
//     not a reason to clear one either.
//
//   * It never clears an existing destination. Turning forwarding off is a
//     separate, deliberate act.
//
//   * If a sweep is in flight it QUEUES the new address instead of applying it,
//     because the in-flight transaction pays the old one and a destination
//     cannot be reasoned about halfway through a send.
//
// RUN IT WITH THE TRAY STOPPED. ForwardStore is the authority on disk, but a
// running tray holds its own copy in memory and will rewrite the file on its
// next save, clobbering what this wrote. The deploy script stops the tray before
// upgrading, so the natural place for this is between the upgrade and the
// relaunch. It refuses to run if it sees a tray process.

using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

namespace PCoinTray
{
    static class FleetProvision
    {
        public static int Run(string[] args)
        {
            string raw = args.Length > 0 ? args[0] : null;
            string confirm = args.Length > 1 ? args[1] : null;

            if (string.IsNullOrEmpty(raw) || string.IsNullOrEmpty(confirm))
            {
                Console.WriteLine("usage: PCoinTray.exe --fleet-forward <address> <last-6-characters>");
                Console.WriteLine();
                Console.WriteLine("  The second argument is the last six characters of the address, retyped.");
                Console.WriteLine("  It is the same transcription check the settings dialog makes, and it is");
                Console.WriteLine("  what catches a truncated or clipboard-mangled address that still has a");
                Console.WriteLine("  valid checksum.");
                return 2;
            }

            string dir = Path.GetDirectoryName(Application.ExecutablePath);

            // A running tray would overwrite this file from its in-memory copy.
            try
            {
                var others = Process.GetProcessesByName("PCoinTray");
                int self = Process.GetCurrentProcess().Id;
                foreach (var p in others)
                {
                    if (p.Id == self) continue;
                    Console.WriteLine("REFUSED: PCoinTray is running (pid " + p.Id + ").");
                    Console.WriteLine("Stop it first, or this write will be lost when it next saves.");
                    return 3;
                }
            }
            catch { /* enumeration is best-effort; not a reason to refuse */ }

            string datadir, payoutWallet;
            ReadConfig(Path.Combine(dir, "pcoin-tray.cfg"), out datadir, out payoutWallet);

            var rpc = new RpcClient(datadir);
            string normalized = ForwardPolicy.NormalizeAddress(raw);

            // Ask the node. This is the authority on whether the string is a
            // PCoin address at all -- a Bitcoin bc1q.../1... fails here, because
            // PCoin's hrp is "pc" and its base58 versions are 55/56.
            var r = rpc.Call(null, "validateaddress", "[" + Json.Quote(normalized) + "]", 20000);
            if (!r.Ok)
            {
                Console.WriteLine("REFUSED: the node did not answer validateaddress"
                                  + (r.Transport ? " (transport failure)" : "")
                                  + ": " + RpcClient.Sanitize(r.Error ?? "unknown"));
                Console.WriteLine("Nothing was written. An unanswered node resolves nothing.");
                return 4;
            }

            var v = Json.Obj(r.Result);
            if (v == null)
            {
                Console.WriteLine("REFUSED: validateaddress returned no object. Nothing was written.");
                return 4;
            }

            bool? valid = Json.Bool(v, "isvalid");
            bool? witness = Json.Bool(v, "iswitness");
            double? version = Json.Number(v, "witness_version");

            // The node's own re-encoding is what gets stored, never the operator's
            // spelling of it.
            string canonical = Json.Str(v, "address");
            if (string.IsNullOrEmpty(canonical)) canonical = normalized;

            bool mine = false;
            var mi = rpc.Call(payoutWallet, "getaddressinfo", "[" + Json.Quote(canonical) + "]", 20000);
            if (mi.Ok)
            {
                bool? m = Json.Bool(Json.Obj(mi.Result), "ismine");
                mine = m.HasValue && m.Value;
            }
            // getaddressinfo is wallet-scoped. If it could not be asked, "is this
            // our own address" stays unknown -- and unknown is not "no". Say so
            // rather than letting a silent false through, which is the exact
            // failure that once discarded a payout address.
            else
            {
                Console.WriteLine("NOTE: could not ask wallet '" + payoutWallet + "' whether it owns this address ("
                                  + RpcClient.Sanitize(mi.Error ?? "no answer") + ").");
                Console.WriteLine("      The own-wallet check is therefore not conclusive below.");
            }

            var facts = new AddressFacts
            {
                IsValid = valid.HasValue && valid.Value,
                IsWitness = witness.HasValue && witness.Value,
                WitnessVersion = version.HasValue ? (int)version.Value : 0,
                IsMine = mine,
                NodeError = Json.Str(v, "error") ?? "",
                ScriptPubKey = Json.Str(v, "scriptPubKey") ?? "",
            };

            var verdict = ForwardPolicy.CheckAddress(canonical, facts, confirm);
            if (verdict != AddressVerdict.OK)
            {
                Console.WriteLine("REFUSED: " + ForwardPolicy.Message(verdict));
                Console.WriteLine("Nothing was written.");
                return 5;
            }

            // Same shape as ForwardEngine.StoreAddress, including the re-probe.
            var store = new ForwardStore(dir);
            if (store.Unreadable)
            {
                Console.WriteLine("REFUSED: " + Path.GetFileName(store.Path_) + " exists but could not be read ("
                                  + store.UnreadableWhy + ").");
                Console.WriteLine("It may hold a record for a transaction that is in flight right now.");
                return 6;
            }

            bool queued = store.HasRecord;
            if (queued)
            {
                store.PendingAddress = canonical;
                Console.WriteLine("QUEUED: a forward is in flight to the previous address.");
                Console.WriteLine("The new address takes effect once that settles, and then a fresh test payment is sent.");
            }
            else
            {
                store.Batch(delegate
                {
                    store.Address = canonical;
                    store.PendingAddress = "";
                    store.ProbeTxid = "";
                    store.ProbeAcked = false;
                    store.ProbeConfirmed = false;
                    store.State = ForwardState.PROBING_PENDING;
                    store.LastError = "";
                    store.BlockedReason = "";
                });
                Console.WriteLine("OK: forwarding destination set.");
            }

            Console.WriteLine("  address : " + canonical);
            Console.WriteLine("  state   : " + store.State);
            Console.WriteLine("  wallet  : " + payoutWallet);
            Console.WriteLine("  file    : " + store.Path_);
            Console.WriteLine();
            Console.WriteLine("A 1 PCN test payment will be sent once coins are spendable. Nothing else");
            Console.WriteLine("is forwarded until someone confirms that payment arrived.");
            return 0;
        }

        /** Read only what provisioning needs; the tray owns the rest of this file. */
        static void ReadConfig(string path, out string datadir, out string payoutWallet)
        {
            datadir = null;
            payoutWallet = "main";
            try
            {
                if (!File.Exists(path)) return;
                foreach (var rawLine in File.ReadAllLines(path))
                {
                    string line = rawLine.Trim();
                    if (line.Length == 0 || line[0] == '#') continue;
                    int eq = line.IndexOf('=');
                    if (eq <= 0) continue;
                    string k = line.Substring(0, eq).Trim();
                    string val = line.Substring(eq + 1).Trim();
                    if (k == "datadir") datadir = val;
                    else if (k == "addresswallet" && val.Length > 0) payoutWallet = val;
                }
            }
            catch { }
        }
    }
}
