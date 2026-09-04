#!/usr/bin/env bash
# The tooltip's timing: how long the pointer has to rest before a control is named.
#
# Separate from the switcher's suite because the question is time rather than geometry — every case
# here waits out a real timer, which is why its `run` is async and the probe awaits it.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "${1:-}" != "--skip-editor" ]]; then
	echo "==> Building the editor bundle"
	(cd Editor && node build.mjs >/dev/null)
fi

echo "==> Running the tooltip suite"
exec swift Scripts/editor-probe.swift "$PWD/Editor/dist/index.html" "$PWD/Editor/tests/tooltip.test.js"
