#!/usr/bin/env bash
# Every gate, in one run: the PaneKit suite, the typecheck, the keyboard tables, and the four
# WKWebView suites against one build of the editor bundle. What CI runs, runnable here.
set -uo pipefail
cd "$(dirname "$0")/.."

status=0
step() { echo; echo "==> $1"; shift; "$@" || { status=1; echo "✗ FAILED: $*"; }; }

step "PaneKit"            Scripts/test.sh
step "Typecheck"          bash -c 'cd Editor && npm run --silent typecheck'
step "Keyboard tables"    Scripts/test-keyboard.sh
step "Editor bundle"      bash -c 'cd Editor && node build.mjs >/dev/null'
step "Command matrix"     Scripts/test-editor.sh --skip-editor
step "Markdown"           Scripts/test-markdown.sh --skip-editor
step "Switcher"           Scripts/test-switcher.sh --skip-editor
step "Tooltip"            Scripts/test-tooltip.sh --skip-editor

echo
[[ $status -eq 0 ]] && echo "✓ every suite green" || echo "✗ at least one suite failed"
exit $status
