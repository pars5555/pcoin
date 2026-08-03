"""Normative integer model of PCoin's LWMA-1, mirroring LwmaGetNextWorkRequired().

Also reproduces the legacy CalculateNextWorkRequired() 256-bit wraparound that
produced the height-2016 anomaly.
"""

MASK256 = (1 << 256) - 1


def set_compact(c):
    size = c >> 24
    word = c & 0x007fffff
    if size <= 3:
        word >>= 8 * (3 - size)
        return word
    return (word << (8 * (size - 3))) & MASK256


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


POW_LIMIT = int("000fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", 16)


def lwma(times, bits, N=60, T=600, ST=None, pow_limit=POW_LIMIT):
    """times/bits are the window newest-last: index 0 is block L-N (timestamp
    only), indices 1..N are blocks L-N+1..L.

    Solvetimes are measured against a running maximum of the timestamps, so they
    are never negative. That is a security requirement, not a simplification:
    consensus only forces a block's timestamp above its parent's median-time-
    past, so a miner may legally backdate its own blocks, and against raw
    solvetimes with an asymmetric clamp band the backdated block floors at -FTL
    while the honest block behind it caps at +ST, manufacturing apparent elapsed
    time and suppressing difficulty indefinitely.
    """
    assert len(times) == N + 1 and len(bits) == N + 1
    if ST is None:
        ST = 12 * T
    k = N * (N + 1) * T // 2
    denom = k * N
    assert 0 < denom <= 0xffffffff

    sum_target = 0
    t = 0
    prev = times[0]
    for i in range(1, N + 1):
        cur = max(times[i], prev)
        st = cur - prev
        prev = cur
        if st > ST:
            st = ST
        t += st * i
        target = set_compact(bits[i])
        assert target <= pow_limit
        sum_target += target // denom

    if t < k // 3:
        t = k // 3
    assert 0 < t <= 0xffffffff

    bn_new = sum_target * t
    assert bn_new <= (ST // T) * pow_limit, "overflow bound violated"
    if bn_new > pow_limit:
        bn_new = pow_limit
    if bn_new == 0:
        bn_new = 1
    return get_compact(bn_new)


def legacy(last_bits, last_time, first_time, timespan=1209600, pow_limit=POW_LIMIT):
    actual = last_time - first_time
    if actual < timespan // 4:
        actual = timespan // 4
    if actual > timespan * 4:
        actual = timespan * 4
    bn = set_compact(last_bits)
    bn = (bn * actual) & MASK256   # <-- the silent wraparound
    bn //= timespan
    if bn > pow_limit:
        bn = pow_limit
    return get_compact(bn)


def _vectors(n=30, N=60, T=600, ST=None, FTL=900, tip_bits=0x1e0b7c33):
    """Regenerate the expected values for pow_tests/pcoin_lwma_differential_vectors.

    Mirrors that test's LCG and window construction exactly. Keep the two in
    step: if either the generator or the algorithm changes, rerun this and paste
    the output over LWMA_EXPECTED.
    """
    if ST is None:
        ST = 12 * T
    mask64 = (1 << 64) - 1
    out = []
    for v in range(n):
        state = [(0x5EED0000 + v) & mask64]

        def nxt():
            state[0] = (state[0] * 6364136223846793005 + 1442695040888963407) & mask64
            return (state[0] >> 33) & 0x7fffffff

        t = 1500000000 + nxt() % 400000000
        times = [t]
        for _ in range(N):
            t += -4 * FTL + nxt() % (20 * T + 4 * FTL + 1)
            times.append(t)

        mode = v % 4
        bits = []
        for _ in range(N + 1):
            if mode == 0:
                target = POW_LIMIT
            elif mode == 1:
                target = set_compact(tip_bits)
            elif mode == 2:
                target = POW_LIMIT >> (nxt() % 120)
                target = target or 1
            else:
                hi = nxt() % (1 << 30)
                lo = nxt() % (1 << 30)
                target = ((hi << 30) + lo) | 1
            bits.append(get_compact(target))
        out.append(lwma(times, bits, N, T, ST))
    return out


if __name__ == "__main__":
    import sys
    if "--vectors" in sys.argv:
        vals = _vectors()
        for row in range(0, len(vals), 6):
            print("        " + " ".join("0x%08xU," % o for o in vals[row:row + 6]))
    else:
        print(__doc__)
