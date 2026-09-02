# PCoin Wallet — permissions

| Permission | Why | Declared where |
|---|---|---|
| `INTERNET` | The bundled full node connects to PCoin peers | `src/main` |
| `ACCESS_NETWORK_STATE` | Node waits for connectivity before syncing | `src/main` |
| `FOREGROUND_SERVICE` | The node runs as a foreground service | `src/main` |
| `FOREGROUND_SERVICE_SPECIAL_USE` | API 34+; a blockchain node is not "data sync" | `src/main` |
| `FOREGROUND_SERVICE_DATA_SYNC` | API 29–33 fallback | `src/main` |
| `POST_NOTIFICATIONS` | Android 13+ requires it to show the node notification | `src/main` |
| `WAKE_LOCK` | Keeps validation running with the screen off | `src/main` |
| `CAMERA` | QR scanning on the send screen | **`src/wallet` only** |

`CAMERA` is wallet-flavour only and `uses-feature ... required="false"`, so a
device with no camera still installs — it just cannot scan.

## Foreground service type

Declared `specialUse|dataSync`; the service picks one at runtime. `specialUse`
is used on API 34+ because from targetSdk 35 a `dataSync` foreground service is
capped at 6 hours per 24 and then killed via `Service.onTimeout()`, which would
silently end an overnight sync. `specialUse` carries no such cap but requires
the Play Console justification recorded in `STORE-LISTING.md`.

## Data safety declaration

Collects nothing, shares nothing. No analytics, no ads, no crash reporting.
Camera frames are processed on-device and never stored or transmitted. The
recovery phrase is encrypted with an AndroidKeyStore key that requires a fresh
device unlock, and is never logged, notified or written elsewhere.
