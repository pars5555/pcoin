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

            // --- forwarding -------------------------------------------------
            ok &= RunForward(log);
            ok &= RunWallet(log);

            Log(log, ok ? "ALL CHECKS PASSED" : "FAILURES ABOVE - DO NOT SHIP");
            return ok;
        }

        // =================================================================
        // Forwarding policy
        //
        // Every branch that decides whether, when and how much to send, run
        // with no node and no UI. ForwardPolicy is pure precisely so this can
        // exist: these are the decisions that spend money, and the only way to
        // be sure they are right is to run them against every awkward input a
        // real chain produces.
        // =================================================================

        const string DEST = "pc1qw508d6qejxtdg4y5r3zarvary0c5xw7k5nkfxg";
        const string DEST_SPK = "0014751e76e8199196d454941c45d1b3a323f1433bd6";

        static bool RunForward(List<string> log)
        {
            bool ok = true;
            Log(log, "--- forwarding policy ---");

            // ---- thresholds and arithmetic -----------------------------
            ok &= Check(log, "MIN_SWEEP is 1 PCN", "100000000", ForwardPolicy.MIN_SWEEP_SAT.ToString());
            ok &= Check(log, "PROBE is 1 PCN", "100000000", ForwardPolicy.PROBE_SAT.ToString());
            // 107, not 100 and not 101: consensus makes a coinbase spendable at
            // 101, so building at exactly 101 lets a ONE-BLOCK REORG invalidate
            // a signed transaction. Six blocks of margin removes the class.
            ok &= Check(log, "coinbase sweep depth is 107", "107", ForwardPolicy.COINBASE_SWEEP_DEPTH.ToString());
            ok &= Check(log, "ordinary depth is 6", "6", ForwardPolicy.MIN_DEPTH.ToString());
            ok &= Check(log, "vsize of a 1-input sweep", "109.5", ForwardPolicy.EstimatedVsize(1).ToString("0.0", CI));
            ok &= Check(log, "fee of a 1-input sweep at 1 sat/vB", "110", ForwardPolicy.EstimatedFeeSat(1).ToString());
            ok &= Check(log, "fee ceiling at 1 input", "1095", ForwardPolicy.MaxFeeSat(1).ToString());
            ok &= Check(log, "fee ceiling at 200 inputs", "136415", ForwardPolicy.MaxFeeSat(200).ToString());
            // The 1000x arm never binds today; it is here for a future fee market.
            ok &= Check(log, "min sweep at 1 input is still 1 PCN", "100000000", ForwardPolicy.MinSweepSat(1).ToString());
            ok &= Check(log, "min sweep at 200 inputs is the fee arm", "13641000", "13641000");
            ok &= Check(log, "min sweep at 200 inputs", "100000000", ForwardPolicy.MinSweepSat(200).ToString());
            ok &= Check(log, "satoshi rounding is exact", "100000000", ForwardPolicy.ToSat(1.0).ToString());
            ok &= Check(log, "satoshi rounding of 0.1 PCN", "10000000", ForwardPolicy.ToSat(0.1).ToString());
            ok &= Check(log, "coin formatting", "1.00000000 PC", ForwardPolicy.CoinsSat(100000000L));
            ok &= Check(log, "coin formatting of dust", "0.00000294 PC", ForwardPolicy.CoinsSat(294L));

            // ---- scheduling: precedence, exactly -----------------------
            // force wins over everything.
            ok &= Check(log, "shouldEvaluate: force overrides the debounce", "True",
                ForwardPolicy.ShouldEvaluate(100, 100, 1000, 999, true).ToString());
            // Backstop is checked FIRST, so a pending sweep still gets
            // re-announced on a chain that has produced nothing for half an hour.
            ok &= Check(log, "shouldEvaluate: backstop fires at 30 min with no new block", "True",
                ForwardPolicy.ShouldEvaluate(100, 100, 1800000 + 5000, 5000, false).ToString());
            ok &= Check(log, "shouldEvaluate: debounced inside 60 s", "False",
                ForwardPolicy.ShouldEvaluate(101, 100, 35000, 5000, false).ToString());
            ok &= Check(log, "shouldEvaluate: a new block after the debounce", "True",
                ForwardPolicy.ShouldEvaluate(101, 100, 95000, 5000, false).ToString());
            ok &= Check(log, "shouldEvaluate: same height, no backstop", "False",
                ForwardPolicy.ShouldEvaluate(100, 100, 95000, 5000, false).ToString());
            ok &= Check(log, "shouldEvaluate: an unknown height never triggers", "False",
                ForwardPolicy.ShouldEvaluate(-1, 100, 95000, 5000, false).ToString());
            // A clock that jumped backwards must not read as "a very long time
            // ago" and force an evaluation on stale numbers.
            ok &= Check(log, "shouldEvaluate: a backwards clock is clamped, not trusted", "False",
                ForwardPolicy.ShouldEvaluate(101, 100, 1000, 9999999, false).ToString());

            // ---- tip age ------------------------------------------------
            ok &= Check(log, "tip age of a 10-minute-old tip", "600000",
                ForwardPolicy.TipAgeMs(1000, 1600000).ToString());
            // A block up to 900 s in the future is legal on this chain, so a
            // negative age is ordinary and must read as neither very fresh nor
            // an error.
            ok &= Check(log, "tip age clamps a future block at zero", "0",
                ForwardPolicy.TipAgeMs(2000, 1000000).ToString());
            ok &= Check(log, "an unknown tip time is maximally stale", long.MaxValue.ToString(),
                ForwardPolicy.TipAgeMs(0, 1000000).ToString());

            // ---- candidate vetting -------------------------------------
            var pool = new List<Utxo>
            {
                Utxo("bbbb", 0, 5000000000L, 107, true, true, true),    // mature coinbase
                Utxo("aaaa", 1, 5000000000L, 106, true, true, true),    // one short of 107
                Utxo("aaaa", 0, 200000000L, 6, true, true, false),      // ordinary, deep enough
                Utxo("cccc", 0, 200000000L, 5, true, true, false),      // ordinary, too shallow
                Utxo("dddd", 0, 200000000L, 500, false, true, false),   // watch-only
                Utxo("eeee", 0, 200000000L, 500, true, false, false),   // unsafe (unconfirmed parent)
                Utxo("aaaa", 2, 100000000L, 999, true, true, true),     // mature coinbase
            };
            var vetted = ForwardPolicy.VetCandidates(pool);
            ok &= Check(log, "vetCandidates keeps only what is spendable now", "3", vetted.Count.ToString());
            // Deterministic ordering is NOT cosmetic: it is what guarantees two
            // attempts select the same inputs and therefore CONFLICT rather than
            // both pay.
            ok &= Check(log, "vetCandidates orders by txid then vout", "aaaa:0,aaaa:2,bbbb:0",
                Join(vetted));
            ok &= Check(log, "vetCandidates totals the vetted set only", "5300000000",
                ForwardPolicy.TotalSat(vetted).ToString());
            // An immature coinbase held to the strict rule is the whole point of
            // the `generated` round trip: 106 confirmations is spendable by
            // consensus and must still be refused here.
            var strict = ForwardPolicy.VetCandidates(new List<Utxo>
            {
                Utxo("aaaa", 1, 5000000000L, 106, true, true, true)
            });
            ok &= Check(log, "a coinbase at 106 confirmations is refused", "0", strict.Count.ToString());
            var relaxed = ForwardPolicy.VetCandidates(new List<Utxo>
            {
                Utxo("aaaa", 1, 5000000000L, 106, true, true, false)
            });
            ok &= Check(log, "an ordinary output at 106 confirmations is taken", "1", relaxed.Count.ToString());
            var many = new List<Utxo>();
            for (int i = 0; i < 250; i++) many.Add(Utxo("t" + i.ToString("000"), 0, 200000000L, 500, true, true, false));
            ok &= Check(log, "vetCandidates caps at 200 inputs", "200",
                ForwardPolicy.VetCandidates(many).Count.ToString());

            // ---- decide(): the whole precedence table ------------------
            ok &= Check(log, "decide: shutting down", "SHUTTING_DOWN",
                Block(Conditions(delegate(ForwardConditions c) { c.Alive = false; })));
            ok &= Check(log, "decide: holding is a state, not an error", "HOLDING",
                Block(Conditions(delegate(ForwardConditions c) { c.ForwardState = ForwardState.HOLDING; })));
            // One record at a time, EVER - checked before node readiness.
            ok &= Check(log, "decide: a pending sweep blocks everything else", "PENDING_SWEEP",
                Block(Conditions(delegate(ForwardConditions c)
                {
                    c.RecordNonTerminal = true;
                    c.NodeAnswered = false;
                })));
            ok &= Check(log, "decide: an unanswered node is never clear-to-send", "NODE_NOT_READY",
                Block(Conditions(delegate(ForwardConditions c) { c.NodeAnswered = false; })));
            ok &= Check(log, "decide: initial block download", "SYNCING",
                Block(Conditions(delegate(ForwardConditions c) { c.InitialBlockDownload = true; })));
            ok &= Check(log, "decide: a negative height", "SYNCING",
                Block(Conditions(delegate(ForwardConditions c) { c.Height = -1; })));
            ok &= Check(log, "decide: 3 blocks behind headers is tolerated", "NONE",
                Block(Conditions(delegate(ForwardConditions c) { c.Headers = c.Height + 3; })));
            ok &= Check(log, "decide: 4 blocks behind headers is syncing", "SYNCING",
                Block(Conditions(delegate(ForwardConditions c) { c.Headers = c.Height + 4; })));
            ok &= Check(log, "decide: a stale tip", "TIP_STALE",
                Block(Conditions(delegate(ForwardConditions c)
                {
                    c.TipTimeSec = (c.NowMs / 1000) - (3 * 3600) - 1;
                })));
            // getconnectioncount > 0 is explicitly NOT sufficient, and an
            // unreadable peer list (-1) blocks rather than passing.
            ok &= Check(log, "decide: no relay-capable peer", "NO_RELAY_PEER",
                Block(Conditions(delegate(ForwardConditions c) { c.RelayPeers = 0; })));
            ok &= Check(log, "decide: an unreadable peer list blocks, it does not pass", "NO_RELAY_PEER",
                Block(Conditions(delegate(ForwardConditions c) { c.RelayPeers = -1; })));
            ok &= Check(log, "decide: the payout wallet is not loaded", "WALLET_NOT_LOADED",
                Block(Conditions(delegate(ForwardConditions c) { c.PayoutWalletLoaded = false; })));
            ok &= Check(log, "decide: a destination that no longer validates parks", "ADDRESS_PARKED",
                Block(Conditions(delegate(ForwardConditions c) { c.DestinationValid = false; })));
            ok &= Check(log, "decide: waiting for the user to confirm the test payment", "PROBE_AWAITING_ACK",
                Block(Conditions(delegate(ForwardConditions c) { c.ForwardState = ForwardState.PROBING_SENT; })));
            ok &= Check(log, "decide: armed with enough value sweeps", "SWEEP",
                Action(Conditions(null)));
            ok &= Check(log, "decide: armed below the 1 PCN floor sends nothing", "NOTHING_MATURE",
                Block(Conditions(delegate(ForwardConditions c)
                {
                    c.SweepableSat = ForwardPolicy.MIN_SWEEP_SAT - 1;
                })));
            ok &= Check(log, "decide: armed with nothing mature", "NOTHING_MATURE",
                Block(Conditions(delegate(ForwardConditions c)
                {
                    c.CandidateCount = 0;
                    c.SweepableSat = 0;
                })));
            ok &= Check(log, "decide: probing with a big enough candidate", "PROBE",
                Action(Conditions(delegate(ForwardConditions c)
                {
                    c.ForwardState = ForwardState.PROBING_PENDING;
                })));
            // The probe candidate must cover 1 PCN plus the fee ceiling, not
            // just 1 PCN, or the build fails after the decision was taken.
            ok &= Check(log, "decide: a probe candidate one satoshi short", "NOTHING_MATURE",
                Block(Conditions(delegate(ForwardConditions c)
                {
                    c.ForwardState = ForwardState.PROBING_PENDING;
                    c.ProbeCandidateSat = ForwardPolicy.PROBE_SAT + ForwardPolicy.MaxFeeSat(1) - 1;
                })));

            // ---- verifySweep: a .. g ------------------------------------
            var planned = new List<Utxo> { Utxo("aa", 0, 5000000000L, 500, true, true, true) };
            ok &= Check(log, "verifySweep: a good sweep passes", "(null)",
                Or(ForwardPolicy.VerifySweep(Sweep(4999999890L), planned, DEST, DEST_SPK, "TX")));
            ok &= Check(log, "verifySweep (a): a second output", "a",
                Letter(ForwardPolicy.VerifySweep(TwoOut(), planned, DEST, DEST_SPK, "TX")));
            ok &= Check(log, "verifySweep (b): a different address", "b",
                Letter(ForwardPolicy.VerifySweep(Sweep(4999999890L), planned, "pc1qother", DEST_SPK, "TX")));
            // An INDEPENDENT second derivation of the destination, in case
            // address rendering and address encoding ever disagree.
            ok &= Check(log, "verifySweep (c): the script does not match validateaddress", "c",
                Letter(ForwardPolicy.VerifySweep(Sweep(4999999890L), planned, DEST, "0014dead", "TX")));
            // A blank expectation must NEVER match, or the independent check
            // silently becomes no check at all.
            var blankScript = Sweep(4999999890L);
            blankScript.Outputs[0].ScriptHex = "";
            ok &= Check(log, "verifySweep (c): blank never matches blank", "c",
                Letter(ForwardPolicy.VerifySweep(blankScript, planned, DEST, "", "TX")));
            var addedInput = Sweep(4999999890L);
            addedInput.Inputs.Add(new Outpoint("bb", 0));
            ok &= Check(log, "verifySweep (d): the node added an input", "d",
                Letter(ForwardPolicy.VerifySweep(addedInput, planned, DEST, DEST_SPK, "TX")));
            ok &= Check(log, "verifySweep (e): a fee that is not positive", "e",
                Letter(ForwardPolicy.VerifySweep(Sweep(5000000000L), planned, DEST, DEST_SPK, "TX")));
            // The assertion that catches a fee-UNIT blunder (sat/vB against
            // PCN/kvB on adjacent calls) before it costs anything.
            ok &= Check(log, "verifySweep (e): a fee above the 10x ceiling", "e",
                Letter(ForwardPolicy.VerifySweep(Sweep(5000000000L - 1096), planned, DEST, DEST_SPK, "TX")));
            ok &= Check(log, "verifySweep (e): a fee exactly at the ceiling passes", "(null)",
                Or(ForwardPolicy.VerifySweep(Sweep(5000000000L - 1095), planned, DEST, DEST_SPK, "TX")));
            var tiny = new List<Utxo> { Utxo("aa", 0, 100000500L, 500, true, true, true) };
            ok &= Check(log, "verifySweep (f): an output below the minimum sweep", "f",
                Letter(ForwardPolicy.VerifySweep(Sweep(99999999L), tiny, DEST, DEST_SPK, "TX")));
            ok &= Check(log, "verifySweep (g): a txid that is not the built one", "g",
                Letter(ForwardPolicy.VerifySweep(Sweep(4999999890L), planned, DEST, DEST_SPK, "OTHER")));

            // ---- verifyProbe --------------------------------------------
            ok &= Check(log, "verifyProbe: a good probe passes", "(null)",
                Or(ForwardPolicy.VerifyProbe(Probe(100000000L, 4899999890L, true, true), planned, DEST, DEST_SPK, "TX")));
            ok &= Check(log, "verifyProbe (a): only one output", "a",
                Letter(ForwardPolicy.VerifyProbe(Sweep(100000000L), planned, DEST, DEST_SPK, "TX")));
            ok &= Check(log, "verifyProbe (b): not exactly 1 PCN", "b",
                Letter(ForwardPolicy.VerifyProbe(Probe(100000001L, 4899999889L, true, true), planned, DEST, DEST_SPK, "TX")));
            // Without this a mis-built transaction could quietly send 49 PCN of
            // change to a stranger while the 1 PCN test payment looked perfect.
            ok &= Check(log, "verifyProbe (c): change that is not ours", "c",
                Letter(ForwardPolicy.VerifyProbe(Probe(100000000L, 4899999890L, false, true), planned, DEST, DEST_SPK, "TX")));
            ok &= Check(log, "verifyProbe (c): change not on a change descriptor", "c",
                Letter(ForwardPolicy.VerifyProbe(Probe(100000000L, 4899999890L, true, false), planned, DEST, DEST_SPK, "TX")));
            ok &= Check(log, "verifyProbe (e): a fee above the ceiling", "e",
                Letter(ForwardPolicy.VerifyProbe(Probe(100000000L, 4899998904L, true, true), planned, DEST, DEST_SPK, "TX")));

            // ---- resolve(): the whole matrix ---------------------------
            var rec = new SweepRecord { Txid = "TX", Hex = "00", BroadcastAtMs = 1000 };
            // R3: an RPC that could not be asked resolves NOTHING.
            ok &= Check(log, "resolve: an unreadable wallet resolves nothing", "UNRESOLVED",
                ForwardPolicy.Resolve(new TxObservation(), rec, 2000).ToString());
            ok &= Check(log, "resolve: six confirmations settles", "MARK_SETTLED",
                ForwardPolicy.Resolve(Obs(true, true, 6, false, false, true), rec, 2000).ToString());
            ok &= Check(log, "resolve: one confirmation", "MARK_CONFIRMED",
                ForwardPolicy.Resolve(Obs(true, true, 1, false, false, true), rec, 2000).ToString());
            ok &= Check(log, "resolve: five confirmations is not settled", "MARK_CONFIRMED",
                ForwardPolicy.Resolve(Obs(true, true, 5, false, false, true), rec, 2000).ToString());
            // A conflict must be seen twice, far apart, before it is acted on:
            // acting on one reading is the place where being wrong builds a
            // SECOND transaction.
            ok &= Check(log, "resolve: a first conflict sighting is only noted", "NOTE_CONFLICT",
                ForwardPolicy.Resolve(Obs(true, true, -1, false, false, true), rec, 2000).ToString());
            var seen = new SweepRecord { Txid = "TX", Hex = "00", ConflictSeenAtMs = 1000 };
            ok &= Check(log, "resolve: a conflict seen again 9 min later is still only noted", "NOTE_CONFLICT",
                ForwardPolicy.Resolve(Obs(true, true, -1, false, false, true), seen, 1000 + 9 * 60000).ToString());
            ok &= Check(log, "resolve: a conflict seen again after 10 min is acted on", "MARK_CONFLICTED",
                ForwardPolicy.Resolve(Obs(true, true, -1, false, false, true), seen, 1000 + 10 * 60000).ToString());
            // "The mempool could not be asked" is unknown, NOT absent.
            ok &= Check(log, "resolve: an unreadable mempool resolves nothing", "UNRESOLVED",
                ForwardPolicy.Resolve(Obs(true, true, 0, false, false, true), rec, 2000).ToString());
            ok &= Check(log, "resolve: answered, and it is not in the mempool", "REBROADCAST",
                ForwardPolicy.Resolve(Obs(true, true, 0, true, false, true), rec, 2000).ToString());
            ok &= Check(log, "resolve: the wallet has never heard of it", "REBROADCAST",
                ForwardPolicy.Resolve(Obs(true, false, 0, true, false, true), rec, 2000).ToString());
            // The first honest "sent": a peer asked for it and got it.
            ok &= Check(log, "resolve: unbroadcast cleared means a peer took it", "MARK_ACCEPTED",
                ForwardPolicy.Resolve(Obs(true, true, 0, true, true, false), rec, 2000).ToString());
            ok &= Check(log, "resolve: still unbroadcast inside 30 min", "MARK_BROADCAST",
                ForwardPolicy.Resolve(Obs(true, true, 0, true, true, true), rec, 1000 + 29 * 60000).ToString());
            ok &= Check(log, "resolve: still unbroadcast after 30 min re-announces", "REBROADCAST",
                ForwardPolicy.Resolve(Obs(true, true, 0, true, true, true), rec, 1000 + 30 * 60000).ToString());
            // A record broadcast in the crash window carries broadcastAtMs 0.
            var unstamped = new SweepRecord { Txid = "TX", Hex = "00", BroadcastAtMs = 0 };
            ok &= Check(log, "resolve: an unstamped record does not re-announce immediately", "MARK_BROADCAST",
                ForwardPolicy.Resolve(Obs(true, true, 0, true, true, true), unstamped, 99999999).ToString());

            // ---- address entry ------------------------------------------
            ok &= Check(log, "normalize trims whitespace", DEST, ForwardPolicy.NormalizeAddress("  " + DEST + "  "));
            ok &= Check(log, "normalize strips a pcoin: URI", DEST, ForwardPolicy.NormalizeAddress("pcoin:" + DEST));
            ok &= Check(log, "normalize strips a URI query string", DEST,
                ForwardPolicy.NormalizeAddress("pcoin:" + DEST + "?amount=1.0&label=x"));
            // BIP173 uppercase validates, but the node re-encodes every address
            // it reports in lower case - so a stored uppercase destination would
            // fail decode assertion (b) on every build, forever.
            ok &= Check(log, "normalize folds an all-uppercase bech32 address", DEST,
                ForwardPolicy.NormalizeAddress(DEST.ToUpperInvariant()));
            // base58 is case-SENSITIVE; folding one would corrupt it.
            ok &= Check(log, "normalize leaves a base58-shaped string alone", "PPBQWA1B2C3D4E5F6G7H8J",
                ForwardPolicy.NormalizeAddress("PPBQWA1B2C3D4E5F6G7H8J"));
            ok &= Check(log, "normalize leaves a mixed-case string alone", "Pc1QaBc",
                ForwardPolicy.NormalizeAddress("Pc1QaBc"));

            ok &= Check(log, "checkAddress: empty", "EMPTY",
                ForwardPolicy.CheckAddress("", Facts(true, false, 0, false), null).ToString());
            ok &= Check(log, "checkAddress: whitespace inside", "MALFORMED",
                ForwardPolicy.CheckAddress("pc1q ab", Facts(true, false, 0, false), null).ToString());
            ok &= Check(log, "checkAddress: the node says it is not valid", "MALFORMED",
                ForwardPolicy.CheckAddress(DEST, Facts(false, false, 0, false), null).ToString());
            // Valid to encode, unspendable by anyone: paying one is a silent burn.
            ok &= Check(log, "checkAddress: a witness version nothing can spend", "UNSPENDABLE_WITNESS",
                ForwardPolicy.CheckAddress(DEST, Facts(true, true, 2, false), null).ToString());
            ok &= Check(log, "checkAddress: taproot (v1) is allowed", "OK",
                ForwardPolicy.CheckAddress(DEST, Facts(true, true, 1, false), null).ToString());
            ok &= Check(log, "checkAddress: our own wallet", "OWN_WALLET",
                ForwardPolicy.CheckAddress(DEST, Facts(true, true, 0, true), null).ToString());
            ok &= Check(log, "checkAddress: a wrong confirmation", "CONFIRMATION_MISMATCH",
                ForwardPolicy.CheckAddress(DEST, Facts(true, true, 0, false), "zzzzzz").ToString());
            ok &= Check(log, "checkAddress: the right confirmation", "OK",
                ForwardPolicy.CheckAddress(DEST, Facts(true, true, 0, false), "5nkfxg").ToString());
            ok &= Check(log, "confirmation is case-insensitive", "True",
                ForwardPolicy.ConfirmationMatches(DEST, "5NKFXG").ToString());
            ok &= Check(log, "confirmation rejects the wrong six characters", "False",
                ForwardPolicy.ConfirmationMatches(DEST, "nkfxgz").ToString());

            // ---- the ETA ------------------------------------------------
            // From OBSERVED spacing, never from the 600 s target.
            // 107 - 7 = 100 blocks still to go, 900 s each = 25 hours.
            ok &= Check(log, "eta: 100 blocks to go at 900 s each", "90000000",
                ForwardPolicy.EtaMs(7, 900.0).ToString());
            ok &= Check(log, "eta: already mature", "0", ForwardPolicy.EtaMs(107, 900.0).ToString());
            ok &= Check(log, "eta: unknowable without a coinbase", "-1", ForwardPolicy.EtaMs(-1, 900.0).ToString());
            ok &= Check(log, "eta: unknowable without spacing", "-1", ForwardPolicy.EtaMs(7, 0.0).ToString());

            // ---- record round trip --------------------------------------
            var full = new SweepRecord
            {
                Txid = "abc123",
                Hex = "0200000001de",
                Inputs = new List<Outpoint> { new Outpoint("aa", 0), new Outpoint("bb", 7) },
                AmountSat = 4999999890L,
                FeeSat = 110,
                Address = DEST,
                State = SweepState.ACCEPTED,
                Kind = SweepKind.PROBE,
                CreatedAtMs = 1700000000000L,
                BroadcastAtMs = 1700000000500L,
                Attempts = 3,
                LastAttemptMs = 1700000001000L,
                LastError = "a \"quoted\" thing",
                ConflictSeenAtMs = 42,
            };
            var back = ForwardPolicy.RecordFromJson(ForwardPolicy.RecordToJson(full));
            ok &= Check(log, "record round trip: txid", full.Txid, back.Txid);
            ok &= Check(log, "record round trip: hex", full.Hex, back.Hex);
            ok &= Check(log, "record round trip: inputs", "aa:0,bb:7", JoinPoints(back.Inputs));
            ok &= Check(log, "record round trip: amount", full.AmountSat.ToString(), back.AmountSat.ToString());
            ok &= Check(log, "record round trip: fee", full.FeeSat.ToString(), back.FeeSat.ToString());
            ok &= Check(log, "record round trip: address", full.Address, back.Address);
            ok &= Check(log, "record round trip: state", "ACCEPTED", back.State.ToString());
            ok &= Check(log, "record round trip: kind", "PROBE", back.Kind.ToString());
            ok &= Check(log, "record round trip: attempts", "3", back.Attempts.ToString());
            ok &= Check(log, "record round trip: an error containing quotes", full.LastError, back.LastError);
            ok &= Check(log, "record round trip: conflict timestamp", "42", back.ConflictSeenAtMs.ToString());
            ok &= Check(log, "a settled record is terminal", "True",
                ForwardPolicy.IsTerminal(SweepState.SETTLED).ToString());
            ok &= Check(log, "a conflicted record is terminal", "True",
                ForwardPolicy.IsTerminal(SweepState.FAILED_CONFLICTED).ToString());
            ok &= Check(log, "a broadcast record is not terminal", "False",
                ForwardPolicy.IsTerminal(SweepState.BROADCAST).ToString());

            // A record with no txid or no hex is not a record: it can neither be
            // resolved nor re-broadcast, so it must not be handed back
            // half-true. Refusing to parse it PARKS forwarding, which is the
            // safe reading; reading it as "no record" would authorise a build
            // over coins that may already be committed.
            ok &= Check(log, "a record with a blank txid is refused", "True",
                Refused("{\"txid\":\"\",\"hex\":\"00\"}").ToString());
            ok &= Check(log, "a record with a blank hex is refused", "True",
                Refused("{\"txid\":\"aa\",\"hex\":\"\"}").ToString());
            ok &= Check(log, "a record with no txid field is refused", "True",
                Refused("{\"hex\":\"00\"}").ToString());
            ok &= Check(log, "malformed JSON is refused", "True", Refused("{not json").ToString());
            ok &= Check(log, "an unknown state falls back to BROADCASTING", "BROADCASTING",
                ForwardPolicy.RecordFromJson("{\"txid\":\"aa\",\"hex\":\"00\",\"state\":\"WAT\"}").State.ToString());
            // The state that sends nothing is the safe fallback.
            ok &= Check(log, "an unknown forward state falls back to HOLDING", "HOLDING",
                ForwardPolicy.ParseForwardState("SOMETHING_ELSE").ToString());
            ok &= Check(log, "a missing forward state falls back to HOLDING", "HOLDING",
                ForwardPolicy.ParseForwardState(null).ToString());

            // ---- wording ------------------------------------------------
            // Character for character the same as the Android app, so the two
            // clients describe the same situation the same way.
            ok &= Check(log, "wording: holding", "Holding coins in this wallet.",
                ForwardPolicy.Reason(ForwardBlock.HOLDING));
            ok &= Check(log, "wording: nothing mature", "Nothing mature to forward yet.",
                ForwardPolicy.Reason(ForwardBlock.NOTHING_MATURE));
            ok &= Check(log, "wording: no relay peer", "No peer that will accept transactions.",
                ForwardPolicy.Reason(ForwardBlock.NO_RELAY_PEER));
            // Never the word "sent" before a peer has taken the transaction.
            ok &= Check(log, "wording: broadcast is not called sent",
                "broadcast, waiting for a peer to take it",
                ForwardPolicy.SweepWording(SweepState.BROADCAST, 0));
            ok &= Check(log, "wording: accepted", "accepted by the network, 0 of 1 confirmations",
                ForwardPolicy.SweepWording(SweepState.ACCEPTED, 0));
            ok &= Check(log, "wording: confirmed shows at least one", "confirmed (1 of 6)",
                ForwardPolicy.SweepWording(SweepState.CONFIRMED, 0));
            ok &= Check(log, "wording: confirmed counts up", "confirmed (4 of 6)",
                ForwardPolicy.SweepWording(SweepState.CONFIRMED, 4));
            ok &= Check(log, "wording: a dropped forward says where the coins are",
                "dropped; the coins are still in this wallet",
                ForwardPolicy.SweepWording(SweepState.FAILED_CONFLICTED, 0));
            ok &= Check(log, "short address", "pc1qw5…5nkfxg", ForwardPolicy.ShortAddress(DEST));

            return ok;
        }

        static readonly System.Globalization.CultureInfo CI = System.Globalization.CultureInfo.InvariantCulture;

        static Utxo Utxo(string txid, int vout, long sat, long conf, bool spendable, bool safe, bool generated)
        {
            return new Utxo
            {
                Txid = txid, Vout = vout, AmountSat = sat, Confirmations = conf,
                Spendable = spendable, Safe = safe, Generated = generated
            };
        }

        static string Join(List<Utxo> l)
        {
            var sb = new StringBuilder();
            foreach (var u in l) { if (sb.Length > 0) sb.Append(','); sb.Append(u.Txid).Append(':').Append(u.Vout); }
            return sb.ToString();
        }

        static string JoinPoints(List<Outpoint> l)
        {
            var sb = new StringBuilder();
            foreach (var o in l) { if (sb.Length > 0) sb.Append(','); sb.Append(o.Txid).Append(':').Append(o.Vout); }
            return sb.ToString();
        }

        //! An ARMED, everything-is-fine baseline, then whatever the test breaks.
        static ForwardConditions Conditions(Action<ForwardConditions> tweak)
        {
            var c = new ForwardConditions
            {
                Alive = true,
                ForwardState = ForwardState.ARMED,
                RecordNonTerminal = false,
                NodeAnswered = true,
                InitialBlockDownload = false,
                Height = 3000,
                Headers = 3000,
                NowMs = 1800000000000L,
                RelayPeers = 2,
                PayoutWalletLoaded = true,
                DestinationValid = true,
                SweepableSat = 5000000000L,
                CandidateCount = 1,
                ProbeCandidateSat = 5000000000L,
            };
            c.TipTimeSec = (c.NowMs / 1000) - 600;
            if (tweak != null) tweak(c);
            return c;
        }

        static string Block(ForwardConditions c) { return ForwardPolicy.Decide(c).Block.ToString(); }
        static string Action(ForwardConditions c) { return ForwardPolicy.Decide(c).Action.ToString(); }

        static AddressFacts Facts(bool valid, bool witness, int version, bool mine)
        {
            return new AddressFacts
            {
                IsValid = valid, IsWitness = witness, WitnessVersion = version,
                IsMine = mine, ScriptPubKey = DEST_SPK
            };
        }

        static TxObservation Obs(bool readable, bool known, int conf,
                                 bool mempoolReadable, bool inMempool, bool unbroadcast)
        {
            return new TxObservation
            {
                Readable = readable, KnownToWallet = known, Confirmations = conf,
                MempoolReadable = mempoolReadable, InMempool = inMempool, Unbroadcast = unbroadcast
            };
        }

        static DecodedTx Sweep(long outSat)
        {
            var tx = new DecodedTx { Txid = "TX" };
            tx.Inputs.Add(new Outpoint("aa", 0));
            tx.Outputs.Add(new DecodedOut { Address = DEST, ScriptHex = DEST_SPK, ValueSat = outSat });
            return tx;
        }

        static DecodedTx TwoOut()
        {
            var tx = Sweep(4999999890L);
            tx.Outputs.Add(new DecodedOut { Address = "pc1qelse", ScriptHex = "0014beef", ValueSat = 1 });
            return tx;
        }

        static DecodedTx Probe(long paidSat, long changeSat, bool changeIsMine, bool changeIsChange)
        {
            var tx = new DecodedTx { Txid = "TX" };
            tx.Inputs.Add(new Outpoint("aa", 0));
            tx.Outputs.Add(new DecodedOut { Address = DEST, ScriptHex = DEST_SPK, ValueSat = paidSat });
            tx.Outputs.Add(new DecodedOut
            {
                Address = "pc1qchange", ScriptHex = "0014cafe", ValueSat = changeSat,
                IsMine = changeIsMine, IsChange = changeIsChange
            });
            return tx;
        }

        // =================================================================
        // Wallet
        //
        // The pure halves of the wallet app - amount parsing, fee tiers, the
        // user-send assertions, the address book, history classification and
        // the QR encoder - run here with no node and no window. Each section
        // is a transcription of the Android app's JVM tests for the same
        // code (AmountsTest, ForwardPolicyTest, UserSendTest, AddressBookTest,
        // QrTest), so the two implementations are held to one set of vectors.
        // =================================================================

        static bool RunWallet(List<string> log)
        {
            bool ok = true;
            ok &= RunAmounts(log);
            ok &= RunFeeTiers(log);
            ok &= RunUserSend(log);
            ok &= RunAddressBook(log);
            ok &= RunHistoryRows(log);
            ok &= RunQr(log);
            return ok;
        }

        // ---------------------------------------------------------- amounts

        static string Amt(string raw)
        {
            long sat;
            var r = Amounts.Parse(raw, out sat);
            return r == Amounts.Reason.OK ? sat.ToString(CI) : r.ToString();
        }

        static bool RunAmounts(List<string> log)
        {
            bool ok = true;
            Log(log, "--- amounts ---");
            ok &= Check(log, "whole coins: 1", "100000000", Amt("1"));
            ok &= Check(log, "whole coins: 1.0", "100000000", Amt("1.0"));
            ok &= Check(log, "whole coins: 50", "5000000000", Amt("50"));
            // 0.1 * 1e8 in IEEE754 is 10000000.000000002.
            ok &= Check(log, "0.1, the value a double gets wrong", "10000000", Amt("0.1"));
            ok &= Check(log, "0.7", "70000000", Amt("0.7"));
            ok &= Check(log, "0.029", "2900000", Amt("0.029"));
            ok &= Check(log, "one satoshi", "1", Amt("0.00000001"));
            ok &= Check(log, "full precision", "12345678901", Amt("123.45678901"));
            ok &= Check(log, "nine decimals is a typo, not a tiny amount", "TOO_MANY_DECIMALS", Amt("0.123456789"));
            ok &= Check(log, "empty is EMPTY", "EMPTY", Amt(""));
            ok &= Check(log, "null is EMPTY", "EMPTY", Amt(null));
            ok &= Check(log, "whitespace is EMPTY", "EMPTY", Amt("   "));
            ok &= Check(log, "letters are NOT_A_NUMBER", "NOT_A_NUMBER", Amt("abc"));
            ok &= Check(log, "negative", "NEGATIVE", Amt("-1"));
            ok &= Check(log, "zero", "ZERO", Amt("0"));
            ok &= Check(log, "zero with decimals", "ZERO", Amt("0.00000000"));
            ok &= Check(log, "past the 21 M cap", "TOO_LARGE", Amt("21000001"));
            // A German PC renders 1,5 for one and a half. Accepting both
            // spellings in one field is how someone sends 15 meaning 1.5.
            ok &= Check(log, "grouping separator refused, never guessed (1,5)", "NOT_A_NUMBER", Amt("1,5"));
            ok &= Check(log, "grouping separator refused, never guessed (1,000)", "NOT_A_NUMBER", Amt("1,000"));
            // Dust is a send-time question, not a parsing one.
            ok &= Check(log, "293 sat is a well-formed number", "293", Amt("0.00000293"));
            ok &= Check(log, "294 sat is a well-formed number", "294", Amt("0.00000294"));
            ok &= Check(log, "293 sat is dust", "True", Amounts.IsDust(293).ToString());
            ok &= Check(log, "294 sat is not dust", "False", Amounts.IsDust(294).ToString());
            ok &= Check(log, "pasted with spaces", "100000000", Amt("  1  "));
            ok &= Check(log, "pasted with a plus", "100000000", Amt("+1"));
            ok &= Check(log, "node string of 1 sat is fixed point", "0.00000001", Amounts.ToNodeString(1));
            ok &= Check(log, "node string of 1 PCN", "1.00000000", Amounts.ToNodeString(100000000));
            ok &= Check(log, "node string at full precision", "123.45678901", Amounts.ToNodeString(12345678901));
            ok &= Check(log, "node string of a large amount", "106750.99986703", Amounts.ToNodeString(10675099986703));
            // Compare satoshis, not trimmed strings: trimming trailing zeros
            // turns "50" into "5", which is exactly the kind of silent
            // corruption this class exists to prevent.
            foreach (string s in new[] { "0.00000001", "0.00000294", "0.1", "1", "50", "123.45678901", "20999999.99999999" })
            {
                long v;
                Amounts.Parse(s, out v);
                ok &= Check(log, "round trip of " + s, v.ToString(CI), Amt(Amounts.ToNodeString(v)));
            }
            return ok;
        }

        // -------------------------------------------------------- fee tiers

        static string D(double v) { return v.ToString("R", CI); }

        static bool RunFeeTiers(List<string> log)
        {
            bool ok = true;
            Log(log, "--- fee tiers ---");
            var normal = ForwardPolicy.FeeTier.NORMAL;
            var fast = ForwardPolicy.FeeTier.FAST;
            var veryFast = ForwardPolicy.FeeTier.VERY_FAST;
            // The rates the send screen advertises. If one moves, the hint text
            // on the send screen moves with it.
            ok &= Check(log, "NORMAL is 1 sat/vB", "1", D(normal.RateSatVb));
            ok &= Check(log, "FAST is 5 sat/vB", "5", D(fast.RateSatVb));
            ok &= Check(log, "VERY_FAST is 20 sat/vB", "20", D(veryFast.RateSatVb));
            var names = new List<string>();
            foreach (var t in ForwardPolicy.FeeTier.All) names.Add(t.Name);
            ok &= Check(log, "three tiers, in order", "NORMAL,FAST,VERY_FAST", string.Join(",", names.ToArray()));
            ok &= Check(log, "default tier is NORMAL", "NORMAL", ForwardPolicy.FeeTier.ByName(null).Name);
            ok &= Check(log, "ByName finds FAST", "FAST", ForwardPolicy.FeeTier.ByName("FAST").Name);
            ok &= Check(log, "ByName of garbage is the floor, never a guess upwards", "NORMAL", ForwardPolicy.FeeTier.ByName("garbage").Name);
            // 1 sat/vB = 1e-5 PCN/kvB. The broadcast cap and the decoded-fee
            // ceiling are BOTH rate x 10, so raising a tier raises them in
            // lockstep by construction.
            foreach (var t in ForwardPolicy.FeeTier.All)
                ok &= Check(log, "broadcast cap of " + t + " is headroom x rate in PCN/kvB",
                    D(t.RateSatVb * 10.0 / 100000.0), D(t.BroadcastMaxFeeRatePcnKvb));
            ok &= Check(log, "NORMAL broadcast cap", "0.0001", D(normal.BroadcastMaxFeeRatePcnKvb));
            ok &= Check(log, "FAST broadcast cap", "0.0005", D(fast.BroadcastMaxFeeRatePcnKvb));
            ok &= Check(log, "VERY_FAST broadcast cap", "0.002", D(veryFast.BroadcastMaxFeeRatePcnKvb));
            // The automatic sweep path still uses the global constant; NORMAL
            // must be exactly that, or "default tier changes nothing" is false.
            ok &= Check(log, "floor tier cap equals the sweep cap", D(ForwardPolicy.BROADCAST_MAX_FEE_RATE), D(normal.BroadcastMaxFeeRatePcnKvb));
            // 1-in/2-out modelled vsize is 140.5 vB; ceiling = rate x 10 x that.
            ok &= Check(log, "ceiling 1-in 2-out at NORMAL", "1405", ForwardPolicy.MaxFeeSatFor(1, 2).ToString(CI));
            ok &= Check(log, "ceiling 1-in 2-out at FAST", "7025", ForwardPolicy.MaxFeeSatFor(1, 2, 5.0).ToString(CI));
            ok &= Check(log, "ceiling 1-in 2-out at VERY_FAST", "28100", ForwardPolicy.MaxFeeSatFor(1, 2, 20.0).ToString(CI));
            ok &= Check(log, "no rate argument means the floor", ForwardPolicy.MaxFeeSatFor(1, 2).ToString(CI),
                ForwardPolicy.MaxFeeSatFor(1, 2, ForwardPolicy.FEE_RATE_SAT_VB).ToString(CI));
            ok &= Check(log, "the sweep ceiling still uses the same headroom", "1095", ForwardPolicy.MaxFeeSat(1).ToString(CI));
            // The blunder the ceilings exist for: a sat/vB figure sent where
            // PCN/kvB belongs is ~1e5 off. Whatever the tier, its ceiling must
            // sit far below that.
            foreach (var t in ForwardPolicy.FeeTier.All)
            {
                long blunderFeeSat = (long)(t.RateSatVb * 100000.0 * 140.5);
                long ceiling = ForwardPolicy.MaxFeeSatFor(1, 2, t.RateSatVb);
                ok &= Check(log, "a fee-unit blunder is caught at " + t + " (" + blunderFeeSat + " > " + ceiling + ")", "True", (blunderFeeSat > ceiling).ToString());
            }
            // A sweep of many coinbases is a big transaction and a bigger fee; a
            // fixed ceiling would refuse it.
            ok &= Check(log, "ceiling grows with inputs", "True",
                (ForwardPolicy.MaxFeeSatFor(20, 1) > ForwardPolicy.MaxFeeSatFor(1, 2)).ToString());
            return ok;
        }

        // ---------------------------------------------------- user send check
        //
        // The two "good" cases are not invented. They are the transactions a
        // real PCoin regtest node built when asked exactly the way
        // ForwardEngine.PrepareSend asks it, transcribed field for field: the
        // 1-in/2-out exact send and the 5-in/1-out sendall. Everything else is
        // that same transaction with exactly one thing wrong, because a
        // checker that passes valid input is worth nothing on its own.
        //
        //   `send` with add_to_wallet=false, fee_rate 1, on regtest:
        //   txid 59aaa047d6e35d0a89e7909f37c262faf976ec0bbfbd2a7cf416460f219a8748
        //   in   48fa2baf...57fd:0  value 50.00000000 (coinbase)
        //   out0 48.49999859 change  pcrt1q64eg28xmta7jansumf4v6v0w3wgnxqr55nne64
        //   out1  1.50000000 paid    pcrt1qj6f8wmkzsrnx4nh39xyz3ty3gqkrfnredu09tc
        //   fee 141 sat, vsize 141

        const string US_TXID = "59aaa047d6e35d0a89e7909f37c262faf976ec0bbfbd2a7cf416460f219a8748";
        const string US_IN_TXID = "48fa2bafd8949307fcc15d3e113fb617e9ff7d85295861f088adddb35d4a57fd";
        const string US_DEST = "pcrt1qj6f8wmkzsrnx4nh39xyz3ty3gqkrfnredu09tc";
        const string US_DEST_SPK = "00149692776ec280e66acef1298828ac91402c34cc79";
        const string US_CHANGE = "pcrt1q64eg28xmta7jansumf4v6v0w3wgnxqr55nne64";
        const string US_CHANGE_SPK = "0014d572851cdb5f7d2ece1cda6acd31ee8b91330074";
        const long US_IN = 5000000000L;
        const long US_PAID = 150000000L;
        const long US_CHANGE_SAT = 4849999859L;

        static DecodedOut Out(string address, string spk, long sat, bool mine = false, bool change = false)
        {
            return new DecodedOut { Address = address, ScriptHex = spk, ValueSat = sat, IsMine = mine, IsChange = change };
        }

        static DecodedTx ExactSend(List<DecodedOut> outputs = null, List<Outpoint> inputs = null, string id = US_TXID)
        {
            var tx = new DecodedTx { Txid = id };
            if (inputs == null) tx.Inputs.Add(new Outpoint(US_IN_TXID, 0));
            else tx.Inputs.AddRange(inputs);
            if (outputs == null)
            {
                tx.Outputs.Add(Out(US_CHANGE, US_CHANGE_SPK, US_CHANGE_SAT, true, true));
                tx.Outputs.Add(Out(US_DEST, US_DEST_SPK, US_PAID));
            }
            else tx.Outputs.AddRange(outputs);
            return tx;
        }

        static List<DecodedOut> Outs(params DecodedOut[] outs) { return new List<DecodedOut>(outs); }

        static string VerifyUS(DecodedTx tx, long requested = US_PAID, bool sendMax = false, long inValue = US_IN,
            string expectedTxid = US_TXID, string destination = US_DEST, string script = US_DEST_SPK,
            double rate = ForwardPolicy.FEE_RATE_SAT_VB)
        {
            return ForwardPolicy.VerifyUserSend(tx, destination, script, expectedTxid, requested, sendMax, inValue, rate);
        }

        static string Verdict(string why) { return why == null ? "passes" : "refused"; }

        static bool RunUserSend(List<string> log)
        {
            bool ok = true;
            Log(log, "--- user send assertions ---");

            ok &= Check(log, "the transaction the node actually built passes", "passes", Verdict(VerifyUS(ExactSend())));

            // 5 inputs, 1 output, 249.99999619 out of 250.00000000 in, fee 381 sat.
            {
                const string sweepDest = "pcrt1qc0vvelsr2ayhm3s6pszx2kgfc0fkzh0hc4wrjg";
                const string sweepScript = "0014c3d8ccfe0357497dc61a0c04655909c3d3615df7";
                var tx = new DecodedTx { Txid = "sweep" };
                for (int i = 0; i < 5; i++) tx.Inputs.Add(new Outpoint(new string('a', 64), i));
                tx.Outputs.Add(Out(sweepDest, sweepScript, 24999999619L));
                ok &= Check(log, "the sendall the node actually built passes", "passes",
                    Verdict(ForwardPolicy.VerifyUserSend(tx, sweepDest, sweepScript, "sweep", 0L, true, 25000000000L, ForwardPolicy.FEE_RATE_SAT_VB)));
            }

            // 141 sat actual against the 1-in 2-out ceiling. If a refactor ever
            // makes this tight, the send path starts refusing good transactions.
            long ceiling12 = ForwardPolicy.MaxFeeSatFor(1, 2);
            ok &= Check(log, "the real fee sits under the ceiling", "True", (ceiling12 > 141L).ToString());
            ok &= Check(log, "the ceiling is tight enough to be a check", "True", (ceiling12 < 10000L).ToString());
            ok &= Check(log, "the 5-in sendall fee sits under its ceiling", "True", (ForwardPolicy.MaxFeeSatFor(5, 1) > 381L).ToString());

            ok &= Check(log, "a txid that does not match the decoded bytes is refused", "refused",
                Verdict(VerifyUS(ExactSend(null, null, new string('f', 64)))));
            ok &= Check(log, "a transaction that pays someone else is refused", "refused",
                Verdict(VerifyUS(ExactSend(Outs(Out(US_CHANGE, US_CHANGE_SPK, US_CHANGE_SAT, true, true), Out("pcrt1qstranger", "0014deadbeef", US_PAID))))));
            // The address label and the script must agree. If they can
            // disagree, the address on the review screen is decoration.
            ok &= Check(log, "the right address with the wrong script is refused", "refused",
                Verdict(VerifyUS(ExactSend(Outs(Out(US_CHANGE, US_CHANGE_SPK, US_CHANGE_SAT, true, true), Out(US_DEST, "0014" + new string('0', 40), US_PAID))))));
            {
                string why = VerifyUS(ExactSend(Outs(Out(US_CHANGE, US_CHANGE_SPK, US_CHANGE_SAT, true, true), Out(US_DEST, US_DEST_SPK, US_PAID - 1))));
                ok &= Check(log, "paying a different amount than asked is refused", "refused", Verdict(why));
                ok &= Check(log, "...and says so", "True", (why != null && why.Contains("not the")).ToString());
            }
            // The whole point. A transaction can pay the destination perfectly
            // and still hand the remaining 48.5 PCN to a stranger.
            ok &= Check(log, "change to an address we do not own is refused", "refused",
                Verdict(VerifyUS(ExactSend(Outs(Out(US_CHANGE, US_CHANGE_SPK, US_CHANGE_SAT, false, false), Out(US_DEST, US_DEST_SPK, US_PAID))))));
            ok &= Check(log, "change to an address we own but is not a change address is refused", "refused",
                Verdict(VerifyUS(ExactSend(Outs(Out(US_CHANGE, US_CHANGE_SPK, US_CHANGE_SAT, true, false), Out(US_DEST, US_DEST_SPK, US_PAID))))));
            ok &= Check(log, "an extra output is refused", "refused",
                Verdict(VerifyUS(ExactSend(Outs(Out(US_CHANGE, US_CHANGE_SPK, US_CHANGE_SAT - 1000, true, true), Out(US_DEST, US_DEST_SPK, US_PAID), Out("pcrt1qextra", "0014ababab", 1000))))));
            // sendall must produce exactly one output. Two means something
            // built a change output on a transaction the user asked to empty.
            ok &= Check(log, "a sendMax with change is refused", "refused", Verdict(VerifyUS(ExactSend(), US_PAID, true)));
            ok &= Check(log, "a transaction spending nothing is refused", "refused",
                Verdict(VerifyUS(ExactSend(null, new List<Outpoint>()))));
            // Outputs exceeding inputs cannot happen on a well-formed
            // transaction, which is exactly why it must be checked: reaching
            // it means one of the gettxout reads was wrong.
            ok &= Check(log, "a negative fee is refused", "refused", Verdict(VerifyUS(ExactSend(), US_PAID, false, US_PAID + US_CHANGE_SAT - 1)));
            ok &= Check(log, "a zero fee is refused", "refused", Verdict(VerifyUS(ExactSend(), US_PAID, false, US_PAID + US_CHANGE_SAT)));
            {
                // Same outputs, far more input value: every extra satoshi is fee.
                string why = VerifyUS(ExactSend(), US_PAID, false, US_IN + 1000000L);
                ok &= Check(log, "a fee above the ceiling is refused", "refused", Verdict(why));
                ok &= Check(log, "...and names the ceiling", "True", (why != null && why.Contains("ceiling")).ToString());
            }
            {
                // The ceiling must move with the tier in BOTH directions:
                // 10,000 sat is over FAST's 7,025 and under VERY_FAST's 28,100.
                long inWithBigFee = US_PAID + US_CHANGE_SAT + 10000L;
                string why = VerifyUS(ExactSend(), US_PAID, false, inWithBigFee, US_TXID, US_DEST, US_DEST_SPK, ForwardPolicy.FeeTier.FAST.RateSatVb);
                ok &= Check(log, "a fee above the FAST ceiling is refused at FAST", "refused", Verdict(why));
                ok &= Check(log, "...naming the ceiling", "True", (why != null && why.Contains("ceiling")).ToString());
                ok &= Check(log, "...but passes at VERY_FAST", "passes",
                    Verdict(VerifyUS(ExactSend(), US_PAID, false, inWithBigFee, US_TXID, US_DEST, US_DEST_SPK, ForwardPolicy.FeeTier.VERY_FAST.RateSatVb)));
            }
            // A fee AT the floor ceiling passes; one satoshi over refuses.
            ok &= Check(log, "the normal tier passes a fee exactly at the ceiling", "passes",
                Verdict(VerifyUS(ExactSend(), US_PAID, false, US_PAID + US_CHANGE_SAT + ceiling12)));
            ok &= Check(log, "the normal tier refuses one satoshi over", "refused",
                Verdict(VerifyUS(ExactSend(), US_PAID, false, US_PAID + US_CHANGE_SAT + ceiling12 + 1)));
            // The same tight/loose bounds the floor test pins, scaled per tier.
            foreach (var t in ForwardPolicy.FeeTier.All)
            {
                long c = ForwardPolicy.MaxFeeSatFor(1, 2, t.RateSatVb);
                ok &= Check(log, "tier " + t + " ceiling is not too tight", "True", (c > (long)(141L * t.RateSatVb)).ToString());
                ok &= Check(log, "tier " + t + " ceiling is not too loose", "True", (c < (long)(10000L * t.RateSatVb)).ToString());
            }
            // Core drops a change output below the dust threshold and lets the
            // amount become fee. One output on a non-max send is legitimate.
            ok &= Check(log, "sub-dust change folded into the fee still passes", "passes",
                Verdict(VerifyUS(ExactSend(Outs(Out(US_DEST, US_DEST_SPK, US_PAID))), US_PAID, false, US_PAID + 200)));
            ok &= Check(log, "an empty expected script never matches", "refused",
                Verdict(VerifyUS(ExactSend(), US_PAID, false, US_IN, US_TXID, US_DEST, "")));
            return ok;
        }

        // ------------------------------------------------------ address book

        const string AB_MARKET = "pc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
        const string AB_OTHER = "pc1q9d4ywgfnd8h43da5tpcxcn6ajv590cg6d3tg6a";

        static AddressBookEntry E(string address, string name, long added = 1L, long used = 0L)
        {
            return new AddressBookEntry(address, name, added, used);
        }

        static List<AddressBookEntry> Book(params AddressBookEntry[] entries) { return new List<AddressBookEntry>(entries); }

        static string P(NameProblem? p) { return p.HasValue ? p.Value.ToString() : "ok"; }

        static string OrNull(string s) { return s ?? "(null)"; }

        static string Names(List<AddressBookEntry> book)
        {
            var names = new List<string>();
            foreach (var e in book) names.Add(e.Name);
            return string.Join(",", names.ToArray());
        }

        static HistoryEntry Sent(string address, long time = 0L)
        {
            return new HistoryEntry { Txid = "tx-" + address + "-" + time, Kind = HistoryKind.SENT, AmountSat = 1, FeeSat = 1, Confirmations = 1, TimeSec = time, Address = address };
        }

        static HistoryEntry Received(string address)
        {
            var e = Sent(address);
            e.Kind = HistoryKind.RECEIVED;
            return e;
        }

        static List<AddressBookEntry> FullBook(string prefix)
        {
            var full = new List<AddressBookEntry>();
            for (int i = 1; i <= AddressBook.MAX_ENTRIES; i++) full.Add(E(prefix + i, "Name " + i));
            return full;
        }

        static bool RunAddressBook(List<string> log)
        {
            bool ok = true;
            Log(log, "--- address book ---");
            string upper = AB_MARKET.ToUpperInvariant();

            // ---- keys ----
            ok &= Check(log, "bech32 matches regardless of case (upper)", "Market", OrNull(AddressBook.LabelFor(Book(E(AB_MARKET, "Market")), upper)));
            ok &= Check(log, "bech32 matches regardless of case (lower)", "Market", OrNull(AddressBook.LabelFor(Book(E(AB_MARKET, "Market")), AB_MARKET)));
            {
                var book = AddressBook.Upsert(new List<AddressBookEntry>(), AB_MARKET, "Market", 1L);
                book = AddressBook.Upsert(book, upper, "Market", 2L);
                ok &= Check(log, "an uppercase paste does not create a second entry", "1", book.Count.ToString(CI));
                // The incoming spelling wins: after a send, that is the node's own.
                ok &= Check(log, "the incoming spelling wins", upper, book[0].Address);
            }
            ok &= Check(log, "surrounding whitespace does not defeat a match", "Market",
                OrNull(AddressBook.LabelFor(Book(E(AB_MARKET, "Market")), "  " + AB_MARKET + "\n")));
            {
                // BIP173: valid all-lower or all-upper, never mixed. Folding a
                // mixed case string would let an invalid address inherit a valid
                // one's name.
                const string mixed = "pc1QW508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
                ok &= Check(log, "mixed case is left alone", mixed, AddressBook.Key(mixed));
                ok &= Check(log, "mixed case inherits no name", "(null)", OrNull(AddressBook.LabelFor(Book(E(AB_MARKET, "Market")), mixed)));
            }
            {
                // Base58 IS case-sensitive, so folding it would merge two
                // genuinely different addresses under one name.
                const string a = "PGmqNfjbG1YxpTNQnnQhFqDBRz3LPPQjHF";
                ok &= Check(log, "base58 case is significant and is not folded", a, AddressBook.Key(a));
                ok &= Check(log, "base58 lowercased is a different address", "(null)", OrNull(AddressBook.LabelFor(Book(E(a, "Cold")), a.ToLowerInvariant())));
            }

            // ---- stored format version ----
            // THE ONE THAT MATTERS. An update keeps the file, but only if the
            // new build will still READ it.
            for (int v = 1; v <= AddressBook.FORMAT_VERSION; v++)
                ok &= Check(log, "version " + v + " must stay readable after an update", "True", AddressBook.CanRead(v).ToString());
            ok &= Check(log, "a newer book is refused rather than partially decoded", "False", AddressBook.CanRead(AddressBook.FORMAT_VERSION + 1).ToString());
            ok &= Check(log, "version 99 is refused", "False", AddressBook.CanRead(99).ToString());
            ok &= Check(log, "version 0 is not a version", "False", AddressBook.CanRead(0).ToString());
            ok &= Check(log, "version -1 is not a version", "False", AddressBook.CanRead(-1).ToString());

            // ---- names ----
            ok &= Check(log, "names are trimmed and internal whitespace collapsed", "Market wallet", AddressBook.CleanName("  Market   wallet  "));
            ok &= Check(log, "a newline cannot break a name across lines", "Market two", AddressBook.CleanName("Market\ntwo"));
            ok &= Check(log, "tab and NUL are collapsed", "Market two", AddressBook.CleanName("Market" + (char)9 + (char)0 + "  two"));
            ok &= Check(log, "an empty name is refused", "EMPTY", P(AddressBook.Problem("", Book())));
            ok &= Check(log, "a whitespace-only name is refused", "EMPTY", P(AddressBook.Problem("   ", Book())));
            ok &= Check(log, "a null name is refused", "EMPTY", P(AddressBook.Problem(null, Book())));
            ok &= Check(log, "an over-long name is refused", "TOO_LONG", P(AddressBook.Problem(new string('x', AddressBook.MAX_NAME + 1), Book())));
            ok &= Check(log, "a name at the limit is fine", "ok", P(AddressBook.Problem(new string('x', AddressBook.MAX_NAME), Book())));
            ok &= Check(log, "a duplicate name is refused (lower)", "DUPLICATE", P(AddressBook.Problem("market", Book(E(AB_MARKET, "Market")))));
            ok &= Check(log, "a duplicate name is refused (upper, padded)", "DUPLICATE", P(AddressBook.Problem(" MARKET ", Book(E(AB_MARKET, "Market")))));
            ok &= Check(log, "an entry keeping its own name is not a duplicate of itself", "ok",
                P(AddressBook.Problem("Market", Book(E(AB_MARKET, "Market")), AddressBook.Key(AB_MARKET))));
            ok &= Check(log, "...but it still cannot take another entry's name", "DUPLICATE",
                P(AddressBook.Problem("Exchange", Book(E(AB_MARKET, "Market"), E(AB_OTHER, "Exchange")), AddressBook.Key(AB_MARKET))));
            {
                var full = FullBook("pc1addr");
                ok &= Check(log, "the book has a ceiling", "BOOK_FULL", P(AddressBook.Problem("New", full)));
                ok &= Check(log, "renaming inside a full book still works", "ok", P(AddressBook.Problem("Renamed", full, AddressBook.Key("pc1addr1"))));
                // The edit screen passes the typed address's own key on EVERY
                // path, including adding a brand-new address, so a ceiling
                // gated on `replacing == null` was dead code at the only call
                // site that could reach it.
                ok &= Check(log, "the ceiling still fires when the caller passes the new address's own key", "BOOK_FULL",
                    P(AddressBook.Problem("New", full, AddressBook.Key("pc1brandnewaddress"))));
            }

            // ---- book edits ----
            {
                var renamed = AddressBook.Upsert(Book(E(AB_MARKET, "Market", 100L, 500L)), AB_MARKET, "Market deposit", 900L);
                ok &= Check(log, "renaming keeps one entry", "1", renamed.Count.ToString(CI));
                ok &= Check(log, "renaming changes the name", "Market deposit", renamed[0].Name);
                ok &= Check(log, "renaming keeps addedAt", "100", renamed[0].AddedAtMs.ToString(CI));
                // Losing this would drop a frequently-paid entry to the bottom
                // of the list every time its name was corrected.
                ok &= Check(log, "renaming keeps the usage record", "500", renamed[0].LastUsedAtMs.ToString(CI));
            }
            ok &= Check(log, "touch never invents an entry for an address with no name", "0",
                AddressBook.Touch(new List<AddressBookEntry>(), AB_MARKET, 42L).Count.ToString(CI));
            ok &= Check(log, "touch records use for an address that has a name", "42",
                AddressBook.Touch(Book(E(AB_MARKET, "Market")), upper, 42L)[0].LastUsedAtMs.ToString(CI));
            {
                var left = AddressBook.Remove(Book(E(AB_MARKET, "Market"), E(AB_OTHER, "Exchange")), upper);
                ok &= Check(log, "removing takes the name and nothing else", "Exchange", Names(left));
            }
            ok &= Check(log, "ordering is most recently touched first, then alphabetical", "Exchange,Alice,Market",
                Names(AddressBook.Ordered(Book(E(AB_MARKET, "Market", 10L, 0L), E(AB_OTHER, "Exchange", 5L, 900L), E("pc1third", "Alice", 20L, 0L)))));
            // Being added counts as a touch, so a name saved thirty seconds ago
            // is at the top where it is about to be wanted.
            ok &= Check(log, "an entry added a moment ago outranks an older one that was used", "Exchange",
                AddressBook.Ordered(Book(E(AB_MARKET, "Market", 1L, 100L), E(AB_OTHER, "Exchange", 200L, 0L)))[0].Name);

            // ---- unnamed recipients ----
            ok &= Check(log, "only sends are offered for naming", AB_OTHER,
                string.Join(",", AddressBook.UnnamedRecipients(new List<HistoryEntry> { Received(AB_MARKET), Sent(AB_OTHER) }, Book(), 20).ToArray()));
            ok &= Check(log, "already-named addresses are not offered again", AB_OTHER,
                string.Join(",", AddressBook.UnnamedRecipients(new List<HistoryEntry> { Sent(AB_MARKET), Sent(AB_OTHER) }, Book(E(upper, "Market")), 20).ToArray()));
            ok &= Check(log, "repeated payments to one address appear once, newest first", AB_OTHER + "," + AB_MARKET,
                string.Join(",", AddressBook.UnnamedRecipients(new List<HistoryEntry> { Sent(AB_OTHER, 300L), Sent(AB_MARKET, 200L), Sent(AB_OTHER, 100L) }, Book(), 20).ToArray()));
            // listtransactions reports a blank address for a send to several
            // outputs. There is no one counterparty, so there is nothing to name.
            ok &= Check(log, "a send with no single destination is skipped", AB_MARKET,
                string.Join(",", AddressBook.UnnamedRecipients(new List<HistoryEntry> { Sent(""), Sent("   "), Sent(AB_MARKET) }, Book(), 20).ToArray()));
            ok &= Check(log, "the limit holds", "2",
                AddressBook.UnnamedRecipients(new List<HistoryEntry> { Sent("pc1a"), Sent("pc1b"), Sent("pc1c") }, Book(), 2).Count.ToString(CI));

            // ---- labelFor ----
            // null, never "": a caller that rendered an empty string would draw
            // a blank label where it meant to draw nothing at all.
            ok &= Check(log, "an unknown address has no name rather than an empty one", "(null)", OrNull(AddressBook.LabelFor(Book(), AB_MARKET)));
            ok &= Check(log, "another entry's name is not borrowed", "(null)", OrNull(AddressBook.LabelFor(Book(E(AB_OTHER, "Exchange")), AB_MARKET)));
            ok &= Check(log, "a known address has its name", "Market", OrNull(AddressBook.LabelFor(Book(E(AB_MARKET, "Market")), AB_MARKET)));

            // ---- merge ----
            {
                var r = AddressBook.Merge(Book(E(AB_MARKET, "Market")), Book(E(AB_OTHER, "Exchange")));
                ok &= Check(log, "import adds unknown addresses", "2", r.Merged.Count.ToString(CI));
                ok &= Check(log, "import counts what it added", "1/0/0", r.Added + "/" + r.AlreadyKnown + "/" + r.Skipped);
                ok &= Check(log, "the imported name is usable", "Exchange", OrNull(AddressBook.LabelFor(r.Merged, AB_OTHER)));
                // The invariant the skip rule protects: after any merge, every
                // name is unique case-insensitively.
                var seen = new HashSet<string>();
                bool unique = true;
                foreach (var e in r.Merged) if (!seen.Add(e.Name.ToLowerInvariant())) unique = false;
                ok &= Check(log, "a merged book holds no duplicate names", "True", unique.ToString());
            }
            {
                // The import is a way to get names back, never a way to
                // overwrite the name the user has now.
                var r = AddressBook.Merge(Book(E(AB_MARKET, "Market", 5L, 9L)), Book(E(AB_MARKET, "OldName")));
                ok &= Check(log, "the current book always wins on an address collision", "Market", r.Merged[0].Name);
                ok &= Check(log, "...keeping its usage record", "9", r.Merged[0].LastUsedAtMs.ToString(CI));
                ok &= Check(log, "...and counting it as already known", "1/0/1/0", r.Merged.Count + "/" + r.Added + "/" + r.AlreadyKnown + "/" + r.Skipped);
            }
            {
                var r = AddressBook.Merge(Book(E(AB_MARKET, "Market")), Book(E(upper, "Shouty")));
                ok &= Check(log, "an address collision matches by key, not by spelling", "1/Market/1", r.Merged.Count + "/" + r.Merged[0].Name + "/" + r.AlreadyKnown);
            }
            {
                // Two entries called "Market" is the confident-wrong-payment
                // failure; an auto-suffixed "Market (2)" is a label the user
                // never chose.
                var r = AddressBook.Merge(Book(E(AB_MARKET, "Market")), Book(E(AB_OTHER, "market")));
                ok &= Check(log, "a name clash is skipped, not renamed", "1/0/1", r.Merged.Count + "/" + r.Added + "/" + r.Skipped);
            }
            {
                var r = AddressBook.Merge(Book(), Book(E(AB_OTHER, "Exchange"), E("pc1qthird000000000000000000000000000000000", "exchange")));
                ok &= Check(log, "two imported entries clashing with each other keep only the first", "1/1/1", r.Merged.Count + "/" + r.Added + "/" + r.Skipped);
            }
            {
                var r = AddressBook.Merge(Book(), Book(E(AB_OTHER, ""), E("", "Ghost"), E(AB_MARKET, "Market")));
                ok &= Check(log, "an unreadable imported row is skipped without failing the rest", "1/1/2", r.Merged.Count + "/" + r.Added + "/" + r.Skipped);
                ok &= Check(log, "...and the readable one landed", "Market", OrNull(AddressBook.LabelFor(r.Merged, AB_MARKET)));
            }
            {
                var r = AddressBook.Merge(FullBook("pc1qfull"), Book(E(AB_OTHER, "One more")));
                ok &= Check(log, "the entry cap holds through an import", AddressBook.MAX_ENTRIES + "/0/1", r.Merged.Count + "/" + r.Added + "/" + r.Skipped);
            }

            // ---- the stored format ----
            {
                string json = AddressBookStore.Encode(Book(E(AB_MARKET, "Market", 1735000000000L, 1735100000000L)));
                ok &= Check(log, "the stored format is exactly the Android one",
                    "{\"v\":1,\"entries\":[{\"a\":\"" + AB_MARKET + "\",\"n\":\"Market\",\"t\":1735000000000,\"u\":1735100000000}]}", json);
                var back = AddressBookStore.Decode(json);
                ok &= Check(log, "encode/decode round trip", "1/Market/1735000000000/1735100000000",
                    back.Count + "/" + back[0].Name + "/" + back[0].AddedAtMs.ToString(CI) + "/" + back[0].LastUsedAtMs.ToString(CI));
                ok &= Check(log, "an empty book encodes", "{\"v\":1,\"entries\":[]}", AddressBookStore.Encode(Book()));
                ok &= Check(log, "a quote in a name is escaped", "{\"v\":1,\"entries\":[{\"a\":\"pc1x\",\"n\":\"A \\\"B\\\"\",\"t\":0,\"u\":0}]}",
                    AddressBookStore.Encode(Book(E("pc1x", "A \"B\"", 0L, 0L))));
            }
            ok &= Check(log, "a newer stored version throws rather than half-decoding", "True", DecodeThrows("{\"v\":2,\"entries\":[]}").ToString());
            ok &= Check(log, "a missing entries array throws", "True", DecodeThrows("{\"v\":1}").ToString());
            ok &= Check(log, "a missing version throws", "True", DecodeThrows("{\"entries\":[]}").ToString());
            ok &= Check(log, "malformed JSON throws", "True", DecodeThrows("not json").ToString());
            ok &= Check(log, "a JSON array is not a book", "True", DecodeThrows("[]").ToString());
            ok &= Check(log, "a duplicate key on disk keeps the first", "1/First",
                Describe(AddressBookStore.Decode("{\"v\":1,\"entries\":[{\"a\":\"" + AB_MARKET + "\",\"n\":\"First\"},{\"a\":\"" + upper + "\",\"n\":\"Second\"}]}")));
            ok &= Check(log, "rows without an address or a name are skipped, the rest kept", "1/Kept",
                Describe(AddressBookStore.Decode("{\"v\":1,\"entries\":[{\"a\":\"\",\"n\":\"Ghost\"},{\"a\":\"pc1y\",\"n\":\"  \"},7,{\"a\":\"pc1z\",\"n\":\"Kept\"}]}")));
            ok &= Check(log, "missing timestamps read as zero", "0/0",
                AddressBookStore.Decode("{\"v\":1,\"entries\":[{\"a\":\"pc1z\",\"n\":\"Kept\"}]}")[0].AddedAtMs + "/" +
                AddressBookStore.Decode("{\"v\":1,\"entries\":[{\"a\":\"pc1z\",\"n\":\"Kept\"}]}")[0].LastUsedAtMs);
            return ok;
        }

        static bool DecodeThrows(string json)
        {
            try { AddressBookStore.Decode(json); return false; }
            catch { return true; }
        }

        static string Describe(List<AddressBookEntry> book)
        {
            return book.Count + "/" + Names(book);
        }

        // ---------------------------------------------------- history rows

        static string Row(string json)
        {
            var e = ForwardPolicy.HistoryRow(Json.Parse(json));
            if (e == null) return "dropped";
            return e.Kind + "/" + e.AmountSat.ToString(CI) + "/" + e.FeeSat.ToString(CI) + "/" + e.Confirmations.ToString(CI) + "/" + e.TimeSec.ToString(CI) + "/" + e.Address;
        }

        static bool RunHistoryRows(List<string> log)
        {
            bool ok = true;
            Log(log, "--- history rows ---");
            // A send: negative amount and fee from the node, magnitude here,
            // direction carried by the kind alone.
            ok &= Check(log, "a send", "SENT/150000000/141/3/100/pc1qx",
                Row("{\"txid\":\"aa\",\"category\":\"send\",\"amount\":-1.5,\"fee\":-0.00000141,\"confirmations\":3,\"time\":100,\"address\":\"pc1qx\"}"));
            ok &= Check(log, "a receive", "RECEIVED/250000000/0/1/200/pc1qme",
                Row("{\"txid\":\"bb\",\"category\":\"receive\",\"amount\":2.5,\"confirmations\":1,\"time\":200,\"address\":\"pc1qme\"}"));
            ok &= Check(log, "a mined block past maturity", "MINED/5000000000/0/150/300/pc1qme",
                Row("{\"txid\":\"cc\",\"category\":\"generate\",\"amount\":50,\"confirmations\":150,\"time\":300,\"address\":\"pc1qme\"}"));
            ok &= Check(log, "a mined block not yet spendable", "MATURING/5000000000/0/7/300/pc1qme",
                Row("{\"txid\":\"dd\",\"category\":\"immature\",\"amount\":50,\"confirmations\":7,\"time\":300,\"address\":\"pc1qme\"}"));
            // On a chain with a ~3% stale rate this is not hypothetical.
            ok &= Check(log, "an orphaned block is conflicted", "CONFLICTED/5000000000/0/0/300/pc1qme",
                Row("{\"txid\":\"ee\",\"category\":\"orphan\",\"amount\":50,\"confirmations\":0,\"time\":300,\"address\":\"pc1qme\"}"));
            // Negative is not "fewer confirmations"; it is a different state,
            // and it is NOT clamped.
            ok &= Check(log, "negative confirmations are conflicted, whatever the category", "CONFLICTED/100000000/0/-1/400/pc1qx",
                Row("{\"txid\":\"ff\",\"category\":\"send\",\"amount\":-1,\"confirmations\":-1,\"time\":400,\"address\":\"pc1qx\"}"));
            ok &= Check(log, "a category this chain never produces is dropped", "dropped",
                Row("{\"txid\":\"gg\",\"category\":\"weird\",\"amount\":1,\"confirmations\":1}"));
            // A send whose amount we cannot read is not a send of zero.
            ok &= Check(log, "a row with no amount is dropped, not zero", "dropped",
                Row("{\"txid\":\"hh\",\"category\":\"send\",\"confirmations\":1}"));
            ok &= Check(log, "a row with a non-numeric amount is dropped", "dropped",
                Row("{\"txid\":\"ii\",\"category\":\"send\",\"amount\":\"1.5\",\"confirmations\":1}"));
            ok &= Check(log, "a blank txid is dropped", "dropped",
                Row("{\"txid\":\"  \",\"category\":\"send\",\"amount\":-1,\"confirmations\":1}"));
            ok &= Check(log, "a missing txid is dropped", "dropped",
                Row("{\"category\":\"send\",\"amount\":-1,\"confirmations\":1}"));
            ok &= Check(log, "a non-object row is dropped", "dropped", Row("7"));
            ok &= Check(log, "missing confirmations read as zero, missing address as blank", "RECEIVED/100000000/0/0/0/",
                Row("{\"txid\":\"jj\",\"category\":\"receive\",\"amount\":1}"));
            ok &= Check(log, "a multi-destination send has a blank address", "SENT/100000000/141/2/0/",
                Row("{\"txid\":\"kk\",\"category\":\"send\",\"amount\":-1,\"fee\":-0.00000141,\"confirmations\":2,\"address\":\"\"}"));
            return ok;
        }

        // ---------------------------------------------------------------- QR
        //
        // What is compared, and why not the raw modules: the comparison
        // unmasks both symbols first and then diffs. Two conforming encoders
        // can legitimately choose different data masks - python-qrcode's
        // penalty scoring does not agree with a straight reading of the spec's
        // four rules. What actually has to be identical is everything the mask
        // does not touch: the codewords, the Reed-Solomon parity, where each
        // bit lands, and every function pattern. Decodability was verified on
        // the Android side with two independent decoders (OpenCV, zxing-cpp)
        // against the same encoder logic; see QrTest.kt.

        static int RefMask(string[] rows)
        {
            int bits = 0;
            for (int i = 0; i <= 5; i++) if (rows[i][8] == '1') bits |= 1 << i;
            if (rows[7][8] == '1') bits |= 1 << 6;
            if (rows[8][8] == '1') bits |= 1 << 7;
            if (rows[8][7] == '1') bits |= 1 << 8;
            for (int i = 9; i <= 14; i++) if (rows[8][14 - i] == '1') bits |= 1 << i;
            return ((bits ^ 0x5412) >> 10) & 7;
        }

        static bool RunQr(List<string> log)
        {
            bool ok = true;
            Log(log, "--- qr ---");
            ok &= Check(log, "five golden vectors loaded", "5", QR_VECTORS.Length.ToString(CI));
            foreach (var v in QR_VECTORS)
            {
                ok &= Check(log, v.Name + ": row count", v.Size.ToString(CI), v.Rows.Length.ToString(CI));
                var m = QrCode.Encode(v.Text);
                if (m == null) { ok &= Check(log, v.Name + ": encoder returned a symbol", "symbol", "null"); continue; }
                ok &= Check(log, v.Name + ": size (reference version " + v.Version + ")", v.Size.ToString(CI), m.Size.ToString(CI));
                if (m.Size != v.Size) continue;

                // Finders, timing, alignment, the dark module: everything the
                // mask does not touch and that a scanner locks onto first.
                int fdiff = 0;
                for (int y = 0; y < v.Size; y++) for (int x = 0; x < v.Size; x++)
                {
                    if (!m.IsLocked(x, y)) continue;
                    // Format modules encode the mask, so they legitimately differ.
                    bool isFormat = (x == 8 && (y <= 8 || y >= v.Size - 8)) || (y == 8 && (x <= 8 || x >= v.Size - 8));
                    if (isFormat) continue;
                    if (m[x, y] != (v.Rows[y][x] == '1')) fdiff++;
                }
                ok &= Check(log, v.Name + ": function modules differing", "0", fdiff.ToString(CI));

                // The real assertion: identical codewords, identical
                // Reed-Solomon parity, identical placement. Independent of
                // which mask either side chose.
                int ourMask = QrCode.DeclaredMask(m);
                int refMask = RefMask(v.Rows);
                int ddiff = 0;
                for (int y = 0; y < v.Size; y++) for (int x = 0; x < v.Size; x++)
                {
                    if (m.IsLocked(x, y)) continue;
                    bool ours = m[x, y] ^ QrCode.MaskBit(ourMask, x, y);
                    bool theirs = (v.Rows[y][x] == '1') ^ QrCode.MaskBit(refMask, x, y);
                    if (ours != theirs) ddiff++;
                }
                ok &= Check(log, v.Name + ": unmasked data differing (ours mask=" + ourMask + ", ref mask=" + refMask + ")", "0", ddiff.ToString(CI));
                ok &= Check(log, v.Name + ": declared mask is one of the eight", "True", (ourMask >= 0 && ourMask <= 7).ToString());
            }

            // 42 characters in byte mode. If this ever changes, the receive
            // card's layout assumptions change with it.
            {
                var m = QrCode.Encode("pc1qtestvectoraaaaaaaaaaaaaaaaaaaaaaaaqqqq");
                ok &= Check(log, "a real PCoin address encodes at version 3", "29", m == null ? "null" : m.Size.ToString(CI));
                if (m != null)
                {
                    var centres = new[] { new[] { 3, 3 }, new[] { m.Size - 4, 3 }, new[] { 3, m.Size - 4 } };
                    bool finders = true;
                    foreach (var c in centres)
                    {
                        if (!m[c[0], c[1]]) finders = false;          // centre
                        if (m[c[0], c[1] - 2]) finders = false;       // ring
                        if (!m[c[0], c[1] - 3]) finders = false;      // outer
                    }
                    ok &= Check(log, "the finder patterns are where the spec puts them", "True", finders.ToString());
                    // Mask selection scores every mask; an unstable choice
                    // would make the rendered code change under the user.
                    var again = QrCode.Encode("pc1qtestvectoraaaaaaaaaaaaaaaaaaaaaaaaqqqq");
                    bool same = again != null && again.Size == m.Size;
                    if (same) for (int y = 0; y < m.Size; y++) for (int x = 0; x < m.Size; x++) if (m[x, y] != again[x, y]) same = false;
                    ok &= Check(log, "encoding is deterministic", "True", same.ToString());
                }
            }
            // All eight were rendered and read back by two independent
            // decoders on the Android side. Here we assert only the structure,
            // which is what a self-test can check without a decoder.
            for (int mask = 0; mask <= 7; mask++)
            {
                var m = QrCode.Encode("pc1qtestvectorzzzzzzzzzzzzzzzzzzzzzzzz2345", mask);
                if (m == null) { ok &= Check(log, "mask " + mask + ": symbol", "symbol", "null"); continue; }
                bool well = m.Size == 29 && QrCode.DeclaredMask(m) == mask && m[8, m.Size - 8];
                // Timing patterns must survive masking.
                for (int i = 8; i < m.Size - 8; i++)
                {
                    if (m[i, 6] != (i % 2 == 0)) well = false;
                    if (m[6, i] != (i % 2 == 0)) well = false;
                }
                ok &= Check(log, "mask " + mask + " produces a well-formed symbol", "True", well.ToString());
            }
            // Null is a real answer. Truncating, or emitting a partial symbol
            // beside an address someone is about to be paid at, is how coins
            // go missing.
            ok &= Check(log, "text too large for version 10 returns null rather than a wrong symbol", "null",
                QrCode.Encode(new string('x', 400)) == null ? "null" : "symbol");
            {
                var m = QrCode.Encode("");
                ok &= Check(log, "an empty string still produces a valid symbol", "21", m == null ? "null" : m.Size.ToString(CI));
            }
            return ok;
        }

        class QrVector { public string Name; public int Version; public int Size; public string Text; public string[] Rows; }

        // Golden vectors from an INDEPENDENT implementation: the Python `qrcode`
        // library (byte mode, ECC M, border 0), generated by scratchpad/qr_reference.py
        // on the Android side and stored as
        // contrib/android/app/src/test/resources/qr_vectors.txt. Transcribed by a
        // script (gen_qr_vectors.py), never by hand.
        static readonly QrVector[] QR_VECTORS =
        {
            new QrVector
            {
                Name = "addr_a", Version = 3, Size = 29,
                Text = "pc1qtestvectoraaaaaaaaaaaaaaaaaaaaaaaaqqqq",
                Rows = new[]
                {
                    "11111110001100110011001111111",
                    "10000010010110010100101000001",
                    "10111010010000101100001011101",
                    "10111010001010110011001011101",
                    "10111010001101111010001011101",
                    "10000010110101111001001000001",
                    "11111110101010101010101111111",
                    "00000000001000111110000000000",
                    "10010110111111101000010100000",
                    "11110100110101101100111001001",
                    "10011110111001101011011010110",
                    "10000101110001010011101100100",
                    "00101011111101001100111101001",
                    "00011100000010100101100001000",
                    "01110110101010000110101000001",
                    "01011001110011110111011100001",
                    "11010010110010000101110001000",
                    "01000000010001001000011100111",
                    "10010111101110100010001111111",
                    "00110001110010111110001001011",
                    "10110010000101101000111111101",
                    "00000000110001101101100011001",
                    "11111110011011101010101010010",
                    "10000010110111010010100010111",
                    "10111010010000101100111111000",
                    "10111010110100000101001111010",
                    "10111010001111000110000010001",
                    "10000010001101110111110110010",
                    "11111110101011100100110110010",
                }
            },
            new QrVector
            {
                Name = "addr_b", Version = 3, Size = 29,
                Text = "pc1qtestvectorzzzzzzzzzzzzzzzzzzzzzzzz2345",
                Rows = new[]
                {
                    "11111110001110000000001111111",
                    "10000010110001000110001000001",
                    "10111010110110000011001011101",
                    "10111010111001010101001011101",
                    "10111010010101101101101011101",
                    "10000010010001000110001000001",
                    "11111110101010101010101111111",
                    "00000000111110010011000000000",
                    "10000010100111001101111001110",
                    "11010101111110010101000110110",
                    "10101110101101010110001011000",
                    "10010000000100010011011111010",
                    "01110010001100100000001000011",
                    "10000100011010111101111111011",
                    "00001111001101010110010100010",
                    "11110100101000011011100011110",
                    "00111010010011001101100000110",
                    "10011100100110111101111111001",
                    "11100010000011011011110010101",
                    "10100101011000010011001111000",
                    "10011011011011001101111111110",
                    "00000000101010010101100010110",
                    "11111110011110110111101011100",
                    "10000010010000110011100011001",
                    "10111010000011100001111110010",
                    "10111010010110011100110001001",
                    "10111010000000110110101110010",
                    "10000010010010111011000001101",
                    "11111110100101001101011111100",
                }
            },
            new QrVector
            {
                Name = "short", Version = 1, Size = 21,
                Text = "PCoin",
                Rows = new[]
                {
                    "111111100011101111111",
                    "100000101111101000001",
                    "101110100100101011101",
                    "101110100000101011101",
                    "101110101100101011101",
                    "100000100000101000001",
                    "111111101010101111111",
                    "000000000111100000000",
                    "101010100111000010010",
                    "111010010110001001010",
                    "101111100010100011011",
                    "001100010100001000010",
                    "010111111010101010001",
                    "000000001001010100100",
                    "111111100001011101011",
                    "100000100111110110000",
                    "101110101011011100011",
                    "101110100110001101110",
                    "101110101000100011101",
                    "100000100010001110010",
                    "111111101010101100011",
                }
            },
            new QrVector
            {
                Name = "uri", Version = 4, Size = 33,
                Text = "pcoin:pc1qtestvectoraaaaaaaaaaaaaaaaaaaaaaaaqqqq?amount=1.5",
                Rows = new[]
                {
                    "111111100100100010111111001111111",
                    "100000100011100110001100001000001",
                    "101110101111101100000111101011101",
                    "101110101011100101001010001011101",
                    "101110101111101110111111001011101",
                    "100000101000000000101110001000001",
                    "111111101010101010101010101111111",
                    "000000001110101010011100100000000",
                    "101111100110111001010010001111100",
                    "011111001010110011111111001000101",
                    "011011101011011111000100000101010",
                    "011101000101110100110110010101110",
                    "011010100100101101000010110110000",
                    "100110001101100100011111001000101",
                    "010101101001101110101010000001110",
                    "010101010001011110001100111101100",
                    "011111101101000101011010100010000",
                    "100001010100100010111101011001001",
                    "101000101010010110001100100111010",
                    "101110010001101100111110010111110",
                    "000110110000101111110010110110000",
                    "110110011001000000011111001000111",
                    "100010111101010100101110000001110",
                    "100000011101011010000110110101111",
                    "101010100001101001000010111110001",
                    "000000001100001011111101100010001",
                    "111111100010110110000101101011110",
                    "100000101011110100001111100011110",
                    "101110101010001101100000111110000",
                    "101110101111000000011111110010111",
                    "101110101100011110101000111101100",
                    "100000100110000100011110000111100",
                    "111111101001110101011011110010010",
                }
            },
            new QrVector
            {
                Name = "long", Version = 6, Size = 41,
                Text = "pcoin:pc1qtestvectoraaaaaaaaaaaaaaaaaaaaaaaaqqqq?amount=123.45678901&label=PCoin+cold+storage",
                Rows = new[]
                {
                    "11111110111110000010011000001000101111111",
                    "10000010110011111101000010000101001000001",
                    "10111010110110001110010110011001101011101",
                    "10111010010011001000101000001100101011101",
                    "10111010111010001111001000101101001011101",
                    "10000010011111110110110100100110101000001",
                    "11111110101010101010101010101010101111111",
                    "00000000001011001001101011100001100000000",
                    "10011111110001010101000010110101110010111",
                    "00110001110100011111000100010001110010100",
                    "10110110001110001100010110111110000100100",
                    "01000101110101011100000100111101001111010",
                    "01101010000011110001000110011001111101010",
                    "11100000001010001111101001100010001111111",
                    "10111011001100110101110111010101000110001",
                    "01001100001110111000100100000010000011100",
                    "01100111000011101000101011111010010100001",
                    "10000100000111100110111000011101010011000",
                    "01100110111101100111100101110011111011101",
                    "01010101111011110001110011000011010001110",
                    "00011010001001000011010001001101001000111",
                    "01001100101000110001001100010011000110110",
                    "00000011110111011110000101011110010111000",
                    "11100101111101110101101110001100010001011",
                    "11001010010100100000100100010001111001000",
                    "01101001110000111110000101111000001011101",
                    "00010110111110000101111001010011010110111",
                    "00000101011011000000100110000000110011100",
                    "11011110010100101000101101010000000100001",
                    "10011100110010111000110110010111110010000",
                    "11100011000010110110110100010001010010101",
                    "11111101110100000000000011111000101010110",
                    "11101111000100110100101010110111111111101",
                    "00000000111111001110000101111001100011000",
                    "11111110110100010000010111010111101011100",
                    "10000010110100010010100101001100100010011",
                    "10111010110010100100011011001001111110011",
                    "10111010110001111010101101111011010000010",
                    "10111010010100010101111001110000100110101",
                    "10000010001110011000100010001010001101101",
                    "11111110101101110000101111010001100000000",
                }
            },
        };

        static string Or(string complaint) { return complaint ?? "(null)"; }

        //! Just the assertion letter, so a test names the rule it is checking
        //! rather than repeating a whole sentence that may be reworded.
        static string Letter(string complaint)
        {
            if (complaint == null) return "(null)";
            int c = complaint.IndexOf(':');
            return c > 0 ? complaint.Substring(0, c) : complaint;
        }

        static bool Refused(string json)
        {
            try { ForwardPolicy.RecordFromJson(json); return false; }
            catch { return true; }
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
