package org.pcoin.miner.wallet

/**
 * Strips key material out of text on its way to a log.
 *
 * This is not paranoia about our own call sites. The node echoes offending
 * input back in its RPC error strings, so an `importdescriptors` failure can
 * arrive carrying the entire descriptor -- xprv included -- and
 * NodeController's existing error logging would put it straight into logcat,
 * which adb can read and which lands in bug reports.
 *
 * Everything that touches a descriptor or an extended key must pass its error
 * text through here before logging it. There is no debug-build exemption:
 * debug builds are what get installed on real phones.
 */
object Redact {

    private val EXT_KEY = Regex("\\b[xt](?:prv|pub)[1-9A-HJ-NP-Za-km-z]{20,}")
    private val DESCRIPTOR = Regex("(wpkh|pkh|sh|wsh|tr|combo|multi|addr|raw)\\([^)]*\\)")

    /** Safe to log. Keeps the shape of the message, loses the secrets. */
    fun text(message: String?): String {
        if (message.isNullOrEmpty()) return ""
        return message
            .replace(EXT_KEY) { "<extended key redacted>" }
            .replace(DESCRIPTOR) { m -> "${m.groupValues[1]}(<redacted>)" }
    }

    fun text(t: Throwable?): String = text(t?.message ?: t?.javaClass?.simpleName)
}
