#!/usr/bin/env python3
"""Validate every content JSON against its category schema.

    python3 scripts/validate.py

Complements build_manifest.py (which checks parseability, duplicate ids, and the
inline-formula lint). This one enforces the JSON Schemas in data/schema/, checks
that every subclass points at a real parent class, and refuses a damaging Turn shared
across the two caster grades. Exit 1 on any failure.
"""
import json
import re
import sys
from pathlib import Path

try:
    import jsonschema
except ImportError:
    print("jsonschema not installed — run: pip install jsonschema", file=sys.stderr)
    sys.exit(2)

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
# category folder -> schema file stem
SCHEMA = {
    "classes": "class", "subclasses": "subclass", "tricks": "trick",
    "skills": "skill", "passives": "passive", "weapons": "weapon",
    "armor": "armor", "rules": "rule",
}


# Caster grades (MECHANICS §4.9a). A half-caster's Turns walk the SHORT scaling ladder
# (§3.1a); everyone else's dice walk the full one.
FULL_CASTERS = {"illusionist", "jester"}
HALF_CASTERS = {"puppeteer", "doppelganger", "joker"}
SCALING_DIE = re.compile(r"\[\[\s*\d+d\d+")


def load(p):
    doc = json.loads(p.read_text(encoding="utf-8"))
    return doc if isinstance(doc, list) else [doc]


def composition(obj):
    """The locked subclass shape (DESIGN.md): exactly 3 features, 2 combat + 1 roleplay."""
    feats = obj.get("features") or []
    roles = [f.get("role") for f in feats]
    if len(feats) == 3 and roles.count("combat") == 2 and roles.count("roleplay") == 1:
        return None
    return (f"subclass composition is {len(feats)} features "
            f"{{combat: {roles.count('combat')}, roleplay: {roles.count('roleplay')}, "
            f"untagged: {roles.count(None)}}} — the locked shape is exactly 3: 2 combat + 1 roleplay")


def cross_grade_turn(obj):
    """A damaging Turn on both a full and a half caster's list has two different, equally
    correct scaling ladders and one page to show them on — so it is not authorable. Utility
    tricks are fine to share (Sleight is), and Pledges/Prestiges use the full ladder for
    everyone, so only a Turn carrying a scaling die can hit this."""
    if obj.get("tier") != "turn":
        return None
    classes = set(obj.get("classes") or [])
    if not (classes & FULL_CASTERS and classes & HALF_CASTERS):
        return None
    text = str(obj.get("description", "")) + str(obj.get("sheetSummary", ""))
    for opt in obj.get("options") or []:
        text += str(opt.get("effect", ""))
    if not SCALING_DIE.search(text):
        return None
    return (f"damaging Turn shared by a full caster and a half-caster "
            f"({', '.join(sorted(classes))}) — the two grades scale it differently "
            f"(MECHANICS §3.1a), so give each class its own trick")


def main():
    errors = []
    class_ids = set()
    subclass_parents = []
    subclass_ids = set()
    subclass_parent = {}
    granted_tricks = []

    for cat, stem in SCHEMA.items():
        schema_path = DATA / "schema" / f"{stem}.schema.json"
        if not schema_path.exists():
            continue
        schema = json.loads(schema_path.read_text(encoding="utf-8"))
        for f in sorted((DATA / cat).glob("*.json")):
            try:
                for obj in load(f):
                    jsonschema.validate(obj, schema)
                    if cat == "classes":
                        class_ids.add(obj.get("id") or obj.get("name"))
                    if cat == "subclasses":
                        subclass_parents.append((f.name, obj.get("parentClass")))
                        sid = obj.get("id") or obj.get("name")
                        subclass_ids.add(sid)
                        subclass_parent[sid] = obj.get("parentClass")
                    if cat == "subclasses":
                        bad = composition(obj)
                        if bad:
                            errors.append(f"subclasses/{f.name}: {bad}")
                    if cat == "tricks":
                        if obj.get("subclasses"):
                            granted_tricks.append((f.name, obj["subclasses"], obj.get("classes") or []))
                        bad = cross_grade_turn(obj)
                        if bad:
                            errors.append(f"tricks/{f.name}: {bad}")
            except jsonschema.ValidationError as e:
                errors.append(f"{cat}/{f.name}: {e.message} (at {list(e.path)})")
            except json.JSONDecodeError as e:
                errors.append(f"{cat}/{f.name}: invalid JSON — {e}")

    # every subclass must reference a real parent class
    for fname, parent in subclass_parents:
        if parent not in class_ids:
            errors.append(f"subclasses/{fname}: parentClass {parent!r} is not an existing class")

    # a subclass-granted trick must name a real subclass AND file under its parent class,
    # or the Tricks tab has nowhere to put it (MECHANICS 4.9d)
    for fname, subs, classes in granted_tricks:
        for sid in subs:
            if sid not in subclass_ids:
                errors.append(f"tricks/{fname}: subclasses lists {sid!r}, which is not an existing subclass")
            elif subclass_parent.get(sid) not in classes:
                errors.append(f"tricks/{fname}: granted by {sid!r} but its parent class "
                              f"{subclass_parent.get(sid)!r} is not in this trick's `classes`")

    if errors:
        print("SCHEMA VALIDATION FAILED:", file=sys.stderr)
        for e in errors:
            print("  -", e, file=sys.stderr)
        sys.exit(1)
    print(f"schema-valid: all files pass; {len(class_ids)} classes, "
          f"{len(subclass_parents)} subclasses, all parents resolve")


if __name__ == "__main__":
    main()
