import Foundation
import PaneKit

/// The height a pane should be, given its mode, its content and any open overlay.
///
/// This mirrors `PaneController.heightWanted`, which cannot be tested directly because it needs a
/// window. The arithmetic is what shipped wrong, so it is the part worth pinning down: the old rule
/// treated a dragged height as a floor, and a floor is unreachable on any note taller than the pane.
private func heightWanted(
    _ pane: PaneState,
    content: CGFloat,
    switcher: CGFloat? = nil,
    actions: CGFloat? = nil
) -> CGFloat {
    var wanted = pane.autoSizing ? content : CGFloat(pane.manualHeight ?? Double(content))
    if let switcher { wanted = max(wanted, switcher) }
    if let actions { wanted = max(wanted, actions) }
    return wanted
}

func runAutoSizingTests() {
    Check.suite("Auto-sizing") {

        Check.test("a new pane follows its content") {
            let pane = PaneState()
            Check.equal(pane.autoSizing, true)
            Check.equal(heightWanted(pane, content: 400), 400)
        }

        Check.test("with auto-sizing off the pane holds the dragged height, however long the note") {
            // The bug, stated as a test. Under the old floor rule this returned 900 — the note's
            // height — because a 300 floor is never reached by content taller than it, so dragging
            // a long note's pane smaller did nothing you could see.
            let pane = PaneState(autoSizing: false, manualHeight: 300)
            Check.equal(heightWanted(pane, content: 900), 300, "a long note must not win")
            Check.equal(heightWanted(pane, content: 100), 300, "and a short one must not shrink it")
        }

        Check.test("an overlay overrides both modes, and closing it gives the mode back") {
            // A panel clipped by the pane it is drawn inside is not a size anyone chose.
            let dragged = PaneState(autoSizing: false, manualHeight: 200)
            Check.equal(heightWanted(dragged, content: 150, actions: 506), 506)
            Check.equal(heightWanted(dragged, content: 150), 200, "back to the dragged height")

            let auto = PaneState()
            Check.equal(heightWanted(auto, content: 150, switcher: 500), 500)
            Check.equal(heightWanted(auto, content: 150), 150, "back to the content")
        }

        Check.test("state written before the mode existed is not read as a pinned pane") {
            // Old state.json carries manualHeight and no autoSizing. Defaulting the flag to true and
            // keeping the height would mean "auto-sizing on, held at 300", which is neither thing.
            let json = #"{"id":"\#(UUID().uuidString)","manualHeight":300,"frames":{}}"#
            let decoded = try? JSONDecoder().decode(PaneState.self, from: Data(json.utf8))

            Check.equal(decoded?.autoSizing, true)
            Check.equal(decoded?.manualHeight == nil, true, "the stale floor must be dropped")
        }

        Check.test("a height written with the mode off survives the round trip") {
            let pane = PaneState(autoSizing: false, manualHeight: 275)
            let data = try? JSONEncoder().encode(pane)
            let back = data.flatMap { try? JSONDecoder().decode(PaneState.self, from: $0) }

            Check.equal(back?.autoSizing, false)
            Check.equal(back?.manualHeight, 275)
        }

        Check.test("growth still stops short of the screen bottom in either mode") {
            // Decision 40 changes which height is asked for, not the cap on it.
            let screen = CGRect(x: 0, y: 0, width: 1440, height: 900)
            let current = CGRect(x: 100, y: 500, width: 438, height: 300)
            let grown = PanelGeometry.grown(from: current, toContentHeight: 5000, visibleFrame: screen)

            Check.equal(grown.frame.maxY, current.maxY, "the top edge is the anchor")
            Check.equal(grown.frame.minY, screen.minY + PanelGeometry.bottomMargin)
            Check.equal(grown.scrolls, true)
        }
    }
}
