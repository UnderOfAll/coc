#!/usr/bin/env bash
# One-command health check for Circus of Chaos. Runs the full gate:
#   1. build_manifest.py  — rebuild manifest + bundle, dup-id check, inline-formula lint
#   2. validate.py        — JSON Schema validation + subclass-parent resolution
#   3. lint_assets.py     — front-end hygiene: missing styles, dead functions, unread fields
#   4. npm run test:dom   — render every page in jsdom (0 errors, 0 leaked tokens expected)
#   5. npm run test:ui    — DRIVE the creator and the sheet: click through a build, level up,
#                           expand a feature, damage yourself. Rendering a page proves nothing
#                           about whether its controls work, and that gap is where every bug in
#                           this tool has hidden so far.
# Exits non-zero if any step fails. Run before committing content changes.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> build_manifest.py"
python3 scripts/build_manifest.py

echo "==> validate.py"
python3 scripts/validate.py

echo "==> lint_assets.py"
python3 scripts/lint_assets.py

echo "==> npm run test:dom"
npm run test:dom

echo "==> npm run test:ui"
npm run test:ui

echo "==> ALL CHECKS PASSED"
