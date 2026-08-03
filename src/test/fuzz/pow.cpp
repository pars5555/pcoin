// Copyright (c) 2020-2022 The Bitcoin Core developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.

#include <chain.h>
#include <chainparams.h>
#include <pow.h>
#include <primitives/block.h>
#include <test/fuzz/FuzzedDataProvider.h>
#include <test/fuzz/fuzz.h>
#include <test/fuzz/util.h>
#include <util/chaintype.h>
#include <util/check.h>
#include <util/overflow.h>

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

void initialize_pow()
{
    SelectParams(ChainType::MAIN);
}

FUZZ_TARGET(pow, .init = initialize_pow)
{
    FuzzedDataProvider fuzzed_data_provider(buffer.data(), buffer.size());
    const Consensus::Params& consensus_params = Params().GetConsensus();
    std::vector<std::unique_ptr<CBlockIndex>> blocks;
    const uint32_t fixed_time = fuzzed_data_provider.ConsumeIntegral<uint32_t>();
    const uint32_t fixed_bits = fuzzed_data_provider.ConsumeIntegral<uint32_t>();
    LIMITED_WHILE(fuzzed_data_provider.remaining_bytes() > 0, 10000) {
        const std::optional<CBlockHeader> block_header = ConsumeDeserializable<CBlockHeader>(fuzzed_data_provider);
        if (!block_header) {
            continue;
        }
        CBlockIndex& current_block{
            *blocks.emplace_back(std::make_unique<CBlockIndex>(*block_header))};
        {
            CBlockIndex* previous_block = blocks.empty() ? nullptr : PickValue(fuzzed_data_provider, blocks).get();
            const int current_height = (previous_block != nullptr && previous_block->nHeight != std::numeric_limits<int>::max()) ? previous_block->nHeight + 1 : 0;
            if (fuzzed_data_provider.ConsumeBool()) {
                current_block.pprev = previous_block;
            }
            if (fuzzed_data_provider.ConsumeBool()) {
                current_block.nHeight = current_height;
            }
            if (fuzzed_data_provider.ConsumeBool()) {
                const uint32_t seconds = current_height * consensus_params.nPowTargetSpacing;
                if (!AdditionOverflow(fixed_time, seconds)) {
                    current_block.nTime = fixed_time + seconds;
                }
            }
            if (fuzzed_data_provider.ConsumeBool()) {
                current_block.nBits = fixed_bits;
            }
            if (fuzzed_data_provider.ConsumeBool()) {
                current_block.nChainWork = previous_block != nullptr ? previous_block->nChainWork + GetBlockProof(*previous_block) : arith_uint256{0};
            } else {
                current_block.nChainWork = ConsumeArithUInt256(fuzzed_data_provider);
            }
        }
        {
            (void)GetBlockProof(current_block);
            (void)CalculateNextWorkRequired(&current_block, fuzzed_data_provider.ConsumeIntegralInRange<int64_t>(0, std::numeric_limits<int64_t>::max()), consensus_params);
            if (current_block.nHeight != std::numeric_limits<int>::max() && current_block.nHeight - (consensus_params.DifficultyAdjustmentInterval() - 1) >= 0) {
                (void)GetNextWorkRequired(&current_block, &(*block_header), consensus_params);
            }
        }
        {
            const auto& to = PickValue(fuzzed_data_provider, blocks);
            const auto& from = PickValue(fuzzed_data_provider, blocks);
            const auto& tip = PickValue(fuzzed_data_provider, blocks);
            try {
                (void)GetBlockProofEquivalentTime(*to, *from, *tip, consensus_params);
            } catch (const uint_error&) {
            }
        }
        {
            const std::optional<uint256> hash = ConsumeDeserializable<uint256>(fuzzed_data_provider);
            if (hash) {
                (void)CheckProofOfWorkImpl(*hash, fuzzed_data_provider.ConsumeIntegral<unsigned int>(), consensus_params);
            }
        }
    }
}


FUZZ_TARGET(pow_transition, .init = initialize_pow)
{
    FuzzedDataProvider fuzzed_data_provider(buffer.data(), buffer.size());
    const Consensus::Params& consensus_params{Params().GetConsensus()};
    std::vector<std::unique_ptr<CBlockIndex>> blocks;

    const uint32_t old_time{fuzzed_data_provider.ConsumeIntegral<uint32_t>()};
    const uint32_t new_time{fuzzed_data_provider.ConsumeIntegral<uint32_t>()};
    const int32_t version{fuzzed_data_provider.ConsumeIntegral<int32_t>()};
    uint32_t nbits{fuzzed_data_provider.ConsumeIntegral<uint32_t>()};

    const arith_uint256 pow_limit = UintToArith256(consensus_params.powLimit);
    arith_uint256 old_target;
    old_target.SetCompact(nbits);
    if (old_target > pow_limit) {
        nbits = pow_limit.GetCompact();
    }
    // Create one difficulty adjustment period worth of headers
    for (int height = 0; height < consensus_params.DifficultyAdjustmentInterval(); ++height) {
        CBlockHeader header;
        header.nVersion = version;
        header.nTime = old_time;
        header.nBits = nbits;
        if (height == consensus_params.DifficultyAdjustmentInterval() - 1) {
            header.nTime = new_time;
        }
        auto current_block{std::make_unique<CBlockIndex>(header)};
        current_block->pprev = blocks.empty() ? nullptr : blocks.back().get();
        current_block->nHeight = height;
        blocks.emplace_back(std::move(current_block));
    }
    auto last_block{blocks.back().get()};
    unsigned int new_nbits{GetNextWorkRequired(last_block, nullptr, consensus_params)};
    Assert(PermittedDifficultyTransition(consensus_params, last_block->nHeight + 1, last_block->nBits, new_nbits));
}

//! PCoin: exercise LwmaGetNextWorkRequired over random but structurally valid
//! chains (nHeight consistent with the pprev walk, targets <= powLimit).
FUZZ_TARGET(pow_lwma, .init = initialize_pow)
{
    FuzzedDataProvider fuzzed_data_provider(buffer.data(), buffer.size());
    Consensus::Params consensus_params{Params().GetConsensus()};
    // Activate LWMA from the bottom of this synthetic chain.
    consensus_params.lwmaHeight = 0;

    const arith_uint256 pow_limit = UintToArith256(consensus_params.powLimit);
    const int64_t N{consensus_params.nLwmaAveragingWindow};

    // Build a chain a little longer than the averaging window so the walk is
    // always satisfiable.
    const int chain_len{static_cast<int>(N) + 1 + fuzzed_data_provider.ConsumeIntegralInRange<int>(0, 40)};

    std::vector<std::unique_ptr<CBlockIndex>> blocks;
    int64_t time{fuzzed_data_provider.ConsumeIntegral<uint32_t>() / 2};
    for (int height = 0; height < chain_len; ++height) {
        CBlockHeader header;
        // Deliberately wild solvetimes, including negative runs and zeros.
        time += fuzzed_data_provider.ConsumeIntegralInRange<int64_t>(-4 * consensus_params.nLwmaMaxFutureBlockTime,
                                                                    20 * consensus_params.nPowTargetSpacing);
        if (time < 0) time = 0;
        header.nTime = static_cast<uint32_t>(time & 0xffffffff);

        arith_uint256 target;
        target.SetCompact(fuzzed_data_provider.ConsumeIntegral<uint32_t>());
        // Consensus guarantees targets are in (0, powLimit]; mirror that.
        if (target == 0 || target > pow_limit) target = pow_limit;
        header.nBits = target.GetCompact();

        auto current_block{std::make_unique<CBlockIndex>(header)};
        current_block->pprev = blocks.empty() ? nullptr : blocks.back().get();
        current_block->nHeight = height;
        blocks.emplace_back(std::move(current_block));
    }

    auto last_block{blocks.back().get()};
    const unsigned int new_nbits{LwmaGetNextWorkRequired(last_block, consensus_params)};

    // The result must always be a usable target: non-zero, not overflowing,
    // and never above powLimit. A zero target would permanently halt the chain.
    const auto derived{DeriveTarget(new_nbits, consensus_params.powLimit)};
    Assert(derived.has_value());
    Assert(*derived > arith_uint256{0});
    Assert(*derived <= pow_limit);

    // Deterministic: nBits is a pure function of the ancestors.
    Assert(LwmaGetNextWorkRequired(last_block, consensus_params) == new_nbits);

    // SECURITY INVARIANT: backdating never eases difficulty.
    //
    // Lowering any single timestamp in the window must never produce a LARGER
    // (easier) target. Against raw solvetimes this was false for interior
    // positions -- lowering w[i] shrank solvetime i (weight i) and grew
    // solvetime i+1 (weight i+1) for a net gain of +d in the weighted sum,
    // which is precisely the emission-inflation exploit. The running maximum in
    // LwmaGetNextWorkRequired() makes it hold for every position.
    {
        const int idx{fuzzed_data_provider.ConsumeIntegralInRange<int>(chain_len - static_cast<int>(N), chain_len - 1)};
        const uint32_t original{blocks[idx]->nTime};
        const uint32_t drop{fuzzed_data_provider.ConsumeIntegralInRange<uint32_t>(0, original)};
        blocks[idx]->nTime = original - drop;
        const unsigned int backdated_nbits{LwmaGetNextWorkRequired(last_block, consensus_params)};
        const auto backdated{DeriveTarget(backdated_nbits, consensus_params.powLimit)};
        Assert(backdated.has_value());
        Assert(*backdated <= *derived);
        blocks[idx]->nTime = original;
    }

    // Under LWMA every transition is permitted (the 4x interval rule does not
    // apply once every block retargets).
    Assert(PermittedDifficultyTransition(consensus_params, last_block->nHeight + 1, last_block->nBits, new_nbits));
}
