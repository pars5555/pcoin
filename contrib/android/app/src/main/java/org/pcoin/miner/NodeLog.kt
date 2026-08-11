package org.pcoin.miner

/**
 * Reading meaning out of bitcoind's own output.
 *
 * PURE. No Android imports, so the patterns below can be tested on a plain JVM
 * against the real strings Core prints. That matters more than it looks: this
 * decides whether the app rebuilds a datadir on the phone holding the treasury,
 * and the input is text from another program that this code does not control.
 */
object NodeLog {

    /**
     * Did the node ask to be restarted with -reindex?
     *
     * Core says one of:
     *   "Error: Please restart with -reindex or -reindex-chainstate to recover."
     *   "Error opening block database. ... You need to rebuild the database
     *    using -reindex to change -txindex."
     *
     * Matched on the FLAG PLUS an instruction word rather than on the flag
     * alone, and that is the whole point of the function. The app prints its own
     * command line when it spawns the node ("spawning: ... -reindex"), so a bare
     * `contains("-reindex")` would read the app's own rebuild as the node
     * demanding another one -- the single input that could turn a one-shot
     * repair into a phone that rebuilds its chain forever. The latch in
     * [Prefs.nodeReindexPending] is the second guard on that, and neither is
     * meant to be the only one.
     */
    fun demandsReindex(lines: List<String>): Boolean = lines.any { line ->
        line.contains("-reindex", ignoreCase = true) &&
            (line.contains("restart", ignoreCase = true) ||
                line.contains("rebuild", ignoreCase = true))
    }
}
