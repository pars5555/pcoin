// Copyright (c) 2015-2022 The Bitcoin Core developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.

#include <chain.h>
#include <chainparams.h>
#include <pow.h>
#include <test/util/random.h>
#include <test/util/setup_common.h>
#include <util/chaintype.h>

#include <boost/test/unit_test.hpp>

#include <algorithm>
#include <limits>
#include <vector>

BOOST_FIXTURE_TEST_SUITE(pow_tests, BasicTestingSetup)

/* Test calculation of next difficulty target with no constraints applying */
BOOST_AUTO_TEST_CASE(get_next_work)
{
    const auto chainParams = CreateChainParams(*m_node.args, ChainType::MAIN);
    int64_t nLastRetargetTime = 1261130161; // Block #30240
    CBlockIndex pindexLast;
    pindexLast.nHeight = 32255;
    pindexLast.nTime = 1262152739;  // Block #32255
    pindexLast.nBits = 0x1d00ffff;

    // Here (and below): expected_nbits is calculated in
    // CalculateNextWorkRequired(); redoing the calculation here would be just
    // reimplementing the same code that is written in pow.cpp. Rather than
    // copy that code, we just hardcode the expected result.
    unsigned int expected_nbits = 0x1d00d86aU;
    BOOST_CHECK_EQUAL(CalculateNextWorkRequired(&pindexLast, nLastRetargetTime, chainParams->GetConsensus()), expected_nbits);
    BOOST_CHECK(PermittedDifficultyTransition(chainParams->GetConsensus(), pindexLast.nHeight+1, pindexLast.nBits, expected_nbits));
}

/* Test the constraint on the upper bound for next work.
 *
 * PCoin: upstream expects 0x1d00ffff here because on Bitcoin that value IS
 * powLimit, so the result gets clamped. PCoin's powLimit is 000fffff...
 * (2^244 - 1), far above Bitcoin's 2^224, so no clamp occurs and the raw
 * retarget value comes through. This is a consequence of the raised powLimit,
 * not of the LWMA change. */
BOOST_AUTO_TEST_CASE(get_next_work_pow_limit)
{
    const auto chainParams = CreateChainParams(*m_node.args, ChainType::MAIN);
    int64_t nLastRetargetTime = 1231006505; // Block #0
    CBlockIndex pindexLast;
    pindexLast.nHeight = 2015;
    pindexLast.nTime = 1233061996;  // Block #2015
    pindexLast.nBits = 0x1d00ffff;
    unsigned int expected_nbits = 0x1d01b304U;
    BOOST_CHECK_EQUAL(CalculateNextWorkRequired(&pindexLast, nLastRetargetTime, chainParams->GetConsensus()), expected_nbits);
    // The clamp that does apply on PCoin is at PCoin's own powLimit.
    {
        const arith_uint256 pow_limit{UintToArith256(chainParams->GetConsensus().powLimit)};
        CBlockIndex atLimit;
        atLimit.nHeight = 2015;
        atLimit.nTime = 1233061996;
        atLimit.nBits = pow_limit.GetCompact();
        arith_uint256 result;
        result.SetCompact(CalculateNextWorkRequired(&atLimit, nLastRetargetTime, chainParams->GetConsensus()));
        BOOST_CHECK(result <= pow_limit);
    }
}

/* Test the constraint on the lower bound for actual time taken */
BOOST_AUTO_TEST_CASE(get_next_work_lower_limit_actual)
{
    const auto chainParams = CreateChainParams(*m_node.args, ChainType::MAIN);
    int64_t nLastRetargetTime = 1279008237; // Block #66528
    CBlockIndex pindexLast;
    pindexLast.nHeight = 68543;
    pindexLast.nTime = 1279297671;  // Block #68543
    pindexLast.nBits = 0x1c05a3f4;
    unsigned int expected_nbits = 0x1c0168fdU;
    BOOST_CHECK_EQUAL(CalculateNextWorkRequired(&pindexLast, nLastRetargetTime, chainParams->GetConsensus()), expected_nbits);
    // PCoin: these heights come from Bitcoin's chain and sit above PCoin's
    // lwmaHeight, where PermittedDifficultyTransition accepts everything
    // because every block retargets. Pin the legacy semantics explicitly by
    // disabling LWMA in a local copy of the params.
    Consensus::Params legacy{chainParams->GetConsensus()};
    legacy.lwmaHeight = std::numeric_limits<int>::max();
    BOOST_CHECK(PermittedDifficultyTransition(legacy, pindexLast.nHeight+1, pindexLast.nBits, expected_nbits));
    // Test that reducing nbits further would not be a PermittedDifficultyTransition.
    unsigned int invalid_nbits = expected_nbits-1;
    BOOST_CHECK(!PermittedDifficultyTransition(legacy, pindexLast.nHeight+1, pindexLast.nBits, invalid_nbits));
}

/* Test the constraint on the upper bound for actual time taken */
BOOST_AUTO_TEST_CASE(get_next_work_upper_limit_actual)
{
    const auto chainParams = CreateChainParams(*m_node.args, ChainType::MAIN);
    int64_t nLastRetargetTime = 1263163443; // NOTE: Not an actual block time
    CBlockIndex pindexLast;
    pindexLast.nHeight = 46367;
    pindexLast.nTime = 1269211443;  // Block #46367
    pindexLast.nBits = 0x1c387f6f;
    unsigned int expected_nbits = 0x1d00e1fdU;
    BOOST_CHECK_EQUAL(CalculateNextWorkRequired(&pindexLast, nLastRetargetTime, chainParams->GetConsensus()), expected_nbits);
    // PCoin: see the note in get_next_work_lower_limit_actual.
    Consensus::Params legacy{chainParams->GetConsensus()};
    legacy.lwmaHeight = std::numeric_limits<int>::max();
    BOOST_CHECK(PermittedDifficultyTransition(legacy, pindexLast.nHeight+1, pindexLast.nBits, expected_nbits));
    // Test that increasing nbits further would not be a PermittedDifficultyTransition.
    unsigned int invalid_nbits = expected_nbits+1;
    BOOST_CHECK(!PermittedDifficultyTransition(legacy, pindexLast.nHeight+1, pindexLast.nBits, invalid_nbits));
}

BOOST_AUTO_TEST_CASE(CheckProofOfWork_test_negative_target)
{
    const auto consensus = CreateChainParams(*m_node.args, ChainType::MAIN)->GetConsensus();
    uint256 hash;
    unsigned int nBits;
    nBits = UintToArith256(consensus.powLimit).GetCompact(true);
    hash = uint256{1};
    BOOST_CHECK(!CheckProofOfWork(hash, nBits, consensus));
}

BOOST_AUTO_TEST_CASE(CheckProofOfWork_test_overflow_target)
{
    const auto consensus = CreateChainParams(*m_node.args, ChainType::MAIN)->GetConsensus();
    uint256 hash;
    unsigned int nBits{~0x00800000U};
    hash = uint256{1};
    BOOST_CHECK(!CheckProofOfWork(hash, nBits, consensus));
}

BOOST_AUTO_TEST_CASE(CheckProofOfWork_test_too_easy_target)
{
    const auto consensus = CreateChainParams(*m_node.args, ChainType::MAIN)->GetConsensus();
    uint256 hash;
    unsigned int nBits;
    arith_uint256 nBits_arith = UintToArith256(consensus.powLimit);
    nBits_arith *= 2;
    nBits = nBits_arith.GetCompact();
    hash = uint256{1};
    BOOST_CHECK(!CheckProofOfWork(hash, nBits, consensus));
}

BOOST_AUTO_TEST_CASE(CheckProofOfWork_test_biger_hash_than_target)
{
    const auto consensus = CreateChainParams(*m_node.args, ChainType::MAIN)->GetConsensus();
    uint256 hash;
    unsigned int nBits;
    arith_uint256 hash_arith = UintToArith256(consensus.powLimit);
    nBits = hash_arith.GetCompact();
    hash_arith *= 2; // hash > nBits
    hash = ArithToUint256(hash_arith);
    BOOST_CHECK(!CheckProofOfWork(hash, nBits, consensus));
}

BOOST_AUTO_TEST_CASE(CheckProofOfWork_test_zero_target)
{
    const auto consensus = CreateChainParams(*m_node.args, ChainType::MAIN)->GetConsensus();
    uint256 hash;
    unsigned int nBits;
    arith_uint256 hash_arith{0};
    nBits = hash_arith.GetCompact();
    hash = ArithToUint256(hash_arith);
    BOOST_CHECK(!CheckProofOfWork(hash, nBits, consensus));
}

BOOST_AUTO_TEST_CASE(GetBlockProofEquivalentTime_test)
{
    const auto chainParams = CreateChainParams(*m_node.args, ChainType::MAIN);
    std::vector<CBlockIndex> blocks(10000);
    for (int i = 0; i < 10000; i++) {
        blocks[i].pprev = i ? &blocks[i - 1] : nullptr;
        blocks[i].nHeight = i;
        blocks[i].nTime = 1269211443 + i * chainParams->GetConsensus().nPowTargetSpacing;
        blocks[i].nBits = 0x207fffff; /* target 0x7fffff000... */
        blocks[i].nChainWork = i ? blocks[i - 1].nChainWork + GetBlockProof(blocks[i - 1]) : arith_uint256(0);
    }

    for (int j = 0; j < 1000; j++) {
        CBlockIndex *p1 = &blocks[m_rng.randrange(10000)];
        CBlockIndex *p2 = &blocks[m_rng.randrange(10000)];
        CBlockIndex *p3 = &blocks[m_rng.randrange(10000)];

        int64_t tdiff = GetBlockProofEquivalentTime(*p1, *p2, *p3, chainParams->GetConsensus());
        BOOST_CHECK_EQUAL(tdiff, p1->GetBlockTime() - p2->GetBlockTime());
    }
}

void sanity_check_chainparams(const ArgsManager& args, ChainType chain_type)
{
    const auto chainParams = CreateChainParams(args, chain_type);
    const auto consensus = chainParams->GetConsensus();

    // hash genesis is correct
    BOOST_CHECK_EQUAL(consensus.hashGenesisBlock, chainParams->GenesisBlock().GetHash());

    // target timespan is an even multiple of spacing
    BOOST_CHECK_EQUAL(consensus.nPowTargetTimespan % consensus.nPowTargetSpacing, 0);

    // genesis nBits is positive, doesn't overflow and is lower than powLimit
    arith_uint256 pow_compact;
    bool neg, over;
    pow_compact.SetCompact(chainParams->GenesisBlock().nBits, &neg, &over);
    BOOST_CHECK(!neg && pow_compact != 0);
    BOOST_CHECK(!over);
    BOOST_CHECK(UintToArith256(consensus.powLimit) >= pow_compact);

    const arith_uint256 pow_limit{UintToArith256(consensus.powLimit)};
    const arith_uint256 max_uint{UintToArith256(uint256{"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"})};

    // PCoin: upstream Bitcoin asserts here that powLimit * 4*nPowTargetTimespan
    // does not overflow, i.e. that CalculateNextWorkRequired() is safe. PCoin's
    // powLimit is 000fffff... (2^244 - 1) rather than Bitcoin's 2^224, so that
    // invariant is FALSE on every PCoin network and the legacy retarget really
    // does wrap modulo 2^256. That is the root cause of the height-2016
    // anomaly, and it is preserved deliberately below consensus.lwmaHeight so
    // the deployed chain remains valid (see pow.cpp). Assert the true state of
    // affairs so nobody "fixes" this test by fixing the chain out from under
    // itself.
    if (!consensus.fPowNoRetargeting) {
        arith_uint256 legacy_safe_max{max_uint};
        legacy_safe_max /= consensus.nPowTargetTimespan * 4;
        BOOST_CHECK_MESSAGE(pow_limit > legacy_safe_max,
                            "legacy retarget is expected to overflow at PCoin's powLimit");
    }

    // The bound that protects the chain from lwmaHeight onwards:
    // LwmaGetNextWorkRequired()'s product is at most (ST/T)*powLimit, for any N
    // and T, because it divides by k*N inside the accumulation loop. That only
    // fits in 256 bits when powLimit <= 2^256/(ST/T), which holds on every
    // network that ships LWMA enabled. Regtest's powLimit is 7fffffff...
    // (~2^255) and does NOT satisfy it, which is why LwmaGetNextWorkRequired()
    // carries an explicit overflow guard instead of relying on the bound alone
    // -- see pcoin_lwma_overflow_guard.
    if (consensus.lwmaHeight != std::numeric_limits<int>::max()) {
        const int64_t st_ratio{consensus.nLwmaMaxSolvetime / consensus.nPowTargetSpacing};
        BOOST_CHECK(pow_limit <= max_uint / arith_uint256(static_cast<uint64_t>(st_ratio)));
    }

    // LWMA parameter invariants.
    const int64_t N{consensus.nLwmaAveragingWindow};
    const int64_t T{consensus.nPowTargetSpacing};
    BOOST_CHECK(N > 0);
    BOOST_CHECK_EQUAL(consensus.nLwmaMaxSolvetime, 12 * T);
    // The tightened future-time limit is gated on lwmaHeight, so it must be
    // strictly below the global one or the gate would be a no-op, and it must
    // be positive or no block could ever be accepted.
    BOOST_CHECK(consensus.nLwmaMaxFutureBlockTime > 0);
    BOOST_CHECK(consensus.nLwmaMaxFutureBlockTime <= MAX_FUTURE_BLOCK_TIME);
    BOOST_CHECK_EQUAL(consensus.nLwmaMaxFutureBlockTime, LWMA_MAX_FUTURE_BLOCK_TIME);
    // denom = k*N must fit in uint32 so the final multiply can use the
    // uint32_t overload.
    const int64_t k{N * (N + 1) * T / 2};
    BOOST_CHECK(k > 0);
    BOOST_CHECK(k * N > 0);
    BOOST_CHECK(k * N <= int64_t{std::numeric_limits<uint32_t>::max()});
    // t <= (ST/T)*k must also fit in uint32.
    BOOST_CHECK((consensus.nLwmaMaxSolvetime / T) * k <= int64_t{std::numeric_limits<uint32_t>::max()});
    // A min-difficulty escape hatch would inject powLimit into the averaging
    // window and collapse difficulty for N blocks; the two rules cannot coexist.
    if (consensus.lwmaHeight != std::numeric_limits<int>::max()) {
        BOOST_CHECK(!consensus.fPowAllowMinDifficultyBlocks);
    }
}

BOOST_AUTO_TEST_CASE(ChainParams_MAIN_sanity)
{
    sanity_check_chainparams(*m_node.args, ChainType::MAIN);
}

BOOST_AUTO_TEST_CASE(ChainParams_REGTEST_sanity)
{
    sanity_check_chainparams(*m_node.args, ChainType::REGTEST);
}

BOOST_AUTO_TEST_CASE(ChainParams_TESTNET_sanity)
{
    sanity_check_chainparams(*m_node.args, ChainType::TESTNET);
}

BOOST_AUTO_TEST_CASE(ChainParams_TESTNET4_sanity)
{
    sanity_check_chainparams(*m_node.args, ChainType::TESTNET4);
}

BOOST_AUTO_TEST_CASE(ChainParams_SIGNET_sanity)
{
    sanity_check_chainparams(*m_node.args, ChainType::SIGNET);
}

// ===========================================================================
// PCoin: LWMA difficulty algorithm
// ===========================================================================

namespace {

//! Build a chain of block indexes. Heights are 0..times.size()-1. The returned
//! vector is sized up front so the pprev pointers into it stay valid, and a
//! vector move transfers the same heap buffer.
std::vector<CBlockIndex> MakeChain(const std::vector<int64_t>& times, const std::vector<uint32_t>& bits)
{
    assert(times.size() == bits.size());
    std::vector<CBlockIndex> blocks(times.size());
    for (size_t i = 0; i < times.size(); ++i) {
        blocks[i].pprev = i ? &blocks[i - 1] : nullptr;
        blocks[i].nHeight = static_cast<int>(i);
        blocks[i].nTime = static_cast<uint32_t>(times[i]);
        blocks[i].nBits = bits[i];
    }
    return blocks;
}

//! A window of N solvetimes at constant nBits, starting from a fixed epoch.
std::vector<CBlockIndex> UniformWindow(int64_t N, int64_t solvetime, uint32_t bits, int64_t t0 = 1785700000)
{
    std::vector<int64_t> times;
    std::vector<uint32_t> bitsv;
    int64_t t = t0;
    for (int64_t i = 0; i <= N; ++i) {
        times.push_back(t);
        bitsv.push_back(bits);
        t += solvetime;
    }
    return MakeChain(times, bitsv);
}

std::vector<CBlockIndex> WindowFromSolvetimes(const std::vector<int64_t>& dts, uint32_t bits, int64_t t0 = 1785700000)
{
    std::vector<int64_t> times{t0};
    std::vector<uint32_t> bitsv{bits};
    for (int64_t d : dts) {
        times.push_back(times.back() + d);
        bitsv.push_back(bits);
    }
    return MakeChain(times, bitsv);
}

arith_uint256 TargetOf(uint32_t nbits)
{
    arith_uint256 t;
    t.SetCompact(nbits);
    return t;
}

//! Ratio of two compact targets, as a double (for readable assertions).
double TargetRatio(uint32_t a, uint32_t b)
{
    return TargetOf(a).getdouble() / TargetOf(b).getdouble();
}

Consensus::Params LwmaParams(const Consensus::Params& base, int64_t N = 60, int64_t T = 600, int lwma_height = 0)
{
    Consensus::Params p{base};
    p.lwmaHeight = lwma_height;
    p.nLwmaAveragingWindow = N;
    p.nPowTargetSpacing = T;
    p.nLwmaMaxSolvetime = 12 * T;
    p.nLwmaMaxFutureBlockTime = LWMA_MAX_FUTURE_BLOCK_TIME;
    p.fPowNoRetargeting = false;
    p.fPowAllowMinDifficultyBlocks = false;
    return p;
}

constexpr uint32_t TIP_BITS{0x1e0b7c33U}; // the live chain's nBits since height 2016

} // namespace

/**
 * REGRESSION LOCK. Reproduces the 256-bit overflow that produced the bogus 356x
 * retarget at mainnet height 2016.
 *
 * pindexLast = height 2015, nTime 1785700177, nBits 1f0fffff
 * pindexFirst = genesis,    nTime 1785600628
 * nActualTimespan = 99549, clamped up to nPowTargetTimespan/4 = 302400.
 * powLimit * 302400 is a 263-bit product; arith_uint256 wraps it modulo 2^256.
 *
 * The correct (non-overflowing) answer would have been 0x1f03ffff, an exact 4x.
 * THE LIVE CHAIN DEPENDS ON THIS EXACT WRONG VALUE. validation.cpp requires
 * block.nBits == GetNextWorkRequired(...) exactly, so "fixing" this would
 * invalidate every block from height 2016 onwards. DO NOT FIX.
 */
BOOST_AUTO_TEST_CASE(pcoin_legacy_overflow_golden_vector)
{
    const auto chainParams = CreateChainParams(*m_node.args, ChainType::MAIN);
    const auto& consensus = chainParams->GetConsensus();

    CBlockIndex pindexLast;
    pindexLast.nHeight = 2015;
    pindexLast.nTime = 1785700177;
    pindexLast.nBits = 0x1f0fffffU;

    BOOST_CHECK_EQUAL(CalculateNextWorkRequired(&pindexLast, 1785600628, consensus), 0x1e0b7c33U);

    // Demonstrate that this is an overflow and not a legitimate 4x: the clamp
    // fired (99549 -> 302400), and the non-wrapping product / 1209600 is
    // exactly 4x the old target.
    arith_uint256 correct;
    correct.SetCompact(0x1f0fffffU);
    correct /= consensus.nPowTargetTimespan; // divide first to avoid the overflow
    correct *= 302400;
    BOOST_CHECK_EQUAL(correct.GetCompact(), 0x1f03ffffU);
    BOOST_CHECK(TargetOf(0x1e0b7c33U) < TargetOf(0x1f03ffffU));
}

//! LWMA activates on the height of the block being validated, not of pindexLast.
BOOST_AUTO_TEST_CASE(pcoin_lwma_activation_boundary)
{
    const auto chainParams = CreateChainParams(*m_node.args, ChainType::MAIN);
    const auto& consensus = chainParams->GetConsensus();
    const int H{consensus.lwmaHeight};
    BOOST_CHECK_EQUAL(H, 2800);

    // Mainnet requirement: the first LWMA window must sit entirely above the
    // height-2016 target discontinuity, or it would average 1f0fffff targets
    // (2^244) with 1e0b7c33 ones (2^235.5).
    BOOST_CHECK(H > 2016 + consensus.nLwmaAveragingWindow);
    // And it must land before height 4032, the next legacy retarget, which
    // overflows again and in the wrong direction.
    BOOST_CHECK(H < 4032);

    // Build a chain up to height H at the live chain's current pace (1317 s),
    // all carrying the live nBits.
    std::vector<int64_t> times;
    std::vector<uint32_t> bits;
    for (int i = 0; i <= H; ++i) {
        times.push_back(1785600628 + int64_t{i} * 1317);
        bits.push_back(TIP_BITS);
    }
    auto blocks = MakeChain(times, bits);

    // Heights H-2 and H-1 take the legacy path. Neither is a 2016-multiple, so
    // the legacy rule returns nBits unchanged.
    BOOST_CHECK_EQUAL(GetNextWorkRequired(&blocks[H - 3], nullptr, consensus), TIP_BITS);
    BOOST_CHECK_EQUAL(GetNextWorkRequired(&blocks[H - 2], nullptr, consensus), TIP_BITS);

    // Height H takes the LWMA path and must differ.
    const unsigned int at_H{GetNextWorkRequired(&blocks[H - 1], nullptr, consensus)};
    BOOST_CHECK_EQUAL(at_H, LwmaGetNextWorkRequired(&blocks[H - 1], consensus));
    BOOST_CHECK(at_H != TIP_BITS);

    // The announced one-off correction: ~2.2x easier target (difficulty ~x0.46),
    // because the chain is running at 1317 s against a 600 s target.
    BOOST_CHECK_EQUAL(at_H, 0x1e1935bcU);
    BOOST_CHECK_CLOSE(TargetRatio(at_H, TIP_BITS), 2.195, 0.5);
    // Well inside the per-block [/6, x3] difficulty bounds.
    BOOST_CHECK(TargetRatio(at_H, TIP_BITS) < 6.0);

    // Height H+1 also LWMA.
    BOOST_CHECK_EQUAL(GetNextWorkRequired(&blocks[H], nullptr, consensus),
                      LwmaGetNextWorkRequired(&blocks[H], consensus));
}

//! The single most important invariant: a window that ran at exactly T leaves
//! difficulty unchanged (modulo compact-encoding truncation).
BOOST_AUTO_TEST_CASE(pcoin_lwma_steady_state)
{
    const auto chainParams = CreateChainParams(*m_node.args, ChainType::MAIN);
    const auto params = LwmaParams(chainParams->GetConsensus());
    const int64_t N{params.nLwmaAveragingWindow};

    for (const uint32_t b : {0x1f0fffffU, TIP_BITS, 0x1d00ffffU, 0x1c05a3f4U}) {
        auto blocks = UniformWindow(N, params.nPowTargetSpacing, b);
        const unsigned int out{LwmaGetNextWorkRequired(&blocks[N], params)};
        // Equal to within one unit in the last place of the compact mantissa.
        BOOST_CHECK_CLOSE(TargetRatio(out, b), 1.0, 0.01);
        BOOST_CHECK(out == b || out == b - 1);
    }
    // Exact expected values from the reference model.
    {
        auto blocks = UniformWindow(N, params.nPowTargetSpacing, TIP_BITS);
        BOOST_CHECK_EQUAL(LwmaGetNextWorkRequired(&blocks[N], params), 0x1e0b7c32U);
    }
}

//! Per-solvetime clamp at +ST caps the difficulty decrease at ST/T == 12x; the
//! k/3 low clamp on the weighted sum caps the increase at 3x. There is no
//! negative clamp: the running maximum makes solvetimes non-negative.
BOOST_AUTO_TEST_CASE(pcoin_lwma_clamps)
{
    const auto chainParams = CreateChainParams(*m_node.args, ChainType::MAIN);
    const auto params = LwmaParams(chainParams->GetConsensus());
    const int64_t N{params.nLwmaAveragingWindow};
    const int64_t T{params.nPowTargetSpacing};
    const int64_t ST{params.nLwmaMaxSolvetime};
    const int64_t FTL{params.nLwmaMaxFutureBlockTime};
    BOOST_CHECK_EQUAL(ST, 12 * T);

    // All solvetimes +ST -> target x12 (difficulty /12), the maximum easing.
    {
        auto blocks = UniformWindow(N, ST, TIP_BITS);
        const unsigned int out{LwmaGetNextWorkRequired(&blocks[N], params)};
        BOOST_CHECK_EQUAL(out, 0x1f0089d2U);
        BOOST_CHECK_CLOSE(TargetRatio(out, TIP_BITS), 12.0, 0.01);
    }
    // 6T is now inside the clamp band and passes through unmodified.
    {
        auto blocks = UniformWindow(N, 6 * T, TIP_BITS);
        const unsigned int out{LwmaGetNextWorkRequired(&blocks[N], params)};
        BOOST_CHECK_EQUAL(out, 0x1e44e931U);
        BOOST_CHECK_CLOSE(TargetRatio(out, TIP_BITS), 6.0, 0.01);
    }
    // All timestamps going backwards -> every solvetime reads 0 through the
    // running maximum -> low clamp binds -> target /3, the maximum hardening.
    // Backdating is punished, not rewarded.
    {
        auto blocks = UniformWindow(N, -FTL, TIP_BITS, 1785800000);
        const unsigned int out{LwmaGetNextWorkRequired(&blocks[N], params)};
        BOOST_CHECK_EQUAL(out, 0x1e03d410U);
        BOOST_CHECK_CLOSE(TargetRatio(out, TIP_BITS), 1.0 / 3.0, 0.01);
    }
    // Saturation: anything beyond the clamp behaves identically to the clamp.
    {
        auto a = UniformWindow(N, 100 * T, TIP_BITS);
        auto b = UniformWindow(N, ST, TIP_BITS);
        BOOST_CHECK_EQUAL(LwmaGetNextWorkRequired(&a[N], params),
                          LwmaGetNextWorkRequired(&b[N], params));
    }
    // Any amount of backdating collapses to the same "no apparent time" result.
    {
        auto a = UniformWindow(N, -10 * FTL, TIP_BITS, 1786500000);
        auto b = UniformWindow(N, -FTL, TIP_BITS, 1785800000);
        auto c = UniformWindow(N, 0, TIP_BITS);
        BOOST_CHECK_EQUAL(LwmaGetNextWorkRequired(&a[N], params),
                          LwmaGetNextWorkRequired(&b[N], params));
        BOOST_CHECK_EQUAL(LwmaGetNextWorkRequired(&a[N], params),
                          LwmaGetNextWorkRequired(&c[N], params));
    }
    // Single-block leverage, the dominant adversarial parameter with 7 miners.
    {
        std::vector<int64_t> dts(N, T);
        auto base = WindowFromSolvetimes(dts, TIP_BITS);
        const unsigned int o0{LwmaGetNextWorkRequired(&base[N], params)};

        dts.back() = ST; // newest solvetime maximally stamped forward
        auto hi = WindowFromSolvetimes(dts, TIP_BITS);
        BOOST_CHECK_CLOSE(TargetRatio(LwmaGetNextWorkRequired(&hi[N], params), o0), 1.3607, 0.1);

        dts.back() = -FTL; // newest block backdated: reads as 0, i.e. HARDER
        auto lo = WindowFromSolvetimes(dts, TIP_BITS);
        BOOST_CHECK_CLOSE(TargetRatio(LwmaGetNextWorkRequired(&lo[N], params), o0), 0.9672, 0.1);
    }
}

//! Response to step changes in hashrate.
BOOST_AUTO_TEST_CASE(pcoin_lwma_hashrate_steps)
{
    const auto chainParams = CreateChainParams(*m_node.args, ChainType::MAIN);
    const auto params = LwmaParams(chainParams->GetConsensus());
    const int64_t N{params.nLwmaAveragingWindow};

    // 10x hashrate DROP: solvetimes go to 6000 s, inside the 7200 s clamp, so
    // the easing is the full 10x on the very next block -- exactly the
    // behaviour that makes death-spiral recovery fast. (At the old ST == 6T
    // this saturated at 6x, which is what made recovery slower.)
    {
        auto blocks = UniformWindow(N, 6000, TIP_BITS);
        const unsigned int out{LwmaGetNextWorkRequired(&blocks[N], params)};
        BOOST_CHECK(TargetOf(out) > TargetOf(TIP_BITS)); // easier
        BOOST_CHECK_EQUAL(out, 0x1e72d9fdU);
        BOOST_CHECK_CLOSE(TargetRatio(out, TIP_BITS), 10.0, 0.01);
    }
    // 100x drop saturates at the ST clamp, i.e. 12x per block.
    {
        auto blocks = UniformWindow(N, 60000, TIP_BITS);
        const unsigned int out{LwmaGetNextWorkRequired(&blocks[N], params)};
        BOOST_CHECK_CLOSE(TargetRatio(out, TIP_BITS), 12.0, 0.01);
    }
    // 10x hashrate RISE: solvetimes go to 60 s, low clamp binds at 3x harder.
    {
        auto blocks = UniformWindow(N, 60, TIP_BITS);
        const unsigned int out{LwmaGetNextWorkRequired(&blocks[N], params)};
        BOOST_CHECK(TargetOf(out) < TargetOf(TIP_BITS)); // harder
        BOOST_CHECK_CLOSE(TargetRatio(out, TIP_BITS), 1.0 / 3.0, 0.01);
    }
    // The first correction arrives on the very next block: one slow block
    // already moves difficulty, unlike the 2016-block rule which cannot respond
    // for an entire period.
    {
        std::vector<int64_t> dts(N, params.nPowTargetSpacing);
        auto flat = WindowFromSolvetimes(dts, TIP_BITS);
        dts.back() = 6 * params.nPowTargetSpacing;
        auto one_slow = WindowFromSolvetimes(dts, TIP_BITS);
        BOOST_CHECK(TargetOf(LwmaGetNextWorkRequired(&one_slow[N], params)) >
                    TargetOf(LwmaGetNextWorkRequired(&flat[N], params)));
    }
}

/**
 * Closed-loop convergence: simulate a chain whose hashrate steps by 10x and
 * check that LWMA drives the solvetime back to T. This is the property the
 * 2016-block rule cannot deliver (189 days vs ~32 hours for a 10x drop).
 */
BOOST_AUTO_TEST_CASE(pcoin_lwma_convergence)
{
    const auto chainParams = CreateChainParams(*m_node.args, ChainType::MAIN);
    const auto params = LwmaParams(chainParams->GetConsensus());
    const int64_t N{params.nLwmaAveragingWindow};
    const int64_t T{params.nPowTargetSpacing};

    for (const double hashrate_factor : {0.1, 0.5, 2.0, 10.0, 100.0}) {
        // Seed a window that is in equilibrium at the reference hashrate.
        std::vector<int64_t> times;
        std::vector<uint32_t> bits;
        for (int64_t i = 0; i <= N; ++i) {
            times.push_back(1785700000 + i * T);
            bits.push_back(TIP_BITS);
        }
        const double ref_target{TargetOf(TIP_BITS).getdouble()};

        // Then run 300 blocks at the new hashrate. Solvetime is deterministic
        // (no Poisson noise) so the test is stable: solvetime = T *
        // (ref_target/target) / factor.
        for (int step = 0; step < 300; ++step) {
            auto chain = MakeChain(times, bits);
            const unsigned int nb{LwmaGetNextWorkRequired(&chain[chain.size() - 1], params)};
            const double target{TargetOf(nb).getdouble()};
            int64_t solvetime{static_cast<int64_t>(T * (ref_target / target) / hashrate_factor)};
            solvetime = std::clamp<int64_t>(solvetime, 1, 200 * T);
            times.push_back(times.back() + solvetime);
            bits.push_back(nb);
            // Never degenerate.
            BOOST_CHECK(TargetOf(nb) > arith_uint256{0});
            BOOST_CHECK(TargetOf(nb) <= UintToArith256(params.powLimit));
        }

        // Measure the achieved pace over the last N blocks.
        const int64_t span{times.back() - times[times.size() - 1 - N]};
        const double mean_solvetime{static_cast<double>(span) / N};
        BOOST_CHECK_MESSAGE(mean_solvetime > 0.7 * T && mean_solvetime < 1.3 * T,
                            "hashrate x" << hashrate_factor << " converged to "
                                         << mean_solvetime << " s/block, want ~" << T);
    }
}

/**
 * The overflow theorem, checked directly. Worst case is every target at
 * powLimit and every solvetime at the +ST clamp. The product must not wrap,
 * must stay at or below (ST/T)*powLimit, and the result must clamp to powLimit.
 *
 * The bound is independent of N and T -- that is the entire reason the division
 * by k*N lives inside the accumulation loop.
 */
BOOST_AUTO_TEST_CASE(pcoin_lwma_overflow_bound)
{
    const auto chainParams = CreateChainParams(*m_node.args, ChainType::MAIN);
    const auto& base = chainParams->GetConsensus();
    const arith_uint256 pow_limit{UintToArith256(base.powLimit)};
    const uint32_t pow_limit_bits{pow_limit.GetCompact()};

    for (const int64_t N : {45, 60, 90}) {
        for (const int64_t T : {60, 600}) {
            const auto params = LwmaParams(base, N, T);

            const int64_t k{N * (N + 1) * T / 2};
            const int64_t denom{k * N};
            BOOST_CHECK(denom > 0 && denom <= int64_t{std::numeric_limits<uint32_t>::max()});

            // Reproduce the accumulation exactly and check the product bound.
            arith_uint256 sumTarget{0};
            for (int64_t i = 0; i < N; ++i) {
                arith_uint256 t{pow_limit};
                t /= arith_uint256(denom);
                sumTarget += t;
            }
            const int64_t t_max{(params.nLwmaMaxSolvetime / T) * k}; // all solvetimes at the +ST clamp
            const arith_uint256 product{sumTarget * static_cast<uint32_t>(t_max)};
            // No wraparound.
            BOOST_CHECK(product >= sumTarget);
            // And within the proven bound of (ST/T)*powLimit.
            arith_uint256 bound{pow_limit};
            bound *= static_cast<uint32_t>(params.nLwmaMaxSolvetime / T);
            BOOST_CHECK(product <= bound);

            // End to end: the worst case clamps to powLimit and never wraps to
            // something small.
            auto blocks = UniformWindow(N, params.nLwmaMaxSolvetime, pow_limit_bits);
            BOOST_CHECK_EQUAL(LwmaGetNextWorkRequired(&blocks[N], params), pow_limit_bits);
        }
    }

    // Contrast: the legacy rule at the same powLimit DOES wrap. This is the
    // documented, deliberately-preserved bug. powLimit * 302400 is a 263-bit
    // product; after wrapping it comes out ~3392x LARGER than powLimit, which
    // is why the height-2016 retarget went the wrong way by 356x instead of
    // being an exact 4x.
    {
        // Use the genesis nBits value, not consensus.powLimit: 0x1f0fffff
        // decodes to 0x0fffff << 224, whereas powLimit is 000fffff followed by
        // all ones. The chain's blocks carry the compact form.
        const arith_uint256 genesis_target{TargetOf(0x1f0fffffU)};
        arith_uint256 wrapped{genesis_target};
        wrapped *= 302400; // the clamp floor, nPowTargetTimespan/4
        // A true product would be >= the old target; the wrapped one is a
        // different number entirely.
        arith_uint256 correct{genesis_target};
        correct /= 1209600; // divide first, so no overflow
        correct *= 302400;
        BOOST_CHECK_EQUAL(correct.GetCompact(), 0x1f03ffffU); // the honest 4x
        wrapped /= 1209600;
        BOOST_CHECK_EQUAL(wrapped.GetCompact(), 0x1e0b7c33U); // what the chain has
        BOOST_CHECK(wrapped < correct);
    }
}

/**
 * The explicit overflow guard, exercised on regtest's oversized powLimit.
 *
 * Regtest uses powLimit = 7fffffff... (~2^255), where the 6*powLimit bound is
 * 2^258 and therefore does NOT fit in 256 bits. A regtest chain running LWMA
 * (-testactivationheight=lwma@N -powretargeting) with slow blocks can reach
 * the overflow, so the guard must be a real check, not an assumption.
 */
BOOST_AUTO_TEST_CASE(pcoin_lwma_overflow_guard)
{
    const auto chainParams = CreateChainParams(*m_node.args, ChainType::REGTEST);
    const auto params = LwmaParams(chainParams->GetConsensus());
    const int64_t N{params.nLwmaAveragingWindow};
    const int64_t T{params.nPowTargetSpacing};
    const arith_uint256 pow_limit{UintToArith256(params.powLimit)};

    // Confirm the premise: this powLimit really does break the 6x bound.
    const arith_uint256 max_uint{~arith_uint256{0}};
    BOOST_CHECK(pow_limit > max_uint / 6);

    // At powLimit with maximally slow blocks the naive product would wrap.
    // The guard must return a valid, mineable target instead of a wrapped one.
    for (const int64_t solvetime : {T, 2 * T, 3 * T, 4 * T, 6 * T}) {
        auto blocks = UniformWindow(N, solvetime, pow_limit.GetCompact());
        const unsigned int out{LwmaGetNextWorkRequired(&blocks[N], params)};
        const auto derived{DeriveTarget(out, params.powLimit)};
        BOOST_REQUIRE(derived.has_value());
        BOOST_CHECK(*derived > arith_uint256{0});
        BOOST_CHECK(*derived <= pow_limit);
        // Crucially: never a small wrapped value. At powLimit with blocks at or
        // slower than target the answer is "stay at (or return to) powLimit",
        // to within compact-encoding truncation. A wraparound would instead
        // yield an arbitrary, far harder target.
        BOOST_CHECK_MESSAGE(*derived > (pow_limit >> 1),
                            "solvetime " << solvetime << " gave " << out
                                         << ", far below powLimit -- possible wraparound");
    }

    // Sanity: the guard's own predicate is exact. sumTarget * t overflows iff
    // sumTarget > (2^256-1)/t.
    {
        const int64_t k{N * (N + 1) * T / 2};
        const int64_t denom{k * N};
        arith_uint256 sumTarget{0};
        for (int64_t i = 0; i < N; ++i) {
            arith_uint256 x{pow_limit};
            x /= arith_uint256(denom);
            sumTarget += x;
        }
        const int64_t t_max{(params.nLwmaMaxSolvetime / T) * k};
        BOOST_CHECK(sumTarget > max_uint / arith_uint256(static_cast<uint64_t>(t_max)));
        // ...and at the low clamp it does not overflow, so the guard is not
        // simply always-on.
        const int64_t t_min{k / 3};
        BOOST_CHECK(sumTarget <= max_uint / arith_uint256(static_cast<uint64_t>(t_min)));
    }
}

/**
 * BACKDATING MUST NOT PAY -- the security property the running maximum exists
 * for.
 *
 * Consensus only requires a block's timestamp to exceed its parent's
 * median-time-past, so a miner may legally stamp its OWN blocks at MTP+1, far
 * behind the parent. Against raw solvetimes with an asymmetric clamp band
 * [-FTL, +ST] that was a standing subsidy: the backdated block floored at -FTL
 * while the honest block behind it capped at +ST, so the pair reported
 * (ST - FTL) seconds of apparent time for about 2T seconds of real time.
 * Simulation of the exact integer algorithm put that at 1.31x emission for a
 * single one of PCoin's seven miners and 2.09x at 50% hashrate, sustained
 * indefinitely rather than as a transient.
 *
 * The running maximum removes that subsidy: apparent elapsed time telescopes to
 * max(timestamp) - first, so backdating can only WITHHOLD apparent time.
 *
 * It does NOT reduce the residual to zero, and this test deliberately asserts
 * the true bound rather than the convenient one. Because the weights are
 * positional, holding the running maximum flat for a block defers that block's
 * increment to the next (higher-weighted) index, which raises the weighted sum
 * slightly. Writing the weighted sum in Abel form makes the whole effect
 * visible and boundable:
 *
 *     t = N*M_N - sum_{i=0}^{N-1} M_i        (M = running maximum)
 *
 * M_N is pinned by real time (honest miners stamp the real clock) and M_i can
 * only be pushed DOWN, so the attacker's entire leverage is depressing interior
 * M_i. Suppressing m consecutive blocks and letting one honest block catch up
 * yields exactly
 *
 *     t/k = 1 + m/(N+1),   valid while (m+1)*T <= ST
 *
 * so the easing is capped at 1 + (ST/T - 1)/(N+1) == 1.180x, and sustaining a
 * run of m needs m/(m+1) of the hashrate: 1.016x at 50%, 1.033x at 67%, and the
 * 1.180x maximum only at 91.7% -- which is 1 - T/ST, the share at which the
 * attacker can already ratchet difficulty to infinity and brick the chain
 * outright (see pcoin_lwma_clamps). Beyond m == ST/T - 1 the catch-up block's
 * solvetime is clamped at ST and the withheld time is destroyed, so pushing
 * harder makes the chain HARDER, not easier.
 *
 * Against the pre-running-maximum 3.43x (unbounded in attacker share, 1.40x at
 * one of seven miners) this is a bounded second-order effect, and at every share
 * a real attacker could plausibly hold it is under 2%. Do not weaken these
 * assertions to "never easier" -- that claim is false, and asserting it would
 * hide the regression it is meant to catch.
 */
BOOST_AUTO_TEST_CASE(pcoin_lwma_backdating_never_pays)
{
    const auto chainParams = CreateChainParams(*m_node.args, ChainType::MAIN);
    const auto params = LwmaParams(chainParams->GetConsensus());
    const int64_t N{params.nLwmaAveragingWindow};
    const int64_t T{params.nPowTargetSpacing};
    const int64_t ST{params.nLwmaMaxSolvetime};
    const int64_t FTL{params.nLwmaMaxFutureBlockTime};

    const std::vector<int64_t> flat(N, T);
    auto flat_chain = WindowFromSolvetimes(flat, TIP_BITS);
    const unsigned int steady{LwmaGetNextWorkRequired(&flat_chain[N], params)};

    // The exploit shape itself: alternate a backdated block with an honest
    // block that catches up. Real elapsed time is unchanged from `flat`. Under
    // raw solvetimes this was worth (ST - FTL) of apparent time per pair; under
    // the running maximum it is worth exactly one deferred increment, i.e. the
    // m == 1 case of 1 + m/(N+1). Anything above that is a regression.
    {
        std::vector<int64_t> dts;
        for (int64_t i = 0; i < N; ++i) dts.push_back(i % 2 == 0 ? -FTL : 2 * T + FTL);
        auto chain = WindowFromSolvetimes(dts, TIP_BITS);
        const double ratio{TargetRatio(LwmaGetNextWorkRequired(&chain[N], params), steady)};
        const double bound{1.0 + 1.0 / static_cast<double>(N + 1)}; // 1.0164
        BOOST_CHECK_MESSAGE(ratio <= bound * 1.0001,
                            "backdate/catch-up alternation eased difficulty by " << ratio
                            << "x, above the 1 + 1/(N+1) = " << bound << "x bound");
        // ...and it really is that value, not merely below it: pin it so a
        // change that made backdating pay MORE cannot slip through as "still
        // under the bound".
        BOOST_CHECK_CLOSE(ratio, bound, 0.05);
    }

    // Pure oscillation makes no net progress in apparent time at all, so the
    // chain reads as maximally fast and difficulty takes its maximum 3x step
    // UP. Every amplitude collapses to the same answer.
    for (const int64_t amp : {FTL, 2 * T, 6 * T, ST}) {
        std::vector<int64_t> dts;
        for (int64_t i = 0; i < N; ++i) dts.push_back(i % 2 == 0 ? amp : -amp);
        auto chain = WindowFromSolvetimes(dts, TIP_BITS);
        const unsigned int out{LwmaGetNextWorkRequired(&chain[N], params)};
        BOOST_CHECK_EQUAL(out, 0x1e03d410U);
        BOOST_CHECK(TargetOf(out) < TargetOf(steady));
    }

    // A single backdated block makes the target smaller (harder). This is the
    // direction that proves backdating is not rewarded.
    {
        std::vector<int64_t> dts(N, T);
        dts.back() = -FTL;
        auto chain = WindowFromSolvetimes(dts, TIP_BITS);
        BOOST_CHECK(TargetOf(LwmaGetNextWorkRequired(&chain[N], params)) < TargetOf(steady));
    }

    // Sweep a SINGLE backdate/catch-up pair across every position in the window,
    // holding total real elapsed time fixed. One deferred increment moves T of
    // weight by one index, so t goes from k to k + T and the easing is exactly
    // 1 + T/k == 1 + 2/(N*(N+1)) == 1.000546x, independent of position.
    {
        const int64_t real_span{N * T};
        const double bound{1.0 + 2.0 / static_cast<double>(N * (N + 1))};
        for (int64_t j = 1; j < N; ++j) {
            std::vector<int64_t> dts(N, T);
            dts[j - 1] = -FTL;
            dts[j] = 2 * T + FTL;
            int64_t total{0};
            for (const int64_t d : dts) total += d;
            BOOST_REQUIRE_EQUAL(total, real_span);
            auto chain = WindowFromSolvetimes(dts, TIP_BITS);
            const double ratio{TargetRatio(LwmaGetNextWorkRequired(&chain[N], params), steady)};
            BOOST_CHECK_MESSAGE(ratio <= bound * 1.0001,
                                "backdating at position " << j << " eased difficulty by " << ratio
                                << "x, above the 1 + 2/(N(N+1)) = " << bound << "x bound");
        }
    }

    // The bound is genuinely maximal: an attacker suppressing m consecutive
    // blocks and letting one honest block catch up gets 1 + m/(N+1) while the
    // catch-up still fits under ST, and LOSES ground once it does not. This
    // pins both the peak and the fact that pushing past it backfires.
    {
        const auto ease_for_run = [&](int64_t m) {
            std::vector<int64_t> inc;
            while (static_cast<int64_t>(inc.size()) < N) {
                for (int64_t i = 0; i < m; ++i) inc.push_back(0);
                inc.push_back((m + 1) * T);
            }
            inc.resize(N);
            auto chain = WindowFromSolvetimes(inc, TIP_BITS);
            return TargetRatio(LwmaGetNextWorkRequired(&chain[N], params), steady);
        };
        const int64_t m_max{params.nLwmaMaxSolvetime / T - 1}; // 11
        const double peak{1.0 + static_cast<double>(m_max) / static_cast<double>(N + 1)};
        BOOST_CHECK_CLOSE(ease_for_run(m_max), peak, 0.05); // 1.180x
        // Sustaining a run of m needs m/(m+1) of the hashrate, so the peak is
        // only reachable at 1 - T/ST == 91.7%, where the chain is already lost.
        // Everything a realistic attacker can hold is far below it.
        BOOST_CHECK(ease_for_run(1) < 1.02); // 50% hashrate
        BOOST_CHECK(ease_for_run(2) < 1.04); // 67% hashrate
        // Past the ST clamp the withheld time is destroyed, not banked.
        BOOST_CHECK(ease_for_run(m_max + 4) < 1.0);
        // No run length anywhere may beat the analytic peak.
        for (int64_t m = 0; m <= 30; ++m) {
            BOOST_CHECK_MESSAGE(ease_for_run(m) <= peak * 1.0001,
                                "run of " << m << " eased difficulty by " << ease_for_run(m)
                                << "x, above the analytic peak " << peak << "x");
        }
    }

    // Stamping forward cannot be farmed either: a constant forward offset
    // cancels out of the differences entirely, so it is worth exactly nothing.
    {
        auto shifted = WindowFromSolvetimes(flat, TIP_BITS, 1785700000 + FTL);
        BOOST_CHECK_EQUAL(LwmaGetNextWorkRequired(&shifted[N], params), steady);
    }
}

//! Degenerate inputs must still yield a usable, mineable target.
BOOST_AUTO_TEST_CASE(pcoin_lwma_degenerate_inputs)
{
    const auto chainParams = CreateChainParams(*m_node.args, ChainType::MAIN);
    const auto params = LwmaParams(chainParams->GetConsensus());
    const int64_t N{params.nLwmaAveragingWindow};
    const arith_uint256 pow_limit{UintToArith256(params.powLimit)};

    // All timestamps identical -> t == 0 -> low clamp -> valid, 3x harder.
    {
        auto blocks = UniformWindow(N, 0, TIP_BITS);
        const unsigned int out{LwmaGetNextWorkRequired(&blocks[N], params)};
        BOOST_CHECK_EQUAL(out, 0x1e03d410U);
        BOOST_CHECK(DeriveTarget(out, params.powLimit).has_value());
    }
    // sumTarget == 0 (every target below k*N) -> result is 1, never 0. nBits
    // encoding a zero target is rejected by DeriveTarget, which would make
    // every subsequent block unmineable and halt the chain permanently.
    {
        arith_uint256 one{1};
        const uint32_t tiny{one.GetCompact()};
        auto blocks = UniformWindow(N, params.nPowTargetSpacing, tiny);
        const unsigned int out{LwmaGetNextWorkRequired(&blocks[N], params)};
        BOOST_CHECK_EQUAL(TargetOf(out), arith_uint256{1});
        BOOST_CHECK(DeriveTarget(out, params.powLimit).has_value());
    }
    // Result never exceeds powLimit even when the window is already at it and
    // blocks are arriving slowly.
    {
        auto blocks = UniformWindow(N, 6 * params.nPowTargetSpacing, pow_limit.GetCompact());
        const unsigned int out{LwmaGetNextWorkRequired(&blocks[N], params)};
        BOOST_CHECK_EQUAL(out, pow_limit.GetCompact());
        BOOST_CHECK(TargetOf(out) <= pow_limit);
    }
    // Short history: fewer than N ancestors returns powLimit.
    {
        auto blocks = UniformWindow(N - 1, params.nPowTargetSpacing, TIP_BITS);
        BOOST_CHECK_EQUAL(LwmaGetNextWorkRequired(&blocks[N - 1], params), pow_limit.GetCompact());
    }
    // fPowNoRetargeting (regtest) short-circuits, matching upstream semantics.
    {
        Consensus::Params p{params};
        p.fPowNoRetargeting = true;
        auto blocks = UniformWindow(N, 6 * p.nPowTargetSpacing, TIP_BITS);
        BOOST_CHECK_EQUAL(LwmaGetNextWorkRequired(&blocks[N], p), TIP_BITS);
    }
}

//! Increasing any single solvetime never decreases the target, and later
//! (newer) positions carry more weight than earlier ones.
BOOST_AUTO_TEST_CASE(pcoin_lwma_monotonicity)
{
    const auto chainParams = CreateChainParams(*m_node.args, ChainType::MAIN);
    const auto params = LwmaParams(chainParams->GetConsensus());
    const int64_t N{params.nLwmaAveragingWindow};
    const int64_t T{params.nPowTargetSpacing};

    const std::vector<int64_t> base(N, T);
    auto base_chain = WindowFromSolvetimes(base, TIP_BITS);
    const arith_uint256 base_target{TargetOf(LwmaGetNextWorkRequired(&base_chain[N], params))};

    arith_uint256 prev_bumped{0};
    for (int64_t j = 0; j < N; ++j) {
        std::vector<int64_t> dts{base};
        dts[j] += 300;
        auto chain = WindowFromSolvetimes(dts, TIP_BITS);
        const arith_uint256 bumped{TargetOf(LwmaGetNextWorkRequired(&chain[N], params))};
        // Monotone: a longer solvetime never makes the chain harder.
        BOOST_CHECK(bumped >= base_target);
        // Weight increases with index: the same bump later in the window has
        // strictly more influence.
        BOOST_CHECK(bumped > prev_bumped);
        prev_bumped = bumped;
    }
}

/**
 * Differential test against the normative Python model, contrib/lwma/lwma_ref.py.
 * Both sides build the same windows from the same documented LCG, so only the 30
 * expected nBits need to be committed. Regenerate with:
 *
 *     python contrib/lwma/lwma_ref.py --vectors
 *
 * Targets span 1 .. powLimit, solvetimes span -4*FTL .. +20T including zero and
 * negative runs (which the running maximum folds to zero).
 */
BOOST_AUTO_TEST_CASE(pcoin_lwma_differential_vectors)
{
    const auto chainParams = CreateChainParams(*m_node.args, ChainType::MAIN);
    const auto params = LwmaParams(chainParams->GetConsensus());
    const int64_t N{params.nLwmaAveragingWindow};
    const int64_t T{params.nPowTargetSpacing};
    const int64_t FTL{params.nLwmaMaxFutureBlockTime};
    const arith_uint256 pow_limit{UintToArith256(params.powLimit)};

    static const unsigned int LWMA_EXPECTED[30] = {
        0x1f0fffffU, 0x1e478fbaU, 0x1f037b9dU, 0x0821bea6U, 0x1f0fffffU, 0x1e4c5b21U,
        0x1f027c4dU, 0x08445137U, 0x1f0fffffU, 0x1e417687U, 0x1f03b064U, 0x082d56a5U,
        0x1f0fffffU, 0x1e4279f2U, 0x1f01fc0dU, 0x083516f1U, 0x1f0fffffU, 0x1e3da4e5U,
        0x1f022b6fU, 0x083ca588U, 0x1f0fffffU, 0x1e461a95U, 0x1f00b036U, 0x082a3d4aU,
        0x1f0fffffU, 0x1e489c9bU, 0x1f03bbd4U, 0x0832acd6U, 0x1f0fffffU, 0x1e465e92U,
    };

    for (int v = 0; v < 30; ++v) {
        uint64_t x{static_cast<uint64_t>(0x5EED0000U + v)};
        auto next = [&x]() -> uint32_t {
            x = x * 6364136223846793005ULL + 1442695040888963407ULL;
            return static_cast<uint32_t>((x >> 33) & 0x7fffffffULL);
        };

        std::vector<int64_t> times;
        int64_t t{1500000000 + int64_t{next()} % 400000000};
        times.push_back(t);
        for (int64_t i = 0; i < N; ++i) {
            const int64_t dt{-4 * FTL + int64_t{next()} % (20 * T + 4 * FTL + 1)};
            t += dt;
            times.push_back(t);
        }

        const int mode{v % 4};
        std::vector<uint32_t> bits;
        for (int64_t i = 0; i <= N; ++i) {
            arith_uint256 target;
            if (mode == 0) {
                target = pow_limit;
            } else if (mode == 1) {
                target = TargetOf(TIP_BITS);
            } else if (mode == 2) {
                target = pow_limit >> static_cast<unsigned int>(next() % 120);
                if (target == 0) target = arith_uint256{1};
            } else {
                const uint64_t hi{uint64_t{next()} % (uint64_t{1} << 30)};
                const uint64_t lo{uint64_t{next()} % (uint64_t{1} << 30)};
                target = arith_uint256{((hi << 30) + lo) | 1};
            }
            const uint32_t nb{target.GetCompact()};
            BOOST_REQUIRE(TargetOf(nb) > arith_uint256{0});
            BOOST_REQUIRE(TargetOf(nb) <= pow_limit);
            bits.push_back(nb);
        }

        auto chain = MakeChain(times, bits);
        BOOST_CHECK_EQUAL(LwmaGetNextWorkRequired(&chain[N], params), LWMA_EXPECTED[v]);
    }
}

//! PermittedDifficultyTransition must accept LWMA transitions at non-interval
//! heights, or header sync breaks the moment nMinimumChainWork is set.
BOOST_AUTO_TEST_CASE(pcoin_lwma_permitted_difficulty_transition)
{
    const auto chainParams = CreateChainParams(*m_node.args, ChainType::MAIN);
    const auto& consensus = chainParams->GetConsensus();
    const int H{consensus.lwmaHeight};

    // Below the fork the legacy rule still applies: a change at a non-interval
    // height is rejected.
    BOOST_CHECK(!PermittedDifficultyTransition(consensus, 2500, TIP_BITS, 0x1e1935bcU));
    BOOST_CHECK(PermittedDifficultyTransition(consensus, 2500, TIP_BITS, TIP_BITS));

    // At and above the fork every block retargets, so changes are permitted at
    // arbitrary heights and by arbitrary amounts (the real bound needs the full
    // window, which this function does not have).
    BOOST_CHECK(PermittedDifficultyTransition(consensus, H, TIP_BITS, 0x1e1935bcU));
    BOOST_CHECK(PermittedDifficultyTransition(consensus, H + 1, TIP_BITS, 0x1e44e931U));
    BOOST_CHECK(PermittedDifficultyTransition(consensus, H + 7, TIP_BITS, 0x1e03d410U));
    BOOST_CHECK(PermittedDifficultyTransition(consensus, H + 1000, 0x1f0fffffU, 0x1d00ffffU));
}

BOOST_AUTO_TEST_SUITE_END()
