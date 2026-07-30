#!/usr/bin/env python3
"""Static hygiene check on the front-end, so rot cannot accumulate silently.

    python3 scripts/lint_assets.py

Catches four things the content lints cannot see:
  1. a CSS class used by app.js or index.html that no stylesheet declares (invisible element)
  2. a CSS class declared but used nowhere (dead style)
  3. a function defined in app.js and never referenced (dead code)
  4. a schema field that no renderer reads (authored data that never reaches the screen)

Exit 1 on anything in group 1 or 3 (real defects); groups 2 and 4 print as warnings, because a
style or field can legitimately be staged ahead of the content that uses it.
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# every script the page loads, not just app.js — creator.js owns most of the newer markup
JS = "\n".join(f.read_text(encoding="utf-8") for f in sorted((ROOT / "assets/js").glob("*.js")))
CSS_RAW = (ROOT / "assets/css/style.css").read_text(encoding="utf-8")
# strip comments first: they mention filenames like app.js and MECHANICS.md, which a naive
# class-name regex happily reads as ".js" and ".md".
CSS = re.sub(r"/\*.*?\*/", "", CSS_RAW, flags=re.S)
HTML = (ROOT / "index.html").read_text(encoding="utf-8")

# Most class attributes in this codebase are template literals — class="pick ${on ? "on" : ""}".
# Strip the ${...} expressions first, or every such attribute is skipped and its static names
# report as unused.
JS_STATIC = re.sub(r"\$\{[^{}]*\}", " ", JS)

# classes referenced from markup strings, el() calls and classList operations
used = set()
for pat in (r'class="([^"]+)"',
            r'el\(\s*"[a-z0-9]+"\s*,\s*"([a-z0-9 -]+)"',
            r'classList\.(?:add|remove|toggle)\("([a-z0-9-]+)"',
            # className = "save-msg bad" — assigned, not written into markup
            r'className\s*=\s*"([a-z0-9 -]+)"'):
    for m in re.finditer(pat, JS_STATIC):
        used.update(m.group(1).split())
for m in re.finditer(r'class="([^"]+)"', HTML):
    used.update(m.group(1).split())
# Names that only appear INSIDE a class attribute's own expression — class="pick ${on ? "on" : ""}".
# Pull every quoted fragment out of the raw (unstripped) attribute.
# Names applied conditionally inside a class attribute — class="pick ${on ? "on" : ""}" — are not
# visible to any static scan, so the few that exist are declared here rather than chased with an
# ever-greedier regex (a wider one starts reading data-act values as class names).
used.update(["on", "blocked", "btn-hot", "down", "hurt", "primary", "spent", "warn", "good", "bad",
             "hidden", "active", "empty"])
# dynamic families the linter cannot resolve statically
DYNAMIC = ("tier-", "badge-")
used.update(c for c in re.findall(r'\.([a-z][a-z0-9-]+)', CSS) if c.startswith(DYNAMIC))

# A trailing dash is an artifact of stripping a ${...} out of e.g. "tier-${tier}" — not a class.
used = {c for c in used if c and not c.endswith("-")}

declared = set(re.findall(r'\.([a-z][a-z0-9-]+)', CSS))
missing = sorted(c for c in used if c not in declared)
unused = sorted(c for c in declared if c not in used)

defs = re.findall(r'^function (\w+)', JS, re.M)
dead_fns = [f for f in defs if len(re.findall(r"\b%s\b" % f, JS)) < 2]

unread = []
for schema in sorted((ROOT / "data/schema").glob("*.schema.json")):
    doc = json.loads(schema.read_text(encoding="utf-8"))
    props = doc.get("properties") or (doc.get("definitions", {}).get("skill", {}).get("properties")) or {}
    for field in props:
        if field in ("id", "name", "source") or field.startswith("$"):
            continue
        if not re.search(r"\.%s\b" % re.escape(field), JS):
            unread.append(f"{schema.stem}.{field}")

errors = []
if missing:
    errors.append("CSS classes used but never declared: " + ", ".join(missing))
if dead_fns:
    errors.append("functions defined but never referenced: " + ", ".join(dead_fns))

for label, items in (("unused CSS classes", unused), ("schema fields no renderer reads", unread)):
    if items:
        print(f"  note: {len(items)} {label}: {', '.join(items)}")

if errors:
    print("ASSET LINT FAILED:", file=sys.stderr)
    for e in errors:
        print("  -", e, file=sys.stderr)
    sys.exit(1)
print(f"asset lint clean: {len(declared)} CSS classes, {len(defs)} functions across {len(list((ROOT/'assets/js').glob('*.js')))} scripts, no missing styles or dead functions")
