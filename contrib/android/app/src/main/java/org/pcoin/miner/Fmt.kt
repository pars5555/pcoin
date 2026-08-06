package org.pcoin.miner

import java.util.Locale

/**
 * Display formatting.
 *
 * Deliberately dumb: it prints what the node reported and nothing else. There
 * are no earnings projections, no fiat conversions and no extrapolated "coins
 * per day" anywhere in this app, because none of those numbers would be real.
 */
object Fmt {

    /** Hash rate. RandomX on a phone lands in the tens-to-hundreds of H/s. */
    fun hashrate(hs: Double): String = when {
        hs.isNaN() || hs < 0 -> "--"
        hs < 1_000 -> String.format(Locale.US, "%.1f H/s", hs)
        hs < 1_000_000 -> String.format(Locale.US, "%.2f kH/s", hs / 1_000.0)
        else -> String.format(Locale.US, "%.2f MH/s", hs / 1_000_000.0)
    }

    /** Coin amounts, as reported by the wallet. -1 means "not known yet". */
    fun coins(v: Double): String =
        if (v.isNaN() || v < 0) "--" else String.format(Locale.US, "%.8f PCN", v)

    /**
     * Coin amounts held in satoshi. Everything on the forwarding path works in
     * integers -- a transaction is built, verified and recorded in satoshi, and
     * only the display converts -- because a fee assertion done in floating
     * point is an assertion that can be off by a rounding error.
     */
    fun coinsSat(sat: Long): String =
        if (sat < 0) "--" else String.format(Locale.US, "%d.%08d PCN", sat / 100_000_000L, sat % 100_000_000L)

    /**
     * A rough wall-clock duration, for "about 10 h from now" style estimates.
     * Deliberately coarse: the underlying number comes from observed block
     * spacing on a chain whose difficulty is currently pinned, so minutes of
     * precision would be false confidence.
     */
    fun roughDuration(ms: Long): String = when {
        ms < 0 -> "--"
        ms < 90 * 60_000L -> "${maxOf(1L, ms / 60_000L)} min"
        ms < 48 * 3_600_000L -> "${Math.round(ms / 3_600_000.0)} h"
        else -> "${Math.round(ms / 86_400_000.0)} days"
    }

    fun temp(c: Float): String =
        if (c.isNaN()) "--" else String.format(Locale.US, "%.1f°C", c)

    fun count(v: Long): String = if (v < 0) "--" else v.toString()

    fun count(v: Int): String = if (v < 0) "--" else v.toString()

    /** Chain height, with sync progress when the node is still catching up. */
    fun height(height: Long, headers: Long, progress: Double): String {
        if (height < 0) return "--"
        val base = height.toString()
        val syncing = headers > height || (progress in 0.0..0.9999)
        if (!syncing) return base
        val pct = if (progress in 0.0..1.0) {
            String.format(Locale.US, " (syncing %.1f%%)", progress * 100.0)
        } else if (headers > height) {
            " (syncing, $headers headers)"
        } else {
            " (syncing)"
        }
        return base + pct
    }

    /**
     * "50%  (4 of 8 cores)" -- deliberately the same wording the Windows tray
     * app uses (contrib/windows-tray/PCoinTray.cs), so the two clients describe
     * the same setting the same way.
     */
    fun performance(percent: Int, threads: Int, cores: Int): String =
        String.format(Locale.US, "%d%%  (%d of %d cores)", percent, threads, cores)
}
