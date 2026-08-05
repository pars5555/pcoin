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
