# PCoin Wallet — release notes

## 0.2.12 (versionCode 15) — submitted 2026-08-31

Play copy (en-US):

```
First public release: a non-custodial PCoin (PCN) wallet that runs a full node on your phone. Send and receive PCN, choose your network fee, scan QR codes, keep a private address book you can export and import, and back everything up with a 12-word recovery phrase.
```

What actually changed on the way to this build:

| Version | Change |
|---|---|
| 0.2.9 (13) | Fee tiers on the send screen — Normal 1, Fast 5, Very fast 20 sat/vB, with per-tier safety ceilings; address book export/import to a JSON file |
| 0.2.10 (13) | Rebuilt for Play: targetSdk 35, CameraX 1.4.2, node relinked 16 KB-aligned |
| 0.2.11 (14) | Selected fee tier is a FILLED button — the alpha-only difference was invisible on a real phone |
| 0.2.12 (15) | History scrolls forever (pages of 50 via `listtransactions` skip) instead of stopping at 50; every screen pads clear of the system bars and keyboard |

## Version numbering

`versionCode` must increase on **every** build that leaves this machine, even
when only metadata changed. Two different binaries reporting one version has
already happened once in this project and cost a day of confusion.

The `miner` flavour has its own independent numbering; a shared-code fix that
changes both apps' behaviour must bump both.
