// Copyright (c) 2026 The PCoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.
//
// The one question this app asks about where its blocks go.
//
// Shown once, after auto-tuning has MEASURED what this machine does, and only
// when the arithmetic says solo genuinely suits it. Rules it follows, all of
// them deliberate:
//
//  - it shows the numbers it is arguing from, both of them read at runtime.
//    Nothing here is a stored figure about the network: difficulty moves, and a
//    number a program states as fact is a promise it has to keep.
//  - Enter picks nothing: there is no AcceptButton. The recommended answer is
//    the bold one; the answer keyboard focus rests on is the one that changes
//    nothing, because those are different jobs and only one of them is safe to
//    do by reflex.
//  - Escape, and the X, mean "stay with the pool" -- the mode this machine is
//    already in. A dialog closed without being read must never change anything.
//  - it names no fee percentage. The pool's fee is the pool's to set and this
//    app has no way to read it, so it says the pool takes a fee, which stays
//    true whatever that fee becomes.

using System;
using System.Drawing;
using System.Globalization;
using System.Windows.Forms;

namespace PCoinTray
{
    class SoloOfferForm : Form
    {
        SoloOfferForm(double hps, double days, string poolUrl)
        {
            Text = "PCoin Miner";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            StartPosition = FormStartPosition.CenterScreen;
            MaximizeBox = false;
            MinimizeBox = false;
            ClientSize = new Size(474, 282);
            Font = new Font("Segoe UI", 9f);
            TopMost = true;
            ShowInTaskbar = true;

            string rate = hps >= 1000
                ? (hps / 1000.0).ToString("0.0", CultureInfo.InvariantCulture) + " kH/s"
                : hps.ToString("0", CultureInfo.InvariantCulture) + " H/s";
            // One decimal while the wait is short enough for it to mean
            // something, none once it is measured in days -- "about 1.7 days"
            // is a real distinction, "about 11.3 days" is false precision.
            string wait = days < 10
                ? days.ToString("0.0", CultureInfo.InvariantCulture)
                : days.ToString("0", CultureInfo.InvariantCulture);
            string pool = string.IsNullOrEmpty(poolUrl) ? "the pool" : poolUrl;

            Ui.Text(this, "Mine solo, or stay with the pool?", 16, 14, 442, 24, true);
            Ui.Text(this,
                "Auto-tuning measured this machine at " + rate + ". Mining on its own, it would "
                + "expect to find a block about every " + wait + " days at the difficulty the "
                + "network is at right now, and it would keep the fee the pool takes.\r\n\r\n"
                + "Solo mining also spreads out who finds PCoin's blocks. Any pool that finds "
                + "most of them is in a position to reorganise the chain, so capable machines "
                + "mining on their own make the network harder to attack.\r\n\r\n"
                + "Mining with " + pool + " pays a little less on average, but far more evenly: "
                + "a steady share of every block the pool finds, instead of the whole of a rare "
                + "one. Either choice can be changed later in the miner window.",
                16, 46, 442, 178, false);

            var stay = Ui.Button(this, "Stay with the pool", 322, 236, 136, DialogResult.No);
            var solo = Ui.Button(this, "Mine solo", 190, 236, 124, DialogResult.Yes);
            // Solo is what the arithmetic above recommends, so it is the button
            // that says so. That is as far as the recommendation goes: the KEY
            // default stays on the answer that changes nothing, because a
            // keypress on a dialog nobody has read must not move a machine.
            solo.Font = new Font(solo.Font, FontStyle.Bold);
            AcceptButton = null;    // Enter is not an answer; the person clicks one
            CancelButton = stay;    // Escape, and the X, leave this machine as it is
        }

        //! true = the person chose solo. Every other outcome, including a
        //! dialog closed without an answer, is false: the machine stays exactly
        //! as it was configured.
        public static bool Ask(double hps, double days, string poolUrl)
        {
            using (var f = new SoloOfferForm(hps, days, poolUrl))
                return f.ShowDialog() == DialogResult.Yes;
        }
    }
}
