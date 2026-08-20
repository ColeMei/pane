import CoreGraphics
import Foundation
import PaneKit

/// A 1512×982 display with the menu bar taken off the top — the built-in screen on a 14" MacBook Pro.
private let builtIn = CGRect(x: 0, y: 0, width: 1512, height: 945)

/// A second display sitting to the right of it.
private let external = CGRect(x: 1512, y: 0, width: 2560, height: 1415)

private let titleBar: CGFloat = 40
private let paneWidth: CGFloat = 692

func runPanelGeometryTests() {
    Check.suite("Pane geometry") {

        // MARK: - Rule 1, Summon

        Check.test("first launch centres horizontally in the top third") {
            let f = PanelGeometry.firstLaunchFrame(
                width: paneWidth, height: 400, visibleFrame: builtIn
            )
            Check.equal(f.width, paneWidth)
            Check.equal(f.midX, builtIn.midX, "horizontally centred")
            Check.expect(f.maxY < builtIn.maxY, "leaves a gap above")
            Check.expect(f.maxY > builtIn.midY, "sits in the upper half")
        }

        Check.test("first launch on a short screen still leaves the bottom margin") {
            let tiny = CGRect(x: 0, y: 0, width: 1280, height: 400)
            let f = PanelGeometry.firstLaunchFrame(width: 692, height: 900, visibleFrame: tiny)
            Check.expect(
                f.minY >= tiny.minY + PanelGeometry.bottomMargin - 1,
                "bottom margin honoured, got minY \(f.minY)"
            )
        }

        // MARK: - Rule 2, Grow

        Check.test("height grows downward with the top edge pinned") {
            let start = CGRect(x: 100, y: 600, width: paneWidth, height: 200)
            let grown = PanelGeometry.grown(from: start, toContentHeight: 320, visibleFrame: builtIn)
            Check.equal(grown.frame.maxY, start.maxY, "top edge must not move")
            Check.equal(grown.frame.height, 320)
            Check.equal(grown.frame.minY, start.maxY - 320, "origin moves down, not up")
            Check.equal(grown.frame.width, paneWidth, "width never changes")
            Check.expect(!grown.scrolls)
        }

        Check.test("deleting text shrinks the pane back, still from the top") {
            let start = CGRect(x: 100, y: 400, width: paneWidth, height: 400)
            let shrunk = PanelGeometry.grown(from: start, toContentHeight: 180, visibleFrame: builtIn)
            Check.equal(shrunk.frame.maxY, start.maxY)
            Check.equal(shrunk.frame.height, 180)
        }

        Check.test("growth stops 24px from the bottom and the note scrolls instead") {
            // Top edge near the top of the screen, content far taller than the screen.
            let start = CGRect(x: 100, y: 800, width: paneWidth, height: 100)
            let grown = PanelGeometry.grown(from: start, toContentHeight: 5000, visibleFrame: builtIn)
            Check.equal(grown.frame.maxY, start.maxY, "top edge still pinned")
            Check.equal(
                grown.frame.minY,
                builtIn.minY + PanelGeometry.bottomMargin,
                "stops exactly at the bottom margin"
            )
            Check.expect(grown.scrolls, "content that does not fit must scroll")
        }

        Check.test("never shrinks below a usable minimum") {
            let start = CGRect(x: 100, y: 600, width: paneWidth, height: 300)
            let grown = PanelGeometry.grown(from: start, toContentHeight: 10, visibleFrame: builtIn)
            Check.equal(grown.frame.height, PanelGeometry.minimumHeight)
        }

        // MARK: - Rule 3 and 4, Stay put / display change

        Check.test("a frame still on a connected screen is restored untouched") {
            let remembered = CGRect(x: 1800, y: 900, width: paneWidth, height: 400)
            let restored = PanelGeometry.restore(
                remembered: remembered,
                titleBarHeight: titleBar,
                screens: [builtIn, external],
                activeVisibleFrame: builtIn,
                defaultWidth: paneWidth,
                defaultHeight: 400
            )
            Check.equal(restored, remembered, "stay put means stay put")
        }

        Check.test("a frame on a screen that went away comes back to the active display") {
            // Remembered on the external monitor, which is no longer connected.
            let remembered = CGRect(x: 3000, y: 1100, width: paneWidth, height: 400)
            let restored = PanelGeometry.restore(
                remembered: remembered,
                titleBarHeight: titleBar,
                screens: [builtIn],
                activeVisibleFrame: builtIn,
                defaultWidth: paneWidth,
                defaultHeight: 400
            )
            Check.expect(
                PanelGeometry.isReachable(restored, titleBarHeight: titleBar, onAnyOf: [builtIn]),
                "restored frame must be reachable, got \(restored)"
            )
            Check.expect(builtIn.contains(restored), "and fully on screen, got \(restored)")
        }

        Check.test("a pane whose title bar is off the top is unreachable") {
            let offTop = CGRect(x: 100, y: builtIn.maxY - 10, width: paneWidth, height: 400)
            Check.expect(
                !PanelGeometry.isReachable(offTop, titleBarHeight: titleBar, onAnyOf: [builtIn]),
                "title bar above the screen is not grabbable"
            )
        }

        Check.test("a pane hanging off the bottom is untidy but still reachable") {
            // Body spills below the screen; the title bar is fully visible, so don't move it.
            let hanging = CGRect(x: 100, y: -300, width: paneWidth, height: 500)
            Check.expect(
                PanelGeometry.isReachable(hanging, titleBarHeight: titleBar, onAnyOf: [builtIn]),
                "only the title bar decides reachability"
            )
        }

        Check.test("a sliver left on screen is not enough to count as reachable") {
            let sliver = CGRect(
                x: builtIn.maxX - 40, y: 700, width: paneWidth, height: 400
            )
            Check.expect(
                !PanelGeometry.isReachable(sliver, titleBarHeight: titleBar, onAnyOf: [builtIn]),
                "40px of title bar is not a handle"
            )
        }

        Check.test("no remembered frame at all falls back to first launch placement") {
            let restored = PanelGeometry.restore(
                remembered: nil,
                titleBarHeight: titleBar,
                screens: [builtIn],
                activeVisibleFrame: builtIn,
                defaultWidth: paneWidth,
                defaultHeight: 400
            )
            Check.equal(
                restored,
                PanelGeometry.firstLaunchFrame(width: paneWidth, height: 400, visibleFrame: builtIn)
            )
        }

        Check.test("a pane grown for an overlay leaves room above and below it") {
            let panel: CGFloat = 507   // ⌘K at fourteen rows
            let pane = PanelGeometry.paneHeight(forOverlay: panel)
            let top = pane * 0.15
            Check.expect(top >= PanelGeometry.overlayTopMinimum, "top \(top)")
            Check.expect(
                pane - top - panel >= PanelGeometry.overlayBottomMinimum,
                "bottom gap \(pane - top - panel)"
            )
        }

        Check.test("a short overlay still gets the minimum margins rather than a smaller pane") {
            let panel: CGFloat = 100
            Check.equal(
                PanelGeometry.paneHeight(forOverlay: panel),
                PanelGeometry.overlayTopMinimum + panel + PanelGeometry.overlayBottomMinimum
            )
        }

        Check.test("a pane wider or taller than the new display is shrunk to fit") {
            let small = CGRect(x: 0, y: 0, width: 800, height: 500)
            let huge = CGRect(x: 4000, y: 4000, width: 1600, height: 1200)
            let clamped = PanelGeometry.clamped(huge, into: small)
            Check.expect(clamped.width <= small.width, "got width \(clamped.width)")
            Check.expect(clamped.height <= small.height, "got height \(clamped.height)")
            Check.expect(small.contains(clamped), "got \(clamped)")
        }
    }
}

func runPaneWidthTests() {
    Check.suite("Width has both ends; height has one") {

        // Decision 22's own argument, enforced: past the content's measure a wider pane is gutters.
        Check.test("a drag wider than the measure is capped") {
            Check.equal(PanelGeometry.constrainWidth(1600), PanelGeometry.maximumWidth)
        }

        Check.test("a drag narrower than the floor is lifted") {
            Check.equal(PanelGeometry.constrainWidth(80), PanelGeometry.minimumWidth)
        }

        Check.test("anything in between is left alone") {
            Check.equal(PanelGeometry.constrainWidth(500), 500)
        }

        // A frame remembered before the cap existed, or dragged wide on a bigger display, must not
        // come back wider than the pane is now allowed to be.
        Check.test("a remembered frame is narrowed on the way back") {
            let screen = CGRect(x: 0, y: 0, width: 1920, height: 1080)
            let remembered = CGRect(x: 100, y: 200, width: 1600, height: 400)
            let restored = PanelGeometry.restore(
                remembered: remembered,
                titleBarHeight: 40,
                screens: [screen],
                activeVisibleFrame: screen,
                defaultWidth: 692,
                defaultHeight: 400
            )
            Check.equal(restored.width, PanelGeometry.maximumWidth)
            // And nothing else about it moves — "stay put" is still a rule.
            Check.equal(restored.minX, 100)
            Check.equal(restored.height, 400)
        }

        Check.test("a remembered frame inside the range is untouched") {
            let screen = CGRect(x: 0, y: 0, width: 1920, height: 1080)
            let remembered = CGRect(x: 100, y: 200, width: 500, height: 400)
            Check.equal(
                PanelGeometry.restore(
                    remembered: remembered, titleBarHeight: 40, screens: [screen],
                    activeVisibleFrame: screen, defaultWidth: 692, defaultHeight: 400
                ),
                remembered
            )
        }

        // Height keeps its floor and gains no ceiling.
        Check.test("height is not capped") {
            let screen = CGRect(x: 0, y: 0, width: 1920, height: 1080)
            let tall = PanelGeometry.clamped(
                CGRect(x: 0, y: 0, width: 500, height: 5000), into: screen)
            Check.equal(tall.height, screen.height - PanelGeometry.bottomMargin)
        }
    }
}
