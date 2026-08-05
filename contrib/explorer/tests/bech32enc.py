"""A bech32/bech32m *encoder*, for tests only.

The explorer itself only ever decodes -- it must never derive or construct an
address, because it is non-custodial (see ``pcoin_explorer/__init__.py``). The
tests need to mint plausible PCoin addresses that are not in the index, so the
encoder lives here, in the test tree, where nothing shipped can reach it.
"""

from pcoin_explorer.addr import _CHARSET, _convertbits, _hrp_expand, _polymod

BECH32_CONST = 1
BECH32M_CONST = 0x2BC830A3


def bech32_encode(hrp, data, spec="bech32"):
    const = BECH32_CONST if spec == "bech32" else BECH32M_CONST
    poly = _polymod(_hrp_expand(hrp) + data + [0, 0, 0, 0, 0, 0]) ^ const
    checksum = [(poly >> 5 * (5 - i)) & 31 for i in range(6)]
    return hrp + "1" + "".join(_CHARSET[d] for d in data + checksum)


def p2wpkh(hash20, hrp="pc"):
    return bech32_encode(hrp, [0] + _convertbits(list(hash20), 8, 5))


def p2wsh(hash32, hrp="pc"):
    return bech32_encode(hrp, [0] + _convertbits(list(hash32), 8, 5))


def p2tr(key32, hrp="pc"):
    return bech32_encode(hrp, [1] + _convertbits(list(key32), 8, 5), "bech32m")


def address_n(i, hrp="pc"):
    """A deterministic, distinct, valid P2WPKH address for index `i`."""
    return p2wpkh(bytes([(i + 7) % 251] * 20), hrp)
