import AppKit
import Carbon.HIToolbox
import PaneKit

/// Click it, press a combination, it becomes the combination — design frames 2c and 3c.
///
/// Decision 15 reverses half of decision 12 to ship this: the argument that a settings file is a fair
/// substitute for a recorder fails at exactly the moment it matters, which is first launch, when
/// somebody wants a different combo and is least willing to go looking for JSON.
///
/// Recording is a *mode*, which is why this is one view rather than a control plus a formatter: while
/// it is on, every key the user presses belongs to this view and to nothing else, the menu bar
/// included. `performKeyEquivalent` is the only hook that runs before menu key equivalents, so the
/// capture has to live there — `keyDown` alone would never see ⌘Q, ⌘W or ⌘, and the user would quit
/// the app trying to record one.
///
/// The base class owns the mode and the drawing. Subclasses decide what a captured combination *is*:
/// a Carbon `Hotkey` for the global summon, a CodeMirror binding string for the in-pane shortcuts.
@MainActor
class HotkeyRecorderViewBase: NSView {

    private var isRecording = false {
        didSet { needsDisplay = true }
    }

    /// The modifiers currently held, so the combination builds up visibly as the user chords.
    private var liveModifiers: NSEvent.ModifierFlags = []

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        translatesAutoresizingMaskIntoConstraints = false
        setContentHuggingPriority(.defaultHigh, for: .horizontal)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    // MARK: - Subclass hooks

    /// What to show when not recording.
    var displayText: String { "" }

    /// Consume a captured combination.
    ///
    /// - Returns: true when it was accepted and recording should stop. False keeps recording, which
    ///   is the right answer mid-chord — a combination with no modifiers is almost always a user who
    ///   has not finished pressing keys yet.
    func handle(keyCode: UInt16, flags: NSEvent.ModifierFlags) -> Bool { false }

    // MARK: - Layout and drawing

    override var intrinsicContentSize: NSSize { NSSize(width: 132, height: 24) }

    override var acceptsFirstResponder: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        let box = bounds.insetBy(dx: 0.5, dy: 0.5)
        let path = NSBezierPath(roundedRect: box, xRadius: 6, yRadius: 6)

        (isRecording ? NSColor.controlAccentColor.withAlphaComponent(0.12) : .textBackgroundColor)
            .setFill()
        path.fill()

        (isRecording ? NSColor.controlAccentColor : NSColor.separatorColor).setStroke()
        path.lineWidth = isRecording ? 2 : 1
        path.stroke()

        let text: String
        let colour: NSColor
        if isRecording {
            let pending = Self.symbols(for: liveModifiers)
            text = pending.isEmpty ? "Type a shortcut…" : pending
            colour = pending.isEmpty ? .tertiaryLabelColor : .labelColor
        } else {
            text = displayText
            colour = .labelColor
        }

        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 12.5),
            .foregroundColor: colour,
        ]
        let size = (text as NSString).size(withAttributes: attributes)
        (text as NSString).draw(
            at: NSPoint(x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2),
            withAttributes: attributes
        )
    }

    override var focusRingMaskBounds: NSRect { bounds }

    override func drawFocusRingMask() {
        NSBezierPath(roundedRect: bounds, xRadius: 6, yRadius: 6).fill()
    }

    // MARK: - Recording

    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        isRecording = true
        liveModifiers = []
    }

    override func resignFirstResponder() -> Bool {
        isRecording = false
        return true
    }

    override func flagsChanged(with event: NSEvent) {
        guard isRecording else { return super.flagsChanged(with: event) }
        liveModifiers = event.modifierFlags
        needsDisplay = true
    }

    /// Runs before menu key equivalents, which is the only reason ⌘-anything can be recorded here.
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        guard isRecording else { return super.performKeyEquivalent(with: event) }
        return capture(event)
    }

    override func keyDown(with event: NSEvent) {
        guard isRecording, capture(event) else { return super.keyDown(with: event) }
    }

    /// - Returns: true when the event was consumed, whether or not it produced a shortcut.
    private func capture(_ event: NSEvent) -> Bool {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)

        // Escape abandons the recording and keeps whatever was there. Every recorder on the platform
        // does this, and it is the only exit that does not require choosing something.
        if event.keyCode == UInt16(kVK_Escape), flags.isEmpty {
            stop()
            return true
        }

        if handle(keyCode: event.keyCode, flags: flags) { stop() }
        return true
    }

    private func stop() {
        isRecording = false
        window?.makeFirstResponder(nil)
    }

    // MARK: - Modifier translation

    static func hotkeyModifiers(for flags: NSEvent.ModifierFlags) -> Hotkey.Modifiers {
        var result: Hotkey.Modifiers = []
        if flags.contains(.control) { result.insert(.control) }
        if flags.contains(.option) { result.insert(.option) }
        if flags.contains(.shift) { result.insert(.shift) }
        if flags.contains(.command) { result.insert(.command) }
        return result
    }

    /// Apple's display order: control, option, shift, command.
    static func symbols(for flags: NSEvent.ModifierFlags) -> String {
        var s = ""
        if flags.contains(.control) { s += "⌃" }
        if flags.contains(.option) { s += "⌥" }
        if flags.contains(.shift) { s += "⇧" }
        if flags.contains(.command) { s += "⌘" }
        return s
    }
}

/// The global summon hotkey — a Carbon key code and modifier mask (decision 9).
@MainActor
final class HotkeyRecorderView: HotkeyRecorderViewBase {

    /// Fired with a combination the user chose. Not called when recording is cancelled.
    var onRecord: ((Hotkey) -> Void)?

    private(set) var hotkey: Hotkey

    init(hotkey: Hotkey) {
        self.hotkey = hotkey
        super.init(frame: .zero)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    func setHotkey(_ hotkey: Hotkey) {
        self.hotkey = hotkey
        needsDisplay = true
    }

    override var displayText: String { hotkey.displayString }

    override func handle(keyCode: UInt16, flags: NSEvent.ModifierFlags) -> Bool {
        let modifiers = Self.hotkeyModifiers(for: flags)
        // A global hotkey with no modifier would swallow that key in every application on the
        // system, which is never what anyone means.
        guard !modifiers.isEmpty else { return false }

        let recorded = Hotkey(keyCode: UInt32(keyCode), modifiers: modifiers)
        hotkey = recorded
        onRecord?(recorded)
        return true
    }
}
