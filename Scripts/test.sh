#!/usr/bin/env bash
#
# Runs the PaneKit suite.
#
# Not `swift test`: neither XCTest nor swift-testing ships with the Command Line Tools, so the
# standard runner needs a full Xcode install. The suite is an ordinary executable instead, which
# means a fresh checkout can be tested with nothing but the toolchain that builds the app.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

exec swift run "$@" PaneKitTests
