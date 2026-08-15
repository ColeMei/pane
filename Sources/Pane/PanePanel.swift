import AppKit
import PaneKit

/// The window a note lives in.
///
/// Every unusual thing about it exists to satisfy one line of the bar — *summoning never activates
/// the app or changes the menu bar* — and design frame 1g's six behaviour rules. Measured on this
/// machine: an `.accessory` app **can** own a key window, and a `.nonactivatingPanel` shown with
/// `makeKeyAndOrderFront` leaves `frontmostApplication` and `menuBarOwningApplication` with the other
/// app, which is what the bar actually asks for. So don't check this with `NSApp.isActive`; it lies.
///
/// Borderless because the pane draws its own rounding, hairline and material in CSS (see the comment
/// at the top of `pane.css`) — the window is a transparent hole the web view fills.
@MainActor
final class PanePanel: NSPanel {

    /// Fixed width, per rule 2. Resizing is allowed but the content has its own measure, so a wider
    /// pane buys gutters rather than longer lines.
    static let defaultWidth: CGFloat = 692
    static let defaultHeight: CGFloat = 400

    /// The title bar is the drag handle (rule 3), and its height is the one number Swift needs from
    /// the design tokens to decide whether a remembered frame is still reachable.
    static let titleBarHeight: CGFloat = 40

    /// Somewhere no display reaches. Dismiss moves the window here rather than hiding it, because
    /// `setIsVisible(false)` **suspends the WKWebView** — measured, with rAF gaps of 653 ms and
    /// 3991 ms — and a suspended web view cannot meet a 100 ms summon. Offscreen keeps it warm
    /// (34–39 ms) and, unlike `alphaValue = 0`, cannot swallow a click meant for another app.
    private static let offscreenOrigin = CGPoint(x: -30_000, y: -30_000)

    private var onscreenFrame: CGRect?

    override var canBecomeKey: Bool { true }

    /// Never main. Main window status is what drives the menu bar, and Pane's whole trick is not
    /// touching it.
    override var canBecomeMain: Bool { false }

    init() {
        super.init(
            contentRect: CGRect(x: 0, y: 0, width: Self.defaultWidth, height: Self.defaultHeight),
            styleMask: [.nonactivatingPanel, .borderless, .resizable],
            backing: .buffered,
            defer: false
        )

        isFloatingPanel = true
        level = .floating
        // Without this an accessory app's panel vanishes the moment you click back into your editor,
        // which is the opposite of a panel you can type into while reading something else.
        hidesOnDeactivate = false
        isReleasedWhenClosed = false

        backgroundColor = .clear
        isOpaque = false
        hasShadow = true

        // The drag handle is a Swift overlay over the web view's title bar, not
        // `isMovableByWindowBackground`: a full-window WKWebView consumes mouse events, so the
        // background drag would never fire — and if it did, it would fire in the text too.
        isMovableByWindowBackground = false

        // Off, or the panel would appear in a screen recording's window list and in Mission Control
        // as a window you can miss. It is a HUD over your work, not a document.
        isExcludedFromWindowsMenu = true

        // A pane whose whole point is that it sits over other apps must not need a click to focus
        // and a second click to place the caret.
        acceptsMouseMovedEvents = true

        // A resizable window with no floor can be dragged to nothing, and a pane dragged to nothing
        // is unrecoverable: there is no title bar left to grab and no close dot left to click.
        // `PanelGeometry.minimumHeight` is the same floor auto-sizing already respects — title bar,
        // one line, footer — and the width keeps the three title bar buttons and the footer's word
        // count from colliding.
        minSize = NSSize(width: Self.minimumWidth, height: PanelGeometry.minimumHeight)

        applyCollectionBehaviour(pinned: false)
    }

    /// Narrowest the pane may be dragged. Below this the title bar's three buttons and the footer's
    /// centred word count start overlapping each other.
    static let minimumWidth: CGFloat = 320

    // MARK: - Spaces

    /// Every pane joins every Space, pinned or not.
    ///
    /// This reverses the Space half of rule 5, and the reason is that the rule was built on a
    /// conflation the design record itself makes. "Pinned" means two different things in two
    /// different frames: in 1c it is a note sorted to the top of the switcher, and in 1g it is a
    /// window that ignores dismiss *and* follows Space switches. Wiring one control to all three
    /// made the Space behaviour a side effect of a list-ordering choice, which is not a thing anyone
    /// could predict — and it showed up exactly as you would expect, as an unpinned pane refusing to
    /// come to the Space you were on.
    ///
    /// `.moveToActiveSpace` was also the wrong tool for it. It is evaluated when a window is ordered
    /// front, and this window is never ordered out — dismiss parks it offscreen so the WebContent
    /// process stays warm, which is what keeps the 100 ms bar reachable. A window already in the
    /// window list gets re-fronted without AppKit reconsidering its Space, so the rule failed
    /// silently rather than loudly.
    ///
    /// `.canJoinAllSpaces` has neither problem: the pane is on every Space already, so summoning is
    /// only ever a matter of moving it back on screen. Pinning keeps the two meanings that are
    /// actually about the note and the pane — top of the switcher, and ignores the dismiss hotkey.
    ///
    /// `.fullScreenAuxiliary` joins a fullscreen app as an overlay rather than forcing a Space
    /// switch out of it.
    func applyCollectionBehaviour(pinned: Bool = false) {
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
    }

    // MARK: - Summon and dismiss

    var isSummoned: Bool { onscreenFrame == nil ? false : frame.origin != Self.offscreenOrigin }

    /// Puts the pane back where it was, on the Space you are on now.
    ///
    /// - Parameter frame: where to appear. Rule 3 — "only a drag moves a pane" — so this is the
    ///   remembered frame, already reconciled against the connected displays by `PanelGeometry`.
    func summon(at frame: CGRect, pinned: Bool) {
        onscreenFrame = frame
        setFrame(frame, display: false)

        // Re-assert the collection behaviour on every summon, not just when the pin state changes.
        //
        // `.moveToActiveSpace` is evaluated when a window is *ordered front*, and this window is
        // never ordered out — dismiss parks it offscreen so the web view stays warm (measured:
        // `setIsVisible(false)` suspends it). A window that is already in the window list can be
        // re-fronted without AppKit reconsidering which Space it belongs on, which is rule 1
        // silently failing: summon on another Space and nothing appears.
        applyCollectionBehaviour(pinned: pinned)

        makeKeyAndOrderFront(nil)
        // `orderFrontRegardless` is the one that crosses a Space boundary without activating the
        // app. `makeKeyAndOrderFront` alone gives the pane key status on the Space it is already on.
        orderFrontRegardless()
    }

    /// Moves the pane out of sight without letting the web view go to sleep.
    ///
    /// - Returns: the frame it was occupying, for `state.json`.
    @discardableResult
    func dismiss() -> CGRect? {
        let was = frame
        guard was.origin != Self.offscreenOrigin else { return onscreenFrame }
        onscreenFrame = was
        setFrameOrigin(Self.offscreenOrigin)
        return was
    }

    /// The frame the pane would return to, in screen coordinates.
    ///
    /// While the pane is on screen this is simply its live frame, and that is the whole point: the
    /// user drags the window with the mouse, so AppKit — not this class — is the only thing that
    /// knows where it ended up. Returning the origin stashed at summon time instead meant every drag
    /// was thrown away and the pane reappeared wherever it was last *programmatically* placed.
    var rememberedFrame: CGRect? {
        frame.origin == Self.offscreenOrigin ? onscreenFrame : frame
    }

    /// Resizes while offscreen or onscreen without losing track of where "onscreen" is.
    func applyHeight(_ frame: CGRect) {
        if self.frame.origin == Self.offscreenOrigin {
            onscreenFrame = frame
            setContentSize(frame.size)
        } else {
            onscreenFrame = frame
            setFrame(frame, display: true)
        }
    }
}
