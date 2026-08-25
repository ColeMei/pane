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
STAGE="$ROOT/build/dmg-staging"

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }

# A release bundle must not be stamped as a scratch build — same guard as the release workflow, here
# too because this script is the last thing to touch the bundle before somebody downloads it.
if /usr/libexec/PlistBuddy -c "Print :PaneScratchBuild" "$APP/Contents/Info.plist" >/dev/null 2>&1; then
	echo "error: $APP is a scratch build (PaneScratchBuild is set) — rebuild without --debug" >&2
	exit 1
fi

say "Staging"
rm -rf "$STAGE" "$DMG"
mkdir -p "$STAGE"
# ditto, not cp -R: it preserves the extended attributes and the ad-hoc signature. A bundle copied
# with cp -R fails `codesign --verify` on the other end, which on an already-unsigned app reads to
# the user as a corrupt download.
ditto "$APP" "$STAGE/Pane.app"
ln -s /Applications "$STAGE/Applications"

# No custom window layout, background image or icon positions. Setting those means driving Finder
# over AppleScript, which needs a real GUI session and Automation consent — neither of which a CI
# runner reliably has, and a release step that works on one machine is not a release step.
say "Building $DMG"
hdiutil create \
	-volname "Pane" \
	-srcfolder "$STAGE" \
	-fs HFS+ \
	-format UDZO \
	-quiet \
	"$DMG"

rm -rf "$STAGE"

say "Built $DMG ($VERSION, $(du -h "$DMG" | cut -f1))"
