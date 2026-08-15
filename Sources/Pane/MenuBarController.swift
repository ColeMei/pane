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
    var onOpenNote: ((String) -> Void)?
    var onSettings: (() -> Void)?

    /// Supplies the pinned notes as (filename, title) pairs, most recently used first.
    var pinnedNotes: () -> [(filename: String, title: String)] = { [] }

    init(hotkey: Hotkey) {
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        super.init()

        if let button = item.button {
            button.image = NSImage(
                systemSymbolName: "note.text",
                accessibilityDescription: "Pane"
            )
            button.image?.isTemplate = true
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

        // The summon item carries the hotkey as a label rather than as a key equivalent: it is a
        // global hotkey handled by Carbon, and giving the menu item the same combination would
        // register it twice, in two systems, with different ideas about who won.
        let show = NSMenuItem(title: "Show Pane", action: #selector(showPane), keyEquivalent: "")
        show.target = self
        show.attributedTitle = Self.title("Show Pane", shortcut: hotkey.displayString)
        menu.addItem(show)

        menu.addItem(action("New Note", key: "n", selector: #selector(newNote)))
        menu.addItem(action("Browse Notes…", key: "p", selector: #selector(browse)))

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
    private static func title(_ text: String, shortcut: String) -> NSAttributedString {
        let result = NSMutableAttributedString(string: text)
        result.append(
            NSAttributedString(
                string: "   \(shortcut)",
                attributes: [.foregroundColor: NSColor.tertiaryLabelColor]
            )
        )
        return result
    }

    private static let pinImage: NSImage? = {
        let image = NSImage(systemSymbolName: "pin.fill", accessibilityDescription: nil)
        image?.isTemplate = true
        return image
    }()

    // MARK: - Actions

    @objc private func showPane() { onShow?() }
    @objc private func newNote() { onNewNote?() }
    @objc private func browse() { onBrowse?() }
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
