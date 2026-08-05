"""Parse a raw transaction and compute its txid, with the standard library only.

Why the API parses a transaction at all, when the node is perfectly capable of
doing it: CLAUDE.md section 7.6 -- *"if the transport can lose a response, every
operation on it must be idempotent, and the result must be verified by content
hash, not by 'the call returned'."* Broadcast is the one state-changing endpoint
here, and it runs over HTTP to a node that may be on another host. If the
response to ``sendrawtransaction`` is lost we must still be able to say *which*
transaction we were talking about, so the client can retry safely and so we can
ask the node "do you have this one?" instead of guessing.

Knowing the txid up front also lets the endpoint:
  * reject a malformed transaction before it ever reaches the node,
  * report the txid on an ambiguous outcome instead of returning nothing,
  * ask ``getmempoolentry <txid>`` afterwards for the honest propagation signal.

PCoin note: PoW is RandomX, but transaction and block *ids* are still plain
double-SHA256 (CLAUDE.md section 3). Nothing here needs to know PoW exists, and
nothing here needs the network magic, the bech32 hrp or the base58 versions --
this is consensus-neutral serialisation only, identical to upstream v29.4.
"""

import hashlib

# MAX_STANDARD_TX_WEIGHT is 400 000 (policy.h), i.e. at most 400 000 bytes of
# non-witness data in the pathological case. This is a transport ceiling, not a
# policy check -- the node remains the authority on what it will accept.
MAX_TX_BYTES = 400_000
MIN_TX_BYTES = 60          # version + 1 in + 1 out + locktime, roughly

# A segwit transaction serialises a zero input count as the marker, followed by
# this flag byte, before the real input count (BIP144).
SEGWIT_FLAG = 0x01


class TxParseError(ValueError):
    """The bytes offered are not a well-formed transaction."""


def _dsha256(data):
    return hashlib.sha256(hashlib.sha256(data).digest()).digest()


def _rhex(digest):
    """Bitcoin displays hashes byte-reversed."""
    return digest[::-1].hex()


class _Reader:
    __slots__ = ("buf", "pos")

    def __init__(self, buf):
        self.buf = buf
        self.pos = 0

    def take(self, n):
        if n < 0:
            raise TxParseError("negative read")
        end = self.pos + n
        if end > len(self.buf):
            raise TxParseError("truncated transaction: wanted %d more byte(s) at "
                               "offset %d, only %d available"
                               % (n, self.pos, len(self.buf) - self.pos))
        out = self.buf[self.pos:end]
        self.pos = end
        return out

    def uint(self, n):
        return int.from_bytes(self.take(n), "little")

    def varint(self):
        first = self.uint(1)
        if first < 0xFD:
            return first
        if first == 0xFD:
            return self.uint(2)
        if first == 0xFE:
            return self.uint(4)
        return self.uint(8)

    def varbytes(self):
        n = self.varint()
        # A length prefix larger than the whole buffer is the classic
        # allocate-4GB parser bug. `take` bounds-checks before allocating.
        return self.take(n)

    @property
    def remaining(self):
        return len(self.buf) - self.pos


def parse_tx(raw):
    """Parse a serialised transaction.

    Returns a dict with txid, wtxid, version, locktime, vin, vout, sizes and
    whether it carries witness data. Raises TxParseError on anything malformed,
    including trailing bytes -- a transaction with junk appended is not a
    transaction, and accepting it would mean the txid we report is not the txid
    of what we sent.
    """
    if not isinstance(raw, (bytes, bytearray)):
        raise TxParseError("expected bytes")
    raw = bytes(raw)
    if len(raw) < MIN_TX_BYTES:
        raise TxParseError("too short to be a transaction (%d bytes)" % len(raw))
    if len(raw) > MAX_TX_BYTES:
        raise TxParseError("transaction is %d bytes, over the %d byte ceiling"
                           % (len(raw), MAX_TX_BYTES))

    r = _Reader(raw)
    version = r.uint(4)

    has_witness = False
    n_in = r.varint()
    if n_in == 0:
        # A zero input count is the segwit marker; the flag byte must follow.
        flag = r.uint(1)
        if flag != SEGWIT_FLAG:
            raise TxParseError("input count is 0 and the following byte is 0x%02x, "
                               "which is not the segwit flag 0x01" % flag)
        has_witness = True
        n_in = r.varint()
        if n_in == 0:
            raise TxParseError("segwit transaction with no inputs")

    vin = []
    for i in range(n_in):
        prev_hash = r.take(32)
        prev_n = r.uint(4)
        script = r.varbytes()
        sequence = r.uint(4)
        vin.append({
            "index": i,
            "prev_txid": _rhex(prev_hash),
            "prev_n": prev_n,
            "script_sig_hex": script.hex(),
            "sequence": sequence,
            "coinbase": prev_hash == b"\x00" * 32 and prev_n == 0xFFFFFFFF,
        })

    n_out = r.varint()
    if n_out == 0:
        raise TxParseError("transaction has no outputs")
    vout = []
    for i in range(n_out):
        value = r.uint(8)
        script = r.varbytes()
        vout.append({"n": i, "value_sat": value, "script_pub_key_hex": script.hex()})

    witness_start = r.pos
    if has_witness:
        for entry in vin:
            items = []
            for _ in range(r.varint()):
                items.append(r.varbytes().hex())
            entry["witness"] = items
    witness_end = r.pos

    locktime = r.uint(4)
    if r.remaining:
        raise TxParseError("%d trailing byte(s) after the transaction"
                           % r.remaining)

    # The txid is over the serialisation *without* marker, flag or witness.
    if has_witness:
        stripped = (raw[0:4]                       # version
                    + raw[6:witness_start]         # inputs + outputs (skip 00 01)
                    + raw[witness_end:])           # locktime
    else:
        stripped = raw

    txid = _rhex(_dsha256(stripped))
    wtxid = _rhex(_dsha256(raw)) if has_witness else txid

    base_size = len(stripped)
    total_size = len(raw)
    weight = base_size * 3 + total_size
    vsize = (weight + 3) // 4        # ceil(weight / 4), as GetVirtualTransactionSize

    return {
        "txid": txid,
        "wtxid": wtxid,
        "version": version,
        "locktime": locktime,
        "vin": vin,
        "vout": vout,
        "has_witness": has_witness,
        "size": total_size,
        "strippedsize": base_size,
        "weight": weight,
        "vsize": vsize,
        "is_coinbase": len(vin) == 1 and vin[0]["coinbase"],
    }


def parse_hex(hexstr):
    """Validate and parse a hex-encoded transaction.

    Validation is deliberately strict and happens before the node is contacted:
    a client that sends something other than a signed transaction gets a clear
    400 from us instead of an opaque error from the node, and the node is never
    asked to parse arbitrary attacker-supplied bytes.
    """
    if not isinstance(hexstr, str):
        raise TxParseError("expected a hex string, got %s" % type(hexstr).__name__)
    s = hexstr.strip()
    if not s:
        raise TxParseError("empty transaction hex")
    if len(s) % 2:
        raise TxParseError("transaction hex has an odd length (%d)" % len(s))
    if len(s) > MAX_TX_BYTES * 2:
        raise TxParseError("transaction hex is %d characters, over the %d ceiling"
                           % (len(s), MAX_TX_BYTES * 2))
    stripped = s.lower()
    if any(c not in "0123456789abcdef" for c in stripped):
        raise TxParseError("transaction hex contains a non-hex character")
    try:
        raw = bytes.fromhex(stripped)
    except ValueError as exc:                                # pragma: no cover
        raise TxParseError(str(exc)) from exc
    parsed = parse_tx(raw)
    if parsed["is_coinbase"]:
        # A coinbase can only be created by a miner inside a block; offering one
        # here is always a mistake and the node would reject it anyway.
        raise TxParseError("this is a coinbase transaction and cannot be relayed")
    parsed["hex"] = stripped
    return parsed
