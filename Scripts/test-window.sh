#!/usr/bin/env bash
# Native focus, window-order and hover regressions. Never loads a vault or user settings.
set -euo pipefail
cd "$(dirname "$0")/.."

swift build --target PaneKit
BIN="$(swift build --show-bin-path)"
mkdir -p .build/window-probe
swiftc -swift-version 6 -parse-as-library -I "$BIN/Modules" \
    Sources/Pane/PanePanel.swift Sources/Pane/AutoSizeBadge.swift \
    Scripts/window-probe.swift "$BIN"/PaneKit.build/*.o \
    -o .build/window-probe/window-probe
exec .build/window-probe/window-probe
