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

    /// Tallest the pane may be, and the reason is decision 83's own argument arriving on the other
    /// axis.
    ///
    /// "No maximum height" was decided while every display in view was wider than it was tall, so
    /// the screen was the ceiling and the screen was a sensible one. A **portrait** display breaks
    /// that: on a rotated 1080×1920 the pane could grow past 1890pt, which is not more note in any
    /// useful sense — it is one column of text taller than any reader's eye travels, on a pane whose
    /// content measure is 680.
    ///
    /// Derived rather than picked (decision 82): `maximumWidth` × √2, the A-series page ratio, so
    /// the widest allowed pane at its tallest is exactly a page. That lands at 1024, which is above
    /// the usable height of every landscape display the project has met — so this cap **only ever
    /// bites on a tall screen**, which is the case that had no answer.
    public static let maximumHeight: CGFloat = (maximumWidth * 1.41421356).rounded()

    /// Width into its allowed range.
    public static func constrainWidth(_ width: CGFloat) -> CGFloat {
        min(max(width, minimumWidth), maximumWidth)
    }

    /// Height into its allowed range. The screen still constrains it further — see `maxHeight`.
    public static func constrainHeight(_ height: CGFloat) -> CGFloat {
        min(max(height, minimumHeight), maximumHeight)
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
    ///
    /// Two ceilings, whichever is lower: the screen's, and `maximumHeight`. The screen's alone was
    /// the whole rule until a portrait display made it a very poor one.
    public static func maxHeight(topY: CGFloat, visibleFrame: CGRect) -> CGFloat {
        let toScreenEdge = topY - (visibleFrame.minY + bottomMargin)
        return max(minimumHeight, min(maximumHeight, toScreenEdge))
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
        let h = min(constrainHeight(frame.height), visibleFrame.height - bottomMargin)

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
    ///
    /// `lastSize` is what a display the pane has **never** been used on inherits: the size the user
    /// last chose, anywhere. Without it a new monitor means a first-launch pane, which is a size
    /// nobody picked — and while the display key was unstable, that was the size you got every time
    /// a monitor was switched off and on again.
    public static func restore(
        remembered: CGRect?,
        lastSize: CGSize? = nil,
        titleBarHeight: CGFloat,
        screens: [CGRect],
        activeVisibleFrame: CGRect,
        defaultWidth: CGFloat,
        defaultHeight: CGFloat
    ) -> CGRect {
        guard let remembered, !remembered.isEmpty else {
            return firstLaunchFrame(
                width: constrainWidth(lastSize?.width ?? defaultWidth),
                height: lastSize?.height ?? defaultHeight,
                visibleFrame: activeVisibleFrame
            )
        }
        if isReachable(remembered, titleBarHeight: titleBarHeight, onAnyOf: screens) {
            // Size still gets clamped: a frame remembered before a cap existed, or from a larger
            // display, would otherwise come back bigger than the pane is now allowed to be.
            let width = constrainWidth(remembered.width)
            let height = constrainHeight(remembered.height)
            guard width != remembered.width || height != remembered.height else { return remembered }
            // Anchored by the top edge, which is the edge the user reaches for.
            return CGRect(
                x: remembered.minX,
                y: remembered.maxY - height,
                width: width,
                height: height
            )
        }
        return clamped(remembered, into: activeVisibleFrame)
    }

    // MARK: - Remembering, per display

    /// The key a pane's remembered frame is filed under.
    ///
    /// **`uuid` must be the display's persistent UUID, never its `CGDirectDisplayID`.** The ID was
    /// the key until v0.6.5, on the written assumption that it "survives sleep and resolution
    /// changes". It does not: measured on a two-monitor Mac 2026-09-10, one power cycle of both
    /// monitors moved them from 53 and 54 to 59 and 58 — a new number, a new key, and a pane that
    /// came back at its first-launch size because nothing was filed under the new one. That
    /// `state.json` had **56 entries for two monitors**, every one of them orphaned. The UUIDs were
    /// byte-identical across the same power cycle.
    ///
    /// The size is still appended, so swapping a monitor for a different one at the same port
    /// cannot inherit a frame sized for the old panel.
    public static func displayKey(uuid: String, width: CGFloat, height: CGFloat) -> String {
        "\(uuid)-\(Int(width))x\(Int(height))"
    }

    /// Whether a key was written by a build that filed frames under the display ID.
    ///
    /// Those keys can never match again — the ID they name is gone the moment a display is power
    /// cycled — so they are dead weight that grows without bound. A legacy key is one whose first
    /// segment is all digits; a UUID's never is.
    public static func isLegacyDisplayKey(_ key: String) -> Bool {
        guard let head = key.split(separator: "-").first, !head.isEmpty else { return false }
        return head.allSatisfy(\.isNumber)
    }
}
