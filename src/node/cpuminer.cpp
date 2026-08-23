// Copyright (c) 2026 The PCoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.

#include <node/cpuminer.h>

#include <chain.h>
#include <consensus/merkle.h>
#include <crypto/pow_randomx.h>
#include <node/cpu_topology.h>
#include <interfaces/mining.h>
#include <logging.h>
#include <node/blockstorage.h>
#include <node/miner.h>
#include <pow.h>
#include <primitives/block.h>
#include <uint256.h>
#include <sync.h>
#include <util/signalinterrupt.h>
#include <util/thread.h>
#include <validation.h>

#include <algorithm>
#include <chrono>
#include <limits>

namespace node {

//! Nonces handed to a worker per atomic hand-out. Large enough that the atomic
//! is not a bottleneck, small enough that workers notice a new template fast
//! (a RandomX light-mode hash is ~1-20 ms, so 64 hashes is well under a second
//! on anything we care about).
static constexpr uint32_t NONCE_BATCH = 64;

//! How often the supervisor rebuilds the template even if the tip has not
//! moved, so newly arrived fee-paying transactions get included.
static constexpr auto TEMPLATE_REFRESH{std::chrono::seconds{20}};

CpuMiner::~CpuMiner()
{
    Stop();
}

CpuMiner& GetCpuMiner()
{
    static CpuMiner miner;
    return miner;
}

double CpuMiner::GetHashesPerSecond() const
{
    return m_hashrate.load(std::memory_order_relaxed);
}

CScript CpuMiner::GetScript() const
{
    std::lock_guard<std::mutex> lock(m_mutex);
    return m_script;
}

static int64_t SteadyNowMs()
{
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::steady_clock::now().time_since_epoch())
        .count();
}

void CpuMiner::KeepAlive()
{
    m_last_keepalive_ms = SteadyNowMs();
}

void CpuMiner::SetFastModeIntent(bool enabled, int build_threads)
{
    m_fast_build_threads = build_threads;
    m_fast_mode_requested = enabled;
}

bool CpuMiner::Start(ChainstateManager& chainman, interfaces::Mining& mining,
                     const CScript& script, int threads, std::string& error,
                     int64_t ttl_seconds)
{
    // Serialise the whole of Start() against Stop() and against another
    // Start().
    //
    // m_supervisor and m_workers are a std::thread and a vector of them. They
    // are not atomic and were previously touched with no lock at all, so two
    // startmining calls arriving together would have one thread assigning over
    // a std::thread while the other joined it. Assigning to a joinable thread
    // calls std::terminate, and that is precisely how a node died in the field:
    // exception 0x40000015 (STATUS_FATAL_APP_EXIT) with two "pcminer-sup thread
    // start" lines in the log, seconds after two tray apps on the same PC both
    // asked to mine.
    //
    // The node must survive whatever its callers do, however careless: this RPC
    // is reachable by anyone who can reach the RPC port.
    std::lock_guard<std::mutex> lifecycle(m_lifecycle_mutex);

    if (script.empty()) {
        error = "No payout script: a valid address is required to mine.";
        return false;
    }
    // Capping above the core count is friendlier than refusing, and a <= 0
    // request becomes the fast-mode-aware default; the caller sees the real
    // value through GetThreads().
    threads = ResolveThreadCount(threads);

    threads = PrepareLocked(threads, ttl_seconds);

    {
        std::lock_guard<std::mutex> lock(m_mutex);
        m_script = script;
    }

    m_supervisor = std::thread(&util::TraceThread, "pcminer-sup", [this, &chainman, &mining] {
        this->Supervisor(&chainman, &mining);
    });
    for (int i = 0; i < threads; ++i) {
        m_workers.emplace_back(&util::TraceThread, "pcminer", [this, &chainman] {
            this->Worker(&chainman);
        });
    }

    // Note what is deliberately NOT done here: the RandomX fast-mode dataset is
    // neither allocated nor built. That work takes tens of seconds to minutes
    // and this function holds m_lifecycle_mutex, which Stop() also takes and
    // which Interrupt() takes during shutdown -- so building it here would hang
    // stopmining and hang node shutdown for the duration, on an RPC-reachable
    // path, with no cancellation point inside randomx_init_dataset().
    //
    // It is kicked off from the SUPERVISOR thread instead (see Supervisor()),
    // which holds no lock and returns immediately: mining is the only consumer,
    // so a node that never mines must never pay 2080 MiB for it. Re-issuing
    // startmining does not re-pay anything -- RandomXFastModeStart() is
    // idempotent. Workers pick the dataset up when it is ready.
    const RandomXFastModeStatus rx{RandomXFastModeGetStatus()};
    if (rx.state == RandomXFastModeState::BUILDING) {
        LogPrintf("PCoin CPU miner started with %d thread(s); RandomX %s, mining in light mode until it finishes\n",
                  threads, rx.reason);
    } else {
        LogPrintf("PCoin CPU miner started with %d thread(s)\n", threads);
    }
    return true;
}

int CpuMiner::ResolveThreadCount(int requested) const
{
    const int max_threads{std::max(1, static_cast<int>(std::thread::hardware_concurrency()))};
    if (requested > 0) return std::min(requested, max_threads);

    // requested <= 0: "every core". In LIGHT mode that is correct -- it is
    // ALU-bound and keeps scaling with hyperthreads. In FAST mode it is the
    // documented cliff: the per-worker 2 MiB scratchpads stop fitting in L3 and
    // hyperthread siblings start fighting over one core's L1/L2/TLB, so the
    // TOTAL rate falls (all 24 threads on the dev i9 measured ~half of 9). So
    // default to the topology-derived peak, but ONLY when fast mode is both
    // asked for AND actually available here -- otherwise a machine that will
    // fall back to light mode (too little RAM for the dataset) would be capped
    // for no reason. Eligibility is a few small /proc reads or one
    // GlobalMemoryStatusEx; the cache it may initialise is already up from node
    // startup. An explicit count never reaches this branch.
    std::string ignored;
    if (m_fast_mode_requested.load() && RandomXFastModeEligible(ignored)) {
        return std::min(FastModeThreadTarget(GetCpuTopology()), max_threads);
    }
    return max_threads;
}

int CpuMiner::PrepareLocked(int threads, int64_t ttl_seconds)
{
    StopLocked(); // idempotent restart; the lifecycle lock is already held

    {
        std::lock_guard<std::mutex> lock(m_mutex);
        m_template.reset();
        m_pool_job = PoolJob{};
    }
    m_hashes = 0;
    m_hashrate = 0.0;
    m_generation = 0;
    m_next_nonce = 0;
    m_threads = threads;
    m_fast_threads = 0;
    m_ttl_seconds = std::max<int64_t>(0, ttl_seconds);
    m_last_keepalive_ms = SteadyNowMs();
    m_stop = false;
    m_running = true;
    return threads;
}

std::shared_ptr<PoolClient> CpuMiner::GetPoolClient() const
{
    std::lock_guard<std::mutex> lock(m_mutex);
    return m_pool;
}

bool CpuMiner::StartPool(ChainstateManager& chainman, const std::string& host, uint16_t port,
                         const std::string& user, int threads, std::string& error,
                         int64_t ttl_seconds)
{
    // Exactly the same serialisation as Start(), for exactly the same reason:
    // two callers arriving together must not assign over a joinable thread.
    // See the incident recorded in Start().
    std::lock_guard<std::mutex> lifecycle(m_lifecycle_mutex);

    if (host.empty()) { error = "No pool host given."; return false; }
    if (port == 0) { error = "No pool port given."; return false; }
    if (user.empty()) {
        error = "No pool user: the payout address you want the pool to credit is required.";
        return false;
    }
    threads = ResolveThreadCount(threads); // capped, not refused; fast-mode-aware default

    threads = PrepareLocked(threads, ttl_seconds);

    {
        std::lock_guard<std::mutex> lock(m_mutex);
        // A fresh client per start. The old one is destroyed here, after
        // StopLocked() joined every thread that could have been touching it.
        m_pool = std::make_shared<PoolClient>(host, port, user);
        m_script.clear();  // pool mining pays no local script; the pool credits `user`
    }
    m_pool_mode = true;

    m_supervisor = std::thread(&util::TraceThread, "pcminer-sup", [this, &chainman] {
        this->PoolSupervisor(&chainman);
    });
    for (int i = 0; i < threads; ++i) {
        m_workers.emplace_back(&util::TraceThread, "pcminer", [this, &chainman] {
            this->PoolWorker(&chainman);
        });
    }

    LogPrintf("PCoin pool miner started with %d thread(s), pool %s:%d, crediting %s\n",
              threads, host, port, user);
    return true;
}

void CpuMiner::Stop()
{
    std::lock_guard<std::mutex> lifecycle(m_lifecycle_mutex);
    StopLocked();
}

void CpuMiner::StopLocked()
{
    // Always join. The supervisor can retire itself (dead-man's switch) and
    // clear m_running on its own, so an early return keyed on m_running would
    // leave joinable threads in m_workers; the next Start() would then append
    // to a vector holding un-joined threads and std::terminate on destruction.
    // Must never be called from the supervisor thread itself.
    const bool was_running{m_running.exchange(false)};
    m_stop = true;

    if (m_supervisor.joinable()) m_supervisor.join();
    for (auto& t : m_workers) {
        if (t.joinable()) t.join();
    }
    m_workers.clear();
    m_threads = 0;
    m_fast_threads = 0;
    m_hashrate = 0.0;
    m_ttl_seconds = 0;

    // Only now, with every worker and the supervisor joined, is it safe to let
    // the pool client go: they are the threads that used it. Workers hold their
    // own shared_ptr for the duration of the call anyway, so this is belt and
    // braces rather than the thing keeping it alive.
    const bool was_pool{m_pool_mode.exchange(false)};
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        if (m_pool) m_pool->Close();
        m_pool.reset();
        m_pool_job = PoolJob{};
    }
    if (was_running) LogPrintf("PCoin %s miner stopped\n", was_pool ? "pool" : "CPU");
}

void CpuMiner::Supervisor(ChainstateManager* chainman, interfaces::Mining* mining)
{
    const CBlockIndex* last_tip{nullptr};
    auto last_build{std::chrono::steady_clock::time_point::min()};
    auto last_sample{std::chrono::steady_clock::now()};
    uint64_t last_hashes{0};

    // RandomX fast-mode dataset progress reporting. The build is minutes of
    // silence on a slow machine, and silence reads as a hang -- so say
    // something every few seconds and once more when it settles.
    auto last_rx_log{std::chrono::steady_clock::time_point::min()};
    constexpr auto RX_LOG_INTERVAL{std::chrono::seconds{5}};
    bool rx_settled_logged{false};
    RandomXFastModeState rx_last_logged{RandomXFastModeState::DISABLED};

    // This is where the opt-in fast-mode dataset is requested: on a thread that
    // holds no lock, only once this node is genuinely mining, and only after
    // the node has already allocated its own caches so the memory gate is
    // measuring a real steady state. RandomXFastModeStart() returns
    // immediately; the build runs on its own threads and is joined by
    // RandomXFastModeShutdown() at Interrupt(). Idempotent, so the field
    // supervisors that re-issue startmining every few minutes cost nothing.
    if (m_fast_mode_requested.load()) {
        std::string reason;
        if (RandomXFastModeStart(m_fast_build_threads.load(), reason)) {
            LogPrintf("PCoin CPU miner: RandomX fast mode requested (%s)\n", reason);
        } else {
            LogPrintf("PCoin CPU miner: RandomX fast mode unavailable (%s); mining in light mode\n", reason);
            rx_settled_logged = true; // already said it; do not repeat below
            rx_last_logged = RandomXFastModeState::UNAVAILABLE;
        }
    }

    while (!m_stop && !chainman->m_interrupt) {
        const CBlockIndex* tip{WITH_LOCK(::cs_main, return chainman->ActiveChain().Tip())};
        const auto now{std::chrono::steady_clock::now()};
        const bool stale{now - last_build >= TEMPLATE_REFRESH};

        if (tip != last_tip || stale || !m_generation) {
            CScript script{GetScript()};
            std::unique_ptr<interfaces::BlockTemplate> tmpl;
            try {
                tmpl = mining->createNewBlock({.coinbase_output_script = script});
            } catch (const std::exception& e) {
                LogPrintf("PCoin CPU miner: template creation failed: %s\n", e.what());
            }
            if (tmpl) {
                auto block{std::make_shared<CBlock>(tmpl->getBlock())};
                block->hashMerkleRoot = BlockMerkleRoot(*block);
                block->nNonce = 0;
                {
                    std::lock_guard<std::mutex> lock(m_mutex);
                    m_template = block;
                }
                m_next_nonce = 0;
                ++m_generation; // publish: workers pick this up
                last_tip = tip;
                last_build = now;
            }
        }

        // Refresh the hashrate estimate roughly once a second.
        const auto sample_now{std::chrono::steady_clock::now()};
        const auto dt{std::chrono::duration_cast<std::chrono::milliseconds>(sample_now - last_sample).count()};
        if (dt >= 1000) {
            const uint64_t h{m_hashes.load()};
            m_hashrate = static_cast<double>(h - last_hashes) * 1000.0 / static_cast<double>(dt);
            last_hashes = h;
            last_sample = sample_now;
        }

        {
            const RandomXFastModeStatus rx{RandomXFastModeGetStatus()};
            // Settled-once is keyed on the STATE, not on a one-way flag: fast
            // mode can be taken out of service after it was READY (a worker
            // catching a fast/light disagreement does exactly that), and that
            // transition is the single most important line this node will ever
            // print. A one-way flag would swallow it.
            if (rx.state != rx_last_logged) rx_settled_logged = false;
            if (!rx_settled_logged) {
                if (rx.state == RandomXFastModeState::BUILDING) {
                    if (sample_now - last_rx_log >= RX_LOG_INTERVAL) {
                        LogPrintf("PCoin CPU miner: RandomX %s\n", rx.reason);
                        last_rx_log = sample_now;
                    }
                } else if (rx.state == RandomXFastModeState::READY) {
                    LogPrintf("PCoin CPU miner: RandomX fast-mode dataset ready; workers switch over as they finish their current nonce batch\n");
                    rx_settled_logged = true;
                    rx_last_logged = rx.state;
                } else if (rx.state == RandomXFastModeState::UNAVAILABLE) {
                    // Loud, once, and specific. A silent fall back to light mode
                    // is how somebody ends up believing they are mining several
                    // times faster than they are.
                    LogPrintf("PCoin CPU miner: RandomX fast mode unavailable (%s); mining in light mode\n", rx.reason);
                    rx_settled_logged = true;
                    rx_last_logged = rx.state;
                } else {
                    rx_settled_logged = true; // DISABLED: nobody asked, nothing to say
                    rx_last_logged = rx.state;
                }
            }
        }

        // Dead-man's switch: if whoever asked for mining has stopped checking
        // in, assume it is gone and stand down. Without this an orphaned node
        // keeps hashing with nothing left to enforce battery or thermal limits.
        const int64_t ttl{m_ttl_seconds.load()};
        if (ttl > 0 && SteadyNowMs() - m_last_keepalive_ms.load() > ttl * 1000) {
            LogPrintf("PCoin CPU miner: no keepalive for %ds, stopping\n", (int)ttl);
            m_stop = true;
            m_running = false;
            // Report the truth immediately: the workers are on their way out,
            // so getcpuminerinfo must not keep advertising live threads.
            m_threads = 0;
            m_hashrate = 0.0;
            break;
        }

        std::this_thread::sleep_for(std::chrono::milliseconds{250});
    }
}

void CpuMiner::PoolSupervisor(ChainstateManager* chainman)
{
    std::shared_ptr<PoolClient> pool{GetPoolClient()};
    if (!pool) return;

    auto last_sample{std::chrono::steady_clock::now()};
    uint64_t last_hashes{0};
    uint64_t published{0};

    // Same opt-in fast-mode kickoff as solo mining, for the same reasons: on a
    // thread holding no lock, only once this node is genuinely mining.
    if (m_fast_mode_requested.load()) {
        std::string reason;
        if (RandomXFastModeStart(m_fast_build_threads.load(), reason)) {
            LogPrintf("PCoin pool miner: RandomX fast mode requested (%s)\n", reason);
        } else {
            LogPrintf("PCoin pool miner: RandomX fast mode unavailable (%s); mining in light mode\n", reason);
        }
    }

    while (!m_stop && !chainman->m_interrupt) {
        // All socket I/O happens here and nowhere else. The budget doubles as
        // this loop's sleep, so a quiet pool costs one poll per 100 ms rather
        // than a spin.
        pool->Pump(std::chrono::milliseconds{100});

        // Publish a new job to the workers when the pool sends one.
        PoolJob job;
        if (pool->GetJob(job) && job.generation != published) {
            {
                std::lock_guard<std::mutex> lock(m_mutex);
                m_pool_job = job;
            }
            m_next_nonce = 0;
            ++m_generation;   // publish: workers pick this up
            published = job.generation;
        } else if (!pool->GetJob(job) && published != 0) {
            // The connection dropped and took its job with it. STOP HASHING.
            //
            // Grinding a job from a pool we are no longer talking to produces
            // shares nobody will ever receive, while every dial the user can
            // see -- hashrate, threads, temperature -- reads exactly like
            // working. Retiring the job costs a few seconds of idle CPU and is
            // the difference between "reconnecting" and "silently mining for
            // nobody".
            {
                std::lock_guard<std::mutex> lock(m_mutex);
                m_pool_job = PoolJob{};
            }
            ++m_generation;
            published = 0;
        }

        const auto sample_now{std::chrono::steady_clock::now()};
        const auto dt{std::chrono::duration_cast<std::chrono::milliseconds>(sample_now - last_sample).count()};
        if (dt >= 1000) {
            const uint64_t h{m_hashes.load()};
            m_hashrate = static_cast<double>(h - last_hashes) * 1000.0 / static_cast<double>(dt);
            last_hashes = h;
            last_sample = sample_now;
        }

        // The dead-man's switch is identical to solo mining's, and matters just
        // as much: a pool miner whose supervising app died is still a hot CPU
        // in someone's living room.
        const int64_t ttl{m_ttl_seconds.load()};
        if (ttl > 0 && SteadyNowMs() - m_last_keepalive_ms.load() > ttl * 1000) {
            LogPrintf("PCoin pool miner: no keepalive for %ds, stopping\n", (int)ttl);
            m_stop = true;
            m_running = false;
            m_threads = 0;
            m_hashrate = 0.0;
            break;
        }
    }
    pool->Close();
}

void CpuMiner::PoolWorker(ChainstateManager* chainman)
{
    // Hold our own reference for the life of this thread, so the client cannot
    // be destroyed underneath us even if the lifecycle rules were ever changed.
    std::shared_ptr<PoolClient> pool{GetPoolClient()};
    if (!pool) return;

    uint64_t local_gen{0};
    PoolJob job;
    RandomXMiningVm rx_vm;

    struct FastThreadCount {
        std::atomic<int>& counter;
        bool counted{false};
        void Observe(bool fast)
        {
            if (fast && !counted) { counter.fetch_add(1, std::memory_order_relaxed); counted = true; }
        }
        void Drop()
        {
            if (counted) { counter.fetch_sub(1, std::memory_order_relaxed); counted = false; }
        }
        ~FastThreadCount() { Drop(); }
    } fast_count{m_fast_threads};

    while (!m_stop && !chainman->m_interrupt) {
        fast_count.Observe(rx_vm.TryAcquire());

        const uint64_t gen{m_generation.load(std::memory_order_acquire)};
        if (gen == 0) {
            std::this_thread::sleep_for(std::chrono::milliseconds{100});
            continue;
        }
        if (gen != local_gen) {
            {
                std::lock_guard<std::mutex> lock(m_mutex);
                job = m_pool_job;
            }
            local_gen = gen;
        }
        if (job.id.empty()) {
            // No job: disconnected, or the pool has not sent one yet. Idle
            // rather than grind something stale.
            std::this_thread::sleep_for(std::chrono::milliseconds{100});
            continue;
        }

        const uint32_t start{m_next_nonce.fetch_add(NONCE_BATCH, std::memory_order_relaxed)};
        if (start > std::numeric_limits<uint32_t>::max() - NONCE_BATCH) {
            // Nonce space exhausted for this job. Unlike solo mining nothing
            // here can refresh it locally -- the pool owns the template -- so
            // wait for the pool's next job.
            std::this_thread::sleep_for(std::chrono::milliseconds{100});
            continue;
        }

        CBlockHeader header{job.header};
        for (uint32_t n = start; n < start + NONCE_BATCH; ++n) {
            if (m_stop || static_cast<bool>(chainman->m_interrupt)) return;
            if (m_generation.load(std::memory_order_acquire) != local_gen) break;

            header.nNonce = n;
            m_hashes.fetch_add(1, std::memory_order_relaxed);

            // The identical RandomX hash solo mining computes -- same function,
            // same VM, same bytes. Only the comparison differs: against the
            // POOL's easier target instead of the network's, which is the whole
            // of what makes this a share rather than a block.
            if (UintToArith256(rx_vm.Hash(header)) > job.target) continue;

            // A share does NOT retire the job. This is the one place pool
            // mining genuinely differs from solo mining: solo finds at most one
            // solution per template and must stop the other workers, whereas
            // shares are the normal product and the job stays live until the
            // pool replaces it. Bumping the generation here would throw away
            // the rest of the round's work every few seconds.
            pool->QueueSubmit(job.id, n);
        }
    }
}

void CpuMiner::Worker(ChainstateManager* chainman)
{
    const Consensus::Params& consensus{chainman->GetConsensus()};
    uint64_t local_gen{0};
    CBlock block;

    // This worker's RandomX VM, owned by this stack frame -- deliberately not
    // thread_local and not a process-wide pool. What keeps it safe is NOT the
    // join in StopLocked() (different lock, different lifetime): it is that the
    // dataset is published by a monotone false->true latch and a READY dataset
    // is never freed, so no VM can ever point into released memory. Do not add
    // a free-on-stopmining "optimisation" on the strength of the join.
    // Default-constructed this handle is exactly the
    // ordinary light path; TryAcquire() upgrades it to a fast-mode VM if and
    // only if the opt-in dataset is built and has been cross-checked against
    // light mode. A worker that never acquires one simply mines in light
    // mode, which is correct, just slower.
    RandomXMiningVm rx_vm;

    // Report what this worker actually holds, and unreport it on every exit
    // path (the inner loop returns).
    struct FastThreadCount {
        std::atomic<int>& counter;
        bool counted{false};
        void Observe(bool fast)
        {
            if (fast && !counted) {
                counter.fetch_add(1, std::memory_order_relaxed);
                counted = true;
            }
        }
        //! This worker is no longer in fast mode. Idempotent.
        void Drop()
        {
            if (counted) {
                counter.fetch_sub(1, std::memory_order_relaxed);
                counted = false;
            }
        }
        ~FastThreadCount() { Drop(); }
    } fast_count{m_fast_threads};

    bool rx_acquire_failed{false};

    while (!m_stop && !chainman->m_interrupt) {
        // Once per nonce batch, not per hash: a single relaxed atomic load
        // once the VM is held, and one acquire load before that. Checking
        // here rather than once at thread start is what lets a worker that
        // began before the dataset was ready pick it up when it lands.
        bool failed{false};
        fast_count.Observe(rx_vm.TryAcquire(&failed));
        if (failed && !rx_acquire_failed) {
            // Said once, not never and not 80 times a second. Without this the
            // node holds 2080 MiB, reports a 100%-built dataset, and mines in
            // light mode with nothing anywhere explaining why.
            rx_acquire_failed = true;
            LogPrintf("PCoin CPU miner: the fast-mode dataset is ready but this thread could not create "
                      "a fast-mode VM (JIT page allocation refused?); mining in light mode\n");
        }

        const uint64_t gen{m_generation.load(std::memory_order_acquire)};
        if (gen == 0) { // no template published yet
            std::this_thread::sleep_for(std::chrono::milliseconds{100});
            continue;
        }
        if (gen != local_gen) {
            std::shared_ptr<const CBlock> tmpl;
            {
                std::lock_guard<std::mutex> lock(m_mutex);
                tmpl = m_template;
            }
            if (!tmpl) {
                std::this_thread::sleep_for(std::chrono::milliseconds{100});
                continue;
            }
            block = *tmpl;
            local_gen = gen;
        }

        const uint32_t start{m_next_nonce.fetch_add(NONCE_BATCH, std::memory_order_relaxed)};
        if (start > std::numeric_limits<uint32_t>::max() - NONCE_BATCH) {
            // Nonce space exhausted for this template; wait for the supervisor
            // to publish a fresh one (its timestamp/mempool will differ).
            std::this_thread::sleep_for(std::chrono::milliseconds{100});
            continue;
        }

        for (uint32_t n = start; n < start + NONCE_BATCH; ++n) {
            if (m_stop || static_cast<bool>(chainman->m_interrupt)) return;
            if (m_generation.load(std::memory_order_acquire) != local_gen) break;

            block.nNonce = n;
            m_hashes.fetch_add(1, std::memory_order_relaxed);

            // Same consensus function, and therefore the same proof-of-work
            // statement, that validation.cpp uses. The extra argument is an
            // accelerator, not a rule: it only changes which VM computes the
            // hash, and both VMs compute the same hash.
            if (!CheckProofOfWorkRandomX(block, block.nBits, consensus, &rx_vm)) continue;

            // Found one. Retire this template before submitting: bump the
            // generation so the other workers stop, and drop the template so
            // they wait for a fresh one instead of grinding a height that is
            // already solved. Without this they keep producing valid-but-
            // duplicate solutions for the same height until the supervisor
            // notices the tip moved.
            auto solved{std::make_shared<const CBlock>(block)};
            {
                std::lock_guard<std::mutex> lock(m_mutex);
                m_template.reset();
            }
            ++m_generation;

            LogPrintf("PCoin CPU miner found block %s (nonce %u)\n",
                      solved->GetHash().GetHex(), n);

            // Belt and braces, and cheap: once per block found, re-check the
            // solution through the ordinary light-mode verification path --
            // the exact path every other node on the network will use. If the
            // two ever disagreed, this turns a silent total loss of mining
            // into one unmissable log line. Only fast-mode workers pay for it.
            if (rx_vm.IsFast() && !CheckProofOfWorkRandomX(block, block.nBits, consensus)) {
                // TERMINAL, PROCESS-WIDE, AND ACTED ON -- not just printed.
                //
                // Logging and continuing is what the first version of this did,
                // and it is the exact mistake CLAUDE.md 7.1/7.2 records: a
                // node-confirmed terminal outcome must advance the
                // authoritative state. `break` alone only leaves the nonce
                // loop; the same broken VM would grind the next template at
                // full speed and throw away every block it found, forever,
                // while getcpuminerinfo went on reporting a healthy "fast"
                // miner. The fleet supervisors read that RPC and never read
                // logs, so nobody would ever find out.
                //
                // So: close the gate for the whole process (the dataset is NOT
                // freed -- other workers still hold VMs into it), then drop
                // this handle. Every other worker converges on light mode at
                // its next TryAcquire(), the supervisor prints the reason, and
                // getcpuminerinfo starts reporting mode "light" with it.
                const std::string reason{
                    "fast mode disagreed with light mode on block " + solved->GetHash().GetHex() +
                    " -- fast mode is disabled for the life of this process; restart without "
                    "-randomxfastmode and report this"};
                LogPrintf("PCoin CPU miner: FAST MODE DISAGREES WITH LIGHT MODE on block %s -- "
                          "disabling fast mode process-wide and continuing in light mode; "
                          "this is a bug, please report it\n",
                          solved->GetHash().GetHex());
                RandomXFastModeDisable(reason);
                rx_vm.Release();
                fast_count.Drop();
                // The block itself is fine or it is not; the light path just
                // said it is not, so it is not submitted. The template was
                // already retired above, so this worker simply picks up the
                // next one -- in light mode.
                break;
            }

            if (!chainman->ProcessNewBlock(solved, /*force_processing=*/true,
                                           /*min_pow_checked=*/true, nullptr)) {
                LogPrintf("PCoin CPU miner: block was NOT accepted\n");
                break;
            }

            // ProcessNewBlock also returns true for a perfectly valid block
            // that lost the race and ended up on a side branch. Such a block
            // pays nothing, so only count it once it is actually part of the
            // active chain — otherwise the figure shown to the user overstates
            // what they earned.
            const uint256 solved_hash{solved->GetHash()};
            const bool in_active_chain{WITH_LOCK(::cs_main,
                const CBlockIndex* pindex{chainman->m_blockman.LookupBlockIndex(solved_hash)};
                return pindex && chainman->ActiveChain().Contains(pindex))};
            if (in_active_chain) {
                ++m_blocks_found;
            } else {
                LogPrintf("PCoin CPU miner: block %s is valid but not on the active chain\n",
                          solved_hash.GetHex());
            }
            break;
        }
    }
}

} // namespace node
