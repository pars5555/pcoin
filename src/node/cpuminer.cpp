// Copyright (c) 2026 The PCoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.

#include <node/cpuminer.h>

#include <chain.h>
#include <consensus/merkle.h>
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

bool CpuMiner::Start(ChainstateManager& chainman, interfaces::Mining& mining,
                     const CScript& script, int threads, std::string& error)
{
    if (script.empty()) {
        error = "No payout script: a valid address is required to mine.";
        return false;
    }
    const int max_threads{std::max(1, static_cast<int>(std::thread::hardware_concurrency()))};
    if (threads <= 0) threads = max_threads;
    if (threads > max_threads) {
        // Not an error: capping is friendlier than refusing, and the caller
        // sees the real value through GetThreads().
        threads = max_threads;
    }

    Stop(); // idempotent restart

    {
        std::lock_guard<std::mutex> lock(m_mutex);
        m_script = script;
        m_template.reset();
    }
    m_hashes = 0;
    m_hashrate = 0.0;
    m_generation = 0;
    m_next_nonce = 0;
    m_threads = threads;
    m_stop = false;
    m_running = true;

    m_supervisor = std::thread(&util::TraceThread, "pcminer-sup", [this, &chainman, &mining] {
        this->Supervisor(&chainman, &mining);
    });
    for (int i = 0; i < threads; ++i) {
        m_workers.emplace_back(&util::TraceThread, "pcminer", [this, &chainman] {
            this->Worker(&chainman);
        });
    }

    LogPrintf("PCoin CPU miner started with %d thread(s)\n", threads);
    return true;
}

void CpuMiner::Stop()
{
    if (m_stop.exchange(true) && !m_running) return;
    m_running = false;

    if (m_supervisor.joinable()) m_supervisor.join();
    for (auto& t : m_workers) {
        if (t.joinable()) t.join();
    }
    m_workers.clear();
    m_threads = 0;
    m_hashrate = 0.0;
    LogPrintf("PCoin CPU miner stopped\n");
}

void CpuMiner::Supervisor(ChainstateManager* chainman, interfaces::Mining* mining)
{
    const CBlockIndex* last_tip{nullptr};
    auto last_build{std::chrono::steady_clock::time_point::min()};
    auto last_sample{std::chrono::steady_clock::now()};
    uint64_t last_hashes{0};

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

        std::this_thread::sleep_for(std::chrono::milliseconds{250});
    }
}

void CpuMiner::Worker(ChainstateManager* chainman)
{
    const Consensus::Params& consensus{chainman->GetConsensus()};
    uint64_t local_gen{0};
    CBlock block;

    while (!m_stop && !chainman->m_interrupt) {
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

            if (!CheckProofOfWorkRandomX(block, block.nBits, consensus)) continue;

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
