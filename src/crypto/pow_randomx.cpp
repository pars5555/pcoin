// Copyright (c) 2026 The PCoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.

#include <crypto/pow_randomx.h>

#include <primitives/block.h>
#include <serialize.h>
#include <streams.h>
#include <uint256.h>

#include <randomx.h>

#include <algorithm>
#include <atomic>
#include <cassert>
#include <cstddef>
#include <cstdint>
#include <exception>
#include <fstream>
#include <mutex>
#include <stdexcept>
#include <string>
#include <system_error>
#include <thread>
#include <vector>

#ifdef WIN32
#include <windows.h>
#else
#include <unistd.h>
#endif

namespace {

//! Fixed RandomX key for PCoin PoW v1: the ASCII bytes of "PCoin/RandomX/v1"
//! (16 bytes, no NUL terminator). Identical on all networks including regtest.
//! Key rotation, if ever introduced, would be a hard fork (PoW v2).
constexpr char RANDOMX_KEY[] = "PCoin/RandomX/v1";
constexpr std::size_t RANDOMX_KEY_SIZE{sizeof(RANDOMX_KEY) - 1};
static_assert(RANDOMX_KEY_SIZE == 16);

//! Shared light-mode cache (~256 MiB), initialized exactly once on first use
//! and intentionally never released: per-thread VMs referencing it may be
//! destroyed at any point during shutdown (thread_local destructors), so
//! leaking the cache for the lifetime of the process avoids any
//! destruction-order hazard.
randomx_cache* g_cache{nullptr};
//! Flags the cache was successfully allocated with; also the first-choice
//! flags for VM creation so cache and VMs agree on JIT/HARD_AES use.
randomx_flags g_flags{RANDOMX_FLAG_DEFAULT};
std::once_flag g_cache_once;

//! Shared fallback VM (created during initialization, never released, same
//! rationale as g_cache) used, under g_fallback_mutex, by any thread that
//! cannot allocate its own VM. Guarantees RandomXPowHash() cannot fail once
//! initialization has succeeded.
randomx_vm* g_fallback_vm{nullptr};
std::mutex g_fallback_mutex;

//! Create a light-mode VM on the shared cache, degrading gracefully: the
//! detected flags first (JIT and/or hardware AES), then W^X-compliant JIT
//! (RANDOMX_FLAG_SECURE — JIT page allocation can fail at runtime under W^X
//! policies even when nominally supported), then the interpreter, which
//! works everywhere. All flag combinations produce identical hashes; they
//! only differ in speed. Returns nullptr if every attempt fails.
randomx_vm* CreateVM()
{
    // CONSENSUS FIREWALL, enforced rather than merely commented. This is a
    // VERIFICATION VM: it must be built from exactly the light-mode flags. If a
    // future edit ever OR-ed LARGE_PAGES or FULL_MEM into g_flags "so the mining
    // VM gets it", randomx_alloc_cache(g_flags) and this call would degrade the
    // verification path (large-page cache failure -> portable interpreter; a
    // full-memory VM with no dataset -> a library assert), on the very phones
    // the light-mode contract protects -- and the hash would stay correct, so
    // no differential test would catch it. Asserts are live in release here, so
    // the mistake aborts on first run instead of shipping a silently slow node.
    assert((g_flags & (RANDOMX_FLAG_LARGE_PAGES | RANDOMX_FLAG_FULL_MEM)) == 0);
    randomx_vm* vm{randomx_create_vm(g_flags, g_cache, nullptr)};
    if (vm == nullptr && (g_flags & RANDOMX_FLAG_JIT) == RANDOMX_FLAG_JIT) {
        vm = randomx_create_vm(g_flags | RANDOMX_FLAG_SECURE, g_cache, nullptr);
    }
    if (vm == nullptr && g_flags != RANDOMX_FLAG_DEFAULT) {
        vm = randomx_create_vm(RANDOMX_FLAG_DEFAULT, g_cache, nullptr);
    }
    return vm;
}

void InitCache()
{
    // Light mode only: no RANDOMX_FLAG_FULL_MEM (no 2 GiB dataset) and no
    // RANDOMX_FLAG_LARGE_PAGES (must never be required — it commonly fails
    // without special OS configuration). randomx_get_flags() auto-detects
    // JIT support, hardware AES and Argon2 SSSE3/AVX2 for this machine and
    // never includes LARGE_PAGES/FULL_MEM/SECURE.
    randomx_flags flags{randomx_get_flags()};
    randomx_cache* cache{randomx_alloc_cache(flags)};
    if (cache == nullptr) {
        // Fall back to the fully portable interpreter configuration; some
        // environments refuse the executable pages the JIT needs.
        flags = RANDOMX_FLAG_DEFAULT;
        cache = randomx_alloc_cache(flags);
    }
    if (cache == nullptr) {
        throw std::runtime_error("RandomX: failed to allocate the ~256 MiB light-mode verification cache (out of memory?)");
    }
    randomx_init_cache(cache, RANDOMX_KEY, RANDOMX_KEY_SIZE);
    g_cache = cache;
    g_flags = flags;

    // The firewall invariant, asserted at the one place g_flags is written.
    // randomx_get_flags() never sets LARGE_PAGES/FULL_MEM and neither does the
    // RANDOMX_FLAG_DEFAULT fallback above; this refuses the hand-edit that would.
    assert((g_flags & (RANDOMX_FLAG_LARGE_PAGES | RANDOMX_FLAG_FULL_MEM)) == 0);

    // Create the shared fallback VM up front so that, after successful
    // initialization, hashing can always proceed even if a thread later
    // fails to allocate its own VM.
    g_fallback_vm = CreateVM();
    if (g_fallback_vm == nullptr) {
        randomx_release_cache(cache);
        g_cache = nullptr;
        g_flags = RANDOMX_FLAG_DEFAULT;
        throw std::runtime_error("RandomX: failed to create a verification VM (out of memory?)");
    }
}

//! Return this thread's lazily-created RandomX VM (light mode, shared
//! cache), or nullptr if this thread could not allocate one (the caller
//! then serializes on g_fallback_vm instead).
randomx_vm* GetThreadVM()
{
    std::call_once(g_cache_once, InitCache);

    struct VMHolder {
        randomx_vm* vm{nullptr};
        VMHolder() : vm{CreateVM()}
        {
            // vm may be nullptr under severe memory pressure; this is
            // deliberately not an error — RandomXPowHash() falls back to
            // the shared VM so verification degrades instead of crashing.
        }
        ~VMHolder()
        {
            if (vm != nullptr) randomx_destroy_vm(vm);
        }
        VMHolder(const VMHolder&) = delete;
        VMHolder& operator=(const VMHolder&) = delete;
    };
    thread_local VMHolder holder;
    return holder.vm;
}

} // namespace

bool RandomXPowInit(std::string& error)
{
    try {
        std::call_once(g_cache_once, InitCache);
        return true;
    } catch (const std::exception& e) {
        error = e.what();
        return false;
    }
}

uint256 RandomXPowHash(const CBlockHeader& header)
{
    // Serialize the header exactly as CBlockHeader::GetHash() does: the
    // canonical 80-byte wire format.
    DataStream ss{};
    ss << header;
    assert(ss.size() == 80);

    // Fill the uint256 with the 32 RandomX output bytes in the same order a
    // block hash stores its bytes, so UintToArith256() interprets the result
    // as a little-endian 256-bit integer, matching the existing target
    // comparison convention.
    uint256 hash;
    if (randomx_vm* vm{GetThreadVM()}) {
        randomx_calculate_hash(vm, ss.data(), ss.size(), hash.begin());
    } else {
        // This thread could not allocate its own VM (severe memory
        // pressure). Serialize on the shared fallback VM created during
        // initialization: slower, but verification keeps working instead
        // of taking the process down.
        std::lock_guard lock{g_fallback_mutex};
        randomx_calculate_hash(g_fallback_vm, ss.data(), ss.size(), hash.begin());
    }
    return hash;
}

bool RandomXVerificationIsLightModeOnly()
{
    std::call_once(g_cache_once, InitCache);
    return (g_flags & (RANDOMX_FLAG_LARGE_PAGES | RANDOMX_FLAG_FULL_MEM)) == 0;
}

/* =========================================================================
 * OPT-IN RANDOMX FAST MODE -- MINING ONLY
 *
 * NOTHING BELOW THIS LINE IS REACHABLE FROM THE VERIFICATION PATH. Everything
 * above -- InitCache(), CreateVM(), GetThreadVM(), RandomXPowHash(), g_flags --
 * is untouched by this feature and stays light mode forever. In particular
 * RANDOMX_FLAG_FULL_MEM is never OR-ed into g_flags: it is added only at the
 * randomx_create_vm() call in CreateMiningVM(), so a verification VM is
 * structurally incapable of becoming a fast VM. If you are tempted to "unify"
 * the two hash paths, read the light-mode-only contract at the top of
 * InitCache() first -- PCoin validates on phones with ~2 GB of RAM.
 *
 * There is no logging here on purpose: bitcoin_crypto links only
 * core_interface and randomx (src/crypto/CMakeLists.txt), and dragging the
 * logging machinery into libbitcoinkernel for a mining accelerator is the
 * wrong trade. State is published through RandomXFastModeGetStatus() and the
 * node layer (init.cpp, node/cpuminer.cpp) does the talking.
 * ========================================================================= */

namespace {

constexpr uint64_t ONE_MIB{1024 * 1024};

//! The dataset is 2,181,038,016 bytes: RANDOMX_DATASET_BASE_SIZE (2147483648)
//! + RANDOMX_DATASET_EXTRA_SIZE (33554368), see randomx/src/configuration.h.
//! That is 2080 MiB minus 64 bytes -- NOT "2 GiB", which understates it by
//! 32 MiB. Rounded up here so every check is conservative.
constexpr uint64_t FAST_MODE_DATASET_MIB{2080};

//! Refuse to allocate right up against the last free megabyte. On Linux that
//! is how the OOM killer gets invited onto a box that is also running someone
//! else's database; on Windows it is how the whole desktop starts swapping,
//! and RandomX's 16384 random dataset reads per hash are pathological against
//! a pagefile. Matches FAST_MODE_HEADROOM_MIB in contrib/windows-tray, so the
//! tray and the node agree about eligibility.
constexpr uint64_t FAST_MODE_HEADROOM_MIB{900};

//! Hard floor on physically installed memory, independent of what happens to
//! be free right now. A 4 GB machine that currently looks empty is still a
//! machine where a 2080 MiB dataset is most of the RAM.
constexpr uint64_t FAST_MODE_MIN_TOTAL_MIB{4096};

//! Items initialised per randomx_init_dataset() call. That call has no
//! progress callback and no cancellation point -- it returns only when the
//! whole requested range is done -- so THE CHUNK SIZE IS THE SHUTDOWN LATENCY,
//! and shutdown blocks on the slowest chunk in flight. 32768 items is 2 MiB of
//! dataset: measured at well under a second on the machine this was developed
//! on, and it will be longer on slower hardware -- which is the reason for the
//! small number rather than the 16 MiB it started at. The shared claim counter
//! is nowhere near a bottleneck at this granularity.
constexpr unsigned long DATASET_CHUNK_ITEMS{1UL << 15};

//! The 2080 MiB dataset. Allocated at most once and, once READY, never
//! released -- the same rationale as g_cache above, one order of magnitude
//! larger: a fast VM dereferences dataset memory on every single hash
//! (randomx/src/vm_compiled.cpp), and worker threads are torn down at
//! unpredictable moments. Releasing it is only ever done on the failure path
//! below, where no VM can exist yet because the state never became READY.
//!
//! Atomic not because the hot path needs it -- builders only ever read a value
//! written before they were created -- but so that misuse is a defined race
//! rather than undefined behaviour if someone ever adds a second entry point.
std::atomic<randomx_dataset*> g_dataset{nullptr};

//! The one variable the mining hot path reads. Set with release ordering
//! after every dataset byte is written AND the light/fast cross-check has
//! passed, so an acquiring reader sees a complete, verified dataset.
std::atomic<bool> g_dataset_ready{false};

//! -randomxlargepages intent, recorded from init.cpp BEFORE any allocation, and
//! whether the dataset actually ended up on large pages. Both are MINING ONLY:
//! neither ever touches g_flags, so the verification path is untouched (the
//! firewall assert in InitCache()/CreateVM() enforces that). Large pages are an
//! attempt, never a requirement -- every failure falls back to normal pages and
//! mining proceeds. See AllocDataset()/CreateMiningVM().
std::atomic<bool> g_large_pages_requested{false};
std::atomic<bool> g_dataset_large_pages{false};

//! Mutable fast-mode bookkeeping, allocated once and intentionally never
//! destroyed -- the same doctrine as g_cache and g_fallback_vm, for a sharper
//! reason: `builders` holds std::thread objects, and destroying a joinable
//! std::thread calls std::terminate. A node that exited without running
//! Interrupt() would otherwise die at static-destruction time in exactly the
//! way the CPU miner already died once in the field. The mutex and the reason
//! string are kept in here too so that a builder thread outliving main() can
//! still touch them safely.
struct FastModeState {
    std::mutex mutex; //!< guards every field below
    RandomXFastModeState state{RandomXFastModeState::DISABLED};
    std::string reason;
    //! Why the dataset is or is not on large pages: "not requested", the OS
    //! refusal, or the actionable thing to grant. Empty until a dataset build
    //! is attempted. Reported through getcpuminerinfo, never logged from here.
    std::string large_pages_reason;
    std::vector<std::thread> builders;
};

FastModeState& Fast()
{
    static FastModeState* state{new FastModeState()};
    return *state;
}

std::atomic<unsigned long> g_next_item{0}; //!< next chunk to claim
std::atomic<unsigned long> g_items_done{0};
std::atomic<int> g_builders_live{0};

//! Set once, never cleared. RandomXFastModeStart() must NOT reset this:
//! shutdown would then be a one-shot cancel rather than a latch, and a start
//! arriving after Interrupt() would spawn builder threads that nothing joins,
//! running 2080 MiB of dataset initialisation through static destruction.
std::atomic<bool> g_build_cancel{false};

//! Sticky. Once shutdown has run, fast mode is closed for this process.
std::atomic<bool> g_shutdown_requested{false};

void SetFastState(RandomXFastModeState state, const std::string& reason)
{
    std::lock_guard lock{Fast().mutex};
    Fast().state = state;
    Fast().reason = reason;
}

/**
 * Create a fast-mode VM on the shared cache and the completed dataset.
 *
 * Deliberately NOT CreateVM(): that ladder's last resort is a light VM, so a
 * fast VM that failed to allocate would come back light and look like
 * success. This one never degrades. It returns nullptr and lets the caller
 * make the fall-back-to-light decision explicitly and visibly.
 *
 * Passing g_cache alongside the dataset is correct and required by nothing:
 * randomx_create_vm() records the cache key and then points the VM at the
 * dataset (randomx/src/randomx.cpp), and a full-memory VM's setCache is a
 * no-op. Reusing the very same cache is also what makes the fast and light
 * hashes provably the same value -- there is exactly one place in this
 * process where RANDOMX_KEY is used, and it is InitCache().
 */
randomx_vm* CreateMiningVM(bool* large_pages_out = nullptr)
{
    if (large_pages_out != nullptr) *large_pages_out = false;
    randomx_dataset* dataset{g_dataset.load(std::memory_order_acquire)};
    if (dataset == nullptr) return nullptr; // never call with FULL_MEM and no dataset
    const randomx_flags fast{g_flags | RANDOMX_FLAG_FULL_MEM};
    const bool jit{(g_flags & RANDOMX_FLAG_JIT) == RANDOMX_FLAG_JIT};

    // Rung 1, only when the operator opted in: a large-page 2 MiB scratchpad.
    // RANDOMX_FLAG_LARGE_PAGES at randomx_create_vm() selects ONLY this VM's
    // scratchpad allocator -- one TLB entry per worker instead of 512 -- and
    // touches neither the dataset nor the cache. It is written as a BARE LITERAL
    // and never derived from g_flags: the verification path must remain
    // structurally incapable of seeing it (the InitCache/CreateVM firewall
    // assert enforces that). A failure here -- no privilege, no pool, or
    // physical fragmentation -- is common and expected; it returns nullptr and
    // falls straight through to the normal-page rung, so one TryAcquire() still
    // yields a working fast VM.
    if (g_large_pages_requested.load(std::memory_order_relaxed)) {
        const randomx_flags lp{fast | RANDOMX_FLAG_LARGE_PAGES};
        randomx_vm* vm{randomx_create_vm(lp, g_cache, dataset)};
        if (vm == nullptr && jit) vm = randomx_create_vm(lp | RANDOMX_FLAG_SECURE, g_cache, dataset);
        if (vm != nullptr) {
            if (large_pages_out != nullptr) *large_pages_out = true;
            return vm;
        }
    }

    // Rung 2: the ordinary normal-page fast VM -- today's exact behaviour.
    // Deliberately NOT CreateVM(): that ladder's last resort is a LIGHT VM, so a
    // fast VM that failed to allocate would come back light and look like
    // success. This one never degrades; it returns nullptr and lets the caller
    // make the fall-back-to-light decision explicitly and visibly.
    randomx_vm* vm{randomx_create_vm(fast, g_cache, dataset)};
    if (vm == nullptr && jit) {
        vm = randomx_create_vm(fast | RANDOMX_FLAG_SECURE, g_cache, dataset);
    }
    return vm;
}

//! How many distinct headers the fast-vs-light cross-check hashes.
//!
//! One is not enough. A single RandomX hash performs RANDOMX_PROGRAM_COUNT (8)
//! x RANDOMX_PROGRAM_ITERATIONS (2048) = 16384 dataset reads against
//! 34,078,719 items -- under 0.05% of the dataset. A region corrupted outside
//! those reads would pass. 32 headers is ~1.5% and costs ~32 light hashes
//! (tens of milliseconds) against a build measured in minutes.
constexpr int FAST_MODE_PROBE_HEADERS{32};

//! Fixed, arbitrary 80-byte headers used only to cross-check fast against
//! light. Their content is irrelevant; only that both modes hash the same
//! bytes, and that they land in different places in the dataset.
std::vector<CBlockHeader> FastModeProbeHeaders()
{
    std::vector<CBlockHeader> headers;
    headers.reserve(FAST_MODE_PROBE_HEADERS);
    for (int i = 0; i < FAST_MODE_PROBE_HEADERS; ++i) {
        CBlockHeader header; // CBlockHeader() calls SetNull(): all fields zeroed
        header.nVersion = 0x20000000;
        header.nTime = 1785600628 + static_cast<uint32_t>(i); // PCoin's genesis timestamp
        header.nBits = 0x1f0fffff;                            // PCoin's powLimit in compact form
        header.nNonce = 0x50436f69 + static_cast<uint32_t>(i) * 0x9e3779b9u; // "PCoi", spread
        headers.push_back(header);
    }
    return headers;
}

/* ---------------------- host memory interrogation ----------------------- */

struct HostMemory {
    uint64_t total_bytes{0};
    uint64_t available_bytes{0};
    //! Memory that is genuinely unused right now, as opposed to reclaimable.
    //! UINT64_MAX means "this platform will not tell us", which disables the
    //! working-set test below rather than failing it.
    uint64_t free_bytes{UINT64_MAX};
};

enum class FileRead { ABSENT, UNREADABLE, OK };

//! Read a single unsigned integer from the first line of `path`. The literal
//! "max" (cgroup v2's no-limit sentinel) reads as UINT64_MAX.
FileRead ReadU64File(const char* path, uint64_t& out)
{
    std::ifstream f{path};
    if (!f.is_open()) return FileRead::ABSENT;
    std::string token;
    if (!(f >> token)) return FileRead::UNREADABLE;
    if (token == "max") {
        out = UINT64_MAX;
        return FileRead::OK;
    }
    try {
        size_t consumed{0};
        const unsigned long long v{std::stoull(token, &consumed)};
        if (consumed != token.size()) return FileRead::UNREADABLE;
        out = static_cast<uint64_t>(v);
        return FileRead::OK;
    } catch (const std::exception&) {
        return FileRead::UNREADABLE;
    }
}

#ifdef __linux__
//! Parse MemTotal, MemAvailable and MemFree out of /proc/meminfo (all in kB).
//!
//! BOTH MemAvailable and MemFree are needed, and they answer different
//! questions:
//!
//!  - MemAvailable is the kernel's estimate of what a new workload can take
//!    without swapping. It counts reclaimable page cache, so it is the right
//!    metric for a TRANSIENT allocation.
//!  - This allocation is not transient. The dataset is held for the life of
//!    the process and there is no RPC to drop it. Satisfying it out of
//!    reclaimable cache means permanently evicting somebody else's working
//!    set -- on a box running a 10 GB MariaDB with no swap, that is not a
//!    "free" 2 GB, it is a database that now reads from disk forever.
//!
//! So MemFree gates the permanent part: the dataset must fit in memory nobody
//! is currently using. MemAvailable still gates the total, headroom included.
bool ReadProcMemInfo(HostMemory& mem)
{
    std::ifstream f{"/proc/meminfo"};
    if (!f.is_open()) return false;
    std::string key;
    uint64_t value{0};
    std::string unit;
    bool have_total{false};
    bool have_avail{false};
    bool have_free{false};
    while (f >> key >> value >> unit) {
        if (unit != "kB") continue;
        if (key == "MemTotal:") {
            mem.total_bytes = value * 1024;
            have_total = true;
        } else if (key == "MemAvailable:") {
            mem.available_bytes = value * 1024;
            have_avail = true;
        } else if (key == "MemFree:") {
            mem.free_bytes = value * 1024;
            have_free = true;
        }
        if (have_total && have_avail && have_free) return true;
    }
    return have_total && have_avail;
}

//! This process's own path within a cgroup hierarchy, from /proc/self/cgroup.
//! v2 lines are "0::/user.slice/pcoind.service"; v1 lines are
//! "7:memory:/docker/abc123". Returns false if there is no such line.
bool ReadSelfCgroupPath(bool v2, std::string& out)
{
    std::ifstream f{"/proc/self/cgroup"};
    if (!f.is_open()) return false;
    std::string line;
    while (std::getline(f, line)) {
        const size_t c1{line.find(':')};
        if (c1 == std::string::npos) continue;
        const size_t c2{line.find(':', c1 + 1)};
        if (c2 == std::string::npos) continue;
        const std::string controllers{line.substr(c1 + 1, c2 - c1 - 1)};
        const bool match{v2 ? controllers.empty()
                            : controllers.find("memory") != std::string::npos};
        if (match) {
            out = line.substr(c2 + 1);
            if (out.empty()) out = "/";
            return true;
        }
    }
    return false;
}

//! Fold any cgroup memory limit into the figures.
//!
//! /proc/meminfo reports the HOST's memory inside a container, so a node in a
//! `docker run -m 2g` would happily read 8 GB, allocate 2080 MiB, and then be
//! killed by the cgroup's own OOM handler rather than the global one. PCoin's
//! only seed node runs in Docker. The same applies to a systemd unit with
//! MemoryMax=, which is the obvious thing for someone to add to
//! pcoind.service on a small box.
//!
//! A limit set anywhere ABOVE this process in the hierarchy binds it just as
//! hard as one set on its own cgroup, so walk to the root and take the
//! tightest. An absent file means "no limit at this level" and is fine; a
//! file that is present but cannot be parsed is UNKNOWN, and unknown is its
//! own state -- it refuses rather than collapsing into "plenty of room".
bool ApplyCgroupLimit(HostMemory& mem)
{
    struct Layout {
        bool v2;
        const char* root;
        const char* limit;
        const char* usage;
    };
    const Layout layouts[]{
        {true, "/sys/fs/cgroup", "memory.max", "memory.current"},
        {false, "/sys/fs/cgroup/memory", "memory.limit_in_bytes", "memory.usage_in_bytes"},
    };

    for (const auto& layout : layouts) {
        std::string path;
        if (!ReadSelfCgroupPath(layout.v2, path)) continue;

        // This cgroup, then each ancestor, then the hierarchy root.
        std::vector<std::string> dirs;
        for (;;) {
            dirs.push_back(std::string{layout.root} + (path == "/" ? "" : path));
            if (path == "/") break;
            const size_t slash{path.rfind('/')};
            path = (slash == std::string::npos || slash == 0) ? "/" : path.substr(0, slash);
        }

        bool found_controller{false};
        for (const auto& dir : dirs) {
            uint64_t limit{0};
            const FileRead lr{ReadU64File((dir + "/" + layout.limit).c_str(), limit)};
            if (lr == FileRead::UNREADABLE) return false;
            if (lr == FileRead::ABSENT) continue;
            found_controller = true;
            // cgroup v1 spells "no limit" as a huge sentinel, v2 as "max"
            // (already mapped to UINT64_MAX by ReadU64File).
            if (limit == UINT64_MAX || limit >= (uint64_t{1} << 62)) continue;

            uint64_t usage{0};
            if (ReadU64File((dir + "/" + layout.usage).c_str(), usage) != FileRead::OK) return false;

            const uint64_t headroom{usage >= limit ? 0 : limit - usage};
            mem.total_bytes = std::min(mem.total_bytes, limit);
            mem.available_bytes = std::min(mem.available_bytes, headroom);
            mem.free_bytes = std::min(mem.free_bytes, headroom);
        }
        if (found_controller) return true;
    }
    return true; // no cgroup memory controller in sight
}
#endif // __linux__

/**
 * Best available answer to "how much physical memory does this machine have,
 * and how much of it could a new 2 GiB workload actually take".
 *
 * Returns false when the platform cannot be interrogated honestly. That is a
 * refusal, not a shrug: on Linux a 2080 MiB allocation SUCCEEDS under the
 * default heuristic overcommit whether or not the memory exists, and the
 * process (or an innocent neighbour like MariaDB) is SIGKILLed a minute later
 * while the pages are being touched. There is no exception to catch, no log
 * line and no destructor. This check is the only real protection there is.
 */
bool QueryHostMemory(HostMemory& mem, std::string& reason)
{
#if defined(__ANDROID__)
    // Not a memory question. bitcoind runs as a child of the app under the
    // app's oom_score_adj on ~2 GB devices, where the dataset alone exceeds
    // RAM; the app already trims dbcache to 50 MiB to leave room for the
    // 256 MiB light cache. A kill here costs the user a full chain resync.
    (void)mem;
    reason = "fast mode is not supported on Android";
    return false;
#elif defined(WIN32)
    MEMORYSTATUSEX status{};
    status.dwLength = sizeof(status);
    if (!GlobalMemoryStatusEx(&status)) {
        reason = "could not read this machine's memory status";
        return false;
    }
    // ullAvailPhys, never ullAvailPageFile/ullTotalPageFile: those are the
    // commit limit, and a commit satisfied out of the pagefile is worse than
    // no fast mode at all.
    mem.total_bytes = static_cast<uint64_t>(status.ullTotalPhys);
    mem.available_bytes = static_cast<uint64_t>(status.ullAvailPhys);
    // ullAvailPhys is free + zeroed + standby, i.e. it includes the file
    // cache, and Windows exposes no cheap free-versus-standby split. Rather
    // than invent a number, the working-set test below is skipped here and
    // free_bytes stays UNKNOWN. That is acceptable because the machines this
    // runs on are dedicated miners; it would NOT be acceptable on the Linux
    // boxes, which is exactly where MemFree is available.
    return true;
#elif defined(__linux__)
    if (!ReadProcMemInfo(mem)) {
        reason = "could not read MemTotal/MemAvailable from /proc/meminfo";
        return false;
    }
    if (!ApplyCgroupLimit(mem)) {
        reason = "could not read this process's cgroup memory limit";
        return false;
    }
    return true;
#elif defined(_SC_PHYS_PAGES) && defined(_SC_AVPHYS_PAGES)
    const long pages{sysconf(_SC_PHYS_PAGES)};
    const long avail{sysconf(_SC_AVPHYS_PAGES)};
    const long page_size{sysconf(_SC_PAGESIZE)};
    if (pages <= 0 || avail < 0 || page_size <= 0) {
        reason = "could not determine this machine's memory size";
        return false;
    }
    mem.total_bytes = static_cast<uint64_t>(pages) * static_cast<uint64_t>(page_size);
    mem.available_bytes = static_cast<uint64_t>(avail) * static_cast<uint64_t>(page_size);
    return true;
#else
    (void)mem;
    reason = "cannot determine available memory on this platform";
    return false;
#endif
}

/* ---------------------- large-page preflight (opt-in) ------------------- */

#ifdef __linux__
//! The usable hugetlb pool in bytes: (HugePages_Free - HugePages_Rsvd) pages of
//! Hugepagesize each. HugePages_Rsvd is a SUBSET of HugePages_Free -- pages
//! another process has promised to fault in but not yet touched -- so it MUST be
//! subtracted or the pool is overcounted and a large-page allocation is admitted
//! that then fails. Returns false, leaving pool_bytes untouched, if ANY of the
//! three lines is missing or unparseable: an unknown pool must read as no pool,
//! never as a big one. Deliberately a NEW line-oriented parser -- ReadProcMemInfo's
//! `f >> key >> value >> unit` loop desynchronises on the HugePages_* lines,
//! which carry a bare count with no unit token.
bool ReadProcHugePages(uint64_t& pool_bytes)
{
    std::ifstream f{"/proc/meminfo"};
    if (!f.is_open()) return false;
    uint64_t free_pages{0}, rsvd_pages{0}, page_kib{0};
    bool have_free{false}, have_rsvd{false}, have_size{false};
    std::string line;
    auto after = [](const std::string& l, const char* key, uint64_t& out) -> bool {
        const size_t n{std::char_traits<char>::length(key)};
        if (l.compare(0, n, key) != 0) return false;
        try {
            size_t consumed{0};
            out = static_cast<uint64_t>(std::stoull(l.substr(n), &consumed));
            return consumed > 0;
        } catch (const std::exception&) { return false; }
    };
    while (std::getline(f, line)) {
        if (!have_free && after(line, "HugePages_Free:", free_pages)) have_free = true;
        else if (!have_rsvd && after(line, "HugePages_Rsvd:", rsvd_pages)) have_rsvd = true;
        else if (!have_size && after(line, "Hugepagesize:", page_kib)) have_size = true;
        if (have_free && have_rsvd && have_size) break;
    }
    if (!(have_free && have_rsvd && have_size) || page_kib == 0) return false;
    const uint64_t usable{free_pages > rsvd_pages ? free_pages - rsvd_pages : 0};
    pool_bytes = usable * page_kib * 1024;
    return true;
}
#endif // __linux__

//! Could a large-page allocation of `bytes` even be attempted right now? A
//! cheap, SIDE-EFFECT-FREE check run before the real allocation, so a machine
//! that cannot use large pages pays nothing -- no AdjustTokenPrivileges on
//! Windows, no MAP_POPULATE on Linux. Necessarily optimistic: physical-memory
//! fragmentation can still fail the real allocation, and NOTHING gates mining on
//! this -- the allocation itself is the final word and always falls back to
//! normal pages. Fills `why` in both directions.
bool LargePagePreflight(uint64_t bytes, std::string& why)
{
#if defined(WIN32)
    // Large pages need the "Lock pages in memory" right present IN THIS TOKEN.
    // UAC strips it from a filtered token, so the miner must run elevated; the
    // token scan here means the real allocator's setPrivilege() -- which
    // permanently enables the privilege -- is only ever reached on a machine
    // that was deliberately granted it.
    (void)bytes;
    if (GetLargePageMinimum() == 0) {
        why = "this Windows build does not support large pages";
        return false;
    }
    HANDLE token{nullptr};
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) {
        why = "could not read this process's privileges";
        return false;
    }
    LUID luid{};
    bool held{false};
    if (LookupPrivilegeValueA(nullptr, "SeLockMemoryPrivilege", &luid)) {
        DWORD len{0};
        GetTokenInformation(token, TokenPrivileges, nullptr, 0, &len);
        if (len > 0) {
            std::vector<unsigned char> buf(len);
            if (GetTokenInformation(token, TokenPrivileges, buf.data(), len, &len)) {
                const auto* tp{reinterpret_cast<const TOKEN_PRIVILEGES*>(buf.data())};
                for (DWORD i = 0; i < tp->PrivilegeCount; ++i) {
                    if (tp->Privileges[i].Luid.LowPart == luid.LowPart &&
                        tp->Privileges[i].Luid.HighPart == luid.HighPart) {
                        held = true;
                        break;
                    }
                }
            }
        }
    }
    CloseHandle(token);
    if (!held) {
        why = "grant the \"Lock pages in memory\" right to this account and run the miner "
              "elevated; mining on normal pages";
        return false;
    }
    why = "large pages available";
    return true;
#elif defined(__linux__)
    uint64_t pool{0};
    if (!ReadProcHugePages(pool)) {
        why = "no hugetlb pool (reserve one with vm.nr_hugepages); mining on normal pages";
        return false;
    }
    if (pool < bytes) {
        why = "the hugetlb pool holds " + std::to_string(pool / ONE_MIB) + " MiB but " +
              std::to_string((bytes + ONE_MIB - 1) / ONE_MIB) +
              " MiB is needed (raise vm.nr_hugepages); mining on normal pages";
        return false;
    }
    why = "large pages available";
    return true;
#else
    (void)bytes;
    why = "large pages are not implemented on this platform";
    return false;
#endif
}

/* --------------------------- the dataset build -------------------------- */

//! Run once, by whichever builder thread finishes last. Decides whether the
//! dataset may be used, and this is the check that enforces the whole
//! feature's central promise: fast and light must agree, bit for bit, on this
//! actual machine with this actual dataset.
void FinishDatasetBuild()
{
    const unsigned long total{randomx_dataset_item_count()};
    std::string failure;

    if (g_build_cancel.load(std::memory_order_relaxed)) {
        failure = "dataset build cancelled";
    } else if (g_items_done.load(std::memory_order_relaxed) != total) {
        // A gap or an overlap in the item split does not crash and does not
        // look wrong: it produces a miner whose every solution is rejected as
        // high-hash, silently burning the machine's entire hashrate. Refuse.
        failure = "dataset incomplete (" + std::to_string(g_items_done.load()) +
                  " of " + std::to_string(total) + " items initialised)";
    } else {
        std::string existing_failure;
        {
            std::lock_guard lock{Fast().mutex};
            if (Fast().state == RandomXFastModeState::UNAVAILABLE) existing_failure = Fast().reason;
        }
        if (!existing_failure.empty()) {
            failure = existing_failure;
        }
    }

    if (failure.empty()) {
        // THE CROSS-CHECK. Hash a spread of fixed headers both ways and
        // require bit equality on every one before any worker is allowed near
        // this dataset. The library documents the two modes as interchangeable
        // and the code agrees structurally, but a wrong answer here would be a
        // consensus split, so it is verified at runtime rather than trusted.
        randomx_vm* probe{CreateMiningVM()};
        if (probe == nullptr) {
            failure = "could not create a fast-mode VM";
        } else {
            for (const CBlockHeader& header : FastModeProbeHeaders()) {
                DataStream ss{};
                ss << header;
                assert(ss.size() == 80);
                uint256 fast_hash;
                randomx_calculate_hash(probe, ss.data(), ss.size(), fast_hash.begin());
                const uint256 light_hash{RandomXPowHash(header)};
                if (fast_hash != light_hash) {
                    failure = "fast mode disagrees with light mode (" + fast_hash.GetHex() +
                              " vs " + light_hash.GetHex() + ") -- refusing to mine on it";
                    break;
                }
            }
            randomx_destroy_vm(probe); // before any chance of releasing the dataset
        }
    }

    if (!failure.empty()) {
        // Safe to release here and only here: the state never became READY,
        // so RandomXMiningVm::TryAcquire() has never handed out a VM that
        // points into this memory, and the probe VM above is destroyed. That
        // -- not the worker join in CpuMiner::StopLocked() -- is the whole
        // lifetime argument, so assert the precondition rather than trust it.
        assert(!g_dataset_ready.load(std::memory_order_acquire));
        if (randomx_dataset* dataset{g_dataset.exchange(nullptr, std::memory_order_acq_rel)}) {
            randomx_release_dataset(dataset);
        }
        SetFastState(RandomXFastModeState::UNAVAILABLE, failure);
        return;
    }

    SetFastState(RandomXFastModeState::READY, "");
    g_dataset_ready.store(true, std::memory_order_release); // publishes the dataset
}

void DatasetBuilder()
{
    // Nothing may escape this function. An exception leaving a std::thread's
    // entry point calls std::terminate, and taking a node carrying real
    // chainstate down because an optional mining accelerator failed would be
    // absurd.
    try {
        const unsigned long total{randomx_dataset_item_count()};
        randomx_dataset* const dataset{g_dataset.load(std::memory_order_acquire)};
        for (;;) {
            if (dataset == nullptr) break;
            if (g_build_cancel.load(std::memory_order_relaxed)) break;
            const unsigned long start{g_next_item.fetch_add(DATASET_CHUNK_ITEMS, std::memory_order_relaxed)};
            if (start >= total) break;
            // count is derived from the remaining range, never a fixed
            // stride, so the last chunk is exact. randomx_init_dataset()
            // asserts start < total and start + count <= total, and those
            // asserts are LIVE in release builds here (the build system
            // removes -DNDEBUG on purpose), so an off-by-one would abort the
            // node rather than corrupt the dataset. Neither is acceptable;
            // this arithmetic cannot produce either.
            const unsigned long count{std::min<unsigned long>(DATASET_CHUNK_ITEMS, total - start)};
            randomx_init_dataset(dataset, g_cache, start, count);
            g_items_done.fetch_add(count, std::memory_order_relaxed);
        }
    } catch (const std::exception& e) {
        SetFastState(RandomXFastModeState::UNAVAILABLE, std::string{"dataset build failed: "} + e.what());
        g_build_cancel.store(true, std::memory_order_relaxed);
    } catch (...) {
        SetFastState(RandomXFastModeState::UNAVAILABLE, "dataset build failed with an unknown exception");
        g_build_cancel.store(true, std::memory_order_relaxed);
    }

    // Last one out finalises. Avoids a separate coordinator thread that would
    // itself have to be joined at shutdown.
    if (g_builders_live.fetch_sub(1, std::memory_order_acq_rel) == 1) {
        try {
            FinishDatasetBuild();
        } catch (const std::exception& e) {
            SetFastState(RandomXFastModeState::UNAVAILABLE, std::string{"dataset verification failed: "} + e.what());
        } catch (...) {
            SetFastState(RandomXFastModeState::UNAVAILABLE, "dataset verification failed");
        }
    }
}

/**
 * Allocate the 2080 MiB dataset, on large pages when asked for and possible, and
 * otherwise on ordinary pages -- but never an ordinary allocation the strict
 * memory gate would refuse.
 *
 * `used_lp` is set true iff the dataset landed on large pages. `why` is filled in
 * every case for getcpuminerinfo. Returns nullptr only when NO safe allocation is
 * possible; the caller then goes UNAVAILABLE and mines light.
 *
 * The large-page flag is a BARE LITERAL (never derived from g_flags), so it
 * cannot leak onto the verification path. A large-page failure -- the common
 * case: no privilege, no pool, or physical fragmentation -- is not fatal; it
 * falls through to the ordinary allocation.
 */
randomx_dataset* AllocDataset(bool large_pages, bool& used_lp, std::string& why)
{
    used_lp = false;
    const uint64_t dataset_bytes{FAST_MODE_DATASET_MIB * ONE_MIB};

    if (large_pages) {
        std::string pf;
        if (LargePagePreflight(dataset_bytes, pf)) {
            // randomx_alloc_dataset() reads exactly one flag bit,
            // RANDOMX_FLAG_LARGE_PAGES. Written as a bare literal so large pages
            // can never leak in via g_flags even if g_flags changes.
            if (randomx_dataset* d{randomx_alloc_dataset(RANDOMX_FLAG_LARGE_PAGES)}) {
                used_lp = true;
                why = "on large pages";
                return d;
            }
            why = "the OS refused a large-page dataset (physical memory too fragmented, or the "
                  "pool was taken); mining on normal pages -- ";
        } else {
            why = pf + " -- ";
        }
    } else {
        why = "large pages not requested; ";
    }

    // NORMAL-PAGE FALLBACK. Re-check the STRICT, UNCREDITED memory gate right
    // here. RandomXFastModeEligible() may have been credited by a hugetlb pool,
    // admitting a machine that does NOT have 2080 MiB of ordinary memory; and
    // minutes can pass between that eligibility preview and this call. Without
    // this re-check a large-page failure would drop to a 2080 MiB ORDINARY
    // allocation the gate would refuse -- and on a shared seed the OOM killer,
    // not an exception, answers. The check mirrors RandomXFastModeEligible()'s
    // uncredited arithmetic exactly.
    HostMemory mem;
    std::string mr;
    if (!QueryHostMemory(mem, mr)) {
        why += "and this machine's memory could not be re-checked (" + mr + ")";
        return nullptr;
    }
    const uint64_t needed{(FAST_MODE_DATASET_MIB + FAST_MODE_HEADROOM_MIB) * ONE_MIB};
    if (mem.total_bytes < FAST_MODE_MIN_TOTAL_MIB * ONE_MIB || mem.available_bytes < needed ||
        (mem.free_bytes != UINT64_MAX && mem.free_bytes < dataset_bytes)) {
        why += "and there is not enough ordinary memory for a " + std::to_string(FAST_MODE_DATASET_MIB) +
               " MiB dataset (available " + std::to_string(mem.available_bytes / ONE_MIB) + " MiB, unused " +
               (mem.free_bytes == UINT64_MAX ? std::string{"unknown"} : std::to_string(mem.free_bytes / ONE_MIB) + " MiB") + ")";
        return nullptr;
    }
    randomx_dataset* d{randomx_alloc_dataset(RANDOMX_FLAG_DEFAULT)};
    if (d == nullptr) why += "and the normal-page dataset allocation failed";
    return d;
}

} // namespace

bool RandomXFastModeEligible(bool large_pages, std::string& reason)
{
    // The cache must exist first: its flags decide whether the dataset build
    // is JIT-compiled or interpreted, and fast mode reuses the very same
    // cache rather than allocating a second one.
    try {
        std::call_once(g_cache_once, InitCache);
    } catch (const std::exception& e) {
        reason = std::string{"RandomX is not initialised: "} + e.what();
        return false;
    }

    if ((g_flags & RANDOMX_FLAG_JIT) != RANDOMX_FLAG_JIT) {
        // Without the JIT the dataset is built by the portable interpreter,
        // roughly an order of magnitude slower, AND the resulting full-memory
        // interpreter VM is slower than a light-mode JIT VM while using
        // 2080 MiB more. Fast mode here is worse on every axis. This is a
        // permanent property of the machine, so say so plainly.
        reason = "this machine has no RandomX JIT, where fast mode would be slower than light mode";
        return false;
    }

    HostMemory mem;
    std::string mem_reason;
    if (!QueryHostMemory(mem, mem_reason)) {
        reason = mem_reason;
        return false;
    }

    // Everything the decision was made from, in one string, reported whether
    // the answer is yes or no. Two nodes disagreeing about fast mode with no
    // way to find out why is its own kind of outage.
    const std::string measured{
        "total " + std::to_string(mem.total_bytes / ONE_MIB) + " MiB, available " +
        std::to_string(mem.available_bytes / ONE_MIB) + " MiB, unused " +
        (mem.free_bytes == UINT64_MAX ? std::string{"unknown"}
                                      : std::to_string(mem.free_bytes / ONE_MIB) + " MiB")};

    // Linux large-page CREDIT. When the operator has reserved a hugetlb pool
    // that covers the dataset, the 2080 MiB dataset comes from THAT pool -- which
    // is already reserved and already subtracted from MemFree/MemAvailable -- and
    // not from ordinary memory. So the dataset does not have to be found in
    // MemFree/MemAvailable a second time, and it evicts nobody's page cache;
    // without this credit, reserving the pool would itself push MemFree below the
    // threshold and REFUSE the very machine that configured the feature.
    //
    // The credit binds ONLY this "may we attempt fast mode" decision. The
    // normal-page fallback inside AllocDataset() re-checks the UNCREDITED gate,
    // so a machine that reserved a pool but has little ordinary memory can never
    // fall back to a 2080 MiB ordinary allocation this credited gate would let
    // through -- on a shared seed that would invite the OOM killer, not an
    // exception. On Windows there is no pool concept (large pages come from
    // ordinary physical memory, counted normally), so `large_pages` never
    // credits anything there.
    bool dataset_from_pool{false};
#ifdef __linux__
    if (large_pages) {
        uint64_t pool{0};
        if (ReadProcHugePages(pool) && pool >= FAST_MODE_DATASET_MIB * ONE_MIB) dataset_from_pool = true;
    }
#else
    (void)large_pages;
#endif

    const uint64_t needed{(dataset_from_pool ? FAST_MODE_HEADROOM_MIB
                                             : FAST_MODE_DATASET_MIB + FAST_MODE_HEADROOM_MIB) * ONE_MIB};
    if (mem.total_bytes < FAST_MODE_MIN_TOTAL_MIB * ONE_MIB) {
        reason = "fast mode needs at least " + std::to_string(FAST_MODE_MIN_TOTAL_MIB) +
                 " MiB of RAM installed; this machine has " +
                 std::to_string(mem.total_bytes / ONE_MIB) + " MiB (" + measured + ")";
        return false;
    }
    if (mem.available_bytes < needed) {
        reason = "fast mode needs " + std::to_string(needed / ONE_MIB) + " MiB free" +
                 (dataset_from_pool ? " of headroom beyond the hugetlb pool"
                                    : " (a " + std::to_string(FAST_MODE_DATASET_MIB) + " MiB dataset plus " +
                                          std::to_string(FAST_MODE_HEADROOM_MIB) + " MiB of headroom)") +
                 "; only " + std::to_string(mem.available_bytes / ONE_MIB) + " MiB is available (" + measured + ")";
        return false;
    }
    // The working-set test. `available` counts reclaimable page cache, and a
    // PERMANENT reservation satisfied out of cache is somebody else's hot data
    // evicted forever -- on a swapless box with a large resident database,
    // that is the difference between "fast mode" and "the database now reads
    // from disk". Skipped when the dataset comes from the hugetlb pool: those
    // pages were reserved out of band and evict no cache.
    if (!dataset_from_pool && mem.free_bytes != UINT64_MAX && mem.free_bytes < FAST_MODE_DATASET_MIB * ONE_MIB) {
        reason = "fast mode needs " + std::to_string(FAST_MODE_DATASET_MIB) +
                 " MiB of genuinely unused memory (its dataset is never released, so taking it "
                 "out of reclaimable cache would permanently evict whatever else is running here); "
                 "only " + std::to_string(mem.free_bytes / ONE_MIB) + " MiB is unused (" + measured + ")";
        return false;
    }
    reason = "fast mode eligible: " + measured + (dataset_from_pool ? " (dataset from hugetlb pool)" : "");
    return true;
}

bool RandomXFastModeStart(int threads, std::string& reason)
{
    // THE WHOLE DISABLED->BUILDING TRANSITION HAPPENS UNDER THIS LOCK.
    //
    // It used to read the state, drop the lock, and only publish BUILDING
    // after eligibility (milliseconds of /proc I/O) and a 2080 MiB
    // allocation. Two callers landing in that window would both pass the
    // idempotency check: two datasets allocated, g_dataset overwritten while
    // the first cohort of builders was writing through it, g_builders_live
    // clobbered so the wrong thread runs the finaliser, and
    // randomx_release_dataset() called on memory a live builder is touching.
    // That is CLAUDE.md 7.5 one level down -- "an RPC entry point is a
    // concurrent entry point" -- and there is now more than one caller
    // (cpuminer's supervisor, plus the unit test), so it is not hypothetical.
    //
    // Cost of holding it: the allocation is a reservation, not a touch, and
    // eligibility is a few small file reads. Everything that contends for this
    // mutex is a status read. Correctness is worth the microseconds.
    {
        std::lock_guard lock{Fast().mutex};

        if (g_shutdown_requested.load(std::memory_order_relaxed)) {
            // Shutdown is a latch, not a one-shot cancel. Spawning builders
            // now would leave threads nobody joins running 2080 MiB of dataset
            // initialisation through chainstate teardown and static
            // destruction, lazily constructing thread_local VMs on the way.
            reason = "the node is shutting down";
            return false;
        }
        if (Fast().state == RandomXFastModeState::BUILDING ||
            Fast().state == RandomXFastModeState::READY) {
            return true; // idempotent
        }
        if (Fast().state == RandomXFastModeState::UNAVAILABLE) {
            // Sticky. One refusal per process: never auto-retry into the same
            // out-of-memory condition on an unattended machine.
            reason = Fast().reason;
            return false;
        }

        // Eligibility is credited by a hugetlb pool when large pages are
        // requested, so a machine that reserved a pool is not refused for the
        // very memory it set aside. AllocDataset() re-checks the uncredited gate
        // before any ordinary-page fallback.
        if (!RandomXFastModeEligible(g_large_pages_requested.load(std::memory_order_relaxed), reason)) {
            Fast().state = RandomXFastModeState::UNAVAILABLE;
            Fast().reason = reason;
            return false;
        }

        // Claim the transition before doing anything expensive. Any failure
        // below moves the state to UNAVAILABLE; nothing leaves it BUILDING.
        Fast().state = RandomXFastModeState::BUILDING;
        Fast().reason = "building the RandomX dataset";
    }

    bool used_lp{false};
    std::string lp_why;
    randomx_dataset* dataset{AllocDataset(g_large_pages_requested.load(std::memory_order_relaxed), used_lp, lp_why)};
    if (dataset == nullptr) {
        reason = "could not allocate the " + std::to_string(FAST_MODE_DATASET_MIB) + " MiB RandomX dataset (" + lp_why + ")";
        SetFastState(RandomXFastModeState::UNAVAILABLE, reason);
        return false;
    }
    g_dataset_large_pages.store(used_lp, std::memory_order_relaxed);
    {
        std::lock_guard lock{Fast().mutex};
        Fast().large_pages_reason = lp_why;
    }

    const int max_threads{std::max(1, static_cast<int>(std::thread::hardware_concurrency()))};
    if (threads <= 0) {
        // Half the cores by default. These machines run other people's
        // services; pinning every core for the length of the build is its own
        // small outage, and the build is a one-off cost either way.
        threads = std::max(1, max_threads / 2);
    }
    threads = std::min(threads, max_threads);

    g_next_item.store(0, std::memory_order_relaxed);
    g_items_done.store(0, std::memory_order_relaxed);
    // g_build_cancel is deliberately NOT reset here; see its declaration.
    //
    // The spawner holds a ticket of its own (+1). The finaliser is elected by
    // whichever fetch_sub returns 1, and without that extra ticket a builder
    // that finished before the spawn loop had subtracted for its failed
    // siblings would see a count above 1, decline to finalise, and the
    // spawner's own corrections would then carry the counter to zero with
    // nobody left to run FinishDatasetBuild(): 2080 MiB pinned forever, state
    // stuck at BUILDING, and a progress field reading 100% for the life of the
    // process. With the ticket, exactly one decrementer always observes 1.
    g_builders_live.store(threads + 1, std::memory_order_relaxed);
    g_dataset.store(dataset, std::memory_order_release);

    int spawned{0};
    {
        std::lock_guard lock{Fast().mutex};
        Fast().builders.reserve(static_cast<size_t>(threads));
        for (int i = 0; i < threads; ++i) {
            try {
                Fast().builders.emplace_back(DatasetBuilder);
                ++spawned;
            } catch (const std::system_error&) {
                // Could not spawn this thread. The ones already running still
                // cover the whole range -- chunks are claimed from a shared
                // counter rather than statically split, so coverage does not
                // depend on how many threads exist.
            }
        }
    }

    if (spawned == 0) {
        // No builder exists, so nobody races this: safe to unwind directly.
        g_dataset.store(nullptr, std::memory_order_release);
        randomx_release_dataset(dataset);
        g_builders_live.store(0, std::memory_order_relaxed);
        reason = "could not start any dataset build threads";
        SetFastState(RandomXFastModeState::UNAVAILABLE, reason);
        return false;
    }

    // Retire the spawner's ticket plus one for each spawn that failed. Done
    // OUTSIDE the lock: FinishDatasetBuild() takes it via SetFastState().
    bool finalise{false};
    for (int i = 0; i < 1 + (threads - spawned); ++i) {
        if (g_builders_live.fetch_sub(1, std::memory_order_acq_rel) == 1) finalise = true;
    }
    if (finalise) {
        try {
            FinishDatasetBuild();
        } catch (const std::exception& e) {
            SetFastState(RandomXFastModeState::UNAVAILABLE,
                         std::string{"dataset verification failed: "} + e.what());
        } catch (...) {
            SetFastState(RandomXFastModeState::UNAVAILABLE, "dataset verification failed");
        }
    }
    return true;
}

void RandomXFastModeDisable(const std::string& reason)
{
    // Order matters. Close the gate first so no further worker can acquire a
    // VM, then publish the reason. The dataset is NOT released: workers that
    // already hold VMs are still dereferencing it, and never-release is the
    // invariant that makes that safe.
    g_dataset_ready.store(false, std::memory_order_release);
    SetFastState(RandomXFastModeState::UNAVAILABLE, reason);
}

RandomXFastModeStatus RandomXFastModeGetStatus()
{
    RandomXFastModeStatus out;
    const unsigned long total{randomx_dataset_item_count()};
    const unsigned long done{g_items_done.load(std::memory_order_relaxed)};
    {
        std::lock_guard lock{Fast().mutex};
        out.state = Fast().state;
        out.reason = Fast().reason;
        out.large_pages_reason = Fast().large_pages_reason;
    }
    out.large_pages = g_dataset_large_pages.load(std::memory_order_relaxed);
    if (out.state == RandomXFastModeState::READY) {
        out.percent = 100;
    } else if (out.state == RandomXFastModeState::BUILDING && total > 0) {
        out.percent = static_cast<int>((static_cast<uint64_t>(done) * 100) / total);
        out.reason = "building the RandomX dataset, " + std::to_string(out.percent) + "% done";
    }
    return out;
}

void RandomXSetLargePagesIntent(bool enabled)
{
    g_large_pages_requested.store(enabled, std::memory_order_relaxed);
}

bool RandomXLargePagesPreflight()
{
    // Already in use? Then large pages are unquestionably in play -- answer yes
    // without re-reading the pool, which the running dataset has by now consumed
    // (HugePages_Free drops to near zero once the 1040-page dataset is mapped, so
    // a fresh preflight would wrongly say "no" while every worker is on large
    // pages).
    if (g_dataset_large_pages.load(std::memory_order_relaxed)) return true;
    if (!g_large_pages_requested.load(std::memory_order_relaxed)) return false;
    std::string why;
    return LargePagePreflight(FAST_MODE_DATASET_MIB * ONE_MIB, why);
}

void RandomXFastModeShutdown()
{
    // Latch first, cancel second. Once this is set, RandomXFastModeStart()
    // refuses for the rest of the process, so no cohort of builder threads can
    // be created after the join below has already happened.
    g_shutdown_requested.store(true, std::memory_order_relaxed);
    g_build_cancel.store(true, std::memory_order_relaxed);
    std::vector<std::thread> builders;
    {
        // Swap the handles out under the lock and join OUTSIDE it: a builder
        // thread takes this same mutex when it publishes its result, so
        // joining while holding it would deadlock.
        std::lock_guard lock{Fast().mutex};
        builders.swap(Fast().builders);
    }
    for (auto& t : builders) {
        if (t.joinable()) t.join();
    }
    // A completed dataset is deliberately not released; see g_dataset above.
}

RandomXMiningVm::~RandomXMiningVm()
{
    if (m_vm != nullptr) randomx_destroy_vm(m_vm);
}

bool RandomXMiningVm::TryAcquire(bool* failed)
{
    if (m_vm != nullptr) return true;
    if (m_tried) return false; // one attempt per handle; see the header
    // One relaxed-ish atomic load in the common case. The acquire pairs with
    // the release store in FinishDatasetBuild(), so if this reads true the
    // dataset is complete, verified, and visible to this thread. It also goes
    // back to false if fast mode is taken out of service, which is what makes
    // every worker converge on light mode within one nonce batch.
    if (!g_dataset_ready.load(std::memory_order_acquire)) return false;
    m_tried = true;
    m_vm = CreateMiningVM(&m_large_pages);
    if (m_vm == nullptr && failed != nullptr) *failed = true;
    return m_vm != nullptr;
}

void RandomXMiningVm::Release()
{
    if (m_vm != nullptr) {
        randomx_destroy_vm(m_vm);
        m_vm = nullptr;
    }
    m_tried = true; // never re-acquire under this handle
}

uint256 RandomXMiningVm::Hash(const CBlockHeader& header)
{
    if (m_vm == nullptr) {
        // No fast VM: this is byte-for-byte the ordinary light path, which is
        // the correct answer, just slower. Mixed fast/light workers are fine.
        return RandomXPowHash(header);
    }
    DataStream ss{};
    ss << header;
    assert(ss.size() == 80);
    uint256 hash;
    randomx_calculate_hash(m_vm, ss.data(), ss.size(), hash.begin());
    return hash;
}
