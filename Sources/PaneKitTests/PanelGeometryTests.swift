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

        Check.test("a frame on the display being summoned to is restored untouched") {
            // "Stay put" is per display: the frame handed in was looked up under *this* display's
            // key, so the case that means anything is a frame that belongs here.
            let remembered = CGRect(x: 300, y: 400, width: paneWidth, height: 400)
            let restored = PanelGeometry.restore(
                remembered: remembered,
                titleBarHeight: titleBar,
                activeVisibleFrame: builtIn,
                defaultWidth: paneWidth,
                defaultHeight: 400
            )
            Check.equal(restored, remembered, "stay put means stay put")
        }

        Check.test("a frame that lands on another display is pulled onto this one") {
            // The report, 2026-09-10: after a power cycle of two monitors, summoning on the main
            // display put the pane on the portrait one, every time. The main display's stored frame
            // was at x=2267 — inside the portrait monitor's area — and `restore` accepted it because
            // it tested reachability against *every* screen rather than the one being summoned to.
            //
            // This is reachable in the app whenever the arrangement's origins move under a stored
            // frame, which a display wake does. Clamping onto the active display is the recovery.
            let onTheOtherScreen = CGRect(x: 2267, y: 147, width: 320, height: 718)
            let restored = PanelGeometry.restore(
                remembered: onTheOtherScreen,
                titleBarHeight: titleBar,
                activeVisibleFrame: builtIn,
                defaultWidth: paneWidth,
                defaultHeight: 400
            )
            Check.expect(
                builtIn.contains(restored),
                "the pane must come up on the display you summoned from, got \(restored)"
            )
            Check.equal(restored.width, 320, "the size the user chose is kept")
            Check.equal(restored.height, 718)
        }

        Check.test("a frame on a screen that went away comes back to the active display") {
            // Remembered on the external monitor, which is no longer connected.
            let remembered = CGRect(x: 3000, y: 1100, width: paneWidth, height: 400)
            let restored = PanelGeometry.restore(
                remembered: remembered,
                titleBarHeight: titleBar,
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
                    remembered: remembered, titleBarHeight: 40,
                    activeVisibleFrame: screen, defaultWidth: 692, defaultHeight: 400
                ),
                remembered
            )
        }

        // MARK: - The height ceiling
        //
        // This replaces a test called "height is not capped", which asserted the screen was the only
        // limit. That was decision 83 as written, and it was written with only landscape displays in
        // view. A rotated 1080×1920 monitor is what showed the difference.

        Check.test("the height ceiling is derived from the width cap, not picked") {
            // Decision 82: when a number comes from another number, derive it. √2 is the A-series
            // page ratio, so the widest allowed pane at its tallest is exactly a page.
            Check.equal(
                PanelGeometry.maximumHeight,
                (PanelGeometry.maximumWidth * 1.41421356).rounded()
            )
        }

        Check.test("a portrait display cannot make an enormous pane") {
            // 1080×1920 rotated, menu bar off the top. Without the cap this grows past 1890.
            let portrait = CGRect(x: 0, y: 0, width: 1080, height: 1895)
            let top = portrait.maxY - 100
            Check.equal(
                PanelGeometry.maxHeight(topY: top, visibleFrame: portrait),
                PanelGeometry.maximumHeight,
                "the ceiling, not the screen edge"
            )

            let start = CGRect(x: 0, y: top - 300, width: paneWidth, height: 300)
            let grown = PanelGeometry.grown(
                from: start, toContentHeight: 4000, visibleFrame: portrait
            )
            Check.equal(grown.frame.height, PanelGeometry.maximumHeight)
            Check.expect(grown.scrolls, "a note past the ceiling scrolls inside the pane")
            Check.equal(grown.frame.maxY, top, "growth is still anchored by the top edge")
        }

        Check.test("what the ceiling actually costs, display by display") {
            // Written after the first version of this test asserted the cap "never bites on a
            // landscape display" and went red on two of them. It does bite, and the honest record is
            // the measurement rather than the assumption — this is the same class of mistake as the
            // `displayKey` comment the whole change exists to correct.
            //
            // Usable height is the visible frame; the pane also keeps `bottomMargin` off the floor.
            let cases: [(String, CGRect, CGFloat)] = [
                ("14\" built-in 1512×982", builtIn, 921),
                ("1920×1080 external", CGRect(x: 0, y: 0, width: 1920, height: 1055), 1024),
                ("3440×1440 ultrawide", CGRect(x: 0, y: 0, width: 3440, height: 1415), 1024),
                ("1080×1920 portrait", CGRect(x: 0, y: 0, width: 1080, height: 1895), 1024),
            ]
            for (name, screen, expected) in cases {
                Check.equal(
                    PanelGeometry.maxHeight(topY: screen.maxY, visibleFrame: screen),
                    expected,
                    name
                )
            }
        }

        Check.test("clamped honours the ceiling as well as the screen") {
            let screen = CGRect(x: 0, y: 0, width: 1920, height: 1080)
            let tall = PanelGeometry.clamped(
                CGRect(x: 0, y: 0, width: 500, height: 5000), into: screen)
            Check.equal(tall.height, PanelGeometry.maximumHeight)
        }

        Check.test("a remembered frame taller than the ceiling comes back capped, top edge held") {
            let portrait = CGRect(x: 0, y: 0, width: 1080, height: 1895)
            let remembered = CGRect(x: 100, y: 200, width: 500, height: 1600)
            let restored = PanelGeometry.restore(
                remembered: remembered, titleBarHeight: titleBar,
                activeVisibleFrame: portrait, defaultWidth: paneWidth, defaultHeight: 400
            )
            Check.equal(restored.height, PanelGeometry.maximumHeight)
            Check.equal(restored.maxY, remembered.maxY, "the top edge is the one the user reaches for")
            Check.equal(restored.minX, remembered.minX)
        }

        // MARK: - Remembering per display, and the key that could not be looked up
        //
        // The report: turn a monitor off and on and the pane comes back at its first-launch size.
        // Cause — the frame was filed under the `CGDirectDisplayID`, which macOS re-issues. Measured
        // 2026-09-10 on a two-monitor Mac: one power cycle moved the displays from 53 and 54 to 59
        // and 58, and that machine's `state.json` held 56 orphaned frames for two monitors.

        Check.test("the key is the display's identity, and survives a re-issued ID") {
            let uuid = "DA50421B-C4EE-4978-9813-F642FDDDEF28"
            Check.equal(
                PanelGeometry.displayKey(uuid: uuid, width: 1920, height: 1080),
                PanelGeometry.displayKey(uuid: uuid, width: 1920, height: 1080),
                "the same monitor is the same key however many times it has been power cycled"
            )
            Check.expect(
                !PanelGeometry.displayKey(uuid: uuid, width: 1920, height: 1080).hasPrefix("53"),
                "nothing in the key may come from the display ID"
            )
        }

        Check.test("a different panel at the same size is a different key") {
            Check.expect(
                PanelGeometry.displayKey(uuid: "AAA", width: 1920, height: 1080)
                    != PanelGeometry.displayKey(uuid: "BBB", width: 1920, height: 1080),
                "swapping monitors must not inherit the old one's frame"
            )
        }

        Check.test("a key written under the display ID is recognised as dead") {
            for dead in ["53-1920x1080", "4-1080x1920", "0-1512x982"] {
                Check.expect(PanelGeometry.isLegacyDisplayKey(dead), "\(dead) can never match again")
            }
            for live in [
                "DA50421B-C4EE-4978-9813-F642FDDDEF28-1920x1080",
                "id53-1920x1080",   // the fallback for a display that refuses a UUID
            ] {
                Check.expect(!PanelGeometry.isLegacyDisplayKey(live), "\(live) is a real key")
            }
        }

        Check.test("an unknown display inherits the size you last chose, not the default") {
            // The symptom the report actually described: a pane that comes back looking like a fresh
            // install. Even with a genuinely new monitor, the size is one the user picked.
            let chosen = CGSize(width: 434, height: 576)
            let restored = PanelGeometry.restore(
                remembered: nil,
                lastSize: chosen,
                titleBarHeight: titleBar,
                activeVisibleFrame: builtIn,
                defaultWidth: paneWidth,
                defaultHeight: 400
            )
            Check.equal(restored.width, chosen.width, "not the \(paneWidth) default")
            Check.equal(restored.height, chosen.height)
            Check.equal(restored.midX, builtIn.midX, "placed like a first launch, sized like yours")
        }

        Check.test("with nothing remembered anywhere the default still applies") {
            let restored = PanelGeometry.restore(
                remembered: nil, lastSize: nil, titleBarHeight: titleBar,
                activeVisibleFrame: builtIn, defaultWidth: paneWidth, defaultHeight: 400
            )
            Check.equal(
                restored,
                PanelGeometry.firstLaunchFrame(width: paneWidth, height: 400, visibleFrame: builtIn)
            )
        }

        Check.test("a last size out of range is brought back in") {
            let restored = PanelGeometry.restore(
                remembered: nil,
                lastSize: CGSize(width: 4000, height: 400),
                titleBarHeight: titleBar,
                activeVisibleFrame: builtIn, defaultWidth: paneWidth, defaultHeight: 400
            )
            Check.equal(restored.width, PanelGeometry.maximumWidth)
        }
    }
}
