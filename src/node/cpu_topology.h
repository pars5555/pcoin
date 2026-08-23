// Copyright (c) 2026 The PCoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.

#ifndef BITCOIN_NODE_CPU_TOPOLOGY_H
#define BITCOIN_NODE_CPU_TOPOLOGY_H

#include <cstdint>

namespace node {

/**
 * What the RandomX miner needs to know about this CPU, and nothing else.
 *
 * Fast mode holds one shared 2080 MiB dataset plus a PRIVATE 2 MiB scratchpad
 * per worker, and a RandomX scratchpad is designed to live in cache. Past the
 * point where the scratchpads stop fitting -- and, on a hyperthreaded machine,
 * once two workers start sharing one physical core's L1/L2/TLB -- extra workers
 * evict each other and the TOTAL hash rate FALLS. Measured on three Intel HT
 * desktops, the peak sits at min(physical cores, L3 / 2 MiB): the 10920X
 * (12P/24L, 19.25 MB L3) peaks at 9-10 and all 24 threads produce roughly HALF
 * of that; the 9900K (8P/16L, 16 MB) peaks at 8; the 8700K (6P/12L, 12 MB) at
 * 6. A non-hyperthreaded i5-9600K (6P/6L, 9 MB) shows no such cliff -- it climbs
 * to all six cores -- so the advice is given ONLY where hyperthreading makes it
 * true. Light mode is ALU-bound, has no dataset to stream and keeps scaling with
 * hyperthreads, so none of this applies to it.
 *
 * All fields are best-effort. A field this platform cannot read honestly is left
 * at 0, which every consumer must treat as "unknown" -- never as "none".
 */
struct CpuTopology {
    //! Logical processors (hyperthreads included). std::thread::hardware_concurrency().
    int logical{0};
    //! Physical cores, or 0 if the topology could not be read.
    int physical{0};
    //! Total last-level (L3) cache in bytes, summed over distinct cache
    //! domains (so a chiplet part is counted whole, not multiplied), or 0 if
    //! unreadable.
    uint64_t l3_bytes{0};
};

//! Read this machine's topology. Cached after the first call: it never changes
//! for the life of the process, and the OS query is not free.
CpuTopology GetCpuTopology();

/**
 * Worker count to actually START in fast mode when the caller asked for "all
 * cores" (threads <= 0). This is the DEFAULT, not a cap: an explicit thread
 * count is always honoured, exactly as the tray slider is. Mirrors the tray's
 * advice so a node and its UI never disagree.
 *
 *  - hyperthreaded, topology known: min(physical, L3 / 2 MiB), at least 1.
 *  - not hyperthreaded (physical >= logical): all logical cores; there is no
 *    cliff to avoid and light-mode fallback wants them all.
 *  - topology unknown: half the logical processors -- right on every HT machine
 *    and merely conservative on the rest. Guessing "all of them" is the one
 *    answer measured to be harmful in fast mode.
 *
 * Always returns at least 1 and never more than `logical`.
 */
int FastModeThreadTarget(const CpuTopology& topo);

/**
 * The same number, but as ADVICE for a UI or an operator: the fast-mode peak
 * when there is a useful one to name, or 0 when there is nothing to advise --
 * no hyperthreading (no cliff), topology unreadable, or the peak is simply all
 * the cores. 0 means "say nothing", never "use zero threads".
 */
int FastModeThreadAdvice(const CpuTopology& topo);

} // namespace node

#endif // BITCOIN_NODE_CPU_TOPOLOGY_H
