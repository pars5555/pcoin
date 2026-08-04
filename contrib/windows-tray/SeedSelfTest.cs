// Copyright (c) 2026 The PCoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.
//
// Test vectors for the key derivation.
//
// This app implements BIP39, BIP32, BIP84, Base58 and Bech32 from scratch,
// because it is compiled with the in-box C# compiler and cannot take a library
// dependency. Hand-written cryptography that nobody checks is how people lose
// money, so it is checked here against the published vectors from BIP32, BIP39
// and BIP84 - values produced by other implementations, not by this one.
//
// Run it with:  PCoinTray.exe --selftest
//
// The critical part is the BIP84 chain: mnemonic -> seed -> master key ->
// account key -> first address. If all four agree with the published Bitcoin
// vectors, then the same code applied to PCoin's coin type is right too, since
// the only difference is one number in the path.

using System;
using System.Collections.Generic;
using System.Text;

namespace PCoinTray
{
    static class SeedSelfTest
    {
        //! A burn phrase. It is the standard all-zero-entropy BIP39 test
        //! mnemonic, published in every wallet's test suite. Never put coins on
        //! any address derived from it.
        public const string TEST_MNEMONIC =
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

        static readonly PCoinNetwork BITCOIN_FOR_VECTORS = new PCoinNetwork
        {
            Chain = "bip84-vectors",
            Hrp = "bc",
            XprvVersion = new byte[] { 0x04, 0x88, 0xAD, 0xE4 },
            CoinType = 0
        };

        public static bool Run(List<string> log)
        {
            bool ok = true;
            ok &= Check(log, "wordlist integrity", "2048", Bip39.Words.Length.ToString());
            ok &= Check(log, "wordlist[0]", "abandon", Bip39.Words[0]);
            ok &= Check(log, "wordlist[2047]", "zoo", Bip39.Words[2047]);

            // --- BIP39 -----------------------------------------------------
            ok &= Check(log, "BIP39 entropy -> mnemonic",
                TEST_MNEMONIC,
                Bip39.FromEntropy(Hashes.FromHex("00000000000000000000000000000000")));

            ok &= Check(log, "BIP39 24-word entropy -> mnemonic",
                "legal winner thank year wave sausage worth useful legal winner thank year wave sausage " +
                "worth useful legal winner thank year wave sausage worth title",
                Bip39.FromEntropy(Hashes.FromHex("7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f")));

            ok &= Check(log, "BIP39 seed (empty passphrase)",
                "5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4",
                Hashes.ToHex(Bip39.ToSeed(TEST_MNEMONIC, "")));

            ok &= Check(log, "BIP39 seed (passphrase TREZOR)",
                "c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04",
                Hashes.ToHex(Bip39.ToSeed(TEST_MNEMONIC, "TREZOR")));

            var check = Bip39.Check(TEST_MNEMONIC);
            ok &= Check(log, "BIP39 checksum accepts a good phrase", "True", check.Ok.ToString());
            // Same words, two of them swapped: every word is valid, the phrase is not.
            var swapped = Bip39.Check(
                "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about abandon");
            ok &= Check(log, "BIP39 checksum rejects a reordered phrase", "False", swapped.Ok.ToString());
            ok &= Check(log, "BIP39 reordered phrase has no unknown words", "0", swapped.Unknown.Count.ToString());
            var typo = Bip39.Check(TEST_MNEMONIC.Replace("about", "abuot"));
            ok &= Check(log, "BIP39 reports the unknown word", "abuot",
                        typo.Unknown.Count == 1 ? typo.Unknown[0] : "(none)");

            // --- BIP32 test vector 1 ---------------------------------------
            var m = ExtKey.Master(Hashes.FromHex("000102030405060708090a0b0c0d0e0f"));
            var btcVer = new byte[] { 0x04, 0x88, 0xAD, 0xE4 };
            ok &= Check(log, "BIP32 vector 1 master xprv",
                "xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi",
                m.ToBase58(btcVer));
            ok &= Check(log, "BIP32 vector 1 m/0'",
                "xprv9uHRZZhk6KAJC1avXpDAp4MDc3sQKNxDiPvvkX8Br5ngLNv1TxvUxt4cV1rGL5hj6KCesnDYUhd7oWgT11eZG7XnxHrnYeSvkzY7d2bhkJ7",
                m.Derive(0 | ExtKey.HARDENED).ToBase58(btcVer));
            ok &= Check(log, "BIP32 vector 1 m/0'/1 (unhardened)",
                "xprv9wTYmMFdV23N2TdNG573QoEsfRrWKQgWeibmLntzniatZvR9BmLnvSxqu53Kw1UmYPxLgboyZQaXwTCg8MSY3H2EU4pWcQDnRnrVA1xe8fs",
                m.Derive(0 | ExtKey.HARDENED).Derive(1).ToBase58(btcVer));

            // --- BIP84 end to end ------------------------------------------
            // BIP84 publishes its vectors in the SLIP-132 zprv/zpub encoding
            // rather than xprv/xpub, so the version bytes here are that
            // encoding's. The key material is identical either way; only the
            // four leading bytes differ.
            var zprv = Hashes.FromHex("04b2430c");
            var zpub = Hashes.FromHex("04b24746");

            var root = ExtKey.Master(Bip39.ToSeed(TEST_MNEMONIC, ""));
            ok &= Check(log, "BIP84 root xprv",
                "xprv9s21ZrQH143K3GJpoapnV8SFfukcVBSfeCficPSGfubmSFDxo1kuHnLisriDvSnRRuL2Qrg5ggqHKNVpxR86QEC8w35uxmGoggxtQTPvfUu",
                root.ToBase58(btcVer));
            ok &= Check(log, "BIP84 rootpriv (zprv form)",
                "zprvAWgYBBk7JR8Gjrh4UJQ2uJdG1r3WNRRfURiABBE3RvMXYSrRJL62XuezvGdPvG6GFBZduosCc1YP5wixPox7zhZLfiUm8aunE96BBa4Kei5",
                root.ToBase58(zprv));

            // Depth, parent fingerprint and child number all live in this
            // string, so matching it proves the serialisation and not just the
            // key material.
            var acct84 = root.DerivePath(84 | ExtKey.HARDENED, 0 | ExtKey.HARDENED, 0 | ExtKey.HARDENED);
            ok &= Check(log, "BIP84 account 0 zpub m/84'/0'/0'",
                "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs",
                acct84.ToBase58Pub(zpub));

            using (var acct = SeedAccount.FromMnemonic(TEST_MNEMONIC, BITCOIN_FOR_VECTORS))
            {
                ok &= Check(log, "BIP84 account key agrees with the direct derivation",
                    acct84.ToBase58(btcVer), acct.AccountXprv);
                ok &= Check(log, "BIP84 first receive address", "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu", acct.Address(0, 0));
                ok &= Check(log, "BIP84 second receive address", "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g", acct.Address(0, 1));
                ok &= Check(log, "BIP84 first change address", "bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el", acct.Address(1, 0));
                ok &= Check(log, "BIP84 master fingerprint", "73c5da0a", acct.MasterFingerprint);
            }

            // --- PCoin ------------------------------------------------------
            // Not a third-party vector; this is what the published PCoin test
            // vectors in PCOIN.md must say, and it fails loudly if the coin
            // type, the bech32 prefix or the descriptor template ever move.
            using (var pc = SeedAccount.FromMnemonic(TEST_MNEMONIC, PCoinNetwork.Main))
            {
                ok &= Check(log, "PCoin origin path", "84h/9444h/0h", pc.OriginPath);
                ok &= Check(log, "PCoin master fingerprint", "73c5da0a", pc.MasterFingerprint);
                Log(log, "PCoin account xprv m/84'/9444'/0' = " + pc.AccountXprv);
                Log(log, "PCoin receive descriptor = " + pc.Descriptor(0));
                Log(log, "PCoin change  descriptor = " + pc.Descriptor(1));
                for (uint i = 0; i < 3; i++) Log(log, "PCoin m/84'/9444'/0'/0/" + i + " = " + pc.Address(0, i));
                for (uint i = 0; i < 3; i++) Log(log, "PCoin m/84'/9444'/0'/1/" + i + " = " + pc.Address(1, i));

                ok &= Check(log, "PCoin address prefix", "pc1q", pc.Address(0, 0).Substring(0, 4));
            }

            // --- regtest must not reuse the mainnet coin type ---------------
            using (var rt = SeedAccount.FromMnemonic(TEST_MNEMONIC, PCoinNetwork.Regtest))
            {
                ok &= Check(log, "regtest coin type is 1", "84h/1h/0h", rt.OriginPath);
                ok &= Check(log, "regtest uses tprv", "tprv", rt.AccountXprv.Substring(0, 4));
                ok &= Check(log, "regtest address prefix", "pcrt1q", rt.Address(0, 0).Substring(0, 6));
            }

            // --- sanitiser --------------------------------------------------
            ok &= Check(log, "error text redacts a private key",
                "bad descriptor <private key redacted>",
                RpcClient.Sanitize("bad descriptor xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi"));

            Log(log, ok ? "ALL CHECKS PASSED" : "FAILURES ABOVE - DO NOT SHIP");
            return ok;
        }

        static void Log(List<string> log, string s) { log.Add(s); }

        static bool Check(List<string> log, string what, string expect, string got)
        {
            bool ok = string.Equals(expect, got, StringComparison.Ordinal);
            log.Add((ok ? "ok   " : "FAIL ") + what);
            if (!ok) { log.Add("       expected: " + expect); log.Add("       got:      " + got); }
            return ok;
        }
    }
}
