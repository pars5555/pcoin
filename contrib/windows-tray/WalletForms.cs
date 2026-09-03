// Copyright (c) 2026 The PCoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.
//
// The wallet's dialogs: first-run setup, Send, History, the address book.
//
// WinForms, on the shared Ui helper from SeedForms.cs, so they look like the
// phrase dialogs they sit beside. Every call that talks to the node runs
// inside BusyForm.Run, which is modal: while a payment is being built or
// broadcast nothing else on the dialog can be clicked, which is the whole of
// the double-spend guard the Android screen enforces with its `busy` flag.
//
// Send is inspect-then-commit, ported from the Android SendActivity:
//
//   compose  ->  PrepareSend builds the transaction with add_to_wallet=false,
//                decodes it, reads every input with gettxout and asserts the
//                result is the one asked for
//   review   ->  the REAL figures from that decoded transaction: the address
//                the node canonicalised, the amount, the fee as inputs minus
//                outputs. Never an estimate.
//   confirm  ->  BroadcastPrepared re-checks the mempool and sends the SAME
//                hex. A failure keeps the review screen and the prepared bytes:
//                pressing Confirm again re-sends them, and never rebuilds.
//
// The fee tier is drawn as a FILLED control when selected, outlines otherwise.
// An alpha-only difference was tried on Android first and the owner could not
// tell which one was selected; the selected state has to survive a glance.

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Text;
using System.Windows.Forms;

namespace PCoinTray
{
    static class WalletUi
    {
        public static string Coins(long sat) { return Amounts.ToPlainString(sat) + " PCN"; }

        /** The selected tier is FILLED like a primary button; the others are outlines. */
        public static void StyleTier(Button b, bool selected)
        {
            b.FlatStyle = FlatStyle.Flat;
            b.FlatAppearance.BorderColor = Ui.Accent;
            b.FlatAppearance.BorderSize = selected ? 2 : 1;
            b.FlatAppearance.MouseOverBackColor = selected ? Ui.Accent : Color.FromArgb(240, 236, 255);
            b.BackColor = selected ? Ui.Accent : Color.White;
            b.ForeColor = selected ? Color.White : Ui.Accent;
            b.Font = new Font("Segoe UI", 9.5f, selected ? FontStyle.Bold : FontStyle.Regular);
            b.UseVisualStyleBackColor = false;
        }

        static readonly DateTime EPOCH = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);

        /** Local date and time. A missing or future timestamp is left blank. */
        public static string When(long unixSec)
        {
            if (unixSec <= 0) return "";
            try
            {
                var t = EPOCH.AddSeconds(unixSec).ToLocalTime();
                return t.ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture);
            }
            catch { return ""; }
        }

        public static Label Text(Control parent, string s, int x, int y, int w, int h, bool bold)
        {
            var l = new Label
            {
                Text = s,
                Location = new Point(x, y),
                Size = new Size(w, h),
                AutoSize = false,
                Font = new Font("Segoe UI", bold ? 10f : 9f, bold ? FontStyle.Bold : FontStyle.Regular)
            };
            parent.Controls.Add(l);
            return l;
        }

        public static Button Button(Control parent, string s, int x, int y, int w)
        {
            var b = new Button
            {
                Text = s,
                Location = new Point(x, y),
                Size = new Size(w, 30),
                UseVisualStyleBackColor = true
            };
            parent.Controls.Add(b);
            return b;
        }

        public static void Primary(Button b)
        {
            b.FlatStyle = FlatStyle.Flat;
            b.FlatAppearance.BorderColor = Ui.Accent;
            b.BackColor = Ui.Accent;
            b.ForeColor = Color.White;
            b.Font = new Font("Segoe UI", 9.5f, FontStyle.Bold);
            b.UseVisualStyleBackColor = false;
        }

        public static string Kind(HistoryKind k)
        {
            switch (k)
            {
                case HistoryKind.RECEIVED: return "Received";
                case HistoryKind.SENT: return "Sent";
                case HistoryKind.MINED: return "Mined";
                case HistoryKind.MATURING: return "Mined (maturing)";
                case HistoryKind.CONFLICTED: return "Conflicted";
                default: return k.ToString();
            }
        }
    }

    // =====================================================================
    // First run
    // =====================================================================

    enum WalletSetupChoice { Cancel, Create, Restore }

    class WalletSetupForm : Form
    {
        public WalletSetupChoice Choice = WalletSetupChoice.Cancel;
        public int WordCount = 12;

        public WalletSetupForm()
        {
            Text = "PCoin Wallet - set up";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            StartPosition = FormStartPosition.CenterScreen;
            MaximizeBox = MinimizeBox = false;
            ClientSize = new Size(520, 300);
            Font = new Font("Segoe UI", 9f);
            TopMost = true;

            Ui.Text(this, "Your wallet is twelve words", 20, 18, 480, 26, true);
            Ui.Text(this,
                "A PCoin wallet is a recovery phrase: twelve ordinary English words that rebuild it " +
                "on any machine, including the PCoin Wallet app on Android. You write them on paper " +
                "once and keep the paper somewhere safe.\r\n\r\n" +
                "Anyone who has the words has the money, so they never go in an email, a photo or a " +
                "password manager you do not control. Nobody - not even you - can recover the coins " +
                "without them.",
                20, 48, 480, 130, false);

            var adv = new CheckBox
            {
                Text = "Use 24 words instead of 12 (advanced)",
                Location = new Point(20, 190),
                Size = new Size(300, 22)
            };
            adv.CheckedChanged += (s, e) => WordCount = adv.Checked ? 24 : 12;
            Controls.Add(adv);

            var create = Ui.Button(this, "Create a new wallet", 20, 232, 180, DialogResult.OK);
            create.Click += (s, e) => Choice = WalletSetupChoice.Create;
            WalletUi.Primary(create);
            var restore = Ui.Button(this, "I have a recovery phrase", 210, 232, 190, DialogResult.OK);
            restore.Click += (s, e) => Choice = WalletSetupChoice.Restore;
            var cancel = Ui.Button(this, "Not now", 410, 232, 90, DialogResult.Cancel);
            cancel.Click += (s, e) => Choice = WalletSetupChoice.Cancel;
            AcceptButton = create;
            CancelButton = cancel;
        }
    }

    // =====================================================================
    // Send
    // =====================================================================

    class SendForm : Form
    {
        readonly ForwardEngine _engine;
        readonly string _wallet;
        readonly AddressBookStore _book;
        readonly string _ownAddress;

        readonly Panel _compose = new Panel();
        readonly Panel _review = new Panel();
        readonly Panel _result = new Panel();

        // compose
        readonly TextBox _addr = new TextBox();
        readonly Label _addrNote;
        readonly TextBox _amount = new TextBox();
        readonly Button _max;
        readonly Label _amountNote;
        readonly List<Button> _tierBtns = new List<Button>();
        readonly Label _composeStatus;
        bool _sendMax;
        ForwardPolicy.FeeTier _tier = ForwardPolicy.FeeTier.NORMAL;
        List<AddressBookEntry> _entries;

        // review
        readonly Label _rvTo;
        readonly Label _rvName;
        readonly Label _rvAmount;
        readonly Label _rvFee;
        readonly Label _rvTotal;
        readonly Label _rvTier;
        readonly Label _reviewStatus;
        readonly Button _confirm;
        ForwardEngine.Prepared _prepared;

        // result
        readonly TextBox _txid = new TextBox();
        readonly Button _saveName;
        string _sentTo = "";

        public SendForm(ForwardEngine engine, string wallet, AddressBookStore book, string ownAddress)
        {
            _engine = engine;
            _wallet = wallet;
            _book = book;
            _ownAddress = ownAddress ?? "";
            _entries = _book.Load();

            Text = "PCoin Wallet - send";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            StartPosition = FormStartPosition.CenterScreen;
            MaximizeBox = MinimizeBox = false;
            ClientSize = new Size(580, 470);
            Font = new Font("Segoe UI", 9f);

            foreach (var p in new[] { _compose, _review, _result })
            {
                p.Location = new Point(0, 0);
                p.Size = ClientSize;
                p.Visible = false;
                Controls.Add(p);
            }

            // ---- compose ----
            WalletUi.Text(_compose, "Send PCN", 20, 16, 400, 26, true);

            WalletUi.Text(_compose, "Pay to (PCoin address)", 20, 50, 300, 20, false);
            _addr.Location = new Point(20, 70);
            _addr.Size = new Size(410, 26);
            _addr.Font = new Font("Consolas", 10f);
            _addr.TextChanged += (s, e) => UpdateAddressNote();
            _compose.Controls.Add(_addr);
            var pick = WalletUi.Button(_compose, "Address book...", 440, 68, 120);
            pick.Click += (s, e) => PickAddress();
            _addrNote = WalletUi.Text(_compose, "", 20, 99, 540, 20, false);
            _addrNote.ForeColor = Color.FromArgb(90, 90, 110);

            WalletUi.Text(_compose, "Amount (PCN)", 20, 128, 300, 20, false);
            _amount.Location = new Point(20, 148);
            _amount.Size = new Size(200, 26);
            _amount.Font = new Font("Consolas", 10f);
            _amount.TextChanged += (s, e) => UpdateAmountNote();
            _compose.Controls.Add(_amount);
            _max = WalletUi.Button(_compose, "Send everything", 230, 146, 140);
            _max.Click += (s, e) => ToggleMax();
            _amountNote = WalletUi.Text(_compose, "", 20, 178, 540, 20, false);
            _amountNote.ForeColor = Color.FromArgb(90, 90, 110);

            WalletUi.Text(_compose, "Network fee rate", 20, 208, 300, 20, false);
            int bx = 20;
            foreach (var t in ForwardPolicy.FeeTier.All)
            {
                var tier = t;
                var b = new Button
                {
                    Text = tier.Label,
                    Location = new Point(bx, 230),
                    Size = new Size(130, 36),
                    Tag = tier
                };
                b.Click += (s, e) => SetTier(tier);
                _compose.Controls.Add(b);
                _tierBtns.Add(b);
                bx += 140;
            }
            var hint = WalletUi.Text(_compose,
                "Fixed rates: " + Rates() + " sat per vbyte. Normal is enough unless the network is busy. " +
                "The exact fee is shown before anything is sent.",
                20, 272, 540, 36, false);
            hint.ForeColor = Color.FromArgb(90, 90, 110);

            _composeStatus = WalletUi.Text(_compose, "", 20, 316, 540, 74, false);
            _composeStatus.ForeColor = Color.FromArgb(180, 30, 30);

            var review = WalletUi.Button(_compose, "Review payment", 380, 418, 180);
            WalletUi.Primary(review);
            review.Click += (s, e) => Prepare();
            var cancel = WalletUi.Button(_compose, "Cancel", 20, 418, 100);
            cancel.Click += (s, e) => Close();

            // ---- review ----
            WalletUi.Text(_review, "Check the payment", 20, 16, 400, 26, true);
            var nothing = WalletUi.Text(_review, "Nothing has been sent yet. These figures come from the transaction " +
                "the node actually built, not from what was typed.", 20, 44, 540, 36, false);
            nothing.ForeColor = Color.FromArgb(90, 90, 110);

            WalletUi.Text(_review, "To", 20, 90, 100, 20, false);
            _rvTo = WalletUi.Text(_review, "", 130, 90, 430, 40, false);
            _rvTo.Font = new Font("Consolas", 10f);
            _rvName = WalletUi.Text(_review, "", 130, 128, 430, 20, false);
            _rvName.ForeColor = Color.FromArgb(90, 90, 110);

            WalletUi.Text(_review, "Amount", 20, 158, 100, 22, false);
            _rvAmount = WalletUi.Text(_review, "", 130, 158, 430, 22, true);
            WalletUi.Text(_review, "Network fee", 20, 186, 100, 22, false);
            _rvFee = WalletUi.Text(_review, "", 130, 186, 430, 22, true);
            WalletUi.Text(_review, "Total", 20, 214, 100, 22, false);
            _rvTotal = WalletUi.Text(_review, "", 130, 214, 430, 22, false);
            WalletUi.Text(_review, "Fee rate", 20, 242, 100, 22, false);
            _rvTier = WalletUi.Text(_review, "", 130, 242, 430, 22, false);

            _reviewStatus = WalletUi.Text(_review, "", 20, 290, 540, 110, false);
            _reviewStatus.ForeColor = Color.FromArgb(180, 30, 30);

            _confirm = WalletUi.Button(_review, "Confirm and send", 380, 418, 180);
            WalletUi.Primary(_confirm);
            _confirm.Click += (s, e) => Broadcast();
            var back = WalletUi.Button(_review, "Back", 20, 418, 100);
            back.Click += (s, e) => ShowCompose();

            // ---- result ----
            WalletUi.Text(_result, "Sent", 20, 16, 400, 26, true);
            WalletUi.Text(_result, "The payment has been handed to the network. It appears in History as " +
                "pending until a block includes it.", 20, 44, 540, 40, false);
            WalletUi.Text(_result, "Transaction id", 20, 96, 300, 20, false);
            _txid.Location = new Point(20, 116);
            _txid.Size = new Size(540, 26);
            _txid.Font = new Font("Consolas", 9.5f);
            _txid.ReadOnly = true;
            _result.Controls.Add(_txid);
            var copy = WalletUi.Button(_result, "Copy transaction id", 20, 150, 160);
            copy.Click += (s, e) => { try { Clipboard.SetText(_txid.Text); copy.Text = "Copied"; } catch { } };
            _saveName = WalletUi.Button(_result, "Save this address to the book...", 190, 150, 240);
            _saveName.Click += (s, e) => SaveName();
            var done = WalletUi.Button(_result, "Done", 460, 418, 100);
            done.Click += (s, e) => Close();

            SetTier(ForwardPolicy.FeeTier.NORMAL);
            ShowCompose();
        }

        static string Rates()
        {
            var parts = new List<string>();
            foreach (var t in ForwardPolicy.FeeTier.All) parts.Add(t.RateSatVb.ToString("0.###", CultureInfo.InvariantCulture));
            return string.Join(", ", parts.ToArray());
        }

        void ShowCompose()
        {
            _prepared = null;                    // a recompose builds different bytes
            _reviewStatus.Text = "";
            _review.Visible = false;
            _result.Visible = false;
            _compose.Visible = true;
            _addr.Focus();
        }

        void SetTier(ForwardPolicy.FeeTier tier)
        {
            _tier = tier;
            foreach (var b in _tierBtns) WalletUi.StyleTier(b, ReferenceEquals(b.Tag, tier));
        }

        void ToggleMax()
        {
            _sendMax = !_sendMax;
            _amount.Enabled = !_sendMax;
            _amount.Text = _sendMax ? "" : _amount.Text;
            _max.Text = _sendMax ? "Everything (change)" : "Send everything";
            UpdateAmountNote();
        }

        void UpdateAddressNote()
        {
            string a = ForwardPolicy.NormalizeAddress(_addr.Text);
            if (a.Length < AddressBook.LOOKS_LIKE_ADDRESS) { _addrNote.Text = ""; return; }
            if (string.Equals(a, _ownAddress, StringComparison.Ordinal)) { _addrNote.Text = "This is your own receive address."; return; }
            string name = AddressBook.LabelFor(_entries, a);
            _addrNote.Text = name != null ? "Address book: " + name : "Not in your address book.";
        }

        void UpdateAmountNote()
        {
            if (_sendMax) { _amountNote.Text = "Everything spendable, minus the network fee. The exact amount is shown next."; return; }
            long sat;
            var r = Amounts.Parse(_amount.Text, out sat);
            if (r == Amounts.Reason.OK) _amountNote.Text = Amounts.IsDust(sat) ? Amounts.Explain(Amounts.Reason.DUST) : Amounts.ToPlainString(sat) + " PCN";
            else if (r == Amounts.Reason.EMPTY) _amountNote.Text = "";
            else _amountNote.Text = Amounts.Explain(r);
        }

        void PickAddress()
        {
            using (var f = new AddressBookForm(_book, true))
            {
                if (f.ShowDialog(this) == DialogResult.OK && !string.IsNullOrEmpty(f.Picked))
                {
                    _addr.Text = f.Picked;
                }
            }
            _entries = _book.Load();
            UpdateAddressNote();
        }

        /** Compose -> review. Everything the node says goes on screen; nothing is sent. */
        void Prepare()
        {
            _composeStatus.Text = "";
            string dest = ForwardPolicy.NormalizeAddress(_addr.Text);
            if (dest.Length == 0) { _composeStatus.Text = "Enter the address to pay."; return; }
            foreach (char c in dest) if (char.IsWhiteSpace(c)) { _composeStatus.Text = "That address contains a space."; return; }

            long amountSat = 0;
            if (!_sendMax)
            {
                var r = Amounts.Parse(_amount.Text, out amountSat);
                if (r != Amounts.Reason.OK) { _composeStatus.Text = Amounts.Explain(r); return; }
                if (Amounts.IsDust(amountSat)) { _composeStatus.Text = Amounts.Explain(Amounts.Reason.DUST); return; }
            }

            ForwardEngine.Prepared p = null;
            bool sendMax = _sendMax;
            var tier = _tier;
            var ex = BusyForm.Run("Building the payment and reading its real fee...",
                () => { p = _engine.PrepareSend(_wallet, dest, amountSat, sendMax, tier); });
            if (ex != null)
            {
                _composeStatus.Text = ex is ForwardEngine.SendRefused
                    ? ex.Message
                    : "Could not build the payment: " + RpcClient.Sanitize(ex.Message);
                return;
            }
            if (p == null) { _composeStatus.Text = "Could not build the payment."; return; }

            _prepared = p;
            _rvTo.Text = p.Destination;
            // The book is looked up against the node's canonical spelling, not
            // what was typed - the two can differ in case, and the name must
            // sit next to the address that will actually be paid.
            string name = AddressBook.LabelFor(_entries, p.Destination);
            _rvName.Text = name != null ? "Address book: " + name : "Not in your address book.";
            _rvAmount.Text = WalletUi.Coins(p.PaidSat);
            _rvFee.Text = WalletUi.Coins(p.FeeSat) + "  (" + p.FeeSat.ToString("N0", CultureInfo.InvariantCulture) + " sat, " + p.Inputs + (p.Inputs == 1 ? " input" : " inputs") + ")";
            _rvTotal.Text = p.SendMax
                ? "Sending everything, minus the fee."
                : WalletUi.Coins(p.PaidSat + p.FeeSat) + " leaves your wallet.";
            _rvTier.Text = p.Tier.Label + " (" + p.Tier.RateSatVb.ToString("0.###", CultureInfo.InvariantCulture) + " sat/vB)";
            _reviewStatus.Text = "";
            _compose.Visible = false;
            _result.Visible = false;
            _review.Visible = true;
            _confirm.Focus();
        }

        /** Review -> result. Sends the prepared bytes, never a rebuild. */
        void Broadcast()
        {
            var p = _prepared;
            if (p == null)
            {
                // A completed click must never end in silence.
                _reviewStatus.Text = "Nothing is prepared. Go back and build the payment again.";
                return;
            }
            _reviewStatus.Text = "";
            string txid = null;
            var ex = BusyForm.Run("Sending...", () => { txid = _engine.BroadcastPrepared(p); });
            if (ex != null)
            {
                // Stay here: the prepared transaction is still valid, and a
                // second Confirm re-sends the same bytes.
                _reviewStatus.Text = ex is ForwardEngine.SendRefused
                    ? ex.Message
                    : "The send did not complete: " + RpcClient.Sanitize(ex.Message);
                return;
            }
            _prepared = null;
            _sentTo = p.Destination;
            _txid.Text = txid ?? p.Txid;
            _book.Touch(p.Destination, NowMs());
            _entries = _book.Load();
            _saveName.Visible = AddressBook.LabelFor(_entries, p.Destination) == null;
            _review.Visible = false;
            _compose.Visible = false;
            _result.Visible = true;
        }

        void SaveName()
        {
            using (var f = new AddressBookEditForm(_entries, _sentTo, "", false))
            {
                if (f.ShowDialog(this) != DialogResult.OK) return;
                try
                {
                    _entries = _book.Put(f.Address, f.EntryName, NowMs());
                    _saveName.Visible = false;
                }
                catch (Exception ex)
                {
                    MessageBox.Show("Could not save the address book: " + ex.Message, "PCoin Wallet",
                                    MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
            }
        }

        static long NowMs()
        {
            return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
        }
    }

    // =====================================================================
    // History
    // =====================================================================

    class HistoryForm : Form
    {
        /** A coinbase becomes spendable at this many confirmations. */
        const int COINBASE_SPENDABLE_DEPTH = 101;

        readonly ForwardEngine _engine;
        readonly string _wallet;
        readonly AddressBookStore _book;
        readonly Func<bool> _trustworthy;

        readonly ListView _list = new ListView();
        readonly Label _status;
        readonly Label _count;
        readonly Button _more;
        readonly List<HistoryEntry> _loaded = new List<HistoryEntry>();
        List<AddressBookEntry> _entries = new List<AddressBookEntry>();
        int _pages;
        bool _reachedEnd;

        public HistoryForm(ForwardEngine engine, string wallet, AddressBookStore book, Func<bool> trustworthy)
        {
            _engine = engine;
            _wallet = wallet;
            _book = book;
            _trustworthy = trustworthy;

            Text = "PCoin Wallet - history";
            FormBorderStyle = FormBorderStyle.Sizable;
            StartPosition = FormStartPosition.CenterScreen;
            MinimizeBox = false;
            ClientSize = new Size(760, 480);
            MinimumSize = new Size(600, 320);
            Font = new Font("Segoe UI", 9f);

            _list.View = View.Details;
            _list.FullRowSelect = true;
            _list.MultiSelect = false;
            _list.HideSelection = false;
            _list.Location = new Point(12, 12);
            _list.Size = new Size(ClientSize.Width - 24, ClientSize.Height - 70);
            _list.Anchor = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right;
            _list.Columns.Add("When", 125);
            _list.Columns.Add("Type", 110);
            _list.Columns.Add("Amount", 150, HorizontalAlignment.Right);
            _list.Columns.Add("Status", 150);
            _list.Columns.Add("Who", 190);
            _list.DoubleClick += (s, e) => OpenSelected();
            Controls.Add(_list);

            _count = WalletUi.Text(this, "", 12, ClientSize.Height - 48, 360, 20, false);
            _count.Anchor = AnchorStyles.Bottom | AnchorStyles.Left;
            _status = WalletUi.Text(this, "", 12, ClientSize.Height - 28, 500, 22, false);
            _status.Anchor = AnchorStyles.Bottom | AnchorStyles.Left;
            _status.ForeColor = Color.FromArgb(180, 30, 30);

            var refresh = WalletUi.Button(this, "Refresh", ClientSize.Width - 342, ClientSize.Height - 44, 100);
            refresh.Anchor = AnchorStyles.Bottom | AnchorStyles.Right;
            refresh.Click += (s, e) => LoadFirstPage();
            _more = WalletUi.Button(this, "Load more", ClientSize.Width - 232, ClientSize.Height - 44, 110);
            _more.Anchor = AnchorStyles.Bottom | AnchorStyles.Right;
            _more.Click += (s, e) => LoadMore();
            var close = WalletUi.Button(this, "Close", ClientSize.Width - 112, ClientSize.Height - 44, 100);
            close.Anchor = AnchorStyles.Bottom | AnchorStyles.Right;
            close.Click += (s, e) => Close();

            Shown += (s, e) => LoadFirstPage();
        }

        /** Top refresh: page 0. A failed load leaves the previous list alone. */
        void LoadFirstPage()
        {
            HistoryPage page = null;
            var ex = BusyForm.Run("Reading your history...", () => { page = _engine.ListHistoryPage(_wallet, 0); });
            if (ex != null || page == null)
            {
                // "I could not ask" is not "you have no transactions".
                _status.Text = "Could not read the history from the node" + (ex != null ? ": " + RpcClient.Sanitize(ex.Message) : ".");
                return;
            }
            _status.Text = "";
            _loaded.Clear();
            _loaded.AddRange(page.Entries);
            _pages = 1;
            _reachedEnd = page.RawCount == 0;
            Draw();
        }

        /**
         * The next page. The offset is pages x page size, NEVER the number of
         * rows on screen: rows the classifier dropped make the screen count
         * smaller than the node's, and asking from the screen count would
         * re-request rows already shown.
         */
        void LoadMore()
        {
            if (_reachedEnd || _pages == 0) return;
            int skip = _pages * ForwardEngine.HISTORY_PAGE;
            HistoryPage page = null;
            var ex = BusyForm.Run("Reading more...", () => { page = _engine.ListHistoryPage(_wallet, skip); });
            if (ex != null || page == null)
            {
                _status.Text = "Could not read more from the node" + (ex != null ? ": " + RpcClient.Sanitize(ex.Message) : ".");
                return;
            }
            _status.Text = "";
            _loaded.AddRange(page.Entries);
            _pages++;
            // Only an EMPTY node page proves the end. A short one does not.
            if (page.RawCount == 0) _reachedEnd = true;
            Draw();
        }

        void Draw()
        {
            // The book is read once per draw, not once per row.
            _entries = _book.Load();
            bool trust = _trustworthy();
            _list.BeginUpdate();
            _list.Items.Clear();
            foreach (var e in _loaded)
            {
                string sign = e.Kind == HistoryKind.SENT ? "-" : "+";
                var item = new ListViewItem(WalletUi.When(e.TimeSec));
                item.SubItems.Add(WalletUi.Kind(e.Kind));
                item.SubItems.Add(sign + WalletUi.Coins(e.AmountSat));
                item.SubItems.Add(StatusLine(e, trust));
                item.SubItems.Add(Party(e));
                item.Tag = e;
                if (e.Kind == HistoryKind.CONFLICTED || e.Kind == HistoryKind.MATURING) item.ForeColor = Color.FromArgb(120, 120, 135);
                else if (e.Kind != HistoryKind.SENT) item.ForeColor = Color.FromArgb(60, 110, 60);
                _list.Items.Add(item);
            }
            _list.EndUpdate();
            _more.Enabled = !_reachedEnd;
            if (_loaded.Count == 0)
            {
                _count.Text = trust ? "No transactions yet." : "Nothing to show yet - the node is still catching up.";
            }
            else
            {
                _count.Text = _reachedEnd
                    ? _loaded.Count + (_loaded.Count == 1 ? " transaction" : " transactions")
                    : _loaded.Count + " transactions shown - there are more.";
            }
        }

        /** In the order the Android screen decides it. */
        static string StatusLine(HistoryEntry e, bool trust)
        {
            if (e.Confirmations < 0) return "conflicted (" + (-e.Confirmations) + ")";
            if (e.Kind == HistoryKind.MATURING)
            {
                long left = Math.Max(1L, COINBASE_SPENDABLE_DEPTH - e.Confirmations);
                return "spendable in " + left + (left == 1 ? " block" : " blocks");
            }
            if (e.Confirmations == 0 && !trust) return "catching up";
            if (e.Confirmations == 0) return "pending";
            if (e.Kind == HistoryKind.SENT && e.FeeSat > 0)
                return e.Confirmations + (e.Confirmations == 1 ? " confirmation" : " confirmations") + ", fee " + e.FeeSat + " sat";
            return e.Confirmations + (e.Confirmations == 1 ? " confirmation" : " confirmations");
        }

        /**
         * listtransactions.address means different things per category: the
         * counterparty for a send, YOUR OWN address for a receive or a block
         * reward. A name is shown NEXT to an address, never instead of it.
         */
        string Party(HistoryEntry e)
        {
            string a = (e.Address ?? "").Trim();
            if (e.Kind == HistoryKind.CONFLICTED || a.Length == 0) return "";
            string name = AddressBook.LabelFor(_entries, a);
            string shown = ForwardPolicy.ShortAddress(a);
            if (e.Kind == HistoryKind.SENT) return name != null ? name + "  " + shown : shown;
            return "to you  " + shown;
        }

        void OpenSelected()
        {
            if (_list.SelectedItems.Count == 0) return;
            var e = _list.SelectedItems[0].Tag as HistoryEntry;
            if (e == null) return;
            using (var f = new TxDetailForm(e, AddressBook.LabelFor(_entries, e.Address), StatusLine(e, _trustworthy())))
            {
                f.ShowDialog(this);
            }
        }
    }

    class TxDetailForm : Form
    {
        public TxDetailForm(HistoryEntry e, string name, string status)
        {
            Text = "PCoin Wallet - transaction";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            StartPosition = FormStartPosition.CenterParent;
            MaximizeBox = MinimizeBox = false;
            ClientSize = new Size(560, 300);
            Font = new Font("Segoe UI", 9f);

            var sb = new StringBuilder();
            sb.Append(WalletUi.Kind(e.Kind)).Append("  ").Append(e.Kind == HistoryKind.SENT ? "-" : "+").Append(WalletUi.Coins(e.AmountSat)).Append("\r\n");
            sb.Append("Status:  ").Append(status).Append("\r\n");
            if (e.TimeSec > 0) sb.Append("When:    ").Append(WalletUi.When(e.TimeSec)).Append("\r\n");
            if (e.Kind == HistoryKind.SENT && e.FeeSat > 0) sb.Append("Fee:     ").Append(WalletUi.Coins(e.FeeSat)).Append(" (").Append(e.FeeSat).Append(" sat)\r\n");
            string a = (e.Address ?? "").Trim();
            if (a.Length > 0)
            {
                sb.Append(e.Kind == HistoryKind.SENT ? "To:      " : "Address: ").Append(a);
                if (name != null) sb.Append("  (").Append(name).Append(")");
                sb.Append("\r\n");
            }
            sb.Append("Txid:    ").Append(e.Txid).Append("\r\n");

            var box = new TextBox
            {
                Location = new Point(16, 16),
                Size = new Size(528, 224),
                Multiline = true,
                ReadOnly = true,
                ScrollBars = ScrollBars.Vertical,
                Font = new Font("Consolas", 9.5f),
                Text = sb.ToString()
            };
            Controls.Add(box);
            var copy = WalletUi.Button(this, "Copy transaction id", 16, 254, 160);
            copy.Click += (s, ev) => { try { Clipboard.SetText(e.Txid); copy.Text = "Copied"; } catch { } };
            var close = Ui.Button(this, "Close", 444, 254, 100, DialogResult.OK);
            AcceptButton = close;
            CancelButton = close;
        }
    }

    // =====================================================================
    // Address book
    // =====================================================================

    class AddressBookForm : Form
    {
        readonly AddressBookStore _book;
        readonly bool _pick;
        readonly ListView _list = new ListView();
        readonly Button _use;
        readonly Button _edit;
        readonly Button _remove;
        readonly Label _status;
        List<AddressBookEntry> _entries = new List<AddressBookEntry>();

        /** The address chosen, when opened as a picker. */
        public string Picked = "";

        public AddressBookForm(AddressBookStore book, bool pick)
        {
            _book = book;
            _pick = pick;

            Text = pick ? "PCoin Wallet - choose an address" : "PCoin Wallet - address book";
            FormBorderStyle = FormBorderStyle.Sizable;
            StartPosition = FormStartPosition.CenterScreen;
            MinimizeBox = false;
            ClientSize = new Size(700, 440);
            MinimumSize = new Size(560, 300);
            Font = new Font("Segoe UI", 9f);

            _list.View = View.Details;
            _list.FullRowSelect = true;
            _list.MultiSelect = false;
            _list.HideSelection = false;
            _list.Location = new Point(12, 12);
            _list.Size = new Size(ClientSize.Width - 24, ClientSize.Height - 96);
            _list.Anchor = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right;
            _list.Columns.Add("Name", 170);
            _list.Columns.Add("Address", 360);
            _list.Columns.Add("Last paid", 120);
            _list.SelectedIndexChanged += (s, e) => UpdateButtons();
            _list.DoubleClick += (s, e) => { if (_pick) Use(); else Edit(); };
            Controls.Add(_list);

            int y = ClientSize.Height - 74;
            int x = 12;
            _use = WalletUi.Button(this, "Use this address", x, y, 140);
            _use.Anchor = AnchorStyles.Bottom | AnchorStyles.Left;
            _use.Visible = pick;
            _use.Click += (s, e) => Use();
            if (pick) { WalletUi.Primary(_use); x += 150; }

            var add = WalletUi.Button(this, "Add...", x, y, 80);
            add.Anchor = AnchorStyles.Bottom | AnchorStyles.Left;
            add.Click += (s, e) => Add();
            x += 90;
            _edit = WalletUi.Button(this, "Edit...", x, y, 80);
            _edit.Anchor = AnchorStyles.Bottom | AnchorStyles.Left;
            _edit.Click += (s, e) => Edit();
            x += 90;
            _remove = WalletUi.Button(this, "Remove", x, y, 90);
            _remove.Anchor = AnchorStyles.Bottom | AnchorStyles.Left;
            _remove.Click += (s, e) => Remove();
            x += 100;
            var export = WalletUi.Button(this, "Export...", x, y, 90);
            export.Anchor = AnchorStyles.Bottom | AnchorStyles.Left;
            export.Click += (s, e) => Export();
            x += 100;
            var import = WalletUi.Button(this, "Import...", x, y, 90);
            import.Anchor = AnchorStyles.Bottom | AnchorStyles.Left;
            import.Click += (s, e) => Import();

            var close = WalletUi.Button(this, pick ? "Cancel" : "Close", ClientSize.Width - 112, y, 100);
            close.Anchor = AnchorStyles.Bottom | AnchorStyles.Right;
            close.Click += (s, e) => { DialogResult = DialogResult.Cancel; Close(); };
            CancelButton = close;

            _status = WalletUi.Text(this, "", 12, ClientSize.Height - 34, ClientSize.Width - 24, 24, false);
            _status.Anchor = AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right;
            _status.ForeColor = Color.FromArgb(90, 90, 110);

            Reload();
        }

        void Reload()
        {
            _entries = _book.Load();
            _list.BeginUpdate();
            _list.Items.Clear();
            foreach (var e in AddressBook.Ordered(_entries))
            {
                var item = new ListViewItem(e.Name);
                item.SubItems.Add(e.Address);
                item.SubItems.Add(e.LastUsedAtMs > 0 ? WalletUi.When(e.LastUsedAtMs / 1000L) : "never");
                item.Tag = e;
                _list.Items.Add(item);
            }
            _list.EndUpdate();
            _status.Text = _book.LastLoadUnreadable
                ? "The address book file could not be read; a copy was kept as " + AddressBookStore.CORRUPT_FILE + "."
                : (_entries.Count == 0 ? "No saved addresses yet. A name is a note this PC keeps; it is shown next to an address, never instead of it."
                                       : _entries.Count + " of " + AddressBook.MAX_ENTRIES + " entries.");
            UpdateButtons();
        }

        AddressBookEntry Selected()
        {
            return _list.SelectedItems.Count == 0 ? null : _list.SelectedItems[0].Tag as AddressBookEntry;
        }

        void UpdateButtons()
        {
            bool any = Selected() != null;
            _use.Enabled = any;
            _edit.Enabled = any;
            _remove.Enabled = any;
        }

        void Use()
        {
            var e = Selected();
            if (e == null) return;
            Picked = e.Address;
            DialogResult = DialogResult.OK;
            Close();
        }

        void Add()
        {
            using (var f = new AddressBookEditForm(_entries, "", "", true))
            {
                if (f.ShowDialog(this) != DialogResult.OK) return;
                Store(() => _book.Put(f.Address, f.EntryName, NowMs()));
            }
        }

        void Edit()
        {
            var e = Selected();
            if (e == null) return;
            using (var f = new AddressBookEditForm(_entries, e.Address, e.Name, false))
            {
                if (f.ShowDialog(this) != DialogResult.OK) return;
                Store(() => _book.Put(f.Address, f.EntryName, NowMs()));
            }
        }

        void Remove()
        {
            var e = Selected();
            if (e == null) return;
            if (MessageBox.Show("Remove the name \"" + e.Name + "\"?\r\n\r\nOnly the label goes; no transaction or " +
                                "address is changed.", "PCoin Wallet", MessageBoxButtons.YesNo, MessageBoxIcon.Question,
                                MessageBoxDefaultButton.Button2) != DialogResult.Yes) return;
            Store(() => _book.Remove(e.Address));
        }

        void Store(Action work)
        {
            try { work(); }
            catch (Exception ex)
            {
                MessageBox.Show("Could not save the address book: " + ex.Message, "PCoin Wallet",
                                MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            Reload();
        }

        /** The exact stored format, so an import goes through the same reader. */
        void Export()
        {
            using (var d = new SaveFileDialog
            {
                FileName = AddressBookStore.EXPORT_FILE,
                Filter = "JSON (*.json)|*.json|All files (*.*)|*.*",
                Title = "Export the address book"
            })
            {
                if (d.ShowDialog(this) != DialogResult.OK) return;
                try
                {
                    File.WriteAllText(d.FileName, _book.ExportJson(), new UTF8Encoding(false));
                    _status.Text = "Exported " + _entries.Count + " entries to " + d.FileName;
                }
                catch (Exception ex)
                {
                    MessageBox.Show("Could not write the file: " + ex.Message, "PCoin Wallet",
                                    MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
            }
        }

        /** The current book always wins; the result says what happened. */
        void Import()
        {
            using (var d = new OpenFileDialog
            {
                // Files round-tripped through messengers come back with any
                // extension at all; the reader decides, not the filter.
                Filter = "All files (*.*)|*.*|JSON (*.json)|*.json",
                Title = "Import an address book"
            })
            {
                if (d.ShowDialog(this) != DialogResult.OK) return;
                AddressBookImportResult r;
                try { r = _book.ImportFile(d.FileName); }
                catch (Exception ex)
                {
                    MessageBox.Show("That file could not be read as an address book: " + ex.Message +
                                    "\r\n\r\nNothing was changed.", "PCoin Wallet",
                                    MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return;
                }
                Reload();
                MessageBox.Show("Added " + r.Added + ", already known " + r.AlreadyKnown + ", skipped " + r.Skipped +
                                (r.Skipped > 0 ? " (a name clash, or the book is full)." : "."),
                                "PCoin Wallet", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
        }

        static long NowMs()
        {
            return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
        }
    }

    /** Add or rename one entry. Validation is here, on a screen that can say why. */
    class AddressBookEditForm : Form
    {
        readonly List<AddressBookEntry> _entries;
        readonly TextBox _addr = new TextBox();
        readonly TextBox _name = new TextBox();
        readonly Label _status;
        public string Address = "";
        public string EntryName = "";

        public AddressBookEditForm(List<AddressBookEntry> entries, string address, string name, bool addressEditable)
        {
            _entries = entries;
            Text = string.IsNullOrEmpty(name) ? "PCoin Wallet - name an address" : "PCoin Wallet - rename";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            StartPosition = FormStartPosition.CenterParent;
            MaximizeBox = MinimizeBox = false;
            ClientSize = new Size(520, 230);
            Font = new Font("Segoe UI", 9f);

            WalletUi.Text(this, "PCoin address", 20, 16, 300, 20, false);
            _addr.Location = new Point(20, 36);
            _addr.Size = new Size(480, 26);
            _addr.Font = new Font("Consolas", 10f);
            _addr.Text = address ?? "";
            _addr.ReadOnly = !addressEditable;
            Controls.Add(_addr);

            WalletUi.Text(this, "Name (a note for you; shown next to the address, never instead of it)", 20, 72, 480, 20, false);
            _name.Location = new Point(20, 92);
            _name.Size = new Size(300, 26);
            _name.MaxLength = AddressBook.MAX_NAME;
            _name.Text = name ?? "";
            Controls.Add(_name);

            _status = WalletUi.Text(this, "", 20, 126, 480, 40, false);
            _status.ForeColor = Color.FromArgb(180, 30, 30);

            var ok = WalletUi.Button(this, "Save", 400, 180, 100);
            WalletUi.Primary(ok);
            ok.Click += (s, e) => Save();
            var cancel = Ui.Button(this, "Cancel", 20, 180, 100, DialogResult.Cancel);
            AcceptButton = ok;
            CancelButton = cancel;
            if (addressEditable) _addr.Focus(); else _name.Focus();
        }

        void Save()
        {
            string a = ForwardPolicy.NormalizeAddress(_addr.Text);
            if (a.Length == 0) { _status.Text = "Enter the address."; return; }
            foreach (char c in a) if (char.IsWhiteSpace(c)) { _status.Text = "That address contains a space."; return; }
            var problem = AddressBook.Problem(_name.Text, _entries, AddressBook.Key(a));
            if (problem.HasValue) { _status.Text = AddressBook.ProblemText(problem.Value); return; }
            Address = a;
            EntryName = AddressBook.CleanName(_name.Text);
            DialogResult = DialogResult.OK;
            Close();
        }
    }
}
