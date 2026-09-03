// Copyright (c) 2026 The PCoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.
//
// The address book: names this PC has given to addresses it pays.
//
// A 1:1 port of the Android app's AddressBook.kt. PURE: no UI, no I/O,
// deliberately, so every rule below runs under --selftest with no node.
// Storage is AddressBookStore; the screens are in WalletForms.
//
// WHAT A NAME IS, AND WHAT IT IS NOT.
// A name is a note this PC keeps to itself. It is not a claim about who
// controls an address, nothing signs it, and nothing can check it - there is
// no identity layer on this chain, and `verifymessage` cannot even handle a
// bech32 address in this fork (common/signmessage.cpp rejects anything that is
// not P2PKH). Two rules follow, and both are enforced at every call site:
//
//   1. A name NEVER replaces an address on screen. It is shown next to one.
//      A book entry whose address was mistyped when it was saved would
//      otherwise be a permanent, confident label over the wrong destination.
//   2. The book NEVER decides where money goes. Picking an entry fills in a
//      field; the node still validates and canonicalises that string in
//      PrepareSend, and the review step still shows what was actually built.
//
// MATCHING IS BY A NORMALISED KEY, NOT BY THE STRING.
// BIP173 says a bech32 address is valid written all-lower or all-upper, and is
// INVALID in mixed case. The node reports every address in lower case, but a
// person can type or paste one in upper case, and a book that keyed on the raw
// string would then hold two entries for one address and fail to recognise the
// address it had just saved. Key() folds case for bech32 only. Base58 is left
// exactly as written, because base58 IS case-sensitive and folding it would
// merge two genuinely different addresses.
//
// RENAMING DOES NOT REWRITE THE PAST.
// Nothing stores a name against a transaction. History looks the name up live,
// by address, every time it draws - so renaming an entry changes every screen
// at once and can never leave one screen disagreeing with another. This is also
// why removing an entry is safe: it takes away a label, never a record.

using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;

namespace PCoinTray
{
    class AddressBookEntry
    {
        /**
         * As the node spells it whenever the node has had a chance to: an entry
         * saved after a send stores Prepared.Destination, which came back from
         * validateaddress. An entry typed by hand stores what was typed.
         */
        public readonly string Address;
        public readonly string Name;
        public readonly long AddedAtMs;
        /** 0 when it has never been paid since it was named. */
        public readonly long LastUsedAtMs;

        public AddressBookEntry(string address, string name, long addedAtMs, long lastUsedAtMs)
        {
            Address = address ?? "";
            Name = name ?? "";
            AddedAtMs = addedAtMs;
            LastUsedAtMs = lastUsedAtMs;
        }

        public string Key { get { return AddressBook.Key(Address); } }

        /**
         * What the list sorts on: most recently touched first, where being
         * added counts as a touch. A name saved thirty seconds ago is the one
         * most likely to be wanted next, and it would otherwise sink below
         * every older entry that had ever been paid.
         */
        public long RecencyMs { get { return Math.Max(LastUsedAtMs, AddedAtMs); } }

        public AddressBookEntry WithName(string name) { return new AddressBookEntry(Address, name, AddedAtMs, LastUsedAtMs); }
        public AddressBookEntry WithLastUsed(long ms) { return new AddressBookEntry(Address, Name, AddedAtMs, ms); }
    }

    enum NameProblem { EMPTY, TOO_LONG, DUPLICATE, BOOK_FULL }

    /** What an import did: the resulting book, plus counts for the user. */
    class AddressBookImportResult
    {
        public List<AddressBookEntry> Merged = new List<AddressBookEntry>();
        public int Added;
        /** Address already in the book - the existing entry was kept as-is. */
        public int AlreadyKnown;
        /** Name clash or the MAX_ENTRIES cap - the imported entry was NOT added. */
        public int Skipped;
    }

    static class AddressBook
    {
        /**
         * The stored format this build writes. Bump it only alongside a change
         * to what AddressBookStore encodes.
         */
        public const int FORMAT_VERSION = 1;

        /**
         * Can this build read a book stamped with version v?
         *
         * ANYTHING AT OR BELOW THE CURRENT VERSION IS READABLE, and that
         * asymmetry is the whole point. A strict `v == FORMAT_VERSION` looks
         * tidier and is a trap: the day someone bumps the constant to add a
         * field, every user's existing book fails to decode on the FIRST LAUNCH
         * AFTER AN UPDATE and their saved names silently vanish. An update must
         * never cost the user their address book.
         *
         * A NEWER version is refused rather than guessed at. That is a
         * downgrade, where a blob written by a later build contains fields this
         * one does not understand; decoding it partially and then writing it
         * back would discard whatever it did not recognise. Refusing sends it
         * down the preserve-and-empty path instead, so the newer book survives
         * untouched.
         *
         * 0 and negative are not versions at all - they are what a blob with
         * no version field reads as, i.e. corruption.
         */
        public static bool CanRead(int v) { return v >= 1 && v <= FORMAT_VERSION; }

        /** Long enough for "Exchange deposit (main)", short enough to fit a row. */
        public const int MAX_NAME = 32;

        /**
         * A ceiling, because the whole book is one file written whole. 200
         * entries is far past any real use and still a file measured in tens
         * of kilobytes.
         */
        public const int MAX_ENTRIES = 200;

        /**
         * Shortest string the UI will treat as "an address someone has finished
         * typing". Only used to decide whether to say "not in your address
         * book" - never to accept or reject anything. PCoin bech32 addresses
         * are 42 characters; base58 are 26..35.
         */
        public const int LOOKS_LIKE_ADDRESS = 20;

        /** The bech32 human-readable part, plus its separator. PCOIN.md section 1. */
        const string BECH32_PREFIX = "pc1";

        /**
         * The identity of an address for lookup purposes.
         *
         * ToLowerInvariant, never ToLower: the Turkish locale maps a capital I
         * to a dotless i, so a culture-sensitive fold would produce a key on a
         * Turkish PC that matches nothing and silently loses every saved name.
         *
         * A mixed-case string is left alone. It cannot be a valid bech32
         * address, so folding it could only ever make an invalid address
         * collide with a valid one and inherit its name.
         */
        public static string Key(string address)
        {
            string a = (address ?? "").Trim();
            if (a.Length < BECH32_PREFIX.Length ||
                !string.Equals(a.Substring(0, BECH32_PREFIX.Length), BECH32_PREFIX, StringComparison.OrdinalIgnoreCase))
                return a;
            bool hasUpper = false, hasLower = false;
            foreach (char c in a)
            {
                if (c >= 'A' && c <= 'Z') hasUpper = true;
                else if (c >= 'a' && c <= 'z') hasLower = true;
            }
            return hasUpper && hasLower ? a : a.ToLowerInvariant();
        }

        /**
         * A name as it will be stored: no control characters, no runs of
         * spaces, no leading or trailing space.
         *
         * Newlines matter more than they look. A name goes into a one-line row
         * and next to the address in history, so an embedded newline would push
         * the address out of view - which is exactly the thing rule 1 above
         * exists to stop.
         */
        public static string CleanName(string raw)
        {
            var collapsed = new StringBuilder();
            bool pendingSpace = false;
            foreach (char ch in raw ?? "")
            {
                char c = char.IsControl(ch) || ch == ' ' ? ' ' : ch;
                if (c == ' ')
                {
                    if (collapsed.Length > 0) pendingSpace = true;
                }
                else
                {
                    if (pendingSpace) collapsed.Append(' ');
                    pendingSpace = false;
                    collapsed.Append(c);
                }
            }
            return collapsed.ToString();
        }

        /**
         * Why this name cannot be stored, or null when it can.
         *
         * `replacing` is the key of the entry being renamed, so an entry
         * keeping its own name is not a duplicate of itself.
         *
         * Duplicate names are refused rather than allowed with a warning. The
         * book exists so that a name identifies a destination; two entries
         * called "market" in a clickable list is the one failure mode that
         * turns the feature into a way to pay the wrong address confidently.
         */
        public static NameProblem? Problem(string raw, List<AddressBookEntry> entries, string replacing)
        {
            string name = CleanName(raw);
            if (name.Length == 0) return NameProblem.EMPTY;
            if (name.Length > MAX_NAME) return NameProblem.TOO_LONG;
            foreach (var e in entries)
            {
                if (!string.Equals(e.Key, replacing, StringComparison.Ordinal) &&
                    string.Equals(e.Name, name, StringComparison.OrdinalIgnoreCase))
                    return NameProblem.DUPLICATE;
            }
            // The ceiling applies when this operation ADDS an entry. That is
            // NOT the same question as `replacing == null`, and gating on
            // nullness left the cap dead everywhere it mattered: the edit
            // screen passes the typed address's own key on every path,
            // including a brand-new address, so the only caller that could ever
            // hit the limit was the post-send save. Ask the question that
            // decides it instead - is there already an entry under this key? A
            // null `replacing` matches nothing, so the add path still counts as
            // an add.
            bool exists = false;
            foreach (var e in entries) if (string.Equals(e.Key, replacing, StringComparison.Ordinal)) { exists = true; break; }
            if (!exists && entries.Count >= MAX_ENTRIES) return NameProblem.BOOK_FULL;
            return null;
        }

        public static NameProblem? Problem(string raw, List<AddressBookEntry> entries) { return Problem(raw, entries, null); }

        public static string ProblemText(NameProblem p)
        {
            switch (p)
            {
                case NameProblem.EMPTY: return "Enter a name.";
                case NameProblem.TOO_LONG: return "Names are at most " + MAX_NAME + " characters.";
                case NameProblem.DUPLICATE: return "Another entry already has that name.";
                case NameProblem.BOOK_FULL: return "The address book is full (" + MAX_ENTRIES + " entries).";
                default: return "";
            }
        }

        public static AddressBookEntry Find(List<AddressBookEntry> entries, string address)
        {
            string a = (address ?? "").Trim();
            if (a.Length == 0) return null;
            string k = Key(a);
            foreach (var e in entries) if (string.Equals(e.Key, k, StringComparison.Ordinal)) return e;
            return null;
        }

        /**
         * The name for an address, or null when there isn't one.
         *
         * null, never "". "I have no name for this" is a different fact from
         * "its name is empty", and a caller that renders an empty string draws
         * a blank label where it meant to draw nothing - the CLAUDE.md 7.1 rule
         * about unknown states, applied to a much smaller thing than money.
         */
        public static string LabelFor(List<AddressBookEntry> entries, string address)
        {
            var e = Find(entries, address);
            return e == null ? null : e.Name;
        }

        /**
         * Add or rename. Returns a new list; the caller stores it.
         *
         * An existing entry keeps its AddedAtMs and LastUsedAtMs - renaming is
         * not a new relationship with the address, and losing the usage record
         * would push a frequently-paid entry to the bottom of the list every
         * time its name was corrected.
         *
         * The ADDRESS of an existing entry is overwritten with the incoming
         * spelling, because they share a key and the incoming one is the more
         * likely to have come from the node: saving after a send passes
         * Prepared.Destination, and that is validateaddress's own re-encoding.
         */
        public static List<AddressBookEntry> Upsert(List<AddressBookEntry> entries, string address, string name, long nowMs)
        {
            string clean = CleanName(name);
            string k = Key(address);
            AddressBookEntry existing = null;
            foreach (var e in entries) if (string.Equals(e.Key, k, StringComparison.Ordinal)) { existing = e; break; }
            var entry = new AddressBookEntry(
                (address ?? "").Trim(),
                clean,
                existing != null ? existing.AddedAtMs : nowMs,
                existing != null ? existing.LastUsedAtMs : 0L);
            var outList = new List<AddressBookEntry>(entries.Count + 1);
            if (existing == null)
            {
                outList.AddRange(entries);
                outList.Add(entry);
            }
            else
            {
                foreach (var e in entries) outList.Add(string.Equals(e.Key, k, StringComparison.Ordinal) ? entry : e);
            }
            return outList;
        }

        public static List<AddressBookEntry> Remove(List<AddressBookEntry> entries, string address)
        {
            string k = Key(address);
            var outList = new List<AddressBookEntry>(entries.Count);
            foreach (var e in entries) if (!string.Equals(e.Key, k, StringComparison.Ordinal)) outList.Add(e);
            return outList;
        }

        /**
         * Record that this address was just paid, for ordering only.
         *
         * Deliberately does NOT create an entry for an unknown address. A send
         * to an address nobody has named must not put a nameless row in the
         * book; it appears under "recently sent" instead, which is drawn from
         * the wallet's own history and needs nothing stored here.
         *
         * Returns the SAME list instance when nothing changed, so a caller can
         * tell "no entry to touch" from "touched" without comparing contents.
         */
        public static List<AddressBookEntry> Touch(List<AddressBookEntry> entries, string address, long nowMs)
        {
            string k = Key(address);
            bool any = false;
            foreach (var e in entries) if (string.Equals(e.Key, k, StringComparison.Ordinal)) { any = true; break; }
            if (!any) return entries;
            var outList = new List<AddressBookEntry>(entries.Count);
            foreach (var e in entries) outList.Add(string.Equals(e.Key, k, StringComparison.Ordinal) ? e.WithLastUsed(nowMs) : e);
            return outList;
        }

        /** Most recently touched first, then alphabetically. A stable sort. */
        public static List<AddressBookEntry> Ordered(List<AddressBookEntry> entries)
        {
            return entries
                .OrderByDescending(e => e.RecencyMs)
                .ThenBy(e => e.Name.ToLowerInvariant(), StringComparer.Ordinal)
                .ToList();
        }

        /**
         * Merge an exported book into the current one. THE CURRENT BOOK ALWAYS
         * WINS: an import must never rename, move or reorder what the user has
         * now - it is a way to get names back, not a way to overwrite them.
         *
         * An imported entry is added only when its address is unknown AND its
         * name collides with nothing (current or already merged,
         * case-insensitive like Problem()) AND the book is under MAX_ENTRIES.
         * A name clash is skipped rather than suffixed, because two entries
         * with one name is the confident-wrong-payment failure the book must
         * never contain - and an auto-renamed "market (2)" is a label the user
         * never chose.
         */
        public static AddressBookImportResult Merge(List<AddressBookEntry> current, List<AddressBookEntry> imported)
        {
            var r = new AddressBookImportResult();
            r.Merged.AddRange(current);
            var keys = new HashSet<string>(StringComparer.Ordinal);
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (var e in current) { keys.Add(e.Key); names.Add(e.Name.ToLowerInvariant()); }
            foreach (var e in imported)
            {
                string name = CleanName(e.Name);
                if (e.Address.Trim().Length == 0 || name.Length == 0) { r.Skipped++; continue; }
                if (!keys.Add(e.Key)) { r.AlreadyKnown++; continue; }
                if (!names.Add(name.ToLowerInvariant()) || r.Merged.Count >= MAX_ENTRIES)
                {
                    keys.Remove(e.Key);
                    r.Skipped++;
                    continue;
                }
                r.Merged.Add(e.WithName(name));
                r.Added++;
            }
            return r;
        }

        /**
         * Addresses this wallet has paid that have no name yet, newest first.
         *
         * Drawn from wallet history rather than from anything stored, which is
         * why it is honest with no bookkeeping at all: it is a view of what the
         * node says happened, minus what the book already covers.
         *
         * Only SENT entries. A receive or a coinbase carries YOUR OWN address in
         * that field, so including them would offer to name your own wallet as
         * though it were a counterparty.
         */
        public static List<string> UnnamedRecipients(List<HistoryEntry> history, List<AddressBookEntry> entries, int limit)
        {
            var known = new HashSet<string>(StringComparer.Ordinal);
            foreach (var e in entries) known.Add(e.Key);
            var seen = new HashSet<string>(StringComparer.Ordinal);
            var outList = new List<string>();
            foreach (var h in history)
            {
                if (h.Kind != HistoryKind.SENT) continue;
                // A send to several destinations reports a blank address. There
                // is no single counterparty to name, so there is nothing to offer.
                string a = (h.Address ?? "").Trim();
                if (a.Length == 0) continue;
                string k = Key(a);
                if (known.Contains(k) || !seen.Add(k)) continue;
                outList.Add(a);
                if (outList.Count >= limit) break;
            }
            return outList;
        }
    }
}
