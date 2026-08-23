// Copyright (c) 2026 The PCoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.

#ifndef BITCOIN_CRYPTO_POW_RANDOMX_H
#define BITCOIN_CRYPTO_POW_RANDOMX_H

#include <uint256.h>

#include <string>

class CBlockHeader;
struct randomx_vm;

/**
 * Eagerly initialize the RandomX proof-of-work verification state: the
 * shared ~256 MiB light-mode cache plus a shared fallback VM. Safe to call
 * more than once and from multiple threads (protected by std::call_once).
 *
 * Returns false and fills `error` (instead of throwing) if allocation
 * fails, so node init can turn an out-of-memory condition into a clean
 * startup error rather than an uncaught exception during the first header
 * validation. After a successful call, RandomXPowHash() never throws.
 */
bool RandomXPowInit(std::string& error);

/**
 * Compute the PCoin v1 RandomX proof-of-work hash of a block header.
 *
 * The input is the canonical 80-byte serialized header (the exact same bytes
 * CBlockHeader::GetHash() hashes with SHA256d). The RandomX key is the fixed
 * ASCII string "PCoin/RandomX/v1" (16 bytes, no NUL terminator) on all
 * networks, including regtest.
 *
 * The 32 output bytes are placed into a uint256 with the same byte-order
 * convention as a block hash, i.e. the returned value compares against a
 * target after UintToArith256() exactly like GetHash() would.
 *
 * Verification runs in RandomX light mode: a ~256 MiB shared cache
 * (initialized once, eagerly via RandomXPowInit() or lazily on first use)
 * plus one lazily-created VM per thread. A JIT-capable VM is used when the
 * platform allows it, with automatic fallback to the (slower, fully
 * portable) interpreter; large pages are never required. A thread that
 * cannot allocate its own VM shares a mutex-protected fallback VM, so
 * after successful initialization this function never fails. Only the
 * initialization itself can fail: if it has to run lazily here and
 * allocation fails, this throws std::runtime_error (node code avoids that
 * path by calling RandomXPowInit() at startup).
 *
 * Note: this function is NOT the block id. Block hashes (GetHash(),
 * prev-block links, RPC hashes) remain double-SHA256; only the
 * proof-of-work check uses this hash.
 */
uint256 RandomXPowHash(const CBlockHeader& header);

/**
 * True iff the shared RandomX VERIFICATION flags (g_flags) carry neither
 * RANDOMX_FLAG_LARGE_PAGES nor RANDOMX_FLAG_FULL_MEM.
 *
 * That is the consensus firewall stated as a value a test can read. g_flags is
 * the one variable both paths share: it builds the verification cache and every
 * verification VM, and fast mode only ever ORs FULL_MEM in at a single
 * mining-only call site. If either bit ever leaked into g_flags itself, block
 * verification would try to allocate its 256 MiB cache (or a VM scratchpad) on
 * large pages / as a full dataset and silently fall back to the portable
 * interpreter on the constrained machines the light-mode contract exists to
 * protect -- with the hash still bit-for-bit correct, so no hash test would
 * notice. The node also asserts this at runtime (InitCache/CreateVM); this
 * accessor lets the unit tests assert it without pulling randomx.h into a
 * public header. Forces initialisation first, so the answer is never "not yet
 * decided".
 */
bool RandomXVerificationIsLightModeOnly();

/* -------------------------------------------------------------------------
 * OPT-IN RANDOMX FAST MODE -- MINING ONLY.
 *
 * RandomX can hash from a ~2 GiB dataset ("fast mode") instead of recomputing
 * dataset items on the fly from the 256 MiB cache ("light mode"). Both modes
 * produce IDENTICAL hashes -- light mode's dataset reads call the very same
 * item-initialisation routine that fills the dataset -- so this is purely a
 * memory-for-speed trade with no consensus content whatsoever.
 *
 * Everything above this line is the VERIFICATION path and stays in light mode
 * forever. That is not a default, it is a requirement: PCoin nodes run on
 * phones with ~2 GB of RAM and every one of them must be able to validate
 * every block. Nothing below this line is reachable from RandomXPowHash(),
 * GetThreadVM(), CreateVM(), InitCache() or g_flags; the only consumer is
 * src/node/cpuminer.cpp, and it reaches it through RandomXMiningVm.
 *
 * Fast mode is off unless the operator asks for it (-randomxfastmode), and it
 * refuses itself on a machine that cannot afford the memory. It is never
 * fatal: a refusal mines in light mode and says so.
 * ------------------------------------------------------------------------- */

//! -randomxfastmode default. Never change this to true.
static constexpr bool DEFAULT_RANDOMX_FAST_MODE{false};

enum class RandomXFastModeState {
    DISABLED,    //!< never requested
    BUILDING,    //!< dataset allocated, initialisation in progress
    READY,       //!< dataset complete and verified against light mode
    UNAVAILABLE, //!< requested but refused or failed; see `reason`
};

struct RandomXFastModeStatus {
    RandomXFastModeState state{RandomXFastModeState::DISABLED};
    //! Dataset build progress, 0..100. Only meaningful in BUILDING/READY.
    int percent{0};
    //! Human-readable explanation. Empty in READY; a refusal or failure
    //! reason in UNAVAILABLE; a progress note in BUILDING.
    std::string reason;
};

/**
 * Decide whether fast mode may run on this machine, without allocating
 * anything. Returns false and fills `reason` with an operator-readable
 * explanation (too little RAM, no JIT, unsupported platform, ...).
 *
 * "Cannot tell how much memory is available" is a refusal, not a maybe.
 */
bool RandomXFastModeEligible(std::string& reason);

/**
 * Request fast mode. Allocates the ~2080 MiB dataset and starts initialising
 * it on `threads` background threads, then RETURNS IMMEDIATELY -- the build
 * takes tens of seconds to minutes and must never block an RPC, a mining
 * start, or shutdown.
 *
 * `threads` <= 0 means "half the cores, at least one": the machines that run
 * this also run other people's services, and saturating every core for a
 * minute at startup is its own kind of outage.
 *
 * CALL THIS ONLY WHEN THE NODE IS ACTUALLY GOING TO MINE. The dataset is a
 * permanent 2080 MiB reservation with exactly one consumer, so a node that
 * never mines must never allocate it. node/cpuminer.cpp calls it from the
 * mining supervisor thread, i.e. after a real `startmining`; init.cpp only
 * records the operator's intent. A pure relay or seed node therefore cannot
 * reach this code no matter what is in its config file.
 *
 * `reason` is filled in BOTH directions: on failure with the refusal, on
 * success with the measured memory figures the decision was made from, so an
 * operator can see why one node engaged fast mode and another did not.
 *
 * A failure discovered later (allocation, coverage, or the light/fast
 * cross-check) turns the state into UNAVAILABLE with a reason instead; the
 * miner then runs in light mode. Idempotent under concurrency: the
 * DISABLED->BUILDING transition happens under one lock, so a second caller
 * (a second startmining, a second RPC) sees BUILDING and returns true without
 * allocating anything.
 *
 * Returns false once RandomXFastModeShutdown() has been called: shutdown is a
 * sticky latch, not a one-shot cancel, so a start racing a shutdown can never
 * leave builder threads behind that nobody will join.
 *
 * Requires RandomXPowInit() to have succeeded first (init.cpp guarantees it).
 */
bool RandomXFastModeStart(int threads, std::string& reason);

/**
 * Take fast mode out of service for the rest of the process, with a reason.
 *
 * The one caller that matters is the miner's own last line of defence: if a
 * fast-mode solve ever fails the light-mode re-check (node/cpuminer.cpp), the
 * dataset is not trustworthy and every subsequent fast-mode solve would be
 * silently discarded. Detecting that and merely logging it is the mistake this
 * project has already made three times -- a node-confirmed terminal outcome
 * must advance the authoritative state, not print about it.
 *
 * After this call: RandomXMiningVm::TryAcquire() hands out nothing, every
 * worker converges on light mode within one nonce batch, and getcpuminerinfo
 * reports mode "light" with this reason -- which is the only signal the fleet
 * supervisors can actually see, because they read RPC and never read logs.
 *
 * The dataset itself is NOT released: other workers may still hold VMs
 * pointing into it. Never-release is what makes this safe.
 */
void RandomXFastModeDisable(const std::string& reason);

/**
 * Snapshot of the fast-mode state, safe to call from any thread at any time.
 * This is an OBSERVATION, not an intent: it reports what the dataset actually
 * is, so a UI can never claim fast mode on a node that refused it.
 */
RandomXFastModeStatus RandomXFastModeGetStatus();

/**
 * Cancel any in-progress dataset build and join the builder threads. Called
 * during node shutdown. Returns promptly (the build is chunked and checks for
 * cancellation between chunks). Safe to call when fast mode was never started.
 *
 * A completed dataset is NOT released -- see the leak rationale in the .cpp.
 */
void RandomXFastModeShutdown();

/**
 * A mining thread's RandomX VM.
 *
 * Owned by the worker's stack frame, never thread_local and never pooled.
 *
 * WHAT ACTUALLY GUARANTEES SAFETY: the dataset is published by a monotone
 * false->true latch and a READY dataset is never freed. The only
 * randomx_release_dataset() call sits on a path where the latch was never set,
 * so TryAcquire() cannot have handed out a VM pointing into that memory. The
 * worker join in CpuMiner::StopLocked() proves nothing about this -- it is a
 * different lock and a different lifetime -- so do not add a
 * release-on-stopmining "optimisation" on the strength of it. Freeing the
 * dataset would require a reference count owned by this class.
 *
 * Default-constructed it holds nothing and Hash() is exactly the ordinary
 * light path. TryAcquire() upgrades it to a fast VM if and only if the
 * dataset is READY. A worker that never manages to acquire one simply mines
 * in light mode -- correct, just slower -- and workers in the two modes can
 * mine side by side, because the hashes are the same.
 */
class RandomXMiningVm
{
public:
    RandomXMiningVm() = default;
    ~RandomXMiningVm();

    RandomXMiningVm(const RandomXMiningVm&) = delete;
    RandomXMiningVm& operator=(const RandomXMiningVm&) = delete;

    /**
     * Acquire a fast-mode VM if the dataset is ready and one is not already
     * held. Cheap enough to call in a mining loop (one relaxed atomic load in
     * the common case). Returns true if a fast VM is held afterwards.
     *
     * VM creation is attempted AT MOST ONCE per handle. A machine whose W^X
     * policy refuses the JIT page allocation fails this every time, and this
     * is called once per 64-nonce batch -- roughly 80 times a second per
     * worker -- so an unlatched retry is a permanent mmap/mprotect/munmap
     * storm plus a 2 MiB scratchpad churned each round. `failed` tells the
     * caller to say so once instead of silently spinning.
     */
    bool TryAcquire(bool* failed = nullptr);

    //! Drop the fast VM and go back to being the ordinary light path. Used when
    //! fast mode is taken out of service under this handle's feet.
    void Release();

    //! True if this handle holds a fast-mode VM.
    bool IsFast() const { return m_vm != nullptr; }

    /**
     * The PCoin v1 RandomX PoW hash of `header`: bit-for-bit the same value
     * RandomXPowHash() returns, computed on this handle's fast VM when it has
     * one and by the ordinary light path when it does not.
     */
    uint256 Hash(const CBlockHeader& header);

private:
    randomx_vm* m_vm{nullptr};
    //! One attempt per handle; see TryAcquire().
    bool m_tried{false};
};

#endif // BITCOIN_CRYPTO_POW_RANDOMX_H
