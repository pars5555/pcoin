// Copyright (c) 2026 The PCoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.
//
// The windows a person sees when they set up, check or restore a recovery
// phrase.
//
// Rules these forms follow, all of them deliberate:
//  - the words are shown as labels, never in a text box, and there is no copy
//    button. Twelve words exist so that they can go on paper; a clipboard on
//    Windows is shared, is read by other programs, and on some machines syncs
//    to a phone.
//  - every window that can display the words is excluded from screen capture
//    and hides itself when it loses focus.
//  - nothing is auto-corrected. A suggestion has to be typed or clicked by the
//    person; silently rewriting a word restores a different wallet.

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.Security.Cryptography;
using System.Threading;
using System.Windows.Forms;

namespace PCoinTray
{
    //! Shared look, so the dialogs do not each invent their own.
    static class Ui
    {
        public static readonly Color Accent = Color.FromArgb(139, 92, 246);

        public static Form Dialog(string title, int w, int h)
        {
            return new Form
            {
                Text = title,
                FormBorderStyle = FormBorderStyle.FixedDialog,
                StartPosition = FormStartPosition.CenterScreen,
                MaximizeBox = false,
                MinimizeBox = false,
                ClientSize = new Size(w, h),
                Font = new Font("Segoe UI", 9f),
                TopMost = true,
                ShowInTaskbar = true
            };
        }

        public static Label Text(Form f, string s, int x, int y, int w, int h, bool bold)
        {
            var l = new Label
            {
                Text = s,
                Location = new Point(x, y),
                Size = new Size(w, h),
                AutoSize = false,
                Font = new Font("Segoe UI", bold ? 10f : 9f, bold ? FontStyle.Bold : FontStyle.Regular)
            };
            f.Controls.Add(l);
            return l;
        }

        public static Button Button(Form f, string s, int x, int y, int w, DialogResult r)
        {
            var b = new Button
            {
                Text = s,
                Location = new Point(x, y),
                Size = new Size(w, 30),
                DialogResult = r,
                UseVisualStyleBackColor = true
            };
            f.Controls.Add(b);
            return b;
        }
    }

    /**
     * Run a slow job without freezing the tray.
     *
     * Wallet creation and, on a restore, the rescan can take a while, and the
     * UI thread must never be the one waiting on RPC.
     */
    class BusyForm : Form
    {
        readonly Action _work;
        public Exception Error;

        BusyForm(string message, Action work)
        {
            _work = work;
            Text = "PCoin";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            StartPosition = FormStartPosition.CenterScreen;
            ControlBox = false;
            ClientSize = new Size(420, 90);
            TopMost = true;
            Font = new Font("Segoe UI", 9f);
            Controls.Add(new Label { Text = message, Location = new Point(16, 18), Size = new Size(388, 34) });
            var bar = new ProgressBar
            {
                Location = new Point(16, 56),
                Size = new Size(388, 16),
                Style = ProgressBarStyle.Marquee
            };
            Controls.Add(bar);
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            var t = new Thread(() =>
            {
                try { _work(); }
                catch (Exception ex) { Error = ex; }
                try { BeginInvoke(new Action(Close)); } catch { }
            })
            { IsBackground = true };
            t.Start();
        }

        //! Returns the exception the job threw, or null.
        public static Exception Run(string message, Action work)
        {
            using (var f = new BusyForm(message, work))
            {
                f.ShowDialog();
                return f.Error;
            }
        }
    }

    /**
     * A deliberate, typed acknowledgement.
     *
     * Used only where Windows could not confirm who is at the keyboard, so the
     * person has to state plainly that they mean to reveal the phrase. A button
     * is too easy to click by reflex; a word has to be read first.
     */
    class TypeToConfirmForm : Form
    {
        public TypeToConfirmForm(string headline, string body, string word)
        {
            Text = "PCoin - are you sure?";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            StartPosition = FormStartPosition.CenterScreen;
            MaximizeBox = MinimizeBox = false;
            ClientSize = new Size(460, 250);
            Font = new Font("Segoe UI", 9f);
            TopMost = true;

            Ui.Text(this, headline, 20, 16, 420, 24, true);
            Ui.Text(this, body, 20, 44, 420, 118, false);
            Ui.Text(this, "Type " + word + " to continue:", 20, 168, 200, 22, false);

            var box = new TextBox { Location = new Point(220, 164), Size = new Size(120, 26) };
            Controls.Add(box);

            var ok = Ui.Button(this, "Show the phrase", 240, 204, 200, DialogResult.OK);
            ok.Enabled = false;
            box.TextChanged += (s, e) => ok.Enabled = box.Text.Trim().ToUpperInvariant() == word;
            var cancel = Ui.Button(this, "Cancel", 20, 204, 100, DialogResult.Cancel);
            CancelButton = cancel;
        }
    }

    enum SetupChoice { Cancel, Create, Restore }

    class PhraseIntroForm : Form
    {
        public SetupChoice Choice = SetupChoice.Cancel;
        public int WordCount = 12;

        public PhraseIntroForm(bool hasExistingWallet)
        {
            Text = "PCoin - recovery phrase";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            StartPosition = FormStartPosition.CenterScreen;
            MaximizeBox = MinimizeBox = false;
            ClientSize = new Size(500, hasExistingWallet ? 330 : 280);
            Font = new Font("Segoe UI", 9f);
            TopMost = true;

            Ui.Text(this, "Back up your PCoin with 12 words", 20, 18, 460, 26, true);
            Ui.Text(this,
                "Right now the coins on this PC exist only as a file. If Windows is " +
                "reinstalled or the disk fails, they are gone.\r\n\r\n" +
                "A recovery phrase is twelve ordinary English words that can rebuild the " +
                "wallet on any machine. You write them on paper once and keep the paper " +
                "somewhere safe. Anyone who has the words has the money, so they never go " +
                "in an email, a photo or a password manager you do not control.",
                20, 48, 460, 118, false);

            int y = 172;
            if (hasExistingWallet)
            {
                var warn = Ui.Text(this,
                    "Your existing wallet is not touched. It keeps its coins and stays " +
                    "spendable. The new phrase-backed wallet is created alongside it, and " +
                    "future mining rewards are paid into it.",
                    20, y, 460, 52, false);
                warn.ForeColor = Color.FromArgb(120, 70, 0);
                y += 58;
            }

            var adv = new CheckBox
            {
                Text = "Use 24 words instead of 12 (advanced)",
                Location = new Point(20, y),
                Size = new Size(300, 22)
            };
            adv.CheckedChanged += (s, e) => WordCount = adv.Checked ? 24 : 12;
            Controls.Add(adv);
            y += 30;

            var create = Ui.Button(this, "Create a recovery phrase", 20, y, 200, DialogResult.OK);
            create.Click += (s, e) => Choice = SetupChoice.Create;
            var restore = Ui.Button(this, "I already have one", 230, y, 140, DialogResult.OK);
            restore.Click += (s, e) => Choice = SetupChoice.Restore;
            var cancel = Ui.Button(this, "Not now", 380, y, 100, DialogResult.Cancel);
            cancel.Click += (s, e) => Choice = SetupChoice.Cancel;
            AcceptButton = create;
            CancelButton = cancel;
        }
    }

    /**
     * Show the words.
     *
     * Used both during setup and later from the Recovery phrase menu item. The
     * words are hidden the moment the window stops being the active one, so
     * they are not left sitting on an unattended screen, and the window closes
     * itself after a few minutes.
     */
    class PhraseShowForm : Form
    {
        readonly Panel _panel;
        readonly Label _cover;
        readonly Label _countdown;
        readonly System.Windows.Forms.Timer _timer = new System.Windows.Forms.Timer();
        int _secondsLeft = 180;

        public PhraseShowForm(string[] words, string headline, string body, string continueText)
        {
            Text = "PCoin - recovery phrase";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            StartPosition = FormStartPosition.CenterScreen;
            MaximizeBox = MinimizeBox = false;
            Font = new Font("Segoe UI", 9f);
            TopMost = true;

            int cols = words.Length > 12 ? 4 : 3;
            int rows = words.Length / cols;
            int panelH = rows * 30 + 16;
            ClientSize = new Size(520, 150 + panelH + 60);

            Ui.Text(this, headline, 20, 16, 480, 24, true);
            Ui.Text(this, body, 20, 44, 480, 92, false);

            _panel = new Panel
            {
                Location = new Point(20, 142),
                Size = new Size(480, panelH),
                BorderStyle = BorderStyle.FixedSingle,
                BackColor = Color.FromArgb(248, 246, 255)
            };
            Controls.Add(_panel);

            int colW = 480 / cols;
            for (int i = 0; i < words.Length; i++)
            {
                int c = i / rows, r = i % rows;
                var l = new Label
                {
                    // The number matters: a phrase is an ordered list, and the
                    // most common restore failure is words written down in the
                    // wrong order.
                    Text = (i + 1).ToString(CultureInfo.InvariantCulture) + ".  " + words[i],
                    Location = new Point(c * colW + 10, r * 30 + 8),
                    Size = new Size(colW - 12, 24),
                    Font = new Font("Consolas", 12f, FontStyle.Bold),
                    ForeColor = Color.FromArgb(40, 30, 70)
                };
                _panel.Controls.Add(l);
            }

            _cover = new Label
            {
                Text = "Hidden while this window is not in front.\r\nClick here to show the words again.",
                Location = _panel.Location,
                Size = _panel.Size,
                TextAlign = ContentAlignment.MiddleCenter,
                BorderStyle = BorderStyle.FixedSingle,
                BackColor = Color.FromArgb(235, 235, 240),
                ForeColor = Color.FromArgb(80, 80, 90),
                Visible = false
            };
            _cover.Click += (s, e) => { _cover.Visible = false; _panel.Visible = true; };
            Controls.Add(_cover);
            _cover.BringToFront();

            _countdown = Ui.Text(this, "", 20, 150 + panelH, 300, 22, false);
            _countdown.ForeColor = Color.FromArgb(110, 110, 120);

            var ok = Ui.Button(this, continueText, 340, 146 + panelH, 160, DialogResult.OK);
            AcceptButton = ok;

            _timer.Interval = 1000;
            _timer.Tick += (s, e) =>
            {
                _secondsLeft--;
                _countdown.Text = string.Format(CultureInfo.InvariantCulture,
                    "This window closes in {0}:{1:00}", _secondsLeft / 60, _secondsLeft % 60);
                if (_secondsLeft <= 0) { DialogResult = DialogResult.Cancel; Close(); }
            };
            _timer.Start();
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            ScreenGuard.Protect(this);
        }

        protected override void OnDeactivate(EventArgs e)
        {
            base.OnDeactivate(e);
            _panel.Visible = false;
            _cover.Visible = true;
            _cover.BringToFront();
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            _timer.Stop();
            base.OnFormClosed(e);
        }
    }

    /**
     * Prove the phrase was actually written down.
     *
     * Three words at positions chosen by the system random number generator,
     * re-chosen on every attempt so repeatedly guessing gets nowhere.
     */
    class PhraseConfirmForm : Form
    {
        readonly string[] _words;
        int[] _positions;
        readonly TextBox[] _boxes = new TextBox[3];
        readonly Label[] _labels = new Label[3];
        readonly Label _status;

        public PhraseConfirmForm(string[] words)
        {
            _words = words;
            _positions = PickPositions(words.Length, 3);

            Text = "PCoin - check your paper";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            StartPosition = FormStartPosition.CenterScreen;
            MaximizeBox = MinimizeBox = false;
            ClientSize = new Size(460, 260);
            Font = new Font("Segoe UI", 9f);
            TopMost = true;

            Ui.Text(this, "Confirm you wrote the words down", 20, 16, 420, 24, true);
            Ui.Text(this, "Type the words at these positions from your paper. " +
                          "The window with the phrase is closed on purpose.", 20, 44, 420, 40, false);

            for (int i = 0; i < 3; i++)
            {
                _labels[i] = Ui.Text(this, "Word " + (_positions[i] + 1), 20, 96 + i * 36, 70, 24, false);
                var t = new TextBox
                {
                    Location = new Point(96, 92 + i * 36),
                    Size = new Size(200, 26),
                    Font = new Font("Consolas", 11f),
                    // No autocomplete and no suggestion history: the phrase must
                    // not end up in a Windows autofill store.
                    AutoCompleteMode = AutoCompleteMode.None,
                    AutoCompleteSource = AutoCompleteSource.None
                };
                _boxes[i] = t;
                Controls.Add(t);
            }

            _status = Ui.Text(this, "", 20, 208, 300, 22, false);
            _status.ForeColor = Color.Firebrick;

            var ok = Ui.Button(this, "Confirm", 240, 214, 100, DialogResult.None);
            ok.Click += (s, e) => Verify();
            var back = Ui.Button(this, "Show me again", 20, 214, 120, DialogResult.Retry);
            Ui.Button(this, "Cancel", 350, 214, 90, DialogResult.Cancel);
            AcceptButton = ok;
        }

        void Verify()
        {
            for (int i = 0; i < 3; i++)
            {
                string typed = Bip39.Normalize(_boxes[i].Text);
                if (!string.Equals(typed, _words[_positions[i]], StringComparison.Ordinal))
                {
                    _status.Text = "That does not match your phrase. Check your paper.";
                    Reroll();
                    return;
                }
            }
            DialogResult = DialogResult.OK;
            Close();
        }

        //! New positions after every failed attempt, so the same three words
        //! cannot be brute-forced by trying again.
        void Reroll()
        {
            _positions = PickPositions(_words.Length, 3);
            for (int i = 0; i < 3; i++)
            {
                _labels[i].Text = "Word " + (_positions[i] + 1);
                _boxes[i].Text = "";
            }
            _boxes[0].Focus();
        }

        static int[] PickPositions(int count, int howMany)
        {
            var chosen = new List<int>();
            using (var rng = new RNGCryptoServiceProvider())
            {
                var b = new byte[4];
                while (chosen.Count < howMany)
                {
                    rng.GetBytes(b);
                    int v = (int)(BitConverter.ToUInt32(b, 0) % (uint)count);
                    if (!chosen.Contains(v)) chosen.Add(v);
                }
            }
            chosen.Sort();
            return chosen.ToArray();
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            ScreenGuard.Protect(this);
        }
    }

    /**
     * Enter an existing phrase.
     *
     * Nothing is written and no wallet is touched until the phrase validates,
     * so this can be retried as often as needed at no cost.
     */
    class PhraseRestoreForm : Form
    {
        readonly TextBox _input;
        readonly Label _status;
        readonly Label _detail;
        readonly Button _ok;
        public string Mnemonic = "";

        public PhraseRestoreForm()
        {
            Text = "PCoin - restore from a recovery phrase";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            StartPosition = FormStartPosition.CenterScreen;
            MaximizeBox = MinimizeBox = false;
            ClientSize = new Size(540, 330);
            Font = new Font("Segoe UI", 9f);
            TopMost = true;

            Ui.Text(this, "Type your 12 or 24 words", 20, 16, 500, 24, true);
            Ui.Text(this, "In order, separated by spaces. Upper or lower case does not matter. " +
                          "Nothing is changed until the phrase checks out.", 20, 42, 500, 36, false);

            _input = new TextBox
            {
                Location = new Point(20, 84),
                Size = new Size(500, 96),
                Multiline = true,
                Font = new Font("Consolas", 11f),
                AutoCompleteMode = AutoCompleteMode.None,
                AutoCompleteSource = AutoCompleteSource.None
            };
            _input.TextChanged += (s, e) => CheckPhrase();
            Controls.Add(_input);

            _status = Ui.Text(this, "0 of 12 words", 20, 190, 500, 22, true);
            _detail = Ui.Text(this, "", 20, 214, 500, 66, false);

            _ok = Ui.Button(this, "Restore this wallet", 330, 288, 190, DialogResult.OK);
            _ok.Enabled = false;
            _ok.Click += (s, e) => Mnemonic = Bip39.Normalize(_input.Text);
            var cancel = Ui.Button(this, "Cancel", 20, 288, 100, DialogResult.Cancel);
            CancelButton = cancel;
        }

        void CheckPhrase()
        {
            var c = Bip39.Check(_input.Text);
            _ok.Enabled = c.Ok;

            int target = c.WordCount > 12 ? 24 : 12;
            _status.Text = string.Format(CultureInfo.InvariantCulture, "{0} of {1} words", c.WordCount, target);
            _status.ForeColor = c.Ok ? Color.FromArgb(20, 120, 40) : Color.FromArgb(60, 60, 70);

            if (c.WordCount == 0) { _detail.Text = ""; return; }

            if (c.Unknown.Count > 0)
            {
                // Point at the words that are definitely wrong, and offer real
                // alternatives - but never substitute one automatically.
                var sb = new System.Text.StringBuilder();
                sb.Append("Not BIP39 words: ").Append(string.Join(", ", c.Unknown.ToArray())).Append("\r\n");
                foreach (var w in c.Unknown)
                {
                    string prefix = w.Length >= 4 ? w.Substring(0, 4) : w;
                    var sug = Bip39.Suggest(prefix, 6);
                    if (sug.Count == 0 && w.Length > 2) sug = Bip39.Suggest(w.Substring(0, 2), 6);
                    if (sug.Count > 0) sb.Append("  instead of \"").Append(w).Append("\": ")
                                         .Append(string.Join(", ", sug.ToArray())).Append("\r\n");
                }
                _detail.ForeColor = Color.Firebrick;
                _detail.Text = sb.ToString();
                return;
            }

            if (!c.CountOk)
            {
                _detail.ForeColor = Color.FromArgb(60, 60, 70);
                _detail.Text = "A recovery phrase is exactly 12 or 24 words.";
                return;
            }

            if (!c.ChecksumOk)
            {
                // The checksum says the phrase as a whole is wrong. It cannot
                // say which word, and pointing at one would send the user off
                // correcting a word that was fine.
                _detail.ForeColor = Color.Firebrick;
                _detail.Text = "All of these are real words, but the phrase is not right - either a word is " +
                               "in the wrong position, or one was written down slightly wrong. " +
                               "Check the order against your paper.";
                return;
            }

            _detail.ForeColor = Color.FromArgb(20, 120, 40);
            _detail.Text = "This phrase is valid.";
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            ScreenGuard.Protect(this);
        }
    }
}
