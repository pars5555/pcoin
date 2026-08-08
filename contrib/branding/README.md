# Branding

The PCoin mark is a **struck coin**: a milled edge, a struck face, a four-point
star cut into it. Graphite `#262B33` field, white mark.

Everything below is **generated**. `make-icons.ps1` is the single source, and it
emits the Android drawables, the website SVG, every PNG size and (via
`make-ico.py`) the Windows `.ico` from one set of constants.

```powershell
contrib\branding\make-icons.ps1      # writes the Android XML + contrib/branding/out/
python contrib\branding\make-ico.py  # packs out/*.png into the .ico files
```

`make-icons.ps1` writes directly into `contrib/android/app/src/{miner,wallet}/res/`.
Re-running it and getting no `git diff` is the check that the tracked drawables
still match the generator.

## Why generated and not hand-drawn

The same mark ships on Android, on the website, in the Windows tray and in the
installer. Keeping four hand-maintained copies in step is how a logo ends up
subtly different on one platform and nobody notices for a year. Editing a
generated file directly desyncs it silently — change the constants at the top of
`make-icons.ps1` instead.

The one input that is **not** computed is `wallet-word.path`: the outlines of the
word WALLET, extracted once from Segoe UI Bold. VectorDrawable has no `<text>`
element, so the word has to ship as outlines or it renders differently on every
phone. Regenerate it with `scratchpad/extract_word.ps1` only if the wording or
the type changes.

## The geometry, and why it is what it is

The canvas is Android's adaptive **108×108**. A launcher shows only the middle
**72×72**, and only the central **66×66 circle** survives every OEM mask —
Samsung, Pixel and OnePlus all crop differently. The whole mark sits inside that
circle, which is checked numerically rather than by eye.

Three decisions are load-bearing:

**16 teeth, not 24.** The first version had 24 and thin star arms. It looked
better at 512px and fell apart at 48dp — the teeth blurred into a grey ring and
the star nearly vanished. The count and the arm width were both set by looking
at the 48px raster, which is the only size that decides anything.

**The shapes are cut, not overpainted.** The star is a genuine hole in the face
and the lettering is a genuine hole in the base, both via `evenOdd`. Paint them
in the field colour instead and the foreground stops being transparent there,
which silently degrades the Android 13 monochrome themed icon into a solid blob.
The `A` counter lands at three crossings and so fills back to white, which is
what a real counter does.

**Both flavours share the field colour.** They used to differ only by hue, which
means they were indistinguishable in greyscale and to a colour-blind user. They
are now told apart by *silhouette*: the wallet carries a base plate with WALLET
struck out of it. Graphite measures 14.2:1 against the white mark, the highest of
ten fields that were tested; below roughly 3:1 the milled edge stops resolving at
48dp.

## What ships where

| Artifact | Consumer |
|---|---|
| `app/src/{miner,wallet}/res/drawable/ic_launcher_foreground.xml` | adaptive icon, API 26+ |
| `app/src/{miner,wallet}/res/mipmap/ic_launcher.xml` | API 24–25, which predate adaptive icons |
| `app/src/{miner,wallet}/res/values/ic_launcher_background.xml` | the field colour |
| `pcoin-miner.svg`, `pcoin-wallet.svg` | pc.am favicon, nav and footer logos |
| `play-store-{miner,wallet}-512.png` | Google Play listing, which rejects vectors |
| `../windows-tray/pcoin.ico` | installer icon and shortcuts |
| `PCoinTray.cs` `MakeIcon()` | tray, drawn in code because it needs two tinted states |

`out/` is scratch and is gitignored; the artifacts that actually ship are tracked.

## Changing the mark

1. Edit the constants at the top of `make-icons.ps1`.
2. Re-run both generators.
3. **Look at the 48px render**, not the 512. That is where designs die.
4. Rebuild both APKs — `gradlew.bat assembleMinerDebug assembleWalletDebug` —
   and confirm the drawables differ between flavours inside the APKs.
5. Update `PCoinTray.cs` `MakeIcon()` to match, since it is the one copy the
   generator cannot write.

Step 5 is the weak point in this arrangement and is worth remembering: the tray
draws the mark in C# because `build.bat` is a bare `csc.exe` file list with no
resource step, so there is nowhere to embed an icon from.
