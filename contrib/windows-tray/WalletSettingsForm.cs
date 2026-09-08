// Copyright (c) 2026 The PCoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.
//
// The wallet's Settings screen. A port of the Android SettingsActivity, minus
// the warnings panel: those are Android-OS facts (battery optimisation, the
// storage permission, doze) with no Windows counterpart, and inventing a
// Windows-shaped equivalent would be inventing a problem.
//
// It carries ONE setting today, the fee tier a payment starts on. That is
// enough for the screen to exist, because the alternative - a preference living
// only in the send dialog - is a preference that resets every time and is
// therefore not a preference.
//
// It also answers "where is my wallet on this disk", which is the question
// people actually open Settings for. Those are read-outs, not settings: the
// data folder is chosen by the installer and changing it here would leave a
// node running against the old one.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

namespace PCoinTray
{
    class WalletSettingsForm : Form
    {
        readonly WalletSettings _settings;
        readonly List<Button> _tierBtns = new List<Button>();
        ForwardPolicy.FeeTier _tier;

        public WalletSettingsForm(WalletSettings settings, string exeDir, string dataDir, string walletName)
        {
            _settings = settings;
            _tier = settings.DefaultFeeTier();

            Text = "PCoin Wallet - settings";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            StartPosition = FormStartPosition.CenterParent;
            MaximizeBox = MinimizeBox = false;
            ClientSize = new Size(560, 420);
            Font = new Font("Segoe UI", 9f);

            WalletUi.Text(this, "Settings", 20, 16, 400, 26, true);

            // ---- default fee tier ----
            WalletUi.Text(this, "Network fee rate for new payments", 20, 56, 400, 20, false);
            int bx = 20;
            foreach (var t in ForwardPolicy.FeeTier.All)
            {
                var tier = t;
                var b = new Button
                {
                    Text = tier.Label,
                    Location = new Point(bx, 78),
                    Size = new Size(160, 36),
                    Tag = tier
                };
                b.Click += (s, e) => SetTier(tier);
                Controls.Add(b);
                _tierBtns.Add(b);
                bx += 170;
            }
            var hint = WalletUi.Text(this,
                "Fixed rates: " + Rates() + " sat per vbyte. This decides only where the Send screen " +
                "STARTS - you can change the rate on any individual payment, and the exact fee is " +
                "always shown before anything is sent.",
                20, 122, 520, 52, false);
            hint.ForeColor = Color.FromArgb(90, 90, 110);

            var why = WalletUi.Text(this,
                "Normal is enough on this chain: blocks are mostly empty, so a higher rate buys " +
                "robustness against an unusually strict miner rather than a place in a queue.",
                20, 176, 520, 40, false);
            why.ForeColor = Color.FromArgb(120, 120, 135);

            // ---- where things are ----
            WalletUi.Text(this, "Where your wallet lives", 20, 228, 400, 20, false);
            var paths = new TextBox
            {
                Location = new Point(20, 250),
                Size = new Size(520, 90),
                Multiline = true,
                ReadOnly = true,
                ScrollBars = ScrollBars.Vertical,
                Font = new Font("Consolas", 9f),
                Text =
                    "Wallet name  " + walletName + "\r\n" +
                    "Program      " + exeDir + "\r\n" +
                    "Chain data   " + dataDir + "\r\n" +
                    "Settings     " + settings.Path_
            };
            Controls.Add(paths);
            var note = WalletUi.Text(this,
                "The recovery phrase is stored separately and encrypted to this Windows account. " +
                "Your twelve words on paper are the only backup that survives losing this PC.",
                20, 346, 520, 34, false);
            note.ForeColor = Color.FromArgb(120, 120, 135);

            var open = WalletUi.Button(this, "Open the program folder", 20, 384, 180);
            open.Click += (s, e) => { try { Process.Start("explorer.exe", exeDir); } catch { } };

            var close = Ui.Button(this, "Close", 440, 384, 100, DialogResult.OK);
            AcceptButton = close;
            CancelButton = close;

            MarkTiers();
        }

        static string Rates()
        {
            var parts = new List<string>();
            foreach (var t in ForwardPolicy.FeeTier.All)
                parts.Add(t.RateSatVb.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture));
            return string.Join(", ", parts.ToArray());
        }

        /**
         * Written straight through on the click, not on Close.
         *
         * A settings screen that only saves when it is dismissed the right way
         * loses the change when the window is closed with the X, and the person
         * has no way to tell which happened. There is nothing to cancel here -
         * the choice IS the action.
         */
        void SetTier(ForwardPolicy.FeeTier tier)
        {
            _tier = tier;
            MarkTiers();
            try { _settings.SetDefaultFeeTier(tier); }
            catch (Exception ex)
            {
                MarkTiers();
                MessageBox.Show(this,
                    "That preference could not be saved:\r\n\r\n" + ex.Message +
                    "\r\n\r\nPayments will still work; the Send screen will just start on the " +
                    "previous rate.",
                    "PCoin Wallet", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                // Show what is actually STORED, not what was clicked. Leaving
                // the new tier highlighted after a failed write would be the
                // screen asserting something it does not know.
                _tier = _settings.DefaultFeeTier();
                MarkTiers();
            }
        }

        void MarkTiers()
        {
            foreach (var b in _tierBtns) WalletUi.StyleTier(b, ReferenceEquals(b.Tag, _tier));
        }
    }
}
