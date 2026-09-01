#!/usr/bin/env bash
# The markdown suite: what a person typing markdown gets.
#
# The companion to `Scripts/test-editor.sh`, and the other half of the same job. That one drives the
# **commands** — eleven of them against every shape of selection. This one drives the **keyboard**:
# every case is a keystroke script, and every nested list in it is built the way a person builds one.
#
# Run both before tagging. This one also writes its table to `markdown-findings.txt`.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "${1:-}" != "--skip-editor" ]]; then
	echo "==> Building the editor bundle"
	(cd Editor && node build.mjs >/dev/null)
fi

echo "==> Running the markdown suite"
swift Scripts/editor-probe.swift \
	"$PWD/Editor/dist/index.html" \
	"$PWD/Editor/tests/markdown.test.js" | tee markdown-findings.txt
echo "==> Table written to markdown-findings.txt"
