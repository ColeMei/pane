import AppKit
import PaneKit

/// The little "⇕ Auto-size" pill that appears under the pane when the pointer nears a resize edge.
///
/// Lifted from Raycast Notes, and it earns its place for a reason particular to decision 40: a drag
/// **silently turns auto-sizing off**. That is the right behaviour — stating a height can only mean
/// "stop resizing my window" — but a mode that changes without being asked has to say so somewhere,
/// or the pane simply stops following the note one day and nothing ever explains why. The pill says
/// it at exactly the moment it is about to happen: when you reach for the edge.
///
/// Its own window, because it hangs *below* the pane. The pane is a web view that cannot paint
/// outside its own frame — the same constraint that made the format bar's heading menu a real
/// `NSMenu` — so anything drawn past the bottom edge has to be a separate window.
@MainActor
final class AutoSizeBadge {

    /// How close to an edge counts as reaching for it. Wider than the 4 pt resize margin itself,
    /// so the pill arrives *before* the cursor changes shape rather than at the same moment.
    static let edgeProximity: CGFloat = 16

    /// Gap between the pane's bottom edge and the pill.
    private static let offset: CGFloat = 10

    private let panel: NSPanel
    private let label: NSTextField

    private var isShowing = false

    init() {
        panel = NSPanel(
            contentRect: .zero,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: true
        )
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = .floating
        panel.ignoresMouseEvents = true
        panel.isReleasedWhenClosed = false
        // Same rule as the pane (decision 33): it must show up on whatever Space the pane is on.
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]

        let background = NSVisualEffectView()
        background.material = .popover
        background.blendingMode = .behindWindow
        // Pinned rather than following the window's active state — the pane is in use precisely
        // when the app is *not* frontmost, which is the whole premise (decision 9).
        background.state = .active
        background.wantsLayer = true
        background.layer?.cornerRadius = 13
        background.layer?.masksToBounds = true

        label = NSTextField(labelWithString: "")
        label.font = .systemFont(ofSize: 12, weight: .medium)
        label.textColor = .labelColor
        label.alignment = .center
        label.translatesAutoresizingMaskIntoConstraints = false

        background.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerYAnchor.constraint(equalTo: background.centerYAnchor),
            label.leadingAnchor.constraint(equalTo: background.leadingAnchor, constant: 14),
            label.trailingAnchor.constraint(equalTo: background.trailingAnchor, constant: -14),
        ])

        panel.contentView = background
    }

    /// Shows the pill under `paneFrame`, or hides it.
    ///
    /// - Parameter autoSizing: what the pill should say. Both states are worth showing: near the
    ///   edge with auto-sizing on it warns that dragging will end it, and with auto-sizing off it
    ///   explains why the pane stopped following the note.
    func update(near paneFrame: CGRect, autoSizing: Bool, visible: Bool) {
        guard visible else {
            hide()
            return
        }

        label.stringValue = autoSizing ? "⇕  Auto-size" : "⇕  Auto-size off"
        let size = CGSize(width: label.intrinsicContentSize.width + 28, height: 26)
        let origin = CGPoint(
            x: (paneFrame.midX - size.width / 2).rounded(),
            y: (paneFrame.minY - size.height - Self.offset).rounded()
        )
        panel.setFrame(CGRect(origin: origin, size: size), display: true)

        guard !isShowing else { return }
        isShowing = true
        panel.alphaValue = 0
        panel.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.12
            panel.animator().alphaValue = 1
        }
    }

    func hide() {
        guard isShowing else { return }
        isShowing = false
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.12
            panel.animator().alphaValue = 0
        } completionHandler: { [weak self] in
            MainActor.assumeIsolated {
                // Guarded: `update` may have brought it back during the fade.
                guard let self, !self.isShowing else { return }
                self.panel.orderOut(nil)
            }
        }
    }

    /// Whether `point` is within `edgeProximity` of the pane's bottom edge or bottom corners.
    ///
    /// Bottom only. The top edge is the title bar — reaching for it means dragging the window, not
    /// resizing it — and the sides only change width, which is fixed (decision 22's measure).
    static func isNearResizeEdge(_ point: CGPoint, of frame: CGRect) -> Bool {
        let band = frame.insetBy(dx: -edgeProximity, dy: -edgeProximity)
        guard band.contains(point) else { return false }
        return point.y <= frame.minY + edgeProximity
    }
}
