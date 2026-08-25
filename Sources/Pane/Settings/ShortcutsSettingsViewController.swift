import AppKit
import PaneKit

/// Design frame 3c — the Shortcuts tab.
///
/// A plain table, which is the design's own point: every future feature adds a row, never a new
/// control style. Every row is a binding the web layer installs inside a pane.
///
/// **This tab answers "what would you want to change", not "what keys exist".** Conflating the two
/// took it to sixteen rows in one column, three of which nobody would ever touch: the summon hotkey
/// was here *and* on General — the same recorder twice — and ⌘F and ⌥⌘F mean find and replace in
/// every editor anyone has used. The line now lives in `Settings.fixedShortcuts`, which carries the
/// reasoning; what matters here is that a key being absent from this tab does not make it absent
/// from the app. Each one still prints itself in ⌘K or in the control's own tooltip, and every one
/// of those reads the binding in force rather than a literal.
///
/// The summon hotkey is deliberately **not** here any more. It is the one Carbon binding (decision
/// 9) and the one key that has to work while Pane is not frontmost, so it keeps its recorder — on
/// General, where it always also was.
///
/// The count is `Settings.shortcutActions.count`; don't restate it here without changing it there.
/// `NSTabViewController` gives each tab its own height, so shrinking this one does not disturb the
/// others.
///
/// The rule that governs this list has not moved: a recordable row that binds nothing is a worse lie
/// than an absent row, so a row appears here only when `Settings.shortcutActions` has an entry doing
/// something. Recently Deleted is the one ⌘K row with no entry, because the design gives it no
/// shortcut and a blank waiting to be filled in is the same lie in a different shape.
@MainActor
final class ShortcutsSettingsViewController: NSViewController {

    private let settings: SettingsStore
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

        var group: String?
        for action in Settings.shortcutActions {
            // A heading whenever the group changes. A flat column is a list you read rather than
            // scan; these are ⌘K's own groups, so the two places that list the same actions agree
            // about which belong together.
            if action.group != group {
                group = action.group
                rows.addArrangedSubview(header(action.group))
            }

            let recorder = PaneShortcutRecorderView(binding: settings.value.shortcut(action.key))
            recorder.onRecord = { [weak self] binding in
                self?.settings.update { $0.shortcuts[action.key] = binding }
            }
            paneRecorders.append((action.key, recorder))
            rows.addArrangedSubview(row(label: action.label, control: recorder))
        }

        // No "click a shortcut to re-record it" caption. The rows are obviously buttons and they say
        // "Click to record" the moment one is focused; a line of prose under every screen is what
        // this window had too much of.
        let restore = SettingsForm.push(
            "Restore Defaults", target: self, action: #selector(restoreDefaults)
        )

        let footer = NSStackView(views: [NSView(), restore])
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

            container.widthAnchor.constraint(equalToConstant: SettingsForm.contentWidth),
        ])

        // This is the one tab that does not fit the window every other tab wants.
        //
        // `NSTabViewController` gives each tab its own height, which is the standard behaviour and
        // was fine while every tab was within a hundred points of the others. Ten rows in three
        // groups plus a footer is roughly twice the tallest of the rest, so switching to it threw
        // the window open and switching away snapped it shut — the window jumping around the screen
        // as you read the tab bar. Every tab is one size now (see `SettingsWindowController`), and
        // the tab that does not fit scrolls rather than deciding the size for the other four.
        //
        // The scroll view holds the container at its natural height and lets the tab clip it, which
        // is why the container keeps hugging vertically: the rows must stay their own height rather
        // than sharing out whatever the scroll view has.
        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.horizontalScrollElasticity = .none
        scroll.documentView = container
        container.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            container.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
            container.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
        ])

        view = scroll
    }

    /// A group's name, in the type the rest of the window uses for a quiet label.
    private func header(_ text: String) -> NSView {
        let label = NSTextField(labelWithString: text)
        label.font = .systemFont(ofSize: 11, weight: .semibold)
        label.textColor = .tertiaryLabelColor

        let stack = NSStackView(views: [label])
        stack.orientation = .horizontal
        stack.edgeInsets = NSEdgeInsets(top: 14, left: 2, bottom: 4, right: 2)
        return stack
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
        for entry in paneRecorders {
            entry.recorder.setBinding(new.shortcut(entry.action))
        }
    }

    /// Restores every binding this tab can record — and the summon hotkey with them.
    ///
    /// The summon row moved to General, but "Restore Defaults" still resets it: this button means
    /// "put my keys back", and leaving one recorded combination behind because its recorder now
    /// lives on another tab would be a surprise rather than a distinction.
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
