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
        readonly WalletSettings _settings;

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

        public SendForm(ForwardEngine engine, string wallet, AddressBookStore book, string ownAddress,
                        WalletSettings settings, string prefillAddress)
        {
            _engine = engine;
            _wallet = wallet;
            _book = book;
            _ownAddress = ownAddress ?? "";
            _settings = settings;
            _entries = _book.Load();
            // The saved preference decides where the screen STARTS. Changing it
            // here changes only this payment; Settings is the only place that
            // writes it back, so an experiment on one send cannot silently
            // become the standing choice.
            if (_settings != null) _tier = _settings.DefaultFeeTier();

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
            _addr.Name = "address";
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
            _amount.Name = "amount";
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
            _txid.Name = "txid";
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

            SetTier(_tier);
            if (!string.IsNullOrEmpty(prefillAddress)) _addr.Text = prefillAddress;
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
            ActiveControl = _addr;
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
            string linkNote = TakeAmountFromLink(_addr.Text);
            string a = ForwardPolicy.NormalizeAddress(_addr.Text);
            if (a.Length < AddressBook.LOOKS_LIKE_ADDRESS) { _addrNote.Text = linkNote; return; }
            if (string.Equals(a, _ownAddress, StringComparison.Ordinal)) { _addrNote.Text = "This is your own receive address."; return; }
            string name = AddressBook.LabelFor(_entries, a);
            string note = name != null ? "Address book: " + name : "Not in your address book.";
            _addrNote.Text = linkNote.Length > 0 ? note + "  " + linkNote : note;
        }

        /**
         * A pasted or scanned payment link may name an amount as well as an
         * address. Take it ONLY into an empty box.
         *
         * Overwriting a figure the person has already typed would change what
         * they are about to pay without asking, and the review screen would
         * then show a number they never entered. When both exist, the typed one
         * wins and the note says the link disagreed - a visible conflict rather
         * than a silent substitution.
         */
        string TakeAmountFromLink(string raw)
        {
            var t = PaymentUri.Parse(raw);
            if (t == null || !t.HasAmount) return "";
            if (_sendMax) return "The link names an amount; \"send everything\" is on.";
            if (_amount.Text.Trim().Length == 0)
            {
                _amount.Text = Amounts.ToPlainString(t.AmountSat);
                UpdateAmountNote();
                return "Amount taken from the payment link.";
            }
            long typed;
            if (Amounts.Parse(_amount.Text, out typed) == Amounts.Reason.OK && typed == t.AmountSat) return "";
            return "The link asks for " + WalletUi.Coins(t.AmountSat) + "; your amount is kept.";
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

        /** Which directions the list shows. Mined coins count as arriving. */
        enum Filter { ALL, SENT, RECEIVED }

        readonly ListView _list = new ListView();
        readonly Label _status;
        readonly Label _count;
        readonly Button _more;
        readonly TextBox _search = new TextBox();
        readonly List<Button> _filterBtns = new List<Button>();
        readonly List<HistoryEntry> _loaded = new List<HistoryEntry>();
        List<AddressBookEntry> _entries = new List<AddressBookEntry>();
        Filter _filter = Filter.ALL;
        /** Lower-cased and trimmed. Empty means no search. */
        string _query = "";
        int _pages;
        bool _reachedEnd;

        /** Set when a row's detail asked to pay someone. Read by the caller. */
        public string PayTo = "";

        readonly string _ownAddress;

        public HistoryForm(ForwardEngine engine, string wallet, AddressBookStore book, Func<bool> trustworthy,
                           string ownAddress)
        {
            _engine = engine;
            _wallet = wallet;
            _book = book;
            _trustworthy = trustworthy;
            _ownAddress = ownAddress ?? "";

            Text = "PCoin Wallet - history";
            FormBorderStyle = FormBorderStyle.Sizable;
            StartPosition = FormStartPosition.CenterScreen;
            MinimizeBox = false;
            ClientSize = new Size(760, 480);
            MinimumSize = new Size(600, 320);
            Font = new Font("Segoe UI", 9f);

            // ---- search and direction filters ----
            //
            // Both narrow the rows ALREADY LOADED and never re-ask the node.
            // A filter that re-queried would page differently under each
            // setting, and "Load more" would then mean different things
            // depending on what was typed.
            WalletUi.Text(this, "Search", 12, 16, 50, 20, false);
            _search.Name = "search";
            _search.Location = new Point(58, 13);
            _search.Size = new Size(240, 24);
            _search.TextChanged += (s, e) =>
            {
                _query = (_search.Text ?? "").Trim().ToLowerInvariant();
                ApplyFilters();
            };
            Controls.Add(_search);
            var hint = WalletUi.Text(this, "address, name or transaction id", 304, 16, 210, 20, false);
            hint.ForeColor = Color.FromArgb(120, 120, 135);

            int fx = ClientSize.Width - 246;
            foreach (Filter f in new[] { Filter.ALL, Filter.SENT, Filter.RECEIVED })
            {
                var cap = f;
                var b = WalletUi.Button(this, f == Filter.ALL ? "All" : (f == Filter.SENT ? "Sent" : "Received"), fx, 12, 78);
                b.Anchor = AnchorStyles.Top | AnchorStyles.Right;
                b.Tag = cap;
                b.Click += (s, e) => SetFilter(cap);
                _filterBtns.Add(b);
                fx += 80;
            }
            MarkFilterButtons();

            _list.Name = "history";
            _list.View = View.Details;
            _list.FullRowSelect = true;
            _list.MultiSelect = false;
            _list.HideSelection = false;
            _list.Location = new Point(12, 48);
            _list.Size = new Size(ClientSize.Width - 24, ClientSize.Height - 106);
            _list.Anchor = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right;
            _list.Columns.Add("When", 125);
            _list.Columns.Add("Type", 110);
            _list.Columns.Add("Amount", 150, HorizontalAlignment.Right);
            _list.Columns.Add("Status", 150);
            _list.Columns.Add("Who", 190);
            _list.DoubleClick += (s, e) => OpenSelected();
            Controls.Add(_list);

            // Both footer labels stop short of the buttons at Width-342. They
            // are added to the form BEFORE the buttons, and in WinForms an
            // earlier control has the higher z-order, so a label that reaches
            // under a button DRAWS OVER IT: "Refresh" came out with its top
            // half sliced off. The gutter is what keeps them apart.
            const int FOOTER_LABEL_W = 398;      // 760 - 342 - 12 - 8
            _count = WalletUi.Text(this, "", 12, ClientSize.Height - 48, FOOTER_LABEL_W, 20, false);
            _count.Anchor = AnchorStyles.Bottom | AnchorStyles.Left;
            _status = WalletUi.Text(this, "", 12, ClientSize.Height - 28, FOOTER_LABEL_W, 22, false);
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

        void SetFilter(Filter f)
        {
            if (_filter == f) return;
            _filter = f;
            MarkFilterButtons();
            ApplyFilters();
        }

        void MarkFilterButtons()
        {
            foreach (var b in _filterBtns) WalletUi.StyleTier(b, (Filter)b.Tag == _filter);
        }

        /**
         * The book is reloaded before matching, because searching covers the
         * NAME saved for an address and a rename made on the address-book
         * screen would otherwise not be searchable until this window was
         * reopened.
         */
        void ApplyFilters()
        {
            _entries = _book.Load();
            Draw();
        }

        /**
         * Does this row survive the current filter and search?
         *
         * Searching covers the transaction id, the counterparty address and the
         * name saved for that address - the three things someone actually
         * remembers a payment by. Matching is a plain case-insensitive
         * substring: an address and a txid are both long strings where a
         * fragment is what a person has to hand, and anything cleverer would
         * surprise more often than it helped.
         */
        bool Matches(HistoryEntry e)
        {
            bool dirOk;
            switch (_filter)
            {
                case Filter.SENT: dirOk = e.Kind == HistoryKind.SENT; break;
                // Mined and maturing coins are money arriving. Excluding them
                // from "received" would make a block reward invisible under
                // every filter except All, which is a hiding place, not a
                // filter.
                case Filter.RECEIVED:
                    dirOk = e.Kind == HistoryKind.RECEIVED || e.Kind == HistoryKind.MINED ||
                            e.Kind == HistoryKind.MATURING;
                    break;
                default: dirOk = true; break;
            }
            if (!dirOk) return false;
            if (_query.Length == 0) return true;
            if ((e.Txid ?? "").ToLowerInvariant().Contains(_query)) return true;
            if ((e.Address ?? "").ToLowerInvariant().Contains(_query)) return true;
            string name = AddressBook.LabelFor(_entries, e.Address);
            return name != null && name.ToLowerInvariant().Contains(_query);
        }

        void Draw()
        {
            // The book is read once per draw, not once per row.
            _entries = _book.Load();
            bool trust = _trustworthy();
            int shown = 0;
            _list.BeginUpdate();
            _list.Items.Clear();
            foreach (var e in _loaded)
            {
                if (!Matches(e)) continue;
                shown++;
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
            bool narrowed = _query.Length > 0 || _filter != Filter.ALL;
            if (_loaded.Count == 0)
            {
                _count.Text = trust ? "No transactions yet." : "Nothing to show yet - the node is still catching up.";
            }
            else if (narrowed)
            {
                // Say what was searched, not just how many matched. A count on
                // its own reads as "this is all you have" when it means "this
                // is all that matched what is typed", and the difference
                // matters when the rest of the history has not been loaded yet.
                _count.Text = shown + " of " + _loaded.Count + " loaded rows match" +
                    (_reachedEnd ? "." : " - load more to search further back.");
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
            using (var f = new TxDetailForm(e, _entries, StatusLine(e, _trustworthy()),
                                           _engine, _wallet, _ownAddress))
            {
                f.ShowDialog(this);
                if (!string.IsNullOrEmpty(f.PayTo))
                {
                    PayTo = f.PayTo;
                    Close();
                }
            }
        }
    }

    /**
     * One transaction, including who was on the other side.
     *
     * THE OTHER SIDE IS TWO DIFFERENT QUESTIONS, and answering them the same way
     * is the mistake this screen exists to avoid:
     *
     *   A SEND's destination is already known exactly - listtransactions puts it
     *   in `address` - so it needs NO block lookup and works while the payment
     *   is still unconfirmed. Gating it on a confirmation the destination never
     *   depended on would hide "Pay again" behind a wait, and would tell someone
     *   their own outgoing payment's origin was unknown, which is not even the
     *   question being asked.
     *
     *   A RECEIVE has no such field, because there is no sender in the protocol.
     *   Its INPUTS are the closest thing, they need the block, and there may be
     *   several of them. They are shown as a list of inputs and never collapsed
     *   into one confident "From".
     */
    class TxDetailForm : Form
    {
        /** Set when the person pressed pay next to an address. */
        public string PayTo = "";

        readonly ListView _parties = new ListView();
        readonly Label _partyStatus;
        readonly Button _pay;
        Button _copyAddr;

        public TxDetailForm(HistoryEntry e, List<AddressBookEntry> entries, string status,
                            ForwardEngine engine, string wallet, string ownAddress)
        {
            Text = "PCoin Wallet - transaction";
            FormBorderStyle = FormBorderStyle.Sizable;
            StartPosition = FormStartPosition.CenterParent;
            MaximizeBox = MinimizeBox = false;
            ClientSize = new Size(600, 420);
            MinimumSize = new Size(520, 380);
            Font = new Font("Segoe UI", 9f);

            string name = AddressBook.LabelFor(entries, e.Address);
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
                Size = new Size(ClientSize.Width - 32, 118),
                Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right,
                Multiline = true,
                ReadOnly = true,
                ScrollBars = ScrollBars.Vertical,
                Font = new Font("Consolas", 9.5f),
                Text = sb.ToString()
            };
            Controls.Add(box);

            _partyStatus = WalletUi.Text(this, "Reading...", 16, 144, ClientSize.Width - 32, 20, false);
            _partyStatus.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;

            _parties.View = View.Details;
            _parties.FullRowSelect = true;
            _parties.MultiSelect = false;
            _parties.HideSelection = false;
            _parties.Location = new Point(16, 168);
            _parties.Size = new Size(ClientSize.Width - 32, ClientSize.Height - 232);
            _parties.Anchor = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right;
            _parties.Columns.Add("Name", 150);
            _parties.Columns.Add("Address", 380);
            _parties.SelectedIndexChanged += (s, ev) =>
            {
                bool any = _parties.SelectedItems.Count > 0;
                _pay.Enabled = any;
                if (_copyAddr != null) _copyAddr.Enabled = any;
            };
            _parties.DoubleClick += (s, ev) => Pay();
            Controls.Add(_parties);

            var copy = WalletUi.Button(this, "Copy transaction id", 16, ClientSize.Height - 46, 160);
            copy.Anchor = AnchorStyles.Bottom | AnchorStyles.Left;
            copy.Click += (s, ev) => { try { Clipboard.SetText(e.Txid); copy.Text = "Copied"; } catch { } };

            var copyAddr = WalletUi.Button(this, "Copy address", 186, ClientSize.Height - 46, 120);
            copyAddr.Anchor = AnchorStyles.Bottom | AnchorStyles.Left;
            copyAddr.Enabled = false;
            copyAddr.Click += (s, ev) =>
            {
                if (_parties.SelectedItems.Count == 0) return;
                try { Clipboard.SetText((string)_parties.SelectedItems[0].Tag); copyAddr.Text = "Copied"; } catch { }
            };
            _copyAddr = copyAddr;

            _pay = WalletUi.Button(this, e.Kind == HistoryKind.SENT ? "Pay again" : "Pay this address",
                                   316, ClientSize.Height - 46, 150);
            _pay.Anchor = AnchorStyles.Bottom | AnchorStyles.Left;
            _pay.Enabled = false;
            _pay.Click += (s, ev) => Pay();

            var close = Ui.Button(this, "Close", ClientSize.Width - 116, ClientSize.Height - 46, 100, DialogResult.OK);
            close.Anchor = AnchorStyles.Bottom | AnchorStyles.Right;
            CancelButton = close;

            Shown += (s, ev) =>
            {
                // A read-only multiline TextBox selects its whole contents when
                // it takes focus, so the summary opened as a wall of blue.
                // Put the caret at the start and give focus to the list.
                box.SelectionStart = 0;
                box.SelectionLength = 0;
                ActiveControl = _parties;
                LoadParties(e, entries, engine, wallet, ownAddress);
            };
        }

        void Pay()
        {
            if (_parties.SelectedItems.Count == 0) return;
            PayTo = (string)_parties.SelectedItems[0].Tag;
            // Fills the compose field and nothing more: validateaddress still
            // runs and the review step still shows what the node built.
            DialogResult = DialogResult.OK;
            Close();
        }

        void LoadParties(HistoryEntry e, List<AddressBookEntry> entries,
                         ForwardEngine engine, string wallet, string ownAddress)
        {
            bool sent = e.Kind == HistoryKind.SENT;
            List<string> payable;

            if (sent)
            {
                // No node call at all - see the class comment.
                payable = TxParties.Payable(new List<string> { e.Address }, new List<string>());
            }
            else
            {
                TxDetails d = null;
                Exception failed = null;
                var ex = BusyForm.Run("Reading the transaction...", () =>
                {
                    try { d = engine.GetTxDetails(wallet, e.Txid); }
                    catch (Exception inner) { failed = inner; }
                });
                if (ex != null || failed != null || d == null)
                {
                    // "I could not ask" is not "nobody paid you".
                    Exception why = ex ?? failed;
                    _partyStatus.Text = "Could not read who paid this" +
                        (why != null ? ": " + RpcClient.Sanitize(why.Message) : ".");
                    return;
                }
                if (d.UnresolvedReason != null)
                {
                    _partyStatus.Text = "Who paid this cannot be shown - " + d.UnresolvedReason + ".";
                    return;
                }
                var mine = new List<string>();
                if (!string.IsNullOrEmpty(ownAddress)) mine.Add(ownAddress);
                payable = TxParties.Payable(d.InputAddresses, mine);
            }

            if (payable.Count == 0)
            {
                _partyStatus.Text = sent
                    ? "This payment went to more than one place, so there is no single destination to show."
                    : "No address on the other side could be identified.";
                return;
            }

            _partyStatus.Text = sent
                ? "Paid to"
                : (payable.Count == 1
                    ? "Funded by this address - which is not necessarily the sender's own:"
                    : "Funded by these " + payable.Count + " addresses - not necessarily the sender's own:");

            _parties.BeginUpdate();
            _parties.Items.Clear();
            foreach (string addr in payable)
            {
                string nm = AddressBook.LabelFor(entries, addr);
                var item = new ListViewItem(nm ?? "");
                item.SubItems.Add(addr);
                item.Tag = addr;
                _parties.Items.Add(item);
            }
            _parties.EndUpdate();
            if (_parties.Items.Count > 0) _parties.Items[0].Selected = true;
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

            _list.Name = "book";
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
            _addr.Name = "address";
            _addr.Location = new Point(20, 36);
            _addr.Size = new Size(480, 26);
            _addr.Font = new Font("Consolas", 10f);
            _addr.Text = address ?? "";
            _addr.ReadOnly = !addressEditable;
            Controls.Add(_addr);

            WalletUi.Text(this, "Name (a note for you; shown next to the address, never instead of it)", 20, 72, 480, 20, false);
            _name.Name = "name";
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
            // ActiveControl, not Focus(): Focus() does nothing before the
            // handle exists, and the first control in tab order - the
            // read-only address box - would take the keystrokes instead.
            ActiveControl = addressEditable ? (Control)_addr : _name;
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
