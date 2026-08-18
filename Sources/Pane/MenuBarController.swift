import AppKit
import PaneKit

/// The menu bar item, design frame 2d.
///
/// The pinned section is the only part that moves: it is one item per pinned note, and it disappears
/// entirely — along with one of the separators — when nothing is pinned. A menu with an empty region
/// in the middle of it looks broken, and pins are per-machine (decision 11), so an empty section is
/// the normal state on a fresh Mac.
@MainActor
final class MenuBarController: NSObject {

    private let item: NSStatusItem
    private let menu = NSMenu()

    var onShow: (() -> Void)?
    var onNewNote: (() -> Void)?
    var onBrowse: (() -> Void)?
    var onActions: (() -> Void)?
    var onOpenNote: ((String) -> Void)?
    var onSettings: (() -> Void)?

    /// Supplies the pinned notes as (filename, title) pairs, most recently used first.
    var pinnedNotes: () -> [(filename: String, title: String)] = { [] }

    init(hotkey: Hotkey) {
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        super.init()

        if let button = item.button {
            button.image = Self.statusImage
            button.toolTip = "Pane — \(hotkey.displayString)"
        }

        menu.delegate = self
        item.menu = menu
        rebuild(hotkey: hotkey)
    }

    private var hotkey: Hotkey = .defaultSummon

    func rebuild(hotkey: Hotkey) {
        self.hotkey = hotkey
        menu.removeAllItems()

        // The summon item's shortcut goes in AppKit's key column like every other item's.
        //
        // It used to be part of the title — first three spaces and the glyphs, then a right-aligned
        // tab stop — and both landed short of the column ⌘N, ⌘P and ⌘K sit in, because that column
        // is inset from the menu's right edge by an amount an item's own text never reaches; making
        // the item wider widens the menu and takes the column with it. So it is a real key
        // equivalent, and `toggle` ignores a second call within a quarter second: the combination is
        // registered globally with Carbon (decision 9), and while Pane is frontmost — which is only
        // ever the Settings window — both would fire for one press.
        let show = NSMenuItem(title: "Show Pane", action: #selector(showPane), keyEquivalent: "")
        show.target = self
        if let key = hotkey.menuKeyEquivalent {
            show.keyEquivalent = key
            var mask: NSEvent.ModifierFlags = []
            if hotkey.modifiers.contains(.command) { mask.insert(.command) }
            if hotkey.modifiers.contains(.shift) { mask.insert(.shift) }
            if hotkey.modifiers.contains(.option) { mask.insert(.option) }
            if hotkey.modifiers.contains(.control) { mask.insert(.control) }
            show.keyEquivalentModifierMask = mask
        } else {
            show.attributedTitle = Self.title("Show Pane", shortcut: hotkey.displayString)
        }
        menu.addItem(show)

        menu.addItem(action("New Note", key: "n", selector: #selector(newNote)))
        menu.addItem(action("Browse Notes…", key: "p", selector: #selector(browse)))
        // Frame 2a justifies having no ⌘ toolbar button by pointing at "the footer hint and menu
        // bar". This is the menu bar half — without it, and without the footer hint, ⌘K was a panel
        // with no way to find out it existed.
        menu.addItem(action("Actions…", key: "k", selector: #selector(actionPanel)))

        let pinned = pinnedNotes()
        if !pinned.isEmpty {
            menu.addItem(.separator())
            for note in pinned {
                let entry = NSMenuItem(
                    title: note.title.isEmpty ? note.filename : note.title,
                    action: #selector(openPinned(_:)),
                    keyEquivalent: ""
                )
                entry.target = self
                entry.representedObject = note.filename
                entry.image = Self.pinImage
                menu.addItem(entry)
            }
        }

        menu.addItem(.separator())
        menu.addItem(action("Settings…", key: ",", selector: #selector(settings)))

        let quit = NSMenuItem(title: "Quit Pane", action: #selector(quit), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
    }

    private func action(_ title: String, key: String, selector: Selector) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: selector, keyEquivalent: key)
        item.target = self
        return item
    }

    /// Right-aligned shortcut text in a menu item, for a combination that is not a key equivalent.
    /// "Show Pane" with its hotkey in the column AppKit puts every other item's key equivalent in.
    ///
    /// The shortcut used to be three spaces and the glyphs, so it landed wherever the title happened
    /// to end while ⌘N, ⌘P and ⌘K below it were right-aligned by AppKit — one item out of step in a
    /// six-item menu. A right-aligned tab stop puts it in the same column without making it a real
    /// key equivalent, which is what this must not become: the combination is a Carbon global hotkey
    /// (decision 9), and registering it twice in two systems is two owners for one keypress.
    private static func title(_ text: String, shortcut: String) -> NSAttributedString {
        let style = NSMutableParagraphStyle()
        style.tabStops = [NSTextTab(textAlignment: .right, location: 240)]

        let result = NSMutableAttributedString(
            string: text, attributes: [.paragraphStyle: style]
        )
        result.append(
            NSAttributedString(
                string: "\t\(shortcut)",
                attributes: [
                    .foregroundColor: NSColor.tertiaryLabelColor,
                    .paragraphStyle: style,
                ]
            )
        )
        return result
    }

    /// The menu bar glyph — Pane's own mark, drawn as a template so macOS tints it for the current
    /// menu bar rather than painting a black shape onto a dark background.
    ///
    /// Falls back to an SF Symbol when the resource is absent, which is the case for `swift run Pane`
    /// during development: `NSImage(named:)` reads the app bundle, and there isn't one.
    private static let statusImage: NSImage? = {
        let image = NSImage(named: "MenuBar")
            ?? NSImage(systemSymbolName: "note.text", accessibilityDescription: "Pane")
        image?.isTemplate = true
        image?.accessibilityDescription = "Pane"
        return image
    }()

    private static let pinImage: NSImage? = {
        let image = NSImage(systemSymbolName: "pin.fill", accessibilityDescription: nil)
        image?.isTemplate = true
        return image
    }()

    // MARK: - Actions

    @objc private func showPane() { onShow?() }
    @objc private func newNote() { onNewNote?() }
    @objc private func browse() { onBrowse?() }
    @objc private func actionPanel() { onActions?() }
    @objc private func settings() { onSettings?() }
    @objc private func quit() { NSApp.terminate(nil) }

    @objc private func openPinned(_ sender: NSMenuItem) {
        guard let filename = sender.representedObject as? String else { return }
        onOpenNote?(filename)
    }
}

extension MenuBarController: NSMenuDelegate {
    /// Rebuilt on open rather than on every pin change, so the pinned section is right without the
    /// menu having to be told each time a note is pinned from inside a pane.
    func menuWillOpen(_ menu: NSMenu) {
        rebuild(hotkey: hotkey)
    }
}
