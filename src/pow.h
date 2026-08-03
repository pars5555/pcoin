// Copyright (c) 2009-2010 Satoshi Nakamoto
// Copyright (c) 2009-2022 The Bitcoin Core developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.

#ifndef BITCOIN_POW_H
#define BITCOIN_POW_H

#include <consensus/params.h>

#include <stdint.h>

class CBlockHeader;
class CBlockIndex;
class uint256;
class arith_uint256;

/**
 * Convert nBits value to target.
 *
 * @param[in] nBits     compact representation of the target
 * @param[in] pow_limit PoW limit (consensus parameter)
 *
 * @return              the proof-of-work target or nullopt if the nBits value
 *                      is invalid (due to overflow or exceeding pow_limit)
 */
std::optional<arith_uint256> DeriveTarget(unsigned int nBits, const uint256 pow_limit);

unsigned int GetNextWorkRequired(const CBlockIndex* pindexLast, const CBlockHeader *pblock, const Consensus::Params&);
unsigned int CalculateNextWorkRequired(const CBlockIndex* pindexLast, int64_t nFirstBlockTime, const Consensus::Params&);

/**
 * PCoin: zawy12 LWMA-1 next-work calculation, used at and above
 * params.lwmaHeight. Retargets every block over a rolling window of
 * params.nLwmaAveragingWindow solvetimes, weighted linearly with the newest
 * solvetime carrying the largest weight.
 *
 * Depends only on ancestors of the block being mined (deliberately takes no
 * CBlockHeader), and is overflow-safe at PCoin's 2^244 powLimit by dividing
 * before multiplying -- see the comment on the definition in pow.cpp.
 *
 * Solvetimes are measured against a running maximum of the window's timestamps,
 * so they are never negative and a miner cannot manufacture apparent elapsed
 * time by backdating its own blocks. See the MONOTONIC TIMESTAMPS note in
 * pow.cpp before changing this.
 *
 * Per-block bounds relative to the window-average target A: the result lies in
 * [A/3, (nLwmaMaxSolvetime/nPowTargetSpacing)*A] == [A/3, 12A] on mainnet, then
 * clamped to (0, powLimit].
 */
unsigned int LwmaGetNextWorkRequired(const CBlockIndex* pindexLast, const Consensus::Params&);

/** Check whether a block hash satisfies the proof-of-work requirement specified by nBits */
bool CheckProofOfWork(uint256 hash, unsigned int nBits, const Consensus::Params&);
bool CheckProofOfWorkImpl(uint256 hash, unsigned int nBits, const Consensus::Params&);

/**
 * PCoin: check whether a block header satisfies the RandomX proof-of-work
 * requirement specified by nBits.
 *
 * The proof-of-work statement is: RandomXPowHash(80-byte serialized header),
 * interpreted as a little-endian 256-bit integer, must be <= the target
 * encoded in nBits. The block id (CBlockHeader::GetHash(), double-SHA256) is
 * intentionally NOT the PoW hash; consensus validation must call this
 * function, not the hash-based CheckProofOfWork() above (which is retained
 * for tests and tools that reason about raw hashes).
 */
bool CheckProofOfWorkRandomX(const CBlockHeader& header, unsigned int nBits, const Consensus::Params&);

/**
 * Return false if the proof-of-work requirement specified by new_nbits at a
 * given height is not possible, given the proof-of-work on the prior block as
 * specified by old_nbits.
 *
 * This function only checks that the new value is within a factor of 4 of the
 * old value for blocks at the difficulty adjustment interval, and otherwise
 * requires the values to be the same.
 *
 * Always returns true on networks where min difficulty blocks are allowed,
 * such as regtest/testnet, and always returns true at heights >=
 * params.lwmaHeight, where every block legitimately retargets and bounding the
 * transition would require the full LWMA window.
 */
bool PermittedDifficultyTransition(const Consensus::Params& params, int64_t height, uint32_t old_nbits, uint32_t new_nbits);

#endif // BITCOIN_POW_H
