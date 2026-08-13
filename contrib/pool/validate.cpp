// PCoin pool: share validator, step 1.
//
// Reads vectors on stdin (from make-vectors.sh), recomputes the RandomX hash of
// each 80-byte header, and checks it against the target encoded in nBits.
//
//   ./validate < vectors.txt          one-shot: verify real-block vectors
//   ./validate --serve                 long-lived: validate shares on a pipe
//
// SERVE MODE is what the pool actually uses. Building the RandomX VM costs
// ~834 ms; paying that per share would be fatal, so the pool spawns this once
// and keeps the pipe open. Protocol, one line each way:
//
//   in    <80-byte header hex> <32-byte target hex, big-endian>
//   out   ok|no <32-byte hash hex, big-endian(display) order>
//   out   err <reason>            malformed input -- NEVER exit
//
// A share validator that dies on a bad line takes the pool down with it, and
// bad lines are exactly what a hostile miner sends. Every parse failure is an
// `err` and the loop continues.
//
// WHY THIS EXISTS BEFORE ANY NETWORKING
// A pool must verify every share itself -- a miner that could not be checked
// could claim credit for work it never did. Verification is the one part of a
// RandomX pool that is genuinely hard, and it is the part that silently
// "works" while being wrong: a validator with the wrong byte order or the wrong
// key rejects every share, and one that never really hashes accepts every
// share. Both look like a running pool.
//
// So this is checked against blocks the CHAIN HAS ALREADY ACCEPTED. If the
// validator agrees with the network on 100 real blocks, its notion of the PoW
// is the network's notion. Nothing else proves that.
//
// It deliberately does NOT link Bitcoin Core -- only the vendored RandomX. The
// whole point is to isolate the hard part.
//
// Build: see build.sh

#include <randomx.h>

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

// The key is FIXED on every PCoin network and rotating it is PoW v2, a hard
// fork (src/crypto/pow_randomx.cpp). Monero re-keys every 2048 blocks and every
// Monero pool must manage that transition; here the VM is built once.
static const char* RANDOMX_KEY = "PCoin/RandomX/v1";

static bool unhex(const std::string& in, std::vector<uint8_t>& out)
{
    if (in.size() % 2) return false;
    out.clear();
    out.reserve(in.size() / 2);
    for (size_t i = 0; i < in.size(); i += 2) {
        auto nib = [](char c) -> int {
            if (c >= '0' && c <= '9') return c - '0';
            if (c >= 'a' && c <= 'f') return c - 'a' + 10;
            if (c >= 'A' && c <= 'F') return c - 'A' + 10;
            return -1;
        };
        const int hi = nib(in[i]), lo = nib(in[i + 1]);
        if (hi < 0 || lo < 0) return false;
        out.push_back(uint8_t((hi << 4) | lo));
    }
    return true;
}

// nBits -> 256-bit target, big-endian bytes. Same compact encoding Bitcoin
// uses; PCoin did not change it.
static void bits_to_target(uint32_t bits, uint8_t target[32])
{
    std::memset(target, 0, 32);
    const uint32_t exponent = bits >> 24;
    const uint32_t mantissa = bits & 0x007fffff;
    if (exponent <= 3) {
        const uint32_t m = mantissa >> (8 * (3 - exponent));
        target[31] = uint8_t(m & 0xff);
        if (exponent >= 2) target[30] = uint8_t((m >> 8) & 0xff);
        if (exponent >= 3) target[29] = uint8_t((m >> 16) & 0xff);
    } else {
        const int i = 32 - int(exponent);  // index of the mantissa's top byte
        if (i >= 0 && i + 2 < 32) {
            target[i]     = uint8_t((mantissa >> 16) & 0xff);
            target[i + 1] = uint8_t((mantissa >> 8) & 0xff);
            target[i + 2] = uint8_t(mantissa & 0xff);
        }
    }
}

// The PoW statement: RandomX(header) read LITTLE-endian is <= target. The hash
// comes out of RandomX as 32 little-endian bytes, so compare from the last byte
// down. Getting this backwards is the classic way to build a validator that
// rejects everything, which is why the real blocks below are the test.
static bool hash_le_target(const uint8_t hash[32], const uint8_t target_be[32])
{
    for (int i = 31; i >= 0; --i) {
        const uint8_t h = hash[i];             // hash[31] is the most significant
        const uint8_t t = target_be[31 - i];   // target is big-endian
        if (h < t) return true;
        if (h > t) return false;
    }
    return true;  // exactly equal is a valid solution
}

// Emit a 32-byte hash in display order (most significant byte first), which is
// the order every explorer and log will show.
static void print_hash_be(const uint8_t hash[32], char out[65])
{
    static const char* hexd = "0123456789abcdef";
    for (int i = 0; i < 32; ++i) {
        const uint8_t b = hash[31 - i];
        out[i * 2]     = hexd[b >> 4];
        out[i * 2 + 1] = hexd[b & 0xf];
    }
    out[64] = 0;
}

static int serve(randomx_vm* vm)
{
    // Unbuffered enough that the caller sees each verdict immediately; a pool
    // blocking on a share it already validated is a hang nobody enjoys finding.
    std::string line;
    while (std::getline(std::cin, line)) {
        if (line.empty()) continue;
        std::istringstream is(line);
        std::string hdr_hex, target_hex;
        if (!(is >> hdr_hex >> target_hex)) { std::printf("err need <header> <target>\n"); std::fflush(stdout); continue; }

        std::vector<uint8_t> hdr, target;
        if (!unhex(hdr_hex, hdr) || hdr.size() != 80) { std::printf("err header must be 80 bytes\n"); std::fflush(stdout); continue; }
        if (!unhex(target_hex, target) || target.size() != 32) { std::printf("err target must be 32 bytes\n"); std::fflush(stdout); continue; }

        uint8_t hash[RANDOMX_HASH_SIZE];
        randomx_calculate_hash(vm, hdr.data(), hdr.size(), hash);
        char hex[65];
        print_hash_be(hash, hex);
        std::printf("%s %s\n", hash_le_target(hash, target.data()) ? "ok" : "no", hex);
        std::fflush(stdout);
    }
    return 0;
}

int main(int argc, char** argv)
{
    const bool serve_mode = (argc > 1 && std::string(argv[1]) == "--serve");
    randomx_flags flags = randomx_get_flags();
    randomx_cache* cache = randomx_alloc_cache(flags);
    if (!cache) {  // same degradation the node does
        flags = RANDOMX_FLAG_DEFAULT;
        cache = randomx_alloc_cache(flags);
    }
    if (!cache) { std::fprintf(stderr, "could not allocate a RandomX cache\n"); return 2; }
    randomx_init_cache(cache, RANDOMX_KEY, std::strlen(RANDOMX_KEY));

    randomx_vm* vm = randomx_create_vm(flags, cache, nullptr);
    if (!vm) {
        vm = randomx_create_vm(randomx_flags(flags | RANDOMX_FLAG_SECURE), cache, nullptr);
    }
    if (!vm) { randomx_release_cache(cache); std::fprintf(stderr, "could not create a RandomX VM\n"); return 2; }

    if (serve_mode) {
        std::fprintf(stderr, "ready\n");   // the pool waits for this before sending
        const int rc = serve(vm);
        randomx_destroy_vm(vm);
        randomx_release_cache(cache);
        return rc;
    }

    size_t total = 0, ok = 0;
    std::string line;
    while (std::getline(std::cin, line)) {
        if (line.empty() || line[0] == '#') continue;
        std::istringstream is(line);
        std::string height, hdr_hex, bits_hex, blockhash;
        if (!(is >> height >> hdr_hex >> bits_hex)) continue;
        is >> blockhash;

        std::vector<uint8_t> hdr;
        if (!unhex(hdr_hex, hdr) || hdr.size() != 80) {
            std::printf("  height %-6s MALFORMED header (%zu bytes)\n", height.c_str(), hdr.size());
            ++total;
            continue;
        }
        const uint32_t bits = uint32_t(std::stoul(bits_hex, nullptr, 16));
        uint8_t target[32];
        bits_to_target(bits, target);

        uint8_t hash[RANDOMX_HASH_SIZE];
        randomx_calculate_hash(vm, hdr.data(), hdr.size(), hash);

        ++total;
        if (hash_le_target(hash, target)) {
            ++ok;
        } else {
            std::printf("  height %-6s FAILED  bits=%s\n", height.c_str(), bits_hex.c_str());
            std::printf("      hash(le) ");
            for (int i = 31; i >= 0; --i) std::printf("%02x", hash[i]);
            std::printf("\n      target   ");
            for (int i = 0; i < 32; ++i) std::printf("%02x", target[i]);
            std::printf("\n");
        }
    }

    randomx_destroy_vm(vm);
    randomx_release_cache(cache);

    std::printf("\n  %zu/%zu real blocks verified\n", ok, total);
    if (total == 0) { std::printf("  NO VECTORS READ -- that is a failure, not a pass\n"); return 2; }
    if (ok != total) { std::printf("  VALIDATOR DISAGREES WITH THE CHAIN\n"); return 1; }
    std::printf("  the validator's notion of PoW matches the network's\n");
    return 0;
}
