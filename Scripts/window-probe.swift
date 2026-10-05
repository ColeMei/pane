import AppKit
import PaneKit

/// Native window regressions. Creates only temporary panels; never loads settings or notes.
@main
@MainActor
struct WindowProbe {
    static var checked = 0
    static var failures = 0

    static func check(_ condition: Bool, _ message: String) {
        checked += 1
        if !condition {
            failures += 1
            print("✗ \(message)")
        }
    }

    static func settle() async {
        try? await Task.sleep(nanoseconds: 200_000_000)
    }

    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) {
            print("window-probe: timed out")
            exit(2)
        }
        Task { @MainActor in
            await run()
            print("\(failures == 0 ? "✓" : "✗") \(checked) native window assertions, \(failures) failures")
            exit(failures == 0 ? 0 : 1)
        }
        app.run()
    }

    static func run() async {
        guard let screen = NSScreen.main else {
            check(false, "a Window Server is required")
            return
        }
        let frame = CGRect(
            x: (screen.visibleFrame.minX + 40).rounded(),
            y: (screen.visibleFrame.minY + 80).rounded(),
            width: 460, height: 360
        )
        let pane = PanePanel()
        let content = NSView(frame: CGRect(origin: .zero, size: frame.size))
        content.wantsLayer = true
        content.layer?.backgroundColor = NSColor.textBackgroundColor.cgColor
        pane.contentView = content

        let cover = KeyPanel(
            contentRect: frame, styleMask: [.nonactivatingPanel, .borderless],
            backing: .buffered, defer: false
        )
        cover.backgroundColor = .windowBackgroundColor
        cover.isReleasedWhenClosed = false
        cover.level = .popUpMenu
        let badge = AutoSizeBadge()
        defer {
            badge.suppressDuringResize()
            cover.orderOut(nil)
            pane.orderOut(nil)
        }

        let frontmost = NSWorkspace.shared.frontmostApplication?.processIdentifier
        pane.summon(at: frame, pinned: false)
        await settle()
        check(pane.isKeyWindow, "summoning gives the pane keyboard focus")
        check(NSWorkspace.shared.frontmostApplication?.processIdentifier == frontmost,
              "summoning leaves the frontmost application alone")

        let center = CGPoint(x: frame.midX, y: frame.midY)
        let leftEdge = CGPoint(x: frame.minX + 40, y: frame.minY + 2)
        let rightEdge = CGPoint(x: frame.maxX - 40, y: frame.minY + 2)
        let outsideEdge = CGPoint(x: rightEdge.x, y: frame.minY - 10)
        check(pane.isExposed(near: center), "an unobstructed pane accepts hover")
        check(pane.isExposed(near: outsideEdge), "hover can approach an exposed edge from outside")
        check(AutoSizeBadge.isNearResizeEdge(outsideEdge, of: frame),
              "the outside resize margin is retained")

        cover.makeKeyAndOrderFront(nil)
        await settle()
        check(!pane.isKeyWindow, "another panel takes keyboard focus")
        check(!pane.isExposed(near: center), "a covered pane does not accept hover")
        check(!pane.isExposed(near: outsideEdge), "a covered edge does not accept outside hover")

        // Cover only the left part of the bottom edge: full-window occlusion alone cannot decide it.
        cover.setFrame(CGRect(x: frame.minX, y: frame.minY - 20, width: 180, height: 90), display: true)
        await settle()
        check(!pane.isExposed(near: leftEdge), "the covered part of the edge rejects hover")
        check(pane.isExposed(near: rightEdge), "the exposed part of the edge still accepts hover")
        check(!pane.isKeyWindow, "hover does not require the pane to have keyboard focus")

        cover.orderOut(nil)
        pane.summon(at: frame, pinned: false)
        await settle()
        check(pane.isKeyWindow, "summoning an already open, unfocused pane restores keyboard focus")
        check(pane.frame == frame, "refocusing does not park or move the pane")

        // Refocus must also raise the pane above a window at the same level.
        cover.level = pane.level
        cover.setFrame(frame, display: true)
        cover.makeKeyAndOrderFront(nil)
        await settle()
        check(!pane.isExposed(near: center), "a later window at the same level covers the pane")
        pane.summon(at: frame, pinned: true)
        await settle()
        check(pane.isKeyWindow && pane.isExposed(near: center),
              "a pinned pane can be brought back above another window")
        cover.orderOut(nil)

        check(SummonPolicy.shouldDismiss(
            isSummoned: pane.isSummoned, isKeyWindow: pane.isKeyWindow,
            dismissMode: .sameHotkeyToggles
        ), "a focused pinned pane can be dismissed by the global hotkey")
        pane.dismiss()
        check(!pane.isSummoned, "a pinned pane can be parked")
        pane.summon(at: frame, pinned: true)
        await settle()
        check(pane.isKeyWindow && pane.isExposed(near: center) && pane.level == .floating,
              "a dismissed pinned pane returns focused and floating")

        badge.update(near: pane, autoSizing: false, visible: true)
        await settle()
        guard let pill = pane.childWindows?.first else {
            check(false, "the badge belongs to the pane")
            return
        }
        check(pill.isVisible && pill.alphaValue > 0.9, "the badge appears for an exposed edge")
        check(pill.level == pane.level, "the badge follows the pane's window level")
        check(!pill.isKeyWindow && pane.isKeyWindow, "the badge does not steal keyboard focus")
        check(pill.frame.maxY < pane.frame.minY, "the badge sits below the pane")

        pane.showsOnEverySpace = false
        pane.isFloatingPanel = false
        pane.level = .normal
        badge.update(near: pane, autoSizing: true, visible: true)
        await settle()
        check(pill.collectionBehavior == pane.collectionBehavior,
              "the badge follows Keep on This Space")
        check(pill.level == .normal, "the badge stays with a lowered pane")
        let moved = pane.frame.offsetBy(dx: 20, dy: 20)
        pane.setFrame(moved, display: true)
        await settle()
        check(abs(pill.frame.midX - pane.frame.midX) <= 1,
              "moving the pane carries its badge with it")

        badge.hide()
        await settle()
        check(!pill.isVisible, "leaving the edge hides the badge")
        badge.update(near: pane, autoSizing: true, visible: true)
        await settle()
        check(pill.isVisible, "hovering again shows the badge")

        cover.level = .floating
        cover.setFrame(moved, display: true)
        cover.orderFrontRegardless()
        await settle()
        let edge = CGPoint(x: moved.midX, y: moved.minY + 2)
        badge.update(near: pane, autoSizing: true, visible: pane.isExposed(near: edge))
        await settle()
        check(!pill.isVisible, "covering the edge hides the badge without moving the pointer")

        pane.dismiss()
        check(!pane.isExposed(near: edge), "a parked pane rejects hover")
    }
}

@MainActor
private final class KeyPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}
