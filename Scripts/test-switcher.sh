#!/usr/bin/env bash
# The switcher's geometry: where the arrow keys actually put things on screen.
#
# The third suite on `Scripts/editor-probe.swift`, alongside the command matrix and the markdown
# suite. It exists because the switcher's bugs are geometric — a row can be selected, ordered and
# rendered correctly and still be sitting under a gradient — and only a real WKWebView has rectangles
# to measure.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "${1:-}" != "--skip-editor" ]]; then
	echo "==> Building the editor bundle"
	(cd Editor && node build.mjs >/dev/null)
fi

echo "==> Running the switcher suite"
exec swift Scripts/editor-probe.swift "$PWD/Editor/dist/index.html" "$PWD/Editor/tests/switcher.test.js"
