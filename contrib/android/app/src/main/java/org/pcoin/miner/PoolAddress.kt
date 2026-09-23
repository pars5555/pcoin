package org.pcoin.miner

/**
 * Which pool the miner works for, and whether a typed-in pool is usable.
 *
 * PURE. No Android imports, so every rule below runs on a plain JVM under test
 * (PoolAddressTest). The picker lives in the miner's MainActivity; this file
 * decides what the typed TEXT means and what is stored.
 *
 * THE STORED FORM MUST BE EXACTLY WHAT THE NODE REPORTS BACK. On every tick
 * MinerService compares [Prefs.poolUrl] with getcpuminerinfo's `poolurl`, and
 * restarts the miner when they differ (`poolWrong`). The node builds that field
 * as `host + ":" + std::to_string(port)` (PoolClient::Describe), but its parser
 * is looser than its printer: Core's ParseUInt16 reads "+3333" and "03333" as
 * 3333. A pool stored in either spelling would never compare equal, so the
 * miner would be torn down and restarted every three seconds, mining nothing,
 * while every single start reported success. Hence: the port is ASCII digits
 * only and is stored in canonical decimal, and the host is stored lower-case
 * (DNS ignores case, and a preset typed in capitals then IS the preset).
 *
 * WHAT THIS DOES NOT DO. It cannot tell whether anything is listening there or
 * whether it speaks the pool protocol. Only the node finds that out, when it
 * connects. This check only stops a typo from becoming the stored setting.
 */
object PoolAddress {

    /** The recommended pool and the default for a new install ([Prefs.DEFAULT_POOL]). */
    const val PCOIN_POOL = "pool.pc.am:3333"

    /** The second PCoin pool. */
    const val PCOIN_POOL_2 = "pool2.pc.am:3333"

    /** What a stored pool setting means to the picker. */
    enum class Choice { PCOIN, PCOIN_2, CUSTOM, SOLO }

    /**
     * Blank is SOLO -- the only way [Prefs.poolUrl] says solo. Anything that is
     * not blank and not a preset is CUSTOM.
     */
    fun choiceFor(stored: String): Choice = when (stored.trim()) {
        "" -> Choice.SOLO
        PCOIN_POOL -> Choice.PCOIN
        PCOIN_POOL_2 -> Choice.PCOIN_2
        else -> Choice.CUSTOM
    }

    /** Why a typed pool was refused. The screen turns each one into a sentence. */
    enum class Problem {
        /** Nothing typed. Solo is its own choice, never an empty custom pool. */
        EMPTY,

        /** "http://", "stratum+tcp://" and the like. Only host:port is wanted. */
        SCHEME,

        /**
         * No ":port". There is deliberately no default port: a guessed one
         * would send the phone's work somewhere and look as if it worked.
         */
        NO_PORT,

        /** More than one ':' -- an IPv6 address, or a typo. */
        TOO_MANY_COLONS,

        /** Before the colon: neither a host name nor an IPv4 address. */
        BAD_HOST,

        /** After the colon: not a whole number from 1 to 65535. */
        BAD_PORT,
    }

    sealed class Result {
        /** [hostPort] is the canonical form: the one to store and to hand to the node. */
        data class Valid(val hostPort: String) : Result()

        data class Invalid(val problem: Problem) : Result()
    }

    /** The canonical `host:port`, or null if [raw] is not a usable pool. */
    fun normalize(raw: String): String? = (parse(raw) as? Result.Valid)?.hostPort

    fun parse(raw: String): Result {
        // Surrounding whitespace is what a paste brings with it, not part of
        // what was meant. Whitespace INSIDE is refused below.
        val s = raw.trim()
        if (s.isEmpty()) return Result.Invalid(Problem.EMPTY)
        if (s.contains("://")) return Result.Invalid(Problem.SCHEME)

        val colons = s.count { it == ':' }
        if (colons == 0) return Result.Invalid(Problem.NO_PORT)
        if (colons > 1) return Result.Invalid(Problem.TOO_MANY_COLONS)

        val host = s.substringBefore(':')
        if (!isHost(host)) return Result.Invalid(Problem.BAD_HOST)
        val port = parsePort(s.substringAfter(':')) ?: return Result.Invalid(Problem.BAD_PORT)

        // Lower-cased only AFTER every character was checked to be ASCII. Java
        // folds some non-ASCII letters into ASCII ones -- the Kelvin sign
        // U+212A becomes "k" -- so folding first would let a look-alike through.
        return Result.Valid("${host.lowercase()}:$port")
    }

    private const val MAX_HOST = 253
    private const val MAX_LABEL = 63
    private const val MAX_PORT = 65535

    /**
     * A host name (RFC 1123 labels: ASCII letters, digits and hyphens, 1-63
     * characters, no hyphen at either end) or a dotted-quad IPv4 address.
     *
     * A host made only of digits and dots is taken to be an IPv4 address and
     * must be a real one, so "999.1.1.1" and "1.2.3" are refused rather than
     * waved through as names. For the same reason a name may not end in an
     * all-digit label (RFC 3696 section 2): that is neither a name nor an
     * address.
     */
    private fun isHost(host: String): Boolean {
        if (host.isEmpty() || host.length > MAX_HOST) return false
        if (!host.all { isAsciiLetter(it) || isAsciiDigit(it) || it == '-' || it == '.' }) return false

        val labels = host.split('.')
        if (labels.all { it.isNotEmpty() && it.all(::isAsciiDigit) }) return isIpv4(labels)

        for (label in labels) {
            if (label.isEmpty() || label.length > MAX_LABEL) return false
            if (label.first() == '-' || label.last() == '-') return false
        }
        return !labels.last().all(::isAsciiDigit)
    }

    /**
     * Four decimal octets, 0-255, with no leading zeros. "010" is refused
     * rather than guessed at: some resolvers read it as octal (8).
     */
    private fun isIpv4(octets: List<String>): Boolean {
        if (octets.size != 4) return false
        return octets.all { o ->
            o.length in 1..3 &&
                (o.length == 1 || o[0] != '0') &&
                o.toInt() <= 255
        }
    }

    /**
     * ASCII digits only -- no sign, no spaces, and not Char.isDigit(), which
     * also accepts Arabic-Indic and other Unicode digits. Leading zeros are
     * accepted and dropped, because the node reports the port back without
     * them (see the class comment).
     */
    private fun parsePort(text: String): Int? {
        if (text.isEmpty() || !text.all(::isAsciiDigit)) return null
        val digits = text.trimStart('0')
        if (digits.isEmpty() || digits.length > 5) return null
        return digits.toInt().takeIf { it in 1..MAX_PORT }
    }

    private fun isAsciiDigit(c: Char): Boolean = c in '0'..'9'

    private fun isAsciiLetter(c: Char): Boolean = c in 'a'..'z' || c in 'A'..'Z'
}
