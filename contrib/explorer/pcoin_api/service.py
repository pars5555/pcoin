"""Payload builders. Everything the HTTP layer serves is assembled here.

Three rules run through the whole file, and every one of them exists because
getting it wrong is how an explorer tells a wallet a lie:

1. **Every response carries the index height.** `_index_block` goes on top of
   every payload -- not only the balance ones -- so a client can always see how
   far behind the index is and whether it has stopped moving. A balance without
   a height is unfalsifiable.

2. **Confirmed, immature and unconfirmed are never merged.** They are three
   different claims about three different things: money that is spendable now,
   money that consensus forbids spending for another N blocks, and money that no
   block has committed to at all.

3. **Unknown is its own state.** If the mempool has not been observed,
   `unconfirmed` is `{"known": false, "reason": ...}` and `spendable` is `null`.
   It is never `0`. CLAUDE.md section 7.1: *"model 'unknown' as its own state.
   Never let it collapse into 'no'."*

Nothing here derives an address, generates a key or signs anything.
"""

import datetime
import re

from pcoin_indexer import queries
from pcoin_indexer.amounts import from_sat
from pcoin_indexer.indexer import COINBASE_MATURITY

from .errors import ApiError, bad_request, not_found
from .nodeview import sat_per_vb_str

# Addresses on PCoin are bech32 (`pc1…`) or base58 (versions 55/56/183), both of
# which are alphanumeric. This is a *transport* guard -- it bounds the string
# before it reaches SQL, a log line or a JSON document -- and deliberately not a
# validity check: the index stores whatever string the node decoded, and this API
# never needs to know the hrp or the version bytes. An address that is well formed
# but has no history simply comes back with zeros and `used: false`.
ADDRESS_RE = re.compile(r"\A[0-9A-Za-z]{6,128}\Z")
HASH_RE = re.compile(r"\A[0-9a-fA-F]{64}\Z")
DECIMAL = frozenset("0123456789")

# Anything above this cannot be bound to a SQLite integer: sqlite3 raises
# OverflowError on the bind, which would surface as a 500 carrying a raw Python
# exception. Every place that turns request text into a height or a cursor is
# bounded by it.
MAX_HEIGHT = 2 ** 62


def is_decimal(text):
    """Strict ASCII digits.

    Not ``str.isdigit()``: that is True for '2' (superscript two) and for
    Arabic-Indic digits, while ``int()`` raises on both. This decides whether a
    path segment is a block height, and a path segment is arbitrary text.
    """
    return bool(text) and all(c in DECIMAL for c in text)


def parse_height(text):
    """A decimal path segment as a height, or a 400. Never an OverflowError."""
    value = int(text)
    if value > MAX_HEIGHT:
        raise bad_request("block height %s is out of range" % text)
    return value

DEFAULT_PAGE = 25
MAX_PAGE = 200
DEFAULT_UTXO_PAGE = 1000
MAX_UTXO_PAGE = 2000
MAX_ADDRESSES = 500

# What a wallet should actually pay on PCoin today. See `fees()` for why this is
# ten times the node's relay floor rather than equal to it.
RECOMMENDED_SAT_PER_KVB = 1000

# GetDustThreshold(): dustRelayFee * (serialized output size + spend cost) / 1000.
# DUST_RELAY_TX_FEE is a compile-time constant (src/policy/policy.h:64) that no
# RPC reports, so these are stated with their derivation rather than observed.
DUST_RELAY_TX_FEE_SAT_PER_KVB = 3000
_DUST_SIZES = {"p2wpkh": 31 + 67, "p2tr": 43 + 57.5, "p2pkh": 34 + 148,
               "p2sh": 32 + 148, "p2wsh": 43 + 67}


def iso(ts):
    if ts is None:
        return None
    return (datetime.datetime.fromtimestamp(int(ts), datetime.timezone.utc)
            .strftime("%Y-%m-%dT%H:%M:%SZ"))


def money(target, prefix, sat):
    """Write an amount as an exact integer *and* a fixed-point string.

    `_sat` is authoritative and is what a wallet must do arithmetic on. `_pcn` is
    a string, never a JSON float, because 106250.00000001 does not survive a
    round trip through an IEEE double and money that does not round-trip is a
    bug report waiting to happen.
    """
    target[prefix + "_sat"] = None if sat is None else int(sat)
    target[prefix + "_pcn"] = None if sat is None else from_sat(int(sat))
    return target


def parse_int(params, name, default, *, minimum, maximum):
    raw = params.get(name)
    if raw is None or raw == "":
        return default
    try:
        value = int(raw)
    except (TypeError, ValueError):
        raise bad_request("%s must be an integer, got %r" % (name, raw))
    if value < minimum or value > maximum:
        raise bad_request("%s must be between %d and %d, got %d"
                          % (name, minimum, maximum, value))
    return value


def parse_bool(params, name, default=False):
    raw = params.get(name)
    if raw is None or raw == "":
        return default
    low = str(raw).strip().lower()
    if low in ("1", "true", "yes", "on"):
        return True
    if low in ("0", "false", "no", "off"):
        return False
    raise bad_request("%s must be a boolean, got %r" % (name, raw))


def check_address(address):
    if not isinstance(address, str) or not ADDRESS_RE.match(address):
        raise bad_request(
            "not a usable address string: must be 6-128 alphanumeric characters")
    return address


def check_hash(value, what="hash"):
    if not isinstance(value, str) or not HASH_RE.match(value):
        raise bad_request("%s must be 64 hexadecimal characters" % what)
    return value.lower()


class Service:
    def __init__(self, store, node, *, max_addresses=MAX_ADDRESSES,
                 recommended_sat_per_kvb=RECOMMENDED_SAT_PER_KVB,
                 maturity=COINBASE_MATURITY):
        self.store = store
        self.node = node
        self.max_addresses = max_addresses
        self.recommended_sat_per_kvb = recommended_sat_per_kvb
        self.maturity = maturity

    # -- shared blocks ---------------------------------------------------
    def _index_block(self, conn):
        h = queries.health(conn)
        h["indexed_time"] = None
        row = conn.execute("SELECT time FROM blocks WHERE height=?",
                           (h["indexed_height"],)).fetchone()
        if row is not None:
            h["indexed_time"] = row["time"]
            h["indexed_time_iso"] = iso(row["time"])
        return h

    def _envelope(self, conn, snap=None):
        """The `index` block that sits on top of every response.

        `index.blocks_behind` is the *indexer's* own arithmetic, from the last
        node tip it observed. When this process has its own live observation the
        block also carries `blocks_behind_now`, which is measured against a tip
        seen seconds ago rather than at the indexer's last poll. Both are
        reported and neither overwrites the other: they are two measurements by
        two processes, and a client watching for a stalled indexer needs to be
        able to tell them apart.
        """
        block = self._index_block(conn)
        if snap is not None and snap.get("known"):
            node_height = snap.get("blocks")
            block["node_height_now"] = node_height
            block["node_observed_seconds_ago"] = snap.get("age_seconds")
            block["node_reachable"] = bool(snap.get("fresh"))
            if node_height is not None and block["indexed_height"] is not None:
                block["blocks_behind_now"] = node_height - block["indexed_height"]
        return {"index": block}

    def _mempool_block(self, snap):
        mem = snap.get("mempool") or {}
        block = {
            "known": bool(mem.get("known")),
            "node_reachable": bool(snap.get("fresh")),
            "observed_seconds_ago": snap.get("age_seconds"),
            "tx_count": mem.get("tx_count"),
        }
        if not block["known"]:
            block["reason"] = (mem.get("reason") or mem.get("error")
                               or snap.get("error")
                               or "the mempool has not been observed")
        if mem.get("incomplete_txids"):
            block["partial"] = True
            block["incomplete_tx_count"] = len(mem["incomplete_txids"])
        if mem.get("truncated"):
            # Observed, but not all of it. That is a third state and it has to
            # read as one: a client building a transaction needs to know that
            # "not spent in the mempool" was decided over a subset.
            block["partial"] = True
            block["truncated"] = True
            block["tracked_tx_count"] = mem.get("tracked_tx_count")
            block["truncated_detail"] = mem.get("truncated_detail")
        return block

    # -- status ----------------------------------------------------------
    def status(self, *, broadcast_state=None, server=None):
        snap = self.node.snapshot()
        with self.store.snapshot() as conn:
            out = self._envelope(conn, snap)
            stats = queries.chain_stats(conn)
            stats.pop("health", None)
            money(stats, "supply", stats.pop("supply_sat"))
            stats["block_time_iso"] = iso(stats.get("block_time"))
            out["chain"] = stats
        out["node"] = {
            # This is the API's own live observation of the node it talks to.
            # `index.node_height` is the *indexer's* last observation, which is a
            # different measurement made by a different process at a different
            # time. Both are reported; neither is derived from the other.
            "observed": bool(snap.get("known")),
            "reachable": bool(snap.get("fresh")),
            "error": snap.get("error"),
            "observed_seconds_ago": snap.get("age_seconds"),
            "chain": snap.get("chain"),
            "blocks": snap.get("blocks"),
            "headers": snap.get("headers"),
            "best_hash": snap.get("best_hash"),
            "initial_block_download": snap.get("initial_block_download"),
            "connections": snap.get("connections"),
        }
        out["mempool"] = self._mempool_block(snap)
        if broadcast_state is not None:
            out["broadcast"] = broadcast_state
        if server is not None:
            out["server"] = server
        return out

    def tip(self):
        snap = self.node.snapshot()
        with self.store.snapshot() as conn:
            out = self._envelope(conn, snap)
            row = conn.execute(
                "SELECT * FROM blocks ORDER BY height DESC LIMIT 1").fetchone()
            out["tip"] = None if row is None else self._block_row(dict(row), conn)
        return out

    # -- addresses -------------------------------------------------------
    def _pending_spend(self, conn, address, snap):
        """Confirmed, still-unspent outputs of `address` that a mempool
        transaction is consuming. `(None, None)` when the mempool is unknown."""
        mem = snap.get("mempool") or {}
        if not mem.get("known"):
            return None, None
        entry = (mem.get("by_address") or {}).get(address)
        if not entry:
            return 0, 0
        outpoints = [(s["txid"], s["vout"]) for s in entry["spends"]
                     if s.get("confirmed")]
        if not outpoints:
            return 0, 0
        # Re-check against the index rather than trusting the mempool view: the
        # spend may have been mined between the two observations, in which case
        # the output is already spent here and must not be subtracted twice.
        by_txid = {}
        for txid, n in outpoints:
            by_txid.setdefault(txid, set()).add(n)
        total = count = 0
        txids = list(by_txid)
        for i in range(0, len(txids), 400):
            chunk = txids[i:i + 400]
            rows = conn.execute(
                "SELECT txid, n, value FROM outputs WHERE txid IN (%s)"
                " AND address=? AND spent_height IS NULL AND unspendable=0"
                % ",".join("?" * len(chunk)), chunk + [address])
            for r in rows:
                if r["n"] in by_txid[r["txid"]]:
                    total += r["value"]
                    count += 1
        return total, count

    def _address_balance(self, conn, address, snap):
        # `with_health=False`: the health block is already on every response
        # (`_envelope`), and it is the same answer for every address in the
        # request. Recomputing it per address made POST /api/addresses with 500
        # addresses run 500 extra sync_state/tip queries for a value it discards.
        summary = queries.address_summary(conn, address, maturity=self.maturity,
                                          with_health=False)
        summary.pop("health", None)
        tip = summary["as_of_height"]
        immature_sat = summary["immature"]
        unspent_sat = summary["balance"]
        mature_sat = unspent_sat - immature_sat
        mature_count = summary["utxo_count"] - summary["immature_utxo_count"]
        pending_sat, pending_count = self._pending_spend(conn, address, snap)

        confirmed = {}
        money(confirmed, "mature", mature_sat)
        confirmed["mature_utxo_count"] = mature_count
        money(confirmed, "immature", immature_sat)
        confirmed["immature_utxo_count"] = summary["immature_utxo_count"]
        money(confirmed, "pending_spend", pending_sat)
        confirmed["pending_spend_utxo_count"] = pending_count
        money(confirmed, "spendable",
              None if pending_sat is None else mature_sat - pending_sat)
        confirmed["spendable_utxo_count"] = (None if pending_count is None
                                             else mature_count - pending_count)
        # mature + immature. Equal to what `gettxoutsetinfo` would attribute to
        # this address, and NOT what may be spent -- hence the name.
        money(confirmed, "onchain_unspent", unspent_sat)
        confirmed["utxo_count"] = summary["utxo_count"]
        confirmed["as_of_height"] = tip
        confirmed["maturity_blocks"] = self.maturity
        if pending_sat is None:
            confirmed["spendable_unknown_reason"] = self._mempool_block(snap).get(
                "reason", "the mempool has not been observed")

        unconfirmed = self.node.mempool_for_address(snap, address)
        if unconfirmed.get("known"):
            money(unconfirmed, "receiving", unconfirmed.pop("receiving_sat"))
            money(unconfirmed, "spending", unconfirmed.pop("spending_sat"))

        lifetime = {"tx_count": summary["tx_count"],
                    "first_height": summary["first_height"],
                    "last_height": summary["last_height"]}
        money(lifetime, "received", summary["received"])
        money(lifetime, "sent", summary["sent"])

        next_maturity = conn.execute(
            "SELECT MIN(maturity_height) m FROM outputs WHERE address=?"
            " AND spent_height IS NULL AND is_coinbase=1 AND unspendable=0"
            "   AND maturity_height > ?", (address, tip + 1)).fetchone()["m"]
        if next_maturity is not None:
            confirmed["next_maturity_height"] = next_maturity
            # In blocks, never as a clock: block spacing on PCoin is neither the
            # 600 s target nor stable, and it changes again at height 2800.
            confirmed["next_maturity_in_blocks"] = next_maturity - (tip + 1)

        return {"confirmed": confirmed, "unconfirmed": unconfirmed,
                "lifetime": lifetime}

    def address(self, address, params=None):
        check_address(address)
        params = params or {}
        history_limit = parse_int(params, "history", 10, minimum=0, maximum=MAX_PAGE)
        snap = self.node.snapshot()
        with self.store.snapshot() as conn:
            out = self._envelope(conn, snap)
            out["mempool"] = self._mempool_block(snap)
            out["address"] = address
            out["balance"] = self._address_balance(conn, address, snap)
            out["used"] = self._used(out["balance"])
            if history_limit:
                out["history"] = self._history_page(
                    conn, address, limit=history_limit, offset=0, cursor=None)
                out["unconfirmed_history"] = self._mempool_history(snap, address)
        return out

    @staticmethod
    def _used(balance):
        """Has this address ever been seen? `null` when we genuinely cannot say.

        A gap-limit scan stops after N consecutive unused addresses, so a `false`
        that should have been "I do not know" silently truncates somebody's
        wallet.
        """
        if balance["lifetime"]["tx_count"]:
            return True
        unconf = balance["unconfirmed"]
        if not unconf.get("known"):
            return None
        return bool(unconf.get("tx_count"))

    def addresses(self, address_list, params=None):
        params = params or {}
        if not isinstance(address_list, list) or not address_list:
            raise bad_request("provide a non-empty list of addresses")
        if len(address_list) > self.max_addresses:
            raise ApiError(413, "too_many_addresses",
                           "at most %d addresses per request, got %d"
                           % (self.max_addresses, len(address_list)),
                           max_addresses=self.max_addresses)
        seen = []
        for a in address_list:
            check_address(a)
            if a not in seen:
                seen.append(a)
        snap = self.node.snapshot()
        with self.store.snapshot() as conn:
            out = self._envelope(conn, snap)
            out["mempool"] = self._mempool_block(snap)
            results = []
            for a in seen:
                balance = self._address_balance(conn, a, snap)
                results.append({"address": a, "used": self._used(balance),
                                "balance": balance})
            out["addresses"] = results
            out["count"] = len(results)
            out["max_addresses"] = self.max_addresses
        return out

    def rich_list(self, params=None):
        params = params or {}
        limit = parse_int(params, "limit", 100, minimum=1, maximum=1000)
        offset = parse_int(params, "offset", 0, minimum=0, maximum=1_000_000)
        with self.store.snapshot() as conn:
            out = self._envelope(conn)
            rows = conn.execute(
                "SELECT address, balance, received, sent, tx_count, utxo_count,"
                " first_height, last_height FROM addresses WHERE balance > 0"
                " ORDER BY balance DESC, address ASC LIMIT ? OFFSET ?",
                (limit, offset)).fetchall()
            total = conn.execute(
                "SELECT COUNT(*) c FROM addresses WHERE balance > 0").fetchone()["c"]
            items = []
            for rank, r in enumerate(rows, start=offset + 1):
                d = {"rank": rank, "address": r["address"],
                     "tx_count": r["tx_count"], "utxo_count": r["utxo_count"],
                     "first_height": r["first_height"],
                     "last_height": r["last_height"]}
                # `onchain_unspent` and not `balance`: this figure includes
                # immature coinbase, which on a chain that is 99% coinbase is
                # most of it. Per-address detail is one request away.
                money(d, "onchain_unspent", r["balance"])
                money(d, "received", r["received"])
                money(d, "sent", r["sent"])
                items.append(d)
            out["addresses"] = items
            out["total"] = total
            out["limit"] = limit
            out["offset"] = offset
        return out

    # -- history ---------------------------------------------------------
    def _history_page(self, conn, address, *, limit, offset, cursor):
        sql = ("SELECT at.txid, at.height, at.block_index, at.received, at.sent,"
               " at.n_in, at.n_out, b.time, b.hash AS block_hash"
               " FROM address_txs at JOIN blocks b ON b.height = at.height"
               " WHERE at.address=?")
        args = [address]
        if cursor is not None:
            # Keyset pagination. Offsets shift under you when the chain reorgs
            # or extends between two pages; a key does not.
            sql += " AND (at.height < ? OR (at.height = ? AND at.block_index < ?))"
            args += [cursor[0], cursor[0], cursor[1]]
        sql += " ORDER BY at.height DESC, at.block_index DESC LIMIT ?"
        args.append(limit + 1)
        if cursor is None and offset:
            sql = sql.replace("LIMIT ?", "LIMIT ? OFFSET ?")
            args.append(offset)
        rows = conn.execute(sql, args).fetchall()
        more = len(rows) > limit
        rows = rows[:limit]
        tip = queries.tip_height(conn)
        items = []
        for r in rows:
            d = {"txid": r["txid"], "height": r["height"],
                 "block_hash": r["block_hash"], "block_index": r["block_index"],
                 "time": r["time"], "time_iso": iso(r["time"]),
                 "confirmations": tip - r["height"] + 1,
                 "n_in": r["n_in"], "n_out": r["n_out"]}
            money(d, "received", r["received"])
            money(d, "sent", r["sent"])
            money(d, "net", r["received"] - r["sent"])
            items.append(d)
        total = conn.execute("SELECT COUNT(*) c FROM address_txs WHERE address=?",
                             (address,)).fetchone()["c"]
        page = {"items": items, "total": total, "limit": limit, "has_more": more}
        if cursor is None:
            page["offset"] = offset
        if more and rows:
            last = rows[len(rows) - 1]
            page["next_cursor"] = "%d:%d" % (last["height"], last["block_index"])
        return page

    def _mempool_history(self, snap, address):
        mem = snap.get("mempool") or {}
        if not mem.get("known"):
            return {"known": False,
                    "reason": self._mempool_block(snap).get("reason"),
                    "items": None}
        entry = (mem.get("by_address") or {}).get(address)
        items = []
        for txid in (entry or {}).get("txids", []):
            info = (mem.get("entries") or {}).get(txid, {})
            received = sum(o["value_sat"] for o in entry["outputs"]
                           if o["txid"] == txid)
            sent = sum(s["value_sat"] for s in entry["spends"]
                       if s["spender_txid"] == txid)
            d = {"txid": txid, "height": None, "confirmations": 0,
                 "time": info.get("time"), "time_iso": iso(info.get("time")),
                 "vsize": info.get("vsize"), "unbroadcast": info.get("unbroadcast")}
            money(d, "received", received)
            money(d, "sent", sent)
            money(d, "net", received - sent)
            money(d, "fee", info.get("fee_sat"))
            items.append(d)
        return {"known": True, "items": items, "count": len(items)}

    def address_history(self, address, params=None):
        check_address(address)
        params = params or {}
        limit = parse_int(params, "limit", DEFAULT_PAGE, minimum=1, maximum=MAX_PAGE)
        offset = parse_int(params, "offset", 0, minimum=0, maximum=10_000_000)
        cursor = self._parse_cursor(params.get("cursor"))
        snap = self.node.snapshot()
        with self.store.snapshot() as conn:
            out = self._envelope(conn, snap)
            out["mempool"] = self._mempool_block(snap)
            out["address"] = address
            # Unconfirmed transactions are a separate array on purpose. Merging
            # them into the paged confirmed history would make page 2 shift every
            # time the mempool changed.
            out["unconfirmed"] = self._mempool_history(snap, address)
            out["confirmed"] = self._history_page(
                conn, address, limit=limit, offset=offset, cursor=cursor)
        return out

    @staticmethod
    def _parse_cursor(raw):
        if raw is None or raw == "":
            return None
        try:
            height, index = str(raw).split(":", 1)
            parsed = (int(height), int(index))
        except (TypeError, ValueError):
            raise bad_request("cursor must look like <height>:<block_index>")
        # An unbounded int binds to SQLite as an OverflowError, i.e. a 500 with a
        # raw Python exception in it. A cursor is server-issued, so anything
        # outside the representable range is a client that made one up.
        if any(v < 0 or v > MAX_HEIGHT for v in parsed):
            raise bad_request("cursor is out of range")
        return parsed

    # -- utxos -----------------------------------------------------------
    def address_utxos(self, address, params=None):
        check_address(address)
        params = params or {}
        limit = parse_int(params, "limit", DEFAULT_UTXO_PAGE, minimum=1,
                          maximum=MAX_UTXO_PAGE)
        offset = parse_int(params, "offset", 0, minimum=0, maximum=10_000_000)
        include_immature = parse_bool(params, "include_immature", False)
        include_pending = parse_bool(params, "include_pending_spend", False)
        include_unconfirmed = parse_bool(params, "include_unconfirmed", False)
        require_mempool = parse_bool(params, "require_mempool", False)

        snap = self.node.snapshot()
        mem = snap.get("mempool") or {}
        mempool_known = bool(mem.get("known"))
        mempool_truncated = bool(mem.get("truncated"))
        if require_mempool and not mempool_known:
            raise ApiError(
                503, "mempool_unknown",
                "require_mempool=1 was requested and the mempool could not be "
                "observed, so this API cannot tell you which of these outputs "
                "are already being spent: %s" % self._mempool_block(snap).get("reason"))
        if require_mempool and mempool_truncated:
            # A partial mempool answers "is this output already being spent?"
            # over a subset, i.e. it can answer "no" when the truth is "yes".
            # A caller that asked for a guarantee gets a 503, not that answer.
            raise ApiError(
                503, "mempool_truncated",
                "require_mempool=1 was requested and the mempool is larger than "
                "this process tracks, so 'not being spent' would be a guess: %s"
                % mem.get("truncated_detail"))
        spent_in_mempool = mem.get("spent_outpoints") or {}

        with self.store.snapshot() as conn:
            out = self._envelope(conn, snap)
            out["mempool"] = self._mempool_block(snap)
            out["address"] = address
            tip = queries.tip_height(conn)
            rows = conn.execute(
                "SELECT o.txid, o.n, o.value, o.height, o.is_coinbase,"
                " o.maturity_height, o.script_hex, o.script_type,"
                " b.hash AS block_hash, b.time AS block_time"
                " FROM outputs o JOIN blocks b ON b.height = o.height"
                " WHERE o.address=? AND o.spent_height IS NULL AND o.unspendable=0"
                " ORDER BY o.height ASC, o.txid ASC, o.n ASC", (address,)).fetchall()

            items = []
            counts = {"mature": 0, "immature": 0, "pending_spend": 0}
            totals = {"mature": 0, "immature": 0, "pending_spend": 0}
            for r in rows:
                mature = (not r["is_coinbase"]) or r["maturity_height"] <= tip + 1
                pending = (r["txid"], r["n"]) in spent_in_mempool
                bucket = ("immature" if not mature
                          else "pending_spend" if pending else "mature")
                counts[bucket] += 1
                totals[bucket] += r["value"]
                if bucket == "immature" and not include_immature:
                    continue
                if bucket == "pending_spend" and not include_pending:
                    continue
                d = {"txid": r["txid"], "vout": r["n"], "height": r["height"],
                     "block_hash": r["block_hash"], "block_time": r["block_time"],
                     "block_time_iso": iso(r["block_time"]),
                     "confirmations": tip - r["height"] + 1,
                     "is_coinbase": bool(r["is_coinbase"]),
                     "maturity_height": r["maturity_height"],
                     "mature": mature,
                     "spent_in_mempool": pending if mempool_known else None,
                     "spendable": (mature and not pending) if mempool_known else None,
                     "status": "confirmed",
                     "script_hex": r["script_hex"], "script_type": r["script_type"]}
                money(d, "value", r["value"])
                items.append(d)

            unconfirmed_items = []
            if include_unconfirmed and mempool_known:
                entry = (mem.get("by_address") or {}).get(address)
                for o in (entry or {}).get("outputs", []):
                    if (o["txid"], o["vout"]) in spent_in_mempool:
                        continue
                    d = {"txid": o["txid"], "vout": o["vout"], "height": None,
                         "block_hash": None, "block_time": None,
                         "confirmations": 0, "is_coinbase": False,
                         "maturity_height": None, "mature": True,
                         "spent_in_mempool": False, "spendable": True,
                         "status": "unconfirmed",
                         "script_hex": o.get("script_hex"),
                         "script_type": o.get("script_type")}
                    money(d, "value", o["value_sat"])
                    unconfirmed_items.append(d)

            # The whole unspent set is materialised before slicing, because the
            # summary has to count buckets the page does not contain. The chain
            # holds ~140 UTXOs in total today and the largest single address
            # holds 38, so this is bounded by the index being small -- if that
            # ever stops being true, the buckets become three COUNT/SUM queries
            # and the page becomes a LIMIT.
            combined = items + unconfirmed_items
            total_items = len(combined)
            page = combined[offset:offset + limit]
            out["utxos"] = page
            out["count"] = len(page)
            out["total"] = total_items
            out["limit"] = limit
            out["offset"] = offset
            out["has_more"] = offset + len(page) < total_items
            out["as_of_height"] = tip

            # `summary` describes ALL of the address's unspent outputs, whichever
            # of them the filters let through, so a client can see what it is not
            # being shown.
            summary = {"mempool_filtered": mempool_known}
            for bucket in ("mature", "immature"):
                money(summary, bucket, totals[bucket])
                summary[bucket + "_count"] = counts[bucket]
            # With no mempool observation nothing lands in the pending bucket --
            # but that is ignorance, not zero, and it has to read as ignorance
            # here for the same reason it does in /api/address.
            money(summary, "pending_spend",
                  totals["pending_spend"] if mempool_known else None)
            summary["pending_spend_count"] = (counts["pending_spend"]
                                              if mempool_known else None)
            money(summary, "spendable",
                  totals["mature"] if mempool_known else None)
            summary["spendable_count"] = counts["mature"] if mempool_known else None
            out["summary"] = summary

            out["filters"] = {"include_immature": include_immature,
                              "include_pending_spend": include_pending,
                              "include_unconfirmed": include_unconfirmed}
            warnings = []
            if not mempool_known:
                warnings.append(
                    "The mempool could not be observed (%s). This list may contain "
                    "outputs an unconfirmed transaction is already spending; "
                    "building a transaction from it risks a double-spend of your "
                    "own coins. Pass require_mempool=1 to get a 503 instead."
                    % self._mempool_block(snap).get("reason"))
            if mempool_truncated:
                warnings.append(
                    "The mempool was only partly observed (%s), so an output "
                    "listed here as spendable may already be spent by an "
                    "unconfirmed transaction. Pass require_mempool=1 to get a "
                    "503 instead." % mem.get("truncated_detail"))
            index_health = out["index"]
            if index_health.get("stale"):
                warnings.append(
                    "The index is stale (%s); newer outputs may be missing."
                    % "; ".join(index_health.get("stale_reasons") or []))
            out["warnings"] = warnings
        return out

    # -- transactions ----------------------------------------------------
    def transaction(self, txid, params=None):
        check_hash(txid, "txid")
        txid = txid.lower()
        snap = self.node.snapshot()
        with self.store.snapshot() as conn:
            out = self._envelope(conn, snap)
            out["mempool"] = self._mempool_block(snap)
            tx = queries.transaction(conn, txid)
            if tx is not None:
                tx.pop("health", None)
                out["tx"] = self._decorate_tx(tx, conn)
                return out
            mem_tx = self._mempool_tx(snap, txid)
            if mem_tx is not None:
                out["tx"] = mem_tx
                return out
        raise not_found(
            "no transaction %s in the index or the observed mempool" % txid,
            conclusive=not out["index"].get("stale"),
            index_height=out["index"].get("indexed_height"),
            detail=("The index is stale, so this is not a conclusive answer."
                    if out["index"].get("stale") else
                    "The index is current, so this transaction is not in any block "
                    "up to the height reported in `index`."))

    def _decorate_tx(self, tx, conn):
        block_time = tx.get("block_time")
        tx["time_iso"] = iso(block_time)
        tx["block_time_iso"] = iso(block_time)
        tx["mediantime_iso"] = iso(tx.get("block_mediantime"))
        tx["status"] = "confirmed"
        for key in ("value_in", "value_out", "fee"):
            money(tx, key, tx.pop(key))
        # queries.py computes this as a Python float; recompute it as an exact
        # integer ratio rendered to a string, so no money-adjacent number in a
        # response is ever an IEEE double.
        tx.pop("fee_rate_sat_vb", None)
        if tx.get("vsize"):
            tx["fee_rate_sat_per_vb"] = sat_per_vb_str(
                (tx["fee_sat"] * 1000) // tx["vsize"])
        else:                                                # pragma: no cover
            tx["fee_rate_sat_per_vb"] = None
        for i in tx.get("inputs") or []:
            money(i, "value", i.pop("value"))
        for o in tx.get("outputs") or []:
            money(o, "value", o.pop("value"))
            o["unspendable"] = bool(o["unspendable"])
            o["is_coinbase"] = bool(o["is_coinbase"])
        tx["is_coinbase"] = bool(tx["is_coinbase"])
        if tx["is_coinbase"]:
            tip = queries.tip_height(conn)
            tx["matures_at_height"] = tx["height"] + self.maturity
            tx["mature"] = tx["matures_at_height"] <= tip + 1
            tx["maturity_in_blocks"] = max(0, tx["matures_at_height"] - (tip + 1))
        return tx

    def _mempool_tx(self, snap, txid):
        mem = snap.get("mempool") or {}
        if not mem.get("known"):
            return None
        info = (mem.get("entries") or {}).get(txid)
        if info is None:
            return None
        out = {"txid": txid, "status": "unconfirmed", "confirmations": 0,
               "height": None, "block_hash": None,
               "time": info.get("time"), "time_iso": iso(info.get("time")),
               "vsize": info.get("vsize"), "depends": info.get("depends"),
               "unbroadcast": info.get("unbroadcast"),
               "in_mempool": True}
        money(out, "fee", info.get("fee_sat"))
        if info.get("fee_sat") is not None and info.get("vsize"):
            out["fee_rate_sat_per_vb"] = sat_per_vb_str(
                (info["fee_sat"] * 1000) // info["vsize"])
        # Inputs and outputs of an unconfirmed transaction, as far as this API
        # could attribute them. Each spend and each output belongs to exactly one
        # address entry, so one pass is enough. Inputs whose source could not be
        # resolved at all are absent, and `partial` below says so.
        ins, outs = [], []
        for entry_address, entry in (mem.get("by_address") or {}).items():
            for s in entry["spends"]:
                if s["spender_txid"] == txid:
                    d = {"prev_txid": s["txid"], "prev_n": s["vout"],
                         "address": entry_address}
                    money(d, "value", s["value_sat"])
                    ins.append(d)
            for o in entry["outputs"]:
                if o["txid"] == txid:
                    d = {"n": o["vout"], "address": entry_address,
                         "script_type": o.get("script_type"),
                         "script_hex": o.get("script_hex")}
                    money(d, "value", o["value_sat"])
                    outs.append(d)
        out["inputs"] = sorted(ins, key=lambda d: (d["prev_txid"], d["prev_n"]))
        out["outputs"] = sorted(outs, key=lambda d: d["n"])
        if txid in (mem.get("incomplete_txids") or []):
            out["partial"] = True
            out["partial_detail"] = ("some inputs of this transaction could not be "
                                     "attributed to an address")
        return out

    # -- blocks ----------------------------------------------------------
    def _block_row(self, d, conn):
        d["time_iso"] = iso(d.get("time"))
        d["mediantime_iso"] = iso(d.get("mediantime"))
        for key in ("value_out", "total_fees", "subsidy", "coinbase_out"):
            if key in d:
                money(d, key, d.pop(key))
        return d

    def block(self, ident, params=None):
        params = params or {}
        limit = parse_int(params, "limit", MAX_PAGE, minimum=0, maximum=2000)
        offset = parse_int(params, "offset", 0, minimum=0, maximum=10_000_000)
        if isinstance(ident, str):
            if is_decimal(ident):
                parse_height(ident)
            else:
                check_hash(ident, "block hash")
                ident = ident.lower()
        with self.store.snapshot() as conn:
            out = self._envelope(conn)
            b = queries.block(conn, ident, with_txids=False)
            if b is None:
                raise not_found("no block %s in the index" % ident)
            if b.get("orphaned"):
                # A block this index once held and later unwound. Reported as an
                # answer rather than a 404, because "I saw that block and it lost
                # a reorg" is a different fact from "I have never heard of it".
                b["time_iso"] = iso(b.get("time"))
                b["unwound_at_iso"] = iso(b.get("unwound_ts"))
                out["block"] = b
                return out
            b = self._block_row(b, conn)
            total = conn.execute("SELECT COUNT(*) c FROM txs WHERE height=?",
                                 (b["height"],)).fetchone()["c"]
            txids = [r["txid"] for r in conn.execute(
                "SELECT txid FROM txs WHERE height=? ORDER BY block_index"
                " LIMIT ? OFFSET ?", (b["height"], limit, offset))]
            b["txids"] = txids
            b["tx_count"] = total
            b["tx_page"] = {"limit": limit, "offset": offset,
                            "has_more": offset + len(txids) < total}
            out["block"] = b
        return out

    def block_txs(self, ident, params=None):
        params = params or {}
        limit = parse_int(params, "limit", 25, minimum=1, maximum=50)
        offset = parse_int(params, "offset", 0, minimum=0, maximum=10_000_000)
        if isinstance(ident, str):
            if is_decimal(ident):
                parse_height(ident)
            else:
                check_hash(ident, "block hash")
                ident = ident.lower()
        with self.store.snapshot() as conn:
            out = self._envelope(conn)
            b = queries.block(conn, ident, with_txids=False)
            if b is None or b.get("orphaned"):
                raise not_found("no block %s on the indexed chain" % ident)
            total = conn.execute("SELECT COUNT(*) c FROM txs WHERE height=?",
                                 (b["height"],)).fetchone()["c"]
            txids = [r["txid"] for r in conn.execute(
                "SELECT txid FROM txs WHERE height=? ORDER BY block_index"
                " LIMIT ? OFFSET ?", (b["height"], limit, offset))]
            txs = []
            for t in txids:
                tx = queries.transaction(conn, t)
                tx.pop("health", None)
                txs.append(self._decorate_tx(tx, conn))
            out["height"] = b["height"]
            out["block_hash"] = b["hash"]
            out["txs"] = txs
            out["tx_count"] = total
            out["limit"] = limit
            out["offset"] = offset
            out["has_more"] = offset + len(txids) < total
        return out

    def blocks(self, params=None):
        params = params or {}
        limit = parse_int(params, "limit", DEFAULT_PAGE, minimum=1, maximum=MAX_PAGE)
        before = params.get("before_height")
        with self.store.snapshot() as conn:
            out = self._envelope(conn)
            tip = queries.tip_height(conn)
            hi = tip if before in (None, "") else parse_int(
                {"before_height": before}, "before_height", tip, minimum=0,
                maximum=2_000_000_000) - 1
            rows = conn.execute(
                "SELECT height, hash, prev_hash, time, mediantime, n_tx, size,"
                " weight, difficulty, bits, total_fees, subsidy, value_out"
                " FROM blocks WHERE height <= ? ORDER BY height DESC LIMIT ?",
                (hi, limit)).fetchall()
            items = []
            for r in rows:
                d = self._block_row(dict(r), conn)
                d["confirmations"] = tip - d["height"] + 1
                items.append(d)
            out["blocks"] = items
            out["count"] = len(items)
            out["tip_height"] = tip
            if items:
                out["next_before_height"] = items[len(items) - 1]["height"]
        return out

    # -- search ----------------------------------------------------------
    def search(self, term):
        term = (term or "").strip()
        if not term:
            raise bad_request("q is required")
        if len(term) > 128:
            raise bad_request("q is too long")
        if is_decimal(term):
            try:
                return {"kind": "block", **self.block(term)}
            except ApiError:
                raise not_found("nothing matches %r" % term)
        if HASH_RE.match(term):
            low = term.lower()
            try:
                return {"kind": "tx", **self.transaction(low)}
            except ApiError:
                pass
            try:
                return {"kind": "block", **self.block(low)}
            except ApiError:
                raise not_found("nothing matches %r" % term)
        check_address(term)
        with self.store.snapshot() as conn:
            known = conn.execute("SELECT 1 FROM addresses WHERE address=?",
                                 (term,)).fetchone()
            if known is None:
                known = conn.execute(
                    "SELECT 1 FROM outputs WHERE address=? LIMIT 1", (term,)
                ).fetchone()
        snap = self.node.snapshot()
        in_mempool = bool(((snap.get("mempool") or {}).get("by_address") or {})
                          .get(term))
        if known is None and not in_mempool:
            # Still answer with the address view: an address with no history is a
            # valid answer to "what does this hold", and a wallet scanning for a
            # fresh receive address needs exactly that answer.
            return {"kind": "address", "known": False, **self.address(term)}
        return {"kind": "address", "known": True, **self.address(term)}

    # -- fees ------------------------------------------------------------
    def fees(self):
        """The fee floor, as the node reports it, plus what a wallet should pay.

        These are two different numbers on PCoin and merging them is a mistake:

        * The **relay floor** is what the network will accept. Upstream v29.4 set
          ``DEFAULT_MIN_RELAY_TX_FEE`` to 100 sat/kvB (`src/policy/policy.h:66`,
          unchanged by PCoin), so the floor here is **0.1 sat/vB**, not the
          1 sat/vB of older Bitcoin releases.
        * The **recommended** rate is 1 000 sat/kvB = 1.0 sat/vB, which is what
          the `fallbackfee=0.00001` every PCoin wallet is told to set
          (`PCOIN.md` section 6.5) actually pays. There is no fee market to bid
          into -- `estimatesmartfee` has no data and says so -- so paying the
          documented rate keeps a transaction indistinguishable from every other
          transaction on the chain, and paying the bare floor saves nothing worth
          having on a 200-vbyte payment (180 satoshis).

        Both are reported. Neither is invented: if the node has never been
        observed this raises rather than guessing a number somebody might spend
        against.
        """
        snap = self.node.snapshot()
        relay = snap.get("relay") or {}
        floor = relay.get("min_relay_sat_per_kvb")
        mempool_min = relay.get("mempool_min_sat_per_kvb")
        if not snap.get("known") or (floor is None and mempool_min is None):
            # No cached observation and no live one. A fee floor is a number
            # somebody is about to spend against; inventing one is worse than
            # answering "I do not know".
            raise ApiError(
                503, "node_unreachable",
                "the fee floor has never been observed from a node: %s"
                % (snap.get("error") or "no successful poll yet"))

        def rate(sat_per_kvb, source):
            if sat_per_kvb is None:
                return {"sat_per_kvb": None, "sat_per_vb": None,
                        "pcn_per_kvb": None, "source": source,
                        "known": False}
            return {"sat_per_kvb": sat_per_kvb,
                    "sat_per_vb": sat_per_vb_str(sat_per_kvb),
                    "pcn_per_kvb": from_sat(sat_per_kvb),
                    "source": source, "known": True}

        effective = max(v for v in (floor, mempool_min) if v is not None)
        recommended = max(effective, self.recommended_sat_per_kvb)
        with self.store.snapshot() as conn:
            out = self._envelope(conn, snap)
        out["observed"] = {
            "node_reachable": bool(snap.get("fresh")),
            "observed_seconds_ago": snap.get("age_seconds"),
            "error": snap.get("error"),
        }
        out["relay_floor"] = rate(floor, "getmempoolinfo.minrelaytxfee")
        out["mempool_min"] = rate(mempool_min, "getmempoolinfo.mempoolminfee")
        out["incremental_relay"] = rate(
            relay.get("incremental_relay_sat_per_kvb"),
            "getmempoolinfo.incrementalrelayfee")
        out["effective_floor"] = rate(
            effective, "max(minrelaytxfee, mempoolminfee) -- a transaction below "
                       "this is rejected, not queued")
        out["recommended"] = rate(
            recommended,
            "max(effective_floor, 1000 sat/kvB) -- 1000 sat/kvB is what "
            "fallbackfee=0.00001 (PCOIN.md section 6.5) pays, and PCoin has no "
            "fee market to bid into")
        out["fee_estimation"] = {
            "usable": False,
            "detail": "estimatesmartfee needs a fee history this chain does not "
                      "have; it answers 'Insufficient data or no feerate found'. "
                      "Use `recommended`.",
        }
        out["dust_thresholds_sat"] = {
            k: int(DUST_RELAY_TX_FEE_SAT_PER_KVB * size / 1000)
            for k, size in _DUST_SIZES.items()}
        out["dust_thresholds_note"] = (
            "Derived from DUST_RELAY_TX_FEE = 3000 sat/kvB, a compile-time "
            "constant (src/policy/policy.h:64) that no RPC reports and that "
            "-dustrelayfee can override. Treat as informational, not observed.")
        out["mempool"] = self._mempool_block(snap)
        out["no_fee_market"] = True
        return out
