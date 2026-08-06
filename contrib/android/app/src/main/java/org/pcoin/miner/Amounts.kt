package org.pcoin.miner

import java.math.BigDecimal
import java.math.RoundingMode
import java.util.Locale

/**
 * Decimal text to satoshis, and back.
 *
 * `Fmt.coins` formats for display and has no inverse anywhere in the app, so
 * until now nothing could turn what a user typed into an amount. This is that
 * missing half, and it is deliberately its own file with its own tests: it is
 * the one place where a slip becomes a 100,000,000x error.
 *
 * Rules:
 *  * BigDecimal only. `"0.1".toDouble() * 1e8` is 10000000.000000002, and
 *    rounding that is a coin flip on the last satoshi.
 *  * At most 8 decimal places. More is a typo, not a tiny amount, and silently
 *    rounding it would send something other than what was typed.
 *  * The separator is a literal '.', never the locale's. A phone set to German
 *    renders 1,5 but the node parses 1.5, and accepting both spellings from one
 *    field is how someone sends 15 PCN meaning 1.5.
 *  * Rejects negatives, blanks, and anything non-finite.
 */
object Amounts {

    const val SATS_PER_COIN = 100_000_000L

    /** The dust threshold for P2WPKH: an output below this is unspendable. */
    const val DUST_SAT = 294L

    sealed class Parsed {
        data class Ok(val sat: Long) : Parsed()
        data class Bad(val why: Reason) : Parsed()
    }

    enum class Reason { EMPTY, NOT_A_NUMBER, TOO_MANY_DECIMALS, NEGATIVE, ZERO, DUST, TOO_LARGE }

    /**
     * Parse user input.
     *
     * Accepts a leading/trailing space and a leading '+', because people paste.
     * Accepts no grouping separators at all: "1,000" is ambiguous across
     * locales and is rejected rather than guessed at.
     */
    fun parse(raw: String?): Parsed {
        val s = raw?.trim()?.removePrefix("+")?.trim().orEmpty()
        if (s.isEmpty()) return Parsed.Bad(Reason.EMPTY)
        if (s.any { it == ',' }) return Parsed.Bad(Reason.NOT_A_NUMBER)

        val dec = try {
            BigDecimal(s)
        } catch (_: NumberFormatException) {
            return Parsed.Bad(Reason.NOT_A_NUMBER)
        }

        if (dec.signum() < 0) return Parsed.Bad(Reason.NEGATIVE)
        if (dec.scale() > 8) return Parsed.Bad(Reason.TOO_MANY_DECIMALS)
        if (dec.signum() == 0) return Parsed.Bad(Reason.ZERO)

        // 21 M cap: anything past it cannot exist, so it is a typo we can catch
        // before the node has to.
        if (dec > BigDecimal("21000000")) return Parsed.Bad(Reason.TOO_LARGE)

        // Dust is deliberately NOT checked here. "Is this a number?" and "is this
        // worth sending?" are different questions: the first belongs to the
        // field as the user types, the second to the send path, which is also
        // the only place that knows whether this is an exact amount or a
        // send-everything. Conflating them made a valid 1-satoshi amount
        // unparseable.
        val sat = dec.movePointRight(8).setScale(0, RoundingMode.UNNECESSARY).toLong()
        return Parsed.Ok(sat)
    }

    /** Would this output be unspendable? Asked at send time, not at parse time. */
    fun isDust(sat: Long): Boolean = sat < DUST_SAT

    /**
     * Satoshis to the exact fixed-point string the node must be handed.
     *
     * NOT a Double. `AmountFromValue` in the node runs ParseFixedPoint over the
     * raw JSON text, and org.json's double path can emit "1.0E-8" for small
     * values, which the node rejects. The existing probe survives only because
     * 100000000/1e8 is exactly 1.0.
     */
    fun toNodeString(sat: Long): String =
        String.format(Locale.ROOT, "%d.%08d", sat / SATS_PER_COIN, sat % SATS_PER_COIN)

    /** For display next to a currency label. No suffix -- the caller adds it. */
    fun toPlainString(sat: Long): String = toNodeString(sat)
}
