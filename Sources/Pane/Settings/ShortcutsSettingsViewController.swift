import AppKit
import PaneKit

/// Design frame 3c — the Shortcuts tab.
///
/// A plain table, which is the design's own point: every future feature adds a row, never a new
/// control style. The summon row is the global hotkey (Carbon, decision 9); the rest are bindings
/// the web layer installs inside a pane.
///
/// Frame 3c lists eight rows and this ships fourteen — the summon hotkey plus every entry in
/// `Settings.shortcutActions` — which is the table doing exactly what the frame said it was for:
/// every feature that lands adds a row, never a new control style. Seven of the frame's eight are
/// here; the eighth, Open in New Pane, belongs to multi-pane and is still deferred (decision 18).
/// The seven beyond the frame — Duplicate Note, Copy as Markdown, Window Auto-sizing, Reveal in
/// Finder, Export…, Hide from Screen Capture, Delete Note — each arrived with its ⌘K row.
///
/// The count is `Settings.shortcutActions.count + 1`; don't restate it here without changing it
/// there. `NSTabViewController` gives each tab its own height, so growing this one does not disturb
/// the others — measured at 540×564 with fourteen rows.
///
/// The rule that governs this list has not moved: a recordable row that binds nothing is a worse lie
/// than an absent row, so a row appears here only when `Settings.shortcutActions` has an entry doing
/// something. Recently Deleted is the one ⌘K row with no entry, because the design gives it no
/// shortcut and a blank waiting to be filled in is the same lie in a different shape.
@MainActor
final class ShortcutsSettingsViewController: NSViewController {

    private let settings: SettingsStore
    private var summonRecorder: HotkeyRecorderView!
    private var paneRecorders: [(action: String, recorder: PaneShortcutRecorderView)] = []

    init(settings: SettingsStore) {
        self.settings = settings
        super.init(nibName: nil, bundle: nil)
        title = "Shortcuts"
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override func loadView() {
        let rows = NSStackView()
        rows.orientation = .vertical
        rows.alignment = .leading
        rows.spacing = 0
        rows.translatesAutoresizingMaskIntoConstraints = false

        summonRecorder = HotkeyRecorderView(hotkey: settings.value.summonHotkey)
        summonRecorder.onRecord = { [weak self] hotkey in
            self?.settings.update { $0.summonHotkey = hotkey }
        }
        rows.addArrangedSubview(row(label: "Summon / dismiss Pane", control: summonRecorder))

        for action in Settings.shortcutActions {
            let recorder = PaneShortcutRecorderView(binding: settings.value.shortcut(action.key))
            recorder.onRecord = { [weak self] binding in
                self?.settings.update { $0.shortcuts[action.key] = binding }
            }
            paneRecorders.append((action.key, recorder))
            rows.addArrangedSubview(row(label: action.label, control: recorder))
        }

        let caption = NSTextField(labelWithString: "Click any shortcut to re-record it.")
        caption.font = .systemFont(ofSize: 11)
        caption.textColor = .secondaryLabelColor

        let restore = SettingsForm.push(
            "Restore Defaults", target: self, action: #selector(restoreDefaults)
        )

        let footer = NSStackView(views: [caption, NSView(), restore])
        footer.orientation = .horizontal
        footer.distribution = .fill
        footer.spacing = 8
        footer.translatesAutoresizingMaskIntoConstraints = false

        // Same reason as `SettingsForm.makeContentView`: anything that ties this to the container's
        // full height hands the tab view's spare space to the stack, which puts it between the
        // shortcut rows. Hug vertically, pin to the top, and let the container be taller.
        rows.setContentHuggingPriority(.required, for: .vertical)

        let container = NSView()
        container.addSubview(rows)
        container.addSubview(footer)

        NSLayoutConstraint.activate([
            rows.topAnchor.constraint(equalTo: container.topAnchor, constant: 14),
            rows.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 24),
            rows.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -24),

            footer.topAnchor.constraint(equalTo: rows.bottomAnchor, constant: 12),
            footer.leadingAnchor.constraint(equalTo: rows.leadingAnchor),
            footer.trailingAnchor.constraint(equalTo: rows.trailingAnchor),
            container.bottomAnchor.constraint(greaterThanOrEqualTo: footer.bottomAnchor, constant: 20),

            container.widthAnchor.constraint(greaterThanOrEqualToConstant: 540),
        ])
        view = container
    }

    /// Label left, recorder right, hairline underneath — the frame's row exactly.
    private func row(label text: String, control: NSView) -> NSView {
        let label = NSTextField(labelWithString: text)
        label.font = .systemFont(ofSize: 13)

        let line = NSStackView(views: [label, NSView(), control])
        line.orientation = .horizontal
        line.spacing = 8
        line.edgeInsets = NSEdgeInsets(top: 6, left: 2, bottom: 6, right: 2)

        let separator = NSBox()
        separator.boxType = .separator

        let stack = NSStackView(views: [line, separator])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 0
        stack.translatesAutoresizingMaskIntoConstraints = false
        line.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        separator.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        return stack
    }

    func settingsChanged(_ new: Settings) {
        summonRecorder?.setHotkey(new.summonHotkey)
        for entry in paneRecorders {
            entry.recorder.setBinding(new.shortcut(entry.action))
        }
    }

    @objc private func restoreDefaults() {
        settings.update {
            $0.summonHotkey = .defaultSummon
            $0.shortcuts = Settings.standardShortcuts
        }
        settingsChanged(settings.value)
    }
}

/// The same recorder, for a shortcut that is a CodeMirror binding rather than a Carbon hotkey.
///
/// Separate from `HotkeyRecorderView` because the two produce different things and validate
/// differently: a global hotkey must carry a modifier or it would swallow that key system-wide, while
/// an in-pane binding must carry one for a much smaller reason — it lives in a text editor, so an
/// unmodified key is a character somebody wanted to type.
@MainActor
final class PaneShortcutRecorderView: HotkeyRecorderViewBase {

    var onRecord: ((String) -> Void)?

    private var binding: String

    init(binding: String) {
        self.binding = binding
        super.init(frame: .zero)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    func setBinding(_ binding: String) {
        self.binding = binding
        needsDisplay = true
    }

    override var displayText: String { Self.symbols(for: binding) }

    override func handle(keyCode: UInt16, flags: NSEvent.ModifierFlags) -> Bool {
        var parts: [String] = []
        if flags.contains(.control) { parts.append("Ctrl") }
        if flags.contains(.option) { parts.append("Alt") }
        if flags.contains(.shift) { parts.append("Shift") }
        if flags.contains(.command) { parts.append("Mod") }
        guard !parts.isEmpty else { return false }

        guard let key = Self.bindingKey(for: keyCode) else { return false }
        parts.append(key)

        binding = parts.joined(separator: "-")
        onRecord?(binding)
        return true
    }

    /// CodeMirror names keys by `KeyboardEvent.key`, so this maps the hardware code to that name.
    private static func bindingKey(for keyCode: UInt16) -> String? {
        KeyCode.bindingName(for: UInt32(keyCode))
    }

    /// Renders `"Shift-Mod-p"` as `⇧⌘P`, in Apple's display order rather than the binding's.
    static func symbols(for binding: String) -> String {
        var pieces = binding.split(separator: "-").map(String.init)
        guard let key = pieces.popLast() else { return "" }

        let held = Set(pieces)
        var s = ""
        if held.contains("Ctrl") { s += "⌃" }
        if held.contains("Alt") { s += "⌥" }
        if held.contains("Shift") { s += "⇧" }
        if held.contains("Mod") || held.contains("Cmd") { s += "⌘" }
        return s + (key.count == 1 ? key.uppercased() : key)
    }
}
