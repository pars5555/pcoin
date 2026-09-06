#!/usr/bin/env python3
"""Build the house announcement card: 1200x630, PCoin brand, live figures.

    python make_card.py --out card.png \
        --headline "WebAI now takes PCN" \
        --tagline  "An AI assistant that lives in your browser" \
        --stat "3 confirmations|about 30 minutes" \
        --stat "1 PCN|minimum deposit" \
        --stat "No subscription|pay as you go" \
        --cta "webai.pc.am/deposit"

WHY THIS FILE IS IN THE REPO
The previous generator lived in a scratchpad and the scratchpad was cleaned, so
it is gone along with every other helper (CLAUDE.md 2). Rebuilding one outside
version control would be making the same mistake a second time.

WHY IT REFUSES RATHER THAN GUESSES
Every figure on the card is a promise (CLAUDE.md 8b). `--rate-from` reads the
live oracle at build time, and a failed read ABORTS: a card is published once
and then circulates forever, so a stale or invented number is worse than no
card. There is no default rate and no fallback constant, deliberately -- the
whole class of bug this project keeps hitting is an unreadable value quietly
becoming a plausible one.

1200x630 is not arbitrary: Telegram renders that aspect uncropped, and a taller
card is shrunk to a thumbnail nobody can read.
"""
import argparse
import datetime
import json
import os
import sys
import urllib.request

from PIL import Image, ImageDraw, ImageFont

W, H = 1200, 630
BG = (10, 11, 16)
INK = (233, 235, 244)
MUTED = (150, 158, 178)
TEAL = (45, 212, 191)
PURPLE = (139, 92, 246)
CARD = (22, 25, 33)

FONT_DIRS = ["C:/Windows/Fonts", "/usr/share/fonts/truetype/dejavu",
             "/usr/share/fonts/truetype/liberation", "/Library/Fonts"]
BOLD = ["calibrib.ttf", "arialbd.ttf", "DejaVuSans-Bold.ttf",
        "LiberationSans-Bold.ttf", "Arial Bold.ttf"]
REG = ["calibri.ttf", "arial.ttf", "DejaVuSans.ttf",
       "LiberationSans-Regular.ttf", "Arial.ttf"]


def font(names, size):
    for d in FONT_DIRS:
        for n in names:
            p = os.path.join(d, n)
            if os.path.exists(p):
                try:
                    return ImageFont.truetype(p, size)
                except OSError:
                    continue
    raise SystemExit("no usable font found; looked for %s in %s"
                     % (", ".join(names), ", ".join(FONT_DIRS)))


EMOJI = ["seguiemj.ttf", "NotoColorEmoji.ttf", "AppleColorEmoji.ttc"]


def emoji_font(size):
    """Colour-emoji face, or None. Optional on purpose: a card without emoji is
    still a card, but a crash at build time would block the announcement."""
    for dd in FONT_DIRS:
        for n in EMOJI:
            pth = os.path.join(dd, n)
            if os.path.exists(pth):
                try:
                    return ImageFont.truetype(pth, size)
                except OSError:
                    continue
    return None


def live_rate(url):
    """The published rate, or abort. Never a fallback -- see the module docstring."""
    try:
        with urllib.request.urlopen(url, timeout=20) as r:
            d = json.loads(r.read().decode("utf-8"))
    except Exception as exc:
        raise SystemExit("REFUSING TO BUILD: could not read the rate from %s (%s).\n"
                         "A card outlives the moment it was built, so a guessed "
                         "number would be wrong in public for as long as it "
                         "circulates." % (url, exc))
    rate = d.get("serviceRate") or d.get("price")
    if not rate or float(rate) <= 0:
        raise SystemExit("REFUSING TO BUILD: %s answered without a usable rate (%r)"
                         % (url, d))
    return float(rate)


def wrap(draw, text, f, max_w):
    words, lines, cur = text.split(), [], ""
    for w_ in words:
        t = (cur + " " + w_).strip()
        if draw.textlength(t, font=f) <= max_w:
            cur = t
        else:
            if cur:
                lines.append(cur)
            cur = w_
    if cur:
        lines.append(cur)
    return lines


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--headline", required=True)
    ap.add_argument("--tagline", required=True)
    ap.add_argument("--feature", action="append", default=[],
                    help='"<emoji>|<line>", up to four')
    ap.add_argument("--stat", action="append", default=[],
                    help='"value|label", up to three')
    ap.add_argument("--cta", required=True)
    ap.add_argument("--motif", default="", choices=["", "browser"],
                    help="optional illustration on the right half")
    ap.add_argument("--mark", default="site/brand/pcoin-round-256.png")
    ap.add_argument("--eyebrow", default="PCoin \u00b7 PCN")
    ap.add_argument("--rate-from", default="https://price.pc.am")
    ap.add_argument("--no-rate", action="store_true",
                    help="omit the rate footnote (still stamps the build time)")
    a = ap.parse_args()

    rate = None if a.no_rate else live_rate(a.rate_from)

    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    # A vertical wash, lighter at the top, so the headline sits on contrast
    # rather than on flat black.
    for y in range(H):
        k = y / H
        d.line([(0, y), (W, y)],
               fill=(int(BG[0] + 14 * (1 - k)), int(BG[1] + 16 * (1 - k)),
                     int(BG[2] + 22 * (1 - k))))

    m = 72
    # ---- optional motif on the right --------------------------------------
    # A browser window with its side panel lit up. The card claims "inside your
    # browser"; showing the shape says it faster than the sentence does, and it
    # fills the right half, which otherwise reads as an unfinished layout.
    if a.motif == "browser":
        bx, by, bw2, bh = 700, 236, 428, 268
        d.rounded_rectangle([bx + 8, by + 10, bx + bw2 + 8, by + bh + 10],
                            radius=16, fill=(6, 7, 11))          # drop shadow
        d.rounded_rectangle([bx, by, bx + bw2, by + bh], radius=16, fill=CARD,
                            outline=(52, 58, 72), width=2)
        d.rounded_rectangle([bx, by, bx + bw2, by + 40], radius=16, fill=(32, 36, 47))
        d.rectangle([bx, by + 28, bx + bw2, by + 40], fill=(32, 36, 47))
        for i, col in enumerate([(255, 95, 87), (254, 188, 46), (40, 200, 100)]):
            d.ellipse([bx + 18 + i * 22, by + 14, bx + 30 + i * 22, by + 26], fill=col)
        # page content, suggested rather than drawn
        for i, wfrac in enumerate([0.62, 0.80, 0.45, 0.72, 0.55]):
            ly = by + 64 + i * 26
            d.rounded_rectangle([bx + 20, ly, bx + 20 + int(250 * wfrac), ly + 10],
                                radius=5, fill=(58, 64, 80))
        # the side panel: this is the product
        px = bx + bw2 - 132
        d.rounded_rectangle([px, by + 52, bx + bw2 - 16, by + bh - 16],
                            radius=12, fill=(18, 46, 46), outline=TEAL, width=2)
        f_sp = font(BOLD, 17)
        d.text((px + 16, by + 66), "WebAI", font=f_sp, fill=TEAL)
        for i, wfrac in enumerate([0.85, 0.6, 0.9, 0.5]):
            ly = by + 96 + i * 22
            d.rounded_rectangle([px + 16, ly, px + 16 + int(100 * wfrac), ly + 8],
                                radius=4, fill=(45, 120, 112))

    # ---- eyebrow: round mark + wordmark ---------------------------------
    top = 56
    try:
        mark = Image.open(a.mark).convert("RGBA").resize((56, 56), Image.LANCZOS)
        img.paste(mark, (m, top), mark)
        tx = m + 56 + 18
    except Exception:
        tx = m                      # the card is still valid without the mark
    f_eye = font(BOLD, 26)
    d.text((tx, top + 14), a.eyebrow, font=f_eye, fill=MUTED)

    # ---- gradient rule ---------------------------------------------------
    ry = top + 56 + 30
    for x in range(m, W - m):
        k = (x - m) / (W - 2 * m)
        d.line([(x, ry), (x, ry + 3)],
               fill=(int(TEAL[0] + (PURPLE[0] - TEAL[0]) * k),
                     int(TEAL[1] + (PURPLE[1] - TEAL[1]) * k),
                     int(TEAL[2] + (PURPLE[2] - TEAL[2]) * k)))

    # ---- headline --------------------------------------------------------
    # With a motif on the right the text column has to stop short of it, or the
    # headline runs under the illustration -- which it did, through the browser
    # chrome, on the first build.
    col = (W - 2 * m - 470) if a.motif else (W - 2 * m)
    y = ry + 44
    # Shrink the headline until it fits on ONE line rather than wrapping. A
    # wrapped headline pushes the features into the CTA, and the vertical budget
    # of a fixed-height card has no slack to absorb that. Falls back to wrapping
    # only if even the floor size will not fit, so a very long headline still
    # renders instead of overflowing.
    size = 76
    while size > 46 and d.textlength(a.headline, font=font(BOLD, size)) > col:
        size -= 2
    f_h = font(BOLD, size)
    lines = ([a.headline] if d.textlength(a.headline, font=f_h) <= col
             else wrap(d, a.headline, f_h, col))
    for line in lines:
        d.text((m, y), line, font=f_h, fill=INK)
        y += int(size * 1.14)

    # ---- tagline ---------------------------------------------------------
    y += 6
    f_t = font(REG, 34)
    for line in wrap(d, a.tagline, f_t, col):
        d.text((m, y), line, font=f_t, fill=TEAL)
        y += 44

    # ---- feature rows (emoji + line) -------------------------------------
    # Colour emoji needs its own face and embedded_color=True; the text font
    # renders them as blank boxes. Drawn as separate runs for that reason.
    if a.feature:
        y += 18
        f_fe = font(REG, 30)
        f_em = emoji_font(34)
        for spec in a.feature[:4]:
            parts = spec.split("|", 1)
            glyph = parts[0].strip()
            label = parts[1].strip() if len(parts) > 1 else ""
            if f_em is not None and glyph:
                try:
                    d.text((m, y - 4), glyph, font=f_em, embedded_color=True)
                except Exception:
                    d.text((m, y), glyph, font=f_fe, fill=TEAL)
            d.text((m + 58, y), label, font=f_fe, fill=INK)
            y += 46

    # ---- stat row --------------------------------------------------------
    stats = [s.split("|", 1) for s in a.stat[:3]]
    if stats:
        y += 26
        bw = (W - 2 * m - 2 * 20) // max(len(stats), 1)
        f_sv = font(BOLD, 34)
        f_sl = font(REG, 21)
        for i, pair in enumerate(stats):
            val = pair[0].strip()
            lab = pair[1].strip() if len(pair) > 1 else ""
            bx = m + i * (bw + 20)
            d.rounded_rectangle([bx, y, bx + bw, y + 96], radius=14, fill=CARD)
            d.text((bx + 20, y + 18), val, font=f_sv, fill=INK)
            d.text((bx + 20, y + 60), lab, font=f_sl, fill=MUTED)
        y += 96

    # ---- CTA + footnote --------------------------------------------------
    # Placed from the content above rather than at a fixed offset from the
    # bottom: a two-line tagline pushed the stat row down into the button, and
    # a card is not something you get to fix after it has been posted.
    f_c = font(BOLD, 30)
    cw = int(d.textlength(a.cta, font=f_c)) + 56
    cy = max(y + 34, H - 138)
    if cy + 60 > H - 74:                      # keep clear of the footnote
        cy = H - 74 - 60 - 10
    d.rounded_rectangle([m, cy, m + cw, cy + 60], radius=30, fill=TEAL)
    d.text((m + 28, cy + 14), a.cta, font=f_c, fill=(8, 20, 20))

    f_f = font(REG, 19)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%d %b %Y %H:%M UTC")
    note = ("Rate read %s: $%.6f per PCN" % (stamp, rate)) if rate else ("Built %s" % stamp)
    d.text((m, H - 52), note, font=f_f, fill=MUTED)

    img.save(a.out, "PNG", optimize=True)
    print("wrote %s  %dx%d  %d bytes" % (a.out, W, H, os.path.getsize(a.out)))
    if rate:
        print("rate stamped: %.10f (live from %s)" % (rate, a.rate_from))


if __name__ == "__main__":
    sys.exit(main())
