#!/usr/bin/env bash
# The markdown torture suite — an instrument, not a gate.
#
# `Scripts/test-editor.sh` is the gate: everything in it is behaviour we decided on, and red means a
# regression. This runs `Editor/tests/markdown.test.js`, which asserts what the editor *should* do
# against our locked decisions, then CommonMark, then Typora — so a red case here may be a bug
# nobody has decided to fix yet. It exits 0 either way, and writes the table to
# `markdown-findings.txt` so the divergences can be read beside the code.
#
# A case that gets fixed moves into `Editor/tests/commands.test.js`, where it becomes a gate.
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
