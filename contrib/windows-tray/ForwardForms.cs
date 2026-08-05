// Copyright (c) 2026 The PCoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.
//
// Where the user chooses whether mined coins are forwarded, and to where.
//
// The Windows counterpart of the Android app's ForwardActivity, with the same
// wording and the same three gates. The field starts EMPTY and staying empty is
// a complete answer: the app is itself a wallet backed by the twelve words, so
// coins accumulating here are exactly as recoverable as coins anywhere else.
// That is stated on screen in those words rather than implied by an absence.
//
// Three things happen before an address is accepted, and none of them is
// optional:
//
//  1. The NODE validates it (validateaddress), so a wrong-chain or mistyped
//     address is rejected with the character position highlighted.
//  2. The user retypes the last six characters, which catches transcription and
//     clipboard-hijack errors a checksum cannot see.
//  3. A Windows sign-in prompt gates the change itself.
//
// And then nothing is forwarded anyway until a 1 PCN test payment has confirmed
// AND the user has said they can see it. A valid address nobody holds the key
// to accepts coins silently and burns every future reward; a signed-message
// challenge cannot help, because `verifymessage` in this fork rejects anything
// that is not P2PKH (common/signmessage.cpp:36) and every modern wallet hands
// out bech32. A confirmed payment the user can actually see is the only proof
// available, so it is the one used.
//
// About gate 3, stated honestly rather than papered over: on Android the key
// that holds the phrase is created with setUserAuthenticationRequired(true), so
// the Cipher physically CANNOT produce plaintext without a fresh unlock - there
// is no boolean to skip past. WindowsUnlock IS a boolean:
// CredUIPromptForWindowsCredentials plus LogonUser. Anything already running as
// this user could change this setting. What the prompt does is stop a passer-by
// at an unattended desk and make the change deliberate. Where Windows cannot
// check who is at the keyboard at all - a PIN, a fingerprint, no password - the
// control does not silently weaken: it degrades exactly as Android's does, by
// demanding the WHOLE address a second time instead of its tail.

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.Windows.Forms;

namespace PCoinTray
{
    /**
     * Type the whole address again.
     *
     * Reached only when Windows could not confirm who is at the keyboard, which
     * is Android's "no screen lock" branch. The comparison is exact and
     * case-sensitive: this is a copy of what is already on screen, not something
     * being read off paper, so there is no reason to be lenient about it.
     */
    class TypeAddressAgainForm : Form
    {
        public TypeAddressAgainForm(string address)
        {
            Text = "PCoin - type the address again";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            StartPosition = FormStartPosition.CenterScreen;
            MaximizeBox = MinimizeBox = false;
            ClientSize = new Size(560, 300);
            Font = new Font("Segoe UI", 9f);
            TopMost = true;

            Ui.Text(this, "Windows could not check who you are", 20, 16, 520, 24, true);
            Ui.Text(this,
                "This PC signs in with a PIN, a fingerprint or no password, so nothing can gate this " +
                "change - anyone signed in as you could redirect your coins. The whole address has to " +
                "be typed twice instead.",
                20, 44, 520, 60, false);

            Ui.Text(this, "The address you entered:", 20, 112, 520, 18, false);
            var shown = new TextBox
            {
                Text = address,
                Location = new Point(20, 132),
                Size = new Size(520, 24),
                ReadOnly = true,
                Font = new Font("Consolas", 10f)
            };
            Controls.Add(shown);

            Ui.Text(this, "Type the WHOLE address again", 20, 166, 520, 18, false);
            var box = new TextBox
            {
                Location = new Point(20, 186),
                Size = new Size(520, 24),
                Font = new Font("Consolas", 10f)
            };
            Controls.Add(box);

            var mismatch = Ui.Text(this, "", 20, 216, 520, 20, false);
            mismatch.ForeColor = Color.FromArgb(160, 40, 40);

            var ok = Ui.Button(this, "Save forwarding address", 320, 250, 220, DialogResult.OK);
            ok.Enabled = false;
            box.TextChanged += delegate
            {
                bool same = string.Equals(box.Text, address, StringComparison.Ordinal);
                ok.Enabled = same;
                mismatch.Text = (box.Text.Length == 0 || same)
                    ? "" : "The two addresses are not the same. Check both.";
            };
            var cancel = Ui.Button(this, "Cancel", 20, 250, 110, DialogResult.Cancel);
            CancelButton = cancel;
        }
    }

    /**
     * The forwarding settings dialog. Four actions: Save, Stop, Clear a stuck
     * record, Close.
     */
    class ForwardSettingsForm : Form
    {
        readonly ForwardEngine _engine;
        readonly ForwardStore _store;
        readonly RpcClient _rpc;
        readonly Func<string> _payoutWallet;

        readonly TextBox _current = new TextBox();
        readonly TextBox _address = new TextBox();
        readonly TextBox _confirm = new TextBox();
        readonly Label _confirmLabel;
        readonly Label _status;
        readonly Label _noLock;
        readonly Button _save;
        readonly Button _stop;
        readonly Button _clear;

        /**
         * This PC has already told us it cannot verify a sign-in.
         *
         * Remembered for the rest of this dialog so the confirmation field
         * switches to the whole address up front, which is exactly the state
         * Android renders when there is no screen lock. It is never assumed the
         * other way: a PC that CAN verify is asked every single time.
         */
        bool _cannotVerify;

        const int RPC_TIMEOUT_MS = 20000;

        public ForwardSettingsForm(ForwardEngine engine, RpcClient rpc, Func<string> payoutWallet)
        {
            _engine = engine;
            _store = engine.Store;
            _rpc = rpc;
            _payoutWallet = payoutWallet;

            Text = "PCoin - forward my coins";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            StartPosition = FormStartPosition.CenterScreen;
            MaximizeBox = MinimizeBox = false;
            ClientSize = new Size(580, 690);
            Font = new Font("Segoe UI", 9f);

            Ui.Text(this, "Forward my coins", 20, 16, 540, 26, true);
            Ui.Text(this,
                "This app is a wallet. Mined coins are paid into it and stay here, recoverable with " +
                "your twelve words, until you choose otherwise.\r\n\r\n" +
                "If you set an address below, the app will automatically send coins there once they " +
                "are spendable. Everything the wallet holds is forwarded, not only mining rewards - so " +
                "a payment someone sends you here would go on to that address too.\r\n\r\n" +
                "Before any real forwarding starts, the app sends a 1.00000000 PC test payment and " +
                "waits for you to confirm you can see it. If you never confirm it, nothing more is " +
                "ever sent.",
                20, 46, 540, 118, false);

            // Read-only multiline box rather than a label: it shows the
            // destination address, and an address is something people need to be
            // able to select and copy.
            _current.Location = new Point(20, 172);
            _current.Size = new Size(540, 76);
            _current.Multiline = true;
            _current.ReadOnly = true;
            _current.BorderStyle = BorderStyle.FixedSingle;
            _current.BackColor = Color.FromArgb(246, 246, 250);
            _current.Font = new Font("Segoe UI", 9f);
            Controls.Add(_current);

            Ui.Text(this, "FORWARD TO THIS ADDRESS", 20, 260, 540, 18, false);
            _address.Location = new Point(20, 280);
            _address.Size = new Size(540, 24);
            _address.Font = new Font("Consolas", 10f);
            Controls.Add(_address);

            _confirmLabel = Ui.Text(this, "Retype the LAST 6 CHARACTERS of that address", 20, 312, 540, 18, false);
            _confirm.Location = new Point(20, 332);
            _confirm.Size = new Size(200, 24);
            _confirm.Font = new Font("Consolas", 10f);
            Controls.Add(_confirm);

            _noLock = Ui.Text(this, "", 20, 364, 540, 56, false);
            _noLock.ForeColor = Color.FromArgb(150, 90, 0);

            _status = Ui.Text(this, "", 20, 424, 540, 96, false);
            _status.ForeColor = Color.FromArgb(40, 40, 40);

            Ui.Text(this,
                "Timing, honestly: mined coins cannot be spent for 101 blocks, which on PCoin today " +
                "is about a day. Forwards start roughly a day after this PC finds a block, and then " +
                "arrive about as often as it finds them. There is no way to make that faster.",
                20, 524, 540, 56, false).ForeColor = Color.FromArgb(105, 105, 115);

            _save = Ui.Button(this, "Save forwarding address", 20, 590, 220, DialogResult.None);
            _save.Click += delegate { Submit(); };

            _stop = Ui.Button(this, "Stop forwarding, keep coins here", 250, 590, 230, DialogResult.None);
            _stop.Click += delegate { StopForwarding(); };

            _clear = Ui.Button(this, "Clear the stuck forward record", 20, 628, 230, DialogResult.None);
            _clear.Click += delegate { ClearStuckRecord(); };

            var close = Ui.Button(this, "Close", 460, 628, 100, DialogResult.OK);
            CancelButton = close;
            AcceptButton = _save;

            Render();
        }

        // ------------------------------------------------------------------ render

        void Render()
        {
            string address = _store.Address;
            ForwardState state = _store.State;

            if (string.IsNullOrEmpty(address) || state == ForwardState.HOLDING)
            {
                _current.Text = "Holding coins in this wallet. No forwarding address is set, and that is " +
                                "a perfectly safe place for them to stay.";
            }
            else if (state == ForwardState.PROBING_PENDING)
            {
                _current.Text = "Forwarding to:\r\n" + address +
                                "\r\n\r\nA test payment will be sent as soon as coins are spendable.";
            }
            else if (state == ForwardState.PROBING_SENT)
            {
                _current.Text = "Forwarding to:\r\n" + address +
                                "\r\n\r\nA test payment is on its way. Nothing else will be sent until " +
                                "you confirm it arrived.";
            }
            else
            {
                _current.Text = "Forwarding to:\r\n" + address;
            }

            string pending = _store.PendingAddress;
            if (!string.IsNullOrEmpty(pending))
            {
                _current.Text += "\r\n\r\nQueued, takes effect when the current forward settles:\r\n" + pending;
            }

            _stop.Visible = !string.IsNullOrEmpty(address);
            _clear.Visible = _store.HasRecord || _store.Unreadable;

            if (_cannotVerify)
            {
                _noLock.Text =
                    "This PC signs in with a PIN, a fingerprint or no password, so nothing can gate " +
                    "this change - anyone signed in as you could redirect your coins. The whole " +
                    "address has to be typed twice instead.";
                _noLock.Visible = true;
                _confirmLabel.Text = "Type the WHOLE address again";
                _confirm.Size = new Size(540, 24);
            }
            else
            {
                _noLock.Visible = false;
                _confirmLabel.Text = "Retype the LAST 6 CHARACTERS of that address";
                _confirm.Size = new Size(200, 24);
            }
        }

        // ------------------------------------------------------------------ submit

        void Submit()
        {
            _status.Text = "";
            string typed = ForwardPolicy.NormalizeAddress(_address.Text);
            if (typed.Length == 0)
            {
                _status.Text = ForwardPolicy.Message(AddressVerdict.EMPTY);
                return;
            }
            if (string.Equals(typed, _store.Address, StringComparison.Ordinal))
            {
                _status.Text = "That is already your forwarding address.";
                return;
            }

            // The confirmation is checked before the node is even asked: it
            // costs nothing and it is the check that catches a swapped clipboard.
            string confirmation = _confirm.Text.Trim();
            bool confirmationOk = _cannotVerify
                ? string.Equals(_confirm.Text, typed, StringComparison.Ordinal)
                : ForwardPolicy.ConfirmationMatches(typed, confirmation);
            if (!confirmationOk)
            {
                _status.Text = _cannotVerify
                    ? "The two addresses are not the same. Check both."
                    : ForwardPolicy.Message(AddressVerdict.CONFIRMATION_MISMATCH);
                return;
            }

            _save.Enabled = false;
            try
            {
                Outcome outcome = null;
                Exception failed = BusyForm.Run("Checking that address with the node...",
                    delegate { outcome = Validate(typed); });
                if (failed != null)
                {
                    _status.Text = NodeUnreachable(failed.Message);
                    return;
                }
                if (outcome == null || outcome.Verdict != AddressVerdict.OK)
                {
                    _status.Text = (outcome != null && outcome.Detail.Length > 0)
                        ? outcome.Detail
                        : (outcome == null ? NodeUnreachable("no answer") : ForwardPolicy.Message(outcome.Verdict));
                    return;
                }
                // The node's own encoding, not the typed string: see Outcome.
                AuthorizeAndStore(outcome.Canonical.Length > 0 ? outcome.Canonical : typed);
            }
            finally { _save.Enabled = true; }
        }

        class Outcome
        {
            public AddressVerdict Verdict = AddressVerdict.MALFORMED;
            public string Detail = "";
            /**
             * validateaddress.address - the node's own re-encoding of what was
             * typed, which is what gets stored.
             *
             * The typed string is not necessarily how the node will render this
             * address back to us. An all-uppercase bech32 address is the case
             * that bites: it validates, but every address the node reports is
             * lower case, so a stored uppercase destination would never equal
             * the address in the decoded transaction and every build would abort
             * on assertion (b) - forever, with a cryptic message. Storing the
             * node's own form removes the whole class.
             */
            public string Canonical = "";
        }

        /**
         * Asks the node. validateaddress is node-level, so it works even with no
         * wallet loaded; getaddressinfo is wallet-scoped and is aimed at the
         * PAYOUT wallet specifically, because asking the wrong wallet whether it
         * owns an address gets a confident, authoritative-looking "no".
         *
         * Runs on the BusyForm's worker thread; touches no controls.
         */
        Outcome Validate(string address)
        {
            var v = _rpc.Call(null, "validateaddress", "[" + Json.Quote(address) + "]", RPC_TIMEOUT_MS);
            if (!v.Ok || v.Result == null)
                return new Outcome { Verdict = AddressVerdict.MALFORMED, Detail = NodeUnreachable(v.Error ?? "no answer") };

            bool? valid = Json.Bool(v.Result, "isvalid");
            if (!valid.HasValue || !valid.Value)
            {
                // error_locations turns "invalid address" into "character 14
                // looks wrong", which is the difference between a user fixing a
                // typo and a user giving up.
                var where = Json.Arr(Json.Field(v.Result, "error_locations"));
                var positions = new List<string>();
                if (where != null)
                {
                    foreach (var p in where)
                        if (p is double) positions.Add(((int)(double)p + 1).ToString(CultureInfo.InvariantCulture));
                }
                string nodeError = Json.Str(v.Result, "error");
                string detail = string.IsNullOrEmpty(nodeError)
                    ? ForwardPolicy.Message(AddressVerdict.MALFORMED) : nodeError;
                if (positions.Count > 0)
                    detail += "\r\n\r\nThe problem looks like it is at character(s): " +
                              string.Join(", ", positions.ToArray());
                return new Outcome { Verdict = AddressVerdict.MALFORMED, Detail = detail };
            }

            var ai = _rpc.Call(_payoutWallet(), "getaddressinfo", "[" + Json.Quote(address) + "]", RPC_TIMEOUT_MS);
            if (!ai.Ok)
            {
                // Could not ask. That is not evidence that the address is not
                // ours, and forwarding to our own wallet only burns fees - so
                // refuse rather than guess.
                return new Outcome { Verdict = AddressVerdict.MALFORMED, Detail = NodeUnreachable(ai.Error) };
            }
            bool? mine = Json.Bool(ai.Result, "ismine");

            bool? witness = Json.Bool(v.Result, "iswitness");
            double? version = Json.Number(v.Result, "witness_version");
            var facts = new AddressFacts
            {
                IsValid = true,
                IsWitness = witness.HasValue && witness.Value,
                WitnessVersion = version.HasValue ? (int)version.Value : 0,
                IsMine = mine.HasValue && mine.Value,
                NodeError = Json.Str(v.Result, "error") ?? "",
                ScriptPubKey = Json.Str(v.Result, "scriptPubKey") ?? "",
            };
            AddressVerdict verdict = ForwardPolicy.CheckAddress(address, facts, null);
            // Fall back to what was typed only if the node returned no address
            // field at all; it always does for a valid one.
            string canonical = Json.Str(v.Result, "address") ?? "";
            return new Outcome
            {
                Verdict = verdict,
                Detail = ForwardPolicy.Message(verdict),
                Canonical = canonical.Length > 0 ? canonical : address,
            };
        }

        static string NodeUnreachable(string why)
        {
            return "The node could not check that address (" + RpcClient.Sanitize(why ?? "no answer") +
                   "), so nothing has been saved. Try again in a moment.";
        }

        /**
         * The Windows sign-in prompt, then the write.
         *
         * Four outcomes, mapped onto Android's three branches. CannotVerify is
         * Android's "no screen lock" branch, NOT its "the lock check failed"
         * branch: it must never quietly take the weaker tail-of-six path, which
         * is a security control degrading in silence.
         */
        void AuthorizeAndStore(string address)
        {
            WindowsUnlock.Outcome outcome = WindowsUnlock.Prompt(this,
                "Confirm your Windows sign-in to change where your PCoin is sent.");

            if (outcome == WindowsUnlock.Outcome.Cancelled)
            {
                _status.Text = "Cancelled. Nothing has been changed.";
                return;
            }
            if (outcome == WindowsUnlock.Outcome.WrongCredential)
            {
                _status.Text = "Windows sign-in was not confirmed, so nothing has been changed.";
                return;
            }
            if (outcome == WindowsUnlock.Outcome.CannotVerify)
            {
                _cannotVerify = true;
                Render();
                using (var again = new TypeAddressAgainForm(address))
                {
                    if (again.ShowDialog(this) != DialogResult.OK)
                    {
                        _status.Text = "Cancelled. Nothing has been changed.";
                        return;
                    }
                }
            }
            Store(address);
        }

        void Store(string address)
        {
            bool queued;
            try { queued = _engine.StoreAddress(address); }
            catch (Exception ex)
            {
                _status.Text = "The forwarding settings could not be saved: " + ex.Message;
                return;
            }
            _status.Text = queued
                ? "Saved. A forward is in flight to your previous address right now, so the new one " +
                  "takes effect as soon as that one settles - and then a fresh test payment is sent."
                : "Saved. A 1.00000000 PC test payment will be sent once coins are spendable - about " +
                  "a day after this PC finds its next block.";
            _address.Text = "";
            _confirm.Text = "";
            Render();
        }

        /** Not gated: turning forwarding OFF cannot lose money. */
        void StopForwarding()
        {
            try { _engine.StopForwarding(); }
            catch (Exception ex)
            {
                _status.Text = "The forwarding settings could not be saved: " + ex.Message;
                return;
            }
            _status.Text = "Forwarding is off. Coins stay in this wallet.";
            Render();
        }

        /**
         * Behind the unlock gate: this is the one action that can let a second
         * transaction be built over the same coins.
         */
        void ClearStuckRecord()
        {
            WindowsUnlock.Outcome outcome = WindowsUnlock.Prompt(this,
                "Confirm your Windows sign-in to clear the stuck PCoin forward record.");
            if (outcome == WindowsUnlock.Outcome.Cancelled)
            {
                _status.Text = "Cancelled. Nothing has been changed.";
                return;
            }
            if (outcome == WindowsUnlock.Outcome.WrongCredential)
            {
                _status.Text = "Windows sign-in was not confirmed, so nothing has been changed.";
                return;
            }
            if (outcome == WindowsUnlock.Outcome.CannotVerify)
            {
                _cannotVerify = true;
                Render();
                using (var t = new TypeToConfirmForm(
                    "Windows could not check who you are",
                    "This PC signs in with a PIN, a fingerprint or no password, so nothing can gate " +
                    "this change.\r\n\r\n" +
                    "Clearing the record lets this app build a NEW transaction over the same coins. " +
                    "If the old one is still alive somewhere on the network, both could be paid. " +
                    "Check the transaction in a block explorer first.",
                    "CLEAR", "Clear the record"))
                {
                    if (t.ShowDialog(this) != DialogResult.OK)
                    {
                        _status.Text = "Cancelled. Nothing has been changed.";
                        return;
                    }
                }
            }
            try { _engine.ClearStuckRecord(); }
            catch (Exception ex)
            {
                _status.Text = "The record could not be cleared: " + ex.Message;
                return;
            }
            _status.Text = "The stuck record has been cleared. Check the transaction in a block " +
                           "explorer before assuming it did not go through.";
            Render();
        }
    }
}
