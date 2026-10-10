#!/usr/bin/env python3
"""Draws the DMG window's background: packaging/dmg/background.png and background@2x.png.

The PNGs are committed, so a release never runs this. Run it only to change the art:

    python3 Scripts/make-dmg-background.py [path/to/Inter/fonts/]

Needs Pillow and the Inter typeface (https://rsms.me/inter/). Icon positions here must match
`icon_locations` in packaging/dmg/settings.py — the arrow is drawn from one to the other.
"""
import math
import os
import sys

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "packaging", "dmg")
FONTS = sys.argv[1] if len(sys.argv) > 1 else "/usr/share/fonts/opentype/inter/"

# Points. 428 tall, everything inside the top 400: see `window_rect` in settings.py.
W, H = 640, 428
PANE_AT, APPS_AT = (190, 205), (450, 205)

INK = (63, 68, 72)          # the caret in the app icon
ARROW = (160, 151, 143)
MUTED = (138, 130, 123)
# A shade under the icon's own off-white, so the icon still reads as an object on it.
TOP, BOTTOM = (246, 242, 237), (233, 226, 218)

TITLE = "Drag Pane to Applications"
# Until there is a Developer ID: the people who see this window are the ones about to meet
# Gatekeeper's "damaged" dialog for the first time. One line, and it goes when signing arrives.
FOOTER = "Pane isn’t signed by Apple yet. If macOS says it’s damaged, see the README."


def font(name, size):
    return ImageFont.truetype(os.path.join(FONTS, name), size)


def draw(scale):
    w, h = W * scale, H * scale
    img = Image.new("RGB", (w, h))
    px = img.load()
    for y in range(h):
        t = min(y / (400 * scale), 1.0)
        row = tuple(round(a + (b - a) * t) for a, b in zip(TOP, BOTTOM))
        for x in range(w):
            px[x, y] = row
    d = ImageDraw.Draw(img)

    f = font("InterDisplay-SemiBold.otf", 20 * scale)
    d.text((w / 2, 64 * scale), TITLE, font=f, fill=INK, anchor="mm")

    # A soft arc between the icons, ending in an open chevron. Drawn at 4x and scaled down, because
    # PIL does not antialias lines.
    k = 4
    layer = Image.new("L", (w * k, h * k), 0)
    ld = ImageDraw.Draw(layer)
    x0, x1 = (PANE_AT[0] + 70) * scale * k, (APPS_AT[0] - 70) * scale * k
    y0 = (PANE_AT[1] - 2) * scale * k
    sag = 14 * scale * k
    pts = [(x0 + (x1 - x0) * i / 60, y0 - sag * math.sin(math.pi * i / 60)) for i in range(61)]
    stroke = round(2.2 * scale * k)
    r = stroke / 2

    def dot(p):
        ld.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=255)

    ld.line(pts, fill=255, width=stroke, joint="curve")
    dot(pts[0])
    dot(pts[-1])
    ex, ey = pts[-1]
    heading = math.atan2(pts[-1][1] - pts[-4][1], pts[-1][0] - pts[-4][0])
    for side in (-1, 1):
        a = heading + math.pi - side * math.radians(36)
        tip = (ex + 10 * scale * k * math.cos(a), ey + 10 * scale * k * math.sin(a))
        ld.line([(ex, ey), tip], fill=255, width=stroke)
        dot(tip)
    img.paste(Image.new("RGB", (w, h), ARROW), (0, 0), layer.resize((w, h), Image.LANCZOS))

    f = font("Inter-Regular.otf", 12 * scale)
    d.text((w / 2, 352 * scale), FOOTER, font=f, fill=MUTED, anchor="mm")
    return img


if __name__ == "__main__":
    draw(1).save(os.path.join(OUT, "background.png"), optimize=True)
    draw(2).save(os.path.join(OUT, "background@2x.png"), optimize=True)
    print("wrote", OUT)
