#!/usr/bin/env python3
"""Move the LP tokens and un-pooled wPCN to an address the owner controls.

    ./handover.py 0xYourWalletAddress

WHY THIS EXISTS. The deployer key was generated on a server and delivered to the
owner through a chat transcript. That is acceptable for a key whose only job is
to deploy a contract. It is not acceptable for a key that keeps custody of the
liquidity position and the wrap-desk inventory, because anyone who ever reads
that transcript can take both. This moves them to a wallet whose private key has
never left the owner's device, after which the deployer key controls nothing
worth stealing and its exposure stops mattering.

It does NOT touch the pool. Transferring LP tokens changes who is allowed to
withdraw the liquidity; it does not withdraw it. The pool keeps trading
throughout, and the price is unaffected.

Refusals are deliberate: it will not send to the deployer itself, and it will not
send to a contract address -- LP tokens sent to a contract that does not know
about them are unrecoverable, and that is a permanent loss with no error message.
"""
import sys

from web3 import Web3

from deploy import connect, load, send

# deploy.py's ERC20_ABI is read-only (balanceOf/decimals/approve) -- it has no
# transfer, because deploying never needed one. Declared here rather than
# widening the shared one: this is the only script that moves tokens.
TRANSFER_ABI = [
    {"constant": False, "inputs": [{"name": "_to", "type": "address"},
                                   {"name": "_value", "type": "uint256"}],
     "name": "transfer", "outputs": [{"name": "", "type": "bool"}],
     "type": "function"},
    {"constant": True, "inputs": [{"name": "_owner", "type": "address"}],
     "name": "balanceOf", "outputs": [{"name": "balance", "type": "uint256"}],
     "type": "function"},
]


def main() -> int:
    if len(sys.argv) != 2:
        sys.exit("usage: handover.py <0xaddress>")

    cfg = load()
    w3, acct = connect(cfg)

    dest = sys.argv[1]
    if not Web3.is_address(dest):
        sys.exit(f"not a valid address: {dest}")
    dest = Web3.to_checksum_address(dest)

    if dest == acct.address:
        sys.exit("destination is the deployer itself -- refusing")
    if w3.eth.get_code(dest) != b"":
        sys.exit("destination is a CONTRACT, not a wallet -- refusing. "
                 "Tokens sent to a contract that does not expect them are lost.")

    print(f"  from : {acct.address}  (deployer)")
    print(f"  to   : {dest}")
    print()

    moved = 0
    for label, key in (("wPCN", "TOKEN"), ("LP", "PAIR")):
        addr = cfg.get(key)
        if not addr:
            print(f"  {label}: no {key} in wpcn.conf -- skipping")
            continue
        c = w3.eth.contract(address=Web3.to_checksum_address(addr), abi=TRANSFER_ABI)
        bal = c.functions.balanceOf(acct.address).call()
        if bal == 0:
            print(f"  {label}: nothing to move")
            continue

        print(f"  {label}: moving {bal:,} units")
        send(w3, acct, c.functions.transfer(dest, bal).build_transaction(
            {"from": acct.address}), f"transfer {label}")

        # Read both sides back from the chain. "The call returned" is not proof
        # that the balance moved.
        after_src = c.functions.balanceOf(acct.address).call()
        after_dst = c.functions.balanceOf(dest).call()
        print(f"  {label}: deployer now {after_src:,}, destination now {after_dst:,}")
        if after_src != 0:
            sys.exit(f"  {label}: deployer STILL holds {after_src} -- stopping")
        moved += 1

    print()
    print(f"  done: {moved} asset(s) moved. The deployer key now holds no wPCN "
          f"and no LP tokens.")
    print("  It still holds leftover BNB for gas, which is worth a few dollars "
          "and is not custody of anything.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
