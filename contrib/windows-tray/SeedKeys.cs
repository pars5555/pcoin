// Copyright (c) 2026 The PCoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.
//
// BIP39 mnemonics, BIP32 key derivation, and PCoin's BIP84 account layout.
//
// The recovery phrase is the source of truth for a PCoin wallet. Everything the
// node is ever told is derived from it here, in this process, and only the
// account-level extended private key ever crosses the RPC boundary.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Numerics;
using System.Security.Cryptography;
using System.Text;

namespace PCoinTray
{
    /**
     * The result of checking a phrase the user typed.
     *
     * Deliberately reports "which words are not in the list" and "the checksum
     * failed" as separate facts, because they need different advice: an unknown
     * word can be pointed at, a checksum failure cannot be attributed to any
     * particular word and guessing at one sends the user off correcting a word
     * that was fine.
     */
    class PhraseCheck
    {
        public int WordCount;
        public bool CountOk;                                  // 12 or 24
        public readonly List<string> Unknown = new List<string>();
        public bool ChecksumOk;
        public bool Ok { get { return CountOk && Unknown.Count == 0 && ChecksumOk; } }
    }

    static class Bip39
    {
        const int PBKDF2_ITERATIONS = 2048;                   // fixed by BIP39
        static string[] _words;
        static readonly object _lock = new object();

        /**
         * The wordlist, checked against its published SHA-256 the first time it
         * is touched. A silently altered wordlist changes every derived key, so
         * this is a hard failure rather than a warning.
         */
        public static string[] Words
        {
            get
            {
                lock (_lock)
                {
                    if (_words != null) return _words;
                    var w = Bip39Wordlist.WORDS.Split(' ');
                    if (w.Length != 2048) throw new InvalidOperationException("BIP39 wordlist is not 2048 words");
                    // The canonical file is one word per line with a trailing newline.
                    var canonical = new StringBuilder();
                    foreach (var word in w) { canonical.Append(word); canonical.Append('\n'); }
                    string got = Hashes.ToHex(Hashes.Sha256(Encoding.ASCII.GetBytes(canonical.ToString())));
                    if (!string.Equals(got, Bip39Wordlist.SHA256_HEX, StringComparison.OrdinalIgnoreCase))
                        throw new InvalidOperationException("BIP39 wordlist failed its integrity check");
                    _words = w;
                    return _words;
                }
            }
        }

        static Dictionary<string, int> _index;

        public static int IndexOf(string word)
        {
            lock (_lock)
            {
                if (_index == null)
                {
                    _index = new Dictionary<string, int>(2048, StringComparer.Ordinal);
                    var w = Words;
                    for (int i = 0; i < w.Length; i++) _index[w[i]] = i;
                }
            }
            int v;
            return _index.TryGetValue(word, out v) ? v : -1;
        }

        /**
         * BIP39 requires NFKD. Even for English this matters once a keyboard or
         * a copy-paste inserts a non-breaking space or a typographic character.
         * Whitespace runs are collapsed so a phrase pasted across several lines
         * behaves the same as one typed on a single line.
         */
        public static string Normalize(string s)
        {
            if (s == null) return "";
            s = s.Normalize(NormalizationForm.FormKD).ToLowerInvariant();
            var sb = new StringBuilder(s.Length);
            bool space = true;                                // trims the front
            foreach (char c in s)
            {
                if (char.IsWhiteSpace(c) || c == ' ')
                {
                    if (!space) { sb.Append(' '); space = true; }
                }
                else { sb.Append(c); space = false; }
            }
            return sb.ToString().Trim();
        }

        //! Generate a fresh phrase. 12 words = 128 bits, 24 words = 256 bits.
        public static string Generate(int wordCount)
        {
            if (wordCount != 12 && wordCount != 24) throw new ArgumentException("word count must be 12 or 24");
            var entropy = new byte[wordCount == 12 ? 16 : 32];
            using (var rng = new RNGCryptoServiceProvider()) rng.GetBytes(entropy);
            try { return FromEntropy(entropy); }
            finally { Hashes.Wipe(entropy); }
        }

        public static string FromEntropy(byte[] entropy)
        {
            if (entropy.Length != 16 && entropy.Length != 32)
                throw new ArgumentException("entropy must be 16 or 32 bytes");
            int checksumBits = entropy.Length * 8 / 32;
            byte[] hash = Hashes.Sha256(entropy);

            var bits = new StringBuilder();
            foreach (byte b in entropy) bits.Append(Convert.ToString(b, 2).PadLeft(8, '0'));
            var hashBits = new StringBuilder();
            foreach (byte b in hash) hashBits.Append(Convert.ToString(b, 2).PadLeft(8, '0'));
            bits.Append(hashBits.ToString(0, checksumBits));

            var w = Words;
            var outWords = new List<string>();
            for (int i = 0; i < bits.Length; i += 11)
                outWords.Add(w[Convert.ToInt32(bits.ToString(i, 11), 2)]);
            return string.Join(" ", outWords.ToArray());
        }

        public static PhraseCheck Check(string mnemonic)
        {
            var r = new PhraseCheck();
            string norm = Normalize(mnemonic);
            if (norm.Length == 0) return r;
            var words = norm.Split(' ');
            r.WordCount = words.Length;
            r.CountOk = words.Length == 12 || words.Length == 24;

            var bits = new StringBuilder();
            foreach (var word in words)
            {
                int i = IndexOf(word);
                if (i < 0) { if (!r.Unknown.Contains(word)) r.Unknown.Add(word); continue; }
                bits.Append(Convert.ToString(i, 2).PadLeft(11, '0'));
            }
            if (!r.CountOk || r.Unknown.Count > 0) return r;

            int entBits = words.Length * 11 * 32 / 33;
            int csBits = words.Length * 11 - entBits;
            var entropy = new byte[entBits / 8];
            for (int i = 0; i < entropy.Length; i++)
                entropy[i] = Convert.ToByte(bits.ToString(i * 8, 8), 2);
            var hash = Hashes.Sha256(entropy);
            var hashBits = new StringBuilder();
            foreach (byte b in hash) hashBits.Append(Convert.ToString(b, 2).PadLeft(8, '0'));
            r.ChecksumOk = string.Equals(bits.ToString(entBits, csBits), hashBits.ToString(0, csBits), StringComparison.Ordinal);
            Hashes.Wipe(entropy);
            return r;
        }

        //! Up to a handful of wordlist entries sharing the given prefix. BIP39
        //! guarantees the first four letters identify a word uniquely, so this
        //! is enough to fix any realistic typo - but the user must pick one; a
        //! phrase must never be auto-corrected.
        public static List<string> Suggest(string prefix, int max)
        {
            var r = new List<string>();
            if (string.IsNullOrEmpty(prefix)) return r;
            foreach (var w in Words)
            {
                if (w.StartsWith(prefix, StringComparison.Ordinal)) { r.Add(w); if (r.Count >= max) break; }
            }
            return r;
        }

        /**
         * Mnemonic -> 64-byte seed.
         *
         * passphrase is fixed at "" by the current design; the parameter exists
         * so the record format written today can describe a future scheme
         * rather than having to guess what an old wallet used.
         */
        public static byte[] ToSeed(string mnemonic, string passphrase)
        {
            byte[] pw = Encoding.UTF8.GetBytes(Normalize(mnemonic));
            byte[] salt = Encoding.UTF8.GetBytes(("mnemonic" + (passphrase ?? "")).Normalize(NormalizationForm.FormKD));
            try { return Hashes.Pbkdf2Sha512(pw, salt, PBKDF2_ITERATIONS, 64); }
            finally { Hashes.Wipe(pw); Hashes.Wipe(salt); }
        }
    }

    //! A BIP32 extended private key.
    class ExtKey
    {
        public const uint HARDENED = 0x80000000;

        public byte[] Key = new byte[32];         // private key
        public byte[] Chain = new byte[32];
        public byte Depth;
        public uint Child;
        public byte[] ParentFingerprint = new byte[4];

        /**
         * The literal ASCII string "Bitcoin seed" is part of BIP32 and must not
         * be changed to "PCoin seed": every standard BIP32 implementation uses
         * it, and changing it would make a PCoin phrase unrestorable anywhere
         * else for no security benefit whatsoever. PCoin separates itself from
         * Bitcoin at the coin-type level (SLIP-44 9444'), not here.
         */
        public static ExtKey Master(byte[] seed)
        {
            byte[] i = Hashes.HmacSha512(Encoding.ASCII.GetBytes("Bitcoin seed"), seed);
            var k = new ExtKey();
            Buffer.BlockCopy(i, 0, k.Key, 0, 32);
            Buffer.BlockCopy(i, 32, k.Chain, 0, 32);
            Hashes.Wipe(i);
            var d = Secp256k1.FromBytes(k.Key);
            if (d.Sign == 0 || d >= Secp256k1.N)
                throw new InvalidOperationException("invalid master key (astronomically unlikely; regenerate)");
            return k;
        }

        public byte[] PubKey() { return Secp256k1.PubKey(Key); }

        public byte[] Fingerprint()
        {
            var h = Hashes.Hash160(PubKey());
            var fp = new byte[4];
            Buffer.BlockCopy(h, 0, fp, 0, 4);
            return fp;
        }

        public ExtKey Derive(uint index)
        {
            byte[] data;
            if (index >= HARDENED)
            {
                data = new byte[1 + 32 + 4];
                Buffer.BlockCopy(Key, 0, data, 1, 32);
            }
            else
            {
                data = new byte[33 + 4];
                Buffer.BlockCopy(PubKey(), 0, data, 0, 33);
            }
            int o = data.Length - 4;
            data[o + 0] = (byte)(index >> 24); data[o + 1] = (byte)(index >> 16);
            data[o + 2] = (byte)(index >> 8); data[o + 3] = (byte)index;

            byte[] i = Hashes.HmacSha512(Chain, data);
            Hashes.Wipe(data);

            var il = new byte[32];
            Buffer.BlockCopy(i, 0, il, 0, 32);
            var parsed = Secp256k1.FromBytes(il);
            var kpar = Secp256k1.FromBytes(Key);
            var ki = (parsed + kpar) % Secp256k1.N;

            // BIP32: if IL >= n or the child key is zero, the index is invalid
            // and derivation proceeds with the next one. Roughly a 1 in 2^127
            // event, but skipping it silently would produce a key nobody else
            // computes the same way.
            if (parsed >= Secp256k1.N || ki.IsZero)
            {
                Hashes.Wipe(i); Hashes.Wipe(il);
                return Derive(index + 1);
            }

            var child = new ExtKey
            {
                Key = Secp256k1.ToBytes(ki, 32),
                Depth = (byte)(Depth + 1),
                Child = index,
                ParentFingerprint = Fingerprint()
            };
            Buffer.BlockCopy(i, 32, child.Chain, 0, 32);
            Hashes.Wipe(i); Hashes.Wipe(il);
            return child;
        }

        public ExtKey DerivePath(params uint[] path)
        {
            var k = this;
            foreach (uint p in path) k = k.Derive(p);
            return k;
        }

        //! Serialise as xprv/tprv. The version bytes come from the network, not
        //! from a constant: PCoin mainnet kept Bitcoin's 0x0488ADE4, but the
        //! test networks use 0x04358394 and getting that wrong produces a key
        //! the node will reject or, worse, silently mis-attribute.
        public string ToBase58(byte[] version)
        {
            var b = Header(version);
            b[45] = 0x00;
            Buffer.BlockCopy(Key, 0, b, 46, 32);
            string s = Base58.EncodeCheck(b);
            Hashes.Wipe(b);
            return s;
        }

        //! The matching extended PUBLIC key. Not used in normal operation - the
        //! node is only ever given a private key - but it is what the published
        //! BIP84 vectors state, so the self-test can check the serialisation
        //! metadata (depth, parent fingerprint, child number) against them.
        public string ToBase58Pub(byte[] version)
        {
            var b = Header(version);
            Buffer.BlockCopy(PubKey(), 0, b, 45, 33);
            return Base58.EncodeCheck(b);
        }

        byte[] Header(byte[] version)
        {
            var b = new byte[78];
            Buffer.BlockCopy(version, 0, b, 0, 4);
            b[4] = Depth;
            Buffer.BlockCopy(ParentFingerprint, 0, b, 5, 4);
            b[9] = (byte)(Child >> 24); b[10] = (byte)(Child >> 16);
            b[11] = (byte)(Child >> 8); b[12] = (byte)Child;
            Buffer.BlockCopy(Chain, 0, b, 13, 32);
            return b;
        }

        public void Wipe() { Hashes.Wipe(Key); Hashes.Wipe(Chain); }
    }

    //! Per-network constants that the derivation depends on.
    class PCoinNetwork
    {
        public string Chain;            // as reported by getblockchaininfo
        public string Hrp;              // bech32 human readable part
        public byte[] XprvVersion;
        public uint CoinType;           // SLIP-44, without the hardening bit

        public static readonly PCoinNetwork Main =
            new PCoinNetwork { Chain = "main", Hrp = "pc", XprvVersion = new byte[] { 0x04, 0x88, 0xAD, 0xE4 }, CoinType = 9444 };

        // SLIP-44 reserves coin type 1 for every test network. Never use 9444'
        // on a test chain: that is how test coins and real coins end up sharing
        // keys.
        public static readonly PCoinNetwork Test =
            new PCoinNetwork { Chain = "test", Hrp = "tpc", XprvVersion = new byte[] { 0x04, 0x35, 0x83, 0x94 }, CoinType = 1 };
        public static readonly PCoinNetwork Testnet4 =
            new PCoinNetwork { Chain = "testnet4", Hrp = "tpc", XprvVersion = new byte[] { 0x04, 0x35, 0x83, 0x94 }, CoinType = 1 };
        public static readonly PCoinNetwork Signet =
            new PCoinNetwork { Chain = "signet", Hrp = "tpc", XprvVersion = new byte[] { 0x04, 0x35, 0x83, 0x94 }, CoinType = 1 };
        public static readonly PCoinNetwork Regtest =
            new PCoinNetwork { Chain = "regtest", Hrp = "pcrt", XprvVersion = new byte[] { 0x04, 0x35, 0x83, 0x94 }, CoinType = 1 };

        public static PCoinNetwork ByChain(string chain)
        {
            switch (chain)
            {
                case "main": return Main;
                case "test": return Test;
                case "testnet4": return Testnet4;
                case "signet": return Signet;
                case "regtest": return Regtest;
                default: return null;
            }
        }
    }

    /**
     * A phrase resolved to the account level: m/84'/<coin>'/0'.
     *
     * Derivation stops at the account on purpose. The node is given a key that
     * can spend account 0 and nothing else, so a stolen wallet.dat exposes
     * neither the seed nor any future account, and cannot be turned back into
     * the words.
     */
    class SeedAccount : IDisposable
    {
        public const uint PURPOSE = 84;
        public const uint ACCOUNT = 0;

        public readonly PCoinNetwork Net;
        public readonly string MasterFingerprint;   // lowercase hex
        public readonly string AccountXprv;
        readonly ExtKey _account;

        SeedAccount(PCoinNetwork net, string fp, ExtKey account)
        {
            Net = net; MasterFingerprint = fp; _account = account;
            AccountXprv = account.ToBase58(net.XprvVersion);
        }

        public static SeedAccount FromMnemonic(string mnemonic, PCoinNetwork net)
        {
            byte[] seed = Bip39.ToSeed(mnemonic, "");
            ExtKey master = null, l1 = null, l2 = null, account = null;
            try
            {
                master = ExtKey.Master(seed);
                string fp = Hashes.ToHex(master.Fingerprint());
                l1 = master.Derive(PURPOSE | ExtKey.HARDENED);
                l2 = l1.Derive(net.CoinType | ExtKey.HARDENED);
                account = l2.Derive(ACCOUNT | ExtKey.HARDENED);
                return new SeedAccount(net, fp, account);
            }
            finally
            {
                Hashes.Wipe(seed);
                if (master != null) master.Wipe();
                if (l1 != null) l1.Wipe();
                if (l2 != null) l2.Wipe();
                // account is kept; the caller disposes it.
            }
        }

        //! "84h/9444h/0h" - written with h rather than ' so the string is safe
        //! to embed in JSON and in any shell.
        public string OriginPath
        {
            get
            {
                return string.Format(CultureInfo.InvariantCulture, "{0}h/{1}h/{2}h", PURPOSE, Net.CoinType, ACCOUNT);
            }
        }

        //! The descriptor without its checksum. change: 0 = receive, 1 = change.
        public string Descriptor(int change)
        {
            return string.Format(CultureInfo.InvariantCulture, "wpkh([{0}/{1}]{2}/{3}/*)",
                                 MasterFingerprint, OriginPath, AccountXprv, change);
        }

        //! The address at m/84'/<coin>'/0'/<change>/<index>, computed locally.
        //! This is what the node's answer is checked against; if the two ever
        //! disagree the wallet must not be used.
        public string Address(uint change, uint index)
        {
            ExtKey c = null, k = null;
            try
            {
                c = _account.Derive(change);
                k = c.Derive(index);
                return Bech32.EncodeSegwit(Net.Hrp, 0, Hashes.Hash160(k.PubKey()));
            }
            finally
            {
                if (c != null) c.Wipe();
                if (k != null) k.Wipe();
            }
        }

        public void Dispose() { _account.Wipe(); }
    }
}
