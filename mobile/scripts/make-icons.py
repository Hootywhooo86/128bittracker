"""Draws the 128bit Tracker pixel icon + splash into the Android res folder.

Re-run after changing the art:  python3 mobile/scripts/make-icons.py
"""
from pathlib import Path
from PIL import Image

RES = Path(__file__).resolve().parent.parent / "android/app/src/main/res"
NAVY, ORANGE, ORANGE_D, TEAL, PINK = (11, 11, 22, 255), (255, 159, 28, 255), (160, 94, 0, 255), (45, 212, 191, 255), (255, 93, 143, 255)

# 16x16 pixel art: rising bars (teal, orange, pink) on navy with a streak flame dot.
ART = [
    "................",
    "................",
    "............PP..",
    "............PP..",
    "............PP..",
    "........OO..PP..",
    "........OO..PP..",
    "........OO..PP..",
    "....TT..OO..PP..",
    "....TT..OO..PP..",
    "....TT..OO..PP..",
    "....TT..OO..PP..",
    "................",
    "...WWWWWWWWWWW..",
    "................",
    "................",
]
COLORS = {"T": TEAL, "O": ORANGE, "P": PINK, "W": (244, 241, 255, 255)}


def art(scale, bg=None):
    img = Image.new("RGBA", (16, 16), bg or (0, 0, 0, 0))
    for y, row in enumerate(ART):
        for x, ch in enumerate(row):
            if ch in COLORS:
                img.putpixel((x, y), COLORS[ch])
    return img.resize((16 * scale, 16 * scale), Image.NEAREST)


def legacy(size, round_=False):
    # Orange pixel frame around a navy tile, like the logo mark on the site.
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    unit = size // 24
    tile = Image.new("RGBA", (size - 2 * unit, size - 2 * unit), NAVY)
    frame = Image.new("RGBA", (size, size), ORANGE)
    if round_:
        mask = Image.new("L", (size, size), 0)
        from PIL import ImageDraw
        ImageDraw.Draw(mask).ellipse((0, 0, size - 1, size - 1), fill=255)
        img.paste(frame, (0, 0), mask)
        inner = Image.new("L", tile.size, 0)
        ImageDraw.Draw(inner).ellipse((0, 0, tile.size[0] - 1, tile.size[1] - 1), fill=255)
        img.paste(tile, (unit, unit), inner)
    else:
        img.paste(frame, (0, 0))
        img.paste(tile, (unit, unit))
    a = art(max(1, int(size * 0.6) // 16))
    img.alpha_composite(a, ((size - a.size[0]) // 2, (size - a.size[1]) // 2))
    return img


DENS = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}
for d, m in DENS.items():
    legacy(int(48 * m)).save(RES / f"mipmap-{d}/ic_launcher.png")
    legacy(int(48 * m), round_=True).save(RES / f"mipmap-{d}/ic_launcher_round.png")
    # Adaptive foreground: 108dp canvas, art inside the 66dp safe zone.
    fg_size = int(108 * m)
    fg = Image.new("RGBA", (fg_size, fg_size), (0, 0, 0, 0))
    a = art(max(1, int(fg_size * 0.5) // 16))
    fg.alpha_composite(a, ((fg_size - a.size[0]) // 2, (fg_size - a.size[1]) // 2))
    fg.save(RES / f"mipmap-{d}/ic_launcher_foreground.png")


def splash(w, h):
    img = Image.new("RGBA", (w, h), NAVY)
    a = art(max(2, min(w, h) // 3 // 16))
    img.alpha_composite(a, ((w - a.size[0]) // 2, (h - a.size[1]) // 2))
    return img.convert("RGB")


for p in RES.glob("drawable*/splash.png"):
    w, h = Image.open(p).size
    splash(w, h).save(p)

# Notification icon: Android wants a white silhouette on transparent (24dp).
def silhouette(size):
    img = Image.new("RGBA", (16, 16), (0, 0, 0, 0))
    for y, row in enumerate(ART):
        for x, ch in enumerate(row):
            if ch in COLORS:
                img.putpixel((x, y), (255, 255, 255, 255))
    return img.resize((size, size), Image.NEAREST)


for d, m in DENS.items():
    out = RES / f"drawable-{d}"
    out.mkdir(exist_ok=True)
    silhouette(int(24 * m)).save(out / "ic_stat_tracker.png")

(RES / "values/ic_launcher_background.xml").write_text(
    '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#0B0B16</color>\n</resources>\n'
)
print("icons + splash written to", RES)
