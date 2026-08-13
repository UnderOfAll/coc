#!/usr/bin/env python3
"""Draw the middle scene of the one-shot — THE MIDWAY — as a top-down battlemap.

    python3 scripts/make_midway_map.py            # writes maps/midway.svg

Then `node scripts/render_map.mjs maps/midway.svg maps/midway.png` turns it into the picture a scene
takes. It is drawn rather than painted because the two scenes either side of it came out of an image
generator and this machine has none: what it can do honestly is a real 26x18 grid where every square is
where it says it is, which for the three fights this room holds matters more than brushwork.

THE ROOM IS THE FIGHT. Its three creatures each want a different shape of space, so the map gives each
one its own:
  · a long straight AISLE down the middle, because the Standing Ovation comes down an aisle at speed 20
    and is only frightening in a place you cannot simply walk around it;
  · two rows of STALLS with real gaps between them, because reaching the Blindfold is the whole fight and
    cover from something that hears you is a solid object, not a shadow;
  · a raised BARKER'S PLATFORM in the middle with sight down the whole length, for the Ringmaster's Voice,
    which wants thirty feet and a cone.
Everything else on it is a thing a player can pick up, hide behind, set on fire or drag next door.
"""
import math
import random
from pathlib import Path

CELL = 70
COLS, ROWS = 26, 18
W, H = COLS * CELL, ROWS * CELL
ROOT = Path(__file__).resolve().parent.parent

# Sampled off the two scenes that already exist, so the three sit together: deep warm browns, ochre
# sawdust, circus red and cream, and a near-black beyond the canvas.
NIGHT = "#0a0910"
CANVAS_D = "#1d1721"
SAW = "#9c7440"
SAW_D = "#54381c"
SAW_L = "#b98d4b"
RED = "#7d2724"
RED_D = "#5d1e1c"
CREAM = "#cbb083"
WOOD = "#5b3c21"
WOOD_D = "#2a1a0c"
WOOD_L = "#7d5730"
BRASS = "#c2933c"
LAMP = "#ffd68a"
IRON = "#3b3a3f"
GLASS = "#8fa9b8"

rnd = random.Random(1830)
out = []


def add(s):
    out.append(s)


def px(c):
    return c * CELL


def rect(x, y, w, h, fill, **kw):
    """x/y/w/h in SQUARES, so nothing on this map can drift off the grid."""
    attrs = "".join(f' {k.replace("_", "-")}="{v}"' for k, v in kw.items())
    return f'<rect x="{px(x):.1f}" y="{px(y):.1f}" width="{px(w):.1f}" height="{px(h):.1f}" fill="{fill}"{attrs}/>'


def circ(cx, cy, r, fill, **kw):
    attrs = "".join(f' {k.replace("_", "-")}="{v}"' for k, v in kw.items())
    return f'<circle cx="{px(cx):.1f}" cy="{px(cy):.1f}" r="{px(r):.1f}" fill="{fill}"{attrs}/>'


def line(x1, y1, x2, y2, stroke, w=2, **kw):
    attrs = "".join(f' {k.replace("_", "-")}="{v}"' for k, v in kw.items())
    return (f'<line x1="{px(x1):.1f}" y1="{px(y1):.1f}" x2="{px(x2):.1f}" y2="{px(y2):.1f}" '
            f'stroke="{stroke}" stroke-width="{w}" stroke-linecap="round"{attrs}/>')


def text(x, y, s, size=22, fill=CREAM, weight=600, anchor="middle", rot=0, opacity=1.0, spacing=2):
    t = f' transform="rotate({rot} {px(x):.1f} {px(y):.1f})"' if rot else ""
    return (f'<text x="{px(x):.1f}" y="{px(y):.1f}" font-family="Georgia, serif" font-size="{size}" '
            f'font-weight="{weight}" letter-spacing="{spacing}" fill="{fill}" text-anchor="{anchor}" '
            f'opacity="{opacity}"{t}>{s}</text>')


# ---------------------------------------------------------------- defs

add(f'''<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">
<defs>
  <!-- Sawdust grain. Two turbulences at different scales: one for the coarse trodden litter, one fine,
       or a flat fill reads as paper the moment it is zoomed in on at a table. -->
  <filter id="grit" x="-5%" y="-5%" width="110%" height="110%">
    <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="4" seed="7" result="n"/>
    <feColorMatrix in="n" type="saturate" values="0"/>
    <feComponentTransfer><feFuncA type="linear" slope="0.30"/></feComponentTransfer>
    <feComposite in2="SourceGraphic" operator="in"/>
  </filter>
  <filter id="coarse" x="-5%" y="-5%" width="110%" height="110%">
    <feTurbulence type="fractalNoise" baseFrequency="0.06" numOctaves="5" seed="21" result="n"/>
    <feColorMatrix in="n" type="saturate" values="0"/>
    <feComponentTransfer><feFuncA type="linear" slope="0.40"/></feComponentTransfer>
    <feComposite in2="SourceGraphic" operator="in"/>
  </filter>
  <!-- Everything standing on the floor throws the same short shadow, which is what tells a player at a
       glance that a crate is an object and a stain is not. -->
  <filter id="drop" x="-30%" y="-30%" width="180%" height="180%">
    <feDropShadow dx="3" dy="6" stdDeviation="6" flood-color="#000" flood-opacity="0.55"/>
  </filter>
  <filter id="softdrop" x="-30%" y="-30%" width="180%" height="180%">
    <feDropShadow dx="2" dy="3" stdDeviation="3" flood-color="#000" flood-opacity="0.45"/>
  </filter>
  <filter id="blur6"><feGaussianBlur stdDeviation="6"/></filter>
  <filter id="blur18"><feGaussianBlur stdDeviation="18"/></filter>

  <linearGradient id="sawgrad" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="{SAW_D}"/><stop offset="0.45" stop-color="{SAW}"/>
    <stop offset="1" stop-color="{SAW_D}"/>
  </linearGradient>
  <linearGradient id="plank" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="{WOOD_L}"/><stop offset="1" stop-color="{WOOD_D}"/>
  </linearGradient>
  <linearGradient id="roofN" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#3a2a1b"/><stop offset="1" stop-color="#7a5530"/>
  </linearGradient>
  <linearGradient id="roofS" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#7a5530"/><stop offset="1" stop-color="#3a2a1b"/>
  </linearGradient>
  <radialGradient id="lamp">
    <stop offset="0" stop-color="{LAMP}" stop-opacity="0.55"/>
    <stop offset="0.55" stop-color="#e8a24a" stop-opacity="0"/>
  </radialGradient>
  <radialGradient id="pool">
    <stop offset="0" stop-color="{LAMP}" stop-opacity="0.26"/>
    <stop offset="0.5" stop-color="#e0973c" stop-opacity="0.10"/>
    <stop offset="1" stop-color="{LAMP}" stop-opacity="0"/>
  </radialGradient>
  <radialGradient id="vign" cx="0.5" cy="0.5" r="0.88">
    <stop offset="0.50" stop-color="#000" stop-opacity="0"/>
    <stop offset="1" stop-color="#000" stop-opacity="0.70"/>
  </radialGradient>
  <!-- The alley is lit down its spine and black against the cloth, which is the whole reason the stalls
       are worth standing behind. -->
  <linearGradient id="alley" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#000" stop-opacity="0.52"/>
    <stop offset="0.22" stop-color="#000" stop-opacity="0.10"/>
    <stop offset="0.50" stop-color="#000" stop-opacity="0"/>
    <stop offset="0.78" stop-color="#000" stop-opacity="0.10"/>
    <stop offset="1" stop-color="#000" stop-opacity="0.52"/>
  </linearGradient>
  <!-- Canvas: the striped tent wall, drawn as a pattern so both long walls are the same cloth. -->
  <pattern id="stripe" width="84" height="40" patternUnits="userSpaceOnUse">
    <rect width="84" height="40" fill="#b59a70"/>
    <rect width="42" height="40" fill="{RED}"/>
  </pattern>
  <linearGradient id="wallshade" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#000" stop-opacity="0.75"/>
    <stop offset="0.55" stop-color="#000" stop-opacity="0.15"/>
    <stop offset="1" stop-color="#000" stop-opacity="0"/>
  </linearGradient>
</defs>''')

# ---------------------------------------------------------------- the ground

add(rect(0, 0, COLS, ROWS, NIGHT))
# The floor of the alley: sawdust over bare earth, lit down the middle and dark at the walls.
add(rect(0.6, 1.1, COLS - 1.2, ROWS - 2.2, "url(#sawgrad)"))
add(rect(0.6, 1.1, COLS - 1.2, ROWS - 2.2, SAW_L, filter="url(#coarse)", opacity="0.5"))
add(rect(0.6, 1.1, COLS - 1.2, ROWS - 2.2, "#000", filter="url(#grit)", opacity="0.35"))

# Trodden path: eleven years of the same feet walking the same line.
add(f'<path d="M{px(1)} {px(9)} Q {px(7)} {px(8.4)}, {px(13)} {px(9)} T {px(25)} {px(8.8)}" '
    f'stroke="{SAW_D}" stroke-width="{px(3.4)}" fill="none" opacity="0.45" filter="url(#blur18)"/>')
add(f'<path d="M{px(1)} {px(9.2)} Q {px(8)} {px(9.6)}, {px(14)} {px(9.1)} T {px(25)} {px(9.3)}" '
    f'stroke="{SAW_D}" stroke-width="{px(1.6)}" fill="none" opacity="0.30" filter="url(#blur18)"/>')

# ---------------------------------------------------------------- the canvas walls

WALL = 1.35
for top in (True, False):
    y0 = 0.0 if top else ROWS - WALL
    add(rect(0, y0, COLS, WALL, "url(#stripe)", opacity="0.95"))
    add(rect(0, y0, COLS, WALL, "#000", filter="url(#coarse)", opacity="0.45"))
    # Cloth hangs in folds off its rings, so the light runs down it in bands.
    for i in range(COLS * 2 + 1):
        add(line(i / 2, y0, i / 2, y0 + WALL, "#000", 5, opacity="0.20"))
        add(line(i / 2 + 0.16, y0, i / 2 + 0.16, y0 + WALL, "#fff", 2, opacity="0.05"))
    add(f'<g transform="translate(0 {px(y0 if top else y0 + WALL):.1f}) scale(1 {1 if top else -1})">'
        + rect(0, 0, COLS, 0.75, "url(#wallshade)") + "</g>")
    # The lacing rings, every other square.
    for x in range(1, COLS, 2):
        ry = y0 + (WALL - 0.22 if top else 0.22)
        add(circ(x, ry, 0.10, "#1a1410", stroke=BRASS, stroke_width="3", opacity="0.8"))
    # And black beyond the cloth.
    add(rect(0, 0 if top else ROWS - 0.3, COLS, 0.3, NIGHT, opacity="0.9"))

# ---------------------------------------------------------------- stalls

def stall(x, y, w, h, label, side="N", roof="url(#roofN)", counter=True):
    """A sideshow booth: a plank roof, a counter facing the aisle, and a dark interior behind it.

    `side` is which side of the aisle it stands on, which decides where the counter goes — a stall you
    can stand behind is cover, and cover only works if a player can see which face is the open one."""
    g = [f'<g filter="url(#drop)">']
    g.append(rect(x, y, w, h, roof))
    g.append(rect(x, y, w, h, "#000", filter="url(#coarse)", opacity="0.30"))
    # Planking, along the length.
    for i in range(1, int(h * 3)):
        yy = y + i / 3
        if yy < y + h:
            g.append(line(x, yy, x + w, yy, "#000", 1.5, opacity="0.22"))
    g.append(rect(x, y, w, h, "none", stroke=WOOD_D, stroke_width="4"))
    # The open face, towards the aisle.
    if counter:
        cy = y + h - 0.22 if side == "N" else y
        g.append(rect(x + 0.1, cy, w - 0.2, 0.22, CREAM, opacity="0.55"))
        g.append(rect(x + 0.1, cy, w - 0.2, 0.22, "none", stroke=WOOD_D, stroke_width="3"))
    # A striped valance over the front, which is what makes a shed a sideshow.
    vy = y + h - 0.42 if side == "N" else y + 0.2
    for i in range(int(w * 2)):
        g.append(f'<path d="M{px(x + i / 2)} {px(vy)} L{px(x + i / 2 + 0.5)} {px(vy)} '
                 f'L{px(x + i / 2 + 0.25)} {px(vy + 0.2)} Z" fill="{RED if i % 2 else CREAM}" opacity="0.9"/>')
    g.append("</g>")
    if label:
        # Outside the roof, not on it: printed over the valance the name was unreadable, which is the one
        # job a name has.
        ly = y - 0.22 if side == "N" else y + h + 0.55
        g.append(text(x + w / 2, ly, label, size=17, fill="#f0e0bd", opacity=0.8, spacing=3))
    add("".join(g))


def crate(x, y, w=1, h=1, open_top=False, tint=WOOD):
    g = [f'<g filter="url(#softdrop)">', rect(x, y, w, h, tint),
         rect(x, y, w, h, "#000", filter="url(#coarse)", opacity="0.35"),
         rect(x, y, w, h, "none", stroke=WOOD_D, stroke_width="3.5"),
         line(x + 0.06, y + 0.06, x + w - 0.06, y + h - 0.06, WOOD_L, 3, opacity="0.5"),
         line(x + w - 0.06, y + 0.06, x + 0.06, y + h - 0.06, WOOD_L, 3, opacity="0.5")]
    if open_top:
        g.append(rect(x + 0.12, y + 0.12, w - 0.24, h - 0.24, "#150e08"))
    g.append("</g>")
    add("".join(g))


def barrel(x, y, r=0.42):
    add(f'<g filter="url(#softdrop)">{circ(x, y, r, WOOD)}'
        f'{circ(x, y, r, "none", stroke=WOOD_D, stroke_width="4")}'
        f'{circ(x, y, r * 0.62, "none", stroke=IRON, stroke_width="3", opacity="0.8")}'
        f'{circ(x, y, r * 0.3, "#2a1c10")}</g>')


# ---- north side, from the backstage door to the ring
stall(2.0, 1.9, 4.4, 3.1, "SHOOTING GALLERY", "N")
# tin ducks on their rail, and the rifles
for i in range(7):
    add(circ(2.45 + i * 0.62, 2.62, 0.16, "#5d7f86", stroke="#20303a", stroke_width="2"))
add(line(2.25, 2.62, 6.2, 2.62, "#2b2b2f", 4, opacity="0.9"))
for i in range(3):
    add(line(2.6 + i * 0.9, 3.3, 3.25 + i * 0.9, 3.6, "#2a2119", 7))

stall(7.1, 1.9, 3.4, 3.1, "HOOPLA", "N")
for i in range(3):
    for j in range(2):
        add(circ(7.6 + i * 0.9, 2.6 + j * 0.75, 0.2, "none", stroke=BRASS, stroke_width="4", opacity="0.85"))

# The mirror maze: a black doorway, and panels stacked outside it that two people can carry.
stall(11.2, 1.9, 4.2, 3.1, "HALL OF MIRRORS", "N", roof="url(#roofN)", counter=False)
add(rect(12.6, 3.55, 1.4, 1.45, "#07070c"))
add(rect(12.6, 3.55, 1.4, 1.45, "none", stroke=WOOD_D, stroke_width="5"))
for i in range(4):
    add(f'<g filter="url(#softdrop)">{rect(11.45 + i * 0.28, 3.7, 0.22, 1.25, GLASS, opacity="0.55")}'
        f'{rect(11.45 + i * 0.28, 3.7, 0.22, 1.25, "none", stroke="#d9c79c", stroke_width="2.5")}</g>')
add(f'<g filter="url(#softdrop)">{rect(14.35, 3.8, 0.9, 1.15, GLASS, opacity="0.5")}'
    f'{rect(14.35, 3.8, 0.9, 1.15, "none", stroke="#d9c79c", stroke_width="3")}</g>')

# The dummies: the whole reason to come down this alley. Seen from above they are a head and a pair of
# shoulders and nothing else — which is exactly what they will look like sitting in the stands.
stall(16.1, 1.9, 4.6, 3.1, "THE COMPANY", "N")
for r in range(3):
    for c in range(6 - r % 2):
        cx = 16.6 + c * 0.72 + (r % 2) * 0.36
        cy = 2.5 + r * 0.62
        add(f'<g filter="url(#softdrop)">'
            f'<path d="M{px(cx - 0.26)} {px(cy + 0.22)} Q{px(cx)} {px(cy - 0.02)}, {px(cx + 0.26)} {px(cy + 0.22)} Z" '
            f'fill="#6d5a3c"/>'
            f'{circ(cx, cy - 0.02, 0.155, "#b9a37c")}'
            f'{circ(cx - 0.05, cy - 0.06, 0.05, "#e2d3ae", opacity="0.5")}</g>')

stall(21.4, 1.9, 2.6, 3.1, "TICKETS", "N")
add(rect(21.75, 4.15, 1.9, 0.55, "#0d0a10"))
for i in range(5):
    add(line(21.85 + i * 0.42, 4.2, 21.85 + i * 0.42, 4.65, BRASS, 4, opacity="0.8"))

# ---- south side
stall(2.2, 13.0, 3.2, 3.1, "TEST YOUR STRENGTH", "S", roof="url(#roofS)", counter=False)
add(line(3.8, 13.4, 3.8, 15.9, "#4a3620", 12))
add(circ(3.8, 13.35, 0.22, BRASS, stroke="#6a4a17", stroke_width="3"))
for i, c in enumerate(("#7f2f2b", "#8e5f2b", "#8e8b2b", "#4f7f34")):
    add(rect(3.62, 13.7 + i * 0.5, 0.36, 0.4, c, opacity="0.8"))
add(f'<g filter="url(#softdrop)">{rect(2.6, 15.3, 0.85, 0.5, IRON)}'
    f'{circ(2.55, 15.55, 0.3, "#26262b")}{circ(3.5, 15.55, 0.3, "#26262b")}</g>')

stall(6.0, 13.0, 3.4, 3.1, "FORTUNES", "S", roof="url(#roofS)")
add(f'<g filter="url(#softdrop)">{circ(7.7, 14.3, 0.45, "#2b2440")}'
    f'{circ(7.62, 14.2, 0.16, "#b9c7e6", opacity="0.7")}</g>')
for i in range(4):
    add(rect(8.35 + (i % 2) * 0.3, 14.1 + (i // 2) * 0.42, 0.24, 0.36, CREAM,
             opacity="0.75", transform=f"rotate({-14 + i * 9} {px(8.45 + (i % 2) * 0.3)} {px(14.28)})"))

# The lemonade wagon — on wheels, and heavy. Something to shove.
add(f'<g filter="url(#drop)">{rect(10.2, 13.3, 3.0, 2.0, "#5e2a26")}'
    f'{rect(10.2, 13.3, 3.0, 2.0, "#000", filter="url(#coarse)", opacity="0.3")}'
    f'{rect(10.2, 13.3, 3.0, 2.0, "none", stroke=WOOD_D, stroke_width="4")}'
    f'{rect(10.45, 13.55, 2.5, 0.75, CREAM, opacity="0.28")}'
    f'{circ(10.75, 15.45, 0.42, "#241a12", stroke=WOOD_L, stroke_width="4")}'
    f'{circ(12.65, 15.45, 0.42, "#241a12", stroke=WOOD_L, stroke_width="4")}</g>')
add(text(11.7, 13.35, "LEMONADE", size=15, fill="#f0e0bd", opacity=0.75, spacing=2))

# The menagerie wagon — barred, open, and empty. Whatever was in it is out.
add(f'<g filter="url(#drop)">{rect(14.3, 13.3, 3.3, 2.2, "#120d09")}'
    f'{rect(14.3, 13.3, 3.3, 2.2, "none", stroke="#5a4a2c", stroke_width="9")}</g>')
for i in range(1, 11):
    add(line(14.3 + i * 0.3, 13.35, 14.3 + i * 0.3, 15.45, "#6d5c3a", 4, opacity="0.85"))
add(line(14.3, 14.4, 17.6, 14.4, "#6d5c3a", 3, opacity="0.4"))
add(circ(15.95, 14.4, 0.9, "#000", opacity="0.5", filter="url(#blur18)"))
# the door, hanging open into the aisle
add(f'<g filter="url(#softdrop)" transform="rotate(-52 {px(14.3)} {px(13.3)})">'
    f'{rect(14.3, 13.18, 1.4, 0.2, "#5a4a2c")}</g>')
add(circ(14.55, 15.9, 0.55, "#000", opacity="0.30", filter="url(#blur6)"))
# and a long smear of drag marks coming out of it, up the aisle
add(f'<path d="M{px(15.6)} {px(13.1)} Q{px(14.9)} {px(12.2)}, {px(14.2)} {px(11.6)}" stroke="{SAW_D}" '
    f'stroke-width="{px(0.4)}" fill="none" opacity="0.30" filter="url(#blur6)"/>')

# The crate yard, and the crate Act 1 left open.
for (cx, cy, cw, ch) in ((18.6, 13.1, 1.3, 1.3), (20.0, 13.2, 1.0, 1.1), (18.5, 14.6, 1.1, 1.1),
                         (19.8, 14.5, 1.4, 1.3), (21.3, 14.0, 1.2, 1.2)):
    crate(cx, cy, cw, ch)
crate(21.5, 15.4, 1.4, 1.1, open_top=True)
# fireworks, sticking out of it — the thing they carried out of the dressing room
for i in range(5):
    add(line(21.7 + i * 0.24, 15.9, 21.62 + i * 0.24, 15.35, "#8f3b34", 7))
    add(circ(21.62 + i * 0.24, 15.3, 0.07, "#2a1c10"))
barrel(23.2, 13.6)
barrel(23.4, 14.6, 0.36)

# ---------------------------------------------------------------- the two ends

# WEST: the way back to the dressing room, and the door that came off its hinges.
add(rect(0.6, 6.6, 0.7, 4.4, "#0a0810"))
add(f'<path d="M{px(1.3)} {px(6.6)} Q {px(1.05)} {px(8.8)}, {px(1.3)} {px(11.0)}" stroke="{RED_D}" '
    f'stroke-width="{px(0.5)}" fill="none" opacity="0.95"/>')
add(text(0.95, 8.8, "BACKSTAGE", size=17, fill="#c9b287", opacity=0.75, rot=-90, spacing=3))
add(f'<g filter="url(#drop)" transform="rotate(24 {px(2.6)} {px(10.2)})">'
    f'{rect(1.9, 9.7, 1.6, 2.4, WOOD)}{rect(1.9, 9.7, 1.6, 2.4, "#000", filter="url(#coarse)", opacity="0.35")}'
    f'{rect(1.9, 9.7, 1.6, 2.4, "none", stroke=WOOD_D, stroke_width="4")}'
    f'{line(1.9, 10.4, 3.5, 10.4, WOOD_D, 3)}{line(1.9, 11.3, 3.5, 11.3, WOOD_D, 3)}</g>')
# splinters
for i in range(9):
    a = rnd.uniform(0, math.tau)
    d = rnd.uniform(0.4, 1.8)
    add(line(2.6 + math.cos(a) * d, 10.2 + math.sin(a) * d * 0.7,
             2.6 + math.cos(a) * (d + 0.3), 10.2 + math.sin(a) * (d + 0.3) * 0.7, WOOD_L, 4, opacity="0.6"))

# EAST: the way through to the big top, drawn as the mirror of the backstage flap at the other end —
# a gap in the end wall, its curtain hooked back, and warm light coming through it from a tent that is
# supposed to be empty. Symmetrical with the west on purpose: a player should be able to see at a glance
# that this alley has two ends and which one they came in by.
ENDX = 24.35
add(rect(ENDX, 1.35, COLS - ENDX, ROWS - 2.7, "#161009"))
add(rect(ENDX, 1.35, COLS - ENDX, ROWS - 2.7, "#000", filter="url(#coarse)", opacity="0.45"))
add(rect(ENDX, 1.35, 0.14, ROWS - 2.7, "#0a0704", opacity="0.85"))
add(rect(ENDX + 0.5, 6.2, 0.85, 5.6, "#3a251a"))
add(circ(ENDX + 0.35, 9.0, 2.4, "url(#pool)"))
add(f'<path d="M{px(ENDX + 0.4)} {px(6.2)} Q {px(ENDX + 0.72)} {px(9.0)}, {px(ENDX + 0.4)} {px(11.8)}" '
    f'stroke="{RED_D}" stroke-width="{px(0.5)}" fill="none" opacity="0.95"/>')
add(text(ENDX + 0.95, 9.0, "TO THE RING", size=16, fill="#e2cb9d", opacity=0.85, rot=90, spacing=3))

# ---------------------------------------------------------------- the barker's platform

add(f'<g filter="url(#drop)">{circ(12.6, 9.1, 1.55, "#5c3f23")}'
    f'{circ(12.6, 9.1, 1.55, "#000", filter="url(#coarse)", opacity="0.3")}'
    f'{circ(12.6, 9.1, 1.55, "none", stroke=WOOD_D, stroke_width="6")}'
    f'{circ(12.6, 9.1, 1.2, "none", stroke=RED, stroke_width="7", opacity="0.55")}'
    f'{circ(12.6, 9.1, 0.35, BRASS, opacity="0.5")}</g>')
for i in range(16):
    a = math.tau * i / 16
    add(line(12.6 + math.cos(a) * 0.4, 9.1 + math.sin(a) * 0.4,
             12.6 + math.cos(a) * 1.5, 9.1 + math.sin(a) * 1.5, WOOD_D, 2.5, opacity="0.45"))
# The pole, and the horn hanging off it. This is what has been calling the acts.
add(circ(12.6, 9.1, 0.16, "#2a1c10"))
add(f'<g filter="url(#drop)"><path d="M{px(12.6)} {px(8.5)} L{px(11.75)} {px(8.15)} '
    f'L{px(11.75)} {px(9.05)} Z" fill="{BRASS}" stroke="#6a4a17" stroke-width="3"/>'
    f'{circ(12.6, 8.6, 0.14, "#8a6a24")}</g>')
add(text(12.6, 11.15, "THE MIDWAY", size=20, fill="#e5cfa4", opacity=0.7, spacing=6))

# ---------------------------------------------------------------- litter, rope, light

# Guy ropes crossing overhead, exactly as they do in the dressing room.
for (x1, y1, x2, y2) in ((0.9, 5.55, 23.2, 5.30), (0.9, 12.60, 23.2, 12.85)):
    add(line(x1, y1, x2, y2, "#0b0906", 6, opacity="0.45"))
    add(line(x1, y1, x2, y2, "#8c7350", 2.5, opacity="0.30"))

# String lights along the two roof lines, and the pools they throw on the sawdust.
for i in range(20):
    x = 1.6 + i * 1.22
    add(circ(x, 5.4 + math.sin(i) * 0.06, 0.09, LAMP, opacity="0.9"))
    add(circ(x, 12.75 + math.sin(i + 2) * 0.06, 0.09, LAMP, opacity="0.85"))
for x in (3.0, 6.2, 9.4, 12.6, 15.8, 19.0, 22.0):
    add(circ(x, 9.0, 3.3, "url(#pool)"))
    add(circ(x, 5.5, 1.5, "url(#pool)", opacity="0.55"))
    add(circ(x, 12.7, 1.5, "url(#pool)", opacity="0.55"))

# Sawdust litter: stubs, popcorn, a dropped programme, a mask nobody came back for.
for _ in range(150):
    x = rnd.uniform(1.2, 24.6)
    y = rnd.uniform(1.6, 16.4)
    add(circ(x, y, rnd.uniform(0.025, 0.06), rnd.choice(("#e8dcc0", "#cbb894", "#8e6a3c", "#7f2f2b")),
             opacity=f"{rnd.uniform(0.25, 0.7):.2f}"))
for _ in range(22):
    x, y = rnd.uniform(1.4, 24.4), rnd.uniform(6.2, 12.4)
    add(rect(x, y, 0.22, 0.16, CREAM, opacity=f"{rnd.uniform(0.2, 0.5):.2f}",
             transform=f"rotate({rnd.uniform(0, 180):.0f} {px(x):.0f} {px(y):.0f})"))
# A mask, face down in the sawdust, and a programme nobody picked up.
add(f'<g filter="url(#softdrop)" transform="rotate(-22 {px(8.4)} {px(10.6)})">'
    f'<ellipse cx="{px(8.4)}" cy="{px(10.6)}" rx="{px(0.28)}" ry="{px(0.34)}" fill="#7d6a4a"/>'
    f'<ellipse cx="{px(8.4)}" cy="{px(10.6)}" rx="{px(0.22)}" ry="{px(0.27)}" fill="#4a3c28"/></g>')
add(f'<g filter="url(#softdrop)" transform="rotate(14 {px(17.2)} {px(11.4)})">'
    f'{rect(16.95, 11.2, 0.5, 0.38, "#c9b48b")}{line(17.0, 11.3, 17.4, 11.3, "#5a4a30", 2)}'
    f'{line(17.0, 11.4, 17.4, 11.4, "#5a4a30", 2)}</g>')

# ---------------------------------------------------------------- the dark at the edges
#
# No grid is drawn here on purpose: the app lays its own over the picture from the scene's cols/rows/cell,
# and two grids a pixel apart is worse than none. What the picture owes it is that its squares are 70px
# and start at the corner, which they do.

add(rect(0, 0, COLS, ROWS, "url(#alley)"))
add(rect(0, 0, COLS, ROWS, "url(#vign)"))
add("</svg>")

svg = "\n".join(out)
dest = ROOT / "maps" / "midway.svg"
dest.parent.mkdir(exist_ok=True)
dest.write_text(svg, encoding="utf-8")
print(f"wrote {dest}  ({COLS}x{ROWS} squares, {W}x{H}px, {len(svg) // 1024} KB of SVG)")
