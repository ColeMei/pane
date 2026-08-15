import AppKit
import PaneKit

// Placeholder entry point. The real AppKit shell — non-activating panel, ⌃⌥Space hotkey, menu bar
// item, editor web view — lands next; this exists so the package builds and PaneKit stays testable
// while it does.
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
