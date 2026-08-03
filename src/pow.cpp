// Copyright (c) 2009-2010 Satoshi Nakamoto
// Copyright (c) 2009-2022 The Bitcoin Core developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.

#include <pow.h>

#include <arith_uint256.h>
#include <chain.h>
#include <crypto/pow_randomx.h>
#include <primitives/block.h>
#include <uint256.h>
#include <util/check.h>

#include <limits>
#include <vector>

/**
 * PCoin: zawy12 LWMA-1 difficulty algorithm. Active at and above
 * params.lwmaHeight. Linearly-weighted moving average of solvetimes, with the
 * target averaged over the same window, evaluated on every block.
 *
 * OVERFLOW SAFETY -- READ BEFORE EDITING.
 *
 * The division by (k*N) MUST stay inside the accumulation loop, before any
 * multiplication. That ordering is the whole reason this function is safe at
 * PCoin's oversized powLimit (000fffff... == 2^244 - 1, versus Bitcoin's
 * 2^224). With the per-solvetime cap ST it bounds the final product at
 * (ST/T)*powLimit regardless of N and T:
 *
 *     sumTarget <= N * powLimit/(k*N) = powLimit/k
 *     t         <= sum_{i=1..N} i*ST  = (ST/T)*k
 *     => sumTarget * t <= (ST/T) * powLimit
 *
 * At mainnet's ST == 12T that is 12*powLimit == 2^247.6, leaving ~8 bits of
 * headroom. NOTE that the bound is only *sufficient* when
 * powLimit <= 2^256/(ST/T) (~2^252.4 at ST == 12T). Regtest's powLimit is
 * ~2^255 and does not satisfy it, which is why the multiply below is still
 * protected by an explicit, exact overflow check rather than by this argument
 * alone.
 *
 * Doing it the other way round -- the shape used by most published LWMA
 * reference implementations, `avgTarget * weightedSolvetime / k` -- multiplies
 * a ~2^244 value by something in the 10^5..10^7 range and silently wraps
 * modulo 2^256, because arith_uint256::operator*=(uint32_t) discards the carry
 * out of the top limb with no overflow detection.
 *
 * That is exactly the bug that produced the bogus 356x retarget at height 2016
 * on the live chain: CalculateNextWorkRequired() below does
 * `bnNew *= nActualTimespan` with bnNew == powLimit and nActualTimespan ==
 * 302400, a 2^262.2 product, which wrapped to a value whose compact form is
 * 0x1e0b7c33. Every node computed the same wrong answer and so consensus
 * agreed with itself. Do not reintroduce that shape here.
 *
 * pblock is deliberately not a parameter: nBits must depend only on ancestors.
 * If the candidate block's own timestamp fed the calculation a miner could
 * grind its timestamp within the future-time limit to lower its own difficulty.
 *
 * MONOTONIC TIMESTAMPS -- READ BEFORE EDITING.
 *
 * The window is read through a running maximum, not raw header timestamps, so
 * every solvetime is >= 0 by construction. This is a security requirement, not
 * a simplification.
 *
 * Consensus does not require a block's timestamp to exceed its parent's -- only
 * to exceed the parent's median-time-past (validation.cpp, "time-too-old"). A
 * miner may therefore legally backdate its OWN blocks to MTP+1. Against raw
 * solvetimes with an asymmetric clamp band [-FTL, +ST] that is a standing
 * subsidy: the backdated block's solvetime floors at -FTL while the honest
 * block behind it caps at +ST, so the pair reports (ST - FTL) seconds of
 * apparent time for roughly 2T seconds of real time. Repeated every block it
 * suppresses difficulty permanently and inflates emission -- simulated at
 * 1.31x emission for a single one of PCoin's seven miners and 2.09x at 50%
 * hashrate. Flooring solvetimes at zero instead does not help either: it lets
 * an attacker alternate a far-forward stamp (counted in full) with a backward
 * stamp (discarded) for the same effect.
 *
 * The running maximum defeats both. Apparent elapsed time over the window
 * telescopes to max(timestamps) - first, so it can never exceed real elapsed
 * time plus the one-off future-time allowance, no matter how the attacker
 * stamps. Backdating now only *withholds* apparent time, which makes the chain
 * look faster and raises the attacker's own difficulty.
 *
 * It does NOT reduce the subsidy to exactly zero, and the residual is worth
 * stating honestly. The weights are positional, so holding the running maximum
 * flat for a block defers that block's increment to the next, higher-weighted
 * index. In Abel form t = N*M_N - sum_{i<N} M_i, where M_N is pinned by real
 * time (honest miners stamp the real clock) and interior M_i can only be pushed
 * down. Suppressing m consecutive blocks and letting one honest block catch up
 * gives exactly t/k = 1 + m/(N+1) while (m+1)*T <= ST, so the easing is capped
 * at 1 + (ST/T - 1)/(N+1) == 1.18x -- and sustaining a run of m costs m/(m+1)
 * of the hashrate: 1.016x at 50%, 1.033x at 67%, the 1.18x peak only at 91.7%,
 * which is 1 - T/ST, the share that already permits the unbounded upward
 * ratchet below. Past m == ST/T - 1 the catch-up solvetime hits the ST clamp
 * and the withheld time is destroyed, so overreaching makes the chain harder.
 *
 * So the guarantee is "bounded and second-order", not "zero": against the raw-
 * solvetime 3.43x (unbounded in attacker share) it is at most 1.18x, and under
 * 2% at any share an attacker could realistically hold. pow_tests/
 * pcoin_lwma_backdating_never_pays asserts these exact bounds.
 *
 * On an all-honest chain (timestamps already increasing) the running maximum is
 * the identity, so this costs nothing: measured mean spacing, difficulty
 * variance and hashrate-loss recovery are bit-identical to the raw-solvetime
 * version.
 */
unsigned int LwmaGetNextWorkRequired(const CBlockIndex* pindexLast, const Consensus::Params& params)
{
    assert(pindexLast != nullptr);
    const arith_uint256 bnPowLimit = UintToArith256(params.powLimit);

    if (params.fPowNoRetargeting) return pindexLast->nBits;

    const int64_t N = params.nLwmaAveragingWindow;
    const int64_t T = params.nPowTargetSpacing;
    const int64_t ST = params.nLwmaMaxSolvetime; // == 12*T

    assert(N > 0 && T > 0 && ST >= T);

    // Insufficient history (test networks with very low activation heights).
    // Never fires on mainnet, where lwmaHeight is far above N.
    if (pindexLast->nHeight < N) return bnPowLimit.GetCompact();

    const int64_t k = N * (N + 1) * T / 2;
    const int64_t denom = k * N;
    assert(denom > 0 && denom <= std::numeric_limits<uint32_t>::max());

    // Collect the window newest -> oldest in one pprev walk (O(N), no
    // GetAncestor()). w[0] supplies a timestamp only; w[1..N] supply both a
    // timestamp and a target.
    std::vector<const CBlockIndex*> w(N + 1);
    const CBlockIndex* p = pindexLast;
    for (int64_t i = N; i >= 0; --i) {
        assert(p);
        w[i] = p;
        p = p->pprev;
    }

    arith_uint256 sumTarget = 0;
    int64_t t = 0;
    // Running maximum of the timestamps seen so far. Solvetimes are measured
    // against this rather than against the raw parent timestamp, so a backdated
    // block yields 0 instead of a large negative that a later block is paid to
    // "catch up" on. See the MONOTONIC TIMESTAMPS note above.
    int64_t prevTime = w[0]->GetBlockTime();
    for (int64_t i = 1; i <= N; ++i) {
        const int64_t rawTime = w[i]->GetBlockTime();
        const int64_t curTime = rawTime > prevTime ? rawTime : prevTime;
        int64_t solvetime = curTime - prevTime; // in [0, ST] after the clamp
        prevTime = curTime;
        if (solvetime > ST) solvetime = ST;
        t += solvetime * i;

        arith_uint256 target;
        target.SetCompact(w[i]->nBits); // <= powLimit by consensus (DeriveTarget)
        target /= arith_uint256(denom);
        sumTarget += target;
    }

    // Low clamp: caps the difficulty INCREASE at 3x per block. The +ST
    // per-solvetime clamp above caps the DECREASE at ST/T == 12x per block. The
    // asymmetry [/12 .. x3] is deliberate and biased toward liveness.
    //
    // ST is the parameter that decides whether a supermajority miner can ratchet
    // difficulty upward without bound: because apparent slowness saturates at
    // ST, a miner holding more than 1 - T/ST of the hashrate can stamp every
    // block at MTP+1 and drive difficulty up forever, permanently bricking the
    // chain. Raising ST from 6T to 12T moves that threshold from 83% to ~90%
    // hashrate; simulation also shows it cuts 99%-hashrate-loss recovery from
    // 10.3 to 6.2 days and reduces the Jensen emission bias from +0.42% to
    // +0.16%, at no measurable cost in difficulty variance. Raising the low
    // clamp instead does NOT help -- it only slows the ramp, leaving the
    // divergence threshold where it was.
    if (t < k / 3) t = k / 3;
    assert(t > 0 && t <= std::numeric_limits<uint32_t>::max());

    // Explicit overflow guard, checked rather than assumed.
    //
    // The (ST/T)*powLimit bound above is independent of N and T, but it only
    // fits in 256 bits when powLimit <= 2^256/(ST/T) (~2^252.4 at ST == 12T).
    // Mainnet's 2^244 has ~8 bits of headroom and can never reach this branch.
    // Regtest's powLimit is 7fffffff... (~2^255), where 12*powLimit is 2^259,
    // so a regtest chain
    // running LWMA (-testactivationheight=lwma@N -powretargeting) with slow
    // blocks genuinely can overflow.
    //
    // The test is exact: sumTarget * t overflows iff sumTarget > (2^256 - 1)/t.
    // Deriving the bound by a route independent of the multiply being checked
    // is deliberate -- PermittedDifficultyTransition failed to catch the
    // height-2016 bug precisely because it re-derived its bound with the same
    // overflowing expression.
    const arith_uint256 max_uint{~arith_uint256{0}};
    arith_uint256 bnNew;
    if (sumTarget > max_uint / arith_uint256(static_cast<uint64_t>(t))) {
        // Unreachable on mainnet. Failing to powLimit (the easiest possible
        // target) errs in the chain-stays-alive direction and is deterministic,
        // so nodes cannot disagree.
        bnNew = bnPowLimit;
    } else {
        bnNew = sumTarget * static_cast<uint32_t>(t);
    }

    if (bnNew > bnPowLimit) bnNew = bnPowLimit;
    // nBits encoding a zero target is rejected by DeriveTarget(), which would
    // make every subsequent block unmineable and permanently halt the chain.
    if (bnNew == 0) bnNew = arith_uint256(1);
    return bnNew.GetCompact();
}

unsigned int GetNextWorkRequired(const CBlockIndex* pindexLast, const CBlockHeader *pblock, const Consensus::Params& params)
{
    assert(pindexLast != nullptr);
    unsigned int nProofOfWorkLimit = UintToArith256(params.powLimit).GetCompact();

    // PCoin: LWMA applies to the block being validated, i.e. height
    // pindexLast->nHeight + 1.
    if (pindexLast->nHeight + 1 >= params.lwmaHeight) {
        return LwmaGetNextWorkRequired(pindexLast, params);
    }

    // ------------------------------------------------------------------
    // Legacy Bitcoin 2016-block retarget. DO NOT MODIFY, AND IN PARTICULAR DO
    // NOT FIX THE 256-BIT OVERFLOW IN CalculateNextWorkRequired() BELOW.
    //
    // Live PCoin blocks 2016..lwmaHeight-1 carry nBits == 0x1e0b7c33, a value
    // that is only reproducible with the wrapping arithmetic. validation.cpp
    // requires block.nBits == GetNextWorkRequired(...) exactly, so correcting
    // the arithmetic here would invalidate the chain from height 2016 and
    // orphan every coin mined since.
    // ------------------------------------------------------------------

    // Only change once per difficulty adjustment interval
    if ((pindexLast->nHeight+1) % params.DifficultyAdjustmentInterval() != 0)
    {
        if (params.fPowAllowMinDifficultyBlocks)
        {
            // Special difficulty rule for testnet:
            // If the new block's timestamp is more than 2* 10 minutes
            // then allow mining of a min-difficulty block.
            if (pblock->GetBlockTime() > pindexLast->GetBlockTime() + params.nPowTargetSpacing*2)
                return nProofOfWorkLimit;
            else
            {
                // Return the last non-special-min-difficulty-rules-block
                const CBlockIndex* pindex = pindexLast;
                while (pindex->pprev && pindex->nHeight % params.DifficultyAdjustmentInterval() != 0 && pindex->nBits == nProofOfWorkLimit)
                    pindex = pindex->pprev;
                return pindex->nBits;
            }
        }
        return pindexLast->nBits;
    }

    // Go back by what we want to be 14 days worth of blocks
    int nHeightFirst = pindexLast->nHeight - (params.DifficultyAdjustmentInterval()-1);
    assert(nHeightFirst >= 0);
    const CBlockIndex* pindexFirst = pindexLast->GetAncestor(nHeightFirst);
    assert(pindexFirst);

    return CalculateNextWorkRequired(pindexLast, pindexFirst->GetBlockTime(), params);
}

/**
 * Legacy (pre-lwmaHeight) retarget.
 *
 * WARNING: `bnNew *= nActualTimespan` below overflows arith_uint256 for every
 * PCoin retarget, because powLimit is 2^244 - 1 and nActualTimespan is clamped
 * into [302400, 4838400]. arith_uint256::operator*=(uint32_t) discards the
 * carry out of the top limb, so the result is computed mod 2^256. This is what
 * produced the 356x difficulty jump at height 2016 (0x1f0fffff -> 0x1e0b7c33)
 * instead of the expected 4x (0x1f03ffff).
 *
 * This is deliberately NOT fixed. The deployed chain's blocks 2016 onwards are
 * consensus-valid only under the wrapping arithmetic, and validation.cpp
 * requires an exact nBits match. Repairing it would orphan the live chain.
 * The fix is LwmaGetNextWorkRequired(), which replaces this function entirely
 * at and above params.lwmaHeight and is overflow-proof by construction.
 */
unsigned int CalculateNextWorkRequired(const CBlockIndex* pindexLast, int64_t nFirstBlockTime, const Consensus::Params& params)
{
    if (params.fPowNoRetargeting)
        return pindexLast->nBits;

    // Limit adjustment step
    int64_t nActualTimespan = pindexLast->GetBlockTime() - nFirstBlockTime;
    if (nActualTimespan < params.nPowTargetTimespan/4)
        nActualTimespan = params.nPowTargetTimespan/4;
    if (nActualTimespan > params.nPowTargetTimespan*4)
        nActualTimespan = params.nPowTargetTimespan*4;

    // Retarget
    const arith_uint256 bnPowLimit = UintToArith256(params.powLimit);
    arith_uint256 bnNew;

    // Special difficulty rule for Testnet4
    if (params.enforce_BIP94) {
        // Here we use the first block of the difficulty period. This way
        // the real difficulty is always preserved in the first block as
        // it is not allowed to use the min-difficulty exception.
        int nHeightFirst = pindexLast->nHeight - (params.DifficultyAdjustmentInterval()-1);
        const CBlockIndex* pindexFirst = pindexLast->GetAncestor(nHeightFirst);
        bnNew.SetCompact(pindexFirst->nBits);
    } else {
        bnNew.SetCompact(pindexLast->nBits);
    }

    bnNew *= nActualTimespan;
    bnNew /= params.nPowTargetTimespan;

    if (bnNew > bnPowLimit)
        bnNew = bnPowLimit;

    return bnNew.GetCompact();
}

// Check that on difficulty adjustments, the new difficulty does not increase
// or decrease beyond the permitted limits.
bool PermittedDifficultyTransition(const Consensus::Params& params, int64_t height, uint32_t old_nbits, uint32_t new_nbits)
{
    if (params.fPowAllowMinDifficultyBlocks) return true;

    // PCoin: under LWMA every block retargets, so neither the
    // "interval boundary, within 4x" branch nor the "must be unchanged"
    // branch below applies. Bounding an LWMA transition properly requires the
    // whole N-block window, which this function does not have, so accept.
    //
    // This is not a loss of safety relative to today: the legacy branch below
    // re-derives its bounds with the same overflowing expression it is meant to
    // police (`largest_difficulty_target *= largest_timespan`), so at PCoin's
    // powLimit it compares a corrupt observed value against an identically
    // corrupt bound and passes. It never caught the height-2016 event.
    //
    // The function is reached only from headerssync.cpp, i.e. the low-work
    // headers pre-sync path, which is itself inert while
    // nMinimumChainWork == 0.
    //
    // REQUIREMENT: nMinimumChainWork must stay zero while this returns true.
    // Setting it would enable headers pre-sync in exactly the regime where this
    // bound is absent, letting a peer feed unbounded cheap headers above the
    // activation height. A startup assert in kernel/chainparams.cpp enforces
    // this; before relaxing it, give this function a coarse bound that
    // headerssync can actually evaluate.
    if (height >= params.lwmaHeight) return true;

    if (height % params.DifficultyAdjustmentInterval() == 0) {
        int64_t smallest_timespan = params.nPowTargetTimespan/4;
        int64_t largest_timespan = params.nPowTargetTimespan*4;

        const arith_uint256 pow_limit = UintToArith256(params.powLimit);
        arith_uint256 observed_new_target;
        observed_new_target.SetCompact(new_nbits);

        // Calculate the largest difficulty value possible:
        arith_uint256 largest_difficulty_target;
        largest_difficulty_target.SetCompact(old_nbits);
        largest_difficulty_target *= largest_timespan;
        largest_difficulty_target /= params.nPowTargetTimespan;

        if (largest_difficulty_target > pow_limit) {
            largest_difficulty_target = pow_limit;
        }

        // Round and then compare this new calculated value to what is
        // observed.
        arith_uint256 maximum_new_target;
        maximum_new_target.SetCompact(largest_difficulty_target.GetCompact());
        if (maximum_new_target < observed_new_target) return false;

        // Calculate the smallest difficulty value possible:
        arith_uint256 smallest_difficulty_target;
        smallest_difficulty_target.SetCompact(old_nbits);
        smallest_difficulty_target *= smallest_timespan;
        smallest_difficulty_target /= params.nPowTargetTimespan;

        if (smallest_difficulty_target > pow_limit) {
            smallest_difficulty_target = pow_limit;
        }

        // Round and then compare this new calculated value to what is
        // observed.
        arith_uint256 minimum_new_target;
        minimum_new_target.SetCompact(smallest_difficulty_target.GetCompact());
        if (minimum_new_target > observed_new_target) return false;
    } else if (old_nbits != new_nbits) {
        return false;
    }
    return true;
}

// Bypasses the actual proof of work check during fuzz testing with a simplified validation checking whether
// the most significant bit of the last byte of the hash is set.
bool CheckProofOfWork(uint256 hash, unsigned int nBits, const Consensus::Params& params)
{
    if constexpr (G_FUZZING) return (hash.data()[31] & 0x80) == 0;
    return CheckProofOfWorkImpl(hash, nBits, params);
}

// PCoin consensus PoW check: RandomX hash of the serialized header vs target.
// The target logic (and its fuzzing bypass, keyed on the cheap block hash so
// fuzz harnesses that grind GetHash() keep working) mirrors CheckProofOfWork.
bool CheckProofOfWorkRandomX(const CBlockHeader& header, unsigned int nBits, const Consensus::Params& params)
{
    if constexpr (G_FUZZING) return (header.GetHash().data()[31] & 0x80) == 0;
    // Reject malformed/out-of-range nBits before paying for a RandomX hash
    // (light-mode hashing costs ~ms; this keeps garbage headers cheap).
    if (!DeriveTarget(nBits, params.powLimit)) return false;
    return CheckProofOfWorkImpl(RandomXPowHash(header), nBits, params);
}

std::optional<arith_uint256> DeriveTarget(unsigned int nBits, const uint256 pow_limit)
{
    bool fNegative;
    bool fOverflow;
    arith_uint256 bnTarget;

    bnTarget.SetCompact(nBits, &fNegative, &fOverflow);

    // Check range
    if (fNegative || bnTarget == 0 || fOverflow || bnTarget > UintToArith256(pow_limit))
        return {};

    return bnTarget;
}

bool CheckProofOfWorkImpl(uint256 hash, unsigned int nBits, const Consensus::Params& params)
{
    auto bnTarget{DeriveTarget(nBits, params.powLimit)};
    if (!bnTarget) return false;

    // Check proof of work matches claimed amount
    if (UintToArith256(hash) > bnTarget)
        return false;

    return true;
}
