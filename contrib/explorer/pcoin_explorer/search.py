"""One search box, routed.

The owner's request was "it should be possible to search for address or
transaction", so this is the product. Getting it right means three things:

* **Never route to the wrong kind.** The three input shapes overlap less than
  they look -- a height is decimal, an id is 64 hex characters, an address
  carries its own checksum -- so every branch below is decided by a positive
  test, never by elimination.
* **Never answer "not found" when the truth is something more useful.** A valid
  address with no history is a real address with a zero balance. An address
  from another chain is a wrong-network mistake. An address with a broken
  checksum is a typo. A short hex string is a truncated id. Each of those is a
  different message.
* **Never let "the index has not caught up" look like "it does not exist".**
  When nothing matches and the index is behind or stale, the caller is told to
  say so (CLAUDE.md 7.1/7.2: an unanswerable question must not collapse into a
  definite negative).

Return shape: a dict with ``kind`` in
``block | tx | address | ambiguous | invalid | not_found | empty``.
A ``block``/``tx``/``address`` result carries ``target``, the canonical path to
redirect to.
"""

from pcoin_indexer import queries

from . import addr as addrmod
from . import reads

HEX = set("0123456789abcdef")
DECIMAL = set("0123456789")
MAX_HEIGHT = 2 ** 62            # anything larger cannot be a SQLite integer
MIN_PREFIX = 8                  # below this, a hex prefix matches too much
MAX_AMBIGUOUS = 20


def _is_hex(text):
    return bool(text) and all(c in HEX for c in text)


def _is_decimal(text):
    """Strict ASCII digits.

    Not ``str.isdigit()``: that is true for '²' and for Arabic-Indic digits,
    and ``int('²')`` raises. A search box takes arbitrary text, so the check
    that decides whether something is a block height has to be exact.
    """
    return bool(text) and all(c in DECIMAL for c in text)


def _strip_pasted_url(term):
    """Accept a pasted explorer URL or path, not just a bare identifier."""
    for marker in ("/tx/", "/block/", "/address/", "/blocks/", "/height/"):
        idx = term.rfind(marker)
        if idx >= 0:
            term = term[idx + len(marker):]
            break
    else:
        if "://" in term:
            term = term.rsplit("/", 1)[-1]
    for cut in ("?", "#"):
        if cut in term:
            term = term.split(cut, 1)[0]
    return term.strip().strip("/")


def normalise(term):
    if term is None:
        return ""
    term = term.strip().strip("​").strip()
    if len(term) >= 2 and term[0] == term[-1] and term[0] in "\"'":
        term = term[1:-1].strip()
    term = _strip_pasted_url(term)
    if term[:2].lower() == "0x" and _is_hex(term[2:].lower()):
        term = term[2:]
    return term


def _prefix_matches(conn, prefix):
    """Range scan on the primary/unique keys: `x >= prefix AND x < prefix+'g'`.

    Every txid and block hash in the index is 64 lowercase hex characters, and
    'g' sorts immediately above 'f', so this is an exact prefix match that the
    index can serve without a table scan.
    """
    lo, hi = prefix, prefix + "g"
    out = []
    for row in conn.execute(
            "SELECT txid AS id FROM txs WHERE txid >= ? AND txid < ? LIMIT ?",
            (lo, hi, MAX_AMBIGUOUS + 1)):
        out.append({"kind": "tx", "id": row["id"]})
    for row in conn.execute(
            "SELECT hash AS id, height FROM blocks WHERE hash >= ? AND hash < ? LIMIT ?",
            (lo, hi, MAX_AMBIGUOUS + 1)):
        out.append({"kind": "block", "id": row["id"], "height": row["height"]})
    for row in conn.execute(
            "SELECT hash AS id, height FROM orphaned_blocks"
            " WHERE hash >= ? AND hash < ? LIMIT ?", (lo, hi, MAX_AMBIGUOUS + 1)):
        out.append({"kind": "block", "id": row["id"], "height": row["height"],
                    "orphaned": True})
    return out[:MAX_AMBIGUOUS + 1]


def route(conn, term, *, chain="main"):
    raw = term or ""
    q = normalise(raw)
    if not q:
        return {"kind": "empty", "query": raw}

    tip = queries.tip_height(conn)

    # 1. A decimal string is a block height. No address is decimal-only
    #    (base58 has no '0' and bech32 has a letter prefix), and no id is
    #    64 characters of decimal in practice -- and even if one were, the
    #    64-hex branch below is reached first for anything that long.
    if _is_decimal(q) and len(q) != 64:
        height = int(q)
        row = None
        if height <= MAX_HEIGHT:
            row = conn.execute("SELECT hash FROM blocks WHERE height = ?",
                               (height,)).fetchone()
        if row:
            return {"kind": "block", "query": q, "target": "/block/%d" % height,
                    "height": height, "hash": row["hash"]}
        return {"kind": "not_found", "query": q, "shape": "height",
                "detail": ("no block at height %d -- the index holds heights 0..%d"
                           % (height, tip)) if tip >= 0 else
                          "the index is empty",
                "tip": tip}

    # 2. A checksummed address. Checked before any hex handling because the
    #    checksum is a far stronger signal than "these characters are hex":
    #    a base58 address can be all-hex-looking by chance, but it cannot
    #    accidentally carry a valid double-SHA256 checksum.
    canonical = addrmod.canonicalise(q, chain)
    if canonical:
        seen = reads.address_exists(conn, canonical)
        return {"kind": "address", "query": q, "target": "/address/%s" % canonical,
                "address": canonical, "seen": seen,
                "type": addrmod.classify(canonical, chain)}

    # 3. A full 64-character identifier: transaction first, then block, then a
    #    block this index once held and unwound (which is a real answer on a
    #    chain with a ~3% stale rate, not a 404).
    low = q.lower()
    if len(low) == 64 and _is_hex(low):
        if conn.execute("SELECT 1 FROM txs WHERE txid = ?", (low,)).fetchone():
            return {"kind": "tx", "query": q, "target": "/tx/%s" % low, "txid": low}
        row = conn.execute("SELECT height FROM blocks WHERE hash = ?",
                           (low,)).fetchone()
        if row:
            return {"kind": "block", "query": q, "target": "/block/%s" % low,
                    "hash": low, "height": row["height"]}
        if conn.execute("SELECT 1 FROM orphaned_blocks WHERE hash = ?",
                        (low,)).fetchone():
            return {"kind": "block", "query": q, "target": "/block/%s" % low,
                    "hash": low, "orphaned": True}
        return {"kind": "not_found", "query": q, "shape": "id",
                "detail": "no transaction or block with that id is in the index",
                "tip": tip}

    # 4. A truncated identifier. Common when an id is copied out of a log or a
    #    screenshot; an exact prefix match on the key is cheap.
    if MIN_PREFIX <= len(low) < 64 and _is_hex(low):
        matches = _prefix_matches(conn, low)
        if len(matches) == 1:
            m = matches[0]
            path = "/tx/%s" % m["id"] if m["kind"] == "tx" else "/block/%s" % m["id"]
            return {"kind": m["kind"], "query": q, "target": path,
                    "txid": m["id"], "hash": m["id"],
                    "height": m.get("height"), "prefix": True}
        if len(matches) > 1:
            return {"kind": "ambiguous", "query": q,
                    "matches": matches[:MAX_AMBIGUOUS],
                    "truncated": len(matches) > MAX_AMBIGUOUS}
        return {"kind": "not_found", "query": q, "shape": "id-prefix",
                "detail": "nothing in the index starts with that hex prefix",
                "tip": tip}

    # 5. Address-shaped but not a PCoin address on this chain.
    hint = addrmod.foreign_hint(q, chain)
    if hint:
        return {"kind": "invalid", "query": q, "shape": "foreign-address",
                "detail": "that is %s" % hint}
    if addrmod.looks_like_attempted_address(q, chain):
        return {"kind": "invalid", "query": q, "shape": "address",
                "detail": ("that looks like an address but its checksum does not"
                           " verify -- check for a typo or a missing character")}
    if len(low) < 64 and _is_hex(low) and low:
        return {"kind": "invalid", "query": q, "shape": "short-hex",
                "detail": ("hex, but too short to identify anything -- paste at"
                           " least %d characters of a txid or block hash"
                           % MIN_PREFIX)}
    return {"kind": "not_found", "query": q, "shape": "unknown",
            "detail": ("not a block height, a transaction id, a block hash or a"
                       " PCoin address"),
            "tip": tip}
