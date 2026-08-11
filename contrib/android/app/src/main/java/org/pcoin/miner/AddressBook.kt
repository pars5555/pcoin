package org.pcoin.miner

/**
 * The address book: names this phone has given to addresses it pays.
 *
 * PURE. No Android imports, deliberately, so every rule below runs on a plain
 * JVM under test. Storage is [AddressBookStore]; the screens are
 * AddressBookActivity and the compose step of SendActivity.
 *
 * WHAT A NAME IS, AND WHAT IT IS NOT.
 * A name is a note this phone keeps to itself. It is not a claim about who
 * controls an address, nothing signs it, and nothing can check it -- there is
 * no identity layer on this chain, and `verifymessage` cannot even handle a
 * bech32 address in this fork (common/signmessage.cpp rejects anything that is
 * not P2PKH). Two rules follow, and both are enforced at every call site:
 *
 *   1. A name NEVER replaces an address on screen. It is shown next to one.
 *      A book entry whose address was mistyped when it was saved would
 *      otherwise be a permanent, confident label over the wrong destination.
 *   2. The book NEVER decides where money goes. Tapping an entry fills in a
 *      field; the node still validates and canonicalises that string in
 *      prepareSend, and the review step still shows what was actually built.
 *
 * MATCHING IS BY A NORMALISED KEY, NOT BY THE STRING.
 * BIP173 says a bech32 address is valid written all-lower or all-upper, and is
 * INVALID in mixed case. The node reports every address in lower case, but a
 * person can type or paste one in upper case, and a book that keyed on the raw
 * string would then hold two entries for one address and fail to recognise the
 * address it had just saved. [key] folds case for bech32 only. Base58 is left
 * exactly as written, because base58 IS case-sensitive and folding it would
 * merge two genuinely different addresses.
 *
 * RENAMING DOES NOT REWRITE THE PAST.
 * Nothing stores a name against a transaction. History looks the name up live,
 * by address, every time it draws -- so renaming an entry changes every screen
 * at once and can never leave one screen disagreeing with another. This is also
 * why removing an entry is safe: it takes away a label, never a record.
 */
object AddressBook {

    /** Long enough for "Exchange deposit (main)", short enough to fit a row. */
    const val MAX_NAME = 32

    /**
     * A ceiling, because the whole book is one SharedPreferences value that is
     * written with commit() on the UI thread. 200 entries is far past any real
     * use and still a blob measured in tens of kilobytes.
     */
    const val MAX_ENTRIES = 200

    /**
     * Shortest string the UI will treat as "an address someone has finished
     * typing". Only used to decide whether to say "not in your address book" --
     * never to accept or reject anything. PCoin bech32 addresses are 42
     * characters; base58 are 26..35.
     */
    const val LOOKS_LIKE_ADDRESS = 20

    /** The bech32 human-readable part, plus its separator. `PCOIN.md` §1. */
    private const val BECH32_PREFIX = "pc1"

    data class Entry(
        /**
         * As the node spells it whenever the node has had a chance to: an entry
         * saved after a send stores `Prepared.destination`, which came back
         * from validateaddress. An entry typed by hand stores what was typed.
         */
        val address: String,
        val name: String,
        val addedAtMs: Long,
        /** 0 when it has never been paid since it was named. */
        val lastUsedAtMs: Long,
    ) {
        val key: String get() = AddressBook.key(address)

        /**
         * What the list sorts on: most recently touched first, where being
         * added counts as a touch. A name saved thirty seconds ago is the one
         * most likely to be wanted next, and it would otherwise sink below
         * every older entry that had ever been paid.
         */
        val recencyMs: Long get() = maxOf(lastUsedAtMs, addedAtMs)
    }

    enum class NameProblem { EMPTY, TOO_LONG, DUPLICATE, BOOK_FULL }

    /**
     * The identity of an address for lookup purposes.
     *
     * `lowercase()` with no argument is Locale.ROOT in Kotlin, and that is
     * load-bearing rather than incidental: the Turkish locale maps 'I' to 'ı',
     * so a locale-sensitive fold would produce a key on a Turkish phone that
     * matches nothing and silently loses every saved name.
     *
     * A mixed-case string is left alone. It cannot be a valid bech32 address,
     * so folding it could only ever make an invalid address collide with a
     * valid one and inherit its name.
     */
    fun key(address: String): String {
        val a = address.trim()
        if (!a.regionMatches(0, BECH32_PREFIX, 0, BECH32_PREFIX.length, ignoreCase = true)) return a
        val hasUpper = a.any { it in 'A'..'Z' }
        val hasLower = a.any { it in 'a'..'z' }
        return if (hasUpper && hasLower) a else a.lowercase()
    }

    /**
     * A name as it will be stored: no control characters, no runs of spaces, no
     * leading or trailing space.
     *
     * Newlines matter more than they look. A name goes into a one-line row and
     * into `history_party_to`, so an embedded newline would push the address
     * out of view -- which is exactly the thing rule 1 above exists to stop.
     */
    fun cleanName(raw: String?): String {
        val collapsed = StringBuilder()
        var pendingSpace = false
        for (ch in raw.orEmpty()) {
            val c = if (ch.isISOControl() || ch == ' ') ' ' else ch
            if (c == ' ') {
                if (collapsed.isNotEmpty()) pendingSpace = true
            } else {
                if (pendingSpace) collapsed.append(' ')
                pendingSpace = false
                collapsed.append(c)
            }
        }
        return collapsed.toString()
    }

    /**
     * Why this name cannot be stored, or null when it can.
     *
     * [replacing] is the key of the entry being renamed, so an entry keeping
     * its own name is not a duplicate of itself.
     *
     * Duplicate names are refused rather than allowed with a warning. The book
     * exists so that a name identifies a destination; two entries called
     * "market" in a tappable list is the one failure mode that turns the
     * feature into a way to pay the wrong address confidently.
     */
    fun nameProblem(
        raw: String?,
        entries: List<Entry>,
        replacing: String? = null,
    ): NameProblem? {
        val name = cleanName(raw)
        if (name.isEmpty()) return NameProblem.EMPTY
        if (name.length > MAX_NAME) return NameProblem.TOO_LONG
        if (entries.any { it.key != replacing && it.name.equals(name, ignoreCase = true) }) {
            return NameProblem.DUPLICATE
        }
        if (replacing == null && entries.size >= MAX_ENTRIES) return NameProblem.BOOK_FULL
        return null
    }

    fun find(entries: List<Entry>, address: String?): Entry? {
        val a = address?.trim().orEmpty()
        if (a.isEmpty()) return null
        val k = key(a)
        return entries.firstOrNull { it.key == k }
    }

    /**
     * The name for an address, or null when there isn't one.
     *
     * null, never "". "I have no name for this" is a different fact from "its
     * name is empty", and a caller that renders an empty string draws a blank
     * label where it meant to draw nothing -- the §7.1 rule about unknown
     * states, applied to a much smaller thing than money.
     */
    fun labelFor(entries: List<Entry>, address: String?): String? = find(entries, address)?.name

    /**
     * Add or rename. Returns a new list; the caller stores it.
     *
     * An existing entry keeps its `addedAtMs` and `lastUsedAtMs` -- renaming is
     * not a new relationship with the address, and losing the usage record
     * would push a frequently-paid entry to the bottom of the list every time
     * its name was corrected.
     *
     * The ADDRESS of an existing entry is overwritten with the incoming
     * spelling, because they share a key and the incoming one is the more
     * likely to have come from the node: saving after a send passes
     * `Prepared.destination`, and that is validateaddress's own re-encoding.
     */
    fun upsert(entries: List<Entry>, address: String, name: String, nowMs: Long): List<Entry> {
        val clean = cleanName(name)
        val k = key(address)
        val existing = entries.firstOrNull { it.key == k }
        val entry = Entry(
            address = address.trim(),
            name = clean,
            addedAtMs = existing?.addedAtMs ?: nowMs,
            lastUsedAtMs = existing?.lastUsedAtMs ?: 0L,
        )
        return if (existing == null) entries + entry
        else entries.map { if (it.key == k) entry else it }
    }

    fun remove(entries: List<Entry>, address: String): List<Entry> {
        val k = key(address)
        return entries.filterNot { it.key == k }
    }

    /**
     * Record that this address was just paid, for ordering only.
     *
     * Deliberately does NOT create an entry for an unknown address. A send to
     * an address nobody has named must not put a nameless row in the book; it
     * appears under "recently sent" instead, which is drawn from the wallet's
     * own history and needs nothing stored here.
     */
    fun touch(entries: List<Entry>, address: String, nowMs: Long): List<Entry> {
        val k = key(address)
        if (entries.none { it.key == k }) return entries
        return entries.map { if (it.key == k) it.copy(lastUsedAtMs = nowMs) else it }
    }

    /** Most recently touched first, then alphabetically. */
    fun ordered(entries: List<Entry>): List<Entry> =
        entries.sortedWith(
            compareByDescending<Entry> { it.recencyMs }
                .thenBy { it.name.lowercase() }
        )

    /**
     * Addresses this wallet has paid that have no name yet, newest first.
     *
     * Drawn from wallet history rather than from anything stored, which is why
     * it is honest with no bookkeeping at all: it is a view of what the node
     * says happened, minus what the book already covers.
     *
     * Only SENT entries. A receive or a coinbase carries YOUR OWN address in
     * that field (see HistoryActivity.party), so including them would offer to
     * name your own wallet as though it were a counterparty.
     */
    fun unnamedRecipients(
        history: List<ForwardEngine.HistoryEntry>,
        entries: List<Entry>,
        limit: Int = 20,
    ): List<String> {
        val known = entries.map { it.key }.toHashSet()
        val seen = HashSet<String>()
        val out = ArrayList<String>()
        for (h in history) {
            if (h.kind != ForwardEngine.HistoryEntry.Kind.SENT) continue
            // A send to several destinations reports a blank address. There is
            // no single counterparty to name, so there is nothing to offer.
            val a = h.address.trim()
            if (a.isEmpty()) continue
            val k = key(a)
            if (k in known || !seen.add(k)) continue
            out.add(a)
            if (out.size >= limit) break
        }
        return out
    }
}
