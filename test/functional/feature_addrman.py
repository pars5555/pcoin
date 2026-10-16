#!/usr/bin/env python3
# Copyright (c) 2021-2022 The Bitcoin Core developers
# Distributed under the MIT software license, see the accompanying
# file COPYING or http://www.opensource.org/licenses/mit-license.php.
"""Test addrman functionality"""

import os

from test_framework.messages import ser_uint256, hash256, MAGIC_BYTES
from test_framework.netutil import ADDRMAN_NEW_BUCKET_COUNT, ADDRMAN_TRIED_BUCKET_COUNT, ADDRMAN_BUCKET_SIZE
from test_framework.test_framework import BitcoinTestFramework
from test_framework.util import assert_equal

def serialize_addrman(
    *,
    format=1,
    lowest_compatible=4,
    net_magic="regtest",
    bucket_key=1,
    len_new=None,
    len_tried=None,
    mock_checksum=None,
):
    new = []
    tried = []
    INCOMPATIBILITY_BASE = 32
    r = MAGIC_BYTES[net_magic]
    r += format.to_bytes(1, "little")
    r += (INCOMPATIBILITY_BASE + lowest_compatible).to_bytes(1, "little")
    r += ser_uint256(bucket_key)
    r += (len_new or len(new)).to_bytes(4, "little", signed=True)
    r += (len_tried or len(tried)).to_bytes(4, "little", signed=True)
    ADDRMAN_NEW_BUCKET_COUNT = 1 << 10
    r += (ADDRMAN_NEW_BUCKET_COUNT ^ (1 << 30)).to_bytes(4, "little", signed=True)
    for _ in range(ADDRMAN_NEW_BUCKET_COUNT):
        r += (0).to_bytes(4, "little", signed=True)
    checksum = hash256(r)
    r += mock_checksum or checksum
    return r


def write_addrman(peers_dat, **kwargs):
    with open(peers_dat, "wb") as f:
        f.write(serialize_addrman(**kwargs))


class AddrmanTest(BitcoinTestFramework):
    def set_test_params(self):
        self.num_nodes = 1

    def run_test(self):
        peers_dat = os.path.join(self.nodes[0].chain_path, "peers.dat")

        # PCoin: a corrupt peers.dat no longer stops the node. It is moved to
        # peers.dat.corrupt and the node starts with an empty address manager
        # (src/addrdb.cpp), because an unattended miner that refuses to start
        # stops earning with nothing to say so. Upstream asserted an init error
        # for every case below; each now asserts the quarantine instead.
        def assert_quarantined(reason):
            corrupt = peers_dat + ".corrupt"
            if os.path.exists(corrupt):
                os.remove(corrupt)
            with self.nodes[0].assert_debug_log([
                    f"Invalid or corrupt peers.dat ({reason}",
                    "and started with an empty address book",
            ]):
                self.start_node(0)
            assert_equal(self.nodes[0].getnodeaddresses(), [])
            assert_equal(os.path.exists(corrupt), True)
            assert_equal(os.path.exists(peers_dat), True)

        self.log.info("Check that mocked addrman is valid")
        self.stop_node(0)
        write_addrman(peers_dat)
        with self.nodes[0].assert_debug_log(["Loaded 0 addresses from peers.dat"]):
            self.start_node(0, extra_args=["-checkaddrman=1"])
        assert_equal(self.nodes[0].getnodeaddresses(), [])

        self.log.info("Check that addrman with negative lowest_compatible is quarantined")
        self.stop_node(0)
        write_addrman(peers_dat, lowest_compatible=-32)
        assert_quarantined(
            "Corrupted addrman database: The compat value (0) is lower "
            "than the expected minimum value 32."
        )

        self.log.info("Check that addrman from future is overwritten with new addrman")
        self.stop_node(0)
        write_addrman(peers_dat, lowest_compatible=111)
        assert_equal(os.path.exists(peers_dat + ".bak"), False)
        with self.nodes[0].assert_debug_log([
                f'Creating new peers.dat because the file version was not compatible ("{peers_dat}"). Original backed up to peers.dat.bak',
        ]):
            self.start_node(0)
        assert_equal(self.nodes[0].getnodeaddresses(), [])
        assert_equal(os.path.exists(peers_dat + ".bak"), True)

        self.log.info("Check that corrupt addrman is quarantined (EOF)")
        self.stop_node(0)
        with open(peers_dat, "wb") as f:
            f.write(serialize_addrman()[:-1])
        assert_quarantined("AutoFile::read: end of file")

        self.log.info("Check that corrupt addrman is quarantined (magic)")
        self.stop_node(0)
        write_addrman(peers_dat, net_magic="signet")
        assert_quarantined("Invalid network magic number")

        self.log.info("Check that corrupt addrman is quarantined (checksum)")
        self.stop_node(0)
        write_addrman(peers_dat, mock_checksum=b"ab" * 32)
        assert_quarantined("Checksum mismatch, data corrupted")

        self.log.info("Check that corrupt addrman is quarantined (len_tried)")
        self.stop_node(0)
        max_len_tried = ADDRMAN_TRIED_BUCKET_COUNT * ADDRMAN_BUCKET_SIZE
        write_addrman(peers_dat, len_tried=-1)
        assert_quarantined(f"Corrupt AddrMan serialization: nTried=-1, should be in [0, {max_len_tried}]")

        self.log.info("Check that corrupt addrman is quarantined (large len_tried)")
        self.stop_node(0)
        write_addrman(peers_dat, len_tried=max_len_tried + 1)
        assert_quarantined(f"Corrupt AddrMan serialization: nTried={max_len_tried + 1}, should be in [0, {max_len_tried}]")

        self.log.info("Check that corrupt addrman is quarantined (len_new)")
        self.stop_node(0)
        max_len_new = ADDRMAN_NEW_BUCKET_COUNT * ADDRMAN_BUCKET_SIZE
        write_addrman(peers_dat, len_new=-1)
        assert_quarantined(f"Corrupt AddrMan serialization: nNew=-1, should be in [0, {max_len_new}]")

        self.log.info("Check that corrupt addrman is quarantined (large len_new)")
        self.stop_node(0)
        write_addrman(peers_dat, len_new=max_len_new + 1)
        assert_quarantined(f"Corrupt AddrMan serialization: nNew={max_len_new + 1}, should be in [0, {max_len_new}]")

        self.log.info("Check that corrupt addrman is quarantined (failed check)")
        self.stop_node(0)
        write_addrman(peers_dat, bucket_key=0)
        assert_quarantined("Corrupt data. Consistency check failed with code -16: ")

        self.log.info("Check that missing addrman is recreated")
        self.restart_node(0, clear_addrman=True)
        assert_equal(self.nodes[0].getnodeaddresses(), [])


if __name__ == "__main__":
    AddrmanTest(__file__).main()
