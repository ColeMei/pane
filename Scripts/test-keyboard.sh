#!/usr/bin/env bash
# The keyboard tables, in plain node — what ⌫ ⏎ ⇧⏎ ⇥ ↑↓ ⌦ decide for a document
# and a caret. Milliseconds, no window. The markdown suite remains the gate for what is drawn.
set -euo pipefail
cd "$(dirname "$0")/.."
echo "==> Running the keyboard tables"
(cd Editor && node tests/unit/run.mjs)
