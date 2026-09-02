# Signing material is deliberately NOT in this folder

The other Play projects on this machine (`crowd-counting`, `guess-the-word`,
`JajTur`) keep `*.jks` and `KEYSTORE-CREDENTIALS.txt` in `playstore/v1/files/`.
Those repositories are private. **This one is public** —
github.com/pars5555/pcoin — and `CLAUDE.md` §8 forbids any key, token, password
or seed phrase in the tree. `.gitignore` blocks `*.keystore` and `*.aab` as a
net under the tightrope, not as permission to keep a copy here.

So this folder holds pointers, not material.

| What | Where |
|---|---|
| Release keystore | `D:\pc.am\pcoin-release.keystore` |
| Debug keystore | `D:\pc.am\pcoin-debug.keystore` |
| Passwords / aliases | `D:\pc.am\PCOIN-SECRETS.md` §2b |
| Gradle wiring | `contrib/android/signing.properties` (untracked) |
| Off-machine copy 1 | custody vault 1 — host and path in `D:\pc.am\PCOIN-CUSTODY-RUNBOOK.md` (off-repo) |
| Off-machine copy 2 | custody vault 2 — same runbook |

Fingerprints and the verified backup hashes are in `../SIGNING.md`.

The built bundle `../PCoinWallet-release-0.2.12-vc15.aab` is on disk next to
this file but is gitignored — it is a build artifact, reproducible with
`bundleWalletRelease`, and Play already holds the copy that matters.
