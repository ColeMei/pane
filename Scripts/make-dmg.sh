#!/usr/bin/env bash
#
# Packages an already-built Pane.app into a distributable disk image.
#
# The disk image is what a person downloads; the Homebrew cask reads the same file. It exists
# because a .zip leaves Pane.app sitting in ~/Downloads and every instruction Pane prints says
# /Applications — a window with an Applications alias in it makes the move obvious instead of
# assumed. It does nothing about Gatekeeper: Pane is unsigned either way, and the quarantine flag
# still has to be cleared once. See the README.
#
#   Scripts/make-dmg.sh                      packages build/Pane.app
#   Scripts/make-dmg.sh path/to/Pane.app     packages that bundle instead
#
# The version comes from the bundle's Info.plist, not from a flag, so the image cannot end up
# named for a different build than the one inside it.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

APP="${1:-$ROOT/build/Pane.app}"
[[ -d "$APP" ]] || { echo "error: no app bundle at $APP" >&2; exit 1; }

VERSION="$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$APP/Contents/Info.plist")"
DMG="$ROOT/build/Pane-$VERSION.dmg"

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }

# A release bundle must not be stamped as a scratch build — same guard as the release workflow, here
# too because this script is the last thing to touch the bundle before somebody downloads it.
if /usr/libexec/PlistBuddy -c "Print :PaneScratchBuild" "$APP/Contents/Info.plist" >/dev/null 2>&1; then
	echo "error: $APP is a scratch build (PaneScratchBuild is set) — rebuild without --debug" >&2
	exit 1
fi

# dmgbuild, from hash-pinned requirements, in a venv of its own under build/ — so the tool that packs
# the download is the same on every machine and never touches the system Python.
VENV="$ROOT/build/.dmgbuild-venv"
REQS="$ROOT/packaging/dmg/requirements.txt"
if [[ ! -x "$VENV/bin/dmgbuild" || "$REQS" -nt "$VENV/bin/dmgbuild" ]]; then
	say "Installing dmgbuild"
	rm -rf "$VENV"
	python3 -m venv "$VENV"
	"$VENV/bin/pip" install --quiet --disable-pip-version-check --require-hashes --no-deps -r "$REQS"
fi

# The window: background art, icon positions, no toolbar or sidebar — packaging/dmg/settings.py.
# dmgbuild copies the bundle with the extended attributes and the ad-hoc signature intact, and writes
# the window's .DS_Store itself, without driving Finder.
say "Building $DMG"
rm -f "$DMG"
"$VENV/bin/dmgbuild" \
	-s "$ROOT/packaging/dmg/settings.py" \
	-D app="$APP" \
	-D background="$ROOT/packaging/dmg/background.png" \
	"Pane" \
	"$DMG"

say "Built $DMG ($VERSION, $(du -h "$DMG" | cut -f1))"
