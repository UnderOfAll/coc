#!/usr/bin/env python3
"""Scan data/<category>/ and (re)generate data/manifest.json.

Run this whenever an agent adds, renames, or removes a content JSON file:

    python3 scripts/build_manifest.py

It also validates that every file is parseable JSON and reports duplicates by id,
so a malformed drop is caught before it silently disappears from the UI.
"""

import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CATEGORIES = ["rules", "classes", "subclasses", "tricks", "skills", "passives", "weapons", "armor", "enemies"]
# Assets that get a content-hash cache-buster stamped into index.html (see stamp_assets).
VERSIONED_ASSETS = ["assets/css/style.css", "assets/js/app.js",
                    "assets/js/storage.js", "assets/js/creator.js", "assets/js/dm.js",
                    "assets/js/live.js", "assets/js/table-board.js",
                    "assets/js/table-dice.js", "assets/js/table-panels.js",
                    "assets/js/table-music.js", "assets/js/table.js"]


def entries(path):
    """Yield each content object from a file (files may hold one object or a list)."""
    doc = json.loads(path.read_text(encoding="utf-8"))
    yield from (doc if isinstance(doc, list) else [doc])


# Prose must never spell a derived-number formula (a DC, a to-hit, a cap) inline. Such
# numbers are character-dependent: on a class page they belong in a {{Label|formula}} hover
# tooltip; on a real character sheet they get replaced by the computed value. This lint
# catches raw calculus that slipped into prose so it can't silently reappear (see DESIGN.md
# "Formula tooltips, not inline"). Formulas *inside* a {{...}} token are the correct usage
# and are exempt (stripped before matching).
# Tokens whose contents are the SANCTIONED place for math — stripped before linting.
# {{Label|formula}} = a derived-number tooltip; [[XdY]] / [[XdY+Abil]] = a scaling-damage die.
TOKEN_RE = re.compile(r"\{\{[^}]*\}\}|\[\[[^\]]*\]\]")
# A {{Label|formula}} token shows the LABEL and hides the formula. Writing it the other way
# round renders the maths inline - the exact thing the tooltip rule exists to prevent - and it
# has slipped through twice, so it is linted rather than eyeballed.
REVERSED_TOKEN_RE = re.compile(
    r"\{\{\s*[^|{}]*(?:d20\s*\+|proficiency bonus\s*\+|\d+\s*\+\s*(?:your\s+)?proficiency|"
    r"equal to your\s+[A-Za-z]+\s+modifier)[^|{}]*\|", re.I)
INLINE_FORMULA_RES = [
    # DC / derived-number formulas spelled out (must be a {{Label|formula}} token).
    re.compile(r"\d+\s*\+\s*(?:your\s+)?proficiency bonus", re.I),
    re.compile(r"proficiency bonus\s*\+\s*(?:your\s+)?[A-Za-z]+ modifier", re.I),
    # Damage die immediately followed by "+ your <ability> modifier" (fold into [[XdY+Abil]]).
    re.compile(r"\]\]\s*(?:\+|plus|and)\s+(?:your\s+)?[A-Za-z]+ modifier", re.I),
    # An attack-roll formula spelled out (must be a {{attack roll|...}} token).
    re.compile(r"d20\s*\+\s*(?:your\s+)?[A-Za-z]+ modifier", re.I),
    # A uses-count / cap / flat value spelled as "equal to your <stat>" (must be a token).
    re.compile(r"equal to your (?:proficiency bonus|[A-Za-z]+ modifier)", re.I),
]
# Rules pages exist to TEACH the math, so their formulas stay inline (lint-exempt).
LINT_EXEMPT_CATEGORIES = {"rules"}
# Keys whose free-text values are player-facing prose to lint.
# `sheetSummary` USED to be excluded, on the grounds that it was invisible character-sheet text.
# That stopped being true when the two-tab view shipped: sheetSummary is now the PRIMARY rendered
# text of the "How it works" tab, and the exemption is exactly why two reversed tokens reached the
# live site. `narration` is linted too — it is the "In play" tab and is supposed to carry no maths
# at all.
PROSE_KEYS = {"description", "effect", "summary", "flavor", "note", "text",
              "paragraphs", "parryReskin", "riposte", "sheetSummary", "narration"}


def _iter_prose(obj):
    """Yield (key, string) for every player-facing prose value, recursively."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if isinstance(v, str) and k in PROSE_KEYS:
                yield k, v
            else:
                yield from _iter_prose(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _iter_prose(v)


def lint_summary_duplication(obj, rel):
    """An entry with an `options` table must keep its sheetSummary to the intro line: cost, action,
    range, duration, then a pointer at the table. Restating the rows there is the prose-blob problem
    wearing a different hat, and it has been flagged by Kayki repeatedly."""
    out = []
    for f in _iter_optioned(obj):
        s = f.get("sheetSummary") or ""
        if len(s) > 320:
            out.append(f"summary duplicates its options table in {rel} ({f.get('name')}): "
                       f"{len(s)} chars — keep it to the intro line and let the table carry the rows")
    return out


def _iter_optioned(obj):
    """Yield every dict that carries a non-empty `options` list."""
    if isinstance(obj, dict):
        if isinstance(obj.get("options"), list) and obj["options"]:
            yield obj
        for v in obj.values():
            yield from _iter_optioned(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _iter_optioned(v)


# A trick's sheetSummary used to open with "Action, 30 ft, cooldown 2, costs 1 Mirth." — every one
# of which the sheet and the trick page now render as its own at-a-glance chip, from the trick's own
# castingTime/range/cooldown/engineCost fields. Restating them is duplication that goes stale the
# moment one of those fields changes. Targeting ("10-ft radius burst", "one creature") is NOT this
# and must stay: it is nowhere else.
PREAMBLE_RES = [
    re.compile(r"^(1\s+)?(action|bonus action|reaction)$", re.I),
    re.compile(r"^\d+\s*(ft|feet)$", re.I),
    re.compile(r"^(self|touch)$", re.I),
    re.compile(r"^cooldown\s+\d+$", re.I),
    re.compile(r"^costs?\s+\d+\s+\w+$", re.I),
    re.compile(r"^concentration(\s+up\s+to\s+.+)?$", re.I),
    re.compile(r"^once per combat$", re.I),
]


# The same duplication on a FEATURE, where the chips are built from its own `meta` block. A part is
# only a duplicate if the matching meta field actually exists — otherwise the summary is the only
# place it is written down.
FEATURE_PREAMBLE_RES = [
    ("action", re.compile(r"^(1\s+)?(action|bonus action|reaction|free action|no action)$", re.I)),
    ("range", re.compile(r"^(\d+\s*(ft|feet)|self|touch|self\s*/\s*\d+\s*ft)$", re.I)),
    ("uses", re.compile(r"^(\d+\s*/\s*(turn|combat|round)|once per (turn|combat|round))$", re.I)),
    ("cost", re.compile(r"^(costs?\s+)?\d+\s+[A-Z][a-z]+$")),
]


def lint_summary_preamble(obj, rel):
    """A trick summary must not restate the meta chips the renderer builds from its own fields."""
    out = []
    summary = obj.get("sheetSummary") or ""
    head = summary.split(". ")[0] if ". " in summary else summary
    for part in (p.strip().rstrip(".") for p in head.split(",")):
        if any(rx.match(part) for rx in PREAMBLE_RES):
            out.append(f"summary preamble in {rel} ({obj.get('name')}): {part!r} — castingTime, range, "
                       f"cooldown, engineCost and the Prestige tier already render as chips; "
                       f"say only what they cannot (targeting, shape, requirements)")
    return out


# A summary that OPENS by naming its action economy — "Passive.", "Free,", "Action:", "Special," —
# says nothing the Cost chip has not already said.
LEAD_ACTION_RE = re.compile(
    r"^(passive|free|special|automatic|movement|action|bonus action|reaction|no action)\b\s*[:,.]", re.I)
# The scaling-uses ladder written out longhand next to a Uses chip that already says "Scaling".
LEAD_USES_RE = re.compile(r"^\{\{uses per combat\|[^}]*\}\}\s*(times|uses) per combat$", re.I)


def _split_parts(text):
    """Split on commas that are OUTSIDE a {{...}} token — the tokens contain commas of their own."""
    parts, depth, buf = [], 0, ""
    for i, ch in enumerate(text):
        if text.startswith("{{", i): depth += 1
        if text.startswith("}}", i) and depth: depth -= 1
        if ch == "," and depth == 0:
            parts.append(buf); buf = ""
        else:
            buf += ch
    parts.append(buf)
    return [p.strip().rstrip(".") for p in parts if p.strip()]


def lint_feature_preambles(obj, rel):
    """Same rule for every feature carrying a `meta` block."""
    out = []
    for feat in (obj.get("features") or []):
        meta = feat.get("meta") or {}
        summary = feat.get("sheetSummary") or ""
        head = summary.split(". ")[0] if ". " in summary else summary
        if meta.get("action") and LEAD_ACTION_RE.match(summary):
            out.append(f"summary preamble in {rel} ({feat.get('name')}): opens by naming its action "
                       f"economy, which meta.action already renders as a chip")
        for part in _split_parts(head):
            if meta.get("uses") and LEAD_USES_RE.match(part):
                out.append(f"summary preamble in {rel} ({feat.get('name')}): spells out the uses "
                           f"ladder that meta.uses already renders as a chip")
            for field, rx in FEATURE_PREAMBLE_RES:
                if meta.get(field) and rx.match(part):
                    out.append(f"summary preamble in {rel} ({feat.get('name')}): {part!r} duplicates "
                               f"meta.{field}, which already renders as a chip")
    return out


def lint_inline_formulas(obj, rel):
    """Return a list of error strings for inline calculus found in prose (tokens exempt)."""
    out = []
    for _key, text in _iter_prose(obj):
        stripped = TOKEN_RE.sub("", text)
        for m in REVERSED_TOKEN_RE.finditer(text):
            out.append(f"reversed token in {rel} ({_key}): {m.group(0)[:60]!r} — the LABEL is the "
                       f"maths; {{Label|formula}} must hide the formula, not show it")
        for rx in INLINE_FORMULA_RES:
            m = rx.search(stripped)
            if m:
                out.append(f"inline formula in {rel}: {m.group(0)!r} "
                           f"— wrap as {{{{Label|formula}}}} (see DESIGN.md)")
                break
    return out


def build_map_index():
    """List the map images committed into maps/ so the table's DM panel can offer them.

    A map served from the repo costs nothing to host and never touches the database, which is why it
    is one of the four ways to get a map onto the board. The app cannot list a directory over HTTP,
    so the build writes the listing out for it.
    """
    folder = ROOT / "maps"
    folder.mkdir(exist_ok=True)
    exts = {".jpg", ".jpeg", ".png", ".webp", ".avif"}
    files = sorted(f.name for f in folder.iterdir() if f.suffix.lower() in exts)
    (folder / "index.json").write_text(json.dumps(files, indent=2) + "\n", encoding="utf-8")
    return files


def build_music_index():
    """List the audio committed into music/ so the table's Music panel can offer it.

    Same trade as the maps, for the same reason: the app cannot list a directory over HTTP, so the build
    writes the listing out for it. A track served from the repo has no size cap and never goes near the
    database — which is what makes "download it, drop it in, push" the sane way to run a session's music.
    """
    folder = ROOT / "music"
    folder.mkdir(exist_ok=True)
    exts = {".mp3", ".ogg", ".m4a", ".opus", ".wav", ".webm"}
    # SUBFOLDERS ARE THE POINT. Kayki wants music/backstage/, music/main-stage/ and so on, so the listing
    # is relative paths rather than names — the panel groups by the first segment and the app fetches
    # "music/" + the path. One level or five; the walk does not care.
    files = sorted(str(f.relative_to(folder).as_posix())
                   for f in folder.rglob("*") if f.is_file() and f.suffix.lower() in exts)
    (folder / "index.json").write_text(json.dumps(files, indent=2) + "\n", encoding="utf-8")
    return files


def stamp_assets():
    """Stamp a short content hash onto each versioned asset's link in index.html.

    Browsers cache assets/js/app.js and assets/css/style.css aggressively (GitHub Pages
    serves them with a long max-age), so a deploy can look unchanged until a hard refresh.
    Appending '?v=<hash of the file>' makes the URL change whenever — and only when — the
    file's contents change, so browsers fetch the new version automatically. Run as part of
    the normal build, so it's always in sync before a push.
    """
    index = ROOT / "index.html"
    html = index.read_text(encoding="utf-8")
    stamped = []
    for asset in VERSIONED_ASSETS:
        path = ROOT / asset
        if not path.exists():
            continue
        digest = hashlib.md5(path.read_bytes()).hexdigest()[:8]
        # Match "asset" or "asset?v=..." inside the src/href attribute, keeping the quote char.
        pattern = re.compile(r'(["\'])' + re.escape(asset) + r'(?:\?v=[0-9a-f]+)?\1')
        html, n = pattern.subn(r'\g<1>' + asset + '?v=' + digest + r'\g<1>', html)
        if n:
            stamped.append(f"{asset}?v={digest}")
    index.write_text(html, encoding="utf-8")
    return stamped


def main():
    manifest = {}
    bundle = {}
    errors = []
    seen_ids = {}

    for cat in CATEGORIES:
        folder = DATA / cat
        folder.mkdir(exist_ok=True)
        files = []
        objs = []
        for f in sorted(folder.glob("*.json")):
            rel = f"{cat}/{f.name}"
            try:
                for obj in entries(f):
                    key = (cat, obj.get("id") or obj.get("name", ""))
                    if key in seen_ids:
                        errors.append(f"duplicate {cat} id {key[1]!r}: {rel} and {seen_ids[key]}")
                    seen_ids[key] = rel
                    if cat not in LINT_EXEMPT_CATEGORIES:
                        errors.extend(lint_inline_formulas(obj, rel))
                        errors.extend(lint_summary_duplication(obj, rel))
                        if cat == "tricks":
                            errors.extend(lint_summary_preamble(obj, rel))
                        if cat in ("classes", "subclasses"):
                            errors.extend(lint_feature_preambles(obj, rel))
                    obj["_file"] = rel
                    objs.append(obj)
                files.append(rel)
            except json.JSONDecodeError as e:
                errors.append(f"invalid JSON in {rel}: {e}")
        manifest[cat] = files
        bundle[cat] = objs

    (DATA / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    # bundle.json inlines every entry so the app loads in ONE request instead of ~60.
    (DATA / "bundle.json").write_text(
        json.dumps(bundle, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    stamped = stamp_assets()
    maps = build_map_index()
    music = build_music_index()

    print(f"maps/index.json written — {len(maps)} map image(s) committed to the repo")
    print(f"music/index.json written — {len(music)} track(s) committed to the repo")

    total = sum(len(v) for v in manifest.values())
    print(f"manifest.json + bundle.json written — {total} files across {len(CATEGORIES)} categories")
    for cat in CATEGORIES:
        print(f"  {cat:11} {len(manifest[cat])}")
    for s in stamped:
        print(f"  stamped {s}")

    if errors:
        print("\nWARNINGS:", file=sys.stderr)
        for e in errors:
            print("  -", e, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
