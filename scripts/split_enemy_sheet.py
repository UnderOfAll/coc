#!/usr/bin/env python3
"""Cut a 3x3 contact sheet of generated creature art into nine tokens.

    python3 scripts/split_enemy_sheet.py prints/<sheet>.png

WHY THIS EXISTS RATHER THAN NINE SEPARATE FILES. Kayki generates the creature art in an image generator
of his own — this machine has none, and the WSL box is capped at 4 GB by his own `.wslconfig`, which is
under half of what Stable Diffusion needs on a CPU. What comes back is one sheet, so this cuts it.

THE ORDER IS THE CONTRACT. Left to right, top to bottom, matching the order the prompts were written in.
Change the prompts and this list changes with them, or every creature quietly gets somebody else's face.

A TOKEN IS SQUARE. The app paints a figure as a filled square and then clips it to whichever shape the DM
picked, so a landscape cell is cropped to a square rather than letterboxed. The middle is right for most
of them; `BIAS` slides that window where the subject is not centred, judged by eye.
"""
import sys
from pathlib import Path
from PIL import Image, ImageStat

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "enemies"
SIDE = 512

ORDER = ["sawdust-hound", "rigging-crawler", "ticketing-usher",
         "cinder-juggler", "greasepaint-mime", "the-blindfold",
         "the-ringmasters-voice", "the-standing-ovation", "grinsel-the-last-clown"]
# -1 is hard left, +1 hard right. The hound's head and the usher's face sit right of centre; Grinsel's
# fan of cards is the thing a square crop loses first.
BIAS = {"sawdust-hound": 0.15, "ticketing-usher": 0.10, "grinsel-the-last-clown": 0.15}


def gutters(gray, along_rows):
    """The pale seams between cells, found rather than assumed — a sheet from a different generator will
    not have them in the same places, and guessing at thirds leaves a sliver of the neighbour behind."""
    w, h = gray.size
    n = h if along_rows else w
    hits = []
    for i in range(n):
        strip = gray.crop((0, i, w, i + 1)) if along_rows else gray.crop((i, 0, i + 1, h))
        st = ImageStat.Stat(strip)
        if st.mean[0] > 140 and st.stddev[0] < 45:
            hits.append(i)
    runs = []
    for v in hits:
        if runs and v == runs[-1][-1] + 1:
            runs[-1].append(v)
        else:
            runs.append([v])
    return [(r[0], r[-1]) for r in runs]


def bands(seams, size, pad=2):
    """Cell bounds from the seams: everything either side of them, inset so no sliver comes across."""
    inner = [s for s in seams if s[0] > 4 and s[1] < size - 5]
    edges = [0] + [x for s in inner for x in s] + [size]
    out = []
    for i in range(0, len(edges) - 1, 2):
        a, b = edges[i], edges[i + 1]
        if b - a > size / 6:
            out.append((a + pad, b - pad))
    return out


def main():
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else None
    if not src or not src.exists():
        print("usage: python3 scripts/split_enemy_sheet.py prints/<sheet>.png")
        return 1
    im = Image.open(src).convert("RGB")
    gray = im.convert("L")
    rows = bands(gutters(gray, True), im.height)
    cols = bands(gutters(gray, False), im.width)
    if len(rows) != 3 or len(cols) != 3:
        print(f"expected a 3x3 sheet; found {len(rows)} row(s) and {len(cols)} column(s) — "
              f"rows={rows} cols={cols}")
        return 1
    OUT.mkdir(parents=True, exist_ok=True)
    for i, name in enumerate(ORDER):
        r, c = divmod(i, 3)
        cell = im.crop((cols[c][0], rows[r][0], cols[c][1], rows[r][1]))
        w, h = cell.size
        side = min(w, h)
        slack = w - side
        x0 = max(0, min(slack, round(slack * (0.5 + BIAS.get(name, 0.0) * 0.5))))
        y0 = max(0, (h - side) // 2)
        sq = cell.crop((x0, y0, x0 + side, y0 + side)).resize((SIDE, SIDE), Image.LANCZOS)
        dest = OUT / f"{name}.jpg"
        sq.save(dest, quality=90, optimize=True)
        print(f"  {name:24s} {side}x{side} -> {SIDE}  {dest.stat().st_size // 1024} KB")
    print(f"nine tokens written to {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
