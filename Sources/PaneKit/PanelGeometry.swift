import CoreGraphics
import Foundation

/// The arithmetic behind the design's pane behaviour rules (design frame 1g), kept free of AppKit so
/// it can be tested without a window server — which matters, because the failure mode these rules
/// exist to prevent is a pane restored somewhere the user cannot reach it, and that is not a thing
/// you want to discover by hand on a second monitor.
///
/// Everything here is in AppKit screen coordinates: **origin bottom-left, y increasing upward**.
/// That inversion is the whole reason "height grows downward" is not a one-liner — growing downward
/// means the origin moves *down* while `maxY` stays put.
public enum PanelGeometry {

    /// Gap the pane keeps from the bottom of the screen before it stops growing and scrolls instead.
    public static let bottomMargin: CGFloat = 24

    /// How tall a pane has to be for an overlay of this height to sit in it properly.
    ///
    /// The web layer places the switcher and ⌘K at 15% of the pane's height (`overlay.ts`). On a
    /// pane that is already tall enough that lands where the reference draws it. On one that is not,
    /// the pane grows — and growing it to exactly `54 + panel + 16` made the two rules disagree in
    /// the one case the panel is the whole point: the panel came up jammed against the bottom edge
    /// with a fifth of the pane empty above it, because 54 is a *floor* for the offset and not a
    /// design. Growing to `panel / 0.75` gives a pane whose 15%-and-10% margins the panel actually
    /// fits between, so a grown pane looks like a tall one rather than like a shrink-wrap.
    ///
    /// The floor is still there for a short panel, where the proportional answer would be tighter
    /// than the minimum margins.
    public static func paneHeight(forOverlay panelHeight: CGFloat) -> CGFloat {
        let proportional = panelHeight / 0.75
        let minimum = overlayTopMinimum + panelHeight + overlayBottomMinimum
        return (proportional > minimum ? proportional : minimum).rounded()
    }

    /// Mirrors `--overlay-top-min` and `--overlay-gap-bottom` in tokens.css. Swift cannot read the
    /// stylesheet, so these two have to move together with it.
    public static let overlayTopMinimum: CGFloat = 54
    public static let overlayBottomMinimum: CGFloat = 16

    /// Fraction of the visible height left above the pane on first launch. Puts the pane in the top
    /// third, at roughly Spotlight's height — the position the muscle memory this product is
    /// competing with already expects.
    public static let firstLaunchTopInsetFraction: CGFloat = 0.22

    /// Smallest pane worth showing: title bar, one line, footer.
    public static let minimumHeight: CGFloat = 120

    /// Widest the pane may be dragged, and the reason is decision 22's own.
    ///
    /// The content has a measure — `--content-measure`, 680px — because long lines are hard to
    /// read, so past that point a wider pane buys **gutters, not longer lines**. It was unbounded,
    /// which meant the pane could be dragged to fill a display and show the same column of text
    /// with several hundred points of empty material either side of it.
    ///
    /// 680 plus the content padding, so the widest useful pane is exactly the one where the measure
    /// touches both edges. The reference caps its width too, and leaves height alone — height is the
    /// axis that actually carries more note.
    public static let maximumWidth: CGFloat = 724

    /// Narrowest the pane may be. Below this the title bar's buttons and the footer's centred word
    /// count start overlapping each other.
    public static let minimumWidth: CGFloat = 320

    /// Width into its allowed range. **Height deliberately has no equivalent**: a taller pane is
    /// simply more note, which is the thing the pane is for, so it keeps a floor and no ceiling —
    /// auto-sizing already stops `bottomMargin` short of the screen edge, and a drag may go past it.
    public static func constrainWidth(_ width: CGFloat) -> CGFloat {
        min(max(width, minimumWidth), maximumWidth)
    }

    /// How much of the title bar has to remain on a screen for the pane to count as reachable.
    /// Enough to grab and drag, and to hit the close dot.
    public static let minimumReachableWidth: CGFloat = 120

    // MARK: - First launch

    /// Where a pane goes when there is no remembered frame: horizontally centred, top third.
    public static func firstLaunchFrame(
        width: CGFloat,
        height: CGFloat,
        visibleFrame: CGRect
    ) -> CGRect {
        let topY = visibleFrame.maxY - visibleFrame.height * firstLaunchTopInsetFraction
        let h = min(max(height, minimumHeight), maxHeight(topY: topY, visibleFrame: visibleFrame))
        let x = visibleFrame.midX - width / 2
        return CGRect(x: x.rounded(), y: (topY - h).rounded(), width: width, height: h.rounded())
    }

    // MARK: - Growth

    /// Tallest the pane may be with its top edge at `topY`, given the screen it is on.
    public static func maxHeight(topY: CGFloat, visibleFrame: CGRect) -> CGFloat {
        max(minimumHeight, topY - (visibleFrame.minY + bottomMargin))
    }

    public struct Growth: Equatable, Sendable {
        public let frame: CGRect
        /// True when the content no longer fits and the note has to scroll inside the pane.
        public let scrolls: Bool
    }

    /// Resizes a pane to fit its content, anchored by its top edge.
    ///
    /// Width never changes — that is the point of a fixed measure. Height follows the content down
    /// until the pane is `bottomMargin` from the bottom of the screen, and after that the note
    /// scrolls inside a pane that has stopped moving. Deleting text shrinks it back, so the pane is
    /// always exactly as big as what is in it.
    public static func grown(
        from current: CGRect,
        toContentHeight desired: CGFloat,
        visibleFrame: CGRect
    ) -> Growth {
        let topY = current.maxY
        let cap = maxHeight(topY: topY, visibleFrame: visibleFrame)
        let h = min(max(desired, minimumHeight), cap)
        let frame = CGRect(x: current.minX, y: (topY - h).rounded(), width: current.width, height: h.rounded())
        return Growth(frame: frame, scrolls: desired > cap + 0.5)
    }

    // MARK: - Display changes

    /// Whether enough of the pane's title bar is on some screen for the user to grab it.
    ///
    /// The test is deliberately about the *title bar*, not the pane as a whole: a pane whose body
    /// spills off the bottom of a screen is merely untidy, but a pane whose title bar is off-screen
    /// cannot be moved, closed, or pinned, and to the user it has simply vanished.
    public static func isReachable(
        _ frame: CGRect,
        titleBarHeight: CGFloat,
        onAnyOf visibleFrames: [CGRect]
    ) -> Bool {
        let titleBar = CGRect(
            x: frame.minX,
            y: frame.maxY - titleBarHeight,
            width: frame.width,
            height: titleBarHeight
        )
        return visibleFrames.contains { screen in
            let overlap = screen.intersection(titleBar)
            return !overlap.isNull
                && overlap.width >= minimumReachableWidth
                && overlap.height >= titleBarHeight / 2
        }
    }

    /// Brings a pane back onto the active display by the shortest move that works.
    ///
    /// Called when a remembered frame lands on a screen that is no longer connected — the laptop
    /// left the desk, the external monitor changed resolution. The pane keeps its size where it can
    /// and only shrinks if it no longer fits, because size is something the user chose.
    public static func clamped(_ frame: CGRect, into visibleFrame: CGRect) -> CGRect {
        let w = min(constrainWidth(frame.width), visibleFrame.width)
        let h = min(max(frame.height, minimumHeight), visibleFrame.height - bottomMargin)

        // Horizontal: pull inside, favouring the left edge when the pane is wider than the screen.
        var x = min(frame.minX, visibleFrame.maxX - w)
        x = max(x, visibleFrame.minX)

        // Vertical: the top edge is what the user reaches for, so clamp maxY and derive the origin.
        // `h` is already capped at `visibleFrame.height - bottomMargin`, so the lower bound below can
        // never exceed the upper one.
        var top = min(frame.maxY, visibleFrame.maxY)
        top = max(top, visibleFrame.minY + bottomMargin + h)

        return CGRect(x: x.rounded(), y: (top - h).rounded(), width: w.rounded(), height: h.rounded())
    }

    /// The frame to actually use when restoring a remembered pane.
    ///
    /// Returns the remembered frame untouched when it is still reachable — "stay put" is a rule, and
    /// a pane that quietly re-centres itself every time a monitor is plugged in has broken it. Only
    /// when the frame is unreachable on every connected screen does it move, and then onto the
    /// active display.
    public static func restore(
        remembered: CGRect?,
        titleBarHeight: CGFloat,
        screens: [CGRect],
        activeVisibleFrame: CGRect,
        defaultWidth: CGFloat,
        defaultHeight: CGFloat
    ) -> CGRect {
        guard let remembered, !remembered.isEmpty else {
            return firstLaunchFrame(
                width: defaultWidth,
                height: defaultHeight,
                visibleFrame: activeVisibleFrame
            )
        }
        if isReachable(remembered, titleBarHeight: titleBarHeight, onAnyOf: screens) {
            // Width still gets clamped: a frame remembered before the cap existed, or from a wider
            // display, would otherwise come back wider than the pane is now allowed to be.
            let width = constrainWidth(remembered.width)
            guard width != remembered.width else { return remembered }
            return CGRect(x: remembered.minX, y: remembered.minY, width: width, height: remembered.height)
        }
        return clamped(remembered, into: activeVisibleFrame)
    }
}
