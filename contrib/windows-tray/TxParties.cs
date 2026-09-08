// Copyright (c) 2026 The PCoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.
//
// Who was on the other side of a transaction, as far as anything can say.
//
// A port of the Android app's TxParties.kt, held to the same vectors in
// SeedSelfTest. PURE: the RPC that fetches the addresses lives in
// ForwardEngine.GetTxDetails.
//
// THE HONEST LIMIT, STATED ONCE. A PCoin transaction has no "from" field.
// Inputs only point at earlier outputs, so the closest thing to a sender is the
// set of addresses whose coins were spent to fund the payment. That is NOT the
// same as a person:
//
//   * Several inputs give several addresses and there is no single answer.
//   * An input address is very often an exchange's pooled wallet, a service, or
//     the payer's own change address rather than anything they would call
//     "their address".
//
// So everything here returns a LIST, callers render it as inputs rather than as
// an identity, and nothing collapses it to one name. Getting this wrong would
// put a confident wrong "From" on a receipt.

using System;
using System.Collections.Generic;

namespace PCoinTray
{
    static class TxParties
    {
        /**
         * The addresses on the other side: everything that is not ours,
         * deduplicated, in the order the transaction lists them.
         *
         * `mine` removes our own addresses, which is what turns a raw output
         * list into a destination: a send pays the recipient AND returns change
         * to ourselves, and showing the change address as a counterparty would
         * tell someone they had paid themselves. For a receive it removes the
         * self-spend case for the same reason.
         *
         * Order is preserved rather than sorted. The first input is not more
         * meaningful than the second, but a stable order means the same
         * transaction renders identically every time it is opened, and a list
         * that reshuffles between viewings reads as though the data changed.
         */
        public static List<string> Counterparties(List<string> addresses, ICollection<string> mine)
        {
            var mineKeys = new HashSet<string>(StringComparer.Ordinal);
            if (mine != null)
                foreach (string m in mine)
                    if (!string.IsNullOrEmpty(m)) mineKeys.Add(AddressBook.Key(m));

            var seen = new HashSet<string>(StringComparer.Ordinal);
            var outList = new List<string>();
            if (addresses == null) return outList;
            foreach (string raw in addresses)
            {
                string a = (raw ?? "").Trim();
                if (a.Length == 0) continue;
                string k = AddressBook.Key(a);
                if (mineKeys.Contains(k)) continue;
                if (!seen.Add(k)) continue;
                outList.Add(a);
            }
            return outList;
        }

        /**
         * Whether an address can be offered as a "pay this" button.
         *
         * Deliberately narrow. Only a genuine counterparty is offered; paying
         * ourselves is not a feature anyone asked for, and an empty or
         * malformed string must never reach the compose field. Everything that
         * survives here still goes through validateaddress at send time - this
         * is a filter on what to SHOW, not a judgement that the address is good.
         */
        public static List<string> Payable(List<string> addresses, ICollection<string> mine)
        {
            var outList = new List<string>();
            foreach (string a in Counterparties(addresses, mine))
                if (a.Length >= AddressBook.LOOKS_LIKE_ADDRESS) outList.Add(a);
            return outList;
        }

        /**
         * A short description of why a transaction's other side is unknown, or
         * null when it can be resolved.
         *
         * Unconfirmed is the case that matters: inputs are resolved by asking
         * for the transaction WITHIN ITS BLOCK, which is the only way to do it
         * on a node with no txindex, and a transaction that is not in a block
         * yet has no block to ask about. That is a real "not yet", not a
         * failure, and the UI says so rather than showing an empty list that
         * reads as "nobody".
         */
        public static string UnresolvableReason(int confirmations, bool hasBlockHash, bool isCoinbase)
        {
            if (isCoinbase) return "newly mined coins have no sender";
            if (confirmations <= 0 || !hasBlockHash) return "not in a block yet";
            return null;
        }
    }
}
