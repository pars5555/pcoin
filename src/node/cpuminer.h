// Copyright (c) 2026 The PCoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.

#ifndef BITCOIN_NODE_CPUMINER_H
#define BITCOIN_NODE_CPUMINER_H

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
 * against it. Workers share one RandomX light-mode cache (~256 MiB) and hold a
 * VM each (a few MiB), so memory is essentially flat in the thread count.
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

    //! Refresh the dead-man's switch. Harmless when no TTL is set.
    void KeepAlive();

    //! Stop all workers and join them. Safe to call when not running, and safe
    //! to call concurrently with Start() from another thread.
    //!
    //! Must never be called from the supervisor thread itself: it joins that
    //! thread.
    void Stop();

    bool IsRunning() const { return m_running; }
    int GetThreads() const { return m_threads; }
    uint64_t GetBlocksFound() const { return m_blocks_found; }

    //! Rolling average hashes per second across all workers.
    double GetHashesPerSecond() const;

    //! Address/script currently being mined to, for status display.
    CScript GetScript() const;

private:
    void Supervisor(ChainstateManager* chainman, interfaces::Mining* mining);
    void Worker(ChainstateManager* chainman);

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

    std::vector<std::thread> m_workers;
    std::thread m_supervisor;

    std::atomic<bool> m_running{false};
    std::atomic<bool> m_stop{true};
    std::atomic<int> m_threads{0};

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
