// Copyright (c) 2026 The PCoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.

#ifndef BITCOIN_CRYPTO_POW_RANDOMX_H
#define BITCOIN_CRYPTO_POW_RANDOMX_H

#include <uint256.h>

#include <string>

class CBlockHeader;

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

#endif // BITCOIN_CRYPTO_POW_RANDOMX_H
