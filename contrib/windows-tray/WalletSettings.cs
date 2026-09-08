// Copyright (c) 2026 The PCoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.
//
// The wallet's own preferences: currently one, the fee tier the send screen
// starts on. A port of the Android app's Prefs.defaultFeeTier.
//
// NOT IN pcoin-wallet.cfg, AND THAT IS THE WHOLE POINT OF THIS FILE.
// install-wallet.ps1 writes that config with Set-Content and a single line -
// `datadir=...` - so every upgrade replaces it wholesale and anything else
// stored there is gone. This is the same trap that keeps the recovery phrase
// out of pcoin-tray.cfg (SeedStore.cs:93-100); losing a fee preference is a far
// smaller harm than losing a phrase, but the mechanism is identical and so is
// the fix. Own file, next to the address book, which survives upgrades and is
// rescued by the uninstaller.
//
// A tier is AUTHORITATIVE INTENT in the ForwardStore sense: written only when
// the owner picks one, never derived, never cleared because a read failed.
// Which is why an unreadable file falls back to the default IN MEMORY and is
// not rewritten - see Load.

using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace PCoinTray
{
    class WalletSettings
    {
        public const string FILE = "pcoin-wallet-settings.json";

        const string K_VERSION = "v";
        const string K_FEE_TIER = "feeTier";
        const int VERSION = 1;

        readonly string _path;
        readonly object _lock = new object();

        /**
         * Set by the last Load() when the file existed and could not be read.
         * The UI may say so; nothing decides anything on it. As with the
         * address book, "I could not read it" is not "there was nothing there".
         */
        public bool LastLoadUnreadable;

        public WalletSettings(string dir)
        {
            _path = Path.Combine(dir, FILE);
        }

        public string Path_ { get { return _path; } }

        /**
         * The tier the send screen starts on.
         *
         * Stored as the tier's NAME, never its position in FeeTier.All. A
         * position silently remaps if the tiers are ever reordered - "Normal"
         * would become "Very fast" and every later send would quietly pay
         * twenty times the fee, with nothing in the data to show it had
         * happened.
         *
         * An unknown or unreadable name falls to NORMAL, the cheapest tier,
         * because the safe direction for a fee preference nobody can read is
         * down. A wallet that guesses upward spends the owner's money on a
         * guess. That floor is FeeTier.ByName's own rule, not a second one
         * here: null (no file, no key, unreadable file) reaches it as an
         * unrecognised name and comes back NORMAL.
         */
        public ForwardPolicy.FeeTier DefaultFeeTier()
        {
            return ForwardPolicy.FeeTier.ByName(Read(K_FEE_TIER));
        }

        public void SetDefaultFeeTier(ForwardPolicy.FeeTier tier)
        {
            Write(K_FEE_TIER, (tier ?? ForwardPolicy.FeeTier.NORMAL).Name);
        }

        // ------------------------------------------------------------ storage

        string Read(string key)
        {
            lock (_lock)
            {
                LastLoadUnreadable = false;
                if (!File.Exists(_path)) return null;
                try
                {
                    var o = Json.Obj(Json.Parse(File.ReadAllText(_path)));
                    if (o == null) { LastLoadUnreadable = true; return null; }
                    return Json.Str(o, key);
                }
                catch
                {
                    // Deliberately does NOT rewrite the file. A settings file
                    // this app cannot parse may still be one a later version
                    // can, and overwriting it with defaults would destroy the
                    // evidence as well as the setting.
                    LastLoadUnreadable = true;
                    return null;
                }
            }
        }

        /**
         * Replace one key, keeping every other key the file already holds -
         * including keys this version does not know about, so that downgrading
         * and upgrading again does not silently drop a newer setting.
         *
         * Temp file plus File.Replace, like AddressBookStore: an interrupted
         * write can never leave a truncated settings file.
         */
        void Write(string key, string value)
        {
            lock (_lock)
            {
                var kv = new Dictionary<string, string>(StringComparer.Ordinal);
                try
                {
                    if (File.Exists(_path))
                    {
                        var o = Json.Obj(Json.Parse(File.ReadAllText(_path)));
                        if (o != null)
                            foreach (var pair in o)
                            {
                                string s = pair.Value as string;
                                if (s != null) kv[pair.Key] = s;
                            }
                    }
                }
                catch { kv.Clear(); }
                kv[K_VERSION] = VERSION.ToString(System.Globalization.CultureInfo.InvariantCulture);
                kv[key] = value ?? "";

                var sb = new StringBuilder();
                sb.Append("{\n");
                bool first = true;
                foreach (var pair in kv)
                {
                    if (!first) sb.Append(",\n");
                    first = false;
                    sb.Append("  ").Append(Json.Quote(pair.Key)).Append(": ").Append(Json.Quote(pair.Value));
                }
                sb.Append("\n}\n");

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
        }
    }
}
