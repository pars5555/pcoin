# PCoin Wallet — Play Console submission runbook

> **Submitted 2026-08-31** — app created, all 11 declarations completed, store
> listing + graphics uploaded, Finance category, 177 countries, production
> release `15 (0.2.12)` full rollout, and **11 changes sent for review**.
> The steps below are the reference for the next release.

| | |
|---|---|
| Play app id | `4975043691135197837` |
| Developer account | `5629165226012715046` (Oonak, organisation) |
| Package | `am.pc.pcoinwallet` (wallet flavour only) |
| Submitted build | `15 (0.2.12)` — `PCoinWallet-release-0.2.12-vc15.aab` |
| Category | Finance · Free · no ads · no in-app products |
| Privacy policy | https://pc.am/wallet-privacy.html |
| Contact | pcoinpcn@gmail.com · https://pc.am |

## 0. Prerequisites

- [ ] Privacy policy live — verify CONTENT, not status code:
      `curl -s https://pc.am/wallet-privacy.html | grep -o "<title>[^<]*</title>"`
- [ ] Signed AAB built and its signer verified (see `SIGNING.md`)
- [ ] Unit tests green: `gradlew.bat testWalletDebugUnitTest`
      (the whole suite is device-free; the old device-holding E2E test was removed)

## 1. Create app

Play Console → Create app → "PCoin Wallet", App, Free. Tick both declarations.

## 2. Store listing

Copy from `STORE-LISTING.md`; upload `assets/icon-512.png`,
`assets/feature-graphic.png`, screenshots 01–04. Phone screenshots also satisfy
the 7-inch and 10-inch tablet slots — select the same four from the library.

## 3. App content declarations (11)

| Declaration | Answer |
|---|---|
| Privacy policy | https://pc.am/wallet-privacy.html |
| Ads | No |
| **Sign in details** | **Yes** + one entry — see the trap below |
| Content rating | All Other App Types → all No → All ages |
| Target audience | 18 and over |
| Data safety | Collects nothing, shares nothing |
| Government apps | No |
| **Financial features** | **Cryptocurrency wallet** + 12 jurisdiction declarations |
| Health | No health features |
| Advertising ID | No |
| Foreground services | Data sync + Special use, with a demo video |

## 4. Store settings

App category **Finance**; contact email + website. Both need the confirmation
dialog — see the trap below.

## 5. Release

Production → Create new release → upload the AAB (or Add from library) →
release notes from `RELEASE-NOTES.md` → Next → Save.
Countries: select all (177).

## 6. Submit

Publishing overview → Submit N changes for review → Send changes for review.
Checks run ~10-15 min, then it goes to Google automatically.

---

## Traps that cost hours here — read before repeating

1. **"Save and publish" opens a SECOND confirmation dialog** ("Publish change on
   Google Play?"). Miss it and the change silently reverts on reload while the
   summary still shows your value. This ate the contact details three times.
   **Always reload and re-read after saving.**

2. **"Sign in details" must be YES.** The wallet asks for the device screen
   lock before sending, and Google's list counts *biometric authentication* as
   restricted access. Declaring No fails the pre-submission check with
   *"Missing sign in details"* and blocks ALL changes. The entry we ship names
   no credentials, because none exist — it explains the flow instead. Text is
   in `STORE-LISTING.md`, and it must be **≤500 characters**.

3. **Financial features → Cryptocurrency wallet** demands a licensing
   declaration for 12 jurisdictions. Each one offers
   *"I confirm that my app is a non-custodial software wallet"* — that is the
   correct and honest answer here, and no licence upload is needed.

4. **Foreground services needs a demo VIDEO** (unlisted YouTube is fine),
   showing the service running and its notification. Ours:
   https://www.youtube.com/watch?v=sY2qV5UdeWs

5. **The targetSdk floor MOVES, and Play tells you only at upload.** It was 35
   for 0.2.12 on 2026-08-31; **eight days later, on 2026-09-06, an upload was
   rejected with "targets API level 35 and must target at least API level 36".**
   Nothing warns you in advance and the local build is perfectly happy — the
   refusal happens in the console, after the bundle is uploaded, which matters
   because of trap 8 below. **Check the current floor before every build**, bump
   `compileSdk`/`targetSdk` in `app/build.gradle.kts` and
   `android.suppressUnsupportedCompileSdk` in `gradle.properties` together
   (AGP 8.5.1 predates both 35 and 36 and refuses without the suppression).

   Raising it changes app behaviour. targetSdk 35 made Android draw edge-to-edge
   and silently turned `adjustResize` into a no-op; without `padForSystemBars()`
   the Send button hides under the navigation bar. See
   `../../app/src/main/java/org/pcoin/miner/SystemInsets.kt`.

6. **CameraX must be 1.4.x.** 1.3's `libimage_processing_util_jni.so` is
   4 KB-aligned and fails Play's 16 KB page-size check.

7. **A saved release cannot be edited.** To change its bundle: Release details
   → Discard release → Create new release → Add from library. Uploaded bundles
   stay in the library, so discarding loses nothing but the notes.

8. **A version code is BURNED THE MOMENT IT IS UPLOADED — even into a draft you
   then discard.** Re-uploading it returns *"Version code N has already been
   used. Try another version code."* On 2026-09-06 codes 16 and 17 were both
   consumed this way in one sitting: 16 by a bundle Play rejected for
   targetSdk 35, 17 by a re-upload attempt after the draft was discarded. The
   fix shipped as 17 only because the discarded bundle was still in the
   **artifact library** — `Add from library`, not `Upload`, is what recovers it.
   So: never re-upload a file to fix a rejected draft; discard the draft, create
   a new release, and add the already-uploaded bundle from the library.

9. **"Save" on the preview step does NOT submit.** It saves the release and
   offers "Go to Publishing overview", where **Submit N changes for review** →
   a second **Send changes for review** dialog is what actually sends it. Two
   confirmations, same as the store-listing trap in point 1.
