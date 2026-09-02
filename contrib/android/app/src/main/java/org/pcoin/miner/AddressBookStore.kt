package org.pcoin.miner

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

/**
 * Where the address book lives: one JSON blob in one SharedPreferences key.
 *
 * ONE KEY, DELIBERATELY -- the same argument as [Prefs.forwardSweepRecordJson].
 * commit() of a single key is atomic; a key per entry would be N atomic writes
 * with a kill possible between any two of them, and a book that lost half its
 * entries would be indistinguishable from a book the user had pruned.
 *
 * The names are the user's own words, typed once and expected to still be there
 * next year, so this is authoritative intent in the [Prefs] sense: written only
 * by a user action, written with commit(), and never cleared because something
 * else failed.
 *
 * A CORRUPT BLOB IS NEVER SILENTLY DISCARDED. If the stored text does not parse,
 * [load] returns an empty book so the app keeps working -- but the raw text is
 * copied aside first, so the next write cannot be the thing that destroys it.
 * "I could not read it" is not "there was nothing there"; that mistake has been
 * made three times in this project on much more expensive data (§7.1).
 */
class AddressBookStore(context: Context) {

    private val prefs = Prefs(context.applicationContext)

    fun load(): List<AddressBook.Entry> {
        val raw = prefs.addressBookJson ?: return emptyList()
        return try {
            decode(raw)
        } catch (e: Exception) {
            // The exception is NOT passed to Log: Android's JSONTokener embeds
            // the whole input in its message, which would put every address and
            // every name the user typed into logcat.
            Log.w(TAG, "address book unreadable (${e.javaClass.simpleName}); keeping a copy aside")
            prefs.preserveCorruptAddressBook(raw)
            emptyList()
        }
    }

    fun save(entries: List<AddressBook.Entry>) {
        prefs.addressBookJson = encode(entries)
    }

    /** The name for an address, or null. See [AddressBook.labelFor] on why null. */
    fun label(address: String?): String? = AddressBook.labelFor(load(), address)

    /**
     * Add or rename, returning the stored book.
     *
     * Validation is the CALLER's job -- every caller has a screen to report a
     * [AddressBook.NameProblem] on, and a store that silently cleaned up a bad
     * name would leave the user looking at something they did not type.
     */
    fun put(address: String, name: String, nowMs: Long = System.currentTimeMillis()):
        List<AddressBook.Entry> = AddressBook.upsert(load(), address, name, nowMs).also { save(it) }

    fun remove(address: String): List<AddressBook.Entry> =
        AddressBook.remove(load(), address).also { save(it) }

    /**
     * Note that an address was just paid, for list ordering.
     *
     * Never creates an entry, and a failure here is not worth reporting: the
     * consequence of losing it is that a name sorts lower than it might have.
     */
    fun touch(address: String, nowMs: Long = System.currentTimeMillis()) {
        val before = load()
        val after = AddressBook.touch(before, address, nowMs)
        if (after != before) save(after)
    }

    /**
     * The book as a file the user keeps: EXACTLY the stored format, so an
     * import goes through the same [decode] that reads the book at startup —
     * same version gate, same per-entry salvage, same dedup. One format means
     * one reader, and the reader is the code that is already trusted.
     */
    fun exportJson(): String = encode(load())

    /**
     * Merge an exported file back in. Throws on anything unreadable — the
     * caller shows the failure; an import that silently does nothing would be
     * indistinguishable from one that worked (§7.1).
     *
     * The current book always wins; see [AddressBook.merge]. Nothing is
     * written unless something was actually added.
     */
    @Throws(Exception::class)
    fun importJson(raw: String): AddressBook.ImportResult {
        val result = AddressBook.merge(load(), decode(raw))
        if (result.added > 0) save(result.merged)
        return result
    }

    private fun encode(entries: List<AddressBook.Entry>): String {
        val arr = JSONArray()
        for (e in entries) {
            arr.put(
                JSONObject()
                    .put(K_ADDRESS, e.address)
                    .put(K_NAME, e.name)
                    .put(K_ADDED, e.addedAtMs)
                    .put(K_USED, e.lastUsedAtMs)
            )
        }
        return JSONObject().put(K_VERSION, AddressBook.FORMAT_VERSION).put(K_ENTRIES, arr).toString()
    }

    /**
     * Skips entries it cannot make sense of rather than failing the whole read.
     *
     * One unreadable row losing the other forty-nine names is a much worse
     * outcome than one name going missing, and an entry with no address is not
     * recoverable by any means -- there is nothing to match it against.
     */
    private fun decode(raw: String): List<AddressBook.Entry> {
        val root = JSONObject(raw)
        // A blob that parses as JSON but is not the shape this class writes has
        // to reach the same preserve-and-empty path as one that does not parse
        // at all. It used to `return emptyList()` here, which quietly bypassed
        // the guarantee this file makes at the top: the next put() would then
        // overwrite the original. optJSONArray and friends never throw, so
        // nothing else was going to catch it.
        // Readable if it is this format or an older one. See AddressBook.canRead
        // for why refusing an OLDER blob would wipe every user's book the next
        // time the format changes.
        val version = root.optInt(K_VERSION, -1)
        if (!AddressBook.canRead(version)) throw Unreadable("address book version $version")
        val arr = root.optJSONArray(K_ENTRIES) ?: throw Unreadable("no entries array")
        val out = ArrayList<AddressBook.Entry>(arr.length())
        val seen = HashSet<String>()
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val address = o.optString(K_ADDRESS).trim()
            val name = AddressBook.cleanName(o.optString(K_NAME))
            if (address.isEmpty() || name.isEmpty()) continue
            // A duplicate key can only come from a blob written by something
            // other than encode(). Keep the first and drop the rest, so lookup
            // stays deterministic instead of depending on iteration order.
            if (!seen.add(AddressBook.key(address))) continue
            out.add(
                AddressBook.Entry(
                    address = address,
                    name = name,
                    addedAtMs = o.optLong(K_ADDED, 0L),
                    lastUsedAtMs = o.optLong(K_USED, 0L),
                )
            )
        }
        return out
    }

    /** A blob that is readable JSON but not an address book. */
    private class Unreadable(message: String) : Exception(message)

    private companion object {
        const val TAG = "PCoinAddressBook"

        const val K_VERSION = "v"
        const val K_ENTRIES = "entries"
        const val K_ADDRESS = "a"
        const val K_NAME = "n"
        const val K_ADDED = "t"
        const val K_USED = "u"
    }
}
