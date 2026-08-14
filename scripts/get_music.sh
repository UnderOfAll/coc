#!/usr/bin/env bash
# Pull the audio out of a link and drop it in music/, ready to commit.
#
#   bash scripts/get_music.sh backstage "https://youtu.be/xxxxxxxxxxx"
#   bash scripts/get_music.sh main-stage URL URL URL
#   bash scripts/get_music.sh midway --from list.txt        # one URL per line, # for comments
#
# The first argument is the FOLDER inside music/ it lands in. Use "." for the top level.
#
# WHY THIS EXISTS. Kayki: "I don't want to use one of those skanky dangerous sites to convert it." Those
# sites are a web page wrapped around exactly these two programs, plus adverts and a malware surface.
# This is the two programs:
#   yt-dlp  — fetches the best audio-only stream there is, so nothing is wasted decoding video
#   ffmpeg  — turns it into an mp3
# Both are open source, both are in every distribution, and neither wants anything from you.
#
# WHAT IT DOES BESIDES DOWNLOAD, because the point is a file that is good to play at a table:
#   · audio-only from the start (smaller and faster than grabbing a video and throwing it away)
#   · 192 kbps, which is past the point anybody hears a difference under a fight
#   · LOUDNESS-NORMALISED to -16 LUFS, so the backstage track and the boss track do not need the
#     players to reach for their volume between scenes. This is the thing the conversion sites do not do
#     and the reason a homemade playlist usually sounds like a mess.
#   · a READABLE filename — "Soul of Cinder.mp3", not "soul-of-cinder.mp3" — because the filename IS the
#     title the DM picks from in the app, sitting in a list beside tracks named by hand
#   · chapters, playlists and anything else clever left alone: one link, one file
#
# A NOTE ON WHAT YOU PUT IN HERE, once, and practical rather than moral: `music/` is committed to a
# PUBLIC repository, so anything in it is being republished to anybody who visits, not kept for your
# table. That is a different thing from downloading a track to listen to, and it is the kind of thing
# that gets a GitHub Pages site taken down rather than argued with. Plenty of people who make tabletop
# ambience put it on YouTube specifically to be used this way and say so in the description — those are
# the safe ones to commit. For anything else, keep the file off the repo and use "From this device" in
# the Music panel, which stores it in the table rather than on the public site.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ $# -lt 2 ]; then
  echo "usage: bash scripts/get_music.sh <folder> <url> [url…]"
  echo "       bash scripts/get_music.sh <folder> --from <file-of-urls>"
  exit 1
fi

for tool in yt-dlp ffmpeg; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "$tool is not installed."
    echo "  ffmpeg: sudo apt-get install -y ffmpeg"
    echo "  yt-dlp: pip3 install --upgrade yt-dlp"
    exit 1
  }
done

# A THIRD PROGRAM, and only because YouTube made it necessary. The page hands out a JavaScript puzzle
# that has to be run to get a working media URL; without an engine to run it yt-dlp falls back to a
# client that now answers 403 on plenty of tracks — it fails per-video, so it looks like a broken link
# rather than a missing dependency. Deno is the runtime yt-dlp enables by default (node is detected but
# refused unless it is very new). Nothing else in this project uses it.
command -v deno >/dev/null 2>&1 || {
  echo "deno is not installed — without it YouTube returns 403 for many tracks."
  echo "  sudo apt-get install -y unzip"
  echo "  curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh -s -- -y"
  echo
  echo "Carrying on anyway; if a link fails with 403, that is why."
}

folder="$1"; shift
dest="music/${folder}"
[ "$folder" = "." ] && dest="music"
mkdir -p "$dest"

urls=()
if [ "${1:-}" = "--from" ]; then
  [ -f "${2:-}" ] || { echo "no such file: ${2:-}"; exit 1; }
  while IFS= read -r line; do
    line="${line%%#*}"                      # trailing comments
    line="$(echo "$line" | tr -d '[:space:]')"
    [ -n "$line" ] && urls+=("$line")
  done < "$2"
else
  urls=("$@")
fi

echo "==> ${#urls[@]} link(s) into $dest/"
ok=0
for url in "${urls[@]}"; do
  echo
  echo "--- $url"
  # `-x` takes the audio-only stream; the postprocessor makes the mp3. Spaces in the name are fine: every
  # path segment is URL-escaped where it is used, and the alternative is a title nobody can read.
  if yt-dlp \
      --no-playlist \
      --extract-audio --audio-format mp3 --audio-quality 192K \
      --embed-metadata \
      --postprocessor-args "ExtractAudio:-af loudnorm=I=-16:TP=-1.5:LRA=11" \
      --output "$dest/%(title)s.%(ext)s" \
      --no-progress \
      "$url"; then
    ok=$((ok + 1))
  else
    echo "!!! that one failed — carrying on with the rest"
  fi
done

# Tidy every name in the folder, not only the ones just fetched: it is idempotent and it means a file
# dragged in by hand gets the same treatment.
echo
echo "==> tidying filenames"
python3 - "$dest" <<'PY'
# WHAT THE TIDY DOES AND DOES NOT DO. Kayki, seeing a shelf of hand-named YouTube tracks beside these:
# "before you were putting the musics like Soul of Cinder, and the last three you were putting
# like-this-i-doint-know-why". He is right — for a REPO track the filename becomes the title in the app,
# so lower-casing it and hyphenating it made every downloaded track read like a slug next to the ones he
# typed himself. What is left is only what genuinely hurts: the (Official Video) noise, characters a URL
# or a filesystem argues about, and runs of whitespace. Capitals, spaces and words are kept.
import re, sys, unicodedata
from pathlib import Path
folder = Path(sys.argv[1])
for f in sorted(folder.glob("*.mp3")):
    stem = unicodedata.normalize("NFKD", f.stem).encode("ascii", "ignore").decode()
    stem = re.sub(r"[\(\[].*?[\)\]]", " ", stem)          # (Official Video), [HD] and friends
    stem = re.sub(r"[\\/:*?\"<>|#%&{}$!'`~+]", " ", stem)     # what a path or a URL would rather not carry
    stem = re.sub(r"\s+", " ", stem).strip(" -_") or "track"
    dest = f.with_name(stem + ".mp3")
    n = 2
    while dest.exists() and dest != f:
        dest = f.with_name(f"{stem}-{n}.mp3"); n += 1
    if dest != f:
        f.rename(dest)
        print(f"  {f.name}  ->  {dest.name}")
PY

echo
echo "==> $ok of ${#urls[@]} fetched. What is in $dest now:"
ls -lh "$dest" | tail -n +2 | awk '{printf "   %-52s %s\n", $9, $5}'
echo
echo "Next: python3 scripts/build_manifest.py   (then commit and push, or just say so)"
