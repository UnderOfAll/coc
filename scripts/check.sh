#!/usr/bin/env bash
# One-command health check for Circus of Chaos. Runs the full gate:
#   1. build_manifest.py  — rebuild manifest + bundle, dup-id check, inline-formula lint
#   2. validate.py        — JSON Schema validation + subclass-parent resolution
#   3. lint_assets.py     — front-end hygiene: missing styles, dead functions, unread fields
#   4. npm run test:live   — CocLive: writes land, watchers fire, a drag collapses into few writes,
#                           and the database's streaming events are applied to the mirror correctly
#   5. npm run test:table  — DRIVE a live session: open a table, have a second device join, drag
#                           tokens with pointer events, and prove a player cannot move someone else's
#   6. npm run test:dom   — render every page in jsdom (0 errors, 0 leaked tokens expected)
#   5. npm run test:ui    — DRIVE the creator and the sheet: click through a build, level up,
#                           expand a feature, damage yourself. Rendering a page proves nothing
#                           about whether its controls work, and that gap is where every bug in
#                           this tool has hidden so far.
#   8. npm run test:cross  — the SAME board in every engine this machine can run: real Firefox, real
#                           WebKit (Safari) and real Chromium, plus a Pixel and an iPhone. This is the step
#                           that would have caught the native-drag bug that took five reports.
#   7. npm run test:board  — REAL Chromium on the table: a finger drags a token, two fingers pinch,
#                           the wheel keeps the square under the cursor, and an upload is resized
#                           through a canvas. None of that exists in jsdom.
#   6. npm run test:mobile — REAL Chromium at 360px and 320px: assert nothing makes the document
#                           wider than the screen. jsdom has no layout engine and cannot see this,
#                           and it is the one class of bug that made the app unusable on a phone.
# Exits non-zero if any step fails. Run before committing content changes.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> build_manifest.py"
python3 scripts/build_manifest.py

echo "==> validate.py"
python3 scripts/validate.py

echo "==> lint_assets.py"
python3 scripts/lint_assets.py

echo "==> npm run test:live"
npm run test:live

echo "==> npm run test:table"
npm run test:table

echo "==> npm run test:dom"
npm run test:dom

echo "==> npm run test:ui"
npm run test:ui

echo "==> npm run test:mobile"
npm run test:mobile

echo "==> npm run test:board"
npm run test:board

echo "==> npm run test:cross"
npm run test:cross

echo "==> ALL CHECKS PASSED"
