package org.pcoin.miner

/**
 * What a scanned QR code might contain, and what to do with it.
 *
 * PURE. No Android imports, so every rule below runs on a plain JVM under test.
 * The camera and the decoder live in ScanActivity; this file decides what the
 * decoded TEXT means.
 *
 * WHAT THIS DOES NOT DO. It does not decide that an address is valid, spendable,
 * or on this chain. It cannot -- only the node can, and it still does, in
 * prepareSend, exactly as it does for a pasted address. A scan is a faster way
 * to fill a text field and nothing more: the review step still shows the
 * destination the node actually built. See [AddressBook] for the same rule
 * applied to saved names.
 *
 * FORMS ACCEPTED
 *   pc1q...                       a bare address, which is what this app's own
 *                                 Receive screen encodes
 *   pcoin:pc1q...                 a URI, which is what other wallets tend to
 *   pcoin:pc1q...?amount=1.5      with an amount, BIP21 style
 *   PC1Q...                       upper case, because QR encoders switch to
 *                                 alphanumeric mode for it -- see below
 *
 * UPPER CASE IS NOT A CURIOSITY, IT IS THE COMMON CASE. QR's alphanumeric mode
 * covers digits and CAPITALS only, and it is far denser than byte mode, so
 * encoders routinely upper-case a bech32 address to shrink the code. BIP173
 * allows exactly that. A reader that only accepts lower case would fail on a
 * large share of real-world codes, so anything bech32-shaped is folded down to
 * lower case here -- with the same Locale.ROOT reasoning as [AddressBook.key].
 */
object PaymentUri {

    /**
     * [amountSat] is null when the code did not name an amount, or named one
     * this app could not read. Null means "not stated", never zero: the send
     * screen leaves the field empty and the person types what they mean to pay.
     * Inventing a number here would be inventing a payment.
     */
    data class Target(val address: String, val amountSat: Long?)

    /** Schemes seen in the wild for this chain. Compared case-insensitively. */
    private val SCHEMES = listOf("pcoin:", "pcn:", "bitcoin:")

    /** Below this, it is not an address, it is a stray string. */
    private const val MIN_ADDRESS = 20

    fun parse(raw: String?): Target? {
        var s = raw?.trim().orEmpty()
        if (s.isEmpty()) return null

        // Strip a scheme if there is one. Everything after it, up to '?', is
        // the address.
        for (scheme in SCHEMES) {
            if (s.regionMatches(0, scheme, 0, scheme.length, ignoreCase = true)) {
                s = s.substring(scheme.length)
                break
            }
        }
        // Some encoders write pcoin://addr. An empty authority is not a host.
        while (s.startsWith("/")) s = s.substring(1)

        val query = s.substringAfter('?', "")
        val address = normalise(s.substringBefore('?').trim())
        if (address.length < MIN_ADDRESS) return null
        // An address never contains whitespace. If this one does, the QR held a
        // sentence, not a payment.
        if (address.any { it.isWhitespace() }) return null

        return Target(address, amountFrom(query))
    }

    /**
     * Fold a bech32 address to lower case; leave anything else exactly as it is.
     *
     * Base58 IS case-sensitive, so folding it would corrupt a legitimate
     * address into a different one. Mixed case is left alone because it cannot
     * be valid bech32 anyway, and the node will say so.
     */
    private fun normalise(a: String): String {
        if (!a.regionMatches(0, "pc1", 0, 3, ignoreCase = true)) return a
        val hasUpper = a.any { it in 'A'..'Z' }
        val hasLower = a.any { it in 'a'..'z' }
        return if (hasUpper && hasLower) a else a.lowercase()
    }

    /**
     * The amount, if the code states one readably.
     *
     * Anything unreadable yields null rather than an error, and that is the
     * deliberate direction: an unparsable amount must not stop the address from
     * reaching the field, because the address is the part that is hard to type
     * and easy to get wrong. The consequence of null is an empty amount box,
     * which the person fills in themselves and then reviews -- a visible gap,
     * not a silent wrong number.
     */
    private fun amountFrom(query: String): Long? {
        if (query.isEmpty()) return null
        for (part in query.split('&')) {
            val key = part.substringBefore('=')
            if (!key.equals("amount", ignoreCase = true)) continue
            val value = part.substringAfter('=', "")
            return when (val p = Amounts.parse(value)) {
                is Amounts.Parsed.Ok -> p.sat
                is Amounts.Parsed.Bad -> null
            }
        }
        return null
    }
}
