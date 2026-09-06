# PCoin Wallet — release notes

## 0.2.14 (versionCode 17) — submitted 2026-09-06

Play copy (en-US):

```
Fixes a crash: the app could close by itself when Android restarted its node service in the background. It now shuts that service down cleanly and starts it again when you open the app.

Your wallet, your recovery phrase and your saved addresses are untouched by this update.
```

The bug, in full: from Android 12 a foreground service may not be STARTED while
the app is in the background, and the refusal is not raised where you would look
for it. `startForegroundService()` returns normally; the refusal arrives inside
`MinerService.onCreate` as `ForegroundServiceStartNotAllowedException`, on the
main thread, where nothing caught it. `onStartCommand` returned `START_STICKY`,
so Android relaunched the service into the identical refusal. Seen on the
owner's phone on the LIVE 0.2.12 build: two FATAL EXCEPTIONs 19 s apart, no
reboot involved.

Two `try`/`catch` blocks were *already* wrapped around the calls that start this
service, both commented "Android 12 may refuse". **Both are on the wrong side of
the process boundary and had never caught anything.** The guard now lives in
`goForeground`, which returns false instead of throwing, and `onStartCommand`
returns `START_NOT_STICKY` once refused so the relaunch loop cannot form.

**0.2.13 (versionCode 16) exists but never reached a user** — Play rejected it
for targetSdk 35 (see SUBMISSION.md trap 5), and the code was burned by the
upload (trap 8), so the same fix shipped as 0.2.14 at targetSdk 36.

## 0.2.12 (versionCode 15) — submitted 2026-08-31, LIVE since 2026-09-04

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
