// Copyright (c) 2026 The PCoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.
//
// Decimal text to satoshis, and back.
//
// A 1:1 port of the Android app's Amounts.kt. ForwardPolicy.CoinsSat formats
// for display and has no inverse anywhere in this app, so until now nothing
// could turn what a user typed into an amount. This is that missing half, and
// it is deliberately its own file with its own self-test section: it is the one
// place where a slip becomes a 100,000,000x error.
//
// Rules:
//  * decimal only. (double)"0.1" * 1e8 is 10000000.000000002, and rounding
//    that is a coin flip on the last satoshi.
//  * At most 8 decimal places. More is a typo, not a tiny amount, and silently
//    rounding it would send something other than what was typed.
//  * The separator is a literal '.', never the locale's. A PC set to German
//    renders 1,5 but the node parses 1.5, and accepting both spellings from one
//    field is how someone sends 15 PCN meaning 1.5.
//  * Rejects negatives, blanks, and anything non-finite.

using System;
using System.Globalization;

namespace PCoinTray
{
    static class Amounts
    {
        public const long SATS_PER_COIN = 100000000L;

        /** The dust threshold for P2WPKH: an output below this is unspendable. */
        public const long DUST_SAT = 294L;

        public enum Reason { OK, EMPTY, NOT_A_NUMBER, TOO_MANY_DECIMALS, NEGATIVE, ZERO, DUST, TOO_LARGE }

        /**
         * Parse user input.
         *
         * Accepts a leading/trailing space and a leading '+', because people
         * paste. Accepts no grouping separators at all: "1,000" is ambiguous
         * across locales and is rejected rather than guessed at.
         *
         * @return Reason.OK with `sat` set, or the reason with `sat` = -1. A
         *   -1 rather than 0 on failure, so a caller that forgets to check the
         *   reason cannot accidentally send "nothing" as though it were valid.
         */
        public static Reason Parse(string raw, out long sat)
        {
            sat = -1;
            string s = (raw ?? "").Trim();
            if (s.StartsWith("+", StringComparison.Ordinal)) s = s.Substring(1).Trim();
            if (s.Length == 0) return Reason.EMPTY;
            if (s.IndexOf(',') >= 0) return Reason.NOT_A_NUMBER;

            decimal dec;
            // No AllowThousands, no AllowCurrencySymbol, no whitespace: exactly
            // the grammar BigDecimal(String) accepts on the Android side.
            const NumberStyles style = NumberStyles.AllowLeadingSign | NumberStyles.AllowDecimalPoint | NumberStyles.AllowExponent;
            if (!decimal.TryParse(s, style, CultureInfo.InvariantCulture, out dec)) return Reason.NOT_A_NUMBER;

            if (dec < 0m) return Reason.NEGATIVE;
            if (Scale(dec) > 8) return Reason.TOO_MANY_DECIMALS;
            if (dec == 0m) return Reason.ZERO;

            // 21 M cap: anything past it cannot exist, so it is a typo we can
            // catch before the node has to.
            if (dec > 21000000m) return Reason.TOO_LARGE;

            // Dust is deliberately NOT checked here. "Is this a number?" and "is
            // this worth sending?" are different questions: the first belongs
            // to the field as the user types, the second to the send path,
            // which is also the only place that knows whether this is an exact
            // amount or a send-everything. Conflating them made a valid
            // 1-satoshi amount unparseable.
            sat = (long)(dec * SATS_PER_COIN);       // exact: scale <= 8
            return Reason.OK;
        }

        /** The number of digits after the decimal point, as typed. "1.0" is 1. */
        static int Scale(decimal d)
        {
            int[] bits = decimal.GetBits(d);
            return (bits[3] >> 16) & 0xFF;
        }

        /** Would this output be unspendable? Asked at send time, not at parse time. */
        public static bool IsDust(long sat) { return sat < DUST_SAT; }

        /**
         * Satoshis to the exact fixed-point string the node must be handed.
         *
         * NOT a double. `AmountFromValue` in the node runs ParseFixedPoint over
         * the raw JSON text, and a formatted double can emit "1E-08" for small
         * values, which the node rejects.
         */
        public static string ToNodeString(long sat)
        {
            return string.Format(CultureInfo.InvariantCulture, "{0}.{1:D8}", sat / SATS_PER_COIN, sat % SATS_PER_COIN);
        }

        /** For display next to a currency label. No suffix - the caller adds it. */
        public static string ToPlainString(long sat) { return ToNodeString(sat); }

        /** The wording for each rejection, shared by every amount field. */
        public static string Explain(Reason r)
        {
            switch (r)
            {
                case Reason.EMPTY: return "Enter an amount.";
                case Reason.NOT_A_NUMBER: return "Enter a number, using a dot as the decimal separator.";
                case Reason.TOO_MANY_DECIMALS: return "At most 8 decimal places.";
                case Reason.NEGATIVE: return "The amount cannot be negative.";
                case Reason.ZERO: return "The amount cannot be zero.";
                case Reason.DUST: return "That amount is too small to be spendable (below 0.00000294 PCN).";
                case Reason.TOO_LARGE: return "That is more than the 21,000,000 PCN that will ever exist.";
                default: return "";
            }
        }
    }
}
