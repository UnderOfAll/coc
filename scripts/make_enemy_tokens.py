#!/usr/bin/env python3
"""Draw a top-down token for every authored creature, from its own name and description.

    python3 scripts/make_enemy_tokens.py                 # writes assets/enemies/*.svg
    node scripts/render_map.mjs <in.svg> <out.jpg> …     # rasterises them

DRAWN, NOT PAINTED. The two scenes on either side of the one-shot came out of an image generator and this
machine has none, so these are emblems rather than portraits — which is the right trade for the thing they
actually are: a figure on a board, read at about seventy pixels across, from above, in a hurry, next to
eight others. What a token owes its DM is a silhouette nobody can mistake for the silhouette beside it.

THE TIER IS THE RIM. Wood for a normal, iron for a special, brass for a boss — so a glance at the board
says which of the things in front of you is the one the fight is built around, without opening a card.

Everything is drawn from the creature's own `flavor` line in `data/enemies/`. Ribs like tent poles, a
bandolier that is never empty, a brass megaphone where its face should be: if it is in the description it
is in the picture, and if it is not in the description it is not invented here.
"""
import json
import math
import random
from pathlib import Path

S = 420                      # a token is square and read small; 420 is plenty at any zoom this app allows
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "enemies"

NIGHT = "#0d0b10"
SAW = "#8a6534"
SAW_D = "#3d2a15"
WOOD = "#6b4726"
WOOD_D = "#2a1a0c"
IRON = "#565560"
IRON_D = "#26252b"
BRASS = "#c2933c"
BRASS_D = "#6a4a17"
RED = "#8e2f2b"
RED_D = "#4d1917"
CREAM = "#e3d3ae"
BONE = "#cbb894"
WHITE = "#f2ece0"
INK = "#1a1512"
FLESH = "#c8a678"

# THE TIER IS THE GROUND IT STANDS ON. The first version drew a rim — wood, iron, brass — which was wrong
# for the frame it lands in: the app paints a token as a FILLED SQUARE and then clips it to whichever
# shape the DM picked (square, circle, triangle, diamond), so a disc leaves four empty corners and a ring
# survives none of the three clips that are not a circle. A ground colour survives all four.
GROUND = {"normal": ("#4a3820", "#0f0c09"), "special": ("#33323f", "#0c0c11"), "boss": ("#54211f", "#150a09")}

rnd = random.Random(4242)


def px(u):
    """Everything is authored in a 0-1 box and scaled once, so a shape can be moved without arithmetic."""
    return u * S


def el(cx, cy, rx, ry, fill, rot=0, **kw):
    a = "".join(f' {k.replace("_", "-")}="{v}"' for k, v in kw.items())
    t = f' transform="rotate({rot} {px(cx):.1f} {px(cy):.1f})"' if rot else ""
    return (f'<ellipse cx="{px(cx):.1f}" cy="{px(cy):.1f}" rx="{px(rx):.1f}" ry="{px(ry):.1f}" '
            f'fill="{fill}"{a}{t}/>')


def ci(cx, cy, r, fill, **kw):
    a = "".join(f' {k.replace("_", "-")}="{v}"' for k, v in kw.items())
    return f'<circle cx="{px(cx):.1f}" cy="{px(cy):.1f}" r="{px(r):.1f}" fill="{fill}"{a}/>'


def ln(x1, y1, x2, y2, stroke, w=2, **kw):
    a = "".join(f' {k.replace("_", "-")}="{v}"' for k, v in kw.items())
    return (f'<line x1="{px(x1):.1f}" y1="{px(y1):.1f}" x2="{px(x2):.1f}" y2="{px(y2):.1f}" '
            f'stroke="{stroke}" stroke-width="{w}" stroke-linecap="round"{a}/>')


def path(d, fill="none", **kw):
    a = "".join(f' {k.replace("_", "-")}="{v}"' for k, v in kw.items())
    return f'<path d="{d}" fill="{fill}"{a}/>'


def P(*pts):
    """A path string from (x, y) pairs in the 0-1 box: P((0,0), (1,0)) -> 'M0 0 L420 0'."""
    out = []
    for i, (x, y) in enumerate(pts):
        out.append(("M" if i == 0 else "L") + f"{px(x):.1f} {px(y):.1f}")
    return " ".join(out)


def hand(cx, cy, r, rot=0, fill=BONE, edge="#7d6a4a"):
    """A hand seen from above: a palm and five fingers. The Standing Ovation is nothing else."""
    g = [f'<g transform="rotate({rot} {px(cx):.1f} {px(cy):.1f})">']
    g.append(el(cx, cy, r * 0.62, r * 0.72, fill, stroke=edge, stroke_width=str(max(1, r * S * 0.10))))
    for i, a in enumerate((-52, -22, 6, 34)):
        rad = math.radians(a - 90)
        fx, fy = cx + math.cos(rad) * r * 0.95, cy + math.sin(rad) * r * 0.95
        g.append(el(fx, fy, r * 0.19, r * 0.42, fill, rot=a, stroke=edge,
                    stroke_width=str(max(1, r * S * 0.08))))
    g.append(el(cx - r * 0.72, cy + r * 0.34, r * 0.20, r * 0.34, fill, rot=-58, stroke=edge,
                stroke_width=str(max(1, r * S * 0.08))))
    g.append("</g>")
    return "".join(g)


def head(cx, cy, r, skin=FLESH, hair=None, edge="#3a2a1a"):
    """A head from directly above: the crown, and the shoulders are somebody else's job."""
    out = ""
    if hair:
        out += ci(cx, cy, r * 1.12, hair)
    out += ci(cx, cy, r, skin, stroke=edge, stroke_width="3")
    return out


def shoulders(cx, cy, rx, ry, fill, edge="#241a10", rot=0):
    return el(cx, cy, rx, ry, fill, rot=rot, stroke=edge, stroke_width="4")


# ---------------------------------------------------------------- the nine

def sawdust_hound():
    """'A ring dog gone feral, coat matted grey with sawdust, ribs like tent poles under the fur.'"""
    g = []
    body = "#6d6152"
    # the four legs first, so the body sits over them
    for x, y, a in ((0.36, 0.40, -24), (0.64, 0.40, 24), (0.36, 0.68, -18), (0.64, 0.68, 18)):
        g.append(el(x, y, 0.045, 0.10, "#4c4238", rot=a))
        g.append(ci(x - 0.01 if x < 0.5 else x + 0.01, y + 0.09, 0.032, "#3a322a"))
    g.append(el(0.5, 0.55, 0.15, 0.235, body, stroke="#3d352c", stroke_width="4"))   # ribcage / barrel
    # ribs like tent poles
    for i in range(5):
        yy = 0.40 + i * 0.055
        g.append(path(f'M{px(0.375)} {px(yy)} Q{px(0.5)} {px(yy + 0.035)}, {px(0.625)} {px(yy)}',
                      stroke="#453b31", stroke_width="6", opacity="0.85"))
    # matted sawdust in the coat
    for _ in range(26):
        a, d = rnd.uniform(0, math.tau), rnd.uniform(0, 0.20)
        g.append(ci(0.5 + math.cos(a) * d * 0.72, 0.55 + math.sin(a) * d, rnd.uniform(0.004, 0.011),
                    rnd.choice(("#a3906d", "#c2ab7f", "#514537")), opacity=f"{rnd.uniform(0.4, 0.9):.2f}"))
    g.append(el(0.5, 0.80, 0.035, 0.09, "#5a5046", rot=6))                            # haunches
    g.append(path(f'M{px(0.5)} {px(0.87)} Q{px(0.60)} {px(0.93)}, {px(0.545)} {px(0.98)}',
                  stroke="#5a5046", stroke_width="11", stroke_linecap="round"))       # tail
    g.append(el(0.5, 0.295, 0.10, 0.115, "#77694f", stroke="#3d352c", stroke_width="4"))   # skull
    for sx in (-1, 1):
        g.append(path(P((0.5 + sx * 0.075, 0.235), (0.5 + sx * 0.145, 0.16), (0.5 + sx * 0.115, 0.265)),
                      "#5e5340", stroke="#332c22", stroke_width="3"))                 # ears
    g.append(el(0.5, 0.195, 0.048, 0.062, "#8a7a5c", stroke="#3d352c", stroke_width="3"))  # muzzle
    g.append(ci(0.5, 0.155, 0.019, INK))
    for sx in (-1, 1):
        g.append(ci(0.5 + sx * 0.045, 0.285, 0.016, "#e8d27a"))
        g.append(ci(0.5 + sx * 0.045, 0.285, 0.007, INK))
    return "".join(g)


def rigging_crawler():
    """'A thing of knotted rope and pulley-wheels that lives in the roof of the tent, head first.'"""
    g = []
    rope, rope_d = "#9a8058", "#5c4a30"
    for i in range(7):
        a = math.radians(-90 + (i - 3) * 40)
        # every leg is a rope: it bends where a rope bends, not where a joint would
        x1, y1 = 0.5 + math.cos(a) * 0.16, 0.46 + math.sin(a) * 0.16
        x2, y2 = 0.5 + math.cos(a) * 0.34, 0.46 + math.sin(a) * 0.30
        x3, y3 = 0.5 + math.cos(a) * 0.30, 0.46 + math.sin(a) * 0.46
        g.append(path(f'M{px(x1)} {px(y1)} Q{px(x2)} {px(y2)}, {px(x3)} {px(y3)}',
                      stroke=rope_d, stroke_width="16", stroke_linecap="round"))
        g.append(path(f'M{px(x1)} {px(y1)} Q{px(x2)} {px(y2)}, {px(x3)} {px(y3)}',
                      stroke=rope, stroke_width="9", stroke_linecap="round"))
        g.append(ci(x3, y3, 0.022, rope_d))
    g.append(ci(0.5, 0.47, 0.175, "#54432c", stroke="#2c2116", stroke_width="4"))     # the knot
    for i in range(5):                                                                # its windings
        g.append(path(f'M{px(0.34)} {px(0.40 + i * 0.035)} Q{px(0.5)} {px(0.44 + i * 0.035)}, '
                      f'{px(0.66)} {px(0.40 + i * 0.035)}', stroke=rope, stroke_width="10", opacity="0.85"))
    for cx, cy, r in ((0.315, 0.30, 0.085), (0.70, 0.345, 0.065)):                    # pulley wheels
        g.append(ci(cx, cy, r, "#3a3841", stroke=IRON, stroke_width="6"))
        g.append(ci(cx, cy, r * 0.30, IRON))
        for k in range(6):
            a = math.tau * k / 6
            g.append(ln(cx + math.cos(a) * r * 0.32, cy + math.sin(a) * r * 0.32,
                        cx + math.cos(a) * r * 0.82, cy + math.sin(a) * r * 0.82, "#6d6b78", 4))
    g.append(path(f'M{px(0.5)} {px(0.30)} Q{px(0.47)} {px(0.20)}, {px(0.52)} {px(0.12)}',
                  stroke=rope_d, stroke_width="13", stroke_linecap="round"))          # it hangs by this
    g.append(path(f'M{px(0.52)} {px(0.12)} q{px(0.05)} {px(-0.03)}, {px(0.02)} {px(-0.06)}',
                  stroke=IRON, stroke_width="9", stroke_linecap="round"))             # the hook
    return "".join(g)


def ticketing_usher():
    """'A thin figure in a moth-eaten uniform, still checking stubs for a show that ended long ago.'"""
    g = []
    coat = "#5e2b30"
    g.append(shoulders(0.5, 0.62, 0.24, 0.20, coat))
    for _ in range(22):                                                               # moth holes
        a, d = rnd.uniform(0, math.tau), rnd.uniform(0, 1)
        g.append(ci(0.5 + math.cos(a) * d * 0.21, 0.62 + math.sin(a) * d * 0.17,
                    rnd.uniform(0.006, 0.017), "#2a1416", opacity=f"{rnd.uniform(0.5, 0.95):.2f}"))
    g.append(ln(0.5, 0.47, 0.5, 0.80, "#3d1c20", 5))                                  # the coat's seam
    for i in range(3):
        g.append(ci(0.5, 0.55 + i * 0.09, 0.017, BRASS, stroke=BRASS_D, stroke_width="2"))
    for sx in (-1, 1):                                                                # thin arms
        g.append(el(0.5 + sx * 0.245, 0.66, 0.05, 0.115, coat, rot=sx * 22, stroke="#3d1c20", stroke_width="3"))
    g.append(head(0.5, 0.40, 0.105, skin="#ab8a63"))
    g.append(ci(0.5, 0.395, 0.135, "#4a2226", stroke="#2a1416", stroke_width="4"))     # the cap
    g.append(path(f'M{px(0.375)} {px(0.375)} Q{px(0.5)} {px(0.255)}, {px(0.625)} {px(0.375)} Z',
                  "#3a1a1e", stroke="#201013", stroke_width="3"))                      # its peak
    g.append(ci(0.5, 0.345, 0.026, BRASS, stroke=BRASS_D, stroke_width="2"))           # the badge
    # the stubs, still being checked
    for i, a in enumerate((-16, -2, 12)):
        g.append(el(0.745, 0.72 + i * 0.012, 0.038, 0.055, "#ded0ac", rot=a, stroke="#8d7f5f", stroke_width="2"))
        g.append(ln(0.745, 0.70 + i * 0.012, 0.745, 0.745 + i * 0.012, "#8d7f5f", 2))
    return "".join(g)


def cinder_juggler():
    """'Six clubs in the air and every one alight; the fire has forgotten how to land.'"""
    g = []
    g.append(ci(0.5, 0.5, 0.40, "url(#emberglow)"))
    g.append(shoulders(0.5, 0.60, 0.185, 0.155, "#4a3a2c"))
    g.append(head(0.5, 0.46, 0.095, skin="#b08c62", hair="#33261c"))
    for k in range(6):                                                                 # six, in the air
        a = math.tau * k / 6 - math.pi / 2 + 0.22
        cx, cy = 0.5 + math.cos(a) * 0.325, 0.5 + math.sin(a) * 0.325
        deg = math.degrees(a) + 90
        g.append(f'<g transform="rotate({deg:.0f} {px(cx):.1f} {px(cy):.1f})">')
        g.append(path(P((cx - 0.017, cy + 0.085), (cx - 0.030, cy - 0.030), (cx, cy - 0.075),
                        (cx + 0.030, cy - 0.030), (cx + 0.017, cy + 0.085)),
                      "#7a5a35", stroke="#3a2a18", stroke_width="3"))                  # the club
        g.append(ci(cx, cy - 0.088, 0.055, "url(#flamecore)"))
        g.append(path(P((cx - 0.024, cy - 0.078), (cx, cy - 0.150), (cx + 0.024, cy - 0.078)),
                      "#ffbe4b"))                                                      # its flame
        g.append(path(P((cx - 0.012, cy - 0.082), (cx, cy - 0.118), (cx + 0.012, cy - 0.082)), "#fff1c0"))
        g.append("</g>")
    for _ in range(30):                                                                # sparks
        a, d = rnd.uniform(0, math.tau), rnd.uniform(0.18, 0.44)
        g.append(ci(0.5 + math.cos(a) * d, 0.5 + math.sin(a) * d, rnd.uniform(0.004, 0.010),
                    rnd.choice(("#ffcf6a", "#ff9a3c", "#f7e6b0")), opacity=f"{rnd.uniform(0.4, 1):.2f}"))
    return "".join(g)


def greasepaint_mime():
    """'White face, black tears, both palms pressed flat against nothing at all — and the nothing holds.'"""
    g = []
    # the nothing it is pressed against, which holds
    g.append(f'<rect x="{px(0.175):.0f}" y="{px(0.20):.0f}" width="{px(0.65):.0f}" height="{px(0.30):.0f}" '
             f'fill="#9fb4c6" opacity="0.10" stroke="#b9cddd" stroke-width="3" stroke-dasharray="10 9"/>')
    g.append(shoulders(0.5, 0.66, 0.205, 0.165, "#26242a"))
    for i in range(5):                                                                 # the striped shirt
        g.append(f'<rect x="{px(0.30):.0f}" y="{px(0.565 + i * 0.040):.0f}" width="{px(0.40):.0f}" '
                 f'height="{px(0.020):.0f}" fill="#e8e4db" opacity="0.85"/>')
    for sx in (-1, 1):                                                                 # arms, out to the flat
        g.append(path(f'M{px(0.5 + sx * 0.14)} {px(0.60)} Q{px(0.5 + sx * 0.30)} {px(0.50)}, '
                      f'{px(0.5 + sx * 0.30)} {px(0.36)}', stroke="#26242a", stroke_width="26",
                      stroke_linecap="round"))
        g.append(hand(0.5 + sx * 0.30, 0.295, 0.085, rot=0 if sx > 0 else 0, fill="#efeae0", edge="#9a948a"))
    g.append(ci(0.5, 0.455, 0.125, WHITE, stroke="#a49c8e", stroke_width="3"))          # the white face
    for sx in (-1, 1):
        g.append(ci(0.5 + sx * 0.048, 0.425, 0.020, INK))
        g.append(path(f'M{px(0.5 + sx * 0.048)} {px(0.447)} q{px(sx * 0.006)} {px(0.045)}, '
                      f'{px(sx * -0.004)} {px(0.075)}', stroke=INK, stroke_width="7",
                      stroke_linecap="round"))                                          # black tears
    g.append(path(f'M{px(0.462)} {px(0.520)} Q{px(0.5)} {px(0.500)}, {px(0.538)} {px(0.520)}',
                  stroke=INK, stroke_width="5"))
    return "".join(g)


def the_blindfold():
    """'A knife-thrower with a black band over her eyes and a bandolier that is never empty.'"""
    g = []
    g.append(shoulders(0.5, 0.63, 0.215, 0.175, "#3a2f3a"))
    for sx in (-1, 1):                                                                  # the bandolier
        g.append(path(f'M{px(0.5 + sx * 0.20)} {px(0.52)} L{px(0.5 - sx * 0.17)} {px(0.76)}',
                      stroke="#5a4326", stroke_width="20", stroke_linecap="round"))
        for i in range(4):
            t = 0.18 + i * 0.22
            kx = (0.5 + sx * 0.20) + ((0.5 - sx * 0.17) - (0.5 + sx * 0.20)) * t
            ky = 0.52 + (0.76 - 0.52) * t
            g.append(el(kx, ky, 0.011, 0.030, "#cfd4dc", rot=sx * 45, stroke="#6d727c", stroke_width="2"))
    for sx in (-1, 1):                                                                  # hands, already moving
        g.append(path(f'M{px(0.5 + sx * 0.15)} {px(0.60)} Q{px(0.5 + sx * 0.31)} {px(0.56)}, '
                      f'{px(0.5 + sx * 0.34)} {px(0.44)}', stroke="#3a2f3a", stroke_width="24",
                      stroke_linecap="round"))
        g.append(ci(0.5 + sx * 0.345, 0.415, 0.05, "#c09a70", stroke="#6d5232", stroke_width="3"))
        g.append(path(P((0.5 + sx * 0.345, 0.375), (0.5 + sx * 0.325, 0.255), (0.5 + sx * 0.365, 0.255)),
                      "#dfe4ec", stroke="#767c88", stroke_width="2"))                   # the knife in it
    g.append(head(0.5, 0.42, 0.115, skin="#c09a70", hair="#1d1a20"))
    g.append(f'<rect x="{px(0.375):.0f}" y="{px(0.395):.0f}" width="{px(0.25):.0f}" height="{px(0.062):.0f}" '
             f'rx="6" fill="#141217" stroke="#000" stroke-width="2"/>')                 # the band
    g.append(path(f'M{px(0.455)} {px(0.500)} Q{px(0.5)} {px(0.487)}, {px(0.545)} {px(0.500)}',
                  stroke="#6d5232", stroke_width="4"))
    # two more knives, in flight, because she has not missed in eleven years
    for x, y, a in ((0.20, 0.20, -34), (0.80, 0.185, 30)):
        g.append(path(P((x, y + 0.045), (x - 0.016, y - 0.055), (x + 0.016, y - 0.055)), "#dfe4ec",
                      rot=a, stroke="#767c88", stroke_width="2"))
    return "".join(g)


def the_ringmasters_voice():
    """'A tall coated figure with a brass megaphone where its face should be.'"""
    g = []
    g.append(f'<path d="{P((0.5, 0.44), (0.10, 0.06), (0.90, 0.06))}" fill="url(#shout)" opacity="0.55"/>')
    g.append(shoulders(0.5, 0.66, 0.235, 0.185, "#2b2430"))                              # the coat
    for sx in (-1, 1):                                                                   # epaulettes
        g.append(el(0.5 + sx * 0.205, 0.615, 0.055, 0.045, "#4a3b22", stroke=BRASS_D, stroke_width="3"))
        for i in range(4):
            g.append(ln(0.5 + sx * 0.185 + i * 0.012 * sx, 0.648,
                        0.5 + sx * 0.185 + i * 0.012 * sx, 0.700, BRASS, 3, opacity="0.9"))
    g.append(ln(0.5, 0.52, 0.5, 0.84, "#171320", 5))
    for i in range(3):
        g.append(ci(0.5, 0.60 + i * 0.085, 0.017, BRASS, stroke=BRASS_D, stroke_width="2"))
    g.append(ci(0.5, 0.455, 0.125, "#1e1a24", stroke="#0d0b12", stroke_width="4"))       # where a head goes
    # the megaphone, where its face should be
    g.append(path(P((0.418, 0.455), (0.315, 0.235), (0.685, 0.235), (0.582, 0.455)),
                  "url(#brassgrad)", stroke=BRASS_D, stroke_width="5"))
    g.append(el(0.5, 0.235, 0.185, 0.058, "#e6bd64", stroke=BRASS_D, stroke_width="5"))  # its bell
    g.append(el(0.5, 0.235, 0.150, 0.040, "#3a2a12"))
    g.append(el(0.5, 0.243, 0.108, 0.026, "#0f0a06"))
    g.append(el(0.5, 0.455, 0.085, 0.030, "#a97e2c", stroke=BRASS_D, stroke_width="4"))
    return "".join(g)


def the_standing_ovation():
    """'The applause outlived the audience. It is a churning mass of hands.'"""
    g = []
    g.append(ci(0.5, 0.5, 0.40, "#2a2118", opacity="0.55"))
    spots = []
    for ring, (n, rad, size) in enumerate(((9, 0.335, 0.088), (7, 0.215, 0.100), (4, 0.085, 0.108))):
        for k in range(n):
            a = math.tau * k / n + ring * 0.5
            spots.append((0.5 + math.cos(a) * rad, 0.5 + math.sin(a) * rad,
                          size * rnd.uniform(0.82, 1.18), math.degrees(a) + 90 + rnd.uniform(-40, 40)))
    # Back to front, so the mass reads as deep rather than as a pattern.
    spots.sort(key=lambda s: s[1])
    for x, y, r, rot in spots:
        shade = rnd.choice(("#b9a077", "#cdb68d", "#a08a64", "#dcc79c"))
        g.append(hand(x, y, r, rot=rot, fill=shade, edge="#5d4c33"))
    for _ in range(24):                                                                  # the noise of it
        a, d = rnd.uniform(0, math.tau), rnd.uniform(0.30, 0.46)
        g.append(ci(0.5 + math.cos(a) * d, 0.5 + math.sin(a) * d, rnd.uniform(0.004, 0.009),
                    "#efe3c8", opacity=f"{rnd.uniform(0.2, 0.6):.2f}"))
    return "".join(g)


def grinsel():
    """'The only one of the company who never took the paint off, doing the same routine to an empty tent.'"""
    g = []
    g.append(ci(0.5, 0.5, 0.42, "url(#spot)"))
    g.append(shoulders(0.5, 0.70, 0.215, 0.165, "#4a1d2a"))
    for sx in (-1, 1):
        g.append(path(f'M{px(0.5 + sx * 0.15)} {px(0.68)} Q{px(0.5 + sx * 0.32)} {px(0.62)}, '
                      f'{px(0.5 + sx * 0.34)} {px(0.50)}', stroke="#4a1d2a", stroke_width="24",
                      stroke_linecap="round"))
        g.append(ci(0.5 + sx * 0.345, 0.475, 0.05, "#efeae0", stroke="#9a948a", stroke_width="3"))
    # the razor cards, fanned out of one hand
    for i, a in enumerate((-40, -20, 0, 20)):
        g.append(f'<g transform="rotate({a} {px(0.845):.1f} {px(0.475):.1f})">'
                 f'<rect x="{px(0.815):.0f}" y="{px(0.335):.0f}" width="{px(0.062):.0f}" '
                 f'height="{px(0.090):.0f}" rx="4" fill="#ece3cd" stroke="#8f8878" stroke-width="2"/></g>')
    g.append(ci(0.5, 0.615, 0.185, "#efeae0", stroke="#b9b2a4", stroke_width="3"))       # the ruff
    g.append(ci(0.5, 0.615, 0.135, "#d8d0c0"))
    for k in range(18):
        a = math.tau * k / 18
        g.append(ln(0.5 + math.cos(a) * 0.135, 0.615 + math.sin(a) * 0.135,
                    0.5 + math.cos(a) * 0.185, 0.615 + math.sin(a) * 0.185, "#c2b9a8", 4))
    for sx in (-1, 1):                                                                   # the hair he kept
        for i in range(4):
            g.append(ci(0.5 + sx * (0.145 + i * 0.028), 0.395 + i * 0.030, 0.040 - i * 0.004, "#a8321f"))
        g.append(ci(0.5 + sx * 0.175, 0.365, 0.034, "#c33f26"))
    g.append(ci(0.5, 0.415, 0.155, WHITE, stroke="#a49c8e", stroke_width="3"))            # the paint
    for sx in (-1, 1):                                                                    # the eyes
        g.append(path(P((0.5 + sx * 0.030, 0.320), (0.5 + sx * 0.115, 0.355), (0.5 + sx * 0.052, 0.412)),
                      "#8e2f2b"))
        g.append(ci(0.5 + sx * 0.058, 0.378, 0.024, WHITE, stroke=INK, stroke_width="3"))
        g.append(ci(0.5 + sx * 0.058, 0.378, 0.011, INK))
    g.append(ci(0.5, 0.442, 0.030, "#c0392b", stroke="#7d2018", stroke_width="2"))         # the nose
    g.append(path(f'M{px(0.395)} {px(0.470)} Q{px(0.5)} {px(0.565)}, {px(0.605)} {px(0.470)}',
                  "none", stroke="#8e2f2b", stroke_width="14", stroke_linecap="round"))    # the grin
    g.append(path(f'M{px(0.418)} {px(0.482)} Q{px(0.5)} {px(0.540)}, {px(0.582)} {px(0.482)}',
                  "#2a1010"))
    for i in range(5):                                                                     # the teeth
        g.append(f'<rect x="{px(0.432 + i * 0.028):.0f}" y="{px(0.492):.0f}" width="{px(0.020):.0f}" '
                 f'height="{px(0.026):.0f}" fill="#f2ece0"/>')
    return "".join(g)


ART = {
    "sawdust-hound": sawdust_hound, "rigging-crawler": rigging_crawler,
    "ticketing-usher": ticketing_usher, "cinder-juggler": cinder_juggler,
    "greasepaint-mime": greasepaint_mime, "the-blindfold": the_blindfold,
    "the-ringmasters-voice": the_ringmasters_voice, "the-standing-ovation": the_standing_ovation,
    "grinsel-the-last-clown": grinsel,
}


def token(enemy):
    inner, outer = GROUND.get(enemy.get("tier", "normal"), GROUND["normal"])
    art = ART[enemy["id"]]()
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{S}" height="{S}" viewBox="0 0 {S} {S}">
<defs>
  <radialGradient id="ground" cx="0.5" cy="0.42" r="0.72">
    <stop offset="0" stop-color="{inner}"/><stop offset="1" stop-color="{outer}"/>
  </radialGradient>
  <radialGradient id="spot" cx="0.5" cy="0.42" r="0.55">
    <stop offset="0" stop-color="#ffd68a" stop-opacity="0.22"/>
    <stop offset="1" stop-color="#ffd68a" stop-opacity="0"/>
  </radialGradient>
  <radialGradient id="emberglow" cx="0.5" cy="0.5" r="0.5">
    <stop offset="0" stop-color="#ff9a3c" stop-opacity="0.30"/>
    <stop offset="1" stop-color="#ff9a3c" stop-opacity="0"/>
  </radialGradient>
  <radialGradient id="flamecore" cx="0.5" cy="0.5" r="0.5">
    <stop offset="0" stop-color="#fff2c8"/><stop offset="0.55" stop-color="#ff9e33" stop-opacity="0.75"/>
    <stop offset="1" stop-color="#ff6a1e" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="brassgrad" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="#8a6420"/><stop offset="0.45" stop-color="#e6bd64"/>
    <stop offset="1" stop-color="#8a6420"/>
  </linearGradient>
  <linearGradient id="shout" x1="0" y1="1" x2="0" y2="0">
    <stop offset="0" stop-color="#e6bd64" stop-opacity="0.35"/>
    <stop offset="1" stop-color="#e6bd64" stop-opacity="0"/>
  </linearGradient>
  <radialGradient id="edgedark" cx="0.5" cy="0.5" r="0.72">
    <stop offset="0.55" stop-color="#000" stop-opacity="0"/>
    <stop offset="1" stop-color="#000" stop-opacity="0.55"/>
  </radialGradient>
  <filter id="grain" x="-5%" y="-5%" width="110%" height="110%">
    <feTurbulence type="fractalNoise" baseFrequency="0.055" numOctaves="4" seed="11" result="n"/>
    <feColorMatrix in="n" type="saturate" values="0"/>
    <feComponentTransfer><feFuncA type="linear" slope="0.30"/></feComponentTransfer>
    <feComposite in2="SourceGraphic" operator="in"/>
  </filter>
  <filter id="lift" x="-25%" y="-25%" width="150%" height="150%">
    <feDropShadow dx="0" dy="5" stdDeviation="7" flood-color="#000" flood-opacity="0.6"/>
  </filter>
</defs>
<rect width="{S}" height="{S}" fill="url(#ground)"/>
<rect width="{S}" height="{S}" fill="#c9a15e" filter="url(#grain)" opacity="0.28"/>
<g filter="url(#lift)">{art}</g>
<rect width="{S}" height="{S}" fill="url(#edgedark)"/>
</svg>'''


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    src = ROOT / "data" / "enemies"
    made = 0
    for f in sorted(src.glob("*.json")):
        e = json.loads(f.read_text(encoding="utf-8"))
        if e["id"] not in ART:
            print(f"  no art written for {e['id']} — skipped")
            continue
        (OUT / (e["id"] + ".svg")).write_text(token(e), encoding="utf-8")
        made += 1
    print(f"wrote {made} token(s) to {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
