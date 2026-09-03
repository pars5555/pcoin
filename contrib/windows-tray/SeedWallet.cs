// Copyright (c) 2026 The PCoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.
//
// Turning a recovery phrase into a working wallet on the node, and back.
//
// The rule that governs this file: the phrase is authoritative, the node is
// checked against it, and nothing that already exists is ever replaced. The
// phrase-backed wallet is created under its own name alongside whatever wallet
// this machine already had; no existing wallet is renamed, unloaded, altered or
// deleted, and no coins are moved.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;

namespace PCoinTray
{
    /**
     * The non-secret half of the phrase record, kept in plain text next to it.
     *
     * This exists so the app can know, without unlocking anything, that a
     * phrase-backed wallet is in use and which address mining should pay to.
     * Everything in here is public information: an address, a wallet name, a
     * key fingerprint. The words are never in this file.
     */
    class PhraseInfo
    {
        public string Wallet = "";
        public string Address0 = "";
        public string Fingerprint = "";
        public string Network = "";
        public string Path = "";
        public string Created = "";
        public int WordCount;

        public string Serialize()
        {
            var sb = new StringBuilder();
            sb.Append("wallet=").Append(Wallet).Append("\r\n");
            sb.Append("address0=").Append(Address0).Append("\r\n");
            sb.Append("fingerprint=").Append(Fingerprint).Append("\r\n");
            sb.Append("network=").Append(Network).Append("\r\n");
            sb.Append("path=").Append(Path).Append("\r\n");
            sb.Append("created=").Append(Created).Append("\r\n");
            sb.Append("words=").Append(WordCount.ToString(CultureInfo.InvariantCulture)).Append("\r\n");
            return sb.ToString();
        }

        public static PhraseInfo Deserialize(string text)
        {
            var r = new PhraseInfo();
            foreach (var raw in text.Replace("\r", "").Split('\n'))
            {
                int eq = raw.IndexOf('=');
                if (eq <= 0) continue;
                string k = raw.Substring(0, eq).Trim(), v = raw.Substring(eq + 1).Trim();
                switch (k)
                {
                    case "wallet": r.Wallet = v; break;
                    case "address0": r.Address0 = v; break;
                    case "fingerprint": r.Fingerprint = v; break;
                    case "network": r.Network = v; break;
                    case "path": r.Path = v; break;
                    case "created": r.Created = v; break;
                    case "words": int.TryParse(v, out r.WordCount); break;
                }
            }
            return r;
        }

        const string FILE = "pcoin-seed.info";

        public static string PathFor(string dir) { return System.IO.Path.Combine(dir, FILE); }

        public static PhraseInfo Load(string dir)
        {
            try
            {
                string p = PathFor(dir);
                if (!File.Exists(p)) return null;
                var i = Deserialize(File.ReadAllText(p));
                return string.IsNullOrEmpty(i.Address0) ? null : i;
            }
            catch { return null; }
        }

        public static void Save(string dir, PhraseInfo info)
        {
            File.WriteAllText(PathFor(dir), info.Serialize());
        }
    }

    class SetupOutcome
    {
        public bool Ok;
        public string Error;            // already sanitised, safe to display
        public string Address;          // m/84'/coin'/0'/0/0
        public string Wallet;
        public string Network;          // the chain the node reported
        public string Fingerprint;      // master key fingerprint, hex
        public string Path;             // the account path actually used
        public bool AlreadySetUp;       // the node already had this exact phrase

        /**
         * What the scan actually found. -1 means the node could not be asked,
         * which is deliberately not the same as zero.
         *
         * Reported because a valid-but-wrong phrase restores silently into an
         * empty wallet: one mistyped word that happens to be another word from
         * the list passes the 4-bit checksum roughly one time in sixteen, and
         * without this the result looked exactly like a successful restore.
         */
        public int TxCount = -1;
        public double Balance = -1;
    }

    class SeedWallet
    {
        //! A new name, deliberately. The existing "main" wallet keeps its name,
        //! its keys and its coins, and stays loaded alongside this one.
        public const string HD_WALLET = "pcoin-hd";

        //! PCoin's genesis nTime. Used as the rescan floor on a restore: it is
        //! the true lower bound, and importdescriptors already subtracts a two
        //! hour window from whatever it is given.
        public const long GENESIS_TIME = 1785600628;

        public const int IMPORT_RANGE = 999;      // 1000 addresses per chain

        readonly RpcClient _rpc;

        public SeedWallet(RpcClient rpc) { _rpc = rpc; }

        public RpcClient Rpc { get { return _rpc; } }

        //! The chain the node is actually running, or null if it cannot be asked.
        //! Deriving mainnet keys against a regtest node - or the reverse - is a
        //! money bug, so this is checked rather than assumed.
        public string DetectChain()
        {
            string why;
            return DetectChain(out why);
        }

        /**
         * Three attempts, two seconds apart. A node in initial block download
         * on a busy PC can miss one twenty-second window; one miss must not
         * abort a setup that has changed nothing yet, and the reason for the
         * last miss is handed back so the message can say what happened.
         */
        public string DetectChain(out string why)
        {
            why = null;
            for (int attempt = 0; attempt < 3; attempt++)
            {
                if (attempt > 0) System.Threading.Thread.Sleep(2000);
                var r = _rpc.Call("getblockchaininfo", "[]");
                if (r.Ok)
                {
                    string chain = Json.Str(r.Result, "chain");
                    if (chain != null) return chain;
                    why = "getblockchaininfo carried no chain name";
                    continue;
                }
                why = r.Error ?? "no answer";
            }
            return null;
        }

        /**
         * The wallets the node currently has open, or null if it could not be
         * asked.
         *
         * Null, not an empty list. "Nothing is loaded" and "I could not find
         * out" lead to opposite decisions - the first invites a createwallet,
         * the second must stop everything - and an earlier version swallowed
         * the RPC failure and returned an empty list, so any hiccup read as
         * "this node has no wallets".
         */
        public List<string> LoadedWallets()
        {
            var r = _rpc.Call("listwallets", "[]");
            if (!r.Ok) return null;
            var arr = Json.Arr(r.Result);
            if (arr == null) return null;
            var list = new List<string>();
            foreach (var o in arr) { var s = o as string; if (s != null) list.Add(s); }
            return list;
        }

        /**
         * Make sure a wallet is loaded, creating it only if asked to.
         *
         * Returns null on success or a message on failure. Loading is done
         * explicitly here rather than as a side effect of some other call: a
         * wallet that is only ever loaded incidentally is a wallet that
         * eventually stops being loaded at all.
         */
        public string EnsureWallet(string name, bool create, bool blank)
        {
            var loaded = LoadedWallets();
            if (loaded == null)
                return "Could not ask the node which wallets are loaded, so nothing was loaded " +
                       "or created. Make sure the node is running and try again.";
            if (loaded.Contains(name)) return null;

            var load = _rpc.Call(null, "loadwallet", "[" + Json.Quote(name) + ",true]", 60000);
            if (load.Ok) return null;
            if (!create) return load.Error;

            // wallet_name, disable_private_keys, blank, passphrase, avoid_reuse,
            // descriptors, load_on_startup, external_signer
            string p = "[" + Json.Quote(name) + ",false," + (blank ? "true" : "false") +
                       ",\"\",false,true,true,false]";
            var made = _rpc.Call(null, "createwallet", p, 60000);
            if (made.Ok) return null;
            return made.Error;
        }

        /**
         * The descriptors already present in a wallet.
         *
         * Returns null - not an empty list - when the node could not be asked.
         * "I do not know what is in this wallet" and "this wallet is empty" lead
         * to opposite decisions, and conflating them here would let a failed RPC
         * authorise an import over the top of somebody's existing keys.
         */
        List<string> Descriptors(string wallet)
        {
            var r = _rpc.Call(wallet, "listdescriptors", "[]", 30000);
            if (!r.Ok) return null;
            var arr = Json.Arr(Json.Field(r.Result, "descriptors"));
            if (arr == null) return null;
            var list = new List<string>();
            foreach (var o in arr) { var d = Json.Str(o, "desc"); if (d != null) list.Add(d); }
            return list;
        }

        /**
         * Create or restore the phrase-backed wallet.
         *
         * @param mnemonic  the phrase; never logged, never leaves this process
         * @param restore   true if these words may already have coins, which
         *                  decides whether the node rescans
         */
        public SetupOutcome Setup(string mnemonic, bool restore)
        {
            var o = new SetupOutcome { Wallet = HD_WALLET };

            string why;
            string chain = DetectChain(out why);
            if (chain == null)
            {
                o.Error = "The PCoin node is not answering (" + RpcClient.Sanitize(why ?? "no answer") +
                          "). Start it and try again.";
                return o;
            }
            var net = PCoinNetwork.ByChain(chain);
            if (net == null) { o.Error = "Unrecognised network \"" + chain + "\"; refusing to derive keys."; return o; }

            o.Network = chain;
            using (var acct = SeedAccount.FromMnemonic(mnemonic, net))
            {
                o.Path = "m/" + acct.OriginPath;
                o.Fingerprint = acct.MasterFingerprint;
                string localAddress = acct.Address(0, 0);
                string origin = "[" + acct.MasterFingerprint + "/" + acct.OriginPath + "]";

                // blank: no HD seed of the node's own choosing. The only keys
                // this wallet ever holds are the ones derived from the phrase.
                string err = EnsureWallet(HD_WALLET, true, true);
                if (err != null) { o.Error = "Could not create the wallet: " + err; return o; }

                // If this wallet already holds these exact keys, there is
                // nothing to do and re-importing would be pointless churn. If it
                // holds somebody else's keys, stop: silently layering a second
                // set of active descriptors over them is how a wallet ends up
                // paying to keys its owner does not have.
                var existing = Descriptors(HD_WALLET);
                if (existing == null)
                {
                    o.Error = "Could not read what the wallet \"" + HD_WALLET + "\" already contains, so " +
                              "nothing was imported into it. Make sure the node is running and try again.";
                    return o;
                }
                if (existing.Count > 0)
                {
                    bool ours = existing.TrueForAll(d => d.Contains(origin));
                    if (!ours)
                    {
                        o.Error = "The wallet \"" + HD_WALLET + "\" already exists on this machine and was made " +
                                  "from a different recovery phrase. Nothing has been changed. Move or rename " +
                                  "that wallet before restoring a different phrase.";
                        return o;
                    }
                    o.AlreadySetUp = true;
                }

                if (!o.AlreadySetUp)
                {
                    string extDesc, intDesc;
                    err = Checksummed(acct.Descriptor(0), out extDesc);
                    if (err != null) { o.Error = err; return o; }
                    err = Checksummed(acct.Descriptor(1), out intDesc);
                    if (err != null) { o.Error = err; return o; }

                    // "now" for a phrase generated a moment ago: those keys
                    // provably never existed before, so there is nothing to scan
                    // for. Genesis for a restore, because the coins may be as
                    // old as the chain.
                    string ts = restore ? GENESIS_TIME.ToString(CultureInfo.InvariantCulture) : "\"now\"";
                    string body = "[[" +
                        DescRequest(extDesc, false, ts) + "," +
                        DescRequest(intDesc, true, ts) + "]]";

                    var imp = _rpc.Call(HD_WALLET, "importdescriptors", body, 600000);
                    if (!imp.Ok) { o.Error = "Import failed: " + imp.Error; return o; }

                    // importdescriptors reports per-descriptor results and does
                    // not fail the call when only one of them worked. A wallet
                    // that imported the receive descriptor but not the change
                    // one can take coins and cannot build change - invisible
                    // until the first send.
                    var results = Json.Arr(imp.Result);
                    if (results == null || results.Count != 2)
                    {
                        o.Error = "Import returned an unexpected result; the wallet may be incomplete. " +
                                  "Do not use it - check with listdescriptors.";
                        return o;
                    }
                    foreach (var r in results)
                    {
                        bool? ok = Json.Bool(r, "success");
                        if (ok != true)
                        {
                            string msg = Json.Str(Json.Field(r, "error"), "message");
                            o.Error = "A descriptor failed to import: " + RpcClient.Sanitize(msg ?? "unknown error") +
                                      ". The wallet is incomplete and must not be used.";
                            return o;
                        }
                    }
                }

                // ---- verification: the node and the phrase must agree ----

                var wi = _rpc.Call(HD_WALLET, "getwalletinfo", "[]", 30000);
                if (!wi.Ok) { o.Error = "Could not read the wallet back: " + wi.Error; return o; }
                if (Json.Bool(wi.Result, "descriptors") != true)
                {
                    o.Error = "The node did not create a descriptor wallet. Stopping.";
                    return o;
                }

                var desc = _rpc.Call(HD_WALLET, "listdescriptors", "[]", 30000);
                var darr = Json.Arr(Json.Field(desc.Result, "descriptors"));
                int active = 0, internalActive = 0;
                if (darr != null)
                    foreach (var d in darr)
                    {
                        if (Json.Bool(d, "active") != true) continue;
                        active++;
                        if (Json.Bool(d, "internal") == true) internalActive++;
                    }
                if (active != 2 || internalActive != 1)
                {
                    o.Error = "The wallet does not have exactly one receive and one change descriptor active " +
                              "(found " + active + " active, " + internalActive + " internal). Do not use it.";
                    return o;
                }

                /*
                 * The cross-check that makes all of this trustworthy: the node
                 * must agree that the address these words derive to is one of
                 * its own, at exactly the path the words say. If it does not,
                 * something between the phrase and the node is wrong - the
                 * wrong network's version bytes, a public key where a private
                 * one was meant, an off-by-one in the path - and the user must
                 * not be handed an address they cannot spend from.
                 *
                 * Note what this deliberately does NOT do: ask the node for a
                 * new address and compare. That works for a freshly generated
                 * phrase and is wrong for a restore, because the rescan
                 * advances the descriptor past every index that already has
                 * history - so getnewaddress correctly hands back index 3 or
                 * 50, and a comparison against index 0 fails on exactly the
                 * wallets that have coins in them. Asking about the address we
                 * derived is the question we actually mean.
                 */
                var ai = _rpc.Call(HD_WALLET, "getaddressinfo", "[" + Json.Quote(localAddress) + "]", 30000);
                if (!ai.Ok) { o.Error = "Could not verify the address with the node: " + ai.Error; return o; }
                if (Json.Bool(ai.Result, "ismine") != true)
                {
                    o.Error = "STOP. The node does not recognise the address these words derive to as its own.\n\n" +
                              "words: " + localAddress + "\n\n" +
                              "The wallet has not been put into use and no mining has been redirected. " +
                              "Report this before going any further.";
                    return o;
                }

                // Core reports the full path it used. When it is there it is
                // the strongest statement available that the node walked the
                // same tree, so check it - but do not fail on its absence, a
                // future release is free to stop reporting it.
                string keypath = Json.Str(ai.Result, "hdkeypath");
                if (!string.IsNullOrEmpty(keypath))
                {
                    string expect = "m/" + acct.OriginPath + "/0/0";
                    if (!string.Equals(keypath.Replace("'", "h"), expect, StringComparison.Ordinal))
                    {
                        o.Error = "STOP. The node derived " + localAddress + " at " + keypath +
                                  ", but these words put it at " + expect + ".\n\n" +
                                  "Nothing has been put into use. Report this before going any further.";
                        return o;
                    }
                }

                // Cosmetic, and allowed to fail: it only labels the address in
                // the node's own wallet listings.
                _rpc.Call(HD_WALLET, "setlabel", "[" + Json.Quote(localAddress) + ",\"mining\"]", 20000);

                // What the scan found, so the caller can say it out loud rather
                // than declaring success over an empty wallet.
                double? tx = Json.Number(wi.Result, "txcount");
                if (tx.HasValue) o.TxCount = (int)tx.Value;
                double trusted, immature;
                if (Balances(HD_WALLET, out trusted, out immature)) o.Balance = trusted + immature;

                o.Address = localAddress;
                o.Ok = true;
                return o;
            }
        }

        static string DescRequest(string descWithChecksum, bool isInternal, string timestampJson)
        {
            // No label on the internal descriptor: ProcessImport rejects that.
            return "{\"desc\":" + Json.Quote(descWithChecksum) +
                   ",\"active\":true,\"internal\":" + (isInternal ? "true" : "false") +
                   ",\"range\":[0," + IMPORT_RANGE.ToString(CultureInfo.InvariantCulture) + "]" +
                   ",\"next_index\":0,\"timestamp\":" + timestampJson + "}";
        }

        /**
         * Ask the node for a descriptor's checksum and append it.
         *
         * Only the checksum field of the answer is used. The descriptor field
         * that comes back is the canonical form WITHOUT private keys - importing
         * that would produce a watch-only wallet that looks perfectly healthy
         * right up until the day somebody tries to spend from it.
         */
        string Checksummed(string desc, out string result)
        {
            result = null;
            var r = _rpc.Call(null, "getdescriptorinfo", "[" + Json.Quote(desc) + "]", 30000);
            if (!r.Ok) return "The node rejected the descriptor: " + r.Error;

            if (Json.Bool(r.Result, "hasprivatekeys") != true)
                return "The descriptor lost its private key on the way to the node. Stopping.";
            if (Json.Bool(r.Result, "isrange") != true)
                return "The descriptor is not a ranged descriptor. Stopping.";

            string checksum = Json.Str(r.Result, "checksum");
            if (string.IsNullOrEmpty(checksum)) return "The node did not return a descriptor checksum.";

            result = desc + "#" + checksum;
            return null;
        }

        // ---- balances ----

        //! Spendable and immature balance of a wallet, or null if it cannot be
        //! read. Null and zero mean very different things to somebody looking at
        //! their money, so they are never conflated.
        public bool Balances(string wallet, out double trusted, out double immature)
        {
            trusted = 0; immature = 0;
            var r = _rpc.Call(wallet, "getbalances", "[]", 20000);
            if (!r.Ok) return false;
            var mine = Json.Field(r.Result, "mine");
            double? t = Json.Number(mine, "trusted");
            double? p = Json.Number(mine, "untrusted_pending");
            double? i = Json.Number(mine, "immature");
            if (!t.HasValue) return false;
            trusted = t.Value + (p.HasValue ? p.Value : 0);
            immature = i.HasValue ? i.Value : 0;
            return true;
        }

        /**
         * Make sure pcoin.conf has the two settings a spend depends on.
         *
         * Lines are only ever appended; anything already in the file is left
         * exactly as it is. Both settings take effect when the node next starts.
         *
         *  fallbackfee - Core's default is 0, and PCoin has no fee history to
         *      estimate from, so without this every send fails outright with
         *      "Fee estimation failed".
         *  changetype  - the wallet only has wpkh descriptors. Sending to a
         *      taproot address would otherwise fail while allocating change,
         *      because there is no tr() descriptor to take it.
         */
        public string EnsureConfig()
        {
            try
            {
                string path = _rpc.ConfPath;
                var have = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                if (File.Exists(path))
                {
                    foreach (var raw in File.ReadAllLines(path))
                    {
                        string line = raw.Trim();
                        int eq = line.IndexOf('=');
                        if (eq > 0 && line.Length > 0 && line[0] != '#') have.Add(line.Substring(0, eq).Trim());
                    }
                }
                var add = new List<string>();
                if (!have.Contains("fallbackfee")) add.Add("fallbackfee=0.00001");
                if (!have.Contains("changetype")) add.Add("changetype=bech32");
                if (add.Count == 0) return null;

                var sb = new StringBuilder();
                sb.Append("\r\n# added by PCoinTray: required for spending to work at all\r\n");
                foreach (var l in add) sb.Append(l).Append("\r\n");
                File.AppendAllText(path, sb.ToString());
                return string.Join(", ", add.ToArray());
            }
            catch (Exception ex) { return "could not update pcoin.conf: " + ex.Message; }
        }
    }
}
