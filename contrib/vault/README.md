# pcoin-seed-vault

Create a system's PCN wallet offline, and back it up so it can be recovered
without ever putting a spendable key on a server.

```
npm install
node pcoin-seed-vault.mjs --selftest       # must print ALL CHECKS PASSED
node pcoin-seed-vault.mjs new --system <name>
```

## What problem this solves

A service that accepts PCN needs somewhere for the coins to land. The obvious
approach — a wallet on the web server — means a server breach is a total loss.

This tool takes the other approach. One HD wallet per system; every user's
deposit address is a non-hardened child of it. The server gets only the
**account xpub**, which can watch every deposit and cannot spend a satoshi. The
private side never leaves the owner's machine.

A consequence worth stating plainly: **there is nothing to consolidate.** All
the per-user addresses are already one wallet. "The system's balance" is a sum
over the pool, not a transaction anyone has to make. When the owner wants the
money moved, they restore the phrase offline, sweep, and broadcast.

## Output

| file | goes to | can it spend? |
|---|---|---|
| `<system>-xpub.txt` | the server | no — watch only |
| `<system>-seed.enc.json` | both vault hosts | only with the passphrase |

Both patterns are in the repo's `.gitignore`, because `new` writes into the
current directory and a run started inside a clone would otherwise leave a
wallet backup staged for commit.

## Commands

| command | does |
|---|---|
| `--selftest` | derivation vectors, encryption round-trip, tamper detection |
| `new --system <name>` | generate, verify the paper copy, encrypt, write both files |
| `verify --file <blob>` | decrypt and prove it reproduces the recorded xpub. Exit 0/1, so it works in a cron check |
| `restore --file <blob>` | print the twelve words. Only when about to sign |

## Three things that are deliberate

**The paper copy is verified before anything is written.** The tool prints the
words, clears the screen, and makes you type them back. A mismatch aborts
without writing a file. A backup discovered wrong on the day you need it is not
a backup, and this is the only moment when fixing it is free.

**`verify` re-derives rather than just decrypting.** It decrypts the phrase,
derives the account xpub again, and compares against the xpub recorded in the
blob. That proves the file reproduces *that specific wallet* — not merely that
it is well-formed JSON with the right passphrase.

**Encryption is AES-256-GCM over scrypt (N=2^17).** GCM authenticates, so a
wrong passphrase or a flipped bit throws instead of returning plausible
rubbish. scrypt is deliberately slow: the passphrase is the only thing between a
stolen blob and the coins.

## The trap that costs real money

PCoin kept Bitcoin's `xprv`/`xpub` version bytes. Under coin type `0'` the same
seed derives **live Bitcoin keys**, and nothing in the encoding would warn you.
The account path is `m/84'/9444'/0'`, and `--selftest` asserts both that it
matches the published PCoin vectors (`PCOIN.md` §6.4) and that coin type `0'`
produces the known Bitcoin address instead. Never change it.

## Operational procedure

Generating a wallet, verifying the paper copy, uploading to both vault hosts and
sweeping are written up in `D:\pc.am\PCOIN-CUSTODY-RUNBOOK.md`, which is kept
off this repo because it names the vault hosts.

The short version: run it yourself, in your own terminal, offline if you can.
Not over SSH, not through an assistant. The twelve words appear on screen once
and the passphrase is typed rather than passed as an argument, specifically so
neither can end up in a transcript, a shell history or a log.
