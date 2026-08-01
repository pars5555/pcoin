// Copyright (c) 2026 The PCoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.

#include <crypto/pow_randomx.h>

#include <primitives/block.h>
#include <serialize.h>
#include <streams.h>
#include <uint256.h>

#include <randomx.h>

#include <cassert>
#include <cstddef>
#include <exception>
#include <mutex>
#include <stdexcept>
#include <string>

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
