#!/usr/bin/env bash
# The editor's own tests: the formatting commands, against the real parser in a real WKWebView.
#
# Separate from Scripts/test.sh because that one is pure Foundation and runs anywhere `swift build`
# does. This needs a window server and the built web bundle, so it is its own command — but it is
# the one that covers the layer every editor bug in this project has come from.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "${1:-}" != "--skip-editor" ]]; then
	echo "==> Building the editor bundle"
	(cd Editor && node build.mjs >/dev/null)
fi

echo "==> Running the command matrix"
exec swift Scripts/editor-probe.swift "$PWD/Editor/dist/index.html" "$PWD/Editor/tests/commands.test.js"
