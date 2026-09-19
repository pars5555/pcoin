#!/usr/bin/env python3
"""Recover the signer of an EIP-191 (personal_sign) message. Used by the wrap desk.

stdin:  {"message": "<text>", "signature": "0x<130 hex>"}
stdout: the recovered address, lower-case, and nothing else
exit:   0 recovered · 3 the signature or input does not parse · 2 anything else

Why a subprocess: Node has no secp256k1 public-key recovery built in, and the
alternative -- hand-rolling curve arithmetic and keccak inside a money path --
is a worse risk than one extra process per claim. eth_account is already
installed in /opt/wpcn/.venv for the watcher, and the watcher does the SAME
recovery independently before anything is paid, so both halves must agree.

Run it with /opt/wpcn/.venv/bin/python. The system python has no eth_account.
"""
import json
import sys


def main() -> int:
    try:
        req = json.load(sys.stdin)
        message = req["message"]
        signature = req["signature"]
        if not isinstance(message, str) or not isinstance(signature, str):
            return 3
    except Exception:
        return 3
    try:
        from eth_account import Account
        from eth_account.messages import encode_defunct
    except Exception as e:                       # environment problem, not the claim's
        print(f"eth_account unavailable: {e}", file=sys.stderr)
        return 2
    try:
        addr = Account.recover_message(encode_defunct(text=message), signature=signature)
    except Exception:
        return 3
    print(addr.lower())
    return 0


if __name__ == "__main__":
    sys.exit(main())
