// Copyright (c) 2026 The PCoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.
//
// What a pasted or scanned payment string means.
//
// A port of the Android app's PaymentUri.kt, held to the same vectors in
// SeedSelfTest. PURE: no window, no node, no file system, so every rule below
// runs under --selftest.
//
// WHAT THIS DOES NOT DO. It does not decide that an address is valid,
// spendable, or on this chain. It cannot - only the node can, and it still
// does, in Prepare(), exactly as it does for a hand-typed address. Parsing is
// a faster way to fill a text field and nothing more: the review step still
// shows the destination the node actually built. Same rule as AddressBook,
// where a saved name never replaces the address it stands next to.
//
// FORMS ACCEPTED
//   pc1q...                    a bare address, which is what this app's own
//                              receive card encodes
//   pcoin:pc1q...              a URI, which is what other wallets tend to
//   PCN:pc1q... bitcoin:pc1q.  other spellings seen in the wild
//   pcoin://pc1q...            some encoders write an empty authority
//   pcoin:pc1q...?amount=1.5   with an amount, BIP21 style
//   PC1Q...                    upper case - see below, it is the common case
//
// UPPER CASE IS NOT A CURIOSITY, IT IS THE COMMON CASE. QR's alphanumeric mode
// covers digits and CAPITALS only and is far denser than byte mode, so encoders
// routinely upper-case a bech32 address to shrink the code. BIP173 allows
// exactly that. A reader that only accepted lower case would fail on a large
// share of real-world codes.

using System;
using System.Globalization;

namespace PCoinTray
{
    static class PaymentUri
    {
        /**
         * A destination, and an amount only if one was stated readably.
         *
         * HasAmount false means "not stated", NEVER zero: the send screen
         * leaves the field empty and the person types what they mean to pay.
         * Inventing a number here would be inventing a payment - the CLAUDE.md
         * 7.1 rule about unknown states, applied to the one field that decides
         * how much money moves.
         */
        public class Target
        {
            public string Address = "";
            public bool HasAmount;
            public long AmountSat;
        }

        /** Schemes seen in the wild for this chain. Compared case-insensitively. */
        static readonly string[] SCHEMES = { "pcoin:", "pcn:", "bitcoin:" };

        /**
         * Below this it is not an address, it is a stray string.
         *
         * The same constant the address book uses to decide whether someone has
         * finished typing. One number, because they are the same question asked
         * by two screens, and two copies would drift.
         */
        public const int MIN_ADDRESS = AddressBook.LOOKS_LIKE_ADDRESS;

        /**
         * The whole string, understood as a payment - or null when it is not
         * one.
         *
         * Null is a real answer and callers must render it as one: a QR holding
         * a URL or a sentence is not a malformed address, it is not an address,
         * and telling someone "invalid address" about a photograph of a poster
         * sends them looking for a typo that does not exist.
         */
        public static Target Parse(string raw)
        {
            string s = (raw ?? "").Trim();
            if (s.Length == 0) return null;

            s = StripScheme(s);

            int q = s.IndexOf('?');
            string query = q >= 0 ? s.Substring(q + 1) : "";
            string address = FoldCase((q >= 0 ? s.Substring(0, q) : s).Trim());

            if (address.Length < MIN_ADDRESS) return null;
            if (!LooksLikeAddress(address)) return null;

            var t = new Target { Address = address };
            long sat;
            if (AmountFrom(query, out sat)) { t.HasAmount = true; t.AmountSat = sat; }
            return t;
        }

        /**
         * Is this the SHAPE of an address? Not whether it is a valid one.
         *
         * Every address on this chain is alphanumeric: bech32's charset is
         * digits and letters, and base58 is the alphanumerics minus 0, O, I and
         * l. So a string carrying a dot, a slash, a colon or a space is not an
         * address in any encoding PCoin uses, and cannot become one.
         *
         * THIS EXISTS BECAUSE OF A REAL CASE. Without it "https://pc.am/download"
         * is a payment: over twenty characters, no whitespace, no scheme this
         * file knows. Scanning a poster's website QR would then fill the pay-to
         * field with a URL, and the node would answer "malformed address" -
         * sending someone to hunt for a typo in something that was never an
         * address. "That code is not a payment" is the true statement, and it
         * can only be made here.
         *
         * It is a filter on what to TREAT AS A PAYMENT, never a judgement that
         * the address is good; validateaddress still decides that, and this
         * rule cannot reject anything validateaddress would have accepted.
         * (The Android PaymentUri checks only whitespace. This is deliberately
         * stricter, in the one direction that cannot lose a real address.)
         */
        static bool LooksLikeAddress(string a)
        {
            foreach (char c in a)
            {
                bool alnum = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
                if (!alnum) return false;
            }
            return true;
        }

        /**
         * Drop a `pcoin:` / `pcn:` / `bitcoin:` prefix and any empty authority
         * after it. Everything else is returned unchanged.
         *
         * Case-insensitive because a QR encoder that upper-cased the address to
         * reach alphanumeric mode upper-cased the scheme with it, and a
         * reader that only matched "pcoin:" would hand "PCOIN:PC1Q..." to the
         * node as an address and be told it was malformed.
         */
        public static string StripScheme(string raw)
        {
            string s = (raw ?? "").Trim();
            foreach (string scheme in SCHEMES)
            {
                if (s.Length >= scheme.Length &&
                    string.Equals(s.Substring(0, scheme.Length), scheme, StringComparison.OrdinalIgnoreCase))
                {
                    s = s.Substring(scheme.Length);
                    break;
                }
            }
            // Some encoders write pcoin://addr. An empty authority is not a host.
            while (s.Length > 0 && s[0] == '/') s = s.Substring(1);
            return s;
        }

        /**
         * Fold an all-uppercase bech32 address to lower case; leave anything
         * else exactly as it is.
         *
         * Delegates to ForwardPolicy, which already carries the careful version
         * of this rule and the reasoning for it: base58 IS case-sensitive, so
         * folding one would silently turn a valid address into a different
         * valid-looking one.
         */
        public static string FoldCase(string a)
        {
            return ForwardPolicy.FoldUppercaseBech32(a ?? "");
        }

        /**
         * The amount, if the query states one readably.
         *
         * Anything unreadable yields "not stated" rather than an error, and
         * that is the deliberate direction: an unparsable amount must not stop
         * the ADDRESS from reaching the field, because the address is the part
         * that is hard to type and easy to get wrong. The consequence is an
         * empty amount box, which the person fills in and then reviews - a
         * visible gap, not a silent wrong number.
         */
        static bool AmountFrom(string query, out long sat)
        {
            sat = 0L;
            if (string.IsNullOrEmpty(query)) return false;
            foreach (string part in query.Split('&'))
            {
                int eq = part.IndexOf('=');
                string key = eq >= 0 ? part.Substring(0, eq) : part;
                if (!string.Equals(key, "amount", StringComparison.OrdinalIgnoreCase)) continue;
                string value = eq >= 0 ? part.Substring(eq + 1) : "";
                long parsed;
                return Amounts.Parse(value, out parsed) == Amounts.Reason.OK && Set(parsed, out sat);
            }
            return false;
        }

        static bool Set(long from, out long to) { to = from; return true; }
    }
}
