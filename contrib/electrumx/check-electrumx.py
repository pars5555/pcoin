#!/usr/bin/env python3
"""Prove a PCoin ElectrumX server is up, current, and INDEXING CORRECTLY.

    check-electrumx.py electrum1.pc.am:50001:t
    check-electrumx.py electrum1.pc.am:50002:s --address pc1q...
    check-electrumx.py electrum2.pc.am:50004:w --json

"Reachable" is a much weaker claim than "correct", and Komodo delists on the
second one silently. So this does four things, in increasing order of strength:

  1. connect                           -- and for ssl/wss, verify the certificate
     against the SYSTEM TRUST STORE, which is what distinguishes a real
     Let's Encrypt certificate from the self-signed one Komodo rejects
  2. server.version / server.features  -- it speaks the protocol, on OUR chain
  3. blockchain.headers.subscribe      -- and it is at the tip, compared against
     an independent source rather than against itself
  4. blockchain.scripthash.get_balance -- and the balance it reports for a real
     address matches an INDEPENDENT index (explorer.pc.am)

Check 4 is the point of the whole script. A server can pass 1-3 while returning
an empty history for every address on the chain -- that is exactly what a coin
class with the wrong version bytes or a mis-chosen deserializer looks like.

An unreadable answer is UNKNOWN. It never becomes a zero and never becomes a
pass: a comparison against a reference that could not be read would "confirm" a
server that indexes nothing at all.

But UNKNOWN is not the same as BROKEN, and conflating them is its own bug. An
unreachable explorer, or two indexes momentarily at different heights, says
nothing about this ElectrumX server. Reporting that as a failure produced two
false alarms in the first six hours -- and a monitor that cries wolf gets muted,
taking the real alert with it. So there are three outcomes, not two:

    exit 0   every check passed
    exit 1   the SERVER is broken -- alert
    exit 2   the server looks fine, but a reference-dependent check could not be
             completed. Not a pass. pcoin-electrumx-watch escalates only if this
             persists across consecutive runs.

Stdlib only, so it runs from a monitoring unit on a box with no venv.
"""
import argparse
import base64
import hashlib
import json
import os
import socket
import ssl
import sys
import time
import urllib.request

EXPLORER = "https://explorer.pc.am"
GENESIS = ("a95d51f0cbf25cad10c35961c6189356"
           "525d079835f02e83e2395f382fbe264a")

# ---------------------------------------------------------------- addresses --

CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"


def _bech32_polymod(values):
    gen = [0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3]
    chk = 1
    for v in values:
        top = chk >> 25
        chk = (chk & 0x1FFFFFF) << 5 ^ v
        for i in range(5):
            chk ^= gen[i] if ((top >> i) & 1) else 0
    return chk


def _bech32_hrp_expand(hrp):
    return [ord(x) >> 5 for x in hrp] + [0] + [ord(x) & 31 for x in hrp]


def _bech32_decode(addr):
    if any(ord(x) < 33 or ord(x) > 126 for x in addr):
        raise ValueError("bad characters")
    if addr.lower() != addr and addr.upper() != addr:
        raise ValueError("mixed case")
    addr = addr.lower()
    pos = addr.rfind("1")
    if pos < 1 or pos + 7 > len(addr):
        raise ValueError("bad separator position")
    hrp, data = addr[:pos], []
    for c in addr[pos + 1:]:
        if c not in CHARSET:
            raise ValueError("bad data character")
        data.append(CHARSET.index(c))
    const = _bech32_polymod(_bech32_hrp_expand(hrp) + data)
    # 1 == bech32 (witness v0), 0x2bc830a3 == bech32m (witness v1+)
    if const not in (1, 0x2BC830A3):
        raise ValueError("bad checksum")
    return hrp, data[:-6], const


def _convertbits(data, frombits, tobits, pad=True):
    acc = bits = 0
    ret = []
    maxv = (1 << tobits) - 1
    for value in data:
        acc = (acc << frombits) | value
        bits += frombits
        while bits >= tobits:
            bits -= tobits
            ret.append((acc >> bits) & maxv)
    if pad and bits:
        ret.append((acc << (tobits - bits)) & maxv)
    elif bits >= frombits or ((acc << (tobits - bits)) & maxv):
        raise ValueError("bad padding")
    return ret


_B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def _b58decode_check(s):
    n = 0
    for ch in s:
        n = n * 58 + _B58.index(ch)
    raw = n.to_bytes((n.bit_length() + 7) // 8, "big")
    raw = b"\x00" * (len(s) - len(s.lstrip("1"))) + raw
    body, chk = raw[:-4], raw[-4:]
    if hashlib.sha256(hashlib.sha256(body).digest()).digest()[:4] != chk:
        raise ValueError("bad base58 checksum")
    return body


def address_to_script(addr, hrp="pc", p2pkh=0x37, p2sh=0x38):
    """PCoin address -> scriptPubKey bytes.

    The three constants mirror src/kernel/chainparams.cpp: bech32_hrp "pc",
    base58Prefixes PUBKEY_ADDRESS 55 (0x37) and SCRIPT_ADDRESS 56 (0x38).
    """
    if addr.lower().startswith(hrp + "1"):
        got_hrp, data, const = _bech32_decode(addr)
        if got_hrp != hrp:
            raise ValueError(f"wrong hrp {got_hrp!r}, expected {hrp!r}")
        witver, prog = data[0], bytes(_convertbits(data[1:], 5, 8, False))
        if witver == 0 and const != 1:
            raise ValueError("v0 address must use bech32, not bech32m")
        if witver > 0 and const != 0x2BC830A3:
            raise ValueError("v1+ address must use bech32m")
        if witver == 0 and len(prog) not in (20, 32):
            raise ValueError("bad v0 program length")
        op = 0x00 if witver == 0 else 0x50 + witver
        return bytes([op, len(prog)]) + prog
    raw = _b58decode_check(addr)
    ver, h160 = raw[0], raw[1:]
    if len(h160) != 20:
        raise ValueError("bad hash160 length")
    if ver == p2pkh:
        return b"\x76\xa9\x14" + h160 + b"\x88\xac"
    if ver == p2sh:
        return b"\xa9\x14" + h160 + b"\x87"
    raise ValueError(f"unknown address version byte {ver}")


def scripthash(script):
    """Electrum scripthash: sha256 of the scriptPubKey, byte-REVERSED, as hex."""
    return hashlib.sha256(script).digest()[::-1].hex()


# ------------------------------------------------------------------ client --

def _dns_a_query(host, resolver, timeout=5):
    """Ask one resolver directly for an A record. Returns an IP or None.

    Stdlib has no DNS client, so this is a minimal A query. It exists because
    the SYSTEM resolver's answer is not the answer that matters: an outside
    client -- Komodo's scanner, a wallet -- uses its own. A host whose ElectrumX
    spent an hour retrying peer discovery against a name that did not exist yet
    holds a negative cache entry for the zone's SOA minimum (30 minutes on
    Cloudflare), and reporting that as "the server is down" is a false alarm.
    A monitor that cries wolf gets muted, taking the real alert with it.
    """
    import struct
    qname = b"".join(bytes([len(p)]) + p.encode("idna")
                     for p in host.rstrip(".").split(".")) + b"\x00"
    # id 0x1234, flags 0x0100 (standard query, recursion desired), qdcount 1
    pkt = struct.pack(">HHHHHH", 0x1234, 0x0100, 1, 0, 0, 0) + qname + struct.pack(">HH", 1, 1)
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.settimeout(timeout)
        s.sendto(pkt, (resolver, 53))
        data, _ = s.recvfrom(4096)
    except Exception:
        return None
    finally:
        s.close()
    if len(data) < 12 or data[:2] != pkt[:2]:
        return None
    ancount = struct.unpack(">H", data[6:8])[0]
    if ancount == 0:
        return None

    def skip_name(buf, off):
        while True:
            ln = buf[off]
            if ln == 0:
                return off + 1
            if ln & 0xC0 == 0xC0:      # compression pointer: 2 bytes, ends the name
                return off + 2
            off += 1 + ln

    off = skip_name(data, 12) + 4      # past the question's name, qtype, qclass
    for _ in range(ancount):
        off = skip_name(data, off)
        rtype, _rclass, _ttl, rdlen = struct.unpack(">HHIH", data[off:off + 10])
        off += 10
        if rtype == 1 and rdlen == 4:  # A record
            return socket.inet_ntoa(data[off:off + 4])
        off += rdlen                   # CNAME and friends: keep walking
    return None


def resolve(host, timeout=5):
    """(ip, source) for host. Raises if it resolves nowhere.

    Falls back to public resolvers so a stale local cache cannot masquerade as
    an outage. The source is reported so the opposite case -- a genuinely broken
    local resolver -- stays visible instead of being silently papered over.
    """
    try:
        socket.inet_aton(host)
        return host, "literal"
    except OSError:
        pass
    try:
        return socket.getaddrinfo(host, None, socket.AF_INET)[0][4][0], "system"
    except socket.gaierror:
        pass
    for r in ("1.1.1.1", "8.8.8.8", "9.9.9.9"):
        ip = _dns_a_query(host, r, timeout)
        if ip:
            return ip, f"{r} (system resolver failed -- stale negative cache?)"
    raise RuntimeError(f"{host} does not resolve, via the system resolver or any public one")


def _cert_days_left(sock):
    """Days until the peer certificate expires, or None if it cannot be read.

    None is UNKNOWN. With verify_mode=CERT_NONE getpeercert() returns {}, so
    --insecure legitimately yields None and the expiry check is skipped rather
    than silently passed.
    """
    import datetime
    try:
        cert = sock.getpeercert()
        if not cert or "notAfter" not in cert:
            return None
        exp = datetime.datetime.strptime(cert["notAfter"], "%b %d %H:%M:%S %Y %Z")
        exp = exp.replace(tzinfo=datetime.timezone.utc)
        return (exp - datetime.datetime.now(datetime.timezone.utc)).days
    except Exception:
        return None


class Electrum:
    """Just enough Electrum client for tcp, ssl and wss."""

    def __init__(self, host, port, proto, timeout=20, insecure=False):
        self.host, self.port, self.proto = host, port, proto
        self._id = 0
        self._ws = None
        self.cert_days = None
        self.ip, self.dns_source = resolve(host, timeout)
        # Connect to the resolved ADDRESS but keep server_hostname=host, so the
        # certificate is still validated against the public name -- which is the
        # whole point of testing ssl/wss rather than a raw port.
        sock = socket.create_connection((self.ip, port), timeout=timeout)
        if proto in ("s", "w"):
            ctx = ssl.create_default_context()
            if insecure:
                ctx.check_hostname = False
                ctx.verify_mode = ssl.CERT_NONE
            sock = ctx.wrap_socket(sock, server_hostname=host)
            self.cert_days = _cert_days_left(sock)
        self.sock = sock
        if proto == "w":
            self._ws_handshake()
        else:
            self.f = sock.makefile("rwb")

    # -- websocket ----------------------------------------------------------
    def _ws_handshake(self):
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall(
            f"GET / HTTP/1.1\r\nHost: {self.host}\r\nUpgrade: websocket\r\n"
            f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
            f"Sec-WebSocket-Version: 13\r\n\r\n".encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise RuntimeError("websocket handshake: connection closed")
            buf += chunk
        status = buf.split(b"\r\n", 1)[0].decode("latin-1")
        if " 101 " not in status:
            raise RuntimeError(f"websocket handshake failed: {status}")
        self._ws = True
        self._ws_buf = buf.split(b"\r\n\r\n", 1)[1]

    def _ws_send(self, payload):
        mask = os.urandom(4)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        n = len(payload)
        if n < 126:
            hdr = bytes([0x81, 0x80 | n])
        elif n < 65536:
            hdr = bytes([0x81, 0x80 | 126]) + n.to_bytes(2, "big")
        else:
            hdr = bytes([0x81, 0x80 | 127]) + n.to_bytes(8, "big")
        self.sock.sendall(hdr + mask + masked)

    def _ws_recv(self):
        def need(k):
            while len(self._ws_buf) < k:
                chunk = self.sock.recv(65536)
                if not chunk:
                    raise RuntimeError("websocket closed")
                self._ws_buf += chunk
        while True:
            need(2)
            b1, b2 = self._ws_buf[0], self._ws_buf[1]
            ln, off = b2 & 0x7F, 2
            if ln == 126:
                need(4)
                ln = int.from_bytes(self._ws_buf[2:4], "big")
                off = 4
            elif ln == 127:
                need(10)
                ln = int.from_bytes(self._ws_buf[2:10], "big")
                off = 10
            need(off + ln)
            payload = self._ws_buf[off:off + ln]
            self._ws_buf = self._ws_buf[off + ln:]
            opcode = b1 & 0x0F
            if opcode in (1, 2):
                return payload
            if opcode == 8:
                raise RuntimeError("websocket closed by server")
            # ping/pong/continuation frames: ignore and read the next one

    # -- rpc ----------------------------------------------------------------
    def call(self, method, params=()):
        self._id += 1
        req = json.dumps({"jsonrpc": "2.0", "id": self._id,
                          "method": method, "params": list(params)})
        if self._ws:
            self._ws_send(req.encode())
            while True:
                msg = json.loads(self._ws_recv().decode())
                if msg.get("id") == self._id:
                    break
        else:
            self.f.write(req.encode() + b"\n")
            self.f.flush()
            while True:
                line = self.f.readline()
                if not line:
                    raise RuntimeError("server closed the connection")
                msg = json.loads(line.decode())
                if msg.get("id") == self._id:
                    break
        if msg.get("error"):
            raise RuntimeError(f"{method}: {msg['error']}")
        return msg["result"]

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


# ------------------------------------------------------------------- main --

def explorer_json(path, timeout=20):
    """GET explorer.pc.am/<path> as JSON, or None if it could not be read.

    None means UNKNOWN. Callers must fail the check rather than substitute a
    value -- see the module docstring.
    """
    try:
        with urllib.request.urlopen(f"{EXPLORER}{path}", timeout=timeout) as r:
            return json.load(r)
    except Exception:
        return None


def explorer_balance(addr):
    """(satoshis, as_of_height) from explorer.pc.am, or (None, None) if unknown.

    The field is onchain_unspent_sat, NOT mature_sat. Electrum's
    blockchain.scripthash.get_balance has no notion of coinbase maturity -- it
    sums every confirmed UTXO -- so mature_sat is the wrong comparison and would
    report a false MISMATCH on any mining address holding immature coinbases,
    which on this chain is most of them.

    The HEIGHT is returned because the balance alone is not comparable. These are
    two independently-advancing indexes: when one has ingested a block the other
    has not, their answers differ by exactly that block's effect and BOTH are
    correct. On this chain that is not a rare race -- one address mines ~70% of
    blocks, so most new blocks move it by exactly one 50 PCN coinbase. Comparing
    without aligning heights produced two false MISMATCH alerts in six hours,
    each off by exactly 5000000000 sat.
    """
    d = explorer_json(f"/api/address/{addr}")
    if not isinstance(d, dict):
        return None, None
    conf = (d.get("balance") or {}).get("confirmed")
    if isinstance(conf, dict) and isinstance(conf.get("onchain_unspent_sat"), int):
        return conf["onchain_unspent_sat"], conf.get("as_of_height")
    return None, None


def main():
    ap = argparse.ArgumentParser(
        description="Check a PCoin ElectrumX server end to end.")
    ap.add_argument("server",
                    help="host:port:proto -- proto is t (tcp), s (ssl) or w (wss), "
                         "e.g. electrum1.pc.am:50002:s")
    ap.add_argument("--address", action="append", default=[],
                    help="address to cross-check against explorer.pc.am (repeatable)")
    ap.add_argument("--max-lag", type=int, default=3,
                    help="fail if the tip is more than this many blocks behind (default 3)")
    ap.add_argument("--min-cert-days", type=int, default=10,
                    help="for ssl/wss, fail if the certificate expires within this many "
                         "days (default 10). An expired certificate is the classic silent "
                         "ElectrumX failure: renewal succeeded, nothing restarted")
    ap.add_argument("--insecure", action="store_true",
                    help="skip TLS verification. Debugging only: it defeats the "
                         "self-signed-certificate check, which is the main reason "
                         "to test ssl/wss at all")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    host, port, proto = a.server.rsplit(":", 2)
    port = int(port)
    if proto not in ("t", "s", "w"):
        ap.error("proto must be t, s or w")

    out = {"server": a.server, "checks": {}, "ok": True, "unverified": False}

    def fail(name, detail):
        """The SERVER is broken. Alert."""
        out["checks"][name] = {"state": "FAIL", "detail": detail}
        out["ok"] = False

    def unverified(name, detail):
        """The server looks fine but a check could not be COMPLETED.

        Distinct from fail on purpose. An unreachable explorer, or two indexes
        momentarily at different heights, says nothing about this ElectrumX
        server -- and shouting "Komodo delists on failing servers" at it is a
        false alarm. It is still not a pass: the caller gets exit code 2 and
        decides, and pcoin-electrumx-watch only escalates when it persists.
        """
        out["checks"][name] = {"state": "UNVERIFIED", "detail": detail}
        out["unverified"] = True

    def good(name, detail):
        out["checks"][name] = {"state": "ok", "detail": detail}

    def report():
        if a.json:
            print(json.dumps(out, indent=1))
        else:
            for name, res in out["checks"].items():
                print(f"  [{res['state']:<10}] {name}: {res['detail']}")
            print("PASS" if out["ok"] and not out["unverified"]
                  else ("FAIL" if not out["ok"] else "UNVERIFIED"))
        if not out["ok"]:
            return 1
        return 2 if out["unverified"] else 0

    try:
        cli = Electrum(host, port, proto, insecure=a.insecure)
    except Exception as e:
        fail("connect", f"{type(e).__name__}: {e}")
        return report()

    tls = ""
    if proto in ("s", "w"):
        tls = (" (TLS NOT verified -- --insecure)" if a.insecure
               else " (certificate verified against the system trust store)")
    dns = "" if cli.dns_source in ("system", "literal") else f", DNS via {cli.dns_source}"
    good("connect", f"{proto}://{host}:{port} [{cli.ip}]{dns}{tls}")

    if proto in ("s", "w") and not a.insecure:
        if cli.cert_days is None:
            fail("cert_expiry", "could not read the certificate expiry -- UNVERIFIED")
        elif cli.cert_days < a.min_cert_days:
            fail("cert_expiry",
                 f"certificate expires in {cli.cert_days} day(s), "
                 f"threshold {a.min_cert_days}")
        else:
            good("cert_expiry", f"{cli.cert_days} days left")

    try:
        good("server.version", cli.call("server.version", ["pcoin-check", "1.4"]))

        feats = cli.call("server.features")
        if feats.get("genesis_hash") != GENESIS:
            fail("genesis", f"WRONG CHAIN: server reports {feats.get('genesis_hash')}")
        else:
            good("genesis", feats["genesis_hash"])

        head = cli.call("blockchain.headers.subscribe")
        good("tip", f"height {head['height']}")

        hdr_len = len(bytes.fromhex(head["hex"]))
        if hdr_len != 80:
            fail("header_size", f"{hdr_len} bytes, expected 80")
        else:
            good("header_size", "80 bytes")

        status = explorer_json("/api/status")
        if not isinstance(status, dict):
            # Unreadable reference is UNKNOWN, not "in sync" -- and not this
            # server's fault either.
            unverified("lag", "could not read explorer.pc.am/api/status to compare")
        else:
            exp_h = status["chain"]["height"]
            lag = exp_h - head["height"]
            if lag > a.max_lag:
                fail("lag", f"{lag} blocks behind explorer.pc.am (which is at {exp_h})")
            else:
                good("lag", f"{lag} block(s) behind explorer.pc.am ({exp_h})")

        for addr in a.address:
            try:
                sh = scripthash(address_to_script(addr))
                hist = cli.call("blockchain.scripthash.get_history", [sh])
            except Exception as e:
                fail(f"address:{addr}", f"{type(e).__name__}: {e}")
                continue

            # Align the two indexes on a common height before comparing. Both
            # advance independently, so a bare balance-vs-balance check is a race
            # that this chain loses constantly -- see explorer_balance().
            got = ref = ref_h = our_h = None
            aligned = False
            for _attempt in range(4):
                try:
                    # BRACKET the balance read between two height reads. Reading
                    # the height only BEFORE is not enough: if a block lands
                    # between the two calls, the balance is from height N+1 while
                    # we are about to compare it against the explorer at N -- and
                    # the heights still LOOK equal, so it is reported as a
                    # MISMATCH. That is exactly what happened at height 4830,
                    # off by one 50 PCN coinbase, after the first fix.
                    h_before = cli.call("blockchain.headers.subscribe")["height"]
                    bal = cli.call("blockchain.scripthash.get_balance", [sh])
                    h_after = cli.call("blockchain.headers.subscribe")["height"]
                except Exception as e:
                    fail(f"address:{addr}", f"{type(e).__name__}: {e}")
                    got = None
                    break
                if h_before != h_after:
                    time.sleep(3)          # a block landed mid-read; redo it
                    continue
                our_h = h_after
                got = bal["confirmed"]
                ref, ref_h = explorer_balance(addr)
                if ref is None or ref_h == our_h:
                    aligned = True
                    break
                time.sleep(3)   # let the slower index catch up, then re-read BOTH

            if got is None:
                continue
            if ref is None:
                unverified(f"address:{addr}",
                           f"electrumx says {got} sat over {len(hist)} txs; "
                           f"explorer.pc.am was unreadable, so nothing was compared")
            elif not aligned or ref_h != our_h:
                unverified(f"address:{addr}",
                           f"could not align heights after 4 tries "
                           f"(electrumx at {our_h}, explorer at {ref_h}); "
                           f"balances {got} vs {ref} are not comparable")
            elif ref != got:
                fail(f"address:{addr}",
                     f"MISMATCH at the same height {our_h}: "
                     f"electrumx {got} sat vs explorer.pc.am {ref} sat")
            else:
                # Report unconfirmed explicitly. Without it, "0 sat over 1 txs"
                # reads as a contradiction -- the confirmed balance is being
                # compared against a total that includes the mempool, and the
                # honest answer ("it is there, it has not confirmed") is exactly
                # the information the line was hiding.
                pending = (f", plus {bal['unconfirmed']} sat unconfirmed"
                           if bal.get("unconfirmed") else "")
                good(f"address:{addr}",
                     f"{got} sat confirmed over {len(hist)} txs{pending}, "
                     f"confirmed matches explorer.pc.am")
    except Exception as e:
        fail("protocol", f"{type(e).__name__}: {e}")
    finally:
        cli.close()

    return report()


if __name__ == "__main__":
    sys.exit(main())
