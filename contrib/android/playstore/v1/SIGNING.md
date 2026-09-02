# PCoin Wallet — signing

## Keys

| | Release | Debug |
|---|---|---|
| Keystore | `D:\pc.am\pcoin-release.keystore` | `D:\pc.am\pcoin-debug.keystore` |
| Alias | `pcoin` | `androiddebugkey` |
| SHA-256 | `2D:C0:84:24:50:7C:08:C1:2F:5A:FB:7C:E7:32:8D:5F:4F:EC:77:2D:DE:04:DE:40:D6:9A:69:E8:DC:AC:CB:32` | `DE:1F:D6:50:53:B2:44:8D:65:41:C0:1C:04:5B:59:9D:68:34:4E:71:F8:2E:B8:54:89:5E:E5:CE:A8:A5:10:D8` |
| Algorithm | RSA 4096, valid to 2056-07-26 | standard debug key |

Passwords are in `D:\pc.am\PCOIN-SECRETS.md` §2b. Paths and passwords are read
by Gradle from `contrib/android/signing.properties`, which is **not** in git.

## Why both keys are irreplaceable

- **Release key**: Android refuses to upgrade an app signed with a different
  key. Lose it and no future APK can ever update an installed one — every user
  would have to uninstall, and an uninstall destroys the wallet in app-private
  storage.
- **Debug key**: the fleet phones run debug-signed builds and hold real wallets.
  The default `~/.android/debug.keystore` was lost and silently regenerated once
  (2026-08-04), producing a build Android refused to install over the existing
  one. That is why `debugStoreFile` is pinned.

## Backups — three copies, verified by hash

| Location | Path |
|---|---|
| Working machine | `D:\pc.am\pcoin-{release,debug}.keystore` |
| Vault host 1 | the custody vault — host and path in `D:\pc.am\PCOIN-CUSTODY-RUNBOOK.md` (off-repo: it names the vault hosts) |
| Vault host 2 | the second custody vault — same runbook |

Both vault copies are `0600 root:root` and were verified byte-identical on
2026-08-31:

```
f055edf4929e907a41b0188b7015e931b9ad9b3f17a8e7ac34cb6191f80a0d0c  pcoin-release.keystore
3ab3538c909429ef5750680dcea1cc3a5ae674afa2ca4cff385552b4d94a1005  pcoin-debug.keystore
```

The keystore files are on the vaults; the passwords are **only** on `D:`. That
split is deliberate and matches how the seed blobs are stored — no single
machine holds both halves.

## Play App Signing

Play re-signs the delivered APKs with Google's own key, so the store version
carries a DIFFERENT certificate from `2dc08424…`. Consequences:

- A Play install and a sideloaded APK **cannot upgrade each other**. The
  owner's phone runs the sideloaded release build; moving it to the Play build
  later means uninstall + restore from the 12 words.
- Record the Play app-signing SHA-1/SHA-256 here once Google publishes them
  (Test and release → App integrity → App signing).

## Verify before shipping

```powershell
apksigner verify --print-certs app\build\outputs\apk\wallet\release\app-wallet-release.apk
```
