# Security Policy

PCoin is an independent Layer-1 chain. It is a fork of the Bitcoin Core codebase,
but it is **not** Bitcoin Core and the Bitcoin Core project cannot act on a bug
in it. Please do not send PCoin issues to `security@bitcoincore.org` — this file
used to say that, and a report sent there would simply never reach us.

## Reporting a vulnerability

**Preferred: [open a private security advisory](https://github.com/pars5555/pcoin/security/advisories/new).**
It is private to the maintainers, needs no key exchange, and gives us a place to
work with you on a fix and a disclosure date.

If you cannot use GitHub, email **pcoin@pc.am**. Say only that you have a
security issue and we will arrange an encrypted channel before you send details.
Please do not put an exploit in a first email.

**Please do not open a public issue, and do not post it in the Telegram channel.**
The chain is live and carries real value; a public report is an attack that has
not happened yet.

## What is in scope

Anything that can take money, halt the chain, or rewrite it:

| area | examples |
|---|---|
| Consensus | `src/pow.cpp` (LWMA), `src/crypto/pow_randomx.*`, `src/validation.cpp`, `src/kernel/chainparams.cpp` |
| Node | P2P handling, RPC, the built-in miner (`src/node/cpuminer.*`) |
| Wallets | derivation, seed storage, the Android and Windows apps |
| Services in `contrib/` | pool, market, explorer, price oracle, wrap desk, deposit watchers |
| wPCN | `contrib/wpcn/WrappedPCoin.sol` and the reserve/redeem path |
| Supply chain | the installers, release artefacts, and the checksums that gate them |

Reports about upstream Bitcoin Core code that PCoin has not modified are still
welcome, but please report those to Bitcoin Core as well — they own the fix.

## What to expect

- **Acknowledgement within 72 hours.** If you do not hear back, please chase us;
  a silent report is a failure on our side, not a decision.
- We will tell you what we found, what we are changing, and when.
- Credit in the release notes if you want it, and none if you do not.

There is no bug bounty programme. We will not pretend otherwise, and we would
rather you knew that before spending your time.

## A note on scope we already know about

Some weaknesses are documented and deliberate rather than undiscovered — the
legacy pre-height-2800 difficulty overflow is left broken on purpose because
fixing it would orphan the live chain (`src/pow.cpp`), and release checksums are
not yet signed. Reports on those are still welcome; you will just get a pointer
to the existing reasoning rather than a fix.
