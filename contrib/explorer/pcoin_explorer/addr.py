"""Address recognition, offline.

The explorer never asks the node whether a string is an address -- it decodes
it here. That matters for one specific case the owner will hit on day one:
a freshly derived receive address (BIP84, m/84'/9444'/0'/0/i) has no history,
so it appears in no table of the index. Without a validator, searching for
your own new address would say "not found", which reads as "your address is
wrong". With one, it routes to an address page showing a zero balance, which
is the truth.

The constants below are PCoin's, not Bitcoin's, and are the *only* place in
the explorer that needs to know them (everything else reads addresses as
strings the node already decoded, per the indexer's design):

    bech32 hrp        main "pc"   test/testnet4/signet "tpc"   regtest "pcrt"
    base58 P2PKH      main 55     test/testnet4/signet 117     regtest 117
    base58 P2SH       main 56     test/testnet4/signet 118     regtest 118

    src/kernel/chainparams.cpp:198-204 (main), :289-295, :373-379, :487-493,
    :610-616.

A false positive here is harmless (you get a zero-balance page for a string
that is not really an address). A false *negative* is the bad outcome, because
it tells someone their address does not exist. The checksum tests below are
therefore the reference BIP173/BIP350 algorithms, not a prefix guess.
"""

import hashlib

BECH32_HRP = {"main": "pc", "test": "tpc", "testnet4": "tpc",
              "signet": "tpc", "regtest": "pcrt"}
BASE58_VERSIONS = {"main": (55, 56), "test": (117, 118), "testnet4": (117, 118),
                   "signet": (117, 118), "regtest": (117, 118)}

_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
_B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
_B58_MAP = {c: i for i, c in enumerate(_B58)}

BECH32_CONST = 1
BECH32M_CONST = 0x2BC830A3


# -- bech32 / bech32m (BIP173, BIP350 reference implementation) -------------

def _polymod(values):
    gen = (0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3)
    chk = 1
    for v in values:
        top = chk >> 25
        chk = ((chk & 0x1FFFFFF) << 5) ^ v
        for i in range(5):
            chk ^= gen[i] if ((top >> i) & 1) else 0
    return chk


def _hrp_expand(hrp):
    return [ord(c) >> 5 for c in hrp] + [0] + [ord(c) & 31 for c in hrp]


def bech32_decode(text):
    """-> (hrp, data5bit, spec) where spec is 'bech32' or 'bech32m'.

    Returns None for anything that is not a well-formed, correctly-checksummed
    bech32 string. Mixed case is rejected outright, as BIP173 requires.
    """
    if any(ord(c) < 33 or ord(c) > 126 for c in text):
        return None
    if text.lower() != text and text.upper() != text:
        return None
    text = text.lower()
    pos = text.rfind("1")
    if pos < 1 or pos + 7 > len(text) or len(text) > 90:
        return None
    hrp, tail = text[:pos], text[pos + 1:]
    if any(c not in _CHARSET for c in tail):
        return None
    data = [_CHARSET.index(c) for c in tail]
    chk = _polymod(_hrp_expand(hrp) + data)
    if chk == BECH32_CONST:
        spec = "bech32"
    elif chk == BECH32M_CONST:
        spec = "bech32m"
    else:
        return None
    return hrp, data[:-6], spec


def _convertbits(data, frm, to, pad=True):
    acc = 0
    bits = 0
    out = []
    maxv = (1 << to) - 1
    for value in data:
        if value < 0 or (value >> frm):
            return None
        acc = (acc << frm) | value
        bits += frm
        while bits >= to:
            bits -= to
            out.append((acc >> bits) & maxv)
    if pad:
        if bits:
            out.append((acc << (to - bits)) & maxv)
    elif bits >= frm or ((acc << (to - bits)) & maxv):
        return None
    return out


def decode_segwit(text, chain="main"):
    """-> (witness_version, program_bytes) or None."""
    got = bech32_decode(text)
    if got is None:
        return None
    hrp, data, spec = got
    if hrp != BECH32_HRP.get(chain, "pc"):
        return None
    if not data:
        return None
    version = data[0]
    program = _convertbits(data[1:], 5, 8, pad=False)
    if program is None or not 2 <= len(program) <= 40:
        return None
    if version > 16:
        return None
    if version == 0:
        if spec != "bech32" or len(program) not in (20, 32):
            return None
    elif spec != "bech32m":
        return None
    return version, bytes(program)


# -- base58check ------------------------------------------------------------

def base58_decode_check(text):
    """-> payload bytes (version byte first) or None."""
    if not text or len(text) > 120:
        return None
    num = 0
    for ch in text:
        digit = _B58_MAP.get(ch)
        if digit is None:
            return None
        num = num * 58 + digit
    raw = num.to_bytes((num.bit_length() + 7) // 8, "big") if num else b""
    pad = 0
    for ch in text:
        if ch == "1":
            pad += 1
        else:
            break
    raw = b"\x00" * pad + raw
    if len(raw) < 5:
        return None
    body, checksum = raw[:-4], raw[-4:]
    if hashlib.sha256(hashlib.sha256(body).digest()).digest()[:4] != checksum:
        return None
    return body


def classify(text, chain="main"):
    """Name the address type, or None if `text` is not a valid PCoin address
    on `chain`.

    Returns one of: 'P2PKH', 'P2SH', 'P2WPKH', 'P2WSH', 'P2TR',
    'witness_v<N>'.
    """
    if not text:
        return None
    sw = decode_segwit(text, chain)
    if sw is not None:
        version, program = sw
        if version == 0:
            return "P2WPKH" if len(program) == 20 else "P2WSH"
        if version == 1 and len(program) == 32:
            return "P2TR"
        return "witness_v%d" % version
    body = base58_decode_check(text)
    if body is not None and len(body) == 21:
        p2pkh, p2sh = BASE58_VERSIONS.get(chain, (55, 56))
        if body[0] == p2pkh:
            return "P2PKH"
        if body[0] == p2sh:
            return "P2SH"
    return None


def canonicalise(text, chain="main"):
    """Normalise a pasted address, or return None if it is not one.

    The only normalisation that is ever safe: bech32 is case-insensitive as a
    whole (BIP173 allows all-upper for QR codes and forbids mixing), and its
    canonical form -- the form the node emits and therefore the only form
    stored in the index -- is lowercase. Base58 is emphatically case-sensitive
    and is never touched.
    """
    if not text:
        return None
    text = text.strip()
    if decode_segwit(text, chain) is not None:
        return text.lower()
    body = base58_decode_check(text)
    if body is not None and len(body) == 21:
        if body[0] in BASE58_VERSIONS.get(chain, (55, 56)):
            return text
    return None


# -- "that is not a PCoin address" -----------------------------------------

# PCoin inherited Bitcoin's BIP32 version bytes (CLAUDE.md 6), which is exactly
# why the two chains' address formats must be told apart loudly rather than
# quietly failing to match. Someone pasting a Bitcoin address into a PCoin
# explorer deserves to be told what happened.
_FOREIGN_HRP = {"bc": "Bitcoin mainnet", "tb": "Bitcoin testnet",
                "bcrt": "Bitcoin regtest", "ltc": "Litecoin",
                "tltc": "Litecoin testnet"}
_FOREIGN_B58 = {0: "Bitcoin mainnet (P2PKH)", 5: "Bitcoin mainnet (P2SH)",
                111: "Bitcoin testnet (P2PKH)", 196: "Bitcoin testnet (P2SH)",
                48: "Litecoin (P2PKH)", 50: "Litecoin (P2SH)"}

# PCoin's own networks, named the way a person would say them.
_PCOIN_HRP_NETWORK = {"pc": "mainnet", "tpc": "test network", "pcrt": "regtest"}
_PCOIN_B58_NETWORK = {55: "mainnet", 56: "mainnet",
                      117: "test network", 118: "test network"}
_CHAIN_NAME = {"main": "mainnet", "test": "the test network",
               "testnet4": "the test network", "signet": "the test network",
               "regtest": "regtest"}


def foreign_hint(text, chain="main"):
    """If `text` is a valid address on some *other* chain, name it.

    Returns a human string or None. Only ever used to improve an error
    message; it never routes anywhere.
    """
    if not text:
        return None
    text = text.strip()
    serving = _CHAIN_NAME.get(chain, chain)
    got = bech32_decode(text)
    if got is not None:
        hrp = got[0]
        if hrp == BECH32_HRP.get(chain):
            return None                     # right network, bad program
        if hrp in _PCOIN_HRP_NETWORK:
            return ("a PCoin %s address, but this explorer is serving %s"
                    % (_PCOIN_HRP_NETWORK[hrp], serving))
        if hrp in _FOREIGN_HRP:
            return "a %s address, not a PCoin one" % _FOREIGN_HRP[hrp]
        return ("a bech32 address with the prefix %r; PCoin %s uses %r"
                % (hrp, serving, BECH32_HRP.get(chain)))
    body = base58_decode_check(text)
    if body is not None and len(body) == 21:
        version = body[0]
        if version in BASE58_VERSIONS.get(chain, (55, 56)):
            return None
        if version in _PCOIN_B58_NETWORK:
            return ("a PCoin %s address, but this explorer is serving %s"
                    % (_PCOIN_B58_NETWORK[version], serving))
        if version in _FOREIGN_B58:
            return "a %s address, not a PCoin one" % _FOREIGN_B58[version]
        return "a base58 address with version byte %d, which is not PCoin's" % version
    return None


def looks_like_attempted_address(text, chain="main"):
    """A string shaped like an address whose checksum did not verify.

    Distinguishing "typo in an address" from "random noise" is what lets the
    search box say 'check for a typo' instead of 'not found'.
    """
    if not text or not 20 <= len(text) <= 90:
        return False
    hrps = tuple(BECH32_HRP.values()) + tuple(_FOREIGN_HRP)
    low = text.lower()
    if any(low.startswith(h + "1") for h in hrps):
        return True
    return all(c in _B58 for c in text)
