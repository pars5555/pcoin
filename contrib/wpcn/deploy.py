#!/usr/bin/env python3
"""Deploy wPCN and seed its PancakeSwap V2 pool. Staged, and verified at each step.

    ./deploy.py addr                 # show the deployer address and balances
    ./deploy.py token                # deploy WrappedPCoin
    ./deploy.py pool                 # approve + createPair + addLiquidity
    ./deploy.py verify               # read everything back off-chain

Config lives in wpcn.conf (mode 0600, NOT in git):

    RPC=https://bsc-dataseed.bnbchain.org
    PRIVATE_KEY=0x...
    ISSUED_PCN=200000                # whole PCN; must already be locked in RESERVE
    RESERVE=pc1...                   # PCoin address holding the backing
    POOL_WPCN=24000                  # whole wPCN to put in the pool
    POOL_USDT=385                    # whole USDT to put in the pool
    TOKEN=0x...                      # written by `token`, read by `pool`

WHY STAGED. Every step here is irreversible and costs real money, and the
failure that matters is not a crash -- it is a step that half-succeeds and gets
retried. So each stage writes its result into the config and refuses to run
twice, and `verify` reads state back off the chain rather than trusting what
this script believed it did.

THE PRICE IS SET BY THE RATIO YOU CHOOSE HERE. addLiquidity on an empty pair
mints the pool at exactly POOL_USDT/POOL_WPCN and nothing checks whether that
is sensible. Getting it wrong is not recoverable by editing anything -- it is
recoverable only by someone arbitraging you.
"""
import json
import sys
from pathlib import Path

from web3 import Web3
from web3.middleware import ExtraDataToPOAMiddleware

HERE = Path(__file__).resolve().parent
CONF = HERE / "wpcn.conf"

# Verified against BscScan, 2026-08-24. These are the addresses everything
# depends on; a wrong one here sends money to nowhere it can be recovered from.
ROUTER  = "0x10ED43C718714eb63d5aA57B78B54704E256024E"  # PancakeSwap V2 Router
FACTORY = "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73"  # PancakeSwap V2 Factory
USDT    = "0x55d398326f99059fF775485246999027B3197955"  # Binance-Peg BSC-USD
USDT_DECIMALS = 18   # USDT on BSC is 18, NOT the 6 it uses on Ethereum/Tron.
WPCN_DECIMALS = 8

ERC20_ABI = json.loads("""[
 {"name":"approve","type":"function","inputs":[{"name":"s","type":"address"},{"name":"v","type":"uint256"}],"outputs":[{"type":"bool"}]},
 {"name":"allowance","type":"function","stateMutability":"view","inputs":[{"name":"o","type":"address"},{"name":"s","type":"address"}],"outputs":[{"type":"uint256"}]},
 {"name":"balanceOf","type":"function","stateMutability":"view","inputs":[{"name":"a","type":"address"}],"outputs":[{"type":"uint256"}]},
 {"name":"decimals","type":"function","stateMutability":"view","inputs":[],"outputs":[{"type":"uint8"}]},
 {"name":"totalSupply","type":"function","stateMutability":"view","inputs":[],"outputs":[{"type":"uint256"}]},
 {"name":"symbol","type":"function","stateMutability":"view","inputs":[],"outputs":[{"type":"string"}]}
]""")

ROUTER_ABI = json.loads("""[
 {"name":"addLiquidity","type":"function","inputs":[
   {"name":"tokenA","type":"address"},{"name":"tokenB","type":"address"},
   {"name":"amountADesired","type":"uint256"},{"name":"amountBDesired","type":"uint256"},
   {"name":"amountAMin","type":"uint256"},{"name":"amountBMin","type":"uint256"},
   {"name":"to","type":"address"},{"name":"deadline","type":"uint256"}],
  "outputs":[{"type":"uint256"},{"type":"uint256"},{"type":"uint256"}]}
]""")

FACTORY_ABI = json.loads("""[
 {"name":"getPair","type":"function","stateMutability":"view","inputs":[
   {"name":"a","type":"address"},{"name":"b","type":"address"}],"outputs":[{"type":"address"}]}
]""")


def load():
    if not CONF.exists():
        sys.exit(f"{CONF} missing. See the docstring for the required keys.")
    cfg = {}
    for line in CONF.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            cfg[k.strip()] = v.strip()
    return cfg


def save(key, value):
    """Persist a result so a re-run cannot repeat an irreversible step."""
    lines = CONF.read_text().splitlines()
    out, seen = [], False
    for line in lines:
        if line.strip().startswith(key + "="):
            out.append(f"{key}={value}")
            seen = True
        else:
            out.append(line)
    if not seen:
        out.append(f"{key}={value}")
    CONF.write_text("\n".join(out) + "\n")


def connect(cfg):
    w3 = Web3(Web3.HTTPProvider(cfg["RPC"], request_kwargs={"timeout": 60}))
    # BSC is proof-of-authority: its blocks carry an extraData field longer than
    # Ethereum's, and web3 rejects them without this.
    w3.middleware_onion.inject(ExtraDataToPOAMiddleware, layer=0)
    if not w3.is_connected():
        sys.exit(f"cannot reach {cfg['RPC']}")
    if w3.eth.chain_id != 56:
        sys.exit(f"WRONG CHAIN: chain_id {w3.eth.chain_id}, expected 56 (BSC mainnet)")
    acct = w3.eth.account.from_key(cfg["PRIVATE_KEY"])
    return w3, acct


def send(w3, acct, tx, label):
    tx.setdefault("from", acct.address)
    tx.setdefault("nonce", w3.eth.get_transaction_count(acct.address))
    tx.setdefault("chainId", 56)
    # Pick ONE fee model. web3 >= 6 adds EIP-1559 fields in build_transaction()
    # whenever the chain advertises them, and BSC rejects a transaction carrying
    # both those and a legacy gasPrice:
    #   "both gasPrice and (maxFeePerGas or maxPriorityFeePerGas) specified"
    # Legacy gasPrice is what BSC validators actually price on, so drop the 1559
    # pair rather than the other way round.
    tx.pop("maxFeePerGas", None)
    tx.pop("maxPriorityFeePerGas", None)
    tx.setdefault("gasPrice", w3.eth.gas_price)
    if "gas" not in tx:
        tx["gas"] = int(w3.eth.estimate_gas(tx) * 1.25)
    signed = acct.sign_transaction(tx)
    h = w3.eth.send_raw_transaction(signed.raw_transaction)
    print(f"  {label}: sent {h.hex()}")
    r = w3.eth.wait_for_transaction_receipt(h, timeout=300)
    cost = r.gasUsed * tx["gasPrice"] / 1e18
    if r.status != 1:
        sys.exit(f"  {label}: REVERTED in block {r.blockNumber} -- stopping")
    print(f"  {label}: ok, block {r.blockNumber}, {r.gasUsed:,} gas, {cost:.8f} BNB")
    return r


def cmd_addr(cfg):
    w3, acct = connect(cfg)
    bnb = w3.eth.get_balance(acct.address) / 1e18
    usdt_c = w3.eth.contract(address=USDT, abi=ERC20_ABI)
    usdt = usdt_c.functions.balanceOf(acct.address).call() / 10**USDT_DECIMALS
    print(f"  deployer : {acct.address}")
    print(f"  BNB      : {bnb:.8f}   (gas -- needed regardless of the pool pairing)")
    print(f"  USDT     : {usdt:.6f}")
    print(f"  chain    : {w3.eth.chain_id} (BSC mainnet)")
    need_usdt = float(cfg.get("POOL_USDT", 0))
    if bnb < 0.001:
        print(f"  NOT READY: BNB is {bnb:.8f}; send a little for gas.")
    if usdt < need_usdt:
        print(f"  NOT READY: USDT is {usdt:.6f}, POOL_USDT wants {need_usdt}.")
    if bnb >= 0.001 and usdt >= need_usdt:
        print("  READY to deploy.")


def cmd_token(cfg):
    if cfg.get("TOKEN"):
        sys.exit(f"TOKEN is already set to {cfg['TOKEN']} -- refusing to deploy a second one.\n"
                 f"Clear it in {CONF} only if you are certain the first deploy failed.")
    art = json.loads((HERE / "build" / "combined.json").read_text())
    key = next(k for k in art["contracts"] if k.endswith(":WrappedPCoin"))
    c = art["contracts"][key]
    abi = c["abi"] if isinstance(c["abi"], list) else json.loads(c["abi"])

    w3, acct = connect(cfg)
    supply = int(round(float(cfg["ISSUED_PCN"]) * 10**WPCN_DECIMALS))
    reserve = cfg["RESERVE"]
    print(f"  issuing  : {float(cfg['ISSUED_PCN']):,.8f} wPCN  ({supply} units)")
    print(f"  reserve  : {reserve}")
    print("  This must ALREADY be matched by locked PCN. Deploying does not create backing.")

    Factory = w3.eth.contract(abi=abi, bytecode=c["bin"])
    tx = Factory.constructor(supply, reserve).build_transaction(
        {"from": acct.address, "nonce": w3.eth.get_transaction_count(acct.address)})
    tx.pop("gas", None)
    r = send(w3, acct, tx, "deploy wPCN")
    addr = r.contractAddress
    save("TOKEN", addr)
    print(f"  TOKEN    : {addr}   (saved to {CONF.name})")


def cmd_pool(cfg):
    w3, acct = connect(cfg)
    token = Web3.to_checksum_address(cfg["TOKEN"])
    factory = w3.eth.contract(address=FACTORY, abi=FACTORY_ABI)
    existing = factory.functions.getPair(token, USDT).call()
    if int(existing, 16) != 0:
        sys.exit(f"a wPCN/USDT pair ALREADY exists at {existing} -- refusing to add blindly.\n"
                 "Adding to a pool that already has reserves uses ITS ratio, not yours.")

    wpcn = int(round(float(cfg["POOL_WPCN"]) * 10**WPCN_DECIMALS))
    usdt = int(round(float(cfg["POOL_USDT"]) * 10**USDT_DECIMALS))
    price = float(cfg["POOL_USDT"]) / float(cfg["POOL_WPCN"])
    print(f"  pooling  : {float(cfg['POOL_WPCN']):,} wPCN  +  {float(cfg['POOL_USDT']):,} USDT")
    print(f"  OPENING PRICE: ${price:.8f} per wPCN  <-- set by this ratio, irreversibly")

    tok = w3.eth.contract(address=token, abi=ERC20_ABI)
    usd = w3.eth.contract(address=USDT, abi=ERC20_ABI)
    have_t, have_u = tok.functions.balanceOf(acct.address).call(), usd.functions.balanceOf(acct.address).call()
    if have_t < wpcn:
        sys.exit(f"  not enough wPCN: have {have_t/10**WPCN_DECIMALS}, need {float(cfg['POOL_WPCN'])}")
    if have_u < usdt:
        sys.exit(f"  not enough USDT: have {have_u/10**USDT_DECIMALS}, need {float(cfg['POOL_USDT'])}")

    for c, amt, name in ((tok, wpcn, "wPCN"), (usd, usdt, "USDT")):
        if c.functions.allowance(acct.address, ROUTER).call() < amt:
            send(w3, acct, c.functions.approve(ROUTER, amt).build_transaction(
                {"from": acct.address, "nonce": w3.eth.get_transaction_count(acct.address)}),
                f"approve {name}")

    router = w3.eth.contract(address=ROUTER, abi=ROUTER_ABI)
    deadline = w3.eth.get_block("latest")["timestamp"] + 1200
    # Mins equal desired: on a brand-new pair there is no other liquidity to
    # move the ratio, so any shortfall means something is wrong and the tx
    # should revert rather than open the pool at a price nobody chose.
    tx = router.functions.addLiquidity(
        token, USDT, wpcn, usdt, wpcn, usdt, acct.address, deadline
    ).build_transaction({"from": acct.address,
                         "nonce": w3.eth.get_transaction_count(acct.address)})
    tx.pop("gas", None)
    send(w3, acct, tx, "createPair + addLiquidity")
    pair = factory.functions.getPair(token, USDT).call()
    save("PAIR", pair)
    print(f"  PAIR     : {pair}")
    print(f"  trade at : https://pancakeswap.finance/swap?outputCurrency={token}")


def cmd_verify(cfg):
    w3, acct = connect(cfg)
    token = Web3.to_checksum_address(cfg["TOKEN"])
    art = json.loads((HERE / "build" / "combined.json").read_text())
    key = next(k for k in art["contracts"] if k.endswith(":WrappedPCoin"))
    c = art["contracts"][key]
    abi = c["abi"] if isinstance(c["abi"], list) else json.loads(c["abi"])
    t = w3.eth.contract(address=token, abi=abi)
    print(f"  token         : {token}")
    print(f"  symbol        : {t.functions.symbol().call()}")
    print(f"  decimals      : {t.functions.decimals().call()}")
    print(f"  totalSupply   : {t.functions.totalSupply().call()/10**WPCN_DECIMALS:,.8f} wPCN")
    print(f"  issuedSupply  : {t.functions.issuedSupply().call()/10**WPCN_DECIMALS:,.8f} wPCN")
    print(f"  reserveAddress: {t.functions.reserveAddress().call()}")
    print(f"  deployer holds: {t.functions.balanceOf(acct.address).call()/10**WPCN_DECIMALS:,.8f} wPCN")
    pair = w3.eth.contract(address=FACTORY, abi=FACTORY_ABI).functions.getPair(token, USDT).call()
    print(f"  pair          : {pair if int(pair,16) else '(none yet)'}")
    if int(pair, 16):
        pt = w3.eth.contract(address=pair, abi=ERC20_ABI)
        print(f"    pool wPCN   : {t.functions.balanceOf(pair).call()/10**WPCN_DECIMALS:,.8f}")
        u = w3.eth.contract(address=USDT, abi=ERC20_ABI)
        print(f"    pool USDT   : {u.functions.balanceOf(pair).call()/10**USDT_DECIMALS:,.6f}")
        lp_total = pt.functions.totalSupply().call()
        lp_mine = pt.functions.balanceOf(acct.address).call()
        print(f"    LP tokens   : deployer holds {lp_mine} of {lp_total}"
              f" ({100*lp_mine/lp_total if lp_total else 0:.2f}%)")
        print("    NOTE: whoever holds LP tokens can withdraw the liquidity. That, not")
        print("          the token contract, is what people mean by 'is liquidity locked'.")


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    cfg = load()
    {"addr": cmd_addr, "token": cmd_token, "pool": cmd_pool,
     "verify": cmd_verify}.get(sys.argv[1], lambda _: sys.exit(__doc__))(cfg)


if __name__ == "__main__":
    main()
