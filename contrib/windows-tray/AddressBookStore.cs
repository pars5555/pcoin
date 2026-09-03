// Copyright (c) 2026 The PCoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.
//
// Where the address book lives: one JSON file, written whole.
//
// A port of the Android app's AddressBookStore.kt, on the ForwardStore.cs
// recipe: its own file next to the exe (never a line in a config an installer
// rewrites), a temp file plus File.Replace so an interrupted write can never
// leave a truncated book, and ONE file deliberately - a file per entry would be
// N writes with a kill possible between any two of them, and a book that lost
// half its entries would be indistinguishable from a book the user had pruned.
//
// The names are the user's own words, typed once and expected to still be there
// next year, so this is authoritative intent in the ForwardStore sense: written
// only by a user action and never cleared because something else failed.
//
// A CORRUPT FILE IS NEVER SILENTLY DISCARDED. If the stored text does not parse,
// Load() returns an empty book so the app keeps working - but the raw text is
// copied aside first, ONCE, so the next write cannot be the thing that destroys
// it. "I could not read it" is not "there was nothing there"; that mistake has
// been made three times in this project on much more expensive data
// (CLAUDE.md 7.1).

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;

namespace PCoinTray
{
    /** A file that is readable JSON but not an address book. */
    class AddressBookUnreadable : Exception
    {
        public AddressBookUnreadable(string message) : base(message) { }
    }

    class AddressBookStore
    {
        public const string FILE = "pcoin-addressbook.json";
        /** The preserved copy of a file that could not be read. Written once. */
        public const string CORRUPT_FILE = "pcoin-addressbook.corrupt.json";
        /** The default name offered on export. */
        public const string EXPORT_FILE = "pcoin-addressbook.json";
        /** ~50x a full book. A file this big is not an address book. */
        public const long IMPORT_MAX_BYTES = 1024L * 1024L;

        const string K_VERSION = "v";
        const string K_ENTRIES = "entries";
        const string K_ADDRESS = "a";
        const string K_NAME = "n";
        const string K_ADDED = "t";
        const string K_USED = "u";

        readonly string _path;
        readonly string _corruptPath;
        readonly object _lock = new object();

        /**
         * Set by the last Load() when the file existed and could not be read.
         * The UI tells the user, once, where the copy was kept. Never used to
         * decide anything.
         */
        public bool LastLoadUnreadable;
        public string LastLoadWhy = "";

        public AddressBookStore(string dir)
        {
            _path = Path.Combine(dir, FILE);
            _corruptPath = Path.Combine(dir, CORRUPT_FILE);
        }

        public string Path_ { get { return _path; } }
        public string CorruptPath { get { return _corruptPath; } }

        public List<AddressBookEntry> Load()
        {
            lock (_lock)
            {
                LastLoadUnreadable = false;
                LastLoadWhy = "";
                if (!File.Exists(_path)) return new List<AddressBookEntry>();
                string raw;
                try { raw = File.ReadAllText(_path); }
                catch (Exception ex)
                {
                    // Cannot even read the bytes. Not "empty": say so, and touch
                    // nothing.
                    LastLoadUnreadable = true;
                    LastLoadWhy = ex.Message;
                    return new List<AddressBookEntry>();
                }
                try
                {
                    return Decode(raw);
                }
                catch (Exception ex)
                {
                    LastLoadUnreadable = true;
                    LastLoadWhy = ex.GetType().Name;
                    Preserve(raw);
                    return new List<AddressBookEntry>();
                }
            }
        }

        /**
         * Keep a copy of a file that could not be read - ONCE. A second
         * failure must not overwrite the first preserved copy with whatever
         * replaced it, which by then may be the empty book this class wrote.
         */
        void Preserve(string raw)
        {
            try
            {
                if (File.Exists(_corruptPath)) return;
                File.WriteAllText(_corruptPath, raw, new UTF8Encoding(false));
            }
            catch { }
        }

        public void Save(List<AddressBookEntry> entries)
        {
            lock (_lock)
            {
                string tmp = _path + ".tmp";
                File.WriteAllText(tmp, Encode(entries), new UTF8Encoding(false));
                try
                {
                    if (File.Exists(_path)) File.Replace(tmp, _path, null);
                    else File.Move(tmp, _path);
                }
                catch
                {
                    try { File.Delete(tmp); } catch { }
                    throw;
                }
            }
        }

        /** The name for an address, or null. See AddressBook.LabelFor on why null. */
        public string Label(string address) { return AddressBook.LabelFor(Load(), address); }

        /**
         * Add or rename, returning the stored book.
         *
         * Validation is the CALLER's job - every caller has a screen to report
         * a NameProblem on, and a store that silently cleaned up a bad name
         * would leave the user looking at something they did not type.
         */
        public List<AddressBookEntry> Put(string address, string name, long nowMs)
        {
            var book = AddressBook.Upsert(Load(), address, name, nowMs);
            Save(book);
            return book;
        }

        public List<AddressBookEntry> Remove(string address)
        {
            var book = AddressBook.Remove(Load(), address);
            Save(book);
            return book;
        }

        /**
         * Note that an address was just paid, for list ordering.
         *
         * Never creates an entry, and a failure here is not worth reporting:
         * the consequence of losing it is that a name sorts lower than it
         * might have.
         */
        public void Touch(string address, long nowMs)
        {
            try
            {
                var before = Load();
                var after = AddressBook.Touch(before, address, nowMs);
                if (!ReferenceEquals(before, after)) Save(after);
            }
            catch { }
        }

        /**
         * The book as a file the user keeps: EXACTLY the stored format, so an
         * import goes through the same Decode that reads the book at startup -
         * same version gate, same per-entry salvage, same dedup. One format
         * means one reader, and the reader is the code that is already trusted.
         */
        public string ExportJson() { return Encode(Load()); }

        /**
         * Merge an exported file back in. THROWS on anything unreadable - the
         * caller shows the failure; an import that silently does nothing would
         * be indistinguishable from one that worked (CLAUDE.md 7.1).
         *
         * The current book always wins; see AddressBook.Merge. Nothing is
         * written unless something was actually added.
         */
        public AddressBookImportResult ImportJson(string raw)
        {
            var result = AddressBook.Merge(Load(), Decode(raw));
            if (result.Added > 0) Save(result.Merged);
            return result;
        }

        /** Read a file chosen by the user and import it. Size-capped first. */
        public AddressBookImportResult ImportFile(string path)
        {
            long len = new FileInfo(path).Length;
            if (len > IMPORT_MAX_BYTES)
                throw new AddressBookUnreadable("that file is too large to be an address book");
            return ImportJson(File.ReadAllText(path));
        }

        public static string Encode(List<AddressBookEntry> entries)
        {
            var sb = new StringBuilder();
            sb.Append("{\"").Append(K_VERSION).Append("\":").Append(AddressBook.FORMAT_VERSION.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"").Append(K_ENTRIES).Append("\":[");
            for (int i = 0; i < entries.Count; i++)
            {
                var e = entries[i];
                if (i > 0) sb.Append(',');
                sb.Append("{\"").Append(K_ADDRESS).Append("\":").Append(Json.Quote(e.Address));
                sb.Append(",\"").Append(K_NAME).Append("\":").Append(Json.Quote(e.Name));
                sb.Append(",\"").Append(K_ADDED).Append("\":").Append(e.AddedAtMs.ToString(CultureInfo.InvariantCulture));
                sb.Append(",\"").Append(K_USED).Append("\":").Append(e.LastUsedAtMs.ToString(CultureInfo.InvariantCulture));
                sb.Append('}');
            }
            sb.Append("]}");
            return sb.ToString();
        }

        /**
         * Skips entries it cannot make sense of rather than failing the whole
         * read.
         *
         * One unreadable row losing the other forty-nine names is a much worse
         * outcome than one name going missing, and an entry with no address is
         * not recoverable by any means - there is nothing to match it against.
         *
         * A blob that parses as JSON but is not the shape this class writes has
         * to reach the same preserve-and-empty path as one that does not parse
         * at all, so both the version gate and the missing array THROW.
         */
        public static List<AddressBookEntry> Decode(string raw)
        {
            object root = Json.Parse(raw);                  // throws on malformed JSON
            if (Json.Obj(root) == null) throw new AddressBookUnreadable("not a JSON object");
            // Readable if it is this format or an older one. See
            // AddressBook.CanRead for why refusing an OLDER file would wipe
            // every user's book the next time the format changes.
            double? v = Json.Number(root, K_VERSION);
            int version = v.HasValue ? (int)v.Value : -1;
            if (!AddressBook.CanRead(version)) throw new AddressBookUnreadable("address book version " + version);
            var arr = Json.Arr(Json.Field(root, K_ENTRIES));
            if (arr == null) throw new AddressBookUnreadable("no entries array");
            var outList = new List<AddressBookEntry>(arr.Count);
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var item in arr)
            {
                if (Json.Obj(item) == null) continue;
                string address = (Json.Str(item, K_ADDRESS) ?? "").Trim();
                string name = AddressBook.CleanName(Json.Str(item, K_NAME));
                if (address.Length == 0 || name.Length == 0) continue;
                // A duplicate key can only come from a file written by
                // something other than Encode(). Keep the first and drop the
                // rest, so lookup stays deterministic.
                if (!seen.Add(AddressBook.Key(address))) continue;
                outList.Add(new AddressBookEntry(
                    address,
                    name,
                    (long)(Json.Number(item, K_ADDED) ?? 0.0),
                    (long)(Json.Number(item, K_USED) ?? 0.0)));
            }
            return outList;
        }
    }
}
