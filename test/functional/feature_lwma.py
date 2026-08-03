#!/usr/bin/env python3
# Copyright (c) 2026 The PCoin developers
# Distributed under the MIT software license, see the accompanying
# file COPYING or http://www.opensource.org/licenses/mit-license.php.
"""Test the LWMA difficulty adjustment algorithm.

LWMA (zawy12 LWMA-1) replaces Bitcoin's 2016-block retarget at a fixed
activation height. It retargets on every block over a rolling window of the
last N solvetimes, weighted linearly with the newest solvetime carrying the
largest weight.

Run with -testactivationheight=lwma@<height> -powretargeting, since regtest
ships fPowNoRetargeting=true so that blocks stay instant.

NOTE ON COVERAGE: PCoin's proof of work is RandomX over the serialized header,
and the Python test framework has no RandomX implementation -- CBlock.solve()
grinds the double-SHA256 block id, which is not the PoW hash. Blocks therefore
have to be produced by the node itself via generatetoaddress(). That rules out
the negative tests that need a hand-built block (submitting a deliberately
wrong nBits, or a too-far-future timestamp): CheckBlockHeader rejects them with
"high-hash" before validation ever reaches "bad-diffbits" or "time-too-new".
Those cases are covered in src/test/pow_tests.cpp instead, and the consensus
enforcement of nBits is covered here by the fork test at the end, which proves
two nodes with different activation heights genuinely split.
"""

from test_framework.test_framework import BitcoinTestFramework
from test_framework.util import assert_equal, assert_greater_than, assert_greater_than_or_equal

# Must match the values LwmaGetNextWorkRequired() uses on regtest.
LWMA_HEIGHT = 120
N = 60          # nLwmaAveragingWindow
T = 600         # nPowTargetSpacing
ST = 12 * T     # nLwmaMaxSolvetime
POW_LIMIT_BITS = 0x207fffff


def set_compact(c):
    size = c >> 24
    word = c & 0x007fffff
    if size <= 3:
        return word >> (8 * (3 - size))
    return word << (8 * (size - 3))


def get_compact(n):
    size = (n.bit_length() + 7) // 8
    if size <= 3:
        compact = (n << (8 * (3 - size))) & 0xffffffff
    else:
        compact = (n >> (8 * (size - 3))) & 0xffffffff
    if compact & 0x00800000:
        compact >>= 8
        size += 1
    return compact | (size << 24)


def lwma_reference(times, bits, pow_limit_bits=POW_LIMIT_BITS):
    """Normative model, mirroring LwmaGetNextWorkRequired().

    times/bits cover the window newest-last: index 0 is block L-N (which
    supplies a timestamp only), indices 1..N are blocks L-N+1..L.
    """
    assert len(times) == N + 1 and len(bits) == N + 1
    pow_limit = set_compact(pow_limit_bits)
    k = N * (N + 1) * T // 2
    denom = k * N

    sum_target = 0
    t = 0
    prev = times[0]
    for i in range(1, N + 1):
        # Solvetimes are measured against a running MAXIMUM of the window's
        # timestamps, so they are never negative. A backdated block reads as 0
        # rather than as a large negative that the next block gets paid to catch
        # up on -- see the MONOTONIC TIMESTAMPS note in src/pow.cpp.
        cur = max(times[i], prev)
        st = min(cur - prev, ST)
        prev = cur
        t += st * i
        sum_target += set_compact(bits[i]) // denom

    t = max(t, k // 3)

    # Explicit overflow guard, matching pow.cpp. Regtest's powLimit is ~2^255,
    # so (ST/T)*powLimit does NOT fit in 256 bits and this branch is reachable
    # here (it is unreachable on mainnet, where powLimit is 2^244).
    if sum_target > ((1 << 256) - 1) // t:
        bn_new = pow_limit
    else:
        bn_new = sum_target * t

    bn_new = min(bn_new, pow_limit)
    bn_new = max(bn_new, 1)
    return get_compact(bn_new)


class LwmaTest(BitcoinTestFramework):
    def set_test_params(self):
        self.num_nodes = 2
        self.setup_clean_chain = True
        self.extra_args = [
            [f"-testactivationheight=lwma@{LWMA_HEIGHT}", "-powretargeting"],
            # Node 1 activates one block later, to prove the activation height
            # is genuinely consensus-critical and correctly plumbed.
            [f"-testactivationheight=lwma@{LWMA_HEIGHT + 1}", "-powretargeting"],
        ]

    def setup_network(self):
        # Keep the nodes apart until the fork test at the end.
        self.setup_nodes()

    def bits_at(self, node, height):
        return int(node.getblockheader(node.getblockhash(height))["bits"], 16)

    def expected_nbits(self, node, height):
        """The nBits the block at `height` must carry, derived from the chain."""
        times, bits = [], []
        for h in range(height - 1 - N, height):
            hdr = node.getblockheader(node.getblockhash(h))
            times.append(hdr["time"])
            bits.append(int(hdr["bits"], 16))
        return lwma_reference(times, bits)

    def mine(self, node, count, spacing=T):
        """Mine `count` blocks, advancing mocktime by `spacing` per block.

        Uses generatetodescriptor rather than generatetoaddress: this fork sets
        regtest base58Prefixes[PUBKEY_ADDRESS]=117, so the test framework's
        hardcoded deterministic key (upstream's prefix 111) is rejected with
        "Invalid address". The raw(51) descriptor is OP_TRUE, which needs no
        address encoding at all. Go through the framework wrapper, which this
        fork requires (the RPC has a called_by_framework keyword-only arg).
        """
        for _ in range(count):
            self.mocktime += spacing
            node.setmocktime(self.mocktime)
            self.generatetodescriptor(node, 1, "raw(51)", sync_fun=self.no_op)

    def run_test(self):
        node = self.nodes[0]
        self.mocktime = 1785600628
        node.setmocktime(self.mocktime)

        self.log.info("Below the activation height nBits is constant at the genesis value")
        self.mine(node, LWMA_HEIGHT - 1)
        assert_equal(node.getblockcount(), LWMA_HEIGHT - 1)
        for h in range(1, LWMA_HEIGHT):
            assert_equal(self.bits_at(node, h), POW_LIMIT_BITS)

        self.log.info("The activation block retargets and matches the reference model")
        want = self.expected_nbits(node, LWMA_HEIGHT)
        self.mine(node, 1)
        assert_equal(self.bits_at(node, LWMA_HEIGHT), want)

        self.log.info("Every subsequent block retargets, always matching the model")
        for _ in range(40):
            h = node.getblockcount() + 1
            want = self.expected_nbits(node, h)
            self.mine(node, 1)
            assert_equal(self.bits_at(node, h), want)

        # NOTE ON ORDERING: the chain starts pinned at powLimit (the easiest
        # possible target), so "slow blocks make it easier" is unobservable from
        # here -- the result clamps straight back to powLimit. The target has to
        # be driven DOWN first. Each phase also has to run a full window (N=60)
        # or the preceding 600 s solvetimes still dominate the weighted sum and
        # the target does not move far enough to assert on.
        before = set_compact(self.bits_at(node, node.getblockcount()))
        # Still pinned at the easiest target -- but one compact ulp below it,
        # not exactly equal. LwmaGetNextWorkRequired() must divide by k*N INSIDE
        # the accumulation loop (that ordering is what makes it overflow-proof;
        # see the note in src/pow.cpp), and that integer division truncates. At
        # a steady 600 s the result therefore lands a hair under powLimit and
        # re-encodes as 0x207ffffe rather than 0x207fffff -- a 2**-23 relative
        # difference, which is simply the resolution of the compact format.
        pow_limit = set_compact(POW_LIMIT_BITS)
        one_ulp = pow_limit - set_compact(POW_LIMIT_BITS - 1)
        assert_greater_than_or_equal(pow_limit, before)
        assert_greater_than_or_equal(before, pow_limit - one_ulp)

        self.log.info("Step change: fast blocks make the target harder")
        for _ in range(N + 10):
            h = node.getblockcount() + 1
            want = self.expected_nbits(node, h)
            self.mine(node, 1, spacing=60)
            assert_equal(self.bits_at(node, h), want)
        after_fast = set_compact(self.bits_at(node, node.getblockcount()))
        assert_greater_than(before, after_fast)

        self.log.info("Step change: slow blocks make the target easier again")
        for _ in range(N + 10):
            h = node.getblockcount() + 1
            want = self.expected_nbits(node, h)
            self.mine(node, 1, spacing=6 * T)
            assert_equal(self.bits_at(node, h), want)
        after_slow = set_compact(self.bits_at(node, node.getblockcount()))
        assert_greater_than(after_slow, after_fast)

        self.log.info("Backdated blocks are accepted, and never ease difficulty")
        # A backwards-stamped block is legal as long as it beats MedianTimePast.
        # Under the running maximum it contributes a zero solvetime, so it can
        # only make the next target smaller (harder) -- never larger.
        before_backdate = set_compact(self.bits_at(node, node.getblockcount()))
        h = node.getblockcount() + 1
        want = self.expected_nbits(node, h)
        self.mine(node, 1, spacing=-1)
        assert_equal(self.bits_at(node, h), want)
        assert_greater_than_or_equal(before_backdate, set_compact(self.bits_at(node, h)))

        self.log.info("Reorg across the activation height restores identical nBits")
        snapshot = {h: self.bits_at(node, h)
                    for h in range(LWMA_HEIGHT - 5, node.getblockcount() + 1)}
        tip_before = node.getbestblockhash()
        rewind_to = LWMA_HEIGHT - 3
        # Capture the hash BEFORE invalidating: afterwards the block is no
        # longer in the active chain and getblockhash raises
        # "Block height out of range".
        rewind_hash = node.getblockhash(rewind_to)
        node.invalidateblock(rewind_hash)
        assert_equal(node.getblockcount(), rewind_to - 1)
        node.reconsiderblock(rewind_hash)
        assert_equal(node.getbestblockhash(), tip_before)
        for h, bits in snapshot.items():
            assert_equal(self.bits_at(node, h), bits)

        self.log.info("Nodes disagreeing on the activation height split at exactly that block")
        # Node 1 activates at LWMA_HEIGHT+1, so for the block at LWMA_HEIGHT it
        # computes the legacy nBits and must reject node 0's block. It can
        # therefore follow node 0 only as far as LWMA_HEIGHT-1.
        self.connect_nodes(0, 1)
        self.nodes[1].setmocktime(self.mocktime)
        # Assert on the HEADER chain, not getblockcount(). Node 1 rejects the
        # header at LWMA_HEIGHT as bad-diffbits and immediately disconnects node
        # 0 as misbehaving, so it never downloads any block BODIES at all --
        # its blockcount stays 0 while its headers stop at LWMA_HEIGHT-1.
        self.wait_until(lambda: self.nodes[1].getblockchaininfo()["headers"] == LWMA_HEIGHT - 1,
                        timeout=60)
        assert_equal(self.nodes[1].getblockchaininfo()["headers"], LWMA_HEIGHT - 1)
        assert_greater_than(node.getblockcount(), LWMA_HEIGHT)
        self.log.info("Node 0 at height %d, node 1's headers stall at %d as expected",
                      node.getblockcount(), self.nodes[1].getblockchaininfo()["headers"])
        # The short-history guard (fewer than N ancestors -> powLimit) is
        # covered by pow_tests/pcoin_lwma_degenerate_inputs.


if __name__ == '__main__':
    LwmaTest(__file__).main()
