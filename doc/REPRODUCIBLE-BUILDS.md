# Reproducible builds

**The machinery already exists and has never been run.** `contrib/guix/` and
`depends/` are byte-identical to Bitcoin Core v29.4 — `git diff v29.4..HEAD`
over either directory is empty. PCoin therefore inherits Bitcoin Core's Guix
build system intact, and making PCoin's releases reproducible is a matter of
*using* it, not writing anything.

That distinction matters, because "add reproducible builds" sounds like a
project and is mostly an afternoon of compute.

---

## What this buys you

Today's releases are built once, on one machine, and published with SHA-256
checksums at <https://pc.am/dl/SHA256SUMS.txt>. Those checksums prove your
download was not corrupted in transit. They **do not** prove the binary
corresponds to the published source — only the person who built it knows that.

A Guix build fixes exactly that: it pins the entire toolchain by content hash
and builds in an isolated container, so anyone can rebuild the same commit and
get **bit-identical** binaries. Independent parties then attest to the same
hashes, and "trust the maintainer" is replaced by "check for yourself".

Exchanges ask for this. So does anyone who takes custody seriously.

---

## Prerequisites

Guix, and a machine with real disk and time. Verified working on the WSL2 box
used for PCoin's Linux builds:

```
Ubuntu 24.04, 16 cores, 15 GB RAM, 752 GB free
guix (GNU Guix) 1.4.0            # apt install guix
guix-daemon                       # active
```

`apt install guix` is enough on Debian/Ubuntu. Other options — the upstream
shell installer, a binary tarball, fanquake's Docker image — are covered in
[`../contrib/guix/INSTALL.md`](../contrib/guix/INSTALL.md), which is upstream's
own document and applies unchanged.

Budget **several hours** for the first run and tens of gigabytes in
`/gnu/store`. Guix bootstraps a whole toolchain from source before it builds
anything of ours. Later runs reuse the store and are far quicker.

---

## Running it

From a clean checkout of the tag you want to release:

```bash
cd /root/pcoin-build            # a plain copy, not a git worktree, is fine
git checkout v1.2.1             # build a TAG, never a moving branch

# Build. HOSTS selects the targets; the default set is every platform upstream
# supports, which is far more than PCoin ships.
env HOSTS='x86_64-linux-gnu x86_64-w64-mingw32' ./contrib/guix/guix-build
```

Output lands in `guix-build-<version>/output/<host>/`, with a `SHA256SUMS.part`
per host.

```bash
# Attest to what you got. This signs the hashes with your key.
./contrib/guix/guix-attest

# Compare against someone else's attestation.
./contrib/guix/guix-verify
```

`./contrib/guix/guix-clean` removes build state without touching the store.

---

## What PCoin actually needs to ship

1. Build the release tag under Guix on two independent machines.
2. Confirm the `SHA256SUMS` match exactly.
3. Publish the sums **and** the attestations next to the release.
4. State in the release notes which commit and which Guix revision produced
   them, so a third party can repeat it.

Until step 3 happens, the honest statement — and the one currently made in
`pc.am/dl/SHA256SUMS.txt` and in [`INTEGRATION.md`](INTEGRATION.md) — is that
**the builds are not yet reproducible**. That sentence should be deleted only
when it stops being true.

---

## Things that will bite

* **Build a tag, not a branch.** A reproducible build of a moving target is not
  reproducible. `git checkout v1.2.1`, not `main`.
* **The tree must be clean.** Guix builds what is committed. An uncommitted
  change produces a binary nobody else can reproduce, which is worse than not
  trying, because the hashes will look authoritative.
* **`contrib/guix/` and `depends/` must stay untouched.** They are upstream's,
  unmodified, and that is what makes the result comparable to Bitcoin Core's own
  toolchain. If PCoin ever needs to patch them, say so loudly in the release
  notes — a fork of the build system is a fork of the trust model.
* **The Android `libbitcoind.so` is out of scope.** It is built separately with
  the NDK (recipe: `contrib/android/playstore/v1/DEPLOY.md`) and is not covered by
  any of this. The APK is
  also debug-signed today, so its provenance rests on the signing key, not on
  the build.
* **Do not run this on a seed.** It will saturate the machine for hours. Use a
  build box.

---

## Current status

| | |
|---|---|
| Guix machinery present and unmodified | yes, byte-identical to v29.4 |
| Guix installed on the build box | yes, 1.4.0, daemon active |
| Release built under Guix | **not yet** |
| Attestations published | **not yet** |
| Claim made publicly | "not reproducible yet", stated plainly |

The remaining work is compute and a second machine, not code.
