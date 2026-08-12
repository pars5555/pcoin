package org.pcoin.miner

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The address book's rules, on a plain JVM.
 *
 * [AddressBook] has no Android imports precisely so this can run with no device
 * and no emulator. Storage (AddressBookStore) and the screens are not covered
 * here -- what is covered is every rule that decides which name is shown next
 * to which address, because that is the part that could quietly put the wrong
 * label on a destination.
 */
class AddressBookTest {

    private val market = "pc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"
    private val other = "pc1q9d4ywgfnd8h43da5tpcxcn6ajv590cg6d3tg6a"

    private fun entry(address: String, name: String, added: Long = 1L, used: Long = 0L) =
        AddressBook.Entry(address, name, added, used)

    // ------------------------------------------------------------------- keys

    @Test
    fun `bech32 matches regardless of case`() {
        val book = listOf(entry(market, "Market"))
        assertEquals("Market", AddressBook.labelFor(book, market.uppercase()))
        assertEquals("Market", AddressBook.labelFor(book, market.lowercase()))
    }

    @Test
    fun `an uppercase paste does not create a second entry`() {
        var book = AddressBook.upsert(emptyList(), market, "Market", 1L)
        book = AddressBook.upsert(book, market.uppercase(), "Market", 2L)
        assertEquals(1, book.size)
        // The incoming spelling wins: after a send, that is the node's own.
        assertEquals(market.uppercase(), book[0].address)
    }

    @Test
    fun `surrounding whitespace does not defeat a match`() {
        val book = listOf(entry(market, "Market"))
        assertEquals("Market", AddressBook.labelFor(book, "  $market\n"))
    }

    @Test
    fun `mixed case is left alone because it cannot be a valid bech32 address`() {
        // BIP173: valid all-lower or all-upper, never mixed. Folding a mixed
        // case string would let an invalid address inherit a valid one's name.
        val mixed = "pc1QW508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"
        assertEquals(mixed, AddressBook.key(mixed))
        assertNull(AddressBook.labelFor(listOf(entry(market, "Market")), mixed))
    }

    @Test
    fun `base58 case is significant and is not folded`() {
        // Base58 IS case-sensitive, so folding it would merge two genuinely
        // different addresses under one name.
        val a = "PGmqNfjbG1YxpTNQnnQhFqDBRz3LPPQjHF"
        assertEquals(a, AddressBook.key(a))
        assertNull(AddressBook.labelFor(listOf(entry(a, "Cold")), a.lowercase()))
    }

    // -------------------------------------------------- stored format version

    @Test
    fun `an update must never make an existing book unreadable`() {
        // THE ONE THAT MATTERS. An update keeps app-private storage, so the
        // stored blob survives -- but only if the new build will still READ it.
        // A strict equality check here means the first release that bumps the
        // format wipes every user's saved names on upgrade.
        for (v in 1..AddressBook.FORMAT_VERSION) {
            assertTrue("version $v must stay readable", AddressBook.canRead(v))
        }
    }

    @Test
    fun `a newer book is refused rather than partially decoded`() {
        // A downgrade. The blob may carry fields this build does not know, and
        // decoding then rewriting would silently drop them. Refusing sends it
        // to preserve-and-empty, which keeps the newer book intact.
        assertFalse(AddressBook.canRead(AddressBook.FORMAT_VERSION + 1))
        assertFalse(AddressBook.canRead(99))
    }

    @Test
    fun `a missing or nonsense version is not a version`() {
        // optInt returns the default for a blob with no version field at all.
        assertFalse(AddressBook.canRead(0))
        assertFalse(AddressBook.canRead(-1))
    }

    // ------------------------------------------------------------------ names

    @Test
    fun `names are trimmed and internal whitespace collapsed`() {
        assertEquals("Market wallet", AddressBook.cleanName("  Market   wallet  "))
    }

    @Test
    fun `control characters cannot break a name across lines`() {
        // A newline in a name would push the address it sits next to out of
        // view, which is the one thing the labelling rules exist to prevent.
        assertEquals("Market two", AddressBook.cleanName("Market\ntwo"))
        // Tab and NUL, written by code point so this source carries no escapes.
        val withControls = "Market" + 9.toChar() + 0.toChar() + "  two"
        assertEquals("Market two", AddressBook.cleanName(withControls))
    }

    @Test
    fun `an empty or whitespace-only name is refused`() {
        assertEquals(AddressBook.NameProblem.EMPTY, AddressBook.nameProblem("", emptyList()))
        assertEquals(AddressBook.NameProblem.EMPTY, AddressBook.nameProblem("   ", emptyList()))
        assertEquals(AddressBook.NameProblem.EMPTY, AddressBook.nameProblem(null, emptyList()))
    }

    @Test
    fun `an over-long name is refused`() {
        val long = "x".repeat(AddressBook.MAX_NAME + 1)
        assertEquals(AddressBook.NameProblem.TOO_LONG, AddressBook.nameProblem(long, emptyList()))
        assertNull(AddressBook.nameProblem("x".repeat(AddressBook.MAX_NAME), emptyList()))
    }

    @Test
    fun `a duplicate name is refused whatever its case`() {
        val book = listOf(entry(market, "Market"))
        assertEquals(AddressBook.NameProblem.DUPLICATE, AddressBook.nameProblem("market", book))
        assertEquals(AddressBook.NameProblem.DUPLICATE, AddressBook.nameProblem(" MARKET ", book))
    }

    @Test
    fun `an entry keeping its own name is not a duplicate of itself`() {
        val book = listOf(entry(market, "Market"))
        assertNull(AddressBook.nameProblem("Market", book, replacing = AddressBook.key(market)))
        // ...but it still cannot take the name of a DIFFERENT entry.
        val two = book + entry(other, "Exchange")
        assertEquals(
            AddressBook.NameProblem.DUPLICATE,
            AddressBook.nameProblem("Exchange", two, replacing = AddressBook.key(market)),
        )
    }

    @Test
    fun `the book has a ceiling, and renaming inside a full book still works`() {
        val full = (1..AddressBook.MAX_ENTRIES).map { entry("pc1addr$it", "Name $it") }
        assertEquals(AddressBook.NameProblem.BOOK_FULL, AddressBook.nameProblem("New", full))
        assertNull(AddressBook.nameProblem("Renamed", full, replacing = AddressBook.key("pc1addr1")))
    }

    @Test
    fun `the ceiling still fires when the caller passes the new address's own key`() {
        // AddressBookActivity passes AddressBook.key(typed) on EVERY path,
        // including adding a brand-new address, so a ceiling gated on
        // `replacing == null` was dead code at the only call site that could
        // reach it. What decides an add is whether an entry with that key
        // already exists.
        val full = (1..AddressBook.MAX_ENTRIES).map { entry("pc1addr$it", "Name $it") }
        assertEquals(
            AddressBook.NameProblem.BOOK_FULL,
            AddressBook.nameProblem("New", full, replacing = AddressBook.key("pc1brandnewaddress")),
        )
    }

    // ------------------------------------------------------------ book edits

    @Test
    fun `renaming keeps the usage record`() {
        val book = listOf(entry(market, "Market", added = 100L, used = 500L))
        val renamed = AddressBook.upsert(book, market, "Market deposit", 900L)
        assertEquals(1, renamed.size)
        assertEquals("Market deposit", renamed[0].name)
        assertEquals(100L, renamed[0].addedAtMs)
        // Losing this would drop a frequently-paid entry to the bottom of the
        // list every time its name was corrected.
        assertEquals(500L, renamed[0].lastUsedAtMs)
    }

    @Test
    fun `touch never invents an entry for an address with no name`() {
        val book = AddressBook.touch(emptyList(), market, 42L)
        assertTrue(book.isEmpty())
    }

    @Test
    fun `touch records use for an address that has a name`() {
        val book = AddressBook.touch(listOf(entry(market, "Market")), market.uppercase(), 42L)
        assertEquals(42L, book[0].lastUsedAtMs)
    }

    @Test
    fun `removing takes the name and nothing else`() {
        val book = listOf(entry(market, "Market"), entry(other, "Exchange"))
        val left = AddressBook.remove(book, market.uppercase())
        assertEquals(1, left.size)
        assertEquals("Exchange", left[0].name)
    }

    @Test
    fun `ordering is most recently touched first, then alphabetical`() {
        val book = listOf(
            entry(market, "Market", added = 10L, used = 0L),
            entry(other, "Exchange", added = 5L, used = 900L),
            entry("pc1third", "Alice", added = 20L, used = 0L),
        )
        assertEquals(
            listOf("Exchange", "Alice", "Market"),
            AddressBook.ordered(book).map { it.name },
        )
    }

    @Test
    fun `an entry added a moment ago outranks an older one that was used`() {
        // Being added counts as a touch, so a name saved thirty seconds ago is
        // at the top where it is about to be wanted.
        val book = listOf(
            entry(market, "Market", added = 1L, used = 100L),
            entry(other, "Exchange", added = 200L, used = 0L),
        )
        assertEquals("Exchange", AddressBook.ordered(book).first().name)
    }

    // ------------------------------------------------------- unnamed recipients

    private fun sent(address: String, time: Long = 0L) = ForwardEngine.HistoryEntry(
        txid = "tx-$address-$time",
        kind = ForwardEngine.HistoryEntry.Kind.SENT,
        amountSat = 1L,
        feeSat = 1L,
        confirmations = 1,
        timeSec = time,
        address = address,
    )

    private fun received(address: String) = sent(address).copy(
        kind = ForwardEngine.HistoryEntry.Kind.RECEIVED,
    )

    @Test
    fun `only sends are offered for naming`() {
        // A receive or a coinbase carries YOUR OWN address in that field, so
        // including them would offer to name your own wallet as a counterparty.
        val history = listOf(received(market), sent(other))
        assertEquals(listOf(other), AddressBook.unnamedRecipients(history, emptyList()))
    }

    @Test
    fun `already-named addresses are not offered again`() {
        val history = listOf(sent(market), sent(other))
        val book = listOf(entry(market.uppercase(), "Market"))
        assertEquals(listOf(other), AddressBook.unnamedRecipients(history, book))
    }

    @Test
    fun `repeated payments to one address appear once, newest first`() {
        val history = listOf(sent(other, 300L), sent(market, 200L), sent(other, 100L))
        assertEquals(listOf(other, market), AddressBook.unnamedRecipients(history, emptyList()))
    }

    @Test
    fun `a send with no single destination is skipped`() {
        // listtransactions reports a blank address for a send to several
        // outputs. There is no one counterparty, so there is nothing to name.
        val history = listOf(sent(""), sent("   "), sent(market))
        assertEquals(listOf(market), AddressBook.unnamedRecipients(history, emptyList()))
    }

    @Test
    fun `an unknown address has no name rather than an empty one`() {
        // null, never "": a caller that rendered an empty string would draw a
        // blank label where it meant to draw nothing at all.
        assertNull(AddressBook.labelFor(emptyList(), market))
        assertNull(AddressBook.labelFor(listOf(entry(other, "Exchange")), market))
        assertNotNull(AddressBook.labelFor(listOf(entry(market, "Market")), market))
    }
}
