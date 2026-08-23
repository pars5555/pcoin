// Copyright (c) 2026 The PCoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.

#ifndef BITCOIN_NODE_CPUMINER_H
#define BITCOIN_NODE_CPUMINER_H

#include <node/poolclient.h>
#include <script/script.h>

#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

class CBlock;
class ChainstateManager;

namespace interfaces {
class Mining;
} // namespace interfaces

namespace node {

/**
 * PCoin's built-in multi-threaded CPU miner.
 *
 * Bitcoin Core removed internal mining long ago because CPU mining became
 * pointless under SHA-256d. PCoin uses RandomX, where an ordinary CPU is the
 * intended miner, so the node ships a real miner again.
 *
 * A supervisor thread keeps a fresh block template (rebuilt when the tip moves
 * or the template goes stale) and N worker threads grind disjoint nonce batches
 * against it.
 *
 * Memory, both modes:
 *  - Light mode (the default, and always what block VERIFICATION uses): workers
 *    share one RandomX cache (256 MiB) and hold a VM each (2 MiB), so memory is
 *    essentially flat in the thread count.
 *  - Fast mode (opt-in, -randomxfastmode): additionally a 2080 MiB dataset,
 *    shared by all workers and never released for the life of the process. The
 *    cache stays too -- verification needs it -- so the RandomX footprint is
 *    roughly 2.3 GiB plus 2 MiB per worker. Still flat in the thread count,
 *    just a much larger constant.
 *
 * Both modes produce identical hashes; fast mode is a memory-for-speed trade
 * with no consensus content. Workers may run in different modes side by side.
 *
 * Thread-safe. Start()/Stop() are idempotent and may be called from RPC.
 */
class CpuMiner
{
public:
    ~CpuMiner();

    //! Begin mining to `script` with `threads` workers. Restarts cleanly if
    //! already running. Returns false and sets `error` on bad input.
    //!
    //! `ttl_seconds` is a dead-man's switch: if greater than zero, mining stops
    //! automatically unless KeepAlive() is called at least that often. It
    //! exists because a supervising process can die -- a phone app killed by
    //! the OS, a crashed script -- leaving the node hashing forever with
    //! nothing left to apply battery or thermal limits. A device that overheats
    //! because its minder vanished is exactly the failure this prevents.
    bool Start(ChainstateManager& chainman, interfaces::Mining& mining,
               const CScript& script, int threads, std::string& error,
               int64_t ttl_seconds = 0);

    //! Begin POOL mining: take work from `host`:`port` instead of building it,
    //! and send solved nonces back there instead of to ProcessNewBlock.
    //!
    //! Everything else is deliberately identical to Start() -- same worker
    //! pool, same 64-nonce batching, same RandomX VMs, same dead-man's switch,
    //! same lifecycle mutex. The only differences are where a template comes
    //! from and where a solution goes, which is exactly why this is a change to
    //! one function rather than a new miner.
    //!
    //! `user` is the miner's payout address at the pool: it is how the pool
    //! knows whom to credit, and it has nothing to do with this node's wallet.
    //! No key is involved and no wallet is required.
    //!
    //! Unlike solo mining, this does NOT require a synced node. The pool
    //! supplies the block being worked on, so a node that is still in initial
    //! block download cannot build a competing fork by pool mining.
    bool StartPool(ChainstateManager& chainman, const std::string& host, uint16_t port,
                   const std::string& user, int threads, std::string& error,
                   int64_t ttl_seconds = 0);

    //! Refresh the dead-man's switch. Harmless when no TTL is set.
    void KeepAlive();

    //! Record the operator's -randomxfastmode intent. Called once from init.cpp.
    //!
    //! Recording it is ALL init does. The 2080 MiB dataset is not allocated
    //! until this miner actually starts, and it is kicked off from the
    //! supervisor thread, which does not hold m_lifecycle_mutex. Two things
    //! follow, and both are the point:
    //!
    //!  - A node that never mines never allocates it, whatever its config file
    //!    says. The seed nodes are shared production boxes and the network's
    //!    only bootstrap points; protecting them must not depend on a memory
    //!    heuristic guessing right on a machine whose free memory moves.
    //!  - Eligibility is measured after the node has taken its own dbcache,
    //!    coins cache and mempool, instead of at the one moment in the
    //!    process's life when it holds none of them.
    void SetFastModeIntent(bool enabled, int build_threads);

    //! Stop all workers and join them. Safe to call when not running, and safe
    //! to call concurrently with Start() from another thread.
    //!
    //! Must never be called from the supervisor thread itself: it joins that
    //! thread.
    void Stop();

    bool IsRunning() const { return m_running; }
    int GetThreads() const { return m_threads; }
    uint64_t GetBlocksFound() const { return m_blocks_found; }

    //! True while mining for a pool rather than solo.
    bool IsPoolMining() const { return m_pool_mode; }

    //! The pool client, or nullptr when solo. Its accessors are thread-safe;
    //! the pointer itself only changes under m_lifecycle_mutex.
    //!
    //! Callers must not hold this across a Stop(): copy what they need.
    std::shared_ptr<PoolClient> GetPoolClient() const;

    //! How many workers are currently hashing from the fast-mode dataset.
    //!
    //! This is an OBSERVATION of what the workers actually hold, not a record
    //! of what anyone asked for. A UI must render the mode from this, never
    //! from its own saved intent: a node that refused fast mode would
    //! otherwise be displayed as running it.
    int GetFastThreads() const { return m_fast_threads; }

    //! How many workers currently hold a LARGE-PAGE fast VM (a subset of
    //! GetFastThreads()). Observed, like the fast count; a large-page and a
    //! normal-page fast VM compute the identical hash -- this is a performance
    //! readout, not a mode.
    int GetLargePageThreads() const { return m_lp_threads; }

    //! Rolling average hashes per second across all workers.
    double GetHashesPerSecond() const;

    //! Address/script currently being mined to, for status display.
    CScript GetScript() const;

private:
    void Supervisor(ChainstateManager* chainman, interfaces::Mining* mining);
    void PoolSupervisor(ChainstateManager* chainman);
    void Worker(ChainstateManager* chainman);
    void PoolWorker(ChainstateManager* chainman);

    //! Resolve a requested worker count into the number to actually start.
    //!
    //! A positive request is honoured (capped to the logical core count): the
    //! operator asked for it, exactly as the tray slider is never overridden.
    //! A request of <= 0 means "all cores" -- which is the WRONG default in
    //! fast mode, where extra workers past the L3/hyperthread limit make the
    //! machine mine LESS. So <= 0 resolves to the topology-derived fast-mode
    //! peak when fast mode is both requested and available on this machine, and
    //! to every logical core otherwise (light mode scales with hyperthreads).
    int ResolveThreadCount(int requested) const;

    //! Shared prologue of Start()/StartPool(). Requires m_lifecycle_mutex.
    //! Resets counters, stops anything running, and validates the thread count.
    int PrepareLocked(int threads, int64_t ttl_seconds);

    //! Body of Stop(); requires m_lifecycle_mutex to be held by the caller.
    void StopLocked();

    /**
     * Serialises Start() and Stop() against each other.
     *
     * Deliberately separate from m_mutex, which workers take while the miner is
     * running: StopLocked() joins those workers, so holding the same lock they
     * need would deadlock. This one is only ever held by a thread that is
     * starting or stopping the miner, never by a worker.
     */
    std::mutex m_lifecycle_mutex;

    mutable std::mutex m_mutex;               //!< guards m_template and m_script
    std::shared_ptr<const CBlock> m_template; //!< current template, nonce unset
    CScript m_script;

    //! Pool mode. m_pool_mode is read by workers on every batch; the client
    //! pointer is only reassigned under m_lifecycle_mutex, with every worker
    //! joined, so a worker can never observe it changing underneath itself.
    std::atomic<bool> m_pool_mode{false};
    std::shared_ptr<PoolClient> m_pool;
    //! The pool job the workers are grinding, republished on every new job.
    PoolJob m_pool_job;                       //!< guarded by m_mutex

    std::vector<std::thread> m_workers;
    std::thread m_supervisor;

    std::atomic<bool> m_running{false};
    std::atomic<bool> m_stop{true};
    std::atomic<int> m_threads{0};
    //! Workers currently holding a fast-mode VM. Incremented by a worker when
    //! it acquires one and decremented when it returns; never inferred.
    std::atomic<int> m_fast_threads{0};
    //! Workers currently holding a LARGE-PAGE fast VM; a subset of
    //! m_fast_threads. Maintained by the same worker latches, and zeroed in the
    //! same four places (PrepareLocked, StopLocked, both dead-man's-switch break
    //! paths) so it can never report a stale or negative value after a stop.
    std::atomic<int> m_lp_threads{0};

    //! Operator intent from -randomxfastmode, not an observation of anything.
    //! Never render a UI from these; render from GetFastThreads().
    std::atomic<bool> m_fast_mode_requested{false};
    std::atomic<int> m_fast_build_threads{0};

    //! Bumped whenever a new template is published; workers restart on change.
    std::atomic<uint64_t> m_generation{0};
    //! Next nonce batch to hand out for the current generation.
    std::atomic<uint32_t> m_next_nonce{0};

    std::atomic<uint64_t> m_hashes{0};
    std::atomic<uint64_t> m_blocks_found{0};

    //! Dead-man's switch. 0 disables it.
    std::atomic<int64_t> m_ttl_seconds{0};
    //! steady_clock time of the last KeepAlive(), in milliseconds.
    std::atomic<int64_t> m_last_keepalive_ms{0};
    std::atomic<double> m_hashrate{0.0}; //!< sampled by the supervisor
};

//! Process-wide miner instance. Lives for the life of the process; Stop() is
//! called during shutdown before the chainstate goes away.
CpuMiner& GetCpuMiner();

} // namespace node

#endif // BITCOIN_NODE_CPUMINER_H
