#ifndef BITCOIN_CHAINPARAMSSEEDS_H
#define BITCOIN_CHAINPARAMSSEEDS_H
/**
 * List of fixed seed nodes for the PCoin network.
 *
 * These are the addresses a node falls back to when it has no peers in its
 * addrman and DNS seeding produced nothing -- because the DNS seed is down, or
 * because DNS is blocked or filtered, or because the node was started with
 * -dnsseed=0. Without them, the single DNS name (seed.pc.am) is a single point
 * of failure for joining the network at all.
 *
 * FORMAT. Each line is one BIP155-serialized (networkID, address, port) tuple:
 *
 *   byte 0        network id: 1 = IPv4, 2 = IPv6, 4 = Tor v3, 5 = I2P, 6 = CJDNS
 *   byte 1..      CompactSize length of the address (4 for IPv4, 16 for IPv6,
 *                 32 for Tor v3 and I2P)
 *   then          the address bytes, most significant byte first
 *   last 2 bytes  the port, BIG endian
 *
 * So the first entry decodes as 1, 4, 35.239.156.16, 0x24e4 == 9444.
 *
 * ADDING MORE. Do not hand-assemble bytes. Write the endpoints, one per line,
 * as <ip>:<port> (or [<ipv6>]:<port>, or <onion>.onion:<port>) into
 * contrib/seeds/nodes_main.txt and regenerate:
 *
 *   python3 contrib/seeds/generate-seeds.py contrib/seeds
 *
 * then keep only the chainparams_seed_main array and restore this comment
 * block, neither of which the generator knows about. The bytes below were
 * produced by that generator, not by hand.
 *
 * Only list nodes that accept inbound connections on a stable address and are
 * expected to stay up. A dead fixed seed costs every new node a connection
 * timeout, and unlike a DNS seed record it cannot be withdrawn without shipping
 * a new release. That is why this list is short: only addresses verified to
 * exist belong in it.
 *
 * NOTE. The file this replaces was still Bitcoin's mainnet seed list. It was
 * dead code -- nothing #included it -- and that was the only thing stopping
 * PCoin nodes from dialling Bitcoin nodes. It is live now
 * (kernel/chainparams.cpp includes it), so nothing that is not a PCoin node may
 * ever appear here.
 *
 * Only mainnet has fixed seeds, so only that array is defined here. The test
 * networks and regtest deliberately have none; kernel/chainparams.cpp calls
 * vFixedSeeds.clear() for those.
 *
 * All three entries verified on 2026-08-04: resolving from seed.pc.am, and
 * accepting connections on tcp/9444.
 */
static const uint8_t chainparams_seed_main[] = {
    0x01,0x04,0x23,0xef,0x9c,0x10,0x24,0xe4, // 35.239.156.16:9444 -- seed.pc.am, GCP
    0x01,0x04,0x23,0xee,0x2f,0x0e,0x24,0xe4, // 35.238.47.14:9444  -- GCP
    0x01,0x04,0xb2,0x69,0x03,0x33,0x24,0xe4, // 178.105.3.51:9444  -- Hetzner
};

#endif // BITCOIN_CHAINPARAMSSEEDS_H
