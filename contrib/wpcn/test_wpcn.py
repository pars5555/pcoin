#!/usr/bin/env python3
"""Exercise WrappedPCoin against a real EVM before real money trades against it.

    solc --optimize --optimize-runs 200 --combined-json abi,bin -o build WrappedPCoin.sol
    ./.venv/bin/python test_wpcn.py

Runs on eth-tester's in-process py-evm, so it needs no network, no faucet and no
key. It is the same bytecode that will be deployed to BNB Smart Chain.

The tests are chosen around the claims the contract makes about itself, because
those claims are what people will rely on:

  * the supply is fixed and there is no way to create more
  * there is no owner, no pause, no blacklist, no fee -- checked by ABI
    inspection, not by reading the source, so a future edit that adds one fails
    the suite
  * redeem burns, decrements totalSupply, leaves issuedSupply alone, and records
    the PCoin address in a log nobody can retract
  * the 21M cap is enforced at construction
  * ordinary ERC20 behaviour, including the infinite-allowance path PancakeSwap
    relies on

A wrapper whose properties were only ever asserted in a README is a wrapper
nobody should buy.
"""
import json
import sys
from pathlib import Path

from eth_tester import EthereumTester, PyEVMBackend
from web3 import Web3, EthereumTesterProvider

HERE = Path(__file__).resolve().parent
SUPPLY = 200_000 * 10**8          # 200,000 wPCN at 8 decimals
RESERVE = "pc1qnfk7xenwzxx7h4mx88g004crlx0m2zcjg3nq4j"
CAP = 21_000_000 * 10**8

failures = []


def check(name, cond, detail=""):
    if cond:
        print(f"  [ok  ] {name}")
    else:
        print(f"  [FAIL] {name} {detail}")
        failures.append(name)


def expect_revert(name, fn, *args, **kw):
    try:
        fn(*args, **kw)
    except Exception as e:
        print(f"  [ok  ] {name} (reverted: {type(e).__name__})")
        return
    print(f"  [FAIL] {name} -- it did NOT revert")
    failures.append(name)


def main():
    art = json.loads((HERE / "build" / "combined.json").read_text())
    key = next(k for k in art["contracts"] if k.endswith(":WrappedPCoin"))
    c = art["contracts"][key]
    abi = c["abi"] if isinstance(c["abi"], list) else json.loads(c["abi"])
    bytecode = c["bin"]

    w3 = Web3(EthereumTesterProvider(EthereumTester(backend=PyEVMBackend())))
    deployer, alice, bob = w3.eth.accounts[0], w3.eth.accounts[1], w3.eth.accounts[2]

    print("\n== deployment ==")
    Factory = w3.eth.contract(abi=abi, bytecode=bytecode)
    tx = Factory.constructor(SUPPLY, RESERVE).transact({"from": deployer})
    rcpt = w3.eth.wait_for_transaction_receipt(tx)
    t = w3.eth.contract(address=rcpt.contractAddress, abi=abi)
    print(f"  deployed at {rcpt.contractAddress}, gas used {rcpt.gasUsed:,}")
    print(f"  runtime bytecode: {len(w3.eth.get_code(rcpt.contractAddress))} bytes")

    check("name", t.functions.name().call() == "Wrapped PCoin")
    check("symbol", t.functions.symbol().call() == "wPCN")
    check("decimals is 8, matching PCN", t.functions.decimals().call() == 8)
    check("totalSupply == supply", t.functions.totalSupply().call() == SUPPLY)
    check("issuedSupply == supply", t.functions.issuedSupply().call() == SUPPLY)
    check("reserveAddress recorded", t.functions.reserveAddress().call() == RESERVE)
    check("deployer holds the whole supply",
          t.functions.balanceOf(deployer).call() == SUPPLY)

    print("\n== the supply really is fixed: no way to create more ==")
    names = {i.get("name") for i in abi if i.get("type") == "function"}
    for forbidden in ("mint", "burnFrom", "setOwner", "transferOwnership", "owner",
                      "pause", "unpause", "blacklist", "setFee", "setTaxWallet",
                      "upgradeTo", "renounceOwnership", "setReserveAddress"):
        check(f"no {forbidden}() in the ABI", forbidden not in names)
    check("the only state-changing entrypoints are transfer/approve/transferFrom/redeem",
          {n for n in names} == {"name", "symbol", "decimals", "totalSupply",
                                 "issuedSupply", "reserveAddress", "balanceOf",
                                 "allowance", "transfer", "approve",
                                 "transferFrom", "redeem"},
          f"got {sorted(names)}")

    print("\n== the 21M cap is enforced in the constructor ==")
    expect_revert("supply above PCoin's 21M cap is refused",
                  lambda: Factory.constructor(CAP + 1, RESERVE).transact({"from": deployer}))
    expect_revert("zero supply is refused",
                  lambda: Factory.constructor(0, RESERVE).transact({"from": deployer}))
    expect_revert("empty reserve address is refused",
                  lambda: Factory.constructor(SUPPLY, "").transact({"from": deployer}))
    # Exactly at the cap must be allowed -- an off-by-one here would be silent.
    at_cap = Factory.constructor(CAP, RESERVE).transact({"from": deployer})
    w3.eth.wait_for_transaction_receipt(at_cap)
    check("supply exactly at the cap is allowed", True)

    print("\n== ordinary ERC20 behaviour ==")
    amt = 1_000 * 10**8
    w3.eth.wait_for_transaction_receipt(
        t.functions.transfer(alice, amt).transact({"from": deployer}))
    check("transfer moves value", t.functions.balanceOf(alice).call() == amt)
    check("sender debited", t.functions.balanceOf(deployer).call() == SUPPLY - amt)
    expect_revert("transfer beyond balance reverts",
                  lambda: t.functions.transfer(bob, SUPPLY).transact({"from": alice}))
    expect_revert("transfer to the zero address reverts",
                  lambda: t.functions.transfer(
                      "0x0000000000000000000000000000000000000000", 1).transact({"from": alice}))

    print("\n== allowances, including the path PancakeSwap uses ==")
    w3.eth.wait_for_transaction_receipt(
        t.functions.approve(bob, amt).transact({"from": alice}))
    check("allowance set", t.functions.allowance(alice, bob).call() == amt)
    w3.eth.wait_for_transaction_receipt(
        t.functions.transferFrom(alice, bob, amt // 2).transact({"from": bob}))
    check("transferFrom moves value", t.functions.balanceOf(bob).call() == amt // 2)
    check("finite allowance is decremented",
          t.functions.allowance(alice, bob).call() == amt - amt // 2)
    expect_revert("transferFrom beyond allowance reverts",
                  lambda: t.functions.transferFrom(alice, bob, amt).transact({"from": bob}))

    MAX = 2**256 - 1
    w3.eth.wait_for_transaction_receipt(
        t.functions.approve(bob, MAX).transact({"from": alice}))
    before = t.functions.balanceOf(alice).call()
    w3.eth.wait_for_transaction_receipt(
        t.functions.transferFrom(alice, bob, 1).transact({"from": bob}))
    check("infinite allowance is NOT decremented (the router relies on this)",
          t.functions.allowance(alice, bob).call() == MAX)
    check("...and the transfer still happened",
          t.functions.balanceOf(alice).call() == before - 1)

    print("\n== redeem: burns, records, and cannot be retracted ==")
    supply_before = t.functions.totalSupply().call()
    bob_before = t.functions.balanceOf(bob).call()
    burn = bob_before // 2
    r = w3.eth.wait_for_transaction_receipt(
        t.functions.redeem(burn, RESERVE).transact({"from": bob}))
    check("holder debited", t.functions.balanceOf(bob).call() == bob_before - burn)
    check("totalSupply decremented", t.functions.totalSupply().call() == supply_before - burn)
    check("issuedSupply UNCHANGED -- still what the reserve was sized against",
          t.functions.issuedSupply().call() == SUPPLY)
    ev = t.events.Redeem().process_receipt(r)
    check("Redeem event emitted", len(ev) == 1)
    if ev:
        check("event records the burner", ev[0]["args"]["from"] == bob)
        check("event records the amount", ev[0]["args"]["value"] == burn)
        check("event records the PCoin address", ev[0]["args"]["pcoinAddress"] == RESERVE)
    tev = t.events.Transfer().process_receipt(r)
    check("a Transfer to address(0) is emitted, so explorers show the burn",
          any(e["args"]["to"] == "0x0000000000000000000000000000000000000000" for e in tev))

    expect_revert("redeem beyond balance reverts",
                  lambda: t.functions.redeem(SUPPLY, RESERVE).transact({"from": bob}))
    expect_revert("redeem of zero reverts",
                  lambda: t.functions.redeem(0, RESERVE).transact({"from": bob}))
    expect_revert("redeem with an empty address reverts",
                  lambda: t.functions.redeem(1, "").transact({"from": bob}))
    expect_revert("redeem with an over-long address reverts",
                  lambda: t.functions.redeem(1, "x" * 91).transact({"from": bob}))
    # A real bech32 PCoin address is 42 chars and must fit comfortably.
    w3.eth.wait_for_transaction_receipt(
        t.functions.redeem(1, "pc1q85lry2j8n5yphq44mk86vc6u3rwygwlnc5ryc7").transact({"from": bob}))
    check("a real 42-char bech32 PCoin address is accepted", True)

    print("\n== supply conservation ==")
    total = sum(t.functions.balanceOf(a).call() for a in w3.eth.accounts)
    check("sum of all balances == totalSupply",
          total == t.functions.totalSupply().call(),
          f"{total} vs {t.functions.totalSupply().call()}")

    print()
    if failures:
        print(f"FAILED: {len(failures)} check(s): {failures}")
        return 1
    print("ALL CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
