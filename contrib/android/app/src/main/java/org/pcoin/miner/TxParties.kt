package org.pcoin.miner

/**
 * Who was on the other side of a transaction, as far as anything can say.
 *
 * PURE. No Android imports, so the rules run on a plain JVM under test. The RPC
 * that fetches the addresses lives in ForwardEngine.
 *
 * THE HONEST LIMIT, STATED ONCE. A PCoin transaction has no "from" field. Inputs
 * only point at earlier outputs, so the closest thing to a sender is the set of
 * addresses whose coins were spent to fund the payment. That is NOT the same as
 * a person:
 *
 *   * Several inputs give several addresses and there is no single answer.
 *   * An input address is very often an exchange's pooled wallet, a service, or
 *     the payer's own change address rather than anything they would call
 *     "their address".
 *
 * So everything here returns a LIST, callers render it as inputs rather than as
 * an identity, and nothing collapses it to one name. Getting this wrong would
 * put a confident wrong "From" on a receipt.
 */
object TxParties {

    /**
     * The addresses on the other side: everything that is not ours, deduplicated,
     * in the order the transaction lists them.
     *
     * [mine] removes our own addresses, which is what turns a raw output list
     * into a destination: a send pays the recipient AND returns change to
     * ourselves, and showing the change address as a counterparty would tell
     * someone they had paid themselves. For a receive it removes the self-spend
     * case for the same reason.
     *
     * Order is preserved rather than sorted. The first input is not more
     * meaningful than the second, but a stable order means the same transaction
     * renders identically every time it is opened, and a list that reshuffles
     * between viewings reads as though the data changed.
     */
    fun counterparties(addresses: List<String>, mine: Set<String>): List<String> {
        val mineKeys = mine.map { AddressBook.key(it) }.toHashSet()
        val seen = HashSet<String>()
        val out = ArrayList<String>()
        for (raw in addresses) {
            val a = raw.trim()
            if (a.isEmpty()) continue
            val k = AddressBook.key(a)
            if (k in mineKeys) continue
            if (!seen.add(k)) continue
            out.add(a)
        }
        return out
    }

    /**
     * Whether an address can be offered as a "pay this" button.
     *
     * Deliberately narrow. Only a genuine counterparty is offered; paying
     * ourselves is not a feature anyone asked for, and an empty or malformed
     * string must never reach the compose field. Everything that survives here
     * still goes through validateaddress at send time -- this is a filter on
     * what to SHOW, not a judgement that the address is good.
     */
    fun payable(addresses: List<String>, mine: Set<String>): List<String> =
        counterparties(addresses, mine).filter { it.length >= AddressBook.LOOKS_LIKE_ADDRESS }

    /**
     * A short description of why a transaction's other side is unknown, or null
     * when it can be resolved.
     *
     * Unconfirmed is the case that matters: inputs are resolved by asking for
     * the transaction WITHIN ITS BLOCK, which is the only way to do it on a node
     * with no txindex, and a transaction that is not in a block yet has no block
     * to ask about. That is a real "not yet", not a failure, and the UI says so
     * rather than showing an empty list that reads as "nobody".
     */
    fun unresolvableReason(confirmations: Int, hasBlockHash: Boolean, isCoinbase: Boolean): String? = when {
        isCoinbase -> "newly mined coins have no sender"
        confirmations <= 0 || !hasBlockHash -> "not in a block yet"
        else -> null
    }
}
