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

        //! Height of `lines` lines of text in `font`, measured rather than assumed.
        public static int LinesHigh(Font font, int lines)
        {
            return TextRenderer.MeasureText("Ag", font).Height * lines;
        }
    }

    /**
     * Lays a dialog out top to bottom from MEASURED text, so that nothing in it
     * can be clipped at any display scale (GitHub issue #3).
     *
     * The app declares itself DPI-aware (PCoinTray.manifest), which keeps text
     * sharp but means Windows scales nothing for us: at 150% a 9pt font is drawn
     * half as large again in pixels, while every pixel size the code sets stays
     * exactly what it was. A Label in a box sized for 100% then wraps, and the
     * lines that no longer fit are cut off without a trace. That is how "check
     * your paper" came to ask for "Word" with no number: the word grid was fixed
     * in 1.4.28 by measuring it, and this is the same fix for every other part of
     * the dialogs a person meets while setting up a phrase or forwarding.
     *
     * Every height comes from measuring the text in the font it is drawn in.
     * Every width, margin and gap is the 100% design value times Scale, so text
     * wraps where it did at 100% and the dialog keeps its proportions. The window
     * is then sized from what it ended up containing. Scale is read off the
     * dialog's own font, so it is 1.0 at 100% - where the layout is the one these
     * dialogs always had - and it follows whatever font was actually used.
     */
    sealed class Flow
    {
        readonly Form _form;
        //! 1.0 at 100% display scaling, 1.5 at 150%, 2.0 at 200%.
        public readonly float Scale;
        public readonly int Left;
        //! Width of the column in real pixels; text wraps at it.
        public int Width;
        //! Top of the next row in real pixels.
        public int Y;

        //! `left`, `top` and `width` are the 100% design values. Set the form's
        //! Font first: the scale is read from it.
        public Flow(Form form, int left, int top, int width)
        {
            _form = form;
            float dpi;
            using (var g = Graphics.FromHwnd(IntPtr.Zero)) dpi = g.DpiY;
            // 9pt is 12 pixels at 96 DPI, the size these dialogs were designed at.
            Scale = form.Font.SizeInPoints * dpi / 72f / 12f;
            Left = Px(left);
            Width = Px(width);
            Y = Px(top);
        }

        public int Px(int designPixels)
        {
            return (int)Math.Round(designPixels * Scale);
        }

        //! A label that wraps at the column width and is exactly as tall as the
        //! wrapped text, or as `minLines` lines, for text that is set later.
        public Label Text(string s, bool bold, int gapAfter, int minLines = 1)
        {
            var l = Ui.Text(_form, s, Left, Y, Width, 1, bold);
            l.Height = Math.Max(l.GetPreferredSize(new Size(Width, 0)).Height, Ui.LinesHigh(l.Font, minLines));
            Y = l.Bottom + Px(gapAfter);
            return l;
        }

        //! Adds `c` at the left of the column, keeping its own size (a CheckBox
        //! with AutoSize, a Panel sized by the caller).
        public T Place<T>(T c, int gapAfter) where T : Control
        {
            c.Location = new Point(Left, Y);
            _form.Controls.Add(c);
            Y = c.Bottom + Px(gapAfter);
            return c;
        }

        //! Adds `c` at the left of the column, `designWidth` wide at 100%, or
        //! the whole column for 0. A single-line TextBox takes its height from
        //! its own font.
        public T Place<T>(T c, int designWidth, int gapAfter) where T : Control
        {
            c.Width = designWidth > 0 ? Px(designWidth) : Width;
            return Place(c, gapAfter);
        }

        //! A multi-line TextBox tall enough for `lines` lines of its own font.
        public TextBox Box(TextBox t, int designWidth, int lines, int gapAfter)
        {
            Place(t, designWidth, 0);
            t.Height = Ui.LinesHigh(t.Font, lines) + (t.Height - t.ClientSize.Height) + Px(4);
            Y = t.Bottom + Px(gapAfter);
            return t;
        }

        //! A label and its field on one row, the field starting at `column`
        //! pixels from the left edge, both centred on the taller of the two.
        public void Pair(Label label, Control field, int column, int gapAfter)
        {
            int h = Math.Max(label.Height, field.Height);
            label.Location = new Point(Left, Y + (h - label.Height) / 2);
            field.Location = new Point(Left + column, Y + (h - field.Height) / 2);
            Y += h + Px(gapAfter);
        }

        //! A button at least `designWidth` x 30 at 100%, and larger if its text
        //! needs it. Placed by Row().
        public Button Button(string text, int designWidth, DialogResult r)
        {
            var b = Ui.Button(_form, text, Left, Y, Px(designWidth), r);
            b.Height = Px(30);
            var need = b.GetPreferredSize(Size.Empty);
            b.Size = new Size(Math.Max(Px(designWidth), need.Width), Math.Max(Px(30), need.Height));
            return b;
        }

        //! One row: `left` packed from the left edge, `right` ending at the
        //! right edge of the column (or after `left`, if they would meet), all
        //! centred on the tallest.
        public void Row(Control[] left, Control[] right, int gapAfter)
        {
            int gap = Px(10), h = 0, x = Left, rightW = -gap;
            foreach (var c in left) h = Math.Max(h, c.Height);
            foreach (var c in right) { h = Math.Max(h, c.Height); rightW += c.Width + gap; }
            foreach (var c in left)
            {
                c.Location = new Point(x, Y + (h - c.Height) / 2);
                x = c.Right + gap;
            }
            x = Math.Max(Left + Width - rightW, x);
            foreach (var c in right)
            {
                c.Location = new Point(x, Y + (h - c.Height) / 2);
                x = c.Right + gap;
            }
            Y += h + Px(gapAfter);
        }

        //! Sizes the window to what it contains. If that is taller than the
        //! screen it opens on - the forwarding window at 175% on a 1080p
        //! display - it stops at the screen and scrolls, because a button below
        //! the bottom of the screen is as lost as a clipped one.
        public void Finish()
        {
            int right = Left + Width, bottom = 0;
            foreach (Control c in _form.Controls)
            {
                right = Math.Max(right, c.Right);
                bottom = Math.Max(bottom, c.Bottom);
            }
            _form.ClientSize = new Size(right + Left, bottom + Px(16));

            Rectangle screen = Screen.FromPoint(Control.MousePosition).WorkingArea;
            if (_form.Height > screen.Height)
            {
                int chrome = _form.Height - _form.ClientSize.Height;
                _form.AutoScroll = true;
                _form.ClientSize = new Size(right + Left + SystemInformation.VerticalScrollBarWidth,
                                            screen.Height - chrome);
            }
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
            TopMost = true;
            Font = new Font("Segoe UI", 9f);

            var flow = new Flow(this, 16, 18, 388);     // measured: see Flow
            flow.Text(message, false, 4);
            var bar = new ProgressBar
            {
                Height = flow.Px(16),
                Style = ProgressBarStyle.Marquee
            };
            flow.Place(bar, 0, 0);
            flow.Finish();
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
        //! @param action  what the confirming button says. It has to name what
        //! is about to happen: a button reading "Show the phrase" on a dialog
        //! about clearing a payment record is worse than no label at all.
        public TypeToConfirmForm(string headline, string body, string word, string action = "Show the phrase")
        {
            Text = "PCoin - are you sure?";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            StartPosition = FormStartPosition.CenterScreen;
            MaximizeBox = MinimizeBox = false;
            Font = new Font("Segoe UI", 9f);
            TopMost = true;

            var flow = new Flow(this, 20, 16, 420);     // measured: see Flow
            flow.Text(headline, true, 4);
            flow.Text(body, false, 6);
            var prompt = Ui.Text(this, "Type " + word + " to continue:", 0, 0, 1, 1, false);
            prompt.AutoSize = true;

            var box = new TextBox { Width = flow.Px(120) };
            Controls.Add(box);
            flow.Pair(prompt, box, Math.Max(flow.Px(200), prompt.Width + flow.Px(6)), 12);

            var ok = flow.Button(action, 200, DialogResult.OK);
            ok.Enabled = false;
            box.TextChanged += (s, e) => ok.Enabled = box.Text.Trim().ToUpperInvariant() == word;
            var cancel = flow.Button("Cancel", 100, DialogResult.Cancel);
            CancelButton = cancel;
            flow.Row(new Control[] { cancel }, new Control[] { ok }, 0);
            flow.Finish();
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
            Font = new Font("Segoe UI", 9f);
            TopMost = true;

            var flow = new Flow(this, 20, 18, 460);     // measured: see Flow
            flow.Text("Back up your PCoin with 12 words", true, 4);
            flow.Text(
                "Right now the coins on this PC exist only as a file. If Windows is " +
                "reinstalled or the disk fails, they are gone.\r\n\r\n" +
                "A recovery phrase is twelve ordinary English words that can rebuild the " +
                "wallet on any machine. You write them on paper once and keep the paper " +
                "somewhere safe. Anyone who has the words has the money, so they never go " +
                "in an email, a photo or a password manager you do not control.",
                false, 6);

            if (hasExistingWallet)
            {
                var warn = flow.Text(
                    "Your existing wallet is not touched. It keeps its coins and stays " +
                    "spendable. The new phrase-backed wallet is created alongside it, and " +
                    "future mining rewards are paid into it.",
                    false, 6);
                warn.ForeColor = Color.FromArgb(120, 70, 0);
            }

            var adv = new CheckBox
            {
                Text = "Use 24 words instead of 12 (advanced)",
                AutoSize = true
            };
            adv.CheckedChanged += (s, e) => WordCount = adv.Checked ? 24 : 12;
            flow.Place(adv, 8);

            var create = flow.Button("Create a recovery phrase", 200, DialogResult.OK);
            create.Click += (s, e) => Choice = SetupChoice.Create;
            var restore = flow.Button("I already have one", 140, DialogResult.OK);
            restore.Click += (s, e) => Choice = SetupChoice.Restore;
            var cancel = flow.Button("Not now", 100, DialogResult.Cancel);
            cancel.Click += (s, e) => Choice = SetupChoice.Cancel;
            AcceptButton = create;
            CancelButton = cancel;
            flow.Row(new Control[] { create, restore }, new Control[] { cancel }, 0);
            flow.Finish();
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

            // MEASURE, THEN SIZE -- never the other way round. This grid used to
            // give each word a fixed 108-pixel box and draw it in 12pt bold
            // Consolas; "24.  abandon" needs about 115, so the Label's default
            // WordBreak moved the WORD to a second line and the fixed 24-pixel
            // height clipped that line away. The user saw the number and no word.
            // That was GitHub issue #3: three people hit it, on 1.2.4, 1.3.11 and
            // 1.3.12, and one of them lost access to a wallet over it.
            //
            // A recovery phrase is the one screen in this application where
            // "mostly readable" is worthless, so the layout is derived from the
            // text rather than hoped to fit it, and every label below is
            // AutoSize so it cannot be clipped at any DPI or font scale.
            var wordFont = new Font("Consolas", 12f, FontStyle.Bold);
            var cellSize = new Size(0, 0);
            for (int i = 0; i < words.Length; i++)
            {
                var sz = TextRenderer.MeasureText(
                    (i + 1).ToString(CultureInfo.InvariantCulture) + ".  " + words[i], wordFont);
                if (sz.Width > cellSize.Width) cellSize.Width = sz.Width;
                if (sz.Height > cellSize.Height) cellSize.Height = sz.Height;
            }
            int colW = cellSize.Width + 22;          // widest entry, plus gutters
            int rowH = cellSize.Height + 8;
            int panelH = rows * rowH + 16;

            // The headline, body and button around the grid are measured the
            // same way (see Flow), and everything lines up with the grid.
            var flow = new Flow(this, 20, 16, 480);
            flow.Width = Math.Max(flow.Width, cols * colW);
            flow.Text(headline, true, 4);
            flow.Text(body, false, 6);

            _panel = new Panel
            {
                Size = new Size(flow.Width, panelH),
                BorderStyle = BorderStyle.FixedSingle,
                BackColor = Color.FromArgb(248, 246, 255)
            };
            flow.Place(_panel, 4);

            for (int i = 0; i < words.Length; i++)
            {
                int c = i / rows, r = i % rows;
                var l = new Label
                {
                    // The number matters: a phrase is an ordered list, and the
                    // most common restore failure is words written down in the
                    // wrong order.
                    Text = (i + 1).ToString(CultureInfo.InvariantCulture) + ".  " + words[i],
                    Location = new Point(c * colW + 10, r * rowH + 8),
                    // AutoSize, and NOT AutoEllipsis. An ellipsis would render
                    // "abando..." -- which still looks like a word, so it would be
                    // copied down and the loss discovered only at restore time.
                    // Silent truncation is the same failure in a politer coat.
                    AutoSize = true,
                    Font = wordFont,
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

            // Sized for the longest thing it will say; it starts empty.
            _countdown = Ui.Text(this, "This window closes in 0:00", 0, 0, 1, 1, false);
            _countdown.Size = _countdown.GetPreferredSize(Size.Empty);
            _countdown.Text = "";
            _countdown.ForeColor = Color.FromArgb(110, 110, 120);

            var ok = flow.Button(continueText, 160, DialogResult.OK);
            AcceptButton = ok;
            flow.Row(new Control[] { _countdown }, new Control[] { ok }, 0);
            flow.Finish();

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

        const string MISMATCH = "That does not match your phrase. Check your paper.";

        public PhraseConfirmForm(string[] words)
        {
            _words = words;
            _positions = PickPositions(words.Length, 3);

            Text = "PCoin - check your paper";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            StartPosition = FormStartPosition.CenterScreen;
            MaximizeBox = MinimizeBox = false;
            Font = new Font("Segoe UI", 9f);
            TopMost = true;

            // MEASURED, like the word grid before it (see Flow). The "Word N"
            // labels used to be fixed 70x24-pixel boxes. Above 100% display
            // scaling "Word 24" no longer fit, wrapped at the space, and the
            // number went to a second line the box cut off - so this window
            // asked for three words without saying which. That was the second
            // half of GitHub issue #3, in every release up to 1.4.35, and the
            // workaround people found was to drop Windows to 100%.
            var flow = new Flow(this, 20, 16, 420);
            flow.Text("Confirm you wrote the words down", true, 4);
            flow.Text("Type the words at these positions from your paper. " +
                      "The window with the phrase is closed on purpose.", false, 8);

            int labelW = 0;
            for (int i = 0; i < 3; i++)
            {
                _labels[i] = Ui.Text(this, "Word " + (_positions[i] + 1), 0, 0, 1, 1, false);
                _labels[i].AutoSize = true;
                // Wide enough for every label Reroll can produce, not only the
                // three shown first, so a later "Word 24" never meets its box.
                if (i == 0)
                    for (int n = 1; n <= words.Length; n++)
                        labelW = Math.Max(labelW, TextRenderer.MeasureText(
                            "Word " + n.ToString(CultureInfo.InvariantCulture), _labels[0].Font).Width);
                var t = new TextBox
                {
                    Width = flow.Px(200),
                    Font = new Font("Consolas", 11f),
                    // No autocomplete and no suggestion history: the phrase must
                    // not end up in a Windows autofill store.
                    AutoCompleteMode = AutoCompleteMode.None,
                    AutoCompleteSource = AutoCompleteSource.None
                };
                _boxes[i] = t;
                Controls.Add(t);
            }
            int column = Math.Max(flow.Px(70), labelW) + flow.Px(6);
            for (int i = 0; i < 3; i++)
                flow.Pair(_labels[i], _boxes[i], column, i < 2 ? 10 : 12);

            // Sized for the one thing it ever says, so that cannot be clipped
            // either; it starts empty.
            _status = flow.Text(MISMATCH, false, 6);
            _status.Text = "";
            _status.ForeColor = Color.Firebrick;

            var ok = flow.Button("Confirm", 100, DialogResult.None);
            ok.Click += (s, e) => Verify();
            var back = flow.Button("Show me again", 120, DialogResult.Retry);
            var cancel = flow.Button("Cancel", 90, DialogResult.Cancel);
            AcceptButton = ok;
            flow.Row(new Control[] { back }, new Control[] { ok, cancel }, 0);
            flow.Finish();
        }

        void Verify()
        {
            for (int i = 0; i < 3; i++)
            {
                string typed = Bip39.Normalize(_boxes[i].Text);
                if (!string.Equals(typed, _words[_positions[i]], StringComparison.Ordinal))
                {
                    _status.Text = MISMATCH;
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
            Font = new Font("Segoe UI", 9f);
            TopMost = true;

            var flow = new Flow(this, 20, 16, 500);     // measured: see Flow
            flow.Text("Type your 12 or 24 words", true, 2);
            flow.Text("In order, separated by spaces. Upper or lower case does not matter. " +
                      "Nothing is changed until the phrase checks out.", false, 6);

            _input = new TextBox
            {
                Multiline = true,
                Font = new Font("Consolas", 11f),
                AutoCompleteMode = AutoCompleteMode.None,
                AutoCompleteSource = AutoCompleteSource.None
            };
            _input.TextChanged += (s, e) => CheckPhrase();
            flow.Box(_input, 0, 5, 10);

            _status = flow.Text("0 of 12 words", true, 2);
            _detail = flow.Text("", false, 8, 4);      // four lines, as it always had room for

            _ok = flow.Button("Restore this wallet", 190, DialogResult.OK);
            _ok.Enabled = false;
            _ok.Click += (s, e) => Mnemonic = Bip39.Normalize(_input.Text);
            var cancel = flow.Button("Cancel", 100, DialogResult.Cancel);
            CancelButton = cancel;
            flow.Row(new Control[] { cancel }, new Control[] { _ok }, 0);
            flow.Finish();
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
