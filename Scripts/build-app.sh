#!/usr/bin/env bash
#
# Assembles Pane.app around the SwiftPM executable.
#
# There is no Xcode project on purpose — `swift build` works with only the Command Line Tools, so
# this script is the whole build. It compiles the editor bundle, compiles the Swift binary, lays out
# the bundle, and ad-hoc signs it (arm64 binaries must carry at least an ad-hoc signature to launch,
# and rewriting the bundle invalidates the signature SwiftPM applied).
#
#   Scripts/build-app.sh                 release build for the host architecture
#   Scripts/build-app.sh --debug         debug build, faster, for iterating
#   Scripts/build-app.sh --universal     arm64 + x86_64, for a release artifact
#   Scripts/build-app.sh --skip-editor   reuse the existing Editor/dist
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CONFIG=release
SKIP_EDITOR=0
ARCH_ARGS=()

while [[ $# -gt 0 ]]; do
	case "$1" in
		--debug)       CONFIG=debug ;;
		--release)     CONFIG=release ;;
		--universal)   ARCH_ARGS=(--arch arm64 --arch x86_64) ;;
		--skip-editor) SKIP_EDITOR=1 ;;
		-h|--help)     sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
		*)             echo "unknown flag: $1" >&2; exit 2 ;;
	esac
	shift
done

VERSION="${PANE_VERSION:-0.1.0}"
BUILD_NUMBER="${PANE_BUILD:-$(git rev-list --count HEAD 2>/dev/null || echo 1)}"

APP="$ROOT/build/Pane.app"
CONTENTS="$APP/Contents"

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }

# ---- 1. editor bundle -------------------------------------------------------------------------
if [[ "$SKIP_EDITOR" -eq 0 ]]; then
	say "Building editor bundle"
	if [[ ! -d "$ROOT/Editor/node_modules" ]]; then
		( cd "$ROOT/Editor" && npm ci --no-audit --no-fund )
	fi
	( cd "$ROOT/Editor" && npm run build )
fi

if [[ ! -f "$ROOT/Editor/dist/index.html" ]]; then
	echo "error: Editor/dist/index.html is missing — run without --skip-editor" >&2
	exit 1
fi

# ---- 2. swift binary --------------------------------------------------------------------------
say "Building Pane ($CONFIG${ARCH_ARGS:+, universal})"
swift build -c "$CONFIG" "${ARCH_ARGS[@]}" --product Pane

BIN="$(swift build -c "$CONFIG" "${ARCH_ARGS[@]}" --product Pane --show-bin-path)/Pane"
[[ -f "$BIN" ]] || { echo "error: binary not found at $BIN" >&2; exit 1; }

# ---- 3. bundle layout -------------------------------------------------------------------------
say "Assembling $APP"
rm -rf "$APP"
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources"

cp "$BIN" "$CONTENTS/MacOS/Pane"
cp -R "$ROOT/Editor/dist/." "$CONTENTS/Resources/Editor/"

# Static bundle resources — currently the menu bar template images. Flat rather than in a
# subdirectory because `NSImage(named:)` only searches the top level of Resources, and going through
# a subdirectory would mean loading them by path and losing the automatic @2x/@3x selection.
if [[ -d "$ROOT/Resources" ]]; then
	cp -R "$ROOT/Resources/." "$CONTENTS/Resources/"
fi

sed -e "s/__VERSION__/$VERSION/" -e "s/__BUILD__/$BUILD_NUMBER/" \
	"$ROOT/Scripts/Info.plist" > "$CONTENTS/Info.plist"

printf 'APPL????' > "$CONTENTS/PkgInfo"

if [[ -f "$ROOT/Scripts/AppIcon.icns" ]]; then
	cp "$ROOT/Scripts/AppIcon.icns" "$CONTENTS/Resources/AppIcon.icns"
	/usr/libexec/PlistBuddy -c "Add :CFBundleIconFile string AppIcon" "$CONTENTS/Info.plist" >/dev/null
fi

# ---- 4. signature -----------------------------------------------------------------------------
# Ad-hoc only. Pane ships unsigned by design (no Developer ID), which is documented in the README —
# but an arm64 Mach-O with no signature at all will not launch, so this is not optional.
say "Ad-hoc signing"
codesign --force --sign - --timestamp=none "$APP"
codesign --verify --deep --strict "$APP"

say "Built $APP ($VERSION build $BUILD_NUMBER)"
