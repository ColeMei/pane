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

    /// Rule 2's width. Resizing is allowed between `PanelGeometry.minimumWidth` and
    /// `maximumWidth` — the content has its own measure, so past that a wider pane buys gutters
    /// rather than longer lines, and it used to be draggable to the full width of a display.
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

    /// Whether the pane is meant to be on screen, held rather than derived.
    ///
    /// `isSummoned` used to read the origin alone, which made "dismissed" a fact about geometry that
    /// anything moving the window could overwrite — and something does. See `reparkAfterScreenChange`.
    private var parked = false

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

        // Width is capped and height is not, which is the reference's split and the right one: past
        // the content's measure a wider pane is gutters (see `PanelGeometry.maximumWidth`), while a
        // taller one is simply more note. `greatestFiniteMagnitude` is `maxSize`'s own default.
        maxSize = NSSize(width: PanelGeometry.maximumWidth, height: .greatestFiniteMagnitude)

        applyCollectionBehaviour(pinned: false)
        observeScreenChanges()
    }

    // MARK: - Staying parked across a display change

    /// AppKit rescues windows that sit on no display, and a dismissed pane is exactly that.
    ///
    /// Dismiss parks the window at `offscreenOrigin` rather than hiding it, because
    /// `setIsVisible(false)` suspends the WebContent process and a suspended web view cannot meet the
    /// 100 ms summon bar. The cost of that trick is that the window is, as far as AppKit is
    /// concerned, a window the user has lost: when the screen configuration changes — a monitor
    /// sleeping and waking, a lid closing and opening, a display unplugged — it walks the window list
    /// and moves anything outside every screen back onto the main one. So closing and reopening a
    /// laptop put a dismissed pane on the desktop, unasked, with nobody having summoned it.
    ///
    /// **Measured, by flipping the display mode with `CGConfigureDisplayWithDisplayMode` and logging
    /// every frame call.** Two things came out of it that guesswork got wrong:
    ///
    /// - **`constrainFrameRect` is not the hook.** It *is* consulted — with `(240, 752)`, the origin
    ///   AppKit had already picked — and returning the rect unchanged changed nothing: the very next
    ///   call was `setFrame` to `(240, 784)`. Overriding it to decline the rescue reads exactly like
    ///   a fix and is not one, so there is no override here.
    /// - **The notification arrives after the move, which is what makes it work.** By the time this
    ///   fires the origin already reads `(240, 784)`, so re-parking has something to undo. Both
    ///   happen in the same millisecond, so nothing is drawn on screen in between.
    ///
    /// The other half of the fix is that `parked` has to be true in the first place. It was not:
    /// `PaneController.init` parked the pane at startup with a bare `setFrameOrigin` on its own copy
    /// of the literal, so a pane that had never been summoned was offscreen with `parked` false and
    /// this guard switched off. That is now `parkBeforeFirstSummon`.
    ///
    /// A pane that is genuinely on screen is left alone, and should be: it may have been on the
    /// display that just went away, and AppKit bringing it back is the right answer there.
    ///
    /// The remembered frame is untouched — `onscreenFrame` is where the pane returns to, and a
    /// display change must not silently redefine it. `PanelGeometry` reconciles it against the
    /// connected displays at summon time, which is the right moment: the answer depends on the
    /// screens attached *then*, not on the screens attached when the lid shut.
    private func observeScreenChanges() {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(reparkAfterScreenChange),
            name: NSApplication.didChangeScreenParametersNotification,
            object: nil
        )
    }

    @objc private func reparkAfterScreenChange() {
        guard parked, frame.origin != Self.offscreenOrigin else { return }
        setFrameOrigin(Self.offscreenOrigin)
    }

    /// Lives in `PanelGeometry` so the clamp and the window agree; kept here as the name the rest
    /// of the shell already uses.
    static var minimumWidth: CGFloat { PanelGeometry.minimumWidth }

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
    /// `Settings.showOnEverySpace`, kept here because `summon` re-asserts the behaviour on every
    /// summon and has no route to the settings store.
    ///
    /// Off drops `.canJoinAllSpaces`, so the pane belongs to the Space it is on rather than being
    /// drawn on all of them. `.ignoresCycle` and `.fullScreenAuxiliary` stay either way — the pane
    /// is never a ⌘Tab candidate, and it still overlays a fullscreen app rather than forcing a
    /// Space switch out of one.
    var showsOnEverySpace = true {
        didSet { if showsOnEverySpace != oldValue { applyCollectionBehaviour() } }
    }

    func applyCollectionBehaviour(pinned: Bool = false) {
        var behaviour: NSWindow.CollectionBehavior = [.fullScreenAuxiliary, .ignoresCycle]
        if showsOnEverySpace { behaviour.insert(.canJoinAllSpaces) }
        collectionBehavior = behaviour
    }

    // MARK: - Summon and dismiss

    var isSummoned: Bool { onscreenFrame != nil && !parked }

    /// Puts the pane back where it was, on the Space you are on now.
    ///
    /// - Parameter frame: where to appear. Rule 3 — "only a drag moves a pane" — so this is the
    ///   remembered frame, already reconciled against the connected displays by `PanelGeometry`.
    func summon(at frame: CGRect, pinned: Bool) {
        onscreenFrame = frame
        parked = false
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

    /// Parks the pane before it has ever been summoned.
    ///
    /// The web view has to be laid out and warm before the first summon, so the window is ordered
    /// front offscreen at startup rather than shown later. That has to go through here rather than
    /// through a bare `setFrameOrigin`: `parked` is what every guard in this file reads, and a window
    /// sitting at `offscreenOrigin` with `parked` still false is a pane AppKit is free to rescue onto
    /// the desktop at the next display change, which is exactly what it did.
    func parkBeforeFirstSummon() {
        parked = true
        setFrameOrigin(Self.offscreenOrigin)
        orderFront(nil)
    }

    /// Moves the pane out of sight without letting the web view go to sleep.
    ///
    /// - Returns: the frame it was occupying, for `state.json`.
    @discardableResult
    func dismiss() -> CGRect? {
        let was = frame
        guard !parked else { return onscreenFrame }
        parked = true
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
        parked ? onscreenFrame : frame
    }

    /// Resizes while offscreen or onscreen without losing track of where "onscreen" is.
    func applyHeight(_ frame: CGRect) {
        if parked {
            onscreenFrame = frame
            setContentSize(frame.size)
        } else {
            onscreenFrame = frame
            setFrame(frame, display: true)
        }
    }
}

extension PanePanel {

    /// Steps every pane out of the way of a window the app has put in front on purpose.
    ///
    /// A pane sits at `.floating` so it stays above other applications — that is the product. A save
    /// panel, an `NSAlert` and the Settings window are ordinary windows at `.normal`, so **all four
    /// moments Pane deliberately activates** (decisions 16, 27, 37 and the Sync alert of decision
    /// 30) put their window *behind* the pane. Measured on the running app: the Export panel's Save
    /// button sat under the pane's edge, and Settings opened with its first rows covered.
    ///
    /// The pane is lowered rather than the other window raised, and that is the whole design.
    /// Raising Settings to `.floating` would leave it above every *other* app's windows too, which
    /// is exactly the behaviour Pane reserves for the pane. Lowering is also scoped by construction:
    /// it lasts only as long as the window that asked for it.
    ///
    /// `isFloatingPanel` is cleared as well, because it owns the level — setting `level` alone left
    /// the panel back at `.floating` and the save panel still behind it.
    static func stepAside() {
        for pane in NSApp.windows.compactMap({ $0 as? PanePanel }) {
            pane.isFloatingPanel = false
            pane.level = .normal
        }
    }

    /// Puts them back. Safe to call when nothing stepped aside.
    static func resumeFloating() {
        for pane in NSApp.windows.compactMap({ $0 as? PanePanel }) {
            pane.isFloatingPanel = true
            pane.level = .floating
        }
    }

    /// The scoped form, for anything that runs modal.
    static func steppingAside<T>(_ body: () throws -> T) rethrows -> T {
        stepAside()
        defer { resumeFloating() }
        return try body()
    }
}
